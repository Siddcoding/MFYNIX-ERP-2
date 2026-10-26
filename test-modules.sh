#!/bin/bash
# End-to-end test of the four new modules against a running server.
set -u
BASE=http://localhost:3999/api
PASS=0; FAIL=0
chk() { # chk "label" "expected_substring" "actual"
  if echo "$3" | grep -q "$2"; then echo "  PASS: $1"; PASS=$((PASS+1));
  else echo "  FAIL: $1"; echo "        expected to contain: $2"; echo "        got: $(echo "$3" | head -c 400)"; FAIL=$((FAIL+1)); fi
}
j() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)"; }

echo "== login as admin =="
TOK=$(curl -s -X POST $BASE/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"Admin@123"}' | j "d['token']")
AUTH="Authorization: Bearer $TOK"
CT="Content-Type: application/json"
# utok USER PASS -> a usable token. New users must change their password at
# first sign-in (ROL-01), so the helper does that when asked and keeps the token.
utok() {
  local R T
  R=$(curl -s -X POST $BASE/auth/login -H "$CT" -d "{\"username\":\"$1\",\"password\":\"$2\"}")
  T=$(echo "$R" | j "d.get('token','')")
  if echo "$R" | grep -q '"mustChangePassword":true'; then
    curl -s -X POST $BASE/auth/change-password -H "Authorization: Bearer $T" -H "$CT" \
      -d "{\"currentPassword\":\"$2\",\"newPassword\":\"${2}#chg\"}" > /dev/null
  fi
  echo "$T"
}
[ -n "$TOK" ] && echo "  token ok" || { echo "  LOGIN FAILED"; exit 1; }

BRANCHES=$(curl -s -H "$AUTH" $BASE/branches)
B1=$(echo "$BRANCHES" | j "[b['BranchID'] for b in d if b['BranchCode']=='HYD'][0]")
B2=$(echo "$BRANCHES" | j "[b['BranchID'] for b in d if b['BranchCode']=='BBSR'][0]")
ROLES=$(curl -s -H "$AUTH" $BASE/branches/roles/list)
rid() { echo "$ROLES" | j "[r['RoleID'] for r in d if r['RoleName']=='$1'][0]"; }
echo "  branches: $B1 $B2"

PERIOD=$(date +%Y-%m)
TODAY=$(date +%Y-%m-%d)

echo
echo "== seed masters + transactions =="
CUST_GST=$(curl -s -X POST $BASE/masters/customers -H "$AUTH" -H "$CT" \
  -d "{\"CustomerName\":\"Acme Traders\",\"GSTIN\":\"36AAAAA1111A1ZX\",\"State\":\"Telangana\",\"branchId\":$B1}" | j "d['id']")
CUST_B2C=$(curl -s -X POST $BASE/masters/customers -H "$AUTH" -H "$CT" \
  -d "{\"CustomerName\":\"Walk-in Customer\",\"State\":\"Odisha\",\"branchId\":$B2}" | j "d['id']")
SUPP=$(curl -s -X POST $BASE/masters/suppliers -H "$AUTH" -H "$CT" \
  -d "{\"SupplierName\":\"Global Supply Co\",\"GSTIN\":\"21BBBBB2222B1ZT\",\"State\":\"Odisha\",\"branchId\":$B1}" | j "d['id']")
ITEM=$(curl -s -X POST $BASE/masters/items -H "$AUTH" -H "$CT" \
  -d '{"ItemName":"Steel Rod 12mm","HSN":"7214","GSTRate":18,"Unit":"KG","PurchaseRate":50,"SaleRate":80,"ReorderLevel":100}' | j "d['id']")
echo "  cust=$CUST_GST b2c=$CUST_B2C supp=$SUPP item=$ITEM"

curl -s -X POST $BASE/purchase -H "$AUTH" -H "$CT" \
  -d "{\"branchId\":$B1,\"supplierId\":$SUPP,\"purchaseDate\":\"$TODAY\",\"vendorInvoiceNo\":\"V$RANDOM$RANDOM\",\"vendorInvoiceDate\":\"$TODAY\",\"items\":[{\"itemId\":$ITEM,\"qty\":500,\"rate\":50,\"gst\":18}]}" > /dev/null
S1=$(curl -s -X POST $BASE/sales -H "$AUTH" -H "$CT" \
  -d "{\"branchId\":$B1,\"customerId\":$CUST_GST,\"invoiceDate\":\"$TODAY\",\"items\":[{\"itemId\":$ITEM,\"qty\":100,\"rate\":80,\"gst\":18}]}")
chk "sales invoice created" '"invoiceNo"' "$S1"
# BBSR has no stock of this item, and since Tier 1 the system correctly refuses
# to sell what a branch hasn't got - so give it an opening balance first. (The
# old version of this test relied on the missing guard, which is exactly how the
# demo data used to end up with negative stock.)
curl -s -X POST $BASE/inventory/adjust -H "$AUTH" -H "$CT" \
  -d "{\"branchId\":$B2,\"itemId\":$ITEM,\"adjustmentType\":\"Opening Stock\",\"qty\":200,\"reason\":\"Opening balance at BBSR\"}" > /dev/null
S2=$(curl -s -X POST $BASE/sales -H "$AUTH" -H "$CT" \
  -d "{\"branchId\":$B2,\"customerId\":$CUST_B2C,\"invoiceDate\":\"$TODAY\",\"items\":[{\"itemId\":$ITEM,\"qty\":10,\"rate\":80,\"gst\":18}]}")
chk "b2c invoice created" '"invoiceNo"' "$S2"

echo
echo "== GST module =="
G1=$(curl -s -H "$AUTH" "$BASE/gst/gstr1?period=$PERIOD")
chk "gstr1 returns b2b block" '"b2b"' "$G1"
echo "  gstr1 totals: $(echo "$G1" | j "d['totals']")"
# Acme is Telangana, branch1 (HYD) is Telangana -> intra-state -> CGST+SGST
python3 - <<PY
import json,sys
d=json.loads('''$G1''')
b2b=d['b2b']; tot=d['totals']
assert len(b2b)==1, b2b
inv=b2b[0]
assert abs(inv['taxableValue']-8000)<0.01, inv
assert abs(inv['cgst']-720)<0.01 and abs(inv['sgst']-720)<0.01 and inv['igst']==0, inv
assert abs(inv['rate']-18)<0.01, inv
assert len(d['b2cs'])==1, d['b2cs']
print("  PASS: GSTR-1 intra-state split CGST 720 / SGST 720, rate 18%, B2C bucketed separately")
PY
[ $? -eq 0 ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

G3=$(curl -s -H "$AUTH" "$BASE/gst/gstr3b?period=$PERIOD")
echo "  gstr3b: $(echo "$G3" | j "d['liability']")  netPayable=$(echo "$G3" | j "d['netPayable']")"
python3 - <<PY
import json
d=json.loads('''$G3''')
out=d['outwardSupplies']; inw=d['inwardSupplies']; L=d['liability']
assert abs(out['taxableValue']-8800)<0.01, out     # 8000 + 800
assert abs(inw['taxableValue']-25000)<0.01, inw    # purchase 500*50
# Bought inter-state (IGST input 4500), sold intra-state (CGST 792 + SGST 792).
# Sec 49A: IGST credit must be used first, and CAN cover CGST/SGST liability.
assert abs(L['igst']['input']-4500)<0.01, L
assert L['cgst']['payable']==0 and L['sgst']['payable']==0, L
assert abs(L['cgst']['creditUtilised']-792)<0.01, L
assert abs(L['sgst']['creditUtilised']-792)<0.01, L
assert d['netPayable']==0, d
assert abs(d['totalCarryForward']-(4500-1584))<0.01, d   # 2916 IGST credit left
print("  PASS: GSTR-3B applies the Sec 49A ITC set-off order - IGST credit covers CGST+SGST liability, 2916 carries forward")
PY
[ $? -eq 0 ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

BS=$(curl -s -H "$AUTH" "$BASE/gst/branch-summary?period=$PERIOD")
chk "branch-wise GST summary" 'netPayable' "$BS"
HSN=$(curl -s -H "$AUTH" "$BASE/gst/hsn-summary?period=$PERIOD")
chk "HSN summary uses item HSN" '7214' "$HSN"
CSV=$(curl -s -H "$AUTH" "$BASE/gst/export/gstr1.csv?period=$PERIOD")
chk "GSTR-1 CSV export header" 'GSTIN/UIN of Recipient' "$CSV"
JSN=$(curl -s -H "$AUTH" "$BASE/gst/export/gstr1.json?period=$PERIOD")
chk "GSTR-1 JSON export has b2b/ctin" '"ctin"' "$JSN"
chk "GSTR-1 JSON fp is MMYYYY" "\"fp\": \"$(date +%m%Y)\"" "$JSN"
chk "bad period rejected" 'YYYY-MM' "$(curl -s -H "$AUTH" "$BASE/gst/gstr1?period=2026")"

R1=$(curl -s -X POST $BASE/gst/returns -H "$AUTH" -H "$CT" -d "{\"returnType\":\"GSTR3B\",\"period\":\"$PERIOD\"}")
RID=$(echo "$R1" | j "d.get('returnId')")
chk "return logged" '[0-9]' "$RID"
chk "regenerating updates instead of duplicating" '"updated": true' "$(curl -s -X POST $BASE/gst/returns -H "$AUTH" -H "$CT" -d "{\"returnType\":\"GSTR3B\",\"period\":\"$PERIOD\"}" | python3 -m json.tool)"
chk "file requires valid ARN" 'ARN' "$(curl -s -X POST $BASE/gst/returns/$RID/file -H "$AUTH" -H "$CT" -d '{"arn":"x"}')"
chk "marked filed" 'success' "$(curl -s -X POST $BASE/gst/returns/$RID/file -H "$AUTH" -H "$CT" -d '{"arn":"AA210826123456Z"}')"
chk "filed return cannot be regenerated" 'already been marked as filed' "$(curl -s -X POST $BASE/gst/returns -H "$AUTH" -H "$CT" -d "{\"returnType\":\"GSTR3B\",\"period\":\"$PERIOD\"}")"

echo
echo "== Payroll module =="
E1=$(curl -s -X POST $BASE/payroll/employees -H "$AUTH" -H "$CT" \
  -d "{\"branchId\":$B1,\"fullName\":\"Ravi Kumar\",\"designation\":\"Sales Manager\",\"basic\":20000,\"hra\":8000,\"allowances\":2000,\"monthlyTDS\":1000}")
EID1=$(echo "$E1" | j "d['employeeId']")
E2=$(curl -s -X POST $BASE/payroll/employees -H "$AUTH" -H "$CT" \
  -d "{\"branchId\":$B1,\"fullName\":\"Sita Devi\",\"designation\":\"Accountant\",\"basic\":12000,\"hra\":4000,\"allowances\":1000}")
EID2=$(echo "$E2" | j "d['employeeId']")
chk "employee code is branch-wise" '\-E001' "$(curl -s -H "$AUTH" $BASE/payroll/employees)"
chk "basic salary required" 'basic salary' "$(curl -s -X POST $BASE/payroll/employees -H "$AUTH" -H "$CT" -d "{\"branchId\":$B1,\"fullName\":\"No Pay\"}")"

curl -s -X POST $BASE/payroll/attendance -H "$AUTH" -H "$CT" \
  -d "{\"period\":\"$PERIOD\",\"rows\":[{\"employeeId\":$EID1,\"workingDays\":26,\"presentDays\":26,\"overtimeHours\":10},{\"employeeId\":$EID2,\"workingDays\":26,\"presentDays\":13}]}" > /dev/null
chk "present > working days rejected" 'cannot exceed' "$(curl -s -X POST $BASE/payroll/attendance -H "$AUTH" -H "$CT" -d "{\"period\":\"$PERIOD\",\"rows\":[{\"employeeId\":$EID1,\"workingDays\":26,\"presentDays\":30}]}")"

PV=$(curl -s -H "$AUTH" "$BASE/payroll/preview?period=$PERIOD&branchId=$B1")
echo "  preview totals: $(echo "$PV" | j "d['totals']")"
python3 - <<PY
import json
d=json.loads('''$PV''')
p={s['fullName']:s for s in d['payslips']}
r=p['Ravi Kumar']; s=p['Sita Devi']
# Ravi: full month. basic 20000, hra 8000, allow 2000, OT = 20000/208*10 = 961.54
assert abs(r['overtime']-961.54)<0.02, r
assert abs(r['gross']-30961.54)<0.02, r
# PF = 12% of min(basic, 15000) = 1800 ; ESI: gross > 21000 -> 0 ; TDS 1000
assert abs(r['pf']-1800)<0.01 and r['esi']==0 and r['tds']==1000, r
assert abs(r['netPay']-(r['gross']-2800))<0.02, r
# Sita: half month -> basic 6000, hra 2000, allow 500 -> gross 8500
assert abs(s['gross']-8500)<0.01, s
assert abs(s['pf']-720)<0.01, s                 # 12% of 6000
assert abs(s['esi']-63.75)<0.01, s              # 0.75% of 8500 (under 21000 ceiling)
print("  PASS: payslip math - pro-rata, overtime, PF ceiling, ESI ceiling, TDS all correct")
PY
[ $? -eq 0 ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

RUN=$(curl -s -X POST $BASE/payroll/run -H "$AUTH" -H "$CT" -d "{\"period\":\"$PERIOD\",\"branchId\":$B1}")
RUNID=$(echo "$RUN" | j "d.get('payrollRunID', d.get('payrollRunId'))")
chk "payroll posted with journal" '"journalId"' "$RUN"
chk "duplicate payroll run refused" 'already been posted' "$(curl -s -X POST $BASE/payroll/run -H "$AUTH" -H "$CT" -d "{\"period\":\"$PERIOD\",\"branchId\":$B1}")"
chk "attendance locked after posting" 'locked' "$(curl -s -X POST $BASE/payroll/attendance -H "$AUTH" -H "$CT" -d "{\"period\":\"$PERIOD\",\"rows\":[{\"employeeId\":$EID1,\"workingDays\":26,\"presentDays\":20}]}")"
chk "statutory register" 'PF' "$(curl -s -H "$AUTH" "$BASE/payroll/statutory?period=$PERIOD")"
chk "payslips retrievable" 'NetPay' "$(curl -s -H "$AUTH" $BASE/payroll/runs/$RUNID)"
chk "mark paid" 'success' "$(curl -s -X POST $BASE/payroll/runs/$RUNID/pay -H "$AUTH" -H "$CT" -d '{}')"
chk "double payment refused" 'already marked as paid' "$(curl -s -X POST $BASE/payroll/runs/$RUNID/pay -H "$AUTH" -H "$CT" -d '{}')"

echo
echo "== CRM module =="
L1=$(curl -s -X POST $BASE/crm/leads -H "$AUTH" -H "$CT" \
  -d "{\"branchId\":$B1,\"leadName\":\"Bharat Infra\",\"contactPerson\":\"Mr Rao\",\"mobile\":\"9876543210\",\"source\":\"Referral\",\"estimatedValue\":500000,\"nextFollowUp\":\"2020-01-01\"}")
LID=$(echo "$L1" | j "d['leadId']")
curl -s -X POST $BASE/crm/leads -H "$AUTH" -H "$CT" \
  -d "{\"branchId\":$B2,\"leadName\":\"Odisha Builders\",\"estimatedValue\":250000}" > /dev/null
chk "lead created" '[0-9]' "$LID"
chk "stage move recorded" '"stage": "Qualified"' "$(curl -s -X POST $BASE/crm/leads/$LID/stage -H "$AUTH" -H "$CT" -d '{"stage":"Qualified","notes":"budget confirmed"}' | python3 -m json.tool)"
chk "same-stage move rejected" 'already at stage' "$(curl -s -X POST $BASE/crm/leads/$LID/stage -H "$AUTH" -H "$CT" -d '{"stage":"Qualified"}')"
chk "Lost requires a reason" 'reason is required' "$(curl -s -X POST $BASE/crm/leads/$LID/stage -H "$AUTH" -H "$CT" -d '{"stage":"Lost"}')"
chk "activity logged" 'success' "$(curl -s -X POST $BASE/crm/leads/$LID/activities -H "$AUTH" -H "$CT" -d '{"activityType":"Call","notes":"Spoke to Mr Rao","nextFollowUp":"2020-02-01"}')"
chk "overdue follow-up surfaced" '"overdue": true' "$(curl -s -H "$AUTH" $BASE/crm/followups | python3 -m json.tool)"
CONV=$(curl -s -X POST $BASE/crm/leads/$LID/convert -H "$AUTH" -H "$CT" -d '{"gstin":"36CCCCC3333C1Z3","state":"Telangana"}')
chk "lead converted to customer" '"customerId"' "$CONV"
chk "double conversion refused" 'already been converted' "$(curl -s -X POST $BASE/crm/leads/$LID/convert -H "$AUTH" -H "$CT" -d '{}')"
NEWCUST=$(echo "$CONV" | j "d['customerId']")
chk "converted customer exists in masters" 'Bharat Infra' "$(curl -s -H "$AUTH" $BASE/masters/customers)"
PIPE=$(curl -s -H "$AUTH" $BASE/crm/pipeline)
echo "  pipeline: $(echo "$PIPE" | j "(d['openLeads'], d['conversionRate'])")"
python3 - <<PY
import json
d=json.loads('''$PIPE''')
assert d['openLeads']==1, d      # Odisha Builders still New; Bharat Infra now Won
assert d['conversionRate']==100.0, d   # 1 won / 1 closed
print("  PASS: pipeline counts open leads and computes conversion on closed leads only")
PY
[ $? -eq 0 ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))
chk "branch performance" 'ConversionRate' "$(curl -s -H "$AUTH" $BASE/crm/branch-performance)"

echo
echo "== MFinAI =="
ask() { curl -s -X POST $BASE/ai/ask -H "$AUTH" -H "$CT" -d "{\"question\":\"$1\"}"; }
A=$(ask "What were my sales this month?"); echo "  Q: sales this month -> $(echo "$A" | j "d['answer']")"
chk "sales intent" '"intent": "sales_total"' "$(echo "$A" | python3 -m json.tool)"
A=$(ask "Who are my top 3 customers this month?"); echo "  Q: top customers -> $(echo "$A" | j "d['answer']")"
chk "top customers intent" 'top_customers' "$A"
A=$(ask "Compare branch performance this month"); echo "  Q: branches -> $(echo "$A" | j "d['answer']")"
chk "branch comparison intent" 'branch_comparison' "$A"
A=$(ask "What is my GST liability this month?"); echo "  Q: gst -> $(echo "$A" | j "d['answer']")"
chk "gst intent" 'gst_liability' "$A"
A=$(ask "What is my payroll cost this month?"); echo "  Q: payroll -> $(echo "$A" | j "d['answer']")"
chk "payroll intent" 'payroll_cost' "$A"
A=$(ask "How is my pipeline doing?"); echo "  Q: crm -> $(echo "$A" | j "d['answer']")"
chk "crm intent" 'crm_pipeline' "$A"
A=$(ask "What is my profit this month?"); echo "  Q: profit -> $(echo "$A" | j "d['answer']")"
chk "profit intent" 'profit' "$A"
A=$(ask "How much is outstanding from customers?"); echo "  Q: outstanding -> $(echo "$A" | j "d['answer']")"
chk "outstanding intent" 'outstanding' "$A"
A=$(ask "Which items are low on stock?"); echo "  Q: low stock -> $(echo "$A" | j "d['answer']")"
chk "low stock intent" 'low_stock' "$A"
A=$(ask "Show me sales for the Hyderabad branch this month"); echo "  Q: branch-scoped -> $(echo "$A" | j "d['answer']")"
chk "branch named in question is honoured" 'Hyderabad' "$A"
chk "unknown question is admitted, not guessed" "couldn't match" "$(ask "what is the weather in paris")"

INS=$(curl -s -H "$AUTH" $BASE/ai/insights)
echo "  insights: $(echo "$INS" | j "[i['title'] for i in d['insights']]")"
chk "insights returned" '"insights"' "$INS"
chk "books-balanced insight present" 'Books are balanced' "$INS"

echo
echo "== accounting integration =="
TB=$(curl -s -H "$AUTH" $BASE/accounts/trial-balance)
echo "  trial balance: Dr $(echo "$TB" | j "d['totalDebit']") Cr $(echo "$TB" | j "d['totalCredit']") balanced=$(echo "$TB" | j "d['balanced']")"
chk "trial balance still balances after payroll" '"balanced": true' "$(echo "$TB" | python3 -m json.tool)"
chk "payroll hit Salaries & Wages" 'Salaries' "$TB"
chk "PF Payable account exists and is used" 'PF Payable' "$TB"
BSH=$(curl -s -H "$AUTH" $BASE/accounts/balance-sheet)
chk "balance sheet balances" '"balanced": true' "$(echo "$BSH" | python3 -m json.tool)"

echo
echo "== role enforcement =="
CASHIER=$(curl -s -X POST $BASE/branches/users -H "$AUTH" -H "$CT" \
  -d "{\"branchId\":$B2,\"roleId\":$(rid 'Cashier'),\"userName\":\"cash1\",\"fullName\":\"Cash Desk\",\"password\":\"Cash@1234\"}")
CTOK=$(utok cash1 Cash@1234)
if [ -n "$CTOK" ]; then
  CA="Authorization: Bearer $CTOK"
  chk "cashier blocked from GST" 'do not have access' "$(curl -s -H "$CA" "$BASE/gst/gstr1?period=$PERIOD")"
  chk "cashier blocked from Payroll" 'do not have access' "$(curl -s -H "$CA" $BASE/payroll/employees)"
  chk "cashier blocked from CRM" 'do not have access' "$(curl -s -H "$CA" $BASE/crm/leads)"
else
  echo "  SKIP: could not create cashier ($CASHIER)"
fi

SEXEC=$(curl -s -X POST $BASE/branches/users -H "$AUTH" -H "$CT" \
  -d "{\"branchId\":$B2,\"roleId\":$(rid 'Sales Executive'),\"userName\":\"sales1\",\"fullName\":\"Field Sales\",\"password\":\"Sales@1234\"}")
STOK=$(utok sales1 Sales@1234)
if [ -n "$STOK" ]; then
  SA="Authorization: Bearer $STOK"
  SL=$(curl -s -H "$SA" $BASE/crm/leads)
  chk "sales exec can use CRM" 'Odisha Builders' "$SL"
  python3 - <<PY
import json
d=json.loads('''$SL''')
rows=d['rows'] if isinstance(d, dict) else d
assert all(l['BranchName'].startswith('Head Office') or l['BranchID']==$B2 for l in rows), rows
assert not any(l['LeadName']=='Bharat Infra' for l in rows), "branch leakage: saw another branch's lead"
print("  PASS: branch-locked sales exec sees only their own branch's leads")
PY
  [ $? -eq 0 ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))
  chk "sales exec blocked from Payroll" 'do not have access' "$(curl -s -H "$SA" $BASE/payroll/employees)"
  # A branch-locked user asking about ANOTHER branch must still get their own
  # branch's numbers - the question must not widen their access.
  SCOPED=$(curl -s -X POST $BASE/ai/ask -H "$SA" -H "$CT" -d '{"question":"sales for Hyderabad branch this month"}')
  chk "branch user cannot widen scope via the question" 'Bhubaneswar' "$SCOPED"
  chk "branch user answer excludes the other branch's data" 'no-leak' "$(echo "$SCOPED" | j "d['answer']" | grep -qi hyderabad && echo 'LEAKED' || echo 'no-leak')"
fi

AUD=$(curl -s -X POST $BASE/branches/users -H "$AUTH" -H "$CT" \
  -d "{\"branchId\":null,\"roleId\":$(rid 'Auditor'),\"userName\":\"aud1\",\"fullName\":\"Auditor\",\"password\":\"Audit@1234\"}")
ATOK=$(utok aud1 Audit@1234)
if [ -n "$ATOK" ]; then
  AA="Authorization: Bearer $ATOK"
  chk "auditor can read GST" '"b2b"' "$(curl -s -H "$AA" "$BASE/gst/gstr1?period=$PERIOD")"
  chk "auditor cannot file GST" 'read-only' "$(curl -s -X POST $BASE/gst/returns -H "$AA" -H "$CT" -d "{\"returnType\":\"GSTR1\",\"period\":\"$PERIOD\"}")"
  chk "auditor can read payroll" 'EmpCode' "$(curl -s -H "$AA" $BASE/payroll/employees)"
  chk "auditor cannot post payroll" 'read-only' "$(curl -s -X POST $BASE/payroll/run -H "$AA" -H "$CT" -d "{\"period\":\"2026-01\",\"branchId\":$B2}")"
  chk "auditor cannot create leads" 'read-only' "$(curl -s -X POST $BASE/crm/leads -H "$AA" -H "$CT" -d "{\"branchId\":$B1,\"leadName\":\"X\"}")"
fi

# Tests for the features added after the first release live in their own file,
# sourced here so they share these helpers and the same seeded data.
source "$(dirname "$0")/test-new-features.sh"
source "$(dirname "$0")/test-tier1.sh"
source "$(dirname "$0")/test-mfynix.sh"
source "$(dirname "$0")/test-final.sh"
source "$(dirname "$0")/test-portal.sh"
source "$(dirname "$0")/test-import.sh"
source "$(dirname "$0")/test-fields.sh"
source "$(dirname "$0")/test-r0.sh"
source "$(dirname "$0")/test-r1.sh"
source "$(dirname "$0")/test-r2.sh"
source "$(dirname "$0")/test-r3.sh"

echo
echo "======================================"
echo "PASS: $PASS   FAIL: $FAIL"
[ $FAIL -eq 0 ] || exit 1
