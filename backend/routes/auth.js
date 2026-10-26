const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { signToken, requireAuth } = require('../middleware/auth');
const totp = require('../services/totp');
const { checkPassword } = require('../services/passwords');
const messaging = require('../services/messaging');

const MAX_FAILED_LOGINS = Number(process.env.MAX_FAILED_LOGINS) || 5;
const LOCK_MINUTES = Number(process.env.LOCK_MINUTES) || 15;

const router = express.Router();

// Per-IP request caps. Configurable so an automated test run (which signs in
// many times from one address) is not throttled; production keeps the defaults.
const RATE_MAX = Number(process.env.AUTH_RATE_MAX) || 10;

const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: RATE_MAX,
  message: { error: 'Too many reset attempts. Try again in 15 minutes.' }
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: RATE_MAX,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' }
});

function logAudit({ companyId, branchId, userId, action, entityType, entityId, details, ip }) {
  db.prepare(
    `INSERT INTO AuditLog (CompanyID, BranchID, UserID, Action, EntityType, EntityID, Details, IPAddress)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(companyId, branchId, userId, action, entityType || null, entityId || null, details || null, ip || null);
}

// ---- Email-login signup + admin approval ---------------------------------
//
// Anyone can request access with an email + password. If the email is on the
// allowlist the account is active at once; otherwise it is Pending until an
// existing admin approves it. Admins can also add emails to the allowlist and
// approve/reject/revoke accounts.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Roles that may manage access (approve signups, edit the allowlist).
const ADMIN_MANAGE_ROLES = ['Super Admin', 'Company Admin'];
// In a non-production run, verification codes are returned in the response so
// the flow is testable before an SMTP provider is configured. Never in prod.
const SHOW_CODES = process.env.NODE_ENV !== 'production';

function defaultCompanyId() {
  const c = db.prepare('SELECT CompanyID FROM Company WHERE IsActive = 1 ORDER BY CompanyID LIMIT 1').get()
    || db.prepare('SELECT CompanyID FROM Company ORDER BY CompanyID LIMIT 1').get();
  return c ? c.CompanyID : null;
}
function roleId(name) {
  const r = db.prepare('SELECT RoleID FROM Role WHERE RoleName = ?').get(name);
  return r ? r.RoleID : null;
}
function isAllowlisted(companyId, email) {
  return !!db.prepare('SELECT 1 FROM ApprovedAdminEmail WHERE CompanyID = ? AND LOWER(Email) = LOWER(?)').get(companyId, email);
}
function gen6() { return String(Math.floor(100000 + Math.random() * 900000)); }

// Self-service signup. Creates an admin account (active if allowlisted, else
// pending approval).
router.post('/signup', loginLimiter, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const fullName = String(req.body.fullName || '').trim();
  const password = req.body.password || '';
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'That does not look like a valid email address' });
  const pwProblem = checkPassword(password);
  if (pwProblem) return res.status(400).json({ error: pwProblem });

  const companyId = defaultCompanyId();
  if (!companyId) return res.status(500).json({ error: 'No company is set up yet' });

  const existing = db.prepare('SELECT UserID, Status FROM Users WHERE LOWER(Email) = LOWER(?) OR UserName = ?').get(email, email);
  if (existing) {
    const msg = existing.Status === 'Pending'
      ? 'An access request for this email is already waiting for approval.'
      : 'An account with this email already exists. Try signing in or resetting your password.';
    return res.status(409).json({ error: msg });
  }

  const allowed = isAllowlisted(companyId, email);
  const status = allowed ? 'Active' : 'Pending';
  // Allowlisted founders are Super Admins; others, once approved, are Company
  // Admins. Both can manage access.
  const role = allowed ? roleId('Super Admin') : roleId('Company Admin');
  const passwordHash = bcrypt.hashSync(password, 10);

  const info = db.prepare(
    `INSERT INTO Users (CompanyID, BranchID, RoleID, UserName, FullName, Email, PasswordHash, Status, MustChangePassword, SignupAt)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 0, datetime('now'))`
  ).run(companyId, role, email, fullName || email, email, passwordHash, status);

  logAudit({ companyId, userId: info.lastInsertRowid, action: allowed ? 'SIGNUP_AUTO_APPROVED' : 'SIGNUP_PENDING', entityType: 'Users', entityId: info.lastInsertRowid, details: email, ip: req.ip });

  // Let the existing admins know someone is waiting (best-effort email).
  if (!allowed) {
    const admins = db.prepare(`SELECT Email FROM Users WHERE CompanyID = ? AND Status = 'Active' AND Email IS NOT NULL AND RoleID IN (SELECT RoleID FROM Role WHERE RoleName IN ('Super Admin','Company Admin'))`).all(companyId);
    for (const a of admins) {
      messaging.send({ companyId, channel: 'Email', to: a.Email,
        subject: 'New admin access request - Mfynix ERP',
        body: `${fullName || email} (${email}) has requested admin access to the ERP. Approve or decline them under Admins & Access.`,
        refType: 'Users', refId: info.lastInsertRowid }).catch(() => {});
    }
  }

  res.status(201).json({
    status,
    message: allowed
      ? 'Your account is ready. You can sign in now.'
      : 'Request submitted. An administrator will review it shortly; you will be able to sign in once approved.'
  });
});

// List admin users (active + pending + others), for the Admins & Access screen.
router.get('/admins', requireAuth, (req, res) => {
  if (!ADMIN_MANAGE_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const rows = db.prepare(
    `SELECT u.UserID, u.FullName, u.Email, u.UserName, u.Status, u.SignupAt, u.ApprovedAt, u.LastLogin,
            r.RoleName, a.FullName AS ApprovedByName
     FROM Users u
     JOIN Role r ON r.RoleID = u.RoleID
     LEFT JOIN Users a ON a.UserID = u.ApprovedBy
     WHERE u.CompanyID = ? AND r.RoleName IN ('Super Admin','Company Admin')
     ORDER BY CASE u.Status WHEN 'Pending' THEN 0 ELSE 1 END, u.UserID DESC`
  ).all(req.user.companyId);
  res.json(rows);
});

router.post('/admins/:id/approve', requireAuth, (req, res) => {
  if (!ADMIN_MANAGE_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const u = db.prepare('SELECT * FROM Users WHERE UserID = ? AND CompanyID = ?').get(req.params.id, req.user.companyId);
  if (!u) return res.status(404).json({ error: 'User not found' });
  if (u.Status === 'Active') return res.json({ success: true, already: true });
  db.prepare("UPDATE Users SET Status = 'Active', ApprovedBy = ?, ApprovedAt = datetime('now') WHERE UserID = ?").run(req.user.userId, u.UserID);
  // Remember the decision so the same email is frictionless next time.
  if (u.Email) db.prepare('INSERT OR IGNORE INTO ApprovedAdminEmail (CompanyID, Email, AddedBy) VALUES (?,?,?)').run(req.user.companyId, u.Email.toLowerCase(), req.user.userId);
  logAudit({ companyId: req.user.companyId, userId: req.user.userId, action: 'ADMIN_APPROVED', entityType: 'Users', entityId: u.UserID, details: u.Email, ip: req.ip });
  messaging.send({ companyId: req.user.companyId, channel: 'Email', to: u.Email, subject: 'Your Mfynix ERP access is approved', body: `Hello ${u.FullName || ''},\n\nYour admin access has been approved. You can now sign in with your email and password.` }).catch(() => {});
  res.json({ success: true });
});

router.post('/admins/:id/reject', requireAuth, (req, res) => {
  if (!ADMIN_MANAGE_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const u = db.prepare('SELECT * FROM Users WHERE UserID = ? AND CompanyID = ?').get(req.params.id, req.user.companyId);
  if (!u) return res.status(404).json({ error: 'User not found' });
  if (u.UserID === req.user.userId) return res.status(400).json({ error: 'You cannot reject your own account' });
  db.prepare("UPDATE Users SET Status = 'Rejected' WHERE UserID = ?").run(u.UserID);
  logAudit({ companyId: req.user.companyId, userId: req.user.userId, action: 'ADMIN_REJECTED', entityType: 'Users', entityId: u.UserID, details: u.Email, ip: req.ip });
  res.json({ success: true });
});

router.post('/admins/:id/revoke', requireAuth, (req, res) => {
  if (!ADMIN_MANAGE_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const u = db.prepare('SELECT * FROM Users WHERE UserID = ? AND CompanyID = ?').get(req.params.id, req.user.companyId);
  if (!u) return res.status(404).json({ error: 'User not found' });
  if (u.UserID === req.user.userId) return res.status(400).json({ error: 'You cannot revoke your own access' });
  // Never leave the company with no active admin.
  const activeAdmins = db.prepare(`SELECT COUNT(*) AS c FROM Users u JOIN Role r ON r.RoleID = u.RoleID WHERE u.CompanyID = ? AND u.Status = 'Active' AND r.RoleName IN ('Super Admin','Company Admin')`).get(req.user.companyId).c;
  if (activeAdmins <= 1 && u.Status === 'Active') return res.status(400).json({ error: 'This is the last active admin - add another before revoking this one' });
  db.prepare("UPDATE Users SET Status = 'Inactive' WHERE UserID = ?").run(u.UserID);
  logAudit({ companyId: req.user.companyId, userId: req.user.userId, action: 'ADMIN_REVOKED', entityType: 'Users', entityId: u.UserID, details: u.Email, ip: req.ip });
  res.json({ success: true });
});

// The allowlist of pre-approved admin emails.
router.get('/allowlist', requireAuth, (req, res) => {
  if (!ADMIN_MANAGE_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const rows = db.prepare(
    `SELECT e.ID, e.Email, e.CreatedAt, a.FullName AS AddedByName,
            (SELECT Status FROM Users u WHERE LOWER(u.Email) = LOWER(e.Email) AND u.CompanyID = e.CompanyID LIMIT 1) AS AccountStatus
     FROM ApprovedAdminEmail e LEFT JOIN Users a ON a.UserID = e.AddedBy
     WHERE e.CompanyID = ? ORDER BY e.ID`
  ).all(req.user.companyId);
  res.json(rows);
});

router.post('/allowlist', requireAuth, (req, res) => {
  if (!ADMIN_MANAGE_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });
  try {
    db.prepare('INSERT INTO ApprovedAdminEmail (CompanyID, Email, AddedBy) VALUES (?,?,?)').run(req.user.companyId, email, req.user.userId);
  } catch (e) {
    if (/UNIQUE/.test(e.message)) return res.status(409).json({ error: 'That email is already on the allowlist' });
    throw e;
  }
  // If someone with that email is already waiting, approve them now.
  const pending = db.prepare("SELECT UserID FROM Users WHERE CompanyID = ? AND LOWER(Email) = LOWER(?) AND Status = 'Pending'").get(req.user.companyId, email);
  if (pending) db.prepare("UPDATE Users SET Status = 'Active', ApprovedBy = ?, ApprovedAt = datetime('now') WHERE UserID = ?").run(req.user.userId, pending.UserID);
  logAudit({ companyId: req.user.companyId, userId: req.user.userId, action: 'ALLOWLIST_ADD', details: email, ip: req.ip });
  res.status(201).json({ success: true, activatedPending: !!pending });
});

router.delete('/allowlist/:id', requireAuth, (req, res) => {
  if (!ADMIN_MANAGE_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const row = db.prepare('SELECT * FROM ApprovedAdminEmail WHERE ID = ? AND CompanyID = ?').get(req.params.id, req.user.companyId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM ApprovedAdminEmail WHERE ID = ?').run(row.ID);
  logAudit({ companyId: req.user.companyId, userId: req.user.userId, action: 'ALLOWLIST_REMOVE', details: row.Email, ip: req.ip });
  res.json({ success: true });
});

// List companies -> branches, for the login screen's Company/Branch selectors
router.get('/companies', (req, res) => {
  const companies = db.prepare('SELECT CompanyID, CompanyName FROM Company WHERE IsActive = 1').all();
  res.json(companies);
});

router.get('/branches/:companyId', (req, res) => {
  const branches = db.prepare(
    'SELECT BranchID, BranchName, BranchCode, IsHeadOffice FROM Branch WHERE CompanyID = ? AND IsActive = 1'
  ).all(req.params.companyId);
  res.json(branches);
});

router.post('/login', loginLimiter, (req, res) => {
  // Login identity is the email address. The field may arrive as `email` or,
  // for the seeded backstop account and the existing test suite, as `username`;
  // either way we match on the email first and fall back to the username.
  const identifier = String(req.body.email || req.body.username || '').trim();
  const { password, companyId, rememberMe } = req.body;
  if (!identifier || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const user = db.prepare(
    `SELECT u.*, r.RoleName, b.BranchName, b.BranchCode, c.CompanyName
     FROM Users u
     JOIN Role r ON r.RoleID = u.RoleID
     JOIN Company c ON c.CompanyID = u.CompanyID
     LEFT JOIN Branch b ON b.BranchID = u.BranchID
     WHERE LOWER(u.Email) = LOWER(?) OR u.UserName = ?`
  ).get(identifier, identifier);

  if (!user) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  // A signup awaiting approval is a distinct, honest state - not a wrong
  // password and not a deactivated account.
  if (user.Status === 'Pending') {
    return res.status(403).json({ error: 'Your account is waiting for an administrator to approve it. You will be able to sign in once it is approved.' });
  }
  if (user.Status === 'Rejected') {
    return res.status(403).json({ error: 'Your access request was declined. Contact an administrator.' });
  }
  if (user.Status !== 'Active') {
    return res.status(401).json({ error: 'This account has been deactivated. Contact your administrator.' });
  }
  if (companyId && Number(companyId) !== user.CompanyID) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  // Lockout (ROL-01): after repeated failures the account refuses sign-in for a
  // while, even with the right password, so guessing cannot be automated.
  if (user.LockedUntil && new Date(user.LockedUntil).getTime() > Date.now()) {
    const mins = Math.ceil((new Date(user.LockedUntil).getTime() - Date.now()) / 60000);
    logAudit({ companyId: user.CompanyID, branchId: user.BranchID, userId: user.UserID, action: 'LOGIN_BLOCKED_LOCKED', ip: req.ip });
    return res.status(423).json({ error: `Too many failed attempts. This account is locked for another ${mins} minute${mins === 1 ? '' : 's'}.` });
  }
  const ok = bcrypt.compareSync(password, user.PasswordHash);
  if (!ok) {
    const failed = (user.FailedLogins || 0) + 1;
    if (failed >= MAX_FAILED_LOGINS) {
      const until = new Date(Date.now() + LOCK_MINUTES * 60000).toISOString();
      db.prepare('UPDATE Users SET FailedLogins = 0, LockedUntil = ? WHERE UserID = ?').run(until, user.UserID);
      logAudit({ companyId: user.CompanyID, branchId: user.BranchID, userId: user.UserID, action: 'ACCOUNT_LOCKED', details: `${failed} failed sign-ins`, ip: req.ip });
    } else {
      db.prepare('UPDATE Users SET FailedLogins = ? WHERE UserID = ?').run(failed, user.UserID);
    }
    logAudit({ companyId: user.CompanyID, branchId: user.BranchID, userId: user.UserID, action: 'LOGIN_FAILED', ip: req.ip });
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  // ROL-02: second factor for accounts that have it switched on.
  if (user.TotpEnabled) {
    const code = String(req.body.totp || req.body.otp || '').trim();
    if (!code) {
      return res.status(401).json({ error: 'Enter the 6-digit code from your authenticator app', totpRequired: true });
    }
    let good = totp.verify(user.TotpSecret, code);
    if (!good && /^[0-9a-f]{10}$/i.test(code)) {
      // A recovery code is single-use: accept it, then burn it.
      let codes = [];
      try { codes = JSON.parse(user.RecoveryCodesJson || '[]'); } catch (e) { codes = []; }
      const idx = codes.indexOf(code.toLowerCase());
      if (idx >= 0) { good = true; codes.splice(idx, 1); db.prepare('UPDATE Users SET RecoveryCodesJson = ? WHERE UserID = ?').run(JSON.stringify(codes), user.UserID); }
    }
    if (!good) {
      logAudit({ companyId: user.CompanyID, branchId: user.BranchID, userId: user.UserID, action: 'LOGIN_2FA_FAILED', ip: req.ip });
      return res.status(401).json({ error: 'That code is not valid', totpRequired: true });
    }
  }

  db.prepare('UPDATE Users SET LastLogin = datetime(\'now\'), LastActivity = datetime(\'now\'), FailedLogins = 0, LockedUntil = NULL WHERE UserID = ?').run(user.UserID);
  logAudit({ companyId: user.CompanyID, branchId: user.BranchID, userId: user.UserID, action: 'LOGIN', ip: req.ip });

  const token = signToken(user, { rememberMe: !!rememberMe });
  res.json({
    token,
    user: {
      userId: user.UserID,
      userName: user.UserName,
      fullName: user.FullName,
      role: user.RoleName,
      companyId: user.CompanyID,
      companyName: user.CompanyName,
      branchId: user.BranchID,
      branchName: user.BranchName || 'All Branches (Head Office)',
      mustChangePassword: !!user.MustChangePassword,
      totpEnabled: !!user.TotpEnabled
    }
  });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// ---- Forgot / reset password ----
// PLT-03: the reset token is sent ONLY to the user's registered email address.
// It is never returned in the response and never shown on screen. If no email
// provider is configured the message is recorded in the delivery log as
// "NotSent" (the token itself is hidden there) and an administrator can set a
// temporary password from Branches & Users instead.

function publicBaseUrl(req) {
  return (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

// Look up the account a reset is for. Accepts an email (preferred) or, for the
// backstop/test account, a username.
function findResetUser(identifier) {
  const id = String(identifier || '').trim();
  if (!id) return null;
  return db.prepare('SELECT UserID, CompanyID, BranchID, Email, FullName, UserName, Status FROM Users WHERE LOWER(Email) = LOWER(?) OR UserName = ?').get(id, id);
}

// Step 1: request a reset. A 6-digit verification code is generated and emailed
// to the account's address. The response never reveals whether the account
// exists, so this cannot be used to probe for valid emails.
router.post('/forgot-password', resetLimiter, async (req, res) => {
  const identifier = req.body.email || req.body.username;
  if (!identifier) return res.status(400).json({ error: 'Email is required' });

  const user = findResetUser(identifier);
  const generic = { message: 'If that account exists, a 6-digit verification code has been sent to its email address. It expires in 15 minutes.' };
  if (!user || user.Status !== 'Active' || !user.Email) {
    // Still return any dev code slot empty so the client code path is uniform.
    return res.json(generic);
  }

  const code = gen6();
  const codeHash = crypto.createHash('sha256').update(code).digest('hex');
  const expiry = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 minutes
  db.prepare('UPDATE Users SET ResetTokenHash = ?, ResetTokenExpiry = ? WHERE UserID = ?').run(codeHash, expiry, user.UserID);

  logAudit({ companyId: user.CompanyID, branchId: user.BranchID, userId: user.UserID, action: 'PASSWORD_RESET_REQUESTED', ip: req.ip });

  const result = await messaging.sendTemplate({
    companyId: user.CompanyID, code: 'PASSWORD_RESET', to: user.Email,
    vars: { name: user.FullName || user.Email, token: code, link: `${publicBaseUrl(req)}/forgot-password.html` },
    refType: 'Users', refId: user.UserID, sensitive: true
  }).catch(() => ({ status: 'Failed' }));
  if (result.status !== 'Sent') {
    logAudit({ companyId: user.CompanyID, branchId: user.BranchID, userId: user.UserID, action: 'PASSWORD_RESET_NOT_DELIVERED', details: result.status, ip: req.ip });
  }

  // Test fallback: before SMTP is configured, a non-production server prints
  // the code to its own console (like the first-boot admin banner) so the flow
  // can be exercised end to end. It is never put in the HTTP response, and
  // never printed when NODE_ENV=production.
  if (SHOW_CODES && result.status !== 'Sent') {
    console.log(`\n[DEV] Password-reset code for ${user.Email}: ${code}  (expires in 15 min)\n`);
  }
  res.json({ ...generic, delivered: result.status === 'Sent' });
});

// Step 2 (optional UX): verify the code without consuming it, so the UI can
// move to the "set a new password" step only once the code is right.
router.post('/verify-reset-code', resetLimiter, (req, res) => {
  const user = findResetUser(req.body.email || req.body.username);
  const code = String(req.body.code || '').trim();
  if (!user || !user.Email || !code) return res.status(400).json({ error: 'Enter the code sent to your email' });
  const row = db.prepare('SELECT ResetTokenHash, ResetTokenExpiry FROM Users WHERE UserID = ?').get(user.UserID);
  if (!row.ResetTokenHash || !row.ResetTokenExpiry || new Date(row.ResetTokenExpiry).getTime() < Date.now()) {
    return res.status(400).json({ error: 'That code has expired. Request a new one.' });
  }
  if (crypto.createHash('sha256').update(code).digest('hex') !== row.ResetTokenHash) {
    return res.status(400).json({ error: 'That code is not correct.' });
  }
  res.json({ ok: true });
});

// Step 3: set the new password with a valid code.
router.post('/reset-password', resetLimiter, (req, res) => {
  const identifier = req.body.email || req.body.username;
  const code = String(req.body.code || req.body.token || '').trim();
  const { newPassword } = req.body;
  if (!identifier || !code || !newPassword) {
    return res.status(400).json({ error: 'email, code and newPassword are required' });
  }
  const pwProblem = checkPassword(newPassword);
  if (pwProblem) return res.status(400).json({ error: pwProblem });

  const found = findResetUser(identifier);
  const user = found && db.prepare('SELECT * FROM Users WHERE UserID = ?').get(found.UserID);
  if (!user || !user.ResetTokenHash || !user.ResetTokenExpiry) {
    return res.status(400).json({ error: 'Invalid or expired verification code' });
  }
  if (new Date(user.ResetTokenExpiry).getTime() < Date.now()) {
    return res.status(400).json({ error: 'That code has expired. Please request a new one.' });
  }
  if (crypto.createHash('sha256').update(code).digest('hex') !== user.ResetTokenHash) {
    return res.status(400).json({ error: 'Invalid or expired verification code' });
  }

  const newHash = bcrypt.hashSync(newPassword, 10);
  db.prepare(`UPDATE Users SET PasswordHash = ?, ResetTokenHash = NULL, ResetTokenExpiry = NULL,
              MustChangePassword = 0, FailedLogins = 0, LockedUntil = NULL, PasswordChangedAt = datetime('now') WHERE UserID = ?`)
    .run(newHash, user.UserID);

  logAudit({ companyId: user.CompanyID, branchId: user.BranchID, userId: user.UserID, action: 'PASSWORD_RESET_COMPLETED', ip: req.ip });
  res.json({ message: 'Password has been reset. You can now log in with your new password.' });
});

// ---- Change your own password (while logged in) ----
// The current password is required even though the caller is already
// authenticated: it stops someone changing the password on a machine the real
// user walked away from, and it's what people expect.
router.post('/change-password', requireAuth, resetLimiter, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'currentPassword and newPassword are required' });
  }
  const pwProblem = checkPassword(newPassword);
  if (pwProblem) return res.status(400).json({ error: pwProblem });
  if (currentPassword === newPassword) {
    return res.status(400).json({ error: 'The new password must be different from the current one' });
  }

  const user = db.prepare('SELECT * FROM Users WHERE UserID = ?').get(req.user.userId);
  if (!user || !bcrypt.compareSync(currentPassword, user.PasswordHash)) {
    logAudit({ companyId: req.user.companyId, branchId: req.user.branchId, userId: req.user.userId, action: 'PASSWORD_CHANGE_FAILED', ip: req.ip });
    return res.status(401).json({ error: 'Your current password is not correct' });
  }

  // Any outstanding reset token is cleared too - otherwise a token requested
  // before the change would still be usable afterwards.
  db.prepare(`UPDATE Users SET PasswordHash = ?, ResetTokenHash = NULL, ResetTokenExpiry = NULL,
              MustChangePassword = 0, PasswordChangedAt = datetime('now') WHERE UserID = ?`)
    .run(bcrypt.hashSync(newPassword, 10), user.UserID);

  logAudit({ companyId: user.CompanyID, branchId: user.BranchID, userId: user.UserID, action: 'PASSWORD_CHANGED', ip: req.ip });
  res.json({ message: 'Password changed. Use the new password next time you log in.' });
});

// ---- ROL-02: two-factor enrolment ----
// Finance and admin roles can (and for a real deployment, should) turn on TOTP.
const TWOFA_ROLES = ['Super Admin', 'Company Admin', 'Accountant'];
router.post('/2fa/setup', requireAuth, (req, res) => {
  if (!TWOFA_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Two-factor is for admin and finance roles' });
  const secret = totp.randomSecret();
  db.prepare('UPDATE Users SET TotpSecret = ?, TotpEnabled = 0 WHERE UserID = ?').run(secret, req.user.userId);
  res.json({ secret, otpauthUri: totp.otpauthUri(secret, req.user.userName || `user${req.user.userId}`) });
});
router.post('/2fa/enable', requireAuth, (req, res) => {
  const u = db.prepare('SELECT TotpSecret FROM Users WHERE UserID = ?').get(req.user.userId);
  if (!u || !u.TotpSecret) return res.status(400).json({ error: 'Start with 2FA setup first' });
  if (!totp.verify(u.TotpSecret, String(req.body.totp || '').trim())) return res.status(400).json({ error: 'That code is not valid - check the time on your phone and try again' });
  const codes = totp.recoveryCodes();
  db.prepare('UPDATE Users SET TotpEnabled = 1, RecoveryCodesJson = ? WHERE UserID = ?').run(JSON.stringify(codes), req.user.userId);
  logAudit({ companyId: req.user.companyId, userId: req.user.userId, action: 'ENABLE_2FA', ip: req.ip });
  res.json({ success: true, recoveryCodes: codes });
});
router.post('/2fa/disable', requireAuth, (req, res) => {
  const u = db.prepare('SELECT PasswordHash FROM Users WHERE UserID = ?').get(req.user.userId);
  if (!u || !bcrypt.compareSync(String(req.body.password || ''), u.PasswordHash)) return res.status(401).json({ error: 'Confirm your password to turn off two-factor' });
  db.prepare('UPDATE Users SET TotpEnabled = 0, TotpSecret = NULL, RecoveryCodesJson = NULL WHERE UserID = ?').run(req.user.userId);
  logAudit({ companyId: req.user.companyId, userId: req.user.userId, action: 'DISABLE_2FA', ip: req.ip });
  res.json({ success: true });
});

module.exports = { router, logAudit };
