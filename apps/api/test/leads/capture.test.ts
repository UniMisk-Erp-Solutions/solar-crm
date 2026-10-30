import { describe, expect, it } from 'vitest';
import { hashMobile, seedId, verhoeffCheckDigit } from '@solar/shared';
import { bigrams, nameSimilarity, normaliseName } from '../../src/services/dedupe';
import { API, IDS, leadEnv, person } from './helpers';

describe('public intake — API key, validation, provenance, consent', () => {
  it('rejects a missing or wrong API key with 401', async () => {
    const env = leadEnv();
    const none = await env.anonymous().post(`${API}/public/leads`).send(person());
    expect(none.status).toBe(401);
    const bad = await env.anonymous().post(`${API}/public/leads`).set('X-Api-Key', 'fs_website_not_a_real_key').send(person());
    expect(bad.status).toBe(401);
    expect(await env.db.table('leads').count()).toBe(0);
  });

  it('an inactive key is refused', async () => {
    const env = leadEnv();
    const key = await env.key('website');
    for (const k of await env.db.table('source_api_keys').all()) await env.db.table('source_api_keys').update(k.id, { active: false });
    expect((await env.capture(person(), key)).status).toBe(401);
  });

  it('creates a lead whose source comes from the key, with provenance, E.164 mobile and a consent row naming the recipients', async () => {
    const env = leadEnv();
    const key = await env.key('referral');
    const res = await env.capture(person({ provenance: { utm_source: 'google', utm_campaign: 'diwali', referrer: 'https://example.com/solar' } }), key);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ received: true, consent_recorded: true });
    expect(res.body.data).not.toHaveProperty('status'); // an anonymous caller learns nothing about routing or duplicates
    const lead = await env.lead(res.body.data.lead_id);
    expect(lead.source).toBe('referral');
    expect(lead.mobile).toBe('+919876543210');
    expect(lead.city).toBe('Ahmedabad');
    expect(lead.territory_id).toBe(IDS.territoryAhmedabad);
    expect(lead.source_detail).toMatchObject({ utm_source: 'google', utm_campaign: 'diwali', referrer: 'https://example.com/solar', user_agent: 'vitest-agent' });
    expect(lead.notice_version).toBe('v1');
    const consents = await env.db.table('lead_consents').all({ lead_id: lead.id });
    expect(consents).toHaveLength(1);
    expect(consents[0]).toMatchObject({ notice_version: 'v1', purposes: ['service', 'promotional'], user_agent: 'vitest-agent', capture_source: 'referral' });
    expect(consents[0]!.proof_ref).toMatch(/^referral:/);
    expect(consents[0]!.recipients_named).toEqual(expect.arrayContaining(['Future Solar Pvt. Ltd.', 'Alpha Solar Distributors']));
    const events = (await env.db.table('lead_events').all({ lead_id: lead.id })).map((e) => e.event_type);
    expect(events).toEqual(expect.arrayContaining(['captured', 'dnd_scrubbed', 'assigned', 'consent_recorded', 'status_changed']));
  });

  it('validates the mobile (+91, 10 digits, 6–9) and the e-mail', async () => {
    const env = leadEnv();
    for (const mobile of ['1234567890', '98765', 'abcdefghij', '5876543210']) {
      const r = await env.capture(person({ mobile }));
      expect(r.status, mobile).toBe(422);
      expect(r.body.error.details[0].path).toBe('mobile');
    }
    const bad = await env.capture(person({ email: 'not-an-email' }));
    expect(bad.status).toBe(422);
    expect(bad.body.error.details.map((d: { path: string }) => d.path)).toContain('email');
    const key = await env.key('website');
    for (const [i, mobile] of ['+91 98765 43210', '09876543210', '919876543210'].entries()) {
      expect((await env.capture(person({ mobile, email: undefined, name: `Different Person ${'ABC'[i]}`, pincode: '395003' }), key)).status, mobile).toBe(201);
    }
    expect((await env.db.table('leads').all()).every((l) => l.mobile === '+919876543210')).toBe(true);
  });

  it('refuses an Aadhaar number in any field (G14)', async () => {
    const env = leadEnv();
    const n = '23456789012' + verhoeffCheckDigit('23456789012');
    const r = await env.capture(person({ requirement_text: `my aadhaar ${n.slice(0, 4)} ${n.slice(4, 8)} ${n.slice(8)}` }));
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('AADHAAR_BLOCKED');
  });

  it('a dealer upload must name a dealer and locks the lead to that dealer', async () => {
    const env = leadEnv();
    const key = await env.key('dealer_upload');
    expect((await env.capture(person(), key)).status).toBe(422);
    const ok = await env.capture(person({ dealer_id: IDS.dealerA1 }), key);
    expect(ok.status).toBe(201);
    const lead = await env.lead(ok.body.data.lead_id);
    expect(lead).toMatchObject({ source: 'dealer_upload', dealer_id: IDS.dealerA1, distributor_id: IDS.distributorA, lock_status: 'locked', locked_by_dealer_id: IDS.dealerA1, status: 'assigned' });
    const consent = (await env.db.table('lead_consents').all({ lead_id: lead.id }))[0]!;
    expect(consent.recipients_named).toEqual(expect.arrayContaining(['Alpha Solar Distributors', 'Sunrise Installers']));
    expect(lead.owner_id).toBe(IDS.profile('dealer_user')); // the dealer's own user works the lead
  });

  it('a website key cannot claim a dealer lock', async () => {
    const env = leadEnv();
    const r = await env.capture(person({ dealer_id: IDS.dealerA1 }));
    expect((await env.lead(r.body.data.lead_id)).dealer_id).toBeNull();
  });

  it('serves the consent notice (default and versioned template) and pincode auto-fill', async () => {
    const env = leadEnv();
    const key = await env.key('website');
    const d = await env.anonymous().get(`${API}/public/consent-notice?lang=hi`).set('X-Api-Key', key);
    expect(d.body.data).toMatchObject({ source: 'default', language: 'hi', notice_version: 'default-v1' });
    await env.template({ key: 'consent_notice', channel: 'email', category: 'service', purpose: 'service', body: 'Notice v1' });
    await env.template({ key: 'consent_notice', channel: 'email', category: 'service', purpose: 'service', body: 'Notice v2', version: 2 });
    const t = await env.anonymous().get(`${API}/public/consent-notice`).set('X-Api-Key', key);
    expect(t.body.data).toMatchObject({ source: 'template', notice_version: 'v2', body: 'Notice v2' });
    expect((await env.anonymous().get(`${API}/public/consent-notice`)).status).toBe(401);

    const pin = await env.anonymous().get(`${API}/public/pincode/380001`).set('X-Api-Key', key);
    expect(pin.body.data).toMatchObject({ city: 'Ahmedabad', state: 'Gujarat', serviceable: true });
    const provider = await env.anonymous().get(`${API}/public/pincode/390001`).set('X-Api-Key', key); // not in the table: provider fallback
    expect(provider.body.data).toMatchObject({ city: 'Vadodara', serviceable: false });
    expect((await env.anonymous().get(`${API}/public/pincode/999999`).set('X-Api-Key', key)).status).toBe(404);
    expect((await env.anonymous().get(`${API}/public/pincode/12`).set('X-Api-Key', key)).status).toBe(422);
  });
});

describe('DND scrub', () => {
  it('records a clear result hashed in dnd_register and on the lead', async () => {
    const env = leadEnv();
    const r = await env.capture(person());
    const lead = await env.lead(r.body.data.lead_id);
    expect(lead.dnd_status).toBe('clear');
    expect(lead.dnd_checked_at).not.toBeNull();
    const reg = await env.db.table('dnd_register').all();
    expect(reg).toHaveLength(1);
    expect(reg[0]).toMatchObject({ mobile_hash: hashMobile('+919876543210'), status: 'clear' });
    expect(JSON.stringify(reg)).not.toContain('9876543210');
  });

  it('a registered number is still captured but flagged registered', async () => {
    const env = leadEnv();
    env.providers.dndOverrides.set('+919876543210', 'registered');
    const r = await env.capture(person());
    expect(r.status).toBe(201);
    const lead = await env.lead(r.body.data.lead_id);
    expect(lead.dnd_status).toBe('registered');
    expect((await env.db.table('dnd_register').all())[0]!.status).toBe('registered');
  });
});

describe('duplicate detection', () => {
  it('similarity: bigram Jaccard, order-insensitive, threshold 0.6', () => {
    expect(normaliseName('Patel  Jayesh')).toBe('jayesh patel');
    expect(nameSimilarity('Jayesh Patel', 'Patel Jayesh')).toBe(1);
    expect(nameSimilarity('Jayesh Patel', 'Jayesh Patil')).toBeGreaterThanOrEqual(0.6);
    expect(nameSimilarity('Jayesh Patel', 'Meera Shah')).toBeLessThan(0.3);
    expect(nameSimilarity('', 'x')).toBe(0);
    expect(bigrams('ab').size).toBe(3);
  });

  it('exact mobile → duplicate_of, held for a manager, not routed', async () => {
    const env = leadEnv();
    const first = await env.capture(person());
    const second = await env.capture(person({ name: 'Someone Else', email: 'other@example.com' }));
    const dup = await env.lead(second.body.data.lead_id);
    expect(dup.status).toBe('duplicate');
    expect(dup.duplicate_of).toBe(first.body.data.lead_id);
    expect(dup.distributor_id).toBeNull();
    expect(dup.next_action).toMatch(/Manager review/);
    expect(dup.lock_status).toBe('open');
    expect((await env.db.table('lead_events').all({ lead_id: dup.id })).map((e) => e.event_type)).toContain('duplicate_detected');
    expect(await env.db.table('lead_assignments').count({ lead_id: dup.id })).toBe(0);
  });

  it('exact e-mail and exact consumer number', async () => {
    const env = leadEnv();
    const first = await env.capture(person({ consumer_no: 'GJ1234567' }));
    const byEmail = await env.capture(person({ name: 'Zed Quark', mobile: '9123456789', consumer_no: undefined }));
    expect((await env.lead(byEmail.body.data.lead_id)).duplicate_of).toBe(first.body.data.lead_id);
    const byConsumer = await env.capture(person({ name: 'Zed Quark', mobile: '9123456780', email: 'new@example.com', consumer_no: 'gj1234567' }));
    expect((await env.lead(byConsumer.body.data.lead_id)).duplicate_of).toBe(first.body.data.lead_id);
  });

  it('fuzzy name + same pincode', async () => {
    const env = leadEnv();
    const first = await env.capture(person({ name: 'Jayesh Patel', email: 'j@example.com' }));
    const near = await env.capture(person({ name: 'Patel Jayesh', mobile: '9123456780', email: 'x@example.com' }));
    const a = await env.lead(near.body.data.lead_id);
    expect(a.status).toBe('duplicate');
    expect(a.duplicate_of).toBe(first.body.data.lead_id);
    const other = await env.capture(person({ name: 'Meera Shah', mobile: '9123456781', email: 'm@example.com' }));
    expect((await env.lead(other.body.data.lead_id)).status).toBe('assigned');
    const otherPin = await env.capture(person({ name: 'Jayesh Patel', mobile: '9123456782', email: 'n@example.com', pincode: '395003' }));
    expect((await env.lead(otherPin.body.data.lead_id)).status).toBe('assigned'); // same name, different pincode
  });

  it('an existing customer is reported but does not block the lead', async () => {
    const env = leadEnv();
    const ts = env.now().toISOString();
    await env.db.table('customers').insert({ id: seedId('cust', 1), org_id: IDS.org, created_at: ts, updated_at: ts, created_by: null, legal_name: 'Asha Patel', display_name: null, customer_type: 'residential', gstin: null, pan: null, email: null, phone: '9876543210', billing_address: null, shipping_address: null, state: 'Gujarat', lead_id: null, aadhaar_last4: null, anonymised_at: null });
    const r = await env.capture(person());
    const lead = await env.lead(r.body.data.lead_id);
    expect(lead.status).toBe('assigned');
    const detail = await env.u('admin').get(`${API}/leads/${lead.id}`);
    expect(detail.body.data.duplicates.customers[0]).toMatchObject({ customer_id: seedId('cust', 1), kind: 'mobile' });
    expect((await env.db.table('lead_events').all({ lead_id: lead.id })).map((e) => e.event_type)).toContain('existing_customer_match');
  });

  it('retries of the same webhook reference do not create a second lead', async () => {
    const env = leadEnv();
    const a = await env.capture(person({ source_ref: 'ext-1' }));
    const b = await env.capture(person({ source_ref: 'ext-1' }));
    expect(b.status).toBe(200);
    expect(b.body.data.lead_id).toBe(a.body.data.lead_id);
    expect(await env.db.table('leads').count()).toBe(1);
  });

  it('a lost lead re-enquiring is a fresh lead, not a duplicate', async () => {
    const env = leadEnv();
    const first = await env.capture(person());
    await env.u('admin').post(`${API}/leads/${first.body.data.lead_id}/lost`).send({ reason: 'Not interested right now' });
    const again = await env.capture(person());
    expect((await env.lead(again.body.data.lead_id)).status).toBe('assigned');
  });
});

describe('ownership lock across dealers', () => {
  async function lockedAndChallenger() {
    const env = leadEnv();
    const dealerKey = await env.key('dealer_upload');
    const first = await env.capture(person({ dealer_id: IDS.dealerA1 }), dealerKey);
    const rival = await env.capture(person({ dealer_id: IDS.dealerB1 }), dealerKey);
    return { env, firstId: first.body.data.lead_id as string, rivalId: rival.body.data.lead_id as string };
  }

  it('a lead duplicating a lead locked by a different dealer waits in override_pending', async () => {
    const { env, firstId, rivalId } = await lockedAndChallenger();
    const rival = await env.lead(rivalId);
    expect(rival).toMatchObject({ status: 'duplicate', duplicate_of: firstId, lock_status: 'override_pending', dealer_id: IDS.dealerB1 });
    expect(await env.db.table('notifications').count({ kind: 'lead.duplicate', user_id: IDS.profile('dsm') })).toBe(1);
  });

  it('the same dealer re-uploading is a plain duplicate without a lock conflict', async () => {
    const env = leadEnv();
    const key = await env.key('dealer_upload');
    await env.capture(person({ dealer_id: IDS.dealerA1 }), key);
    const again = await env.capture(person({ dealer_id: IDS.dealerA1 }), key);
    const lead = await env.lead(again.body.data.lead_id);
    expect(lead.status).toBe('duplicate');
    expect(lead.lock_status).toBe('locked');
  });

  it('approve → independent lead that is routed; reject → stays a duplicate', async () => {
    const { env, rivalId } = await lockedAndChallenger();
    const req = await env.u(IDS.dealerUserB).post(`${API}/leads/${rivalId}/lock-override`).send({ reason: 'Customer asked us to quote' });
    expect(req.status).toBe(200);
    expect(req.body.data.lock_status).toBe('override_pending');
    // only sales_manager+ may decide
    expect((await env.u('dsm').post(`${API}/leads/${rivalId}/lock-override/decide`).send({ decision: 'approve' })).status).toBe(403);
    expect((await env.u(IDS.dealerUserB).post(`${API}/leads/${rivalId}/lock-override/decide`).send({ decision: 'approve' })).status).toBe(403);

    const rej = await env.u('sales_manager').post(`${API}/leads/${rivalId}/lock-override/decide`).send({ decision: 'reject', note: 'Dealer A had it first' });
    expect(rej.status).toBe(200);
    expect(rej.body.data).toMatchObject({ status: 'duplicate', lock_status: 'locked' });

    const ok = await env.u('sales_manager').post(`${API}/leads/${rivalId}/lock-override/decide`).send({ decision: 'approve', note: 'Customer confirmed in writing' });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ status: 'assigned', duplicate_of: null, lock_status: 'locked', locked_by_dealer_id: IDS.dealerB1, distributor_id: IDS.distributorB });
    const types = (await env.db.table('lead_events').all({ lead_id: rivalId })).map((e) => e.event_type);
    expect(types).toEqual(expect.arrayContaining(['lock_override_requested', 'lock_override_rejected', 'lock_override_approved', 'assigned']));
    expect(await env.db.table('audit_log').count({ action: 'lead.lock_override_approve', record_id: rivalId })).toBe(1);
  });

  it('only a duplicate can be put forward for an override', async () => {
    const env = leadEnv();
    const r = await env.capture(person());
    const res = await env.u('dsm').post(`${API}/leads/${r.body.data.lead_id}/lock-override`).send({ reason: 'Because I would like to' });
    expect(res.status).toBe(409);
  });

  it('merge moves details and active consents to the target and closes the source', async () => {
    const env = leadEnv();
    const first = await env.capture(person({ email: undefined, consent: undefined }));
    const second = await env.capture(person({ consumer_no: 'GJ99999', capacity_kw: 8 }));
    const secondId = second.body.data.lead_id as string;
    expect((await env.lead(secondId)).status).toBe('duplicate');
    const merged = await env.u('dsm').post(`${API}/leads/${secondId}/merge`).send({ into_lead_id: first.body.data.lead_id });
    expect(merged.status).toBe(200);
    expect(merged.body.data.source).toMatchObject({ status: 'merged', duplicate_of: first.body.data.lead_id });
    const target = await env.lead(first.body.data.lead_id);
    expect(target.email).toBe('asha@example.com'); // filled from the source
    expect(target.consumer_no).toBe('GJ99999');
    expect(await env.db.table('lead_consents').count({ lead_id: target.id, withdrawn_at: null })).toBe(1);
    expect((await env.u('dsm').post(`${API}/leads/${secondId}/merge`).send({ into_lead_id: secondId })).status).toBe(409);
    expect((await env.u('distributor_user').post(`${API}/leads/${secondId}/merge`).send({ into_lead_id: target.id })).status).toBe(403);
  });
});

describe('campaign and WhatsApp webhooks', () => {
  type Field = { name: string; values: string[] };
  const metaPayload = (leadgenId = 'L-100') => ({
    entry: [{ id: 'page-1', time: 1, changes: [{ field: 'leadgen', value: { leadgen_id: leadgenId, form_id: 'F-1', ad_id: 'AD-9', campaign_id: 'C-5', field_data: [
      { name: 'full_name', values: ['Kiran Desai'] }, { name: 'phone_number', values: ['+919811122233'] }, { name: 'email', values: ['kiran@example.com'] },
      { name: 'zip_code', values: ['380001'] }, { name: 'what_is_your_system_size_kw', values: ['5 kW'] }, { name: 'property_type', values: ['Home'] },
      { name: 'i_agree_to_be_contacted', values: ['Yes'] },
    ] as Field[] } }] }],
  });

  it('Meta Lead Ads field_data → a campaign lead with provenance, idempotent on leadgen_id, consent only when ticked', async () => {
    const env = leadEnv();
    const key = await env.key('campaign');
    const r = await env.anonymous().post(`${API}/webhooks/campaign`).set('X-Api-Key', key).send(metaPayload());
    expect(r.status).toBe(200);
    expect(r.body.data.results[0]).toMatchObject({ status: 'created' });
    const lead = await env.lead(r.body.data.results[0].lead_id);
    expect(lead).toMatchObject({ source: 'campaign', name: 'Kiran Desai', mobile: '+919811122233', pincode: '380001', capacity_kw: 5, customer_type: 'residential', source_ref: 'meta:L-100' });
    expect(lead.source_detail).toMatchObject({ platform: 'meta', form_id: 'F-1', ad_id: 'AD-9', campaign_id: 'C-5' });
    expect(await env.db.table('lead_consents').count({ lead_id: lead.id })).toBe(1);
    const again = await env.anonymous().post(`${API}/webhooks/campaign`).set('X-Api-Key', key).send(metaPayload());
    expect(again.body.data.results[0]).toMatchObject({ status: 'existing', lead_id: lead.id });
    expect(await env.db.table('leads').count()).toBe(1);

    const noConsent = metaPayload('L-101');
    const fields = noConsent.entry[0]!.changes[0]!.value.field_data;
    fields.pop();
    fields[1]!.values = ['9811122244'];
    fields[2]!.values = ['other@example.com'];
    fields[0]!.values = ['Different Person'];
    const r2 = await env.anonymous().post(`${API}/webhooks/campaign`).set('X-Api-Key', key).send(noConsent);
    expect(await env.db.table('lead_consents').count({ lead_id: r2.body.data.results[0].lead_id })).toBe(0);
  });

  it('Google lead form (key in the payload), test leads ignored, bad mobile rejected, wrong key type forbidden', async () => {
    const env = leadEnv();
    const key = await env.key('campaign');
    const google = { lead_id: 'G-1', form_id: 'GF', campaign_id: 'GC', gcl_id: 'abc123', is_test: false, google_key: key, user_column_data: [
      { column_id: 'FULL_NAME', string_value: 'Ravi Mehta' }, { column_id: 'PHONE_NUMBER', string_value: '+919822233344' }, { column_id: 'POSTAL_CODE', string_value: '395003' }] };
    const r = await env.anonymous().post(`${API}/webhooks/campaign`).send(google);
    expect(r.status).toBe(200);
    const lead = await env.lead(r.body.data.results[0].lead_id);
    expect(lead).toMatchObject({ name: 'Ravi Mehta', source_ref: 'google:G-1', city: 'Surat' });
    expect(lead.source_detail).toMatchObject({ platform: 'google', gclid: 'abc123' });
    const test = await env.anonymous().post(`${API}/webhooks/campaign`).set('X-Api-Key', key).send({ ...google, lead_id: 'G-2', is_test: true });
    expect(test.body.data.results[0].status).toBe('ignored_test');
    const bad = await env.anonymous().post(`${API}/webhooks/campaign`).set('X-Api-Key', key).send({ ...google, lead_id: 'G-3', user_column_data: [{ column_id: 'PHONE_NUMBER', string_value: '12345' }] });
    expect(bad.body.data.results[0].status).toBe('rejected');
    const website = await env.key('website');
    expect((await env.anonymous().post(`${API}/webhooks/campaign`).set('X-Api-Key', website).send(google)).status).toBe(403);
    expect((await env.anonymous().post(`${API}/webhooks/campaign`).set('X-Api-Key', key).send({ nothing: true })).status).toBe(422);
  });

  it('WhatsApp: Meta verification challenge, inbound message logged and attached, window opens', async () => {
    const env = leadEnv();
    const key = await env.key('whatsapp');
    const ok = await env.anonymous().get(`${API}/webhooks/whatsapp`).query({ 'hub.mode': 'subscribe', 'hub.verify_token': key, 'hub.challenge': '1158201444' });
    expect(ok.status).toBe(200);
    expect(ok.text).toBe('1158201444');
    expect((await env.anonymous().get(`${API}/webhooks/whatsapp`).query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong-token-xx', 'hub.challenge': '1' })).status).toBe(403);
    expect((await env.anonymous().post(`${API}/webhooks/whatsapp`).send({ from: '919876543210', body: 'Hi' })).status).toBe(401);

    const captured = await env.capture(person());
    const leadId = captured.body.data.lead_id as string;
    expect((await env.u('admin').get(`${API}/leads/${leadId}/consents`)).body.data.summary.whatsapp_window_open).toBe(false);
    const inbound = await env.anonymous().post(`${API}/webhooks/whatsapp`).set('X-Api-Key', key).send({ from: '919876543210', body: 'Hello, send me a quote' });
    expect(inbound.body.data).toMatchObject({ received: 1, attached: 1, leads_created: 0 });
    const log = await env.db.table('message_log').all({ lead_id: leadId });
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ direction: 'inbound', channel: 'whatsapp' });
    expect(log[0]!.to_masked).not.toContain('9876543210');
    expect((await env.u('admin').get(`${API}/leads/${leadId}/consents`)).body.data.summary.whatsapp_window_open).toBe(true);
  });

  it('WhatsApp inbound from an unknown number creates a WhatsApp lead (no consent) that goes to the DSM', async () => {
    const env = leadEnv();
    const key = await env.key('whatsapp');
    const r = await env.anonymous().post(`${API}/webhooks/whatsapp`).query({ key }).send({ from: '919000011111', body: 'I want solar' });
    expect(r.body.data).toMatchObject({ leads_created: 1, attached: 1 });
    const lead = (await env.db.table('leads').all())[0]!;
    expect(lead).toMatchObject({ source: 'whatsapp', status: 'unassigned', owner_id: IDS.profile('dsm') });
    expect(await env.db.table('lead_consents').count({ lead_id: lead.id })).toBe(0);
  });

  it('a WhatsApp message containing an Aadhaar number is not stored', async () => {
    const env = leadEnv();
    const key = await env.key('whatsapp');
    const n = '23456789012' + verhoeffCheckDigit('23456789012');
    await env.anonymous().post(`${API}/webhooks/whatsapp`).set('X-Api-Key', key).send({ from: '919000011112', body: `my aadhaar is ${n}` });
    const logs = await env.db.table('message_log').all();
    expect(logs[0]!.body_preview).toMatch(/withheld/);
    expect((await env.db.table('leads').all())[0]!.requirement_text).toMatch(/withheld/);
  });
});
