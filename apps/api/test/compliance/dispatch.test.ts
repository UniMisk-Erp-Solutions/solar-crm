/** evaluateDispatch: serial-level gates from each serial's compliance snapshot, G11 and G14, overrides. */
import { describe, expect, it } from 'vitest';
import type { InventorySerial, SalesOrder, SerialSnapshot, Segment } from '@solar/shared';
import { FAKE_AADHAAR, IDS, addSku, gate, makeWorld, real, type World } from '../quotes/helpers';

const OK: SerialSnapshot = { almm_list1: true, almm_list2: true, dcr_verified: true, bis_ok: true, snapshot_date: '2026-10-25' };

async function orderWith(w: World, snapshots: Partial<SerialSnapshot>[], so: { segment?: Segment; commissioning?: string | null; po?: string | null; sku?: Awaited<ReturnType<typeof addSku>> } = {}) {
  const ctx = w.c();
  const sku = so.sku ?? (await addSku(w));
  const order = await ctx.db.table('sales_orders').insert({
    so_no: 'FS/SO/26/0001', pi_id: IDS.org, quote_id: IDS.org, segment: so.segment ?? 'pmsg_residential', status: 'approved', dealer_id: IDS.dealerA1, distributor_id: IDS.distributorA,
    expected_commissioning_date: so.commissioning === undefined ? '2026-12-01' : so.commissioning, customer_po_no: so.po ?? null, total: 300000, order_date: '2026-10-26', advance_received: 0,
  } as Partial<SalesOrder>);
  const serials: InventorySerial[] = [];
  for (const [i, s] of snapshots.entries()) {
    serials.push(await ctx.db.table('inventory_serials').insert({
      serial: `SN-${i + 1}`, sku_id: sku.id, batch_id: null, status: 'reserved', sales_order_id: order.id, compliance_snapshot: { ...OK, ...s }, invoice_chain: [],
    } as Partial<InventorySerial>));
  }
  return { order, serials, sku };
}
const run = (w: World, soId: string, opts: { dispatchId?: string; serialIds?: string[]; persist?: boolean } = {}) => w.c().svc.compliance.evaluateDispatch(soId, opts);

describe('evaluateDispatch', () => {
  it('passes clean serials', async () => {
    const w = await makeWorld();
    const { order } = await orderWith(w, [{}, {}]);
    const r = await run(w, order.id);
    expect(r.hasHardStop).toBe(false);
    expect(r.status).toBe('clear');
  });

  it('hard-stops a PMSG dispatch on a non-DCR, non-List-I, non-List-II or non-BIS serial and names the serials', async () => {
    const w = await makeWorld();
    const { order } = await orderWith(w, [{ dcr_verified: false }, { almm_list1: false }, { almm_list2: false }, { bis_ok: false }, {}]);
    const r = await run(w, order.id);
    expect(r.hasHardStop).toBe(true);
    expect(r.status).toBe('blocked');
    const byGate = (g: string) => real(r, g)[0]!;
    expect(byGate('G2')).toMatchObject({ severity: 'hard_stop', fieldRefs: ['serial:SN-1'] });
    expect(byGate('G3').fieldRefs).toEqual(['serial:SN-2']);
    expect(byGate('G4').fieldRefs).toEqual(['serial:SN-3']);
    expect(byGate('G6').fieldRefs).toEqual(['serial:SN-4']);
    expect(byGate('G2').ruleIds.length).toBe(1);
  });

  it('follows Appendix A: captive needs no List-II (G4 warning at most); List-II not needed before its date', async () => {
    const cap = await makeWorld({ segment: 'ci_captive', kw: 100 });
    const c = await orderWith(cap, [{ almm_list1: false, almm_list2: false, dcr_verified: false }], { segment: 'ci_captive' });
    const rc = await run(cap, c.order.id);
    expect(rc.hasHardStop).toBe(false);
    expect(real(rc, 'G3')[0]!.severity).toBe('warning');
    expect(real(rc, 'G2')).toHaveLength(0);

    const early = await makeWorld();
    const e = await orderWith(early, [{ almm_list2: false }], { commissioning: '2026-05-01' });
    expect(real(await run(early, e.order.id), 'G4')).toHaveLength(0);
  });

  it('evaluates only the serials of a dispatch / the given serial ids', async () => {
    const w = await makeWorld();
    const { order, serials } = await orderWith(w, [{ dcr_verified: false }, {}]);
    expect((await run(w, order.id, { serialIds: [serials[1]!.id] })).hasHardStop).toBe(false);
    expect((await run(w, order.id, { serialIds: [serials[0]!.id] })).hasHardStop).toBe(true);
    const dispatch = await w.c().db.table('dispatches').insert({ dispatch_no: 'FS/DN/26/0001', so_id: order.id, status: 'planned', compliance_status: 'pending', compliance_findings: [], ewb_status: 'not_required', invoice_chain: [] } as never);
    await w.c().db.table('dispatch_serials').insert({ dispatch_id: dispatch.id, serial_id: serials[0]!.id, so_line_id: null });
    expect((await run(w, order.id, { dispatchId: dispatch.id })).hasHardStop).toBe(true);
    // persist is opt-in: the dispatch service sets compliance_status itself
    expect((await w.c().db.table('dispatches').getOrThrow(dispatch.id)).compliance_status).toBe('pending');
    await run(w, order.id, { dispatchId: dispatch.id, persist: true });
    expect((await w.c().db.table('dispatches').getOrThrow(dispatch.id)).compliance_status).toBe('blocked');
  });

  it('a stale ALMM snapshot is a warning (G10) unless the register was re-confirmed', async () => {
    const w = await makeWorld();
    const stale = await addSku(w, { compliance: { almm_snapshot_date: '2026-09-01' } });
    const { order } = await orderWith(w, [{ snapshot_date: '2026-09-01' }], { sku: stale });
    expect(real(await run(w, order.id), 'G10')[0]).toMatchObject({ severity: 'warning' });
    const fresh = await addSku(w);
    const f = await orderWith(w, [{ snapshot_date: '2026-09-01' }], { sku: fresh });
    expect(real(await run(w, f.order.id), 'G10')).toHaveLength(0);
  });

  it('G11: a deactivated dealer hard-stops a dispatch; being over the limit is a warning (the sales order guard owns it)', async () => {
    const w = await makeWorld();
    const { order } = await orderWith(w, [{}]);
    await w.c().db.table('dealer_receivables').insert({ dealer_id: IDS.dealerA1, distributor_id: IDS.distributorA, doc_ref: 'INV-9', amount: 2_000_000, paid_amount: 0, invoice_date: '2026-09-01', due_date: '2026-10-01', subsidy_linked: false, status: 'open' });
    const over = await run(w, order.id);
    expect(real(over, 'G11')[0]!.severity).toBe('warning');
    expect(over.hasHardStop).toBe(false);
    await w.c().db.table('dealers').update(IDS.dealerA1, { portal_status: 'deactivated' });
    expect(real(await run(w, order.id), 'G11').some((f) => f.severity === 'hard_stop')).toBe(true);
  });

  it('G14: an Aadhaar number in the PO reference is a hard stop', async () => {
    const w = await makeWorld();
    const { order } = await orderWith(w, [{}], { po: `PO ${FAKE_AADHAAR}` });
    expect(real(await run(w, order.id), 'G14')[0]).toMatchObject({ severity: 'hard_stop' });
  });

  it('an approved dispatch override (opened by the dispatch module) marks the hard stops overridden', async () => {
    const w = await makeWorld();
    const { order } = await orderWith(w, [{ dcr_verified: false }]);
    const dispatch = await w.c().db.table('dispatches').insert({ dispatch_no: 'FS/DN/26/0002', so_id: order.id, status: 'planned', compliance_status: 'pending', compliance_findings: [], ewb_status: 'not_required', invoice_chain: [] } as never);
    const approval = await w.c().db.table('approvals').insert({
      entity_type: 'compliance_override', entity_id: dispatch.id, lane: 'compliance', step: 1, required_role: 'compliance_officer', approver_id: null, decision: 'pending', comment: null, decided_at: null,
      due_at: null, requested_by: null, requested_at: w.env.now().toISOString(), meta: { round: 1, dispatch_id: dispatch.id, so_id: order.id, reason: 'Customer accepts non-DCR modules' },
    } as never);
    expect((await run(w, order.id, { dispatchId: dispatch.id, serialIds: undefined })).hasHardStop).toBe(false); // no serials linked to the dispatch yet → nothing to stop
    const serial = (await w.c().db.table('inventory_serials').all({ sales_order_id: order.id }))[0]!;
    expect((await run(w, order.id, { dispatchId: dispatch.id, serialIds: [serial.id] })).hasHardStop).toBe(true);
    const res = await w.env.as('compliance_officer').post(`/api/v1/approvals/${approval.id}/decide`).send({ decision: 'approved', comment: 'Customer waiver on file' });
    expect(res.status).toBe(200);
    const after = await run(w, order.id, { dispatchId: dispatch.id, serialIds: [serial.id] });
    expect(after.hasHardStop).toBe(false);
    expect(gate(after, 'G2')[0]).toMatchObject({ severity: 'hard_stop', overridden: true });
  });
});
