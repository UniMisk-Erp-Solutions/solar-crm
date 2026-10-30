# Post-sale and channel management API

Base path `/api/v1`. All endpoints need a signed-in user. Success is `{ data }`; lists are `{ data, total, limit, offset }`; errors are `{ error: { code, message, details } }`.
Request schemas and response types live in `@solar/shared` (`schemas/postsale.ts`, `schemas/channel.ts`); rows are the types in `rows.ts`.

## Conventions

* **Roles.** `admin` is always allowed. Groups used below:
  * **ANY** — every signed-in role; rows are scoped (see next point).
  * **FIELD** — `accounts, management, sales_manager, dsm, regional_head, dispatch, techno_commercial, dealer_user, distributor_user`.
  * **CHANNEL** — `accounts, management, sales_manager, dsm, regional_head`.
  * **CHANNEL+C** — CHANNEL plus `compliance_officer`.
* **Scoping.** `distributor_user` sees only rows of its own distributor, `dealer_user` only its own dealer's. Reading another party's row is `403 FORBIDDEN`. `vendor_registrations` and `sop_cases` are internal-only (external roles get `403`). Internal roles see everything.
* **List query** (every `GET` list): `q` (search), `limit` (1–200, default 25), `offset`, `sort`, `order=asc|desc`, filters `?col=a,b` (IN), `?col__gte= / __lte= / __gt= / __lt=`, `?col__null=true|false`. The filterable columns of each list are named below.
* **`warnings: string[]`** — stateful endpoints add this array to the row they return. Warnings never block: they say, for example, that a rule is inactive so a clock was not started. A rule that is `is_active = false` never changes behaviour; a rule that does not exist at all falls back to the documented default.
* **Timestamps in bodies** (`postsaleTimestampSchema`): an ISO-8601 instant with offset, or a bare `YYYY-MM-DD` (taken as 00:00 IST). "Within N days" deadlines are the **end of the IST calendar day** N days after the start date, so `due_at` looks like `2026-11-10T18:29:59.999Z`.
* **Errors.** `422 VALIDATION_ERROR` (bad body), `422 GUARD_BLOCKED` (business rule, `details` explains), `409 INVALID_STATE` / `CONFLICT`, `403`, `404`. Every mutation is written to `audit_log`.
* **Aadhaar.** Bodies containing an Aadhaar number are refused (`422 AADHAAR_BLOCKED`); upload file names such as `aadhaar_*.jpg` are refused.

---

## 1. Installations

An installation is created from a **dispatched** sales order (`partially_dispatched`, `dispatched` or `closed`). Status ladder: `planned → installed (install_date) → certified (certificate_at) → commissioned`.

Row: `Installation` + hydrated `customer_name`, `dealer_name`, `so_no`, `geo_tagged_photos`, `discom_application` (`{ id, application_no, feasibility_status, commissioning_due_at, commissioning_at, deemed_breach } | null`).

| Endpoint | Roles | Notes |
|---|---|---|
| `GET /installations` | ANY | Filters: `status, dealer_id, distributor_id, sales_order_id, site_id, customer_id, vendor_registration_id, agreement_status, no_connectivity_agreement, install_date, certificate_at, commissioned_at, om_end, kw`. Search: `installer_name, regulation_version`. |
| `GET /installations/:id` | ANY | |
| `GET /installations/om-register` | ANY | See below. Declared before `/:id`. |
| `POST /installations` | FIELD | Body `InstallationCreateInput`: `sales_order_id` (uuid, required), `installer_name?`, `vendor_registration_id?` (must belong to the order's dealer or distributor), `install_date?` (YYYY-MM-DD), `kw?` (default: opportunity, then quote kW), `agreement_status?` (`pending\|signed\|not_required`; default `pending` for PMSG / RWA / KUSUM, else `not_required`), `no_connectivity_agreement?`. `201` → installation + `warnings`. Errors: `422 GUARD_BLOCKED` if the order is not dispatched; `409` if the order already has an installation. |
| `PATCH /installations/:id` | FIELD | Body `InstallationUpdateInput`: the create fields (except the order) plus `certificate_at?` and `commissioned_at?`. Passing `certificate_at` / `commissioned_at` behaves exactly like the two endpoints below. |
| `POST /installations/:id/certificate` | FIELD | Body `{ certificate_at? }` (default now). Needs `install_date` and `kw`; the certificate cannot predate the install date. Sets status `certified`, **creates or updates the DISCOM application** (links it, `certificate_submitted_at`, `commissioning_due_at`) and **starts the `discom_commissioning` clock** (entity `discom_application`; length = rule `discom.commissioning_days`, default 15 days). Response `{ installation, discom_application, warnings }`. |
| `POST /installations/:id/commission` | FIELD | Body `{ commissioned_at?, meter_type?, meter_at? }`. Needs a certificate. Completes the clock, sets `commissioned_at`, status `commissioned`, **`regulation_version`** (rule `gerc.regulation_versions`, latest `from` ≤ commissioning date), **`warranty_end`** (longest SKU warranty of the order's serials), **`om_end`** (rule `pmsg.om_years`, default 5), flips the order's `dispatched` serials to `installed`, and closes the project's subsidy-linked receivables if its subsidy is already released. Response `{ installation, discom_application, serials_installed, receivables_closed, warnings }`. `409` if already commissioned. |
| `POST /installations/:id/photos` | FIELD | `multipart/form-data`, file field `photos` (up to 10 images; JPG / PNG / WebP — a PDF is `400`). Optional text fields `lat`, `lng`, `taken_at` supply device GPS for photos without EXIF geo. Stored in bucket `site-photos`; EXIF geo is read from JPEGs. `201` → `{ installation, uploaded: InstallPhoto[], warnings }`; a warning counts photos with no geo-tag. |

**`GET /installations/om-register`** — the 5-year O&M register (vendor-of-record duty). Query: `state=not_started|active|expiring|expired`, `dealer_id`, `distributor_id`, `within_days` (O&M ends in 0..N days), `limit` (≤500, default 100), `offset`. Response (not wrapped again): `{ data: OmRegisterRow[], total, limit, offset, summary: { not_started, active, expiring, expired, expiring_window_days } }`, sorted by `om_end` ascending. `expiring` = `days_left ≤` rule `postsale.om_expiring_days` (default 90). Row: `installation_id, sales_order_id, customer_id, customer_name, dealer_id, dealer_name, distributor_id, vendor_registration_id, installer_name, kw, commissioned_at, om_start, om_end, days_left, state, warranty_end`.

Rule `gujarat.pmsg_no_connectivity_agreement` (seeded unverified / inactive): when **active** and the order is Gujarat PMSG, `no_connectivity_agreement` defaults to `true` on create and the DISCOM application's `agreement_status` becomes `not_required`. While inactive the flag is a manual entry (a warning says so).

---

## 2. DISCOM applications

Row: `DiscomApplication` + hydrated `customer_name, dealer_name, discom_code, discom_name, commissioning_overdue, days_to_commissioning_due, feasibility_clock, commissioning_clock` (`{ status, due_at } | null`).

| Endpoint | Roles | Notes |
|---|---|---|
| `GET /discom-applications` | ANY | Filters: `discom_id, dealer_id, distributor_id, sales_order_id, installation_id, site_id, customer_id, feasibility_status, agreement_status, deemed_breach, regulation_version, submitted_at, complete_at, certificate_submitted_at, commissioning_due_at, commissioning_at, inspection_at, meter_at, applied_kw`. Search: `application_no, meter_type`. |
| `GET /discom-applications/:id` | ANY | |
| `GET /discom-applications/ageing` | ANY | Per-DISCOM stage ageing. Query `discom_id, distributor_id, dealer_id, from, to` (YYYY-MM-DD, on the application's first known date). `data: DiscomStageAgeingResult` = `{ rows, totals, generated_at }`; each row: `discom_id, discom_code, discom_name, applications, feasibility\|inspection\|meter\|commissioning: { n, pending, median_days, p90_days }, breaches: { commissioning, feasibility, total }`. Stage definitions: feasibility = application complete (else submitted) → outcome (a lapsed clock counts to its due date); inspection = certificate → inspection; meter = inspection (else certificate) → meter; commissioning = certificate → commissioning. `pending` = started, not finished. Also exported as `discomStageAgeing(ctx, filters)` from `services/discomService.ts` (scoped to the caller). |
| `POST /discom-applications` | FIELD | Body `DiscomApplicationCreateInput`: `applied_kw` (required) and at least one of `sales_order_id, installation_id, site_id`; optional `customer_id, discom_id, dealer_id, distributor_id, application_no, submitted_at, complete_at, agreement_status`. Missing links, the DISCOM and survey dates are filled from the order / site / latest survey. `feasibility_status` is `not_required` up to rule `discom.feasibility_study_exempt_up_to_kw` (default 10 kW), else `pending`. |
| `PATCH /discom-applications/:id` | FIELD | Body `DiscomApplicationUpdateInput`: `discom_id, application_no, applied_kw, submitted_at, complete_at, feasibility_status, inspection_at, meter_type, meter_at, commissioning_at, agreement_status`. Behaviour below. |

Behaviour:
* **Feasibility (> exempt kW):** setting `complete_at` starts the `discom_feasibility` clock, stores `feasibility_due_at`, length = rule `discom.feasibility_study_days_above_10kw` (default 15 d). If the clock breaches, `feasibility_status` becomes **`deemed`** (deemed feasible on silence), the clock is resolved, evidence is written to the audit log and the DSM is notified. A nightly job (`discom.deemed_feasibility_sweep`) does the same if no handler ran. Setting `feasibility_status` to `approved / rejected / deemed` completes the clock; `not_required` cancels it. Changing `applied_kw` re-evaluates the exemption.
* **Commissioning:** a breach of the `discom_commissioning` clock sets `deemed_breach = true`, writes an `audit_log` row `discom.deemed_breach` with `detail.evidence`, and notifies the DSM (`kind discom.deemed_breach`). Setting `commissioning_at` (needs the installation certificate when linked) runs the same completion as `POST /installations/:id/commission`; commissioning dated after `commissioning_due_at` also sets `deemed_breach`.

---

## 3. Subsidy claims

Row: `SubsidyClaim` + hydrated `customer_name, dealer_name, blockers: string[], days_to_deadline, clocks: { cfa_release, legacy_deadline, grievance }` (each `{ status, due_at } | null`). Status ladder: `not_ready → ready → claimed → released`, or `rejected` (re-openable). `ready` is automatic when bank proof, photos, DISCOM inspection approval and e-token are all present.

| Endpoint | Roles | Notes |
|---|---|---|
| `GET /subsidy-claims` | ANY | Filters: `status, cohort, dealer_id, distributor_id, customer_id, installation_id, sales_order_id, claim_deadline, claim_at, discom_approval_at, released_at, rejection_reason, state_share_received_at`. Search: `e_token, rejection_reason`. |
| `GET /subsidy-claims/:id` | ANY | |
| `POST /subsidy-claims` | FIELD | Body `SubsidyClaimCreateInput`: `installation_id` (required); optional `cohort` (`legacy\|current`), `application_date`, `households` (RWA), `bank_proof_ok, photos_ok, inspection_ok, e_token, state_share_due_at`. One claim per installation (`409`). Segments without a central scheme (C&I, open access, government) are refused (`422`). `cfa_computed` comes from `computeCfa`; `state_share` is the order's quotation `state_share` if > 0, else rule `gujarat.state_subsidy` (`{ per_kw?, fixed?, pct_of_cfa?, max_total? }`; an empty object, inactive or absent ⇒ 0). `photos_ok` defaults to "has a geo-tagged installation photo". **Cohort:** `cohort` from the body; else `legacy` when the rule `pmsg.legacy_cohort_cutoff` is **active** and the application date (body → DISCOM application submitted date → order date) is earlier; else `current` (+ warning). A legacy claim gets `claim_deadline` = rule `pmsg.claim_deadline.legacy_cohort` and a `legacy_cfa_claim_deadline` clock (warn at D-14). |
| `PATCH /subsidy-claims/:id` | FIELD | Body: `cohort, bank_proof_ok, photos_ok, inspection_ok, e_token, state_share_due_at, discom_approval_at`. Status is recomputed (`not_ready` ↔ `ready`). `409` once released. |
| `POST /subsidy-claims/:id/discom-approval` | FIELD | Body `{ approved_at? }`. Sets `discom_approval_at`, ticks `inspection_ok`, and **starts the `cfa_release` clock** (rule `pmsg.cfa_release_days_after_discom_approval`, default 15 d). Breach notifies Accounts. |
| `POST /subsidy-claims/:id/claim` | FIELD | Body `{ claim_at? }`. Submits the claim (`ready → claimed`); `422 GUARD_BLOCKED` with `details.blockers` if not ready; completes the legacy deadline clock; warns if submitted after the deadline. |
| `POST /subsidy-claims/:id/reject` | FIELD | Body `{ reason, note? }`, `reason` ∈ `bank_proof_invalid, photos_unclear, inspection_pending, dcr_mismatch, name_mismatch, duplicate_claim, deadline_missed, other` (`SUBSIDY_REJECTION_REASONS`). |
| `POST /subsidy-claims/:id/reopen` | FIELD | Rejected → `not_ready` / `ready`; a legacy claim gets its deadline clock back. |
| `POST /subsidy-claims/:id/release` | CHANNEL, dispatch, techno_commercial | Body `{ released_at?, state_share_received_at? }`. Only from `claimed`. Completes the `cfa_release`, `legacy_cfa_claim_deadline` and `grievance` clocks and **closes the project's subsidy-linked dealer receivables** (`status paid`, matched on `linked_project_id` = sales order, installation or opportunity id). Response: claim + `receivables_closed`, `warnings`. |
| `POST /subsidy-claims/:id/state-share` | CHANNEL | Body `{ received_at?, due_at? }` (at least one). Records the state share received / its expected date. |
| `POST /subsidy-claims/:id/grievance` | FIELD | Body `{ raised_at?, note? }`. Starts the `grievance` clock (rule `pmsg.grievance_days`, default 30 d). |
| `POST /subsidy-claims/:id/grievance/resolve` | FIELD | Completes the grievance clock. |
| `GET /subsidy-claims/worklist` | ANY | The **daily work-list**. Query `cohort, status, dealer_id, distributor_id, limit` (≤500, default 200). Open claims (`not_ready, ready, claimed`), **legacy cohort first**, then not-yet-submitted before submitted, then fewest days to the deadline, then oldest. Response (unwrapped): `{ data: SubsidyWorklistRow[], total, summary }`. Row: `claim_id, status, cohort, phase (prepare\|submit\|await_release), customer_*, dealer_*, installation_id, sales_order_id, cfa_computed, state_share, claim_deadline, days_to_deadline, deadline_state (overdue\|critical\|urgent\|warning\|ok\|null), deadline_met, discom_approval_at, cfa_release_due_at, cfa_release_overdue, age_days, blockers[], next_action`. Summary: `legacy, legacy_at_risk, legacy_value_at_risk, current, blocked, ready_to_claim, awaiting_release, as_of`. |
| `GET /subsidy-claims/state-share-ageing` | ANY | State-share receivable ageing. Query `dealer_id`, `include_received=true\|false`. `{ data: StateShareAgeingRow[], buckets: { not_due, d0_30, d31_60, d61_90, d90_plus }, outstanding }`. Ageing counts from `state_share_due_at` when set, otherwise from the release / claim / approval date. |

**Legacy reminders (D-14 / D-7 / D-3).** Rule `subsidy.legacy_reminder_days` (default `[14,7,3]`). The nightly job `subsidy.legacy_claim_reminders` (`sendLegacyClaimReminders(ctx)`) notifies once per claim per threshold: first threshold → DSM, Accounts, the distributor; second adds the **Sales Manager**; third adds **Management**; after the deadline Sales Manager, Management and DSM are told it was missed (`kind subsidy.legacy_deadline.d14 / d7 / d3 / overdue`). The clock engine also warns at D-14 and notifies Sales Manager + Management when the deadline passes.

---

## 4. Loans

Row: `Loan` + hydrated `dealer_name, customer_name, age_days` (open loans), `ageing_over_threshold`. Served by the CRUD router: `GET /loans`, `GET /loans/:id`, `POST /loans`, `PATCH /loans/:id`. Roles: read ANY; write CHANNEL, `techno_commercial`, `distributor_user`, `dealer_user`. Filters: `status, bank, dealer_id, distributor_id, customer_id, lead_id, opportunity_id, owner_id, rejection_code, application_date, disbursed_at`; search `bank, co_applicant, notes`.

Body (`loanCreateSchema` / partial for PATCH): `bank` (required), `opportunity_id, lead_id, customer_id, dealer_id, distributor_id, owner_id, application_date, status, rejection_code, amount, rate_pct, rate_source_date, co_applicant, document_checklist ({ [doc]: boolean }), notes`.
* External users are pinned to their own dealer / distributor on create.
* **Status ladder:** `draft → applied → in_review → approved → disbursed`; `rejected` from `applied / in_review` (can be re-applied); `withdrawn` from any open state. Illegal moves: `422 GUARD_BLOCKED` with `details.allowed`. `application_date` defaults to today when the loan leaves draft.
* **`rejection_code`** (`LOAN_REJECTION_CODES`: `name_mismatch, arrears, land_title, collateral_demanded, missing_documents, other`) is required for `rejected` and only allowed there.
* **`rate_pct` is a free input and is never defaulted.** If it is given, `rate_source_date` is required (`422`).
* **Ageing clock** `loan_ageing` starts when the loan becomes `applied`, measured from the actual `application_date`; its threshold is rule `loan.ageing_warn_days` (default 15). Passing it only warns (DSM + owner, once); it never escalates to Management. Completed on any decision.

`GET /loans/summary` (ANY, scoped) — query `from, to` (application date), `bank`, `dealer_id`, `distributor_id`. `data: LoanSummary` = `{ overall, by_bank[], by_dealer[], rejection_codes: [{ code, count }], ageing: { warn_days, pending, over_threshold } }`; each group `{ key, label, applied, approved, rejected, disbursed, approval_rate_pct }`. *Applied* = every loan that left draft; *approved* = approved or disbursed.

---

## 5. Warranty / RMA tickets

Row: `WarrantyTicket` + hydrated `serial_no, dealer_name, customer_name, turnaround_days, rma_overdue, days_to_rma_due`. Statuses: `open → inspected → sent_to_brand → replaced / rejected → closed` (see `WARRANTY_NEXT`; illegal moves `422`; `rejected → sent_to_brand` allowed as a brand appeal).

| Endpoint | Roles | Notes |
|---|---|---|
| `GET /warranty-tickets` | ANY | Filters: `status, type, cost_bearer, dealer_id, customer_id, installation_id, sales_order_id, serial_id, owner_id, opened_at, rma_due_at, closed_at`; extra `?serial=<serial no>`; search `ticket_no, issue, brand_claim_no`. |
| `GET /warranty-tickets/:id` | ANY | |
| `POST /warranty-tickets` | FIELD | Body `WarrantyTicketCreateInput`: one of `serial` (printed serial) / `serial_id` / `installation_id` / `sales_order_id`; `type` (`warranty, rma, om_visit, complaint`); `issue`; optional `brand_claim_no, cost_bearer` (`distributor, dealer, brand, consumer, unknown` — default `unknown`), `customer_id, dealer_id, owner_id`. `ticket_no` = `FS/W/<yy>/<nnnn>` (yy = IST year; numbering restarts yearly). Types `warranty` and `rma` start the **`warranty_rma` clock** (rule `warranty.rma_tat_days`, default 21 d; `rma_due_at`). Type `rma` moves the serial to `rma`. A serial still `in_stock` is refused. |
| `PATCH /warranty-tickets/:id` | FIELD | Body `status, issue, brand_claim_no, cost_bearer, recovered_amount, owner_id`. `replaced / rejected / closed` complete the RMA clock; `sent_to_brand` moves the serial to `rma`; `rejected`, or `closed` without a replacement, returns it to `installed` (or `dispatched`); a replaced unit stays `rma`. `recovered_amount` is the brand-claim recovery (a warning if there is no `brand_claim_no`). |

---

## 6. Receivables (`dealer_receivables`)

CRUD router: `GET /receivables`, `GET /receivables/:id`, `POST /receivables`, `PATCH /receivables/:id` (no delete). Read ANY (scoped); write CHANNEL. Filters: `dealer_id, distributor_id, status, subsidy_linked, linked_project_id, invoice_date, due_date`; search `doc_ref`. Default sort `due_date` ascending.
Body: `dealer_id` (create only), `doc_ref`, `amount` (> 0), `paid_amount?`, `invoice_date`, `due_date` (≥ invoice date), `subsidy_linked?`, `linked_project_id?` (sales order, installation or opportunity id), `status?`. `distributor_id` is derived. **`status` is always recalculated** from the amounts and due date: `paid` when fully paid, `overdue` when past due, else `open` (only `written_off` is respected). Responses add `open_amount`, `days_overdue`, `dealer_name`, and show the recalculated `status` even before the nightly job (`receivables.overdue_sweep`) persists it. Helper exports: `effectiveReceivableStatus`, `refreshReceivableStatuses`, `closeSubsidyLinkedReceivables`.

---

## 7. Post-sale board

`GET /post-sale/board` (ANY, scoped). `data: PostSaleBoard`: for each tab `{ total, open, overdue, by_status }` plus extras —
* `installations`: `awaiting_certificate`, `om_expiring`; *overdue* = certified, DISCOM commissioning past due.
* `discom`: `deemed_breaches`, `feasibility_overdue`, `commissioning_overdue`; `by_status` ∈ `feasibility_pending, applied, awaiting_inspection, awaiting_meter, awaiting_commissioning, commissioned`.
* `loans`: `over_threshold`; *overdue* = waiting longer than `loan.ageing_warn_days`.
* `subsidy`: `legacy_at_risk` (legacy, not submitted, within the largest reminder window), `cfa_release_overdue`; *overdue* = legacy deadline passed + CFA release overdue.
* `warranty`: `rma_overdue`.
Plus `generated_at`.

---

## 8. Distributors

Row: `Distributor` + `dealer_count`. CRUD: `GET /distributors`, `GET /distributors/:id`, `POST /distributors`, `PATCH /distributors/:id`. Read ANY (a distributor user sees only itself); write CHANNEL. Filters: `status, state, city, score, credit_days, credit_limit`; search `legal_name, trade_name, city, gstin, contact_name`; default sort `score` desc.
Body (`distributorCreateSchema`): `legal_name, state` required; `trade_name, gstin, pan, contact_name, phone, email, address, city, territory_ids[], capacity_band_min_kw, capacity_band_max_kw` (max ≥ min; defaults 0 / 100000), `capability_tags[], status` (default `onboarding`), `credit_days, credit_limit, rebate_slab_key`. `score` cannot be written directly.

* `POST /distributors/:id/score/recompute` (CHANNEL) → `DistributorScoreResult` `{ distributor_id, score, previous_score, components[], computed_at, history_id }`. **Score 0–100** = Σ weight × factor, weights from rule `distributor.score_weights` (default 30 acceptance rate, 15 on-time acceptance, 25 lead→opportunity conversion, 20 compliance record, 10 open-lead load; normalised to 100) with tuning in rule `distributor.score_params` (look-back `window_days` 90, `min_sample` 3, `conversion_full_credit_rate` 0.4, `max_open_leads` 25, compliance penalties). Components carry `{ key, label, weight, factor, points, note, insufficient_data? }`; thin history gives a neutral 0.5. Every recompute updates `distributors.score` (read by the lead router) and **appends a `distributor_score_history` row**. A new distributor is scored on creation; a nightly job recomputes all.
* `GET /distributors/:id/score-history` (ANY, scoped) → `DistributorScoreHistory[]`, newest first.

## 9. Dealers

Row: `Dealer` + hydrated `distributor_name, territory_name, open_sop_cases: SopCase[]` (stage ≠ closed — **the dealer panel**), `vendor_registrations: VendorRegistration[]`. CRUD: `GET /dealers`, `GET /dealers/:id`, `POST /dealers`, `PATCH /dealers/:id`. Read ANY (distributor user: its dealers; dealer user: itself only). Write: CHANNEL, and `distributor_user` within limits — a distributor user's new dealer is pinned to its distributorship (`status onboarding`, credit limit 0, no security) and it may edit only `legal_name, trade_name, gstin, pan, contact_name, phone, email, territory_id, city, district, state` (anything else is `403`). `portal_status`, `complaint_count` and `rebate_accrued` are system-maintained. Filters: `distributor_id, status, portal_status, territory_id, state, district, city, credit_limit, complaint_count`; search `legal_name, trade_name, city, district, gstin, contact_name`. Body (`dealerCreateSchema`): `legal_name, state` required; `distributor_id` (required for internal users), `trade_name, gstin, pan, contact_name, phone, email, territory_id, city, district, credit_limit, security_type, security_amount, status`.

* `GET /dealers/:id/scorecard` → `DealerScorecard`: `dealer_id, dealer_name, distributor_id, as_of, territory, credit { limit, outstanding, available, utilisation_pct, over_limit }, dso_days, overdue_amount, overdue_pct, ageing { current, d1_30, d31_60, d61_90, d90_plus }, invoices_open, subsidy_linked { amount, pct_of_limit, exceeds_limit }, portal_status, deactivations, complaint_count, sop_open, bank_guarantee { amount, valid_till, days_left, valid, expiring_soon, alert_days, alert }, rebate, alerts[]`. Built on `computeDealerExposure`. The BG alert window is rule `reporting.bg_expiry_alert_days` (default 60).
  * `rebate: RebateAccrual` — from rule **`channel.rebate_slabs`, which has no default**. Absent / inactive / no slab set for the dealer ⇒ `slabs_configured: false`, `accrued: 0`, `message` ("Rebate slabs are not configured …") and the alert "Rebate slabs not configured". Accepted rule shapes: an array of slabs; `{ period?: 'month'|'quarter'|'fy' (default fy), mode?: 'flat'|'marginal' (default flat), slabs: [{ from, to?, rate_pct }] }`; or an object keyed by `distributors.rebate_slab_key` (with an optional `default` key) whose values are either of those. Volume = the dealer's billed `dealer_receivables.amount` in the period.
* `POST /dealers/:id/rebate/recompute` (CHANNEL) → the accrual, and stores it in `dealers.rebate_accrued`.
* `GET /dealers/exposure` (ANY, scoped; declared before `/:id`) → `{ data: DealerExposureView[] }`, one per visible dealer, busiest first. Query `distributor_id`, `over_limit=true|false`. Fields: `dealer_id, dealer_name, distributor_id, credit_limit, outstanding, available, over_limit, utilisation_pct, ageing, overdue_amount, overdue_pct, subsidy_linked, subsidy_linked_pct_of_limit, dso_days, invoices_open, bank_guarantee, portal_status, sop_open, deactivated, blocked_reasons[]`.

## 10. Vendor registrations

Row: `VendorRegistration` + hydrated `party_name, bg_days_left, bg_warnings: BankGuaranteeWarning[]`. CRUD (no delete): `GET /vendor-registrations`, `GET /vendor-registrations/:id`, `POST`, `PATCH`. **Read: internal roles only. Write: CHANNEL+C.** Filters: `party_type, party_id, level, portal_status, bank_guarantee_valid_till, deactivated_from, deactivated_to`; search `portal_vendor_id, notes`.
Body: `party_type` (`distributor\|dealer`), `party_id`, `level` (`state\|multi_state\|national`) required on create; `portal_vendor_id, states[], districts[], bank_guarantee_amount, bank_guarantee_valid_till, portal_status` (`active\|deactivated\|under_sop`), `deactivated_from, deactivated_to, notes`. `complaint_count` is maintained by the SOP tracker.
* **Portal status** changes are audited (`vendor_registration.portal_status_change`) and **mirrored to `dealers.portal_status`** (the worst status among the dealer's registrations; audited as `dealer.portal_status_change`). Deactivating without a start date defaults it to today.
* **Bank-guarantee check** (`bg_warnings`, warning only): amount versus rules `pmsg.vendor_bg.national` / `pmsg.vendor_bg.per_state` × number of states (checked only while the rule is active; severity via `decideSeverity`); plus expired / expiring guarantees.
* `POST /vendor-registrations/scan-bank-guarantees` (CHANNEL) → `{ scanned, expiring, expired, notified }`. Same as the nightly job `channel.bank_guarantee_scan` (`scanBankGuarantees(ctx)`): notifies Accounts, DSM and Sales Manager about guarantees expiring within the alert window or already expired, repeating at most weekly (and never while an earlier alert is unread).

## 11. MNRE SOP tracker (`/sop-cases`)

Row: `SopCase` + hydrated `dealer_name, next_stages, next_due_at, days_to_next_due, overdue`. **Internal only** (the dealer's own panel shows open cases through `GET /dealers/:id`). Read ANY internal; write CHANNEL+C. It is a **tracker**: it never blocks anything; an open case only puts the dealer's portal status at `under_sop` (a warning in gate G11).

| Endpoint | Notes |
|---|---|
| `GET /sop-cases` | Filters `stage, dealer_id, vendor_registration_id, notice_at, closed_at`; search `complaint_ref, summary, outcome`. |
| `GET /sop-cases/:id` | |
| `POST /sop-cases` | Body `SopCaseCreateInput`: `dealer_id, complaint_ref` required; `vendor_registration_id?` (default: the dealer's active registration), `summary?`, `notice_at?` (default now). Stage `reply`; `reply_due_at` = notice + rule `mnre_sop.vendor_reply_days` (8 d) with a `sop_reply` clock; increments the dealer's / registration's `complaint_count`; sets `under_sop`; notifies DSM, Sales Manager, Compliance. |
| `PATCH /sop-cases/:id` | Body `summary?, complaint_ref?, outcome?`. |
| `POST /sop-cases/:id/transition` | Body `{ to, at?, outcome? }`. Allowed: `reply → reminder \| closed`, `reminder → show_cause \| closed`, `show_cause → deactivation \| closed`, `deactivation → appeal \| closed`, `appeal → closed` (else `409`, `details.allowed`). `reminder`: sets `reminder_at` and re-runs the `sop_reply` clock to notice + `mnre_sop.reminder_days` (15 d). `show_cause`: `show_cause_at`, `show_cause_due_at` = at + `mnre_sop.show_cause_days` (15 d), `sop_show_cause` clock. `deactivation`: `deactivated_at`, portal status `deactivated` with `deactivated_from` / `deactivated_to` = + `mnre_sop.deactivation_months` (1) on the registration (or the dealer if none), `appeal_due_at` = at + `mnre_sop.appeal_days` (30 d). `appeal`: records the appeal. `closed`: `closed_at`, reinstates the vendor (`active`) unless another case for the dealer is still open. Every due date comes from `rule_config`: change the rule and the dates change; **an inactive rule gives a warning and no clock/date**, an absent rule uses the default in brackets. Response: case + `warnings`. |
| `POST /sop-cases/:id/reply` | Body `{ replied_at? }`. Stops the reply / show-cause clock (stage unchanged; `409` outside the reply, reminder and show-cause stages). |

Clock breaches (`sop_reply`, `sop_show_cause`) notify the DSM / Sales Manager / Compliance (and Management for show-cause) on top of the kernel's escalation.

---

## Rule keys read (path → default when absent)

| Rule | Default | Used for |
|---|---|---|
| `discom.commissioning_days` | 15 | commissioning clock |
| `discom.feasibility_study_exempt_up_to_kw` / `discom.feasibility_study_days_above_10kw` | 10 / 15 | feasibility exemption and clock |
| `pmsg.cfa_release_days_after_discom_approval` | 15 | CFA release clock |
| `pmsg.grievance_days` | 30 | grievance clock |
| `pmsg.claim_deadline.legacy_cohort` | none (no clock without it) | legacy deadline |
| `pmsg.legacy_cohort_cutoff` | none (manual flag) — seeded unverified / inactive | cohort derivation |
| `pmsg.cfa.*`, `rwa_ghs.*` | via `computeCfa` (no default) | `cfa_computed` |
| `gujarat.state_subsidy` | none ⇒ 0 | `state_share` |
| `gujarat.pmsg_no_connectivity_agreement` | off — seeded unverified / inactive | installation flag default |
| `gerc.regulation_versions` | none ⇒ null | `regulation_version` |
| `pmsg.om_years` | 5 | `om_end` |
| `postsale.om_expiring_days` | 90 | O&M register window |
| `subsidy.legacy_reminder_days` | [14,7,3] | reminders |
| `loan.ageing_warn_days` | 15 | loan ageing clock |
| `warranty.rma_tat_days` | 21 | RMA clock |
| `mnre_sop.vendor_reply_days / reminder_days / show_cause_days / deactivation_months / appeal_days` | 8 / 15 / 15 / 1 / 30 | SOP tracker |
| `pmsg.vendor_bg.national / per_state` | none (no amount check) | BG warning |
| `reporting.bg_expiry_alert_days` | 60 | BG alert window |
| `channel.rebate_slabs` | **none — accrual 0 + flag** | rebate accrual |
| `distributor.score_weights`, `distributor.score_params` | see §8 | distributor score |

Seeded by this module in `packages/shared/src/seed/rules.postsale.ts`: `gujarat.pmsg_no_connectivity_agreement`, `pmsg.om_years`, `pmsg.legacy_cohort_cutoff`, `subsidy.legacy_reminder_days`, `loan.ageing_warn_days`, `warranty.rma_tat_days`, `postsale.om_expiring_days`, `distributor.score_weights`, `distributor.score_params`.

## Nightly jobs registered (`registerJob`)

`receivables.overdue_sweep` (01:30), `distributor.score_recompute` (02:00), `channel.bank_guarantee_scan` (02:30), `discom.deemed_feasibility_sweep` (02:15), `subsidy.legacy_claim_reminders` (03:00).
