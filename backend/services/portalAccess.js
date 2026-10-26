/* =========================================================================
   CUSTOMER PORTAL ACCESS — TERM AND EXPIRY
   -------------------------------------------------------------------------
   Portal access is granted for a fixed term rather than forever. An account
   manager gives a customer 1, 3, 6 or 12 months and it lapses on its own;
   nobody has to remember to revoke it when a relationship ends, which is the
   failure mode of every "tick to enable" permission ever built.

   One definition of "is this access live?" lives here and is used by the login
   route, by the middleware on every portal request, and by the admin screen -
   so the three can never drift apart and let an expired customer keep reading
   invoices because one of them forgot to check.
   ========================================================================= */

// The terms the UI offers. `months: null` is the escape hatch for a customer
// who genuinely should not expire - a long-standing key account, say - and it
// is also what an access granted before this feature existed looks like.
const PORTAL_TERMS = [
  { key: '1m', months: 1, label: '1 month' },
  { key: '3m', months: 3, label: '3 months' },
  { key: '6m', months: 6, label: '6 months' },
  { key: '12m', months: 12, label: '1 year' },
  { key: 'never', months: null, label: 'No expiry' }
];

const VALID_MONTHS = [1, 3, 6, 12];

/**
 * Add whole months to a date, clamping the day so 31 January + 1 month is
 * 28 February rather than rolling into March. JavaScript's own setMonth does
 * roll over, and a customer whose access silently ran a day long every quarter
 * would be a genuinely confusing bug to chase.
 */
function addMonths(fromIso, months) {
  const d = new Date(fromIso + 'T00:00:00Z');
  const targetMonth = d.getUTCMonth() + months;
  const result = new Date(Date.UTC(d.getUTCFullYear(), targetMonth, 1));
  const lastDayOfTarget = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(d.getUTCDate(), lastDayOfTarget));
  return result.toISOString().slice(0, 10);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function daysBetween(fromIso, toIso) {
  const a = new Date(fromIso + 'T00:00:00Z').getTime();
  const b = new Date(toIso + 'T00:00:00Z').getTime();
  return Math.round((b - a) / 86400000);
}

/**
 * Work out where a customer's portal access stands right now.
 *
 * Expiry is inclusive of the last day: access granted for one month on the 5th
 * runs to the end of the 5th of next month. Anyone reading "expires 5 March"
 * expects to be able to sign in on 5 March.
 */
function accessStatus(customer, asOn = today()) {
  const enabled = !!(customer && customer.PortalEnabled);
  const expiresAt = customer ? (customer.PortalExpiresAt || null) : null;
  const expired = !!(expiresAt && daysBetween(asOn, expiresAt) < 0);

  return {
    enabled,
    expiresAt,
    termMonths: customer ? (customer.PortalTermMonths || null) : null,
    grantedAt: customer ? (customer.PortalGrantedAt || null) : null,
    expired,
    // null when there is no expiry at all; 0 means "expires today, still valid".
    daysRemaining: expiresAt ? daysBetween(asOn, expiresAt) : null,
    active: enabled && !expired,
    // Two weeks is enough notice to renew without the banner living on screen
    // permanently, which is how warnings stop being read.
    expiringSoon: enabled && !expired && expiresAt !== null && daysBetween(asOn, expiresAt) <= 14
  };
}

// One message, so the login screen, the middleware and the admin list all say
// the same thing about the same state.
function refusalReason(status) {
  if (!status.enabled) return 'Portal access for this account has been withdrawn. Contact your account manager.';
  if (status.expired) return `Portal access for this account expired on ${status.expiresAt}. Contact your account manager to renew it.`;
  return null;
}

/**
 * Work out the new expiry date for a grant or a renewal.
 *
 * A renewal extends from the existing expiry, not from today, so renewing
 * early never costs the customer the days they had left. If the access has
 * already lapsed, the new term starts today - there is nothing left to extend.
 */
function computeExpiry(months, currentExpiry, asOn = today()) {
  if (months === null || months === undefined) return null;      // no expiry
  const base = currentExpiry && daysBetween(asOn, currentExpiry) > 0 ? currentExpiry : asOn;
  return addMonths(base, months);
}

module.exports = { PORTAL_TERMS, VALID_MONTHS, addMonths, accessStatus, refusalReason, computeExpiry, today, daysBetween };
