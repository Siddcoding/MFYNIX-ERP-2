const jwt = require('jsonwebtoken');
const db = require('../db');
const { accessStatus, refusalReason } = require('../services/portalAccess');

// A JWT secret is what stops anyone minting their own login token. The old
// fallback was a fixed string published in this repo, so any deployment that
// forgot to set JWT_SECRET could be signed into as any user by anyone who had
// read the code. Development still gets a throwaway secret for convenience,
// but production has to supply a real one - see server.js, which refuses to
// start otherwise rather than booting quietly insecure.
const DEV_FALLBACK_SECRET = 'dev-only-insecure-secret-do-not-use-in-production';
const JWT_SECRET = process.env.JWT_SECRET || DEV_FALLBACK_SECRET;
const SESSION_IDLE_MINUTES = Number(process.env.SESSION_IDLE_MINUTES) || 60;

function signToken(user, { rememberMe = false } = {}) {
  return jwt.sign(
    {
      userId: user.UserID,
      companyId: user.CompanyID,
      branchId: user.BranchID,     // null = head-office / all-branch user
      role: user.RoleName,
      userName: user.UserName,
      rm: rememberMe ? 1 : 0
    },
    JWT_SECRET,
    { expiresIn: rememberMe ? '30d' : '12h' }
  );
}

// Customers sign in to the self-service portal, not to the ERP. Their token is
// deliberately a different shape - kind:'customer', a CustomerID and no
// RoleID - so a portal token can never satisfy requireAuth even though both
// are signed with the same secret.
function signCustomerToken(customer, { rememberMe = false } = {}) {
  return jwt.sign(
    {
      kind: 'customer',
      customerId: customer.CustomerID,
      companyId: customer.CompanyID,
      customerName: customer.CustomerName
    },
    JWT_SECRET,
    { expiresIn: rememberMe ? '30d' : '12h' }
  );
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    // Belt and braces: a portal token has no userId, so the Users lookup below
    // would fail anyway - but reject it explicitly so the reason is obvious in
    // a log rather than looking like a deactivated account.
    if (decoded.kind === 'customer') {
      return res.status(403).json({ error: 'This is a customer portal login. Sign in as a staff user to use the ERP.' });
    }

    // Check live status, not just what was true when the token was issued -
    // a Super Admin deactivating someone should take effect immediately,
    // not wait for a long-lived (remember-me) token to expire on its own.
    const current = db.prepare('SELECT Status, MustChangePassword, LastActivity, LockedUntil FROM Users WHERE UserID = ?').get(decoded.userId);
    if (!current || current.Status !== 'Active') {
      return res.status(401).json({ error: 'This account has been deactivated. Contact your administrator.' });
    }

    // Session timeout (ROL-01 / PLT-09): a session that has been idle too long
    // is refused even though the token itself has not expired. "Keep me signed
    // in" tokens are exempt - that is what the box means.
    if (!decoded.rm && current.LastActivity) {
      const idleMs = Date.now() - new Date(current.LastActivity.replace(' ', 'T') + 'Z').getTime();
      if (idleMs > SESSION_IDLE_MINUTES * 60000) {
        return res.status(401).json({ error: 'Your session timed out. Please sign in again.' });
      }
      if (idleMs > 30000) db.prepare("UPDATE Users SET LastActivity = datetime('now') WHERE UserID = ?").run(decoded.userId);
    }

    // First-sign-in password change: until it is done, the only things the
    // account may call are the auth endpoints (change password, who am I).
    if (current.MustChangePassword && !String(req.originalUrl).startsWith('/api/auth/')) {
      return res.status(403).json({ error: 'You must change your password before continuing.', mustChangePassword: true });
    }

    req.user = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Gate for the customer portal. Re-reads the Customer row every request so
// that revoking portal access (or deactivating the customer) takes effect
// immediately instead of waiting for a 30-day remember-me token to lapse.
function requireCustomer(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.kind !== 'customer') {
      return res.status(403).json({ error: 'This endpoint is for customer portal logins only.' });
    }
    const current = db.prepare(
      'SELECT CustomerID, IsActive, PortalEnabled, PortalExpiresAt, PortalTermMonths, PortalGrantedAt FROM Customer WHERE CustomerID = ?'
    ).get(decoded.customerId);
    if (!current || !current.IsActive) {
      return res.status(401).json({ error: 'Portal access for this account has been withdrawn. Contact your account manager.' });
    }
    // Checked on every request, not just at login: a 30-day remember-me token
    // must stop working the moment the granted term runs out, otherwise the
    // expiry date is decorative.
    const status = accessStatus(current);
    if (!status.active) {
      return res.status(401).json({ error: refusalReason(status), expired: status.expired });
    }
    req.portalAccess = status;
    req.customer = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Restrict to specific roles, e.g. requireRole('Super Admin', 'Company Admin')
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// Resolve which branch a request should operate on.
// Head-office users (branchId === null) may pass ?branchId= to scope a query,
// or omit it to get all branches. Branch users are always locked to their own branch.
function resolveBranchScope(req) {
  const requested = req.query.branchId ? Number(req.query.branchId) : null;
  if (req.user.branchId) return req.user.branchId;   // branch user - locked
  return requested || null;                            // HO user - optional filter
}

module.exports = {
  signToken, signCustomerToken, requireAuth, requireCustomer, requireRole,
  resolveBranchScope, JWT_SECRET, DEV_FALLBACK_SECRET
};
