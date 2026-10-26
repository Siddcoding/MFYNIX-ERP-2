/**
 * MFinAI - the assistant module.
 *
 * IMPORTANT, so nobody is misled about what this is: this is a deterministic
 * rule-based engine, not a large language model. It parses a question against
 * a fixed set of intents, extracts the period/branch/limit it mentions, runs
 * REAL SQL against the company's own data, and returns the answer together
 * with the numbers it came from. Nothing is invented, nothing leaves the
 * server, and it needs no API key or internet connection.
 *
 * If a question doesn't match an intent it says so and lists what it can
 * answer, rather than guessing. If you later want a true LLM behind this,
 * the shape is already right: swap `matchIntent` for a model call that
 * returns {intent, params}, keep every handler below unchanged.
 */

const express = require('express');
const db = require('../db');
const { requireAuth, resolveBranchScope } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
function money(n) { return '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 }); }
function ym(date) { return date.toISOString().slice(0, 10); }

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/**
 * Works out the date window a question is asking about.
 * Defaults to the last 30 days when the question names no period at all.
 */
function extractPeriod(q, now) {
  const today = new Date(now);
  const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };

  if (/\btoday\b/.test(q)) {
    const d = startOfDay(today);
    return { from: ym(d), to: ym(today), label: 'today' };
  }
  if (/\byesterday\b/.test(q)) {
    const d = new Date(today); d.setDate(d.getDate() - 1);
    return { from: ym(d), to: ym(d), label: 'yesterday' };
  }
  if (/\bthis (month|mth)\b/.test(q)) {
    const d = new Date(today.getFullYear(), today.getMonth(), 1);
    return { from: ym(d), to: ym(today), label: 'this month' };
  }
  if (/\blast month\b/.test(q)) {
    const start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const end = new Date(today.getFullYear(), today.getMonth(), 0);
    return { from: ym(start), to: ym(end), label: 'last month' };
  }
  if (/\bthis (year|fy)\b/.test(q)) {
    const d = new Date(today.getFullYear(), 0, 1);
    return { from: ym(d), to: ym(today), label: 'this year' };
  }
  const weekMatch = q.match(/\blast (\d+)?\s*(day|week|month)s?\b/);
  if (weekMatch) {
    const n = Number(weekMatch[1] || 1);
    const unit = weekMatch[2];
    const d = new Date(today);
    if (unit === 'day') d.setDate(d.getDate() - n);
    if (unit === 'week') d.setDate(d.getDate() - n * 7);
    if (unit === 'month') d.setMonth(d.getMonth() - n);
    return { from: ym(d), to: ym(today), label: `last ${n} ${unit}${n > 1 ? 's' : ''}` };
  }
  // A named month, optionally with a year: "sales in March", "March 2026"
  for (let i = 0; i < MONTHS.length; i++) {
    const re = new RegExp(`\\b${MONTHS[i]}\\b(?:\\s+(\\d{4}))?`, 'i');
    const m = q.match(re);
    if (m) {
      const year = m[1] ? Number(m[1]) : today.getFullYear();
      const start = new Date(year, i, 1);
      const end = new Date(year, i + 1, 0);
      return { from: ym(start), to: ym(end), label: `${MONTHS[i][0].toUpperCase()}${MONTHS[i].slice(1)} ${year}` };
    }
  }
  const d = new Date(today); d.setDate(d.getDate() - 30);
  return { from: ym(d), to: ym(today), label: 'the last 30 days' };
}

// Finds a branch the question names, by branch name or branch code.
function extractBranch(q, companyId) {
  const branches = db.prepare('SELECT BranchID, BranchName, BranchCode FROM Branch WHERE CompanyID = ? AND IsActive = 1').all(companyId);
  for (const b of branches) {
    const name = b.BranchName.toLowerCase();
    const firstWord = name.split(/[\s-]/)[0];
    if (q.includes(name) || new RegExp(`\\b${b.BranchCode.toLowerCase()}\\b`).test(q) ||
        (firstWord.length > 3 && q.includes(firstWord))) {
      return b;
    }
  }
  return null;
}

function extractLimit(q, fallback = 5) {
  const m = q.match(/\btop\s+(\d+)\b/);
  return m ? Math.min(50, Math.max(1, Number(m[1]))) : fallback;
}

// ---------------- Intent matching ----------------
// Ordered: the first pattern that matches wins, so put specific ones first.
const INTENTS = [
  { name: 'top_customers', test: q => /\b(top|best)\b/.test(q) && /\bcustomer/.test(q) },
  { name: 'top_items', test: q => /\b(top|best|most sold|best.?selling)\b/.test(q) && /\b(item|product|sku)/.test(q) },
  { name: 'branch_comparison', test: q => /\b(compare|comparison|branch wise|branchwise|which branch|best branch|per branch|by branch)\b/.test(q) },
  // "low stock", "low on stock", "stock is low", "running low" all reach here.
  { name: 'low_stock', test: q => /\b(reorder|re-order|out of stock|running out|stock alert|shortage)\b/.test(q) || (/\blow\b/.test(q) && /\bstock\b/.test(q)) },
  { name: 'stock_value', test: q => /\bstock\b/.test(q) && /\b(value|worth|holding|on hand)\b/.test(q) },
  { name: 'gst_liability', test: q => /\bgst\b/.test(q) || /\btax\b/.test(q) },
  { name: 'payroll_cost', test: q => /\b(payroll|salary|salaries|wage|staff cost)\b/.test(q) },
  { name: 'crm_pipeline', test: q => /\b(lead|pipeline|crm|follow.?up|conversion)\b/.test(q) },
  { name: 'profit', test: q => /\b(profit|loss|margin|p&l|pnl|bottom line)\b/.test(q) },
  { name: 'outstanding', test: q => /\b(outstanding|receivable|debtor|owed|payable|creditor)\b/.test(q) },
  { name: 'purchase_total', test: q => /\bpurchase|bought|procure/.test(q) },
  { name: 'sales_total', test: q => /\b(sale|sales|revenue|turnover|sold|billing)\b/.test(q) },
];

function matchIntent(q) {
  for (const i of INTENTS) if (i.test(q)) return i.name;
  return null;
}

const CAPABILITIES = [
  'What were my sales last month?',
  'Show sales for the Hyderabad branch this month',
  'Compare branch performance this year',
  'Who are my top 5 customers?',
  'What are the best selling items last 90 days?',
  'What is my GST liability this month?',
  'What is my profit this month?',
  'How much is outstanding from customers?',
  'Which items are low on stock?',
  'What is my payroll cost this month?',
  'How is my CRM pipeline doing?',
  'What is my purchase total last month?'
];

// ---------------- Query handlers ----------------
// Each returns { answer, table?, columns?, meta } - answer is the sentence,
// table is the supporting data so the user can check the number themselves.

function branchClause(branchId, alias) {
  return branchId ? `AND ${alias}.BranchID = ?` : '';
}

const HANDLERS = {
  sales_total(ctx) {
    const { companyId, branchId, period } = ctx;
    const args = branchId ? [companyId, period.from, period.to, branchId] : [companyId, period.from, period.to];
    const row = db.prepare(
      `SELECT COUNT(*) AS Invoices, COALESCE(SUM(NetAmount),0) AS Net, COALESCE(SUM(Total),0) AS Taxable, COALESCE(SUM(GST),0) AS Gst
       FROM SalesHeader s WHERE CompanyID = ? AND Status != 'Cancelled' AND InvoiceDate BETWEEN ? AND ? ${branchClause(branchId, 's')}`
    ).get(...args);

    const scope = ctx.branchLabel;
    const avg = row.Invoices > 0 ? row.Net / row.Invoices : 0;
    return {
      answer: row.Invoices === 0
        ? `No sales were recorded ${scope} in ${period.label}.`
        : `Sales ${scope} in ${period.label}: ${money(row.Net)} across ${row.Invoices} invoice${row.Invoices === 1 ? '' : 's'} (taxable ${money(row.Taxable)} + GST ${money(row.Gst)}). Average invoice ${money(avg)}.`,
      columns: ['Measure', 'Value'],
      table: [
        { Measure: 'Invoices', Value: row.Invoices },
        { Measure: 'Taxable value', Value: money(row.Taxable) },
        { Measure: 'GST', Value: money(row.Gst) },
        { Measure: 'Net sales', Value: money(row.Net) },
        { Measure: 'Average invoice', Value: money(avg) }
      ]
    };
  },

  purchase_total(ctx) {
    const { companyId, branchId, period } = ctx;
    const args = branchId ? [companyId, period.from, period.to, branchId] : [companyId, period.from, period.to];
    const row = db.prepare(
      `SELECT COUNT(*) AS Bills, COALESCE(SUM(NetAmount),0) AS Net, COALESCE(SUM(GST),0) AS Gst
       FROM PurchaseHeader p WHERE CompanyID = ? AND Status != 'Cancelled' AND PurchaseDate BETWEEN ? AND ? ${branchClause(branchId, 'p')}`
    ).get(...args);
    return {
      answer: row.Bills === 0
        ? `No purchases were recorded ${ctx.branchLabel} in ${period.label}.`
        : `Purchases ${ctx.branchLabel} in ${period.label}: ${money(row.Net)} across ${row.Bills} bill${row.Bills === 1 ? '' : 's'}, including ${money(row.Gst)} of input GST.`,
      columns: ['Measure', 'Value'],
      table: [
        { Measure: 'Bills', Value: row.Bills },
        { Measure: 'Input GST', Value: money(row.Gst) },
        { Measure: 'Net purchases', Value: money(row.Net) }
      ]
    };
  },

  top_customers(ctx) {
    const { companyId, branchId, period, limit } = ctx;
    const args = branchId ? [companyId, period.from, period.to, branchId, limit] : [companyId, period.from, period.to, limit];
    const rows = db.prepare(
      `SELECT c.CustomerName, COUNT(*) AS Invoices, SUM(s.NetAmount) AS Total
       FROM SalesHeader s JOIN Customer c ON c.CustomerID = s.CustomerID
       WHERE s.CompanyID = ? AND s.Status != 'Cancelled' AND s.InvoiceDate BETWEEN ? AND ? ${branchClause(branchId, 's')}
       GROUP BY s.CustomerID ORDER BY Total DESC LIMIT ?`
    ).all(...args);
    if (rows.length === 0) return { answer: `No customer billing found ${ctx.branchLabel} in ${period.label}.` };
    return {
      answer: `Top ${rows.length} customer${rows.length === 1 ? '' : 's'} ${ctx.branchLabel} in ${period.label}: ${rows.map(r => `${r.CustomerName} (${money(r.Total)})`).join(', ')}.`,
      columns: ['Customer', 'Invoices', 'Total'],
      table: rows.map(r => ({ Customer: r.CustomerName, Invoices: r.Invoices, Total: money(r.Total) }))
    };
  },

  top_items(ctx) {
    const { companyId, branchId, period, limit } = ctx;
    const args = branchId ? [companyId, period.from, period.to, branchId, limit] : [companyId, period.from, period.to, limit];
    const rows = db.prepare(
      `SELECT i.ItemName, SUM(sd.Qty) AS Qty, SUM(sd.Amount) AS Amount
       FROM SalesDetail sd JOIN SalesHeader s ON s.InvoiceID = sd.InvoiceID JOIN Item i ON i.ItemID = sd.ItemID
       WHERE s.CompanyID = ? AND s.Status != 'Cancelled' AND s.InvoiceDate BETWEEN ? AND ? ${branchClause(branchId, 's')}
       GROUP BY sd.ItemID ORDER BY Amount DESC LIMIT ?`
    ).all(...args);
    if (rows.length === 0) return { answer: `No items were sold ${ctx.branchLabel} in ${period.label}.` };
    return {
      answer: `Best selling ${ctx.branchLabel} in ${period.label}: ${rows.map(r => `${r.ItemName} (${round2(r.Qty)} units, ${money(r.Amount)})`).join(', ')}.`,
      columns: ['Item', 'Qty sold', 'Value'],
      table: rows.map(r => ({ Item: r.ItemName, 'Qty sold': round2(r.Qty), Value: money(r.Amount) }))
    };
  },

  branch_comparison(ctx) {
    const { companyId, period } = ctx;
    const rows = db.prepare(
      `SELECT b.BranchName, b.BranchCode,
              COALESCE((SELECT SUM(NetAmount) FROM SalesHeader s WHERE s.BranchID = b.BranchID AND s.Status != 'Cancelled' AND s.InvoiceDate BETWEEN ? AND ?),0) AS Sales,
              COALESCE((SELECT SUM(NetAmount) FROM PurchaseHeader p WHERE p.BranchID = b.BranchID AND p.Status != 'Cancelled' AND p.PurchaseDate BETWEEN ? AND ?),0) AS Purchases,
              COALESCE((SELECT COUNT(*) FROM SalesHeader s WHERE s.BranchID = b.BranchID AND s.Status != 'Cancelled' AND s.InvoiceDate BETWEEN ? AND ?),0) AS Invoices
       FROM Branch b WHERE b.CompanyID = ? AND b.IsActive = 1 ORDER BY Sales DESC`
    ).all(period.from, period.to, period.from, period.to, period.from, period.to, companyId);

    const total = rows.reduce((s, r) => s + r.Sales, 0);
    const best = rows[0];
    return {
      answer: total === 0
        ? `No branch recorded any sales in ${period.label}.`
        : `In ${period.label}, ${best.BranchName} leads with ${money(best.Sales)} of ${money(total)} total (${round2((best.Sales / total) * 100)}% of company sales) across ${rows.length} branches.`,
      columns: ['Branch', 'Sales', 'Purchases', 'Invoices', 'Share'],
      table: rows.map(r => ({
        Branch: `${r.BranchName} (${r.BranchCode})`, Sales: money(r.Sales), Purchases: money(r.Purchases),
        Invoices: r.Invoices, Share: total > 0 ? round2((r.Sales / total) * 100) + '%' : '0%'
      }))
    };
  },

  low_stock(ctx) {
    const { companyId, branchId } = ctx;
    const rows = db.prepare(
      `SELECT b.BranchName, i.ItemName, i.Unit, i.ReorderLevel,
              SUM(sl.InQty) - SUM(sl.OutQty) AS CurrentStock
       FROM StockLedger sl JOIN Item i ON i.ItemID = sl.ItemID JOIN Branch b ON b.BranchID = sl.BranchID
       WHERE sl.CompanyID = ? ${branchClause(branchId, 'sl')}
       GROUP BY sl.BranchID, sl.ItemID HAVING CurrentStock <= i.ReorderLevel ORDER BY CurrentStock`
    ).all(...(branchId ? [companyId, branchId] : [companyId]));
    if (rows.length === 0) return { answer: `Nothing is at or below its reorder level ${ctx.branchLabel} right now.` };
    return {
      answer: `${rows.length} item-branch combination${rows.length === 1 ? ' is' : 's are'} at or below reorder level ${ctx.branchLabel}. Lowest: ${rows[0].ItemName} at ${rows[0].BranchName} (${round2(rows[0].CurrentStock)} ${rows[0].Unit}).`,
      columns: ['Branch', 'Item', 'In stock', 'Reorder level'],
      table: rows.map(r => ({ Branch: r.BranchName, Item: r.ItemName, 'In stock': round2(r.CurrentStock), 'Reorder level': round2(r.ReorderLevel) }))
    };
  },

  stock_value(ctx) {
    const { companyId, branchId } = ctx;
    const rows = db.prepare(
      `SELECT b.BranchName, SUM((sl.InQty - sl.OutQty) * i.PurchaseRate) AS Value
       FROM StockLedger sl JOIN Item i ON i.ItemID = sl.ItemID JOIN Branch b ON b.BranchID = sl.BranchID
       WHERE sl.CompanyID = ? ${branchClause(branchId, 'sl')} GROUP BY sl.BranchID ORDER BY Value DESC`
    ).all(...(branchId ? [companyId, branchId] : [companyId]));
    const total = rows.reduce((s, r) => s + (r.Value || 0), 0);
    return {
      answer: `Stock on hand ${ctx.branchLabel} is worth ${money(total)} at purchase cost.`,
      columns: ['Branch', 'Stock value'],
      table: rows.map(r => ({ Branch: r.BranchName, 'Stock value': money(r.Value || 0) }))
    };
  },

  gst_liability(ctx) {
    const { companyId, branchId, period } = ctx;
    const salesArgs = branchId ? [companyId, period.from, period.to, branchId] : [companyId, period.from, period.to];
    const out = db.prepare(
      `SELECT COALESCE(SUM(GST),0) AS Gst FROM SalesHeader s WHERE CompanyID = ? AND Status != 'Cancelled' AND InvoiceDate BETWEEN ? AND ? ${branchClause(branchId, 's')}`
    ).get(...salesArgs).Gst;
    const inp = db.prepare(
      `SELECT COALESCE(SUM(GST),0) AS Gst FROM PurchaseHeader p WHERE CompanyID = ? AND Status != 'Cancelled' AND PurchaseDate BETWEEN ? AND ? ${branchClause(branchId, 'p')}`
    ).get(...salesArgs).Gst;
    const net = out - inp;
    return {
      answer: net >= 0
        ? `GST position ${ctx.branchLabel} for ${period.label}: output tax ${money(out)} less input credit ${money(inp)} leaves ${money(net)} payable.`
        : `GST position ${ctx.branchLabel} for ${period.label}: input credit ${money(inp)} exceeds output tax ${money(out)}, so ${money(-net)} carries forward as credit.`,
      columns: ['Measure', 'Value'],
      table: [
        { Measure: 'Output tax (on sales)', Value: money(out) },
        { Measure: 'Input credit (on purchases)', Value: money(inp) },
        { Measure: net >= 0 ? 'Net payable' : 'Credit carried forward', Value: money(Math.abs(net)) }
      ]
    };
  },

  payroll_cost(ctx) {
    const { companyId, branchId, period } = ctx;
    // Payroll is stored by YYYY-MM period, so match any run whose period falls in the window.
    const fromP = period.from.slice(0, 7), toP = period.to.slice(0, 7);
    const args = branchId ? [companyId, fromP, toP, branchId] : [companyId, fromP, toP];
    const rows = db.prepare(
      `SELECT b.BranchName, r.Period, r.EmployeeCount, r.GrossTotal, r.DeductionTotal, r.NetTotal, r.Status
       FROM PayrollRun r JOIN Branch b ON b.BranchID = r.BranchID
       WHERE r.CompanyID = ? AND r.Period BETWEEN ? AND ? ${branchClause(branchId, 'r')}
       ORDER BY r.Period DESC`
    ).all(...args);
    if (rows.length === 0) return { answer: `No payroll has been posted ${ctx.branchLabel} for ${period.label}.` };
    const gross = rows.reduce((s, r) => s + r.GrossTotal, 0);
    const net = rows.reduce((s, r) => s + r.NetTotal, 0);
    const heads = rows.reduce((s, r) => s + r.EmployeeCount, 0);
    return {
      answer: `Payroll cost ${ctx.branchLabel} for ${period.label}: ${money(gross)} gross across ${heads} payslip${heads === 1 ? '' : 's'}, ${money(net)} paid out after statutory deductions.`,
      columns: ['Branch', 'Period', 'Employees', 'Gross', 'Deductions', 'Net', 'Status'],
      table: rows.map(r => ({
        Branch: r.BranchName, Period: r.Period, Employees: r.EmployeeCount,
        Gross: money(r.GrossTotal), Deductions: money(r.DeductionTotal), Net: money(r.NetTotal), Status: r.Status
      }))
    };
  },

  crm_pipeline(ctx) {
    const { companyId, branchId } = ctx;
    const rows = db.prepare(
      `SELECT Stage, COUNT(*) AS Count, COALESCE(SUM(EstimatedValue),0) AS Value
       FROM Lead l WHERE CompanyID = ? AND IsActive = 1 ${branchClause(branchId, 'l')} GROUP BY Stage`
    ).all(...(branchId ? [companyId, branchId] : [companyId]));
    if (rows.length === 0) return { answer: `There are no leads recorded ${ctx.branchLabel} yet.` };
    const map = Object.fromEntries(rows.map(r => [r.Stage, r]));
    const won = map.Won ? map.Won.Count : 0;
    const lost = map.Lost ? map.Lost.Count : 0;
    const openValue = rows.filter(r => !['Won', 'Lost'].includes(r.Stage)).reduce((s, r) => s + r.Value, 0);
    const openCount = rows.filter(r => !['Won', 'Lost'].includes(r.Stage)).reduce((s, r) => s + r.Count, 0);
    const conv = (won + lost) > 0 ? round2((won / (won + lost)) * 100) : 0;
    return {
      answer: `CRM ${ctx.branchLabel}: ${openCount} open lead${openCount === 1 ? '' : 's'} worth ${money(openValue)}, ${won} won and ${lost} lost so far - a ${conv}% conversion rate on closed leads.`,
      columns: ['Stage', 'Leads', 'Value'],
      table: rows.map(r => ({ Stage: r.Stage, Leads: r.Count, Value: money(r.Value) }))
    };
  },

  profit(ctx) {
    const { companyId, branchId, period } = ctx;
    const args = branchId ? [companyId, period.from, period.to, branchId] : [companyId, period.from, period.to];
    const rows = db.prepare(
      `SELECT a.AccountName, a.AccountType,
              COALESCE(SUM(jl.Debit),0) AS D, COALESCE(SUM(jl.Credit),0) AS C
       FROM ChartOfAccounts a
       JOIN JournalLine jl ON jl.AccountID = a.AccountID
       JOIN JournalEntry j ON j.JournalID = jl.JournalID
       WHERE a.CompanyID = ? AND a.AccountType IN ('Income','Expense') AND j.EntryDate BETWEEN ? AND ? ${branchClause(branchId, 'j')}
       GROUP BY a.AccountID ORDER BY a.AccountCode`
    ).all(...args);
    const income = rows.filter(r => r.AccountType === 'Income').reduce((s, r) => s + (r.C - r.D), 0);
    const expense = rows.filter(r => r.AccountType === 'Expense').reduce((s, r) => s + (r.D - r.C), 0);
    const profit = income - expense;
    const margin = income > 0 ? round2((profit / income) * 100) : 0;
    return {
      answer: rows.length === 0
        ? `No income or expense was posted ${ctx.branchLabel} in ${period.label}.`
        : `${profit >= 0 ? 'Profit' : 'Loss'} ${ctx.branchLabel} for ${period.label}: ${money(Math.abs(profit))} on income of ${money(income)} against expenses of ${money(expense)}${income > 0 ? ` (${margin}% margin)` : ''}.`,
      columns: ['Account', 'Type', 'Amount'],
      table: rows.map(r => ({
        Account: r.AccountName, Type: r.AccountType,
        Amount: money(r.AccountType === 'Income' ? r.C - r.D : r.D - r.C)
      }))
    };
  },

  outstanding(ctx) {
    const { companyId, branchId } = ctx;
    // Receivables/payables come from the ledger balances of the control accounts,
    // so they always agree with the books rather than being recomputed separately.
    const bal = (code) => {
      const args = branchId ? [companyId, code, branchId] : [companyId, code];
      const r = db.prepare(
        `SELECT COALESCE(SUM(jl.Debit),0) AS D, COALESCE(SUM(jl.Credit),0) AS C
         FROM ChartOfAccounts a JOIN JournalLine jl ON jl.AccountID = a.AccountID
         JOIN JournalEntry j ON j.JournalID = jl.JournalID
         WHERE a.CompanyID = ? AND a.AccountCode = ? ${branchClause(branchId, 'j')}`
      ).get(...args);
      return { debit: r.D, credit: r.C };
    };
    const debtors = bal('1100');
    const creditors = bal('2000');
    const receivable = debtors.debit - debtors.credit;
    const payable = creditors.credit - creditors.debit;
    return {
      answer: `Outstanding ${ctx.branchLabel}: ${money(receivable)} receivable from customers and ${money(payable)} payable to suppliers - a net position of ${money(receivable - payable)}.`,
      columns: ['Measure', 'Value'],
      table: [
        { Measure: 'Receivable (Debtors)', Value: money(receivable) },
        { Measure: 'Payable (Creditors)', Value: money(payable) },
        { Measure: 'Net position', Value: money(receivable - payable) }
      ]
    };
  }
};

// ---------------- Ask endpoint ----------------

router.post('/ask', (req, res) => {
  const question = String(req.body.question || '').trim();
  if (!question) return res.status(400).json({ error: 'Ask a question first' });
  if (question.length > 500) return res.status(400).json({ error: 'That question is too long - try something shorter' });

  const q = question.toLowerCase();
  const intent = matchIntent(q);
  if (!intent) {
    return res.json({
      question, intent: null,
      answer: "I couldn't match that to anything I know how to compute. I answer questions about sales, purchases, branches, customers, items, stock, GST, profit, outstanding balances, payroll and CRM leads.",
      suggestions: CAPABILITIES
    });
  }

  // A branch-locked user's scope always wins over a branch named in the question.
  const namedBranch = req.user.branchId ? null : extractBranch(q, req.user.companyId);
  const branchId = req.user.branchId || (namedBranch ? namedBranch.BranchID : null);
  const branchRow = req.user.branchId
    ? db.prepare('SELECT BranchName FROM Branch WHERE BranchID = ?').get(req.user.branchId)
    : namedBranch;

  const ctx = {
    companyId: req.user.companyId,
    branchId,
    branchLabel: branchRow ? `at ${branchRow.BranchName}` : 'across all branches',
    period: extractPeriod(q, new Date()),
    limit: extractLimit(q)
  };

  try {
    const result = HANDLERS[intent](ctx);
    res.json({
      question, intent,
      period: ctx.period,
      scope: ctx.branchLabel,
      ...result
    });
  } catch (e) {
    res.status(500).json({ error: 'Could not answer that: ' + e.message });
  }
});

router.get('/capabilities', (req, res) => res.json({ examples: CAPABILITIES }));

// ---------------- Automated insights ----------------
// Everything here is computed, not guessed. Each insight carries the numbers
// that produced it so the user can verify the claim.
router.get('/insights', (req, res) => {
  const companyId = req.user.companyId;
  const branchId = resolveBranchScope(req);
  const insights = [];

  const today = new Date();
  const thisMonthStart = ym(new Date(today.getFullYear(), today.getMonth(), 1));
  const lastMonthStart = ym(new Date(today.getFullYear(), today.getMonth() - 1, 1));
  const lastMonthEnd = ym(new Date(today.getFullYear(), today.getMonth(), 0));
  const todayStr = ym(today);

  const sales = (from, to) => {
    const args = branchId ? [companyId, from, to, branchId] : [companyId, from, to];
    return db.prepare(
      `SELECT COALESCE(SUM(NetAmount),0) AS Total FROM SalesHeader s
       WHERE CompanyID = ? AND Status != 'Cancelled' AND InvoiceDate BETWEEN ? AND ? ${branchClause(branchId, 's')}`
    ).get(...args).Total;
  };

  // 1. Month-on-month sales movement
  const thisMonth = sales(thisMonthStart, todayStr);
  const lastMonth = sales(lastMonthStart, lastMonthEnd);
  if (lastMonth > 0) {
    const change = ((thisMonth - lastMonth) / lastMonth) * 100;
    insights.push({
      type: change >= 0 ? 'positive' : 'warning',
      title: change >= 0 ? 'Sales are up on last month' : 'Sales are down on last month',
      detail: `Month to date is ${money(thisMonth)} against ${money(lastMonth)} for all of last month - a ${round2(Math.abs(change))}% ${change >= 0 ? 'increase' : 'decrease'}. Note the current month is still incomplete.`,
      metric: round2(change)
    });
  } else if (thisMonth > 0) {
    insights.push({ type: 'info', title: 'First month with sales', detail: `${money(thisMonth)} billed month to date, with nothing recorded last month to compare against.` });
  }

  // 2. Branch concentration risk (head-office view only)
  if (!branchId) {
    const rows = db.prepare(
      `SELECT b.BranchName, COALESCE(SUM(s.NetAmount),0) AS Total
       FROM Branch b LEFT JOIN SalesHeader s ON s.BranchID = b.BranchID AND s.Status != 'Cancelled' AND s.InvoiceDate >= ?
       WHERE b.CompanyID = ? AND b.IsActive = 1 GROUP BY b.BranchID ORDER BY Total DESC`
    ).all(lastMonthStart, companyId);
    const total = rows.reduce((s, r) => s + r.Total, 0);
    if (total > 0 && rows.length > 1) {
      const share = (rows[0].Total / total) * 100;
      if (share >= 70) {
        insights.push({
          type: 'warning', title: 'Revenue is concentrated in one branch',
          detail: `${rows[0].BranchName} accounts for ${round2(share)}% of sales since ${lastMonthStart}. The other ${rows.length - 1} branch${rows.length === 2 ? '' : 'es'} contribute the remaining ${round2(100 - share)}%.`,
          metric: round2(share)
        });
      }
      const idle = rows.filter(r => r.Total === 0);
      if (idle.length > 0) {
        insights.push({
          type: 'warning', title: 'Branches with no sales activity',
          detail: `${idle.map(r => r.BranchName).join(', ')} recorded no sales since ${lastMonthStart}.`,
        });
      }
    }
  }

  // 3. Stock at or below reorder level
  const low = db.prepare(
    `SELECT i.ItemName, b.BranchName, SUM(sl.InQty) - SUM(sl.OutQty) AS Stock, i.ReorderLevel
     FROM StockLedger sl JOIN Item i ON i.ItemID = sl.ItemID JOIN Branch b ON b.BranchID = sl.BranchID
     WHERE sl.CompanyID = ? ${branchClause(branchId, 'sl')}
     GROUP BY sl.BranchID, sl.ItemID HAVING Stock <= i.ReorderLevel ORDER BY Stock LIMIT 5`
  ).all(...(branchId ? [companyId, branchId] : [companyId]));
  if (low.length > 0) {
    insights.push({
      type: 'warning', title: `${low.length} item${low.length === 1 ? ' needs' : 's need'} reordering`,
      detail: low.map(r => `${r.ItemName} at ${r.BranchName} (${round2(r.Stock)} left, reorder at ${round2(r.ReorderLevel)})`).join('; ') + '.',
      metric: low.length
    });
  }

  // 4. Negative stock - a real data-integrity problem, not a style issue
  const negative = db.prepare(
    `SELECT i.ItemName, b.BranchName, SUM(sl.InQty) - SUM(sl.OutQty) AS Stock
     FROM StockLedger sl JOIN Item i ON i.ItemID = sl.ItemID JOIN Branch b ON b.BranchID = sl.BranchID
     WHERE sl.CompanyID = ? ${branchClause(branchId, 'sl')}
     GROUP BY sl.BranchID, sl.ItemID HAVING Stock < 0 LIMIT 5`
  ).all(...(branchId ? [companyId, branchId] : [companyId]));
  if (negative.length > 0) {
    insights.push({
      type: 'critical', title: 'Negative stock detected',
      detail: `${negative.map(r => `${r.ItemName} at ${r.BranchName} (${round2(r.Stock)})`).join('; ')}. This means goods were sold or transferred without a matching purchase or opening entry - check those branches' stock ledgers.`,
      metric: negative.length
    });
  }

  // 5. GST payable for the current month
  const gstArgs = branchId ? [companyId, thisMonthStart, todayStr, branchId] : [companyId, thisMonthStart, todayStr];
  const outputTax = db.prepare(`SELECT COALESCE(SUM(GST),0) AS G FROM SalesHeader s WHERE CompanyID = ? AND Status != 'Cancelled' AND InvoiceDate BETWEEN ? AND ? ${branchClause(branchId, 's')}`).get(...gstArgs).G;
  const inputTax = db.prepare(`SELECT COALESCE(SUM(GST),0) AS G FROM PurchaseHeader p WHERE CompanyID = ? AND Status != 'Cancelled' AND PurchaseDate BETWEEN ? AND ? ${branchClause(branchId, 'p')}`).get(...gstArgs).G;
  if (outputTax > 0 || inputTax > 0) {
    const net = outputTax - inputTax;
    insights.push({
      type: net > 0 ? 'info' : 'positive',
      title: net > 0 ? 'GST payable is accruing this month' : 'Input credit exceeds output tax',
      detail: net > 0
        ? `${money(net)} is payable so far this month (output ${money(outputTax)} less input ${money(inputTax)}). GSTR-3B is due by the 20th of next month.`
        : `${money(-net)} of input credit will carry forward (input ${money(inputTax)} against output ${money(outputTax)}).`,
      metric: round2(net)
    });
  }

  // 6. Overdue CRM follow-ups
  const overdue = db.prepare(
    `SELECT COUNT(*) AS C FROM Lead l WHERE CompanyID = ? AND IsActive = 1 AND Stage NOT IN ('Won','Lost')
     AND NextFollowUp IS NOT NULL AND NextFollowUp < ? ${branchClause(branchId, 'l')}`
  ).get(...(branchId ? [companyId, todayStr, branchId] : [companyId, todayStr])).C;
  if (overdue > 0) {
    insights.push({
      type: 'warning', title: `${overdue} lead follow-up${overdue === 1 ? ' is' : 's are'} overdue`,
      detail: `These leads have a follow-up date in the past and are still open. Overdue follow-ups are the single biggest cause of lost pipeline.`,
      metric: overdue
    });
  }

  // 7. Unfiled GST returns
  const unfiled = db.prepare(
    `SELECT COUNT(*) AS C FROM GSTReturnLog WHERE CompanyID = ? AND Status = 'Generated' ${branchId ? 'AND BranchID = ?' : ''}`
  ).get(...(branchId ? [companyId, branchId] : [companyId])).C;
  if (unfiled > 0) {
    insights.push({
      type: 'warning', title: `${unfiled} GST return${unfiled === 1 ? '' : 's'} generated but not filed`,
      detail: 'These returns have been prepared in the system but have no ARN recorded against them yet.',
      metric: unfiled
    });
  }

  // 8. Books integrity check - the trial balance must balance
  const tb = db.prepare(
    `SELECT COALESCE(SUM(jl.Debit),0) AS D, COALESCE(SUM(jl.Credit),0) AS C
     FROM JournalLine jl JOIN JournalEntry j ON j.JournalID = jl.JournalID
     WHERE j.CompanyID = ? ${branchClause(branchId, 'j')}`
  ).get(...(branchId ? [companyId, branchId] : [companyId]));
  if (Math.abs(tb.D - tb.C) > 0.01) {
    insights.push({
      type: 'critical', title: 'The books do not balance',
      detail: `Total debits ${money(tb.D)} against total credits ${money(tb.C)}. Every journal entry is validated on the way in, so a difference here needs investigating immediately.`,
      metric: round2(tb.D - tb.C)
    });
  } else if (tb.D > 0) {
    insights.push({
      type: 'positive', title: 'Books are balanced',
      detail: `${money(tb.D)} of debits matched by ${money(tb.C)} of credits across all posted entries.`
    });
  }

  if (insights.length === 0) {
    insights.push({ type: 'info', title: 'Nothing to flag yet', detail: 'Record some sales, purchases or leads and insights will appear here.' });
  }

  // Most urgent first.
  const order = { critical: 0, warning: 1, info: 2, positive: 3 };
  insights.sort((a, b) => order[a.type] - order[b.type]);

  res.json({ generatedAt: new Date().toISOString(), scope: branchId ? 'branch' : 'consolidated', insights });
});

module.exports = router;
