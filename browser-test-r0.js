// R0 exit test: hostile text in every kind of master must render as text, never run.
const { chromium } = require('playwright');
(async () => {
  const BASE = 'http://localhost:3999';
  const P = '<img src=x onerror="window.__xss=1"><script>window.__xss=1</script>"\'>';
  const api = async (path, opt = {}, tok) => {
    const r = await fetch(BASE + '/api' + path, { method: opt.method || 'GET', headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: opt.body ? JSON.stringify(opt.body) : undefined });
    return r.json();
  };
  const login = await api('/auth/login', { method: 'POST', body: { username: 'admin', password: 'Admin@123' } });
  const tok = login.token;
  const branches = await api('/branches', {}, tok);
  const b = branches[0].BranchID;
  await api('/masters/customers', { method: 'POST', body: { CustomerName: 'C' + P, State: 'Odisha', branchId: b, Address: P } }, tok);
  await api('/masters/suppliers', { method: 'POST', body: { SupplierName: 'S' + P, State: 'Odisha', branchId: b } }, tok);
  await api('/masters/items', { method: 'POST', body: { ItemName: 'I' + P, HSN: '1234', GSTRate: 18, branchId: b } }, tok);
  await api('/crm/leads', { method: 'POST', body: { LeadName: 'L' + P, branchId: b } }, tok);
  await api('/branches/users', { method: 'POST', body: { userName: 'xssuser', fullName: 'U' + P, password: 'Xss@12345', roleId: 4, branchId: b } }, tok);

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await (await browser.newContext()).newPage();
  const dialogs = [];
  page.on('dialog', d => { dialogs.push(d.message()); d.dismiss(); });
  await page.goto(BASE + '/index.html?mode=admin');
  await page.fill('#username', 'admin'); await page.fill('#password', 'Admin@123');
  await page.click('#loginBtn'); await page.waitForURL('**/dashboard.html');
  let bad = 0;
  for (const p of ['dashboard', 'masters', 'sales', 'purchase', 'inventory', 'accounts', 'outstanding', 'notes', 'banking', 'reports', 'gst', 'payroll', 'crm', 'branches', 'admin']) {
    await page.goto(`${BASE}/${p}.html`); await page.waitForTimeout(700);
    for (const tab of await page.$$('#tabBar button')) { await tab.click().catch(() => {}); await page.waitForTimeout(250); }
    const x = await page.evaluate(() => window.__xss);
    if (x || dialogs.length) { bad++; console.log('  FAIL: script ran on', p); }
  }
  console.log(bad ? `  FAIL: ${bad} page(s) executed injected script` : '  PASS: hostile names rendered as text on all 15 pages');
  await browser.close(); process.exit(bad ? 1 : 0);
})();
