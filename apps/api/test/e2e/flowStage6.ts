/** After dispatch (diagram section 7, P1-P5): serial dispatch + compliance, installation, DISCOM commissioning clock, subsidy, loan, warranty, SOP tracker, channel scorecard, deemed feasibility, quote expiry. */
import { describe, expect, it } from 'vitest';
import type { Dispatch, InventorySerial } from '@solar/shared';
import { covers } from './flowCoverage';
import { API, D, MINUTE, S, data, env, goto, notificationsOf } from './flowKit';
import { failure } from './flowHarness';

interface Finding { gate: string; severity: string; message: string; fieldRefs: string[]; overridden?: boolean }
interface DSerial { serial_id: string; serial: string; sku_id: string; batch_no: string | null; status: string; compliance: { compliant: boolean; applicable: boolean; missing: string[] }; invoice_chain: { from: string; to: string; invoice_no: string }[] }
interface DDetail extends Dispatch { so_no: string; serials: DSerial[]; hard_stops: Finding[]; override: { approved: boolean; pending: boolean; approval_ids: string[] }; einvoice: { status: string; irn: string | null } | null; lines: { so_line_id: string; serial_tracked: boolean; qty_ordered: number; qty_dispatched: number }[] }
interface SoLines { id: string; status: string; lines: { id: string; qty: number; serial_tracked: boolean; description: string; sku_id: string | null }[] }

const dsp = (who: 'dispatch' | 'accounts' | 'dealer_user' = 'dispatch') => env.as(who);
const GOOD_COMPLIANCE_KEYS = ['almm_list1', 'almm_list1_ref', 'almm_list1_valid_till', 'almm_snapshot_date', 'cell_maker', 'almm_list2', 'dcr_verified', 'cell_origin', 'bis_licence_no', 'bis_licensed_model', 'bis_standard_no', 'bis_valid_till', 'inverter_kw', 'self_certified', 'thin_film'] as const;

async function setDcr(verified: boolean): Promise<void> {
  const cur = data<Record<string, unknown>>(await env.as('compliance_officer').get(`${API}/skus/${D.sku.m1Dcr}/compliance`));
  const body = Object.fromEntries(GOOD_COMPLIANCE_KEYS.map((k) => [k, cur[k] ?? null]));
  body['dcr_verified'] = verified;
  body['almm_snapshot_date'] = new Date(env.now().getTime() + 330 * MINUTE).toISOString().slice(0, 10);
  data(await env.as('compliance_officer').put(`${API}/skus/${D.sku.m1Dcr}/compliance`).send(body));
}

export function stage6(): void {
  describe('Q/Expired · quote lifecycle: Sent → Expired → Draft', () => {
    it('Q/Expired: a sent quote whose validity date has passed is expired by the nightly job and can be renewed as a new draft', async () => {
      goto('2026-11-07', '10:00');
      const before = await env.db.table('quotations').getOrThrow(S.govQuoteId);
      expect(before.status).toBe('sent');
      expect(before.validity_date < '2026-11-20').toBe(true);
      expect(data<{ status: string }>(await env.as('admin').post(`${API}/admin/jobs/quotes.expire/run`).send({})).status).toBe('ok');
      expect((await env.db.table('quotations').getOrThrow(S.govQuoteId)).status).toBe('expired');
      const renewed = data<{ version: number; status: string; parent_quote_id: string }>(await env.as('techno_commercial').post(`${API}/quotes/${S.govQuoteId}/revise`).send({ reprice: true }), 201);
      expect(renewed).toMatchObject({ version: 2, status: 'draft', parent_quote_id: S.govQuoteId });
      covers('Q/Expired', 'Sent → Expired when the validity date passed (job quotes.expire); Expired → Draft by revise (renew)', 'system');
    });

  });

  describe('P1 · serial dispatch (diagram 7): reserve by batch, C dispatch compliance check, fail → replace the serial, pass → note, invoice chain, e-way bill', () => {
    it('stock that was received while the DCR certificate had lapsed carries a non-compliant serial snapshot (oldest batch, so FIFO picks it first)', async () => {
      goto('2026-11-09', '08:00');
      await setDcr(false);
      const recv = data<{ batch: { id: string }; serials: number; compliance_snapshot: { dcr_verified: boolean } | null }>(await dsp().post(`${API}/stock-batches`).send({
        sku_id: D.sku.m1Dcr, batch_no: 'DS600D-2026-LATE', received_at: '2026-08-01', qty: 6, supplier: 'DemoSolar Manufacturing (Demo)', origin: 'domestic', unit_cost: 13800, location: 'Ahmedabad warehouse',
        serials: ['FLOW-BAD-0001', 'FLOW-BAD-0002', 'FLOW-BAD-0003', 'FLOW-BAD-0004', 'FLOW-BAD-0005', 'FLOW-BAD-0006'],
      }), 201);
      expect(recv.serials).toBe(6);
      expect(recv.compliance_snapshot?.dcr_verified).toBe(false);
      S.badBatchId = recv.batch.id;
      await setDcr(true); // the certificate is renewed: new stock is fine, the old serials keep the snapshot taken at receipt
      const bad = await env.db.table('inventory_serials').all({ batch_id: S.badBatchId });
      expect(bad.every((s) => s.compliance_snapshot && (s.compliance_snapshot as { dcr_verified: boolean }).dcr_verified === false)).toBe(true);
    });

    it('7/B: dispatch planning reserves serials FIFO by batch against the SO lines; 7/C/fail: the evaluation finds the non-DCR serials a HARD STOP and the dispatch is refused', async () => {
      const so = data<SoLines>(await dsp().get(`${API}/sales-orders/${S.soId}`));
      const mod = so.lines.find((l) => l.serial_tracked && l.qty === 5)!;
      const inv = so.lines.find((l) => l.serial_tracked && l.qty === 1)!;
      failure(await env.as('accounts').post(`${API}/dispatches`).send({ so_id: S.soId, lines: [{ so_line_id: mod.id, qty: 5 }] }), 403);
      const d = data<DDetail>(await dsp().post(`${API}/dispatches`).send({ so_id: S.soId, planned_at: '2026-11-09T14:00:00+05:30', vehicle_no: 'GJ01AB1234', transporter: 'Safe Express Logistics', lines: [{ so_line_id: mod.id, qty: 5 }, { so_line_id: inv.id, qty: 1 }] }), 201);
      S.dispatchId = d.id;
      expect(d.dispatch_no).toMatch(/^FS\/DSP\/26\/\d{4}$/);
      expect(d.serials).toHaveLength(6);
      const modules = d.serials.filter((s) => s.sku_id === D.sku.m1Dcr);
      expect(modules.every((s) => s.batch_no === 'DS600D-2026-LATE')).toBe(true); // FIFO: the oldest batch first
      expect((await env.db.table('inventory_serials').all({ dispatch_id: d.id })).every((s) => s.status === 'reserved' && s.sales_order_id === S.soId)).toBe(true);
      covers('7/B', 'serials reserved FIFO by batch received_at (oldest batch first), status reserved, linked to the SO line, quote and dispatch; accounts role gets 403', 'dispatch');

      const ev = data<DDetail>(await dsp().post(`${API}/dispatches/${d.id}/evaluate`).send({}));
      expect(ev.status).toBe('blocked');
      expect(ev.compliance_status).toBe('blocked');
      expect(ev.hard_stops.filter((f) => f.gate === 'G2')).toHaveLength(6); // one summary finding (carries the rule id) + one per serial
      expect(ev.hard_stops.some((f) => (f as Finding & { ruleIds?: string[] }).ruleIds?.length)).toBe(true);
      expect(ev.hard_stops.every((f) => f.fieldRefs.some((r) => r.startsWith('serial:')))).toBe(true);
      const refused = failure(await dsp().post(`${API}/dispatches/${d.id}/dispatch`).send({}), 422, 'COMPLIANCE_BLOCKED');
      expect(JSON.stringify(refused.details)).toContain('G2');
      expect((await env.db.table('dispatches').getOrThrow(d.id)).status).not.toBe('dispatched');
      S.badSerialIds = JSON.stringify(ev.serials.filter((x) => !x.compliance.compliant && x.compliance.applicable).map((x) => x.serial_id));
      covers('7/C/fail-replace', 'dispatch evaluation: five non-DCR module serials → G2 hard stops with serial refs, dispatch status blocked, POST /dispatch → 422 COMPLIANCE_BLOCKED and nothing shipped (next test swaps them)', 'dispatch');
    });

    it('7/C/fail-replace: the bad serials are swapped for compliant stock of the same product; re-evaluation passes and the truck can go', async () => {
      const bad = JSON.parse(S.badSerialIds) as string[];
      expect(bad).toHaveLength(5);
      const good = data<(InventorySerial & { batch_no: string })[]>(await dsp().get(`${API}/serials?sku_id=${D.sku.m1Dcr}&status=in_stock&limit=50`)).filter((s) => s.batch_id !== S.badBatchId);
      expect(good.length).toBeGreaterThanOrEqual(5);
      const swap = good.slice(0, 5).map((g, i) => ({ old_serial_id: bad[i]!, new_serial_id: g.id }));
      const swapped = data<DDetail>(await dsp().post(`${API}/dispatches/${S.dispatchId}/serials`).send({ replace: swap }));
      expect(swapped.status).toBe('planned'); // evaluation reset
      const ev = data<DDetail>(await dsp().post(`${API}/dispatches/${S.dispatchId}/evaluate`).send({}));
      expect(ev).toMatchObject({ status: 'ready' });
      expect(ev.hard_stops).toEqual([]);
      expect((await env.db.table('inventory_serials').all({ batch_id: S.badBatchId })).every((s) => s.status === 'in_stock')).toBe(true); // the rejected serials went back to stock
      covers('7/C/pass', 'after the swap the serial snapshots are DCR / List-I / List-II compliant → ready; rejected serials returned to stock', 'dispatch');
    });

    it('7/C/pass: dispatch writes the brand → distributor → dealer → site invoice chain and e-way bill / e-invoice status; manual entry fills the numbers', async () => {
      const out = data<DDetail>(await dsp().post(`${API}/dispatches/${S.dispatchId}/dispatch`).send({ vehicle_no: 'GJ01AB1234', transporter: 'Safe Express Logistics' }));
      expect(out.status).toBe('dispatched');
      expect(out.invoice_no).toMatch(/^FS\/INV\/26\/\d{4}$/);
      const chain = out.serials[0]!.invoice_chain;
      expect(chain.map((l) => `${l.from.split(' ')[0]}>${l.to.split(' ')[0]}`)[0]).toBe('Future>Sunrise');
      expect(chain.length).toBeGreaterThanOrEqual(3);
      expect(out.einvoice?.status).toBe('manual_pending'); // mock provider: never stored as a real IRN
      expect(out.einvoice?.irn ?? null).toBeNull();
      expect(out.serials.every((s) => s.status === 'dispatched')).toBe(true);
      expect((await env.db.table('sales_orders').getOrThrow(S.soId)).status).toBe('dispatched');
      expect((await notificationsOf(D.profile.accounts, 'dispatch.einvoice_manual')).length).toBeGreaterThan(0);
      const manual = data<DDetail>(await dsp('accounts').patch(`${API}/dispatches/${S.dispatchId}/einvoice`).send({ irn: 'a7c1e5f0b2d94c38a1e6f7b3c9d20e4a8b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e', ack_no: '112026001234', ack_date: '2026-11-09', ewb_no: 281026100234 }));
      expect(manual.ewb_status).toBe('generated');
      expect(manual.ewb_no).toBe('281026100234');
      const note = data<{ document_id: string; url: string }>(await dsp().get(`${API}/dispatches/${S.dispatchId}/note`));
      expect((await env.db.table('documents').getOrThrow(note.document_id)).doc_type).toBe('dispatch_note');
      S.dispatchSerials = JSON.stringify(out.serials.map((s) => ({ id: s.serial_id, serial: s.serial, sku: s.sku_id })));
      covers('P1', 'serial-number dispatch: FIFO reservation, per-serial compliance evaluation, dispatch, invoice chain and e-way bill status, dispatch note PDF', 'dispatch');
    });
  });
}

