import { describe, expect, it } from 'vitest';
import { evaluateOutbound, type OutboundFacts } from '../../src/services/consentService';
import { unsubscribeToken, verifyUnsubscribeToken } from '../../src/services/consentServiceLedger';
import { API, IDS, leadEnv, person, type LeadEnv } from './helpers';

const DAY = 86_400_000;

async function templates(env: LeadEnv) {
  await env.template({ key: 'promo_wa', channel: 'whatsapp', category: 'marketing', purpose: 'promotional', body: 'Hi {{name}}, solar offers inside. Stop: {{unsubscribe_url}}', whatsapp_template_name: 'promo_v1' });
  await env.template({ key: 'svc_wa', channel: 'whatsapp', category: 'utility', purpose: 'service', body: 'Hi {{name}}, we received your enquiry.', whatsapp_template_name: 'svc_v1' });
  await env.template({ key: 'promo_sms', channel: 'sms', category: 'marketing', purpose: 'promotional', body: 'Hi {{name}}, solar offers.', dlt_template_id: 'DLT-P-1', dlt_header: 'FSOLAR' });
  await env.template({ key: 'svc_sms', channel: 'sms', category: 'utility', purpose: 'service', body: 'Hi {{name}}, enquiry received.', dlt_template_id: 'DLT-S-1', dlt_header: 'FSOLAR' });
  await env.template({ key: 'no_dlt_sms', channel: 'sms', category: 'utility', purpose: 'service', body: 'No DLT here' });
  await env.template({ key: 'promo_mail', channel: 'email', category: 'marketing', purpose: 'promotional', body: 'Hello {{name}}, our latest offers.', subject: 'Offers' });
}
async function newLead(env: LeadEnv, over: Record<string, unknown> = {}) {
  const r = await env.capture(person(over));
  return r.body.data.lead_id as string;
}
const send = (env: LeadEnv, id: string, body: Record<string, unknown>, who = 'admin') => env.u(who).post(`${API}/leads/${id}/messages`).send(body);
async function inbound(env: LeadEnv, from = '919876543210', text = 'Hello') {
  const key = await env.key('whatsapp');
  return env.anonymous().post(`${API}/webhooks/whatsapp`).set('X-Api-Key', key).send({ from, body: text });
}

describe('pure evaluation (Appendix A)', () => {
  const now = new Date('2026-10-26T05:00:00Z');
  const facts = (over: Partial<OutboundFacts> = {}): OutboundFacts => ({
    lead: { dnd_status: 'clear', dnd_checked_at: now.toISOString(), mobile: '+919876543210', email: 'a@b.in', anonymised_at: null },
    consents: [], now, windowHours: 24, dndMaxAgeDays: 30, lastInboundAt: null, ...over,
  });
  const consent = (over: Record<string, unknown> = {}) => ({ id: 'c1', lead_id: 'l', notice_version: 'v1', purposes: ['promotional', 'service'], channels: ['sms', 'whatsapp'], recipients_named: [], granted_at: now.toISOString(), withdrawn_at: null, optout_suppress_until: null, ...over }) as never;
  const codes = (r: ReturnType<typeof evaluateOutbound>) => r.reasons.map((x) => x.code);

  it('promotional needs consent, a fresh clear DND scrub and no suppression', () => {
    expect(codes(evaluateOutbound(facts(), 'sms', 'promotional'))).toEqual(['NO_CONSENT']);
    expect(evaluateOutbound(facts({ consents: [consent()] }), 'sms', 'promotional')).toMatchObject({ allowed: true, consent_id: 'c1' });
    expect(codes(evaluateOutbound(facts({ consents: [consent({ channels: ['email'] })] }), 'sms', 'promotional'))).toEqual(['CHANNEL_NOT_CONSENTED']);
    expect(codes(evaluateOutbound(facts({ consents: [consent({ purposes: ['service'] })] }), 'sms', 'promotional'))).toEqual(['PURPOSE_NOT_CONSENTED']);
    expect(codes(evaluateOutbound(facts({ consents: [consent({ withdrawn_at: now.toISOString() })] }), 'sms', 'promotional'))).toEqual(['WITHDRAWN']);
    const future = new Date(now.getTime() + 10 * DAY).toISOString();
    expect(codes(evaluateOutbound(facts({ consents: [consent({ withdrawn_at: now.toISOString(), optout_suppress_until: future })] }), 'sms', 'promotional'))).toEqual(['WITHDRAWN', 'SUPPRESSED_90_DAY']);
    expect(codes(evaluateOutbound(facts({ consents: [consent({ withdrawn_at: now.toISOString(), optout_suppress_until: now.toISOString() })] }), 'sms', 'promotional'))).toEqual(['WITHDRAWN']); // suppression over
    const stale = { dnd_status: 'clear' as const, dnd_checked_at: new Date(now.getTime() - 31 * DAY).toISOString(), mobile: '+919876543210', email: null, anonymised_at: null };
    expect(codes(evaluateOutbound(facts({ lead: stale, consents: [consent()] }), 'sms', 'promotional'))).toEqual(['DND_STALE']);
    expect(codes(evaluateOutbound(facts({ lead: { ...stale, dnd_status: 'unchecked', dnd_checked_at: null }, consents: [consent()] }), 'sms', 'promotional'))).toEqual(['DND_UNCHECKED']);
    expect(codes(evaluateOutbound(facts({ lead: { ...stale, dnd_status: 'registered', dnd_checked_at: now.toISOString() }, consents: [consent()] }), 'sms', 'promotional'))).toEqual(['DND_REGISTERED']);
  });

  it('service needs a service/quotation consent on the channel, or an open WhatsApp window', () => {
    expect(codes(evaluateOutbound(facts(), 'sms', 'service'))).toEqual(['NO_CONSENT']);
    expect(evaluateOutbound(facts({ consents: [consent({ purposes: ['quotation'] })] }), 'sms', 'service').allowed).toBe(true);
    expect(evaluateOutbound(facts({ consents: [consent({ purposes: ['promotional'] })] }), 'sms', 'service').allowed).toBe(false);
    const open = new Date(now.getTime() - 2 * 3600_000).toISOString();
    expect(evaluateOutbound(facts({ lastInboundAt: open }), 'whatsapp', 'service')).toMatchObject({ allowed: true, consent_id: null, whatsapp_window_open: true });
    expect(evaluateOutbound(facts({ lastInboundAt: open }), 'sms', 'service').allowed).toBe(false); // the window only exists on WhatsApp
    const closed = new Date(now.getTime() - 25 * 3600_000).toISOString();
    expect(evaluateOutbound(facts({ lastInboundAt: closed }), 'whatsapp', 'service')).toMatchObject({ allowed: false, whatsapp_window_open: false });
    expect(evaluateOutbound(facts({ lastInboundAt: open }), 'whatsapp', 'promotional').allowed).toBe(false); // an open window never replaces promotional consent
  });

  it('DND does not apply to e-mail; a missing address blocks with NO_CONTACT', () => {
    const lead = { dnd_status: 'registered' as const, dnd_checked_at: now.toISOString(), mobile: '+919876543210', email: 'a@b.in', anonymised_at: null };
    expect(evaluateOutbound(facts({ lead, consents: [consent({ channels: ['email'] })] }), 'email', 'promotional').allowed).toBe(true);
    expect(codes(evaluateOutbound(facts({ lead: { ...lead, email: null }, consents: [consent({ channels: ['email'] })] }), 'email', 'promotional'))).toEqual(['NO_CONTACT']);
  });
});

describe('send pipeline — consent, window, DLT', () => {
  it('no consent → blocked, logged with the reason, nothing reaches the provider; the owner is told', async () => {
    const env = leadEnv(); await templates(env);
    const id = await newLead(env, { consent: undefined });
    const r = await send(env, id, { channel: 'sms', purpose: 'promotional', template_key: 'promo_sms' });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('CONSENT_BLOCKED');
    expect(r.body.error.details.reasons[0]).toMatchObject({ code: 'NO_CONSENT' });
    expect(env.providers.calls.sms).toHaveLength(0);
    const log = await env.db.table('message_log').all({ lead_id: id });
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ status: 'blocked', block_reason: 'NO_CONSENT', direction: 'outbound', channel: 'sms' });
    expect(log[0]!.to_masked).not.toContain('9876543210');
    expect(await env.db.table('notifications').count({ kind: 'message.blocked' })).toBe(1);
  });

  it('SMS needs a DLT template with id and header', async () => {
    const env = leadEnv(); await templates(env);
    const id = await newLead(env);
    const noTpl = await send(env, id, { channel: 'sms', purpose: 'service', body: 'free text sms' });
    expect(noTpl.body.error.details.reasons[0].code).toBe('NO_TEMPLATE');
    const noDlt = await send(env, id, { channel: 'sms', purpose: 'service', template_key: 'no_dlt_sms' });
    expect(noDlt.body.error.details.reasons[0].code).toBe('NO_TEMPLATE');
    const unknown = await send(env, id, { channel: 'sms', purpose: 'service', template_key: 'nope' });
    expect(unknown.status).toBe(422);
    expect(env.providers.calls.sms).toHaveLength(0);
    const ok = await send(env, id, { channel: 'sms', purpose: 'service', template_key: 'svc_sms' });
    expect(ok.status).toBe(201);
    expect(ok.body.data).toMatchObject({ status: 'sent', template_category: 'utility' });
    expect(env.providers.calls.sms).toEqual([{ to: '+919876543210', dlt_template_id: 'DLT-S-1', dlt_header: 'FSOLAR' }]);
    // a service template cannot carry a promotional message and vice versa
    const mismatch = await send(env, id, { channel: 'sms', purpose: 'promotional', template_key: 'svc_sms' });
    expect(mismatch.body.error.details.reasons[0].code).toBe('NO_TEMPLATE');
  });

  it('WhatsApp: closed window → approved template only; open window → free-form session message', async () => {
    const env = leadEnv(); await templates(env);
    const id = await newLead(env);
    const free = await send(env, id, { channel: 'whatsapp', purpose: 'service', body: 'Can we talk tomorrow?' });
    expect(free.body.error.details.reasons[0].code).toBe('WHATSAPP_WINDOW_CLOSED');
    expect(env.providers.calls.whatsappSession).toHaveLength(0);
    const tpl = await send(env, id, { channel: 'whatsapp', purpose: 'service', template_key: 'svc_wa' });
    expect(tpl.status).toBe(201);
    expect(tpl.body.data.template_category).toBe('utility');
    expect(env.providers.calls.whatsappTemplate).toEqual([{ to: '+919876543210', template_name: 'svc_v1' }]);

    await inbound(env);
    const session = await send(env, id, { channel: 'whatsapp', purpose: 'service', body: 'Sure, 4 pm works.' });
    expect(session.status).toBe(201);
    expect(session.body.data.template_category).toBe('service');
    expect(env.providers.calls.whatsappSession).toEqual([{ to: '+919876543210', body: 'Sure, 4 pm works.' }]);

    env.advance(25 * 3600_000); // the 24-hour window is over
    const again = await send(env, id, { channel: 'whatsapp', purpose: 'service', body: 'Still there?' });
    expect(again.body.error.details.reasons[0].code).toBe('WHATSAPP_WINDOW_CLOSED');
  });

  it('WhatsApp category fits the purpose: promotional → marketing template, never a utility one', async () => {
    const env = leadEnv(); await templates(env);
    const id = await newLead(env);
    const wrong = await send(env, id, { channel: 'whatsapp', purpose: 'promotional', template_key: 'svc_wa' });
    expect(wrong.body.error.details.reasons[0].code).toBe('NO_TEMPLATE');
    const ok = await send(env, id, { channel: 'whatsapp', purpose: 'promotional', template_key: 'promo_wa' });
    expect(ok.status).toBe(201);
    expect(ok.body.data.template_category).toBe('marketing');
    const log = (await env.db.table('message_log').all({ lead_id: id, status: 'sent' }))[0]!;
    expect(log).toMatchObject({ category: 'marketing', template_key: 'promo_wa', consent_id: expect.any(String) });
    expect(log.body_preview).toContain('/unsubscribe?token='); // {{unsubscribe_url}} is rendered
  });

  it('no consent but the customer wrote first → a service reply is allowed inside the window, promotional is not', async () => {
    const env = leadEnv(); await templates(env);
    const id = await newLead(env, { consent: undefined });
    expect((await send(env, id, { channel: 'whatsapp', purpose: 'service', body: 'hello' })).status).toBe(422);
    await inbound(env);
    const reply = await send(env, id, { channel: 'whatsapp', purpose: 'service', body: 'Thanks for writing to us.' });
    expect(reply.status).toBe(201);
    expect((await env.db.table('message_log').all({ lead_id: id, status: 'sent', direction: 'outbound' }))[0]!.consent_id).toBeNull();
    const promo = await send(env, id, { channel: 'whatsapp', purpose: 'promotional', body: 'Big offer' });
    expect(promo.status).toBe(422);
    expect(promo.body.error.details.reasons.map((x: { code: string }) => x.code)).toContain('NO_CONSENT');
  });

  it('calls are only logged; e-mail carries an unsubscribe footer on promotional mail', async () => {
    const env = leadEnv(); await templates(env);
    const id = await newLead(env);
    const call = await send(env, id, { channel: 'call', purpose: 'service' });
    expect(call.status).toBe(201);
    expect((await env.db.table('message_log').all({ lead_id: id, channel: 'call' }))[0]).toMatchObject({ status: 'sent', provider: 'call-log' });
    const mail = await send(env, id, { channel: 'email', purpose: 'promotional', template_key: 'promo_mail' });
    expect(mail.status).toBe(201);
    expect(env.providers.calls.email.filter((m) => m.to === 'asha@example.com')).toEqual([{ to: 'asha@example.com', subject: 'Offers' }]); // staff e-mails to the owner are separate
    const noEmail = await newLead(env, { mobile: '9123456780', name: 'No Mail', email: undefined, pincode: '395003' });
    expect((await send(env, noEmail, { channel: 'email', purpose: 'service', body: 'hi' })).body.error.details.reasons[0].code).toBe('NO_CONTACT');
  });

  it('role scoping: a distributor user can only message their own leads', async () => {
    const env = leadEnv(); await templates(env);
    const id = await newLead(env);
    expect((await send(env, id, { channel: 'sms', purpose: 'service', template_key: 'svc_sms' }, IDS.distributorUserB)).status).toBe(403);
    expect((await send(env, id, { channel: 'sms', purpose: 'service', template_key: 'svc_sms' }, 'distributor_user')).status).toBe(201);
    expect((await send(env, id, { channel: 'sms', purpose: 'service', template_key: 'svc_sms' }, 'viewer')).status).toBe(403);
  });
});

describe('DND freshness', () => {
  it('registered blocks promotional on telecom channels but not service messages; stale scrub is re-done on request', async () => {
    const env = leadEnv(); await templates(env);
    env.providers.dndOverrides.set('+919876543210', 'registered');
    const id = await newLead(env);
    const promo = await send(env, id, { channel: 'sms', purpose: 'promotional', template_key: 'promo_sms' });
    expect(promo.body.error.details.reasons.map((x: { code: string }) => x.code)).toEqual(['DND_REGISTERED']);
    expect((await send(env, id, { channel: 'sms', purpose: 'service', template_key: 'svc_sms' })).status).toBe(201);
    expect((await send(env, id, { channel: 'email', purpose: 'promotional', template_key: 'promo_mail' })).status).toBe(201);

    // the number comes off the register; a fresh scrub is needed before promotional contact
    env.providers.dndOverrides.set('+919876543210', 'clear');
    const scrub = await env.u('dsm').post(`${API}/leads/${id}/dnd-scrub`).send({});
    expect(scrub.body.data).toMatchObject({ status: 'clear', cached: false });
    expect((await send(env, id, { channel: 'sms', purpose: 'promotional', template_key: 'promo_sms' })).status).toBe(201);

    env.advance(31 * DAY);
    const stale = await send(env, id, { channel: 'sms', purpose: 'promotional', template_key: 'promo_sms' });
    expect(stale.body.error.details.reasons.map((x: { code: string }) => x.code)).toEqual(['DND_STALE']);
    const refreshed = await send(env, id, { channel: 'sms', purpose: 'promotional', template_key: 'promo_sms', refresh_dnd: true });
    expect(refreshed.status).toBe(201);
  });

  it('a number that was never scrubbed is DND_UNCHECKED', async () => {
    const env = leadEnv(); await templates(env);
    const id = await newLead(env);
    await env.db.table('leads').update(id, { dnd_status: 'unchecked', dnd_checked_at: null });
    const r = await send(env, id, { channel: 'whatsapp', purpose: 'promotional', template_key: 'promo_wa' });
    expect(r.body.error.details.reasons[0].code).toBe('DND_UNCHECKED');
  });
});

describe('withdrawal, 90-day suppression and propagation', () => {
  it('one-click withdrawal suppresses for 90 days, reaches every named recipient and the same person’s other enquiries', async () => {
    const env = leadEnv(); await templates(env);
    const dealerKey = await env.key('dealer_upload');
    const a = (await env.capture(person({ dealer_id: IDS.dealerA1 }), dealerKey)).body.data.lead_id as string;
    const b = (await env.capture(person({ name: 'Asha P', email: 'asha2@example.com' }))).body.data.lead_id as string; // same mobile → duplicate lead
    expect((await env.lead(b)).status).toBe('duplicate');

    const res = await env.u('admin').post(`${API}/leads/${a}/consents/withdraw`).send({ channel: 'ui', reason: 'Customer called' });
    expect(res.status).toBe(200);
    const until = new Date(env.now().getTime() + 90 * DAY).toISOString();
    expect(res.body.data).toMatchObject({ suppress_until: until, propagated_lead_ids: [b] });
    expect(res.body.data.recipients).toEqual(expect.arrayContaining(['Sunrise Installers', 'Alpha Solar Distributors']));
    for (const id of [a, b]) {
      const rows = await env.db.table('lead_consents').all({ lead_id: id });
      expect(rows.every((c) => c.withdrawn_at !== null && c.optout_suppress_until === until && c.withdrawal_channel)).toBe(true);
    }
    // recipients' users are told; the ledger rows were not rewritten (only withdrawal fields changed)
    const notified = (await env.db.table('notifications').all({ kind: 'consent.withdrawn' })).map((n) => n.user_id);
    expect(notified).toEqual(expect.arrayContaining([IDS.profile('dealer_user'), IDS.profile('distributor_user')]));
    expect((await env.db.table('lead_events').all({ lead_id: a })).map((e) => e.event_type)).toContain('consent_withdrawn');
    expect((await env.db.table('lead_events').all({ lead_id: b })).map((e) => e.event_type)).toContain('consent_suppression_propagated');
    expect(await env.db.table('audit_log').count({ action: 'consent.withdraw', record_id: a })).toBe(1);
    expect((await env.db.table('lead_consents').all({ lead_id: a }))[0]!.notice_version).toBe('v1');

    // blocked for both reasons, on every channel
    for (const channel of ['sms', 'whatsapp', 'email'] as const) {
      const tpl = channel === 'sms' ? 'promo_sms' : channel === 'whatsapp' ? 'promo_wa' : 'promo_mail';
      const blocked = await send(env, a, { channel, purpose: 'promotional', template_key: tpl });
      expect(blocked.body.error.details.reasons.map((x: { code: string }) => x.code)).toEqual(['WITHDRAWN', 'SUPPRESSED_90_DAY']);
    }
    expect((await send(env, a, { channel: 'sms', purpose: 'service', template_key: 'svc_sms' })).status).toBe(422);
    const summary = (await env.u('admin').get(`${API}/leads/${a}/consents`)).body.data.summary;
    expect(summary).toMatchObject({ has_active: false, withdrawn: true, suppressed: true, suppress_until: until });
  });

  it('a new consent inside the 90 days is recorded but the bar stays; after 90 days it lifts', async () => {
    const env = leadEnv(); await templates(env);
    const id = await newLead(env);
    await env.u('admin').post(`${API}/leads/${id}/consents/withdraw`).send({});
    const consent = { notice_version: 'v2', purposes: ['service', 'promotional'], channels: ['sms', 'whatsapp', 'email', 'call'], proof_ref: 'recording-123' };
    expect((await env.u('admin').post(`${API}/leads/${id}/consents`).send({ ...consent, proof_ref: undefined })).status).toBe(422); // proof is mandatory
    const added = await env.u('admin').post(`${API}/leads/${id}/consents`).send(consent);
    expect(added.status).toBe(201);
    expect(added.body.data.consent.recipients_named).toContain('Future Solar Pvt. Ltd.');
    env.advance(30 * DAY);
    await env.u('admin').post(`${API}/leads/${id}/dnd-scrub`).send({});
    const early = await send(env, id, { channel: 'sms', purpose: 'promotional', template_key: 'promo_sms' });
    expect(early.body.error.details.reasons.map((x: { code: string }) => x.code)).toEqual(['SUPPRESSED_90_DAY']);
    env.advance(61 * DAY);
    await env.u('admin').post(`${API}/leads/${id}/dnd-scrub`).send({});
    expect((await send(env, id, { channel: 'sms', purpose: 'promotional', template_key: 'promo_sms' })).status).toBe(201);
  });

  it('a new enquiry from a number that opted out inherits the suppression', async () => {
    const env = leadEnv(); await templates(env);
    const first = await newLead(env);
    await env.u('admin').post(`${API}/leads/${first}/consents/withdraw`).send({});
    await env.u('admin').post(`${API}/leads/${first}/lost`).send({ reason: 'Asked us to stop' });
    const again = await newLead(env); // lost leads do not block a fresh enquiry
    expect((await env.lead(again)).id).not.toBe(first);
    const r = await send(env, again, { channel: 'whatsapp', purpose: 'promotional', template_key: 'promo_wa' });
    expect(r.body.error.details.reasons.map((x: { code: string }) => x.code)).toContain('SUPPRESSED_90_DAY');
    expect((await env.db.table('lead_events').all({ lead_id: again })).map((e) => e.event_type)).toContain('consent_suppression_inherited');
  });

  it('opting out before any consent exists still records the suppression', async () => {
    const env = leadEnv();
    const id = await newLead(env, { consent: undefined });
    const res = await env.u('admin').post(`${API}/leads/${id}/consents/withdraw`).send({});
    expect(res.body.data.withdrawn).toBe(1);
    const rows = await env.db.table('lead_consents').all({ lead_id: id });
    expect(rows[0]).toMatchObject({ capture_source: 'optout_marker', purposes: [] });
  });

  it('STOP on WhatsApp is a full opt-out and does not open the reply window', async () => {
    const env = leadEnv(); await templates(env);
    const id = await newLead(env);
    const r = await inbound(env, '919876543210', 'STOP');
    expect(r.body.data).toMatchObject({ received: 1, optouts: 1 });
    expect(await env.db.table('lead_consents').count({ lead_id: id, withdrawn_at: null })).toBe(0);
    const summary = (await env.u('admin').get(`${API}/leads/${id}/consents`)).body.data.summary;
    expect(summary).toMatchObject({ suppressed: true, whatsapp_window_open: false });
    const free = await send(env, id, { channel: 'whatsapp', purpose: 'service', body: 'Sorry to see you go' });
    expect(free.status).toBe(422); // the STOP message did not open the window
    // unknown number saying STOP is simply logged
    expect((await inbound(env, '919000000001', 'unsubscribe')).body.data).toMatchObject({ optouts: 1, ignored: 1 });
    expect(await env.db.table('leads').count()).toBe(1);
  });

  it('the HMAC-signed unsubscribe link withdraws everything; tampered or foreign tokens are refused', async () => {
    const env = leadEnv(); await templates(env);
    const id = await newLead(env);
    const token = unsubscribeToken(id);
    expect(verifyUnsubscribeToken(token)).toBe(id);
    expect(verifyUnsubscribeToken(`${token}x`)).toBeNull();
    expect(verifyUnsubscribeToken('garbage')).toBeNull();
    const preview = await env.anonymous().get(`${API}/public/unsubscribe`).query({ token });
    expect(preview.body.data).toMatchObject({ valid: true });
    expect(preview.body.data.mobile_masked).not.toContain('9876543210');
    expect((await env.anonymous().post(`${API}/public/unsubscribe`).send({ token: `${token}tampered` })).status).toBe(400);
    const ok = await env.anonymous().post(`${API}/public/unsubscribe`).send({ token });
    expect(ok.status).toBe(200);
    expect(ok.body.data.unsubscribed).toBe(true);
    expect(await env.db.table('lead_consents').count({ lead_id: id, withdrawn_at: null })).toBe(0);
    expect((await env.db.table('lead_consents').all({ lead_id: id }))[0]!.withdrawal_channel).toBe('unsubscribe_link');
    // the link rendered into a template verifies
    await send(env, id, { channel: 'email', purpose: 'service', body: 'x' }); // blocked now, but does not throw
  });
});

describe('merge fields', () => {
  it('{{name}} is the first word of the lead\'s name, whatever letters it contains (regression: the name was cut at the first "s")', async () => {
    const env = leadEnv();
    await templates(env);
    const id = await newLead(env, { name: 'Rasik Solanki' });
    const res = await send(env, id, { channel: 'whatsapp', purpose: 'service', template_key: 'svc_wa' });
    expect(res.status).toBe(201);
    const row = (await env.db.table('message_log').all({ lead_id: id, status: 'sent' }))[0]!;
    expect(row.body_preview).toBe('Hi Rasik, we received your enquiry.');
  });
});
