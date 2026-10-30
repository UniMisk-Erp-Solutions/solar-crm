/** Catalogue: SKUs, compliance register, price snapshots, stock batches and serials. */
import { Router } from 'express';
import {
  recommendQuerySchema, serialListQuerySchema, serialsAddSchema, skuComplianceSchema, skuCreateSchema, skuListQuerySchema, skuPriceCreateSchema, skuPriceListQuerySchema,
  skuUpdateSchema, stockBatchCreateSchema, stockBatchListQuerySchema, type InventorySerial,
} from '@solar/shared';
import { ALL_ROLES, INTERNAL_ONLY, allow } from '../auth/authorize';
import { runList } from '../http/crud';
import { body, handle, param, query, respondPage, wrap } from '../http/handler';
import { createPrice, createSku, getCompliance, getSkuDetail, hydrateSkus, listSkus, publicPrice, putCompliance, recommendSkus, updateSku } from '../services/skuService';
import { addSerials, hydrateBatches, receiveBatch, stockExposure } from '../services/stockService';

const router = Router();

const CATALOGUE_WRITE = ['techno_commercial', 'compliance_officer', 'management'] as const;
const REGISTER_WRITE = ['compliance_officer', 'techno_commercial'] as const;
const PRICE_WRITE = ['management', 'techno_commercial', 'accounts'] as const;
const STOCK_WRITE = ['dispatch', 'techno_commercial', 'management', 'accounts'] as const;

/* ───────────── SKUs ───────────── */
router.get('/skus', allow(...ALL_ROLES), wrap(async (req, res) => {
  const ctx = req.ctx!;
  const q = query(skuListQuerySchema, req);
  const { rows, total } = await listSkus(ctx, q);
  respondPage(res, rows, total, q.limit, q.offset);
}));

// step 16 — validated SKUs only, each with USP fields and a per-gate pass / fail summary for the segment
router.get('/skus/recommend', allow(...ALL_ROLES), handle((ctx, req) => recommendSkus(ctx, query(recommendQuerySchema, req))));

router.get('/skus/:id', allow(...ALL_ROLES), handle((ctx, req) => getSkuDetail(ctx, param(req, 'id'))));
router.post('/skus', allow(...CATALOGUE_WRITE), handle(async (ctx, req, res) => {
  const row = await createSku(ctx, body(skuCreateSchema, req));
  res.status(201).json({ data: (await hydrateSkus(ctx, [row]))[0] });
}));
router.patch('/skus/:id', allow(...CATALOGUE_WRITE), handle(async (ctx, req) => {
  const row = await updateSku(ctx, param(req, 'id'), body(skuUpdateSchema, req));
  return (await hydrateSkus(ctx, [row]))[0];
}));

router.get('/skus/:id/compliance', allow(...ALL_ROLES), handle((ctx, req) => getCompliance(ctx, param(req, 'id'))));
router.put('/skus/:id/compliance', allow(...REGISTER_WRITE), handle((ctx, req) => putCompliance(ctx, param(req, 'id'), body(skuComplianceSchema, req))));

/* ───────────── price snapshots (landed cost and floor price are internal) ───────────── */
router.get('/prices', allow(...INTERNAL_ONLY), wrap(async (req, res) => {
  const ctx = req.ctx!;
  const q = query(skuPriceListQuerySchema, req);
  const today = ctx.now().toISOString().slice(0, 10);
  const where: Record<string, unknown> = {};
  if (q.sku_id) where['sku_id'] = q.sku_id;
  const { rows, total } = await ctx.db.table('sku_prices').list({ where: where as never, orderBy: [{ col: 'valid_from', dir: 'desc' }], limit: q.limit, offset: q.offset });
  const active = q.active === undefined ? rows : rows.filter((p) => (p.valid_from <= today && (!p.valid_to || p.valid_to >= today)) === q.active);
  respondPage(res, active.map((p) => publicPrice(ctx, p)), q.active === undefined ? total : active.length, q.limit, q.offset);
}));
router.post('/prices', allow(...PRICE_WRITE), handle(async (ctx, req, res) => {
  res.status(201).json({ data: await createPrice(ctx, body(skuPriceCreateSchema, req)) });
}));

/* ───────────── stock batches ───────────── */
router.get('/stock-batches', allow(...INTERNAL_ONLY), wrap(async (req, res) => {
  const ctx = req.ctx!;
  query(stockBatchListQuerySchema, req);
  const page = await runList(ctx, req, { table: 'stock_batches', filterCols: ['sku_id', 'origin'], searchCols: ['batch_no', 'supplier'], defaultSort: { col: 'received_at', dir: 'desc' }, unscoped: true });
  respondPage(res, await hydrateBatches(ctx, page.rows as never), page.total, page.limit, page.offset);
}));
router.post('/stock-batches', allow(...STOCK_WRITE), handle(async (ctx, req, res) => {
  res.status(201).json({ data: await receiveBatch(ctx, body(stockBatchCreateSchema, req)) });
}));

/* ───────────── serials ───────────── */
router.get('/serials/exposure', allow(...INTERNAL_ONLY), handle((ctx) => stockExposure(ctx)));
router.get('/serials', allow(...INTERNAL_ONLY), wrap(async (req, res) => {
  const ctx = req.ctx!;
  query(serialListQuerySchema, req);
  const page = await runList<InventorySerial>(ctx, req, { table: 'inventory_serials', filterCols: ['status', 'sku_id', 'batch_id', 'sales_order_id'], searchCols: ['serial'], defaultSort: { col: 'created_at', dir: 'desc' }, unscoped: true });
  const skuIds = [...new Set(page.rows.map((r) => r.sku_id))];
  const batchIds = [...new Set(page.rows.map((r) => r.batch_id).filter((b): b is string => !!b))];
  const skus = new Map((skuIds.length ? await ctx.db.table('skus').all({ id: skuIds }) : []).map((s) => [s.id, s]));
  const batches = new Map((batchIds.length ? await ctx.db.table('stock_batches').all({ id: batchIds }) : []).map((b) => [b.id, b]));
  respondPage(res, page.rows.map((r) => ({
    ...r, sku_label: skus.get(r.sku_id) ? `${skus.get(r.sku_id)!.make} ${skus.get(r.sku_id)!.model}` : null, sku_category: skus.get(r.sku_id)?.category ?? null,
    batch_no: r.batch_id ? batches.get(r.batch_id)?.batch_no ?? null : null, received_at: r.batch_id ? batches.get(r.batch_id)?.received_at ?? null : null,
  })), page.total, page.limit, page.offset);
}));
router.post('/serials', allow(...STOCK_WRITE), handle(async (ctx, req, res) => {
  const input = body(serialsAddSchema, req);
  res.status(201).json({ data: await addSerials(ctx, input.batch_id, input.serials) });
}));

export default router;
