/**
 * DISCOM feasibility tracking for site surveys (flow diagram §4).
 *  - Up to the exempt capacity (rule discom.feasibility_study_exempt_up_to_kw, default 10 kW) no study is needed → 'not_required'.
 *  - Above it, BOTH the "submitted" and "complete" dates of the DISCOM application are stored; the `discom_feasibility`
 *    clock starts when the application is COMPLETE and runs for discom.feasibility_study_days_above_10kw (default 15) days.
 *  - On a breach the survey is marked 'deemed' (deemed feasible on DISCOM silence) — but ONLY while that days-rule is active.
 *    When the rule is absent/inactive the countdown is advisory: a notification and a timeline entry, no status change.
 */
import { formatDate, type Clock, type FeasibilityStatus, type Lead, type RuleStatus, type SiteSurvey, type SurveyFeasibilityInput } from '@solar/shared';
import type { AppContext } from '../auth/context';
import { audit } from '../lib/audit';
import { addDays } from '../lib/time';
import { guardBlocked, invalidState } from '../http/errors';
import { invalidField, logLeadEvent } from './siteAccess';
import type { ClockHandlers } from './contracts';
import { getClockHandlers, registerClockHandlers, registerJob } from './hooks';

export const FEASIBILITY_THRESHOLD_RULE = 'discom.feasibility_study_exempt_up_to_kw';
export const FEASIBILITY_DAYS_RULE = 'discom.feasibility_study_days_above_10kw';
/** Documented fallbacks, used only when the rule does not exist or is inactive. */
export const FALLBACK_THRESHOLD_KW = 10;
export const FALLBACK_DAYS = 15;
const CLOCK_SOURCE = 'site_survey';

export interface FeasibilityRules {
  threshold_kw: number; threshold_source: 'rule' | 'fallback';
  days: number; days_source: 'rule' | 'fallback';
  /** true only when the days rule exists AND is active: silence may then mark the survey 'deemed' */
  deemed_enabled: boolean;
  days_rule: { path: string; status: RuleStatus; confidence: string; active: boolean; source: string } | null;
}

export async function loadFeasibilityRules(ctx: AppContext): Promise<FeasibilityRules> {
  const threshold = await ctx.svc.rules.value<number>(FEASIBILITY_THRESHOLD_RULE);
  const daysRule = await ctx.svc.rules.path(FEASIBILITY_DAYS_RULE);
  const daysValue = daysRule && daysRule.isActive && typeof daysRule.value === 'number' ? daysRule.value : null;
  return {
    threshold_kw: typeof threshold === 'number' ? threshold : FALLBACK_THRESHOLD_KW, threshold_source: typeof threshold === 'number' ? 'rule' : 'fallback',
    days: daysValue ?? FALLBACK_DAYS, days_source: daysValue !== null ? 'rule' : 'fallback', deemed_enabled: daysValue !== null,
    days_rule: daysRule ? { path: FEASIBILITY_DAYS_RULE, status: daysRule.status, confidence: daysRule.confidence, active: daysRule.isActive, source: daysRule.source.name } : null,
  };
}

/** Capacity the survey is about: the opportunity's kW once converted, otherwise the lead's capacity. */
export async function surveyCapacityKw(ctx: AppContext, survey: SiteSurvey, lead?: Lead | null): Promise<number | null> {
  const opp = survey.opportunity_id ? await ctx.db.table('opportunities').get(survey.opportunity_id) : await ctx.db.table('opportunities').one({ lead_id: survey.lead_id });
  if (opp) return opp.kw;
  const l = lead ?? await ctx.db.table('leads').get(survey.lead_id);
  return l?.capacity_kw ?? null;
}

/** true = study needed, false = exempt, null = capacity not known yet. */
export const feasibilityRequired = (kw: number | null, rules: Pick<FeasibilityRules, 'threshold_kw'>): boolean | null => (kw === null ? null : kw > rules.threshold_kw);

/** Status a fresh/unsubmitted survey should carry for the given capacity. Never used once DISCOM dates or a decision exist. */
export const initialFeasibilityStatus = (kw: number | null, rules: Pick<FeasibilityRules, 'threshold_kw'>): FeasibilityStatus => (kw !== null && kw <= rules.threshold_kw ? 'not_required' : 'pending');

/** Re-evaluate the "is a study needed" status after the capacity became known/changed. Returns the (possibly updated) survey. */
export async function refreshFeasibilityRequirement(ctx: AppContext, survey: SiteSurvey, lead?: Lead | null): Promise<SiteSurvey> {
  if (survey.feasibility_application_submitted_at || survey.feasibility_application_complete_at) return survey;
  if (survey.feasibility_status !== 'not_required' && survey.feasibility_status !== 'pending') return survey;
  const rules = await loadFeasibilityRules(ctx);
  const next = initialFeasibilityStatus(await surveyCapacityKw(ctx, survey, lead), rules);
  return next === survey.feasibility_status ? survey : ctx.db.table('site_surveys').update(survey.id, { feasibility_status: next });
}

/* ───────────── view ───────────── */

export interface FeasibilityView {
  kw: number | null;
  required: boolean | null;
  status: FeasibilityStatus;
  threshold_kw: number; threshold_source: 'rule' | 'fallback';
  days_allowed: number; days_source: 'rule' | 'fallback';
  /** false = the deemed-feasible rule is absent/inactive, so the countdown is advisory only */
  deemed_enabled: boolean;
  days_rule: FeasibilityRules['days_rule'];
  application_submitted_at: string | null; application_complete_at: string | null; due_at: string | null;
  clock: { id: string; status: string; due_at: string; warn_at: string | null; escalated_level: number } | null;
  message: string;
}

const meta = (c: Clock): { source?: string; survey_id?: string } => (c.meta && typeof c.meta === 'object' && !Array.isArray(c.meta) ? (c.meta as { source?: string; survey_id?: string }) : {});

async function surveyClock(ctx: AppContext, survey: SiteSurvey): Promise<Clock | null> {
  const clocks = await ctx.svc.clocks.forEntity('lead', survey.lead_id);
  return clocks.find((c) => c.clock_type === 'discom_feasibility' && meta(c).survey_id === survey.id && !c.resolved_at) ?? clocks.find((c) => c.clock_type === 'discom_feasibility' && meta(c).survey_id === survey.id) ?? null;
}

export async function buildFeasibilityView(ctx: AppContext, survey: SiteSurvey, lead?: Lead | null): Promise<FeasibilityView> {
  const rules = await loadFeasibilityRules(ctx);
  const kw = await surveyCapacityKw(ctx, survey, lead);
  const required = feasibilityRequired(kw, rules);
  const clock = survey.feasibility_application_complete_at ? await surveyClock(ctx, survey) : null;
  let message: string;
  if (required === null) message = 'System capacity is not set yet, so it is not known whether a DISCOM feasibility study is needed.';
  else if (!required) message = `No DISCOM feasibility study is needed up to ${rules.threshold_kw} kW.`;
  else if (survey.feasibility_status === 'approved') message = 'DISCOM approved the feasibility study.';
  else if (survey.feasibility_status === 'rejected') message = 'DISCOM rejected the feasibility study — resolve the objection and re-submit the application.';
  else if (survey.feasibility_status === 'deemed') message = `DISCOM did not respond within ${rules.days} days — the site is deemed feasible.`;
  else if (!survey.feasibility_application_complete_at) message = `Record when the application was submitted and when it became complete — the ${rules.days}-day clock starts when it is complete.`;
  else if (rules.deemed_enabled) message = `Deemed feasible if DISCOM stays silent until ${formatDate(survey.feasibility_due_at)}.`;
  else message = `Advisory countdown only (${rules.days} days to ${formatDate(survey.feasibility_due_at)}): the deemed-feasibility rule is not active, so DISCOM silence will not mark this site deemed.`;
  return {
    kw, required, status: survey.feasibility_status, threshold_kw: rules.threshold_kw, threshold_source: rules.threshold_source, days_allowed: rules.days, days_source: rules.days_source,
    deemed_enabled: rules.deemed_enabled, days_rule: rules.days_rule, application_submitted_at: survey.feasibility_application_submitted_at, application_complete_at: survey.feasibility_application_complete_at,
    due_at: survey.feasibility_due_at,
    clock: clock ? { id: clock.id, status: clock.status, due_at: clock.due_at, warn_at: clock.warn_at, escalated_level: clock.escalated_level } : null,
    message,
  };
}

/* ───────────── PATCH /surveys/:id/feasibility ───────────── */

const TOLERANCE_MS = 5 * 60_000;

export async function recordFeasibility(ctx: AppContext, survey: SiteSurvey, lead: Lead, input: SurveyFeasibilityInput): Promise<FeasibilityView> {
  const rules = await loadFeasibilityRules(ctx);
  const kw = await surveyCapacityKw(ctx, survey, lead);
  if (kw === null) throw guardBlocked('Set the system capacity (kW) on the lead before recording DISCOM feasibility', { missing: ['capacity_kw'] });
  if (kw <= rules.threshold_kw) {
    if (survey.feasibility_status !== 'not_required') await ctx.db.table('site_surveys').update(survey.id, { feasibility_status: 'not_required' });
    throw invalidState(`A DISCOM feasibility study is not required for systems up to ${rules.threshold_kw} kW`, { kw, threshold_kw: rules.threshold_kw, threshold_source: rules.threshold_source });
  }

  const now = ctx.now();
  const limit = now.getTime() + TOLERANCE_MS;
  const submitted = input.submitted_at ?? survey.feasibility_application_submitted_at;
  const complete = input.complete_at ?? survey.feasibility_application_complete_at;
  if (input.submitted_at && new Date(input.submitted_at).getTime() > limit) throw invalidField('submitted_at', 'The submitted date cannot be in the future');
  if (input.complete_at && new Date(input.complete_at).getTime() > limit) throw invalidField('complete_at', 'The complete date cannot be in the future');
  if (complete && !submitted) throw invalidField('submitted_at', 'Add the date the application was submitted as well');
  if (complete && submitted && new Date(complete).getTime() < new Date(submitted).getTime()) throw invalidField('complete_at', 'The application cannot be complete before it was submitted');
  if (input.response && !submitted) throw invalidField('submitted_at', 'Record the submission date before recording the DISCOM response');
  const respondedAt = input.responded_at ?? now.toISOString();
  if (new Date(respondedAt).getTime() > limit) throw invalidField('responded_at', 'The response date cannot be in the future');

  const patch: Partial<SiteSurvey> = {};
  if (input.submitted_at) patch.feasibility_application_submitted_at = input.submitted_at;
  if (input.complete_at) patch.feasibility_application_complete_at = input.complete_at;
  const completeChanged = !!input.complete_at && (!survey.feasibility_application_complete_at || new Date(input.complete_at).getTime() !== new Date(survey.feasibility_application_complete_at).getTime());

  let status: FeasibilityStatus = survey.feasibility_status;
  if (input.response) status = input.response;
  else if (status === 'not_required') status = 'pending';
  else if ((status === 'deemed' || status === 'approved' || status === 'rejected') && completeChanged) status = 'pending'; // application was re-filed
  patch.feasibility_status = status;

  let dueIso = survey.feasibility_due_at;
  if (complete && completeChanged) { dueIso = addDays(new Date(complete), rules.days).toISOString(); patch.feasibility_due_at = dueIso; }
  else if (complete && !dueIso) { dueIso = addDays(new Date(complete), rules.days).toISOString(); patch.feasibility_due_at = dueIso; }

  const row = await ctx.db.table('site_surveys').update(survey.id, patch);
  const ownerId = row.surveyor_id ?? lead.owner_id ?? (ctx.system ? null : ctx.user.id);

  if (status === 'pending' && complete && dueIso) {
    const running = await surveyClock(ctx, row);
    const sameClock = running && !running.resolved_at && running.status === 'running' && new Date(running.due_at).getTime() === new Date(dueIso).getTime();
    if (!sameClock) {
      await ctx.svc.clocks.start({
        entity_type: 'lead', entity_id: lead.id, clock_type: 'discom_feasibility', due_at: dueIso, started_at: complete, owner_id: ownerId,
        meta: { source: CLOCK_SOURCE, survey_id: survey.id, deemed_enabled: rules.deemed_enabled, days: rules.days },
      });
    }
  }
  if (input.response) {
    await ctx.svc.clocks.complete('lead', lead.id, 'discom_feasibility', { source: CLOCK_SOURCE, survey_id: survey.id, response: input.response, responded_at: respondedAt });
  }

  const summary = input.response
    ? `DISCOM feasibility ${input.response}`
    : complete ? `DISCOM feasibility application complete — due ${formatDate(dueIso)}` : 'DISCOM feasibility application submitted';
  await logLeadEvent(ctx, lead.id, input.response ? 'feasibility_response' : 'feasibility_recorded', summary, {
    survey_id: survey.id, status, submitted_at: submitted ?? null, complete_at: complete ?? null, due_at: dueIso ?? null, responded_at: input.response ? respondedAt : null, note: input.note ?? null,
  });
  await audit(ctx, { action: 'survey.feasibility', table: 'site_surveys', record_id: survey.id, old: { feasibility_status: survey.feasibility_status, due_at: survey.feasibility_due_at }, new: { feasibility_status: status, due_at: dueIso ?? null, response: input.response ?? null } });
  if (input.response === 'rejected') {
    await ctx.svc.notify.notify({
      user_ids: [lead.owner_id, row.surveyor_id].filter((x): x is string => !!x), roles: ['techno_commercial'], distributor_id: lead.distributor_id, kind: 'survey.feasibility_rejected',
      title: `DISCOM rejected the feasibility study — ${lead.name}`, body: input.note ?? 'Resolve the objection and re-submit the application.', severity: 'warning', entity_type: 'lead', entity_id: lead.id, link: `/leads/${lead.id}?tab=site`,
    });
  }
  return buildFeasibilityView(ctx, row, lead);
}

/* ───────────── deemed feasibility on DISCOM silence ───────────── */

/** Returns true when the survey was marked deemed. With the days-rule inactive it only notifies (advisory) and returns false. */
export async function markSurveyDeemed(ctx: AppContext, survey: SiteSurvey, via: 'clock' | 'job'): Promise<boolean> {
  if (survey.feasibility_status !== 'pending') return false;
  const lead = await ctx.db.table('leads').get(survey.lead_id);
  if (!lead) return false;
  const rules = await loadFeasibilityRules(ctx);
  const recipients = { user_ids: [lead.owner_id, survey.surveyor_id].filter((x): x is string => !!x), roles: ['techno_commercial' as const], distributor_id: lead.distributor_id };
  const link = `/leads/${lead.id}?tab=site`;
  if (!rules.deemed_enabled) {
    await logLeadEvent(ctx, lead.id, 'feasibility_period_elapsed', `The ${rules.days}-day DISCOM feasibility period has passed (advisory — deemed rule not active)`, { survey_id: survey.id, due_at: survey.feasibility_due_at, via });
    await ctx.svc.notify.notify({
      ...recipients, kind: 'survey.feasibility_overdue', title: `DISCOM feasibility period has passed — ${lead.name}`,
      body: `No DISCOM answer after ${rules.days} days. The deemed-feasibility rule is not active, so the site is NOT marked deemed — follow up with the DISCOM.`, severity: 'warning', entity_type: 'lead', entity_id: lead.id, link,
    });
    return false;
  }
  const row = await ctx.db.table('site_surveys').update(survey.id, { feasibility_status: 'deemed' });
  await logLeadEvent(ctx, lead.id, 'feasibility_deemed', `Deemed feasible — DISCOM did not respond within ${rules.days} days`, { survey_id: survey.id, due_at: survey.feasibility_due_at, via });
  await ctx.svc.notify.notify({
    ...recipients, kind: 'survey.feasibility_deemed', title: `Deemed feasible on DISCOM silence — ${lead.name}`,
    body: `DISCOM did not answer within ${rules.days} days of the complete application, so feasibility is deemed granted. Keep the application proof on file.`, severity: 'info', entity_type: 'lead', entity_id: lead.id, link,
  });
  await audit(ctx, { action: 'survey.feasibility_deemed', table: 'site_surveys', record_id: survey.id, old: { feasibility_status: 'pending' }, new: { feasibility_status: row.feasibility_status }, detail: { via, due_at: survey.feasibility_due_at } });
  // the deadline has been dealt with — stop the escalation ladder (the clock stays "breached" for KPI purposes)
  await ctx.svc.clocks.complete('lead', lead.id, 'discom_feasibility', { source: CLOCK_SOURCE, survey_id: survey.id, outcome: 'deemed' });
  return true;
}

async function onFeasibilityBreach(ctx: AppContext, clock: Clock): Promise<void> {
  const surveyId = meta(clock).survey_id;
  if (!surveyId) return;
  const survey = await ctx.db.table('site_surveys').get(surveyId);
  if (survey) await markSurveyDeemed(ctx, survey, 'clock');
}

/** Safety net when a breach handler was replaced or a tick was missed: deem every overdue pending survey (only while the rule is active). */
export async function reconcileDeemedSurveys(ctx: AppContext): Promise<{ deemed: number; scanned: number }> {
  const rules = await loadFeasibilityRules(ctx);
  if (!rules.deemed_enabled) return { deemed: 0, scanned: 0 };
  const overdue = await ctx.db.table('site_surveys').all({ feasibility_status: 'pending', feasibility_due_at: { lte: ctx.now().toISOString() } });
  let deemed = 0;
  for (const s of overdue) if (s.feasibility_application_complete_at && (await markSurveyDeemed(ctx, s, 'job'))) deemed++;
  return { deemed, scanned: overdue.length };
}

/* ───────────── registration (module load) ───────────── */

type Marked = ClockHandlers & { __siteSurvey?: true };
const previous = getClockHandlers('discom_feasibility') as Marked | undefined;
// `registerClockHandlers` keeps ONE handler per clock type. Chain whatever is already there (e.g. the post-sale DISCOM-application handler)
// so clocks that are not ours still reach it; ours are recognised by meta.source = 'site_survey'.
if (!previous?.__siteSurvey) {
  const handlers: Marked = {
    __siteSurvey: true,
    async onWarn(ctx, clock) { if (meta(clock).source !== CLOCK_SOURCE) await previous?.onWarn?.(ctx, clock); },
    async onBreach(ctx, clock) { if (meta(clock).source === CLOCK_SOURCE) await onFeasibilityBreach(ctx, clock); else await previous?.onBreach?.(ctx, clock); },
    async onEscalate(ctx, clock, level) { if (meta(clock).source !== CLOCK_SOURCE) await previous?.onEscalate?.(ctx, clock, level); },
  };
  registerClockHandlers('discom_feasibility', handlers);
}

registerJob({ name: 'survey_feasibility_reconcile', schedule: '*/30 * * * *', run: async (ctx) => ({ ...(await reconcileDeemedSurveys(ctx)) }) });
