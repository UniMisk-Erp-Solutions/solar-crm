import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildSeed } from '@solar/shared/seed';
import { createApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { MemoryDb } from '../../src/db/memory';
import { createLogger } from '../../src/lib/logger';
import { buildProviders } from '../../src/providers';

/** Every GET the five modules call on load, as the admin, against the real seed. A 4xx/5xx here is a broken screen. */
describe('admin screens: every endpoint the pages call answers', () => {
  it('serves the dashboard, Leads, Site, Quotation, Order, Control and Settings data', async () => {
    const config = loadConfig({}, { NODE_ENV: 'test', DEMO_MODE: true, RUN_JOBS: false, LOG_LEVEL: 'silent' });
    const log = createLogger('silent');
    const now = new Date('2026-10-26T06:30:00Z');
    const db = new MemoryDb(buildSeed(now), { now: () => now });
    const app = createApp({ config, db, providers: buildProviders(config, db, log), log, now: () => now });
    const users = (await request(app).get('/api/v1/auth/demo-users')).body.data as { id: string; role: string }[];
    const admin = users.find((u) => u.role === 'admin')!;
    const token = (await request(app).post('/api/v1/auth/demo-login').send({ profile_id: admin.id })).body.data.token;
    const get = (p: string) => request(app).get(`/api/v1${p}`).set('Authorization', `Bearer ${token}`);

    const lead = (await get('/leads?status=assigned&limit=1')).body.data?.[0];
    const opp = (await get('/opportunities?limit=1')).body.data?.[0];
    const quote = (await get('/quotes?limit=1')).body.data?.[0];
    const pi = (await get('/pis?limit=1')).body.data?.[0];
    const so = (await get('/sales-orders?limit=1')).body.data?.[0];
    expect(lead && opp && quote && pi && so, 'seed must have a lead, opportunity, quote, PI and SO').toBeTruthy();

    const paths = [
      '/auth/me', '/leads?status=unassigned,assigned&limit=1', '/leads?limit=25', `/leads/${lead.id}`, `/leads/${lead.id}/timeline`, '/followups?bucket=overdue', '/followups?bucket=due_today', '/followups?bucket=upcoming',
      '/lookups/pincode/380001', '/distributors', '/admin/users', `/leads/${lead.id}/convert-check`, `/leads/${lead.id}/negotiations`, `/leads/${lead.id}/requirement`,
      '/surveys?status=scheduled&limit=1', '/surveys', '/skus/recommend?segment=pmsg_residential&kw=3', '/opportunities', `/opportunities/${opp.id}`,
      '/quotes', `/quotes/${quote.id}`, `/quotes/${quote.id}/discussions`, '/approvals', '/approvals/summary', `/quotes/${quote.id}/pre-pi-checklist`,
      '/pis', `/pis/${pi.id}`, '/sales-orders', `/sales-orders/${so.id}`, '/sales-orders?status=on_hold,pending_approval&limit=1',
      '/dashboards/funnel', '/dashboards/sla', '/admin/sla',
    ];
    const bad: string[] = [];
    for (const p of paths) {
      const r = await get(p);
      if (r.status >= 400) bad.push(`${p} -> ${r.status} ${r.body?.error?.message ?? ''}`);
    }
    expect(bad).toEqual([]);
  });
});
