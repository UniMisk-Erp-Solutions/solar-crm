/**
 * Lowest layer of the lead module: loading and saving a lead (with the “mandatory on every save” rule), the business event
 * ledger, and the small helpers every other lead service shares (DSM lookup, staff notifications).
 */
import { LEAD_FORM_LABEL, type Clock, type ClockType, type Json, type Lead, type LeadEvent } from '@solar/shared';
import { SYSTEM_USER_ID, type AppContext } from '../auth/context';
import { AppError, notFound } from '../http/errors';
import { ruleOr } from './leadServiceSettings';

/** null for system/cron actors (no human). */
export const actorId = (ctx: AppContext): string | null => (ctx.system || ctx.user.id === SYSTEM_USER_ID ? null : ctx.user.id);

export async function logLeadEvent(ctx: AppContext, leadId: string, eventType: string, summary: string, detail: Record<string, Json> = {}): Promise<LeadEvent> {
  return ctx.db.table('lead_events').insert({ lead_id: leadId, event_type: eventType, summary, actor_id: actorId(ctx), detail: detail as Json });
}

export async function getLead(ctx: AppContext, id: string): Promise<Lead> {
  const lead = await ctx.db.table('leads').get(id);
  if (!lead || lead.deleted_at) throw notFound('Lead');
  return lead;
}

/* ───────────── mandatory fields (Stage 2: Last Action, Next Action, Next Follow-up Date, Owner) ───────────── */
export type MandatoryField = keyof typeof LEAD_FORM_LABEL;
const blank = (v: unknown): boolean => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

export function missingMandatory(lead: Pick<Lead, MandatoryField>): { path: MandatoryField; message: string }[] {
  const out: { path: MandatoryField; message: string }[] = [];
  for (const f of Object.keys(LEAD_FORM_LABEL) as MandatoryField[]) {
    if (blank(lead[f])) out.push({ path: f, message: `${LEAD_FORM_LABEL[f]} is required on every lead` });
  }
  return out;
}

export function assertMandatory(lead: Pick<Lead, MandatoryField>): void {
  const missing = missingMandatory(lead);
  if (missing.length) {
    throw new AppError(422, 'VALIDATION_ERROR', 'Last action, next action, next follow-up date and owner are required on every lead', missing);
  }
}

export interface SaveLeadOptions { skipMandatory?: boolean }

/**
 * The single write path for lead rows. Merges the patch with the stored row and refuses a result in which any of the four
 * mandatory fields would be empty (HTTP 422 with per-field details). Undefined values in the patch are ignored; null / '' blank a field.
 */
/** The customer segment follows from what the customer is: used whenever nobody has chosen one, so the requirement form and the quote never dead-end on a missing segment. */
export function inferSegment(lead: Pick<Lead, 'segment' | 'customer_type' | 'product_interest'>): Lead['segment'] {
  if (lead.segment) return lead.segment;
  const tags = (lead.product_interest ?? []).map((t) => t.toLowerCase());
  if (tags.includes('kusum')) return 'pm_kusum';
  if (tags.includes('rwa')) return 'rwa_ghs';
  switch (lead.customer_type) {
    case 'residential': return 'pmsg_residential';
    case 'housing_society': return 'rwa_ghs';
    case 'commercial': return 'ci_net_metered';
    case 'industrial': return 'ci_captive';
    case 'farmer': return 'pm_kusum';
    case 'government': return 'government_bid';
    default: return tags.includes('pmsg') ? 'pmsg_residential' : null;
  }
}

export async function saveLead(ctx: AppContext, id: string, patch: Partial<Lead>, opts: SaveLeadOptions = {}): Promise<{ before: Lead; after: Lead }> {
  const before = await getLead(ctx, id);
  const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<Lead>;
  if (!opts.skipMandatory) assertMandatory({ ...before, ...defined });
  const seg = inferSegment({ ...before, ...defined });
  if (seg && !before.segment && defined.segment === undefined) defined.segment = seg;
  const after = await ctx.db.table('leads').update(id, defined);
  return { before, after };
}

/* ───────────── people ───────────── */
/** DSM(s) responsible for a territory: the territory's DSM, DSMs whose profile covers it, else every active DSM. */
export async function dsmIds(ctx: AppContext, territoryId: string | null): Promise<string[]> {
  const out = new Set<string>();
  if (territoryId) {
    const t = await ctx.db.table('territories').get(territoryId);
    if (t?.dsm_id) out.add(t.dsm_id);
  }
  const dsms = await ctx.db.table('profiles').all({ role: 'dsm', active: true });
  for (const d of dsms) if (!territoryId || d.territory_ids.includes(territoryId)) out.add(d.id);
  if (!out.size) for (const d of dsms) out.add(d.id);
  return [...out];
}

/** An owner for a lead nobody has been chosen for: territory DSM, then any Sales Manager, then any administrator. */
export async function fallbackOwnerId(ctx: AppContext, territoryId: string | null): Promise<string | null> {
  const dsm = (await dsmIds(ctx, territoryId))[0];
  if (dsm) return dsm;
  for (const role of ['sales_manager', 'regional_head', 'admin'] as const) {
    const p = (await ctx.db.table('profiles').all({ role, active: true }))[0];
    if (p) return p.id;
  }
  return null;
}

export interface StaffNotice {
  user_ids: string[]; kind: string; title: string; body?: string; severity?: 'info' | 'success' | 'warning' | 'critical'; lead_id: string;
  /** also e-mail the recipients (staff, so no customer consent is involved) */
  email?: boolean;
}

/** In-app notification plus an optional e-mail to internal users / channel partners. Never throws — a failed e-mail must not break a workflow. */
export async function notifyStaff(ctx: AppContext, n: StaffNotice): Promise<number> {
  const ids = [...new Set(n.user_ids.filter(Boolean))];
  if (!ids.length) return 0;
  const created = await ctx.svc.notify.notify({ user_ids: ids, kind: n.kind, title: n.title, body: n.body ?? null, severity: n.severity ?? 'info', entity_type: 'lead', entity_id: n.lead_id });
  if (n.email && (await ruleOr<boolean>(ctx, 'followup.email_reminders', true))) {
    const profiles = await ctx.db.table('profiles').all({ id: ids, active: true });
    for (const p of profiles) {
      if (!p.email) continue;
      try {
        await ctx.providers.email.send({ to: p.email, subject: n.title, text: `${n.body ?? n.title}\n\nOpen the lead in the CRM to take action.` });
      } catch (e) { ctx.log.warn({ err: e }, 'staff e-mail failed'); }
    }
  }
  return created;
}

/**
 * Completes the lead's running clock of this type. A clock whose due time has passed but which the minute-tick has not
 * reached yet is first marked breached, so a late completion is never recorded as “met”.
 */
export async function completeLeadClock(ctx: AppContext, leadId: string, type: ClockType, meta?: Json): Promise<Clock | null> {
  const open = (await ctx.svc.clocks.forEntity('lead', leadId)).find((c) => c.clock_type === type && !c.resolved_at);
  if (open && open.status === 'running' && ctx.now().getTime() > new Date(open.due_at).getTime()) {
    await ctx.db.table('clocks').update(open.id, { status: 'breached', breached_at: open.due_at });
  }
  return ctx.svc.clocks.complete('lead', leadId, type, meta);
}
