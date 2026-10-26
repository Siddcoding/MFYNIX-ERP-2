const express = require('express');
const db = require('../db');
const { requireAuth, resolveBranchScope } = require('../middleware/auth');
const { logAudit } = require('./auth');
const { assertStockAvailable } = require('../services/policy');
const { postJournalEntry } = require('./accounts');
const { accountId: acct, assertPeriodOpen } = require('../services/posting');
const { postStock, isPerpetual, costRow, fallbackCost } = require('../services/valuation');

const router = express.Router();
router.use(requireAuth);

// Current stock = SUM(InQty) - SUM(OutQty), per branch/item
router.get('/stock', (req, res) => {
  const branchId = resolveBranchScope(req);
  const rows = branchId
    ? db.prepare(
        `SELECT sl.BranchID, b.BranchName, sl.ItemID, i.ItemName, i.Unit, i.ReorderLevel,
                SUM(sl.InQty) - SUM(sl.OutQty) AS CurrentStock
         FROM StockLedger sl
         JOIN Item i ON i.ItemID = sl.ItemID
         JOIN Branch b ON b.BranchID = sl.BranchID
         WHERE sl.CompanyID = ? AND sl.BranchID = ?
         GROUP BY sl.BranchID, sl.ItemID
         ORDER BY i.ItemName`
      ).all(req.user.companyId, branchId)
    : db.prepare(
        `SELECT sl.BranchID, b.BranchName, sl.ItemID, i.ItemName, i.Unit, i.ReorderLevel,
                SUM(sl.InQty) - SUM(sl.OutQty) AS CurrentStock
         FROM StockLedger sl
         JOIN Item i ON i.ItemID = sl.ItemID
         JOIN Branch b ON b.BranchID = sl.BranchID
         WHERE sl.CompanyID = ?
         GROUP BY sl.BranchID, sl.ItemID
         ORDER BY b.BranchName, i.ItemName`
      ).all(req.user.companyId);
  res.json(rows);
});

router.get('/low-stock', (req, res) => {
  const branchId = resolveBranchScope(req);
  const all = db.prepare(
    `SELECT sl.BranchID, b.BranchName, sl.ItemID, i.ItemName, i.ReorderLevel,
            SUM(sl.InQty) - SUM(sl.OutQty) AS CurrentStock
     FROM StockLedger sl
     JOIN Item i ON i.ItemID = sl.ItemID
     JOIN Branch b ON b.BranchID = sl.BranchID
     WHERE sl.CompanyID = ? ${branchId ? 'AND sl.BranchID = ?' : ''}
     GROUP BY sl.BranchID, sl.ItemID
     HAVING CurrentStock <= i.ReorderLevel`
  ).all(...(branchId ? [req.user.companyId, branchId] : [req.user.companyId]));
  res.json(all);
});

// Inter-branch stock transfer - writes a TRANSFER_OUT at source and TRANSFER_IN at destination
router.post('/transfer', (req, res) => {
  const { fromBranchId, toBranchId, itemId, qty } = req.body;
  if (!fromBranchId || !toBranchId || !itemId || !qty) {
    return res.status(400).json({ error: 'fromBranchId, toBranchId, itemId and qty are required' });
  }
  if (fromBranchId === toBranchId) {
    return res.status(400).json({ error: 'Source and destination branch must differ' });
  }
  // Branch-scoped users can only transfer stock out of their own branch
  if (req.user.branchId && req.user.branchId !== Number(fromBranchId)) {
    return res.status(403).json({ error: 'You can only transfer stock from your own branch' });
  }

  const tx = db.transaction(() => {
    // Same rule as a sale: you can't move out stock the source branch hasn't got.
    assertStockAvailable(req.user.companyId, fromBranchId, [{ itemId, qty }], { action: 'transfer' });

    const transferResult = db.prepare(
      `INSERT INTO StockTransfer (CompanyID, FromBranchID, ToBranchID, ItemID, Qty, CreatedBy)
       VALUES (?,?,?,?,?,?)`
    ).run(req.user.companyId, fromBranchId, toBranchId, itemId, qty, req.user.userId);
    const transferId = transferResult.lastInsertRowid;

    const companyId = req.user.companyId;
    const today = new Date().toISOString().slice(0, 10);
    assertPeriodOpen(companyId, 'Inventory', today);
    // Stock leaves the source at its average cost and arrives at the same value.
    const out = postStock({ companyId, branchId: fromBranchId, itemId, transType: 'TRANSFER_OUT', refType: 'StockTransfer', refId: transferId, qty, dir: 'out', date: today });
    postStock({ companyId, branchId: toBranchId, itemId, transType: 'TRANSFER_IN', refType: 'StockTransfer', refId: transferId, qty, dir: 'in', date: today, value: out.value });
    if (isPerpetual(companyId) && out.value > 0) {
      // Each branch's books stay balanced through an inter-branch clearing account.
      postJournalEntry(db, { companyId, branchId: fromBranchId, entryDate: today, narration: `Stock transfer #${transferId} out`,
        sourceType: 'StockTransfer', sourceId: transferId, createdBy: req.user.userId,
        lines: [{ accountId: acct(companyId, '1250'), debit: out.value, credit: 0 }, { accountId: acct(companyId, '1200'), debit: 0, credit: out.value }] });
      postJournalEntry(db, { companyId, branchId: toBranchId, entryDate: today, narration: `Stock transfer #${transferId} in`,
        sourceType: 'StockTransfer', sourceId: transferId, createdBy: req.user.userId,
        lines: [{ accountId: acct(companyId, '1200'), debit: out.value, credit: 0 }, { accountId: acct(companyId, '1250'), debit: 0, credit: out.value }] });
    }

    logAudit({
      companyId: req.user.companyId, branchId: fromBranchId, userId: req.user.userId,
      action: 'STOCK_TRANSFER', entityType: 'StockTransfer', entityId: transferId,
      details: `${qty} units to branch ${toBranchId}`, ip: req.ip
    });

    return transferId;
  });

  try {
    const transferId = tx();
    res.status(201).json({ transferId });
  } catch (e) {
    const isRuleViolation = /Not enough stock|locked/i.test(e.message);
    res.status(isRuleViolation ? 400 : 500).json({
      error: isRuleViolation ? e.message : 'Transfer failed: ' + e.message
    });
  }
});

// ---- Stock adjustment / opening balance ----
//
// This is what you use to load opening stock when going live, and to correct
// the book quantity after a physical count. Without it the only way to get
// stock into the system is to raise a purchase bill, which would also create
// a supplier liability that never existed.
//
// ACCOUNTING NOTE: this deliberately writes to the stock ledger ONLY, with no
// journal entry. The system expenses purchases directly (Dr Purchases), which
// is periodic-inventory accounting - there is no perpetual Inventory asset
// balance for an adjustment to move. Posting an adjustment to the ledger here
// would make the books inconsistent with how purchases are already treated.
// Closing stock is brought into the P&L at period end by the accountant, the
// same way it works in Tally under periodic inventory.
const ADJUSTMENT_TYPES = ['Opening Stock', 'Increase', 'Decrease', 'Damage / Loss', 'Physical Count Correction'];

router.get('/adjustment-types', (req, res) => res.json(ADJUSTMENT_TYPES));

// POST /inventory/adjust
// { branchId, itemId, adjustmentType, qty, reason, adjustDate }
// For "Physical Count Correction", qty is the COUNTED quantity and the system
// works out the difference itself - that's how a stock take actually happens,
// and it avoids the user having to do the subtraction (and get it wrong).
router.post('/adjust', (req, res) => {
  const branchId = req.user.branchId || req.body.branchId;
  if (!branchId) return res.status(400).json({ error: 'branchId is required (head-office users must specify one)' });
  if (req.user.branchId && Number(req.body.branchId || branchId) !== req.user.branchId) {
    return res.status(403).json({ error: 'You can only adjust stock in your own branch' });
  }

  const { itemId, adjustmentType, qty, reason, adjustDate } = req.body;
  if (!itemId || !adjustmentType || qty === undefined || qty === null || qty === '') {
    return res.status(400).json({ error: 'itemId, adjustmentType and qty are required' });
  }
  if (!ADJUSTMENT_TYPES.includes(adjustmentType)) {
    return res.status(400).json({ error: `adjustmentType must be one of: ${ADJUSTMENT_TYPES.join(', ')}` });
  }
  const quantity = Number(qty);
  if (!Number.isFinite(quantity) || quantity < 0) {
    return res.status(400).json({ error: 'qty must be a number of zero or more' });
  }
  if (!reason || String(reason).trim().length < 3) {
    return res.status(400).json({ error: 'A reason is required - stock adjustments must be explainable at audit' });
  }

  const item = db.prepare('SELECT * FROM Item WHERE ItemID = ? AND CompanyID = ?').get(itemId, req.user.companyId);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  const current = db.prepare(
    `SELECT COALESCE(SUM(InQty),0) - COALESCE(SUM(OutQty),0) AS stock
     FROM StockLedger WHERE CompanyID = ? AND BranchID = ? AND ItemID = ?`
  ).get(req.user.companyId, branchId, itemId).stock;

  let inQty = 0, outQty = 0, delta = 0;
  if (adjustmentType === 'Physical Count Correction') {
    delta = quantity - current;             // counted minus book
    if (Math.abs(delta) < 0.0001) {
      return res.status(400).json({ error: `The book quantity is already ${current} - nothing to correct` });
    }
    if (delta > 0) inQty = delta; else outQty = -delta;
  } else if (adjustmentType === 'Decrease' || adjustmentType === 'Damage / Loss') {
    if (quantity > current) {
      return res.status(400).json({ error: `Cannot remove ${quantity} - only ${current} in stock at this branch` });
    }
    outQty = quantity; delta = -quantity;
  } else {
    // Opening Stock / Increase
    if (adjustmentType === 'Opening Stock' && current !== 0) {
      return res.status(400).json({ error: `This item already has stock movement at this branch (currently ${current}). Use "Increase" or "Physical Count Correction" instead of Opening Stock.` });
    }
    inQty = quantity; delta = quantity;
  }

  const companyId = req.user.companyId;
  const when = adjustDate || new Date().toISOString().slice(0, 10);
  let ledgerId;
  try {
    db.transaction(() => {
      assertPeriodOpen(companyId, 'Inventory', when);
      const perpetual = isPerpetual(companyId);
      const dir = inQty > 0 ? 'in' : 'out';
      const q = inQty > 0 ? inQty : outQty;
      let unit = req.body.unitCost !== undefined && req.body.unitCost !== '' ? Number(req.body.unitCost) : null;
      if (unit !== null && !(unit >= 0)) throw new Error('unitCost must be zero or more');
      if (dir === 'in' && unit === null) {
        const r = costRow(companyId, branchId, itemId);
        unit = r.Qty > 0 ? r.Value / r.Qty : fallbackCost(companyId, itemId);
      }
      const m = postStock({ companyId, branchId, itemId, transType: 'ADJUSTMENT', refType: 'Adjustment', refId: null, qty: q, dir, date: when, unitCost: unit });
      ledgerId = m.ledgerId;
      if (perpetual && m.value > 0) {
        // Opening stock is funded from Capital / Opening Balance; other gains
        // and losses go to their own P&L accounts.
        const inv = acct(companyId, '1200');
        let lines;
        if (dir === 'in') {
          const other = acct(companyId, adjustmentType === 'Opening Stock' ? '3000' : '4910');
          lines = [{ accountId: inv, debit: m.value, credit: 0 }, { accountId: other, debit: 0, credit: m.value }];
        } else {
          lines = [{ accountId: acct(companyId, '5910'), debit: m.value, credit: 0 }, { accountId: inv, debit: 0, credit: m.value }];
        }
        postJournalEntry(db, { companyId, branchId, entryDate: when, narration: `Stock adjustment - ${adjustmentType}: ${item.ItemName} (${String(reason).trim()})`,
          sourceType: 'StockAdjustment', sourceId: ledgerId, createdBy: req.user.userId, lines });
      }
    })();
  } catch (e) {
    return res.status(/locked|unitCost/.test(e.message) ? 400 : 500).json({ error: e.message });
  }
  const result = { lastInsertRowid: ledgerId };

  logAudit({
    companyId: req.user.companyId, branchId, userId: req.user.userId,
    action: 'STOCK_ADJUSTMENT', entityType: 'StockLedger', entityId: result.lastInsertRowid,
    details: `${adjustmentType} ${item.ItemName}: ${current} -> ${current + delta} (${reason})`, ip: req.ip
  });

  res.status(201).json({ itemName: item.ItemName, previousStock: current, newStock: current + delta, change: delta });
});

// ---- Stock ledger history for one item at one branch ----
// The audit trail behind a stock figure: every movement, with a running balance.
router.get('/ledger', (req, res) => {
  const branchId = req.user.branchId || (req.query.branchId ? Number(req.query.branchId) : null);
  const itemId = req.query.itemId;
  if (!itemId) return res.status(400).json({ error: 'itemId is required' });
  if (!branchId) return res.status(400).json({ error: 'branchId is required' });

  const rows = db.prepare(
    `SELECT sl.*, i.ItemName, i.Unit FROM StockLedger sl JOIN Item i ON i.ItemID = sl.ItemID
     WHERE sl.CompanyID = ? AND sl.BranchID = ? AND sl.ItemID = ?
     ORDER BY sl.TransDate, sl.StockLedgerID`
  ).all(req.user.companyId, branchId, itemId);

  let balance = 0;
  const entries = rows.map(r => {
    balance += (r.InQty || 0) - (r.OutQty || 0);
    return { ...r, RunningBalance: balance };
  });
  res.json({ entries, closingStock: balance });
});

module.exports = router;
