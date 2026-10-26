/**
 * Dunning (DUN-01..13): procedure masters with levels, an on-demand or
 * scheduled run that builds a proposal from overdue balances (net of receipts
 * and credit notes, read from Outstanding), notices by email/SMS/WhatsApp, and
 * a per-customer history.
 */
const express = require('express');
const db = require('../db');
const { requireAuth, resolveBranchScope } = require('../middleware/auth');
const { logAudit } = require('./auth');
const { openDocuments } = require('./outstanding');
const messaging = require('../services/messaging');

const router = express.Router();
router.use(requireAuth);

function round2(n) { return Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100; }
function today() { return new Date().toISOString().slice(0, 10); }
const ADMIN = ['Super Admin', 'Company Admin', 'Accountant', 'Branch Manager'];
function requireAdmin(req, res, next) { if (!ADMIN.includes(req.user.role)) return res.status(403).json({ error: 'You do not have rights to manage dunning' }); next(); }

// ---- Procedures (DUN-01) ----
router.get('/procedures', (req, res) => {
  const procs = db.prepare('SELECT * FROM DunningProcedure WHERE CompanyID = ? AND IsActive = 1 ORDER BY ProcedureID').all(req.user.companyId);
  procs.forEach(p => { p.levels = db.prepare('SELECT * FROM DunningLevel WHERE ProcedureID = ? ORDER BY Level').all(p.ProcedureID); });
  res.json(procs);
});
router.post('/procedures', requireAdmin, (req, res) => {
  const { name, minAmount, interestRate, levels } = req.body || {};
  if (!name) return res.status(400).json({ error: 'A name is required' });
  const id = db.transaction(() => {
    const pid = db.prepare('INSERT INTO DunningProcedure (CompanyID, Name, MinAmount, InterestRate) VALUES (?,?,?,?)')
      .run(req.user.companyId, name, Number(minAmount) || 0, Number(interestRate) || 0).lastInsertRowid;
    (Array.isArray(levels) ? levels : []).forEach((l, i) =>
      db.prepare('INSERT INTO DunningLevel (ProcedureID, Level, DaysOverdue, TemplateCode, Auto) VALUES (?,?,?,?,?)')
        .run(pid, l.level || i + 1, Number(l.daysOverdue) || 0, l.templateCode || `DUNNING_${i + 1}`, l.auto === false ? 0 : 1));
    return pid;
  })();
  logAudit({ companyId: req.user.companyId, userId: req.user.userId, action: 'CREATE_DUNNING_PROCEDURE', entityType: 'DunningProcedure', entityId: id, details: name, ip: req.ip });
  res.status(201).json({ procedureId: id });
});

// DUN-08: block/unblock a customer from dunning.
router.post('/customers/:id/block', requireAdmin, (req, res) => {
  const block = req.body.block !== false;
  db.prepare('UPDATE Customer SET DunningBlock = ?, DunningBlockReason = ? WHERE CustomerID = ? AND CompanyID = ?')
    .run(block ? 1 : 0, block ? (req.body.reason || null) : null, req.params.id, req.user.companyId);
  logAudit({ companyId: req.user.companyId, userId: req.user.userId, action: block ? 'DUNNING_BLOCK' : 'DUNNING_UNBLOCK', entityType: 'Customer', entityId: Number(req.params.id), details: req.body.reason || '', ip: req.ip });
  res.json({ success: true, blocked: block });
});

/** Build the dunning proposal: one row per customer at their highest due level. */
function buildProposal(companyId, branchId) {
  const procedures = {};
  db.prepare('SELECT * FROM DunningProcedure WHERE CompanyID = ? AND IsActive = 1').all(companyId)
    .forEach(p => { procedures[p.ProcedureID] = { ...p, levels: db.prepare('SELECT * FROM DunningLevel WHERE ProcedureID = ? ORDER BY DaysOverdue DESC').all(p.ProcedureID) }; });
  const defaultProc = Object.values(procedures).find(p => p.IsDefault) || Object.values(procedures)[0];

  const customers = db.prepare(`SELECT CustomerID, CustomerName, Email, Mobile, DunningBlock, DunningProcedureID FROM Customer WHERE CompanyID = ?`).all(companyId);
  const proposal = [];
  customers.forEach(c => {
    if (c.DunningBlock) return;
    const docs = openDocuments(companyId, { branchId, partyType: 'Customer', partyId: c.CustomerID }).filter(d => d.Overdue);
    if (!docs.length) return;
    const proc = procedures[c.DunningProcedureID] || defaultProc;
    if (!proc) return;
    const overdue = round2(docs.reduce((s, d) => s + d.OpenAmount, 0));
    if (overdue < (proc.MinAmount || 0)) return;
    const maxDays = Math.max(...docs.map(d => d.OverdueDays || 0));
    const level = (proc.levels.find(l => maxDays >= l.DaysOverdue) || proc.levels[proc.levels.length - 1] || { Level: 1, TemplateCode: 'DUNNING_1', Auto: 1 });
    proposal.push({
      customerId: c.CustomerID, customerName: c.CustomerName, email: c.Email, mobile: c.Mobile,
      procedureId: proc.ProcedureID, level: level.Level, templateCode: level.TemplateCode, auto: !!level.Auto,
      overdueAmount: overdue, oldestDays: maxDays,
      documents: docs.map(d => ({ docNo: d.DocNo, docDate: d.DocDate, dueDate: d.DueDate, overdueDays: d.OverdueDays, openAmount: d.OpenAmount }))
    });
  });
  return proposal.sort((a, b) => b.overdueAmount - a.overdueAmount);
}

// DUN-04: preview the run (a proposal) before sending anything.
router.get('/run/preview', requireAdmin, (req, res) => {
  const branchId = resolveBranchScope(req);
  const proposal = buildProposal(req.user.companyId, branchId);
  res.json({ asOn: today(), count: proposal.length, totalOverdue: round2(proposal.reduce((s, p) => s + p.overdueAmount, 0)), proposal });
});

// DUN-05/06: send one notice per customer in the proposal; record history.
router.post('/run', requireAdmin, async (req, res) => {
  const branchId = req.user.branchId || (req.body.branchId ? Number(req.body.branchId) : null);
  const channel = ['Email', 'SMS', 'WhatsApp'].includes(req.body.channel) ? req.body.channel : 'Email';
  const onlyCustomerId = req.body.customerId ? Number(req.body.customerId) : null;
  // When autoOnly is true, levels marked "reviewed" (Auto=0) are listed but not sent.
  const autoOnly = req.body.autoOnly === true;
  let proposal = buildProposal(req.user.companyId, branchId);
  if (onlyCustomerId) proposal = proposal.filter(p => p.customerId === onlyCustomerId);
  const company = db.prepare('SELECT CompanyName FROM Company WHERE CompanyID = ?').get(req.user.companyId) || {};
  const results = [];
  for (const p of proposal) {
    if (autoOnly && !p.auto) { results.push({ customerId: p.customerId, skipped: 'needs review (manual level)' }); continue; }
    const to = channel === 'Email' ? p.email : p.mobile;
    const r = await messaging.sendTemplate({
      companyId: req.user.companyId, code: p.templateCode, channel, to,
      vars: { name: p.customerName, company: company.CompanyName || 'us', amount: p.overdueAmount, invoices: p.documents.map(d => d.docNo).join(', ') },
      refType: 'Dunning', refId: p.customerId
    }).catch(e => ({ status: 'Failed', detail: e.message }));
    db.prepare(`INSERT INTO DunningHistory (CompanyID, BranchID, CustomerID, Level, Channel, OverdueAmount, RunDate, DocsJson, MessageStatus, CreatedBy)
                VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(req.user.companyId, branchId, p.customerId, p.level, channel, p.overdueAmount, today(), JSON.stringify(p.documents), r.status, req.user.userId);
    results.push({ customerId: p.customerId, customerName: p.customerName, level: p.level, overdueAmount: p.overdueAmount, deliveryStatus: r.status });
  }
  logAudit({ companyId: req.user.companyId, branchId, userId: req.user.userId, action: 'DUNNING_RUN', details: `${results.length} notices (${channel})`, ip: req.ip });
  res.json({ sent: results.filter(r => r.deliveryStatus === 'Sent').length, total: results.length, channel, results });
});

// DUN-12: dunning history for a customer (and company-wide).
router.get('/history', (req, res) => {
  const cid = req.query.customerId ? Number(req.query.customerId) : null;
  const rows = cid
    ? db.prepare('SELECT * FROM DunningHistory WHERE CompanyID = ? AND CustomerID = ? ORDER BY HistoryID DESC LIMIT 200').all(req.user.companyId, cid)
    : db.prepare('SELECT h.*, c.CustomerName FROM DunningHistory h JOIN Customer c ON c.CustomerID = h.CustomerID WHERE h.CompanyID = ? ORDER BY h.HistoryID DESC LIMIT 200').all(req.user.companyId);
  res.json(rows);
});

// DUN-13: a small collections dashboard.
router.get('/collections', requireAdmin, (req, res) => {
  const branchId = resolveBranchScope(req);
  const proposal = buildProposal(req.user.companyId, branchId);
  const byLevel = {};
  proposal.forEach(p => { byLevel[p.level] = round2((byLevel[p.level] || 0) + p.overdueAmount); });
  res.json({
    totalOverdue: round2(proposal.reduce((s, p) => s + p.overdueAmount, 0)),
    customersOverdue: proposal.length,
    byLevel: Object.entries(byLevel).map(([level, amount]) => ({ level: Number(level), amount })),
    worst: proposal.slice(0, 10).map(p => ({ customerName: p.customerName, overdueAmount: p.overdueAmount, oldestDays: p.oldestDays, level: p.level }))
  });
});

module.exports = router;
