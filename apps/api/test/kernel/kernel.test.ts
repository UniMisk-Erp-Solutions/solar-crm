import { describe, expect, it } from 'vitest';
import { seedId, type Lead } from '@solar/shared';
import { scopeDb } from '../../src/db/scoped';
import { MemoryDb } from '../../src/db/memory';
import { decideSeverity } from '../../src/services/severity';
import { tickClocks } from '../../src/services/clockService';
import { computeCfa } from '../../src/services/cfa';
import { computeDealerExposure } from '../../src/services/exposure';
import { addWorkingMinutes, isWorkingTime, nextWorkingStart } from '../../src/lib/time';
import { IDS, createTestEnv } from '../helpers/env';
import { Router } from 'express';
import { handle } from '../../src/http/handler';
import { runList } from '../../src/http/crud';

describe('MemoryDb', () => {
  it('filters, sorts, paginates and emulates triggers', async () => {
    const env = createTestEnv();
    const c = env.ctx();
    const mk = (name: string) => c.db.table('leads').insert({ name, mobile: '+919876543210', status: 'new', source: 'manual' } as Partial<Lead>);
    const a = await mk('Asha'); await mk('Bina'); await mk('Chirag');
    const page = await c.db.table('leads').list({ orderBy: { col: 'name', dir: 'desc' }, limit: 2 });
    expect(page.total).toBe(3);
    expect(page.rows.map((r) => r.name)).toEqual(['Chirag', 'Bina']);
    expect((await c.db.table('leads').list({ search: { cols: ['name'], text: 'ASH' } })).rows).toHaveLength(1);
    await c.db.table('leads').update(a.id, { status: 'validated' });
    const events = await c.db.table('lead_events').all({ lead_id: a.id });
    expect(events.map((e) => e.event_type)).toContain('status_changed');
    expect((await c.db.table('audit_log').all({ record_id: a.id })).length).toBeGreaterThanOrEqual(2);
    const auditRow = (await c.db.table('audit_log').all())[0]!;
    await expect(c.db.table('audit_log').delete(auditRow.id)).rejects.toThrow(/append-only/);
  });

  it('keeps the consent ledger immutable except withdrawal fields', async () => {
    const env = createTestEnv();
    const c = env.ctx();
    const consent = await c.db.table('lead_consents').insert({ lead_id: seedId('l', 1), notice_version: 'v1', purposes: ['promotional'], channels: ['whatsapp'], recipients_named: [], granted_at: env.now().toISOString() } as never);
    await expect(c.db.table('lead_consents').update(consent.id, { notice_version: 'v2' })).rejects.toThrow(/immutable/);
    const w = await c.db.table('lead_consents').update(consent.id, { withdrawn_at: env.now().toISOString() });
    expect(w.withdrawn_at).not.toBeNull();
  });
});

describe('multi-tenancy', () => {
  it('scoped db never leaks another organisation', async () => {
    const db = new MemoryDb();
    const orgA = seedId('org', 1), orgB = seedId('org', 2);
    await scopeDb(db, orgA).table('leads').insert({ name: 'A-lead' } as Partial<Lead>);
    const b = await scopeDb(db, orgB).table('leads').insert({ name: 'B-lead' } as Partial<Lead>);
    expect((await scopeDb(db, orgA).table('leads').all()).map((l) => l.name)).toEqual(['A-lead']);
    expect(await scopeDb(db, orgA).table('leads').get(b.id)).toBeNull();
    await expect(scopeDb(db, orgA).table('leads').update(b.id, { name: 'hijack' })).rejects.toThrow(/not found/);
  });
});

describe('rule resolution by effective date', () => {
  it('returns the version in force on the reference date and honours is_active', async () => {
    const env = createTestEnv();
    const c = env.ctx();
    await env.rule('gst.modules_cells_rate', 12, { effective_from: '2020-01-01', effective_to: '2025-09-21' });
    await env.rule('gst.modules_cells_rate', 5, { effective_from: '2025-09-22' });
    expect((await c.svc.rules.path('gst.modules_cells_rate', '2025-01-01'))?.value).toBe(12);
    expect((await c.svc.rules.path('gst.modules_cells_rate', '2026-10-26'))?.value).toBe(5);
    expect(await c.svc.rules.path('gst.modules_cells_rate', '2019-01-01')).toBeNull();
    await env.rule('gst.inverter_rate', 18, { status: 'conflicting', is_active: false, confidence: 'low' });
    expect(await c.svc.rules.value('gst.inverter_rate')).toBeNull(); // inactive rules never alter behaviour
    expect((await c.svc.rules.path('gst.inverter_rate'))?.status).toBe('conflicting');
  });

  it('createVersion closes the previous version and demands a source', async () => {
    const env = createTestEnv();
    const c = env.ctx('compliance_officer');
    const v1 = await c.svc.rules.createVersion({ category: 'x', key: 'k', value: 1, effective_from: '2026-01-01', source_name: 's', source_ref: 'r', confidence: 'high', status: 'verified', is_active: true });
    await c.svc.rules.createVersion({ category: 'x', key: 'k', value: 2, effective_from: '2026-07-01', source_name: 's', source_ref: 'r', confidence: 'high', status: 'verified', is_active: true });
    expect((await c.db.table('rule_config').get(v1.id))?.effective_to).toBe('2026-06-30');
    expect((await c.svc.rules.path('x.k', '2026-03-01'))?.value).toBe(1);
    expect((await c.svc.rules.path('x.k', '2026-08-01'))?.value).toBe(2);
    await expect(c.svc.rules.createVersion({ category: 'x', key: 'k', value: 3, effective_from: '2027-01-01', source_name: 's', source_ref: ' ', confidence: 'high', status: 'verified' })).rejects.toThrow(/source/i);
  });
});

describe('severity decision — unverified rules are advisory only', () => {
  const rule = (o: Partial<Parameters<typeof decideSeverity>[0] & object>) => ({ id: 'r', category: 'c', key: 'k', value: 1, status: 'verified', confidence: 'high', isActive: true, maxSeverity: 'hard_stop', enforceHardStop: false, source: { name: 's', ref: 'r' }, effective_from: '2020-01-01', effective_to: null, notes: null, ...o }) as never;
  it('verified + active → full severity', () => expect(decideSeverity(rule({}), 'hard_stop')).toEqual({ severity: 'hard_stop', advisory: false }));
  it('respects max_severity cap', () => expect(decideSeverity(rule({ maxSeverity: 'warning' }), 'hard_stop').severity).toBe('warning'));
  it('inactive degrades hard stop to warning', () => expect(decideSeverity(rule({ isActive: false }), 'hard_stop')).toEqual({ severity: 'warning', advisory: true }));
  it('conflicting degrades to warning', () => expect(decideSeverity(rule({ status: 'conflicting' }), 'hard_stop').severity).toBe('warning'));
  it('unverified but explicitly enforced can hard stop', () => expect(decideSeverity(rule({ status: 'unverified', enforceHardStop: true }), 'hard_stop').severity).toBe('hard_stop'));
  it('no governing rule → info', () => expect(decideSeverity(null, 'hard_stop').severity).toBe('info'));
});

describe('working time (IST)', () => {
  it('skips nights and Sundays', () => {
    const fri6pm = new Date('2026-10-30T12:30:00Z'); // 18:00 IST Friday
    expect(isWorkingTime(fri6pm)).toBe(true);
    const due = addWorkingMinutes(fri6pm, 60); // 30 min Fri + 30 min Sat 09:30
    expect(due.toISOString()).toBe('2026-10-31T04:30:00.000Z'); // Sat 10:00 IST
    const sat7pm = new Date('2026-10-31T13:30:00Z');
    expect(nextWorkingStart(sat7pm).toISOString()).toBe('2026-11-02T04:00:00.000Z'); // Mon 09:30 IST
  });
});

describe('clock engine', () => {
  it('warns at 70 %, breaches at 100 %, then escalates owner → DSM → Sales Manager → Management', async () => {
    const env = createTestEnv();
    const c = env.ctx('distributor_user');
    const start = env.now();
    await c.svc.clocks.start({ entity_type: 'lead', entity_id: seedId('lead', 1), clock_type: 'lead_acceptance', due_at: new Date(start.getTime() + 100 * 60000), owner_id: IDS.profile('distributor_user') });
    await env.rule('sla.escalation_step_minutes', 60);
    env.advance(75 * 60000);
    expect(await tickClocks(env.deps)).toMatchObject({ warned: 1, breached: 0 });
    env.advance(30 * 60000);
    expect(await tickClocks(env.deps)).toMatchObject({ breached: 1 });
    let clock = (await env.db.table('clocks').all())[0]!;
    expect(clock.status).toBe('breached');
    expect(clock.escalated_level).toBe(1);
    env.advance(61 * 60000);
    await tickClocks(env.deps);
    env.advance(61 * 60000);
    await tickClocks(env.deps);
    clock = (await env.db.table('clocks').all())[0]!;
    expect(clock.escalated_level).toBe(3);
    const notes = await env.db.table('notifications').all();
    expect(notes.some((n) => n.user_id === IDS.profile('dsm'))).toBe(true);
    expect(notes.some((n) => n.user_id === IDS.profile('sales_manager'))).toBe(true);
    expect(notes.some((n) => n.user_id === IDS.profile('management'))).toBe(true);
    // completing a breached clock keeps it 'breached' for KPI purposes but resolves it
    const done = await c.svc.clocks.complete('lead', seedId('lead', 1), 'lead_acceptance');
    expect(done?.status).toBe('breached');
    expect(done?.resolved_at).not.toBeNull();
  });

  it('completing before the deadline marks the clock met', async () => {
    const env = createTestEnv();
    const c = env.ctx();
    await c.svc.clocks.start({ entity_type: 'lead', entity_id: seedId('lead', 2), clock_type: 'followup', due_at: new Date(env.now().getTime() + 3600000) });
    expect((await c.svc.clocks.complete('lead', seedId('lead', 2), 'followup'))?.status).toBe('met');
  });
});

describe('CFA calculator (rule-driven)', () => {
  async function seedCfa(env: ReturnType<typeof createTestEnv>) {
    await env.rule('pmsg.cfa.per_kw_first_2kw', 30000); await env.rule('pmsg.cfa.third_kw', 18000); await env.rule('pmsg.cfa.max_total', 78000); await env.rule('pmsg.cfa.max_kw_eligible', 3);
    await env.rule('pmsg.cfa.special_category.per_kw_first_2kw', 33000); await env.rule('pmsg.cfa.special_category.third_kw', 19800);
    await env.rule('rwa_ghs.cfa_per_kw', 18000); await env.rule('rwa_ghs.max_kw', 500); await env.rule('rwa_ghs.kw_per_household', 3);
  }
  it.each([[1, 30000], [2, 60000], [3, 78000], [4, 78000]])('PMSG %s kW → ₹ %s', async (kw, expected) => {
    const env = createTestEnv(); await seedCfa(env);
    expect((await computeCfa(env.ctx(), { segment: 'pmsg_residential', kw })).cfa).toBe(expected);
  });
  it('special-category states get the higher rates', async () => {
    const env = createTestEnv(); await seedCfa(env);
    expect((await computeCfa(env.ctx(), { segment: 'pmsg_residential', kw: 3, special_category_state: true })).cfa).toBe(33000 * 2 + 19800);
  });
  it('RWA/GHS is capped by 3 kW per household', async () => {
    const env = createTestEnv(); await seedCfa(env);
    const r = await computeCfa(env.ctx(), { segment: 'rwa_ghs', kw: 100, households: 20 });
    expect(r.eligible_kw).toBe(60); expect(r.cfa).toBe(60 * 18000);
  });
  it('inactive rules produce no subsidy (never silently change a price)', async () => {
    const env = createTestEnv();
    await env.rule('pmsg.cfa.per_kw_first_2kw', 30000, { is_active: false }); await env.rule('pmsg.cfa.third_kw', 18000); await env.rule('pmsg.cfa.max_kw_eligible', 3);
    const r = await computeCfa(env.ctx(), { segment: 'pmsg_residential', kw: 3 });
    expect(r.cfa).toBe(0); expect(r.warnings.join(' ')).toMatch(/not active/);
  });
  it('existing solar counts against the 3 kW cap', async () => {
    const env = createTestEnv(); await seedCfa(env);
    expect((await computeCfa(env.ctx(), { segment: 'pmsg_residential', kw: 3, existing_solar_kw: 1 })).cfa).toBe(60000);
  });
});

describe('dealer exposure', () => {
  it('computes limit use, ageing buckets, subsidy-linked share', async () => {
    const env = createTestEnv();
    const c = env.ctx();
    const mk = (amount: number, due: string, subsidy = false) => c.db.table('dealer_receivables').insert({ dealer_id: IDS.dealerA1, distributor_id: IDS.distributorA, doc_ref: 'INV', amount, paid_amount: 0, invoice_date: '2026-09-01', due_date: due, subsidy_linked: subsidy, linked_project_id: null, status: 'open' });
    await mk(100000, '2026-11-15'); await mk(200000, '2026-10-10'); await mk(300000, '2026-07-01', true);
    const x = await computeDealerExposure(c, IDS.dealerA1);
    expect(x.outstanding).toBe(600000);
    expect(x.ageing.current).toBe(100000); expect(x.ageing.d1_30).toBe(200000); expect(x.ageing.d90_plus).toBe(300000);
    expect(x.subsidy_linked).toBe(300000); expect(x.over_limit).toBe(false);
    await mk(500000, '2026-12-01');
    expect((await computeDealerExposure(c, IDS.dealerA1)).over_limit).toBe(true);
  });
});

describe('auth, role scoping and mobile privacy', () => {
  function probeRouter() {
    const r = Router();
    r.get('/probe/leads', async (req, res, next) => { try { const page = await runList(req.ctx!, req, { table: 'leads', searchCols: ['name'], filterCols: ['status'], defaultSort: { col: 'created_at', dir: 'desc' } }); res.json({ data: page.rows, total: page.total }); } catch (e) { next(e); } });
    r.post('/probe/echo', handle(async (_ctx, req) => req.body));
    return r;
  }
  async function leads(env: ReturnType<typeof createTestEnv>) {
    const c = env.ctx();
    const mk = (name: string, distributor_id: string | null) => c.db.table('leads').insert({ name, mobile: '+919812345678', status: 'assigned', source: 'manual', distributor_id, dealer_id: null, territory_id: IDS.territoryAhmedabad } as Partial<Lead>);
    await mk('For A', IDS.distributorA); await mk('For B', IDS.distributorB);
  }
  it('rejects unauthenticated requests', async () => {
    const env = createTestEnv({ authed: [probeRouter()] });
    const r = await env.anon().get('/api/v1/probe/leads');
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('UNAUTHENTICATED');
  });
  it('a distributor user cannot read another distributor’s leads', async () => {
    const env = createTestEnv({ authed: [probeRouter()] }); await leads(env);
    const a = await env.as('distributor_user').get('/api/v1/probe/leads');
    expect(a.body.data.map((l: Lead) => l.name)).toEqual(['For A']);
    const b = await env.as(IDS.distributorUserB).get('/api/v1/probe/leads');
    expect(b.body.data.map((l: Lead) => l.name)).toEqual(['For B']);
    const admin = await env.as('admin').get('/api/v1/probe/leads');
    expect(admin.body.total).toBe(2);
    // a crafted filter cannot widen the scope
    const sneaky = await env.as('distributor_user').get(`/api/v1/probe/leads?status=assigned`);
    expect(sneaky.body.total).toBe(1);
  });
  it('territory-restricted internal users only see their territories', async () => {
    const env = createTestEnv({ authed: [probeRouter()] }); await leads(env);
    await env.db.table('profiles').update(IDS.profile('dsm'), { territory_ids: [IDS.territorySurat] });
    const r = await env.as('dsm').get('/api/v1/probe/leads');
    expect(r.body.total).toBe(0);
  });
  it('blocks Aadhaar numbers in request bodies (G14) but allows mobiles', async () => {
    const env = createTestEnv({ authed: [probeRouter()] });
    const ok = await env.as('admin').post('/api/v1/probe/echo').send({ mobile: '919876543210', note: 'call 9876543210' });
    expect(ok.status).toBe(200);
    const { verhoeffCheckDigit } = await import('@solar/shared');
    const n = '23456789012' + verhoeffCheckDigit('23456789012');
    const bad = await env.as('admin').post('/api/v1/probe/echo').send({ notes: `Aadhaar ${n.slice(0, 4)} ${n.slice(4, 8)} ${n.slice(8)}` });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('AADHAAR_BLOCKED');
  });
  it('GET /auth/me returns the profile and demo login works only in demo mode', async () => {
    const env = createTestEnv();
    const me = await env.as('dsm').get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.data.profile.role).toBe('dsm');
    const login = await env.anon().post('/api/v1/auth/demo-login').send({ profile_id: IDS.profile('dsm') });
    expect(login.status).toBe(200);
    expect(login.body.data.token).toMatch(/^demo\./);
  });
});
