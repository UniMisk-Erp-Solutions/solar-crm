import { daysBetween, entityPath, type SkuPrice, type StockBatchRow, type StockExposureDashboard, type StockSkuRow } from '@solar/shared';
import { forbidden } from '../../http/errors';
import { KpiBuilder, type Family, type KpiDetail } from './common';
import { ruleRef } from './cfa';
import type { KpiScope } from './scope';
import { ratioPct, round, sum } from './stats';

export const EXEMPTION_FALLBACK = '2026-12-31';
const EXEMPTION_RULE = 'almm.list2.exemption_net_metering_open_access_until';

/** Price in force on `on` for a SKU (latest valid_from within validity), or null. */
function priceOn(prices: SkuPrice[] | undefined, on: string): number | null {
  if (!prices) return null;
  const p = prices.filter((x) => x.valid_from <= on && (!x.valid_to || x.valid_to >= on)).sort((a, b) => b.valid_from.localeCompare(a.valid_from))[0];
  return p ? p.base_price : null;
}

/** Non-List-II module stock ahead of the ALMM List-II exemption end date. Internal roles only (stock is not party-scoped). */
export async function computeStockExposure(scope: KpiScope): Promise<Family<Pick<StockExposureDashboard, 'exemption' | 'totals' | 'by_sku' | 'by_batch'>>> {
  if (scope.external) throw forbidden('Stock exposure is available to internal users only');
  const { ctx, filters: f } = scope;
  const kb = await KpiBuilder.create(ctx, 'stock-exposure');
  const alertDays = (await ctx.svc.rules.value<number>('reporting.stock_exposure_alert_days', undefined, 90)) ?? 90;

  const rule = await ruleRef(ctx, EXEMPTION_RULE, EXEMPTION_FALLBACK);
  const date = typeof rule.value === 'string' ? rule.value.slice(0, 10) : EXEMPTION_FALLBACK;
  const daysLeft = daysBetween(f.today, date);

  const modules = await scope.reference('skus', { category: 'module' });
  const skuById = new Map(modules.map((s) => [s.id, s]));
  const serials = (await scope.reference('inventory_serials', { status: ['in_stock', 'reserved'] })).filter((s) => skuById.has(s.sku_id) && s.compliance_snapshot?.almm_list2 === false);
  const inStock = serials.filter((s) => s.status === 'in_stock');
  const reserved = serials.length - inStock.length;

  const batches = new Map((await scope.reference('stock_batches')).map((b) => [b.id, b]));
  const prices = new Map<string, SkuPrice[]>();
  for (const p of await scope.reference('sku_prices')) { const a = prices.get(p.sku_id) ?? []; a.push(p); prices.set(p.sku_id, a); }

  interface Agg { units: number; value: number; unpriced: number }
  const bySku = new Map<string, Agg>();
  const byBatch = new Map<string, Agg & { sku_id: string; batch_id: string | null }>();
  for (const s of inStock) {
    const batch = s.batch_id ? batches.get(s.batch_id) : undefined;
    const unit = batch?.unit_cost ?? priceOn(prices.get(s.sku_id), f.today);
    const v = unit ?? 0;
    const a = bySku.get(s.sku_id) ?? { units: 0, value: 0, unpriced: 0 };
    a.units++; a.value += v; if (unit === null) a.unpriced++;
    bySku.set(s.sku_id, a);
    const bk = `${s.batch_id ?? 'none'}|${s.sku_id}`;
    const b = byBatch.get(bk) ?? { units: 0, value: 0, unpriced: 0, sku_id: s.sku_id, batch_id: s.batch_id };
    b.units++; b.value += v; if (unit === null) b.unpriced++;
    byBatch.set(bk, b);
  }
  const totalUnits = inStock.length;
  const totalValue = sum([...bySku.values()].map((a) => a.value));
  const unpriced = sum([...bySku.values()].map((a) => a.unpriced));

  const skuLabel = (id: string): string => { const s = skuById.get(id); return s ? `${s.make} ${s.model}${s.variant ? ` ${s.variant}` : ''}` : 'Unknown SKU'; };
  const by_sku: StockSkuRow[] = [...bySku].map(([id, a]) => {
    const s = skuById.get(id)!;
    return { sku_id: id, make: s.make, model: s.model, variant: s.variant, wattage: s.wattage, units: a.units, value: round(a.value, 2), unpriced_units: a.unpriced, pct_of_value: ratioPct(a.value, totalValue), path: entityPath('sku', id) };
  }).sort((a, b) => b.value - a.value || b.units - a.units);
  const by_batch: StockBatchRow[] = [...byBatch.values()].map((a) => {
    const b = a.batch_id ? batches.get(a.batch_id) : undefined;
    return { batch_id: a.batch_id, batch_no: b?.batch_no ?? 'No batch', sku_id: a.sku_id, sku_label: skuLabel(a.sku_id), received_at: b?.received_at ?? null, supplier: b?.supplier ?? null, origin: b?.origin ?? null, units: a.units, unit_cost: b?.unit_cost ?? null, value: round(a.value, 2), unpriced_units: a.unpriced };
  }).sort((a, b) => b.value - a.value || b.units - a.units);

  const urgency: StockExposureDashboard['exemption']['urgency'] = totalUnits === 0 ? 'none' : daysLeft < 0 ? 'passed' : daysLeft <= 30 ? 'critical' : daysLeft <= alertDays ? 'watch' : 'none';
  const exemption = { date, days_left: daysLeft, urgency, rule };

  const advisory = !rule.active || rule.status !== 'verified' ? 'Rule is advisory — verify the exemption date against the MNRE ALMM notification' : undefined;
  const kpis = [
    kb.make('non_list2_stock_value', {
      value: round(totalValue, 2), secondary: { label: 'Units', value: totalUnits, unit: 'count' },
      breakdown: by_sku.slice(0, 10).map((s) => ({ key: s.sku_id, label: `${s.make} ${s.model}`, value: s.value, units: s.units })),
      note: unpriced ? `${unpriced} unit(s) have no cost or price on file and are valued at ₹ 0` : undefined,
      links: [{ label: 'SKU catalogue', path: '/catalogue' }],
    }),
    kb.make('non_list2_stock_units', {
      value: totalUnits, secondary: { label: 'Reserved (not counted)', value: reserved, unit: 'count' },
      breakdown: by_batch.slice(0, 10).map((b) => ({ key: b.batch_id ?? 'none', label: `${b.batch_no} — ${b.sku_label}`, value: b.units, amount: b.value })),
    }),
    kb.make('list2_exemption_days_left', { value: daysLeft, note: `Exemption ends ${date}${advisory ? `. ${advisory}` : ''}` }),
  ];

  const details: Record<string, KpiDetail> = {
    non_list2_stock_value: {
      title: 'Non-List-II module stock by SKU',
      columns: [{ key: 'make', label: 'Make', type: 'text' }, { key: 'model', label: 'Model', type: 'text' }, { key: 'wattage', label: 'Wp', type: 'int' }, { key: 'units', label: 'Units', type: 'int' }, { key: 'value', label: 'Value (₹)', type: 'inr' }, { key: 'unpriced', label: 'Unpriced units', type: 'int' }, { key: 'pct', label: '% of value', type: 'pct' }],
      rows: by_sku.map((s) => ({ make: s.make, model: s.model + (s.variant ? ` ${s.variant}` : ''), wattage: s.wattage, units: s.units, value: s.value, unpriced: s.unpriced_units, pct: s.pct_of_value })),
    },
    non_list2_stock_units: {
      title: 'Non-List-II module stock by batch',
      columns: [{ key: 'batch', label: 'Batch', type: 'text' }, { key: 'sku', label: 'SKU', type: 'text' }, { key: 'received', label: 'Received', type: 'date' }, { key: 'supplier', label: 'Supplier', type: 'text' }, { key: 'origin', label: 'Origin', type: 'text' }, { key: 'units', label: 'Units', type: 'int' }, { key: 'unit_cost', label: 'Unit cost (₹)', type: 'inr' }, { key: 'value', label: 'Value (₹)', type: 'inr' }],
      rows: by_batch.map((b) => ({ batch: b.batch_no, sku: b.sku_label, received: b.received_at, supplier: b.supplier, origin: b.origin, units: b.units, unit_cost: b.unit_cost, value: b.value })),
    },
  };
  return {
    kpis, details,
    extra: { exemption, totals: { units: totalUnits, value: round(totalValue, 2), unpriced_units: unpriced, reserved_units: reserved, skus: by_sku.length, batches: by_batch.length }, by_sku, by_batch },
  };
}
