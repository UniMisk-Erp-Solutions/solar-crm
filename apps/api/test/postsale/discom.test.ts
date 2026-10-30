import { describe, expect, it } from 'vitest';
import { discomStageAgeing, sweepDeemedFeasibility } from '../../src/services/discomService';
import { tickClocks } from '../../src/services/clockService';
import { API, DISCOM_ID, IDS, newEnv, seedProject, seedRules } from './fixtures';

describe('DISCOM applications — feasibility above the exempt kW', () => {
  it('≤ 10 kW needs no feasibility study and no clock', async () => {
    const env = newEnv();
    await seedRules(env);
    const p = await seedProject(env, { kw: 8 });
    const r = await env.as('dsm').post(`${API}/discom-applications`).send({ site_id: p.siteId, sales_order_id: p.soId, applied_kw: 8, submitted_at: '2026-10-20', complete_at: '2026-10-22' });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ feasibility_status: 'not_required', feasibility_due_at: null, discom_id: DISCOM_ID, dealer_id: IDS.dealerA1 });
    expect(await env.db.table('clocks').count({ clock_type: 'discom_feasibility' })).toBe(0);
  });

  it('> 10 kW starts the 15-day clock from complete_at; silence makes feasibility deemed', async () => {
    const env = newEnv();
    await seedRules(env);
    const p = await seedProject(env, { kw: 25 });
    const r = await env.as('dsm').post(`${API}/discom-applications`).send({ site_id: p.siteId, sales_order_id: p.soId, applied_kw: 25, submitted_at: '2026-10-20', complete_at: '2026-10-26' });
    expect(r.body.data).toMatchObject({ feasibility_status: 'pending', feasibility_due_at: '2026-11-10T18:29:59.999Z' });
    const clock = (await env.db.table('clocks').all({ clock_type: 'discom_feasibility' }))[0]!;
    expect(clock).toMatchObject({ entity_type: 'discom_application', entity_id: r.body.data.id, status: 'running', due_at: '2026-11-10T18:29:59.999Z' });
    expect(clock.started_at).toBe('2026-10-25T18:30:00.000Z'); // complete_at 26-Oct 00:00 IST

    env.setNow(new Date('2026-11-12T05:00:00Z'));
    await tickClocks(env.deps);
    const app = await env.db.table('discom_applications').get(r.body.data.id);
    expect(app?.feasibility_status).toBe('deemed');
    const after = await env.db.table('clocks').get(clock.id);
    expect(after?.status).toBe('breached');
    expect(after?.resolved_at).not.toBeNull(); // resolved: the DISCOM's silence must not escalate internally
    expect(await env.db.table('notifications').count({ kind: 'discom.feasibility_deemed' })).toBeGreaterThan(0);
    expect((await env.db.table('audit_log').all({ action: 'discom.feasibility_deemed' })).length).toBe(1);
  });

  it('complete_at set later starts the clock; an approval inside the window marks it met', async () => {
    const env = newEnv();
    await seedRules(env);
    const p = await seedProject(env, { kw: 25 });
    const created = (await env.as('dsm').post(`${API}/discom-applications`).send({ site_id: p.siteId, applied_kw: 25, submitted_at: '2026-10-20' })).body.data;
    expect(created.feasibility_status).toBe('pending');
    expect(created.feasibility_due_at).toBeNull();
    expect(await env.db.table('clocks').count({ clock_type: 'discom_feasibility' })).toBe(0);
    await env.as('dsm').patch(`${API}/discom-applications/${created.id}`).send({ complete_at: '2026-10-24' });
    expect(await env.db.table('clocks').count({ clock_type: 'discom_feasibility', status: 'running' })).toBe(1);
    const done = await env.as('dsm').patch(`${API}/discom-applications/${created.id}`).send({ feasibility_status: 'approved' });
    expect(done.body.data.feasibility_status).toBe('approved');
    expect((await env.db.table('clocks').all({ clock_type: 'discom_feasibility' }))[0]!.status).toBe('met');
    // dropping the capacity under the exempt limit on a pending application removes the requirement
    const other = (await env.as('dsm').post(`${API}/discom-applications`).send({ site_id: p.siteId, applied_kw: 25, complete_at: '2026-10-24' })).body.data;
    const smaller = await env.as('dsm').patch(`${API}/discom-applications/${other.id}`).send({ applied_kw: 9 });
    expect(smaller.body.data.feasibility_status).toBe('not_required');
    expect((await env.db.table('clocks').all({ entity_id: other.id }))[0]!.status).toBe('cancelled');
  });

  it('inactive feasibility rule: warning and no clock', async () => {
    const env = newEnv();
    await seedRules(env);
    const rule = (await env.db.table('rule_config').all({ key: 'feasibility_study_days_above_10kw' }))[0]!;
    await env.db.table('rule_config').update(rule.id, { is_active: false });
    const p = await seedProject(env, { kw: 25 });
    const r = await env.as('dsm').post(`${API}/discom-applications`).send({ site_id: p.siteId, applied_kw: 25, complete_at: '2026-10-26' });
    expect(r.body.data.warnings.join(' ')).toMatch(/discom\.feasibility_study_days_above_10kw is not active/);
    expect(r.body.data.feasibility_due_at).toBeNull();
    expect(await env.db.table('clocks').count({ clock_type: 'discom_feasibility' })).toBe(0);
  });

  it('the nightly sweep deems feasibility even if no clock handler ran', async () => {
    const env = newEnv();
    await seedRules(env);
    const p = await seedProject(env, { kw: 25 });
    const app = await env.ctx().db.table('discom_applications').insert({
      site_id: p.siteId, applied_kw: 25, feasibility_status: 'pending', feasibility_due_at: '2026-10-20T18:29:59.999Z', complete_at: '2026-10-05T00:00:00.000Z', deemed_breach: false, agreement_status: 'pending',
    });
    expect(await sweepDeemedFeasibility(env.systemCtx())).toEqual({ deemed: 1 });
    expect((await env.db.table('discom_applications').get(app.id))?.feasibility_status).toBe('deemed');
  });
});

describe('per-DISCOM stage ageing', () => {
  async function seedApps(env: ReturnType<typeof newEnv>) {
    const db = env.ctx().db;
    const other = '7a1c0000-0000-4000-8000-0000000000aa';
    await db.table('discoms').insert({ id: DISCOM_ID, code: 'UGVCL', name: 'UGVCL', state: 'Gujarat', kind: 'discom' });
    await db.table('discoms').insert({ id: other, code: 'DGVCL', name: 'DGVCL', state: 'Gujarat', kind: 'discom' });
    const mk = (discom: string, cert: string, inspection: string | null, meter: string | null, commissioning: string | null, breach = false) => db.table('discom_applications').insert({
      discom_id: discom, applied_kw: 3, dealer_id: IDS.dealerA1, distributor_id: IDS.distributorA, feasibility_status: 'not_required', certificate_submitted_at: `${cert}T00:00:00.000Z`,
      inspection_at: inspection && `${inspection}T00:00:00.000Z`, meter_at: meter && `${meter}T00:00:00.000Z`, commissioning_at: commissioning && `${commissioning}T00:00:00.000Z`, deemed_breach: breach, agreement_status: 'pending',
    });
    await mk(DISCOM_ID, '2026-09-01', '2026-09-03', '2026-09-06', '2026-09-10');            // 2 / 3 / 9
    await mk(DISCOM_ID, '2026-09-01', '2026-09-05', '2026-09-10', '2026-09-20', true);      // 4 / 5 / 19, breach
    await mk(DISCOM_ID, '2026-09-01', '2026-09-11', '2026-09-12', '2026-09-30', true);      // 10 / 1 / 29, breach
    await mk(DISCOM_ID, '2026-10-20', '2026-10-22', null, null);                            // inspection done; meter + commissioning pending
    await mk(other, '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04');                // 1 / 1 / 3
    return { other };
  }

  it('computes median and 90th percentile per stage, pending counts and deemed-clock breaches', async () => {
    const env = newEnv();
    const { other } = await seedApps(env);
    const res = await discomStageAgeing(env.ctx('dsm'), {});
    const u = res.rows.find((r) => r.discom_id === DISCOM_ID)!;
    expect(u.applications).toBe(4);
    expect(u.inspection).toEqual({ n: 4, pending: 0, median_days: 3, p90_days: 10 });   // 2, 4, 10, 2 → sorted 2,2,4,10
    expect(u.meter).toMatchObject({ n: 3, pending: 1, median_days: 3, p90_days: 5 });     // 3, 5, 1 → sorted 1,3,5 (the 4th is pending)
    expect(u.commissioning).toMatchObject({ n: 3, pending: 1, median_days: 19, p90_days: 29 });
    expect(u.breaches).toEqual({ commissioning: 2, feasibility: 0, total: 2 });
    const d = res.rows.find((r) => r.discom_id === other)!;
    expect(d.commissioning).toMatchObject({ n: 1, median_days: 3, p90_days: 3 });
    expect(res.totals.applications).toBe(5);
    expect(res.totals.breaches.total).toBe(2);
  });

  it('is served at /discom-applications/ageing, filterable by DISCOM and scoped to the caller', async () => {
    const env = newEnv();
    const { other } = await seedApps(env);
    const all = await env.as('dsm').get(`${API}/discom-applications/ageing`);
    expect(all.status).toBe(200);
    expect(all.body.data.rows).toHaveLength(2);
    const one = await env.as('dsm').get(`${API}/discom-applications/ageing?discom_id=${other}`);
    expect(one.body.data.rows).toHaveLength(1);
    expect(one.body.data.rows[0].discom_code).toBe('DGVCL');
    const dealer = await env.as(IDS.dealerUserB).get(`${API}/discom-applications/ageing`);
    expect(dealer.body.data.totals.applications).toBe(0);
    expect((await env.as('dealer_user').get(`${API}/discom-applications/ageing`)).body.data.totals.applications).toBe(5);
  });
});

describe('DISCOM application list', () => {
  it('hydrates names and overdue flags; other dealers’ applications stay hidden', async () => {
    const env = newEnv();
    await seedRules(env);
    const p = await seedProject(env);
    const inst = (await env.as('admin').post(`${API}/installations`).send({ sales_order_id: p.soId, install_date: '2026-10-01' })).body.data;
    await env.as('admin').post(`${API}/installations/${inst.id}/certificate`).send({ certificate_at: '2026-10-02' });
    const list = await env.as('dealer_user').get(`${API}/discom-applications`);
    expect(list.body.total).toBe(1);
    expect(list.body.data[0]).toMatchObject({ customer_name: 'Customer 1', discom_code: 'UGVCL', commissioning_overdue: true, commissioning_clock: { status: 'running' } });
    expect((await env.as(IDS.dealerUserB).get(`${API}/discom-applications`)).body.total).toBe(0);
    const forbidden = await env.as(IDS.dealerUserB).get(`${API}/discom-applications/${list.body.data[0].id}`);
    expect(forbidden.status).toBe(403);
  });
});
