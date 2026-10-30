/** Opportunities (steps 19–20 and the pipeline board): list, hydrated detail, update, stage moves, lose / reopen, pipeline totals. */
import type { Request } from 'express';
import {
  OPEN_OPPORTUNITY_STAGES, OPPORTUNITY_STAGES, defaultExemptionReliance, defaultProbability, EXEMPTION_SEGMENTS, indicativeValue, formatDate, opportunityListFilterCols, pipelineQuerySchema,
  type Json, type Lead, type Opportunity, type OpportunityLoseInput, type OpportunityReopenInput, type OpportunityStage, type OpportunityUpdateInput, type Quotation, type SalesOrder, type Site,
} from '@solar/shared';
import { assertCanRead, maskPii, scopedWhere } from '../auth/access';
import type { AppContext } from '../auth/context';
import { audit } from '../lib/audit';
import { badRequest, guardBlocked, invalidState, notFound } from '../http/errors';
import { runList } from '../http/crud';
import { parse } from '../http/handler';
import {
  REGULATION_VERSIONS_RULE, exemptionDefault, exemptionEndDate, indicativeRate, probabilityDefaults, regulationVersionFor, syncExemptionClock,
} from './opportunityRules';
import { logLeadEvent, profileNames, type Hint } from './siteAccess';
import { hydrateSurvey } from './surveyService';
import { summarise } from './negotiationService';
import { maskCustomer } from './siteService';
import { requirementStatus } from './requirementService';

const asJson = (v: unknown): Json => v as Json;
const isOpen = (s: OpportunityStage): boolean => (OPEN_OPPORTUNITY_STAGES as readonly string[]).includes(s);

export async function loadOpportunity(ctx: AppContext, id: string): Promise<Opportunity> {
  const opp = await ctx.db.table('opportunities').get(id);
  if (!opp) throw notFound('Opportunity');
  await assertCanRead(ctx, 'opportunities', opp);
  return opp;
}

/* ───────────── list ───────────── */

export async function listOpportunities(ctx: AppContext, req: Request) {
  // friendly aliases: ?owner=, ?distributor=, ?dealer= are the same as owner_id / distributor_id / dealer_id
  const query: Record<string, unknown> = { ...req.query };
  for (const [alias, col] of [['owner', 'owner_id'], ['distributor', 'distributor_id'], ['dealer', 'dealer_id']] as const) {
    if (typeof query[alias] === 'string' && query[col] === undefined) query[col] = query[alias];
  }
  const page = await runList<Opportunity>(ctx, { query } as unknown as Request, {
    table: 'opportunities', searchCols: ['name'], filterCols: [...opportunityListFilterCols, 'kw', 'probability', 'expected_value', 'expected_close_date', 'expected_commissioning_date', 'lead_id', 'customer_id'],
    sortCols: ['name', 'kw', 'expected_value', 'probability', 'expected_close_date', 'expected_commissioning_date', 'stage'], defaultSort: { col: 'created_at', dir: 'desc' },
  });
  const leads = new Map((await ctx.db.table('leads').all({ id: [...new Set(page.rows.map((o) => o.lead_id))] })).map((l) => [l.id, l]));
  const owners = await profileNames(ctx, page.rows.map((o) => o.owner_id));
  return {
    ...page,
    rows: page.rows.map((o) => {
      const l = leads.get(o.lead_id);
      return { ...o, lead_name: l?.name ?? null, lead_temperature: l?.temperature ?? null, lead_city: l?.city ?? null, owner_name: o.owner_id ? owners.get(o.owner_id) ?? null : null };
    }),
  };
}

/* ───────────── detail ───────────── */

export interface NextStep { code: string; step: number | null; message: string }

export function nextStepFor(opp: Opportunity, ctxData: { quotes: Quotation[]; orders: SalesOrder[]; surveyDone: boolean }): NextStep {
  if (opp.stage === 'lost') return { code: 'reopen_or_close', step: null, message: 'Lost. Reopen the opportunity if the customer comes back.' };
  if (opp.stage === 'won') return { code: 'order_in_progress', step: 34, message: ctxData.orders.length ? `Order ${ctxData.orders[0]!.so_no} is ${ctxData.orders[0]!.status.replace(/_/g, ' ')} — track it through dispatch and installation.` : 'Won. Track the order through dispatch and installation.' };
  if (!ctxData.surveyDone) return { code: 'complete_site_visit', step: 14, message: 'No completed site visit yet — schedule and complete it before quoting.' };
  if (!opp.expected_commissioning_date) return { code: 'set_commissioning_date', step: 20, message: 'Set the expected commissioning date — it decides the regulation version and the ALMM exemption checks.' };
  const live = ctxData.quotes.filter((q) => q.status !== 'expired' && q.status !== 'rejected');
  const latest = [...live].sort((a, b) => b.version - a.version || (a.created_at < b.created_at ? 1 : -1))[0];
  if (!latest) return { code: 'prepare_quote', step: 21, message: 'Prepare the techno-commercial quotation.' };
  switch (latest.status) {
    case 'draft': return { code: 'review_quote', step: 22, message: 'Finish the quotation, run the compliance check and send it for price review.' };
    case 'blocked': return { code: 'fix_compliance', step: 22, message: 'The quotation is blocked by a compliance finding — fix it or request an override.' };
    case 'price_review': case 'pending_approval': return { code: 'await_approval', step: 23, message: 'Waiting for approval — chase the approvers if the SLA is running out.' };
    case 'approved': return { code: 'send_quote', step: 24, message: 'Approved — send the quotation to the customer.' };
    case 'sent': case 'negotiation': return { code: 'follow_up_quote', step: 25, message: 'Follow up with the customer (Day 1, 3, 5, 7) and log the discussion.' };
    case 'accepted': return { code: 'prepare_pi', step: 28, message: 'Quotation accepted — prepare the proforma invoice (check legal name, addresses and GST first).' };
    case 'revised': case 'requote_required': return { code: 'revise_quote', step: 26, message: 'The quotation needs a new version — revise and re-send it.' };
    default: return { code: 'prepare_quote', step: 21, message: 'Prepare the techno-commercial quotation.' };
  }
}

async function regulationDisplay(ctx: AppContext, opp: Opportunity) {
  const rule = await ctx.svc.rules.path(REGULATION_VERSIONS_RULE);
  const versions = rule && Array.isArray(rule.value) ? (rule.value as { from?: string; label?: string }[]) : [];
  const entry = opp.regulation_version ? versions.find((v) => v.label === opp.regulation_version) : undefined;
  return {
    label: opp.regulation_version, effective_from: entry?.from ?? null, resolved_from_commissioning_date: opp.expected_commissioning_date,
    rule: rule ? { path: REGULATION_VERSIONS_RULE, status: rule.status, confidence: rule.confidence, active: rule.isActive, source: rule.source.name } : null,
    advisory: !rule || !(rule.status === 'verified' && rule.isActive),
    note: opp.regulation_version ? null : opp.expected_commissioning_date
      ? 'No regulation version could be resolved for this commissioning date (rule missing, inactive or no entry applies).'
      : 'Set the expected commissioning date to resolve the applicable regulation version.',
  };
}

export async function getOpportunityView(ctx: AppContext, opp: Opportunity, extra: { warnings?: Hint[] } = {}) {
  const lead = await ctx.db.table('leads').get(opp.lead_id);
  const customer = opp.customer_id ? await ctx.db.table('customers').get(opp.customer_id) : null;
  const site: Site | null = opp.site_id ? await ctx.db.table('sites').get(opp.site_id) : null;
  const surveys = await ctx.db.table('site_surveys').all({ lead_id: opp.lead_id }, { orderBy: { col: 'created_at', dir: 'desc' } });
  const survey = surveys.find((s) => s.status === 'completed') ?? surveys.find((s) => s.status === 'scheduled') ?? surveys[0] ?? null;
  const quotes = await ctx.db.table('quotations').all({ opportunity_id: opp.id }, { orderBy: [{ col: 'version', dir: 'desc' }, { col: 'created_at', dir: 'desc' }] });
  const orders = await ctx.db.table('sales_orders').all({ opportunity_id: opp.id, status: { neq: 'cancelled' } }, { orderBy: { col: 'created_at', dir: 'desc' } });
  const rate = await indicativeRate(ctx);
  const owners = await profileNames(ctx, [opp.owner_id]);
  const indicative = indicativeValue(opp.kw, rate.rate);
  const negotiations = await ctx.db.table('negotiation_logs').all({ lead_id: opp.lead_id }, { orderBy: { col: 'logged_at', dir: 'desc' } });
  const warnings: Hint[] = [...(extra.warnings ?? [])];
  if (opp.exemption_reliance && opp.expected_commissioning_date) {
    const end = await exemptionEndDate(ctx);
    if (end && opp.expected_commissioning_date > end) warnings.push({ code: 'EXEMPTION_DATE_EXCEEDED', gate: 'G5', severity: 'warning', advisory: true, message: `The job relies on the ALMM List-II exemption but commissioning is expected after ${formatDate(end)}.` });
  }
  const loan = opp.funding_mix.loan_pct > 0 && (opp.funding_mix.loan_rate_pct === null || opp.funding_mix.loan_rate_pct === undefined);
  if (loan) warnings.push({ code: 'LOAN_RATE_MISSING', severity: 'info', advisory: true, message: 'A loan share is planned but no loan interest rate (with its source date) has been entered.' });
  const maskedLead = lead ? maskPii(ctx, { id: lead.id, name: lead.name, mobile: lead.mobile, email: lead.email, status: lead.status, temperature: lead.temperature, city: lead.city, pincode: lead.pincode, capacity_kw: lead.capacity_kw, quality_score: lead.quality_score, requirement_text: lead.requirement_text, timeline_bucket: lead.timeline_bucket }) : null;
  return {
    ...opp,
    owner_name: opp.owner_id ? owners.get(opp.owner_id) ?? null : null,
    lead: maskedLead,
    customer: customer ? maskCustomer(ctx, customer) : null,
    site,
    survey: survey && lead ? await hydrateSurvey(ctx, survey, lead) : null,
    quotes: quotes.map((q) => ({ id: q.id, quote_no: q.quote_no, version: q.version, status: q.status, total: q.total, kw: q.kw, validity_date: q.validity_date, compliance_status: q.compliance_status, sent_at: q.sent_at, accepted_at: q.accepted_at, parent_quote_id: q.parent_quote_id })),
    quotes_summary: { count: quotes.length, latest_status: quotes[0]?.status ?? null, latest_total: quotes[0]?.total ?? null, accepted: quotes.some((q) => q.status === 'accepted') },
    sales_orders: orders.map((o) => ({ id: o.id, so_no: o.so_no, status: o.status, total: o.total, order_date: o.order_date })),
    funding_mix: opp.funding_mix,
    regulation_version_display: await regulationDisplay(ctx, opp),
    indicative: { rate_per_kw: rate.rate, rate_source: rate.source, value: indicative, label: 'Indicative — kW × rate, not a quotation price' },
    expected_value_basis: Math.abs(opp.expected_value - indicative) < 1 ? 'indicative' : 'manual',
    requirement_form: lead ? await requirementStatus(ctx, lead.id) : 'none',
    negotiation: summarise(negotiations, opp.kw),
    next_step: nextStepFor(opp, { quotes, orders, surveyDone: surveys.some((s) => s.status === 'completed') }),
    warnings,
  };
}

/* ───────────── step 20: update ───────────── */

export async function updateOpportunity(ctx: AppContext, id: string, input: OpportunityUpdateInput) {
  const before = await loadOpportunity(ctx, id);
  if (!isOpen(before.stage)) throw invalidState(before.stage === 'won' ? 'A won opportunity is closed and can no longer be edited' : 'This opportunity is lost — reopen it before editing', { stage: before.stage });
  const patch: Partial<Opportunity> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.probability !== undefined) patch.probability = input.probability;
  if (input.kw !== undefined) patch.kw = input.kw;
  if (input.expected_value !== undefined) patch.expected_value = input.expected_value;
  if (input.expected_close_date !== undefined) patch.expected_close_date = input.expected_close_date;
  if (input.competitor !== undefined) patch.competitor = input.competitor;
  if (input.funding_mix !== undefined) patch.funding_mix = input.funding_mix;
  if (input.exemption_reliance !== undefined) patch.exemption_reliance = input.exemption_reliance;

  // a changed capacity keeps an indicative revenue figure indicative; a hand-typed revenue is never overwritten
  if (input.kw !== undefined && input.expected_value === undefined) {
    const rate = await indicativeRate(ctx);
    if (Math.abs(before.expected_value - indicativeValue(before.kw, rate.rate)) < 1) patch.expected_value = indicativeValue(input.kw, rate.rate);
  }
  // step 20: the commissioning date decides the regulation version (and the default for exemption reliance)
  if (input.expected_commissioning_date !== undefined) {
    patch.expected_commissioning_date = input.expected_commissioning_date;
    patch.regulation_version = (await regulationVersionFor(ctx, input.expected_commissioning_date))?.label ?? null;
    if (input.exemption_reliance === undefined && EXEMPTION_SEGMENTS.includes(before.segment)) {
      const until = await exemptionEndDate(ctx);
      const oldDefault = defaultExemptionReliance({ segment: before.segment, expected_commissioning_date: before.expected_commissioning_date, exemption_until: until });
      if (before.exemption_reliance === oldDefault) patch.exemption_reliance = await exemptionDefault(ctx, before.segment, input.expected_commissioning_date);
    }
  }

  const row = Object.keys(patch).length ? await ctx.db.table('opportunities').update(id, patch) : before;
  if (patch.exemption_reliance !== undefined || patch.expected_commissioning_date !== undefined) await syncExemptionClock(ctx, row);
  const changed = Object.keys(patch);
  await logLeadEvent(ctx, row.lead_id, 'opportunity_updated', `Opportunity updated (${changed.join(', ')})`, { opportunity_id: id, changed });
  await audit(ctx, { action: 'opportunity.update', table: 'opportunities', record_id: id, old: asJson(before), new: asJson(row) });
  return getOpportunityView(ctx, row);
}

/* ───────────── board moves ───────────── */

export async function setStage(ctx: AppContext, id: string, stage: OpportunityStage) {
  const before = await loadOpportunity(ctx, id);
  if (stage === 'lost') throw badRequest('Use POST /opportunities/:id/lose — a lost reason is required');
  if (before.stage === 'won') throw invalidState('A won opportunity is closed', { stage: before.stage });
  if (before.stage === 'lost') throw invalidState('This opportunity is lost — reopen it first (POST /opportunities/:id/reopen)', { stage: before.stage });
  if (stage === before.stage) return getOpportunityView(ctx, before);
  if (stage === 'won') {
    const orders = await ctx.db.table('sales_orders').count({ opportunity_id: id, status: { neq: 'cancelled' } });
    if (!orders) throw guardBlocked('An opportunity can only be marked won once a sales order exists for it', { missing: ['sales_order'] });
  }
  const row = await ctx.db.table('opportunities').update(id, stage === 'won' ? { stage, probability: 100 } : { stage });
  if (stage === 'won') {
    await ctx.db.table('leads').update(row.lead_id, { status: 'won', last_action: 'Opportunity won', last_action_at: ctx.now().toISOString() });
    await syncExemptionClock(ctx, row);
  }
  await logLeadEvent(ctx, row.lead_id, 'opportunity_stage', `Opportunity moved from ${before.stage} to ${stage}`, { opportunity_id: id, from: before.stage, to: stage });
  await audit(ctx, { action: 'opportunity.stage', table: 'opportunities', record_id: id, old: { stage: before.stage }, new: { stage } });
  return getOpportunityView(ctx, row);
}

export async function loseOpportunity(ctx: AppContext, id: string, input: OpportunityLoseInput) {
  const before = await loadOpportunity(ctx, id);
  if (before.stage === 'won') throw invalidState('A won opportunity cannot be marked lost', { stage: before.stage });
  if (before.stage === 'lost') throw invalidState('This opportunity is already lost', { stage: before.stage });
  const row = await ctx.db.table('opportunities').update(id, { stage: 'lost', lost_reason: input.reason, probability: 0, ...(input.competitor ? { competitor: input.competitor } : {}) });
  await ctx.db.table('leads').update(row.lead_id, { status: 'lost', lost_reason: input.reason, last_action: 'Opportunity lost', last_action_at: ctx.now().toISOString() });
  await syncExemptionClock(ctx, row);
  await logLeadEvent(ctx, row.lead_id, 'opportunity_lost', `Opportunity lost — ${input.reason}`, { opportunity_id: id, from: before.stage, competitor: input.competitor ?? null });
  await audit(ctx, { action: 'opportunity.lose', table: 'opportunities', record_id: id, old: { stage: before.stage }, new: { stage: 'lost', lost_reason: input.reason } });
  return getOpportunityView(ctx, row);
}

export async function reopenOpportunity(ctx: AppContext, id: string, input: OpportunityReopenInput) {
  const before = await loadOpportunity(ctx, id);
  if (before.stage !== 'lost') throw invalidState('Only a lost opportunity can be reopened', { stage: before.stage });
  const hasQuote = (await ctx.db.table('quotations').count({ opportunity_id: id })) > 0;
  const lead = await ctx.db.table('leads').get(before.lead_id);
  const stage = input.stage ?? (hasQuote ? 'quotation' : 'qualified');
  const probability = defaultProbability(lead?.temperature, await probabilityDefaults(ctx));
  const row = await ctx.db.table('opportunities').update(id, { stage, lost_reason: null, probability });
  if (lead) await ctx.db.table('leads').update(lead.id, { status: 'opportunity', lost_reason: null, last_action: 'Opportunity reopened', last_action_at: ctx.now().toISOString() } as Partial<Lead>);
  await syncExemptionClock(ctx, row);
  await logLeadEvent(ctx, row.lead_id, 'opportunity_reopened', `Opportunity reopened at ${stage}${input.note ? ` — ${input.note}` : ''}`, { opportunity_id: id, stage, previous_lost_reason: before.lost_reason });
  await audit(ctx, { action: 'opportunity.reopen', table: 'opportunities', record_id: id, old: { stage: before.stage, lost_reason: before.lost_reason }, new: { stage } });
  return getOpportunityView(ctx, row);
}

/* ───────────── pipeline board ───────────── */

export async function pipeline(ctx: AppContext, req: Request) {
  const q = parse(pipelineQuerySchema, req.query);
  const filters: Record<string, string> = {};
  if (q.segment) filters['segment'] = q.segment;
  if (q.owner) filters['owner_id'] = q.owner;
  if (q.distributor) filters['distributor_id'] = q.distributor;
  if (q.dealer) filters['dealer_id'] = q.dealer;
  const where = await scopedWhere(ctx, 'opportunities', filters);
  const rows = await ctx.db.table('opportunities').all(where);
  const stages = OPPORTUNITY_STAGES.map((stage) => {
    const inStage = rows.filter((o) => o.stage === stage);
    const value = inStage.reduce((s, o) => s + o.expected_value, 0);
    const weighted = inStage.reduce((s, o) => s + (stage === 'won' ? o.expected_value : stage === 'lost' ? 0 : (o.expected_value * o.probability) / 100), 0);
    return {
      stage, count: inStage.length, kw: Math.round(inStage.reduce((s, o) => s + o.kw, 0) * 100) / 100, value: Math.round(value), weighted_value: Math.round(weighted),
      avg_probability: inStage.length ? Math.round(inStage.reduce((s, o) => s + o.probability, 0) / inStage.length) : null,
      cards: [...inStage].sort((a, b) => b.expected_value - a.expected_value).slice(0, q.card_limit).map((o) => ({
        id: o.id, name: o.name, lead_id: o.lead_id, segment: o.segment, kw: o.kw, expected_value: o.expected_value, probability: o.probability, expected_close_date: o.expected_close_date,
        owner_id: o.owner_id, distributor_id: o.distributor_id, dealer_id: o.dealer_id, exemption_reliance: o.exemption_reliance,
      })),
    };
  });
  const open = stages.filter((s) => (OPEN_OPPORTUNITY_STAGES as readonly string[]).includes(s.stage));
  const won = stages.find((s) => s.stage === 'won')!, lost = stages.find((s) => s.stage === 'lost')!;
  return {
    currency: 'INR',
    note: 'Values are expected_value per opportunity (indicative until a quotation exists); weighted = value × probability.',
    stages,
    totals: {
      open_count: open.reduce((s, x) => s + x.count, 0), open_value: open.reduce((s, x) => s + x.value, 0), open_weighted_value: open.reduce((s, x) => s + x.weighted_value, 0), open_kw: Math.round(open.reduce((s, x) => s + x.kw, 0) * 100) / 100,
      won_count: won.count, won_value: won.value, lost_count: lost.count, lost_value: lost.value,
      win_rate_pct: won.count + lost.count ? Math.round((won.count / (won.count + lost.count)) * 1000) / 10 : null,
    },
  };
}
