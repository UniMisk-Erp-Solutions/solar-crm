import { describe, expect, it } from 'vitest';
import type { ComplianceCalendarItem } from '@solar/shared';
import { runJob } from '../../src/jobs';
import { runCalendarCountdown, countdownLabel, countdownShort, urgencyFor } from '../../src/services/calendarService';
import { IDS, type TestEnv } from '../helpers/env';
import { mkLead, platformEnv } from './fixtures';

const api = '/api/v1';
const at = (date: string) => new Date(`${date}T05:00:00.000Z`); // 10:30 IST on that date

async function item(env: TestEnv, over: Partial<ComplianceCalendarItem> = {}): Promise<ComplianceCalendarItem> {
  return env.ctx('admin').db.table('compliance_calendar_items').insert({
    due_date: '2026-11-13', title: 'DPDP Consent Manager registration', description: null, category: 'dpdp', confidence: 'high', source_ref: 'DPDP Rules', escalate_days: [14, 7, 3], rule_key: null, active: true, ...over,
  });
}
const notes = (env: TestEnv, kind?: string) => env.db.table('notifications').all(kind ? { kind } : {});

describe('compliance calendar API', () => {
  it('returns countdown, label, confidence tag and sorts soonest first', async () => {
    const env = platformEnv();
    await item(env, { due_date: '2027-05-13', title: 'DPDP core duties', confidence: 'medium' });
    await item(env, { due_date: '2026-11-13' });
    await item(env, { due_date: '2026-10-20', title: 'Already passed', escalate_days: [] });
    await item(env, { due_date: '2026-10-27', title: 'Tomorrow', active: true });
    await item(env, { due_date: '2026-11-30', title: 'Inactive one', active: false });

    const all = await env.as('distributor_user').get(`${api}/calendar`); // the persistent strip is visible to every signed-in user
    expect(all.status).toBe(200);
    expect(all.body.data.map((i: { title: string }) => i.title)).toEqual(['Already passed', 'Tomorrow', 'DPDP Consent Manager registration', 'DPDP core duties']);
    const byTitle = Object.fromEntries(all.body.data.map((i: { title: string }) => [i.title, i]));
    expect(byTitle['DPDP Consent Manager registration']).toMatchObject({ days_left: 18, countdown_label: '18 days left', countdown_short: 'D-18', urgency: 'info', confidence: 'high', confidence_label: 'High', is_past: false });
    expect(byTitle['Tomorrow']).toMatchObject({ days_left: 1, countdown_label: '1 day left', urgency: 'critical' });
    expect(byTitle['Already passed']).toMatchObject({ days_left: -6, countdown_label: 'Overdue by 6 days', urgency: 'overdue', is_past: true });
    expect(byTitle['DPDP core duties'].confidence_label).toBe('Medium');

    const strip = await env.as('viewer').get(`${api}/calendar?next=2`);
    expect(strip.body.data.map((i: { title: string }) => i.title)).toEqual(['Tomorrow', 'DPDP Consent Manager registration']);
    expect((await env.as('viewer').get(`${api}/calendar?upcoming=true`)).body.data).toHaveLength(3);
    expect((await env.as('viewer').get(`${api}/calendar?include_inactive=true`)).body.data).toHaveLength(5);
    expect((await env.as('viewer').get(`${api}/calendar?category=nothing`)).body.data).toHaveLength(0);
  });

  it('counts down from the test clock', async () => {
    const env = platformEnv();
    await item(env);
    env.setNow(at('2026-11-12'));
    expect((await env.as('viewer').get(`${api}/calendar`)).body.data[0]).toMatchObject({ days_left: 1, urgency: 'critical' });
    env.setNow(at('2026-11-13'));
    expect((await env.as('viewer').get(`${api}/calendar`)).body.data[0]).toMatchObject({ days_left: 0, countdown_label: 'Due today', countdown_short: 'D-day' });
    expect(countdownLabel(-1)).toBe('Overdue by 1 day');
    expect(countdownShort(-3)).toBe('D+3');
    expect(urgencyFor(10)).toBe('warning');
  });

  it('lets only compliance officers and admins manage items; new items get the default countdown points', async () => {
    const env = platformEnv();
    const body = { due_date: '2026-12-31', title: 'ALMM List-II exemption ends', category: 'almm', confidence: 'high', source_ref: 'MNRE OM' };
    expect((await env.as('dsm').post(`${api}/calendar`).send(body)).status).toBe(403);
    const made = await env.as('compliance_officer').post(`${api}/calendar`).send(body);
    expect(made.status).toBe(201);
    expect(made.body.data.escalate_days).toEqual([14, 7, 3]);
    const custom = await env.as('admin').post(`${api}/calendar`).send({ ...body, title: 'Custom points', escalate_days: [3, 30] });
    expect(custom.body.data.escalate_days).toEqual([30, 3]);
    expect((await env.as('admin').post(`${api}/calendar`).send({ ...body, due_date: '31-12-2026' })).status).toBe(422);
    const patched = await env.as('compliance_officer').patch(`${api}/calendar/${made.body.data.id}`).send({ due_date: '2027-01-15', confidence: 'medium' });
    expect(patched.body.data).toMatchObject({ due_date: '2027-01-15', confidence: 'medium' });
    expect((await env.as('compliance_officer').patch(`${api}/calendar/${made.body.data.id}`).send({})).status).toBe(422);
    expect((await env.as('dsm').delete(`${api}/calendar/${made.body.data.id}`)).status).toBe(403);
    expect((await env.as('compliance_officer').delete(`${api}/calendar/${made.body.data.id}`)).status).toBe(200);
    expect((await env.as('compliance_officer').delete(`${api}/calendar/${made.body.data.id}`)).status).toBe(404);
    expect((await env.db.table('audit_log').all({ source: 'api' })).map((a) => a.action)).toEqual(expect.arrayContaining(['calendar.create', 'calendar.update', 'calendar.delete']));
  });
});

describe('calendar countdown notifications', () => {
  it('fires at D-14, D-7 and D-3 with rising severity, once per stage, to compliance, management and admin', async () => {
    const env = platformEnv();
    const it1 = await item(env);
    const run = () => runCalendarCountdown(env.systemCtx());

    expect((await run()).notified).toHaveLength(0); // D-18: too early
    env.setNow(at('2026-10-30')); // D-14
    const d14 = await run();
    expect(d14.notified).toMatchObject([{ item_id: it1.id, stage_days: 14, days_left: 14, severity: 'info', recipients: 3 }]);
    const sent14 = await notes(env, 'calendar.countdown.d14');
    expect(sent14.map((n) => n.user_id).sort()).toEqual([IDS.profile('admin'), IDS.profile('compliance_officer'), IDS.profile('management')].sort());
    expect(sent14[0]).toMatchObject({ severity: 'info', entity_type: 'compliance_calendar_item', entity_id: it1.id });
    expect(sent14[0]!.title).toBe('DPDP Consent Manager registration — 14 days left');

    // idempotent: the same day, and every following day inside the same stage, sends nothing more — even after the notice was read
    for (const u of sent14) await env.db.table('notifications').update(u.id, { read_at: env.now().toISOString() });
    const again = await run();
    expect(again.notified).toHaveLength(0);
    expect(again.already_sent).toBe(1);
    env.setNow(at('2026-10-31')); // D-13
    expect((await run()).notified).toHaveLength(0);
    env.setNow(at('2026-11-05')); // D-8
    expect((await run()).notified).toHaveLength(0);

    env.setNow(at('2026-11-06')); // D-7
    expect((await run()).notified).toMatchObject([{ stage_days: 7, severity: 'warning' }]);
    env.setNow(at('2026-11-10')); // D-3
    expect((await run()).notified).toMatchObject([{ stage_days: 3, severity: 'critical' }]);
    env.setNow(at('2026-11-11')); // D-2 — still stage 3, already sent
    expect((await run()).notified).toHaveLength(0);
    env.setNow(at('2026-11-14')); // past due
    expect((await run()).notified).toHaveLength(0);

    expect((await notes(env)).length).toBe(9); // 3 stages × 3 recipients
    expect((await notes(env, 'calendar.countdown.d3')).every((n) => n.severity === 'critical')).toBe(true);
  });

  it('ignores inactive items and items without countdown points, and uses a catch-up stage if a night was missed', async () => {
    const env = platformEnv();
    await item(env, { title: 'Inactive', active: false });
    await item(env, { title: 'No points', escalate_days: [] });
    const late = await item(env, { title: 'Found late', due_date: '2026-11-04' }); // D-9 on the first run → the D-14 stage fires late
    const r = await runCalendarCountdown(env.systemCtx());
    expect(r.notified).toHaveLength(1);
    expect(r.notified[0]).toMatchObject({ item_id: late.id, stage_days: 14, days_left: 9 });
    expect((await notes(env))[0]!.title).toBe('Found late — 9 days left');
  });

  it('runs through the job runner, records the run and skips nothing on repeat', async () => {
    const env = platformEnv();
    await item(env);
    env.setNow(at('2026-11-06')); // D-7
    const [first] = await runJob(env.deps, 'calendar.countdown');
    expect(first).toMatchObject({ job_name: 'calendar.countdown', status: 'ok' });
    expect(first!.details).toMatchObject({ checked: 1, already_sent: 0 });
    const [second] = await runJob(env.deps, 'calendar.countdown');
    expect(second!.details).toMatchObject({ already_sent: 1 });
    expect(await env.db.table('job_runs').count({ job_name: 'calendar.countdown', status: 'ok' })).toBe(2);
    // the first run in the stage notified 3 users once
    expect(await env.db.table('notifications').count({ kind: 'calendar.countdown.d7' })).toBe(3);
  });
});

describe('clocks API', () => {
  it('lists with filters and adds label, link and remaining time', async () => {
    const env = platformEnv();
    const lead = await mkLead(env);
    const c = env.ctx('admin');
    await c.svc.clocks.start({ entity_type: 'lead', entity_id: lead.id, clock_type: 'lead_acceptance', due_at: new Date(env.now().getTime() + 100 * 60_000), owner_id: IDS.profile('distributor_user') });
    await c.svc.clocks.start({ entity_type: 'lead', entity_id: lead.id, clock_type: 'followup', due_at: new Date(env.now().getTime() - 60_000), started_at: new Date(env.now().getTime() - 120_000), owner_id: IDS.profile('dsm') });
    await env.db.table('clocks').update((await env.db.table('clocks').one({ clock_type: 'followup' }))!.id, { status: 'breached', breached_at: env.now().toISOString(), escalated_level: 1 });

    const all = await env.as('dsm').get(`${api}/clocks`);
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(2);
    expect(all.body.data[0].clock_type).toBe('followup'); // earliest due first
    const acceptance = all.body.data.find((x: { clock_type: string }) => x.clock_type === 'lead_acceptance');
    expect(acceptance).toMatchObject({ label: 'Lead acceptance', entity_link: `/leads/${lead.id}`, owner_name: 'Test distributor_user', remaining_minutes: 100, breached: false });
    expect((await env.as('dsm').get(`${api}/clocks?breached=true`)).body.data.map((x: { clock_type: string }) => x.clock_type)).toEqual(['followup']);
    expect((await env.as('dsm').get(`${api}/clocks?breached=false`)).body.data.map((x: { clock_type: string }) => x.clock_type)).toEqual(['lead_acceptance']);
    expect((await env.as('dsm').get(`${api}/clocks?type=lead_acceptance`)).body.total).toBe(1);
    expect((await env.as('dsm').get(`${api}/clocks?status=running`)).body.total).toBe(1);
    expect((await env.as('dsm').get(`${api}/clocks?entity=lead&entity_id=${lead.id}`)).body.total).toBe(2);
    expect((await env.as('dsm').get(`${api}/clocks?entity=quotation`)).body.total).toBe(0);
    expect((await env.as('dsm').get(`${api}/clocks?owner=me`)).body.data.map((x: { clock_type: string }) => x.clock_type)).toEqual(['followup']);
    expect((await env.as('dsm').get(`${api}/clocks?owner=${IDS.profile('distributor_user')}`)).body.total).toBe(1);
    expect((await env.as('dsm').get(`${api}/clocks?open=true`)).body.total).toBe(2);
    expect((await env.as('distributor_user').get(`${api}/clocks`)).status).toBe(403);
  });

  it('returns the clocks of one entity and respects territory scope', async () => {
    const env = platformEnv();
    const lead = await mkLead(env);
    await env.ctx('admin').svc.clocks.start({ entity_type: 'lead', entity_id: lead.id, clock_type: 'lead_acceptance', due_at: new Date(env.now().getTime() + 60_000) });
    const r = await env.as('sales_manager').get(`${api}/clocks/entity/lead/${lead.id}`);
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(1);
    expect((await env.as('sales_manager').get(`${api}/clocks/entity/lead/${IDS.org}`)).status).toBe(404);
    await env.db.table('profiles').update(IDS.profile('dsm'), { territory_ids: [IDS.territorySurat] });
    expect((await env.as('dsm').get(`${api}/clocks/entity/lead/${lead.id}`)).status).toBe(403);
  });
});

describe('notifications API', () => {
  it('lists only my notifications with an unread filter and count, and marks them read', async () => {
    const env = platformEnv();
    const c = env.ctx('admin');
    await c.svc.notify.notify({ user_ids: [IDS.profile('dsm')], kind: 'a', title: 'First', severity: 'info' });
    env.advance(1000);
    await c.svc.notify.notify({ user_ids: [IDS.profile('dsm')], kind: 'b', title: 'Second', severity: 'critical' });
    await c.svc.notify.notify({ user_ids: [IDS.profile('accounts')], kind: 'a', title: 'Not mine' });

    const mine = await env.as('dsm').get(`${api}/notifications`);
    expect(mine.body.total).toBe(2);
    expect(mine.body.data.map((n: { title: string }) => n.title)).toEqual(['Second', 'First']); // newest first
    expect((await env.as('dsm').get(`${api}/notifications/unread-count`)).body.data.count).toBe(2);

    const first = mine.body.data[1] as { id: string };
    const read = await env.as('dsm').post(`${api}/notifications/${first.id}/read`);
    expect(read.status).toBe(200);
    expect(read.body.data.read_at).not.toBeNull();
    expect((await env.as('dsm').get(`${api}/notifications?unread=true`)).body.data.map((n: { title: string }) => n.title)).toEqual(['Second']);
    expect((await env.as('dsm').get(`${api}/notifications?unread=false`)).body.data).toHaveLength(1);
    expect((await env.as('dsm').get(`${api}/notifications?severity=critical`)).body.total).toBe(1);
    expect((await env.as('dsm').get(`${api}/notifications?limit=1&offset=1`)).body.data).toHaveLength(1);
    expect((await env.as('dsm').get(`${api}/notifications/unread-count`)).body.data.count).toBe(1);

    // someone else's notification looks like it does not exist
    const theirs = (await env.db.table('notifications').one({ user_id: IDS.profile('accounts') }))!;
    expect((await env.as('dsm').post(`${api}/notifications/${theirs.id}/read`)).status).toBe(404);

    const all = await env.as('dsm').post(`${api}/notifications/read-all`);
    expect(all.body.data.updated).toBe(1);
    expect((await env.as('dsm').get(`${api}/notifications/unread-count`)).body.data.count).toBe(0);
    expect((await env.db.table('notifications').one({ user_id: IDS.profile('accounts') }))!.read_at).toBeNull();
    expect((await env.anon().get(`${api}/notifications`)).status).toBe(401);
  });
});
