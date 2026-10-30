// Zod schemas + response shapes for the post-sale area: installations, DISCOM applications, subsidy claims, loans, warranty / RMA, dealer receivables.
import { z } from 'zod';
import {
  AGREEMENT_STATUSES, COST_BEARERS, FEASIBILITY_STATUSES, LOAN_REJECTION_CODES, LOAN_STATUSES, RECEIVABLE_STATUSES, SUBSIDY_COHORTS,
  SUBSIDY_REJECTION_REASONS, SUBSIDY_STATUSES, WARRANTY_STATUSES, WARRANTY_TYPES,
  type LoanRejectionCode, type SubsidyCohort, type SubsidyStatus,
} from '../enums';
import { isoDateSchema, isoDateTimeSchema, safeText, uuidSchema } from '../validators';

/** Timestamp input: a full ISO-8601 instant, or a bare YYYY-MM-DD (taken as 00:00 IST). Always normalised to an ISO UTC string. */
export const postsaleTimestampSchema = z.union([isoDateTimeSchema, isoDateSchema]).transform((v) => (v.length === 10 ? new Date(`${v}T00:00:00+05:30`) : new Date(v)).toISOString());

const optId = uuidSchema.nullable().optional();
const money = z.number().min(0).max(100_000_000_000);

/* ───────────────────────── Installations ───────────────────────── */
export const installationCreateSchema = z.object({
  sales_order_id: uuidSchema,
  installer_name: safeText(120).nullable().optional(),
  /** vendor of record (vendor_registrations.id) */
  vendor_registration_id: optId,
  install_date: isoDateSchema.nullable().optional(),
  /** installed capacity in kW; defaults to the opportunity / quote kW */
  kw: z.number().positive().max(100_000).nullable().optional(),
  /** vendor-consumer agreement status */
  agreement_status: z.enum(AGREEMENT_STATUSES).optional(),
  no_connectivity_agreement: z.boolean().optional(),
});
export type InstallationCreateInput = z.infer<typeof installationCreateSchema>;

export const installationUpdateSchema = z.object({
  installer_name: safeText(120).nullable().optional(),
  vendor_registration_id: optId,
  install_date: isoDateSchema.nullable().optional(),
  kw: z.number().positive().max(100_000).nullable().optional(),
  agreement_status: z.enum(AGREEMENT_STATUSES).optional(),
  no_connectivity_agreement: z.boolean().optional(),
  /** recording the installation certificate starts the DISCOM commissioning clock */
  certificate_at: postsaleTimestampSchema.optional(),
  commissioned_at: postsaleTimestampSchema.optional(),
});
export type InstallationUpdateInput = z.infer<typeof installationUpdateSchema>;

export const installationCertificateSchema = z.object({ certificate_at: postsaleTimestampSchema.optional() });
export const installationCommissionSchema = z.object({
  commissioned_at: postsaleTimestampSchema.optional(),
  meter_type: safeText(60).nullable().optional(),
  meter_at: postsaleTimestampSchema.optional(),
});
/** Optional text fields that may accompany a multipart photo upload (device GPS is used when the JPEG has no EXIF geo). */
export const installationPhotoMetaSchema = z.object({
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  taken_at: postsaleTimestampSchema.optional(),
});

export const omRegisterQuerySchema = z.object({
  state: z.enum(['not_started', 'active', 'expiring', 'expired']).optional(),
  dealer_id: uuidSchema.optional(),
  distributor_id: uuidSchema.optional(),
  within_days: z.coerce.number().int().min(1).max(3650).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export type OmState = 'not_started' | 'active' | 'expiring' | 'expired';
export interface OmRegisterRow {
  installation_id: string; sales_order_id: string; customer_id: string | null; customer_name: string | null; dealer_id: string | null; dealer_name: string | null;
  distributor_id: string | null; vendor_registration_id: string | null; installer_name: string | null; kw: number | null;
  commissioned_at: string | null; om_start: string | null; om_end: string | null; days_left: number | null; state: OmState; warranty_end: string | null;
}
export interface OmRegisterResult {
  data: OmRegisterRow[]; total: number; limit: number; offset: number;
  summary: { not_started: number; active: number; expiring: number; expired: number; expiring_window_days: number };
}

/* ───────────────────────── DISCOM applications ───────────────────────── */
export const discomApplicationCreateSchema = z.object({
  sales_order_id: optId, installation_id: optId, site_id: optId, customer_id: optId, discom_id: optId, dealer_id: optId, distributor_id: optId,
  application_no: safeText(60).nullable().optional(),
  applied_kw: z.number().positive().max(100_000),
  submitted_at: postsaleTimestampSchema.nullable().optional(),
  complete_at: postsaleTimestampSchema.nullable().optional(),
  agreement_status: z.enum(AGREEMENT_STATUSES).optional(),
}).refine((v) => v.sales_order_id || v.installation_id || v.site_id, { message: 'Link the application to a sales order, installation or site', path: ['sales_order_id'] });
export type DiscomApplicationCreateInput = z.infer<typeof discomApplicationCreateSchema>;

export const discomApplicationUpdateSchema = z.object({
  discom_id: optId,
  application_no: safeText(60).nullable().optional(),
  applied_kw: z.number().positive().max(100_000).optional(),
  submitted_at: postsaleTimestampSchema.nullable().optional(),
  /** application complete — starts the 15-day feasibility clock above the exempt kW */
  complete_at: postsaleTimestampSchema.nullable().optional(),
  /** manual outcome of the feasibility study */
  feasibility_status: z.enum(FEASIBILITY_STATUSES).optional(),
  inspection_at: postsaleTimestampSchema.nullable().optional(),
  meter_type: safeText(60).nullable().optional(),
  meter_at: postsaleTimestampSchema.nullable().optional(),
  commissioning_at: postsaleTimestampSchema.nullable().optional(),
  agreement_status: z.enum(AGREEMENT_STATUSES).optional(),
});
export type DiscomApplicationUpdateInput = z.infer<typeof discomApplicationUpdateSchema>;

export const discomAgeingQuerySchema = z.object({
  discom_id: uuidSchema.optional(),
  distributor_id: uuidSchema.optional(),
  dealer_id: uuidSchema.optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});
export interface DiscomStageAgeingStat { n: number; pending: number; median_days: number | null; p90_days: number | null }
export interface DiscomStageAgeingRow {
  discom_id: string | null; discom_code: string | null; discom_name: string; applications: number;
  feasibility: DiscomStageAgeingStat; inspection: DiscomStageAgeingStat; meter: DiscomStageAgeingStat; commissioning: DiscomStageAgeingStat;
  breaches: { commissioning: number; feasibility: number; total: number };
}
export interface DiscomStageAgeingResult { rows: DiscomStageAgeingRow[]; totals: Omit<DiscomStageAgeingRow, 'discom_id' | 'discom_code' | 'discom_name'>; generated_at: string }

/* ───────────────────────── Subsidy claims ───────────────────────── */
export const subsidyClaimCreateSchema = z.object({
  installation_id: uuidSchema,
  /** manual cohort flag; when omitted it is derived from rule pmsg.legacy_cohort_cutoff (only if that rule is active) */
  cohort: z.enum(SUBSIDY_COHORTS).optional(),
  /** date the PMSG application was made; compared with the legacy cut-off */
  application_date: isoDateSchema.optional(),
  /** RWA / GHS only — number of households (each entitles 3 kW of common-facility capacity) */
  households: z.number().int().positive().max(100_000).optional(),
  bank_proof_ok: z.boolean().optional(),
  photos_ok: z.boolean().optional(),
  inspection_ok: z.boolean().optional(),
  e_token: safeText(60).nullable().optional(),
  state_share_due_at: postsaleTimestampSchema.nullable().optional(),
});
export type SubsidyClaimCreateInput = z.infer<typeof subsidyClaimCreateSchema>;

export const subsidyClaimUpdateSchema = z.object({
  cohort: z.enum(SUBSIDY_COHORTS).optional(),
  bank_proof_ok: z.boolean().optional(),
  photos_ok: z.boolean().optional(),
  inspection_ok: z.boolean().optional(),
  e_token: safeText(60).nullable().optional(),
  state_share_due_at: postsaleTimestampSchema.nullable().optional(),
  /** recording DISCOM approval starts the CFA-release clock */
  discom_approval_at: postsaleTimestampSchema.optional(),
});
export type SubsidyClaimUpdateInput = z.infer<typeof subsidyClaimUpdateSchema>;

export const subsidyDiscomApprovalSchema = z.object({ approved_at: postsaleTimestampSchema.optional() });
export const subsidyClaimSubmitSchema = z.object({ claim_at: postsaleTimestampSchema.optional() });
export const subsidyRejectSchema = z.object({ reason: z.enum(SUBSIDY_REJECTION_REASONS), note: safeText(500).optional() });
export const subsidyReleaseSchema = z.object({ released_at: postsaleTimestampSchema.optional(), state_share_received_at: postsaleTimestampSchema.optional() });
export const subsidyStateShareSchema = z.object({ received_at: postsaleTimestampSchema.optional(), due_at: postsaleTimestampSchema.nullable().optional() });
export const subsidyGrievanceSchema = z.object({ raised_at: postsaleTimestampSchema.optional(), note: safeText(500).optional() });

export const subsidyWorklistQuerySchema = z.object({
  cohort: z.enum(SUBSIDY_COHORTS).optional(),
  status: z.enum(SUBSIDY_STATUSES).optional(),
  dealer_id: uuidSchema.optional(),
  distributor_id: uuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export type DeadlineState = 'overdue' | 'critical' | 'urgent' | 'warning' | 'ok';
export interface SubsidyWorklistRow {
  claim_id: string; status: SubsidyStatus; cohort: SubsidyCohort; phase: 'prepare' | 'submit' | 'await_release';
  customer_id: string | null; customer_name: string | null; dealer_id: string | null; dealer_name: string | null;
  installation_id: string | null; sales_order_id: string | null; cfa_computed: number; state_share: number;
  claim_deadline: string | null; days_to_deadline: number | null; deadline_state: DeadlineState | null; deadline_met: boolean;
  discom_approval_at: string | null; cfa_release_due_at: string | null; cfa_release_overdue: boolean;
  age_days: number; blockers: string[]; next_action: string;
}
export interface SubsidyWorklistResult {
  data: SubsidyWorklistRow[]; total: number;
  summary: { legacy: number; legacy_at_risk: number; legacy_value_at_risk: number; current: number; blocked: number; ready_to_claim: number; awaiting_release: number; as_of: string };
}

export const stateShareAgeingQuerySchema = z.object({ dealer_id: uuidSchema.optional(), include_received: z.enum(['true', 'false']).transform((v) => v === 'true').optional() });
export interface StateShareAgeingRow {
  claim_id: string; customer_name: string | null; dealer_id: string | null; dealer_name: string | null; state_share: number; status: SubsidyStatus;
  since: string | null; age_days: number; due_at: string | null; days_overdue: number; bucket: 'not_due' | 'd0_30' | 'd31_60' | 'd61_90' | 'd90_plus'; received_at: string | null;
}
export interface StateShareAgeingResult {
  data: StateShareAgeingRow[];
  buckets: { not_due: number; d0_30: number; d31_60: number; d61_90: number; d90_plus: number };
  outstanding: number;
}

/* ───────────────────────── Loans ───────────────────────── */
const loanFields = {
  bank: z.string().trim().min(2).max(120),
  opportunity_id: optId, lead_id: optId, customer_id: optId, dealer_id: optId, distributor_id: optId, owner_id: optId,
  application_date: isoDateSchema.nullable().optional(),
  status: z.enum(LOAN_STATUSES).optional(),
  rejection_code: z.enum(LOAN_REJECTION_CODES).nullable().optional(),
  amount: money.nullable().optional(),
  /** FREE INPUT — never defaulted. Must come with the date the rate was sourced. */
  rate_pct: z.number().min(0).max(100).nullable().optional(),
  rate_source_date: isoDateSchema.nullable().optional(),
  co_applicant: safeText(160).nullable().optional(),
  document_checklist: z.record(z.string().trim().min(1).max(80), z.boolean()).optional(),
  notes: safeText(1000).nullable().optional(),
};
export const loanCreateSchema = z.object(loanFields);
export const loanUpdateSchema = z.object(loanFields).partial();
export type LoanCreateInput = z.infer<typeof loanCreateSchema>;

export const loanSummaryQuerySchema = z.object({
  from: isoDateSchema.optional(), to: isoDateSchema.optional(), bank: z.string().trim().max(120).optional(),
  dealer_id: uuidSchema.optional(), distributor_id: uuidSchema.optional(),
});
export interface LoanSummaryGroup { key: string; label: string; applied: number; approved: number; rejected: number; disbursed: number; approval_rate_pct: number | null }
export interface LoanSummary {
  overall: LoanSummaryGroup;
  by_bank: LoanSummaryGroup[]; by_dealer: LoanSummaryGroup[];
  rejection_codes: { code: LoanRejectionCode | 'unspecified'; count: number }[];
  /** applied loans still waiting for a decision for longer than rule loan.ageing_warn_days */
  ageing: { warn_days: number; pending: number; over_threshold: number };
}

/* ───────────────────────── Warranty / RMA ───────────────────────── */
export const warrantyTicketCreateSchema = z.object({
  /** serial number as printed (inventory_serials.serial) … */
  serial: z.string().trim().min(3).max(80).optional(),
  /** … or its id */
  serial_id: uuidSchema.optional(),
  installation_id: optId, sales_order_id: optId, customer_id: optId, dealer_id: optId,
  type: z.enum(WARRANTY_TYPES),
  issue: safeText(1000).pipe(z.string().min(3)),
  brand_claim_no: safeText(60).nullable().optional(),
  cost_bearer: z.enum(COST_BEARERS).optional(),
  owner_id: optId,
}).refine((v) => v.serial || v.serial_id || v.installation_id || v.sales_order_id, { message: 'Give a serial number, installation or sales order', path: ['serial'] });
export type WarrantyTicketCreateInput = z.infer<typeof warrantyTicketCreateSchema>;

export const warrantyTicketUpdateSchema = z.object({
  status: z.enum(WARRANTY_STATUSES).optional(),
  issue: safeText(1000).pipe(z.string().min(3)).optional(),
  brand_claim_no: safeText(60).nullable().optional(),
  cost_bearer: z.enum(COST_BEARERS).optional(),
  recovered_amount: money.optional(),
  owner_id: optId,
});
export type WarrantyTicketUpdateInput = z.infer<typeof warrantyTicketUpdateSchema>;

/* ───────────────────────── Receivables ───────────────────────── */
const receivableFields = {
  dealer_id: uuidSchema,
  doc_ref: z.string().trim().min(1).max(80),
  amount: z.number().positive().max(100_000_000_000),
  paid_amount: money.optional(),
  invoice_date: isoDateSchema,
  due_date: isoDateSchema,
  subsidy_linked: z.boolean().optional(),
  /** the project this receivable waits on — sales order, installation or opportunity id */
  linked_project_id: optId,
  status: z.enum(RECEIVABLE_STATUSES).optional(),
};
export const receivableCreateSchema = z.object(receivableFields).refine((v) => v.due_date >= v.invoice_date, { message: 'Due date cannot be before the invoice date', path: ['due_date'] });
export const receivableUpdateSchema = z.object(receivableFields).omit({ dealer_id: true }).partial();
export type ReceivableCreateInput = z.infer<typeof receivableCreateSchema>;

/* ───────────────────────── Post-sale board ───────────────────────── */
export interface PostSaleTab { total: number; open: number; overdue: number; by_status: Record<string, number> }
export interface PostSaleBoard {
  installations: PostSaleTab & { awaiting_certificate: number; om_expiring: number };
  discom: PostSaleTab & { deemed_breaches: number; feasibility_overdue: number; commissioning_overdue: number };
  loans: PostSaleTab & { over_threshold: number };
  subsidy: PostSaleTab & { legacy_at_risk: number; cfa_release_overdue: number };
  warranty: PostSaleTab & { rma_overdue: number };
  generated_at: string;
}
