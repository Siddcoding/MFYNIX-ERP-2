require('dotenv').config();

// ---- Preflight checks: fail with a clear message instead of a cryptic crash ----
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 18) {
  console.error(`\nMfynix requires Node.js 18 or newer. You're running ${process.version}.`);
  console.error(`Install a current LTS version from https://nodejs.org and try again.\n`);
  process.exit(1);
}

// ---- Refuse to run insecurely in production ----
// NODE_ENV=production without a real JWT_SECRET means every session token is
// forgeable, so fail loudly at boot instead of serving a false sense of safety.
const MIN_SECRET_LENGTH = 24;
if (process.env.NODE_ENV === 'production') {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH || /change-this|replace-with|dev-only/i.test(secret)) {
    console.error('\nRefusing to start: JWT_SECRET is missing, too short, or still the placeholder.');
    console.error('Anyone who knows the default can forge a login token for any user.');
    console.error(`Set a random string of at least ${MIN_SECRET_LENGTH} characters, for example:`);
    console.error('  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
    console.error('Then set it as the JWT_SECRET environment variable (or in backend/.env).\n');
    process.exit(1);
  }
} else if (!process.env.JWT_SECRET) {
  console.warn('Warning: JWT_SECRET is not set, using an insecure development secret.');
  console.warn('Set JWT_SECRET (and NODE_ENV=production) before deploying.');
}

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');

let db;
try {
  db = require('./db'); // also runs schema + seed - surface DB init failures here, not deep in a route
} catch (err) {
  console.error('\nFailed to initialize the database.');
  if (String(err.message || '').includes('bindings')) {
    console.error('This usually means better-sqlite3 could not find its native binary for your platform.');
    console.error('Try: cd backend && rm -rf node_modules package-lock.json && npm install\n');
  } else {
    console.error(err.message + '\n');
  }
  process.exit(1);
}

const { router: authRouter } = require('./routes/auth');
const branchesRouter = require('./routes/branches');
const mastersRouter = require('./routes/masters');
const salesRouter = require('./routes/sales');
const purchaseRouter = require('./routes/purchase');
const inventoryRouter = require('./routes/inventory');
const dashboardRouter = require('./routes/dashboard');
const { router: accountsRouter } = require('./routes/accounts');
const gstRouter = require('./routes/gst');
const payrollRouter = require('./routes/payroll');
const crmRouter = require('./routes/crm');
const aiRouter = require('./routes/ai');
const adminRouter = require('./routes/admin');
const outstandingRouter = require('./routes/outstanding');
const notesRouter = require('./routes/notes');
const bankingRouter = require('./routes/banking');
const reportsRouter = require('./routes/reports');
const portalRouter = require('./routes/portal');   // customer self-service portal
const brandingRouter = require('./routes/branding');
const messagingRouter = require('./routes/messaging');
const ordersRouter = require('./routes/orders');
const procurementRouter = require('./routes/procurement');
const dunningRouter = require('./routes/dunning');
const approvalsRouter = require('./routes/approvals');
const einvoiceRouter = require('./routes/einvoice');
const ewaybillRouter = require('./routes/ewaybill');
const backupService = require('./services/backup');

const app = express();
const PORT = process.env.PORT || 3000;

// ---- Behind a hosting proxy (Render, Railway, Fly, Nginx, Cloudflare) ----
// Every platform terminates TLS in front of the app, so without this every
// request appears to come from the proxy's own IP. That is not cosmetic: the
// login rate limiter counts attempts per IP, so ten failed logins from ANY ten
// customers would lock out the entire company. TRUST_PROXY defaults on in
// production and can be set to a number for a specific hop count.
const TRUST_PROXY = process.env.TRUST_PROXY !== undefined
  ? (isNaN(Number(process.env.TRUST_PROXY)) ? process.env.TRUST_PROXY : Number(process.env.TRUST_PROXY))
  : (process.env.NODE_ENV === 'production' ? 1 : false);
if (TRUST_PROXY !== false) app.set('trust proxy', TRUST_PROXY);

// PLT-04: a real content security policy. The bundled pages use inline scripts
// and styles, so 'unsafe-inline' stays for those two, but nothing may load from
// or talk to any other origin, no page may be framed, and plugins/base-URI/form
// targets are locked. Escaping every rendered value is the primary defence
// against script injection; this is the second line.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      fontSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"]
    }
  }
}));

// Cross-origin access is limited to the product's own addresses. The app serves
// its own frontend, so same-origin calls need no CORS at all; ALLOWED_ORIGINS
// (comma-separated) lists any extra origin, e.g. a separate customer-portal host.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, false);                 // same-origin / non-browser: no CORS headers needed
    cb(null, ALLOWED_ORIGINS.includes(origin));
  }
}));
// 12mb, not 2mb: a bulk import posts the spreadsheet as base64 inside the JSON
// body, and base64 inflates it by a third. A few thousand rows sits well inside
// this; anything larger belongs in a staged migration rather than a browser
// upload, and the importer says so instead of failing with a bare 413.
app.use(express.json({ limit: '12mb' }));
app.use(morgan('tiny'));

// ---- API routes ----
app.use('/api/auth', authRouter);
app.use('/api/branches', branchesRouter);
app.use('/api/masters', mastersRouter);
app.use('/api/sales', salesRouter);
app.use('/api/purchase', purchaseRouter);
app.use('/api/inventory', inventoryRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/accounts', accountsRouter);
app.use('/api/gst', gstRouter);
app.use('/api/payroll', payrollRouter);
app.use('/api/crm', crmRouter);
app.use('/api/ai', aiRouter);
app.use('/api/admin', adminRouter);
app.use('/api/outstanding', outstandingRouter);
app.use('/api/notes', notesRouter);
app.use('/api/banking', bankingRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/portal', portalRouter);
app.use('/api/branding', brandingRouter);
app.use('/api/messaging', messagingRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/procurement', procurementRouter);
app.use('/api/dunning', dunningRouter);
app.use('/api/approvals', approvalsRouter);
app.use('/api/einvoice', einvoiceRouter);
app.use('/api/ewaybill', ewaybillRouter);

// Health check. Hosting platforms poll this to decide whether a deploy is live,
// so it reports the database as well - a process that is up but cannot read its
// own data is not healthy, and a green tick on it would be a lie.
app.get('/api/health', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok', database: 'ok', time: new Date().toISOString() });
  } catch (e) {
    res.status(503).json({ status: 'degraded', database: 'unreachable', time: new Date().toISOString() });
  }
});

// ---- Serve the frontend (same origin -> no CORS issues on any device) ----
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');
app.use(express.static(FRONTEND_DIR));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

// ---- Error handler ----
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(PORT, () => {
  backupService.startScheduler();
  console.log(`Mfynix backend running on port ${PORT}`);
  console.log(`Open http://localhost:${PORT} in your browser (don't open the HTML files directly).`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use.`);
    console.error(`Either stop whatever is using it, or set a different port:`);
    console.error(`  - create/edit backend/.env and set PORT=3001, then run npm start again`);
    console.error(`  (this works the same way on Windows, Mac, and Linux)\n`);
  } else {
    console.error('Server failed to start:', err);
  }
  process.exit(1);
});
