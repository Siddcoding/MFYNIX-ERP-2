/**
 * Outbound messaging: email, SMS and WhatsApp (PLT-08).
 *
 * Email goes out over SMTP (nodemailer). SMS and WhatsApp go through a generic
 * HTTP gateway the company configures (URL, optional auth header, JSON body
 * template) so any provider that accepts an HTTP POST can be used without code
 * changes. Nothing is sent unless a provider is configured and active; the
 * message is still written to MessageLog with Status 'NotSent' and the reason,
 * so a missing provider is visible rather than silent.
 *
 * Every attempt - sent, failed or not sent - is logged (the delivery log).
 */

const db = require('../db');

let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (e) { /* optional at runtime; reported as a send failure */ }

const CHANNELS = ['Email', 'SMS', 'WhatsApp'];

const DEFAULT_TEMPLATES = {
  PASSWORD_RESET: {
    Channel: 'Email', Subject: 'Reset your Mfynix password',
    Body: 'Hello {{name}},\n\nUse this code to reset your Mfynix password: {{token}}\n\nOr open: {{link}}\n\nIt expires in 15 minutes and works once. If you did not ask for this, ignore this message.'
  },
  PORTAL_INVITE: {
    Channel: 'Email', Subject: 'Your {{company}} customer portal access',
    Body: 'Hello {{name}},\n\n{{company}} has given you access to the customer portal. Set your password here: {{link}}\n\nThe link works once and expires in 7 days.'
  },
  DUNNING_1: {
    Channel: 'Email', Subject: 'Payment reminder from {{company}}',
    Body: 'Hello {{name}},\n\nThis is a friendly reminder that {{amount}} is overdue. Invoices: {{invoices}}.\n\nPlease arrange payment at your earliest convenience.'
  },
  DUNNING_2: {
    Channel: 'Email', Subject: 'Second reminder: overdue payment to {{company}}',
    Body: 'Hello {{name}},\n\nWe have not yet received {{amount}}. Invoices: {{invoices}}.\n\nPlease pay within 7 days or contact us.'
  },
  DUNNING_3: {
    Channel: 'Email', Subject: 'Final notice before account hold: {{company}}',
    Body: 'Hello {{name}},\n\nFinal notice: {{amount}} remains unpaid. Invoices: {{invoices}}.\n\nNew orders will be held until this is cleared.'
  },
  APPROVAL_PENDING: {
    Channel: 'Email', Subject: 'Approval needed: {{docType}} {{docNo}}',
    Body: 'Hello {{name}},\n\n{{requester}} has submitted {{docType}} {{docNo}} for {{amount}} and it needs your approval in Mfynix.'
  }
};

function render(text, vars = {}) {
  return String(text || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : ''));
}

function getTemplate(companyId, code, channel = 'Email') {
  const row = db.prepare('SELECT * FROM MessageTemplate WHERE CompanyID = ? AND Code = ? AND Channel = ?').get(companyId, code, channel);
  if (row) return { Subject: row.Subject, Body: row.Body };
  const d = DEFAULT_TEMPLATES[code];
  return d && d.Channel === channel ? { Subject: d.Subject, Body: d.Body } : null;
}

function getProvider(companyId, channel) {
  const row = db.prepare('SELECT * FROM MessageProvider WHERE CompanyID = ? AND Channel = ? AND IsActive = 1').get(companyId, channel);
  if (!row) return null;
  let config = {};
  try { config = JSON.parse(row.ConfigJson || '{}'); } catch (e) { /* treated as unconfigured */ }
  return { ...row, config };
}

function logMessage({ companyId, channel, to, subject, body, templateCode, status, detail, refType, refId, sensitive }) {
  return db.prepare(
    `INSERT INTO MessageLog (CompanyID, Channel, ToAddress, Subject, Body, TemplateCode, Status, Detail, RefType, RefID, Sensitive)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(companyId || null, channel, to || null, subject || null, body || null, templateCode || null,
    status, detail || null, refType || null, refId || null, sensitive ? 1 : 0).lastInsertRowid;
}

async function sendEmail(provider, { to, subject, body }) {
  if (!nodemailer) throw new Error('nodemailer is not installed on the server');
  const c = provider.config;
  if (!c.host || !c.from) throw new Error('Email provider needs a host and a From address');
  const transport = nodemailer.createTransport({
    host: c.host, port: Number(c.port) || 587, secure: !!c.secure,
    auth: c.user ? { user: c.user, pass: c.pass } : undefined
  });
  await transport.sendMail({ from: c.from, to, subject, text: body });
}

async function sendHttp(provider, { to, subject, body }) {
  const c = provider.config;
  if (!c.url) throw new Error('Gateway needs a URL');
  const tpl = c.bodyTemplate || '{"to":"{{to}}","message":"{{message}}"}';
  const esc = (s) => String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  const payload = render(tpl, { to: esc(to), message: esc(body), subject: esc(subject) });
  const headers = { 'Content-Type': 'application/json' };
  if (c.authHeader) headers['Authorization'] = c.authHeader;
  const res = await fetch(c.url, { method: 'POST', headers, body: payload, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Gateway answered ${res.status}`);
}

/**
 * Sends one message and records the outcome. Never throws: callers (password
 * reset, dunning) must not fail because a provider is down. Resolves to
 * { status, messageId }.
 */
async function send({ companyId, channel = 'Email', to, subject, body, templateCode, refType, refId, sensitive = false }) {
  if (!CHANNELS.includes(channel)) throw new Error(`Unknown channel ${channel}`);
  if (!to) {
    const id = logMessage({ companyId, channel, to, subject, body, templateCode, status: 'NotSent', detail: 'No recipient address on record', refType, refId, sensitive });
    return { status: 'NotSent', messageId: id };
  }
  const provider = getProvider(companyId, channel);
  if (!provider) {
    const id = logMessage({ companyId, channel, to, subject, body, templateCode, status: 'NotSent', detail: `No active ${channel} provider configured`, refType, refId, sensitive });
    return { status: 'NotSent', messageId: id };
  }
  try {
    if (channel === 'Email') await sendEmail(provider, { to, subject, body });
    else await sendHttp(provider, { to, subject, body });
    const id = logMessage({ companyId, channel, to, subject, body, templateCode, status: 'Sent', refType, refId, sensitive });
    return { status: 'Sent', messageId: id };
  } catch (e) {
    const id = logMessage({ companyId, channel, to, subject, body, templateCode, status: 'Failed', detail: String(e.message).slice(0, 300), refType, refId, sensitive });
    return { status: 'Failed', messageId: id };
  }
}

/** Renders a template by code and sends it. */
async function sendTemplate({ companyId, code, channel = 'Email', to, vars, refType, refId, sensitive = false }) {
  const t = getTemplate(companyId, code, channel);
  if (!t) throw new Error(`No template ${code} for ${channel}`);
  return send({
    companyId, channel, to, templateCode: code, refType, refId, sensitive,
    subject: render(t.Subject, vars), body: render(t.Body, vars)
  });
}

module.exports = { CHANNELS, DEFAULT_TEMPLATES, render, getTemplate, getProvider, send, sendTemplate, logMessage };
