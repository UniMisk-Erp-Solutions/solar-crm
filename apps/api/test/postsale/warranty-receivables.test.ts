import { describe, expect, it } from 'vitest';
import { tickClocks } from '../../src/services/clockService';
import { refreshReceivableStatuses } from '../../src/services/receivableService';
import { API, IDS, newEnv, seedProject, seedRules } from './fixtures';
import type { TestEnv } from '../helpers/env';

const ticket = (env: TestEnv, who: string, body: Record<string, unknown>) => env.as(who).post(`${API}/warranty-tickets`).send(body);

describe('warranty / RMA tickets', () => {
  it('raises a ticket by serial with an FS/W/<yy>/<nnnn> number, unknown cost bearer and a 21-day RMA clock', async () => {
    const env = newEnv();
    const p = await seedProject(env);
    const r = await ticket(env, 'dealer_user', { serial: p.serials[0], type: 'rma', issue: 'Module hot-spot on string 2', brand_claim_no: 'WAA-2026-118' });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({
      ticket_no: 'FS/W/26/0001', status: 'open', cost_bearer: 'unknown', recovered_amount: 0, serial_no: p.serials[0], sales_order_id: p.soId, customer_id: p.customerId, dealer_id: IDS.dealerA1,
      brand_claim_no: 'WAA-2026-118', rma_due_at: '2026-11-16T18:29:59.999Z', rma_overdue: false,
    });
    const second = await ticket(env, 'dealer_user', { serial: p.serials[1], type: 'complaint', issue: 'Customer complaint about output' });
    expect(second.body.data.ticket_no).toBe('FS/W/26/0002');
    expect(second.body.data.rma_due_at).toBeNull(); // complaints carry no RMA clock
    const clocks = await env.db.table('clocks').all({ clock_type: 'warranty_rma' });
    expect(clocks).toHaveLength(1);
    expect(clocks[0]).toMatchObject({ entity_type: 'warranty_ticket', entity_id: r.body.data.id, status: 'running' });
    expect((await env.db.table('inventory_serials').get(p.serialIds[0]!))?.status).toBe('rma');
    expect((await env.db.table('inventory_serials').get(p.serialIds[1]!))?.status).toBe('dispatched');
  });

  it('the RMA turnaround is a rule: change it and the due date moves; inactive ⇒ warning and no clock', async () => {
    const env = newEnv();
    await env.rule('warranty.rma_tat_days', 10, { status: 'unverified' });
    const p = await seedProject(env);
    const r = await ticket(env, 'admin', { serial: p.serials[0], type: 'warranty', issue: 'Inverter error E04' });
    expect(r.body.data.rma_due_at).toBe('2026-11-05T18:29:59.999Z');

    const env2 = newEnv();
    await env2.rule('warranty.rma_tat_days', 10, { is_active: false });
    const p2 = await seedProject(env2);
    const r2 = await ticket(env2, 'admin', { serial: p2.serials[0], type: 'warranty', issue: 'Inverter error E04' });
    expect(r2.body.data.warnings.join(' ')).toMatch(/warranty\.rma_tat_days is not active/);
    expect(r2.body.data.rma_due_at).toBeNull();
    expect(await env2.db.table('clocks').count({ clock_type: 'warranty_rma' })).toBe(0);
  });

  it('breaches the clock after the turnaround and escalates through the matrix', async () => {
    const env = newEnv();
    const p = await seedProject(env);
    const t = (await ticket(env, 'dsm', { serial: p.serials[0], type: 'rma', issue: 'No output' })).body.data;
    env.setNow(new Date('2026-11-18T05:00:00Z'));
    expect((await tickClocks(env.deps)).breached).toBe(1);
    const list = await env.as('dsm').get(`${API}/warranty-tickets`);
    expect(list.body.data[0]).toMatchObject({ id: t.id, rma_overdue: true });
    expect(await env.db.table('notifications').count({ kind: 'clock.warranty_rma.breach' })).toBeGreaterThan(0);
  });

  it('walks the status ladder, tracks brand recovery and sends the serial to RMA and back', async () => {
    const env = newEnv();
    const p = await seedProject(env);
    await env.db.table('inventory_serials').update(p.serialIds[0]!, { status: 'installed', installed_at: '2026-09-30T00:00:00.000Z' });
    const t = (await ticket(env, 'dealer_user', { serial: p.serials[0], type: 'warranty', issue: 'Cracked glass', cost_bearer: 'brand' })).body.data;
    const patch = (body: Record<string, unknown>) => env.as('dealer_user').patch(`${API}/warranty-tickets/${t.id}`).send(body);
    expect((await patch({ status: 'closed', recovered_amount: -1 })).status).toBe(422);
    expect((await patch({ status: 'inspected' })).body.data.status).toBe('inspected');
    expect((await env.db.table('inventory_serials').get(p.serialIds[0]!))?.status).toBe('installed');
    const sent = await patch({ status: 'sent_to_brand', brand_claim_no: 'BR-77' });
    expect(sent.body.data.brand_claim_no).toBe('BR-77');
    expect((await env.db.table('inventory_serials').get(p.serialIds[0]!))?.status).toBe('rma');
    expect((await patch({ status: 'inspected' })).status).toBe(422); // cannot go back
    const rejected = await patch({ status: 'rejected', recovered_amount: 0 });
    expect(rejected.body.data.status).toBe('rejected');
    expect((await env.db.table('inventory_serials').get(p.serialIds[0]!))?.status).toBe('installed'); // unit goes back to the customer
    expect((await env.db.table('clocks').all({ clock_type: 'warranty_rma' }))[0]!.status).toBe('met');
    const appeal = await patch({ status: 'sent_to_brand' });
    expect(appeal.status).toBe(200);
    const replaced = await patch({ status: 'replaced', recovered_amount: 14500 });
    expect(replaced.body.data.recovered_amount).toBe(14500);
    expect((await env.db.table('inventory_serials').get(p.serialIds[0]!))?.status).toBe('rma'); // replaced unit stays out of the installed base
    const closed = await patch({ status: 'closed' });
    expect(closed.body.data).toMatchObject({ status: 'closed', closed_at: env.now().toISOString() });
    expect((await env.db.table('inventory_serials').get(p.serialIds[0]!))?.status).toBe('rma');
    expect((await patch({ status: 'open' })).status).toBe(422);
  });

  it('warns when recovery is recorded without a brand claim number; unknown serials and stock serials are refused', async () => {
    const env = newEnv();
    const p = await seedProject(env);
    const t = (await ticket(env, 'admin', { serial: p.serials[0], type: 'warranty', issue: 'Defective junction box' })).body.data;
    const r = await env.as('admin').patch(`${API}/warranty-tickets/${t.id}`).send({ recovered_amount: 500 });
    expect(r.body.data.warnings.join(' ')).toMatch(/brand claim number/);
    expect((await ticket(env, 'admin', { serial: 'NOPE-0001', type: 'rma', issue: 'x unknown' })).status).toBe(404);
    expect((await ticket(env, 'admin', { type: 'rma', issue: 'No serial given' })).status).toBe(422);
    await env.db.table('inventory_serials').update(p.serialIds[1]!, { status: 'in_stock' });
    expect((await ticket(env, 'admin', { serial: p.serials[1], type: 'rma', issue: 'Still in stock' })).status).toBe(422);
  });

  it('filters by serial and keeps other dealers’ tickets private', async () => {
    const env = newEnv();
    const a = await seedProject(env, { n: 1 });
    const b = await seedProject(env, { n: 2, dealerId: IDS.dealerB1, distributorId: IDS.distributorB });
    await ticket(env, 'admin', { serial: a.serials[0], type: 'rma', issue: 'Hot spot A' });
    await ticket(env, 'admin', { serial: b.serials[0], type: 'rma', issue: 'Hot spot B' });
    expect((await env.as('admin').get(`${API}/warranty-tickets?serial=${a.serials[0]}`)).body.total).toBe(1);
    expect((await env.as('admin').get(`${API}/warranty-tickets?serial=NOPE`)).body.total).toBe(0);
    expect((await env.as('dealer_user').get(`${API}/warranty-tickets`)).body.total).toBe(1);
    expect((await env.as('distributor_user').get(`${API}/warranty-tickets`)).body.total).toBe(1);
    const mine = (await env.as('dealer_user').get(`${API}/warranty-tickets`)).body.data[0];
    expect((await env.as(IDS.dealerUserB).get(`${API}/warranty-tickets/${mine.id}`)).status).toBe(403);
    // a dealer cannot raise a ticket against another dealer's serial
    expect((await ticket(env, 'dealer_user', { serial: b.serials[1], type: 'rma', issue: 'Not my unit' })).status).toBe(403);
  });
});

describe('dealer receivables', () => {
  it('recalculates status from the amounts and the due date; derives the distributor', async () => {
    const env = newEnv();
    const post = (body: Record<string, unknown>) => env.as('accounts').post(`${API}/receivables`).send({ dealer_id: IDS.dealerA1, doc_ref: 'INV-1', amount: 100000, invoice_date: '2026-09-01', due_date: '2026-10-01', ...body });
    const overdue = await post({ subsidy_linked: true, linked_project_id: IDS.dealerA2 });
    expect(overdue.status).toBe(201);
    expect(overdue.body.data).toMatchObject({ status: 'overdue', days_overdue: 25, open_amount: 100000, distributor_id: IDS.distributorA, subsidy_linked: true, linked_project_id: IDS.dealerA2, dealer_name: 'Sunrise Installers' });
    expect((await post({ due_date: '2026-12-01', doc_ref: 'INV-2' })).body.data.status).toBe('open');
    expect((await post({ paid_amount: 100000, doc_ref: 'INV-3' })).body.data).toMatchObject({ status: 'paid', open_amount: 0 });
    expect((await post({ paid_amount: 200000, doc_ref: 'INV-4' })).status).toBe(422);
    expect((await post({ due_date: '2026-08-01', doc_ref: 'INV-5' })).status).toBe(422);
    // part payment then full payment through PATCH
    const id = overdue.body.data.id;
    const part = await env.as('accounts').patch(`${API}/receivables/${id}`).send({ paid_amount: 40000 });
    expect(part.body.data).toMatchObject({ status: 'overdue', open_amount: 60000 });
    expect((await env.as('accounts').patch(`${API}/receivables/${id}`).send({ paid_amount: 100000 })).body.data.status).toBe('paid');
    expect((await env.as('accounts').patch(`${API}/receivables/${id}`).send({ status: 'written_off', paid_amount: 0 })).body.data.status).toBe('written_off');
  });

  it('the nightly sweep persists open → overdue; only channel administrators write; dealers see their own', async () => {
    const env = newEnv();
    const mk = (dealer: string, due: string) => env.ctx().db.table('dealer_receivables').insert({ dealer_id: dealer, distributor_id: dealer === IDS.dealerB1 ? IDS.distributorB : IDS.distributorA, doc_ref: `D-${due}`, amount: 1000, paid_amount: 0, invoice_date: '2026-08-01', due_date: due, subsidy_linked: false, linked_project_id: null, status: 'open' });
    const a = await mk(IDS.dealerA1, '2026-09-30'); await mk(IDS.dealerA1, '2026-12-30'); await mk(IDS.dealerB1, '2026-09-01');
    expect(await refreshReceivableStatuses(env.systemCtx())).toEqual({ scanned: 3, updated: 2 });
    expect((await env.db.table('dealer_receivables').get(a.id))?.status).toBe('overdue');
    expect((await env.as('dealer_user').get(`${API}/receivables`)).body.total).toBe(2);
    expect((await env.as('distributor_user').get(`${API}/receivables?status=overdue`)).body.total).toBe(1);
    expect((await env.as('dealer_user').post(`${API}/receivables`).send({ dealer_id: IDS.dealerA1, doc_ref: 'X', amount: 1, invoice_date: '2026-09-01', due_date: '2026-10-01' })).status).toBe(403);
    expect((await env.as('dealer_user').patch(`${API}/receivables/${a.id}`).send({ paid_amount: 10 })).status).toBe(403);
  });
});

describe('post-sale board', () => {
  it('counts every tab and what is overdue', async () => {
    const env = newEnv();
    await seedRules(env);
    const p = await seedProject(env);
    const inst = (await env.as('admin').post(`${API}/installations`).send({ sales_order_id: p.soId, install_date: '2026-10-01' })).body.data;
    await env.as('admin').post(`${API}/installations/${inst.id}/certificate`).send({ certificate_at: '2026-10-05' }); // due 20-Oct → overdue today
    const p2 = await seedProject(env, { n: 2, kw: 25 });
    await env.as('admin').post(`${API}/discom-applications`).send({ site_id: p2.siteId, applied_kw: 25, complete_at: '2026-10-01' }); // feasibility due 16-Oct → overdue
    const db = env.ctx().db;
    await db.table('loans').insert({ bank: 'SBI', status: 'applied', application_date: '2026-10-01', dealer_id: IDS.dealerA1, distributor_id: IDS.distributorA, document_checklist: {} });
    await db.table('loans').insert({ bank: 'SBI', status: 'approved', application_date: '2026-10-01', dealer_id: IDS.dealerA1, distributor_id: IDS.distributorA, document_checklist: {} });
    await db.table('subsidy_claims').insert({ status: 'not_ready', cohort: 'legacy', claim_deadline: '2026-11-05', dealer_id: IDS.dealerA1, distributor_id: IDS.distributorA, cfa_computed: 78000, state_share: 0, bank_proof_ok: false, photos_ok: false, inspection_ok: false, e_token: null });
    await db.table('subsidy_claims').insert({ status: 'released', cohort: 'current', dealer_id: IDS.dealerA1, distributor_id: IDS.distributorA, cfa_computed: 78000, state_share: 0, bank_proof_ok: true, photos_ok: true, inspection_ok: true, e_token: 'T' });
    await ticket(env, 'admin', { serial: p.serials[0], type: 'rma', issue: 'No output' });
    env.setNow(new Date('2026-11-20T05:00:00Z'));
    const r = await env.as('dsm').get(`${API}/post-sale/board`);
    expect(r.status).toBe(200);
    const b = r.body.data;
    expect(b.installations).toMatchObject({ total: 1, open: 1, overdue: 1, by_status: { certified: 1 } });
    expect(b.discom).toMatchObject({ total: 2, open: 2, overdue: 2, feasibility_overdue: 1, commissioning_overdue: 1, by_status: { awaiting_inspection: 1, feasibility_pending: 1 } });
    expect(b.loans).toMatchObject({ total: 2, open: 2, overdue: 1, over_threshold: 1, by_status: { applied: 1, approved: 1 } });
    expect(b.subsidy).toMatchObject({ total: 2, open: 1, overdue: 1, legacy_at_risk: 1, by_status: { not_ready: 1, released: 1 } });
    expect(b.warranty).toMatchObject({ total: 1, open: 1, overdue: 1, rma_overdue: 1, by_status: { open: 1 } });
    // external users only see their own party's numbers
    const other = await env.as(IDS.dealerUserB).get(`${API}/post-sale/board`);
    expect(other.body.data.installations.total).toBe(0);
    expect(other.body.data.loans.total).toBe(0);
  });
});
