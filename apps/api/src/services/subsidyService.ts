/**
 * Subsidy claims (PM Surya Ghar CFA + state share): created from an installation, readiness checklist, DISCOM approval → CFA-release clock,
 * legacy-cohort deadline clock with D-14 / D-7 / D-3 escalation, daily work-list (legacy first), rejection picklist, state-share receivable
 * ageing, grievance timer and release (closes the clocks and the subsidy-linked receivables).
 */
import {
  daysBetween, formatDate, istDateString, type Clock, type DeadlineState, type Json, type Segment, type StateShareAgeingResult, type StateShareAgeingRow,
  type SubsidyClaim, type SubsidyClaimCreateInput, type SubsidyClaimUpdateInput, type SubsidyWorklistResult, type SubsidyWorklistRow,
} from '@solar/shared';
import type { AppContext } from '../auth/context';
import { assertCanRead, scopedWhere } from '../auth/access';
import { badRequest, conflict, guardBlocked, invalidState, notFound } from '../http/errors';
import { audit } from '../lib/audit';
import { istEndOfDay, istMidnight } from '../lib/time';
import { computeCfa } from './cfa';
import { registerClockHandlers, registerJob } from './hooks';
import { geoTaggedPhotoCount, type WithWarnings } from './installationService';
import {
  actorId, addCalendarDays, dueAfterDays, istDay, loadByIds, mapById, notifyOnce, ruleDate, ruleNumber, ruleObject,
} from './postsaleShared';
import { closeSubsidyLinkedReceivables } from './receivableService';

/** Segments for which a subsidy claim makes sense (CFA / central scheme). */
const SUBSIDY_SEGMENTS: Segment[] = ['pmsg_residential', 'rwa_ghs', 'pm_kusum'];
const PRE_CLAIM: SubsidyClaim['status'][] = ['not_ready', 'ready'];
const OPEN_STATES: SubsidyClaim['status'][] = [...PRE_CLAIM, 'claimed'];
const DEFAULT_REMINDER_DAYS = [14, 7, 3];

/* ───────────── readiness ───────────── */
export function readinessBlockers(c: Pick<SubsidyClaim, 'bank_proof_ok' | 'photos_ok' | 'inspection_ok' | 'e_token'>): string[] {
  const out: string[] = [];
  if (!c.bank_proof_ok) out.push('Bank proof not validated');
  if (!c.photos_ok) out.push('Geo-tagged photos not accepted');
  if (!c.inspection_ok) out.push('DISCOM inspection approval pending');
  if (!c.e_token) out.push('e-token not recorded');
  return out;
}
const statusFor = (c: Pick<SubsidyClaim, 'bank_proof_ok' | 'photos_ok' | 'inspection_ok' | 'e_token'>): 'ready' | 'not_ready' => (readinessBlockers(c).length ? 'not_ready' : 'ready');

/* ───────────── state share (rule gujarat.state_subsidy) ───────────── */
/**
 * State top-up. Rule `gujarat.state_subsidy` is an object: { per_kw?, fixed?, pct_of_cfa?, max_total? } — all optional, all rupees except pct_of_cfa (percent).
 * An empty object, an inactive rule or no rule means no state scheme: the share is 0. The quotation's own state_share wins when the order has one,
 * so the claim always matches what the customer was sold.
 */
export async function stateShareFor(ctx: AppContext, opts: { cfa: number; eligible_kw: number; quoteShare: number | null }): Promise<number> {
  if (opts.quoteShare !== null && opts.quoteShare > 0) return opts.quoteShare;
  const o = await ruleObject(ctx, 'gujarat.state_subsidy');
  if (!o) return 0;
  const n = (k: string) => (typeof o[k] === 'number' ? (o[k] as number) : 0);
  let share = n('fixed') + n('per_kw') * opts.eligible_kw + (n('pct_of_cfa') / 100) * opts.cfa;
  if (typeof o['max_total'] === 'number') share = Math.min(share, o['max_total'] as number);
  return Math.max(0, Math.round(share));
}

/* ───────────── legacy deadline clock ───────────── */
async function startLegacyClock(ctx: AppContext, claim: SubsidyClaim, warnings: string[]): Promise<SubsidyClaim> {
  const deadline = await ruleDate(ctx, 'pmsg.claim_deadline.legacy_cohort', 'legacy deadline clock not started');
  if (!deadline.value) { if (deadline.warning) warnings.push(deadline.warning); return claim; }
  const reminderDays = await reminderThresholds(ctx);
  const warnAt = istMidnight(addCalendarDays(deadline.value, -(reminderDays[0] ?? DEFAULT_REMINDER_DAYS[0]!)));
  const updated = await ctx.db.table('subsidy_claims').update(claim.id, { claim_deadline: deadline.value });
  if (PRE_CLAIM.includes(claim.status)) {
    await ctx.svc.clocks.start({
      entity_type: 'subsidy_claim', entity_id: claim.id, clock_type: 'legacy_cfa_claim_deadline', due_at: istEndOfDay(deadline.value), warn_at: warnAt, owner_id: actorId(ctx),
      meta: { deadline: deadline.value, rule_id: deadline.rule_id } as Json,
    });
  }
  return updated;
}

async function reminderThresholds(ctx: AppContext): Promise<number[]> {
  const v = await ctx.svc.rules.value<Json>('subsidy.legacy_reminder_days');
  const nums = Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number' && x > 0).sort((a, b) => b - a) : [];
  return nums.length ? nums : DEFAULT_REMINDER_DAYS;
}

async function cohortFor(ctx: AppContext, explicit: SubsidyClaim['cohort'] | undefined, applicationDate: string | null, warnings: string[]): Promise<SubsidyClaim['cohort']> {
  if (explicit) return explicit;
  const cutoff = await ruleDate(ctx, 'pmsg.legacy_cohort_cutoff', 'cohort is a manual flag');
  if (!cutoff.value) { if (cutoff.warning) warnings.push(`${cutoff.warning}. Set the cohort by hand if this is a legacy application.`); return 'current'; }
  return applicationDate && applicationDate < cutoff.value ? 'legacy' : 'current';
}

/* ───────────── create / update ───────────── */
export async function createSubsidyClaim(ctx: AppContext, input: SubsidyClaimCreateInput): Promise<WithWarnings<SubsidyClaim>> {
  const warnings: string[] = [];
  const inst = await ctx.db.table('installations').get(input.installation_id);
  if (!inst) throw notFound('Installation');
  await assertCanRead(ctx, 'installations', inst);
  const dup = await ctx.db.table('subsidy_claims').one({ installation_id: inst.id });
  if (dup) throw conflict('A subsidy claim already exists for this installation', { claim_id: dup.id });
  const so = await ctx.db.table('sales_orders').get(inst.sales_order_id);
  if (!so) throw notFound('Sales order');
  if (!SUBSIDY_SEGMENTS.includes(so.segment)) throw guardBlocked(`No central subsidy scheme applies to the ${so.segment.replace(/_/g, ' ')} segment`);
  const [site, opp, quote, app] = await Promise.all([
    inst.site_id ? ctx.db.table('sites').get(inst.site_id) : null,
    so.opportunity_id ? ctx.db.table('opportunities').get(so.opportunity_id) : null,
    ctx.db.table('quotations').get(so.quote_id),
    ctx.db.table('discom_applications').one({ installation_id: inst.id }),
  ]);
  const kw = inst.kw ?? opp?.kw ?? quote?.kw;
  if (!kw) throw guardBlocked('Record the installed capacity (kW) on the installation before creating the claim');
  const cfa = await computeCfa(ctx, {
    segment: so.segment, kw, existing_solar_kw: site?.existing_solar_kw ?? 0, special_category_state: site?.special_category_state ?? false,
    households: input.households, referenceDate: inst.commissioned_at ? istDay(inst.commissioned_at) : inst.install_date ?? undefined,
  });
  warnings.push(...cfa.warnings.filter((w) => /not active/.test(w)));
  const applicationDate = input.application_date ?? (app?.submitted_at ? istDay(app.submitted_at) : so.order_date);
  const cohort = await cohortFor(ctx, input.cohort, applicationDate, warnings);
  const state_share = await stateShareFor(ctx, { cfa: cfa.cfa, eligible_kw: cfa.eligible_kw, quoteShare: quote && quote.state_share > 0 ? quote.state_share : null });
  const flags = {
    bank_proof_ok: input.bank_proof_ok ?? false,
    photos_ok: input.photos_ok ?? geoTaggedPhotoCount(inst) > 0,
    inspection_ok: input.inspection_ok ?? false,
    e_token: input.e_token ?? null,
  };
  let row = await ctx.db.table('subsidy_claims').insert({
    sales_order_id: so.id, installation_id: inst.id, opportunity_id: so.opportunity_id, customer_id: inst.customer_id, dealer_id: inst.dealer_id, distributor_id: inst.distributor_id,
    status: statusFor(flags), cohort, cfa_computed: cfa.cfa, state_share, ...flags, discom_approval_at: null, claim_at: null, released_at: null, rejection_reason: null,
    state_share_due_at: input.state_share_due_at ?? null, state_share_received_at: null, claim_deadline: null, grievance_raised_at: null, created_by: actorId(ctx),
  });
  await audit(ctx, { action: 'subsidy_claim.create', table: 'subsidy_claims', record_id: row.id, new: row as unknown as Json, detail: { cfa_rule_ids: cfa.ruleIds, cfa_lines: cfa.lines } as unknown as Json });
  if (cohort === 'legacy') row = await startLegacyClock(ctx, row, warnings);
  return { ...row, warnings };
}

export async function updateSubsidyClaim(ctx: AppContext, id: string, input: SubsidyClaimUpdateInput): Promise<WithWarnings<SubsidyClaim>> {
  const warnings: string[] = [];
  const before = await ctx.db.table('subsidy_claims').get(id);
  if (!before) throw notFound('Subsidy claim');
  await assertCanRead(ctx, 'subsidy_claims', before);
  if (before.status === 'released') throw invalidState('This claim is already released and can no longer be edited');
  const { discom_approval_at, ...rest } = input;
  const patch = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) as Partial<SubsidyClaim>;
  const merged = { ...before, ...patch };
  if (PRE_CLAIM.includes(before.status)) patch.status = statusFor(merged);
  let row = Object.keys(patch).length ? await ctx.db.table('subsidy_claims').update(id, patch) : before;

  if (patch.cohort && patch.cohort !== before.cohort) {
    if (patch.cohort === 'legacy') row = await startLegacyClock(ctx, row, warnings);
    else { await ctx.svc.clocks.cancel('subsidy_claim', id, 'legacy_cfa_claim_deadline'); row = await ctx.db.table('subsidy_claims').update(id, { claim_deadline: null }); }
  }
  await audit(ctx, { action: 'subsidy_claim.update', table: 'subsidy_claims', record_id: id, old: before as unknown as Json, new: row as unknown as Json });
  if (discom_approval_at) {
    const res = await recordDiscomApproval(ctx, id, discom_approval_at);
    return { ...res, warnings: [...warnings, ...res.warnings] };
  }
  return { ...row, warnings };
}

/** DISCOM approval recorded: the inspection item is ticked and the CFA-release clock starts (rule pmsg.cfa_release_days_after_discom_approval, default 15). */
export async function recordDiscomApproval(ctx: AppContext, id: string, approvedAt?: string): Promise<WithWarnings<SubsidyClaim>> {
  const warnings: string[] = [];
  const before = await ctx.db.table('subsidy_claims').get(id);
  if (!before) throw notFound('Subsidy claim');
  await assertCanRead(ctx, 'subsidy_claims', before);
  if (['released', 'rejected'].includes(before.status)) throw invalidState(`A ${before.status} claim cannot take a new DISCOM approval`);
  const at = approvedAt ?? ctx.now().toISOString();
  const merged = { ...before, inspection_ok: true };
  let row = await ctx.db.table('subsidy_claims').update(id, { discom_approval_at: at, inspection_ok: true, ...(before.status === 'claimed' ? {} : { status: statusFor(merged) }) });
  const days = await ruleNumber(ctx, 'pmsg.cfa_release_days_after_discom_approval', 15, 'CFA-release clock not started', at);
  if (days.warning) warnings.push(days.warning);
  if (days.value !== null && row.status !== 'released') {
    await ctx.svc.clocks.start({
      entity_type: 'subsidy_claim', entity_id: id, clock_type: 'cfa_release', due_at: dueAfterDays(at, days.value), started_at: at, owner_id: actorId(ctx),
      meta: { discom_approval_at: at, days: days.value, rule_basis: days.basis } as Json,
    });
  }
  row = await ctx.db.table('subsidy_claims').getOrThrow(id);
  await audit(ctx, { action: 'subsidy_claim.discom_approval', table: 'subsidy_claims', record_id: id, old: before as unknown as Json, new: row as unknown as Json });
  return { ...row, warnings };
}

/** Submit the claim on the portal (status ready → claimed). Requires every readiness item; completes the legacy deadline clock. */
export async function submitClaim(ctx: AppContext, id: string, claimAt?: string): Promise<WithWarnings<SubsidyClaim>> {
  const warnings: string[] = [];
  const before = await ctx.db.table('subsidy_claims').get(id);
  if (!before) throw notFound('Subsidy claim');
  await assertCanRead(ctx, 'subsidy_claims', before);
  if (before.status === 'claimed') throw invalidState('This claim has already been submitted');
  if (['released', 'rejected'].includes(before.status)) throw invalidState(`A ${before.status} claim cannot be submitted${before.status === 'rejected' ? ' — reopen it first' : ''}`);
  const blockers = readinessBlockers(before);
  if (blockers.length) throw guardBlocked('The claim is not ready to submit', { blockers });
  const at = claimAt ?? ctx.now().toISOString();
  const row = await ctx.db.table('subsidy_claims').update(id, { status: 'claimed', claim_at: at, rejection_reason: null });
  if (before.cohort === 'legacy') {
    await ctx.svc.clocks.complete('subsidy_claim', id, 'legacy_cfa_claim_deadline', { claim_at: at });
    if (before.claim_deadline && istDay(at) > before.claim_deadline) warnings.push(`Submitted after the legacy-cohort deadline of ${formatDate(before.claim_deadline)} — expect the portal to refuse it.`);
  }
  if (!before.discom_approval_at) warnings.push('Record the DISCOM approval date to start the CFA-release clock.');
  await audit(ctx, { action: 'subsidy_claim.submit', table: 'subsidy_claims', record_id: id, old: before as unknown as Json, new: row as unknown as Json });
  return { ...row, warnings };
}

export async function rejectClaim(ctx: AppContext, id: string, reason: string, note?: string): Promise<SubsidyClaim> {
  const before = await ctx.db.table('subsidy_claims').get(id);
  if (!before) throw notFound('Subsidy claim');
  await assertCanRead(ctx, 'subsidy_claims', before);
  if (['released', 'rejected'].includes(before.status)) throw invalidState(`This claim is already ${before.status}`);
  const row = await ctx.db.table('subsidy_claims').update(id, { status: 'rejected', rejection_reason: reason });
  await audit(ctx, { action: 'subsidy_claim.reject', table: 'subsidy_claims', record_id: id, old: before as unknown as Json, new: row as unknown as Json, detail: { reason, note: note ?? null } });
  return row;
}

/** Re-open a rejected claim for correction and resubmission. A legacy claim gets its deadline clock back. */
export async function reopenClaim(ctx: AppContext, id: string): Promise<WithWarnings<SubsidyClaim>> {
  const warnings: string[] = [];
  const before = await ctx.db.table('subsidy_claims').get(id);
  if (!before) throw notFound('Subsidy claim');
  await assertCanRead(ctx, 'subsidy_claims', before);
  if (before.status !== 'rejected') throw invalidState('Only a rejected claim can be re-opened');
  let row = await ctx.db.table('subsidy_claims').update(id, { status: statusFor(before), rejection_reason: null, claim_at: null });
  if (row.cohort === 'legacy') row = await startLegacyClock(ctx, row, warnings);
  await audit(ctx, { action: 'subsidy_claim.reopen', table: 'subsidy_claims', record_id: id, old: before as unknown as Json, new: row as unknown as Json });
  return { ...row, warnings };
}

/** CFA received: closes the clocks (CFA release, legacy deadline, grievance) and the dealer's subsidy-linked receivables for the project. */
export async function releaseClaim(ctx: AppContext, id: string, input: { released_at?: string; state_share_received_at?: string }): Promise<WithWarnings<SubsidyClaim & { receivables_closed: number }>> {
  const warnings: string[] = [];
  const before = await ctx.db.table('subsidy_claims').get(id);
  if (!before) throw notFound('Subsidy claim');
  await assertCanRead(ctx, 'subsidy_claims', before);
  if (before.status !== 'claimed') throw invalidState(before.status === 'released' ? 'This claim is already released' : 'Only a submitted (claimed) claim can be released');
  const at = input.released_at ?? ctx.now().toISOString();
  const row = await ctx.db.table('subsidy_claims').update(id, { status: 'released', released_at: at, ...(input.state_share_received_at ? { state_share_received_at: input.state_share_received_at } : {}) });
  for (const type of ['cfa_release', 'legacy_cfa_claim_deadline', 'grievance'] as const) await ctx.svc.clocks.complete('subsidy_claim', id, type, { released_at: at });
  const receivables_closed = await closeSubsidyLinkedReceivables(ctx, [before.sales_order_id, before.installation_id, before.opportunity_id], `subsidy claim ${id} released`);
  if (before.state_share > 0 && !row.state_share_received_at) warnings.push('State share is still outstanding — record it with the state-share action when it arrives.');
  await audit(ctx, { action: 'subsidy_claim.release', table: 'subsidy_claims', record_id: id, old: before as unknown as Json, new: row as unknown as Json, detail: { receivables_closed } });
  return { ...row, receivables_closed, warnings };
}

export async function recordStateShare(ctx: AppContext, id: string, input: { received_at?: string; due_at?: string | null }): Promise<SubsidyClaim> {
  const before = await ctx.db.table('subsidy_claims').get(id);
  if (!before) throw notFound('Subsidy claim');
  await assertCanRead(ctx, 'subsidy_claims', before);
  if (before.state_share <= 0) throw guardBlocked('This claim has no state share to track');
  if (input.received_at === undefined && input.due_at === undefined) throw badRequest('Give the date the state share was received, or its expected due date');
  const row = await ctx.db.table('subsidy_claims').update(id, {
    ...(input.received_at ? { state_share_received_at: input.received_at } : {}), ...(input.due_at !== undefined ? { state_share_due_at: input.due_at } : {}),
  });
  await audit(ctx, { action: 'subsidy_claim.state_share', table: 'subsidy_claims', record_id: id, old: before as unknown as Json, new: row as unknown as Json });
  return row;
}

/** Grievance (rule pmsg.grievance_days, default 30): starts the grievance clock. */
export async function raiseGrievance(ctx: AppContext, id: string, input: { raised_at?: string; note?: string }): Promise<WithWarnings<SubsidyClaim>> {
  const warnings: string[] = [];
  const before = await ctx.db.table('subsidy_claims').get(id);
  if (!before) throw notFound('Subsidy claim');
  await assertCanRead(ctx, 'subsidy_claims', before);
  if (before.status === 'released') throw invalidState('A released claim cannot take a grievance');
  const at = input.raised_at ?? ctx.now().toISOString();
  const row = await ctx.db.table('subsidy_claims').update(id, { grievance_raised_at: at });
  const days = await ruleNumber(ctx, 'pmsg.grievance_days', 30, 'grievance clock not started', at);
  if (days.warning) warnings.push(days.warning);
  if (days.value !== null) {
    await ctx.svc.clocks.start({ entity_type: 'subsidy_claim', entity_id: id, clock_type: 'grievance', due_at: dueAfterDays(at, days.value), started_at: at, owner_id: actorId(ctx), meta: { note: input.note ?? null, days: days.value } as Json });
  }
  await audit(ctx, { action: 'subsidy_claim.grievance', table: 'subsidy_claims', record_id: id, old: before as unknown as Json, new: row as unknown as Json, detail: { note: input.note ?? null } });
  return { ...row, warnings };
}

export async function resolveGrievance(ctx: AppContext, id: string): Promise<SubsidyClaim> {
  const before = await ctx.db.table('subsidy_claims').get(id);
  if (!before) throw notFound('Subsidy claim');
  await assertCanRead(ctx, 'subsidy_claims', before);
  if (!before.grievance_raised_at) throw invalidState('No grievance has been raised on this claim');
  await ctx.svc.clocks.complete('subsidy_claim', id, 'grievance', { resolved_by: actorId(ctx) });
  await audit(ctx, { action: 'subsidy_claim.grievance_resolved', table: 'subsidy_claims', record_id: id });
  return ctx.db.table('subsidy_claims').getOrThrow(id);
}

/* ───────────── clocks: notifications on breach ───────────── */
async function claimLabel(ctx: AppContext, c: SubsidyClaim): Promise<string> {
  const customer = c.customer_id ? await ctx.db.table('customers').get(c.customer_id) : null;
  return customer?.display_name ?? customer?.legal_name ?? `claim ${c.id.slice(0, 8)}`;
}

registerClockHandlers('legacy_cfa_claim_deadline', {
  async onBreach(ctx, clock: Clock) {
    const c = await ctx.db.table('subsidy_claims').get(clock.entity_id);
    if (!c || !PRE_CLAIM.includes(c.status)) return;
    await ctx.svc.notify.notify({
      roles: ['sales_manager', 'management'], kind: 'subsidy.legacy_deadline.missed', severity: 'critical', entity_type: 'subsidy_claim', entity_id: c.id,
      title: `Legacy CFA claim deadline passed — ${await claimLabel(ctx, c)}`,
      body: `The claim was not submitted by ${formatDate(c.claim_deadline)}. Confirm with MNRE whether it can still be received; blockers: ${readinessBlockers(c).join(', ') || 'none'}.`,
    });
  },
});
registerClockHandlers('cfa_release', {
  async onBreach(ctx, clock: Clock) {
    const c = await ctx.db.table('subsidy_claims').get(clock.entity_id);
    if (!c || c.status === 'released') return;
    await ctx.svc.notify.notify({
      roles: ['accounts'], kind: 'subsidy.cfa_release_overdue', severity: 'warning', entity_type: 'subsidy_claim', entity_id: c.id,
      title: `CFA not released within the target — ${await claimLabel(ctx, c)}`,
      body: `DISCOM approval was recorded ${formatDate(c.discom_approval_at)}; the subsidy is still awaited. Raise a grievance if it stays pending.`,
    });
  },
});

/* ───────────── legacy-cohort reminders (D-14 / D-7 / D-3, then overdue) ───────────── */
/**
 * For every legacy claim that is not yet submitted, send the reminder for the tightest threshold now crossed
 * (rule subsidy.legacy_reminder_days, default [14, 7, 3]). Each (claim, threshold) is sent once. The first threshold goes to the DSM and
 * Accounts, the second adds the Sales Manager, the last adds Management; after the deadline Sales Manager and Management are told it was missed.
 */
export async function sendLegacyClaimReminders(ctx: AppContext): Promise<{ checked: number; notified: number }> {
  const thresholds = await reminderThresholds(ctx);
  const today = istDateString(ctx.now());
  const claims = await ctx.db.table('subsidy_claims').all({ cohort: 'legacy', status: PRE_CLAIM });
  const customers = mapById(await loadByIds(ctx, 'customers', claims.map((c) => c.customer_id)));
  let notified = 0;
  for (const c of claims) {
    if (!c.claim_deadline) continue;
    const d = daysBetween(today, c.claim_deadline);
    const customer = customers.get(c.customer_id ?? '');
    const who = customer?.display_name ?? customer?.legal_name ?? `claim ${c.id.slice(0, 8)}`;
    const blockers = readinessBlockers(c);
    let level = -1;
    thresholds.forEach((t, i) => { if (d >= 0 && d <= t) level = i; });
    const base = { entity_type: 'subsidy_claim', entity_id: c.id, distributor_id: c.distributor_id };
    if (d < 0) {
      notified += await notifyOnce(ctx, { ...base, roles: ['dsm', 'sales_manager', 'management'], kind: 'subsidy.legacy_deadline.overdue', severity: 'critical', title: `Legacy CFA claim deadline passed — ${who}`, body: `Deadline was ${formatDate(c.claim_deadline)}. Blockers: ${blockers.join(', ') || 'none — submit now'}.` }, 3650);
    } else if (level >= 0) {
      const roles = level === 0 ? (['dsm', 'accounts', 'distributor_user'] as const) : level === 1 ? (['dsm', 'accounts', 'sales_manager', 'distributor_user'] as const) : (['dsm', 'accounts', 'sales_manager', 'management', 'distributor_user'] as const);
      notified += await notifyOnce(ctx, {
        ...base, roles: [...roles], kind: `subsidy.legacy_deadline.d${thresholds[level]}`, severity: level === 0 ? 'warning' : 'critical',
        title: `Legacy CFA claim — ${d === 0 ? 'deadline is today' : `${d} day${d === 1 ? '' : 's'} left`} (${formatDate(c.claim_deadline)}) · ${who}`,
        body: blockers.length ? `Still blocked: ${blockers.join(', ')}.` : 'Ready — submit the claim on the portal today.',
      }, 3650);
    }
  }
  return { checked: claims.length, notified };
}
registerJob({ name: 'subsidy.legacy_claim_reminders', schedule: '0 3 * * *', run: (ctx) => sendLegacyClaimReminders(ctx) });

/* ───────────── daily work-list ───────────── */
export interface WorklistQuery { cohort?: SubsidyClaim['cohort']; status?: SubsidyClaim['status']; dealer_id?: string; distributor_id?: string; limit: number }

const deadlineState = (days: number | null, thresholds: number[]): DeadlineState | null => {
  if (days === null) return null;
  if (days < 0) return 'overdue';
  const [t1 = 14, t2 = 7, t3 = 3] = thresholds;
  if (days <= t3) return 'critical';
  if (days <= t2) return 'urgent';
  if (days <= t1) return 'warning';
  return 'ok';
};

/** The daily work-list: open claims, legacy cohort first, then by days to the deadline (soonest first), with the readiness blockers for each. */
export async function subsidyWorklist(ctx: AppContext, q: WorklistQuery): Promise<SubsidyWorklistResult> {
  const today = istDateString(ctx.now());
  const where = await scopedWhere(ctx, 'subsidy_claims', {
    status: q.status ? [q.status] : OPEN_STATES, ...(q.cohort ? { cohort: q.cohort } : {}), ...(q.dealer_id ? { dealer_id: q.dealer_id } : {}), ...(q.distributor_id ? { distributor_id: q.distributor_id } : {}),
  });
  const claims = await ctx.db.table('subsidy_claims').all(where);
  const [customers, dealers, thresholds, releaseClocks] = await Promise.all([
    loadByIds(ctx, 'customers', claims.map((c) => c.customer_id)).then(mapById),
    loadByIds(ctx, 'dealers', claims.map((c) => c.dealer_id)).then(mapById),
    reminderThresholds(ctx),
    claims.length ? ctx.db.table('clocks').all({ entity_type: 'subsidy_claim', entity_id: claims.map((c) => c.id), clock_type: 'cfa_release', resolved_at: null }) : Promise.resolve([] as Clock[]),
  ]);
  const releaseBy = new Map(releaseClocks.map((c) => [c.entity_id, c]));

  const rows: SubsidyWorklistRow[] = claims.map((c) => {
    const blockers = readinessBlockers(c);
    const claimed = c.status === 'claimed';
    const days = c.claim_deadline ? daysBetween(today, c.claim_deadline) : null;
    const rel = releaseBy.get(c.id);
    const relDue = rel?.due_at ?? null;
    const relOverdue = !!relDue && claimed && new Date(relDue) < ctx.now();
    const phase: SubsidyWorklistRow['phase'] = claimed ? 'await_release' : blockers.length ? 'prepare' : 'submit';
    const since = c.discom_approval_at ?? c.created_at;
    const next = claimed
      ? relOverdue ? 'CFA release is overdue — follow up with the DISCOM / raise a grievance' : 'Waiting for CFA release'
      : blockers.length ? `Clear: ${blockers.join('; ')}` : 'Submit the claim on the portal';
    const cu = customers.get(c.customer_id ?? '');
    return {
      claim_id: c.id, status: c.status, cohort: c.cohort, phase, customer_id: c.customer_id, customer_name: cu?.display_name ?? cu?.legal_name ?? null,
      dealer_id: c.dealer_id, dealer_name: dealers.get(c.dealer_id ?? '')?.legal_name ?? null, installation_id: c.installation_id, sales_order_id: c.sales_order_id,
      cfa_computed: c.cfa_computed, state_share: c.state_share, claim_deadline: c.claim_deadline, days_to_deadline: days,
      deadline_state: c.cohort === 'legacy' && !claimed ? deadlineState(days, thresholds) : null, deadline_met: claimed,
      discom_approval_at: c.discom_approval_at, cfa_release_due_at: relDue, cfa_release_overdue: relOverdue, age_days: Math.max(0, daysBetween(since, today)), blockers: claimed ? [] : blockers, next_action: next,
    };
  });
  rows.sort((a, b) => {
    if ((a.cohort === 'legacy') !== (b.cohort === 'legacy')) return a.cohort === 'legacy' ? -1 : 1;
    if (a.deadline_met !== b.deadline_met) return a.deadline_met ? 1 : -1;
    const da = a.days_to_deadline ?? Number.POSITIVE_INFINITY, db = b.days_to_deadline ?? Number.POSITIVE_INFINITY;
    if (da !== db) return da - db;
    return b.age_days - a.age_days;
  });
  const legacyOpen = rows.filter((r) => r.cohort === 'legacy' && !r.deadline_met);
  const summary = {
    legacy: rows.filter((r) => r.cohort === 'legacy').length,
    legacy_at_risk: legacyOpen.filter((r) => r.deadline_state === 'overdue' || r.deadline_state === 'critical' || r.deadline_state === 'urgent' || r.deadline_state === 'warning').length,
    legacy_value_at_risk: legacyOpen.reduce((s, r) => s + r.cfa_computed + r.state_share, 0),
    current: rows.filter((r) => r.cohort === 'current').length,
    blocked: rows.filter((r) => r.phase === 'prepare').length, ready_to_claim: rows.filter((r) => r.phase === 'submit').length, awaiting_release: rows.filter((r) => r.phase === 'await_release').length,
    as_of: today,
  };
  return { data: rows.slice(0, q.limit), total: rows.length, summary };
}

/* ───────────── state-share receivable ageing ───────────── */
export async function stateShareAgeing(ctx: AppContext, q: { dealer_id?: string; include_received?: boolean }): Promise<StateShareAgeingResult> {
  const today = istDateString(ctx.now());
  const where = await scopedWhere(ctx, 'subsidy_claims', { state_share: { gt: 0 }, status: ['not_ready', 'ready', 'claimed', 'released'], ...(q.dealer_id ? { dealer_id: q.dealer_id } : {}) });
  let claims = await ctx.db.table('subsidy_claims').all(where);
  if (!q.include_received) claims = claims.filter((c) => !c.state_share_received_at);
  const [customers, dealers] = await Promise.all([
    loadByIds(ctx, 'customers', claims.map((c) => c.customer_id)).then(mapById),
    loadByIds(ctx, 'dealers', claims.map((c) => c.dealer_id)).then(mapById),
  ]);
  const buckets = { not_due: 0, d0_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
  let outstanding = 0;
  const data: StateShareAgeingRow[] = claims.map((c) => {
    const since = c.released_at ?? c.claim_at ?? c.discom_approval_at ?? c.created_at;
    const age = Math.max(0, daysBetween(since, today));
    const due = c.state_share_due_at ? istDay(c.state_share_due_at) : null;
    const overdue = due ? Math.max(0, daysBetween(due, today)) : 0;
    const basis = due ? daysBetween(due, today) : age;
    const bucket: StateShareAgeingRow['bucket'] = due && basis <= 0 ? 'not_due' : basis <= 30 ? 'd0_30' : basis <= 60 ? 'd31_60' : basis <= 90 ? 'd61_90' : 'd90_plus';
    if (!c.state_share_received_at) { buckets[bucket] += c.state_share; outstanding += c.state_share; }
    const cu = customers.get(c.customer_id ?? '');
    return {
      claim_id: c.id, customer_name: cu?.display_name ?? cu?.legal_name ?? null, dealer_id: c.dealer_id, dealer_name: dealers.get(c.dealer_id ?? '')?.legal_name ?? null,
      state_share: c.state_share, status: c.status, since, age_days: age, due_at: c.state_share_due_at, days_overdue: overdue, bucket, received_at: c.state_share_received_at,
    };
  }).sort((a, b) => b.age_days - a.age_days);
  return { data, buckets, outstanding };
}

/* ───────────── hydration ───────────── */
export async function hydrateSubsidyClaims(ctx: AppContext, rows: SubsidyClaim[]): Promise<SubsidyClaim[]> {
  const today = istDateString(ctx.now());
  const [customers, dealers] = await Promise.all([
    loadByIds(ctx, 'customers', rows.map((r) => r.customer_id)).then(mapById),
    loadByIds(ctx, 'dealers', rows.map((r) => r.dealer_id)).then(mapById),
  ]);
  const clocks = rows.length ? await ctx.db.table('clocks').all({ entity_type: 'subsidy_claim', entity_id: rows.map((r) => r.id), clock_type: ['cfa_release', 'legacy_cfa_claim_deadline', 'grievance'] }) : [];
  return rows.map((r) => {
    const cu = customers.get(r.customer_id ?? '');
    const clock = (t: string) => { const c = clocks.filter((x) => x.entity_id === r.id && x.clock_type === t).sort((a, b) => b.started_at.localeCompare(a.started_at))[0]; return c ? { status: c.status, due_at: c.due_at } : null; };
    return {
      ...r, customer_name: cu?.display_name ?? cu?.legal_name ?? null, dealer_name: dealers.get(r.dealer_id ?? '')?.legal_name ?? null,
      blockers: ['released', 'claimed'].includes(r.status) ? [] : readinessBlockers(r),
      days_to_deadline: r.claim_deadline ? daysBetween(today, r.claim_deadline) : null,
      clocks: { cfa_release: clock('cfa_release'), legacy_deadline: clock('legacy_cfa_claim_deadline'), grievance: clock('grievance') },
    } as SubsidyClaim;
  });
}

