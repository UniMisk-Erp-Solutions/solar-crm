import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildSeed } from '@solar/shared/seed';
import { createApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { MemoryDb } from '../../src/db/memory';
import { createLogger } from '../../src/lib/logger';
import { buildProviders } from '../../src/providers';

describe('the admin can perform the actions the screens offer', () => {
  it('accepts a lead, logs a contact, qualifies it, decides an approval, and moves an order along', async () => {
    const config = loadConfig({}, { NODE_ENV: 'test', DEMO_MODE: true, RUN_JOBS: false, LOG_LEVEL: 'silent' });
    const log = createLogger('silent');
    const now = new Date('2026-10-26T06:30:00Z');
    const db = new MemoryDb(buildSeed(now), { now: () => now });
    const app = createApp({ config, db, providers: buildProviders(config, db, log), log, now: () => now });
    const users = (await request(app).get('/api/v1/auth/demo-users')).body.data as { id: string; role: string }[];
    const token = (await request(app).post('/api/v1/auth/demo-login').send({ profile_id: users.find((u) => u.role === 'admin')!.id })).body.data.token;
    const h = { Authorization: `Bearer ${token}` };
    const get = (p: string) => request(app).get(`/api/v1${p}`).set(h);
    const post = (p: string, b: object = {}) => request(app).post(`/api/v1${p}`).set(h).send(b);
    const out: Record<string, number> = {};

    // step 7 — accept an assigned lead
    const lead = (await get('/leads?status=assigned&limit=1')).body.data[0];
    const acc = await post(`/leads/${lead.id}/accept`, {});
    out['accept'] = acc.status; expect(acc.status, JSON.stringify(acc.body)).toBe(200);
    // step 8 — first contact
    const contact = await post(`/leads/${lead.id}/contacts`, { channel: 'call', outcome: 'connected_interested', notes: 'Spoke to customer' });
    out['contact'] = contact.status; expect(contact.status, JSON.stringify(contact.body)).toBe(201);
    // step 9 — qualification call
    const q = await post(`/leads/${lead.id}/qualification`, { requirement_text: 'Rooftop 5 kW for home, wants net metering', timeline_bucket: 'within_30_days', decision_maker: 'self', budget_inr: 300000 });
    out['qualify'] = q.status; expect(q.status, JSON.stringify(q.body)).toBe(200);
    expect(['hot', 'warm', 'cold']).toContain(q.body.data.temperature);

    // step 23 — decide a pending approval as admin
    const pending = (await get('/approvals?limit=5')).body.data as { id: string; decision?: string }[];
    if (pending.length) {
      const d = await post(`/approvals/${pending[0]!.id}/decide`, { decision: 'approved', comment: 'ok' });
      out['approve'] = d.status; expect(d.status, JSON.stringify(d.body)).toBe(200);
    }

    // step 34 — hand over an approved sales order
    const so = (await get('/sales-orders?status=approved&limit=1')).body.data?.[0];
    if (so) {
      const ho = await post(`/sales-orders/${so.id}/handover`, {});
      out['handover'] = ho.status; expect(ho.status, JSON.stringify(ho.body)).toBe(200);
    }
    console.log('admin actions', out);
  });
});
