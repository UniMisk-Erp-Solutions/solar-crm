import { describe, expect, it } from 'vitest';
import type { FunnelDashboard, Kpi } from '@solar/shared';
import { IDS, ago, dateOffset, makeEnv, seeder, type Seeder } from './fixtures';
import type { TestEnv } from '../helpers/env';

/**
 * Funnel fixture (cohort = leads created in the last 90 days):
 *   PMSG   L1 won (opp,quote,PI,SO) · L2 opportunity (opp,quote,PI) · L3 opportunity (opp,quote) · L4 qualified · L5 contacted · L6 duplicate (excluded)
 *   CI-NM  L7 site_visit + completed survey · L8 opportunity (opp only) · L9 new · L10 won (opp,quote,PI,SO)
 *   none   L11 new, no segment
 *   out    L12 created 200 days ago (outside the period), L13 soft-deleted
 * Totals → valid 10 · qualified 7 · opportunity 5 · quotation 4 · PI 3 · sales order 2
 */
async function seedFunnel(s: Seeder) {
  const A = IDS.distributorA, B = IDS.distributorB;
  await s.lead(1, { status: 'won', segment: 'pmsg_residential', distributor_id: A, dealer_id: IDS.dealerA1 });
  await s.lead(2, { status: 'opportunity', segment: 'pmsg_residential', distributor_id: B });
  await s.lead(3, { status: 'opportunity', segment: 'pmsg_residential', distributor_id: B });
  await s.lead(4, { status: 'qualified', segment: 'pmsg_residential', distributor_id: B });
  await s.lead(5, { status: 'contacted', segment: 'pmsg_residential', distributor_id: B });
  await s.lead(6, { status: 'duplicate', segment: 'pmsg_residential', distributor_id: B });
  await s.lead(7, { status: 'site_visit', segment: 'ci_net_metered', distributor_id: A });
  await s.lead(8, { status: 'opportunity', segment: 'ci_net_metered', distributor_id: B });
  await s.lead(9, { status: 'new', segment: 'ci_net_metered', distributor_id: B });
  await s.lead(10, { status: 'won', segment: 'ci_net_metered', distributor_id: A });
  await s.lead(11, { status: 'new', segment: null });
  await s.lead(12, { status: 'won', segment: 'pmsg_residential', created_at: ago(200), distributor_id: B });
  await s.lead(13, { status: 'new', segment: 'pmsg_residential', deleted_at: ago(1), distributor_id: B });

  // opportunities → quotations → PIs → SOs
  await s.opp(1, 1, { distributor_id: A, dealer_id: IDS.dealerA1 }); await s.quote(1, 1, { distributor_id: A, dealer_id: IDS.dealerA1 });
  await s.pi(1, 1, { distributor_id: A, dealer_id: IDS.dealerA1 }); await s.so(1, 1, 1, { distributor_id: A, dealer_id: IDS.dealerA1 });
  await s.opp(2, 2, { distributor_id: B }); await s.quote(2, 2, { distributor_id: B }); await s.pi(2, 2, { distributor_id: B });
  await s.opp(3, 3, { distributor_id: B }); await s.quote(3, 3, { distributor_id: B });
  await s.opp(8, 8, { segment: 'ci_net_metered', distributor_id: B });
  await s.opp(10, 10, { segment: 'ci_net_metered', distributor_id: A }); await s.quote(10, 10, { segment: 'ci_net_metered', distributor_id: A });
  await s.pi(10, 10, { distributor_id: A }); await s.so(10, 10, 10, { segment: 'ci_net_metered', distributor_id: A });
  // a cancelled PI and a cancelled SO on L3's quotation must not count
  await s.pi(11, 3, { distributor_id: B, status: 'cancelled' }); await s.so(11, 11, 3, { distributor_id: B, status: 'cancelled' });

  // surveys: L1, L2, L3, L7 completed; L4 only scheduled
  for (const n of [1, 2, 3, 7]) await s.survey(n, n, { status: 'completed' });
  await s.survey(4, 4, { status: 'scheduled' });

  // loans: 4 applied in period (2 approved/disbursed), 1 draft, 1 outside the period
  await s.loan(1, { status: 'approved', bank: 'SBI' }); await s.loan(2, { status: 'disbursed', bank: 'SBI' }); await s.loan(3, { status: 'rejected', bank: 'HDFC', rejection_code: 'name_mismatch' });
  await s.loan(4, { status: 'in_review', bank: 'HDFC' }); await s.loan(5, { status: 'draft' }); await s.loan(6, { status: 'approved', application_date: dateOffset(-200), created_at: ago(200) });
}

const kpi = (d: FunnelDashboard, key: string): Kpi => d.kpis.find((k) => k.key === key)!;
const get = async (env: TestEnv, who: string, qs = ''): Promise<FunnelDashboard> => (await env.as(who).get(`/api/v1/dashboards/funnel${qs}`).expect(200)).body.data;

describe('GET /dashboards/funnel', () => {
  it('counts the six conversion gates and the five conversion percentages exactly', async () => {
    const env = makeEnv();
    await seedFunnel(seeder(env));
    const d = await get(env, 'management');

    expect(d.gates.map((g) => [g.key, g.count])).toEqual([['valid_lead', 10], ['qualified_lead', 7], ['opportunity', 5], ['quotation', 4], ['pi', 3], ['sales_order', 2]]);
    expect(d.gates[1]).toMatchObject({ pct_of_previous: 70, pct_of_valid: 70 });
    expect(kpi(d, 'conv_inquiry_to_qualified').value).toBe(70);
    expect(kpi(d, 'conv_qualified_to_opportunity').value).toBe(71.4);
    expect(kpi(d, 'conv_opportunity_to_quotation').value).toBe(80);
    expect(kpi(d, 'conv_quotation_to_pi').value).toBe(75);
    expect(kpi(d, 'conv_pi_to_sales_order').value).toBe(66.7);
    expect(kpi(d, 'funnel_gates').breakdown!.map((b) => b.value)).toEqual([10, 7, 5, 4, 3, 2]);
  });

  it('splits every conversion by segment', async () => {
    const env = makeEnv();
    await seedFunnel(seeder(env));
    const d = await get(env, 'management');

    const pmsg = d.by_segment.find((s) => s.segment === 'pmsg_residential')!;
    expect(pmsg.counts).toEqual({ valid_lead: 5, qualified_lead: 4, opportunity: 3, quotation: 3, pi: 2, sales_order: 1 });
    expect(pmsg.conversions).toEqual({ inquiry_to_qualified: 80, qualified_to_opportunity: 75, opportunity_to_quotation: 100, quotation_to_pi: 66.7, pi_to_sales_order: 50 });
    const ci = d.by_segment.find((s) => s.segment === 'ci_net_metered')!;
    expect(ci.counts).toEqual({ valid_lead: 4, qualified_lead: 3, opportunity: 2, quotation: 1, pi: 1, sales_order: 1 });
    expect(ci.conversions).toEqual({ inquiry_to_qualified: 75, qualified_to_opportunity: 66.7, opportunity_to_quotation: 50, quotation_to_pi: 100, pi_to_sales_order: 100 });
    expect(d.by_segment.find((s) => s.segment === 'unspecified')!.counts.valid_lead).toBe(1);

    const q2o = kpi(d, 'conv_inquiry_to_qualified').breakdown!;
    expect(q2o.find((b) => b.key === 'pmsg_residential')).toMatchObject({ value: 80, numerator: 4, denominator: 5 });
    expect(q2o.find((b) => b.key === 'ci_net_metered')).toMatchObject({ value: 75, numerator: 3, denominator: 4 });
  });

  it('computes Survey → Quote and Loan approved ÷ applied', async () => {
    const env = makeEnv();
    await seedFunnel(seeder(env));
    const d = await get(env, 'management');
    expect(kpi(d, 'survey_to_quote_pct')).toMatchObject({ value: 75, secondary: { value: 4 } });
    expect(kpi(d, 'survey_to_quote_pct').breakdown!.find((b) => b.key === 'ci_net_metered')).toMatchObject({ value: 0, numerator: 0, denominator: 1 });
    expect(kpi(d, 'loan_approval_pct')).toMatchObject({ value: 50, secondary: { value: 4 } });
    expect(kpi(d, 'loan_approval_pct').breakdown!.find((b) => b.label === 'SBI')).toMatchObject({ value: 100, numerator: 2, denominator: 2 });
  });

  it('every KPI carries a plain-language definition', async () => {
    const env = makeEnv();
    await seedFunnel(seeder(env));
    const d = await get(env, 'management');
    expect(d.kpis).toHaveLength(8);
    for (const k of d.kpis) expect(k.definition.length).toBeGreaterThan(20);
  });

  it('honours the segment and period filters', async () => {
    const env = makeEnv();
    await seedFunnel(seeder(env));
    const ci = await get(env, 'management', '?segment=ci_net_metered');
    expect(ci.gates.map((g) => g.count)).toEqual([4, 3, 2, 1, 1, 1]);
    expect(ci.filters.segment).toBe('ci_net_metered');
    // widening the period to include L12 (created 200 days ago, won) — it has no downstream rows but is a 'won' lead
    const wide = await get(env, 'management', `?from=${dateOffset(-260)}&to=${dateOffset(0)}`);
    expect(wide.gates[0]!.count).toBe(11);
    expect(wide.period.from).toBe(dateOffset(-260));
    // narrow period → nothing
    const none = await get(env, 'management', `?from=${dateOffset(-400)}&to=${dateOffset(-300)}`);
    expect(none.gates.every((g) => g.count === 0)).toBe(true);
    expect(kpi(none, 'conv_inquiry_to_qualified').value).toBeNull();
  });

  it('defaults to the last 90 days and rejects bad dates', async () => {
    const env = makeEnv();
    const d = await get(env, 'management');
    expect(d.period).toEqual({ from: dateOffset(-89), to: dateOffset(0), days: 90 });
    await env.as('management').get('/api/v1/dashboards/funnel?from=2026-13-45x').expect(422);
    await env.as('management').get(`/api/v1/dashboards/funnel?from=${dateOffset(0)}&to=${dateOffset(-5)}`).expect(422);
    await env.as('management').get('/api/v1/dashboards/funnel?segment=nonsense').expect(422);
  });

  it('a distributor user sees only their own party\'s numbers', async () => {
    const env = makeEnv();
    await seedFunnel(seeder(env));
    // distributor A owns L1, L7, L10 and their chains
    const a = await get(env, 'distributor_user');
    expect(a.gates.map((g) => g.count)).toEqual([3, 3, 2, 2, 2, 2]);
    // distributor B's user sees B's leads (L2,L3,L4,L5,L8,L9 + dup excluded)
    const b = await get(env, IDS.distributorUserB);
    expect(b.gates.map((g) => g.count)).toEqual([6, 4, 3, 2, 1, 0]);
    // a dealer user sees just their dealer's lead (L1)
    const dl = await get(env, 'dealer_user');
    expect(dl.gates.map((g) => g.count)).toEqual([1, 1, 1, 1, 1, 1]);
    // an external user cannot widen the scope with filters
    const sneaky = await get(env, 'distributor_user', `?distributor_id=${IDS.distributorB}`);
    expect(sneaky.gates[0]!.count).toBe(0);
  });
});
