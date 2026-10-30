/**
 * Privacy & data-protection operations: data-principal access export (DSAR), erasure / anonymisation,
 * the nightly retention job and the unmask-event viewer.
 *
 * Erasure keeps what the law and the business need — consent-ledger metadata, aggregates, and statutory financial records
 * (issued invoices, orders) with their amounts and GST data — and removes or anonymises everything else that identifies the person.
 */
import { randomUUID } from 'node:crypto';
import {
  maskEmail, maskMobile,
  type AuditLog, type Customer, type DataRequest, type DocumentRow, type Json, type Lead, type LeadStatus, type MessageLog, type TableName, type TableRow,
} from '@solar/shared';
import { AppError, guardBlocked, invalidState, notFound } from '../http/errors';
import type { AppContext } from '../auth/context';
import { audit } from '../lib/audit';
import type { Where } from '../db/types';
import { decideSeverity } from './severity';

/* ───────────── helpers ───────────── */
async function rowsWhere<K extends TableName>(ctx: AppContext, table: K, col: string, ids: string[]): Promise<TableRow<K>[]> {
  if (!ids.length) return [];
  return ctx.db.table(table).all({ [col]: [...new Set(ids)] });
}
const uniq = (xs: string[]): string[] => [...new Set(xs)];

/** Masks e-mail addresses and phone-like digit runs inside free text. */
export function maskFreeText(s: string | null): string | null {
  if (s === null) return null;
  return s
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, (m) => maskEmail(m))
    .replace(/(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}/g, (m) => maskMobile(m))
    .replace(/\d{9,}/g, '•••');
}

interface Subject { leads: Lead[]; customers: Customer[] }

/** The person behind a lead or a customer: that lead + its duplicates/master, and every customer record linked to them. */
async function resolveSubject(ctx: AppContext, input: { lead_id?: string; customer_id?: string }): Promise<Subject> {
  const leads = new Map<string, Lead>();
  const customers = new Map<string, Customer>();
  const addLead = (l: Lead | null) => { if (l) leads.set(l.id, l); };
  const addCustomer = (c: Customer | null) => { if (c) customers.set(c.id, c); };
  if (input.lead_id) {
    const lead = await ctx.db.table('leads').get(input.lead_id);
    if (!lead) throw notFound('Lead');
    addLead(lead);
  } else if (input.customer_id) {
    const customer = await ctx.db.table('customers').get(input.customer_id);
    if (!customer) throw notFound('Customer');
    addCustomer(customer);
    if (customer.lead_id) addLead(await ctx.db.table('leads').get(customer.lead_id));
    for (const l of await ctx.db.table('leads').all({ customer_id: customer.id })) addLead(l);
  }
  // duplicates of / the master of the same person
  for (const l of [...leads.values()]) {
    for (const d of await ctx.db.table('leads').all({ duplicate_of: l.id })) addLead(d);
    if (l.duplicate_of) addLead(await ctx.db.table('leads').get(l.duplicate_of));
  }
  for (const l of leads.values()) {
    if (l.customer_id) addCustomer(await ctx.db.table('customers').get(l.customer_id));
  }
  for (const c of await rowsWhere(ctx, 'customers', 'lead_id', [...leads.keys()])) addCustomer(c);
  return { leads: [...leads.values()], customers: [...customers.values()] };
}

/* ───────────── data-principal access request (export) ───────────── */
export interface ExportBundle {
  generated_at: string; generated_by: string;
  subject: { lead_ids: string[]; customer_ids: string[] };
  summary: Record<string, number>;
  data: {
    leads: Lead[]; consents: TableRow<'lead_consents'>[]; events: TableRow<'lead_events'>[]; contact_logs: TableRow<'contact_logs'>[]; followups: TableRow<'followups'>[];
    messages: MessageLog[]; customers: Customer[]; sites: TableRow<'sites'>[]; site_surveys: TableRow<'site_surveys'>[]; requirement_forms: TableRow<'requirement_forms'>[];
    opportunities: TableRow<'opportunities'>[]; negotiation_logs: TableRow<'negotiation_logs'>[]; quotes: (TableRow<'quotations'> & { lines: TableRow<'quotation_lines'>[] })[];
    proforma_invoices: TableRow<'proforma_invoices'>[]; sales_orders: TableRow<'sales_orders'>[]; loans: TableRow<'loans'>[];
    documents: Pick<DocumentRow, 'id' | 'entity_type' | 'entity_id' | 'doc_type' | 'file_name' | 'mime' | 'size_bytes' | 'created_at'>[];
  };
  notes: string[];
}

export async function exportPersonalData(ctx: AppContext, input: { lead_id?: string; customer_id?: string; note?: string }): Promise<{ request: DataRequest; export: ExportBundle }> {
  const { leads, customers } = await resolveSubject(ctx, input);
  const leadIds = leads.map((l) => l.id);
  const customerIds = customers.map((c) => c.id);

  const [consents, events, contacts, followups, messages, forms, surveys, opps, negotiations, scores, assignments] = await Promise.all([
    rowsWhere(ctx, 'lead_consents', 'lead_id', leadIds), rowsWhere(ctx, 'lead_events', 'lead_id', leadIds), rowsWhere(ctx, 'contact_logs', 'lead_id', leadIds),
    rowsWhere(ctx, 'followups', 'lead_id', leadIds), rowsWhere(ctx, 'message_log', 'lead_id', leadIds), rowsWhere(ctx, 'requirement_forms', 'lead_id', leadIds),
    rowsWhere(ctx, 'site_surveys', 'lead_id', leadIds), rowsWhere(ctx, 'opportunities', 'lead_id', leadIds), rowsWhere(ctx, 'negotiation_logs', 'lead_id', leadIds),
    rowsWhere(ctx, 'lead_scores', 'lead_id', leadIds), rowsWhere(ctx, 'lead_assignments', 'lead_id', leadIds),
  ]);
  const sites = uniqById([...(await rowsWhere(ctx, 'sites', 'lead_id', leadIds)), ...(await rowsWhere(ctx, 'sites', 'customer_id', customerIds))]);
  const quotes = uniqById([...(await rowsWhere(ctx, 'quotations', 'lead_id', leadIds)), ...(await rowsWhere(ctx, 'quotations', 'customer_id', customerIds))]);
  const lines = await rowsWhere(ctx, 'quotation_lines', 'quote_id', quotes.map((q) => q.id));
  const pis = uniqById([...(await rowsWhere(ctx, 'proforma_invoices', 'customer_id', customerIds)), ...(await rowsWhere(ctx, 'proforma_invoices', 'quote_id', quotes.map((q) => q.id)))]);
  const orders = uniqById([...(await rowsWhere(ctx, 'sales_orders', 'customer_id', customerIds)), ...(await rowsWhere(ctx, 'sales_orders', 'quote_id', quotes.map((q) => q.id)))]);
  const loans = uniqById([...(await rowsWhere(ctx, 'loans', 'lead_id', leadIds)), ...(await rowsWhere(ctx, 'loans', 'customer_id', customerIds))]);
  const docOwners = uniq([...leadIds, ...customerIds, ...sites.map((s) => s.id), ...surveys.map((s) => s.id), ...opps.map((o) => o.id), ...quotes.map((q) => q.id), ...pis.map((p) => p.id), ...loans.map((l) => l.id)]);
  const docs = await rowsWhere(ctx, 'documents', 'entity_id', docOwners);

  const data: ExportBundle['data'] = {
    leads, consents, events, contact_logs: contacts, followups, customers, sites, site_surveys: surveys, requirement_forms: forms, opportunities: opps, negotiation_logs: negotiations,
    messages: messages.map((m) => ({ ...m, body_preview: maskFreeText(m.body_preview) })),
    quotes: quotes.map((q) => ({ ...q, lines: lines.filter((l) => l.quote_id === q.id) })),
    proforma_invoices: pis, sales_orders: orders, loans,
    documents: docs.map((d) => ({ id: d.id, entity_type: d.entity_type, entity_id: d.entity_id, doc_type: d.doc_type, file_name: d.file_name, mime: d.mime, size_bytes: d.size_bytes, created_at: d.created_at })),
  };
  const summary: Record<string, number> = {};
  for (const [k, v] of Object.entries(data)) summary[k] = v.length;
  summary['lead_scores'] = scores.length;
  summary['lead_assignments'] = assignments.length;
  const now = ctx.now().toISOString();
  const bundle: ExportBundle = {
    generated_at: now, generated_by: ctx.user.id, subject: { lead_ids: leadIds, customer_ids: customerIds }, summary, data,
    notes: [
      'Message bodies are masked; documents are listed by name only — request the files separately if needed.',
      'Internal staff notes and scores about the person are included because they are personal data about them.',
      'This export is a record of a data-principal access request and has been logged.',
    ],
  };
  const request = await ctx.db.table('data_requests').insert({
    lead_id: input.lead_id ?? leads[0]?.id ?? null, customer_id: input.customer_id ?? null, kind: 'export', status: 'completed', requested_at: now, completed_at: now,
    notes: [input.note, `Exported ${Object.entries(summary).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(', ') || 'no records'}`].filter(Boolean).join(' — '), created_by: ctx.user.id,
  });
  await audit(ctx, { action: 'privacy.export', table: 'data_requests', record_id: request.id, detail: { lead_id: input.lead_id ?? null, customer_id: input.customer_id ?? null, summary } });
  return { request, export: bundle };
}

function uniqById<T extends { id: string }>(rows: T[]): T[] {
  return [...new Map(rows.map((r) => [r.id, r])).values()];
}

/* ───────────── erasure (anonymisation) ───────────── */
const OPEN_LEAD_STATUSES: LeadStatus[] = ['new', 'validated', 'unassigned', 'assigned', 'accepted', 'contacted', 'qualified', 'site_visit', 'nurture', 'opportunity'];
const OPEN_OPP_STAGES = ['qualified', 'quotation', 'negotiation', 'pi_stage'];
const PERSONAL_BUCKETS = ['lead-docs', 'site-photos'];
const CLOSED_ORDER_STATUSES = ['closed', 'cancelled'];

export interface ErasureReport {
  lead_ids: string[]; customer_ids: string[]; anonymised_at: string; reason: string;
  counts: Record<string, number>;
  message_log: { total: number; scrubbed: number; retained_append_only: number };
  retained: { table: string; reason: string }[];
}

/** Open (not closed/cancelled) sales orders linked to the person's customer records. */
async function openOrderCount(ctx: AppContext, customerIds: string[]): Promise<number> {
  const orders = await rowsWhere(ctx, 'sales_orders', 'customer_id', customerIds);
  return orders.filter((o) => !CLOSED_ORDER_STATUSES.includes(o.status)).length;
}

export async function eraseLead(ctx: AppContext, leadId: string, opts: { reason: string; trigger?: 'request' | 'retention' }): Promise<{ request: DataRequest; report: ErasureReport }> {
  const trigger = opts.trigger ?? 'request';
  const subject = await resolveSubject(ctx, { lead_id: leadId });
  const target = subject.leads.find((l) => l.id === leadId);
  if (!target) throw notFound('Lead');
  if (target.anonymised_at) throw invalidState('This person’s data has already been erased');
  const customerIds = subject.customers.map((c) => c.id);
  const blockOnOrders = (await ctx.svc.rules.value<boolean>('privacy.erase_blocked_by_open_orders', undefined, true)) ?? true;
  if (blockOnOrders && (await openOrderCount(ctx, customerIds)) > 0) {
    throw guardBlocked('This person has an open sales order. Statutory and contractual records are needed until it closes — erase after the order is closed.');
  }

  const now = ctx.now().toISOString();
  const label = trigger === 'retention' ? 'Erased under the retention policy' : 'Erased at the data principal’s request';
  const request = await ctx.db.table('data_requests').insert({
    lead_id: leadId, customer_id: customerIds[0] ?? null, kind: 'erasure', status: 'requested', requested_at: now, completed_at: null, notes: opts.reason, created_by: ctx.system ? null : ctx.user.id,
  });
  const leadIds = subject.leads.map((l) => l.id);
  const counts: Record<string, number> = {};
  const retained: ErasureReport['retained'] = [];
  const bump = (k: string, n = 1) => { counts[k] = (counts[k] ?? 0) + n; };

  // 1 — withdraw every live consent (the ledger rows themselves stay as proof of what was agreed)
  for (const c of await rowsWhere(ctx, 'lead_consents', 'lead_id', leadIds)) {
    if (c.withdrawn_at) continue;
    await ctx.db.table('lead_consents').update(c.id, { withdrawn_at: now, withdrawn_by: ctx.system ? null : ctx.user.id, withdrawal_channel: 'erasure' });
    bump('consents_withdrawn');
  }
  retained.push({ table: 'lead_consents', reason: 'Consent ledger metadata is kept as proof of what was agreed and when.' });

  // 2 — free-text interaction records
  for (const r of await rowsWhere(ctx, 'contact_logs', 'lead_id', leadIds)) { await ctx.db.table('contact_logs').update(r.id, { notes: null }); bump('contact_logs'); }
  for (const r of await rowsWhere(ctx, 'negotiation_logs', 'lead_id', leadIds)) { await ctx.db.table('negotiation_logs').update(r.id, { notes: null }); bump('negotiation_logs'); }
  for (const r of await rowsWhere(ctx, 'followups', 'lead_id', leadIds)) {
    await ctx.db.table('followups').update(r.id, { note: null, outcome: null, ...(r.status === 'open' ? { status: 'cancelled' as const } : {}) });
    bump('followups');
  }
  for (const r of await rowsWhere(ctx, 'requirement_forms', 'lead_id', leadIds)) { await ctx.db.table('requirement_forms').update(r.id, { data: {} }); bump('requirement_forms'); }
  const surveys = await rowsWhere(ctx, 'site_surveys', 'lead_id', leadIds);
  for (const r of surveys) { await ctx.db.table('site_surveys').update(r.id, { notes: null, photos: [], sld_ref: null }); bump('site_surveys'); }

  // 3 — sites, opportunities, loans, quotes
  const sites = uniqById([...(await rowsWhere(ctx, 'sites', 'lead_id', leadIds)), ...(await rowsWhere(ctx, 'sites', 'customer_id', customerIds))]);
  for (const s of sites) {
    await ctx.db.table('sites').update(s.id, { name_on_bill: null, applicant_name: null, consumer_no: null, address: null, pincode: null, city: null, lat: null, lng: null, bill_doc_id: null });
    bump('sites');
  }
  const opps = await rowsWhere(ctx, 'opportunities', 'lead_id', leadIds);
  for (const o of opps) {
    await ctx.db.table('opportunities').update(o.id, { name: 'Opportunity (erased)', ...(OPEN_OPP_STAGES.includes(o.stage) ? { stage: 'lost' as const, lost_reason: label } : {}) });
    bump('opportunities');
  }
  const loans = uniqById([...(await rowsWhere(ctx, 'loans', 'lead_id', leadIds)), ...(await rowsWhere(ctx, 'loans', 'customer_id', customerIds))]);
  for (const l of loans) { await ctx.db.table('loans').update(l.id, { co_applicant: null, notes: null }); bump('loans'); }
  const quotes = uniqById([...(await rowsWhere(ctx, 'quotations', 'lead_id', leadIds)), ...(await rowsWhere(ctx, 'quotations', 'customer_id', customerIds))]);
  for (const q of quotes) { if (q.rejected_reason) { await ctx.db.table('quotations').update(q.id, { rejected_reason: null }); bump('quotations'); } }
  if (quotes.length) retained.push({ table: 'quotations', reason: 'Quote amounts, GST data and compliance findings are kept (aggregates and statutory pricing record).' });

  // 4 — customers and proforma invoices: statutory records keep the tax identity, everything else goes
  const orders = await rowsWhere(ctx, 'sales_orders', 'customer_id', customerIds);
  const pis = uniqById([...(await rowsWhere(ctx, 'proforma_invoices', 'customer_id', customerIds)), ...(await rowsWhere(ctx, 'proforma_invoices', 'quote_id', quotes.map((q) => q.id)))]);
  const statutoryPi = (status: string) => ['issued', 'partially_paid', 'paid'].includes(status);
  const statutoryCustomers = new Set<string>();
  for (const o of orders) if (o.customer_id && o.status !== 'draft' && o.status !== 'cancelled') statutoryCustomers.add(o.customer_id);
  for (const p of pis) if (p.customer_id && statutoryPi(p.status)) statutoryCustomers.add(p.customer_id);
  for (const p of pis) {
    if (statutoryPi(p.status)) continue;
    await ctx.db.table('proforma_invoices').update(p.id, { legal_name: 'Erased', gstin: null, billing_address: null, shipping_address: null });
    bump('proforma_invoices');
  }
  if (pis.some((p) => statutoryPi(p.status))) retained.push({ table: 'proforma_invoices', reason: 'Issued invoices keep amounts, GST data and the buyer’s tax identity — statutory record.' });
  for (const c of subject.customers) {
    if (statutoryCustomers.has(c.id)) {
      await ctx.db.table('customers').update(c.id, { display_name: null, email: null, phone: null, aadhaar_last4: null, ...(c.gstin ? {} : { pan: null }), anonymised_at: now });
      retained.push({ table: 'customers', reason: 'Legal name, GSTIN and billing/shipping address are kept for statutory tax records; contact details were removed.' });
    } else {
      await ctx.db.table('customers').update(c.id, { legal_name: 'Erased', display_name: null, gstin: null, pan: null, email: null, phone: null, billing_address: null, shipping_address: null, aadhaar_last4: null, anonymised_at: now });
    }
    bump('customers');
  }
  if (orders.length) retained.push({ table: 'sales_orders', reason: 'Orders, amounts and GST data are kept (statutory financial record).' });

  // 5 — personal documents (bills, site photos) are deleted; quote PDFs and invoices are statutory
  const ownerIds = uniq([...leadIds, ...customerIds, ...sites.map((s) => s.id), ...surveys.map((s) => s.id), ...opps.map((o) => o.id), ...loans.map((l) => l.id), ...quotes.map((q) => q.id), ...pis.map((p) => p.id)]);
  for (const d of await rowsWhere(ctx, 'documents', 'entity_id', ownerIds)) {
    if (!PERSONAL_BUCKETS.includes(d.bucket)) { bump('documents_retained'); continue; }
    try { await ctx.providers.storage.remove({ bucket: d.bucket, path: d.path }); } catch (e) { ctx.log.warn({ err: e, document: d.id }, 'could not remove stored file during erasure'); }
    await ctx.db.table('documents').delete(d.id);
    bump('documents_deleted');
  }
  if (counts['documents_retained']) retained.push({ table: 'documents', reason: 'Quote PDFs, invoices and compliance documents are statutory records.' });

  // 6 — notifications that mention the person, running clocks, message bodies
  for (const n of await rowsWhere(ctx, 'notifications', 'entity_id', ownerIds)) { await ctx.db.table('notifications').delete(n.id); bump('notifications_deleted'); }
  for (const id of leadIds) await ctx.svc.clocks.cancel('lead', id);
  const messages = await rowsWhere(ctx, 'message_log', 'lead_id', leadIds);
  let scrubbed = 0;
  let appendOnly = 0;
  for (const m of messages) {
    if (m.body_preview === null) continue;
    try { await ctx.db.table('message_log').update(m.id, { body_preview: null }); scrubbed++; } catch (e) {
      if (e instanceof AppError && e.status === 403) { appendOnly++; continue; }
      throw e;
    }
  }
  if (appendOnly) retained.push({ table: 'message_log', reason: 'The message log is an append-only ledger in this deployment; bodies could not be cleared (to_masked holds a masked number only).' });
  retained.push({ table: 'lead_events', reason: 'The lead timeline is an append-only processing record; it holds no contact details.' });

  // 7 — the lead records themselves, last: a half-finished run is then simply re-run
  for (const l of subject.leads) {
    await ctx.db.table('leads').update(l.id, {
      name: 'Erased', mobile: `erased-${randomUUID().slice(0, 8)}`, email: null, pincode: null, city: null, consumer_no: null, requirement_text: null, notes: null,
      nurture_reason: null, nurture_until: null, source_ref: null, source_detail: {}, budget_inr: null,
      last_action: 'Personal data erased', next_action: null, next_followup_at: null,
      ...(OPEN_LEAD_STATUSES.includes(l.status) || l.status === 'lost' ? { status: 'lost' as const, lost_reason: label } : { lost_reason: null }),
      anonymised_at: now,
    });
    await ctx.db.table('lead_events').insert({ lead_id: l.id, event_type: 'privacy_erased', summary: 'Personal data erased', actor_id: ctx.system ? null : ctx.user.id, detail: { trigger, data_request_id: request.id } });
    bump('leads');
  }

  const report: ErasureReport = {
    lead_ids: leadIds, customer_ids: customerIds, anonymised_at: now, reason: opts.reason, counts,
    message_log: { total: messages.length, scrubbed, retained_append_only: appendOnly }, retained: dedupeRetained(retained),
  };
  const done = await ctx.db.table('data_requests').update(request.id, { status: 'completed', completed_at: ctx.now().toISOString(), notes: `${opts.reason} — ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ')}` });
  await audit(ctx, { action: trigger === 'retention' ? 'privacy.erase_retention' : 'privacy.erase', table: 'leads', record_id: leadId, detail: { data_request_id: request.id, reason: opts.reason, counts, message_log: report.message_log } });
  return { request: done, report };
}

function dedupeRetained(items: ErasureReport['retained']): ErasureReport['retained'] {
  return [...new Map(items.map((i) => [`${i.table}|${i.reason}`, i])).values()];
}

/* ───────────── retention job ───────────── */
export interface RetentionPart {
  rule: string; rule_id: string | null; days: number | null;
  /** apply = the rule is verified and active, so the action ran · report = the rule is unverified/inactive, candidates only · skipped = no usable rule */
  mode: 'apply' | 'report' | 'skipped';
  candidates: number; acted: number; failed: number; sample_ids: string[];
}

async function retentionPart(ctx: AppContext, path: string): Promise<{ part: RetentionPart; days: number; act: boolean } | { part: RetentionPart; days: null; act: false }> {
  const rule = await ctx.svc.rules.path(path);
  const days = rule && typeof rule.value === 'number' && rule.value > 0 ? rule.value : null;
  const base: RetentionPart = { rule: path, rule_id: rule?.id ?? null, days, mode: 'skipped', candidates: 0, acted: 0, failed: 0, sample_ids: [] };
  if (!rule || days === null) return { part: base, days: null, act: false };
  // destructive action only for a verified, active rule (or one a compliance officer explicitly enforced)
  const act = rule.isActive && !decideSeverity(rule, 'hard_stop').advisory;
  return { part: { ...base, mode: act ? 'apply' : 'report' }, days, act };
}

const daysAgoIso = (ctx: AppContext, days: number): string => new Date(ctx.now().getTime() - days * 86_400_000).toISOString();

export async function runRetention(ctx: AppContext): Promise<{ lead_inactive: RetentionPart; dnd_register: RetentionPart; message_bodies: RetentionPart; note: string }> {
  const batch = Math.max(1, (await ctx.svc.rules.value<number>('retention.batch_size', undefined, 200)) ?? 200);

  // inactive leads
  const leadPart = await retentionPart(ctx, 'retention.lead_inactive_days');
  if (leadPart.days !== null) {
    const cutoff = daysAgoIso(ctx, leadPart.days);
    const stale = await ctx.db.table('leads').all({ anonymised_at: null, status: { nin: ['opportunity', 'won'] }, updated_at: { lt: cutoff } });
    const openCustomers = new Set((await ctx.db.table('sales_orders').all({ status: { nin: CLOSED_ORDER_STATUSES } })).map((o) => o.customer_id).filter((x): x is string => !!x));
    const linked = new Map<string, string[]>();
    for (const c of await ctx.db.table('customers').all({ lead_id: { is_null: false } })) if (c.lead_id) linked.set(c.lead_id, [...(linked.get(c.lead_id) ?? []), c.id]);
    const candidates = stale.filter((l) => {
      if (l.last_action_at && l.last_action_at >= cutoff) return false;
      if (l.next_followup_at && l.next_followup_at > ctx.now().toISOString()) return false;
      const customers = [...(l.customer_id ? [l.customer_id] : []), ...(linked.get(l.id) ?? [])];
      return !customers.some((c) => openCustomers.has(c));
    });
    leadPart.part.candidates = candidates.length;
    leadPart.part.sample_ids = candidates.slice(0, 20).map((l) => l.id);
    if (leadPart.act) {
      const done = new Set<string>();
      for (const l of candidates.slice(0, batch)) {
        if (done.has(l.id)) continue;
        try {
          const { report } = await eraseLead(ctx, l.id, { reason: `Inactive for more than ${leadPart.days} days (rule retention.lead_inactive_days)`, trigger: 'retention' });
          report.lead_ids.forEach((id) => done.add(id));
          leadPart.part.acted++;
        } catch (e) {
          leadPart.part.failed++;
          ctx.log.warn({ err: e, lead: l.id }, 'retention: could not anonymise lead');
        }
      }
    }
  }

  // stale DND scrub cache
  const dndPart = await retentionPart(ctx, 'retention.dnd_register_days');
  if (dndPart.days !== null) {
    const old = await ctx.db.table('dnd_register').all({ checked_at: { lt: daysAgoIso(ctx, dndPart.days) } });
    dndPart.part.candidates = old.length;
    dndPart.part.sample_ids = old.slice(0, 20).map((r) => r.id);
    if (dndPart.act) for (const r of old) { try { await ctx.db.table('dnd_register').delete(r.id); dndPart.part.acted++; } catch { dndPart.part.failed++; } }
  }

  // old message bodies
  const msgPart = await retentionPart(ctx, 'retention.message_body_days');
  if (msgPart.days !== null) {
    const old = await ctx.db.table('message_log').all({ created_at: { lt: daysAgoIso(ctx, msgPart.days) }, body_preview: { is_null: false } });
    msgPart.part.candidates = old.length;
    msgPart.part.sample_ids = old.slice(0, 20).map((r) => r.id);
    if (msgPart.act) {
      for (const [i, m] of old.entries()) {
        try { await ctx.db.table('message_log').update(m.id, { body_preview: null }); msgPart.part.acted++; } catch (e) {
          // an append-only ledger refuses edits: count the rest as failed and stop instead of failing once per row
          msgPart.part.failed += old.length - i;
          ctx.log.warn({ err: e }, 'retention: message_log refused body clearing');
          break;
        }
      }
    }
  }

  const reportOnly = [leadPart.part, dndPart.part, msgPart.part].filter((p) => p.mode === 'report').map((p) => p.rule);
  return {
    lead_inactive: leadPart.part, dnd_register: dndPart.part, message_bodies: msgPart.part,
    note: reportOnly.length ? `Report only (rule not verified and active): ${reportOnly.join(', ')}. Activate the rule under Admin → Rules to let the job act.` : 'All retention rules are active.',
  };
}

/* ───────────── unmask events and data requests ───────────── */
export interface UnmaskEvent { id: string; created_at: string; actor_id: string | null; actor_name: string | null; actor_role: string | null; action: string; table_name: string | null; record_id: string | null; detail: Json | null; ip: string | null }

export async function listUnmaskEvents(ctx: AppContext, q: { actor?: string; record?: string; from?: string; to?: string; limit: number; offset: number }): Promise<{ rows: UnmaskEvent[]; total: number }> {
  const where: Where = { action: { ilike: '%unmask%' } };
  if (q.actor) where['actor_id'] = q.actor;
  if (q.record) where['record_id'] = q.record;
  if (q.from || q.to) where['created_at'] = { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) };
  const { rows, total } = await ctx.db.table('audit_log').list({ where, orderBy: { col: 'created_at', dir: 'desc' }, limit: q.limit, offset: q.offset });
  const actors = new Map((await rowsWhere(ctx, 'profiles', 'id', uniq(rows.map((r: AuditLog) => r.actor_id).filter((x): x is string => !!x)))).map((p) => [p.id, p]));
  return {
    total,
    rows: rows.map((r: AuditLog) => ({
      id: r.id, created_at: r.created_at, actor_id: r.actor_id, actor_name: r.actor_id ? actors.get(r.actor_id)?.full_name ?? null : null, actor_role: r.actor_id ? actors.get(r.actor_id)?.role ?? null : null,
      action: r.action, table_name: r.table_name, record_id: r.record_id, detail: r.detail, ip: r.ip,
    })),
  };
}

