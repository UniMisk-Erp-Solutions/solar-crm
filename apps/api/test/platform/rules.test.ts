import { describe, expect, it } from 'vitest';
import { DEMO_ORG_ID } from '@solar/shared';
import { platformEnv } from './fixtures';

const api = '/api/v1';
const newVersion = (over: Record<string, unknown> = {}) => ({
  path: 'test.limit', value: 10, effective_from: '2026-01-01', source_name: 'MNRE', source_ref: 'OM 12/2026 clause 4', confidence: 'medium', status: 'unverified', ...over,
});

describe('rules API — resolution by date', () => {
  it('returns exactly the version the engine would use on that date, with its effect', async () => {
    const env = platformEnv();
    await env.rule('gst.modules_cells_rate', 12, { effective_from: '2020-01-01', effective_to: '2025-09-21' });
    await env.rule('gst.modules_cells_rate', 5, { effective_from: '2025-09-22' });
    await env.rule('gst.inverter_rate', 18, { status: 'conflicting', is_active: false, confidence: 'low' });

    const before = await env.as('viewer').get(`${api}/rules/resolve?path=gst.modules_cells_rate&date=2025-01-01`);
    expect(before.status).toBe(200);
    expect(before.body.data.rule.value).toBe(12);
    expect(before.body.data.effect).toBe('active');
    const after = await env.as('sales_manager').get(`${api}/rules/resolve?path=gst.modules_cells_rate&date=2026-10-26`);
    expect(after.body.data.rule.value).toBe(5);
    // no date → today (the test clock)
    expect((await env.as('dsm').get(`${api}/rules/resolve?path=gst.modules_cells_rate`)).body.data.rule.value).toBe(5);
    const none = await env.as('dsm').get(`${api}/rules/resolve?path=gst.modules_cells_rate&date=2019-01-01`);
    expect(none.body.data).toMatchObject({ found: false, rule: null, effect: 'none' });
    const inactive = await env.as('dsm').get(`${api}/rules/resolve?path=gst.inverter_rate`);
    expect(inactive.body.data).toMatchObject({ found: true, effect: 'inactive', max_effective_severity: null });
    expect(inactive.body.data.rule.status).toBe('conflicting');
  });

  it('lists with filters, flags the version in force and keeps external users out', async () => {
    const env = platformEnv();
    await env.rule('gst.modules_cells_rate', 12, { effective_from: '2020-01-01', effective_to: '2025-09-21' });
    await env.rule('gst.modules_cells_rate', 5, { effective_from: '2025-09-22' });
    await env.rule('pmsg.cfa.max_total', 78000);
    await env.rule('trai.promotional_series', '140', { status: 'unverified', is_active: false, confidence: 'low' });
    const all = await env.as('accounts').get(`${api}/rules`);
    expect(all.body.total).toBe(4);
    const inForce = all.body.data.filter((r: { in_force: boolean }) => r.in_force);
    expect(inForce).toHaveLength(3);
    expect((await env.as('accounts').get(`${api}/rules?category=gst&current=true`)).body.data.map((r: { value: number }) => r.value)).toEqual([5]);
    expect((await env.as('accounts').get(`${api}/rules?status=unverified`)).body.total).toBe(1);
    expect((await env.as('accounts').get(`${api}/rules?active=false`)).body.data[0].advisory).toBe(true);
    expect((await env.as('accounts').get(`${api}/rules?q=cfa`)).body.total).toBe(1);
    expect((await env.as('distributor_user').get(`${api}/rules`)).status).toBe(403);
    expect((await env.anon().get(`${api}/rules`)).status).toBe(401);
  });

  it('shows history and a field-level diff between two versions', async () => {
    const env = platformEnv();
    const v1 = await env.rule('gst.modules_cells_rate', { rate: 12, note: 'old' }, { effective_from: '2020-01-01', effective_to: '2025-09-21' });
    const v2 = await env.rule('gst.modules_cells_rate', { rate: 5, note: 'old' }, { effective_from: '2025-09-22', status: 'unverified' });
    const hist = await env.as('compliance_officer').get(`${api}/rules/history?path=gst.modules_cells_rate`);
    expect(hist.body.data.map((r: { effective_from: string }) => r.effective_from)).toEqual(['2025-09-22', '2020-01-01']);
    expect((await env.as('compliance_officer').get(`${api}/rules/history?category=gst&key=modules_cells_rate`)).body.data).toHaveLength(2);
    expect((await env.as('compliance_officer').get(`${api}/rules/history`)).status).toBe(422);

    const diff = await env.as('compliance_officer').get(`${api}/rules/diff?a=${v1.id}&b=${v2.id}`);
    expect(diff.status).toBe(200);
    expect(diff.body.data.identical).toBe(false);
    expect(diff.body.data.changes.map((c: { field: string }) => c.field)).toEqual(expect.arrayContaining(['value', 'effective_from', 'effective_to', 'status']));
    expect(diff.body.data.value_changes).toEqual([{ path: 'rate', a: 12, b: 5 }]);
    const same = await env.as('compliance_officer').get(`${api}/rules/diff?a=${v1.id}&b=${v1.id}`);
    expect(same.body.data.identical).toBe(true);
    expect((await env.as('compliance_officer').get(`${api}/rules/diff?a=${v1.id}&b=00000000-0000-4000-8000-000000000000`)).status).toBe(404);
  });
});

describe('rules API — who may change rules', () => {
  it('only compliance officers and admins can create, edit, activate or deactivate', async () => {
    const env = platformEnv();
    for (const role of ['dsm', 'management', 'sales_manager', 'accounts', 'viewer', 'distributor_user']) {
      expect((await env.as(role).post(`${api}/rules`).send(newVersion())).status, role).toBe(403);
    }
    const created = await env.as('compliance_officer').post(`${api}/rules`).send(newVersion());
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ path: 'test.limit', is_active: false, status: 'unverified' });
    const id = created.body.data.id as string;
    expect((await env.as('dsm').patch(`${api}/rules/${id}`).send({ notes: 'x' })).status).toBe(403);
    expect((await env.as('management').post(`${api}/rules/${id}/activate`).send({})).status).toBe(403);
    expect((await env.as('management').post(`${api}/rules/${id}/deactivate`)).status).toBe(403);
    expect((await env.as('admin').post(`${api}/rules/${id}/activate`).send({})).status).toBe(200);
    expect((await env.as('compliance_officer').post(`${api}/rules/${id}/deactivate`)).body.data.is_active).toBe(false);
    // every change is audited
    const actions = (await env.db.table('audit_log').all({ source: 'api' })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['rule.create_version', 'rule.activate', 'rule.deactivate']));
  });

  it('rejects a version without a source reference', async () => {
    const env = platformEnv();
    const as = env.as('compliance_officer');
    for (const bad of [{ source_ref: '' }, { source_ref: '   ' }, { source_ref: undefined }, { source_name: '' }]) {
      const r = await as.post(`${api}/rules`).send(newVersion(bad));
      expect(r.status, JSON.stringify(bad)).toBe(422);
      expect(r.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect(await env.db.table('rule_config').count()).toBe(0);
    const ok = await as.post(`${api}/rules`).send(newVersion());
    const patch = await as.patch(`${api}/rules/${ok.body.data.id}`).send({ source_ref: ' ' });
    expect(patch.status).toBe(422);
  });

  it('adds an effective-dated version, closes the previous one and refuses a duplicate start date', async () => {
    const env = platformEnv();
    const as = env.as('compliance_officer');
    const v1 = await as.post(`${api}/rules`).send(newVersion({ value: 1, status: 'verified', confidence: 'high', is_active: true }));
    const v2 = await as.post(`${api}/rules`).send(newVersion({ value: 2, effective_from: '2026-07-01', status: 'verified', confidence: 'high', is_active: true }));
    expect(v2.status).toBe(201);
    expect((await env.db.table('rule_config').get(v1.body.data.id))?.effective_to).toBe('2026-06-30');
    expect((await env.as('dsm').get(`${api}/rules/resolve?path=test.limit&date=2026-03-01`)).body.data.rule.value).toBe(1);
    expect((await env.as('dsm').get(`${api}/rules/resolve?path=test.limit&date=2026-08-01`)).body.data.rule.value).toBe(2);
    const clash = await as.post(`${api}/rules`).send(newVersion({ value: 3, effective_from: '2026-07-01' }));
    expect(clash.status).toBe(409);
    // category + key is accepted instead of path
    expect((await as.post(`${api}/rules`).send(newVersion({ path: undefined, category: 'test', key: 'other.key', effective_from: '2026-02-02' }))).status).toBe(201);
  });
});

describe('rules API — activating an unverified rule as a hard stop needs the explicit flag', () => {
  it('blocks the implicit hard stop, allows advisory activation, and records an explicit enforcement', async () => {
    const env = platformEnv();
    const as = env.as('compliance_officer');
    const created = await as.post(`${api}/rules`).send(newVersion({ path: 'almm.list2.exemption_net_metering_open_access_until', value: '2026-12-31' }));
    const id = created.body.data.id as string;

    const implicit = await as.post(`${api}/rules/${id}/activate`).send({ max_severity: 'hard_stop' });
    expect(implicit.status).toBe(422);
    expect(implicit.body.error.code).toBe('GUARD_BLOCKED');
    expect(implicit.body.error.details.code).toBe('HARD_STOP_NEEDS_CONFIRMATION');
    expect((await env.db.table('rule_config').get(id))?.is_active).toBe(false);

    // plain activation: active but advisory — the engine may warn, never block
    const plain = await as.post(`${api}/rules/${id}/activate`).send({});
    expect(plain.status).toBe(200);
    expect(plain.body.data.is_active).toBe(true);
    const advisory = await as.get(`${api}/rules/resolve?path=almm.list2.exemption_net_metering_open_access_until`);
    expect(advisory.body.data.effect).toBe('advisory');
    expect(advisory.body.data.max_effective_severity).not.toBe('hard_stop');

    // explicit enforcement
    const enforced = await as.post(`${api}/rules/${id}/activate`).send({ enforce_hard_stop: true, reason: 'Counsel confirmed the 31-Dec-2026 date' });
    expect(enforced.status).toBe(200);
    expect(enforced.body.data).toMatchObject({ enforce_hard_stop: true, max_severity: 'hard_stop' });
    const live = await as.get(`${api}/rules/resolve?path=almm.list2.exemption_net_metering_open_access_until`);
    expect(live.body.data).toMatchObject({ effect: 'active', max_effective_severity: 'hard_stop' });
    const audited = await env.db.table('audit_log').all({ action: 'rule.hard_stop_enforced' });
    expect(audited).toHaveLength(1);
    expect(audited[0]!.detail).toMatchObject({ reason: 'Counsel confirmed the 31-Dec-2026 date', status: 'unverified' });

    // a verified rule needs no confirmation
    const verified = await as.post(`${api}/rules`).send(newVersion({ path: 'test.verified', status: 'verified', confidence: 'high' }));
    expect((await as.post(`${api}/rules/${verified.body.data.id}/activate`).send({ max_severity: 'hard_stop' })).status).toBe(200);
  });

  it('applies the same consent check when creating or editing a rule', async () => {
    const env = platformEnv();
    const as = env.as('compliance_officer');
    const bad = await as.post(`${api}/rules`).send(newVersion({ max_severity: 'hard_stop' }));
    expect(bad.status).toBe(422);
    const ok = await as.post(`${api}/rules`).send(newVersion({ max_severity: 'hard_stop', enforce_hard_stop: true, is_active: true }));
    expect(ok.status).toBe(201);
    const second = await as.post(`${api}/rules`).send(newVersion({ path: 'test.second' }));
    const patchBad = await as.patch(`${api}/rules/${second.body.data.id}`).send({ max_severity: 'hard_stop' });
    expect(patchBad.status).toBe(422);
    const patchOk = await as.patch(`${api}/rules/${second.body.data.id}`).send({ max_severity: 'hard_stop', enforce_hard_stop: true });
    expect(patchOk.status).toBe(200);
    expect(patchOk.body.data.enforce_hard_stop).toBe(true);
  });
});

describe('verify-before-relying register', () => {
  async function seedRegister(env: ReturnType<typeof platformEnv>) {
    return env.ctx('admin').db.table('verify_register').insert({
      code: 'V-01', title: 'PMSG CFA claim deadline', detail: 'OM text not read', where_to_check: 'MNRE OM 31-Aug-2026', confidence: 'medium', owner: null, status: 'open', closing_source_url: null, closed_at: null,
    });
  }

  it('lists, filters and updates the owner', async () => {
    const env = platformEnv();
    const item = await seedRegister(env);
    expect((await env.as('viewer').get(`${api}/verify-register`)).body.total).toBe(1);
    expect((await env.as('viewer').get(`${api}/verify-register?status=closed`)).body.total).toBe(0);
    expect((await env.as('viewer').get(`${api}/verify-register?q=deadline`)).body.total).toBe(1);
    expect((await env.as('distributor_user').get(`${api}/verify-register`)).status).toBe(403);
    expect((await env.as('dsm').patch(`${api}/verify-register/${item.id}`).send({ owner: 'Meera' })).status).toBe(403);
    const r = await env.as('compliance_officer').patch(`${api}/verify-register/${item.id}`).send({ owner: 'Meera (CA)' });
    expect(r.body.data.owner).toBe('Meera (CA)');
  });

  it('closing requires a source URL, stamps the date, and reopening clears it', async () => {
    const env = platformEnv();
    const item = await seedRegister(env);
    const as = env.as('compliance_officer');
    const noUrl = await as.patch(`${api}/verify-register/${item.id}`).send({ status: 'closed' });
    expect(noUrl.status).toBe(422);
    expect(noUrl.body.error.details[0].path).toBe('closing_source_url');
    const badUrl = await as.patch(`${api}/verify-register/${item.id}`).send({ status: 'closed', closing_source_url: 'not a url' });
    expect(badUrl.status).toBe(422);
    const closed = await as.patch(`${api}/verify-register/${item.id}`).send({ status: 'closed', closing_source_url: 'https://mnre.gov.in/om-31-aug-2026.pdf' });
    expect(closed.status).toBe(200);
    expect(closed.body.data).toMatchObject({ status: 'closed', closing_source_url: 'https://mnre.gov.in/om-31-aug-2026.pdf', closed_at: '2026-10-26' });
    const withDate = await as.patch(`${api}/verify-register/${item.id}`).send({ closed_at: '2026-10-20' });
    expect(withDate.body.data.closed_at).toBe('2026-10-20');
    const reopened = await as.patch(`${api}/verify-register/${item.id}`).send({ status: 'open' });
    expect(reopened.body.data).toMatchObject({ status: 'open', closed_at: null, closing_source_url: null });
    // closing details make no sense on an open item
    expect((await as.patch(`${api}/verify-register/${item.id}`).send({ closing_source_url: 'https://example.org/x' })).status).toBe(422);
    expect((await env.db.table('audit_log').all({ action: 'verify_register.close' }))).toHaveLength(1);
    expect(DEMO_ORG_ID).toBeTruthy();
  });
});
