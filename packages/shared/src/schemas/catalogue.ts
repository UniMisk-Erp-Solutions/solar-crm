// Zod schemas for the catalogue area: SKUs, compliance register, price snapshots, stock batches, serials and the live compliance preview.
import { z } from 'zod';
import { GATES, SEGMENTS, SERIAL_STATUSES, SKU_CATEGORIES } from '../enums';
import { isoDateSchema, listQuerySchema, safeText, uuidSchema } from '../validators';

const reqText = (max: number) => safeText(max).refine((v) => v.length > 0, { message: 'This field is required' });
const optText = (max: number) => safeText(max).nullable().optional();
/** `?flag=true|false` query-string boolean. */
const queryBool = z.enum(['true', 'false']).transform((v) => v === 'true');

export const brandUspSchema = z.object({
  quality: safeText(500),
  warranty: safeText(500),
  certifications: safeText(500),
  service_support: safeText(500),
  delivery_reliability: safeText(500),
});
export type BrandUspInput = z.infer<typeof brandUspSchema>;

export const skuCreateSchema = z.object({
  category: z.enum(SKU_CATEGORIES),
  make: reqText(80),
  model: reqText(120),
  variant: optText(120),
  wattage: z.number().positive().max(100000).nullable().optional(),
  hsn: z.string().trim().regex(/^\d{4,8}$/, 'HSN must be 4 to 8 digits').nullable().optional(),
  uom: z.string().trim().min(1).max(20).default('nos'),
  active: z.boolean().default(true),
  demo: z.boolean().default(false),
  description: optText(1000),
  warranty_years: z.number().min(0).max(50).nullable().optional(),
  brand_usp: brandUspSchema.nullable().optional(),
});
export type SkuCreateInput = z.infer<typeof skuCreateSchema>;
export const skuUpdateSchema = skuCreateSchema.partial();
export type SkuUpdateInput = z.infer<typeof skuUpdateSchema>;

export const skuListQuerySchema = listQuerySchema.extend({
  category: z.enum(SKU_CATEGORIES).optional(),
  active: queryBool.optional(),
  demo: queryBool.optional(),
  /** only SKUs whose ALMM snapshot is older than compliance.almm_snapshot_max_age_days (or missing) */
  stale_snapshot: queryBool.optional(),
});

/** Compliance register entry. `almm_snapshot_date` is mandatory — it is the date the ALMM listing was last checked against the MNRE list. */
export const skuComplianceSchema = z.object({
  almm_list1: z.boolean(),
  almm_list1_ref: optText(200),
  almm_list1_valid_till: isoDateSchema.nullable().optional(),
  almm_snapshot_date: isoDateSchema,
  cell_maker: optText(120),
  almm_list2: z.boolean(),
  dcr_verified: z.boolean(),
  cell_origin: optText(120),
  bis_licence_no: optText(100),
  bis_licensed_model: optText(120),
  bis_standard_no: optText(60),
  bis_valid_till: isoDateSchema.nullable().optional(),
  inverter_kw: z.number().positive().max(100000).nullable().optional(),
  self_certified: z.boolean().default(false),
  thin_film: z.boolean().default(false),
});
export type SkuComplianceInput = z.infer<typeof skuComplianceSchema>;

export const landedCostSchema = z.record(z.string().min(1).max(40), z.number().min(0));

export const skuPriceCreateSchema = z.object({
  sku_id: uuidSchema,
  base_price: z.number().min(0),
  valid_from: isoDateSchema,
  valid_to: isoDateSchema.nullable().optional(),
  /** per-unit cost build-up in rupees (bcd, aidc, sws, adc, freight, and any other component). The SUM is the landed cost used for margin. */
  landed_cost: landedCostSchema.default({}),
  floor_price: z.number().min(0).nullable().optional(),
  source: optText(200),
  snapshot_label: optText(100),
});
export type SkuPriceCreateInput = z.infer<typeof skuPriceCreateSchema>;
export const skuPriceListQuerySchema = listQuerySchema.extend({ sku_id: uuidSchema.optional(), active: queryBool.optional() });

const serialNo = z.string().trim().min(3).max(60).regex(/^[A-Za-z0-9._\-/]+$/, 'Serial numbers may contain letters, digits and . _ - /');

export const stockBatchCreateSchema = z.object({
  sku_id: uuidSchema,
  batch_no: z.string().trim().min(1).max(60),
  received_at: isoDateSchema,
  qty: z.number().int().positive().max(1_000_000),
  supplier: optText(120),
  origin: z.enum(['import', 'domestic']).default('domestic'),
  boe_no: optText(60),
  unit_cost: z.number().min(0).nullable().optional(),
  location: optText(80),
  /** optional serial numbers received in this batch; when given their count must not exceed qty */
  serials: z.array(serialNo).max(5000).optional(),
});
export type StockBatchCreateInput = z.infer<typeof stockBatchCreateSchema>;
export const stockBatchListQuerySchema = listQuerySchema.extend({ sku_id: uuidSchema.optional(), origin: z.enum(['import', 'domestic']).optional() });

export const serialsAddSchema = z.object({ batch_id: uuidSchema, serials: z.array(serialNo).min(1).max(5000) });
export const serialListQuerySchema = listQuerySchema.extend({
  status: z.enum(SERIAL_STATUSES).optional(),
  sku_id: uuidSchema.optional(),
  batch_id: uuidSchema.optional(),
  sales_order_id: uuidSchema.optional(),
});

export const recommendQuerySchema = z.object({
  segment: z.enum(SEGMENTS),
  kw: z.coerce.number().positive().max(100000),
  commissioning: isoDateSchema.optional(),
  category: z.enum(SKU_CATEGORIES).optional(),
  /** hide SKUs that would hit a hard stop for this segment */
  compliant_only: queryBool.optional(),
});

export type RecommendQuery = z.infer<typeof recommendQuerySchema>;

/** Live gate results without a quote — product-recommendation screen and quote builder. */
export const compliancePreviewSchema = z.object({
  segment: z.enum(SEGMENTS),
  kw: z.number().positive().max(100000),
  expected_commissioning_date: isoDateSchema.nullable().optional(),
  exemption_reliance: z.boolean().default(false),
  sku_ids: z.array(uuidSchema).max(50).default([]),
  dealer_id: uuidSchema.nullable().optional(),
  lead_id: uuidSchema.nullable().optional(),
  site_id: uuidSchema.nullable().optional(),
  validity_date: isoDateSchema.nullable().optional(),
  /** any typed free text on the form, scanned by gate G14 */
  free_text: z.array(z.string().max(4000)).max(50).optional(),
});
export type CompliancePreviewInput = z.infer<typeof compliancePreviewSchema>;

/** Compliance-lane override request (written reason is mandatory). */
export const complianceOverrideRequestSchema = z.object({
  entity_type: z.enum(['quotation', 'dispatch', 'sales_order']),
  entity_id: uuidSchema,
  gates: z.array(z.enum(GATES)).min(1).max(14),
  reason: safeText(1000).refine((v) => v.length >= 10, { message: 'Give a written reason (at least 10 characters)' }),
});
export type ComplianceOverrideRequestInput = z.infer<typeof complianceOverrideRequestSchema>;
