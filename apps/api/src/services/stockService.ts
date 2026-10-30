/** Stock receipt: batches and serial numbers. Each serial copies the SKU's compliance snapshot at the moment of receipt. */
import { istDateString, type InventorySerial, type Json, type SerialSnapshot, type Sku, type SkuCompliance, type StockBatch, type StockBatchCreateInput } from '@solar/shared';
import type { AppContext } from '../auth/context';
import { conflict, notFound } from '../http/errors';
import { audit } from '../lib/audit';
import { diffDays } from './compliance/dates';

const norm = (s: string | null | undefined): string => (s ?? '').toLowerCase().replace(/[\s_-]+/g, '');

/** The SKU's ALMM / DCR / BIS position on the receipt date, frozen onto the serial. */
export function complianceSnapshot(sku: Sku, comp: SkuCompliance | null, receivedAt: string): SerialSnapshot {
  if (!comp) return { almm_list1: false, almm_list2: false, dcr_verified: false, bis_ok: false, snapshot_date: null };
  const bisOk = !!comp.bis_licence_no && !!comp.bis_valid_till && comp.bis_valid_till >= receivedAt && norm(comp.bis_licensed_model) === norm(sku.model);
  return {
    almm_list1: comp.almm_list1 && (!comp.almm_list1_valid_till || comp.almm_list1_valid_till >= receivedAt),
    almm_list2: comp.almm_list2, dcr_verified: comp.dcr_verified, bis_ok: bisOk, snapshot_date: comp.almm_snapshot_date,
  };
}

async function assertSerialsFree(ctx: AppContext, serials: string[]): Promise<void> {
  const unique = new Set(serials);
  if (unique.size !== serials.length) {
    const dup = serials.filter((s, i) => serials.indexOf(s) !== i);
    throw conflict('The same serial number appears more than once in this request', { serials: [...new Set(dup)].slice(0, 20) });
  }
  const existing = await ctx.db.table('inventory_serials').all({ serial: serials });
  if (existing.length) throw conflict('Some serial numbers are already in stock', { serials: existing.map((e) => e.serial).slice(0, 20) });
}

async function insertSerials(ctx: AppContext, sku: Sku, batch: StockBatch, serials: string[]): Promise<{ rows: InventorySerial[]; snapshot: SerialSnapshot }> {
  const comp = await ctx.db.table('sku_compliance').one({ sku_id: sku.id });
  const snapshot = complianceSnapshot(sku, comp, batch.received_at);
  const rows = await ctx.db.table('inventory_serials').insertMany(serials.map((serial) => ({
    serial, sku_id: sku.id, batch_id: batch.id, status: 'in_stock' as const, quote_id: null, sales_order_id: null, sales_order_line_id: null, dispatch_id: null, site_id: null,
    compliance_snapshot: snapshot, invoice_chain: [], installed_at: null, created_by: ctx.user.id,
  })));
  return { rows, snapshot };
}

export async function receiveBatch(ctx: AppContext, input: StockBatchCreateInput) {
  const sku = await ctx.db.table('skus').get(input.sku_id);
  if (!sku) throw notFound('SKU');
  const serials = input.serials ?? [];
  if (serials.length > input.qty) throw conflict(`${serials.length} serial numbers were given for a quantity of ${input.qty}`);
  const dupBatch = await ctx.db.table('stock_batches').one({ sku_id: input.sku_id, batch_no: input.batch_no });
  if (dupBatch) throw conflict('This batch number is already recorded for the SKU', { id: dupBatch.id });
  if (serials.length) await assertSerialsFree(ctx, serials);

  const batch = await ctx.db.table('stock_batches').insert({
    sku_id: input.sku_id, batch_no: input.batch_no, received_at: input.received_at, qty: input.qty, supplier: input.supplier ?? null, origin: input.origin,
    boe_no: input.boe_no ?? null, unit_cost: input.unit_cost ?? null, location: input.location ?? null, created_by: ctx.user.id,
  });
  await audit(ctx, { action: 'stock.receive', table: 'stock_batches', record_id: batch.id, new: batch as unknown as Json });
  const { rows, snapshot } = serials.length ? await insertSerials(ctx, sku, batch, serials) : { rows: [], snapshot: null };
  const comp = await ctx.db.table('sku_compliance').one({ sku_id: sku.id });
  const warnings: string[] = [];
  if (!comp) warnings.push('This SKU has no compliance register entry — the serials were received with ALMM / DCR / BIS marked as not verified.');
  else if (snapshot && !snapshot.almm_list2) warnings.push('The cells in this batch are not on ALMM List-II — the stock is exposed ahead of the List-II dates.');
  return { batch, serials: rows.length, serials_pending: input.qty - rows.length, compliance_snapshot: snapshot, warnings };
}

export async function addSerials(ctx: AppContext, batchId: string, serials: string[]) {
  const batch = await ctx.db.table('stock_batches').get(batchId);
  if (!batch) throw notFound('Stock batch');
  const sku = await ctx.db.table('skus').getOrThrow(batch.sku_id);
  const have = await ctx.db.table('inventory_serials').count({ batch_id: batchId });
  if (have + serials.length > batch.qty) throw conflict(`This batch holds ${batch.qty} units and already has ${have} serials — ${batch.qty - have} left`);
  await assertSerialsFree(ctx, serials);
  const { rows, snapshot } = await insertSerials(ctx, sku, batch, serials);
  await audit(ctx, { action: 'stock.serials_added', table: 'stock_batches', record_id: batchId, detail: { count: rows.length } });
  return { added: rows.length, compliance_snapshot: snapshot, serials: rows };
}

export async function hydrateBatches(ctx: AppContext, batches: StockBatch[]) {
  if (!batches.length) return [];
  const skus = new Map((await ctx.db.table('skus').all({ id: [...new Set(batches.map((b) => b.sku_id))] })).map((s) => [s.id, s]));
  const serials = await ctx.db.table('inventory_serials').all({ batch_id: batches.map((b) => b.id) });
  return batches.map((b) => {
    const mine = serials.filter((s) => s.batch_id === b.id);
    const sku = skus.get(b.sku_id);
    return {
      ...b, sku: sku ? { id: sku.id, make: sku.make, model: sku.model, variant: sku.variant, category: sku.category } : null,
      serial_count: mine.length, in_stock: mine.filter((s) => s.status === 'in_stock').length, serials_pending: Math.max(0, b.qty - mine.length),
    };
  });
}

/** Non-List-II stock exposure ahead of the exemption date (value uses the batch unit cost). */
export async function stockExposure(ctx: AppContext) {
  const today = istDateString(ctx.now());
  const serials = await ctx.db.table('inventory_serials').all({ status: 'in_stock' });
  const skuIds = [...new Set(serials.map((s) => s.sku_id))];
  const batchIds = [...new Set(serials.map((s) => s.batch_id).filter((b): b is string => !!b))];
  const skus = new Map((skuIds.length ? await ctx.db.table('skus').all({ id: skuIds }) : []).map((s) => [s.id, s]));
  const batches = new Map((batchIds.length ? await ctx.db.table('stock_batches').all({ id: batchIds }) : []).map((b) => [b.id, b]));
  const until = await ctx.svc.rules.path('almm.list2.exemption_net_metering_open_access_until');
  const untilDate = until && typeof until.value === 'string' ? until.value.slice(0, 10) : null;

  const bySku = new Map<string, { sku_id: string; make: string; model: string; units: number; value: number; non_list2_units: number; non_list2_value: number }>();
  for (const s of serials) {
    const sku = skus.get(s.sku_id);
    const cost = (s.batch_id ? batches.get(s.batch_id)?.unit_cost : null) ?? 0;
    const e = bySku.get(s.sku_id) ?? { sku_id: s.sku_id, make: sku?.make ?? '', model: sku?.model ?? '', units: 0, value: 0, non_list2_units: 0, non_list2_value: 0 };
    e.units += 1; e.value += cost;
    if (!s.compliance_snapshot.almm_list2) { e.non_list2_units += 1; e.non_list2_value += cost; }
    bySku.set(s.sku_id, e);
  }
  const rows = [...bySku.values()];
  return {
    as_of: today, exemption_until: untilDate, days_left: untilDate ? diffDays(today, untilDate) : null, exemption_rule_status: until?.status ?? null,
    total_units: rows.reduce((a, r) => a + r.units, 0), total_value: rows.reduce((a, r) => a + r.value, 0),
    non_list2_units: rows.reduce((a, r) => a + r.non_list2_units, 0), non_list2_value: rows.reduce((a, r) => a + r.non_list2_value, 0), by_sku: rows,
  };
}
