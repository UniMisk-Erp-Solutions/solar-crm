/** Quote arithmetic: totals, tax, margin / floor check, CFA / state / loan / consumer split, validity capping, numbering. */
import { describe, expect, it } from 'vitest';
import { addSku, makeWorld, quoteWith, type WorldOpts } from './helpers';

async function cfaQuote(o: WorldOpts, qty = 10) {
  const w = await makeWorld(o);
  const q = await quoteWith(w, [await addSku(w)], { qty });
  return { w, q: await w.c().db.table('quotations').getOrThrow(q.id) };
}

describe('CFA entitlement in a quote (computed by the rule engine)', () => {
  it.each([
    [1, 30000, 1], [2, 60000, 2], [3, 78000, 3], [4, 78000, 3],
  ])('PMSG %s kW → ₹ %s CFA on %s kW', async (kw, cfa, eligible) => {
    const { q } = await cfaQuote({ kw });
    expect(q.cfa_entitlement).toBe(cfa);
    expect((q.cfa_breakdown as { cfa: { eligible_kw: number } }).cfa.eligible_kw).toBe(eligible);
  });

  it('special-category state uses the higher rates', async () => {
    const { q } = await cfaQuote({ kw: 3, siteOver: { special_category_state: true } });
    expect(q.cfa_entitlement).toBe(85800); // 2 × 33,000 + 19,800
  });

  it('existing solar counts against the 3 kW cap', async () => {
    const { q } = await cfaQuote({ kw: 3, siteOver: { existing_solar_kw: 1 } });
    expect(q.cfa_entitlement).toBe(60000);
  });

  it('RWA / GHS: ₹ 18,000 per kW up to 500 kW and 3 kW per household', async () => {
    const big = await cfaQuote({ segment: 'rwa_ghs', kw: 100 }, 200);
    expect(big.q.cfa_entitlement).toBe(1_800_000);
    const w = await makeWorld({ segment: 'rwa_ghs', kw: 100 });
    await w.c().db.table('requirement_forms').insert({ lead_id: w.ids.lead, opportunity_id: w.ids.opp, site_id: w.ids.site, segment: 'rwa_ghs', data: { households: 20 }, completed_at: null, completed_by: null });
    const q = await quoteWith(w, [await addSku(w)], { qty: 200 });
    expect((await w.c().db.table('quotations').getOrThrow(q.id)).cfa_entitlement).toBe(1_080_000); // 20 households × 3 kW × ₹ 18,000
  });

  it('no central subsidy for C&I segments', async () => {
    const { q } = await cfaQuote({ segment: 'ci_net_metered', kw: 100 });
    expect(q.cfa_entitlement).toBe(0);
  });

  it('an inactive CFA rule never silently produces a subsidy', async () => {
    const w = await makeWorld({ rules: false });
    await w.env.rule('pmsg.cfa.per_kw_first_2kw', 30000, { is_active: false, status: 'unverified' });
    await w.env.rule('pmsg.cfa.third_kw', 18000);
    await w.env.rule('pmsg.cfa.max_kw_eligible', 3);
    const q = await quoteWith(w, [await addSku(w)], { qty: 10 });
    const row = await w.c().db.table('quotations').getOrThrow(q.id);
    expect(row.cfa_entitlement).toBe(0);
    expect(JSON.stringify(row.cfa_breakdown)).toMatch(/not active/);
  });

  it('splits the total into CFA, state share (configurable scheme), loan share and consumer share', async () => {
    const w = await makeWorld({ kw: 3, fundingLoanPct: 20 });
    await w.env.rule('gujarat.state_subsidy', { per_kw: 10000, max_total: 20000 }, { max_severity: 'warning' });
    const q = await quoteWith(w, [await addSku(w)], { qty: 10 });
    const row = await w.c().db.table('quotations').getOrThrow(q.id);
    expect(row.total).toBe(210000);
    expect(row).toMatchObject({ cfa_entitlement: 78000, state_share: 20000, loan_share: 42000, consumer_share: 70000 });
    expect(row.cfa_entitlement + row.state_share + row.loan_share + row.consumer_share).toBe(row.total);
    expect(row.rule_ids_used.length).toBeGreaterThan(5);
  });

  it('an empty or inactive state-scheme object means no state share', async () => {
    const empty = await makeWorld({ rules: true });
    await empty.env.rule('gujarat.state_subsidy', {}, { max_severity: 'warning' });
    expect((await empty.c().db.table('quotations').getOrThrow((await quoteWith(empty, [await addSku(empty)])).id)).state_share).toBe(0);
    const off = await makeWorld();
    await off.env.rule('gujarat.state_subsidy', { flat: 15000 }, { is_active: false, status: 'unverified' });
    expect((await off.c().db.table('quotations').getOrThrow((await quoteWith(off, [await addSku(off)])).id)).state_share).toBe(0);
  });
});

describe('totals, tax, margin and floor check', () => {
  it('computes subtotal, discount, per-line GST, total, margin over landed cost', async () => {
    const w = await makeWorld({ kw: 3 });
    const q = await quoteWith(w, [await addSku(w)], { qty: 10, discount_pct: 10 });
    const row = await w.c().db.table('quotations').getOrThrow(q.id);
    expect(row).toMatchObject({ subtotal: 200000, discount_amount: 20000, discount_pct: 10, tax_total: 9000, total: 189000, margin_pct: 25, place_of_supply: 'Gujarat' });
    expect(row.floor_check).toMatchObject({ ok: true, margin_pct: 25 });
  });

  it('flags a line priced below the floor price', async () => {
    const w = await makeWorld();
    const q = await quoteWith(w, [await addSku(w)], { qty: 1, discount_pct: 30 });
    const row = await w.c().db.table('quotations').getOrThrow(q.id);
    expect(row.floor_check?.ok).toBe(false);
    expect(row.floor_check?.lines[0]).toMatchObject({ unit_price: 14000, floor_price: 15000, below_floor: true });
  });

  it('refuses a SKU with no price snapshot, an inactive SKU and an unknown SKU', async () => {
    const w = await makeWorld();
    const created = await w.env.as('dsm').post('/api/v1/quotes').send({ opportunity_id: w.ids.opp });
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;
    const noPrice = await addSku(w, { price: null });
    const inactive = await addSku(w, { active: false });
    const put = (sku_id: string) => w.env.as('dsm').put(`/api/v1/quotes/${id}/lines`).send({ lines: [{ sku_id, qty: 1 }] });
    expect((await put(noPrice.id)).status).toBe(422);
    expect((await put(inactive.id)).status).toBe(422);
    expect((await put('11111111-1111-4111-8111-111111111111')).status).toBe(404);
  });

  it('numbers quotes FS/Q/<yy>/<nnnn> in sequence, version 1', async () => {
    const w = await makeWorld();
    const a = await w.env.as('dsm').post('/api/v1/quotes').send({ opportunity_id: w.ids.opp });
    const b = await w.env.as('dsm').post('/api/v1/quotes').send({ opportunity_id: w.ids.opp });
    expect(a.body.data.quote_no).toBe('FS/Q/26/0001');
    expect(b.body.data.quote_no).toBe('FS/Q/26/0002');
    expect(a.body.data.version).toBe(1);
    expect(a.body.data).toMatchObject({ kw: 3, segment: 'pmsg_residential', owner_id: expect.any(String), dealer_id: expect.any(String) });
    expect((await w.c().db.table('opportunities').getOrThrow(w.ids.opp)).stage).toBe('quotation');
  });
});

describe('quote validity', () => {
  it('defaults to quote date + 7 days', async () => {
    const w = await makeWorld();
    const q = await w.env.as('dsm').post('/api/v1/quotes').send({ opportunity_id: w.ids.opp });
    expect(q.body.data.validity_date).toBe('2026-11-02');
  });

  it('is capped at the price valid_to of a line once lines are added', async () => {
    const w = await makeWorld();
    const q = await quoteWith(w, [await addSku(w, { price: { valid_to: '2026-10-29' } })]);
    expect((await w.c().db.table('quotations').getOrThrow(q.id)).validity_date).toBe('2026-10-29');
  });

  it('is capped at the price-snapshot age limit', async () => {
    const w = await makeWorld({ rules: false });
    await w.env.rule('quote.default_validity_days', 30, { max_severity: 'warning' });
    await w.env.rule('quote.max_price_snapshot_age_days', 5, { max_severity: 'warning' });
    const q = await w.env.as('dsm').post('/api/v1/quotes').send({ opportunity_id: w.ids.opp });
    expect(q.body.data.validity_date).toBe('2026-10-31');
  });

  it('is capped at the exemption date when the job relies on the exemption', async () => {
    const w = await makeWorld({ segment: 'ci_net_metered', kw: 100, exemption: true, commissioning: '2026-12-20' });
    w.env.setNow(new Date('2026-12-28T05:00:00Z'));
    const q = await w.env.as('dsm').post('/api/v1/quotes').send({ opportunity_id: w.ids.opp });
    expect(q.body.data.validity_date).toBe('2026-12-31');
  });

  it('an explicit past validity date is refused', async () => {
    const w = await makeWorld();
    const q = await w.env.as('dsm').post('/api/v1/quotes').send({ opportunity_id: w.ids.opp, validity_date: '2026-10-01' });
    expect(q.status).toBe(422);
  });
});
