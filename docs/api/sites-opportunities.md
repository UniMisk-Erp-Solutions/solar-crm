# API — Customers, sites, surveys, requirement capture, negotiation, opportunities (Stage 3)

Base path `/api/v1`. All endpoints need a signed-in user (`Authorization: Bearer …`). Success: `{ "data": … }`; lists: `{ "data": [], "total", "limit", "offset" }`; errors: `{ "error": { "code", "message", "details" } }`.
Shared Zod schemas live in `packages/shared/src/schemas/customers.ts` and `opportunities.ts`; row types in `rows.ts`.

**Roles.** *Read* = every role. *Write* = `admin, management, regional_head, sales_manager, dsm, techno_commercial, distributor_user, dealer_user`. *Customer write* = Write + `accounts`. *Form admin* = `admin, management, sales_manager, techno_commercial, compliance_officer`.
**Visibility.** Customers, sites, surveys, requirement forms and negotiations follow the **linked lead**; opportunities carry their own distributor / dealer / territory. A `distributor_user` / `dealer_user` only reaches their own party's data (403 on another party's id, empty lists otherwise); territory-limited staff are restricted likewise. Contact details (`phone`, `email`, lead `mobile`) are masked for roles that may not see them. Path ids that are not UUIDs return 404.
**Privacy.** No Aadhaar numbers or images. Any request field whose *name* looks like Aadhaar (except `aadhaar_last4`) → `422 AADHAAR_BLOCKED`; a Verhoeff-valid Aadhaar number in any JSON value is blocked at the edge; Aadhaar-looking file names and captions are refused. `aadhaar_last4` must be exactly 4 digits.
**Audit.** Every mutation writes an `audit_log` row (`customer.create`, `site.save`, `survey.schedule`, `lead.convert`, `opportunity.stage` …) and, where it concerns a lead, a `lead_events` timeline entry.

Common errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN`, `404 NOT_FOUND`, `409 CONFLICT | INVALID_STATE`, `422 VALIDATION_ERROR` (`details: [{ path, message }]`), `422 GUARD_BLOCKED`, `422 AADHAAR_BLOCKED`, `413`/`415` for uploads.

Hint objects (`hints`, `warnings`): `{ code, gate?: "G12"|"G5"…, severity: "info"|"warning", advisory: true, message }` — informational only, never blocking.

---

## 1. Customers

### `GET /customers`
Read. Query: `q` (legal_name, display_name, gstin, pan, phone, email), `customer_type`, `state`, `lead_id`, `limit`, `offset`, `sort` (`created_at`, `updated_at`, `customer_type`, `state`, `lead_id`), `order`. Response: `Customer[]` (phone/email masked per role).

### `GET /customers/:id`
Read. Response: `Customer & { sites: Site[], leads: { id, name, status }[] }` (only leads the caller may see).

### `POST /customers`  (Customer write) → `201`
Body (strict — unknown keys are errors): `legal_name` string 2–200 **required**; `display_name?`; `customer_type?` (`residential|housing_society|commercial|industrial|farmer|government`); `gstin?` (15-char GSTIN); `pan?` (PAN; must equal the PAN inside the GSTIN when both given); `email?`; `phone?` (any Indian format → `+91XXXXXXXXXX`); `billing_address?`, `shipping_address?` (`{ line1, line2?, city, district?, state, pincode }`); `state?`; `lead_id?` (links `leads.customer_id` when empty; **required for distributor/dealer users**); `aadhaar_last4?` (`^\d{4}$`). `""` means null.
Errors: `409 CONFLICT` duplicate GSTIN; `422` invalid GSTIN/PAN or PAN≠GSTIN (`details[0].path = "pan"`). Response: `Customer`.

### `PATCH /customers/:id`  (Customer write)
Same fields (all optional, no `lead_id`). Response `Customer`. Anonymised customers → `409 INVALID_STATE`.

---

## 2. Sites and the lead's site form

`Site` = row type in `rows.ts` (`name_on_bill, applicant_name, name_match, consumer_no, discom_id, sanctioned_load_kw, contracted_demand_kva, phase, address, pincode, city, district, state, lat, lng, roof_ownership, title_ok, pending_dues, existing_solar_kw, category, special_category_state, roof_type, load_type, bill_doc_id, customer_id, lead_id`).

**Site fields accepted by every write** (all optional): `applicant_name`, `name_on_bill` (2–200), `consumer_no` (3–30, letters/digits/`-`/`/`/space; stored upper-case), `discom_id` (uuid) **or** `discom_code` (e.g. `"UGVCL"`, case-insensitive; unknown → `422` path `discom_code`), `sanctioned_load_kw` (>0), `contracted_demand_kva` (>0), `phase` (`single|three`), `address`, `pincode`, `city`, `district`, `state`, `lat` (−90..90), `lng` (−180..180), `roof_ownership` (`owned|rented|society|leased|government`), `title_ok` boolean, `pending_dues` boolean, `existing_solar_kw` ≥0, `category` (`general|sc|st`), `special_category_state` boolean|null, `roof_type` (`rcc|metal_sheet|asbestos|tile|ground_mount|other`), `load_type`. Numbers may be sent as numeric strings. `null`/`""` clears a nullable field; omitted fields are untouched.

Derived by the server on every save:
* `name_match` — normalised, order-insensitive, forgiving comparison of `name_on_bill` and `applicant_name` (falls back to the customer's legal name); `null` until both exist. Honorifics, "Pvt Ltd", Mohd/Mohammad, initials and a missing middle name are tolerated; look-alikes (Rajesh/Ramesh) are not. Threshold: rule `site.name_match_min_score` (default 0.85). **Feeds gate G12.**
* `special_category_state` — `true`/`false` in the body is a **manual override** and wins. Otherwise (omitted or `null`), when the state changes / first save / `null` is sent, it is derived from rule `pmsg.special_category_states` **only while that rule is active** (it ships unverified + inactive: then nothing is derived and a hint `SPECIAL_CATEGORY_UNVERIFIED` is returned).
* `city/district/state` filled from the pincode table when only a pincode is sent.
* `leads.consumer_no` mirrors `consumer_no`.

### `GET /leads/:id/site`  (Read)
Response `{ lead_id, customer: Customer|null, site: Site|null, bill: { id, file_name, mime, size_bytes, created_at }|null, hints: Hint[], special_category: { state, listed: boolean|null, rule_active, rule_status, flag }|null }`.

### `PUT /leads/:id/site`  (Write) → `201` on first save, else `200`
Body: site fields above plus optional `customer: { …customer fields except lead_id }`. **Creates the customer + site on the first save** and links `leads.customer_id`, `leads.site_id` (and existing surveys / requirement forms). Everything refusable (unknown DISCOM, duplicate GSTIN, bad input) is checked **before** anything is created. Merged/duplicate/anonymised leads → `409 INVALID_STATE`.
Response `{ customer: Customer, site: Site, created: { customer: boolean, site: boolean }, hints: Hint[], special_category: { state, listed, rule_active, rule_status, flag, basis: "manual_override"|"derived"|"unchanged" } }`. Hints: `NAME_MISMATCH` (G12), `PENDING_DUES` (G12), `SPECIAL_CATEGORY_UNVERIFIED`.

### `POST /leads/:id/site/bill`  (Write, multipart) → `201`
Field `file` (JPG/PNG/WebP/PDF, ≤ `MAX_UPLOAD_MB` = 10 MB). Stored in bucket `lead-docs` (`doc_type: "electricity_bill"`), sets `sites.bill_doc_id` and `leads.bill_captured = true`; creates the customer + site if missing. Errors: `415` wrong type, `413` too large, `422 AADHAAR_BLOCKED` (file name), `400` no file (nothing is created on a refused upload).
Response `{ document: DocumentRow, site: Site, bill_captured: true }`.

### `GET /sites`  (Read)
Query: `q` (consumer_no, name_on_bill, applicant_name, city, pincode), `customer_id`, `lead_id`, `discom_id`, `state`, `name_match`, `pending_dues`, `category`, `special_category_state`, `phase`, paging/sort. Response `Site[]`.

### `GET /sites/:id`  (Read)
Response `Site & { customer: Customer|null, lead: { id, name, status, segment, capacity_kw }|null, discom: { id, code, name }|null, latest_survey: SiteSurvey|null, has_bill: boolean, hints: Hint[] }`.

### `POST /sites`  (Write) → `201`
Site fields plus `customer_id?`, `lead_id?`. With `lead_id` it behaves like `PUT /leads/:id/site` (`409` if the lead already has a site). Distributor/dealer users **must** give a `lead_id` (403 otherwise). Response as `PUT /leads/:id/site` (`customer` may be `null`).

### `PATCH /sites/:id`  (Write)
Site fields. Response `{ site: Site, hints: Hint[], special_category: {…} }`.

### `POST /sites/:id/bill`  (Write, multipart) — same as the lead variant, for a site that has a `lead_id`.
### `GET /sites/:id/bill/url`  (Read)
Response `{ url, expires_at, file_name, mime }` — signed URL valid 5 minutes; `404` if no bill.

---

## 3. Site visits and surveys (step 14)

`SiteSurvey` = row type: `status` (`scheduled|completed|cancelled`), `scheduled_at`, `surveyed_at`, `surveyor_id`, `photos: { path, lat, lng, taken_at, caption }[]`, `shading` (`none|low|medium|high`), `roof_type`, `roof_area_sqm`, `sld_ref`, `notes`, `feasibility_status` (`not_required|pending|deemed|approved|rejected`), `feasibility_application_submitted_at`, `feasibility_application_complete_at`, `feasibility_due_at`, `site_id`, `lead_id`, `opportunity_id`.

**Survey view** (returned by `GET /surveys/:id`, `POST /surveys`, `PATCH /surveys/:id`): `SiteSurvey & { photo_count, lead: { id, name, status, segment, capacity_kw, temperature, city, pincode, distributor_id, dealer_id }, site: { id, consumer_no, discom_id, sanctioned_load_kw, phase, roof_type, state, name_match, pending_dues }|null, surveyor: { id, full_name }|null, feasibility: FeasibilityView }`.

**FeasibilityView**: `{ kw, required: boolean|null, status, threshold_kw, threshold_source: "rule"|"fallback", days_allowed, days_source: "rule"|"fallback", deemed_enabled, days_rule: { path, status, confidence, active, source }|null, application_submitted_at, application_complete_at, due_at, clock: { id, status, due_at, warn_at, escalated_level }|null, message }`. `deemed_enabled:false` means rule `discom.feasibility_study_days_above_10kw` is absent/inactive: the countdown is **advisory only** and DISCOM silence will not mark the survey deemed.

### `GET /surveys`  (Read)
Query: `status`, `lead_id`, `surveyor_id`, `feasibility_status`, `site_id`, `opportunity_id`, `mine=true` (my visits), `scheduled_from`, `scheduled_to` (ISO date-time), paging, `sort` (`scheduled_at` default desc, `surveyed_at`). Rows: `SiteSurvey & { photo_count, lead_name, lead_status, lead_city, lead_pincode, capacity_kw, surveyor_name }`.

### `POST /surveys`  (Write) → `201`
Body `{ lead_id (uuid, required), scheduled_at (ISO date-time with offset, required, not in the past), surveyor_id?, notes? }`. Surveyor defaults to the caller; must be an active sales-side user (external surveyors must belong to the lead's distributor/dealer). Lead must be `accepted…opportunity` (else `409 INVALID_STATE`); a second open visit for the lead → `409 CONFLICT`. Sets the lead's `last_action`, `next_action = "Site visit"`, `next_followup_at = scheduled_at`; notifies the surveyor; reminders follow (see below). Initial `feasibility_status` = `not_required` when capacity ≤ the exempt threshold, else `pending`. Response: survey view.

### `GET /surveys/:id`  (Read) → survey view.

### `PATCH /surveys/:id`  (Write)
Body (at least one): `status` (`completed|cancelled`; `scheduled` is a no-op), `scheduled_at` (reschedule a scheduled visit), `surveyor_id` (cannot be null), `surveyed_at` (only when completing; default now, not future), `shading`, `roof_type`, `roof_area_sqm`, `sld_ref`, `notes`, `cancel_reason`.
* **Complete** (`status:"completed"`): needs `shading`, `roof_type`, `roof_area_sqm` (in the body or already saved) → else `422` with one `details` entry per missing field. Effects: `surveyed_at`; lead → `site_visit` (from accepted/contacted/qualified/nurture; an opportunity stays one); lead `last_action`, `next_action = "Share recommendation and discuss rate"`, `next_followup_at = now + survey.post_visit_followup_days` (default 2); `roof_type` mirrored onto the site; survey linked to the lead's site; feasibility need re-evaluated; lead owner notified.
* **Cancel** needs `cancel_reason` (appended to `notes`); lead `next_action = "Reschedule site visit"`.
* Completed visits stay editable (findings/notes) but cannot go back; cancelled visits are frozen (`409 INVALID_STATE`).
Response: survey view.

**Reminders.** The surveyor gets an in-app notification `survey.scheduled` on assignment and `survey.reminder.<hours>` before the visit (rule `survey.reminder_hours_before`, default `[24, 2]`; one per level, never repeated; a short-notice booking gets only the most relevant level). Run by job `site_survey_reminders` (every 15 min).

### `PATCH /surveys/:id/feasibility`  (Write)
Body (at least one): `submitted_at`, `complete_at` (ISO date-time, not in the future, `complete_at ≥ submitted_at`, `complete_at` needs `submitted_at`), `response` (`approved|rejected`, needs `submitted_at`), `responded_at?`, `note?`.
* Capacity unknown → `422 GUARD_BLOCKED` (`missing:["capacity_kw"]`). Capacity ≤ `discom.feasibility_study_exempt_up_to_kw` (fallback 10, `threshold_source` tells which) → `409 INVALID_STATE` and `feasibility_status = not_required`.
* Both dates are stored. When the application is **complete**: `feasibility_due_at = complete_at + discom.feasibility_study_days_above_10kw` (fallback 15 days when the rule is absent/inactive) and a `discom_feasibility` clock starts (clock `entity_type:"lead"`, `entity_id`: lead id, `meta.source:"site_survey"`, `meta.survey_id`). Repeating the same data does not restart it; re-filing after a decision does.
* On clock breach (`tickClocks`): rule active → survey `feasibility_status = "deemed"` (deemed feasible on DISCOM silence), timeline event `feasibility_deemed`, notification `survey.feasibility_deemed`, escalation stops. Rule inactive/absent → status stays `pending`, event `feasibility_period_elapsed` + notification `survey.feasibility_overdue` (advisory).
* `response` completes the clock and sets the status (`rejected` also notifies owner/surveyor/techno-commercial).
Response: `FeasibilityView`.

### `POST /surveys/:id/photos`  (Write, multipart) → `201`
Field **`photos`** (1–10 files per request; JPG/PNG/WebP only — PDFs are refused with 415), each ≤ 10 MB, stored in bucket `site-photos`. Optional text fields, either once (applies to all files) or repeated once per file: `lat`, `lng` (together; used only when the image has no EXIF GPS), `taken_at` (ISO), `caption` (≤200). EXIF GPS and capture time (JPEG) win over client values. At most `survey.max_photos` (default 10) per survey (`422`). The whole batch is validated before anything is stored. Errors: `415` bad type, `413` too large, `422 AADHAAR_BLOCKED` (file name or caption), `422` count/coordinates, `409` cancelled survey, `400` wrong field name.
Response `{ uploaded: { path, lat, lng, taken_at, caption, index, document_id, file_name, geo_source: "exif"|"client"|"none" }[], photo_count, max_photos }`.

### `GET /surveys/:id/photos/:index/url`  (Read)
`index` = position in `survey.photos` (0-based). Response `{ url, expires_at, photo: SurveyPhoto, index }` — signed URL, 5 minutes. `404` for an unknown index.

---

## 4. Requirement capture (step 15)

`FormFieldDef`: `{ key, label, type: "text"|"number"|"select"|"boolean"|"date"|"textarea"|"file", required, options?, help?, group? }`.

### `GET /segments/:segment/form`  (Read)
`segment` ∈ `pmsg_residential|rwa_ghs|ci_captive|ci_net_metered|open_access|pm_kusum|government_bid`. Response `{ id: string|null, segment, version, fields: FormFieldDef[], source: "config"|"default" }` — the highest `segment_form_config.version`, or the built-in form (`version 0`, `source:"default"`). The `discom_code` select is filled with the DISCOM master codes.

### `PUT /segments/:segment/form`  (Form admin)
Body `{ fields: FormFieldDef[] }` (1–80, unique lower-snake `key`s, selects need `options`, no Aadhaar keys). Publishes version + 1. Response as GET.

### `GET /leads/:id/requirement`  (Read)
Response `{ lead_id, segment: Segment|null, config: (form as above)|null, form: RequirementForm|null, data: {…}, completed: boolean, missing_required: { key, label }[], stale_keys: string[], message: string|null }`. Without a segment: `segment:null, config:null` and a message.

### `PUT /leads/:id/requirement`  (Write)
Body `{ data: { [key]: value }, complete?: boolean }`. Keys must exist in the segment's form (`422`, path `data.<key>`); values are type-checked even in drafts (numbers ≥ 0 — numeric strings accepted, booleans, `YYYY-MM-DD` dates, selects within `options`, text ≤ 500 / textarea ≤ 4000); `null`/`""` clears an answer; answers are **merged** over the saved data. `complete:true` enforces every required field (`422` listing each `data.<key>`); a completed form falls back to draft if a required answer is cleared. Lead without segment → `422 GUARD_BLOCKED`.
A form that asks for the DISCOM under the key `discom` (as the seeded segment forms do) is resolved against the DISCOM master by code or name and mirrored into `sites.discom_id`. Answers that overlap site columns (`applicant_name, name_on_bill, consumer_no, discom_code, sanctioned_load_kw, contracted_demand_kva, phase, load_type, roof_ownership, title_ok, roof_type, pending_dues, existing_solar_kw, category`) are validated with the site rules and **mirrored into the site** (created if needed). Response: the GET view `& { hints: Hint[], site: Site|null }`.

---

## 5. Rate negotiation log (step 18)

### `GET /leads/:id/negotiations`  (Read)
Response `{ rows: NegotiationLog[] (newest first), summary: { rounds, latest_quoted_rate_per_kw, latest_counter_per_kw, gap_per_kw, gap_pct, gap_total_inr, kw } }`.

### `POST /leads/:id/negotiations`  (Write) → `201`
Body: `quoted_rate_per_kw?`, `customer_counter_per_kw?` (₹/kW, >0), `notes?` — at least one. Lead must be `accepted…opportunity` (`409`). Links `opportunity_id` if the lead is converted. Response `{ row: NegotiationLog, summary }`.

---

## 6. Convert to opportunity (steps 19–20)

### `GET /leads/:id/convert-check`  (Read)
Response `{ lead_id, opportunity_id: string|null, lead_status, status_ok, can_convert, prerequisites: { key: "segment"|"capacity_kw"|"site", label, ok, hint }[], confirmations: { key, label }[], requirement_form: "none"|"draft"|"complete", missing: string[] }`.

### `POST /leads/:id/convert`  (Write) → `201` created, `200` already converted
Body (all optional): `requirement_confirmed`, `timeline_confirmed`, `commercial_potential_confirmed` (booleans, default false), `kw` (default lead capacity), `expected_commissioning_date`, `expected_close_date` (`YYYY-MM-DD`), `probability` 0–100, `expected_value`, `competitor`, `funding_mix`, `exemption_reliance`, `name`.
* **Guard:** all three confirmations must be `true`, and the lead needs a segment, a capacity and a saved site. Otherwise `422 GUARD_BLOCKED`, `details: { missing: string[], missing_confirmations: string[], missing_prerequisites: string[] }` — exactly what is missing (e.g. `["timeline_confirmed","commercial_potential_confirmed"]`, `["segment","capacity_kw","site"]`). The database trigger enforces the same rule.
* Lead status must be `accepted|contacted|qualified|site_visit|nurture|opportunity`, else `409 INVALID_STATE`.
* **Idempotent:** a lead converts once; repeating returns the existing opportunity with `200`, `already_converted:true` (even with an empty body).
* Created with: `scheme_route` derived from the segment (`pmsg_residential→pmsg, rwa_ghs→rwa_ghs, ci_captive→captive, ci_net_metered→net_metering, open_access→open_access, pm_kusum→kusum, government_bid→government_bid`); `funding_mix` = consumer 100 / loan 0 / subsidy 0 with **no loan rate**; `probability` from rule `opportunity.default_probability` by lead temperature (null temperature → warm; fallback 60/40/20); `expected_value` = kW × rule `opportunity.indicative_rate_per_kw` (fallback ₹ 50,000 — **indicative**, `expected_value_basis:"indicative"`); owner/distributor/dealer/territory copied from the lead; `regulation_version` = the last entry of rule `gerc.regulation_versions` (`[{from,label}]`) whose `from` ≤ `expected_commissioning_date` (null when the rule is absent/inactive, the date is empty or none applies); `exemption_reliance` default `true` when the segment is `ci_net_metered|open_access` and the commissioning date ≤ rule `almm.list2.exemption_net_metering_open_access_until` (false when the rule is absent/inactive or no date), overridable; stage `qualified`.
* Side effects: lead → `opportunity`; surveys, requirement form and negotiation logs get the `opportunity_id`; an `almm_exemption_commissioning` clock (entity `opportunity`) runs while exemption reliance is on and the date is ahead; timeline event `converted`; audit `lead.convert`; notification to the lead owner and techno-commercial.
Response `{ opportunity: OpportunityView, created, already_converted, expected_value_basis: "indicative"|"manual", indicative_rate_per_kw: { rate, source: "rule"|"fallback" }, warnings: Hint[] }`.

`FundingMix` (also used by PATCH): `{ consumer_pct, loan_pct, subsidy_pct (0–100, must total 100), loan_rate_pct?: number|null (0–40), loan_rate_source_date?: "YYYY-MM-DD"|null, bank?: string|null }`. `loan_rate_pct` is a **free input, never defaulted**, and requires `loan_rate_source_date` (`422`, path `funding_mix.loan_rate_source_date`). Stored with the three optional keys normalised to `null`.

---

## 7. Opportunities

`Opportunity` = row type. **OpportunityView** (flat): `Opportunity & { owner_name, lead: { id, name, mobile, email, status, temperature, city, pincode, capacity_kw, quality_score, requirement_text, timeline_bucket }|null, customer: Customer|null, site: Site|null, survey: survey view|null (completed one preferred), quotes: { id, quote_no, version, status, total, kw, validity_date, compliance_status, sent_at, accepted_at, parent_quote_id }[], quotes_summary: { count, latest_status, latest_total, accepted }, sales_orders: { id, so_no, status, total, order_date }[] (cancelled excluded), funding_mix, regulation_version_display: { label, effective_from, resolved_from_commissioning_date, rule: { path, status, confidence, active, source }|null, advisory, note }, indicative: { rate_per_kw, rate_source, value, label }, expected_value_basis: "indicative"|"manual", requirement_form: "none"|"draft"|"complete", negotiation: NegotiationSummary, next_step: { code, step: number|null, message }, warnings: Hint[] }`.
`expected_value_basis` is `"indicative"` while `expected_value` still equals kW × indicative rate. `next_step.code` ∈ `complete_site_visit, set_commissioning_date, prepare_quote, review_quote, fix_compliance, await_approval, send_quote, follow_up_quote, prepare_pi, revise_quote, order_in_progress, reopen_or_close`. Warnings: `EXEMPTION_DATE_EXCEEDED` (G5), `LOAN_RATE_MISSING`.

### `GET /opportunities`  (Read, scope-aware)
Query: `q` (name), `stage` (comma list), `segment`, `owner` / `owner_id`, `distributor` / `distributor_id`, `dealer` / `dealer_id`, `territory_id`, `scheme_route`, `exemption_reliance`, `lead_id`, `customer_id`, ranges via `kw__gte`, `probability__lte`, `expected_close_date__gte` …, paging, `sort` (`name, kw, expected_value, probability, expected_close_date, expected_commissioning_date, stage, created_at`). Rows: `Opportunity & { lead_name, lead_temperature, lead_city, owner_name }`.

### `GET /opportunities/pipeline`  (Read, scope-aware)
Query: `segment`, `owner`, `distributor`, `dealer`, `card_limit` (0–100, default 20). Response `{ currency:"INR", note, stages: { stage, count, kw, value, weighted_value, avg_probability|null, cards: { id, name, lead_id, segment, kw, expected_value, probability, expected_close_date, owner_id, distributor_id, dealer_id, exemption_reliance }[] }[] (qualified, quotation, negotiation, pi_stage, won, lost; cards largest first), totals: { open_count, open_value, open_weighted_value, open_kw, won_count, won_value, lost_count, lost_value, win_rate_pct|null } }`. `weighted = value × probability / 100` (won = full value, lost = 0).

### `GET /opportunities/:id`  (Read) → `OpportunityView`.

### `PATCH /opportunities/:id`  (Write) — step 20
Body (strict, at least one): `name`, `probability` 0–100, `kw` >0, `expected_value` ≥0 (revenue), `expected_close_date`, `expected_commissioning_date` (null clears), `competitor`, `funding_mix`, `exemption_reliance`.
* `expected_commissioning_date` **re-derives `regulation_version`** and — unless `exemption_reliance` is sent or the flag was set by hand — the exemption default.
* Changing `kw` re-computes an *indicative* `expected_value`; a typed-in revenue is never overwritten.
* Won/lost opportunities → `409 INVALID_STATE`.
Response `OpportunityView`.

### `POST /opportunities/:id/stage`  (Write)
Body `{ stage: "qualified"|"quotation"|"negotiation"|"pi_stage"|"won" }`. Free movement between open stages (same stage = no-op). `won` requires a non-cancelled sales order for the opportunity (`422 GUARD_BLOCKED`, `missing:["sales_order"]`) and sets probability 100 and the lead to `won`. `lost` → `400` (use `/lose`). From won/lost → `409`. Response `OpportunityView`.

### `POST /opportunities/:id/lose`  (Write)
Body `{ reason (3–500, required), competitor? }`. Sets stage `lost`, `lost_reason`, probability 0, lead → `lost` (with the reason), stops the exemption clock. Already lost / won → `409`. Response `OpportunityView`.

### `POST /opportunities/:id/reopen`  (Write)
Body `{ stage?: "qualified"|"quotation"|"negotiation"|"pi_stage", note? }` — default `quotation` when a quote exists, else `qualified`. Probability reset from the temperature default, `lost_reason` cleared, lead back to `opportunity`. Only lost opportunities (`409` otherwise). Response `OpportunityView`.

---

## Rule keys read (path → fallback when absent/inactive)

| Rule | Used for | Fallback |
|---|---|---|
| `discom.feasibility_study_exempt_up_to_kw` | feasibility threshold | 10 (reported as `threshold_source:"fallback"`) |
| `discom.feasibility_study_days_above_10kw` | feasibility period + deemed | 15 days, advisory only (no deemed) |
| `almm.list2.exemption_net_metering_open_access_until` | exemption-reliance default, exemption clock | no default (false) |
| `gerc.regulation_versions` | regulation version | null |
| `opportunity.indicative_rate_per_kw` (seeded 50000, unverified) | indicative expected value | 50000 |
| `opportunity.default_probability` (seeded 60/40/20, unverified) | starting probability | 60/40/20 |
| `pmsg.special_category_states` (seeded **unverified, inactive**) | special-category flag derivation | nothing derived |
| `site.name_match_min_score` | name match threshold | 0.85 |
| `survey.max_photos` / `survey.reminder_hours_before` / `survey.post_visit_followup_days` | photo cap / reminders / follow-up | 10 / `[24,2]` / 2 |

## Jobs and clock handlers registered by this module
* `site_survey_reminders` (every 15 min) and `survey_feasibility_reconcile` (every 30 min, safety net that deems overdue pending surveys while the rule is active).
* `discom_feasibility` clock handler — chained with any previously registered handler (the registry keeps one handler per clock type); survey clocks are recognised by `meta.source = "site_survey"`.
