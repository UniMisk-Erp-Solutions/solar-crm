import { describe, expect, it } from 'vitest';
import { GSTIN_UNREGISTERED } from '@solar/shared';
import { decide, decideAll, orderEnv, pay, seedWorld, issuePi, GSTIN } from './fixtures';

describe('pre-PI checklist and proforma invoice (steps 28-29)', () => {
  it('reports exactly the missing items before a PI exists', async () => {
    const { env } = orderEnv();
    const w = await seedWorld(env, { customerType: 'residential', gstin: null, shipping: null, paymentTerms: null });
    // shipping falls back to the site address, so only GST and payment terms are missing
    const r = await env.as('accounts').get(`/api/v1/quotes/${w.quote.id}/pre-pi-checklist`);
    expect(r.status).toBe(200);
    expect(r.body.data.accepted).toBe(true);
    expect(r.body.data.missing.sort()).toEqual(['gst', 'payment_terms']);
    expect(r.body.data.complete).toBe(false);
    expect(r.body.data.defaults.unregistered_allowed).toBe(true);
    expect(r.body.data.defaults.shipping_address.pincode).toBe('380015');
  });

  it('creates a draft PI from an accepted quote and refuses to issue it while the checklist has false items', async () => {
    const { env } = orderEnv();
    const w = await seedWorld(env, { customerType: 'residential', gstin: null, paymentTerms: null });
    const accounts = env.as('accounts');
    const created = await accounts.post('/api/v1/pis').send({ quote_id: w.quote.id });
    expect(created.status).toBe(201);
    const pi = created.body.data;
    expect(pi.pi_no).toMatch(/^FS\/PI\/26\/\d{4}$/);
    expect(pi.status).toBe('draft');
    expect(pi.lines).toHaveLength(3);
    expect(pi.total).toBe(500000);
    expect(pi.subtotal + pi.freight + pi.tax_total).toBe(pi.total);
    expect([pi.consumer_share, pi.loan_share, pi.subsidy_receivable]).toEqual([322000, 100000, 78000]);
    expect(pi.pre_pi_checklist.gst).toBe(false);
    expect(pi.pre_pi_checklist.payment_terms).toBe(false);
    expect(pi.pre_pi_checklist.freight).toBe(true);

    const blocked = await accounts.post(`/api/v1/pis/${pi.id}/submit`).send({});
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('GUARD_BLOCKED');
    expect(blocked.body.error.details.missing.sort()).toEqual(['gst', 'payment_terms']);
    expect(await env.ctx('admin').db.table('approvals').count({ entity_id: pi.id })).toBe(0);

    // a residential customer may be billed as unregistered only with the explicit flag
    const fixed = await accounts.patch(`/api/v1/pis/${pi.id}`).send({ gst_unregistered: true, payment_terms: '100% advance' });
    expect(fixed.status).toBe(200);
    expect(fixed.body.data.gstin).toBe(GSTIN_UNREGISTERED);
    expect(fixed.body.data.pre_pi_checklist).toMatchObject({ gst: true, payment_terms: true });
    expect((await accounts.post(`/api/v1/pis/${pi.id}/submit`).send({})).status).toBe(200);
  });

  it('does not accept the unregistered flag for a business customer and validates a GSTIN', async () => {
    const { env } = orderEnv();
    const w = await seedWorld(env, { customerType: 'commercial', gstin: null });
    const accounts = env.as('accounts');
    const pi = (await accounts.post('/api/v1/pis').send({ quote_id: w.quote.id, gst_unregistered: true })).body.data;
    const r = await accounts.post(`/api/v1/pis/${pi.id}/submit`).send({});
    expect(r.status).toBe(422);
    expect(r.body.error.details.missing).toEqual(['gst']);
    expect((await accounts.patch(`/api/v1/pis/${pi.id}`).send({ gstin: 'NOT-A-GSTIN' })).status).toBe(422);
    expect((await accounts.patch(`/api/v1/pis/${pi.id}`).send({ gstin: GSTIN })).status).toBe(200);
    expect((await accounts.post(`/api/v1/pis/${pi.id}/submit`).send({})).status).toBe(200);
  });

  it('needs an accepted quote and allows one live PI per quote', async () => {
    const { env } = orderEnv();
    const w = await seedWorld(env, { quoteStatus: 'sent' });
    const accounts = env.as('accounts');
    const r = await accounts.post('/api/v1/pis').send({ quote_id: w.quote.id });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('INVALID_STATE');
    await env.ctx('admin').db.table('quotations').update(w.quote.id, { status: 'accepted' });
    expect((await accounts.post('/api/v1/pis').send({ quote_id: w.quote.id })).status).toBe(201);
    expect((await accounts.post('/api/v1/pis').send({ quote_id: w.quote.id })).status).toBe(409);
  });

  it('PI -> approval -> issued, with validity from the rule and the approval clock', async () => {
    const { env } = orderEnv();
    const w = await seedWorld(env);
    await env.rule('order.pi_validity_days', 10);
    const accounts = env.as('accounts');
    const id = (await accounts.post('/api/v1/pis').send({ quote_id: w.quote.id })).body.data.id as string;
    const submitted = await accounts.post(`/api/v1/pis/${id}/submit`).send({});
    expect(submitted.body.data.status).toBe('pending_approval');
    const approvals = submitted.body.data.approvals;
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ entity_type: 'proforma_invoice', lane: 'credit', required_role: 'accounts', step: 1, decision: 'pending' });
    const stepClock = (await env.ctx('admin').svc.clocks.forEntity('approval', approvals[0].id))[0];
    expect(stepClock).toMatchObject({ clock_type: 'approval', status: 'running', due_at: approvals[0].due_at });
    // opportunity moved to the PI stage
    expect((await env.ctx('admin').db.table('opportunities').get(w.opp.id))?.stage).toBe('pi_stage');

    const viaHttp = await accounts.post(`/api/v1/approvals/${approvals[0].id}/decide`).send({ decision: 'approved', comment: 'Looks right' });
    expect(viaHttp.status).toBe(200);
    expect(viaHttp.body.data.outcome).toBe('lane_approved');
    const pi = (await accounts.get(`/api/v1/pis/${id}`)).body.data;
    expect(pi.status).toBe('issued');
    expect(pi.issue_date).toBe('2026-10-26');
    expect(pi.valid_till).toBe('2026-11-05');
    expect(pi.approved_by).toBe(env.ctx('accounts').user.id);
    expect((await env.ctx('admin').svc.clocks.forEntity('approval', approvals[0].id))[0]?.status).toBe('met');
  });

  it('big orders get a second approval step by Management; a rejection returns the PI to draft', async () => {
    const { env } = orderEnv();
    const w = await seedWorld(env);
    await env.rule('order.management_approval_above', 400000);
    const accounts = env.as('accounts');
    const id = (await accounts.post('/api/v1/pis').send({ quote_id: w.quote.id })).body.data.id as string;
    const sub = await accounts.post(`/api/v1/pis/${id}/submit`).send({});
    expect(sub.body.data.approvals.map((a: { required_role: string }) => a.required_role)).toEqual(['accounts', 'management']);
    const step2Before = (await env.ctx('admin').db.table('approvals').all({ entity_id: id, step: 2 }))[0]!;
    expect(step2Before.due_at).toBeNull(); // not active until step 1 is decided
    await decide(env, 'proforma_invoice', id, 'approved');
    expect((await accounts.get(`/api/v1/pis/${id}`)).body.data.status).toBe('pending_approval'); // waits for management
    const step2 = (await env.ctx('admin').db.table('approvals').all({ entity_id: id, step: 2 }))[0]!;
    expect(step2.due_at).not.toBeNull();
    expect((await env.ctx('admin').svc.clocks.forEntity('approval', step2.id))[0]).toMatchObject({ status: 'running' });
    await decide(env, 'proforma_invoice', id, 'rejected', 'Price below floor');
    const pi = (await accounts.get(`/api/v1/pis/${id}`)).body.data;
    expect(pi.status).toBe('draft');
    expect(pi.issue_date).toBeNull();
    // resubmission is a fresh round
    expect((await accounts.post(`/api/v1/pis/${id}/submit`).send({})).status).toBe(200);
    await decideAll(env, 'proforma_invoice', id);
    expect((await accounts.get(`/api/v1/pis/${id}`)).body.data.status).toBe('issued');
  });

  it('records payments, moves the PI through partially_paid and paid and refuses over-payment', async () => {
    const { env } = orderEnv();
    const w = await seedWorld(env);
    const pi = await issuePi(env, w);
    const first = await pay(env, pi.id, 150000);
    expect(first.status).toBe(201);
    expect(first.body.data.pi.status).toBe('partially_paid');
    expect(first.body.data.pi.paid_amount).toBe(150000);
    expect(first.body.data.pi.advance_ok).toBe(true);
    expect((await pay(env, pi.id, 400000, 'balance')).status).toBe(422);
    const last = await pay(env, pi.id, 350000, 'balance');
    expect(last.body.data.pi.status).toBe('paid');
    const list = await env.as('accounts').get(`/api/v1/payments?pi_id=${pi.id}`);
    expect(list.body.total).toBe(2);
    // a bounced cheque drops the PI back
    const bounced = await env.as('accounts').patch(`/api/v1/payments/${last.body.data.payment.id}`).send({ status: 'bounced' });
    expect(bounced.body.data.pi.status).toBe('partially_paid');
    expect((await env.as('dispatch').post(`/api/v1/pis/${pi.id}/payments`).send({ amount: 10, mode: 'upi' })).status).toBe(403);
    expect((await env.as('accounts').post('/api/v1/pis/' + w.quote.id + '/payments').send({ amount: 10, mode: 'upi' })).status).toBe(404);
  });

  it('draft PIs take no payments; cancelling is blocked once money is in', async () => {
    const { env } = orderEnv();
    const w = await seedWorld(env);
    const accounts = env.as('accounts');
    const draft = (await accounts.post('/api/v1/pis').send({ quote_id: w.quote.id })).body.data;
    expect((await pay(env, draft.id, 1000)).status).toBe(409);
    expect((await accounts.post(`/api/v1/pis/${draft.id}/cancel`).send({})).body.data.status).toBe('cancelled');
    const w2 = await seedWorld(env);
    const pi = await issuePi(env, w2);
    await pay(env, pi.id, 1000);
    expect((await accounts.post(`/api/v1/pis/${pi.id}/cancel`).send({})).status).toBe(409);
  });

  it('renders a branded PDF into the invoices bucket (signed URL by default, bytes with ?inline=1)', async () => {
    const { env } = orderEnv();
    const w = await seedWorld(env);
    const pi = await issuePi(env, w);
    const json = await env.as('accounts').get(`/api/v1/pis/${pi.id}/pdf`);
    expect(json.status).toBe(200);
    expect(json.body.data.url).toContain('/invoices/');
    expect(json.body.data.file_name).toMatch(/^FS-PI-26-\d{4}\.pdf$/);
    const doc = await env.ctx('admin').db.table('documents').get(json.body.data.document_id);
    expect(doc).toMatchObject({ bucket: 'invoices', doc_type: 'pi_pdf', entity_type: 'proforma_invoice', entity_id: pi.id, mime: 'application/pdf' });
    expect(env.providers.files.has(`invoices/${doc!.path}`)).toBe(true);
    const bytes = await env.as('accounts').get(`/api/v1/pis/${pi.id}/pdf?inline=1`).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect(bytes.headers['content-type']).toContain('application/pdf');
    expect((bytes.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    // unchanged PI: the stored document is reused
    expect(await env.ctx('admin').db.table('documents').count({ entity_id: pi.id, doc_type: 'pi_pdf' })).toBe(1);
  });
});
