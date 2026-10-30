/**
 * Job runner and scheduler (node-cron, Asia/Kolkata).
 *  · every minute  → clock engine tick (tickClocks)
 *  · 02:00 IST     → every job registered through registerJob() that uses the nightly schedule, per organisation
 *  · other cron    → jobs that registered their own schedule (e.g. the hourly breach watch)
 * Every run of a job in an organisation writes a `job_runs` row (status, timings, details or the captured error).
 */
import * as nodeCron from 'node-cron';
import type { Json, JobRun } from '@solar/shared';
import type { AppContext } from '../auth/context';
import { buildContext, systemUser, type AppDeps } from '../deps';
import { notFound } from '../http/errors';
import { tickClocks } from '../services/clockService';
import { registeredJobs, type JobDef } from '../services/hooks';
import { HOURLY_CRON, JOB_DESCRIPTIONS, NIGHTLY_CRON } from './platformJobs';
import { bindPlatformDeps } from './runtime';

export { NIGHTLY_CRON, HOURLY_CRON } from './platformJobs';
export { bindPlatformDeps, getPlatformDeps, depsFromContext } from './runtime';

// node-cron is CommonJS: depending on the loader the API lives on the namespace or on `default`
const cron: Pick<typeof nodeCron, 'schedule' | 'validate'> = (nodeCron as unknown as { default?: typeof nodeCron }).default ?? nodeCron;

export const JOB_TIMEZONE = 'Asia/Kolkata';
export const CLOCK_TICK_CRON = '* * * * *';

export interface JobHandle {
  stop(): void;
  /** Resolves once the schedules have been read from the rules and registered with node-cron. */
  ready: Promise<void>;
  /** The cron expressions in use and the jobs each one runs (available after `ready`). */
  schedule(): { cron: string; jobs: string[] }[];
}

export interface JobRunSummary {
  org_id: string; job_name: string; run_id: string | null; status: 'ok' | 'failed'; started_at: string; finished_at: string; details: Json; error: string | null;
}
export interface RunOptions { orgId?: string; trigger?: 'cron' | 'manual'; triggeredBy?: string | null }

const toJson = (v: unknown): Json => JSON.parse(JSON.stringify(v ?? null)) as Json;
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Run one job for one organisation, recording a job_runs row. Never throws: a failure is captured in the row and the summary. */
async function runForOrg(deps: AppDeps, job: JobDef, orgId: string, opts: RunOptions): Promise<JobRunSummary> {
  const trigger = opts.trigger ?? 'cron';
  const ctx: AppContext = buildContext(deps, orgId, systemUser(orgId), { system: true, requestId: `job-${job.name}-${deps.now().getTime()}` });
  const started = ctx.now().toISOString();
  const meta = { trigger, triggered_by: opts.triggeredBy ?? null };
  let runId: string | null = null;
  try {
    const row = await ctx.db.table('job_runs').insert({ job_name: job.name, started_at: started, finished_at: null, status: 'running', details: meta });
    runId = row.id;
  } catch (e) {
    deps.log.error({ err: e, job: job.name }, 'job_runs insert failed — running the job anyway');
  }
  const finish = async (status: JobRun['status'], details: Json): Promise<JobRunSummary> => {
    const finished = ctx.now().toISOString();
    if (runId) {
      try { await ctx.db.table('job_runs').update(runId, { status, finished_at: finished, details }); } catch (e) { deps.log.error({ err: e, job: job.name }, 'job_runs update failed'); }
    }
    return { org_id: orgId, job_name: job.name, run_id: runId, status: status === 'ok' ? 'ok' : 'failed', started_at: started, finished_at: finished, details, error: status === 'failed' ? String((details as { error?: Json }).error ?? '') : null };
  };
  try {
    const result = await job.run(ctx);
    return await finish('ok', { ...meta, ...(toJson(result ?? {}) as { [k: string]: Json }) });
  } catch (e) {
    deps.log.error({ err: e, job: job.name, org: orgId }, 'job failed');
    return finish('failed', { ...meta, error: errorText(e), error_name: e instanceof Error ? e.name : 'Error' });
  }
}

async function targetOrgs(deps: AppDeps, orgId?: string): Promise<string[]> {
  if (orgId) return [orgId];
  return (await deps.db.table('organizations').all()).map((o) => o.id);
}

/** Run a registered job by name for every organisation (or only `opts.orgId`). */
export async function runJob(deps: AppDeps, name: string, opts: RunOptions = {}): Promise<JobRunSummary[]> {
  const job = registeredJobs().find((j) => j.name === name);
  if (!job) throw notFound(`Job "${name}"`);
  const out: JobRunSummary[] = [];
  for (const orgId of await targetOrgs(deps, opts.orgId)) out.push(await runForOrg(deps, job, orgId, opts));
  return out;
}

/** Run every registered job (or the subset `only`) — what the nightly schedule does for the default cron. */
export async function runAllJobs(deps: AppDeps, opts: RunOptions & { only?: string[] } = {}): Promise<JobRunSummary[]> {
  const out: JobRunSummary[] = [];
  const jobs = registeredJobs().filter((j) => !opts.only || opts.only.includes(j.name));
  for (const orgId of await targetOrgs(deps, opts.orgId)) for (const job of jobs) out.push(await runForOrg(deps, job, orgId, opts));
  return out;
}

/* ───────────── admin view ───────────── */
export interface JobStatus {
  name: string; kind: 'job' | 'engine'; schedule: string; description: string;
  last_run: JobRun | null; last_ok_at: string | null; failures_24h: number;
}

export async function listJobStatus(ctx: AppContext): Promise<JobStatus[]> {
  const since = new Date(ctx.now().getTime() - 24 * 3_600_000).toISOString();
  const tickCron = await scheduleRule(ctx, 'jobs.clock_tick_cron', CLOCK_TICK_CRON);
  const nightlyCron = await scheduleRule(ctx, 'jobs.nightly_cron', NIGHTLY_CRON);
  const breachCron = await scheduleRule(ctx, 'jobs.breach_watch_cron', HOURLY_CRON);
  const out: JobStatus[] = [{ name: 'clock_tick', kind: 'engine', schedule: tickCron, description: 'Clock engine: marks breaches, sends 70 % warnings and escalates level by level.', last_run: null, last_ok_at: null, failures_24h: 0 }];
  for (const j of registeredJobs()) {
    const last = (await ctx.db.table('job_runs').list({ where: { job_name: j.name }, orderBy: { col: 'started_at', dir: 'desc' }, limit: 1 })).rows[0] ?? null;
    const lastOk = (await ctx.db.table('job_runs').list({ where: { job_name: j.name, status: 'ok' }, orderBy: { col: 'started_at', dir: 'desc' }, limit: 1 })).rows[0] ?? null;
    out.push({
      name: j.name, kind: 'job', schedule: effectiveSchedule(j, { nightly: nightlyCron, breach: breachCron }), description: JOB_DESCRIPTIONS[j.name] ?? '', last_run: last,
      last_ok_at: lastOk?.finished_at ?? null, failures_24h: await ctx.db.table('job_runs').count({ job_name: j.name, status: 'failed', started_at: { gte: since } }),
    });
  }
  return out;
}

/* ───────────── scheduling ───────────── */
interface Schedules { tick: string; nightly: string; breach: string }

async function scheduleRule(ctx: AppContext, path: string, fallback: string): Promise<string> {
  const v = await ctx.svc.rules.value<string>(path, undefined, fallback);
  return typeof v === 'string' && cron.validate(v) ? v : fallback;
}

const effectiveSchedule = (job: JobDef, s: Pick<Schedules, 'nightly' | 'breach'>): string => {
  const base = job.name === 'breach.watch' ? s.breach : job.schedule === NIGHTLY_CRON ? s.nightly : job.schedule;
  return cron.validate(base) ? base : s.nightly;
};

async function loadSchedules(deps: AppDeps): Promise<Schedules> {
  const defaults: Schedules = { tick: CLOCK_TICK_CRON, nightly: NIGHTLY_CRON, breach: HOURLY_CRON };
  try {
    const org = (await deps.db.table('organizations').all())[0];
    if (!org) return defaults;
    const ctx = buildContext(deps, org.id, systemUser(org.id), { system: true });
    return { tick: await scheduleRule(ctx, 'jobs.clock_tick_cron', CLOCK_TICK_CRON), nightly: await scheduleRule(ctx, 'jobs.nightly_cron', NIGHTLY_CRON), breach: await scheduleRule(ctx, 'jobs.breach_watch_cron', HOURLY_CRON) };
  } catch (e) {
    deps.log.warn({ err: e }, 'could not read job schedules from the rules — using defaults');
    return defaults;
  }
}

/** Start the cron schedules. Returns immediately; `ready` resolves once the rule-driven schedules are registered. */
export function startJobs(deps: AppDeps): JobHandle {
  bindPlatformDeps(deps);
  const tasks: { stop(): void }[] = [];
  const plan: { cron: string; jobs: string[] }[] = [];
  let stopped = false;

  const guarded = (label: string, fn: () => Promise<unknown>): (() => void) => {
    let busy = false;
    return () => {
      if (busy) { deps.log.warn({ job: label }, 'previous run still in progress — skipping this tick'); return; }
      busy = true;
      fn().catch((e: unknown) => deps.log.error({ err: e, job: label }, 'scheduled run failed')).finally(() => { busy = false; });
    };
  };

  const ready = (async () => {
    const s = await loadSchedules(deps);
    if (stopped) return;
    tasks.push(cron.schedule(s.tick, guarded('clock_tick', () => tickClocks(deps)), { timezone: JOB_TIMEZONE }));
    plan.push({ cron: s.tick, jobs: ['clock_tick'] });
    const groups = new Map<string, string[]>();
    for (const j of registeredJobs()) {
      const expr = effectiveSchedule(j, s);
      groups.set(expr, [...(groups.get(expr) ?? []), j.name]);
    }
    for (const [expr, names] of groups) {
      tasks.push(cron.schedule(expr, guarded(`jobs@${expr}`, () => runAllJobs(deps, { only: names, trigger: 'cron' })), { timezone: JOB_TIMEZONE }));
      plan.push({ cron: expr, jobs: names });
    }
    deps.log.info({ schedule: plan }, 'scheduled jobs started');
  })().catch((e: unknown) => deps.log.error({ err: e }, 'could not start scheduled jobs'));

  return { stop() { stopped = true; for (const t of tasks) t.stop(); tasks.length = 0; }, ready, schedule: () => plan.map((p) => ({ ...p })) };
}
