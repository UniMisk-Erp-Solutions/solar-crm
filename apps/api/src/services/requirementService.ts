/**
 * Requirement capture (step 15): a dynamic form per segment (`segment_form_config`) whose answers are stored in
 * `requirement_forms.data`. Drafts may be incomplete; marking the form complete enforces every required field.
 * Answers that overlap with site columns (consumer number, sanctioned load, phase, roof …) are mirrored into the site.
 */
import { inferSegment } from './leadServiceStore';
import {
  calendarDateSchema, detectAadhaar, findAadhaarKeys, siteFieldsSchema, TIMELINE_BUCKETS,
  type FormFieldDef, type Json, type Lead, type RequirementForm, type RequirementSaveInput, type Segment, type SegmentFormSaveInput, type Site, type SiteFieldsInput,
} from '@solar/shared';
import type { AppContext } from '../auth/context';
import { audit } from '../lib/audit';
import { AppError, guardBlocked } from '../http/errors';
import { actorId, assertLeadEditable, logLeadEvent, type Hint } from './siteAccess';
import { defaultSegmentForm, SITE_MIRROR_KEYS } from './requirementDefaults';
import { applySiteFieldsForLead } from './siteService';

const asJson = (v: unknown): Json => v as Json;
type FormData = { [key: string]: Json };

export interface SegmentFormView { id: string | null; segment: Segment; version: number; fields: FormFieldDef[]; source: 'config' | 'default' }
export interface FieldIssue { path: string; message: string }

/* ───────────── segment form config ───────────── */

/**
 * The step-15 chart names six things every form must capture: Site, MW (size), Load type, Timeline, Specs and Documents (uploads are separate).
 * Forms published earlier may lack some of them, so the size, load type, timeline and specs fields are always present; the rest come from the segment.
 */
export const CHART_REQUIRED = ['site_note', 'capacity_kw', 'load_type', 'timeline_bucket'] as const;
export function withChartFields(fields: FormFieldDef[]): FormFieldDef[] {
  const out = [...fields];
  const has = (k: string) => out.some((x) => x.key === k);
  if (!has('site_note')) out.push({ key: 'site_note', label: 'Site', type: 'text', required: false, group: 'Site', help: 'Where it will be installed: address, and roof or land' });
  if (!has('capacity_kw')) out.push({ key: 'capacity_kw', label: 'Project size (kW)', type: 'number', required: true, group: 'Size', help: 'Planned plant size in kW (1,000 kW = 1 MW)' });
  if (!has('load_type')) out.push({ key: 'load_type', label: 'Load type', type: 'select', required: false, group: 'Load type', options: ['residential', 'commercial', 'industrial', 'agricultural', 'institutional', 'mixed'] });
  if (!has('timeline_bucket')) out.push({ key: 'timeline_bucket', label: 'How soon does the customer want to go ahead?', type: 'select', required: false, group: 'Timeline', options: [...TIMELINE_BUCKETS] });
  if (!has('specs') && !has('specs_notes')) out.push({ key: 'specs', label: 'Technical specifications / client requirements', type: 'textarea', required: false, group: 'Specs' });
  return out;
}

/** The newest published form for the segment (or the built-in default). DISCOM options are filled from the DISCOM master. */
export async function getSegmentForm(ctx: AppContext, segment: Segment): Promise<SegmentFormView> {
  const rows = await ctx.db.table('segment_form_config').all({ segment }, { orderBy: { col: 'version', dir: 'desc' } });
  const row = rows[0];
  const fields = withChartFields(row ? row.fields : defaultSegmentForm(segment)).map((x) => ({ ...x, options: x.options ? [...x.options] : x.options }));
  const discoms = (await ctx.db.table('discoms').all({}, { orderBy: { col: 'code' } })).map((d) => d.code);
  for (const x of fields) if (x.key === 'discom_code' && x.type === 'select' && discoms.length) x.options = discoms;
  return { id: row?.id ?? null, segment, version: row?.version ?? 0, fields, source: row ? 'config' : 'default' };
}

export async function publishSegmentForm(ctx: AppContext, segment: Segment, input: SegmentFormSaveInput): Promise<SegmentFormView> {
  const rows = await ctx.db.table('segment_form_config').all({ segment });
  const version = rows.reduce((m, r) => Math.max(m, r.version), 0) + 1;
  const row = await ctx.db.table('segment_form_config').insert({ segment, version, fields: input.fields, created_by: actorId(ctx) });
  await audit(ctx, { action: 'segment_form.publish', table: 'segment_form_config', record_id: row.id, new: asJson({ segment, version, fields: input.fields.length }) });
  return getSegmentForm(ctx, segment);
}

/* ───────────── validation ───────────── */

const present = (v: Json | undefined): boolean => v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '');

function coerce(field: FormFieldDef, raw: Json): { ok: true; value: Json } | { ok: false; message: string } {
  switch (field.type) {
    case 'text': case 'textarea': {
      if (typeof raw !== 'string') return { ok: false, message: `${field.label} must be text` };
      const v = raw.trim();
      const max = field.type === 'text' ? 500 : 4000;
      if (v.length > max) return { ok: false, message: `${field.label} can be at most ${max} characters` };
      if (detectAadhaar(v).length) throw new AppError(422, 'AADHAAR_BLOCKED', 'An Aadhaar number was detected. We do not store Aadhaar numbers — remove it (last four digits only).', { fields: [`data.${field.key}`] });
      return { ok: true, value: v };
    }
    case 'number': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
      if (!Number.isFinite(n) || n < 0 || n > 1e12) return { ok: false, message: `${field.label} must be a number (0 or more)` };
      return { ok: true, value: n };
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return { ok: true, value: raw };
      if (raw === 'true' || raw === 'false') return { ok: true, value: raw === 'true' };
      return { ok: false, message: `${field.label} must be yes or no` };
    }
    case 'date': {
      if (typeof raw !== 'string' || !calendarDateSchema.safeParse(raw).success) return { ok: false, message: `${field.label} must be a date in YYYY-MM-DD form` };
      return { ok: true, value: raw };
    }
    case 'select': {
      if (typeof raw !== 'string') return { ok: false, message: `${field.label} must be one of the listed options` };
      const v = raw.trim();
      if (field.options?.length && !field.options.includes(v)) return { ok: false, message: `${field.label} must be one of: ${field.options.join(', ')}` };
      return { ok: true, value: v };
    }
    case 'file': {
      if (typeof raw !== 'string' || raw.length > 500) return { ok: false, message: `${field.label} must be a document reference` };
      return { ok: true, value: raw.trim() };
    }
  }
}

/** Validate the keys that were sent. Unknown keys and wrong types are errors even in a draft; required-ness is checked separately. */
export function validateAnswers(fields: FormFieldDef[], incoming: FormData): { cleaned: FormData; cleared: string[]; issues: FieldIssue[] } {
  const bad = findAadhaarKeys(incoming);
  if (bad.length) throw new AppError(422, 'AADHAAR_BLOCKED', 'Aadhaar fields are not accepted. We do not store Aadhaar numbers — use last four digits only where asked.', { fields: bad });
  const byKey = new Map(fields.map((x) => [x.key, x]));
  const cleaned: FormData = {};
  const cleared: string[] = [];
  const issues: FieldIssue[] = [];
  for (const [key, raw] of Object.entries(incoming)) {
    const field = byKey.get(key);
    if (!field) { issues.push({ path: `data.${key}`, message: 'This field is not part of the form for this segment' }); continue; }
    if (!present(raw)) { cleared.push(key); continue; }
    const r = coerce(field, raw);
    if (r.ok) cleaned[key] = r.value; else issues.push({ path: `data.${key}`, message: r.message });
  }
  return { cleaned, cleared, issues };
}

/**
 * The seeded segment forms (and forms published before the site columns were fixed) ask for the DISCOM under the key `discom` with display names
 * ("Torrent Power"), while the site stores `discom_code` (UGVCL, TORRENT…). Resolve the answer against the DISCOM master by code or name so it reaches the site.
 */
async function discomCodeFor(ctx: AppContext, answer: Json): Promise<string | null> {
  if (typeof answer !== 'string') return null;
  const want = answer.trim().toLowerCase();
  const discoms = await ctx.db.table('discoms').all();
  const hit = discoms.find((d) => d.code.toLowerCase() === want) ?? discoms.find((d) => d.name.toLowerCase() === want) ?? discoms.find((d) => d.name.toLowerCase().startsWith(want) || d.code.toLowerCase().startsWith(want));
  return hit?.code ?? null;
}

export const missingRequired = (fields: FormFieldDef[], data: FormData): FormFieldDef[] => fields.filter((x) => x.required && !present(data[x.key]));

/* ───────────── read / save ───────────── */

export interface RequirementView {
  lead_id: string;
  segment: Segment | null;
  config: SegmentFormView | null;
  form: RequirementForm | null;
  data: FormData;
  completed: boolean;
  missing_required: { key: string; label: string }[];
  /** answers stored earlier that the current form no longer has (the segment or the form version changed) */
  stale_keys: string[];
  message: string | null;
}

export async function getRequirementView(ctx: AppContext, leadIn: Lead): Promise<RequirementView> {
  let lead = leadIn;
  if (!lead.segment) { // leads created before the segment was inferred: work it out from the customer type and keep it
    const seg = inferSegment(lead);
    if (seg) lead = await ctx.db.table('leads').update(lead.id, { segment: seg });
  }
  const form = await ctx.db.table('requirement_forms').one({ lead_id: lead.id });
  if (!lead.segment) {
    return { lead_id: lead.id, segment: null, config: null, form, data: form?.data ?? {}, completed: false, missing_required: [], stale_keys: [], message: 'Set the lead’s segment first — the requirement form depends on it.' };
  }
  const config = await getSegmentForm(ctx, lead.segment);
  const data: FormData = { ...(lead.capacity_kw !== null ? { capacity_kw: lead.capacity_kw } : {}), ...(lead.timeline_bucket ? { timeline_bucket: lead.timeline_bucket } : {}), ...(form?.data ?? {}) };
  const keys = new Set(config.fields.map((x) => x.key));
  return {
    lead_id: lead.id, segment: lead.segment, config, form, data, completed: !!form?.completed_at,
    missing_required: missingRequired(config.fields, data).map((x) => ({ key: x.key, label: x.label })),
    stale_keys: Object.keys(data).filter((k) => !keys.has(k) && !k.startsWith('_')), message: null,
  };
}

export async function saveRequirement(ctx: AppContext, lead: Lead, input: RequirementSaveInput): Promise<RequirementView & { hints: Hint[]; site: Site | null }> {
  assertLeadEditable(lead);
  if (!lead.segment) throw guardBlocked('Set the lead’s segment before capturing requirements', { missing: ['segment'] });
  const config = await getSegmentForm(ctx, lead.segment);
  const existing = await ctx.db.table('requirement_forms').one({ lead_id: lead.id });
  const { cleaned, cleared, issues } = validateAnswers(config.fields, input.data);

  const data: FormData = { ...(existing?.data ?? {}), ...cleaned };
  // size and timeline already known on the lead count as answered
  const known: FormData = { ...(lead.capacity_kw !== null ? { capacity_kw: lead.capacity_kw } : {}), ...(lead.timeline_bucket ? { timeline_bucket: lead.timeline_bucket } : {}) };
  for (const k of cleared) delete data[k];
  const missing = input.chart_only
    ? config.fields.filter((x) => (CHART_REQUIRED as readonly string[]).includes(x.key) && !present({ ...known, ...data }[x.key]))
    : missingRequired(config.fields, { ...known, ...data });
  if (input.complete) for (const m of missing) issues.push({ path: `data.${m.key}`, message: `${m.label} is required to complete the form` });

  // answers that overlap with site columns are validated with the site schema BEFORE anything is written
  const mirror: Record<string, Json> = {};
  for (const k of SITE_MIRROR_KEYS) if (k in cleaned) mirror[k] = cleaned[k]!;
  if (!('discom_code' in cleaned) && 'discom' in cleaned) {
    const code = await discomCodeFor(ctx, cleaned['discom']!);
    if (code) mirror['discom_code'] = code; else issues.push({ path: 'data.discom', message: 'That DISCOM is not in the DISCOM master' });
  }
  let siteFields: SiteFieldsInput = {};
  if (Object.keys(mirror).length) {
    const parsed = siteFieldsSchema.safeParse(mirror);
    if (parsed.success) siteFields = parsed.data;
    else for (const i of parsed.error.issues) issues.push({ path: `data.${i.path.join('.')}`, message: i.message });
  }
  if (issues.length) throw new AppError(422, 'VALIDATION_ERROR', input.complete ? 'Complete the required fields before finishing the form' : 'Please check the highlighted fields', issues);

  const mirrored = await applySiteFieldsForLead(ctx, lead, siteFields);
  // size and timeline live on the lead too (routing, scoring and the quote read them from there)
  const leadPatch: Partial<Lead> = {};
  if (typeof cleaned['capacity_kw'] === 'number' && cleaned['capacity_kw'] > 0) leadPatch.capacity_kw = cleaned['capacity_kw'];
  if (typeof cleaned['timeline_bucket'] === 'string') leadPatch.timeline_bucket = cleaned['timeline_bucket'] as Lead['timeline_bucket'];
  if (Object.keys(leadPatch).length) await ctx.db.table('leads').update(lead.id, leadPatch);
  const siteId = mirrored?.site.id ?? lead.site_id ?? existing?.site_id ?? null;

  const wasComplete = !!existing?.completed_at;
  const nowIso = ctx.now().toISOString();
  const completedNow = input.complete === true || (wasComplete && missing.length === 0);
  const patch = {
    segment: lead.segment, data, site_id: siteId,
    completed_at: completedNow ? (wasComplete && input.complete !== true ? existing!.completed_at : nowIso) : null,
    completed_by: completedNow ? (wasComplete && input.complete !== true ? existing!.completed_by : actorId(ctx)) : null,
  };
  const form = existing
    ? await ctx.db.table('requirement_forms').update(existing.id, patch)
    : await ctx.db.table('requirement_forms').insert({ ...patch, lead_id: lead.id, opportunity_id: null, created_by: actorId(ctx) });

  const becameComplete = completedNow && !wasComplete;
  await logLeadEvent(ctx, lead.id, becameComplete ? 'requirement_completed' : 'requirement_saved', becameComplete ? 'Requirement form completed' : 'Requirement form saved as draft', { form_id: form.id, segment: lead.segment, fields: Object.keys(cleaned) });
  await audit(ctx, { action: becameComplete ? 'requirement.complete' : 'requirement.save', table: 'requirement_forms', record_id: form.id, old: existing ? asJson({ completed_at: existing.completed_at }) : null, new: asJson({ segment: lead.segment, completed_at: form.completed_at, keys: Object.keys(data) }) });

  const view = await getRequirementView(ctx, { ...lead, site_id: siteId });
  return { ...view, hints: mirrored?.hints ?? [], site: mirrored?.site ?? null };
}

/** Requirement-form state for convert-readiness: none | draft | complete. */
export async function requirementStatus(ctx: AppContext, leadId: string): Promise<'none' | 'draft' | 'complete'> {
  const form = await ctx.db.table('requirement_forms').one({ lead_id: leadId });
  return !form ? 'none' : form.completed_at ? 'complete' : 'draft';
}

/* ───────────── step 16: the shortlisted products ───────────── */
export interface ShortlistView { lead_id: string; sku_ids: string[]; saved_at: string | null }
const SHORTLIST_KEY = '_shortlist';

export async function getShortlist(ctx: AppContext, lead: Lead): Promise<ShortlistView> {
  const form = await ctx.db.table('requirement_forms').one({ lead_id: lead.id });
  const raw = form?.data?.[SHORTLIST_KEY] as { sku_ids?: string[]; saved_at?: string } | undefined;
  return { lead_id: lead.id, sku_ids: Array.isArray(raw?.sku_ids) ? raw!.sku_ids : [], saved_at: raw?.saved_at ?? null };
}

export async function saveShortlist(ctx: AppContext, lead: Lead, skuIds: string[]): Promise<ShortlistView> {
  assertLeadEditable(lead);
  const ids = [...new Set(skuIds)];
  if (ids.length) {
    const found = await ctx.db.table('skus').all({ id: ids, active: true });
    const missing = ids.filter((id) => !found.some((s) => s.id === id));
    if (missing.length) throw new AppError(422, 'VALIDATION_ERROR', 'Some of the chosen products are not available any more', missing.map((m) => ({ path: 'sku_ids', message: m })));
  }
  const existing = await ctx.db.table('requirement_forms').one({ lead_id: lead.id });
  const savedAt = ctx.now().toISOString();
  const data: FormData = { ...(existing?.data ?? {}), [SHORTLIST_KEY]: asJson({ sku_ids: ids, saved_at: savedAt }) };
  if (!ids.length) delete data[SHORTLIST_KEY];
  if (existing) await ctx.db.table('requirement_forms').update(existing.id, { data });
  else if (ids.length) await ctx.db.table('requirement_forms').insert({ lead_id: lead.id, opportunity_id: null, segment: lead.segment ?? undefined, data, site_id: lead.site_id ?? null, completed_at: null, completed_by: null, created_by: actorId(ctx) });
  await logLeadEvent(ctx, lead.id, 'products_shortlisted', ids.length ? `${ids.length} product(s) shortlisted for this job` : 'Product shortlist cleared', { sku_ids: asJson(ids) });
  await audit(ctx, { action: 'requirement.shortlist', table: 'requirement_forms', record_id: existing?.id ?? lead.id, new: asJson({ count: ids.length }) });
  return { lead_id: lead.id, sku_ids: ids, saved_at: ids.length ? savedAt : null };
}
