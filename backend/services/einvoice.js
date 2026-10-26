/**
 * E-invoice (IRN/QR) and e-way-bill generation (R3 / EIN-01, EWB-01/02).
 *
 * MODE. With no GST Suvidha Provider (GSP) credentials wired up, this runs in
 * "sandbox" mode: it builds the exact JSON payload the IRP / EWB portal expects,
 * computes the standard IRN hash, and returns an acknowledgement, a QR payload
 * and an e-way-bill number locally. The shape is production-correct, so turning
 * on a real GSP is a matter of POSTing `payload` to the provider and storing the
 * IRN/AckNo/SignedQR they return, instead of the ones generated here. The code
 * marks every document with its Mode so a sandbox IRN is never mistaken for a
 * filed one.
 */
const crypto = require('crypto');

const EWAY_THRESHOLD = Number(process.env.EWAY_THRESHOLD || 50000);   // ₹ value above which an e-way bill is required
const EINVOICE_TURNOVER_ENABLED = process.env.EINVOICE_DISABLED !== '1';

function round2(n) { return Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100; }

/** Financial year "2026-27" for a date (India's April–March year). */
function financialYear(dateStr) {
  const d = new Date(String(dateStr).slice(0, 10) + 'T00:00:00Z');
  const y = d.getUTCFullYear(), m = d.getUTCMonth(); // 0=Jan
  const start = m >= 3 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}
function ddmmyyyy(dateStr) {
  const d = String(dateStr).slice(0, 10).split('-');
  return `${d[2]}/${d[1]}/${d[0]}`;
}

/**
 * The IRN is the SHA-256 hash of supplier GSTIN + doc type + doc number +
 * financial year (the NIC-documented hash input), as 64 lowercase hex chars.
 */
function computeIrn(supplierGstin, docType, docNo, fy) {
  const input = `${supplierGstin}${docType}${docNo}${fy}`;
  return crypto.createHash('sha256').update(input).digest('hex');
}

/** Build the canonical IRP e-invoice payload (schema v1.1, trimmed to essentials). */
function buildEInvoicePayload({ company, branch, buyer, header, lines }) {
  const docNo = header.InvoiceNo;
  const fy = financialYear(header.InvoiceDate);
  const isB2B = !!(buyer.GSTIN && String(buyer.GSTIN).trim());
  const itemList = lines.map((l, i) => ({
    SlNo: String(i + 1),
    PrdDesc: l.ItemName || l.ItemDesc || `Item ${l.ItemID}`,
    IsServc: 'N',
    HsnCd: l.HSN || '9999',
    Qty: l.Qty, Unit: l.Unit || 'NOS',
    UnitPrice: round2(l.Rate),
    TotAmt: round2(l.Qty * l.Rate),
    Discount: round2(l.Discount || 0),
    AssAmt: round2(l.NettAmount != null ? l.NettAmount : (l.Qty * l.Rate - (l.Discount || 0))),
    GstRt: l.GST || 0,
    IgstAmt: round2(l.IGSTAmount || 0),
    CgstAmt: round2(l.CGSTAmount || 0),
    SgstAmt: round2(l.SGSTAmount || 0),
    TotItemVal: round2(l.GrossAmount != null ? l.GrossAmount : (l.Qty * l.Rate))
  }));
  return {
    Version: '1.1',
    TranDtls: { TaxSch: 'GST', SupTyp: 'B2B', RegRev: header.ReverseCharge ? 'Y' : 'N' },
    DocDtls: { Typ: 'INV', No: docNo, Dt: ddmmyyyy(header.InvoiceDate) },
    SellerDtls: {
      Gstin: branch.GSTIN || company.GSTIN, LglNm: company.CompanyName,
      Addr1: branch.Address || '', Loc: branch.State || '', Pin: branch.Pin || 0,
      Stcd: (branch.GSTIN || company.GSTIN || '').slice(0, 2)
    },
    BuyerDtls: {
      Gstin: isB2B ? buyer.GSTIN : 'URP', LglNm: buyer.CustomerName,
      Pos: (buyer.StateCode || (buyer.GSTIN || '').slice(0, 2) || '96'),
      Addr1: buyer.Address || '', Loc: buyer.State || '',
      Stcd: (buyer.StateCode || (buyer.GSTIN || '').slice(0, 2) || '96')
    },
    ItemList: itemList,
    ValDtls: {
      AssVal: round2(header.Total),
      IgstVal: round2(lines.reduce((s, l) => s + (l.IGSTAmount || 0), 0)),
      CgstVal: round2(lines.reduce((s, l) => s + (l.CGSTAmount || 0), 0)),
      SgstVal: round2(lines.reduce((s, l) => s + (l.SGSTAmount || 0), 0)),
      TotInvVal: round2(header.NetAmount)
    },
    _meta: { fy, isB2B }
  };
}

/** Generate the e-invoice: IRN, acknowledgement and the QR payload. */
function generateEInvoice({ company, branch, buyer, header, lines }) {
  if (!EINVOICE_TURNOVER_ENABLED) throw new Error('E-invoicing is disabled on this server');
  const sellerGstin = branch.GSTIN || company.GSTIN;
  if (!sellerGstin) throw new Error('The branch has no GSTIN - an e-invoice needs a registered supplier');
  const payload = buildEInvoicePayload({ company, branch, buyer, header, lines });
  const fy = payload._meta.fy;
  const irn = computeIrn(sellerGstin, 'INV', header.InvoiceNo, fy);
  const now = new Date();
  const ackNo = String(Math.abs(hashInt(irn)) % 1e12).padStart(12, '0');
  const ackDate = now.toISOString().replace('T', ' ').slice(0, 19);
  // The QR carries the signed invoice summary. In sandbox it is a base64 JSON of
  // the standard QR fields (unsigned); live mode replaces this with the IRP JWT.
  const qrData = {
    SellerGstin: sellerGstin, BuyerGstin: payload.BuyerDtls.Gstin,
    DocNo: header.InvoiceNo, DocTyp: 'INV', DocDt: ddmmyyyy(header.InvoiceDate),
    TotInvVal: round2(header.NetAmount), ItemCnt: lines.length,
    MainHsnCode: lines[0] ? (lines[0].HSN || '9999') : '9999', Irn: irn, IrnDt: ackDate
  };
  const signedQR = Buffer.from(JSON.stringify(qrData)).toString('base64');
  return { irn, ackNo, ackDate, signedQR, payload, mode: 'sandbox' };
}

/** Whether an e-way bill is required for this invoice (EWB-02). */
function ewayRequired({ header, lines }) {
  const value = round2(header.NetAmount);
  const hasGoods = lines.some(l => String(l.IsServc || 'N') !== 'Y');  // treat items as goods by default
  return {
    required: hasGoods && value > EWAY_THRESHOLD,
    value, threshold: EWAY_THRESHOLD, hasGoods,
    reason: !hasGoods ? 'Services only - no e-way bill needed'
      : value <= EWAY_THRESHOLD ? `Invoice value ${value} is at or below the ₹${EWAY_THRESHOLD} threshold`
      : `Goods over ₹${EWAY_THRESHOLD} - an e-way bill is required`
  };
}

/** Generate an e-way bill: number, validity and the EWB payload. */
function generateEWayBill({ company, branch, buyer, header, lines, transport }) {
  const sellerGstin = branch.GSTIN || company.GSTIN;
  const elig = ewayRequired({ header, lines });
  if (!elig.required) throw new Error(`No e-way bill needed: ${elig.reason}`);
  const t = transport || {};
  const payload = {
    supplyType: 'O', subSupplyType: '1', docType: 'INV', docNo: header.InvoiceNo, docDate: ddmmyyyy(header.InvoiceDate),
    fromGstin: sellerGstin, fromPincode: branch.Pin || 0, fromStateCode: (sellerGstin || '').slice(0, 2),
    toGstin: buyer.GSTIN || 'URP', toPincode: buyer.Pin || 0, toStateCode: (buyer.StateCode || (buyer.GSTIN || '').slice(0, 2) || '96'),
    totalValue: round2(header.Total), totInvValue: round2(header.NetAmount),
    cgstValue: round2(lines.reduce((s, l) => s + (l.CGSTAmount || 0), 0)),
    sgstValue: round2(lines.reduce((s, l) => s + (l.SGSTAmount || 0), 0)),
    igstValue: round2(lines.reduce((s, l) => s + (l.IGSTAmount || 0), 0)),
    transMode: t.transMode || '1', transDistance: String(t.distance || 0),
    transporterName: t.transporterName || header.TransporterName || '',
    vehicleNo: t.vehicleNo || '', vehicleType: 'R',
    itemList: lines.map(l => ({ productName: l.ItemName || `Item ${l.ItemID}`, hsnCode: l.HSN || '9999', quantity: l.Qty, qtyUnit: l.Unit || 'NOS', taxableAmount: round2(l.NettAmount != null ? l.NettAmount : l.Qty * l.Rate), cgstRate: 0, sgstRate: 0, igstRate: l.GST || 0 }))
  };
  const ewbNo = String(Math.abs(hashInt(sellerGstin + header.InvoiceNo + 'EWB')) % 1e12).padStart(12, '0');
  const now = new Date();
  // Validity: 1 day up to 200 km, +1 day per extra 200 km (over-dimensional ignored).
  const days = Math.max(1, Math.ceil((Number(t.distance) || 1) / 200));
  const validUpto = new Date(now.getTime() + days * 86400000);
  return {
    ewbNo, ewbDate: now.toISOString().replace('T', ' ').slice(0, 19),
    validUpto: validUpto.toISOString().replace('T', ' ').slice(0, 19),
    distance: Number(t.distance) || 0, payload, mode: 'sandbox'
  };
}

function hashInt(s) {
  const h = crypto.createHash('sha256').update(String(s)).digest();
  return h.readInt32BE(0);
}

module.exports = { financialYear, computeIrn, buildEInvoicePayload, generateEInvoice, ewayRequired, generateEWayBill, EWAY_THRESHOLD };
