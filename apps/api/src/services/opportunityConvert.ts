/**
 * Convert a lead into an opportunity (steps 19–20).
 * Work instruction: never convert unless requirement, timeline and commercial potential are all confirmed — enforced here
 * (GUARD_BLOCKED listing exactly what is missing) and again by the database trigger.
 */
import {
  CONVERT_CONFIRMATION_KEYS, DEFAULT_FUNDING_MIX, defaultProbability, deriveSchemeRoute, formatKw, indicativeValue,
  type FundingMix, type Json, type LeadConvertInput, type Lead, type LeadStatus, type Opportunity,
} from '@solar/shared';
import type { AppContext } from '../auth/context';
import { audit } from '../lib/audit';
import { guardBlocked, invalidState } from '../http/errors';
import { actorId, assertLeadEditable, logLeadEvent, type Hint } from './siteAccess';
import { exemptionDefault, exemptionEndDate, indicativeRate, probabilityDefaults, regulationVersionFor, syncExemptionClock } from './opportunityRules';
import { requirementStatus } from './requirementService';

const CONVERTIBLE: LeadStatus[] = ['accepted', 'contacted', 'qualified', 'site_visit', 'nurture', 'opportunity'];
const CONFIRMATION_LABEL: Record<(typeof CONVERT_CONFIRMATION_KEYS)[number], string> = {
  requirement_confirmed: 'Requirement confirmed', timeline_confirmed: 'Timeline confirmed', commercial_potential_confirmed: 'Commercial potential confirmed',
};

export interface ConvertResult {
  opportunity: Opportunity;
  /** false when the lead had already been converted (the existing opportunity is returned) */
  created: boolean;
  expected_value_basis: 'indicative' | 'manual';
  indicative_rate_per_kw: { rate: number; source: 'rule' | 'fallback' };
  warnings: Hint[];
}

export interface ConvertReadiness {
  lead_id: string;
  opportunity_id: string | null;
  lead_status: LeadStatus;
  status_ok: boolean;
  can_convert: boolean;
  prerequisites: { key: string; label: string; ok: boolean; hint: string | null }[];
  confirmations: { key: string; label: string }[];
  requirement_form: 'none' | 'draft' | 'complete';
  missing: string[];
}

export async function getConvertReadiness(ctx: AppContext, lead: Lead): Promise<ConvertReadiness> {
  const opp = await ctx.db.table('opportunities').one({ lead_id: lead.id });
  const site = lead.site_id ? await ctx.db.table('sites').get(lead.site_id) : null;
  const prerequisites = [
    { key: 'segment', label: 'Segment chosen', ok: !!lead.segment, hint: lead.segment ? null : 'Set the segment on the lead' },
    { key: 'capacity_kw', label: 'Capacity (kW) known', ok: lead.capacity_kw !== null && lead.capacity_kw > 0, hint: lead.capacity_kw ? null : 'Enter the expected system size in kW' },
    { key: 'site', label: 'Site details saved', ok: !!site, hint: site ? null : 'Save the site details (consumer number, load, roof)' },
  ];
  const statusOk = CONVERTIBLE.includes(lead.status);
  return {
    lead_id: lead.id, opportunity_id: opp?.id ?? null, lead_status: lead.status, status_ok: statusOk,
    can_convert: !opp && statusOk && prerequisites.every((p) => p.ok),
    prerequisites, confirmations: CONVERT_CONFIRMATION_KEYS.map((key) => ({ key, label: CONFIRMATION_LABEL[key] })),
    requirement_form: await requirementStatus(ctx, lead.id), missing: prerequisites.filter((p) => !p.ok).map((p) => p.key),
  };
}

async function valueBasis(ctx: AppContext, opp: Opportunity): Promise<{ basis: 'indicative' | 'manual'; rate: { rate: number; source: 'rule' | 'fallback' } }> {
  const rate = await indicativeRate(ctx);
  return { basis: Math.abs(opp.expected_value - indicativeValue(opp.kw, rate.rate)) < 1 ? 'indicative' : 'manual', rate };
}

export async function convertLead(ctx: AppContext, lead: Lead, input: LeadConvertInput): Promise<ConvertResult> {
  // idempotent: a lead converts once; repeating the call returns the opportunity that already exists
  const existing = await ctx.db.table('opportunities').one({ lead_id: lead.id });
  if (existing) {
    const { basis, rate } = await valueBasis(ctx, existing);
    return { opportunity: existing, created: false, expected_value_basis: basis, indicative_rate_per_kw: rate, warnings: [] };
  }
  assertLeadEditable(lead);
  if (!CONVERTIBLE.includes(lead.status)) {
    throw invalidState(`Only an accepted, qualified lead can become an opportunity (current status: ${lead.status})`, { status: lead.status });
  }

  const site = lead.site_id ? await ctx.db.table('sites').get(lead.site_id) : null;
  const kw = input.kw ?? lead.capacity_kw;
  const missingConfirmations = CONVERT_CONFIRMATION_KEYS.filter((k) => input[k] !== true);
  const missingPrerequisites = [!lead.segment ? 'segment' : null, !kw || kw <= 0 ? 'capacity_kw' : null, !site ? 'site' : null].filter((x): x is string => !!x);
  if (missingConfirmations.length || missingPrerequisites.length) {
    const parts = [
      ...missingConfirmations.map((k) => CONFIRMATION_LABEL[k].toLowerCase().replace(' confirmed', ' not confirmed')),
      ...missingPrerequisites.map((k) => ({ segment: 'segment not chosen', capacity_kw: 'capacity (kW) not set', site: 'site details not saved' })[k] ?? k),
    ];
    throw guardBlocked(`Cannot convert yet — ${parts.join('; ')}`, {
      missing: [...missingConfirmations, ...missingPrerequisites], missing_confirmations: missingConfirmations, missing_prerequisites: missingPrerequisites,
    });
  }
  const segment = lead.segment!;
  const capacity = kw!;

  const rate = await indicativeRate(ctx);
  const probabilities = await probabilityDefaults(ctx);
  const commissioning = input.expected_commissioning_date ?? null;
  const regulation = await regulationVersionFor(ctx, commissioning);
  const exemption = input.exemption_reliance ?? await exemptionDefault(ctx, segment, commissioning);
  const funding: FundingMix = input.funding_mix ?? { ...DEFAULT_FUNDING_MIX };
  const expectedValue = input.expected_value ?? indicativeValue(capacity, rate.rate);

  const opp = await ctx.db.table('opportunities').insert({
    name: input.name ?? `${lead.name} — ${formatKw(capacity)}`, lead_id: lead.id, customer_id: lead.customer_id, site_id: lead.site_id, segment, kw: capacity,
    scheme_route: deriveSchemeRoute(segment), funding_mix: funding, probability: input.probability ?? defaultProbability(lead.temperature, probabilities), expected_value: expectedValue,
    expected_close_date: input.expected_close_date ?? null, expected_commissioning_date: commissioning, competitor: input.competitor ?? null,
    regulation_version: regulation?.label ?? null, exemption_reliance: exemption,
    requirement_confirmed: true, timeline_confirmed: true, commercial_potential_confirmed: true,
    stage: 'qualified', lost_reason: null, owner_id: lead.owner_id ?? actorId(ctx), distributor_id: lead.distributor_id, dealer_id: lead.dealer_id, territory_id: lead.territory_id, created_by: actorId(ctx),
  });

  // no transactions: if two requests raced, the earliest opportunity wins and ours is removed again
  const rivals = (await ctx.db.table('opportunities').all({ lead_id: lead.id })).sort((a, b) => (a.created_at === b.created_at ? (a.id < b.id ? -1 : 1) : a.created_at < b.created_at ? -1 : 1));
  const winner = rivals[0];
  if (winner && winner.id !== opp.id) {
    await ctx.db.table('opportunities').delete(opp.id);
    const { basis, rate: r } = await valueBasis(ctx, winner);
    return { opportunity: winner, created: false, expected_value_basis: basis, indicative_rate_per_kw: r, warnings: [] };
  }

  const now = ctx.now().toISOString();
  const leadPatch: Partial<Lead> = { status: 'opportunity', last_action: 'Converted to opportunity', last_action_at: now };
  if (lead.capacity_kw === null) leadPatch.capacity_kw = capacity;
  await ctx.db.table('leads').update(lead.id, leadPatch);
  await ctx.db.table('site_surveys').updateWhere({ lead_id: lead.id, opportunity_id: null }, { opportunity_id: opp.id });
  await ctx.db.table('requirement_forms').updateWhere({ lead_id: lead.id, opportunity_id: null }, { opportunity_id: opp.id });
  await ctx.db.table('negotiation_logs').updateWhere({ lead_id: lead.id, opportunity_id: null }, { opportunity_id: opp.id });
  await syncExemptionClock(ctx, opp);

  await logLeadEvent(ctx, lead.id, 'converted', `Converted to opportunity — ${formatKw(capacity)}, ${opp.scheme_route}`, { opportunity_id: opp.id, kw: capacity, segment, regulation_version: opp.regulation_version, exemption_reliance: opp.exemption_reliance });
  await audit(ctx, { action: 'lead.convert', table: 'opportunities', record_id: opp.id, old: { lead_status: lead.status } as Json, new: opp as unknown as Json, detail: { lead_id: lead.id } });
  await ctx.svc.notify.notify({
    user_ids: [lead.owner_id].filter((x): x is string => !!x && x !== actorId(ctx)), roles: ['techno_commercial'], distributor_id: lead.distributor_id,
    kind: 'opportunity.created', title: `New opportunity — ${opp.name}`, body: 'Ready for the techno-commercial quotation (step 21).', severity: 'success', entity_type: 'opportunity', entity_id: opp.id,
  });

  const warnings: Hint[] = [];
  if (opp.exemption_reliance) {
    const end = await exemptionEndDate(ctx);
    if (end && commissioning && commissioning > end) warnings.push({ code: 'EXEMPTION_DATE_EXCEEDED', gate: 'G5', severity: 'warning', advisory: true, message: `The job relies on the ALMM List-II exemption, but the expected commissioning date is after ${end}.` });
  }
  if (rate.source === 'fallback') warnings.push({ code: 'INDICATIVE_RATE_FALLBACK', severity: 'info', advisory: true, message: 'Rule opportunity.indicative_rate_per_kw is not active, so a built-in indicative rate was used for the expected value.' });
  return { opportunity: opp, created: true, expected_value_basis: input.expected_value === undefined || input.expected_value === null ? 'indicative' : 'manual', indicative_rate_per_kw: rate, warnings };
}
