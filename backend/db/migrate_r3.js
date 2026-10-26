/**
 * R3 (compliance) schema: the fields an e-invoice (IRN/QR) and an e-way bill
 * put back on a sales invoice, plus a log of every attempt.
 *
 * SalesHeader already has IRN and EWayBillNo (from the base schema); this adds
 * the acknowledgement, the signed QR, the e-way-bill validity and the statuses.
 */
module.exports = function migrateR3(db) {
  const col = (t, c, d) => {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map(x => x.name);
    if (!cols.includes(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`);
  };
  // e-invoice
  col('SalesHeader', 'AckNo', 'TEXT');
  col('SalesHeader', 'AckDate', 'TEXT');
  col('SalesHeader', 'SignedQR', 'TEXT');
  col('SalesHeader', 'EInvoiceStatus', 'TEXT');          // Generated / Cancelled
  col('SalesHeader', 'EInvoiceCancelledAt', 'TEXT');
  col('SalesHeader', 'EInvoiceMode', 'TEXT');            // sandbox / live
  // e-way bill
  col('SalesHeader', 'EWayBillDate', 'TEXT');
  col('SalesHeader', 'EWayBillValidUpto', 'TEXT');
  col('SalesHeader', 'EWayBillStatus', 'TEXT');          // Generated / Cancelled
  col('SalesHeader', 'TransportMode', 'TEXT');
  col('SalesHeader', 'VehicleNo', 'TEXT');
  col('SalesHeader', 'Distance', 'INTEGER');

  db.exec(`
    CREATE TABLE IF NOT EXISTS ComplianceLog (
      LogID INTEGER PRIMARY KEY AUTOINCREMENT,
      CompanyID INTEGER NOT NULL, BranchID INTEGER,
      DocType TEXT NOT NULL,          -- SalesInvoice
      DocID INTEGER NOT NULL,
      Kind TEXT NOT NULL,             -- EInvoice / EWayBill
      Action TEXT NOT NULL,           -- Generate / Cancel
      Status TEXT NOT NULL,           -- Success / Failed
      Reference TEXT,                 -- IRN or EWB number
      Mode TEXT,                      -- sandbox / live
      PayloadJson TEXT,
      Detail TEXT,
      CreatedBy INTEGER, CreatedAt TEXT DEFAULT (datetime('now'))
    );
  `);
};
