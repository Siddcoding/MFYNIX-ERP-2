/* =========================================================================
   CUSTOMER SELF-SERVICE PORTAL
   -------------------------------------------------------------------------
   A customer is not an ERP user. They have no Role, no branch scope, and no
   business seeing anyone else's data - so this router is deliberately its own
   world: its own login, its own middleware (requireCustomer), and every query
   below is hard-filtered by the CustomerID carried in the token. There is no
   parameter anywhere in this file that lets a caller name a different
   customer, which is the property that makes the isolation checkable.

   Everything here is read-only apart from the customer's own password. A
   portal login can never create, edit, cancel, or allocate anything.
   ========================================================================= */
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { signCustomerToken, requireCustomer } = require('../middleware/auth');
const { readPaging, pagedResult } = require('../services/paging');
const { openDocuments } = require('./outstanding');
const { accessStatus, refusalReason } = require('../services/portalAccess');
const crypto = require('crypto');

const router = express.Router();

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const portalLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' }
});

// ---------------- Login ----------------
// Customers sign in with their email address, not a username: it is the one
// identifier they already know, and the ERP already stores it on the master.
router.post('/login', portalLoginLimiter, (req, res) => {
  const { email, password, companyId, rememberMe } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  // Email is matched case-insensitively - people type their own address in
  // whatever case they feel like, and refusing them over that is just rude.
  const rows = db.prepare(
    `SELECT c.*, co.CompanyName
     FROM Customer c
     JOIN Company co ON co.CompanyID = c.CompanyID
     WHERE lower(trim(c.Email)) = lower(trim(?)) AND c.IsActive = 1 AND c.PortalEnabled = 1`
  ).all(email);

  const candidates = companyId ? rows.filter(r => r.CompanyID === Number(companyId)) : rows;

  // Same generic message for "no such account", "wrong password" and "portal
  // not enabled", so this endpoint can't be used to discover who is a customer.
  const reject = () => res.status(401).json({ error: 'Invalid email or password' });
  if (candidates.length === 0) return reject();

  // The same address could in principle exist under two companies. Rather than
  // guessing, ask which one - the login screen already knows how to show it.
  if (candidates.length > 1) {
    return res.status(409).json({
      error: 'This email is registered with more than one company. Pick a company and sign in again.',
      companies: candidates.map(c => ({ companyId: c.CompanyID, companyName: c.CompanyName }))
    });
  }

  const customer = candidates[0];
  if (!customer.PortalPasswordHash || !bcrypt.compareSync(password, customer.PortalPasswordHash)) {
    return reject();
  }

  // The password check comes first deliberately. Telling a stranger "that
  // account's access expired on 3 March" would confirm the address belongs to
  // a real customer; telling the actual account holder is helpful, because
  // otherwise a lapsed term looks like a forgotten password and they waste an
  // afternoon on it.
  const status = accessStatus(customer);
  if (!status.active) {
    return res.status(403).json({ error: refusalReason(status), expired: status.expired, expiresAt: status.expiresAt });
  }

  db.prepare("UPDATE Customer SET PortalLastLogin = datetime('now') WHERE CustomerID = ?").run(customer.CustomerID);

  res.json({
    token: signCustomerToken(customer, { rememberMe: !!rememberMe }),
    customer: {
      kind: 'customer',
      customerId: customer.CustomerID,
      customerName: customer.CustomerName,
      email: customer.Email,
      companyId: customer.CompanyID,
      companyName: customer.CompanyName,
      accessExpiresAt: status.expiresAt,
      accessDaysRemaining: status.daysRemaining
    }
  });
});

// Everything below this line requires a valid customer token.
router.use(requireCustomer);

function me(req) {
  return db.prepare(
    `SELECT c.*, co.CompanyName, co.GSTIN AS CompanyGSTIN, co.Phone AS CompanyPhone, co.Email AS CompanyEmail
     FROM Customer c JOIN Company co ON co.CompanyID = c.CompanyID
     WHERE c.CustomerID = ?`
  ).get(req.customer.customerId);
}

// The customer's own open documents, straight from the same function the ERP's
// outstanding module uses - one definition of "what is still owed", so the
// portal can never quietly disagree with what the accounts team sees.
function myOpenDocs(req) {
  return openDocuments(req.customer.companyId, {
    partyType: 'Customer',
    partyId: req.customer.customerId
  });
}

// ---------------- Profile ----------------
router.get('/me', (req, res) => {
  const c = me(req);
  if (!c) return res.status(404).json({ error: 'Account not found' });
  res.json({
    customerId: c.CustomerID,
    customerName: c.CustomerName,
    email: c.Email,
    mobile: c.Mobile,
    gstin: c.GSTIN,
    address: c.Address,
    state: c.State,
    creditLimit: round2(c.CreditLimit),
    creditDays: c.CreditDays || 0,
    companyName: c.CompanyName,
    companyGSTIN: c.CompanyGSTIN,
    companyPhone: c.CompanyPhone,
    companyEmail: c.CompanyEmail,
    lastLogin: c.PortalLastLogin,
    access: accessStatus(c)
  });
});

// ---------------- Account summary (the portal's landing KPIs) ----------------
router.get('/summary', (req, res) => {
  const cid = req.customer.customerId;
  const companyId = req.customer.companyId;

  const billed = db.prepare(
    `SELECT COALESCE(SUM(NetAmount),0) AS total, COUNT(*) AS cnt
     FROM SalesHeader WHERE CompanyID = ? AND CustomerID = ? AND Status != 'Cancelled'`
  ).get(companyId, cid);

  const paid = db.prepare(
    `SELECT COALESCE(SUM(Amount),0) AS total FROM Allocation
     WHERE CompanyID = ? AND PartyType = 'Customer' AND PartyID = ? AND DocType = 'SalesInvoice'`
  ).get(companyId, cid);

  const credits = db.prepare(
    `SELECT COALESCE(SUM(NetAmount),0) AS total FROM NoteHeader
     WHERE CompanyID = ? AND NoteType = 'Credit' AND PartyType = 'Customer' AND PartyID = ?
       AND Status != 'Cancelled'`
  ).get(companyId, cid);

  const docs = myOpenDocs(req);
  const outstanding = round2(docs.reduce((s, d) => s + d.OpenAmount, 0));
  const overdue = round2(docs.filter(d => d.Overdue).reduce((s, d) => s + d.OpenAmount, 0));

  // Ageing, using the same buckets the ERP's ageing report uses.
  const buckets = {};
  docs.forEach(d => { buckets[d.Bucket] = round2((buckets[d.Bucket] || 0) + d.OpenAmount); });

  const c = me(req);
  const creditLimit = round2(c.CreditLimit);

  res.json({
    invoiceCount: billed.cnt,
    totalBilled: round2(billed.total),
    totalPaid: round2(paid.total),
    creditNotes: round2(credits.total),
    outstanding,
    overdue,
    openDocumentCount: docs.length,
    creditLimit,
    creditAvailable: creditLimit > 0 ? round2(Math.max(0, creditLimit - outstanding)) : null,
    creditUsedPercent: creditLimit > 0 ? Math.min(100, Math.round((outstanding / creditLimit) * 100)) : null,
    ageing: buckets,
    oldestOpenDays: docs.length ? Math.max(...docs.map(d => d.AgeDays)) : 0
  });
});

// ---------------- Invoices ----------------
router.get('/invoices', (req, res) => {
  const { page, pageSize, offset } = readPaging(req.query);
  const cid = req.customer.customerId;
  const companyId = req.customer.companyId;
  const status = req.query.status;   // Open / Paid / Cancelled / undefined = all

  const total = db.prepare(
    'SELECT COUNT(*) AS n FROM SalesHeader WHERE CompanyID = ? AND CustomerID = ?'
  ).get(companyId, cid).n;

  const rows = db.prepare(
    `SELECT s.InvoiceID, s.InvoiceNo, s.InvoiceDate, s.Total, s.GST, s.NetAmount, s.Status,
            b.BranchName
     FROM SalesHeader s JOIN Branch b ON b.BranchID = s.BranchID
     WHERE s.CompanyID = ? AND s.CustomerID = ?
     ORDER BY date(s.InvoiceDate) DESC, s.InvoiceID DESC
     LIMIT ? OFFSET ?`
  ).all(companyId, cid, pageSize, offset);

  // Attach the open amount so the customer sees what is still to pay, not just
  // what was invoiced - the number they actually care about.
  const allocStmt = db.prepare(
    `SELECT COALESCE(SUM(Amount),0) AS a FROM Allocation
     WHERE CompanyID = ? AND DocType = 'SalesInvoice' AND DocID = ?`
  );
  const enriched = rows.map(r => {
    const allocated = r.Status === 'Cancelled' ? 0 : allocStmt.get(companyId, r.InvoiceID).a;
    const open = r.Status === 'Cancelled' ? 0 : round2(r.NetAmount - allocated);
    return {
      ...r,
      Total: round2(r.Total), GST: round2(r.GST), NetAmount: round2(r.NetAmount),
      Paid: round2(allocated),
      OpenAmount: open,
      PaymentStatus: r.Status === 'Cancelled' ? 'Cancelled' : (open <= 0.009 ? 'Paid' : (allocated > 0 ? 'Part paid' : 'Unpaid'))
    };
  });

  const filtered = status ? enriched.filter(r => r.PaymentStatus === status) : enriched;
  res.json(pagedResult(filtered, total, { page, pageSize }));
});

router.get('/invoices/:id', (req, res) => {
  const header = db.prepare(
    `SELECT s.*, b.BranchName, b.BranchCode
     FROM SalesHeader s JOIN Branch b ON b.BranchID = s.BranchID
     WHERE s.InvoiceID = ? AND s.CompanyID = ? AND s.CustomerID = ?`
  ).get(req.params.id, req.customer.companyId, req.customer.customerId);

  // Not 403 - a customer should not be able to tell the difference between
  // "that invoice belongs to someone else" and "no such invoice".
  if (!header) return res.status(404).json({ error: 'Invoice not found' });

  const lines = db.prepare(
    `SELECT d.SalesDetailID, i.ItemName, i.HSN, i.Unit, d.Qty, d.Rate, d.Discount, d.GST, d.Amount
     FROM SalesDetail d JOIN Item i ON i.ItemID = d.ItemID
     WHERE d.InvoiceID = ?`
  ).all(header.InvoiceID);

  const allocations = db.prepare(
    `SELECT a.AllocationID, a.Amount, a.AllocDate, j.Narration
     FROM Allocation a LEFT JOIN JournalEntry j ON j.JournalID = a.JournalID
     WHERE a.CompanyID = ? AND a.DocType = 'SalesInvoice' AND a.DocID = ?
     ORDER BY date(a.AllocDate), a.AllocationID`
  ).all(req.customer.companyId, header.InvoiceID);

  const paid = round2(allocations.reduce((s, a) => s + a.Amount, 0));
  res.json({
    header: { ...header, Total: round2(header.Total), GST: round2(header.GST), NetAmount: round2(header.NetAmount) },
    lines,
    payments: allocations,
    paid,
    openAmount: header.Status === 'Cancelled' ? 0 : round2(header.NetAmount - paid)
  });
});

// ---------------- Outstanding / ageing ----------------
router.get('/outstanding', (req, res) => {
  const docs = myOpenDocs(req);
  res.json({
    asOn: new Date().toISOString().slice(0, 10),
    rows: docs.sort((a, b) => b.AgeDays - a.AgeDays),
    total: round2(docs.reduce((s, d) => s + d.OpenAmount, 0)),
    overdueTotal: round2(docs.filter(d => d.Overdue).reduce((s, d) => s + d.OpenAmount, 0))
  });
});

// ---------------- Statement of account ----------------
// A running-balance ledger: invoices debit the customer, receipts and credit
// notes credit them, opening balance seeds the running total. Same convention
// as the ERP's party ledger so the two documents reconcile line for line.
function buildStatement(req) {
  const cid = req.customer.customerId;
  const companyId = req.customer.companyId;
  const from = req.query.from || '1900-01-01';
  const to = req.query.to || new Date().toISOString().slice(0, 10);

  const invoices = db.prepare(
    `SELECT s.InvoiceDate AS Date, 'Invoice' AS Type, s.InvoiceNo AS Reference,
            s.NetAmount AS Debit, 0 AS Credit, b.BranchName AS Branch
     FROM SalesHeader s JOIN Branch b ON b.BranchID = s.BranchID
     WHERE s.CompanyID = ? AND s.CustomerID = ? AND s.Status != 'Cancelled'
       AND date(s.InvoiceDate) BETWEEN date(?) AND date(?)`
  ).all(companyId, cid, from, to);

  const receipts = db.prepare(
    `SELECT a.AllocDate AS Date, 'Receipt' AS Type,
            COALESCE(j.Narration, 'Payment received') AS Reference,
            0 AS Debit, a.Amount AS Credit, b.BranchName AS Branch
     FROM Allocation a
     JOIN Branch b ON b.BranchID = a.BranchID
     LEFT JOIN JournalEntry j ON j.JournalID = a.JournalID
     WHERE a.CompanyID = ? AND a.PartyType = 'Customer' AND a.PartyID = ?
       AND a.DocType = 'SalesInvoice'
       AND date(a.AllocDate) BETWEEN date(?) AND date(?)`
  ).all(companyId, cid, from, to);

  const notes = db.prepare(
    `SELECT n.NoteDate AS Date, 'Credit Note' AS Type, n.NoteNo AS Reference,
            0 AS Debit, n.NetAmount AS Credit, b.BranchName AS Branch
     FROM NoteHeader n JOIN Branch b ON b.BranchID = n.BranchID
     WHERE n.CompanyID = ? AND n.PartyType = 'Customer' AND n.PartyID = ?
       AND n.NoteType = 'Credit' AND n.Status != 'Cancelled'
       AND date(n.NoteDate) BETWEEN date(?) AND date(?)`
  ).all(companyId, cid, from, to);

  const c = me(req);
  const opening = round2(c.OpeningBalance || 0);

  const entries = [...invoices, ...receipts, ...notes]
    .sort((a, b) => (a.Date < b.Date ? -1 : a.Date > b.Date ? 1 : 0));

  let running = opening;
  const rows = entries.map(e => {
    running = round2(running + (e.Debit || 0) - (e.Credit || 0));
    return { ...e, Debit: round2(e.Debit), Credit: round2(e.Credit), Balance: running };
  });

  return {
    from, to,
    openingBalance: opening,
    rows,
    totals: {
      debit: round2(entries.reduce((s, e) => s + (e.Debit || 0), 0)),
      credit: round2(entries.reduce((s, e) => s + (e.Credit || 0), 0)),
      closingBalance: running
    }
  };
}

router.get('/statement', (req, res) => res.json(buildStatement(req)));

// CSV export of the same statement, so it can go straight into the customer's
// own bookkeeping without anyone retyping it.
router.get('/statement/export.csv', (req, res) => {
  const payload = buildStatement(req);
  const esc = (v) => {
    const s = String(v === null || v === undefined ? '' : v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [
    ['Date', 'Type', 'Reference', 'Branch', 'Debit', 'Credit', 'Balance'].join(','),
    ['', 'Opening balance', '', '', '', '', payload.openingBalance].map(esc).join(','),
    ...payload.rows.map(r => [r.Date, r.Type, r.Reference, r.Branch, r.Debit, r.Credit, r.Balance].map(esc).join(',')),
    ['', 'Closing balance', '', '', payload.totals.debit, payload.totals.credit, payload.totals.closingBalance].map(esc).join(',')
  ];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="statement-${req.customer.customerId}-${payload.to}.csv"`);
  res.send(lines.join('\n'));
});

// ---------------- Change portal password ----------------
router.post('/change-password', (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'currentPassword and newPassword are required' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }
  if (currentPassword === newPassword) {
    return res.status(400).json({ error: 'The new password must be different from the current one' });
  }
  const c = db.prepare('SELECT PortalPasswordHash FROM Customer WHERE CustomerID = ?').get(req.customer.customerId);
  if (!c || !c.PortalPasswordHash || !bcrypt.compareSync(currentPassword, c.PortalPasswordHash)) {
    return res.status(401).json({ error: 'Your current password is not correct' });
  }
  db.prepare('UPDATE Customer SET PortalPasswordHash = ? WHERE CustomerID = ?')
    .run(bcrypt.hashSync(newPassword, 10), req.customer.customerId);
  res.json({ message: 'Password changed. Use the new password next time you sign in.' });
});

// PRT-01: a customer sets their own password from the emailed invite link.
router.post('/accept-invite', (req, res) => {
  const { customerId, token, password } = req.body || {};
  if (!customerId || !token || !password) return res.status(400).json({ error: 'customerId, token and password are required' });
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const c = db.prepare('SELECT * FROM Customer WHERE CustomerID = ?').get(customerId);
  if (!c || !c.PortalInviteHash) return res.status(400).json({ error: 'This invite is not valid' });
  if (c.PortalInviteExpiry && new Date(c.PortalInviteExpiry) < new Date()) return res.status(400).json({ error: 'This invite has expired - ask for a new one' });
  const hash = crypto.createHash('sha256').update(String(token)).digest('hex');
  if (hash !== c.PortalInviteHash) return res.status(400).json({ error: 'This invite link is not valid' });
  db.prepare('UPDATE Customer SET PortalPasswordHash = ?, PortalEnabled = 1, PortalInviteHash = NULL, PortalInviteExpiry = NULL, PortalGrantedAt = ? WHERE CustomerID = ?')
    .run(bcrypt.hashSync(String(password), 10), new Date().toISOString().slice(0, 10), c.CustomerID);
  res.json({ success: true, message: 'Password set. You can now sign in to the portal.' });
});

module.exports = router;
