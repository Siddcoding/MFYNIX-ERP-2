const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logAudit } = require('./auth');
const crypto = require('crypto');
const { parseSheet, pick } = require('../services/importer');

const router = express.Router();
router.use(requireAuth);

// ---- Branches ----

router.get('/', (req, res) => {
  const branches = db.prepare(
    'SELECT * FROM Branch WHERE CompanyID = ? ORDER BY IsHeadOffice DESC, BranchName'
  ).all(req.user.companyId);
  res.json(branches);
});

router.post('/', requireRole('Super Admin', 'Company Admin'), (req, res) => {
  const { branchName, branchCode, gstin, state, address, phone } = req.body;
  if (!branchName || !branchCode) {
    return res.status(400).json({ error: 'branchName and branchCode are required' });
  }
  // EIN-01: the branch code is part of every document number, which GST caps at 16 characters.
  const code = String(branchCode).trim().toUpperCase();
  if (!/^[A-Z0-9]{1,4}$/.test(code)) {
    return res.status(400).json({ error: 'Branch code must be 1 to 4 letters or digits (it is part of every invoice number, which is limited to 16 characters)' });
  }
  const company = db.prepare('SELECT InvoicePrefix FROM Company WHERE CompanyID = ?').get(req.user.companyId);
  const prefixProblem = require('../services/numbering').checkPrefix(`${code}-${(company && company.InvoicePrefix) || 'INV'}`);
  if (prefixProblem) return res.status(400).json({ error: prefixProblem });
  try {
    const result = db.prepare(
      `INSERT INTO Branch (CompanyID, BranchName, BranchCode, GSTIN, State, Address, Phone)
       VALUES (?,?,?,?,?,?,?)`
    ).run(req.user.companyId, branchName, code, gstin, state, address, phone);

    logAudit({
      companyId: req.user.companyId, branchId: req.user.branchId, userId: req.user.userId,
      action: 'CREATE_BRANCH', entityType: 'Branch', entityId: result.lastInsertRowid, ip: req.ip
    });
    res.status(201).json({ branchId: result.lastInsertRowid });
  } catch (e) {
    if (String(e).includes('UNIQUE')) {
      return res.status(409).json({ error: 'A branch with that code already exists for this company' });
    }
    res.status(500).json({ error: 'Failed to create branch' });
  }
});

router.put('/:id', requireRole('Super Admin', 'Company Admin'), (req, res) => {
  const { branchName, gstin, state, address, phone, isActive } = req.body;
  db.prepare(
    `UPDATE Branch SET BranchName = COALESCE(?, BranchName), GSTIN = COALESCE(?, GSTIN),
     State = COALESCE(?, State), Address = COALESCE(?, Address), Phone = COALESCE(?, Phone),
     IsActive = COALESCE(?, IsActive)
     WHERE BranchID = ? AND CompanyID = ?`
  ).run(branchName, gstin, state, address, phone, isActive, req.params.id, req.user.companyId);

  logAudit({
    companyId: req.user.companyId, branchId: req.user.branchId, userId: req.user.userId,
    action: 'UPDATE_BRANCH', entityType: 'Branch', entityId: req.params.id, ip: req.ip
  });
  res.json({ success: true });
});

// ---- Users (branch/company scoped) ----

router.get('/users/list', requireRole('Super Admin', 'Company Admin', 'Branch Manager'), (req, res) => {
  const scoped = req.user.branchId
    ? db.prepare(
        `SELECT u.UserID, u.UserName, u.FullName, u.Email, u.Status, r.RoleName, b.BranchName
         FROM Users u JOIN Role r ON r.RoleID = u.RoleID LEFT JOIN Branch b ON b.BranchID = u.BranchID
         WHERE u.CompanyID = ? AND u.BranchID = ?`
      ).all(req.user.companyId, req.user.branchId)
    : db.prepare(
        `SELECT u.UserID, u.UserName, u.FullName, u.Email, u.Status, r.RoleName, b.BranchName
         FROM Users u JOIN Role r ON r.RoleID = u.RoleID LEFT JOIN Branch b ON b.BranchID = u.BranchID
         WHERE u.CompanyID = ?`
      ).all(req.user.companyId);
  res.json(scoped);
});

// Deactivate ("remove") or reactivate ("add back") a user account. This is a
// soft, reversible toggle - not a permanent delete - so Super Admin / Company
// Admin can suspend someone temporarily and restore them later without
// losing their history (invoices, audit trail, etc. all stay intact).
router.patch('/users/:id/status', requireRole('Super Admin', 'Company Admin'), (req, res) => {
  const { status } = req.body; // 'Active' | 'Inactive'
  if (!['Active', 'Inactive'].includes(status)) {
    return res.status(400).json({ error: "status must be 'Active' or 'Inactive'" });
  }
  const target = db.prepare('SELECT * FROM Users WHERE UserID = ? AND CompanyID = ?').get(req.params.id, req.user.companyId);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.UserID === req.user.userId) {
    return res.status(400).json({ error: 'You cannot deactivate your own account' });
  }

  db.prepare('UPDATE Users SET Status = ? WHERE UserID = ? AND CompanyID = ?')
    .run(status, req.params.id, req.user.companyId);

  logAudit({
    companyId: req.user.companyId, branchId: req.user.branchId, userId: req.user.userId,
    action: status === 'Active' ? 'REACTIVATE_USER' : 'DEACTIVATE_USER',
    entityType: 'Users', entityId: req.params.id, ip: req.ip
  });
  res.json({ success: true, status });
});

router.get('/roles/list', (req, res) => {
  res.json(db.prepare('SELECT * FROM Role').all());
});

const bcrypt = require('bcryptjs');
const { checkPassword } = require('../services/passwords');
router.post('/users', requireRole('Super Admin', 'Company Admin', 'Branch Manager'), (req, res) => {
  const { userName, fullName, email, password, roleId, branchId } = req.body;
  if (!userName || !password || !roleId) {
    return res.status(400).json({ error: 'userName, password and roleId are required' });
  }
  const pwProblem = checkPassword(password);
  if (pwProblem) return res.status(400).json({ error: pwProblem });
  // Branch Manager can only create users inside their own branch
  const effectiveBranchId = req.user.branchId || branchId || null;

  try {
    const hash = bcrypt.hashSync(password, 10);
    const result = db.prepare(
      `INSERT INTO Users (CompanyID, BranchID, RoleID, UserName, FullName, Email, PasswordHash, MustChangePassword)
       VALUES (?,?,?,?,?,?,?,1)`
    ).run(req.user.companyId, effectiveBranchId, roleId, userName, fullName, email, hash);

    logAudit({
      companyId: req.user.companyId, branchId: req.user.branchId, userId: req.user.userId,
      action: 'CREATE_USER', entityType: 'Users', entityId: result.lastInsertRowid, ip: req.ip
    });
    res.status(201).json({ userId: result.lastInsertRowid });
  } catch (e) {
    if (String(e).includes('UNIQUE')) return res.status(409).json({ error: 'Username already exists' });
    res.status(500).json({ error: 'Failed to create user' });
  }
});

/* ---------------- Bulk import users from Excel / CSV ----------------
   Same shape as the master importer, but users need three things a customer
   does not: a role that has to resolve to a real Role row, a branch, and a
   password. A blank password column generates one and returns it in the result
   so the admin can hand it over - shown exactly once, never stored in plain
   text, which is the rule the single-user reset already follows.

   Creating logins in bulk is a bigger deal than creating customers, so this is
   Super Admin and Company Admin only - not Branch Manager, who can still add
   users one at a time inside their own branch.                              */
router.post('/users/import', requireRole('Super Admin', 'Company Admin'), (req, res) => {
  const { filename, dataBase64 } = req.body || {};
  if (!dataBase64) return res.status(400).json({ error: 'No file was received. Pick a .xlsx or .csv file and try again.' });

  let parsed;
  try {
    parsed = parseSheet(Buffer.from(dataBase64, 'base64'), filename || '');
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  if (parsed.rows.length === 0) return res.status(400).json({ error: 'The sheet has headings but no data rows.' });

  const roles = db.prepare('SELECT RoleID, RoleName FROM Role').all();
  const branches = db.prepare('SELECT BranchID, BranchName, BranchCode FROM Branch WHERE CompanyID = ? AND IsActive = 1')
    .all(req.user.companyId);
  const takenNames = new Set(db.prepare('SELECT UserName FROM Users').all().map(u => u.UserName.toLowerCase()));

  const findRole = (text) => roles.find(r => r.RoleName.toLowerCase() === String(text).trim().toLowerCase());
  const findBranch = (text) => {
    const t = String(text).trim().toLowerCase();
    return branches.find(b => (b.BranchCode || '').toLowerCase() === t)
        || branches.find(b => (b.BranchName || '').toLowerCase() === t);
  };

  // Readable rather than clever: no lookalike characters, and long enough to be
  // worth replacing rather than keeping.
  const generatePassword = () => {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    let out = '';
    for (let i = 0; i < 10; i++) out += alphabet[crypto.randomInt(alphabet.length)];
    return out + '@1';
  };

  const results = [];
  const toInsert = [];

  for (const { rowNumber, values } of parsed.rows) {
    const userName = pick(values, ['UserName', 'Username', 'User', 'LoginID', 'Login', 'User Name']);
    const fullName = pick(values, ['FullName', 'Name', 'Full Name', 'EmployeeName', 'Person']);
    const email = pick(values, ['Email', 'EmailAddress', 'Mail', 'E-mail']);
    const roleText = pick(values, ['Role', 'RoleName', 'Designation', 'Role Name']);
    const branchText = pick(values, ['Branch', 'BranchName', 'BranchCode', 'Location', 'Branch Name']);
    const password = pick(values, ['Password', 'InitialPassword', 'Temp Password']);

    const label = fullName || userName || `Row ${rowNumber}`;
    const fail = (reason) => results.push({ row: rowNumber, name: label, status: 'error', reason });

    if (!userName) { fail('UserName is blank'); continue; }
    if (!/^[A-Za-z0-9._-]{3,}$/.test(userName)) {
      fail(`"${userName}" is not a usable username - letters, digits, dot, dash and underscore only, at least 3 characters`);
      continue;
    }
    if (!roleText) { fail('Role is blank'); continue; }

    const role = findRole(roleText);
    if (!role) {
      fail(`Role "${roleText}" does not exist. Valid roles: ${roles.map(r => r.RoleName).join(', ')}`);
      continue;
    }
    if (password && password.length < 8) {
      fail('Password must be at least 8 characters (or leave it blank and one will be generated)');
      continue;
    }

    // A branch user importing can only create users in their own branch,
    // whatever the sheet says - the rule the single-user route already applies.
    let branchId = req.user.branchId || null;
    if (!req.user.branchId && branchText) {
      const branch = findBranch(branchText);
      if (!branch) {
        fail(`Branch "${branchText}" does not exist. Use the branch name or its code.`);
        continue;
      }
      branchId = branch.BranchID;
    }

    if (takenNames.has(userName.toLowerCase())) {
      results.push({ row: rowNumber, name: label, status: 'skipped', reason: `the username "${userName}" is already taken` });
      continue;
    }
    takenNames.add(userName.toLowerCase());

    const generated = password ? null : generatePassword();
    toInsert.push({
      userName, fullName: fullName || userName, email: email || null,
      roleId: role.RoleID, branchId, plain: password || generated
    });
    results.push({
      row: rowNumber, name: label, status: 'imported',
      reason: `${role.RoleName}${branchId ? '' : ' · head office'}`,
      userName,
      // Only a password this import invented is echoed back; one the admin
      // typed into the sheet is already in their hands.
      generatedPassword: generated
    });
  }

  try {
    db.transaction(() => {
      for (const u of toInsert) {
        db.prepare(
          `INSERT INTO Users (CompanyID, BranchID, RoleID, UserName, FullName, Email, PasswordHash, MustChangePassword)
           VALUES (?,?,?,?,?,?,?,1)`
        ).run(req.user.companyId, u.branchId, u.roleId, u.userName, u.fullName, u.email, bcrypt.hashSync(u.plain, 10));
      }
    })();
  } catch (e) {
    return res.status(400).json({ error: 'Nothing was imported: ' + String(e.message || e) });
  }

  if (toInsert.length > 0) {
    logAudit({
      companyId: req.user.companyId, branchId: req.user.branchId, userId: req.user.userId,
      action: 'IMPORT_USERS', entityType: 'Users',
      details: `${toInsert.length} created from ${filename || 'upload'}`, ip: req.ip
    });
  }

  res.json({
    entity: 'users',
    label: 'User',
    headersFound: parsed.rawHeaders.filter(Boolean),
    total: parsed.rows.length,
    inserted: toInsert.length,
    skipped: results.filter(r => r.status === 'skipped').length,
    failed: results.filter(r => r.status === 'error').length,
    results
  });
});

router.get('/users/import/template.csv', requireRole('Super Admin', 'Company Admin'), (req, res) => {
  const roleNames = db.prepare('SELECT RoleName FROM Role').all().map(r => r.RoleName);
  const branch = db.prepare('SELECT BranchCode FROM Branch WHERE CompanyID = ? AND IsActive = 1 LIMIT 1')
    .get(req.user.companyId);
  const csv =
    'UserName,FullName,Email,Role,Branch,Password\n' +
    `jdoe,Jane Doe,jane@example.com,${roleNames[0] || 'Accountant'},${branch ? branch.BranchCode : ''},\n`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="users-template.csv"');
  res.send(csv);
});

// ---- Admin: reset a user's password ----
// Used when someone is locked out and can't do the self-service flow. The new
// password is shown once to the admin to hand over; it is never stored in
// plain text and never logged.
router.post('/users/:id/reset-password', requireRole('Super Admin', 'Company Admin'), (req, res) => {
  const { newPassword } = req.body;
  const pwProblem = checkPassword(newPassword);
  if (!newPassword || pwProblem) {
    return res.status(400).json({ error: pwProblem || 'newPassword is required' });
  }
  const target = db.prepare('SELECT * FROM Users WHERE UserID = ? AND CompanyID = ?').get(req.params.id, req.user.companyId);
  if (!target) return res.status(404).json({ error: 'User not found' });

  // A password an administrator chose is known to the administrator, so the
  // user must replace it at their next sign-in; any lockout is cleared too.
  db.prepare(`UPDATE Users SET PasswordHash = ?, ResetTokenHash = NULL, ResetTokenExpiry = NULL,
              MustChangePassword = 1, FailedLogins = 0, LockedUntil = NULL WHERE UserID = ?`)
    .run(bcrypt.hashSync(newPassword, 10), target.UserID);

  logAudit({
    companyId: req.user.companyId, branchId: req.user.branchId, userId: req.user.userId,
    action: 'ADMIN_RESET_USER_PASSWORD', entityType: 'Users', entityId: target.UserID,
    details: `for ${target.UserName}`, ip: req.ip
  });
  res.json({ message: `Password reset for ${target.UserName}.` });
});

// ---- Admin: edit a user's details / role / branch ----
router.put('/users/:id', requireRole('Super Admin', 'Company Admin'), (req, res) => {
  const target = db.prepare('SELECT * FROM Users WHERE UserID = ? AND CompanyID = ?').get(req.params.id, req.user.companyId);
  if (!target) return res.status(404).json({ error: 'User not found' });

  // Don't let an admin lock themselves out of their own account's access level.
  if (target.UserID === req.user.userId && req.body.roleId && Number(req.body.roleId) !== target.RoleID) {
    return res.status(400).json({ error: 'You cannot change your own role - ask another administrator' });
  }

  const allowed = ['FullName', 'Email', 'RoleID', 'BranchID'];
  const map = { fullName: 'FullName', email: 'Email', roleId: 'RoleID', branchId: 'BranchID' };
  const cols = [], vals = [];
  Object.entries(map).forEach(([bodyKey, col]) => {
    if (req.body[bodyKey] !== undefined) { cols.push(col); vals.push(req.body[bodyKey] === '' ? null : req.body[bodyKey]); }
  });
  if (cols.length === 0) return res.status(400).json({ error: 'No fields provided' });

  db.prepare(`UPDATE Users SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE UserID = ?`).run(...vals, target.UserID);
  logAudit({
    companyId: req.user.companyId, branchId: req.user.branchId, userId: req.user.userId,
    action: 'UPDATE_USER', entityType: 'Users', entityId: target.UserID, ip: req.ip
  });
  res.json({ success: true });
});

module.exports = router;
