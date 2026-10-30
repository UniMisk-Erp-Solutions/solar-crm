/** State and helpers shared by the stage files of the flow test (one module instance per test file, so every stage sees the same app, clock and ids). */
import { createHash } from 'node:crypto';
import type { Lead, LeadSource, NotificationRow } from '@solar/shared';
import { DEMO_IDS } from '@solar/shared/seed';
import { API, DAY, HOUR, MINUTE, createFlowEnv, data, type FlowEnv, type Who } from './flowHarness';

export const env: FlowEnv = createFlowEnv();
export const D = DEMO_IDS;
export { API, DAY, HOUR, MINUTE, data };

/** Ids and facts handed from one stage to the next. */
export const S: Record<string, string> = {};
/** Source API keys by lead source. */
export const KEYS: Partial<Record<LeadSource, string>> = {};

export const iso = (d: Date): string => d.toISOString();
export const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
export const lead = (id: string): Promise<Lead> => env.db.table('leads').getOrThrow(id);
export const eventsOf = async (leadId: string): Promise<string[]> => (await env.db.table('lead_events').all({ lead_id: leadId })).map((e) => e.event_type);
export const notificationsOf = async (userId: string, kindPrefix: string): Promise<NotificationRow[]> =>
  (await env.db.table('notifications').all({ user_id: userId })).filter((n) => n.kind.startsWith(kindPrefix));
export const clockOf = async (entityId: string, type: string) => (await env.db.table('clocks').all({ entity_id: entityId, clock_type: type as never }, { orderBy: { col: 'started_at', dir: 'asc' } })).at(-1)!;

/** An IST wall-clock time on a calendar day, as an instant. */
export const ist = (date: string, hhmm: string): Date => new Date(`${date}T${hhmm}:00+05:30`);
/** Jump the clock to an IST wall-clock time. */
export const goto = (date: string, hhmm: string): void => env.setNow(ist(date, hhmm));
/** The clock's current IST date `YYYY-MM-DD`. */
export const istToday = (): string => new Date(env.now().getTime() + 330 * MINUTE).toISOString().slice(0, 10);

/** Issue a source key through the admin endpoint (once per source). */
export async function keyFor(source: LeadSource): Promise<string> {
  const have = KEYS[source];
  if (have) return have;
  const created = data<{ key: string }>(await env.as('admin').post(`${API}/admin/api-keys`).send({ source, label: `Flow test ${source}` }), 201);
  KEYS[source] = created.key;
  return created.key;
}

export const CONSENT_ALL = { notice_version: 'default-v1', purposes: ['service', 'promotional', 'quotation', 'subsidy_processing'], channels: ['call', 'sms', 'whatsapp', 'email'], capture_source: 'web_form' };

/** POST /public/leads with the key of `source`; returns the raw response. */
export async function capture(source: LeadSource, body: Record<string, unknown>) {
  return env.anon().post(`${API}/public/leads`).set('X-Api-Key', await keyFor(source)).set('User-Agent', 'flow-test').send(body);
}
export async function captureOk(source: LeadSource, body: Record<string, unknown>): Promise<string> {
  return data<{ lead_id: string }>(await capture(source, body), [200, 201]).lead_id;
}

/** Accept a freshly assigned lead as the right user. */
export async function acceptAs(who: Who, leadId: string) {
  return data<{ id: string; status: string }>(await env.as(who).post(`${API}/leads/${leadId}/accept`).send({}));
}

/** Gate counts of the funnel dashboard for a segment (cohort = leads created in the default 90-day window). */
export async function funnel(who: Who = 'management', segment = 'pmsg_residential'): Promise<Record<string, number>> {
  const f = data<{ gates: { key: string; count: number }[] }>(await env.as(who).get(`${API}/dashboards/funnel?segment=${segment}`));
  return Object.fromEntries(f.gates.map((g) => [g.key, g.count]));
}

export const roleOf = async (profileId: string | null): Promise<string> => (profileId ? (await env.db.table('profiles').getOrThrow(profileId)).role : 'system');
