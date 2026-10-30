import { describe, expect, it } from 'vitest';
import type { SerialSnapshot } from '@solar/shared';
import { IDS } from '../helpers/env';
import { evaluateSerial } from '../../src/services/dispatchService';
import { SNAP_OK, decide, fakes, orderEnv, readyForDispatch, seedStock, seedWorld, type Fakes, type World } from './fixtures';

type Env = ReturnType<typeof orderEnv>['env'];
type SoView = { lines: { id: string; sku_id: string }[] };

/** a world with stock, an SO handed over to dispatch planning, and handy line ids */
async function setup(opts: { segment?: Parameters<typeof seedWorld>[1] extends infer O ? (O extends { segment?: infer S } ? S : never) : never; snap?: Partial<SerialSnapshot>; f?: Fakes; stockOpts?: boolean } = {}) {
  const f = opts.f ?? fakes();
  const { env } = orderEnv(f);
  const residential = opts.segment === 'pmsg_residential';
  const w: World = await seedWorld(env, residential ? { segment: 'pmsg_residential', customerType: 'residential', gstin: null } : { segment: opts.segment });
  const stock = await seedStock(env, w, opts.snap);
  const rd = await readyForDispatch(env, w, 150000, residential ? { gst_unregistered: true } : {});
  const so = rd.so as unknown as SoView;
  const line = { module: so.lines[0]!.id, inverter: so.lines[1]!.id, structure: so.lines[2]!.id };
  return { env, f, w, stock, rd, line, dispatcher: env.as('dispatch') };
}

const plan = (env: Env, soId: string, lines: unknown[], extra: Record<string, unknown> = {}) =>
  env.as('dispatch').post('/api/v1/dispatches').send({ so_id: soId, planned_at: '2026-10-28', lines, ...extra });

describe('serial-number reservation', () => {
  it('reserves FIFO by batch: the older batch is used up before the newer one', async () => {
    const { env, rd, line, stock } = await setup();
    const r = await plan(env, rd.soId, [{ so_line_id: line.module, qty: 8 }, { so_line_id: line.inverter, qty: 1 }]);
    expect(r.status).toBe(201);
    const d = r.body.data;
    expect(d.dispatch_no).toMatch(/^FS\/DSP\/26\/\d{4}$/);
    expect(d).toMatchObject({ status: 'planned', compliance_status: 'pending', so_no: rd.so.so_no });
    const modules = d.serials.filter((s: { category: string }) => s.category === 'module');
    expect(modules).toHaveLength(8);
    expect(modules.map((s: { serial: string }) => s.serial)).toEqual(['JAN-001', 'JAN-002', 'JAN-003', 'JAN-004', 'JAN-005', 'JAN-006', 'MAR-001', 'MAR-002']);
    expect(modules.filter((s: { batch_no: string }) => s.batch_no === 'B-JAN')).toHaveLength(6);
    expect(d.lines.find((l: { so_line_id: string }) => l.so_line_id === line.module)).toMatchObject({ qty_ordered: 10, qty_in_this_dispatch: 8, serial_tracked: true });
    expect(d.lines.find((l: { so_line_id: string }) => l.so_line_id === line.structure)).toMatchObject({ serial_tracked: false, qty_in_this_dispatch: 0 });

    const row = await env.ctx('admin').db.table('inventory_serials').get(stock.serials['JAN-001']!.id);
    expect(row).toMatchObject({ status: 'reserved', sales_order_id: rd.soId, sales_order_line_id: line.module, dispatch_id: d.id, quote_id: expect.any(String) });
    expect((await env.ctx('admin').db.table('inventory_serials').get(stock.serials['MAR-003']!.id))?.status).toBe('in_stock');

    // second dispatch continues FIFO from where the first stopped; the line cannot be over-planned
    const second = await plan(env, rd.soId, [{ so_line_id: line.module, qty: 2 }]);
    expect(second.body.data.serials.map((s: { serial: string }) => s.serial)).toEqual(['MAR-003', 'MAR-004']);
    const over = await plan(env, rd.soId, [{ so_line_id: line.module, qty: 1 }]);
    expect(over.status).toBe(400);
    expect(over.body.error.details).toMatchObject({ requested: 1, remaining: 0 });
  });

  it('accepts explicit serial ids and refuses ones that are not in stock or are another product', async () => {
    const { env, rd, line, stock } = await setup();
    const pick = ['MAR-006', 'JAN-003'].map((k) => stock.serials[k]!.id);
    const ok = await plan(env, rd.soId, [{ so_line_id: line.module, serial_ids: pick }]);
    expect(ok.status).toBe(201);
    expect(ok.body.data.serials.map((s: { serial: string }) => s.serial)).toEqual(['JAN-003', 'MAR-006']);
    expect((await plan(env, rd.soId, [{ so_line_id: line.module, serial_ids: [stock.serials['JAN-003']!.id] }])).status).toBe(400); // already reserved
    expect((await plan(env, rd.soId, [{ so_line_id: line.module, serial_ids: [stock.serials['INV-1']!.id] }])).status).toBe(400); // wrong product
    expect((await plan(env, rd.soId, [{ so_line_id: line.structure, qty: 1 }])).status).toBe(400); // bulk item is not serial-tracked
  });

  it('fails cleanly when stock is short — nothing is reserved and no dispatch is left behind', async () => {
    const { env, rd, line, stock } = await setup();
    const db = env.ctx('admin').db;
    for (const [label, s] of Object.entries(stock.serials)) if (label.startsWith('MAR-') && label !== 'MAR-001') await db.table('inventory_serials').update(s.id, { status: 'installed' });
    // 6 JAN + 1 MAR left in stock = 7 < 8
    const r = await plan(env, rd.soId, [{ so_line_id: line.module, qty: 8 }]);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(r.body.error.details).toMatchObject({ requested: 8, in_stock: 7 });
    expect(await db.table('dispatches').count()).toBe(0);
    expect(await db.table('inventory_serials').count({ status: 'reserved' })).toBe(0);
  });

  it('cancelling a planned dispatch unreserves its serials', async () => {
    const { env, rd, line, stock } = await setup();
    const d = (await plan(env, rd.soId, [{ so_line_id: line.module, qty: 3 }])).body.data;
    expect(await env.ctx('admin').db.table('inventory_serials').count({ status: 'reserved' })).toBe(3);
    const c = await env.as('dispatch').post(`/api/v1/dispatches/${d.id}/cancel`).send({ note: 'Truck unavailable' });
    expect(c.status).toBe(200);
    expect(c.body.data.status).toBe('cancelled');
    const s = await env.ctx('admin').db.table('inventory_serials').get(stock.serials['JAN-001']!.id);
    expect(s).toMatchObject({ status: 'in_stock', sales_order_id: null, sales_order_line_id: null, dispatch_id: null });
    expect(await env.ctx('admin').db.table('dispatch_serials').count({ dispatch_id: d.id })).toBe(0);
    expect((await env.as('dispatch').post(`/api/v1/dispatches/${d.id}/cancel`).send({})).status).toBe(409);
    // the freed quantity can be planned again
    expect((await plan(env, rd.soId, [{ so_line_id: line.module, qty: 10 }])).status).toBe(201);
  });

  it('cancelling the sales order releases every open dispatch', async () => {
    const { env, rd, line } = await setup();
    await plan(env, rd.soId, [{ so_line_id: line.module, qty: 4 }]);
    const r = await env.as('management').post(`/api/v1/sales-orders/${rd.soId}/cancel`).send({ note: 'Lost' });
    expect(r.status).toBe(200);
    expect(await env.ctx('admin').db.table('inventory_serials').count({ status: 'reserved' })).toBe(0);
  });

  it('is only possible after hand-over to dispatch planning, and only for dispatch roles', async () => {
    const f = fakes();
    const { env } = orderEnv(f);
    const w = await seedWorld(env);
    await seedStock(env, w);
    const pi = await (await import('./fixtures')).issuePi(env, w);
    await (await import('./fixtures')).pay(env, pi.id, 150000);
    const so = (await env.as('accounts').post('/api/v1/sales-orders').send({ pi_id: pi.id, customer_po_no: 'PO-1', customer_po_date: '2026-10-25' })).body.data;
    const early = await plan(env, so.id, [{ so_line_id: so.lines[0].id, qty: 1 }]);
    expect(early.status).toBe(409);
    expect((await env.as('dealer_user').post('/api/v1/dispatches').send({ so_id: so.id, lines: [] })).status).toBe(403);
    expect((await env.as('accounts').post('/api/v1/dispatches').send({ so_id: so.id, lines: [] })).status).toBe(403);
  });
});

describe('dispatch compliance guard', () => {
  it('stores the evaluation, blocks the dispatch on a hard stop and leaves everything reserved', async () => {
    const { env, f, rd, line } = await setup();
    f.compliance.hardStop = true;
    const d = (await plan(env, rd.soId, [{ so_line_id: line.module, qty: 2 }, { so_line_id: line.inverter, qty: 1 }])).body.data;
    const ev = await env.as('dispatch').post(`/api/v1/dispatches/${d.id}/evaluate`).send({});
    expect(ev.status).toBe(200);
    expect(ev.body.data).toMatchObject({ status: 'blocked', compliance_status: 'blocked' });
    expect(ev.body.data.hard_stops[0]).toMatchObject({ gate: 'G3', severity: 'hard_stop' });
    expect(f.compliance.calls.at(-1)).toMatchObject({ soId: rd.soId, dispatchId: d.id });
    expect(f.compliance.calls.at(-1)!.serialIds).toHaveLength(3);

    const go = await env.as('dispatch').post(`/api/v1/dispatches/${d.id}/dispatch`).send({ vehicle_no: 'GJ01AB1234' });
    expect(go.status).toBe(422);
    expect(go.body.error.code).toBe('COMPLIANCE_BLOCKED');
    expect(go.body.error.details.findings[0].gate).toBe('G3');
    const admin = env.ctx('admin');
    expect((await admin.db.table('dispatches').get(d.id))?.status).toBe('blocked');
    expect(await admin.db.table('inventory_serials').count({ status: 'dispatched' })).toBe(0);
    expect(await admin.db.table('einvoice_status').count()).toBe(0);
    expect((await admin.db.table('sales_orders').get(rd.soId))?.status).toBe('dispatch_planning');

    // once compliance clears, the same dispatch goes through
    f.compliance.hardStop = false;
    expect((await env.as('dispatch').post(`/api/v1/dispatches/${d.id}/evaluate`).send({})).body.data.status).toBe('ready');
    expect((await env.as('dispatch').post(`/api/v1/dispatches/${d.id}/dispatch`).send({ vehicle_no: 'GJ01AB1234' })).status).toBe(200);
  });

  it('is allowed through with an approved compliance override, and the findings are marked overridden', async () => {
    const { env, f, rd, line } = await setup();
    f.compliance.hardStop = true;
    const d = (await plan(env, rd.soId, [{ so_line_id: line.module, qty: 2 }])).body.data;
    expect((await env.as('dispatch').post(`/api/v1/dispatches/${d.id}/dispatch`).send({})).status).toBe(422);

    const req = await env.as('dispatch').post(`/api/v1/dispatches/${d.id}/compliance-override`).send({ reason: 'Alternate List-I model approved by MNRE letter' });
    expect(req.status).toBe(201);
    expect(req.body.data.override).toMatchObject({ approved: false, pending: true });
    const admin = env.ctx('admin');
    const pending = await admin.db.table('approvals').all({ entity_type: 'compliance_override', entity_id: d.id });
    expect(pending[0]).toMatchObject({ lane: 'compliance', required_role: 'compliance_officer', decision: 'pending' });
    expect((await env.as('dispatch').post(`/api/v1/dispatches/${d.id}/compliance-override`).send({ reason: 'again, please please' })).status).toBe(409);
    expect((await env.as('dispatch').post(`/api/v1/dispatches/${d.id}/dispatch`).send({})).status).toBe(422); // still pending

    await decide(env, 'compliance_override', d.id, 'approved', 'Alternate model confirmed against the MNRE letter'); // real approvals engine
    const go = await env.as('dispatch').post(`/api/v1/dispatches/${d.id}/dispatch`).send({ vehicle_no: 'GJ01AB1234' });
    expect(go.status).toBe(200);
    expect(go.body.data.status).toBe('dispatched');
    expect(go.body.data.compliance_status).toBe('blocked'); // history is kept; the override is what let it go
    expect(go.body.data.compliance_findings[0]).toMatchObject({ gate: 'G3', overridden: true });
    expect(go.body.data.override.approved).toBe(true);
  });

  it('enforces the segment rules per serial even when the rules engine is clear — and a swap fixes it', async () => {
    const { env, rd, line, stock } = await setup({ segment: 'pmsg_residential' });
    const db = env.ctx('admin').db;
    await db.table('inventory_serials').update(stock.serials['JAN-001']!.id, { compliance_snapshot: { ...SNAP_OK, dcr_verified: false } });
    const d = (await plan(env, rd.soId, [{ so_line_id: line.module, qty: 2 }])).body.data;
    const bad = d.serials.find((s: { serial: string }) => s.serial === 'JAN-001');
    expect(bad.compliance).toMatchObject({ compliant: false, applicable: true, missing: ['DCR verification'] });
    expect(d.serials.find((s: { serial: string }) => s.serial === 'JAN-002').compliance.compliant).toBe(true);

    const ev = await env.as('dispatch').post(`/api/v1/dispatches/${d.id}/evaluate`).send({});
    expect(ev.body.data.status).toBe('blocked');
    expect(ev.body.data.hard_stops).toHaveLength(1);
    expect(ev.body.data.hard_stops[0]).toMatchObject({ gate: 'G2', fieldRefs: [`serial:${bad.serial_id}`] });
    expect(ev.body.data.hard_stops[0].message).toContain('JAN-001');
    expect((await env.as('dispatch').post(`/api/v1/dispatches/${d.id}/dispatch`).send({})).status).toBe(422);

    // swap the non-compliant serial for a compliant one
    const sw = await env.as('dispatch').post(`/api/v1/dispatches/${d.id}/serials`).send({ replace: [{ old_serial_id: bad.serial_id, new_serial_id: stock.serials['MAR-006']!.id }] });
    expect(sw.status).toBe(200);
    expect(sw.body.data.status).toBe('planned');
    expect(sw.body.data.serials.map((s: { serial: string }) => s.serial)).toEqual(['JAN-002', 'MAR-006']);
    expect((await db.table('inventory_serials').get(bad.serial_id))?.status).toBe('in_stock');
    expect((await env.as('dispatch').post(`/api/v1/dispatches/${d.id}/evaluate`).send({})).body.data.status).toBe('ready');
    expect((await env.as('dispatch').post(`/api/v1/dispatches/${d.id}/dispatch`).send({ vehicle_no: 'GJ01AB1234' })).status).toBe(200);
  });

  it('supports adding and removing serials on a planned dispatch', async () => {
    const { env, rd, line, stock } = await setup();
    const d = (await plan(env, rd.soId, [{ so_line_id: line.module, qty: 1 }])).body.data;
    const add = await env.as('dispatch').post(`/api/v1/dispatches/${d.id}/serials`).send({ add: [{ serial_id: stock.serials['MAR-001']!.id }] });
    expect(add.body.data.serials.map((s: { serial: string }) => s.serial)).toEqual(['JAN-001', 'MAR-001']);
    expect(add.body.data.serials.find((s: { serial: string }) => s.serial === 'MAR-001').so_line_id).toBe(line.module);
    const rm = await env.as('dispatch').post(`/api/v1/dispatches/${d.id}/serials`).send({ remove: [stock.serials['JAN-001']!.id] });
    expect(rm.body.data.serials.map((s: { serial: string }) => s.serial)).toEqual(['MAR-001']);
    expect((await env.ctx('admin').db.table('inventory_serials').get(stock.serials['JAN-001']!.id))?.status).toBe('in_stock');
    expect((await env.as('dispatch').post(`/api/v1/dispatches/${d.id}/serials`).send({ remove: [stock.serials['JAN-002']!.id] })).status).toBe(400); // not on this dispatch
    expect((await env.as('dispatch').post(`/api/v1/dispatches/${d.id}/serials`).send({})).status).toBe(422);
  });

  it('evaluateSerial applies the Appendix A segment rules to modules only', () => {
    const none: SerialSnapshot = { almm_list1: false, almm_list2: false, dcr_verified: false, bis_ok: false, snapshot_date: null };
    expect(evaluateSerial(none, 'module', 'pmsg_residential', true).missing).toEqual(['DCR verification', 'ALMM List-I listing', 'ALMM List-II (cell) listing']);
    expect(evaluateSerial(none, 'module', 'pmsg_residential', false).missing).toEqual(['DCR verification', 'ALMM List-I listing']);
    expect(evaluateSerial(none, 'module', 'pm_kusum', true).missing).toEqual(['DCR verification', 'ALMM List-I listing']);
    expect(evaluateSerial(none, 'module', 'rwa_ghs', true).missing).toEqual(['ALMM List-I listing', 'ALMM List-II (cell) listing']);
    expect(evaluateSerial(none, 'module', 'ci_net_metered', true).missing).toEqual(['ALMM List-I listing']);
    expect(evaluateSerial(none, 'module', 'ci_captive', true)).toMatchObject({ compliant: true, missing: [] });
    expect(evaluateSerial(none, 'inverter', 'pmsg_residential', true)).toMatchObject({ compliant: true, applicable: false });
    expect(evaluateSerial({ ...none, almm_list1: true, almm_list2: true, dcr_verified: true }, 'module', 'pmsg_residential', true).compliant).toBe(true);
  });

  it('List-II applies from almm.list2.effective_date and only while that rule is active', async () => {
    const { env, rd, line } = await setup({ segment: 'government_bid', snap: { almm_list2: false } });
    const rule = await env.rule('almm.list2.effective_date', '2026-06-01');
    const d = (await plan(env, rd.soId, [{ so_line_id: line.module, qty: 1 }])).body.data;
    expect(d.serials[0].compliance.missing).toEqual(['ALMM List-II (cell) listing']);
    expect((await env.as('dispatch').post(`/api/v1/dispatches/${d.id}/evaluate`).send({})).body.data.hard_stops[0].gate).toBe('G4');
    await env.ctx('admin').db.table('rule_config').update(rule.id, { is_active: false }); // advisory only: must not block
    expect((await env.as('dispatch').get(`/api/v1/dispatches/${d.id}`)).body.data.serials[0].compliance.compliant).toBe(true);
  });
});

describe('dispatch: invoice chain, e-invoice, e-way bill, note', () => {
  it('records the invoice chain on every serial and tracks SO progress (partial then complete)', async () => {
    const { env, rd, line, stock } = await setup();
    const d1 = (await plan(env, rd.soId, [{ so_line_id: line.module, qty: 8 }, { so_line_id: line.inverter, qty: 1 }])).body.data;
    const go = await env.as('dispatch').post(`/api/v1/dispatches/${d1.id}/dispatch`).send({ vehicle_no: 'GJ01AB1234', transporter: 'Shree Roadways', chain_invoices: { dealer: 'ALPHA/INV/881' } });
    expect(go.status).toBe(200);
    const d = go.body.data;
    expect(d).toMatchObject({ status: 'dispatched', vehicle_no: 'GJ01AB1234', transporter: 'Shree Roadways', so_status: 'partially_dispatched' });
    expect(d.invoice_no).toMatch(/^FS\/INV\/26\/\d{4}$/);
    expect(d.dispatched_at).toBe(env.now().toISOString());
    const expected = [
      { from: 'Future Solar', to: 'Alpha Solar Distributors', invoice_no: d.invoice_no, date: '2026-10-26' },
      { from: 'Alpha Solar Distributors', to: 'Sunrise Installers', invoice_no: 'ALPHA/INV/881', date: '2026-10-26' },
      { from: 'Sunrise Installers', to: 'Patel Textiles Pvt Ltd (site)', invoice_no: 'PENDING', date: '2026-10-26' },
    ];
    expect(d.invoice_chain).toEqual(expected);
    const db = env.ctx('admin').db;
    for (const key of ['JAN-001', 'MAR-002', 'INV-1']) {
      const s = await db.table('inventory_serials').get(stock.serials[key]!.id);
      expect(s).toMatchObject({ status: 'dispatched', dispatch_id: d1.id, invoice_chain: expected });
    }
    // SO quantities: serial-tracked lines by serials; the bulk structure kit rides with the first consignment
    const so1 = (await env.as('accounts').get(`/api/v1/sales-orders/${rd.soId}`)).body.data;
    expect(so1.status).toBe('partially_dispatched');
    expect(so1.lines.map((l: { qty_dispatched: number }) => l.qty_dispatched)).toEqual([8, 1, 1]);
    expect(so1.dispatches[0]).toMatchObject({ id: d1.id, serial_count: 9 });

    const d2 = (await plan(env, rd.soId, [{ so_line_id: line.module, qty: 2 }])).body.data;
    expect((await env.as('dispatch').post(`/api/v1/dispatches/${d2.id}/dispatch`).send({})).status).toBe(200);
    const so2 = (await env.as('accounts').get(`/api/v1/sales-orders/${rd.soId}`)).body.data;
    expect(so2.status).toBe('dispatched');
    expect(so2.lines.map((l: { qty_dispatched: number; remaining_qty: number }) => [l.qty_dispatched, l.remaining_qty])).toEqual([[10, 0], [1, 0], [1, 0]]);
    expect((await env.as('dispatch').post(`/api/v1/dispatches/${d1.id}/dispatch`).send({})).status).toBe(409); // already shipped
    expect(d.invoice_no).not.toBe((await env.as('dispatch').get(`/api/v1/dispatches/${d2.id}`)).body.data.invoice_no);

    // downstream invoice numbers can be filled in later and flow to every serial
    const up = await env.as('accounts').patch(`/api/v1/dispatches/${d1.id}/invoice-chain`).send({ dealer_to_site: 'SUNRISE/INV/42' });
    expect(up.body.data.invoice_chain[2].invoice_no).toBe('SUNRISE/INV/42');
    expect((await db.table('inventory_serials').get(stock.serials['JAN-001']!.id))?.invoice_chain[2]?.invoice_no).toBe('SUNRISE/INV/42');
  });

  it('e-invoice and e-way bill from the mock provider are manual_pending; manual entry completes them', async () => {
    const { env, rd, line } = await setup();
    const d1 = (await plan(env, rd.soId, [{ so_line_id: line.module, qty: 2 }])).body.data;
    const go = (await env.as('dispatch').post(`/api/v1/dispatches/${d1.id}/dispatch`).send({ vehicle_no: 'GJ01AB1234' })).body.data;
    expect(go).toMatchObject({ ewb_status: 'manual_pending', ewb_no: null });
    expect(go.einvoice).toMatchObject({ status: 'manual_pending', irn: null, ack_no: null, entity_type: 'dispatch', entity_id: d1.id, provider: 'fake-einvoice' });
    expect(await env.ctx('admin').db.table('notifications').count({ kind: 'dispatch.einvoice_manual' })).toBeGreaterThan(0);

    expect((await env.as('dispatch').patch(`/api/v1/dispatches/${d1.id}/einvoice`).send({ irn: 'short', ack_no: '1', ack_date: '2026-10-27' })).status).toBe(422);
    expect((await env.as('dispatch').patch(`/api/v1/dispatches/${d1.id}/einvoice`).send({ irn: 'a'.repeat(64) })).status).toBe(422); // ack required with IRN
    expect((await env.as('dispatch').patch(`/api/v1/dispatches/${d1.id}/einvoice`).send({ ewb_no: '123' })).status).toBe(422);
    const irn = 'AB12'.repeat(16);
    const ok = await env.as('dispatch').patch(`/api/v1/dispatches/${d1.id}/einvoice`).send({ irn, ack_no: '112010012345678', ack_date: '2026-10-27', ewb_no: 331012345678 }); // a JSON number: see the schema note on the Aadhaar guard
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data).toMatchObject({ ewb_status: 'generated', ewb_no: '331012345678' });
    expect(ok.body.data.einvoice).toMatchObject({ status: 'generated', irn: irn.toLowerCase(), ack_no: '112010012345678', provider: 'manual' });
    expect(await env.ctx('admin').db.table('einvoice_status').count({ entity_id: d1.id })).toBe(1); // updated in place
    expect((await env.as('dealer_user').patch(`/api/v1/dispatches/${d1.id}/einvoice`).send({ ewb_no: 331012345678 })).status).toBe(403);
  });

  it('uses what the provider returns when it can generate, and survives a provider outage', async () => {
    const { env, rd, line } = await setup();
    env.providers.einvoice.generateIrn = async () => ({ status: 'generated', irn: 'c'.repeat(64), ack_no: '99', ack_date: '2026-10-26T06:00:00.000Z' });
    env.providers.ewayBill.generate = async () => ({ status: 'generated', ewb_no: '331099998888' });
    const d1 = (await plan(env, rd.soId, [{ so_line_id: line.module, qty: 1 }])).body.data;
    const ok = (await env.as('dispatch').post(`/api/v1/dispatches/${d1.id}/dispatch`).send({})).body.data;
    expect(ok).toMatchObject({ ewb_status: 'generated', ewb_no: '331099998888' });
    expect(ok.einvoice).toMatchObject({ status: 'generated', irn: 'c'.repeat(64), ack_no: '99' });

    env.providers.einvoice.generateIrn = async () => { throw new Error('GSP timeout'); };
    env.providers.ewayBill.generate = async () => { throw new Error('NIC down'); };
    const d2 = (await plan(env, rd.soId, [{ so_line_id: line.module, qty: 1 }])).body.data;
    const out = await env.as('dispatch').post(`/api/v1/dispatches/${d2.id}/dispatch`).send({});
    expect(out.status).toBe(200); // a provider outage never blocks the truck
    expect(out.body.data).toMatchObject({ ewb_status: 'failed', ewb_no: null });
    expect(out.body.data.einvoice).toMatchObject({ status: 'failed', irn: null });
  });

  it('generates a dispatch note PDF into the invoices bucket and replaces it on regeneration', async () => {
    const { env, rd, line } = await setup();
    const d = (await plan(env, rd.soId, [{ so_line_id: line.module, qty: 2 }, { so_line_id: line.inverter, qty: 1 }])).body.data;
    await env.as('dispatch').post(`/api/v1/dispatches/${d.id}/dispatch`).send({ vehicle_no: 'GJ01AB1234', transporter: 'Shree Roadways' });
    const json = await env.as('dispatch').get(`/api/v1/dispatches/${d.id}/note`);
    expect(json.status).toBe(200);
    expect(json.body.data.url).toContain('/invoices/');
    const db = env.ctx('admin').db;
    const doc = await db.table('documents').get(json.body.data.document_id);
    expect(doc).toMatchObject({ bucket: 'invoices', doc_type: 'dispatch_note', entity_type: 'dispatch', entity_id: d.id, mime: 'application/pdf' });
    expect((await db.table('dispatches').get(d.id))?.dispatch_note_document_id).toBe(doc!.id);
    const bytes = env.providers.files.get(`invoices/${doc!.path}`)!;
    expect(bytes.subarray(0, 4).toString()).toBe('%PDF');
    const again = await env.as('dispatch').get(`/api/v1/dispatches/${d.id}/note`);
    expect(await db.table('documents').count({ entity_id: d.id, doc_type: 'dispatch_note' })).toBe(1);
    expect(again.body.data.document_id).not.toBe(doc!.id);
    expect(env.providers.files.has(`invoices/${doc!.path}`)).toBe(false);
  });

  it('lists dispatches with party scoping', async () => {
    const { env, rd, line } = await setup();
    const d = (await plan(env, rd.soId, [{ so_line_id: line.module, qty: 1 }])).body.data;
    const own = await env.as('dealer_user').get('/api/v1/dispatches');
    expect(own.body.data.map((x: { id: string }) => x.id)).toEqual([d.id]);
    expect(own.body.data[0]).toMatchObject({ so_no: rd.so.so_no, serial_count: 1 });
    expect((await env.as('dealer_user').get(`/api/v1/dispatches/${d.id}`)).status).toBe(200);
    expect((await env.as(IDS.dealerUserB).get('/api/v1/dispatches')).body.data).toEqual([]);
    expect((await env.as(IDS.dealerUserB).get(`/api/v1/dispatches/${d.id}`)).status).toBe(403);
    expect((await env.as('dealer_user').post(`/api/v1/dispatches/${d.id}/dispatch`).send({})).status).toBe(403);
    expect((await env.as('accounts').get('/api/v1/dispatches?status=planned')).body.total).toBe(1);
  });
});
