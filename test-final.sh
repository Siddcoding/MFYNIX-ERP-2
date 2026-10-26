# Tests for the final batch: credit/debit notes, receipt-with-allocation,
# year-end close with carry-forward, multi-company, banking and reports.
# Sourced by test-modules.sh, so it reuses that script's helpers and data.

echo
echo "== FINAL: credit and debit notes =="
NOTE_CUST=$(curl -s -X POST $BASE/masters/customers -H "$AUTH" -H "$CT" \
  -d "{\"CustomerName\":\"Return Co\",\"State\":\"Telangana\",\"CreditDays\":15,\"branchId\":$B1}" | j "d['id']")
curl -s -X POST $BASE/inventory/adjust -H "$AUTH" -H "$CT" \
  -d "{\"branchId\":$B1,\"itemId\":$ITEM,\"adjustmentType\":\"Increase\",\"qty\":200,\"reason\":\"Stock for note tests\"}" > /dev/null
N_INV=$(curl -s -X POST $BASE/sales -H "$AUTH" -H "$CT" \
  -d "{\"branchId\":$B1,\"customerId\":$NOTE_CUST,\"invoiceDate\":\"$TODAY\",\"items\":[{\"itemId\":$ITEM,\"qty\":20,\"rate\":100,\"gst\":18}]}")
N_INVID=$(echo "$N_INV" | j "d['invoiceId']")
echo "  invoice for the note tests: $(echo "$N_INV" | j "d['invoiceNo']") worth $(echo "$N_INV" | j "d['netAmount']")"

chk "reason is mandatory on a note" 'reason is required' "$(curl -s -X POST $BASE/notes -H "$AUTH" -H "$CT" \
  -d "{\"noteType\":\"Credit\",\"noteDate\":\"$TODAY\",\"partyId\":$NOTE_CUST,\"branchId\":$B1,\"items\":[{\"itemId\":$ITEM,\"qty\":1,\"rate\":100,\"gst\":18}]}")"
chk "note type is validated" "must be 'Credit' or 'Debit'" "$(curl -s -X POST $BASE/notes -H "$AUTH" -H "$CT" \
  -d "{\"noteType\":\"Sideways\",\"noteDate\":\"$TODAY\",\"partyId\":$NOTE_CUST,\"branchId\":$B1,\"reason\":\"x y z\",\"items\":[{\"itemId\":$ITEM,\"qty\":1,\"rate\":100,\"gst\":18}]}")"
chk "cannot credit more than was billed" 'uncredited' "$(curl -s -X POST $BASE/notes -H "$AUTH" -H "$CT" \
  -d "{\"noteType\":\"Credit\",\"noteDate\":\"$TODAY\",\"partyId\":$NOTE_CUST,\"againstDocId\":$N_INVID,\"branchId\":$B1,\"reason\":\"Too much\",\"items\":[{\"itemId\":$ITEM,\"qty\":500,\"rate\":100,\"gst\":18}]}")"

STOCK_BEFORE_CN=$(curl -s -H "$AUTH" "$BASE/inventory/ledger?itemId=$ITEM&branchId=$B1" | j "d['closingStock']")
CN=$(curl -s -X POST $BASE/notes -H "$AUTH" -H "$CT" \
  -d "{\"noteType\":\"Credit\",\"noteDate\":\"$TODAY\",\"partyId\":$NOTE_CUST,\"againstDocId\":$N_INVID,\"branchId\":$B1,\"reason\":\"5 units returned damaged\",\"items\":[{\"itemId\":$ITEM,\"qty\":5,\"rate\":100,\"gst\":18}]}")
echo "  credit note: $CN"
chk "credit note posted" 'noteNo' "$CN"
chk "credit note number uses the CN series" 'HYD-CN' "$CN"
STOCK_AFTER_CN=$(curl -s -H "$AUTH" "$BASE/inventory/ledger?itemId=$ITEM&branchId=$B1" | j "d['closingStock']")
DIFF_CN=$(python3 -c "print(round(float('$STOCK_AFTER_CN') - float('$STOCK_BEFORE_CN'), 2))")
if [ "$DIFF_CN" = "5.0" ]; then
  echo "  PASS: the credit note put 5 units back into stock ($STOCK_BEFORE_CN -> $STOCK_AFTER_CN)"; PASS=$((PASS+1))
else
  echo "  FAIL: stock did not come back ($STOCK_BEFORE_CN -> $STOCK_AFTER_CN, diff $DIFF_CN)"; FAIL=$((FAIL+1))
fi

# The note must reduce what the customer owes, and the books must still balance.
python3 - "$BASE" "$TOK" "$NOTE_CUST" "$N_INVID" <<'PYEOF'
import json, sys, urllib.request
base, tok, cust, inv = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
def get(p):
    r = urllib.request.Request(base + p, headers={'Authorization': 'Bearer ' + tok})
    return json.load(urllib.request.urlopen(r))
d = get(f'/outstanding/customers/{cust}')
doc = next((x for x in d['documents'] if x['DocID'] == inv), None)
assert doc, 'the invoice vanished from outstanding'
# Invoice was 20 x 100 + 18% = 2360. Credit note 5 x 100 + 18% = 590. Open = 1770.
assert abs(doc['NetAmount'] - 2360) < 0.01, doc
assert abs(doc['Allocated'] - 590) < 0.01, doc
assert abs(doc['OpenAmount'] - 1770) < 0.01, doc
tb = get('/accounts/trial-balance')
assert tb['balanced'], tb
print("  PASS: the credit note reduced the invoice from 2360 to 1770 open, and the books still balance")
PYEOF
[ $? -eq 0 ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

chk "a price allowance moves no stock" 'noteNo' "$(curl -s -X POST $BASE/notes -H "$AUTH" -H "$CT" \
  -d "{\"noteType\":\"Credit\",\"noteDate\":\"$TODAY\",\"partyId\":$NOTE_CUST,\"againstDocId\":$N_INVID,\"branchId\":$B1,\"reason\":\"Price allowance, no goods back\",\"restoreStock\":false,\"items\":[{\"itemId\":$ITEM,\"qty\":1,\"rate\":100,\"gst\":18}]}")"
STOCK_AFTER_ALLOW=$(curl -s -H "$AUTH" "$BASE/inventory/ledger?itemId=$ITEM&branchId=$B1" | j "d['closingStock']")
if [ "$STOCK_AFTER_ALLOW" = "$STOCK_AFTER_CN" ]; then
  echo "  PASS: a pure price allowance left stock untouched at $STOCK_AFTER_ALLOW"; PASS=$((PASS+1))
else
  echo "  FAIL: allowance changed stock ($STOCK_AFTER_CN -> $STOCK_AFTER_ALLOW)"; FAIL=$((FAIL+1))
fi

# A debit note sends goods back to the supplier, so stock must be available.
D_PUR=$(curl -s -X POST $BASE/purchase -H "$AUTH" -H "$CT" \
  -d "{\"branchId\":$B1,\"supplierId\":$SUPP,\"purchaseDate\":\"$TODAY\",\"vendorInvoiceNo\":\"V$RANDOM$RANDOM\",\"vendorInvoiceDate\":\"$TODAY\",\"items\":[{\"itemId\":$ITEM,\"qty\":10,\"rate\":50,\"gst\":18}]}" | j "d['purchaseId']")
chk "debit note posted" 'HYD-DN' "$(curl -s -X POST $BASE/notes -H "$AUTH" -H "$CT" \
  -d "{\"noteType\":\"Debit\",\"noteDate\":\"$TODAY\",\"partyId\":$SUPP,\"againstDocId\":$D_PUR,\"branchId\":$B1,\"reason\":\"3 units returned to supplier\",\"items\":[{\"itemId\":$ITEM,\"qty\":3,\"rate\":50,\"gst\":18}]}")"
chk "notes list works" 'NoteNo' "$(curl -s -H "$AUTH" $BASE/notes)"
chk "auditor cannot raise a note" 'read-only' "$(curl -s -X POST $BASE/notes -H "$AA" -H "$CT" \
  -d "{\"noteType\":\"Credit\",\"noteDate\":\"$TODAY\",\"partyId\":$NOTE_CUST,\"branchId\":$B1,\"reason\":\"nope nope\",\"items\":[{\"itemId\":$ITEM,\"qty\":1,\"rate\":10,\"gst\":0}]}")"

echo
echo "== FINAL: receipt with allocation in one step =="
S_CUST=$(curl -s -X POST $BASE/masters/customers -H "$AUTH" -H "$CT" \
  -d "{\"CustomerName\":\"Settle Co\",\"State\":\"Telangana\",\"branchId\":$B1}" | j "d['id']")
S1_INV=$(curl -s -X POST $BASE/sales -H "$AUTH" -H "$CT" \
  -d "{\"branchId\":$B1,\"customerId\":$S_CUST,\"invoiceDate\":\"$TODAY\",\"items\":[{\"itemId\":$ITEM,\"qty\":3,\"rate\":100,\"gst\":0}]}" | j "d['invoiceId']")
S2_INV=$(curl -s -X POST $BASE/sales -H "$AUTH" -H "$CT" \
  -d "{\"branchId\":$B1,\"customerId\":$S_CUST,\"invoiceDate\":\"$TODAY\",\"items\":[{\"itemId\":$ITEM,\"qty\":2,\"rate\":100,\"gst\":0}]}" | j "d['invoiceId']")

chk "amount and allocation must agree" 'must match' "$(curl -s -X POST $BASE/accounts/settle -H "$AUTH" -H "$CT" \
  -d "{\"voucherType\":\"Receipt\",\"entryDate\":\"$TODAY\",\"mode\":\"Bank\",\"partyType\":\"Customer\",\"partyId\":$S_CUST,\"amount\":999,\"branchId\":$B1,\"allocations\":[{\"docType\":\"SalesInvoice\",\"docId\":$S1_INV,\"amount\":300}]}")"
chk "a Receipt must be against a Customer" 'against a Customer' "$(curl -s -X POST $BASE/accounts/settle -H "$AUTH" -H "$CT" \
  -d "{\"voucherType\":\"Receipt\",\"entryDate\":\"$TODAY\",\"mode\":\"Bank\",\"partyType\":\"Supplier\",\"partyId\":$SUPP,\"amount\":100,\"branchId\":$B1,\"allocations\":[{\"docType\":\"SalesInvoice\",\"docId\":$S1_INV,\"amount\":100}]}")"
chk "cannot settle more than is open" 'only' "$(curl -s -X POST $BASE/accounts/settle -H "$AUTH" -H "$CT" \
  -d "{\"voucherType\":\"Receipt\",\"entryDate\":\"$TODAY\",\"mode\":\"Bank\",\"partyType\":\"Customer\",\"partyId\":$S_CUST,\"amount\":9999,\"branchId\":$B1,\"allocations\":[{\"docType\":\"SalesInvoice\",\"docId\":$S1_INV,\"amount\":9999}]}")"

SETTLED=$(curl -s -X POST $BASE/accounts/settle -H "$AUTH" -H "$CT" \
  -d "{\"voucherType\":\"Receipt\",\"entryDate\":\"$TODAY\",\"mode\":\"Bank\",\"partyType\":\"Customer\",\"partyId\":$S_CUST,\"amount\":500,\"branchId\":$B1,\"allocations\":[{\"docType\":\"SalesInvoice\",\"docId\":$S1_INV,\"amount\":300},{\"docType\":\"SalesInvoice\",\"docId\":$S2_INV,\"amount\":200}]}")
echo "  settled: $SETTLED"
chk "receipt posted and allocated together" '"settled":2' "$(echo "$SETTLED" | tr -d ' ')"

python3 - "$BASE" "$TOK" "$S_CUST" <<'PYEOF'
import json, sys, urllib.request
base, tok, cust = sys.argv[1], sys.argv[2], sys.argv[3]
def get(p):
    r = urllib.request.Request(base + p, headers={'Authorization': 'Bearer ' + tok})
    return json.load(urllib.request.urlopen(r))
d = get(f'/outstanding/customers/{cust}')
assert d['totalOpen'] == 0, d          # 300 + 200 billed, both fully settled
tb = get('/accounts/trial-balance')
assert tb['balanced'], tb
print("  PASS: one save posted the money AND cleared both invoices; nothing is left open and the books balance")
PYEOF
[ $? -eq 0 ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

# A rejected allocation must not leave the money posted either.
BEFORE_TB=$(curl -s -H "$AUTH" $BASE/accounts/trial-balance | j "d['totalDebit']")
curl -s -X POST $BASE/accounts/settle -H "$AUTH" -H "$CT" \
  -d "{\"voucherType\":\"Receipt\",\"entryDate\":\"$TODAY\",\"mode\":\"Bank\",\"partyType\":\"Customer\",\"partyId\":$S_CUST,\"amount\":50,\"branchId\":$B1,\"allocations\":[{\"docType\":\"SalesInvoice\",\"docId\":$S1_INV,\"amount\":50}]}" > /dev/null
AFTER_TB=$(curl -s -H "$AUTH" $BASE/accounts/trial-balance | j "d['totalDebit']")
if [ "$BEFORE_TB" = "$AFTER_TB" ]; then
  echo "  PASS: a rejected settlement posted nothing at all (trial balance unchanged)"; PASS=$((PASS+1))
else
  echo "  FAIL: a rejected settlement still moved the books ($BEFORE_TB -> $AFTER_TB)"; FAIL=$((FAIL+1))
fi

echo
echo "== FINAL: banking =="
# Statement dates are relative to today: the suggestion window is days-based, so a
# hard-coded August date silently stopped matching once the calendar moved on.
TDMY=$(date +%d/%m/%Y)
BANK_ACC=$(curl -s -X POST $BASE/banking/accounts -H "$AUTH" -H "$CT" \
  -d "{\"accountName\":\"Current Account\",\"bankName\":\"Test Bank\",\"accountNo\":\"1234567890\",\"branchId\":$B1}" | j "d['bankAccountId']")
chk "bank account created" '[0-9]' "$BANK_ACC"
chk "bank accounts list" 'AccountName' "$(curl -s -H "$AUTH" $BASE/banking/accounts)"

IMPORTED=$(curl -s -X POST $BASE/banking/import -H "$AUTH" -H "$CT" -d "{
  \"bankAccountId\": $BANK_ACC,
  \"hasHeader\": true,
  \"dateFormat\": \"DD/MM/YYYY\",
  \"mapping\": {\"date\":0,\"description\":1,\"ref\":2,\"debit\":3,\"credit\":4,\"balance\":5},
  \"rows\": [
    [\"Date\",\"Narration\",\"Ref\",\"Withdrawal\",\"Deposit\",\"Balance\"],
    [\"$TDMY\",\"NEFT from Settle Co\",\"UTR001\",\"\",\"500.00\",\"10500.00\"],
    [\"$TDMY\",\"Bank charges\",\"CHG01\",\"118.00\",\"\",\"10382.00\"],
    [\"$TDMY\",\"Cheque paid\",\"CHQ55\",\"1,200.00\",\"\",\"9182.00\"],
    [\"not-a-date\",\"Garbage row\",\"\",\"10\",\"\",\"\"]
  ]}")
echo "  import: $IMPORTED"
chk "good rows imported" '"imported":3' "$(echo "$IMPORTED" | tr -d ' ')"
chk "unreadable row reported, not silently dropped" '"skipped":1' "$(echo "$IMPORTED" | tr -d ' ')"
chk "the problem is explained" 'could not read the date' "$IMPORTED"

REIMPORT=$(curl -s -X POST $BASE/banking/import -H "$AUTH" -H "$CT" -d "{
  \"bankAccountId\": $BANK_ACC, \"hasHeader\": true, \"dateFormat\": \"DD/MM/YYYY\",
  \"mapping\": {\"date\":0,\"description\":1,\"ref\":2,\"debit\":3,\"credit\":4,\"balance\":5},
  \"rows\": [
    [\"Date\",\"Narration\",\"Ref\",\"Withdrawal\",\"Deposit\",\"Balance\"],
    [\"$TDMY\",\"NEFT from Settle Co\",\"UTR001\",\"\",\"500.00\",\"10500.00\"]
  ]}")
chk "re-importing the same file does not duplicate" '"duplicates":1' "$(echo "$REIMPORT" | tr -d ' ')"

LINE_ID=$(curl -s -H "$AUTH" "$BASE/banking/statement/$BANK_ACC?status=Unmatched" | j "[l['StatementLineID'] for l in d['rows'] if l['Credit']==500][0]")
SUGG=$(curl -s -H "$AUTH" "$BASE/banking/statement/line/$LINE_ID/suggestions?days=60")
echo "  suggestions for the 500 credit: $(echo "$SUGG" | j "len(d['suggestions'])")"
chk "the matching receipt is suggested" 'Settle Co' "$SUGG"
SUGG_JID=$(echo "$SUGG" | j "d['suggestions'][0]['JournalID']")
chk "line matched" 'success' "$(curl -s -X POST $BASE/banking/statement/line/$LINE_ID/match -H "$AUTH" -H "$CT" -d "{\"journalId\":$SUGG_JID}")"
chk "the same journal cannot match twice" 'already matched to another' "$(curl -s -X POST $BASE/banking/statement/line/$(curl -s -H "$AUTH" "$BASE/banking/statement/$BANK_ACC?status=Unmatched" | j "d['rows'][0]['StatementLineID']")/match -H "$AUTH" -H "$CT" -d "{\"journalId\":$SUGG_JID}")"

# Bank charges only ever exist on the statement, so post them from there.
CHG_LINE=$(curl -s -H "$AUTH" "$BASE/banking/statement/$BANK_ACC?status=Unmatched" | j "[l['StatementLineID'] for l in d['rows'] if l['Debit']==118][0]")
EXP_ACC=$(curl -s -H "$AUTH" $BASE/accounts/accounts | j "[a['AccountID'] for a in d if a['AccountCode']=='5900'][0]")
chk "bank charge posted from the statement" 'journalId' "$(curl -s -X POST $BASE/banking/statement/line/$CHG_LINE/post -H "$AUTH" -H "$CT" -d "{\"contraAccountId\":$EXP_ACC,\"narration\":\"Bank charges\"}")"
# A company-wide bank account has no branch, and a head-office user has none
# either - posting must still work by falling back to the head office branch.
WIDE_ACC=$(curl -s -X POST $BASE/banking/accounts -H "$AUTH" -H "$CT" \
  -d '{"accountName":"Company-wide Account","bankName":"Wide Bank"}' | j "d['bankAccountId']")
curl -s -X POST $BASE/banking/import -H "$AUTH" -H "$CT" -d "{
  \"bankAccountId\": $WIDE_ACC, \"hasHeader\": false, \"dateFormat\": \"DD/MM/YYYY\",
  \"mapping\": {\"date\":0,\"description\":1,\"debit\":2,\"credit\":3},
  \"rows\": [[\"09/08/2026\",\"Company-wide bank charge\",\"75.00\",\"\"]]}" > /dev/null
WIDE_LINE=$(curl -s -H "$AUTH" "$BASE/banking/statement/$WIDE_ACC?status=Unmatched" | j "d['rows'][0]['StatementLineID']")
chk "a company-wide account can still post" 'journalId' "$(curl -s -X POST $BASE/banking/statement/line/$WIDE_LINE/post -H "$AUTH" -H "$CT" -d "{\"contraAccountId\":$EXP_ACC}")"
chk "the bank account itself is refused as the other side" 'cannot be the bank account' "$(curl -s -X POST $BASE/banking/statement/line/$(curl -s -H "$AUTH" "$BASE/banking/statement/$BANK_ACC?status=Unmatched" | j "d['rows'][0]['StatementLineID']")/post -H "$AUTH" -H "$CT" -d "{\"contraAccountId\":$(curl -s -H "$AUTH" $BASE/accounts/accounts | j "[a['AccountID'] for a in d if a['AccountCode']=='1010'][0]")}")"
RECON=$(curl -s -H "$AUTH" $BASE/banking/reconciliation/$BANK_ACC)
echo "  reconciliation: statement $(echo "$RECON" | j "d['statementBalance']") vs books $(echo "$RECON" | j "d['bookBalance']"), diff $(echo "$RECON" | j "d['difference']")"
chk "reconciliation summary works" 'unmatchedCount' "$RECON"
chk "books still balance after banking" '"balanced":true' "$(curl -s -H "$AUTH" $BASE/accounts/trial-balance | tr -d ' ')"

echo
echo "== FINAL: reports =="
chk "report list" 'day-book' "$(curl -s -H "$AUTH" $BASE/reports)"
for R in day-book cash-flow sales-register purchase-register item-sales stock-valuation stock-movement; do
  OUT=$(curl -s -H "$AUTH" "$BASE/reports/$R")
  if echo "$OUT" | grep -q '"columns"'; then echo "  PASS: report $R returns rows and columns"; PASS=$((PASS+1));
  else echo "  FAIL: report $R -> $(echo "$OUT" | head -c 120)"; FAIL=$((FAIL+1)); fi
done
chk "party ledger needs a party" 'partyId is required' "$(curl -s -H "$AUTH" "$BASE/reports/party-ledger")"
chk "party ledger runs" 'Balance' "$(curl -s -H "$AUTH" "$BASE/reports/party-ledger?partyType=Customer&partyId=$NOTE_CUST")"
chk "CSV export works for any report" 'Sales Register' "$(curl -s -H "$AUTH" "$BASE/reports/sales-register/export.csv")"
chk "dead stock is categorised" 'Dead' "$(curl -s -H "$AUTH" "$BASE/reports/stock-movement?days=1")"
# Cash flow must agree with the cash and bank ledger movement.
python3 - "$BASE" "$TOK" <<'PYEOF'
import json, sys, urllib.request
base, tok = sys.argv[1], sys.argv[2]
def get(p):
    r = urllib.request.Request(base + p, headers={'Authorization': 'Bearer ' + tok})
    return json.load(urllib.request.urlopen(r))
cf = get('/reports/cash-flow?from=2000-01-01&to=2099-12-31')
# Opening is before all time, so closing must equal net movement.
assert abs(cf['closingCash'] - cf['totals']['Net']) < 0.02, (cf['closingCash'], cf['totals']['Net'])
print(f"  PASS: cash flow net movement {cf['totals']['Net']} equals the closing cash position {cf['closingCash']}")
PYEOF
[ $? -eq 0 ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))
chk "a cashier cannot open Reports" 'do not have access' "$(curl -s -H "$CA" $BASE/reports)"

echo
echo "== FINAL: multi-company =="
NEWCO=$(curl -s -X POST $BASE/admin/companies -H "$AUTH" -H "$CT" \
  -d '{"companyName":"Northern Traders Pvt Ltd","branchName":"Delhi Head Office","branchCode":"DEL","adminUserName":"northadmin","adminPassword":"North@12345","state":"Delhi"}')
chk "company created" 'companyId' "$NEWCO"
chk "short admin password refused" 'at least 8' "$(curl -s -X POST $BASE/admin/companies -H "$AUTH" -H "$CT" \
  -d '{"companyName":"Weak Co","branchName":"HO","branchCode":"WK","adminUserName":"weakadmin","adminPassword":"123"}')"
chk "duplicate username refused" 'already taken' "$(curl -s -X POST $BASE/admin/companies -H "$AUTH" -H "$CT" \
  -d '{"companyName":"Dup Co","branchName":"HO","branchCode":"DP","adminUserName":"northadmin","adminPassword":"Dup@123456"}')"
NTOK=$(utok northadmin North@12345)
chk "the new company's admin can sign in" '.' "$NTOK"
NA="Authorization: Bearer $NTOK"
# The whole point of multi-company: the new company must see none of the first one's data.
python3 - "$BASE" "$NTOK" <<'PYEOF'
import json, sys, urllib.request
base, tok = sys.argv[1], sys.argv[2]
def get(p):
    r = urllib.request.Request(base + p, headers={'Authorization': 'Bearer ' + tok})
    return json.load(urllib.request.urlopen(r))
assert get('/sales')['total'] == 0, 'new company can see another company\'s invoices'
assert len(get('/masters/customers')) == 0, 'new company can see another company\'s customers'
coa = get('/accounts/accounts')
assert len(coa) >= 20, f'new company did not get a chart of accounts ({len(coa)})'
fy = get('/admin/financial-years')
assert len(fy) == 1 and fy[0]['IsActive'], fy
branches = get('/branches')
assert len(branches) == 1 and branches[0]['BranchCode'] == 'DEL', branches
print("  PASS: the new company is fully isolated, with its own chart of accounts, financial year and branch")
PYEOF
[ $? -eq 0 ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))
chk "only a Super Admin can add companies" 'Insufficient permissions' "$(curl -s -X POST $BASE/admin/companies -H "$PA" -H "$CT" \
  -d '{"companyName":"Sneaky Co","branchName":"HO","branchCode":"SN","adminUserName":"sneaky","adminPassword":"Sneak@1234"}')"

echo
echo "== FINAL: backup =="
chk "backup info" 'sizeBytes' "$(curl -s -H "$AUTH" $BASE/admin/backup/info)"
curl -s -H "$AUTH" $BASE/admin/backup -o /tmp/mfbackup.db
BSIZE=$(stat -c%s /tmp/mfbackup.db 2>/dev/null || stat -f%z /tmp/mfbackup.db)
if [ "$BSIZE" -gt 20000 ]; then
  echo "  PASS: backup downloaded, $BSIZE bytes"; PASS=$((PASS+1))
else
  echo "  FAIL: backup looks empty ($BSIZE bytes)"; FAIL=$((FAIL+1))
fi
# The backup must be a real, openable database with the data in it.
python3 - <<'PYEOF'
import sqlite3
con = sqlite3.connect('/tmp/mfbackup.db')
tables = [r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")]
assert 'SalesHeader' in tables and 'JournalEntry' in tables, tables
n = con.execute('SELECT COUNT(*) FROM SalesHeader').fetchone()[0]
assert n > 0, 'backup has no sales data'
print(f"  PASS: the backup opens as a real database and contains {n} sales invoices")
PYEOF
[ $? -eq 0 ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))
rm -f /tmp/mfbackup.db
chk "only a Super Admin can take a backup" 'Insufficient permissions' "$(curl -s -H "$PA" $BASE/admin/backup)"

echo
echo "== FINAL: year-end close with carry-forward =="
# Build a clean company so the close can be asserted precisely.
YE=$(curl -s -X POST $BASE/admin/companies -H "$AUTH" -H "$CT" \
  -d '{"companyName":"YearEnd Test Ltd","branchName":"Test HO","branchCode":"YE","adminUserName":"yeadmin","adminPassword":"Year@123456","state":"Odisha"}')
YTOK=$(utok yeadmin Year@123456)
YA="Authorization: Bearer $YTOK"
YB=$(curl -s -H "$YA" $BASE/branches | j "d[0]['BranchID']")
YFY=$(curl -s -H "$YA" $BASE/admin/financial-years | j "d[0]")
YFY_ID=$(curl -s -H "$YA" $BASE/admin/financial-years | j "d[0]['FinancialYearID']")
YFY_START=$(curl -s -H "$YA" $BASE/admin/financial-years | j "d[0]['StartDate']")
YCUST=$(curl -s -X POST $BASE/masters/customers -H "$YA" -H "$CT" -d "{\"CustomerName\":\"YE Customer\",\"State\":\"Odisha\",\"branchId\":$YB}" | j "d['id']")
YITEM=$(curl -s -X POST $BASE/masters/items -H "$YA" -H "$CT" -d '{"ItemName":"YE Widget","GSTRate":0,"Unit":"PCS","PurchaseRate":40,"SaleRate":100}' | j "d['id']")
curl -s -X POST $BASE/inventory/adjust -H "$YA" -H "$CT" -d "{\"branchId\":$YB,\"itemId\":$YITEM,\"adjustmentType\":\"Opening Stock\",\"qty\":100,\"reason\":\"Opening for year-end test\"}" > /dev/null
# One sale of 1000 inside the year, and one expense of 300.
curl -s -X POST $BASE/sales -H "$YA" -H "$CT" \
  -d "{\"branchId\":$YB,\"customerId\":$YCUST,\"invoiceDate\":\"$YFY_START\",\"items\":[{\"itemId\":$YITEM,\"qty\":10,\"rate\":100,\"gst\":0}]}" > /dev/null
RENT=$(curl -s -H "$YA" $BASE/accounts/accounts | j "[a['AccountID'] for a in d if a['AccountCode']=='5200'][0]")
CASH=$(curl -s -H "$YA" $BASE/accounts/accounts | j "[a['AccountID'] for a in d if a['AccountCode']=='1000'][0]")
curl -s -X POST $BASE/accounts/journal -H "$YA" -H "$CT" \
  -d "{\"branchId\":$YB,\"entryDate\":\"$YFY_START\",\"narration\":\"Rent\",\"lines\":[{\"accountId\":$RENT,\"debit\":300,\"credit\":0},{\"accountId\":$CASH,\"debit\":0,\"credit\":300}]}" > /dev/null

chk "close needs a following year to exist" 'Create the following financial year first' "$(curl -s -X POST $BASE/admin/financial-years/$YFY_ID/close-with-carryforward -H "$YA" -H "$CT" -d '{}')"
curl -s -X POST $BASE/admin/financial-years -H "$YA" -H "$CT" \
  -d '{"yearName":"2027-28","startDate":"2027-04-01","endDate":"2028-03-31"}' > /dev/null
CLOSED=$(curl -s -X POST $BASE/admin/financial-years/$YFY_ID/close-with-carryforward -H "$YA" -H "$CT" -d '{}')
echo "  year-end close: $CLOSED"
chk "year closed with a profit figure" 'netProfit' "$CLOSED"

python3 - "$BASE" "$YTOK" <<'PYEOF'
import json, sys, urllib.request
base, tok = sys.argv[1], sys.argv[2]
def get(p):
    r = urllib.request.Request(base + p, headers={'Authorization': 'Bearer ' + tok})
    return json.load(urllib.request.urlopen(r))
years = get('/admin/financial-years')
closed = [y for y in years if y['IsClosed']][0]
active = [y for y in years if y['IsActive']][0]
assert active['YearName'] == '2027-28', active
assert closed['ClosingJournalID'], 'no closing journal was recorded'

# Sales 1000, rent 300, COGS on 10 units @ 40 = 400 -> profit 300 (perpetual inventory).
pl = get(f"/accounts/profit-loss?from={closed['StartDate']}&to={closed['EndDate']}")
# After closing, income and expense inside the year net to zero.
assert abs(pl['netProfit']) < 0.01, f"P&L should be flat after closing, got {pl['netProfit']}"

ob = get(f"/admin/financial-years/{active['FinancialYearID']}/opening-balances")
assert ob['balanced'], ob
assert ob['rows'], 'no opening balances were carried forward'
retained = [r for r in ob['rows'] if r['AccountCode'] == '3100']
assert retained and abs(retained[0]['Credit'] - 300) < 0.01, retained
tb = get('/accounts/trial-balance')
assert tb['balanced'], tb
print("  PASS: closing zeroed the P&L, moved 300 profit into Retained Earnings, carried a balanced set of openings into 2027-28, and the books still balance")
PYEOF
[ $? -eq 0 ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))
chk "postings into the closed year are refused" 'is closed' "$(curl -s -X POST $BASE/sales -H "$YA" -H "$CT" \
  -d "{\"branchId\":$YB,\"customerId\":$YCUST,\"invoiceDate\":\"$YFY_START\",\"items\":[{\"itemId\":$YITEM,\"qty\":1,\"rate\":10,\"gst\":0}]}")"
chk "closing twice is refused" 'already closed' "$(curl -s -X POST $BASE/admin/financial-years/$YFY_ID/close-with-carryforward -H "$YA" -H "$CT" -d '{}')"
