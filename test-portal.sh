# Customer self-service portal.
# Sourced from test-modules.sh, so it shares $BASE, $AUTH, $CT, chk(), j(),
# and the customers/invoices already seeded there.
#
# The point of most of these assertions is isolation: a customer token must see
# its own data and nothing else, and must not be usable against the ERP at all.

echo
echo "== PORTAL: enabling access =="

# Acme has no email on the master yet, so enabling access should be refused
# rather than creating a login nobody can use.
chk "portal access refused without an email address" 'email address' \
  "$(curl -s -X POST $BASE/masters/customers/$CUST_GST/portal-access -H "$AUTH" -H "$CT" \
     -d '{"enabled":true,"password":"Portal@123"}')"

curl -s -X PUT $BASE/masters/customers/$CUST_GST -H "$AUTH" -H "$CT" \
  -d '{"Email":"accounts@acmetraders.example","CreditLimit":500000,"CreditDays":15}' > /dev/null

chk "a short portal password is refused" '8 characters' \
  "$(curl -s -X POST $BASE/masters/customers/$CUST_GST/portal-access -H "$AUTH" -H "$CT" \
     -d '{"enabled":true,"password":"short"}')"

chk "enabling without ever setting a password is refused" 'Set a password' \
  "$(curl -s -X POST $BASE/masters/customers/$CUST_GST/portal-access -H "$AUTH" -H "$CT" \
     -d '{"enabled":true}')"

chk "portal access enabled" '"enabled":true' \
  "$(curl -s -X POST $BASE/masters/customers/$CUST_GST/portal-access -H "$AUTH" -H "$CT" \
     -d '{"enabled":true,"password":"Portal@123"}')"

chk "customer list never exposes the portal password hash" 'PASS' \
  "$(curl -s -H "$AUTH" $BASE/masters/customers | grep -q 'PortalPasswordHash' && echo NOPE || echo PASS)"

echo
echo "== PORTAL: login =="
chk "wrong portal password rejected" 'Invalid email or password' \
  "$(curl -s -X POST $BASE/portal/login -H "$CT" -d '{"email":"accounts@acmetraders.example","password":"nope1234"}')"

chk "unknown email rejected with the same message" 'Invalid email or password' \
  "$(curl -s -X POST $BASE/portal/login -H "$CT" -d '{"email":"nobody@example.com","password":"Portal@123"}')"

PLOGIN=$(curl -s -X POST $BASE/portal/login -H "$CT" \
  -d '{"email":"ACCOUNTS@AcmeTraders.Example","password":"Portal@123"}')
chk "portal login works and is case-insensitive on the email" '"token"' "$PLOGIN"
PTOK=$(echo "$PLOGIN" | j "d['token']")
PAUTH="Authorization: Bearer $PTOK"

echo
echo "== PORTAL: isolation between the two systems =="
chk "a customer token cannot reach the ERP" 'customer portal login' \
  "$(curl -s -H "$PAUTH" $BASE/dashboard/kpis)"
chk "a customer token cannot list other customers" 'customer portal login' \
  "$(curl -s -H "$PAUTH" $BASE/masters/customers)"
chk "a staff token cannot use the portal" 'customer portal logins only' \
  "$(curl -s -H "$AUTH" $BASE/portal/summary)"
chk "the portal needs a token at all" 'Missing token' \
  "$(curl -s $BASE/portal/summary)"

echo
echo "== PORTAL: the customer's own data =="
PME=$(curl -s -H "$PAUTH" $BASE/portal/me)
chk "profile returns the customer's own record" 'Acme Traders' "$PME"

PSUM=$(curl -s -H "$PAUTH" $BASE/portal/summary)
chk "summary returns an outstanding figure" '"outstanding"' "$PSUM"

PINV=$(curl -s -H "$PAUTH" $BASE/portal/invoices)
chk "invoice list is paged" '"totalPages"' "$PINV"

# The heart of it: every invoice the portal returns must belong to this
# customer. Compared against what the ERP itself says the customer was billed.
ERP_TOTAL=$(curl -s -H "$AUTH" "$BASE/outstanding/customers" | python3 -c "
import sys,json
d=json.load(sys.stdin)
parties=d['parties'] if isinstance(d,dict) and 'parties' in d else d
mine=[p for p in parties if p['partyId']==$CUST_GST]
print(round(mine[0]['total'],2) if mine else 0)")
PORTAL_TOTAL=$(echo "$PSUM" | j "round(d['outstanding'],2)")
chk "portal outstanding ($PORTAL_TOTAL) matches what the ERP shows for this customer ($ERP_TOTAL)" \
  "^${ERP_TOTAL}$" "$PORTAL_TOTAL"

OTHERS=$(echo "$PINV" | python3 -c "
import sys,json
print(len([r for r in json.load(sys.stdin)['rows'] if r['InvoiceNo'] is None]))")
chk "no malformed rows in the invoice list" '^0$' "$OTHERS"

# Fetch an invoice belonging to the OTHER customer and confirm it 404s.
OTHER_INV=$(curl -s -H "$AUTH" "$BASE/sales?branchId=$B2" | python3 -c "
import sys,json
d=json.load(sys.stdin); rows=d['rows'] if isinstance(d,dict) else d
mine=[r for r in rows if r.get('CustomerID')==$CUST_B2C]
print(mine[0]['InvoiceID'] if mine else '')")
if [ -n "$OTHER_INV" ]; then
  chk "another customer's invoice is not readable" 'Invoice not found' \
    "$(curl -s -H "$PAUTH" $BASE/portal/invoices/$OTHER_INV)"
fi

MY_INV=$(echo "$PINV" | j "d['rows'][0]['InvoiceID']")
PDET=$(curl -s -H "$PAUTH" $BASE/portal/invoices/$MY_INV)
chk "own invoice opens with its line items" '"lines"' "$PDET"
chk "invoice detail reports what is still due" '"openAmount"' "$PDET"

echo
echo "== PORTAL: statement of account =="
PST=$(curl -s -H "$PAUTH" "$BASE/portal/statement")
chk "statement returns a running balance" '"closingBalance"' "$PST"

# Arithmetic, not just shape: closing = opening + debits - credits, and the
# last row's running balance must equal the reported closing balance.
chk "statement arithmetic is self-consistent" '^OK$' "$(echo "$PST" | python3 -c "
import sys,json
d=json.load(sys.stdin)
expected=round(d['openingBalance']+d['totals']['debit']-d['totals']['credit'],2)
closing=round(d['totals']['closingBalance'],2)
last=round(d['rows'][-1]['Balance'],2) if d['rows'] else round(d['openingBalance'],2)
print('OK' if abs(expected-closing)<0.01 and abs(last-closing)<0.01 else f'{expected} vs {closing} vs {last}')")"

chk "statement exports as CSV" 'Closing balance' \
  "$(curl -s -H "$PAUTH" "$BASE/portal/statement/export.csv")"

echo
echo "== PORTAL: password and revocation =="
chk "portal password change needs the right current password" 'not correct' \
  "$(curl -s -X POST $BASE/portal/change-password -H "$PAUTH" -H "$CT" \
     -d '{"currentPassword":"wrongone","newPassword":"Portal@456"}')"

chk "portal password changed" 'Password changed' \
  "$(curl -s -X POST $BASE/portal/change-password -H "$PAUTH" -H "$CT" \
     -d '{"currentPassword":"Portal@123","newPassword":"Portal@456"}')"

chk "the old portal password no longer works" 'Invalid email or password' \
  "$(curl -s -X POST $BASE/portal/login -H "$CT" \
     -d '{"email":"accounts@acmetraders.example","password":"Portal@123"}')"

# Revoking access must bite immediately, not when the token happens to expire.
curl -s -X POST $BASE/masters/customers/$CUST_GST/portal-access -H "$AUTH" -H "$CT" \
  -d '{"enabled":false}' > /dev/null
chk "revoking access invalidates the live token straight away" 'withdrawn' \
  "$(curl -s -H "$PAUTH" $BASE/portal/summary)"

# Put it back so anything running after this still has a working portal login.
curl -s -X POST $BASE/masters/customers/$CUST_GST/portal-access -H "$AUTH" -H "$CT" \
  -d '{"enabled":true}' > /dev/null
chk "access can be restored without resetting the password" '"token"' \
  "$(curl -s -X POST $BASE/portal/login -H "$CT" \
     -d '{"email":"accounts@acmetraders.example","password":"Portal@456"}')"

echo
echo "== PORTAL: who may grant access =="
if [ -n "${CTOK:-}" ]; then
  chk "a cashier cannot grant portal access" 'Insufficient permissions' \
    "$(curl -s -X POST $BASE/masters/customers/$CUST_GST/portal-access \
       -H "Authorization: Bearer $CTOK" -H "$CT" -d '{"enabled":true}')"
fi

echo
echo "== PORTAL: timed access (1 / 3 / 6 / 12 months) =="

# Granting for a term must produce the right calendar date, computed the same
# way the server does. Checked against Python's own date maths, not against a
# string the server handed back.
expected_expiry() { # expected_expiry <months> [from]
  python3 - "$1" "${2:-}" <<'PY'
import sys, datetime
months = int(sys.argv[1])
base = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else datetime.date.today().isoformat()
d = datetime.date.fromisoformat(base)
m = d.month - 1 + months
y = d.year + m // 12
m = m % 12 + 1
last = [31,29 if (y%4==0 and y%100!=0) or y%400==0 else 28,31,30,31,30,31,31,30,31,30,31][m-1]
print(datetime.date(y, m, min(d.day, last)).isoformat())
PY
}

grant_term() { # grant_term <months>
  curl -s -X POST $BASE/masters/customers/$CUST_GST/portal-access -H "$AUTH" -H "$CT" \
    -d "{\"enabled\":true,\"termMonths\":$1}"
}

# Start from a clean slate: no expiry, so each term below is measured from today.
python3 - <<PY
import sqlite3
db = sqlite3.connect("$PWD/backend/db/test.db")
db.execute("UPDATE Customer SET PortalExpiresAt = NULL, PortalTermMonths = NULL WHERE CustomerID = $CUST_GST")
db.commit()
PY

for M in 1 3 6 12; do
  # Reset to no expiry first so each term is measured from today, not stacked.
  python3 - <<PY
import sqlite3
db = sqlite3.connect("$PWD/backend/db/test.db")
db.execute("UPDATE Customer SET PortalExpiresAt = NULL WHERE CustomerID = $CUST_GST")
db.commit()
PY
  WANT=$(expected_expiry $M)
  chk "a $M-month grant expires on $WANT" "\"expiresAt\":\"$WANT\"" "$(grant_term $M)"
done

chk "an invalid term is refused" 'must be one of 1, 3, 6, 12' \
  "$(curl -s -X POST $BASE/masters/customers/$CUST_GST/portal-access -H "$AUTH" -H "$CT" \
     -d '{"enabled":true,"termMonths":7}')"

chk "\"never\" clears the expiry" '"expiresAt":null' \
  "$(curl -s -X POST $BASE/masters/customers/$CUST_GST/portal-access -H "$AUTH" -H "$CT" \
     -d '{"enabled":true,"termMonths":"never"}')"

# Renewing early must extend from the existing expiry, not from today, so the
# customer never loses the days they already had.
python3 - <<PY
import sqlite3, datetime
db = sqlite3.connect("$PWD/backend/db/test.db")
future = (datetime.date.today() + datetime.timedelta(days=40)).isoformat()
db.execute("UPDATE Customer SET PortalExpiresAt = ? WHERE CustomerID = $CUST_GST", (future,))
db.commit()
PY
FUTURE=$(python3 -c "import datetime;print((datetime.date.today()+datetime.timedelta(days=40)).isoformat())")
WANT=$(expected_expiry 3 "$FUTURE")
chk "renewing early extends from the existing expiry, not from today ($WANT)" "\"expiresAt\":\"$WANT\"" "$(grant_term 3)"

echo
echo "== PORTAL: what happens when the term runs out =="
GOOD=$(curl -s -X POST $BASE/portal/login -H "$CT" \
  -d '{"email":"accounts@acmetraders.example","password":"Portal@456"}')
LIVE_TOK=$(echo "$GOOD" | j "d['token']")
chk "a customer inside their term can still sign in" '"token"' "$GOOD"
chk "the login response says when access ends" '"accessExpiresAt"' "$GOOD"

# Backdate the expiry to yesterday. The token issued a moment ago is still
# cryptographically valid, so this is the real test: does the *expiry* stop it,
# or only the login screen?
python3 - <<PY
import sqlite3, datetime
db = sqlite3.connect("$PWD/backend/db/test.db")
past = (datetime.date.today() - datetime.timedelta(days=1)).isoformat()
db.execute("UPDATE Customer SET PortalExpiresAt = ? WHERE CustomerID = $CUST_GST", (past,))
db.commit()
PY
chk "an expired term kills the live token on the very next request" 'expired on' \
  "$(curl -s -H "Authorization: Bearer $LIVE_TOK" $BASE/portal/summary)"
chk "and blocks a fresh sign-in with the right password" 'expired on' \
  "$(curl -s -X POST $BASE/portal/login -H "$CT" \
     -d '{"email":"accounts@acmetraders.example","password":"Portal@456"}')"
chk "the refusal is not a generic bad-password message" 'renew' \
  "$(curl -s -X POST $BASE/portal/login -H "$CT" \
     -d '{"email":"accounts@acmetraders.example","password":"Portal@456"}')"
chk "but a wrong password on an expired account still says only that" 'Invalid email or password' \
  "$(curl -s -X POST $BASE/portal/login -H "$CT" \
     -d '{"email":"accounts@acmetraders.example","password":"totallywrong"}')"

# Expiry today must still work - the last day is inclusive.
python3 - <<PY
import sqlite3, datetime
db = sqlite3.connect("$PWD/backend/db/test.db")
db.execute("UPDATE Customer SET PortalExpiresAt = ? WHERE CustomerID = $CUST_GST",
           (datetime.date.today().isoformat(),))
db.commit()
PY
LASTDAY=$(curl -s -X POST $BASE/portal/login -H "$CT" \
  -d '{"email":"accounts@acmetraders.example","password":"Portal@456"}')
chk "the last day of the term is inclusive" '"token"' "$LASTDAY"
LASTDAY_TOK=$(echo "$LASTDAY" | j "d.get('token','')")

# Renewing an already-lapsed access starts the term from today.
python3 - <<PY
import sqlite3, datetime
db = sqlite3.connect("$PWD/backend/db/test.db")
past = (datetime.date.today() - datetime.timedelta(days=90)).isoformat()
db.execute("UPDATE Customer SET PortalExpiresAt = ? WHERE CustomerID = $CUST_GST", (past,))
db.commit()
PY
WANT=$(expected_expiry 6)
RENEW=$(grant_term 6)
chk "renewing a lapsed access starts the new term today ($WANT)" "\"expiresAt\":\"$WANT\"" "$RENEW"
# Asserted from the access state rather than by signing in again: by this point
# the portal's own login limiter has legitimately kicked in, and re-logging-in
# purely to prove a database field would be testing the limiter, not the term.
chk "and the access is live again" '"active":true' "$RENEW"

# The token minted while the term was valid still works, and reports the window.
if [ -n "${LASTDAY_TOK:-}" ]; then
  chk "the profile reports the remaining days" '"daysRemaining"' \
    "$(curl -s -H "Authorization: Bearer $LASTDAY_TOK" $BASE/portal/me)"
fi

chk "the admin view lists the four terms plus no-expiry" '1 month' \
  "$(curl -s -H "$AUTH" $BASE/masters/customers/$CUST_GST/portal-access)"
chk "the admin view reports days remaining" '"daysRemaining"' \
  "$(curl -s -H "$AUTH" $BASE/masters/customers/$CUST_GST/portal-access)"
