import { describe, expect, it, vi } from 'vitest';
import {
  DEMO_ORG_ID, SEGMENTS, seedId, type Clock, type Dealer, type DealerReceivable, type Followup, type FunnelDashboard, type Lead, type LeadConsent, type LeadStatus, type MessageLog,
  type Opportunity, type ProformaInvoice, type Quotation, type SalesOrder,
} from '@solar/shared';
import type { SeedData } from '@solar/shared/seed';
import { IDS, T0, baseSeed, createTestEnv } from '../helpers/env';
import dashboardsRouter from '../../src/routes/dashboards.routes';
import reportsRouter from '../../src/routes/reports.routes';
import searchRouter from '../../src/routes/search.routes';

const DAY = 86_400_000;
const iso = (offsetDays: number, hours = 0): string => new Date(T0.getTime() - offsetDays * DAY - hours * 3_600_000).toISOString();
const base = { org_id: DEMO_ORG_ID, updated_at: iso(0), created_by: null };

/** 2 000 synthetic leads with the full downstream chain (opportunities, quotations, PIs, orders), follow-ups, clocks, consents, messages and 120 dealer receivables. */
function synthetic(leadCount = 2000): { seed: SeedData; expectedValid: number; expectedSo: number } {
  const leads: Lead[] = [], opps: Opportunity[] = [], quotes: Quotation[] = [], pis: ProformaInvoice[] = [], sos: SalesOrder[] = [], fus: Followup[] = [], clocks: Clock[] = [], consents: LeadConsent[] = [], msgs: MessageLog[] = [];
  const statuses: LeadStatus[] = ['new', 'assigned', 'accepted', 'contacted', 'qualified', 'site_visit', 'opportunity', 'won', 'nurture', 'lost', 'duplicate'];
  let expectedValid = 0, expectedSo = 0;
  for (let i = 1; i <= leadCount; i++) {
    const status = statuses[i % statuses.length]!;
    const dist = i % 2 ? IDS.distributorA : IDS.distributorB;
    const created = iso(1 + (i % 80), i % 24);
    const leadId = seedId('perf-lead', i);
    leads.push({ ...base, id: leadId, created_at: created, source: 'website', name: `Synthetic ${i}`, mobile: `+9190000${String(i).padStart(5, '0')}`, email: null, status, segment: SEGMENTS[i % SEGMENTS.length]!, temperature: i % 3 === 0 ? 'hot' : 'warm',
      distributor_id: dist, dealer_id: null, territory_id: null, owner_id: null, deleted_at: null, first_contacted_at: i % 5 === 0 ? null : new Date(Date.parse(created) + (i % 50) * 60_000).toISOString(), dnd_status: 'clear', sla_due_at: iso(0, -(i % 6)) } as Lead);
    if (status !== 'duplicate') expectedValid++;
    if (status === 'duplicate') continue;
    consents.push({ ...base, id: seedId('perf-consent', i), created_at: created, lead_id: leadId, notice_version: 'v1', purposes: ['promotional'], channels: ['whatsapp'], recipients_named: [], granted_at: created, ip: null, user_agent: null, proof_ref: null, capture_source: null, withdrawn_at: null, withdrawn_by: null, withdrawal_channel: null, optout_suppress_until: null } as LeadConsent);
    msgs.push({ id: seedId('perf-msg', i), org_id: DEMO_ORG_ID, created_at: iso(1 + (i % 40)), lead_id: leadId, channel: 'whatsapp', purpose: 'promotional', category: null, template_key: null, direction: 'outbound', to_masked: null, body_preview: null, status: i % 7 === 0 ? 'blocked' : 'sent', block_reason: i % 7 === 0 ? 'DND_REGISTERED' : null, consent_id: null, provider: null, provider_ref: null, created_by: null });
    fus.push({ ...base, id: seedId('perf-fu', i), created_at: created, lead_id: leadId, kind: 'call', due_at: iso(i % 30, 1), note: null, status: i % 4 === 0 ? 'open' : 'done', done_at: i % 4 === 0 ? null : iso(i % 30, 2), owner_id: null, outcome: null, reminder_sent_at: null, escalated_level: 0 });
    clocks.push({ ...base, id: seedId('perf-clock', i), created_at: created, entity_type: 'lead', entity_id: leadId, clock_type: 'lead_acceptance', started_at: created, due_at: iso(i % 20), warn_at: null, status: i % 3 === 0 ? 'breached' : 'met', escalated_level: i % 3 === 0 ? 1 : 0, owner_id: null, warned_at: null, breached_at: null, resolved_at: i % 3 === 0 ? null : created, last_escalated_at: null, meta: {} });
    if (i % 3 === 0) continue; // two thirds go further
    const oppId = seedId('perf-opp', i);
    opps.push({ ...base, id: oppId, created_at: created, name: `Opp ${i}`, lead_id: leadId, customer_id: null, site_id: null, segment: SEGMENTS[i % SEGMENTS.length]!, kw: 5, scheme_route: 'pmsg', funding_mix: { consumer_pct: 100, loan_pct: 0, subsidy_pct: 0 }, probability: 50, expected_value: 250_000, expected_close_date: null, expected_commissioning_date: null, competitor: null, regulation_version: null, exemption_reliance: false, requirement_confirmed: true, timeline_confirmed: true, commercial_potential_confirmed: true, stage: 'qualified', lost_reason: null, owner_id: null, distributor_id: dist, dealer_id: null, territory_id: null } as Opportunity);
    const quoteId = seedId('perf-quote', i);
    quotes.push({ ...base, id: quoteId, created_at: created, quote_no: `QT-${i}`, version: 1, parent_quote_id: null, opportunity_id: oppId, lead_id: leadId, segment: SEGMENTS[i % SEGMENTS.length]!, kw: 5, status: i % 11 === 0 ? 'requote_required' : 'sent', total: 250_000, requote_reason: null, sent_at: created, owner_id: null, distributor_id: dist, dealer_id: null, territory_id: null,
      compliance_findings: i % 9 === 0 ? [{ gate: 'G3', severity: 'hard_stop', message: 'x', ruleIds: [], fieldRefs: [] }] : [] } as unknown as Quotation);
    if (i % 2) continue;
    const piId = seedId('perf-pi', i);
    pis.push({ ...base, id: piId, created_at: created, pi_no: `PI-${i}`, quote_id: quoteId, status: 'issued', total: 250_000, sales_order_id: null, distributor_id: dist, dealer_id: null, legal_name: null, valid_till: null } as unknown as ProformaInvoice);
    if (i % 4) continue;
    expectedSo++;
    sos.push({ ...base, id: seedId('perf-so', i), created_at: created, so_no: `SO-${i}`, pi_id: piId, quote_id: quoteId, segment: SEGMENTS[i % SEGMENTS.length]!, status: 'approved', total: 250_000, order_date: created.slice(0, 10), distributor_id: dist, dealer_id: null, territory_id: null, hold_reason: null } as unknown as SalesOrder);
  }
  const dealers: Dealer[] = [];
  const receivables: DealerReceivable[] = [];
  for (let d = 1; d <= 40; d++) {
    const dealerId = seedId('perf-dealer', d);
    dealers.push({ ...base, id: dealerId, created_at: iso(100), distributor_id: d % 2 ? IDS.distributorA : IDS.distributorB, legal_name: `Perf Dealer ${d}`, credit_limit: 1_000_000, portal_status: 'active', status: 'active', state: 'Gujarat' } as unknown as Dealer);
    for (let r = 0; r < 3; r++) receivables.push({ ...base, id: seedId('perf-recv', d * 10 + r), created_at: iso(30), dealer_id: dealerId, distributor_id: d % 2 ? IDS.distributorA : IDS.distributorB, doc_ref: `INV-${d}-${r}`, amount: 100_000, paid_amount: 0, invoice_date: iso(30).slice(0, 10), due_date: iso(10 * r - 5).slice(0, 10), subsidy_linked: r === 2, linked_project_id: null, status: 'open' });
  }
  return {
    seed: { leads, opportunities: opps, quotations: quotes, proforma_invoices: pis, sales_orders: sos, followups: fus, clocks, lead_consents: consents, message_log: msgs, dealers, dealer_receivables: receivables },
    expectedValid, expectedSo,
  };
}

describe('dashboards on 2 000 synthetic leads', () => {
  const { seed, expectedValid, expectedSo } = synthetic();
  const base0 = baseSeed();
  const env = createTestEnv({ authed: [dashboardsRouter, reportsRouter, searchRouter], seed: { ...base0, ...seed, dealers: [...(base0.dealers ?? []), ...(seed.dealers ?? [])] } });

  it('every dashboard answers in under 2 s and issues a bounded number of queries (no N+1)', async () => {
    const tableSpy = vi.spyOn(env.db, 'table');
    const names = ['funnel', 'sla', 'consent', 'compliance', 'dealer-exposure', 'cfa-pending', 'discom-ageing', 'stock-exposure', 'home'];
    for (const name of names) {
      tableSpy.mockClear();
      const t0 = performance.now();
      const res = await env.as('management').get(`/api/v1/dashboards/${name}`).expect(200);
      const ms = performance.now() - t0;
      expect(ms, `${name} took ${Math.round(ms)} ms`).toBeLessThan(2000);
      // each scoped table() call is one query; a per-lead / per-dealer loop would be in the thousands
      expect(tableSpy.mock.calls.length, `${name} issued ${tableSpy.mock.calls.length} queries`).toBeLessThan(120);
      expect(res.body.data).toBeTruthy();
    }
  }, 60_000);

  it('the numbers are right at volume', async () => {
    const funnel: FunnelDashboard = (await env.as('management').get('/api/v1/dashboards/funnel').expect(200)).body.data;
    expect(funnel.gates[0]!.count).toBe(expectedValid);
    expect(funnel.gates[5]!.count).toBe(expectedSo);
    for (let i = 1; i < funnel.gates.length; i++) expect(funnel.gates[i]!.count).toBeLessThanOrEqual(funnel.gates[i - 1]!.count);
    const sum = funnel.by_segment.reduce((s, r) => s + r.counts.valid_lead, 0);
    expect(sum).toBe(expectedValid);
    const dealers = (await env.as('management').get('/api/v1/dashboards/dealer-exposure').expect(200)).body.data;
    expect(dealers.totals).toMatchObject({ dealers: 43, outstanding: 40 * 300_000 });
  });

  it('exports and searches stay fast too', async () => {
    const t0 = performance.now();
    const res = await env.as('management').get('/api/v1/reports/export?kpi=conv_inquiry_to_qualified').expect(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    const s0 = performance.now();
    const search = await env.as('sales_manager').get('/api/v1/search?q=Synthetic 19').expect(200);
    expect(search.body.data.groups[0].hits).toHaveLength(5);
    expect(performance.now() - s0).toBeLessThan(2000);
    expect(performance.now() - t0).toBeLessThan(6000);
  }, 30_000);
});
