/**
 * R2 schema: the document chain (quotation -> order -> delivery -> invoice and
 * purchase order -> goods receipt -> bill), dunning, and approvals.
 *
 * Every header carries a Status and every line carries an open/pending quantity,
 * because the one rule that holds the chain together (OTC-12) is that a later
 * document can never exceed the open quantity of the earlier one.
 */
module.exports = function migrateR2(db) {
  db.exec(`
    -- ---- Sales chain ----
    CREATE TABLE IF NOT EXISTS Quotation (
      QuotationID INTEGER PRIMARY KEY AUTOINCREMENT,
      CompanyID INTEGER NOT NULL, BranchID INTEGER NOT NULL,
      QuoteNo TEXT NOT NULL, QuoteDate TEXT NOT NULL, ValidUntil TEXT,
      CustomerID INTEGER NOT NULL, PaymentTermID INTEGER,
      Version INTEGER DEFAULT 1, Status TEXT DEFAULT 'Draft',   -- Draft/Sent/Accepted/Rejected/Expired
      Total REAL DEFAULT 0, GST REAL DEFAULT 0, NetAmount REAL DEFAULT 0,
      Remarks TEXT, CreatedBy INTEGER, CreatedAt TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS QuotationLine (
      LineID INTEGER PRIMARY KEY AUTOINCREMENT, QuotationID INTEGER NOT NULL,
      ItemID INTEGER NOT NULL, Qty REAL NOT NULL, Rate REAL NOT NULL, GST REAL DEFAULT 0,
      Discount REAL DEFAULT 0, Amount REAL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS SalesOrder (
      OrderID INTEGER PRIMARY KEY AUTOINCREMENT,
      CompanyID INTEGER NOT NULL, BranchID INTEGER NOT NULL,
      OrderNo TEXT NOT NULL, OrderDate TEXT NOT NULL,
      CustomerID INTEGER NOT NULL, PaymentTermID INTEGER, QuotationID INTEGER,
      CustomerPORef TEXT, RequestedDate TEXT, ShipTo TEXT,
      Status TEXT DEFAULT 'Open',   -- Open/Partly delivered/Delivered/Invoiced/Closed/Cancelled
      Total REAL DEFAULT 0, GST REAL DEFAULT 0, NetAmount REAL DEFAULT 0,
      Remarks TEXT, CreatedBy INTEGER, CreatedAt TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS SalesOrderLine (
      LineID INTEGER PRIMARY KEY AUTOINCREMENT, OrderID INTEGER NOT NULL,
      ItemID INTEGER NOT NULL, Qty REAL NOT NULL, Rate REAL NOT NULL, GST REAL DEFAULT 0,
      Discount REAL DEFAULT 0, Amount REAL DEFAULT 0,
      DeliveredQty REAL DEFAULT 0, InvoicedQty REAL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS Delivery (
      DeliveryID INTEGER PRIMARY KEY AUTOINCREMENT,
      CompanyID INTEGER NOT NULL, BranchID INTEGER NOT NULL,
      DeliveryNo TEXT NOT NULL, DeliveryDate TEXT NOT NULL,
      OrderID INTEGER NOT NULL, CustomerID INTEGER NOT NULL,
      Status TEXT DEFAULT 'Delivered',   -- Delivered/Invoiced/Cancelled
      InvoiceID INTEGER, CreatedBy INTEGER, CreatedAt TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS DeliveryLine (
      LineID INTEGER PRIMARY KEY AUTOINCREMENT, DeliveryID INTEGER NOT NULL,
      OrderLineID INTEGER, ItemID INTEGER NOT NULL, Qty REAL NOT NULL,
      Rate REAL DEFAULT 0, GST REAL DEFAULT 0, InvoicedQty REAL DEFAULT 0
    );

    -- ---- Purchase chain ----
    CREATE TABLE IF NOT EXISTS PurchaseOrder (
      POID INTEGER PRIMARY KEY AUTOINCREMENT,
      CompanyID INTEGER NOT NULL, BranchID INTEGER NOT NULL,
      PONo TEXT NOT NULL, PODate TEXT NOT NULL,
      SupplierID INTEGER NOT NULL, PaymentTermID INTEGER, ExpectedDate TEXT,
      Status TEXT DEFAULT 'Open',   -- Open/Partly received/Received/Billed/Closed/Cancelled
      Total REAL DEFAULT 0, GST REAL DEFAULT 0, NetAmount REAL DEFAULT 0,
      Remarks TEXT, CreatedBy INTEGER, CreatedAt TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS PurchaseOrderLine (
      LineID INTEGER PRIMARY KEY AUTOINCREMENT, POID INTEGER NOT NULL,
      ItemID INTEGER NOT NULL, Qty REAL NOT NULL, Rate REAL NOT NULL, GST REAL DEFAULT 0,
      Amount REAL DEFAULT 0, ReceivedQty REAL DEFAULT 0, BilledQty REAL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS GoodsReceipt (
      GRNID INTEGER PRIMARY KEY AUTOINCREMENT,
      CompanyID INTEGER NOT NULL, BranchID INTEGER NOT NULL,
      GRNNo TEXT NOT NULL, GRNDate TEXT NOT NULL,
      POID INTEGER NOT NULL, SupplierID INTEGER NOT NULL,
      Status TEXT DEFAULT 'Received',   -- Received/Billed/Cancelled
      PurchaseID INTEGER, CreatedBy INTEGER, CreatedAt TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS GoodsReceiptLine (
      LineID INTEGER PRIMARY KEY AUTOINCREMENT, GRNID INTEGER NOT NULL,
      POLineID INTEGER, ItemID INTEGER NOT NULL, Qty REAL NOT NULL,
      Rate REAL DEFAULT 0, GST REAL DEFAULT 0, BatchNo TEXT, ExpDate TEXT, BilledQty REAL DEFAULT 0
    );

    -- ---- Dunning ----
    CREATE TABLE IF NOT EXISTS DunningProcedure (
      ProcedureID INTEGER PRIMARY KEY AUTOINCREMENT,
      CompanyID INTEGER NOT NULL, Name TEXT NOT NULL,
      MinAmount REAL DEFAULT 0, InterestRate REAL DEFAULT 0, IsDefault INTEGER DEFAULT 0,
      IsActive INTEGER DEFAULT 1, CreatedAt TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS DunningLevel (
      LevelID INTEGER PRIMARY KEY AUTOINCREMENT, ProcedureID INTEGER NOT NULL,
      Level INTEGER NOT NULL, DaysOverdue INTEGER NOT NULL, TemplateCode TEXT, Auto INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS DunningHistory (
      HistoryID INTEGER PRIMARY KEY AUTOINCREMENT,
      CompanyID INTEGER NOT NULL, BranchID INTEGER, CustomerID INTEGER NOT NULL,
      Level INTEGER, Channel TEXT, OverdueAmount REAL, RunDate TEXT, DocsJson TEXT,
      MessageStatus TEXT, CreatedBy INTEGER, CreatedAt TEXT DEFAULT (datetime('now'))
    );

    -- ---- Approvals (ROL-04/05/06) ----
    CREATE TABLE IF NOT EXISTS ApprovalRule (
      RuleID INTEGER PRIMARY KEY AUTOINCREMENT,
      CompanyID INTEGER NOT NULL, DocType TEXT NOT NULL,   -- SalesOrder/PurchaseOrder/Payment/CreditNote/Journal
      Threshold REAL DEFAULT 0, ApproverRole TEXT, IsActive INTEGER DEFAULT 1,
      CreatedAt TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS ApprovalRequest (
      RequestID INTEGER PRIMARY KEY AUTOINCREMENT,
      CompanyID INTEGER NOT NULL, BranchID INTEGER, DocType TEXT NOT NULL, DocID INTEGER,
      Amount REAL, Reason TEXT, Status TEXT DEFAULT 'Pending',   -- Pending/Approved/Rejected
      RequestedBy INTEGER, DecidedBy INTEGER, DecisionComment TEXT, DecidedAt TEXT,
      CreatedAt TEXT DEFAULT (datetime('now'))
    );
  `);

  // Dunning block on the customer (DUN-08) and a procedure link (DUN-02).
  const col = (t, c, d) => { const cols = db.prepare(`PRAGMA table_info(${t})`).all().map(x => x.name); if (!cols.includes(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`); };
  col('Customer', 'DunningProcedureID', 'INTEGER');
  col('Customer', 'DunningBlock', 'INTEGER DEFAULT 0');
  col('Customer', 'DunningBlockReason', 'TEXT');
  col('Supplier', 'PaymentBlock', 'INTEGER DEFAULT 0');
  col('SalesHeader', 'OrderID', 'INTEGER');
  col('SalesHeader', 'DeliveryID', 'INTEGER');
  col('PurchaseHeader', 'POID', 'INTEGER');
  col('PurchaseHeader', 'GRNID', 'INTEGER');

  module.exports.ensureDefaults(db);
};

// A sensible default dunning procedure per company (three levels), so the
// dunning run works out of the box.
module.exports.ensureDefaults = function ensureDefaults(db) {
  const companies = db.prepare('SELECT CompanyID FROM Company').all();
  const insProc = db.prepare('INSERT INTO DunningProcedure (CompanyID, Name, MinAmount, IsDefault) VALUES (?,?,?,1)');
  const insLvl = db.prepare('INSERT INTO DunningLevel (ProcedureID, Level, DaysOverdue, TemplateCode, Auto) VALUES (?,?,?,?,?)');
  companies.forEach(({ CompanyID }) => {
    const has = db.prepare('SELECT 1 FROM DunningProcedure WHERE CompanyID = ? AND IsDefault = 1').get(CompanyID);
    if (has) return;
    const pid = insProc.run(CompanyID, 'Standard', 100).lastInsertRowid;
    insLvl.run(pid, 1, 7, 'DUNNING_1', 1);
    insLvl.run(pid, 2, 15, 'DUNNING_2', 1);
    insLvl.run(pid, 3, 30, 'DUNNING_3', 0);
  });
};
