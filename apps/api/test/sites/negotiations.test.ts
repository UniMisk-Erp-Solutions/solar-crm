import { describe, expect, it } from 'vitest';
import { IDS } from '../helpers/env';
import { API, makeEnv, seedLead } from './fixtures';

describe('rate negotiation log (step 18)', () => {
  it('logs rounds newest first and summarises the gap', async () => {
    const env = await makeEnv();
    const lead = await seedLead(env, { capacity_kw: 5 });
    const url = `${API}/leads/${lead.id}/negotiations`;
    const one = await env.as('dsm').post(url).send({ quoted_rate_per_kw: 52000, notes: 'Opening quote' });
    expect(one.status).toBe(201);
    expect(one.body.data.row).toMatchObject({ lead_id: lead.id, quoted_rate_per_kw: 52000, customer_counter_per_kw: null, logged_by: IDS.profile('dsm'), opportunity_id: null });
    env.advance(3_600_000);
    await env.as('dsm').post(url).send({ customer_counter_per_kw: 46000 });
    env.advance(3_600_000);
    const third = await env.as('dsm').post(url).send({ quoted_rate_per_kw: 50000, customer_counter_per_kw: 47000, notes: 'Meeting in the middle' });
    expect(third.body.data.summary).toMatchObject({ rounds: 3, latest_quoted_rate_per_kw: 50000, latest_counter_per_kw: 47000, gap_per_kw: 3000, gap_pct: 6, gap_total_inr: 15000, kw: 5 });

    const list = await env.as('dsm').get(url);
    expect(list.body.data.rows.map((r: { notes: string | null }) => r.notes)).toEqual(['Meeting in the middle', null, 'Opening quote']);
    expect(list.body.data.summary.rounds).toBe(3);
    const fresh = (await env.db.table('leads').get(lead.id))!;
    expect(fresh.last_action).toBe('Rate negotiation');
    expect((await env.db.table('lead_events').all({ lead_id: lead.id })).filter((e) => e.event_type === 'negotiation_logged')).toHaveLength(3);
    expect((await env.db.table('audit_log').all()).some((a) => a.source === 'api' && a.action === 'negotiation.log')).toBe(true);
  });

  it('validates the entry', async () => {
    const env = await makeEnv();
    const lead = await seedLead(env);
    const url = `${API}/leads/${lead.id}/negotiations`;
    expect((await env.as('dsm').post(url).send({})).status).toBe(422);
    expect((await env.as('dsm').post(url).send({ quoted_rate_per_kw: -5 })).status).toBe(422);
    expect((await env.as('dsm').post(url).send({ quoted_rate_per_kw: 'lots' })).status).toBe(422);
    expect((await env.as('dsm').post(url).send({ notes: 'Customer wants a call back' })).status).toBe(201);
    const early = await seedLead(env, { status: 'assigned' });
    expect((await env.as('dsm').post(`${API}/leads/${early.id}/negotiations`).send({ quoted_rate_per_kw: 50000 })).body.error.code).toBe('INVALID_STATE');
  });

  it('is scoped to the lead’s own channel', async () => {
    const env = await makeEnv();
    const lead = await seedLead(env);
    const url = `${API}/leads/${lead.id}/negotiations`;
    expect((await env.as('distributor_user').post(url).send({ quoted_rate_per_kw: 50000 })).status).toBe(201);
    expect((await env.as(IDS.distributorUserB).get(url)).status).toBe(403);
    expect((await env.as(IDS.distributorUserB).post(url).send({ quoted_rate_per_kw: 1 })).status).toBe(403);
    expect((await env.as('viewer').post(url).send({ quoted_rate_per_kw: 1 })).status).toBe(403);
    expect((await env.as('viewer').get(url)).body.data.rows).toHaveLength(1);
  });
});
