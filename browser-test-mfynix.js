// Browser walkthrough of the Mfynix additions: splash, themes, the full
// Settings area, and Outstanding with ageing and allocation.
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

  // ---- Splash on the login page ----
  await page.goto(BASE + '/index.html?mode=admin');
  const splashTitle = await page.$eval('#appSplash .splash-title', n => n.textContent).catch(() => null);
  const slogan = await page.$eval('#appSplash .splash-slogan', n => n.textContent).catch(() => null);
  step(`splash: "${splashTitle}" — "${slogan}"`);
  if (!splashTitle || !/Mfynix/i.test(splashTitle)) errors.push('splash title missing the product name');
  if (!slogan || !/Smarter ERP/i.test(slogan)) errors.push('splash slogan missing');
  // The mark itself must actually load, not just be referenced - a broken
  // image tag would still pass a "src is set" check.
  const markLoaded = await page.$eval('#appSplash .splash-logo',
    img => img.complete && img.naturalWidth > 0).catch(() => false);
  step('splash brand mark rendered: ' + markLoaded);
  if (!markLoaded) errors.push('the Mfynix mark did not load on the splash');
  if (!slogan) errors.push('splash slogan missing');
  await page.screenshot({ path: 'shot-splash.png' });

  await page.waitForTimeout(1400);
  const stillUp = await page.$('#appSplash');
  step('splash cleared after load: ' + !stillUp);
  if (stillUp) errors.push('splash never went away');

  const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  step('default theme: ' + theme);
  if (theme !== 'mfynix') errors.push('default theme is not the new one');

  await page.fill('#username, input[name=username]', 'admin');
  await page.fill('#password, input[name=password]', 'Admin@123');
  await page.click('#loginBtn');
  await page.waitForURL('**/dashboard.html', { timeout: 15000 });
  step('logged in');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'shot-theme-mfynix.png' });

  const nav = await page.$$eval('.sidebar nav a', as => as.map(a => a.textContent.trim()));
  for (const want of ['Outstanding', 'Settings']) {
    if (!nav.includes(want)) errors.push(`nav missing ${want}`);
  }
  step('nav: ' + nav.join(' | '));

  // ---- Settings: every tab ----
  await page.goto(BASE + '/admin.html');
  await page.waitForTimeout(1800);
  const tabs = await page.$$eval('#tabBar button', bs => bs.map(b => b.textContent.trim()));
  step('settings tabs: ' + tabs.join(', '));
  for (const want of ['Company', 'Financial Years', 'Numbering', 'Appearance', 'Policies', 'Audit Log']) {
    if (!tabs.includes(want)) errors.push(`settings tab missing: ${want}`);
  }

  // Company profile round-trip
  if (!await page.$('#companyForm')) errors.push('company form missing');
  await page.fill('input[name=pan]', 'BROWSER123X');
  await page.fill('input[name=phone]', '+91 90000 00000');
  await page.click('#companyForm button[type=submit]');
  await page.waitForTimeout(1800);
  step('company save → ' + await toasts());
  await page.reload();
  await page.waitForTimeout(1900);
  const panBack = await page.$eval('input[name=pan]', n => n.value);
  step('PAN persisted: ' + panBack);
  if (panBack !== 'BROWSER123X') errors.push('company profile did not persist');
  await page.screenshot({ path: 'shot-settings-company.png' });

  // Financial years
  await page.click('#tabBar button[data-tab="Financial Years"]');
  await page.waitForTimeout(1500);
  const fyRows = await page.$$eval('#tabContent table tbody tr', r => r.length);
  step('financial years listed: ' + fyRows);
  if (fyRows === 0) errors.push('no financial years shown');

  // Numbering
  await page.click('#tabBar button[data-tab="Numbering"]');
  await page.waitForTimeout(1500);
  const seqRows = await page.$$eval('#tabContent table tbody tr', r => r.length);
  const firstPreview = await page.$$eval('#tabContent table tbody tr td', tds => tds.map(t => t.textContent).join(' | '));
  step(`numbering series: ${seqRows}; first row: ${firstPreview.slice(0, 90)}`);
  if (seqRows === 0) errors.push('no numbering series shown');

  // Appearance — switch theme and confirm it sticks across a reload
  await page.click('#tabBar button[data-tab="Appearance"]');
  await page.waitForTimeout(1300);
  const themeCards = await page.$$eval('.theme-card', c => c.length);
  step('themes offered: ' + themeCards);
  if (themeCards < 4) errors.push('theme picker is missing options');
  await page.click('.theme-card[data-theme-id="daylight"]');
  await page.waitForTimeout(900);
  const applied = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  step(`daylight applied: ${applied}, body background ${bodyBg}`);
  if (applied !== 'daylight') errors.push('theme did not apply');
  await page.screenshot({ path: 'shot-theme-daylight.png' });

  await page.reload();
  await page.waitForTimeout(1800);
  const persisted = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  step('theme after reload: ' + persisted);
  if (persisted !== 'daylight') errors.push('theme did not persist');

  await page.click('#tabBar button[data-tab="Appearance"]');
  await page.waitForTimeout(1200);
  await page.click('.theme-card[data-theme-id="plum"]');
  await page.waitForTimeout(700);
  await page.screenshot({ path: 'shot-theme-plum.png' });
  await page.click('.theme-card[data-theme-id="mfynix"]');
  await page.waitForTimeout(700);

  // Policies still work
  await page.click('#tabBar button[data-tab="Policies"]');
  await page.waitForTimeout(1400);
  if (!await page.$('#setNegStock')) errors.push('policies tab broke');
  step('policies tab intact');

  // Audit log still works
  await page.click('#tabBar button[data-tab="Audit Log"]');
  await page.waitForTimeout(1700);
  const auditRows = await page.$$eval('#auditRows tbody tr', r => r.length).catch(() => 0);
  step('audit rows: ' + auditRows);
  if (auditRows === 0) errors.push('audit log broke');

  // ---- Outstanding ----
  await page.goto(BASE + '/outstanding.html');
  await page.waitForTimeout(2000);
  const kpis = await page.$$eval('.kpi-card .value', ns => ns.map(n => n.textContent.trim()));
  step('outstanding KPIs: ' + kpis.join(' | '));
  const partyRows = await page.$$eval('#tabContent table tbody tr', r => r.length);
  step('customers with balances: ' + partyRows);
  if (partyRows === 0) errors.push('no outstanding customers shown');
  await page.screenshot({ path: 'shot-outstanding.png' });

  // Open a party and settle something
  const openBtn = await page.$('[data-party]');
  if (openBtn) {
    await openBtn.click();
    await page.waitForTimeout(1300);
    const docRows = await page.$$eval('#activeModalBackdrop tbody tr', r => r.length).catch(() => 0);
    step('open documents in the drawer: ' + docRows);
    const amountInput = await page.$('#activeModalBackdrop [data-doc-id]');
    if (amountInput) {
      const max = await amountInput.evaluate(n => n.dataset.max);
      await amountInput.fill(String(Math.min(1, Number(max))));
      await page.click('#allocSave');
      await page.waitForTimeout(1900);
      step('settlement → ' + await toasts());
    } else { errors.push('no allocation inputs in the drawer'); }
  } else { errors.push('could not open a party'); }

  // Ageing report
  await page.click('#tabBar button[data-tab="Ageing Report"]');
  await page.waitForTimeout(1700);
  const buckets = await page.$$eval('.funnel-row .funnel-stage', ns => ns.map(n => n.textContent.trim()));
  step('ageing buckets: ' + buckets.join(', '));
  if (buckets.length !== 5) errors.push('ageing report should show 5 buckets, got ' + buckets.length);
  await page.screenshot({ path: 'shot-ageing.png' });

  await page.click('#tabBar button[data-tab="Payable"]');
  await page.waitForTimeout(1500);
  step('payable view rendered');

  // ---- mobile ----
  await page.setViewportSize({ width: 390, height: 844 });
  for (const p of ['admin.html', 'outstanding.html', 'dashboard.html']) {
    await page.goto(BASE + '/' + p);
    await page.waitForTimeout(1800);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
    step(`${p} mobile ok: ${!overflow}`);
    if (overflow) errors.push(p + ' scrolls sideways on mobile');
  }

  await browser.close();
  console.log('\n' + (errors.length ? 'ERRORS:\n' + errors.join('\n') : 'No page errors.'));
  process.exit(errors.length ? 1 : 0);
})();
