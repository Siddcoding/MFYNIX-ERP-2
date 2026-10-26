// Browser walkthrough of the five post-release features.
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const context = await browser.newContext({ viewport: { width: 1400, height: 950 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('[pageerror] ' + e.message));
  const BASE = 'http://localhost:3999';
  const step = s => console.log('  · ' + s);
  const toasts = async () => (await page.$$eval('.toast .toast-msg', ns => ns.map(n => n.textContent))).join(' / ');

  await page.goto(BASE + '/index.html?mode=admin');
  await page.fill('#username, input[name=username]', 'admin');
  await page.fill('#password, input[name=password]', 'Admin@123');
  await page.click('#loginBtn');
  await page.waitForURL('**/dashboard.html', { timeout: 15000 });
  step('logged in');

  // ---- 1. Change password modal (validation only; don't actually change admin's) ----
  await page.click('#changePwBtn');
  await page.waitForTimeout(600);
  if (!await page.$('#cpCurrent')) errors.push('change-password modal did not open');
  await page.fill('#cpCurrent', 'Admin@123');
  await page.fill('#cpNew', 'Mismatch@111');
  await page.fill('#cpConfirm', 'Different@222');
  await page.click('#cpSave');
  await page.waitForTimeout(700);
  const mismatch = await page.$eval('#cpError', n => n.textContent).catch(() => '');
  step('password mismatch caught: "' + mismatch + '"');
  if (!/do not match/i.test(mismatch)) errors.push('mismatch validation missing');
  await page.fill('#cpNew', 'short');
  await page.fill('#cpConfirm', 'short');
  await page.click('#cpSave');
  await page.waitForTimeout(700);
  const short = await page.$eval('#cpError', n => n.textContent).catch(() => '');
  step('short password caught: "' + short + '"');
  await page.click('#cpCancel');
  await page.waitForTimeout(400);

  // ---- 2. Stock adjustment ----
  await page.goto(BASE + '/inventory.html');
  await page.waitForTimeout(1600);
  if (!await page.$('#adjustForm')) errors.push('stock adjustment form missing');
  const items = await page.$$eval('#adjItem option', os => os.map(o => o.textContent));
  step('adjustment form loaded, ' + items.length + ' items selectable');
  await page.selectOption('#adjType', 'Increase');
  await page.waitForTimeout(300);
  step('hint for Increase: ' + await page.$eval('#adjHint', n => n.textContent));
  await page.selectOption('#adjType', 'Physical Count Correction');
  await page.waitForTimeout(300);
  step('qty label switches to: ' + await page.$eval('#adjQtyLabel', n => n.textContent));

  await page.selectOption('#adjType', 'Increase');
  await page.fill('#adjQty', '7');
  await page.fill('input[name=reason]', 'Browser test increase');
  await page.click('#adjustForm button[type=submit]');
  await page.waitForTimeout(1600);
  step('adjustment result toast: ' + await toasts());
  const ledgerRows = await page.$$eval('#ledgerTable table tbody tr', r => r.length).catch(() => 0);
  step('item stock ledger rows: ' + ledgerRows);
  if (ledgerRows === 0) errors.push('stock ledger rendered no rows');
  await page.screenshot({ path: 'shot-adjust.png' });

  // ---- 3. Vouchers ----
  await page.goto(BASE + '/accounts.html');
  await page.waitForTimeout(1600);
  if (!await page.$('#voucherForm')) errors.push('voucher form missing (is Vouchers the default tab?)');
  step('voucher explain: ' + await page.$eval('#vExplain', n => n.textContent));
  await page.click('#vTypeBar [data-vtype="Contra"]');
  await page.waitForTimeout(400);
  const contraVisible = await page.$eval('#vDirWrap', n => n.style.display);
  const modeHidden = await page.$eval('#vModeWrap', n => n.style.display);
  step(`Contra selected → direction ${contraVisible}, mode ${modeHidden}`);
  if (contraVisible !== 'block' || modeHidden !== 'none') errors.push('contra form did not switch fields');

  await page.click('#vTypeBar [data-vtype="Receipt"]');
  await page.waitForTimeout(400);
  const defaultAgainst = await page.$eval('#vAgainst', n => n.options[n.selectedIndex].textContent);
  step('Receipt default account: ' + defaultAgainst);
  if (!/Debtors/.test(defaultAgainst)) errors.push('receipt did not default to Debtors');

  const branchSel = await page.$('#vBranch');
  if (branchSel) await page.selectOption('#vBranch', await page.$eval('#vBranch option', o => o.value));
  await page.fill('#voucherForm input[name=amount]', '2500');
  await page.click('#voucherForm button[type=submit]');
  await page.waitForTimeout(1800);
  step('voucher toast: ' + await toasts());
  const vRows = await page.$$eval('#tabContent table tbody tr', r => r.length);
  step('voucher register rows: ' + vRows);
  await page.screenshot({ path: 'shot-vouchers.png' });

  await page.click('#tabBar button[data-tab="Trial Balance"]');
  await page.waitForTimeout(1400);
  const tbText = await page.$eval('#tabContent', n => n.textContent);
  step('trial balance still balanced: ' + /balanced|Balanced/.test(tbText));

  // ---- 4 & 5. Print + cancel ----
  await page.goto(BASE + '/sales.html');
  await page.waitForTimeout(1600);
  const printBtns = await page.$$('[data-print]');
  const cancelBtns = await page.$$('[data-cancel]');
  step(`sales list: ${printBtns.length} print buttons, ${cancelBtns.length} cancel buttons`);
  if (printBtns.length === 0) errors.push('no print buttons on sales list');

  const statuses = await page.$$eval('#invoiceList .badge', ns => ns.map(n => n.textContent.trim()));
  step('statuses shown: ' + [...new Set(statuses)].join(', '));

  // Open the printable invoice in a new tab
  const firstId = await page.$eval('[data-print]', b => b.dataset.print);
  const printPage = await context.newPage();   // same context, so the login token is shared
  await printPage.goto(`${BASE}/print.html?type=sales&id=${firstId}`);
  await printPage.waitForTimeout(1500);
  const docText = await printPage.$eval('#doc', n => n.textContent);
  for (const must of ['Tax Invoice', 'GSTIN', 'Amount in words', 'Authorised signatory']) {
    if (!docText.includes(must)) errors.push(`printed invoice missing "${must}"`);
  }
  step('printed invoice contains: Tax Invoice / GSTIN / amount in words / signatory');
  const words = await printPage.$eval('.words', n => n.textContent);
  step(words.trim());
  await printPage.screenshot({ path: 'shot-print.png', fullPage: true });

  // A cancelled invoice must carry the stamp
  const cancelledId = await page.evaluate(async () => {
    const res = await fetch('/api/sales', { headers: { Authorization: 'Bearer ' + localStorage.getItem('mf_token') } });
    const data = await res.json();
    const rows = Array.isArray(data) ? data : data.rows;   // list endpoints are paged now
    const c = rows.find(r => r.Status === 'Cancelled');
    return c ? c.InvoiceID : null;
  });
  if (cancelledId) {
    await printPage.goto(`${BASE}/print.html?type=sales&id=${cancelledId}`);
    await printPage.waitForTimeout(1200);
    const stamp = await printPage.$('.cancel-stamp');
    step('cancelled invoice shows the CANCELLED stamp: ' + !!stamp);
    if (!stamp) errors.push('cancelled invoice has no stamp');
    await printPage.screenshot({ path: 'shot-print-cancelled.png' });
  } else { step('no cancelled invoice to check the stamp on'); }
  await printPage.close();

  // Cancel flow through the modal
  if (cancelBtns.length) {
    await cancelBtns[0].click();
    await page.waitForTimeout(700);
    await page.click('#cancelConfirm');           // no reason -> should be refused
    await page.waitForTimeout(1200);
    const err = await page.$eval('#cancelError', n => n.textContent).catch(() => '');
    step('cancel without a reason refused: "' + err + '"');
    if (!/reason/i.test(err)) errors.push('cancel allowed without a reason');
    await page.click('#cancelDismiss');
  }
  await page.screenshot({ path: 'shot-sales-cancel.png' });

  // ---- Users screen: reset-password button ----
  await page.goto(BASE + '/branches.html');
  await page.waitForTimeout(1600);
  const resetBtns = await page.$$('.user-reset-btn');
  step('admin reset-password buttons: ' + resetBtns.length);
  if (resetBtns.length === 0) errors.push('no admin reset-password buttons');

  // ---- mobile ----
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(BASE + '/accounts.html');
  await page.waitForTimeout(1600);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
  if (overflow) errors.push('accounts page scrolls sideways on mobile');
  step('mobile layout ok: ' + !overflow);

  await browser.close();
  console.log('\n' + (errors.length ? 'ERRORS:\n' + errors.join('\n') : 'No page errors.'));
  process.exit(errors.length ? 1 : 0);
})();
