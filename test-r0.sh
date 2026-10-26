# Release R0 tests: sign-in security, reset flow, escaping, CSP, backup, numbering.
# Sourced by test-modules.sh (reuses chk, j, BASE, AUTH, CT, B1, B2, TODAY).
# Needs read access to the test database file for the reset-code and lock checks.
echo
echo "== R0: password rules, lockout, forced change =="
DBF="$(cd "$(dirname "$0")" && pwd)/backend/db/test.db"
dbq() { node -e "const D=require('$(cd "$(dirname "$0")" && pwd)/backend/node_modules/better-sqlite3');const d=new D('$DBF',{readonly:true});const r=d.prepare(process.argv[1]).all(...process.argv.slice(2));console.log(JSON.stringify(r));" "$@"; }

ACC_R=$(echo "$ROLES" | j "[r['RoleID'] for r in d if r['RoleName']=='Accountant'][0]")
chk "user creation enforces 8 characters" 'at least 8' "$(curl -s -X POST $BASE/branches/users -H "$AUTH" -H "$CT" -d "{\"branchId\":$B1,\"roleId\":$ACC_R,\"userName\":\"shortpw\",\"password\":\"abc12\"}")"
curl -s -X POST $BASE/branches/users -H "$AUTH" -H "$CT" -d "{\"branchId\":$B1,\"roleId\":$ACC_R,\"userName\":\"lockme\",\"fullName\":\"Lock Me\",\"email\":\"lockme@example.com\",\"password\":\"Lockme@1234\"}" > /dev/null
chk "a new user is forced to change password at first sign-in" '"mustChangePassword":true' "$(curl -s -X POST $BASE/auth/login -H "$CT" -d '{"username":"lockme","password":"Lockme@1234"}')"
LT=$(curl -s -X POST $BASE/auth/login -H "$CT" -d '{"username":"lockme","password":"Lockme@1234"}' | j "d['token']")
chk "every other API is refused until the password is changed" 'must change your password' "$(curl -s -H "Authorization: Bearer $LT" $BASE/masters/customers)"
chk "the change-password route itself still works" 'Password changed' "$(curl -s -X POST $BASE/auth/change-password -H "Authorization: Bearer $LT" -H "$CT" -d '{"currentPassword":"Lockme@1234","newPassword":"Chosen@5678"}')"
chk "after that the account works normally" 'CustomerName' "$(curl -s -H "Authorization: Bearer $LT" "$BASE/masters/customers")"

for i in 1 2 3 4 5; do curl -s -X POST $BASE/auth/login -H "$CT" -d '{"username":"lockme","password":"wrong-guess"}' > /dev/null; done
chk "five wrong passwords lock the account" 'locked' "$(curl -s -X POST $BASE/auth/login -H "$CT" -d '{"username":"lockme","password":"wrong-guess"}')"
chk "even the right password is refused while locked" 'locked' "$(curl -s -X POST $BASE/auth/login -H "$CT" -d '{"username":"lockme","password":"Chosen@5678"}')"
chk "the lock is in the audit log" 'ACCOUNT_LOCKED' "$(curl -s -H "$AUTH" "$BASE/admin/audit?search=lock&pageSize=50" ; curl -s -H "$AUTH" "$BASE/admin/audit?action=ACCOUNT_LOCKED")"
LUID=$(curl -s -H "$AUTH" $BASE/branches/users/list | j "[u['UserID'] for u in d if u['UserName']=='lockme'][0]")
curl -s -X POST $BASE/branches/users/$LUID/reset-password -H "$AUTH" -H "$CT" -d '{"newPassword":"Unlocked@123"}' > /dev/null
chk "an administrator reset clears the lock" 'token' "$(curl -s -X POST $BASE/auth/login -H "$CT" -d '{"username":"lockme","password":"Unlocked@123"}')"

echo
echo "== R0: forgot password goes by email, never on screen =="
FP=$(curl -s -X POST $BASE/auth/forgot-password -H "$CT" -d '{"username":"lockme"}')
echo "  response: $FP"
chk "the response is the same generic message" 'If that account exists' "$FP"
chk "the response carries no reset token" 'XX' "$(echo "$FP" | grep -qiE 'token|devReset' && echo LEAK || echo XX)"
chk "unknown users get the identical answer" 'If that account exists' "$(curl -s -X POST $BASE/auth/forgot-password -H "$CT" -d '{"username":"no-such-person"}')"
chk "the message was written to the delivery log" 'NotSent' "$(dbq "SELECT Status FROM MessageLog WHERE TemplateCode='PASSWORD_RESET' ORDER BY MessageID DESC LIMIT 1")"
chk "...addressed to the registered email" 'lockme@example.com' "$(dbq "SELECT ToAddress FROM MessageLog WHERE TemplateCode='PASSWORD_RESET' ORDER BY MessageID DESC LIMIT 1")"
chk "...and the delivery log API hides the one-time code" 'hidden' "$(curl -s -H "$AUTH" "$BASE/messaging/log?pageSize=5")"
chk "reset with a 6-character password is refused" 'at least 8' "$(curl -s -X POST $BASE/auth/reset-password -H "$CT" -d '{"username":"lockme","token":"x","newPassword":"abc123"}')"
RESET_BODY=$(dbq "SELECT Body FROM MessageLog WHERE TemplateCode='PASSWORD_RESET' ORDER BY MessageID DESC LIMIT 1")
RTOKEN=$(echo "$RESET_BODY" | python3 -c "import sys,json,re;b=json.load(sys.stdin)[0]['Body'];print(re.search(r'code to reset your Mfynix password: (\w+)',b).group(1))")
chk "a wrong code is refused" 'Invalid or expired' "$(curl -s -X POST $BASE/auth/reset-password -H "$CT" -d '{"username":"lockme","token":"deadbeef","newPassword":"Another@1234"}')"
chk "the emailed code resets the password" 'has been reset' "$(curl -s -X POST $BASE/auth/reset-password -H "$CT" -d "{\"username\":\"lockme\",\"token\":\"$RTOKEN\",\"newPassword\":\"Another@1234\"}")"
chk "the code works only once" 'Invalid or expired' "$(curl -s -X POST $BASE/auth/reset-password -H "$CT" -d "{\"username\":\"lockme\",\"token\":\"$RTOKEN\",\"newPassword\":\"Third@12345\"}")"
chk "the new password signs in" 'token' "$(curl -s -X POST $BASE/auth/login -H "$CT" -d '{"username":"lockme","password":"Another@1234"}')"

echo
echo "== R0: messaging providers =="
chk "an email provider needs host and from" 'needs an SMTP host' "$(curl -s -X PUT $BASE/messaging/providers/Email -H "$AUTH" -H "$CT" -d '{"config":{}}')"
chk "a gateway needs a URL" 'gateway URL' "$(curl -s -X PUT $BASE/messaging/providers/SMS -H "$AUTH" -H "$CT" -d '{"config":{"url":"ftp://x"}}')"
chk "email provider saved" 'success' "$(curl -s -X PUT $BASE/messaging/providers/Email -H "$AUTH" -H "$CT" -d '{"config":{"host":"127.0.0.1","port":1,"from":"a@b.c","pass":"secret-pass"},"isActive":true}')"
chk "the stored password is masked on read" '\*\*\*\*' "$(curl -s -H "$AUTH" $BASE/messaging/providers)"
chk "a failed send is logged as Failed, not lost" 'Failed' "$(curl -s -X POST $BASE/messaging/providers/Email/test -H "$AUTH" -H "$CT" -d '{"to":"x@y.z"}')"
curl -s -X PUT $BASE/messaging/providers/Email -H "$AUTH" -H "$CT" -d '{"config":{"host":"127.0.0.1","from":"a@b.c"},"isActive":false}' > /dev/null

echo
echo "== R0: headers, CORS, escaping =="
HDRS=$(curl -s -D - -o /dev/null http://localhost:3999/index.html)
chk "a content security policy is sent" 'Content-Security-Policy' "$HDRS"
chk "no framing" "frame-ancestors 'none'" "$HDRS"
chk "scripts only from self" "script-src 'self'" "$HDRS"
CORS=$(curl -s -D - -o /dev/null -H "Origin: https://evil.example" $BASE/health)
chk "a foreign origin gets no CORS permission" 'XX' "$(echo "$CORS" | grep -qi 'access-control-allow-origin' && echo LEAK || echo XX)"
chk "the sign-in page shows no credentials" 'XX' "$(curl -s http://localhost:3999/index.html | grep -qiE 'Admin@123|Demo staff login' && echo LEAK || echo XX)"

echo
echo "== R0: document numbers fit 16 characters =="
N16=$(curl -s -X POST $BASE/sales -H "$AUTH" -H "$CT" -d "{\"branchId\":$B2,\"customerId\":$CUST_B2C,\"invoiceDate\":\"$TODAY\",\"items\":[{\"itemId\":$ITEM,\"qty\":1,\"rate\":10,\"gst\":0}]}" | j "d['invoiceNo']")
python3 - "$N16" <<'PYEOF'
import re,sys
n=sys.argv[1]
assert len(n)<=16, f"{n} is {len(n)} chars"
assert re.fullmatch(r'[A-Za-z0-9\-/]+',n), n
print(f"  PASS: {n} is {len(n)} characters, letters/digits/hyphen only")
PYEOF
[ $? -eq 0 ] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))
chk "a branch code that would break the limit is refused" 'Branch code must be 1 to 4' "$(curl -s -X POST $BASE/branches -H "$AUTH" -H "$CT" -d '{"branchName":"Long","branchCode":"LONGCODE"}')"
chk "a prefix that would break the limit is refused" 'at most 16' "$(curl -s -X PUT $BASE/admin/company -H "$AUTH" -H "$CT" -d '{"invoicePrefix":"TAXINVOICE"}')"

echo
echo "== R0: verified backups =="
BK=$(curl -s -X POST $BASE/admin/backups -H "$AUTH" -H "$CT")
echo "  backup: $(echo "$BK" | head -c 200)"
chk "a backup is taken and verified" '"verified":true' "$(echo "$BK" | tr -d ' ')"
BKID=$(echo "$BK" | j "d['backupId']")
chk "the restore test passes" '"ok":true' "$(curl -s -X POST $BASE/admin/backups/$BKID/test-restore -H "$AUTH" | tr -d ' ')"
chk "history lists it" 'integrity_check ok' "$(curl -s -H "$AUTH" $BASE/admin/backups)"
chk "only a Super Admin may run backups" 'Insufficient permissions' "$(curl -s -X POST $BASE/admin/backups -H "$PA")"
