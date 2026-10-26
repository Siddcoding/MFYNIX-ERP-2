const express = require('express');
const db = require('../db');
const { requireAuth, resolveBranchScope } = require('../middleware/auth');
const { logAudit } = require('./auth');
const { postJournalEntry } = require('./accounts');
const { nextDocumentNumber, assertYearOpen } = require('../services/numbering');
const { assertStockAvailable } = require('../services/policy');
const { readPaging, pagedResult } = require('../services/paging');
const {
  headerFieldsFrom, partySnapshot, branchState, buildLines, LINE_COLUMNS, lineValues
} = require('../services/documentFields');

const { accountId: acct, assertPeriodOpen } = require('../services/posting');
const { postStock, isPerpetual, costRow, fallbackCost } = require('../services/valuation');

const router = express.Router();
router.use(requireAuth);

const NOTE_ROLES = ['Super Admin', 'Company Admin', 'Accountant', 'Branch Manager', 'Auditor'];
router.use((req, res, next) => {
  if (!NOTE_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'You do not have access to Credit / Debit Notes' });
  }
  next();
});
function requirePostingRights(req, res, next) {
  if (['Auditor', 'Read Only'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Your role is read-only' });
  }
  next();
}

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

function getAccountId(companyId, code) {
  const row = db.prepare('SELECT AccountID FROM ChartOfAccounts WHERE CompanyID = ? AND AccountCode = ?').get(companyId, code);
  if (!row) throw new Error(`Chart of Accounts is missing required account ${code}`);
  return row.AccountID;
}

/**
 * How much of an invoice a note may still cover.
 *
 * You cannot credit more than you billed, so the original invoice value less
 * anything already credited against it is the ceiling. Without this, repeated
 * credit notes could turn a customer's balance negative and quietly hand them
 * credit that was never earned.
 */
function creditableRemaining(companyId, docType, docId) {
  const invoice = docType === 'SalesInvoice'
    ? db.prepare('SELECT NetAmount, Status FROM SalesHeader WHERE InvoiceID = ? AND CompanyID = ?').get(docId, companyId)
    : db.prepare('SELECT NetAmount, Status FROM PurchaseHeader WHERE PurchaseID = ? AND CompanyID = ?').get(docId, companyId);
  if (!invoice) throw new Error('The document this note is raised against was not found');
  if (invoice.Status === 'Cancelled') {
    throw new Error('That document is cancelled — it was already reversed in full, so there is nothing to credit');
  }
  const noted = db.prepare(
    `SELECT COALESCE(SUM(NetAmount),0) AS t FROM NoteHeader
     WHERE CompanyID = ? AND AgainstDocType = ? AND AgainstDocID = ? AND Status != 'Cancelled'`
  ).get(companyId, docType, docId).t;
  return round2(invoice.NetAmount - noted);
}

// ---------------- List ----------------
router.get('/', (req, res) => {
  const branchId = resolveBranchScope(req);
  const { page, pageSize, offset } = readPaging(req.query);
  const { noteType, search, from, to } = req.query;

  const where = ['n.CompanyID = ?'];
  const args = [req.user.companyId];
  if (branchId) { where.push('n.BranchID = ?'); args.push(branchId); }
  if (noteType) { where.push('n.NoteType = ?'); args.push(noteType); }
  if (from) { where.push('date(n.NoteDate) >= date(?)'); args.push(from); }
  if (to) { where.push('date(n.NoteDate) <= date(?)'); args.push(to); }
  if (search) { where.push('(n.NoteNo LIKE ? OR n.Reason LIKE ?)'); const q = `%${search}%`; args.push(q, q); }
  const whereSql = where.join(' AND ');

  const total = db.prepare(`SELECT COUNT(*) AS c FROM NoteHeader n WHERE ${whereSql}`).get(...args).c;
  const rows = db.prepare(
    `SELECT n.*, b.BranchName,
            CASE WHEN n.PartyType = 'Customer'
                 THEN (SELECT CustomerName FROM Customer WHERE CustomerID = n.PartyID)
                 ELSE (SELECT SupplierName FROM Supplier WHERE SupplierID = n.PartyID) END AS PartyName,
            CASE WHEN n.AgainstDocType = 'SalesInvoice'
                 THEN (SELECT InvoiceNo FROM SalesHeader WHERE InvoiceID = n.AgainstDocID)
                 ELSE (SELECT PurchaseNo FROM PurchaseHeader WHERE PurchaseID = n.AgainstDocID) END AS AgainstDocNo
     FROM NoteHeader n JOIN Branch b ON b.BranchID = n.BranchID
     WHERE ${whereSql} ORDER BY n.NoteID DESC LIMIT ? OFFSET ?`
  ).all(...args, pageSize, offset);

  res.json(pagedResult(rows, total, { page, pageSize }));
});

router.get('/:id', (req, res) => {
  const header = db.prepare(
    `SELECT n.*, b.BranchName, b.BranchCode, b.GSTIN AS BranchGSTIN, b.Address AS BranchAddress, b.State AS BranchState,
            co.CompanyName, co.GSTIN AS CompanyGSTIN,
            CASE WHEN n.PartyType = 'Customer'
                 THEN (SELECT CustomerName FROM Customer WHERE CustomerID = n.PartyID)
                 ELSE (SELECT SupplierName FROM Supplier WHERE SupplierID = n.PartyID) END AS PartyName,
            CASE WHEN n.AgainstDocType = 'SalesInvoice'
                 THEN (SELECT InvoiceNo FROM SalesHeader WHERE InvoiceID = n.AgainstDocID)
                 ELSE (SELECT PurchaseNo FROM PurchaseHeader WHERE PurchaseID = n.AgainstDocID) END AS AgainstDocNo
     FROM NoteHeader n JOIN Branch b ON b.BranchID = n.BranchID
     JOIN Company co ON co.CompanyID = n.CompanyID
     WHERE n.NoteID = ? AND n.CompanyID = ?`
  ).get(req.params.id, req.user.companyId);
  if (!header) return res.status(404).json({ error: 'Note not found' });
  const lines = db.prepare(
    `SELECT nd.*, i.ItemName, i.HSN, i.Unit FROM NoteDetail nd JOIN Item i ON i.ItemID = nd.ItemID WHERE NoteID = ?`
  ).all(req.params.id);
  res.json({ header, lines });
});

// What can still be credited against an invoice, plus its lines to prefill from.
router.get('/against/:docType/:docId', (req, res) => {
  const docType = req.params.docType === 'purchase' ? 'PurchaseInvoice' : 'SalesInvoice';
  try {
    const remaining = creditableRemaining(req.user.companyId, docType, req.params.docId);
    const lines = docType === 'SalesInvoice'
      ? db.prepare(`SELECT sd.ItemID, sd.Qty, sd.Rate, sd.GST, i.ItemName, i.Unit
                    FROM SalesDetail sd JOIN Item i ON i.ItemID = sd.ItemID WHERE sd.InvoiceID = ?`).all(req.params.docId)
      : db.prepare(`SELECT pd.ItemID, pd.Qty, pd.Rate, pd.GST, i.ItemName, i.Unit
                    FROM PurchaseDetail pd JOIN Item i ON i.ItemID = pd.ItemID WHERE pd.PurchaseID = ?`).all(req.params.docId);
    res.json({ docType, remaining, lines });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * POST /notes
 * { noteType: 'Credit'|'Debit', noteDate, partyId, againstDocId?, reason,
 *   restoreStock, branchId?, items: [{ itemId, qty, rate, gst }] }
 *
 * A credit note against a sale:
 *   - takes the goods back into stock (unless it's a pure price allowance)
 *   - Dr Sales + Dr GST Output, Cr Debtors  (the exact mirror of the sale)
 *   - reduces what the customer owes, so it shows up in Outstanding immediately
 * A debit note against a purchase is the same idea in the other direction.
 */
router.post('/', requirePostingRights, (req, res) => {
  const branchId = req.user.branchId || req.body.branchId;
  if (!branchId) return res.status(400).json({ error: 'branchId is required (head-office users must specify one)' });

  const { noteType, noteDate, partyId, againstDocId, reason, items } = req.body;
  const restoreStock = req.body.restoreStock !== false;

  if (!['Credit', 'Debit'].includes(noteType)) {
    return res.status(400).json({ error: "noteType must be 'Credit' or 'Debit'" });
  }
  if (!noteDate || !partyId || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'noteDate, partyId and at least one line are required' });
  }
  if (!reason || String(reason).trim().length < 3) {
    return res.status(400).json({ error: 'A reason is required — a note has to be explainable at audit' });
  }

  const isCredit = noteType === 'Credit';
  const partyType = isCredit ? 'Customer' : 'Supplier';
  const againstDocType = isCredit ? 'SalesInvoice' : 'PurchaseInvoice';

  const tx = db.transaction(() => {
    assertYearOpen(req.user.companyId, noteDate);
    assertPeriodOpen(req.user.companyId, isCredit ? 'Sales' : 'Purchase', noteDate);

    items.forEach(it => {
      const qty = Number(it.qty), rate = Number(it.rate);
      if (!(qty > 0) || !(rate >= 0)) throw new Error('Every line needs a quantity above zero and a rate');
    });

    // A note carries the same statutory line detail as the document it
    // reverses - including the CGST/SGST or IGST split, which has to land on
    // the same heads the original did, or the return will not net off.
    const party = partySnapshot(db, partyType, partyId);
    const supplierState = branchState(db, branchId);
    const { lines: computed, totals } = buildLines(db, {
      companyId: req.user.companyId, branchId, items, supplierState, party
    });

    const total = totals.taxable;
    const gstTotal = totals.tax;
    const netAmount = totals.gross;

    // Cannot credit more than was billed on the original document.
    if (againstDocId) {
      const remaining = creditableRemaining(req.user.companyId, againstDocType, againstDocId);
      if (netAmount > remaining + 0.009) {
        throw new Error(`This note is ${netAmount} but only ${remaining} is left uncredited on that document`);
      }
    }

    // A DEBIT note sends goods back to the supplier, so the branch must have
    // them. A CREDIT note brings goods back in, which never fails.
    if (restoreStock && !isCredit) {
      assertStockAvailable(req.user.companyId, branchId, computed, { action: 'return' });
    }

    const noteNo = nextDocumentNumber(req.user.companyId, branchId, isCredit ? 'CN' : 'DN', noteDate);

    const extra = {
      ...headerFieldsFrom(req.body),
      PartyPhone: party.PartyPhone, PartyPAN: party.PartyPAN, PartyGSTIN: party.PartyGSTIN,
      PartyState: party.PartyState, PartyStateCode: party.PartyStateCode,
      PartyType: req.body.partyCategory || party.PartyType,
      PlaceOfSupply: req.body.placeOfSupply || party.PlaceOfSupply
    };
    const extraCols = Object.keys(extra).filter(k => extra[k] !== undefined && extra[k] !== null);

    const noteId = db.prepare(
      `INSERT INTO NoteHeader (CompanyID, BranchID, NoteType, NoteNo, NoteDate, PartyType, PartyID,
                               AgainstDocType, AgainstDocID, Reason, RestoreStock, Total, GST, NetAmount, CreatedBy${
        extraCols.length ? ', ' + extraCols.join(', ') : ''})
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?${extraCols.map(() => ',?').join('')})`
    ).run(req.user.companyId, branchId, noteType, noteNo, noteDate, partyType, partyId,
          againstDocId ? againstDocType : null, againstDocId || null, reason.trim(),
          restoreStock ? 1 : 0, total, gstTotal, netAmount, req.user.userId,
          ...extraCols.map(c => extra[c])).lastInsertRowid;

    const insertLine = db.prepare(
      `INSERT INTO NoteDetail (NoteID, ItemID, Qty, Rate, GST, Amount, Discount, ${LINE_COLUMNS.join(', ')})
       VALUES (?,?,?,?,?,?,?${LINE_COLUMNS.map(() => ',?').join('')})`
    );
    const companyId = req.user.companyId;
    const perpetual = isPerpetual(companyId);
    let stockValueMoved = 0;
    computed.forEach(l => {
      insertLine.run(noteId, l.itemId, l.qty, l.rate, l.gstRate, l.grossAmount, l.discountAmount, ...lineValues(l));
      if (!restoreStock) return;
      if (isCredit) {
        // Goods come back at the cost they left at on the original invoice,
        // or at today's average when the note is not tied to one.
        let unit = null;
        if (againstDocId) {
          const o = db.prepare(`SELECT SUM(OutQty) q, SUM(-ValueAmount) v FROM StockLedger WHERE CompanyID = ? AND RefType = 'SalesHeader' AND RefID = ? AND ItemID = ? AND TransType = 'SALE'`)
            .get(companyId, againstDocId, l.itemId);
          if (o && o.q > 0 && o.v > 0) unit = o.v / o.q;
        }
        if (unit === null) { const r = costRow(companyId, branchId, l.itemId); unit = r.Qty > 0 ? r.Value / r.Qty : fallbackCost(companyId, l.itemId); }
        const r = postStock({ companyId, branchId, itemId: l.itemId, transType: 'SALES_RETURN', refType: 'NoteHeader', refId: noteId, qty: l.qty, dir: 'in', date: noteDate, unitCost: unit });
        stockValueMoved += r.value;
      } else {
        const r = postStock({ companyId, branchId, itemId: l.itemId, transType: 'PURCHASE_RETURN', refType: 'NoteHeader', refId: noteId, qty: l.qty, dir: 'out', date: noteDate });
        stockValueMoved += r.value;
      }
    });
    stockValueMoved = Math.round(stockValueMoved * 100) / 100;

    // Accounting: the exact mirror of the original document. Under perpetual
    // valuation the goods' cost moves as well.
    const lines = [];
    if (isCredit) {
      if (total > 0) lines.push({ accountId: acct(companyId, '4000'), debit: total, credit: 0 });
      if (gstTotal > 0) lines.push({ accountId: acct(companyId, '2100'), debit: gstTotal, credit: 0 });
      lines.push({ accountId: acct(companyId, '1100'), debit: 0, credit: netAmount });
      if (perpetual && restoreStock && stockValueMoved > 0) {
        lines.push({ accountId: acct(companyId, '1200'), debit: stockValueMoved, credit: 0 });
        lines.push({ accountId: acct(companyId, '5010'), debit: 0, credit: stockValueMoved });
      }
    } else {
      lines.push({ accountId: acct(companyId, '2000'), debit: netAmount, credit: 0 });
      if (perpetual && restoreStock) {
        // Inventory leaves at its book value; any difference to the billed
        // amount is a price variance, taken to cost of goods sold.
        if (stockValueMoved > 0) lines.push({ accountId: acct(companyId, '1200'), debit: 0, credit: stockValueMoved });
        const diff = Math.round((total - stockValueMoved) * 100) / 100;
        if (diff > 0) lines.push({ accountId: acct(companyId, '5010'), debit: 0, credit: diff });
        if (diff < 0) lines.push({ accountId: acct(companyId, '5010'), debit: -diff, credit: 0 });
      } else if (total > 0) {
        lines.push({ accountId: acct(companyId, perpetual ? '5010' : '5000'), debit: 0, credit: total });
      }
      if (gstTotal > 0) lines.push({ accountId: acct(companyId, '1900'), debit: 0, credit: gstTotal });
    }

    const journalId = postJournalEntry(db, {
      companyId: req.user.companyId, branchId, entryDate: noteDate,
      narration: `${noteType} note ${noteNo} — ${reason.trim()}`,
      sourceType: isCredit ? 'CreditNote' : 'DebitNote', sourceId: noteId,
      createdBy: req.user.userId, lines, partyType, partyId
    });
    db.prepare('UPDATE NoteHeader SET JournalID = ? WHERE NoteID = ?').run(journalId, noteId);

    // A note against a specific invoice settles that much of it, so the invoice
    // stops showing as collectable in Outstanding.
    if (againstDocId) {
      db.prepare(
        `INSERT INTO Allocation (CompanyID, BranchID, PartyType, PartyID, DocType, DocID, JournalID, Amount, AllocDate, CreatedBy)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      ).run(req.user.companyId, branchId, partyType, partyId, againstDocType, againstDocId,
            journalId, netAmount, noteDate, req.user.userId);
    }

    logAudit({
      companyId: req.user.companyId, branchId, userId: req.user.userId,
      action: isCredit ? 'CREATE_CREDIT_NOTE' : 'CREATE_DEBIT_NOTE', entityType: 'NoteHeader', entityId: noteId,
      details: `${noteNo} ${netAmount}: ${reason.trim()}`, ip: req.ip
    });

    return { noteId, noteNo, netAmount, journalId };
  });

  try {
    res.status(201).json(tx());
  } catch (e) {
    const isRuleViolation = /Not enough stock|uncredited|financial year|cancelled|not found|reason|quantity|locked/i.test(e.message);
    res.status(isRuleViolation ? 400 : 500).json({
      error: isRuleViolation ? e.message : 'Failed to create the note: ' + e.message
    });
  }
});

module.exports = router;
