const express = require('express');
const db = require('../db');
const { requireAuth, requireRole, resolveBranchScope } = require('../middleware/auth');
const { logAudit } = require('./auth');

const router = express.Router();
router.use(requireAuth);
const { assertPeriodOpen, reverseJournal } = require('../services/posting');

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

// Roles allowed to touch accounting data at all. Everyone else (Sales
// Executive, Store Manager, Cashier, etc.) never sees this module.
const ACCOUNTS_ROLES = ['Super Admin', 'Company Admin', 'Accountant', 'Auditor'];
function requireAccountsAccess(req, res, next) {
  if (!ACCOUNTS_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'You do not have access to Accounts' });
  }
  next();
}
router.use(requireAccountsAccess);

// Auditors can see everything here but never post or edit - read-only role.
function requirePostingRights(req, res, next) {
  if (req.user.role === 'Auditor') {
    return res.status(403).json({ error: 'Auditor access is read-only' });
  }
  next();
}

/**
 * Posts a balanced journal entry inside the CALLER's transaction. Used both
 * by the manual journal route below and by Sales/Purchase auto-posting
 * (see routes/sales.js, routes/purchase.js). Throws if debits != credits -
 * callers should let that abort their surrounding transaction, so a sales
 * invoice can never exist without its accounting entry balancing.
 */
function postJournalEntry(db, { companyId, branchId, entryDate, narration, sourceType = 'Manual', sourceId = null, createdBy, lines, partyType = null, partyId = null, refNo = null, voucherNo = null, bankAccountId = null }) {
  const totalDebit = lines.reduce((s, l) => s + (l.debit || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (l.credit || 0), 0);
  if (Math.abs(totalDebit - totalCredit) > 0.005) {
    throw new Error(`Journal entry does not balance: debit ${totalDebit.toFixed(2)} vs credit ${totalCredit.toFixed(2)}`);
  }
  if (lines.length < 2) {
    throw new Error('A journal entry needs at least two lines');
  }

  const header = db.prepare(
    `INSERT INTO JournalEntry (CompanyID, BranchID, EntryDate, Narration, SourceType, SourceID, CreatedBy, PartyType, PartyID, RefNo, VoucherNo, BankAccountID)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(companyId, branchId, entryDate, narration || null, sourceType, sourceId, createdBy, partyType, partyId, refNo, voucherNo, bankAccountId);
  const journalId = header.lastInsertRowid;

  const insertLine = db.prepare(`INSERT INTO JournalLine (JournalID, AccountID, Debit, Credit) VALUES (?,?,?,?)`);
  lines.forEach(l => insertLine.run(journalId, l.accountId, l.debit || 0, l.credit || 0));

  return journalId;
}

// ---- Chart of Accounts ----

router.get('/accounts', (req, res) => {
  const rows = db.prepare(
    `SELECT * FROM ChartOfAccounts WHERE CompanyID = ? AND IsActive = 1 ORDER BY AccountCode`
  ).all(req.user.companyId);
  res.json(rows);
});

router.post('/accounts', requirePostingRights, (req, res) => {
  const { accountCode, accountName, accountType } = req.body;
  const validTypes = ['Asset', 'Liability', 'Equity', 'Income', 'Expense'];
  if (!accountCode || !accountName || !validTypes.includes(accountType)) {
    return res.status(400).json({ error: `accountCode, accountName and a valid accountType (${validTypes.join('/')}) are required` });
  }
  try {
    const result = db.prepare(
      `INSERT INTO ChartOfAccounts (CompanyID, AccountCode, AccountName, AccountType) VALUES (?,?,?,?)`
    ).run(req.user.companyId, accountCode, accountName, accountType);
    logAudit({ companyId: req.user.companyId, branchId: req.user.branchId, userId: req.user.userId, action: 'CREATE_ACCOUNT', entityType: 'ChartOfAccounts', entityId: result.lastInsertRowid, ip: req.ip });
    res.status(201).json({ accountId: result.lastInsertRowid });
  } catch (e) {
    if (String(e).includes('UNIQUE')) return res.status(409).json({ error: 'An account with that code already exists' });
    res.status(500).json({ error: 'Failed to create account' });
  }
});

router.put('/accounts/:id', requirePostingRights, (req, res) => {
  const acc = db.prepare('SELECT * FROM ChartOfAccounts WHERE AccountID = ? AND CompanyID = ?').get(req.params.id, req.user.companyId);
  if (!acc) return res.status(404).json({ error: 'Account not found' });
  const fields = ['AccountName', 'GroupName', 'SubGroup'];
  // The type and code of a system account are fixed; only its presentation group may change.
  if (!acc.IsSystem && req.body.AccountType) fields.push('AccountType');
  const cols = fields.filter(f => req.body[f] !== undefined);
  if (!cols.length) return res.status(400).json({ error: 'Nothing to update' });
  db.prepare(`UPDATE ChartOfAccounts SET ${cols.map(c => c + ' = ?').join(', ')} WHERE AccountID = ? AND CompanyID = ?`)
    .run(...cols.map(c => req.body[c]), req.params.id, req.user.companyId);
  logAudit({ companyId: req.user.companyId, userId: req.user.userId, action: 'UPDATE_ACCOUNT', entityType: 'ChartOfAccounts', entityId: req.params.id,
    details: cols.map(c => `${c}=${req.body[c]}`).join('; '), ip: req.ip });
  res.json({ success: true });
});

router.delete('/accounts/:id', requirePostingRights, (req, res) => {
  const acc = db.prepare('SELECT * FROM ChartOfAccounts WHERE AccountID = ? AND CompanyID = ?').get(req.params.id, req.user.companyId);
  if (!acc) return res.status(404).json({ error: 'Account not found' });
  if (acc.IsSystem) return res.status(400).json({ error: 'This account is used by automatic posting and cannot be removed' });
  const used = db.prepare('SELECT COUNT(*) AS c FROM JournalLine WHERE AccountID = ?').get(req.params.id).c;
  if (used > 0) return res.status(400).json({ error: 'This account has journal entries posted to it and cannot be removed' });
  db.prepare('UPDATE ChartOfAccounts SET IsActive = 0 WHERE AccountID = ?').run(req.params.id);
  res.json({ success: true });
});

// ---- Manual Journal Entry ----
// body: { entryDate, narration, branchId (HO users only), lines: [{accountId, debit, credit}] }
router.post('/journal', requirePostingRights, (req, res) => {
  const branchId = req.user.branchId || req.body.branchId;
  if (!branchId) return res.status(400).json({ error: 'branchId is required (head-office users must specify one)' });

  const { entryDate, narration, lines } = req.body;
  if (!entryDate || !Array.isArray(lines) || lines.length < 2) {
    return res.status(400).json({ error: 'entryDate and at least two journal lines are required' });
  }
  for (const l of lines) {
    if (!l.accountId || ((l.debit || 0) > 0 && (l.credit || 0) > 0)) {
      return res.status(400).json({ error: 'Each line needs an account and only one of debit or credit, not both' });
    }
  }

  const tx = db.transaction(() => {
    assertPeriodOpen(req.user.companyId, 'Accounts', entryDate);
    return postJournalEntry(db, {
      companyId: req.user.companyId, branchId, entryDate, narration,
      sourceType: req.body.sourceType || 'Manual', createdBy: req.user.userId, lines,
      refNo: req.body.refNo, voucherNo: req.body.voucherNo, partyType: req.body.partyType, partyId: req.body.partyId
    });
  });

  try {
    const journalId = tx();
    logAudit({ companyId: req.user.companyId, branchId, userId: req.user.userId, action: 'CREATE_JOURNAL_ENTRY', entityType: 'JournalEntry', entityId: journalId, ip: req.ip });
    res.status(201).json({ journalId });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/journal', (req, res) => {
  const branchId = resolveBranchScope(req);
  const args = branchId ? [req.user.companyId, branchId] : [req.user.companyId];
  const headers = db.prepare(
    `SELECT j.*, b.BranchName FROM JournalEntry j JOIN Branch b ON b.BranchID = j.BranchID
     WHERE j.CompanyID = ? ${branchId ? 'AND j.BranchID = ?' : ''}
     ORDER BY j.JournalID DESC LIMIT 100`
  ).all(...args);

  const lineStmt = db.prepare(
    `SELECT jl.*, a.AccountCode, a.AccountName FROM JournalLine jl
     JOIN ChartOfAccounts a ON a.AccountID = jl.AccountID WHERE jl.JournalID = ?`
  );
  const withLines = headers.map(h => ({ ...h, lines: lineStmt.all(h.JournalID) }));
  res.json(withLines);
});

// ---- Ledger: all postings to one account, with running balance ----
router.get('/ledger/:accountId', (req, res) => {
  const account = db.prepare('SELECT * FROM ChartOfAccounts WHERE AccountID = ? AND CompanyID = ?').get(req.params.accountId, req.user.companyId);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const branchId = resolveBranchScope(req);
  const args = branchId ? [req.params.accountId, req.user.companyId, branchId] : [req.params.accountId, req.user.companyId];
  const rows = db.prepare(
    `SELECT jl.Debit, jl.Credit, j.EntryDate, j.Narration, j.SourceType, j.JournalID
     FROM JournalLine jl JOIN JournalEntry j ON j.JournalID = jl.JournalID
     WHERE jl.AccountID = ? AND j.CompanyID = ? ${branchId ? 'AND j.BranchID = ?' : ''}
     ORDER BY j.EntryDate, j.JournalID`
  ).all(...args);

  // Debit-normal accounts (Asset, Expense) increase with debit; others (Liability, Equity, Income) increase with credit.
  const debitNormal = ['Asset', 'Expense'].includes(account.AccountType);
  let balance = 0;
  const withBalance = rows.map(r => {
    balance += debitNormal ? (r.Debit - r.Credit) : (r.Credit - r.Debit);
    return { ...r, runningBalance: balance };
  });

  res.json({ account, entries: withBalance, closingBalance: balance });
});

// ---- Trial Balance: every account's net debit/credit as of now ----
router.get('/trial-balance', (req, res) => {
  const branchId = resolveBranchScope(req);
  // FIN-01: a trial balance can be struck as on any date, or between two dates.
  const { from, to, asOn } = req.query;
  const dateSql = [];
  const dateArgs = [];
  if (from) { dateSql.push('date(j.EntryDate) >= date(?)'); dateArgs.push(from); }
  if (to || asOn) { dateSql.push('date(j.EntryDate) <= date(?)'); dateArgs.push(to || asOn); }
  const jFilter = `j.CompanyID = ? ${branchId ? 'AND j.BranchID = ?' : ''}${dateSql.length ? ' AND ' + dateSql.join(' AND ') : ''}`;
  const jArgs = branchId ? [req.user.companyId, branchId, ...dateArgs] : [req.user.companyId, ...dateArgs];
  const rows = db.prepare(
    `SELECT a.AccountID, a.AccountCode, a.AccountName, a.AccountType,
            COALESCE(SUM(jl.Debit),0) AS TotalDebit, COALESCE(SUM(jl.Credit),0) AS TotalCredit
     FROM ChartOfAccounts a
     LEFT JOIN JournalLine jl ON jl.AccountID = a.AccountID
     LEFT JOIN JournalEntry j ON j.JournalID = jl.JournalID AND ${jFilter}
     WHERE a.CompanyID = ? AND a.IsActive = 1
     GROUP BY a.AccountID
     HAVING TotalDebit != 0 OR TotalCredit != 0
     ORDER BY a.AccountCode`
  ).all(...jArgs, req.user.companyId);

  const result = rows.map(r => {
    // Trial balance columns are simple: whichever side (debit or credit) is
    // larger for that account, the difference is shown on that side - this
    // is independent of whether the account's "normal" balance is debit or
    // credit (that only matters for the ledger's running-balance direction).
    const net = r.TotalDebit - r.TotalCredit;
    return {
      ...r,
      Debit: Math.max(0, net),
      Credit: Math.max(0, -net)
    };
  });
  const totalDebit = result.reduce((s, r) => s + r.Debit, 0);
  const totalCredit = result.reduce((s, r) => s + r.Credit, 0);
  res.json({ accounts: result, totalDebit, totalCredit, balanced: Math.abs(totalDebit - totalCredit) < 0.01 });
});

// ---- Profit & Loss: Income vs Expense over a date range ----
router.get('/profit-loss', (req, res) => {
  const branchId = resolveBranchScope(req);
  const { from, to } = req.query;
  const dateFilter = (from && to) ? 'AND j.EntryDate BETWEEN ? AND ?' : '';
  const dateArgs = (from && to) ? [from, to] : [];
  const args = branchId
    ? [req.user.companyId, branchId, ...dateArgs]
    : [req.user.companyId, ...dateArgs];

  const rows = db.prepare(
    `SELECT a.AccountName, a.AccountType, COALESCE(SUM(jl.Debit),0) AS TotalDebit, COALESCE(SUM(jl.Credit),0) AS TotalCredit
     FROM ChartOfAccounts a
     JOIN JournalLine jl ON jl.AccountID = a.AccountID
     JOIN JournalEntry j ON j.JournalID = jl.JournalID
     WHERE a.CompanyID = ? AND a.AccountType IN ('Income','Expense')
       ${branchId ? 'AND j.BranchID = ?' : ''} ${dateFilter}
     GROUP BY a.AccountID`
  ).all(...args);

  const income = rows.filter(r => r.AccountType === 'Income').map(r => ({ name: r.AccountName, amount: r.TotalCredit - r.TotalDebit }));
  const expense = rows.filter(r => r.AccountType === 'Expense').map(r => ({ name: r.AccountName, amount: r.TotalDebit - r.TotalCredit }));
  const totalIncome = income.reduce((s, r) => s + r.amount, 0);
  const totalExpense = expense.reduce((s, r) => s + r.amount, 0);
  res.json({ income, expense, totalIncome, totalExpense, netProfit: totalIncome - totalExpense });
});

// ---- Balance Sheet: Assets vs Liabilities + Equity, as of now ----
router.get('/balance-sheet', (req, res) => {
  const branchId = resolveBranchScope(req);
  const asOn = req.query.asOn || req.query.to;     // FIN-01: balance sheet as on a date
  const dateSql = asOn ? 'AND date(j.EntryDate) <= date(?)' : '';
  const args = branchId
    ? [req.user.companyId, branchId, ...(asOn ? [asOn] : [])]
    : [req.user.companyId, ...(asOn ? [asOn] : [])];

  const rows = db.prepare(
    `SELECT a.AccountName, a.AccountType, COALESCE(SUM(jl.Debit),0) AS TotalDebit, COALESCE(SUM(jl.Credit),0) AS TotalCredit
     FROM ChartOfAccounts a
     JOIN JournalLine jl ON jl.AccountID = a.AccountID
     JOIN JournalEntry j ON j.JournalID = jl.JournalID
     WHERE a.CompanyID = ? AND a.AccountType IN ('Asset','Liability','Equity') ${branchId ? 'AND j.BranchID = ?' : ''} ${dateSql}
     GROUP BY a.AccountID`
  ).all(...args);

  // Retained earnings = net profit/loss to date, computed from Income/Expense
  // so the sheet balances even though P&L accounts don't carry a running
  // balance forward automatically.
  const incomeTotals = db.prepare(
    `SELECT COALESCE(SUM(jl.Credit),0) - COALESCE(SUM(jl.Debit),0) AS net FROM ChartOfAccounts a
     JOIN JournalLine jl ON jl.AccountID = a.AccountID JOIN JournalEntry j ON j.JournalID = jl.JournalID
     WHERE a.CompanyID = ? AND a.AccountType = 'Income' ${branchId ? 'AND j.BranchID = ?' : ''} ${dateSql}`
  ).get(...args).net;
  const expenseTotals = db.prepare(
    `SELECT COALESCE(SUM(jl.Debit),0) - COALESCE(SUM(jl.Credit),0) AS net FROM ChartOfAccounts a
     JOIN JournalLine jl ON jl.AccountID = a.AccountID JOIN JournalEntry j ON j.JournalID = jl.JournalID
     WHERE a.CompanyID = ? AND a.AccountType = 'Expense' ${branchId ? 'AND j.BranchID = ?' : ''} ${dateSql}`
  ).get(...args).net;
  const retainedEarnings = incomeTotals - expenseTotals;

  const assets = rows.filter(r => r.AccountType === 'Asset').map(r => ({ name: r.AccountName, amount: r.TotalDebit - r.TotalCredit }));
  const liabilities = rows.filter(r => r.AccountType === 'Liability').map(r => ({ name: r.AccountName, amount: r.TotalCredit - r.TotalDebit }));
  const equity = rows.filter(r => r.AccountType === 'Equity').map(r => ({ name: r.AccountName, amount: r.TotalCredit - r.TotalDebit }));
  equity.push({ name: 'Retained Earnings (current)', amount: retainedEarnings });

  const totalAssets = assets.reduce((s, r) => s + r.amount, 0);
  const totalLiabilities = liabilities.reduce((s, r) => s + r.amount, 0);
  const totalEquity = equity.reduce((s, r) => s + r.amount, 0);

  res.json({
    assets, liabilities, equity,
    totalAssets, totalLiabilities, totalEquity,
    balanced: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.01
  });
});

// ---- Payment / Receipt / Contra vouchers ----
//
// These are the entries a cashier or accountant makes every day, and typing
// them as raw journal lines is both slow and easy to get backwards. Each
// voucher below is still a normal double-entry JournalEntry underneath - the
// voucher form just picks the correct two accounts and the correct side, so
// the user never has to think about which one is debited.
//
//   Receipt : money IN   -> Dr Cash/Bank,  Cr Debtors (or another income/account)
//   Payment : money OUT  -> Dr Creditors (or an expense head), Cr Cash/Bank
//   Contra  : cash <-> bank, no profit or loss effect
const VOUCHER_TYPES = ['Receipt', 'Payment', 'Contra'];
const CASH_CODE = '1000';
const BANK_CODE = '1010';
const DEBTORS_CODE = '1100';
const CREDITORS_CODE = '2000';

function accountByCode(companyId, code) {
  const row = db.prepare('SELECT * FROM ChartOfAccounts WHERE CompanyID = ? AND AccountCode = ? AND IsActive = 1').get(companyId, code);
  if (!row) throw new Error(`Chart of Accounts is missing required account ${code}`);
  return row;
}

router.get('/voucher-options', (req, res) => {
  const accounts = db.prepare(
    `SELECT AccountID, AccountCode, AccountName, AccountType FROM ChartOfAccounts
     WHERE CompanyID = ? AND IsActive = 1 ORDER BY AccountCode`
  ).all(req.user.companyId);
  res.json({
    voucherTypes: VOUCHER_TYPES,
    // Anything that isn't cash/bank itself can be the "other side" of a voucher.
    accounts: accounts.filter(a => ![CASH_CODE, BANK_CODE].includes(a.AccountCode)),
    cashAndBank: accounts.filter(a => [CASH_CODE, BANK_CODE].includes(a.AccountCode))
  });
});

// POST /accounts/voucher
// { voucherType, entryDate, mode: 'Cash'|'Bank', amount, againstAccountId?, narration, branchId?,
//   contraDirection?: 'CashToBank'|'BankToCash' }
router.post('/voucher', requirePostingRights, (req, res) => {
  const branchId = req.user.branchId || req.body.branchId;
  if (!branchId) return res.status(400).json({ error: 'branchId is required (head-office users must specify one)' });

  const { voucherType, entryDate, mode, amount, againstAccountId, narration, contraDirection } = req.body;
  if (!VOUCHER_TYPES.includes(voucherType)) {
    return res.status(400).json({ error: `voucherType must be one of ${VOUCHER_TYPES.join('/')}` });
  }
  if (!entryDate) return res.status(400).json({ error: 'entryDate is required' });

  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) {
    return res.status(400).json({ error: 'amount must be greater than zero' });
  }

  let lines, autoNarration;
  try {
    if (voucherType === 'Contra') {
      if (!['CashToBank', 'BankToCash'].includes(contraDirection)) {
        return res.status(400).json({ error: "contraDirection must be 'CashToBank' or 'BankToCash'" });
      }
      const cash = accountByCode(req.user.companyId, CASH_CODE);
      const bank = accountByCode(req.user.companyId, BANK_CODE);
      const toBank = contraDirection === 'CashToBank';
      lines = [
        { accountId: toBank ? bank.AccountID : cash.AccountID, debit: value, credit: 0 },
        { accountId: toBank ? cash.AccountID : bank.AccountID, debit: 0, credit: value }
      ];
      autoNarration = toBank ? 'Cash deposited into bank' : 'Cash withdrawn from bank';
    } else {
      if (!['Cash', 'Bank'].includes(mode)) {
        return res.status(400).json({ error: "mode must be 'Cash' or 'Bank'" });
      }
      const money = accountByCode(req.user.companyId, mode === 'Cash' ? CASH_CODE : BANK_CODE);

      // Default the other side to the control account the voucher usually hits,
      // so the common case needs no account picking at all.
      const other = againstAccountId
        ? db.prepare('SELECT * FROM ChartOfAccounts WHERE AccountID = ? AND CompanyID = ? AND IsActive = 1').get(againstAccountId, req.user.companyId)
        : accountByCode(req.user.companyId, voucherType === 'Receipt' ? DEBTORS_CODE : CREDITORS_CODE);
      if (!other) return res.status(404).json({ error: 'The account you selected was not found' });
      if ([CASH_CODE, BANK_CODE].includes(other.AccountCode)) {
        return res.status(400).json({ error: 'For a cash-to-bank movement use a Contra voucher, not a Receipt or Payment' });
      }

      if (voucherType === 'Receipt') {
        lines = [
          { accountId: money.AccountID, debit: value, credit: 0 },
          { accountId: other.AccountID, debit: 0, credit: value }
        ];
        autoNarration = `Received into ${mode} against ${other.AccountName}`;
      } else {
        lines = [
          { accountId: other.AccountID, debit: value, credit: 0 },
          { accountId: money.AccountID, debit: 0, credit: value }
        ];
        autoNarration = `Paid from ${mode} towards ${other.AccountName}`;
      }
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  const tx = db.transaction(() => postJournalEntry(db, {
    companyId: req.user.companyId, branchId, entryDate,
    narration: narration || autoNarration,
    sourceType: voucherType, createdBy: req.user.userId, lines
  }));

  try {
    const journalId = tx();
    logAudit({
      companyId: req.user.companyId, branchId, userId: req.user.userId,
      action: `CREATE_${voucherType.toUpperCase()}_VOUCHER`, entityType: 'JournalEntry', entityId: journalId,
      details: `${voucherType} ${value}`, ip: req.ip
    });
    res.status(201).json({ journalId, voucherType, amount: value, narration: narration || autoNarration });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});


// ---------------- Receipt / Payment WITH allocation, in one step ----------------
//
// The two-step version (post a voucher, then go to Outstanding and settle) was
// the most-repeated bit of daily friction in the system: the money and the
// invoices it pays are one real-world event, so they should be one save. This
// endpoint posts the journal AND the allocations inside a single transaction -
// if the allocation is invalid, the money is not posted either, and the books
// can never show a receipt that settles nothing.
//
// body: { voucherType: 'Receipt'|'Payment', entryDate, mode: 'Cash'|'Bank',
//         partyType, partyId, amount, narration, branchId?,
//         allocations: [{ docType, docId, amount }] }
router.post('/settle', requirePostingRights, (req, res) => {
  const branchId = req.user.branchId || req.body.branchId;
  if (!branchId) return res.status(400).json({ error: 'branchId is required (head-office users must specify one)' });

  const { voucherType, entryDate, mode, partyType, partyId, narration, allocations } = req.body;
  if (!['Receipt', 'Payment'].includes(voucherType)) {
    return res.status(400).json({ error: "voucherType must be 'Receipt' or 'Payment'" });
  }
  if (!['Cash', 'Bank'].includes(mode)) return res.status(400).json({ error: "mode must be 'Cash' or 'Bank'" });
  if (!entryDate) return res.status(400).json({ error: 'entryDate is required' });
  const expectedParty = voucherType === 'Receipt' ? 'Customer' : 'Supplier';
  if (partyType !== expectedParty) {
    return res.status(400).json({ error: `A ${voucherType} is against a ${expectedParty}` });
  }
  if (!partyId) return res.status(400).json({ error: 'partyId is required' });
  const allowAdvance = req.body.onAccount === true;
  if ((!Array.isArray(allocations) || allocations.length === 0) && !allowAdvance) {
    return res.status(400).json({ error: 'Settle at least one document — use a plain voucher for money not tied to an invoice' });
  }
  const allocs = Array.isArray(allocations) ? allocations : [];

  const amount = Number(req.body.amount);          // cash/bank actually moved
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'amount must be greater than zero' });
  }
  const tds = round2(Number(req.body.tds) || 0);   // OTC-05/PTP-03: tax deducted at source
  if (tds < 0) return res.status(400).json({ error: 'TDS cannot be negative' });
  const allocTotal = round2(allocs.reduce((s, a) => s + Number(a.amount || 0), 0));
  const settledByParty = round2(amount + tds);     // money moved + TDS relieves the party's account
  const onAccount = round2(settledByParty - allocTotal);
  // By default the money must exactly match what it settles. Only when the
  // caller explicitly asks (onAccount:true) is an excess kept as an advance.
  if (!allowAdvance) {
    if (Math.abs(onAccount) > 0.009) {
      return res.status(400).json({
        error: `The amount (${round2(amount)}${tds ? ' + TDS ' + tds : ''}) and what you allocated (${allocTotal}) must match. Allocate the difference, tick "keep on account", or change the amount.`
      });
    }
  } else if (onAccount < -0.009) {
    return res.status(400).json({
      error: `You allocated ${allocTotal} but only ${settledByParty} (amount ${round2(amount)}${tds ? ' + TDS ' + tds : ''}) is available. Reduce the allocation.`
    });
  }

  const { openDocuments } = require('./outstanding');

  const tx = db.transaction(() => {
    assertPeriodOpen(req.user.companyId, 'Accounts', entryDate);
    // Validate every allocation against what is genuinely still open.
    const open = openDocuments(req.user.companyId, { partyType, partyId });
    const byKey = new Map(open.map(d => [`${d.DocType}:${d.DocID}`, d]));
    allocs.forEach(a => {
      const doc = byKey.get(`${a.docType}:${a.docId}`);
      if (!doc) throw new Error(`Document ${a.docType} #${a.docId} is not open for this party`);
      const amt = Number(a.amount);
      if (!(amt > 0)) throw new Error('Every allocation amount must be greater than zero');
      if (amt > doc.OpenAmount + 0.009) {
        throw new Error(`Cannot settle ${amt} against ${doc.DocNo} — only ${doc.OpenAmount} is still open on it`);
      }
      doc.OpenAmount = round2(doc.OpenAmount - amt);
    });

    const money = accountByCode(req.user.companyId, mode === 'Cash' ? CASH_CODE : BANK_CODE);
    const control = accountByCode(req.user.companyId, voucherType === 'Receipt' ? DEBTORS_CODE : CREDITORS_CODE);
    const partyName = partyType === 'Customer'
      ? (db.prepare('SELECT CustomerName AS n FROM Customer WHERE CustomerID = ?').get(partyId) || {}).n
      : (db.prepare('SELECT SupplierName AS n FROM Supplier WHERE SupplierID = ?').get(partyId) || {}).n;

    const advanceAcct = accountByCode(req.user.companyId, voucherType === 'Receipt' ? '2400' : '1400');
    let lines;
    if (voucherType === 'Receipt') {
      // Dr Cash/Bank + Dr TDS Receivable ; Cr Debtors (invoices) + Cr Customer Advances (on account)
      lines = [{ accountId: money.AccountID, debit: round2(amount), credit: 0 }];
      if (tds > 0) lines.push({ accountId: accountByCode(req.user.companyId, '1300').AccountID, debit: tds, credit: 0 });
      if (allocTotal > 0) lines.push({ accountId: control.AccountID, debit: 0, credit: allocTotal });
      if (onAccount > 0.009) lines.push({ accountId: advanceAcct.AccountID, debit: 0, credit: onAccount });
    } else {
      // Dr Creditors (invoices) + Dr Advances to Suppliers (on account) ; Cr Cash/Bank + Cr TDS Payable
      lines = [];
      if (allocTotal > 0) lines.push({ accountId: control.AccountID, debit: allocTotal, credit: 0 });
      if (onAccount > 0.009) lines.push({ accountId: advanceAcct.AccountID, debit: onAccount, credit: 0 });
      lines.push({ accountId: money.AccountID, debit: 0, credit: round2(amount) });
      if (tds > 0) lines.push({ accountId: accountByCode(req.user.companyId, '2350').AccountID, debit: 0, credit: tds });
    }

    const journalId = postJournalEntry(db, {
      companyId: req.user.companyId, branchId, entryDate,
      narration: narration || `${voucherType} from ${partyName || partyType} settling ${allocs.length} document(s)${onAccount > 0.009 ? ' (+' + onAccount + ' on account)' : ''}`,
      sourceType: voucherType, createdBy: req.user.userId, lines, partyType, partyId, refNo: req.body.refNo
    });

    // An on-account advance is recorded so it can be drawn down against a later invoice.
    if (onAccount > 0.009) {
      db.prepare(`INSERT INTO PartyAdvance (CompanyID, BranchID, PartyType, PartyID, JournalID, Amount, Applied, AdvanceDate)
                  VALUES (?,?,?,?,?,?,0,?)`)
        .run(req.user.companyId, branchId, partyType, partyId, journalId, onAccount, entryDate);
    }

    const insertAlloc = db.prepare(
      `INSERT INTO Allocation (CompanyID, BranchID, PartyType, PartyID, DocType, DocID, JournalID, Amount, AllocDate, CreatedBy)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    );
    allocs.forEach(a => insertAlloc.run(req.user.companyId, branchId, partyType, partyId,
      a.docType, a.docId, journalId, Number(a.amount), entryDate, req.user.userId));

    logAudit({
      companyId: req.user.companyId, branchId, userId: req.user.userId,
      action: `${voucherType.toUpperCase()}_WITH_ALLOCATION`, entityType: 'JournalEntry', entityId: journalId,
      details: `${partyName || partyId}: ${round2(amount)} across ${allocs.length} document(s)`, ip: req.ip
    });

    return { journalId, amount: round2(amount), tds, onAccount: onAccount > 0.009 ? onAccount : 0, settled: allocs.length };
  });

  try {
    res.status(201).json(tx());
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Voucher register - the journal filtered to just the voucher entries.
router.get('/vouchers', (req, res) => {
  const branchId = resolveBranchScope(req);
  const args = branchId ? [req.user.companyId, branchId] : [req.user.companyId];
  const headers = db.prepare(
    `SELECT j.*, b.BranchName FROM JournalEntry j JOIN Branch b ON b.BranchID = j.BranchID
     WHERE j.CompanyID = ? AND j.SourceType IN ('Receipt','Payment','Contra') ${branchId ? 'AND j.BranchID = ?' : ''}
     ORDER BY j.EntryDate DESC, j.JournalID DESC LIMIT 200`
  ).all(...args);

  const lineStmt = db.prepare(
    `SELECT jl.Debit, jl.Credit, a.AccountCode, a.AccountName FROM JournalLine jl
     JOIN ChartOfAccounts a ON a.AccountID = jl.AccountID WHERE jl.JournalID = ?`
  );
  res.json(headers.map(h => {
    const lines = lineStmt.all(h.JournalID);
    const amount = lines.reduce((s, l) => s + l.Debit, 0);
    return {
      ...h, amount,
      debitAccount: (lines.find(l => l.Debit > 0) || {}).AccountName || '',
      creditAccount: (lines.find(l => l.Credit > 0) || {}).AccountName || ''
    };
  }));
});


// ---- FIN-03: reverse a posted journal (manual or source) ----
router.post('/journal/:id/reverse', requirePostingRights, (req, res) => {
  const { reason, date } = req.body || {};
  try {
    const result = db.transaction(() => {
      const j = db.prepare('SELECT * FROM JournalEntry WHERE JournalID = ? AND CompanyID = ?').get(req.params.id, req.user.companyId);
      if (!j) throw new Error('Journal entry not found');
      const when = (date || new Date().toISOString().slice(0, 10)).slice(0, 10);
      assertPeriodOpen(req.user.companyId, 'Accounts', j.EntryDate);
      assertPeriodOpen(req.user.companyId, 'Accounts', when);
      const revId = reverseJournal({ journalId: j.JournalID, companyId: req.user.companyId, date: when, reason, userId: req.user.userId });
      logAudit({ companyId: req.user.companyId, branchId: j.BranchID, userId: req.user.userId, action: 'REVERSE_JOURNAL',
        entityType: 'JournalEntry', entityId: revId, details: `reversed #${j.JournalID}${reason ? ': ' + reason : ''}`, ip: req.ip });
      return revId;
    })();
    res.status(201).json({ reversalJournalId: result });
  } catch (e) {
    res.status(/not found|already|locked|cannot itself/i.test(e.message) ? 400 : 500).json({ error: e.message });
  }
});

// ---- FIN-04: reconciliation of sub-ledgers to their control accounts ----
// Debtors 1100 vs sum of open customer balances; Creditors 2000 vs suppliers;
// Inventory 1200 vs the stock valuation. Any gap is a posting bug and is shown.
router.get('/reconciliation', (req, res) => {
  const companyId = req.user.companyId;
  const { openDocuments } = require('./outstanding');
  const { stockValue } = require('../services/valuation');

  function controlBalance(code) {
    const r = db.prepare(
      `SELECT COALESCE(SUM(jl.Debit),0) - COALESCE(SUM(jl.Credit),0) AS net
       FROM ChartOfAccounts a JOIN JournalLine jl ON jl.AccountID = a.AccountID
       JOIN JournalEntry j ON j.JournalID = jl.JournalID
       WHERE a.CompanyID = ? AND a.AccountCode = ?`).get(companyId, code);
    return round2(r ? r.net : 0);
  }
  function subLedgerTotal(partyType) {
    const parties = partyType === 'Customer'
      ? db.prepare('SELECT CustomerID AS id FROM Customer WHERE CompanyID = ?').all(companyId)
      : db.prepare('SELECT SupplierID AS id FROM Supplier WHERE CompanyID = ?').all(companyId);
    let net = 0, advances = 0;
    parties.forEach(p => {
      openDocuments(companyId, { partyType, partyId: p.id }).forEach(d => { net += d.OpenAmount; });
    });
    advances = round2(db.prepare('SELECT COALESCE(SUM(Amount - Applied),0) AS a FROM PartyAdvance WHERE CompanyID = ? AND PartyType = ?').get(companyId, partyType).a);
    return { open: round2(net), advances };
  }

  const debtors = controlBalance('1100');
  const cust = subLedgerTotal('Customer');
  const creditors = -controlBalance('2000');   // liability: credit-normal
  const supp = subLedgerTotal('Supplier');
  const inventoryLedger = controlBalance('1200');
  const stock = stockValue(companyId);

  const rows = [
    { name: 'Debtors (1100) vs open customer invoices', control: debtors, subLedger: round2(cust.open - cust.advances), difference: round2(debtors - (cust.open - cust.advances)) },
    { name: 'Creditors (2000) vs open vendor bills', control: creditors, subLedger: round2(supp.open - supp.advances), difference: round2(creditors - (supp.open - supp.advances)) },
    { name: 'Inventory (1200) vs stock valuation', control: inventoryLedger, subLedger: stock, difference: round2(inventoryLedger - stock) }
  ].map(r => ({ ...r, reconciled: Math.abs(r.difference) < 0.5 }));

  res.json({ rows, reconciled: rows.every(r => r.reconciled) });
});

// Unapplied advances held for a party (feeds the receipt/payment screen).
router.get('/advances', (req, res) => {
  const { partyType, partyId } = req.query;
  if (!partyType || !partyId) return res.status(400).json({ error: 'partyType and partyId are required' });
  const rows = db.prepare(
    `SELECT AdvanceID, Amount, Applied, (Amount - Applied) AS Balance, AdvanceDate, JournalID
     FROM PartyAdvance WHERE CompanyID = ? AND PartyType = ? AND PartyID = ? AND (Amount - Applied) > 0.009
     ORDER BY AdvanceDate`).all(req.user.companyId, partyType, partyId);
  res.json({ rows, total: round2(rows.reduce((s, r) => s + r.Balance, 0)) });
});

module.exports = { router, postJournalEntry };
