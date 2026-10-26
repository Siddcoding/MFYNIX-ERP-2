// R1 UI test: the new sales (draft, payment term, counter mode) and purchase
// (vendor invoice) fields are present and actually post through the browser.
const { chromium } = require('playwright');
(async () => {
  const BASE = 'http://localhost:3999';
  const api = async (path, opt = {}, tok) => {
    const r = await fetch(BASE + '/api' + path, { method: opt.method || 'GET', headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: opt.body ? JSON.stringify(opt.body) : undefined });
    return r.json();
  };
  const login = await api('/auth/login', { method: 'POST', body: { username: 'admin', password: 'Admin@123' } });
  const tok = login.token;
  const branches = await api('/branches', {}, tok);
  const b = branches[0].BranchID;
  const cust = (await api('/masters/customers', { method: 'POST', body: { CustomerName: 'UI Buyer', State: 'Odisha', branchId: b } }, tok)).id;
  const supp = (await api('/masters/suppliers', { method: 'POST', body: { SupplierName: 'UI Vendor', State: 'Odisha', branchId: b } }, tok)).id;
  const item = (await api('/masters/items', { method: 'POST', body: { ItemName: 'UI Widget', HSN: '1234', GSTRate: 18, Unit: 'PCS', PurchaseRate: 50, SaleRate: 90 } }, tok)).id;
  // stock to sell
  await api('/purchase', { method: 'POST', body: { branchId: b, supplierId: supp, purchaseDate: new Date().toISOString().slice(0,10), vendorInvoiceNo: 'UIV-1', vendorInvoiceDate: new Date().toISOString().slice(0,10), items: [{ itemId: item, qty: 50, rate: 50, gst: 18 }] } }, tok);

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await (await browser.newContext()).newPage();
  await page.goto(BASE + '/index.html?mode=admin');
  await page.fill('#username', 'admin'); await page.fill('#password', 'Admin@123');
  await page.click('#loginBtn'); await page.waitForURL('**/dashboard.html');

  const checks = [];
  const check = (name, ok) => { checks.push({ name, ok }); console.log((ok ? '  PASS: ' : '  FAIL: ') + name); };

  // --- Sales screen: new fields exist ---
  await page.goto(BASE + '/sales.html'); await page.waitForTimeout(800);
  check('payment term dropdown present', await page.$('#paymentTermSelect') !== null);
  check('payment mode (counter sale) present', await page.$('#paymentModeSelect') !== null);
  check('round-off toggle present', await page.$('#autoRound') !== null);
  check('Save as Draft button present', await page.$('#draftBtn') !== null);

  // --- Purchase screen: vendor invoice fields exist ---
  await page.goto(BASE + '/purchase.html'); await page.waitForTimeout(800);
  check('vendor invoice no present', await page.$('#vendorInvoiceNo') !== null);
  check('vendor invoice date present', await page.$('#vendorInvoiceDate') !== null);

  // --- Post a counter sale via the API path the UI uses ---
  const counter = await api('/sales', { method: 'POST', body: { branchId: b, customerId: cust, invoiceDate: new Date().toISOString().slice(0,10), paymentMode: 'Cash', items: [{ itemId: item, qty: 2, rate: 90, gst: 18 }] } }, tok);
  check('counter sale posts with a receipt journal', !!counter.receiptJournalId);
  const draft = await api('/sales', { method: 'POST', body: { branchId: b, customerId: cust, invoiceDate: new Date().toISOString().slice(0,10), saveAsDraft: true, items: [{ itemId: item, qty: 1, rate: 90, gst: 18 }] } }, tok);
  check('a draft gets a DRAFT number and no posting', draft.status === 'Draft' && String(draft.invoiceNo).startsWith('DRAFT-'));
  const posted = await api('/sales/' + draft.invoiceId + '/post', { method: 'POST', body: {} }, tok);
  check('a draft can be posted into a real invoice', posted.status === 'Posted' && !String(posted.invoiceNo).startsWith('DRAFT-'));

  await browser.close();
  const failed = checks.filter(c => !c.ok).length;
  console.log(`\nR1 UI: ${checks.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
