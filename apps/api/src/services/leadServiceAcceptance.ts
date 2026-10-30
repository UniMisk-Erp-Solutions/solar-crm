/**
 * Stage 1, steps 5–7: assigning a lead, the acceptance loop (accept / reject / reminder → DSM alert → auto-reassignment),
 * manual reassignment, and the escalation to the DSM when nobody is eligible. Every step is written to `lead_events` and `audit_log`.
 */
import { formatDateTime, type Clock, type Json, type Lead, type LeadAssignment } from '@solar/shared';
import type { AppContext } from '../auth/context';
import { AppError, invalidState, notFound } from '../http/errors';
import { audit } from '../lib/audit';
import { cancelFollowups, planNextAction } from './followupService';
import { registerClockHandlers } from './hooks';
import { acceptanceDueAt, DEFAULT_REASSIGN_MINUTES, ruleOr, workingMinutesFrom } from './leadServiceSettings';
import { actorId, completeLeadClock, dsmIds, fallbackOwnerId, getLead, logLeadEvent, notifyStaff, saveLead } from './leadServiceStore';
import { pickOwner, planRouting, resolveGeo, type RoutingCandidate, type RoutingDecision, type RoutingGeo } from './routing';

const iso = (d: Date): string => d.toISOString();
const AUTOMATIC_STEPS: LeadAssignment['step'][] = ['auto', 'reassignment'];

/* ───────────── helpers ───────────── */
async function assignmentsOf(ctx: AppContext, leadId: string): Promise<LeadAssignment[]> {
  return ctx.db.table('lead_assignments').all({ lead_id: leadId }, { orderBy: { col: 'assigned_at', dir: 'asc' } });
}

/** Distributors that already had this lead and did not keep it. */
export async function excludedDistributors(ctx: AppContext, leadId: string): Promise<string[]> {
  const rows = await ctx.db.table('lead_assignments').all({ lead_id: leadId, status: ['rejected', 'expired', 'reassigned'] });
  return [...new Set(rows.map((r) => r.distributor_id).filter((x): x is string => !!x))];
}

async function closePending(ctx: AppContext, leadId: string, status: LeadAssignment['status'], reason: string | null): Promise<LeadAssignment[]> {
  const out: LeadAssignment[] = [];
  for (const a of await ctx.db.table('lead_assignments').all({ lead_id: leadId, status: ['pending', 'accepted'] })) {
    out.push(await ctx.db.table('lead_assignments').update(a.id, { status, responded_at: iso(ctx.now()), ...(reason ? { reason } : {}) }));
  }
  return out;
}

const leadGeo = async (ctx: AppContext, lead: Lead): Promise<RoutingGeo> => {
  const geo = await resolveGeo(ctx, lead.pincode);
  return geo.territory_id || !lead.territory_id ? geo : { ...geo, territory_id: lead.territory_id };
};

/* ───────────── applying a routing outcome ───────────── */
export interface AssignOptions { step: LeadAssignment['step']; reason: string; ownerId?: string | null }

/** Step 5 — record the assignment, set the owner, start the acceptance clock and tell the new owner. */
export async function applyAssignment(ctx: AppContext, lead: Lead, decision: RoutingDecision, opts: AssignOptions): Promise<Lead> {
  const chosen = decision.chosen as RoutingCandidate;
  const dealerId = decision.mode === 'auto' ? null : decision.dealer_id;
  const territoryId = decision.geo.territory_id ?? lead.territory_id;
  const owner = opts.ownerId ?? (await pickOwner(ctx, { distributor_id: chosen.distributor_id, dealer_id: dealerId, territory_id: territoryId })) ?? (await fallbackOwnerId(ctx, territoryId));
  if (!owner) throw new AppError(422, 'VALIDATION_ERROR', 'No user is available to own this lead', [{ path: 'owner_id', message: 'Owner is required on every lead' }]);
  const now = ctx.now();
  const due = await acceptanceDueAt(ctx, lead.temperature, now);
  await closePending(ctx, lead.id, 'reassigned', null);
  const a = await ctx.db.table('lead_assignments').insert({
    lead_id: lead.id, distributor_id: chosen.distributor_id, dealer_id: dealerId, assigned_to: owner, step: opts.step, status: 'pending', reason: opts.reason,
    assigned_at: iso(now), due_at: iso(due), responded_at: null, score_snapshot: decision.snapshot, created_by: ctx.system ? null : ctx.user.id,
  });
  if (lead.status === 'accepted' || lead.status === 'contacted') await cancelFollowups(ctx, lead.id, 'reassigned');
  const { after } = await saveLead(ctx, lead.id, {
    status: 'assigned', distributor_id: chosen.distributor_id, dealer_id: dealerId, owner_id: owner,
    territory_id: territoryId, city: lead.city ?? decision.geo.city, district: lead.district ?? decision.geo.district, state: lead.state ?? decision.geo.state,
    assigned_at: iso(now), accepted_at: null, sla_due_at: iso(due), last_action: `Assigned to ${chosen.name}`, last_action_at: iso(now),
    next_action: 'Accept the lead and contact the customer', next_followup_at: iso(due),
  });
  await ctx.svc.clocks.start({ entity_type: 'lead', entity_id: lead.id, clock_type: 'lead_acceptance', due_at: due, owner_id: owner, meta: { assignment_id: a.id, distributor_id: chosen.distributor_id, step_minutes: await ruleOr<number>(ctx, `sla.lead_acceptance_reassign_minutes.${lead.temperature ?? 'warm'}`, DEFAULT_REASSIGN_MINUTES[lead.temperature ?? 'warm'], now) } });
  await logLeadEvent(ctx, lead.id, 'assigned', `Assigned to ${chosen.name} (${opts.step}); acceptance due ${formatDateTime(iso(due))}`, {
    assignment_id: a.id, step: opts.step, distributor_id: chosen.distributor_id, owner_id: owner, due_at: iso(due), reason: opts.reason, ranking: decision.candidates.slice(0, 5) as unknown as Json,
  });
  await audit(ctx, { action: 'lead.assign', table: 'leads', record_id: lead.id, old: { distributor_id: lead.distributor_id, owner_id: lead.owner_id, status: lead.status } as Json, new: { distributor_id: chosen.distributor_id, owner_id: owner, status: 'assigned', step: opts.step } as Json });
  await notifyStaff(ctx, {
    user_ids: [owner], kind: 'lead.assigned', severity: lead.temperature === 'hot' ? 'critical' : 'info', lead_id: lead.id, email: true,
    title: `New ${lead.temperature ?? 'warm'} lead — ${lead.name}`, body: `Please accept or reject by ${formatDateTime(iso(due))}.${lead.city ? ` ${lead.city}.` : ''}`,
  });
  return after;
}

/** Step 6 — nobody eligible: the lead is `unassigned` and handed to the territory DSM with a notification. */
export async function applyUnassigned(ctx: AppContext, lead: Lead, decision: RoutingDecision, reason: string): Promise<Lead> {
  const territoryId = decision.geo.territory_id ?? lead.territory_id;
  const owner = (await pickOwner(ctx, { distributor_id: null, territory_id: territoryId })) ?? (await fallbackOwnerId(ctx, territoryId));
  if (!owner) throw new AppError(422, 'VALIDATION_ERROR', 'No DSM is available to receive this lead', [{ path: 'owner_id', message: 'Owner is required on every lead' }]);
  const now = ctx.now();
  await closePending(ctx, lead.id, 'expired', null);
  await ctx.svc.clocks.cancel('lead', lead.id, 'lead_acceptance');
  const a = await ctx.db.table('lead_assignments').insert({
    lead_id: lead.id, distributor_id: null, dealer_id: null, assigned_to: owner, step: 'escalation', status: 'pending', reason, assigned_at: iso(now), due_at: null,
    responded_at: null, score_snapshot: decision.snapshot, created_by: ctx.system ? null : ctx.user.id,
  });
  const nextCheck = await workingMinutesFrom(ctx, await ruleOr<number>(ctx, 'sla.lead_acceptance_minutes.warm', 120), now);
  const { after } = await saveLead(ctx, lead.id, {
    status: 'unassigned', distributor_id: null, dealer_id: null, owner_id: owner, territory_id: territoryId, city: lead.city ?? decision.geo.city, district: lead.district ?? decision.geo.district,
    state: lead.state ?? decision.geo.state, assigned_at: null, accepted_at: null, sla_due_at: null, last_action: 'No eligible distributor — escalated to the DSM', last_action_at: iso(now),
    next_action: 'Assign a distributor or reassign the territory', next_followup_at: iso(nextCheck),
  });
  const why = [...new Set(decision.candidates.flatMap((c) => c.reasons))].slice(0, 4);
  await logLeadEvent(ctx, lead.id, 'unassigned', `No eligible distributor — escalated to the DSM. ${reason}`, { assignment_id: a.id, reason, reasons: why, candidates: decision.candidates.length });
  await audit(ctx, { action: 'lead.unassigned', table: 'leads', record_id: lead.id, detail: { reason, reasons: why } as Json });
  await notifyStaff(ctx, {
    user_ids: await dsmIds(ctx, territoryId), kind: 'lead.unassigned', severity: 'warning', lead_id: lead.id, email: true,
    title: `Lead needs a distributor — ${lead.name}`, body: `${reason}${why.length ? ` (${why.join('; ')})` : ''}. Reassign the territory or pick a distributor.`,
  });
  return after;
}

/** Plans the route and applies it: assigned when a distributor is eligible, otherwise unassigned + DSM escalation. */
export async function routeLead(ctx: AppContext, lead: Lead, opts: { step: LeadAssignment['step']; reason: string; exclude?: string[]; ownerId?: string | null; forceDistributorId?: string | null }): Promise<{ lead: Lead; assigned: boolean; decision: RoutingDecision }> {
  const geo = await leadGeo(ctx, lead);
  const decision = await planRouting(ctx, { geo, capacity_kw: lead.capacity_kw, product_interest: lead.product_interest, dealer_id: lead.dealer_id, exclude: opts.exclude, force_distributor_id: opts.forceDistributorId });
  if (decision.chosen && AUTOMATIC_STEPS.includes(opts.step)) {
    const max = await ruleOr<number>(ctx, 'routing.max_auto_reassignments', 3);
    const used = (await assignmentsOf(ctx, lead.id)).filter((a) => AUTOMATIC_STEPS.includes(a.step) && a.distributor_id).length;
    if (used >= max) return { lead: await applyUnassigned(ctx, lead, { ...decision, chosen: null }, `Automatic assignment limit (${max}) reached`), assigned: false, decision };
  }
  if (!decision.chosen) {
    const reason = decision.candidates.length ? 'No distributor is eligible for this pincode, size and product' : 'No distributors are set up';
    return { lead: await applyUnassigned(ctx, lead, decision, reason), assigned: false, decision };
  }
  return { lead: await applyAssignment(ctx, lead, decision, opts), assigned: true, decision };
}

/* ───────────── step 7: accept / reject ───────────── */
export async function acceptLead(ctx: AppContext, leadId: string, opts: { note?: string | null; implicit?: boolean } = {}): Promise<Lead> {
  const lead = await getLead(ctx, leadId);
  if (lead.status !== 'assigned') throw invalidState(`This lead is ${lead.status.replace('_', ' ')} — only a lead awaiting acceptance can be accepted`);
  const pending = (await assignmentsOf(ctx, leadId)).filter((a) => a.status === 'pending').pop();
  const now = iso(ctx.now());
  if (pending) await ctx.db.table('lead_assignments').update(pending.id, { status: 'accepted', responded_at: now });
  const clock = await completeLeadClock(ctx, leadId, 'lead_acceptance', { accepted_by: actorId(ctx) });
  const external = ctx.user.role === 'distributor_user' || ctx.user.role === 'dealer_user';
  await saveLead(ctx, leadId, { status: 'accepted', accepted_at: now, owner_id: external ? ctx.user.id : lead.owner_id });
  await planNextAction(ctx, leadId, { note: 'Make the initial contact with the customer', kind: 'call', lastAction: opts.implicit ? 'Lead accepted by first contact' : 'Lead accepted' });
  const late = clock?.status === 'breached';
  await logLeadEvent(ctx, leadId, 'accepted', `Lead accepted${late ? ' after the SLA' : ' within the SLA'}${opts.note ? ` — ${opts.note}` : ''}`, { assignment_id: pending?.id ?? null, within_sla: !late, implicit: !!opts.implicit, note: opts.note ?? null });
  await audit(ctx, { action: 'lead.accept', table: 'leads', record_id: leadId, old: { status: lead.status } as Json, new: { status: 'accepted', within_sla: !late } as Json });
  return getLead(ctx, leadId);
}

export async function rejectLead(ctx: AppContext, leadId: string, reason: string): Promise<{ lead: Lead; reassigned: boolean }> {
  const lead = await getLead(ctx, leadId);
  if (lead.status !== 'assigned') throw invalidState(`This lead is ${lead.status.replace('_', ' ')} — only a lead awaiting acceptance can be rejected`);
  const pending = (await assignmentsOf(ctx, leadId)).filter((a) => a.status === 'pending').pop();
  if (pending) await ctx.db.table('lead_assignments').update(pending.id, { status: 'rejected', responded_at: iso(ctx.now()), reason });
  await ctx.svc.clocks.cancel('lead', leadId, 'lead_acceptance');
  await logLeadEvent(ctx, leadId, 'rejected', `Lead rejected: ${reason}`, { assignment_id: pending?.id ?? null, reason, distributor_id: pending?.distributor_id ?? lead.distributor_id });
  await audit(ctx, { action: 'lead.reject', table: 'leads', record_id: leadId, old: { status: lead.status, distributor_id: lead.distributor_id } as Json, detail: { reason } as Json });
  await notifyStaff(ctx, { user_ids: await dsmIds(ctx, lead.territory_id), kind: 'lead.rejected', severity: 'info', lead_id: leadId, title: `Lead rejected — ${lead.name}`, body: reason });
  const routed = await routeLead(ctx, lead, { step: 'reassignment', reason: `Rejected by the previous distributor: ${reason}`, exclude: await excludedDistributors(ctx, leadId) });
  return { lead: routed.lead, reassigned: routed.assigned };
}

/** First contact or qualification by the assignee counts as acceptance. Leads not yet routed cannot be worked. */
export async function ensureAcceptedForWork(ctx: AppContext, lead: Lead): Promise<Lead> {
  if (['accepted', 'contacted', 'qualified', 'site_visit', 'nurture'].includes(lead.status)) return lead;
  if (lead.status === 'assigned') return acceptLead(ctx, lead.id, { implicit: true });
  throw invalidState(lead.status === 'unassigned' ? 'This lead has no distributor yet — assign it first' : `A lead that is ${lead.status.replace('_', ' ')} cannot be worked`);
}

/* ───────────── manual reassignment (DSM and above) ───────────── */
export interface ReassignInput { distributor_id?: string; dealer_id?: string; owner_id?: string; auto?: boolean; reason: string }

export async function reassignLead(ctx: AppContext, leadId: string, input: ReassignInput): Promise<Lead> {
  const lead = await getLead(ctx, leadId);
  if (!['validated', 'unassigned', 'assigned', 'accepted'].includes(lead.status)) {
    throw invalidState(`A lead that is ${lead.status.replace('_', ' ')} cannot be re-routed. Change the owner with PATCH /leads/:id instead.`);
  }
  const exclude = await excludedDistributors(ctx, leadId);
  if (lead.distributor_id) exclude.push(lead.distributor_id);
  await closePending(ctx, leadId, 'reassigned', input.reason);
  await ctx.svc.clocks.cancel('lead', leadId, 'lead_acceptance');
  let result: Lead;
  if (input.auto || !input.distributor_id) {
    result = (await routeLead(ctx, lead, { step: 'manual', reason: `Re-routed by ${ctx.user.full_name}: ${input.reason}`, exclude, ownerId: input.owner_id })).lead;
  } else {
    const dist = await ctx.db.table('distributors').get(input.distributor_id);
    if (!dist) throw notFound('Distributor');
    if (dist.status !== 'active') throw new AppError(422, 'VALIDATION_ERROR', `${dist.legal_name} is ${dist.status.replace('_', ' ')} and cannot receive leads`, [{ path: 'distributor_id', message: 'Choose an active distributor' }]);
    if (input.dealer_id) {
      const dealer = await ctx.db.table('dealers').get(input.dealer_id);
      if (!dealer || dealer.distributor_id !== dist.id) throw new AppError(422, 'VALIDATION_ERROR', 'That dealer does not belong to the chosen distributor', [{ path: 'dealer_id', message: 'Choose a dealer of this distributor' }]);
    }
    if (input.owner_id) {
      const owner = await ctx.db.table('profiles').get(input.owner_id);
      if (!owner || !owner.active) throw new AppError(422, 'VALIDATION_ERROR', 'The chosen owner is not an active user', [{ path: 'owner_id', message: 'Choose an active user' }]);
    }
    const geo = await leadGeo(ctx, lead);
    const planned = await planRouting(ctx, { geo, capacity_kw: lead.capacity_kw, product_interest: lead.product_interest });
    const candidate = planned.candidates.find((c) => c.distributor_id === dist.id) ?? { distributor_id: dist.id, name: dist.legal_name, eligible: false, reasons: [], score: dist.score, open_leads: 0, load: 0, band_fit: 0, total: 0 };
    const decision: RoutingDecision = {
      ...planned, mode: 'manual', chosen: candidate, dealer_id: input.dealer_id ?? null,
      snapshot: { ...(planned.snapshot as Record<string, Json>), mode: 'manual', chosen: dist.id, forced_by: ctx.user.id, overrode_ineligibility: candidate.reasons as unknown as Json },
    };
    result = await applyAssignment(ctx, lead, { ...decision, mode: 'manual' }, { step: 'manual', reason: `Reassigned by ${ctx.user.full_name}: ${input.reason}`, ownerId: input.owner_id });
  }
  await audit(ctx, { action: 'lead.reassign', table: 'leads', record_id: leadId, old: { distributor_id: lead.distributor_id, owner_id: lead.owner_id, status: lead.status } as Json, new: { distributor_id: result.distributor_id, owner_id: result.owner_id, status: result.status } as Json, detail: { reason: input.reason } as Json });
  return result;
}

/* ───────────── acceptance clock handlers: Reminder 1 → DSM alert → auto-reassignment ───────────── */
async function awaiting(ctx: AppContext, clock: Clock): Promise<{ lead: Lead; assignment: LeadAssignment | null } | null> {
  const lead = await ctx.db.table('leads').get(clock.entity_id);
  if (!lead || lead.deleted_at || lead.status !== 'assigned') return null;
  const id = (clock.meta as { assignment_id?: string } | null)?.assignment_id;
  const assignment = id ? await ctx.db.table('lead_assignments').get(id) : null;
  if (assignment && assignment.status !== 'pending') return null;
  return { lead, assignment };
}

registerClockHandlers('lead_acceptance', {
  /** Reminder 1 — to the assignee. */
  async onWarn(ctx, clock) {
    const w = await awaiting(ctx, clock);
    if (!w) return;
    await notifyStaff(ctx, {
      user_ids: [clock.owner_id ?? w.lead.owner_id ?? ''], kind: 'lead.acceptance.reminder1', severity: 'warning', lead_id: w.lead.id, email: true,
      title: `Reminder: accept lead ${w.lead.name}`, body: `Most of the acceptance time is used up. Accept or reject before ${formatDateTime(clock.due_at)}.`,
    });
    await logLeadEvent(ctx, w.lead.id, 'acceptance_reminder', 'Reminder 1 sent to the assigned owner', { owner_id: clock.owner_id, due_at: clock.due_at });
  },
  /** DSM alert — the SLA has passed. */
  async onBreach(ctx, clock) {
    const w = await awaiting(ctx, clock);
    if (!w) return;
    await notifyStaff(ctx, {
      user_ids: await dsmIds(ctx, w.lead.territory_id), kind: 'lead.acceptance.dsm_alert', severity: 'critical', lead_id: w.lead.id, email: true,
      title: `Lead not accepted in time — ${w.lead.name}`, body: 'The acceptance SLA has passed. If nobody accepts it, the lead will be re-assigned to the next best distributor.',
    });
    await logLeadEvent(ctx, w.lead.id, 'acceptance_breached', 'Not accepted within the SLA — DSM alerted', { due_at: clock.due_at, assignment_id: w.assignment?.id ?? null });
  },
  /** Auto-reassignment — still unaccepted after the first escalation step. */
  async onEscalate(ctx, clock, level) {
    if (level < 2) return;
    const w = await awaiting(ctx, clock);
    if (!w) return;
    if (w.assignment) await ctx.db.table('lead_assignments').update(w.assignment.id, { status: 'expired', responded_at: iso(ctx.now()), reason: 'Not accepted within the SLA' });
    await logLeadEvent(ctx, w.lead.id, 'acceptance_expired', 'Still not accepted — re-assigning to the next best distributor', { assignment_id: w.assignment?.id ?? null, level });
    const routed = await routeLead(ctx, w.lead, { step: 'reassignment', reason: 'Auto-reassigned: not accepted within the SLA', exclude: await excludedDistributors(ctx, w.lead.id) });
    await logLeadEvent(ctx, w.lead.id, 'auto_reassigned', routed.assigned ? `Auto-reassigned to ${routed.decision.chosen?.name ?? 'the next distributor'}` : 'No other eligible distributor — handed to the DSM', { assigned: routed.assigned, distributor_id: routed.lead.distributor_id });
  },
});

