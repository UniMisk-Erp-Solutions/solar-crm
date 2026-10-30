import { describe, expect, it } from 'vitest';
import { API, IDS, leadEnv, person, type LeadEnv } from './helpers';

let n = 0;
const mobile = () => `9${String(200000000 + ++n * 11).padStart(9, '0')}`;

async function newLead(env: LeadEnv) {
  const r = await env.u('admin').post(`${API}/leads`).send({ ...person({ name: 'Meera Joshi', mobile: mobile(), email: undefined }), source: 'call_centre', consent: undefined });
  expect(r.status).toBe(201);
  return r.body.data.lead.id as string;
}
const pendingOf = async (env: LeadEnv, id: string) => (await env.db.table('lead_assignments').all({ lead_id: id })).filter((a) => a.status === 'pending');

describe('select mode: the system suggests, a person chooses whom to ask, the first to accept gets the lead', () => {
  it('saving the inquiry assigns nobody; it waits with ranked suggestions', async () => {
    const env = leadEnv();
    await env.rule('routing.mode', 'select');
    const id = await newLead(env);
    const lead = await env.lead(id);
    expect(lead).toMatchObject({ status: 'validated', distributor_id: null });
    expect(await env.db.table('lead_assignments').count({ lead_id: id })).toBe(0);

    const s = await env.u('admin').get(`${API}/leads/${id}/suggestions`);
    expect(s.status).toBe(200);
    const cands = s.body.data.candidates as { distributor_id: string; eligible: boolean; recommended: boolean; reasons: string[] }[];
    expect(cands.length).toBeGreaterThanOrEqual(2);
    expect(cands.some((c) => c.recommended)).toBe(true);
    expect(cands.filter((c) => c.recommended).every((c) => c.eligible)).toBe(true);
  });

  it('a request can go to several distributors, even ones that are not a perfect match; the first to accept wins and the rest close', async () => {
    const env = leadEnv();
    await env.rule('routing.mode', 'select');
    const id = await newLead(env);
    const send = await env.u('admin').post(`${API}/leads/${id}/requests`).send({ distributor_ids: [IDS.distributorA, IDS.distributorB] });
    expect(send.status).toBe(200);
    expect(await env.lead(id)).toMatchObject({ status: 'assigned', distributor_id: null });
    expect(await pendingOf(env, id)).toHaveLength(2);
    expect((await env.db.table('clocks').all({ entity_type: 'lead', entity_id: id })).filter((c) => c.clock_type === 'lead_acceptance')).toHaveLength(1);

    // two distributors were asked: accepting without saying who is refused
    expect((await env.u('admin').post(`${API}/leads/${id}/accept`).send({})).status).toBe(422);
    const ok = await env.u('admin').post(`${API}/leads/${id}/accept`).send({ distributor_id: IDS.distributorB });
    expect(ok.status).toBe(200);
    expect(await env.lead(id)).toMatchObject({ status: 'accepted', distributor_id: IDS.distributorB });
    const rows = await env.db.table('lead_assignments').all({ lead_id: id });
    expect(rows.find((a) => a.distributor_id === IDS.distributorB)?.status).toBe('accepted');
    expect(rows.find((a) => a.distributor_id === IDS.distributorA)?.status).toBe('reassigned');
    expect(await pendingOf(env, id)).toHaveLength(0);
  });

  it('one rejection keeps the lead waiting for the others; the last rejection sends it back to be chosen again', async () => {
    const env = leadEnv();
    await env.rule('routing.mode', 'select');
    const id = await newLead(env);
    await env.u('admin').post(`${API}/leads/${id}/requests`).send({ distributor_ids: [IDS.distributorA, IDS.distributorB] });
    const first = await env.u('admin').post(`${API}/leads/${id}/reject`).send({ reason: 'No capacity this month', distributor_id: IDS.distributorA });
    expect(first.status).toBe(200);
    expect(await env.lead(id)).toMatchObject({ status: 'assigned', distributor_id: null });
    expect(await pendingOf(env, id)).toHaveLength(1);

    const last = await env.u('admin').post(`${API}/leads/${id}/reject`).send({ reason: 'Outside our area' });
    expect(last.status).toBe(200);
    expect(await env.lead(id)).toMatchObject({ status: 'unassigned', distributor_id: null });
    // and a new choice can be made, including a distributor that already said no
    const again = await env.u('admin').post(`${API}/leads/${id}/requests`).send({ distributor_ids: [IDS.distributorA] });
    expect(again.status).toBe(200);
    expect(await env.lead(id)).toMatchObject({ status: 'assigned' });
  });

  it('more distributors can be added while the first request is still waiting, and an unknown or duplicate request is refused', async () => {
    const env = leadEnv();
    await env.rule('routing.mode', 'select');
    const id = await newLead(env);
    await env.u('admin').post(`${API}/leads/${id}/requests`).send({ distributor_ids: [IDS.distributorA] });
    const dueBefore = (await env.lead(id)).sla_due_at;
    const more = await env.u('admin').post(`${API}/leads/${id}/requests`).send({ distributor_ids: [IDS.distributorB] });
    expect(more.status).toBe(200);
    expect(await pendingOf(env, id)).toHaveLength(2);
    expect((await env.lead(id)).sla_due_at).toBe(dueBefore); // the acceptance time is not restarted
    expect((await env.u('admin').post(`${API}/leads/${id}/requests`).send({ distributor_ids: [IDS.distributorA] })).status).toBe(422);
    expect((await env.u('admin').post(`${API}/leads/${id}/requests`).send({ distributor_ids: ['00000000-0000-4000-8000-000000000000'] })).status).toBe(404);
  });

  it('with the old automatic mode nothing changes: the best match is assigned at once', async () => {
    const env = leadEnv();
    await env.rule('routing.mode', 'auto');
    const id = await newLead(env);
    expect((await env.lead(id)).status).toBe('assigned');
    expect((await env.lead(id)).distributor_id).not.toBeNull();
  });
});
