/**
 * Helpers shared by the order-to-dispatch services (PI, payments, credit, sales order, dispatch):
 * document numbering, rule lookups with documented fallbacks, approval chains, working-time SLA dates and stakeholder lookup.
 */
import { groupIndian, istDateString, type AppRole, type Approval, type ApprovalEntity, type ApprovalLane, type CreditOverride, type Json } from '@solar/shared';
import type { AppContext } from '../auth/context';
import { AppError } from '../http/errors';
import { DEFAULT_WORK_CALENDAR, addWorkingMinutes, nextWorkingStart, type WorkCalendar } from '../lib/time';

export const toJson = (v: unknown): Json => v as Json;
export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
export const money = (n: number): string => `Rs. ${groupIndian(n, Number.isInteger(n) ? 0 : 2)}`;
export const todayIst = (ctx: AppContext): string => istDateString(ctx.now());
export const yy = (ctx: AppContext): string => todayIst(ctx).slice(2, 4);
export const actorId = (ctx: AppContext): string | null => (ctx.system ? null : ctx.user.id);

export function addDaysToDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/* ───────────── numbering: FS/PI/26/0001 ───────────── */

/** Next number for `prefix` (e.g. "FS/PI/26/") given the numbers already issued. */
export function nextNumber(existing: (string | null | undefined)[], prefix: string): string {
  let max = 0;
  for (const n of existing) {
    if (!n || !n.startsWith(prefix)) continue;
    const v = Number(n.slice(prefix.length));
    if (Number.isFinite(v) && v > max) max = v;
  }
  return `${prefix}${String(max + 1).padStart(4, '0')}`;
}

const isDuplicate = (e: unknown): boolean => {
  const err = e as { code?: string; status?: number; message?: string };
  return err.code === '23505' || (e instanceof AppError && e.status === 409) || /duplicate key|unique/i.test(err.message ?? '');
};
/** There are no DB transactions: a clash on the unique number (parallel request) re-reads the sequence and retries. */
export async function insertNumbered<T>(make: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let i = 0; i < 4; i++) {
    try { return await make(); } catch (e) { if (!isDuplicate(e)) throw e; last = e; }
  }
  throw last;
}

/* ───────────── rules with fallbacks ───────────── */

async function num(ctx: AppContext, path: string, fallback: number): Promise<number> {
  const v = await ctx.svc.rules.value<number>(path, undefined, fallback);
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
export const minAdvancePct = (ctx: AppContext): Promise<number> => num(ctx, 'order.min_advance_pct', 30);
export const piValidityDays = (ctx: AppContext): Promise<number> => num(ctx, 'order.pi_validity_days', 15);
export const approvalSlaHours = (ctx: AppContext): Promise<number> => num(ctx, 'order.approval_sla_hours', 8);
export const reminderHours = (ctx: AppContext): Promise<number> => num(ctx, 'order.payment_reminder_hours', 24);
export const managementApprovalAbove = (ctx: AppContext): Promise<number> => num(ctx, 'order.management_approval_above', 2_500_000);
export async function reminderEscalation(ctx: AppContext): Promise<{ sales_manager_after: number; management_after: number }> {
  const v = await ctx.svc.rules.value<{ sales_manager_after?: number; management_after?: number }>('order.payment_reminder_escalation');
  return { sales_manager_after: Number(v?.sales_manager_after) || 3, management_after: Number(v?.management_after) || 5 };
}

/** Working calendar from the `work_calendar.*` rules (days, start, end, holidays); the default calendar when absent. */
export async function workCalendar(ctx: AppContext): Promise<WorkCalendar> {
  const [days, start, end, holidays] = await Promise.all([
    ctx.svc.rules.value<number[]>('work_calendar.days'), ctx.svc.rules.value<string>('work_calendar.start'),
    ctx.svc.rules.value<string>('work_calendar.end'), ctx.svc.rules.value<string[]>('work_calendar.holidays'),
  ]);
  const hm = /^\d{1,2}:\d{2}$/;
  return {
    days: Array.isArray(days) && days.length && days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6) ? days : DEFAULT_WORK_CALENDAR.days,
    start: typeof start === 'string' && hm.test(start) ? start : DEFAULT_WORK_CALENDAR.start,
    end: typeof end === 'string' && hm.test(end) ? end : DEFAULT_WORK_CALENDAR.end,
    holidays: Array.isArray(holidays) ? holidays.filter((h): h is string => typeof h === 'string') : DEFAULT_WORK_CALENDAR.holidays,
  };
}
export async function workingDue(ctx: AppContext, hours: number, from: Date = ctx.now()): Promise<Date> {
  return addWorkingMinutes(from, Math.round(hours * 60), await workCalendar(ctx));
}
/** `hours` of real time from now, pushed into the next working time (reminders are not sent at night or on holidays). */
export async function nextWorkingAfter(ctx: AppContext, hours: number): Promise<Date> {
  return nextWorkingStart(new Date(ctx.now().getTime() + hours * 3600_000), await workCalendar(ctx));
}

/* ───────────── money in / credit ───────────── */

/** Sum of payments received against a PI (pending and bounced payments do not count). */
export async function advanceReceived(ctx: AppContext, piId: string): Promise<number> {
  const pays = await ctx.db.table('payments').all({ pi_id: piId, status: 'received' });
  return round2(pays.reduce((s, p) => s + p.amount, 0));
}
export const requiredAdvance = (total: number, pct: number): number => round2((total * pct) / 100);
export const advanceSatisfied = (advance: number, total: number, pct: number): boolean => advance + 0.005 >= requiredAdvance(total, pct);

/** An approved credit override for the dealer that covers this PI (or is dealer-wide). */
export async function findApprovedOverride(ctx: AppContext, dealerId: string, piId: string): Promise<CreditOverride | null> {
  const rows = await ctx.db.table('credit_overrides').all({ dealer_id: dealerId, status: 'approved' });
  return rows.find((o) => o.pi_id === piId || o.pi_id === null) ?? null;
}

/* ───────────── approvals (rows in `approvals`; decisions are made through the approvals module) ───────────── */

const roundOf = (a: Approval): number => Number((a.meta as { round?: number } | null)?.round ?? 1);

const startStepClock = (ctx: AppContext, a: Approval, label: string): Promise<unknown> =>
  ctx.svc.clocks.start({
    entity_type: 'approval', entity_id: a.id, clock_type: 'approval', due_at: new Date(a.due_at!), owner_id: a.requested_by,
    meta: { label, lane: a.lane, entity_type: a.entity_type, entity_id: a.entity_id, role: a.required_role } as Json,
  });

/**
 * Opens one approval round for an entity: one pending row per role in `chain` (step 1..n), all in `lane`, stamped `meta.round` so a
 * re-submission after a rejection is a new round. Same conventions as the approvals engine (services/approvalService): only step 1 is
 * active (has `due_at` and an `approval` SLA clock on entity_type "approval"); the entity's handler activates the next step on `step_approved`.
 */
export async function openApproval(ctx: AppContext, input: {
  entity_type: ApprovalEntity; entity_id: string; lane: ApprovalLane; chain: AppRole[]; label: string; extra?: Record<string, Json>;
}): Promise<Approval[]> {
  const prior = await ctx.db.table('approvals').all({ entity_type: input.entity_type, entity_id: input.entity_id });
  const round = prior.reduce((m, a) => Math.max(m, roundOf(a)), 0) + 1;
  const slaHours = await approvalSlaHours(ctx);
  const now = ctx.now();
  const rows: Approval[] = [];
  for (const [i, role] of input.chain.entries()) {
    const row = await ctx.db.table('approvals').insert({
      entity_type: input.entity_type, entity_id: input.entity_id, lane: input.lane, step: i + 1, required_role: role, approver_id: null, decision: 'pending',
      comment: null, decided_at: null, due_at: i === 0 ? (await workingDue(ctx, slaHours, now)).toISOString() : null, requested_by: actorId(ctx), requested_at: now.toISOString(),
      created_by: actorId(ctx), meta: { round, label: input.label, chain: input.chain, sla_hours: slaHours, ...(input.extra ?? {}) } as Json,
    });
    rows.push(row);
  }
  await startStepClock(ctx, rows[0]!, input.label);
  await ctx.svc.notify.notify({
    roles: [input.chain[0]!], kind: `approval.${input.entity_type}.requested`, title: `Approval needed — ${input.label}`, body: `${input.chain.length > 1 ? `Step 1 of ${input.chain.length}. ` : ''}Please review and decide.`,
    severity: 'info', link: '/approvals', entity_type: input.entity_type, entity_id: input.entity_id,
  });
  return rows;
}

/** After `step_approved`: start the next step of the same lane and round (due date, SLA clock, notification). */
export async function activateNextStep(ctx: AppContext, approval: Approval): Promise<Approval | null> {
  const rows = await ctx.db.table('approvals').all({ entity_type: approval.entity_type, entity_id: approval.entity_id, decision: 'pending' }, { orderBy: { col: 'step' } });
  const next = rows.find((r) => r.lane === approval.lane && roundOf(r) === roundOf(approval) && r.step > approval.step);
  if (!next) return null;
  const meta = next.meta as { sla_hours?: number; label?: string } | null;
  const due = await workingDue(ctx, Number(meta?.sla_hours) || (await approvalSlaHours(ctx)));
  const active = await ctx.db.table('approvals').update(next.id, { due_at: due.toISOString() });
  const label = meta?.label ?? approval.entity_type;
  const chainLength = (approval.meta as { chain?: unknown[] } | null)?.chain?.length ?? 0;
  await startStepClock(ctx, active, label);
  await ctx.svc.notify.notify({
    roles: [next.required_role], kind: `approval.${next.entity_type}.requested`, title: `Approval needed — ${label}`, body: `Step ${next.step}${chainLength ? ` of ${chainLength}` : ''}.`,
    severity: 'info', link: '/approvals', entity_type: next.entity_type, entity_id: next.entity_id,
  });
  return active;
}

export interface RoundState { rows: Approval[]; rejected: Approval | null; pending: Approval[]; approved: Approval[]; allApproved: boolean; lastApprover: string | null }
/** The state of the approval round that `approval` belongs to (robust whichever `outcome` the approvals module reports). */
export async function roundState(ctx: AppContext, approval: Approval): Promise<RoundState> {
  const round = roundOf(approval);
  const rows = (await ctx.db.table('approvals').all({ entity_type: approval.entity_type, entity_id: approval.entity_id }, { orderBy: { col: 'step' } })).filter((a) => roundOf(a) === round);
  const live = rows.filter((a) => a.decision !== 'skipped');
  const pending = live.filter((a) => a.decision === 'pending');
  const approved = live.filter((a) => a.decision === 'approved');
  const rejected = live.find((a) => a.decision === 'rejected') ?? null;
  const last = [...approved].sort((a, b) => b.step - a.step || (b.decided_at ?? '').localeCompare(a.decided_at ?? ''))[0]; // the final step's approver
  return { rows, rejected, pending, approved, allApproved: live.length > 0 && pending.length === 0 && !rejected && approved.length === live.length, lastApprover: last?.approver_id ?? approval.approver_id ?? null };
}

/** Mark every still-pending row of the entity as skipped (cancelled entity, or a rejection ended the round). */
export async function skipPending(ctx: AppContext, entity_type: ApprovalEntity, entity_id: string): Promise<void> {
  const pending = await ctx.db.table('approvals').all({ entity_type, entity_id, decision: 'pending' });
  for (const a of pending) {
    await ctx.db.table('approvals').update(a.id, { decision: 'skipped', decided_at: ctx.now().toISOString(), comment: a.comment ?? 'Closed — the request was cancelled or already rejected' });
    await ctx.svc.clocks.cancel('approval', a.id, 'approval');
  }
}

/* ───────────── people ───────────── */

/** Distributor and dealer portal users that belong to a party (the notify service only filters by distributor). */
export async function partyUserIds(ctx: AppContext, parties: { distributor_id?: string | null; dealer_id?: string | null }): Promise<string[]> {
  const ids = new Set<string>();
  if (parties.distributor_id) for (const u of await ctx.db.table('profiles').all({ role: 'distributor_user', distributor_id: parties.distributor_id, active: true })) ids.add(u.id);
  if (parties.dealer_id) for (const u of await ctx.db.table('profiles').all({ role: 'dealer_user', dealer_id: parties.dealer_id, active: true })) ids.add(u.id);
  return [...ids];
}

/* ───────────── lead timeline ───────────── */

/** Append an entry to the lead's immutable timeline (no-op when the order has no lead). */
export async function leadEvent(ctx: AppContext, leadId: string | null | undefined, event_type: string, summary: string, detail: Record<string, Json> = {}): Promise<void> {
  if (!leadId) return;
  await ctx.db.table('lead_events').insert({ lead_id: leadId, event_type, summary, actor_id: actorId(ctx), detail: detail as Json });
}
