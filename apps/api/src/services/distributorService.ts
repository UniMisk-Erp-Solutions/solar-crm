/**
 * Distributor score (0–100). Read by the lead router when it ranks distributors. Components and weights (rule distributor.score_weights):
 *   acceptance_rate  — accepted ÷ (accepted + rejected + expired + reassigned) over the look-back window of lead_assignments
 *   acceptance_time  — share of accepted assignments answered by their due time
 *   conversion       — leads that became opportunities ÷ leads received (full marks at params.conversion_full_credit_rate)
 *   compliance       — 1 minus penalties for deactivations, open SOP notices, complaints and expired bank guarantees (distributor and its dealers)
 *   load             — 1 minus open leads ÷ params.max_open_leads
 * Every recompute appends a distributor_score_history row. Where there is too little history the factor is a neutral 0.5 and flagged.
 */
import { istDateString, type Distributor, type DistributorCreateInput, type DistributorScoreComponent, type DistributorScoreResult, type Json, type LeadAssignment } from '@solar/shared';
import type { AppContext } from '../auth/context';
import { notFound } from '../http/errors';
import { audit } from '../lib/audit';
import { registerJob } from './hooks';
import { OPEN_SOP_STAGES } from './sopService';
import { ruleObject, round1 } from './postsaleShared';

const DEFAULT_WEIGHTS = { acceptance_rate: 30, acceptance_time: 15, conversion: 25, compliance: 20, load: 10 };
const DEFAULT_PARAMS = { window_days: 90, min_sample: 3, conversion_full_credit_rate: 0.4, max_open_leads: 25, complaint_penalty: 0.05, open_sop_penalty: 0.15, deactivated_penalty: 0.5, expired_bg_penalty: 0.2 };
const OPEN_LEAD_STATUSES = ['assigned', 'accepted', 'contacted', 'qualified', 'site_visit'];
const NEUTRAL = 0.5;

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
const numbers = <T extends Record<string, number>>(defaults: T, override: Record<string, Json> | null): T => {
  const out = { ...defaults };
  if (override) for (const k of Object.keys(defaults)) { const v = override[k]; if (typeof v === 'number' && Number.isFinite(v)) (out as Record<string, number>)[k] = v; }
  return out;
};

export async function recomputeDistributorScore(ctx: AppContext, distributorId: string): Promise<DistributorScoreResult> {
  const dist = await ctx.db.table('distributors').get(distributorId);
  if (!dist) throw notFound('Distributor');
  const weights = numbers(DEFAULT_WEIGHTS, await ruleObject(ctx, 'distributor.score_weights'));
  const p = numbers(DEFAULT_PARAMS, await ruleObject(ctx, 'distributor.score_params'));
  const now = ctx.now();
  const today = istDateString(now);
  const since = new Date(now.getTime() - p.window_days * 86400000).toISOString();

  /* acceptance rate + timeliness */
  const assignments: LeadAssignment[] = await ctx.db.table('lead_assignments').all({ distributor_id: distributorId, assigned_at: { gte: since } });
  const decided = assignments.filter((a) => ['accepted', 'rejected', 'expired', 'reassigned'].includes(a.status));
  const accepted = decided.filter((a) => a.status === 'accepted');
  const rateOk = decided.length >= p.min_sample;
  const acceptanceRate = rateOk ? accepted.length / decided.length : NEUTRAL;
  const onTime = accepted.filter((a) => !a.due_at || !a.responded_at || new Date(a.responded_at) <= new Date(a.due_at));
  const timeOk = accepted.length >= p.min_sample;
  const acceptanceTime = timeOk ? onTime.length / accepted.length : NEUTRAL;

  /* conversion: leads → opportunities */
  const leads = (await ctx.db.table('leads').all({ distributor_id: distributorId, created_at: { gte: since } })).filter((l) => !['duplicate', 'merged'].includes(l.status));
  const opps = leads.length ? await ctx.db.table('opportunities').all({ lead_id: leads.map((l) => l.id) }) : [];
  const converted = new Set(opps.map((o) => o.lead_id)).size;
  const convOk = leads.length >= p.min_sample;
  const convRate = leads.length ? converted / leads.length : 0;
  const conversion = convOk ? clamp01(convRate / Math.max(0.01, p.conversion_full_credit_rate)) : NEUTRAL;

  /* compliance record */
  const dealers = await ctx.db.table('dealers').all({ distributor_id: distributorId });
  const dealerIds = dealers.map((d) => d.id);
  const regs = [
    ...(await ctx.db.table('vendor_registrations').all({ party_type: 'distributor', party_id: distributorId })),
    ...(dealerIds.length ? await ctx.db.table('vendor_registrations').all({ party_type: 'dealer', party_id: dealerIds }) : []),
  ];
  const openSop = dealerIds.length ? await ctx.db.table('sop_cases').count({ dealer_id: dealerIds, stage: OPEN_SOP_STAGES }) : 0;
  const ownDeactivated = regs.filter((r) => r.party_type === 'distributor' && r.portal_status === 'deactivated').length;
  const dealersDeactivated = dealers.filter((d) => d.portal_status === 'deactivated').length;
  const complaints = dealers.reduce((s, d) => s + d.complaint_count, 0) + regs.filter((r) => r.party_type === 'distributor').reduce((s, r) => s + r.complaint_count, 0);
  const expiredBg = regs.some((r) => r.bank_guarantee_valid_till && r.bank_guarantee_valid_till < today);
  const penalties = (ownDeactivated ? p.deactivated_penalty : 0) + (dealers.length ? (dealersDeactivated / dealers.length) * p.deactivated_penalty : 0) + openSop * p.open_sop_penalty + complaints * p.complaint_penalty + (expiredBg ? p.expired_bg_penalty : 0);
  const compliance = clamp01(1 - penalties);

  /* load */
  const openLeads = await ctx.db.table('leads').count({ distributor_id: distributorId, status: OPEN_LEAD_STATUSES });
  const load = clamp01(1 - openLeads / Math.max(1, p.max_open_leads));

  const total = Object.values(weights).reduce((s, w) => s + w, 0) || 100;
  const build = (key: keyof typeof DEFAULT_WEIGHTS, label: string, factor: number, note: string, insufficient = false): DistributorScoreComponent => {
    const weight = round1((weights[key] / total) * 100);
    return { key, label, weight, factor: Math.round(factor * 1000) / 1000, points: round1(weight * factor), note, ...(insufficient ? { insufficient_data: true } : {}) };
  };
  const components: DistributorScoreComponent[] = [
    build('acceptance_rate', 'Lead acceptance rate', acceptanceRate, rateOk ? `${accepted.length} of ${decided.length} assignments accepted in ${p.window_days} days` : `Only ${decided.length} decided assignment(s) in ${p.window_days} days — neutral`, !rateOk),
    build('acceptance_time', 'On-time acceptance', acceptanceTime, timeOk ? `${onTime.length} of ${accepted.length} accepted before the due time` : `Only ${accepted.length} accepted assignment(s) — neutral`, !timeOk),
    build('conversion', 'Lead → opportunity conversion', conversion, convOk ? `${converted} of ${leads.length} leads became opportunities (${Math.round(convRate * 100)}%)` : `Only ${leads.length} lead(s) in ${p.window_days} days — neutral`, !convOk),
    build('compliance', 'Compliance record', compliance, penalties > 0 ? `Penalties ${Math.round(penalties * 100)}%: ${[ownDeactivated ? 'own registration deactivated' : '', dealersDeactivated ? `${dealersDeactivated} dealer(s) deactivated` : '', openSop ? `${openSop} open SOP notice(s)` : '', complaints ? `${complaints} complaint(s)` : '', expiredBg ? 'expired bank guarantee' : ''].filter(Boolean).join(', ')}` : 'No complaints, SOP notices or deactivations'),
    build('load', 'Open-lead load', load, `${openLeads} open lead(s) against a ceiling of ${p.max_open_leads}`),
  ];
  const score = Math.max(0, Math.min(100, Math.round(components.reduce((s, c) => s + c.points, 0))));
  const computed_at = now.toISOString();
  await ctx.db.table('distributors').update(distributorId, { score });
  const history = await ctx.db.table('distributor_score_history').insert({ distributor_id: distributorId, score, components: components as unknown as Json, computed_at });
  await audit(ctx, { action: 'distributor.score_recompute', table: 'distributors', record_id: distributorId, old: { score: dist.score }, new: { score }, detail: { history_id: history.id } });
  return { distributor_id: distributorId, score, previous_score: dist.score, components, computed_at, history_id: history.id };
}

export async function recomputeAllDistributorScores(ctx: AppContext): Promise<{ recomputed: number }> {
  const dists = await ctx.db.table('distributors').all({ status: ['active', 'onboarding'] });
  for (const d of dists) await recomputeDistributorScore(ctx, d.id);
  return { recomputed: dists.length };
}
registerJob({ name: 'distributor.score_recompute', schedule: '0 2 * * *', run: (ctx) => recomputeAllDistributorScores(ctx) });

/** Full column set for a new distributor. The score starts neutral and is recomputed right after creation. */
export function prepareDistributorCreate(input: Partial<DistributorCreateInput>): Partial<Distributor> {
  return {
    trade_name: input.trade_name ?? null, gstin: input.gstin ?? null, pan: input.pan ?? null, contact_name: input.contact_name ?? null, phone: input.phone ?? null, email: input.email ?? null,
    address: input.address ?? null, city: input.city ?? null, territory_ids: input.territory_ids ?? [], capacity_band_min_kw: input.capacity_band_min_kw ?? 0, capacity_band_max_kw: input.capacity_band_max_kw ?? 100000,
    capability_tags: input.capability_tags ?? [], score: 50, status: input.status ?? 'onboarding', credit_days: input.credit_days ?? 0, credit_limit: input.credit_limit ?? 0, rebate_slab_key: input.rebate_slab_key ?? null,
  };
}

/** Adds the dealer count to each distributor row and shows the stored score. */
export async function hydrateDistributors(ctx: AppContext, rows: Distributor[]): Promise<Distributor[]> {
  if (!rows.length) return rows;
  const [dealers, fresh] = await Promise.all([ctx.db.table('dealers').all({ distributor_id: rows.map((r) => r.id) }), ctx.db.table('distributors').all({ id: rows.map((r) => r.id) })]);
  const score = new Map(fresh.map((d) => [d.id, d.score])); // a create returns before its first score is computed — always show the stored score
  return rows.map((r) => ({ ...r, score: score.get(r.id) ?? r.score, dealer_count: dealers.filter((d) => d.distributor_id === r.id).length } as Distributor));
}
