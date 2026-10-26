-- MFinTech Smart ERP - Multi-Location Control Flow
-- Core schema (Milestones 1-5 of the client's roadmap)
-- Every transactional table carries CompanyID + BranchID so branch-wise
-- and consolidated (head-office) views come from the same tables.

PRAGMA foreign_keys = ON;

-- ===================== ADMINISTRATION =====================

CREATE TABLE IF NOT EXISTS Company (
  CompanyID     INTEGER PRIMARY KEY AUTOINCREMENT,
  CompanyName   TEXT NOT NULL,
  GSTIN         TEXT,
  Address       TEXT,
  CreatedAt     TEXT DEFAULT (datetime('now')),
  IsActive      INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS Branch (
  BranchID      INTEGER PRIMARY KEY AUTOINCREMENT,
  CompanyID     INTEGER NOT NULL REFERENCES Company(CompanyID),
  BranchName    TEXT NOT NULL,
  BranchCode    TEXT NOT NULL,          -- e.g. HYD, BBSR, DEL - used for invoice numbering
  GSTIN         TEXT,
  State         TEXT,
  Address       TEXT,
  Phone         TEXT,
  IsHeadOffice  INTEGER DEFAULT 0,
  IsActive      INTEGER DEFAULT 1,
  CreatedAt     TEXT DEFAULT (datetime('now')),
  UNIQUE(CompanyID, BranchCode)
);

CREATE TABLE IF NOT EXISTS Role (
  RoleID        INTEGER PRIMARY KEY AUTOINCREMENT,
  RoleName      TEXT NOT NULL UNIQUE   -- Super Admin, Company Admin, Branch Manager, Accountant, Cashier, Sales Executive, Store Manager, Auditor, Read Only
);

CREATE TABLE IF NOT EXISTS Users (
  UserID        INTEGER PRIMARY KEY AUTOINCREMENT,
  CompanyID     INTEGER NOT NULL REFERENCES Company(CompanyID),
  BranchID      INTEGER REFERENCES Branch(BranchID),   -- NULL = Head Office / all-branch access
  RoleID        INTEGER NOT NULL REFERENCES Role(RoleID),
  UserName      TEXT NOT NULL UNIQUE,
  FullName      TEXT,
  Email         TEXT,
  PasswordHash  TEXT NOT NULL,
  Status        TEXT DEFAULT 'Active', -- Active / Inactive / Locked
  LastLogin     TEXT,
  ResetTokenHash    TEXT,   -- hashed forgot-password token (never store raw)
  ResetTokenExpiry  TEXT,   -- ISO datetime the token stops being valid
  CreatedAt     TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS AuditLog (
  AuditID       INTEGER PRIMARY KEY AUTOINCREMENT,
  CompanyID     INTEGER,
  BranchID      INTEGER,
  UserID        INTEGER,
  Action        TEXT NOT NULL,         -- e.g. LOGIN, CREATE_INVOICE, UPDATE_ITEM
  EntityType    TEXT,
  EntityID      INTEGER,
  Details       TEXT,
  IPAddress     TEXT,
  CreatedAt     TEXT DEFAULT (datetime('now'))
);

-- ===================== MASTERS =====================

CREATE TABLE IF NOT EXISTS Customer (
  CustomerID    INTEGER PRIMARY KEY AUTOINCREMENT,
  CompanyID     INTEGER NOT NULL REFERENCES Company(CompanyID),
  BranchID      INTEGER REFERENCES Branch(BranchID),  -- home branch (customer still visible company-wide)
  CustomerName  TEXT NOT NULL,
  GSTIN         TEXT,
  Mobile        TEXT,
  Email         TEXT,
  Address       TEXT,
  State         TEXT,
  CreditLimit   REAL DEFAULT 0,
  IsActive      INTEGER DEFAULT 1,
  CreatedAt     TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS Supplier (
  SupplierID    INTEGER PRIMARY KEY AUTOINCREMENT,
  CompanyID     INTEGER NOT NULL REFERENCES Company(CompanyID),
  BranchID      INTEGER REFERENCES Branch(BranchID),
  SupplierName  TEXT NOT NULL,
  GSTIN         TEXT,
  Mobile        TEXT,
  Email         TEXT,
  Address       TEXT,
  State         TEXT,
  IsActive      INTEGER DEFAULT 1,
  CreatedAt     TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS Item (
  ItemID        INTEGER PRIMARY KEY AUTOINCREMENT,
  CompanyID     INTEGER NOT NULL REFERENCES Company(CompanyID),
  ItemName      TEXT NOT NULL,
  HSN           TEXT,
  GSTRate       REAL DEFAULT 0,
  Unit          TEXT DEFAULT 'PCS',
  Barcode       TEXT,
  PurchaseRate  REAL DEFAULT 0,
  SaleRate      REAL DEFAULT 0,
  ReorderLevel  REAL DEFAULT 0,
  IsActive      INTEGER DEFAULT 1,
  CreatedAt     TEXT DEFAULT (datetime('now'))
);

-- ===================== SALES =====================

CREATE TABLE IF NOT EXISTS SalesHeader (
  InvoiceID     INTEGER PRIMARY KEY AUTOINCREMENT,
  CompanyID     INTEGER NOT NULL REFERENCES Company(CompanyID),
  BranchID      INTEGER NOT NULL REFERENCES Branch(BranchID),
  InvoiceNo     TEXT NOT NULL,          -- e.g. HYD-0001 (branch-wise numbering)
  InvoiceDate   TEXT NOT NULL,
  CustomerID    INTEGER NOT NULL REFERENCES Customer(CustomerID),
  Total         REAL DEFAULT 0,
  GST           REAL DEFAULT 0,
  NetAmount     REAL DEFAULT 0,
  Status        TEXT DEFAULT 'Posted',  -- Draft / Posted / Cancelled
  CreatedBy     INTEGER REFERENCES Users(UserID),
  CreatedAt     TEXT DEFAULT (datetime('now')),
  UNIQUE(BranchID, InvoiceNo)
);

CREATE TABLE IF NOT EXISTS SalesDetail (
  SalesDetailID INTEGER PRIMARY KEY AUTOINCREMENT,
  InvoiceID     INTEGER NOT NULL REFERENCES SalesHeader(InvoiceID) ON DELETE CASCADE,
  ItemID        INTEGER NOT NULL REFERENCES Item(ItemID),
  Qty           REAL NOT NULL,
  Rate          REAL NOT NULL,
  Discount      REAL DEFAULT 0,
  GST           REAL DEFAULT 0,
  Amount        REAL NOT NULL
);

-- ===================== PURCHASE =====================

CREATE TABLE IF NOT EXISTS PurchaseHeader (
  PurchaseID    INTEGER PRIMARY KEY AUTOINCREMENT,
  CompanyID     INTEGER NOT NULL REFERENCES Company(CompanyID),
  BranchID      INTEGER NOT NULL REFERENCES Branch(BranchID),
  PurchaseNo    TEXT NOT NULL,
  PurchaseDate  TEXT NOT NULL,
  SupplierID    INTEGER NOT NULL REFERENCES Supplier(SupplierID),
  Total         REAL DEFAULT 0,
  GST           REAL DEFAULT 0,
  NetAmount     REAL DEFAULT 0,
  Status        TEXT DEFAULT 'Posted',
  CreatedBy     INTEGER REFERENCES Users(UserID),
  CreatedAt     TEXT DEFAULT (datetime('now')),
  UNIQUE(BranchID, PurchaseNo)
);

CREATE TABLE IF NOT EXISTS PurchaseDetail (
  PurchaseDetailID INTEGER PRIMARY KEY AUTOINCREMENT,
  PurchaseID    INTEGER NOT NULL REFERENCES PurchaseHeader(PurchaseID) ON DELETE CASCADE,
  ItemID        INTEGER NOT NULL REFERENCES Item(ItemID),
  Qty           REAL NOT NULL,
  Rate          REAL NOT NULL,
  GST           REAL DEFAULT 0,
  Amount        REAL NOT NULL
);

-- ===================== INVENTORY =====================

-- Running stock ledger - every sale/purchase/transfer writes one row here.
-- Current stock per branch/item = SUM(InQty) - SUM(OutQty).
CREATE TABLE IF NOT EXISTS StockLedger (
  StockLedgerID INTEGER PRIMARY KEY AUTOINCREMENT,
  CompanyID     INTEGER NOT NULL REFERENCES Company(CompanyID),
  BranchID      INTEGER NOT NULL REFERENCES Branch(BranchID),
  ItemID        INTEGER NOT NULL REFERENCES Item(ItemID),
  TransType     TEXT NOT NULL,   -- SALE / PURCHASE / TRANSFER_IN / TRANSFER_OUT / ADJUSTMENT
  RefType       TEXT,            -- SalesHeader / PurchaseHeader / StockTransfer
  RefID         INTEGER,
  InQty         REAL DEFAULT 0,
  OutQty        REAL DEFAULT 0,
  TransDate     TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS StockTransfer (
  TransferID    INTEGER PRIMARY KEY AUTOINCREMENT,
  CompanyID     INTEGER NOT NULL REFERENCES Company(CompanyID),
  FromBranchID  INTEGER NOT NULL REFERENCES Branch(BranchID),
  ToBranchID    INTEGER NOT NULL REFERENCES Branch(BranchID),
  ItemID        INTEGER NOT NULL REFERENCES Item(ItemID),
  Qty           REAL NOT NULL,
  Status        TEXT DEFAULT 'Completed', -- Pending / In-Transit / Completed
  CreatedBy     INTEGER REFERENCES Users(UserID),
  CreatedAt     TEXT DEFAULT (datetime('now'))
);

-- ===================== ACCOUNTS (Milestone 8: double-entry bookkeeping) =====================

-- Every account a company posts to. Seeded with a standard chart on company
-- creation (Cash, Bank, Debtors, Creditors, Sales, Purchases, GST accounts,
-- Capital, common expense heads) - see db/index.js seedChartOfAccounts().
CREATE TABLE IF NOT EXISTS ChartOfAccounts (
  AccountID     INTEGER PRIMARY KEY AUTOINCREMENT,
  CompanyID     INTEGER NOT NULL REFERENCES Company(CompanyID),
  AccountCode   TEXT NOT NULL,          -- e.g. 1000, 4000 - used for sort order and display
  AccountName   TEXT NOT NULL,
  AccountType   TEXT NOT NULL,          -- Asset / Liability / Equity / Income / Expense
  IsSystem      INTEGER DEFAULT 0,      -- 1 = used by auto-posting (Sales/Purchase/GST/etc.), protected from deletion
  IsActive      INTEGER DEFAULT 1,
  CreatedAt     TEXT DEFAULT (datetime('now')),
  UNIQUE(CompanyID, AccountCode)
);

-- Journal header. Every accounting event - whether typed in manually or
-- auto-posted from a Sales/Purchase invoice - creates exactly one of these.
CREATE TABLE IF NOT EXISTS JournalEntry (
  JournalID     INTEGER PRIMARY KEY AUTOINCREMENT,
  CompanyID     INTEGER NOT NULL REFERENCES Company(CompanyID),
  BranchID      INTEGER NOT NULL REFERENCES Branch(BranchID),
  EntryDate     TEXT NOT NULL,
  Narration     TEXT,
  SourceType    TEXT NOT NULL DEFAULT 'Manual', -- Manual / SalesInvoice / PurchaseInvoice
  SourceID      INTEGER,                        -- InvoiceID/PurchaseID when auto-posted, else NULL
  CreatedBy     INTEGER REFERENCES Users(UserID),
  CreatedAt     TEXT DEFAULT (datetime('now'))
);

-- Journal lines. A JournalEntry's lines must always sum Debit = Credit
-- (enforced in application code at insert time, not just trusted).
CREATE TABLE IF NOT EXISTS JournalLine (
  JournalLineID INTEGER PRIMARY KEY AUTOINCREMENT,
  JournalID     INTEGER NOT NULL REFERENCES JournalEntry(JournalID) ON DELETE CASCADE,
  AccountID     INTEGER NOT NULL REFERENCES ChartOfAccounts(AccountID),
  Debit         REAL NOT NULL DEFAULT 0,
  Credit        REAL NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_journal_branch_date ON JournalEntry(BranchID, EntryDate);
CREATE INDEX IF NOT EXISTS idx_journalline_account ON JournalLine(AccountID);

-- Useful indexes for branch-wise & consolidated reporting
CREATE INDEX IF NOT EXISTS idx_sales_branch_date ON SalesHeader(BranchID, InvoiceDate);
CREATE INDEX IF NOT EXISTS idx_purchase_branch_date ON PurchaseHeader(BranchID, PurchaseDate);
CREATE INDEX IF NOT EXISTS idx_stock_branch_item ON StockLedger(BranchID, ItemID);
CREATE INDEX IF NOT EXISTS idx_audit_company_branch ON AuditLog(CompanyID, BranchID);

-- ===================== GST FILING (Milestone 9) =====================

-- A record of each return the company has generated/filed from this system.
-- The return DATA itself is always recomputed live from SalesHeader/PurchaseHeader
-- so it can never drift from the books; this table stores the filing trail
-- (who generated it, for which period, what the totals were, ARN once filed).
CREATE TABLE IF NOT EXISTS GSTReturnLog (
  ReturnID      INTEGER PRIMARY KEY AUTOINCREMENT,
  CompanyID     INTEGER NOT NULL REFERENCES Company(CompanyID),
  BranchID      INTEGER REFERENCES Branch(BranchID),  -- NULL = consolidated (company-level filing)
  ReturnType    TEXT NOT NULL,          -- GSTR1 / GSTR3B
  Period        TEXT NOT NULL,          -- YYYY-MM
  TaxableValue  REAL DEFAULT 0,
  CGST          REAL DEFAULT 0,
  SGST          REAL DEFAULT 0,
  IGST          REAL DEFAULT 0,
  NetPayable    REAL DEFAULT 0,
  Status        TEXT DEFAULT 'Generated', -- Generated / Filed
  ARN           TEXT,                     -- acknowledgement number, filled when marked Filed
  FiledAt       TEXT,
  CreatedBy     INTEGER REFERENCES Users(UserID),
  CreatedAt     TEXT DEFAULT (datetime('now')),
  UNIQUE(CompanyID, BranchID, ReturnType, Period)
);

-- ===================== PAYROLL (Milestone 10) =====================

CREATE TABLE IF NOT EXISTS Employee (
  EmployeeID    INTEGER PRIMARY KEY AUTOINCREMENT,
  CompanyID     INTEGER NOT NULL REFERENCES Company(CompanyID),
  BranchID      INTEGER NOT NULL REFERENCES Branch(BranchID),
  EmpCode       TEXT NOT NULL,          -- branch-wise, e.g. HYD-E001
  FullName      TEXT NOT NULL,
  Designation   TEXT,
  Department    TEXT,
  Mobile        TEXT,
  Email         TEXT,
  PAN           TEXT,
  BankAccount   TEXT,
  IFSC          TEXT,
  DateOfJoining TEXT,
  Basic         REAL DEFAULT 0,
  HRA           REAL DEFAULT 0,
  Allowances    REAL DEFAULT 0,
  PFApplicable  INTEGER DEFAULT 1,
  ESIApplicable INTEGER DEFAULT 1,
  MonthlyTDS    REAL DEFAULT 0,
  IsActive      INTEGER DEFAULT 1,
  CreatedAt     TEXT DEFAULT (datetime('now')),
  UNIQUE(CompanyID, EmpCode)
);

-- One row per employee per month: days present drives pro-rata pay.
CREATE TABLE IF NOT EXISTS Attendance (
  AttendanceID  INTEGER PRIMARY KEY AUTOINCREMENT,
  CompanyID     INTEGER NOT NULL REFERENCES Company(CompanyID),
  BranchID      INTEGER NOT NULL REFERENCES Branch(BranchID),
  EmployeeID    INTEGER NOT NULL REFERENCES Employee(EmployeeID),
  Period        TEXT NOT NULL,          -- YYYY-MM
  WorkingDays   REAL NOT NULL DEFAULT 26,
  PresentDays   REAL NOT NULL DEFAULT 26,
  LeaveDays     REAL DEFAULT 0,
  OvertimeHours REAL DEFAULT 0,
  UNIQUE(EmployeeID, Period)
);

-- A payroll run locks a branch's payroll for one month. Re-running the same
-- branch+period is refused, so salaries can't be double-posted to accounts.
CREATE TABLE IF NOT EXISTS PayrollRun (
  PayrollRunID  INTEGER PRIMARY KEY AUTOINCREMENT,
  CompanyID     INTEGER NOT NULL REFERENCES Company(CompanyID),
  BranchID      INTEGER NOT NULL REFERENCES Branch(BranchID),
  Period        TEXT NOT NULL,          -- YYYY-MM
  GrossTotal    REAL DEFAULT 0,
  DeductionTotal REAL DEFAULT 0,
  NetTotal      REAL DEFAULT 0,
  EmployeeCount INTEGER DEFAULT 0,
  JournalID     INTEGER REFERENCES JournalEntry(JournalID),
  Status        TEXT DEFAULT 'Posted',  -- Posted / Paid
  CreatedBy     INTEGER REFERENCES Users(UserID),
  CreatedAt     TEXT DEFAULT (datetime('now')),
  UNIQUE(BranchID, Period)
);

CREATE TABLE IF NOT EXISTS PayrollDetail (
  PayrollDetailID INTEGER PRIMARY KEY AUTOINCREMENT,
  PayrollRunID  INTEGER NOT NULL REFERENCES PayrollRun(PayrollRunID) ON DELETE CASCADE,
  EmployeeID    INTEGER NOT NULL REFERENCES Employee(EmployeeID),
  WorkingDays   REAL, PresentDays REAL,
  Basic         REAL DEFAULT 0,
  HRA           REAL DEFAULT 0,
  Allowances    REAL DEFAULT 0,
  Overtime      REAL DEFAULT 0,
  Gross         REAL DEFAULT 0,
  PF            REAL DEFAULT 0,
  ESI           REAL DEFAULT 0,
  TDS           REAL DEFAULT 0,
  Deductions    REAL DEFAULT 0,
  NetPay        REAL DEFAULT 0
);

-- ===================== CRM (Milestone 11) =====================

CREATE TABLE IF NOT EXISTS Lead (
  LeadID        INTEGER PRIMARY KEY AUTOINCREMENT,
  CompanyID     INTEGER NOT NULL REFERENCES Company(CompanyID),
  BranchID      INTEGER NOT NULL REFERENCES Branch(BranchID),
  LeadName      TEXT NOT NULL,
  ContactPerson TEXT,
  Mobile        TEXT,
  Email         TEXT,
  Source        TEXT,                    -- Walk-in / Referral / Website / Cold Call / Exhibition
  Stage         TEXT DEFAULT 'New',      -- New / Contacted / Qualified / Proposal / Won / Lost
  EstimatedValue REAL DEFAULT 0,
  NextFollowUp  TEXT,                    -- date
  Notes         TEXT,
  OwnerUserID   INTEGER REFERENCES Users(UserID),
  ConvertedCustomerID INTEGER REFERENCES Customer(CustomerID),
  LostReason    TEXT,
  IsActive      INTEGER DEFAULT 1,
  CreatedAt     TEXT DEFAULT (datetime('now')),
  UpdatedAt     TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS LeadActivity (
  ActivityID    INTEGER PRIMARY KEY AUTOINCREMENT,
  LeadID        INTEGER NOT NULL REFERENCES Lead(LeadID) ON DELETE CASCADE,
  ActivityType  TEXT NOT NULL,           -- Call / Email / Meeting / Note / Stage Change
  Notes         TEXT,
  NextFollowUp  TEXT,
  CreatedBy     INTEGER REFERENCES Users(UserID),
  CreatedAt     TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_lead_branch_stage ON Lead(BranchID, Stage);
CREATE INDEX IF NOT EXISTS idx_employee_branch ON Employee(BranchID);
CREATE INDEX IF NOT EXISTS idx_payrollrun_branch_period ON PayrollRun(BranchID, Period);

-- ===================== POLICY SETTINGS (Milestone 13) =====================
-- Per-company switches for the controls that different businesses want
-- enforced differently. Defaults are the SAFE option: block the transaction.
-- A Super Admin can relax them per company, e.g. a distributor who genuinely
-- bills before goods physically arrive.
CREATE TABLE IF NOT EXISTS CompanySettings (
  CompanyID            INTEGER PRIMARY KEY REFERENCES Company(CompanyID),
  AllowNegativeStock   INTEGER DEFAULT 0,   -- 0 = refuse a sale/transfer with insufficient stock
  EnforceCreditLimit   INTEGER DEFAULT 1,   -- 1 = refuse a sale that breaches the customer's limit
  UpdatedAt            TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON AuditLog(CreatedAt);
CREATE INDEX IF NOT EXISTS idx_audit_user ON AuditLog(UserID);

-- ===================== MFYNIX STACK ADDITIONS (Milestone 14) =====================
-- Implements sections 3 (Company & Organisation), 14 (Outstanding) and 22
-- (Document Numbering Engine) of the Mfynix stack-structure document.

-- Financial years. Transactions are stamped with the year they fall in, so
-- reports and closing can be scoped to a year rather than "everything ever".
CREATE TABLE IF NOT EXISTS FinancialYear (
  FinancialYearID INTEGER PRIMARY KEY AUTOINCREMENT,
  CompanyID     INTEGER NOT NULL REFERENCES Company(CompanyID),
  YearName      TEXT NOT NULL,          -- e.g. "2026-27"
  StartDate     TEXT NOT NULL,
  EndDate       TEXT NOT NULL,
  IsActive      INTEGER DEFAULT 0,      -- exactly one active year per company
  IsClosed      INTEGER DEFAULT 0,      -- closed years reject new postings
  CreatedAt     TEXT DEFAULT (datetime('now')),
  UNIQUE(CompanyID, YearName)
);

-- Central document numbering (section 22). One row per company+branch+doc type
-- +financial year. The counter is incremented inside the caller's transaction,
-- so two users saving at the same moment can never be handed the same number -
-- which the old COUNT(*)+1 approach could not guarantee.
CREATE TABLE IF NOT EXISTS DocumentSequence (
  SequenceID    INTEGER PRIMARY KEY AUTOINCREMENT,
  CompanyID     INTEGER NOT NULL REFERENCES Company(CompanyID),
  BranchID      INTEGER REFERENCES Branch(BranchID),   -- NULL = company-wide series
  DocType       TEXT NOT NULL,          -- INV / PUR / REC / PAY / JV / CN / DN
  FinancialYear TEXT NOT NULL,          -- e.g. "2026-27", or 'ALL' if not year-scoped
  Prefix        TEXT NOT NULL,          -- what the number starts with
  Padding       INTEGER DEFAULT 6,
  NextNumber    INTEGER DEFAULT 1,
  UNIQUE(CompanyID, BranchID, DocType, FinancialYear)
);

-- Receipt / payment allocation against specific invoices (section 14).
-- Without this, "outstanding" can only ever be total-billed; with it, a
-- customer's real balance and its ageing become computable.
CREATE TABLE IF NOT EXISTS Allocation (
  AllocationID  INTEGER PRIMARY KEY AUTOINCREMENT,
  CompanyID     INTEGER NOT NULL REFERENCES Company(CompanyID),
  BranchID      INTEGER NOT NULL REFERENCES Branch(BranchID),
  PartyType     TEXT NOT NULL,          -- Customer / Supplier
  PartyID       INTEGER NOT NULL,
  DocType       TEXT NOT NULL,          -- SalesInvoice / PurchaseInvoice
  DocID         INTEGER NOT NULL,       -- InvoiceID / PurchaseID
  JournalID     INTEGER REFERENCES JournalEntry(JournalID),  -- the receipt/payment voucher
  Amount        REAL NOT NULL,
  AllocDate     TEXT NOT NULL,
  CreatedBy     INTEGER REFERENCES Users(UserID),
  CreatedAt     TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_alloc_party ON Allocation(PartyType, PartyID);
CREATE INDEX IF NOT EXISTS idx_alloc_doc ON Allocation(DocType, DocID);
CREATE INDEX IF NOT EXISTS idx_fy_company ON FinancialYear(CompanyID, IsActive);

-- ===================== CREDIT / DEBIT NOTES (Milestone 15) =====================
-- A credit note reverses part or all of a SALES invoice (customer returns goods
-- or is given an allowance). A debit note does the same against a PURCHASE.
-- Unlike cancellation, a note is a document in its own right with its own
-- number, and it is the lawful remedy once the period's GST return is filed.
CREATE TABLE IF NOT EXISTS NoteHeader (
  NoteID        INTEGER PRIMARY KEY AUTOINCREMENT,
  CompanyID     INTEGER NOT NULL REFERENCES Company(CompanyID),
  BranchID      INTEGER NOT NULL REFERENCES Branch(BranchID),
  NoteType      TEXT NOT NULL,          -- Credit (against sales) / Debit (against purchase)
  NoteNo        TEXT NOT NULL,
  NoteDate      TEXT NOT NULL,
  PartyType     TEXT NOT NULL,          -- Customer / Supplier
  PartyID       INTEGER NOT NULL,
  AgainstDocType TEXT,                  -- SalesInvoice / PurchaseInvoice
  AgainstDocID  INTEGER,                -- original invoice, optional but usual
  Reason        TEXT NOT NULL,
  RestoreStock  INTEGER DEFAULT 1,      -- 0 for a pure price allowance, no goods back
  Total         REAL DEFAULT 0,
  GST           REAL DEFAULT 0,
  NetAmount     REAL DEFAULT 0,
  JournalID     INTEGER REFERENCES JournalEntry(JournalID),
  Status        TEXT DEFAULT 'Posted',
  CreatedBy     INTEGER REFERENCES Users(UserID),
  CreatedAt     TEXT DEFAULT (datetime('now')),
  UNIQUE(BranchID, NoteNo)
);

CREATE TABLE IF NOT EXISTS NoteDetail (
  NoteDetailID  INTEGER PRIMARY KEY AUTOINCREMENT,
  NoteID        INTEGER NOT NULL REFERENCES NoteHeader(NoteID) ON DELETE CASCADE,
  ItemID        INTEGER NOT NULL REFERENCES Item(ItemID),
  Qty           REAL NOT NULL,
  Rate          REAL NOT NULL,
  GST           REAL DEFAULT 0,
  Amount        REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_note_branch_date ON NoteHeader(BranchID, NoteDate);
CREATE INDEX IF NOT EXISTS idx_note_against ON NoteHeader(AgainstDocType, AgainstDocID);

-- ===================== BANKING (Mfynix section 9) =====================

CREATE TABLE IF NOT EXISTS BankAccount (
  BankAccountID INTEGER PRIMARY KEY AUTOINCREMENT,
  CompanyID     INTEGER NOT NULL REFERENCES Company(CompanyID),
  BranchID      INTEGER REFERENCES Branch(BranchID),   -- NULL = company-wide
  AccountName   TEXT NOT NULL,
  BankName      TEXT,
  AccountNo     TEXT,
  IFSC          TEXT,
  LedgerAccountID INTEGER REFERENCES ChartOfAccounts(AccountID),  -- which COA account it posts to
  OpeningBalance REAL DEFAULT 0,
  IsActive      INTEGER DEFAULT 1,
  CreatedAt     TEXT DEFAULT (datetime('now'))
);

-- Lines imported from a bank statement. Kept separate from the ledger: a
-- statement line is what the BANK says happened, and reconciliation is the act
-- of agreeing it with what the books say.
CREATE TABLE IF NOT EXISTS BankStatementLine (
  StatementLineID INTEGER PRIMARY KEY AUTOINCREMENT,
  CompanyID     INTEGER NOT NULL REFERENCES Company(CompanyID),
  BankAccountID INTEGER NOT NULL REFERENCES BankAccount(BankAccountID),
  TxnDate       TEXT NOT NULL,
  Description   TEXT,
  RefNo         TEXT,
  Debit         REAL DEFAULT 0,          -- money out of the bank
  Credit        REAL DEFAULT 0,          -- money into the bank
  RunningBalance REAL,
  ImportBatch   TEXT,                    -- so a bad import can be identified
  RowHash       TEXT,                    -- duplicate-import guard
  MatchedJournalID INTEGER REFERENCES JournalEntry(JournalID),
  Status        TEXT DEFAULT 'Unmatched', -- Unmatched / Matched / Ignored
  MatchedBy     INTEGER REFERENCES Users(UserID),
  MatchedAt     TEXT,
  CreatedAt     TEXT DEFAULT (datetime('now')),
  UNIQUE(BankAccountID, RowHash)
);

CREATE INDEX IF NOT EXISTS idx_stmt_account_status ON BankStatementLine(BankAccountID, Status);

-- ===================== YEAR-END CLOSE =====================
-- Opening balances carried into a year by the close of the previous one.
CREATE TABLE IF NOT EXISTS OpeningBalance (
  OpeningBalanceID INTEGER PRIMARY KEY AUTOINCREMENT,
  CompanyID     INTEGER NOT NULL REFERENCES Company(CompanyID),
  BranchID      INTEGER NOT NULL REFERENCES Branch(BranchID),
  FinancialYearID INTEGER NOT NULL REFERENCES FinancialYear(FinancialYearID),
  AccountID     INTEGER NOT NULL REFERENCES ChartOfAccounts(AccountID),
  Debit         REAL DEFAULT 0,
  Credit        REAL DEFAULT 0,
  CreatedAt     TEXT DEFAULT (datetime('now')),
  UNIQUE(FinancialYearID, BranchID, AccountID)
);
