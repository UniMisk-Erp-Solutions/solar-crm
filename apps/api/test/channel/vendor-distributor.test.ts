import { describe, expect, it } from 'vitest';
import { seedId } from '@solar/shared';
import { registeredJobs } from '../../src/services/hooks';
import { scanBankGuarantees } from '../../src/services/vendorService';
import { API, IDS, newEnv } from '../postsale/fixtures';
import type { TestEnv } from '../helpers/env';

const reg = (env: TestEnv, who: string, body: Record<string, unknown>) => env.as(who).post(`${API}/vendor-registrations`).send({ party_type: 'dealer', party_id: IDS.dealerA1, level: 'state', ...body });

describe('vendor registrations', () => {
  it('stores level, portal vendor id, states / districts, bank guarantee and portal status', async () => {
    const env = newEnv();
    const r = await reg(env, 'accounts', { level: 'multi_state', portal_vendor_id: 'PMSG-MS-114', states: ['Gujarat', 'Rajasthan'], districts: ['Ahmedabad', 'Gandhinagar'], bank_guarantee_amount: 500000, bank_guarantee_valid_till: '2031-03-31', notes: 'BG with SBI Navrangpura' });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ party_type: 'dealer', level: 'multi_state', portal_vendor_id: 'PMSG-MS-114', states: ['Gujarat', 'Rajasthan'], portal_status: 'active', complaint_count: 0, party_name: 'Sunrise Installers', deactivated_from: null });
    expect((await env.as('accounts').get(`${API}/vendor-registrations?party_id=${IDS.dealerA1}&level=multi_state`)).body.total).toBe(1);
    expect((await reg(env, 'accounts', { party_id: seedIdUnknown })).status).toBe(400);
    expect((await reg(env, 'accounts', { level: 'galactic' })).status).toBe(422);
    const dist = await reg(env, 'accounts', { party_type: 'distributor', party_id: IDS.distributorA, level: 'national', bank_guarantee_amount: 2500000, bank_guarantee_valid_till: '2031-01-01' });
    expect(dist.body.data.party_name).toBe('Alpha Solar Distributors');
  });

  it('checks the guarantee against pmsg.vendor_bg.* as a WARNING only — and only while the rule is active', async () => {
    const env = newEnv();
    await env.rule('pmsg.vendor_bg.national', 2500000, { status: 'unverified', confidence: 'medium', max_severity: 'warning' });
    await env.rule('pmsg.vendor_bg.per_state', 250000, { status: 'unverified', confidence: 'medium', max_severity: 'warning' });
    const low = await reg(env, 'accounts', { level: 'multi_state', states: ['Gujarat', 'Rajasthan'], bank_guarantee_amount: 300000, bank_guarantee_valid_till: '2031-03-31' });
    expect(low.status).toBe(201); // never blocks
    expect(low.body.data.bg_warnings).toEqual([expect.objectContaining({ code: 'BG_AMOUNT_LOW', severity: 'warning', advisory: true })]);
    expect(low.body.data.bg_warnings[0].message).toMatch(/₹ 3,00,000 is below the ₹ 5,00,000/);
    const none = await reg(env, 'accounts', { party_type: 'distributor', party_id: IDS.distributorA, level: 'national' });
    expect(none.body.data.bg_warnings[0]).toMatchObject({ code: 'BG_MISSING' });
    const ok = await reg(env, 'accounts', { level: 'multi_state', states: ['Gujarat'], bank_guarantee_amount: 250000, bank_guarantee_valid_till: '2031-03-31', portal_vendor_id: 'ok' });
    expect(ok.body.data.bg_warnings).toEqual([]);
    const rule = (await env.db.table('rule_config').all({ key: 'vendor_bg.per_state' }))[0]!;
    await env.db.table('rule_config').update(rule.id, { is_active: false });
    const relaxed = await env.as('accounts').get(`${API}/vendor-registrations/${low.body.data.id}`);
    expect(relaxed.body.data.bg_warnings).toEqual([]);
  });

  it('mirrors every portal-status change to dealers.portal_status and audits it', async () => {
    const env = newEnv();
    const a = (await reg(env, 'sales_manager', { portal_vendor_id: 'GJ-1' })).body.data;
    const b = (await reg(env, 'sales_manager', { portal_vendor_id: 'RJ-1', states: ['Rajasthan'] })).body.data;
    const status = () => env.db.table('dealers').get(IDS.dealerA1).then((d) => d?.portal_status);
    expect(await status()).toBe('active');

    const under = await env.as('sales_manager').patch(`${API}/vendor-registrations/${a.id}`).send({ portal_status: 'under_sop' });
    expect(under.body.data.portal_status).toBe('under_sop');
    expect(await status()).toBe('under_sop');
    const deact = await env.as('sales_manager').patch(`${API}/vendor-registrations/${b.id}`).send({ portal_status: 'deactivated' });
    expect(deact.body.data).toMatchObject({ portal_status: 'deactivated', deactivated_from: '2026-10-26' }); // defaulted to today
    expect(await status()).toBe('deactivated'); // worst of the dealer's registrations
    await env.as('sales_manager').patch(`${API}/vendor-registrations/${b.id}`).send({ portal_status: 'active' });
    expect(await status()).toBe('under_sop');
    await env.as('sales_manager').patch(`${API}/vendor-registrations/${a.id}`).send({ portal_status: 'active' });
    expect(await status()).toBe('active');
    const audits = await env.db.table('audit_log').all({ action: 'vendor_registration.portal_status_change' });
    expect(audits.length).toBe(6); // 2 creates + 4 changes
    expect(audits.some((x) => (x.new_data as { portal_status: string }).portal_status === 'deactivated')).toBe(true);
    expect((await env.db.table('audit_log').all({ action: 'dealer.portal_status_change' })).map((x) => (x.new_data as { portal_status: string }).portal_status)).toEqual(['under_sop', 'deactivated', 'under_sop', 'active']);
    expect((await env.as('sales_manager').patch(`${API}/vendor-registrations/${a.id}`).send({ deactivated_from: '2026-05-01', deactivated_to: '2026-04-01' })).status).toBe(422);
  });

  it('is an internal register: dealers and viewers cannot read or write', async () => {
    const env = newEnv();
    expect((await env.as('dealer_user').get(`${API}/vendor-registrations`)).status).toBe(403);
    expect((await env.as('distributor_user').get(`${API}/vendor-registrations`)).status).toBe(403);
    expect((await reg(env, 'viewer', {})).status).toBe(403);
    expect((await reg(env, 'dealer_user', {})).status).toBe(403);
    expect((await env.as('viewer').get(`${API}/vendor-registrations`)).status).toBe(200);
  });
});

const seedIdUnknown = seedId('unknown-dealer', 1);

describe('bank-guarantee expiry scan', () => {
  async function seedGuarantees(env: TestEnv) {
    const mk = (till: string, ref: string, party: string = IDS.dealerA1, type = 'dealer') => env.ctx().db.table('vendor_registrations').insert({
      party_type: type as 'dealer', party_id: party, level: 'state', portal_vendor_id: ref, states: ['Gujarat'], districts: [], bank_guarantee_amount: 250000, bank_guarantee_valid_till: till,
      portal_status: 'active', deactivated_from: null, deactivated_to: null, complaint_count: 0, notes: null,
    });
    return { soon: await mk('2026-11-25', 'SOON'), expired: await mk('2026-10-01', 'EXPIRED', IDS.dealerA2), later: await mk('2027-06-30', 'LATER', IDS.dealerB1), distributor: await mk('2026-12-20', 'DIST', IDS.distributorA, 'distributor') };
  }

  it('alerts Accounts, DSM and Sales Manager about guarantees expiring within 60 days or already expired, once a week', async () => {
    const env = newEnv();
    const regs = await seedGuarantees(env);
    const first = await scanBankGuarantees(env.systemCtx());
    expect(first).toMatchObject({ scanned: 4, expiring: 2, expired: 1 });
    expect(first.notified).toBe(9); // 3 registrations × 3 recipients
    const soon = await env.db.table('notifications').all({ entity_id: regs.soon.id });
    expect(soon.map((n) => n.user_id).sort()).toEqual([IDS.profile('accounts'), IDS.profile('dsm'), IDS.profile('sales_manager')].sort());
    expect(soon[0]).toMatchObject({ kind: 'vendor.bg_expiring', severity: 'warning', link: `/dealers/${IDS.dealerA1}`, title: expect.stringContaining('30 days') });
    expect((await env.db.table('notifications').all({ entity_id: regs.expired.id }))[0]).toMatchObject({ kind: 'vendor.bg_expired', severity: 'critical' });
    expect(await env.db.table('notifications').count({ entity_id: regs.later.id })).toBe(0);
    expect((await env.db.table('notifications').all({ entity_id: regs.distributor.id }))[0]?.link).toBe(`/distributors/${IDS.distributorA}`);

    expect((await scanBankGuarantees(env.systemCtx())).notified).toBe(0); // same day: nothing repeated
    env.setNow(new Date(env.now().getTime() + 8 * 86400000));
    expect((await scanBankGuarantees(env.systemCtx())).notified).toBe(0); // unread alerts are never duplicated
    await env.db.table('notifications').updateWhere({ kind: ['vendor.bg_expiring', 'vendor.bg_expired'] }, { read_at: env.now().toISOString() });
    expect((await scanBankGuarantees(env.systemCtx())).notified).toBe(9); // once read, reminded again after a week
  });

  it('uses the configurable alert window and is available as a nightly job and an on-demand endpoint', async () => {
    const env = newEnv();
    await seedGuarantees(env);
    await env.rule('reporting.bg_expiry_alert_days', 20);
    expect(await scanBankGuarantees(env.systemCtx())).toMatchObject({ expiring: 0, expired: 1 }); // 30 and 55 days away are outside a 20-day window
    expect(registeredJobs().map((j) => j.name)).toEqual(expect.arrayContaining(['channel.bank_guarantee_scan', 'distributor.score_recompute', 'receivables.overdue_sweep', 'subsidy.legacy_claim_reminders', 'discom.deemed_feasibility_sweep']));
    expect((await env.as('dealer_user').post(`${API}/vendor-registrations/scan-bank-guarantees`).send({})).status).toBe(403);
    const api = await env.as('accounts').post(`${API}/vendor-registrations/scan-bank-guarantees`).send({});
    expect(api.status).toBe(200);
    expect(api.body.data.scanned).toBe(4);
  });
});

describe('distributor score', () => {
  async function seedHistory(env: TestEnv) {
    const db = env.ctx().db;
    const mkLead = (n: number, status: string) => db.table('leads').insert({ id: seedId('d-lead', n), name: `Lead ${n}`, mobile: '+919812345678', source: 'manual', status: status as never, distributor_id: IDS.distributorA });
    for (let n = 1; n <= 4; n++) await mkLead(n, n <= 2 ? 'accepted' : 'assigned');
    for (const n of [1, 2]) await db.table('opportunities').insert({ name: `Opp ${n}`, lead_id: seedId('d-lead', n), distributor_id: IDS.distributorA, stage: 'qualified' });
    const mkAssign = (n: number, status: string, responded: string | null) => db.table('lead_assignments').insert({
      lead_id: seedId('d-lead', n), distributor_id: IDS.distributorA, step: 'auto', status: status as never, assigned_at: '2026-10-10T05:00:00.000Z', due_at: '2026-10-10T07:00:00.000Z', responded_at: responded, reason: null, score_snapshot: {},
    });
    for (let n = 1; n <= 4; n++) await mkAssign(n, 'accepted', '2026-10-10T06:00:00.000Z');
    await mkAssign(5, 'rejected', '2026-10-11T06:00:00.000Z');
  }

  it('recomputes a 0–100 score from acceptance, timeliness, conversion, compliance and load, and appends a history row', async () => {
    const env = newEnv();
    await seedHistory(env);
    const r = await env.as('dsm').post(`${API}/distributors/${IDS.distributorA}/score/recompute`).send({});
    expect(r.status).toBe(200);
    const d = r.body.data;
    const by = Object.fromEntries(d.components.map((c: { key: string }) => [c.key, c]));
    expect(by.acceptance_rate).toMatchObject({ weight: 30, factor: 0.8, points: 24 }); // 4 of 5
    expect(by.acceptance_time).toMatchObject({ weight: 15, factor: 1, points: 15 });
    expect(by.conversion).toMatchObject({ weight: 25, factor: 1, points: 25 });           // 2 of 4 leads = 50% ≥ the 40% full-credit rate
    expect(by.compliance).toMatchObject({ weight: 20, factor: 1, points: 20 });
    expect(by.load).toMatchObject({ weight: 10, factor: 0.84, points: 8.4 });             // 4 open leads of a 25 ceiling
    expect(d).toMatchObject({ score: 92, previous_score: 80, distributor_id: IDS.distributorA });
    expect((await env.db.table('distributors').get(IDS.distributorA))?.score).toBe(92);
    const history = await env.db.table('distributor_score_history').all({ distributor_id: IDS.distributorA });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ score: 92, id: d.history_id });
    expect((history[0]!.components as unknown as { key: string }[]).map((c) => c.key)).toEqual(['acceptance_rate', 'acceptance_time', 'conversion', 'compliance', 'load']);

    await env.as('dsm').post(`${API}/distributors/${IDS.distributorA}/score/recompute`).send({});
    const hist = await env.as('sales_manager').get(`${API}/distributors/${IDS.distributorA}/score-history`);
    expect(hist.body.data).toHaveLength(2);
    expect((await env.db.table('audit_log').all({ action: 'distributor.score_recompute' })).length).toBe(2);
  });

  it('weights come from rule distributor.score_weights', async () => {
    const env = newEnv();
    await seedHistory(env);
    await env.rule('distributor.score_weights', { acceptance_rate: 100, acceptance_time: 0, conversion: 0, compliance: 0, load: 0 });
    const r = await env.as('dsm').post(`${API}/distributors/${IDS.distributorA}/score/recompute`).send({});
    expect(r.body.data.score).toBe(80); // 4 of 5 accepted
    expect(r.body.data.components.find((c: { key: string }) => c.key === 'acceptance_rate').weight).toBe(100);
  });

  it('penalises complaints, SOP notices and deactivations; too little history is neutral and flagged', async () => {
    const env = newEnv();
    // no history at all
    let r = await env.as('dsm').post(`${API}/distributors/${IDS.distributorB}/score/recompute`).send({});
    const neutral = r.body.data.components.filter((c: { insufficient_data?: boolean }) => c.insufficient_data).map((c: { key: string }) => c.key);
    expect(neutral).toEqual(['acceptance_rate', 'acceptance_time', 'conversion']);
    expect(r.body.data.score).toBe(Math.round(15 + 7.5 + 12.5 + 20 + 10)); // 0.5 × (30+15+25) + full compliance + empty load = 65
    expect(r.body.data.score).toBe(65);

    await env.db.table('dealers').update(IDS.dealerB1, { complaint_count: 2, portal_status: 'deactivated' });
    await env.as('dsm').post(`${API}/sop-cases`).send({ dealer_id: IDS.dealerB1, complaint_ref: 'X-1' });
    r = await env.as('dsm').post(`${API}/distributors/${IDS.distributorB}/score/recompute`).send({});
    const compliance = r.body.data.components.find((c: { key: string }) => c.key === 'compliance');
    // 1 − (0.5 × 1/1 deactivated dealers + 0.15 open SOP + 2 × 0.05 complaints + 0.05 for the case just opened) = 0.2
    expect(compliance.factor).toBeCloseTo(0.2, 2);
    expect(r.body.data.score).toBeLessThan(65);
  });

  it('a new distributor starts with a computed score and history; only channel administrators create or recompute', async () => {
    const env = newEnv();
    const created = await env.as('sales_manager').post(`${API}/distributors`).send({ legal_name: 'Gamma Solar Traders', state: 'Gujarat', city: 'Rajkot', capability_tags: ['module', 'inverter'], capacity_band_min_kw: 1, capacity_band_max_kw: 500, credit_days: 30, credit_limit: 2_500_000 });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ status: 'onboarding', capability_tags: ['module', 'inverter'], capacity_band_max_kw: 500, dealer_count: 0 });
    expect(await env.db.table('distributor_score_history').count({ distributor_id: created.body.data.id })).toBe(1);
    expect((await env.db.table('distributors').get(created.body.data.id))?.score).toBe(65);
    expect((await env.as('sales_manager').post(`${API}/distributors`).send({ legal_name: 'Bad Band', state: 'Gujarat', capacity_band_min_kw: 100, capacity_band_max_kw: 10 })).status).toBe(422);
    expect((await env.as('distributor_user').post(`${API}/distributors`).send({ legal_name: 'Nope', state: 'Gujarat' })).status).toBe(403);
    expect((await env.as('distributor_user').post(`${API}/distributors/${IDS.distributorA}/score/recompute`).send({})).status).toBe(403);
    expect((await env.as('viewer').post(`${API}/distributors/${IDS.distributorA}/score/recompute`).send({})).status).toBe(403);
    expect((await env.as('dsm').post(`${API}/distributors/${seedId('nope', 1)}/score/recompute`).send({})).status).toBe(404);
  });

  it('distributors see only themselves; the list is sorted by score and the lead router reads distributors.score', async () => {
    const env = newEnv();
    await seedHistory(env);
    await env.as('dsm').post(`${API}/distributors/${IDS.distributorA}/score/recompute`).send({});
    const all = await env.as('dsm').get(`${API}/distributors`);
    expect(all.body.data.map((d: { id: string }) => d.id)).toEqual([IDS.distributorA, IDS.distributorB]);
    expect(all.body.data[0]).toMatchObject({ score: 92, dealer_count: 2 });
    expect((await env.as('distributor_user').get(`${API}/distributors`)).body.data.map((d: { id: string }) => d.id)).toEqual([IDS.distributorA]);
    expect((await env.as(IDS.distributorUserB).get(`${API}/distributors/${IDS.distributorA}`)).status).toBe(403);
    expect((await env.as('distributor_user').get(`${API}/distributors/${IDS.distributorA}/score-history`)).body.data).toHaveLength(1);
    expect((await env.as(IDS.distributorUserB).get(`${API}/distributors/${IDS.distributorA}/score-history`)).status).toBe(403);
    const edit = await env.as('accounts').patch(`${API}/distributors/${IDS.distributorA}`).send({ credit_limit: 9_000_000, capability_tags: ['module'] });
    expect(edit.body.data).toMatchObject({ credit_limit: 9_000_000, capability_tags: ['module'] });
  });
});
