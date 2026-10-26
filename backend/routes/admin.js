const express = require('express');
const db = require('../db');
const { requireAuth, requireRole, resolveBranchScope } = require('../middleware/auth');
const { logAudit } = require('./auth');
const { getSettings, updateSettings } = require('../services/policy');
const { DOC_TYPES, peekNextNumber, activeFinancialYear, composeNumber, checkPrefix, MAX_NUMBER_LENGTH } = require('../services/numbering');
const { postJournalEntry } = require('./accounts');
const path = require('path');
const fs = require('fs');

const router = express.Router();
router.use(requireAuth);

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

// ---------------- Company policy settings ----------------

router.get('/settings', (req, res) => {
  res.json(getSettings(req.user.companyId));
});

// Only a Super Admin can relax a control. These switches decide whether the
// system refuses bad transactions, so they are not a Company Admin's to flip.
router.put('/settings', requireRole('Super Admin'), (req, res) => {
  const { allowNegativeStock, enforceCreditLimit } = req.body;
  if (allowNegativeStock === undefined && enforceCreditLimit === undefined) {
    return res.status(400).json({ error: 'Nothing to change' });
  }
  const updated = updateSettings(req.user.companyId, { allowNegativeStock, enforceCreditLimit });

  // Relaxing a control is exactly the kind of thing an auditor needs to see.
  logAudit({
    companyId: req.user.companyId, branchId: req.user.branchId, userId: req.user.userId,
    action: 'UPDATE_COMPANY_SETTINGS', entityType: 'CompanySettings', entityId: req.user.companyId,
    details: `allowNegativeStock=${updated.allowNegativeStock}, enforceCreditLimit=${updated.enforceCreditLimit}`,
    ip: req.ip
  });
  res.json(updated);
});


// ---------------- Company Master (Mfynix section 3) ----------------

router.get('/company', (req, res) => {
  const company = db.prepare('SELECT * FROM Company WHERE CompanyID = ?').get(req.user.companyId);
  if (!company) return res.status(404).json({ error: 'Company not found' });
  res.json(company);
});

router.put('/company', requireRole('Super Admin', 'Company Admin'), (req, res) => {
  const allowed = {
    companyName: 'CompanyName', gstin: 'GSTIN', pan: 'PAN', cin: 'CIN',
    address: 'Address', state: 'State', country: 'Country',
    phone: 'Phone', email: 'Email', website: 'Website', logoDataUrl: 'LogoDataUrl',
    bankName: 'BankName', bankAccountNo: 'BankAccountNo', bankIFSC: 'BankIFSC', bankBranch: 'BankBranch',
    invoicePrefix: 'InvoicePrefix', declarationText: 'DeclarationText'
  };
  const cols = [], vals = [];
  Object.entries(allowed).forEach(([k, col]) => {
    if (req.body[k] !== undefined) { cols.push(`${col} = ?`); vals.push(req.body[k] === '' ? null : req.body[k]); }
  });
  if (cols.length === 0) return res.status(400).json({ error: 'Nothing to change' });

  if (req.body.companyName !== undefined && !String(req.body.companyName).trim()) {
    return res.status(400).json({ error: 'Company name cannot be empty' });
  }
  // EIN-01: the prefix must leave room for branch code, year and counter within 16 characters.
  if (req.body.invoicePrefix !== undefined && String(req.body.invoicePrefix).trim()) {
    const pfx = String(req.body.invoicePrefix).trim();
    const longestBranch = db.prepare('SELECT MAX(LENGTH(BranchCode)) AS m FROM Branch WHERE CompanyID = ?').get(req.user.companyId).m || 0;
    const problem = checkPrefix(longestBranch ? `${'X'.repeat(longestBranch)}-${pfx}` : pfx)
      || (/^[A-Za-z0-9\-\/]+$/.test(pfx) ? null : 'The invoice prefix may use only letters, digits, hyphen and slash');
    if (problem) return res.status(400).json({ error: problem.replace(/^Document number "[^"]*"/, 'With this prefix an invoice number') });
  }
  // A logo is embedded as a data URL and printed on every invoice, so keep it
  // small enough not to bloat every page load.
  if (req.body.logoDataUrl && String(req.body.logoDataUrl).length > 400000) {
    return res.status(400).json({ error: 'Logo is too large - use an image under about 300 KB' });
  }

  db.prepare(`UPDATE Company SET ${cols.join(', ')} WHERE CompanyID = ?`).run(...vals, req.user.companyId);

  // Changing the invoice prefix has to reach the numbering engine, or the
  // setting looks like it did nothing. It is applied only to series that have
  // not issued a number yet: renaming a series mid-year would leave a visible
  // break in an invoice sequence that GST expects to be continuous. Series
  // already in use are reported back so the admin knows to change them
  // deliberately on the Numbering tab if that is really what they want.
  let seriesNote = null;
  if (req.body.invoicePrefix !== undefined && String(req.body.invoicePrefix).trim()) {
    const newPrefix = String(req.body.invoicePrefix).trim();
    const invSeries = db.prepare(
      `SELECT d.*, b.BranchCode FROM DocumentSequence d LEFT JOIN Branch b ON b.BranchID = d.BranchID
       WHERE d.CompanyID = ? AND d.DocType = 'INV'`
    ).all(req.user.companyId);

    let renamed = 0;
    const inUse = [];
    invSeries.forEach(sq => {
      const target = sq.BranchCode ? `${sq.BranchCode}-${newPrefix}` : newPrefix;
      if (sq.Prefix === target) return;
      if (sq.NextNumber === 1) {
        db.prepare('UPDATE DocumentSequence SET Prefix = ? WHERE SequenceID = ?').run(target, sq.SequenceID);
        renamed++;
      } else {
        inUse.push(`${sq.Prefix} (${sq.FinancialYear})`);
      }
    });
    if (inUse.length) {
      seriesNote = `The new prefix applies to new number series. ${inUse.length} series already in use kept its existing prefix so the invoice sequence stays unbroken: ${inUse.join(', ')}. Change those on the Numbering tab if you want them renamed.`;
    } else if (renamed) {
      seriesNote = `Invoice numbering will now use "${newPrefix}".`;
    }
  }

  logAudit({
    companyId: req.user.companyId, branchId: req.user.branchId, userId: req.user.userId,
    action: 'UPDATE_COMPANY', entityType: 'Company', entityId: req.user.companyId,
    details: Object.keys(allowed).filter(k => req.body[k] !== undefined).join(', '), ip: req.ip
  });
  res.json({ ...db.prepare('SELECT * FROM Company WHERE CompanyID = ?').get(req.user.companyId), seriesNote });
});

// ---------------- Financial years (Mfynix section 3) ----------------

router.get('/financial-years', (req, res) => {
  res.json(db.prepare(
    'SELECT * FROM FinancialYear WHERE CompanyID = ? ORDER BY StartDate DESC'
  ).all(req.user.companyId));
});

router.post('/financial-years', requireRole('Super Admin', 'Company Admin'), (req, res) => {
  const { yearName, startDate, endDate } = req.body;
  if (!yearName || !startDate || !endDate) {
    return res.status(400).json({ error: 'yearName, startDate and endDate are required' });
  }
  if (new Date(endDate) <= new Date(startDate)) {
    return res.status(400).json({ error: 'The end date must be after the start date' });
  }
  // Overlapping years would make "which year is this invoice in?" ambiguous.
  const clash = db.prepare(
    `SELECT YearName FROM FinancialYear WHERE CompanyID = ?
       AND date(StartDate) <= date(?) AND date(EndDate) >= date(?)`
  ).get(req.user.companyId, endDate, startDate);
  if (clash) return res.status(409).json({ error: `Those dates overlap the existing year ${clash.YearName}` });

  try {
    const id = db.prepare(
      'INSERT INTO FinancialYear (CompanyID, YearName, StartDate, EndDate) VALUES (?,?,?,?)'
    ).run(req.user.companyId, yearName, startDate, endDate).lastInsertRowid;
    logAudit({ companyId: req.user.companyId, branchId: req.user.branchId, userId: req.user.userId,
      action: 'CREATE_FINANCIAL_YEAR', entityType: 'FinancialYear', entityId: id, details: yearName, ip: req.ip });
    res.status(201).json({ financialYearId: id });
  } catch (e) {
    if (String(e).includes('UNIQUE')) return res.status(409).json({ error: 'A year with that name already exists' });
    res.status(500).json({ error: 'Could not create the financial year' });
  }
});

// Exactly one year is active at a time - it's what new documents default into.
router.post('/financial-years/:id/activate', requireRole('Super Admin', 'Company Admin'), (req, res) => {
  const fy = db.prepare('SELECT * FROM FinancialYear WHERE FinancialYearID = ? AND CompanyID = ?')
    .get(req.params.id, req.user.companyId);
  if (!fy) return res.status(404).json({ error: 'Financial year not found' });
  if (fy.IsClosed) return res.status(400).json({ error: 'A closed year cannot be made active - reopen it first' });

  const tx = db.transaction(() => {
    db.prepare('UPDATE FinancialYear SET IsActive = 0 WHERE CompanyID = ?').run(req.user.companyId);
    db.prepare('UPDATE FinancialYear SET IsActive = 1 WHERE FinancialYearID = ?').run(fy.FinancialYearID);
  });
  tx();
  logAudit({ companyId: req.user.companyId, branchId: req.user.branchId, userId: req.user.userId,
    action: 'ACTIVATE_FINANCIAL_YEAR', entityType: 'FinancialYear', entityId: fy.FinancialYearID,
    details: fy.YearName, ip: req.ip });
  res.json({ success: true, active: fy.YearName });
});

// Closing a year stops new postings dated inside it. It is reversible on
// purpose: an accountant often closes, finds an error, and needs to reopen.
router.post('/financial-years/:id/close', requireRole('Super Admin', 'Company Admin'), (req, res) => {
  const { closed } = req.body;
  const fy = db.prepare('SELECT * FROM FinancialYear WHERE FinancialYearID = ? AND CompanyID = ?')
    .get(req.params.id, req.user.companyId);
  if (!fy) return res.status(404).json({ error: 'Financial year not found' });
  if (closed && fy.IsActive) {
    return res.status(400).json({ error: 'The active year cannot be closed - activate another year first' });
  }
  db.prepare('UPDATE FinancialYear SET IsClosed = ? WHERE FinancialYearID = ?').run(closed ? 1 : 0, fy.FinancialYearID);
  logAudit({ companyId: req.user.companyId, branchId: req.user.branchId, userId: req.user.userId,
    action: closed ? 'CLOSE_FINANCIAL_YEAR' : 'REOPEN_FINANCIAL_YEAR', entityType: 'FinancialYear',
    entityId: fy.FinancialYearID, details: fy.YearName, ip: req.ip });
  res.json({ success: true, closed: !!closed });
});

// ---------------- Document numbering (Mfynix section 22) ----------------

router.get('/numbering', (req, res) => {
  const fy = activeFinancialYear(req.user.companyId);
  const rows = db.prepare(
    `SELECT d.*, b.BranchName, b.BranchCode FROM DocumentSequence d
     LEFT JOIN Branch b ON b.BranchID = d.BranchID
     WHERE d.CompanyID = ? ORDER BY d.DocType, b.BranchCode`
  ).all(req.user.companyId);

  res.json({
    activeYear: fy ? fy.YearName : null,
    docTypes: Object.entries(DOC_TYPES).map(([code, v]) => ({
      code, label: v.label, nextNumber: peekNextNumber(req.user.companyId, null, code)
    })),
    sequences: rows.map(r => ({
      ...r,
      preview: (() => { try { return composeNumber(r.Prefix, r.FinancialYear, r.NextNumber, r.Padding || 5); } catch (e) { return '(invalid: ' + e.message + ')'; } })(),
      maxLength: MAX_NUMBER_LENGTH
    }))
  });
});

// The prefix and padding can be changed; the counter can only be moved FORWARD.
// Letting it go backwards would reissue numbers that are already on documents
// a customer or the GST department has seen.
router.put('/numbering/:id', requireRole('Super Admin', 'Company Admin'), (req, res) => {
  const seq = db.prepare('SELECT * FROM DocumentSequence WHERE SequenceID = ? AND CompanyID = ?')
    .get(req.params.id, req.user.companyId);
  if (!seq) return res.status(404).json({ error: 'Sequence not found' });

  const { prefix, padding, nextNumber } = req.body;
  const sets = [], vals = [];
  // EIN-01: whatever is saved must still produce numbers of at most 16 valid characters.
  {
    const newPrefix = prefix !== undefined ? String(prefix).trim() : seq.Prefix;
    const newPadding = padding !== undefined ? Number(padding) : (seq.Padding || 5);
    if ((prefix !== undefined || padding !== undefined) && Number.isInteger(newPadding) && newPadding >= 1 && newPadding <= 10) {
      const problem = checkPrefix(newPrefix, newPadding);
      if (problem) return res.status(400).json({ error: problem });
    }
  }
  if (prefix !== undefined) {
    if (!String(prefix).trim()) return res.status(400).json({ error: 'Prefix cannot be empty' });
    sets.push('Prefix = ?'); vals.push(String(prefix).trim());
  }
  if (padding !== undefined) {
    const p = Number(padding);
    if (!Number.isInteger(p) || p < 1 || p > 10) return res.status(400).json({ error: 'Padding must be between 1 and 10' });
    sets.push('Padding = ?'); vals.push(p);
  }
  if (nextNumber !== undefined) {
    const n = Number(nextNumber);
    if (!Number.isInteger(n) || n < 1) return res.status(400).json({ error: 'The next number must be a whole number of 1 or more' });
    if (n < seq.NextNumber) {
      return res.status(400).json({
        error: `The counter can only move forward. It is at ${seq.NextNumber}; setting it back would reissue numbers that are already on saved documents.`
      });
    }
    sets.push('NextNumber = ?'); vals.push(n);
  }
  if (sets.length === 0) return res.status(400).json({ error: 'Nothing to change' });

  db.prepare(`UPDATE DocumentSequence SET ${sets.join(', ')} WHERE SequenceID = ?`).run(...vals, seq.SequenceID);
  logAudit({ companyId: req.user.companyId, branchId: req.user.branchId, userId: req.user.userId,
    action: 'UPDATE_DOCUMENT_SEQUENCE', entityType: 'DocumentSequence', entityId: seq.SequenceID,
    details: `${seq.DocType} ${seq.FinancialYear}`, ip: req.ip });
  res.json({ success: true });
});


// ---------------- Year-end close with carry-forward ----------------
//
// Closing a year properly does three things, all in one transaction:
//   1. posts a closing journal that zeroes every Income and Expense account
//      into Retained Earnings, so the P&L starts the new year at nil;
//   2. writes the resulting balance-sheet balances into OpeningBalance for the
//      next year, so reports for that year start from the right position;
//   3. locks the year against further postings.
// Previously "close" only did step 3, which meant retained earnings were
// recomputed on the fly forever and no year ever really ended.
router.post('/financial-years/:id/close-with-carryforward', requireRole('Super Admin', 'Company Admin'), (req, res) => {
  const fy = db.prepare('SELECT * FROM FinancialYear WHERE FinancialYearID = ? AND CompanyID = ?')
    .get(req.params.id, req.user.companyId);
  if (!fy) return res.status(404).json({ error: 'Financial year not found' });
  if (fy.IsClosed) return res.status(409).json({ error: 'That year is already closed' });

  const nextFy = db.prepare(
    `SELECT * FROM FinancialYear WHERE CompanyID = ? AND date(StartDate) > date(?) ORDER BY date(StartDate) LIMIT 1`
  ).get(req.user.companyId, fy.EndDate);
  if (!nextFy) {
    return res.status(400).json({ error: 'Create the following financial year first — there is nowhere to carry the balances into' });
  }

  const tx = db.transaction(() => {
    const branches = db.prepare('SELECT BranchID, BranchName FROM Branch WHERE CompanyID = ? AND IsActive = 1').all(req.user.companyId);
    const retained = db.prepare(
      `SELECT AccountID FROM ChartOfAccounts WHERE CompanyID = ? AND AccountCode = '3100'`
    ).get(req.user.companyId);
    if (!retained) throw new Error('Chart of Accounts is missing Retained Earnings (3100)');

    let closingJournalId = null;
    let totalProfit = 0;
    const perBranch = [];

    branches.forEach(branch => {
      // Balances for this branch, for entries dated inside the year being closed.
      const balances = db.prepare(
        `SELECT a.AccountID, a.AccountCode, a.AccountName, a.AccountType,
                COALESCE(SUM(jl.Debit),0) AS D, COALESCE(SUM(jl.Credit),0) AS C
         FROM ChartOfAccounts a
         JOIN JournalLine jl ON jl.AccountID = a.AccountID
         JOIN JournalEntry j ON j.JournalID = jl.JournalID
         WHERE a.CompanyID = ? AND j.BranchID = ?
           AND date(j.EntryDate) BETWEEN date(?) AND date(?)
         GROUP BY a.AccountID`
      ).all(req.user.companyId, branch.BranchID, fy.StartDate, fy.EndDate);

      if (balances.length === 0) return;

      // 1. Close P&L accounts into Retained Earnings.
      const pl = balances.filter(b => ['Income', 'Expense'].includes(b.AccountType));
      const closingLines = [];
      let profit = 0;
      pl.forEach(b => {
        const net = b.D - b.C;             // debit-positive
        if (Math.abs(net) < 0.005) return;
        // Post the opposite of the balance to bring the account to zero.
        closingLines.push(net > 0
          ? { accountId: b.AccountID, debit: 0, credit: net }
          : { accountId: b.AccountID, debit: -net, credit: 0 });
        profit -= net;                      // income (credit-heavy) increases profit
      });

      if (closingLines.length) {
        closingLines.push(profit >= 0
          ? { accountId: retained.AccountID, debit: 0, credit: round2(profit) }
          : { accountId: retained.AccountID, debit: round2(-profit), credit: 0 });

        closingJournalId = postJournalEntry(db, {
          companyId: req.user.companyId, branchId: branch.BranchID, entryDate: fy.EndDate,
          narration: `Year-end closing entry for ${fy.YearName} — ${branch.BranchName}`,
          sourceType: 'YearEndClose', sourceId: fy.FinancialYearID,
          createdBy: req.user.userId, lines: closingLines
        });
      }
      totalProfit += profit;
      perBranch.push({ branch: branch.BranchName, profit: round2(profit) });

      // 2. Carry balance-sheet accounts forward as next year's openings.
      // The closing entry has just changed Retained Earnings, so re-read it.
      const carry = db.prepare(
        `SELECT a.AccountID, a.AccountType,
                COALESCE(SUM(jl.Debit),0) AS D, COALESCE(SUM(jl.Credit),0) AS C
         FROM ChartOfAccounts a
         JOIN JournalLine jl ON jl.AccountID = a.AccountID
         JOIN JournalEntry j ON j.JournalID = jl.JournalID
         WHERE a.CompanyID = ? AND j.BranchID = ?
           AND a.AccountType IN ('Asset','Liability','Equity')
           AND date(j.EntryDate) <= date(?)
         GROUP BY a.AccountID`
      ).all(req.user.companyId, branch.BranchID, fy.EndDate);

      const upsertOpening = db.prepare(
        `INSERT INTO OpeningBalance (CompanyID, BranchID, FinancialYearID, AccountID, Debit, Credit)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(FinancialYearID, BranchID, AccountID) DO UPDATE SET Debit = excluded.Debit, Credit = excluded.Credit`
      );
      carry.forEach(b => {
        const net = round2(b.D - b.C);
        if (Math.abs(net) < 0.005) return;
        upsertOpening.run(req.user.companyId, branch.BranchID, nextFy.FinancialYearID, b.AccountID,
          net > 0 ? net : 0, net < 0 ? -net : 0);
      });
    });

    // 3. Lock the year and make the next one active.
    db.prepare(`UPDATE FinancialYear SET IsClosed = 1, IsActive = 0, ClosedAt = datetime('now'), ClosingJournalID = ? WHERE FinancialYearID = ?`)
      .run(closingJournalId, fy.FinancialYearID);
    db.prepare('UPDATE FinancialYear SET IsActive = 0 WHERE CompanyID = ?').run(req.user.companyId);
    db.prepare('UPDATE FinancialYear SET IsActive = 1 WHERE FinancialYearID = ?').run(nextFy.FinancialYearID);

    logAudit({
      companyId: req.user.companyId, branchId: req.user.branchId, userId: req.user.userId,
      action: 'YEAR_END_CLOSE', entityType: 'FinancialYear', entityId: fy.FinancialYearID,
      details: `${fy.YearName} closed, profit ${round2(totalProfit)}, carried into ${nextFy.YearName}`, ip: req.ip
    });

    return { closed: fy.YearName, carriedInto: nextFy.YearName, netProfit: round2(totalProfit), perBranch };
  });

  try {
    res.json(tx());
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/financial-years/:id/opening-balances', (req, res) => {
  const rows = db.prepare(
    `SELECT o.*, a.AccountCode, a.AccountName, a.AccountType, b.BranchName
     FROM OpeningBalance o
     JOIN ChartOfAccounts a ON a.AccountID = o.AccountID
     JOIN Branch b ON b.BranchID = o.BranchID
     WHERE o.CompanyID = ? AND o.FinancialYearID = ?
     ORDER BY b.BranchName, a.AccountCode`
  ).all(req.user.companyId, req.params.id);
  const totalDebit = rows.reduce((s, r) => s + r.Debit, 0);
  const totalCredit = rows.reduce((s, r) => s + r.Credit, 0);
  res.json({ rows, totalDebit: round2(totalDebit), totalCredit: round2(totalCredit),
             balanced: Math.abs(totalDebit - totalCredit) < 0.01 });
});

// ---------------- Multi-company ----------------

router.get('/companies', requireRole('Super Admin'), (req, res) => {
  res.json(db.prepare(
    `SELECT c.CompanyID, c.CompanyName, c.GSTIN, c.IsActive,
            (SELECT COUNT(*) FROM Branch b WHERE b.CompanyID = c.CompanyID) AS Branches,
            (SELECT COUNT(*) FROM Users u WHERE u.CompanyID = c.CompanyID) AS Users
     FROM Company c ORDER BY c.CompanyName`
  ).all());
});

// Creating a company also creates its head-office branch, its admin user, its
// chart of accounts, its financial year and its settings - otherwise you'd be
// left with a company nobody can log into and nothing can post to.
router.post('/companies', requireRole('Super Admin'), (req, res) => {
  const { companyName, gstin, state, branchName, branchCode, adminUserName, adminPassword, adminFullName } = req.body;
  if (!companyName || !branchName || !branchCode || !adminUserName || !adminPassword) {
    return res.status(400).json({ error: 'companyName, branchName, branchCode, adminUserName and adminPassword are required' });
  }
  if (String(adminPassword).length < 8) {
    return res.status(400).json({ error: 'The admin password must be at least 8 characters' });
  }
  if (db.prepare('SELECT 1 FROM Users WHERE UserName = ?').get(adminUserName)) {
    return res.status(409).json({ error: 'That username is already taken' });
  }

  const bcrypt = require('bcryptjs');
  const { seedCompany } = require('../db/seed');

  try {
    const result = db.transaction(() => seedCompany(db, {
      companyName, gstin, state, branchName, branchCode,
      adminUserName, adminFullName, passwordHash: bcrypt.hashSync(adminPassword, 10)
    }))();
    require('../db/migrate_r1').ensureDefaults(db);
    require('../db/migrate_r2').ensureDefaults(db);
    logAudit({
      companyId: req.user.companyId, branchId: req.user.branchId, userId: req.user.userId,
      action: 'CREATE_COMPANY', entityType: 'Company', entityId: result.companyId,
      details: `${companyName} with admin ${adminUserName}`, ip: req.ip
    });
    res.status(201).json(result);
  } catch (e) {
    res.status(500).json({ error: 'Could not create the company: ' + e.message });
  }
});

// ---------------- Backup ----------------
//
// The whole database is one SQLite file, so a backup is a byte-for-byte copy.
// VACUUM INTO is used rather than copying the file directly: it produces a
// consistent snapshot even while the server is running and other writes are in
// flight, which a plain file copy of a WAL database does not.
router.get('/backup', requireRole('Super Admin'), (req, res) => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const tmpPath = path.join(require('os').tmpdir(), `mfynix-backup-${stamp}.db`);
  try {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    db.prepare('VACUUM INTO ?').run(tmpPath);

    logAudit({
      companyId: req.user.companyId, branchId: req.user.branchId, userId: req.user.userId,
      action: 'DOWNLOAD_BACKUP', entityType: 'Database', details: `mfynix-backup-${stamp}.db`, ip: req.ip
    });

    res.download(tmpPath, `mfynix-backup-${stamp}.db`, (err) => {
      fs.unlink(tmpPath, () => {});   // always clean the temp file up
      if (err && !res.headersSent) res.status(500).json({ error: 'Backup download failed' });
    });
  } catch (e) {
    res.status(500).json({ error: 'Could not create the backup: ' + e.message });
  }
});

router.get('/backup/info', requireRole('Super Admin'), (req, res) => {
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'db', 'mfintech.db');
  let sizeBytes = null, modified = null;
  try {
    const st = fs.statSync(dbPath);
    sizeBytes = st.size; modified = st.mtime.toISOString();
  } catch (e) { /* file may not exist yet on a brand-new install */ }
  const counts = {};
  ['SalesHeader', 'PurchaseHeader', 'JournalEntry', 'NoteHeader', 'Customer', 'Item', 'AuditLog']
    .forEach(t => { counts[t] = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c; });
  res.json({ sizeBytes, modified, counts });
});


// ---------------- Scheduled backups (PLT-05 / AUT-16) ----------------
const backupSvc = require('../services/backup');

router.get('/backups', requireRole('Super Admin'), (req, res) => {
  res.json({ rows: backupSvc.listBackups(), lastScheduled: backupSvc.lastScheduledDate() });
});

router.post('/backups', requireRole('Super Admin'), (req, res) => {
  const r = backupSvc.runBackup('manual');
  logAudit({ companyId: req.user.companyId, branchId: req.user.branchId, userId: req.user.userId, action: 'RUN_BACKUP', entityType: 'Database', details: r.fileName + (r.verified ? ' verified' : ' NOT verified'), ip: req.ip });
  res.status(r.verified ? 201 : 500).json(r);
});

router.post('/backups/:id/test-restore', requireRole('Super Admin'), (req, res) => {
  try {
    const r = backupSvc.testRestore(Number(req.params.id));
    logAudit({ companyId: req.user.companyId, branchId: req.user.branchId, userId: req.user.userId, action: 'TEST_RESTORE', entityType: 'Database', details: r.ok ? 'ok' : r.detail, ip: req.ip });
    res.json(r);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/backups/:id/download', requireRole('Super Admin'), (req, res) => {
  const row = db.prepare('SELECT * FROM BackupLog WHERE BackupID = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Backup not found' });
  const file = backupSvc.backupPath(row.FileName);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'That backup file has been pruned' });
  logAudit({ companyId: req.user.companyId, branchId: req.user.branchId, userId: req.user.userId, action: 'DOWNLOAD_BACKUP', entityType: 'Database', details: row.FileName, ip: req.ip });
  res.download(file, row.FileName);
});

// ---------------- Audit log ----------------
//
// The log has been written since day one but had no way to read it, which made
// it useless for the compliance question it exists to answer. Visible to the
// roles that are accountable for what happened: administrators and auditors.

const AUDIT_ROLES = ['Super Admin', 'Company Admin', 'Auditor'];

router.get('/audit', (req, res) => {
  if (!AUDIT_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'You do not have access to the audit log' });
  }

  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 50));
  const offset = (page - 1) * pageSize;

  // A branch-locked administrator sees only their own branch's activity.
  const branchId = resolveBranchScope(req);
  const { action, userId, from, to, search } = req.query;

  const where = ['a.CompanyID = ?'];
  const args = [req.user.companyId];
  if (branchId) { where.push('a.BranchID = ?'); args.push(branchId); }
  if (action) { where.push('a.Action = ?'); args.push(action); }
  if (userId) { where.push('a.UserID = ?'); args.push(userId); }
  if (from) { where.push('date(a.CreatedAt) >= date(?)'); args.push(from); }
  if (to) { where.push('date(a.CreatedAt) <= date(?)'); args.push(to); }
  if (search) {
    where.push('(a.Details LIKE ? OR a.EntityType LIKE ? OR u.UserName LIKE ?)');
    const q = `%${search}%`; args.push(q, q, q);
  }
  const whereSql = where.join(' AND ');

  const total = db.prepare(
    `SELECT COUNT(*) AS c FROM AuditLog a LEFT JOIN Users u ON u.UserID = a.UserID WHERE ${whereSql}`
  ).get(...args).c;

  const rows = db.prepare(
    `SELECT a.*, u.UserName, u.FullName, b.BranchName
     FROM AuditLog a
     LEFT JOIN Users u ON u.UserID = a.UserID
     LEFT JOIN Branch b ON b.BranchID = a.BranchID
     WHERE ${whereSql}
     ORDER BY a.AuditID DESC LIMIT ? OFFSET ?`
  ).all(...args, pageSize, offset);

  res.json({ rows, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
});

// The distinct actions actually present, so the filter dropdown only ever
// offers values that will return something.
router.get('/audit/actions', (req, res) => {
  if (!AUDIT_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'You do not have access to the audit log' });
  }
  const rows = db.prepare(
    `SELECT DISTINCT Action FROM AuditLog WHERE CompanyID = ? ORDER BY Action`
  ).all(req.user.companyId);
  res.json(rows.map(r => r.Action));
});


// ---- FIN-05: period locks ----
// Once a month is reconciled and filed, locking it stops anyone back-dating a
// document into it. A lock is per module (or 'All'); unlocking is an audited act.
const LOCK_MODULES = ['Sales', 'Purchase', 'Inventory', 'Accounts', 'Payroll', 'All'];
router.get('/period-locks', (req, res) => {
  res.json(db.prepare('SELECT * FROM PeriodLock WHERE CompanyID = ? ORDER BY Period DESC, Module').all(req.user.companyId));
});
router.post('/period-locks', requireRole('Super Admin', 'Company Admin', 'Accountant'), (req, res) => {
  const { period, module } = req.body || {};
  if (!/^\d{4}-\d{2}$/.test(period || '')) return res.status(400).json({ error: 'period must be YYYY-MM' });
  const mod = module || 'All';
  if (!LOCK_MODULES.includes(mod)) return res.status(400).json({ error: `module must be one of ${LOCK_MODULES.join(', ')}` });
  try {
    db.prepare('INSERT INTO PeriodLock (CompanyID, Period, Module, LockedBy, LockedAt) VALUES (?,?,?,?,datetime(\'now\'))')
      .run(req.user.companyId, period, mod, req.user.userId);
  } catch (e) { return res.status(400).json({ error: /UNIQUE/.test(e.message) ? 'That period and module is already locked' : e.message }); }
  logAudit({ companyId: req.user.companyId, userId: req.user.userId, action: 'LOCK_PERIOD', entityType: 'PeriodLock', details: `${period} ${mod}`, ip: req.ip });
  res.status(201).json({ success: true });
});
router.delete('/period-locks/:id', requireRole('Super Admin', 'Company Admin'), (req, res) => {
  const row = db.prepare('SELECT * FROM PeriodLock WHERE LockID = ? AND CompanyID = ?').get(req.params.id, req.user.companyId);
  if (!row) return res.status(404).json({ error: 'Lock not found' });
  db.prepare('DELETE FROM PeriodLock WHERE LockID = ? AND CompanyID = ?').run(req.params.id, req.user.companyId);
  logAudit({ companyId: req.user.companyId, userId: req.user.userId, action: 'UNLOCK_PERIOD', entityType: 'PeriodLock', details: `${row.Period} ${row.Module}`, ip: req.ip });
  res.json({ success: true });
});

module.exports = router;
