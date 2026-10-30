/**
 * Quote arithmetic: line building (price snapshot, GST from rules at the quote date), totals, margin / floor check,
 * CFA / state / loan / consumer split, default validity, quote numbers and clauses.
 *
 * Money is rupees (plain numbers) rounded to paise. GST rates are NEVER invented: a line gets a rate only from an ACTIVE rule
 * (`gst.<category>_rate` resolved on the quote date) or from an explicit CA-type decision; otherwise it is null and gate G9 warns.
 */
import { istDateString, type FloorCheck, type Json, type Opportunity, type Quotation, type QuotationLine, type QuoteLineInput, type Site, type Sku, type SkuPrice } from '@solar/shared';
import type { AppContext } from '../auth/context';
import { guardBlocked, notFound } from '../http/errors';
import { computeCfa } from './cfa';
import { addDaysStr, istDate, minDateStr } from './compliance/dates';
import { GST_RULE_PATH, requiresTaxApproval } from './compliance/tax';
import { activePriceFor } from './skuService';

export const r2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/* ───────────── quote number ───────────── */
/** `FS/Q/<yy>/<nnnn>` — every version of a quote shares its number; `version` tells them apart. */
export async function nextQuoteNo(ctx: AppContext): Promise<string> {
  const yy = istDateString(ctx.now()).slice(2, 4);
  const prefix = `FS/Q/${yy}/`;
  const rows = await ctx.db.table('quotations').all({ quote_no: { like: `${prefix}%` } });
  const max = rows.reduce((m, r) => Math.max(m, Number(r.quote_no.slice(prefix.length)) || 0), 0);
  return `${prefix}${String(max + 1).padStart(4, '0')}`;
}

/* ───────────── clauses ───────────── */
export async function defaultClauseKeys(ctx: AppContext): Promise<string[]> {
  const templates = await ctx.db.table('message_templates').all({ key: { like: 'clause.%' }, active: true });
  const existing = new Set(templates.map((t) => t.key));
  const configured = await ctx.svc.rules.value<string[]>('quote.default_clauses', undefined, null);
  if (Array.isArray(configured)) return configured.filter((k) => typeof k === 'string' && existing.has(k));
  return [...existing].sort();
}

export async function assertClauseKeys(ctx: AppContext, keys: string[]): Promise<void> {
  if (!keys.length) return;
  const found = new Set((await ctx.db.table('message_templates').all({ key: keys, active: true })).map((t) => t.key));
  const missing = keys.filter((k) => !found.has(k));
  if (missing.length) throw guardBlocked(`Unknown clause template(s): ${missing.join(', ')}`, { missing });
}

/* ───────────── validity ───────────── */
export type ValidityCap = 'validity_days' | 'price_snapshot_age' | 'price_valid_to' | 'exemption_date';

/**
 * Default validity = the EARLIEST of quote date + quote.default_validity_days, the price horizon (snapshot age limit and the lines'
 * sku_prices.valid_to) and — when relying on the List-II exemption — the exemption end date.
 */
export async function defaultValidity(ctx: AppContext, p: { quoteDate: string; snapshotAt: string; exemptionReliance: boolean; refDate: string; priceValidTos: (string | null)[]; ruleIds?: string[] }): Promise<{ date: string; capped_by: ValidityCap }> {
  const days = await ctx.svc.rules.path('quote.default_validity_days', p.quoteDate);
  const age = await ctx.svc.rules.path('quote.max_price_snapshot_age_days', p.quoteDate);
  p.ruleIds?.push(...[days?.id, age?.id].filter((x): x is string => !!x));
  const validityDays = days?.isActive && typeof days.value === 'number' ? days.value : 7;
  const maxAge = age?.isActive && typeof age.value === 'number' ? age.value : 14;
  const candidates: { date: string; cap: ValidityCap }[] = [
    { date: addDaysStr(p.quoteDate, validityDays), cap: 'validity_days' },
    { date: addDaysStr(istDate(p.snapshotAt), maxAge), cap: 'price_snapshot_age' },
  ];
  for (const t of p.priceValidTos) if (t) candidates.push({ date: t, cap: 'price_valid_to' });
  if (p.exemptionReliance) {
    const until = await ctx.svc.rules.path('almm.list2.exemption_net_metering_open_access_until', p.refDate);
    if (until) p.ruleIds?.push(until.id);
    if (until?.isActive && typeof until.value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(until.value)) candidates.push({ date: until.value.slice(0, 10), cap: 'exemption_date' });
  }
  const earliest = minDateStr(...candidates.map((c) => c.date));
  return { date: earliest, capped_by: candidates.find((c) => c.date === earliest)!.cap };
}

/* ───────────── lines ───────────── */
export interface LineDraft {
  sku_id: string | null; description: string; hsn: string | null; gst_rate: number | null; gst_as_of: string | null; tax_position_approved: boolean; tax_approved_by: string | null;
  qty: number; uom: string; unit_price: number; discount_pct: number; line_total: number; price_id: string | null; sort_order: number;
}

export async function gstRateFor(ctx: AppContext, sku: Sku | null, date: string, ruleIds: string[]): Promise<number | null> {
  const path = sku ? GST_RULE_PATH[sku.category] : undefined;
  if (!path) return null;
  const rule = await ctx.svc.rules.path(path, date);
  if (rule) ruleIds.push(rule.id);
  return rule && rule.isActive && typeof rule.value === 'number' ? rule.value : null;
}

const skuDescription = (s: Sku): string => [s.make, s.model, s.variant, s.wattage ? `${s.wattage} W` : null].filter(Boolean).join(' ');

export async function buildLineDrafts(ctx: AppContext, quote: Quotation, inputs: QuoteLineInput[], previous: QuotationLine[], quoteDate: string): Promise<{ drafts: LineDraft[]; ruleIds: string[] }> {
  const ids = [...new Set(inputs.map((i) => i.sku_id).filter((s): s is string => !!s))];
  const skus = new Map((ids.length ? await ctx.db.table('skus').all({ id: ids }) : []).map((s) => [s.id, s]));
  const ruleIds: string[] = [];
  const usedPrev = new Set<string>();
  const drafts: LineDraft[] = [];

  for (const [idx, input] of inputs.entries()) {
    const sku = input.sku_id ? skus.get(input.sku_id) ?? null : null;
    if (input.sku_id && !sku) throw notFound('SKU');
    if (sku && !sku.active) throw guardBlocked(`${skuDescription(sku)} is inactive and cannot be quoted`);
    const price = sku ? await activePriceFor(ctx, sku.id, quoteDate) : null;
    const unit = input.unit_price ?? price?.base_price;
    if (unit === undefined) {
      throw guardBlocked(sku ? `No active price snapshot for ${skuDescription(sku)} — ask Management to publish a price before quoting it` : 'A free-form line needs a unit price', { line: idx });
    }
    const description = input.description?.trim() || (sku ? skuDescription(sku) : '');
    if (!description) throw guardBlocked('A free-form line needs a description', { line: idx });
    let hsn = input.hsn ?? sku?.hsn ?? null;
    let gst = await gstRateFor(ctx, sku, quoteDate, ruleIds);
    let approved = false;
    let approvedBy: string | null = null;

    // keep a CA-type user's tax position across re-saves, unless the line's identity or the governing rule changed
    const prev = previous.find((p) => !usedPrev.has(p.id) && p.sku_id === (input.sku_id ?? null) && (sku ? true : p.description === description));
    if (prev) {
      usedPrev.add(prev.id);
      if (prev.tax_position_approved && prev.tax_approved_by && prev.gst_rate !== null && (input.hsn === undefined || input.hsn === prev.hsn) && (gst === null || gst === prev.gst_rate)) {
        gst = prev.gst_rate; approved = true; approvedBy = prev.tax_approved_by; hsn = prev.hsn ?? hsn;
      }
    }
    const gross = input.qty * unit;
    const disc = input.discount_pct ?? 0;
    drafts.push({
      sku_id: sku?.id ?? null, description, hsn, gst_rate: gst, gst_as_of: gst !== null ? quoteDate : null, tax_position_approved: approved, tax_approved_by: approvedBy,
      qty: input.qty, uom: input.uom ?? sku?.uom ?? 'nos', unit_price: r2(unit), discount_pct: disc, line_total: r2(gross * (1 - disc / 100)), price_id: price?.id ?? null, sort_order: idx + 1,
    });
  }
  return { drafts, ruleIds };
}

/* ───────────── totals, margin, floor ───────────── */
export interface FloorCheckExt extends FloorCheck { min_margin_pct: number | null; margin_below_min: boolean }

const sumLanded = (p: SkuPrice | undefined): number => (p ? Object.values(p.landed_cost ?? {}).reduce<number>((a, v) => a + (typeof v === 'number' ? v : 0), 0) : 0);

export async function computeTotals(ctx: AppContext, lines: QuotationLine[], freight: number, quoteDate: string, ruleIds: string[]) {
  const priceIds = [...new Set(lines.map((l) => l.price_id).filter((p): p is string => !!p))];
  const prices = new Map((priceIds.length ? await ctx.db.table('sku_prices').all({ id: priceIds }) : []).map((p) => [p.id, p]));
  let subtotal = 0, net = 0, tax = 0, cost = 0, costRevenue = 0;
  const floorLines: FloorCheck['lines'] = [];
  for (const l of lines) {
    const gross = l.qty * l.unit_price;
    subtotal += gross; net += l.line_total;
    if (l.gst_rate !== null) tax += l.line_total * (l.gst_rate / 100);
    const price = l.price_id ? prices.get(l.price_id) : undefined;
    const landed = sumLanded(price);
    if (landed > 0) { cost += landed * l.qty; costRevenue += l.line_total; }
    if (l.sku_id) {
      const netUnit = l.qty > 0 ? l.line_total / l.qty : l.unit_price;
      const floor = price?.floor_price ?? null;
      floorLines.push({ sku_id: l.sku_id, unit_price: r2(netUnit), floor_price: floor, below_floor: floor !== null && netUnit < floor - 0.005 });
    }
  }
  const margin = costRevenue > 0 ? r2(((costRevenue - cost) / costRevenue) * 100) : null;
  const minRule = await ctx.svc.rules.path('price_floor.min_margin_pct', quoteDate);
  if (minRule) ruleIds.push(minRule.id);
  // an unverified margin floor is advisory: it is shown in the price review but does not make the check fail
  const minUsable = !!minRule && minRule.isActive && minRule.status === 'verified' && typeof minRule.value === 'number' ? minRule.value : null;
  const marginBelow = minUsable !== null && margin !== null && margin < minUsable;
  const floor: FloorCheckExt = {
    ok: !floorLines.some((f) => f.below_floor) && !marginBelow, lines: floorLines, margin_pct: margin,
    min_margin_pct: minRule && typeof minRule.value === 'number' ? minRule.value : null, margin_below_min: marginBelow,
  };
  const discountAmount = r2(subtotal - net);
  return {
    subtotal: r2(subtotal), discount_amount: discountAmount, discount_pct: subtotal > 0 ? r2((discountAmount / subtotal) * 100) : 0,
    tax_total: r2(tax), total: r2(net + tax + freight), net: r2(net), margin_pct: margin, floor_check: floor as FloorCheck,
  };
}

/* ───────────── funding split ───────────── */
function isPlain(v: Json): v is { [k: string]: Json } { return !!v && typeof v === 'object' && !Array.isArray(v); }

/** `gujarat.state_subsidy` — an empty / missing / inactive object means NO state share. Supported keys: flat | per_kw (+max_kw), max_total, segments, states. */
async function stateShare(ctx: AppContext, opp: Opportunity | null, site: Site | null, kw: number, refDate: string, ruleIds: string[]): Promise<{ amount: number; note: string }> {
  const rule = await ctx.svc.rules.path('gujarat.state_subsidy', refDate);
  if (rule) ruleIds.push(rule.id);
  if (!rule || !rule.isActive) return { amount: 0, note: 'No state scheme is active (gujarat.state_subsidy).' };
  const v = rule.value;
  if (!isPlain(v) || !Object.keys(v).length) return { amount: 0, note: 'The state scheme object is empty — no state share.' };
  const segments = Array.isArray(v['segments']) ? v['segments'] : ['pmsg_residential'];
  const states = (Array.isArray(v['states']) ? v['states'] : ['Gujarat']).map((s) => String(s).toLowerCase());
  const segment = opp?.segment ?? null;
  if (!segment || !segments.includes(segment)) return { amount: 0, note: 'The state scheme does not cover this segment.' };
  if (!site?.state || !states.includes(site.state.toLowerCase())) return { amount: 0, note: 'The state scheme does not cover the site state.' };
  let amount = typeof v['flat'] === 'number' ? v['flat'] : typeof v['per_kw'] === 'number' ? v['per_kw'] * Math.min(kw, typeof v['max_kw'] === 'number' ? v['max_kw'] : kw) : 0;
  if (typeof v['max_total'] === 'number') amount = Math.min(amount, v['max_total']);
  return { amount: r2(Math.max(0, amount)), note: 'State share from the configured state scheme.' };
}

export async function computeFunding(ctx: AppContext, quote: Quotation, opp: Opportunity | null, site: Site | null, total: number, ruleIds: string[]) {
  const refDate = quote.expected_commissioning_date ?? istDateString(ctx.now());
  let households: number | undefined;
  if (opp?.lead_id) {
    const forms = await ctx.db.table('requirement_forms').all({ lead_id: opp.lead_id }, { orderBy: { col: 'created_at', dir: 'desc' } });
    const h = forms.map((f) => f.data?.['households']).find((x) => typeof x === 'number');
    if (typeof h === 'number') households = h;
  }
  const cfa = await computeCfa(ctx, {
    segment: quote.segment, kw: quote.kw, referenceDate: refDate, existing_solar_kw: site?.existing_solar_kw, special_category_state: site?.special_category_state, households,
  });
  ruleIds.push(...cfa.ruleIds);
  const state = await stateShare(ctx, opp, site, quote.kw, refDate, ruleIds);
  const cfaAmount = Math.min(cfa.cfa, total);
  const stateAmount = Math.min(state.amount, Math.max(0, total - cfaAmount));
  const loanPct = opp?.funding_mix?.loan_pct ?? 0;
  const loan = r2(Math.min(total * (loanPct / 100), Math.max(0, total - cfaAmount - stateAmount)));
  const consumer = r2(Math.max(0, total - cfaAmount - stateAmount - loan));
  const breakdown: Json = {
    cfa: { eligible: cfa.eligible, eligible_kw: cfa.eligible_kw, amount: cfa.cfa, benchmark_cost: cfa.benchmark_cost, lines: cfa.lines as unknown as Json, warnings: cfa.warnings },
    state: { amount: state.amount, note: state.note }, loan: { pct: loanPct, amount: loan }, consumer: { amount: consumer },
    funding_mix: (opp?.funding_mix ?? null) as unknown as Json, reference_date: refDate, ruleIds: [...new Set(ruleIds)],
  };
  return { cfa_entitlement: r2(cfaAmount), state_share: r2(stateAmount), loan_share: loan, consumer_share: consumer, cfa_breakdown: breakdown };
}

/** Place of supply = the site's state, else the customer's, else the organisation's. */
export async function placeOfSupply(ctx: AppContext, site: Site | null, customerId: string | null): Promise<string | null> {
  if (site?.state) return site.state;
  if (customerId) { const c = await ctx.db.table('customers').get(customerId); if (c?.state) return c.state; }
  const org = await ctx.db.table('organizations').get(ctx.org_id);
  return org?.state ?? null;
}

/** Recompute every derived number on a quote from its stored lines, and persist them. Returns the updated quote. */
export async function recalcQuote(ctx: AppContext, quoteId: string, extra: Partial<Quotation> = {}): Promise<Quotation> {
  const quote = { ...(await ctx.db.table('quotations').getOrThrow(quoteId)), ...extra };
  const lines = await ctx.db.table('quotation_lines').all({ quote_id: quoteId }, { orderBy: { col: 'sort_order' } });
  const opp = await ctx.db.table('opportunities').get(quote.opportunity_id);
  const site = quote.site_id ? await ctx.db.table('sites').get(quote.site_id) : null;
  const quoteDate = istDate(quote.price_snapshot_at);
  const skuIds = [...new Set(lines.map((l) => l.sku_id).filter((s): s is string => !!s))];
  const skus = new Map((skuIds.length ? await ctx.db.table('skus').all({ id: skuIds }) : []).map((s) => [s.id, s]));
  const ruleIds: string[] = [];
  for (const sku of skus.values()) {
    const path = GST_RULE_PATH[sku.category];
    if (path) { const r = await ctx.svc.rules.path(path, quoteDate); if (r) ruleIds.push(r.id); }
  }
  const totals = await computeTotals(ctx, lines, quote.freight, quoteDate, ruleIds);
  const funding = await computeFunding(ctx, quote, opp, site, totals.total, ruleIds);
  const mandatory = lines.filter((l) => requiresTaxApproval({ sku: l.sku_id ? skus.get(l.sku_id) ?? null : null, description: l.description }));
  const patch: Partial<Quotation> = {
    ...extra, subtotal: totals.subtotal, discount_amount: totals.discount_amount, discount_pct: totals.discount_pct, tax_total: totals.tax_total, total: totals.total,
    margin_pct: totals.margin_pct, floor_check: totals.floor_check, ...funding, place_of_supply: await placeOfSupply(ctx, site, quote.customer_id),
    tax_position_approved: mandatory.every((l) => l.tax_position_approved),
  };
  return ctx.db.table('quotations').update(quoteId, patch);
}
