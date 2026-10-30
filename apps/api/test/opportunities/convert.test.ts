import { describe, expect, it } from 'vitest';
import { IDS } from '../helpers/env';
import { API, allConfirmed, completeBody, convertibleLead, makeEnv, saveSite, scheduleSurvey, seedLead } from '../sites/fixtures';

const REGULATIONS = [{ from: '2019-01-01', label: 'GERC Net Metering 2019' }, { from: '2024-04-01', label: 'GERC Net Metering 2024' }];
const FLAGS = ['requirement_confirmed', 'timeline_confirmed', 'commercial_potential_confirmed'] as const;

describe('POST /leads/:id/convert — the opportunity guard', () => {
  it.each([
    [{}, [...FLAGS]],
    [{ requirement_confirmed: true }, ['timeline_confirmed', 'commercial_potential_confirmed']],
    [{ timeline_confirmed: true }, ['requirement_confirmed', 'commercial_potential_confirmed']],
    [{ commercial_potential_confirmed: true }, ['requirement_confirmed', 'timeline_confirmed']],
    [{ requirement_confirmed: true, timeline_confirmed: true }, ['commercial_potential_confirmed']],
    [{ requirement_confirmed: true, timeline_confirmed: false, commercial_potential_confirmed: true }, ['timeline_confirmed']],
  ])('lists exactly the missing confirmations for %j', async (flags, missing) => {
    const env = await makeEnv();
    const lead = await convertibleLead(env);
    const r = await env.as('dsm').post(`${API}/leads/${lead.id}/convert`).send(flags);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('GUARD_BLOCKED');
    expect(r.body.error.details.missing).toEqual(missing);
    expect(r.body.error.details.missing_confirmations).toEqual(missing);
    expect(r.body.error.details.missing_prerequisites).toEqual([]);
    expect(await env.db.table('opportunities').count()).toBe(0);
    expect((await env.db.table('leads').get(lead.id))!.status).toBe('qualified');
  });

  it('also needs a segment, a capacity and a site — and says which', async () => {
    const env = await makeEnv();
    const bare = await seedLead(env, { segment: null, capacity_kw: null });
    const r = await env.as('dsm').post(`${API}/leads/${bare.id}/convert`).send(allConfirmed);
    expect(r.body.error.code).toBe('GUARD_BLOCKED');
    expect(r.body.error.details.missing_prerequisites).toEqual(['segment', 'capacity_kw', 'site']);
    expect(r.body.error.details.missing_confirmations).toEqual([]);
    const both = await env.as('dsm').post(`${API}/leads/${bare.id}/convert`).send({});
    expect(both.body.error.details.missing).toEqual([...FLAGS, 'segment', 'capacity_kw', 'site']);
    expect(both.body.error.message).toMatch(/requirement not confirmed/);
    // a capacity in the request is enough
    const noKw = await convertibleLead(env, { capacity_kw: null, name: 'No kW' });
    expect((await env.as('dsm').post(`${API}/leads/${noKw.id}/convert`).send(allConfirmed)).body.error.details.missing).toEqual(['capacity_kw']);
    const withKw = await env.as('dsm').post(`${API}/leads/${noKw.id}/convert`).send({ ...allConfirmed, kw: 4.5 });
    expect(withKw.status).toBe(201);
    expect(withKw.body.data.opportunity.kw).toBe(4.5);
    expect((await env.db.table('leads').get(noKw.id))!.capacity_kw).toBe(4.5);
  });

  it('only accepted-or-later leads convert', async () => {
    const env = await makeEnv();
    for (const status of ['new', 'assigned', 'lost', 'won', 'merged', 'duplicate'] as const) {
      const lead = await convertibleLead(env, { status, name: `Lead ${status}` });
      const r = await env.as('dsm').post(`${API}/leads/${lead.id}/convert`).send(allConfirmed);
      expect(r.status, status).toBe(409);
      expect(r.body.error.code).toBe('INVALID_STATE');
    }
    for (const status of ['accepted', 'contacted', 'site_visit', 'nurture'] as const) {
      const lead = await convertibleLead(env, { status, name: `Lead ${status}` });
      expect((await env.as('dsm').post(`${API}/leads/${lead.id}/convert`).send(allConfirmed)).status, status).toBe(201);
    }
  });
});

describe('POST /leads/:id/convert — creating the opportunity', () => {
  it('creates and links the opportunity, moves the lead, and logs events', async () => {
    const env = await makeEnv();
    const lead = await convertibleLead(env);
    const survey = await scheduleSurvey(env, lead);
    await env.as('dsm').post(`${API}/leads/${lead.id}/negotiations`).send({ quoted_rate_per_kw: 52000 });
    await env.as('dsm').put(`${API}/leads/${lead.id}/requirement`).send({ data: { consumer_no: '5551234' } });

    const r = await env.as('dsm').post(`${API}/leads/${lead.id}/convert`).send({ ...allConfirmed, expected_close_date: '2026-12-01' });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ created: true, already_converted: false, expected_value_basis: 'indicative' });
    const o = r.body.data.opportunity;
    expect(o).toMatchObject({
      lead_id: lead.id, customer_id: lead.customer_id, site_id: lead.site_id, segment: 'pmsg_residential', scheme_route: 'pmsg', kw: 5, stage: 'qualified',
      requirement_confirmed: true, timeline_confirmed: true, commercial_potential_confirmed: true, owner_id: IDS.profile('dsm'),
      distributor_id: IDS.distributorA, dealer_id: IDS.dealerA1, territory_id: IDS.territoryAhmedabad, expected_close_date: '2026-12-01',
      regulation_version: null, exemption_reliance: false, probability: 40, expected_value: 250000, name: 'Ramesh Patel — 5 kW',
    });
    expect(o.funding_mix).toEqual({ consumer_pct: 100, loan_pct: 0, subsidy_pct: 0, loan_rate_pct: null, loan_rate_source_date: null, bank: null }); // the loan rate is never defaulted
    expect(r.body.data.indicative_rate_per_kw).toEqual({ rate: 50000, source: 'fallback' });
    expect(r.body.data.warnings.map((w: { code: string }) => w.code)).toContain('INDICATIVE_RATE_FALLBACK');

    expect((await env.db.table('leads').get(lead.id))!.status).toBe('opportunity');
    const events = (await env.db.table('lead_events').all({ lead_id: lead.id })).map((e) => e.event_type);
    expect(events).toEqual(expect.arrayContaining(['converted', 'status_changed']));
    expect((await env.db.table('site_surveys').get(survey.id))!.opportunity_id).toBe(o.id);
    expect((await env.db.table('requirement_forms').one({ lead_id: lead.id }))!.opportunity_id).toBe(o.id);
    expect((await env.db.table('negotiation_logs').one({ lead_id: lead.id }))!.opportunity_id).toBe(o.id);
    expect((await env.db.table('audit_log').all()).some((a) => a.source === 'api' && a.action === 'lead.convert' && a.record_id === o.id)).toBe(true);
    expect((await env.db.table('notifications').all({ kind: 'opportunity.created' })).length).toBeGreaterThan(0);
  });

  it('is idempotent: a lead converts once', async () => {
    const env = await makeEnv();
    const lead = await convertibleLead(env);
    const first = await env.as('dsm').post(`${API}/leads/${lead.id}/convert`).send(allConfirmed);
    const again = await env.as('dsm').post(`${API}/leads/${lead.id}/convert`).send(allConfirmed);
    const bare = await env.as('dsm').post(`${API}/leads/${lead.id}/convert`).send({}); // even without the flags the existing opportunity is returned
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(bare.status).toBe(200);
    expect(again.body.data).toMatchObject({ created: false, already_converted: true });
    expect(again.body.data.opportunity.id).toBe(first.body.data.opportunity.id);
    expect(await env.db.table('opportunities').count({ lead_id: lead.id })).toBe(1);
    expect((await env.db.table('lead_events').all({ lead_id: lead.id })).filter((e) => e.event_type === 'converted')).toHaveLength(1);
  });

  it('probability and value come from the rules and the lead temperature', async () => {
    const env = await makeEnv();
    await env.rule('opportunity.indicative_rate_per_kw', 60000);
    await env.rule('opportunity.default_probability', { hot: 70, warm: 45, cold: 10 });
    const hot = await convertibleLead(env, { temperature: 'hot', name: 'Hot' });
    const cold = await convertibleLead(env, { temperature: 'cold', name: 'Cold' });
    const h = await env.as('dsm').post(`${API}/leads/${hot.id}/convert`).send(allConfirmed);
    const c = await env.as('dsm').post(`${API}/leads/${cold.id}/convert`).send({ ...allConfirmed, expected_value: 275000 });
    expect(h.body.data.opportunity).toMatchObject({ probability: 70, expected_value: 300000 });
    expect(h.body.data.indicative_rate_per_kw).toEqual({ rate: 60000, source: 'rule' });
    expect(h.body.data.opportunity.indicative).toMatchObject({ value: 300000, label: expect.stringMatching(/Indicative/) });
    expect(h.body.data.warnings).toEqual([]);
    expect(c.body.data.opportunity).toMatchObject({ probability: 10, expected_value: 275000, expected_value_basis: 'manual' });
    expect(c.body.data.expected_value_basis).toBe('manual');
    // an inactive rule never changes behaviour
    const env2 = await makeEnv();
    await env2.rule('opportunity.indicative_rate_per_kw', 99999, { is_active: false });
    const l = await convertibleLead(env2);
    expect((await env2.as('dsm').post(`${API}/leads/${l.id}/convert`).send(allConfirmed)).body.data.opportunity.expected_value).toBe(250000);
  });

  it('accepts an explicit funding mix; the loan rate must carry its source date', async () => {
    const env = await makeEnv();
    const lead = await convertibleLead(env);
    const url = `${API}/leads/${lead.id}/convert`;
    expect((await env.as('dsm').post(url).send({ ...allConfirmed, funding_mix: { consumer_pct: 50, loan_pct: 40, subsidy_pct: 20 } })).status).toBe(422); // adds up to 110
    const noDate = await env.as('dsm').post(url).send({ ...allConfirmed, funding_mix: { consumer_pct: 40, loan_pct: 40, subsidy_pct: 20, loan_rate_pct: 7 } });
    expect(noDate.status).toBe(422);
    expect(noDate.body.error.details.map((d: { path: string }) => d.path)).toContain('funding_mix.loan_rate_source_date');
    const ok = await env.as('dsm').post(url).send({ ...allConfirmed, funding_mix: { consumer_pct: 40, loan_pct: 40, subsidy_pct: 20, loan_rate_pct: 7, loan_rate_source_date: '2026-10-01', bank: 'SBI' } });
    expect(ok.status).toBe(201);
    expect(ok.body.data.opportunity.funding_mix).toMatchObject({ loan_rate_pct: 7, loan_rate_source_date: '2026-10-01', bank: 'SBI' });
    // a loan without a rate is allowed — and flagged, never defaulted
    const l2 = await convertibleLead(env, { name: 'Loan no rate' });
    const open = await env.as('dsm').post(`${API}/leads/${l2.id}/convert`).send({ ...allConfirmed, funding_mix: { consumer_pct: 40, loan_pct: 40, subsidy_pct: 20 } });
    expect(open.body.data.opportunity.funding_mix.loan_rate_pct).toBeNull();
    expect(open.body.data.warnings.map((w: { code: string }) => w.code)).toContain('LOAN_RATE_MISSING');
  });
});

describe('regulation_version from the expected commissioning date', () => {
  it.each([
    ['2025-01-01', 'GERC Net Metering 2024'],
    ['2024-04-01', 'GERC Net Metering 2024'], // the day a new regulation starts
    ['2024-03-31', 'GERC Net Metering 2019'],
    ['2023-06-01', 'GERC Net Metering 2019'],
    ['2018-12-31', null], // before the first entry
    [null, null],
  ])('%s → %s', async (date, label) => {
    const env = await makeEnv();
    await env.rule('gerc.regulation_versions', REGULATIONS);
    const lead = await convertibleLead(env);
    const r = await env.as('dsm').post(`${API}/leads/${lead.id}/convert`).send({ ...allConfirmed, expected_commissioning_date: date });
    expect(r.status).toBe(201);
    expect(r.body.data.opportunity.regulation_version).toBe(label);
  });

  it('is null when the rule is absent or inactive', async () => {
    const env = await makeEnv();
    const a = await convertibleLead(env, { name: 'Lead Alpha' });
    expect((await env.as('dsm').post(`${API}/leads/${a.id}/convert`).send({ ...allConfirmed, expected_commissioning_date: '2025-06-01' })).body.data.opportunity.regulation_version).toBeNull();
    await env.rule('gerc.regulation_versions', REGULATIONS, { is_active: false, status: 'unverified' });
    const b = await convertibleLead(env, { name: 'Lead Beta' });
    expect((await env.as('dsm').post(`${API}/leads/${b.id}/convert`).send({ ...allConfirmed, expected_commissioning_date: '2025-06-01' })).body.data.opportunity.regulation_version).toBeNull();
  });

  it('the opportunity detail shows the regulation with its rule status', async () => {
    const env = await makeEnv();
    await env.rule('gerc.regulation_versions', REGULATIONS, { status: 'unverified', confidence: 'medium' });
    const lead = await convertibleLead(env);
    const o = (await env.as('dsm').post(`${API}/leads/${lead.id}/convert`).send({ ...allConfirmed, expected_commissioning_date: '2025-06-01' })).body.data.opportunity;
    expect(o.regulation_version_display).toMatchObject({ label: 'GERC Net Metering 2024', effective_from: '2024-04-01', advisory: true, resolved_from_commissioning_date: '2025-06-01' });
    expect(o.regulation_version_display.rule).toMatchObject({ status: 'unverified', confidence: 'medium', active: true });
  });
});

describe('exemption_reliance default', () => {
  const run = async (segment: 'ci_net_metered' | 'open_access' | 'pmsg_residential' | 'ci_captive', date: string | null, rule: string | null, body: Record<string, unknown> = {}) => {
    const env = await makeEnv();
    if (rule) await env.rule('almm.list2.exemption_net_metering_open_access_until', rule);
    const lead = await convertibleLead(env, { segment, customer_type: 'commercial', capacity_kw: 100 });
    const r = await env.as('dsm').post(`${API}/leads/${lead.id}/convert`).send({ ...allConfirmed, expected_commissioning_date: date, ...body });
    expect(r.status).toBe(201);
    return { env, opp: r.body.data.opportunity, body: r.body.data };
  };

  it('is true for net-metered / open access jobs commissioning on or before the exemption date', async () => {
    expect((await run('ci_net_metered', '2026-12-15', '2026-12-31')).opp.exemption_reliance).toBe(true);
    expect((await run('open_access', '2026-12-31', '2026-12-31')).opp.exemption_reliance).toBe(true);
  });

  it('is false after the date, without a date, for other segments, and when the rule is missing', async () => {
    expect((await run('ci_net_metered', '2027-01-15', '2026-12-31')).opp.exemption_reliance).toBe(false);
    expect((await run('ci_net_metered', null, '2026-12-31')).opp.exemption_reliance).toBe(false);
    expect((await run('pmsg_residential', '2026-12-15', '2026-12-31')).opp.exemption_reliance).toBe(false);
    expect((await run('ci_captive', '2026-12-15', '2026-12-31')).opp.exemption_reliance).toBe(false);
    expect((await run('ci_net_metered', '2026-12-15', null)).opp.exemption_reliance).toBe(false);
  });

  it('can be overridden, warns when the date is past the exemption, and runs an exemption clock', async () => {
    expect((await run('ci_net_metered', '2026-12-15', '2026-12-31', { exemption_reliance: false })).opp.exemption_reliance).toBe(false);
    const late = await run('ci_net_metered', '2027-02-01', '2026-12-31', { exemption_reliance: true });
    expect(late.opp.exemption_reliance).toBe(true);
    expect(late.body.warnings.map((w: { code: string; gate?: string }) => w.code)).toContain('EXEMPTION_DATE_EXCEEDED');
    const ok = await run('ci_net_metered', '2026-12-15', '2026-12-31');
    const clocks = await ok.env.db.table('clocks').all({ entity_id: ok.opp.id });
    expect(clocks).toHaveLength(1);
    expect(clocks[0]).toMatchObject({ clock_type: 'almm_exemption_commissioning', entity_type: 'opportunity', status: 'running', owner_id: IDS.profile('dsm') });
    expect(clocks[0]!.due_at).toBe('2026-12-31T18:29:59.999Z'); // end of 31-Dec in IST
  });
});

describe('convert access and readiness', () => {
  it('keeps other distributors and read-only roles out', async () => {
    const env = await makeEnv();
    const lead = await convertibleLead(env);
    expect((await env.as(IDS.distributorUserB).post(`${API}/leads/${lead.id}/convert`).send(allConfirmed)).status).toBe(403);
    expect((await env.as('viewer').post(`${API}/leads/${lead.id}/convert`).send(allConfirmed)).status).toBe(403);
    expect((await env.as('accounts').post(`${API}/leads/${lead.id}/convert`).send(allConfirmed)).status).toBe(403);
    expect(await env.db.table('opportunities').count()).toBe(0);
    const own = await env.as('distributor_user').post(`${API}/leads/${lead.id}/convert`).send(allConfirmed);
    expect(own.status).toBe(201);
    expect(own.body.data.opportunity.distributor_id).toBe(IDS.distributorA);
  });

  it('GET /leads/:id/convert-check explains what is still missing', async () => {
    const env = await makeEnv();
    const bare = await seedLead(env, { capacity_kw: null });
    const before = await env.as('dsm').get(`${API}/leads/${bare.id}/convert-check`);
    expect(before.body.data).toMatchObject({ can_convert: false, status_ok: true, missing: ['capacity_kw', 'site'], requirement_form: 'none', opportunity_id: null });
    expect(before.body.data.confirmations.map((c: { key: string }) => c.key)).toEqual([...FLAGS]);
    await saveSite(env, bare);
    await env.db.table('leads').update(bare.id, { capacity_kw: 5 });
    const ready = await env.as('dsm').get(`${API}/leads/${bare.id}/convert-check`);
    expect(ready.body.data).toMatchObject({ can_convert: true, missing: [] });
    const o = (await env.as('dsm').post(`${API}/leads/${bare.id}/convert`).send(allConfirmed)).body.data.opportunity;
    expect((await env.as('dsm').get(`${API}/leads/${bare.id}/convert-check`)).body.data).toMatchObject({ can_convert: false, opportunity_id: o.id });
  });

  it('a completed site visit and a saved requirement form show up on the opportunity', async () => {
    const env = await makeEnv();
    const lead = await convertibleLead(env);
    const survey = await scheduleSurvey(env, lead);
    await env.as('dsm').patch(`${API}/surveys/${survey.id}`).send(completeBody);
    const o = (await env.as('dsm').post(`${API}/leads/${lead.id}/convert`).send(allConfirmed)).body.data.opportunity;
    expect(o.survey).toMatchObject({ id: survey.id, status: 'completed', opportunity_id: o.id });
    expect(o.next_step.code).toBe('set_commissioning_date');
  });
});
