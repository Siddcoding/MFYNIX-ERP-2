const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

// DB_PATH lets a host point the database at a mounted volume instead of at the
// code directory, which most platforms replace wholesale on every deploy.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'mfintech.db');

// Create the directory if the volume is mounted empty. better-sqlite3 throws an
// unhelpful "unable to open database file" otherwise, which reads like a
// corruption problem rather than a missing folder and has cost people hours.
const DB_DIR = path.dirname(DB_PATH);
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

let db;
try {
  db = new Database(DB_PATH);
} catch (err) {
  console.error(`\nCould not open the database at ${DB_PATH}`);
  console.error(err.message);
  console.error('\nIf this is a hosted deployment, check that DB_PATH points at a writable');
  console.error('persistent volume, and that the volume is actually mounted.\n');
  throw err;
}
db.pragma('journal_mode = WAL'); // safer for concurrent branch access

// Run schema (idempotent - CREATE TABLE IF NOT EXISTS)
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// Lightweight migration: add columns that CREATE TABLE IF NOT EXISTS can't
// retrofit onto a database created by an earlier version of schema.sql.
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
ensureColumn('Users', 'ResetTokenHash', 'TEXT');
ensureColumn('Users', 'ResetTokenExpiry', 'TEXT');

// Company Master, expanded to the fields the Mfynix stack document lists in
// section 3. Added as ALTER COLUMNs so an existing database upgrades in place
// without losing anything.
[
  ['PAN', 'TEXT'], ['CIN', 'TEXT'], ['State', 'TEXT'], ['Country', "TEXT DEFAULT 'India'"],
  ['Phone', 'TEXT'], ['Email', 'TEXT'], ['Website', 'TEXT'], ['LogoDataUrl', 'TEXT'],
  ['BankName', 'TEXT'], ['BankAccountNo', 'TEXT'], ['BankIFSC', 'TEXT'], ['BankBranch', 'TEXT'],
  ['InvoicePrefix', "TEXT DEFAULT 'INV'"], ['DeclarationText', 'TEXT'],
].forEach(([col, def]) => ensureColumn('Company', col, def));

// Credit terms and opening balances on the party masters (section 4).
ensureColumn('Customer', 'CreditDays', 'INTEGER DEFAULT 0');
ensureColumn('Customer', 'OpeningBalance', 'REAL DEFAULT 0');
ensureColumn('Supplier', 'OpeningBalance', 'REAL DEFAULT 0');
ensureColumn('Supplier', 'CreditDays', 'INTEGER DEFAULT 0');

// Customer self-service portal sign-in. A customer is NOT a Users row - they
// never touch the ERP itself - so their credentials live on the Customer
// master and are checked by a separate login route that mints a
// customer-kind token. PortalEnabled defaults to 0, so no existing customer
// silently gains a login when this version is deployed over an old database.
ensureColumn('Customer', 'PortalEnabled', 'INTEGER DEFAULT 0');
ensureColumn('Customer', 'PortalPasswordHash', 'TEXT');
ensureColumn('Customer', 'PortalLastLogin', 'TEXT');

// Portal access is time-boxed: the admin grants it for 1, 3, 6 or 12 months and
// it lapses on its own. NULL means no expiry - which is what an access granted
// by an earlier version of this app already had, so upgrading never silently
// locks an existing customer out.
ensureColumn('Customer', 'PortalExpiresAt', 'TEXT');
ensureColumn('Customer', 'PortalGrantedAt', 'TEXT');
ensureColumn('Customer', 'PortalTermMonths', 'INTEGER');

/* ---------------- Item master, full specification ----------------
   The original Item table carried the eight fields a simple invoice needs.
   These are the rest of what a manufacturing/trading business actually keeps
   against an item - sourcing, storage, traceability, costing and BOM. All
   added as ALTER COLUMNs so an existing database picks them up in place.   */
[
  ['ItemCode', 'TEXT'],                     // the business's own code, e.g. RM001
  ['Category', 'TEXT'],                     // Raw Material / Finished Goods / Consumable
  ['AltUnit', 'TEXT'],                      // e.g. Box
  ['AltUnitFactor', 'REAL'],                // how many base units in one alt unit
  ['Dimensions', 'TEXT'],                   // free text: L/W/H, weight
  ['MaterialType', 'TEXT'],
  ['PreferredVendorID', 'INTEGER'],         // -> Supplier
  ['LeadTimeDays', 'INTEGER DEFAULT 0'],
  ['Warehouse', 'TEXT'],
  ['BinRack', 'TEXT'],
  ['BatchTracking', 'INTEGER DEFAULT 0'],
  ['SerialTracking', 'INTEGER DEFAULT 0'],
  ['ShelfLifeMonths', 'INTEGER'],
  ['CostingMethod', "TEXT DEFAULT 'FIFO'"], // FIFO / LIFO / Weighted Average / Standard
  ['StandardCost', 'REAL DEFAULT 0'],
  ['GLMapping', 'TEXT'],                    // which account this item posts to
  ['BOMLink', 'TEXT'],
  ['YieldPercent', 'REAL'],
  ['WastagePercent', 'REAL'],
  ['ImageDataUrl', 'TEXT'],                 // small product image / spec sheet ref
  ['CustomAttributes', 'TEXT'],             // e.g. "Grade A, Silver"
  ['Remarks', 'TEXT'],
].forEach(([col, def]) => ensureColumn('Item', col, def));

// PAN and party type on the masters, so the document can snapshot them.
['Customer', 'Supplier'].forEach(t => {
  ensureColumn(t, 'PAN', 'TEXT');
  ensureColumn(t, 'PartyType', "TEXT DEFAULT 'Registered'");
  ensureColumn(t, 'StateCode', 'TEXT');
});

/* ---------------- Statutory document fields ----------------
   The header fields a GST tax invoice, purchase bill, credit note or debit
   note has to carry. Party PAN/GSTIN/state are SNAPSHOT onto the document
   rather than read live from the master: an invoice is a legal record of what
   was true on the day it was raised, and editing a customer's GSTIN next year
   must not silently rewrite last year's invoices.                          */
const DOCUMENT_HEADER_COLUMNS = [
  ['RefNo', 'TEXT'], ['RefDate', 'TEXT'],              // INVC_REF_NO / INVC_REF_DT
  ['IRN', 'TEXT'], ['EWayBillNo', 'TEXT'],
  ['OrderNo', 'TEXT'], ['OrderDate', 'TEXT'],
  ['TransporterName', 'TEXT'],
  ['ConsignmentNo', 'TEXT'], ['ConsignmentDate', 'TEXT'],
  ['ReverseCharge', 'INTEGER DEFAULT 0'],
  ['PayLedger', 'TEXT'],                               // Cash / Bank / Credit
  ['PartyType', 'TEXT'],                               // Registered / Unregistered / Composition / SEZ / Export
  ['PartyPhone', 'TEXT'], ['PartyPAN', 'TEXT'], ['PartyGSTIN', 'TEXT'],
  ['PartyState', 'TEXT'], ['PartyStateCode', 'TEXT'],
  ['PlaceOfSupply', 'TEXT'],
  ['Remarks', 'TEXT'],
];
['SalesHeader', 'PurchaseHeader', 'NoteHeader'].forEach(table => {
  DOCUMENT_HEADER_COLUMNS.forEach(([col, def]) => ensureColumn(table, col, def));
});

/* Line-level fields. Item code, description and HSN are snapshot for the same
   reason as the party details - renaming an item must not rewrite history.
   The tax heads are stored per line rather than recomputed on read, so a
   printed invoice and a filed return always show the same figures.         */
const DOCUMENT_LINE_COLUMNS = [
  ['ItemCode', 'TEXT'], ['ItemDesc', 'TEXT'], ['HSN', 'TEXT'], ['Unit', 'TEXT'],
  ['BatchNo', 'TEXT'], ['MfgDate', 'TEXT'], ['ExpDate', 'TEXT'],
  ['DiscountPercent', 'REAL DEFAULT 0'],
  ['NettAmount', 'REAL DEFAULT 0'],
  ['IGSTPercent', 'REAL DEFAULT 0'], ['IGSTAmount', 'REAL DEFAULT 0'],
  ['CGSTPercent', 'REAL DEFAULT 0'], ['CGSTAmount', 'REAL DEFAULT 0'],
  ['SGSTPercent', 'REAL DEFAULT 0'], ['SGSTAmount', 'REAL DEFAULT 0'],
  ['GrossAmount', 'REAL DEFAULT 0'],
];
['SalesDetail', 'PurchaseDetail', 'NoteDetail'].forEach(table => {
  DOCUMENT_LINE_COLUMNS.forEach(([col, def]) => ensureColumn(table, col, def));
});
// PurchaseDetail and NoteDetail never had a discount column at all.
ensureColumn('PurchaseDetail', 'Discount', 'REAL DEFAULT 0');
ensureColumn('NoteDetail', 'Discount', 'REAL DEFAULT 0');

// Year-end close bookkeeping on the financial year itself.
ensureColumn('FinancialYear', 'ClosedAt', 'TEXT');
ensureColumn('FinancialYear', 'ClosingJournalID', 'INTEGER');

// Standard chart of accounts every company gets, seeded once per company.
// Codes follow a conventional numbering block: 1xxx Assets, 2xxx Liabilities,
// 3xxx Equity, 4xxx Income, 5xxx Expenses. IsSystem=1 accounts are the ones
// Sales/Purchase auto-posting depends on (see routes/sales.js, purchase.js) -
// the accounts API refuses to delete or retype those.
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
// Idempotent: creates any standard account the company doesn't already have,
// and re-flags accounts that later modules started depending on (IsSystem).
// Safe to call on every boot - it never touches an account's balances, and
// never renames or retypes an account the user may have edited.
function seedChartOfAccounts(companyId) {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO ChartOfAccounts (CompanyID, AccountCode, AccountName, AccountType, IsSystem) VALUES (?,?,?,?,?)`
  );
  const flagSystem = db.prepare(
    `UPDATE ChartOfAccounts SET IsSystem = 1 WHERE CompanyID = ? AND AccountCode = ? AND IsSystem = 0`
  );
  const tx = db.transaction(() => {
    STANDARD_CHART.forEach(([code, name, type, isSystem]) => {
      insert.run(companyId, code, name, type, isSystem);
      if (isSystem) flagSystem.run(companyId, code);
    });
  });
  tx();
}
// Migration safety net: every existing company gets any standard account it is
// missing. This covers databases created before Accounts existed (zero accounts)
// AND databases created before Payroll added the PF/ESI/TDS/Salaries Payable heads.
db.prepare('SELECT CompanyID FROM Company').all().forEach(({ CompanyID }) => {
  seedChartOfAccounts(CompanyID);
});

require('./migrate_r0')(db);
const migrateR1 = require('./migrate_r1');
migrateR1(db);
const migrateR2 = require('./migrate_r2');
migrateR2(db);
require('./migrate_r3')(db);
require('./migrate_r4')(db);
require('./migrate_r5')(db);

// ---- One-time seed: roles + a demo company/branch/admin so the app is usable immediately ----
const roleCount = db.prepare('SELECT COUNT(*) AS c FROM Role').get().c;
if (roleCount === 0) {
  const roles = [
    'Super Admin', 'Company Admin', 'Branch Manager', 'Accountant',
    'Cashier', 'Sales Executive', 'Store Manager', 'Auditor', 'Read Only'
  ];
  const insertRole = db.prepare('INSERT INTO Role (RoleName) VALUES (?)');
  const tx = db.transaction((rs) => rs.forEach(r => insertRole.run(r)));
  tx(roles);
}

let seededAdminPassword = null;
const companyCount = db.prepare('SELECT COUNT(*) AS c FROM Company').get().c;
if (companyCount === 0) {
  const seed = db.transaction(() => {
    const companyId = db.prepare(
      'INSERT INTO Company (CompanyName, GSTIN, Address) VALUES (?,?,?)'
    ).run('MFinTech Solutions Pvt. Ltd.', '21AAAAA0000A1ZE', 'Head Office, Odisha').lastInsertRowid;

    const hoId = db.prepare(
      `INSERT INTO Branch (CompanyID, BranchName, BranchCode, State, IsHeadOffice)
       VALUES (?,?,?,?,1)`
    ).run(companyId, 'Head Office - Bhubaneswar', 'BBSR', 'Odisha').lastInsertRowid;

    db.prepare(
      `INSERT INTO Branch (CompanyID, BranchName, BranchCode, State) VALUES (?,?,?,?)`
    ).run(companyId, 'Hyderabad Branch', 'HYD', 'Telangana');

    const superAdminRole = db.prepare('SELECT RoleID FROM Role WHERE RoleName = ?').get('Super Admin').RoleID;
    // PLT-02: no published default password. The installer either supplies
    // ADMIN_PASSWORD or gets a random one, printed once on first boot, and the
    // account is forced to change it at first sign-in.
    const supplied = process.env.ADMIN_PASSWORD;
    seededAdminPassword = supplied || require('crypto').randomBytes(9).toString('base64').replace(/[+/=]/g, 'x') + '#7a';
    const passwordHash = bcrypt.hashSync(seededAdminPassword, 10);
    const forceChange = process.env.SEED_NO_FORCE_CHANGE === '1' ? 0 : 1;

    // BranchID = NULL means true head-office / all-branch access (see middleware/auth.js
    // resolveBranchScope). The "Head Office" row in Branch is still a real branch for its
    // own local transactions, but the Super Admin's account is not locked to it.
    db.prepare(
      `INSERT INTO Users (CompanyID, BranchID, RoleID, UserName, FullName, Email, PasswordHash, MustChangePassword)
       VALUES (?, NULL, ?,?,?,?,?,?)`
    ).run(companyId, superAdminRole, 'admin', 'System Administrator', 'admin@mfintech.local', passwordHash, forceChange);

    seedChartOfAccounts(companyId);
  });
  seed();
  if (process.env.ADMIN_PASSWORD) {
    console.log('Seeded first company. Sign in as "admin" with the ADMIN_PASSWORD you set; you will be asked to change it.');
  } else {
    console.log('\n=========================================================');
    console.log(' First-boot administrator account (shown ONCE, not stored)');
    console.log('   username: admin');
    console.log('   password: ' + seededAdminPassword);
    console.log(' You must change it at first sign-in.');
    console.log('=========================================================\n');
  }
}

// Every company gets the admin allowlist seeded (idempotent). This runs after
// the first-company seed above so a brand-new database - where the migration
// ran before any company existed - still gets its three pre-approved emails.
{
  const { ALLOWLIST_EMAILS } = require('./migrate_r5');
  const insAllow = db.prepare('INSERT OR IGNORE INTO ApprovedAdminEmail (CompanyID, Email) VALUES (?, ?)');
  db.prepare('SELECT CompanyID FROM Company').all().forEach(({ CompanyID }) => {
    ALLOWLIST_EMAILS.forEach(e => insAllow.run(CompanyID, e.toLowerCase()));
  });
}

// Every company gets a financial year. The Indian FY runs 1 April - 31 March,
// so "today" decides which year is created and made active on first boot.
db.prepare('SELECT CompanyID FROM Company').all().forEach(({ CompanyID }) => {
  const existing = db.prepare('SELECT COUNT(*) AS c FROM FinancialYear WHERE CompanyID = ?').get(CompanyID).c;
  if (existing === 0) {
    const now = new Date();
    const startYear = now.getMonth() + 1 >= 4 ? now.getFullYear() : now.getFullYear() - 1;
    db.prepare(
      `INSERT INTO FinancialYear (CompanyID, YearName, StartDate, EndDate, IsActive)
       VALUES (?,?,?,?,1)`
    ).run(CompanyID, `${startYear}-${String(startYear + 1).slice(2)}`,
          `${startYear}-04-01`, `${startYear + 1}-03-31`);
  }
});

// Every company gets a settings row with the SAFE defaults (block negative
// stock, enforce credit limits). This runs last so it covers both an existing
// database and the demo company seeded just above.
db.prepare('SELECT CompanyID FROM Company').all().forEach(({ CompanyID }) => {
  db.prepare('INSERT OR IGNORE INTO CompanySettings (CompanyID) VALUES (?)').run(CompanyID);
});

// Payment terms, term links and account groups for every company (including one just seeded).
migrateR1.ensureDefaults(db);
migrateR2.ensureDefaults(db);

module.exports = db;
