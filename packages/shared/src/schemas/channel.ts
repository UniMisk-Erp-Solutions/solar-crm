// Zod schemas + response shapes for the channel-management area: distributors, dealers, vendor registrations, MNRE SOP tracker.
import { z } from 'zod';
import { PARTY_STATUSES, PORTAL_STATUSES, SECURITY_TYPES, SOP_STAGES, VENDOR_LEVELS, type PortalStatus, type SopStage } from '../enums';
import type { CreditAgeing } from '../rows';
import { addressSchema, emailSchema, gstinSchema, isoDateSchema, panSchema, safeText, uuidSchema } from '../validators';
import { postsaleTimestampSchema } from './postsale';

const phone = z.string().trim().min(5).max(20).regex(/^[0-9+()\-\s]+$/, 'Enter a valid phone number');
const optPhone = phone.nullable().optional();
const optEmail = emailSchema.nullable().optional();
const optGstin = gstinSchema.nullable().optional();
const optPan = panSchema.nullable().optional();
const name = z.string().trim().min(2).max(200);
const money = z.number().min(0).max(100_000_000_000);

/* ───────────────────────── Distributors ───────────────────────── */
const distributorBase = {
  legal_name: name,
  trade_name: z.string().trim().max(200).nullable().optional(),
  gstin: optGstin, pan: optPan,
  contact_name: z.string().trim().max(120).nullable().optional(),
  phone: optPhone, email: optEmail,
  address: addressSchema.nullable().optional(),
  state: z.string().trim().min(2).max(100),
  city: z.string().trim().max(100).nullable().optional(),
  territory_ids: z.array(uuidSchema).max(200).optional(),
  capacity_band_min_kw: z.number().min(0).max(1_000_000).optional(),
  capacity_band_max_kw: z.number().min(0).max(1_000_000).optional(),
  capability_tags: z.array(z.string().trim().min(1).max(40)).max(40).optional(),
  status: z.enum(PARTY_STATUSES).optional(),
  credit_days: z.number().int().min(0).max(365).optional(),
  credit_limit: money.optional(),
  rebate_slab_key: z.string().trim().max(60).nullable().optional(),
};
const bandOk = (v: { capacity_band_min_kw?: number; capacity_band_max_kw?: number }) =>
  v.capacity_band_min_kw === undefined || v.capacity_band_max_kw === undefined || v.capacity_band_max_kw >= v.capacity_band_min_kw;
export const distributorCreateSchema = z.object(distributorBase).refine(bandOk, { message: 'Maximum capacity must be at least the minimum', path: ['capacity_band_max_kw'] });
export const distributorUpdateSchema = z.object(distributorBase).partial().refine(bandOk, { message: 'Maximum capacity must be at least the minimum', path: ['capacity_band_max_kw'] });
export type DistributorCreateInput = z.infer<typeof distributorCreateSchema>;

export interface DistributorScoreComponent { key: string; label: string; weight: number; factor: number; points: number; note: string; insufficient_data?: boolean }
export interface DistributorScoreResult { distributor_id: string; score: number; previous_score: number; components: DistributorScoreComponent[]; computed_at: string; history_id: string }

/* ───────────────────────── Dealers ───────────────────────── */
const dealerBase = {
  distributor_id: uuidSchema,
  legal_name: name,
  trade_name: z.string().trim().max(200).nullable().optional(),
  gstin: optGstin, pan: optPan,
  contact_name: z.string().trim().max(120).nullable().optional(),
  phone: optPhone, email: optEmail,
  territory_id: uuidSchema.nullable().optional(),
  city: z.string().trim().max(100).nullable().optional(),
  district: z.string().trim().max(100).nullable().optional(),
  state: z.string().trim().min(2).max(100),
  credit_limit: money.optional(),
  security_type: z.enum(SECURITY_TYPES).optional(),
  security_amount: money.optional(),
  status: z.enum(PARTY_STATUSES).optional(),
};
/** `distributor_id` is required for internal users; a distributor user's own distributorship is applied by the API. */
export const dealerCreateSchema = z.object({ ...dealerBase, distributor_id: uuidSchema.optional() });
export const dealerUpdateSchema = z.object(dealerBase).omit({ distributor_id: true }).partial();
export type DealerCreateInput = z.infer<typeof dealerCreateSchema>;

export interface RebateAccrual {
  /** false when rule channel.rebate_slabs is absent / inactive / has no slab set for this dealer — accrual is then 0 */
  slabs_configured: boolean; message: string | null;
  period: 'month' | 'quarter' | 'fy' | null; period_start: string | null; period_end: string | null;
  mode: 'flat' | 'marginal' | null; volume: number; rate_pct: number | null; accrued: number;
}
export interface DealerScorecard {
  dealer_id: string; dealer_name: string; distributor_id: string; as_of: string;
  territory: { id: string; name: string } | null;
  credit: { limit: number; outstanding: number; available: number; utilisation_pct: number; over_limit: boolean };
  dso_days: number | null; overdue_amount: number; overdue_pct: number; ageing: CreditAgeing; invoices_open: number;
  subsidy_linked: { amount: number; pct_of_limit: number; exceeds_limit: boolean };
  portal_status: PortalStatus; deactivations: number; complaint_count: number; sop_open: number;
  bank_guarantee: { amount: number; valid_till: string | null; days_left: number | null; valid: boolean; expiring_soon: boolean; alert_days: number; alert: string | null };
  rebate: RebateAccrual;
  alerts: string[];
}
export interface DealerExposureView {
  dealer_id: string; dealer_name: string; distributor_id: string; credit_limit: number; outstanding: number; available: number; over_limit: boolean; utilisation_pct: number;
  ageing: CreditAgeing; overdue_amount: number; overdue_pct: number; subsidy_linked: number; subsidy_linked_pct_of_limit: number; dso_days: number | null; invoices_open: number;
  bank_guarantee: { amount: number; valid_till: string | null; days_left: number | null; valid: boolean; expiring_soon: boolean };
  portal_status: PortalStatus; sop_open: number; deactivated: boolean; blocked_reasons: string[];
}

/* ───────────────────────── Vendor registrations ───────────────────────── */
const vendorBase = {
  party_type: z.enum(['distributor', 'dealer']),
  party_id: uuidSchema,
  level: z.enum(VENDOR_LEVELS),
  portal_vendor_id: z.string().trim().max(80).nullable().optional(),
  states: z.array(z.string().trim().min(2).max(100)).max(40).optional(),
  districts: z.array(z.string().trim().min(2).max(100)).max(400).optional(),
  bank_guarantee_amount: money.optional(),
  bank_guarantee_valid_till: isoDateSchema.nullable().optional(),
  portal_status: z.enum(PORTAL_STATUSES).optional(),
  deactivated_from: isoDateSchema.nullable().optional(),
  deactivated_to: isoDateSchema.nullable().optional(),
  notes: safeText(1000).nullable().optional(),
};
export const vendorRegistrationCreateSchema = z.object(vendorBase);
export const vendorRegistrationUpdateSchema = z.object(vendorBase).omit({ party_type: true, party_id: true }).partial();
export type VendorRegistrationCreateInput = z.infer<typeof vendorRegistrationCreateSchema>;
export interface BankGuaranteeWarning { code: 'BG_EXPIRED' | 'BG_EXPIRING' | 'BG_AMOUNT_LOW' | 'BG_MISSING'; severity: 'info' | 'warning' | 'hard_stop'; advisory: boolean; message: string }

/* ───────────────────────── MNRE SOP tracker ───────────────────────── */
export const sopCaseCreateSchema = z.object({
  dealer_id: uuidSchema,
  vendor_registration_id: uuidSchema.nullable().optional(),
  complaint_ref: z.string().trim().min(1).max(120),
  summary: safeText(1000).nullable().optional(),
  /** date / time the MNRE notice was received; defaults to now */
  notice_at: postsaleTimestampSchema.optional(),
});
export type SopCaseCreateInput = z.infer<typeof sopCaseCreateSchema>;
export const sopCaseUpdateSchema = z.object({ summary: safeText(1000).nullable().optional(), complaint_ref: z.string().trim().min(1).max(120).optional(), outcome: safeText(500).nullable().optional() });
export const sopTransitionSchema = z.object({
  to: z.enum(SOP_STAGES),
  at: postsaleTimestampSchema.optional(),
  outcome: safeText(500).optional(),
});
export const sopReplySchema = z.object({ replied_at: postsaleTimestampSchema.optional() });
export const SOP_NEXT: Record<SopStage, SopStage[]> = {
  reply: ['reminder', 'closed'], reminder: ['show_cause', 'closed'], show_cause: ['deactivation', 'closed'], deactivation: ['appeal', 'closed'], appeal: ['closed'], closed: [],
};
export interface SopCaseView {
  next_stages: SopStage[]; next_due_at: string | null; days_to_next_due: number | null; warnings: string[];
}
