/* =========================================================================
   BULK IMPORT FROM EXCEL / CSV
   -------------------------------------------------------------------------
   Most of this data already exists in somebody's spreadsheet. Retyping a
   thousand customers into a web form is how migrations get abandoned, so the
   masters and the user list accept the sheet directly.

   Three design decisions worth knowing:

   1. HEADERS ARE MATCHED LOOSELY. Real sheets say "Customer Name", "NAME",
      "customer_name" and "Party". Requiring an exact header would mean the
      first upload always fails, so headers are normalised (lowercased, all
      non-alphanumerics stripped) and matched against a list of aliases.

   2. A DUPLICATE IS SKIPPED, NEVER OVERWRITTEN. An import should not be able
      to quietly destroy data that somebody has already corrected by hand. Every
      skip is reported with the reason, so re-uploading a corrected sheet is
      safe and tells you exactly what it did.

   3. THE WHOLE IMPORT IS ONE TRANSACTION. Either every valid row lands or none
      does. A half-applied import that fails on row 400 is far worse than one
      that fails cleanly - you can retry a clean failure.
   ========================================================================= */
const XLSX = require('xlsx');

// ---------------- Reading the file ----------------

// Normalise a header cell so "Customer Name", "customer_name" and "CUSTOMERNAME"
// all collapse to the same key.
function normaliseHeader(h) {
  return String(h == null ? '' : h).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Parse an uploaded file into { headers, rows } where each row is a plain
 * object keyed by the normalised header.
 *
 * CSV is handled by SheetJS too, so quoted commas, embedded newlines and BOMs
 * behave the same way they do in Excel - which is the behaviour people expect,
 * since Excel is where the file came from.
 */
function parseSheet(buffer, filename = '') {
  const isCsv = /\.csv$/i.test(filename) || /\.txt$/i.test(filename);
  let workbook;
  try {
    workbook = isCsv
      ? XLSX.read(buffer.toString('utf8').replace(/^﻿/, ''), { type: 'string', raw: false })
      : XLSX.read(buffer, { type: 'buffer', cellDates: true });
  } catch (e) {
    throw new Error('That file could not be read as a spreadsheet. Save it as .xlsx or .csv and try again.');
  }

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('The file has no sheets in it.');

  // header:1 gives raw arrays, so the header row can be normalised before the
  // objects are built - SheetJS's own object mode would key on the raw text.
  const grid = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
    header: 1, blankrows: false, defval: ''
  });
  if (grid.length === 0) throw new Error('The sheet is empty.');

  const rawHeaders = grid[0].map(h => String(h == null ? '' : h).trim());
  const headers = rawHeaders.map(normaliseHeader);
  if (headers.every(h => h === '')) throw new Error('The first row must be the column headings.');

  const rows = [];
  for (let i = 1; i < grid.length; i++) {
    const cells = grid[i];
    const obj = {};
    let hasAnything = false;
    headers.forEach((key, idx) => {
      if (!key) return;
      let v = cells[idx];
      if (v instanceof Date) v = v.toISOString().slice(0, 10);
      v = String(v == null ? '' : v).trim();
      if (v !== '') hasAnything = true;
      obj[key] = v;
    });
    if (hasAnything) rows.push({ rowNumber: i + 1, values: obj });   // +1 = the row number Excel shows
  }

  return { headers, rawHeaders, rows, sheetName };
}

// Pull a value out of a parsed row by trying each alias in turn.
function pick(values, aliases) {
  for (const alias of aliases) {
    const key = normaliseHeader(alias);
    if (values[key] !== undefined && values[key] !== '') return values[key];
  }
  return '';
}

// Numbers arrive as "1,20,000", "₹1200", "12.5%" or just blank.
function num(raw) {
  if (raw === '' || raw == null) return null;
  const cleaned = String(raw).replace(/[₹$,%\s,]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

// Yes/No columns. Spreadsheets express these every possible way, and a cell
// nobody filled in is a "no", not an error.
const TRUTHY = ['yes', 'y', 'true', '1', 'required', 'enabled', 'on'];
const FALSY = ['no', 'n', 'false', '0', 'not required', 'disabled', 'off', 'na', 'n/a', '-', '—'];
function bool(raw) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  if (v === '') return null;
  if (TRUTHY.includes(v)) return 1;
  if (FALSY.includes(v)) return 0;
  return NaN;
}

// Shelf life is written as "12 months", "2 years", "18", or "—".
function months(raw) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  if (v === '' || v === '-' || v === '—' || v === 'na' || v === 'n/a') return null;
  const n = parseFloat(v.replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n)) return NaN;
  if (/year|yr/.test(v)) return Math.round(n * 12);
  if (/day/.test(v)) return Math.round(n / 30);
  return Math.round(n);
}

// ---------------- What each entity expects ----------------
// `required` is checked before anything else; `dedupe` says what makes a row a
// duplicate of something already stored. Aliases are ordered best-first.
const ENTITIES = {
  customers: {
    label: 'Customer',
    table: 'Customer',
    idColumn: 'CustomerID',
    branchScoped: true,
    fields: [
      { column: 'CustomerName', aliases: ['CustomerName', 'Customer', 'Name', 'Party', 'PartyName', 'Customer Name'], required: true },
      { column: 'GSTIN', aliases: ['GSTIN', 'GST', 'GSTNo', 'GST Number', 'GSTIN/UIN'] },
      { column: 'Mobile', aliases: ['Mobile', 'Phone', 'Contact', 'ContactNo', 'Mobile No'] },
      { column: 'Email', aliases: ['Email', 'EmailAddress', 'Mail', 'E-mail'] },
      { column: 'Address', aliases: ['Address', 'BillingAddress', 'Address1'] },
      { column: 'State', aliases: ['State', 'StateName', 'Place of Supply'] },
      { column: 'CreditLimit', aliases: ['CreditLimit', 'Limit', 'Credit Limit'], type: 'number' },
      { column: 'CreditDays', aliases: ['CreditDays', 'Days', 'Credit Days', 'Payment Terms'], type: 'number' },
      { column: 'OpeningBalance', aliases: ['OpeningBalance', 'Opening', 'Opening Balance'], type: 'number' },
      { column: 'PAN', aliases: ['PAN', 'PANNo', 'PAN Number', 'PAN_NO'] },
      { column: 'PartyType', aliases: ['PartyType', 'CustType', 'CUST_TYPE', 'Customer Type', 'Registration Type'] }
    ],
    dedupe: [
      { column: 'CustomerName', label: 'a customer with this name' },
      { column: 'GSTIN', label: 'a customer with this GSTIN' }
    ]
  },

  suppliers: {
    label: 'Supplier',
    table: 'Supplier',
    idColumn: 'SupplierID',
    branchScoped: true,
    fields: [
      { column: 'SupplierName', aliases: ['SupplierName', 'Supplier', 'Name', 'Vendor', 'VendorName', 'Party'], required: true },
      { column: 'GSTIN', aliases: ['GSTIN', 'GST', 'GSTNo', 'GST Number'] },
      { column: 'Mobile', aliases: ['Mobile', 'Phone', 'Contact', 'ContactNo'] },
      { column: 'Email', aliases: ['Email', 'EmailAddress', 'Mail'] },
      { column: 'Address', aliases: ['Address', 'Address1'] },
      { column: 'State', aliases: ['State', 'StateName'] },
      { column: 'CreditDays', aliases: ['CreditDays', 'Days', 'Credit Days'], type: 'number' },
      { column: 'OpeningBalance', aliases: ['OpeningBalance', 'Opening', 'Opening Balance'], type: 'number' },
      { column: 'PAN', aliases: ['PAN', 'PANNo', 'PAN Number', 'PAN_NO'] },
      { column: 'PartyType', aliases: ['PartyType', 'VendorType', 'Supplier Type', 'Registration Type'] }
    ],
    dedupe: [
      { column: 'SupplierName', label: 'a supplier with this name' },
      { column: 'GSTIN', label: 'a supplier with this GSTIN' }
    ]
  },

  items: {
    label: 'Item',
    table: 'Item',
    idColumn: 'ItemID',
    branchScoped: false,          // items are company-wide, stock is per branch
    fields: [
      { column: 'ItemCode', aliases: ['ItemCode', 'Code', 'Item Code', 'SKU Code', 'Material Code'] },
      { column: 'ItemName', aliases: ['ItemName', 'Item', 'Name', 'Product', 'ProductName', 'Description', 'Item Name'], required: true },
      { column: 'Category', aliases: ['Category', 'Group', 'ItemGroup', 'Item Category', 'Type'] },
      { column: 'HSN', aliases: ['HSN', 'HSNCode', 'HSN/SAC', 'HSN/SAC Code', 'SAC'] },
      { column: 'GSTRate', aliases: ['GSTRate', 'GST', 'GST%', 'TaxRate', 'GST Rate', 'Tax %', 'Tax'], type: 'number' },
      { column: 'Unit', aliases: ['Unit', 'UOM', 'Units', 'Measure', 'Base UOM'] },
      { column: 'AltUnit', aliases: ['AltUOM', 'Alt UOM', 'AlternateUnit', 'Alt Unit', 'Secondary UOM'] },
      { column: 'AltUnitFactor', aliases: ['AltUOMFactor', 'Conversion', 'UOM Factor', 'Alt Factor'], type: 'number' },
      { column: 'Dimensions', aliases: ['Dimensions', 'Dimensions/Weight', 'Size', 'Weight'] },
      { column: 'MaterialType', aliases: ['MaterialType', 'Material Type', 'Material'] },
      { column: 'LeadTimeDays', aliases: ['LeadTime', 'Lead Time (Days)', 'LeadTimeDays', 'Lead Days'], type: 'number' },
      { column: 'ReorderLevel', aliases: ['ReorderLevel', 'Reorder', 'MinStock', 'Minimum Stock', 'Reorder Level'], type: 'number' },
      { column: 'PurchaseRate', aliases: ['PurchaseRate', 'Purchase', 'PurchasePrice', 'Purchase Price', 'CostPrice', 'Cost', 'Buy Rate'], type: 'number' },
      { column: 'Warehouse', aliases: ['Warehouse', 'Store', 'Location'] },
      { column: 'BinRack', aliases: ['Bin', 'Rack', 'Bin/Rack', 'BinRack', 'Shelf'] },
      { column: 'BatchTracking', aliases: ['BatchTracking', 'Batch Tracking', 'Batch'], type: 'boolean' },
      { column: 'SerialTracking', aliases: ['SerialTracking', 'Serial Tracking', 'Serial'], type: 'boolean' },
      { column: 'ShelfLifeMonths', aliases: ['ShelfLife', 'Expiry/Shelf Life', 'Shelf Life', 'Expiry'], type: 'months' },
      { column: 'CostingMethod', aliases: ['CostingMethod', 'Costing Method', 'Valuation'] },
      { column: 'StandardCost', aliases: ['StandardCost', 'Standard Cost', 'Std Cost'], type: 'number' },
      { column: 'SaleRate', aliases: ['SaleRate', 'Sale', 'SellingPrice', 'Selling Price/MRP', 'Selling Price', 'MRP', 'Rate', 'Sell Rate'], type: 'number' },
      { column: 'Barcode', aliases: ['Barcode', 'EAN', 'SKU'] },
      { column: 'GLMapping', aliases: ['GLMapping', 'GL Mapping', 'GL Account', 'Ledger'] },
      { column: 'BOMLink', aliases: ['BOM', 'BOMLink', 'BOM Link', 'BOM Code'] },
      { column: 'YieldPercent', aliases: ['Yield', 'Yield %', 'YieldPercent'], type: 'number' },
      { column: 'WastagePercent', aliases: ['Wastage', 'Wastage %', 'WastagePercent', 'Scrap %'], type: 'number' },
      { column: 'CustomAttributes', aliases: ['CustomAttributes', 'Custom Attributes', 'Attributes', 'Specs'] },
      { column: 'Remarks', aliases: ['Remarks', 'Notes', 'Comment'] }
    ],
    dedupe: [
      { column: 'ItemCode', label: 'an item with this code' },
      { column: 'ItemName', label: 'an item with this name' },
      { column: 'Barcode', label: 'an item with this barcode' }
    ]
  }
};

/**
 * Import rows into one of the master tables.
 *
 * Returns { total, inserted, skipped, results } where `results` has one entry
 * per data row, so the screen can show exactly what happened line by line.
 */
function importMaster(db, entityKey, { buffer, filename, companyId, branchId, dryRun = false, updateMode = false }) {
  const spec = ENTITIES[entityKey];
  if (!spec) throw new Error('Unknown import type');

  const { rows, rawHeaders } = parseSheet(buffer, filename);
  if (rows.length === 0) throw new Error('The sheet has headings but no data rows.');

  // Everything already stored, read once - checking row by row against the
  // database would be a query per row per rule.
  const existing = db.prepare(
    `SELECT * FROM ${spec.table} WHERE CompanyID = ? AND IsActive = 1`
  ).all(companyId);

  const seen = {};   // dedupe column -> Set of lowercased values already taken
  const existingByKey = {};  // for update mode: dedupe value -> existing row
  const idCol = spec.idColumn || (spec.table + 'ID');
  spec.dedupe.forEach(rule => {
    seen[rule.column] = new Set(
      existing.map(r => String(r[rule.column] || '').trim().toLowerCase()).filter(Boolean)
    );
    existingByKey[rule.column] = {};
    existing.forEach(r => { const v = String(r[rule.column] || '').trim().toLowerCase(); if (v) existingByKey[rule.column][v] = r; });
  });

  const results = [];
  const toInsert = [];
  const toUpdate = [];

  for (const { rowNumber, values } of rows) {
    const record = {};
    let problem = null;

    for (const field of spec.fields) {
      const raw = pick(values, field.aliases);
      if (field.required && !raw) {
        problem = `${field.column} is blank`;
        break;
      }
      if (!raw) continue;
      if (field.type === 'number') {
        const n = num(raw);
        if (Number.isNaN(n)) { problem = `${field.column} is not a number ("${raw}")`; break; }
        if (n !== null) record[field.column] = n;
      } else if (field.type === 'boolean') {
        const b = bool(raw);
        if (Number.isNaN(b)) { problem = `${field.column} should be Yes or No, not "${raw}"`; break; }
        if (b !== null) record[field.column] = b;
      } else if (field.type === 'months') {
        const m = months(raw);
        if (Number.isNaN(m)) { problem = `${field.column} is not a period ("${raw}") - try "12 months" or "2 years"`; break; }
        if (m !== null) record[field.column] = m;
      } else {
        record[field.column] = raw;
      }
    }

    const name = record[spec.fields[0].column] || `Row ${rowNumber}`;

    if (problem) {
      results.push({ row: rowNumber, name, status: 'error', reason: problem });
      continue;
    }

    // Duplicate against the database, or against an earlier row in this very
    // sheet - people paste the same customer twice more often than you'd think.
    let duplicate = null;
    for (const rule of spec.dedupe) {
      const v = String(record[rule.column] || '').trim().toLowerCase();
      if (v && seen[rule.column].has(v)) { duplicate = rule.label; break; }
    }
    if (duplicate) {
      if (updateMode) {
        // MD-11 update mode: refresh the existing record instead of skipping it.
        let target = null;
        for (const rule of spec.dedupe) {
          const v = String(record[rule.column] || '').trim().toLowerCase();
          if (v && existingByKey[rule.column][v]) { target = existingByKey[rule.column][v]; break; }
        }
        toUpdate.push({ rowNumber, name, record, id: target[idCol] });
        results.push({ row: rowNumber, name, status: 'updated', reason: '' });
        continue;
      }
      results.push({ row: rowNumber, name, status: 'skipped', reason: `${duplicate} already exists` });
      continue;
    }

    spec.dedupe.forEach(rule => {
      const v = String(record[rule.column] || '').trim().toLowerCase();
      if (v) seen[rule.column].add(v);
    });

    toInsert.push({ rowNumber, name, record });
    results.push({ row: rowNumber, name, status: 'imported', reason: '' });
  }

  // A validation preview (dry run) reports exactly what a real import would do,
  // but writes nothing - MD-11's "preview before commit".
  if (!dryRun) {
    const applyAll = db.transaction(() => {
      for (const { record } of toInsert) {
        const cols = Object.keys(record);
        const columns = spec.branchScoped ? ['CompanyID', 'BranchID', ...cols] : ['CompanyID', ...cols];
        const vals = spec.branchScoped
          ? [companyId, branchId || null, ...cols.map(c => record[c])]
          : [companyId, ...cols.map(c => record[c])];
        db.prepare(
          `INSERT INTO ${spec.table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`
        ).run(...vals);
      }
      for (const { record, id } of toUpdate) {
        const cols = Object.keys(record);
        if (!cols.length) continue;
        db.prepare(`UPDATE ${spec.table} SET ${cols.map(c => c + ' = ?').join(', ')} WHERE ${idCol} = ? AND CompanyID = ?`)
          .run(...cols.map(c => record[c]), id, companyId);
      }
    });
    applyAll();
  }

  // An "error file" the user can download: the rejected rows and why.
  const errorRows = results.filter(r => r.status === 'error');

  return {
    entity: entityKey,
    label: spec.label,
    dryRun,
    updateMode,
    headersFound: rawHeaders.filter(Boolean),
    total: rows.length,
    inserted: toInsert.length,
    updated: toUpdate.length,
    skipped: results.filter(r => r.status === 'skipped').length,
    failed: errorRows.length,
    errorRows,
    results
  };
}

// A blank template with the headings this importer understands, so nobody has
// to guess. The first alias of each field is the canonical heading.
function templateCsv(entityKey) {
  const spec = ENTITIES[entityKey];
  if (!spec) throw new Error('Unknown import type');
  const headers = spec.fields.map(f => f.aliases[0]);
  const example = spec.fields.map(f => f.example || '');
  return headers.join(',') + '\n' + example.join(',') + '\n';
}

module.exports = { parseSheet, pick, num, normaliseHeader, importMaster, templateCsv, ENTITIES };
