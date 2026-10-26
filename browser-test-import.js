// Browser walkthrough of the Excel/CSV bulk import on Masters and on the user
// list. Real files are written to disk and handed to the real file input, so
// this exercises the browser's FileReader path, not a mocked upload.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const context = await browser.newContext({ viewport: { width: 1400, height: 950 }, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('[pageerror] ' + e.message));
  const BASE = 'http://localhost:3999';
  const step = s => console.log('  · ' + s);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-import-'));
  const stamp = Date.now();

  // Headings deliberately not matching the database columns.
  // The GSTINs carry the timestamp too, not just the names: the importer
  // deduplicates on either, so a fixed GSTIN would make the second run of this
  // suite skip everything and look like a regression.
  const tail = String(stamp).slice(-5);
  const customersCsv = path.join(dir, 'customers.csv');
  fs.writeFileSync(customersCsv,
    'Party,GST Number,mobile,state,Credit Limit\n' +
    `UI Import Alpha ${stamp},29UIIM${tail}A1Z5,9800001111,Karnataka,"1,50,000"\n` +
    `UI Import Beta ${stamp},29UIIM${tail}B1Z5,9800002222,Karnataka,80000\n` +
    ',,9800003333,Karnataka,50000\n');          // blank name → must be rejected

  const usersCsv = path.join(dir, 'users.csv');
  fs.writeFileSync(usersCsv,
    'UserName,Full Name,Role,Branch,Password\n' +
    `ui.imp.${stamp},UI Imported Manager,Store Manager,HYD,\n` +
    'admin,Clashes With Admin,Accountant,HYD,\n');

  const notASheet = path.join(dir, 'notes.pdf');
  fs.writeFileSync(notASheet, 'this is definitely not a spreadsheet');

  // ---------------- Sign in ----------------
  await page.goto(BASE + '/index.html?mode=admin');
  await page.fill('#username', 'admin');
  await page.fill('#password', 'Admin@123');
  await page.click('#loginBtn');
  await page.waitForURL('**/dashboard.html', { timeout: 15000 });
  step('signed in');

  // ---------------- Masters → Customers ----------------
  await page.goto(BASE + '/masters.html');
  await page.waitForTimeout(1800);

  const btnLabel = await page.$eval('#importBtn', n => n.textContent.trim());
  step('import button on the customer tab: "' + btnLabel + '"');
  if (!/customer/i.test(btnLabel)) errors.push('the import button does not name the active tab');

  const before = await page.$$eval('#listArea tbody tr', ns => ns.length);

  await page.click('#importBtn');
  await page.waitForTimeout(700);
  if (!await page.isVisible('#importDrop')) errors.push('the import dialog did not open');
  step('import dialog open, Import button disabled until a file is chosen: ' +
    (await page.$eval('#importGo', n => n.disabled)));
  if (!(await page.$eval('#importGo', n => n.disabled))) errors.push('Import was enabled with no file chosen');

  // A file that is not a spreadsheet must be refused in the browser, before
  // anything is uploaded.
  await page.setInputFiles('#importFile', notASheet);
  await page.waitForTimeout(500);
  const refusal = await page.$eval('#importError', n => n.textContent);
  step('non-spreadsheet refused client-side: ' + refusal.trim().slice(0, 60));
  if (!/\.xlsx or \.csv/i.test(refusal)) errors.push('a .pdf was not refused before upload');

  // Now the real file.
  await page.setInputFiles('#importFile', customersCsv);
  await page.waitForTimeout(500);
  const chosen = await page.$eval('#importChosen', n => n.textContent);
  step('file chosen: ' + chosen.trim());
  if (!/customers\.csv/.test(chosen)) errors.push('the chosen filename was not shown');

  await page.click('#importGo');
  await page.waitForTimeout(2500);

  const chips = await page.$$eval('.import-summary .chip', ns => ns.map(n => n.textContent.trim()));
  step('result: ' + chips.join(' / '));
  if (!chips.some(c => /^2 imported/.test(c))) errors.push('expected 2 rows imported, got: ' + chips.join(', '));
  if (!chips.some(c => /^1 rejected/.test(c))) errors.push('expected 1 rejected row, got: ' + chips.join(', '));

  const resultRows = await page.$$eval('.import-results tbody tr', ns => ns.map(n => n.textContent.replace(/\s+/g, ' ').trim()));
  step('per-row detail: ' + resultRows.length + ' rows, first is "' + (resultRows[0] || '') + '"');
  if (!resultRows.some(r => /blank/i.test(r))) errors.push('the rejected row does not say why');
  // Worst-first ordering: the problem row must not be buried at the bottom.
  if (resultRows.length && !/error/i.test(resultRows[0])) errors.push('the rejected row is not listed first');

  // The list behind the dialog must have refreshed.
  await page.click('#importClose');
  await page.waitForTimeout(1200);
  const after = await page.$$eval('#listArea tbody tr', ns => ns.length);
  step(`customer list refreshed: ${before} → ${after} rows`);
  if (after !== before + 2) errors.push(`the list did not refresh with the imported rows (${before} → ${after})`);

  const listText = await page.$eval('#listArea', n => n.textContent);
  if (!listText.includes(`UI Import Alpha ${stamp}`)) errors.push('the imported customer is not in the list');
  // "1,50,000" must have become a number, not text.
  step('imported credit limit shown as: ' + (listText.match(/150000/) ? '150000' : 'NOT PARSED'));
  if (!/150000/.test(listText)) errors.push('the formatted credit limit was not parsed to a number');

  // Re-uploading the same file must skip, not duplicate.
  await page.click('#importBtn');
  await page.waitForTimeout(600);
  await page.setInputFiles('#importFile', customersCsv);
  await page.waitForTimeout(400);
  await page.click('#importGo');
  await page.waitForTimeout(2500);
  const chips2 = await page.$$eval('.import-summary .chip', ns => ns.map(n => n.textContent.trim()));
  step('re-upload result: ' + chips2.join(' / '));
  if (!chips2.some(c => /^0 imported/.test(c))) errors.push('re-uploading the same sheet imported rows again');
  if (!chips2.some(c => /^2 skipped/.test(c))) errors.push('re-upload did not report the duplicates as skipped');
  await page.click('#importClose');
  await page.waitForTimeout(800);

  // ---------------- The button follows the active tab ----------------
  await page.click('[data-tab="items"]');
  await page.waitForTimeout(1200);
  const itemsLabel = await page.$eval('#importBtn', n => n.textContent.trim());
  step('after switching to Items the button reads: "' + itemsLabel + '"');
  if (!/item/i.test(itemsLabel)) errors.push('the import button did not follow the tab switch');

  // ---------------- Template download ----------------
  await page.click('#importBtn');
  await page.waitForTimeout(600);
  const download = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }),
    page.click('#importTemplate')
  ]).then(([d]) => d).catch(() => null);
  step('template download: ' + (download ? download.suggestedFilename() : 'FAILED'));
  if (!download) errors.push('the blank template did not download');
  if (download && !/items-template\.csv/.test(download.suggestedFilename())) {
    errors.push('the template filename does not name the entity: ' + download.suggestedFilename());
  }
  await page.click('#importClose');

  // ---------------- Users ----------------
  await page.goto(BASE + '/branches.html');
  await page.waitForTimeout(2000);
  if (!await page.isVisible('#importUsersBtn')) errors.push('the user import button is not shown to a Super Admin');

  await page.click('#importUsersBtn');
  await page.waitForTimeout(600);
  await page.setInputFiles('#importFile', usersCsv);
  await page.waitForTimeout(400);
  await page.click('#importGo');
  await page.waitForTimeout(2800);

  const userChips = await page.$$eval('.import-summary .chip', ns => ns.map(n => n.textContent.trim()));
  step('user import: ' + userChips.join(' / '));
  if (!userChips.some(c => /^1 imported/.test(c))) errors.push('expected 1 user imported');
  if (!userChips.some(c => /^1 skipped/.test(c))) errors.push('the clashing "admin" username was not skipped');

  // A generated password must be shown once, here.
  const passwordCell = await page.$$eval('.import-results code', ns => ns.map(n => n.textContent.trim()));
  step('generated password shown to the admin: ' + (passwordCell[0] ? passwordCell[0].length + ' characters' : 'NONE'));
  if (!passwordCell.length) errors.push('no generated password was shown for the blank password cell');

  await page.click('#importClose');
  await page.waitForTimeout(1200);
  const userListText = await page.$eval('#userList', n => n.textContent);
  if (!userListText.includes('UI Imported Manager')) errors.push('the imported user is not in the user list');
  step('user list refreshed and contains the imported user');

  // ---------------- Mobile ----------------
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(BASE + '/masters.html');
  await page.waitForTimeout(1800);
  await page.click('#importBtn');
  await page.waitForTimeout(700);
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  step('import dialog fits a phone screen: ' + fits);
  if (!fits) errors.push('the import dialog overflows horizontally on a phone');
  await page.screenshot({ path: 'shot-import-mobile.png' });

  await page.setViewportSize({ width: 1400, height: 950 });
  await page.goto(BASE + '/masters.html');
  await page.waitForTimeout(1600);
  await page.click('#importBtn');
  await page.waitForTimeout(700);
  await page.screenshot({ path: 'shot-import.png' });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(errors.length ? '\nERRORS:\n' + errors.join('\n') : '\nNo page errors.');
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})();
