/** Catalogue: SKUs, the compliance register, price snapshots and the validated-SKU product recommendation. */
import {
  istDateString, isExternalRole, type BrandUsp, type CompliancePreviewInput, type Json, type RecommendQuery, type Sku, type SkuComplianceInput, type SkuCreateInput,
  type SkuCompliance, type SkuPrice, type SkuPriceCreateInput, type SkuUpdateInput,
} from '@solar/shared';
import type { AppContext } from '../auth/context';
import type { Where } from '../db/types';
import { conflict, notFound } from '../http/errors';
import { audit } from '../lib/audit';
import { addDaysStr } from './compliance/dates';
import { runGates } from './compliance/engine';
import { buildPreviewInput } from './compliance/inputs';
import type { GateSummary } from './compliance/types';
import { onSkuComplianceChanged, onSkuPriceChanged } from './requoteService';

/** The price snapshot in force for a SKU on `date` (latest valid_from wins). */
export async function activePriceFor(ctx: AppContext, skuId: string, date: string): Promise<SkuPrice | null> {
  const rows = await ctx.db.table('sku_prices').all({ sku_id: skuId, valid_from: { lte: date } }, { orderBy: { col: 'valid_from', dir: 'desc' } });
  return rows.find((p) => !p.valid_to || p.valid_to >= date) ?? null;
}

/** Hide landed cost and floor price from external (distributor / dealer) users. */
export const publicPrice = (ctx: AppContext, p: SkuPrice | null): SkuPrice | Omit<SkuPrice, 'landed_cost' | 'floor_price'> | null => {
  if (!p) return null;
  if (!isExternalRole(ctx.user.role)) return p;
  const { landed_cost: _l, floor_price: _f, ...rest } = p;
  return rest;
};

export async function snapshotMaxAgeDays(ctx: AppContext): Promise<number> {
  return (await ctx.svc.rules.value<number>('compliance.almm_snapshot_max_age_days', undefined, 7)) ?? 7;
}

export interface SkuView extends Sku { compliance: SkuCompliance | null; price: ReturnType<typeof publicPrice>; snapshot_stale: boolean }

export async function hydrateSkus(ctx: AppContext, skus: Sku[]): Promise<SkuView[]> {
  if (!skus.length) return [];
  const today = istDateString(ctx.now());
  const maxAge = await snapshotMaxAgeDays(ctx);
  const cutoff = addDaysStr(today, -maxAge);
  const comps = await ctx.db.table('sku_compliance').all({ sku_id: skus.map((s) => s.id) });
  const byId = new Map(comps.map((c) => [c.sku_id, c]));
  const out: SkuView[] = [];
  for (const s of skus) {
    const c = byId.get(s.id) ?? null;
    const price = await activePriceFor(ctx, s.id, today);
    out.push({ ...s, compliance: c, price: publicPrice(ctx, price), snapshot_stale: !c || !c.almm_snapshot_date || c.almm_snapshot_date < cutoff });
  }
  return out;
}

export async function listSkus(ctx: AppContext, q: { q?: string; category?: string; active?: boolean; demo?: boolean; stale_snapshot?: boolean; limit: number; offset: number; sort?: string; order: 'asc' | 'desc' }) {
  const where: Where = {};
  if (q.category) where['category'] = q.category;
  if (q.active !== undefined) where['active'] = q.active;
  if (q.demo !== undefined) where['demo'] = q.demo;
  if (q.stale_snapshot) {
    const cutoff = addDaysStr(istDateString(ctx.now()), -(await snapshotMaxAgeDays(ctx)));
    const comps = await ctx.db.table('sku_compliance').all();
    const fresh = comps.filter((c) => c.almm_snapshot_date && c.almm_snapshot_date >= cutoff).map((c) => c.sku_id);
    if (fresh.length) where['id'] = { nin: fresh };
  }
  const sortable = new Set(['make', 'model', 'category', 'created_at', 'updated_at', 'wattage']);
  const { rows, total } = await ctx.db.table('skus').list({
    where, limit: q.limit, offset: q.offset, orderBy: { col: q.sort && sortable.has(q.sort) ? q.sort : 'make', dir: q.sort ? q.order : 'asc' },
    search: q.q ? { cols: ['make', 'model', 'variant', 'hsn', 'description'], text: q.q } : undefined,
  });
  return { rows: await hydrateSkus(ctx, rows), total };
}

export async function getSkuDetail(ctx: AppContext, id: string) {
  const sku = await ctx.db.table('skus').get(id);
  if (!sku) throw notFound('SKU');
  const [view] = await hydrateSkus(ctx, [sku]);
  const prices = await ctx.db.table('sku_prices').all({ sku_id: id }, { orderBy: { col: 'valid_from', dir: 'desc' } });
  const inStock = await ctx.db.table('inventory_serials').count({ sku_id: id, status: 'in_stock' });
  return { ...view!, prices: prices.slice(0, 10).map((p) => publicPrice(ctx, p)), in_stock: inStock };
}

export async function createSku(ctx: AppContext, input: SkuCreateInput): Promise<Sku> {
  const dup = await ctx.db.table('skus').one({ make: input.make, model: input.model, variant: input.variant ?? null });
  if (dup) throw conflict('A SKU with this make, model and variant already exists', { id: dup.id });
  const row = await ctx.db.table('skus').insert({
    category: input.category, make: input.make, model: input.model, variant: input.variant ?? null, wattage: input.wattage ?? null, hsn: input.hsn ?? null, uom: input.uom,
    active: input.active, demo: input.demo, description: input.description ?? null, warranty_years: input.warranty_years ?? null, brand_usp: (input.brand_usp ?? null) as BrandUsp | null, created_by: ctx.user.id,
  });
  await audit(ctx, { action: 'sku.create', table: 'skus', record_id: row.id, new: row as unknown as Json });
  return row;
}

export async function updateSku(ctx: AppContext, id: string, patch: SkuUpdateInput): Promise<Sku> {
  const before = await ctx.db.table('skus').get(id);
  if (!before) throw notFound('SKU');
  const clean: Partial<Sku> = {};
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) (clean as Record<string, unknown>)[k] = v;
  const row = await ctx.db.table('skus').update(id, clean);
  await audit(ctx, { action: 'sku.update', table: 'skus', record_id: id, old: before as unknown as Json, new: row as unknown as Json });
  // a deactivated SKU or a changed HSN affects open quotes
  if (before.active !== row.active || before.hsn !== row.hsn) await onSkuComplianceChanged(ctx, id, row.active ? 'SKU details changed' : 'SKU deactivated');
  return row;
}

/* ───────────── compliance register ───────────── */
const REGISTER_FIELDS = ['almm_list1', 'almm_list1_ref', 'almm_list1_valid_till', 'almm_list2', 'cell_maker', 'dcr_verified', 'cell_origin', 'bis_licence_no', 'bis_licensed_model', 'bis_standard_no', 'bis_valid_till', 'inverter_kw', 'self_certified', 'thin_film'] as const;

export async function getCompliance(ctx: AppContext, skuId: string): Promise<SkuCompliance | null> {
  if (!(await ctx.db.table('skus').get(skuId))) throw notFound('SKU');
  return ctx.db.table('sku_compliance').one({ sku_id: skuId });
}

export async function putCompliance(ctx: AppContext, skuId: string, input: SkuComplianceInput): Promise<SkuCompliance> {
  if (!(await ctx.db.table('skus').get(skuId))) throw notFound('SKU');
  const before = await ctx.db.table('sku_compliance').one({ sku_id: skuId });
  const values = {
    almm_list1: input.almm_list1, almm_list1_ref: input.almm_list1_ref ?? null, almm_list1_valid_till: input.almm_list1_valid_till ?? null, almm_snapshot_date: input.almm_snapshot_date,
    cell_maker: input.cell_maker ?? null, almm_list2: input.almm_list2, dcr_verified: input.dcr_verified, cell_origin: input.cell_origin ?? null,
    bis_licence_no: input.bis_licence_no ?? null, bis_licensed_model: input.bis_licensed_model ?? null, bis_standard_no: input.bis_standard_no ?? null, bis_valid_till: input.bis_valid_till ?? null,
    inverter_kw: input.inverter_kw ?? null, self_certified: input.self_certified, thin_film: input.thin_film,
    verified_by: ctx.user.id, verified_at: ctx.now().toISOString(),
  };
  const row = before
    ? await ctx.db.table('sku_compliance').update(before.id, values)
    : await ctx.db.table('sku_compliance').insert({ sku_id: skuId, ...values, created_by: ctx.user.id });
  await audit(ctx, { action: before ? 'sku.compliance.update' : 'sku.compliance.create', table: 'sku_compliance', record_id: row.id, old: (before ?? null) as unknown as Json, new: row as unknown as Json });
  const changed = !before || REGISTER_FIELDS.some((f) => JSON.stringify(before[f]) !== JSON.stringify(row[f]));
  if (changed) await onSkuComplianceChanged(ctx, skuId, 'ALMM / DCR / BIS register entry changed');
  return row;
}

/* ───────────── price snapshots ───────────── */
export async function createPrice(ctx: AppContext, input: SkuPriceCreateInput): Promise<SkuPrice> {
  const sku = await ctx.db.table('skus').get(input.sku_id);
  if (!sku) throw notFound('SKU');
  if (input.valid_to && input.valid_to < input.valid_from) throw conflict('valid_to cannot be before valid_from');
  const existing = await ctx.db.table('sku_prices').all({ sku_id: input.sku_id }, { orderBy: { col: 'valid_from', dir: 'asc' } });
  if (existing.some((p) => p.valid_from === input.valid_from)) throw conflict('A price snapshot already starts on this date — pick a later valid_from');
  const closeTo = addDaysStr(input.valid_from, -1);
  // close the snapshot this one supersedes …
  for (const p of existing) {
    if (p.valid_from < input.valid_from && (!p.valid_to || p.valid_to >= input.valid_from)) {
      await ctx.db.table('sku_prices').update(p.id, { valid_to: closeTo });
      await audit(ctx, { action: 'price.close', table: 'sku_prices', record_id: p.id, old: { valid_to: p.valid_to }, new: { valid_to: closeTo } });
    }
  }
  // … and end this one the day before a later-dated snapshot starts
  const next = existing.find((p) => p.valid_from > input.valid_from);
  const validTo = input.valid_to ?? (next ? addDaysStr(next.valid_from, -1) : null);
  const row = await ctx.db.table('sku_prices').insert({
    sku_id: input.sku_id, base_price: input.base_price, valid_from: input.valid_from, valid_to: validTo, landed_cost: input.landed_cost, floor_price: input.floor_price ?? null,
    source: input.source ?? null, snapshot_label: input.snapshot_label ?? null, created_by: ctx.user.id,
  });
  await audit(ctx, { action: 'price.create', table: 'sku_prices', record_id: row.id, new: row as unknown as Json });
  await onSkuPriceChanged(ctx, input.sku_id, `New price snapshot ${input.snapshot_label ?? row.valid_from}`);
  return row;
}

/* ───────────── product recommendation (step 16) ───────────── */
export interface RecommendedSku extends SkuView {
  usp: BrandUsp | null; warranty_years: number | null;
  gates: GateSummary[]; has_hard_stop: boolean; compliance_status: 'clear' | 'warnings' | 'blocked';
}
const SKU_GATES = ['G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G9', 'G10'] as const;

export async function recommendSkus(ctx: AppContext, q: RecommendQuery): Promise<RecommendedSku[]> {
  const where: Where = { active: true };
  if (q.category) where['category'] = q.category;
  const skus = await ctx.db.table('skus').all(where, { orderBy: [{ col: 'category' }, { col: 'make' }, { col: 'model' }] });
  const comps = skus.length ? await ctx.db.table('sku_compliance').all({ sku_id: skus.map((s) => s.id) }) : [];
  const withRegister = new Set(comps.map((c) => c.sku_id));
  const candidates = skus.filter((s) => withRegister.has(s.id));
  const views = await hydrateSkus(ctx, candidates);
  const out: RecommendedSku[] = [];
  for (let i = 0; i < views.length; i += 8) {
    const batch = views.slice(i, i + 8);
    const results = await Promise.all(batch.map(async (v) => {
      const params: CompliancePreviewInput = { segment: q.segment, kw: q.kw, expected_commissioning_date: q.commissioning ?? null, exemption_reliance: false, sku_ids: [v.id] };
      const input = await buildPreviewInput(ctx, params);
      const gateSet = [...SKU_GATES];
      return runGates(ctx, input, { gates: gateSet });
    }));
    batch.forEach((v, idx) => {
      const r = results[idx]!;
      out.push({ ...v, usp: v.brand_usp, warranty_years: v.warranty_years, gates: r.gates, has_hard_stop: r.hasHardStop, compliance_status: r.status === 'pending' ? 'clear' : r.status });
    });
  }
  return q.compliant_only ? out.filter((r) => !r.has_hard_stop) : out;
}
