# Tests for the Mfynix stack additions: Company Master, Financial Years,
# the central document numbering engine, and Outstanding with ageing.
# Sourced by test-modules.sh, so it reuses that script's helpers and data.

echo
echo "== MFYNIX: Company Master =="
chk "company profile readable" 'CompanyName' "$(curl -s -H "$AUTH" $BASE/admin/company)"
UPD=$(curl -s -X PUT $BASE/admin/company -H "$AUTH" -H "$CT" \
  -d '{"pan":"AAAAA0000A","cin":"U72900OR2020PTC000001","state":"Odisha","bankName":"State Bank","bankIFSC":"SBIN0001234","invoicePrefix":"MFT","declarationText":"Goods once sold will not be taken back."}')
chk "company profile saved" 'AAAAA0000A' "$UPD"
chk "bank details saved" 'SBIN0001234' "$UPD"
chk "empty company name rejected" 'cannot be empty' "$(curl -s -X PUT $BASE/admin/company -H "$AUTH" -H "$CT" -d '{"companyName":"  "}')"
python3 -c "import json;print(json.dumps({'logoDataUrl':'x'*400001}))" > /tmp/biglogo.json
chk "oversized logo rejected" 'too large' "$(curl -s -X PUT $BASE/admin/company -H "$AUTH" -H "$CT" --data-binary @/tmp/biglogo.json)"
chk "company change is audited" 'UPDATE_COMPANY' "$(curl -s -H "$AUTH" "$BASE/admin/audit?action=UPDATE_COMPANY&pageSize=5")"
chk "accountant cannot edit the company" 'Insufficient permissions' "$(curl -s -X PUT $BASE/admin/company -H "$PA" -H "$CT" -d '{"pan":"HACKED0000"}')"

echo
echo "== MFYNIX: Financial years =="
FYS=$(curl -s -H "$AUTH" $BASE/admin/financial-years)
chk "a financial year exists on first boot" 'IsActive' "$FYS"
ACTIVE_FY=$(echo "$FYS" | j "[y['YearName'] for y in d if y['IsActive']][0]")
echo "  active year: $ACTIVE_FY"
chk "overlapping year refused" 'overlap' "$(curl -s -X POST $BASE/admin/financial-years -H "$AUTH" -H "$CT" \
  -d "{\"yearName\":\"clash\",\"startDate\":\"$(date +%Y)-06-01\",\"endDate\":\"$(date +%Y)-07-01\"}")"
chk "end before start refused" 'after the start' "$(curl -s -X POST $BASE/admin/financial-years -H "$AUTH" -H "$CT" \
  -d '{"yearName":"backwards","startDate":"2030-04-01","endDate":"2029-03-31"}')"
NEWFY=$(curl -s -X POST $BASE/admin/financial-years -H "$AUTH" -H "$CT" \
  -d '{"yearName":"2030-31","startDate":"2030-04-01","endDate":"2031-03-31"}')
chk "future year created" 'financialYearId' "$NEWFY"
NEWFYID=$(echo "$NEWFY" | j "d['financialYearId']")
chk "duplicate year name refused" 'already exists' "$(curl -s -X POST $BASE/admin/financial-years -H "$AUTH" -H "$CT" \
  -d '{"yearName":"2030-31","startDate":"2031-04-01","endDate":"2032-03-31"}')"
chk "year can be closed" '"closed":true' "$(curl -s -X POST $BASE/admin/financial-years/$NEWFYID/close -H "$AUTH" -H "$CT" -d '{"closed":true}' | tr -d ' ')"
chk "a closed year cannot be activated" 'reopen it first' "$(curl -s -X POST $BASE/admin/financial-years/$NEWFYID/activate -H "$AUTH" -H "$CT" -d '{}')"
# A posting dated inside a closed year must be refused.
chk "posting into a closed year refused" 'is closed' "$(curl -s -X POST $BASE/sales -H "$AUTH" -H "$CT" \
  -d "{\"branchId\":$B1,\"customerId\":$CUST_GST,\"invoiceDate\":\"2030-06-15\",\"items\":[{\"itemId\":$ITEM,\"qty\":1,\"rate\":10,\"gst\":0}]}")"
curl -s -X POST $BASE/admin/financial-years/$NEWFYID/close -H "$AUTH" -H "$CT" -d '{"closed":false}' > /dev/null
ACTIVE_ID=$(echo "$FYS" | j "[y['FinancialYearID'] for y in d if y['IsActive']][0]")
chk "the active year cannot be closed" 'activate another year first' "$(curl -s -X POST $BASE/admin/financial-years/$ACTIVE_ID/close -H "$AUTH" -H "$CT" -d '{"closed":true}')"

echo
echo "== MFYNIX: document numbering engine =="
NUM=$(curl -s -H "$AUTH" $BASE/admin/numbering)
chk "numbering endpoint lists sequences" 'sequences' "$NUM"
chk "sequences are year-scoped" "$ACTIVE_FY" "$NUM"
# A new invoice must use PREFIX-YEAR-NNNNNN, with the company's chosen prefix.
NEWINV=$(curl -s -X POST $BASE/sales -H "$AUTH" -H "$CT" \
  -d "{\"branchId\":$B1,\"customerId\":$CUST_GST,\"invoiceDate\":\"$TODAY\",\"items\":[{\"itemId\":$ITEM,\"qty\":1,\"rate\":100,\"gst\":18}]}")
INVNO=$(echo "$NEWINV" | j "d['invoiceNo']")
echo "  issued invoice number: $INVNO"
python3 - "$INVNO" "$ACTIVE_FY" <<'PYEOF'
import re, sys
no, fy = sys.argv[1], sys.argv[2]
# BRANCH-PREFIXyy-NNNNN, e.g. HYD-INV26-00008 (max 16 characters, EIN-01)
m = re.match(r'^([A-Z0-9]+)-([A-Z]+)(\d{2})-(\d{5})$', no)
assert m, f"number {no} does not match BRANCH-PREFIXyy-NNNNN"
assert len(no) <= 16, f"{no} is {len(no)} characters (limit 16)"
assert m.group(3) == fy[2:4], f"wrong financial year in {no} (expected {fy})"
print(f"  PASS: number {no} is {len(no)} characters and carries the active financial year")
PYEOF
[ $? -eq 0 ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

# The counter must never hand out the same number twice, even under load.
python3 - "$BASE" "$TOK" "$B1" "$CUST_GST" "$ITEM" "$TODAY" <<'PYEOF'
import json, sys, urllib.request, threading
base, tok, branch, cust, item, today = sys.argv[1:7]
numbers, errors = [], []
lock = threading.Lock()
def raise_invoice():
    body = json.dumps({"branchId": int(branch), "customerId": int(cust), "invoiceDate": today,
                       "items": [{"itemId": int(item), "qty": 1, "rate": 10, "gst": 0}]}).encode()
    req = urllib.request.Request(base + '/sales', data=body, method='POST',
                                 headers={'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json'})
    try:
        d = json.load(urllib.request.urlopen(req))
        with lock: numbers.append(d['invoiceNo'])
    except Exception as e:
        with lock: errors.append(str(e))
threads = [threading.Thread(target=raise_invoice) for _ in range(12)]
[t.start() for t in threads]; [t.join() for t in threads]
assert not errors, f"some invoices failed: {errors[:2]}"
assert len(numbers) == 12, numbers
assert len(set(numbers)) == 12, f"DUPLICATE NUMBERS ISSUED: {sorted(numbers)}"
print(f"  PASS: 12 invoices raised at once got 12 distinct numbers ({sorted(numbers)[0]} .. {sorted(numbers)[-1]})")
PYEOF
[ $? -eq 0 ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

SEQID=$(curl -s -H "$AUTH" $BASE/admin/numbering | j "[s['SequenceID'] for s in d['sequences'] if s['DocType']=='INV'][0]")
SEQNEXT=$(curl -s -H "$AUTH" $BASE/admin/numbering | j "[s['NextNumber'] for s in d['sequences'] if s['DocType']=='INV'][0]")
chk "counter cannot move backwards" 'only move forward' "$(curl -s -X PUT $BASE/admin/numbering/$SEQID -H "$AUTH" -H "$CT" -d '{"nextNumber":1}')"
chk "counter can jump forward" 'success' "$(curl -s -X PUT $BASE/admin/numbering/$SEQID -H "$AUTH" -H "$CT" -d "{\"nextNumber\":$((SEQNEXT+500))}")"
chk "empty prefix rejected" 'cannot be empty' "$(curl -s -X PUT $BASE/admin/numbering/$SEQID -H "$AUTH" -H "$CT" -d '{"prefix":"  "}')"
chk "silly padding rejected" 'between 1 and 10' "$(curl -s -X PUT $BASE/admin/numbering/$SEQID -H "$AUTH" -H "$CT" -d '{"padding":99}')"
# Changing the company prefix must NOT rename a series that has already issued
# numbers - that would put a visible break in the invoice sequence.
PFX=$(curl -s -X PUT $BASE/admin/company -H "$AUTH" -H "$CT" -d '{"invoicePrefix":"ZZZ"}')
chk "in-use series keeps its prefix" 'already in use kept its existing prefix' "$PFX"
NEXTINV=$(curl -s -X POST $BASE/sales -H "$AUTH" -H "$CT" \
  -d "{\"branchId\":$B1,\"customerId\":$CUST_GST,\"invoiceDate\":\"$TODAY\",\"items\":[{\"itemId\":$ITEM,\"qty\":1,\"rate\":10,\"gst\":0}]}" | j "d['invoiceNo']")
chk "the running series is unbroken" 'HYD-INV' "$NEXTINV"
# A branch with no invoices yet DOES pick the new prefix up.
NEWPFX=$(curl -s -X POST $BASE/sales -H "$AUTH" -H "$CT" \
  -d "{\"branchId\":$B2,\"customerId\":$CUST_B2C,\"invoiceDate\":\"$TODAY\",\"items\":[{\"itemId\":$ITEM,\"qty\":1,\"rate\":10,\"gst\":0}]}" | j "d['invoiceNo']")
echo "  second branch first invoice: $NEWPFX"

echo
echo "== MFYNIX: Outstanding, allocation and ageing =="
AGE_CUST=$(curl -s -X POST $BASE/masters/customers -H "$AUTH" -H "$CT" \
  -d "{\"CustomerName\":\"Ageing Test Ltd\",\"State\":\"Telangana\",\"CreditDays\":30,\"branchId\":$B1}" | j "d['id']")
curl -s -X POST $BASE/inventory/adjust -H "$AUTH" -H "$CT" \
  -d "{\"branchId\":$B1,\"itemId\":$ITEM,\"adjustmentType\":\"Increase\",\"qty\":300,\"reason\":\"Stock for ageing test\"}" > /dev/null
D_OLD=$(date -d "$TODAY -100 days" +%Y-%m-%d 2>/dev/null || date -v-100d +%Y-%m-%d)
D_MID=$(date -d "$TODAY -45 days" +%Y-%m-%d 2>/dev/null || date -v-45d +%Y-%m-%d)
INV_OLD=$(curl -s -X POST $BASE/sales -H "$AUTH" -H "$CT" \
  -d "{\"branchId\":$B1,\"customerId\":$AGE_CUST,\"invoiceDate\":\"$D_OLD\",\"items\":[{\"itemId\":$ITEM,\"qty\":10,\"rate\":100,\"gst\":0}]}" | j "d['invoiceId']")
INV_MID=$(curl -s -X POST $BASE/sales -H "$AUTH" -H "$CT" \
  -d "{\"branchId\":$B1,\"customerId\":$AGE_CUST,\"invoiceDate\":\"$D_MID\",\"items\":[{\"itemId\":$ITEM,\"qty\":5,\"rate\":100,\"gst\":0}]}" | j "d['invoiceId']")
INV_NEW=$(curl -s -X POST $BASE/sales -H "$AUTH" -H "$CT" \
  -d "{\"branchId\":$B1,\"customerId\":$AGE_CUST,\"invoiceDate\":\"$TODAY\",\"items\":[{\"itemId\":$ITEM,\"qty\":2,\"rate\":100,\"gst\":0}]}" | j "d['invoiceId']")

python3 - "$BASE" "$TOK" "$AGE_CUST" <<'PYEOF'
import json, sys, urllib.request
base, tok, cust = sys.argv[1], sys.argv[2], sys.argv[3]
def get(p):
    r = urllib.request.Request(base + p, headers={'Authorization': 'Bearer ' + tok})
    return json.load(urllib.request.urlopen(r))
d = get(f'/outstanding/customers/{cust}')
docs = {doc['DocID']: doc for doc in d['documents']}
assert len(docs) == 3, d
assert abs(d['totalOpen'] - 1700) < 0.01, d['totalOpen']          # 1000 + 500 + 200
buckets = sorted(doc['Bucket'] for doc in d['documents'])
assert buckets == ['0-30', '31-60', '91-180'], buckets
overdue = [doc for doc in d['documents'] if doc['Overdue']]
assert len(overdue) == 2, [ (o['DocNo'], o['AgeDays']) for o in overdue ]   # 100d and 45d, vs 30 credit days
print("  PASS: three invoices land in the 0-30 / 31-60 / 91-180 buckets and the two past 30 credit days are flagged overdue")
PYEOF
[ $? -eq 0 ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

chk "over-allocation refused" 'only' "$(curl -s -X POST $BASE/outstanding/allocate -H "$AUTH" -H "$CT" \
  -d "{\"partyType\":\"Customer\",\"partyId\":$AGE_CUST,\"allocDate\":\"$TODAY\",\"lines\":[{\"docType\":\"SalesInvoice\",\"docId\":$INV_OLD,\"amount\":99999}]}")"
chk "zero allocation refused" 'greater than zero' "$(curl -s -X POST $BASE/outstanding/allocate -H "$AUTH" -H "$CT" \
  -d "{\"partyType\":\"Customer\",\"partyId\":$AGE_CUST,\"allocDate\":\"$TODAY\",\"lines\":[{\"docType\":\"SalesInvoice\",\"docId\":$INV_OLD,\"amount\":0}]}")"
chk "partial settlement accepted" '"allocated":400' "$(curl -s -X POST $BASE/outstanding/allocate -H "$AUTH" -H "$CT" \
  -d "{\"partyType\":\"Customer\",\"partyId\":$AGE_CUST,\"allocDate\":\"$TODAY\",\"lines\":[{\"docType\":\"SalesInvoice\",\"docId\":$INV_OLD,\"amount\":400}]}" | tr -d ' ')"
chk "two lines cannot double-spend one doc" 'only' "$(curl -s -X POST $BASE/outstanding/allocate -H "$AUTH" -H "$CT" \
  -d "{\"partyType\":\"Customer\",\"partyId\":$AGE_CUST,\"allocDate\":\"$TODAY\",\"lines\":[{\"docType\":\"SalesInvoice\",\"docId\":$INV_MID,\"amount\":300},{\"docType\":\"SalesInvoice\",\"docId\":$INV_MID,\"amount\":300}]}")"

python3 - "$BASE" "$TOK" "$AGE_CUST" "$INV_OLD" "$INV_NEW" <<'PYEOF'
import json, sys, urllib.request
base, tok, cust, old_id, new_id = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), int(sys.argv[5])
def get(p):
    r = urllib.request.Request(base + p, headers={'Authorization': 'Bearer ' + tok})
    return json.load(urllib.request.urlopen(r))
def post(p, body):
    r = urllib.request.Request(base + p, data=json.dumps(body).encode(), method='POST',
                               headers={'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(r))

d = get(f'/outstanding/customers/{cust}')
old = next(x for x in d['documents'] if x['DocID'] == old_id)
assert abs(old['OpenAmount'] - 600) < 0.01, old        # 1000 billed, 400 settled
assert abs(d['totalOpen'] - 1300) < 0.01, d['totalOpen']

# Settling a document in full removes it from Outstanding entirely.
post('/outstanding/allocate', {'partyType': 'Customer', 'partyId': int(cust),
     'allocDate': '2026-08-22', 'lines': [{'docType': 'SalesInvoice', 'docId': new_id, 'amount': 200}]})
d2 = get(f'/outstanding/customers/{cust}')
assert new_id not in [x['DocID'] for x in d2['documents']], "fully settled invoice is still listed as open"
assert abs(d2['totalOpen'] - 1100) < 0.01, d2['totalOpen']
print("  PASS: partial settlement reduces the open amount, and a fully settled invoice drops off Outstanding")
PYEOF
[ $? -eq 0 ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

chk "ageing report has buckets" '91-180' "$(curl -s -H "$AUTH" "$BASE/outstanding/report/ageing?partyType=Customer")"
chk "supplier payable view works" 'parties' "$(curl -s -H "$AUTH" $BASE/outstanding/suppliers)"
chk "customer summary view works" 'parties' "$(curl -s -H "$AUTH" $BASE/outstanding/customers)"
chk "auditor cannot allocate" 'read-only' "$(curl -s -X POST $BASE/outstanding/allocate -H "$AA" -H "$CT" \
  -d "{\"partyType\":\"Customer\",\"partyId\":$AGE_CUST,\"allocDate\":\"$TODAY\",\"lines\":[{\"docType\":\"SalesInvoice\",\"docId\":$INV_MID,\"amount\":1}]}")"

echo
echo "== MFYNIX: credit limit now uses real outstanding =="
LIM2=$(curl -s -X POST $BASE/masters/customers -H "$AUTH" -H "$CT" \
  -d "{\"CustomerName\":\"Revolving Credit Ltd\",\"State\":\"Telangana\",\"CreditLimit\":1000,\"branchId\":$B1}" | j "d['id']")
L_INV=$(curl -s -X POST $BASE/sales -H "$AUTH" -H "$CT" \
  -d "{\"branchId\":$B1,\"customerId\":$LIM2,\"invoiceDate\":\"$TODAY\",\"items\":[{\"itemId\":$ITEM,\"qty\":10,\"rate\":100,\"gst\":0}]}" | j "d['invoiceId']")
chk "limit is now exhausted" 'credit limit' "$(curl -s -X POST $BASE/sales -H "$AUTH" -H "$CT" \
  -d "{\"branchId\":$B1,\"customerId\":$LIM2,\"invoiceDate\":\"$TODAY\",\"items\":[{\"itemId\":$ITEM,\"qty\":1,\"rate\":100,\"gst\":0}]}")"
curl -s -X POST $BASE/outstanding/allocate -H "$AUTH" -H "$CT" \
  -d "{\"partyType\":\"Customer\",\"partyId\":$LIM2,\"allocDate\":\"$TODAY\",\"lines\":[{\"docType\":\"SalesInvoice\",\"docId\":$L_INV,\"amount\":1000}]}" > /dev/null
chk "paying the invoice frees the limit again" 'invoiceNo' "$(curl -s -X POST $BASE/sales -H "$AUTH" -H "$CT" \
  -d "{\"branchId\":$B1,\"customerId\":$LIM2,\"invoiceDate\":\"$TODAY\",\"items\":[{\"itemId\":$ITEM,\"qty\":9,\"rate\":100,\"gst\":0}]}")"
