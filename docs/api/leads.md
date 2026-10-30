# Leads API — Stage 0–2 (capture, allocation, follow-up, classification)

Base URL `/api/v1`. All bodies are JSON. Success is `{ "data": … }`; lists are `{ "data": […], "total", "limit", "offset" }`; errors are
`{ "error": { "code", "message", "details" } }` (`details` is `[{ "path", "message" }]` for `VALIDATION_ERROR`, HTTP 422).
Row types (`Lead`, `LeadConsent`, `Followup`, …) are in `packages/shared/src/rows.ts`; request schemas and the view types named below
(`LeadListItem`, `LeadDetail`, …) are in `packages/shared/src/schemas/leads.ts` and are exported from `@solar/shared`.

`admin` is allowed on every authenticated endpoint. "SALES" below means `regional_head, sales_manager, dsm, techno_commercial, distributor_user, dealer_user`;
"MANAGERS" means `regional_head, sales_manager, dsm`. External users (`distributor_user`, `dealer_user`) only ever reach leads of their own party
(403 otherwise); internal users with `territory_ids` only see leads in those territories.

Mobile numbers are masked (`+91 ••••• ••210`) in every payload for roles outside `admin, sales_manager, regional_head, dsm, distributor_user, dealer_user, techno_commercial`.
`POST /leads/:id/unmask` is the audited way to see them.

## 1. Public endpoints (no session — API key)

Rate-limited (`PUBLIC_RATE_LIMIT_PER_MIN`). The key is an opaque string created in Admin (§8). It is sent as header **`X-Api-Key`**; only its SHA-256 is stored.
The key fixes the lead `source` and the organisation. `401 UNAUTHENTICATED` for a missing / unknown / inactive key, `403 FORBIDDEN` when the key's source does not fit the endpoint.
Public responses never reveal duplicates, routing or other people's data.

Wiring: `createPublicRouter(deps)` (named export, also `isPublicRouter = true`) must be mounted before authentication — `createApp(deps, { public: [createPublicRouter(deps)] })`.
The default export is a lazily-built plain Router for registries that only list Routers: call `bindPublicDeps(deps)` once at start-up.

### POST /public/leads
Website form, call-centre entry, referral entry and dealer-uploaded lead use the same payload; the key's `source` (`website | call_centre | referral | dealer_upload | …`) is stored.

| field | type | req | notes |
|---|---|---|---|
| name | string 2–120 | yes | |
| mobile | string | yes | any common format; must be a valid Indian mobile (10 digits starting 6–9); stored as E.164 `+91…` |
| email | string \| null | | validated, lower-cased |
| pincode | 6-digit string | | auto-fills city / district / state and the territory |
| city, district, state | string | | override the pincode lookup |
| segment | `pmsg_residential \| rwa_ghs \| ci_captive \| ci_net_metered \| open_access \| pm_kusum \| government_bid` | | required before a quote, not to capture |
| customer_type | `residential \| housing_society \| commercial \| industrial \| farmer \| government` | | |
| capacity_kw | number > 0 | | |
| product_interest | string[] (≤10) | | matched against distributor `capability_tags` |
| consumer_no | string | | DISCOM consumer number |
| language | `en \| hi \| gu` | | |
| requirement_text, notes | string ≤2000 | | Aadhaar numbers are refused (422 `AADHAAR_BLOCKED`) |
| bill_captured | boolean | | |
| dealer_id | uuid | **required when the key is `dealer_upload`**, ignored otherwise | locks the lead to that dealer |
| source_ref | string | | external reference; the same `(source, source_ref)` never creates a second lead (HTTP 200 returns the first) |
| consent | `{ notice_version, purposes[], channels[], proof_ref?, capture_source? }` | | purposes ⊂ `service, promotional, quotation, subsidy_processing, financing`; channels ⊂ `call, sms, whatsapp, email`. Written to the immutable ledger with IP, user agent and the legal names of Future Solar + the routed distributor/dealer. `proof_ref` defaults to `<source>:<requestId>`. Without `consent` the lead is captured but nothing promotional may be sent. |
| provenance | `{ utm_source, utm_medium, utm_campaign, utm_term, utm_content, campaign, referrer, landing_url, referrer_name, device }` | | stored in `leads.source_detail` with ip / user_agent |

Response `201` (`200` for an idempotent retry): `{ data: { lead_id, reference, received: true, consent_recorded } }`.
Errors: 422 `VALIDATION_ERROR` (`details[].path` = `mobile`, `email`, …), 422 `AADHAAR_BLOCKED`.

Pipeline: validate → pincode lookup → duplicate check (exact mobile / e-mail / consumer number, fuzzy name + pincode ≥ 0.6, existing customers) → DND scrub (`dnd_register` upsert, `leads.dnd_status`, `dnd_checked_at`) →
duplicate: status `duplicate`, `duplicate_of`, held for a manager (and `lock_status='override_pending'` when the original is locked by a different dealer) · otherwise `validated` → routing → `assigned` (acceptance clock started) or `unassigned` (DSM notified) → consent row → score.

### POST /webhooks/campaign
Key source must be `campaign`. The key may also be sent as `?key=` or, for Google Ads lead forms, in the payload's `google_key`.
Accepts Meta Lead Ads (`field_data` single, `entry[].changes[].value`, or arrays under `leads` / `data`) and Google Ads (`user_column_data`) payloads. Fields are mapped by name
(`full_name`, `phone_number`, `email`, `zip_code`/`postal_code`, a `…kw…` / `capacity` question, `property_type` → `customer_type`, `message`). Consent is recorded **only** when the form carried an explicit consent answer (e.g. `i_agree…: Yes`).
Idempotent on `leadgen_id` (Meta) / `lead_id` (Google) → `source_ref = meta:<id> | google:<id>`. Google `is_test: true` leads are acknowledged and ignored.
Response `200`: `{ data: { received, results: [{ index, status: 'created' | 'duplicate' | 'existing' | 'ignored_test' | 'rejected', lead_id, reason? }] } }`. 422 when no lead is found in the payload.

### GET /webhooks/whatsapp
Meta verification. `?hub.mode=subscribe&hub.verify_token=<a whatsapp API key>&hub.challenge=<n>` → `200 text/plain` `<n>`; otherwise `403`. (The verify token **is** the API key of a `whatsapp` source.)

### POST /webhooks/whatsapp
Key source `whatsapp` (header `X-Api-Key` or `?key=`). Payload is parsed by `ctx.providers.whatsapp.parseInbound`.
Each inbound message is written to `message_log` (direction `inbound`), attached to the lead with that mobile and **opens the 24-hour reply window**.
An unknown number creates a `whatsapp` lead (no consent; goes to the DSM when it cannot be routed). `STOP`, `UNSUBSCRIBE`, `OPT OUT`, `CANCEL` are a **full opt-out** (§6) and do not open the window.
A subscribe keyword (`START`) is logged and the owner is told to capture consent with proof. Messages containing an Aadhaar number are stored as "[withheld…]".
Response `200`: `{ data: { received, attached, leads_created, optouts, ignored } }`.

### GET /public/consent-notice?lang=en|hi|gu
Any key. Latest active `message_templates` row with `key = 'consent_notice'` in the language (English fallback), else the built-in text.
`{ data: { notice_version: 'v<template version>' | 'default-v1', language, body, source: 'template' | 'default', purposes: [{value,label}], channels: [{value,label}], recipients: [legal name], withdrawal } }`.
Send the returned `notice_version` back inside `consent`.

### GET /public/pincode/:pin
Any key. `{ data: { pincode, city, district, state, serviceable } }` — local `pincodes` table first, then the pincode provider; `serviceable` = a territory covers it. 404 unknown, 422 malformed.

### GET /public/unsubscribe?token=… · POST /public/unsubscribe
No key — the HMAC-signed `token` (from `{{unsubscribe_url}}` in outbound templates; helper `unsubscribeToken(leadId)`; set `UNSUBSCRIBE_TOKEN_SECRET` in production) is the credential.
`GET` → `{ data: { valid: true, mobile_masked } }`. `POST { token }` → full opt-out → `{ data: { unsubscribed: true, suppress_until } }`. Bad token 400.
The web page is expected at `<first CORS origin>/unsubscribe?token=…` and calls these two endpoints.

## 2. Lead list, detail, create, edit

### GET /leads — all roles (scoped)
Query: `status` (comma list), `source`, `segment`, `temperature`, `owner_id`, `distributor_id`, `dealer_id`, `territory_id`, `lock_status`, `dnd_status`, `customer_type`, `duplicate_of`
(each `a,b` = any of), range filters `created_at__gte|lte`, `next_followup_at__gte|lte|gt|lt`, `quality_score__gte|lte`, `q` (name, mobile, e-mail, city, pincode, consumer no., source ref),
`sla_state=breached|due_soon|ok` (from the lead's unresolved acceptance / follow-up clocks), `followup_overdue=true` (next follow-up passed, open statuses),
`sort` (`created_at, updated_at, next_followup_at, quality_score, sla_due_at, name, last_action_at, status, temperature`), `order=asc|desc`, `limit` (≤200, default 25), `offset`.
Response: `LeadListItem[]` = `Lead` + `owner_name, distributor_name, dealer_name, sla_state, followup_overdue`, mobile/e-mail masked where required.

`GET /leads?view=kanban[&per_column=25&…same filters]` → `{ data: LeadKanbanView }` = `{ columns: [{ status, label, count, items: LeadListItem[] }], total }`
in the order `new, unassigned, assigned, accepted, contacted, qualified, site_visit, nurture` (`LEAD_KANBAN_COLUMNS`); items ordered by next follow-up.

### POST /leads — SALES
Internal manual lead form. Same fields as `/public/leads` plus `source` (default `manual`), `distributor_id`, `dealer_id`, `owner_id`; `consent` here **requires `proof_ref`**.
Staff (`regional_head, sales_manager, dsm, techno_commercial`) → routed by the engine (or straight to a named `distributor_id`). `distributor_user` → the lead belongs to their distributor (optionally one of their `dealer_id`s), owned by and **accepted by** the creator.
`dealer_user` → `source` forced to `dealer_upload`, dealer = theirs, accepted by the creator.
`201` (`200` if `source_ref` was seen): `{ data: { lead: LeadListItem, created, duplicate_of, lock_conflict, assigned, consent_id, duplicates: LeadDuplicateReport, hints: [{field,message}] } }`.
`hints` carries the validation hints (segment is required before any quote — never a hard block on capture).

### GET /leads/:id — all roles (own scope)
`{ data: LeadDetail }`:
`lead` (+ `owner_name, distributor_name, dealer_name, territory_name`), `events` (newest first), `consents`, `consent_summary`, `assignments`, `followups`, `contact_logs`, `score` (latest `LeadScore` or null),
`clocks` (unresolved), `duplicates` (`{ leads[], customers[], checked_at, hidden? }` — live matches; external users only see matches they may read, `hidden` counts the rest),
`customer_id`, `site_id`, `opportunity_ids`, `next_best_action` (`{ code, label, due_at, urgent }`; codes `followup_overdue, route, review_duplicate, assign, accept, contact, qualify, site_visit, requirement, reengage, opportunity, recycle, none`),
`convert_blockers` (`[{ code, message }]`: `status_not_ready, segment_missing, capacity_missing, consent_missing, requirement_unconfirmed, timeline_unconfirmed, commercial_potential_unconfirmed`), `can_convert`,
`validation_hints`, `first_response_minutes` (created → first outbound contact), `qualification_gaps`.
For external users assignment `score_snapshot`s and the routing ranking inside events are removed.
(`POST /leads/:id/convert` belongs to the opportunities module.)

`consent_summary`: `{ has_active, withdrawn, purposes[], channels[], suppress_until, suppressed, dnd_status, dnd_checked_at, dnd_fresh, whatsapp_window_open, whatsapp_window_closes_at, outbound: { whatsapp|sms|email|call: { promotional: boolean, service: boolean } } }`.

### PATCH /leads/:id — SALES
Body (all optional, at least one): `name, email, pincode, city, district, state, segment, customer_type, capacity_kw, product_interest, consumer_no, language, requirement_text, notes, timeline_bucket, budget_inr, decision_maker, decision_maker_access, bill_captured, last_action, next_action, next_followup_at, owner_id`.
`mobile` cannot be changed. **`last_action`, `next_action`, `next_followup_at` and `owner_id` can be edited but never emptied, and the saved lead must have all four** — otherwise `422 VALIDATION_ERROR` with `details: [{ path: 'next_action', message: 'Next action is required on every lead' }, …]`.
Changing `next_followup_at` moves the earliest open follow-up and its clock (must be in the future and ≤ `followup.max_days_ahead` days ahead). `owner_id` must be an active user (external users: of their own distributor). Re-scores when a scoring field changes. Returns `LeadListItem`.

### GET /leads/:id/timeline?limit=50&offset=0
Merged newest-first feed: `{ data: LeadTimelineItem[], total, limit, offset }`, `LeadTimelineItem = { at, kind: 'event' | 'contact' | 'message' | 'followup', type, summary, actor_id, detail }`.

### POST /leads/:id/unmask — management, regional_head, sales_manager, dsm, techno_commercial, accounts, compliance_officer, dispatch, distributor_user, dealer_user
Body `{ reason: string ≥5 }` → `{ data: { mobile, email } }`. Writes `audit_log` `mobile.unmask` and a `mobile_unmasked` lead event.

## 3. Stage 1 — acceptance loop

### POST /leads/:id/accept — dsm, sales_manager, regional_head, distributor_user, dealer_user
Body `{ note? }`. Lead must be `assigned` (409 otherwise). Assignment → `accepted`, `lead_acceptance` clock completed (`met`, or stays `breached` if late), status `accepted`, `accepted_at`, owner = the accepting external user, first follow-up planned. Returns `LeadListItem`.

### POST /leads/:id/reject — same roles
Body `{ reason: string ≥3 }`. Assignment → `rejected`; the lead is **re-routed to the next best distributor** (excluding everyone who rejected / expired / was replaced); when none is left it becomes `unassigned` and the DSM is notified.
Returns `{ lead, reassigned }` (`lead` is `{ id, status }` for external callers, who lose access).

### POST /leads/:id/reassign — MANAGERS
Body `{ distributor_id? , dealer_id?, owner_id?, auto?, reason }` (either `distributor_id` or `auto: true`). Lead status must be `validated, unassigned, assigned or accepted` (409 otherwise). Inactive distributor → 422. Creates a `manual` assignment, closes the previous one (`reassigned`), restarts the acceptance clock. Returns `LeadListItem`.

Clock behaviour (kernel `tickClocks` + handlers registered by this module): at 70 % → **Reminder 1** (`lead.acceptance.reminder1`, in-app + e-mail to the assignee, event `acceptance_reminder`); at 100 % → **DSM alert** (`lead.acceptance.dsm_alert`, event `acceptance_breached`);
at escalation level 2 → **auto-reassignment** (event `acceptance_expired`, `auto_reassigned`; new `reassignment` assignment + new clock, or `unassigned` + `lead.unassigned` to the DSM). SLA: hot `sla.lead_acceptance_minutes.hot` working minutes, warm `…warm`, cold end of the working day.

### POST /leads/:id/lock-override — MANAGERS, distributor_user, dealer_user
Body `{ reason }`. Lead must be `duplicate`; sets `lock_status='override_pending'`, notifies Sales Managers / DSM. Returns `LeadListItem`.

### POST /leads/:id/lock-override/decide — sales_manager, regional_head
Body `{ decision: 'approve' | 'reject', note? }`. **approve** → independent lead (`duplicate_of` cleared, `status validated`, routed like a new lead → `assigned`/`unassigned`). **reject** → stays `duplicate`, `lock_status='locked'`. Returns `LeadListItem`.

### POST /leads/:id/merge — MANAGERS
Body `{ into_lead_id, note? }`. Source → `merged` (`duplicate_of` = target, follow-ups and clocks closed); the target gets missing details and copies of the source's active consents. Returns `{ source, target }` (`LeadListItem`). 409 for self-merge / already merged.

## 4. Stage 2 — contact, qualification, score, follow-ups

### POST /leads/:id/contacts — SALES
Body `{ channel: call|whatsapp|visit|sms|email, direction?: outbound|inbound (default outbound), outcome, notes?, duration_min?, occurred_at? (not future), next_action?, next_followup_at? }`.
`outcome` ∈ `connected_interested, connected_not_now, connected_not_interested, no_answer, busy_call_back, wrong_number, message_delivered, message_replied, visit_done, visit_rescheduled` (labels: `CONTACT_OUTCOME_LABEL`).
An `assigned` lead is accepted implicitly. Sets `first_contacted_at` once (first outbound contact — the first-response KPI), `last_action`; a connected outcome moves `accepted`/`nurture` → `contacted`. The earliest follow-up that is due (≤24 h) is marked done; the next action/date default from the outcome (retry after `followup.retry_minutes` working minutes for no answer, otherwise `sla.followup_days.<temperature>`).
`201 { data: { contact: ContactLog, lead: LeadListItem } }`. 409 if the lead is not yet routed / is a duplicate.

### GET /leads/:id/contacts → `ContactLog[]` (newest first)

### POST /leads/:id/qualification — SALES
Body: `requirement_text` (required), `timeline_bucket` (required: `immediate, within_30_days, one_to_three_months, three_to_six_months, six_months_plus, unknown`), `decision_maker` (required: `self, family, committee, unknown`), optional `budget_inr, decision_maker_access, capacity_kw, segment, customer_type, product_interest, bill_captured, notes, next_action, next_followup_at`.
Derives **temperature** (+ deadline uplift) and the **quality score** (components stored in `lead_scores`), sets status `qualified` when `lead.qualification_required_fields` are known (else `contacted`), and plans the next follow-up.
`200 { data: { lead, gaps: string[], qualified, score, temperature, deadline_uplift } }`.

### GET /leads/:id/score · POST /leads/:id/score/recompute (SALES, compliance_officer)
`LeadScoreView = { score, components: [{ key, label, weight, points, note }], computed_at, temperature, deadline_uplift, history: [{ score, computed_at }] }`. Component keys: `requirement_clarity, mw_size, timeline, budget, decision_maker, consent_present, bill_captured` (Appendix A of the brief).

### POST /leads/:id/followups — SALES
Body `{ kind?: call|whatsapp|visit|email|task, due_at (future), note }` (`note` = the next action). `201 { data: { followup, lead } }`. The lead's `next_action` / `next_followup_at` always show the earliest open follow-up; a `followup` clock runs to it.

### GET /leads/:id/followups → `Followup[]` (latest due first)

### POST /followups/:id/complete — SALES
Body `{ outcome, next_action, next_followup_at (future), next_kind?, last_action? }` — **next action and date are mandatory**. Works on `open` and `missed` follow-ups (a late completion keeps the clock `breached` for the KPI). `200 { data: { followup, next, lead } }`. 409 if already done.

### GET /followups — all roles
My work-list. Query `bucket=due_today|overdue|upcoming|all` (default all), `scope=mine|team` (default mine; team = every lead the user may see), `status`, `limit` (≤200, default 50), `offset`.
`{ data: FollowupListItem[] (Followup + lead_name, lead_status, lead_temperature, lead_mobile (masked where required), overdue), total, limit, offset }` ordered by due time.
Follow-up clock: warn at 70 % → `followup.reminder` (in-app + e-mail to the owner); breach → follow-up `missed`, `followup.missed`, escalation owner → DSM → Sales Manager → Management (kernel notifications `clock.followup.*`).

## 5. Nurture and lost

### POST /leads/:id/nurture — SALES
Body `{ reason, nurture_until: 'YYYY-MM-DD' }` (tomorrow … 730 days). Allowed from `accepted, contacted, qualified, site_visit, lost, nurture`. Status `nurture`, follow-up at 10:00 IST on that day. The nightly job `lead.nurture_reactivation` (02:15 IST) moves due leads back to `contacted`, plans a follow-up and notifies the owner (`lead.nurture_due`). Returns `LeadListItem`.

### POST /leads/:id/lost — SALES
Body `{ reason }`. Status `lost`, `lost_reason`, follow-ups and clocks closed, ownership lock released. 409 from `lost, won, opportunity, merged, duplicate`. Returns `LeadListItem`.

## 6. Consent ledger, DND and messages

### GET /leads/:id/consents → `{ consents: LeadConsent[], summary: LeadConsentSummary }`

### POST /leads/:id/consents — SALES, compliance_officer
Body `{ notice_version, purposes[], channels[], proof_ref (required), capture_source?, recipients_named?, granted_at? }`. `recipients_named` always includes Future Solar and the current distributor / dealer legal names. `201 { data: { consent, summary } }`. Recording a consent during an opt-out bar does **not** lift the bar.

### POST /leads/:id/consents/withdraw — SALES, compliance_officer  (one click)
Body `{ channel?: 'ui'|'call'|'whatsapp'|'sms'|'email'|'unsubscribe_link'|'in_person', reason? }`. Sets `withdrawn_at` on every active consent, `optout_suppress_until = now + trai.optout_reconsent_block_days` (90) on the ledger, applies the same to every other lead with the same mobile, notifies the named distributor / dealer users and lead owners (`consent.withdrawn`), writes `lead_events` + `audit_log`.
`{ data: { withdrawn, suppress_until, propagated_lead_ids, recipients, notified, summary } }`. Opt-out by WhatsApp keyword and by the unsubscribe link do exactly the same. A new enquiry from a suppressed number inherits the bar.

### POST /leads/:id/dnd-scrub — SALES, compliance_officer
Forces a new scrub: `{ data: { status: 'clear'|'registered'|'blocked'|'unchecked', checked_at, source, cached } }`; updates `dnd_register` (hashed) and the lead.

### GET /leads/:id/messages → `MessageLog[]` (newest first; blocked attempts included)

### POST /leads/:id/messages — SALES
Body `{ channel: whatsapp|sms|email|call, purpose: promotional|service|transactional, template_key?, body?, subject?, vars?, refresh_dnd? }` (template or body required except `call`).
Goes through `ctx.svc.messaging.send` (gate G1): promotional needs a non-withdrawn consent for purpose + channel, DND `clear` and scrubbed within `compliance.dnd_scrub_max_age_days` (call / SMS / WhatsApp only), no opt-out bar. Service / transactional need a service-or-quotation consent for the channel, or an open WhatsApp window.
WhatsApp: free text only inside the 24-hour window, otherwise an approved template (marketing category for promotional, never for service). SMS: a template with `dlt_template_id` and `dlt_header`. Calls are logged only.
Success `201 { data: { status: 'sent'|'queued', blocked: false, reasons: [], message_log_id, template_category } }` (`502` with the same shape when the provider failed).
**Blocked** → `422 CONSENT_BLOCKED`, `details: { reasons: [{ code, message }], message_log_id, status: 'blocked' }`; codes `NO_CONSENT, PURPOSE_NOT_CONSENTED, CHANNEL_NOT_CONSENTED, WITHDRAWN, SUPPRESSED_90_DAY, DND_REGISTERED, DND_UNCHECKED, DND_STALE, WHATSAPP_WINDOW_CLOSED, NO_TEMPLATE, NO_CONTACT`. The owner is notified (`message.blocked`).
Templates may use `{{name}}` and `{{unsubscribe_url}}`.

## 7. Events, notifications

`lead_events.event_type` values written by this module (plus the trigger's `status_changed`): `captured, dnd_scrubbed, duplicate_detected, existing_customer_match, assigned, unassigned, accepted, rejected, acceptance_reminder, acceptance_breached, acceptance_expired, auto_reassigned, consent_recorded, consent_withdrawn, consent_suppression_propagated, consent_suppression_inherited, scored, contact_logged, qualified, qualification_updated, followup_scheduled, followup_rescheduled, followup_completed, followup_reminder, followup_missed, followup_escalated, nurture, nurture_reactivated, lost, merged, merged_in, updated, mobile_unmasked, lock_override_requested, lock_override_approved, lock_override_rejected, whatsapp_inbound, whatsapp_optin_keyword`.
Notification `kind`s: `lead.assigned, lead.unassigned, lead.rejected, lead.acceptance.reminder1, lead.acceptance.dsm_alert, lead.duplicate, lead.lock_override_requested, lead.lock_override_rejected, lead.whatsapp_inbound, lead.nurture_due, lead.note, followup.reminder, followup.missed, consent.withdrawn, message.blocked`.

## 8. API keys for the public endpoints — admin only

* `GET /lead-source-keys` → `[{ id, source, label, key_prefix, active, last_used_at, created_at }]`
* `POST /lead-source-keys` `{ source, label }` → `201` the same plus **`key`** (shown once: `fs_<source>_<48 hex>`).
* `PATCH /lead-source-keys/:id` `{ active?, label? }`.

## 9. Rules read (path → default when absent or inactive)

`sla.lead_acceptance_minutes.hot` 30 · `.warm` 120 · cold = end of working day · `sla.followup_days.hot|warm|cold` 1|3|7 · `sla.escalation_step_minutes` 240 (kernel) · `work_calendar.hours|days|start|end|holidays` (Mon–Sat 09:30–18:30) ·
`scoring.weights` (Appendix A) · `temperature.deadline_uplift_days` 60 · `pmsg.claim_deadline.legacy_cohort` · `almm.list2.exemption_net_metering_open_access_until` · `compliance.dnd_scrub_max_age_days` 30 · `trai.optout_reconsent_block_days` 90 · `whatsapp.service_window_hours` 24 ·
`routing.score_weights` {score .6, load .2, band_fit .2} · `routing.load_reference_leads` 20 · `routing.max_auto_reassignments` 3 · `lead.dedupe_similarity_threshold` 0.6 · `lead.qualification_required_fields` [requirement_text, timeline_bucket, decision_maker, capacity_kw] ·
`followup.email_reminders` true · `followup.retry_minutes` 240 · `followup.max_days_ahead` 180. Operational defaults are in `packages/shared/src/seed/rules.leads.ts`.
