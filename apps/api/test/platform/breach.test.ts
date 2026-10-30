import { describe, expect, it } from 'vitest';
import { runJob } from '../../src/jobs';
import { IDS } from '../helpers/env';
import { platformEnv } from './fixtures';

const api = '/api/v1';
const HOUR = 3_600_000;
const create = (env: ReturnType<typeof platformEnv>, body: Record<string, unknown> = {}) =>
  env.as('compliance_officer').post(`${api}/breaches`).send({ title: 'Customer sheet shared with a wrong recipient', description: 'An export was e-mailed externally', ...body });

describe('breach incidents — 72-hour countdown', () => {
  it('sets report_due_at = detected_at + 72 h, starts a clock and logs the first evidence', async () => {
    const env = platformEnv();
    const r = await create(env);
    expect(r.status).toBe(201);
    const b = r.body.data;
    expect(b.status).toBe('open');
    expect(new Date(b.report_due_at).getTime() - new Date(b.detected_at).getTime()).toBe(72 * HOUR);
    expect(b.detected_at).toBe(env.now().toISOString());
    expect(b).toMatchObject({ hours_left: 72, overdue: false, reported_at: null });
    expect(b.countdown_label).toContain('left to report');
    expect(b.evidence).toHaveLength(1);
    expect(b.evidence[0]).toMatchObject({ by: IDS.profile('compliance_officer') });
    // the clock appears in the clock list with its own label and the same due time
    expect(b.clock).toMatchObject({ entity_type: 'breach_incident', entity_id: b.id, status: 'running', due_at: b.report_due_at, meta: { kind: 'dpdp_breach_report' } });
    const clocks = await env.as('compliance_officer').get(`${api}/clocks/entity/breach_incident/${b.id}`);
    expect(clocks.body.data[0]).toMatchObject({ label: 'DPDP breach report (72 h)', remaining_minutes: 72 * 60 });
    expect(await env.db.table('notifications').count({ kind: 'breach.opened' })).toBe(3); // compliance, management, admin
    expect(await env.db.table('audit_log').count({ action: 'breach.create' })).toBe(1);
  });

  it('follows the dpdp.breach_report_hours rule when it is active and honours an earlier detection time', async () => {
    const env = platformEnv();
    await env.rule('dpdp.breach_report_hours', 48);
    const detected = new Date(env.now().getTime() - 10 * HOUR).toISOString();
    const b = (await create(env, { detected_at: detected })).body.data;
    expect(new Date(b.report_due_at).getTime() - new Date(detected).getTime()).toBe(48 * HOUR);
    expect(b.hours_left).toBe(38);
    expect((await create(env, { detected_at: new Date(env.now().getTime() + 3 * HOUR).toISOString() })).status).toBe(400);
    // an inactive rule falls back to the documented 72 hours
    const env2 = platformEnv();
    await env2.rule('dpdp.breach_report_hours', 24, { is_active: false, status: 'unverified' });
    const b2 = (await create(env2)).body.data;
    expect(new Date(b2.report_due_at).getTime() - new Date(b2.detected_at).getTime()).toBe(72 * HOUR);
  });

  it('counts down with the clock, flags overdue, and the hourly watch warns once per stage', async () => {
    const env = platformEnv();
    const b = (await create(env)).body.data;
    env.advance(30 * HOUR);
    const mid = (await env.as('admin').get(`${api}/breaches/${b.id}`)).body.data;
    expect(mid).toMatchObject({ hours_left: 42, overdue: false });
    expect((await runJob(env.deps, 'breach.watch'))[0]!.details).toMatchObject({ open: 1, notified: [] }); // 42 h left: nothing yet

    env.advance(20 * HOUR); // 22 h left → 24 h stage
    const w1 = (await runJob(env.deps, 'breach.watch'))[0]!;
    expect((w1.details as { notified: { kind: string }[] }).notified).toMatchObject([{ kind: 'breach.watch.h24' }]);
    expect(await env.db.table('notifications').count({ kind: 'breach.watch.h24' })).toBe(3);
    expect((await runJob(env.deps, 'breach.watch'))[0]!.details).toMatchObject({ notified: [], already_sent: 1 });

    env.advance(18 * HOUR); // 4 h left → 6 h stage, critical
    await runJob(env.deps, 'breach.watch');
    expect((await env.db.table('notifications').one({ kind: 'breach.watch.h6' }))!.severity).toBe('critical');

    env.advance(5 * HOUR); // 1 h overdue
    const late = (await env.as('admin').get(`${api}/breaches/${b.id}`)).body.data;
    expect(late).toMatchObject({ overdue: true, hours_left: -1 });
    expect(late.countdown_label).toMatch(/^Overdue by/);
    await runJob(env.deps, 'breach.watch');
    await runJob(env.deps, 'breach.watch');
    expect(await env.db.table('notifications').count({ kind: 'breach.overdue' })).toBe(3);
    expect((await env.as('admin').get(`${api}/breaches?overdue=true`)).body.total).toBe(1);
    expect((await env.as('admin').get(`${api}/breaches?overdue=false`)).body.total).toBe(0);
  });
});

describe('breach incidents — evidence, drafts, reporting and closing', () => {
  it('appends evidence, drafts the notification (default or company template) and edits details', async () => {
    const env = platformEnv();
    const b = (await create(env)).body.data;
    const as = env.as('compliance_officer');
    env.advance(HOUR);
    const ev = await as.post(`${api}/breaches/${b.id}/evidence`).send({ note: 'Mail recall requested from the recipient’s IT team' });
    expect(ev.body.data.evidence).toHaveLength(2);
    expect(ev.body.data.evidence[1]).toMatchObject({ by: IDS.profile('compliance_officer'), note: 'Mail recall requested from the recipient’s IT team' });
    expect((await as.post(`${api}/breaches/${b.id}/evidence`).send({ note: '' })).status).toBe(422);
    expect((await as.patch(`${api}/breaches/${b.id}`).send({ title: 'Customer sheet e-mailed externally' })).body.data.title).toBe('Customer sheet e-mailed externally');

    const draft = (await as.get(`${api}/breaches/${b.id}/notification-draft`)).body.data;
    expect(draft).toMatchObject({ source: 'default', template_key: null, report_due_at: b.report_due_at });
    expect(draft.subject).toContain('Customer sheet e-mailed externally');
    expect(draft.body).toContain('DRAFT');
    expect(draft.body).toContain('Mail recall requested');

    await env.ctx('admin').db.table('message_templates').insert({ key: 'breach.notification', channel: 'email', category: 'service', purpose: 'service', language: 'en', subject: 'Intimation: {{title}}', body: 'Detected {{detected_at}}. Report by {{report_due_at}}.\n{{evidence}}', dlt_template_id: null, dlt_header: null, whatsapp_template_name: null, version: 1, active: true });
    const fromTpl = (await as.get(`${api}/breaches/${b.id}/notification-draft`)).body.data;
    expect(fromTpl).toMatchObject({ source: 'template', template_key: 'breach.notification', subject: 'Intimation: Customer sheet e-mailed externally' });
    expect(fromTpl.body).toContain('Report by');
  });

  it('moves open → reported → closed, completes the clock, and refuses invalid transitions', async () => {
    const env = platformEnv();
    const as = env.as('compliance_officer');
    const b = (await create(env)).body.data;
    expect((await as.post(`${api}/breaches/${b.id}/close`).send({})).status).toBe(422); // report first, or say why it is not reportable
    env.advance(10 * HOUR);
    const rep = await as.post(`${api}/breaches/${b.id}/report`).send({ reference: 'DPB-2026-0042', note: 'Filed through the Board portal' });
    expect(rep.status).toBe(200);
    expect(rep.body.data).toMatchObject({ status: 'reported', reported_at: env.now().toISOString(), overdue: false, clock: { status: 'met' } });
    expect(rep.body.data.evidence.map((e: { note: string }) => e.note).join(' ')).toContain('DPB-2026-0042');
    expect(rep.body.data.countdown_label).toContain('before the deadline');
    expect((await as.post(`${api}/breaches/${b.id}/report`).send({})).status).toBe(409);
    const closed = await as.post(`${api}/breaches/${b.id}/close`).send({ reason: 'Containment confirmed' });
    expect(closed.body.data.status).toBe('closed');
    expect((await as.post(`${api}/breaches/${b.id}/close`).send({})).status).toBe(409);
    expect((await as.post(`${api}/breaches/${b.id}/evidence`).send({ note: 'late note' })).status).toBe(409);
    expect((await as.patch(`${api}/breaches/${b.id}`).send({ title: 'Changed' })).status).toBe(409);
    expect((await env.as('admin').get(`${api}/breaches?status=closed`)).body.total).toBe(1);
    expect((await env.as('admin').get(`${api}/breaches?status=open`)).body.total).toBe(0);
    expect((await env.db.table('audit_log').all({ source: 'api' })).map((a) => a.action)).toEqual(expect.arrayContaining(['breach.create', 'breach.report', 'breach.close']));
  });

  it('records a late report and allows closing an unreportable incident with a reason', async () => {
    const env = platformEnv();
    const as = env.as('admin');
    const late = (await create(env)).body.data;
    env.advance(80 * HOUR);
    const rep = await as.post(`${api}/breaches/${late.id}/report`).send({});
    expect(rep.body.data.evidence.at(-1).note).toContain('after the deadline');
    expect(rep.body.data.countdown_label).toContain('after the deadline');
    const fp = (await create(env, { title: 'False alarm' })).body.data;
    const closed = await as.post(`${api}/breaches/${fp.id}/close`).send({ reason: 'Assessed: no personal data involved' });
    expect(closed.status).toBe(200);
    expect(closed.body.data.evidence.at(-1).note).toContain('no personal data involved');
    expect(closed.body.data.clock.status).toBe('cancelled');
  });

  it('is limited to compliance officers and admins', async () => {
    const env = platformEnv();
    const b = (await create(env)).body.data;
    for (const role of ['management', 'sales_manager', 'dsm', 'accounts', 'viewer', 'distributor_user']) {
      const as = env.as(role);
      expect((await as.get(`${api}/breaches`)).status, role).toBe(403);
      expect((await as.get(`${api}/breaches/${b.id}`)).status, role).toBe(403);
      expect((await as.post(`${api}/breaches`).send({ title: 'Nope nope' })).status, role).toBe(403);
      expect((await as.post(`${api}/breaches/${b.id}/report`).send({})).status, role).toBe(403);
    }
    expect((await env.as('admin').get(`${api}/breaches/${IDS.org}`)).status).toBe(404);
    expect((await env.as('admin').post(`${api}/breaches`).send({ title: 'ab' })).status).toBe(422);
  });
});
