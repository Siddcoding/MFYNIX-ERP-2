const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { requireAuth, resolveBranchScope } = require('../middleware/auth');
const { logAudit } = require('./auth');
const { postJournalEntry } = require('./accounts');
const { readPaging, pagedResult } = require('../services/paging');

const router = express.Router();
router.use(requireAuth);

const BANK_ROLES = ['Super Admin', 'Company Admin', 'Accountant', 'Auditor'];
router.use((req, res, next) => {
  if (!BANK_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'You do not have access to Banking' });
  }
  next();
});
function requireWriteRights(req, res, next) {
  if (['Auditor', 'Read Only'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Your role is read-only' });
  }
  next();
}

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

// ---------------- Bank accounts ----------------

router.get('/accounts', (req, res) => {
  const rows = db.prepare(
    `SELECT ba.*, b.BranchName, a.AccountCode, a.AccountName AS LedgerAccountName,
            (SELECT COUNT(*) FROM BankStatementLine s WHERE s.BankAccountID = ba.BankAccountID) AS StatementLines,
            (SELECT COUNT(*) FROM BankStatementLine s WHERE s.BankAccountID = ba.BankAccountID AND s.Status = 'Unmatched') AS Unmatched
     FROM BankAccount ba
     LEFT JOIN Branch b ON b.BranchID = ba.BranchID
     LEFT JOIN ChartOfAccounts a ON a.AccountID = ba.LedgerAccountID
     WHERE ba.CompanyID = ? AND ba.IsActive = 1 ORDER BY ba.AccountName`
  ).all(req.user.companyId);
  res.json(rows);
});

router.post('/accounts', requireWriteRights, (req, res) => {
  const { accountName, bankName, accountNo, ifsc, branchId, ledgerAccountId, openingBalance } = req.body;
  if (!accountName) return res.status(400).json({ error: 'accountName is required' });

  // Every bank account has to point at a Chart of Accounts head, or a matched
  // statement line would have nowhere to post. Default to the standard Bank account.
  const ledger = ledgerAccountId
    ? db.prepare('SELECT AccountID FROM ChartOfAccounts WHERE AccountID = ? AND CompanyID = ?').get(ledgerAccountId, req.user.companyId)
    : db.prepare("SELECT AccountID FROM ChartOfAccounts WHERE CompanyID = ? AND AccountCode = '1010'").get(req.user.companyId);
  if (!ledger) return res.status(400).json({ error: 'Pick a valid ledger account for this bank account' });

  const id = db.prepare(
    `INSERT INTO BankAccount (CompanyID, BranchID, AccountName, BankName, AccountNo, IFSC, LedgerAccountID, OpeningBalance)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(req.user.companyId, branchId || req.user.branchId || null, accountName, bankName || null,
        accountNo || null, ifsc || null, ledger.AccountID, Number(openingBalance || 0)).lastInsertRowid;

  logAudit({ companyId: req.user.companyId, branchId: req.user.branchId, userId: req.user.userId,
    action: 'CREATE_BANK_ACCOUNT', entityType: 'BankAccount', entityId: id, details: accountName, ip: req.ip });
  res.status(201).json({ bankAccountId: id });
});

// ---------------- Statement import ----------------
//
// Bank CSV layouts differ by bank, so rather than hard-coding one format the
// caller says which column is which. The UI reads the header row and lets the
// user map it, which means any bank works without a code change.
//
// body: { bankAccountId, rows: [ [..], [..] ], mapping: { date, description, ref, debit, credit, balance },
//         hasHeader, dateFormat }
const DATE_FORMATS = {
  'DD/MM/YYYY': s => { const m = s.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/); return m && `${pad4(m[3])}-${pad(m[2])}-${pad(m[1])}`; },
  'MM/DD/YYYY': s => { const m = s.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/); return m && `${pad4(m[3])}-${pad(m[1])}-${pad(m[2])}`; },
  'YYYY-MM-DD': s => { const m = s.match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/); return m && `${m[1]}-${pad(m[2])}-${pad(m[3])}`; }
};
function pad(n) { return String(n).padStart(2, '0'); }
function pad4(y) { const s = String(y); return s.length === 2 ? (Number(s) > 70 ? '19' + s : '20' + s) : s; }

function parseAmount(v) {
  if (v === undefined || v === null) return 0;
  // Indian statements use 1,23,456.78 and sometimes trailing Cr/Dr markers.
  const cleaned = String(v).replace(/[,\s₹]/g, '').replace(/(cr|dr)$/i, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.abs(n) : 0;
}

router.get('/date-formats', (req, res) => res.json(Object.keys(DATE_FORMATS)));

router.post('/import', requireWriteRights, (req, res) => {
  const { bankAccountId, rows, mapping, hasHeader, dateFormat } = req.body;
  const account = db.prepare('SELECT * FROM BankAccount WHERE BankAccountID = ? AND CompanyID = ?')
    .get(bankAccountId, req.user.companyId);
  if (!account) return res.status(404).json({ error: 'Bank account not found' });
  if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: 'No rows to import' });
  if (!mapping || mapping.date === undefined || mapping.date === null) {
    return res.status(400).json({ error: 'Tell the importer which column holds the date' });
  }
  if (mapping.debit === undefined && mapping.credit === undefined && mapping.amount === undefined) {
    return res.status(400).json({ error: 'Map at least a debit, credit or amount column' });
  }
  const parseDate = DATE_FORMATS[dateFormat] || DATE_FORMATS['DD/MM/YYYY'];

  const batch = crypto.randomBytes(6).toString('hex');
  const dataRows = hasHeader ? rows.slice(1) : rows;

  const tx = db.transaction(() => {
    const insert = db.prepare(
      `INSERT OR IGNORE INTO BankStatementLine
         (CompanyID, BankAccountID, TxnDate, Description, RefNo, Debit, Credit, RunningBalance, ImportBatch, RowHash)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    );
    let imported = 0, skipped = 0, duplicates = 0;
    const problems = [];

    dataRows.forEach((row, i) => {
      const rawDate = row[mapping.date];
      const isoDate = rawDate ? parseDate(String(rawDate)) : null;
      if (!isoDate) {
        skipped++;
        if (problems.length < 5) problems.push(`Row ${i + (hasHeader ? 2 : 1)}: could not read the date "${rawDate}"`);
        return;
      }

      let debit = 0, credit = 0;
      if (mapping.amount !== undefined && mapping.amount !== null) {
        // A single signed amount column: negative is money out.
        const raw = String(row[mapping.amount] ?? '').replace(/[,\s₹]/g, '');
        const n = Number(raw);
        if (!Number.isFinite(n)) { skipped++; return; }
        if (n < 0) debit = Math.abs(n); else credit = n;
      } else {
        debit = parseAmount(row[mapping.debit]);
        credit = parseAmount(row[mapping.credit]);
      }
      if (debit === 0 && credit === 0) { skipped++; return; }

      const description = mapping.description !== undefined ? String(row[mapping.description] ?? '') : '';
      const refNo = mapping.ref !== undefined ? String(row[mapping.ref] ?? '') : '';
      const balance = mapping.balance !== undefined ? parseAmount(row[mapping.balance]) : null;

      // Re-importing the same statement is a normal accident. Hashing the row
      // means it is silently ignored the second time rather than doubling up.
      const hash = crypto.createHash('sha256')
        .update([isoDate, description, refNo, debit, credit].join('|')).digest('hex');

      const r = insert.run(req.user.companyId, account.BankAccountID, isoDate, description, refNo,
                           debit, credit, balance, batch, hash);
      if (r.changes === 0) duplicates++; else imported++;
    });

    logAudit({ companyId: req.user.companyId, branchId: req.user.branchId, userId: req.user.userId,
      action: 'IMPORT_BANK_STATEMENT', entityType: 'BankAccount', entityId: account.BankAccountID,
      details: `${imported} imported, ${duplicates} duplicates, ${skipped} unreadable`, ip: req.ip });

    return { imported, duplicates, skipped, problems, batch };
  });

  try {
    res.status(201).json(tx());
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------------- Statement lines + suggested matches ----------------

router.get('/statement/:bankAccountId', (req, res) => {
  const { page, pageSize, offset } = readPaging(req.query, { defaultPageSize: 50 });
  const status = req.query.status;
  const where = ['s.CompanyID = ?', 's.BankAccountID = ?'];
  const args = [req.user.companyId, req.params.bankAccountId];
  if (status) { where.push('s.Status = ?'); args.push(status); }
  const whereSql = where.join(' AND ');

  const total = db.prepare(`SELECT COUNT(*) AS c FROM BankStatementLine s WHERE ${whereSql}`).get(...args).c;
  const rows = db.prepare(
    `SELECT s.*, j.Narration AS MatchedNarration FROM BankStatementLine s
     LEFT JOIN JournalEntry j ON j.JournalID = s.MatchedJournalID
     WHERE ${whereSql} ORDER BY date(s.TxnDate) DESC, s.StatementLineID DESC LIMIT ? OFFSET ?`
  ).all(...args, pageSize, offset);
  res.json(pagedResult(rows, total, { page, pageSize }));
});

/**
 * Suggests journal entries that could be this statement line.
 *
 * Deliberately conservative: same bank ledger account, same side, same amount,
 * within a few days. It suggests, it never auto-matches — an ERP that silently
 * decides which invoice a payment belongs to causes worse problems than it
 * solves, so a person always confirms.
 */
router.get('/statement/line/:id/suggestions', (req, res) => {
  const line = db.prepare(
    `SELECT s.*, ba.LedgerAccountID FROM BankStatementLine s
     JOIN BankAccount ba ON ba.BankAccountID = s.BankAccountID
     WHERE s.StatementLineID = ? AND s.CompanyID = ?`
  ).get(req.params.id, req.user.companyId);
  if (!line) return res.status(404).json({ error: 'Statement line not found' });

  const window = Number(req.query.days) || 7;
  // Money INTO the bank is a debit to the bank ledger, and vice versa.
  const wantDebit = line.Credit > 0;
  const amount = line.Credit > 0 ? line.Credit : line.Debit;

  const rows = db.prepare(
    `SELECT j.JournalID, j.EntryDate, j.Narration, j.SourceType, jl.Debit, jl.Credit, b.BranchName
     FROM JournalEntry j
     JOIN JournalLine jl ON jl.JournalID = j.JournalID
     JOIN Branch b ON b.BranchID = j.BranchID
     WHERE j.CompanyID = ? AND jl.AccountID = ?
       AND ${wantDebit ? 'jl.Debit' : 'jl.Credit'} BETWEEN ? AND ?
       AND ABS(julianday(j.EntryDate) - julianday(?)) <= ?
       AND j.JournalID NOT IN (SELECT MatchedJournalID FROM BankStatementLine WHERE MatchedJournalID IS NOT NULL)
     ORDER BY ABS(julianday(j.EntryDate) - julianday(?))
     LIMIT 10`
  ).all(req.user.companyId, line.LedgerAccountID, amount - 0.01, amount + 0.01,
        line.TxnDate, window, line.TxnDate);

  res.json({ line, suggestions: rows });
});

// ---------------- Reconciliation actions ----------------

router.post('/statement/line/:id/match', requireWriteRights, (req, res) => {
  const { journalId } = req.body;
  const line = db.prepare('SELECT * FROM BankStatementLine WHERE StatementLineID = ? AND CompanyID = ?')
    .get(req.params.id, req.user.companyId);
  if (!line) return res.status(404).json({ error: 'Statement line not found' });
  if (line.Status === 'Matched') return res.status(409).json({ error: 'That line is already matched' });

  const journal = db.prepare('SELECT * FROM JournalEntry WHERE JournalID = ? AND CompanyID = ?')
    .get(journalId, req.user.companyId);
  if (!journal) return res.status(404).json({ error: 'Journal entry not found' });

  const alreadyUsed = db.prepare('SELECT StatementLineID FROM BankStatementLine WHERE MatchedJournalID = ?').get(journalId);
  if (alreadyUsed) return res.status(409).json({ error: 'That journal entry is already matched to another statement line' });

  db.prepare(`UPDATE BankStatementLine SET Status='Matched', MatchedJournalID=?, MatchedBy=?, MatchedAt=datetime('now') WHERE StatementLineID=?`)
    .run(journalId, req.user.userId, line.StatementLineID);
  logAudit({ companyId: req.user.companyId, branchId: req.user.branchId, userId: req.user.userId,
    action: 'MATCH_BANK_LINE', entityType: 'BankStatementLine', entityId: line.StatementLineID,
    details: `matched to journal #${journalId}`, ip: req.ip });
  res.json({ success: true });
});

router.post('/statement/line/:id/unmatch', requireWriteRights, (req, res) => {
  const line = db.prepare('SELECT * FROM BankStatementLine WHERE StatementLineID = ? AND CompanyID = ?')
    .get(req.params.id, req.user.companyId);
  if (!line) return res.status(404).json({ error: 'Statement line not found' });
  db.prepare(`UPDATE BankStatementLine SET Status='Unmatched', MatchedJournalID=NULL, MatchedBy=NULL, MatchedAt=NULL WHERE StatementLineID=?`)
    .run(line.StatementLineID);
  res.json({ success: true });
});

/**
 * Creates the missing journal entry for a statement line and matches it.
 * This is how bank charges, interest and direct debits get into the books —
 * they only ever appear on the statement, never from a voucher someone typed.
 */
router.post('/statement/line/:id/post', requireWriteRights, (req, res) => {
  const { contraAccountId, narration, branchId: bodyBranch } = req.body;
  const line = db.prepare(
    `SELECT s.*, ba.LedgerAccountID, ba.BranchID AS BankBranchID FROM BankStatementLine s
     JOIN BankAccount ba ON ba.BankAccountID = s.BankAccountID
     WHERE s.StatementLineID = ? AND s.CompanyID = ?`
  ).get(req.params.id, req.user.companyId);
  if (!line) return res.status(404).json({ error: 'Statement line not found' });
  if (line.Status === 'Matched') return res.status(409).json({ error: 'That line is already matched' });

  const contra = db.prepare('SELECT * FROM ChartOfAccounts WHERE AccountID = ? AND CompanyID = ?')
    .get(contraAccountId, req.user.companyId);
  if (!contra) return res.status(400).json({ error: 'Pick the account this belongs to' });
  if (contra.AccountID === line.LedgerAccountID) {
    return res.status(400).json({ error: 'The other side cannot be the bank account itself' });
  }

  // A bank account can legitimately be company-wide (no branch), and a
  // head-office user has no branch of their own - so fall back to the head
  // office branch rather than refusing to post. Without this, bank charges on
  // a company-wide account could never be entered at all.
  const headOffice = db.prepare(
    'SELECT BranchID FROM Branch WHERE CompanyID = ? AND IsHeadOffice = 1 AND IsActive = 1'
  ).get(req.user.companyId);
  const branchId = req.user.branchId || bodyBranch || line.BankBranchID || (headOffice && headOffice.BranchID);
  if (!branchId) {
    return res.status(400).json({ error: 'This company has no head-office branch to post against — set one on the Branches screen.' });
  }

  const amount = line.Credit > 0 ? line.Credit : line.Debit;
  const lines = line.Credit > 0
    ? [{ accountId: line.LedgerAccountID, debit: amount, credit: 0 }, { accountId: contra.AccountID, debit: 0, credit: amount }]
    : [{ accountId: contra.AccountID, debit: amount, credit: 0 }, { accountId: line.LedgerAccountID, debit: 0, credit: amount }];

  const tx = db.transaction(() => {
    const journalId = postJournalEntry(db, {
      companyId: req.user.companyId, branchId, entryDate: line.TxnDate,
      narration: narration || line.Description || 'Bank statement entry',
      sourceType: 'BankStatement', sourceId: line.StatementLineID,
      createdBy: req.user.userId, lines
    });
    db.prepare(`UPDATE BankStatementLine SET Status='Matched', MatchedJournalID=?, MatchedBy=?, MatchedAt=datetime('now') WHERE StatementLineID=?`)
      .run(journalId, req.user.userId, line.StatementLineID);
    return journalId;
  });

  try {
    const journalId = tx();
    logAudit({ companyId: req.user.companyId, branchId, userId: req.user.userId,
      action: 'POST_BANK_LINE', entityType: 'BankStatementLine', entityId: line.StatementLineID,
      details: `posted to ${contra.AccountName}`, ip: req.ip });
    res.status(201).json({ journalId });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/statement/line/:id/ignore', requireWriteRights, (req, res) => {
  const line = db.prepare('SELECT * FROM BankStatementLine WHERE StatementLineID = ? AND CompanyID = ?')
    .get(req.params.id, req.user.companyId);
  if (!line) return res.status(404).json({ error: 'Statement line not found' });
  db.prepare(`UPDATE BankStatementLine SET Status='Ignored' WHERE StatementLineID=?`).run(line.StatementLineID);
  res.json({ success: true });
});

// ---------------- Reconciliation summary ----------------
//
// The number that matters: what the bank says the balance is, versus what the
// books say, and exactly which items explain the gap.
router.get('/reconciliation/:bankAccountId', (req, res) => {
  const account = db.prepare('SELECT * FROM BankAccount WHERE BankAccountID = ? AND CompanyID = ?')
    .get(req.params.bankAccountId, req.user.companyId);
  if (!account) return res.status(404).json({ error: 'Bank account not found' });
  const asOn = req.query.asOn || new Date().toISOString().slice(0, 10);

  const stmt = db.prepare(
    `SELECT COALESCE(SUM(Credit),0) - COALESCE(SUM(Debit),0) AS net, COUNT(*) AS lines
     FROM BankStatementLine WHERE BankAccountID = ? AND Status != 'Ignored' AND date(TxnDate) <= date(?)`
  ).get(account.BankAccountID, asOn);

  const book = db.prepare(
    `SELECT COALESCE(SUM(jl.Debit),0) - COALESCE(SUM(jl.Credit),0) AS net
     FROM JournalLine jl JOIN JournalEntry j ON j.JournalID = jl.JournalID
     WHERE j.CompanyID = ? AND jl.AccountID = ? AND date(j.EntryDate) <= date(?)`
  ).get(req.user.companyId, account.LedgerAccountID, asOn);

  const unmatched = db.prepare(
    `SELECT * FROM BankStatementLine WHERE BankAccountID = ? AND Status = 'Unmatched' AND date(TxnDate) <= date(?)
     ORDER BY date(TxnDate)`
  ).all(account.BankAccountID, asOn);

  const statementBalance = round2(account.OpeningBalance + stmt.net);
  const bookBalance = round2(account.OpeningBalance + book.net);

  res.json({
    account, asOn,
    statementBalance, bookBalance,
    difference: round2(statementBalance - bookBalance),
    reconciled: Math.abs(statementBalance - bookBalance) < 0.01,
    statementLines: stmt.lines,
    unmatchedCount: unmatched.length,
    unmatchedValue: round2(unmatched.reduce((s, l) => s + (l.Credit - l.Debit), 0)),
    unmatched
  });
});

module.exports = router;
