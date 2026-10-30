/**
 * Re-quote engine. Open quotes that depend on a changed GST / duty / ALMM / BIS / PMSG / Gujarat rule, on a changed SKU compliance entry
 * or on a new price snapshot are flagged `requote_required` (reason recorded, owner + DSM notified, audited).
 *
 * Three entry points:
 *   · onRuleChanged hook   — fired by the rule service on every create / update / activate / deactivate;
 *   · onSkuComplianceChanged / onSkuPriceChanged — called by the catalogue service;
 *   · nightly job `quotes.requote_scan` — catches anything that changed without a hook (e.g. a rule version that came into force today).
 * Dependency = the rule ids stored on the quote (`rule_ids_used`, every version of the same category.key counts) or the quote's SKUs.
 * Also here: the nightly expiry job and the exposure report (open quotes grouped by SKU).
 */
import { istDateString, type Json, type Quotation, type QuoteStatus, type RuleConfig } from '@solar/shared';
import type { AppContext } from '../auth/context';
import { audit } from '../lib/audit';
import { onRuleChanged, registerJob } from './hooks';

/** Quotes that can still be flagged. */
export const OPEN_QUOTE_STATUSES: QuoteStatus[] = ['draft', 'blocked', 'price_review', 'pending_approval', 'approved', 'sent', 'negotiation'];
/** Rule categories whose changes can alter a quote. */
export const REQUOTE_CATEGORIES = new Set(['gst', 'customs', 'almm', 'bis', 'pmsg', 'rwa_ghs', 'kusum', 'gujarat']);

/** Owner plus the DSM(s) responsible for the quote's territory (all DSMs when none is mapped). */
async function recipients(ctx: AppContext, quote: Quotation): Promise<string[]> {
  const ids = new Set<string>();
  if (quote.owner_id) ids.add(quote.owner_id);
  const dsms = await ctx.db.table('profiles').all({ role: 'dsm', active: true });
  const mapped = quote.territory_id ? dsms.filter((d) => d.territory_ids.includes(quote.territory_id!)) : [];
  for (const d of mapped.length ? mapped : dsms) ids.add(d.id);
  return [...ids];
}

/** Stop everything that was waiting on a quote that must be re-quoted (approvals, follow-up clocks). */
export async function closeQuoteWorkflow(ctx: AppContext, quote: Pick<Quotation, 'id'>, note: string): Promise<void> {
  const pending = await ctx.db.table('approvals').all({ entity_type: 'quotation', entity_id: quote.id, decision: 'pending' });
  for (const a of pending) {
    await ctx.db.table('approvals').update(a.id, { decision: 'skipped', decided_at: ctx.now().toISOString(), comment: note });
    await ctx.svc.clocks.cancel('approval', a.id, 'approval');
  }
  await ctx.svc.clocks.cancel('quotation', quote.id, 'quote_followup');
}

export async function flagQuotes(ctx: AppContext, quotes: Quotation[], reason: string, source: Json): Promise<Quotation[]> {
  const flagged: Quotation[] = [];
  for (const q of quotes) {
    if (!OPEN_QUOTE_STATUSES.includes(q.status)) continue;
    const row = await ctx.db.table('quotations').update(q.id, { status: 'requote_required', requote_reason: reason });
    await closeQuoteWorkflow(ctx, q, 'Quote flagged for re-quote');
    await audit(ctx, { action: 'quote.requote_required', table: 'quotations', record_id: q.id, old: { status: q.status }, new: { status: 'requote_required', reason }, detail: source });
    const to = await recipients(ctx, q);
    if (to.length) {
      await ctx.svc.notify.notify({
        user_ids: to, kind: 'quote.requote_required', title: `Re-quote needed — ${q.quote_no} v${q.version}`, body: reason, severity: 'warning', entity_type: 'quotation', entity_id: q.id,
      });
    }
    flagged.push(row);
  }
  return flagged;
}

async function openQuotes(ctx: AppContext): Promise<Quotation[]> {
  return ctx.db.table('quotations').all({ status: OPEN_QUOTE_STATUSES });
}

/* ───────────── rule changes ───────────── */
export async function flagForRule(ctx: AppContext, rule: RuleConfig, change: string): Promise<Quotation[]> {
  if (!REQUOTE_CATEGORIES.has(rule.category)) return [];
  const versions = await ctx.db.table('rule_config').all({ category: rule.category, key: rule.key });
  const ids = new Set(versions.map((v) => v.id));
  const quotes = (await openQuotes(ctx)).filter((q) => q.rule_ids_used.some((id) => ids.has(id)));
  if (!quotes.length) return [];
  const reason = `Rule ${rule.category}.${rule.key} was ${change} — the quote was evaluated on the earlier rule. Re-evaluate and re-quote.`;
  return flagQuotes(ctx, quotes, reason, { rule_id: rule.id, path: `${rule.category}.${rule.key}`, change });
}

onRuleChanged(async (ctx, rule, change) => { await flagForRule(ctx, rule, change); });

/* ───────────── SKU and price changes ───────────── */
async function quotesWithSku(ctx: AppContext, skuId: string): Promise<Quotation[]> {
  const lines = await ctx.db.table('quotation_lines').all({ sku_id: skuId });
  const ids = [...new Set(lines.map((l) => l.quote_id))];
  if (!ids.length) return [];
  return (await ctx.db.table('quotations').all({ id: ids })).filter((q) => OPEN_QUOTE_STATUSES.includes(q.status));
}

export async function onSkuComplianceChanged(ctx: AppContext, skuId: string, what: string): Promise<Quotation[]> {
  const quotes = await quotesWithSku(ctx, skuId);
  if (!quotes.length) return [];
  const sku = await ctx.db.table('skus').get(skuId);
  const label = sku ? `${sku.make} ${sku.model}` : 'A SKU on the quote';
  return flagQuotes(ctx, quotes, `${label}: ${what}. Re-evaluate compliance and re-quote.`, { sku_id: skuId, change: what });
}

export async function onSkuPriceChanged(ctx: AppContext, skuId: string, what: string): Promise<Quotation[]> {
  const quotes = await quotesWithSku(ctx, skuId);
  if (!quotes.length) return [];
  const sku = await ctx.db.table('skus').get(skuId);
  const label = sku ? `${sku.make} ${sku.model}` : 'A SKU on the quote';
  return flagQuotes(ctx, quotes, `${label}: ${what}. The quoted price is no longer current — re-quote.`, { sku_id: skuId, change: what });
}

/* ───────────── nightly scan ───────────── */
/**
 * Compares each open quote against the world as it is today: a rule it depends on was updated after the quote was evaluated, or a
 * different version of it is now in force; a SKU register entry was changed after evaluation; a newer price snapshot is in force.
 */
export async function scanOpenQuotes(ctx: AppContext): Promise<{ scanned: number; flagged: number }> {
  const today = istDateString(ctx.now());
  const quotes = await openQuotes(ctx);
  let flagged = 0;
  const skuCache = new Map<string, { compUpdated: string | null; latestPrice: string | null; label: string }>();
  const skuInfo = async (skuId: string) => {
    let e = skuCache.get(skuId);
    if (!e) {
      const [comp, prices, sku] = await Promise.all([
        ctx.db.table('sku_compliance').one({ sku_id: skuId }),
        ctx.db.table('sku_prices').all({ sku_id: skuId, valid_from: { lte: today } }, { orderBy: { col: 'valid_from', dir: 'desc' } }),
        ctx.db.table('skus').get(skuId),
      ]);
      const current = prices.find((p) => !p.valid_to || p.valid_to >= today) ?? null;
      e = { compUpdated: comp?.updated_at ?? null, latestPrice: current?.id ?? null, label: sku ? `${sku.make} ${sku.model}` : 'A SKU' };
      skuCache.set(skuId, e);
    }
    return e;
  };

  for (const q of quotes) {
    const evaluatedAt = q.compliance_evaluated_at ?? q.updated_at;
    const reasons: string[] = [];
    if (q.rule_ids_used.length) {
      const rows = await ctx.db.table('rule_config').all({ id: q.rule_ids_used });
      for (const r of rows) {
        if (!REQUOTE_CATEGORIES.has(r.category)) continue;
        const refDate = q.expected_commissioning_date ?? today;
        const current = await ctx.svc.rules.get(r.category, r.key, refDate);
        if (r.updated_at > evaluatedAt) reasons.push(`Rule ${r.category}.${r.key} changed after this quote was evaluated.`);
        else if (current && current.id !== r.id) reasons.push(`A new version of rule ${r.category}.${r.key} is now in force.`);
      }
    }
    const lines = await ctx.db.table('quotation_lines').all({ quote_id: q.id });
    for (const l of lines) {
      if (!l.sku_id) continue;
      const info = await skuInfo(l.sku_id);
      if (info.compUpdated && info.compUpdated > evaluatedAt) reasons.push(`${info.label}: the compliance register entry changed after this quote was evaluated.`);
      if (info.latestPrice && l.price_id && info.latestPrice !== l.price_id) reasons.push(`${info.label}: a newer price snapshot is in force.`);
    }
    if (reasons.length) {
      await flagQuotes(ctx, [q], [...new Set(reasons)].join(' '), { source: 'nightly_scan' });
      flagged++;
    }
  }
  return { scanned: quotes.length, flagged };
}

/* ───────────── expiry ───────────── */
const EXPIRABLE: QuoteStatus[] = ['draft', 'blocked', 'price_review', 'pending_approval', 'approved', 'sent', 'negotiation', 'requote_required'];

/** Quotes whose validity date has passed (and that were not accepted) become `expired`. */
export async function expireQuotes(ctx: AppContext): Promise<{ expired: number }> {
  const today = istDateString(ctx.now());
  const due = await ctx.db.table('quotations').all({ status: EXPIRABLE, validity_date: { lt: today } });
  for (const q of due) {
    await ctx.db.table('quotations').update(q.id, { status: 'expired' });
    await closeQuoteWorkflow(ctx, q, 'Quote expired');
    await audit(ctx, { action: 'quote.expire', table: 'quotations', record_id: q.id, old: { status: q.status, validity_date: q.validity_date } });
    if (q.owner_id) {
      await ctx.svc.notify.notify({
        user_ids: [q.owner_id], kind: 'quote.expired', title: `Quote expired — ${q.quote_no} v${q.version}`, body: `The validity date ${q.validity_date} has passed. Revise the quote to renew it.`,
        severity: 'warning', entity_type: 'quotation', entity_id: q.id,
      });
    }
  }
  return { expired: due.length };
}

registerJob({ name: 'quotes.expire', schedule: '45 1 * * *', run: async (ctx) => ({ ...(await expireQuotes(ctx)) }) });
registerJob({ name: 'quotes.requote_scan', schedule: '55 1 * * *', run: async (ctx) => ({ ...(await scanOpenQuotes(ctx)) }) });

/* ───────────── exposure report ───────────── */
export interface RequoteExposureRow {
  sku_id: string; make: string; model: string; category: string; open_quotes: number; requote_required: number; value: number; flagged_value: number;
  quotes: { quote_id: string; quote_no: string; version: number; status: QuoteStatus; total: number; line_value: number; owner_id: string | null; requote_reason: string | null }[];
}

/** Open quotes grouped by SKU: how many, and how many rupees of quoted value are exposed to a change in that SKU's rules, compliance or price. */
export async function requoteExposure(ctx: AppContext, opts: { only_flagged?: boolean } = {}): Promise<{ rows: RequoteExposureRow[]; totals: { open_quotes: number; requote_required: number; value: number; flagged_value: number } }> {
  const statuses: QuoteStatus[] = [...OPEN_QUOTE_STATUSES, 'requote_required'];
  const quotes = await ctx.db.table('quotations').all({ status: opts.only_flagged ? ['requote_required'] : statuses });
  const byId = new Map(quotes.map((q) => [q.id, q]));
  const lines = quotes.length ? await ctx.db.table('quotation_lines').all({ quote_id: quotes.map((q) => q.id) }) : [];
  const skuIds = [...new Set(lines.map((l) => l.sku_id).filter((s): s is string => !!s))];
  const skus = new Map((skuIds.length ? await ctx.db.table('skus').all({ id: skuIds }) : []).map((s) => [s.id, s]));
  const rows = new Map<string, RequoteExposureRow>();
  for (const l of lines) {
    if (!l.sku_id) continue;
    const q = byId.get(l.quote_id);
    const sku = skus.get(l.sku_id);
    if (!q || !sku) continue;
    const row = rows.get(sku.id) ?? { sku_id: sku.id, make: sku.make, model: sku.model, category: sku.category, open_quotes: 0, requote_required: 0, value: 0, flagged_value: 0, quotes: [] };
    let entry = row.quotes.find((e) => e.quote_id === q.id);
    if (!entry) {
      entry = { quote_id: q.id, quote_no: q.quote_no, version: q.version, status: q.status, total: q.total, line_value: 0, owner_id: q.owner_id, requote_reason: q.requote_reason };
      row.quotes.push(entry);
      row.open_quotes += 1;
      if (q.status === 'requote_required') row.requote_required += 1;
    }
    const withTax = l.line_total * (1 + (l.gst_rate ?? 0) / 100);
    entry.line_value = Math.round((entry.line_value + withTax) * 100) / 100;
    row.value = Math.round((row.value + withTax) * 100) / 100;
    if (q.status === 'requote_required') row.flagged_value = Math.round((row.flagged_value + withTax) * 100) / 100;
    rows.set(sku.id, row);
  }
  const list = [...rows.values()].sort((a, b) => b.value - a.value);
  return {
    rows: list,
    totals: { open_quotes: quotes.length, requote_required: quotes.filter((q) => q.status === 'requote_required').length, value: Math.round(list.reduce((s, r) => s + r.value, 0) * 100) / 100, flagged_value: Math.round(list.reduce((s, r) => s + r.flagged_value, 0) * 100) / 100 },
  };
}

