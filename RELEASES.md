# Mfynix ERP — release coverage

This maps the requirement document (195 requirements, releases R0–R4) to what is
built. **Done** = implemented and covered by an automated test. **Partial** =
implemented but not to the full letter of the requirement. **Not yet** = not built.

Automated tests: **479 passing** (`bash run-tests.sh`), plus browser tests
(`browser-test-r0.js` XSS, `browser-test-r1.js` new sales/purchase UI).

---

## R0 — Stabilise ✅ Done

| Area | Status |
|---|---|
| Strong passwords (min 8), forced change at first sign-in and after admin reset | Done |
| Login lockout (5 failures → 15-min lock), idle-session timeout (60 min) | Done |
| Forgot-password by **email only** (code never shown on screen), single-use, 15-min | Done |
| Messaging service: email (SMTP), SMS/WhatsApp (HTTP gateway), delivery log, templates | Done |
| Verified daily backups (`VACUUM INTO` + `integrity_check` + restore test), 14-day retention | Done |
| Document numbers ≤ 16 chars, GST-legal charset, branch-wise unbroken series | Done |
| Security headers (CSP, no-framing), CORS allow-list, output escaping (XSS-safe on every page) | Done |

## R1 — Core integrity ✅ Done

| Req | Area | Status |
|---|---|---|
| MD-01 | Masters edit + deactivate with old→new audit, no delete once used | Done |
| MD-02/03 | GST state list; GSTIN checksum + state-match + PAN derivation | Done |
| MD-04/05/06 | Payment-term master; term on customer/vendor; due date stored on each invoice/bill | Done |
| MD-07/08/09 | Extended customer / vendor / material fields | Done |
| MD-10 | Opening balances | Done (carry-forward at year-end close) |
| MD-11 | Bulk upload: validation **preview** (dry-run), update mode, error rows | Done |
| OTC-02/03/04 | Invoice header fields, **draft → post**, counter-sale payment mode (auto receipt) | Done |
| OTC-05 | One-step customer receipt with allocation, **advance on account**, **TDS**, part-payment | Done |
| OTC-06 | Ageing/credit/dunning read the stored due date | Done |
| PTP-01/02 | Vendor invoice no. + date mandatory, duplicate booking refused | Done |
| PTP-03 | One-step vendor payment with advance + TDS | Done |
| INV-01/02 | **Perpetual weighted-average** valuation across sales, purchase, transfer, adjust, notes | Done |
| FIN-01 | Dated trial balance / balance sheet (as-on & between-dates); P&L by range | Done |
| FIN-02 | Vouchers carry party / ref / voucher no. | Done |
| FIN-03 | Journal & document **reversal** (never edit/delete) | Done |
| FIN-04 | **Reconciliation** of sub-ledgers (Debtors, Creditors) and stock to control accounts | Done |
| FIN-05 | Monthly **period locks** by module | Done |
| FIN-07 | Chart-of-accounts groups, edit & deactivate | Done |
| PAY-01 | Employee edit, date-of-leaving, deactivate | Done |
| RPT-01 | CSV export with header on every report | Done |
| RPT-02 | Due-date receivables/payables **cash forecast** | Done |
| PRT-01 | Customer-portal **invite by email** (one-time link, self-set password) | Done |
| ROL-02 | **Two-factor (TOTP)** for admin/finance, with recovery codes | Done |
| **R1 exit** | After a full cycle, customer/vendor balances == control accounts, stock == Inventory ledger | Done (tested) |

## R2 — Document flow, automation & approvals ◑ Core done

| Req | Area | Status |
|---|---|---|
| CRM-03 | Quotation with validity, payment term, status (Draft/Sent/Accepted/Rejected/Expired) | Done |
| CRM-04/05 | Sales order (direct or from quotation), PO ref, requested date, ship-to; line open-qty | Done |
| CRM-06 | Credit check at order confirmation → over-limit routed to approval | Done |
| CRM-07 | Stock-on-hand shown per order line | Done (display; hard reservation: Partial) |
| OTC-07/09 | Delivery from order (full/partial), goods issue, **invoice from delivery** | Done |
| OTC-12 | Document chain: a later document cannot exceed the earlier one's open quantity | Done |
| PTP-04 | Purchase order with approval limits, status lifecycle | Done |
| PTP-05/06 | Goods receipt (full/partial, batch/expiry), **draft bill from GRN** | Done |
| PTP-07 | **Three-way match** (PO ↔ GRN ↔ bill) with price/qty tolerance → mismatch held for approval | Done |
| PTP-08 | Reorder proposal (below reorder level → suggested PO on preferred vendor) | Done |
| ROL-04/05/06 | Approval workflow with amount rules, **creator ≠ approver**, approve/reject inbox | Done |
| DUN-01/02 | Dunning procedure master (levels, days, min amount, interest), per-customer + company default | Done |
| DUN-03/04/05 | Overdue from stored due date net of receipts/credits; on-demand run; proposal | Done |
| DUN-06/12 | Notices by email/SMS/WhatsApp with delivery status; dunning history | Done |
| DUN-08 | Dunning block on a customer | Done |
| DUN-13 | Collections view (overdue by level, worst accounts) | Done |
| OTC-10 | Billing run (scheduled/consolidated proposal) | Partial (invoice-from-delivery works; scheduled batch run: not yet) |
| OTC-13/CRM-02 | Auto-email invoice/quotation PDF, follow-up reminders | Not yet (messaging service is ready; PDF-by-email hook pending) |
| MD-12 | Price lists by customer group/branch with validity | Not yet |
| INV-03/04/05/06/08 | Multi-line in-transit transfers, warehouses, batch/FEFO, unit conversion, stock-count sheets | Not yet (single-line transfer and adjustments exist from R1) |
| ROL-03 | Full per-right permission matrix UI | Partial (role checks enforced server-side; matrix editor: not yet) |
| FIN-08/09/10, BNK-02/03/04 | Statement drill-down, cost centres, attachments, bank matching rules | Not yet |

**R2 front-end:** the sales/purchase daily screens carry the new fields (payment
term, counter-sale mode, freight/round-off, draft/post; vendor invoice no./date).
A **Delivery** screen (deliver from a sales order, full/partial, invoice at the
same time) and an **Invoicing** screen (all sales invoices by customer, all
purchase bills by vendor, with e-invoice and e-way-bill actions) are now in the
sidebar. The remaining R2 document-chain modules (quotations, orders, PO/GRN,
approvals inbox, dunning) are complete, tested REST APIs with screens still to
build.

## R3 — Compliance ◑ E-invoice + e-way bill done (sandbox)

| Req | Area | Status |
|---|---|---|
| EIN-01 | **E-invoice**: generate IRN (64-char SHA-256), acknowledgement, signed QR, full IRP JSON payload; cancel within 24h; status | Done (sandbox) |
| EWB-01 | **E-way bill**: generate number + validity + portal payload; cancel; status | Done (sandbox) |
| EWB-02 | Flag when an e-way bill is **required** (goods over the ₹50,000 threshold, B2B) | Done |

`POST /api/einvoice/sales/:id/generate`, `POST /api/ewaybill/sales/:id/generate`
(+ `/cancel`, status, and `/ewaybill/sales/:id/required`). These run in
**sandbox mode**: the payload shape and the IRN hash are production-correct, but
the acknowledgement/QR/EWB number are generated locally because no GST Suvidha
Provider (GSP) is connected. Every document is tagged with its `Mode`, so a
sandbox IRN is never mistaken for a filed one. Switching to a live GSP is a
drop-in: POST `payload` to the provider and store the IRN/AckNo/SignedQR it
returns. Set `EWAY_THRESHOLD` to change the ₹50,000 trigger.

**Still not built in R3:** TDS/TCS challans and returns automation, and GSTR-2B
reconciliation (these need live portal contracts). The data model already holds
the inputs (TDS accounts/postings from R1, the GST return log).

## R4 — Differentiation ✗ Not yet built

POS / hospitality (tables, KOT, menu), the MFinAI LLM assistant, a mobile app,
the vendor self-service portal, landed cost and barcode scanning. These are
greenfield builds; the customer portal (R1, PRT-01) is the nearest existing
foundation for the vendor portal.

---

## Open decisions in the requirement doc — defaults chosen

- **Inventory valuation:** weighted-average (the doc's first-listed option). FIFO
  is not implemented.
- **Password reset / notices:** email via configurable SMTP; SMS/WhatsApp via a
  generic HTTP gateway (no provider locked in).
- **Three-way-match tolerance:** 2% on price, 0% on quantity
  (`MATCH_PRICE_TOLERANCE`, `MATCH_QTY_TOLERANCE`).
- **Database:** SQLite (better-sqlite3), file-based with verified daily backups.
  Point-in-time recovery is **not** available (recovery is to the last backup, at
  most a day); a move to PostgreSQL is the production path and is isolated behind
  the `db` layer.
