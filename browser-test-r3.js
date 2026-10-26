// R3/UI test: Invoicing + Delivery screens load, filters work, and e-invoice /
// e-way bill generate through the UI's API path.
const { chromium } = require('playwright');
(async () => {
  const BASE = 'http://localhost:3999';
  const api = async (p, opt = {}, tok) => (await fetch(BASE + '/api' + p, { method: opt.method || 'GET', headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: opt.body ? JSON.stringify(opt.body) : undefined })).json();
  const tok = (await api('/auth/login', { method: 'POST', body: { username: 'admin', password: 'Admin@123' } })).token;
  const b = (await api('/branches', {}, tok))[0].BranchID;
  const cust = (await api('/masters/customers', { method: 'POST', body: { CustomerName: 'R3 Buyer', GSTIN: '27AAACS2222S1Z3', State: 'Maharashtra', branchId: b } }, tok)).id;
  const item = (await api('/masters/items', { method: 'POST', body: { ItemName: 'R3 Widget', HSN: '7214', GSTRate: 18, Unit: 'PCS', PurchaseRate: 500, SaleRate: 900 } }, tok)).id;
  const sup = (await api('/masters/suppliers', {}, tok))[0].SupplierID;
  await api('/purchase', { method: 'POST', body: { branchId: b, supplierId: sup, purchaseDate: new Date().toISOString().slice(0,10), vendorInvoiceNo: 'R3-1', vendorInvoiceDate: new Date().toISOString().slice(0,10), items: [{ itemId: item, qty: 100, rate: 500, gst: 18 }] } }, tok);
  const inv = await api('/sales', { method: 'POST', body: { branchId: b, customerId: cust, invoiceDate: new Date().toISOString().slice(0,10), items: [{ itemId: item, qty: 80, rate: 900, gst: 18 }] } }, tok);

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await (await browser.newContext()).newPage();
  await page.goto(BASE + '/index.html?mode=admin');
  await page.fill('#username', 'admin'); await page.fill('#password', 'Admin@123');
  await page.click('#loginBtn'); await page.waitForURL('**/dashboard.html');

  const checks = [];
  const ck = (n, ok) => { checks.push(ok); console.log((ok ? '  PASS: ' : '  FAIL: ') + n); };

  // Sidebar has the two new links.
  const nav = await page.$$eval('.sidebar nav a', as => as.map(a => a.getAttribute('href')));
  ck('Delivery link in sidebar', nav.includes('delivery.html'));
  ck('Invoicing link in sidebar', nav.includes('invoicing.html'));

  // Invoicing page loads and lists the invoice.
  await page.goto(BASE + '/invoicing.html'); await page.waitForTimeout(1000);
  ck('Invoicing page shows the invoice', (await page.content()).includes(inv.invoiceNo));
  ck('Invoicing has a party filter', await page.$('#partySelect') !== null);
  ck('Invoicing has customer/vendor tabs', (await page.$$('#tabBar button')).length === 2);

  // Delivery page loads.
  await page.goto(BASE + '/delivery.html'); await page.waitForTimeout(800);
  ck('Delivery page renders', (await page.content()).includes('Deliveries'));

  // E-invoice + e-way bill through the API the UI calls.
  const ei = await api(`/einvoice/sales/${inv.invoiceId}/generate`, { method: 'POST', body: {} }, tok);
  ck('e-invoice generates an IRN', /^[0-9a-f]{64}$/.test(ei.irn || ''));
  const ewb = await api(`/ewaybill/sales/${inv.invoiceId}/generate`, { method: 'POST', body: { distance: 300, vehicleNo: 'OD02AB1234' } }, tok);
  ck('e-way bill generates a number', !!ewb.ewbNo);

  await browser.close();
  const failed = checks.filter(x => !x).length;
  console.log(`\nR3 UI: ${checks.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
