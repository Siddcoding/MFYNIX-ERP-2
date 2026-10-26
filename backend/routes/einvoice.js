/**
 * E-invoice API (EIN-01): generate an IRN + signed QR for a posted sales
 * invoice, view it, and cancel it (within the 24-hour window the IRP allows).
 */
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { logAudit } = require('./auth');
const einvoice = require('../services/einvoice');

const router = express.Router();
router.use(requireAuth);

const ROLES = ['Super Admin', 'Company Admin', 'Accountant', 'Branch Manager'];
function requireRole(req, res, next) {
  if (!ROLES.includes(req.user.role)) return res.status(403).json({ error: 'You do not have rights to generate e-invoices' });
  next();
}

// Loads everything the generator needs for one sales invoice, scoped to the company.
function loadSalesDoc(companyId, id) {
  const header = db.prepare('SELECT * FROM SalesHeader WHERE InvoiceID = ? AND CompanyID = ?').get(id, companyId);
  if (!header) return null;
  const company = db.prepare('SELECT CompanyName, GSTIN, PAN FROM Company WHERE CompanyID = ?').get(companyId);
  const branch = db.prepare('SELECT BranchName, GSTIN, Address, State FROM Branch WHERE BranchID = ?').get(header.BranchID);
  const buyer = db.prepare('SELECT CustomerName, GSTIN, Address, State, StateCode FROM Customer WHERE CustomerID = ?').get(header.CustomerID);
  const lines = db.prepare('SELECT sd.*, i.ItemName, i.HSN AS ItemHSN, i.Unit AS ItemUnit FROM SalesDetail sd JOIN Item i ON i.ItemID = sd.ItemID WHERE InvoiceID = ?').all(id)
    .map(l => ({ ...l, HSN: l.HSN || l.ItemHSN, Unit: l.Unit || l.ItemUnit }));
  return { header, company, branch, buyer, lines };
}

function log(req, header, kind, action, status, reference, mode, payload, detail) {
  db.prepare(`INSERT INTO ComplianceLog (CompanyID, BranchID, DocType, DocID, Kind, Action, Status, Reference, Mode, PayloadJson, Detail, CreatedBy)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(req.user.companyId, header.BranchID, 'SalesInvoice', header.InvoiceID, kind, action, status, reference || null, mode || null, payload ? JSON.stringify(payload) : null, detail || null, req.user.userId);
}

// GET /einvoice/sales/:id - current e-invoice status for an invoice.
router.get('/sales/:id', (req, res) => {
  const doc = loadSalesDoc(req.user.companyId, req.params.id);
  if (!doc) return res.status(404).json({ error: 'Invoice not found' });
  const h = doc.header;
  res.json({
    invoiceId: h.InvoiceID, invoiceNo: h.InvoiceNo,
    status: h.EInvoiceStatus || 'Not generated',
    irn: h.IRN || null, ackNo: h.AckNo || null, ackDate: h.AckDate || null,
    signedQR: h.SignedQR || null, mode: h.EInvoiceMode || null,
    eligible: !!(doc.buyer && doc.buyer.GSTIN)   // B2B invoices carry an IRN
  });
});

// POST /einvoice/sales/:id/generate
router.post('/sales/:id/generate', requireRole, (req, res) => {
  const doc = loadSalesDoc(req.user.companyId, req.params.id);
  if (!doc) return res.status(404).json({ error: 'Invoice not found' });
  const h = doc.header;
  if (h.Status === 'Cancelled') return res.status(400).json({ error: 'This invoice is cancelled' });
  if (h.Status === 'Draft') return res.status(400).json({ error: 'Post the invoice before generating its e-invoice' });
  if (h.EInvoiceStatus === 'Generated' && h.IRN) return res.status(409).json({ error: 'This invoice already has an IRN', irn: h.IRN });
  try {
    const r = einvoice.generateEInvoice(doc);
    db.prepare(`UPDATE SalesHeader SET IRN = ?, AckNo = ?, AckDate = ?, SignedQR = ?, EInvoiceStatus = 'Generated', EInvoiceMode = ? WHERE InvoiceID = ?`)
      .run(r.irn, r.ackNo, r.ackDate, r.signedQR, r.mode, h.InvoiceID);
    log(req, h, 'EInvoice', 'Generate', 'Success', r.irn, r.mode, r.payload, null);
    logAudit({ companyId: req.user.companyId, branchId: h.BranchID, userId: req.user.userId, action: 'GENERATE_EINVOICE', entityType: 'SalesHeader', entityId: h.InvoiceID, details: `${h.InvoiceNo} IRN ${r.irn.slice(0, 12)}… (${r.mode})`, ip: req.ip });
    res.status(201).json({ invoiceNo: h.InvoiceNo, irn: r.irn, ackNo: r.ackNo, ackDate: r.ackDate, signedQR: r.signedQR, mode: r.mode, payload: r.payload });
  } catch (e) {
    log(req, h, 'EInvoice', 'Generate', 'Failed', null, null, null, e.message);
    res.status(400).json({ error: e.message });
  }
});

// POST /einvoice/sales/:id/cancel  { reason }
router.post('/sales/:id/cancel', requireRole, (req, res) => {
  const doc = loadSalesDoc(req.user.companyId, req.params.id);
  if (!doc) return res.status(404).json({ error: 'Invoice not found' });
  const h = doc.header;
  if (h.EInvoiceStatus !== 'Generated') return res.status(400).json({ error: 'There is no active e-invoice to cancel' });
  const reason = String(req.body.reason || '').trim();
  if (reason.length < 3) return res.status(400).json({ error: 'A cancellation reason is required' });
  // The IRP allows cancellation only within 24 hours of generation.
  if (h.AckDate && (Date.now() - new Date(h.AckDate.replace(' ', 'T') + 'Z').getTime()) > 24 * 3600 * 1000) {
    return res.status(400).json({ error: 'An e-invoice can only be cancelled within 24 hours of generation - raise a credit note instead' });
  }
  db.prepare(`UPDATE SalesHeader SET EInvoiceStatus = 'Cancelled', EInvoiceCancelledAt = datetime('now') WHERE InvoiceID = ?`).run(h.InvoiceID);
  log(req, h, 'EInvoice', 'Cancel', 'Success', h.IRN, h.EInvoiceMode, null, reason);
  logAudit({ companyId: req.user.companyId, branchId: h.BranchID, userId: req.user.userId, action: 'CANCEL_EINVOICE', entityType: 'SalesHeader', entityId: h.InvoiceID, details: `${h.InvoiceNo}: ${reason}`, ip: req.ip });
  res.json({ success: true, invoiceNo: h.InvoiceNo });
});

module.exports = router;
module.exports.loadSalesDoc = loadSalesDoc;
module.exports.log = log;
