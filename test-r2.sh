# Release R2 tests: the sales and purchase document chains, three-way match,
# approvals and dunning. Sourced by test-modules.sh.
echo
echo "== R2: sales chain quotation -> order -> delivery -> invoice =="
R2CUST=$(curl -s -X POST $BASE/masters/customers -H "$AUTH" -H "$CT" -d "{\"CustomerName\":\"Chain Buyer\",\"State\":\"Telangana\",\"Email\":\"chain@x.com\",\"branchId\":$B1}" | j "d['id']")
R2SUP=$(curl -s -H "$AUTH" $BASE/masters/suppliers | j "d[0]['SupplierID']")
R2ITEM=$(curl -s -X POST $BASE/masters/items -H "$AUTH" -H "$CT" -d '{"ItemName":"Chain Widget","GSTRate":18,"Unit":"PCS","PurchaseRate":100,"SaleRate":150}' | j "d['id']")
# stock to ship
curl -s -X POST $BASE/purchase -H "$AUTH" -H "$CT" -d "{\"branchId\":$B1,\"supplierId\":$R2SUP,\"purchaseDate\":\"$TODAY\",\"vendorInvoiceNo\":\"CH-$RANDOM\",\"vendorInvoiceDate\":\"$TODAY\",\"items\":[{\"itemId\":$R2ITEM,\"qty\":100,\"rate\":100,\"gst\":18}]}" > /dev/null

QUO=$(curl -s -X POST $BASE/orders/quotations -H "$AUTH" -H "$CT" -d "{\"branchId\":$B1,\"customerId\":$R2CUST,\"quoteDate\":\"$TODAY\",\"validUntil\":\"$TODAY\",\"items\":[{\"itemId\":$R2ITEM,\"qty\":10,\"rate\":150,\"gst\":18}]}")
QID=$(echo "$QUO" | j "d['quotationId']")
chk "a quotation is created with a number" '"quoteNo"' "$QUO"
SO=$(curl -s -X POST $BASE/orders/orders -H "$AUTH" -H "$CT" -d "{\"branchId\":$B1,\"customerId\":$R2CUST,\"orderDate\":\"$TODAY\",\"quotationId\":$QID,\"items\":[{\"itemId\":$R2ITEM,\"qty\":10,\"rate\":150,\"gst\":18}]}")
SOID=$(echo "$SO" | j "d['orderId']")
chk "a sales order is created from the quotation" '"orderNo"' "$SO"
chk "the quotation is now Accepted" 'Accepted' "$(curl -s -H "$AUTH" $BASE/orders/quotations/$QID | j "d['Status']")"

# Deliver 4 of 10, then invoice that delivery.
DEL=$(curl -s -X POST $BASE/orders/orders/$SOID/deliver -H "$AUTH" -H "$CT" -d "{\"deliveryDate\":\"$TODAY\",\"lines\":[{\"orderLineId\":$(curl -s -H "$AUTH" $BASE/orders/orders/$SOID | j "d['lines'][0]['LineID']"),\"qty\":4}],\"invoice\":true}")
echo "  delivery+invoice: $(echo "$DEL" | tr -d ' ' | head -c 160)"
chk "a partial delivery issues goods" '"deliveryNo"' "$DEL"
chk "goods issue books a COGS value" '"cogs"' "$DEL"
chk "the delivery raises a tax invoice" '"invoiceNo"' "$DEL"
chk "the order is now Partly delivered" 'Partly delivered' "$(curl -s -H "$AUTH" $BASE/orders/orders/$SOID | j "d['Status']")"
# Over-deliver is refused (can't exceed open qty).
OL=$(curl -s -H "$AUTH" $BASE/orders/orders/$SOID | j "d['lines'][0]['LineID']")
chk "cannot deliver more than the open quantity" 'open' "$(curl -s -X POST $BASE/orders/orders/$SOID/deliver -H "$AUTH" -H "$CT" -d "{\"lines\":[{\"orderLineId\":$OL,\"qty\":99}]}")"

echo
echo "== R2: credit check routes an over-limit order to approval =="
LIMCUST=$(curl -s -X POST $BASE/masters/customers -H "$AUTH" -H "$CT" -d "{\"CustomerName\":\"Tight Limit Co\",\"State\":\"Telangana\",\"CreditLimit\":1000,\"branchId\":$B1}" | j "d['id']")
BIGSO=$(curl -s -X POST $BASE/orders/orders -H "$AUTH" -H "$CT" -d "{\"branchId\":$B1,\"customerId\":$LIMCUST,\"orderDate\":\"$TODAY\",\"items\":[{\"itemId\":$R2ITEM,\"qty\":50,\"rate\":150,\"gst\":18}]}")
chk "an order over the credit limit needs approval" '"approvalRequired":true' "$(echo "$BIGSO" | tr -d ' ')"
APID=$(echo "$BIGSO" | j "d['approvalId']")
chk "the order sits Pending approval" 'Pending approval' "$(curl -s -H "$AUTH" $BASE/orders/orders/$(echo "$BIGSO" | j "d['orderId']") | j "d['Status']")"
# The creator (admin) cannot approve their own (ROL-05). A different approver can.
SELF=$(curl -s -X POST $BASE/approvals/$APID/approve -H "$AUTH" -H "$CT" -d '{}')
chk "the creator cannot approve their own document" 'cannot approve' "$SELF"
# Make a second admin to approve.
CA_ROLE=$(curl -s -H "$AUTH" $BASE/branches/roles/list | j "[r['RoleID'] for r in d if r['RoleName']=='Company Admin'][0]")
curl -s -X POST $BASE/branches/users -H "$AUTH" -H "$CT" -d "{\"branchId\":$B1,\"roleId\":$CA_ROLE,\"userName\":\"approver1\",\"fullName\":\"Approver\",\"password\":\"Approve@123\"}" > /dev/null
ATOK=$(utok approver1 Approve@123)
chk "a different approver can approve it" '"status":"Approved"' "$(curl -s -X POST $BASE/approvals/$APID/approve -H "Authorization: Bearer $ATOK" -H "$CT" -d '{"comment":"ok"}' | tr -d ' ')"
chk "approval releases the order to Open" 'Open' "$(curl -s -H "$AUTH" $BASE/orders/orders/$(echo "$BIGSO" | j "d['orderId']") | j "d['Status']")"

echo
echo "== R2: purchase chain PO -> GRN -> bill with three-way match =="
PO=$(curl -s -X POST $BASE/procurement/orders -H "$AUTH" -H "$CT" -d "{\"branchId\":$B1,\"supplierId\":$R2SUP,\"poDate\":\"$TODAY\",\"items\":[{\"itemId\":$R2ITEM,\"qty\":20,\"rate\":100,\"gst\":18}]}")
POID=$(echo "$PO" | j "d['poId']")
chk "a purchase order is created" '"poNo"' "$PO"
# Receive all 20 and bill at PO price -> match passes and posts.
GRN=$(curl -s -X POST $BASE/procurement/orders/$POID/receive -H "$AUTH" -H "$CT" -d "{\"grnDate\":\"$TODAY\",\"bill\":true,\"vendorInvoiceNo\":\"GRNB-$RANDOM\",\"vendorInvoiceDate\":\"$TODAY\"}")
echo "  grn+bill: $(echo "$GRN" | tr -d ' ' | head -c 200)"
chk "a goods receipt is created" '"grnNo"' "$GRN"
chk "a matching bill posts straight away" '"status":"Posted"' "$(echo "$GRN" | tr -d ' ')"
chk "the three-way match reports matched" '"matched":true' "$(echo "$GRN" | tr -d ' ')"

# A second PO, received, then billed at a higher price -> match fails -> Draft held for approval.
PO2=$(curl -s -X POST $BASE/procurement/orders -H "$AUTH" -H "$CT" -d "{\"branchId\":$B1,\"supplierId\":$R2SUP,\"poDate\":\"$TODAY\",\"items\":[{\"itemId\":$R2ITEM,\"qty\":10,\"rate\":100,\"gst\":18}]}")
PO2ID=$(echo "$PO2" | j "d['poId']")
GRN2=$(curl -s -X POST $BASE/procurement/orders/$PO2ID/receive -H "$AUTH" -H "$CT" -d "{\"grnDate\":\"$TODAY\"}")
GRN2ID=$(echo "$GRN2" | j "d['grnId']")
GL=$(curl -s -H "$AUTH" $BASE/procurement/grn | j "d[0]['GRNID']")
BILL2=$(curl -s -X POST $BASE/procurement/grn/$GRN2ID/bill -H "$AUTH" -H "$CT" -d "{\"vendorInvoiceNo\":\"OV-$RANDOM\",\"vendorInvoiceDate\":\"$TODAY\",\"lines\":[{\"grnLineId\":$(curl -s -H "$AUTH" $BASE/procurement/orders/$PO2ID | j "d['lines'][0]['LineID']"),\"rate\":130}]}")
echo "  mismatch bill: $(echo "$BILL2" | tr -d ' ' | head -c 160)"
chk "a price mismatch holds the bill as a draft" '"status":"Draft"' "$(echo "$BILL2" | tr -d ' ')"
chk "the mismatch is explained" 'price' "$BILL2"
BID=$(echo "$BILL2" | j "d['purchaseId']")
chk "the held bill can be approved and posted" '"status":"Posted"' "$(curl -s -X POST $BASE/procurement/bills/$BID/approve-post -H "$AUTH" -H "$CT" -d '{}' | tr -d ' ')"

echo
echo "== R2: reorder proposal flags low stock =="
chk "the reorder proposal runs" 'count' "$(curl -s -H "$AUTH" $BASE/procurement/reorder-proposal)"

echo
echo "== R2: dunning procedures and run =="
chk "a default dunning procedure exists" 'Standard' "$(curl -s -H "$AUTH" $BASE/dunning/procedures)"
# Create an overdue invoice: back-date it well past the term.
OLD=$(date -d "$TODAY -40 days" +%Y-%m-%d 2>/dev/null || echo "2026-09-01")
DUNCUST=$(curl -s -X POST $BASE/masters/customers -H "$AUTH" -H "$CT" -d "{\"CustomerName\":\"Overdue Co\",\"State\":\"Telangana\",\"Email\":\"overdue@x.com\",\"branchId\":$B1}" | j "d['id']")
curl -s -X POST $BASE/sales -H "$AUTH" -H "$CT" -d "{\"branchId\":$B1,\"customerId\":$DUNCUST,\"invoiceDate\":\"$OLD\",\"items\":[{\"itemId\":$R2ITEM,\"qty\":5,\"rate\":150,\"gst\":18}]}" > /dev/null
PREV=$(curl -s -H "$AUTH" $BASE/dunning/run/preview)
echo "  dunning preview: $(echo "$PREV" | j "d['count']") customers, total $(echo "$PREV" | j "d['totalOverdue']")"
chk "the overdue customer appears in the dunning proposal" 'Overdue Co' "$PREV"
RUN=$(curl -s -X POST $BASE/dunning/run -H "$AUTH" -H "$CT" -d "{\"customerId\":$DUNCUST,\"channel\":\"Email\"}")
chk "the dunning run records a notice" '"total":1' "$(echo "$RUN" | tr -d ' ')"
chk "the notice is in the dunning history" 'Email' "$(curl -s -H "$AUTH" "$BASE/dunning/history?customerId=$DUNCUST")"
# DUN-08: a dunning block takes the customer out of the run.
curl -s -X POST $BASE/dunning/customers/$DUNCUST/block -H "$AUTH" -H "$CT" -d '{"block":true,"reason":"in dispute"}' > /dev/null
BLOCKED_SEEN=$(curl -s -H "$AUTH" $BASE/dunning/run/preview | python3 -c "import sys,json;d=json.load(sys.stdin);print('yes' if any(p['customerId']==$DUNCUST for p in d['proposal']) else 'no')")
chk "a blocked customer drops out of the proposal" 'no' "$BLOCKED_SEEN"
