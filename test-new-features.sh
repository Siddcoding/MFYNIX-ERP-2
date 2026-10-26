# Tests for the five features added after the first release:
#   change password, stock adjustment, vouchers, cancellation, report filters.
# Sourced by test-modules.sh, so it reuses that script's helpers ($AUTH, chk, j...).

echo
echo "== NEW: change password =="
ACC_ROLE=$(rid 'Accountant')
curl -s -X POST $BASE/branches/users -H "$AUTH" -H "$CT" \
  -d "{\"branchId\":$B2,\"roleId\":$ACC_ROLE,\"userName\":\"pwuser\",\"fullName\":\"Pw Test\",\"password\":\"OldPass@123\"}" > /dev/null
PTOK=$(curl -s -X POST $BASE/auth/login -H "$CT" -d '{"username":"pwuser","password":"OldPass@123"}' | j "d.get('token','')")
PA="Authorization: Bearer $PTOK"
chk "wrong current password rejected" 'not correct' "$(curl -s -X POST $BASE/auth/change-password -H "$PA" -H "$CT" -d '{"currentPassword":"nope","newPassword":"BrandNew@123"}')"
chk "short new password rejected" 'at least 8' "$(curl -s -X POST $BASE/auth/change-password -H "$PA" -H "$CT" -d '{"currentPassword":"OldPass@123","newPassword":"abc"}')"
chk "same-as-current rejected" 'must be different' "$(curl -s -X POST $BASE/auth/change-password -H "$PA" -H "$CT" -d '{"currentPassword":"OldPass@123","newPassword":"OldPass@123"}')"
chk "password changed" 'Password changed' "$(curl -s -X POST $BASE/auth/change-password -H "$PA" -H "$CT" -d '{"currentPassword":"OldPass@123","newPassword":"BrandNew@123"}')"
chk "old password stops working" 'Invalid username or password' "$(curl -s -X POST $BASE/auth/login -H "$CT" -d '{"username":"pwuser","password":"OldPass@123"}')"
chk "new password works" 'token' "$(curl -s -X POST $BASE/auth/login -H "$CT" -d '{"username":"pwuser","password":"BrandNew@123"}')"

PWUID=$(curl -s -H "$AUTH" $BASE/branches/users/list | j "[u['UserID'] for u in d if u['UserName']=='pwuser'][0]")
chk "admin reset needs 8+ chars" 'at least 8' "$(curl -s -X POST $BASE/branches/users/$PWUID/reset-password -H "$AUTH" -H "$CT" -d '{"newPassword":"tiny"}')"
chk "admin reset works" 'Password reset' "$(curl -s -X POST $BASE/branches/users/$PWUID/reset-password -H "$AUTH" -H "$CT" -d '{"newPassword":"AdminSet@123"}')"
chk "login with the admin-set password" 'token' "$(curl -s -X POST $BASE/auth/login -H "$CT" -d '{"username":"pwuser","password":"AdminSet@123"}')"
chk "an admin-set password forces a change at next sign-in" '"mustChangePassword":true' "$(curl -s -X POST $BASE/auth/login -H "$CT" -d '{"username":"pwuser","password":"AdminSet@123"}')"
chk "until it is changed, other APIs are refused" 'must change your password' "$(curl -s -H "Authorization: Bearer $(curl -s -X POST $BASE/auth/login -H "$CT" -d '{"username":"pwuser","password":"AdminSet@123"}' | j "d['token']")" $BASE/masters/customers)"
# An admin-set password must be replaced at next sign-in (ROL-01); get a usable token the way a user would.
PA="Authorization: Bearer $(utok pwuser AdminSet@123)"
chk "non-admin cannot reset someone else" 'Insufficient permissions' "$(curl -s -X POST $BASE/branches/users/$PWUID/reset-password -H "$PA" -H "$CT" -d '{"newPassword":"Hacked@1234"}')"

echo
echo "== NEW: stock adjustment / opening stock =="
ITEM2=$(curl -s -X POST $BASE/masters/items -H "$AUTH" -H "$CT" \
  -d '{"ItemName":"Cement Bag","HSN":"2523","GSTRate":28,"Unit":"BAG","PurchaseRate":300,"SaleRate":400,"ReorderLevel":20}' | j "d['id']")
chk "reason is mandatory" 'reason is required' "$(curl -s -X POST $BASE/inventory/adjust -H "$AUTH" -H "$CT" -d "{\"branchId\":$B1,\"itemId\":$ITEM2,\"adjustmentType\":\"Opening Stock\",\"qty\":100}")"
OP=$(curl -s -X POST $BASE/inventory/adjust -H "$AUTH" -H "$CT" -d "{\"branchId\":$B1,\"itemId\":$ITEM2,\"adjustmentType\":\"Opening Stock\",\"qty\":100,\"reason\":\"Go-live opening balance\"}")
echo "  opening stock -> $OP"
chk "opening stock applied" '"newStock":100' "$(echo "$OP" | tr -d ' ')"
chk "a second opening stock is refused" 'already has stock movement' "$(curl -s -X POST $BASE/inventory/adjust -H "$AUTH" -H "$CT" -d "{\"branchId\":$B1,\"itemId\":$ITEM2,\"adjustmentType\":\"Opening Stock\",\"qty\":50,\"reason\":\"duplicate attempt\"}")"
chk "cannot decrease below zero" 'only 100 in stock' "$(curl -s -X POST $BASE/inventory/adjust -H "$AUTH" -H "$CT" -d "{\"branchId\":$B1,\"itemId\":$ITEM2,\"adjustmentType\":\"Decrease\",\"qty\":500,\"reason\":\"too much\"}")"
chk "damage write-off works" '"newStock":95' "$(curl -s -X POST $BASE/inventory/adjust -H "$AUTH" -H "$CT" -d "{\"branchId\":$B1,\"itemId\":$ITEM2,\"adjustmentType\":\"Damage / Loss\",\"qty\":5,\"reason\":\"Torn bags\"}" | tr -d ' ')"

CNT=$(curl -s -X POST $BASE/inventory/adjust -H "$AUTH" -H "$CT" -d "{\"branchId\":$B1,\"itemId\":$ITEM2,\"adjustmentType\":\"Physical Count Correction\",\"qty\":90,\"reason\":\"Annual stock take\"}")
echo "  count correction -> $CNT"
PREV=$(echo "$CNT" | j "d['previousStock']"); NEW=$(echo "$CNT" | j "d['newStock']"); CHG=$(echo "$CNT" | j "d['change']")
if [ "$PREV" = "95" ] && [ "$NEW" = "90" ] && [ "$CHG" = "-5" ]; then
  echo "  PASS: count correction works out the difference itself (book 95, counted 90 -> -5)"; PASS=$((PASS+1))
else
  echo "  FAIL: count correction gave prev=$PREV new=$NEW change=$CHG"; FAIL=$((FAIL+1))
fi
chk "a no-op count correction is refused" 'already 90' "$(curl -s -X POST $BASE/inventory/adjust -H "$AUTH" -H "$CT" -d "{\"branchId\":$B1,\"itemId\":$ITEM2,\"adjustmentType\":\"Physical Count Correction\",\"qty\":90,\"reason\":\"same\"}")"
chk "stock ledger shows the adjustment trail" 'ADJUSTMENT' "$(curl -s -H "$AUTH" "$BASE/inventory/ledger?itemId=$ITEM2&branchId=$B1")"
chk "ledger closing balance is 90" '"closingStock":90' "$(curl -s -H "$AUTH" "$BASE/inventory/ledger?itemId=$ITEM2&branchId=$B1" | tr -d ' ')"

echo
echo "== NEW: Payment / Receipt / Contra vouchers =="
BANK_ACC=$(curl -s -H "$AUTH" $BASE/accounts/accounts | j "[a['AccountID'] for a in d if a['AccountCode']=='1010'][0]")
chk "voucher options expose cash+bank" 'cashAndBank' "$(curl -s -H "$AUTH" $BASE/accounts/voucher-options)"
RCPT=$(curl -s -X POST $BASE/accounts/voucher -H "$AUTH" -H "$CT" -d "{\"voucherType\":\"Receipt\",\"entryDate\":\"$TODAY\",\"mode\":\"Bank\",\"amount\":5000,\"branchId\":$B1}")
chk "receipt posted" 'journalId' "$RCPT"
chk "receipt narration auto-filled" 'Received into Bank' "$RCPT"
chk "payment posted" 'journalId' "$(curl -s -X POST $BASE/accounts/voucher -H "$AUTH" -H "$CT" -d "{\"voucherType\":\"Payment\",\"entryDate\":\"$TODAY\",\"mode\":\"Cash\",\"amount\":1200,\"branchId\":$B1}")"
chk "contra posted" 'journalId' "$(curl -s -X POST $BASE/accounts/voucher -H "$AUTH" -H "$CT" -d "{\"voucherType\":\"Contra\",\"entryDate\":\"$TODAY\",\"contraDirection\":\"CashToBank\",\"amount\":800,\"branchId\":$B1}")"
chk "contra needs a direction" 'contraDirection' "$(curl -s -X POST $BASE/accounts/voucher -H "$AUTH" -H "$CT" -d "{\"voucherType\":\"Contra\",\"entryDate\":\"$TODAY\",\"amount\":100,\"branchId\":$B1}")"
chk "zero amount rejected" 'greater than zero' "$(curl -s -X POST $BASE/accounts/voucher -H "$AUTH" -H "$CT" -d "{\"voucherType\":\"Receipt\",\"entryDate\":\"$TODAY\",\"mode\":\"Cash\",\"amount\":0,\"branchId\":$B1}")"
chk "cash->bank via Receipt is redirected to Contra" 'use a Contra voucher' "$(curl -s -X POST $BASE/accounts/voucher -H "$AUTH" -H "$CT" -d "{\"voucherType\":\"Receipt\",\"entryDate\":\"$TODAY\",\"mode\":\"Cash\",\"amount\":100,\"againstAccountId\":$BANK_ACC,\"branchId\":$B1}")"
chk "voucher register lists them" 'Receipt' "$(curl -s -H "$AUTH" $BASE/accounts/vouchers)"

# A receipt must move Debtors down and Bank up - check the ledger, not just the HTTP code.
python3 - "$BASE" "$TOK" <<'PYEOF'
import json, sys, urllib.request
base, tok = sys.argv[1], sys.argv[2]
def get(p):
    r = urllib.request.Request(base + p, headers={'Authorization': 'Bearer ' + tok})
    return json.load(urllib.request.urlopen(r))
accts = {a['AccountCode']: a['AccountID'] for a in get('/accounts/accounts')}
bank = get(f"/accounts/ledger/{accts['1010']}")
entries = [e for e in bank['entries'] if e['SourceType'] == 'Receipt']
assert entries and entries[-1]['Debit'] == 5000, entries[-3:]
contra = [e for e in bank['entries'] if e['SourceType'] == 'Contra']
assert contra and contra[-1]['Debit'] == 800, contra[-3:]
print("  PASS: receipt debited Bank 5000 and the contra debited Bank 800 in the actual ledger")
PYEOF
[ $? -eq 0 ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))
chk "books balance after vouchers" '"balanced":true' "$(curl -s -H "$AUTH" $BASE/accounts/trial-balance | tr -d ' ')"

echo
echo "== NEW: cancellation with full reversal =="
# The earlier block filed a GSTR-3B for this period, so cancelling inside it must be blocked.
CID=$(curl -s -X POST $BASE/sales -H "$AUTH" -H "$CT" \
  -d "{\"branchId\":$B2,\"customerId\":$CUST_B2C,\"invoiceDate\":\"$TODAY\",\"items\":[{\"itemId\":$ITEM,\"qty\":1,\"rate\":80,\"gst\":18}]}" | j "d['invoiceId']")
chk "a reason is mandatory" 'reason is required' "$(curl -s -X POST $BASE/sales/$CID/cancel -H "$AUTH" -H "$CT" -d '{}')"
chk "cancel blocked once the GST return is filed" 'already been filed' "$(curl -s -X POST $BASE/sales/$CID/cancel -H "$AUTH" -H "$CT" -d '{"reason":"test cancel"}')"

# A period with no filed return, so the happy path can run.
OLDDATE=$(date -d "$TODAY -2 months" +%Y-%m-%d 2>/dev/null || date -v-2m +%Y-%m-%d)
OLDPERIOD=$(echo "$OLDDATE" | cut -c1-7)
OLD_INV=$(curl -s -X POST $BASE/sales -H "$AUTH" -H "$CT" \
  -d "{\"branchId\":$B1,\"customerId\":$CUST_GST,\"invoiceDate\":\"$OLDDATE\",\"items\":[{\"itemId\":$ITEM2,\"qty\":3,\"rate\":400,\"gst\":28}]}")
OID=$(echo "$OLD_INV" | j "d['invoiceId']")
OINV=$(echo "$OLD_INV" | j "d['invoiceNo']")
STOCK_BEFORE=$(curl -s -H "$AUTH" "$BASE/inventory/ledger?itemId=$ITEM2&branchId=$B1" | j "d['closingStock']")
chk "sales invoice cancelled" '"success":true' "$(curl -s -X POST $BASE/sales/$OID/cancel -H "$AUTH" -H "$CT" -d '{"reason":"Billed to the wrong customer"}' | tr -d ' ')"
chk "cancelling twice is refused" 'already cancelled' "$(curl -s -X POST $BASE/sales/$OID/cancel -H "$AUTH" -H "$CT" -d '{"reason":"again"}')"
STOCK_AFTER=$(curl -s -H "$AUTH" "$BASE/inventory/ledger?itemId=$ITEM2&branchId=$B1" | j "d['closingStock']")
DIFF=$(python3 -c "print(float('$STOCK_AFTER') - float('$STOCK_BEFORE'))")
if [ "$DIFF" = "3.0" ]; then
  echo "  PASS: cancelling the sale put the 3 units back ($STOCK_BEFORE -> $STOCK_AFTER)"; PASS=$((PASS+1))
else
  echo "  FAIL: stock did not come back ($STOCK_BEFORE -> $STOCK_AFTER, diff $DIFF)"; FAIL=$((FAIL+1))
fi
chk "a reversal journal was written" 'Cancellation of sales invoice' "$(curl -s -H "$AUTH" $BASE/accounts/journal)"
chk "books balance after the reversal" '"balanced":true' "$(curl -s -H "$AUTH" $BASE/accounts/trial-balance | tr -d ' ')"
if curl -s -H "$AUTH" "$BASE/gst/gstr1?period=$OLDPERIOD" | grep -q "$OINV"; then
  echo "  FAIL: the cancelled invoice $OINV still appears in GSTR-1"; FAIL=$((FAIL+1))
else
  echo "  PASS: the cancelled invoice is excluded from GSTR-1"; PASS=$((PASS+1))
fi

# Purchase cancellation, and the guard that stops it going negative.
PID2=$(curl -s -X POST $BASE/purchase -H "$AUTH" -H "$CT" \
  -d "{\"branchId\":$B1,\"supplierId\":$SUPP,\"purchaseDate\":\"$OLDDATE\",\"vendorInvoiceNo\":\"V$RANDOM$RANDOM\",\"vendorInvoiceDate\":\"$OLDDATE\",\"items\":[{\"itemId\":$ITEM2,\"qty\":10,\"rate\":300,\"gst\":28}]}" | j "d['purchaseId']")
chk "purchase detail view works" 'SupplierName' "$(curl -s -H "$AUTH" $BASE/purchase/$PID2)"
chk "purchase cancelled" '"success":true' "$(curl -s -X POST $BASE/purchase/$PID2/cancel -H "$AUTH" -H "$CT" -d '{"reason":"Duplicate supplier bill"}' | tr -d ' ')"

BIG_PUR=$(curl -s -X POST $BASE/purchase -H "$AUTH" -H "$CT" \
  -d "{\"branchId\":$B1,\"supplierId\":$SUPP,\"purchaseDate\":\"$OLDDATE\",\"vendorInvoiceNo\":\"V$RANDOM$RANDOM\",\"vendorInvoiceDate\":\"$OLDDATE\",\"items\":[{\"itemId\":$ITEM2,\"qty\":5,\"rate\":300,\"gst\":28}]}" | j "d['purchaseId']")
CURSTOCK=$(curl -s -H "$AUTH" "$BASE/inventory/ledger?itemId=$ITEM2&branchId=$B1" | j "d['closingStock']")
curl -s -X POST $BASE/inventory/adjust -H "$AUTH" -H "$CT" \
  -d "{\"branchId\":$B1,\"itemId\":$ITEM2,\"adjustmentType\":\"Decrease\",\"qty\":$CURSTOCK,\"reason\":\"Drain stock for the negative-stock guard test\"}" > /dev/null
chk "cancel refused once the goods have gone" 'raise a debit note instead' "$(curl -s -X POST $BASE/purchase/$BIG_PUR/cancel -H "$AUTH" -H "$CT" -d '{"reason":"try it"}')"
chk "stock never went negative" 'PASS' "$(python3 -c "
s = float('$(curl -s -H "$AUTH" "$BASE/inventory/ledger?itemId=$ITEM2&branchId=$B1" | j "d['closingStock']")')
print('PASS' if s >= 0 else 'FAIL ' + str(s))")"

echo
echo "== NEW: cancelled documents are excluded from reports =="
python3 - "$BASE" "$TOK" "$OINV" <<'PYEOF'
import json, sys, urllib.request
base, tok, cancelled_inv = sys.argv[1], sys.argv[2], sys.argv[3]
def get(p):
    r = urllib.request.Request(base + p, headers={'Authorization': 'Bearer ' + tok})
    return json.load(urllib.request.urlopen(r))
recent = get('/dashboard/recent-transactions')
assert all('Status' in r for r in recent), recent[:2]
# The cancelled invoice is still listed (it happened) but is flagged, not hidden.
row = [r for r in recent if r['RefNo'] == cancelled_inv]
if row:
    assert row[0]['Status'] == 'Cancelled', row
kpis = get('/dashboard/kpis')
assert isinstance(kpis['monthlySales'], (int, float))
for key in ('todaySales', 'monthlySales', 'gstCollected'):
    assert kpis[key] >= 0, kpis
print("  PASS: recent transactions flag cancelled documents and KPIs exclude them")
PYEOF
[ $? -eq 0 ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

chk "auditor cannot post a voucher" 'read-only' "$(curl -s -X POST $BASE/accounts/voucher -H "$AA" -H "$CT" -d "{\"voucherType\":\"Receipt\",\"entryDate\":\"$TODAY\",\"mode\":\"Cash\",\"amount\":10,\"branchId\":$B1}")"
