/**
 * Approval workflow (ROL-04/05/06).
 *
 * A rule says "documents of this type over this amount need an approver of this
 * role". When a document crosses the line it raises an ApprovalRequest; the
 * person who created it may never approve it (ROL-05). Approvers see a pending
 * inbox (ROL-06) and approve or reject with a comment.
 */
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { logAudit } = require('./auth');

const router = express.Router();

/**
 * Raise an approval request when a rule applies (or when `force` is set, e.g. a
 * credit-limit breach). Returns the request row, or null if none was needed.
 * Safe to call inside a transaction.
 */
function createApprovalIfNeeded(db, { companyId, branchId, docType, docId, amount, reason, userId, force = false }) {
  let rule = null;
  if (!force) {
    rule = db.prepare(
      `SELECT * FROM ApprovalRule WHERE CompanyID = ? AND DocType = ? AND IsActive = 1 AND ? >= Threshold ORDER BY Threshold DESC LIMIT 1`
    ).get(companyId, docType, amount || 0);
    if (!rule) return null;
  }
  const id = db.prepare(
    `INSERT INTO ApprovalRequest (CompanyID, BranchID, DocType, DocID, Amount, Reason, Status, RequestedBy)
     VALUES (?,?,?,?,?,?,'Pending',?)`
  ).run(companyId, branchId || null, docType, docId || null, amount || 0, reason || null, userId).lastInsertRowid;
  return db.prepare('SELECT * FROM ApprovalRequest WHERE RequestID = ?').get(id);
}

router.use(requireAuth);

// ---- Approval rules (admin) ----
const RULE_ROLES = ['Super Admin', 'Company Admin'];
router.get('/rules', (req, res) => {
  res.json(db.prepare('SELECT * FROM ApprovalRule WHERE CompanyID = ? ORDER BY DocType, Threshold').all(req.user.companyId));
});
router.post('/rules', (req, res) => {
  if (!RULE_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Only an administrator can set approval rules' });
  const { docType, threshold, approverRole } = req.body || {};
  const DOC = ['SalesOrder', 'PurchaseOrder', 'Payment', 'CreditNote', 'Journal', 'MasterChange'];
  if (!DOC.includes(docType)) return res.status(400).json({ error: `docType must be one of ${DOC.join(', ')}` });
  const id = db.prepare('INSERT INTO ApprovalRule (CompanyID, DocType, Threshold, ApproverRole) VALUES (?,?,?,?)')
    .run(req.user.companyId, docType, Number(threshold) || 0, approverRole || 'Company Admin').lastInsertRowid;
  logAudit({ companyId: req.user.companyId, userId: req.user.userId, action: 'CREATE_APPROVAL_RULE', entityType: 'ApprovalRule', entityId: id, details: `${docType} >= ${threshold}`, ip: req.ip });
  res.status(201).json({ id });
});
router.delete('/rules/:id', (req, res) => {
  if (!RULE_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Only an administrator can change approval rules' });
  db.prepare('UPDATE ApprovalRule SET IsActive = 0 WHERE RuleID = ? AND CompanyID = ?').run(req.params.id, req.user.companyId);
  res.json({ success: true });
});

// ---- Approval inbox (ROL-06) ----
router.get('/', (req, res) => {
  const status = req.query.status || 'Pending';
  const rows = db.prepare(
    `SELECT a.*, u.FullName AS RequestedByName FROM ApprovalRequest a LEFT JOIN Users u ON u.UserID = a.RequestedBy
     WHERE a.CompanyID = ? AND a.Status = ? ORDER BY a.RequestID DESC LIMIT 200`
  ).all(req.user.companyId, status);
  res.json(rows);
});
router.get('/pending-count', (req, res) => {
  res.json({ count: db.prepare("SELECT COUNT(*) AS c FROM ApprovalRequest WHERE CompanyID = ? AND Status = 'Pending'").get(req.user.companyId).c });
});

function decide(req, res, decision) {
  const r = db.prepare('SELECT * FROM ApprovalRequest WHERE RequestID = ? AND CompanyID = ?').get(req.params.id, req.user.companyId);
  if (!r) return res.status(404).json({ error: 'Approval request not found' });
  if (r.Status !== 'Pending') return res.status(409).json({ error: 'This request has already been decided' });
  // ROL-05: the requester cannot approve their own document.
  if (r.RequestedBy === req.user.userId) return res.status(403).json({ error: 'You cannot approve a document you raised yourself' });
  db.transaction(() => {
    db.prepare('UPDATE ApprovalRequest SET Status = ?, DecidedBy = ?, DecisionComment = ?, DecidedAt = datetime(\'now\') WHERE RequestID = ?')
      .run(decision, req.user.userId, req.body.comment || null, r.RequestID);
    // On approval of a credit-blocked sales order, release it to Open.
    if (decision === 'Approved' && r.DocType === 'SalesOrder' && r.DocID) {
      db.prepare("UPDATE SalesOrder SET Status = 'Open' WHERE OrderID = ? AND Status = 'Pending approval'").run(r.DocID);
    }
    if (decision === 'Rejected' && r.DocType === 'SalesOrder' && r.DocID) {
      db.prepare("UPDATE SalesOrder SET Status = 'Cancelled' WHERE OrderID = ? AND Status = 'Pending approval'").run(r.DocID);
    }
    logAudit({ companyId: req.user.companyId, branchId: r.BranchID, userId: req.user.userId, action: decision === 'Approved' ? 'APPROVE' : 'REJECT',
      entityType: 'ApprovalRequest', entityId: r.RequestID, details: `${r.DocType} #${r.DocID}${req.body.comment ? ': ' + req.body.comment : ''}`, ip: req.ip });
  })();
  res.json({ success: true, status: decision });
}
router.post('/:id/approve', (req, res) => decide(req, res, 'Approved'));
router.post('/:id/reject', (req, res) => decide(req, res, 'Rejected'));

module.exports = router;
module.exports.createApprovalIfNeeded = createApprovalIfNeeded;
