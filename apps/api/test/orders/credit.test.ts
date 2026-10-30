import { describe, expect, it } from 'vitest';
import { IDS } from '../helpers/env';
import { tickClocks } from '../../src/services/clockService';
import { decide, decideAll, fakes, issuePi, orderEnv, pay, seedWorld } from './fixtures';

const SO_BODY = (pi_id: string) => ({ pi_id, customer_po_no: 'PO-100', customer_po_date: '2026-10-25' });

async function addReceivable(env: ReturnType<typeof orderEnv>['env'], amount: number, opts: { due?: string; paid?: number; subsidy?: boolean } = {}) {
  await env.ctx('admin').db.table('dealer_receivables').insert({
    dealer_id: IDS.dealerA1, distributor_id: IDS.distributorA, doc_ref: `INV-${amount}`, amount, paid_amount: opts.paid ?? 0, invoice_date: '2026-09-01', due_date: opts.due ?? '2026-12-31',
    subsidy_linked: opts.subsidy ?? false, linked_project_id: null, status: 'open',
  });
}

describe('payment / credit verification (step 30)', () => {
  it('advance basis follows the rule order.min_advance_pct (default 30 %)', async () => {
    const { env } = orderEnv();
    const w = await seedWorld(env);
    const pi = await issuePi(env, w);
    const accounts = env.as('accounts');
    const none = await accounts.post(`/api/v1/pis/${pi.id}/credit-check`).send({ basis: 'advance' });
    expect(none.status).toBe(201);
    expect(none.body.data).toMatchObject({ basis: 'advance', result: 'rejected', required_advance: 150000, advance_received: 0 });
    await pay(env, pi.id, 149999);
    expect((await accounts.post(`/api/v1/pis/${pi.id}/credit-check`).send({ basis: 'advance' })).body.data.result).toBe('rejected');
    await pay(env, pi.id, 1);
    const ok = await accounts.post(`/api/v1/pis/${pi.id}/credit-check`).send({ basis: 'advance' });
    expect(ok.body.data).toMatchObject({ result: 'approved', advance_received: 150000, decided_at: expect.any(String) });
    // the percentage is a rule, not a constant
    await env.rule('order.min_advance_pct', 50);
    expect((await accounts.post(`/api/v1/pis/${pi.id}/credit-check`).send({ basis: 'advance' })).body.data).toMatchObject({ result: 'rejected', required_advance: 250000 });
  });

  it('credit basis snapshots the dealer exposure and waits for Accounts to decide', async () => {
    const { env } = orderEnv();
    const w = await seedWorld(env);
    await addReceivable(env, 100000, { due: '2026-12-31' });                    // current
    await addReceivable(env, 80000, { due: '2026-09-16', paid: 30000, subsidy: true }); // 40 days past due, subsidy linked, 50,000 open
    const pi = await issuePi(env, w);
    const accounts = env.as('accounts');
    const r = await accounts.post(`/api/v1/pis/${pi.id}/credit-check`).send({ basis: 'credit' });
    expect(r.status).toBe(201);
    const cc = r.body.data;
    expect(cc).toMatchObject({ basis: 'credit', result: 'pending', credit_limit: 1000000, outstanding: 150000, subsidy_linked: 50000, portal_status: 'active', decided_at: null });
    expect(cc.ageing).toMatchObject({ current: 100000, d31_60: 50000, d1_30: 0 });
    expect(cc.exposure_after).toBe(650000);
    // Accounts is told where to decide: the notification opens the invoice (a real web route), not a screen that does not exist
    const note = await env.db.table('notifications').one({ kind: 'credit_check.pending', entity_id: cc.id });
    expect(note?.link).toBe(`/invoices/${pi.id}`);
    expect(cc.guard).toMatchObject({ gate: 'G11', blocked: false });

    expect((await accounts.post(`/api/v1/pis/${pi.id}/credit-check`).send({ basis: 'credit' })).status).toBe(409);
    expect((await env.as('dispatch').post(`/api/v1/credit-checks/${cc.id}/decide`).send({ result: 'approved' })).status).toBe(403);
    expect((await accounts.post(`/api/v1/credit-checks/${cc.id}/decide`).send({ result: 'rejected' })).status).toBe(422); // reason required
    const done = await accounts.post(`/api/v1/credit-checks/${cc.id}/decide`).send({ result: 'approved', notes: 'Good payment history' });
    expect(done.status).toBe(200);
    expect(done.body.data).toMatchObject({ result: 'approved', decided_by: env.ctx('accounts').user.id });
    expect((await accounts.post(`/api/v1/credit-checks/${cc.id}/decide`).send({ result: 'rejected', notes: 'x' })).status).toBe(409);

    const list = await accounts.get('/api/v1/credit-checks?result=approved');
    expect(list.body.total).toBe(1);
    expect(list.body.data[0]).toMatchObject({ pi_no: pi.pi_no, dealer_name: 'Sunrise Installers' });
  });

  it('credit basis needs a dealer', async () => {
    const { env } = orderEnv();
    const w = await seedWorld(env, { dealerId: null });
    const pi = await issuePi(env, w);
    const r = await env.as('accounts').post(`/api/v1/pis/${pi.id}/credit-check`).send({ basis: 'credit' });
    expect(r.status).toBe(400);
  });

  it('exposes the dealer credit position (thin wrapper over computeDealerExposure) with party scoping', async () => {
    const { env } = orderEnv();
    await seedWorld(env);
    await addReceivable(env, 250000);
    const own = await env.as('dealer_user').get(`/api/v1/credit-position/${IDS.dealerA1}`);
    expect(own.status).toBe(200);
    expect(own.body.data).toMatchObject({ dealer_id: IDS.dealerA1, credit_limit: 1000000, outstanding: 250000, available: 750000, over_limit: false, portal_status: 'active' });
    expect(own.body.data.overrides).toEqual([]);
    expect((await env.as('dealer_user').get(`/api/v1/credit-position/${IDS.dealerB1}`)).status).toBe(403);
    expect((await env.as('accounts').get(`/api/v1/credit-position/${IDS.dealerB1}`)).status).toBe(200);
  });
});

describe('gate G11 — sales-order credit guard', () => {
  it('blocks an over-limit dealer even with the advance paid, and creates nothing', async () => {
    const { env } = orderEnv();
    const w = await seedWorld(env);
    await addReceivable(env, 700000);
    const pi = await issuePi(env, w);
    await pay(env, pi.id, 150000);
    const r = await env.as('accounts').post('/api/v1/sales-orders').send(SO_BODY(pi.id));
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('GUARD_BLOCKED');
    expect(r.body.error.details).toMatchObject({ gate: 'G11', blocked: true, outstanding: 700000, exposure_after: 1050000, credit_limit: 1000000, order_total: 500000, advance_received: 150000 });
    expect(r.body.error.message).toMatch(/credit limit/);
    expect(await env.ctx('admin').db.table('sales_orders').count()).toBe(0);
  });

  it('blocks a deactivated dealer regardless of amount, and allows an under-SOP dealer with a warning', async () => {
    const { env } = orderEnv();
    const w = await seedWorld(env);
    const pi = await issuePi(env, w);
    await pay(env, pi.id, 150000);
    const admin = env.ctx('admin');
    await admin.db.table('dealers').update(IDS.dealerA1, { portal_status: 'deactivated' });
    const blocked = await env.as('accounts').post('/api/v1/sales-orders').send(SO_BODY(pi.id));
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.details.reasons.join(' ')).toMatch(/deactivated/);

    await admin.db.table('dealers').update(IDS.dealerA1, { portal_status: 'under_sop' });
    const allowed = await env.as('accounts').post('/api/v1/sales-orders').send(SO_BODY(pi.id));
    expect(allowed.status).toBe(201);
    expect(allowed.body.data.status).toBe('pending_approval');
    expect(allowed.body.data.warnings.join(' ')).toMatch(/SOP/);
  });

  it('is lifted by an approved credit override (Accounts then Management) and only then', async () => {
    const { env } = orderEnv();
    const w = await seedWorld(env);
    await env.ctx('admin').db.table('dealers').update(IDS.dealerA1, { portal_status: 'deactivated' });
    const pi = await issuePi(env, w);
    await pay(env, pi.id, 150000);
    const accounts = env.as('accounts');
    expect((await accounts.post('/api/v1/sales-orders').send(SO_BODY(pi.id))).status).toBe(422);

    expect((await accounts.post('/api/v1/credit-overrides').send({ dealer_id: IDS.dealerA1, pi_id: pi.id, reason: 'x' })).status).toBe(422); // reason too short
    expect((await env.as('dealer_user').post('/api/v1/credit-overrides').send({ dealer_id: IDS.dealerA1, pi_id: pi.id, reason: 'Please let it through' })).status).toBe(403);
    const req = await accounts.post('/api/v1/credit-overrides').send({ dealer_id: IDS.dealerA1, pi_id: pi.id, reason: 'Appeal pending; customer prepaid 30%' });
    expect(req.status).toBe(201);
    const overrideId = req.body.data.override.id as string;
    expect(req.body.data.override.status).toBe('pending');
    expect(req.body.data.approvals.map((a: { required_role: string; lane: string; entity_type: string }) => [a.entity_type, a.lane, a.required_role]))
      .toEqual([['credit_override', 'credit', 'accounts'], ['credit_override', 'credit', 'management']]);
    expect((await accounts.post('/api/v1/credit-overrides').send({ dealer_id: IDS.dealerA1, pi_id: pi.id, reason: 'Appeal pending; customer prepaid 30%' })).status).toBe(409);

    // pending is not enough
    expect((await accounts.post('/api/v1/sales-orders').send(SO_BODY(pi.id))).status).toBe(422);
    await decide(env, 'credit_override', overrideId, 'approved');
    expect((await env.ctx('admin').db.table('credit_overrides').get(overrideId))?.status).toBe('pending'); // waiting for Management
    expect((await accounts.post('/api/v1/sales-orders').send(SO_BODY(pi.id))).status).toBe(422);
    await decide(env, 'credit_override', overrideId, 'approved');
    const row = await env.ctx('admin').db.table('credit_overrides').get(overrideId);
    expect(row).toMatchObject({ status: 'approved', approved_by: env.ctx('management').user.id });

    const so = await accounts.post('/api/v1/sales-orders').send(SO_BODY(pi.id));
    expect(so.status).toBe(201);
    expect(so.body.data.warnings.join(' ')).toMatch(/credit override/);
    expect((await env.ctx('admin').db.table('credit_overrides').get(overrideId))?.sales_order_id).toBe(so.body.data.id);
    expect((await accounts.get(`/api/v1/credit-overrides/${overrideId}`)).body.data.approvals).toHaveLength(2);
  });

  it('a rejected override stays rejected and does not unblock the order', async () => {
    const { env } = orderEnv();
    const w = await seedWorld(env);
    await addReceivable(env, 900000);
    const pi = await issuePi(env, w);
    const accounts = env.as('accounts');
    const id = (await accounts.post('/api/v1/credit-overrides').send({ dealer_id: IDS.dealerA1, pi_id: pi.id, reason: 'Dealer asked nicely' })).body.data.override.id as string;
    await decide(env, 'credit_override', id, 'rejected', 'Not acceptable');
    expect((await env.ctx('admin').db.table('credit_overrides').get(id))?.status).toBe('rejected');
    expect((await accounts.post('/api/v1/sales-orders').send(SO_BODY(pi.id))).status).toBe(422);
    expect(await env.ctx('admin').db.table('approvals').count({ entity_id: id, decision: 'pending' })).toBe(0);
  });
});

describe('advance received OR credit approved? — hold, reminders and release', () => {
  it('puts the order on hold with a payment_reminder clock, reminds the customer daily and escalates', async () => {
    const f = fakes();
    const { env } = orderEnv(f);
    const w = await seedWorld(env);
    const pi = await issuePi(env, w);
    const r = await env.as('accounts').post('/api/v1/sales-orders').send(SO_BODY(pi.id));
    expect(r.status).toBe(201);
    const so = r.body.data;
    expect(so.status).toBe('on_hold');
    expect(so.hold_reason).toMatch(/Awaiting advance of Rs\. 1,50,000/);
    expect(so.approvals).toHaveLength(0);
    const admin = env.ctx('admin');
    const clock = (await admin.svc.clocks.forEntity('sales_order', so.id)).find((c) => c.clock_type === 'payment_reminder')!;
    expect(clock).toMatchObject({ status: 'running', meta: { cycle: 1 } });
    expect(new Date(clock.due_at).getTime() - env.now().getTime()).toBeGreaterThanOrEqual(24 * 3600_000);

    // day 1: the clock breaches -> transactional WhatsApp reminder through the consent-aware pipeline
    env.advance(25 * 3600_000);
    const tick = await tickClocks(env.deps, env.now());
    expect(tick.breached).toBeGreaterThanOrEqual(1);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toMatchObject({ lead_id: w.lead.id, purpose: 'transactional', channel: 'whatsapp', template_key: 'wa.payment_reminder' }); // the approved WhatsApp template that is seeded
    expect(f.sent[0]!.vars).toMatchObject({ '1': expect.any(String), '3': expect.any(String) }); // template variables: {{1}} name, {{2}} amount due, {{3}} proforma invoice
    expect(f.sent[0]!.vars!['2']).toContain('Rs. 1,50,000');
    const clocks = (await admin.svc.clocks.forEntity('sales_order', so.id)).filter((c) => c.clock_type === 'payment_reminder');
    expect(clocks.filter((c) => c.status === 'running')).toHaveLength(1);
    expect(clocks.find((c) => c.status === 'running')!.meta).toMatchObject({ cycle: 2 });
    expect(await admin.db.table('notifications').count({ kind: 'clock.payment_reminder.breach' })).toBeGreaterThan(0);

    // later days: Sales Manager after 3 reminders, Management after 5 (rule order.payment_reminder_escalation)
    for (let day = 0; day < 4; day++) { env.advance(25 * 3600_000); await tickClocks(env.deps, env.now()); }
    expect(f.sent.length).toBe(5);
    expect(await admin.db.table('notifications').count({ kind: 'so.payment_overdue.3', user_id: env.ctx('sales_manager').user.id })).toBe(1);
    expect(await admin.db.table('notifications').count({ kind: 'so.payment_overdue.5', user_id: env.ctx('management').user.id })).toBe(1);
  });

  it('records a blocked reminder (no consent) and tells the owner instead of failing', async () => {
    const f = fakes();
    f.msg.blocked = true;
    const { env } = orderEnv(f);
    const w = await seedWorld(env);
    const pi = await issuePi(env, w);
    const so = (await env.as('accounts').post('/api/v1/sales-orders').send(SO_BODY(pi.id))).body.data;
    env.advance(25 * 3600_000);
    await tickClocks(env.deps, env.now());
    expect(f.sent).toHaveLength(1);
    expect(await env.ctx('admin').db.table('notifications').count({ kind: 'so.reminder_not_delivered', entity_id: so.id })).toBe(1);
  });

  it('release-hold refuses until money or credit is in, then moves the order to approval and stops the reminders', async () => {
    const { env } = orderEnv();
    const w = await seedWorld(env);
    const pi = await issuePi(env, w);
    const accounts = env.as('accounts');
    const so = (await accounts.post('/api/v1/sales-orders').send(SO_BODY(pi.id))).body.data;
    const early = await accounts.post(`/api/v1/sales-orders/${so.id}/release-hold`).send({});
    expect(early.status).toBe(422);
    expect(early.body.error.code).toBe('GUARD_BLOCKED');

    // a partial payment is not enough; a credit approval is
    await pay(env, pi.id, 50000);
    expect((await accounts.get(`/api/v1/sales-orders/${so.id}`)).body.data.status).toBe('on_hold');
    const cc = (await accounts.post(`/api/v1/pis/${pi.id}/credit-check`).send({ basis: 'credit' })).body.data;
    await accounts.post(`/api/v1/credit-checks/${cc.id}/decide`).send({ result: 'approved', notes: 'ok' });
    // approving credit releases the held order automatically
    const released = (await accounts.get(`/api/v1/sales-orders/${so.id}`)).body.data;
    expect(released.status).toBe('pending_approval');
    expect(released.credit_basis).toBe('credit');
    expect(released.hold_reason).toBeNull();
    expect(released.approvals).toHaveLength(1);
    expect(released.advance_received).toBe(50000);
    const reminder = (await env.ctx('admin').svc.clocks.forEntity('sales_order', so.id)).find((c) => c.clock_type === 'payment_reminder')!;
    expect(reminder.status).toBe('met');
    expect((await accounts.post(`/api/v1/sales-orders/${so.id}/release-hold`).send({})).status).toBe(409);
  });

  it('paying the advance releases a held order automatically', async () => {
    const { env } = orderEnv();
    const w = await seedWorld(env);
    const pi = await issuePi(env, w);
    const so = (await env.as('accounts').post('/api/v1/sales-orders').send(SO_BODY(pi.id))).body.data;
    await pay(env, pi.id, 150000);
    const after = (await env.as('accounts').get(`/api/v1/sales-orders/${so.id}`)).body.data;
    expect(after).toMatchObject({ status: 'pending_approval', credit_basis: 'advance', advance_received: 150000 });
    await decideAll(env, 'sales_order', so.id);
    expect((await env.as('accounts').get(`/api/v1/sales-orders/${so.id}`)).body.data.status).toBe('approved');
  });
});
