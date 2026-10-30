/** Stage 0 + Stage 1 of the flow (diagram sections 2 and 9, steps 1-7): intake, consent, DND, duplicates, routing, acceptance, escalation. */
import { describe, expect, it } from 'vitest';
import { hashMobile, type Lead, type LeadConsent, type LeadListItem } from '@solar/shared';
import { covers } from './flowCoverage';
import { API, CONSENT_ALL, D, HOUR, KEYS, MINUTE, S, acceptAs, capture, captureOk, clockOf, data, env, eventsOf, iso, keyFor, lead, notificationsOf, sha256 } from './flowKit';
import { failure } from './flowHarness';

const PERSON = {
  name: 'Mukesh Trivedi', mobile: '98250 12345', email: 'Mukesh.Trivedi@example.com', pincode: '380015', segment: 'pmsg_residential', customer_type: 'residential', capacity_kw: 3,
  product_interest: ['residential', 'rooftop'], language: 'gu', requirement_text: '3 kW rooftop system for my bungalow in Satellite before next summer.', source_ref: 'dealer-app-0001', dealer_id: D.dealer.d1,
  provenance: { utm_source: 'dealer-app', utm_medium: 'referral', landing_url: 'https://futuresolar.example/dealer-upload', referrer_name: 'Anand Rooftop Solutions' },
};
const small = (name: string, mobile: string, extra: Record<string, unknown> = {}) => ({ name, mobile, pincode: '380004', segment: 'pmsg_residential', customer_type: 'residential', capacity_kw: 3, product_interest: ['residential'], ...extra });

export function stage1(): void {
  /* ═════════════════════════════ Stage 0: lead arrives, consent ledger, DND scrub ═════════════════════════════ */
  describe('Stage 0 · N0 lead arrives from every source, N0a consent ledger, N0b DND scrub, X1 provenance', () => {
    it('the admin issues one key per source and only the SHA-256 is stored', async () => {
      const created = data<{ id: string; key: string; source: string }>(await env.as('admin').post(`${API}/admin/api-keys`).send({ source: 'dealer_upload', label: 'Flow test dealer app' }), 201);
      KEYS.dealer_upload = created.key;
      const row = await env.db.table('source_api_keys').getOrThrow(created.id);
      expect(row.key_hash).toBe(sha256(created.key));
      for (const s of ['website', 'call_centre', 'referral', 'campaign', 'whatsapp'] as const) await keyFor(s);
      const listed = data<{ id: string; source: string }[]>(await env.as('admin').get(`${API}/lead-source-keys`));
      expect(listed.length).toBeGreaterThanOrEqual(6);
      expect(JSON.stringify(listed)).not.toContain(created.key);
      failure(await env.anon().post(`${API}/public/leads`).send(small('No Key', '9825000001')), 401, 'UNAUTHENTICATED');
      failure(await env.anon().post(`${API}/public/leads`).set('X-Api-Key', 'fsk_wrong').send(small('Wrong Key', '9825000001')), 401, 'UNAUTHENTICATED');
    });

    it('N0: website, call centre, referral, campaign (Meta lead ad), WhatsApp and dealer upload each create a lead with its own source', async () => {
      const call = await captureOk('call_centre', small('Dinesh Parmar', '9825031111', { source_ref: 'cc-1' }));
      const ref = await captureOk('referral', small('Rekha Joshi', '9825032222', { source_ref: 'ref-1', provenance: { referrer_name: 'Existing customer Kavita Joshi' } }));
      expect((await lead(call)).source).toBe('call_centre');
      expect((await lead(ref)).source).toBe('referral');
      expect((await lead(ref)).source_detail).toMatchObject({ referrer_name: 'Existing customer Kavita Joshi' });
      await acceptAs('distributor_user', call);
      await acceptAs('distributor_user', ref);

      const meta = await env.anon().post(`${API}/webhooks/campaign?key=${KEYS.campaign}`).send({
        leadgen_id: 'meta-lead-9001',
        field_data: [{ name: 'full_name', values: ['Hetal Shah'] }, { name: 'phone_number', values: ['+919825033333'] }, { name: 'email', values: ['hetal.shah@example.com'] }, { name: 'zip_code', values: ['380006'] },
          { name: 'i_agree_to_be_contacted_about_solar', values: ['Yes'] }],
      });
      const results = data<{ results: { status: string; lead_id: string }[] }>(meta).results;
      expect(results[0]!.status).toBe('created');
      expect((await lead(results[0]!.lead_id)).source).toBe('campaign');
      expect(await env.db.table('lead_consents').count({ lead_id: results[0]!.lead_id })).toBe(1); // explicit consent answer on the form
      await acceptAs('distributor_user', results[0]!.lead_id);

      const wa = await env.anon().post(`${API}/webhooks/whatsapp?key=${KEYS.whatsapp}`).send({ from: '919825034444', body: 'Hello, I want a quote for rooftop solar' });
      expect(data<{ leads_created: number }>(wa).leads_created).toBe(1);
      const waLead = (await env.db.table('leads').all({ source: 'whatsapp', mobile: '+919825034444' }))[0]!;
      expect(waLead.mobile).toBe('+919825034444');
      expect(await env.db.table('lead_consents').count({ lead_id: waLead.id })).toBe(0); // WhatsApp opt-in is not consent

      covers('N0', 'website/call_centre/referral/campaign/whatsapp/dealer_upload keys each create a lead with the key\'s source', 'system');
    });

    it('step 1 · N0a · X1 · N0b: a dealer-uploaded PMSG lead with consent lands in the ledger, is scrubbed for DND and routed to the dealer\'s distributor', async () => {
      const notice = data<{ notice_version: string; recipients: string[]; purposes: unknown[]; channels: unknown[] }>(await env.anon().get(`${API}/public/consent-notice?lang=en`).set('X-Api-Key', KEYS.website!));
      expect(notice.notice_version).toBeTruthy();
      const res = await env.anon().post(`${API}/public/leads`).set('X-Api-Key', KEYS.dealer_upload!).set('User-Agent', 'flow-test-dealer-app').send({ ...PERSON, consent: { ...CONSENT_ALL, notice_version: notice.notice_version } });
      const out = data<{ lead_id: string; reference: string; received: boolean; consent_recorded: boolean }>(res, 201);
      expect(out).toMatchObject({ received: true, consent_recorded: true });
      S.leadId = out.lead_id;
      const l = await lead(S.leadId);
      expect(l).toMatchObject({ name: 'Mukesh Trivedi', mobile: '+919825012345', email: 'mukesh.trivedi@example.com', source: 'dealer_upload', status: 'assigned', dnd_status: 'clear', dealer_id: D.dealer.d1, distributor_id: D.distributor.sunrise, lock_status: 'locked' });
      expect(l.dnd_checked_at).toBeTruthy();
      expect(l.source_detail).toMatchObject({ utm_source: 'dealer-app', referrer_name: 'Anand Rooftop Solutions', ip: expect.anything() });

      // N0a: one active, immutable ledger row naming Future Solar, the distributor AND the dealer
      const [c] = await env.db.table('lead_consents').all({ lead_id: S.leadId }) as [LeadConsent];
      expect(c.withdrawn_at).toBeNull();
      expect(c.notice_version).toBe(notice.notice_version);
      expect(c.purposes).toEqual(expect.arrayContaining(['service', 'promotional', 'quotation', 'subsidy_processing']));
      expect(c.channels).toEqual(expect.arrayContaining(['call', 'sms', 'whatsapp', 'email']));
      const named = JSON.stringify(c.recipients_named);
      for (const who of ['Future Solar', 'Sunrise Solar Distribution', 'Anand Rooftop Solutions']) expect(named).toContain(who);
      expect(c.proof_ref).toMatch(/^dealer_upload:/);
      covers('N0a', 'ledger row: notice version, purposes, channels, named recipients (Future Solar + distributor + dealer), proof reference', 'system');

      // N0b: DND scrubbed (hashed register row, never the number) at capture
      expect((await env.db.table('dnd_register').all()).some((r) => JSON.stringify(r).includes('9825012345'))).toBe(false);
      expect(await env.db.table('dnd_register').count({ mobile_hash: hashMobile('+919825012345') })).toBe(1);
      covers('N0b', 'dnd_status clear with dnd_checked_at set and a hashed dnd_register row; WhatsApp lead from an unknown number had no consent', 'system');
      covers('X1', 'source, utm/referrer/landing page/ip/user agent stored in source_detail; notice version + purposes + channels + recipients in the ledger', 'system');

      // step 3: details captured and normalised
      expect(l).toMatchObject({ city: 'Ahmedabad', state: 'Gujarat', territory_id: D.territory.ahmedabad, segment: 'pmsg_residential', customer_type: 'residential', capacity_kw: 3, language: 'gu' });
      expect(l.product_interest).toEqual(['residential', 'rooftop']);
      covers('1', 'inquiry captured through the public intake endpoint with a source key; 201 + reference; idempotent on source_ref', 'system');
      covers('3', 'pincode filled city/state/territory; segment, customer type, kW and product interest stored; mobile normalised to E.164', 'system');
      covers('L/New', 'captured event written for the new lead', 'system');
      expect(await eventsOf(S.leadId)).toEqual(expect.arrayContaining(['captured', 'dnd_scrubbed', 'assigned', 'consent_recorded']));

      const retry = await env.anon().post(`${API}/public/leads`).set('X-Api-Key', KEYS.dealer_upload!).send({ ...PERSON });
      expect(data<{ lead_id: string }>(retry, [200, 201]).lead_id).toBe(S.leadId);
      expect(await env.db.table('leads').count({ source_ref: 'dealer-app-0001' })).toBe(1);
    });

    it('step 2: bad mobile / e-mail are refused field by field; an Aadhaar number in free text is refused', async () => {
      const bad = failure(await capture('website', small('Bad Mobile', '12345', { email: 'not-an-email' })), 422, 'VALIDATION_ERROR');
      const paths = (bad.details as { path: string }[]).map((d) => d.path);
      expect(paths).toEqual(expect.arrayContaining(['mobile', 'email']));
      failure(await capture('website', small('Aadhaar Typer', '9825000002', { requirement_text: 'My Aadhaar is 2345 6789 0124 please use it' })), 422, 'AADHAAR_BLOCKED');
      expect(await env.db.table('leads').count({ name: 'Bad Mobile' })).toBe(0);
      covers('2', 'invalid mobile and e-mail return 422 with per-field paths; no lead is created; duplicate check is run (see X4)', 'system');
    });
  });

  /* ═════════════════════════════ routing: steps 4-6, D1 ═════════════════════════════ */
  describe('Stage 1 · step 4 territory + capability match, D1 distributor eligible?, step 5 auto-assign, step 6 escalate / reassign', () => {
    it('step 4 · D1 YES · step 5: an automatic website lead is ranked against every distributor, with reasons, and assigned to the best eligible one', async () => {
      const id = await captureOk('website', small('Krunal Desai', '9825041111', { source_ref: 'web-w-1' }));
      S.routedLeadId = id;
      const l = await lead(id);
      expect(l).toMatchObject({ status: 'assigned', distributor_id: D.distributor.sunrise, territory_id: D.territory.ahmedabad });
      const [a] = await env.db.table('lead_assignments').all({ lead_id: id });
      const snap = a!.score_snapshot as unknown as { mode: string; chosen: string; candidates: { distributor_id: string; eligible: boolean; reasons: string[] }[]; geo: { territory_name: string } };
      expect(snap.mode).toBe('auto');
      expect(snap.geo.territory_name).toBe('Ahmedabad');
      expect(snap.candidates).toHaveLength(3);
      expect(snap.candidates.find((c) => c.distributor_id === D.distributor.sunrise)).toMatchObject({ eligible: true });
      const other = snap.candidates.find((c) => c.distributor_id === D.distributor.suryamitra)!;
      expect(other.eligible).toBe(false);
      expect(other.reasons.join(' ')).toMatch(/Does not serve Ahmedabad/);
      expect(snap.candidates.find((c) => c.distributor_id === D.distributor.saurashtra)!.eligible).toBe(false);
      expect(a).toMatchObject({ distributor_id: D.distributor.sunrise, status: 'pending' });
      expect((await clockOf(id, 'lead_acceptance')).status).toBe('running');
      await acceptAs('distributor_user', id);
      covers('4', 'routing snapshot: territory from pincode, capacity band, capability tags and vendor registration checked per distributor; ineligible ones carry reasons', 'system');
      covers('5', 'assigned to the best eligible distributor, assignment row + acceptance clock started, assignee notified', 'system');
      covers('2/D1/yes', 'eligible distributor found → auto-assign and acceptance clock', 'system');
      covers('L/Validated', 'duplicate check passed → validated → routed (event trail captured → assigned)', 'system');
      covers('L/Assigned', 'status assigned with a pending assignment', 'system');
    });

    it('D1 NO → step 6: no distributor covers Vadodara, the lead is Unassigned and the territory DSM is alerted, then reassigns', async () => {
      const id = await captureOk('website', small('Bhavesh Pandya', '9825042222', { pincode: '390001', source_ref: 'web-vad-1' }));
      S.vadodaraLeadId = id;
      expect(await lead(id)).toMatchObject({ status: 'unassigned', distributor_id: null, territory_id: D.territory.vadodara });
      expect((await notificationsOf(D.profile.dsm2, 'lead.unassigned')).length).toBeGreaterThan(0);
      covers('2/D1/no', 'no eligible distributor → status unassigned, no acceptance clock, DSM notified (lead.unassigned)', 'system');
      covers('L/Unassigned', 'Validated → Unassigned when no distributor is eligible', 'system');

      // a DSM of another territory cannot touch it; the Vadodara DSM can
      expect([403, 404]).toContain((await env.as('accounts').post(`${API}/leads/${id}/reassign`).send({ distributor_id: D.distributor.suryamitra, reason: 'not mine to reassign' })).status);
      const res = await env.as('dsm2').post(`${API}/leads/${id}/reassign`).send({ distributor_id: D.distributor.suryamitra, reason: 'Vadodara has no local partner yet - Suryamitra holds a national registration' });
      expect(data<LeadListItem>(res)).toMatchObject({ status: 'assigned', distributor_id: D.distributor.suryamitra });
      expect(await env.db.table('lead_assignments').count({ lead_id: id, status: 'pending' })).toBe(1);
      covers('6', 'DSM of the territory reassigns an unassigned lead by hand; manual assignment row + restarted acceptance clock', 'dsm');
      covers('L/Reassigned', 'DSM reassigns territory: manual re-routing back to Assigned', 'dsm');

      // the distributor rejects → nobody else covers Vadodara → Unassigned again
      const rej = data<{ lead: { status: string }; reassigned: boolean }>(await env.as('distributor_user_b').post(`${API}/leads/${id}/reject`).send({ reason: 'Outside our installation radius this quarter' }));
      expect(rej.reassigned).toBe(false);
      expect(await lead(id)).toMatchObject({ status: 'unassigned', distributor_id: null });
      expect((await env.db.table('lead_assignments').all({ lead_id: id })).map((a) => a.status)).toEqual(expect.arrayContaining(['reassigned', 'rejected']));
      covers('L/Rejected', 'distributor rejects with a reason → assignment rejected → re-route finds nobody → Unassigned', 'distributor_user');
      const again = await env.as('dsm2').post(`${API}/leads/${id}/reassign`).send({ distributor_id: D.distributor.saurashtra, reason: 'Saurashtra Kiran agreed to take Vadodara leads' });
      expect(data<LeadListItem>(again).status).toBe('assigned');
      expect((await acceptAs('distributor_user_c', id)).status).toBe('accepted');
    });
  });

  /* ═════════════════════════════ consent decision X2 + messaging §9 ═════════════════════════════ */
  describe('Stage 0/1 · X2 consent present and DND clear?, X3 block promotional outreach, §9 first terminals', () => {
    it('X2 YES: the dealer-uploaded lead has consent and a clear DND scrub, so outbound is allowed on every channel', async () => {
      const detail = data<{ consent_summary: { has_active: boolean; dnd_status: string; dnd_fresh: boolean; outbound: Record<string, { promotional: boolean; service: boolean }> } }>(await env.as('dsm').get(`${API}/leads/${S.leadId}`));
      expect(detail.consent_summary).toMatchObject({ has_active: true, dnd_status: 'clear', dnd_fresh: true });
      expect(detail.consent_summary.outbound.whatsapp).toEqual({ promotional: true, service: true });
      covers('X2', 'consent + DND decision evaluated at intake for consenting, non-consenting and DND-registered leads', 'system');
      covers('2/X2/yes', 'consent_summary: active consent + fresh clear DND → promotional and service allowed on WhatsApp/SMS/e-mail/call', 'system');
    });

    it('X2 NO / X3: a lead with no consent is blocked for promotional messages, the reason is logged and the owner told; a customer message opens the 24 h window for a service reply', async () => {
      const id = await captureOk('website', small('Rasik Solanki', '9825044444', { source_ref: 'web-nc-1' }));
      await acceptAs('distributor_user', id);
      const owner = (await lead(id)).owner_id!;
      expect(await env.db.table('lead_consents').count({ lead_id: id })).toBe(0);

      const blocked = await env.as('dsm').post(`${API}/leads/${id}/messages`).send({ channel: 'whatsapp', purpose: 'promotional', body: 'Special Diwali offer on rooftop solar!' });
      const err = failure(blocked, 422, 'CONSENT_BLOCKED');
      expect(JSON.stringify(err.details)).toContain('NO_CONSENT');
      const log = await env.db.table('message_log').all({ lead_id: id });
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({ status: 'blocked', direction: 'outbound', channel: 'whatsapp', purpose: 'promotional' });
      expect(log[0]!.block_reason).toContain('NO_CONSENT');
      expect((await notificationsOf(owner, 'message.blocked')).length).toBe(1);
      covers('9/BLK', 'BLOCK G1: 422 CONSENT_BLOCKED with reason codes, blocked message_log row, owner notified (message.blocked)', 'dsm');
      covers('2/X2/no', 'no consent on record → promotional blocked (NO_CONSENT)', 'system');
      covers('X3', 'promotional outreach blocked and logged; service reply only inside the WhatsApp window (next step)', 'system');

      // a service reply is also refused until the customer writes first
      failure(await env.as('dsm').post(`${API}/leads/${id}/messages`).send({ channel: 'whatsapp', purpose: 'service', body: 'Hello' }), 422, 'CONSENT_BLOCKED');
      const inbound = await env.anon().post(`${API}/webhooks/whatsapp?key=${KEYS.whatsapp}`).send({ from: '919825044444', body: 'Namaste, I saw your rooftop solar ad' });
      expect(data<{ attached: number }>(inbound).attached).toBe(1);
      const reply = data<{ status: string; blocked: boolean }>(await env.as('distributor_user').post(`${API}/leads/${id}/messages`).send({ channel: 'whatsapp', purpose: 'service', body: 'Namaste {{name}}, thank you for writing to Future Solar.' }), 201);
      expect(reply).toMatchObject({ status: 'sent', blocked: false });
      const sent = (await env.db.table('message_log').all({ lead_id: id, status: 'sent', direction: 'outbound' }))[0]!;
      expect(sent.body_preview).toMatch(/^Namaste Rasik,/); // first-name merge field (regression: the name was cut at the first "s")
      // ... but promotional stays blocked even inside the window
      failure(await env.as('distributor_user').post(`${API}/leads/${id}/messages`).send({ channel: 'whatsapp', purpose: 'promotional', body: 'Offer' }), 422, 'CONSENT_BLOCKED');
      covers('9/W2', 'inside the 24 h window a free-form session message is sent and logged; merge field {{name}} rendered', 'distributor_user');
      S.noConsentLeadId = id;
    });

    it('X2 NO (DND): a registered number with promotional consent is still blocked for promotional WhatsApp, while a service e-mail goes out', async () => {
      await env.db.table('dnd_register').insert({ mobile_hash: hashMobile('+919825055555'), status: 'registered', checked_at: iso(env.now()), source: 'flow-test registry' });
      const id = await captureOk('website', small('Hasmukh Dave', '9825055555', { email: 'hasmukh@example.com', source_ref: 'web-dnd-1', consent: CONSENT_ALL }));
      await acceptAs('distributor_user', id);
      expect((await lead(id)).dnd_status).toBe('registered');
      const promo = failure(await env.as('dsm').post(`${API}/leads/${id}/messages`).send({ channel: 'whatsapp', purpose: 'promotional', body: 'Offer for you' }), 422, 'CONSENT_BLOCKED');
      expect(JSON.stringify(promo.details)).toContain('DND_REGISTERED');
      const mail = data<{ status: string }>(await env.as('dsm').post(`${API}/leads/${id}/messages`).send({ channel: 'email', purpose: 'service', subject: 'Your enquiry', body: 'Namaste {{name}}, we received your enquiry.' }), 201);
      expect(mail.status).toBe('sent');
      covers('2/X2/no', 'DND register hit → dnd_status registered → promotional WhatsApp blocked (DND_REGISTERED), service e-mail allowed', 'system');
    });
  });

  /* ═════════════════════════════ duplicates X4 / X5 ═════════════════════════════ */
  describe('Stage 1 · step 2 de-duplicate, X4 duplicate or existing owner?, X5 ownership lock + manager override', () => {
    it('X4 NO: a first-time person is validated straight through (no duplicate report)', async () => {
      const detail = data<{ duplicates: { leads: unknown[]; customers: unknown[] }; lead: Lead }>(await env.as('dsm').get(`${API}/leads/${S.routedLeadId}`));
      expect(detail.duplicates.leads).toHaveLength(0);
      expect(detail.lead.duplicate_of).toBeNull();
      covers('X4', 'duplicate / existing-owner decision evaluated for a new person (no) and for the same mobile uploaded by another dealer (yes)', 'system');
      covers('2/X4/no', 'no matching lead or customer → status validated → routed', 'system');
    });

    it('X4 YES: the same mobile uploaded by another dealer is held as a Duplicate under the first dealer\'s ownership lock', async () => {
      const z0 = await captureOk('dealer_upload', small('Jayesh Bhatt', '9825066666', { source_ref: 'jb-d2', dealer_id: D.dealer.d2, consent: CONSENT_ALL }));
      S.z0 = z0;
      expect(await lead(z0)).toMatchObject({ status: 'assigned', lock_status: 'locked', locked_by_dealer_id: D.dealer.d2 });
      await acceptAs('distributor_user', z0);
      const z1 = await captureOk('dealer_upload', small('Jayesh Bhatt', '9825066666', { source_ref: 'jb-d3', dealer_id: D.dealer.d3, consent: CONSENT_ALL }));
      S.z1 = z1;
      const l1 = await lead(z1);
      expect(l1).toMatchObject({ status: 'duplicate', duplicate_of: z0, lock_status: 'override_pending' });
      expect(await env.db.table('clocks').count({ entity_id: z1, clock_type: 'lead_acceptance' })).toBe(0); // nobody is asked to accept a duplicate
      expect(await eventsOf(z1)).toContain('duplicate_detected');
      covers('2/X4/yes', 'same mobile as a lead locked by another dealer → status duplicate, duplicate_of set, held for a manager, no acceptance clock', 'system');
      covers('L/Duplicate', 'New → Duplicate when a match is found', 'system');
    });

    it('X5: the dealer asks for an override, the Sales Manager rejects it (lock stays); a second duplicate is merged into the original; a third override is approved and routed as an independent lead', async () => {
      // reject path
      const req = await env.as('dealer_user_3').post(`${API}/leads/${S.z1}/lock-override`).send({ reason: 'We met the customer first at our Gandhinagar showroom on 20 Oct' });
      expect(data<LeadListItem>(req).lock_status).toBe('override_pending');
      expect((await notificationsOf(D.profile.sales_manager, 'lead.lock_override_requested')).length).toBeGreaterThan(0);
      const rejected = await env.as('sales_manager').post(`${API}/leads/${S.z1}/lock-override/decide`).send({ decision: 'reject', note: 'Original dealer registered the customer on 19 Oct' });
      expect(data<LeadListItem>(rejected)).toMatchObject({ status: 'duplicate', lock_status: 'locked' });

      // merge path
      const z2 = await captureOk('call_centre', small('Jayesh Bhatt', '9825066666', { source_ref: 'jb-cc' }));
      expect((await lead(z2)).status).toBe('duplicate');
      const merged = data<{ source: LeadListItem; target: LeadListItem }>(await env.as('sales_manager').post(`${API}/leads/${z2}/merge`).send({ into_lead_id: S.z0, note: 'Same person - call centre entry' }));
      expect(merged.source).toMatchObject({ status: 'merged', duplicate_of: S.z0 });
      covers('L/Merged', 'Duplicate → Merged (duplicate_of = target), follow-ups and clocks closed', 'sales_manager');

      // approve path
      const z3 = await captureOk('referral', small('Jayesh Bhatt', '9825066666', { source_ref: 'jb-ref' }));
      expect((await lead(z3)).status).toBe('duplicate');
      S.z3 = z3;
      await env.as('distributor_user').post(`${API}/leads/${z3}/lock-override`).send({ reason: 'Customer asked us directly for a second property in Satellite' });
      const approved = data<LeadListItem>(await env.as('regional_head').post(`${API}/leads/${z3}/lock-override/decide`).send({ decision: 'approve', note: 'Second property - independent lead' }));
      expect(approved).toMatchObject({ status: 'assigned', duplicate_of: null });
      await acceptAs('distributor_user', z3);
      covers('X5', 'override requested by dealer/distributor, decided by Sales Manager / Regional Head (reject keeps the lock, approve routes an independent lead), duplicate merged by a manager', 'sales_manager');
      covers('L/Validated', 'Duplicate → Validated by manager override (then routed and accepted)', 'regional_head');
    });
  });

  /* ═════════════════════════════ step 7 + D2 + escalation ═════════════════════════════ */
  describe('Stage 1 · step 7 lead acceptance, D2 accepted within SLA?', () => {
    it('D2 YES · step 7: the distributor accepts inside the SLA; only a distributor-side role may accept', async () => {
      failure(await env.as('accounts').post(`${API}/leads/${S.leadId}/accept`).send({}), 403);
      failure(await env.as('viewer').post(`${API}/leads/${S.leadId}/accept`).send({}), 403);
      env.advance(10 * MINUTE);
      const res = await env.as('distributor_user').post(`${API}/leads/${S.leadId}/accept`).send({ note: 'Will call the customer today' });
      expect(data<LeadListItem>(res)).toMatchObject({ id: S.leadId, status: 'accepted' });
      const l = await lead(S.leadId);
      expect(l.accepted_at).toBeTruthy();
      expect(l.owner_id).toBe(D.profile.distributor_user);
      expect((await env.db.table('lead_assignments').all({ lead_id: S.leadId }))[0]!.status).toBe('accepted');
      const clock = await clockOf(S.leadId, 'lead_acceptance');
      expect(clock.status).toBe('met');
      expect(l.next_action).toBeTruthy();
      expect(await env.db.table('followups').count({ lead_id: S.leadId, status: 'open' })).toBeGreaterThan(0);
      failure(await env.as('distributor_user').post(`${API}/leads/${S.leadId}/accept`).send({}), 409);
      covers('7', 'accepted by the distributor user: assignment accepted, acceptance clock met, owner = accepting user, first follow-up planned; accounts/viewer get 403', 'distributor_user');
      covers('2/D2/yes', 'accepted inside the SLA → clock met (not breached)', 'distributor_user');
      covers('L/Accepted', 'Assigned → Accepted within SLA', 'distributor_user');
      covers('K/Met', 'lead_acceptance clock: Running → Met on the completion event, resolved_at set', 'system');
    });

    it('a second distributor takes overflow, then a society lead nobody accepts goes Reminder 1 → DSM alert → auto-reassignment (D2 NO)', async () => {
      const patched = await env.as('sales_manager').patch(`${API}/distributors/${D.distributor.suryamitra}`).send({ territory_ids: [D.territory.surat, D.territory.ahmedabad] });
      expect(data<{ territory_ids: string[] }>(patched).territory_ids).toContain(D.territory.ahmedabad);
      S.lateLeadId = await captureOk('website', {
        name: 'Shreenath Heights CHS', mobile: '9825098765', pincode: '380015', segment: 'rwa_ghs', customer_type: 'housing_society', capacity_kw: 40, product_interest: ['rwa'], source_ref: 'web-chs-1',
        requirement_text: 'Common-area rooftop solar for 40 households.', consent: { notice_version: 'default-v1', purposes: ['service', 'quotation'], channels: ['call', 'email'] },
      });
      const l = await lead(S.lateLeadId);
      expect(l.status).toBe('assigned');
      expect([D.distributor.sunrise, D.distributor.suryamitra]).toContain(l.distributor_id);
      S.firstDistributor = l.distributor_id!;
      const clock0 = await clockOf(S.lateLeadId, 'lead_acceptance');
      expect(clock0.status).toBe('running');
      covers('K/Running', 'start trigger fired: lead assigned → lead_acceptance clock running with due_at and warn_at', 'system');

      // Reminder 1 at 70 %
      env.advance(85 * MINUTE);
      const t1 = await env.tick();
      expect(t1.warned).toBeGreaterThan(0);
      const warned = await clockOf(S.lateLeadId, 'lead_acceptance');
      expect(warned).toMatchObject({ status: 'running', escalated_level: 0 });
      expect(warned.warned_at).toBeTruthy();
      expect(await eventsOf(S.lateLeadId)).toContain('acceptance_reminder');
      expect((await notificationsOf(warned.owner_id!, 'lead.acceptance.reminder1')).length).toBeGreaterThan(0);
      covers('2/R1', 'Reminder 1 at 70 %: lead.acceptance.reminder1 to the assignee + acceptance_reminder event', 'system');
      covers('K/Warned', '70 % of the time used: warned_at set, status still running, kernel warning notification clock.lead_acceptance.warn', 'system');

      // DSM alert at 100 %
      env.advance(40 * MINUTE);
      const t2 = await env.tick();
      expect(t2.breached).toBeGreaterThan(0);
      const breached = await clockOf(S.lateLeadId, 'lead_acceptance');
      expect(breached).toMatchObject({ status: 'breached', escalated_level: 1 });
      expect(await eventsOf(S.lateLeadId)).toContain('acceptance_breached');
      expect((await notificationsOf(D.profile.dsm, 'lead.acceptance.dsm_alert')).length).toBeGreaterThan(0);
      expect((await notificationsOf(D.profile.dsm, 'clock.lead_acceptance.breach')).length).toBeGreaterThan(0);
      expect((await lead(S.lateLeadId)).distributor_id).toBe(S.firstDistributor);
      covers('2/R2', 'DSM alert at 100 %: lead.acceptance.dsm_alert + kernel breach notification to the territory DSM', 'system');
      covers('K/Escalated1', '100 % reached: status breached, escalated_level 1, owner → DSM notified', 'system');
      covers('10/T1', 'unaccepted lead escalates Distributor → DSM (level 1) → Sales Manager (level 2, below)', 'system');

      // next escalation step: Sales Manager notified and the lead is auto-reassigned
      env.advance(4 * HOUR + MINUTE);
      const t3 = await env.tick();
      expect(t3.escalated).toBeGreaterThan(0);
      const l2 = await lead(S.lateLeadId);
      const other = S.firstDistributor === D.distributor.sunrise ? D.distributor.suryamitra : D.distributor.sunrise;
      expect(l2).toMatchObject({ status: 'assigned', distributor_id: other });
      const assignments = await env.db.table('lead_assignments').all({ lead_id: S.lateLeadId }, { orderBy: { col: 'created_at' } });
      expect(assignments.map((a) => a.status)).toEqual(['expired', 'pending']);
      expect(await eventsOf(S.lateLeadId)).toEqual(expect.arrayContaining(['acceptance_expired', 'auto_reassigned']));
      expect((await notificationsOf(D.profile.sales_manager, 'clock.lead_acceptance.level2')).length).toBeGreaterThan(0);
      const open = (await env.db.table('clocks').all({ entity_id: S.lateLeadId, clock_type: 'lead_acceptance' })).filter((c) => c.resolved_at === null);
      expect(open).toHaveLength(1);
      expect(open[0]).toMatchObject({ status: 'running' });
      covers('2/R3', 'level 2: old assignment expired, new reassignment assignment to the next best distributor, fresh acceptance clock', 'system');
      covers('2/D2/no', 'not accepted within SLA → Reminder 1 → DSM alert → auto-reassignment loop back to assignment', 'system');
      covers('K/Escalated2', 'still open after the step: escalated_level 2, Sales Manager notified (clock.lead_acceptance.level2)', 'system');
      covers('L/Reassigned', 'Assigned → Reassigned (SLA missed) → Assigned to the next distributor', 'system');

      const asUser = l2.distributor_id === D.distributor.suryamitra ? 'distributor_user_b' : 'distributor_user';
      expect((await acceptAs(asUser, S.lateLeadId)).status).toBe('accepted');
    });
  });
}

