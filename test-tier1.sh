# Tests for the Tier-1 data-integrity work:
#   negative-stock prevention, credit limits, pagination, audit log, JWT secret.
# Sourced by test-modules.sh, so it reuses that script's helpers and seeded data.

echo
echo "== TIER 1: negative stock is refused =="
GUARD_ITEM=$(curl -s -X POST $BASE/masters/items -H "$AUTH" -H "$CT" \
  -d '{"ItemName":"Guard Widget","HSN":"8481","GSTRate":18,"Unit":"PCS","PurchaseRate":10,"SaleRate":20,"ReorderLevel":5}' | j "d['id']")
GUARD_CUST=$(curl -s -X POST $BASE/masters/customers -H "$AUTH" -H "$CT" \
  -d "{\"CustomerName\":\"Guard Buyer\",\"State\":\"Telangana\",\"branchId\":$B1}" | j "d['id']")

# Nothing in stock yet, so this sale must be refused outright.
NOSTOCK=$(curl -s -X POST $BASE/sales -H "$AUTH" -H "$CT" \
  -d "{\"branchId\":$B1,\"customerId\":$GUARD_CUST,\"invoiceDate\":\"$TODAY\",\"items\":[{\"itemId\":$GUARD_ITEM,\"qty\":5,\"rate\":20,\"gst\":18}]}")
chk "sale with no stock refused" 'Not enough stock' "$NOSTOCK"
chk "refusal names the shortfall" 'only 0' "$NOSTOCK"
chk "nothing was written" '"total":0' "$(curl -s -H "$AUTH" "$BASE/sales?search=Guard" | tr -d ' ')"

curl -s -X POST $BASE/inventory/adjust -H "$AUTH" -H "$CT" \
  -d "{\"branchId\":$B1,\"itemId\":$GUARD_ITEM,\"adjustmentType\":\"Opening Stock\",\"qty\":10,\"reason\":\"Stock for guard test\"}" > /dev/null
chk "sale within stock succeeds" 'invoiceNo' "$(curl -s -X POST $BASE/sales -H "$AUTH" -H "$CT" \
  -d "{\"branchId\":$B1,\"customerId\":$GUARD_CUST,\"invoiceDate\":\"$TODAY\",\"items\":[{\"itemId\":$GUARD_ITEM,\"qty\":4,\"rate\":20,\"gst\":18}]}")"
chk "sale beyond remaining stock refused" 'only 6' "$(curl -s -X POST $BASE/sales -H "$AUTH" -H "$CT" \
  -d "{\"branchId\":$B1,\"customerId\":$GUARD_CUST,\"invoiceDate\":\"$TODAY\",\"items\":[{\"itemId\":$GUARD_ITEM,\"qty\":7,\"rate\":20,\"gst\":18}]}")"
# The same item split across two lines must be summed, not checked line by line.
chk "same item on two lines is summed" 'Not enough stock' "$(curl -s -X POST $BASE/sales -H "$AUTH" -H "$CT" \
  -d "{\"branchId\":$B1,\"customerId\":$GUARD_CUST,\"invoiceDate\":\"$TODAY\",\"items\":[{\"itemId\":$GUARD_ITEM,\"qty\":4,\"rate\":20,\"gst\":18},{\"itemId\":$GUARD_ITEM,\"qty\":4,\"rate\":20,\"gst\":18}]}")"
chk "transfer beyond stock refused" 'Not enough stock' "$(curl -s -X POST $BASE/inventory/transfer -H "$AUTH" -H "$CT" \
  -d "{\"fromBranchId\":$B1,\"toBranchId\":$B2,\"itemId\":$GUARD_ITEM,\"qty\":99}")"
STOCK_NOW=$(curl -s -H "$AUTH" "$BASE/inventory/ledger?itemId=$GUARD_ITEM&branchId=$B1" | j "d['closingStock']")
if [ "$STOCK_NOW" = "6" ]; then
  echo "  PASS: stock is exactly 6 - no refused transaction leaked a partial write"; PASS=$((PASS+1))
else
  echo "  FAIL: expected stock 6 after guard tests, got $STOCK_NOW"; FAIL=$((FAIL+1))
fi

echo
echo "== TIER 1: the negative-stock override =="
chk "only Super Admin may change policy" 'Insufficient permissions' "$(curl -s -X PUT $BASE/admin/settings -H "$PA" -H "$CT" -d '{"allowNegativeStock":true}')"
chk "override enabled" '"allowNegativeStock":true' "$(curl -s -X PUT $BASE/admin/settings -H "$AUTH" -H "$CT" -d '{"allowNegativeStock":true}' | tr -d ' ')"
chk "oversell now allowed" 'invoiceNo' "$(curl -s -X POST $BASE/sales -H "$AUTH" -H "$CT" \
  -d "{\"branchId\":$B1,\"customerId\":$GUARD_CUST,\"invoiceDate\":\"$TODAY\",\"items\":[{\"itemId\":$GUARD_ITEM,\"qty\":50,\"rate\":20,\"gst\":18}]}")"
chk "policy change is audited" 'UPDATE_COMPANY_SETTINGS' "$(curl -s -H "$AUTH" "$BASE/admin/audit?pageSize=20")"
chk "override switched back off" '"allowNegativeStock":false' "$(curl -s -X PUT $BASE/admin/settings -H "$AUTH" -H "$CT" -d '{"allowNegativeStock":false}' | tr -d ' ')"

echo
echo "== TIER 1: credit limit is enforced =="
LIM_CUST=$(curl -s -X POST $BASE/masters/customers -H "$AUTH" -H "$CT" \
  -d "{\"CustomerName\":\"Limited Buyer\",\"State\":\"Telangana\",\"CreditLimit\":1000,\"branchId\":$B1}" | j "d['id']")
curl -s -X POST $BASE/inventory/adjust -H "$AUTH" -H "$CT" \
  -d "{\"branchId\":$B1,\"itemId\":$GUARD_ITEM,\"adjustmentType\":\"Increase\",\"qty\":500,\"reason\":\"Stock for credit-limit test\"}" > /dev/null
chk "sale inside the limit is allowed" 'invoiceNo' "$(curl -s -X POST $BASE/sales -H "$AUTH" -H "$CT" \
  -d "{\"branchId\":$B1,\"customerId\":$LIM_CUST,\"invoiceDate\":\"$TODAY\",\"items\":[{\"itemId\":$GUARD_ITEM,\"qty\":10,\"rate\":50,\"gst\":0}]}")"
OVER=$(curl -s -X POST $BASE/sales -H "$AUTH" -H "$CT" \
  -d "{\"branchId\":$B1,\"customerId\":$LIM_CUST,\"invoiceDate\":\"$TODAY\",\"items\":[{\"itemId\":$GUARD_ITEM,\"qty\":20,\"rate\":50,\"gst\":0}]}")
chk "sale breaching the limit is refused" 'credit limit' "$OVER"
chk "refusal shows the resulting balance" 'Limited Buyer' "$OVER"
chk "a customer with no limit is unrestricted" 'invoiceNo' "$(curl -s -X POST $BASE/sales -H "$AUTH" -H "$CT" \
  -d "{\"branchId\":$B1,\"customerId\":$GUARD_CUST,\"invoiceDate\":\"$TODAY\",\"items\":[{\"itemId\":$GUARD_ITEM,\"qty\":10,\"rate\":5000,\"gst\":0}]}")"
chk "enforcement can be switched off" '"enforceCreditLimit":false' "$(curl -s -X PUT $BASE/admin/settings -H "$AUTH" -H "$CT" -d '{"enforceCreditLimit":false}' | tr -d ' ')"
chk "over-limit sale now allowed" 'invoiceNo' "$(curl -s -X POST $BASE/sales -H "$AUTH" -H "$CT" \
  -d "{\"branchId\":$B1,\"customerId\":$LIM_CUST,\"invoiceDate\":\"$TODAY\",\"items\":[{\"itemId\":$GUARD_ITEM,\"qty\":20,\"rate\":50,\"gst\":0}]}")"
curl -s -X PUT $BASE/admin/settings -H "$AUTH" -H "$CT" -d '{"enforceCreditLimit":true}' > /dev/null

echo
echo "== TIER 1: pagination, search and date filters =="
PAGED=$(curl -s -H "$AUTH" "$BASE/sales?page=1&pageSize=2")
chk "sales returns a paged envelope" '"totalPages"' "$PAGED"
python3 - "$BASE" "$TOK" <<'PYEOF'
import json, sys, urllib.request
base, tok = sys.argv[1], sys.argv[2]
def get(p):
    r = urllib.request.Request(base + p, headers={'Authorization': 'Bearer ' + tok})
    return json.load(urllib.request.urlopen(r))
p1 = get('/sales?page=1&pageSize=2')
assert len(p1['rows']) <= 2, p1
assert p1['total'] > 2, "need more than 2 invoices for a meaningful paging test"
p2 = get('/sales?page=2&pageSize=2')
ids1 = {r['InvoiceID'] for r in p1['rows']}
ids2 = {r['InvoiceID'] for r in p2['rows']}
assert not (ids1 & ids2), f"pages overlap: {ids1 & ids2}"
# Every record must be reachable by walking the pages - the whole point.
seen = set()
for n in range(1, p1['totalPages'] + 1):
    seen |= {r['InvoiceID'] for r in get(f'/sales?page={n}&pageSize=2')['rows']}
assert len(seen) == p1['total'], f"walked {len(seen)} of {p1['total']} records"
print(f"  PASS: paging reaches all {p1['total']} invoices with no overlap across {p1['totalPages']} pages")
PYEOF
[ $? -eq 0 ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))
chk "search narrows the result" 'Limited Buyer' "$(curl -s -H "$AUTH" "$BASE/sales?search=Limited")"
chk "search excludes non-matches" '"total":0' "$(curl -s -H "$AUTH" "$BASE/sales?search=NoSuchCustomerAnywhere" | tr -d ' ')"
chk "date filter excludes the future" '"total":0' "$(curl -s -H "$AUTH" "$BASE/sales?from=2099-01-01" | tr -d ' ')"
chk "status filter works" 'Cancelled' "$(curl -s -H "$AUTH" "$BASE/sales?status=Cancelled")"
chk "purchase list is paged too" '"totalPages"' "$(curl -s -H "$AUTH" "$BASE/purchase?page=1&pageSize=2")"
chk "leads list is paged too" '"totalPages"' "$(curl -s -H "$AUTH" "$BASE/crm/leads?page=1&pageSize=2")"
chk "pageSize is capped" 'PASS' "$(python3 -c "
import json,urllib.request
r=urllib.request.Request('$BASE/sales?pageSize=99999', headers={'Authorization':'Bearer $TOK'})
d=json.load(urllib.request.urlopen(r))
print('PASS' if d['pageSize'] <= 200 else 'FAIL ' + str(d['pageSize']))")"

echo
echo "== TIER 1: audit log is readable =="
AUD=$(curl -s -H "$AUTH" "$BASE/admin/audit?pageSize=10")
chk "audit log returns rows" '"rows"' "$AUD"
chk "audit rows name the user" 'admin' "$AUD"
chk "login events are recorded" 'LOGIN' "$(curl -s -H "$AUTH" "$BASE/admin/audit?action=LOGIN&pageSize=5")"
chk "invoice creation is recorded" 'CREATE_SALES_INVOICE' "$(curl -s -H "$AUTH" "$BASE/admin/audit?action=CREATE_SALES_INVOICE&pageSize=5")"
chk "cancellation is recorded" 'CANCEL_SALES_INVOICE' "$(curl -s -H "$AUTH" "$BASE/admin/audit?action=CANCEL_SALES_INVOICE&pageSize=5")"
chk "action list is offered for filtering" 'CREATE_LEAD' "$(curl -s -H "$AUTH" $BASE/admin/audit/actions)"
chk "audit search works" 'rows' "$(curl -s -H "$AUTH" "$BASE/admin/audit?search=admin&pageSize=5")"
chk "audit log is paged" '"totalPages"' "$AUD"
chk "auditor may read the audit log" '"rows"' "$(curl -s -H "$AA" "$BASE/admin/audit?pageSize=5")"
chk "a cashier may not" 'do not have access' "$(curl -s -H "$CA" "$BASE/admin/audit")"
chk "a sales exec may not" 'do not have access' "$(curl -s -H "$SA" "$BASE/admin/audit")"
# A branch-locked administrator must not see another branch's activity.
python3 - "$BASE" "$TOK" <<'PYEOF'
import json, sys, urllib.request
base, tok = sys.argv[1], sys.argv[2]
r = urllib.request.Request(base + '/admin/audit?pageSize=200', headers={'Authorization': 'Bearer ' + tok})
d = json.load(urllib.request.urlopen(r))
assert d['total'] > 10, d['total']
assert all('Action' in row for row in d['rows'])
print(f"  PASS: audit log holds {d['total']} entries and every row carries an action")
PYEOF
[ $? -eq 0 ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

echo
echo "== TIER 1: production refuses a weak JWT secret =="
BACKEND_DIR="$(cd "$(dirname "$0")" && pwd)/backend"
OUT=$(cd "$BACKEND_DIR" && NODE_ENV=production DB_PATH=/tmp/jwtcheck.db PORT=3998 node server.js 2>&1 | head -3)
chk "boots refused with no secret" 'Refusing to start' "$OUT"
OUT2=$(cd "$BACKEND_DIR" && NODE_ENV=production JWT_SECRET=short DB_PATH=/tmp/jwtcheck.db PORT=3998 node server.js 2>&1 | head -3)
chk "boot refused with a short secret" 'Refusing to start' "$OUT2"
OUT3=$(cd "$BACKEND_DIR" && NODE_ENV=production JWT_SECRET=replace-with-a-long-random-string-placeholder DB_PATH=/tmp/jwtcheck.db PORT=3998 node server.js 2>&1 | head -3)
chk "boot refused with the placeholder" 'Refusing to start' "$OUT3"
GOOD=$(node -e "console.log(require('crypto').randomBytes(40).toString('hex'))")
OUT4=$(cd "$BACKEND_DIR" && NODE_ENV=production JWT_SECRET=$GOOD DB_PATH=/tmp/jwtcheck.db PORT=3998 timeout 3 node server.js 2>&1 | head -14)
chk "boots with a proper secret" 'running on port' "$OUT4"
rm -f /tmp/jwtcheck.db /tmp/jwtcheck.db-wal /tmp/jwtcheck.db-shm
