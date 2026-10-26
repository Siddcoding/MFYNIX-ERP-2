# Release R3 (partial) tests: e-invoice (IRN/QR) and e-way bill generation.
# Sourced by test-modules.sh. Sandbox mode (no live GSP) - the payload shape and
# IRN hash are production-correct; the acknowledgement is generated locally.
echo
echo "== R3: e-invoice and e-way bill =="
EICUST=$(curl -s -X POST $BASE/masters/customers -H "$AUTH" -H "$CT" -d "{\"CustomerName\":\"E-Inv Buyer\",\"GSTIN\":\"27AAACS2222S1Z3\",\"State\":\"Maharashtra\",\"branchId\":$B1}" | j "d['id']")
EIITEM=$(curl -s -X POST $BASE/masters/items -H "$AUTH" -H "$CT" -d '{"ItemName":"E-Inv Widget","HSN":"7214","GSTRate":18,"Unit":"PCS","PurchaseRate":500,"SaleRate":900}' | j "d['id']")
EISUP=$(curl -s -H "$AUTH" $BASE/masters/suppliers | j "d[0]['SupplierID']")
curl -s -X POST $BASE/purchase -H "$AUTH" -H "$CT" -d "{\"branchId\":$B1,\"supplierId\":$EISUP,\"purchaseDate\":\"$TODAY\",\"vendorInvoiceNo\":\"EI-$RANDOM\",\"vendorInvoiceDate\":\"$TODAY\",\"items\":[{\"itemId\":$EIITEM,\"qty\":100,\"rate\":500,\"gst\":18}]}" > /dev/null
# A B2B invoice worth well over the e-way-bill threshold.
EIINV=$(curl -s -X POST $BASE/sales -H "$AUTH" -H "$CT" -d "{\"branchId\":$B1,\"customerId\":$EICUST,\"invoiceDate\":\"$TODAY\",\"items\":[{\"itemId\":$EIITEM,\"qty\":80,\"rate\":900,\"gst\":18}]}" | j "d['invoiceId']")

echo "  -- e-invoice --"
chk "an e-invoice is not generated yet" 'Not generated' "$(curl -s -H "$AUTH" $BASE/einvoice/sales/$EIINV)"
GEN=$(curl -s -X POST $BASE/einvoice/sales/$EIINV/generate -H "$AUTH" -H "$CT" -d '{}')
echo "  generate: $(echo "$GEN" | j "d.get('irn','')[:20]")… ack $(echo "$GEN" | j "d.get('ackNo')") ($(echo "$GEN" | j "d.get('mode')"))"
chk "generating returns a 64-char IRN" '"irn"' "$GEN"
IRNVAL=$(echo "$GEN" | j "d.get('irn','')")
chk "the IRN is a 64-char hex SHA-256" "$(node -e "console.log(/^[0-9a-f]{64}$/.test('$IRNVAL')?'HEX64':'no')")" "HEX64"
chk "a signed QR payload is returned" '"signedQR"' "$GEN"
chk "the e-invoice carries the full IRP payload" '"SellerDtls"' "$GEN"
chk "it is clearly marked sandbox" '"mode":"sandbox"' "$(echo "$GEN" | tr -d ' ')"
chk "the invoice now shows Generated" 'Generated' "$(curl -s -H "$AUTH" $BASE/einvoice/sales/$EIINV)"
chk "generating twice is refused" 'already has an IRN' "$(curl -s -X POST $BASE/einvoice/sales/$EIINV/generate -H "$AUTH" -H "$CT" -d '{}')"
chk "it can be cancelled within 24h with a reason" '"success":true' "$(curl -s -X POST $BASE/einvoice/sales/$EIINV/cancel -H "$AUTH" -H "$CT" -d '{"reason":"wrong buyer"}' | tr -d ' ')"
# A B2C invoice (no buyer GSTIN) is not e-invoice-eligible.
B2CINV=$(curl -s -X POST $BASE/sales -H "$AUTH" -H "$CT" -d "{\"branchId\":$B1,\"customerId\":$(curl -s -X POST $BASE/masters/customers -H "$AUTH" -H "$CT" -d "{\"CustomerName\":\"Walk In\",\"State\":\"Telangana\",\"branchId\":$B1}" | j "d['id']"),\"invoiceDate\":\"$TODAY\",\"items\":[{\"itemId\":$EIITEM,\"qty\":1,\"rate\":900,\"gst\":18}]}" | j "d['invoiceId']")
chk "a B2C invoice is flagged not e-invoice-eligible" '"eligible":false' "$(curl -s -H "$AUTH" $BASE/einvoice/sales/$B2CINV | tr -d ' ')"

echo "  -- e-way bill --"
chk "EWB-02: the big invoice needs an e-way bill" '"required":true' "$(curl -s -H "$AUTH" $BASE/ewaybill/sales/$EIINV/required | tr -d ' ')"
chk "EWB-02: the small B2C invoice does not" '"required":false' "$(curl -s -H "$AUTH" $BASE/ewaybill/sales/$B2CINV/required | tr -d ' ')"
EWB=$(curl -s -X POST $BASE/ewaybill/sales/$EIINV/generate -H "$AUTH" -H "$CT" -d '{"distance":450,"vehicleNo":"OD02AB1234","transMode":"1"}')
echo "  eway: no $(echo "$EWB" | j "d.get('ewbNo')") valid to $(echo "$EWB" | j "d.get('validUpto')")"
chk "an e-way bill number is generated" '"ewbNo"' "$EWB"
chk "it has a validity date" '"validUpto"' "$EWB"
chk "it carries the EWB portal payload" '"subSupplyType"' "$EWB"
chk "generating twice is refused" 'already has an e-way bill' "$(curl -s -X POST $BASE/ewaybill/sales/$EIINV/generate -H "$AUTH" -H "$CT" -d '{"distance":10}')"
chk "a services-only / small invoice is refused an e-way bill" 'No e-way bill needed' "$(curl -s -X POST $BASE/ewaybill/sales/$B2CINV/generate -H "$AUTH" -H "$CT" -d '{"distance":10}')"
chk "the e-way bill can be cancelled" '"success":true' "$(curl -s -X POST $BASE/ewaybill/sales/$EIINV/cancel -H "$AUTH" -H "$CT" -d '{"reason":"vehicle changed"}' | tr -d ' ')"
