import { afterEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '@solar/shared';
import { buildSeed } from '@solar/shared/seed';
import { bindPlatformDeps } from '../../src/jobs';
import type { TableName } from '@solar/shared';
import type { Db } from '../../src/db/types';
import { createUser, loadWorkCalendar, resetDemo, setAuthAdminFactory, setUserActive, type AuthAdmin } from '../../src/services/adminService';
import { IDS } from '../helpers/env';
import { mkLead, platformEnv } from './fixtures';

const api = '/api/v1';
afterEach(() => setAuthAdminFactory(null));

const newUser = (over: Record<string, unknown> = {}) => ({ email: 'Priya.Shah@Example.com', full_name: 'Priya Shah', role: 'dsm', territory_ids: [IDS.territoryAhmedabad], ...over });

describe('admin users', () => {
  it('creates a user (demo mode: a generated id), lowercases the e-mail and syncs territories', async () => {
    const env = platformEnv();
    const r = await env.as('admin').post(`${api}/admin/users`).send(newUser());
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ email: 'priya.shah@example.com', role: 'dsm', role_label: expect.any(String), active: true, territory_names: ['Ahmedabad'], language: 'en' });
    const id = r.body.data.id as string;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const profile = (await env.db.table('profiles').get(id))!;
    expect(profile.territory_ids).toEqual([IDS.territoryAhmedabad]);
    expect(profile.org_id).toBe(IDS.org);
    expect(await env.db.table('user_territories').count({ user_id: id, territory_id: IDS.territoryAhmedabad })).toBe(1);
    expect((await env.db.table('audit_log').all({ action: 'user.create' }))).toHaveLength(1);
    // the new user can sign in (demo token) and sees their own profile
    expect((await env.as(id).get(`${api}/auth/me`)).status).toBe(200);
    expect((await env.as('admin').post(`${api}/admin/users`).send(newUser())).status).toBe(409);
  });

  it('is admin-only and validates role/party consistency', async () => {
    const env = platformEnv();
    for (const role of ['management', 'compliance_officer', 'dsm', 'distributor_user']) {
      expect((await env.as(role).post(`${api}/admin/users`).send(newUser({ email: `${role}@x.com` }))).status, role).toBe(403);
      expect((await env.as(role).get(`${api}/admin/users`)).status, role).toBe(403);
    }
    const as = env.as('admin');
    const noParty = await as.post(`${api}/admin/users`).send(newUser({ email: 'a@x.com', role: 'distributor_user' }));
    expect(noParty.status).toBe(422);
    expect(noParty.body.error.details[0].path).toBe('distributor_id');
    expect((await as.post(`${api}/admin/users`).send(newUser({ email: 'b@x.com', role: 'distributor_user', distributor_id: IDS.distributorA, dealer_id: IDS.dealerA1 }))).status).toBe(422);
    expect((await as.post(`${api}/admin/users`).send(newUser({ email: 'c@x.com', role: 'dsm', distributor_id: IDS.distributorA }))).status).toBe(422);
    expect((await as.post(`${api}/admin/users`).send(newUser({ email: 'd@x.com', territory_ids: [IDS.org] }))).status).toBe(422);
    expect((await as.post(`${api}/admin/users`).send(newUser({ email: 'not-an-email' }))).status).toBe(422);
    const dealer = await as.post(`${api}/admin/users`).send(newUser({ email: 'e@x.com', role: 'dealer_user', dealer_id: IDS.dealerB1, territory_ids: [] }));
    expect(dealer.status).toBe(201);
    expect(dealer.body.data).toMatchObject({ distributor_id: IDS.distributorB, dealer_name: 'Gamma Solar Dealers' });
    expect((await as.post(`${api}/admin/users`).send(newUser({ email: 'f@x.com', role: 'dealer_user', dealer_id: IDS.dealerB1, distributor_id: IDS.distributorA }))).status).toBe(422);
  });

  it('updates role, party, territories and language; clears the party when moving to an internal role', async () => {
    const env = platformEnv();
    const as = env.as('admin');
    const made = await as.post(`${api}/admin/users`).send(newUser({ email: 'ext@x.com', role: 'distributor_user', distributor_id: IDS.distributorA, territory_ids: [] }));
    const id = made.body.data.id as string;
    const toDealer = await as.patch(`${api}/admin/users/${id}`).send({ role: 'dealer_user', dealer_id: IDS.dealerA2 });
    expect(toDealer.body.data).toMatchObject({ role: 'dealer_user', dealer_id: IDS.dealerA2, distributor_id: IDS.distributorA });
    const internal = await as.patch(`${api}/admin/users/${id}`).send({ role: 'sales_manager', territory_ids: [IDS.territoryAhmedabad, IDS.territorySurat], language: 'gu', designation: 'Regional lead' });
    expect(internal.status).toBe(200);
    expect(internal.body.data).toMatchObject({ role: 'sales_manager', distributor_id: null, dealer_id: null, language: 'gu', designation: 'Regional lead' });
    expect(await env.db.table('user_territories').count({ user_id: id })).toBe(2);
    const fewer = await as.patch(`${api}/admin/users/${id}`).send({ territory_ids: [IDS.territorySurat] });
    expect(fewer.body.data.territory_names).toEqual(['Surat']);
    expect(await env.db.table('user_territories').count({ user_id: id })).toBe(1);
    expect((await as.patch(`${api}/admin/users/${id}`).send({})).status).toBe(422);
    expect((await as.patch(`${api}/admin/users/${id}`).send({ reports_to: id })).status).toBe(422);
    expect((await as.patch(`${api}/admin/users/${IDS.org}`).send({ language: 'hi' })).status).toBe(404);
    const list = await as.get(`${api}/admin/users?role=sales_manager&q=ext`);
    expect(list.body.total).toBe(1);
    expect((await as.get(`${api}/admin/users?active=true&limit=5`)).body.data.length).toBeLessThanOrEqual(5);
  });

  it('deactivates and reactivates; a deactivated user can no longer sign in', async () => {
    const env = platformEnv();
    const made = await env.as('admin').post(`${api}/admin/users`).send(newUser({ email: 'leaver@x.com' }));
    const id = made.body.data.id as string;
    const off = await env.as('admin').post(`${api}/admin/users/${id}/deactivate`).send({ reason: 'Left the company' });
    expect(off.body.data.active).toBe(false);
    expect((await env.as(id).get(`${api}/auth/me`)).status).toBe(403);
    expect((await env.as('admin').post(`${api}/admin/users/${id}/activate`)).body.data.active).toBe(true);
    expect((await env.as(id).get(`${api}/auth/me`)).status).toBe(200);
    expect((await env.db.table('audit_log').all({ action: 'user.deactivate' }))[0]!.detail).toMatchObject({ reason: 'Left the company' });
  });

  it('never leaves the system without an active administrator', async () => {
    const env = platformEnv();
    const as = env.as('admin');
    // the seeded admin cannot deactivate or demote themselves
    expect((await as.post(`${api}/admin/users/${IDS.profile('admin')}/deactivate`).send({})).status).toBe(422);
    const self = await as.patch(`${api}/admin/users/${IDS.profile('admin')}`).send({ role: 'management' });
    expect(self.status).toBe(422);
    expect(self.body.error.message).toMatch(/last active administrator/i);

    const second = await as.post(`${api}/admin/users`).send(newUser({ email: 'admin2@x.com', role: 'admin', territory_ids: [] }));
    const b = second.body.data.id as string;
    // with two admins, one may be demoted ...
    const demote = await env.as(b).patch(`${api}/admin/users/${IDS.profile('admin')}`).send({ role: 'management' });
    expect(demote.status).toBe(200);
    // ... but now B is the last one: demoting or deactivating B (even via someone else) is refused
    expect((await env.as(b).patch(`${api}/admin/users/${b}`).send({ role: 'dsm' })).status).toBe(422);
    expect((await env.as(b).post(`${api}/admin/users/${b}/deactivate`).send({})).status).toBe(422);
    // the guard also protects the service when called directly (e.g. by a script)
    const ctx = env.ctx(b);
    await expect(setUserActive(ctx, IDS.profile('management'), false)).resolves.toBeTruthy(); // not an admin: fine
    expect(await env.db.table('profiles').count({ role: 'admin', active: true })).toBe(1);
  });

  it('live mode: creates the Supabase Auth user first and uses its id as profiles.id; rolls back on failure; bans on deactivate', async () => {
    const env = platformEnv();
    const calls: string[] = [];
    const fake: AuthAdmin = {
      createUser: async (i) => { calls.push(`create:${i.email}:${i.send_invite}`); return { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }; },
      deleteUser: async (id) => { calls.push(`delete:${id}`); },
      setBanned: async (id, banned) => { calls.push(`ban:${id}:${banned}`); },
    };
    setAuthAdminFactory(() => fake);
    const ctx = env.ctx('admin');
    const view = await createUser(ctx, { email: 'live@x.com', full_name: 'Live User', role: 'accounts', territory_ids: [], language: 'en', send_invite: true });
    expect(view.id).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    expect(calls).toEqual(['create:live@x.com:true']);
    expect((await env.db.table('profiles').get(view.id))!.email).toBe('live@x.com');
    await setUserActive(ctx, view.id, false);
    await setUserActive(ctx, view.id, true);
    expect(calls.slice(1)).toEqual([`ban:${view.id}:true`, `ban:${view.id}:false`]);
    // a validation failure never touches Auth
    await expect(createUser(ctx, { email: 'bad@x.com', full_name: 'Bad Role', role: 'dealer_user', territory_ids: [], language: 'en', send_invite: false })).rejects.toMatchObject({ status: 422 });
    expect(calls.some((c) => c.includes('bad@x.com'))).toBe(false);
    // a failed profile insert deletes the Auth account again
    const failingCtx = env.ctx('admin');
    const realDb = failingCtx.db;
    const failingDb: Db = {
      table: <K extends TableName>(name: K) => {
        const t = realDb.table(name);
        return (name === 'profiles' ? { ...t, insert: async () => { throw new Error('db down'); } } : t) as typeof t;
      },
    };
    failingCtx.db = failingDb;
    await expect(createUser(failingCtx, { email: 'rollback@x.com', full_name: 'Roll Back', role: 'viewer', territory_ids: [], language: 'en', send_invite: false })).rejects.toThrow('db down');
    expect(calls).toContain('delete:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  });
});

describe('admin territories', () => {
  const terr = (over: Record<string, unknown> = {}) => ({ name: 'Rajkot', state: 'Gujarat', district: 'Rajkot', pincode_ranges: [{ from: '360001', to: '360999' }], ...over });

  it('creates, lists, updates and deletes; ranges are validated and overlaps need confirmation', async () => {
    const env = platformEnv();
    const as = env.as('admin');
    const made = await as.post(`${api}/admin/territories`).send(terr({ dsm_id: IDS.profile('dsm') }));
    expect(made.status).toBe(201);
    expect(made.body.data).toMatchObject({ name: 'Rajkot', dsm_name: 'Test dsm', user_count: 0, active: true });
    expect((await as.post(`${api}/admin/territories`).send(terr())).status).toBe(409); // same name
    expect((await as.post(`${api}/admin/territories`).send(terr({ name: 'Bad range', pincode_ranges: [{ from: '360999', to: '360001' }] }))).status).toBe(422);
    expect((await as.post(`${api}/admin/territories`).send(terr({ name: 'Bad pin', pincode_ranges: [{ from: '12', to: '360001' }] }))).status).toBe(422);
    const overlap = await as.post(`${api}/admin/territories`).send(terr({ name: 'Ahmedabad East', pincode_ranges: [{ from: '382000', to: '383000' }] }));
    expect(overlap.status).toBe(409);
    expect(overlap.body.error.details.overlapping_territories).toEqual(['Ahmedabad']);
    expect((await as.post(`${api}/admin/territories`).send(terr({ name: 'Ahmedabad East', district: 'Ahmedabad', pincode_ranges: [{ from: '382000', to: '383000' }], allow_overlap: true }))).status).toBe(201);
    expect((await as.post(`${api}/admin/territories`).send(terr({ name: 'Ghost', dsm_id: IDS.profile('distributor_user') }))).status).toBe(422);

    const list = await env.as('dsm').get(`${api}/admin/territories?state=Gujarat&q=raj`);
    expect(list.body.total).toBe(1);
    expect((await env.as('dsm').post(`${api}/admin/territories`).send(terr({ name: 'Nope' }))).status).toBe(403);
    expect((await env.as('distributor_user').get(`${api}/admin/territories`)).status).toBe(403);
    const upd = await as.patch(`${api}/admin/territories/${made.body.data.id}`).send({ pincode_ranges: [{ from: '360001', to: '361999' }], active: true });
    expect(upd.body.data.pincode_ranges).toEqual([{ from: '360001', to: '361999' }]);
    expect((await as.patch(`${api}/admin/territories/${made.body.data.id}`).send({ name: 'Surat' })).status).toBe(409);
    expect((await as.get(`${api}/admin/territories/${made.body.data.id}`)).body.data.name).toBe('Rajkot');
    expect((await as.delete(`${api}/admin/territories/${made.body.data.id}`)).status).toBe(200);
    expect((await as.get(`${api}/admin/territories/${made.body.data.id}`)).status).toBe(404);
  });

  it('refuses to delete a territory that is in use, and assigns users through user_territories', async () => {
    const env = platformEnv();
    const as = env.as('admin');
    await mkLead(env);
    const used = await as.delete(`${api}/admin/territories/${IDS.territoryAhmedabad}`);
    expect(used.status).toBe(409);
    expect(used.body.error.details.leads).toBe(1);

    const assign = await as.put(`${api}/admin/territories/${IDS.territorySurat}/users`).send({ user_ids: [IDS.profile('dsm'), IDS.profile('sales_manager')] });
    expect(assign.status).toBe(200);
    expect(assign.body.data.map((u: { id: string }) => u.id).sort()).toEqual([IDS.profile('dsm'), IDS.profile('sales_manager')].sort());
    expect((await env.db.table('profiles').get(IDS.profile('dsm')))!.territory_ids).toEqual([IDS.territorySurat]);
    expect((await as.get(`${api}/admin/territories/${IDS.territorySurat}`)).body.data.user_count).toBe(2);
    const shrink = await as.put(`${api}/admin/territories/${IDS.territorySurat}/users`).send({ user_ids: [IDS.profile('sales_manager')] });
    expect(shrink.body.data).toHaveLength(1);
    expect((await env.db.table('profiles').get(IDS.profile('dsm')))!.territory_ids).toEqual([]);
    expect((await as.get(`${api}/admin/territories/${IDS.territorySurat}/users`)).body.data).toHaveLength(1);
    expect((await as.put(`${api}/admin/territories/${IDS.territorySurat}/users`).send({ user_ids: [IDS.profile('distributor_user')] })).status).toBe(422);
    expect((await as.put(`${api}/admin/territories/${IDS.territorySurat}/users`).send({ user_ids: [IDS.org] })).status).toBe(422);
    // an unused territory can be deleted
    expect((await as.delete(`${api}/admin/territories/${IDS.territorySurat}`)).status).toBe(409); // still has users and distributors
    await as.put(`${api}/admin/territories/${IDS.territorySurat}/users`).send({ user_ids: [] });
    await env.db.table('distributors').update(IDS.distributorA, { territory_ids: [IDS.territoryAhmedabad] });
    await env.db.table('distributors').update(IDS.distributorB, { territory_ids: [IDS.territoryAhmedabad] });
    expect((await as.delete(`${api}/admin/territories/${IDS.territorySurat}`)).status).toBe(200);
  });
});

describe('admin message templates — versioning and validation', () => {
  const sms = (over: Record<string, unknown> = {}) => ({ key: 'lead.welcome', channel: 'sms', category: 'utility', purpose: 'service', language: 'en', body: 'Thank you for your enquiry with Future Solar.', dlt_template_id: '1107161234567890123', dlt_header: 'FUTSOL', ...over });

  it('validates DLT, WhatsApp and e-mail fields', async () => {
    const env = platformEnv();
    const as = env.as('admin');
    const noDlt = await as.post(`${api}/admin/templates`).send(sms({ dlt_template_id: undefined, dlt_header: undefined }));
    expect(noDlt.status).toBe(422);
    expect(noDlt.body.error.details.map((d: { path: string }) => d.path)).toEqual(expect.arrayContaining(['dlt_template_id', 'dlt_header']));
    expect((await as.post(`${api}/admin/templates`).send(sms({ dlt_template_id: 'abc' }))).status).toBe(422);
    expect((await as.post(`${api}/admin/templates`).send(sms({ dlt_header: 'no spaces!' }))).status).toBe(422);
    const wa = { key: 'quote.sent', channel: 'whatsapp', category: 'utility', purpose: 'service', language: 'en', body: 'Hello {{1}}, your quote is ready.' };
    expect((await as.post(`${api}/admin/templates`).send(wa)).body.error.details[0].path).toBe('whatsapp_template_name');
    expect((await as.post(`${api}/admin/templates`).send({ ...wa, whatsapp_template_name: 'Quote Sent' })).status).toBe(422);
    expect((await as.post(`${api}/admin/templates`).send({ ...wa, purpose: 'promotional', whatsapp_template_name: 'quote_sent' })).body.error.details[0].path).toBe('category');
    expect((await as.post(`${api}/admin/templates`).send({ ...wa, body: 'Hello {{1, ready', whatsapp_template_name: 'quote_sent' })).status).toBe(422);
    expect((await as.post(`${api}/admin/templates`).send({ ...wa, dlt_header: 'FUTSOL', whatsapp_template_name: 'quote_sent' })).status).toBe(422);
    expect((await as.post(`${api}/admin/templates`).send({ key: 'mail.a', channel: 'email', category: 'utility', purpose: 'service', body: 'Hi' })).body.error.details[0].path).toBe('subject');
    expect((await as.post(`${api}/admin/templates`).send({ ...wa, whatsapp_template_name: 'quote_sent' })).status).toBe(201);
    expect((await env.as('dsm').post(`${api}/admin/templates`).send(sms())).status).toBe(403);
  });

  it('an edit creates version + 1 and retires the old one; older versions cannot be edited; rollback works', async () => {
    const env = platformEnv();
    const as = env.as('compliance_officer');
    const v1 = (await as.post(`${api}/admin/templates`).send(sms())).body.data;
    expect(v1).toMatchObject({ version: 1, active: true });
    expect((await as.post(`${api}/admin/templates`).send(sms())).status).toBe(409); // same key/channel/language

    const v2res = await as.patch(`${api}/admin/templates/${v1.id}`).send({ body: 'Thank you for choosing Future Solar. We will call you shortly.' });
    expect(v2res.status).toBe(200);
    const v2 = v2res.body.data;
    expect(v2).toMatchObject({ version: 2, active: true, key: 'lead.welcome', dlt_template_id: '1107161234567890123' });
    expect(v2.id).not.toBe(v1.id);
    expect((await env.db.table('message_templates').get(v1.id))).toMatchObject({ active: false, body: v1.body }); // the old text is untouched
    expect(await env.db.table('message_templates').count({ key: 'lead.welcome', active: true })).toBe(1);

    const stale = await as.patch(`${api}/admin/templates/${v1.id}`).send({ body: 'edit the old one' });
    expect(stale.status).toBe(409);
    expect(stale.body.error.details).toMatchObject({ latest_id: v2.id, latest_version: 2 });
    // an invalid edit changes nothing
    expect((await as.patch(`${api}/admin/templates/${v2.id}`).send({ dlt_header: '!!' })).status).toBe(422);
    // an identical edit does not create a version
    const same = await as.patch(`${api}/admin/templates/${v2.id}`).send({ body: v2.body });
    expect(same.body.data.id).toBe(v2.id);
    expect(await env.db.table('message_templates').count({ key: 'lead.welcome' })).toBe(2);

    const hist = await as.get(`${api}/admin/templates/${v2.id}/history`);
    expect(hist.body.data.map((t: { version: number }) => t.version)).toEqual([2, 1]);
    const latest = await as.get(`${api}/admin/templates?latest=true`);
    expect(latest.body.data.map((t: { version: number }) => t.version)).toEqual([2]);
    expect((await as.get(`${api}/admin/templates`)).body.total).toBe(2);
    expect((await as.get(`${api}/admin/templates?active=true&channel=sms`)).body.total).toBe(1);

    const rollback = await as.post(`${api}/admin/templates/${v1.id}/activate`);
    expect(rollback.body.data).toMatchObject({ version: 1, active: true });
    expect((await env.db.table('message_templates').get(v2.id))!.active).toBe(false);
    expect((await as.post(`${api}/admin/templates/${v1.id}/deactivate`)).body.data.active).toBe(false);
    // editing a deactivated template keeps it deactivated until someone activates it
    const v3 = (await as.patch(`${api}/admin/templates/${v2.id}`).send({ body: 'Draft for next month' })).body.data;
    expect(v3).toMatchObject({ version: 3, active: false });
    const actions = (await env.db.table('audit_log').all({ source: 'api' })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['template.create', 'template.revise', 'template.activate', 'template.deactivate']));
  });
});

describe('admin approval rules', () => {
  const rule = (over: Record<string, unknown> = {}) => ({ lane: 'commercial', name: 'Up to 5 L — DSM', min_value: 0, max_value: 500000, role_chain: ['dsm'], sla_hours: 8, ...over });

  it('creates, validates, lists, updates and deletes (admin writes, finance leadership reads)', async () => {
    const env = platformEnv();
    const as = env.as('admin');
    const made = await as.post(`${api}/admin/approval-rules`).send(rule());
    expect(made.status).toBe(201);
    expect(made.body.data).toMatchObject({ lane: 'commercial', role_chain: ['dsm'], active: true, sla_hours: 8 });
    expect((await as.post(`${api}/admin/approval-rules`).send(rule({ min_value: 10, max_value: 5 }))).status).toBe(422);
    expect((await as.post(`${api}/admin/approval-rules`).send(rule({ role_chain: ['distributor_user'] }))).status).toBe(422);
    expect((await as.post(`${api}/admin/approval-rules`).send(rule({ role_chain: [] }))).status).toBe(422);
    expect((await as.post(`${api}/admin/approval-rules`).send(rule({ lane: 'nope' }))).status).toBe(422);
    expect((await env.as('compliance_officer').post(`${api}/admin/approval-rules`).send(rule())).status).toBe(403);
    expect((await env.as('dsm').get(`${api}/admin/approval-rules`)).status).toBe(403);
    expect((await env.as('accounts').get(`${api}/admin/approval-rules?lane=commercial`)).body.total).toBe(1);
    const upd = await as.patch(`${api}/admin/approval-rules/${made.body.data.id}`).send({ max_value: null, role_chain: ['dsm', 'regional_head'] });
    expect(upd.body.data).toMatchObject({ max_value: null, role_chain: ['dsm', 'regional_head'] });
    expect((await as.patch(`${api}/admin/approval-rules/${made.body.data.id}`).send({ min_value: 5 })).status).toBe(200);
    expect((await as.delete(`${api}/admin/approval-rules/${made.body.data.id}`)).status).toBe(200);
    expect((await env.db.table('audit_log').all({ source: 'api' })).map((a) => a.action)).toEqual(expect.arrayContaining(['approval_rule.create', 'approval_rule.update', 'approval_rule.delete']));
  });
});

describe('admin API keys', () => {
  it('returns the plaintext key once and stores only its SHA-256 hash and a prefix', async () => {
    const env = platformEnv();
    const made = await env.as('admin').post(`${api}/admin/api-keys`).send({ source: 'website', label: 'Marketing website' });
    expect(made.status).toBe(201);
    const key = made.body.data.key as string;
    expect(key).toMatch(/^fsk_[A-Za-z0-9_-]{32}$/);
    expect(made.body.data).toMatchObject({ source: 'website', label: 'Marketing website', active: true, key_prefix: key.slice(0, 10) });
    expect(made.body.data.key_hash).toBeUndefined();

    const row = (await env.db.table('source_api_keys').get(made.body.data.id))!;
    expect(row.key_hash).toBe(sha256Hex(key));
    expect(row.key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(key);
    expect((await env.db.table('audit_log').all({ action: 'api_key.create' }))[0]!.detail).not.toHaveProperty('key');
    expect(JSON.stringify(await env.db.table('audit_log').all())).not.toContain(key);

    const list = await env.as('admin').get(`${api}/admin/api-keys`);
    expect(list.body.data).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(key);
    expect(list.body.data[0].key).toBeUndefined();
    expect(list.body.data[0].key_hash).toBeUndefined();
  });

  it('revokes and rotates; only admins may touch keys', async () => {
    const env = platformEnv();
    const as = env.as('admin');
    const a = (await as.post(`${api}/admin/api-keys`).send({ source: 'campaign', label: 'Meta lead ads' })).body.data;
    for (const role of ['compliance_officer', 'management', 'dsm']) {
      expect((await env.as(role).post(`${api}/admin/api-keys`).send({ source: 'website', label: 'x1' })).status, role).toBe(403);
      expect((await env.as(role).get(`${api}/admin/api-keys`)).status, role).toBe(403);
    }
    expect((await as.post(`${api}/admin/api-keys`).send({ source: 'telepathy', label: 'bad' })).status).toBe(422);
    const rotated = await as.post(`${api}/admin/api-keys/${a.id}/rotate`);
    expect(rotated.status).toBe(201);
    expect(rotated.body.data.key).not.toBe(a.key);
    expect(rotated.body.data).toMatchObject({ source: 'campaign', label: 'Meta lead ads', active: true });
    expect((await env.db.table('source_api_keys').get(a.id))!.active).toBe(false);
    const revoked = await as.post(`${api}/admin/api-keys/${rotated.body.data.id}/revoke`);
    expect(revoked.body.data.active).toBe(false);
    expect((await as.post(`${api}/admin/api-keys/${IDS.org}/revoke`)).status).toBe(404);
  });
});

describe('admin gate applicability, work calendar and SLA', () => {
  it('shows the whole matrix with defaults and saves a cell', async () => {
    const env = platformEnv();
    const m = await env.as('viewer').get(`${api}/admin/gate-applicability`);
    expect(m.body.data.gates).toHaveLength(14);
    expect(m.body.data.segments).toHaveLength(7);
    expect(m.body.data.cells).toHaveLength(98);
    expect(m.body.data.matrix.G3.ci_captive).toMatchObject({ applicability: 'applies', defaulted: true, id: null });
    expect((await env.as('dsm').put(`${api}/admin/gate-applicability`).send({ gate: 'G3', segment: 'ci_captive', applicability: 'warning' })).status).toBe(403);
    const put = await env.as('compliance_officer').put(`${api}/admin/gate-applicability`).send({ gate: 'G3', segment: 'ci_captive', applicability: 'warning', note: 'Behind-the-meter jobs are exempt (definition unverified)' });
    expect(put.status).toBe(200);
    expect(put.body.data).toMatchObject({ gate: 'G3', segment: 'ci_captive', applicability: 'warning', defaulted: false });
    await env.as('admin').put(`${api}/admin/gate-applicability`).send({ gate: 'G3', segment: 'ci_captive', applicability: 'not_applies' });
    expect(await env.db.table('gate_applicability').count({ gate: 'G3', segment: 'ci_captive' })).toBe(1); // updated, not duplicated
    const again = await env.as('viewer').get(`${api}/admin/gate-applicability`);
    expect(again.body.data.matrix.G3.ci_captive).toMatchObject({ applicability: 'not_applies', defaulted: false });
    expect((await env.as('admin').put(`${api}/admin/gate-applicability`).send({ gate: 'G99', segment: 'ci_captive', applicability: 'applies' })).status).toBe(422);
  });

  it('reads and writes the work calendar through the rule service and requires a source', async () => {
    const env = platformEnv();
    await env.rule('work_calendar.hours', { days: [1, 2, 3, 4, 5, 6], start: '09:30', end: '18:30' });
    const as = env.as('compliance_officer');
    const before = await as.get(`${api}/admin/work-calendar`);
    expect(before.body.data.hours).toEqual({ days: [1, 2, 3, 4, 5, 6], start: '09:30', end: '18:30' });
    expect(before.body.data.holidays).toEqual([]);
    expect((await as.put(`${api}/admin/work-calendar`).send({ hours: { days: [1, 2], start: '10:00', end: '17:00' } })).status).toBe(422); // no source_ref
    expect((await as.put(`${api}/admin/work-calendar`).send({ source_ref: 'HR memo', hours: { days: [1], start: '18:00', end: '09:00' } })).status).toBe(422);
    expect((await as.put(`${api}/admin/work-calendar`).send({ source_ref: 'HR memo' })).status).toBe(422);
    expect((await env.as('dsm').put(`${api}/admin/work-calendar`).send({ source_ref: 'x', holidays: ['2026-11-09'] })).status).toBe(403);

    const put = await as.put(`${api}/admin/work-calendar`).send({
      source_ref: 'HR memo 12/2026', hours: { days: [1, 2, 3, 4, 5], start: '10:00', end: '19:00' },
      holidays: [{ date: '2026-11-09', name: 'Diwali' }, '2026-11-10', '2026-11-09'],
    });
    expect(put.status).toBe(200);
    expect(put.body.data.hours).toEqual({ days: [1, 2, 3, 4, 5], start: '10:00', end: '19:00' });
    expect(put.body.data.holidays).toEqual([{ date: '2026-11-09', name: 'Diwali' }, { date: '2026-11-10', name: null }]);
    expect(put.body.data.history.hours).toHaveLength(2);
    expect(put.body.data.rules.hours.source_ref).toBe('HR memo 12/2026');
    // the SLA arithmetic sees it
    const cal = await loadWorkCalendar(env.ctx('admin'));
    expect(cal).toMatchObject({ days: [1, 2, 3, 4, 5], start: '10:00', end: '19:00', holidays: ['2026-11-09', '2026-11-10'] });
    // the same day again edits that version in place
    await as.put(`${api}/admin/work-calendar`).send({ source_ref: 'HR memo 13/2026', hours: { days: [1, 2, 3, 4, 5], start: '10:00', end: '18:00' } });
    expect((await env.ctx('admin').svc.rules.history('work_calendar', 'hours'))).toHaveLength(2);
    expect((await loadWorkCalendar(env.ctx('admin'))).end).toBe('18:00');
    // before the change takes effect the old hours apply
    expect((await loadWorkCalendar(env.ctx('admin'), '2026-10-01')).start).toBe('09:30');
  });

  it('lists and edits SLA settings through the rule service', async () => {
    const env = platformEnv();
    await env.rule('sla.lead_acceptance_minutes.hot', 30, { effective_from: '2020-01-01' });
    await env.rule('sla.followup_days.hot', 1);
    await env.rule('sla.quote_followup_days', [1, 3, 5, 7]);
    await env.rule('pmsg.cfa.max_total', 78000);
    const as = env.as('compliance_officer');
    const list = await as.get(`${api}/admin/sla`);
    expect(list.body.data.map((s: { key: string }) => s.key)).toEqual(['followup_days.hot', 'lead_acceptance_minutes.hot', 'quote_followup_days']);
    expect(list.body.data[1]).toMatchObject({ path: 'sla.lead_acceptance_minutes.hot', value: 30, versions: 1, is_active: true });

    expect((await env.as('dsm').put(`${api}/admin/sla`).send({ key: 'followup_days.hot', value: 2, source_ref: 'x' })).status).toBe(403);
    expect((await as.put(`${api}/admin/sla`).send({ key: 'lead_acceptance_minutes.hot', value: 45 })).status).toBe(422); // source missing
    expect((await as.put(`${api}/admin/sla`).send({ key: 'lead_acceptance_minutes.hot', value: 'soon', source_ref: 'x' })).status).toBe(422); // wrong kind
    expect((await as.put(`${api}/admin/sla`).send({ key: 'lead_acceptance_minutes.hot', value: -5, source_ref: 'x' })).status).toBe(422);
    expect((await as.put(`${api}/admin/sla`).send({ key: 'nothing.here', value: 1, source_ref: 'x' })).status).toBe(404);
    const put = await as.put(`${api}/admin/sla`).send({ key: 'lead_acceptance_minutes.hot', value: 45, source_ref: 'Sales ops circular 7/2026' });
    expect(put.status).toBe(200);
    const row = put.body.data.find((s: { key: string }) => s.key === 'lead_acceptance_minutes.hot');
    expect(row).toMatchObject({ value: 45, versions: 2, source_ref: 'Sales ops circular 7/2026', effective_from: '2026-10-26' });
    expect(await env.ctx('admin').svc.rules.value('sla.lead_acceptance_minutes.hot')).toBe(45);
    expect(await env.ctx('admin').svc.rules.value('sla.lead_acceptance_minutes.hot', '2026-01-01')).toBe(30);
    expect((await as.put(`${api}/admin/sla`).send({ key: 'quote_followup_days', value: [1, 2, 4, 7], source_ref: 'Circular' })).body.data.find((s: { key: string }) => s.key === 'quote_followup_days').value).toEqual([1, 2, 4, 7]);
    expect((await env.db.table('audit_log').all({ action: 'rule.create_version' })).length).toBeGreaterThanOrEqual(2);
  });
});

describe('audit viewer', () => {
  it('is restricted to admin and compliance and filters by actor, action, table, record, source and date', async () => {
    const env = platformEnv();
    for (const role of ['management', 'dsm', 'sales_manager', 'accounts', 'viewer', 'distributor_user', 'dealer_user']) {
      expect((await env.as(role).get(`${api}/admin/audit`)).status, role).toBe(403);
    }
    const terr = await env.as('admin').post(`${api}/admin/territories`).send({ name: 'Anand', state: 'Gujarat', pincode_ranges: [] });
    await env.as('admin').patch(`${api}/admin/territories/${terr.body.data.id}`).send({ district: 'Anand' });
    env.advance(3 * 86_400_000);
    await env.as('admin').post(`${api}/admin/users`).send(newUser());

    const all = await env.as('compliance_officer').get(`${api}/admin/audit?source=api`);
    expect(all.status).toBe(200);
    expect((await env.as('compliance_officer').get(`${api}/admin/audit`)).body.total).toBeGreaterThan(3);
    expect(all.body.data[0]).toMatchObject({ actor_id: IDS.profile('admin'), actor_name: 'Test admin', actor_role: 'admin' });
    expect(all.body.data[0].old_data).toBeUndefined();
    expect(all.body.data[0].new_data).toBeUndefined();

    const byAction = await env.as('admin').get(`${api}/admin/audit?action=territory.`);
    expect(byAction.body.data.map((a: { action: string }) => a.action).sort()).toEqual(expect.arrayContaining(['territory.create', 'territory.update']));
    expect(byAction.body.data.every((a: { action: string }) => a.action.includes('territory.'))).toBe(true);
    const update = byAction.body.data.find((a: { action: string; source: string }) => a.action === 'territory.update' && a.source === 'api');
    expect(update.table_name).toBe('territories');
    const byRecord = await env.as('admin').get(`${api}/admin/audit?table=territories&record=${terr.body.data.id}&source=api`);
    expect(byRecord.body.data.map((a: { action: string }) => a.action).sort()).toEqual(['territory.create', 'territory.update']);
    expect((await env.as('admin').get(`${api}/admin/audit?source=trigger&table=territories`)).body.data.every((a: { source: string }) => a.source === 'trigger')).toBe(true);
    expect((await env.as('admin').get(`${api}/admin/audit?actor=${IDS.profile('dsm')}`)).body.total).toBe(0);
    expect((await env.as('admin').get(`${api}/admin/audit?q=user.create`)).body.total).toBeGreaterThan(0);
    // date range in IST: the territory changes were made 3 days before the user was created
    const today = '2026-10-29';
    const onlyToday = await env.as('admin').get(`${api}/admin/audit?from=${today}&to=${today}&source=api`);
    expect(onlyToday.body.data.map((a: { action: string }) => a.action)).toEqual(['user.create']);
    const early = await env.as('admin').get(`${api}/admin/audit?from=2026-10-26&to=2026-10-26&source=api&table=territories`);
    expect(early.body.total).toBe(2);
    expect((await env.as('admin').get(`${api}/admin/audit?from=yesterday`)).status).toBe(422);
    // pagination
    const page = await env.as('admin').get(`${api}/admin/audit?limit=2&offset=1`);
    expect(page.body).toMatchObject({ limit: 2, offset: 1 });
    expect(page.body.data).toHaveLength(2);
  });

  it('shows before/after with personal fields masked unless revealed — and the reveal itself is audited', async () => {
    const env = platformEnv();
    const row = await env.db.table('audit_log').insert({
      org_id: IDS.org, actor_id: IDS.profile('dsm'), action: 'lead.update', table_name: 'leads', record_id: IDS.org, source: 'api', request_id: null, ip: null, detail: null,
      old_data: { name: 'Asha', mobile: '+919812345678', status: 'new' }, new_data: { name: 'Asha', mobile: '+919812345678', status: 'assigned' },
    });
    const masked = await env.as('compliance_officer').get(`${api}/admin/audit/${row.id}`);
    expect(masked.body.data).toMatchObject({ old_data: { mobile: '[masked]', status: 'new' }, new_data: { mobile: '[masked]', status: 'assigned' }, changed_fields: ['status'], revealed: false, actor_name: 'Test dsm' });
    const revealed = await env.as('compliance_officer').get(`${api}/admin/audit/${row.id}?reveal=true`);
    expect(revealed.body.data.new_data.mobile).toBe('+919812345678');
    expect(await env.db.table('audit_log').count({ action: 'audit.reveal', record_id: row.id })).toBe(1);
    expect((await env.as('management').get(`${api}/admin/audit/${row.id}`)).status).toBe(403);
    expect((await env.as('admin').get(`${api}/admin/audit/${IDS.org}`)).status).toBe(404);
  });
});

describe('demo reset', () => {
  it('rebuilds through the repositories when no handle on the store exists, and is admin + demo only', async () => {
    const env = platformEnv();
    await mkLead(env);
    await mkLead(env, { name: 'Second', mobile: '+919000000009' });
    expect((await env.as('management').post(`${api}/admin/demo/reset`)).status).toBe(403);
    const r = await env.as('admin').post(`${api}/admin/demo/reset`);
    expect(r.status).toBe(200);
    expect(r.body.data.mode).toBe('repository-reset');
    expect(await env.db.table('leads').count({ name: 'Second' })).toBe(0); // test data is gone
    expect(await env.db.table('leads').count()).toBe((buildSeed(env.now()).leads ?? []).length); // demo data is back
    expect(await env.db.table('organizations').count()).toBe(1);
  });

  it('uses MemoryDb.reset(buildSeed(now)) when the store is available', async () => {
    const env = platformEnv();
    await mkLead(env);
    bindPlatformDeps(env.deps);
    const r = await env.as('admin').post(`${api}/admin/demo/reset`);
    expect(r.status).toBe(200);
    expect(r.body.data.mode).toBe('memory-reset');
    const seed = buildSeed(env.now());
    expect(await env.db.table('leads').count({ name: 'Asha Patel', source_ref: 'camp-1' })).toBe(0);
    expect(await env.db.table('leads').count()).toBe((seed.leads ?? []).length);
    expect(await env.db.table('profiles').count()).toBe((seed.profiles ?? []).length);
    expect(await env.db.table('organizations').count()).toBe(1);
    expect(await env.db.table('audit_log').count({ action: 'demo.reset' })).toBe(1);
  });

  it('refuses outside demo mode', async () => {
    const env = platformEnv();
    const ctx = env.ctx('admin');
    ctx.config = { ...ctx.config, demo: false };
    await expect(resetDemo(ctx, env.deps)).rejects.toMatchObject({ status: 403 });
  });
});

