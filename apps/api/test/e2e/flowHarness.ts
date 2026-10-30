/**
 * Harness for the end-to-end flow test: the REAL seed, the REAL app (every router), the in-memory database, the mock providers and a
 * clock the test controls. Nothing is stubbed - every cross-module hand-off in test/e2e/flow.test.ts goes through HTTP.
 */
import request from 'supertest';
import { DEMO_ORG_ID, type AppRole, type Profile } from '@solar/shared';
import { DEMO_IDS, buildSeed } from '@solar/shared/seed';
import { createApp } from '../../src/app';
import { demoToken } from '../../src/auth/authenticate';
import type { AppContext } from '../../src/auth/context';
import { loadConfig } from '../../src/config';
import { MemoryDb } from '../../src/db/memory';
import { buildContext, type AppDeps } from '../../src/deps';
import { createLogger } from '../../src/lib/logger';
import { buildProviders } from '../../src/providers';
import type { MemoryStorage } from '../../src/providers/storage';
import { tickClocks, type TickResult } from '../../src/services/clockService';

/** Monday 26-Oct-2026, 10:30 IST - a normal working morning (the seed is generated relative to this instant). */
export const START = new Date('2026-10-26T05:00:00.000Z');
export const API = '/api/v1';
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Seed profile keys: admin, management, regional_head, sales_manager, dsm, dsm2, techno_commercial, accounts, compliance_officer, dispatch, viewer, distributor_user(_b/_c), dealer_user(_2/_3). */
export type Who = keyof typeof DEMO_IDS.profile;

export interface FlowEnv {
  app: ReturnType<typeof createApp>;
  deps: AppDeps;
  db: MemoryDb;
  storage: MemoryStorage;
  now(): Date;
  setNow(d: Date): void;
  advance(ms: number): void;
  /** authenticated supertest verbs for a seeded user */
  as(who: Who): Verbs;
  /** supertest without a session (public endpoints) */
  anon(): ReturnType<typeof request>;
  /** a fresh request context for reading through the same services the API uses */
  ctx(who?: Who): Promise<AppContext>;
  /** run the clock engine once at the current time */
  tick(): Promise<TickResult>;
}

export interface Verbs {
  get(url: string): request.Test;
  post(url: string): request.Test;
  put(url: string): request.Test;
  patch(url: string): request.Test;
  delete(url: string): request.Test;
}

export function createFlowEnv(start: Date = START): FlowEnv {
  let t = start;
  const now = () => t;
  const config = loadConfig({}, { NODE_ENV: 'test', DEMO_MODE: true, RUN_JOBS: false, LOG_LEVEL: 'silent' });
  const log = createLogger('silent');
  const db = new MemoryDb(buildSeed(start), { now });
  const providers = buildProviders(config, db, log);
  const deps: AppDeps = { config, db, providers, log, now };
  const app = createApp(deps);

  const as = (who: Who): Verbs => {
    const auth = (r: request.Test) => r.set('Authorization', `Bearer ${demoToken(DEMO_IDS.profile[who], now().getTime())}`);
    return {
      get: (u) => auth(request(app).get(u)),
      post: (u) => auth(request(app).post(u)),
      put: (u) => auth(request(app).put(u)),
      patch: (u) => auth(request(app).patch(u)),
      delete: (u) => auth(request(app).delete(u)),
    };
  };
  return {
    app, deps, db, storage: providers.storage as MemoryStorage, now,
    setNow: (d) => { t = d; },
    advance: (ms) => { t = new Date(t.getTime() + ms); },
    as,
    anon: () => request(app),
    async ctx(who = 'admin') {
      const profile = await db.table('profiles').getOrThrow(DEMO_IDS.profile[who]);
      return buildContext(deps, DEMO_ORG_ID, profile as Profile, { requestId: 'flow-test', now });
    },
    tick: () => tickClocks(deps),
  };
}

/** Unwraps `{ data }` and fails with the full error body (not just "expected 200 to be 201") when the status is not the expected one. */
export function data<T>(res: request.Response, expected: number | number[] = 200): T {
  const want = Array.isArray(expected) ? expected : [expected];
  if (!want.includes(res.status)) {
    const req = res.request as unknown as { method?: string; url?: string };
    throw new Error(`${req.method ?? ''} ${req.url ?? ''} -> HTTP ${res.status}, expected ${want.join('/')}: ${JSON.stringify(res.body).slice(0, 2500)}`);
  }
  return (res.body as { data: T }).data;
}

export interface ApiError { code: string; message: string; details: unknown }

/** Asserts an error response and returns its body. */
export function failure(res: request.Response, status: number, code?: string): ApiError {
  const req = res.request as unknown as { method?: string; url?: string };
  if (res.status !== status) throw new Error(`${req.method ?? ''} ${req.url ?? ''} -> HTTP ${res.status}, expected ${status}: ${JSON.stringify(res.body).slice(0, 2500)}`);
  const err = (res.body as { error: ApiError }).error;
  if (code && err.code !== code) throw new Error(`${req.method ?? ''} ${req.url ?? ''} -> error code ${err.code}, expected ${code}: ${JSON.stringify(err).slice(0, 2500)}`);
  return err;
}

/** `[{ path, message }]` out of a VALIDATION_ERROR / GUARD_BLOCKED body. */
export const detailPaths = (e: ApiError): string[] => (Array.isArray(e.details) ? (e.details as { path?: string }[]).map((d) => d.path ?? '') : []);

export type { AppRole };
