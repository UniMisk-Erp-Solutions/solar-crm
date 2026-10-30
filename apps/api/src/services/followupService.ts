/**
 * Stage 2, steps 12–13 — the CRM follow-up engine.
 *
 *  - One `followups` row per planned action; the lead's “Next action / Next follow-up date” mirror the earliest open one.
 *  - A `followup` clock (entity = the lead) runs to that follow-up’s due time. Warn at 70 % → reminder to the owner (in-app + e-mail);
 *    breach → the follow-up is marked `missed`, owner reminded, kernel escalation continues owner → DSM → Sales Manager → Management.
 *  - Customer-facing reminders are never sent from here — they go through ctx.svc.messaging.send (consent aware).
 */
import { formatDateTime, type Clock, type ContactOutcome, type Followup, type FollowupKind, type Lead, type LeadStatus } from '@solar/shared';
import type { AppContext } from '../auth/context';
import { AppError, conflict, notFound } from '../http/errors';
import { audit } from '../lib/audit';
import { istEndOfDay, todayIst } from '../lib/time';
import { registerClockHandlers } from './hooks';
import { completeLeadClock, getLead, logLeadEvent, notifyStaff, saveLead } from './leadServiceStore';
import { defaultFollowupAt, ruleOr, workingMinutesFrom } from './leadServiceSettings';

const iso = (d: Date): string => d.toISOString();

/* ───────────── validation ───────────── */
/** A follow-up must be in the future (one minute of grace for clock skew) and within `followup.max_days_ahead`. */
export async function assertFollowupDate(ctx: AppContext, due: Date, path = 'next_followup_at', opts: { ignoreMax?: boolean } = {}): Promise<void> {
  const now = ctx.now().getTime();
  const max = await ruleOr<number>(ctx, 'followup.max_days_ahead', 180);
  if (Number.isNaN(due.getTime())) throw new AppError(422, 'VALIDATION_ERROR', 'Enter a valid follow-up date and time', [{ path, message: 'Invalid date' }]);
  if (due.getTime() < now - 60_000) throw new AppError(422, 'VALIDATION_ERROR', 'The next follow-up must be in the future', [{ path, message: 'Choose a date and time that has not passed' }]);
  if (!opts.ignoreMax && due.getTime() > now + max * 86_400_000) throw new AppError(422, 'VALIDATION_ERROR', `The next follow-up can be at most ${max} days ahead`, [{ path, message: `Choose a date within ${max} days` }]);
}

/* ───────────── core: schedule, refresh, complete ───────────── */
const openFollowups = (ctx: AppContext, leadId: string): Promise<Followup[]> =>
  ctx.db.table('followups').all({ lead_id: leadId, status: 'open' }, { orderBy: { col: 'due_at', dir: 'asc' } });

async function currentFollowupClock(ctx: AppContext, leadId: string): Promise<Clock | null> {
  return (await ctx.svc.clocks.forEntity('lead', leadId)).find((c) => c.clock_type === 'followup' && !c.resolved_at) ?? null;
}

/**
 * Keeps the lead’s next_* fields and the follow-up clock aligned with the earliest open follow-up.
 * The clock is only restarted when the earliest follow-up changed, so escalation state is not reset by unrelated edits.
 */
export async function refreshLeadFollowup(ctx: AppContext, leadId: string): Promise<Followup | null> {
  const first = (await openFollowups(ctx, leadId))[0] ?? null;
  if (!first) { await ctx.svc.clocks.cancel('lead', leadId, 'followup'); return null; }
  const lead = await getLead(ctx, leadId);
  if (lead.next_followup_at !== first.due_at || (first.note && lead.next_action !== first.note)) {
    await saveLead(ctx, leadId, { next_followup_at: first.due_at, ...(first.note ? { next_action: first.note } : {}) });
  }
  const cur = await currentFollowupClock(ctx, leadId);
  const meta = (cur?.meta ?? {}) as { followup_id?: string };
  if (!cur || meta.followup_id !== first.id || new Date(cur.due_at).getTime() !== new Date(first.due_at).getTime()) {
    await ctx.svc.clocks.start({ entity_type: 'lead', entity_id: leadId, clock_type: 'followup', due_at: first.due_at, owner_id: first.owner_id ?? lead.owner_id, meta: { followup_id: first.id } });
  }
  return first;
}

export interface ScheduleInput { kind: FollowupKind; due_at: Date; note: string; owner_id?: string | null }

/** Adds a follow-up. `replaceOpen` supersedes the lead’s current open follow-ups (used when the lead’s next action is rescheduled). */
export async function scheduleFollowup(ctx: AppContext, leadId: string, input: ScheduleInput, opts: { replaceOpen?: boolean; ignoreMax?: boolean } = {}): Promise<Followup> {
  const lead = await getLead(ctx, leadId);
  await assertFollowupDate(ctx, input.due_at, 'due_at', { ignoreMax: opts.ignoreMax });
  const owner = input.owner_id ?? lead.owner_id;
  if (!owner) throw new AppError(422, 'VALIDATION_ERROR', 'Owner is required on every lead', [{ path: 'owner_id', message: 'Owner is required on every lead' }]);
  if (opts.replaceOpen) {
    for (const f of await openFollowups(ctx, leadId)) await ctx.db.table('followups').update(f.id, { status: 'cancelled', outcome: 'rescheduled' });
  }
  const row = await ctx.db.table('followups').insert({
    lead_id: leadId, kind: input.kind, due_at: iso(input.due_at), note: input.note, status: 'open', done_at: null, owner_id: owner, outcome: null,
    reminder_sent_at: null, escalated_level: 0, created_by: ctx.system ? null : ctx.user.id,
  });
  await refreshLeadFollowup(ctx, leadId);
  await logLeadEvent(ctx, leadId, 'followup_scheduled', `Follow-up planned for ${formatDateTime(row.due_at)}: ${input.note}`, { followup_id: row.id, kind: row.kind, due_at: row.due_at, note: row.note });
  return row;
}

/**
 * Moves the lead’s earliest open follow-up to a new time (PATCH next_followup_at), or creates one when none is open
 * (for instance after the previous one was missed). Resets reminders and escalation for the moved follow-up.
 */
export async function rescheduleNextFollowup(ctx: AppContext, leadId: string, due: Date, note: string | null): Promise<Followup> {
  await assertFollowupDate(ctx, due);
  const lead = await getLead(ctx, leadId);
  const first = (await openFollowups(ctx, leadId))[0];
  if (!first) return scheduleFollowup(ctx, leadId, { kind: 'call', due_at: due, note: note ?? lead.next_action ?? 'Follow up with the customer' });
  const moved = await ctx.db.table('followups').update(first.id, { due_at: iso(due), reminder_sent_at: null, escalated_level: 0, ...(note ? { note } : {}) });
  await refreshLeadFollowup(ctx, leadId);
  await logLeadEvent(ctx, leadId, 'followup_rescheduled', `Next follow-up moved to ${formatDateTime(moved.due_at)}`, { followup_id: moved.id, from: first.due_at, to: moved.due_at });
  return moved;
}

export interface CompleteInput { outcome: string; next_action: string; next_followup_at: Date; next_kind: FollowupKind; last_action?: string | null }

/** Completes (or late-completes a missed) follow-up and schedules the next one — next action and date are mandatory. */
export async function completeFollowup(ctx: AppContext, followupId: string, input: CompleteInput): Promise<{ followup: Followup; next: Followup; lead: Lead }> {
  const fu = await ctx.db.table('followups').get(followupId);
  if (!fu) throw notFound('Follow-up');
  if (fu.status !== 'open' && fu.status !== 'missed') throw conflict(`This follow-up is already ${fu.status}`);
  await assertFollowupDate(ctx, input.next_followup_at);
  const now = ctx.now();
  const clock = await currentFollowupClock(ctx, fu.lead_id);
  if (clock && (clock.meta as { followup_id?: string }).followup_id === fu.id) {
    await completeLeadClock(ctx, fu.lead_id, 'followup', { completed_followup_id: fu.id });
  }
  const done = await ctx.db.table('followups').update(fu.id, { status: 'done', done_at: iso(now), outcome: input.outcome });
  const next = await ctx.db.table('followups').insert({
    lead_id: fu.lead_id, kind: input.next_kind, due_at: iso(input.next_followup_at), note: input.next_action, status: 'open', done_at: null, owner_id: fu.owner_id,
    outcome: null, reminder_sent_at: null, escalated_level: 0, created_by: ctx.system ? null : ctx.user.id,
  });
  await saveLead(ctx, fu.lead_id, { last_action: input.last_action ?? `Follow-up done: ${input.outcome}`.slice(0, 300), last_action_at: iso(now) });
  await refreshLeadFollowup(ctx, fu.lead_id);
  const late = new Date(fu.due_at).getTime() < now.getTime();
  await logLeadEvent(ctx, fu.lead_id, 'followup_completed', `Follow-up ${late ? 'completed late' : 'completed'}: ${input.outcome}`, { followup_id: fu.id, late, outcome: input.outcome, next_followup_id: next.id, next_due_at: next.due_at });
  await audit(ctx, { action: 'followup.complete', table: 'followups', record_id: fu.id, old: fu as never, new: done as never });
  return { followup: done, next, lead: await getLead(ctx, fu.lead_id) };
}

/** First follow-up after a status change (accepted, contacted, qualified…): default time from the temperature SLA unless given. */
export async function planNextAction(ctx: AppContext, leadId: string, a: { note: string; kind?: FollowupKind; due_at?: Date | null; lastAction: string; replaceOpen?: boolean; ignoreMax?: boolean }): Promise<Followup> {
  const lead = await getLead(ctx, leadId);
  const due = a.due_at ?? (await defaultFollowupAt(ctx, lead.temperature));
  await saveLead(ctx, leadId, { last_action: a.lastAction.slice(0, 300), last_action_at: iso(ctx.now()) });
  return scheduleFollowup(ctx, leadId, { kind: a.kind ?? 'call', due_at: due, note: a.note }, { replaceOpen: a.replaceOpen ?? true, ignoreMax: a.ignoreMax });
}

/** Closes every open follow-up and the clock (lead lost, merged, converted…). */
export async function cancelFollowups(ctx: AppContext, leadId: string, reason: string): Promise<void> {
  for (const f of await ctx.db.table('followups').all({ lead_id: leadId, status: ['open', 'missed'] })) {
    await ctx.db.table('followups').update(f.id, { status: 'cancelled', outcome: reason });
  }
  await ctx.svc.clocks.cancel('lead', leadId, 'followup');
}

/* ───────────── default next steps after a contact attempt ───────────── */
export interface NextStep { action: string; kind: FollowupKind; minutes?: number; byTemperature?: boolean }
const NEXT_BY_OUTCOME: Record<ContactOutcome, NextStep> = {
  connected_interested: { action: 'Qualification call — requirement, timeline, budget, decision maker', kind: 'call', byTemperature: true },
  connected_not_now: { action: 'Call back as agreed with the customer', kind: 'call', byTemperature: true },
  connected_not_interested: { action: 'Confirm the reason and move to nurture or mark lost', kind: 'call', minutes: 1440 },
  no_answer: { action: 'Call again — no answer last time', kind: 'call', minutes: -1 },
  busy_call_back: { action: 'Call back — customer was busy', kind: 'call', minutes: -1 },
  wrong_number: { action: 'Verify the contact number with the source', kind: 'task', minutes: 1440 },
  message_delivered: { action: 'Follow up the message with a call', kind: 'call', minutes: 1440 },
  message_replied: { action: 'Reply to the customer and start the qualification', kind: 'call', minutes: 240 },
  visit_done: { action: 'Update the requirement and qualification after the visit', kind: 'task', minutes: 1440 },
  visit_rescheduled: { action: 'Visit the customer at the new time', kind: 'visit', minutes: 1440 },
};
export const nextStepFor = (o: ContactOutcome): NextStep => NEXT_BY_OUTCOME[o];

export async function dueFor(ctx: AppContext, step: NextStep, lead: Pick<Lead, 'temperature'>): Promise<Date> {
  if (step.byTemperature) return defaultFollowupAt(ctx, lead.temperature);
  const mins = step.minutes === -1 ? await ruleOr<number>(ctx, 'followup.retry_minutes', 240) : step.minutes ?? 1440;
  return workingMinutesFrom(ctx, mins);
}

/* ───────────── work-list ───────────── */
export type FollowupBucket = 'due_today' | 'overdue' | 'upcoming' | 'all';

export interface FollowupRow extends Followup { lead_name: string; lead_status: LeadStatus; lead_temperature: Lead['temperature']; lead_mobile: string; overdue: boolean }

export async function listFollowups(ctx: AppContext, q: { bucket: FollowupBucket; scope: 'mine' | 'team'; status?: string; limit: number; offset: number }, leadScope: string[] | null): Promise<{ rows: FollowupRow[]; total: number }> {
  const now = ctx.now();
  const todayEnd = istEndOfDay(todayIst(now));
  const where: Record<string, unknown> = {};
  if (q.scope === 'mine') where['owner_id'] = ctx.user.id;
  else if (leadScope) where['lead_id'] = leadScope;
  const open = q.status ? [q.status === 'pending' ? 'open' : q.status] : q.bucket === 'overdue' ? ['open', 'missed'] : q.bucket === 'all' ? ['open', 'missed'] : ['open'];
  where['status'] = open;
  if (q.bucket === 'overdue') where['due_at'] = { lt: iso(now) };
  else if (q.bucket === 'due_today') where['due_at'] = { gte: iso(now), lte: iso(todayEnd) };
  else if (q.bucket === 'upcoming') where['due_at'] = { gt: iso(todayEnd) };
  const page = await ctx.db.table('followups').list({ where: where as never, orderBy: { col: 'due_at', dir: 'asc' }, limit: q.limit, offset: q.offset });
  const leads = page.rows.length ? await ctx.db.table('leads').all({ id: [...new Set(page.rows.map((f) => f.lead_id))] }) : [];
  const byId = new Map(leads.map((l) => [l.id, l]));
  const rows = page.rows.map((f) => {
    const l = byId.get(f.lead_id);
    return { ...f, lead_name: l?.name ?? '—', lead_status: l?.status ?? 'new', lead_temperature: l?.temperature ?? null, lead_mobile: l?.mobile ?? '', overdue: f.status !== 'done' && new Date(f.due_at).getTime() < now.getTime() };
  });
  return { rows, total: page.total };
}

/* ───────────── clock handlers (registered when this module loads) ───────────── */
async function followupOf(ctx: AppContext, clock: Clock): Promise<{ lead: Lead; fu: Followup | null } | null> {
  const lead = await ctx.db.table('leads').get(clock.entity_id);
  if (!lead || lead.deleted_at) return null;
  const id = (clock.meta as { followup_id?: string } | null)?.followup_id;
  return { lead, fu: id ? await ctx.db.table('followups').get(id) : null };
}

registerClockHandlers('followup', {
  async onWarn(ctx, clock) {
    const f = await followupOf(ctx, clock);
    if (!f?.fu || f.fu.status !== 'open') return;
    await ctx.db.table('followups').update(f.fu.id, { reminder_sent_at: iso(ctx.now()) });
    await notifyStaff(ctx, {
      user_ids: [f.fu.owner_id ?? f.lead.owner_id ?? ''], kind: 'followup.reminder', severity: 'warning', lead_id: f.lead.id, email: true,
      title: `Follow-up due soon — ${f.lead.name}`, body: `${f.fu.note ?? 'Follow up with the customer'} (due ${formatDateTime(f.fu.due_at)})`,
    });
    await logLeadEvent(ctx, f.lead.id, 'followup_reminder', 'Reminder sent to the owner: follow-up is due soon', { followup_id: f.fu.id });
  },
  async onBreach(ctx, clock) {
    const f = await followupOf(ctx, clock);
    if (!f?.fu || f.fu.status !== 'open') return;
    await ctx.db.table('followups').update(f.fu.id, { status: 'missed', escalated_level: 1 });
    await logLeadEvent(ctx, f.lead.id, 'followup_missed', `Follow-up was not done on time (${formatDateTime(f.fu.due_at)}): ${f.fu.note ?? ''}`.trim(), { followup_id: f.fu.id, due_at: f.fu.due_at });
    await notifyStaff(ctx, {
      user_ids: [f.fu.owner_id ?? f.lead.owner_id ?? ''], kind: 'followup.missed', severity: 'critical', lead_id: f.lead.id, email: true,
      title: `Missed follow-up — ${f.lead.name}`, body: `${f.fu.note ?? 'Follow-up'} was due ${formatDateTime(f.fu.due_at)}. It has been escalated to the DSM.`,
    });
  },
  async onEscalate(ctx, clock, level) {
    const f = await followupOf(ctx, clock);
    if (!f) return;
    if (f.fu) await ctx.db.table('followups').update(f.fu.id, { escalated_level: level });
    await logLeadEvent(ctx, f.lead.id, 'followup_escalated', `Overdue follow-up escalated to ${level === 2 ? 'the Sales Manager' : 'Management'}`, { followup_id: f.fu?.id ?? null, level });
  },
});
