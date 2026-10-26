/** Payment terms and due dates (MD-04/05/06). One function decides every due date. */
const db = require('../db');

function addDays(dateStr, days) {
  const d = new Date(String(dateStr).slice(0, 10) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}
function monthEnd(dateStr) {
  const d = new Date(String(dateStr).slice(0, 10) + 'T00:00:00Z');
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
}

/** Due date for a document dated `docDate` under `term` (a PaymentTerm row, or null = on receipt). */
function computeDueDate(term, docDate) {
  const date = String(docDate).slice(0, 10);
  if (!term) return date;
  const base = term.BaselineDate === 'MonthEnd' ? monthEnd(date) : date;
  return addDays(base, term.NetDays || 0);
}

function getTerm(companyId, termId) {
  if (!termId) return null;
  return db.prepare('SELECT * FROM PaymentTerm WHERE PaymentTermID = ? AND CompanyID = ?').get(termId, companyId) || null;
}

/** The term a document should carry: explicit override, else the party's default. */
function termForParty(companyId, kind, partyId) {
  const table = kind === 'Supplier' ? 'Supplier' : 'Customer';
  const idCol = kind === 'Supplier' ? 'SupplierID' : 'CustomerID';
  const p = db.prepare(`SELECT PaymentTermID, CreditDays FROM ${table} WHERE ${idCol} = ? AND CompanyID = ?`).get(partyId, companyId);
  if (!p) return null;
  return getTerm(companyId, p.PaymentTermID);
}

/** Cash discount available if paid on `payDate` (tiers: [{days, percent}]). */
function discountFor(term, docDate, payDate) {
  if (!term || !term.DiscountJson) return 0;
  let tiers = [];
  try { tiers = JSON.parse(term.DiscountJson); } catch (e) { return 0; }
  const elapsed = Math.floor((new Date(payDate) - new Date(docDate)) / 86400000);
  const hit = tiers.filter(t => elapsed <= Number(t.days)).sort((a, b) => b.percent - a.percent)[0];
  return hit ? Number(hit.percent) : 0;
}

module.exports = { addDays, monthEnd, computeDueDate, getTerm, termForParty, discountFor };
