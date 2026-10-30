import { describe, expect, it } from 'vitest';
import type { CfaPendingDashboard, DiscomAgeingDashboard, Kpi } from '@solar/shared';
import { IDS, ago, ahead, dateOffset, id, makeEnv, seeder, type Seeder } from './fixtures';
import type { TestEnv } from '../helpers/env';

/**
 * DISCOM fixture (all durations are whole days):
 *   UGVCL  A1 feasibility 15 (deemed, clock lapsed) · inspection 5 · meter 5 · commissioning 12
 *          A2 feasibility 4 · inspection 12 · meter 6 · commissioning 20 (late → deemed breach)
 *          A3 feasibility 8 · inspection 5 · meter 3 · commissioning 10
 *   DGVCL  A4 feasibility pending 20 d, past its 15-day clock (breach) · A5 certificate 10 d ago, awaiting inspection
 *   A6 submitted 200 days ago (outside the period)
 * UGVCL → feasibility [15,4,8] median 8 / p90 13.6 · inspection [5,12,5] 5 / 10.6 · meter [5,6,3] 5 / 5.8 · commissioning [12,20,10] 12 / 18.4
 */
async function seedDiscom(s: Seeder) {
  await s.discom(1, 'UGVCL', 'Uttar Gujarat Vij Company Ltd');
  await s.discom(2, 'DGVCL', 'Dakshin Gujarat Vij Company Ltd');
  const U = id('discom', 1), D = id('discom', 2);
  const clock = (n: number, appN: number, o: object) => s.clock(n, { entity_type: 'discom_application', entity_id: id('dapp', appN), clock_type: 'discom_feasibility', ...o });

  await s.discomApp(1, { discom_id: U, distributor_id: IDS.distributorA, dealer_id: IDS.dealerA1, submitted_at: ago(41), complete_at: ago(40), feasibility_status: 'deemed', feasibility_due_at: ago(25),
    certificate_submitted_at: ago(20), commissioning_due_at: ago(5), inspection_at: ago(15), meter_at: ago(10), commissioning_at: ago(8) });
  await clock(1, 1, { status: 'breached', started_at: ago(40), due_at: ago(25), resolved_at: ago(25) });
  await s.discomApp(2, { discom_id: U, distributor_id: IDS.distributorA, dealer_id: IDS.dealerA1, submitted_at: ago(41), complete_at: ago(40), feasibility_status: 'approved', feasibility_due_at: ago(25),
    certificate_submitted_at: ago(30), commissioning_due_at: ago(15), inspection_at: ago(18), meter_at: ago(12), commissioning_at: ago(10) });
  await clock(2, 2, { status: 'met', started_at: ago(40), due_at: ago(25), resolved_at: ago(36) });
  await s.discomApp(3, { discom_id: U, distributor_id: IDS.distributorB, dealer_id: IDS.dealerB1, submitted_at: ago(36), complete_at: ago(35), feasibility_status: 'approved', feasibility_due_at: ago(20),
    certificate_submitted_at: ago(25), commissioning_due_at: ago(10), inspection_at: ago(20), meter_at: ago(17), commissioning_at: ago(15) });
  await clock(3, 3, { status: 'met', started_at: ago(35), due_at: ago(20), resolved_at: ago(27) });
  await s.discomApp(4, { discom_id: D, distributor_id: IDS.distributorB, dealer_id: IDS.dealerB1, submitted_at: ago(21), complete_at: ago(20), feasibility_status: 'pending', feasibility_due_at: ago(5) });
  await s.discomApp(5, { discom_id: D, distributor_id: IDS.distributorB, dealer_id: IDS.dealerB1, submitted_at: ago(15), feasibility_status: 'not_required', certificate_submitted_at: ago(10), commissioning_due_at: ahead(5) });
  await s.discomApp(6, { discom_id: U, submitted_at: ago(200), created_at: ago(200), complete_at: ago(199), feasibility_status: 'approved', feasibility_due_at: ago(184), certificate_submitted_at: ago(150), inspection_at: ago(140), meter_at: ago(135), commissioning_at: ago(130) });
  await clock(6, 6, { status: 'met', started_at: ago(199), due_at: ago(184), resolved_at: ago(190) });
}

const kpi = (d: { kpis: Kpi[] }, key: string): Kpi => d.kpis.find((k) => k.key === key)!;
const getDiscom = async (env: TestEnv, who: string, qs = ''): Promise<DiscomAgeingDashboard> => (await env.as(who).get(`/api/v1/dashboards/discom-ageing${qs}`).expect(200)).body.data;
const getCfa = async (env: TestEnv, who: string, qs = ''): Promise<CfaPendingDashboard> => (await env.as(who).get(`/api/v1/dashboards/cfa-pending${qs}`).expect(200)).body.data;

describe('GET /dashboards/discom-ageing', () => {
  it('computes median and p90 days per DISCOM for feasibility, inspection, meter and commissioning', async () => {
    const env = makeEnv();
    await seedDiscom(seeder(env));
    const d = await getDiscom(env, 'management');

    const ug = d.rows.find((r) => r.discom_code === 'UGVCL')!;
    expect(ug.applications).toBe(3);
    expect(ug.stages.feasibility).toMatchObject({ n: 3, median_days: 8, p90_days: 13.6, open: 0 });
    expect(ug.stages.inspection).toMatchObject({ n: 3, median_days: 5, p90_days: 10.6 });
    expect(ug.stages.meter).toMatchObject({ n: 3, median_days: 5, p90_days: 5.8 });
    expect(ug.stages.commissioning).toMatchObject({ n: 3, median_days: 12, p90_days: 18.4 });

    const dg = d.rows.find((r) => r.discom_code === 'DGVCL')!;
    expect(dg.applications).toBe(2);
    expect(dg.stages.feasibility).toMatchObject({ n: 0, median_days: null, open: 1, oldest_open_days: 20 });
    expect(dg.stages.inspection).toMatchObject({ n: 0, open: 1, oldest_open_days: 10 });

    // the dashboard tiles carry the overall median with p90 alongside, plus a per-DISCOM breakdown
    expect(kpi(d, 'discom_feasibility_ageing')).toMatchObject({ value: 8, unit: 'days', secondary: { label: '90th percentile', value: 13.6 } });
    expect(kpi(d, 'discom_feasibility_ageing').breakdown!.find((b) => b.label.includes('Uttar'))).toMatchObject({ value: 8, p90: 13.6, n: 3 });
    expect(d.overall.applications).toBe(5); // A6 is outside the period
  });

  it('counts deemed-clock breaches (feasibility silence and late commissioning)', async () => {
    const env = makeEnv();
    await seedDiscom(seeder(env));
    const d = await getDiscom(env, 'management');
    expect(kpi(d, 'discom_deemed_breaches').value).toBe(3);
    expect(d.deemed_breach_list.map((b) => [b.application_no, b.clock]).sort()).toEqual([['DA-1', 'feasibility'], ['DA-2', 'commissioning'], ['DA-4', 'feasibility']]);
    expect(d.rows.find((r) => r.discom_code === 'UGVCL')!.deemed_breaches).toBe(2);
    expect(d.rows.find((r) => r.discom_code === 'DGVCL')!.deemed_breaches).toBe(1);
    expect(d.deemed_breach_list.find((b) => b.application_no === 'DA-4')!.days_over).toBe(5);
  });

  it('a wider period brings in older applications', async () => {
    const env = makeEnv();
    await seedDiscom(seeder(env));
    const d = await getDiscom(env, 'management', `?from=${dateOffset(-300)}&to=${dateOffset(0)}`);
    expect(d.overall.applications).toBe(6);
    expect(d.rows.find((r) => r.discom_code === 'UGVCL')!.stages.feasibility.n).toBe(4);
  });

  it('agrees with discomStageAgeing() used by the post-sale board', async () => {
    const env = makeEnv();
    await seedDiscom(seeder(env));
    const { discomStageAgeing } = await import('../../src/services/discomService');
    const board = await discomStageAgeing(env.ctx('management'), { from: dateOffset(-89), to: dateOffset(0) });
    const d = await getDiscom(env, 'management');
    for (const row of board.rows) {
      const mine = d.rows.find((r) => r.discom_id === row.discom_id)!;
      for (const st of ['feasibility', 'inspection', 'meter', 'commissioning'] as const) {
        // same population, count, median and open items as the board ...
        expect({ st, n: mine.stages[st].n, median: mine.stages[st].median_days, open: mine.stages[st].open })
          .toEqual({ st, n: row[st].n, median: row[st].median_days, open: row[st].pending });
        // ... the board uses nearest-rank p90, the dashboard linear interpolation (Postgres percentile_cont) — never above the nearest-rank value
        if (row[st].p90_days !== null) {
          expect(mine.stages[st].p90_days!).toBeLessThanOrEqual(row[st].p90_days! + 1e-9);
          expect(mine.stages[st].p90_days!).toBeGreaterThanOrEqual(row[st].median_days! - 1e-9);
        }
      }
    }
  });

  it('external users only see their own party\'s applications', async () => {
    const env = makeEnv();
    await seedDiscom(seeder(env));
    const a = await getDiscom(env, 'distributor_user'); // distributor A owns A1, A2
    expect(a.overall.applications).toBe(2);
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0]!.discom_code).toBe('UGVCL');
    expect(kpi(a, 'discom_deemed_breaches').value).toBe(2);
    const dl = await getDiscom(env, 'dealer_user'); // dealer A1 → A1, A2
    expect(dl.overall.applications).toBe(2);
    const b = await getDiscom(env, IDS.dealerUserB); // dealer B1 → A3, A4, A5
    expect(b.overall.applications).toBe(3);
  });
});

/**
 * CFA fixture (today = 26-Oct-2026):
 *   K1 current, claimed, DISCOM-approved 10 d ago, ₹78,000   K2 current, ready, 20 d, ₹60,000   K3 current, claimed, 70 d, ₹30,000
 *   K4 current, released     K5 legacy, ready, no DISCOM approval yet, ₹78,000   K6 legacy, claimed, 25 d, ₹66,000   K7 legacy released   K8 legacy rejected
 * pending (K1,K2,K3,K6) = ₹2,34,000, ages [10,20,25,70] → median 22.5, p90 56.5 · legacy at risk (K5,K6) = 2 / ₹1,44,000, 35 days to 30-Nov-2026
 */
async function seedCfa(s: Seeder) {
  const A1 = IDS.dealerA1, A2 = IDS.dealerA2, B1 = IDS.dealerB1;
  await s.claim(1, { dealer_id: A1, distributor_id: IDS.distributorA, status: 'claimed', discom_approval_at: ago(10), cfa_computed: 78_000, state_share: 10_000, state_share_due_at: ahead(5) });
  await s.claim(2, { dealer_id: A2, distributor_id: IDS.distributorA, status: 'ready', discom_approval_at: ago(20), cfa_computed: 60_000, state_share: 20_000, state_share_due_at: ago(10) });
  await s.claim(3, { dealer_id: B1, distributor_id: IDS.distributorB, status: 'claimed', discom_approval_at: ago(70), cfa_computed: 30_000, state_share: 5_000, state_share_due_at: ago(45) });
  await s.claim(4, { dealer_id: B1, distributor_id: IDS.distributorB, status: 'released', discom_approval_at: ago(40), released_at: ago(5), cfa_computed: 78_000, state_share: 15_000, state_share_due_at: ago(100) });
  await s.claim(5, { dealer_id: B1, distributor_id: IDS.distributorB, status: 'ready', cohort: 'legacy', cfa_computed: 78_000 });
  await s.claim(6, { dealer_id: A1, distributor_id: IDS.distributorA, status: 'claimed', cohort: 'legacy', discom_approval_at: ago(25), cfa_computed: 66_000 });
  await s.claim(7, { dealer_id: B1, distributor_id: IDS.distributorB, status: 'released', cohort: 'legacy', released_at: ago(3), cfa_computed: 78_000 });
  await s.claim(8, { dealer_id: B1, distributor_id: IDS.distributorB, status: 'rejected', cohort: 'legacy', cfa_computed: 78_000, state_share: 9_999 });
}

describe('GET /dashboards/cfa-pending', () => {
  it('computes CFA pending value and age since DISCOM approval', async () => {
    const env = makeEnv();
    await seedCfa(seeder(env));
    const d = await getCfa(env, 'accounts');

    expect(kpi(d, 'cfa_pending_value')).toMatchObject({ value: 234_000, unit: 'inr', secondary: { value: 4 } });
    expect(kpi(d, 'cfa_pending_age_days')).toMatchObject({ value: 22.5, secondary: { value: 56.5 } });
    expect(d.age_buckets).toEqual([
      { label: '0–15 days', count: 1, value: 78_000 }, { label: '16–30 days', count: 2, value: 126_000 }, { label: '31–60 days', count: 0, value: 0 },
      { label: '61–90 days', count: 1, value: 30_000 }, { label: 'Over 90 days', count: 0, value: 0 },
    ]);
    expect(d.pending.map((p) => p.age_days)).toEqual([70, 25, 20, 10]); // oldest first
    // released after 15 days is policy; K2, K3 and K6 have waited longer
    expect(kpi(d, 'cfa_release_overdue')).toMatchObject({ value: 3, secondary: { value: 156_000 } });
  });

  it('reports legacy-cohort claims at risk with days to the 30-Nov-2026 deadline', async () => {
    const env = makeEnv();
    await seedCfa(seeder(env));
    const d = await getCfa(env, 'accounts');
    expect(kpi(d, 'legacy_claims_at_risk')).toMatchObject({ value: 2, secondary: { value: 35, unit: 'days' } });
    expect(kpi(d, 'legacy_claims_at_risk_value').value).toBe(144_000);
    expect(kpi(d, 'legacy_days_to_deadline').value).toBe(35);
    expect(d.legacy).toMatchObject({ deadline: '2026-11-30', days_to_deadline: 35, count: 2, value: 144_000 });
    expect(d.legacy.rule).toMatchObject({ path: 'pmsg.claim_deadline.legacy_cohort', fallback_used: true });
    expect(d.legacy.claims.map((c) => c.claim_id)).toHaveLength(2);
    expect(kpi(d, 'legacy_claims_at_risk').note).toMatch(/advisory/i);
  });

  it('reads the deadline from the rule when present and shows its status', async () => {
    const env = makeEnv();
    await seedCfa(seeder(env));
    await env.rule('pmsg.claim_deadline.legacy_cohort', '2026-12-15', { status: 'unverified', confidence: 'medium' });
    const d = await getCfa(env, 'accounts');
    expect(d.legacy).toMatchObject({ deadline: '2026-12-15', days_to_deadline: 50 });
    expect(d.legacy.rule).toMatchObject({ status: 'unverified', confidence: 'medium', active: true, fallback_used: false });
  });

  it('ages the state-share receivable by days past due', async () => {
    const env = makeEnv();
    await seedCfa(seeder(env));
    const d = await getCfa(env, 'accounts');
    expect(d.state_share.total_receivable).toBe(50_000);
    expect(d.state_share.count).toBe(4);
    expect(d.state_share.buckets).toEqual([
      { label: 'Not yet due', count: 1, value: 10_000 }, { label: '1–30 days', count: 1, value: 20_000 }, { label: '31–60 days', count: 1, value: 5_000 },
      { label: '61–90 days', count: 0, value: 0 }, { label: 'Over 90 days', count: 1, value: 15_000 },
    ]);
    expect(kpi(d, 'state_share_receivable').value).toBe(50_000);
  });

  it('external users only see their own claims; filters narrow further', async () => {
    const env = makeEnv();
    await seedCfa(seeder(env));
    const a = await getCfa(env, 'distributor_user'); // distributor A: K1, K2, K6
    expect(kpi(a, 'cfa_pending_value').value).toBe(78_000 + 60_000 + 66_000);
    expect(kpi(a, 'legacy_claims_at_risk').value).toBe(1);
    const dl = await getCfa(env, 'dealer_user'); // dealer A1: K1, K6
    expect(kpi(dl, 'cfa_pending_value').value).toBe(78_000 + 66_000);
    const filtered = await getCfa(env, 'management', `?dealer_id=${IDS.dealerB1}`);
    expect(kpi(filtered, 'cfa_pending_value').value).toBe(30_000);
    expect(kpi(filtered, 'legacy_claims_at_risk').value).toBe(1);
  });
});
