import { describe, expect, it } from 'vitest';
import type { DealerExposureDashboard, Kpi, StockExposureDashboard } from '@solar/shared';
import { computeDealerExposure } from '../../src/services/exposure';
import { IDS, ago, dateOffset, id, makeEnv, seeder, type Seeder } from './fixtures';
import type { TestEnv } from '../helpers/env';

/**
 * Dealer fixture (today = 26-Oct-2026):
 *  A1 (limit ₹10,00,000)  R1 ₹3,00,000 5 d past due · R2 ₹2,00,000 less ₹50,000 paid, 40 d past due · R3 ₹1,00,000 not due, subsidy-linked · R4 paid ₹80,000 (billing only)
 *     → outstanding ₹5,50,000 · overdue ₹4,50,000 (82 %) · subsidy-linked ₹1,00,000 (10 %) · billed 90 d ₹6,80,000 → DSO 73
 *  A2 (limit ₹1,00,000)   R5 ₹1,50,000 100 d past due → over limit, under SOP (vendor registration + open SOP case)
 *  B1 (limit ₹10,00,000)  deactivated on the portal; bank guarantee expires in 30 days
 */
async function seedDealers(s: Seeder) {
  await s.db.table('dealers').update(IDS.dealerA2, { credit_limit: 100_000 });
  await s.db.table('dealers').update(IDS.dealerB1, { portal_status: 'deactivated' });
  await s.receivable(1, IDS.dealerA1, { distributor_id: IDS.distributorA, amount: 300_000, invoice_date: dateOffset(-30), due_date: dateOffset(-5) });
  await s.receivable(2, IDS.dealerA1, { distributor_id: IDS.distributorA, amount: 200_000, paid_amount: 50_000, invoice_date: dateOffset(-50), due_date: dateOffset(-40), status: 'overdue' });
  await s.receivable(3, IDS.dealerA1, { distributor_id: IDS.distributorA, amount: 100_000, invoice_date: dateOffset(-5), due_date: dateOffset(10), subsidy_linked: true });
  await s.receivable(4, IDS.dealerA1, { distributor_id: IDS.distributorA, amount: 80_000, paid_amount: 80_000, invoice_date: dateOffset(-20), due_date: dateOffset(-1), status: 'paid' });
  await s.receivable(5, IDS.dealerA2, { distributor_id: IDS.distributorA, amount: 150_000, invoice_date: dateOffset(-120), due_date: dateOffset(-100), status: 'overdue' });
  await s.vendorReg(1, IDS.dealerA1, { bank_guarantee_valid_till: dateOffset(200) });
  await s.vendorReg(2, IDS.dealerA2, { portal_status: 'under_sop' });
  await s.vendorReg(3, IDS.dealerB1, { bank_guarantee_valid_till: dateOffset(30), portal_status: 'deactivated' });
  await s.db.table('sop_cases').insert({ dealer_id: IDS.dealerA2, complaint_ref: 'C-1', stage: 'reply', notice_at: ago(3) });
}

const kpi = (d: { kpis: Kpi[] }, key: string): Kpi => d.kpis.find((k) => k.key === key)!;
const getDealers = async (env: TestEnv, who: string, qs = ''): Promise<DealerExposureDashboard> => (await env.as(who).get(`/api/v1/dashboards/dealer-exposure${qs}`).expect(200)).body.data;

describe('GET /dashboards/dealer-exposure', () => {
  it('computes per-dealer limit, outstanding, ageing, subsidy-linked exposure, DSO and overdue %', async () => {
    const env = makeEnv();
    await seedDealers(seeder(env));
    const d = await getDealers(env, 'accounts');

    const a1 = d.dealers.find((x) => x.dealer_id === IDS.dealerA1)!;
    expect(a1).toMatchObject({ credit_limit: 1_000_000, outstanding: 550_000, available: 450_000, utilisation_pct: 55, over_limit: false, overdue_amount: 450_000, overdue_pct: 82, subsidy_linked: 100_000, subsidy_linked_pct_of_limit: 10, dso_days: 73, invoices_open: 3, portal_status: 'active' });
    expect(a1.ageing).toEqual({ current: 100_000, d1_30: 300_000, d31_60: 150_000, d61_90: 0, d90_plus: 0 });
    expect(a1.bank_guarantee).toMatchObject({ valid: true, expiring_soon: false });
    expect(a1.distributor_name).toBe('Alpha Solar Distributors');
    expect(a1.path).toBe(`/dealers/${IDS.dealerA1}`);

    const a2 = d.dealers.find((x) => x.dealer_id === IDS.dealerA2)!;
    expect(a2).toMatchObject({ outstanding: 150_000, over_limit: true, utilisation_pct: 150, portal_status: 'under_sop', sop_open: 1, dso_days: null });
    expect(a2.ageing.d90_plus).toBe(150_000);
    expect(a2.blocked_reasons).toEqual(['Dealer is over the approved credit limit', 'Dealer is under an MNRE SOP review']);
  });

  it('totals, dealers under SOP / deactivated / over limit and expiring bank guarantees', async () => {
    const env = makeEnv();
    await seedDealers(seeder(env));
    const d = await getDealers(env, 'accounts');

    expect(d.totals).toMatchObject({ dealers: 3, credit_limit: 2_100_000, outstanding: 700_000, overdue_amount: 600_000, overdue_pct: 86, subsidy_linked: 100_000, subsidy_linked_pct_of_limit: 5, dso_days: 93 });
    expect(d.totals.ageing).toEqual({ current: 100_000, d1_30: 300_000, d31_60: 150_000, d61_90: 0, d90_plus: 150_000 });
    expect(d.flagged.under_sop.map((x) => x.dealer_id)).toEqual([IDS.dealerA2]);
    expect(d.flagged.deactivated.map((x) => x.dealer_id)).toEqual([IDS.dealerB1]);
    expect(d.flagged.over_limit.map((x) => x.dealer_id)).toEqual([IDS.dealerA2]);
    expect(d.flagged.bg_expiring.map((x) => x.dealer_id)).toEqual([IDS.dealerB1]);
    expect(d.dealers.map((x) => x.dealer_id)[0]).toBe(IDS.dealerA1); // sorted by outstanding

    expect(kpi(d, 'dealer_outstanding')).toMatchObject({ value: 700_000, secondary: { value: 2_100_000 } });
    expect(kpi(d, 'dealer_outstanding').breakdown!.map((b) => b.value)).toEqual([100_000, 300_000, 150_000, 0, 150_000]);
    expect(kpi(d, 'dealer_overdue_pct').value).toBe(86);
    expect(kpi(d, 'dealer_dso_days').value).toBe(93);
    expect(kpi(d, 'subsidy_linked_exposure')).toMatchObject({ value: 100_000, secondary: { value: 5, unit: 'pct' } });
    expect(kpi(d, 'dealers_under_sop').value).toBe(1);
    expect(kpi(d, 'dealers_deactivated').value).toBe(1);
    expect(kpi(d, 'dealers_over_limit').value).toBe(1);
    expect(kpi(d, 'dealer_bg_expiring').value).toBe(1);
  });

  it('matches the credit lane arithmetic of computeDealerExposure() for every dealer', async () => {
    const env = makeEnv();
    await seedDealers(seeder(env));
    const d = await getDealers(env, 'accounts');
    for (const row of d.dealers) {
      const k = await computeDealerExposure(env.ctx('accounts'), row.dealer_id);
      expect(row).toMatchObject({
        credit_limit: k.credit_limit, outstanding: k.outstanding, available: k.available, over_limit: k.over_limit, utilisation_pct: k.utilisation_pct, ageing: k.ageing, overdue_amount: k.overdue_amount,
        overdue_pct: k.overdue_pct, subsidy_linked: k.subsidy_linked, subsidy_linked_pct_of_limit: k.subsidy_linked_pct_of_limit, dso_days: k.dso_days, invoices_open: k.invoices_open,
        bank_guarantee: k.bank_guarantee, portal_status: k.portal_status, sop_open: k.sop_open, blocked_reasons: k.blocked_reasons,
      });
    }
  });

  it('distributor and dealer users only see their own dealers; filters narrow management\'s view', async () => {
    const env = makeEnv();
    await seedDealers(seeder(env));
    const dist = await getDealers(env, 'distributor_user'); // distributor A → A1, A2
    expect(dist.dealers.map((x) => x.dealer_id).sort()).toEqual([IDS.dealerA1, IDS.dealerA2].sort());
    expect(dist.totals.outstanding).toBe(700_000);
    const dealer = await getDealers(env, 'dealer_user'); // A1 only
    expect(dealer.dealers.map((x) => x.dealer_id)).toEqual([IDS.dealerA1]);
    expect(dealer.totals.outstanding).toBe(550_000);
    const b = await getDealers(env, IDS.distributorUserB);
    expect(b.dealers.map((x) => x.dealer_id)).toEqual([IDS.dealerB1]);
    expect(b.flagged.deactivated).toHaveLength(1);
    const byDist = await getDealers(env, 'management', `?distributor_id=${IDS.distributorB}`);
    expect(byDist.dealers).toHaveLength(1);
    const byDealer = await getDealers(env, 'management', `?dealer_id=${IDS.dealerA2}`);
    expect(byDealer.totals.outstanding).toBe(150_000);
    // an external user cannot look at another party by passing its id
    const sneaky = await getDealers(env, 'dealer_user', `?dealer_id=${IDS.dealerB1}`);
    expect(sneaky.dealers).toEqual([]);
  });
});

/**
 * Stock fixture — modules whose cells are not on ALMM List-II:
 *  SKU1 (batch B-1, unit cost ₹9,000): 5 in stock non-List-II · 2 in stock List-II (ignored) · 2 dispatched (ignored)
 *  SKU2 (batch B-2, no unit cost → price list ₹11,000): 3 in stock + 1 reserved
 *  SKU4: 2 in stock, no cost and no price → unpriced
 *  SKU3 is an inverter (ignored)
 */
async function seedStock(s: Seeder) {
  await s.sku(1); await s.sku(2, { make: 'Adani', model: 'ASB-540' }); await s.sku(3, { category: 'inverter', make: 'Growatt', model: 'MIN-5000' }); await s.sku(4, { make: 'Vikram', model: 'VSMDH-540' });
  await s.batch(1, 1, { unit_cost: 9_000 }); await s.batch(2, 2, { unit_cost: null, batch_no: 'B-2' });
  await s.price(1, 2, { base_price: 11_000 });
  let n = 0;
  const serials = async (count: number, sku: number, o: Parameters<Seeder['serial']>[2]) => { for (let i = 0; i < count; i++) await s.serial(++n, sku, o); };
  const list2 = { almm_list1: true, almm_list2: true, dcr_verified: true, bis_ok: true, snapshot_date: '2026-10-20' };
  await serials(5, 1, { batch_id: id('batch', 1) });
  await serials(2, 1, { batch_id: id('batch', 1), compliance_snapshot: list2 });
  await serials(2, 1, { batch_id: id('batch', 1), status: 'dispatched' });
  await serials(3, 2, { batch_id: id('batch', 2) });
  await serials(1, 2, { batch_id: id('batch', 2), status: 'reserved' });
  await serials(2, 4, {});
  await serials(4, 3, {});
}
const getStock = (env: TestEnv, who: string) => env.as(who).get('/api/v1/dashboards/stock-exposure');

describe('GET /dashboards/stock-exposure', () => {
  it('counts non-List-II module stock by units and value, by SKU and batch', async () => {
    const env = makeEnv();
    await seedStock(seeder(env));
    await env.rule('almm.list2.exemption_net_metering_open_access_until', '2026-12-31');
    const d: StockExposureDashboard = (await getStock(env, 'accounts').expect(200)).body.data;

    expect(d.totals).toEqual({ units: 10, value: 78_000, unpriced_units: 2, reserved_units: 1, skus: 3, batches: 3 });
    expect(d.by_sku.map((r) => [r.model, r.units, r.value, r.unpriced_units])).toEqual([['WSMD-1', 5, 45_000, 0], ['ASB-540', 3, 33_000, 0], ['VSMDH-540', 2, 0, 2]]);
    expect(d.by_sku[0]!.pct_of_value).toBe(57.7);
    expect(d.by_batch[0]).toMatchObject({ batch_no: 'B-1', units: 5, unit_cost: 9_000, value: 45_000 });
    expect(d.by_batch.find((b) => b.batch_no === 'B-2')).toMatchObject({ units: 3, unit_cost: null, value: 33_000 });
    expect(d.by_batch.find((b) => b.batch_id === null)).toMatchObject({ batch_no: 'No batch', units: 2, unpriced_units: 2 });

    const kpis = Object.fromEntries(d.kpis.map((k) => [k.key, k]));
    expect(kpis['non_list2_stock_value']).toMatchObject({ value: 78_000, unit: 'inr', secondary: { value: 10 } });
    expect(kpis['non_list2_stock_value']!.note).toMatch(/2 unit/);
    expect(kpis['non_list2_stock_units']).toMatchObject({ value: 10, secondary: { value: 1 } });
  });

  it('shows days to the exemption date from the rule, with its status', async () => {
    const env = makeEnv();
    await seedStock(seeder(env));
    await env.rule('almm.list2.exemption_net_metering_open_access_until', '2026-12-31', { confidence: 'high' });
    const d: StockExposureDashboard = (await getStock(env, 'accounts').expect(200)).body.data;
    expect(d.exemption).toMatchObject({ date: '2026-12-31', days_left: 66, urgency: 'watch' });
    expect(d.exemption.rule).toMatchObject({ path: 'almm.list2.exemption_net_metering_open_access_until', status: 'verified', active: true, fallback_used: false });
    expect(d.kpis.find((k) => k.key === 'list2_exemption_days_left')!.value).toBe(66);

    env.setNow(new Date('2026-12-10T05:00:00Z'));
    const near: StockExposureDashboard = (await getStock(env, 'accounts').expect(200)).body.data;
    expect(near.exemption).toMatchObject({ days_left: 21, urgency: 'critical' });
    env.setNow(new Date('2027-01-05T05:00:00Z'));
    const after: StockExposureDashboard = (await getStock(env, 'accounts').expect(200)).body.data;
    expect(after.exemption).toMatchObject({ days_left: -5, urgency: 'passed' });
  });

  it('falls back to 31-Dec-2026 when the rule is absent and is closed to external users', async () => {
    const env = makeEnv();
    await seedStock(seeder(env));
    const d: StockExposureDashboard = (await getStock(env, 'management').expect(200)).body.data;
    expect(d.exemption.date).toBe('2026-12-31');
    expect(d.exemption.rule.fallback_used).toBe(true);
    await getStock(env, 'distributor_user').expect(403);
    await getStock(env, 'dealer_user').expect(403);
  });

  it('is empty (urgency none) when no non-List-II module is in stock', async () => {
    const env = makeEnv();
    const d: StockExposureDashboard = (await getStock(env, 'management').expect(200)).body.data;
    expect(d.totals.units).toBe(0);
    expect(d.exemption.urgency).toBe('none');
  });
});
