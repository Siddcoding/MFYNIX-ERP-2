// Browser walkthrough of the expanded item master, the statutory document
// header block, the branded letterhead and the theme picker.
//
// The point of this suite is that the fields are reachable and usable by hand,
// not merely accepted by the API — a field that exists only in the database is
// a field nobody can fill in.
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const context = await browser.newContext({ viewport: { width: 1400, height: 950 }, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('[pageerror] ' + e.message));
  const BASE = 'http://localhost:3999';
  const step = s => console.log('  · ' + s);
  const stamp = String(Date.now()).slice(-6);
  let printableId = null;

  await page.goto(BASE + '/index.html?mode=admin');
  await page.fill('#username', 'admin');
  await page.fill('#password', 'Admin@123');
  await page.click('#loginBtn');
  await page.waitForURL('**/dashboard.html', { timeout: 15000 });
  await page.waitForTimeout(2500);
  step('signed in');

  // ---------------- Branding in the app chrome ----------------
  const brandOk = await page.$eval('.sidebar .brand-logo',
    img => img.complete && img.naturalWidth > 0).catch(() => false);
  step('sidebar brand mark rendered: ' + brandOk);
  if (!brandOk) errors.push('the brand mark did not render in the sidebar');

  const brandCredit = await page.$eval('.sidebar .brand small', n => n.textContent.trim()).catch(() => '');
  step('sidebar reads: "' + brandCredit + '"');

  // ---------------- Item master: the full specification ----------------
  await page.goto(BASE + '/masters.html');
  await page.waitForTimeout(1800);
  await page.click('[data-tab="items"]');
  await page.waitForTimeout(1200);

  const groups = await page.$$eval('.field-group legend', ns => ns.map(n => n.textContent.trim()));
  step('item form groups: ' + groups.join(' | '));
  for (const want of ['Identity', 'Measurement', 'Sourcing', 'Storage & Traceability', 'Costing & Pricing', 'Production']) {
    if (!groups.includes(want)) errors.push('item form missing the group: ' + want);
  }

  const itemFieldCount = await page.$$eval('#masterForm input, #masterForm select', ns => ns.length);
  step('fields on the item form: ' + itemFieldCount);
  if (itemFieldCount < 25) errors.push('the item form has only ' + itemFieldCount + ' fields, expected the full specification');

  // Batch tracking is a Yes/No select, not a bare checkbox — a blank checkbox
  // and a deliberate "No" would look identical on a master.
  const batchOptions = await page.$$eval('[name="BatchTracking"] option', ns => ns.map(n => n.textContent));
  step('batch tracking control offers: ' + batchOptions.join('/'));
  if (!batchOptions.includes('Yes')) errors.push('batch tracking is not a yes/no control');

  const costing = await page.$$eval('[name="CostingMethod"] option', ns => ns.map(n => n.textContent.trim()).filter(Boolean));
  step('costing methods: ' + costing.join(', '));
  if (!costing.includes('FIFO')) errors.push('costing method list is missing FIFO');

  // Fill the whole thing in and save it through the real form.
  const itemName = `UI Spec Item ${stamp}`;
  await page.fill('[name="ItemCode"]', 'UIC' + stamp);
  await page.fill('[name="ItemName"]', itemName);
  await page.selectOption('[name="Category"]', 'Raw Material');
  await page.fill('[name="HSN"]', '7207');
  await page.fill('[name="GSTRate"]', '18');
  await page.fill('[name="Unit"]', 'Kg');
  await page.fill('[name="AltUnit"]', 'Box');
  await page.fill('[name="AltUnitFactor"]', '12');
  await page.fill('[name="Dimensions"]', 'L=12m, W=12mm, 10 Kg');
  await page.fill('[name="LeadTimeDays"]', '7');
  await page.fill('[name="ReorderLevel"]', '100');
  await page.fill('[name="Warehouse"]', 'WH-A');
  await page.fill('[name="BinRack"]', 'Rack B-12');
  await page.selectOption('[name="BatchTracking"]', '1');
  await page.fill('[name="ShelfLifeMonths"]', '12');
  await page.selectOption('[name="CostingMethod"]', 'FIFO');
  await page.fill('[name="PurchaseRate"]', '500');
  await page.fill('[name="StandardCost"]', '450');
  await page.fill('[name="SaleRate"]', '600');
  await page.fill('[name="BOMLink"]', 'BOM001');
  await page.fill('[name="YieldPercent"]', '95');
  await page.fill('[name="WastagePercent"]', '5');
  await page.fill('[name="CustomAttributes"]', 'Grade A, Silver');
  await page.click('#masterForm button[type="submit"]');
  await page.waitForTimeout(2200);

  const itemListText = await page.$eval('#listArea', n => n.textContent);
  step('item saved and listed: ' + itemListText.includes(itemName));
  if (!itemListText.includes(itemName)) errors.push('the item saved from the full form is not in the list');
  if (!itemListText.includes('UIC' + stamp)) errors.push('the item code is not shown in the list');

  // ---------------- Document header fields ----------------
  await page.goto(BASE + '/sales.html');
  await page.waitForTimeout(2000);

  const hasExtras = await page.$('#docExtrasBlock') !== null;
  step('statutory details block present on the sales form: ' + hasExtras);
  if (!hasExtras) errors.push('the statutory details block is missing from the sales form');

  // Collapsed by default: the everyday invoice needs a customer, a date and a
  // line, and burying those behind twelve optional boxes would be slower.
  const startsClosed = await page.$eval('#docExtrasBlock', d => !d.open);
  step('collapsed by default: ' + startsClosed);
  if (!startsClosed) errors.push('the optional details block is open by default');

  await page.click('#docExtrasBlock summary');
  await page.waitForTimeout(400);
  const extraNames = await page.$$eval('#docExtrasBlock input, #docExtrasBlock select', ns => ns.map(n => n.name));
  step('fields offered: ' + extraNames.join(', '));
  for (const want of ['refNo', 'orderNo', 'irn', 'eWayBillNo', 'transporterName', 'consignmentNo', 'payLedger', 'reverseCharge']) {
    if (!extraNames.includes(want)) errors.push('document form missing the field: ' + want);
  }

  // The counter tells you something is in there even when it is collapsed.
  await page.fill('#docExtrasBlock [name="refNo"]', 'UI-REF-' + stamp);
  await page.fill('#docExtrasBlock [name="transporterName"]', 'UI Transporter');
  await page.waitForTimeout(300);
  const counter = await page.$eval('#docExtrasCount', n => n.textContent.trim());
  step('filled-field counter reads: "' + counter + '"');
  if (!/2 filled/.test(counter)) errors.push('the filled-field counter did not update: ' + counter);

  // Raise a real invoice carrying those fields.
  const hasBranchSel = await page.$eval('#branchSelectWrap', n => n.style.display !== 'none').catch(() => false);
  if (hasBranchSel) {
    const firstBranch = await page.$eval('#branchSelect option', o => o.value);
    await page.selectOption('#branchSelect', firstBranch);
  }
  const firstCustomer = await page.$eval('#customerSelect option', o => o.value).catch(() => '');
  if (!firstCustomer) {
    errors.push('no customers available to invoice');
  } else {
    await page.selectOption('#customerSelect', firstCustomer);
    await page.waitForTimeout(400);
    const itemSel = await page.$('.line-row select');
    if (itemSel) {
      const firstItem = await page.$eval('.line-row select option', o => o.value);
      await page.selectOption('.line-row select', firstItem);
      await page.fill('.line-row input[name="qty"], .line-row .line-qty', '1').catch(() => {});
    }
    // Give the branch some stock first. The negative-stock guard is working as
    // designed, and fighting it here would be testing the wrong thing — this
    // suite is about the fields, not about the guard.
    const opened = await page.evaluate(async () => {
      const h = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('mf_token') };
      const items = await (await fetch('/api/masters/items', { headers: h })).json();
      const branches = await (await fetch('/api/branches', { headers: h })).json();
      const item = items[0], branch = branches[0];
      await fetch('/api/inventory/adjust', {
        method: 'POST', headers: h,
        body: JSON.stringify({ branchId: branch.BranchID, itemId: item.ItemID,
          adjustmentType: 'Opening Stock', qty: 50, reason: 'UI field test stock' })
      });
      return { item: item.ItemID, branch: branch.BranchID };
    });
    step('opening stock recorded for the test: ' + JSON.stringify(opened));

    await page.reload();
    await page.waitForTimeout(2200);
    await page.click('#docExtrasBlock summary');
    await page.fill('#docExtrasBlock [name="refNo"]', 'UI-REF-' + stamp);
    await page.fill('#docExtrasBlock [name="transporterName"]', 'UI Transporter');
    await page.fill('#docExtrasBlock [name="eWayBillNo"]', 'EWB-' + stamp);
    await page.selectOption('#docExtrasBlock [name="payLedger"]', 'Cash');
    if (hasBranchSel) await page.selectOption('#branchSelect', String(opened.branch));
    await page.selectOption('#customerSelect', firstCustomer);
    await page.waitForTimeout(400);
    await page.selectOption('.line-row select', String(opened.item));
    await page.waitForTimeout(200);

    step('invoice form filled; submitting');
    await page.click('#salesForm button[type="submit"]');
    await page.waitForTimeout(2800);
    const toasts = (await page.$$eval('.toast .toast-msg', ns => ns.map(n => n.textContent))).join(' / ');
    step('save result: ' + toasts.trim().slice(0, 110));
    if (!/saved/i.test(toasts)) errors.push('the invoice with statutory fields did not save: ' + toasts.trim());

    // And the fields must have landed on the document, not just been posted.
    const stored = await page.evaluate(async () => {
      const h = { Authorization: 'Bearer ' + localStorage.getItem('mf_token') };
      const list = await (await fetch('/api/sales?pageSize=1', { headers: h })).json();
      const id = (list.rows || list)[0].InvoiceID;
      const doc = await (await fetch('/api/sales/' + id, { headers: h })).json();
      return { id, RefNo: doc.header.RefNo, Transporter: doc.header.TransporterName,
               EWay: doc.header.EWayBillNo, Pay: doc.header.PayLedger };
    });
    step('stored on the invoice: ' + JSON.stringify(stored));
    if (stored.RefNo !== 'UI-REF-' + stamp) errors.push('the reference typed into the form did not reach the invoice');
    if (stored.Transporter !== 'UI Transporter') errors.push('the transporter did not reach the invoice');
    printableId = stored.id;
  }

  // ---------------- The printed document ----------------
  if (!printableId) {
    step('no invoice to print (skipping the letterhead check)');
  } else {
    await page.goto(`${BASE}/print.html?type=sales&id=${printableId}`);
    await page.waitForTimeout(2500);

    const logoOk = await page.$eval('.print-logo', img => img.complete && img.naturalWidth > 0).catch(() => false);
    step('letterhead logo rendered: ' + logoOk);
    if (!logoOk) errors.push('the printed document has no letterhead logo');

    const headers = await page.$$eval('.doc thead th', ns => ns.map(n => n.textContent.trim()));
    step('invoice columns: ' + headers.join(' | '));
    for (const want of ['Taxable', 'Disc']) {
      if (!headers.some(h => h.includes(want))) errors.push('the printed invoice has no ' + want + ' column');
    }
    const hasTaxCols = headers.some(h => /CGST|IGST/.test(h));
    if (!hasTaxCols) errors.push('the printed invoice does not break the tax into heads');

    const docText = await page.$eval('.doc', n => n.textContent);
    step('reference strip on the document: ' + /Reference|Transporter|E-Way/.test(docText));
  }

  // ---------------- Themes ----------------
  await page.goto(BASE + '/admin.html');
  await page.waitForTimeout(2200);
  await page.click('#tabBar button[data-tab="Appearance"]');
  await page.waitForTimeout(1200);

  const themeNames = await page.$$eval('.theme-card .theme-name', ns => ns.map(n => n.textContent.trim()));
  step(`${themeNames.length} themes: ` + themeNames.join(', '));
  if (themeNames.length < 10) errors.push('expected at least ten themes, found ' + themeNames.length);
  for (const want of ['Mfynix Blue', 'Forest', 'Rosewood', 'Slate', 'Sandstone', 'High Contrast']) {
    if (!themeNames.includes(want)) errors.push('missing theme: ' + want);
  }

  // Each one must actually apply, not merely be listed.
  for (const id of ['forest', 'sandstone', 'contrast']) {
    await page.click(`.theme-card[data-theme-id="${id}"]`);
    await page.waitForTimeout(500);
    const applied = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    if (applied !== id) errors.push(`picking ${id} left the page on ${applied}`);
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    step(`${id} applied, body background ${bg}`);
  }
  await page.click('.theme-card[data-theme-id="mfynix"]');
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'shot-themes.png' });

  console.log(errors.length ? '\nERRORS:\n' + errors.join('\n') : '\nNo page errors.');
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})();
