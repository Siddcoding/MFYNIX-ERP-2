/**
 * E-way bill API (EWB-01/02): check whether an invoice needs an e-way bill,
 * generate one (number + validity), view it and cancel it.
 */
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { logAudit } = require('./auth');
const einvoice = require('../services/einvoice');
const { loadSalesDoc, log } = require('./einvoice');

const router = express.Router();
router.use(requireAuth);

const ROLES = ['Super Admin', 'Company Admin', 'Accountant', 'Branch Manager', 'Store Manager'];
function requireRole(req, res, next) {
  if (!ROLES.includes(req.user.role)) return res.status(403).json({ error: 'You do not have rights to generate e-way bills' });
  next();
}

// GET /ewaybill/sales/:id/required - EWB-02 eligibility flag.
router.get('/sales/:id/required', (req, res) => {
  const doc = loadSalesDoc(req.user.companyId, req.params.id);
  if (!doc) return res.status(404).json({ error: 'Invoice not found' });
  res.json(einvoice.ewayRequired(doc));
});

// GET /ewaybill/sales/:id - current e-way-bill status.
router.get('/sales/:id', (req, res) => {
  const doc = loadSalesDoc(req.user.companyId, req.params.id);
  if (!doc) return res.status(404).json({ error: 'Invoice not found' });
  const h = doc.header;
  res.json({
    invoiceId: h.InvoiceID, invoiceNo: h.InvoiceNo,
    status: h.EWayBillStatus || 'Not generated',
    ewbNo: h.EWayBillNo || null, ewbDate: h.EWayBillDate || null, validUpto: h.EWayBillValidUpto || null,
    distance: h.Distance || null, vehicleNo: h.VehicleNo || null, mode: h.EInvoiceMode || null,
    ...einvoice.ewayRequired(doc)
  });
});

// POST /ewaybill/sales/:id/generate  { distance, vehicleNo, transMode, transporterName }
router.post('/sales/:id/generate', requireRole, (req, res) => {
  const doc = loadSalesDoc(req.user.companyId, req.params.id);
  if (!doc) return res.status(404).json({ error: 'Invoice not found' });
  const h = doc.header;
  if (h.Status === 'Cancelled') return res.status(400).json({ error: 'This invoice is cancelled' });
  if (h.Status === 'Draft') return res.status(400).json({ error: 'Post the invoice before generating its e-way bill' });
  if (h.EWayBillStatus === 'Generated' && h.EWayBillNo) return res.status(409).json({ error: 'This invoice already has an e-way bill', ewbNo: h.EWayBillNo });
  try {
    const r = einvoice.generateEWayBill({ ...doc, transport: req.body || {} });
    db.prepare(`UPDATE SalesHeader SET EWayBillNo = ?, EWayBillDate = ?, EWayBillValidUpto = ?, EWayBillStatus = 'Generated', Distance = ?, VehicleNo = ?, TransportMode = ? WHERE InvoiceID = ?`)
      .run(r.ewbNo, r.ewbDate, r.validUpto, r.distance, (req.body && req.body.vehicleNo) || null, (req.body && req.body.transMode) || null, h.InvoiceID);
    log(req, h, 'EWayBill', 'Generate', 'Success', r.ewbNo, r.mode, r.payload, null);
    logAudit({ companyId: req.user.companyId, branchId: h.BranchID, userId: req.user.userId, action: 'GENERATE_EWAYBILL', entityType: 'SalesHeader', entityId: h.InvoiceID, details: `${h.InvoiceNo} EWB ${r.ewbNo} (${r.mode})`, ip: req.ip });
    res.status(201).json({ invoiceNo: h.InvoiceNo, ewbNo: r.ewbNo, ewbDate: r.ewbDate, validUpto: r.validUpto, distance: r.distance, mode: r.mode, payload: r.payload });
  } catch (e) {
    log(req, h, 'EWayBill', 'Generate', 'Failed', null, null, null, e.message);
    res.status(400).json({ error: e.message });
  }
});

// POST /ewaybill/sales/:id/cancel  { reason }
router.post('/sales/:id/cancel', requireRole, (req, res) => {
  const doc = loadSalesDoc(req.user.companyId, req.params.id);
  if (!doc) return res.status(404).json({ error: 'Invoice not found' });
  const h = doc.header;
  if (h.EWayBillStatus !== 'Generated') return res.status(400).json({ error: 'There is no active e-way bill to cancel' });
  const reason = String(req.body.reason || '').trim();
  if (reason.length < 3) return res.status(400).json({ error: 'A cancellation reason is required' });
  db.prepare(`UPDATE SalesHeader SET EWayBillStatus = 'Cancelled' WHERE InvoiceID = ?`).run(h.InvoiceID);
  log(req, h, 'EWayBill', 'Cancel', 'Success', h.EWayBillNo, h.EInvoiceMode, null, reason);
  logAudit({ companyId: req.user.companyId, branchId: h.BranchID, userId: req.user.userId, action: 'CANCEL_EWAYBILL', entityType: 'SalesHeader', entityId: h.InvoiceID, details: `${h.InvoiceNo}: ${reason}`, ip: req.ip });
  res.json({ success: true, invoiceNo: h.InvoiceNo });
});

module.exports = router;
