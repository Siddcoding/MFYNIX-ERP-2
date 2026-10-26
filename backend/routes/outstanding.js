const express = require('express');
const db = require('../db');
const { requireAuth, resolveBranchScope } = require('../middleware/auth');
const { logAudit } = require('./auth');

const router = express.Router();
router.use(requireAuth);

const OUTSTANDING_ROLES = ['Super Admin', 'Company Admin', 'Accountant', 'Branch Manager', 'Auditor', 'Cashier'];
router.use((req, res, next) => {
  if (!OUTSTANDING_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'You do not have access to Outstanding' });
  }
  next();
});
function requireWriteRights(req, res, next) {
  if (['Auditor', 'Read Only'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Your role is read-only' });
  }
  next();
}

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
function daysBetween(a, b) { return Math.floor((new Date(b) - new Date(a)) / 86400000); }

// The ageing buckets the Mfynix document specifies in section 14.
const BUCKETS = [
  { key: '0-30', label: '0–30 days', min: 0, max: 30 },
  { key: '31-60', label: '31–60 days', min: 31, max: 60 },
  { key: '61-90', label: '61–90 days', min: 61, max: 90 },
  { key: '91-180', label: '91–180 days', min: 91, max: 180 },
  { key: '180+', label: 'Over 180 days', min: 181, max: Infinity }
];
function bucketFor(days) {
  return (BUCKETS.find(b => days >= b.min && days <= b.max) || BUCKETS[BUCKETS.length - 1]).key;
}

/**
 * Every unsettled invoice for a party type, with how much is still open.
 *
 * Open amount = invoice net less everything allocated against it. Cancelled
 * documents are excluded entirely - they were reversed, so there is nothing to
 * collect. This is the single source of truth for outstanding, ageing, and the
 * credit-limit check in services/policy.js.
 */
function openDocuments(companyId, { branchId, partyType, partyId, asOn }) {
  const today = asOn || new Date().toISOString().slice(0, 10);
  const isSales = partyType === 'Customer';

  const rows = isSales
    ? db.prepare(
        `SELECT s.InvoiceID AS DocID, 'SalesInvoice' AS DocType, s.InvoiceNo AS DocNo,
                s.InvoiceDate AS DocDate, s.NetAmount, s.BranchID, b.BranchName, s.DueDate AS StoredDueDate,
                c.CustomerID AS PartyID, c.CustomerName AS PartyName, c.CreditDays
         FROM SalesHeader s
         JOIN Customer c ON c.CustomerID = s.CustomerID
         JOIN Branch b ON b.BranchID = s.BranchID
         WHERE s.CompanyID = ? AND s.Status != 'Cancelled' AND date(s.InvoiceDate) <= date(?)
           ${branchId ? 'AND s.BranchID = ?' : ''} ${partyId ? 'AND s.CustomerID = ?' : ''}`
      ).all(...[companyId, today, branchId, partyId].filter(v => v !== undefined && v !== null))
    : db.prepare(
        `SELECT p.PurchaseID AS DocID, 'PurchaseInvoice' AS DocType, p.PurchaseNo AS DocNo,
                p.PurchaseDate AS DocDate, p.NetAmount, p.BranchID, b.BranchName, p.DueDate AS StoredDueDate,
                sp.SupplierID AS PartyID, sp.SupplierName AS PartyName, sp.CreditDays
         FROM PurchaseHeader p
         JOIN Supplier sp ON sp.SupplierID = p.SupplierID
         JOIN Branch b ON b.BranchID = p.BranchID
         WHERE p.CompanyID = ? AND p.Status != 'Cancelled' AND date(p.PurchaseDate) <= date(?)
           ${branchId ? 'AND p.BranchID = ?' : ''} ${partyId ? 'AND p.SupplierID = ?' : ''}`
      ).all(...[companyId, today, branchId, partyId].filter(v => v !== undefined && v !== null));

  const allocStmt = db.prepare(
    `SELECT COALESCE(SUM(Amount),0) AS a FROM Allocation
     WHERE CompanyID = ? AND DocType = ? AND DocID = ?`
  );

  return rows.map(r => {
    const allocated = allocStmt.get(companyId, r.DocType, r.DocID).a;
    const open = round2(r.NetAmount - allocated);
    const age = daysBetween(r.DocDate, today);
    // OTC-06: ageing runs from the due date the document actually carries (set
    // from its payment term when it was raised); the old credit-days guess is
    // only a fallback for documents booked before terms existed.
    const dueDate = r.StoredDueDate || new Date(new Date(r.DocDate).getTime() + (r.CreditDays || 0) * 86400000).toISOString().slice(0, 10);
    const overdueDays = daysBetween(dueDate, today);
    return {
      ...r,
      NetAmount: round2(r.NetAmount),
      Allocated: round2(allocated),
      OpenAmount: open,
      AgeDays: age,
      Bucket: bucketFor(overdueDays > 0 ? overdueDays : 0),
      DueDate: dueDate,
      OverdueDays: overdueDays > 0 ? overdueDays : 0,
      Overdue: overdueDays > 0
    };
  }).filter(r => r.OpenAmount > 0.009);   // fully settled documents drop out
}

// ---------------- Outstanding summary, party by party ----------------
// GET /outstanding/customers?branchId=&asOn=
router.get('/:partyType(customers|suppliers)', (req, res) => {
  const partyType = req.params.partyType === 'customers' ? 'Customer' : 'Supplier';
  const branchId = resolveBranchScope(req);
  const docs = openDocuments(req.user.companyId, { branchId, partyType, asOn: req.query.asOn });

  const byParty = new Map();
  docs.forEach(d => {
    if (!byParty.has(d.PartyID)) {
      byParty.set(d.PartyID, {
        partyId: d.PartyID, partyName: d.PartyName, total: 0, overdue: 0, invoices: 0,
        buckets: Object.fromEntries(BUCKETS.map(b => [b.key, 0])), oldestDays: 0
      });
    }
    const p = byParty.get(d.PartyID);
    p.total += d.OpenAmount;
    p.invoices += 1;
    p.buckets[d.Bucket] += d.OpenAmount;
    if (d.Overdue) p.overdue += d.OpenAmount;
    p.oldestDays = Math.max(p.oldestDays, d.AgeDays);
  });

  const parties = [...byParty.values()]
    .map(p => ({
      ...p, total: round2(p.total), overdue: round2(p.overdue),
      buckets: Object.fromEntries(Object.entries(p.buckets).map(([k, v]) => [k, round2(v)]))
    }))
    .sort((a, b) => b.total - a.total);

  const totals = {
    total: round2(parties.reduce((s, p) => s + p.total, 0)),
    overdue: round2(parties.reduce((s, p) => s + p.overdue, 0)),
    buckets: Object.fromEntries(BUCKETS.map(b => [b.key, round2(parties.reduce((s, p) => s + p.buckets[b.key], 0))]))
  };

  res.json({ partyType, buckets: BUCKETS.map(b => ({ key: b.key, label: b.label })), parties, totals });
});

// ---------------- Every open document for one party ----------------
router.get('/:partyType(customers|suppliers)/:partyId', (req, res) => {
  const partyType = req.params.partyType === 'customers' ? 'Customer' : 'Supplier';
  const branchId = resolveBranchScope(req);
  const docs = openDocuments(req.user.companyId, {
    branchId, partyType, partyId: Number(req.params.partyId), asOn: req.query.asOn
  });
  res.json({
    partyType,
    partyName: docs.length ? docs[0].PartyName : '',
    documents: docs.sort((a, b) => a.DocDate.localeCompare(b.DocDate)),
    totalOpen: round2(docs.reduce((s, d) => s + d.OpenAmount, 0))
  });
});

// ---------------- Allocate a receipt / payment to invoices ----------------
// POST /outstanding/allocate
// { partyType, partyId, journalId?, allocDate, lines: [{ docType, docId, amount }] }
//
// This is what turns a bare "money received" voucher into a settled invoice.
// Over-allocating a document is refused, so a customer's balance can never go
// negative because someone double-applied a receipt.
router.post('/allocate', requireWriteRights, (req, res) => {
  const { partyType, partyId, journalId, allocDate, lines } = req.body;
  if (!['Customer', 'Supplier'].includes(partyType)) {
    return res.status(400).json({ error: "partyType must be 'Customer' or 'Supplier'" });
  }
  if (!partyId || !allocDate || !Array.isArray(lines) || lines.length === 0) {
    return res.status(400).json({ error: 'partyId, allocDate and at least one line are required' });
  }

  const tx = db.transaction(() => {
    const open = openDocuments(req.user.companyId, { partyType, partyId });
    const openById = new Map(open.map(d => [`${d.DocType}:${d.DocID}`, d]));

    const insert = db.prepare(
      `INSERT INTO Allocation (CompanyID, BranchID, PartyType, PartyID, DocType, DocID, JournalID, Amount, AllocDate, CreatedBy)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    );

    let total = 0;
    lines.forEach(l => {
      const key = `${l.docType}:${l.docId}`;
      const doc = openById.get(key);
      if (!doc) throw new Error(`Document ${l.docType} #${l.docId} is not open for this party`);
      const amount = Number(l.amount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('Every allocation amount must be greater than zero');
      if (amount > doc.OpenAmount + 0.009) {
        throw new Error(`Cannot allocate ${amount} to ${doc.DocNo} - only ${doc.OpenAmount} is still open on it`);
      }
      insert.run(req.user.companyId, doc.BranchID, partyType, partyId, l.docType, l.docId,
                 journalId || null, amount, allocDate, req.user.userId);
      total += amount;
      doc.OpenAmount = round2(doc.OpenAmount - amount);   // guards two lines against the same doc
    });

    logAudit({
      companyId: req.user.companyId, branchId: req.user.branchId, userId: req.user.userId,
      action: 'ALLOCATE_PAYMENT', entityType: 'Allocation', entityId: partyId,
      details: `${partyType} #${partyId}: ${lines.length} document(s), ${round2(total)}`, ip: req.ip
    });
    return round2(total);
  });

  try {
    res.status(201).json({ success: true, allocated: tx() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------------- Ageing report ----------------
router.get('/report/ageing', (req, res) => {
  const partyType = req.query.partyType === 'Supplier' ? 'Supplier' : 'Customer';
  const branchId = resolveBranchScope(req);
  const docs = openDocuments(req.user.companyId, { branchId, partyType, asOn: req.query.asOn });

  res.json({
    partyType,
    asOn: req.query.asOn || new Date().toISOString().slice(0, 10),
    buckets: BUCKETS.map(b => ({
      key: b.key, label: b.label,
      amount: round2(docs.filter(d => d.Bucket === b.key).reduce((s, d) => s + d.OpenAmount, 0)),
      count: docs.filter(d => d.Bucket === b.key).length
    })),
    documents: docs.sort((a, b) => b.AgeDays - a.AgeDays),
    totalOpen: round2(docs.reduce((s, d) => s + d.OpenAmount, 0)),
    totalOverdue: round2(docs.filter(d => d.Overdue).reduce((s, d) => s + d.OpenAmount, 0))
  });
});

module.exports = router;
module.exports.openDocuments = openDocuments;
