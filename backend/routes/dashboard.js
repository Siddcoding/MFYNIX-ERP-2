const express = require('express');
const db = require('../db');
const { requireAuth, resolveBranchScope } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/kpis', (req, res) => {
  const branchId = resolveBranchScope(req);
  const companyId = req.user.companyId;
  const branchFilterSales = branchId ? 'AND BranchID = ?' : '';
  const args = branchId ? [companyId, branchId] : [companyId];

  const todaySales = db.prepare(
    `SELECT COALESCE(SUM(NetAmount),0) AS total FROM SalesHeader
     WHERE CompanyID = ? ${branchFilterSales} AND Status != 'Cancelled' AND date(InvoiceDate) = date('now')`
  ).get(...args).total;

  const monthlySales = db.prepare(
    `SELECT COALESCE(SUM(NetAmount),0) AS total FROM SalesHeader
     WHERE CompanyID = ? ${branchFilterSales} AND Status != 'Cancelled' AND strftime('%Y-%m', InvoiceDate) = strftime('%Y-%m', 'now')`
  ).get(...args).total;

  const todayPurchase = db.prepare(
    `SELECT COALESCE(SUM(NetAmount),0) AS total FROM PurchaseHeader
     WHERE CompanyID = ? ${branchFilterSales} AND Status != 'Cancelled' AND date(PurchaseDate) = date('now')`
  ).get(...args).total;

  const monthlyPurchase = db.prepare(
    `SELECT COALESCE(SUM(NetAmount),0) AS total FROM PurchaseHeader
     WHERE CompanyID = ? ${branchFilterSales} AND Status != 'Cancelled' AND strftime('%Y-%m', PurchaseDate) = strftime('%Y-%m', 'now')`
  ).get(...args).total;

  const stockValue = db.prepare(
    `SELECT COALESCE(SUM((sl.InQty - sl.OutQty) * i.PurchaseRate), 0) AS val
     FROM (SELECT ItemID, BranchID, SUM(InQty) AS InQty, SUM(OutQty) AS OutQty
           FROM StockLedger WHERE CompanyID = ? ${branchFilterSales} GROUP BY ItemID, BranchID) sl
     JOIN Item i ON i.ItemID = sl.ItemID`
  ).get(...args).val;

  const gstCollected = db.prepare(
    `SELECT COALESCE(SUM(GST),0) AS val FROM SalesHeader WHERE CompanyID = ? ${branchFilterSales} AND Status != 'Cancelled'`
  ).get(...args).val;
  const gstInputCredit = db.prepare(
    `SELECT COALESCE(SUM(GST),0) AS val FROM PurchaseHeader WHERE CompanyID = ? ${branchFilterSales} AND Status != 'Cancelled'`
  ).get(...args).val;
  const gstPayable = gstCollected - gstInputCredit;

  res.json({
    todaySales, monthlySales, todayPurchase, monthlyPurchase, stockValue,
    gstPayable, gstCollected, gstInputCredit,
    scope: branchId ? 'branch' : 'consolidated'
  });
});

// Last 14 days of sales & purchase totals, for the gradient area / trend chart
router.get('/trend', (req, res) => {
  const branchId = resolveBranchScope(req);
  const companyId = req.user.companyId;
  const branchFilter = branchId ? 'AND BranchID = ?' : '';
  const args = branchId ? [companyId, branchId] : [companyId];

  const salesByDay = db.prepare(
    `SELECT date(InvoiceDate) AS d, SUM(NetAmount) AS total FROM SalesHeader
     WHERE CompanyID = ? ${branchFilter} AND Status != 'Cancelled' AND date(InvoiceDate) >= date('now', '-13 days')
     GROUP BY d`
  ).all(...args);
  const purchaseByDay = db.prepare(
    `SELECT date(PurchaseDate) AS d, SUM(NetAmount) AS total FROM PurchaseHeader
     WHERE CompanyID = ? ${branchFilter} AND Status != 'Cancelled' AND date(PurchaseDate) >= date('now', '-13 days')
     GROUP BY d`
  ).all(...args);

  const salesMap = Object.fromEntries(salesByDay.map(r => [r.d, r.total]));
  const purchaseMap = Object.fromEntries(purchaseByDay.map(r => [r.d, r.total]));

  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    days.push({ date: key, sales: salesMap[key] || 0, purchase: purchaseMap[key] || 0 });
  }
  res.json(days);
});

// Branch performance comparison - only meaningful head-office wide
router.get('/branch-performance', (req, res) => {
  const rows = db.prepare(
    `SELECT b.BranchID, b.BranchName,
            COALESCE((SELECT SUM(NetAmount) FROM SalesHeader s WHERE s.BranchID = b.BranchID AND s.Status != 'Cancelled'
                      AND strftime('%Y-%m', s.InvoiceDate) = strftime('%Y-%m','now')), 0) AS MonthlySales,
            COALESCE((SELECT SUM(NetAmount) FROM PurchaseHeader p WHERE p.BranchID = b.BranchID AND p.Status != 'Cancelled'
                      AND strftime('%Y-%m', p.PurchaseDate) = strftime('%Y-%m','now')), 0) AS MonthlyPurchase
     FROM Branch b WHERE b.CompanyID = ? AND b.IsActive = 1
     ORDER BY MonthlySales DESC`
  ).all(req.user.companyId);
  res.json(rows);
});

router.get('/top-customers', (req, res) => {
  const branchId = resolveBranchScope(req);
  const rows = branchId
    ? db.prepare(
        `SELECT c.CustomerName, SUM(s.NetAmount) AS Total FROM SalesHeader s
         JOIN Customer c ON c.CustomerID = s.CustomerID
         WHERE s.CompanyID = ? AND s.BranchID = ? AND s.Status != 'Cancelled' GROUP BY c.CustomerID ORDER BY Total DESC LIMIT 10`
      ).all(req.user.companyId, branchId)
    : db.prepare(
        `SELECT c.CustomerName, SUM(s.NetAmount) AS Total FROM SalesHeader s
         JOIN Customer c ON c.CustomerID = s.CustomerID
         WHERE s.CompanyID = ? AND s.Status != 'Cancelled' GROUP BY c.CustomerID ORDER BY Total DESC LIMIT 10`
      ).all(req.user.companyId);
  res.json(rows);
});

router.get('/recent-transactions', (req, res) => {
  const branchId = resolveBranchScope(req);
  const args = branchId ? [req.user.companyId, branchId] : [req.user.companyId];
  const rows = db.prepare(
    `SELECT 'Sale' AS Type, InvoiceNo AS RefNo, InvoiceDate AS Date, NetAmount AS Amount, BranchID, Status FROM SalesHeader
     WHERE CompanyID = ? ${branchId ? 'AND BranchID = ?' : ''}
     UNION ALL
     SELECT 'Purchase' AS Type, PurchaseNo AS RefNo, PurchaseDate AS Date, NetAmount AS Amount, BranchID, Status FROM PurchaseHeader
     WHERE CompanyID = ? ${branchId ? 'AND BranchID = ?' : ''}
     ORDER BY Date DESC LIMIT 15`
  ).all(...(branchId ? [...args, ...args] : [...args, ...args]));
  res.json(rows);
});

module.exports = router;
