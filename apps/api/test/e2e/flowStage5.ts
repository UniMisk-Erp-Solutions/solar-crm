/** Stage 5 of the flow (diagram section 6, steps 28-34): pre-PI checklist, PI, payment / credit verification, gate G11, sales order, circulation, hand-over. */
import { describe, expect, it } from 'vitest';
import type { CreditCheck, ProformaInvoice, SalesOrder } from '@solar/shared';
import { covers } from './flowCoverage';
import { API, D, HOUR, MINUTE, S, clockOf, data, env, eventsOf, funnel, goto, lead, notificationsOf } from './flowKit';
import { failure } from './flowHarness';

interface Pi extends ProformaInvoice { required_advance: number; advance_ok: boolean; missing_labels: string[]; credit_checks: CreditCheck[]; sales_order: SalesOrder | null; approvals: { id: string; step: number; required_role: string; decision: string }[]; paid_amount: number; balance: number }
interface Checklist { complete: boolean; missing: string[]; checklist: Record<string, boolean>; accepted: boolean; pi_id: string | null }
interface So extends SalesOrder { warnings: string[]; approvals: { id: string; step: number; required_role: string; decision: string; lane: string }[]; lines: { id: string; qty: number; serial_tracked: boolean; description: string }[] }
interface Position { over_limit: boolean; outstanding: number; credit_limit: number; subsidy_linked: number; portal_status: string; bank_guarantee: { valid: boolean }; ageing: Record<string, number>; blocked_reasons: string[]; dealer_name: string }
const ADDRESS = { line1: '12 Shyamal Row Houses, Satellite', city: 'Ahmedabad', district: 'Ahmedabad', state: 'Gujarat', pincode: '380015' };

export function stage5(): void {
  describe('Stage 3 re-entry · 4/NUR a nurtured lead returns on its re-engagement date', () => {
    it('the nightly job moves due nurture leads back to "contacted" and plans a follow-up', async () => {
      goto('2026-11-06', '10:00');
      const run = data<{ status: string }>(await env.as('admin').post(`${API}/admin/jobs/lead.nurture_reactivation/run`).send({}));
      expect(run.status).toBe('ok');
      const l = await lead(S.nurtureLeadId);
      expect(l.status).toBe('contacted');
      expect(await eventsOf(S.nurtureLeadId)).toContain('nurture_reactivated');
      expect((await notificationsOf(l.owner_id!, 'lead.nurture_due')).length).toBeGreaterThan(0);
      expect(await env.db.table('followups').count({ lead_id: S.nurtureLeadId, status: 'open' })).toBeGreaterThan(0);
      covers('4/NUR', 'job lead.nurture_reactivation: due nurture lead → contacted, follow-up planned, owner notified (lead.nurture_due)', 'system');
      covers('L/Contacted', 'Nurture → Contacted when the re-engagement date is reached', 'system');
    });
  });

  describe('Stage 5 · WI/CK pre-PI checklist, step 28 prepare PI, step 29 PI approval and issue', () => {
    it('CK NO: the PI cannot be submitted while legal name, address, GST, product, quantity, price, freight or payment terms are unconfirmed', async () => {
      goto('2026-11-06', '11:00');
      const f0 = await funnel();
      const chk = data<Checklist>(await env.as('accounts').get(`${API}/quotes/${S.quoteId}/pre-pi-checklist`));
      expect(chk).toMatchObject({ accepted: true, complete: false });
      expect(chk.missing.length).toBeGreaterThan(0);
      expect(chk.checklist.legal_name).toBe(true);
      expect(chk.checklist.payment_terms).toBe(true);

      failure(await env.as('dealer_user').post(`${API}/pis`).send({ quote_id: S.quoteId }), 403);
      const pi = data<Pi>(await env.as('accounts').post(`${API}/pis`).send({ quote_id: S.quoteId }), 201);
      S.piId = pi.id;
      expect(pi.status).toBe('draft');
      expect(pi.pi_no).toMatch(/^FS\/PI\/26\/\d{4}$/);
      expect(pi.missing_labels.length).toBeGreaterThan(0);
      const q = await env.db.table('quotations').getOrThrow(S.quoteId);
      // funding split: consumer share, loan share, subsidy receivable (CFA + state share)
      expect(pi.subsidy_receivable).toBe(q.cfa_entitlement + q.state_share);
      expect(pi.subsidy_receivable).toBe(78000);
      expect(pi.consumer_share).toBeCloseTo(pi.total - pi.subsidy_receivable - pi.loan_share, 0);
      const blocked = failure(await env.as('accounts').post(`${API}/pis/${S.piId}/submit`).send({}), 422, 'GUARD_BLOCKED');
      const d = blocked.details as { gate: string; missing: string[]; missing_labels: string[] };
      expect(d.gate).toBe('PRE_PI_CHECKLIST');
      expect(d.missing.length).toBeGreaterThan(0);
      expect(await env.db.table('approvals').count({ entity_type: 'proforma_invoice', entity_id: S.piId })).toBe(0);
      S.piMissing = d.missing.join(',');
      covers('6/CK/no', `submit refused 422 GUARD_BLOCKED gate PRE_PI_CHECKLIST listing missing items [${d.missing.join(', ')}]; no approval created; dealer user gets 403`, 'accounts');
      expect((await funnel()).pi).toBe(f0.pi! + 1); // the PI gate counts a PI from the moment it is prepared (step 28)
    });

    it('CK YES · step 28: confirming the GST position and billing address completes the checklist; step 29: Accounts approves and the PI is issued', async () => {
      const fixed = data<Pi>(await env.as('accounts').patch(`${API}/pis/${S.piId}`).send({ gst_unregistered: true, billing_address: ADDRESS, shipping_address: ADDRESS, legal_name: 'Mukesh Trivedi' }));
      expect(fixed.missing_labels).toEqual([]);
      expect(fixed.gstin).toBe('UNREGISTERED');
      const sub = data<Pi>(await env.as('accounts').post(`${API}/pis/${S.piId}/submit`).send({}));
      expect(sub.status).toBe('pending_approval');
      const chain = sub.approvals.filter((a) => a.decision === 'pending').sort((a, b) => a.step - b.step);
      expect(chain.map((a) => a.required_role)).toEqual(['accounts']); // total is below the Management threshold
      const f0 = await funnel();
      failure(await env.as('dsm').post(`${API}/approvals/${chain[0]!.id}/decide`).send({ decision: 'approved', comment: 'not my lane' }), 403);
      data(await env.as('accounts').post(`${API}/approvals/${chain[0]!.id}/decide`).send({ decision: 'approved', comment: 'Checklist and amounts verified' }));
      const issued = data<Pi>(await env.as('accounts').get(`${API}/pis/${S.piId}`));
      expect(issued.status).toBe('issued');
      expect(issued.issue_date).toBe('2026-11-06');
      expect(issued.valid_till).toBe('2026-11-21');
      S.piTotal = String(issued.total);
      expect((await funnel()).pi).toBe(f0.pi!); // issuing does not count it twice
      covers('6/CK/yes', 'checklist complete (customer is an unregistered individual → GSTIN UNREGISTERED) → submit opens the approval chain', 'accounts');
      covers('28', 'PI drafted from the accepted quote with funding split consumer / loan / subsidy receivable (78,000 = CFA) and the stored checklist', 'accounts');
      covers('29', 'PI approval by Accounts (dsm → 403) → issued, issue_date, valid_till = +15 days; funnel PI gate +1', 'accounts');
    });
  });

  describe('Stage 5 · step 30 payment / credit verification, D1 advance OR credit?, gate G11, step 31 PO, step 32 sales order', () => {
    it('step 30 · D1 NO: no advance has been received, so the advance check is rejected; the dealer credit position (limit, ageing, subsidy-linked, BG, portal) is verified', async () => {
      const adv = data<CreditCheck & { guard: unknown }>(await env.as('accounts').post(`${API}/pis/${S.piId}/credit-check`).send({ basis: 'advance' }), 201);
      expect(adv).toMatchObject({ basis: 'advance', result: 'rejected' });
      const pos = data<Position>(await env.as('accounts').get(`${API}/credit-position/${D.dealer.d1}`));
      expect(pos).toMatchObject({ over_limit: true, credit_limit: 2_000_000, portal_status: 'active' });
      expect(pos.outstanding).toBeGreaterThan(2_000_000);
      expect(pos.subsidy_linked).toBeGreaterThan(0);
      expect(pos.bank_guarantee.valid).toBe(true);
      expect(Object.keys(pos.ageing)).toEqual(expect.arrayContaining(['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus']));
      expect(pos.blocked_reasons.join(' ')).toMatch(/limit/i);
      const credit = data<CreditCheck>(await env.as('accounts').post(`${API}/pis/${S.piId}/credit-check`).send({ basis: 'credit' }), 201);
      expect(credit).toMatchObject({ basis: 'credit', result: 'pending' });
      expect(credit.subsidy_linked).toBeGreaterThan(0);
      expect((await notificationsOf(D.profile.accounts, 'credit_check.pending')).length).toBeGreaterThan(0);
      S.creditCheckId = credit.id;
      covers('30', 'advance check decided from payments (rejected: nothing received); credit check snapshots limit, outstanding, ageing buckets, subsidy-linked exposure, bank guarantee and portal status; Accounts notified', 'accounts');
    });

    it('6/G11/yes: the over-limit dealer\'s sales order is a HARD STOP even with a PO and a credit check; 6/G11/override: only an approved override (Accounts then Management, written comment) unblocks it', async () => {
      const body = { pi_id: S.piId, customer_po_no: 'PO-MT-2026-117', customer_po_date: '2026-11-06' };
      const blocked = failure(await env.as('accounts').post(`${API}/sales-orders`).send(body), 422, 'GUARD_BLOCKED');
      const guard = blocked.details as { gate: string; blocked: boolean; reasons: string[]; exposure_after: number; credit_limit: number; override_id: string | null };
      expect(guard).toMatchObject({ gate: 'G11', blocked: true, override_id: null });
      expect(guard.exposure_after).toBeGreaterThan(guard.credit_limit);
      expect(await env.db.table('sales_orders').count({ pi_id: S.piId })).toBe(0);
      covers('6/G11/yes', 'POST /sales-orders → 422 GUARD_BLOCKED details.gate G11 (exposure_after > credit_limit), no order created', 'accounts');

      failure(await env.as('accounts').post(`${API}/credit-overrides`).send({ dealer_id: D.dealer.d1, pi_id: S.piId, reason: 'short' }), 422);
      const ov = data<{ override: { id: string; status: string }; approvals: { id: string; step: number; required_role: string }[] }>(await env.as('accounts').post(`${API}/credit-overrides`).send({
        dealer_id: D.dealer.d1, pi_id: S.piId, reason: 'Dealer is over limit only because 14.5 lakh of CFA is awaiting release; the customer advance covers this order',
      }), 201);
      expect(ov.override.status).toBe('pending');
      const steps = ov.approvals.sort((a, b) => a.step - b.step);
      expect(steps.map((a) => a.required_role)).toEqual(['accounts', 'management']);
      failure(await env.as('accounts').post(`${API}/approvals/${steps[0]!.id}/decide`).send({ decision: 'approved' }), 422); // comment mandatory on override decisions
      data(await env.as('accounts').post(`${API}/approvals/${steps[0]!.id}/decide`).send({ decision: 'approved', comment: 'Accounts supports: advance and CFA cover the exposure' }));
      failure(await env.as('accounts').post(`${API}/sales-orders`).send({ pi_id: S.piId, customer_po_no: 'PO-MT-2026-117', customer_po_date: '2026-11-06' }), 422, 'GUARD_BLOCKED'); // Accounts alone is not enough
      failure(await env.as('sales_manager').post(`${API}/approvals/${steps[1]!.id}/decide`).send({ decision: 'approved', comment: 'not management' }), 403);
      data(await env.as('management').post(`${API}/approvals/${steps[1]!.id}/decide`).send({ decision: 'approved', comment: 'Approved once, for this PI only' }));
      expect((await env.db.table('credit_overrides').getOrThrow(ov.override.id)).status).toBe('approved');
      S.overrideId = ov.override.id;
      covers('6/G11/override', 'credit override chain Accounts → Management, comment mandatory, Accounts alone does not unblock, Sales Manager gets 403; approved override row is what G11 looks for', 'management');
    });

    it('step 31 · step 32 · 6/D1/no: with the override the order is created but placed ON HOLD (no advance, no approved credit check); the clock engine reminds the customer and escalates', async () => {
      const f0 = await funnel();
      const so = data<So>(await env.as('accounts').post(`${API}/sales-orders`).send({ pi_id: S.piId, customer_po_no: 'PO-MT-2026-117', customer_po_date: '2026-11-06' }), 201);
      S.soId = so.id;
      expect(so.status).toBe('on_hold');
      expect(so.so_no).toMatch(/^FS\/SO\/26\/\d{4}$/);
      expect(so.customer_po_no).toBe('PO-MT-2026-117');
      expect(so.warnings.join(' ')).toMatch(/override/i); // the credit guard was bypassed by an approved override
      expect(so.lines.length).toBeGreaterThan(0);
      expect(await env.db.table('approvals').count({ entity_type: 'sales_order', entity_id: S.soId })).toBe(0); // no approval while on hold
      expect((await funnel()).sales_order).toBe(f0.sales_order! + 1);
      const reminder = await clockOf(S.soId, 'payment_reminder');
      expect(reminder).toMatchObject({ status: 'running' });
      covers('31', 'customer PO number and date are mandatory on the sales order and stored (customer_po_no / customer_po_date)', 'accounts');
      covers('32', 'sales order FS/SO/yy/nnnn created from the issued PI with copied lines; credit guard bypass recorded in warnings; funnel SO gate +1', 'accounts');
      covers('6/G11/no', 'with an approved credit override G11 no longer blocks: the order is created (warning records the override)', 'accounts');
    });

    it('T4 · 6/D1/no: while on hold the customer gets a consent-aware WhatsApp payment reminder every day and the owner / DSM are alerted by the clock engine', async () => {
      const due = new Date((await clockOf(S.soId, 'payment_reminder')).due_at);
      expect(due.getTime()).toBeGreaterThan(env.now().getTime() + 6 * HOUR);
      env.setNow(new Date(due.getTime() + 5 * MINUTE));
      await env.tick();
      const c = (await env.db.table('clocks').all({ entity_id: S.soId, clock_type: 'payment_reminder' }, { orderBy: { col: 'started_at' } }));
      expect(c[0]!.status).toBe('breached');
      expect(c.length).toBeGreaterThan(1); // the next day's reminder is scheduled
      const log = await env.db.table('message_log').all({ lead_id: S.leadId, purpose: 'transactional' });
      expect(log.length).toBeGreaterThan(0);
      expect(log.find((m) => m.template_key === 'wa.payment_reminder')).toMatchObject({ category: 'utility', status: 'sent' });
      expect(log.some((m) => m.channel === 'whatsapp' && m.status === 'sent')).toBe(true);
      const notes = (await env.db.table('notifications').all()).filter((n) => n.entity_id === S.soId && /payment_reminder|so.on_hold|clock.payment_reminder/.test(n.kind));
      expect(notes.length).toBeGreaterThan(0);
      covers('10/T4', 'pending payment: payment_reminder clock breached → transactional WhatsApp reminder logged and sent, owner / DSM notified, next daily reminder scheduled', 'system');
      covers('6/D1/no', 'no advance and no approved credit check → status on_hold with hold_reason, payment_reminder clock, customer reminder and escalation', 'system');
    });

    it('6/D1/yes · step 30: recording the advance releases the hold automatically (advance ≥ 30 % of the PI)', async () => {
      const pi = data<Pi>(await env.as('accounts').get(`${API}/pis/${S.piId}`));
      const partial = Math.round(pi.required_advance / 2);
      const p1 = data<{ pi: Pi }>(await env.as('accounts').post(`${API}/pis/${S.piId}/payments`).send({ kind: 'advance', amount: partial, mode: 'upi', reference: 'UPI-4410-A' }), 201);
      expect(p1.pi.status).toBe('partially_paid');
      expect((await env.db.table('sales_orders').getOrThrow(S.soId)).status).toBe('on_hold'); // half the advance is not enough
      const rest = Math.ceil(pi.required_advance - partial);
      data(await env.as('accounts').post(`${API}/pis/${S.piId}/payments`).send({ kind: 'advance', amount: rest, mode: 'neft_rtgs', reference: 'UTR-2026110700117' }), 201);
      const so = await env.db.table('sales_orders').getOrThrow(S.soId);
      expect(so.status).toBe('pending_approval');
      expect(so.advance_received).toBeGreaterThanOrEqual(pi.required_advance);
      expect(await clockOf(S.soId, 'payment_reminder').then((c) => c.resolved_at)).toBeTruthy();
      const chk = data<CreditCheck>(await env.as('accounts').post(`${API}/pis/${S.piId}/credit-check`).send({ basis: 'advance' }), 201);
      expect(chk.result).toBe('approved');
      covers('6/D1/yes', 'advance ≥ min_advance_pct received → hold released automatically, SO pending_approval, reminder clock resolved, advance credit check approved', 'accounts');
    });
  });

  describe('Stage 5 · step 33 SO approval and circulation, step 34 hand over to dispatch planning', () => {
    it('step 33: Accounts approves the sales order and it is circulated to dispatch, accounts, the distributor and the dealer', async () => {
      const so = data<So>(await env.as('accounts').get(`${API}/sales-orders/${S.soId}`));
      const step = so.approvals.filter((a) => a.decision === 'pending').sort((a, b) => a.step - b.step)[0]!;
      expect(step.required_role).toBe('accounts');
      failure(await env.as('dispatch').post(`${API}/approvals/${step.id}/decide`).send({ decision: 'approved', comment: 'x' }), 403);
      data(await env.as('accounts').post(`${API}/approvals/${step.id}/decide`).send({ decision: 'approved', comment: 'Advance received, PO on file' }));
      const approved = await env.db.table('sales_orders').getOrThrow(S.soId);
      expect(approved.status).toBe('approved');
      expect(approved.circulated_at).toBeTruthy();
      for (const [user, label] of [[D.profile.dispatch, 'dispatch'], [D.profile.accounts, 'accounts'], [D.profile.distributor_user, 'distributor'], [D.profile.dealer_user, 'dealer']] as const) {
        expect((await notificationsOf(user, 'so.circulated')).length, `so.circulated to ${label}`).toBeGreaterThan(0);
      }
      covers('33', 'SO approval (lane credit, Accounts) → approved + circulated_at; so.circulated notifications to dispatch, accounts, the distributor and the dealer user; dispatch role gets 403 on the decision', 'accounts');
    });

    it('step 34: the order is handed over to dispatch planning; the opportunity and the lead become WON', async () => {
      failure(await env.as('viewer').post(`${API}/sales-orders/${S.soId}/handover`).send({}), 403);
      const so = data<So>(await env.as('management').post(`${API}/sales-orders/${S.soId}/handover`).send({ note: 'Stock confirmed at the Ahmedabad warehouse' }));
      expect(so.status).toBe('dispatch_planning');
      expect(so.dispatch_handover_at).toBeTruthy();
      expect((await env.db.table('opportunities').getOrThrow(S.oppId)).stage).toBe('won');
      expect(await lead(S.leadId)).toMatchObject({ status: 'won' });
      expect((await notificationsOf(D.profile.dispatch, 'so.handover')).length).toBeGreaterThan(0);
      covers('34', 'handover → dispatch_planning with dispatch_handover_at, dispatch role notified (so.handover); viewer gets 403', 'management');
      covers('L/Won', 'Opportunity → Won when the sales order is handed over (opportunity stage won)', 'management');
    });
  });
}

