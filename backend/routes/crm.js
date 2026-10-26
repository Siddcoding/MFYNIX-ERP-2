const express = require('express');
const db = require('../db');
const { requireAuth, resolveBranchScope } = require('../middleware/auth');
const { logAudit } = require('./auth');
const { readPaging, pagedResult } = require('../services/paging');

const router = express.Router();
router.use(requireAuth);

// CRM is the one module a Sales Executive is the primary user of.
const CRM_ROLES = ['Super Admin', 'Company Admin', 'Branch Manager', 'Sales Executive', 'Auditor'];
router.use((req, res, next) => {
  if (!CRM_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'You do not have access to CRM' });
  }
  next();
});
function requireWriteRights(req, res, next) {
  if (req.user.role === 'Auditor') return res.status(403).json({ error: 'Auditor access is read-only' });
  next();
}

// The pipeline, in order. Won/Lost are terminal.
const STAGES = ['New', 'Contacted', 'Qualified', 'Proposal', 'Won', 'Lost'];
const OPEN_STAGES = ['New', 'Contacted', 'Qualified', 'Proposal'];

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

// ---------------- Leads ----------------

router.get('/leads', (req, res) => {
  const branchId = resolveBranchScope(req);
  const { stage, search } = req.query;

  const where = ['l.CompanyID = ?', 'l.IsActive = 1'];
  const args = [req.user.companyId];
  if (branchId) { where.push('l.BranchID = ?'); args.push(branchId); }
  if (stage && STAGES.includes(stage)) { where.push('l.Stage = ?'); args.push(stage); }
  if (search) { where.push('(l.LeadName LIKE ? OR l.ContactPerson LIKE ? OR l.Mobile LIKE ?)'); const q = `%${search}%`; args.push(q, q, q); }

  const whereSql = where.join(' AND ');
  const { page, pageSize, offset } = readPaging(req.query, { defaultPageSize: 50 });

  const total = db.prepare(`SELECT COUNT(*) AS c FROM Lead l WHERE ${whereSql}`).get(...args).c;
  const rows = db.prepare(
    `SELECT l.*, b.BranchName, b.BranchCode, u.FullName AS OwnerName,
            (SELECT COUNT(*) FROM LeadActivity a WHERE a.LeadID = l.LeadID) AS ActivityCount
     FROM Lead l
     JOIN Branch b ON b.BranchID = l.BranchID
     LEFT JOIN Users u ON u.UserID = l.OwnerUserID
     WHERE ${whereSql}
     ORDER BY l.UpdatedAt DESC, l.LeadID DESC LIMIT ? OFFSET ?`
  ).all(...args, pageSize, offset);
  res.json(pagedResult(rows, total, { page, pageSize }));
});

router.get('/leads/:id', (req, res) => {
  const lead = db.prepare(
    `SELECT l.*, b.BranchName, u.FullName AS OwnerName FROM Lead l
     JOIN Branch b ON b.BranchID = l.BranchID
     LEFT JOIN Users u ON u.UserID = l.OwnerUserID
     WHERE l.LeadID = ? AND l.CompanyID = ?`
  ).get(req.params.id, req.user.companyId);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  if (req.user.branchId && lead.BranchID !== req.user.branchId) {
    return res.status(403).json({ error: 'You can only view leads of your own branch' });
  }
  const activities = db.prepare(
    `SELECT a.*, u.FullName AS CreatedByName FROM LeadActivity a
     LEFT JOIN Users u ON u.UserID = a.CreatedBy
     WHERE a.LeadID = ? ORDER BY a.ActivityID DESC`
  ).all(req.params.id);
  res.json({ lead, activities });
});

router.post('/leads', requireWriteRights, (req, res) => {
  const branchId = req.user.branchId || req.body.branchId;
  if (!branchId) return res.status(400).json({ error: 'branchId is required (head-office users must specify one)' });

  const { leadName, contactPerson, mobile, email, source, estimatedValue, nextFollowUp, notes, stage } = req.body;
  if (!leadName) return res.status(400).json({ error: 'leadName is required' });
  if (stage && !STAGES.includes(stage)) return res.status(400).json({ error: `stage must be one of ${STAGES.join('/')}` });

  const result = db.prepare(
    `INSERT INTO Lead (CompanyID, BranchID, LeadName, ContactPerson, Mobile, Email, Source, Stage,
                       EstimatedValue, NextFollowUp, Notes, OwnerUserID)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(req.user.companyId, branchId, leadName, contactPerson || null, mobile || null, email || null,
        source || null, stage || 'New', Number(estimatedValue || 0), nextFollowUp || null, notes || null, req.user.userId);

  db.prepare(`INSERT INTO LeadActivity (LeadID, ActivityType, Notes, CreatedBy) VALUES (?, 'Note', ?, ?)`)
    .run(result.lastInsertRowid, 'Lead created', req.user.userId);

  logAudit({ companyId: req.user.companyId, branchId, userId: req.user.userId,
    action: 'CREATE_LEAD', entityType: 'Lead', entityId: result.lastInsertRowid, details: leadName, ip: req.ip });
  res.status(201).json({ leadId: result.lastInsertRowid });
});

function loadOwnLead(req, res) {
  const lead = db.prepare('SELECT * FROM Lead WHERE LeadID = ? AND CompanyID = ?').get(req.params.id, req.user.companyId);
  if (!lead) { res.status(404).json({ error: 'Lead not found' }); return null; }
  if (req.user.branchId && lead.BranchID !== req.user.branchId) {
    res.status(403).json({ error: 'You can only work on leads of your own branch' });
    return null;
  }
  return lead;
}

router.put('/leads/:id', requireWriteRights, (req, res) => {
  const lead = loadOwnLead(req, res);
  if (!lead) return;
  const allowed = ['LeadName', 'ContactPerson', 'Mobile', 'Email', 'Source', 'EstimatedValue', 'NextFollowUp', 'Notes'];
  const cols = allowed.filter(c => req.body[c] !== undefined);
  if (cols.length === 0) return res.status(400).json({ error: 'No fields provided' });
  db.prepare(`UPDATE Lead SET ${cols.map(c => `${c} = ?`).join(', ')}, UpdatedAt = datetime('now') WHERE LeadID = ?`)
    .run(...cols.map(c => req.body[c]), req.params.id);
  res.json({ success: true });
});

// Stage change is its own endpoint so every move is recorded as an activity -
// that's what makes the funnel/velocity reporting meaningful.
router.post('/leads/:id/stage', requireWriteRights, (req, res) => {
  const lead = loadOwnLead(req, res);
  if (!lead) return;
  const { stage, notes, lostReason } = req.body;
  if (!STAGES.includes(stage)) return res.status(400).json({ error: `stage must be one of ${STAGES.join('/')}` });
  if (stage === 'Lost' && !lostReason) return res.status(400).json({ error: 'A reason is required when marking a lead Lost' });
  if (lead.Stage === stage) return res.status(400).json({ error: `Lead is already at stage ${stage}` });

  const tx = db.transaction(() => {
    db.prepare(`UPDATE Lead SET Stage = ?, LostReason = ?, UpdatedAt = datetime('now') WHERE LeadID = ?`)
      .run(stage, stage === 'Lost' ? lostReason : null, lead.LeadID);
    db.prepare(`INSERT INTO LeadActivity (LeadID, ActivityType, Notes, CreatedBy) VALUES (?, 'Stage Change', ?, ?)`)
      .run(lead.LeadID, `${lead.Stage} -> ${stage}${notes ? ': ' + notes : ''}${lostReason ? ' (' + lostReason + ')' : ''}`, req.user.userId);
  });
  tx();

  logAudit({ companyId: req.user.companyId, branchId: lead.BranchID, userId: req.user.userId,
    action: 'LEAD_STAGE_CHANGE', entityType: 'Lead', entityId: lead.LeadID, details: `${lead.Stage} -> ${stage}`, ip: req.ip });
  res.json({ success: true, stage });
});

router.post('/leads/:id/activities', requireWriteRights, (req, res) => {
  const lead = loadOwnLead(req, res);
  if (!lead) return;
  const { activityType, notes, nextFollowUp } = req.body;
  const types = ['Call', 'Email', 'Meeting', 'Note'];
  if (!types.includes(activityType)) return res.status(400).json({ error: `activityType must be one of ${types.join('/')}` });
  if (!notes) return res.status(400).json({ error: 'notes is required' });

  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO LeadActivity (LeadID, ActivityType, Notes, NextFollowUp, CreatedBy) VALUES (?,?,?,?,?)`)
      .run(lead.LeadID, activityType, notes, nextFollowUp || null, req.user.userId);
    // Logging an activity always refreshes the lead's follow-up date and its
    // UpdatedAt, so "stale leads" reporting reflects real contact, not edits.
    db.prepare(`UPDATE Lead SET NextFollowUp = COALESCE(?, NextFollowUp), UpdatedAt = datetime('now') WHERE LeadID = ?`)
      .run(nextFollowUp || null, lead.LeadID);
  });
  tx();
  res.status(201).json({ success: true });
});

// Convert a won lead into a Customer master record, so the very next invoice
// can be raised against it. Idempotent: converting twice returns the same customer.
router.post('/leads/:id/convert', requireWriteRights, (req, res) => {
  const lead = loadOwnLead(req, res);
  if (!lead) return;
  if (lead.ConvertedCustomerID) {
    return res.status(409).json({ error: 'This lead has already been converted', customerId: lead.ConvertedCustomerID });
  }
  const { gstin, address, state, creditLimit } = req.body;

  const tx = db.transaction(() => {
    const customerId = db.prepare(
      `INSERT INTO Customer (CompanyID, BranchID, CustomerName, GSTIN, Mobile, Email, Address, State, CreditLimit)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(req.user.companyId, lead.BranchID, lead.LeadName, gstin || null, lead.Mobile, lead.Email,
          address || null, state || null, Number(creditLimit || 0)).lastInsertRowid;

    db.prepare(`UPDATE Lead SET Stage = 'Won', ConvertedCustomerID = ?, UpdatedAt = datetime('now') WHERE LeadID = ?`)
      .run(customerId, lead.LeadID);
    db.prepare(`INSERT INTO LeadActivity (LeadID, ActivityType, Notes, CreatedBy) VALUES (?, 'Stage Change', ?, ?)`)
      .run(lead.LeadID, `Converted to customer #${customerId}`, req.user.userId);

    return customerId;
  });

  const customerId = tx();
  logAudit({ companyId: req.user.companyId, branchId: lead.BranchID, userId: req.user.userId,
    action: 'CONVERT_LEAD', entityType: 'Lead', entityId: lead.LeadID, details: `Customer #${customerId}`, ip: req.ip });
  res.status(201).json({ customerId });
});

router.delete('/leads/:id', requireWriteRights, (req, res) => {
  const lead = loadOwnLead(req, res);
  if (!lead) return;
  db.prepare('UPDATE Lead SET IsActive = 0 WHERE LeadID = ?').run(lead.LeadID);
  res.json({ success: true });
});

// ---------------- Pipeline / reporting ----------------

router.get('/pipeline', (req, res) => {
  const branchId = resolveBranchScope(req);
  const args = branchId ? [req.user.companyId, branchId] : [req.user.companyId];
  const rows = db.prepare(
    `SELECT Stage, COUNT(*) AS Count, COALESCE(SUM(EstimatedValue),0) AS Value
     FROM Lead WHERE CompanyID = ? AND IsActive = 1 ${branchId ? 'AND BranchID = ?' : ''}
     GROUP BY Stage`
  ).all(...args);

  const byStage = Object.fromEntries(rows.map(r => [r.Stage, r]));
  const pipeline = STAGES.map(s => ({
    stage: s,
    count: byStage[s] ? byStage[s].Count : 0,
    value: round2(byStage[s] ? byStage[s].Value : 0)
  }));

  const won = pipeline.find(p => p.stage === 'Won').count;
  const lost = pipeline.find(p => p.stage === 'Lost').count;
  const open = pipeline.filter(p => OPEN_STAGES.includes(p.stage)).reduce((s, p) => s + p.count, 0);
  const closed = won + lost;

  res.json({
    pipeline,
    openLeads: open,
    openValue: round2(pipeline.filter(p => OPEN_STAGES.includes(p.stage)).reduce((s, p) => s + p.value, 0)),
    wonValue: round2(pipeline.find(p => p.stage === 'Won').value),
    // Conversion rate is won / closed, not won / total - leads still in the
    // pipeline haven't had their chance yet and would drag the rate down.
    conversionRate: closed > 0 ? round2((won / closed) * 100) : 0,
    closedCount: closed
  });
});

// Follow-ups due today or overdue - the CRM's daily to-do list.
router.get('/followups', (req, res) => {
  const branchId = resolveBranchScope(req);
  const today = new Date().toISOString().slice(0, 10);
  const args = branchId ? [req.user.companyId, today, branchId] : [req.user.companyId, today];
  const rows = db.prepare(
    `SELECT l.LeadID, l.LeadName, l.ContactPerson, l.Mobile, l.Stage, l.NextFollowUp, l.EstimatedValue,
            b.BranchName, u.FullName AS OwnerName
     FROM Lead l JOIN Branch b ON b.BranchID = l.BranchID
     LEFT JOIN Users u ON u.UserID = l.OwnerUserID
     WHERE l.CompanyID = ? AND l.IsActive = 1 AND l.Stage NOT IN ('Won','Lost')
       AND l.NextFollowUp IS NOT NULL AND l.NextFollowUp <= ?
       ${branchId ? 'AND l.BranchID = ?' : ''}
     ORDER BY l.NextFollowUp`
  ).all(...args);
  res.json(rows.map(r => ({ ...r, overdue: r.NextFollowUp < today })));
});

// Branch-wise CRM performance, for the head-office comparison view.
router.get('/branch-performance', (req, res) => {
  const rows = db.prepare(
    `SELECT b.BranchID, b.BranchName, b.BranchCode,
            COUNT(l.LeadID) AS TotalLeads,
            SUM(CASE WHEN l.Stage = 'Won' THEN 1 ELSE 0 END) AS Won,
            SUM(CASE WHEN l.Stage = 'Lost' THEN 1 ELSE 0 END) AS Lost,
            COALESCE(SUM(CASE WHEN l.Stage = 'Won' THEN l.EstimatedValue ELSE 0 END),0) AS WonValue,
            COALESCE(SUM(CASE WHEN l.Stage NOT IN ('Won','Lost') THEN l.EstimatedValue ELSE 0 END),0) AS OpenValue
     FROM Branch b
     LEFT JOIN Lead l ON l.BranchID = b.BranchID AND l.IsActive = 1
     WHERE b.CompanyID = ? AND b.IsActive = 1 ${req.user.branchId ? 'AND b.BranchID = ?' : ''}
     GROUP BY b.BranchID ORDER BY WonValue DESC`
  ).all(...(req.user.branchId ? [req.user.companyId, req.user.branchId] : [req.user.companyId]));

  res.json(rows.map(r => ({
    ...r,
    WonValue: round2(r.WonValue), OpenValue: round2(r.OpenValue),
    ConversionRate: (r.Won + r.Lost) > 0 ? round2((r.Won / (r.Won + r.Lost)) * 100) : 0
  })));
});

module.exports = router;
