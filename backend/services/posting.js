/** Shared posting helpers: account lookup, period locks, journal reversal. */
const db = require('../db');

function round2(n) { return Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100; }

function accountId(companyId, code) {
  const row = db.prepare('SELECT AccountID FROM ChartOfAccounts WHERE CompanyID = ? AND AccountCode = ?').get(companyId, code);
  if (!row) throw new Error(`Chart of Accounts is missing required account ${code} - cannot post the accounting entry`);
  return row.AccountID;
}

const MODULES = ['Sales', 'Purchase', 'Inventory', 'Accounts', 'Payroll'];

/**
 * FIN-05: monthly period lock by module. A period locked for 'All' blocks every
 * module. Throws when the date falls in a locked month for that module.
 */
function assertPeriodOpen(companyId, module, dateStr) {
  if (!dateStr) return;
  const period = String(dateStr).slice(0, 7);
  const hit = db.prepare(
    `SELECT Module FROM PeriodLock WHERE CompanyID = ? AND Period = ? AND Module IN (?, 'All') LIMIT 1`
  ).get(companyId, period, module);
  if (hit) {
    throw new Error(`The period ${period} is locked for ${hit.Module === 'All' ? 'all modules' : hit.Module}. Ask an administrator to unlock it, or date the document in an open period.`);
  }
}

/**
 * FIN-03: reverse a posted journal. Nothing is edited or deleted: a mirror
 * entry is added, each is linked to the other, and a journal can be reversed once.
 */
function reverseJournal({ journalId, companyId, date, reason, userId, narrationPrefix = 'Reversal of' }) {
  const j = db.prepare('SELECT * FROM JournalEntry WHERE JournalID = ? AND CompanyID = ?').get(journalId, companyId);
  if (!j) throw new Error('Journal entry not found');
  if (j.ReversedByID) throw new Error('This entry has already been reversed');
  if (j.ReversalOfID) throw new Error('A reversal entry cannot itself be reversed - post a fresh entry instead');
  const lines = db.prepare('SELECT * FROM JournalLine WHERE JournalID = ?').all(journalId);
  const revId = db.prepare(
    `INSERT INTO JournalEntry (CompanyID, BranchID, EntryDate, Narration, SourceType, SourceID, CreatedBy, ReversalOfID, ReversalReason, PartyType, PartyID)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(companyId, j.BranchID, date, `${narrationPrefix} #${j.JournalID}${j.Narration ? ' (' + j.Narration + ')' : ''}${reason ? ' - ' + reason : ''}`,
    'Reversal', j.JournalID, userId, j.JournalID, reason || null, j.PartyType, j.PartyID).lastInsertRowid;
  const ins = db.prepare('INSERT INTO JournalLine (JournalID, AccountID, Debit, Credit) VALUES (?,?,?,?)');
  lines.forEach(l => ins.run(revId, l.AccountID, l.Credit, l.Debit));
  db.prepare('UPDATE JournalEntry SET ReversedByID = ? WHERE JournalID = ?').run(revId, journalId);
  return revId;
}

module.exports = { round2, accountId, assertPeriodOpen, reverseJournal, MODULES };
