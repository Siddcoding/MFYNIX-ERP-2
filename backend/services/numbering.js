/**
 * Central document numbering engine — section 22 of the Mfynix stack document.
 *
 * Why this exists: each module used to build its own number with
 * `SELECT COUNT(*) ... + 1`. That is wrong in two ways. Two users saving at the
 * same instant both read the same count and are handed the same number, and any
 * gap in the table (a deleted row) silently reuses a number that was already
 * issued. Both matter for an invoice series that has to be unbroken and unique
 * for GST.
 *
 * Here the number comes from a counter row that is read and incremented in the
 * same statement, inside the caller's transaction. Whoever gets there first
 * takes the number; the second caller sees the incremented value. Numbers are
 * never reused, even if the document is later cancelled — which is exactly what
 * GST expects.
 */

const db = require('../db');

// EIN-01: GST rules and the e-invoice portal accept document numbers of at most
// 16 characters made of letters, digits, hyphen and slash.
const MAX_NUMBER_LENGTH = 16;
const NUMBER_CHARS = /^[A-Za-z0-9\-\/]+$/;
const DEFAULT_PADDING = 5;

/** "2026-27" -> "26": the year the financial year starts in, two digits. */
function shortYear(fyName) {
  const m = /^(\d{4})-\d{2}$/.exec(fyName || '');
  return m ? m[1].slice(2) : '00';
}

/**
 * The one place a document number is assembled, and validated.
 * Format: <prefix><yy>-<counter>, e.g. HYD-INV26-00001 (16 characters).
 */
function composeNumber(prefix, fyName, counter, padding = DEFAULT_PADDING) {
  const number = `${prefix}${shortYear(fyName)}-${String(counter).padStart(padding, '0')}`;
  if (!NUMBER_CHARS.test(number)) {
    throw new Error(`Document number "${number}" contains characters GST does not allow - use only letters, digits, hyphen and slash.`);
  }
  if (number.length > MAX_NUMBER_LENGTH) {
    throw new Error(`Document number "${number}" would be ${number.length} characters; GST allows at most ${MAX_NUMBER_LENGTH}. Shorten the branch code or the prefix, or reduce the number padding.`);
  }
  return number;
}

/** True when a prefix/padding pair can still issue valid numbers for counters up to 10^padding - 1. */
function checkPrefix(prefix, padding = DEFAULT_PADDING) {
  try { composeNumber(prefix, '2026-27', Math.pow(10, padding) - 1, padding); return null; }
  catch (e) { return e.message; }
}

// Document types the engine knows about, with their default prefixes.
const DOC_TYPES = {
  INV: { label: 'Sales Invoice', defaultPrefix: 'INV' },
  PUR: { label: 'Purchase Bill', defaultPrefix: 'PUR' },
  REC: { label: 'Receipt', defaultPrefix: 'REC' },
  PAY: { label: 'Payment', defaultPrefix: 'PAY' },
  JV: { label: 'Journal Voucher', defaultPrefix: 'JV' },
  CN: { label: 'Credit Note', defaultPrefix: 'CN' },
  DN: { label: 'Debit Note', defaultPrefix: 'DN' },
  QUO: { label: 'Quotation', defaultPrefix: 'QT' },
  SO: { label: 'Sales Order', defaultPrefix: 'SO' },
  DC: { label: 'Delivery Challan', defaultPrefix: 'DC' },
  PO: { label: 'Purchase Order', defaultPrefix: 'PO' },
  GRN: { label: 'Goods Receipt', defaultPrefix: 'GRN' }
};

/** The company's active financial year, or null if none is set. */
function activeFinancialYear(companyId) {
  return db.prepare(
    'SELECT * FROM FinancialYear WHERE CompanyID = ? AND IsActive = 1'
  ).get(companyId) || null;
}

/** The financial year a given date falls into, falling back to the active one. */
function financialYearForDate(companyId, dateStr) {
  if (dateStr) {
    const fy = db.prepare(
      `SELECT * FROM FinancialYear WHERE CompanyID = ? AND date(?) BETWEEN date(StartDate) AND date(EndDate)`
    ).get(companyId, dateStr);
    if (fy) return fy;
  }
  return activeFinancialYear(companyId);
}

/**
 * Refuses a posting into a financial year that has been closed.
 * Called by the transaction routes; throws so the surrounding transaction aborts.
 */
function assertYearOpen(companyId, dateStr) {
  const fy = financialYearForDate(companyId, dateStr);
  if (fy && fy.IsClosed) {
    throw new Error(`The financial year ${fy.YearName} is closed. Reopen it in Settings, or post the document into the current year.`);
  }
}

function ensureSequence(companyId, branchId, docType, fyName, prefix) {
  db.prepare(
    `INSERT OR IGNORE INTO DocumentSequence (CompanyID, BranchID, DocType, FinancialYear, Prefix, Padding, NextNumber)
     VALUES (?,?,?,?,?,?,1)`
  ).run(companyId, branchId, docType, fyName, prefix, DEFAULT_PADDING);
  return db.prepare(
    `SELECT * FROM DocumentSequence WHERE CompanyID = ? AND DocType = ? AND FinancialYear = ?
       AND ${branchId === null ? 'BranchID IS NULL' : 'BranchID = ?'}`
  ).get(...(branchId === null ? [companyId, docType, fyName] : [companyId, docType, fyName, branchId]));
}

/**
 * Issues the next number for a document. MUST be called inside a transaction.
 *
 * Format: PREFIX-FY-NNNNNN, e.g. HYD/INV-2026-27-000001. The branch code is
 * folded into the prefix so each branch keeps its own unbroken series, which is
 * what a multi-location business under separate GSTINs needs.
 */
function nextDocumentNumber(companyId, branchId, docType, dateStr) {
  if (!DOC_TYPES[docType]) throw new Error(`Unknown document type ${docType}`);

  const fy = financialYearForDate(companyId, dateStr);
  const fyName = fy ? fy.YearName : 'ALL';

  const branch = branchId
    ? db.prepare('SELECT BranchCode FROM Branch WHERE BranchID = ?').get(branchId)
    : null;
  const company = db.prepare('SELECT InvoicePrefix FROM Company WHERE CompanyID = ?').get(companyId);

  // Sales invoices honour the company's configurable invoice prefix; everything
  // else uses the fixed type code.
  const base = (docType === 'INV' && company && company.InvoicePrefix)
    ? company.InvoicePrefix
    : DOC_TYPES[docType].defaultPrefix;
  const prefix = branch ? `${branch.BranchCode}-${base}` : base;

  const seq = ensureSequence(companyId, branchId || null, docType, fyName, prefix);

  // Compose first: if the result would be an invalid number the caller's
  // transaction aborts before a counter value is consumed.
  const number = composeNumber(seq.Prefix, fyName, seq.NextNumber, seq.Padding || DEFAULT_PADDING);

  // Read-and-increment as one statement. Under better-sqlite3 the surrounding
  // transaction serialises writers, so the number handed out here is unique.
  db.prepare('UPDATE DocumentSequence SET NextNumber = NextNumber + 1 WHERE SequenceID = ?').run(seq.SequenceID);
  return number;
}

/** Read-only preview of what the next number would be, for the Settings screen. */
function peekNextNumber(companyId, branchId, docType) {
  const fy = activeFinancialYear(companyId);
  const fyName = fy ? fy.YearName : 'ALL';
  const row = db.prepare(
    `SELECT * FROM DocumentSequence WHERE CompanyID = ? AND DocType = ? AND FinancialYear = ?
       AND ${branchId ? 'BranchID = ?' : 'BranchID IS NULL'}`
  ).get(...(branchId ? [companyId, docType, fyName, branchId] : [companyId, docType, fyName]));
  if (!row) return null;
  try { return composeNumber(row.Prefix, fyName, row.NextNumber, row.Padding || DEFAULT_PADDING); }
  catch (e) { return null; }
}

module.exports = {
  MAX_NUMBER_LENGTH, composeNumber, checkPrefix, DEFAULT_PADDING,
  DOC_TYPES, nextDocumentNumber, peekNextNumber,
  activeFinancialYear, financialYearForDate, assertYearOpen
};
