/**
 * R2 sales document chain: Quotation -> Sales Order -> Delivery -> Invoice.
 *
 * The invariant (OTC-12): a later document can never ship or bill more than the
 * open quantity of the one before it. Each order line carries DeliveredQty and
 * InvoicedQty; each delivery line carries InvoicedQty. Goods leave stock at the
 * delivery (goods issue, Dr COGS / Cr Inventory); revenue is booked at the
 * invoice (Dr Debtors / Cr Sales / Cr GST), so nothing is counted twice.
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
const { assertStockAvailable, customerOutstanding } = require('../services/policy');
const { createApprovalIfNeeded } = require('./approvals');

const router = express.Router();
router.use(requireAuth);

function round2(n) { return Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100; }
function today() { return new Date().toISOString().slice(0, 10); }
const CAN_WRITE = ['Super Admin', 'Company Admin', 'Branch Manager', 'Accountant', 'Sales Executive', 'Store Manager'];
function requireWrite(req, res, next) {
  if (!CAN_WRITE.includes(req.user.role)) return res.status(403).json({ error: 'You do not have rights to create sales documents' });
  next();
}

function computeTotals(companyId, branchId, items, customerId) {
  const party = partySnapshot(db, 'Customer', customerId);
  const supplierState = branchState(db, branchId);
  const { lines, totals } = buildLines(db, { companyId, branchId, items, supplierState, party });
  return { lines, totals, party };
}

// ============================ QUOTATIONS (CRM-03) ============================
router.get('/quotations', (req, res) => {
  const branchId = resolveBranchScope(req);
  const rows = db.prepare(
    `SELECT q.*, c.CustomerName FROM Quotation q JOIN Customer c ON c.CustomerID = q.CustomerID
     WHERE q.CompanyID = ? ${branchId ? 'AND q.BranchID = ?' : ''} ORDER BY q.QuotationID DESC LIMIT 200`
  ).all(...(branchId ? [req.user.companyId, branchId] : [req.user.companyId]));
  res.json(rows);
});
router.get('/quotations/:id', (req, res) => {
  const h = db.prepare('SELECT q.*, c.CustomerName FROM Quotation q JOIN Customer c ON c.CustomerID = q.CustomerID WHERE q.QuotationID = ? AND q.CompanyID = ?').get(req.params.id, req.user.companyId);
  if (!h) return res.status(404).json({ error: 'Quotation not found' });
  h.lines = db.prepare('SELECT ql.*, i.ItemName FROM QuotationLine ql JOIN Item i ON i.ItemID = ql.ItemID WHERE ql.QuotationID = ?').all(h.QuotationID);
  res.json(h);
});
router.post('/quotations', requireWrite, (req, res) => {
  const branchId = req.user.branchId || req.body.branchId;
  const { customerId, quoteDate, items, validUntil } = req.body;
  if (!branchId || !customerId || !quoteDate || !Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'branchId, customerId, quoteDate and at least one item are required' });
  }
  try {
    const result = db.transaction(() => {
      const { lines, totals } = computeTotals(req.user.companyId, branchId, items, customerId);
      const term = req.body.paymentTermId ? getTerm(req.user.companyId, Number(req.body.paymentTermId)) : termForParty(req.user.companyId, 'Customer', customerId);
      const no = nextDocumentNumber(req.user.companyId, branchId, 'QUO', quoteDate);
      const id = db.prepare(
        `INSERT INTO Quotation (CompanyID, BranchID, QuoteNo, QuoteDate, ValidUntil, CustomerID, PaymentTermID, Status, Total, GST, NetAmount, Remarks, CreatedBy)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(req.user.companyId, branchId, no, quoteDate, validUntil || null, customerId, term ? term.PaymentTermID : null,
        req.body.status || 'Draft', totals.taxable, totals.tax, totals.gross, req.body.remarks || null, req.user.userId).lastInsertRowid;
      const ins = db.prepare('INSERT INTO QuotationLine (QuotationID, ItemID, Qty, Rate, GST, Discount, Amount) VALUES (?,?,?,?,?,?,?)');
      lines.forEach((l, i) => ins.run(id, l.itemId, items[i].qty, items[i].rate, l.gstRate, l.discountAmount, l.grossAmount));
      logAudit({ companyId: req.user.companyId, branchId, userId: req.user.userId, action: 'CREATE_QUOTATION', entityType: 'Quotation', entityId: id, details: no, ip: req.ip });
      return { quotationId: id, quoteNo: no, netAmount: totals.gross };
    })();
    res.status(201).json(result);
  } catch (e) { res.status(/required|not found|year/i.test(e.message) ? 400 : 500).json({ error: e.message }); }
});
router.post('/quotations/:id/status', requireWrite, (req, res) => {
  const valid = ['Draft', 'Sent', 'Accepted', 'Rejected', 'Expired'];
  if (!valid.includes(req.body.status)) return res.status(400).json({ error: `status must be one of ${valid.join(', ')}` });
  const q = db.prepare('SELECT * FROM Quotation WHERE QuotationID = ? AND CompanyID = ?').get(req.params.id, req.user.companyId);
  if (!q) return res.status(404).json({ error: 'Quotation not found' });
  db.prepare('UPDATE Quotation SET Status = ? WHERE QuotationID = ?').run(req.body.status, q.QuotationID);
  logAudit({ companyId: req.user.companyId, branchId: q.BranchID, userId: req.user.userId, action: 'QUOTATION_STATUS', entityType: 'Quotation', entityId: q.QuotationID, details: `${q.QuoteNo} -> ${req.body.status}`, ip: req.ip });
  res.json({ success: true, status: req.body.status });
});

// ============================ SALES ORDERS (CRM-04/05/06) ============================
router.get('/orders', (req, res) => {
  const branchId = resolveBranchScope(req);
  const rows = db.prepare(
    `SELECT o.*, c.CustomerName FROM SalesOrder o JOIN Customer c ON c.CustomerID = o.CustomerID
     WHERE o.CompanyID = ? ${branchId ? 'AND o.BranchID = ?' : ''} ORDER BY o.OrderID DESC LIMIT 200`
  ).all(...(branchId ? [req.user.companyId, branchId] : [req.user.companyId]));
  res.json(rows);
});
router.get('/orders/:id', (req, res) => {
  const o = db.prepare('SELECT o.*, c.CustomerName FROM SalesOrder o JOIN Customer c ON c.CustomerID = o.CustomerID WHERE o.OrderID = ? AND o.CompanyID = ?').get(req.params.id, req.user.companyId);
  if (!o) return res.status(404).json({ error: 'Sales order not found' });
  o.lines = db.prepare(
    `SELECT ol.*, i.ItemName, (ol.Qty - ol.DeliveredQty) AS OpenToDeliver, (ol.DeliveredQty - ol.InvoicedQty) AS DeliveredNotInvoiced
     FROM SalesOrderLine ol JOIN Item i ON i.ItemID = ol.ItemID WHERE ol.OrderID = ?`
  ).all(o.OrderID);
  // CRM-07: show stock on hand per line so the user sees what can ship now.
  o.lines.forEach(l => {
    l.OnHand = db.prepare('SELECT COALESCE(SUM(InQty),0)-COALESCE(SUM(OutQty),0) AS s FROM StockLedger WHERE CompanyID=? AND BranchID=? AND ItemID=?').get(req.user.companyId, o.BranchID, l.ItemID).s;
  });
  res.json(o);
});
router.post('/orders', requireWrite, (req, res) => {
  const branchId = req.user.branchId || req.body.branchId;
  const { customerId, orderDate, items, quotationId } = req.body;
  if (!branchId || !customerId || !orderDate || !Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'branchId, customerId, orderDate and at least one item are required' });
  }
  try {
    const result = db.transaction(() => {
      const { lines, totals } = computeTotals(req.user.companyId, branchId, items, customerId);
      const term = req.body.paymentTermId ? getTerm(req.user.companyId, Number(req.body.paymentTermId)) : termForParty(req.user.companyId, 'Customer', customerId);
      const no = nextDocumentNumber(req.user.companyId, branchId, 'SO', orderDate);
      const id = db.prepare(
        `INSERT INTO SalesOrder (CompanyID, BranchID, OrderNo, OrderDate, CustomerID, PaymentTermID, QuotationID, CustomerPORef, RequestedDate, ShipTo, Status, Total, GST, NetAmount, Remarks, CreatedBy)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(req.user.companyId, branchId, no, orderDate, customerId, term ? term.PaymentTermID : null, quotationId || null,
        req.body.customerPORef || null, req.body.requestedDate || null, req.body.shipTo || null,
        'Open', totals.taxable, totals.tax, totals.gross, req.body.remarks || null, req.user.userId).lastInsertRowid;
      const ins = db.prepare('INSERT INTO SalesOrderLine (OrderID, ItemID, Qty, Rate, GST, Discount, Amount) VALUES (?,?,?,?,?,?,?)');
      lines.forEach((l, i) => ins.run(id, l.itemId, items[i].qty, items[i].rate, l.gstRate, l.discountAmount, l.grossAmount));
      if (quotationId) db.prepare("UPDATE Quotation SET Status = 'Accepted' WHERE QuotationID = ? AND CompanyID = ?").run(quotationId, req.user.companyId);

      // CRM-06: credit check at order time. Over the limit or with overdue
      // balance, the order is still created but routed for approval.
      let approval = null;
      const settings = db.prepare('SELECT * FROM CompanySettings WHERE CompanyID = ?').get(req.user.companyId) || {};
      const cust = db.prepare('SELECT CreditLimit FROM Customer WHERE CustomerID = ?').get(customerId) || {};
      const outstanding = customerOutstanding(req.user.companyId, customerId);
      if (cust.CreditLimit && (outstanding + totals.gross) > cust.CreditLimit + 0.009) {
        approval = createApprovalIfNeeded(db, { companyId: req.user.companyId, branchId, docType: 'SalesOrder', docId: id,
          amount: totals.gross, reason: `Order takes ${customerName(customerId)} to ${round2(outstanding + totals.gross)} against a limit of ${cust.CreditLimit}`, userId: req.user.userId, force: true });
        db.prepare("UPDATE SalesOrder SET Status = 'Pending approval' WHERE OrderID = ?").run(id);
      }
      logAudit({ companyId: req.user.companyId, branchId, userId: req.user.userId, action: 'CREATE_SALES_ORDER', entityType: 'SalesOrder', entityId: id, details: no, ip: req.ip });
      return { orderId: id, orderNo: no, netAmount: totals.gross, approvalRequired: !!approval, approvalId: approval ? approval.RequestID : null };
    })();
    res.status(201).json(result);
  } catch (e) { res.status(/required|not found|year|limit/i.test(e.message) ? 400 : 500).json({ error: e.message }); }
});

function customerName(id) { const c = db.prepare('SELECT CustomerName AS n FROM Customer WHERE CustomerID = ?').get(id); return c ? c.n : `#${id}`; }

function refreshOrderStatus(orderId) {
  const lines = db.prepare('SELECT Qty, DeliveredQty, InvoicedQty FROM SalesOrderLine WHERE OrderID = ?').all(orderId);
  const allDelivered = lines.every(l => l.DeliveredQty >= l.Qty - 1e-9);
  const anyDelivered = lines.some(l => l.DeliveredQty > 1e-9);
  const allInvoiced = lines.every(l => l.InvoicedQty >= l.Qty - 1e-9);
  const cur = db.prepare('SELECT Status FROM SalesOrder WHERE OrderID = ?').get(orderId).Status;
  if (cur === 'Cancelled' || cur === 'Pending approval') return;
  let status = 'Open';
  if (allInvoiced) status = 'Invoiced';
  else if (allDelivered) status = 'Delivered';
  else if (anyDelivered) status = 'Partly delivered';
  db.prepare('UPDATE SalesOrder SET Status = ? WHERE OrderID = ?').run(status, orderId);
}

// ============================ DELIVERIES (OTC-07/09) ============================
// A delivery issues goods against an order (full or partial) and can invoice at
// the same time. Goods leave stock here; revenue is booked on the invoice.
router.post('/orders/:id/deliver', requireWrite, (req, res) => {
  const order = db.prepare('SELECT * FROM SalesOrder WHERE OrderID = ? AND CompanyID = ?').get(req.params.id, req.user.companyId);
  if (!order) return res.status(404).json({ error: 'Sales order not found' });
  if (order.Status === 'Pending approval') return res.status(400).json({ error: 'This order is awaiting approval and cannot be delivered yet' });
  if (order.Status === 'Cancelled') return res.status(400).json({ error: 'This order is cancelled' });
  const deliveryDate = req.body.deliveryDate || today();
  // lines: [{ orderLineId, qty }] - defaults to the full open quantity when omitted.
  const wantInvoice = req.body.invoice === true;
  try {
    const result = db.transaction(() => {
      assertYearOpen(req.user.companyId, deliveryDate);
      assertPeriodOpen(req.user.companyId, 'Inventory', deliveryDate);
      const orderLines = db.prepare('SELECT * FROM SalesOrderLine WHERE OrderID = ?').all(order.OrderID);
      const byId = new Map(orderLines.map(l => [l.LineID, l]));
      let picks = Array.isArray(req.body.lines) && req.body.lines.length
        ? req.body.lines.map(p => ({ line: byId.get(Number(p.orderLineId)), qty: Number(p.qty) }))
        : orderLines.map(l => ({ line: l, qty: round2(l.Qty - l.DeliveredQty) })).filter(p => p.qty > 0);
      picks = picks.filter(p => p.line && p.qty > 0);
      if (!picks.length) throw new Error('Nothing to deliver - every line is already fully delivered');
      picks.forEach(p => {
        const open = round2(p.line.Qty - p.line.DeliveredQty);
        if (p.qty > open + 0.009) throw new Error(`Cannot deliver ${p.qty} of line ${p.line.LineID}; only ${open} is open`);
      });
      // Stock must be on hand to issue.
      assertStockAvailable(req.user.companyId, order.BranchID, picks.map(p => ({ itemId: p.line.ItemID, qty: p.qty })), { action: 'deliver' });

      const no = nextDocumentNumber(req.user.companyId, order.BranchID, 'DC', deliveryDate);
      const did = db.prepare(
        `INSERT INTO Delivery (CompanyID, BranchID, DeliveryNo, DeliveryDate, OrderID, CustomerID, Status, CreatedBy)
         VALUES (?,?,?,?,?,?,?,?)`
      ).run(req.user.companyId, order.BranchID, no, deliveryDate, order.OrderID, order.CustomerID, 'Delivered', req.user.userId).lastInsertRowid;
      const insLine = db.prepare('INSERT INTO DeliveryLine (DeliveryID, OrderLineID, ItemID, Qty, Rate, GST) VALUES (?,?,?,?,?,?)');
      let cogs = 0;
      picks.forEach(p => {
        insLine.run(did, p.line.LineID, p.line.ItemID, p.qty, p.line.Rate, p.line.GST);
        db.prepare('UPDATE SalesOrderLine SET DeliveredQty = DeliveredQty + ? WHERE LineID = ?').run(p.qty, p.line.LineID);
        const r = postStock({ companyId: req.user.companyId, branchId: order.BranchID, itemId: p.line.ItemID, transType: 'GOODS_ISSUE', refType: 'Delivery', refId: did, qty: p.qty, dir: 'out', date: deliveryDate });
        cogs += r.value;
      });
      cogs = round2(cogs);
      // Goods issue: Dr COGS, Cr Inventory (perpetual only).
      if (isPerpetual(req.user.companyId) && cogs > 0) {
        postJournalEntry(db, { companyId: req.user.companyId, branchId: order.BranchID, entryDate: deliveryDate,
          narration: `Goods issue on delivery ${no}`, sourceType: 'Delivery', sourceId: did, createdBy: req.user.userId,
          lines: [{ accountId: acct(req.user.companyId, '5010'), debit: cogs, credit: 0 }, { accountId: acct(req.user.companyId, '1200'), debit: 0, credit: cogs }] });
      }
      logAudit({ companyId: req.user.companyId, branchId: order.BranchID, userId: req.user.userId, action: 'CREATE_DELIVERY', entityType: 'Delivery', entityId: did, details: no, ip: req.ip });
      refreshOrderStatus(order.OrderID);

      let invoice = null;
      if (wantInvoice) invoice = invoiceDelivery(req, did);
      return { deliveryId: did, deliveryNo: no, cogs, invoice };
    })();
    res.status(201).json(result);
  } catch (e) { res.status(/open|deliver|stock|not found|year|locked|approval|cancelled/i.test(e.message) ? 400 : 500).json({ error: e.message }); }
});

// Build a tax invoice from a delivery. Revenue only - the goods already left at
// the delivery, so no stock or COGS is posted again (OTC-09).
function invoiceDelivery(req, deliveryId) {
  const companyId = req.user.companyId;
  const d = db.prepare('SELECT * FROM Delivery WHERE DeliveryID = ? AND CompanyID = ?').get(deliveryId, companyId);
  if (!d) throw new Error('Delivery not found');
  if (d.InvoiceID) throw new Error('This delivery is already invoiced');
  const order = db.prepare('SELECT * FROM SalesOrder WHERE OrderID = ?').get(d.OrderID);
  const dlines = db.prepare('SELECT * FROM DeliveryLine WHERE DeliveryID = ?').all(deliveryId);
  const items = dlines.map(l => ({ itemId: l.ItemID, qty: l.Qty, rate: l.Rate, gst: l.GST }));
  const invoiceDate = today();
  assertPeriodOpen(companyId, 'Sales', invoiceDate);
  const { lines: computed, totals, party } = computeTotals(companyId, d.BranchID, items, d.CustomerID);
  const term = getTerm(companyId, order.PaymentTermID) || termForParty(companyId, 'Customer', d.CustomerID);
  const dueDate = computeDueDate(term, invoiceDate);
  const invoiceNo = nextDocumentNumber(companyId, d.BranchID, 'INV', invoiceDate);
  const invId = db.prepare(
    `INSERT INTO SalesHeader (CompanyID, BranchID, InvoiceNo, InvoiceDate, CustomerID, Total, GST, NetAmount, CreatedBy, Status, OrderID, DeliveryID, PaymentTermID, DueDate, PartyGSTIN, PartyState, PartyStateCode)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(companyId, d.BranchID, invoiceNo, invoiceDate, d.CustomerID, totals.taxable, totals.tax, totals.gross,
    req.user.userId, 'Posted', d.OrderID, d.DeliveryID, term ? term.PaymentTermID : null, dueDate,
    party.PartyGSTIN, party.PartyState, party.PartyStateCode).lastInsertRowid;
  const { LINE_COLUMNS, lineValues } = require('../services/documentFields');
  const insLine = db.prepare(`INSERT INTO SalesDetail (InvoiceID, ItemID, Qty, Rate, Discount, GST, Amount, ${LINE_COLUMNS.join(', ')}) VALUES (?,?,?,?,?,?,?${LINE_COLUMNS.map(() => ',?').join('')})`);
  computed.forEach(it => insLine.run(invId, it.itemId, it.qty, it.rate, it.discountAmount, it.gstRate, it.grossAmount, ...lineValues(it)));
  // Revenue: Dr Debtors, Cr Sales, Cr GST output.
  const jl = [{ accountId: acct(companyId, '1100'), debit: totals.gross, credit: 0 }];
  if (totals.taxable > 0) jl.push({ accountId: acct(companyId, '4000'), debit: 0, credit: totals.taxable });
  if (totals.tax > 0) jl.push({ accountId: acct(companyId, '2100'), debit: 0, credit: totals.tax });
  postJournalEntry(db, { companyId, branchId: d.BranchID, entryDate: invoiceDate, narration: `Sales invoice ${invoiceNo} (from delivery ${d.DeliveryNo})`,
    sourceType: 'SalesInvoice', sourceId: invId, createdBy: req.user.userId, lines: jl, partyType: 'Customer', partyId: d.CustomerID });
  db.prepare("UPDATE Delivery SET Status = 'Invoiced', InvoiceID = ? WHERE DeliveryID = ?").run(invId, deliveryId);
  dlines.forEach(l => { if (l.OrderLineID) db.prepare('UPDATE SalesOrderLine SET InvoicedQty = InvoicedQty + ? WHERE LineID = ?').run(l.Qty, l.OrderLineID); });
  refreshOrderStatus(d.OrderID);
  logAudit({ companyId, branchId: d.BranchID, userId: req.user.userId, action: 'INVOICE_FROM_DELIVERY', entityType: 'SalesHeader', entityId: invId, details: invoiceNo, ip: req.ip });
  return { invoiceId: invId, invoiceNo, netAmount: totals.gross, dueDate };
}

router.post('/deliveries/:id/invoice', requireWrite, (req, res) => {
  try {
    const result = db.transaction(() => invoiceDelivery(req, Number(req.params.id)))();
    res.status(201).json(result);
  } catch (e) { res.status(/not found|already|locked|year/i.test(e.message) ? 400 : 500).json({ error: e.message }); }
});

router.get('/deliveries', (req, res) => {
  const branchId = resolveBranchScope(req);
  res.json(db.prepare(
    `SELECT d.*, c.CustomerName, o.OrderNo FROM Delivery d JOIN Customer c ON c.CustomerID = d.CustomerID JOIN SalesOrder o ON o.OrderID = d.OrderID
     WHERE d.CompanyID = ? ${branchId ? 'AND d.BranchID = ?' : ''} ORDER BY d.DeliveryID DESC LIMIT 200`
  ).all(...(branchId ? [req.user.companyId, branchId] : [req.user.companyId])));
});

module.exports = router;
