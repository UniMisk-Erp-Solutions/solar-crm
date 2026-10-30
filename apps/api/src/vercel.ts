/**
 * Vercel entry point. The API runs as ONE serverless function (every path is rewritten to /api, see vercel.json), so the in-process
 * node-cron scheduler used by src/server.ts cannot run here. Vercel Cron calls GET /api/v1/internal/cron instead:
 *   ?kind=tick     the clock engine (reminders, DSM alerts, auto-reassignment)      every minute
 *   ?kind=nightly  every nightly job (scores, KPI snapshots, compliance calendar …)  02:00 IST
 *   ?kind=hourly   the breach watch                                                  every hour
 * Vercel sends "Authorization: Bearer <CRON_SECRET>"; any other caller gets 401.
 */
import express, { type Express, type Request, type Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { createApp } from './app';
import { createDeps } from './bootstrap';
import { HOURLY_CRON, bindPlatformDeps, runAllJobs } from './jobs';
import { registeredJobs } from './services/hooks';
import { tickClocks } from './services/clockService';

let cached: Express | null = null;

function build(): Express {
  const deps = createDeps();
  bindPlatformDeps(deps);
  const secret = process.env['CRON_SECRET'] ?? '';
  const outer = express();

  outer.get('/api/v1/internal/cron', async (req: Request, res: Response) => {
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

  outer.use(createApp(deps));
  return outer;
}

export default function handler(req: Request, res: Response): void {
  cached ??= build();
  cached(req, res);
}
