// Browser walkthrough of the final batch: credit/debit notes, banking with a
// real CSV upload, the reports pack, multi-company, backup and year-end close.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const context = await browser.newContext({ viewport: { width: 1400, height: 950 }, acceptDownloads: true });
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

  const nav = await page.$$eval('.sidebar nav a', as => as.map(a => a.textContent.trim()));
  for (const want of ['Credit / Debit Notes', 'Banking', 'Reports']) {
    if (!nav.includes(want)) errors.push('nav missing ' + want);
  }
  step('nav: ' + nav.join(' | '));

  // ---- Credit note ----
  await page.goto(BASE + '/notes.html');
  await page.waitForTimeout(2200);
  if (!await page.$('#noteForm')) errors.push('note form missing');
  const invoiceOpts = await page.$$eval('#againstDoc option', o => o.length);
  step('invoices offered to credit against: ' + (invoiceOpts - 1));
  if (invoiceOpts <= 1) errors.push('no invoices offered on the note form');

  // Picking an invoice must prefill the party and lines.
  const secondOpt = await page.$eval('#againstDoc option:nth-child(2)', o => o.value);
  await page.selectOption('#againstDoc', secondOpt);
  await page.waitForTimeout(1600);
  const prefilled = await page.$$eval('.line-row', r => r.length);
  const hint = await page.$eval('#remainingHint', n => n.textContent);
  step(`invoice picked → ${prefilled} line(s) prefilled; ${hint.trim()}`);
  if (prefilled === 0) errors.push('picking an invoice prefilled no lines');
  if (!/uncredited/.test(hint)) errors.push('remaining-to-credit hint missing');

  await page.fill('.line-row .li-qty', '1');
  await page.fill('input[name=reason]', 'Browser test return');
  await page.waitForTimeout(400);
  const preview = await page.$eval('#netPreview', n => n.textContent);
  step('note value preview: ' + preview);
  await page.click('#noteForm button[type=submit]');
  await page.waitForTimeout(2200);
  step('credit note → ' + await toasts());
  const noteRows = await page.$$eval('#noteList tbody tr', r => r.length);
  step('notes listed: ' + noteRows);
  if (noteRows === 0) errors.push('the note did not appear in the list');
  await page.screenshot({ path: 'shot-notes.png' });

  // ---- Banking: create an account and import a real CSV ----
  await page.goto(BASE + '/banking.html');
  await page.waitForTimeout(2000);
  await page.click('#tabBar button[data-tab="Accounts"]');
  await page.waitForTimeout(1500);
  if (await page.$('#accForm')) {
    await page.fill('input[name=accountName]', 'Browser Test Account');
    await page.fill('input[name=bankName]', 'UI Bank');
    await page.click('#accForm button[type=submit]');
    await page.waitForTimeout(1800);
    step('bank account created → ' + await toasts());
  }

  const csvPath = path.join('/tmp', 'browser-statement.csv');
  fs.writeFileSync(csvPath,
    'Date,Narration,Ref,Withdrawal,Deposit,Balance\n' +
    '10/08/2026,UPI receipt from a customer,UPI900,,2500.00,12500.00\n' +
    '12/08/2026,Monthly bank charges,CHG99,236.00,,12264.00\n' +
    '14/08/2026,Electricity direct debit,DD41,1450.00,,10814.00\n');

  await page.selectOption('#accountSel', { label: /Browser Test Account/ }).catch(() => {});
  await page.click('#tabBar button[data-tab="Import"]');
  await page.waitForTimeout(1600);
  await page.setInputFiles('#csvFile', csvPath);
  await page.waitForTimeout(1400);

  const guessed = await page.evaluate(() => ({
    date: document.getElementById('mDate')?.value,
    desc: document.getElementById('mDesc')?.value,
    debit: document.getElementById('mDebit')?.value,
    credit: document.getElementById('mCredit')?.value
  }));
  step('column mapping guessed from the header: ' + JSON.stringify(guessed));
  if (guessed.date !== '0' || guessed.credit !== '4') errors.push('column auto-mapping was wrong: ' + JSON.stringify(guessed));

  const previewRows = await page.$$eval('#mapArea tbody tr', r => r.length);
  step('preview rows shown: ' + previewRows);
  await page.screenshot({ path: 'shot-bank-import.png' });

  await page.click('#doImport');
  await page.waitForTimeout(2500);
  step('import → ' + await toasts());

  const reconKpis = await page.$$eval('.kpi-card .value', ns => ns.map(n => n.textContent.trim()));
  step('reconciliation KPIs: ' + reconKpis.join(' | '));
  const unmatchedRows = await page.$$eval('#tabContent table tbody tr', r => r.length);
  step('unmatched lines to work through: ' + unmatchedRows);
  if (unmatchedRows === 0) errors.push('imported lines did not appear as unmatched');
  await page.screenshot({ path: 'shot-banking.png' });

  // Post a bank charge straight from the statement.
  const postBtn = await page.$('[data-post]');
  if (postBtn) {
    await postBtn.click();
    await page.waitForTimeout(1200);
    await page.selectOption('#postAccount', { label: /Other Expenses/ }).catch(async () => {
      await page.selectOption('#postAccount', { index: 0 });
    });
    await page.click('#postSave');
    await page.waitForTimeout(2000);
    step('posted a statement line → ' + await toasts());
  } else { errors.push('no "Post new" button on an unmatched line'); }

  // ---- Reports ----
  await page.goto(BASE + '/reports.html');
  await page.waitForTimeout(2400);
  const reportCount = await page.$$eval('#reportSel option', o => o.length);
  step('reports available: ' + reportCount);
  if (reportCount < 8) errors.push('expected at least 8 reports, got ' + reportCount);

  for (const key of ['day-book', 'cash-flow', 'stock-movement', 'sales-register']) {
    await page.selectOption('#reportSel', key);
    await page.waitForTimeout(1800);
    const title = await page.$eval('#reportArea h2', n => n.textContent).catch(() => '(none)');
    const rows = await page.$$eval('#reportArea tbody tr', r => r.length).catch(() => 0);
    step(`${key} → "${title}" with ${rows} rows`);
    if (title === '(none)') errors.push(key + ' rendered no report');
  }
  await page.screenshot({ path: 'shot-reports.png' });

  // CSV download must actually produce a file.
  const dl = page.waitForEvent('download', { timeout: 15000 });
  await page.click('#csvBtn');
  const download = await dl.catch(() => null);
  if (download) {
    const p = await download.path();
    const size = p ? fs.statSync(p).size : 0;
    step(`CSV downloaded: ${download.suggestedFilename()} (${size} bytes)`);
    if (size < 20) errors.push('the CSV download was empty');
  } else { errors.push('CSV download never fired'); }

  // ---- Settings: companies, backup, year-end ----
  await page.goto(BASE + '/admin.html');
  await page.waitForTimeout(2000);
  const tabs = await page.$$eval('#tabBar button', bs => bs.map(b => b.textContent.trim()));
  step('settings tabs: ' + tabs.join(', '));
  for (const want of ['Companies', 'Backup']) {
    if (!tabs.includes(want)) errors.push('settings tab missing: ' + want);
  }

  await page.click('#tabBar button[data-tab="Companies"]');
  await page.waitForTimeout(1600);
  const coRows = await page.$$eval('#tabContent table tbody tr', r => r.length);
  step('companies listed: ' + coRows);
  if (coRows < 2) errors.push('expected more than one company by now');

  await page.click('#tabBar button[data-tab="Backup"]');
  await page.waitForTimeout(1600);
  const backupInfo = await page.$$eval('#tabContent tbody tr', rs => rs.length);
  step('backup info rows: ' + backupInfo);
  const bdl = page.waitForEvent('download', { timeout: 20000 });
  await page.click('#backupBtn');
  const bfile = await bdl.catch(() => null);
  if (bfile) {
    const p = await bfile.path();
    const size = p ? fs.statSync(p).size : 0;
    step(`backup downloaded: ${bfile.suggestedFilename()} (${(size / 1024).toFixed(0)} KB)`);
    if (size < 20000) errors.push('the backup download looks empty');
  } else { errors.push('backup download never fired'); }

  await page.click('#tabBar button[data-tab="Financial Years"]');
  await page.waitForTimeout(1600);
  const hasYearEnd = await page.$('[data-yearend]');
  step('year-end close button present: ' + !!hasYearEnd);
  if (!hasYearEnd) errors.push('no year-end close button on the active year');
  await page.screenshot({ path: 'shot-settings-years.png' });

  // ---- mobile ----
  await page.setViewportSize({ width: 390, height: 844 });
  for (const p of ['notes.html', 'banking.html', 'reports.html']) {
    await page.goto(BASE + '/' + p);
    await page.waitForTimeout(2000);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
    step(`${p} mobile ok: ${!overflow}`);
    if (overflow) errors.push(p + ' scrolls sideways on mobile');
  }

  await browser.close();
  console.log('\n' + (errors.length ? 'ERRORS:\n' + errors.join('\n') : 'No page errors.'));
  process.exit(errors.length ? 1 : 0);
})();
