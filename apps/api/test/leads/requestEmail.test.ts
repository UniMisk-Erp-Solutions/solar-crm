import { describe, expect, it } from 'vitest';
import { signRequestToken, verifyRequestToken } from '../../src/lib/actionToken';
import { API, IDS, leadEnv, person, type LeadEnv } from './helpers';
import request from 'supertest';

let n = 0;
const mobile = () => `9${String(300000000 + ++n * 13).padStart(9, '0')}`;
const ORIGIN = 'https://crm.example.test';

async function setup() {
  const env = leadEnv();
  await env.rule('routing.mode', 'select');
  for (const id of [IDS.distributorA, IDS.distributorB]) await env.db.table('distributors').update(id, { email: 'pp4835631@gmail.com' });
  const r = await env.u('admin').post(`${API}/leads`).send({ ...person({ name: 'Meera Joshi', mobile: mobile(), email: undefined }), source: 'call_centre', consent: undefined });
  const id = r.body.data.lead.id as string;
  return { env, id };
}
const send = (env: LeadEnv, id: string, ids: string[]) => env.u('admin').post(`${API}/leads/${id}/requests`).set('Origin', ORIGIN).send({ distributor_ids: ids });
const anon = (env: LeadEnv) => request(env.app);
const tokenIn = (text: string, action: 'accept' | 'reject'): string => {
  const line = text.split('\n').find((l) => l.startsWith(action === 'accept' ? 'Accept: ' : 'Decline: ')) ?? '';
  const m = /lead-request\/([^?\s]+)\?do=/.exec(line);
  if (!m) throw new Error(`no link in: ${text}`);
  return m[1]!;
};

describe('action token', () => {
  it('verifies its own signature, rejects tampering and expiry', () => {
    const exp = new Date(Date.now() + 60_000);
    const t = signRequestToken('o1', 'a1', exp);
    expect(verifyRequestToken(t)).toMatchObject({ o: 'o1', a: 'a1' });
    expect(verifyRequestToken(t.slice(0, -2) + 'xx')).toBeNull();
    expect(verifyRequestToken(t, new Date(exp.getTime() + 5000))).toBeNull();
    expect(verifyRequestToken('garbage')).toBeNull();
  });
});

describe('e-mailed request: distributors answer from the link', () => {
  it('e-mails every chosen distributor with working accept and decline links', async () => {
    const { env, id } = await setup();
    const res = await send(env, id, [IDS.distributorA, IDS.distributorB]);
    expect(res.status).toBe(200);
    expect(res.body.data.emails.sent).toHaveLength(2);
    const mails = env.providers.calls.email;
    expect(mails).toHaveLength(2);
    expect(mails[0]!.to).toBe('pp4835631@gmail.com');
    expect(mails[0]!.subject).toMatch(/solar lead/i);
    expect(mails[0]!.html).toContain('Review and accept');
    expect(tokenIn(mails[0]!.text, 'accept')).toBeTruthy();
  });

  it('reports distributors without an address instead of failing the request', async () => {
    const { env, id } = await setup();
    await env.db.table('distributors').update(IDS.distributorB, { email: null });
    const res = await send(env, id, [IDS.distributorA, IDS.distributorB]);
    expect(res.status).toBe(200);
    expect(res.body.data.emails.sent).toHaveLength(1);
    expect(res.body.data.emails.skipped).toHaveLength(1);
    expect(await env.lead(id)).toMatchObject({ status: 'assigned' });
  });

  it('viewing the link changes nothing and hides the number; confirming accepts, shows the number and updates the lead', async () => {
    const { env, id } = await setup();
    await send(env, id, [IDS.distributorA, IDS.distributorB]);
    const tokA = tokenIn(env.providers.calls.email[0]!.text, 'accept');
    const view = await anon(env).get(`${API}/public/lead-requests/${tokA}`);
    expect(view.status).toBe(200);
    expect(view.body.data.state).toBe('open');
    expect(view.body.data.lead.mobile).toContain('•');
    expect((await env.lead(id)).status).toBe('assigned');

    const ok = await anon(env).post(`${API}/public/lead-requests/${tokA}/respond`).send({ action: 'accept' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.state).toBe('accepted');
    expect(ok.body.data.lead.mobile).not.toContain('•');
    expect(await env.lead(id)).toMatchObject({ status: 'accepted' });
    // pressing again is harmless
    expect((await anon(env).post(`${API}/public/lead-requests/${tokA}/respond`).send({ action: 'accept' })).status).toBe(200);
  });

  it('the first to accept wins; the second gets a "taken" answer', async () => {
    const { env, id } = await setup();
    await send(env, id, [IDS.distributorA, IDS.distributorB]);
    const [a, b] = env.providers.calls.email.map((m) => tokenIn(m.text, 'accept'));
    expect((await anon(env).post(`${API}/public/lead-requests/${b}/respond`).send({ action: 'accept' })).status).toBe(200);
    const late = await anon(env).post(`${API}/public/lead-requests/${a}/respond`).send({ action: 'accept' });
    expect(late.status).toBe(409);
    expect(late.body.error.details.state).toBe('taken');
    const lead = await env.lead(id);
    expect(lead.status).toBe('accepted');
    expect(lead.distributor_id).toBe(IDS.distributorB);
  });

  it('declining needs a reason; the last decline sends the lead back to be chosen again', async () => {
    const { env, id } = await setup();
    await send(env, id, [IDS.distributorA]);
    const t = tokenIn(env.providers.calls.email[0]!.text, 'reject');
    expect((await anon(env).post(`${API}/public/lead-requests/${t}/respond`).send({ action: 'reject' })).status).toBe(422);
    const r = await anon(env).post(`${API}/public/lead-requests/${t}/respond`).send({ action: 'reject', reason: 'Outside our area' });
    expect(r.status).toBe(200);
    expect(r.body.data.state).toBe('declined');
    expect(await env.lead(id)).toMatchObject({ status: 'unassigned' });
  });

  it('refuses a forged or expired link', async () => {
    const { env, id } = await setup();
    await send(env, id, [IDS.distributorA]);
    const t = tokenIn(env.providers.calls.email[0]!.text, 'accept');
    expect((await anon(env).get(`${API}/public/lead-requests/${t}x`)).status).toBe(404);
    env.advance(30 * 86_400_000);
    expect((await anon(env).get(`${API}/public/lead-requests/${t}`)).status).toBe(404);
  });
});
