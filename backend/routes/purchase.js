const express = require('express');
const db = require('../db');
const { requireAuth, resolveBranchScope } = require('../middleware/auth');
const { logAudit } = require('./auth');
const { postJournalEntry } = require('./accounts');
const { assertPeriodNotFiled } = require('./sales');
const { readPaging, pagedResult } = require('../services/paging');
const { nextDocumentNumber, assertYearOpen } = require('../services/numbering');
const { accountId: acct, assertPeriodOpen, reverseJournal } = require('../services/posting');
const { postStock, isPerpetual } = require('../services/valuation');
const { getTerm, termForParty, computeDueDate } = require('../services/terms');
const {
  headerFieldsFrom, partySnapshot, branchState, buildLines, LINE_COLUMNS, lineValues
} = require('../services/documentFields');

const router = express.Router();
router.use(requireAuth);

function getAccountId(companyId, code) {
  const row = db.prepare('SELECT AccountID FROM ChartOfAccounts WHERE CompanyID = ? AND AccountCode = ?').get(companyId, code);
  if (!row) throw new Error(`Chart of Accounts is missing required account ${code} - cannot post the accounting entry`);
  return row.AccountID;
}

// Purchase numbers come from the central numbering engine - see services/numbering.js.

// GET /purchase?page=&pageSize=&search=&from=&to=&status=&branchId=
router.get('/', (req, res) => {
  const branchId = resolveBranchScope(req);
  const { page, pageSize, offset } = readPaging(req.query);
  const { search, from, to, status } = req.query;

  const where = ['p.CompanyID = ?'];
  const args = [req.user.companyId];
  if (branchId) { where.push('p.BranchID = ?'); args.push(branchId); }
  if (status) { where.push('p.Status = ?'); args.push(status); }
  if (req.query.supplierId) { where.push('p.SupplierID = ?'); args.push(Number(req.query.supplierId)); }
  if (from) { where.push('date(p.PurchaseDate) >= date(?)'); args.push(from); }
  if (to) { where.push('date(p.PurchaseDate) <= date(?)'); args.push(to); }
  if (search) { where.push('(p.PurchaseNo LIKE ? OR s.SupplierName LIKE ?)'); const q = `%${search}%`; args.push(q, q); }
  const whereSql = where.join(' AND ');

  const total = db.prepare(
    `SELECT COUNT(*) AS c FROM PurchaseHeader p JOIN Supplier s ON s.SupplierID = p.SupplierID WHERE ${whereSql}`
  ).get(...args).c;

  const rows = db.prepare(
    `SELECT p.*, s.SupplierName, b.BranchName FROM PurchaseHeader p
     JOIN Supplier s ON s.SupplierID = p.SupplierID
     JOIN Branch b ON b.BranchID = p.BranchID
     WHERE ${whereSql} ORDER BY p.PurchaseID DESC LIMIT ? OFFSET ?`
  ).all(...args, pageSize, offset);

  res.json(pagedResult(rows, total, { page, pageSize }));
});

router.post('/', (req, res) => {
  const branchId = req.user.branchId || req.body.branchId;
  if (!branchId) return res.status(400).json({ error: 'branchId is required (head-office users must specify one)' });

  const { supplierId, purchaseDate, items } = req.body;
  if (!supplierId || !purchaseDate || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'supplierId, purchaseDate and at least one item are required' });
  }

  const tx = db.transaction(() => {
    assertYearOpen(req.user.companyId, purchaseDate);
    assertPeriodOpen(req.user.companyId, 'Purchase', purchaseDate);

    // PTP-01/02: the vendor's own invoice number and date are mandatory, and the
    // same vendor invoice can only be booked once.
    const vInvNo = String(req.body.vendorInvoiceNo || '').trim();
    const vInvDate = String(req.body.vendorInvoiceDate || '').slice(0, 10);
    if (!vInvNo) throw new Error("Vendor invoice number is required - enter the number printed on the vendor's bill");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(vInvDate)) throw new Error("Vendor invoice date is required - enter the date printed on the vendor's bill");
    if (vInvDate > purchaseDate) throw new Error('Vendor invoice date cannot be after the booking date');
    const dup = db.prepare(
      `SELECT PurchaseNo FROM PurchaseHeader WHERE CompanyID = ? AND SupplierID = ? AND lower(VendorInvoiceNo) = lower(?) AND Status != 'Cancelled'`
    ).get(req.user.companyId, supplierId, vInvNo);
    if (dup) throw new Error(`Duplicate vendor invoice: ${vInvNo} from this vendor is already booked as ${dup.PurchaseNo}`);

    // Payment term and due date come from the vendor master unless overridden.
    let term = termForParty(req.user.companyId, 'Supplier', supplierId);
    if (req.body.paymentTermId) {
      const t = getTerm(req.user.companyId, Number(req.body.paymentTermId));
      if (!t) throw new Error('Payment term not found');
      term = t;
    }
    const dueDate = computeDueDate(term, vInvDate);

    // Same computation the sales side uses, so an inward bill and an outward
    // invoice split their tax by identical rules - which is what lets the ITC
    // in GSTR-3B reconcile against the output tax.
    const party = partySnapshot(db, 'Supplier', supplierId);
    const supplierState = branchState(db, branchId);
    const { lines: computed, totals } = buildLines(db, {
      companyId: req.user.companyId, branchId, items, supplierState, party
    });

    const total = totals.taxable;
    const gstTotal = totals.tax;
    const netAmount = totals.gross;
    const purchaseNo = nextDocumentNumber(req.user.companyId, branchId, 'PUR', purchaseDate);

    const extra = {
      ...headerFieldsFrom(req.body),
      PartyPhone: party.PartyPhone, PartyPAN: party.PartyPAN, PartyGSTIN: party.PartyGSTIN,
      PartyState: party.PartyState, PartyStateCode: party.PartyStateCode,
      PartyType: req.body.partyType || party.PartyType,
      PlaceOfSupply: req.body.placeOfSupply || supplierState,
      VendorInvoiceNo: vInvNo, VendorInvoiceDate: vInvDate,
      PaymentTermID: term ? term.PaymentTermID : null, DueDate: dueDate
    };
    const extraCols = Object.keys(extra).filter(k => extra[k] !== undefined && extra[k] !== null);

    const headerResult = db.prepare(
      `INSERT INTO PurchaseHeader (CompanyID, BranchID, PurchaseNo, PurchaseDate, SupplierID, Total, GST, NetAmount, CreatedBy${
        extraCols.length ? ', ' + extraCols.join(', ') : ''})
       VALUES (?,?,?,?,?,?,?,?,?${extraCols.map(() => ',?').join('')})`
    ).run(req.user.companyId, branchId, purchaseNo, purchaseDate, supplierId, total, gstTotal, netAmount,
      req.user.userId, ...extraCols.map(c => extra[c]));
    const purchaseId = headerResult.lastInsertRowid;

    const insertLine = db.prepare(
      `INSERT INTO PurchaseDetail (PurchaseID, ItemID, Qty, Rate, GST, Amount, Discount, ${LINE_COLUMNS.join(', ')})
       VALUES (?,?,?,?,?,?,?${LINE_COLUMNS.map(() => ',?').join('')})`
    );
    computed.forEach(it => {
      insertLine.run(purchaseId, it.itemId, it.qty, it.rate, it.gstRate, it.grossAmount, it.discountAmount, ...lineValues(it));
      // Stock comes in at the taxable cost (tax is recoverable input credit).
      postStock({ companyId: req.user.companyId, branchId, itemId: it.itemId, transType: 'PURCHASE', refType: 'PurchaseHeader',
        refId: purchaseId, qty: it.qty, dir: 'in', date: purchaseDate, value: it.nettAmount });
    });

    logAudit({
      companyId: req.user.companyId, branchId, userId: req.user.userId,
      action: 'CREATE_PURCHASE_INVOICE', entityType: 'PurchaseHeader', entityId: purchaseId,
      details: purchaseNo, ip: req.ip
    });

    // Auto-post: Debit Purchases (base cost) + Debit GST Input Credit (tax paid),
    // Credit Creditors (full amount owed to supplier). Same transaction as the
    // purchase itself - see the matching comment in routes/sales.js.
    const creditorsAcct = acct(req.user.companyId, '2000');
    // Perpetual valuation books the goods to Inventory; the legacy periodic
    // method keeps using the Purchases expense account.
    const purchasesAcct = acct(req.user.companyId, isPerpetual(req.user.companyId) ? '1200' : '5000');
    const gstInputAcct = acct(req.user.companyId, '1900');
    const journalLines = [{ accountId: creditorsAcct, debit: 0, credit: netAmount }];
    if (total > 0) journalLines.push({ accountId: purchasesAcct, debit: total, credit: 0 });
    if (gstTotal > 0) journalLines.push({ accountId: gstInputAcct, debit: gstTotal, credit: 0 });
    postJournalEntry(db, {
      companyId: req.user.companyId, branchId, entryDate: purchaseDate,
      narration: `Purchase ${purchaseNo}`, sourceType: 'PurchaseInvoice', sourceId: purchaseId,
      createdBy: req.user.userId, lines: journalLines, partyType: 'Supplier', partyId: supplierId
    });

    return { purchaseId, purchaseNo, netAmount };
  });

  try {
    const result = tx();
    res.status(201).json(result);
  } catch (e) {
    const isRuleViolation = /financial year|locked|Vendor invoice|Duplicate|Payment term/i.test(e.message);
    res.status(isRuleViolation ? 400 : 500).json({
      error: isRuleViolation ? e.message : 'Failed to create purchase: ' + e.message
    });
  }
});

// Detail view - needed by the printable bill as well as the UI.
router.get('/:id', (req, res) => {
  const header = db.prepare(
    `SELECT p.*, s.SupplierName, s.GSTIN AS SupplierGSTIN, s.Address AS SupplierAddress, s.State AS SupplierState,
            b.BranchName, b.BranchCode, b.GSTIN AS BranchGSTIN, b.Address AS BranchAddress, b.State AS BranchState,
            co.CompanyName, co.GSTIN AS CompanyGSTIN
     FROM PurchaseHeader p
     JOIN Supplier s ON s.SupplierID = p.SupplierID
     JOIN Branch b ON b.BranchID = p.BranchID
     JOIN Company co ON co.CompanyID = p.CompanyID
     WHERE p.PurchaseID = ? AND p.CompanyID = ?`
  ).get(req.params.id, req.user.companyId);
  if (!header) return res.status(404).json({ error: 'Not found' });
  const lines = db.prepare(
    `SELECT pd.*, i.ItemName, i.HSN, i.Unit FROM PurchaseDetail pd JOIN Item i ON i.ItemID = pd.ItemID WHERE PurchaseID = ?`
  ).all(req.params.id);
  res.json({ header, lines });
});

// POST /purchase/:id/cancel  { reason }
// Same reversal approach as a sales invoice: nothing is deleted, mirror-image
// stock and journal entries are added instead.
router.post('/:id/cancel', (req, res) => {
  const bill = db.prepare('SELECT * FROM PurchaseHeader WHERE PurchaseID = ? AND CompanyID = ?').get(req.params.id, req.user.companyId);
  if (!bill) return res.status(404).json({ error: 'Purchase bill not found' });
  if (bill.Status === 'Cancelled') return res.status(409).json({ error: 'This bill is already cancelled' });
  if (req.user.branchId && bill.BranchID !== req.user.branchId) {
    return res.status(403).json({ error: 'You can only cancel bills raised by your own branch' });
  }
  const { reason } = req.body;
  if (!reason || String(reason).trim().length < 3) {
    return res.status(400).json({ error: 'A cancellation reason is required' });
  }

  const tx = db.transaction(() => {
    assertPeriodNotFiled(req.user.companyId, bill.BranchID, bill.PurchaseDate);

    // Removing purchased stock can't be allowed to push a branch negative -
    // if some of it has already been sold or transferred out, cancelling the
    // bill would silently create an impossible stock position.
    const lines = db.prepare('SELECT * FROM PurchaseDetail WHERE PurchaseID = ?').all(bill.PurchaseID);
    for (const l of lines) {
      const stock = db.prepare(
        `SELECT COALESCE(SUM(InQty),0) - COALESCE(SUM(OutQty),0) AS s
         FROM StockLedger WHERE CompanyID = ? AND BranchID = ? AND ItemID = ?`
      ).get(req.user.companyId, bill.BranchID, l.ItemID).s;
      if (stock < l.Qty) {
        const item = db.prepare('SELECT ItemName FROM Item WHERE ItemID = ?').get(l.ItemID);
        throw new Error(`Cannot cancel: only ${stock} of ${item.ItemName} left in stock but this bill brought in ${l.Qty}. Some of it has already been sold or transferred - raise a debit note instead.`);
      }
    }

    const companyId = req.user.companyId;
    const today = new Date().toISOString().slice(0, 10);
    assertPeriodOpen(companyId, 'Purchase', bill.PurchaseDate);
    assertPeriodOpen(companyId, 'Purchase', today);
    db.prepare(`UPDATE PurchaseHeader SET Status = 'Cancelled' WHERE PurchaseID = ?`).run(bill.PurchaseID);

    // Take the goods back out at the value they came in at.
    const ins = db.prepare(
      `SELECT ItemID, SUM(InQty) AS q, SUM(ValueAmount) AS v FROM StockLedger
       WHERE CompanyID = ? AND RefType = 'PurchaseHeader' AND RefID = ? AND TransType = 'PURCHASE' GROUP BY ItemID`
    ).all(companyId, bill.PurchaseID);
    ins.forEach(r => postStock({ companyId, branchId: bill.BranchID, itemId: r.ItemID, transType: 'CANCEL_REVERSAL',
      refType: 'PurchaseHeader', refId: bill.PurchaseID, qty: r.q, dir: 'out', date: today, value: r.v || 0 }));

    const jr = db.prepare(`SELECT JournalID FROM JournalEntry WHERE CompanyID = ? AND SourceType = 'PurchaseInvoice' AND SourceID = ? AND ReversedByID IS NULL`)
      .get(companyId, bill.PurchaseID);
    if (!jr) throw new Error('The original journal entry for this bill was not found');
    const journalId = reverseJournal({ journalId: jr.JournalID, companyId, date: today, reason, userId: req.user.userId,
      narrationPrefix: `Cancellation of purchase ${bill.PurchaseNo} - reversal of` });
    db.prepare(`UPDATE JournalEntry SET SourceType = 'PurchaseCancellation', SourceID = ? WHERE JournalID = ?`).run(bill.PurchaseID, journalId);

    logAudit({
      companyId: req.user.companyId, branchId: bill.BranchID, userId: req.user.userId,
      action: 'CANCEL_PURCHASE', entityType: 'PurchaseHeader', entityId: bill.PurchaseID,
      details: `${bill.PurchaseNo}: ${reason}`, ip: req.ip
    });
    return journalId;
  });

  try {
    res.json({ success: true, purchaseNo: bill.PurchaseNo, reversalJournalId: tx() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
