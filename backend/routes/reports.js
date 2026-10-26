const express = require('express');
const db = require('../db');
const { requireAuth, resolveBranchScope } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const REPORT_ROLES = ['Super Admin', 'Company Admin', 'Accountant', 'Branch Manager', 'Auditor', 'Store Manager'];
router.use((req, res, next) => {
  if (!REPORT_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'You do not have access to Reports' });
  }
  next();
});

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
function defaultFrom() { const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().slice(0, 10); }
function today() { return new Date().toISOString().slice(0, 10); }

function range(req) {
  return { from: req.query.from || defaultFrom(), to: req.query.to || today() };
}

/**
 * Every report returns the same envelope: { title, columns, rows, totals }.
 * That means one CSV exporter and one table renderer serve all of them, and a
 * new report is a query rather than a query plus a screen plus an exporter.
 */
function report(title, columns, rows, totals = null, extra = {}) {
  return { title, columns, rows, totals, ...extra };
}

// ---------------- Day Book: every transaction on a date range, in order ----------------
router.get('/day-book', (req, res) => {
  const branchId = resolveBranchScope(req);
  const { from, to } = range(req);
  const args = branchId
    ? [req.user.companyId, from, to, branchId]
    : [req.user.companyId, from, to];

  const rows = db.prepare(
    `SELECT j.EntryDate AS Date, j.SourceType AS Type, j.Narration AS Particulars,
            b.BranchName AS Branch,
            (SELECT COALESCE(SUM(Debit),0) FROM JournalLine WHERE JournalID = j.JournalID) AS Debit,
            (SELECT GROUP_CONCAT(a.AccountName, ' / ') FROM JournalLine jl
             JOIN ChartOfAccounts a ON a.AccountID = jl.AccountID
             WHERE jl.JournalID = j.JournalID AND jl.Debit > 0) AS DebitAccounts,
            (SELECT GROUP_CONCAT(a.AccountName, ' / ') FROM JournalLine jl
             JOIN ChartOfAccounts a ON a.AccountID = jl.AccountID
             WHERE jl.JournalID = j.JournalID AND jl.Credit > 0) AS CreditAccounts
     FROM JournalEntry j JOIN Branch b ON b.BranchID = j.BranchID
     WHERE j.CompanyID = ? AND date(j.EntryDate) BETWEEN date(?) AND date(?)
       ${branchId ? 'AND j.BranchID = ?' : ''}
     ORDER BY date(j.EntryDate), j.JournalID`
  ).all(...args);

  res.json(report('Day Book',
    [
      { key: 'Date', label: 'Date' }, { key: 'Type', label: 'Type' },
      { key: 'Particulars', label: 'Particulars' }, { key: 'Branch', label: 'Branch' },
      { key: 'DebitAccounts', label: 'Debit to' }, { key: 'CreditAccounts', label: 'Credit to' },
      { key: 'Debit', label: 'Amount', align: 'right', money: true }
    ],
    rows.map(r => ({ ...r, Debit: round2(r.Debit) })),
    { Debit: round2(rows.reduce((s, r) => s + r.Debit, 0)) },
    { from, to }
  ));
});

// ---------------- Cash Flow: movement through Cash and Bank ----------------
router.get('/cash-flow', (req, res) => {
  const branchId = resolveBranchScope(req);
  const { from, to } = range(req);
  const args = branchId ? [req.user.companyId, from, to, branchId] : [req.user.companyId, from, to];

  // Every entry that touched Cash or Bank, grouped by what the other side was.
  const rows = db.prepare(
    `SELECT other.AccountName AS Head, other.AccountType AS Type,
            COALESCE(SUM(CASE WHEN money.Debit > 0 THEN money.Debit ELSE 0 END),0) AS Inflow,
            COALESCE(SUM(CASE WHEN money.Credit > 0 THEN money.Credit ELSE 0 END),0) AS Outflow
     FROM JournalEntry j
     JOIN JournalLine money ON money.JournalID = j.JournalID
     JOIN ChartOfAccounts cash ON cash.AccountID = money.AccountID AND cash.AccountCode IN ('1000','1010')
     JOIN JournalLine otherLine ON otherLine.JournalID = j.JournalID AND otherLine.JournalLineID != money.JournalLineID
     JOIN ChartOfAccounts other ON other.AccountID = otherLine.AccountID
     WHERE j.CompanyID = ? AND date(j.EntryDate) BETWEEN date(?) AND date(?)
       ${branchId ? 'AND j.BranchID = ?' : ''}
     GROUP BY other.AccountID ORDER BY (Inflow + Outflow) DESC`
  ).all(...args);

  // Opening and closing cash position, so the movement can be checked against it.
  const posArgs = branchId ? [req.user.companyId, branchId] : [req.user.companyId];
  const positionAt = (date) => db.prepare(
    `SELECT COALESCE(SUM(jl.Debit),0) - COALESCE(SUM(jl.Credit),0) AS bal
     FROM JournalLine jl JOIN JournalEntry j ON j.JournalID = jl.JournalID
     JOIN ChartOfAccounts a ON a.AccountID = jl.AccountID AND a.AccountCode IN ('1000','1010')
     WHERE j.CompanyID = ? ${branchId ? 'AND j.BranchID = ?' : ''} AND date(j.EntryDate) <= date(?)`
  ).get(...posArgs, date).bal;

  const opening = round2(positionAt(new Date(new Date(from).getTime() - 86400000).toISOString().slice(0, 10)));
  const closing = round2(positionAt(to));

  res.json(report('Cash Flow',
    [
      { key: 'Head', label: 'Against' }, { key: 'Type', label: 'Type' },
      { key: 'Inflow', label: 'Cash in', align: 'right', money: true },
      { key: 'Outflow', label: 'Cash out', align: 'right', money: true },
      { key: 'Net', label: 'Net', align: 'right', money: true }
    ],
    rows.map(r => ({ ...r, Inflow: round2(r.Inflow), Outflow: round2(r.Outflow), Net: round2(r.Inflow - r.Outflow) })),
    {
      Inflow: round2(rows.reduce((s, r) => s + r.Inflow, 0)),
      Outflow: round2(rows.reduce((s, r) => s + r.Outflow, 0)),
      Net: round2(rows.reduce((s, r) => s + r.Inflow - r.Outflow, 0))
    },
    { from, to, openingCash: opening, closingCash: closing }
  ));
});

// ---------------- Sales Register ----------------
router.get('/sales-register', (req, res) => {
  const branchId = resolveBranchScope(req);
  const { from, to } = range(req);
  const args = branchId ? [req.user.companyId, from, to, branchId] : [req.user.companyId, from, to];
  const rows = db.prepare(
    `SELECT s.InvoiceNo AS Invoice, s.InvoiceDate AS Date, c.CustomerName AS Customer,
            c.GSTIN AS GSTIN, b.BranchName AS Branch, s.Total AS Taxable, s.GST AS GST,
            s.NetAmount AS Total, s.Status AS Status
     FROM SalesHeader s JOIN Customer c ON c.CustomerID = s.CustomerID
     JOIN Branch b ON b.BranchID = s.BranchID
     WHERE s.CompanyID = ? AND date(s.InvoiceDate) BETWEEN date(?) AND date(?)
       ${branchId ? 'AND s.BranchID = ?' : ''}
     ORDER BY date(s.InvoiceDate), s.InvoiceID`
  ).all(...args);
  const live = rows.filter(r => r.Status !== 'Cancelled');
  res.json(report('Sales Register',
    [
      { key: 'Invoice', label: 'Invoice' }, { key: 'Date', label: 'Date' },
      { key: 'Customer', label: 'Customer' }, { key: 'GSTIN', label: 'GSTIN' },
      { key: 'Branch', label: 'Branch' },
      { key: 'Taxable', label: 'Taxable', align: 'right', money: true },
      { key: 'GST', label: 'GST', align: 'right', money: true },
      { key: 'Total', label: 'Total', align: 'right', money: true },
      { key: 'Status', label: 'Status' }
    ],
    rows,
    {
      Taxable: round2(live.reduce((s, r) => s + r.Taxable, 0)),
      GST: round2(live.reduce((s, r) => s + r.GST, 0)),
      Total: round2(live.reduce((s, r) => s + r.Total, 0))
    },
    { from, to, note: 'Totals exclude cancelled invoices.' }
  ));
});

// ---------------- Purchase Register ----------------
router.get('/purchase-register', (req, res) => {
  const branchId = resolveBranchScope(req);
  const { from, to } = range(req);
  const args = branchId ? [req.user.companyId, from, to, branchId] : [req.user.companyId, from, to];
  const rows = db.prepare(
    `SELECT p.PurchaseNo AS Bill, p.PurchaseDate AS Date, sp.SupplierName AS Supplier,
            sp.GSTIN AS GSTIN, b.BranchName AS Branch, p.Total AS Taxable, p.GST AS GST,
            p.NetAmount AS Total, p.Status AS Status
     FROM PurchaseHeader p JOIN Supplier sp ON sp.SupplierID = p.SupplierID
     JOIN Branch b ON b.BranchID = p.BranchID
     WHERE p.CompanyID = ? AND date(p.PurchaseDate) BETWEEN date(?) AND date(?)
       ${branchId ? 'AND p.BranchID = ?' : ''}
     ORDER BY date(p.PurchaseDate), p.PurchaseID`
  ).all(...args);
  const live = rows.filter(r => r.Status !== 'Cancelled');
  res.json(report('Purchase Register',
    [
      { key: 'Bill', label: 'Bill' }, { key: 'Date', label: 'Date' },
      { key: 'Supplier', label: 'Supplier' }, { key: 'GSTIN', label: 'GSTIN' },
      { key: 'Branch', label: 'Branch' },
      { key: 'Taxable', label: 'Taxable', align: 'right', money: true },
      { key: 'GST', label: 'Input GST', align: 'right', money: true },
      { key: 'Total', label: 'Total', align: 'right', money: true },
      { key: 'Status', label: 'Status' }
    ],
    rows,
    {
      Taxable: round2(live.reduce((s, r) => s + r.Taxable, 0)),
      GST: round2(live.reduce((s, r) => s + r.GST, 0)),
      Total: round2(live.reduce((s, r) => s + r.Total, 0))
    },
    { from, to, note: 'Totals exclude cancelled bills.' }
  ));
});

// ---------------- Item-wise sales ----------------
router.get('/item-sales', (req, res) => {
  const branchId = resolveBranchScope(req);
  const { from, to } = range(req);
  const args = branchId ? [req.user.companyId, from, to, branchId] : [req.user.companyId, from, to];
  const rows = db.prepare(
    `SELECT i.ItemName AS Item, i.HSN AS HSN, i.Unit AS Unit,
            SUM(sd.Qty) AS Qty, SUM(sd.Qty * sd.Rate - sd.Discount) AS Taxable,
            SUM(sd.Amount) AS Total, COUNT(DISTINCT s.InvoiceID) AS Invoices,
            AVG(sd.Rate) AS AvgRate
     FROM SalesDetail sd JOIN SalesHeader s ON s.InvoiceID = sd.InvoiceID
     JOIN Item i ON i.ItemID = sd.ItemID
     WHERE s.CompanyID = ? AND s.Status != 'Cancelled'
       AND date(s.InvoiceDate) BETWEEN date(?) AND date(?) ${branchId ? 'AND s.BranchID = ?' : ''}
     GROUP BY sd.ItemID ORDER BY Total DESC`
  ).all(...args);
  res.json(report('Item-wise Sales',
    [
      { key: 'Item', label: 'Item' }, { key: 'HSN', label: 'HSN' }, { key: 'Unit', label: 'Unit' },
      { key: 'Qty', label: 'Qty sold', align: 'right' },
      { key: 'AvgRate', label: 'Avg rate', align: 'right', money: true },
      { key: 'Taxable', label: 'Taxable', align: 'right', money: true },
      { key: 'Total', label: 'Total', align: 'right', money: true },
      { key: 'Invoices', label: 'Invoices', align: 'right' }
    ],
    rows.map(r => ({ ...r, Qty: round2(r.Qty), AvgRate: round2(r.AvgRate), Taxable: round2(r.Taxable), Total: round2(r.Total) })),
    { Total: round2(rows.reduce((s, r) => s + r.Total, 0)), Qty: round2(rows.reduce((s, r) => s + r.Qty, 0)) },
    { from, to }
  ));
});

// ---------------- Stock Valuation ----------------
router.get('/stock-valuation', (req, res) => {
  const branchId = resolveBranchScope(req);
  const args = branchId ? [req.user.companyId, branchId] : [req.user.companyId];
  const rows = db.prepare(
    `SELECT b.BranchName AS Branch, i.ItemName AS Item, i.Unit AS Unit,
            SUM(sl.InQty) - SUM(sl.OutQty) AS Qty,
            i.PurchaseRate AS Rate,
            (SUM(sl.InQty) - SUM(sl.OutQty)) * i.PurchaseRate AS Value,
            i.ReorderLevel AS ReorderLevel
     FROM StockLedger sl JOIN Item i ON i.ItemID = sl.ItemID JOIN Branch b ON b.BranchID = sl.BranchID
     WHERE sl.CompanyID = ? ${branchId ? 'AND sl.BranchID = ?' : ''}
     GROUP BY sl.BranchID, sl.ItemID HAVING Qty != 0
     ORDER BY Value DESC`
  ).all(...args);
  res.json(report('Stock Valuation',
    [
      { key: 'Branch', label: 'Branch' }, { key: 'Item', label: 'Item' }, { key: 'Unit', label: 'Unit' },
      { key: 'Qty', label: 'Qty', align: 'right' },
      { key: 'Rate', label: 'Cost rate', align: 'right', money: true },
      { key: 'Value', label: 'Value', align: 'right', money: true },
      { key: 'ReorderLevel', label: 'Reorder at', align: 'right' }
    ],
    rows.map(r => ({ ...r, Qty: round2(r.Qty), Value: round2(r.Value) })),
    { Value: round2(rows.reduce((s, r) => s + r.Value, 0)) },
    { note: 'Valued at the purchase rate on the item master.' }
  ));
});

// ---------------- Stock movement: fast, slow and dead ----------------
//
// "Dead" means it is sitting in stock and has not sold once in the window.
// That is the report that frees up working capital, so it is worth having.
router.get('/stock-movement', (req, res) => {
  const branchId = resolveBranchScope(req);
  const days = Number(req.query.days) || 90;
  const from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const args = branchId ? [req.user.companyId, branchId] : [req.user.companyId];

  const stock = db.prepare(
    `SELECT sl.ItemID, i.ItemName, i.Unit, i.PurchaseRate,
            SUM(sl.InQty) - SUM(sl.OutQty) AS Qty
     FROM StockLedger sl JOIN Item i ON i.ItemID = sl.ItemID
     WHERE sl.CompanyID = ? ${branchId ? 'AND sl.BranchID = ?' : ''}
     GROUP BY sl.ItemID HAVING Qty > 0`
  ).all(...args);

  const soldArgs = branchId ? [req.user.companyId, from, branchId] : [req.user.companyId, from];
  const sold = db.prepare(
    `SELECT sd.ItemID, SUM(sd.Qty) AS SoldQty, MAX(s.InvoiceDate) AS LastSold
     FROM SalesDetail sd JOIN SalesHeader s ON s.InvoiceID = sd.InvoiceID
     WHERE s.CompanyID = ? AND s.Status != 'Cancelled' AND date(s.InvoiceDate) >= date(?)
       ${branchId ? 'AND s.BranchID = ?' : ''}
     GROUP BY sd.ItemID`
  ).all(...soldArgs);
  const soldMap = new Map(sold.map(s => [s.ItemID, s]));

  const rows = stock.map(s => {
    const m = soldMap.get(s.ItemID);
    const soldQty = m ? round2(m.SoldQty) : 0;
    // Turnover: how many times the held quantity sold through in the window.
    const turnover = s.Qty > 0 ? round2(soldQty / s.Qty) : 0;
    const category = soldQty === 0 ? 'Dead' : (turnover >= 1 ? 'Fast' : 'Slow');
    return {
      Item: s.ItemName, Unit: s.Unit,
      Qty: round2(s.Qty), Value: round2(s.Qty * s.PurchaseRate),
      SoldQty: soldQty, LastSold: m ? m.LastSold : null,
      Turnover: turnover, Category: category
    };
  }).sort((a, b) => a.Turnover - b.Turnover || b.Value - a.Value);

  const byCategory = ['Dead', 'Slow', 'Fast'].map(c => ({
    category: c,
    items: rows.filter(r => r.Category === c).length,
    value: round2(rows.filter(r => r.Category === c).reduce((s, r) => s + r.Value, 0))
  }));

  res.json(report(`Stock Movement (last ${days} days)`,
    [
      { key: 'Item', label: 'Item' }, { key: 'Unit', label: 'Unit' },
      { key: 'Qty', label: 'In stock', align: 'right' },
      { key: 'Value', label: 'Value', align: 'right', money: true },
      { key: 'SoldQty', label: 'Sold', align: 'right' },
      { key: 'LastSold', label: 'Last sold' },
      { key: 'Turnover', label: 'Turnover', align: 'right' },
      { key: 'Category', label: 'Category' }
    ],
    rows,
    { Value: round2(rows.reduce((s, r) => s + r.Value, 0)) },
    { days, byCategory, note: 'Dead = held in stock but not sold once in the window. Turnover = quantity sold ÷ quantity held.' }
  ));
});

// ---------------- Customer / supplier ledger statement ----------------
router.get('/party-ledger', (req, res) => {
  const partyType = req.query.partyType === 'Supplier' ? 'Supplier' : 'Customer';
  const partyId = Number(req.query.partyId);
  if (!partyId) return res.status(400).json({ error: 'partyId is required' });
  const { from, to } = range(req);
  const branchId = resolveBranchScope(req);

  const isCustomer = partyType === 'Customer';
  const docs = isCustomer
    ? db.prepare(
        `SELECT s.InvoiceDate AS Date, s.InvoiceNo AS Reference, 'Invoice' AS Particulars,
                s.NetAmount AS Debit, 0 AS Credit
         FROM SalesHeader s WHERE s.CompanyID = ? AND s.CustomerID = ? AND s.Status != 'Cancelled'
           AND date(s.InvoiceDate) BETWEEN date(?) AND date(?) ${branchId ? 'AND s.BranchID = ?' : ''}`
      ).all(...[req.user.companyId, partyId, from, to, branchId].filter(v => v !== null && v !== undefined))
    : db.prepare(
        `SELECT p.PurchaseDate AS Date, p.PurchaseNo AS Reference, 'Bill' AS Particulars,
                0 AS Debit, p.NetAmount AS Credit
         FROM PurchaseHeader p WHERE p.CompanyID = ? AND p.SupplierID = ? AND p.Status != 'Cancelled'
           AND date(p.PurchaseDate) BETWEEN date(?) AND date(?) ${branchId ? 'AND p.BranchID = ?' : ''}`
      ).all(...[req.user.companyId, partyId, from, to, branchId].filter(v => v !== null && v !== undefined));

  const settlements = db.prepare(
    `SELECT a.AllocDate AS Date, 'Settlement' AS Particulars,
            COALESCE(j.Narration, 'Allocation') AS Reference,
            ${isCustomer ? '0 AS Debit, a.Amount AS Credit' : 'a.Amount AS Debit, 0 AS Credit'}
     FROM Allocation a LEFT JOIN JournalEntry j ON j.JournalID = a.JournalID
     WHERE a.CompanyID = ? AND a.PartyType = ? AND a.PartyID = ?
       AND date(a.AllocDate) BETWEEN date(?) AND date(?)`
  ).all(req.user.companyId, partyType, partyId, from, to);

  const rows = [...docs, ...settlements].sort((a, b) => String(a.Date).localeCompare(String(b.Date)));
  let balance = 0;
  const withBalance = rows.map(r => {
    balance += (r.Debit || 0) - (r.Credit || 0);
    return { ...r, Debit: round2(r.Debit), Credit: round2(r.Credit), Balance: round2(balance) };
  });

  const party = isCustomer
    ? db.prepare('SELECT CustomerName AS Name FROM Customer WHERE CustomerID = ?').get(partyId)
    : db.prepare('SELECT SupplierName AS Name FROM Supplier WHERE SupplierID = ?').get(partyId);

  res.json(report(`${partyType} Ledger — ${party ? party.Name : partyId}`,
    [
      { key: 'Date', label: 'Date' }, { key: 'Particulars', label: 'Particulars' },
      { key: 'Reference', label: 'Reference' },
      { key: 'Debit', label: 'Debit', align: 'right', money: true },
      { key: 'Credit', label: 'Credit', align: 'right', money: true },
      { key: 'Balance', label: 'Balance', align: 'right', money: true }
    ],
    withBalance,
    {
      Debit: round2(withBalance.reduce((s, r) => s + r.Debit, 0)),
      Credit: round2(withBalance.reduce((s, r) => s + r.Credit, 0)),
      Balance: round2(balance)
    },
    { from, to, partyName: party ? party.Name : String(partyId) }
  ));
});

// ---------------- The list the UI builds its menu from ----------------
router.get('/', (req, res) => {
  res.json([
    { key: 'day-book', name: 'Day Book', group: 'Financial', needsRange: true },
    { key: 'cash-flow', name: 'Cash Flow', group: 'Financial', needsRange: true },
    { key: 'sales-register', name: 'Sales Register', group: 'Sales', needsRange: true },
    { key: 'item-sales', name: 'Item-wise Sales', group: 'Sales', needsRange: true },
    { key: 'purchase-register', name: 'Purchase Register', group: 'Purchase', needsRange: true },
    { key: 'stock-valuation', name: 'Stock Valuation', group: 'Inventory', needsRange: false },
    { key: 'stock-movement', name: 'Fast / Slow / Dead Stock', group: 'Inventory', needsRange: false },
    { key: 'party-ledger', name: 'Customer / Supplier Ledger', group: 'Financial', needsRange: true, needsParty: true },
    { key: 'cash-forecast', name: 'Cash Forecast (due receivables / payables)', group: 'Financial', needsRange: false }
  ]);
});


// ---------------- RPT-02: receivables / payables due, with a cash forecast ----------------
// Open documents bucketed by when they fall due, so you can see what is already
// overdue and what is coming in (or going out) over the next weeks.
router.get('/cash-forecast', (req, res) => {
  const { openDocuments } = require('./outstanding');
  const branchId = resolveBranchScope(req);
  const todayStr = today();
  const horizon = Math.min(180, Math.max(7, Number(req.query.days) || 90));

  function side(partyType) {
    const parties = partyType === 'Customer'
      ? db.prepare('SELECT CustomerID AS id FROM Customer WHERE CompanyID = ?').all(req.user.companyId)
      : db.prepare('SELECT SupplierID AS id FROM Supplier WHERE CompanyID = ?').all(req.user.companyId);
    const docs = [];
    parties.forEach(p => openDocuments(req.user.companyId, { branchId, partyType, partyId: p.id }).forEach(d => docs.push(d)));
    return docs;
  }
  const BUCKETS = [
    { key: 'overdue', label: 'Overdue', test: d => d.Overdue },
    { key: 'd0_7', label: 'Due 0-7 days', test: d => !d.Overdue && daysTo(d.DueDate) <= 7 },
    { key: 'd8_30', label: 'Due 8-30 days', test: d => !d.Overdue && daysTo(d.DueDate) > 7 && daysTo(d.DueDate) <= 30 },
    { key: 'd31_60', label: 'Due 31-60 days', test: d => !d.Overdue && daysTo(d.DueDate) > 30 && daysTo(d.DueDate) <= 60 },
    { key: 'd60p', label: 'Due 60+ days', test: d => !d.Overdue && daysTo(d.DueDate) > 60 }
  ];
  function daysTo(dateStr) { return Math.floor((new Date(dateStr) - new Date(todayStr)) / 86400000); }
  function summarise(docs) {
    return BUCKETS.map(b => ({ key: b.key, label: b.label, amount: round2(docs.filter(b.test).reduce((s, d) => s + d.OpenAmount, 0)) }));
  }
  const receivables = side('Customer').filter(d => daysTo(d.DueDate) <= horizon || d.Overdue);
  const payables = side('Supplier').filter(d => daysTo(d.DueDate) <= horizon || d.Overdue);
  const inflow = round2(receivables.reduce((s, d) => s + d.OpenAmount, 0));
  const outflow = round2(payables.reduce((s, d) => s + d.OpenAmount, 0));

  const columns = [{ key: 'label', label: 'Window' }, { key: 'receivable', label: 'Expected In' }, { key: 'payable', label: 'Expected Out' }, { key: 'net', label: 'Net' }];
  const recB = summarise(receivables), payB = summarise(payables);
  const rows = BUCKETS.map((b, i) => ({ label: b.label, receivable: recB[i].amount, payable: payB[i].amount, net: round2(recB[i].amount - payB[i].amount) }));
  res.json(report('Cash Forecast (receivables vs payables by due date)', columns, rows,
    { label: 'TOTAL', receivable: inflow, payable: outflow, net: round2(inflow - outflow) },
    { from: todayStr, to: today(), horizonDays: horizon, netPosition: round2(inflow - outflow) }));
});

// ---------------- CSV export, for any report ----------------
//
// One exporter for every report, because they all return the same envelope.
router.get('/:key/export.csv', (req, res, next) => {
  const key = req.params.key;
  const handler = router.stack.find(l => l.route && l.route.path === '/' + key && l.route.methods.get);
  if (!handler) return res.status(404).json({ error: 'Unknown report' });

  // Re-run the report handler and capture what it would have sent.
  const fakeRes = {
    json(payload) {
      const esc = (v) => {
        const s = v === null || v === undefined ? '' : String(v);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      };
      const head = payload.columns.map(c => esc(c.label)).join(',');
      const body = payload.rows.map(r => payload.columns.map(c => esc(r[c.key])).join(',')).join('\n');
      const totals = payload.totals
        ? '\n' + payload.columns.map(c => esc(payload.totals[c.key] !== undefined ? payload.totals[c.key] : (c === payload.columns[0] ? 'TOTAL' : ''))).join(',')
        : '';
      const csv = `${payload.title}\n${payload.from ? `From ${payload.from} to ${payload.to}\n` : ''}\n${head}\n${body}${totals}\n`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${key}-${today()}.csv"`);
      res.send(csv);
    },
    status(code) { return { json: (o) => res.status(code).json(o) }; }
  };
  handler.route.stack[0].handle(req, fakeRes, next);
});

module.exports = router;
