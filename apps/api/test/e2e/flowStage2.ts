/** Stage 2 of the flow (diagram section 3, steps 8-13): contact, qualification, temperature + deadline uplift, score, follow-up engine, escalation, channel rules, opt-out. */
import { describe, expect, it } from 'vitest';
import type { Followup, LeadListItem } from '@solar/shared';
import { covers } from './flowCoverage';
import { API, CONSENT_ALL, D, DAY, HOUR, KEYS, MINUTE, S, acceptAs, captureOk, clockOf, data, env, eventsOf, funnel, goto, iso, lead, notificationsOf } from './flowKit';
import { failure } from './flowHarness';

const person = (name: string, mobile: string, extra: Record<string, unknown> = {}) => ({ name, mobile, pincode: '380008', segment: 'ci_captive', customer_type: 'industrial', capacity_kw: 90, product_interest: ['small_commercial'], consent: CONSENT_ALL, ...extra });
const qualify = (who: 'distributor_user', id: string, body: Record<string, unknown>) => env.as(who).post(`${API}/leads/${id}/qualification`).send(body);
const daysAhead = (isoTime: string | null) => (new Date(isoTime ?? 0).getTime() - env.now().getTime()) / DAY;

export function stage2(): void {
  describe('Stage 2 · step 8 initial contact, step 9 qualification, steps 10-11 temperature and score', () => {
    it('step 8: the owner makes first contact next morning; the lead becomes "contacted" and the first-response time is recorded', async () => {
      goto('2026-10-27', '10:30');
      S.f0 = JSON.stringify(await funnel());
      failure(await env.as('accounts').post(`${API}/leads/${S.leadId}/contacts`).send({ channel: 'call', outcome: 'connected_interested' }), 403);
      const next = iso(new Date(env.now().getTime() + DAY + HOUR));
      const res = await env.as('distributor_user').post(`${API}/leads/${S.leadId}/contacts`).send({
        channel: 'call', outcome: 'connected_interested', notes: 'Wants 3 kW for the bungalow, bill is about Rs 4,200 a month', duration_min: 12, next_action: 'Qualification call', next_followup_at: next,
      });
      const out = data<{ contact: { id: string }; lead: LeadListItem }>(res, 201);
      expect(out.lead).toMatchObject({ status: 'contacted', next_action: 'Qualification call', next_followup_at: next });
      const l = await lead(S.leadId);
      expect(l.first_contacted_at).toBe(iso(env.now()));
      expect(await env.db.table('contact_logs').count({ lead_id: S.leadId })).toBe(1);
      covers('8', 'outbound call logged by the owner: first_contacted_at, last_action, next action/date, status contacted; accounts gets 403', 'distributor_user');
      covers('L/Contacted', 'Accepted → Contacted on a connected outcome (step 8)', 'distributor_user');
    });

    it('steps 9-11 · HOT: a 30-day timeline gives HOT and the Appendix-A score; the lead becomes "qualified"; the funnel gate moves', async () => {
      const res = await qualify('distributor_user', S.leadId, {
        requirement_text: '3 kW rooftop system for my bungalow in Satellite before next summer.', timeline_bucket: 'within_30_days', decision_maker: 'self', decision_maker_access: true,
        budget_inr: 220000, capacity_kw: 3, segment: 'pmsg_residential', customer_type: 'residential', bill_captured: false,
        next_action: 'Site visit and bill collection', next_followup_at: iso(new Date(env.now().getTime() + 2 * DAY)),
      });
      const q = data<{ lead: LeadListItem; qualified: boolean; score: number; temperature: string; gaps: string[] }>(res);
      expect(q).toMatchObject({ qualified: true, temperature: 'hot', gaps: [] });
      expect(q.score).toBe(85); // requirement 20 + size(3 kW) 7.5 + timeline 22.5 + budget 15 + decision maker 10 + consent 10 + bill 0
      expect(q.lead).toMatchObject({ status: 'qualified', temperature: 'hot', quality_score: 85 });
      const view = data<{ components: { key: string; points: number }[] }>(await env.as('distributor_user').get(`${API}/leads/${S.leadId}/score`));
      expect(Object.fromEntries(view.components.map((c) => [c.key, c.points]))).toMatchObject({ requirement_clarity: 20, mw_size: 7.5, timeline: 22.5, budget: 15, decision_maker: 10, consent_present: 10, bill_captured: 0 });
      covers('9', 'qualification call stores requirement, timeline, budget, decision maker; no gaps → status qualified', 'distributor_user');
      covers('3/HOT', 'within_30_days → HOT', 'distributor_user');
      covers('10', 'temperature derived from the timeline bucket (hot/warm/cold) with deadline uplift', 'system');
      covers('11', 'score 85 = requirement 20 + size 7.5 + timeline 22.5 + budget 15 + decision maker 10 + consent 10 + bill 0, components stored in lead_scores', 'system');
      covers('L/Qualified', 'Contacted → Qualified when steps 9 and 11 are complete', 'distributor_user');
      const f1 = await funnel();
      const f0 = JSON.parse(S.f0) as Record<string, number>;
      expect(f1.qualified_lead).toBe(f0.qualified_lead! + 1);
    });

    it('3/COLD · 3/WARM · 3/UP: COLD and WARM follow the timeline; a PMSG lead is raised one level because the 30-Nov claim deadline is within 60 days, a net-metered one is not (31-Dec is 65 days away)', async () => {
      // COLD: captive C&I, 6+ months, no compliance deadline rule applies
      const cold = await captureOk('website', person('Vraj Packaging Works', '9825071111', { source_ref: 'w-cold' }));
      await acceptAs('distributor_user', cold);
      const c = data<{ temperature: string; lead: LeadListItem; deadline_uplift: boolean }>(await qualify('distributor_user', cold, { requirement_text: 'Factory roof solar, not before next financial year', timeline_bucket: 'six_months_plus', decision_maker: 'committee', capacity_kw: 90 }));
      expect(c).toMatchObject({ temperature: 'cold', deadline_uplift: false });
      expect(daysAhead(c.lead.next_followup_at)).toBeGreaterThan(6); // sla.followup_days.cold = 7
      expect(daysAhead(c.lead.next_followup_at)).toBeLessThan(8.5);
      S.coldLeadId = cold;
      covers('3/COLD', 'six_months_plus on a captive C&I lead → COLD, follow-up SLA 7 days, no uplift', 'distributor_user');

      // WARM: net-metered C&I, 1-3 months; exemption deadline 31-Dec-2026 is 65 days away (> 60) so no uplift
      const warm = await captureOk('website', person('Shah Engineering Works', '9825072222', { segment: 'ci_net_metered', capacity_kw: 60, source_ref: 'w-warm' }));
      await acceptAs('distributor_user', warm);
      const w = data<{ temperature: string; lead: LeadListItem; deadline_uplift: boolean }>(await qualify('distributor_user', warm, { requirement_text: 'Net metered rooftop 60 kW for the press shop', timeline_bucket: 'one_to_three_months', decision_maker: 'self', capacity_kw: 60 }));
      expect(w).toMatchObject({ temperature: 'warm', deadline_uplift: false });
      expect(daysAhead(w.lead.next_followup_at)).toBeGreaterThan(2); // sla.followup_days.warm = 3
      expect(daysAhead(w.lead.next_followup_at)).toBeLessThan(4.5);
      S.warmLeadId = warm;
      covers('3/WARM', 'one_to_three_months on a net-metered lead → WARM, follow-up SLA 3 days, no uplift while the exemption date is more than 60 days away', 'distributor_user');

      // UP: PMSG, 1-3 months → WARM raised to HOT (legacy claim deadline 30-Nov-2026 is 34 days away)
      const up = data<{ temperature: string; deadline_uplift: boolean; lead: LeadListItem }>(await qualify('distributor_user', S.routedLeadId, { requirement_text: 'Rooftop solar for my home in Navrangpura', timeline_bucket: 'one_to_three_months', decision_maker: 'family', capacity_kw: 3 }));
      expect(up).toMatchObject({ temperature: 'hot', deadline_uplift: true });
      expect(daysAhead(up.lead.next_followup_at)).toBeLessThan(1.6); // raised to HOT → sla.followup_days.hot = 1
      expect((await lead(S.routedLeadId)).deadline_uplift).toBe(true);
      const scoreView = data<{ deadline_uplift: boolean; temperature: string }>(await env.as('distributor_user').get(`${API}/leads/${S.routedLeadId}/score`));
      expect(scoreView).toMatchObject({ temperature: 'hot', deadline_uplift: true });
      covers('3/UP', 'PMSG lead with a 1-3 month timeline raised WARM → HOT (deadline_uplift true) by pmsg.claim_deadline.legacy_cohort within 60 days; not raised for the 65-day net-metered exemption date', 'distributor_user');
    });
  });

  describe('Stage 2 · step 12 follow-up engine, MF mandatory fields, step 13 reminders, D1 next action completed on time?', () => {
    it('MF: last action, next action, next follow-up date and owner can be edited but never emptied', async () => {
      const before = await lead(S.leadId);
      const blank = failure(await env.as('distributor_user').patch(`${API}/leads/${S.leadId}`).send({ next_action: '' }), 422, 'VALIDATION_ERROR');
      expect(JSON.stringify(blank.details)).toContain('next_action');
      failure(await env.as('distributor_user').patch(`${API}/leads/${S.leadId}`).send({ next_action: null }), 422, 'VALIDATION_ERROR');
      failure(await env.as('distributor_user').patch(`${API}/leads/${S.leadId}`).send({ next_followup_at: null }), 422, 'VALIDATION_ERROR');
      failure(await env.as('distributor_user').patch(`${API}/leads/${S.leadId}`).send({ owner_id: null }), 422, 'VALIDATION_ERROR');
      failure(await env.as('distributor_user').patch(`${API}/leads/${S.leadId}`).send({ last_action: '' }), 422, 'VALIDATION_ERROR');
      const after = await lead(S.leadId);
      expect([after.next_action, after.next_followup_at, after.owner_id, after.last_action]).toEqual([before.next_action, before.next_followup_at, before.owner_id, before.last_action]);
      const ok = await env.as('distributor_user').patch(`${API}/leads/${S.leadId}`).send({ next_action: 'Site visit, bill collection and roof check' });
      expect(data<LeadListItem>(ok).next_action).toBe('Site visit, bill collection and roof check');
      covers('3/MF', 'blanking next_action / next_followup_at / owner_id / last_action → 422 VALIDATION_ERROR and the lead is unchanged; a real edit is saved', 'distributor_user');
      covers('12', 'mandatory fields enforced on every save; follow-up due dates derive from sla.followup_days by temperature (hot 1, warm 3, cold 7 days)', 'system');
    });

    it('D1 YES: completing a follow-up on time needs the NEXT action and date and keeps the clock un-breached', async () => {
      const mine = await env.as('distributor_user').get(`${API}/followups?scope=mine&bucket=all`);
      const open = (mine.body.data as Followup[]).filter((f) => f.lead_id === S.leadId && f.status === 'open');
      expect(open.length).toBeGreaterThan(0);
      const f = open[0]!;
      failure(await env.as('distributor_user').post(`${API}/followups/${f.id}/complete`).send({ outcome: 'Spoke to customer' }), 422, 'VALIDATION_ERROR');
      env.advance(DAY);
      const nextAt = iso(new Date(env.now().getTime() + 2 * DAY));
      const done = data<{ followup: { status: string }; lead: LeadListItem }>(await env.as('distributor_user').post(`${API}/followups/${f.id}/complete`).send({ outcome: 'Customer confirmed Friday for the site visit', next_action: 'Site survey', next_followup_at: nextAt }));
      expect(done.followup.status).toBe('done');
      expect(done.lead).toMatchObject({ next_action: 'Site survey', next_followup_at: nextAt });
      expect((await env.db.table('clocks').all({ entity_id: f.id })).every((c) => c.status !== 'breached')).toBe(true);
      covers('3/D1/yes', 'follow-up completed before it is due → done, next follow-up planned, clock not breached', 'distributor_user');
    });

    it('step 13 · D1 NO · T2 · clock states: an overdue follow-up warns at 70 %, is missed at 100 %, then climbs DSM → Sales Manager → Management and stays breached', async () => {
      const w = S.warmLeadId;
      const owner = (await lead(w)).owner_id!;
      const fu = data<{ followup: Followup }>(await env.as('distributor_user').post(`${API}/leads/${w}/followups`).send({ kind: 'call', due_at: iso(new Date(env.now().getTime() + 3 * HOUR)), note: 'Call Shah about the electricity bill and roof access' }), 201).followup;
      const clock0 = await clockOf(w, 'followup');
      expect(clock0).toMatchObject({ status: 'running', escalated_level: 0, owner_id: owner });

      env.advance(2 * HOUR + 20 * MINUTE); // 70 % of 3 h
      await env.tick();
      const warned = await clockOf(w, 'followup');
      expect(warned.warned_at).toBeTruthy();
      expect(warned.status).toBe('running');
      expect((await notificationsOf(owner, 'followup.reminder')).length).toBeGreaterThan(0);
      covers('13', 'auto reminder: follow-up clock warned at 70 % → followup.reminder notification to the owner; breach/escalation notifications follow', 'system');

      env.advance(50 * MINUTE); // past due
      await env.tick();
      let c = await clockOf(w, 'followup');
      expect(c).toMatchObject({ status: 'breached', escalated_level: 1 });
      expect((await env.db.table('followups').getOrThrow(fu.id)).status).toBe('missed');
      expect((await notificationsOf(D.profile.dsm, 'followup.missed')).length + (await notificationsOf(D.profile.dsm, 'clock.followup.breach')).length).toBeGreaterThan(0);
      covers('3/D1/no', 'next action not completed on time → follow-up status missed, clock breached, DSM notified (followup.missed / clock.followup.breach)', 'system');
      covers('10/T2', 'overdue follow-up: owner → DSM (level 1) → Sales Manager (level 2) → Management (level 3)', 'system');

      env.advance(4 * HOUR + MINUTE);
      await env.tick();
      c = await clockOf(w, 'followup');
      expect(c.escalated_level).toBe(2);
      expect((await notificationsOf(D.profile.sales_manager, 'clock.followup.level2')).length).toBeGreaterThan(0);
      covers('K/Escalated2', 'follow-up clock: DSM → Sales Manager at the next escalation step (level 2)', 'system');

      env.advance(4 * HOUR + MINUTE);
      await env.tick();
      c = await clockOf(w, 'followup');
      expect(c).toMatchObject({ status: 'breached', escalated_level: 3 });
      expect((await notificationsOf(D.profile.management, 'clock.followup.level3')).length).toBeGreaterThan(0);
      covers('K/Escalated3', 'follow-up clock: Sales Manager → Management at level 3', 'system');

      env.advance(10 * HOUR);
      const breachedId = (await clockOf(w, 'followup')).id;
      const l3Before = (await notificationsOf(D.profile.management, 'clock.followup.level3')).length;
      await env.tick();
      expect((await clockOf(w, 'followup')).escalated_level).toBe(3);
      expect((await notificationsOf(D.profile.management, 'clock.followup.level3')).length).toBe(l3Before);
      // a late completion stops the escalation but the breach stays on record (KPI "follow-up compliance")
      const late = data<{ followup: { status: string } }>(await env.as('distributor_user').post(`${API}/followups/${fu.id}/complete`).send({ outcome: 'Reached the customer late', next_action: 'Share the survey slot', next_followup_at: iso(new Date(env.now().getTime() + DAY)) }));
      expect(late.followup.status).toBe('done');
      const kept = await env.db.table('clocks').getOrThrow(breachedId);
      expect(kept).toMatchObject({ status: 'breached', escalated_level: 3 });
      expect(kept.resolved_at).toBeTruthy();
      covers('K/Breached', 'after level 3 the breach is logged permanently: status stays breached, no further escalation, resolved_at set on late completion', 'system');
    });
  });

  describe('Stage 2 · channel rules CH: WhatsApp window vs template, SMS DLT, call, 90-day opt-out bar (diagram sections 3 and 9)', () => {
    it('3/CH/wa-window: outside the 24 h window a free-text WhatsApp is refused; 3/CH/wa-template: an approved template with consent goes out and its category is recorded', async () => {
      goto('2026-10-28', '10:30');
      const free = failure(await env.as('distributor_user').post(`${API}/leads/${S.leadId}/messages`).send({ channel: 'whatsapp', purpose: 'service', body: 'Namaste {{name}}, your survey is tomorrow' }), 422, 'CONSENT_BLOCKED');
      expect(JSON.stringify(free.details)).toContain('WHATSAPP_WINDOW_CLOSED');
      covers('3/CH/wa-window', 'WhatsApp free text with consent but no inbound message in 24 h → WHATSAPP_WINDOW_CLOSED', 'distributor_user');

      const tpl = data<{ status: string; template_category: string }>(await env.as('distributor_user').post(`${API}/leads/${S.leadId}/messages`).send({ channel: 'whatsapp', purpose: 'service', template_key: 'wa.followup_reminder', vars: { '1': 'Mukesh', '2': 'FS-ENQ-1', '3': 'Your advisor' } }), 201);
      expect(tpl).toMatchObject({ status: 'sent', template_category: 'utility' });
      const row = (await env.db.table('message_log').all({ lead_id: S.leadId, status: 'sent' })).find((m) => m.template_key === 'wa.followup_reminder')!;
      expect(row).toMatchObject({ channel: 'whatsapp', category: 'utility', direction: 'outbound' });
      expect(row.consent_id).toBeTruthy();
      expect(row.provider).toContain('whatsapp');
      covers('3/CH/wa-template', 'approved template wa.followup_reminder sent with consent id, provider and category utility in message_log', 'distributor_user');
      covers('9/W4', 'template send: category tag recorded for cost, consent id on the log row', 'distributor_user');

      // inbound customer message opens the window: free text now allowed
      await env.anon().post(`${API}/webhooks/whatsapp?key=${KEYS.whatsapp}`).send({ from: '919825012345', body: 'Please come on Friday morning' });
      const fresh = data<{ status: string }>(await env.as('distributor_user').post(`${API}/leads/${S.leadId}/messages`).send({ channel: 'whatsapp', purpose: 'service', body: 'Namaste {{name}}, Friday 10 am works.' }), 201);
      expect(fresh.status).toBe('sent');
      expect((await env.db.table('message_log').all({ lead_id: S.leadId, direction: 'inbound' })).length).toBe(1);
      env.advance(25 * HOUR);
      failure(await env.as('distributor_user').post(`${API}/leads/${S.leadId}/messages`).send({ channel: 'whatsapp', purpose: 'service', body: 'Namaste again' }), 422, 'CONSENT_BLOCKED');
      env.advance(-25 * HOUR);
    });

    it('3/CH/sms + 9/SM: SMS needs a DLT-registered template (id and header); 3/CH/call + 9/CL: a call is logged on the call channel', async () => {
      const noTpl = failure(await env.as('distributor_user').post(`${API}/leads/${S.leadId}/messages`).send({ channel: 'sms', purpose: 'service', body: 'Hello from Future Solar' }), 422, 'CONSENT_BLOCKED');
      expect(JSON.stringify(noTpl.details)).toContain('NO_TEMPLATE');
      const sms = data<{ status: string; template_category: string }>(await env.as('distributor_user').post(`${API}/leads/${S.leadId}/messages`).send({ channel: 'sms', purpose: 'service', template_key: 'sms.followup_reminder', vars: {} }), 201);
      expect(sms.status).toBe('sent');
      const smsRow = (await env.db.table('message_log').all({ lead_id: S.leadId, channel: 'sms' })).find((m) => m.status === 'sent')!;
      expect(smsRow.template_key).toBe('sms.followup_reminder');
      const tpl = (await env.db.table('message_templates').all({ key: 'sms.followup_reminder', language: 'en' }))[0]!;
      expect(tpl.dlt_template_id && tpl.dlt_header).toBeTruthy();
      covers('3/CH/sms', 'free-text SMS refused (NO_TEMPLATE: DLT id + header mandatory); DLT-registered template sent', 'distributor_user');
      covers('9/SM', 'SMS sent through a template that carries dlt_template_id and dlt_header', 'distributor_user');

      const call = data<{ status: string }>(await env.as('distributor_user').post(`${API}/leads/${S.leadId}/messages`).send({ channel: 'call', purpose: 'service', body: 'Courtesy call about the survey slot' }), 201);
      expect(call.status).toBe('sent');
      expect((await env.db.table('message_log').all({ lead_id: S.leadId, channel: 'call' }))[0]).toMatchObject({ provider: 'call-log' });
      const scrub = data<{ status: string }>(await env.as('distributor_user').post(`${API}/leads/${S.leadId}/dnd-scrub`).send({}));
      expect(scrub.status).toBe('clear');
      covers('3/CH/call', 'call logged only (provider call-log) after a fresh DND scrub (dnd-scrub endpoint)', 'distributor_user');
      covers('9/CL', 'call channel writes a message_log row with provider call-log', 'distributor_user');
    });

    it('3/CH/optout-bar + 9/OPT: STOP on WhatsApp withdraws every consent, sets the 90-day bar, propagates to the distributor and both dealers, and a new consent does not lift it', async () => {
      const ids = [S.z0, S.z1, S.z3];
      const inbound = data<{ optouts: number }>(await env.anon().post(`${API}/webhooks/whatsapp?key=${KEYS.whatsapp}`).send({ from: '919825066666', body: 'STOP' }));
      expect(inbound.optouts).toBe(1);
      const until = new Date(env.now().getTime() + 90 * DAY).toISOString().slice(0, 10);
      for (const id of ids) {
        const consents = await env.db.table('lead_consents').all({ lead_id: id });
        expect(consents.every((c) => c.withdrawn_at !== null)).toBe(true);
        expect(consents.every((c) => (c.optout_suppress_until ?? '').slice(0, 10) === until)).toBe(true);
      }
      const events = await eventsOf(S.z0);
      expect(events).toEqual(expect.arrayContaining(['consent_withdrawn']));
      expect((await notificationsOf(D.profile.distributor_user, 'consent.withdrawn')).length).toBeGreaterThan(0);
      expect((await notificationsOf(D.profile.dealer_user_2, 'consent.withdrawn')).length).toBeGreaterThan(0);
      expect((await notificationsOf(D.profile.dealer_user_3, 'consent.withdrawn')).length).toBeGreaterThan(0);
      expect((await env.db.table('audit_log').all({ action: 'consent.withdraw' })).length).toBeGreaterThan(0);

      const promo = failure(await env.as('distributor_user').post(`${API}/leads/${S.z0}/messages`).send({ channel: 'whatsapp', purpose: 'promotional', body: 'Last chance offer' }), 422, 'CONSENT_BLOCKED');
      expect(JSON.stringify(promo.details)).toMatch(/WITHDRAWN|SUPPRESSED_90_DAY/);
      const re = data<{ summary: { suppressed: boolean; suppress_until: string | null } }>(await env.as('distributor_user').post(`${API}/leads/${S.z0}/consents`).send({ notice_version: 'default-v1', purposes: ['promotional'], channels: ['whatsapp'], proof_ref: 'call-recording-4412' }), 201);
      expect(re.summary.suppressed).toBe(true);
      failure(await env.as('distributor_user').post(`${API}/leads/${S.z0}/messages`).send({ channel: 'whatsapp', purpose: 'promotional', body: 'Another offer' }), 422, 'CONSENT_BLOCKED');
      covers('3/CH/optout-bar', 'after STOP promotional WhatsApp is blocked (WITHDRAWN/SUPPRESSED_90_DAY) even after a fresh consent row is recorded', 'system');
      covers('9/OPT', 'STOP keyword: all consents withdrawn, optout_suppress_until = now + 90 days on every lead of the number, distributor and both dealers notified (consent.withdrawn), audit + lead events written', 'system');
    });
  });
}
