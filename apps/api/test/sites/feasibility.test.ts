import { describe, expect, it } from 'vitest';
import { tickClocks } from '../../src/services/clockService';
import { reconcileDeemedSurveys } from '../../src/services/surveyFeasibility';
import { IDS } from '../helpers/env';
import { API, feasibilityRules, makeEnv, scheduleSurvey, seedLead } from './fixtures';

const DAY = 86_400_000;

describe('DISCOM feasibility tracking', () => {
  it('up to 10 kW no study is needed and recording one is refused', async () => {
    const env = await makeEnv();
    await feasibilityRules(env);
    const lead = await seedLead(env, { capacity_kw: 8 });
    const survey = await scheduleSurvey(env, lead);
    expect(survey.feasibility_status).toBe('not_required');
    const view = (await env.as('dsm').get(`${API}/surveys/${survey.id}`)).body.data.feasibility;
    expect(view).toMatchObject({ required: false, threshold_kw: 10, threshold_source: 'rule', status: 'not_required' });
    const r = await env.as('dsm').patch(`${API}/surveys/${survey.id}/feasibility`).send({ submitted_at: env.now().toISOString() });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('INVALID_STATE');
    expect(r.body.error.details).toMatchObject({ kw: 8, threshold_kw: 10 });
    expect(await env.db.table('clocks').count()).toBe(0);
  });

  it('above 10 kW both dates are stored, the due date is complete + 15 days and the clock starts when COMPLETE', async () => {
    const env = await makeEnv();
    await feasibilityRules(env);
    const lead = await seedLead(env, { capacity_kw: 25 });
    const survey = await scheduleSurvey(env, lead);
    expect(survey.feasibility_status).toBe('pending');

    const submitted = new Date(env.now().getTime() - 2 * DAY).toISOString();
    const complete = new Date(env.now().getTime() - 1 * DAY).toISOString();
    const first = await env.as('dsm').patch(`${API}/surveys/${survey.id}/feasibility`).send({ submitted_at: submitted });
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ status: 'pending', application_submitted_at: submitted, application_complete_at: null, due_at: null, clock: null });
    expect(await env.db.table('clocks').count()).toBe(0); // submitted but not complete: no clock yet

    const done = await env.as('dsm').patch(`${API}/surveys/${survey.id}/feasibility`).send({ complete_at: complete });
    expect(done.status).toBe(200);
    const due = new Date(new Date(complete).getTime() + 15 * DAY).toISOString();
    expect(done.body.data).toMatchObject({ application_submitted_at: submitted, application_complete_at: complete, due_at: due, days_allowed: 15, days_source: 'rule', deemed_enabled: true, required: true, kw: 25 });
    expect(done.body.data.clock).toMatchObject({ status: 'running', due_at: due });
    const row = (await env.db.table('site_surveys').get(survey.id))!;
    expect(row).toMatchObject({ feasibility_application_submitted_at: submitted, feasibility_application_complete_at: complete, feasibility_due_at: due, feasibility_status: 'pending' });
    const clocks = await env.db.table('clocks').all({ clock_type: 'discom_feasibility' });
    expect(clocks).toHaveLength(1);
    expect(clocks[0]).toMatchObject({ entity_type: 'lead', entity_id: lead.id, started_at: complete, due_at: due, status: 'running' });

    await env.as('dsm').patch(`${API}/surveys/${survey.id}/feasibility`).send({ complete_at: complete }); // same data again: the clock is not restarted
    expect((await env.db.table('clocks').all({ clock_type: 'discom_feasibility' })).map((c) => c.id)).toEqual([clocks[0]!.id]);
  });

  it('silence past the 15 days marks the survey deemed (clock breach via tickClocks) and stops escalation', async () => {
    const env = await makeEnv();
    await feasibilityRules(env);
    const lead = await seedLead(env, { capacity_kw: 25 });
    const survey = await scheduleSurvey(env, lead);
    const t = env.now().toISOString();
    await env.as('dsm').patch(`${API}/surveys/${survey.id}/feasibility`).send({ submitted_at: t, complete_at: t });

    env.advance(10 * DAY); // 66 % — still inside the period
    await tickClocks(env.deps);
    expect((await env.db.table('site_surveys').get(survey.id))!.feasibility_status).toBe('pending');

    env.advance(5 * DAY + 3_600_000);
    expect(await tickClocks(env.deps)).toMatchObject({ breached: 1 });
    expect((await env.db.table('site_surveys').get(survey.id))!.feasibility_status).toBe('deemed');
    expect((await env.db.table('lead_events').all({ lead_id: lead.id })).map((e) => e.event_type)).toContain('feasibility_deemed');
    const notes = await env.db.table('notifications').all({ kind: 'survey.feasibility_deemed' });
    expect(notes.map((n) => n.user_id)).toContain(IDS.profile('dsm')); // the lead owner
    const clock = (await env.db.table('clocks').all({ clock_type: 'discom_feasibility' }))[0]!;
    expect(clock.status).toBe('breached'); // stays breached for KPIs …
    expect(clock.resolved_at).not.toBeNull(); // … but is resolved, so no further escalation
    env.advance(3 * DAY);
    expect(await tickClocks(env.deps)).toMatchObject({ escalated: 0 });
    expect((await env.as('dsm').get(`${API}/surveys/${survey.id}`)).body.data.feasibility.message).toMatch(/deemed feasible/);
  });

  it('without an active days-rule the countdown is advisory: no deemed status, and the response says so', async () => {
    const env = await makeEnv();
    await env.rule('discom.feasibility_study_exempt_up_to_kw', 10);
    await env.rule('discom.feasibility_study_days_above_10kw', 15, { is_active: false, status: 'unverified' });
    const lead = await seedLead(env, { capacity_kw: 25 });
    const survey = await scheduleSurvey(env, lead);
    const t = env.now().toISOString();
    const r = await env.as('dsm').patch(`${API}/surveys/${survey.id}/feasibility`).send({ submitted_at: t, complete_at: t });
    expect(r.body.data).toMatchObject({ deemed_enabled: false, days_source: 'fallback', days_allowed: 15 });
    expect(r.body.data.days_rule).toMatchObject({ active: false, status: 'unverified' });
    expect(r.body.data.message).toMatch(/Advisory/);
    expect(r.body.data.clock.status).toBe('running');

    env.advance(16 * DAY);
    await tickClocks(env.deps);
    expect((await env.db.table('site_surveys').get(survey.id))!.feasibility_status).toBe('pending'); // NOT deemed
    expect(await env.db.table('notifications').count({ kind: 'survey.feasibility_overdue' })).toBeGreaterThan(0);
    expect((await env.db.table('lead_events').all({ lead_id: lead.id })).map((e) => e.event_type)).toContain('feasibility_period_elapsed');
    expect((await reconcileDeemedSurveys(env.systemCtx())).deemed).toBe(0);
  });

  it('with no rules at all it falls back to 10 kW / advisory 15 days and says where the numbers came from', async () => {
    const env = await makeEnv();
    const lead = await seedLead(env, { capacity_kw: 25 });
    const survey = await scheduleSurvey(env, lead);
    const v = (await env.as('dsm').get(`${API}/surveys/${survey.id}`)).body.data.feasibility;
    expect(v).toMatchObject({ threshold_kw: 10, threshold_source: 'fallback', days_source: 'fallback', deemed_enabled: false, days_rule: null });
  });

  it('the DISCOM answer completes the clock; a rejection alerts the team; a re-filed application restarts it', async () => {
    const env = await makeEnv();
    await feasibilityRules(env);
    const lead = await seedLead(env, { capacity_kw: 25 });
    const survey = await scheduleSurvey(env, lead);
    const t = env.now().toISOString();
    await env.as('dsm').patch(`${API}/surveys/${survey.id}/feasibility`).send({ submitted_at: t, complete_at: t });
    env.advance(3 * DAY);
    const ok = await env.as('dsm').patch(`${API}/surveys/${survey.id}/feasibility`).send({ response: 'approved' });
    expect(ok.body.data.status).toBe('approved');
    expect((await env.db.table('clocks').all({ clock_type: 'discom_feasibility' }))[0]).toMatchObject({ status: 'met' });
    env.advance(20 * DAY);
    await tickClocks(env.deps);
    expect((await env.db.table('site_surveys').get(survey.id))!.feasibility_status).toBe('approved');

    const rej = await env.as('dsm').patch(`${API}/surveys/${survey.id}/feasibility`).send({ response: 'rejected', note: 'Transformer overloaded' });
    expect(rej.body.data.status).toBe('rejected');
    expect(await env.db.table('notifications').count({ kind: 'survey.feasibility_rejected' })).toBeGreaterThan(0);

    const again = new Date(env.now().getTime() - 3_600_000).toISOString();
    const refiled = await env.as('dsm').patch(`${API}/surveys/${survey.id}/feasibility`).send({ submitted_at: again, complete_at: again });
    expect(refiled.body.data.status).toBe('pending');
    expect(refiled.body.data.clock.status).toBe('running');
  });

  it('validates the dates and the capacity', async () => {
    const env = await makeEnv();
    await feasibilityRules(env);
    const lead = await seedLead(env, { capacity_kw: 25 });
    const survey = await scheduleSurvey(env, lead);
    const url = `${API}/surveys/${survey.id}/feasibility`;
    const now = env.now().getTime();
    const iso = (ms: number) => new Date(ms).toISOString();
    expect((await env.as('dsm').patch(url).send({})).status).toBe(422);
    expect((await env.as('dsm').patch(url).send({ complete_at: iso(now) })).body.error.details[0].path).toBe('submitted_at');
    expect((await env.as('dsm').patch(url).send({ submitted_at: iso(now - DAY), complete_at: iso(now - 2 * DAY) })).body.error.details[0].path).toBe('complete_at');
    expect((await env.as('dsm').patch(url).send({ submitted_at: iso(now + 3 * DAY) })).status).toBe(422);
    expect((await env.as('dsm').patch(url).send({ response: 'approved' })).status).toBe(422); // nothing submitted yet
    expect(await env.db.table('clocks').count()).toBe(0);

    const noKw = await seedLead(env, { name: 'No Capacity', capacity_kw: null });
    const s2 = await scheduleSurvey(env, noKw);
    expect(s2.feasibility_status).toBe('pending');
    const g = await env.as('dsm').patch(`${API}/surveys/${s2.id}/feasibility`).send({ submitted_at: iso(now) });
    expect(g.status).toBe(422);
    expect(g.body.error.code).toBe('GUARD_BLOCKED');
    expect((await env.as(IDS.distributorUserB).patch(url).send({ submitted_at: iso(now) })).status).toBe(403);
  });

  it('completing the visit re-evaluates whether a study is needed once the capacity is known', async () => {
    const env = await makeEnv();
    await feasibilityRules(env);
    const lead = await seedLead(env, { capacity_kw: null });
    const survey = await scheduleSurvey(env, lead);
    expect(survey.feasibility_status).toBe('pending');
    await env.db.table('leads').update(lead.id, { capacity_kw: 6 });
    const done = await env.as('dsm').patch(`${API}/surveys/${survey.id}`).send({ status: 'completed', shading: 'none', roof_type: 'rcc', roof_area_sqm: 30 });
    expect(done.body.data.feasibility_status).toBe('not_required');
  });

  it('the safety-net job deems overdue applications even if a clock tick was missed', async () => {
    const env = await makeEnv();
    await feasibilityRules(env);
    const lead = await seedLead(env, { capacity_kw: 25 });
    const survey = await scheduleSurvey(env, lead);
    const old = new Date(env.now().getTime() - 20 * DAY).toISOString();
    await env.as('dsm').patch(`${API}/surveys/${survey.id}/feasibility`).send({ submitted_at: old, complete_at: old });
    expect(await reconcileDeemedSurveys(env.systemCtx())).toMatchObject({ deemed: 1 });
    expect((await env.db.table('site_surveys').get(survey.id))!.feasibility_status).toBe('deemed');
    expect(await reconcileDeemedSurveys(env.systemCtx())).toMatchObject({ deemed: 0 });
  });
});
