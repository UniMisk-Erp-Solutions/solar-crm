import { describe, expect, it } from 'vitest';
import { registeredJobs } from '../../src/services/hooks';
import { sendSurveyReminders } from '../../src/services/surveyService';
import { IDS } from '../helpers/env';
import { API, completeBody, in2days, makeEnv, saveSite, scheduleSurvey, seedLead, seedLeadB } from './fixtures';

const HOUR = 3_600_000;

describe('POST /surveys — schedule a site visit', () => {
  it('schedules, assigns the surveyor, updates the lead and notifies the surveyor', async () => {
    const env = await makeEnv();
    const lead = await seedLead(env);
    const when = in2days(env);
    const r = await env.as('dsm').post(`${API}/surveys`).send({ lead_id: lead.id, scheduled_at: when, surveyor_id: IDS.profile('techno_commercial'), notes: 'Call before arriving' });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ status: 'scheduled', lead_id: lead.id, scheduled_at: when, photos: [], photo_count: 0, notes: 'Call before arriving' });
    expect(r.body.data.surveyor.id).toBe(IDS.profile('techno_commercial'));
    expect(r.body.data.lead).toMatchObject({ id: lead.id, name: 'Ramesh Patel', capacity_kw: 5 });
    expect(r.body.data.feasibility).toMatchObject({ status: 'not_required', required: false, kw: 5 });

    const after = (await env.db.table('leads').get(lead.id))!;
    expect(after).toMatchObject({ next_action: 'Site visit', next_followup_at: when, last_action: 'Site visit scheduled' });
    expect((await env.db.table('lead_events').all({ lead_id: lead.id })).map((e) => e.event_type)).toContain('survey_scheduled');
    const note = (await env.db.table('notifications').all({ user_id: IDS.profile('techno_commercial') }))[0]!;
    expect(note).toMatchObject({ kind: 'survey.scheduled', entity_type: 'survey', entity_id: r.body.data.id, link: `/leads/${lead.id}?tab=site` });
    expect((await env.db.table('audit_log').all()).some((a) => a.source === 'api' && a.action === 'survey.schedule')).toBe(true);
    expect((await env.as('dsm').get(`${API}/surveys/${r.body.data.id}`)).status).toBe(200);
  });

  it('defaults the surveyor to the caller and links an existing site', async () => {
    const env = await makeEnv();
    const lead = await seedLead(env);
    const { site } = await saveSite(env, lead);
    const r = await env.as('distributor_user').post(`${API}/surveys`).send({ lead_id: lead.id, scheduled_at: in2days(env) });
    expect(r.status).toBe(201);
    expect(r.body.data.surveyor_id).toBe(IDS.profile('distributor_user'));
    expect(r.body.data.site_id).toBe(site.id);
    expect(r.body.data.site.id).toBe(site.id);
  });

  it('refuses a second open visit, past dates, unsuitable lead statuses and unsuitable surveyors', async () => {
    const env = await makeEnv();
    const lead = await seedLead(env);
    await scheduleSurvey(env, lead);
    const dup = await env.as('dsm').post(`${API}/surveys`).send({ lead_id: lead.id, scheduled_at: in2days(env), surveyor_id: IDS.profile('dsm') });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('CONFLICT');

    const other = await seedLead(env, { name: 'Other Lead' });
    const past = await env.as('dsm').post(`${API}/surveys`).send({ lead_id: other.id, scheduled_at: new Date(env.now().getTime() - 3 * 24 * HOUR).toISOString(), surveyor_id: IDS.profile('dsm') });
    expect(past.status).toBe(422);
    expect(past.body.error.details[0].path).toBe('scheduled_at');

    const unaccepted = await seedLead(env, { status: 'assigned' });
    const st = await env.as('dsm').post(`${API}/surveys`).send({ lead_id: unaccepted.id, scheduled_at: in2days(env), surveyor_id: IDS.profile('dsm') });
    expect(st.status).toBe(409);
    expect(st.body.error.code).toBe('INVALID_STATE');

    const badSurveyor = await env.as('dsm').post(`${API}/surveys`).send({ lead_id: other.id, scheduled_at: in2days(env), surveyor_id: IDS.profile('accounts') });
    expect(badSurveyor.status).toBe(422);
    expect(badSurveyor.body.error.details[0].path).toBe('surveyor_id');
    const wrongParty = await env.as('distributor_user').post(`${API}/surveys`).send({ lead_id: other.id, scheduled_at: in2days(env), surveyor_id: IDS.distributorUserB });
    expect(wrongParty.status).toBe(422);
    expect((await env.as('dsm').post(`${API}/surveys`).send({ lead_id: other.id, scheduled_at: 'tomorrow' })).status).toBe(422);
  });

  it('keeps other distributors out and read-only roles out', async () => {
    const env = await makeEnv();
    const lead = await seedLead(env);
    const survey = await scheduleSurvey(env, lead);
    const asB = env.as(IDS.distributorUserB);
    expect((await asB.post(`${API}/surveys`).send({ lead_id: lead.id, scheduled_at: in2days(env) })).status).toBe(403);
    expect((await asB.get(`${API}/surveys/${survey.id}`)).status).toBe(403);
    expect((await asB.patch(`${API}/surveys/${survey.id}`).send({ notes: 'x' })).status).toBe(403);
    expect((await asB.get(`${API}/surveys`)).body.total).toBe(0);
    expect((await env.as('viewer').post(`${API}/surveys`).send({ lead_id: lead.id, scheduled_at: in2days(env) })).status).toBe(403);
    expect((await env.as('viewer').get(`${API}/surveys/${survey.id}`)).status).toBe(200);
  });
});

describe('PATCH /surveys/:id — complete, reschedule, cancel', () => {
  it('completing needs the findings, then moves the lead to site_visit', async () => {
    const env = await makeEnv();
    const lead = await seedLead(env);
    const { site } = await saveSite(env, lead);
    const survey = await scheduleSurvey(env, lead);

    const missing = await env.as('techno_commercial').patch(`${API}/surveys/${survey.id}`).send({ status: 'completed', shading: 'low' });
    expect(missing.status).toBe(422);
    expect(missing.body.error.details.map((d: { path: string }) => d.path)).toEqual(['roof_type', 'roof_area_sqm']);

    const done = await env.as('techno_commercial').patch(`${API}/surveys/${survey.id}`).send(completeBody);
    expect(done.status).toBe(200);
    expect(done.body.data).toMatchObject({ status: 'completed', shading: 'low', roof_type: 'rcc', roof_area_sqm: 42, sld_ref: 'SLD-001', surveyed_at: env.now().toISOString(), site_id: site.id });
    const after = (await env.db.table('leads').get(lead.id))!;
    expect(after).toMatchObject({ status: 'site_visit', last_action: 'Site visit completed', next_action: 'Share recommendation and discuss rate' });
    expect(after.next_followup_at).toBe(new Date(env.now().getTime() + 2 * 24 * HOUR).toISOString());
    expect((await env.db.table('sites').get(site.id))!.roof_type).toBe('rcc'); // mirrored onto the site
    expect((await env.db.table('lead_events').all({ lead_id: lead.id })).map((e) => e.event_type)).toEqual(expect.arrayContaining(['site_visit_completed', 'status_changed']));
    const owner = await env.db.table('notifications').all({ user_id: IDS.profile('dsm'), kind: 'survey.completed' });
    expect(owner).toHaveLength(1); // the lead owner is told the visit is done

    expect((await env.as('dsm').patch(`${API}/surveys/${survey.id}`).send({ status: 'scheduled' })).status).toBe(409);
    expect((await env.as('dsm').patch(`${API}/surveys/${survey.id}`).send({ notes: 'Revised note' })).body.data.notes).toBe('Revised note'); // findings stay editable
    expect((await env.as('dsm').patch(`${API}/surveys/${survey.id}`).send({ scheduled_at: in2days(env) })).status).toBe(409);
  });

  it('does not pull an opportunity back to site_visit', async () => {
    const env = await makeEnv();
    const lead = await seedLead(env, { status: 'opportunity' });
    const survey = await scheduleSurvey(env, lead);
    await env.as('dsm').patch(`${API}/surveys/${survey.id}`).send(completeBody);
    expect((await env.db.table('leads').get(lead.id))!.status).toBe('opportunity');
  });

  it('reschedules a scheduled visit and tells the surveyor', async () => {
    const env = await makeEnv();
    const lead = await seedLead(env);
    const survey = await scheduleSurvey(env, lead);
    const to = new Date(env.now().getTime() + 5 * 24 * HOUR).toISOString();
    const r = await env.as('dsm').patch(`${API}/surveys/${survey.id}`).send({ scheduled_at: to });
    expect(r.body.data.scheduled_at).toBe(to);
    expect((await env.db.table('leads').get(lead.id))!.next_followup_at).toBe(to);
    expect((await env.db.table('lead_events').all({ lead_id: lead.id })).map((e) => e.event_type)).toContain('survey_rescheduled');
    expect((await env.db.table('notifications').all({ user_id: IDS.profile('techno_commercial'), kind: 'survey.rescheduled' }))).toHaveLength(1);
    const reassigned = await env.as('dsm').patch(`${API}/surveys/${survey.id}`).send({ surveyor_id: IDS.profile('sales_manager') });
    expect(reassigned.body.data.surveyor_id).toBe(IDS.profile('sales_manager'));
    expect((await env.as('dsm').patch(`${API}/surveys/${survey.id}`).send({})).status).toBe(422);
    expect((await env.as('dsm').patch(`${API}/surveys/${survey.id}`).send({ surveyor_id: null })).status).toBe(422);
  });

  it('cancels with a reason and then allows a new visit', async () => {
    const env = await makeEnv();
    const lead = await seedLead(env);
    const survey = await scheduleSurvey(env, lead);
    expect((await env.as('dsm').patch(`${API}/surveys/${survey.id}`).send({ status: 'cancelled' })).body.error.details[0].path).toBe('cancel_reason');
    const c = await env.as('dsm').patch(`${API}/surveys/${survey.id}`).send({ status: 'cancelled', cancel_reason: 'Customer travelling' });
    expect(c.body.data.status).toBe('cancelled');
    expect(c.body.data.notes).toContain('Cancelled: Customer travelling');
    expect((await env.db.table('leads').get(lead.id))!.next_action).toBe('Reschedule site visit');
    expect((await env.as('dsm').patch(`${API}/surveys/${survey.id}`).send({ notes: 'again' })).status).toBe(409);
    const next = await scheduleSurvey(env, lead);
    expect(next.id).not.toBe(survey.id);
  });
});

describe('GET /surveys', () => {
  it('filters and scopes the list', async () => {
    const env = await makeEnv();
    const a = await seedLead(env);
    const b = await seedLeadB(env);
    const sa = await scheduleSurvey(env, a);
    const sb = await scheduleSurvey(env, b);
    await env.as('dsm').patch(`${API}/surveys/${sb.id}`).send(completeBody);

    const all = await env.as('admin').get(`${API}/surveys`);
    expect(all.body.total).toBe(2);
    expect(all.body.data[0]).toHaveProperty('lead_name');
    expect((await env.as('admin').get(`${API}/surveys?status=completed`)).body.data.map((s: { id: string }) => s.id)).toEqual([sb.id]);
    expect((await env.as('admin').get(`${API}/surveys?lead_id=${a.id}`)).body.data.map((s: { id: string }) => s.id)).toEqual([sa.id]);
    expect((await env.as('techno_commercial').get(`${API}/surveys?mine=true`)).body.total).toBe(2);
    expect((await env.as('dsm').get(`${API}/surveys?mine=true`)).body.total).toBe(0);
    const from = new Date(env.now().getTime() + 3 * 24 * HOUR).toISOString();
    expect((await env.as('admin').get(`${API}/surveys?scheduled_from=${encodeURIComponent(from)}`)).body.total).toBe(0);
    expect((await env.as('admin').get(`${API}/surveys?scheduled_from=garbage`)).status).toBe(422);
    const own = await env.as('distributor_user').get(`${API}/surveys`);
    expect(own.body.data.map((s: { id: string }) => s.id)).toEqual([sa.id]);
    expect((await env.as('distributor_user').get(`${API}/surveys?lead_id=${b.id}`)).body.total).toBe(0);
  });
});

describe('reminders before the visit', () => {
  it('sends one reminder per level, never twice, and skips cancelled visits', async () => {
    const env = await makeEnv();
    const lead = await seedLead(env);
    const survey = await scheduleSurvey(env, lead, { scheduled_at: new Date(env.now().getTime() + 23 * HOUR).toISOString() });
    const sys = env.systemCtx();
    expect(await sendSurveyReminders(sys)).toEqual({ scanned: 1, sent: 1 });
    const first = await env.db.table('notifications').all({ user_id: IDS.profile('techno_commercial'), kind: 'survey.reminder.24' });
    expect(first).toHaveLength(1);
    expect(first[0]!.title).toMatch(/^Site visit in 23 h/);
    expect(await sendSurveyReminders(sys)).toEqual({ scanned: 1, sent: 0 }); // already sent

    env.advance(21 * HOUR + 30 * 60_000); // 1 h 30 min before the visit
    expect(await sendSurveyReminders(env.systemCtx())).toMatchObject({ sent: 1 });
    expect(await env.db.table('notifications').count({ kind: 'survey.reminder.2' })).toBe(1);
    expect(await sendSurveyReminders(env.systemCtx())).toMatchObject({ sent: 0 });

    // a rescheduled visit is reminded afresh; a cancelled one is not
    const to = new Date(env.now().getTime() + 90 * 60_000).toISOString();
    await env.as('dsm').patch(`${API}/surveys/${survey.id}`).send({ scheduled_at: to });
    await env.as('dsm').patch(`${API}/surveys/${survey.id}`).send({ status: 'cancelled', cancel_reason: 'Rain' });
    expect(await sendSurveyReminders(env.systemCtx())).toMatchObject({ scanned: 0, sent: 0 });
  });

  it('a visit booked at short notice gets only the most relevant reminder', async () => {
    const env = await makeEnv();
    const lead = await seedLead(env);
    await scheduleSurvey(env, lead, { scheduled_at: new Date(env.now().getTime() + 90 * 60_000).toISOString() });
    expect(await sendSurveyReminders(env.systemCtx())).toMatchObject({ sent: 1 });
    expect(await env.db.table('notifications').count({ kind: 'survey.reminder.2' })).toBe(1);
    expect(await env.db.table('notifications').count({ kind: 'survey.reminder.24' })).toBe(0);
    const events = (await env.db.table('lead_events').all({ lead_id: lead.id, event_type: 'survey_reminder' })).map((e) => e.detail as { hours: number; notified: boolean });
    expect(events.map((e) => [e.hours, e.notified]).sort()).toEqual([[2, true], [24, false]]);
  });

  it('honours the reminder rule and is registered as a scheduled job', async () => {
    const env = await makeEnv();
    await env.rule('survey.reminder_hours_before', [48]);
    const lead = await seedLead(env);
    await scheduleSurvey(env, lead, { scheduled_at: new Date(env.now().getTime() + 40 * HOUR).toISOString() });
    await sendSurveyReminders(env.systemCtx());
    expect(await env.db.table('notifications').count({ kind: 'survey.reminder.48' })).toBe(1);
    expect(registeredJobs().map((j) => j.name)).toEqual(expect.arrayContaining(['site_survey_reminders', 'survey_feasibility_reconcile']));
  });
});
