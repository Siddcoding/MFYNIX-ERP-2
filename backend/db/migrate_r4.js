/**
 * R4 (customer-master enhancements): City, optional bank details, a
 * reconciliation/control account linking the customer to the GL, a customer
 * group ("control field"), a display-mode preference, free-form custom
 * attributes, a serial-number-required flag, SAP code / short customer code,
 * and a free-text reason captured on the record (e.g. why it was blocked or
 * deactivated). Added with ensureColumn so an existing database upgrades in
 * place - see the pattern in migrate_r1..r3.js.
 */
module.exports = function migrateR4(db) {
  const col = (t, c, d) => {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map(x => x.name);
    if (!cols.includes(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`);
  };

  // Address / location
  col('Customer', 'City', 'TEXT');

  // Bank details - optional, used for refunds/NEFT, never required at save time.
  col('Customer', 'BankName', 'TEXT');
  col('Customer', 'BankAccountNo', 'TEXT');
  col('Customer', 'BankIFSC', 'TEXT');

  // GL control / reconciliation account for this customer (SAP-style:
  // the account their sub-ledger balance reconciles against).
  col('Customer', 'ReconciliationAccountID', 'INTEGER REFERENCES ChartOfAccounts(AccountID)');

  // Classification/control field (drives grouping, reporting, credit policy).
  col('Customer', 'CustomerGroup', 'TEXT');

  // How this customer is shown in picklists/search across the app.
  col('Customer', 'DisplayMode', "TEXT DEFAULT 'Name'");

  // Free-form key/value custom attributes, stored as JSON text (same pattern
  // as Item.CustomAttributes).
  col('Customer', 'CustomAttributes', 'TEXT');

  // Whether sales to this customer must capture item serial numbers.
  col('Customer', 'RequireSerialTracking', 'INTEGER DEFAULT 0');

  // External/legacy identifiers.
  col('Customer', 'SAPCode', 'TEXT');
  col('Customer', 'CustomerCode', 'TEXT');

  // A free-text reason recorded against the record (status change, block,
  // special terms, etc.) - separate from DunningBlockReason, which is
  // specifically about dunning.
  col('Customer', 'Reason', 'TEXT');
};
