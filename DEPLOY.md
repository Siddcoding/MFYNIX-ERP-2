# Deploying MFinTech Smart ERP

The app is a single Node process that serves both the API and the frontend, so
there is nothing to build and no second service to run. Wherever you put it, the
deployment comes down to four things:

| | Why it matters |
|---|---|
| **A persistent disk, and `DB_PATH` pointing at it** | Everything lives in one SQLite file. Almost every platform replaces the application directory on each deploy, so a database sitting inside the code folder is destroyed every time you push. |
| **`JWT_SECRET` set to a long random string** | The server refuses to boot in production without one. A known secret means anyone who has read the code can forge a login token for any user. |
| **`NODE_ENV=production`** | Turns on that refusal, and the security posture that goes with it. |
| **One instance, not several** | Two instances would each open their own copy of the SQLite file and the company's data would silently fork in half. Scale up (a bigger machine), never out, until you move to PostgreSQL. |

Generate the secret with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

---

## Render

The repo has a `render.yaml`, so the whole service can come from the file rather
than from a form.

**Blueprint route (easiest):** Render dashboard → **New** → **Blueprint** →
pick the repo → **Apply**. It reads `render.yaml`, creates the web service,
generates `JWT_SECRET` for you and mounts the disk.

**Manual route,** if you would rather see every setting:

- **New** → **Web Service** → connect the repo
- Root directory: `backend`
- Build command: `npm install`
- Start command: `npm start`
- Instance type: **Starter** or above (see the warning below)
- Health check path: `/api/health`
- Environment variables:
  - `NODE_ENV` = `production`
  - `JWT_SECRET` = the random string you generated
  - `DB_PATH` = `/var/data/mfintech.db`
- **Disks** → Add disk → name `mfintech-data`, mount path `/var/data`, size 1 GB

### All environment variables

| Variable | Default | Purpose |
|---|---|---|
| `JWT_SECRET` | — (required in production) | Signs login tokens; the server refuses to boot in production without it |
| `NODE_ENV` | — | Set to `production` to enforce the secret and secure posture |
| `DB_PATH` | `backend/db/mfintech.db` | SQLite database file location (put it on a mounted disk) |
| `PORT` | `3000` | HTTP port |
| `ADMIN_PASSWORD` | random (printed once at first boot) | First admin's password; otherwise a random one is printed to the log once |
| `SEED_NO_FORCE_CHANGE` | `0` | `1` skips the forced password change for the seeded admin (tests/demos only) |
| `ALLOWED_ORIGINS` | same-origin | Comma-separated list of origins allowed by CORS |
| `PUBLIC_URL` | empty | Base URL used in emailed reset / portal-invite links |
| `SESSION_IDLE_MINUTES` | `60` | Idle timeout before a (non-remembered) session must sign in again |
| `MAX_FAILED_LOGINS` | `5` | Failed sign-ins before an account locks |
| `LOCK_MINUTES` | `15` | How long an account stays locked |
| `AUTH_RATE_MAX` | `20` | Max auth requests per window (raise for test suites) |
| `BACKUP_DISABLED` | `0` | `1` turns off the scheduled backup (e.g. in tests) |
| `BACKUP_HOUR` | `2` | Hour of day (0–23) after which the daily backup is taken |
| `BACKUP_KEEP_DAYS` | `14` | How many days of backups to retain |
| `BACKUP_DIR` | next to `DB_PATH` | Where backup snapshots are written |
| `MATCH_PRICE_TOLERANCE` | `0.02` | Three-way-match price tolerance (fraction, e.g. 0.02 = 2%) |
| `MATCH_QTY_TOLERANCE` | `0` | Three-way-match quantity tolerance (fraction) |
| `EWAY_THRESHOLD` | `50000` | Invoice value (₹) above which an e-way bill is required |
| `EINVOICE_DISABLED` | `0` | `1` turns off e-invoice generation |

Email/SMS/WhatsApp providers are **not** environment variables — configure them
per company at runtime under **Admin → Messaging**.

> **The free plan cannot mount a disk.** On free, the filesystem is wiped on
> every deploy and every restart — including the automatic restart after the
> service idles out. The ERP would reset to an empty demo company, losing every
> invoice, customer and payslip entered since the last push. Use the free plan
> to show the client the app; do not put real business data on it.

Then set `DB_PATH` to a path *inside the mount* (`/var/data/mfintech.db`, not
`/var/data`), and deploy. First boot seeds the demo company and prints the
admin login in the logs.

---

## Docker — Railway, Fly.io, Koyeb, Cloud Run, App Runner, or your own server

The `Dockerfile` at the project root is the portable route; nothing in it is
tied to a particular host. Build from the **project root**, not from `backend`,
because the server serves the frontend from a sibling folder.

```bash
docker build -t mfintech-erp .

docker run -d -p 3000:3000 \
  -v mfintech-data:/data \
  -e NODE_ENV=production \
  -e DB_PATH=/data/mfintech.db \
  -e JWT_SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")" \
  --name mfintech-erp mfintech-erp
```

Or with Compose, which is the tidier option on a VPS:

```bash
export JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")
docker compose up -d --build
```

**Railway:** New Project → Deploy from GitHub. It detects the Dockerfile.
Add a **Volume** mounted at `/data`, then set `DB_PATH=/data/mfintech.db`,
`JWT_SECRET` and `NODE_ENV=production` under Variables.

**Fly.io:** `fly.toml` is included.

```bash
fly launch --no-deploy        # keep the existing fly.toml when it asks
fly volumes create mfintech_data --size 1 --region sin
fly secrets set JWT_SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")"
fly deploy
```

Leave `min_machines_running = 1` and `auto_stop_machines = false` as they are in
the file. A machine that sleeps mid-transaction is a bad thing to do to a
database.

**Google Cloud Run / AWS App Runner:** both work, but both are built around
containers that come and go and have no persistent local disk. You would need
to mount a filesystem (Cloud Run supports a GCS volume or Filestore) and pin
`max_instances = 1`. If you are already on that kind of platform, moving to
PostgreSQL is the more natural step than fighting to keep SQLite alive.

---

## A plain VPS (DigitalOcean, Hetzner, an office server)

Without Docker:

```bash
git clone https://github.com/YOUR-USERNAME/mfintech-erp.git
cd mfintech-erp/backend
npm install --omit=dev

sudo mkdir -p /var/lib/mfintech && sudo chown $USER /var/lib/mfintech

cat > .env <<EOF
NODE_ENV=production
PORT=3000
DB_PATH=/var/lib/mfintech/mfintech.db
TRUST_PROXY=1
JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")
EOF

npm start
```

To keep it running after you log out, use pm2 (`npm i -g pm2 && pm2 start
server.js --name mfintech && pm2 save && pm2 startup`) or a systemd unit. Put
nginx or Caddy in front for HTTPS — a login form on plain HTTP sends passwords
in clear text across the network.

---

## After the first deploy, every time

1. **Sign in as `admin` / `Admin@123` and change the password immediately.** The
   seeded credentials are in this repo and in the README; on a public URL they
   are effectively no password at all.
2. Check `https://your-app/api/health` returns `{"status":"ok","database":"ok"}`.
   It reports the database too, because a process that is up but cannot read its
   own data is not healthy.
3. Set up backups. *Settings → Backup* downloads a consistent copy (it uses
   SQLite's `VACUUM INTO`, so it is safe to take while people are working).
   Do it on a schedule — a mounted disk protects you from deploys, not from a
   mistaken year-end close or a platform outage.
4. Fill in Company Master under *Settings*, then create your real branches and
   users before anyone starts entering transactions.

---

## Things that will bite you if nobody mentions them

**The rate limiter and proxies.** Every platform terminates TLS in front of the
app, so without `trust proxy` the server sees the proxy's IP on every request
and the login limiter (10 attempts per 15 minutes) would count the whole company
as one person — ten failed logins anywhere and everybody is locked out. The
server now sets this automatically when `NODE_ENV=production`; `TRUST_PROXY`
overrides it if your setup has a different number of hops.

**Pin the Node version.** `better-sqlite3` is a native module and only ships
prebuilt binaries for current LTS releases. Left to itself, Render reads
`engines` from `package.json` and installs the newest version that satisfies it
— which is how a build ends up on Node 26 and fails to compile. The repo now
carries a `.node-version` file (`20`) and an upper bound in `engines`, which
settles it on every host that reads either. Node 20 is also pinned in the
Dockerfile and in `render.yaml`. If you do change Node major versions, redeploy
from a clean build rather than reusing a cached `node_modules`.

**Old databases upgrade themselves.** Schema changes are applied on boot with
`ensureColumn`, so deploying a newer build over an existing database adds the
new columns in place. It is one-way: take a backup before deploying a build you
have not tried, because there is no downgrade path.

**Scaling.** SQLite comfortably handles dozens of branches at normal ERP volume,
and it is the reason this deploys with no database server to run. When you
genuinely outgrow it, the schema ports to PostgreSQL with minor syntax changes —
mainly `AUTOINCREMENT` → `SERIAL` and `datetime('now')` → `NOW()` — and the
change is confined to `db/index.js` and `db/schema.sql`.

**Running the test suites after deploying** needs Playwright locally
(`npm i -D playwright`) for the browser ones; the 339 API assertions only need
`bash` and `curl` against a running server.

---

## If the build fails with `ENOENT ... /opt/render/project/src/package.json`

Render ran `npm install` at the repository root, where there is no
`package.json`. That is the **Root Directory** setting, not a problem with the
code: it has to point at the folder containing `backend/package.json`.

Check what Render says in the log line `Using Node.js version ... via <path>` —
that path is relative to your repository root and tells you exactly where the
backend actually sits. Set **Settings → Root Directory** to the folder part of
it (`backend`, or `mfintech-erp/backend` if you pushed the parent folder as the
repo), save, and redeploy.

If the path has an extra folder level in it, the repository was created one
directory too high. It will work either way once Root Directory matches, but the
tidier fix is to re-push from the folder that holds `backend/` and `frontend/`
so `render.yaml` at the root applies as written.
