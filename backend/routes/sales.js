const express = require('express');
const db = require('../db');
const { requireAuth, resolveBranchScope } = require('../middleware/auth');
const { logAudit } = require('./auth');
const { postJournalEntry } = require('./accounts');
const { assertStockAvailable, assertWithinCreditLimit } = require('../services/policy');
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

function getAccountId(companyId, code) { // legacy helper
  const row = db.prepare('SELECT AccountID FROM ChartOfAccounts WHERE CompanyID = ? AND AccountCode = ?').get(companyId, code);
  if (!row) throw new Error(`Chart of Accounts is missing required account ${code} - cannot post the accounting entry`);
  return row.AccountID;
}

// Invoice numbers now come from the central engine (services/numbering.js),
// which is concurrency-safe and financial-year aware. The old COUNT(*)+1 could
// hand the same number to two users saving at the same moment.

// GET /sales?page=&pageSize=&search=&from=&to=&status=&branchId=
// Returns a paged envelope, not a bare array - the old hardcoded LIMIT 200
// meant older invoices silently became unreachable.
router.get('/', (req, res) => {
  const branchId = resolveBranchScope(req);
  const { page, pageSize, offset } = readPaging(req.query);
  const { search, from, to, status } = req.query;

  const where = ['s.CompanyID = ?'];
  const args = [req.user.companyId];
  if (branchId) { where.push('s.BranchID = ?'); args.push(branchId); }
  if (status) { where.push('s.Status = ?'); args.push(status); }
  if (req.query.customerId) { where.push('s.CustomerID = ?'); args.push(Number(req.query.customerId)); }
  if (from) { where.push('date(s.InvoiceDate) >= date(?)'); args.push(from); }
  if (to) { where.push('date(s.InvoiceDate) <= date(?)'); args.push(to); }
  if (search) { where.push('(s.InvoiceNo LIKE ? OR c.CustomerName LIKE ?)'); const q = `%${search}%`; args.push(q, q); }
  const whereSql = where.join(' AND ');

  const total = db.prepare(
    `SELECT COUNT(*) AS c FROM SalesHeader s JOIN Customer c ON c.CustomerID = s.CustomerID WHERE ${whereSql}`
  ).get(...args).c;

  const rows = db.prepare(
    `SELECT s.*, c.CustomerName, b.BranchName FROM SalesHeader s
     JOIN Customer c ON c.CustomerID = s.CustomerID
     JOIN Branch b ON b.BranchID = s.BranchID
     WHERE ${whereSql} ORDER BY s.InvoiceID DESC LIMIT ? OFFSET ?`
  ).all(...args, pageSize, offset);

  res.json(pagedResult(rows, total, { page, pageSize }));
});

// Detail view. Carries everything the printable tax invoice needs - seller
// (branch) details, buyer details and both states, so the print view never has
// to make a second round of requests to render a legally complete invoice.
router.get('/:id', (req, res) => {
  const header = db.prepare(
    `SELECT s.*, c.CustomerName, c.GSTIN AS CustomerGSTIN, c.Address AS CustomerAddress,
            c.State AS CustomerState, c.Mobile AS CustomerMobile,
            b.BranchName, b.BranchCode, b.GSTIN AS BranchGSTIN, b.Address AS BranchAddress,
            b.State AS BranchState, b.Phone AS BranchPhone,
            (SELECT Description FROM PaymentTerm pt WHERE pt.PaymentTermID = s.PaymentTermID) AS PaymentTermName,
            COALESCE(s.OrderNo, so.OrderNo) AS OrderNo, COALESCE(s.OrderDate, so.OrderDate) AS OrderDate,
            co.CompanyName, co.GSTIN AS CompanyGSTIN, co.PAN AS CompanyPAN,
            co.BankName, co.BankAccountNo, co.BankIFSC, co.BankBranch, co.DeclarationText
     FROM SalesHeader s
     JOIN Customer c ON c.CustomerID = s.CustomerID
     JOIN Branch b ON b.BranchID = s.BranchID
     JOIN Company co ON co.CompanyID = s.CompanyID
     LEFT JOIN SalesOrder so ON so.OrderID = s.OrderID
     WHERE s.InvoiceID = ? AND s.CompanyID = ?`
  ).get(req.params.id, req.user.companyId);
  if (!header) return res.status(404).json({ error: 'Not found' });
  const lines = db.prepare(
    `SELECT sd.*, i.ItemName, i.HSN, i.Unit FROM SalesDetail sd JOIN Item i ON i.ItemID = sd.ItemID WHERE InvoiceID = ?`
  ).all(req.params.id);
  res.json({ header, lines });
});

// ---- Creating, editing and posting ----------------------------------------
//
// OTC-03: an invoice can be saved as a DRAFT (no number, no stock, no accounting)
// and edited freely; posting it assigns the number and does everything at once.
// A posted invoice is never edited: it changes only by cancellation or a credit note.

const TERM_OVERRIDE_ROLES = ['Super Admin', 'Company Admin', 'Branch Manager', 'Accountant'];
const COUNTER_MODES = { Cash: '1000', UPI: '1010', Card: '1010', Bank: '1010' };

function itemsFromBody(items) {
  return items.map(it => ({ ...it, itemId: Number(it.itemId) }));
}

/**
 * Validates and saves one sales document, inside the caller's transaction.
 * draftId: update this draft instead of creating a new document.
 * post:    issue the number, move stock and post the accounts.
 */
function saveSalesDocument({ req, body, branchId, draftId = null, post }) {
  const companyId = req.user.companyId;
  const { customerId, invoiceDate, items } = body;
  assertYearOpen(companyId, invoiceDate);
  assertPeriodOpen(companyId, 'Sales', invoiceDate);

  const party = partySnapshot(db, 'Customer', customerId);
  if (!party.name) throw new Error('Customer not found');
  const supplierState = branchState(db, branchId);
  const { lines: computed, totals } = buildLines(db, { companyId, branchId, items, supplierState, party });

  // Payment term and due date (MD-05/06, OTC-02). The customer's term is the
  // default; changing it on a document is for authorised roles only.
  const defaultTerm = termForParty(companyId, 'Customer', customerId);
  let term = defaultTerm;
  if (body.paymentTermId !== undefined && body.paymentTermId !== null && body.paymentTermId !== '') {
    const requested = getTerm(companyId, Number(body.paymentTermId));
    if (!requested) throw new Error('Payment term not found');
    if ((!defaultTerm || requested.PaymentTermID !== defaultTerm.PaymentTermID) && !TERM_OVERRIDE_ROLES.includes(req.user.role)) {
      throw new Error('Your role cannot change the payment term on a document - it comes from the customer master.');
    }
    term = requested;
  }
  const dueDate = body.dueDate && TERM_OVERRIDE_ROLES.includes(req.user.role)
    ? String(body.dueDate).slice(0, 10) : computeDueDate(term, invoiceDate);

  // Charges and rounding (OTC-02).
  const freight = Math.max(0, Number(body.freight) || 0);
  const otherCharges = Math.max(0, Number(body.otherCharges) || 0);
  const preRound = Math.round((totals.gross + freight + otherCharges) * 100) / 100;
  let roundOff = Number(body.roundOff) || 0;
  if (body.autoRound === true) roundOff = Math.round((Math.round(preRound) - preRound) * 100) / 100;
  const netAmount = Math.round((preRound + roundOff) * 100) / 100;
  const total = totals.taxable;
  const gstTotal = totals.tax;

  const mode = body.paymentMode ? String(body.paymentMode) : null;
  if (mode && !COUNTER_MODES[mode] && mode !== 'Credit') throw new Error('Payment mode must be Cash, UPI, Card, Bank or Credit');

  if (post) {
    assertStockAvailable(companyId, branchId, items, { action: 'sell' });
    // The credit limit is checked against the finished total; a counter sale
    // paid on the spot never adds to what the customer owes.
    if (!(mode && COUNTER_MODES[mode])) assertWithinCreditLimit(companyId, customerId, netAmount);
  }

  const extra = {
    ...headerFieldsFrom(body),
    PartyPhone: party.PartyPhone, PartyPAN: party.PartyPAN, PartyGSTIN: party.PartyGSTIN,
    PartyState: party.PartyState, PartyStateCode: party.PartyStateCode,
    PartyType: body.partyType || party.PartyType,
    PlaceOfSupply: body.placeOfSupply || party.PlaceOfSupply,
    PaymentTermID: term ? term.PaymentTermID : null, DueDate: dueDate,
    ShipTo: body.shipTo || null, Salesperson: body.salesperson || null, CustomerPORef: body.customerPORef || null,
    Freight: freight, OtherCharges: otherCharges, RoundOff: roundOff, PaymentMode: mode
  };
  const extraCols = Object.keys(extra).filter(k => extra[k] !== undefined && extra[k] !== null);

  let invoiceId, invoiceNo;
  if (draftId) {
    const d = db.prepare('SELECT * FROM SalesHeader WHERE InvoiceID = ? AND CompanyID = ?').get(draftId, companyId);
    if (!d) throw new Error('Invoice not found');
    if (d.Status !== 'Draft') throw new Error('Only a draft can be edited. A posted invoice changes only by cancellation or a credit note.');
    invoiceId = d.InvoiceID; invoiceNo = d.InvoiceNo;
    db.prepare('DELETE FROM SalesDetail WHERE InvoiceID = ?').run(invoiceId);
    const sets = ['InvoiceDate = ?', 'CustomerID = ?', 'BranchID = ?', 'Total = ?', 'GST = ?', 'NetAmount = ?', ...extraCols.map(c => `${c} = ?`)];
    db.prepare(`UPDATE SalesHeader SET ${sets.join(', ')} WHERE InvoiceID = ?`)
      .run(invoiceDate, customerId, branchId, total, gstTotal, netAmount, ...extraCols.map(c => extra[c]), invoiceId);
  } else {
    invoiceNo = post ? nextDocumentNumber(companyId, branchId, 'INV', invoiceDate) : `DRAFT-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
    invoiceId = db.prepare(
      `INSERT INTO SalesHeader (CompanyID, BranchID, InvoiceNo, InvoiceDate, CustomerID, Total, GST, NetAmount, CreatedBy, Status${
        extraCols.length ? ', ' + extraCols.join(', ') : ''})
       VALUES (?,?,?,?,?,?,?,?,?,?${extraCols.map(() => ',?').join('')})`
    ).run(companyId, branchId, invoiceNo, invoiceDate, customerId, total, gstTotal, netAmount,
      req.user.userId, post ? 'Posted' : 'Draft', ...extraCols.map(c => extra[c])).lastInsertRowid;
    if (!post) {
      invoiceNo = `DRAFT-${invoiceId}`;
      db.prepare('UPDATE SalesHeader SET InvoiceNo = ? WHERE InvoiceID = ?').run(invoiceNo, invoiceId);
    }
  }

  const insertLine = db.prepare(
    `INSERT INTO SalesDetail (InvoiceID, ItemID, Qty, Rate, Discount, GST, Amount, ${LINE_COLUMNS.join(', ')})
     VALUES (?,?,?,?,?,?,?${LINE_COLUMNS.map(() => ',?').join('')})`
  );
  let cogs = 0;
  computed.forEach(it => {
    insertLine.run(invoiceId, it.itemId, it.qty, it.rate, it.discountAmount, it.gstRate, it.grossAmount, ...lineValues(it));
  });

  if (!post) {
    logAudit({ companyId, branchId, userId: req.user.userId, action: draftId ? 'UPDATE_SALES_DRAFT' : 'CREATE_SALES_DRAFT', entityType: 'SalesHeader', entityId: invoiceId, details: invoiceNo, ip: req.ip });
    return { invoiceId, invoiceNo, netAmount, status: 'Draft', dueDate };
  }

  // ---- Posting: number (issued above or now), stock, accounting ----
  if (draftId) {
    invoiceNo = nextDocumentNumber(companyId, branchId, 'INV', invoiceDate);
    db.prepare(`UPDATE SalesHeader SET InvoiceNo = ?, Status = 'Posted' WHERE InvoiceID = ?`).run(invoiceNo, invoiceId);
  }
  computed.forEach(it => {
    const r = postStock({ companyId, branchId, itemId: it.itemId, transType: 'SALE', refType: 'SalesHeader', refId: invoiceId, qty: it.qty, dir: 'out', date: invoiceDate });
    cogs += r.value;
  });
  cogs = Math.round(cogs * 100) / 100;

  logAudit({
    companyId, branchId, userId: req.user.userId,
    action: 'CREATE_SALES_INVOICE', entityType: 'SalesHeader', entityId: invoiceId,
    details: invoiceNo, ip: req.ip
  });

  // Dr Debtors (everything owed), Cr Sales (taxable), Cr GST output, Cr charges,
  // +/- round-off. Under perpetual valuation the cost of what left is also
  // expensed: Dr Cost of Goods Sold, Cr Inventory.
  const lines = [{ accountId: acct(companyId, '1100'), debit: netAmount, credit: 0 }];
  if (total > 0) lines.push({ accountId: acct(companyId, '4000'), debit: 0, credit: total });
  if (gstTotal > 0) lines.push({ accountId: acct(companyId, '2100'), debit: 0, credit: gstTotal });
  if (freight + otherCharges > 0) lines.push({ accountId: acct(companyId, '4010'), debit: 0, credit: freight + otherCharges });
  if (roundOff > 0) lines.push({ accountId: acct(companyId, '5920'), debit: 0, credit: roundOff });
  if (roundOff < 0) lines.push({ accountId: acct(companyId, '5920'), debit: -roundOff, credit: 0 });
  if (cogs > 0) {
    lines.push({ accountId: acct(companyId, '5010'), debit: cogs, credit: 0 });
    lines.push({ accountId: acct(companyId, '1200'), debit: 0, credit: cogs });
  }
  postJournalEntry(db, {
    companyId, branchId, entryDate: invoiceDate,
    narration: `Sales invoice ${invoiceNo}`, sourceType: 'SalesInvoice', sourceId: invoiceId,
    createdBy: req.user.userId, lines, partyType: 'Customer', partyId: customerId
  });

  // OTC-04: a counter sale paid on the spot posts its receipt automatically
  // and is settled in the same breath.
  let receiptJournalId = null;
  if (mode && COUNTER_MODES[mode] && netAmount > 0) {
    receiptJournalId = postJournalEntry(db, {
      companyId, branchId, entryDate: invoiceDate,
      narration: `${mode} received with invoice ${invoiceNo}`, sourceType: 'Receipt', sourceId: invoiceId,
      createdBy: req.user.userId, partyType: 'Customer', partyId: customerId,
      lines: [{ accountId: acct(companyId, COUNTER_MODES[mode]), debit: netAmount, credit: 0 },
              { accountId: acct(companyId, '1100'), debit: 0, credit: netAmount }]
    });
    db.prepare(
      `INSERT INTO Allocation (CompanyID, BranchID, PartyType, PartyID, DocType, DocID, JournalID, Amount, AllocDate, CreatedBy)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(companyId, branchId, 'Customer', customerId, 'SalesInvoice', invoiceId, receiptJournalId, netAmount, invoiceDate, req.user.userId);
    db.prepare('UPDATE SalesHeader SET ReceiptJournalID = ? WHERE InvoiceID = ?').run(receiptJournalId, invoiceId);
  }

  return { invoiceId, invoiceNo, netAmount, status: 'Posted', dueDate, receiptJournalId };
}

function salesErrorStatus(e) {
  return /Not enough stock|credit limit|Customer not found|financial year|locked|payment term|Payment term|Payment mode|Only a draft|Invoice not found|role cannot/i.test(e.message);
}

function validateBody(body) {
  const { customerId, invoiceDate, items } = body;
  if (!customerId || !invoiceDate || !Array.isArray(items) || items.length === 0) {
    return 'customerId, invoiceDate and at least one item are required';
  }
  return null;
}

// POST /sales  { customerId, invoiceDate, items: [...], saveAsDraft?, paymentTermId?, paymentMode?, freight?, ... }
router.post('/', (req, res) => {
  const branchId = req.user.branchId || req.body.branchId;
  if (!branchId) return res.status(400).json({ error: 'branchId is required (head-office users must specify one)' });
  const bad = validateBody(req.body);
  if (bad) return res.status(400).json({ error: bad });
  try {
    const result = db.transaction(() => saveSalesDocument({ req, body: req.body, branchId, post: req.body.saveAsDraft !== true }))();
    res.status(201).json(result);
  } catch (e) {
    res.status(salesErrorStatus(e) ? 400 : 500).json({ error: salesErrorStatus(e) ? e.message : 'Failed to create invoice: ' + e.message });
  }
});

// PUT /sales/:id  - edit a DRAFT (same body as POST)
router.put('/:id', (req, res) => {
  const d = db.prepare('SELECT * FROM SalesHeader WHERE InvoiceID = ? AND CompanyID = ?').get(req.params.id, req.user.companyId);
  if (!d) return res.status(404).json({ error: 'Invoice not found' });
  if (req.user.branchId && d.BranchID !== req.user.branchId) return res.status(403).json({ error: 'You can only edit invoices of your own branch' });
  const bad = validateBody(req.body);
  if (bad) return res.status(400).json({ error: bad });
  try {
    const result = db.transaction(() => saveSalesDocument({ req, body: req.body, branchId: d.BranchID, draftId: d.InvoiceID, post: false }))();
    res.json(result);
  } catch (e) {
    res.status(salesErrorStatus(e) ? 400 : 500).json({ error: e.message });
  }
});

// POST /sales/:id/post - turn a draft into a posted invoice (optionally with edits in the body)
router.post('/:id/post', (req, res) => {
  const d = db.prepare('SELECT * FROM SalesHeader WHERE InvoiceID = ? AND CompanyID = ?').get(req.params.id, req.user.companyId);
  if (!d) return res.status(404).json({ error: 'Invoice not found' });
  if (d.Status !== 'Draft') return res.status(409).json({ error: 'This invoice is already posted' });
  if (req.user.branchId && d.BranchID !== req.user.branchId) return res.status(403).json({ error: 'You can only post invoices of your own branch' });

  let body = req.body && req.body.items ? req.body : null;
  if (!body) {
    const lines = db.prepare('SELECT * FROM SalesDetail WHERE InvoiceID = ?').all(d.InvoiceID);
    body = {
      customerId: d.CustomerID, invoiceDate: d.InvoiceDate, paymentTermId: d.PaymentTermID, dueDate: undefined,
      shipTo: d.ShipTo, salesperson: d.Salesperson, customerPORef: d.CustomerPORef,
      freight: d.Freight, otherCharges: d.OtherCharges, roundOff: d.RoundOff, paymentMode: d.PaymentMode,
      refNo: d.RefNo, remarks: d.Remarks, orderNo: d.OrderNo,
      items: lines.map(l => ({ itemId: l.ItemID, qty: l.Qty, rate: l.Rate, discountPercent: l.DiscountPercent || 0,
        discount: l.DiscountPercent ? 0 : l.Discount, gst: l.GST, batchNo: l.BatchNo, mfgDate: l.MfgDate, expDate: l.ExpDate }))
    };
  }
  try {
    const result = db.transaction(() => saveSalesDocument({ req, body, branchId: d.BranchID, draftId: d.InvoiceID, post: true }))();
    res.json(result);
  } catch (e) {
    res.status(salesErrorStatus(e) ? 400 : 500).json({ error: e.message });
  }
});

// DELETE /sales/:id - only drafts may be discarded; posted documents are cancelled
router.delete('/:id', (req, res) => {
  const d = db.prepare('SELECT * FROM SalesHeader WHERE InvoiceID = ? AND CompanyID = ?').get(req.params.id, req.user.companyId);
  if (!d) return res.status(404).json({ error: 'Invoice not found' });
  if (d.Status !== 'Draft') return res.status(409).json({ error: 'Only a draft can be discarded. Cancel a posted invoice instead.' });
  db.transaction(() => {
    db.prepare('DELETE FROM SalesDetail WHERE InvoiceID = ?').run(d.InvoiceID);
    db.prepare('DELETE FROM SalesHeader WHERE InvoiceID = ?').run(d.InvoiceID);
    logAudit({ companyId: req.user.companyId, branchId: d.BranchID, userId: req.user.userId, action: 'DISCARD_SALES_DRAFT', entityType: 'SalesHeader', entityId: d.InvoiceID, details: d.InvoiceNo, ip: req.ip });
  })();
  res.json({ success: true });
});

/**
 * Refuses to touch a document whose GST return for that period has already
 * been filed. Once a return carries an ARN, changing the underlying invoices
 * would put the books out of step with what was filed with the department -
 * the correct remedy at that point is a credit note in the next period, not
 * a retro-active cancellation.
 */
function assertPeriodNotFiled(companyId, branchId, dateStr) {
  const period = String(dateStr).slice(0, 7);
  const filed = db.prepare(
    `SELECT ReturnType, ARN FROM GSTReturnLog
     WHERE CompanyID = ? AND Period = ? AND Status = 'Filed' AND (BranchID = ? OR BranchID IS NULL)`
  ).get(companyId, period, branchId);
  if (filed) {
    throw new Error(`The ${filed.ReturnType} for ${period} has already been filed (ARN ${filed.ARN}). Raise a credit note in the current period instead of cancelling this document.`);
  }
}

// POST /sales/:id/cancel  { reason }
// Cancels a posted invoice by REVERSING it, never by deleting it: the original
// invoice, its stock movement and its journal entry all stay in place, and
// mirror-image entries are added. That keeps the audit trail intact and the
// invoice number permanently consumed, which is what GST law requires.
router.post('/:id/cancel', (req, res) => {
  const invoice = db.prepare('SELECT * FROM SalesHeader WHERE InvoiceID = ? AND CompanyID = ?').get(req.params.id, req.user.companyId);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  if (invoice.Status === 'Cancelled') return res.status(409).json({ error: 'This invoice is already cancelled' });
  if (req.user.branchId && invoice.BranchID !== req.user.branchId) {
    return res.status(403).json({ error: 'You can only cancel invoices raised by your own branch' });
  }
  const { reason } = req.body;
  if (!reason || String(reason).trim().length < 3) {
    return res.status(400).json({ error: 'A cancellation reason is required' });
  }

  if (invoice.Status === 'Draft') return res.status(409).json({ error: 'A draft has no postings - discard it instead of cancelling' });
  const tx = db.transaction(() => {
    const companyId = req.user.companyId;
    const today = new Date().toISOString().slice(0, 10);
    assertPeriodNotFiled(companyId, invoice.BranchID, invoice.InvoiceDate);
    assertPeriodOpen(companyId, 'Sales', invoice.InvoiceDate);
    assertPeriodOpen(companyId, 'Sales', today);

    db.prepare(`UPDATE SalesHeader SET Status = 'Cancelled' WHERE InvoiceID = ?`).run(invoice.InvoiceID);

    // Put the stock back at the cost it left at (not today's average), so the
    // cancellation cannot create or destroy inventory value.
    const out = db.prepare(
      `SELECT ItemID, SUM(OutQty) AS q, SUM(-ValueAmount) AS v FROM StockLedger
       WHERE CompanyID = ? AND RefType = 'SalesHeader' AND RefID = ? AND TransType = 'SALE' GROUP BY ItemID`
    ).all(companyId, invoice.InvoiceID);
    out.forEach(r => {
      if (r.q > 0) postStock({ companyId, branchId: invoice.BranchID, itemId: r.ItemID, transType: 'CANCEL_REVERSAL',
        refType: 'SalesHeader', refId: invoice.InvoiceID, qty: r.q, dir: 'in', date: today, value: r.v || 0 });
    });

    // Mirror-image journals: the invoice, and any receipt taken with it.
    const journals = db.prepare(
      `SELECT JournalID, SourceType FROM JournalEntry
       WHERE CompanyID = ? AND SourceID = ? AND SourceType IN ('SalesInvoice','Receipt') AND ReversedByID IS NULL ORDER BY JournalID`
    ).all(companyId, invoice.InvoiceID);
    let journalId = null;
    journals.forEach(j => {
      const rid = reverseJournal({ journalId: j.JournalID, companyId, date: today, reason, userId: req.user.userId,
        narrationPrefix: `Cancellation of sales invoice ${invoice.InvoiceNo} - reversal of` });
      db.prepare(`UPDATE JournalEntry SET SourceType = 'SalesCancellation', SourceID = ? WHERE JournalID = ?`).run(invoice.InvoiceID, rid);
      if (j.SourceType === 'SalesInvoice') journalId = rid;
    });
    if (invoice.ReceiptJournalID) db.prepare('DELETE FROM Allocation WHERE JournalID = ?').run(invoice.ReceiptJournalID);

    logAudit({
      companyId: req.user.companyId, branchId: invoice.BranchID, userId: req.user.userId,
      action: 'CANCEL_SALES_INVOICE', entityType: 'SalesHeader', entityId: invoice.InvoiceID,
      details: `${invoice.InvoiceNo}: ${reason}`, ip: req.ip
    });
    return journalId;
  });

  try {
    const journalId = tx();
    res.json({ success: true, invoiceNo: invoice.InvoiceNo, reversalJournalId: journalId });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
module.exports.assertPeriodNotFiled = assertPeriodNotFiled;
