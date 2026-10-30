// Zod schemas for the quotes area (API request bodies and shared form validation).
import { z } from 'zod';
import { APPROVAL_LANES } from '../enums';
import { isoDateSchema, isoDateTimeSchema, listQuerySchema, safeText, uuidSchema } from '../validators';

const queryBool = z.enum(['true', 'false']).transform((v) => v === 'true');
const optText = (max: number) => safeText(max).nullable().optional();

export const quoteCreateSchema = z.object({
  opportunity_id: uuidSchema,
  /** defaults to the earliest of quote date + quote.default_validity_days, the price horizon and the exemption date */
  validity_date: isoDateSchema.optional(),
  payment_terms: optText(500),
  clause_keys: z.array(z.string().trim().regex(/^clause\./)).max(30).optional(),
  freight: z.number().min(0).optional(),
});
export type QuoteCreateInput = z.infer<typeof quoteCreateSchema>;

export const quoteLineInputSchema = z.object({
  sku_id: uuidSchema.nullable().optional(),
  /** required for free-form lines (no SKU); defaults to the SKU description for catalogue lines */
  description: safeText(300).optional(),
  hsn: z.string().trim().regex(/^\d{4,8}$/, 'HSN must be 4 to 8 digits').nullable().optional(),
  qty: z.number().positive().max(1_000_000),
  /** defaults to the active sku_prices snapshot; an override is allowed and is checked against the floor price */
  unit_price: z.number().min(0).optional(),
  discount_pct: z.number().min(0).max(100).default(0),
  uom: z.string().trim().min(1).max(20).optional(),
});
export type QuoteLineInput = z.infer<typeof quoteLineInputSchema>;

export const quoteLinesReplaceSchema = z.object({
  lines: z.array(quoteLineInputSchema).max(100),
  /** set an explicit validity date; omit to cap the default validity at the price horizon on the first set of lines */
  validity_date: isoDateSchema.optional(),
  /** recompute the default validity (earliest of validity days / price horizon / exemption date) */
  reset_validity: z.boolean().optional(),
});
export type QuoteLinesReplaceInput = z.infer<typeof quoteLinesReplaceSchema>;

export const quotePatchSchema = z.object({
  validity_date: isoDateSchema.optional(),
  payment_terms: optText(500),
  clause_keys: z.array(z.string().trim().regex(/^clause\./)).max(30).optional(),
  freight: z.number().min(0).optional(),
  expected_commissioning_date: isoDateSchema.nullable().optional(),
  exemption_reliance: z.boolean().optional(),
  loan_rate_pct: z.number().min(0).max(40).nullable().optional(),
  loan_rate_source_date: isoDateSchema.nullable().optional(),
});
export type QuotePatchInput = z.infer<typeof quotePatchSchema>;

export const quoteListQuerySchema = listQuerySchema.extend({
  status: z.string().optional(),
  segment: z.string().optional(),
  opportunity_id: uuidSchema.optional(),
  owner_id: uuidSchema.optional(),
  dealer_id: uuidSchema.optional(),
  distributor_id: uuidSchema.optional(),
  compliance_status: z.enum(['pending', 'clear', 'warnings', 'blocked']).optional(),
  /** only the latest version of each quote chain */
  latest_only: queryBool.optional(),
});

export const requestApprovalSchema = z.object({ note: optText(1000) });
export type RequestApprovalInput = z.infer<typeof requestApprovalSchema>;

export const approvalDecisionSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  /** mandatory on a rejection and on any compliance override */
  comment: safeText(1000).optional(),
});
export type ApprovalDecisionInput = z.infer<typeof approvalDecisionSchema>;

export const approvalListQuerySchema = listQuerySchema.extend({
  scope: z.enum(['mine', 'all']).default('mine'),
  lane: z.enum(APPROVAL_LANES).optional(),
  entity_type: z.enum(['quotation', 'proforma_invoice', 'sales_order', 'credit_override', 'compliance_override']).optional(),
  decision: z.enum(['pending', 'approved', 'rejected', 'skipped']).default('pending'),
  /** only steps whose turn has come (earlier steps in the lane already approved) */
  actionable: queryBool.optional(),
});

export const quoteSendSchema = z.object({
  channels: z.array(z.enum(['email', 'whatsapp'])).min(1).max(2).default(['email', 'whatsapp']),
  message: optText(1000),
});
export type QuoteSendInput = z.infer<typeof quoteSendSchema>;

export const quoteDiscussionSchema = z.object({
  kind: z.enum(['call', 'whatsapp', 'meeting', 'email']),
  outcome: optText(200),
  notes: optText(2000),
  next_followup_at: isoDateTimeSchema.nullable().optional(),
});
export type QuoteDiscussionInput = z.infer<typeof quoteDiscussionSchema>;

export const quoteAcceptSchema = z.object({ note: optText(1000) });
export const quoteRejectSchema = z.object({ reason: safeText(1000).refine((v) => v.length >= 3, { message: 'Give the reason the customer declined' }) });
export const quoteReviseSchema = z.object({
  /** re-read the current price snapshot and GST rules (default: yes when the source quote is requote_required or expired) */
  reprice: z.boolean().optional(),
  note: optText(1000),
});

/** CA-type users (accounts, compliance officer) record the tax position of lines: GST rate, HSN and approval. */
export const taxPositionSchema = z.object({
  lines: z.array(z.object({
    line_id: uuidSchema,
    approved: z.boolean(),
    /** an explicit human tax decision — the only way a rate can differ from the rule (e.g. inverters while the rule is conflicting) */
    gst_rate: z.number().min(0).max(40).optional(),
    hsn: z.string().trim().regex(/^\d{4,8}$/, 'HSN must be 4 to 8 digits').optional(),
  })).min(1).max(100),
  note: optText(1000),
});
export type TaxPositionInput = z.infer<typeof taxPositionSchema>;

export const requoteExposureQuerySchema = z.object({ only_flagged: queryBool.optional() });
