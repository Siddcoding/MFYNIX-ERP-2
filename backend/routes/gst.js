const express = require('express');
const db = require('../db');
const { requireAuth, resolveBranchScope } = require('../middleware/auth');
const { logAudit } = require('./auth');

const router = express.Router();
router.use(requireAuth);

// Same access rule as Accounts: GST returns are books-of-account output.
const GST_ROLES = ['Super Admin', 'Company Admin', 'Accountant', 'Auditor'];
router.use((req, res, next) => {
  if (!GST_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'You do not have access to GST Filing' });
  }
  next();
});
function requireFilingRights(req, res, next) {
  if (req.user.role === 'Auditor') return res.status(403).json({ error: 'Auditor access is read-only' });
  next();
}

function validPeriod(p) { return typeof p === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(p); }

/**
 * Splits a GST amount into CGST/SGST or IGST.
 *
 * Place-of-supply rule (Section 7/8, IGST Act): if the supplier's state and
 * the recipient's state are the same it's an intra-state supply -> the tax is
 * split half CGST / half SGST. Different states -> inter-state -> all IGST.
 * We compare the BRANCH's state (that's the place of supply for the seller)
 * with the counterparty's state. If either state is unknown we fall back to
 * intra-state, which is the common case for a single-state branch.
 */
function splitGst(amount, supplierState, partyState) {
  const known = supplierState && partyState;
  const interState = known && String(supplierState).trim().toLowerCase() !== String(partyState).trim().toLowerCase();
  if (interState) return { cgst: 0, sgst: 0, igst: amount };
  return { cgst: amount / 2, sgst: amount / 2, igst: 0 };
}

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

// Pulls every sales invoice for a period (optionally one branch) with the
// per-invoice taxable value + GST, plus the states needed to split the tax.
function salesForPeriod(companyId, branchId, period) {
  return db.prepare(
    `SELECT s.InvoiceID, s.InvoiceNo, s.InvoiceDate, s.Total, s.GST, s.NetAmount,
            c.CustomerName, c.GSTIN AS CustomerGSTIN, c.State AS CustomerState,
            b.BranchName, b.BranchCode, b.State AS BranchState, s.BranchID
     FROM SalesHeader s
     JOIN Customer c ON c.CustomerID = s.CustomerID
     JOIN Branch b ON b.BranchID = s.BranchID
     WHERE s.CompanyID = ? AND s.Status != 'Cancelled'
       AND substr(s.InvoiceDate,1,7) = ? ${branchId ? 'AND s.BranchID = ?' : ''}
     ORDER BY s.InvoiceDate, s.InvoiceID`
  ).all(...(branchId ? [companyId, period, branchId] : [companyId, period]));
}

function purchasesForPeriod(companyId, branchId, period) {
  return db.prepare(
    `SELECT p.PurchaseID, p.PurchaseNo, p.PurchaseDate, p.Total, p.GST, p.NetAmount,
            sp.SupplierName, sp.GSTIN AS SupplierGSTIN, sp.State AS SupplierState,
            b.BranchName, b.BranchCode, b.State AS BranchState, p.BranchID
     FROM PurchaseHeader p
     JOIN Supplier sp ON sp.SupplierID = p.SupplierID
     JOIN Branch b ON b.BranchID = p.BranchID
     WHERE p.CompanyID = ? AND p.Status != 'Cancelled'
       AND substr(p.PurchaseDate,1,7) = ? ${branchId ? 'AND p.BranchID = ?' : ''}
     ORDER BY p.PurchaseDate, p.PurchaseID`
  ).all(...(branchId ? [companyId, period, branchId] : [companyId, period]));
}

// ---------------- GSTR-1: outward supplies ----------------
// B2B  = customer has a GSTIN (invoice-level detail is required)
// B2CS = customer has no GSTIN (reported as a consolidated summary by rate/state)
router.get('/gstr1', (req, res) => {
  const period = req.query.period;
  if (!validPeriod(period)) return res.status(400).json({ error: 'period must be in YYYY-MM format' });
  const branchId = resolveBranchScope(req);

  const invoices = salesForPeriod(req.user.companyId, branchId, period);

  const b2b = [];
  const b2cBuckets = new Map();   // key: state|rate

  for (const inv of invoices) {
    const taxable = inv.Total;
    const gst = inv.GST;
    const split = splitGst(gst, inv.BranchState, inv.CustomerState);
    // Effective rate, derived from the invoice rather than assumed - a single
    // invoice can mix rates, so this is the blended rate for reporting.
    const rate = taxable > 0 ? round2((gst / taxable) * 100) : 0;

    if (inv.CustomerGSTIN && String(inv.CustomerGSTIN).trim()) {
      b2b.push({
        invoiceNo: inv.InvoiceNo, invoiceDate: inv.InvoiceDate,
        customerName: inv.CustomerName, gstin: inv.CustomerGSTIN,
        placeOfSupply: inv.CustomerState || inv.BranchState || '',
        branch: `${inv.BranchName} (${inv.BranchCode})`,
        taxableValue: round2(taxable), rate,
        cgst: round2(split.cgst), sgst: round2(split.sgst), igst: round2(split.igst),
        invoiceValue: round2(inv.NetAmount)
      });
    } else {
      const state = inv.CustomerState || inv.BranchState || 'Unknown';
      const key = `${state}|${rate}`;
      const bucket = b2cBuckets.get(key) || { placeOfSupply: state, rate, taxableValue: 0, cgst: 0, sgst: 0, igst: 0, invoiceCount: 0 };
      bucket.taxableValue += taxable;
      bucket.cgst += split.cgst; bucket.sgst += split.sgst; bucket.igst += split.igst;
      bucket.invoiceCount += 1;
      b2cBuckets.set(key, bucket);
    }
  }

  const b2cs = [...b2cBuckets.values()].map(b => ({
    ...b, taxableValue: round2(b.taxableValue), cgst: round2(b.cgst), sgst: round2(b.sgst), igst: round2(b.igst)
  }));

  const sum = (arr, f) => round2(arr.reduce((s, r) => s + f(r), 0));
  const totals = {
    taxableValue: round2(sum(b2b, r => r.taxableValue) + sum(b2cs, r => r.taxableValue)),
    cgst: round2(sum(b2b, r => r.cgst) + sum(b2cs, r => r.cgst)),
    sgst: round2(sum(b2b, r => r.sgst) + sum(b2cs, r => r.sgst)),
    igst: round2(sum(b2b, r => r.igst) + sum(b2cs, r => r.igst)),
    invoiceCount: invoices.length
  };
  totals.totalTax = round2(totals.cgst + totals.sgst + totals.igst);

  res.json({ period, branchId: branchId || null, b2b, b2cs, totals });
});

// ---------------- GSTR-3B: summary return + net payable ----------------
// Extracted as a function so the filing-log route stores exactly the same
// numbers the report shows - they can't drift apart.
function computeGstr3b(companyId, branchId, period) {
  const sales = salesForPeriod(companyId, branchId, period);
  const purchases = purchasesForPeriod(companyId, branchId, period);

  const outward = { taxableValue: 0, cgst: 0, sgst: 0, igst: 0 };
  sales.forEach(inv => {
    const s = splitGst(inv.GST, inv.BranchState, inv.CustomerState);
    outward.taxableValue += inv.Total;
    outward.cgst += s.cgst; outward.sgst += s.sgst; outward.igst += s.igst;
  });

  const inward = { taxableValue: 0, cgst: 0, sgst: 0, igst: 0 };
  purchases.forEach(p => {
    const s = splitGst(p.GST, p.BranchState, p.SupplierState);
    inward.taxableValue += p.Total;
    inward.cgst += s.cgst; inward.sgst += s.sgst; inward.igst += s.igst;
  });

  // ---- Input tax credit set-off, per Section 49/49A of the CGST Act ----
  //
  // Credit heads are NOT independent. The mandated order is:
  //   1. IGST credit must be exhausted first - against IGST liability, then
  //      against CGST, then against SGST.
  //   2. CGST credit then covers CGST liability, and any balance may go
  //      against IGST. It can NEVER be used against SGST.
  //   3. SGST credit covers SGST liability, balance against IGST. Never CGST.
  //
  // Offsetting each head in isolation (the naive approach) overstates what's
  // payable whenever a business buys inter-state and sells intra-state - a
  // very common pattern for a multi-branch company, which is exactly what
  // this system is for. So the set-off is modelled properly.
  const credit = { igst: inward.igst, cgst: inward.cgst, sgst: inward.sgst };
  const due = { igst: outward.igst, cgst: outward.cgst, sgst: outward.sgst };
  const utilised = {
    igst: { igst: 0, cgst: 0, sgst: 0 },   // [creditHead][liabilityHead]
    cgst: { igst: 0, cgst: 0, sgst: 0 },
    sgst: { igst: 0, cgst: 0, sgst: 0 }
  };
  function apply(creditHead, liabilityHead) {
    const amount = Math.min(credit[creditHead], due[liabilityHead]);
    if (amount <= 0) return;
    credit[creditHead] -= amount;
    due[liabilityHead] -= amount;
    utilised[creditHead][liabilityHead] += amount;
  }
  apply('igst', 'igst'); apply('igst', 'cgst'); apply('igst', 'sgst');
  apply('cgst', 'cgst'); apply('cgst', 'igst');
  apply('sgst', 'sgst'); apply('sgst', 'igst');

  function head(name) {
    const usedAgainst = utilised.igst[name] + utilised.cgst[name] + utilised.sgst[name];
    return {
      output: round2(outward[name]),
      input: round2(inward[name]),
      creditUtilised: round2(usedAgainst),
      payable: round2(due[name]),          // cash payable after set-off
      carryForward: round2(credit[name])   // unused credit of this head
    };
  }
  const liability = { cgst: head('cgst'), sgst: head('sgst'), igst: head('igst') };
  const netPayable = round2(liability.cgst.payable + liability.sgst.payable + liability.igst.payable);
  const totalCarryForward = round2(liability.cgst.carryForward + liability.sgst.carryForward + liability.igst.carryForward);
  const setOff = utilised;

  return {
    period, branchId: branchId || null,
    outwardSupplies: {
      taxableValue: round2(outward.taxableValue), cgst: round2(outward.cgst),
      sgst: round2(outward.sgst), igst: round2(outward.igst), invoiceCount: sales.length
    },
    inwardSupplies: {
      taxableValue: round2(inward.taxableValue), cgst: round2(inward.cgst),
      sgst: round2(inward.sgst), igst: round2(inward.igst), invoiceCount: purchases.length
    },
    liability, setOff, netPayable, totalCarryForward
  };
}

router.get('/gstr3b', (req, res) => {
  const period = req.query.period;
  if (!validPeriod(period)) return res.status(400).json({ error: 'period must be in YYYY-MM format' });
  res.json(computeGstr3b(req.user.companyId, resolveBranchScope(req), period));
});

// ---------------- Branch-wise GST summary (head office view) ----------------
router.get('/branch-summary', (req, res) => {
  const period = req.query.period;
  if (!validPeriod(period)) return res.status(400).json({ error: 'period must be in YYYY-MM format' });

  const branches = db.prepare('SELECT BranchID, BranchName, BranchCode, GSTIN, State FROM Branch WHERE CompanyID = ? AND IsActive = 1').all(req.user.companyId)
    .filter(b => !req.user.branchId || b.BranchID === req.user.branchId);

  const rows = branches.map(b => {
    const sales = salesForPeriod(req.user.companyId, b.BranchID, period);
    const purchases = purchasesForPeriod(req.user.companyId, b.BranchID, period);
    const outputTax = sales.reduce((s, i) => s + i.GST, 0);
    const inputTax = purchases.reduce((s, i) => s + i.GST, 0);
    return {
      branchId: b.BranchID, branchName: b.BranchName, branchCode: b.BranchCode,
      gstin: b.GSTIN || '', state: b.State || '',
      outwardTaxable: round2(sales.reduce((s, i) => s + i.Total, 0)),
      outputTax: round2(outputTax),
      inwardTaxable: round2(purchases.reduce((s, i) => s + i.Total, 0)),
      inputTax: round2(inputTax),
      netPayable: round2(Math.max(0, outputTax - inputTax)),
      salesCount: sales.length, purchaseCount: purchases.length
    };
  });

  res.json({ period, branches: rows });
});

// ---------------- HSN summary (GSTR-1 Table 12) ----------------
router.get('/hsn-summary', (req, res) => {
  const period = req.query.period;
  if (!validPeriod(period)) return res.status(400).json({ error: 'period must be in YYYY-MM format' });
  const branchId = resolveBranchScope(req);

  const rows = db.prepare(
    `SELECT COALESCE(NULLIF(i.HSN,''), 'NOT SET') AS HSN, i.ItemName, i.Unit,
            SUM(sd.Qty) AS Qty,
            SUM(sd.Qty * sd.Rate - sd.Discount) AS TaxableValue,
            SUM(sd.Amount - (sd.Qty * sd.Rate - sd.Discount)) AS TaxAmount
     FROM SalesDetail sd
     JOIN SalesHeader s ON s.InvoiceID = sd.InvoiceID
     JOIN Item i ON i.ItemID = sd.ItemID
     WHERE s.CompanyID = ? AND s.Status != 'Cancelled'
       AND substr(s.InvoiceDate,1,7) = ? ${branchId ? 'AND s.BranchID = ?' : ''}
     GROUP BY COALESCE(NULLIF(i.HSN,''), 'NOT SET'), i.ItemID
     ORDER BY TaxableValue DESC`
  ).all(...(branchId ? [req.user.companyId, period, branchId] : [req.user.companyId, period]));

  res.json(rows.map(r => ({
    hsn: r.HSN, itemName: r.ItemName, unit: r.Unit, qty: round2(r.Qty),
    taxableValue: round2(r.TaxableValue), taxAmount: round2(r.TaxAmount)
  })));
});

// ---------------- Filing log: generate / list / mark filed ----------------

router.get('/returns', (req, res) => {
  const rows = db.prepare(
    `SELECT g.*, b.BranchName FROM GSTReturnLog g
     LEFT JOIN Branch b ON b.BranchID = g.BranchID
     WHERE g.CompanyID = ? ${req.user.branchId ? 'AND g.BranchID = ?' : ''}
     ORDER BY g.Period DESC, g.ReturnID DESC`
  ).all(...(req.user.branchId ? [req.user.companyId, req.user.branchId] : [req.user.companyId]));
  res.json(rows);
});

// Records that a return was generated for a period. Recording it twice for the
// same branch+period updates the stored totals instead of creating a duplicate,
// so re-generating after a late invoice keeps the log accurate.
router.post('/returns', requireFilingRights, (req, res) => {
  const { returnType, period, branchId: bodyBranch } = req.body;
  if (!['GSTR1', 'GSTR3B'].includes(returnType)) return res.status(400).json({ error: 'returnType must be GSTR1 or GSTR3B' });
  if (!validPeriod(period)) return res.status(400).json({ error: 'period must be in YYYY-MM format' });

  const branchId = req.user.branchId || (bodyBranch ? Number(bodyBranch) : null);

  const sales = salesForPeriod(req.user.companyId, branchId, period);
  const purchases = purchasesForPeriod(req.user.companyId, branchId, period);

  let taxable = 0, cgst = 0, sgst = 0, igst = 0;
  sales.forEach(inv => {
    const s = splitGst(inv.GST, inv.BranchState, inv.CustomerState);
    taxable += inv.Total; cgst += s.cgst; sgst += s.sgst; igst += s.igst;
  });
  const outputTax = cgst + sgst + igst;
  // GSTR-1 reports gross output tax; GSTR-3B reports cash payable after the
  // statutory ITC set-off, so it reuses computeGstr3b rather than approximating.
  const netPayable = returnType === 'GSTR3B'
    ? computeGstr3b(req.user.companyId, branchId, period).netPayable
    : outputTax;

  const existing = db.prepare(
    `SELECT ReturnID, Status FROM GSTReturnLog
     WHERE CompanyID = ? AND ReturnType = ? AND Period = ? AND ${branchId ? 'BranchID = ?' : 'BranchID IS NULL'}`
  ).get(...(branchId ? [req.user.companyId, returnType, period, branchId] : [req.user.companyId, returnType, period]));

  if (existing) {
    if (existing.Status === 'Filed') {
      return res.status(409).json({ error: 'This return has already been marked as filed and cannot be regenerated' });
    }
    db.prepare(
      `UPDATE GSTReturnLog SET TaxableValue=?, CGST=?, SGST=?, IGST=?, NetPayable=?, CreatedBy=?, CreatedAt=datetime('now') WHERE ReturnID=?`
    ).run(round2(taxable), round2(cgst), round2(sgst), round2(igst), round2(netPayable), req.user.userId, existing.ReturnID);
    return res.json({ returnId: existing.ReturnID, updated: true });
  }

  const result = db.prepare(
    `INSERT INTO GSTReturnLog (CompanyID, BranchID, ReturnType, Period, TaxableValue, CGST, SGST, IGST, NetPayable, CreatedBy)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(req.user.companyId, branchId, returnType, period, round2(taxable), round2(cgst), round2(sgst), round2(igst), round2(netPayable), req.user.userId);

  logAudit({
    companyId: req.user.companyId, branchId, userId: req.user.userId,
    action: 'GENERATE_GST_RETURN', entityType: 'GSTReturnLog', entityId: result.lastInsertRowid,
    details: `${returnType} ${period}`, ip: req.ip
  });
  res.status(201).json({ returnId: result.lastInsertRowid });
});

router.post('/returns/:id/file', requireFilingRights, (req, res) => {
  const { arn } = req.body;
  if (!arn || String(arn).trim().length < 6) {
    return res.status(400).json({ error: 'A valid ARN (acknowledgement number) from the GST portal is required' });
  }
  const row = db.prepare('SELECT * FROM GSTReturnLog WHERE ReturnID = ? AND CompanyID = ?').get(req.params.id, req.user.companyId);
  if (!row) return res.status(404).json({ error: 'Return not found' });
  if (row.Status === 'Filed') return res.status(409).json({ error: 'This return is already marked as filed' });
  if (req.user.branchId && row.BranchID !== req.user.branchId) {
    return res.status(403).json({ error: 'You can only file returns for your own branch' });
  }

  db.prepare(`UPDATE GSTReturnLog SET Status='Filed', ARN=?, FiledAt=datetime('now') WHERE ReturnID=?`).run(String(arn).trim(), req.params.id);
  logAudit({
    companyId: req.user.companyId, branchId: row.BranchID, userId: req.user.userId,
    action: 'FILE_GST_RETURN', entityType: 'GSTReturnLog', entityId: Number(req.params.id),
    details: `${row.ReturnType} ${row.Period} ARN ${arn}`, ip: req.ip
  });
  res.json({ success: true });
});

// ---------------- Exports ----------------

function toCsv(rows, columns) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const head = columns.map(c => esc(c.label)).join(',');
  const body = rows.map(r => columns.map(c => esc(r[c.key])).join(',')).join('\n');
  return head + '\n' + body;
}

// CSV of the GSTR-1 B2B table - the format most accountants reconcile against.
router.get('/export/gstr1.csv', (req, res) => {
  const period = req.query.period;
  if (!validPeriod(period)) return res.status(400).json({ error: 'period must be in YYYY-MM format' });
  const branchId = resolveBranchScope(req);
  const invoices = salesForPeriod(req.user.companyId, branchId, period);

  const rows = invoices.map(inv => {
    const split = splitGst(inv.GST, inv.BranchState, inv.CustomerState);
    const rate = inv.Total > 0 ? round2((inv.GST / inv.Total) * 100) : 0;
    return {
      gstin: inv.CustomerGSTIN || 'URP',
      receiver: inv.CustomerName,
      invoiceNo: inv.InvoiceNo,
      invoiceDate: inv.InvoiceDate,
      invoiceValue: round2(inv.NetAmount),
      placeOfSupply: inv.CustomerState || inv.BranchState || '',
      rate,
      taxableValue: round2(inv.Total),
      cgst: round2(split.cgst), sgst: round2(split.sgst), igst: round2(split.igst),
      branch: `${inv.BranchName} (${inv.BranchCode})`
    };
  });

  const csv = toCsv(rows, [
    { key: 'gstin', label: 'GSTIN/UIN of Recipient' },
    { key: 'receiver', label: 'Receiver Name' },
    { key: 'invoiceNo', label: 'Invoice Number' },
    { key: 'invoiceDate', label: 'Invoice date' },
    { key: 'invoiceValue', label: 'Invoice Value' },
    { key: 'placeOfSupply', label: 'Place Of Supply' },
    { key: 'rate', label: 'Rate' },
    { key: 'taxableValue', label: 'Taxable Value' },
    { key: 'cgst', label: 'Central Tax' },
    { key: 'sgst', label: 'State/UT Tax' },
    { key: 'igst', label: 'Integrated Tax' },
    { key: 'branch', label: 'Branch' }
  ]);

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="GSTR1-${period}.csv"`);
  res.send(csv);
});

// JSON in the shape of the GST portal's offline-utility upload payload.
router.get('/export/gstr1.json', (req, res) => {
  const period = req.query.period;
  if (!validPeriod(period)) return res.status(400).json({ error: 'period must be in YYYY-MM format' });
  const branchId = resolveBranchScope(req);

  const company = db.prepare('SELECT GSTIN FROM Company WHERE CompanyID = ?').get(req.user.companyId);
  const branchGstin = branchId ? db.prepare('SELECT GSTIN FROM Branch WHERE BranchID = ?').get(branchId) : null;
  const invoices = salesForPeriod(req.user.companyId, branchId, period);

  // The portal groups B2B invoices under the recipient's GSTIN ("ctin").
  const byCtin = new Map();
  const b2cs = [];
  invoices.forEach(inv => {
    const split = splitGst(inv.GST, inv.BranchState, inv.CustomerState);
    const rate = inv.Total > 0 ? round2((inv.GST / inv.Total) * 100) : 0;
    const itms = [{
      num: 1,
      itm_det: {
        txval: round2(inv.Total), rt: rate,
        camt: round2(split.cgst), samt: round2(split.sgst), iamt: round2(split.igst)
      }
    }];
    if (inv.CustomerGSTIN) {
      const ctin = inv.CustomerGSTIN;
      if (!byCtin.has(ctin)) byCtin.set(ctin, { ctin, inv: [] });
      byCtin.get(ctin).inv.push({
        inum: inv.InvoiceNo, idt: inv.InvoiceDate, val: round2(inv.NetAmount),
        pos: inv.CustomerState || inv.BranchState || '', rchrg: 'N', inv_typ: 'R', itms
      });
    } else {
      b2cs.push({
        sply_ty: split.igst > 0 ? 'INTER' : 'INTRA',
        pos: inv.CustomerState || inv.BranchState || '',
        typ: 'OE', rt: rate, txval: round2(inv.Total),
        camt: round2(split.cgst), samt: round2(split.sgst), iamt: round2(split.igst)
      });
    }
  });

  const payload = {
    gstin: (branchGstin && branchGstin.GSTIN) || (company && company.GSTIN) || '',
    fp: period.replace('-', '').slice(4) + period.slice(0, 4), // MMYYYY, as the portal expects
    version: 'GST3.0.4',
    hash: 'hash',
    b2b: [...byCtin.values()],
    b2cs
  };

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="GSTR1-${period}.json"`);
  res.send(JSON.stringify(payload, null, 2));
});

module.exports = router;
