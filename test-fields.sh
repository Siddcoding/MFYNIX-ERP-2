# The full statutory document fields, the CGST/SGST/IGST split, and the
# expanded item master.
#
# Sourced from test-modules.sh, so it shares $BASE, $AUTH, $CT, chk(), j(),
# $B1 (Telangana branch), $B2 (Odisha branch) and $ITEM.
#
# The assertions that matter here are arithmetic and provenance: does an
# intra-state sale split half CGST half SGST, does an inter-state sale go all
# to IGST, do the header totals equal the sum of their own lines, and is the
# party's GSTIN frozen onto the invoice rather than read live from the master.

echo
echo "== FIELDS: the expanded item master =="
ITEM_FULL=$(curl -s -X POST $BASE/masters/items -H "$AUTH" -H "$CT" -d '{
  "ItemCode":"RM001","ItemName":"Steel Rod 12mm Spec","Category":"Raw Material",
  "HSN":"7207","GSTRate":18,"Unit":"Kg","AltUnit":"Box","AltUnitFactor":12,
  "Dimensions":"L=12m, W=12mm, 10 Kg","MaterialType":"Raw","LeadTimeDays":7,
  "ReorderLevel":100,"PurchaseRate":500,"Warehouse":"WH-A","BinRack":"Rack B-12",
  "BatchTracking":1,"SerialTracking":0,"ShelfLifeMonths":12,"CostingMethod":"FIFO",
  "StandardCost":450,"SaleRate":600,"GLMapping":"Inventory A/c","BOMLink":"BOM001",
  "YieldPercent":95,"WastagePercent":5,"CustomAttributes":"Grade A, Silver"}' | j "d['id']")
chk "an item saved with the full specification" '^[0-9]\+$' "$ITEM_FULL"

FULL=$(curl -s -H "$AUTH" $BASE/masters/items | python3 -c "
import sys,json
d=json.load(sys.stdin)
m=[i for i in d if i['ItemID']==$ITEM_FULL]
print(json.dumps(m[0]) if m else '{}')")
for FIELD in '"ItemCode": "RM001"' '"Category": "Raw Material"' '"AltUnit": "Box"' \
             '"BinRack": "Rack B-12"' '"BatchTracking": 1' '"ShelfLifeMonths": 12' \
             '"CostingMethod": "FIFO"' '"StandardCost": 450' '"BOMLink": "BOM001"' \
             '"YieldPercent": 95' '"WastagePercent": 5' '"CustomAttributes": "Grade A, Silver"'; do
  chk "item master kept ${FIELD%%:*}" "$FIELD" "$(echo "$FULL" | python3 -m json.tool)"
done

echo
echo "== FIELDS: intra-state sale splits CGST + SGST =="
# The HYD branch and a Telangana customer: same state, so the tax has to split
# into two equal halves and nothing may land on IGST.
CUST_TS=$(curl -s -X POST $BASE/masters/customers -H "$AUTH" -H "$CT" \
  -d "{\"CustomerName\":\"Telangana Intra Co\",\"GSTIN\":\"36AAFCT9999T1ZQ\",\"PAN\":\"AAFCT9999T\",\"State\":\"Telangana\",\"Mobile\":\"9000000001\",\"branchId\":$B1}" | j "d['id']")

INTRA=$(curl -s -X POST $BASE/sales -H "$AUTH" -H "$CT" -d "{
  \"branchId\":$B1,\"customerId\":$CUST_TS,\"invoiceDate\":\"$TODAY\",
  \"refNo\":\"PO-INTRA-1\",\"refDate\":\"$TODAY\",\"orderNo\":\"SO-77\",\"orderDate\":\"$TODAY\",
  \"irn\":\"IRN123456789\",\"eWayBillNo\":\"EWB987654321\",
  \"transporterName\":\"Blue Dart\",\"consignmentNo\":\"CN-5501\",\"consignmentDate\":\"$TODAY\",
  \"payLedger\":\"Credit\",\"reverseCharge\":1,\"remarks\":\"Handle with care\",
  \"items\":[{\"itemId\":$ITEM,\"qty\":10,\"rate\":1000,\"gst\":18,\"discountPercent\":10,
              \"batchNo\":\"B-2026-01\",\"mfgDate\":\"2026-01-01\",\"expDate\":\"2027-01-01\"}]}")
chk "intra-state invoice created" '"invoiceNo"' "$INTRA"
INTRA_ID=$(echo "$INTRA" | j "d['invoiceId']")

INTRA_DOC=$(curl -s -H "$AUTH" $BASE/sales/$INTRA_ID)
chk "intra-state arithmetic is exactly right" '^OK$' "$(echo "$INTRA_DOC" | python3 -c "
import sys,json
d=json.load(sys.stdin); l=d['lines'][0]; h=d['header']
# 10 x 1000 = 10000, less 10% discount = 9000 taxable, 18% = 1620 tax,
# split half and half because supplier and customer are both in Telangana.
checks = {
  'amount': (l['Amount'] is not None, ''),
  'disc%': (l['DiscountPercent'] == 10, l['DiscountPercent']),
  'discAmt': (abs(l['Discount'] - 1000) < 0.01, l['Discount']),
  'nett': (abs(l['NettAmount'] - 9000) < 0.01, l['NettAmount']),
  'cgst': (abs(l['CGSTAmount'] - 810) < 0.01, l['CGSTAmount']),
  'sgst': (abs(l['SGSTAmount'] - 810) < 0.01, l['SGSTAmount']),
  'igst': (l['IGSTAmount'] == 0, l['IGSTAmount']),
  'cgst%': (abs(l['CGSTPercent'] - 9) < 0.01, l['CGSTPercent']),
  'gross': (abs(l['GrossAmount'] - 10620) < 0.01, l['GrossAmount']),
  'headerTaxable': (abs(h['Total'] - 9000) < 0.01, h['Total']),
  'headerTax': (abs(h['GST'] - 1620) < 0.01, h['GST']),
  'headerNet': (abs(h['NetAmount'] - 10620) < 0.01, h['NetAmount']),
}
bad = [f'{k}={v[1]}' for k, v in checks.items() if not v[0]]
print('OK' if not bad else ' '.join(bad))")"

chk "the header total equals the sum of its own lines" '^OK$' "$(echo "$INTRA_DOC" | python3 -c "
import sys,json
d=json.load(sys.stdin)
s=round(sum(l['GrossAmount'] for l in d['lines']),2)
print('OK' if abs(s-d['header']['NetAmount'])<0.01 else f\"{s} vs {d['header']['NetAmount']}\")")"

echo
echo "== FIELDS: inter-state sale is all IGST =="
# The same HYD (Telangana) branch selling to an Odisha customer.
CUST_OD=$(curl -s -X POST $BASE/masters/customers -H "$AUTH" -H "$CT" \
  -d "{\"CustomerName\":\"Odisha Inter Co\",\"GSTIN\":\"21AAFCO8888O1ZM\",\"State\":\"Odisha\",\"branchId\":$B1}" | j "d['id']")

INTER=$(curl -s -X POST $BASE/sales -H "$AUTH" -H "$CT" -d "{
  \"branchId\":$B1,\"customerId\":$CUST_OD,\"invoiceDate\":\"$TODAY\",
  \"items\":[{\"itemId\":$ITEM,\"qty\":5,\"rate\":1000,\"gst\":18}]}")
INTER_ID=$(echo "$INTER" | j "d['invoiceId']")
chk "inter-state supply puts the whole tax on IGST" '^OK$' \
  "$(curl -s -H "$AUTH" $BASE/sales/$INTER_ID | python3 -c "
import sys,json
l=json.load(sys.stdin)['lines'][0]
ok = abs(l['IGSTAmount']-900)<0.01 and l['CGSTAmount']==0 and l['SGSTAmount']==0 and abs(l['IGSTPercent']-18)<0.01
print('OK' if ok else f\"igst={l['IGSTAmount']} cgst={l['CGSTAmount']} sgst={l['SGSTAmount']}\")")"

# Odisha is spelled 'Orissa' half the time. Matching by GST state code rather
# than by name is what stops that being taxed as an inter-state supply.
CUST_ORISSA=$(curl -s -X POST $BASE/masters/customers -H "$AUTH" -H "$CT" \
  -d "{\"CustomerName\":\"Orissa Spelling Co\",\"GSTIN\":\"21AAFCS7777S1ZG\",\"State\":\"Orissa\",\"branchId\":$B2}" | j "d['id']")
SPELL=$(curl -s -X POST $BASE/sales -H "$AUTH" -H "$CT" -d "{
  \"branchId\":$B2,\"customerId\":$CUST_ORISSA,\"invoiceDate\":\"$TODAY\",
  \"items\":[{\"itemId\":$ITEM,\"qty\":1,\"rate\":1000,\"gst\":18}]}")
SPELL_ID=$(echo "$SPELL" | j "d.get('invoiceId','')")
if [ -n "$SPELL_ID" ]; then
  chk "\"Orissa\" and \"Odisha\" are recognised as one state, not taxed as inter-state" '^OK$' \
    "$(curl -s -H "$AUTH" $BASE/sales/$SPELL_ID | python3 -c "
import sys,json
l=json.load(sys.stdin)['lines'][0]
print('OK' if l['IGSTAmount']==0 and abs(l['CGSTAmount']-90)<0.01 else f\"igst={l['IGSTAmount']} cgst={l['CGSTAmount']}\")")"
fi

echo
echo "== FIELDS: the statutory header round-trips =="
HDR=$(curl -s -H "$AUTH" $BASE/sales/$INTRA_ID | python3 -m json.tool)
for PAIR in '"RefNo": "PO-INTRA-1"' '"OrderNo": "SO-77"' '"IRN": "IRN123456789"' \
            '"EWayBillNo": "EWB987654321"' '"TransporterName": "Blue Dart"' \
            '"ConsignmentNo": "CN-5501"' '"PayLedger": "Credit"' '"ReverseCharge": 1' \
            '"Remarks": "Handle with care"'; do
  chk "header kept ${PAIR%%:*}" "$PAIR" "$HDR"
done

chk "the party's GSTIN was snapshot onto the invoice" '"PartyGSTIN": "36AAFCT9999T1ZQ"' "$HDR"
chk "the party's PAN was snapshot too" '"PartyPAN": "AAFCT9999T"' "$HDR"
chk "the GST state code was derived from the GSTIN" '"PartyStateCode": "36"' "$HDR"
chk "line traceability round-trips" '"BatchNo": "B-2026-01"' "$HDR"
chk "and so do the manufacture and expiry dates" '"ExpDate": "2027-01-01"' "$HDR"
chk "the item code and description were snapshot" '"ItemDesc"' "$HDR"

# The snapshot is the point: editing the master afterwards must not rewrite
# what was already filed.
curl -s -X PUT $BASE/masters/customers/$CUST_TS -H "$AUTH" -H "$CT" \
  -d '{"GSTIN":"36ZZZZZ0000Z1ZR","CustomerName":"Telangana Intra Co"}' > /dev/null
chk "changing the customer's GSTIN does NOT rewrite the invoice already raised" '"PartyGSTIN": "36AAFCT9999T1ZQ"' \
  "$(curl -s -H "$AUTH" $BASE/sales/$INTRA_ID | python3 -m json.tool)"

echo
echo "== FIELDS: purchases and notes carry the same detail =="
SUPP_TS=$(curl -s -X POST $BASE/masters/suppliers -H "$AUTH" -H "$CT" \
  -d "{\"SupplierName\":\"Local Vendor TS\",\"GSTIN\":\"36AAFCV6666V1Z2\",\"State\":\"Telangana\",\"branchId\":$B1}" | j "d['id']")
PUR=$(curl -s -X POST $BASE/purchase -H "$AUTH" -H "$CT" -d "{
  \"branchId\":$B1,\"supplierId\":$SUPP_TS,\"purchaseDate\":\"$TODAY\",\"vendorInvoiceNo\":\"V$RANDOM$RANDOM\",\"vendorInvoiceDate\":\"$TODAY\",
  \"refNo\":\"VENDOR-BILL-9\",\"transporterName\":\"VRL\",\"payLedger\":\"Bank\",
  \"items\":[{\"itemId\":$ITEM,\"qty\":20,\"rate\":500,\"gst\":18,\"batchNo\":\"P-77\"}]}")
PUR_ID=$(echo "$PUR" | j "d['purchaseId']")
chk "purchase bill created with its reference" '"purchaseNo"' "$PUR"
PUR_DOC=$(curl -s -H "$AUTH" $BASE/purchase/$PUR_ID | python3 -m json.tool)
chk "purchase kept the vendor's bill number" '"RefNo": "VENDOR-BILL-9"' "$PUR_DOC"
chk "purchase line kept its batch" '"BatchNo": "P-77"' "$PUR_DOC"
# Compared as numbers, not as formatted text: 900 and 900.0 are the same
# amount, and an assertion that cares which one JSON printed is testing the
# serializer rather than the tax.
chk "purchase split the tax into CGST and SGST" '^OK$' \
  "$(curl -s -H "$AUTH" $BASE/purchase/$PUR_ID | python3 -c "
import sys,json
l=json.load(sys.stdin)['lines'][0]
ok = abs(l['CGSTAmount']-900)<0.01 and abs(l['SGSTAmount']-900)<0.01 and l['IGSTAmount']==0
print('OK' if ok else f\"cgst={l['CGSTAmount']} sgst={l['SGSTAmount']} igst={l['IGSTAmount']}\")")"

NOTE=$(curl -s -X POST $BASE/notes -H "$AUTH" -H "$CT" -d "{
  \"noteType\":\"Credit\",\"branchId\":$B1,\"partyId\":$CUST_TS,\"noteDate\":\"$TODAY\",
  \"reason\":\"Two rods bent in transit\",\"restoreStock\":true,
  \"refNo\":\"CLAIM-12\",\"transporterName\":\"Blue Dart\",
  \"items\":[{\"itemId\":$ITEM,\"qty\":2,\"rate\":1000,\"gst\":18}]}")
chk "credit note created" '"noteNo"' "$NOTE"
NOTE_ID=$(echo "$NOTE" | j "d.get('noteId','')")
if [ -n "$NOTE_ID" ]; then
  NOTE_DOC=$(curl -s -H "$AUTH" $BASE/notes/$NOTE_ID | python3 -m json.tool)
  chk "the note kept its reference" '"RefNo": "CLAIM-12"' "$NOTE_DOC"
  chk "the note split tax onto the same heads as the invoice it reverses" '^OK$' \
    "$(curl -s -H "$AUTH" $BASE/notes/$NOTE_ID | python3 -c "
import sys,json
l=json.load(sys.stdin)['lines'][0]
ok = abs(l['CGSTAmount']-180)<0.01 and abs(l['SGSTAmount']-180)<0.01 and l['IGSTAmount']==0
print('OK' if ok else f\"cgst={l['CGSTAmount']} sgst={l['SGSTAmount']} igst={l['IGSTAmount']}\")")"
fi

echo
echo "== FIELDS: branding =="
BRAND=$(curl -s -H "$AUTH" $BASE/branding)
chk "branding endpoint returns the company name" '"companyName"' "$BRAND"
chk "with no uploaded logo it reports the fallback" '"hasCustomLogo":false' "$BRAND"

# A one-pixel PNG is enough to prove the round-trip.
TINYPNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
curl -s -X PUT $BASE/admin/company -H "$AUTH" -H "$CT" -d "{\"logoDataUrl\":\"$TINYPNG\"}" > /dev/null
chk "after upload the company's own logo is served" '"hasCustomLogo":true' \
  "$(curl -s -H "$AUTH" $BASE/branding)"
chk "and the branding endpoint never leaks the bank account" '^OK$' \
  "$(curl -s -H "$AUTH" $BASE/branding | python3 -c "
import sys,json
d=json.load(sys.stdin)
leaked=[k for k in d if 'bank' in k.lower() or 'account' in k.lower()]
print('OK' if not leaked else 'leaked: '+','.join(leaked))")"
chk "branding needs a login" 'Missing token' "$(curl -s $BASE/branding)"

# Put it back so nothing downstream sees a stray logo.
curl -s -X PUT $BASE/admin/company -H "$AUTH" -H "$CT" -d '{"logoDataUrl":""}' > /dev/null
