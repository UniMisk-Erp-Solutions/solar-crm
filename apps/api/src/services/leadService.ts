/**
 * Lead read/write service: list decoration, the hydrated lead detail, edits (mandatory fields enforced), nurture, lost, unmask,
 * timeline and score views. Lifecycle pieces live next to it: leadIntake (capture), leadServiceAcceptance (assign / accept / reject / reassign),
 * leadServiceStage2 (contacts, qualification), leadServiceDuplicates (merge, lock override), followupService (follow-up engine).
 */
import {
  CONTACT_OUTCOME_LABEL, LEAD_ACTIVE_STATUSES, daysBetween, maskEmail, maskMobile,
  type Clock, type ContactLog, type Followup, type Json, type Lead, type LeadAssignment, type LeadConsent, type LeadConsentSummary, type LeadConvertBlocker, type LeadCreateInput,
  type LeadDetail, type LeadDuplicateReport, type LeadEvent, type LeadListItem, type LeadNextBestAction, type LeadPatchInput, type LeadScoreView, type LeadSlaState, type LeadTimelineItem,
  type MessageLog,
} from '@solar/shared';
import { isInternal, canSeeMobile, canRead } from '../auth/access';
import type { AppContext } from '../auth/context';
import { AppError, invalidState } from '../http/errors';
import { audit } from '../lib/audit';
import { istMidnight, todayIst } from '../lib/time';
import { evaluateOutbound, getDndMaxAgeDays, getWindowHours, lastInboundWhatsAppAt, activeSuppressionUntil, dndFreshness, windowClosesAt, isWindowOpen } from './consentService';
import { findDuplicates } from './dedupe';
import { captureLead, validationHints, type CaptureResult } from './leadIntake';
import { qualificationGaps } from './leadServiceStage2';
import { cancelFollowups, planNextAction, refreshLeadFollowup, rescheduleNextFollowup, assertFollowupDate } from './followupService';
import { registerJob } from './hooks';
import { getLead, logLeadEvent, notifyStaff, saveLead } from './leadServiceStore';
import { resolveGeo } from './routing';
import { recomputeLeadScore } from './scoring';

const iso = (d: Date): string => d.toISOString();
const EXTERNAL_HIDDEN_KEYS = ['ranking', 'matches', 'customers', 'candidates'];

/* ───────────── SLA state (from the lead's unresolved acceptance / follow-up clocks) ───────────── */
export function slaStateOf(clocks: Pick<Clock, 'status' | 'due_at' | 'warn_at' | 'resolved_at' | 'clock_type'>[], now: Date): LeadSlaState {
  let soon = false;
  for (const c of clocks) {
    if (c.resolved_at || (c.clock_type !== 'lead_acceptance' && c.clock_type !== 'followup')) continue;
    if (c.status === 'breached' || new Date(c.due_at).getTime() <= now.getTime()) return 'breached';
    if (c.warn_at && new Date(c.warn_at).getTime() <= now.getTime()) soon = true;
  }
  return soon ? 'due_soon' : 'ok';
}

/** Lead ids per SLA state, for the `sla_state` list filter. */
export async function slaIdSets(ctx: AppContext): Promise<{ breached: string[]; due_soon: string[] }> {
  const clocks = await ctx.db.table('clocks').all({ entity_type: 'lead', resolved_at: null, status: ['running', 'breached'] });
  const by = new Map<string, Clock[]>();
  for (const c of clocks) by.set(c.entity_id, [...(by.get(c.entity_id) ?? []), c]);
  const now = ctx.now();
  const out = { breached: [] as string[], due_soon: [] as string[] };
  for (const [id, cs] of by) {
    const s = slaStateOf(cs, now);
    if (s === 'breached') out.breached.push(id); else if (s === 'due_soon') out.due_soon.push(id);
  }
  return out;
}

/** Rows for list / kanban: owner and party names, SLA state, overdue flag; mobile and e-mail masked for roles without a need. */
export async function decorateLeads(ctx: AppContext, rows: Lead[]): Promise<LeadListItem[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const uniq = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => !!x))];
  const [owners, dists, dealers, clocks] = await Promise.all([
    ctx.db.table('profiles').all({ id: uniq(rows.map((r) => r.owner_id)) }), ctx.db.table('distributors').all({ id: uniq(rows.map((r) => r.distributor_id)) }),
    ctx.db.table('dealers').all({ id: uniq(rows.map((r) => r.dealer_id)) }), ctx.db.table('clocks').all({ entity_type: 'lead', entity_id: ids, resolved_at: null }),
  ]);
  const now = ctx.now();
  return rows.map((r) => {
    const masked = canSeeMobile(ctx.user.role) ? r : { ...r, mobile: maskMobile(r.mobile), email: r.email ? maskEmail(r.email) : r.email };
    return {
      ...masked, owner_name: owners.find((o) => o.id === r.owner_id)?.full_name ?? null, distributor_name: dists.find((d) => d.id === r.distributor_id)?.legal_name ?? null,
      dealer_name: dealers.find((d) => d.id === r.dealer_id)?.legal_name ?? null, sla_state: slaStateOf(clocks.filter((c) => c.entity_id === r.id), now),
      followup_overdue: !!r.next_followup_at && new Date(r.next_followup_at).getTime() < now.getTime() && LEAD_ACTIVE_STATUSES.includes(r.status),
    };
  });
}

/* ───────────── consent summary ───────────── */
export async function buildConsentSummary(ctx: AppContext, lead: Lead, consents: LeadConsent[]): Promise<LeadConsentSummary> {
  const now = ctx.now();
  const [windowHours, dndMaxAgeDays, lastInboundAt] = await Promise.all([getWindowHours(ctx), getDndMaxAgeDays(ctx), lastInboundWhatsAppAt(ctx, lead.id)]);
  const active = consents.filter((c) => !c.withdrawn_at);
  const suppressed = activeSuppressionUntil(consents, now);
  const matrix = {} as LeadConsentSummary['outbound'];
  for (const ch of ['whatsapp', 'sms', 'email', 'call'] as const) {
    const facts = { lead, consents, now, windowHours, dndMaxAgeDays, lastInboundAt };
    matrix[ch] = { promotional: evaluateOutbound(facts, ch, 'promotional').allowed, service: evaluateOutbound(facts, ch, 'service').allowed };
  }
  const dnd = dndFreshness(lead, now, dndMaxAgeDays);
  return {
    has_active: active.length > 0, withdrawn: consents.length > 0 && active.length === 0, purposes: [...new Set(active.flatMap((c) => c.purposes))], channels: [...new Set(active.flatMap((c) => c.channels))],
    suppress_until: suppressed ? iso(suppressed) : null, suppressed: !!suppressed, dnd_status: lead.dnd_status, dnd_checked_at: lead.dnd_checked_at, dnd_fresh: dnd.fresh,
    whatsapp_window_open: isWindowOpen(lastInboundAt, windowHours, now), whatsapp_window_closes_at: windowClosesAt(lastInboundAt, windowHours)?.toISOString() ?? null, outbound: matrix,
  };
}

/* ───────────── next best action and convert blockers ───────────── */
export function nextBestAction(lead: Lead, gaps: string[], now: Date): LeadNextBestAction {
  const due = lead.next_followup_at;
  const overdue = !!due && new Date(due).getTime() < now.getTime() && LEAD_ACTIVE_STATUSES.includes(lead.status);
  if (overdue) return { code: 'followup_overdue', label: `Follow-up overdue: ${lead.next_action ?? 'contact the customer'}`, due_at: due, urgent: true };
  const a = (code: string, label: string, dueAt: string | null = due, urgent = false): LeadNextBestAction => ({ code, label, due_at: dueAt, urgent });
  switch (lead.status) {
    case 'new': case 'validated': return a('route', 'Routing in progress', null);
    case 'duplicate': return a('review_duplicate', lead.lock_status === 'override_pending' ? 'Sales Manager to decide the lock override' : 'Review the duplicate: merge it or approve it as independent', due, true);
    case 'merged': return a('none', 'Merged into another lead', null);
    case 'unassigned': return a('assign', 'Assign a distributor or reassign the territory', due, true);
    case 'assigned': return a('accept', 'Accept or reject this lead within the SLA', lead.sla_due_at, true);
    case 'accepted': return a('contact', 'Make the initial contact with the customer', due, lead.temperature === 'hot');
    case 'contacted': return a('qualify', gaps.length ? `Complete the qualification call — still needed: ${gaps.join(', ')}` : 'Record the qualification call');
    case 'qualified': return a('site_visit', lead.segment ? 'Schedule the site visit, then convert to an opportunity' : 'Choose the segment, then schedule the site visit');
    case 'site_visit': return a('requirement', 'Complete the requirement form and rate discussion, then convert');
    case 'nurture': return a('reengage', `Re-engage on ${lead.nurture_until ?? 'the agreed date'}`, lead.next_followup_at);
    case 'opportunity': return a('opportunity', 'Work the opportunity', null);
    case 'lost': return a('recycle', 'Lost — recycle to nurture if the customer returns', null);
    case 'won': return a('none', 'Won', null);
    default: return a('none', 'No action', null);
  }
}

/** What stands between this lead and “Convert to opportunity” — the three confirmations of the work instruction plus the lead-side prerequisites. */
export async function convertBlockers(ctx: AppContext, lead: Lead): Promise<LeadConvertBlocker[]> {
  const out: LeadConvertBlocker[] = [];
  const add = (code: string, message: string) => out.push({ code, message });
  if (!['qualified', 'site_visit'].includes(lead.status)) add('status_not_ready', `The lead is ${lead.status.replace('_', ' ')} — it must be qualified (or at site-visit stage) before conversion`);
  if (!lead.segment) add('segment_missing', 'Segment is required before a quote can be prepared');
  if (lead.capacity_kw === null) add('capacity_missing', 'System size (kW) is not captured');
  if (!(await ctx.db.table('lead_consents').count({ lead_id: lead.id, withdrawn_at: null }))) add('consent_missing', 'No active consent on record — capture consent before sending quotes');
  const form = await ctx.db.table('requirement_forms').count({ lead_id: lead.id, completed_at: { is_null: false } });
  if (!lead.requirement_text?.trim() && !form) add('requirement_unconfirmed', 'Requirement is not confirmed — complete the qualification call or the requirement form');
  if (!lead.timeline_bucket || lead.timeline_bucket === 'unknown') add('timeline_unconfirmed', 'Timeline is not confirmed');
  const negotiations = await ctx.db.table('negotiation_logs').count({ lead_id: lead.id });
  if (lead.budget_inr === null && !negotiations) add('commercial_potential_unconfirmed', 'Commercial potential is not confirmed — capture the budget or log the rate discussion');
  return out;
}

/* ───────────── detail ───────────── */
function redactEvent(e: LeadEvent): LeadEvent {
  const d = e.detail;
  if (!d || typeof d !== 'object' || Array.isArray(d)) return e;
  const copy = { ...(d as Record<string, Json>) };
  for (const k of EXTERNAL_HIDDEN_KEYS) delete copy[k];
  return { ...e, detail: copy };
}

export async function visibleDuplicates(ctx: AppContext, lead: Lead): Promise<LeadDuplicateReport> {
  const report = await findDuplicates(ctx, { mobile: lead.mobile, email: lead.email, consumer_no: lead.consumer_no, name: lead.name, pincode: lead.pincode }, { excludeLeadId: lead.id });
  if (isInternal(ctx.user.role)) return report;
  const rows = report.leads.length ? await ctx.db.table('leads').all({ id: report.leads.map((m) => m.lead_id) }) : [];
  const readable = new Set<string>();
  for (const r of rows) if (await canRead(ctx, 'leads', r)) readable.add(r.id);
  const leads = report.leads.filter((m) => readable.has(m.lead_id));
  return { leads, customers: [], checked_at: report.checked_at, hidden: report.leads.length - leads.length + report.customers.length };
}

export async function getLeadDetail(ctx: AppContext, id: string): Promise<LeadDetail> {
  const lead = await getLead(ctx, id);
  const [events, consents, assignments, followups, contacts, scores, clocks, opps, dups, owner, dist, dealer, territory] = await Promise.all([
    ctx.db.table('lead_events').all({ lead_id: id }, { orderBy: { col: 'created_at', dir: 'desc' } }),
    ctx.db.table('lead_consents').all({ lead_id: id }, { orderBy: { col: 'granted_at', dir: 'desc' } }),
    ctx.db.table('lead_assignments').all({ lead_id: id }, { orderBy: { col: 'assigned_at', dir: 'desc' } }),
    ctx.db.table('followups').all({ lead_id: id }, { orderBy: { col: 'due_at', dir: 'desc' } }),
    ctx.db.table('contact_logs').all({ lead_id: id }, { orderBy: { col: 'occurred_at', dir: 'desc' } }),
    ctx.db.table('lead_scores').all({ lead_id: id }, { orderBy: { col: 'computed_at', dir: 'asc' } }),
    ctx.svc.clocks.forEntity('lead', id),
    ctx.db.table('opportunities').all({ lead_id: id }),
    visibleDuplicates(ctx, lead),
    lead.owner_id ? ctx.db.table('profiles').get(lead.owner_id) : Promise.resolve(null),
    lead.distributor_id ? ctx.db.table('distributors').get(lead.distributor_id) : Promise.resolve(null),
    lead.dealer_id ? ctx.db.table('dealers').get(lead.dealer_id) : Promise.resolve(null),
    lead.territory_id ? ctx.db.table('territories').get(lead.territory_id) : Promise.resolve(null),
  ]);
  const external = !isInternal(ctx.user.role);
  const gaps = await qualificationGaps(ctx, lead);
  const blockers = await convertBlockers(ctx, lead);
  const shown = canSeeMobile(ctx.user.role) ? lead : { ...lead, mobile: maskMobile(lead.mobile), email: lead.email ? maskEmail(lead.email) : lead.email };
  const own = (a: LeadAssignment) => a.distributor_id === ctx.user.distributor_id || (!!a.dealer_id && a.dealer_id === ctx.user.dealer_id);
  return {
    lead: { ...shown, owner_name: owner?.full_name ?? null, distributor_name: dist?.legal_name ?? null, dealer_name: dealer?.legal_name ?? null, territory_name: territory?.name ?? null },
    events: external ? events.map(redactEvent) : events, consents, consent_summary: await buildConsentSummary(ctx, lead, consents),
    assignments: external ? assignments.filter(own).map((a) => ({ ...a, score_snapshot: {} })) : assignments, followups, contact_logs: contacts, score: scores.at(-1) ?? null,
    clocks: clocks.filter((c) => !c.resolved_at), duplicates: dups, customer_id: lead.customer_id, site_id: lead.site_id, opportunity_ids: opps.map((o) => o.id),
    next_best_action: nextBestAction(lead, gaps, ctx.now()), convert_blockers: blockers, can_convert: blockers.length === 0, validation_hints: validationHints(lead),
    first_response_minutes: lead.first_contacted_at ? Math.max(0, Math.round((new Date(lead.first_contacted_at).getTime() - new Date(lead.created_at).getTime()) / 60000)) : null,
    qualification_gaps: gaps,
  };
}

/* ───────────── create / update ───────────── */
/** Internal manual lead form. External users enter leads for their own party and accept them at once. */
export async function createManualLead(ctx: AppContext, input: LeadCreateInput): Promise<CaptureResult> {
  const u = ctx.user;
  let dealerId = input.dealer_id, distributorId = input.distributor_id, selfAccept = false;
  let source = input.source;
  if (u.role === 'dealer_user') {
    if (!u.dealer_id) throw new AppError(403, 'FORBIDDEN', 'Your account is not linked to a dealer');
    dealerId = u.dealer_id; distributorId = u.distributor_id ?? undefined; selfAccept = true; source = 'dealer_upload';
  } else if (u.role === 'distributor_user') {
    if (!u.distributor_id) throw new AppError(403, 'FORBIDDEN', 'Your account is not linked to a distributor');
    distributorId = u.distributor_id; selfAccept = true;
    if (dealerId) {
      const d = await ctx.db.table('dealers').get(dealerId);
      if (!d || d.distributor_id !== u.distributor_id) throw new AppError(422, 'VALIDATION_ERROR', 'That dealer does not belong to your distributor', [{ path: 'dealer_id', message: 'Choose one of your dealers' }]);
    }
  }
  return captureLead(ctx, {
    source, origin: 'internal', name: input.name, mobile: input.mobile, email: input.email ?? null, pincode: input.pincode, city: input.city, district: input.district, state: input.state,
    segment: input.segment, customer_type: input.customer_type, capacity_kw: input.capacity_kw, product_interest: input.product_interest, consumer_no: input.consumer_no, language: input.language,
    requirement_text: input.requirement_text, notes: input.notes, bill_captured: input.bill_captured, timeline_bucket: input.timeline_bucket ?? undefined, dealer_id: dealerId, distributor_id: distributorId, owner_id: input.owner_id,
    source_ref: input.source_ref, provenance: { ...(input.provenance as Record<string, Json> | undefined), entered_by: u.id }, consent: input.consent, selfAccept,
  });
}

const SCORING_FIELDS = ['segment', 'capacity_kw', 'requirement_text', 'timeline_bucket', 'budget_inr', 'decision_maker', 'decision_maker_access', 'bill_captured'] as const;

export async function updateLead(ctx: AppContext, id: string, patch: LeadPatchInput): Promise<Lead> {
  const before = await getLead(ctx, id);
  if (before.status === 'merged' || before.anonymised_at) throw invalidState('This lead is closed for editing');
  const { next_followup_at, owner_id, ...rest } = patch;
  const change: Partial<Lead> = { ...rest } as Partial<Lead>;

  if (owner_id !== undefined) {
    if (owner_id === null) change.owner_id = null; // refused by the mandatory-field check below
    else {
      const owner = await ctx.db.table('profiles').get(owner_id);
      if (!owner || !owner.active) throw new AppError(422, 'VALIDATION_ERROR', 'The chosen owner is not an active user', [{ path: 'owner_id', message: 'Choose an active user' }]);
      if (!isInternal(ctx.user.role) && owner.distributor_id !== ctx.user.distributor_id) throw new AppError(403, 'FORBIDDEN', 'You can only assign leads to users of your own organisation');
      change.owner_id = owner_id;
    }
  }
  if (patch.pincode && patch.pincode !== before.pincode) {
    const geo = await resolveGeo(ctx, patch.pincode);
    Object.assign(change, { city: patch.city ?? geo.city ?? before.city, district: patch.district ?? geo.district ?? before.district, state: patch.state ?? geo.state ?? before.state, territory_id: geo.territory_id ?? before.territory_id });
  }
  if (patch.last_action) change.last_action_at = iso(ctx.now());
  if (next_followup_at === null) change.next_followup_at = null; // refused by the mandatory-field check below
  const due = typeof next_followup_at === 'string' ? new Date(next_followup_at) : null;
  if (due) await assertFollowupDate(ctx, due);

  const { after } = await saveLead(ctx, id, change);
  if (due && due.toISOString() !== new Date(before.next_followup_at ?? 0).toISOString()) await rescheduleNextFollowup(ctx, id, due, patch.next_action ?? null);
  else if (patch.next_action && patch.next_action !== before.next_action) {
    const open = (await ctx.db.table('followups').all({ lead_id: id, status: 'open' }, { orderBy: { col: 'due_at', dir: 'asc' } }))[0];
    if (open) await ctx.db.table('followups').update(open.id, { note: patch.next_action });
  }
  if (owner_id && owner_id !== before.owner_id) {
    await ctx.db.table('followups').updateWhere({ lead_id: id, status: 'open' }, { owner_id });
    await refreshLeadFollowup(ctx, id);
  }
  if (SCORING_FIELDS.some((f) => patch[f] !== undefined)) await recomputeLeadScore(ctx, id);

  const fresh = await getLead(ctx, id);
  const changed = Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined);
  const pick = (l: Lead) => Object.fromEntries(changed.map((k) => [k, (l as unknown as Record<string, Json>)[k] ?? null])) as Json;
  await logLeadEvent(ctx, id, 'updated', `Lead updated: ${changed.join(', ')}`, { fields: changed });
  await audit(ctx, { action: 'lead.update', table: 'leads', record_id: id, old: pick(before), new: pick(fresh) });
  return after.id === fresh.id ? fresh : after;
}

/* ───────────── nurture, lost, unmask ───────────── */
export const MAX_NURTURE_DAYS = 730;

export async function nurtureLead(ctx: AppContext, id: string, input: { reason: string; nurture_until: string }): Promise<Lead> {
  const lead = await getLead(ctx, id);
  if (!['accepted', 'contacted', 'qualified', 'site_visit', 'lost', 'nurture'].includes(lead.status)) {
    throw invalidState(`A lead that is ${lead.status.replace('_', ' ')} cannot be parked in nurture`);
  }
  const days = daysBetween(todayIst(ctx.now()), input.nurture_until);
  if (days < 1 || days > MAX_NURTURE_DAYS) throw new AppError(422, 'VALIDATION_ERROR', `Choose a re-engagement date between tomorrow and ${MAX_NURTURE_DAYS} days ahead`, [{ path: 'nurture_until', message: 'Date out of range' }]);
  const due = new Date(istMidnight(input.nurture_until).getTime() + 10 * 3600_000); // 10:00 IST on the day
  await cancelFollowups(ctx, id, 'nurture');
  await ctx.svc.clocks.cancel('lead', id, 'lead_acceptance');
  await saveLead(ctx, id, { status: 'nurture', nurture_until: input.nurture_until, nurture_reason: input.reason, lost_reason: null, last_action: `Moved to nurture: ${input.reason}`.slice(0, 300), last_action_at: iso(ctx.now()) });
  await planNextAction(ctx, id, { note: `Re-engage the customer (nurture until ${input.nurture_until})`, kind: 'call', due_at: due, lastAction: `Moved to nurture: ${input.reason}`, ignoreMax: true });
  await logLeadEvent(ctx, id, 'nurture', `Moved to nurture until ${input.nurture_until}: ${input.reason}`, { reason: input.reason, nurture_until: input.nurture_until, from: lead.status });
  await audit(ctx, { action: 'lead.nurture', table: 'leads', record_id: id, old: { status: lead.status } as Json, new: { status: 'nurture', nurture_until: input.nurture_until } as Json, detail: { reason: input.reason } as Json });
  return getLead(ctx, id);
}

export async function markLeadLost(ctx: AppContext, id: string, reason: string): Promise<Lead> {
  const lead = await getLead(ctx, id);
  if (['lost', 'won', 'opportunity', 'merged', 'duplicate'].includes(lead.status)) throw invalidState(`A lead that is ${lead.status} cannot be marked lost`);
  for (const a of await ctx.db.table('lead_assignments').all({ lead_id: id, status: 'pending' })) await ctx.db.table('lead_assignments').update(a.id, { status: 'expired', responded_at: iso(ctx.now()), reason: 'Lead lost' });
  await cancelFollowups(ctx, id, 'lost');
  await ctx.svc.clocks.cancel('lead', id);
  await saveLead(ctx, id, {
    status: 'lost', lost_reason: reason, nurture_until: null, nurture_reason: null, lock_status: 'open', locked_by_dealer_id: null, last_action: `Marked lost: ${reason}`.slice(0, 300), last_action_at: iso(ctx.now()),
    next_action: 'Closed — recycle to nurture if the customer returns', next_followup_at: lead.next_followup_at ?? iso(ctx.now()),
  });
  await logLeadEvent(ctx, id, 'lost', `Marked lost: ${reason}`, { reason, from: lead.status });
  await audit(ctx, { action: 'lead.lost', table: 'leads', record_id: id, old: { status: lead.status } as Json, new: { status: 'lost' } as Json, detail: { reason } as Json });
  return getLead(ctx, id);
}

/** Full mobile and e-mail — a separate, audited action (privacy by default). */
export async function unmaskLead(ctx: AppContext, id: string, reason: string): Promise<{ mobile: string; email: string | null }> {
  const lead = await getLead(ctx, id);
  await audit(ctx, { action: 'mobile.unmask', table: 'leads', record_id: id, detail: { reason, role: ctx.user.role } as Json });
  await logLeadEvent(ctx, id, 'mobile_unmasked', `${ctx.user.full_name} viewed the full contact details`, { reason, role: ctx.user.role });
  return { mobile: lead.mobile, email: lead.email };
}

/* ───────────── timeline and score ───────────── */
export async function leadTimeline(ctx: AppContext, id: string, limit: number, offset: number): Promise<{ items: LeadTimelineItem[]; total: number }> {
  await getLead(ctx, id);
  const [events, contacts, messages, followups] = await Promise.all([
    ctx.db.table('lead_events').all({ lead_id: id }), ctx.db.table('contact_logs').all({ lead_id: id }), ctx.db.table('message_log').all({ lead_id: id }),
    ctx.db.table('followups').all({ lead_id: id, status: ['done', 'missed'] }),
  ]);
  const external = !isInternal(ctx.user.role);
  const items: LeadTimelineItem[] = [
    ...events.map((e): LeadTimelineItem => ({ at: e.created_at, kind: 'event', type: e.event_type, summary: e.summary, actor_id: e.actor_id, detail: (external ? redactEvent(e) : e).detail })),
    ...contacts.map((c: ContactLog): LeadTimelineItem => ({ at: c.occurred_at, kind: 'contact', type: c.outcome, summary: `${c.channel} ${c.direction}: ${CONTACT_OUTCOME_LABEL[c.outcome]}${c.notes ? ` — ${c.notes}` : ''}`, actor_id: c.logged_by, detail: { channel: c.channel, duration_min: c.duration_min } })),
    ...messages.map((m: MessageLog): LeadTimelineItem => ({ at: m.created_at, kind: 'message', type: `${m.direction}_${m.status}`, summary: `${m.direction === 'inbound' ? 'Received' : m.status === 'blocked' ? 'Blocked' : 'Sent'} ${m.channel} (${m.purpose})${m.block_reason ? `: ${m.block_reason}` : ''}`, actor_id: m.created_by, detail: { template_key: m.template_key, status: m.status } })),
    ...followups.map((f: Followup): LeadTimelineItem => ({ at: f.done_at ?? f.due_at, kind: 'followup', type: f.status, summary: `Follow-up ${f.status}: ${f.note ?? ''}`.trim(), actor_id: f.owner_id, detail: { outcome: f.outcome } })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  return { items: items.slice(offset, offset + limit), total: items.length };
}

export async function leadScoreView(ctx: AppContext, id: string, recompute: boolean): Promise<LeadScoreView> {
  await getLead(ctx, id);
  const outcome = await recomputeLeadScore(ctx, id, { force: recompute });
  const history = (await ctx.db.table('lead_scores').all({ lead_id: id }, { orderBy: { col: 'computed_at', dir: 'asc' } })).reverse().slice(0, 10);
  return {
    score: outcome.score.score, components: outcome.score.components, computed_at: outcome.score.computed_at, temperature: outcome.lead.temperature,
    deadline_uplift: outcome.lead.deadline_uplift, history: history.map((h) => ({ score: h.score, computed_at: h.computed_at })),
  };
}

/* ───────────── nightly job: re-activate nurture leads whose date has come ───────────── */
registerJob({
  name: 'lead.nurture_reactivation', schedule: '15 2 * * *',
  async run(ctx) {
    const today = todayIst(ctx.now());
    const due = await ctx.db.table('leads').all({ status: 'nurture', nurture_until: { lte: today }, deleted_at: null });
    let reactivated = 0;
    for (const lead of due) {
      try {
        await cancelFollowups(ctx, lead.id, 'nurture ended');
        await saveLead(ctx, lead.id, { status: 'contacted', nurture_until: null, nurture_reason: null, last_action: 'Nurture period ended — lead re-activated', last_action_at: iso(ctx.now()) });
        await planNextAction(ctx, lead.id, { note: 'Re-engage the customer — the nurture date has arrived', kind: 'call', lastAction: 'Nurture period ended — lead re-activated', due_at: new Date(ctx.now().getTime() + 4 * 3600_000) });
        await logLeadEvent(ctx, lead.id, 'nurture_reactivated', `Nurture date ${lead.nurture_until ?? ''} reached — lead re-activated`, { nurture_until: lead.nurture_until, previous_reason: lead.nurture_reason });
        await audit(ctx, { action: 'lead.nurture_reactivate', table: 'leads', record_id: lead.id, detail: { nurture_until: lead.nurture_until } as Json });
        if (lead.owner_id) await notifyStaff(ctx, { user_ids: [lead.owner_id], kind: 'lead.nurture_due', severity: 'info', lead_id: lead.id, email: true, title: `Time to re-engage — ${lead.name}`, body: lead.nurture_reason ?? 'The nurture period has ended.' });
        reactivated++;
      } catch (e) { ctx.log.error({ err: e, lead: lead.id }, 'nurture re-activation failed for one lead'); }
    }
    return { due: due.length, reactivated };
  },
});

