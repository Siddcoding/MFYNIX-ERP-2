// Browser walkthrough of the login chooser, the customer portal, the new
// Ember theme and the animation layer.
//
// The portal is set up through the API from inside the page (so it uses the
// same auth path a real admin would) and then driven entirely through the UI.
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const context = await browser.newContext({ viewport: { width: 1400, height: 950 }, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('[pageerror] ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/429|Failed to load resource/.test(m.text())) errors.push('[console] ' + m.text()); });
  const BASE = 'http://localhost:3999';
  const step = s => console.log('  · ' + s);

  // ---------------- The chooser is the first thing on the login screen -----
  await page.goto(BASE + '/index.html');
  await page.waitForTimeout(600);

  const chooserVisible = await page.isVisible('#paneChoose');
  const adminHidden = !(await page.isVisible('#paneAdmin'));
  const customerHidden = !(await page.isVisible('#paneCustomer'));
  step(`chooser shown first: ${chooserVisible}; both forms hidden: ${adminHidden && customerHidden}`);
  if (!chooserVisible) errors.push('the account-type chooser is not shown first');
  if (!adminHidden || !customerHidden) errors.push('a sign-in form is visible before a type is chosen');

  const cards = await page.$$eval('.chooser-card', ns => ns.map(n => n.querySelector('.chooser-title').textContent.trim()));
  step('choices offered: ' + cards.join(' | '));
  if (cards.length !== 2) errors.push('expected exactly two account-type choices');

  const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  step('default theme: ' + theme);
  if (theme !== 'mfynix') errors.push('the new default theme is not applied on the login screen');

  // Picking Customer must show the email form, not the username one.
  await page.click('.chooser-card[data-mode="customer"]');
  await page.waitForTimeout(500);
  if (!await page.isVisible('#custEmail')) errors.push('customer pane did not open');
  if (await page.isVisible('#username')) errors.push('staff form visible on the customer pane');
  step('customer pane opens with an email field');

  // Back returns to the chooser.
  await page.click('#paneCustomer [data-back]');
  await page.waitForTimeout(400);
  if (!await page.isVisible('#paneChoose')) errors.push('back did not return to the chooser');
  step('back returns to the chooser');

  // A customer who does not exist gets a refusal, not a portal.
  await page.click('.chooser-card[data-mode="customer"]');
  await page.fill('#custEmail', 'nobody@example.com');
  await page.fill('#custPassword', 'whatever123');
  await page.click('#custLoginBtn');
  await page.waitForTimeout(2500);
  const badToast = (await page.$$eval('.toast .toast-msg', ns => ns.map(n => n.textContent))).join(' / ');
  step('unknown customer refused: ' + badToast.trim());
  if (!/Invalid email or password|Too many/.test(badToast)) errors.push('unknown customer was not refused clearly');

  // ---------------- Staff side, and granting portal access ----------------
  await page.goto(BASE + '/index.html?mode=admin');
  await page.fill('#username', 'admin');
  await page.fill('#password', 'Admin@123');
  await page.click('#loginBtn');
  await page.waitForURL('**/dashboard.html', { timeout: 15000 });
  await page.waitForTimeout(3000);
  step('staff signed in');

  // The nav indicator and the ripple layer are both part of the new animation
  // work; assert they actually got attached rather than trusting the CSS.
  const hasIndicator = await page.$('.nav-indicator') !== null;
  const tablesAnimated = await page.evaluate(() =>
    [...document.querySelectorAll('#page-content table')].every(t => t.classList.contains('table-anim')));
  step(`nav indicator present: ${hasIndicator}; tables marked for the row stagger: ${tablesAnimated}`);
  if (!hasIndicator) errors.push('sliding nav indicator was not attached');
  if (!tablesAnimated) errors.push('rendered tables were not picked up for the staggered row entrance');

  await page.click('button.btn');
  await page.waitForTimeout(120);
  // The ripple removes itself after ~600ms, so check while it is still there.
  step('button ripple element created: ' + (await page.evaluate(() => !!document.querySelector('.ripple')) ? 'yes' : 'no (already cleaned up)'));

  // Set up a portal customer through the API, from the authenticated page.
  const setup = await page.evaluate(async () => {
    const tok = localStorage.getItem('mf_token');
    const h = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok };
    const customers = await (await fetch('/api/masters/customers', { headers: h })).json();
    const target = customers.find(c => c.CustomerName === 'Acme Traders') || customers[0];
    if (!target) return { error: 'no customers exist' };
    await fetch('/api/masters/customers/' + target.CustomerID, {
      method: 'PUT', headers: h,
      body: JSON.stringify({ Email: 'portal.demo@example.com', CreditLimit: 500000, CreditDays: 15 })
    });
    const res = await (await fetch('/api/masters/customers/' + target.CustomerID + '/portal-access', {
      method: 'POST', headers: h, body: JSON.stringify({ enabled: true, password: 'Portal@123' })
    })).json();
    return { name: target.CustomerName, id: target.CustomerID, res };
  });
  if (setup.error) { errors.push(setup.error); }
  step(`portal access granted to ${setup.name}: ${JSON.stringify(setup.res)}`);

  // The Masters screen should now show that access as "Enabled".
  await page.goto(BASE + '/masters.html');
  await page.waitForTimeout(1800);
  const portalButtons = await page.$$eval('[data-portal]', ns => ns.map(n => n.textContent.trim()));
  step('portal buttons on the customer list: ' + portalButtons.join(', '));
  if (!portalButtons.some(b => /^Until |no expiry|left$|Expires today/.test(b))) {
    errors.push('the customer list does not show when the granted access runs to: ' + portalButtons.join(', '));
  }

  // ---------------- The access term picker ----------------
  // Open the dialog for whichever customer actually has access.
  const buttons = await page.$$('[data-portal]');
  let target = null;
  for (const b of buttons) {
    const t = (await b.textContent()).trim();
    if (t !== 'Off') { target = b; break; }
  }
  if (!target) errors.push('no customer with portal access found on the list');
  else {
    await target.click();
    await page.waitForTimeout(1200);

    const terms = await page.$$eval('.term-card .term-label', ns => ns.map(n => n.textContent.trim()));
    step('access terms offered: ' + terms.join(' | '));
    for (const want of ['1 month', '3 months', '6 months', '1 year']) {
      if (!terms.includes(want)) errors.push('missing access term: ' + want);
    }

    // Each term must show the date it would actually run to, not just a label.
    const untilTexts = await page.$$eval('.term-card .term-until', ns => ns.map(n => n.textContent.trim()));
    step('each term shows its end date: ' + untilTexts.join(' | '));
    if (!untilTexts.filter(t => /^to /.test(t)).length) errors.push('the term cards do not show the resulting date');

    const standing = await page.$eval('.access-standing', n => n.textContent.replace(/\s+/g, ' ').trim());
    step('current standing: ' + standing);
    if (!/Active/.test(standing)) errors.push('the dialog does not report the current access standing');

    // Pick three months and save.
    await page.click('.term-card[data-term="3"]');
    await page.waitForTimeout(400);
    const note = await page.$eval('#paTermNote', n => n.textContent.trim());
    step('after picking 3 months: ' + note);
    if (!/Access will run to/.test(note)) errors.push('picking a term did not say what date it lands on');

    await page.click('#paSave');
    await page.waitForTimeout(2200);
    const saveToast = (await page.$$eval('.toast .toast-msg', ns => ns.map(n => n.textContent))).join(' / ');
    step('save result: ' + saveToast.trim());
    if (!/active until/i.test(saveToast)) errors.push('saving a term did not confirm the new expiry');

    await page.waitForTimeout(1200);
    const labelAfter = await page.$$eval('[data-portal]', ns => ns.map(n => n.textContent.trim()).filter(t => t !== 'Off'));
    step('list now shows: ' + labelAfter.join(', '));
    if (!labelAfter.some(t => /^Until /.test(t))) errors.push('the list did not pick up the new expiry date');
  }

  // ---------------- Customer portal, in a clean session -------------------
  const custContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const cust = await custContext.newPage();
  const custErrors = [];
  cust.on('pageerror', e => custErrors.push('[pageerror] ' + e.message));

  await cust.goto(BASE + '/index.html?mode=customer');
  await cust.fill('#custEmail', 'portal.demo@example.com');
  await cust.fill('#custPassword', 'Portal@123');
  await cust.click('#custLoginBtn');
  await cust.waitForURL('**/portal.html', { timeout: 15000 });
  await cust.waitForTimeout(2200);
  step('customer signed in and landed on the portal');

  const heroText = await cust.$eval('#heroAmount', n => n.textContent);
  const kpis = await cust.$$eval('.kpi-card .label', ns => ns.map(n => n.textContent.trim()));
  step(`portal overview: outstanding ${heroText}; KPIs ${kpis.join(' | ')}`);
  if (!/₹/.test(heroText)) errors.push('the portal outstanding figure did not render');

  // Nothing on the portal may offer a route into the ERP.
  const hasSidebar = await cust.$('.sidebar') !== null;
  const linksOut = await cust.$$eval('a[href]', as => as.map(a => a.getAttribute('href'))
    .filter(h => /dashboard|sales|purchase|accounts|admin|gst|payroll|branches/.test(h)));
  step(`portal has no ERP sidebar: ${!hasSidebar}; no links into the ERP: ${linksOut.length === 0}`);
  if (hasSidebar || linksOut.length) errors.push('the portal exposes ERP navigation');

  const tabs = await cust.$$eval('#portalTabs button', ns => ns.map(n => n.textContent.trim()));
  step('portal tabs: ' + tabs.join(' | '));

  await cust.click('#portalTabs button[data-tab="Invoices"]');
  await cust.waitForTimeout(1800);
  const invoiceRows = await cust.$$eval('#page-content tbody tr', ns => ns.length);
  step('invoices listed: ' + invoiceRows);
  if (invoiceRows === 0) errors.push('the portal showed no invoices for a customer that has some');

  await cust.click('#page-content [data-invoice]');
  await cust.waitForTimeout(1500);
  const modalTitle = await cust.$eval('.modal h2', n => n.textContent);
  const modalLines = await cust.$$eval('.modal tbody tr', ns => ns.length);
  step(`invoice modal "${modalTitle.trim()}" with ${modalLines} line(s)`);
  if (modalLines === 0) errors.push('the invoice detail modal had no line items');
  await cust.click('#invClose');

  await cust.click('#portalTabs button[data-tab="Outstanding"]');
  await cust.waitForTimeout(1600);
  step('outstanding tab: ' + (await cust.$eval('#page-content .muted', n => n.textContent)).trim());

  await cust.click('#portalTabs button[data-tab="Statement"]');
  await cust.waitForTimeout(2200);
  const statementRows = await cust.$$eval('#stBody tbody tr', ns => ns.length);
  step('statement rows: ' + statementRows);
  if (statementRows === 0) errors.push('the statement rendered no rows');

  const download = await Promise.all([
    cust.waitForEvent('download', { timeout: 15000 }),
    cust.click('#stCsv')
  ]).then(([d]) => d).catch(() => null);
  step('statement CSV download: ' + (download ? download.suggestedFilename() : 'FAILED'));
  if (!download) errors.push('statement CSV did not download');

  await cust.click('#portalTabs button[data-tab="My details"]');
  await cust.waitForTimeout(1400);
  const details = await cust.$$eval('.setting-row .label', ns => ns.map(n => n.textContent.trim()));
  step('my details rows: ' + details.join(', '));

  // A customer token must not open an ERP page.
  await cust.goto(BASE + '/dashboard.html');
  await cust.waitForTimeout(2500);
  step('customer opening the ERP dashboard ends at: ' + cust.url().split('/').pop());
  if (/dashboard/.test(cust.url())) errors.push('a customer token was left sitting on the ERP dashboard');

  // And a staff token must not open the portal.
  await page.goto(BASE + '/portal.html');
  await page.waitForTimeout(2000);
  step('staff opening the portal ends at: ' + page.url().split('/').pop());
  if (/portal/.test(page.url())) errors.push('a staff token was left sitting on the customer portal');

  // ---------------- Mobile ----------------
  await cust.setViewportSize({ width: 390, height: 844 });
  await cust.goto(BASE + '/portal.html');
  await cust.waitForTimeout(2200);
  const overflow = await cust.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  step('portal fits a phone screen without sideways scroll: ' + overflow);
  if (!overflow) errors.push('the portal overflows horizontally on a phone');

  await cust.screenshot({ path: 'shot-portal-mobile.png' });
  await cust.setViewportSize({ width: 1280, height: 900 });
  await cust.goto(BASE + '/portal.html');
  await cust.waitForTimeout(2200);
  await cust.screenshot({ path: 'shot-portal.png' });
  await page.goto(BASE + '/index.html');
  await page.evaluate(() => localStorage.removeItem('mf_login_mode'));
  await page.goto(BASE + '/index.html');
  await page.waitForTimeout(900);
  await page.screenshot({ path: 'shot-login-chooser.png' });

  errors.push(...custErrors);
  console.log(errors.length ? '\nERRORS:\n' + errors.join('\n') : '\nNo page errors.');
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})();
