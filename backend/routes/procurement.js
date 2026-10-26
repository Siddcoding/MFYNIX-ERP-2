/**
 * R2 purchase chain: Purchase Order -> Goods Receipt -> draft Bill, with a
 * three-way match (PTP-04..07).
 *
 * Goods arrive and enter stock at the GRN (at PO price). The draft bill is
 * raised from the GRN; the three-way match compares PO price/qty, GRN qty and
 * bill price/qty within tolerance, and anything outside tolerance is flagged
 * for approval before the bill posts.
 */
const express = require('express');
const db = require('../db');
const { requireAuth, resolveBranchScope } = require('../middleware/auth');
const { logAudit } = require('./auth');
const { postJournalEntry } = require('./accounts');
const { nextDocumentNumber, assertYearOpen } = require('../services/numbering');
const { accountId: acct, assertPeriodOpen } = require('../services/posting');
const { postStock, isPerpetual } = require('../services/valuation');
const { getTerm, termForParty, computeDueDate } = require('../services/terms');
const { partySnapshot, branchState, buildLines } = require('../services/documentFields');
const { createApprovalIfNeeded } = require('./approvals');

const router = express.Router();
router.use(requireAuth);

function round2(n) { return Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100; }
function today() { return new Date().toISOString().slice(0, 10); }
const CAN_WRITE = ['Super Admin', 'Company Admin', 'Branch Manager', 'Accountant', 'Store Manager'];
function requireWrite(req, res, next) {
  if (!CAN_WRITE.includes(req.user.role)) return res.status(403).json({ error: 'You do not have rights to create purchase documents' });
  next();
}
const PRICE_TOL = Number(process.env.MATCH_PRICE_TOLERANCE || 0.02);   // 2% price tolerance
const QTY_TOL = Number(process.env.MATCH_QTY_TOLERANCE || 0.0);

function totalsFor(companyId, branchId, items, supplierId) {
  const party = partySnapshot(db, 'Supplier', supplierId);
  const supplierState = branchState(db, branchId);
  const { lines, totals } = buildLines(db, { companyId, branchId, items, supplierState, party });
  return { lines, totals, party };
}

// ============================ PURCHASE ORDERS (PTP-04) ============================
router.get('/orders', (req, res) => {
  const branchId = resolveBranchScope(req);
  res.json(db.prepare(
    `SELECT p.*, s.SupplierName FROM PurchaseOrder p JOIN Supplier s ON s.SupplierID = p.SupplierID
     WHERE p.CompanyID = ? ${branchId ? 'AND p.BranchID = ?' : ''} ORDER BY p.POID DESC LIMIT 200`
  ).all(...(branchId ? [req.user.companyId, branchId] : [req.user.companyId])));
});
router.get('/orders/:id', (req, res) => {
  const o = db.prepare('SELECT p.*, s.SupplierName FROM PurchaseOrder p JOIN Supplier s ON s.SupplierID = p.SupplierID WHERE p.POID = ? AND p.CompanyID = ?').get(req.params.id, req.user.companyId);
  if (!o) return res.status(404).json({ error: 'Purchase order not found' });
  o.lines = db.prepare('SELECT pl.*, i.ItemName, (pl.Qty - pl.ReceivedQty) AS OpenToReceive FROM PurchaseOrderLine pl JOIN Item i ON i.ItemID = pl.ItemID WHERE pl.POID = ?').all(o.POID);
  res.json(o);
});
router.post('/orders', requireWrite, (req, res) => {
  const branchId = req.user.branchId || req.body.branchId;
  const { supplierId, poDate, items } = req.body;
  if (!branchId || !supplierId || !poDate || !Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'branchId, supplierId, poDate and at least one item are required' });
  }
  try {
    const result = db.transaction(() => {
      const { lines, totals } = totalsFor(req.user.companyId, branchId, items, supplierId);
      const term = req.body.paymentTermId ? getTerm(req.user.companyId, Number(req.body.paymentTermId)) : termForParty(req.user.companyId, 'Supplier', supplierId);
      const no = nextDocumentNumber(req.user.companyId, branchId, 'PO', poDate);
      const id = db.prepare(
        `INSERT INTO PurchaseOrder (CompanyID, BranchID, PONo, PODate, SupplierID, PaymentTermID, ExpectedDate, Status, Total, GST, NetAmount, Remarks, CreatedBy)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(req.user.companyId, branchId, no, poDate, supplierId, term ? term.PaymentTermID : null, req.body.expectedDate || null,
        'Open', totals.taxable, totals.tax, totals.gross, req.body.remarks || null, req.user.userId).lastInsertRowid;
      const ins = db.prepare('INSERT INTO PurchaseOrderLine (POID, ItemID, Qty, Rate, GST, Amount) VALUES (?,?,?,?,?,?)');
      lines.forEach((l, i) => ins.run(id, l.itemId, items[i].qty, items[i].rate, l.gstRate, l.grossAmount));
      // PTP-04: a large PO may need approval before it is acted on.
      const approval = createApprovalIfNeeded(db, { companyId: req.user.companyId, branchId, docType: 'PurchaseOrder', docId: id, amount: totals.gross, reason: `Purchase order ${no} for ${round2(totals.gross)}`, userId: req.user.userId });
      logAudit({ companyId: req.user.companyId, branchId, userId: req.user.userId, action: 'CREATE_PURCHASE_ORDER', entityType: 'PurchaseOrder', entityId: id, details: no, ip: req.ip });
      return { poId: id, poNo: no, netAmount: totals.gross, approvalRequired: !!approval, approvalId: approval ? approval.RequestID : null };
    })();
    res.status(201).json(result);
  } catch (e) { res.status(/required|not found|year/i.test(e.message) ? 400 : 500).json({ error: e.message }); }
});

function refreshPOStatus(poId) {
  const lines = db.prepare('SELECT Qty, ReceivedQty, BilledQty FROM PurchaseOrderLine WHERE POID = ?').all(poId);
  const allRec = lines.every(l => l.ReceivedQty >= l.Qty - 1e-9);
  const anyRec = lines.some(l => l.ReceivedQty > 1e-9);
  const allBill = lines.every(l => l.BilledQty >= l.Qty - 1e-9);
  const cur = db.prepare('SELECT Status FROM PurchaseOrder WHERE POID = ?').get(poId).Status;
  if (cur === 'Cancelled') return;
  let status = 'Open';
  if (allBill) status = 'Billed'; else if (allRec) status = 'Received'; else if (anyRec) status = 'Partly received';
  db.prepare('UPDATE PurchaseOrder SET Status = ? WHERE POID = ?').run(status, poId);
}

// ============================ GOODS RECEIPTS (PTP-05/06) ============================
router.post('/orders/:id/receive', requireWrite, (req, res) => {
  const po = db.prepare('SELECT * FROM PurchaseOrder WHERE POID = ? AND CompanyID = ?').get(req.params.id, req.user.companyId);
  if (!po) return res.status(404).json({ error: 'Purchase order not found' });
  if (po.Status === 'Cancelled') return res.status(400).json({ error: 'This purchase order is cancelled' });
  const grnDate = req.body.grnDate || today();
  const wantBill = req.body.bill === true;
  try {
    const result = db.transaction(() => {
      assertYearOpen(req.user.companyId, grnDate);
      assertPeriodOpen(req.user.companyId, 'Inventory', grnDate);
      const poLines = db.prepare('SELECT * FROM PurchaseOrderLine WHERE POID = ?').all(po.POID);
      const byId = new Map(poLines.map(l => [l.LineID, l]));
      let picks = Array.isArray(req.body.lines) && req.body.lines.length
        ? req.body.lines.map(p => ({ line: byId.get(Number(p.poLineId)), qty: Number(p.qty), batchNo: p.batchNo, expDate: p.expDate }))
        : poLines.map(l => ({ line: l, qty: round2(l.Qty - l.ReceivedQty) })).filter(p => p.qty > 0);
      picks = picks.filter(p => p.line && p.qty > 0);
      if (!picks.length) throw new Error('Nothing to receive - every line is already fully received');
      picks.forEach(p => {
        const open = round2(p.line.Qty - p.line.ReceivedQty);
        if (p.qty > open + 0.009) throw new Error(`Cannot receive ${p.qty} of line ${p.line.LineID}; only ${open} is open`);
      });
      const no = nextDocumentNumber(req.user.companyId, po.BranchID, 'GRN', grnDate);
      const gid = db.prepare(
        `INSERT INTO GoodsReceipt (CompanyID, BranchID, GRNNo, GRNDate, POID, SupplierID, Status, CreatedBy) VALUES (?,?,?,?,?,?,?,?)`
      ).run(req.user.companyId, po.BranchID, no, grnDate, po.POID, po.SupplierID, 'Received', req.user.userId).lastInsertRowid;
      const insLine = db.prepare('INSERT INTO GoodsReceiptLine (GRNID, POLineID, ItemID, Qty, Rate, GST, BatchNo, ExpDate) VALUES (?,?,?,?,?,?,?,?)');
      picks.forEach(p => {
        insLine.run(gid, p.line.LineID, p.line.ItemID, p.qty, p.line.Rate, p.line.GST, p.batchNo || null, p.expDate || null);
        db.prepare('UPDATE PurchaseOrderLine SET ReceivedQty = ReceivedQty + ? WHERE LineID = ?').run(p.qty, p.line.LineID);
        // Stock in at the taxable cost (tax is recoverable).
        const taxable = round2(p.qty * p.line.Rate);
        postStock({ companyId: req.user.companyId, branchId: po.BranchID, itemId: p.line.ItemID, transType: 'GRN', refType: 'GoodsReceipt', refId: gid, qty: p.qty, dir: 'in', date: grnDate, value: taxable });
      });
      // Goods received but not yet billed sit in a GRN/IR clearing account so the
      // Inventory asset is real the moment stock arrives.
      if (isPerpetual(req.user.companyId)) {
        const value = round2(picks.reduce((s, p) => s + p.qty * p.line.Rate, 0));
        if (value > 0) postJournalEntry(db, { companyId: req.user.companyId, branchId: po.BranchID, entryDate: grnDate,
          narration: `Goods received ${no} (not yet billed)`, sourceType: 'GoodsReceipt', sourceId: gid, createdBy: req.user.userId,
          lines: [{ accountId: acct(req.user.companyId, '1200'), debit: value, credit: 0 }, { accountId: acct(req.user.companyId, '2050'), debit: 0, credit: value }] });
      }
      logAudit({ companyId: req.user.companyId, branchId: po.BranchID, userId: req.user.userId, action: 'CREATE_GRN', entityType: 'GoodsReceipt', entityId: gid, details: no, ip: req.ip });
      refreshPOStatus(po.POID);
      let bill = null;
      if (wantBill) bill = billFromGrn(req, gid, req.body.vendorInvoiceNo, req.body.vendorInvoiceDate);
      return { grnId: gid, grnNo: no, bill };
    })();
    res.status(201).json(result);
  } catch (e) { res.status(/open|receive|not found|year|locked|cancelled|match|invoice/i.test(e.message) ? 400 : 500).json({ error: e.message }); }
});

// Three-way match + draft bill from a GRN (PTP-06/07).
function billFromGrn(req, grnId, vendorInvoiceNo, vendorInvoiceDate) {
  const companyId = req.user.companyId;
  const grn = db.prepare('SELECT * FROM GoodsReceipt WHERE GRNID = ? AND CompanyID = ?').get(grnId, companyId);
  if (!grn) throw new Error('Goods receipt not found');
  if (grn.PurchaseID) throw new Error('This goods receipt is already billed');
  const po = db.prepare('SELECT * FROM PurchaseOrder WHERE POID = ?').get(grn.POID);
  const glines = db.prepare('SELECT * FROM GoodsReceiptLine WHERE GRNID = ?').all(grnId);
  const poLines = new Map(db.prepare('SELECT * FROM PurchaseOrderLine WHERE POID = ?').all(grn.POID).map(l => [l.LineID, l]));

  // Allow the bill to override price/qty; default to the GRN (which is PO price).
  const overrides = new Map((req.body.lines || []).map(l => [Number(l.grnLineId), l]));
  const items = [];
  const mismatches = [];
  glines.forEach(gl => {
    const ov = overrides.get(gl.LineID) || {};
    const rate = ov.rate !== undefined ? Number(ov.rate) : gl.Rate;
    const qty = ov.qty !== undefined ? Number(ov.qty) : gl.Qty;
    const po = poLines.get(gl.POLineID);
    if (po) {
      const priceDiff = po.Rate ? Math.abs(rate - po.Rate) / po.Rate : (rate === po.Rate ? 0 : 1);
      if (priceDiff > PRICE_TOL + 1e-9) mismatches.push(`price for item ${gl.ItemID}: PO ${po.Rate} vs bill ${rate}`);
      if (Math.abs(qty - gl.Qty) > gl.Qty * QTY_TOL + 1e-9) mismatches.push(`qty for item ${gl.ItemID}: received ${gl.Qty} vs billed ${qty}`);
    }
    items.push({ itemId: gl.ItemID, qty, rate, gst: gl.GST });
  });

  const billDate = today();
  assertPeriodOpen(companyId, 'Purchase', billDate);
  const vInvNo = String(vendorInvoiceNo || `${grn.GRNNo}`).trim();
  const vInvDate = (vendorInvoiceDate || billDate).slice(0, 10);
  const { lines: computed, totals } = totalsFor(companyId, grn.BranchID, items, grn.SupplierID);
  const term = getTerm(companyId, po.PaymentTermID) || termForParty(companyId, 'Supplier', grn.SupplierID);
  const dueDate = computeDueDate(term, vInvDate);
  const no = nextDocumentNumber(companyId, grn.BranchID, 'PUR', billDate);
  // A mismatch outside tolerance parks the bill as a draft for approval.
  const status = mismatches.length ? 'Draft' : 'Posted';
  const { headerFieldsFrom, LINE_COLUMNS, lineValues } = require('../services/documentFields');
  const pid = db.prepare(
    `INSERT INTO PurchaseHeader (CompanyID, BranchID, PurchaseNo, PurchaseDate, SupplierID, Total, GST, NetAmount, CreatedBy, Status, POID, GRNID, VendorInvoiceNo, VendorInvoiceDate, PaymentTermID, DueDate)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(companyId, grn.BranchID, no, billDate, grn.SupplierID, totals.taxable, totals.tax, totals.gross, req.user.userId,
    status, grn.POID, grnId, vInvNo, vInvDate, term ? term.PaymentTermID : null, dueDate).lastInsertRowid;
  const insLine = db.prepare(`INSERT INTO PurchaseDetail (PurchaseID, ItemID, Qty, Rate, GST, Amount, Discount, ${LINE_COLUMNS.join(', ')}) VALUES (?,?,?,?,?,?,?${LINE_COLUMNS.map(() => ',?').join('')})`);
  computed.forEach(it => insLine.run(pid, it.itemId, it.qty, it.rate, it.gstRate, it.grossAmount, it.discountAmount, ...lineValues(it)));
  db.prepare("UPDATE GoodsReceipt SET Status = 'Billed', PurchaseID = ? WHERE GRNID = ?").run(pid, grnId);
  glines.forEach(gl => { if (gl.POLineID) db.prepare('UPDATE PurchaseOrderLine SET BilledQty = BilledQty + ? WHERE LineID = ?').run(gl.Qty, gl.POLineID); });
  refreshPOStatus(grn.POID);

  if (status === 'Posted') {
    postBillAccounting(companyId, grn.BranchID, pid, no, totals, grn.SupplierID, req.user.userId, billDate);
  } else {
    // Over tolerance: raise an approval against the draft bill.
    createApprovalIfNeeded(db, { companyId, branchId: grn.BranchID, docType: 'PurchaseBill', docId: pid, amount: totals.gross,
      reason: `Three-way match failed: ${mismatches.join('; ')}`, userId: req.user.userId, force: true });
  }
  logAudit({ companyId, branchId: grn.BranchID, userId: req.user.userId, action: mismatches.length ? 'DRAFT_BILL_MISMATCH' : 'BILL_FROM_GRN', entityType: 'PurchaseHeader', entityId: pid, details: `${no}${mismatches.length ? ' (held: ' + mismatches.join('; ') + ')' : ''}`, ip: req.ip });
  return { purchaseId: pid, purchaseNo: no, netAmount: totals.gross, status, matched: mismatches.length === 0, mismatches };
}

// On billing, move the goods from the GRN clearing account to the supplier and
// book the recoverable GST input.
function postBillAccounting(companyId, branchId, pid, no, totals, supplierId, userId, billDate) {
  const perpetual = isPerpetual(companyId);
  const lines = [{ accountId: acct(companyId, '2000'), debit: 0, credit: totals.gross }];
  if (totals.taxable > 0) lines.push({ accountId: acct(companyId, perpetual ? '2050' : '5000'), debit: totals.taxable, credit: 0 });
  if (totals.tax > 0) lines.push({ accountId: acct(companyId, '1900'), debit: totals.tax, credit: 0 });
  postJournalEntry(db, { companyId, branchId, entryDate: billDate, narration: `Purchase ${no}`, sourceType: 'PurchaseInvoice', sourceId: pid, createdBy: userId, lines, partyType: 'Supplier', partyId: supplierId });
}

router.post('/grn/:id/bill', requireWrite, (req, res) => {
  try {
    const result = db.transaction(() => billFromGrn(req, Number(req.params.id), req.body.vendorInvoiceNo, req.body.vendorInvoiceDate))();
    res.status(201).json(result);
  } catch (e) { res.status(/not found|already|locked|year|match|invoice/i.test(e.message) ? 400 : 500).json({ error: e.message }); }
});

// Approve a held (draft) bill after a three-way-match exception: it posts.
router.post('/bills/:id/approve-post', requireWrite, (req, res) => {
  try {
    const result = db.transaction(() => {
      const bill = db.prepare('SELECT * FROM PurchaseHeader WHERE PurchaseID = ? AND CompanyID = ?').get(req.params.id, req.user.companyId);
      if (!bill) throw new Error('Bill not found');
      if (bill.Status !== 'Draft') throw new Error('Only a draft bill can be posted this way');
      assertPeriodOpen(req.user.companyId, 'Purchase', bill.PurchaseDate);
      db.prepare("UPDATE PurchaseHeader SET Status = 'Posted' WHERE PurchaseID = ?").run(bill.PurchaseID);
      postBillAccounting(req.user.companyId, bill.BranchID, bill.PurchaseID, bill.PurchaseNo,
        { taxable: bill.Total, tax: bill.GST, gross: bill.NetAmount }, bill.SupplierID, req.user.userId, bill.PurchaseDate);
      db.prepare("UPDATE ApprovalRequest SET Status = 'Approved', DecidedBy = ?, DecidedAt = datetime('now') WHERE DocType = 'PurchaseBill' AND DocID = ? AND Status = 'Pending'").run(req.user.userId, bill.PurchaseID);
      logAudit({ companyId: req.user.companyId, branchId: bill.BranchID, userId: req.user.userId, action: 'POST_HELD_BILL', entityType: 'PurchaseHeader', entityId: bill.PurchaseID, details: bill.PurchaseNo, ip: req.ip });
      return { purchaseId: bill.PurchaseID, purchaseNo: bill.PurchaseNo, status: 'Posted' };
    })();
    res.json(result);
  } catch (e) { res.status(/not found|draft|locked/i.test(e.message) ? 400 : 500).json({ error: e.message }); }
});

router.get('/grn', (req, res) => {
  const branchId = resolveBranchScope(req);
  res.json(db.prepare(
    `SELECT g.*, s.SupplierName, po.PONo FROM GoodsReceipt g JOIN Supplier s ON s.SupplierID = g.SupplierID JOIN PurchaseOrder po ON po.POID = g.POID
     WHERE g.CompanyID = ? ${branchId ? 'AND g.BranchID = ?' : ''} ORDER BY g.GRNID DESC LIMIT 200`
  ).all(...(branchId ? [req.user.companyId, branchId] : [req.user.companyId])));
});

// PTP-08: reorder proposal - items below reorder level, suggested PO per preferred vendor.
router.get('/reorder-proposal', (req, res) => {
  const branchId = resolveBranchScope(req) || (req.query.branchId ? Number(req.query.branchId) : null);
  const items = db.prepare('SELECT * FROM Item WHERE CompanyID = ? AND IsActive = 1 AND ReorderLevel > 0').all(req.user.companyId);
  const rows = [];
  items.forEach(it => {
    const onHand = db.prepare(`SELECT COALESCE(SUM(InQty),0)-COALESCE(SUM(OutQty),0) AS s FROM StockLedger WHERE CompanyID=? AND ItemID=?${branchId ? ' AND BranchID=?' : ''}`)
      .get(...(branchId ? [req.user.companyId, it.ItemID, branchId] : [req.user.companyId, it.ItemID])).s;
    if (onHand < it.ReorderLevel) {
      const vendor = it.PreferredVendorID ? db.prepare('SELECT SupplierName FROM Supplier WHERE SupplierID = ?').get(it.PreferredVendorID) : null;
      rows.push({ itemId: it.ItemID, itemName: it.ItemName, onHand: round2(onHand), reorderLevel: it.ReorderLevel,
        suggestedQty: round2(it.ReorderLevel * 2 - onHand), preferredVendorId: it.PreferredVendorID || null, preferredVendor: vendor ? vendor.SupplierName : null, rate: it.PurchaseRate || 0 });
    }
  });
  res.json({ rows, count: rows.length });
});

module.exports = router;
