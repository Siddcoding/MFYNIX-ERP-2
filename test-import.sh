# Bulk import from Excel / CSV.
# Sourced from test-modules.sh, so it shares $BASE, $AUTH, $CT, chk() and j().
#
# The assertions that matter are not "did it return 200" but: did loosely-named
# headers get matched, did a real .xlsx parse, were duplicates skipped rather
# than overwritten, was a bad row rejected without taking the good rows with it,
# and did the rows that claim to be imported actually land in the database.

IMPDIR=$(mktemp -d)

# ---- Build the fixtures -------------------------------------------------
# Deliberately awkward headers: different case, spaces, underscores, an alias
# ("Party" for the customer name), and a column the importer does not know.
cat > "$IMPDIR/customers.csv" <<'CSV'
Party,GST Number,mobile,Email,state,Credit Limit,credit_days,Loyalty Tier
Northwind Steel,29AAACN1111N1ZK,9800011111,ops@northwind.example,Karnataka,"2,50,000",30,Gold
Sunrise Hardware,27AAACS2222S1Z3,9800022222,,Maharashtra,₹100000,15,Silver
Deccan Fabricators,,9800033333,accounts@deccan.example,Telangana,,,Bronze
CSV

# A second sheet that overlaps the first: one exact duplicate name, one
# duplicate GSTIN under a different name, and one genuinely new row.
cat > "$IMPDIR/customers-again.csv" <<'CSV'
Party,GST Number,State
Northwind Steel,29AAACN9999N1Z8,Karnataka
Northwind Steel Pvt Ltd,29AAACN1111N1ZK,Karnataka
Konark Traders,21AAACK3333K1ZX,Odisha
CSV

# Rows that must be rejected individually without stopping the good one.
cat > "$IMPDIR/customers-bad.csv" <<'CSV'
Party,Credit Limit
,50000
Bad Number Co,not-a-number
Valid Late Entry,75000
CSV

cat > "$IMPDIR/items.csv" <<'CSV'
Product Name,HSN,GST%,UOM,Sale Rate,Cost Price,Reorder
MS Angle 50mm,7216,18,KG,92.50,61,150
Welding Rod 3.15,8311,18,BOX,410,300,20
CSV

cat > "$IMPDIR/users.csv" <<'CSV'
UserName,Full Name,Email,Role,Branch,Password
imp.store1,Import Store One,store1@example.com,Store Manager,HYD,
imp.cash1,Import Cash One,,Cashier,BBSR,Cashier@2026
admin,Clash With Admin,,Accountant,HYD,
bad.role,Bad Role Person,,Chief Wizard,HYD,
x,Too Short Username,,Cashier,HYD,
CSV

# A real .xlsx, not a CSV with the wrong extension - the point is to prove the
# binary path works, so it is built with the same library the server reads with.
node -e "
const XLSX = require('$PWD/backend/node_modules/xlsx');
const rows = [
  ['Supplier Name','GSTIN','State','Credit Days'],
  ['Bharat Alloys','24AAACB4444B1ZD','Gujarat',45],
  ['Coastal Metals','32AAACC5555C1Z7','Kerala',30]
];
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Suppliers');
XLSX.writeFile(wb, '$IMPDIR/suppliers.xlsx');
" || echo "  (could not build the xlsx fixture)"

b64() { base64 -w0 "$1" 2>/dev/null || base64 "$1" | tr -d '\n'; }
post_import() { # post_import <endpoint> <file>
  local payload="$IMPDIR/payload.json"
  python3 - "$2" > "$payload" <<'PY'
import base64, json, sys
p = sys.argv[1]
print(json.dumps({'filename': p.split('/')[-1], 'dataBase64': base64.b64encode(open(p,'rb').read()).decode()}))
PY
  curl -s -X POST "$1" -H "$AUTH" -H "$CT" --data-binary "@$payload"
}

echo
echo "== IMPORT: customers from CSV with loosely-named headers =="
R1=$(post_import "$BASE/masters/customers/import" "$IMPDIR/customers.csv")
chk "csv import reports three rows imported" '"inserted":3' "$R1"
chk "the unknown 'Loyalty Tier' column is ignored rather than failing" '"failed":0' "$R1"

# The alias, the money formatting and the row that landed must all be real.
NW=$(curl -s -H "$AUTH" $BASE/masters/customers | python3 -c "
import sys,json
d=json.load(sys.stdin)
m=[c for c in d if c['CustomerName']=='Northwind Steel']
print(json.dumps(m[0]) if m else '{}')")
chk "the 'Party' column was read as the customer name" 'Northwind Steel' "$NW"
chk "\"2,50,000\" was parsed as 250000" '"CreditLimit": 250000' "$(echo "$NW" | python3 -m json.tool)"
chk "credit days came through" '"CreditDays": 30' "$(echo "$NW" | python3 -m json.tool)"
chk "the rupee sign was stripped from the second row" '100000' \
  "$(curl -s -H "$AUTH" $BASE/masters/customers | python3 -c "
import sys,json
d=json.load(sys.stdin)
print([c['CreditLimit'] for c in d if c['CustomerName']=='Sunrise Hardware'][0])")"

echo
echo "== IMPORT: duplicates are skipped, never overwritten =="
R2=$(post_import "$BASE/masters/customers/import" "$IMPDIR/customers-again.csv")
chk "one new row imported from the overlapping sheet" '"inserted":1' "$R2"
chk "two rows skipped as duplicates" '"skipped":2' "$R2"
chk "the duplicate name is named in the reason" 'already exists' "$R2"

# The critical property: the re-upload must not have changed the original.
chk "the original GSTIN was left alone" '29AAACN1111N1ZK' \
  "$(curl -s -H "$AUTH" $BASE/masters/customers | python3 -c "
import sys,json
d=json.load(sys.stdin)
print([c['GSTIN'] for c in d if c['CustomerName']=='Northwind Steel'][0])")"

echo
echo "== IMPORT: bad rows are rejected one by one =="
R3=$(post_import "$BASE/masters/customers/import" "$IMPDIR/customers-bad.csv")
chk "the blank-name row is rejected" 'CustomerName is blank' "$R3"
chk "the non-numeric credit limit is rejected" 'is not a number' "$R3"
chk "two rows rejected" '"failed":2' "$R3"
chk "the good row in the same file still imported" '"inserted":1' "$R3"
chk "and it really is in the database" 'Valid Late Entry' \
  "$(curl -s -H "$AUTH" $BASE/masters/customers)"

echo
echo "== IMPORT: a real .xlsx workbook =="
if [ -f "$IMPDIR/suppliers.xlsx" ]; then
  R4=$(post_import "$BASE/masters/suppliers/import" "$IMPDIR/suppliers.xlsx")
  chk "xlsx suppliers imported" '"inserted":2' "$R4"
  chk "supplier landed in the database" 'Bharat Alloys' "$(curl -s -H "$AUTH" $BASE/masters/suppliers)"
  chk "re-uploading the same workbook imports nothing" '"inserted":0' \
    "$(post_import "$BASE/masters/suppliers/import" "$IMPDIR/suppliers.xlsx")"
fi

echo
echo "== IMPORT: items =="
R5=$(post_import "$BASE/masters/items/import" "$IMPDIR/items.csv")
chk "items imported" '"inserted":2' "$R5"
chk "GST% read from a percent-named column" '18' \
  "$(curl -s -H "$AUTH" $BASE/masters/items | python3 -c "
import sys,json
d=json.load(sys.stdin)
print([i['GSTRate'] for i in d if i['ItemName']=='MS Angle 50mm'][0])")"

echo
echo "== IMPORT: users =="
R6=$(post_import "$BASE/branches/users/import" "$IMPDIR/users.csv")
chk "two users imported" '"inserted":2' "$R6"
chk "an existing username is skipped, not overwritten" 'already taken' "$R6"
chk "an unknown role is rejected with the valid list" 'does not exist' "$R6"
chk "a too-short username is rejected" 'not a usable username' "$R6"

# A generated password must actually work, and must be the only one echoed.
GEN=$(echo "$R6" | j "[r['generatedPassword'] for r in d['results'] if r.get('userName')=='imp.store1'][0]")
chk "a password was generated for the blank cell" '..........' "$GEN"
# Checked against the stored hash rather than through /auth/login, because by
# this point in the run the login rate limiter has legitimately kicked in - and
# "the hash verifies" is the stronger claim anyway.
verify_password() { # verify_password <username> <plaintext>
  node -e "
const bcrypt = require('$PWD/backend/node_modules/bcryptjs');
const Database = require('$PWD/backend/node_modules/better-sqlite3');
const db = new Database('$PWD/backend/db/test.db', { readonly: true });
const u = db.prepare('SELECT PasswordHash FROM Users WHERE UserName = ?').get(process.argv[1]);
console.log(u && bcrypt.compareSync(process.argv[2], u.PasswordHash) ? 'VALID' : 'INVALID');
" "$1" "$2"
}
chk "the generated password verifies against the stored hash" '^VALID$' "$(verify_password imp.store1 "$GEN")"
chk "a wrong password does not" '^INVALID$' "$(verify_password imp.store1 'definitely-not-it')"
chk "a password supplied in the sheet is not echoed back" '^None$' \
  "$(echo "$R6" | j "[r['generatedPassword'] for r in d['results'] if r.get('userName')=='imp.cash1'][0]")"
chk "the password typed into the sheet is the one that was stored" '^VALID$' \
  "$(verify_password imp.cash1 'Cashier@2026')"
chk "the imported user landed in the right branch" 'Import Store One' \
  "$(curl -s -H "$AUTH" $BASE/branches/users/list)"

echo
echo "== IMPORT: templates and refusals =="
chk "customer template downloads with its headings" 'CustomerName' \
  "$(curl -s -H "$AUTH" "$BASE/masters/customers/import/template.csv")"
chk "user template lists the columns" 'UserName,FullName' \
  "$(curl -s -H "$AUTH" "$BASE/branches/users/import/template.csv")"
chk "an empty upload is refused" 'No file was received' \
  "$(curl -s -X POST $BASE/masters/customers/import -H "$AUTH" -H "$CT" -d '{}')"
chk "a file that is not a spreadsheet is refused" 'could not be read\|no sheets\|empty\|headings' \
  "$(curl -s -X POST $BASE/masters/customers/import -H "$AUTH" -H "$CT" \
     -d '{"filename":"notes.xlsx","dataBase64":"bm90IGEgc3ByZWFkc2hlZXQgYXQgYWxs"}')"

if [ -n "${CTOK:-}" ]; then
  chk "a cashier cannot bulk-import customers" 'Insufficient permissions' \
    "$(curl -s -X POST $BASE/masters/customers/import -H "Authorization: Bearer $CTOK" -H "$CT" \
       -d '{"filename":"x.csv","dataBase64":"TmFtZQpBY21l"}')"
  chk "a cashier cannot bulk-import users" 'Insufficient permissions' \
    "$(curl -s -X POST $BASE/branches/users/import -H "Authorization: Bearer $CTOK" -H "$CT" \
       -d '{"filename":"x.csv","dataBase64":"TmFtZQpBY21l"}')"
fi

rm -rf "$IMPDIR"
