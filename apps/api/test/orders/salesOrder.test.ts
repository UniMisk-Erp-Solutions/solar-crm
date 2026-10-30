import { describe, expect, it } from 'vitest';
import { IDS } from '../helpers/env';
import { decide, decideAll, issuePi, orderEnv, pay, readyForDispatch, seedWorld } from './fixtures';

const SO_BODY = (pi_id: string, extra: Record<string, unknown> = {}) => ({ pi_id, customer_po_no: 'PO-7781', customer_po_date: '2026-10-25', ...extra });

describe('sales order (steps 31-34)', () => {
  it('needs an issued PI and one live order per PI', async () => {
    const { env } = orderEnv();
    const w = await seedWorld(env);
    const accounts = env.as('accounts');
    const draft = (await accounts.post('/api/v1/pis').send({ quote_id: w.quote.id })).body.data;
    const r = await accounts.post('/api/v1/sales-orders').send(SO_BODY(draft.id));
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('INVALID_STATE');
    const pi = await issuePi(env, await seedWorld(env));
    await pay(env, pi.id, 150000);
    expect((await accounts.post('/api/v1/sales-orders').send(SO_BODY(pi.id))).status).toBe(201);
    expect((await accounts.post('/api/v1/sales-orders').send(SO_BODY(pi.id))).status).toBe(409);
    expect((await accounts.post('/api/v1/sales-orders').send({ pi_id: pi.id })).status).toBe(422); // PO number/date required
  });

  it('creates the SO with lines, links PI/payments and opens the approval (advance branch)', async () => {
    const { env } = orderEnv();
    const w = await seedWorld(env);
    const pi = await issuePi(env, w);
    await pay(env, pi.id, 150000);
    const r = await env.as('accounts').post('/api/v1/sales-orders').send(SO_BODY(pi.id));
    expect(r.status).toBe(201);
    const so = r.body.data;
    expect(so.so_no).toMatch(/^FS\/SO\/26\/\d{4}$/);
    expect(so).toMatchObject({
      status: 'pending_approval', credit_basis: 'advance', advance_received: 150000, total: 500000, customer_po_no: 'PO-7781', segment: 'ci_net_metered', order_date: '2026-10-26',
      dealer_id: IDS.dealerA1, distributor_id: IDS.distributorA, pi_no: pi.pi_no, hold_reason: null,
    });
    expect(so.lines.map((l: { description: string; qty: number; qty_dispatched: number; serial_tracked: boolean }) => [l.qty, l.qty_dispatched, l.serial_tracked])).toEqual([[10, 0, true], [1, 0, true], [1, 0, false]]);
    expect(so.approvals).toHaveLength(1);
    expect(so.approvals[0]).toMatchObject({ entity_type: 'sales_order', lane: 'credit', required_role: 'accounts', decision: 'pending' });
    expect(so.payments[0].sales_order_id).toBe(so.id);
    expect(so.compliance_snapshot.quote).toMatchObject({ quote_id: w.quote.id, status: 'clear' });
    expect(so.installation_id).toBeNull();
    const piNow = (await env.as('accounts').get(`/api/v1/pis/${pi.id}`)).body.data;
    expect(piNow.sales_order_id).toBe(so.id);
    // lead timeline
    const events = await env.ctx('admin').db.table('lead_events').all({ lead_id: w.lead.id });
    expect(events.map((e) => e.event_type)).toContain('sales_order_created');
  });

  it('credit approved (no advance) also satisfies the decision node', async () => {
    const { env } = orderEnv();
    const w = await seedWorld(env);
    const pi = await issuePi(env, w);
    const accounts = env.as('accounts');
    const cc = (await accounts.post(`/api/v1/pis/${pi.id}/credit-check`).send({ basis: 'credit' })).body.data;
    await accounts.post(`/api/v1/credit-checks/${cc.id}/decide`).send({ result: 'approved', notes: 'Within limit' });
    const so = (await accounts.post('/api/v1/sales-orders').send(SO_BODY(pi.id))).body.data;
    expect(so).toMatchObject({ status: 'pending_approval', credit_basis: 'credit', advance_received: 0 });
    expect(so.credit_checks.find((c: { id: string }) => c.id === cc.id).sales_order_id).toBe(so.id);
  });

  it('approval -> approved, circulated to distributor, dealer, dispatch and accounts -> hand-over wins the opportunity and lead', async () => {
    const { env } = orderEnv();
    const w = await seedWorld(env);
    const pi = await issuePi(env, w);
    await pay(env, pi.id, 150000);
    const accounts = env.as('accounts');
    const soId = (await accounts.post('/api/v1/sales-orders').send(SO_BODY(pi.id))).body.data.id as string;
    expect((await env.as('management').post(`/api/v1/sales-orders/${soId}/handover`).send({})).status).toBe(409); // not approved yet

    await decide(env, 'sales_order', soId, 'approved');
    const so = (await accounts.get(`/api/v1/sales-orders/${soId}`)).body.data;
    expect(so.status).toBe('approved');
    expect(so.circulated_at).toBe(env.now().toISOString());
    expect(so.approved_by).toBe(env.ctx('accounts').user.id);
    const notified = (await env.ctx('admin').db.table('notifications').all({ kind: 'so.circulated', entity_id: soId })).map((n) => n.user_id);
    for (const who of ['dispatch', 'accounts', 'distributor_user', 'dealer_user'] as const) expect(notified).toContain(env.ctx(who).user.id);
    expect(notified).not.toContain(IDS.dealerUserB);
    expect((await env.ctx('admin').svc.clocks.forEntity('approval', so.approvals[0].id))[0]?.status).toBe('met');

    const h = await env.as('management').post(`/api/v1/sales-orders/${soId}/handover`).send({ note: 'Site ready' });
    expect(h.status).toBe(200);
    expect(h.body.data.status).toBe('dispatch_planning');
    expect(h.body.data.dispatch_handover_at).toBe(env.now().toISOString());
    const admin = env.ctx('admin');
    expect((await admin.db.table('opportunities').get(w.opp.id))?.stage).toBe('won');
    expect((await admin.db.table('leads').get(w.lead.id))?.status).toBe('won');
    expect(await admin.db.table('notifications').count({ kind: 'so.handover', user_id: env.ctx('dispatch').user.id })).toBe(1);
    expect((await env.as('dispatch').post(`/api/v1/sales-orders/${soId}/handover`).send({})).status).toBe(403);
  });

  it('a rejected SO approval cancels the order and frees the PI for a new one', async () => {
    const { env } = orderEnv();
    const w = await seedWorld(env);
    const pi = await issuePi(env, w);
    await pay(env, pi.id, 150000);
    const accounts = env.as('accounts');
    const so = (await accounts.post('/api/v1/sales-orders').send(SO_BODY(pi.id))).body.data;
    await decide(env, 'sales_order', so.id, 'rejected', 'PO does not match quotation');
    const after = (await accounts.get(`/api/v1/sales-orders/${so.id}`)).body.data;
    expect(after.status).toBe('cancelled');
    expect(after.hold_reason).toMatch(/PO does not match/);
    expect((await accounts.post('/api/v1/sales-orders').send(SO_BODY(pi.id, { customer_po_no: 'PO-CORRECT' }))).status).toBe(201);
  });

  it('big orders need Management as a second approval step', async () => {
    const { env } = orderEnv();
    const w = await seedWorld(env);
    await env.rule('order.management_approval_above', 400000);
    const pi = await issuePi(env, w);
    await pay(env, pi.id, 150000);
    const so = (await env.as('accounts').post('/api/v1/sales-orders').send(SO_BODY(pi.id))).body.data;
    expect(so.approvals.map((a: { required_role: string }) => a.required_role)).toEqual(['accounts', 'management']);
    await decide(env, 'sales_order', so.id, 'approved');
    expect((await env.as('accounts').get(`/api/v1/sales-orders/${so.id}`)).body.data.status).toBe('pending_approval');
    await decideAll(env, 'sales_order', so.id);
    expect((await env.as('accounts').get(`/api/v1/sales-orders/${so.id}`)).body.data.status).toBe('approved');
  });

  it('cancel works before shipment; the PI can then be reused', async () => {
    const { env } = orderEnv();
    const w = await seedWorld(env);
    const { soId, pi } = await readyForDispatch(env, w);
    const r = await env.as('management').post(`/api/v1/sales-orders/${soId}/cancel`).send({ note: 'Customer withdrew' });
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe('cancelled');
    expect((await env.as('accounts').get(`/api/v1/pis/${pi.id}`)).body.data.sales_order_id).toBeNull();
    expect((await env.as('management').post(`/api/v1/sales-orders/${soId}/cancel`).send({})).status).toBe(409);
  });
});

describe('role scoping', () => {
  it('a dealer sees only their own PIs, sales orders and credit checks', async () => {
    const { env } = orderEnv();
    const mine = await seedWorld(env);                                              // dealer A1 / distributor A
    const theirs = await seedWorld(env, { dealerId: IDS.dealerB1, distributorId: IDS.distributorB });
    const piMine = await issuePi(env, mine);
    const piTheirs = await issuePi(env, theirs);
    await pay(env, piMine.id, 150000);
    await pay(env, piTheirs.id, 150000);
    const soMine = (await env.as('accounts').post('/api/v1/sales-orders').send(SO_BODY(piMine.id))).body.data.id as string;
    const soTheirs = (await env.as('accounts').post('/api/v1/sales-orders').send(SO_BODY(piTheirs.id))).body.data.id as string;
    await env.as('accounts').post(`/api/v1/pis/${piMine.id}/credit-check`).send({ basis: 'advance' });
    await env.as('accounts').post(`/api/v1/pis/${piTheirs.id}/credit-check`).send({ basis: 'advance' });

    const dealer = env.as('dealer_user');
    expect((await dealer.get('/api/v1/pis')).body.data.map((p: { id: string }) => p.id)).toEqual([piMine.id]);
    expect((await dealer.get('/api/v1/sales-orders')).body.data.map((s: { id: string }) => s.id)).toEqual([soMine]);
    expect((await dealer.get('/api/v1/credit-checks')).body.data.map((c: { pi_id: string }) => c.pi_id)).toEqual([piMine.id]);
    expect((await dealer.get(`/api/v1/pis/${piMine.id}`)).status).toBe(200);
    expect((await dealer.get(`/api/v1/pis/${piTheirs.id}`)).status).toBe(403);
    expect((await dealer.get(`/api/v1/sales-orders/${soTheirs}`)).status).toBe(403);
    expect((await dealer.get(`/api/v1/pis/${piTheirs.id}/pdf`)).status).toBe(403);

    // distributor A sees A, distributor B sees B, internal sees both
    expect((await env.as('distributor_user').get('/api/v1/pis')).body.data.map((p: { id: string }) => p.id)).toEqual([piMine.id]);
    expect((await env.as(IDS.distributorUserB).get('/api/v1/sales-orders')).body.data.map((s: { id: string }) => s.id)).toEqual([soTheirs]);
    expect((await env.as('accounts').get('/api/v1/pis')).body.total).toBe(2);

    // external users cannot create or operate on anything
    expect((await dealer.post('/api/v1/pis').send({ quote_id: mine.quote.id })).status).toBe(403);
    expect((await dealer.post('/api/v1/sales-orders').send(SO_BODY(piMine.id))).status).toBe(403);
    expect((await dealer.get('/api/v1/payments')).status).toBe(403);
    expect((await dealer.get('/api/v1/exports/erp?doc=pi')).status).toBe(403);
    expect((await env.anon().get('/api/v1/pis')).status).toBe(401);
  });
});
