/**
 * Stage 1, steps 4–7 in "select" mode (rule routing.mode = select): the system ranks the distributors for the lead's pincode, size and
 * product and SUGGESTS the best ones; a person then chooses whom to send the request to (one or several, perfect match or not).
 * The first of them to accept gets the lead; the other open requests close. Everything is written to lead_events and audit_log.
 */
import { formatDateTime, type Json, type Lead, type LeadAssignment, type LeadRequestView, type LeadSuggestion, type LeadSuggestions } from '@solar/shared';
import type { AppContext } from '../auth/context';
import { AppError, invalidState, notFound } from '../http/errors';
import { audit } from '../lib/audit';
import { assignmentsOf, leadGeo } from './leadServiceAcceptance';
import { acceptanceDueAt, ruleOr } from './leadServiceSettings';
import { fallbackOwnerId, getLead, logLeadEvent, notifyStaff, saveLead } from './leadServiceStore';
import { pickOwner, planRouting } from './routing';

const iso = (d: Date): string => d.toISOString();
const RECOMMENDED_COUNT = 3;
const REQUESTABLE: Lead['status'][] = ['validated', 'unassigned', 'assigned'];

/** The ranked list shown when a person decides whom to ask. Writes nothing. */
export async function suggestDistributors(ctx: AppContext, leadId: string): Promise<LeadSuggestions> {
  const lead = await getLead(ctx, leadId);
  const geo = await leadGeo(ctx, lead);
  const plan = await planRouting(ctx, { geo, capacity_kw: lead.capacity_kw, product_interest: lead.product_interest });
  const [dists, rows] = await Promise.all([ctx.db.table('distributors').all({ id: plan.candidates.map((c) => c.distributor_id) }), assignmentsOf(ctx, leadId)]);
  const byId = new Map(dists.map((d) => [d.id, d]));
  const latest = new Map<string, LeadAssignment['status']>();
  for (const a of rows) if (a.distributor_id) latest.set(a.distributor_id, a.status);
  let recommended = 0;
  const candidates: LeadSuggestion[] = plan.candidates.map((c) => {
    const d = byId.get(c.distributor_id);
    const rec = c.eligible && recommended < RECOMMENDED_COUNT;
    if (rec) recommended += 1;
    return {
      distributor_id: c.distributor_id, name: c.name, city: d?.city ?? null, home_pincode: (d?.address as { pincode?: string } | null)?.pincode ?? null,
      eligible: c.eligible, recommended: rec, reasons: c.reasons, score: c.score, open_leads: c.open_leads, band_fit: c.band_fit, proximity: c.proximity ?? 0,
      distance_hint: c.distance_hint ?? null, total: c.total, request_status: latest.get(c.distributor_id) ?? null,
    };
  });
  return { lead_id: lead.id, pincode: lead.pincode, territory_name: geo.territory_name, candidates };
}

/** Sends the request to every chosen distributor at once. The acceptance clock starts with the first request; more can be added while waiting. */
export async function sendRequests(ctx: AppContext, leadId: string, input: { distributor_ids: string[]; note?: string | null }): Promise<Lead> {
  const lead = await getLead(ctx, leadId);
  if (!REQUESTABLE.includes(lead.status)) throw invalidState(`This lead is ${lead.status.replace('_', ' ')} — requests can only be sent while it is waiting for a distributor`);
  const ids = [...new Set(input.distributor_ids)];
  const [dists, rows] = await Promise.all([ctx.db.table('distributors').all({ id: ids }), assignmentsOf(ctx, leadId)]);
  for (const id of ids) {
    const d = dists.find((x) => x.id === id);
    if (!d) throw notFound('Distributor');
    if (d.status !== 'active') throw new AppError(422, 'VALIDATION_ERROR', `${d.legal_name} is ${d.status.replace('_', ' ')} and cannot receive leads`, [{ path: 'distributor_ids', message: 'Choose active distributors' }]);
    if (rows.some((a) => a.distributor_id === id && a.status === 'pending')) throw new AppError(422, 'VALIDATION_ERROR', `${d.legal_name} already has an open request for this lead`, [{ path: 'distributor_ids', message: 'Already asked' }]);
  }
  const geo = await leadGeo(ctx, lead);
  const plan = await planRouting(ctx, { geo, capacity_kw: lead.capacity_kw, product_interest: lead.product_interest });
  const now = ctx.now();
  const running = lead.status === 'assigned' && lead.sla_due_at ? new Date(lead.sla_due_at) : null;
  const due = running ?? (await acceptanceDueAt(ctx, lead.temperature, now));
  const territoryId = geo.territory_id ?? lead.territory_id;
  const names: string[] = [];
  for (const d of dists) {
    const owner = (await pickOwner(ctx, { distributor_id: d.id, territory_id: territoryId })) ?? lead.owner_id ?? (await fallbackOwnerId(ctx, territoryId));
    const cand = plan.candidates.find((c) => c.distributor_id === d.id) ?? null;
    await ctx.db.table('lead_assignments').insert({
      lead_id: lead.id, distributor_id: d.id, dealer_id: null, assigned_to: owner, step: 'manual', status: 'pending', reason: `Request sent by ${ctx.user.full_name}${input.note ? `: ${input.note}` : ''}`,
      assigned_at: iso(now), due_at: iso(due), responded_at: null, score_snapshot: { mode: 'select', geo, chosen: d.id, candidate: cand, picked_from: plan.candidates.slice(0, 8) } as unknown as Json,
      created_by: ctx.system ? null : ctx.user.id,
    });
    names.push(d.legal_name);
  }
  const asked = `${names.slice(0, 3).join(', ')}${names.length > 3 ? ` +${names.length - 3}` : ''}`;
  const { after } = await saveLead(ctx, lead.id, {
    status: 'assigned', distributor_id: null, dealer_id: null, territory_id: territoryId, city: lead.city ?? geo.city, district: lead.district ?? geo.district, state: lead.state ?? geo.state,
    assigned_at: lead.assigned_at ?? iso(now), accepted_at: null, sla_due_at: iso(due), last_action: `Request sent to ${asked}`, last_action_at: iso(now),
    next_action: 'Waiting for a distributor to accept', next_followup_at: iso(due),
  });
  if (!running) {
    await ctx.svc.clocks.start({
      entity_type: 'lead', entity_id: lead.id, clock_type: 'lead_acceptance', due_at: due, owner_id: lead.owner_id,
      meta: { select_mode: true, step_minutes: await ruleOr<number>(ctx, `sla.lead_acceptance_reassign_minutes.${lead.temperature ?? 'warm'}`, 60) },
    });
  }
  await logLeadEvent(ctx, lead.id, 'requests_sent', `Request sent to ${asked}; acceptance due ${formatDateTime(iso(due))}. The first to accept gets the lead.`, { distributor_ids: ids, due_at: iso(due) });
  await audit(ctx, { action: 'lead.requests_sent', table: 'leads', record_id: lead.id, new: { distributor_ids: ids } as Json });
  await notifyStaff(ctx, {
    user_ids: [lead.owner_id ?? ''].filter(Boolean), kind: 'lead.requests_sent', severity: 'info', lead_id: lead.id,
    title: `Request sent for ${lead.name}`, body: `Asked ${asked}. Record who accepts first by ${formatDateTime(iso(due))}.`,
  });
  return after;
}

/** Everything sent so far for the lead page: who was asked, and how each answered. */
export async function requestViews(ctx: AppContext, assignments: LeadAssignment[]): Promise<LeadRequestView[]> {
  const rows = assignments.filter((a) => a.distributor_id);
  const ids = [...new Set(rows.map((a) => a.distributor_id!))];
  const dists = ids.length ? await ctx.db.table('distributors').all({ id: ids }) : [];
  return rows.map((a) => ({
    id: a.id, distributor_id: a.distributor_id, distributor_name: dists.find((d) => d.id === a.distributor_id)?.legal_name ?? null, status: a.status, requested_at: a.assigned_at,
    due_at: a.due_at, responded_at: a.responded_at, reason: a.reason,
  }));
}
