// Zod schemas and pure helpers for the opportunities area (convert lead → opportunity, update, board moves).
import { z } from 'zod';
import { OPPORTUNITY_STAGES, type OpportunityStage, type SchemeRoute, type Segment, type Temperature } from '../enums';
import type { FundingMix } from '../rows';
import { calendarDateSchema, looseNumber, plainText } from './customers';

const blankToNull = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? null : v);
const opt = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(blankToNull, schema.nullable().optional());

/* ───────────── derivations shared by API and web ───────────── */

/** Which scheme route a segment follows (step 19 derives this; it can never be typed in). */
export const SCHEME_ROUTE_BY_SEGMENT: Record<Segment, SchemeRoute> = {
  pmsg_residential: 'pmsg',
  rwa_ghs: 'rwa_ghs',
  ci_captive: 'captive',
  ci_net_metered: 'net_metering',
  open_access: 'open_access',
  pm_kusum: 'kusum',
  government_bid: 'government_bid',
};
export const deriveSchemeRoute = (segment: Segment): SchemeRoute => SCHEME_ROUTE_BY_SEGMENT[segment];

/** Stages from which a deal can still be won or lost. */
export const OPEN_OPPORTUNITY_STAGES = ['qualified', 'quotation', 'negotiation', 'pi_stage'] as const satisfies readonly OpportunityStage[];
export type OpenOpportunityStage = (typeof OPEN_OPPORTUNITY_STAGES)[number];

/** Segments that can rely on the ALMM List-II exemption for net-metered / open-access jobs (gate G5). */
export const EXEMPTION_SEGMENTS: readonly Segment[] = ['ci_net_metered', 'open_access'];

/** The three confirmations required before a lead may become an opportunity (work instruction, step 19). */
export const CONVERT_CONFIRMATION_KEYS = ['requirement_confirmed', 'timeline_confirmed', 'commercial_potential_confirmed'] as const;
export type ConvertConfirmationKey = (typeof CONVERT_CONFIRMATION_KEYS)[number];

/** Starting funding mix: the consumer pays everything. The loan rate is never defaulted — it is a free input with a source date. */
export const DEFAULT_FUNDING_MIX: FundingMix = { consumer_pct: 100, loan_pct: 0, subsidy_pct: 0, loan_rate_pct: null, loan_rate_source_date: null, bank: null };

export interface RegulationVersion { from: string; label: string }
export const regulationVersionsSchema = z.array(z.object({ from: calendarDateSchema, label: z.string().trim().min(1).max(200) }));

/** The last entry whose `from` is on/before `date` (the regulation in force on that commissioning date); null when none applies. */
export function resolveRegulationVersion(versions: unknown, date: string | null | undefined): RegulationVersion | null {
  if (!date) return null;
  const parsed = regulationVersionsSchema.safeParse(versions);
  if (!parsed.success) return null;
  const inForce = parsed.data.filter((v) => v.from <= date).sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  return inForce.length ? inForce[inForce.length - 1]! : null;
}

/** Default for the exemption-reliance flag: net-metered / open-access job commissioning on or before the exemption end date. */
export function defaultExemptionReliance(input: { segment: Segment; expected_commissioning_date: string | null | undefined; exemption_until: string | null | undefined }): boolean {
  if (!EXEMPTION_SEGMENTS.includes(input.segment)) return false;
  if (!input.expected_commissioning_date || !input.exemption_until) return false;
  return input.expected_commissioning_date <= input.exemption_until;
}

export const probabilityByTemperatureSchema = z.object({ hot: z.number().min(0).max(100), warm: z.number().min(0).max(100), cold: z.number().min(0).max(100) });
export type ProbabilityByTemperature = z.infer<typeof probabilityByTemperatureSchema>;
/** Fallback used only when rule `opportunity.default_probability` is absent or inactive. */
export const FALLBACK_PROBABILITY: ProbabilityByTemperature = { hot: 60, warm: 40, cold: 20 };
export const defaultProbability = (temperature: Temperature | null | undefined, table: ProbabilityByTemperature = FALLBACK_PROBABILITY): number => table[temperature ?? 'warm'];

/** kW × indicative ₹/kW. Always labelled "indicative" in the UI — it is not a quotation price. */
export const indicativeValue = (kw: number, ratePerKw: number): number => Math.round(kw * ratePerKw);

/* ───────────── request schemas ───────────── */

const pct = z.number().min(0).max(100);

export const fundingMixSchema = z.object({
  consumer_pct: looseNumber(pct),
  loan_pct: looseNumber(pct),
  subsidy_pct: looseNumber(pct),
  /** FREE INPUT — never defaulted by the server; requires the date of the source */
  loan_rate_pct: opt(looseNumber(z.number().min(0).max(40))),
  loan_rate_source_date: opt(calendarDateSchema),
  bank: opt(plainText(1, 120)),
}).strict().superRefine((m, ctx) => {
  const total = m.consumer_pct + m.loan_pct + m.subsidy_pct;
  if (Math.abs(total - 100) > 0.5) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Consumer, loan and subsidy shares must add up to 100 (now ${Math.round(total * 100) / 100})`, path: ['consumer_pct'] });
  if (m.loan_rate_pct != null && !m.loan_rate_source_date) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Add the date of the source for this loan interest rate', path: ['loan_rate_source_date'] });
}).transform((m): FundingMix => ({ ...m, loan_rate_pct: m.loan_rate_pct ?? null, loan_rate_source_date: m.loan_rate_source_date ?? null, bank: m.bank ?? null }));

/** POST /leads/:id/convert */
export const leadConvertSchema = z.object({
  requirement_confirmed: z.boolean().default(false),
  timeline_confirmed: z.boolean().default(false),
  commercial_potential_confirmed: z.boolean().default(false),
  kw: opt(looseNumber(z.number().positive().max(1_000_000))),
  expected_commissioning_date: opt(calendarDateSchema),
  expected_close_date: opt(calendarDateSchema),
  probability: opt(looseNumber(pct)),
  expected_value: opt(looseNumber(z.number().min(0).max(1e12))),
  competitor: opt(plainText(1, 200)),
  funding_mix: fundingMixSchema.optional(),
  exemption_reliance: z.boolean().optional(),
  name: opt(plainText(2, 200)),
}).strict();
export type LeadConvertInput = z.output<typeof leadConvertSchema>;

/** PATCH /opportunities/:id (step 20) */
export const opportunityUpdateSchema = z.object({
  name: plainText(2, 200).optional(),
  probability: looseNumber(pct).optional(),
  kw: looseNumber(z.number().positive().max(1_000_000)).optional(),
  expected_value: looseNumber(z.number().min(0).max(1e12)).optional(),
  expected_close_date: opt(calendarDateSchema),
  expected_commissioning_date: opt(calendarDateSchema),
  competitor: opt(plainText(1, 200)),
  funding_mix: fundingMixSchema.optional(),
  exemption_reliance: z.boolean().optional(),
}).strict().refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });
export type OpportunityUpdateInput = z.output<typeof opportunityUpdateSchema>;

export const opportunityStageSchema = z.object({ stage: z.enum(OPPORTUNITY_STAGES) }).strict();
export const opportunityLoseSchema = z.object({ reason: plainText(3, 500), competitor: opt(plainText(1, 200)) }).strict();
export const opportunityReopenSchema = z.object({ stage: z.enum(OPEN_OPPORTUNITY_STAGES).optional(), note: opt(plainText(1, 500)) }).strict();
export type OpportunityLoseInput = z.output<typeof opportunityLoseSchema>;
export type OpportunityReopenInput = z.output<typeof opportunityReopenSchema>;

export const opportunityListFilterCols = ['stage', 'segment', 'owner_id', 'distributor_id', 'dealer_id', 'territory_id', 'scheme_route', 'exemption_reliance'] as const;

export const pipelineQuerySchema = z.object({
  segment: z.string().optional(),
  owner: z.string().optional(),
  distributor: z.string().optional(),
  dealer: z.string().optional(),
  card_limit: z.coerce.number().int().min(0).max(100).default(20),
});
