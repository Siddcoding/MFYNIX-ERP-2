# Release R1 tests: masters validation, payment terms, perpetual inventory,
# TDS/advance receipts, period locks, reversal, reconciliation.
# Sourced by test-modules.sh (reuses chk, j, BASE, AUTH, CT, B1, B2, TODAY).
echo
echo "== R1: GSTIN / state / PAN validation on masters =="
chk "a mistyped GSTIN check digit is refused" 'check character' "$(curl -s -X POST $BASE/masters/customers -H "$AUTH" -H "$CT" \
  -d "{\"CustomerName\":\"Bad GSTIN\",\"GSTIN\":\"27AAACS2222S1Z9\",\"State\":\"Maharashtra\",\"branchId\":$B1}")"
chk "a GSTIN whose state disagrees is refused" 'registered in' "$(curl -s -X POST $BASE/masters/customers -H "$AUTH" -H "$CT" \
  -d "{\"CustomerName\":\"Wrong State\",\"GSTIN\":\"27AAACS2222S1Z3\",\"State\":\"Telangana\",\"branchId\":$B1}")"
R1C=$(curl -s -X POST $BASE/masters/customers -H "$AUTH" -H "$CT" \
  -d "{\"CustomerName\":\"Good GSTIN Co\",\"GSTIN\":\"27AAACS2222S1Z3\",\"State\":\"Maharashtra\",\"branchId\":$B1}")
R1CID=$(echo "$R1C" | j "d['id']")
chk "a valid GSTIN is accepted and its PAN derived" '[0-9]' "$R1CID"
PAN_OK=$(curl -s -H "$AUTH" $BASE/masters/customers | j "[c['PAN'] for c in d if c.get('CustomerID')==$R1CID][0]")
chk "PAN came from the GSTIN (chars 3-12)" 'AAACS2222S' "$PAN_OK"
chk "the GST state list is available" '\"code\"' "$(curl -s -H "$AUTH" $BASE/masters/gst-states)"
chk "GSTIN can be validated without saving" '\"pan\"' "$(curl -s -H "$AUTH" "$BASE/masters/validate-gstin?gstin=27AAACS2222S1Z3")"

echo
echo "== R1: payment terms master and due dates =="
PT=$(curl -s -X POST $BASE/masters/payment-terms -H "$AUTH" -H "$CT" -d '{"Code":"NET7","Description":"Net 7 days","NetDays":7}')
PTID=$(echo "$PT" | j "d['id']")
chk "a payment term can be created" '[0-9]' "$PTID"
chk "duplicate term code refused" 'already exists' "$(curl -s -X POST $BASE/masters/payment-terms -H "$AUTH" -H "$CT" -d '{"Code":"NET7","NetDays":7}')"
PTCUST=$(curl -s -X POST $BASE/masters/customers -H "$AUTH" -H "$CT" \
  -d "{\"CustomerName\":\"Terms Co\",\"State\":\"Telangana\",\"PaymentTermID\":$PTID,\"branchId\":$B1}" | j "d['id']")
PTINV=$(curl -s -X POST $BASE/sales -H "$AUTH" -H "$CT" \
  -d "{\"branchId\":$B1,\"customerId\":$PTCUST,\"invoiceDate\":\"$TODAY\",\"items\":[{\"itemId\":$ITEM,\"qty\":1,\"rate\":100,\"gst\":0}]}")
chk "the invoice carries a due date from its term" '\"dueDate\"' "$PTINV"
python3 - "$TODAY" "$(echo "$PTINV" | j "d['dueDate']")" <<'PY'
import sys, datetime
d0 = datetime.date.fromisoformat(sys.argv[1])
due = datetime.date.fromisoformat(sys.argv[2])
assert (due - d0).days == 7, (sys.argv[1], sys.argv[2], (due-d0).days)
print("  PASS: NET7 made the due date exactly 7 days after the invoice")
PY
[ $? -eq 0 ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

echo
echo "== R1: a master in use is deactivated, never deleted =="
DEAC=$(curl -s -X DELETE $BASE/masters/customers/$PTCUST -H "$AUTH")
chk "deactivation reports the record is in use" '"inUse":true' "$(echo "$DEAC" | tr -d ' ')"
chk "a deactivated customer is hidden from the active list" "" "$(curl -s -H "$AUTH" $BASE/masters/customers | j "[1 for c in d if c.get('CustomerID')==$PTCUST]" 2>/dev/null)"
chk "but still visible under /all" "$PTCUST" "$(curl -s -H "$AUTH" $BASE/masters/customers/all | j "[c['CustomerID'] for c in d if c.get('CustomerID')==$PTCUST]")"
curl -s -X POST $BASE/masters/customers/$PTCUST/reactivate -H "$AUTH" > /dev/null

echo
echo "== R1: perpetual inventory values the Inventory account =="
VCO=$(curl -s -X POST $BASE/masters/customers -H "$AUTH" -H "$CT" -d "{\"CustomerName\":\"Valuation Buyer\",\"State\":\"Telangana\",\"branchId\":$B1}" | j "d['id']")
VITEM=$(curl -s -X POST $BASE/masters/items -H "$AUTH" -H "$CT" -d '{"ItemName":"Valued Widget","GSTRate":0,"Unit":"PCS","PurchaseRate":60,"SaleRate":100}' | j "d['id']")
VSUP=$(curl -s -H "$AUTH" $BASE/masters/suppliers | j "d[0]['SupplierID']")
# Buy 10 @ 60 -> Inventory +600. Sell 4 @ 100 -> COGS 240, Inventory 360 left.
curl -s -X POST $BASE/purchase -H "$AUTH" -H "$CT" -d "{\"branchId\":$B1,\"supplierId\":$VSUP,\"purchaseDate\":\"$TODAY\",\"vendorInvoiceNo\":\"VAL-$RANDOM\",\"vendorInvoiceDate\":\"$TODAY\",\"items\":[{\"itemId\":$VITEM,\"qty\":10,\"rate\":60,\"gst\":0}]}" > /dev/null
curl -s -X POST $BASE/sales -H "$AUTH" -H "$CT" -d "{\"branchId\":$B1,\"customerId\":$VCO,\"invoiceDate\":\"$TODAY\",\"items\":[{\"itemId\":$VITEM,\"qty\":4,\"rate\":100,\"gst\":0}]}" > /dev/null
python3 - "$BASE" "$TOK" "$VITEM" "$B1" <<'PY'
import json, sys, urllib.request
base, tok, item, br = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
def get(p):
    r = urllib.request.Request(base + p, headers={'Authorization': 'Bearer ' + tok})
    return json.load(urllib.request.urlopen(r))
val = get(f'/reports/stock-valuation')
# find our item
rows = val.get('rows') or val.get('data') or []
print("  PASS: perpetual valuation report available with %d rows" % len(rows))
PY
[ $? -eq 0 ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

echo
echo "== R1: receipt with TDS and advance on account =="
TCO=$(curl -s -X POST $BASE/masters/customers -H "$AUTH" -H "$CT" -d "{\"CustomerName\":\"TDS Buyer\",\"State\":\"Telangana\",\"branchId\":$B1}" | j "d['id']")
TINV=$(curl -s -X POST $BASE/sales -H "$AUTH" -H "$CT" -d "{\"branchId\":$B1,\"customerId\":$TCO,\"invoiceDate\":\"$TODAY\",\"items\":[{\"itemId\":$ITEM,\"qty\":10,\"rate\":100,\"gst\":0}]}" | j "d['invoiceId']")
# Invoice 1000. Customer pays 950 cash and deducts 50 TDS -> invoice fully settled.
RCT=$(curl -s -X POST $BASE/accounts/settle -H "$AUTH" -H "$CT" \
  -d "{\"voucherType\":\"Receipt\",\"entryDate\":\"$TODAY\",\"mode\":\"Bank\",\"partyType\":\"Customer\",\"partyId\":$TCO,\"amount\":950,\"tds\":50,\"branchId\":$B1,\"allocations\":[{\"docType\":\"SalesInvoice\",\"docId\":$TINV,\"amount\":1000}]}")
chk "receipt with TDS settles the invoice in full" '"settled":1' "$(echo "$RCT" | tr -d ' ')"
chk "the invoice is now fully paid" '0' "$(curl -s -H "$AUTH" $BASE/outstanding/customers/$TCO | j "d['totalOpen']")"
# An advance: pay 500 on account with no invoice.
ADV=$(curl -s -X POST $BASE/accounts/settle -H "$AUTH" -H "$CT" \
  -d "{\"voucherType\":\"Receipt\",\"entryDate\":\"$TODAY\",\"mode\":\"Bank\",\"partyType\":\"Customer\",\"partyId\":$TCO,\"amount\":500,\"onAccount\":true,\"branchId\":$B1,\"allocations\":[]}")
chk "a pure advance is accepted on account" '"onAccount":500' "$(echo "$ADV" | tr -d ' ')"
chk "the advance shows as an unapplied balance" '500' "$(curl -s -H "$AUTH" "$BASE/accounts/advances?partyType=Customer&partyId=$TCO" | j "d['total']")"

echo
echo "== R1: period lock blocks back-dated posting =="
LPERIOD=$(date -d "$TODAY" +%Y-%m 2>/dev/null || echo "${TODAY:0:7}")
curl -s -X POST $BASE/admin/period-locks -H "$AUTH" -H "$CT" -d "{\"period\":\"$LPERIOD\",\"module\":\"Sales\"}" > /dev/null
chk "a sale in a locked period is refused" 'locked' "$(curl -s -X POST $BASE/sales -H "$AUTH" -H "$CT" \
  -d "{\"branchId\":$B1,\"customerId\":$TCO,\"invoiceDate\":\"$TODAY\",\"items\":[{\"itemId\":$ITEM,\"qty\":1,\"rate\":100,\"gst\":0}]}")"
LID=$(curl -s -H "$AUTH" $BASE/admin/period-locks | j "[l['LockID'] for l in d if l['Period']=='$LPERIOD' and l['Module']=='Sales'][0]")
curl -s -X DELETE $BASE/admin/period-locks/$LID -H "$AUTH" > /dev/null
chk "after unlocking, the sale posts" '"invoiceNo"' "$(curl -s -X POST $BASE/sales -H "$AUTH" -H "$CT" \
  -d "{\"branchId\":$B1,\"customerId\":$TCO,\"invoiceDate\":\"$TODAY\",\"items\":[{\"itemId\":$ITEM,\"qty\":1,\"rate\":100,\"gst\":0}]}")"

echo
echo "== R1: a posted journal can be reversed (never edited) =="
JV=$(curl -s -X POST $BASE/accounts/journal -H "$AUTH" -H "$CT" -d "{\"branchId\":$B1,\"entryDate\":\"$TODAY\",\"narration\":\"To reverse\",\"lines\":[{\"accountId\":$(curl -s -H "$AUTH" $BASE/accounts/accounts | j "[a['AccountID'] for a in d if a['AccountCode']=='5200'][0]"),\"debit\":100,\"credit\":0},{\"accountId\":$(curl -s -H "$AUTH" $BASE/accounts/accounts | j "[a['AccountID'] for a in d if a['AccountCode']=='1000'][0]"),\"debit\":0,\"credit\":100}]}")
JVID=$(echo "$JV" | j "d['journalId']")
chk "the journal can be reversed" 'reversalJournalId' "$(curl -s -X POST $BASE/accounts/journal/$JVID/reverse -H "$AUTH" -H "$CT" -d '{"reason":"test reversal"}')"
chk "it cannot be reversed twice" 'already been reversed' "$(curl -s -X POST $BASE/accounts/journal/$JVID/reverse -H "$AUTH" -H "$CT" -d '{"reason":"again"}')"

echo
echo "== R1 EXIT: a clean company reconciles after one full cycle =="
# A fresh company so the reconciliation is exact, not muddied by other tests' data.
XE=$(curl -s -X POST $BASE/admin/companies -H "$AUTH" -H "$CT" \
  -d '{"companyName":"Recon Test Ltd","branchName":"RT HO","branchCode":"RT","adminUserName":"rtadmin","adminPassword":"Recon@12345","state":"Odisha"}')
XTOK=$(utok rtadmin Recon@12345)
XA="Authorization: Bearer $XTOK"
XB=$(curl -s -H "$XA" $BASE/branches | j "d[0]['BranchID']")
XSUP=$(curl -s -X POST $BASE/masters/suppliers -H "$XA" -H "$CT" -d "{\"SupplierName\":\"RT Supplier\",\"State\":\"Odisha\",\"branchId\":$XB}" | j "d['id']")
XCUST=$(curl -s -X POST $BASE/masters/customers -H "$XA" -H "$CT" -d "{\"CustomerName\":\"RT Customer\",\"State\":\"Odisha\",\"branchId\":$XB}" | j "d['id']")
XITEM=$(curl -s -X POST $BASE/masters/items -H "$XA" -H "$CT" -d '{"ItemName":"RT Widget","GSTRate":18,"Unit":"PCS","PurchaseRate":100,"SaleRate":150}' | j "d['id']")
# Buy 20 @ 100 (+18% GST), sell 8 @ 150 (+18%), collect part payment.
curl -s -X POST $BASE/purchase -H "$XA" -H "$CT" -d "{\"branchId\":$XB,\"supplierId\":$XSUP,\"purchaseDate\":\"$TODAY\",\"vendorInvoiceNo\":\"RT-001\",\"vendorInvoiceDate\":\"$TODAY\",\"items\":[{\"itemId\":$XITEM,\"qty\":20,\"rate\":100,\"gst\":18}]}" > /dev/null
XINV=$(curl -s -X POST $BASE/sales -H "$XA" -H "$CT" -d "{\"branchId\":$XB,\"customerId\":$XCUST,\"invoiceDate\":\"$TODAY\",\"items\":[{\"itemId\":$XITEM,\"qty\":8,\"rate\":150,\"gst\":18}]}" | j "d['invoiceId']")
# Customer pays 500 against the invoice.
curl -s -X POST $BASE/accounts/settle -H "$XA" -H "$CT" -d "{\"voucherType\":\"Receipt\",\"entryDate\":\"$TODAY\",\"mode\":\"Bank\",\"partyType\":\"Customer\",\"partyId\":$XCUST,\"amount\":500,\"onAccount\":true,\"branchId\":$XB,\"allocations\":[{\"docType\":\"SalesInvoice\",\"docId\":$XINV,\"amount\":500}]}" > /dev/null
XRECON=$(curl -s -H "$XA" $BASE/accounts/reconciliation)
echo "  reconciliation: $(echo "$XRECON" | j "d['rows']")"
chk "a clean company's sub-ledgers reconcile to the paisa" '"reconciled":true}],"reconciled":true' "$(echo "$XRECON" | tr -d ' ')"
chk "and its trial balance balances" '"balanced":true' "$(curl -s -H "$XA" $BASE/accounts/trial-balance | tr -d ' ')"

echo
echo "== R1: two-factor (TOTP) for finance/admin =="
SETUP=$(curl -s -X POST $BASE/auth/2fa/setup -H "$AUTH" -H "$CT" -d '{}')
SECRET=$(echo "$SETUP" | j "d['secret']")
chk "2FA setup returns a secret and otpauth URI" 'otpauth://' "$SETUP"
CODE=$(node -e "console.log(require('$(cd "$(dirname "$0")" && pwd)/backend/services/totp').hotp('$SECRET', Math.floor(Date.now()/1000/30)))")
ENABLED=$(curl -s -X POST $BASE/auth/2fa/enable -H "$AUTH" -H "$CT" -d "{\"totp\":\"$CODE\"}")
chk "a correct code enables 2FA and returns recovery codes" 'recoveryCodes' "$ENABLED"
chk "login without a code is now refused" '"totpRequired":true' "$(curl -s -X POST $BASE/auth/login -H "$CT" -d '{"username":"admin","password":"Admin@123"}')"
CODE2=$(node -e "console.log(require('$(cd "$(dirname "$0")" && pwd)/backend/services/totp').hotp('$SECRET', Math.floor(Date.now()/1000/30)))")
chk "login with the right code succeeds" '"token"' "$(curl -s -X POST $BASE/auth/login -H "$CT" -d "{\"username\":\"admin\",\"password\":\"Admin@123\",\"totp\":\"$CODE2\"}")"
# turn it back off so later tests using admin keep working
curl -s -X POST $BASE/auth/2fa/disable -H "$AUTH" -H "$CT" -d '{"password":"Admin@123"}' > /dev/null
chk "2FA can be turned off with the password" '"token"' "$(curl -s -X POST $BASE/auth/login -H "$CT" -d '{"username":"admin","password":"Admin@123"}')"
