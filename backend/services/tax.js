/* =========================================================================
   GST LINE COMPUTATION AND THE CGST / SGST / IGST SPLIT
   -------------------------------------------------------------------------
   Every document line on an Indian tax invoice has to carry its tax broken
   into the right heads, and the break depends on where the goods went, not on
   anything the operator types. Doing that arithmetic in one place - here -
   means a sales invoice, a purchase bill, a credit note and the GSTR-1 return
   can never disagree about the same transaction.

   The rule (Sections 7 and 8, IGST Act): supplier's state and recipient's
   state the same -> intra-state -> the tax splits half CGST, half SGST.
   Different states -> inter-state -> the whole amount is IGST.
   ========================================================================= */

// GST state codes. The first two digits of a GSTIN are the state code, which
// makes a GSTIN the most reliable source of a party's state - people spell
// state names every way imaginable, but a GSTIN is machine-checkable.
const STATE_CODES = {
  'jammu and kashmir': '01', 'himachal pradesh': '02', 'punjab': '03', 'chandigarh': '04',
  'uttarakhand': '05', 'haryana': '06', 'delhi': '07', 'rajasthan': '08', 'uttar pradesh': '09',
  'bihar': '10', 'sikkim': '11', 'arunachal pradesh': '12', 'nagaland': '13', 'manipur': '14',
  'mizoram': '15', 'tripura': '16', 'meghalaya': '17', 'assam': '18', 'west bengal': '19',
  'jharkhand': '20', 'odisha': '21', 'orissa': '21', 'chhattisgarh': '22', 'madhya pradesh': '23',
  'gujarat': '24', 'daman and diu': '26', 'dadra and nagar haveli': '26', 'maharashtra': '27',
  'karnataka': '29', 'goa': '30', 'lakshadweep': '31', 'kerala': '32', 'tamil nadu': '33',
  'puducherry': '34', 'pondicherry': '34', 'andaman and nicobar islands': '35', 'telangana': '36',
  'andhra pradesh': '37', 'ladakh': '38', 'other territory': '97'
};

const CODE_TO_STATE = Object.entries(STATE_CODES).reduce((acc, [name, code]) => {
  if (!acc[code]) acc[code] = name.replace(/\b\w/g, c => c.toUpperCase());
  return acc;
}, {});

function normaliseState(name) {
  return String(name || '').trim().toLowerCase();
}

/**
 * The two-digit GST state code for a party.
 *
 * A GSTIN wins over a typed state name whenever both are present: the GSTIN is
 * issued by the department and carries the code in its first two characters,
 * whereas "Orissa" / "Odisha" / "odisa" are all things people actually type.
 */
function stateCodeFor(stateName, gstin) {
  const fromGstin = String(gstin || '').trim().slice(0, 2);
  if (/^\d{2}$/.test(fromGstin) && CODE_TO_STATE[fromGstin]) return fromGstin;
  return STATE_CODES[normaliseState(stateName)] || '';
}

function stateNameForCode(code) {
  return CODE_TO_STATE[String(code || '').trim()] || '';
}

/**
 * Is this an inter-state supply?
 *
 * Compared by state CODE, not by name, so "Odisha" and "Orissa" are recognised
 * as one state rather than being taxed as an inter-state supply. When either
 * side's state is genuinely unknown we fall back to intra-state, which is the
 * common case for a single-state branch and the safer default: it produces a
 * CGST/SGST invoice that the accountant will spot, rather than IGST that
 * quietly under-collects one head.
 */
function isInterState(supplierState, partyState, { supplierGstin, partyGstin } = {}) {
  const a = stateCodeFor(supplierState, supplierGstin);
  const b = stateCodeFor(partyState, partyGstin);
  if (!a || !b) {
    // No codes to compare - fall back to a plain name comparison if we have
    // both names, otherwise assume intra-state.
    const an = normaliseState(supplierState), bn = normaliseState(partyState);
    return !!(an && bn && an !== bn);
  }
  return a !== b;
}

function round2(n) { return Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100; }

function splitGst(amount, supplierState, partyState, gstins) {
  const total = Number(amount) || 0;
  if (isInterState(supplierState, partyState, gstins)) {
    return { cgst: 0, sgst: 0, igst: round2(total) };
  }
  // Halving can leave a stray paisa; give it to CGST so the two halves always
  // add back up to the tax actually charged.
  const half = round2(total / 2);
  return { cgst: round2(total - half), sgst: half, igst: 0 };
}

/**
 * Every number a tax-invoice line needs, from what the operator entered.
 *
 * Input:  qty, rate, discountPercent OR discount (an amount), gstRate
 * Output: amount (gross of discount), discount amount, nett (taxable), the
 *         three tax heads with their rates, and the line total.
 *
 * Discount can be given either way round because both exist in the wild: a
 * percentage off list, or a negotiated rupee figure. A percentage wins if both
 * are supplied, since that is the one that was calculated from the price.
 */
function computeLine(line, supplierState, partyState, gstins) {
  const qty = Number(line.qty) || 0;
  const rate = Number(line.rate) || 0;
  const gstRate = Number(line.gst !== undefined ? line.gst : line.gstRate) || 0;

  const amount = round2(qty * rate);

  const discPercent = Number(line.discountPercent) || 0;
  const discAmount = discPercent > 0
    ? round2(amount * discPercent / 100)
    : round2(Number(line.discount) || 0);

  const nett = round2(amount - discAmount);
  const tax = round2(nett * gstRate / 100);
  const { cgst, sgst, igst } = splitGst(tax, supplierState, partyState, gstins);

  const interState = igst > 0 || (tax === 0 && isInterState(supplierState, partyState, gstins));
  const halfRate = round2(gstRate / 2);

  return {
    qty, rate,
    amount,
    discountPercent: discPercent,
    discountAmount: discAmount,
    nettAmount: nett,
    gstRate,
    igstPercent: interState ? gstRate : 0,
    igstAmount: igst,
    cgstPercent: interState ? 0 : halfRate,
    cgstAmount: cgst,
    sgstPercent: interState ? 0 : halfRate,
    sgstAmount: sgst,
    taxAmount: tax,
    grossAmount: round2(nett + tax),
    interState
  };
}

module.exports = {
  STATE_CODES, CODE_TO_STATE, stateCodeFor, stateNameForCode,
  isInterState, splitGst, computeLine, round2
};
