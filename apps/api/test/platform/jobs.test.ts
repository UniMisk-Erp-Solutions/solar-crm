import { afterEach, describe, expect, it } from 'vitest';
import { listJobStatus, runAllJobs, runJob, startJobs, type JobHandle } from '../../src/jobs';
import { registerJob, registeredJobs } from '../../src/services/hooks';
import { IDS } from '../helpers/env';
import { mkLead, platformEnv } from './fixtures';

const api = '/api/v1';

let calls = 0;
registerJob({ name: 'test.ok', schedule: '0 2 * * *', run: async () => { calls++; return { processed: 7, nested: { a: [1, 2] } }; } });
registerJob({ name: 'test.boom', schedule: '0 2 * * *', run: async () => { throw new Error('kaboom'); } });
registerJob({ name: 'test.void', schedule: '30 4 * * 1', run: async () => undefined });

let handle: JobHandle | null = null;
afterEach(() => { handle?.stop(); handle = null; });

describe('job runner', () => {
  it('registers the platform jobs alongside jobs contributed by other modules', () => {
    const names = registeredJobs().map((j) => j.name);
    expect(names).toEqual(expect.arrayContaining(['calendar.countdown', 'privacy.retention', 'platform.data_quality', 'breach.watch', 'test.ok']));
  });

  it('writes a job_runs row per run with timings and details', async () => {
    const env = platformEnv();
    const before = calls;
    const [r] = await runJob(env.deps, 'test.ok');
    expect(calls).toBe(before + 1);
    expect(r).toMatchObject({ job_name: 'test.ok', status: 'ok', error: null, details: { trigger: 'cron', processed: 7, nested: { a: [1, 2] } } });
    const row = await env.db.table('job_runs').get(r!.run_id!);
    expect(row).toMatchObject({ job_name: 'test.ok', status: 'ok', org_id: IDS.org });
    expect(row!.started_at).toBe(env.now().toISOString());
    expect(row!.finished_at).not.toBeNull();
    const [v] = await runJob(env.deps, 'test.void');
    expect(v!.status).toBe('ok');
  });

  it('survives a failing job: the failure is recorded and the other jobs still run', async () => {
    const env = platformEnv();
    const results = await runAllJobs(env.deps, { only: ['test.boom', 'test.ok'] });
    const byName = Object.fromEntries(results.map((r) => [r.job_name, r]));
    expect(byName['test.boom']).toMatchObject({ status: 'failed', error: 'kaboom' });
    expect(byName['test.ok']!.status).toBe('ok');
    const boom = await env.db.table('job_runs').one({ job_name: 'test.boom' });
    expect(boom).toMatchObject({ status: 'failed', details: { error: 'kaboom', error_name: 'Error' } });
    expect(boom!.finished_at).not.toBeNull();
    // and it is not retried in a tight loop: the next run is a fresh row
    await runJob(env.deps, 'test.boom');
    expect(await env.db.table('job_runs').count({ job_name: 'test.boom', status: 'failed' })).toBe(2);
  });

  it('rejects an unknown job name', async () => {
    const env = platformEnv();
    await expect(runJob(env.deps, 'nope')).rejects.toMatchObject({ status: 404 });
  });

  it('runs once per organisation', async () => {
    const env = platformEnv();
    const other = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await env.db.table('organizations').insert({ id: other, name: 'Second org', legal_name: 'Second org', gstin: null, pan: null, address: null, state: 'Gujarat', settings: {} });
    const rows = await runJob(env.deps, 'test.ok');
    expect(rows.map((r) => r.org_id).sort()).toEqual([IDS.org, other].sort());
    expect(await env.db.table('job_runs').count({ org_id: other })).toBe(1);
    const only = await runJob(env.deps, 'test.ok', { orgId: other });
    expect(only).toHaveLength(1);
  });
});

describe('admin job endpoints', () => {
  it('lists registered jobs with their last run, and runs one on demand', async () => {
    const env = platformEnv();
    const first = await env.as('compliance_officer').get(`${api}/admin/jobs`);
    expect(first.status).toBe(200);
    const names = first.body.data.map((j: { name: string }) => j.name);
    expect(names).toEqual(expect.arrayContaining(['clock_tick', 'calendar.countdown', 'privacy.retention', 'test.ok', 'test.boom']));
    const tick = first.body.data.find((j: { name: string }) => j.name === 'clock_tick');
    expect(tick).toMatchObject({ kind: 'engine', schedule: '* * * * *' });
    expect(first.body.data.find((j: { name: string }) => j.name === 'test.ok')).toMatchObject({ kind: 'job', schedule: '0 2 * * *', last_run: null, failures_24h: 0 });

    const run = await env.as('admin').post(`${api}/admin/jobs/test.ok/run`);
    expect(run.status).toBe(200);
    expect(run.body.data).toMatchObject({ job_name: 'test.ok', status: 'ok', details: { trigger: 'manual', triggered_by: IDS.profile('admin'), processed: 7 } });
    const failing = await env.as('compliance_officer').post(`${api}/admin/jobs/test.boom/run`);
    expect(failing.status).toBe(200);
    expect(failing.body.data).toMatchObject({ status: 'failed', error: 'kaboom' });

    const after = await env.as('compliance_officer').get(`${api}/admin/jobs`);
    const ok = after.body.data.find((j: { name: string }) => j.name === 'test.ok');
    expect(ok.last_run).toMatchObject({ status: 'ok' });
    expect(ok.last_ok_at).not.toBeNull();
    const boom = after.body.data.find((j: { name: string }) => j.name === 'test.boom');
    expect(boom).toMatchObject({ failures_24h: 1, last_ok_at: null });
    expect(boom.last_run.status).toBe('failed');

    const history = await env.as('compliance_officer').get(`${api}/admin/jobs/test.boom/runs`);
    expect(history.body.total).toBe(1);
    expect(history.body.data[0].details.error).toBe('kaboom');
    expect((await env.as('admin').post(`${api}/admin/jobs/missing/run`)).status).toBe(404);
    expect((await env.as('admin').get(`${api}/admin/jobs/missing/runs`)).status).toBe(404);
    expect((await env.db.table('audit_log').all({ action: 'job.run' })).length).toBe(2);
  });

  it('is limited to admin and compliance', async () => {
    const env = platformEnv();
    for (const role of ['management', 'dsm', 'sales_manager', 'viewer', 'distributor_user']) {
      expect((await env.as(role).get(`${api}/admin/jobs`)).status, role).toBe(403);
      expect((await env.as(role).post(`${api}/admin/jobs/test.ok/run`)).status, role).toBe(403);
    }
    expect((await listJobStatus(env.ctx('admin'))).length).toBeGreaterThan(5);
  });
});

describe('scheduler', () => {
  it('schedules the clock tick every minute and groups jobs by cron expression (Asia/Kolkata)', async () => {
    const env = platformEnv();
    handle = startJobs(env.deps);
    await handle.ready;
    const plan = handle.schedule();
    expect(plan[0]).toEqual({ cron: '* * * * *', jobs: ['clock_tick'] });
    const nightly = plan.find((p) => p.cron === '0 2 * * *');
    expect(nightly?.jobs).toEqual(expect.arrayContaining(['calendar.countdown', 'privacy.retention', 'platform.data_quality', 'test.ok', 'test.boom']));
    expect(plan.find((p) => p.cron === '0 * * * *')?.jobs).toContain('breach.watch');
    expect(plan.find((p) => p.cron === '30 4 * * 1')?.jobs).toEqual(['test.void']);
  });

  it('takes the schedules from the jobs.* rules when they are active and valid', async () => {
    const env = platformEnv();
    await env.rule('jobs.nightly_cron', '15 3 * * *');
    await env.rule('jobs.clock_tick_cron', 'not a cron', {});
    await env.rule('jobs.breach_watch_cron', '*/30 * * * *');
    handle = startJobs(env.deps);
    await handle.ready;
    const plan = handle.schedule();
    expect(plan[0]).toEqual({ cron: '* * * * *', jobs: ['clock_tick'] }); // invalid expression → default
    expect(plan.find((p) => p.cron === '15 3 * * *')?.jobs).toContain('calendar.countdown');
    expect(plan.find((p) => p.cron === '*/30 * * * *')?.jobs).toContain('breach.watch');
  });

  it('does not schedule anything once stopped before the schedules were read', async () => {
    const env = platformEnv();
    const h = startJobs(env.deps);
    h.stop();
    await h.ready;
    expect(h.schedule()).toEqual([]);
  });
});

describe('data-quality scan', () => {
  it('reports broken records, notifies once while unread, and changes nothing', async () => {
    const env = platformEnv();
    await mkLead(env, { name: 'No owner', owner_id: null });
    await mkLead(env, { name: 'Fine', mobile: '+919000000001' });
    await mkLead(env, { name: 'Twin A', mobile: '+919000000002' });
    await mkLead(env, { name: 'Twin B', mobile: '+919000000002', segment: null, status: 'qualified' });
    const [first] = await runJob(env.deps, 'platform.data_quality');
    expect(first!.status).toBe('ok');
    const details = first!.details as unknown as { checks: { key: string; count: number }[]; total_issues: number; notified: number };
    const count = (key: string) => details.checks.find((c) => c.key === key)!.count;
    expect(count('active_leads_missing_mandatory_fields')).toBe(1);
    expect(count('qualified_leads_without_segment')).toBe(1);
    expect(count('duplicate_mobiles')).toBe(2);
    expect(details.total_issues).toBe(4);
    expect(details.notified).toBe(3); // admin, management, compliance officer
    await runJob(env.deps, 'platform.data_quality');
    expect(await env.db.table('notifications').count({ kind: 'dataquality.daily' })).toBe(3); // not repeated while unread
    expect(await env.db.table('leads').count()).toBe(4);
  });

  it('is quiet when everything is fine', async () => {
    const env = platformEnv();
    await mkLead(env);
    const [r] = await runJob(env.deps, 'platform.data_quality');
    expect((r!.details as { total_issues: number }).total_issues).toBe(0);
    expect(await env.db.table('notifications').count()).toBe(0);
  });
});
