// Shared helpers used across every page. Kept dependency-free so the app
// runs reliably on any device/browser without a build step.

// ---------------- Theme ----------------
// Applied to <html> immediately on script load, before anything paints, so the
// user never sees the default palette flash before their chosen one.
const THEMES = [
  { id: 'mfynix', name: 'Mfynix Blue', desc: 'The brand palette. The default.', colors: ['#1d4ed8', '#0ea5e9', '#0c4a6e'] },
  { id: 'ember', name: 'Ember', desc: 'Warm graphite and amber.', colors: ['#b45309', '#9a3412', '#713f12'] },
  { id: 'teal', name: 'Deep Teal', desc: 'Calm and cool.', colors: ['#0d9488', '#0369a1', '#15803d'] },
  { id: 'midnight', name: 'Midnight', desc: 'The original blue and violet.', colors: ['#3b82f6', '#8b5cf6', '#ec4899'] },
  { id: 'plum', name: 'Royal Plum', desc: 'Warmer, higher contrast.', colors: ['#7e22ce', '#be185d', '#4338ca'] },
  { id: 'daylight', name: 'Daylight', desc: 'A true light theme for bright rooms.', colors: ['#60a5fa', '#a78bfa', '#34d399'] },
  { id: 'carbon', name: 'Carbon', desc: 'Near-monochrome, no distractions.', colors: ['#3f3f46', '#52525b', '#71717a'] },
  { id: 'forest', name: 'Forest', desc: 'Deep green, easy on long days.', colors: ['#166534', '#065f46', '#3f6212'] },
  { id: 'rosewood', name: 'Rosewood', desc: 'Burgundy and rose, warm and formal.', colors: ['#9f1239', '#7c2d12', '#831843'] },
  { id: 'slate', name: 'Slate', desc: 'Cool grey-blue. Quiet and neutral.', colors: ['#334155', '#475569', '#1e293b'] },
  { id: 'sandstone', name: 'Sandstone', desc: 'A warm light theme for paper-heavy work.', colors: ['#d97706', '#a16207', '#b45309'] },
  { id: 'contrast', name: 'High Contrast', desc: 'Maximum legibility. Built for difficult lighting.', colors: ['#ffffff', '#ffd400', '#00e5ff'] }
];
const DEFAULT_THEME = 'mfynix';

// A theme is only "sticky" once somebody has actually picked one in Settings.
// Without that distinction, changing the shipped default would have no effect
// on anyone who had ever loaded the app before, because the old default was
// written to localStorage on first paint and then looked like a choice.
function getTheme() {
  try {
    const chosen = localStorage.getItem('mf_theme_chosen') === '1';
    const stored = localStorage.getItem('mf_theme');
    return chosen && stored ? stored : DEFAULT_THEME;
  } catch (e) { return DEFAULT_THEME; }
}
function applyTheme(id, { remember = false } = {}) {
  const theme = THEMES.some(t => t.id === id) ? id : DEFAULT_THEME;
  document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem('mf_theme', theme);
    if (remember) localStorage.setItem('mf_theme_chosen', '1');
  } catch (e) { /* private mode - the theme just won't persist */ }
  return theme;
}
// What the Settings theme picker calls: same thing, but it counts as a choice.
function chooseTheme(id) { return applyTheme(id, { remember: true }); }
applyTheme(getTheme());

/* =========================================================================
   BRANDING
   The product is Mfynix. Its mark ships with the app and is what every screen
   shows by default, so a fresh install looks like a product rather than a
   template. A company that uploads its own logo under Settings -> Company
   replaces it everywhere - sidebar, splash and printed documents - because a
   customer sending an invoice to THEIR customer should be sending their own
   letterhead, not their software vendor's.

   The logo is cached in sessionStorage: it is a data URL of up to a few
   hundred KB and every page in the app draws it, so re-fetching it on each
   navigation would be a visible cost for something that changes once a year.
   ========================================================================= */
const MFYNIX_LOGO = 'img/mfynix-logo.png';   // full lockup: mark + wordmark + tagline
const MFYNIX_MARK = 'img/mfynix-mark.png';   // the mark alone, for tight spaces
const BRAND_CACHE_KEY = 'mf_branding';

function cachedBranding() {
  try {
    const raw = sessionStorage.getItem(BRAND_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

// Returns the logo to draw right now, without waiting for the network: the
// cached company logo if we have one, otherwise the Mfynix mark. Screens that
// want the company's logo the moment it is known call loadBranding() as well.
function brandLogoSrc({ full = false } = {}) {
  const b = cachedBranding();
  if (b && b.logoDataUrl) return b.logoDataUrl;
  return full ? MFYNIX_LOGO : MFYNIX_MARK;
}

function brandIsCustom() {
  const b = cachedBranding();
  return !!(b && b.logoDataUrl);
}

/**
 * Fetch the company's branding once per browser session and update anything
 * already on the page. Safe to call from every screen.
 */
async function loadBranding({ force = false } = {}) {
  if (!Auth.getToken()) return null;
  const cached = cachedBranding();
  if (cached && !force) return cached;
  try {
    const b = await api('/branding');
    try { sessionStorage.setItem(BRAND_CACHE_KEY, JSON.stringify(b)); } catch (e) { /* private mode */ }
    applyBranding(b);
    return b;
  } catch (e) {
    return cached;   // a branding failure must never stop a page rendering
  }
}

// Point every logo slot on the page at whatever the current branding is.
function applyBranding(b) {
  const src = (b && b.logoDataUrl) || MFYNIX_MARK;
  document.querySelectorAll('[data-brand-logo]').forEach(img => { img.src = src; });
  if (b && b.companyName) {
    document.querySelectorAll('[data-brand-name]').forEach(n => { n.textContent = b.companyName; });
  }
}

// Clearing the cache on logout matters on a shared machine: the next person to
// sign in must not see the previous company's logo.
function clearBrandingCache() {
  try { sessionStorage.removeItem(BRAND_CACHE_KEY); } catch (e) { /* nothing to do */ }
}

// ---------------- Splash screen ----------------
// Shown while the first screen loads. Pages call hideSplash() once their
// content is on the page; a timeout is the safety net so a failed request can
// never leave someone staring at the splash forever.
const APP_SLOGAN = 'Smarter ERP. Faster Growth.';

function showSplash() {
  if (document.getElementById('appSplash')) return;
  const splash = document.createElement('div');
  splash.id = 'appSplash';
  splash.innerHTML = `
    <div class="splash-mark">
      <span class="splash-ring"></span>
      <span class="splash-ring inner"></span>
      <img class="splash-logo" data-brand-logo src="${brandLogoSrc()}" alt="" />
    </div>
    <div class="splash-title">${brandIsCustom() ? '<span data-brand-name></span>' : 'Mfynix <span>ERP</span>'}</div>
    <div class="splash-slogan">${APP_SLOGAN}</div>
    <div class="splash-bar"><i></i></div>`;
  (document.body || document.documentElement).appendChild(splash);
  // Only once it is in the document - applyBranding walks the DOM, so calling
  // it against a detached node would silently do nothing.
  const cached = cachedBranding();
  if (cached) applyBranding(cached);
  // Safety net: never trap the user behind the splash.
  setTimeout(hideSplash, 6000);
}
function hideSplash() {
  const splash = document.getElementById('appSplash');
  if (!splash || splash.classList.contains('hiding')) return;
  splash.classList.add('hiding');
  setTimeout(() => splash.remove(), 500);
}
// Put it up as early as possible - before DOMContentLoaded if the body exists.
if (document.body) showSplash();
else document.addEventListener('DOMContentLoaded', showSplash, { once: true });

// Pages that don't build the app shell (login, forgot-password, the printable
// invoice) still need the splash lifted once they've painted.
window.addEventListener('load', () => setTimeout(hideSplash, 350), { once: true });

// ---------------- HTML escaping ----------------
// Every value that came from the database or a user must go through esc()
// before it is placed in an HTML template (PLT-04). Escapes the five characters
// that matter in both element and attribute contexts.
function esc(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const escapeHtml = esc;

const API_BASE = '/api';


const Auth = {
  getToken() { return localStorage.getItem('mf_token'); },
  getUser() {
    const raw = localStorage.getItem('mf_user');
    return raw ? JSON.parse(raw) : null;
  },
  setSession(token, user) {
    localStorage.setItem('mf_token', token);
    localStorage.setItem('mf_user', JSON.stringify(user));
  },
  clear() {
    localStorage.removeItem('mf_token');
    localStorage.removeItem('mf_user');
  },
  requireLogin() {
    if (!this.getToken()) window.location.href = '/index.html';
  },
  logout() {
    this.clear();
    clearBrandingCache();
    window.location.href = '/index.html';
  }
};

async function api(path, { method = 'GET', body, params } = {}) {
  let url = API_BASE + path;
  if (params) {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
    const qsStr = qs.toString();
    if (qsStr) url += '?' + qsStr;
  }
  const headers = { 'Content-Type': 'application/json' };
  const token = Auth.getToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch (networkErr) {
    throw new Error('Could not reach the server. Make sure the backend is running (npm start) and you opened this page via http://localhost:3000, not as a local file.');
  }

  // A 401 while holding a token means the session has gone. A 401 with no
  // token is just a failed sign-in attempt, and reporting that as "session
  // expired" told people the opposite of what had happened - the server's own
  // message ("Invalid email or password") is the useful one.
  if (res.status === 401 && token) {
    Auth.clear();
    if (!window.location.pathname.endsWith('index.html') && window.location.pathname !== '/') {
      window.location.href = '/index.html';
    }
    throw new Error('Session expired. Please log in again.');
  }

  const data = await res.json().catch(() => ({}));
  // A forced password change (first sign-in, or after an admin reset) blocks
  // every other call until it is done: send the user to the screen that does it.
  if (res.status === 403 && data.mustChangePassword) {
    if (!window.location.pathname.endsWith('index.html')) window.location.href = '/index.html?mustchange=1';
    throw new Error(data.error);
  }
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function fmtMoney(n) {
  const num = Number(n || 0);
  return '₹' + num.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

function fmtDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-IN');
}

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

// ---------------- Toast notifications ----------------
// Usage: toast('Saved successfully', 'success') / toast('Something failed', 'error') / toast('Heads up')
function ensureToastContainer() {
  let c = document.getElementById('toastContainer');
  if (!c) {
    c = document.createElement('div');
    c.id = 'toastContainer';
    document.body.appendChild(c);
  }
  return c;
}

const TOAST_ICONS = { success: '✅', error: '⚠️', info: 'ℹ️' };

function toast(message, type = 'info', duration = 4200) {
  const container = ensureToastContainer();
  const node = el(`
    <div class="toast ${type}">
      <span class="toast-icon">${TOAST_ICONS[type] || TOAST_ICONS.info}</span>
      <span class="toast-msg"></span>
      <button class="toast-close" aria-label="Dismiss">&times;</button>
    </div>
  `);
  node.querySelector('.toast-msg').textContent = message;
  container.appendChild(node);

  const remove = () => {
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 180);
  };
  node.querySelector('.toast-close').addEventListener('click', remove);
  if (duration) setTimeout(remove, duration);
  return node;
}

// ---------------- Button loading state ----------------
// Wraps an async submit handler so the button shows a spinner and disables
// itself while the request is in flight, and always restores afterward.
function withLoading(button, fn) {
  return async (...args) => {
    const original = button.innerHTML;
    button.disabled = true;
    button.innerHTML = `<span class="spinner"></span>${button.dataset.loadingText || 'Working...'}`;
    try {
      await fn(...args);
    } finally {
      button.disabled = false;
      button.innerHTML = original;
    }
  };
}

// ---------------- Lightweight modal ----------------
// Returns the modal element; caller fills #modal-body and wires its own buttons.
function openModal(titleHtml, bodyHtml) {
  closeModal();
  const backdrop = el(`
    <div class="modal-backdrop" id="activeModalBackdrop">
      <div class="modal">
        <h2>${titleHtml}</h2>
        <div id="modal-body">${bodyHtml}</div>
      </div>
    </div>
  `);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });
  document.body.appendChild(backdrop);
  return backdrop;
}
function closeModal() {
  const existing = document.getElementById('activeModalBackdrop');
  if (existing) existing.remove();
}

// Renders the sidebar + topbar shell around whatever page content is passed.
// Every internal page calls this once on load, then fills #page-content.
function renderShell(activeKey) {
  const user = Auth.getUser();
  if (!user) { Auth.requireLogin(); return; }

  // A customer signed into the self-service portal has no business rendering
  // the ERP shell. Without this they got a full sidebar that 403'd on every
  // request - a broken screen instead of a redirect to the one they can use.
  if (user.kind === 'customer') { window.location.href = 'portal.html'; return; }

  const nav = [
    ['dashboard', 'dashboard.html', 'Dashboard'],
    ['masters', 'masters.html', 'Masters'],
    ['sales', 'sales.html', 'Sales'],
    ['delivery', 'delivery.html', 'Delivery'],
    ['invoicing', 'invoicing.html', 'Invoicing'],
    ['purchase', 'purchase.html', 'Purchase'],
    ['inventory', 'inventory.html', 'Inventory'],
    ['accounts', 'accounts.html', 'Accounts'],
    ['outstanding', 'outstanding.html', 'Outstanding'],
    ['notes', 'notes.html', 'Credit / Debit Notes'],
    ['banking', 'banking.html', 'Banking'],
    ['reports', 'reports.html', 'Reports'],
    ['gst', 'gst.html', 'GST Filing'],
    ['payroll', 'payroll.html', 'Payroll'],
    ['crm', 'crm.html', 'CRM'],
    ['ai', 'ai.html', 'MFinAI'],
    ['branches', 'branches.html', 'Branches & Users'],
    ['admins', 'admins.html', 'Admins & Access'],
    ['admin', 'admin.html', 'Settings'],
  ].filter(([key]) => {
    // Mirrors the server-side role checks in routes/*.js. The server is the
    // real gate - this only avoids showing a link that would come back 403.
    if (key === 'accounts' || key === 'gst') return ['Super Admin', 'Company Admin', 'Accountant', 'Auditor'].includes(user.role);
    if (key === 'payroll') return ['Super Admin', 'Company Admin', 'Accountant', 'Branch Manager', 'Auditor'].includes(user.role);
    if (key === 'crm') return ['Super Admin', 'Company Admin', 'Branch Manager', 'Sales Executive', 'Auditor'].includes(user.role);
    if (key === 'admin') return ['Super Admin', 'Company Admin', 'Auditor'].includes(user.role);
    if (key === 'admins') return ['Super Admin', 'Company Admin'].includes(user.role);
    if (key === 'outstanding') return ['Super Admin', 'Company Admin', 'Accountant', 'Branch Manager', 'Auditor', 'Cashier'].includes(user.role);
    if (key === 'notes') return ['Super Admin', 'Company Admin', 'Accountant', 'Branch Manager', 'Auditor'].includes(user.role);
    if (key === 'banking') return ['Super Admin', 'Company Admin', 'Accountant', 'Auditor'].includes(user.role);
    if (key === 'reports') return ['Super Admin', 'Company Admin', 'Accountant', 'Branch Manager', 'Auditor', 'Store Manager'].includes(user.role);
    if (key === 'delivery') return ['Super Admin', 'Company Admin', 'Branch Manager', 'Store Manager', 'Sales Executive'].includes(user.role);
    if (key === 'invoicing') return ['Super Admin', 'Company Admin', 'Accountant', 'Branch Manager', 'Sales Executive', 'Auditor'].includes(user.role);
    return true;
  });

  const shell = el(`
    <div class="app-shell">
      <aside class="sidebar" id="sidebar">
        <div class="brand">
          <img class="brand-logo" data-brand-logo src="${brandLogoSrc()}" alt="" />
          <div><span data-brand-name>${esc(user.companyName)}</span><small>Powered by Mfynix</small></div>
        </div>
        <div class="scope-badge">
          <span class="pill">${esc(user.role)}</span><br/><span style="margin-top:6px;display:inline-block;">${esc(user.branchName)}</span>
        </div>
        <nav>
          ${nav.map(([key, href, label]) => `<a href="${href}" class="${key === activeKey ? 'active' : ''}"><span class="nav-label">${label}</span></a>`).join('')}
        </nav>
      </aside>
      <div class="main">
        <div class="topbar">
          <div style="display:flex;align-items:center;gap:10px;">
            <button class="hamburger" id="hamburgerBtn">&#9776;</button>
            <h1>${esc(user.companyName)}</h1>
          </div>
          <div class="user-chip">
            <span class="user-name">${esc(user.fullName || user.userName)}</span>
            <button class="btn secondary" id="changePwBtn">Password</button>
            <button class="btn secondary" id="logoutBtn">Log out</button>
          </div>
        </div>
        <div class="content" id="page-content"></div>
      </div>
    </div>
  `);

  document.body.prepend(shell);
  document.getElementById('logoutBtn').addEventListener('click', () => Auth.logout());
  document.getElementById('changePwBtn').addEventListener('click', openChangePassword);
  document.getElementById('hamburgerBtn').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('open');
  });
  // Close the mobile sidebar when a nav link is tapped
  document.querySelectorAll('.sidebar nav a').forEach(a => {
    a.addEventListener('click', () => document.getElementById('sidebar').classList.remove('open'));
  });

  loadBranding();
  initAuroraBackground();
  initMorphingSidebar();
  attachHoverEffects();
  initRipples();
  initNavIndicator();
  initPageTransitions();
  observeContent();

  // The shell is on the page; give the page's own content one frame to render
  // underneath, then lift the splash.
  setTimeout(hideSplash, 450);
}

/* =========================================================================
   Visual effects engine: aurora background, morphing sidebar, 3D tilt +
   spotlight hover, animated counters, radial progress, mini-sankey, and a
   transaction-success burst. Kept dependency-free (vanilla JS/CSS only).
   ========================================================================= */

// ---- Aurora background: soft animated color blobs behind everything ----
// Three layers, back to front: a drifting perspective grid, the colour blobs,
// and a fine noise wash to stop the gradients banding on cheap monitors.
function initAuroraBackground() {
  if (document.getElementById('auroraBg')) return;
  const aurora = el(`
    <div id="auroraBg" class="aurora-bg" aria-hidden="true">
      <span class="aurora-blob b1"></span>
      <span class="aurora-blob b2"></span>
      <span class="aurora-blob b3"></span>
      <span class="aurora-blob b4"></span>
    </div>
  `);
  document.body.prepend(aurora);
  document.body.prepend(el('<div class="aurora-noise" aria-hidden="true"></div>'));
  document.body.prepend(el('<div class="aurora-grid" aria-hidden="true"></div>'));
}

/* ---- Reduced motion -----------------------------------------------------
   Checked in JS as well as CSS, because a few effects here are driven by
   requestAnimationFrame and a media query can't switch those off.          */
function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/* ---- Click ripple on every button --------------------------------------
   Bound once at the document level rather than per button, so buttons that
   are rendered later (which is most of them) get it for free.             */
function initRipples() {
  if (document.body.dataset.ripples === '1') return;
  document.body.dataset.ripples = '1';
  document.addEventListener('pointerdown', (e) => {
    if (prefersReducedMotion()) return;
    const btn = e.target.closest && e.target.closest('button.btn');
    if (!btn || btn.disabled) return;
    const rect = btn.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const ink = document.createElement('span');
    ink.className = 'ripple';
    ink.style.width = ink.style.height = size + 'px';
    ink.style.left = (e.clientX - rect.left - size / 2) + 'px';
    ink.style.top = (e.clientY - rect.top - size / 2) + 'px';
    btn.appendChild(ink);
    setTimeout(() => ink.remove(), 600);
  });
}

/* ---- Sliding indicator behind the active sidebar link ------------------ */
function initNavIndicator() {
  const nav = document.querySelector('.sidebar nav');
  if (!nav || nav.querySelector('.nav-indicator')) return;
  const indicator = el('<span class="nav-indicator" aria-hidden="true"></span>');
  nav.prepend(indicator);

  const moveTo = (link) => {
    if (!link) { indicator.classList.remove('ready'); return; }
    indicator.style.height = link.offsetHeight + 'px';
    indicator.style.transform = `translateY(${link.offsetTop}px)`;
    indicator.classList.add('ready');
  };

  const active = nav.querySelector('a.active');
  // One frame's grace so layout has settled and the first move isn't animated
  // from position zero.
  requestAnimationFrame(() => moveTo(active));

  nav.querySelectorAll('a').forEach(a => {
    a.addEventListener('mouseenter', () => moveTo(a));
  });
  nav.addEventListener('mouseleave', () => moveTo(active));
}

/* ---- Page transition ---------------------------------------------------
   Fades the content out on an internal navigation so the next page doesn't
   arrive as a white flash. Deliberately short - 140ms - because a transition
   the user has to wait for is worse than no transition.                    */
function initPageTransitions() {
  if (document.body.dataset.pageFx === '1') return;
  document.body.dataset.pageFx = '1';
  document.addEventListener('click', (e) => {
    if (prefersReducedMotion()) return;
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('http') || a.target === '_blank' || a.hasAttribute('download')) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;   // let the user open a new tab
    e.preventDefault();
    document.body.classList.add('page-leaving');
    setTimeout(() => { window.location.href = href; }, 140);
  });
}

/* ---- Skeleton placeholder markup, for panels whose data is in flight ---- */
function skeletonRows(rows = 5, cols = 4) {
  return `<div class="skeleton-block">${Array.from({ length: rows }, () =>
    `<div class="skeleton-row">${Array.from({ length: cols }, () => '<span class="skeleton"></span>').join('')}</div>`
  ).join('')}</div>`;
}

/* ---- Re-animate a value that has changed in place ---------------------- */
function bumpValue(node) {
  if (!node || prefersReducedMotion()) return;
  node.classList.remove('value-bump');
  void node.offsetWidth;         // force reflow so the animation restarts
  node.classList.add('value-bump');
}

/* ---- Mark a table for the staggered row entrance ----------------------- */
function animateTables(root = document) {
  root.querySelectorAll('table').forEach(t => t.classList.add('table-anim'));
}

/* ---- Watch the page content and decorate whatever appears --------------
   Every module renders its own HTML into #page-content at different times.
   Rather than editing sixteen pages to call animateTables() and
   attachHoverEffects() after each render, one observer picks up anything new.
   Only childList mutations are watched, and the decorations themselves only
   set classes and data attributes, so this cannot loop.                    */
function observeContent() {
  const target = document.getElementById('page-content');
  if (!target || target.dataset.observed === '1' || typeof MutationObserver === 'undefined') return;
  target.dataset.observed = '1';

  let queued = false;
  const decorate = () => {
    queued = false;
    animateTables(target);
    attachHoverEffects();
  };
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(decorate);
  }).observe(target, { childList: true, subtree: true });
}

// ---- Morphing sidebar: desktop collapse/expand with a smooth width morph ----
function initMorphingSidebar() {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar || document.getElementById('sidebarMorphBtn')) return;

  const btn = el(`<button id="sidebarMorphBtn" class="sidebar-morph-btn" title="Collapse sidebar">&#8249;</button>`);
  sidebar.appendChild(btn);

  const collapsed = localStorage.getItem('mf_sidebar_collapsed') === '1';
  if (collapsed) { sidebar.classList.add('collapsed'); btn.innerHTML = '&#8250;'; }

  btn.addEventListener('click', () => {
    const isCollapsed = sidebar.classList.toggle('collapsed');
    btn.innerHTML = isCollapsed ? '&#8250;' : '&#8249;';
    localStorage.setItem('mf_sidebar_collapsed', isCollapsed ? '1' : '0');
  });
}

// ---- 3D tilt + cursor spotlight, applied to cards/kpi-cards ----
function attachHoverEffects(selector = '.card, .kpi-card, .step-card') {
  document.querySelectorAll(selector).forEach(node => {
    if (node.dataset.hoverFx) return; // avoid double-binding on re-render
    node.dataset.hoverFx = '1';
    node.classList.add('fx-tilt');

    node.addEventListener('mousemove', (e) => {
      const rect = node.getBoundingClientRect();
      const px = (e.clientX - rect.left) / rect.width;   // 0..1
      const py = (e.clientY - rect.top) / rect.height;   // 0..1
      const rotateY = (px - 0.5) * 8;   // deg
      const rotateX = (0.5 - py) * 8;   // deg
      node.style.setProperty('--mx', `${px * 100}%`);
      node.style.setProperty('--my', `${py * 100}%`);
      node.style.transform = `perspective(700px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) translateY(-2px)`;
    });
    node.addEventListener('mouseleave', () => {
      node.style.transform = '';
      node.style.setProperty('--mx', `50%`);
      node.style.setProperty('--my', `50%`);
    });
  });
}

// ---- Animated count-up for KPI numbers ----
// formatFn receives the in-progress numeric value and returns display text.
function animateCounter(node, targetValue, formatFn = (v) => Math.round(v).toLocaleString('en-IN'), duration = 900) {
  const start = performance.now();
  const from = 0;
  function tick(now) {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3); // ease-out-cubic
    const value = from + (targetValue - from) * eased;
    node.textContent = formatFn(value);
    if (t < 1) requestAnimationFrame(tick);
    else node.textContent = formatFn(targetValue);
  }
  requestAnimationFrame(tick);
}

// ---- Radial progress ring (SVG) ----
// Returns an HTML string; percent is 0-100.
function radialProgressSvg(percent, { size = 96, stroke = 9, label = '', color = 'var(--primary)' } = {}) {
  const clamped = Math.max(0, Math.min(100, percent));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - clamped / 100);
  const uid = 'rg' + Math.random().toString(36).slice(2, 8);
  return `
    <div class="radial-progress" style="width:${size}px;height:${size}px;">
      <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
        <circle cx="${size/2}" cy="${size/2}" r="${r}" fill="none" stroke="var(--border)" stroke-width="${stroke}"/>
        <circle id="${uid}" cx="${size/2}" cy="${size/2}" r="${r}" fill="none" stroke="${color}"
          stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${c}"
          stroke-dashoffset="${c}" transform="rotate(-90 ${size/2} ${size/2})"
          class="radial-progress-arc" data-target-offset="${offset}"/>
      </svg>
      <div class="radial-progress-label">
        <div class="radial-progress-value">${Math.round(clamped)}%</div>
        ${label ? `<div class="radial-progress-sub">${label}</div>` : ''}
      </div>
    </div>`;
}
// Call after inserting radialProgressSvg's HTML into the DOM to animate the fill.
function animateRadialProgress(container) {
  container.querySelectorAll('.radial-progress-arc').forEach(arc => {
    const target = arc.dataset.targetOffset;
    requestAnimationFrame(() => {
      arc.style.transition = 'stroke-dashoffset 1.1s cubic-bezier(0.22,1,0.36,1)';
      arc.style.strokeDashoffset = target;
    });
  });
}

// ---- Mini cash-flow Sankey (hand-rolled SVG, 3 stages: Purchase -> Stock -> Sales, with GST split) ----
// values: { purchase, sales, gst } — all non-negative numbers.
function miniSankeySvg(values, { width = 640, height = 200 } = {}) {
  const purchase = Math.max(0, values.purchase || 0);
  const sales = Math.max(0, values.sales || 0);
  const gst = Math.max(0, values.gst || 0);
  const max = Math.max(purchase, sales, gst, 1);

  const bandTop = 30, bandBottom = height - 30;
  const scale = (v) => Math.max(6, ((bandBottom - bandTop) * v) / max);

  const xPurchase = 20, xStock = width / 2 - 40, xSales = width - 140;
  const hPurchase = scale(purchase), hStock = scale((purchase + sales) / 2), hSales = scale(sales), hGst = scale(gst);

  const yP = bandTop + (bandBottom - bandTop - hPurchase) / 2;
  const yStk = bandTop + (bandBottom - bandTop - hStock) / 2;
  const ySales = bandTop + (bandBottom - bandTop - hSales) / 2;
  const yGst = bandBottom - hGst;

  function flowPath(x1, y1, h1, x2, y2, h2) {
    const midX = (x1 + x2) / 2;
    return `M${x1},${y1} C${midX},${y1} ${midX},${y2} ${x2},${y2}
            L${x2},${y2 + h2} C${midX},${y2 + h2} ${midX},${y1 + h1} ${x1},${y1 + h1} Z`;
  }

  return `
  <svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" class="sankey-svg">
    <defs>
      <linearGradient id="sankeyFlow1" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#7c5cff" stop-opacity="0.55"/>
        <stop offset="100%" stop-color="#2563eb" stop-opacity="0.55"/>
      </linearGradient>
      <linearGradient id="sankeyFlow2" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#2563eb" stop-opacity="0.55"/>
        <stop offset="100%" stop-color="#16a34a" stop-opacity="0.55"/>
      </linearGradient>
      <linearGradient id="sankeyFlow3" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#16a34a" stop-opacity="0.5"/>
        <stop offset="100%" stop-color="#f59e0b" stop-opacity="0.5"/>
      </linearGradient>
    </defs>
    <path d="${flowPath(xPurchase + 18, yP, hPurchase, xStock, yStk, hStock)}" fill="url(#sankeyFlow1)" class="sankey-flow" />
    <path d="${flowPath(xStock + 18, yStk, hStock, xSales, ySales, hSales)}" fill="url(#sankeyFlow2)" class="sankey-flow" />
    <path d="${flowPath(xSales + 18, ySales, hSales * 0.35, xSales + 120, yGst, hGst)}" fill="url(#sankeyFlow3)" class="sankey-flow" />

    <rect x="${xPurchase}" y="${yP}" width="18" height="${hPurchase}" rx="4" fill="#7c5cff"/>
    <rect x="${xStock}" y="${yStk}" width="18" height="${hStock}" rx="4" fill="#2563eb"/>
    <rect x="${xSales}" y="${ySales}" width="18" height="${hSales}" rx="4" fill="#16a34a"/>
    <rect x="${xSales + 120}" y="${yGst}" width="18" height="${hGst}" rx="4" fill="#f59e0b"/>

    <text x="${xPurchase}" y="${yP - 10}" class="sankey-label">Purchases</text>
    <text x="${xStock}" y="${yStk - 10}" class="sankey-label">Stock Flow</text>
    <text x="${xSales}" y="${ySales - 10}" class="sankey-label">Sales</text>
    <text x="${xSales + 120}" y="${yGst - 10}" class="sankey-label">GST Collected</text>
  </svg>`;
}

// ---- Transaction success animation: brief center-screen checkmark burst ----
function showSuccessBurst(message = 'Success') {
  const overlay = el(`
    <div class="success-burst-overlay">
      <div class="success-burst-card">
        <svg class="success-check" viewBox="0 0 52 52">
          <circle class="success-check-circle" cx="26" cy="26" r="24" fill="none"/>
          <path class="success-check-mark" fill="none" d="M14 27l7 7 16-16"/>
        </svg>
        <div class="success-burst-text"></div>
      </div>
    </div>
  `);
  overlay.querySelector('.success-burst-text').textContent = message;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('show'));
  setTimeout(() => {
    overlay.classList.add('hide');
    setTimeout(() => overlay.remove(), 350);
  }, 1400);
}

// ---------------- Shared helpers for the reporting modules ----------------

// Current month as YYYY-MM, the period format every report endpoint expects.
function currentPeriod() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Renders an array of plain objects as a table. `columns` is a list of
// { key, label, align } - or omit it and the object's own keys are used.
function renderTable(rows, columns, emptyMessage = 'Nothing to show yet.') {
  if (!rows || rows.length === 0) return `<p class="muted">${emptyMessage}</p>`;
  const cols = columns || Object.keys(rows[0]).map(k => ({ key: k, label: k }));
  return `
    <div style="overflow-x:auto;">
      <table>
        <thead><tr>${cols.map(c => `<th${c.align ? ` style="text-align:${c.align}"` : ''}>${esc(c.label)}</th>`).join('')}</tr></thead>
        <tbody>${rows.map(r => `<tr>${cols.map(c => {
          const raw = c.render ? c.render(r) : r[c.key];
          const html = c.render ? raw : esc(raw);
          return `<td${c.align ? ` style="text-align:${c.align}"` : ''}>${html}</td>`;
        }).join('')}</tr>`).join('')}</tbody>
      </table>
    </div>`;
}

// Downloads a file from an authenticated API endpoint. A plain <a href> can't
// be used because the API needs the Bearer token, so the body is fetched and
// handed to the browser as a blob instead.
async function apiDownload(path, params, filename) {
  let url = API_BASE + path;
  if (params) {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
    if (qs.toString()) url += '?' + qs.toString();
  }
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + Auth.getToken() } });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Download failed');
  }
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

// Standard tab bar used by the reporting modules. Calls onChange(tabName).
function buildTabBar(container, tabs, active, onChange) {
  container.innerHTML = '';
  tabs.forEach(t => {
    const btn = el(`<button class="btn ${t === active ? '' : 'secondary'}" data-tab="${t}">${t}</button>`);
    btn.addEventListener('click', () => {
      active = t;
      container.querySelectorAll('button').forEach(b => b.classList.toggle('secondary', b.dataset.tab !== active));
      onChange(t);
    });
    container.appendChild(btn);
  });
}

// Head-office users get a branch selector; branch users get a static label,
// because their scope is fixed server-side regardless of what they pick.
async function buildBranchFilter(wrap, onChange, { allLabel = 'All Branches (Consolidated)' } = {}) {
  const user = Auth.getUser();
  if (user.branchId) {
    wrap.innerHTML = `<p class="muted">Showing data for <strong>${esc(user.branchName)}</strong>.</p>`;
    return [];
  }
  const branches = await api('/branches');
  wrap.innerHTML = `
    <label>Branch</label>
    <select id="branchFilter" style="max-width:320px;">
      <option value="">${allLabel}</option>
      ${branches.map(b => `<option value="${esc(b.BranchID)}">${esc(b.BranchName)} (${esc(b.BranchCode)})</option>`).join('')}
    </select>`;
  wrap.querySelector('#branchFilter').addEventListener('change', onChange);
  return branches;
}
function selectedBranch() {
  const sel = document.getElementById('branchFilter');
  return sel && sel.value ? sel.value : undefined;
}


// ---------------- Change your own password ----------------
// Available from the top bar on every screen. The current password is required
// even though you're already signed in, so a session someone left open can't
// be used to take the account over.
function openChangePassword() {
  const modal = openModal('Change your password', `
    <label>Current password *</label>
    <input type="password" id="cpCurrent" autocomplete="current-password" />
    <label style="margin-top:10px;display:block;">New password *</label>
    <input type="password" id="cpNew" autocomplete="new-password" placeholder="At least 8 characters" />
    <label style="margin-top:10px;display:block;">Confirm new password *</label>
    <input type="password" id="cpConfirm" autocomplete="new-password" />
    <div id="cpError" class="error-text" style="display:none;"></div>
    <div style="display:flex;gap:8px;margin-top:16px;">
      <button class="btn" id="cpSave" data-loading-text="Saving…">Change password</button>
      <button class="btn secondary" id="cpCancel">Cancel</button>
    </div>`);

  modal.querySelector('#cpCancel').addEventListener('click', closeModal);
  const save = modal.querySelector('#cpSave');
  save.addEventListener('click', withLoading(save, async () => {
    const errBox = modal.querySelector('#cpError');
    errBox.style.display = 'none';
    const current = modal.querySelector('#cpCurrent').value;
    const next = modal.querySelector('#cpNew').value;
    const confirm = modal.querySelector('#cpConfirm').value;

    const fail = (msg) => { errBox.textContent = msg; errBox.style.display = 'block'; };
    if (!current || !next) return fail('Fill in both your current and new password.');
    if (next !== confirm) return fail('The two new passwords do not match.');
    if (next.length < 8) return fail('The new password must be at least 8 characters.');

    try {
      await api('/auth/change-password', { method: 'POST', body: { currentPassword: current, newPassword: next } });
      closeModal();
      toast('Password changed. Use the new one next time you sign in.', 'success');
      showSuccessBurst('Password changed');
    } catch (e) {
      fail(e.message);
    }
  }));
}

// ---------------- Pagination ----------------
// List endpoints return { rows, page, pageSize, total, totalPages } instead of
// a bare array, because the old hardcoded LIMITs meant older records silently
// became unreachable. `renderPager` draws the control and calls onPage(n).
function renderPager(container, meta, onPage) {
  if (!meta || meta.totalPages <= 1) {
    container.innerHTML = meta && meta.total
      ? `<p class="muted" style="margin:10px 0 0;">${meta.total} record${meta.total === 1 ? '' : 's'}</p>` : '';
    return;
  }
  const from = (meta.page - 1) * meta.pageSize + 1;
  const to = Math.min(meta.total, meta.page * meta.pageSize);
  container.innerHTML = `
    <div class="pager">
      <span class="muted">Showing ${from}–${to} of ${meta.total}</span>
      <div class="pager-buttons">
        <button class="btn secondary" data-page="1" ${meta.page === 1 ? 'disabled' : ''}>&laquo; First</button>
        <button class="btn secondary" data-page="${meta.page - 1}" ${meta.page === 1 ? 'disabled' : ''}>Prev</button>
        <span class="pager-current">Page ${meta.page} of ${meta.totalPages}</span>
        <button class="btn secondary" data-page="${meta.page + 1}" ${meta.page >= meta.totalPages ? 'disabled' : ''}>Next</button>
        <button class="btn secondary" data-page="${meta.totalPages}" ${meta.page >= meta.totalPages ? 'disabled' : ''}>Last &raquo;</button>
      </div>
    </div>`;
  container.querySelectorAll('[data-page]').forEach(b => {
    if (!b.disabled) b.addEventListener('click', () => onPage(Number(b.dataset.page)));
  });
}

// Tolerates both shapes while every caller is migrated: a paged envelope or a
// plain array from an endpoint that hasn't been converted yet.
function rowsOf(response) {
  return Array.isArray(response) ? response : (response.rows || []);
}

/* =========================================================================
   BULK IMPORT FROM EXCEL / CSV
   One dialog serves customers, suppliers, items and users - they differ only
   in the endpoint and the wording. The file is read in the browser and posted
   as base64, so there is no multipart plumbing on either side.

   The result is always shown row by row. A bulk import that just says
   "47 imported" leaves you wondering about the other three, and the three you
   are wondering about are the whole reason you are looking at the screen.
   ========================================================================= */
const IMPORT_MAX_BYTES = 8 * 1024 * 1024;   // comfortably below the server's body limit

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('That file could not be read.'));
    reader.onload = () => {
      // result looks like "data:...;base64,XXXX" - keep only the payload.
      const s = String(reader.result);
      resolve(s.slice(s.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}

/**
 * openImportDialog({ title, endpoint, templateUrl, hint, onDone })
 *   endpoint    - POST target, e.g. '/masters/customers/import'
 *   templateUrl - GET target for the blank template CSV
 *   hint        - one line describing the columns this import understands
 *   onDone      - called after a successful import so the caller can refresh
 */
function openImportDialog({ title, endpoint, templateUrl, hint, onDone }) {
  const modal = openModal(title, `
    <p class="muted" style="margin-top:0;">${hint || ''}</p>

    <div class="dropzone" id="importDrop" tabindex="0" role="button"
         aria-label="Choose a spreadsheet to import">
      <div class="dropzone-icon">📄</div>
      <div class="dropzone-main">Drop your .xlsx or .csv here</div>
      <div class="dropzone-sub">or click to choose a file</div>
      <input type="file" id="importFile" accept=".xlsx,.xls,.csv,.txt" hidden />
    </div>

    <div id="importChosen" class="import-chosen" style="display:none;"></div>
    <div id="importError" class="error-text" style="display:none;"></div>
    <div id="importResult"></div>

    <div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap;">
      <button class="btn" id="importGo" data-loading-text="Importing…" disabled>Import</button>
      <button class="btn secondary" id="importTemplate">Download blank template</button>
      <button class="btn secondary" id="importClose">Close</button>
    </div>`);

  const drop = modal.querySelector('#importDrop');
  const input = modal.querySelector('#importFile');
  const chosen = modal.querySelector('#importChosen');
  const errBox = modal.querySelector('#importError');
  const resultBox = modal.querySelector('#importResult');
  const goBtn = modal.querySelector('#importGo');
  let file = null;

  const fail = (msg) => { errBox.textContent = msg; errBox.style.display = 'block'; };

  function chooseFile(f) {
    errBox.style.display = 'none';
    resultBox.innerHTML = '';
    if (!f) return;
    if (!/\.(xlsx|xls|csv|txt)$/i.test(f.name)) {
      file = null; goBtn.disabled = true;
      chosen.style.display = 'none';
      return fail('Pick a .xlsx or .csv file. Other formats cannot be read as a spreadsheet.');
    }
    if (f.size > IMPORT_MAX_BYTES) {
      file = null; goBtn.disabled = true;
      chosen.style.display = 'none';
      return fail(`That file is ${(f.size / 1024 / 1024).toFixed(1)} MB, over the ${IMPORT_MAX_BYTES / 1024 / 1024} MB limit. Split it into a few smaller sheets.`);
    }
    file = f;
    goBtn.disabled = false;
    chosen.style.display = 'block';
    chosen.innerHTML = `<span class="chip">📎 ${esc(f.name)}</span> <span class="muted">${(f.size / 1024).toFixed(0)} KB</span>`;
  }

  drop.addEventListener('click', () => input.click());
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  input.addEventListener('change', () => chooseFile(input.files[0]));

  ['dragenter', 'dragover'].forEach(ev =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => chooseFile(e.dataTransfer.files[0]));

  modal.querySelector('#importClose').addEventListener('click', closeModal);
  modal.querySelector('#importTemplate').addEventListener('click', async () => {
    try {
      // '/masters/customers/import/template.csv' -> 'customers-template.csv',
      // so a folder full of downloaded templates is still tellable apart.
      const parts = templateUrl.split('/').filter(Boolean);
      const entity = parts[parts.indexOf('import') - 1] || 'import';
      await apiDownload(templateUrl, null, `${entity}-template.csv`);
    } catch (e) { toast(e.message, 'error'); }
  });

  goBtn.addEventListener('click', withLoading(goBtn, async () => {
    errBox.style.display = 'none';
    if (!file) return fail('Choose a file first.');
    try {
      const dataBase64 = await readFileAsBase64(file);
      const summary = await api(endpoint, { method: 'POST', body: { filename: file.name, dataBase64 } });
      renderImportSummary(resultBox, summary);
      if (summary.inserted > 0) {
        toast(`${summary.inserted} ${summary.label.toLowerCase()}${summary.inserted === 1 ? '' : 's'} imported.`, 'success');
        showSuccessBurst(`${summary.inserted} imported`);
        if (onDone) await onDone(summary);
      } else {
        toast('Nothing was imported — see the row-by-row result.', 'info');
      }
    } catch (e) {
      fail(e.message);
    }
  }));

  return modal;
}

// Row-by-row outcome, worst first: the rows that need attention are the ones
// worth scrolling to, and they should not be buried under 200 successes.
function renderImportSummary(target, summary) {
  const order = { error: 0, skipped: 1, imported: 2 };
  const rows = [...summary.results].sort((a, b) => order[a.status] - order[b.status] || a.row - b.row);
  const pillFor = (s) => s === 'imported' ? 'ok' : (s === 'skipped' ? 'warn' : 'bad');

  const anyGenerated = rows.some(r => r.generatedPassword);

  target.innerHTML = `
    <div class="import-summary">
      <span class="chip ok">${summary.inserted} imported</span>
      <span class="chip warn">${summary.skipped} skipped</span>
      <span class="chip ${summary.failed ? 'bad' : ''}">${summary.failed} rejected</span>
      <span class="muted">of ${summary.total} data row${summary.total === 1 ? '' : 's'}</span>
    </div>
    <p class="muted" style="font-size:0.78rem;">Columns read: ${esc((summary.headersFound || []).join(', ')) || '—'}</p>
    ${anyGenerated ? `<p class="muted" style="font-size:0.8rem;">
      Generated passwords are shown once, here, and nowhere else. Copy them before closing.
    </p>` : ''}
    <div class="import-results">
      ${renderTable(rows, [
        { key: 'row', label: 'Row', align: 'right' },
        { key: 'name', label: 'Name' },
        { key: 'status', label: 'Result', render: (r) => `<span class="pill ${pillFor(r.status)}">${esc(r.status)}</span>` },
        ...(anyGenerated ? [{ key: 'generatedPassword', label: 'Password', render: (r) => r.generatedPassword ? `<code>${esc(r.generatedPassword)}</code>` : '' }] : []),
        { key: 'reason', label: 'Detail' }
      ], 'Nothing to report.')}
    </div>`;
  animateTables(target);
}

/* =========================================================================
   STATUTORY DOCUMENT HEADER FIELDS
   The reference, order, transport and e-invoice details a GST document has to
   carry. Rendered once here and used by sales, purchase and notes, so the four
   document types cannot drift apart.

   Collapsed by default, and that is deliberate: most invoices in a day need a
   customer, a date and a line, and burying those three behind twelve optional
   boxes would make the common case slower to serve. The section says how many
   of its fields are filled, so nothing entered is ever hidden without a trace.
   ========================================================================= */
const PAY_LEDGERS = ['Cash', 'Bank', 'Credit', 'UPI', 'Cheque'];
const DOC_PARTY_TYPES = ['Registered', 'Unregistered', 'Composition', 'SEZ', 'Export', 'Deemed Export'];

function documentExtrasHtml({ open = false } = {}) {
  return `
    <details class="doc-extras" id="docExtrasBlock" ${open ? 'open' : ''}>
      <summary>
        Reference, transport &amp; e-invoice details
        <span class="doc-extras-count" id="docExtrasCount"></span>
      </summary>
      <div class="form-grid" style="margin-top:12px;">
        <div><label>Reference No.</label><input name="refNo" placeholder="Their document no." /></div>
        <div><label>Reference Date</label><input name="refDate" type="date" /></div>
        <div><label>Order No.</label><input name="orderNo" /></div>
        <div><label>Order Date</label><input name="orderDate" type="date" /></div>
        <div><label>IRN</label><input name="irn" placeholder="e-invoice reference no." /></div>
        <div><label>E-Way Bill No.</label><input name="eWayBillNo" /></div>
        <div><label>Transporter</label><input name="transporterName" /></div>
        <div><label>Consignment Note No.</label><input name="consignmentNo" /></div>
        <div><label>Consignment Date</label><input name="consignmentDate" type="date" /></div>
        <div>
          <label>Payment Ledger</label>
          <select name="payLedger">
            <option value="">—</option>
            ${PAY_LEDGERS.map(p => `<option>${p}</option>`).join('')}
          </select>
        </div>
        <div>
          <label>Party Type</label>
          <select name="partyType">
            <option value="">From the master</option>
            ${DOC_PARTY_TYPES.map(p => `<option>${p}</option>`).join('')}
          </select>
        </div>
        <div>
          <label>Reverse Charge</label>
          <select name="reverseCharge"><option value="0">No</option><option value="1">Yes</option></select>
        </div>
        <div style="grid-column:1/-1;"><label>Remarks</label><input name="remarks" /></div>
      </div>
    </details>`;
}

// Wire the "n filled" counter, so a collapsed section still tells you whether
// anything is in it.
function initDocumentExtras(root = document) {
  const block = root.querySelector('#docExtrasBlock');
  if (!block) return;
  const count = block.querySelector('#docExtrasCount');
  const update = () => {
    const filled = [...block.querySelectorAll('input, select')]
      .filter(el => el.value && el.value !== '0').length;
    count.textContent = filled ? `${filled} filled` : '';
    count.classList.toggle('has', filled > 0);
  };
  block.addEventListener('input', update);
  block.addEventListener('change', update);
  update();
}

// Pull them back out for the request body. Empty fields are left out entirely
// rather than sent as empty strings, so the server can tell "not supplied"
// from "deliberately blank".
function collectDocumentExtras(form) {
  const out = {};
  const names = ['refNo', 'refDate', 'orderNo', 'orderDate', 'irn', 'eWayBillNo',
                 'transporterName', 'consignmentNo', 'consignmentDate',
                 'payLedger', 'partyType', 'remarks'];
  names.forEach(n => {
    const el = form.querySelector(`[name="${n}"]`);
    if (el && String(el.value).trim() !== '') out[n] = String(el.value).trim();
  });
  const rc = form.querySelector('[name="reverseCharge"]');
  if (rc && rc.value === '1') out.reverseCharge = 1;
  return out;
}

/* Per-line traceability: batch, manufacture and expiry. Only worth showing for
   items the master says are batch-tracked, so a business that does not track
   batches never sees the columns. */
function lineTraceabilityHtml() {
  return `
    <input class="line-batch" name="batchNo" placeholder="Batch" style="display:none;" />
    <input class="line-mfg" name="mfgDate" type="date" title="Manufacture date" style="display:none;" />
    <input class="line-exp" name="expDate" type="date" title="Expiry date" style="display:none;" />`;
}

/* ------------------------------------------------------------------------
   Flashy FX: a tactile ripple on every button press, and a cursor-follow
   sheen on cards. Delegated on the document so it covers content rendered
   later too, and fully disabled when the viewer prefers reduced motion.
   ------------------------------------------------------------------------ */
(function flashyFX() {
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) return;

  // Ripple from the click point on any .btn.
  document.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest && e.target.closest('button.btn');
    if (!btn || btn.disabled) return;
    const r = btn.getBoundingClientRect();
    const span = document.createElement('span');
    span.className = 'ripple';
    span.style.left = (e.clientX - r.left) + 'px';
    span.style.top = (e.clientY - r.top) + 'px';
    const far = Math.max(r.width, r.height);
    span.style.width = span.style.height = far + 'px';
    span.style.marginLeft = span.style.marginTop = (-far / 2) + 'px';
    btn.appendChild(span);
    span.addEventListener('animationend', () => span.remove());
    setTimeout(() => span.remove(), 700);
  }, { passive: true });
})();
