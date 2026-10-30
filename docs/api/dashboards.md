# API — dashboards, KPIs, reports and search

Base path `/api/v1`. All endpoints need a signed-in user. Success = `{ "data": … }`, errors = `{ "error": { code, message, details } }`.
The response types below are exported from `@solar/shared` (`packages/shared/src/schemas/reports.ts`) — import them instead of re-declaring.
KPI formulas, exclusions and source tables: [`docs/KPI_DEFINITIONS.md`](../KPI_DEFINITIONS.md).

| Method + path | Roles | Purpose |
|---|---|---|
| `GET /dashboards/home` | all roles | role-aware "Today" work queue |
| `GET /dashboards/funnel` | all roles | six conversion gates, conversions by segment, Survey→Quote, Loan approval |
| `GET /dashboards/sla` | all roles | acceptance SLA, first response, follow-up compliance, breaches, escalations |
| `GET /dashboards/discom-ageing` | all roles | median / p90 days per DISCOM per stage, deemed-clock breaches |
| `GET /dashboards/cfa-pending` | all roles | CFA pending value and age, legacy claims at risk, state-share receivable |
| `GET /dashboards/dealer-exposure` | all roles | per-dealer credit exposure, totals, SOP / deactivated / over-limit / BG expiring |
| `GET /dashboards/stock-exposure` | internal roles only (external → 403) | non-List-II module stock value and units vs the exemption date |
| `GET /dashboards/compliance` | all roles | compliance-block rate, re-quote rate and leakage, RMA turnaround and recovery, open overrides |
| `GET /dashboards/consent` | all roles | consent coverage, withdrawals, suppression, DND / blocked messages |
| `GET /reports/catalog` | all roles | exportable KPI reports |
| `GET /reports/export` | all roles | xlsx export of one KPI (audited) |
| `GET /search` | all roles | grouped global search |

"All roles" = the 12 `app_role`s. **External users (`distributor_user`, `dealer_user`) only ever get their own party's numbers**; filters can narrow but never widen that scope. Internal users with `territory_ids` are limited to those territories.

## Common query (every `/dashboards/*` endpoint and `/reports/export`)

| Param | Type | Notes |
|---|---|---|
| `from` | `YYYY-MM-DD` | inclusive IST date; default = `to` − 89 days (rule `reporting.default_period_days`, 90) |
| `to` | `YYYY-MM-DD` | inclusive IST date; default = today (IST) |
| `segment` | `Segment` | one of `pmsg_residential, rwa_ghs, ci_captive, ci_net_metered, open_access, pm_kusum, government_bid` |
| `distributor_id` | uuid | |
| `dealer_id` | uuid | |

Blank values are ignored. `from` after `to`, malformed dates or an unknown segment → `422 VALIDATION_ERROR`. Point-in-time dashboards (dealer exposure, stock exposure, CFA pending) use "now" and ignore the period; the `period` field still echoes it.

## Common shapes

```ts
type KpiUnit = 'count' | 'pct' | 'inr' | 'days' | 'minutes';
interface Kpi {
  key: string;                 // stable id, also the key for /reports/export?kpi=
  label: string;
  value: number | null;        // null = no data (zero denominator / empty period); pct has 1 decimal; inr in rupees
  unit: KpiUnit;
  definition: string;          // plain-language definition — show on hover
  target?: { value: number; direction: 'at_least' | 'at_most'; rule: string; label: string; met: boolean | null };  // operating default from rule_config
  secondary?: { label: string; value: number | null; unit: KpiUnit };   // e.g. the 90th percentile next to the median
  breakdown?: { label: string; value: number | null; key?: string; [extra: string]: string | number | boolean | null | undefined }[];
  series?: { x: string; y: number | null }[];   // x = week start (YYYY-MM-DD, Monday, IST)
  links?: { label: string; path: string }[];    // front-end routes
  note?: string;               // short caveat under the tile
}
interface DashboardBase {
  generated_at: string;                                  // ISO
  period: { from: string; to: string; days: number };
  filters: { segment: Segment | null; distributor_id: string | null; dealer_id: string | null };
  kpis: Kpi[];                                           // internal-only KPIs are omitted for external users
}
interface RuleRef { path: string; value: string | number | boolean | null; status: 'verified' | 'unverified' | 'conflicting' | null; confidence: string | null; active: boolean; source: string | null; fallback_used: boolean }
```

`breakdown` extras are documented per KPI below. A `RuleRef` with `status !== 'verified'`, `active === false` or `fallback_used === true` is **advisory** — show the "unverified / verify before relying" badge.

---

## GET /dashboards/funnel → `FunnelDashboard`

```ts
interface FunnelDashboard extends DashboardBase {
  gates: { key: 'valid_lead'|'qualified_lead'|'opportunity'|'quotation'|'pi'|'sales_order'; label: string; count: number; pct_of_previous: number | null; pct_of_valid: number | null }[];   // always 6, in order
  by_segment: { segment: Segment | 'unspecified'; label: string; counts: Record<GateKey, number>;
                conversions: { inquiry_to_qualified, qualified_to_opportunity, opportunity_to_quotation, quotation_to_pi, pi_to_sales_order: number | null } }[];
}
```
KPIs (all `kpis[].key`): `funnel_gates` (value = valid leads; `breakdown` = the 6 gates with `pct_of_previous`, `pct_of_valid`), `conv_inquiry_to_qualified`, `conv_qualified_to_opportunity`, `conv_opportunity_to_quotation`, `conv_quotation_to_pi`, `conv_pi_to_sales_order` (each `breakdown` = one row per segment: `{ key: segment, label, value: pct, numerator, denominator }`), `survey_to_quote_pct` (`secondary` = surveyed leads), `loan_approval_pct` (`breakdown` per bank with `numerator`/`denominator`, `secondary` = loans applied).
Cohort = leads created in the period; see KPI_DEFINITIONS for what "reached a gate" means.

## GET /dashboards/sla → `SlaDashboard`

```ts
interface SlaDashboard extends DashboardBase {
  breaches: { clock_id; clock_type: ClockType; label: string; entity_type: string; entity_id: string; entity_label: string | null; owner_id: string | null; owner_name: string | null;
              due_at: string; age_minutes: number; age_label: string; escalated_level: number; level_label: string; status: string; path: string }[];   // open breached clocks, oldest first, max 100
  overdue_followups: { followup_id; lead_id; lead_name; kind; due_at; overdue_minutes; overdue_label; owner_id; owner_name; escalated_level; path }[];                   // most overdue first, max 100
  escalations_by_level: { level: 1|2|3; label: string; count: number }[];             // 1 DSM · 2 Sales Manager · 3 Management
  escalation_triggers: { trigger: string; clock_types: ClockType[]; count: number }[]; // the reference chart's escalation matrix
}
```
KPIs: `lead_acceptance_sla_pct` (target), `lead_acceptance_breaches`, `first_response_24h_pct` (target; `breakdown` by lead source with `numerator`/`denominator`; weekly `series`), `first_response_hot_30min_pct` (target), `first_response_median_minutes` (`secondary` = p90), `followup_compliance_pct` (target; `breakdown` by owner; weekly `series`), `overdue_followups`, `sla_breaches_open`, `escalations_open` (level ≥ 2).

## GET /dashboards/discom-ageing → `DiscomAgeingDashboard`

```ts
interface DiscomStageStats { n: number; median_days: number | null; p90_days: number | null; open: number; oldest_open_days: number | null }
interface DiscomAgeingDashboard extends DashboardBase {
  rows: { discom_id: string | null; discom_code: string | null; discom_name: string; applications: number;
          stages: Record<'feasibility'|'inspection'|'meter'|'commissioning', DiscomStageStats>; deemed_breaches: number }[];
  overall: { applications: number; stages: Record<…, DiscomStageStats>; deemed_breaches: number };
  deemed_breach_list: { application_id; application_no; discom_id; discom_name; clock: 'feasibility'|'commissioning'; due_at: string; days_over: number; sales_order_id; path }[];
}
```
KPIs: `discom_feasibility_ageing`, `discom_inspection_ageing`, `discom_meter_ageing`, `discom_commissioning_ageing` (value = overall median days, `secondary` = p90; `breakdown` per DISCOM: `{ value: median, p90, n, open, oldest_open_days }`), `discom_deemed_breaches`. Cohort = applications submitted in the period.

## GET /dashboards/cfa-pending → `CfaPendingDashboard`

```ts
interface CfaClaimRow { claim_id; sales_order_id; dealer_id; dealer_name; status; cohort; cfa_computed: number; state_share: number; discom_approval_at: string | null;
                        age_days: number | null; claim_deadline: string | null; days_to_deadline: number | null; path: string }
interface CfaPendingDashboard extends DashboardBase {
  pending: CfaClaimRow[];                                       // DISCOM-approved, not released; oldest first; max 200
  age_buckets: { label: string; count: number; value: number }[];   // 0–15 / 16–30 / 31–60 / 61–90 / Over 90 days
  legacy: { deadline: string | null; days_to_deadline: number | null; rule: RuleRef; count: number; value: number; claims: CfaClaimRow[] };  // rule pmsg.claim_deadline.legacy_cohort (fallback 2026-11-30)
  state_share: { total_receivable: number; count: number; buckets: { label: string; count: number; value: number }[] };   // Not yet due / 1–30 / 31–60 / 61–90 / Over 90 days past due
}
```
KPIs: `cfa_pending_value`, `cfa_pending_age_days` (`secondary` = p90), `cfa_release_overdue`, `legacy_claims_at_risk` (`secondary` = days to deadline), `legacy_claims_at_risk_value`, `legacy_days_to_deadline`, `state_share_receivable`.

## GET /dashboards/dealer-exposure → `DealerExposureDashboard`

```ts
interface DealerExposureRow { dealer_id; dealer_name; distributor_id; distributor_name; credit_limit; outstanding; available; utilisation_pct; over_limit: boolean;
  ageing: { current; d1_30; d31_60; d61_90; d90_plus }; overdue_amount; overdue_pct; subsidy_linked; subsidy_linked_pct_of_limit; dso_days: number | null; invoices_open;
  bank_guarantee: { amount; valid_till: string | null; days_left: number | null; valid: boolean; expiring_soon: boolean };
  portal_status: 'active' | 'deactivated' | 'under_sop'; sop_open: number; blocked_reasons: string[]; path: string }
interface DealerExposureDashboard extends DashboardBase {
  as_of: string;
  totals: { dealers; credit_limit; outstanding; overdue_amount; overdue_pct; subsidy_linked; subsidy_linked_pct_of_limit; dso_days: number | null; ageing: {…} };
  dealers: DealerExposureRow[];                                  // by outstanding, descending
  flagged: { under_sop: DealerExposureRow[]; deactivated: DealerExposureRow[]; over_limit: DealerExposureRow[]; bg_expiring: DealerExposureRow[] };
}
```
Same arithmetic as `computeDealerExposure` (the credit lane / gate G11). KPIs: `dealer_outstanding` (`secondary` = total limit; `breakdown` = ageing buckets), `dealer_overdue_pct`, `dealer_dso_days`, `subsidy_linked_exposure` (`secondary` = % of limit), `dealers_under_sop`, `dealers_deactivated`, `dealers_over_limit`, `dealer_bg_expiring` (alert threshold: rule `reporting.bg_expiry_alert_days`, 60).

## GET /dashboards/stock-exposure → `StockExposureDashboard` (internal roles)

```ts
interface StockExposureDashboard extends DashboardBase {
  exemption: { date: string | null; days_left: number | null; urgency: 'none'|'watch'|'critical'|'passed'; rule: RuleRef };   // almm.list2.exemption_net_metering_open_access_until, fallback 2026-12-31
  totals: { units; value; unpriced_units; reserved_units; skus; batches };
  by_sku:   { sku_id; make; model; variant; wattage; units; value; unpriced_units; pct_of_value: number | null; path }[];
  by_batch: { batch_id: string | null; batch_no; sku_id; sku_label; received_at; supplier; origin; units; unit_cost: number | null; value; unpriced_units }[];
}
```
`urgency`: `critical` ≤ 30 days, `watch` ≤ `reporting.stock_exposure_alert_days` (90), `passed` once the date is behind us, `none` when there is no exposed stock. KPIs: `non_list2_stock_value` (`secondary` = units), `non_list2_stock_units`, `list2_exemption_days_left`.

## GET /dashboards/compliance → `ComplianceDashboard`

```ts
interface ComplianceDashboard extends DashboardBase {
  blocked_by_gate: { gate: 'G2'|'G3'|'G4'|'G5'|'G6'; label: string; quotes: number }[];
  requotes: { quote_id; quote_no; version; status; reason: string | null; total; repriced_difference: number; leakage: number; owner_id; path }[];   // flagged quotes, largest leakage first, max 50
  open_overrides: { id; kind: 'compliance_override'|'credit_override'; entity_type; entity_id; label; requested_at; age_days; path }[];            // internal users only ([] for external)
}
```
KPIs: `compliance_block_rate_pct` (`breakdown` per gate: `{ key: 'G2', value: % of drafted quotes, quotes }`), `requote_rate_pct`, `price_change_margin_leakage` (internal only), `rma_turnaround_days` (`secondary` = p90), `rma_brand_recovery`, `rma_brand_recovery_rate_pct`, `open_overrides` (internal only).

## GET /dashboards/consent → `ConsentDashboard`

```ts
interface ConsentDashboard extends DashboardBase {
  coverage: { leads: number; covered: number; uncovered: number };
  blocked_reasons: { code: string; label: string; count: number }[];          // codes: NO_CONSENT, PURPOSE_NOT_CONSENTED, CHANNEL_NOT_CONSENTED, WITHDRAWN, SUPPRESSED_90_DAY, DND_REGISTERED, DND_UNCHECKED, DND_STALE, WHATSAPP_WINDOW_CLOSED, NO_TEMPLATE, NO_CONTACT
  uncovered_leads: { lead_id; name; created_at; path }[];                      // max 50
}
```
KPIs: `consent_coverage_pct` (target; `breakdown` by source), `consent_withdrawn`, `consent_suppressed`, `dnd_blocked_messages` (`secondary` = leads on the DND register), `blocked_messages`.

---

## GET /dashboards/home → `HomeDashboard`

Accepts the common filters (rarely used). Sections are role-aware — a section a role has no use for is **omitted**; a relevant section with nothing to do is present with `count: 0`, `items: []`.

```ts
interface HomeDashboard {
  generated_at: string;
  user: { id; name; role: AppRole; role_label: string };
  summary: { key: 'open_leads'|'hot_leads'|'pipeline_inr'|'orders_this_month'; label: string; value: number; unit: KpiUnit; path: string | null }[];
  next_best_action: { text: string; path: string; severity: 'info'|'warning'|'critical' } | null;     // always set today
  sections: HomeSection[];
}
interface HomeSection {
  key: string; title: string; description: string;
  count: number;                  // full count; `items` is the top 5
  severity: 'info' | 'warning' | 'critical';   // critical = something is overdue / blocked
  headline: string | null;        // one-liner for summary-type sections
  items: HomeItem[];
  path: string;                   // "view all"
  meta: Record<string, string | number | boolean | null>;   // always has `overdue`; plus section extras (below)
}
interface HomeItem { id; entity_type; entity_id; title; subtitle: string | null; path: string; due_at: string | null; time_left_minutes: number | null;   // negative = overdue
                     time_left_label: string | null /* "2 h left" | "30 min overdue" */; overdue: boolean; amount: number | null; badge: string | null; mine: boolean }
```

| Section `key` | Roles | Items / meta |
|---|---|---|
| `leads_awaiting_acceptance` | distributor_user, dsm, sales_manager, regional_head, management | assigned leads, soonest SLA first; `due_at` = acceptance deadline |
| `followups_due` | distributor_user, dealer_user, dsm, sales_manager, regional_head, management, techno_commercial | open follow-ups due by end of today; `meta.overdue`, `meta.due_today` |
| `approvals_waiting` | management, regional_head, sales_manager, dsm, accounts, compliance_officer, techno_commercial | only the current step for the user's role; `due_at` = approval SLA |
| `quotes_to_send` | techno_commercial, dsm, sales_manager, regional_head, management, distributor_user, dealer_user | re-quote-required first, then approved; `meta.requote_required`, `ready_to_send`, `blocked` |
| `payments_credit` | accounts, management, regional_head, sales_manager, distributor_user, dealer_user | issued PIs without an SO + pending credit checks; `meta.invoices`, `credit_checks` |
| `so_on_hold` | accounts, sales_manager, regional_head, management, dispatch, dsm, distributor_user, dealer_user, viewer | |
| `dispatch_blocked` | dispatch, compliance_officer, sales_manager, regional_head, management, distributor_user, dealer_user | `subtitle` = first hard-stop finding |
| `discom_cfa_deadlines` | dsm, sales_manager, regional_head, management, techno_commercial, accounts, distributor_user, dealer_user | DISCOM feasibility/commissioning clocks and CFA releases due within `reporting.deadline_alert_days` (3) or overdue |
| `legacy_cfa_claims` | as above + viewer | `headline` e.g. "2 legacy claims (₹ 1.44 L) not released — 35 days to 30-Nov-2026"; `meta.days_to_deadline`, `deadline`, `value`, `advisory` |
| `dealer_alerts` | accounts, sales_manager, regional_head, management, compliance_officer, dsm, distributor_user, dealer_user, viewer | deactivated / over limit / under SOP / BG ≤ 60 days; `meta.under_sop`, `deactivated`, `over_limit`, `bg_expiring` |
| `compliance_calendar` | all roles | active calendar items due within `reporting.calendar_lookahead_days` (60) |
| `stock_exposure` | management, regional_head, sales_manager, accounts, compliance_officer, dispatch, techno_commercial, viewer | `headline`; `count` = units; `meta.units`, `value`, `days_left`, `exemption_date` |
| `consent_coverage` | management, regional_head, sales_manager, dsm, compliance_officer, distributor_user, dealer_user, viewer | `headline`; `count` = leads without valid consent; `meta.coverage_pct` |

`admin` sees every section. Item `path`s come from `entityPath()`; calendar items link to `/calendar`.

---

## GET /reports/catalog

→ `ReportCatalogItem[]`: `{ key, label, dashboard, unit, definition, formula, source_tables: string[], exclusions: string[], formats: ['xlsx'], export_path }` — one entry per KPI (52). KPIs flagged internal-only (`non_list2_stock_value`, `non_list2_stock_units`, `list2_exemption_days_left`, `open_overrides`, `price_change_margin_leakage`) are not listed for `distributor_user` / `dealer_user`.

## GET /reports/export

Query: `kpi` (required, a catalogue key), `format=xlsx` (default; the only value), plus the common filters.
Response: `200` binary, `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, `Content-Disposition: attachment; filename="Future-Solar_<kpi>_<YYYYMMDD>.xlsx"`. Open it with a normal authenticated `fetch` → `blob()` (the endpoint needs the bearer token, so a plain `<a href>` will not work).
Workbook: **Summary** (navy title band `#1F3864`, gold subtitle band `#BF9000`, headline value, target, definition) · **KPI definition** (key, label, dashboard, unit, definition, formula, source tables, exclusions, target) · **Data** (the KPI's detail table; navy header row with gold underline, frozen) · **Breakdown** and **Series** when the KPI has them · **Filters applied** (period, segment, distributor, dealer, generated by/at, data scope). Dates are real Excel dates formatted `DD-MMM-YYYY` (IST), ₹ cells use Indian lakh/crore grouping.
Errors: `404` unknown KPI · `403` internal-only KPI for an external user · `422` bad `format` / filters. Every export writes an `audit_log` row `report.export`.

## GET /search?q=

Query: `q` (2–100 chars, required), `limit` (1–5, default 5 — hits per group).

```ts
interface SearchResponse { q: string; total: number; groups: { key: 'leads'|'opportunities'|'quotes'|'customers'|'dealers'|'distributors'|'skus'|'sales_orders'|'invoices'; label: string;
                           total: number /* matches in the group */; hits: { type: string; id: string; title: string; subtitle: string | null; path: string; badge: string | null; masked: boolean }[] }[] }
```
Only non-empty groups are returned, `leads` first. Searched fields: leads (name, mobile, e-mail), opportunities (name), quotes (quote no.), customers (legal/display name, GSTIN), dealers and distributors (legal/trade name, GSTIN), SKUs (make, model, variant, description), sales orders (SO no., customer PO), proforma invoices (PI no., legal name).
* **Scope-aware** — external users only find their own party's leads, opportunities, quotes, dealers, orders and PIs; `customers` and `distributors` of others are never returned (groups unreachable for the role are simply absent). SKUs are org-wide reference data and are returned to everyone.
* **Privacy** — for roles without a need to see contact details (`management`, `accounts`, `compliance_officer`, `dispatch`, `viewer`) lead hits carry a masked mobile/e-mail (`masked: true`) and a lead can only be found by mobile/e-mail with the **complete** number/address (no partial-digit probing). Roles with a need (`admin`, `sales_manager`, `regional_head`, `dsm`, `techno_commercial`, `distributor_user`, `dealer_user`) can search partial numbers.
* Customer hits link to `/customers/:id` (`entityPath` has no `customer` case).

## Rule keys read

| Rule path | Default if absent |
|---|---|
| `reporting.default_period_days` | 90 |
| `reporting.first_response_window_hours` / `reporting.first_response_hot_minutes` | 24 / 30 |
| `reporting.deadline_alert_days` | 3 |
| `reporting.legacy_claim_alert_days` | 30 |
| `reporting.bg_expiry_alert_days` | 60 |
| `reporting.stock_exposure_alert_days` | 90 |
| `reporting.calendar_lookahead_days` | 60 |
| `kpi.target.follow_up_compliance_pct` / `first_response_24h_pct` / `first_response_hot_30min_pct` / `lead_acceptance_sla_pct` / `consent_coverage_pct` | 90 / 95 / 90 / 90 / 100 |
| `pmsg.claim_deadline.legacy_cohort` | 2026-11-30 (display + countdown only) |
| `pmsg.cfa_release_days_after_discom_approval` | 15 |
| `almm.list2.exemption_net_metering_open_access_until` | 2026-12-31 (display + countdown only) |

All `reporting.*` / `kpi.target.*` defaults are seeded by `packages/shared/src/seed/rules.reporting.ts` as active, informational "Future Solar operating default" rules.
