/**
 * Zod schemas for dashboards, KPIs, search and report exports — plus the exact response types of
 * `/dashboards/*`, `/reports/*` and `/search` so the web app codes against the same contract as the API.
 * Documented in docs/api/dashboards.md; KPI formulas in docs/KPI_DEFINITIONS.md.
 */
import { z } from 'zod';
import { SEGMENTS, type AppRole, type ClockType, type Segment } from '../enums';

/* ───────────────────────── request schemas ───────────────────────── */

const blankToUndefined = (v: unknown): unknown => (v === '' || v === null ? undefined : v);
const dateOnly = z.preprocess(blankToUndefined, z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD').optional());
const optionalUuid = z.preprocess(blankToUndefined, z.string().uuid().optional());

const filterShape = {
  /** first day of the period, IST (default: 90 days before `to`) */
  from: dateOnly,
  /** last day of the period, IST (default: today) */
  to: dateOnly,
  segment: z.preprocess(blankToUndefined, z.enum(SEGMENTS).optional()),
  distributor_id: optionalUuid,
  dealer_id: optionalUuid,
};
const fromBeforeTo = (v: { from?: string; to?: string }) => !v.from || !v.to || v.from <= v.to;
const fromBeforeToMsg = { message: '"from" must not be after "to"', path: ['from'] };

/** Query accepted by every `/dashboards/*` endpoint. */
export const dashboardFilterSchema = z.object(filterShape).refine(fromBeforeTo, fromBeforeToMsg);
export type DashboardFilterInput = z.infer<typeof dashboardFilterSchema>;

/** `GET /reports/export?kpi=<key>&format=xlsx&…filters` */
export const reportExportQuerySchema = z
  .object({ ...filterShape, kpi: z.string().trim().min(1).max(80), format: z.enum(['xlsx']).default('xlsx') })
  .refine(fromBeforeTo, fromBeforeToMsg);
export type ReportExportQuery = z.infer<typeof reportExportQuerySchema>;

/** `GET /search?q=` */
export const searchQuerySchema = z.object({
  q: z.string().trim().min(2, 'Type at least 2 characters').max(100),
  /** hits per group (max 5) */
  limit: z.coerce.number().int().min(1).max(5).default(5),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;

/* ───────────────────────── common KPI shapes ───────────────────────── */

export const KPI_UNITS = ['count', 'pct', 'inr', 'days', 'minutes'] as const;
export type KpiUnit = (typeof KPI_UNITS)[number];

export type KpiExtra = string | number | boolean | null | undefined;
/** One row of a KPI breakdown. `value` is in the KPI's unit; any other keys are per-row extras (numerator, p90, …). */
export interface KpiBreakdownItem { label: string; value: number | null; key?: string; [extra: string]: KpiExtra }
export interface KpiSeriesPoint { x: string; y: number | null }
export interface KpiLink { label: string; path: string }
export interface KpiTarget {
  value: number;
  /** `at_least` = the KPI should be ≥ value, `at_most` = ≤ value */
  direction: 'at_least' | 'at_most';
  /** rule path the target comes from, e.g. kpi.target.follow_up_compliance_pct */
  rule: string;
  label: string;
  /** null when the KPI has no value yet */
  met: boolean | null;
}

export interface Kpi {
  key: string;
  label: string;
  value: number | null;
  unit: KpiUnit;
  /** plain-language definition — shown on hover */
  definition: string;
  target?: KpiTarget;
  /** a second headline number in the same tile, e.g. the 90th percentile next to the median */
  secondary?: { label: string; value: number | null; unit: KpiUnit };
  breakdown?: KpiBreakdownItem[];
  series?: KpiSeriesPoint[];
  links?: KpiLink[];
  /** short caveat shown under the tile (e.g. "no DISCOM applications in the period") */
  note?: string;
}

export interface DashboardFilters { segment: Segment | null; distributor_id: string | null; dealer_id: string | null }
export interface DashboardBase {
  generated_at: string;
  /** inclusive IST calendar dates; `days` = number of days covered */
  period: { from: string; to: string; days: number };
  filters: DashboardFilters;
  kpis: Kpi[];
}

export interface RuleRef { path: string; value: string | number | boolean | null; status: string | null; confidence: string | null; active: boolean; source: string | null; fallback_used: boolean }

/* ───────────────────────── /dashboards/funnel ───────────────────────── */

export const FUNNEL_GATE_KEYS = ['valid_lead', 'qualified_lead', 'opportunity', 'quotation', 'pi', 'sales_order'] as const;
export type FunnelGateKey = (typeof FUNNEL_GATE_KEYS)[number];
export type SegmentOrUnspecified = Segment | 'unspecified';
export interface FunnelGate { key: FunnelGateKey; label: string; count: number; pct_of_previous: number | null; pct_of_valid: number | null }
export interface FunnelConversions {
  inquiry_to_qualified: number | null; qualified_to_opportunity: number | null; opportunity_to_quotation: number | null; quotation_to_pi: number | null; pi_to_sales_order: number | null;
}
export interface FunnelSegmentRow { segment: SegmentOrUnspecified; label: string; counts: Record<FunnelGateKey, number>; conversions: FunnelConversions }
export interface FunnelDashboard extends DashboardBase {
  /** the six conversion gates, cohort = leads created in the period */
  gates: FunnelGate[];
  by_segment: FunnelSegmentRow[];
}

/* ───────────────────────── /dashboards/sla ───────────────────────── */

export interface SlaBreachRow {
  clock_id: string; clock_type: ClockType; label: string; entity_type: string; entity_id: string; entity_label: string | null;
  owner_id: string | null; owner_name: string | null; due_at: string; age_minutes: number; age_label: string; escalated_level: number; level_label: string; status: string; path: string;
}
export interface OverdueFollowupRow {
  followup_id: string; lead_id: string; lead_name: string; kind: string; due_at: string; overdue_minutes: number; overdue_label: string;
  owner_id: string | null; owner_name: string | null; escalated_level: number; path: string;
}
export interface EscalationLevelRow { level: 1 | 2 | 3; label: string; count: number }
export interface EscalationTriggerRow { trigger: string; clock_types: ClockType[]; count: number }
export interface SlaDashboard extends DashboardBase {
  /** open breached clocks, oldest first (max 100) */
  breaches: SlaBreachRow[];
  /** open follow-ups past their due time, most overdue first (max 100) */
  overdue_followups: OverdueFollowupRow[];
  escalations_by_level: EscalationLevelRow[];
  escalation_triggers: EscalationTriggerRow[];
}

/* ───────────────────────── /dashboards/discom-ageing ───────────────────────── */

export const DISCOM_STAGES = ['feasibility', 'inspection', 'meter', 'commissioning'] as const;
export type DiscomStage = (typeof DISCOM_STAGES)[number];
export interface DiscomStageStats { n: number; median_days: number | null; p90_days: number | null; open: number; oldest_open_days: number | null }
export interface DeemedBreachRow {
  application_id: string; application_no: string | null; discom_id: string | null; discom_name: string; clock: 'feasibility' | 'commissioning';
  due_at: string; days_over: number; sales_order_id: string | null; path: string;
}
export interface DiscomAgeingRow {
  discom_id: string | null; discom_code: string | null; discom_name: string; applications: number;
  stages: Record<DiscomStage, DiscomStageStats>; deemed_breaches: number;
}
export interface DiscomAgeingDashboard extends DashboardBase {
  rows: DiscomAgeingRow[];
  overall: { applications: number; stages: Record<DiscomStage, DiscomStageStats>; deemed_breaches: number };
  deemed_breach_list: DeemedBreachRow[];
}

/* ───────────────────────── /dashboards/cfa-pending ───────────────────────── */

export interface CfaClaimRow {
  claim_id: string; sales_order_id: string | null; dealer_id: string | null; dealer_name: string | null; status: string; cohort: string;
  cfa_computed: number; state_share: number; discom_approval_at: string | null; age_days: number | null; claim_deadline: string | null; days_to_deadline: number | null; path: string;
}
export interface CfaBucketRow { label: string; count: number; value: number }
export interface CfaPendingDashboard extends DashboardBase {
  pending: CfaClaimRow[];
  age_buckets: CfaBucketRow[];
  legacy: { deadline: string | null; days_to_deadline: number | null; rule: RuleRef; count: number; value: number; claims: CfaClaimRow[] };
  state_share: { total_receivable: number; count: number; buckets: CfaBucketRow[] };
}

/* ───────────────────────── /dashboards/dealer-exposure ───────────────────────── */

export interface DealerExposureRow {
  dealer_id: string; dealer_name: string; distributor_id: string; distributor_name: string | null;
  credit_limit: number; outstanding: number; available: number; utilisation_pct: number; over_limit: boolean;
  ageing: { current: number; d1_30: number; d31_60: number; d61_90: number; d90_plus: number };
  overdue_amount: number; overdue_pct: number; subsidy_linked: number; subsidy_linked_pct_of_limit: number; dso_days: number | null; invoices_open: number;
  bank_guarantee: { amount: number; valid_till: string | null; days_left: number | null; valid: boolean; expiring_soon: boolean };
  portal_status: 'active' | 'deactivated' | 'under_sop'; sop_open: number; blocked_reasons: string[]; path: string;
}
export interface DealerExposureTotals {
  dealers: number; credit_limit: number; outstanding: number; overdue_amount: number; overdue_pct: number; subsidy_linked: number; subsidy_linked_pct_of_limit: number;
  dso_days: number | null; ageing: { current: number; d1_30: number; d31_60: number; d61_90: number; d90_plus: number };
}
export interface DealerExposureDashboard extends DashboardBase {
  as_of: string;
  totals: DealerExposureTotals;
  dealers: DealerExposureRow[];
  flagged: { under_sop: DealerExposureRow[]; deactivated: DealerExposureRow[]; over_limit: DealerExposureRow[]; bg_expiring: DealerExposureRow[] };
}

/* ───────────────────────── /dashboards/stock-exposure ───────────────────────── */

export interface StockSkuRow { sku_id: string; make: string; model: string; variant: string | null; wattage: number | null; units: number; value: number; unpriced_units: number; pct_of_value: number | null; path: string }
export interface StockBatchRow { batch_id: string | null; batch_no: string; sku_id: string; sku_label: string; received_at: string | null; supplier: string | null; origin: string | null; units: number; unit_cost: number | null; value: number; unpriced_units: number }
export interface StockExposureDashboard extends DashboardBase {
  exemption: { date: string | null; days_left: number | null; urgency: 'none' | 'watch' | 'critical' | 'passed'; rule: RuleRef };
  totals: { units: number; value: number; unpriced_units: number; reserved_units: number; skus: number; batches: number };
  by_sku: StockSkuRow[];
  by_batch: StockBatchRow[];
}

/* ───────────────────────── /dashboards/compliance ───────────────────────── */

export interface BlockedGateRow { gate: string; label: string; quotes: number }
export interface RequoteRow { quote_id: string; quote_no: string; version: number; status: string; reason: string | null; total: number; repriced_difference: number; leakage: number; owner_id: string | null; path: string }
export interface OverrideRow { id: string; kind: 'compliance_override' | 'credit_override'; entity_type: string; entity_id: string; label: string; requested_at: string; age_days: number; path: string }
export interface ComplianceDashboard extends DashboardBase {
  blocked_by_gate: BlockedGateRow[];
  requotes: RequoteRow[];
  open_overrides: OverrideRow[];
}

/* ───────────────────────── /dashboards/consent ───────────────────────── */

export interface BlockedReasonRow { code: string; label: string; count: number }
export interface ConsentDashboard extends DashboardBase {
  coverage: { leads: number; covered: number; uncovered: number };
  blocked_reasons: BlockedReasonRow[];
  uncovered_leads: { lead_id: string; name: string; created_at: string; path: string }[];
}

/* ───────────────────────── /dashboards/home ───────────────────────── */

export type HomeSeverity = 'info' | 'warning' | 'critical';
export interface HomeItem {
  id: string; entity_type: string; entity_id: string; title: string; subtitle: string | null; path: string;
  /** deadline for the item, if any */
  due_at: string | null;
  /** minutes until `due_at` (negative = overdue); null when no deadline */
  time_left_minutes: number | null;
  /** "2 h 15 min left" / "3 d overdue" */
  time_left_label: string | null;
  overdue: boolean;
  amount: number | null;
  badge: string | null;
  /** true when the item is assigned to the signed-in user */
  mine: boolean;
}
export interface HomeSection {
  key: string; title: string; description: string; count: number; severity: HomeSeverity;
  /** one-line headline for summary-type sections (stock exposure, consent coverage, legacy claims) */
  headline: string | null;
  /** top 5 items */
  items: HomeItem[];
  /** where "view all" goes */
  path: string;
  meta: Record<string, string | number | boolean | null>;
}
export interface HomeTile { key: string; label: string; value: number; unit: KpiUnit; path: string | null }
export interface HomeDashboard {
  generated_at: string;
  user: { id: string; name: string; role: AppRole; role_label: string };
  summary: HomeTile[];
  next_best_action: { text: string; path: string; severity: HomeSeverity } | null;
  sections: HomeSection[];
}

/* ───────────────────────── /reports ───────────────────────── */

export interface ReportCatalogItem {
  key: string; label: string; dashboard: string; unit: KpiUnit; definition: string; formula: string; source_tables: string[]; exclusions: string[];
  formats: ('xlsx')[]; export_path: string;
}

/* ───────────────────────── /search ───────────────────────── */

export const SEARCH_GROUP_KEYS = ['leads', 'opportunities', 'quotes', 'customers', 'dealers', 'distributors', 'skus', 'sales_orders', 'invoices'] as const;
export type SearchGroupKey = (typeof SEARCH_GROUP_KEYS)[number];
export interface SearchHit {
  type: string; id: string; title: string; subtitle: string | null; path: string; badge: string | null;
  /** true when personal data in this hit was masked for the signed-in role */
  masked: boolean;
}
export interface SearchGroup { key: SearchGroupKey; label: string; total: number; hits: SearchHit[] }
export interface SearchResponse { q: string; total: number; groups: SearchGroup[] }
