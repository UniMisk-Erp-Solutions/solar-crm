# Platform & Admin API

Base path `/api/v1`. All routes need `Authorization: Bearer <token>` (the router set is mounted after `authenticate`). Source: `apps/api/src/routes/{platform,admin,documents,privacy}.routes.ts`. Request schemas are Zod objects in `@solar/shared` (`platform*` in `schemas/platform.ts`, `admin*` in `schemas/admin.ts`) — import them in forms.

## Conventions
* Success: `{ "data": … }`. Lists: `{ "data": [...], "total": n, "limit": n, "offset": n }`. Errors: `{ "error": { "code", "message", "details" } }` — `VALIDATION_ERROR` (422, `details: [{ path, message }]`), `FORBIDDEN` 403, `NOT_FOUND` 404, `CONFLICT` 409, `INVALID_STATE` 409, `GUARD_BLOCKED` 422, `AADHAAR_BLOCKED` 422.
* `admin` is always allowed wherever a role is listed. "internal" = every role except `distributor_user` and `dealer_user`.
* Query booleans: `true|false|1|0`. Dates `YYYY-MM-DD`; timestamps ISO-8601 UTC. Free text rejects Aadhaar numbers.
* Row types (`RuleConfig`, `Clock`, `NotificationRow`, `ComplianceCalendarItem`, `VerifyRegisterItem`, `Profile`, `Territory`, `MessageTemplate`, `ApprovalRule`, `GateApplicability`, `SourceApiKey`, `AuditLog`, `JobRun`, `DocumentRow`, `BreachIncident`, `DataRequest`) are in `packages/shared/src/rows.ts`. View types below (`Platform*`) are exported from `@solar/shared`.
* **Session timeout** is enforced in `authenticate`: in live mode a JWT older than `SESSION_TIMEOUT_MINUTES` (default 480) is refused with 401 "Your session timed out". `GET /auth/mode` and `GET /auth/me` return the value (`session.timeout_minutes`). Demo mode has no timeout.

---
## 1. Rules (rule engine)
Read: internal roles. Create / edit / activate / deactivate: `compliance_officer`, `admin`. Every change is audited (`rule.create_version`, `rule.update`, `rule.activate`, `rule.deactivate`, `rule.hard_stop_enforced`) and fires the rule-changed hook (re-quote engine).

`PlatformRuleRow` = `RuleConfig` + `{ path: "category.key", in_force: boolean, advisory: boolean }` (`in_force` = the version the engine uses today / on `date`; `advisory` = status ≠ verified or inactive).

| Method + path | Query / body | Response |
|---|---|---|
| `GET /rules` | `category?`, `status?` (verified\|unverified\|conflicting), `active?`, `q?` (category, key, notes, source), `current?` (true → only the version in force), `date?` (for `in_force`/`current`, default today), `limit?` (default 500, max 1000), `offset?` | list of `PlatformRuleRow` |
| `GET /rules/resolve` | `path` (e.g. `pmsg.cfa.max_total`), `date?` | `PlatformRuleResolution`: `{ path, date, found, rule: { id, category, key, value, status, confidence, isActive, maxSeverity, enforceHardStop, source:{name,ref}, effective_from, effective_to, notes } \| null, effect: "none"\|"inactive"\|"advisory"\|"active", max_effective_severity: "info"\|"warning"\|"hard_stop"\|null, message }` — exactly what the engine would use on that date |
| `GET /rules/history` | `path` **or** `category`+`key` | `PlatformRuleRow[]`, newest `effective_from` first |
| `GET /rules/diff` | `a`, `b` (rule ids) | `PlatformRuleDiff`: `{ a: RuleConfig, b: RuleConfig, identical, changes: [{field, a, b}], value_changes: [{path, a, b}] }` (`value_changes` = field-level diff inside JSON values) |
| `GET /rules/:id` | — | `PlatformRuleRow` |
| `POST /rules` | `path` **or** `category`+`key`; `value` (any JSON); `effective_from`; `effective_to?`; **`source_name`**, **`source_ref`** (mandatory, non-blank); `confidence` (high\|medium\|low\|hypothesis); `status`; `is_active?` (default false); `max_severity?`; `enforce_hard_stop?`; `notes?` | 201 `PlatformRuleRow`. Closes the previous open version the day before. 409 if a version already starts on `effective_from`. |
| `PATCH /rules/:id` | any of `value, effective_from, effective_to, source_name, source_ref (non-blank), confidence, status, max_severity, enforce_hard_stop, notes` | `PlatformRuleRow` |
| `POST /rules/:id/activate` | `{ enforce_hard_stop?, max_severity?, reason? }` | `PlatformRuleRow` |
| `POST /rules/:id/deactivate` | — | `PlatformRuleRow` |

**Hard-stop guard:** for a rule whose `status` is not `verified`, asking for `max_severity: "hard_stop"` (on create, patch or activate) without `enforce_hard_stop: true` → 422 `GUARD_BLOCKED`, `details.code = "HARD_STOP_NEEDS_CONFIRMATION"`. Plain activation of an unverified rule is allowed and stays advisory (warnings only).

## 2. Clocks
Read: internal roles. `PlatformClockView` = `Clock` + `{ label, entity_link, owner_name, remaining_minutes (negative when overdue), percent_used, breached }`. Breach incidents use `clock_type: "grievance"` with `entity_type: "breach_incident"` and `meta.label = "DPDP breach report (72 h)"` (`label` honours `meta.label`).

| `GET /clocks` | `entity?` (entity_type), `entity_id?`, `type?` (clock_type), `status?` (running\|met\|breached\|cancelled), `owner?` (profile id or `me`), `breached?` (true → status breached, false → not), `open?` (true → unresolved), `limit?` (25, max 200), `offset?`, `sort?` (due_at\|started_at\|status\|escalated_level\|clock_type), `order?` (default due_at asc) | list of `PlatformClockView` |
|---|---|---|
| `GET /clocks/entity/:type/:id` | — (403 if the caller cannot read the parent entity) | `PlatformClockView[]`, newest first |

## 3. Notifications (always the caller's own)
| Method + path | Query / body | Response |
|---|---|---|
| `GET /notifications` | `unread?` (true → unread only, false → read only), `severity?` (info\|success\|warning\|critical), `kind?` (prefix), `limit?` (25, max 100), `offset?` | list of `NotificationRow`, newest first |
| `GET /notifications/unread-count` | — | **`{ "data": { "count": number } }`** |
| `POST /notifications/:id/read` | — | `NotificationRow` (404 for someone else's) |
| `POST /notifications/read-all` | — | `{ "data": { "updated": number } }` |

## 4. Compliance calendar
Read: every signed-in user (the persistent strip). Write: `compliance_officer`, `admin`.

`PlatformCalendarItem` = `ComplianceCalendarItem` (`id, due_date, title, description, category, confidence, source_ref, escalate_days, rule_key, active`) + `{ days_left (IST calendar days, negative when past), countdown_label ("18 days left", "1 day left", "Due today", "Overdue by 6 days"), countdown_short ("D-18", "D-day", "D+3"), urgency ("info" >14 d, "warning" ≤14, "critical" ≤3, "overdue"), confidence_label ("High"…), is_past }`.

| Method + path | Query / body | Response |
|---|---|---|
| `GET /calendar` | `next?` (1–20: **the next N upcoming items — use `?next=3` for the strip**), `upcoming?` (hide past), `category?`, `include_inactive?` | **`{ "data": PlatformCalendarItem[] }`** (not paginated), soonest `due_date` first; default = all active items including past ones |
| `POST /calendar` | `due_date`, `title`, `description?`, `category`, `confidence`, `source_ref?`, `escalate_days?` (default from rule `calendar.default_escalate_days` = [14,7,3]), `rule_key?`, `active?` | 201 `PlatformCalendarItem` |
| `PATCH /calendar/:id` | any of the above | `PlatformCalendarItem` |
| `DELETE /calendar/:id` | — | `{ id }` |

Countdown notifications (job `calendar.countdown`, nightly): for each active item, at each `escalate_days` point (D-14, D-7, D-3) notify roles `compliance_officer`, `management`, `admin` — kind `calendar.countdown.d<N>`, severity info (>7) / warning (≤7) / critical (≤3), `entity_type: "compliance_calendar_item"`, link `/calendar`. Idempotent per item + stage (a missed night still fires the stage once).

## 5. Verify-before-relying register
| `GET /verify-register` | internal. `status?` (open\|closed), `confidence?`, `owner?`, `q?`, `limit?` (100, max 200), `offset?` | list of `VerifyRegisterItem`, open first then by `code` |
|---|---|---|
| `PATCH /verify-register/:id` | `compliance_officer`/`admin`. `owner?` (string\|null), `status?` (open\|closed), `closing_source_url?` (http(s) URL), `closed_at?` | `VerifyRegisterItem`. Closing needs a URL (422 on `closing_source_url` otherwise); `closed_at` defaults to today; reopening clears both; closing fields on an open item → 422. |

---
## 6. Admin — users (`admin` only)
`UserView` = `Profile` + `{ role_label, distributor_name, dealer_name, territory_names[], reports_to_name }`.

| Method + path | Query / body | Response |
|---|---|---|
| `GET /admin/users` | `q?` (name, e-mail, designation), `role?`, `active?`, `distributor_id?`, `dealer_id?`, `language?`, `limit?`, `offset?`, `sort?` | list of `UserView` |
| `GET /admin/users/:id` | — | `UserView` |
| `POST /admin/users` | `email`, `full_name`, `role`, `phone?`, `designation?`, `distributor_id?`, `dealer_id?`, `territory_ids?` ([]), `reports_to?`, `language?` (en\|hi\|gu), `send_invite?` (true), `password?` (only with `send_invite:false`, never stored) | 201 `UserView`. Live mode first creates the Supabase Auth user (`inviteUserByEmail`, or `createUser` when `send_invite:false`) and uses its id as `profiles.id`; demo mode generates an id. A failed profile insert deletes the Auth user again. 409 if the e-mail exists. |
| `PATCH /admin/users/:id` | any of `full_name, phone, role, designation, distributor_id, dealer_id, territory_ids, reports_to, language` (e-mail cannot change) | `UserView` |
| `POST /admin/users/:id/deactivate` | `{ reason? }` | `UserView` (live mode also bans the Auth user) |
| `POST /admin/users/:id/activate` | — | `UserView` |

Rules: `distributor_user` needs `distributor_id`; `dealer_user` needs `dealer_id` (distributor derived); internal roles must have neither. **Last-admin guard:** the last active admin can be neither demoted nor deactivated (422 `GUARD_BLOCKED`); nobody can deactivate themselves.

## 7. Admin — territories
Read: internal roles. Write: `admin`. `TerritoryView` = `Territory` + `{ discom_name, dsm_name, user_count }`.

| `GET /admin/discoms` | — | `Discom[]` |
|---|---|---|
| `GET /admin/territories` | `q?`, `state?`, `district?`, `active?`, `discom_id?`, `dsm_id?`, paging, `sort?` | list of `TerritoryView` |
| `GET /admin/territories/:id` | — | `TerritoryView` |
| `POST /admin/territories` | `name`, `state`, `district?`, `pincode_ranges?` (`[{from,to}]`, 6-digit, from ≤ to), `discom_id?`, `dsm_id?` (active internal user), `active?`, `allow_overlap?` | 201 `TerritoryView`. 409 if the name exists or a range overlaps another active territory (`details.overlapping_territories`) unless `allow_overlap:true`. |
| `PATCH /admin/territories/:id` | any field above | `TerritoryView` |
| `DELETE /admin/territories/:id` | — | `{ id }`; 409 with usage counts when leads/dealers/distributors/users reference it |
| `GET /admin/territories/:id/users` | — | `UserView[]` |
| `PUT /admin/territories/:id/users` | `{ user_ids: uuid[] }` (internal users; replaces the set; keeps `user_territories` and `profiles.territory_ids` in step) | `UserView[]` |

## 8. Admin — message templates
Read: internal. Write: `compliance_officer`, `admin`. Template family = `key` + `channel` + `language`; `version` increases on every edit.

| `GET /admin/templates` | `q?` (key, body, subject), `channel?`, `key?`, `language?`, `category?`, `purpose?`, `active?`, `latest?` (true → highest version per family), `limit?` (100, max 500), `offset?` | list of `MessageTemplate` |
|---|---|---|
| `GET /admin/templates/:id` · `GET /admin/templates/:id/history` | — | `MessageTemplate` · all versions of its family, newest first |
| `POST /admin/templates` | `key`, `channel` (whatsapp\|sms\|email\|call\|in_app), `category` (marketing\|utility\|authentication\|service), `purpose` (promotional\|service\|transactional), `language?`, `subject?`, `body`, `dlt_template_id?`, `dlt_header?`, `whatsapp_template_name?`, `active?` | 201 `MessageTemplate` (version 1). 409 if the family exists. |
| `PATCH /admin/templates/:id` | any of `category, purpose, subject, body, dlt_template_id, dlt_header, whatsapp_template_name` | **new** `MessageTemplate` row with `version + 1` (same `active` state); the old version is deactivated and untouched. 409 `details:{latest_id,latest_version}` when editing a non-latest version; an unchanged edit returns the current row. |
| `POST /admin/templates/:id/activate` · `/deactivate` | — | `MessageTemplate` (activating one version deactivates the others — rollback) |

Validation (422 `details[].path`): SMS needs `dlt_template_id` (10–20 digits) and `dlt_header` (3–11 letters/digits); WhatsApp needs `whatsapp_template_name` (`[a-z0-9_]`), promotional ⇒ category `marketing`; e-mail needs `subject`; DLT fields only on SMS; `{{ }}` must balance.

## 9. Admin — approval rules, gate applicability, work calendar, SLA
| Method + path | Roles | Body / response |
|---|---|---|
| `GET /admin/approval-rules` | admin, management, regional_head, sales_manager, accounts, compliance_officer | list of `ApprovalRule`; `q?`, `lane?`, `active?`, paging |
| `GET /admin/approval-rules/:id` | same | `ApprovalRule` |
| `POST /admin/approval-rules` · `PATCH /:id` · `DELETE /:id` | admin | `lane` (commercial\|compliance\|credit), `name`, `min_value`, `max_value?` (null = no cap, must be ≥ min), `role_chain` (1–6 internal roles), `sla_hours?` (24), `active?`, `conditions?` (JSON) → `ApprovalRule` · `{ id }` |
| `GET /admin/gate-applicability` | internal | `{ gates[14], segments[7], applicabilities[], cells: GateCellView[98], matrix: { [gate]: { [segment]: GateCellView } } }`; `GateCellView = { gate, segment, applicability, note, id \| null, defaulted }` (missing cell ⇒ `applies`, `defaulted:true`) |
| `PUT /admin/gate-applicability` | compliance_officer, admin | `{ gate, segment, applicability: applies\|not_applies\|warning, note? }` → `GateCellView` (upsert) |
| `GET /admin/work-calendar` | internal | `{ hours:{days[0=Sun..6],start,end}, holidays:[{date,name\|null}], effective:{days,start,end,holidays:string[]}, rules:{hours,holidays,holiday_names (RuleConfig\|null)}, history:{hours:RuleConfig[],holidays:RuleConfig[]} }` |
| `PUT /admin/work-calendar` | compliance_officer, admin | `{ hours?:{days,start:"HH:MM",end}, holidays?:(date \| {date,name?})[], effective_from? (default today), source_name?, source_ref (mandatory) }` → same shape as GET. Writes rules `work_calendar.hours`, `.holidays` (string[]), `.holiday_names` (date→name) through the rule service; the same `effective_from` edits that version in place. |
| `GET /admin/sla` | internal | `SlaSetting[]`: `{ key, path:"sla.<key>", value, rule_id, status, confidence, is_active, effective_from, effective_to, source_name, source_ref, notes, versions, next_version_from }` |
| `PUT /admin/sla` | compliance_officer, admin | `{ key (e.g. "lead_acceptance_minutes.hot"), value (same JSON kind as the current value, durations ≥ 0), effective_from?, source_name?, source_ref (mandatory) }` → `SlaSetting[]` (404 for an unknown key) |

## 10. Admin — audit viewer (`compliance_officer`, `admin` only)
| `GET /admin/audit` | `actor?` (profile id), `action?` (substring), `table?`, `record?` (record id), `source?` (trigger\|api), `from?`/`to?` (`YYYY-MM-DD` = IST day bounds, or ISO date-time), `q?`, `limit?` (50, max 200), `offset?` | list of `AuditView` = `AuditLog` **without** `old_data`/`new_data` + `{ actor_name, actor_role, changed_fields[] }`, newest first |
|---|---|---|
| `GET /admin/audit/:id` | `reveal?=true` | `AuditLog` + `{ actor_name, changed_fields, revealed }` with before/after snapshots; personal fields (mobile, e-mail, phone, addresses…) read `"[masked]"` unless `reveal=true`, which writes an `audit.reveal` entry |

## 11. Admin — lead-source API keys (`admin` only)
`ApiKeyView` = `SourceApiKey` without `key_hash`: `{ id, source, label, key_prefix, active, last_used_at, created_at, … }`.

| `GET /admin/api-keys` | — | `ApiKeyView[]` (never the key) |
|---|---|---|
| `POST /admin/api-keys` | `{ source, label }` | 201 `ApiKeyView & { key }` — **the plaintext `fsk_…` key is returned only here**; stored as SHA-256 hex (`key_hash`) + `key_prefix` (first 10 chars). Public lead endpoints compare `sha256(x-api-key)` with `key_hash` where `active`. |
| `POST /admin/api-keys/:id/revoke` | — | `ApiKeyView` |
| `POST /admin/api-keys/:id/rotate` | — | 201 `ApiKeyView & { key }` (new key, same source/label; old key revoked) |

## 12. Admin — jobs and demo reset
| Method + path | Roles | Response |
|---|---|---|
| `GET /admin/jobs` | compliance_officer, admin | `JobStatus[]` = `{ name, kind: "engine"\|"job", schedule (cron, Asia/Kolkata), description, last_run: JobRun\|null, last_ok_at, failures_24h }`; first item is the clock tick |
| `GET /admin/jobs/:name/runs` | same | list of `JobRun` (`started_at` desc; `sort?`, paging) |
| `POST /admin/jobs/:name/run` | same | `JobRunSummary` `{ org_id, job_name, run_id, status: "ok"\|"failed", started_at, finished_at, details, error }` — runs once for the caller's organisation; a failing job returns 200 with `status:"failed"` and is recorded |
| `POST /admin/demo/reset` | admin, demo mode only (403 otherwise) | `{ mode: "memory-reset"\|"repository-reset", tables_loaded }` — rebuilds the in-memory store from the seed |

Registered jobs: `calendar.countdown`, `privacy.retention`, `platform.data_quality` (nightly 02:00 IST), `breach.watch` (hourly), plus every job other modules register with `registerJob()`. Cron (`node-cron`, `Asia/Kolkata`): clock tick every minute, nightly group at 02:00, hourly breach watch; schedules come from rules `jobs.clock_tick_cron`, `jobs.nightly_cron`, `jobs.breach_watch_cron` (read at start-up). Each run per organisation writes a `job_runs` row (`status` running→ok\|failed, `details` incl. `trigger`, `error`).

---
## 13. Documents
Visibility = the parent entity's: `entity_type` maps to a table (lead, customer, site, survey, opportunity, quotation, proforma_invoice, sales_order, dispatch, installation, loan, discom_application, subsidy_claim, warranty_ticket, dealer, distributor, vendor_registration, sku, sop_case, breach_incident); unknown types are internal-only. Storage paths always start with `<org_id>/` (enforced on every read/delete). `DocumentView` = `DocumentRow` **without `path`** + `{ uploaded_by_name }`.

| Method + path | Roles | Request | Response |
|---|---|---|---|
| `POST /documents` | all except viewer | multipart: `file` (JPG/PNG/WebP/PDF ≤ `MAX_UPLOAD_MB`), `entity_type`, `entity_id`, `doc_type?` (default `other`), `bucket?` | 201 `DocumentView & { exif:{lat,lng,taken_at} }`. Bucket by type: site photos/surveys → `site-photos`, quotes → `quote-pdfs`, PI/SO/dispatch → `invoices`, sku/dealer/distributor/subsidy… → `compliance-docs`, else `lead-docs`. Aadhaar-looking file names → 422 `AADHAAR_BLOCKED`; wrong type 415. |
| `GET /documents` | all | `entity_type`, `entity_id`, `doc_type?`, `limit?` (100), `offset?` | list of `DocumentView` |
| `GET /documents/:id/url` | all | — | `{ url, expires_at, expires_in_seconds, file_name, mime, size_bytes }` — signed download URL, **5 minutes** (rule `documents.signed_url_seconds`, clamped 30–900); audited (`document.access`) |
| `POST /documents/upload-url` | all except viewer | `{ entity_type, entity_id, file_name, content_type, doc_type?, bucket?, size_bytes? }` | 201 `{ document: DocumentView, upload: { url, method:"PUT", expires_at, headers:{"content-type"} }, max_bytes }` — row pre-created; PUT the bytes to `upload.url` |
| `DELETE /documents/:id` | uploader, leadership roles, compliance_officer | — | `{ id }` (file removed from storage first) |

## 14. Privacy (`compliance_officer`, `admin`)
| Method + path | Request | Response |
|---|---|---|
| `POST /privacy/export` | `{ lead_id }` **or** `{ customer_id }` (exactly one), `note?` | `{ request: DataRequest (kind "export", status "completed"), export: { generated_at, generated_by, subject:{lead_ids,customer_ids}, summary:{<section>:count}, data:{ leads, consents, events, contact_logs, followups, messages (body_preview masked), customers, sites, site_surveys, requirement_forms, opportunities, negotiation_logs, quotes (+lines), proforma_invoices, sales_orders, loans, documents (metadata only) }, notes[] } }`. Duplicates/master records of the same person are included. Audited (`privacy.export`). |
| `POST /privacy/erase` | `{ lead_id, reason (≥5 chars) }` | `{ request: DataRequest (kind "erasure", completed), report: { lead_ids, customer_ids, anonymised_at, reason, counts:{…}, message_log:{total,scrubbed,retained_append_only}, retained:[{table,reason}] } }`. 409 if already erased; 422 `GUARD_BLOCKED` while the person has an open sales order (rule `privacy.erase_blocked_by_open_orders`). |
| `GET /privacy/requests` | `kind?` (export\|erasure), `status?`, paging, `sort?` | list of `DataRequest` |
| `GET /privacy/audit-unmask` | `actor?`, `record?`, `from?`, `to?` (ISO), `limit?` (50), `offset?` | list of `{ id, created_at, actor_id, actor_name, actor_role, action, table_name, record_id, detail, ip }` for audit actions containing `unmask` |

**Erasure keeps / removes:** lead → name "Erased", mobile `erased-xxxxxxxx`, e-mail/pincode/city/consumer no./requirement/notes/budget/source detail cleared, `anonymised_at` set, open leads become `lost` (reason "Erased…"); segment, kW, state/district, source, temperature, distributor stay (aggregates). Consents are withdrawn (`withdrawal_channel: "erasure"`) but the ledger rows stay. Contact-log/negotiation/follow-up notes, requirement forms, survey notes+photos, site identity/address/geo, loan co-applicant, notifications about the person are cleared; `lead-docs`/`site-photos` documents are deleted from storage. Quotes, issued PIs, orders keep amounts and GST data; customers with statutory records keep legal name/GSTIN/address but lose contact details; draft PIs and customers without statutory records are fully anonymised.

**Retention job** (`privacy.retention`, nightly): rules `retention.lead_inactive_days`, `retention.dnd_register_days`, `retention.message_body_days`, `retention.batch_size`. Seeded unverified + inactive ⇒ **report only** (`details.<part>.mode = "report"`, with `candidates`/`sample_ids`); it acts (`"apply"`) only when the rule is verified and active, or explicitly enforced. Leads in `opportunity`/`won`, with a future follow-up, or with an open order are never candidates.

## 15. Breach incidents (`compliance_officer`, `admin`)
`BreachView` = `BreachIncident` (`id, title, description, detected_at, report_due_at, status open\|reported\|closed, evidence:[{at,by,note}], reported_at`) + `{ hours_left, overdue, countdown_label, clock: Clock\|null }`. `report_due_at = detected_at + dpdp.breach_report_hours` (72 h if the rule is absent/inactive).

| Method + path | Request | Response |
|---|---|---|
| `GET /breaches` | `status?`, `overdue?`, `limit?` (50), `offset?` | list of `BreachView`, newest first |
| `POST /breaches` | `{ title, description?, detected_at? (≤ now), evidence_note? }` | 201 `BreachView`; starts the countdown clock; notifies compliance/management/admin (`breach.opened`) |
| `GET /breaches/:id` · `PATCH /breaches/:id` | `{ title?, description? }` | `BreachView` (closed incidents are read-only) |
| `POST /breaches/:id/evidence` | `{ note }` | `BreachView` (append-only log) |
| `GET /breaches/:id/notification-draft` | — | `{ subject, body, source: "template"\|"default", template_key, report_due_at, hours_left }` — uses the active e-mail template with key `breach.notification` (`{{title}}`, `{{detected_at}}`, `{{report_due_at}}`, `{{description}}`, `{{evidence}}`) when present |
| `POST /breaches/:id/report` | `{ reported_at?, reference?, note? }` | `BreachView` (open → reported, clock met, a late report is noted in the evidence) |
| `POST /breaches/:id/close` | `{ reason? }` | `BreachView` (reported → closed; open → closed only with a `reason`, i.e. assessed as not reportable) |

Hourly job `breach.watch` notifies (`breach.watch.h24`, `breach.watch.h6`, `breach.overdue`; rule `breach.watch_hours` = [24,6]) once per stage.

---
## Rule keys read by this module (default if absent)
`documents.signed_url_seconds` (300), `documents.upload_url_seconds` (600), `calendar.default_escalate_days` ([14,7,3]), `breach.watch_hours` ([24,6]), `dpdp.breach_report_hours` (72), `privacy.erase_blocked_by_open_orders` (true), `retention.*` (report-only when absent/inactive; `batch_size` 200), `data_quality.sample_size` (20), `jobs.clock_tick_cron` / `jobs.nightly_cron` / `jobs.breach_watch_cron`, `work_calendar.hours|holidays|holiday_names`, `sla.*` (edited only). Seeds: `packages/shared/src/seed/rules.platform.ts`.
