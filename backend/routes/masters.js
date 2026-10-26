const express = require('express');
const db = require('../db');
const bcrypt = require('bcryptjs');
const { requireAuth, requireRole, resolveBranchScope } = require('../middleware/auth');
const { logAudit } = require('./auth');
const { importMaster, templateCsv } = require('../services/importer');
const { PORTAL_TERMS, VALID_MONTHS, accessStatus, computeExpiry } = require('../services/portalAccess');
const { validateGstin } = require('../services/gstin');
const crypto = require('crypto');
const messaging = require('../services/messaging');
const { STATE_CODES, CODE_TO_STATE, stateNameForCode } = require('../services/tax');

// One place decides whether a GSTIN/State/PAN set is coherent, so customers,
// vendors and the branch screen all reject the same mistakes (MD-02/03).
function normaliseParty(body) {
  const out = {};
  const g = validateGstin(body.GSTIN);
  if (!g.ok) throw new Error(g.error);
  if (!g.empty) {
    out.GSTIN = g.gstin;
    // The state must agree with the GSTIN's own state code, and the PAN is the
    // GSTIN's characters 3-12, so neither can silently disagree with it.
    const nameFromCode = stateNameForCode(g.stateCode);
    if (body.State && (STATE_CODES[String(body.State).trim().toLowerCase()] || '') !== g.stateCode) {
      throw new Error(`The GSTIN is registered in ${nameFromCode} (code ${g.stateCode}) but the state is set to ${body.State}`);
    }
    out.State = body.State || nameFromCode;
    out.StateCode = g.stateCode;
    if (body.PAN && String(body.PAN).trim().toUpperCase() !== g.pan) {
      throw new Error(`The PAN must match the GSTIN - its PAN is ${g.pan}`);
    }
    out.PAN = g.pan;
  } else {
    if (body.State !== undefined) { out.State = body.State; out.StateCode = STATE_CODES[String(body.State || '').trim().toLowerCase()] || null; }
    if (body.PAN !== undefined) {
      const pan = String(body.PAN || '').trim().toUpperCase();
      if (pan && !/^[A-Z]{5}\d{4}[A-Z]$/.test(pan)) throw new Error('That is not a valid PAN (5 letters, 4 digits, 1 letter)');
      out.PAN = pan || null;
    }
  }
  return out;
}

// Whether a master row is referenced by any transaction, so it can be
// deactivated but never deleted once it has history (MD-01).
const USAGE = {
  Customer: [['SalesHeader', 'CustomerID'], ['NoteHeader', 'PartyID']],
  Supplier: [['PurchaseHeader', 'SupplierID'], ['NoteHeader', 'PartyID']],
  Item: [['SalesDetail', 'ItemID'], ['PurchaseDetail', 'ItemID'], ['StockLedger', 'ItemID']]
};
function isInUse(table, idCol, id, companyId) {
  for (const [t, col] of (USAGE[table] || [])) {
    const row = db.prepare(`SELECT 1 FROM ${t} WHERE ${col} = ? LIMIT 1`).get(id);
    if (row) return true;
  }
  return false;
}
function diffFields(before, after, cols) {
  const changes = [];
  cols.forEach(c => {
    const o = before ? before[c] : undefined;
    if (after[c] !== undefined && String(o == null ? '' : o) !== String(after[c] == null ? '' : after[c])) {
      changes.push(`${c}: ${o == null ? '(empty)' : o} -> ${after[c] == null ? '(empty)' : after[c]}`);
    }
  });
  return changes;
}

const router = express.Router();
router.use(requireAuth);

function crudFor(table, idCol, fields, { branchScoped = true, validate = null, autoCode = null } = {}) {
  const r = express.Router();

  r.get('/', (req, res) => {
    const branchId = branchScoped ? resolveBranchScope(req) : null;
    const rows = branchScoped && branchId
      ? db.prepare(`SELECT * FROM ${table} WHERE CompanyID = ? AND (BranchID = ? OR BranchID IS NULL) AND IsActive = 1 ORDER BY ${idCol} DESC`).all(req.user.companyId, branchId)
      : db.prepare(`SELECT * FROM ${table} WHERE CompanyID = ? AND IsActive = 1 ORDER BY ${idCol} DESC`).all(req.user.companyId);
    // SELECT * would otherwise hand every staff user the customers' portal
    // password hashes. Nothing in the UI needs them, so they never leave here.
    rows.forEach(r => { delete r.PortalPasswordHash; });
    res.json(rows);
  });

  r.post('/', (req, res) => {
    const body = { ...req.body };
    try { if (validate) Object.assign(body, validate(body)); } catch (e) { return res.status(400).json({ error: e.message }); }
    const cols = fields.filter(f => body[f] !== undefined);
    if (cols.length === 0) return res.status(400).json({ error: 'No fields provided' });
    const branchId = branchScoped ? (req.user.branchId || body.branchId || null) : undefined;

    const insertCols = branchScoped ? ['CompanyID', 'BranchID', ...cols] : ['CompanyID', ...cols];
    const insertVals = branchScoped ? [req.user.companyId, branchId, ...cols.map(c => body[c])] : [req.user.companyId, ...cols.map(c => body[c])];

    const sql = `INSERT INTO ${table} (${insertCols.join(',')}) VALUES (${insertCols.map(() => '?').join(',')})`;
    let result;
    try { result = db.prepare(sql).run(...insertVals); }
    catch (e) { return res.status(400).json({ error: /UNIQUE/.test(e.message) ? 'A record with these details already exists' : e.message }); }

    // Auto-assign a human-readable code after creation when none was supplied
    // (e.g. CUST-0001, ITEM-0001), unique per record via the new row id.
    let generatedCode;
    if (autoCode) {
      const current = db.prepare(`SELECT ${autoCode.column} AS code FROM ${table} WHERE ${idCol} = ?`).get(result.lastInsertRowid);
      if (!current || !current.code || !String(current.code).trim()) {
        generatedCode = `${autoCode.prefix}-${String(result.lastInsertRowid).padStart(4, '0')}`;
        db.prepare(`UPDATE ${table} SET ${autoCode.column} = ? WHERE ${idCol} = ?`).run(generatedCode, result.lastInsertRowid);
      }
    }

    logAudit({
      companyId: req.user.companyId, branchId: req.user.branchId, userId: req.user.userId,
      action: `CREATE_${table.toUpperCase()}`, entityType: table, entityId: result.lastInsertRowid,
      details: body[fields[0]] || '', ip: req.ip
    });
    res.status(201).json({ id: result.lastInsertRowid, code: generatedCode });
  });

  r.put('/:id', (req, res) => {
    const before = db.prepare(`SELECT * FROM ${table} WHERE ${idCol} = ? AND CompanyID = ?`).get(req.params.id, req.user.companyId);
    if (!before) return res.status(404).json({ error: 'Record not found' });
    const body = { ...req.body };
    try { if (validate) Object.assign(body, validate({ ...before, ...body })); } catch (e) { return res.status(400).json({ error: e.message }); }
    const cols = fields.filter(f => body[f] !== undefined);
    if (cols.length === 0) return res.status(400).json({ error: 'No fields provided' });
    const changes = diffFields(before, body, cols);
    const setClause = cols.map(c => `${c} = ?`).join(', ');
    try {
      db.prepare(`UPDATE ${table} SET ${setClause} WHERE ${idCol} = ? AND CompanyID = ?`)
        .run(...cols.map(c => body[c]), req.params.id, req.user.companyId);
    } catch (e) { return res.status(400).json({ error: /UNIQUE/.test(e.message) ? 'A record with these details already exists' : e.message }); }

    logAudit({
      companyId: req.user.companyId, branchId: req.user.branchId, userId: req.user.userId,
      action: `UPDATE_${table.toUpperCase()}`, entityType: table, entityId: req.params.id,
      details: changes.length ? changes.join('; ') : 'no field changed', ip: req.ip
    });
    res.json({ success: true, changes });
  });

  // Deactivate (never hard-delete once a record has transaction history).
  r.delete('/:id', (req, res) => {
    const row = db.prepare(`SELECT * FROM ${table} WHERE ${idCol} = ? AND CompanyID = ?`).get(req.params.id, req.user.companyId);
    if (!row) return res.status(404).json({ error: 'Record not found' });
    // Reason is optional and only meaningful where the field exists (Customer).
    if (req.body && req.body.reason && fields.includes('Reason')) {
      db.prepare(`UPDATE ${table} SET IsActive = 0, Reason = ? WHERE ${idCol} = ? AND CompanyID = ?`).run(req.body.reason, req.params.id, req.user.companyId);
    } else {
      db.prepare(`UPDATE ${table} SET IsActive = 0 WHERE ${idCol} = ? AND CompanyID = ?`).run(req.params.id, req.user.companyId);
    }
    logAudit({ companyId: req.user.companyId, branchId: req.user.branchId, userId: req.user.userId,
      action: `DEACTIVATE_${table.toUpperCase()}`, entityType: table, entityId: req.params.id,
      details: (row[fields[0]] || '') + (req.body && req.body.reason ? ` - ${req.body.reason}` : ''), ip: req.ip });
    res.json({ success: true, deactivated: true, inUse: isInUse(table, idCol, req.params.id, req.user.companyId) });
  });

  // Reactivate a deactivated record.
  r.post('/:id/reactivate', (req, res) => {
    const row = db.prepare(`SELECT * FROM ${table} WHERE ${idCol} = ? AND CompanyID = ?`).get(req.params.id, req.user.companyId);
    if (!row) return res.status(404).json({ error: 'Record not found' });
    db.prepare(`UPDATE ${table} SET IsActive = 1 WHERE ${idCol} = ? AND CompanyID = ?`).run(req.params.id, req.user.companyId);
    logAudit({ companyId: req.user.companyId, branchId: req.user.branchId, userId: req.user.userId,
      action: `REACTIVATE_${table.toUpperCase()}`, entityType: table, entityId: req.params.id, details: row[fields[0]] || '', ip: req.ip });
    res.json({ success: true, active: true });
  });

  // List including inactive, for the master screen's "show inactive" toggle.
  r.get('/all', (req, res) => {
    const branchId = branchScoped ? resolveBranchScope(req) : null;
    const rows = branchScoped && branchId
      ? db.prepare(`SELECT * FROM ${table} WHERE CompanyID = ? AND (BranchID = ? OR BranchID IS NULL) ORDER BY ${idCol} DESC`).all(req.user.companyId, branchId)
      : db.prepare(`SELECT * FROM ${table} WHERE CompanyID = ? ORDER BY ${idCol} DESC`).all(req.user.companyId);
    rows.forEach(r => { delete r.PortalPasswordHash; });
    res.json(rows);
  });

  return r;
}

/* ---------------- Bulk import from Excel / CSV ----------------
   Declared before the CRUD mounts so /customers/import wins over /customers.
   The file arrives base64-encoded inside the JSON body rather than as a
   multipart upload: it avoids a file-upload dependency and a temp directory,
   and the whole thing is held in memory for the length of one request anyway. */
const IMPORT_ROLES = ['Super Admin', 'Company Admin', 'Accountant', 'Branch Manager', 'Store Manager'];

router.get('/:entity(customers|suppliers|items)/import/template.csv', requireRole(...IMPORT_ROLES), (req, res) => {
  const csv = templateCsv(req.params.entity);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.entity}-template.csv"`);
  res.send(csv);
});

router.post('/:entity(customers|suppliers|items)/import', requireRole(...IMPORT_ROLES), (req, res) => {
  const { filename, dataBase64 } = req.body || {};
  if (!dataBase64) return res.status(400).json({ error: 'No file was received. Pick a .xlsx or .csv file and try again.' });

  let buffer;
  try {
    buffer = Buffer.from(dataBase64, 'base64');
  } catch (e) {
    return res.status(400).json({ error: 'The uploaded file could not be decoded.' });
  }
  if (buffer.length === 0) return res.status(400).json({ error: 'The uploaded file is empty.' });

  try {
    const summary = importMaster(db, req.params.entity, {
      buffer,
      filename: filename || '',
      companyId: req.user.companyId,
      // A branch user's imports land in their own branch; a head-office user
      // may name one, or leave it company-wide.
      branchId: req.user.branchId || (req.body.branchId ? Number(req.body.branchId) : null),
      dryRun: req.body.dryRun === true || req.query.preview === '1',   // MD-11 validation preview
      updateMode: req.body.updateMode === true
    });

    if (!summary.dryRun && (summary.inserted > 0 || summary.updated > 0)) {
      logAudit({
        companyId: req.user.companyId, branchId: req.user.branchId, userId: req.user.userId,
        action: `IMPORT_${req.params.entity.toUpperCase()}`, entityType: req.params.entity,
        details: `${summary.inserted} imported, ${summary.updated || 0} updated, ${summary.skipped} skipped, ${summary.failed} rejected from ${filename || 'upload'}`,
        ip: req.ip
      });
    }
    res.json(summary);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* ---------------- Customer portal access ----------------
   Turning on a customer's self-service login is an administrative act, not a
   data edit, so it lives outside the generic CRUD router and is restricted to
   the roles that own customer relationships. Declared before the /customers
   CRUD mount so this more specific path wins.

   The password is set here rather than chosen by the customer because there is
   no mail provider wired up to send an invite - the account manager sets one
   and passes it on. The plaintext is never stored or echoed back.            */
const PORTAL_ADMIN_ROLES = ['Super Admin', 'Company Admin', 'Accountant', 'Branch Manager'];

router.get('/customers/:id/portal-access', requireRole(...PORTAL_ADMIN_ROLES), (req, res) => {
  const c = db.prepare('SELECT * FROM Customer WHERE CustomerID = ? AND CompanyID = ?')
    .get(req.params.id, req.user.companyId);
  if (!c) return res.status(404).json({ error: 'Customer not found' });
  res.json({
    customerId: c.CustomerID,
    customerName: c.CustomerName,
    email: c.Email,
    enabled: !!c.PortalEnabled,
    hasPassword: !!c.PortalPasswordHash,
    lastLogin: c.PortalLastLogin,
    terms: PORTAL_TERMS,
    ...accessStatus(c)
  });
});

router.post('/customers/:id/portal-access', requireRole(...PORTAL_ADMIN_ROLES), (req, res) => {
  const { enabled, password, termMonths } = req.body || {};
  const c = db.prepare('SELECT * FROM Customer WHERE CustomerID = ? AND CompanyID = ?')
    .get(req.params.id, req.user.companyId);
  if (!c) return res.status(404).json({ error: 'Customer not found' });

  const turningOn = enabled === undefined ? !!c.PortalEnabled : !!enabled;

  // Email is the portal's username, so access without one is unusable.
  if (turningOn && !(c.Email || '').trim()) {
    return res.status(400).json({ error: 'Add an email address to this customer before enabling portal access - it is their login.' });
  }
  if (turningOn && !c.PortalPasswordHash && !password) {
    return res.status(400).json({ error: 'Set a password when enabling portal access for the first time.' });
  }
  if (password !== undefined && password !== null && password !== '' && String(password).length < 8) {
    return res.status(400).json({ error: 'Portal password must be at least 8 characters' });
  }

  // How long the access runs for. `termMonths` is one of 1, 3, 6, 12, or the
  // string 'never' for an open-ended grant. Omitting it entirely keeps whatever
  // term is already in force, so switching access off and on again doesn't
  // quietly reset somebody's clock.
  let months;                       // undefined = leave the term as it is
  if (termMonths !== undefined && termMonths !== null && termMonths !== '') {
    if (termMonths === 'never') {
      months = null;
    } else {
      months = Number(termMonths);
      if (!VALID_MONTHS.includes(months)) {
        return res.status(400).json({
          error: `Access term must be one of ${VALID_MONTHS.join(', ')} months, or "never" for no expiry.`
        });
      }
    }
  } else if (turningOn && !c.PortalExpiresAt && !c.PortalTermMonths && !c.PortalEnabled) {
    // A first grant with no term named defaults to a year rather than forever:
    // an access nobody chose the length of should still lapse eventually.
    months = 12;
  }

  const current = db.prepare('SELECT PortalExpiresAt, PortalTermMonths FROM Customer WHERE CustomerID = ?').get(c.CustomerID);
  let expiresAt = current.PortalExpiresAt;
  let storedTerm = current.PortalTermMonths;
  if (months !== undefined) {
    expiresAt = computeExpiry(months, current.PortalExpiresAt);
    storedTerm = months;
  }

  const hash = password ? bcrypt.hashSync(String(password), 10) : c.PortalPasswordHash;
  db.prepare(
    `UPDATE Customer
     SET PortalEnabled = ?, PortalPasswordHash = ?, PortalExpiresAt = ?,
         PortalTermMonths = ?, PortalGrantedAt = ?
     WHERE CustomerID = ?`
  ).run(
    turningOn ? 1 : 0, hash, expiresAt, storedTerm,
    turningOn ? (c.PortalGrantedAt || new Date().toISOString().slice(0, 10)) : c.PortalGrantedAt,
    c.CustomerID
  );

  const after = db.prepare('SELECT * FROM Customer WHERE CustomerID = ?').get(c.CustomerID);
  const status = accessStatus(after);

  logAudit({
    companyId: req.user.companyId, branchId: req.user.branchId, userId: req.user.userId,
    action: turningOn ? 'PORTAL_ACCESS_ENABLED' : 'PORTAL_ACCESS_DISABLED',
    entityType: 'Customer', entityId: c.CustomerID,
    details: `${c.CustomerName}${password ? ' (password set)' : ''}` +
      (turningOn ? ` — ${status.expiresAt ? 'until ' + status.expiresAt : 'no expiry'}` : ''),
    ip: req.ip
  });

  res.json({ success: true, enabled: turningOn, hasPassword: !!hash, ...status });
});

// PRT-01: email a customer a one-time link to set their own portal password.
router.post('/customers/:id/portal-invite', requireRole(...PORTAL_ADMIN_ROLES), async (req, res) => {
  const c = db.prepare('SELECT * FROM Customer WHERE CustomerID = ? AND CompanyID = ?').get(req.params.id, req.user.companyId);
  if (!c) return res.status(404).json({ error: 'Customer not found' });
  if (!(c.Email || '').trim()) return res.status(400).json({ error: 'Add an email address to this customer first - the invite is sent there.' });
  const token = crypto.randomBytes(24).toString('hex');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const expiry = new Date(Date.now() + 7 * 86400000).toISOString();
  db.prepare('UPDATE Customer SET PortalInviteHash = ?, PortalInviteExpiry = ?, PortalEnabled = 1 WHERE CustomerID = ?').run(hash, expiry, c.CustomerID);
  const company = db.prepare('SELECT CompanyName FROM Company WHERE CompanyID = ?').get(req.user.companyId) || {};
  const base = process.env.PUBLIC_URL || '';
  const link = `${base}/portal-setup.html?c=${c.CustomerID}&t=${token}`;
  const r = await messaging.sendTemplate({ companyId: req.user.companyId, code: 'PORTAL_INVITE', to: c.Email,
    vars: { name: c.CustomerName, company: company.CompanyName || 'your supplier', link }, refType: 'Customer', refId: c.CustomerID });
  logAudit({ companyId: req.user.companyId, branchId: req.user.branchId, userId: req.user.userId, action: 'PORTAL_INVITE_SENT',
    entityType: 'Customer', entityId: c.CustomerID, details: `${c.CustomerName} <${c.Email}> (${r.status})`, ip: req.ip });
  res.json({ success: true, deliveryStatus: r.status, messageId: r.messageId });
});

const CUSTOMER_FIELDS = [
  'CustomerName', 'GSTIN', 'PAN', 'PartyType', 'Mobile', 'Email', 'Address', 'City', 'State', 'StateCode',
  'CreditLimit', 'CreditDays', 'PaymentTermID', 'ShippingAddress', 'ContactPerson',
  'BankName', 'BankAccountNo', 'BankIFSC', 'ReconciliationAccountID', 'CustomerGroup', 'DisplayMode',
  'CustomAttributes', 'RequireSerialTracking', 'SAPCode', 'CustomerCode', 'Reason'
];
router.use('/customers', crudFor('Customer', 'CustomerID', CUSTOMER_FIELDS, { validate: normaliseParty, autoCode: { column: 'CustomerCode', prefix: 'CUST' } }));

// "Moving" a customer from its home branch to another (still visible
// company-wide either way - BranchID only decides who it defaults to for).
const MOVE_ROLES = ['Super Admin', 'Company Admin', 'Branch Manager'];
router.post('/customers/:id/move-branch', requireRole(...MOVE_ROLES), (req, res) => {
  const row = db.prepare('SELECT * FROM Customer WHERE CustomerID = ? AND CompanyID = ?').get(req.params.id, req.user.companyId);
  if (!row) return res.status(404).json({ error: 'Customer not found' });
  const branchId = req.body.branchId ? Number(req.body.branchId) : null;
  if (branchId) {
    const branch = db.prepare('SELECT 1 FROM Branch WHERE BranchID = ? AND CompanyID = ?').get(branchId, req.user.companyId);
    if (!branch) return res.status(400).json({ error: 'That branch was not found' });
  }
  db.prepare('UPDATE Customer SET BranchID = ? WHERE CustomerID = ? AND CompanyID = ?').run(branchId, req.params.id, req.user.companyId);
  logAudit({
    companyId: req.user.companyId, branchId: req.user.branchId, userId: req.user.userId,
    action: 'MOVE_CUSTOMER_BRANCH', entityType: 'Customer', entityId: req.params.id,
    details: `${row.CustomerName}: branch ${row.BranchID || '(none)'} -> ${branchId || '(none)'}`, ip: req.ip
  });
  res.json({ success: true, branchId });
});
router.use('/suppliers', crudFor('Supplier', 'SupplierID',
  ['SupplierName', 'GSTIN', 'PAN', 'PartyType', 'Mobile', 'Email', 'Address', 'State', 'StateCode', 'CreditDays', 'PaymentTermID', 'ContactPerson', 'BankAccount', 'BankIFSC'], { validate: normaliseParty }));
// The full item specification: identity, sourcing, storage, traceability,
// costing and BOM. Kept as one flat list because the CRUD helper writes exactly
// the fields it is given and ignores anything else in the body.
const ITEM_FIELDS = [
  'ItemCode', 'ItemName', 'Category', 'HSN', 'GSTRate', 'Unit', 'AltUnit', 'AltUnitFactor',
  'Dimensions', 'MaterialType', 'PreferredVendorID', 'LeadTimeDays', 'ReorderLevel',
  'PurchaseRate', 'Warehouse', 'BinRack', 'BatchTracking', 'SerialTracking', 'ShelfLifeMonths',
  'CostingMethod', 'StandardCost', 'SaleRate', 'Barcode', 'GLMapping', 'BOMLink',
  'YieldPercent', 'WastagePercent', 'ImageDataUrl', 'CustomAttributes', 'Remarks'
];
router.use('/items', crudFor('Item', 'ItemID', ITEM_FIELDS, { branchScoped: false, autoCode: { column: 'ItemCode', prefix: 'ITEM' } }));

// GST state list (MD-02): name + code, for the state dropdowns.
router.get('/gst-states', (req, res) => {
  const seen = {};
  const out = [];
  Object.entries(STATE_CODES).forEach(([name, code]) => {
    if (seen[code]) return; seen[code] = 1;
    out.push({ code, name: stateNameForCode(code) });
  });
  res.json(out.sort((a, b) => a.code.localeCompare(b.code)));
});

// Validate a GSTIN without saving - the master screen calls this as the user types.
router.get('/validate-gstin', (req, res) => res.json(validateGstin(req.query.gstin)));

// Payment terms master (MD-04). Edit and deactivate; a term in use is never deleted.
const PTERM_ROLES = ['Super Admin', 'Company Admin', 'Accountant'];
router.get('/payment-terms', (req, res) => {
  const all = req.query.all === '1';
  res.json(db.prepare(`SELECT * FROM PaymentTerm WHERE CompanyID = ?${all ? '' : ' AND IsActive = 1'} ORDER BY NetDays`).all(req.user.companyId));
});
router.post('/payment-terms', requireRole(...PTERM_ROLES), (req, res) => {
  const { Code, Description, BaselineDate, NetDays, DiscountJson } = req.body || {};
  if (!Code || !String(Code).trim()) return res.status(400).json({ error: 'A short code is required' });
  if (!(Number(NetDays) >= 0)) return res.status(400).json({ error: 'Net days must be zero or more' });
  if (BaselineDate && !['Invoice', 'MonthEnd'].includes(BaselineDate)) return res.status(400).json({ error: "Baseline must be 'Invoice' or 'MonthEnd'" });
  try {
    const id = db.prepare('INSERT INTO PaymentTerm (CompanyID, Code, Description, BaselineDate, NetDays, DiscountJson) VALUES (?,?,?,?,?,?)')
      .run(req.user.companyId, String(Code).trim().toUpperCase(), Description || '', BaselineDate || 'Invoice', Number(NetDays), DiscountJson || null).lastInsertRowid;
    logAudit({ companyId: req.user.companyId, userId: req.user.userId, action: 'CREATE_PAYMENT_TERM', entityType: 'PaymentTerm', entityId: id, details: Code, ip: req.ip });
    res.status(201).json({ id });
  } catch (e) { res.status(400).json({ error: /UNIQUE/.test(e.message) ? 'That code already exists' : e.message }); }
});
router.put('/payment-terms/:id', requireRole(...PTERM_ROLES), (req, res) => {
  const before = db.prepare('SELECT * FROM PaymentTerm WHERE PaymentTermID = ? AND CompanyID = ?').get(req.params.id, req.user.companyId);
  if (!before) return res.status(404).json({ error: 'Payment term not found' });
  const fields = ['Description', 'BaselineDate', 'NetDays', 'DiscountJson'];
  const cols = fields.filter(f => req.body[f] !== undefined);
  if (!cols.length) return res.status(400).json({ error: 'Nothing to update' });
  db.prepare(`UPDATE PaymentTerm SET ${cols.map(c => c + ' = ?').join(', ')} WHERE PaymentTermID = ? AND CompanyID = ?`)
    .run(...cols.map(c => req.body[c]), req.params.id, req.user.companyId);
  logAudit({ companyId: req.user.companyId, userId: req.user.userId, action: 'UPDATE_PAYMENT_TERM', entityType: 'PaymentTerm', entityId: req.params.id,
    details: diffFields(before, req.body, cols).join('; '), ip: req.ip });
  res.json({ success: true });
});
router.delete('/payment-terms/:id', requireRole(...PTERM_ROLES), (req, res) => {
  const used = db.prepare('SELECT 1 FROM Customer WHERE PaymentTermID = ? UNION SELECT 1 FROM Supplier WHERE PaymentTermID = ? LIMIT 1').get(req.params.id, req.params.id);
  db.prepare('UPDATE PaymentTerm SET IsActive = 0 WHERE PaymentTermID = ? AND CompanyID = ?').run(req.params.id, req.user.companyId);
  logAudit({ companyId: req.user.companyId, userId: req.user.userId, action: 'DEACTIVATE_PAYMENT_TERM', entityType: 'PaymentTerm', entityId: req.params.id, ip: req.ip });
  res.json({ success: true, deactivated: true, inUse: !!used });
});

module.exports = router;
