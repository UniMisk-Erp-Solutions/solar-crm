import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildSeed } from '@solar/shared/seed';
import { createApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { MemoryDb } from '../../src/db/memory';
import { createLogger } from '../../src/lib/logger';
import { buildProviders } from '../../src/providers';

describe('full app boots with the real seed and every router', () => {
  it('lists demo users and serves authenticated endpoints', async () => {
    const config = loadConfig({}, { NODE_ENV: 'test', DEMO_MODE: true, RUN_JOBS: false, LOG_LEVEL: 'silent' });
    const log = createLogger('silent');
    const now = new Date('2026-10-26T06:30:00Z');
    const db = new MemoryDb(buildSeed(now), { now: () => now });
    const deps = { config, db, providers: buildProviders(config, db, log), log, now: () => now };
    const app = createApp(deps);

    const users = await request(app).get('/api/v1/auth/demo-users');
    expect(users.status).toBe(200);
    const roles = new Set((users.body.data as { role: string }[]).map((u) => u.role));
    expect(roles.size).toBe(12);

    const dsm = (users.body.data as { id: string; role: string }[]).find((u) => u.role === 'dsm')!;
    const login = await request(app).post('/api/v1/auth/demo-login').send({ profile_id: dsm.id });
    const auth = { Authorization: `Bearer ${login.body.data.token}` };

    const paths = ['/leads', '/opportunities', '/quotes', '/approvals', '/skus', '/sales-orders', '/pis', '/dispatches', '/dealers', '/distributors', '/loans', '/subsidy-claims', '/installations', '/discom-applications', '/warranty-tickets', '/rules', '/calendar', '/notifications', '/dashboards/home', '/dashboards/funnel', '/dashboards/sla', '/dashboards/dealer-exposure', '/search?q=sun', '/verify-register', '/clocks', '/serials'];
    const bad: string[] = [];
    for (const p of paths) {
      const r = await request(app).get(`/api/v1${p}`).set(auth);
      if (r.status >= 400) bad.push(`${p} -> ${r.status} ${r.body?.error?.message ?? ''}`);
    }
    expect(bad).toEqual([]);
  });
});
