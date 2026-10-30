/**
 * Stage 2, steps 10–11: lead temperature (with compliance-deadline uplift) and the 0–100 lead quality score.
 * Algorithms are Appendix A of docs/AGENT_BRIEF.md — SQL, API and web must agree, so change them there first.
 */
import { daysBetween, istDateString, type Json, type Lead, type LeadScore, type LeadScoreComponent, type Segment, type Temperature, type TimelineBucket } from '@solar/shared';
import type { AppContext } from '../auth/context';
import { logLeadEvent } from './leadServiceStore';
import { ruleOr } from './leadServiceSettings';

/* ───────────── quality score ───────────── */
export type ScoreWeights = Record<'requirement_clarity' | 'mw_size' | 'timeline' | 'budget' | 'decision_maker' | 'consent_present' | 'bill_captured', number>;
export const DEFAULT_SCORE_WEIGHTS: ScoreWeights = { requirement_clarity: 20, mw_size: 15, timeline: 25, budget: 15, decision_maker: 10, consent_present: 10, bill_captured: 5 };
export const SCORE_LABELS: Record<keyof ScoreWeights, string> = {
  requirement_clarity: 'Requirement clarity', mw_size: 'System size (kW)', timeline: 'Timeline', budget: 'Budget', decision_maker: 'Decision maker', consent_present: 'Consent on record', bill_captured: 'Electricity bill captured',
};

export interface ScoreInput {
  requirement_text: string | null; segment: Segment | null; capacity_kw: number | null; timeline_bucket: TimelineBucket | null; budget_inr: number | null;
  decision_maker: Lead['decision_maker']; decision_maker_access: boolean | null; bill_captured: boolean; has_active_consent: boolean;
}

const TIMELINE_FACTOR: Record<TimelineBucket, number> = { immediate: 1, within_30_days: 0.9, one_to_three_months: 0.6, three_to_six_months: 0.3, six_months_plus: 0.1, unknown: 0 };
const DECISION_FACTOR: Record<NonNullable<Lead['decision_maker']>, number> = { self: 1, family: 0.8, committee: 0.5, unknown: 0 };
export const BUDGET_PER_KW_INR = 40_000;

/** Factor ∈ [0,1] per component, with a human note — exposed for tests and the score breakdown UI. */
export function scoreFactors(i: ScoreInput): Record<keyof ScoreWeights, { factor: number; note: string }> {
  const len = (i.requirement_text ?? '').trim().length;
  const reqBase = len >= 20 ? 0.6 : len >= 1 ? 0.3 : 0;
  const clarity = reqBase + (i.segment ? 0.2 : 0) + (i.capacity_kw !== null ? 0.2 : 0);
  const kw = i.capacity_kw;
  const mw = kw === null ? 0 : kw < 3 ? 0.3 : kw < 10 ? 0.5 : kw < 100 ? 0.75 : 1;
  const timeline = i.timeline_bucket ? TIMELINE_FACTOR[i.timeline_bucket] : 0;
  let budget = 0;
  if (i.budget_inr !== null) budget = kw !== null && i.budget_inr >= BUDGET_PER_KW_INR * kw ? 1 : 0.6;
  let dm = i.decision_maker ? DECISION_FACTOR[i.decision_maker] : 0;
  if (i.decision_maker && i.decision_maker_access === false) dm *= 0.5;
  return {
    requirement_clarity: { factor: clarity, note: len >= 20 ? 'Requirement described in detail' : len >= 1 ? 'Short requirement note' : 'No requirement captured' },
    mw_size: { factor: mw, note: kw === null ? 'System size not known' : `${kw} kW` },
    timeline: { factor: timeline, note: i.timeline_bucket ?? 'Timeline not known' },
    budget: { factor: budget, note: i.budget_inr === null ? 'Budget not shared' : kw !== null && i.budget_inr >= BUDGET_PER_KW_INR * kw ? 'Budget covers the system size' : 'Budget below ₹ 40,000 per kW (or size unknown)' },
    decision_maker: { factor: dm, note: i.decision_maker ? `${i.decision_maker}${i.decision_maker_access === false ? ' — no access to the decision maker' : ''}` : 'Decision maker not known' },
    consent_present: { factor: i.has_active_consent ? 1 : 0, note: i.has_active_consent ? 'Active consent on the ledger' : 'No active consent' },
    bill_captured: { factor: i.bill_captured ? 1 : 0, note: i.bill_captured ? 'Bill captured' : 'Bill not captured' },
  };
}

/** Weights from rule `scoring.weights`, normalised to sum to 100 so the score can never exceed 100. */
export function normaliseWeights(raw: Partial<Record<keyof ScoreWeights, number>> | null | undefined): ScoreWeights {
  const w: ScoreWeights = { ...DEFAULT_SCORE_WEIGHTS };
  for (const k of Object.keys(w) as (keyof ScoreWeights)[]) {
    const v = raw?.[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) w[k] = v;
  }
  const sum = Object.values(w).reduce((a, b) => a + b, 0);
  if (sum <= 0) return { ...DEFAULT_SCORE_WEIGHTS };
  if (Math.abs(sum - 100) > 1e-9) for (const k of Object.keys(w) as (keyof ScoreWeights)[]) w[k] = (w[k] / sum) * 100;
  return w;
}

export function computeLeadScore(input: ScoreInput, weights: ScoreWeights = DEFAULT_SCORE_WEIGHTS): { score: number; components: LeadScoreComponent[] } {
  const f = scoreFactors(input);
  const keys = Object.keys(DEFAULT_SCORE_WEIGHTS) as (keyof ScoreWeights)[];
  let total = 0;
  const components = keys.map((key) => {
    const points = weights[key] * f[key].factor;
    total += points;
    return { key, label: SCORE_LABELS[key], weight: Math.round(weights[key] * 100) / 100, points: Math.round(points * 100) / 100, note: f[key].note } satisfies LeadScoreComponent;
  });
  return { score: Math.min(100, Math.max(0, Math.round(total))), components };
}

/* ───────────── temperature ───────────── */
export function baseTemperature(bucket: TimelineBucket | null): Temperature {
  if (bucket === null) return 'warm'; // not qualified yet
  if (bucket === 'immediate' || bucket === 'within_30_days') return 'hot';
  if (bucket === 'one_to_three_months') return 'warm';
  return 'cold';
}
export const raiseTemperature = (t: Temperature): Temperature => (t === 'cold' ? 'warm' : 'hot');

/** The compliance deadline that makes a lead of this segment urgent (rule path), if any. */
export function deadlineRuleFor(segment: Segment | null): string | null {
  if (segment === 'pmsg_residential' || segment === 'rwa_ghs') return 'pmsg.claim_deadline.legacy_cohort';
  if (segment === 'ci_net_metered' || segment === 'open_access') return 'almm.list2.exemption_net_metering_open_access_until';
  return null;
}

export interface TemperatureResult { temperature: Temperature; base: Temperature; deadline_uplift: boolean; deadline: { rule: string; date: string; days_left: number } | null }

/** Timeline → temperature, raised one level when a relevant deadline is within `temperature.deadline_uplift_days` (default 60). */
export async function deriveTemperature(ctx: AppContext, lead: Pick<Lead, 'timeline_bucket' | 'segment'>): Promise<TemperatureResult> {
  const base = baseTemperature(lead.timeline_bucket);
  const rule = deadlineRuleFor(lead.segment);
  if (!rule || lead.timeline_bucket === null) return { temperature: base, base, deadline_uplift: false, deadline: null };
  const date = await ctx.svc.rules.value<string>(rule, undefined, null);
  if (!date || typeof date !== 'string') return { temperature: base, base, deadline_uplift: false, deadline: null };
  const windowDays = await ruleOr<number>(ctx, 'temperature.deadline_uplift_days', 60);
  const daysLeft = daysBetween(istDateString(ctx.now()), date.slice(0, 10));
  const within = daysLeft >= 0 && daysLeft <= windowDays;
  const deadline = { rule, date: date.slice(0, 10), days_left: daysLeft };
  if (!within || base === 'hot') return { temperature: base, base, deadline_uplift: false, deadline: within ? deadline : null };
  return { temperature: raiseTemperature(base), base, deadline_uplift: true, deadline };
}

/* ───────────── persistence ───────────── */
export async function hasActiveConsent(ctx: AppContext, leadId: string): Promise<boolean> {
  return (await ctx.db.table('lead_consents').count({ lead_id: leadId, withdrawn_at: null })) > 0;
}

export async function loadScoreWeights(ctx: AppContext): Promise<ScoreWeights> {
  return normaliseWeights(await ruleOr<Partial<ScoreWeights> | null>(ctx, 'scoring.weights', null));
}

export interface ScoringOutcome { lead: Lead; score: LeadScore; temperature: TemperatureResult; changed: boolean }

/**
 * Re-derives temperature + quality score from the stored lead, stores a new `lead_scores` row when anything changed
 * and mirrors score / temperature / deadline_uplift on the lead. `force` writes a row even when nothing changed.
 */
export async function recomputeLeadScore(ctx: AppContext, leadId: string, opts: { force?: boolean } = {}): Promise<ScoringOutcome> {
  const lead = await ctx.db.table('leads').getOrThrow(leadId);
  const [weights, consent, temperature] = await Promise.all([loadScoreWeights(ctx), hasActiveConsent(ctx, leadId), deriveTemperature(ctx, lead)]);
  const { score, components } = computeLeadScore({
    requirement_text: lead.requirement_text, segment: lead.segment, capacity_kw: lead.capacity_kw, timeline_bucket: lead.timeline_bucket, budget_inr: lead.budget_inr,
    decision_maker: lead.decision_maker, decision_maker_access: lead.decision_maker_access, bill_captured: lead.bill_captured, has_active_consent: consent,
  }, weights);
  const latest = (await ctx.db.table('lead_scores').all({ lead_id: leadId }, { orderBy: { col: 'computed_at', dir: 'asc' } })).at(-1) ?? null; // ascending + last: ties resolve to the newest insert
  const same = latest && latest.score === score && JSON.stringify(latest.components) === JSON.stringify(components);
  const row = same && !opts.force
    ? latest
    : await ctx.db.table('lead_scores').insert({ lead_id: leadId, score, components, computed_at: ctx.now().toISOString(), created_by: ctx.system ? null : ctx.user.id });
  const changed = lead.quality_score !== score || lead.temperature !== temperature.temperature || lead.deadline_uplift !== temperature.deadline_uplift;
  let updated = lead;
  if (changed) {
    updated = await ctx.db.table('leads').update(leadId, { quality_score: score, temperature: temperature.temperature, deadline_uplift: temperature.deadline_uplift });
    await logLeadEvent(ctx, leadId, 'scored', `Quality score ${score}/100, ${temperature.temperature}${temperature.deadline_uplift ? ' (raised for a compliance deadline)' : ''}`, {
      score, previous_score: lead.quality_score, temperature: temperature.temperature, previous_temperature: lead.temperature, deadline_uplift: temperature.deadline_uplift,
      deadline: temperature.deadline as unknown as Json,
    });
  }
  return { lead: updated, score: row!, temperature, changed };
}
