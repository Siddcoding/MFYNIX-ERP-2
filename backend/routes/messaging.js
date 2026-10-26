const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logAudit } = require('./auth');
const messaging = require('../services/messaging');

const router = express.Router();
router.use(requireAuth);
router.use(requireRole('Super Admin', 'Company Admin'));

const SECRET_KEYS = ['pass', 'authHeader'];

function maskConfig(cfg) {
  const out = { ...cfg };
  SECRET_KEYS.forEach(k => { if (out[k]) out[k] = '********'; });
  return out;
}

// GET /messaging/providers  (secrets masked)
router.get('/providers', (req, res) => {
  const rows = db.prepare('SELECT * FROM MessageProvider WHERE CompanyID = ?').all(req.user.companyId);
  const byChannel = {};
  rows.forEach(r => {
    let cfg = {};
    try { cfg = JSON.parse(r.ConfigJson); } catch (e) { /* ignore */ }
    byChannel[r.Channel] = { channel: r.Channel, kind: r.Kind, name: r.Name, isActive: !!r.IsActive, config: maskConfig(cfg) };
  });
  res.json(messaging.CHANNELS.map(ch => byChannel[ch] || { channel: ch, kind: ch === 'Email' ? 'smtp' : 'http', name: '', isActive: false, config: {} }));
});

// PUT /messaging/providers/:channel  { kind, name, isActive, config }
router.put('/providers/:channel', (req, res) => {
  const channel = req.params.channel;
  if (!messaging.CHANNELS.includes(channel)) return res.status(400).json({ error: 'Unknown channel' });
  const { name, isActive = true, config = {} } = req.body;
  const kind = channel === 'Email' ? 'smtp' : 'http';

  // A masked secret posted back unchanged means "keep what is stored".
  const existing = db.prepare('SELECT ConfigJson FROM MessageProvider WHERE CompanyID = ? AND Channel = ?').get(req.user.companyId, channel);
  let old = {};
  if (existing) { try { old = JSON.parse(existing.ConfigJson); } catch (e) { /* ignore */ } }
  const merged = { ...config };
  SECRET_KEYS.forEach(k => { if (merged[k] === '********' || merged[k] === undefined) { if (old[k]) merged[k] = old[k]; } });

  if (channel === 'Email' && (!merged.host || !merged.from)) {
    return res.status(400).json({ error: 'Email needs an SMTP host and a From address' });
  }
  if (channel !== 'Email' && (!merged.url || !/^https?:\/\//i.test(merged.url))) {
    return res.status(400).json({ error: 'A gateway URL beginning with http:// or https:// is required' });
  }

  db.prepare(
    `INSERT INTO MessageProvider (CompanyID, Channel, Kind, Name, ConfigJson, IsActive, UpdatedAt)
     VALUES (?,?,?,?,?,?,datetime('now'))
     ON CONFLICT(CompanyID, Channel) DO UPDATE SET Kind = excluded.Kind, Name = excluded.Name,
       ConfigJson = excluded.ConfigJson, IsActive = excluded.IsActive, UpdatedAt = datetime('now')`
  ).run(req.user.companyId, channel, kind, name || null, JSON.stringify(merged), isActive ? 1 : 0);
  logAudit({ companyId: req.user.companyId, branchId: req.user.branchId, userId: req.user.userId, action: 'UPDATE_MESSAGE_PROVIDER', entityType: 'MessageProvider', details: channel, ip: req.ip });
  res.json({ success: true });
});

// POST /messaging/providers/:channel/test  { to }
router.post('/providers/:channel/test', async (req, res) => {
  const channel = req.params.channel;
  if (!messaging.CHANNELS.includes(channel)) return res.status(400).json({ error: 'Unknown channel' });
  if (!req.body.to) return res.status(400).json({ error: 'A test recipient (to) is required' });
  const r = await messaging.send({
    companyId: req.user.companyId, channel, to: req.body.to,
    subject: 'Mfynix test message', body: 'This is a test message from Mfynix. If you can read it, this channel works.',
    templateCode: 'TEST'
  });
  const row = db.prepare('SELECT Status, Detail FROM MessageLog WHERE MessageID = ?').get(r.messageId);
  res.json({ status: row.Status, detail: row.Detail });
});

// Templates --------------------------------------------------------------
router.get('/templates', (req, res) => {
  const saved = db.prepare('SELECT * FROM MessageTemplate WHERE CompanyID = ?').all(req.user.companyId);
  const list = Object.entries(messaging.DEFAULT_TEMPLATES).map(([code, d]) => {
    const s = saved.find(x => x.Code === code && x.Channel === d.Channel);
    return { code, channel: d.Channel, subject: s ? s.Subject : d.Subject, body: s ? s.Body : d.Body, customised: !!s };
  });
  res.json(list);
});

router.put('/templates/:code', (req, res) => {
  const code = req.params.code;
  const def = messaging.DEFAULT_TEMPLATES[code];
  if (!def) return res.status(404).json({ error: 'Unknown template' });
  const { subject, body } = req.body;
  if (!body || String(body).trim().length < 5) return res.status(400).json({ error: 'The template body cannot be empty' });
  db.prepare(
    `INSERT INTO MessageTemplate (CompanyID, Code, Channel, Subject, Body, UpdatedAt) VALUES (?,?,?,?,?,datetime('now'))
     ON CONFLICT(CompanyID, Code, Channel) DO UPDATE SET Subject = excluded.Subject, Body = excluded.Body, UpdatedAt = datetime('now')`
  ).run(req.user.companyId, code, def.Channel, subject || def.Subject, body);
  logAudit({ companyId: req.user.companyId, branchId: req.user.branchId, userId: req.user.userId, action: 'UPDATE_MESSAGE_TEMPLATE', entityType: 'MessageTemplate', details: code, ip: req.ip });
  res.json({ success: true });
});

// Delivery log -----------------------------------------------------------
// Password-reset bodies carry a live secret, so they are never returned.
router.get('/log', (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Number(req.query.pageSize) || 30);
  const where = ['CompanyID = ?']; const args = [req.user.companyId];
  if (req.query.status) { where.push('Status = ?'); args.push(req.query.status); }
  if (req.query.channel) { where.push('Channel = ?'); args.push(req.query.channel); }
  const total = db.prepare(`SELECT COUNT(*) AS c FROM MessageLog WHERE ${where.join(' AND ')}`).get(...args).c;
  const rows = db.prepare(
    `SELECT MessageID, Channel, ToAddress, Subject, CASE WHEN Sensitive = 1 THEN '(hidden - contains a one-time code)' ELSE Body END AS Body,
            TemplateCode, Status, Detail, CreatedAt
     FROM MessageLog WHERE ${where.join(' AND ')} ORDER BY MessageID DESC LIMIT ? OFFSET ?`
  ).all(...args, pageSize, (page - 1) * pageSize);
  res.json({ rows, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
});

module.exports = router;
