// Drives the four new pages in a real browser: logs in, visits each page,
// interacts with it, and fails on any console error or visible error text.
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  const errors = [];
  // The browser logs every non-2xx response as a console error. Two of them are
  // expected here: this suite deliberately re-records an already-filed GST
  // return (409) and saves attendance for a locked payroll month (400), and
  // the UI shows the correct toast for each. Filtering them means a genuine
  // console error is not lost in the noise.
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (/status of (400|409)/.test(text)) return;
    errors.push(`[console] ${text}`);
  });
  page.on('pageerror', e => errors.push(`[pageerror] ${e.message}`));

  const BASE = 'http://localhost:3999';
  const step = (s) => console.log('  · ' + s);

  await page.goto(BASE + '/index.html?mode=admin');
  await page.fill('input[name=username], #username', 'admin');
  await page.fill('input[name=password], #password', 'Admin@123');
  await page.click('#loginBtn');
  await page.waitForURL('**/dashboard.html', { timeout: 15000 });
  step('logged in, dashboard loaded');

  const nav = await page.$$eval('.sidebar nav a', as => as.map(a => a.textContent.trim()));
  console.log('  nav:', nav.join(' | '));
  for (const expected of ['GST Filing', 'Payroll', 'CRM', 'MFinAI']) {
    if (!nav.includes(expected)) errors.push(`nav missing ${expected}`);
  }

  async function visit(file, name) {
    await page.goto(BASE + '/' + file);
    await page.waitForTimeout(1400);
    const bad = await page.$$eval('.error-text', ns => ns.filter(n => n.offsetParent !== null).map(n => n.textContent.trim()));
    if (bad.length) errors.push(`${name}: visible error "${bad.join('; ')}"`);
    step(`${name} rendered`);
  }

  // ---- GST ----
  await visit('gst.html', 'GST');
  const kpi = await page.$$eval('.kpi-card .value', ns => ns.map(n => n.textContent.trim()));
  console.log('  GST KPIs:', kpi.join(' | '));
  for (const tab of ['GSTR-1', 'HSN Summary', 'Branch Summary', 'Filing Log']) {
    await page.click(`#tabBar button[data-tab="${tab}"]`);
    await page.waitForTimeout(900);
    const rows = await page.$$eval('#tabContent table tbody tr', r => r.length);
    step(`GST tab "${tab}" → ${rows} rows`);
  }
  await page.click('#tabBar button[data-tab="GSTR-3B"]');
  await page.waitForTimeout(900);
  await page.click('#logReturnBtn');
  await page.waitForTimeout(1200);
  const toastText = await page.$$eval('.toast .toast-msg', ns => ns.map(n => n.textContent));
  step(`recorded return → toast: ${toastText.join(' / ')}`);
  await page.screenshot({ path: '/root/work/shot-gst.png' });

  // ---- Payroll ----
  await visit('payroll.html', 'Payroll');
  await page.fill('input[name=fullName]', 'Test Employee');
  await page.fill('input[name=basic]', '25000');
  await page.fill('input[name=hra]', '10000');
  await page.click('#empForm button[type=submit]');
  await page.waitForTimeout(1500);
  const empRows = await page.$$eval('#tabContent table tbody tr', r => r.length);
  step(`added employee → ${empRows} employees listed`);

  await page.click('#tabBar button[data-tab="Attendance"]');
  await page.waitForTimeout(1200);
  const attInputs = await page.$$('#tabContent tr[data-emp] input[data-f=presentDays]');
  if (attInputs.length) { await attInputs[0].fill("20"); await page.click("#saveAtt"); await page.waitForTimeout(1400); const t = await page.$$eval(".toast .toast-msg", ns=>ns.map(n=>n.textContent)); step("attendance save toast: " + (t.join(" / ") || "(none)")); }
  step(`attendance grid: ${attInputs.length} employees, saved`);

  await page.click('#tabBar button[data-tab="Run Payroll"]');
  await page.waitForTimeout(1200);
  // Head-office user must choose a branch first
  const needsBranch = await page.$('#branchFilter');
  if (needsBranch) {
    const opts = await page.$$eval('#branchFilter option', os => os.map(o => o.value).filter(Boolean));
    await page.selectOption('#branchFilter', opts[0]);
    await page.waitForTimeout(1400);
  }
  const previewRows = await page.$$eval('#tabContent table tbody tr', r => r.length);
  step(`payroll preview → ${previewRows} table rows`);
  const postBtn = await page.$('#postRun');
  if (postBtn) {
    await postBtn.click();
    await page.waitForTimeout(1800);
    step('payroll posted');
  } else { step('post button absent (already posted for this branch/period)'); }
  await page.screenshot({ path: '/root/work/shot-payroll.png' });

  await page.click('#tabBar button[data-tab="Payroll History"]');
  await page.waitForTimeout(1200);
  step(`history rows: ${await page.$$eval('#tabContent table tbody tr', r => r.length)}`);
  await page.click('#tabBar button[data-tab="Statutory"]');
  await page.waitForTimeout(1200);
  step('statutory register rendered');

  // ---- CRM ----
  await visit('crm.html', 'CRM');
  await page.click('#tabBar button[data-tab="All Leads"]');
  await page.waitForTimeout(1000);
  await page.fill('input[name=leadName]', 'Browser Test Lead');
  await page.fill('input[name=estimatedValue]', '150000');
  await page.click('#leadForm button[type=submit]');
  await page.waitForTimeout(1500);
  step(`lead added → ${await page.$$eval('#tabContent table tbody tr', r => r.length)} leads`);

  await page.click('#tabBar button[data-tab="Pipeline"]');
  await page.waitForTimeout(1300);
  const funnel = await page.$$eval('.funnel-row', r => r.length);
  const cards = await page.$$eval('.kanban-card', r => r.length);
  step(`pipeline: ${funnel} funnel stages, ${cards} board cards`);
  await page.screenshot({ path: '/root/work/shot-crm.png' });

  const firstCard = await page.$('.kanban-card');
  if (firstCard) {
    await firstCard.click();
    await page.waitForTimeout(1000);
    const modalOpen = await page.$('#activeModalBackdrop');
    if (!modalOpen) errors.push('CRM: lead detail modal did not open');
    else {
      await page.selectOption('#stageSelect', 'Contacted');
      await page.click('#stageBtn');
      await page.waitForTimeout(1500);
      step('moved lead to Contacted via modal');
    }
  }
  await page.click('#tabBar button[data-tab="Follow-ups"]');
  await page.waitForTimeout(1000);
  await page.click('#tabBar button[data-tab="Branch Performance"]');
  await page.waitForTimeout(1000);
  step('CRM follow-ups + branch performance rendered');

  // ---- MFinAI ----
  await visit('ai.html', 'MFinAI');
  const chips = await page.$$eval('.chip', c => c.length);
  const insights = await page.$$eval('.insight', i => i.length);
  step(`MFinAI: ${chips} suggestion chips, ${insights} insights`);
  if (insights === 0) errors.push('MFinAI: no insights rendered');

  await page.fill('#questionInput', 'What were my sales this month?');
  await page.click('#askForm button[type=submit]');
  await page.waitForTimeout(1600);
  const answer = await page.$eval('.answer-text', n => n.textContent).catch(() => null);
  if (!answer) errors.push('MFinAI: no answer rendered');
  else step(`answer: ${answer}`);

  await page.click('.chip');
  await page.waitForTimeout(1600);
  step(`chip click answer: ${await page.$eval('.answer-text', n => n.textContent).catch(() => 'none')}`);
  await page.screenshot({ path: '/root/work/shot-ai.png' });

  // ---- mobile layout ----
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(BASE + '/crm.html');
  await page.waitForTimeout(1500);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
  if (overflow) errors.push('mobile: page scrolls horizontally');
  await page.screenshot({ path: '/root/work/shot-mobile.png' });
  step('mobile viewport checked');

  await browser.close();
  console.log('\n' + (errors.length ? 'ERRORS:\n' + errors.join('\n') : 'No console/page errors.'));
  process.exit(errors.length ? 1 : 0);
})();
