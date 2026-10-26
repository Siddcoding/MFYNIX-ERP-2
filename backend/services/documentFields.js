/* =========================================================================
   SHARED DOCUMENT FIELDS
   -------------------------------------------------------------------------
   A sales invoice, a purchase bill, a credit note and a debit note are the
   same document with a different sign and a different party. They carry the
   same statutory header (reference, order, transporter, e-way bill, reverse
   charge, party PAN/GSTIN/state) and the same line shape (item snapshot,
   batch, dates, discount, the three tax heads).

   Writing that four times would guarantee they drift apart, and the one that
   drifts is the one the department asks about. So it lives here once.

   Two things are deliberate:

   1. THE PARTY AND ITEM DETAILS ARE SNAPSHOT, NOT JOINED. An invoice is a
      record of what was true on the day it was raised. If a customer changes
      their GSTIN, or an item is renamed, last year's invoices must still
      print exactly as they were filed.

   2. THE TAX HEADS ARE STORED, NOT RECOMPUTED ON READ. The printed invoice
      and the filed return then cannot disagree, however the state masters are
      edited afterwards.
   ========================================================================= */
const { computeLine, stateCodeFor } = require('./tax');

// Header fields accepted from the client, with the JSON name people would
// naturally use on the left and the column on the right.
const HEADER_FIELDS = [
  ['refNo', 'RefNo'], ['refDate', 'RefDate'],
  ['irn', 'IRN'], ['eWayBillNo', 'EWayBillNo'],
  ['orderNo', 'OrderNo'], ['orderDate', 'OrderDate'],
  ['transporterName', 'TransporterName'],
  ['consignmentNo', 'ConsignmentNo'], ['consignmentDate', 'ConsignmentDate'],
  ['payLedger', 'PayLedger'],
  ['remarks', 'Remarks'],
];

const PAY_LEDGERS = ['Cash', 'Bank', 'Credit', 'UPI', 'Cheque'];
const PARTY_TYPES = ['Registered', 'Unregistered', 'Composition', 'SEZ', 'Export', 'Deemed Export'];

/**
 * Pull the optional header fields out of a request body.
 * Anything absent stays absent rather than being written as an empty string,
 * so "not supplied" and "deliberately blank" remain distinguishable.
 */
function headerFieldsFrom(body = {}) {
  const out = {};
  HEADER_FIELDS.forEach(([key, column]) => {
    const v = body[key];
    if (v !== undefined && v !== null && String(v).trim() !== '') out[column] = String(v).trim();
  });

  if (body.reverseCharge !== undefined) {
    out.ReverseCharge = (body.reverseCharge === true || body.reverseCharge === 1 ||
      String(body.reverseCharge).toLowerCase() === 'yes' || String(body.reverseCharge) === '1') ? 1 : 0;
  }
  if (body.payLedger && !PAY_LEDGERS.includes(out.PayLedger)) {
    // Not fatal - a business may settle in a way we did not list - but keep it
    // tidy by title-casing what came in.
    out.PayLedger = String(body.payLedger).trim();
  }
  return out;
}

/**
 * Everything about the party that has to be frozen onto the document.
 * `kind` is 'Customer' or 'Supplier'.
 */
function partySnapshot(db, kind, partyId) {
  const table = kind === 'Supplier' ? 'Supplier' : 'Customer';
  const idCol = kind === 'Supplier' ? 'SupplierID' : 'CustomerID';
  const nameCol = kind === 'Supplier' ? 'SupplierName' : 'CustomerName';
  const p = db.prepare(`SELECT * FROM ${table} WHERE ${idCol} = ?`).get(partyId);
  if (!p) return {};

  const stateCode = p.StateCode || stateCodeFor(p.State, p.GSTIN);
  return {
    name: p[nameCol],
    PartyPhone: p.Mobile || null,
    PartyPAN: p.PAN || (p.GSTIN ? String(p.GSTIN).slice(2, 12) : null),   // PAN sits inside a GSTIN
    PartyGSTIN: p.GSTIN || null,
    PartyState: p.State || null,
    PartyStateCode: stateCode || null,
    PartyType: p.PartyType || (p.GSTIN ? 'Registered' : 'Unregistered'),
    PlaceOfSupply: p.State || null,
    _state: p.State,
    _gstin: p.GSTIN
  };
}

/**
 * The supplier side of the place-of-supply test: the BRANCH's state, and the
 * BRANCH's own GSTIN if it has one.
 *
 * Not the company's. A company registered in Odisha can run a branch in
 * Telangana, and that branch's sales inside Telangana are intra-state supplies.
 * Resolving the supplier's state from the company's GSTIN would tax every one
 * of them as inter-state IGST - wrong tax, wrong heads, wrong return. Branches
 * that have their own registration carry their own GSTIN; the rest fall back to
 * the branch's state name.
 */
function branchIdentity(db, branchId) {
  const b = db.prepare('SELECT State, GSTIN FROM Branch WHERE BranchID = ?').get(branchId);
  return { state: b ? b.State : null, gstin: b ? b.GSTIN : null };
}

// Kept for callers that only want the name.
function branchState(db, branchId) {
  return branchIdentity(db, branchId).state;
}

function companyGstin(db, companyId) {
  const c = db.prepare('SELECT GSTIN FROM Company WHERE CompanyID = ?').get(companyId);
  return c ? c.GSTIN : null;
}

/**
 * Turn the request's item lines into fully computed, fully snapshot lines.
 *
 * Returns { lines, totals } where totals carry the document-level figures the
 * header stores, each summed from the lines rather than computed separately —
 * a header that disagrees with the sum of its own lines is the classic
 * invoice bug, and summing is the only way to be sure it cannot happen.
 */
function buildLines(db, { companyId, branchId, items, supplierState, party }) {
  const itemStmt = db.prepare('SELECT * FROM Item WHERE ItemID = ? AND CompanyID = ?');

  // Resolved here from branchId rather than trusted from the caller, so no
  // route can accidentally hand in the company's identity for the branch's.
  const branch = branchIdentity(db, branchId);
  const gstins = { supplierGstin: branch.gstin, partyGstin: party ? party._gstin : null };
  const partyState = party ? party._state : null;
  const sellerState = supplierState || branch.state;

  const lines = items.map(it => {
    const master = itemStmt.get(it.itemId, companyId) || {};
    const computed = computeLine(it, sellerState, partyState, gstins);
    return {
      ...computed,
      itemId: it.itemId,
      // Snapshot: what the item was called and coded on the day.
      ItemCode: it.itemCode || master.ItemCode || null,
      ItemDesc: it.itemDesc || master.ItemName || null,
      HSN: it.hsn || master.HSN || null,
      Unit: it.unit || master.Unit || null,
      // Traceability, only meaningful for items that are batch-tracked, but
      // accepted on any line because the operator may know better than the master.
      BatchNo: it.batchNo || null,
      MfgDate: it.mfgDate || null,
      ExpDate: it.expDate || null
    };
  });

  const sum = (f) => Math.round(lines.reduce((s, l) => s + (l[f] || 0), 0) * 100) / 100;
  const totals = {
    taxable: sum('nettAmount'),
    discount: sum('discountAmount'),
    cgst: sum('cgstAmount'),
    sgst: sum('sgstAmount'),
    igst: sum('igstAmount'),
    tax: sum('taxAmount'),
    gross: sum('grossAmount')
  };

  return { lines, totals };
}

// The column list and value builder for the extended detail tables, so the
// three routes insert identical shapes.
const LINE_COLUMNS = [
  'ItemCode', 'ItemDesc', 'HSN', 'Unit', 'BatchNo', 'MfgDate', 'ExpDate',
  'DiscountPercent', 'NettAmount',
  'IGSTPercent', 'IGSTAmount', 'CGSTPercent', 'CGSTAmount',
  'SGSTPercent', 'SGSTAmount', 'GrossAmount'
];

function lineValues(l) {
  return [
    l.ItemCode, l.ItemDesc, l.HSN, l.Unit, l.BatchNo, l.MfgDate, l.ExpDate,
    l.discountPercent, l.nettAmount,
    l.igstPercent, l.igstAmount, l.cgstPercent, l.cgstAmount,
    l.sgstPercent, l.sgstAmount, l.grossAmount
  ];
}

module.exports = {
  HEADER_FIELDS, PAY_LEDGERS, PARTY_TYPES,
  headerFieldsFrom, partySnapshot, branchState, branchIdentity, companyGstin,
  buildLines, LINE_COLUMNS, lineValues
};
