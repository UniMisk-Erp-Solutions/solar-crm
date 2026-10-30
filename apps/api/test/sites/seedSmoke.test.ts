import { describe, expect, it } from 'vitest';
import { buildSeed } from '@solar/shared/seed';
import type { FormFieldDef } from '@solar/shared';
import customersRouter from '../../src/routes/customers.routes';
import opportunitiesRouter from '../../src/routes/opportunities.routes';
import { T0, createTestEnv } from '../helpers/env';

const API = '/api/v1';
const seed = () => buildSeed(T0);
const idOf = (role: string, nth = 0) => seed().profiles!.filter((p) => p.role === role)[nth]!.id;

function sample(f: FormFieldDef): unknown {
  switch (f.type) {
    case 'number': return 5;
    case 'boolean': return true;
    case 'date': return '2026-12-01';
    case 'select': return f.options?.[0] ?? 'x';
    default: return 'Sample value';
  }
}

describe('endpoints against the real seed data never fail with a 5xx', () => {
  const env = createTestEnv({ seed: seed(), authed: [customersRouter, opportunitiesRouter] });
  const data = seed();
  const actors = [idOf('admin'), idOf('dsm'), idOf('distributor_user', 0), idOf('distributor_user', 1), idOf('dealer_user', 0), idOf('viewer')];

  it('reads: every lead, survey, site, customer, opportunity and segment form', async () => {
    const hits: [string, number][] = [];
    const get = async (as: string, url: string) => { const r = await env.as(as).get(`${API}${url}`); hits.push([url, r.status]); return r; };
    for (const as of actors) {
      for (const l of data.leads!) for (const p of ['site', 'requirement', 'negotiations', 'convert-check']) await get(as, `/leads/${l.id}/${p}`);
      for (const s of data.site_surveys!) await get(as, `/surveys/${s.id}`);
      for (const s of data.sites!) await get(as, `/sites/${s.id}`);
      for (const c of data.customers!) await get(as, `/customers/${c.id}`);
      for (const o of data.opportunities!) await get(as, `/opportunities/${o.id}`);
      for (const u of ['/surveys', '/surveys?mine=true', '/sites', '/customers', '/opportunities', '/opportunities?stage=won&sort=expected_value', '/opportunities/pipeline']) await get(as, u);
      for (const seg of ['pmsg_residential', 'rwa_ghs', 'ci_captive', 'ci_net_metered', 'open_access', 'pm_kusum', 'government_bid']) await get(as, `/segments/${seg}/form`);
    }
    const bad = hits.filter(([, s]) => s >= 500);
    expect(bad).toEqual([]);
    expect(hits.filter(([, s]) => s === 200).length).toBeGreaterThan(300);
    const adminOpps = await env.as(idOf('admin')).get(`${API}/opportunities`);
    expect(adminOpps.body.total).toBe(data.opportunities!.length);
    const board = await env.as(idOf('admin')).get(`${API}/opportunities/pipeline`);
    expect(board.body.data.totals.open_count + board.body.data.totals.won_count + board.body.data.totals.lost_count).toBe(data.opportunities!.length);
    // a distributor user sees only a subset
    expect((await env.as(idOf('distributor_user', 0)).get(`${API}/opportunities`)).body.total).toBeLessThan(data.opportunities!.length);
  });

  it('writes: requirement forms built from the seeded segment forms, site saves, survey scheduling and conversion', async () => {
    const statuses: [string, number][] = [];
    const admin = env.as(idOf('admin'));
    for (const lead of data.leads!.filter((l) => l.segment && !['merged', 'duplicate'].includes(l.status))) {
      const form = (await admin.get(`${API}/segments/${lead.segment}/form`)).body.data;
      const answers = Object.fromEntries((form.fields as FormFieldDef[]).filter((f) => f.type !== 'file').map((f) => [f.key, sample(f)]));
      const draft = await admin.put(`${API}/leads/${lead.id}/requirement`).send({ data: { [Object.keys(answers)[0]!]: Object.values(answers)[0] } });
      const complete = await admin.put(`${API}/leads/${lead.id}/requirement`).send({ data: answers, complete: true });
      statuses.push([`requirement draft ${lead.id}`, draft.status], [`requirement complete ${lead.id}`, complete.status]);
      statuses.push([`site ${lead.id}`, (await admin.put(`${API}/leads/${lead.id}/site`).send({ pending_dues: false, existing_solar_kw: 0 })).status]);
    }
    expect(statuses.filter(([, s]) => s >= 500)).toEqual([]);
    const ok = statuses.filter(([, s]) => s < 300).length;
    expect(ok).toBeGreaterThan(20);

    const candidate = data.leads!.find((l) => l.status === 'qualified')!;
    const when = new Date(T0.getTime() + 2 * 86_400_000).toISOString();
    const sched = await admin.post(`${API}/surveys`).send({ lead_id: candidate.id, scheduled_at: when, surveyor_id: idOf('dsm') });
    expect(sched.status).toBeLessThan(500);
    if (sched.status === 201) {
      const done = await admin.patch(`${API}/surveys/${sched.body.data.id}`).send({ status: 'completed', shading: 'low', roof_type: 'rcc', roof_area_sqm: 30 });
      expect(done.status).toBeLessThan(500);
      const feas = await admin.patch(`${API}/surveys/${sched.body.data.id}/feasibility`).send({ submitted_at: T0.toISOString() });
      expect(feas.status).toBeLessThan(500);
    }
    const conv = await admin.post(`${API}/leads/${candidate.id}/convert`).send({ requirement_confirmed: true, timeline_confirmed: true, commercial_potential_confirmed: true });
    expect([201, 422, 409]).toContain(conv.status);
    // existing opportunities convert idempotently
    const existing = data.opportunities![0]!;
    const again = await admin.post(`${API}/leads/${existing.lead_id}/convert`).send({});
    expect(again.status).toBe(200);
    expect(again.body.data.opportunity.id).toBe(existing.id);
    // board moves on seeded deals never 5xx
    for (const o of data.opportunities!.slice(0, 6)) {
      for (const stage of ['quotation', 'won']) expect((await admin.post(`${API}/opportunities/${o.id}/stage`).send({ stage })).status).toBeLessThan(500);
      expect((await admin.patch(`${API}/opportunities/${o.id}`).send({ probability: 55, expected_commissioning_date: '2026-12-15' })).status).toBeLessThan(500);
    }
  });
});
