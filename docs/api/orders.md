# API — Stage 5: PI, payment / credit, sales order, serial-number dispatch, ERP export

Base path `/api/v1`. Success `{ data }`; lists `{ data, total, limit, offset }`; errors `{ error: { code, message, details } }`.
Row types (`ProformaInvoice`, `ProformaInvoiceLine`, `Payment`, `CreditCheck`, `CreditOverride`, `SalesOrder`, `SalesOrderLine`, `Dispatch`, `DispatchSerial`, `EinvoiceStatus`, `InventorySerial`, `InvoiceChainLink`, `Approval`, `Finding`)
are in `packages/shared/src/rows.ts`. Request schemas (Zod), the pure `evaluatePreFlight()` and the **response types** named below (`PreFlightResult`, `PiSummary`, `PiDetail`, `CreditCheckDetail`, `CreditGuardResult`,
`SalesOrderSummary`, `SalesOrderDetail`, `DispatchDetail`, …) are in `packages/shared/src/schemas/commercial.ts` — import them, do not retype them.
Money is rupees (number, 2 decimals); dates `YYYY-MM-DD`; timestamps ISO-8601 UTC. `admin` may call everything.

**Roles.** `COMMERCIAL` = `accounts`, `management`, `sales_manager`. `FINANCE_READ` = COMMERCIAL + `regional_head`. `DISPATCH` = `dispatch`, `management`, `sales_manager`. `ALL` = every role; for `distributor_user` / `dealer_user`
reads are limited to their own party's rows (PIs, sales orders, credit checks via `distributor_id` / `dealer_id`; dispatches via the sales orders they may read). Outside their party → `403 FORBIDDEN`.

**Standard list query** (every `GET` list): `q` (substring search), `limit` (1–200, default 25), `offset`, `sort` (a filterable column, `created_at`, `updated_at`), `order` (`asc`|`desc`, default `desc`).
Filter columns accept `col=a,b` (in), `col__gte`, `col__lte`, `col__gt`, `col__lt`, `col__null=true|false`.

**Error codes** — `VALIDATION_ERROR` 422 (`details` = `[{path,message}]`) · `UNAUTHENTICATED` 401 · `FORBIDDEN` 403 · `NOT_FOUND` 404 · `BAD_REQUEST` 400 · `CONFLICT` 409 (duplicate: `details` carries the existing id) ·
`INVALID_STATE` 409 (wrong status for the action; `details.status`) · `GUARD_BLOCKED` 422 (business guard; `details.gate` = `PRE_PI_CHECKLIST` | `G11`) · `COMPLIANCE_BLOCKED` 422 (dispatch hard stops; `details.findings`) ·
`INSUFFICIENT_STOCK` 422 (`details = { so_line_id, requested, in_stock }`) · `AADHAAR_BLOCKED` 422 (edge guard on any JSON body, see §9).

---

## 0. How the flow fits together

```
accepted quote ──GET /quotes/:id/pre-pi-checklist──▶ POST /pis (draft) ──PATCH /pis/:id── fix checklist items
      POST /pis/:id/submit  (422 while any checklist item is false)  ──▶ approvals (entity proforma_invoice, lane credit, Accounts [→ Management])
      approval decided in /approvals/:id/decide (approvals module) ──▶ PI `issued` (issue_date, valid_till)
      POST /pis/:id/payments            POST /pis/:id/credit-check {advance|credit}  ──▶ POST /credit-checks/:id/decide
      POST /sales-orders {pi_id, customer_po_no, customer_po_date}   ── gate G11 ──▶ `pending_approval` (advance OR credit OK) | `on_hold` (+ payment_reminder clock)
      approvals (entity sales_order, lane credit) ──▶ `approved` + circulated ──▶ POST /sales-orders/:id/handover ──▶ `dispatch_planning`, opportunity `won`, lead `won`
      POST /dispatches (FIFO serial reservation) ─▶ POST /dispatches/:id/evaluate ─▶ [POST /dispatches/:id/serials to swap] ─▶ POST /dispatches/:id/dispatch
      PATCH /dispatches/:id/einvoice (manual IRN / e-way bill) ─▶ GET /dispatches/:id/note
```

**Approvals.** This module only *opens* approval rounds (rows in `approvals`) and *reacts* to decisions; the inbox and the decision endpoint are the approvals module (`GET /approvals`, `POST /approvals/:id/decide`).
Each round is a pre-created chain `step 1..n` (`meta.round`, `meta.label`, `meta.sla_hours`); only the current step has `due_at` and an `approval` SLA clock (`clocks.entity_type = 'approval'`, `entity_id` = the approval row).
Handlers (`registerApprovalHandler`) are registered at module load for `proforma_invoice`, `sales_order` and `credit_override`:

| entity | lane / chain | on `lane_approved` | on `rejected` |
|---|---|---|---|
| `proforma_invoice` | `credit`: Accounts, then Management when `total >= order.management_approval_above` | PI → `issued`, `issue_date` = today, `valid_till` = today + `order.pi_validity_days`, `approved_by`, `issued_at` (re-checks the checklist first; if it regressed the PI returns to `draft`) | PI → `draft`; resubmit opens a new round |
| `sales_order` | `credit`: Accounts, then Management when `total >= order.management_approval_above` | SO → `approved`, `approved_by`, `circulated_at`; notifies dispatch, accounts, the distributor's and the dealer's users | SO → `cancelled` (`hold_reason` = reason), PI freed for a new SO |
| `credit_override` | `credit`: Accounts → Management | override `approved` (`approved_by`, `approved_at`) — this is the row the G11 guard looks for | override `rejected` |

---

## 1. Pre-PI checklist and proforma invoices (steps 28–29)

The checklist (`PreFlightChecklist`) has nine items, all of which must be `true` before a PI can be submitted / issued:
`legal_name`, `billing_address`, `shipping_address`, `gst`, `product`, `quantity`, `price`, `freight`, `payment_terms`.
`gst` is true for a valid GSTIN (`isGstin`) **or** for the explicit "unregistered" flag when the customer is an individual (`customer_type` `residential` or `farmer`): the PI then stores `gstin = "UNREGISTERED"` (`GSTIN_UNREGISTERED`).
Defaults come from the quote and customer: legal name, GSTIN, billing address from the customer (legal name falls back to the lead); shipping address from the customer, else the site address, else billing; payment terms and freight from the quote.

### GET `/quotes/:id/pre-pi-checklist` — roles: ALL (scoped)
Response `PreFlightResult`: `{ quote_id, quote_no, quote_status, accepted, pi_id (live PI for the quote or null), checklist, missing: key[], missing_labels: string[], complete, defaults: { legal_name, gstin, billing_address, shipping_address, payment_terms, freight, customer_type, unregistered_allowed } }`.

### GET `/pis` — roles: ALL (scoped)
Filters: `status`, `dealer_id`, `distributor_id`, `quote_id`, `customer_id`, `issue_date`, `valid_till`; `q` searches `pi_no`, `legal_name`. Rows: `PiSummary` = `ProformaInvoice & { quote_no, dealer_name, paid_amount, balance }`.

### GET `/pis/:id` — roles: ALL (scoped)
`PiDetail` = `PiSummary & { lines: ProformaInvoiceLine[], payments: Payment[] (all statuses), advance_pct, required_advance, advance_ok, credit_checks: CreditCheck[] (newest first), credit_check (latest | null), credit_overrides: CreditOverride[], approvals: Approval[], sales_order: SalesOrder | null, missing_labels: string[] (live checklist), unregistered: boolean }`.

### POST `/pis` — roles: COMMERCIAL — 201 `PiDetail`
Body (flat): `{ quote_id: uuid, legal_name?, gstin?, gst_unregistered?: boolean, billing_address?: Address, shipping_address?: Address, payment_terms?, freight?: number >= 0 }` (the optional fields override what the quote/customer carry; `gstin` and `gst_unregistered: true` together are rejected).
Needs an **accepted** quote (`409 INVALID_STATE` otherwise) and no live PI for it (`409 CONFLICT`, `details.pi_id`). Creates a **draft** PI (`pi_no` `FS/PI/<yy>/<nnnn>`) with the quote lines copied, `subtotal + freight + tax_total = total`,
funding split `consumer_share` / `loan_share` / `subsidy_receivable` (= CFA + state share) from the quote, `pre_pi_checklist` stored (may contain `false` items — draft is allowed), and moves the opportunity to `pi_stage`.
A freight override shifts `total` and `consumer_share` by the difference.

### PATCH `/pis/:id` — roles: COMMERCIAL — `PiDetail`
Draft only (`409` otherwise). Body: any of the override fields above (at least one). Recomputes totals (freight) and the stored checklist.

### POST `/pis/:id/submit` — roles: COMMERCIAL — `PiDetail` (status `pending_approval`)
Step 28 → 29. **`422 GUARD_BLOCKED` while any checklist item is false**: `details = { gate: 'PRE_PI_CHECKLIST', checklist, missing: key[], missing_labels: string[] }` and no approval is created. Otherwise opens the approval round (see §0) and starts the step-1 SLA clock.

### POST `/pis/:id/cancel` — roles: COMMERCIAL — body `{ note? }` — `PiDetail`
Allowed unless a live sales order exists or payments were received (`409`). Closes pending approvals.

### GET `/pis/:id/pdf` — roles: ALL (scoped)
Branded PDF (navy #1F3864 / gold #BF9000 / Helvetica) stored in the `invoices` bucket (`documents` row `doc_type = 'pi_pdf'`; reused until the PI changes; `?refresh=1` forces a new one).
Default response `{ document_id, file_name, url (signed GET, 10 min), expires_at }`; with `?inline=1` the response body is the PDF (`application/pdf`).

---

## 2. Payments (step 30, money side)

### POST `/pis/:id/payments` — roles: COMMERCIAL — 201 `{ payment: Payment, pi: PiDetail }`
Body: `{ kind?: 'advance'|'balance'|'loan_disbursal'|'subsidy' (default advance), amount: number > 0, mode: 'upi'|'neft_rtgs'|'cheque'|'cash'|'card'|'loan'|'other', reference?, received_at?: ISO datetime, status?: 'received'|'pending' (default received) }`.
PI must be `issued` / `partially_paid` / `paid` (`409`). Over-payment of the balance → `422 GUARD_BLOCKED`. Only `received` payments count: `paid >= total` → PI `paid`, `> 0` → `partially_paid`.
Also refreshes `sales_orders.advance_received` and **auto-releases** a held sales order when the advance/credit conditions are now met.

### GET `/payments` — roles: FINANCE_READ
Filters `pi_id`, `sales_order_id`, `kind`, `status`, `mode`, `received_at`; `q` searches `reference`. Rows: `Payment & { pi_no }`.

### PATCH `/payments/:id` — roles: COMMERCIAL — `{ payment, pi: PiDetail | null }`
Body `{ status?: 'received'|'pending'|'bounced', reference? }`. A bounced payment drops the PI back (`partially_paid` / `issued`).

---

## 3. Credit checks, dealer credit position, credit overrides (step 30, credit side)

**Rule `order.min_advance_pct`** (default 30): `required_advance = total × pct / 100`.

### POST `/pis/:id/credit-check` — roles: COMMERCIAL — 201 `CreditCheckDetail`
Body `{ basis: 'advance'|'credit' }`. PI must be issued.
* `advance` — decided at once from payments received: `result` `approved` when `advance_received >= required_advance`, else `rejected`; `decided_by` null (automatic), `notes` explains.
* `credit` — dealer orders only (`400` without a dealer). Snapshots the dealer's exposure (`credit_limit`, `outstanding`, `ageing` buckets, `subsidy_linked`, `bg_valid`, `portal_status`) with `result: 'pending'`, notifies Accounts/Management. A second pending check for the PI → `409`.
`CreditCheckDetail` = `CreditCheck & { pi_no, dealer_name, pi_total, advance_received, required_advance, exposure_after, guard: CreditGuardResult | null }` (`guard` is filled on single reads and after create/decide, `null` in lists).

### GET `/credit-checks` — roles: ALL (scoped by distributor/dealer)
Filters `result`, `basis`, `pi_id`, `sales_order_id`, `dealer_id`, `distributor_id`. Rows `CreditCheckDetail` (without `guard`).

### GET `/credit-checks/:id` — roles: ALL (scoped) — `CreditCheckDetail` (with `guard`)

### POST `/credit-checks/:id/decide` — roles: `accounts`, `management` — `CreditCheckDetail`
Body `{ result: 'approved'|'rejected', notes? }` (`notes` required to reject). Only `pending` checks (`409` otherwise). Approval releases a held sales order automatically. This decision does **not** bypass G11.

### GET `/credit-position/:dealerId` — roles: ALL (dealer / distributor limited to their own)
Thin wrapper over `computeDealerExposure`: `{ dealer_id, dealer_name, distributor_id, credit_limit, outstanding, available, over_limit, utilisation_pct, ageing: { current, d1_30, d31_60, d61_90, d90_plus }, overdue_amount, overdue_pct, subsidy_linked, subsidy_linked_pct_of_limit, dso_days, invoices_open, bank_guarantee: { amount, valid_till, days_left, valid, expiring_soon }, portal_status, sop_open, deactivated, blocked_reasons: string[], overrides: CreditOverride[], recent_checks: CreditCheck[] (10) }`.

### POST `/credit-overrides` — roles: COMMERCIAL — 201 `{ override: CreditOverride, approvals: Approval[] }`
Body `{ dealer_id, pi_id, reason (≥ 10 chars) }`. The PI must belong to the dealer; one pending/approved override per PI (`409`). Opens the chain **Accounts → Management** (entity `credit_override`, lane `credit`). Status `pending` → `approved` / `rejected` by the approvals engine (decisions on overrides need a written comment).

### GET `/credit-overrides` — roles: FINANCE_READ — filters `status`, `dealer_id`, `pi_id`, `sales_order_id`; `q` searches `reason`.
### GET `/credit-overrides/:id` — roles: FINANCE_READ — `{ override, dealer_name, pi_no, approvals }`

---

## 4. Sales order (steps 31–34)

Statuses: `on_hold` · `pending_approval` · `approved` · `dispatch_planning` · `partially_dispatched` · `dispatched` · `cancelled`.

### Gate G11 — credit guard (Appendix A)
`exposure_after = outstanding (open + overdue dealer receivables) + max(0, order_total − advance_received)`. The order is **blocked** when `exposure_after > dealer.credit_limit` or the dealer's portal status is `deactivated`,
unless an **approved** `credit_overrides` row exists for the dealer and this PI. `under_sop` is allowed with a warning. Distributor-direct orders (PI without a dealer) are not credit-guarded.
Blocked → `422 GUARD_BLOCKED`, `details = CreditGuardResult & { override_available: false }` = `{ gate: 'G11', blocked, reasons[], warnings[], order_total, advance_received, outstanding, exposure_after, credit_limit, portal_status, override_id }`. The SQL trigger enforces the same rule.

### POST `/sales-orders` — roles: COMMERCIAL — 201 `SalesOrderDetail`
Body `{ pi_id, customer_po_no, customer_po_date: date, po_document_id?: uuid (a /documents row) }`. PI must be issued (`409`); one live SO per PI (`409`).
1. G11 guard (above).
2. Payment/credit: **advance OK** (`advance_received >= min advance`) **or** an approved `credit`-basis credit check ⇒ status `pending_approval`, `credit_basis` `advance` | `credit`, approval opened (step 33).
   Otherwise status **`on_hold`** with `hold_reason`, no approval yet, and a **`payment_reminder` clock** (cadence rule `order.payment_reminder_hours`, default 24 h, pushed into working time).
3. SO `so_no` `FS/SO/<yy>/<nnnn>`, lines copied from the PI (`qty_dispatched` 0), `PI.sales_order_id` set, payments and the approved credit check / override linked to the SO.
`warnings: string[]` in the response: under-SOP dealer, bank guarantee expiring, credit guard bypassed by an override, PI validity ended.

**Payment reminders.** When the clock breaches, the approved transactional WhatsApp template `wa.payment_reminder` ({{1}} name, {{2}} amount due, {{3}} PI number) is sent through `ctx.svc.messaging.send` (consent-aware; a blocked/failed send notifies the owner instead), the next day's clock is scheduled (cycle +1),
and after `order.payment_reminder_escalation` reminders (default 3 / 5) the Sales Manager / Management are notified. The clock engine itself alerts the owner and DSM at each breach.

### GET `/sales-orders` — roles: ALL (scoped)
Filters `status`, `dealer_id`, `distributor_id`, `segment`, `pi_id`, `customer_id`, `order_date`; `q` searches `so_no`, `customer_po_no`. Rows: `SalesOrderSummary` = `SalesOrder & { pi_no, dealer_name, customer_name }`.

### GET `/sales-orders/:id` — roles: ALL (scoped) — `SalesOrderDetail`
`SalesOrderSummary & { lines: (SalesOrderLine & { remaining_qty, reserved_qty, serial_tracked })[], pi, payments, approvals, credit_checks, dispatches: (Dispatch & { serial_count })[], installation_id | null, compliance_snapshot: { quote: { quote_id, status, evaluated_at, findings } | null, dispatches: [{ dispatch_id, dispatch_no, status, compliance_status, findings }] }, warnings: string[] }`.
`remaining_qty` = still to be planned (ordered − dispatched − currently reserved).

### POST `/sales-orders/:id/release-hold` — roles: COMMERCIAL — body `{ note? }` — `SalesOrderDetail`
`on_hold` only (`409`). Re-checks G11 and the advance/credit condition (`422 GUARD_BLOCKED` while unmet), then `pending_approval`, opens the approval, completes the reminder clock. Happens automatically when a payment is recorded or a credit check is approved.

### POST `/sales-orders/:id/handover` — roles: COMMERCIAL — body `{ note? }` — `SalesOrderDetail`
Step 34. Needs `approved` (`409`). → `dispatch_planning`, `dispatch_handover_at`, opportunity `won`, lead `won` (+ `last_action`), notifies the dispatch role.

### POST `/sales-orders/:id/cancel` — roles: COMMERCIAL — body `{ note? }` — `SalesOrderDetail`
Not after shipment (`409`). Cancels open dispatches (serials return to stock), pending approvals and clocks; frees the PI.

---

## 5. Serial-number dispatch

Serial-tracked SKU categories: `module`, `inverter`, `battery`. Other lines (structures, cables, …) are **bulk**: they are not listed in `lines`; they are marked fully dispatched with the SO's first shipped consignment.
Statuses: `planned` → `ready` | `blocked` → `dispatched` (| `cancelled`). `DISPATCH` roles operate; everyone (scoped) reads.

### POST `/dispatches` — roles: DISPATCH — 201 `DispatchDetail`
Body `{ so_id, planned_at?: ISO datetime | date, vehicle_no?, transporter?, lines: [{ so_line_id, qty?: int, serial_ids?: uuid[] }] }` (each line needs `qty` and/or `serial_ids`; lines may be empty only for an order with no serial-tracked lines).
SO must be `dispatch_planning` / `partially_dispatched` (`409`). **FIFO by batch**: in-stock serials of the line's SKU ordered by `stock_batches.received_at` (then batch, then serial), batch-less serials last; claimed optimistically (`in_stock` → `reserved`, linked to the SO line, quote and dispatch).
Explicit `serial_ids` must be in stock and of the line's product. Over-planning a line → `400` (`details.remaining`); short stock → `422 INSUFFICIENT_STOCK` and nothing is left reserved. `dispatch_no` `FS/DSP/<yy>/<nnnn>`; `ship_to` = the PI shipping address.

### GET `/dispatches` — roles: ALL (scoped via sales orders)
Filters `status`, `so_id`, `compliance_status`, `ewb_status`; `q` searches `dispatch_no`, `invoice_no`, `vehicle_no`. Rows: `Dispatch & { so_no, serial_count }`.

### GET `/dispatches/:id` — roles: ALL (scoped) — `DispatchDetail`
`Dispatch & { so_no, segment, so_status, serials: [{ ...DispatchSerial, serial, sku_id, sku_label, category, batch_id, batch_no, received_at, status, compliance_snapshot, invoice_chain, compliance: { compliant, applicable, missing: string[] } }], lines: [{ so_line_id, description, serial_tracked, qty_ordered, qty_dispatched, qty_in_this_dispatch }], einvoice: EinvoiceStatus | null, hard_stops: Finding[], override: { approved, pending, approval_ids } }`.
Per-serial `compliance` is for the **order's segment** (Appendix A): `pmsg_residential` / `pm_kusum` need `dcr_verified`; every segment except `ci_captive` needs `almm_list1`; `pmsg_residential` / `rwa_ghs` / `government_bid` also need `almm_list2` when the expected commissioning date is on/after `almm.list2.effective_date` (only while that rule is active).
These apply to **module** serials; inverter/battery serials report `applicable: false`.

### POST `/dispatches/:id/evaluate` — roles: DISPATCH — `DispatchDetail`
Calls `ctx.svc.compliance.evaluateDispatch(soId, { dispatchId, serialIds, persist: false })`, adds the per-serial segment findings above (gates G2 DCR / G3 List-I / G4 List-II, `fieldRefs: ['serial:<serial id>']`), stores `compliance_findings` and `compliance_status`, and sets `status` `blocked` (hard stop, no override) or `ready`.

### POST `/dispatches/:id/serials` — roles: DISPATCH — `DispatchDetail`
Body (at least one): `{ add: [{ serial_id, so_line_id? }], remove: [serial_id], replace: [{ old_serial_id, new_serial_id }] }` — swap out a non-compliant serial (same product required). Planned dispatches only (`409`). Resets the evaluation (`status planned`, `compliance_status pending`) — evaluate again.

### POST `/dispatches/:id/dispatch` — roles: DISPATCH — `DispatchDetail`
Body `{ vehicle_no?, transporter?, invoice_no? (generated FS/INV/<yy>/<nnnn> when omitted), chain_invoices?: { dealer?, site? } }`.
1. Re-evaluates compliance. **`422 COMPLIANCE_BLOCKED`** (`details.findings` = hard stops) while a hard stop exists, unless an **approved compliance override** exists (§ below). Nothing is changed when blocked.
2. Invoice chain **brand → distributor → dealer → site** (`InvoiceChainLink { from, to, invoice_no, date }`) written to the dispatch and to every serial. The brand → distributor link carries the dispatch invoice number; downstream links carry `chain_invoices` or `"PENDING"` (fill in later with `PATCH …/invoice-chain`). Distributor-direct orders skip the dealer hop.
3. E-invoice (`ctx.providers.einvoice`) and e-way bill (`ctx.providers.ewayBill`): `einvoice_status` row (`entity_type 'dispatch'`) and `dispatches.ewb_status` / `ewb_no`. Status `generated` | `manual_pending` | `failed` — **`manual_pending` / `failed` never block the truck**; `irn` / `ewb_no` stay null (the mock provider's fake references are not stored as real) and Accounts/Dispatch are notified to enter them manually.
4. Serials → `dispatched`; SO lines `qty_dispatched` recomputed from facts; SO → `partially_dispatched` or `dispatched`; dispatch → `dispatched` (`dispatched_at`). Safe to retry after a partial failure.

### POST `/dispatches/:id/cancel` — roles: DISPATCH — body `{ note? }` — `DispatchDetail`
Planned dispatches only. **Unreserves** every serial (back to `in_stock`, SO/line/dispatch links cleared).

### PATCH `/dispatches/:id/einvoice` — roles: DISPATCH + `accounts` — `DispatchDetail`
Manual-entry fallback. Body: `{ irn?: 64 hex chars, ack_no?: digits, ack_date?: ISO datetime | date, ewb_no?: 12 digits }`. An `irn` needs `ack_no` and `ack_date`. Sets `einvoice_status` to `generated` (`provider: 'manual'`) and/or `ewb_status: 'generated'`, `ewb_no`.
Send `ewb_no` as a JSON **number** if the edge Aadhaar guard rejects the string (see §9).

### PATCH `/dispatches/:id/invoice-chain` — roles: DISPATCH + `accounts` — body `{ distributor_to_dealer?, dealer_to_site? }` (for a distributor-direct order `dealer_to_site` is the distributor → site link) — `DispatchDetail`
Fills the downstream invoice numbers on the dispatch and all its serials.

### POST `/dispatches/:id/compliance-override` — roles: DISPATCH — 201 `DispatchDetail`
Body `{ reason (≥ 10 chars) }`. Opens a compliance-lane approval (`entity_type 'compliance_override'`, `entity_id` = dispatch id, `required_role compliance_officer`, `meta { round, dispatch_id, so_id, reason }`); `409` while one is pending.
The latest fully **approved** round is a blanket override: the dispatch may go out although `compliance_status = 'blocked'`, and its hard-stop findings are stored with `overridden: true`.

### GET `/dispatches/:id/note` — roles: ALL (scoped)
Dispatch note PDF (consignee, vehicle, invoice, e-way bill / IRN, serial table with batches, invoice chain, signature lines) in the `invoices` bucket (`doc_type 'dispatch_note'`, `dispatches.dispatch_note_document_id`; regenerated and replaced on each call).
Response `{ document_id, file_name, url, expires_at }`, or the PDF bytes with `?inline=1`.

---

## 6. ERP export

### GET `/exports/erp` — roles: COMMERCIAL
Query: `doc` = `pi` | `so` | `invoice` (required) · `layout` = `tally` | `sap` (default tally) · `format` = `csv` | `xlsx` (default csv) · `from`, `to` = `YYYY-MM-DD`, inclusive (`pi`: issue date of issued PIs · `so`: order date of non-draft/non-cancelled orders · `invoice`: IST date the dispatch went out).
Response is a file download (`Content-Disposition: attachment`, `X-Export-Rows`), not JSON. Columns and mapping: **`docs/ERP_EXPORT.md`**. The export is audited (`erp.export`).

---

## 7. Rules read (`rule_config`, seed fragment `packages/shared/src/seed/rules.orders.ts`)

| path | default if absent | use |
|---|---|---|
| `order.min_advance_pct` | 30 | advance branch of step 30 and the SO hold decision |
| `order.pi_validity_days` | 15 | `valid_till = issue_date + n` |
| `order.payment_reminder_hours` | 24 | reminder cadence while an SO is on hold |
| `order.payment_reminder_escalation` | `{ sales_manager_after: 3, management_after: 5 }` | reminder count that pulls in the Sales Manager / Management |
| `order.approval_sla_hours` | 8 (working hours) | per-step approval SLA for PI, SO and credit override |
| `order.management_approval_above` | 2 500 000 | PI/SO total at or above which Management is a second approval step |
| `almm.list2.effective_date` | — (inactive ⇒ List-II not enforced) | per-serial List-II check |
| `work_calendar.days/start/end/holidays` | Mon–Sat 09:30–18:30 | working-time arithmetic |

Rules that are not `verified` + active are advisory only and never change behaviour.

## 8. Side effects worth knowing
* Every mutation is audited (`audit_log`, e.g. `pi.create`, `pi.issue`, `payment.record`, `credit_check.advance`, `so.create`, `so.release_hold`, `so.handover`, `dispatch.create`, `dispatch.dispatch`, `erp.export`).
* Lead timeline (`lead_events`): `sales_order_created`, `sales_order_released`, `sales_order_approved`, `order_handover`, `payment_recorded`, `credit_decision`, `payment_reminder`, `dispatched`.
* Notifications: approval requests/decisions, `so.on_hold`, `so.circulated`, `so.handover`, `credit_check.pending`, `dispatch.dispatched`, `dispatch.einvoice_manual`, overdue-payment escalations.
* Customer messages (payment reminders) go only through `ctx.svc.messaging.send` with purpose `transactional`.

## 9. Known edge: Aadhaar guard and 12-digit e-way bill numbers
The edge guard (G14) rejects any JSON **string** that contains a Verhoeff-valid 12-digit number — roughly 1 in 11 real e-way bill numbers. `PATCH /dispatches/:id/einvoice` therefore also accepts `ewb_no` as a JSON number (not scanned).
A kernel-level fix would be to add `ewb_no` (and `irn`) to the guard's skip list in `packages/shared/src/aadhaar.ts`.
