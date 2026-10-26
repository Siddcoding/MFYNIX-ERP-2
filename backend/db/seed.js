/**
 * Creating a company is more than one INSERT.
 *
 * A company with no head-office branch, no chart of accounts, no financial year
 * and no user who can log in is unusable — so this does all of it as one unit.
 * It is used both for the demo company created on first boot and by the
 * multi-company route in routes/admin.js, so the two can never drift apart.
 *
 * Takes `db` as an argument rather than requiring it, to avoid a circular
 * import with db/index.js.
 */

const STANDARD_CHART = [
  ['1000', 'Cash', 'Asset', 1],
  ['1010', 'Bank', 'Asset', 1],
  ['1100', 'Accounts Receivable (Debtors)', 'Asset', 1],
  ['1200', 'Inventory', 'Asset', 1],
  ['1900', 'GST Input Credit', 'Asset', 1],
  ['2000', 'Accounts Payable (Creditors)', 'Liability', 1],
  ['2100', 'GST Output Payable', 'Liability', 1],
  ['2200', 'Salaries Payable', 'Liability', 1],
  ['2210', 'PF Payable', 'Liability', 1],
  ['2220', 'ESI Payable', 'Liability', 1],
  ['2230', 'TDS Payable', 'Liability', 1],
  ['3000', 'Capital / Opening Balance', 'Equity', 0],
  ['3100', 'Retained Earnings', 'Equity', 0],
  ['4000', 'Sales', 'Income', 1],
  ['4900', 'Other Income', 'Income', 0],
  ['5000', 'Purchases (Cost of Goods)', 'Expense', 1],
  ['5100', 'Salaries & Wages', 'Expense', 1],
  ['5110', 'Employer PF Contribution', 'Expense', 0],
  ['5200', 'Rent', 'Expense', 0],
  ['5300', 'Utilities', 'Expense', 0],
  ['5400', 'Office Expenses', 'Expense', 0],
  ['5900', 'Other Expenses', 'Expense', 0],
  ['1250', 'Inter-Branch Stock Transfer', 'Asset', 1],
  ['1300', 'TDS Receivable', 'Asset', 1],
  ['1400', 'Advances to Suppliers', 'Asset', 1],
  ['2400', 'Customer Advances', 'Liability', 1],
  ['2350', 'TDS Payable', 'Liability', 1],
  ['2050', 'Goods Received Not Billed', 'Liability', 1],
  ['4010', 'Freight & Other Charges Recovered', 'Income', 1],
  ['4910', 'Stock Gain', 'Income', 1],
  ['5010', 'Cost of Goods Sold', 'Expense', 1],
  ['5910', 'Stock Loss / Write-off', 'Expense', 1],
  ['5920', 'Round Off', 'Expense', 1],
];

/** Idempotent: adds any standard account the company is missing. */
function seedChartOfAccounts(db, companyId) {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO ChartOfAccounts (CompanyID, AccountCode, AccountName, AccountType, IsSystem) VALUES (?,?,?,?,?)`
  );
  const flagSystem = db.prepare(
    `UPDATE ChartOfAccounts SET IsSystem = 1 WHERE CompanyID = ? AND AccountCode = ? AND IsSystem = 0`
  );
  STANDARD_CHART.forEach(([code, name, type, isSystem]) => {
    insert.run(companyId, code, name, type, isSystem);
    if (isSystem) flagSystem.run(companyId, code);
  });
}

/** The Indian financial year that today falls into (1 April – 31 March). */
function currentFinancialYear(now = new Date()) {
  const startYear = now.getMonth() + 1 >= 4 ? now.getFullYear() : now.getFullYear() - 1;
  return {
    yearName: `${startYear}-${String(startYear + 1).slice(2)}`,
    startDate: `${startYear}-04-01`,
    endDate: `${startYear + 1}-03-31`
  };
}

function ensureFinancialYear(db, companyId) {
  const existing = db.prepare('SELECT COUNT(*) AS c FROM FinancialYear WHERE CompanyID = ?').get(companyId).c;
  if (existing > 0) return;
  const fy = currentFinancialYear();
  db.prepare(
    `INSERT INTO FinancialYear (CompanyID, YearName, StartDate, EndDate, IsActive) VALUES (?,?,?,?,1)`
  ).run(companyId, fy.yearName, fy.startDate, fy.endDate);
}

/**
 * Creates a complete, immediately usable company.
 * Call inside a transaction. Returns { companyId, branchId, userId }.
 */
function seedCompany(db, {
  companyName, gstin = null, state = null, address = null,
  branchName, branchCode, adminUserName, adminFullName = null, adminEmail = null, passwordHash
}) {
  const companyId = db.prepare(
    'INSERT INTO Company (CompanyName, GSTIN, Address, State) VALUES (?,?,?,?)'
  ).run(companyName, gstin, address, state).lastInsertRowid;

  const branchId = db.prepare(
    `INSERT INTO Branch (CompanyID, BranchName, BranchCode, State, IsHeadOffice) VALUES (?,?,?,?,1)`
  ).run(companyId, branchName, branchCode, state).lastInsertRowid;

  const superAdminRole = db.prepare('SELECT RoleID FROM Role WHERE RoleName = ?').get('Company Admin')
    || db.prepare('SELECT RoleID FROM Role WHERE RoleName = ?').get('Super Admin');

  // BranchID NULL = head-office access across every branch of this company.
  const userId = db.prepare(
    `INSERT INTO Users (CompanyID, BranchID, RoleID, UserName, FullName, Email, PasswordHash, MustChangePassword)
     VALUES (?, NULL, ?,?,?,?,?,1)`
  ).run(companyId, superAdminRole.RoleID, adminUserName, adminFullName, adminEmail, passwordHash).lastInsertRowid;

  seedChartOfAccounts(db, companyId);
  ensureFinancialYear(db, companyId);
  db.prepare('INSERT OR IGNORE INTO CompanySettings (CompanyID) VALUES (?)').run(companyId);

  return { companyId, branchId, userId };
}

module.exports = { STANDARD_CHART, seedChartOfAccounts, seedCompany, ensureFinancialYear, currentFinancialYear };
