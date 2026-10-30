/**
 * Supabase Edge Function entry (function name: "api"). The whole backend runs inside Supabase: Postgres, Auth, Storage and this function.
 *
 *  URL   https://<project>.supabase.co/functions/v1/api/api/v1/...   (the first "api" is the function name, which Supabase keeps in the path)
 *  Cron  pg_cron + pg_net (supabase/sql/14_cron.sql) call GET .../api/api/v1/internal/cron?kind=tick|hourly|nightly with the cron secret:
 *          tick     the clock engine (reminders, DSM alerts, auto-reassignment)   every minute
 *          hourly   the breach watch                                               every hour
 *          nightly  every nightly job (scores, KPI snapshots, compliance calendar) 02:00 IST
 *  Secrets  SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase; set the rest with `supabase secrets set` (see docs/DEPLOY.md).
 */
import express, { type Request, type Response } from 'express';
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createApp } from './app';
import { createDeps } from './bootstrap';
import { HOURLY_CRON, bindPlatformDeps, runAllJobs } from './jobs';
import { registeredJobs } from './services/hooks';
import { tickClocks } from './services/clockService';

// an edge function is never a dev machine: no pretty-printing worker thread, JSON logs for the Supabase log viewer
process.env['NODE_ENV'] ||= 'production';
const deps = createDeps();
bindPlatformDeps(deps);
const outer = express();

outer.get('/api/api/v1/internal/cron', async (req: Request, res: Response) => {
  const secret = process.env['CRON_SECRET'] ?? '';
  const sent = Buffer.from(String(req.headers['authorization'] ?? ''));
  const want = Buffer.from(`Bearer ${secret}`);
  if (!secret || sent.length !== want.length || !timingSafeEqual(sent, want)) { res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Cron secret missing or wrong' } }); return; }
  const kind = String(req.query['kind'] ?? 'tick');
  try {
    if (kind === 'tick') { res.json({ data: { kind, result: await tickClocks(deps) } }); return; }
    const jobs = registeredJobs();
    const isBreach = (n: string) => n === 'breach.watch';
    const only = kind === 'hourly' ? jobs.filter((j) => isBreach(j.name) || j.schedule === HOURLY_CRON).map((j) => j.name)
      : kind === 'nightly' ? jobs.filter((j) => !isBreach(j.name) && j.schedule !== HOURLY_CRON).map((j) => j.name) : null;
    if (!only) { res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'kind must be tick, nightly or hourly' } }); return; }
    const runs = await runAllJobs(deps, { only, trigger: 'cron' });
    res.json({ data: { kind, ran: runs.length, failed: runs.filter((r) => r.status === 'failed').length } });
  } catch (e) {
    deps.log.error({ err: e, kind }, 'cron run failed');
    res.status(500).json({ error: { code: 'ERROR', message: 'The scheduled run failed' } });
  }
});

// Supabase keeps the function name ("api") at the front of the path; the Express app itself serves /api/v1/... and /health
outer.use('/api', createApp(deps));

createServer(outer).listen(Number(process.env['PORT'] ?? 8000));
