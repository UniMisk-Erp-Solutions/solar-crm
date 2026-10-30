import { describe, expect, it } from 'vitest';
import type { Opportunity, Quotation, SalesOrder } from '@solar/shared';
import type { TestEnv } from '../helpers/env';
import { IDS } from '../helpers/env';
import { API, convertibleLead, makeEnv, seedOpportunity } from '../sites/fixtures';

const addQuote = (env: TestEnv, opportunity_id: string, o: Partial<Quotation> = {}) =>
  env.ctx().db.table('quotations').insert({ opportunity_id, quote_no: 'Q-0001', version: 1, status: 'draft', total: 300000, kw: 5, validity_date: '2026-12-31', compliance_status: 'pending', ...o });
const addOrder = (env: TestEnv, opportunity_id: string, o: Partial<SalesOrder> = {}) =>
  env.ctx().db.table('sales_orders').insert({ opportunity_id, so_no: 'SO-0001', status: 'approved', total: 300000, order_date: '2026-11-01', ...o });

describe('GET /opportunities', () => {
  it('filters by stage, segment, owner, distributor, dealer and name', async () => {
    const env = await makeEnv();
    const a = await seedOpportunity(env, { name: 'Anil Residence' });
    const b = await seedOpportunity(env, { name: 'Beta Foods', segment: 'ci_net_metered', customer_type: 'commercial', capacity_kw: 100, owner_id: IDS.profile('sales_manager') });
    const c = await seedOpportunity(env, { name: 'Chirag Society', segment: 'rwa_ghs', capacity_kw: 60, distributor_id: IDS.distributorB, dealer_id: IDS.dealerB1 }, {}, 'admin');
    await env.as('dsm').post(`${API}/opportunities/${a.id}/stage`).send({ stage: 'quotation' });
    const ids = (r: { body: { data: { id: string }[] } }) => r.body.data.map((o) => o.id).sort();
    const get = (q: string) => env.as('admin').get(`${API}/opportunities${q}`);

    const all = await get('');
    expect(all.body.total).toBe(3);
    expect(all.body.data[0]).toHaveProperty('lead_name');
    expect(ids(await get('?stage=quotation'))).toEqual([a.id]);
    expect(ids(await get('?stage=qualified,quotation'))).toEqual([a.id, b.id, c.id].sort());
    expect(ids(await get('?segment=ci_net_metered'))).toEqual([b.id]);
    expect(ids(await get(`?owner=${IDS.profile('sales_manager')}`))).toEqual([b.id]);
    expect(ids(await get(`?distributor=${IDS.distributorB}`))).toEqual([c.id]);
    expect(ids(await get(`?dealer=${IDS.dealerA1}`))).toEqual([a.id, b.id].sort());
    expect(ids(await get('?q=foods'))).toEqual([b.id]);
    expect((await get('?sort=kw&order=desc&limit=1')).body.data[0].id).toBe(b.id);
    expect((await get('?limit=2&offset=2')).body.data).toHaveLength(1);
    expect((await get('?kw__gte=50')).body.total).toBe(2);
  });

  it('shows a distributor only their own opportunities, whatever the filter', async () => {
    const env = await makeEnv();
    const a = await seedOpportunity(env, { name: 'Own Deal' });
    const b = await seedOpportunity(env, { name: 'Other Deal', distributor_id: IDS.distributorB, dealer_id: IDS.dealerB1 }, {}, 'admin');
    const asA = env.as('distributor_user');
    expect((await asA.get(`${API}/opportunities`)).body.data.map((o: { id: string }) => o.id)).toEqual([a.id]);
    expect((await asA.get(`${API}/opportunities?distributor=${IDS.distributorB}`)).body.total).toBe(0);
    expect((await asA.get(`${API}/opportunities?distributor_id=${IDS.distributorB}`)).body.total).toBe(0);
    expect((await asA.get(`${API}/opportunities/${b.id}`)).status).toBe(403);
    expect((await asA.patch(`${API}/opportunities/${b.id}`).send({ probability: 90 })).status).toBe(403);
    expect((await asA.post(`${API}/opportunities/${b.id}/stage`).send({ stage: 'quotation' })).status).toBe(403);
    expect((await asA.post(`${API}/opportunities/${b.id}/lose`).send({ reason: 'No budget' })).status).toBe(403);
    const asB = env.as(IDS.distributorUserB);
    expect((await asB.get(`${API}/opportunities`)).body.data.map((o: { id: string }) => o.id)).toEqual([b.id]);
    expect((await asB.get(`${API}/opportunities/${a.id}`)).status).toBe(403);
    // dealer A1 sees A's deal (its own lead), dealer B does not
    expect((await env.as('dealer_user').get(`${API}/opportunities/${a.id}`)).status).toBe(200);
    expect((await env.as(IDS.dealerUserB).get(`${API}/opportunities/${a.id}`)).status).toBe(403);
    expect((await env.anon().get(`${API}/opportunities`)).status).toBe(401);
  });
});

describe('GET /opportunities/:id', () => {
  it('is hydrated with lead, customer, site, survey, quotes, orders, funding mix, regulation and a next-step hint', async () => {
    const env = await makeEnv();
    await env.rule('gerc.regulation_versions', [{ from: '2024-04-01', label: 'GERC 2024' }]);
    const o = await seedOpportunity(env, {}, { expected_commissioning_date: '2026-12-10' });
    const bare = (await env.as('dsm').get(`${API}/opportunities/${o.id}`)).body.data;
    expect(bare).toMatchObject({ id: o.id, regulation_version: 'GERC 2024', stage: 'qualified', expected_value_basis: 'indicative', quotes: [], quotes_summary: { count: 0, latest_status: null, accepted: false } });
    expect(bare.lead).toMatchObject({ id: o.lead_id, name: 'Ramesh Patel', mobile: '+919876543210' });
    expect(bare.customer).toMatchObject({ id: o.customer_id, legal_name: 'Ramesh Patel' });
    expect(bare.site).toMatchObject({ id: o.site_id, consumer_no: '12345678' });
    expect(bare.survey).toBeNull();
    expect(bare.funding_mix).toMatchObject({ consumer_pct: 100 });
    expect(bare.regulation_version_display).toMatchObject({ label: 'GERC 2024', effective_from: '2024-04-01' });
    expect(bare.owner_name).toBe('Test dsm');
    expect(bare.next_step.code).toBe('complete_site_visit');

    // after the site visit the hint moves on; each quote status changes it again
    const survey = (await env.as('dsm').post(`${API}/surveys`).send({ lead_id: o.lead_id, scheduled_at: new Date(env.now().getTime() + 86_400_000).toISOString(), surveyor_id: IDS.profile('dsm') })).body.data;
    await env.as('dsm').patch(`${API}/surveys/${survey.id}`).send({ status: 'completed', shading: 'none', roof_type: 'rcc', roof_area_sqm: 40 });
    const stepOf = async () => (await env.as('dsm').get(`${API}/opportunities/${o.id}`)).body.data.next_step.code;
    expect(await stepOf()).toBe('prepare_quote');
    const q = await addQuote(env, o.id);
    const expectations: [Quotation['status'], string][] = [['draft', 'review_quote'], ['blocked', 'fix_compliance'], ['pending_approval', 'await_approval'], ['approved', 'send_quote'], ['sent', 'follow_up_quote'], ['accepted', 'prepare_pi'], ['requote_required', 'revise_quote']];
    for (const [status, code] of expectations) {
      await env.ctx().db.table('quotations').update(q.id, { status });
      expect(await stepOf(), status).toBe(code);
    }
    await addOrder(env, o.id);
    const full = (await env.as('dsm').get(`${API}/opportunities/${o.id}`)).body.data;
    expect(full.survey).toMatchObject({ id: survey.id, status: 'completed' });
    expect(full.quotes[0]).toMatchObject({ quote_no: 'Q-0001', status: 'requote_required', total: 300000 });
    expect(full.quotes_summary).toMatchObject({ count: 1, latest_total: 300000 });
    expect(full.sales_orders[0]).toMatchObject({ so_no: 'SO-0001', status: 'approved' });
  });

  it('masks contact details for roles without a need and 404s unknown ids', async () => {
    const env = await makeEnv();
    const o = await seedOpportunity(env);
    const v = (await env.as('viewer').get(`${API}/opportunities/${o.id}`)).body.data;
    expect(v.lead.mobile).not.toContain('98765');
    expect(v.customer.phone).not.toContain('98765');
    expect((await env.as('dsm').get(`${API}/opportunities/00000000-0000-4000-8000-000000000000`)).status).toBe(404);
    expect((await env.as('dsm').get(`${API}/opportunities/nope`)).status).toBe(404);
  });
});

describe('PATCH /opportunities/:id (step 20)', () => {
  it('updates probability, capacity, closing date, competitor and keeps an indicative value indicative', async () => {
    const env = await makeEnv();
    const o = await seedOpportunity(env);
    const r = await env.as('dsm').patch(`${API}/opportunities/${o.id}`).send({ probability: 65, kw: 8, expected_close_date: '2026-12-20', competitor: 'Tata Power Solar' });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ probability: 65, kw: 8, expected_close_date: '2026-12-20', competitor: 'Tata Power Solar', expected_value: 400000, expected_value_basis: 'indicative' });
    const manual = await env.as('dsm').patch(`${API}/opportunities/${o.id}`).send({ expected_value: 380000 });
    expect(manual.body.data).toMatchObject({ expected_value: 380000, expected_value_basis: 'manual' });
    const resized = await env.as('dsm').patch(`${API}/opportunities/${o.id}`).send({ kw: 10 });
    expect(resized.body.data.expected_value).toBe(380000); // a typed-in revenue is never overwritten
    expect((await env.as('dsm').patch(`${API}/opportunities/${o.id}`).send({ competitor: '' })).body.data.competitor).toBeNull();
    expect((await env.db.table('audit_log').all()).filter((a) => a.source === 'api' && a.action === 'opportunity.update')).toHaveLength(4);
    expect((await env.db.table('lead_events').all({ lead_id: o.lead_id })).some((e) => e.event_type === 'opportunity_updated')).toBe(true);
  });

  it('a new commissioning date re-derives the regulation version and the exemption default', async () => {
    const env = await makeEnv();
    await env.rule('gerc.regulation_versions', [{ from: '2019-01-01', label: 'GERC 2019' }, { from: '2024-04-01', label: 'GERC 2024' }]);
    await env.rule('almm.list2.exemption_net_metering_open_access_until', '2026-12-31');
    const o = await seedOpportunity(env, { segment: 'ci_net_metered', customer_type: 'commercial', capacity_kw: 100 }, { expected_commissioning_date: '2023-05-01' });
    expect(o).toMatchObject({ regulation_version: 'GERC 2019', exemption_reliance: true });
    const later = await env.as('dsm').patch(`${API}/opportunities/${o.id}`).send({ expected_commissioning_date: '2027-02-01' });
    expect(later.body.data).toMatchObject({ expected_commissioning_date: '2027-02-01', regulation_version: 'GERC 2024', exemption_reliance: false });
    expect((await env.db.table('clocks').all({ entity_id: o.id, status: 'running' }))).toHaveLength(0); // the exemption clock stops when the flag goes off
    const back = await env.as('dsm').patch(`${API}/opportunities/${o.id}`).send({ expected_commissioning_date: '2026-11-15' });
    expect(back.body.data.exemption_reliance).toBe(true);
    expect((await env.db.table('clocks').all({ entity_id: o.id, status: 'running' }))).toHaveLength(1);
    // a deliberate choice is respected when the date moves
    const manual = await env.as('dsm').patch(`${API}/opportunities/${o.id}`).send({ exemption_reliance: false });
    expect(manual.body.data.exemption_reliance).toBe(false);
    const moved = await env.as('dsm').patch(`${API}/opportunities/${o.id}`).send({ expected_commissioning_date: '2026-12-01' });
    expect(moved.body.data.exemption_reliance).toBe(false);
    const cleared = await env.as('dsm').patch(`${API}/opportunities/${o.id}`).send({ expected_commissioning_date: null });
    expect(cleared.body.data).toMatchObject({ expected_commissioning_date: null, regulation_version: null });
    const warn = await env.as('dsm').patch(`${API}/opportunities/${o.id}`).send({ exemption_reliance: true, expected_commissioning_date: '2027-03-01' });
    expect(warn.body.data.warnings.map((w: { code: string }) => w.code)).toContain('EXEMPTION_DATE_EXCEEDED');
  });

  it('the loan rate is a free input with a source date and is never defaulted', async () => {
    const env = await makeEnv();
    const o = await seedOpportunity(env);
    const url = `${API}/opportunities/${o.id}`;
    const noRate = await env.as('dsm').patch(url).send({ funding_mix: { consumer_pct: 30, loan_pct: 50, subsidy_pct: 20 } });
    expect(noRate.status).toBe(200);
    expect(noRate.body.data.funding_mix).toEqual({ consumer_pct: 30, loan_pct: 50, subsidy_pct: 20, loan_rate_pct: null, loan_rate_source_date: null, bank: null });
    expect(noRate.body.data.warnings.map((w: { code: string }) => w.code)).toContain('LOAN_RATE_MISSING');
    const missingDate = await env.as('dsm').patch(url).send({ funding_mix: { consumer_pct: 30, loan_pct: 50, subsidy_pct: 20, loan_rate_pct: 6.75 } });
    expect(missingDate.status).toBe(422);
    const ok = await env.as('dsm').patch(url).send({ funding_mix: { consumer_pct: 30, loan_pct: 50, subsidy_pct: 20, loan_rate_pct: 6.75, loan_rate_source_date: '2026-10-20', bank: 'Bank of Baroda' } });
    expect(ok.body.data.funding_mix).toMatchObject({ loan_rate_pct: 6.75, loan_rate_source_date: '2026-10-20' });
    expect(ok.body.data.warnings.map((w: { code: string }) => w.code)).not.toContain('LOAN_RATE_MISSING');
    expect((await env.as('dsm').patch(url).send({ funding_mix: { consumer_pct: 60, loan_pct: 60, subsidy_pct: 0 } })).status).toBe(422);
  });

  it('validates input and refuses edits on closed opportunities and for read-only roles', async () => {
    const env = await makeEnv();
    const o = await seedOpportunity(env);
    const url = `${API}/opportunities/${o.id}`;
    for (const bad of [{ probability: 150 }, { probability: -1 }, { kw: 0 }, { expected_value: -5 }, { expected_close_date: '2026-13-01' }, { stage: 'won' }, {}]) {
      expect((await env.as('dsm').patch(url).send(bad)).status, JSON.stringify(bad)).toBe(422);
    }
    expect((await env.as('viewer').patch(url).send({ probability: 10 })).status).toBe(403);
    await env.as('dsm').post(`${url}/lose`).send({ reason: 'Chose another vendor' });
    expect((await env.as('dsm').patch(url).send({ probability: 10 })).status).toBe(409);
  });
});

describe('stage moves, lose and reopen', () => {
  it('moves along the board but only goes to won when a sales order exists', async () => {
    const env = await makeEnv();
    const o = await seedOpportunity(env);
    const stage = (s: string, as = 'dsm') => env.as(as).post(`${API}/opportunities/${o.id}/stage`).send({ stage: s });
    for (const s of ['quotation', 'negotiation', 'pi_stage', 'negotiation', 'qualified']) {
      const r = await stage(s);
      expect(r.status, s).toBe(200);
      expect(r.body.data.stage).toBe(s);
    }
    expect((await stage('qualified')).status).toBe(200); // same stage is a no-op
    expect((await stage('bogus')).status).toBe(422);
    const lost = await stage('lost');
    expect(lost.status).toBe(400); // lost needs a reason: use /lose
    expect((await stage('quotation', 'viewer')).status).toBe(403);

    const blocked = await stage('won');
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('GUARD_BLOCKED');
    expect(blocked.body.error.details.missing).toEqual(['sales_order']);
    await addOrder(env, o.id, { status: 'cancelled' });
    expect((await stage('won')).status).toBe(422); // a cancelled order does not count
    await addOrder(env, o.id, { so_no: 'SO-0002', status: 'draft' });
    const won = await stage('won');
    expect(won.status).toBe(200);
    expect(won.body.data).toMatchObject({ stage: 'won', probability: 100 });
    expect((await env.db.table('leads').get(o.lead_id))!.status).toBe('won');
    expect((await stage('quotation')).status).toBe(409); // won is closed
    expect((await env.as('dsm').post(`${API}/opportunities/${o.id}/lose`).send({ reason: 'Cancelled' })).status).toBe(409);
    const events = (await env.db.table('lead_events').all({ lead_id: o.lead_id })).map((e) => e.event_type);
    expect(events).toContain('opportunity_stage');
    expect((await env.db.table('audit_log').all()).filter((a) => a.action === 'opportunity.stage')).toHaveLength(6);
  });

  it('lose needs a reason, closes the lead too, and reopen restores the deal', async () => {
    const env = await makeEnv();
    const o = await seedOpportunity(env);
    const lose = (b: Record<string, unknown>) => env.as('dsm').post(`${API}/opportunities/${o.id}/lose`).send(b);
    expect((await lose({})).status).toBe(422);
    expect((await lose({ reason: 'x' })).status).toBe(422);
    const r = await lose({ reason: 'Customer chose a competitor on price', competitor: 'Waaree' });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ stage: 'lost', lost_reason: 'Customer chose a competitor on price', probability: 0, competitor: 'Waaree' });
    expect(r.body.data.next_step.code).toBe('reopen_or_close');
    expect(await env.db.table('leads').get(o.lead_id)).toMatchObject({ status: 'lost', lost_reason: 'Customer chose a competitor on price' });
    expect((await lose({ reason: 'again' })).status).toBe(409);
    expect((await env.as('dsm').post(`${API}/opportunities/${o.id}/stage`).send({ stage: 'quotation' })).status).toBe(409);

    await addQuote(env, o.id, { status: 'sent' });
    const back = await env.as('dsm').post(`${API}/opportunities/${o.id}/reopen`).send({});
    expect(back.status).toBe(200);
    expect(back.body.data).toMatchObject({ stage: 'quotation', lost_reason: null, probability: 40 });
    expect(await env.db.table('leads').get(o.lead_id)).toMatchObject({ status: 'opportunity', lost_reason: null });
    expect((await env.as('dsm').post(`${API}/opportunities/${o.id}/reopen`).send({})).status).toBe(409); // not lost any more
    await lose({ reason: 'Postponed' });
    const explicit = await env.as('dsm').post(`${API}/opportunities/${o.id}/reopen`).send({ stage: 'negotiation', note: 'Customer called back' });
    expect(explicit.body.data.stage).toBe('negotiation');
    expect((await env.as('dsm').post(`${API}/opportunities/${o.id}/reopen`).send({ stage: 'won' })).status).toBe(422); // only open stages can be reopened into
  });

  it('reopening a deal without any quote goes back to qualified; lose stops the exemption clock', async () => {
    const env = await makeEnv();
    await env.rule('almm.list2.exemption_net_metering_open_access_until', '2026-12-31');
    const o = await seedOpportunity(env, { segment: 'open_access', customer_type: 'industrial', capacity_kw: 500 }, { expected_commissioning_date: '2026-12-01' });
    expect(await env.db.table('clocks').count({ entity_id: o.id, status: 'running' })).toBe(1);
    await env.as('dsm').post(`${API}/opportunities/${o.id}/lose`).send({ reason: 'Grid connection refused' });
    expect(await env.db.table('clocks').count({ entity_id: o.id, status: 'running' })).toBe(0);
    const back = await env.as('dsm').post(`${API}/opportunities/${o.id}/reopen`).send({});
    expect(back.body.data.stage).toBe('qualified');
    expect(await env.db.table('clocks').count({ entity_id: o.id, status: 'running' })).toBe(1);
  });
});

describe('GET /opportunities/pipeline', () => {
  async function board() {
    const env = await makeEnv();
    const a = await seedOpportunity(env, { name: 'Pipe A' }, { probability: 50 }); // 5 kW → 250,000
    const b = await seedOpportunity(env, { name: 'Pipe B', capacity_kw: 10 }, { probability: 20 }); // 500,000
    const c = await seedOpportunity(env, { name: 'Pipe C', segment: 'ci_net_metered', customer_type: 'commercial', capacity_kw: 100, distributor_id: IDS.distributorB, dealer_id: IDS.dealerB1 }, { probability: 80 }, 'admin'); // 5,000,000
    const d = await seedOpportunity(env, { name: 'Pipe D', capacity_kw: 4 });
    const e = await seedOpportunity(env, { name: 'Pipe E', capacity_kw: 6 });
    await env.as('dsm').post(`${API}/opportunities/${b.id}/stage`).send({ stage: 'quotation' });
    await addOrder(env, d.id);
    await env.as('dsm').post(`${API}/opportunities/${d.id}/stage`).send({ stage: 'won' });
    await env.as('dsm').post(`${API}/opportunities/${e.id}/lose`).send({ reason: 'No budget' });
    return { env, a, b, c, d, e };
  }

  it('counts and values every stage and totals the open pipeline', async () => {
    const { env, a, b, c, d } = await board();
    const r = await env.as('admin').get(`${API}/opportunities/pipeline`);
    expect(r.status).toBe(200);
    const by = Object.fromEntries((r.body.data.stages as { stage: string; cards: { id: string }[] }[]).map((s) => [s.stage, s]));
    expect(r.body.data.stages.map((s: { stage: string }) => s.stage)).toEqual(['qualified', 'quotation', 'negotiation', 'pi_stage', 'won', 'lost']);
    expect(by['qualified']).toMatchObject({ count: 2, value: 5_250_000, weighted_value: 125_000 + 4_000_000, kw: 105 });
    expect(by['quotation']).toMatchObject({ count: 1, value: 500_000, weighted_value: 100_000, avg_probability: 20 });
    expect(by['negotiation']).toMatchObject({ count: 0, value: 0, avg_probability: null });
    expect(by['won']).toMatchObject({ count: 1, value: 200_000, weighted_value: 200_000 });
    expect(by['lost']).toMatchObject({ count: 1, weighted_value: 0 });
    expect(by['qualified'].cards.map((x: { id: string }) => x.id)).toEqual([c.id, a.id]); // biggest first
    expect(by['qualified'].cards[0]).toMatchObject({ name: 'Pipe C — 100 kW', expected_value: 5_000_000, probability: 80 });
    expect(r.body.data.totals).toMatchObject({ open_count: 3, open_value: 5_750_000, won_count: 1, won_value: 200_000, lost_count: 1, win_rate_pct: 50, open_kw: 115 });
    expect(r.body.data.currency).toBe('INR');
    expect(by['won'].cards[0].id).toBe(d.id);
    expect(by['quotation'].cards[0].id).toBe(b.id);
  });

  it('filters, limits cards and is scoped to the caller', async () => {
    const { env, a, c } = await board();
    const seg = await env.as('admin').get(`${API}/opportunities/pipeline?segment=ci_net_metered&card_limit=0`);
    expect(seg.body.data.totals.open_count).toBe(1);
    expect(seg.body.data.stages[0].cards).toEqual([]);
    expect((await env.as('admin').get(`${API}/opportunities/pipeline?distributor=${IDS.distributorB}`)).body.data.stages[0].cards[0].id).toBe(c.id);
    const own = await env.as('distributor_user').get(`${API}/opportunities/pipeline`);
    expect(own.body.data.stages[0].cards.map((x: { id: string }) => x.id)).toContain(a.id);
    expect(own.body.data.stages.flatMap((s: { cards: { id: string }[] }) => s.cards).map((x: { id: string }) => x.id)).not.toContain(c.id);
    expect(own.body.data.totals.open_value).toBe(750_000);
    const hacked = await env.as('distributor_user').get(`${API}/opportunities/pipeline?distributor=${IDS.distributorB}`);
    expect(hacked.body.data.totals.open_count).toBe(0);
    expect((await env.as('viewer').get(`${API}/opportunities/pipeline`)).status).toBe(200);
  });

  it('is not shadowed by /opportunities/:id and survives an empty pipeline', async () => {
    const env = await makeEnv();
    const r = await env.as('dsm').get(`${API}/opportunities/pipeline`);
    expect(r.status).toBe(200);
    expect(r.body.data.totals).toMatchObject({ open_count: 0, win_rate_pct: null });
  });
});

describe('opportunity types', () => {
  it('rows keep the contract shape', async () => {
    const env = await makeEnv();
    const lead = await convertibleLead(env);
    const row = (await env.as('dsm').post(`${API}/leads/${lead.id}/convert`).send({ requirement_confirmed: true, timeline_confirmed: true, commercial_potential_confirmed: true })).body.data.opportunity as Opportunity;
    const stored = (await env.db.table('opportunities').get(row.id))!;
    expect(Object.keys(stored)).toEqual(expect.arrayContaining(['name', 'lead_id', 'segment', 'kw', 'scheme_route', 'funding_mix', 'probability', 'expected_value', 'stage', 'owner_id']));
  });
});
