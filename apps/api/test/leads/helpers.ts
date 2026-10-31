import request from 'supertest';
import { DEMO_ORG_ID, seedId, sha256Hex, type AppRole, type Lead, type LeadSource, type MessageTemplate } from '@solar/shared';
import { createApp } from '../../src/app';
import leadsRouter from '../../src/routes/leads.routes';
import { createPublicRouter } from '../../src/routes/public.routes';
import { createLeadRequestRouter } from '../../src/routes/leadRequest.routes';
import { IDS, createTestEnv, type TestEnv, type TestEnvOptions } from '../helpers/env';

export { IDS };
export const API = '/api/v1';

export interface LeadEnv extends TestEnv {
  /** supertest agent authenticated as a role or explicit profile id, mounted on the lead routers */
  u(who: AppRole | string): { get(url: string): request.Test; post(url: string): request.Test; patch(url: string): request.Test };
  anonymous(): ReturnType<typeof request>;
  /** creates an active source API key and returns the plain key */
  key(source: LeadSource): Promise<string>;
  /** POST /public/leads with a website key (or the given one) */
  capture(body: Record<string, unknown>, key?: string): Promise<request.Response>;
  lead(id: string): Promise<Lead>;
  template(t: Partial<MessageTemplate> & Pick<MessageTemplate, 'key' | 'channel' | 'category' | 'purpose' | 'body'>): Promise<MessageTemplate>;
}

export const CONSENT = { notice_version: 'v1', purposes: ['service', 'promotional'], channels: ['call', 'sms', 'whatsapp', 'email'] };
export const person = (over: Record<string, unknown> = {}) => ({
  name: 'Asha Patel', mobile: '9876543210', email: 'asha@example.com', pincode: '380001', capacity_kw: 5, product_interest: ['module'], segment: 'pmsg_residential',
  consent: CONSENT, ...over,
});

/** Tenant of test/helpers/env baseSeed + pincodes, the lead routers and the public router mounted. */
export function leadEnv(opts: TestEnvOptions = {}): LeadEnv {
  const base = createTestEnv(opts);
  const app = createApp(base.deps, { authed: [leadsRouter], public: [createPublicRouter(base.deps), createLeadRequestRouter(base.deps)] });
  const idOf = (who: string) => (/^[0-9a-f-]{36}$/.test(who) ? who : IDS.profile(who as AppRole));
  const u: LeadEnv['u'] = (who) => {
    const auth = (r: request.Test) => r.set('Authorization', `Bearer ${base.token(idOf(who))}`);
    return { get: (url) => auth(request(app).get(url)), post: (url) => auth(request(app).post(url)), patch: (url) => auth(request(app).patch(url)) };
  };
  const ts = base.now().toISOString();
  const rowBase = { org_id: DEMO_ORG_ID, created_at: ts, updated_at: ts, created_by: null };
  void base.db.table('pincodes').insertMany([
    { ...rowBase, id: seedId('pin', 1), pincode: '380001', city: 'Ahmedabad', district: 'Ahmedabad', state: 'Gujarat', discom_id: null, territory_id: IDS.territoryAhmedabad },
    { ...rowBase, id: seedId('pin', 2), pincode: '395003', city: 'Surat', district: 'Surat', state: 'Gujarat', discom_id: null, territory_id: IDS.territorySurat },
  ]);
  let n = 0;
  const env: LeadEnv = {
    ...base, app, u, anonymous: () => request(app),
    async key(source) {
      const plain = `fs_${source}_test_key_${++n}_${seedId('k', n)}`;
      await base.db.table('source_api_keys').insert({ ...rowBase, id: seedId('apikey', n + Math.floor(Math.random() * 1e6)), source, label: `${source} test`, key_hash: sha256Hex(plain), key_prefix: plain.slice(0, 12), active: true, last_used_at: null });
      return plain;
    },
    async capture(body, key) {
      const k = key ?? (await env.key('website'));
      return request(app).post(`${API}/public/leads`).set('X-Api-Key', k).set('User-Agent', 'vitest-agent').send(body);
    },
    async lead(id) { return base.db.table('leads').getOrThrow(id); },
    async template(t) {
      return base.db.table('message_templates').insert({
        ...rowBase, id: undefined as unknown as string, language: 'en', subject: null, dlt_template_id: null, dlt_header: null, whatsapp_template_name: null, version: 1, active: true, ...t,
      });
    },
  };
  return env;
}
