/**
 * Perpetual stock valuation by weighted average (INV-01 / INV-02).
 *
 * Every stock movement goes through postStock(), which keeps a running
 * quantity and value per branch + item (ItemCost), records the cost on the
 * stock-ledger row, and returns the value so the caller can post the matching
 * journal. Because ItemCost.Value is the sum of the ledger's ValueAmount, the
 * stock valuation and the Inventory ledger account can be reconciled to the
 * paisa (FIN-04).
 *
 * FIFO is not implemented: weighted average was the first option in the
 * requirement's open decision and keeps one cost per item per branch.
 */
const db = require('../db');

function round2(n) { return Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100; }

function isPerpetual(companyId) {
  const r = db.prepare('SELECT PerpetualInventory AS p FROM CompanySettings WHERE CompanyID = ?').get(companyId);
  return r ? r.p !== 0 : true;
}

function costRow(companyId, branchId, itemId) {
  db.prepare('INSERT OR IGNORE INTO ItemCost (CompanyID, BranchID, ItemID, Qty, Value) VALUES (?,?,?,0,0)').run(companyId, branchId, itemId);
  return db.prepare('SELECT * FROM ItemCost WHERE CompanyID = ? AND BranchID = ? AND ItemID = ?').get(companyId, branchId, itemId);
}

/** Cost per unit to use when there is no stock on hand to average. */
function fallbackCost(companyId, itemId) {
  const it = db.prepare('SELECT PurchaseRate, StandardCost FROM Item WHERE ItemID = ? AND CompanyID = ?').get(itemId, companyId) || {};
  const last = db.prepare(
    `SELECT UnitCost FROM StockLedger WHERE CompanyID = ? AND ItemID = ? AND InQty > 0 AND UnitCost > 0 ORDER BY StockLedgerID DESC LIMIT 1`
  ).get(companyId, itemId);
  return (last && last.UnitCost) || it.StandardCost || it.PurchaseRate || 0;
}

/**
 * Posts one stock movement.
 *   dir 'in'  : needs unitCost (or value) - the cost of what came in.
 *   dir 'out' : costed at the running average unless `value` is given (used to
 *               reverse an earlier movement at exactly the cost it carried).
 * Returns { value, unitCost, ledgerId }. `value` is always positive.
 */
function postStock({ companyId, branchId, itemId, transType, refType = null, refId = null, qty, dir, date, unitCost, value }) {
  const q = Number(qty);
  if (!(q > 0)) throw new Error('Stock quantity must be greater than zero');
  const perpetual = isPerpetual(companyId);
  let v = 0, uc = 0;

  if (perpetual) {
    const row = costRow(companyId, branchId, itemId);
    if (dir === 'in') {
      v = value !== undefined ? round2(value) : round2(q * Number(unitCost || 0));
      uc = q ? v / q : 0;
      db.prepare('UPDATE ItemCost SET Qty = Qty + ?, Value = Value + ? WHERE CompanyID = ? AND BranchID = ? AND ItemID = ?')
        .run(q, v, companyId, branchId, itemId);
    } else {
      if (value !== undefined) {
        v = round2(value);
      } else if (row.Qty > 0 && q >= row.Qty - 1e-9) {
        v = round2(row.Value);                       // selling the last unit clears the value exactly
      } else {
        const avg = row.Qty > 0 ? row.Value / row.Qty : fallbackCost(companyId, itemId);
        v = round2(q * avg);
      }
      uc = q ? v / q : 0;
      db.prepare('UPDATE ItemCost SET Qty = Qty - ?, Value = Value - ? WHERE CompanyID = ? AND BranchID = ? AND ItemID = ?')
        .run(q, v, companyId, branchId, itemId);
    }
  }

  const ledgerId = db.prepare(
    `INSERT INTO StockLedger (CompanyID, BranchID, ItemID, TransType, RefType, RefID, InQty, OutQty, TransDate, UnitCost, ValueAmount)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(companyId, branchId, itemId, transType, refType, refId,
    dir === 'in' ? q : 0, dir === 'out' ? q : 0,
    date || new Date().toISOString().slice(0, 10), uc, dir === 'in' ? v : -v).lastInsertRowid;

  return { value: v, unitCost: uc, ledgerId };
}

/** Stock value of one branch/item, or of everything for a company. */
function stockValue(companyId, { branchId, itemId } = {}) {
  const where = ['CompanyID = ?']; const args = [companyId];
  if (branchId) { where.push('BranchID = ?'); args.push(branchId); }
  if (itemId) { where.push('ItemID = ?'); args.push(itemId); }
  return round2(db.prepare(`SELECT COALESCE(SUM(Value),0) AS v FROM ItemCost WHERE ${where.join(' AND ')}`).get(...args).v);
}

module.exports = { round2, isPerpetual, postStock, stockValue, fallbackCost, costRow };
