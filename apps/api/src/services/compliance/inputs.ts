/** Assembles an EvalInput for a saved quote, an ad-hoc preview, or a sales order / dispatch. Gate code never loads the entity itself. */
import { istDateString, type CompliancePreviewInput, type InventorySerial, type Quotation, type SerialSnapshot, type Site, type Sku, type SkuCompliance, type SkuPrice } from '@solar/shared';
import type { AppContext } from '../../auth/context';
import { notFound } from '../../http/errors';
import { istDate } from './dates';
import { GST_RULE_PATH } from './tax';
import type { EvalInput, EvalLine, EvalSerial } from './types';

const EMPTY_SNAPSHOT: SerialSnapshot = { almm_list1: false, almm_list2: false, dcr_verified: false, bis_ok: false, snapshot_date: null };

async function skuMaps(ctx: AppContext, skuIds: string[]): Promise<{ skus: Map<string, Sku>; comps: Map<string, SkuCompliance> }> {
  const ids = [...new Set(skuIds)];
  if (!ids.length) return { skus: new Map(), comps: new Map() };
  const [skus, comps] = await Promise.all([ctx.db.table('skus').all({ id: ids }), ctx.db.table('sku_compliance').all({ sku_id: ids })]);
  return { skus: new Map(skus.map((s) => [s.id, s])), comps: new Map(comps.map((c) => [c.sku_id, c])) };
}

const base = (ctx: AppContext): Pick<EvalInput, 'today' | 'extraRuleIds'> => ({ today: istDateString(ctx.now()), extraRuleIds: [] });

/* ───────────── saved quote ───────────── */
export interface QuoteEvalContext { input: EvalInput; quote: Quotation; skuIds: string[] }

export async function buildQuoteInput(ctx: AppContext, quoteId: string): Promise<QuoteEvalContext> {
  const quote = await ctx.db.table('quotations').get(quoteId);
  if (!quote) throw notFound('Quotation');
  const lines = await ctx.db.table('quotation_lines').all({ quote_id: quote.id }, { orderBy: { col: 'sort_order' } });
  const skuIds = lines.map((l) => l.sku_id).filter((s): s is string => !!s);
  const { skus, comps } = await skuMaps(ctx, skuIds);
  const priceIds = [...new Set(lines.map((l) => l.price_id).filter((p): p is string => !!p))];
  const prices: SkuPrice[] = priceIds.length ? await ctx.db.table('sku_prices').all({ id: priceIds }) : [];
  const priceById = new Map(prices.map((p) => [p.id, p]));
  const site: Site | null = quote.site_id ? await ctx.db.table('sites').get(quote.site_id) : null;
  const b = base(ctx);

  const evalLines: EvalLine[] = lines.map((l) => ({
    key: l.id, sku: l.sku_id ? skus.get(l.sku_id) ?? null : null, compliance: l.sku_id ? comps.get(l.sku_id) ?? null : null, description: l.description,
    hsn: l.hsn, gst_rate: l.gst_rate, tax_position_approved: l.tax_position_approved, tax_position_by_human: !!l.tax_approved_by,
    price_valid_to: l.price_id ? priceById.get(l.price_id)?.valid_to ?? null : null,
  }));

  // free text that could carry an Aadhaar number: quote fields, line descriptions, clause text, discussion notes
  const texts: EvalInput['texts'] = [
    { field: 'payment_terms', text: quote.payment_terms }, { field: 'rejected_reason', text: quote.rejected_reason },
    { field: 'requote_reason', text: quote.requote_reason }, { field: 'place_of_supply', text: quote.place_of_supply },
    ...lines.map((l) => ({ field: `line:${l.id}.description`, text: l.description })),
  ];
  if (quote.clause_keys.length) {
    const clauses = await ctx.db.table('message_templates').all({ key: quote.clause_keys, active: true });
    for (const c of clauses) texts.push({ field: `clause:${c.key}`, text: `${c.subject ?? ''} ${c.body}` });
  }
  for (const d of await ctx.db.table('quote_discussions').all({ quote_id: quote.id })) {
    texts.push({ field: `discussion:${d.id}.notes`, text: d.notes }, { field: `discussion:${d.id}.outcome`, text: d.outcome });
  }
  const docs = await ctx.db.table('documents').all({ entity_type: 'quotation', entity_id: quote.id });

  const cfaIds = (quote.cfa_breakdown && typeof quote.cfa_breakdown === 'object' && !Array.isArray(quote.cfa_breakdown) && Array.isArray((quote.cfa_breakdown as { ruleIds?: unknown }).ruleIds))
    ? ((quote.cfa_breakdown as { ruleIds: unknown[] }).ruleIds.filter((x): x is string => typeof x === 'string'))
    : [];

  const input: EvalInput = {
    ...b, mode: 'quote', segment: quote.segment, kw: quote.kw, quoteDate: istDate(quote.price_snapshot_at),
    refDate: quote.expected_commissioning_date ?? b.today, commissioningDate: quote.expected_commissioning_date,
    validityDate: quote.validity_date, priceSnapshotAt: quote.price_snapshot_at, exemptionReliance: quote.exemption_reliance,
    lines: evalLines, serials: [], leadId: quote.lead_id, site, dealerId: quote.dealer_id, orderValue: quote.total,
    texts, fileNames: docs.map((d) => ({ field: `document:${d.id}`, name: d.file_name })), extraRuleIds: cfaIds,
  };
  return { input, quote, skuIds };
}

/* ───────────── preview (no quote yet) ───────────── */
export async function buildPreviewInput(ctx: AppContext, p: CompliancePreviewInput): Promise<EvalInput> {
  const { skus, comps } = await skuMaps(ctx, p.sku_ids);
  for (const id of p.sku_ids) if (!skus.has(id)) throw notFound('SKU');
  const b = base(ctx);
  const lines: EvalLine[] = [];
  for (const id of [...new Set(p.sku_ids)]) {
    const sku = skus.get(id)!;
    const path = GST_RULE_PATH[sku.category];
    const rate = path ? await ctx.svc.rules.value<number>(path, b.today, null) : null;
    lines.push({
      key: sku.id, sku, compliance: comps.get(sku.id) ?? null, description: [sku.make, sku.model, sku.variant].filter(Boolean).join(' '), hsn: sku.hsn,
      gst_rate: typeof rate === 'number' ? rate : null, tax_position_approved: false, tax_position_by_human: false, price_valid_to: null,
    });
  }
  const site = p.site_id ? await ctx.db.table('sites').get(p.site_id) : null;
  return {
    ...b, mode: 'preview', segment: p.segment, kw: p.kw, quoteDate: b.today, refDate: p.expected_commissioning_date ?? b.today,
    commissioningDate: p.expected_commissioning_date ?? null, validityDate: p.validity_date ?? null, priceSnapshotAt: null, exemptionReliance: p.exemption_reliance,
    lines, serials: [], leadId: p.lead_id ?? null, site, dealerId: p.dealer_id ?? null, orderValue: 0,
    texts: (p.free_text ?? []).map((t, i) => ({ field: `free_text[${i}]`, text: t })), fileNames: [],
  };
}

/* ───────────── sales order / dispatch ───────────── */
export interface DispatchEvalContext { input: EvalInput; entityIds: string[] }

export async function buildDispatchInput(ctx: AppContext, soId: string, opts: { dispatchId?: string; serialIds?: string[] } = {}): Promise<DispatchEvalContext> {
  const so = await ctx.db.table('sales_orders').get(soId);
  if (!so) throw notFound('Sales order');
  const quote = so.quote_id ? await ctx.db.table('quotations').get(so.quote_id) : null;
  const siteId = so.site_id ?? quote?.site_id ?? null;
  const site = siteId ? await ctx.db.table('sites').get(siteId) : null;

  let rows: InventorySerial[];
  if (opts.serialIds?.length) rows = await ctx.db.table('inventory_serials').all({ id: opts.serialIds });
  else if (opts.dispatchId) {
    const links = await ctx.db.table('dispatch_serials').all({ dispatch_id: opts.dispatchId });
    rows = links.length ? await ctx.db.table('inventory_serials').all({ id: links.map((l) => l.serial_id) }) : [];
  } else rows = await ctx.db.table('inventory_serials').all({ sales_order_id: so.id, status: ['reserved', 'dispatched'] });

  const { skus, comps } = await skuMaps(ctx, rows.map((r) => r.sku_id));
  const serials: EvalSerial[] = rows.map((r) => ({
    id: r.id, serial: r.serial, sku: skus.get(r.sku_id) ?? null, compliance: comps.get(r.sku_id) ?? null,
    snapshot: { ...EMPTY_SNAPSHOT, ...(r.compliance_snapshot ?? {}) },
  }));

  const dispatch = opts.dispatchId ? await ctx.db.table('dispatches').get(opts.dispatchId) : null;
  const entityIds = [so.id, ...(opts.dispatchId ? [opts.dispatchId] : [])];
  const docs = await ctx.db.table('documents').all({ entity_type: ['sales_order', 'dispatch'], entity_id: entityIds });
  const b = base(ctx);
  const input: EvalInput = {
    ...b, mode: 'dispatch', segment: so.segment, kw: quote?.kw ?? 0, quoteDate: quote ? istDate(quote.created_at) : b.today,
    refDate: so.expected_commissioning_date ?? quote?.expected_commissioning_date ?? b.today, commissioningDate: so.expected_commissioning_date ?? quote?.expected_commissioning_date ?? null,
    validityDate: null, priceSnapshotAt: null, exemptionReliance: quote?.exemption_reliance ?? false, lines: [], serials,
    leadId: null, site, dealerId: so.dealer_id, orderValue: so.total,
    texts: [{ field: 'customer_po_no', text: so.customer_po_no }, { field: 'hold_reason', text: so.hold_reason }, { field: 'vehicle_no', text: dispatch?.vehicle_no }, { field: 'transporter', text: dispatch?.transporter }],
    fileNames: docs.map((d) => ({ field: `document:${d.id}`, name: d.file_name })),
  };
  return { input, entityIds };
}
