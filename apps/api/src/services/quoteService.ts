/**
 * Stage 4 — quotation: builder, compliance sync, price review / approvals, branded PDF, send, follow-up cadence,
 * customer discussion, accept / reject / revise (versioning).
 *
 * Status map (QuoteStatus):
 *   draft ⇄ blocked (hard stop)  →  price_review (evaluated clean)  →  pending_approval  →  approved  →  sent  →  negotiation  →  accepted
 *   rejected | requote_required | expired → revise → new version (draft); the old version becomes `revised`.
 */
import {
  SEGMENT_LABEL, isExternalRole, istDateString,
  type ComplianceOverrideRequestInput, type Json, type Lead, type Opportunity, type Quotation, type QuotationLine, type QuoteCreateInput,
  type QuoteDiscussionInput, type QuoteLinesReplaceInput, type QuotePatchInput, type QuoteSendInput, type QuoteStatus, type Site, type TaxPositionInput,
} from '@solar/shared';
import type { AppContext } from '../auth/context';
import { assertCanRead } from '../auth/access';
import { badRequest, complianceBlocked, conflict, guardBlocked, invalidState, notFound, AppError } from '../http/errors';
import { audit } from '../lib/audit';
import { addDays, nextWorkingStart } from '../lib/time';
import { evaluateQuoteFull, toResult } from './complianceService';
import { istDate } from './compliance/dates';
import { lineSignature } from './compliance/overrides';
import type { FullEvaluation } from './compliance/types';
import { openOverrideApproval, openQuoteApprovals, planQuoteApprovals, quoteApprovals, workCalendar } from './approvalService';
import { closeQuoteWorkflow } from './requoteService';
import { renderQuotePdf, type QuotePdfData } from './quotePdf';
import { assertClauseKeys, buildLineDrafts, defaultClauseKeys, defaultValidity, nextQuoteNo, recalcQuote, r2 } from './quotePricing';

const toJson = (v: unknown): Json => v as Json;
const EDITABLE: QuoteStatus[] = ['draft', 'blocked', 'price_review', 'requote_required'];
const REVISABLE: QuoteStatus[] = ['sent', 'negotiation', 'rejected', 'requote_required', 'expired', 'approved'];

/* ───────────── loading ───────────── */
async function loadQuote(ctx: AppContext, id: string): Promise<Quotation> {
  const q = await ctx.db.table('quotations').get(id);
  if (!q) throw notFound('Quotation');
  await assertCanRead(ctx, 'quotations', q);
  return q;
}

function assertEditable(q: Quotation): void {
  if (!EDITABLE.includes(q.status)) {
    throw invalidState(`A quote that is "${q.status.replace('_', ' ')}" cannot be edited — create a revision instead`, { status: q.status });
  }
  if (q.status === 'requote_required' && q.sent_at) throw invalidState('This quote was already sent to the customer — create a revision to re-quote it', { status: q.status });
}

/** After any change: re-run the gates, then move the quote between draft / blocked (and price_review when asked). */
async function evaluateAndSync(ctx: AppContext, id: string, opts: { toReview?: boolean } = {}): Promise<FullEvaluation> {
  const result = await evaluateQuoteFull(ctx, id, { persist: true });
  const q = await ctx.db.table('quotations').getOrThrow(id);
  if (['draft', 'blocked', 'price_review'].includes(q.status)) {
    const next: QuoteStatus = result.hasHardStop ? 'blocked' : opts.toReview ? 'price_review' : 'draft';
    if (next !== q.status) await ctx.db.table('quotations').update(id, { status: next });
  } else if (q.status === 'requote_required' && !q.sent_at) {
    await ctx.db.table('quotations').update(id, { status: result.hasHardStop ? 'blocked' : 'draft', requote_reason: null });
  }
  return result;
}

/* ───────────── detail ───────────── */
export async function getQuoteDetail(ctx: AppContext, id: string) {
  const q = await loadQuote(ctx, id);
  const external = isExternalRole(ctx.user.role);
  const [lines, discussions, versions, opp, customer, site, owner, dealer, docs, clocks, approvals] = await Promise.all([
    ctx.db.table('quotation_lines').all({ quote_id: q.id }, { orderBy: { col: 'sort_order' } }),
    ctx.db.table('quote_discussions').all({ quote_id: q.id }, { orderBy: { col: 'logged_at', dir: 'desc' } }),
    ctx.db.table('quotations').all({ quote_no: q.quote_no }, { orderBy: { col: 'version' } }),
    ctx.db.table('opportunities').get(q.opportunity_id),
    q.customer_id ? ctx.db.table('customers').get(q.customer_id) : Promise.resolve(null),
    q.site_id ? ctx.db.table('sites').get(q.site_id) : Promise.resolve(null),
    q.owner_id ? ctx.db.table('profiles').get(q.owner_id) : Promise.resolve(null),
    q.dealer_id ? ctx.db.table('dealers').get(q.dealer_id) : Promise.resolve(null),
    ctx.db.table('documents').all({ entity_type: 'quotation', entity_id: q.id }, { orderBy: { col: 'created_at', dir: 'desc' } }),
    ctx.db.table('clocks').all({ entity_type: 'quotation', entity_id: q.id, clock_type: 'quote_followup' }, { orderBy: { col: 'due_at' } }),
    quoteApprovals(ctx, q.id),
  ]);
  const skuIds = [...new Set(lines.map((l) => l.sku_id).filter((s): s is string => !!s))];
  const skus = new Map((skuIds.length ? await ctx.db.table('skus').all({ id: skuIds }) : []).map((s) => [s.id, s]));
  const comps = new Map((skuIds.length ? await ctx.db.table('sku_compliance').all({ sku_id: skuIds }) : []).map((c) => [c.sku_id, c]));
  const base = external ? { ...q, margin_pct: null, floor_check: null } : q;
  return {
    ...base,
    lines: lines.map((l) => {
      const sku = l.sku_id ? skus.get(l.sku_id) ?? null : null;
      return {
        ...l, gross: r2(l.qty * l.unit_price), tax_amount: l.gst_rate === null ? 0 : r2(l.line_total * (l.gst_rate / 100)),
        sku: sku ? { id: sku.id, category: sku.category, make: sku.make, model: sku.model, variant: sku.variant, wattage: sku.wattage, hsn: sku.hsn, uom: sku.uom, brand_usp: sku.brand_usp, warranty_years: sku.warranty_years } : null,
        compliance: l.sku_id ? comps.get(l.sku_id) ?? null : null,
      };
    }),
    findings: q.compliance_findings,
    approvals: approvals.filter((a) => a.entity_type === 'quotation'),
    overrides: approvals.filter((a) => a.entity_type === 'compliance_override'),
    discussions,
    versions: versions.map((v) => ({ id: v.id, version: v.version, status: v.status, total: v.total, parent_quote_id: v.parent_quote_id, created_at: v.created_at })),
    cfa: { entitlement: q.cfa_entitlement, state_share: q.state_share, loan_share: q.loan_share, consumer_share: q.consumer_share, breakdown: q.cfa_breakdown },
    followups: clocks.map((c) => ({ id: c.id, due_at: c.due_at, status: c.status, escalated_level: c.escalated_level, resolved_at: c.resolved_at, day: Number((c.meta as { day?: number } | null)?.day ?? 0) })),
    opportunity: opp ? { id: opp.id, name: opp.name, stage: opp.stage, kw: opp.kw, segment: opp.segment, probability: opp.probability, funding_mix: opp.funding_mix, exemption_reliance: opp.exemption_reliance } : null,
    customer: customer ? { id: customer.id, legal_name: customer.legal_name, gstin: customer.gstin } : null,
    site: site ? { id: site.id, state: site.state, city: site.city, pincode: site.pincode, name_match: site.name_match, pending_dues: site.pending_dues, special_category_state: site.special_category_state, existing_solar_kw: site.existing_solar_kw } : null,
    owner: owner ? { id: owner.id, full_name: owner.full_name } : null,
    dealer: dealer ? { id: dealer.id, legal_name: dealer.legal_name, portal_status: dealer.portal_status } : null,
    documents: docs,
    editable: EDITABLE.includes(q.status) && !(q.status === 'requote_required' && !!q.sent_at),
  };
}
export type QuoteDetail = Awaited<ReturnType<typeof getQuoteDetail>>;

export async function hydrateQuoteList(ctx: AppContext, rows: Quotation[]) {
  if (!rows.length) return [];
  const external = isExternalRole(ctx.user.role);
  const uniq = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => !!x))];
  const [opps, customers, owners, dealers, lines] = await Promise.all([
    ctx.db.table('opportunities').all({ id: uniq(rows.map((r) => r.opportunity_id)) }),
    uniq(rows.map((r) => r.customer_id)).length ? ctx.db.table('customers').all({ id: uniq(rows.map((r) => r.customer_id)) }) : Promise.resolve([]),
    uniq(rows.map((r) => r.owner_id)).length ? ctx.db.table('profiles').all({ id: uniq(rows.map((r) => r.owner_id)) }) : Promise.resolve([]),
    uniq(rows.map((r) => r.dealer_id)).length ? ctx.db.table('dealers').all({ id: uniq(rows.map((r) => r.dealer_id)) }) : Promise.resolve([]),
    ctx.db.table('quotation_lines').all({ quote_id: rows.map((r) => r.id) }),
  ]);
  return rows.map((r) => ({
    ...(external ? { ...r, margin_pct: null, floor_check: null } : r),
    opportunity_name: opps.find((o) => o.id === r.opportunity_id)?.name ?? null, customer_name: customers.find((c) => c.id === r.customer_id)?.legal_name ?? null,
    owner_name: owners.find((o) => o.id === r.owner_id)?.full_name ?? null, dealer_name: dealers.find((d) => d.id === r.dealer_id)?.legal_name ?? null,
    line_count: lines.filter((l) => l.quote_id === r.id).length,
  }));
}

/** Ids of quotes that have a newer version (so the list can show only the latest of each chain). */
export async function supersededQuoteIds(ctx: AppContext): Promise<string[]> {
  const children = await ctx.db.table('quotations').all({ parent_quote_id: { is_null: false } });
  return [...new Set(children.map((c) => c.parent_quote_id).filter((p): p is string => !!p))];
}

async function leadEvent(ctx: AppContext, leadId: string | null, type: string, summary: string, detail: Record<string, Json> = {}): Promise<void> {
  if (!leadId) return;
  await ctx.db.table('lead_events').insert({ lead_id: leadId, event_type: type, summary, actor_id: ctx.system ? null : ctx.user.id, detail: toJson(detail) });
}

/* ───────────── create ───────────── */
export async function createQuote(ctx: AppContext, input: QuoteCreateInput) {
  const opp = await ctx.db.table('opportunities').get(input.opportunity_id);
  if (!opp) throw notFound('Opportunity');
  await assertCanRead(ctx, 'opportunities', opp);
  if (opp.stage === 'won' || opp.stage === 'lost') throw invalidState(`The opportunity is ${opp.stage} — a quotation cannot be raised on it`);
  const now = ctx.now();
  const today = istDateString(now);
  const refDate = opp.expected_commissioning_date ?? today;
  const ruleIds: string[] = [];
  const validity = input.validity_date ?? (await defaultValidity(ctx, { quoteDate: today, snapshotAt: now.toISOString(), exemptionReliance: opp.exemption_reliance, refDate, priceValidTos: [], ruleIds })).date;
  if (validity < today) throw guardBlocked('The validity date cannot be in the past');
  const clauseKeys = input.clause_keys ?? (await defaultClauseKeys(ctx));
  await assertClauseKeys(ctx, clauseKeys);

  const quote = await ctx.db.table('quotations').insert({
    quote_no: await nextQuoteNo(ctx), version: 1, parent_quote_id: null, opportunity_id: opp.id, lead_id: opp.lead_id, customer_id: opp.customer_id, site_id: opp.site_id,
    segment: opp.segment, kw: opp.kw, expected_commissioning_date: opp.expected_commissioning_date, status: 'draft', validity_date: validity, price_snapshot_at: now.toISOString(),
    tax_position_approved: true, clause_keys: clauseKeys, place_of_supply: null, payment_terms: input.payment_terms ?? null,
    subtotal: 0, discount_pct: 0, discount_amount: 0, freight: input.freight ?? 0, tax_total: 0, total: 0, margin_pct: null, floor_check: null,
    cfa_entitlement: 0, state_share: 0, loan_share: 0, consumer_share: 0, cfa_breakdown: {}, loan_rate_pct: opp.funding_mix?.loan_rate_pct ?? null, loan_rate_source_date: opp.funding_mix?.loan_rate_source_date ?? null,
    exemption_reliance: opp.exemption_reliance, compliance_status: 'pending', compliance_findings: [], compliance_evaluated_at: null, rule_ids_used: [...new Set(ruleIds)], requote_reason: null,
    owner_id: opp.owner_id ?? ctx.user.id, distributor_id: opp.distributor_id, dealer_id: opp.dealer_id, territory_id: opp.territory_id,
    sent_at: null, accepted_at: null, rejected_reason: null, pdf_document_id: null, terms_confirmed_at: null, created_by: ctx.user.id,
  });
  await recalcQuote(ctx, quote.id);
  await evaluateAndSync(ctx, quote.id);
  if (opp.stage === 'qualified') await ctx.db.table('opportunities').update(opp.id, { stage: 'quotation' });
  await audit(ctx, { action: 'quote.create', table: 'quotations', record_id: quote.id, new: toJson(quote), detail: toJson({ opportunity_id: opp.id }) });
  await leadEvent(ctx, opp.lead_id, 'quote_created', `Quotation ${quote.quote_no} v1 drafted`, { quote_id: quote.id });
  return getQuoteDetail(ctx, quote.id);
}

/* ───────────── lines ───────────── */
export async function replaceLines(ctx: AppContext, id: string, input: QuoteLinesReplaceInput) {
  const quote = await loadQuote(ctx, id);
  assertEditable(quote);
  const now = ctx.now();
  const today = istDateString(now);
  const previous = await ctx.db.table('quotation_lines').all({ quote_id: id }, { orderBy: { col: 'sort_order' } });
  const { drafts } = await buildLineDrafts(ctx, quote, input.lines, previous, today);

  // validity: an explicit date wins; otherwise the default is (re)capped by the price horizon on the first set of lines or on request
  let validity = quote.validity_date;
  if (input.validity_date) {
    if (input.validity_date < today) throw guardBlocked('The validity date cannot be in the past');
    validity = input.validity_date;
  } else if (!previous.length || input.reset_validity) {
    const priceIds = [...new Set(drafts.map((d) => d.price_id).filter((p): p is string => !!p))];
    const prices = priceIds.length ? await ctx.db.table('sku_prices').all({ id: priceIds }) : [];
    validity = (await defaultValidity(ctx, { quoteDate: today, snapshotAt: now.toISOString(), exemptionReliance: quote.exemption_reliance, refDate: quote.expected_commissioning_date ?? today, priceValidTos: prices.map((p) => p.valid_to) })).date;
  }

  for (const l of previous) await ctx.db.table('quotation_lines').delete(l.id);
  if (drafts.length) await ctx.db.table('quotation_lines').insertMany(drafts.map((d) => ({ ...d, quote_id: id, created_by: ctx.user.id })));
  await recalcQuote(ctx, id, { price_snapshot_at: now.toISOString(), validity_date: validity });
  await evaluateAndSync(ctx, id);
  await audit(ctx, { action: 'quote.lines_replaced', table: 'quotation_lines', record_id: id, detail: toJson({ before: previous.length, after: drafts.length }) });
  return getQuoteDetail(ctx, id);
}

/* ───────────── header changes ───────────── */
export async function patchQuote(ctx: AppContext, id: string, input: QuotePatchInput) {
  const quote = await loadQuote(ctx, id);
  assertEditable(quote);
  const today = istDateString(ctx.now());
  const patch: Partial<Quotation> = {};
  if (input.validity_date !== undefined) {
    if (input.validity_date < today) throw guardBlocked('The validity date cannot be in the past');
    patch.validity_date = input.validity_date;
  }
  if (input.payment_terms !== undefined) patch.payment_terms = input.payment_terms;
  if (input.clause_keys !== undefined) { await assertClauseKeys(ctx, input.clause_keys); patch.clause_keys = input.clause_keys; }
  if (input.freight !== undefined) patch.freight = input.freight;
  if (input.expected_commissioning_date !== undefined) patch.expected_commissioning_date = input.expected_commissioning_date;
  if (input.exemption_reliance !== undefined) patch.exemption_reliance = input.exemption_reliance;
  if (input.loan_rate_pct !== undefined) patch.loan_rate_pct = input.loan_rate_pct;
  if (input.loan_rate_source_date !== undefined) patch.loan_rate_source_date = input.loan_rate_source_date;
  await recalcQuote(ctx, id, patch);
  await evaluateAndSync(ctx, id);
  await audit(ctx, { action: 'quote.update', table: 'quotations', record_id: id, old: toJson(quote), new: toJson(patch) });
  return getQuoteDetail(ctx, id);
}

/* ───────────── CA-type tax position ───────────── */
export async function setTaxPosition(ctx: AppContext, id: string, input: TaxPositionInput) {
  const quote = await loadQuote(ctx, id);
  assertEditable(quote);
  const lines = await ctx.db.table('quotation_lines').all({ quote_id: id });
  const quoteDate = istDate(quote.price_snapshot_at);
  for (const item of input.lines) {
    const line = lines.find((l) => l.id === item.line_id);
    if (!line) throw badRequest('That line does not belong to this quote', { line_id: item.line_id });
    const rate = item.gst_rate ?? line.gst_rate;
    if (item.approved && rate === null) throw guardBlocked('Enter the GST rate you are approving — this line has none', { line_id: item.line_id });
    if (item.approved && !(item.hsn ?? line.hsn)) throw guardBlocked('Enter the HSN code you are approving — this line has none', { line_id: item.line_id });
    await ctx.db.table('quotation_lines').update(line.id, {
      gst_rate: rate, gst_as_of: rate !== null ? quoteDate : null, hsn: item.hsn ?? line.hsn,
      tax_position_approved: item.approved, tax_approved_by: item.approved ? ctx.user.id : null,
    });
  }
  await recalcQuote(ctx, id);
  await evaluateAndSync(ctx, id);
  await audit(ctx, { action: 'quote.tax_position', table: 'quotation_lines', record_id: id, detail: toJson({ lines: input.lines, note: input.note ?? null }) });
  return getQuoteDetail(ctx, id);
}

/* ───────────── evaluate / override ───────────── */
export async function evaluateQuote(ctx: AppContext, id: string) {
  const quote = await loadQuote(ctx, id);
  const editable = ['draft', 'blocked', 'price_review'].includes(quote.status);
  const result = editable ? await evaluateAndSync(ctx, id, { toReview: true }) : await evaluateQuoteFull(ctx, id, { persist: true });
  await audit(ctx, { action: 'quote.evaluate', table: 'quotations', record_id: id, detail: toJson({ status: result.status, hard_stops: result.findings.filter((f) => f.severity === 'hard_stop' && !f.overridden).length }) });
  return { ...result, quote: await getQuoteDetail(ctx, id) };
}

export async function requestOverride(ctx: AppContext, input: ComplianceOverrideRequestInput) {
  if (input.entity_type === 'quotation') {
    const quote = await loadQuote(ctx, input.entity_id);
    if (!['draft', 'blocked', 'price_review', 'requote_required'].includes(quote.status)) throw invalidState(`An override cannot be requested while the quote is "${quote.status.replace('_', ' ')}"`);
    const result = await evaluateQuoteFull(ctx, quote.id, { persist: true });
    const open = new Set(result.findings.filter((f) => f.severity !== 'info' && !f.overridden).map((f) => f.gate));
    const nothing = input.gates.filter((g) => !open.has(g));
    if (nothing.length) throw guardBlocked(`There is nothing to override on ${nothing.join(', ')} — the gate has no open finding`, { gates: nothing });
    const lines = await ctx.db.table('quotation_lines').all({ quote_id: quote.id });
    const approval = await openOverrideApproval(ctx, {
      target: 'quotation', entity_id: quote.id, gates: input.gates, reason: input.reason, label: `Compliance override — quotation ${quote.quote_no} v${quote.version}`,
      extra: { line_signature: lineSignature(lines.map((l) => l.sku_id)), quote_no: quote.quote_no },
    });
    return { approval, quote: await getQuoteDetail(ctx, quote.id) };
  }
  if (input.entity_type === 'dispatch') {
    const dispatch = await ctx.db.table('dispatches').get(input.entity_id);
    if (!dispatch) throw notFound('Dispatch');
    const approval = await openOverrideApproval(ctx, { target: 'dispatch', entity_id: dispatch.id, gates: input.gates, reason: input.reason, label: `Compliance override — dispatch ${dispatch.dispatch_no}`, extra: { dispatch_id: dispatch.id, so_id: dispatch.so_id } });
    return { approval, quote: null };
  }
  const so = await ctx.db.table('sales_orders').get(input.entity_id);
  if (!so) throw notFound('Sales order');
  const approval = await openOverrideApproval(ctx, { target: 'sales_order', entity_id: so.id, gates: input.gates, reason: input.reason, label: `Compliance override — sales order ${so.so_no}`, extra: { so_id: so.id } });
  return { approval, quote: null };
}

/* ───────────── request approval (steps 22 → 23) ───────────── */
export async function requestApproval(ctx: AppContext, id: string, note?: string | null) {
  const quote = await loadQuote(ctx, id);
  if (quote.status === 'pending_approval') throw invalidState('This quote is already waiting for approval');
  if (!['draft', 'price_review', 'blocked'].includes(quote.status)) throw invalidState(`Approval cannot be requested while the quote is "${quote.status.replace('_', ' ')}"`, { status: quote.status });
  const lineCount = await ctx.db.table('quotation_lines').count({ quote_id: id });
  if (!lineCount) throw guardBlocked('Add at least one line before requesting approval');

  const result = await evaluateAndSync(ctx, id);
  const hard = result.findings.filter((f) => f.severity === 'hard_stop' && !f.overridden);
  if (hard.length) throw complianceBlocked('The quote has compliance hard stops — fix them or request a compliance override first', { findings: hard });

  const fresh = await ctx.db.table('quotations').getOrThrow(id);
  const plans = await planQuoteApprovals(ctx, fresh, toResult(result));
  if (!plans.length) {
    await ctx.db.table('quotations').update(id, { status: 'approved' });
    await audit(ctx, { action: 'quote.approved', table: 'quotations', record_id: id, detail: toJson({ lanes: [], reason: 'No approval lane was needed' }) });
  } else {
    await ctx.db.table('quotations').update(id, { status: 'pending_approval' });
    const rows = await openQuoteApprovals(ctx, fresh, plans, note);
    await audit(ctx, { action: 'quote.request_approval', table: 'quotations', record_id: id, detail: toJson({ lanes: plans.map((p) => ({ lane: p.lane, roles: p.roles, reasons: p.reasons })), approvals: rows.map((r) => r.id) }) });
  }
  return getQuoteDetail(ctx, id);
}

/* ───────────── PDF ───────────── */
function titleOf(key: string): string {
  return key.replace(/^clause\./, '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

async function buildPdfData(ctx: AppContext, quote: Quotation, draft: boolean): Promise<QuotePdfData> {
  const [lines, customer, site, owner, dealer, org, lead] = await Promise.all([
    ctx.db.table('quotation_lines').all({ quote_id: quote.id }, { orderBy: { col: 'sort_order' } }),
    quote.customer_id ? ctx.db.table('customers').get(quote.customer_id) : Promise.resolve(null),
    quote.site_id ? ctx.db.table('sites').get(quote.site_id) : Promise.resolve(null),
    quote.owner_id ? ctx.db.table('profiles').get(quote.owner_id) : Promise.resolve(null),
    quote.dealer_id ? ctx.db.table('dealers').get(quote.dealer_id) : Promise.resolve(null),
    ctx.db.table('organizations').get(ctx.org_id),
    quote.lead_id ? ctx.db.table('leads').get(quote.lead_id) : Promise.resolve(null),
  ]);
  const skuIds = [...new Set(lines.map((l) => l.sku_id).filter((s): s is string => !!s))];
  const skus = new Map((skuIds.length ? await ctx.db.table('skus').all({ id: skuIds }) : []).map((s) => [s.id, s]));
  const comps = new Map((skuIds.length ? await ctx.db.table('sku_compliance').all({ sku_id: skuIds }) : []).map((c) => [c.sku_id, c]));
  const templates = quote.clause_keys.length ? await ctx.db.table('message_templates').all({ key: quote.clause_keys, active: true }) : [];
  const clauses = quote.clause_keys.flatMap((k) => {
    const t = templates.find((x) => x.key === k && x.language === 'en') ?? templates.find((x) => x.key === k);
    return t ? [{ key: k, title: t.subject?.trim() || titleOf(k), body: t.body }] : [];
  });
  const addr = site?.address;
  const siteLine = addr ? [addr.line1, addr.city, addr.state, addr.pincode].filter(Boolean).join(', ') : site ? [site.city, site.state, site.pincode].filter(Boolean).join(', ') : null;
  return {
    quote, customerName: customer?.legal_name ?? lead?.name ?? 'Customer', siteLine, ownerName: owner?.full_name ?? null, dealerName: dealer?.legal_name ?? null,
    orgName: org?.legal_name ?? org?.name ?? 'Future Solar', orgGstin: org?.gstin ?? null,
    lines: lines.map((l, i) => {
      const gst = l.gst_rate === null ? 0 : r2(l.line_total * (l.gst_rate / 100));
      return { sl: i + 1, description: l.description, hsn: l.hsn, qty: l.qty, uom: l.uom, unit_price: l.unit_price, discount_pct: l.discount_pct, taxable: l.line_total, gst_rate: l.gst_rate, gst_amount: gst, total: r2(l.line_total + gst) };
    }),
    modules: lines.flatMap((l) => {
      const sku = l.sku_id ? skus.get(l.sku_id) : undefined;
      if (!sku || sku.category !== 'module') return [];
      const c = comps.get(sku.id);
      return [{ label: `${sku.make} ${sku.model}`, almm_list1: !!c?.almm_list1, almm_list2: !!c?.almm_list2, dcr_verified: !!c?.dcr_verified, bis: c?.bis_licence_no ? `${c.bis_licence_no}${c.bis_valid_till ? ` (valid till ${c.bis_valid_till})` : ''}` : 'not recorded', snapshot_date: c?.almm_snapshot_date ?? null }];
    }),
    findings: quote.compliance_findings, clauses, draft, generatedAt: ctx.now(),
  };
}

export async function quotePdfBuffer(ctx: AppContext, id: string): Promise<{ buffer: Buffer; file_name: string; stored: boolean }> {
  const quote = await loadQuote(ctx, id);
  const fileName = `${quote.quote_no.replace(/\//g, '-')}-v${quote.version}.pdf`;
  if (quote.pdf_document_id) {
    const doc = await ctx.db.table('documents').get(quote.pdf_document_id);
    const stored = doc ? await ctx.providers.storage.download({ bucket: 'quote-pdfs', path: doc.path }) : null;
    if (doc && stored) return { buffer: stored, file_name: doc.file_name, stored: true };
  }
  const draft = !['approved', 'sent', 'negotiation', 'accepted'].includes(quote.status);
  return { buffer: await renderQuotePdf(await buildPdfData(ctx, quote, draft)), file_name: fileName, stored: false };
}

async function storePdf(ctx: AppContext, quote: Quotation): Promise<{ buffer: Buffer; documentId: string; path: string; fileName: string }> {
  const buffer = await renderQuotePdf(await buildPdfData(ctx, quote, false));
  const fileName = `${quote.quote_no.replace(/\//g, '-')}-v${quote.version}.pdf`;
  const path = `${ctx.org_id}/${quote.id}/${ctx.now().getTime()}-${fileName}`;
  await ctx.providers.storage.upload({ bucket: 'quote-pdfs', path, content: buffer, contentType: 'application/pdf' });
  const doc = await ctx.db.table('documents').insert({ entity_type: 'quotation', entity_id: quote.id, bucket: 'quote-pdfs', path, doc_type: 'quotation_pdf', file_name: fileName, mime: 'application/pdf', size_bytes: buffer.length, uploaded_by: ctx.system ? null : ctx.user.id, created_by: ctx.system ? null : ctx.user.id });
  return { buffer, documentId: doc.id, path, fileName };
}

/* ───────────── send (step 24) ───────────── */
async function followupDays(ctx: AppContext): Promise<number[]> {
  const v = await ctx.svc.rules.value<number[]>('sla.quote_followup_days', undefined, null);
  const days = Array.isArray(v) ? v.filter((d): d is number => typeof d === 'number' && d > 0) : [];
  return days.length ? [...days].sort((a, b) => a - b) : [1, 3, 5, 7];
}

/**
 * One `quote_followup` clock per cadence day (Day 1, 3, 5, 7 from the send time). Inserted directly because ClockService.start() restarts —
 * i.e. cancels — an existing clock of the same entity and type. A missed day escalates through the clock engine (owner → DSM → Sales Manager → Management).
 */
async function startFollowupCadence(ctx: AppContext, quote: Quotation, sentAt: Date): Promise<number> {
  const days = await followupDays(ctx);
  const cal = await workCalendar(ctx);
  await ctx.svc.clocks.cancel('quotation', quote.id, 'quote_followup');
  for (const [i, day] of days.entries()) {
    const due = nextWorkingStart(addDays(sentAt, day), cal);
    const warn = new Date(sentAt.getTime() + (due.getTime() - sentAt.getTime()) * 0.7);
    await ctx.db.table('clocks').insert({
      entity_type: 'quotation', entity_id: quote.id, clock_type: 'quote_followup', started_at: sentAt.toISOString(), due_at: due.toISOString(), warn_at: warn.toISOString(), status: 'running',
      escalated_level: 0, owner_id: quote.owner_id, warned_at: null, breached_at: null, resolved_at: null, last_escalated_at: null,
      meta: toJson({ day, final: i === days.length - 1, quote_no: quote.quote_no, version: quote.version }), created_by: ctx.system ? null : ctx.user.id,
    });
  }
  return days.length;
}

/** A customer touch satisfies the earliest unresolved cadence clock. */
async function satisfyNextFollowup(ctx: AppContext, quoteId: string): Promise<void> {
  const open = await ctx.db.table('clocks').all({ entity_type: 'quotation', entity_id: quoteId, clock_type: 'quote_followup', resolved_at: null }, { orderBy: { col: 'due_at' } });
  const next = open[0];
  if (next) await ctx.db.table('clocks').update(next.id, { status: next.status === 'running' ? 'met' : next.status, resolved_at: ctx.now().toISOString() });
}

export interface SendDelivery { channel: 'email' | 'whatsapp'; status: string; blocked: boolean; reasons: { code: string; message: string }[] }

export async function sendQuote(ctx: AppContext, id: string, input: QuoteSendInput) {
  const quote = await loadQuote(ctx, id);
  if (quote.status !== 'approved') {
    throw invalidState(quote.status === 'requote_required' ? 'This quote needs a re-quote before it can be sent' : `Only an approved quote can be sent (this one is "${quote.status.replace('_', ' ')}")`, { status: quote.status });
  }
  const today = istDateString(ctx.now());
  if (quote.validity_date < today) throw invalidState('The validity date has passed — revise the quote to renew it', { validity_date: quote.validity_date });

  const result = await evaluateQuoteFull(ctx, id, { persist: true });
  // G1 (consent) is answered by the explicit per-channel consent check below, which cannot be overridden at send time
  const hard = result.findings.filter((f) => f.severity === 'hard_stop' && !f.overridden && f.gate !== 'G1');
  if (hard.length) throw complianceBlocked('The quote has compliance hard stops and cannot be sent', { findings: hard });

  if (!quote.lead_id) throw new AppError(422, 'CONSENT_BLOCKED', 'No lead is linked to this quote, so there is no consent to send it on');
  const channels = [...new Set(input.channels)];
  const allowed: ('email' | 'whatsapp')[] = [];
  const skipped: SendDelivery[] = [];
  for (const channel of channels) {
    const check = await ctx.svc.consent.checkOutbound(quote.lead_id, { channel, purpose: 'service' });
    if (check.allowed) allowed.push(channel);
    else skipped.push({ channel, status: 'blocked', blocked: true, reasons: check.reasons });
  }
  if (!allowed.length) {
    throw new AppError(422, 'CONSENT_BLOCKED', `The customer has not given consent for ${channels.join(' / ')}, so the quotation was not sent`, { reasons: skipped.flatMap((s) => s.reasons.map((r) => ({ channel: s.channel, ...r }))) });
  }

  const pdf = await storePdf(ctx, quote);
  const lead = await ctx.db.table('leads').get(quote.lead_id);
  const subject = `Quotation ${quote.quote_no} (v${quote.version}) — Future Solar`;
  const body = `${input.message ? `${input.message}\n\n` : ''}Dear ${lead?.name ?? 'Customer'},\n\nPlease find your techno-commercial quotation ${quote.quote_no} (version ${quote.version}) for a ${quote.kw} kW ${SEGMENT_LABEL[quote.segment]} system. Total payable: Rs. ${quote.total.toLocaleString('en-IN')}. This offer is valid until ${quote.validity_date}.\n\nRegards,\nFuture Solar`;
  const ownerName = (quote.owner_id ? await ctx.db.table('profiles').get(quote.owner_id) : null)?.full_name ?? 'Your Future Solar advisor';
  const deliveries: SendDelivery[] = [...skipped];
  for (const channel of allowed) {
    const res = await ctx.svc.messaging.send({
      // e-mail carries the composed message and the PDF; WhatsApp can only carry the approved template (seeded as wa.quote_sent, variables {{1}}-{{5}}), which also works outside the 24 h window
      lead_id: quote.lead_id, channel, purpose: 'service', subject,
      ...(channel === 'whatsapp' ? { template_key: 'wa.quote_sent' } : { body }),
      vars: {
        quote_no: quote.quote_no, version: String(quote.version), total: String(quote.total), validity_date: quote.validity_date, customer_name: lead?.name ?? 'Customer',
        '1': (lead?.name ?? 'Customer').split(/\s+/)[0] ?? 'Customer', '2': quote.quote_no, '3': String(quote.kw), '4': quote.validity_date, '5': ownerName,
      },
      attachments: channel === 'email' ? [{ filename: pdf.fileName, content: pdf.buffer, contentType: 'application/pdf' }] : undefined,
    });
    deliveries.push({ channel, status: res.status, blocked: res.blocked, reasons: res.reasons });
  }
  if (!deliveries.some((d) => !d.blocked && d.status !== 'failed')) {
    throw new AppError(422, 'CONSENT_BLOCKED', 'The quotation could not be delivered on any channel', { deliveries });
  }

  const sentAt = ctx.now();
  await ctx.db.table('quotations').update(id, { status: 'sent', sent_at: sentAt.toISOString(), pdf_document_id: pdf.documentId });
  const cadence = await startFollowupCadence(ctx, quote, sentAt);
  await audit(ctx, { action: 'quote.send', table: 'quotations', record_id: id, detail: toJson({ deliveries, followup_clocks: cadence, document_id: pdf.documentId, compliance_status: result.status }) });
  await leadEvent(ctx, quote.lead_id, 'quote_sent', `Quotation ${quote.quote_no} v${quote.version} sent to the customer`, { quote_id: id });
  return { quote: await getQuoteDetail(ctx, id), deliveries, followup_clocks: cadence, document_id: pdf.documentId };
}

/* ───────────── discussion / accept / reject / revise ───────────── */
export async function addDiscussion(ctx: AppContext, id: string, input: QuoteDiscussionInput) {
  const quote = await loadQuote(ctx, id);
  if (!['sent', 'negotiation'].includes(quote.status)) throw invalidState('Customer discussions can be logged only after the quotation has been sent');
  const row = await ctx.db.table('quote_discussions').insert({
    quote_id: id, kind: input.kind, outcome: input.outcome ?? null, notes: input.notes ?? null, logged_by: ctx.user.id, logged_at: ctx.now().toISOString(), next_followup_at: input.next_followup_at ?? null, created_by: ctx.user.id,
  });
  if (quote.status === 'sent') {
    await ctx.db.table('quotations').update(id, { status: 'negotiation' });
    const opp = await ctx.db.table('opportunities').get(quote.opportunity_id);
    if (opp && opp.stage === 'quotation') await ctx.db.table('opportunities').update(opp.id, { stage: 'negotiation' });
  }
  await satisfyNextFollowup(ctx, id);
  await audit(ctx, { action: 'quote.discussion', table: 'quote_discussions', record_id: row.id, new: toJson(row) });
  await leadEvent(ctx, quote.lead_id, 'quote_discussion', `Customer discussion logged on ${quote.quote_no} (${input.kind})`, { quote_id: id });
  return row;
}

export async function acceptQuote(ctx: AppContext, id: string, note?: string | null) {
  const quote = await loadQuote(ctx, id);
  if (!['sent', 'negotiation'].includes(quote.status)) throw invalidState(`Only a sent quotation can be accepted (this one is "${quote.status.replace('_', ' ')}")`);
  if (quote.validity_date < istDateString(ctx.now())) throw invalidState('The validity date has passed — revise the quote to renew it');
  const now = ctx.now().toISOString();
  await ctx.db.table('quotations').update(id, { status: 'accepted', accepted_at: now, terms_confirmed_at: now });
  await ctx.svc.clocks.cancel('quotation', id, 'quote_followup');
  const opp = await ctx.db.table('opportunities').get(quote.opportunity_id);
  if (opp) await ctx.db.table('opportunities').update(opp.id, { stage: 'pi_stage', expected_value: quote.total });
  await audit(ctx, { action: 'quote.accept', table: 'quotations', record_id: id, detail: toJson({ note: note ?? null }) });
  await leadEvent(ctx, quote.lead_id, 'quote_accepted', `Quotation ${quote.quote_no} v${quote.version} accepted — commercial terms confirmed`, { quote_id: id });
  await ctx.svc.notify.notify({ roles: ['accounts'], user_ids: quote.owner_id ? [quote.owner_id] : [], kind: 'quote.accepted', title: `Quotation ${quote.quote_no} accepted`, body: 'Commercial terms are confirmed. Prepare the proforma invoice.', severity: 'success', entity_type: 'quotation', entity_id: id });
  return getQuoteDetail(ctx, id);
}

/** A deal can be called off at any live stage: by the customer on a call, or by the team. The quotation is closed as rejected and can be revised to start again. */
const CANCELLABLE = ['draft', 'blocked', 'price_review', 'pending_approval', 'approved', 'sent', 'negotiation', 'accepted', 'requote_required'];
export async function rejectQuote(ctx: AppContext, id: string, reason: string) {
  const quote = await loadQuote(ctx, id);
  if (!CANCELLABLE.includes(quote.status)) throw invalidState(`This quotation is "${quote.status.replace('_', ' ')}" and cannot be cancelled`);
  await ctx.db.table('quotations').update(id, { status: 'rejected', rejected_reason: reason });
  // approvals still waiting are no longer needed
  for (const ap of await ctx.db.table('approvals').all({ entity_type: 'quotation', entity_id: id, decision: 'pending' })) {
    await ctx.db.table('approvals').update(ap.id, { decision: 'skipped', comment: 'Closed — the deal was cancelled' });
  }
  await ctx.svc.clocks.cancel('quotation', id, 'quote_followup');
  await audit(ctx, { action: 'quote.reject', table: 'quotations', record_id: id, detail: toJson({ reason, from: quote.status }) });
  const byCustomer = ['sent', 'negotiation', 'accepted'].includes(quote.status);
  await leadEvent(ctx, quote.lead_id, 'quote_rejected', byCustomer ? `Quotation ${quote.quote_no} v${quote.version} declined by the customer` : `Quotation ${quote.quote_no} v${quote.version} cancelled`, { quote_id: id, reason });
  return getQuoteDetail(ctx, id);
}

export async function reviseQuote(ctx: AppContext, id: string, opts: { reprice?: boolean; note?: string | null }) {
  const src = await loadQuote(ctx, id);
  if (!REVISABLE.includes(src.status)) throw invalidState(`A quote that is "${src.status.replace('_', ' ')}" cannot be revised`, { status: src.status });
  const child = await ctx.db.table('quotations').one({ parent_quote_id: src.id });
  if (child) throw conflict('This quotation already has a newer version', { quote_id: child.id });
  const chain = await ctx.db.table('quotations').all({ quote_no: src.quote_no });
  const version = chain.reduce((m, q) => Math.max(m, q.version), 0) + 1;
  const now = ctx.now();
  const today = istDateString(now);
  const reprice = opts.reprice ?? (src.status === 'requote_required' || src.status === 'expired');
  const srcLines = await ctx.db.table('quotation_lines').all({ quote_id: src.id }, { orderBy: { col: 'sort_order' } });

  const ruleIds: string[] = [];
  const validity = (await defaultValidity(ctx, { quoteDate: today, snapshotAt: now.toISOString(), exemptionReliance: src.exemption_reliance, refDate: src.expected_commissioning_date ?? today, priceValidTos: [], ruleIds })).date;
  const next = await ctx.db.table('quotations').insert({
    ...copyHeader(src), quote_no: src.quote_no, version, parent_quote_id: src.id, status: 'draft', validity_date: validity, price_snapshot_at: reprice ? now.toISOString() : src.price_snapshot_at,
    compliance_status: 'pending', compliance_findings: [], compliance_evaluated_at: null, rule_ids_used: [...new Set(ruleIds)], requote_reason: null,
    sent_at: null, accepted_at: null, rejected_reason: null, pdf_document_id: null, terms_confirmed_at: null, created_by: ctx.user.id,
  });
  if (reprice) {
    const { drafts } = await buildLineDrafts(ctx, next, srcLines.map((l) => ({ sku_id: l.sku_id, description: l.description, hsn: l.hsn, qty: l.qty, discount_pct: l.discount_pct, uom: l.uom })), srcLines, today);
    if (drafts.length) await ctx.db.table('quotation_lines').insertMany(drafts.map((d) => ({ ...d, quote_id: next.id, created_by: ctx.user.id })));
  } else if (srcLines.length) {
    await ctx.db.table('quotation_lines').insertMany(srcLines.map(({ id: _id, quote_id: _q, created_at: _c, updated_at: _u, ...l }) => ({ ...l, quote_id: next.id, created_by: ctx.user.id })));
  }
  await ctx.db.table('quotations').update(src.id, { status: 'revised' });
  await closeQuoteWorkflow(ctx, src, 'Quote revised');
  await recalcQuote(ctx, next.id);
  await evaluateAndSync(ctx, next.id);
  await audit(ctx, { action: 'quote.revise', table: 'quotations', record_id: next.id, old: toJson({ id: src.id, status: src.status, version: src.version }), new: toJson({ version, parent_quote_id: src.id, repriced: reprice }), detail: toJson({ note: opts.note ?? null }) });
  await leadEvent(ctx, src.lead_id, 'quote_revised', `Quotation ${src.quote_no} revised to v${version}`, { quote_id: next.id, parent_quote_id: src.id });
  return getQuoteDetail(ctx, next.id);
}

/** Header fields carried over to a new version. */
function copyHeader(q: Quotation): Omit<Partial<Quotation>, 'id'> {
  return {
    opportunity_id: q.opportunity_id, lead_id: q.lead_id, customer_id: q.customer_id, site_id: q.site_id, segment: q.segment, kw: q.kw, expected_commissioning_date: q.expected_commissioning_date,
    tax_position_approved: q.tax_position_approved, clause_keys: q.clause_keys, place_of_supply: q.place_of_supply, payment_terms: q.payment_terms,
    subtotal: q.subtotal, discount_pct: q.discount_pct, discount_amount: q.discount_amount, freight: q.freight, tax_total: q.tax_total, total: q.total, margin_pct: q.margin_pct, floor_check: q.floor_check,
    cfa_entitlement: q.cfa_entitlement, state_share: q.state_share, loan_share: q.loan_share, consumer_share: q.consumer_share, cfa_breakdown: q.cfa_breakdown, loan_rate_pct: q.loan_rate_pct,
    loan_rate_source_date: q.loan_rate_source_date, exemption_reliance: q.exemption_reliance, owner_id: q.owner_id, distributor_id: q.distributor_id, dealer_id: q.dealer_id, territory_id: q.territory_id,
  };
}

/* ───────────── convenience for other modules ───────────── */
export async function quoteSummary(ctx: AppContext, id: string): Promise<{ quote: Quotation; lines: QuotationLine[]; lead: Lead | null; opportunity: Opportunity | null; site: Site | null }> {
  const quote = await loadQuote(ctx, id);
  const [lines, lead, opportunity, site] = await Promise.all([
    ctx.db.table('quotation_lines').all({ quote_id: id }, { orderBy: { col: 'sort_order' } }),
    quote.lead_id ? ctx.db.table('leads').get(quote.lead_id) : Promise.resolve(null),
    ctx.db.table('opportunities').get(quote.opportunity_id),
    quote.site_id ? ctx.db.table('sites').get(quote.site_id) : Promise.resolve(null),
  ]);
  return { quote, lines, lead, opportunity, site };
}

