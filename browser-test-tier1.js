// Browser walkthrough of the Tier-1 work: stock/credit guards surfaced in the
// UI, pagination and filters, the audit log, and the policy settings screen.
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

  const nav = await page.$$eval('.sidebar nav a', as => as.map(a => a.textContent.trim()));
  if (!nav.includes('Settings')) errors.push('Settings missing from nav');
  step('nav includes: ' + nav.join(' | '));

  // ---- Sales: filters + pager, and the stock guard surfacing in the UI ----
  await page.goto(BASE + '/sales.html');
  await page.waitForTimeout(1800);
  if (!await page.$('#fSearch')) errors.push('sales filter bar missing');
  const pagerText = await page.$eval('#invoicePager', n => n.textContent.trim()).catch(() => '');
  step('sales pager: ' + (pagerText || '(single page)'));

  await page.fill('#fSearch', 'Guard');
  await page.waitForTimeout(1200);
  const filtered = await page.$$eval('#invoiceList tbody tr', r => r.length);
  step(`search "Guard" → ${filtered} rows`);
  await page.click('#fClear');
  await page.waitForTimeout(1200);
  const cleared = await page.$$eval('#invoiceList tbody tr', r => r.length);
  step(`cleared → ${cleared} rows`);
  if (cleared < filtered) errors.push('clearing filters returned fewer rows');

  await page.fill('#fSearch', 'NoSuchThingHere');
  await page.waitForTimeout(1200);
  const empty = await page.$eval('#invoiceList', n => n.textContent);
  step('no-match message: ' + empty.trim().slice(0, 60));
  await page.click('#fClear');
  await page.waitForTimeout(1000);

  // Try to oversell through the real form and confirm the user sees why.
  const lineRows = await page.$$('#lineItems .line-row');
  if (lineRows.length > 0) {
    await page.selectOption('#customerSelect', { index: 0 });
    await page.selectOption('#lineItems .li-item', { index: 0 });
    await page.fill('#lineItems .li-qty', '99999');
    await page.fill('#lineItems .li-rate', '10');
    await page.click('#salesForm button[type=submit]');
    await page.waitForTimeout(2000);
    const msg = await page.$eval('#salesError', n => n.textContent).catch(() => '');
    const t = await toasts();
    step('oversell attempt → ' + (msg || t).slice(0, 130));
    if (!/Not enough stock|credit limit/i.test(msg + t)) {
      errors.push('overselling was not explained to the user; got: ' + (msg || t || '(nothing)'));
    }
  } else {
    errors.push('sales form had no line rows to test overselling with');
  }
  await page.screenshot({ path: 'shot-sales-filters.png' });

  // ---- Audit log ----
  await page.goto(BASE + '/admin.html');
  await page.waitForTimeout(1800);
  await page.click('#tabBar button[data-tab="Audit Log"]');   // Settings opens on Company now
  await page.waitForTimeout(1800);
  const auditRows = await page.$$eval('#auditRows tbody tr', r => r.length).catch(() => 0);
  step('audit rows on page 1: ' + auditRows);
  if (auditRows === 0) errors.push('audit log rendered no rows');
  const actionCount = await page.$$eval('#aAction option', o => o.length);
  step('action filter offers ' + actionCount + ' options');

  await page.selectOption('#aAction', 'LOGIN');
  await page.waitForTimeout(1400);
  const loginOnly = await page.$$eval('#auditRows tbody tr', rs =>
    rs.map(r => r.querySelector('.audit-action')?.textContent.trim()));
  step('filtered to LOGIN → ' + [...new Set(loginOnly)].join(','));
  if (loginOnly.some(a => a && a !== 'LOGIN')) errors.push('audit action filter leaked other actions');
  await page.click('#aClear');
  await page.waitForTimeout(1400);

  const auditPager = await page.$eval('#auditPager', n => n.textContent.trim()).catch(() => '');
  step('audit pager: ' + auditPager);
  if (/Page 1 of/.test(auditPager)) {
    await page.click('#auditPager [data-page="2"]');
    await page.waitForTimeout(1400);
    const p2 = await page.$eval('#auditPager', n => n.textContent);
    step('after Next → ' + p2.match(/Page \d+ of \d+/)[0]);
    if (!/Page 2 of/.test(p2)) errors.push('audit pager did not advance');
  }
  await page.screenshot({ path: 'shot-audit.png' });

  // ---- Policy settings ----
  await page.click('#tabBar button[data-tab="Policies"]');
  await page.waitForTimeout(1500);
  if (!await page.$('#setNegStock')) errors.push('policy settings did not render');
  const negBefore = await page.$eval('#setNegStock', n => n.checked);
  const credBefore = await page.$eval('#setCredit', n => n.checked);
  step(`settings loaded — allowNegativeStock=${negBefore}, enforceCreditLimit=${credBefore}`);
  if (negBefore !== false || credBefore !== true) errors.push('policy defaults are not the safe ones');

  await page.click('#setNegStock');
  await page.click('#saveSettings');
  await page.waitForTimeout(1600);
  step('saved toggle → ' + await toasts());
  await page.reload();
  await page.waitForTimeout(1800);
  await page.click('#tabBar button[data-tab="Policies"]');
  await page.waitForTimeout(1500);
  const negAfter = await page.$eval('#setNegStock', n => n.checked);
  step('after reload allowNegativeStock=' + negAfter);
  if (negAfter !== true) errors.push('setting did not persist');
  await page.click('#setNegStock');           // put it back to safe
  await page.click('#saveSettings');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'shot-settings.png' });

  // ---- An auditor sees the log but not the settings tab ----
  const roles = await page.evaluate(async () => {
    const t = localStorage.getItem('mf_token');
    const res = await fetch('/api/branches/roles/list', { headers: { Authorization: 'Bearer ' + t } });
    return res.json();
  });
  const auditorRole = roles.find(r => r.RoleName === 'Auditor');
  await page.evaluate(async (roleId) => {
    const t = localStorage.getItem('mf_token');
    await fetch('/api/branches/users', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
      body: JSON.stringify({ userName: 'uiauditor', fullName: 'UI Auditor', password: 'Audit@12345', roleId, branchId: null })
    });
  }, auditorRole.RoleID);

  const auditorPage = await context.newPage();
  await auditorPage.goto(BASE + '/index.html?mode=admin');
  await auditorPage.evaluate(() => localStorage.clear());
  await auditorPage.goto(BASE + '/index.html?mode=admin');
  await auditorPage.fill('#username, input[name=username]', 'uiauditor');
  await auditorPage.fill('#password, input[name=password]', 'Audit@12345');
  await auditorPage.click('#loginBtn');
  await auditorPage.waitForURL('**/dashboard.html', { timeout: 15000 });
  await auditorPage.goto(BASE + '/admin.html');
  await auditorPage.waitForTimeout(2000);
  const auditorTabs = await auditorPage.$$eval('#tabBar button', bs => bs.map(b => b.textContent.trim()));
  step('auditor sees tabs: ' + auditorTabs.join(', '));
  if (auditorTabs.includes('Policies')) errors.push('auditor was offered the policy tab');
  await auditorPage.click('#tabBar button[data-tab="Audit Log"]');
  await auditorPage.waitForTimeout(1700);
  const auditorRows = await auditorPage.$$eval('#auditRows tbody tr', r => r.length).catch(() => 0);
  step('auditor can read ' + auditorRows + ' audit rows');
  if (auditorRows === 0) errors.push('auditor could not read the audit log');
  await auditorPage.close();

  // ---- mobile ----
  await page.setViewportSize({ width: 390, height: 844 });
  for (const p of ['admin.html', 'sales.html']) {
    await page.goto(BASE + '/' + p);
    await page.waitForTimeout(1800);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
    step(`${p} mobile ok: ${!overflow}`);
    if (overflow) errors.push(p + ' scrolls sideways on mobile');
  }
  await page.screenshot({ path: 'shot-audit-mobile.png' });

  await browser.close();
  console.log('\n' + (errors.length ? 'ERRORS:\n' + errors.join('\n') : 'No page errors.'));
  process.exit(errors.length ? 1 : 0);
})();
