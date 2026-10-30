import { describe, expect, it } from 'vitest';
import { API, IDS, newEnv } from '../postsale/fixtures';
import type { TestEnv } from '../helpers/env';

/** Dealer A1 (limit ₹10 L): ₹1 L current, ₹2 L 15 days late, ₹3 L 117 days late and subsidy-linked. All billed on 1-Sep-2026. */
async function seedBook(env: TestEnv) {
  const db = env.ctx().db;
  const mk = (amount: number, due: string, subsidy = false, dealer = IDS.dealerA1, ref = `INV-${due}`) => db.table('dealer_receivables').insert({
    dealer_id: dealer, distributor_id: dealer === IDS.dealerB1 ? IDS.distributorB : IDS.distributorA, doc_ref: ref, amount, paid_amount: 0, invoice_date: '2026-09-01', due_date: due, subsidy_linked: subsidy, linked_project_id: null, status: 'open',
  });
  await mk(100000, '2026-11-15'); await mk(200000, '2026-10-10'); await mk(300000, '2026-07-01', true);
}

describe('dealer scorecard', () => {
  it('computes DSO, overdue %, ageing, subsidy-linked exposure vs limit, deactivations, complaints, portal status, territory and BG expiry', async () => {
    const env = newEnv();
    await seedBook(env);
    await env.db.table('dealers').update(IDS.dealerA1, { complaint_count: 3 });
    const reg = (await env.as('accounts').post(`${API}/vendor-registrations`).send({
      party_type: 'dealer', party_id: IDS.dealerA1, level: 'state', states: ['Gujarat'], portal_vendor_id: 'GJ-001', bank_guarantee_amount: 250000, bank_guarantee_valid_till: '2026-12-01',
      portal_status: 'deactivated', deactivated_from: '2026-03-01', deactivated_to: '2026-04-01',
    })).body.data;
    await env.as('accounts').patch(`${API}/vendor-registrations/${reg.id}`).send({ portal_status: 'active' });

    const r = await env.as('dsm').get(`${API}/dealers/${IDS.dealerA1}/scorecard`);
    expect(r.status).toBe(200);
    const s = r.body.data;
    expect(s).toMatchObject({ dealer_id: IDS.dealerA1, dealer_name: 'Sunrise Installers', as_of: '2026-10-26', territory: { id: IDS.territoryAhmedabad, name: 'Ahmedabad' } });
    expect(s.credit).toEqual({ limit: 1_000_000, outstanding: 600000, available: 400000, utilisation_pct: 60, over_limit: false });
    expect(s.dso_days).toBe(90); // ₹6 L outstanding ÷ ₹6 L billed in 90 days × 90
    expect(s.ageing).toEqual({ current: 100000, d1_30: 200000, d31_60: 0, d61_90: 0, d90_plus: 300000 });
    expect(s).toMatchObject({ overdue_amount: 500000, overdue_pct: 83, invoices_open: 3 });
    expect(s.subsidy_linked).toEqual({ amount: 300000, pct_of_limit: 30, exceeds_limit: false });
    expect(s).toMatchObject({ portal_status: 'active', deactivations: 1, complaint_count: 3, sop_open: 0 });
    expect(s.bank_guarantee).toMatchObject({ amount: 250000, valid_till: '2026-12-01', days_left: 36, valid: true, expiring_soon: true, alert_days: 60 });
    expect(s.bank_guarantee.alert).toMatch(/expires in 36 day/);
    expect(s.alerts).toEqual(expect.arrayContaining([expect.stringMatching(/Bank guarantee expires in 36/), 'Rebate slabs not configured', '83% of the outstanding balance is overdue']));
  });

  it('flags an over-limit dealer and expired / missing guarantees', async () => {
    const env = newEnv();
    await seedBook(env);
    await env.ctx().db.table('dealer_receivables').insert({ dealer_id: IDS.dealerA1, distributor_id: IDS.distributorA, doc_ref: 'BIG', amount: 700000, paid_amount: 0, invoice_date: '2026-10-01', due_date: '2026-11-30', subsidy_linked: false, linked_project_id: null, status: 'open' });
    const s = (await env.as('accounts').get(`${API}/dealers/${IDS.dealerA1}/scorecard`)).body.data;
    expect(s.credit).toMatchObject({ over_limit: true, outstanding: 1_300_000, available: 0 });
    expect(s.alerts[0]).toMatch(/Over the credit limit/);
    expect(s.bank_guarantee.alert).toBe('No bank guarantee on file');
    await env.as('accounts').post(`${API}/vendor-registrations`).send({ party_type: 'dealer', party_id: IDS.dealerA1, level: 'state', bank_guarantee_amount: 250000, bank_guarantee_valid_till: '2026-09-01' });
    expect((await env.as('accounts').get(`${API}/dealers/${IDS.dealerA1}/scorecard`)).body.data.bank_guarantee).toMatchObject({ valid: false, expiring_soon: false, alert: 'Bank guarantee expired on 2026-09-01' });
  });

  it('is limited to the caller’s own dealers', async () => {
    const env = newEnv();
    expect((await env.as('dealer_user').get(`${API}/dealers/${IDS.dealerA1}/scorecard`)).status).toBe(200);
    expect((await env.as('dealer_user').get(`${API}/dealers/${IDS.dealerA2}/scorecard`)).status).toBe(403);
    expect((await env.as('distributor_user').get(`${API}/dealers/${IDS.dealerA2}/scorecard`)).status).toBe(200);
    expect((await env.as('distributor_user').get(`${API}/dealers/${IDS.dealerB1}/scorecard`)).status).toBe(403);
    expect((await env.as('dsm').get(`${API}/dealers/e1111111-1111-4111-8111-111111111111/scorecard`)).status).toBe(404);
  });
});

describe('rebate accrual — configurable slabs, no defaults', () => {
  it('absent rule ⇒ accrual 0 with an explicit "slabs not configured" flag', async () => {
    const env = newEnv();
    await seedBook(env);
    const s = (await env.as('accounts').get(`${API}/dealers/${IDS.dealerA1}/scorecard`)).body.data;
    expect(s.rebate).toMatchObject({ slabs_configured: false, accrued: 0, rate_pct: null, volume: 0 });
    expect(s.rebate.message).toMatch(/slabs are not configured/i);
    const persisted = await env.as('accounts').post(`${API}/dealers/${IDS.dealerA1}/rebate/recompute`).send({});
    expect(persisted.body.data).toMatchObject({ slabs_configured: false, accrued: 0 });
    expect((await env.db.table('dealers').get(IDS.dealerA1))?.rebate_accrued).toBe(0);
  });

  it('an inactive rule is treated as not configured', async () => {
    const env = newEnv();
    await seedBook(env);
    await env.rule('channel.rebate_slabs', [{ from: 0, rate_pct: 1 }], { is_active: false, status: 'unverified', confidence: 'hypothesis' });
    const s = (await env.as('accounts').get(`${API}/dealers/${IDS.dealerA1}/scorecard`)).body.data;
    expect(s.rebate).toMatchObject({ slabs_configured: false, accrued: 0 });
    expect(s.rebate.message).toMatch(/not active/);
  });

  it('flat slabs apply the slab reached to the whole financial-year billing', async () => {
    const env = newEnv();
    await seedBook(env);
    await env.rule('channel.rebate_slabs', { period: 'fy', mode: 'flat', slabs: [{ from: 0, rate_pct: 0 }, { from: 500000, rate_pct: 1 }, { from: 1000000, rate_pct: 2 }] });
    const s = (await env.as('accounts').get(`${API}/dealers/${IDS.dealerA1}/scorecard`)).body.data;
    expect(s.rebate).toMatchObject({ slabs_configured: true, period: 'fy', period_start: '2026-04-01', period_end: '2027-03-31', mode: 'flat', volume: 600000, rate_pct: 1, accrued: 6000, message: null });
    expect(s.alerts).not.toContain('Rebate slabs not configured');
    const saved = await env.as('accounts').post(`${API}/dealers/${IDS.dealerA1}/rebate/recompute`).send({});
    expect(saved.body.data.accrued).toBe(6000);
    expect((await env.db.table('dealers').get(IDS.dealerA1))?.rebate_accrued).toBe(6000);
  });

  it('marginal slabs and a slab set chosen by the distributor’s rebate_slab_key', async () => {
    const env = newEnv();
    await seedBook(env);
    await env.db.table('distributors').update(IDS.distributorA, { rebate_slab_key: 'gold' });
    await env.rule('channel.rebate_slabs', {
      default: [{ from: 0, rate_pct: 0.5 }],
      gold: { period: 'quarter', mode: 'marginal', slabs: [{ from: 0, to: 500000, rate_pct: 0.5 }, { from: 500000, rate_pct: 1 }] },
    });
    const s = (await env.as('accounts').get(`${API}/dealers/${IDS.dealerA1}/scorecard`)).body.data;
    expect(s.rebate).toMatchObject({ period: 'quarter', period_start: '2026-10-01', period_end: '2026-12-31', volume: 0 }); // bills are from September (previous quarter)
    await env.ctx().db.table('dealer_receivables').insert({ dealer_id: IDS.dealerA1, distributor_id: IDS.distributorA, doc_ref: 'Q3', amount: 600000, paid_amount: 0, invoice_date: '2026-10-05', due_date: '2026-12-05', subsidy_linked: false, linked_project_id: null, status: 'open' });
    const t = (await env.as('accounts').get(`${API}/dealers/${IDS.dealerA1}/scorecard`)).body.data;
    expect(t.rebate).toMatchObject({ mode: 'marginal', volume: 600000, accrued: 3500, rate_pct: 1 }); // 5 L × 0.5% + 1 L × 1%
    // dealers of a distributor without a key fall back to "default"
    const b = (await env.as('accounts').get(`${API}/dealers/${IDS.dealerB1}/scorecard`)).body.data;
    expect(b.rebate).toMatchObject({ slabs_configured: true, mode: 'flat' });
  });
});

describe('GET /dealers/exposure', () => {
  it('returns every visible dealer’s exposure row, busiest first, scoped by role', async () => {
    const env = newEnv();
    await seedBook(env);
    await env.ctx().db.table('dealer_receivables').insert({ dealer_id: IDS.dealerA2, distributor_id: IDS.distributorA, doc_ref: 'A2', amount: 50000, paid_amount: 0, invoice_date: '2026-10-01', due_date: '2026-11-30', subsidy_linked: false, linked_project_id: null, status: 'open' });
    const all = await env.as('accounts').get(`${API}/dealers/exposure`);
    expect(all.status).toBe(200);
    expect(all.body.data.map((d: { dealer_id: string }) => d.dealer_id)).toEqual([IDS.dealerA1, IDS.dealerA2, IDS.dealerB1]);
    expect(all.body.data[0]).toMatchObject({ outstanding: 600000, utilisation_pct: 60, subsidy_linked: 300000, subsidy_linked_pct_of_limit: 30, dso_days: 90, over_limit: false });
    expect((await env.as('distributor_user').get(`${API}/dealers/exposure`)).body.data).toHaveLength(2);
    expect((await env.as('dealer_user').get(`${API}/dealers/exposure`)).body.data.map((d: { dealer_id: string }) => d.dealer_id)).toEqual([IDS.dealerA1]);
    expect((await env.as('accounts').get(`${API}/dealers/exposure?distributor_id=${IDS.distributorB}`)).body.data).toHaveLength(1);
    await env.db.table('dealers').update(IDS.dealerA2, { credit_limit: 10000 });
    const over = await env.as('accounts').get(`${API}/dealers/exposure?over_limit=true`);
    expect(over.body.data.map((d: { dealer_id: string }) => d.dealer_id)).toEqual([IDS.dealerA2]);
  });
});

describe('dealer CRUD scoping', () => {
  it('distributor sees only its own dealers; a dealer only itself', async () => {
    const env = newEnv();
    expect((await env.as('distributor_user').get(`${API}/dealers`)).body.data.map((d: { id: string }) => d.id).sort()).toEqual([IDS.dealerA1, IDS.dealerA2].sort());
    expect((await env.as(IDS.distributorUserB).get(`${API}/dealers`)).body.data.map((d: { id: string }) => d.id)).toEqual([IDS.dealerB1]);
    expect((await env.as('dealer_user').get(`${API}/dealers`)).body.data.map((d: { id: string }) => d.id)).toEqual([IDS.dealerA1]);
    expect((await env.as('dealer_user').get(`${API}/dealers/${IDS.dealerA2}`)).status).toBe(403);
    expect((await env.as('distributor_user').get(`${API}/dealers/${IDS.dealerB1}`)).status).toBe(403);
    expect((await env.as('admin').get(`${API}/dealers`)).body.total).toBe(3);
    const one = await env.as('distributor_user').get(`${API}/dealers/${IDS.dealerA1}`);
    expect(one.body.data).toMatchObject({ distributor_name: 'Alpha Solar Distributors', territory_name: 'Ahmedabad', open_sop_cases: [], vendor_registrations: [] });
  });

  it('a distributor adds dealers to its own book (onboarding, no credit) but cannot touch limits, status or another distributor', async () => {
    const env = newEnv();
    const base = { legal_name: 'Kiran Solar Works', state: 'Gujarat', city: 'Mehsana', gstin: '24ABCDE1234F1Z5' };
    const mine = await env.as('distributor_user').post(`${API}/dealers`).send({ ...base, credit_limit: 9_000_000, status: 'active' });
    expect(mine.status).toBe(201);
    expect(mine.body.data).toMatchObject({ distributor_id: IDS.distributorA, credit_limit: 0, status: 'onboarding', portal_status: 'active', complaint_count: 0, rebate_accrued: 0, security_type: 'none' });
    const other = await env.as('distributor_user').post(`${API}/dealers`).send({ ...base, distributor_id: IDS.distributorB });
    expect(other.status).toBe(403);
    const edit = await env.as('distributor_user').patch(`${API}/dealers/${mine.body.data.id}`).send({ contact_name: 'Kiran Shah', phone: '9876543210' });
    expect(edit.body.data.contact_name).toBe('Kiran Shah');
    const limit = await env.as('distributor_user').patch(`${API}/dealers/${mine.body.data.id}`).send({ credit_limit: 1_000_000 });
    expect(limit.status).toBe(403);
    expect((await env.as('distributor_user').patch(`${API}/dealers/${IDS.dealerB1}`).send({ contact_name: 'x' })).status).toBe(403);
    // accounts sets the limit; every change is audited
    const set = await env.as('accounts').patch(`${API}/dealers/${mine.body.data.id}`).send({ credit_limit: 500000, status: 'active', security_type: 'bank_guarantee', security_amount: 250000 });
    expect(set.body.data).toMatchObject({ credit_limit: 500000, status: 'active', security_type: 'bank_guarantee' });
    expect((await env.db.table('audit_log').all({ action: 'dealer.update', record_id: mine.body.data.id })).length).toBe(2);
    expect((await env.db.table('audit_log').all({ action: 'dealer.create' })).length).toBe(1);
  });

  it('dealers and viewers cannot write; invalid GSTIN and unknown distributor are refused', async () => {
    const env = newEnv();
    const body = { legal_name: 'Test Dealer', state: 'Gujarat', distributor_id: IDS.distributorA };
    expect((await env.as('dealer_user').post(`${API}/dealers`).send(body)).status).toBe(403);
    expect((await env.as('viewer').post(`${API}/dealers`).send(body)).status).toBe(403);
    expect((await env.as('accounts').post(`${API}/dealers`).send({ ...body, gstin: '123' })).status).toBe(422);
    expect((await env.as('accounts').post(`${API}/dealers`).send({ ...body, distributor_id: 'e1111111-1111-4111-8111-111111111111' })).status).toBe(422);
    expect((await env.as('dsm').post(`${API}/dealers`).send(body)).status).toBe(201);
  });
});
