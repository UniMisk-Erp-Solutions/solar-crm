/**
 * MNRE SOP tracker for dealer complaints: reply (8 d) → reminder (to 15 d) → show-cause (15 d) → deactivation (1 month) → appeal (30 d) → closed.
 * Every duration is read from rule_config (mnre_sop.*). It is a TRACKER: it records what MNRE does and keeps the clocks; it never blocks anything
 * by itself (the dealer's portal status feeds gate G11 as a warning for `under_sop`). An inactive duration rule means no clock and a warning.
 */
import { SOP_NEXT, daysBetween, formatDate, istDateString, type Clock, type Json, type SopCase, type SopCaseCreateInput, type SopStage } from '@solar/shared';
import type { AppContext } from '../auth/context';
import { badRequest, guardBlocked, invalidState, notFound } from '../http/errors';
import { audit } from '../lib/audit';
import { registerClockHandlers } from './hooks';
import type { WithWarnings } from './installationService';
import { actorId, addCalendarMonths, dueAfterDays, istDay, loadByIds, mapById, ruleNumber } from './postsaleShared';
import { applyDealerPortalStatus } from './vendorService';

export const OPEN_SOP_STAGES: SopStage[] = ['reply', 'reminder', 'show_cause', 'deactivation', 'appeal'];
const CLOCK_ENTITY = 'sop_case';

async function dealerLabel(ctx: AppContext, dealerId: string): Promise<string> {
  const d = await ctx.db.table('dealers').get(dealerId);
  return d?.trade_name ?? d?.legal_name ?? 'dealer';
}

/* ───────────── clock handlers (escalation notifications) ───────────── */
async function sopNotify(ctx: AppContext, clock: Clock, kind: string, title: (dealer: string) => string, body: string, roles: ('dsm' | 'sales_manager' | 'management' | 'compliance_officer')[], severity: 'warning' | 'critical'): Promise<void> {
  const c = await ctx.db.table('sop_cases').get(clock.entity_id);
  if (!c || c.stage === 'closed') return;
  await ctx.svc.notify.notify({ roles, kind, severity, entity_type: CLOCK_ENTITY, entity_id: c.id, link: `/dealers/${c.dealer_id}`, title: title(await dealerLabel(ctx, c.dealer_id)), body });
}
registerClockHandlers('sop_reply', {
  onBreach: (ctx, clock) => sopNotify(ctx, clock, 'sop.reply_overdue', (d) => `MNRE notice unanswered — ${d}`, 'The reply window for the MNRE complaint notice has passed. Reply on the portal, or record the reminder if MNRE has issued one.', ['dsm', 'sales_manager', 'compliance_officer'], 'warning'),
});
registerClockHandlers('sop_show_cause', {
  onBreach: (ctx, clock) => sopNotify(ctx, clock, 'sop.show_cause_overdue', (d) => `Show-cause response overdue — ${d}`, 'The show-cause window has lapsed; MNRE may deactivate the vendor for one month. Gate G11 will warn on new orders if the portal status changes.', ['dsm', 'sales_manager', 'management', 'compliance_officer'], 'critical'),
});

/* ───────────── open a case ───────────── */
export async function openSopCase(ctx: AppContext, input: SopCaseCreateInput): Promise<WithWarnings<SopCase>> {
  const warnings: string[] = [];
  const dealer = await ctx.db.table('dealers').get(input.dealer_id);
  if (!dealer) throw notFound('Dealer');
  let regId = input.vendor_registration_id ?? null;
  if (regId) {
    const reg = await ctx.db.table('vendor_registrations').get(regId);
    if (!reg || reg.party_type !== 'dealer' || reg.party_id !== dealer.id) throw guardBlocked('That vendor registration does not belong to this dealer');
  } else {
    const regs = await ctx.db.table('vendor_registrations').all({ party_type: 'dealer', party_id: dealer.id }, { orderBy: { col: 'created_at', dir: 'desc' } });
    regId = (regs.find((r) => r.portal_status === 'active') ?? regs[0])?.id ?? null;
  }
  const noticeAt = input.notice_at ?? ctx.now().toISOString();
  const days = await ruleNumber(ctx, 'mnre_sop.vendor_reply_days', 8, 'reply clock not started', noticeAt);
  if (days.warning) warnings.push(days.warning);
  const replyDue = days.value !== null ? dueAfterDays(noticeAt, days.value) : null;

  const row = await ctx.db.table('sop_cases').insert({
    dealer_id: dealer.id, vendor_registration_id: regId, complaint_ref: input.complaint_ref, summary: input.summary ?? null, notice_at: noticeAt, stage: 'reply',
    reply_due_at: replyDue ? replyDue.toISOString() : null, replied_at: null, reminder_at: null, show_cause_at: null, show_cause_due_at: null, deactivated_at: null,
    appeal_due_at: null, closed_at: null, outcome: null, created_by: actorId(ctx),
  });
  if (replyDue) {
    await ctx.svc.clocks.start({ entity_type: CLOCK_ENTITY, entity_id: row.id, clock_type: 'sop_reply', due_at: replyDue, started_at: noticeAt, owner_id: actorId(ctx), meta: { dealer_id: dealer.id, complaint_ref: row.complaint_ref, days: days.value } as Json });
  }
  await ctx.db.table('dealers').update(dealer.id, { complaint_count: dealer.complaint_count + 1 });
  if (regId) { const reg = await ctx.db.table('vendor_registrations').getOrThrow(regId); await ctx.db.table('vendor_registrations').update(regId, { complaint_count: reg.complaint_count + 1 }); }
  // an open notice puts the vendor "under SOP" (a warning on new orders — never a block)
  const current = regId ? (await ctx.db.table('vendor_registrations').getOrThrow(regId)).portal_status : dealer.portal_status;
  if (current === 'active') await applyDealerPortalStatus(ctx, dealer.id, regId, { status: 'under_sop' }, `sop_case:${row.id}`);
  await audit(ctx, { action: 'sop_case.open', table: 'sop_cases', record_id: row.id, new: row as unknown as Json });
  await ctx.svc.notify.notify({
    roles: ['dsm', 'sales_manager', 'compliance_officer'], kind: 'sop.opened', severity: 'warning', entity_type: CLOCK_ENTITY, entity_id: row.id, link: `/dealers/${dealer.id}`,
    title: `MNRE complaint notice — ${dealer.trade_name ?? dealer.legal_name}`, body: replyDue ? `Reply due by ${formatDate(replyDue)}. Complaint ref ${row.complaint_ref}.` : `Complaint ref ${row.complaint_ref}. No reply clock is running.`,
  });
  return { ...row, warnings };
}

/* ───────────── stage transitions ───────────── */
export async function transitionSopCase(ctx: AppContext, id: string, input: { to: SopStage; at?: string; outcome?: string }): Promise<WithWarnings<SopCase>> {
  const warnings: string[] = [];
  const before = await ctx.db.table('sop_cases').get(id);
  if (!before) throw notFound('SOP case');
  const allowed = SOP_NEXT[before.stage];
  if (!allowed.includes(input.to)) throw invalidState(`A case in the ${before.stage.replace('_', '-')} stage cannot move to ${input.to.replace('_', '-')}`, { allowed });
  const at = input.at ?? ctx.now().toISOString();
  if (new Date(at) < new Date(before.notice_at)) throw badRequest('The date cannot be before the notice date');
  const patch: Partial<SopCase> = { stage: input.to };
  const day = istDay(at);

  switch (input.to) {
    case 'reminder': {
      const d = await ruleNumber(ctx, 'mnre_sop.reminder_days', 15, 'reminder window clock not started', before.notice_at);
      patch.reminder_at = at;
      if (d.warning) warnings.push(d.warning);
      if (d.value !== null) {
        // "reminder to day 15": the vendor's reply window is extended to reminder_days after the notice
        await ctx.svc.clocks.start({ entity_type: CLOCK_ENTITY, entity_id: id, clock_type: 'sop_reply', due_at: dueAfterDays(before.notice_at, d.value), started_at: at, owner_id: actorId(ctx), meta: { phase: 'reminder', days: d.value } as Json });
      } else await ctx.svc.clocks.complete(CLOCK_ENTITY, id, 'sop_reply', { phase: 'reminder' });
      break;
    }
    case 'show_cause': {
      const d = await ruleNumber(ctx, 'mnre_sop.show_cause_days', 15, 'show-cause clock not started', at);
      patch.show_cause_at = at;
      await ctx.svc.clocks.complete(CLOCK_ENTITY, id, 'sop_reply', { moved_to: 'show_cause' });
      if (d.warning) warnings.push(d.warning);
      if (d.value !== null) {
        const due = dueAfterDays(at, d.value);
        patch.show_cause_due_at = due.toISOString();
        await ctx.svc.clocks.start({ entity_type: CLOCK_ENTITY, entity_id: id, clock_type: 'sop_show_cause', due_at: due, started_at: at, owner_id: actorId(ctx), meta: { days: d.value } as Json });
      }
      break;
    }
    case 'deactivation': {
      const months = await ruleNumber(ctx, 'mnre_sop.deactivation_months', 1, 'deactivation end date not set', at);
      const appeal = await ruleNumber(ctx, 'mnre_sop.appeal_days', 30, 'appeal window not set', at);
      for (const w of [months.warning, appeal.warning]) if (w) warnings.push(w);
      patch.deactivated_at = at;
      if (appeal.value !== null) patch.appeal_due_at = dueAfterDays(at, appeal.value).toISOString();
      await ctx.svc.clocks.complete(CLOCK_ENTITY, id, 'sop_show_cause', { moved_to: 'deactivation' });
      await applyDealerPortalStatus(ctx, before.dealer_id, before.vendor_registration_id, { status: 'deactivated', deactivated_from: day, deactivated_to: months.value !== null ? addCalendarMonths(day, Math.round(months.value)) : null }, `sop_case:${id}`);
      break;
    }
    case 'appeal':
      if (input.outcome) patch.outcome = input.outcome;
      break;
    case 'closed': {
      patch.closed_at = at;
      patch.outcome = input.outcome ?? before.outcome;
      for (const t of ['sop_reply', 'sop_show_cause'] as const) await ctx.svc.clocks.complete(CLOCK_ENTITY, id, t, { moved_to: 'closed' });
      // closing reinstates the vendor unless another notice for the same dealer is still open
      const others = (await ctx.db.table('sop_cases').all({ dealer_id: before.dealer_id, stage: OPEN_SOP_STAGES })).filter((c) => c.id !== id);
      if (!others.length) {
        await applyDealerPortalStatus(ctx, before.dealer_id, before.vendor_registration_id, { status: 'active', ...(before.deactivated_at ? { deactivated_to: day } : {}) }, `sop_case:${id}`);
      } else warnings.push('Another SOP notice for this dealer is still open, so the portal status was left unchanged.');
      break;
    }
    default: break;
  }
  if (input.outcome && input.to !== 'closed' && input.to !== 'appeal') patch.outcome = input.outcome;
  const row = await ctx.db.table('sop_cases').update(id, patch);
  await audit(ctx, { action: 'sop_case.transition', table: 'sop_cases', record_id: id, old: { stage: before.stage }, new: { stage: row.stage }, detail: { from: before.stage, to: input.to, at, outcome: input.outcome ?? null } });
  if (['show_cause', 'deactivation'].includes(input.to)) {
    await ctx.svc.notify.notify({
      roles: ['dsm', 'sales_manager', 'management'], kind: `sop.${input.to}`, severity: 'critical', entity_type: CLOCK_ENTITY, entity_id: id, link: `/dealers/${before.dealer_id}`,
      title: `${input.to === 'show_cause' ? 'Show-cause notice' : 'Portal deactivation'} — ${await dealerLabel(ctx, before.dealer_id)}`,
      body: input.to === 'show_cause' ? `Response due by ${formatDate(row.show_cause_due_at)}.` : `Deactivated from ${formatDate(day)}. Appeal window ends ${formatDate(row.appeal_due_at)}.`,
    });
  }
  return { ...row, warnings };
}

/** The vendor's reply to the notice (or show-cause) went in: stop the reply / show-cause clock. The stage is MNRE's call, so it does not change. */
export async function recordSopReply(ctx: AppContext, id: string, repliedAt?: string): Promise<SopCase> {
  const before = await ctx.db.table('sop_cases').get(id);
  if (!before) throw notFound('SOP case');
  if (!['reply', 'reminder', 'show_cause'].includes(before.stage)) throw invalidState('A reply can only be recorded while the case is in the reply, reminder or show-cause stage');
  const at = repliedAt ?? ctx.now().toISOString();
  const row = await ctx.db.table('sop_cases').update(id, { replied_at: at });
  await ctx.svc.clocks.complete(CLOCK_ENTITY, id, before.stage === 'show_cause' ? 'sop_show_cause' : 'sop_reply', { replied_at: at });
  await audit(ctx, { action: 'sop_case.reply', table: 'sop_cases', record_id: id, old: before as unknown as Json, new: row as unknown as Json });
  return row;
}

/* ───────────── hydration ───────────── */
export async function hydrateSopCases(ctx: AppContext, rows: SopCase[]): Promise<SopCase[]> {
  const now = ctx.now();
  const today = istDateString(now);
  const [dealers, clocks] = await Promise.all([
    loadByIds(ctx, 'dealers', rows.map((r) => r.dealer_id)).then(mapById),
    rows.length ? ctx.db.table('clocks').all({ entity_type: CLOCK_ENTITY, entity_id: rows.map((r) => r.id), clock_type: ['sop_reply', 'sop_show_cause'], resolved_at: null }) : Promise.resolve([] as Clock[]),
  ]);
  return rows.map((r) => {
    const running = clocks.filter((c) => c.entity_id === r.id).sort((a, b) => a.due_at.localeCompare(b.due_at))[0];
    const nextDue = r.stage === 'closed' ? null : running?.due_at ?? (r.stage === 'deactivation' || r.stage === 'appeal' ? r.appeal_due_at : null);
    return {
      ...r, dealer_name: dealers.get(r.dealer_id)?.trade_name ?? dealers.get(r.dealer_id)?.legal_name ?? null, next_stages: SOP_NEXT[r.stage], next_due_at: nextDue,
      days_to_next_due: nextDue ? daysBetween(today, nextDue) : null, overdue: !!nextDue && new Date(nextDue) < now,
    } as SopCase;
  });
}
