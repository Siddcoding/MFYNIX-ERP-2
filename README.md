# Mfynix ERP — Smarter ERP. Faster Growth.

*(MFinTech Smart ERP — multi-location control flow)*

A web-based, SQL-backed replacement for the Excel-VBA architecture described in the
requirement document. Same multi-branch data model (Company → Branch → Users →
Sales/Purchase/Stock, every transaction tagged with CompanyID + BranchID), but the
client is a responsive web app instead of a `.xlsm` file, so it works reliably on
any device — phone, tablet, laptop, any OS — through a browser, with no install.

## What's built (all 12 modules of the client's roadmap)

- **Login & security** — JWT auth, bcrypt password hashing, rate-limited login,
  role-based access (Super Admin, Company Admin, Branch Manager, Accountant,
  Cashier, Sales Executive, Store Manager, Auditor, Read Only), full audit log,
  and a working forgot-password flow (token-based reset, 15-minute expiry,
  single-use tokens — see note below on email delivery).
- **Company & Branch management** — multi-branch setup, branch-wise GSTIN/state,
  Head Office role has all-branch visibility; branch-level users are locked to
  their own branch automatically (server-side, not just hidden in the UI).
- **Masters** — Customer, Supplier, Item (with HSN, GST rate, reorder level).
- **Sales & Purchase** — invoices with branch-wise numbering (e.g. `HYD-0001`,
  `BBSR-0001`), auto GST calculation, posts straight to the stock ledger.
- **Inventory** — running stock ledger per branch/item, inter-branch stock
  transfer, low-stock alerts against reorder level.
- **Dashboard** — Today's/Monthly Sales, Purchase, Stock Value, GST payable
  (net of input credit), branch performance comparison, top customers, recent
  transactions — switches between branch view and Head Office consolidated
  view depending on who's logged in.
- **UI polish** — glassmorphism styling (frosted-glass cards, animated
  gradients), toast notifications instead of browser `alert()` popups, loading
  spinners on every action, smooth page/card transitions.

**Note on forgot-password:** this now goes by email. The reset code is sent
through the messaging service (SMTP via nodemailer) and is **never** returned in
the API response or shown on screen. Configure an email provider under
**Admin → Messaging** (host, port, from-address, credentials); until one is
configured the attempt is still recorded in the delivery log as *NotSent* so it
is visible rather than silent. SMS and WhatsApp use the same service through a
generic HTTP gateway.

> **Release status:** this build implements **R0 (Stabilise)** and **R1 (Core
> integrity)** in full, and the **core of R2 (Document flow & approvals)**.
> R3 (statutory e-invoice/e-way-bill/GSTR-2B integrations) and R4
> (POS/hospitality, LLM assistant, mobile, vendor portal) are **not yet built**
> — see `RELEASES.md` for the requirement-by-requirement coverage matrix and
> exactly what remains.

### Accounts — double-entry bookkeeping

- Standard Chart of Accounts seeded per company (Cash, Bank, Debtors, Creditors,
  GST Input/Output, PF/ESI/TDS/Salaries Payable, Sales, Purchases, expense heads).
- **Sales, Purchase and Payroll auto-post real journal entries in the same
  database transaction as the document itself** — an invoice can't exist without
  its accounting effect, and an unbalanced entry aborts the whole thing.
- Manual Journal Entry (server rejects anything that doesn't balance), Ledger with
  running balance, Trial Balance, Profit & Loss, Balance Sheet — each available
  branch-scoped or consolidated.

### GST Filing

- **GSTR-1** — B2B invoice-level detail (Table 4) and B2C consolidated summary
  (Table 7), split by place of supply and rate.
- **GSTR-3B** — outward/inward summary with the **statutory input tax credit
  set-off order (Section 49/49A)**: IGST credit is exhausted first, against IGST,
  then CGST, then SGST; CGST and SGST credit cover their own head with any balance
  going to IGST, and never each other. Offsetting each head in isolation would
  overstate what's payable for any company that buys inter-state and sells
  intra-state — which is exactly the multi-branch case this system is for.
- CGST/SGST vs IGST is decided per invoice by comparing the **branch's** state
  with the counterparty's state (place-of-supply rule), not assumed.
- **HSN summary** (Table 12), **branch-wise GST position** for head office, and a
  **filing log** where each generated return is recorded and stamped with its ARN
  once filed on the portal. A return marked Filed can't be silently regenerated.
- Exports: GSTR-1 as **CSV** (the reconciliation format accountants use) and as
  **JSON in the portal's offline-utility shape** (`b2b` grouped by `ctin`, `fp`
  as MMYYYY).
- Return data is always recomputed live from the invoices, never cached, so it
  cannot drift from the books.

### Payroll

- Employees per branch with branch-wise codes (`HYD-E001`), salary structure
  (Basic / HRA / Allowances), PAN, bank details, PF/ESI applicability, monthly TDS.
- Monthly **attendance** grid drives pro-rata pay; overtime is paid at the
  employee's hourly basic rate (monthly basic ÷ 208 hours).
- Statutory deductions computed to Indian defaults, all rates in one place at the
  top of `routes/payroll.js`: **PF** 12% of Basic capped at a ₹15,000 wage
  ceiling, **ESI** 0.75% of gross and only where gross ≤ ₹21,000, **TDS** per
  employee.
- **Payroll run** previews every payslip first, then posts payslips *and* the
  accounting entry together:
  `Dr Salaries & Wages` / `Cr PF Payable + ESI Payable + TDS Payable + Salaries
  Payable`. Re-running the same branch and month is refused, and attendance for
  a posted month locks — so salaries can never be double-posted.
- "Mark paid" clears Salaries Payable against Bank. Statutory register shows what
  has to be deposited with EPFO/ESIC/Income Tax, branch by branch.

### CRM

- Lead pipeline (New → Contacted → Qualified → Proposal → Won/Lost) with a funnel
  view and a lead board, per branch or consolidated.
- Every stage change and activity (Call/Email/Meeting/Note) is recorded on the
  lead's timeline; logging an activity refreshes the follow-up date, so "stale
  lead" reporting reflects real contact rather than edits.
- **Convert a won lead into a Customer master in one click**, so the next invoice
  can be raised against it immediately. Conversion is idempotent.
- Follow-ups due/overdue list, and branch-wise conversion performance. Conversion
  rate is won ÷ closed, not won ÷ total — leads still in the pipeline haven't had
  their chance yet.

### MFinAI — the assistant

**What it is, plainly:** a deterministic rule-based engine, *not* a large language
model. It parses a question against a fixed set of intents, extracts the period,
branch and limit it mentions, runs real SQL against your own data, and returns the
answer together with the numbers behind it. Nothing is invented, nothing leaves
the server, and it needs no API key or internet connection. If a question doesn't
match an intent it says so and lists what it can answer, rather than guessing.

- Understands questions about sales, purchases, branch comparison, top customers,
  best-selling items, stock levels and value, GST position, profit, outstanding
  receivables/payables, payroll cost and the CRM pipeline.
- Handles periods in natural language: "today", "last month", "this year",
  "last 90 days", "March 2026".
- A branch-locked user's scope always wins over a branch named in the question —
  asking about another branch cannot widen their access.
- **Automated insights**, all computed rather than guessed: month-on-month sales
  movement, revenue concentration in one branch, branches with no activity, items
  at or below reorder level, **negative stock** (a real data-integrity fault),
  GST accruing this month, overdue CRM follow-ups, unfiled returns, and a
  trial-balance integrity check.

If you later want a genuine LLM behind this, the shape is already right: swap
`matchIntent` in `routes/ai.js` for a model call returning `{intent, params}` and
every handler below it stays unchanged.

### Day-to-day operations

- **Payment / Receipt / Contra vouchers** — the entries a cashier makes every
  day, without hand-writing journal lines. Receipt debits Cash or Bank and
  credits Debtors by default; Payment does the reverse against Creditors (or
  any expense head you pick); Contra moves money between cash and bank. Each
  one is still an ordinary balanced journal entry underneath, so it flows
  straight into the ledger, trial balance and P&L. Trying to move cash to bank
  through a Receipt is redirected to a Contra rather than silently accepted.
- **Opening stock & stock adjustments** — load opening balances at go-live,
  record damage and loss, and correct the books after a physical count. For a
  count you enter the quantity you actually counted and the system works out
  the difference itself. A reason is mandatory on every adjustment, decreases
  can't push a branch below zero, and a second "Opening Stock" on an item that
  already has movement is refused.
- **Item stock ledger** — every movement behind a stock figure, with a running
  balance, so any number on the stock screen can be traced.
- **Printable tax invoice** — a proper black-on-white GST invoice for both
  sales and purchase, with seller and buyer details, HSN, CGST/SGST vs IGST
  decided by the same place-of-supply rule the GST return uses, amount in
  words in Indian numbering, and a signature block. Prints or saves as PDF
  from the browser. A cancelled document prints with a CANCELLED stamp.
- **Cancel with full reversal** — nothing is ever deleted. Cancelling a sales
  invoice or purchase bill marks it Cancelled, writes a mirror-image stock
  movement, and posts a reversing journal entry, so the audit trail and the
  invoice number both survive. Two guards worth knowing about: cancellation is
  refused once the GST return for that period carries an ARN (the remedy then
  is a credit note in the current period), and a purchase can't be cancelled
  if the goods have already been sold or transferred out, since that would
  create an impossible stock position.
- **Passwords** — change your own from the Password button in the top bar
  (current password required), or, for someone locked out, a Super Admin or
  Company Admin can set a temporary one from the Users screen.

**Accounting note on stock adjustments.** They deliberately write to the stock
ledger only, with no journal entry. The system expenses purchases directly
(`Dr Purchases`), which is periodic-inventory accounting — there is no
perpetual Inventory asset balance for an adjustment to move, and posting one
would leave the books inconsistent with how purchases are already treated.
Closing stock is brought into the P&L at period end by the accountant, the
same way it works in Tally under periodic inventory.

### Data-integrity controls

These are the guards that stop the books quietly drifting away from reality.
Each is enforced **inside the database transaction**, so a rejected document
leaves no partial rows behind.

- **Stock can't go negative.** A sale or an inter-branch transfer is refused
  when the branch doesn't have the goods, and the message says exactly how much
  is on hand. The same item split across two invoice lines is summed before the
  check, so 2 x 60 units can't slip past a stock of 100.
- **Credit limits are enforced.** A sale that would take a customer past the
  limit on their master record is refused, with the resulting balance spelled
  out. A limit of zero means "no limit", which is how the master defaults.
- **Both are switchable per company**, from *Audit & Settings → Policy
  Settings*, and only by a Super Admin. Defaults are the safe option. A
  business that genuinely invoices before goods arrive can allow negative
  stock; the trade-off is stated on the screen. Every change is audited.

### Audit log

Every login (successful and failed), invoice, cancellation, stock adjustment,
payroll run, password change and policy change has been recorded since day one
— and is now readable at *Audit & Settings*, with filters by action, user and
date range, plus full-text search over the details. Visible to Super Admin,
Company Admin and Auditor; a branch-locked administrator sees only their own
branch. Nothing in the log can be edited or deleted from the application.

### Pagination and search

Every list endpoint returns `{ rows, page, pageSize, total, totalPages }` and
the UI has a pager plus a filter bar (search, date range, status). This
replaced hardcoded `LIMIT 200` clauses that silently made older records
unreachable after a few months of use — the worst kind of limit, because
nothing tells you it happened. `pageSize` is capped server-side at 200.

### Company, financial years and document numbering (Mfynix stack §3, §22)

- **Company Master** — name, GSTIN, PAN, CIN, state, country, contact details,
  website, logo, bank details, invoice prefix and the declaration printed on
  invoices. Edited under *Settings → Company*.
- **Financial years** — the Indian 1 April–31 March year, created automatically
  on first boot. Years cannot overlap, exactly one is active, and a **closed
  year rejects new sales and purchase postings** dated inside it. Closing is
  reversible, because accountants close, find something, and reopen.
- **Central document numbering engine.** One counter table issues every number
  in the format `BRANCH/PREFIX-YEAR-NNNNNN`, e.g. `HYD/INV-2026-27-000001`.
  Each branch keeps its own unbroken series and the counter can only ever move
  forward.

  This replaced `SELECT COUNT(*) + 1`, which was genuinely unsafe: two users
  saving at the same instant both read the same count and would be handed the
  same invoice number. The test suite proves the fix by firing **twelve
  invoices concurrently and asserting twelve distinct numbers** come back.

  Changing the company's invoice prefix applies to series that have not issued
  a number yet. A series already in use keeps its prefix and the app says so —
  renaming mid-year would leave a visible break in a sequence GST expects to be
  continuous. Rename those deliberately on the Numbering tab.

### Outstanding, allocation and ageing (Mfynix stack §14)

- **Receipts and payments are allocated against specific invoices**, so an
  invoice leaves Outstanding only when it is actually settled. Over-allocating
  is refused, including two lines that would double-spend the same document.
- **Ageing** in the 0–30 / 31–60 / 61–90 / 91–180 / 180+ buckets the document
  specifies, per customer and per supplier, with a "fill oldest first" helper
  that mirrors how collections are really applied.
- **Credit days** on the party master drive the due date and the overdue flag.
- This also fixed a limitation in the credit-limit check. It used to compare
  against total billed, so a customer who had paid stayed blocked. It now uses
  real outstanding, and **collecting a payment frees the limit up again**.

### Importing from Excel or CSV

Nearly all of this data already exists in somebody's spreadsheet, so **Masters →
Customers / Suppliers / Items** and **Branches & Users** each have an
*Import from Excel / CSV* button. Drop an `.xlsx` or `.csv` on the dialog, or
click to pick one; there is a blank template to download if you'd rather start
from the right shape.

Three things about how it behaves are worth knowing before you upload anything:

- **Headings are matched loosely.** "Customer Name", `customer_name`, `NAME` and
  even "Party" all resolve to the same field, and a column the importer doesn't
  recognise is ignored rather than treated as an error. Numbers survive the way
  people actually type them — `2,50,000`, `₹100000` and `18%` all parse.
- **A duplicate is skipped, never overwritten.** A customer whose name or GSTIN
  already exists, an item whose name or barcode already exists, a username
  already taken — each is left exactly as it is and reported. That makes
  re-uploading a corrected sheet safe: it tells you what it did instead of
  quietly replacing work someone did by hand.
- **A bad row doesn't sink the file.** Each row is validated on its own and the
  result is shown line by line — imported, skipped, or rejected with the reason
  — worst first, because the rows needing attention shouldn't be buried under
  two hundred successes. The valid rows all land in a single transaction, so an
  import either applies completely or not at all.

Importing users has two extras: **Role** must match an existing role (the error
lists the valid ones) and **Branch** takes either the branch name or its code,
with blank meaning a head-office user. Leave **Password** blank and one is
generated and shown to you once, in the result table — copy it before closing,
because it is never stored in plain text or logged.

Masters import is open to Super Admin, Company Admin, Accountant, Branch Manager
and Store Manager. Creating logins in bulk is Super Admin and Company Admin only.

### Branding

The product ships as **Mfynix**: its mark is the default logo on the login
screen, the splash, the sidebar, the browser tab and printed documents, so a
fresh install looks like a product rather than a template.

**A company replaces it with their own.** *Settings → Company → Logo*, upload a
PNG, JPEG or SVG, and it takes over everywhere the Mfynix mark was — including
the letterhead on every invoice, bill and note. That last part is the point: a
customer sending an invoice to *their* customer should be sending their own
letterhead, not their software vendor's. Remove the logo and it falls back to
Mfynix. The logo is cached per browser session and cleared on logout, so a
shared machine never shows the previous company's branding.

### The item master

The full specification, grouped on the form the way the information is actually
gathered rather than as one wall of thirty inputs:

| Group | Fields |
|---|---|
| Identity | Item code, name, category, material type, HSN/SAC, tax %, barcode/SKU, custom attributes |
| Measurement | UOM, alternate UOM and its conversion factor, dimensions/weight |
| Sourcing | Preferred vendor (picked from your supplier list), lead time in days, reorder level |
| Storage & traceability | Warehouse, bin/rack, batch tracking, serial tracking, shelf life |
| Costing & pricing | Costing method (FIFO / LIFO / Weighted Average / Standard), purchase price, standard cost, selling price/MRP, GL mapping |
| Production | BOM link, yield %, wastage %, remarks |

Batch and serial tracking are Yes/No selects rather than checkboxes, because on
a master an unticked box and a deliberate "No" look identical and mean
different things. Every field is understood by the Excel/CSV importer too, with
the same loose header matching — "Bin/Rack", "Expiry/Shelf Life" and "Selling
Price/MRP" all land where they should.

### Statutory fields on every document

Sales invoices, purchase bills, credit notes and debit notes now carry the full
set a GST document has to show. They are one shared implementation, so the four
document types cannot drift apart.

**On the header** — reference no. and date, order no. and date, IRN, e-way bill
no., transporter, consignment note no. and date, reverse charge, payment
ledger, party type, and the party's phone, PAN, GSTIN, state and state code.
On the form these sit behind a collapsed *Reference, transport & e-invoice
details* section that shows a count of how many are filled: the everyday
invoice needs a customer, a date and a line, and burying those behind twelve
optional boxes would make the common case slower to serve.

**On each line** — item code, description, HSN, unit, quantity, unit price,
batch no., manufacture and expiry dates, discount % and amount, nett (taxable)
amount, CGST %/amount, SGST %/amount, IGST %/amount, and the gross.

Three decisions worth knowing about, because they are what make the numbers
trustworthy rather than merely present:

- **The party and item details are snapshot, not joined.** An invoice is a
  record of what was true the day it was raised. Change a customer's GSTIN or
  rename an item next year and last year's invoices still print exactly as they
  were filed — there is a test asserting precisely that.
- **The tax heads are stored, not recomputed on read.** The printed invoice and
  the filed return therefore cannot disagree, however the state masters are
  edited afterwards.
- **The header totals are summed from the lines.** A header that disagrees with
  the sum of what it contains is the classic invoice bug; summing is the only
  way to be certain it cannot happen.

**The CGST/SGST vs IGST split** is decided by comparing the *branch's* state
with the party's, by GST state code rather than by name — so "Odisha" and
"Orissa" are one state, not an accidental inter-state supply. Intra-state
splits half CGST and half SGST; inter-state is all IGST. It is the same
function the GST returns use.

### Signing in — Admin or Customer

The login screen now asks *who is signing in* before it asks for a password,
because two completely different audiences arrive at the same URL:

- **Admin / Staff** — username and password, straight into the full ERP.
- **Customer** — email and password, into a read-only self-service portal.

Whichever pane you used last is remembered on that device, and
`index.html?mode=customer` skips the chooser entirely, so a company can hand
its customers a bookmark that lands them on their own form.

### Customer self-service portal

A customer is **not** an ERP user. They have no role, no branch, and no row in
`Users`; their login lives on the customer master and mints a different kind of
token, which the ERP's own middleware refuses outright (and vice versa). Every
query in `routes/portal.js` is hard-filtered by the CustomerID in that token —
there is no parameter anywhere in the file that names a different customer,
which is the property that makes the isolation checkable rather than merely
intended.

What a customer can see:

- **Overview** — outstanding balance, overdue amount, total billed and paid,
  credit notes, ageing by bucket, and credit-limit usage as a dial.
- **Invoices** — every invoice raised against them, with amount, paid, still
  due and a status; open one to see its line items and the payments received.
- **Outstanding** — each open invoice with its due date, age and bucket.
- **Statement of account** — a running-balance ledger of invoices, receipts and
  credit notes for any date range, downloadable as CSV.
- **My details** — what the company holds about them, plus how to get it fixed.

Everything is read-only apart from their own password. A portal login can never
create, edit, cancel or allocate anything.

**Granting access:** *Masters → Customers → Portal login*. Access is off by
default for every customer, needs an email address (that is the login) and a
password of at least eight characters, and is restricted to Super Admin,
Company Admin, Accountant and Branch Manager. There is no mail provider wired
up, so the account manager passes the password on and the customer changes it
themselves.

**Access runs for a fixed term.** The dialog offers **1 month, 3 months,
6 months, 1 year** — or *No expiry* for a key account that genuinely shouldn't
lapse — and each option shows the actual date it would run to, so "6 months" can
be sanity-checked at a glance. A first grant with no term chosen defaults to a
year rather than to forever: access nobody picked a length for should still end
eventually.

What that gives you:

- **It lapses by itself.** Nobody has to remember to revoke a login when a
  relationship ends, which is the failure mode of every tick-to-enable
  permission ever built.
- **Expiry is checked on every request, not just at sign-in.** A 30-day
  remember-me token stops working the moment the term runs out, otherwise the
  date would be decorative. The last day is inclusive — access "until 5 March"
  works all of 5 March.
- **Renewing early costs nothing.** A new term is added on top of the days still
  remaining, not from today. Renewing an access that has already lapsed starts
  the term from today, since there is nothing left to extend.
- **Everyone can see where they stand.** The customer list shows *Until 5 Mar
  2027*, *12 days left*, or *Expired 3 Jan* rather than a bare "Enabled"; the
  customer sees a banner in their portal for the last fortnight; and a lapsed
  sign-in is told plainly that the term expired and to ask for a renewal, rather
  than being left to think they mistyped their password.

Switching access off by hand still works and still bites on the customer's very
next request.

### Appearance and splash

- **Twelve themes** — Mfynix Blue (the default, taken from the logo), Ember,
  Deep Teal, Midnight, Royal Plum, Daylight, Carbon, Forest, Rosewood, Slate,
  Sandstone (a warm light theme for paper-heavy work) and High Contrast (pure
  black with no translucency or blur, for a shop floor or a badly lit
  warehouse office). Chosen under *Settings → Appearance*,
  applied instantly and remembered per browser. The theme is written to
  `<html>` before first paint, so there is no colour flash on load. Every
  theme's body, heading, muted and accent colours were checked against its own
  background: the lowest ratio across all twelve is 4.6:1, above the WCAG AA
  threshold.
- **Background depth** — behind the drifting colour blobs there is now a slowly
  moving perspective grid and a fine noise wash, both pure CSS, both at very
  low opacity so they read as texture rather than competing with the data.
- **Motion, throughout** — staggered entrance for table rows and sidebar links,
  a sliding indicator that follows the active nav item, a click ripple on every
  button, modals that spring in over a blurring backdrop, skeleton loaders
  while a panel's data is in flight, a short fade on page navigation, and
  animated counters on the KPIs. All of it is switched off in one place for
  anyone whose system asks for reduced motion.
- **Splash screen** on every page load, with the product name and the line
  *"One system. Every branch. Complete control."* It lifts as soon as the first
  screen is painted, and has a hard timeout so a failed request can never trap
  someone behind it.

### Credit and debit notes

The lawful remedy once a GST return is filed, and how returned goods are handled.
- A **credit note** reverses part of a sales invoice; a **debit note** does the
  same against a purchase. Each is a document in its own right with its own
  number from the `CN`/`DN` series.
- Picking the original invoice prefills the party and the lines. You **cannot
  credit more than was billed** — repeated notes can't quietly hand a customer
  credit that was never earned.
- Goods come back into stock automatically, unless you untick it for a pure
  price allowance where nothing physically moved.
- The note posts the exact mirror of the original entry and settles that much
  of the invoice, so Outstanding updates immediately.

### Receipt and payment in one step

Taking the money and clearing the invoices is one real-world event, so it is now
one save. The journal and the allocations post inside a single transaction: if
the allocation is invalid, the money is not posted either, and the books can
never show a receipt that settles nothing. The amount and the allocated total
must agree, and neither can exceed what is actually open.

### Year-end close with carry-forward

Closing a year properly now does the whole job:
1. posts a closing entry that zeroes every income and expense account into
   Retained Earnings, so the new year's P&L starts at nil;
2. writes the balance-sheet balances into the next year as **opening balances**;
3. locks the year and makes the next one active.

Previously "close" only locked the year, so retained earnings were recomputed on
the fly forever and no year ever really ended.

### Banking and reconciliation (Mfynix §9)

- **Bank accounts** each point at a Chart of Accounts head, which is where a
  matched line posts.
- **Statement import from any bank.** Rather than hard-coding one CSV layout,
  the importer reads your header row, guesses the column mapping, shows you a
  preview, and lets you correct it — so a new bank needs no code change.
  Re-importing the same file is safe: rows already present are skipped, and
  anything unreadable is reported rather than silently dropped.
- **Suggested matches** are deliberately conservative: same account, same side,
  same amount, within a week. It suggests, it never auto-matches — an ERP that
  silently decides which invoice a payment belongs to causes worse problems
  than it solves.
- **Post from the statement** for bank charges, interest and direct debits,
  which only ever appear there.
- **Reconciliation** shows what the bank says against what the books say, and
  exactly which lines explain the gap.

### Reports and CSV export

Day Book, Cash Flow, Sales Register, Purchase Register, Item-wise Sales, Stock
Valuation, Fast/Slow/**Dead** Stock, and Customer/Supplier Ledger. Every report
returns the same envelope, so one exporter serves all of them — and a new report
is a query rather than a query plus a screen plus an exporter.

### Multi-company

A new company is created complete: head-office branch, chart of accounts,
financial year, settings and an administrator who can sign in. Each company's
data is entirely separate — a test asserts a new company can see none of
another's invoices, customers or branches.

### Backup

The whole system is a single SQLite file, so a backup is one download, taken as
a consistent snapshot even while people are working (`VACUUM INTO`, not a file
copy, which is unsafe on a live WAL database). Restore instructions are on the
Backup tab in Settings.

## Role-based access, enforced server-side

| Module | Who can open it | Who can only read |
|---|---|---|
| Accounts, GST Filing | Super Admin, Company Admin, Accountant, Auditor | Auditor |
| Payroll | above + Branch Manager | Auditor |
| CRM | Super Admin, Company Admin, Branch Manager, Sales Executive | Auditor |
| Sales, Purchase, Inventory, Masters | all roles | Read Only |

Navigation links are hidden for roles without access, but the **server is the real
gate** — every route re-checks the role, so a hidden link can't be worked around
by typing the URL.

## Testing

Two suites are included, both run against a real running server with real data:

- `test-modules.sh`, `test-new-features.sh`, `test-tier1.sh`, `test-mfynix.sh`
  `test-final.sh`, `test-portal.sh`, `test-import.sh` and `test-fields.sh` —
  **385 API assertions**, run against a live server with real data. They cover GST
  computation and the ITC set-off order, payslip math to the paisa, payroll
  locking, CRM stage rules and conversion, every MFinAI intent, voucher
  postings checked in the actual ledger, stock-adjustment guards, cancellation
  reversing both stock and accounting, negative-stock and credit-limit
  enforcement (including the same item split across two lines), pagination
  reaching every record with no overlap, the audit log and its role gating, and
  the production JWT-secret check, financial-year closing, concurrent document
  numbering, outstanding/ageing/allocation arithmetic, credit-note stock and
  accounting effects, one-step settlement rolling back cleanly when rejected,
  bank import de-duplication, a year-end close that moves the right profit
  into Retained Earnings and carries a balanced set of openings forward, and
  the customer portal — including that a customer token is refused by the ERP,
  a staff token is refused by the portal, another customer's invoice returns
  "not found", the portal's outstanding figure equals what the ERP shows for
  that same customer, the statement's running balance reconciles with its own
  totals, and revoking access kills a live token immediately. The importer is
  tested against a real `.xlsx` workbook as well as CSV: loose header matching,
  Indian number formatting, duplicates skipped without altering the original,
  bad rows rejected individually while the good rows still land, and a
  generated password verified against the stored bcrypt hash. Timed portal
  access is tested against Python's own calendar arithmetic for each of the four
  terms, including that an expired term kills a token that was minted while it
  was still valid, that the last day is inclusive, and that renewing early
  extends rather than resets. The document fields are checked by arithmetic:
  an intra-state sale splitting exactly half and half, an inter-state one
  landing wholly on IGST, a 10% discount producing the right taxable value, the
  header equalling the sum of its lines, and a customer's GSTIN staying frozen
  on an invoice after the master is edited.
- `browser-test.js`, `browser-test-new.js`, `browser-test-tier1.js`,
  `browser-test-mfynix.js`, `browser-test-final.js`, `browser-test-portal.js`,
  `browser-test-import.js` and `browser-test-fields.js` — drive
  the real UI in Chromium: log in, visit every page, add an employee, post
  payroll, move a lead, ask MFinAI a question, post a voucher, adjust stock,
  open a printed invoice, attempt to oversell and confirm the user is told why,
  page through the audit log, flip a policy setting and check it persists, and
  confirm no page scrolls sideways on a phone-sized viewport.

```bash
bash run-tests.sh             # API suites, on a throwaway database
node browser-test.js          # UI suite      (needs: npm install playwright)
node browser-test-new.js      # UI suite for the vouchers/print/cancel work
node browser-test-tier1.js    # UI suite for the audit log and policy settings
node browser-test-mfynix.js   # UI suite for Settings, themes and Outstanding
node browser-test-final.js    # UI suite for notes, banking, reports and backup
```

Note: the login endpoint is rate-limited to 10 attempts per 15 minutes, so
running the suites repeatedly in quick succession can trip it. `run-tests.sh`
restarts the server, which clears the counter.

## Tech stack (why this instead of VBA)

| Layer | Technology | Why |
|---|---|---|
| Frontend | Plain HTML/CSS/JS, responsive | No build step, works in any browser on any device — phone, tablet, desktop |
| Backend | Node.js + Express | Same stack as the client's existing GST OneClick app |
| Database | SQLite (`better-sqlite3`) | Zero-config, file-based, no server to install; swap to Postgres/MySQL later just by changing `db/index.js` and `schema.sql` — the SQL is close to standard already |
| Auth | JWT + bcrypt | Stateless, works the same on every device |
| Spreadsheets | SheetJS (`xlsx`) | Reads `.xlsx` and `.csv` with the same quoting and date rules Excel uses, so a file that opens in Excel imports here |

SQLite easily handles dozens of branches and normal ERP transaction volume for
a single company. If MFinTech wants this to scale to genuinely large
concurrent multi-tenant load later, the schema ports to PostgreSQL/MySQL with
minor syntax changes (mainly `AUTOINCREMENT` → `SERIAL`/`AUTO_INCREMENT` and
`datetime('now')` → `NOW()`).

## Running it in VS Code

The project ships with a `.vscode` folder, so there is nothing to configure.

1. **Open the folder** — File → Open Folder → select `mfintech-erp`
   (the folder containing `backend`, `frontend` and `README.md`).
   Open the *whole* folder, not just `backend`.
2. **Install dependencies once** — Terminal → New Terminal, then:
   ```bash
   cd backend
   npm install
   ```
   (Or Terminal → Run Task → *Install dependencies*.)
3. **Press F5.** The server starts with the debugger attached and VS Code opens
   http://localhost:3000 in your browser automatically. Breakpoints anywhere in
   `backend/` will hit.

   Prefer no debugger? Terminal → Run Task → *Start ERP*, or just `npm start`
   from the `backend` folder.
4. **Log in** with `admin` / `Admin@123`.

To stop it: the red square in the debug toolbar, or `Ctrl+C` in the terminal.

**Other tasks** (Terminal → Run Task): *Reset database* wipes all data and
re-seeds the demo company on the next start; *Run API tests* runs the full
suite against a throwaway database.

If port 3000 is taken, pick the **Run on port 3001** configuration from the
dropdown at the top of the Run and Debug panel.

### Things that catch people out

- **Don't use Live Server** (or any "open in browser" extension) on the HTML
  files. Those serve the frontend on a different port with no backend behind
  it, so every screen loads but nothing works. The Express server already
  serves the frontend — always reach the app through `http://localhost:3000`.
- **Don't double-click `frontend/index.html`.** Same reason: a `file://` page
  has no API to talk to.
- **Node 18 or newer is required.** Check with `node -v`; the server tells you
  clearly on startup if your version is too old.

## Running it from the command line



```bash
cd backend
npm install        # already done if you're using the provided node_modules
npm start           # http://localhost:3000
```

Open `http://localhost:3000` in a browser — the backend serves the frontend
directly, so there's no separate frontend server or CORS setup needed.

**Demo login:** username `admin`, password `Admin@123` (seeded automatically
on first run — a Head Office Super Admin with all-branch access). Change it
immediately in a real deployment using the **Password** button in the top bar,
which is available on every screen once you're signed in.

## Troubleshooting

**"It's not working" almost always means one of these:**

- **You opened `frontend/index.html` directly by double-clicking it** (a
  `file://` URL). That won't work — there's no backend behind it that way,
  so login and every API call will fail silently. Run `npm start` from
  `backend/` and open `http://localhost:3000` in the browser instead.
- **Node isn't installed, or is an old version.** This app needs Node 18+.
  Run `node -v` to check; if it's missing or older, install the current LTS
  from https://nodejs.org. The app now checks this on startup and tells you
  clearly if your version is too old, instead of crashing with a stack trace.
- **`npm install` failed on `better-sqlite3`.** This package has a native
  binary; on most systems `npm install` downloads a prebuilt one automatically.
  If it fails, delete `node_modules` and `package-lock.json` and reinstall:
  ```bash
  cd backend
  rm -rf node_modules package-lock.json
  npm install
  ```
  If it still fails, you likely need build tools installed (Python 3 + a C++
  compiler) — on Windows, install "Visual Studio Build Tools" (Desktop C++
  workload); on Mac, run `xcode-select --install`; on Linux,
  `sudo apt install build-essential python3`.
- **Port 3000 is already in use.** The server now says so explicitly instead
  of failing silently. To use a different port, copy `.env.example` to `.env`
  and change `PORT=3000` to something else — this works the same way on
  Windows, Mac, and Linux (an inline `PORT=3001 npm start` only works in
  bash/zsh, not Windows cmd.exe, so `.env` is the reliable option).
- **Blank page or broken styling after opening the right URL.** Hard-refresh
  the browser (Ctrl/Cmd+Shift+R) — you may be looking at a cached copy of an
  older version of the frontend files.

If you hit something not covered here, the most useful thing to send me is
the exact text from the terminal after `npm start`, or whatever shows in the
browser's console (F12 → Console tab).

## Security notes before you deploy

**`JWT_SECRET` is mandatory in production.** The JWT secret is what stops
anyone minting their own login token. Earlier versions fell back to a fixed
string committed to this repo, which meant a deployment that forgot to set the
variable could be signed into as any user by anyone who had read the code. The
server now **refuses to start** when `NODE_ENV=production` and `JWT_SECRET` is
missing, shorter than 24 characters, or still a placeholder. Generate one with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Development still gets a throwaway secret automatically, with a warning on
startup.

Also worth doing before go-live: put the app behind HTTPS (Render does this for
you), change the seeded `admin` password, and set up a scheduled copy of
`backend/db/mfintech.db` — it is a single file, so a nightly copy is a complete
backup.

## Deploying

Full instructions, per platform, are in **[DEPLOY.md](DEPLOY.md)**. The short
version, wherever you host it:

- **Persistent disk, and `DB_PATH` pointing into it.** Everything lives in one
  SQLite file, and most platforms replace the application directory on every
  deploy — a database inside the code folder is destroyed each time you push.
- **`JWT_SECRET`** set to a long random string. The server refuses to boot in
  production without one.
- **`NODE_ENV=production`.**
- **One instance, not several.** Two would each open their own copy of the file
  and the data would silently fork in half. Scale up, not out.

The repo ships the config for the common hosts: `render.yaml` (Blueprint deploy,
disk included), a root `Dockerfile` and `docker-compose.yml` for Railway, Koyeb,
a VPS or the client's own server, `fly.toml` for Fly.io, and a `Procfile` for
buildpack hosts.

One warning worth repeating: **Render's free plan cannot mount a disk**, so a
free deployment resets to an empty demo company on every restart. It is fine for
showing the client the app and unusable for real data.

## Notes on "reliable across devices"

- Single origin (frontend served by the same Express app that serves the
  API) — no cross-origin issues on mobile browsers, corporate networks, etc.
- Fully responsive layout — sidebar collapses to a hamburger menu under
  ~860px, tables scroll horizontally instead of breaking the layout.
- All state lives in the SQL database, not in the browser — no localStorage
  data that could get lost switching devices, only the login token.
- WAL mode is enabled on SQLite so multiple branches writing invoices at the
  same time don't lock each other out.

## Mapping to the Mfynix stack document

| Mfynix layer | State |
|---|---|
| 1. Company & Organisation | Built — multi-company, branches, financial years with year-end close |
| 2. Master Management | Built — customer, supplier, item, credit days, opening balances |
| 3. Sales | Built — invoice, GST, stock, accounting, PDF, credit notes. No quotation/SO/challan chain |
| 4. Purchase | Built — bill, GST input, stock, accounting, debit notes. No PO/GRN chain |
| 5. Inventory | Built — ledger, transfers, adjustments, opening stock, low stock |
| 6. Accounting | Built — double entry, vouchers with allocation, notes, ledger, TB, P&L, balance sheet, year-end close |
| 7. Banking | Built — accounts, CSV statement import, matching, reconciliation |
| 8. GST & Compliance | Built except e-Invoice / e-Way Bill / direct filing (need GSP credentials) |
| 9. Reporting & Dashboard | Built — day book, cash flow, registers, valuation, dead stock, party ledger, all with CSV export |
| 10. MFinAI | Built as a rule-based engine, not an LLM. No voice |
| 11. Communication & Automation | **Not built** — needs a WhatsApp Business account and an email/SMS provider |
| 12. Administration & Security | Built — roles, audit trail, policies, numbering engine |

The document's central design principle — *Master → Transaction → Transaction
Engine → Accounting + Inventory + Tax → Reporting → AI* — is how the code is
already arranged: one save writes the document, its stock movement, its journal
entry and its audit record inside a single database transaction.

## What's still open

Everything buildable without credentials is done. What remains needs something
only MFinTech can supply, or is a deliberate scope choice:

**Blocked on credentials**

1. **e-Invoice (IRN) and e-Way Bill** — need live NIC/GSP API credentials from
   MFinTech's own GSP account. The GSTR-1 data layer already produces the
   invoice detail those APIs consume, so this is wiring, not redesign.
2. **Direct GST portal filing** — same dependency. Today you export the JSON or
   CSV, upload it, and record the ARN back in the filing log.
3. **WhatsApp / email / SMS engine** (Mfynix §19) — needs a WhatsApp Business
   account and an email provider. Password-reset tokens and payslips already
   generate correctly; they just aren't sent. Wire SendGrid or AWS SES in
   `routes/auth.js`.

**Deliberate scope choices**

4. **Online payment from the customer portal** — the portal shows what is due
   but cannot take money. Adding a Razorpay or PayU checkout would need a
   merchant account, and the receipt it produces would post through the
   existing allocation path.
5. **Quotation → Sales Order → Delivery Challan**, and **Purchase Order → GRN**
   — only needed if the business quotes and dispatches before invoicing.
6. **Voice command** (Mfynix §18) — sits on top of MFinAI; speech-to-text in the
   browser plus a confirmation step before anything posts.
7. **Module-level permission matrix** — the document wants VIEW/CREATE/EDIT/
   DELETE/APPROVE/EXPORT per module. Today access is role-based, which is
   coarser but enforced consistently on every route.
8. **Batch and serial tracking, multi-UOM, customer price lists, barcode
   scanning** — inventory depth for a business that needs it.
9. **PostgreSQL migration** — worth doing before genuinely large multi-tenant
   load. The SQL is close to standard already.

**Operational, before go-live**

10. Change the seeded `admin` password, set `NODE_ENV=production` with a real
   `JWT_SECRET` (the server refuses to start without one), put the app behind
   HTTPS, and schedule a regular backup.
