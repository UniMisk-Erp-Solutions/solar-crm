import { describe, expect, it } from 'vitest';
import type { Lead } from '@solar/shared';
import { tickClocks } from '../../src/services/clockService';
import { registeredJobs } from '../../src/services/hooks';
import '../../src/services/leadService';
import { API, IDS, leadEnv, person, type LeadEnv } from './helpers';

const MIN = 60_000;
const DAY = 86_400_000;
async function newLead(env: LeadEnv, over: Record<string, unknown> = {}) {
  return (await env.capture(person(over))).body.data.lead_id as string;
}
const dist = (env: LeadEnv) => env.u('distributor_user');
const types = async (env: LeadEnv, id: string) => (await env.db.table('lead_events').all({ lead_id: id })).map((e) => e.event_type);
/** The four mandatory fields must be non-empty on every lead. */
function expectMandatory(l: Lead) {
  expect(l.last_action, 'last_action').toBeTruthy();
  expect(l.next_action, 'next_action').toBeTruthy();
  expect(l.next_followup_at, 'next_followup_at').toBeTruthy();
  expect(l.owner_id, 'owner_id').toBeTruthy();
}
const inHours = (env: LeadEnv, h: number) => new Date(env.now().getTime() + h * 3600_000).toISOString();

describe('initial contact (step 8)', () => {
  it('logging a contact accepts an assigned lead, sets first_contacted_at once and moves a connected lead to Contacted', async () => {
    const env = leadEnv();
    const id = await newLead(env);
    env.advance(10 * MIN);
    const r = await dist(env).post(`${API}/leads/${id}/contacts`).send({ channel: 'call', outcome: 'connected_interested', notes: 'Wants a site visit', duration_min: 6 });
    expect(r.status).toBe(201);
    expect(r.body.data.contact).toMatchObject({ channel: 'call', direction: 'outbound', outcome: 'connected_interested', logged_by: IDS.profile('distributor_user') });
    const lead = await env.lead(id);
    expect(lead.status).toBe('contacted');
    expect(lead.first_contacted_at).toBe(env.now().toISOString());
    expect(lead.last_action).toBe('Call — Connected — interested');
    expect(lead.next_action).toMatch(/Qualification call/);
    expectMandatory(lead);
    expect(await types(env, id)).toEqual(expect.arrayContaining(['accepted', 'contact_logged']));
    expect((await env.db.table('lead_events').all({ lead_id: id, event_type: 'contact_logged' }))[0]!.detail).toMatchObject({ first_response: true, response_minutes: 10 });

    env.advance(60 * MIN);
    await dist(env).post(`${API}/leads/${id}/contacts`).send({ channel: 'whatsapp', outcome: 'message_replied' });
    expect((await env.lead(id)).first_contacted_at).toBe(new Date(env.now().getTime() - 60 * MIN).toISOString()); // set once
    expect((await dist(env).get(`${API}/leads/${id}/contacts`)).body.data).toHaveLength(2);
  });

  it('an unanswered call is a first response but does not make the lead Contacted; a retry is planned', async () => {
    const env = leadEnv();
    const id = await newLead(env);
    await dist(env).post(`${API}/leads/${id}/contacts`).send({ channel: 'call', outcome: 'no_answer' });
    const lead = await env.lead(id);
    expect(lead.status).toBe('accepted');
    expect(lead.first_contacted_at).not.toBeNull();
    expect(lead.next_action).toMatch(/Call again/);
    expect(lead.next_followup_at).toBe(new Date(env.now().getTime() + 240 * MIN).toISOString()); // followup.retry_minutes default
  });

  it('validation: outcome from the picklist; contact times cannot be in the future; unrouted leads cannot be worked', async () => {
    const env = leadEnv();
    const id = await newLead(env);
    expect((await dist(env).post(`${API}/leads/${id}/contacts`).send({ channel: 'call', outcome: 'made_up' })).status).toBe(422);
    expect((await dist(env).post(`${API}/leads/${id}/contacts`).send({ channel: 'call', outcome: 'no_answer', occurred_at: inHours(env, 3) })).status).toBe(422);
    const dup = await newLead(env);
    expect((await env.u('admin').post(`${API}/leads/${dup}/contacts`).send({ channel: 'call', outcome: 'no_answer' })).status).toBe(409);
  });

  it('a logged contact fulfils the follow-up that was due', async () => {
    const env = leadEnv();
    const id = await newLead(env);
    await dist(env).post(`${API}/leads/${id}/accept`).send({});
    const planned = (await env.db.table('followups').all({ lead_id: id, status: 'open' }))[0]!;
    env.advance(3 * DAY - 5 * MIN); // warm → the first follow-up is 3 days out
    await dist(env).post(`${API}/leads/${id}/contacts`).send({ channel: 'call', outcome: 'connected_not_now' });
    expect((await env.db.table('followups').get(planned.id))).toMatchObject({ status: 'done', outcome: 'Connected — not now' });
    expect((await env.db.table('clocks').all({ entity_id: id, clock_type: 'followup' })).find((c) => (c.meta as { followup_id: string }).followup_id === planned.id)).toMatchObject({ status: 'met' });
    expect(await env.db.table('followups').count({ lead_id: id, status: 'open' })).toBe(1);
  });
});

describe('mandatory fields on every save: Last Action, Next Action, Next Follow-up Date, Owner', () => {
  it('are filled automatically on every way a lead is created or routed', async () => {
    const env = leadEnv();
    expectMandatory(await env.lead(await newLead(env)));
    expectMandatory(await env.lead(await newLead(env))); // duplicate
    await env.db.table('distributors').updateWhere({}, { status: 'inactive' });
    expectMandatory(await env.lead(await newLead(env, { mobile: '9123456789', name: 'Meera Shah', email: 'm@x.in' }))); // unassigned
    for (const who of ['dsm', 'distributor_user', 'dealer_user'] as const) {
      const r = await env.u(who).post(`${API}/leads`).send({ name: `Manual ${who}`, mobile: { dsm: '9800010000', distributor_user: '9800020000', dealer_user: '9800030000' }[who], pincode: '395003' });
      expect(r.status, who).toBe(201);
      expectMandatory(await env.lead(r.body.data.lead.id));
    }
  });

  it('PATCH cannot blank any of the four fields (422 with per-field details)', async () => {
    const env = leadEnv();
    const id = await newLead(env);
    for (const [field, value] of [['next_action', ''], ['next_action', null], ['last_action', '   '], ['next_followup_at', null], ['owner_id', null]] as const) {
      const r = await env.u('dsm').patch(`${API}/leads/${id}`).send({ [field]: value });
      expect(r.status, `${field}=${String(value)}`).toBe(422);
      expect(r.body.error.details).toEqual(expect.arrayContaining([expect.objectContaining({ path: field })]));
    }
    expect(await env.lead(id)).toMatchObject({ next_action: 'Accept the lead and contact the customer' });
  });

  it('a legacy lead missing the fields cannot be saved until they are supplied', async () => {
    const env = leadEnv();
    const id = await newLead(env);
    await env.db.table('leads').update(id, { next_action: null, last_action: null });
    const bad = await env.u('dsm').patch(`${API}/leads/${id}`).send({ notes: 'called twice' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual(['last_action', 'next_action']);
    const ok = await env.u('dsm').patch(`${API}/leads/${id}`).send({ notes: 'called twice', last_action: 'Called', next_action: 'Send quote' });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ last_action: 'Called', next_action: 'Send quote', notes: 'called twice' });
  });

  it('an update that keeps them is fine and is logged; the owner can be changed to an active user only', async () => {
    const env = leadEnv();
    const id = await newLead(env);
    const r = await env.u('dsm').patch(`${API}/leads/${id}`).send({ city: 'Gandhinagar', owner_id: IDS.profile('dsm') });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ city: 'Gandhinagar', owner_id: IDS.profile('dsm'), owner_name: 'Test dsm' });
    expect(await types(env, id)).toContain('updated');
    expect(await env.db.table('audit_log').count({ action: 'lead.update', record_id: id })).toBe(1);
    expect((await env.u('dsm').patch(`${API}/leads/${id}`).send({ owner_id: seedUnknown() })).status).toBe(422);
    expect((await env.u('dsm').patch(`${API}/leads/${id}`).send({})).status).toBe(422);
    // mobile is the identity of the lead: it cannot be patched
    await env.u('dsm').patch(`${API}/leads/${id}`).send({ mobile: '9000000000', name: 'Asha P Patel' });
    expect((await env.lead(id)).mobile).toBe('+919876543210');
  });
});
const seedUnknown = () => '11111111-1111-4111-8111-111111111111';

describe('follow-up engine (steps 12–13)', () => {
  it('rescheduling next_followup_at moves the follow-up and its clock; dates must be sensible', async () => {
    const env = leadEnv();
    const id = await newLead(env);
    await dist(env).post(`${API}/leads/${id}/accept`).send({});
    const when = inHours(env, 50);
    const r = await dist(env).patch(`${API}/leads/${id}`).send({ next_followup_at: when, next_action: 'Call after the weekend' });
    expect(r.status).toBe(200);
    const lead = await env.lead(id);
    expect(lead).toMatchObject({ next_followup_at: when, next_action: 'Call after the weekend' });
    const open = await env.db.table('followups').all({ lead_id: id, status: 'open' });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ due_at: when, note: 'Call after the weekend' });
    const running = (await env.db.table('clocks').all({ entity_id: id, clock_type: 'followup', resolved_at: null }));
    expect(running).toHaveLength(1);
    expect(running[0]!.due_at).toBe(when);
    expect((await dist(env).patch(`${API}/leads/${id}`).send({ next_followup_at: inHours(env, -48) })).status).toBe(422);
    expect((await dist(env).patch(`${API}/leads/${id}`).send({ next_followup_at: inHours(env, 24 * 400) })).status).toBe(422);
  });

  it('POST /followups adds a follow-up; the lead shows the earliest one', async () => {
    const env = leadEnv();
    const id = await newLead(env);
    await dist(env).post(`${API}/leads/${id}/accept`).send({});
    const later = await dist(env).post(`${API}/leads/${id}/followups`).send({ kind: 'visit', due_at: inHours(env, 100), note: 'Site visit' });
    expect(later.status).toBe(201);
    expect((await env.lead(id)).next_action).not.toBe('Site visit');
    const sooner = await dist(env).post(`${API}/leads/${id}/followups`).send({ kind: 'whatsapp', due_at: inHours(env, 2), note: 'Send brochure' });
    expect(sooner.body.data.lead).toMatchObject({ next_action: 'Send brochure', next_followup_at: inHours(env, 2) });
    expect((await dist(env).get(`${API}/leads/${id}/followups`)).body.data).toHaveLength(3);
    expect((await dist(env).post(`${API}/leads/${id}/followups`).send({ kind: 'call', due_at: inHours(env, 2) })).status).toBe(422);
  });

  it('completing a follow-up requires the next action and date and plans the next one', async () => {
    const env = leadEnv();
    const id = await newLead(env);
    await dist(env).post(`${API}/leads/${id}/accept`).send({});
    const fu = (await env.db.table('followups').all({ lead_id: id, status: 'open' }))[0]!;
    expect((await dist(env).post(`${API}/followups/${fu.id}/complete`).send({ outcome: 'Spoke to customer' })).status).toBe(422);
    expect((await dist(env).post(`${API}/followups/${fu.id}/complete`).send({ outcome: 'Spoke', next_action: 'Send quote', next_followup_at: inHours(env, -5) })).status).toBe(422);
    const next = inHours(env, 30);
    const r = await dist(env).post(`${API}/followups/${fu.id}/complete`).send({ outcome: 'Spoke to customer, wants a quote', next_action: 'Send a quote', next_followup_at: next, next_kind: 'email' });
    expect(r.status).toBe(200);
    expect(r.body.data.followup).toMatchObject({ status: 'done', outcome: 'Spoke to customer, wants a quote' });
    expect(r.body.data.followup.done_at).toBe(env.now().toISOString());
    expect(r.body.data.next).toMatchObject({ kind: 'email', due_at: next, note: 'Send a quote', status: 'open' });
    expect(r.body.data.lead).toMatchObject({ next_action: 'Send a quote', next_followup_at: next });
    expect((await env.lead(id)).last_action).toBe('Follow-up done: Spoke to customer, wants a quote');
    expect((await dist(env).post(`${API}/followups/${fu.id}/complete`).send({ outcome: 'again', next_action: 'x1', next_followup_at: next })).status).toBe(409);
    expect((await env.u(IDS.distributorUserB).post(`${API}/followups/${fu.id}/complete`).send({ outcome: 'steal it', next_action: 'x1', next_followup_at: next })).status).toBe(403);
  });

  it('reminder at 70 %, then a miss: follow-up marked missed, owner reminded, escalated up the chain; late completion resolves it', async () => {
    const env = leadEnv();
    await env.rule('sla.escalation_step_minutes', 60);
    const id = await newLead(env);
    await dist(env).post(`${API}/leads/${id}/accept`).send({});
    const fu = (await env.db.table('followups').all({ lead_id: id, status: 'open' }))[0]!;
    const total = new Date(fu.due_at).getTime() - env.now().getTime(); // one day

    env.advance(total * 0.75);
    expect(await tickClocks(env.deps)).toMatchObject({ warned: 1 });
    expect(await env.db.table('notifications').count({ kind: 'followup.reminder', user_id: IDS.profile('distributor_user') })).toBe(1);
    expect(env.providers.calls.email.some((m) => m.to === 'distributor_user@test.local' && /Follow-up due soon/.test(m.subject))).toBe(true);
    expect((await env.db.table('followups').get(fu.id))!.reminder_sent_at).not.toBeNull();

    env.advance(total * 0.3);
    expect(await tickClocks(env.deps)).toMatchObject({ breached: 1 });
    expect(await env.db.table('followups').get(fu.id)).toMatchObject({ status: 'missed', escalated_level: 1 });
    expect(await env.db.table('notifications').count({ kind: 'followup.missed', user_id: IDS.profile('distributor_user') })).toBe(1);
    expect(await env.db.table('notifications').count({ kind: 'clock.followup.breach', user_id: IDS.profile('dsm') })).toBe(1);
    expect(await types(env, id)).toContain('followup_missed');
    const listed = await env.u('dsm').get(`${API}/leads?followup_overdue=true`);
    expect(listed.body.data.map((l: { id: string }) => l.id)).toContain(id);
    expect(listed.body.data[0]).toMatchObject({ followup_overdue: true, sla_state: 'breached' });

    env.advance(1441 * MIN); // escalation step = half the allowed time, capped at one day
    await tickClocks(env.deps);
    expect(await env.db.table('notifications').count({ kind: 'clock.followup.level2', user_id: IDS.profile('sales_manager') })).toBe(1);
    expect((await env.db.table('followups').get(fu.id))!.escalated_level).toBe(2);
    env.advance(1441 * MIN);
    await tickClocks(env.deps);
    expect(await env.db.table('notifications').count({ kind: 'clock.followup.level3', user_id: IDS.profile('management') })).toBe(1);

    const done = await dist(env).post(`${API}/followups/${fu.id}/complete`).send({ outcome: 'Reached the customer late', next_action: 'Send quote', next_followup_at: inHours(env, 24) });
    expect(done.status).toBe(200);
    const clock = (await env.db.table('clocks').all({ entity_id: id, clock_type: 'followup' })).find((c) => (c.meta as { followup_id: string }).followup_id === fu.id)!;
    expect(clock).toMatchObject({ status: 'breached' }); // recorded as late for the compliance KPI
    expect(clock.resolved_at).not.toBeNull();
    expect((await env.db.table('followups').get(fu.id))).toMatchObject({ status: 'done' });
  });

  it('GET /followups: my work-list by bucket, team scope, and the lead summary', async () => {
    const env = leadEnv();
    await env.db.table('distributors').update(IDS.distributorB, { status: 'inactive' });
    const a = await newLead(env);
    const b = await newLead(env, { name: 'Meera Shah', mobile: '9123456789', email: 'm@x.in' });
    await dist(env).post(`${API}/leads/${a}/accept`).send({});
    await dist(env).post(`${API}/leads/${b}/accept`).send({});
    await dist(env).post(`${API}/leads/${a}/followups`).send({ due_at: inHours(env, 2), note: 'Today call' });
    await dist(env).post(`${API}/leads/${b}/followups`).send({ due_at: inHours(env, 120), note: 'Later' });
    const buckets = async (bucket: string, who = 'distributor_user') => (await env.u(who).get(`${API}/followups?bucket=${bucket}`)).body;
    expect((await buckets('due_today')).data.map((f: { note: string }) => f.note)).toEqual(['Today call']);
    expect((await buckets('upcoming')).data.map((f: { note: string }) => f.note)).toEqual(expect.arrayContaining(['Later', 'Make the initial contact with the customer']));
    expect((await buckets('overdue')).total).toBe(0);
    env.advance(4 * DAY);
    const overdue = await buckets('overdue');
    expect(overdue.total).toBe(3); // a: today’s call and the first contact, b: the first contact
    expect(overdue.data[0]).toMatchObject({ overdue: true, lead_name: expect.any(String) });
    expect(overdue.data[0].lead_mobile).toContain('+91'); // distributors may see numbers
    expect((await buckets('overdue', 'management')).total).toBe(0); // nothing is owned by management…
    expect((await env.u('management').get(`${API}/followups?bucket=overdue&scope=team`)).body.data[0].lead_mobile).toContain('•••'); // …and management sees masked numbers
    const team = await env.u('dsm').get(`${API}/followups?bucket=overdue&scope=team`);
    expect(team.body.total).toBe(overdue.total); // …but the DSM sees the team
    expect((await env.u(IDS.distributorUserB).get(`${API}/followups?scope=team`)).body.total).toBe(0);
  });
});

describe('nurture, lost (the “not a real opportunity” branch)', () => {
  it('nurture parks the lead until a date; a nightly job re-activates it to Contacted and tells the owner', async () => {
    const env = leadEnv();
    const id = await newLead(env);
    await dist(env).post(`${API}/leads/${id}/contacts`).send({ channel: 'call', outcome: 'connected_not_now' });
    expect((await dist(env).post(`${API}/leads/${id}/nurture`).send({ reason: 'Wants to wait', nurture_until: '2026-10-26' })).status).toBe(422); // not in the future
    expect((await dist(env).post(`${API}/leads/${id}/nurture`).send({ reason: 'x', nurture_until: '2026-12-01' })).status).toBe(422);
    const r = await dist(env).post(`${API}/leads/${id}/nurture`).send({ reason: 'Wants to wait until after Diwali', nurture_until: '2026-11-15' });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ status: 'nurture', nurture_until: '2026-11-15', nurture_reason: 'Wants to wait until after Diwali' });
    const lead = await env.lead(id);
    expect(lead.next_followup_at).toBe('2026-11-15T04:30:00.000Z'); // 10:00 IST on the day
    expect(lead.next_action).toMatch(/Re-engage/);
    expectMandatory(lead);
    expect(await env.db.table('followups').count({ lead_id: id, status: 'open' })).toBe(1);

    const job = registeredJobs().find((j) => j.name === 'lead.nurture_reactivation')!;
    expect(job).toBeDefined();
    expect(await job.run(env.systemCtx())).toMatchObject({ due: 0, reactivated: 0 }); // too early
    env.setNow(new Date('2026-11-15T21:00:00Z')); // 02:30 IST on the 16th
    expect(await job.run(env.systemCtx())).toMatchObject({ due: 1, reactivated: 1 });
    const back = await env.lead(id);
    expect(back).toMatchObject({ status: 'contacted', nurture_until: null, nurture_reason: null });
    expect(back.next_action).toMatch(/Re-engage/);
    expectMandatory(back);
    expect(await env.db.table('notifications').count({ kind: 'lead.nurture_due', user_id: back.owner_id! })).toBe(1);
    expect(await types(env, id)).toEqual(expect.arrayContaining(['nurture', 'nurture_reactivated']));
    expect(await job.run(env.systemCtx())).toMatchObject({ due: 0 }); // idempotent
  });

  it('only worked leads can go to nurture; a lost lead can be recycled', async () => {
    const env = leadEnv();
    const id = await newLead(env);
    expect((await dist(env).post(`${API}/leads/${id}/nurture`).send({ reason: 'later', nurture_until: '2026-12-01' })).status).toBe(409); // still awaiting acceptance
    await dist(env).post(`${API}/leads/${id}/accept`).send({});
    const lost = await dist(env).post(`${API}/leads/${id}/lost`).send({ reason: 'Bought elsewhere' });
    expect(lost.status).toBe(200);
    expect(lost.body.data).toMatchObject({ status: 'lost', lost_reason: 'Bought elsewhere', lock_status: 'open' });
    expectMandatory(await env.lead(id));
    expect(await env.db.table('followups').count({ lead_id: id, status: 'open' })).toBe(0);
    expect(await env.db.table('clocks').count({ entity_id: id, resolved_at: null })).toBe(0);
    expect((await dist(env).post(`${API}/leads/${id}/lost`).send({ reason: 'again' })).status).toBe(409);
    const recycled = await dist(env).post(`${API}/leads/${id}/nurture`).send({ reason: 'Customer called back', nurture_until: '2026-12-01' });
    expect(recycled.body.data).toMatchObject({ status: 'nurture', lost_reason: null });
  });
});

describe('privacy: masking and audited unmask', () => {
  it('lists and details mask the number for roles without a need; unmask is a separate, audited action', async () => {
    const env = leadEnv();
    const id = await newLead(env);
    const list = await env.u('management').get(`${API}/leads`);
    expect(list.body.data[0].mobile).toBe('+91 ••••• ••210');
    expect(list.body.data[0].email).not.toContain('asha@');
    const detail = await env.u('management').get(`${API}/leads/${id}`);
    expect(detail.body.data.lead.mobile).toBe('+91 ••••• ••210');
    expect((await dist(env).get(`${API}/leads/${id}`)).body.data.lead.mobile).toBe('+919876543210');

    expect((await env.u('management').post(`${API}/leads/${id}/unmask`).send({})).status).toBe(422); // a reason is required
    const un = await env.u('management').post(`${API}/leads/${id}/unmask`).send({ reason: 'Escalated complaint call' });
    expect(un.status).toBe(200);
    expect(un.body.data).toEqual({ mobile: '+919876543210', email: 'asha@example.com' });
    const audit = (await env.db.table('audit_log').all({ action: 'mobile.unmask', record_id: id }))[0]!;
    expect(audit).toMatchObject({ actor_id: IDS.profile('management'), source: 'api' });
    expect(audit.detail).toMatchObject({ reason: 'Escalated complaint call' });
    expect(JSON.stringify(audit)).not.toContain('9876543210');
    expect(await types(env, id)).toContain('mobile_unmasked');
    expect((await env.u('viewer').post(`${API}/leads/${id}/unmask`).send({ reason: 'curious' })).status).toBe(403);
    expect((await env.u(IDS.distributorUserB).post(`${API}/leads/${id}/unmask`).send({ reason: 'curious' })).status).toBe(403);
  });
});

describe('lead API — list, kanban, detail, timeline, manual create', () => {
  it('filters by status, source, segment, temperature, owner, distributor, territory, SLA state, search; sorts and paginates', async () => {
    const env = leadEnv();
    await env.rule('sla.escalation_step_minutes', 60);
    await env.db.table('distributors').update(IDS.distributorB, { status: 'inactive' }); // everything routes to A
    const a = await newLead(env);
    const b = await newLead(env, { name: 'Meera Shah', mobile: '9123456789', email: 'm@x.in', pincode: '395003', segment: 'ci_captive' });
    await dist(env).post(`${API}/leads/${a}/accept`).send({});
    const get = async (qs: string, who = 'admin') => (await env.u(who).get(`${API}/leads?${qs}`)).body;
    expect((await get('')).total).toBe(2);
    expect((await get('status=accepted')).data.map((l: { id: string }) => l.id)).toEqual([a]);
    expect((await get('status=accepted,assigned')).total).toBe(2);
    expect((await get('source=website')).total).toBe(2);
    expect((await get('source=referral')).total).toBe(0);
    expect((await get('segment=ci_captive')).data[0].id).toBe(b);
    expect((await get('temperature=warm')).total).toBe(2);
    expect((await get(`owner_id=${IDS.profile('distributor_user')}`)).total).toBe(2);
    expect((await get(`distributor_id=${IDS.distributorA}`)).total).toBe(2);
    expect((await get(`territory_id=${IDS.territorySurat}`)).data[0].id).toBe(b);
    expect((await get('q=meera')).data[0].id).toBe(b);
    expect((await get('q=380001')).data[0].id).toBe(a);
    expect((await get('sort=name&order=asc')).data.map((l: { name: string }) => l.name)).toEqual(['Asha Patel', 'Meera Shah']);
    expect((await get('limit=1&offset=1&sort=name&order=asc')).data[0].name).toBe('Meera Shah');
    expect((await get('limit=1')).total).toBe(2);
    expect((await get('sla_state=ok')).total).toBe(2);
    expect((await get('sla_state=breached')).total).toBe(0);
    env.advance(130 * MIN);
    await tickClocks(env.deps);
    expect((await get('sla_state=breached')).data.map((l: { id: string }) => l.id)).toEqual([b]); // b was never accepted; a's follow-up is a day away
    expect((await get('sla_state=ok')).data.map((l: { id: string }) => l.id)).toEqual([a]);
    expect((await get('sla_state=breached')).data[0]).toMatchObject({ sla_state: 'breached', distributor_name: 'Alpha Solar Distributors', owner_name: 'Test distributor_user' });
    expect((await get('', IDS.distributorUserB)).total).toBe(0);
    expect((await get('', 'dealer_user')).total).toBe(0);
  });

  it('?view=kanban groups by status in the board column order with counts and items', async () => {
    const env = leadEnv();
    await env.db.table('distributors').update(IDS.distributorB, { status: 'inactive' });
    const a = await newLead(env);
    await newLead(env, { name: 'Meera Shah', mobile: '9123456789', email: 'm@x.in', pincode: '395003' });
    await newLead(env, { name: 'Raj Soni', mobile: '9123456780', email: 'r@x.in', pincode: '390001' }); // unassigned
    await dist(env).post(`${API}/leads/${a}/accept`).send({});
    const res = await env.u('admin').get(`${API}/leads?view=kanban&per_column=1`);
    expect(res.status).toBe(200);
    const cols = res.body.data.columns as { status: string; label: string; count: number; items: { id: string }[] }[];
    expect(cols.map((c) => c.status)).toEqual(['new', 'unassigned', 'assigned', 'accepted', 'contacted', 'qualified', 'site_visit', 'nurture']);
    expect(Object.fromEntries(cols.map((c) => [c.status, c.count]))).toMatchObject({ unassigned: 1, assigned: 1, accepted: 1, contacted: 0 });
    expect(cols.find((c) => c.status === 'accepted')!.items[0]!.id).toBe(a);
    expect(cols.find((c) => c.label === 'Needs assignment')!.items).toHaveLength(1);
    expect(res.body.data.total).toBe(3);
    // a distributor user's board only holds their own leads, and filters apply
    const mine = await dist(env).get(`${API}/leads?view=kanban`);
    expect(mine.body.data.total).toBe(2);
    expect((await env.u('admin').get(`${API}/leads?view=kanban&segment=ci_captive`)).body.data.total).toBe(0);
  });

  it('GET /leads/:id is fully hydrated, with next-best-action and conversion blockers', async () => {
    const env = leadEnv();
    const id = await newLead(env, { segment: undefined });
    const d = (await env.u('admin').get(`${API}/leads/${id}`)).body.data;
    expect(Object.keys(d)).toEqual(expect.arrayContaining(['lead', 'events', 'consents', 'consent_summary', 'assignments', 'followups', 'contact_logs', 'score', 'clocks', 'duplicates', 'customer_id', 'site_id', 'opportunity_ids', 'next_best_action', 'convert_blockers', 'can_convert', 'validation_hints']));
    expect(d.lead).toMatchObject({ distributor_name: 'Alpha Solar Distributors', territory_name: 'Ahmedabad', owner_name: 'Test distributor_user' });
    expect(d.clocks).toHaveLength(1);
    expect(d.next_best_action).toMatchObject({ code: 'accept', urgent: true });
    expect(d.validation_hints.map((h: { field: string }) => h.field)).toContain('segment');
    expect(d.convert_blockers.map((b: { code: string }) => b.code)).toEqual(expect.arrayContaining(['status_not_ready', 'segment_missing', 'timeline_unconfirmed', 'requirement_unconfirmed', 'commercial_potential_unconfirmed']));
    expect(d.can_convert).toBe(false);
    expect(d.consent_summary).toMatchObject({ has_active: true, suppressed: false, dnd_status: 'clear', dnd_fresh: true });
    expect(d.consent_summary.outbound.sms).toEqual({ promotional: true, service: true });

    await dist(env).post(`${API}/leads/${id}/qualification`).send({ requirement_text: 'Rooftop 5 kW for home use, bill ₹4000 a month', timeline_bucket: 'within_30_days', budget_inr: 250000, decision_maker: 'self', segment: 'pmsg_residential' });
    const q = (await env.u('admin').get(`${API}/leads/${id}`)).body.data;
    expect(q.convert_blockers).toEqual([]);
    expect(q.can_convert).toBe(true);
    expect(q.next_best_action.code).toBe('site_visit');
    expect(q.score.score).toBeGreaterThan(50);
    expect(q.first_response_minutes).toBe(0);
    expect(q.events.length).toBeGreaterThan(8);
  });

  it('external users get no ranking of other distributors and no matches from other parties', async () => {
    const env = leadEnv();
    const first = await newLead(env);
    const dup = await newLead(env, { name: 'Asha Patel' }); // duplicate, held by the DSM
    expect((await env.lead(dup)).status).toBe('duplicate');
    const d = (await dist(env).get(`${API}/leads/${first}`)).body.data;
    expect(JSON.stringify(d.events)).not.toContain('Beta Energy');
    expect(JSON.stringify(d.assignments)).not.toContain('candidates');
    expect(d.duplicates.leads).toEqual([]); // the duplicate belongs to nobody they can see
    expect(d.duplicates.hidden).toBe(1);
    const admin = (await env.u('admin').get(`${API}/leads/${first}`)).body.data;
    expect(admin.duplicates.leads).toHaveLength(1);
    expect(JSON.stringify(admin.events)).toContain('Beta Energy');
  });

  it('timeline merges events, contacts, messages and follow-ups, newest first, paginated', async () => {
    const env = leadEnv();
    const id = await newLead(env);
    await dist(env).post(`${API}/leads/${id}/contacts`).send({ channel: 'call', outcome: 'connected_interested', notes: 'ok' });
    await env.u('admin').post(`${API}/leads/${id}/messages`).send({ channel: 'call', purpose: 'service' });
    const t = await dist(env).get(`${API}/leads/${id}/timeline?limit=100`);
    const kinds = new Set(t.body.data.map((x: { kind: string }) => x.kind));
    expect([...kinds]).toEqual(expect.arrayContaining(['event', 'contact', 'message']));
    const stamps = t.body.data.map((x: { at: string }) => x.at);
    expect([...stamps].sort().reverse()).toEqual(stamps);
    const p = await dist(env).get(`${API}/leads/${id}/timeline?limit=2&offset=1`);
    expect(p.body).toMatchObject({ limit: 2, offset: 1, total: t.body.total });
    expect(p.body.data).toHaveLength(2);
  });

  it('the internal manual form: staff are routed through the engine, distributor/dealer users keep their own leads', async () => {
    const env = leadEnv();
    const staff = await env.u('dsm').post(`${API}/leads`).send({ name: 'Walk In', mobile: '9811100000', pincode: '380001', capacity_kw: 3, product_interest: ['module'], consent: { notice_version: 'v1', purposes: ['service'], channels: ['call'], proof_ref: 'form-77' } });
    expect(staff.status).toBe(201);
    expect(staff.body.data.lead).toMatchObject({ source: 'manual', status: 'assigned', distributor_id: IDS.distributorA });
    expect(staff.body.data.hints.map((h: { field: string }) => h.field)).toContain('segment');
    const consent = (await env.db.table('lead_consents').all({ lead_id: staff.body.data.lead.id }))[0]!;
    expect(consent).toMatchObject({ proof_ref: 'form-77', ip: null });
    expect((await env.u('dsm').post(`${API}/leads`).send({ name: 'No Proof', mobile: '9811100001', consent: { notice_version: 'v1', purposes: ['service'], channels: ['call'] } })).status).toBe(422);

    const named = await env.u('sales_manager').post(`${API}/leads`).send({ name: 'Named Dist', mobile: '9811100002', pincode: '380001', distributor_id: IDS.distributorB });
    expect(named.body.data.lead).toMatchObject({ status: 'assigned', distributor_id: IDS.distributorB });

    const own = await dist(env).post(`${API}/leads`).send({ name: 'My Own Customer', mobile: '9811100003', pincode: '395003' });
    expect(own.body.data.lead).toMatchObject({ status: 'accepted', distributor_id: IDS.distributorA, owner_id: IDS.profile('distributor_user') });
    const viaDealer = await dist(env).post(`${API}/leads`).send({ name: 'Dealer Customer', mobile: '9811100004', pincode: '395003', dealer_id: IDS.dealerA2 });
    expect(viaDealer.body.data.lead).toMatchObject({ dealer_id: IDS.dealerA2, lock_status: 'locked' });
    expect((await dist(env).post(`${API}/leads`).send({ name: 'Foreign Dealer', mobile: '9811100005', dealer_id: IDS.dealerB1 })).status).toBe(422);

    const dealer = await env.u('dealer_user').post(`${API}/leads`).send({ name: 'Dealer Walkin', mobile: '9811100006', pincode: '395003', source: 'website', dealer_id: IDS.dealerB1 });
    expect(dealer.body.data.lead).toMatchObject({ source: 'dealer_upload', dealer_id: IDS.dealerA1, status: 'accepted', lock_status: 'locked', owner_id: IDS.profile('dealer_user') });
    expect((await env.u('viewer').post(`${API}/leads`).send({ name: 'Nope', mobile: '9811100007' })).status).toBe(403);
    expect((await env.u('admin').post(`${API}/leads`).send({ name: 'Bad', mobile: '1111' })).status).toBe(422);
  });

  it('source API keys: admin creates (the plain key is shown once), lists masked, deactivates', async () => {
    const env = leadEnv();
    expect((await env.u('dsm').get(`${API}/lead-source-keys`)).status).toBe(403);
    const created = await env.u('admin').post(`${API}/lead-source-keys`).send({ source: 'website', label: 'Main website form' });
    expect(created.status).toBe(201);
    const plain = created.body.data.key as string;
    expect(plain).toMatch(/^fs_website_[0-9a-f]{48}$/);
    const list = await env.u('admin').get(`${API}/lead-source-keys`);
    expect(JSON.stringify(list.body)).not.toContain(plain);
    expect(JSON.stringify(list.body)).not.toContain('key_hash');
    expect((await env.capture(person(), plain)).status).toBe(201);
    expect((await env.db.table('source_api_keys').all())[0]!.last_used_at).not.toBeNull();
    await env.u('admin').patch(`${API}/lead-source-keys/${created.body.data.id}`).send({ active: false });
    expect((await env.capture(person({ mobile: '9811100010', email: undefined, name: 'Other Person' }), plain)).status).toBe(401);
  });
});
