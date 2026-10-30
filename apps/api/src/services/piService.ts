/**
 * Stage 5, steps 28-29: pre-PI checklist, proforma invoice (draft -> approval -> issued) and its PDF.
 * The PI is created from an ACCEPTED quotation; issuing is blocked while any pre-PI checklist item is false.
 */
import { randomUUID } from 'node:crypto';
import {
  GSTIN_UNREGISTERED, PRE_PI_LABELS, UNREGISTERED_ALLOWED_CUSTOMER_TYPES, evaluatePreFlight,
  type Address, type Approval, type Customer, type CustomerType, type Lead, type PiDetail, type PiSummary, type PreFlightChecklist, type PreFlightResult,
  type ProformaInvoice, type ProformaInvoiceLine, type Quotation, type QuotationLine, type Site, type CreatePiInput, type UpdatePiInput, type AppRole,
} from '@solar/shared';
import type { AppContext } from '../auth/context';
import { assertCanRead } from '../auth/access';
import { conflict, guardBlocked, invalidState, notFound } from '../http/errors';
import { audit } from '../lib/audit';
import { registerApprovalHandler, type ApprovalOutcome } from './hooks';
import { renderPiPdf } from './orderPdf';
import {
  actorId, activateNextStep, addDaysToDate, advanceReceived, advanceSatisfied, insertNumbered, managementApprovalAbove, minAdvancePct, nextNumber, openApproval, partyUserIds, piValidityDays,
  requiredAdvance, roundState, round2, skipPending, todayIst, toJson, yy,
} from './orderSupport';

export const PI_ISSUED_STATUSES: ProformaInvoice['status'][] = ['issued', 'partially_paid', 'paid'];

/* ───────────── quote + customer context ───────────── */

interface QuoteContext { quote: Quotation; lines: QuotationLine[]; customer: Customer | null; lead: Lead | null; site: Site | null; customer_type: CustomerType | null }

async function loadQuoteContext(ctx: AppContext, quote: Quotation): Promise<QuoteContext> {
  const [lines, customer, lead, site] = await Promise.all([
    ctx.db.table('quotation_lines').all({ quote_id: quote.id }, { orderBy: { col: 'sort_order' } }),
    quote.customer_id ? ctx.db.table('customers').get(quote.customer_id) : Promise.resolve(null),
    quote.lead_id ? ctx.db.table('leads').get(quote.lead_id) : Promise.resolve(null),
    quote.site_id ? ctx.db.table('sites').get(quote.site_id) : Promise.resolve(null),
  ]);
  return { quote, lines, customer, lead, site, customer_type: customer?.customer_type ?? lead?.customer_type ?? null };
}

interface PiDetails { legal_name: string | null; gstin: string | null; billing_address: Address | null; shipping_address: Address | null; payment_terms: string | null; freight: number }

function defaultsFor(q: QuoteContext): PiDetails {
  return {
    legal_name: q.customer?.legal_name ?? q.lead?.name ?? null,
    gstin: q.customer?.gstin ?? null,
    billing_address: q.customer?.billing_address ?? null,
    shipping_address: q.customer?.shipping_address ?? q.site?.address ?? q.customer?.billing_address ?? null,
    payment_terms: q.quote.payment_terms,
    freight: q.quote.freight,
  };
}

type DetailInput = Partial<Pick<CreatePiInput, 'legal_name' | 'gstin' | 'gst_unregistered' | 'billing_address' | 'shipping_address' | 'payment_terms' | 'freight'>>;
function applyDetails(base: PiDetails, input: DetailInput): PiDetails {
  const out: PiDetails = { ...base };
  if (input.legal_name !== undefined) out.legal_name = input.legal_name;
  if (input.billing_address !== undefined) out.billing_address = input.billing_address;
  if (input.shipping_address !== undefined) out.shipping_address = input.shipping_address;
  if (input.payment_terms !== undefined) out.payment_terms = input.payment_terms;
  if (input.freight !== undefined) out.freight = input.freight;
  if (input.gst_unregistered === true) out.gstin = GSTIN_UNREGISTERED;
  else if (input.gstin !== undefined) out.gstin = input.gstin;
  else if (input.gst_unregistered === false && out.gstin === GSTIN_UNREGISTERED) out.gstin = null;
  return out;
}

/** PI money fields from the accepted quote; a freight override shifts the total and the consumer share by the difference. */
function totalsFor(quote: Quotation, freight: number) {
  const delta = round2(freight - quote.freight);
  return {
    subtotal: round2(quote.total - quote.freight - quote.tax_total), freight, tax_total: quote.tax_total, total: round2(quote.total + delta),
    consumer_share: round2(quote.consumer_share + delta), loan_share: quote.loan_share, subsidy_receivable: round2(quote.cfa_entitlement + quote.state_share),
  };
}

const labels = (missing: (keyof PreFlightChecklist)[]): string[] => missing.map((k) => PRE_PI_LABELS[k]);

/* ───────────── pre-PI checklist ───────────── */

export async function preFlightForQuote(ctx: AppContext, quoteId: string): Promise<PreFlightResult> {
  const quote = await ctx.db.table('quotations').get(quoteId);
  if (!quote) throw notFound('Quotation');
  await assertCanRead(ctx, 'quotations', quote);
  const q = await loadQuoteContext(ctx, quote);
  const d = defaultsFor(q);
  const pf = evaluatePreFlight({ ...d, customer_type: q.customer_type, lines: q.lines });
  const pi = await ctx.db.table('proforma_invoices').one({ quote_id: quote.id, status: { nin: ['cancelled'] } });
  return {
    quote_id: quote.id, quote_no: quote.quote_no, quote_status: quote.status, accepted: quote.status === 'accepted', pi_id: pi?.id ?? null,
    checklist: pf.checklist, missing: pf.missing, missing_labels: labels(pf.missing), complete: pf.complete,
    defaults: { ...d, customer_type: q.customer_type, unregistered_allowed: !!q.customer_type && UNREGISTERED_ALLOWED_CUSTOMER_TYPES.includes(q.customer_type) },
  };
}

/** Live checklist for a PI row from its own (possibly overridden) fields and lines. */
async function checklistForPi(ctx: AppContext, pi: ProformaInvoice, lines?: ProformaInvoiceLine[]) {
  const piLines = lines ?? (await ctx.db.table('proforma_invoice_lines').all({ pi_id: pi.id }, { orderBy: { col: 'sort_order' } }));
  const quote = await ctx.db.table('quotations').get(pi.quote_id);
  const customer = pi.customer_id ? await ctx.db.table('customers').get(pi.customer_id) : null;
  const lead = quote?.lead_id ? await ctx.db.table('leads').get(quote.lead_id) : null;
  return evaluatePreFlight({
    legal_name: pi.legal_name, gstin: pi.gstin, billing_address: pi.billing_address, shipping_address: pi.shipping_address, payment_terms: pi.payment_terms, freight: pi.freight,
    customer_type: customer?.customer_type ?? lead?.customer_type ?? null, lines: piLines,
  });
}

/* ───────────── create / update / submit / cancel ───────────── */

export async function loadPi(ctx: AppContext, id: string): Promise<ProformaInvoice> {
  const pi = await ctx.db.table('proforma_invoices').get(id);
  if (!pi) throw notFound('Proforma invoice');
  await assertCanRead(ctx, 'proforma_invoices', pi);
  return pi;
}

export async function createPi(ctx: AppContext, input: CreatePiInput): Promise<PiDetail> {
  const quote = await ctx.db.table('quotations').get(input.quote_id);
  if (!quote) throw notFound('Quotation');
  await assertCanRead(ctx, 'quotations', quote);
  if (quote.status !== 'accepted') throw invalidState(`Only an accepted quotation can become a proforma invoice (this one is "${quote.status}")`, { quote_status: quote.status });
  const existing = await ctx.db.table('proforma_invoices').one({ quote_id: quote.id, status: { nin: ['cancelled'] } });
  if (existing) throw conflict(`Proforma invoice ${existing.pi_no} already exists for this quotation`, { pi_id: existing.id, pi_no: existing.pi_no });

  const q = await loadQuoteContext(ctx, quote);
  const d = applyDetails(defaultsFor(q), input);
  const pf = evaluatePreFlight({ ...d, customer_type: q.customer_type, lines: q.lines });
  const prefix = `FS/PI/${yy(ctx)}/`;
  const pi = await insertNumbered(async () => {
    const nos = (await ctx.db.table('proforma_invoices').all({ pi_no: { like: `${prefix}%` } })).map((r) => r.pi_no);
    return ctx.db.table('proforma_invoices').insert({
      pi_no: nextNumber(nos, prefix), quote_id: quote.id, opportunity_id: quote.opportunity_id, customer_id: quote.customer_id, dealer_id: quote.dealer_id, distributor_id: quote.distributor_id,
      status: 'draft', legal_name: d.legal_name, gstin: d.gstin, billing_address: d.billing_address, shipping_address: d.shipping_address, payment_terms: d.payment_terms,
      ...totalsFor(quote, d.freight), pre_pi_checklist: pf.checklist, issue_date: null, valid_till: null, approved_by: null, issued_at: null, sales_order_id: null, created_by: actorId(ctx),
    });
  });
  await ctx.db.table('proforma_invoice_lines').insertMany(q.lines.map((l, i) => ({
    pi_id: pi.id, sku_id: l.sku_id, description: l.description, hsn: l.hsn, gst_rate: l.gst_rate, qty: l.qty, unit_price: l.unit_price, line_total: l.line_total, sort_order: l.sort_order ?? i, created_by: actorId(ctx),
  })));
  if (quote.opportunity_id) {
    const opp = await ctx.db.table('opportunities').get(quote.opportunity_id);
    if (opp && opp.stage !== 'won' && opp.stage !== 'lost' && opp.stage !== 'pi_stage') await ctx.db.table('opportunities').update(opp.id, { stage: 'pi_stage' });
  }
  await audit(ctx, { action: 'pi.create', table: 'proforma_invoices', record_id: pi.id, new: toJson(pi), detail: { quote_id: quote.id, checklist_complete: pf.complete } });
  return piDetail(ctx, pi.id);
}

export async function updatePi(ctx: AppContext, id: string, input: UpdatePiInput): Promise<PiDetail> {
  const pi = await loadPi(ctx, id);
  if (pi.status !== 'draft') throw invalidState(`Only a draft proforma invoice can be edited (this one is "${pi.status}")`, { status: pi.status });
  const quote = await ctx.db.table('quotations').getOrThrow(pi.quote_id);
  const base: PiDetails = { legal_name: pi.legal_name, gstin: pi.gstin, billing_address: pi.billing_address, shipping_address: pi.shipping_address, payment_terms: pi.payment_terms, freight: pi.freight };
  const d = applyDetails(base, input);
  const lines = await ctx.db.table('proforma_invoice_lines').all({ pi_id: pi.id }, { orderBy: { col: 'sort_order' } });
  const next: ProformaInvoice = { ...pi, ...d, ...(input.freight !== undefined ? totalsFor(quote, d.freight) : {}) };
  const pf = await checklistForPi(ctx, next, lines);
  const row = await ctx.db.table('proforma_invoices').update(pi.id, {
    legal_name: d.legal_name, gstin: d.gstin, billing_address: d.billing_address, shipping_address: d.shipping_address, payment_terms: d.payment_terms,
    ...(input.freight !== undefined ? totalsFor(quote, d.freight) : {}), pre_pi_checklist: pf.checklist,
  });
  await audit(ctx, { action: 'pi.update', table: 'proforma_invoices', record_id: pi.id, old: toJson(pi), new: toJson(row) });
  return piDetail(ctx, pi.id);
}

/** Step 28 -> 29: refuse while the checklist is incomplete, then open the approval (lane credit, Accounts [+ Management on large orders]). */
export async function submitPi(ctx: AppContext, id: string): Promise<PiDetail> {
  const pi = await loadPi(ctx, id);
  if (pi.status !== 'draft') throw invalidState(`Only a draft proforma invoice can be submitted (this one is "${pi.status}")`, { status: pi.status });
  const pf = await checklistForPi(ctx, pi);
  await ctx.db.table('proforma_invoices').update(pi.id, { pre_pi_checklist: pf.checklist });
  if (!pf.complete) {
    throw guardBlocked(`The pre-PI checklist is incomplete — ${labels(pf.missing).join('; ')}`, { gate: 'PRE_PI_CHECKLIST', checklist: pf.checklist, missing: pf.missing, missing_labels: labels(pf.missing) });
  }
  const chain: AppRole[] = pi.total >= (await managementApprovalAbove(ctx)) ? ['accounts', 'management'] : ['accounts'];
  await openApproval(ctx, { entity_type: 'proforma_invoice', entity_id: pi.id, lane: 'credit', chain, label: `PI ${pi.pi_no}`, extra: { pi_no: pi.pi_no, total: pi.total } });
  await ctx.db.table('proforma_invoices').update(pi.id, { status: 'pending_approval' });
  await audit(ctx, { action: 'pi.submit', table: 'proforma_invoices', record_id: pi.id, detail: { chain } });
  return piDetail(ctx, pi.id);
}

export async function cancelPi(ctx: AppContext, id: string, note?: string): Promise<PiDetail> {
  const pi = await loadPi(ctx, id);
  if (pi.status === 'cancelled') throw invalidState('This proforma invoice is already cancelled');
  if (pi.sales_order_id) {
    const so = await ctx.db.table('sales_orders').get(pi.sales_order_id);
    if (so && so.status !== 'cancelled') throw invalidState(`Sales order ${so.so_no} is open against this PI — cancel the sales order first`, { so_id: so.id });
  }
  const received = await advanceReceived(ctx, pi.id);
  if (received > 0) throw invalidState('Payments have been received against this PI — it cannot be cancelled', { received });
  await skipPending(ctx, 'proforma_invoice', pi.id);
  const row = await ctx.db.table('proforma_invoices').update(pi.id, { status: 'cancelled' });
  await audit(ctx, { action: 'pi.cancel', table: 'proforma_invoices', record_id: pi.id, old: toJson(pi), new: toJson(row), detail: { note: note ?? null } });
  return piDetail(ctx, pi.id);
}

/* ───────────── hydration ───────────── */

export async function hydratePis(ctx: AppContext, pis: ProformaInvoice[]): Promise<PiSummary[]> {
  if (!pis.length) return [];
  const [quotes, dealers, payments] = await Promise.all([
    ctx.db.table('quotations').all({ id: [...new Set(pis.map((p) => p.quote_id))] }),
    ctx.db.table('dealers').all({ id: [...new Set(pis.map((p) => p.dealer_id).filter((x): x is string => !!x))] }),
    ctx.db.table('payments').all({ pi_id: pis.map((p) => p.id), status: 'received' }),
  ]);
  return pis.map((p) => {
    const paid = round2(payments.filter((x) => x.pi_id === p.id).reduce((s, x) => s + x.amount, 0));
    return { ...p, quote_no: quotes.find((q) => q.id === p.quote_id)?.quote_no ?? null, dealer_name: dealers.find((d) => d.id === p.dealer_id)?.legal_name ?? null, paid_amount: paid, balance: round2(Math.max(0, p.total - paid)) };
  });
}

export async function piDetail(ctx: AppContext, id: string): Promise<PiDetail> {
  const pi = await loadPi(ctx, id);
  const [summary] = await hydratePis(ctx, [pi]);
  const [lines, payments, checks, overrides, approvals, so, pct] = await Promise.all([
    ctx.db.table('proforma_invoice_lines').all({ pi_id: pi.id }, { orderBy: { col: 'sort_order' } }),
    ctx.db.table('payments').all({ pi_id: pi.id }, { orderBy: { col: 'received_at', dir: 'asc' } }),
    ctx.db.table('credit_checks').all({ pi_id: pi.id }, { orderBy: { col: 'created_at', dir: 'desc' } }),
    ctx.db.table('credit_overrides').all({ pi_id: pi.id }, { orderBy: { col: 'created_at', dir: 'desc' } }),
    ctx.db.table('approvals').all({ entity_type: 'proforma_invoice', entity_id: pi.id }, { orderBy: [{ col: 'requested_at' }, { col: 'step' }] }),
    pi.sales_order_id ? ctx.db.table('sales_orders').get(pi.sales_order_id) : Promise.resolve(null),
    minAdvancePct(ctx),
  ]);
  const pf = await checklistForPi(ctx, pi, lines);
  const advance = summary!.paid_amount;
  return {
    ...summary!, lines, payments, advance_pct: pct, required_advance: requiredAdvance(pi.total, pct), advance_ok: advanceSatisfied(advance, pi.total, pct),
    credit_checks: checks, credit_check: checks[0] ?? null, credit_overrides: overrides, approvals, sales_order: so, missing_labels: labels(pf.missing), unregistered: pi.gstin === GSTIN_UNREGISTERED,
  };
}

/* ───────────── PDF ───────────── */

export async function piPdf(ctx: AppContext, id: string, opts: { refresh?: boolean } = {}): Promise<{ document_id: string; content: Buffer; url: string; expires_at: string; file_name: string }> {
  const pi = await loadPi(ctx, id);
  const fileName = `${pi.pi_no.replace(/\//g, '-')}.pdf`;
  const sign = async (path: string) => ctx.providers.storage.signedUrl({ bucket: 'invoices', path, method: 'GET', expiresInSec: 600 });
  const prior = (await ctx.db.table('documents').all({ entity_type: 'proforma_invoice', entity_id: pi.id, doc_type: 'pi_pdf' }, { orderBy: { col: 'created_at', dir: 'desc' } }))[0];
  if (prior && !opts.refresh && prior.created_at >= pi.updated_at) {
    const cached = await ctx.providers.storage.download({ bucket: 'invoices', path: prior.path });
    if (cached) { const s = await sign(prior.path); return { document_id: prior.id, content: cached, url: s.url, expires_at: s.expires_at, file_name: prior.file_name }; }
  }
  const [lines, org, quote, paid] = await Promise.all([
    ctx.db.table('proforma_invoice_lines').all({ pi_id: pi.id }, { orderBy: { col: 'sort_order' } }),
    ctx.db.table('organizations').get(ctx.org_id), ctx.db.table('quotations').get(pi.quote_id), advanceReceived(ctx, pi.id),
  ]);
  const content = await renderPiPdf({
    org: { name: org?.name ?? 'Future Solar', legal_name: org?.legal_name ?? 'Future Solar', gstin: org?.gstin ?? null, address: org?.address ?? null },
    pi, lines, quote_no: quote?.quote_no ?? null, place_of_supply: quote?.place_of_supply ?? null, paid_amount: paid,
  });
  const path = `${ctx.org_id}/proforma_invoice/${pi.id}/${randomUUID()}-${fileName}`;
  await ctx.providers.storage.upload({ bucket: 'invoices', path, content, contentType: 'application/pdf' });
  const doc = await ctx.db.table('documents').insert({
    entity_type: 'proforma_invoice', entity_id: pi.id, bucket: 'invoices', path, doc_type: 'pi_pdf', file_name: fileName, mime: 'application/pdf', size_bytes: content.length,
    uploaded_by: actorId(ctx), created_by: actorId(ctx),
  });
  await audit(ctx, { action: 'pi.pdf', table: 'documents', record_id: doc.id, detail: { pi_id: pi.id, bytes: content.length } });
  const s = await sign(path);
  return { document_id: doc.id, content, url: s.url, expires_at: s.expires_at, file_name: fileName };
}

/* ───────────── approval handler (step 29) ───────────── */

async function onPiApproval(ctx: AppContext, approval: Approval, outcome: ApprovalOutcome): Promise<void> {
  const pi = await ctx.db.table('proforma_invoices').get(approval.entity_id);
  if (!pi || pi.status !== 'pending_approval') return;
  const state = await roundState(ctx, approval);
  const requester = approval.requested_by ? [approval.requested_by] : [];

  if (outcome === 'rejected' || state.rejected) {
    await skipPending(ctx, 'proforma_invoice', pi.id);
    await ctx.db.table('proforma_invoices').update(pi.id, { status: 'draft' });
    await audit(ctx, { action: 'pi.approval_rejected', table: 'proforma_invoices', record_id: pi.id, detail: { comment: (state.rejected ?? approval).comment ?? null } });
    if (requester.length) await ctx.svc.notify.notify({ user_ids: requester, kind: 'pi.rejected', title: `PI ${pi.pi_no} was not approved`, body: (state.rejected ?? approval).comment ?? 'It has been returned to draft for correction.', severity: 'warning', entity_type: 'proforma_invoice', entity_id: pi.id });
    return;
  }
  if (!(outcome === 'lane_approved' || state.allApproved)) {
    if (outcome === 'step_approved') await activateNextStep(ctx, approval); // an intermediate step: hand over to the next approver
    return;
  }

  const pf = await checklistForPi(ctx, pi);
  if (!pf.complete) {
    // data changed after submission: do not issue an incomplete PI
    await ctx.db.table('proforma_invoices').update(pi.id, { status: 'draft', pre_pi_checklist: pf.checklist });
    await audit(ctx, { action: 'pi.issue_blocked', table: 'proforma_invoices', record_id: pi.id, detail: { missing: pf.missing } });
    if (requester.length) await ctx.svc.notify.notify({ user_ids: requester, kind: 'pi.issue_blocked', title: `PI ${pi.pi_no} cannot be issued yet`, body: `Checklist incomplete: ${labels(pf.missing).join('; ')}`, severity: 'warning', entity_type: 'proforma_invoice', entity_id: pi.id });
    return;
  }
  const today = todayIst(ctx);
  const days = await piValidityDays(ctx);
  const row = await ctx.db.table('proforma_invoices').update(pi.id, {
    status: 'issued', issue_date: today, valid_till: addDaysToDate(today, days), approved_by: state.lastApprover, issued_at: ctx.now().toISOString(), pre_pi_checklist: pf.checklist,
  });
  await audit(ctx, { action: 'pi.issue', table: 'proforma_invoices', record_id: pi.id, old: toJson(pi), new: toJson(row), detail: { valid_till: row.valid_till } });
  const parties = await partyUserIds(ctx, { distributor_id: pi.distributor_id, dealer_id: pi.dealer_id });
  await ctx.svc.notify.notify({ user_ids: [...new Set([...requester, ...parties])], kind: 'pi.issued', title: `Proforma invoice ${pi.pi_no} issued`, body: `Valid till ${row.valid_till}.`, severity: 'success', entity_type: 'proforma_invoice', entity_id: pi.id });
}
registerApprovalHandler('proforma_invoice', onPiApproval);
