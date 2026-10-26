#!/bin/bash
# Restarts the backend on a FRESH database, then runs the module test suite.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/backend"
if [ -f /tmp/erp.pid ]; then kill "$(cat /tmp/erp.pid)" 2>/dev/null; sleep 1; fi
rm -f db/test.db db/test.db-wal db/test.db-shm
nohup env DB_PATH=$(pwd)/db/test.db PORT=3999 JWT_SECRET=testsecret ADMIN_PASSWORD=Admin@123 SEED_NO_FORCE_CHANGE=1 BACKUP_DISABLED=1 AUTH_RATE_MAX=1000 node server.js > /tmp/srv.log 2>&1 &
echo $! > /tmp/erp.pid
for i in $(seq 1 20); do
  curl -s http://localhost:3999/api/health > /dev/null 2>&1 && break
  sleep 0.5
done
cd "$SCRIPT_DIR" && bash test-modules.sh
