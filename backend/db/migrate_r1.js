/**
 * Release R1 (Core integrity) schema additions. Idempotent.
 */
module.exports = function migrateR1(db) {
  const ensureColumn = (table, column, definition) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  };

  // ---- MD-04/05/06: payment terms and stored due dates ----
  db.exec(`
    CREATE TABLE IF NOT EXISTS PaymentTerm (
      PaymentTermID INTEGER PRIMARY KEY AUTOINCREMENT,
      CompanyID     INTEGER NOT NULL,
      Code          TEXT NOT NULL,
      Description   TEXT,
      BaselineDate  TEXT NOT NULL DEFAULT 'Invoice',   -- Invoice / MonthEnd
      NetDays       INTEGER NOT NULL DEFAULT 0,
      DiscountJson  TEXT,                              -- [{days, percent}] cash-discount tiers
      InstalmentJson TEXT,                             -- [{percent, days}] instalments
      IsActive      INTEGER DEFAULT 1,
      CreatedAt     TEXT DEFAULT (datetime('now')),
      UNIQUE(CompanyID, Code)
    );
  `);
  ensureColumn('Customer', 'PaymentTermID', 'INTEGER');
  ensureColumn('Supplier', 'PaymentTermID', 'INTEGER');
  // Extended party fields (MD-07/08): shipping/contact on customers, contact
  // and bank details on vendors (for payment advices and vendor portal).
  ensureColumn('Customer', 'ShippingAddress', 'TEXT');
  ensureColumn('Customer', 'ContactPerson', 'TEXT');
  ['ContactPerson', 'BankAccount', 'BankIFSC'].forEach(c => ensureColumn('Supplier', c, 'TEXT'));

  ['SalesHeader', 'PurchaseHeader'].forEach(t => {
    ensureColumn(t, 'PaymentTermID', 'INTEGER');
    ensureColumn(t, 'DueDate', 'TEXT');
  });
  [['ShipTo', 'TEXT'], ['Salesperson', 'TEXT'], ['CustomerPORef', 'TEXT'],
   ['Freight', 'REAL DEFAULT 0'], ['OtherCharges', 'REAL DEFAULT 0'], ['RoundOff', 'REAL DEFAULT 0'],
   ['PaymentMode', 'TEXT'], ['ReceiptJournalID', 'INTEGER']].forEach(([c, d]) => ensureColumn('SalesHeader', c, d));
  [['VendorInvoiceNo', 'TEXT'], ['VendorInvoiceDate', 'TEXT']].forEach(([c, d]) => ensureColumn('PurchaseHeader', c, d));
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_purchase_vendor_invoice
           ON PurchaseHeader(CompanyID, SupplierID, VendorInvoiceNo)
           WHERE VendorInvoiceNo IS NOT NULL AND Status != 'Cancelled'`);

  // ---- FIN-02/03: voucher metadata and reversal ----
  [['VoucherNo', 'TEXT'], ['RefNo', 'TEXT'], ['PartyType', 'TEXT'], ['PartyID', 'INTEGER'],
   ['BankAccountID', 'INTEGER'], ['ReversalOfID', 'INTEGER'], ['ReversedByID', 'INTEGER'],
   ['ReversalReason', 'TEXT']].forEach(([c, d]) => ensureColumn('JournalEntry', c, d));

  // ---- FIN-07: account groups ----
  ensureColumn('ChartOfAccounts', 'GroupName', 'TEXT');
  ensureColumn('ChartOfAccounts', 'SubGroup', 'TEXT');

  // ---- FIN-05: period locks per module ----
  db.exec(`
    CREATE TABLE IF NOT EXISTS PeriodLock (
      LockID    INTEGER PRIMARY KEY AUTOINCREMENT,
      CompanyID INTEGER NOT NULL,
      Period    TEXT NOT NULL,            -- YYYY-MM
      Module    TEXT NOT NULL,            -- Sales / Purchase / Inventory / Accounts / All
      LockedBy  INTEGER,
      LockedAt  TEXT DEFAULT (datetime('now')),
      UNIQUE(CompanyID, Period, Module)
    );
  `);

  // ---- INV-01/02: perpetual valuation (weighted average) ----
  ensureColumn('StockLedger', 'UnitCost', 'REAL DEFAULT 0');
  ensureColumn('StockLedger', 'ValueAmount', 'REAL DEFAULT 0');   // signed: + in, - out
  db.exec(`
    CREATE TABLE IF NOT EXISTS ItemCost (
      CompanyID INTEGER NOT NULL, BranchID INTEGER NOT NULL, ItemID INTEGER NOT NULL,
      Qty REAL NOT NULL DEFAULT 0, Value REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (CompanyID, BranchID, ItemID)
    );
  `);
  const hadPerpetual = db.prepare('PRAGMA table_info(CompanySettings)').all().some(c => c.name === 'PerpetualInventory');
  ensureColumn('CompanySettings', 'PerpetualInventory', 'INTEGER DEFAULT 1');

  // ---- OTC-05 / PTP-03: receipts and payments on account; TDS ----
  ensureColumn('Allocation', 'Kind', "TEXT DEFAULT 'Document'");   // Document / Advance
  db.exec(`
    CREATE TABLE IF NOT EXISTS PartyAdvance (
      AdvanceID INTEGER PRIMARY KEY AUTOINCREMENT,
      CompanyID INTEGER NOT NULL, BranchID INTEGER NOT NULL,
      PartyType TEXT NOT NULL, PartyID INTEGER NOT NULL,
      JournalID INTEGER, Amount REAL NOT NULL, Applied REAL NOT NULL DEFAULT 0,
      AdvanceDate TEXT NOT NULL, CreatedAt TEXT DEFAULT (datetime('now'))
    );
  `);

  // ---- ROL-02: two-factor sign-in ----
  ensureColumn('Users', 'TotpSecret', 'TEXT');
  ensureColumn('Users', 'TotpEnabled', 'INTEGER DEFAULT 0');
  ensureColumn('Users', 'RecoveryCodesJson', 'TEXT');

  // ---- PAY-01: employee leaving ----
  ensureColumn('Employee', 'DateOfLeaving', 'TEXT');
  ensureColumn('Employee', 'IsActive', 'INTEGER DEFAULT 1');

  // ---- PRT-01: customer portal invitation token ----
  ensureColumn('Customer', 'PortalInviteHash', 'TEXT');
  ensureColumn('Customer', 'PortalInviteExpiry', 'TEXT');

  // ---- Bulk upload history (MD-11) ----
  db.exec(`
    CREATE TABLE IF NOT EXISTS ImportHistory (
      ImportID INTEGER PRIMARY KEY AUTOINCREMENT,
      CompanyID INTEGER NOT NULL, UserID INTEGER, Entity TEXT NOT NULL, FileName TEXT,
      Mode TEXT, Inserted INTEGER DEFAULT 0, Updated INTEGER DEFAULT 0, Skipped INTEGER DEFAULT 0, Failed INTEGER DEFAULT 0,
      ErrorCsv TEXT, CreatedAt TEXT DEFAULT (datetime('now'))
    );
  `);

  db.prepare(`UPDATE SalesHeader SET DueDate = date(InvoiceDate, '+' || COALESCE((SELECT CreditDays FROM Customer c WHERE c.CustomerID = SalesHeader.CustomerID),0) || ' days') WHERE DueDate IS NULL`).run();
  db.prepare(`UPDATE PurchaseHeader SET DueDate = date(PurchaseDate, '+' || COALESCE((SELECT CreditDays FROM Supplier s WHERE s.SupplierID = PurchaseHeader.SupplierID),0) || ' days') WHERE DueDate IS NULL`).run();

  // Companies that already hold purchases when this release first lands keep the
  // old periodic-inventory treatment: switching an existing ledger mid-stream
  // without an opening inventory journal would misstate profit. New companies
  // (and any company with no purchases yet) run perpetual.
  if (!hadPerpetual) {
    db.prepare(`UPDATE CompanySettings SET PerpetualInventory = 0
                WHERE CompanyID IN (SELECT DISTINCT CompanyID FROM PurchaseHeader)`).run();
  }

};
/** Per-company defaults: payment terms, term links for old CreditDays, account groups. Safe to call on every boot. */
module.exports.ensureDefaults = function ensureDefaults(db) {
  const companies = db.prepare('SELECT CompanyID FROM Company').all();
  const insTerm = db.prepare(
    `INSERT OR IGNORE INTO PaymentTerm (CompanyID, Code, Description, BaselineDate, NetDays) VALUES (?,?,?,?,?)`);
  companies.forEach(({ CompanyID }) => {
    [['IMM', 'Due on receipt', 0], ['NET15', 'Net 15 days', 15], ['NET30', 'Net 30 days', 30],
     ['NET45', 'Net 45 days', 45], ['NET60', 'Net 60 days', 60]]
      .forEach(([code, desc, days]) => insTerm.run(CompanyID, code, desc, 'Invoice', days));
    ['Customer', 'Supplier'].forEach(t => {
      const days = db.prepare(`SELECT DISTINCT COALESCE(CreditDays,0) AS d FROM ${t} WHERE CompanyID = ?`).all(CompanyID);
      days.forEach(({ d }) => {
        const code = d === 0 ? 'IMM' : `NET${d}`;
        insTerm.run(CompanyID, code, d === 0 ? 'Due on receipt' : `Net ${d} days`, 'Invoice', d);
        const term = db.prepare('SELECT PaymentTermID FROM PaymentTerm WHERE CompanyID = ? AND Code = ?').get(CompanyID, code);
        db.prepare(`UPDATE ${t} SET PaymentTermID = ? WHERE CompanyID = ? AND PaymentTermID IS NULL AND COALESCE(CreditDays,0) = ?`)
          .run(term.PaymentTermID, CompanyID, d);
      });
    });
  });
  // FIN-07: default account groups for accounts that have none yet.
  const groupFor = (code, type) => {
    const n = Number(code);
    if (type === 'Asset') return n < 1100 ? 'Cash & Bank' : n < 1200 ? 'Receivables' : n < 1300 ? 'Inventory' : 'Other Current Assets';
    if (type === 'Liability') return n < 2100 ? 'Payables' : n < 2200 ? 'Duties & Taxes' : n < 2300 ? 'Payroll Liabilities' : 'Other Current Liabilities';
    if (type === 'Equity') return 'Capital & Reserves';
    if (type === 'Income') return n < 4100 ? 'Sales' : 'Other Income';
    return n < 5100 ? 'Cost of Goods' : n < 5200 ? 'Employee Costs' : 'Operating Expenses';
  };
  db.prepare("SELECT AccountID, AccountCode, AccountType FROM ChartOfAccounts WHERE GroupName IS NULL").all()
    .forEach(a => db.prepare('UPDATE ChartOfAccounts SET GroupName = ? WHERE AccountID = ?').run(groupFor(a.AccountCode, a.AccountType), a.AccountID));
};
