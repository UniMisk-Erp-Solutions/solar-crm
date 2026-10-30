/** Rule-driven helpers for opportunities: regulation version, exemption reliance, indicative value, default probability, exemption clock. */
import {
  calendarDateSchema, defaultExemptionReliance, FALLBACK_PROBABILITY, probabilityByTemperatureSchema, resolveRegulationVersion,
  type Opportunity, type ProbabilityByTemperature, type RegulationVersion, type Segment,
} from '@solar/shared';
import type { AppContext } from '../auth/context';
import { istEndOfDay } from '../lib/time';

export const REGULATION_VERSIONS_RULE = 'gerc.regulation_versions';
export const EXEMPTION_END_RULE = 'almm.list2.exemption_net_metering_open_access_until';
export const INDICATIVE_RATE_RULE = 'opportunity.indicative_rate_per_kw';
export const PROBABILITY_RULE = 'opportunity.default_probability';
/** Used only when rule opportunity.indicative_rate_per_kw is absent or inactive. */
export const FALLBACK_INDICATIVE_RATE_PER_KW = 50000;

export async function indicativeRate(ctx: AppContext): Promise<{ rate: number; source: 'rule' | 'fallback' }> {
  const v = await ctx.svc.rules.value<number>(INDICATIVE_RATE_RULE);
  return typeof v === 'number' && v >= 0 ? { rate: v, source: 'rule' } : { rate: FALLBACK_INDICATIVE_RATE_PER_KW, source: 'fallback' };
}

export async function probabilityDefaults(ctx: AppContext): Promise<ProbabilityByTemperature> {
  const parsed = probabilityByTemperatureSchema.safeParse(await ctx.svc.rules.value(PROBABILITY_RULE));
  return parsed.success ? parsed.data : FALLBACK_PROBABILITY;
}

/** The regulation in force on the expected commissioning date, from rule gerc.regulation_versions; null when the rule is absent/inactive or no entry applies. */
export async function regulationVersionFor(ctx: AppContext, commissioningDate: string | null | undefined): Promise<RegulationVersion | null> {
  if (!commissioningDate) return null;
  return resolveRegulationVersion(await ctx.svc.rules.value(REGULATION_VERSIONS_RULE), commissioningDate);
}

/** Last commissioning date for which the ALMM List-II exemption holds (net-metered / open access); null when the rule is absent/inactive. */
export async function exemptionEndDate(ctx: AppContext): Promise<string | null> {
  const v = await ctx.svc.rules.value<unknown>(EXEMPTION_END_RULE);
  const parsed = calendarDateSchema.safeParse(v);
  return parsed.success ? parsed.data : null;
}

export async function exemptionDefault(ctx: AppContext, segment: Segment, commissioningDate: string | null | undefined): Promise<boolean> {
  return defaultExemptionReliance({ segment, expected_commissioning_date: commissioningDate, exemption_until: await exemptionEndDate(ctx) });
}

/**
 * Keep the `almm_exemption_commissioning` clock in step with the flag: running while an open opportunity relies on the exemption and
 * the exemption date is still ahead, cancelled otherwise.
 */
export async function syncExemptionClock(ctx: AppContext, opp: Opportunity): Promise<void> {
  const open = opp.stage !== 'won' && opp.stage !== 'lost';
  const end = open && opp.exemption_reliance ? await exemptionEndDate(ctx) : null;
  const dueAt = end ? istEndOfDay(end) : null;
  const clocks = (await ctx.svc.clocks.forEntity('opportunity', opp.id)).filter((c) => c.clock_type === 'almm_exemption_commissioning' && !c.resolved_at);
  if (!dueAt || dueAt.getTime() <= ctx.now().getTime()) {
    if (clocks.length) await ctx.svc.clocks.cancel('opportunity', opp.id, 'almm_exemption_commissioning');
    return;
  }
  if (clocks.some((c) => new Date(c.due_at).getTime() === dueAt.getTime())) return;
  await ctx.svc.clocks.start({ entity_type: 'opportunity', entity_id: opp.id, clock_type: 'almm_exemption_commissioning', due_at: dueAt, owner_id: opp.owner_id, meta: { source: 'opportunity', exemption_until: end } });
}
