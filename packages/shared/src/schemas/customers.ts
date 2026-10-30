// Zod schemas for the customers area (customers, sites, surveys, requirement capture, negotiation log) — API bodies and shared form validation.
import { z } from 'zod';
import { detectAadhaar } from '../aadhaar';
import { CUSTOMER_TYPES, PHASES, ROOF_OWNERSHIPS, ROOF_TYPES, SITE_CATEGORIES, SURVEY_STATUSES } from '../enums';
import type { Json } from '../rows';
import { addressSchema, emailSchema, gstinSchema, isoDateSchema, isoDateTimeSchema, listQuerySchema, mobileSchema, panSchema, pincodeSchema, uuidSchema } from '../validators';

/* ───────────── small building blocks ───────────── */

const AADHAAR_MESSAGE = 'Aadhaar numbers must not be entered here — use last four digits only.';
const blankToNull = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? null : v);

/** Optional + nullable field where an empty string from a form means "clear it". */
const opt = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(blankToNull, schema.nullable().optional());

/** Free text that refuses Aadhaar numbers (gate G14). */
export const plainText = (min: number, max: number) =>
  z.string().trim().min(min).max(max).refine((v) => detectAadhaar(v).length === 0, { message: AADHAAR_MESSAGE, params: { code: 'AADHAAR_BLOCKED' } });

/** Numbers typed into HTML inputs may arrive as numeric strings — accept those, but never an empty string or null as 0. */
export const looseNumber = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : v), schema);

/** A real calendar date in YYYY-MM-DD form (rejects 2026-02-31). */
export const calendarDateSchema = isoDateSchema.refine((v) => {
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}, 'Enter a valid date');

export const aadhaarLast4Schema = z.string().trim().regex(/^\d{4}$/, 'Enter exactly the last four digits — a full Aadhaar number is never stored');

/** Any key that looks like an Aadhaar field other than `aadhaar_last4` (gate G14). */
export const AADHAAR_KEY_RE = /aadhaa?r|adhaar|\buid(ai)?\b|^uid/i;
export function findAadhaarKeys(value: unknown, path = ''): string[] {
  const hits: string[] = [];
  if (Array.isArray(value)) value.forEach((v, i) => hits.push(...findAadhaarKeys(v, `${path}[${i}]`)));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const p = path ? `${path}.${k}` : k;
      if (k !== 'aadhaar_last4' && AADHAAR_KEY_RE.test(k)) hits.push(p);
      hits.push(...findAadhaarKeys(v, p));
    }
  }
  return hits;
}

export const jsonValueSchema: z.ZodType<Json> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)]),
);

/* ───────────── name matching (name on the DISCOM bill vs the applicant) — feeds gate G12 ───────────── */

const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'miss', 'shri', 'shree', 'shrimati', 'sri', 'smt', 'sh', 'kumari', 'kum', 'dr', 'prof', 'late', 'mst']);
const LEGAL_SUFFIXES = new Set(['pvt', 'ltd', 'private', 'limited', 'llp', 'co', 'company', 'inc', 'corp', 'and']);
const NAME_ALIASES: Record<string, string> = { md: 'mohammad', mohd: 'mohammad', mohammed: 'mohammad', muhammad: 'mohammad', mohamad: 'mohammad', mohmad: 'mohammad' };

/** Lower-case, strip accents, honorifics and legal suffixes; returns comparable tokens (letters of any script). */
export function nameTokens(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const cleaned = raw
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\bm\s*\/\s*s\b/g, ' ')
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ');
  const out: string[] = [];
  for (const t of cleaned.split(/\s+/)) {
    if (!t || HONORIFICS.has(t) || LEGAL_SUFFIXES.has(t)) continue;
    const aliased = NAME_ALIASES[t] ?? t;
    // common transliteration spellings: Prateek/Pratik, Patel/Pattel, Vijay/Wijay
    out.push(aliased.replace(/ee|ii/g, 'i').replace(/oo|uu/g, 'u').replace(/aa/g, 'a').replace(/ph/g, 'f').replace(/w/g, 'v').replace(/(.)\1+/g, '$1'));
  }
  return out;
}

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0] ?? 0;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j] ?? 0;
      prev[j] = Math.min((prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length] ?? 0;
}

/** 1 = same word, 0.9 = one-letter slip in a long word, 0.7 = an initial standing for the word, 0 = different. */
function tokenWeight(x: string, y: string): number {
  if (x === y) return 1;
  if (x.length === 1 || y.length === 1) return x[0] === y[0] ? 0.7 : 0;
  // deliberately conservative: Rajesh/Ramesh must NOT match — a false "match" is worse than a false warning
  return Math.max(x.length, y.length) >= 7 && editDistance(x, y) <= 1 ? 0.9 : 0;
}

export type NameMatchReason = 'exact' | 'fuzzy' | 'initials' | 'missing_middle_name' | 'mismatch';
export interface NameMatchResult { match: boolean; score: number; reason: NameMatchReason }

/**
 * Order-insensitive, forgiving comparison of two person/organisation names.
 * Returns null when either name is missing (nothing to compare). A mismatch is a WARNING input only (gate G12).
 */
export function compareNames(a: string | null | undefined, b: string | null | undefined, minScore = 0.85): NameMatchResult | null {
  const ta = nameTokens(a), tb = nameTokens(b);
  if (!ta.length || !tb.length) return null;
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const used = new Set<number>();
  let total = 0, fullWordMatches = 0, allMatched = true, minWeight = 1;
  for (const s of short) {
    let best = 0, bestIdx = -1;
    long.forEach((l, i) => { if (!used.has(i)) { const w = tokenWeight(s, l); if (w > best) { best = w; bestIdx = i; } } });
    if (bestIdx >= 0) used.add(bestIdx);
    total += best;
    if (best === 0) allMatched = false;
    else { minWeight = Math.min(minWeight, best); if (best >= 0.9) fullWordMatches++; }
  }
  const score = Math.round((total / long.length) * 100) / 100;
  const unmatchedLong = long.length - used.size;
  if (score >= 1) return { match: true, score: 1, reason: 'exact' };
  if (score >= minScore) return { match: true, score, reason: 'fuzzy' };
  if (allMatched && short.length >= 2 && unmatchedLong <= 1 && fullWordMatches >= 1 && minWeight >= 0.7) {
    return { match: true, score, reason: short.length === long.length ? 'initials' : 'missing_middle_name' };
  }
  return { match: false, score, reason: 'mismatch' };
}

/** Compare state names tolerantly ("Jammu & Kashmir" = "jammu and kashmir"). */
export const normaliseStateName = (s: string): string => s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
export const stateInList = (state: string | null | undefined, list: readonly string[]): boolean => {
  if (!state) return false;
  const n = normaliseStateName(state);
  return list.some((s) => normaliseStateName(s) === n);
};

/* ───────────── customers ───────────── */

const customerShape = {
  legal_name: plainText(2, 200),
  display_name: opt(plainText(1, 200)),
  customer_type: opt(z.enum(CUSTOMER_TYPES)),
  gstin: opt(gstinSchema),
  pan: opt(panSchema),
  email: opt(emailSchema),
  phone: opt(mobileSchema),
  billing_address: opt(addressSchema),
  shipping_address: opt(addressSchema),
  state: opt(plainText(2, 100)),
  /** only the last four digits are ever accepted — never a full Aadhaar number */
  aadhaar_last4: opt(aadhaarLast4Schema),
};
const gstinMatchesPan = (v: { gstin?: string | null; pan?: string | null }): boolean => !v.gstin || !v.pan || v.gstin.slice(2, 12) === v.pan;
const GSTIN_PAN_MESSAGE = { message: 'The PAN inside the GSTIN does not match the PAN entered', path: ['pan'] };

export const customerObjectSchema = z.object(customerShape).strict();
export const customerCreateSchema = z.object({ ...customerShape, lead_id: opt(uuidSchema) }).strict().refine(gstinMatchesPan, GSTIN_PAN_MESSAGE);
export const customerUpdateSchema = z.object(customerShape).partial().strict().refine(gstinMatchesPan, GSTIN_PAN_MESSAGE);
export type CustomerCreateInput = z.output<typeof customerCreateSchema>;
export type CustomerUpdateInput = z.output<typeof customerUpdateSchema>;

export const customerListFilterCols = ['customer_type', 'state'] as const;

/* ───────────── sites ───────────── */

export const SHADING_LEVELS = ['none', 'low', 'medium', 'high'] as const;
export type ShadingLevel = (typeof SHADING_LEVELS)[number];

const siteShape = {
  applicant_name: opt(plainText(2, 200)),
  name_on_bill: opt(plainText(2, 200)),
  consumer_no: opt(z.string().trim().min(3).max(30).regex(/^[A-Za-z0-9][A-Za-z0-9\-/ ]*$/, 'Use letters, digits, - and / only')),
  discom_id: opt(uuidSchema),
  /** convenience alternative to discom_id, e.g. "UGVCL" */
  discom_code: opt(z.string().trim().min(2).max(40)),
  sanctioned_load_kw: opt(looseNumber(z.number().positive().max(100000))),
  contracted_demand_kva: opt(looseNumber(z.number().positive().max(1000000))),
  phase: opt(z.enum(PHASES)),
  address: opt(addressSchema),
  pincode: opt(pincodeSchema),
  city: opt(plainText(1, 100)),
  district: opt(plainText(1, 100)),
  state: opt(plainText(2, 100)),
  lat: opt(looseNumber(z.number().min(-90).max(90))),
  lng: opt(looseNumber(z.number().min(-180).max(180))),
  roof_ownership: opt(z.enum(ROOF_OWNERSHIPS)),
  title_ok: opt(z.boolean()),
  pending_dues: z.boolean().optional(),
  existing_solar_kw: looseNumber(z.number().min(0).max(100000)).optional(),
  category: z.enum(SITE_CATEGORIES).optional(),
  /** manual override of the special-category-state flag; send null (or omit) to let the server derive it from the rule list */
  special_category_state: opt(z.boolean()),
  roof_type: opt(z.enum(ROOF_TYPES)),
  load_type: opt(plainText(1, 60)),
};

/** Fields of a site that a client may set (all optional). */
export const siteFieldsSchema = z.object(siteShape).strict();
export type SiteFieldsInput = z.output<typeof siteFieldsSchema>;

/** PUT /leads/:id/site — site fields plus optional nested customer details. */
export const leadSiteSaveSchema = z.object({ ...siteShape, customer: customerUpdateSchema.optional() }).strict();
export type LeadSiteSaveInput = z.output<typeof leadSiteSaveSchema>;

/** POST /sites — a site not created through a lead. */
export const siteCreateSchema = z.object({ ...siteShape, customer_id: opt(uuidSchema), lead_id: opt(uuidSchema) }).strict();
export const siteUpdateSchema = siteFieldsSchema;
export type SiteCreateInput = z.output<typeof siteCreateSchema>;

/* ───────────── site survey (step 14) ───────────── */

export const surveyScheduleSchema = z.object({
  lead_id: uuidSchema,
  scheduled_at: isoDateTimeSchema,
  surveyor_id: opt(uuidSchema),
  notes: opt(plainText(1, 2000)),
}).strict();
export type SurveyScheduleInput = z.output<typeof surveyScheduleSchema>;

export const surveyUpdateSchema = z.object({
  status: z.enum(SURVEY_STATUSES).optional(),
  scheduled_at: isoDateTimeSchema.optional(),
  surveyor_id: opt(uuidSchema),
  surveyed_at: isoDateTimeSchema.optional(),
  shading: opt(z.enum(SHADING_LEVELS)),
  roof_type: opt(z.enum(ROOF_TYPES)),
  roof_area_sqm: opt(looseNumber(z.number().positive().max(10000000))),
  sld_ref: opt(plainText(1, 200)),
  notes: opt(plainText(1, 4000)),
  /** required when status is "cancelled" */
  cancel_reason: opt(plainText(3, 500)),
}).strict().refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });
export type SurveyUpdateInput = z.output<typeof surveyUpdateSchema>;

export const surveyFeasibilitySchema = z.object({
  submitted_at: isoDateTimeSchema.optional(),
  complete_at: isoDateTimeSchema.optional(),
  /** DISCOM's answer — completes the clock */
  response: z.enum(['approved', 'rejected']).optional(),
  responded_at: isoDateTimeSchema.optional(),
  note: opt(plainText(1, 1000)),
}).strict().refine((v) => v.submitted_at !== undefined || v.complete_at !== undefined || v.response !== undefined, { message: 'Provide submitted_at, complete_at or response' });
export type SurveyFeasibilityInput = z.output<typeof surveyFeasibilitySchema>;

export const surveyListFilterCols = ['status', 'lead_id', 'surveyor_id', 'feasibility_status', 'site_id', 'opportunity_id'] as const;
export const surveyListQuerySchema = listQuerySchema.extend({
  mine: z.enum(['true', 'false']).optional(),
  scheduled_from: isoDateTimeSchema.optional(),
  scheduled_to: isoDateTimeSchema.optional(),
});

/** Multipart text fields that accompany survey photos. A single value applies to every file; repeat the field to give one value per file. */
export const surveyPhotoMaxCount = 10;

/* ───────────── requirement capture (step 15) ───────────── */

export const requirementSaveSchema = z.object({
  data: z.record(z.string(), jsonValueSchema),
  /** true = validate required fields and mark the form complete; omitted/false = save as a draft */
  complete: z.boolean().optional(),
  /** the step-15 chart form (Site, MW, Load type, Timeline, Specs): only those answers are required to complete */
  chart_only: z.boolean().optional(),
}).strict();
export type RequirementSaveInput = z.output<typeof requirementSaveSchema>;

/** Step 16: the products the salesperson picked for this job (replaces the previous pick; an empty list clears it). */
export const shortlistSaveSchema = z.object({ sku_ids: z.array(uuidSchema).max(60) }).strict();
export type ShortlistSaveInput = z.output<typeof shortlistSaveSchema>;

export const FORM_FIELD_TYPES = ['text', 'number', 'select', 'boolean', 'date', 'textarea', 'file'] as const;
export const formFieldDefSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,59}$/, 'Use lower-case letters, digits and _'),
  label: z.string().trim().min(1).max(120),
  type: z.enum(FORM_FIELD_TYPES),
  required: z.boolean(),
  options: z.array(z.string().trim().min(1).max(80)).max(60).optional(),
  help: z.string().trim().max(300).optional(),
  group: z.string().trim().max(80).optional(),
}).strict();

/** PUT /segments/:segment/form — publishes a new version of the segment's dynamic form. */
export const segmentFormSaveSchema = z.object({ fields: z.array(formFieldDefSchema).min(1).max(80) }).strict().superRefine((v, ctx) => {
  const seen = new Set<string>();
  v.fields.forEach((f, i) => {
    if (seen.has(f.key)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate field key "${f.key}"`, path: ['fields', i, 'key'] });
    seen.add(f.key);
    if (AADHAAR_KEY_RE.test(f.key)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Aadhaar fields are not allowed in any form', path: ['fields', i, 'key'], params: { code: 'AADHAAR_BLOCKED' } });
    if (f.type === 'select' && !f.options?.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A select field needs at least one option', path: ['fields', i, 'options'] });
  });
});
export type SegmentFormSaveInput = z.output<typeof segmentFormSaveSchema>;

/* ───────────── negotiation log (step 18) ───────────── */

const ratePerKw = looseNumber(z.number().positive().max(10_000_000));
export const negotiationCreateSchema = z.object({
  quoted_rate_per_kw: opt(ratePerKw),
  customer_counter_per_kw: opt(ratePerKw),
  notes: opt(plainText(1, 2000)),
}).strict().refine((v) => v.quoted_rate_per_kw != null || v.customer_counter_per_kw != null || !!v.notes, { message: 'Record a quoted rate, the customer counter or a note' });
export type NegotiationCreateInput = z.output<typeof negotiationCreateSchema>;
