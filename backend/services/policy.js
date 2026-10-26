/**
 * Business-rule guards shared by the transaction routes.
 *
 * These live in one place because the same rule has to hold no matter which
 * route reaches the database - a sale, an inter-branch transfer and a stock
 * adjustment all have to agree on what "available stock" means, or the
 * controls become theatre.
 *
 * Every function here is designed to be called INSIDE the caller's
 * transaction and to throw. Throwing aborts the surrounding better-sqlite3
 * transaction, so a rejected invoice leaves no partial rows behind.
 */

const db = require('../db');

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

/** Per-company policy switches, with safe defaults if the row is missing. */
function getSettings(companyId) {
  const row = db.prepare('SELECT * FROM CompanySettings WHERE CompanyID = ?').get(companyId);
  return {
    allowNegativeStock: row ? !!row.AllowNegativeStock : false,
    enforceCreditLimit: row ? !!row.EnforceCreditLimit : true
  };
}

function updateSettings(companyId, { allowNegativeStock, enforceCreditLimit }) {
  db.prepare('INSERT OR IGNORE INTO CompanySettings (CompanyID) VALUES (?)').run(companyId);
  const sets = [], vals = [];
  if (allowNegativeStock !== undefined) { sets.push('AllowNegativeStock = ?'); vals.push(allowNegativeStock ? 1 : 0); }
  if (enforceCreditLimit !== undefined) { sets.push('EnforceCreditLimit = ?'); vals.push(enforceCreditLimit ? 1 : 0); }
  if (sets.length === 0) return getSettings(companyId);
  db.prepare(`UPDATE CompanySettings SET ${sets.join(', ')}, UpdatedAt = datetime('now') WHERE CompanyID = ?`)
    .run(...vals, companyId);
  return getSettings(companyId);
}

/** Current stock of one item at one branch, straight from the ledger. */
function stockOnHand(companyId, branchId, itemId) {
  return db.prepare(
    `SELECT COALESCE(SUM(InQty),0) - COALESCE(SUM(OutQty),0) AS s
     FROM StockLedger WHERE CompanyID = ? AND BranchID = ? AND ItemID = ?`
  ).get(companyId, branchId, itemId).s;
}

/**
 * Refuses to let stock go negative.
 *
 * `lines` is [{ itemId, qty }]. Quantities for the same item are summed first,
 * because a single invoice can legitimately list the same item on two lines -
 * checking each line separately would let 2 x 60 units pass against a stock of
 * 100. Throws on the first item that can't be covered.
 *
 * Skipped entirely when the company has opted into negative stock.
 */
function assertStockAvailable(companyId, branchId, lines, { action = 'sell' } = {}) {
  if (getSettings(companyId).allowNegativeStock) return;

  const needed = new Map();
  lines.forEach(l => needed.set(l.itemId, (needed.get(l.itemId) || 0) + Number(l.qty || 0)));

  for (const [itemId, qty] of needed) {
    const available = stockOnHand(companyId, branchId, itemId);
    if (qty > available + 0.0001) {
      const item = db.prepare('SELECT ItemName, Unit FROM Item WHERE ItemID = ?').get(itemId);
      const name = item ? item.ItemName : `item ${itemId}`;
      const unit = item && item.Unit ? ' ' + item.Unit : '';
      const branch = db.prepare('SELECT BranchName FROM Branch WHERE BranchID = ?').get(branchId);
      throw new Error(
        `Not enough stock to ${action} ${round2(qty)}${unit} of ${name} at ${branch ? branch.BranchName : 'this branch'} ` +
        `- only ${round2(available)}${unit} on hand. Record a purchase or a stock adjustment first, ` +
        `or ask a Super Admin to allow negative stock for this company.`
      );
    }
  }
}

/**
 * Real outstanding receivable from one customer: everything billed, less
 * everything allocated against those invoices, less anything cancelled.
 *
 * This used to be total-billed, because receipts weren't tied to invoices. Now
 * that Allocation exists (see routes/outstanding.js), a customer who has paid
 * down their balance is correctly shown as having room under their limit again.
 */
function customerOutstanding(companyId, customerId) {
  const billed = db.prepare(
    `SELECT COALESCE(SUM(NetAmount),0) AS t FROM SalesHeader
     WHERE CompanyID = ? AND CustomerID = ? AND Status != 'Cancelled'`
  ).get(companyId, customerId).t;

  const allocated = db.prepare(
    `SELECT COALESCE(SUM(a.Amount),0) AS t FROM Allocation a
     JOIN SalesHeader s ON s.InvoiceID = a.DocID AND a.DocType = 'SalesInvoice'
     WHERE a.CompanyID = ? AND a.PartyType = 'Customer' AND a.PartyID = ? AND s.Status != 'Cancelled'`
  ).get(companyId, customerId).t;

  const opening = db.prepare('SELECT COALESCE(OpeningBalance,0) AS o FROM Customer WHERE CustomerID = ?')
    .get(customerId);

  return round2(billed - allocated + (opening ? opening.o : 0));
}

/**
 * Refuses a sale that would push a customer past their credit limit.
 * A limit of 0 means "no limit set", which is how the master defaults.
 */
function assertWithinCreditLimit(companyId, customerId, invoiceAmount) {
  if (!getSettings(companyId).enforceCreditLimit) return;

  const customer = db.prepare('SELECT CustomerName, CreditLimit FROM Customer WHERE CustomerID = ? AND CompanyID = ?')
    .get(customerId, companyId);
  if (!customer) throw new Error('Customer not found');

  const limit = Number(customer.CreditLimit || 0);
  if (limit <= 0) return;   // no limit configured for this customer

  const outstanding = customerOutstanding(companyId, customerId);
  const after = round2(outstanding + Number(invoiceAmount || 0));
  if (after > limit + 0.0001) {
    throw new Error(
      `This invoice would take ${customer.CustomerName} to ₹${after.toLocaleString('en-IN')} against a credit limit of ` +
      `₹${limit.toLocaleString('en-IN')} (currently outstanding ₹${outstanding.toLocaleString('en-IN')}). ` +
      `Raise the limit on the customer master, collect a payment first, or ask a Super Admin to turn off credit-limit enforcement.`
    );
  }
}

module.exports = {
  getSettings, updateSettings, stockOnHand,
  assertStockAvailable, customerOutstanding, assertWithinCreditLimit
};
