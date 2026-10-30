import {
  FUNNEL_GATE_KEYS, SEGMENT_LABEL, type FunnelConversions, type FunnelDashboard, type FunnelGate, type FunnelGateKey, type FunnelSegmentRow, type Kpi, type KpiBreakdownItem,
  type Lead, type LeadStatus, type Opportunity, type Segment, type SegmentOrUnspecified,
} from '@solar/shared';
import { KpiBuilder, type Family, type KpiDetail } from './common';
import { dateInPeriod, type KpiScope } from './scope';
import { ratioPct } from './stats';

const GATE_LABEL: Record<FunnelGateKey, string> = {
  valid_lead: 'Valid Lead', qualified_lead: 'Qualified Lead', opportunity: 'Opportunity', quotation: 'Quotation', pi: 'PI', sales_order: 'Sales Order',
};
const QUALIFIED_STATUSES: LeadStatus[] = ['qualified', 'site_visit', 'opportunity', 'won'];
const OPPORTUNITY_STATUSES: LeadStatus[] = ['opportunity', 'won'];
const NOT_VALID: LeadStatus[] = ['duplicate', 'merged'];

const segmentLabel = (s: SegmentOrUnspecified): string => (s === 'unspecified' ? 'Segment not set' : SEGMENT_LABEL[s]);
const zeroCounts = (): Record<FunnelGateKey, number> => ({ valid_lead: 0, qualified_lead: 0, opportunity: 0, quotation: 0, pi: 0, sales_order: 0 });

function conversions(c: Record<FunnelGateKey, number>): FunnelConversions {
  return {
    inquiry_to_qualified: ratioPct(c.qualified_lead, c.valid_lead),
    qualified_to_opportunity: ratioPct(c.opportunity, c.qualified_lead),
    opportunity_to_quotation: ratioPct(c.quotation, c.opportunity),
    quotation_to_pi: ratioPct(c.pi, c.quotation),
    pi_to_sales_order: ratioPct(c.sales_order, c.pi),
  };
}

export interface LeadFunnelFlags { lead: Lead; segment: SegmentOrUnspecified; reached: Record<FunnelGateKey, boolean>; surveyDone: boolean }

/** Classifies each valid lead of the cohort by the furthest gate it reached (see docs/KPI_DEFINITIONS.md). Exported for tests and the SQL cross-check. */
export async function classifyLeads(scope: KpiScope): Promise<LeadFunnelFlags[]> {
  const f = scope.filters;
  const cohort = (await scope.rows('leads', { created_at: { gte: f.fromIso, lte: f.toIso }, deleted_at: null })).filter((l) => !NOT_VALID.includes(l.status));
  if (!cohort.length) return [];
  const cohortIds = new Set(cohort.map((l) => l.id));

  // downstream records can only exist after the lead, so created_at >= period start is a safe, index-friendly prefilter
  const since = { created_at: { gte: f.fromIso } };
  const [opps, quotes, pis, sos, surveys] = await Promise.all([
    scope.rows('opportunities', since, { raw: true }),
    scope.rows('quotations', since, { raw: true }),
    scope.rows('proforma_invoices', since, { raw: true }),
    scope.rows('sales_orders', since, { raw: true }),
    scope.ctx.db.table('site_surveys').all(since),
  ]);

  const oppLead = new Map<string, string>();
  const firstOpp = new Map<string, Opportunity>();
  for (const o of opps) {
    if (!cohortIds.has(o.lead_id)) continue;
    oppLead.set(o.id, o.lead_id);
    if (!firstOpp.has(o.lead_id)) firstOpp.set(o.lead_id, o);
  }
  const quoteLead = new Map<string, string>();
  for (const q of quotes) {
    const lead = oppLead.get(q.opportunity_id) ?? (q.lead_id && cohortIds.has(q.lead_id) ? q.lead_id : undefined);
    if (lead) quoteLead.set(q.id, lead);
  }
  const piLead = new Map<string, string>();
  for (const p of pis) {
    if (p.status === 'cancelled') continue;
    const lead = quoteLead.get(p.quote_id);
    if (lead) piLead.set(p.id, lead);
  }
  const quoteLeads = new Set(quoteLead.values());
  const piLeads = new Set(piLead.values());
  const soLeads = new Set<string>();
  for (const s of sos) {
    if (s.status === 'cancelled') continue;
    const lead = quoteLead.get(s.quote_id) ?? piLead.get(s.pi_id);
    if (lead) soLeads.add(lead);
  }
  const surveyLeads = new Set<string>();
  const surveyDoneLeads = new Set<string>();
  for (const s of surveys) {
    if (!cohortIds.has(s.lead_id) || s.status === 'cancelled') continue;
    surveyLeads.add(s.lead_id);
    if (s.status === 'completed') surveyDoneLeads.add(s.lead_id);
  }

  return cohort.map((lead) => {
    const hasOpp = firstOpp.has(lead.id) || OPPORTUNITY_STATUSES.includes(lead.status);
    const r: Record<FunnelGateKey, boolean> = {
      valid_lead: true,
      qualified_lead: QUALIFIED_STATUSES.includes(lead.status) || surveyLeads.has(lead.id) || hasOpp,
      opportunity: hasOpp,
      quotation: quoteLeads.has(lead.id),
      pi: piLeads.has(lead.id),
      sales_order: soLeads.has(lead.id),
    };
    // reaching a later gate implies every earlier one
    for (let i = FUNNEL_GATE_KEYS.length - 1; i > 0; i--) if (r[FUNNEL_GATE_KEYS[i]!]) r[FUNNEL_GATE_KEYS[i - 1]!] = true;
    const segment: SegmentOrUnspecified = lead.segment ?? firstOpp.get(lead.id)?.segment ?? 'unspecified';
    return { lead, segment, reached: r, surveyDone: surveyDoneLeads.has(lead.id) };
  });
}

const bySegmentBreakdown = (rows: { key: SegmentOrUnspecified; num: number; den: number }[]): KpiBreakdownItem[] =>
  rows.filter((r) => r.den > 0).map((r) => ({ key: r.key, label: segmentLabel(r.key), value: ratioPct(r.num, r.den), numerator: r.num, denominator: r.den }));

export async function computeFunnel(scope: KpiScope): Promise<Family<Pick<FunnelDashboard, 'gates' | 'by_segment'>>> {
  const kb = await KpiBuilder.create(scope.ctx, 'funnel');
  const flags = await classifyLeads(scope);

  const total = zeroCounts();
  const perSeg = new Map<SegmentOrUnspecified, Record<FunnelGateKey, number>>();
  for (const fl of flags) {
    const seg = perSeg.get(fl.segment) ?? zeroCounts();
    perSeg.set(fl.segment, seg);
    for (const g of FUNNEL_GATE_KEYS) if (fl.reached[g]) { total[g]++; seg[g]++; }
  }

  const gates: FunnelGate[] = FUNNEL_GATE_KEYS.map((key, i) => ({
    key, label: GATE_LABEL[key], count: total[key],
    pct_of_previous: i === 0 ? null : ratioPct(total[key], total[FUNNEL_GATE_KEYS[i - 1]!]),
    pct_of_valid: ratioPct(total[key], total.valid_lead),
  }));

  const segOrder: SegmentOrUnspecified[] = [...(Object.keys(SEGMENT_LABEL) as Segment[]), 'unspecified'];
  const by_segment: FunnelSegmentRow[] = segOrder.filter((s) => perSeg.has(s))
    .map((s) => ({ segment: s, label: segmentLabel(s), counts: perSeg.get(s)!, conversions: conversions(perSeg.get(s)!) }));

  // conversion KPIs with per-segment splits
  const convDefs: { key: string; num: FunnelGateKey; den: FunnelGateKey; field: keyof FunnelConversions }[] = [
    { key: 'conv_inquiry_to_qualified', num: 'qualified_lead', den: 'valid_lead', field: 'inquiry_to_qualified' },
    { key: 'conv_qualified_to_opportunity', num: 'opportunity', den: 'qualified_lead', field: 'qualified_to_opportunity' },
    { key: 'conv_opportunity_to_quotation', num: 'quotation', den: 'opportunity', field: 'opportunity_to_quotation' },
    { key: 'conv_quotation_to_pi', num: 'pi', den: 'quotation', field: 'quotation_to_pi' },
    { key: 'conv_pi_to_sales_order', num: 'sales_order', den: 'pi', field: 'pi_to_sales_order' },
  ];
  const kpis: Kpi[] = [];
  kpis.push(kb.make('funnel_gates', {
    value: total.valid_lead,
    breakdown: gates.map((g) => ({ key: g.key, label: g.label, value: g.count, pct_of_previous: g.pct_of_previous, pct_of_valid: g.pct_of_valid })),
    links: [{ label: 'Open leads', path: '/leads' }],
  }));
  const overall = conversions(total);
  for (const c of convDefs) {
    kpis.push(kb.make(c.key, {
      value: overall[c.field],
      breakdown: bySegmentBreakdown(by_segment.map((s) => ({ key: s.segment, num: s.counts[c.num], den: s.counts[c.den] }))),
      note: total[c.den] === 0 ? 'No leads reached this gate in the period' : undefined,
    }));
  }

  // survey → quote
  const surveyed = flags.filter((x) => x.surveyDone);
  const surveyedQuoted = surveyed.filter((x) => x.reached.quotation);
  const surveySeg = new Map<SegmentOrUnspecified, { num: number; den: number }>();
  for (const x of surveyed) {
    const e = surveySeg.get(x.segment) ?? { num: 0, den: 0 };
    e.den++; if (x.reached.quotation) e.num++;
    surveySeg.set(x.segment, e);
  }
  kpis.push(kb.make('survey_to_quote_pct', {
    value: ratioPct(surveyedQuoted.length, surveyed.length),
    breakdown: bySegmentBreakdown([...surveySeg].map(([key, v]) => ({ key, ...v }))),
    secondary: { label: 'Surveyed leads', value: surveyed.length, unit: 'count' },
  }));

  // loan approved ÷ applied
  const f = scope.filters;
  const loans = (await scope.rows('loans')).filter((l) => (l.application_date ? dateInPeriod(l.application_date, f) : dateInPeriod(l.created_at.slice(0, 10), f)) && l.status !== 'draft');
  const approved = loans.filter((l) => l.status === 'approved' || l.status === 'disbursed');
  const bank = new Map<string, { num: number; den: number }>();
  for (const l of loans) {
    const e = bank.get(l.bank) ?? { num: 0, den: 0 };
    e.den++; if (l.status === 'approved' || l.status === 'disbursed') e.num++;
    bank.set(l.bank, e);
  }
  kpis.push(kb.make('loan_approval_pct', {
    value: ratioPct(approved.length, loans.length),
    breakdown: [...bank].sort((a, b) => b[1].den - a[1].den).map(([label, v]) => ({ label, value: ratioPct(v.num, v.den), numerator: v.num, denominator: v.den })),
    secondary: { label: 'Loans applied', value: loans.length, unit: 'count' },
    links: [{ label: 'Loans', path: '/post-sale?tab=loans' }],
  }));

  // detail tables for export
  const details: Record<string, KpiDetail> = {};
  const segRows = by_segment.map((s) => ({
    segment: s.label, valid_lead: s.counts.valid_lead, qualified_lead: s.counts.qualified_lead, opportunity: s.counts.opportunity, quotation: s.counts.quotation, pi: s.counts.pi, sales_order: s.counts.sales_order,
    inquiry_to_qualified: s.conversions.inquiry_to_qualified, qualified_to_opportunity: s.conversions.qualified_to_opportunity, opportunity_to_quotation: s.conversions.opportunity_to_quotation,
    quotation_to_pi: s.conversions.quotation_to_pi, pi_to_sales_order: s.conversions.pi_to_sales_order,
  }));
  segRows.push({
    segment: 'All segments', valid_lead: total.valid_lead, qualified_lead: total.qualified_lead, opportunity: total.opportunity, quotation: total.quotation, pi: total.pi, sales_order: total.sales_order,
    inquiry_to_qualified: overall.inquiry_to_qualified, qualified_to_opportunity: overall.qualified_to_opportunity, opportunity_to_quotation: overall.opportunity_to_quotation,
    quotation_to_pi: overall.quotation_to_pi, pi_to_sales_order: overall.pi_to_sales_order,
  });
  const funnelDetail: KpiDetail = {
    title: 'Funnel by segment',
    columns: [
      { key: 'segment', label: 'Segment', type: 'text' },
      ...FUNNEL_GATE_KEYS.map((k) => ({ key: k, label: GATE_LABEL[k], type: 'int' as const })),
      { key: 'inquiry_to_qualified', label: 'Inquiry → Qualified Lead %', type: 'pct' }, { key: 'qualified_to_opportunity', label: 'Qualified Lead → Opportunity %', type: 'pct' },
      { key: 'opportunity_to_quotation', label: 'Opportunity → Quotation %', type: 'pct' }, { key: 'quotation_to_pi', label: 'Quotation → PI %', type: 'pct' }, { key: 'pi_to_sales_order', label: 'PI → Sales Order %', type: 'pct' },
    ],
    rows: segRows,
  };
  details['funnel_gates'] = funnelDetail;
  for (const c of convDefs) details[c.key] = funnelDetail;
  details['survey_to_quote_pct'] = {
    title: 'Surveyed leads', columns: [{ key: 'lead', label: 'Lead', type: 'text' }, { key: 'segment', label: 'Segment', type: 'text' }, { key: 'quoted', label: 'Quotation prepared', type: 'text' }, { key: 'created', label: 'Lead created', type: 'date' }],
    rows: surveyed.map((x) => ({ lead: x.lead.name, segment: segmentLabel(x.segment), quoted: x.reached.quotation ? 'Yes' : 'No', created: x.lead.created_at })),
  };
  details['loan_approval_pct'] = {
    title: 'Loan applications', columns: [{ key: 'bank', label: 'Bank', type: 'text' }, { key: 'status', label: 'Status', type: 'text' }, { key: 'applied', label: 'Application date', type: 'date' }, { key: 'amount', label: 'Amount', type: 'inr' }, { key: 'rejection', label: 'Rejection code', type: 'text' }],
    rows: loans.map((l) => ({ bank: l.bank, status: l.status, applied: l.application_date ?? l.created_at, amount: l.amount, rejection: l.rejection_code })),
  };

  return { kpis, extra: { gates, by_segment }, details };
}
