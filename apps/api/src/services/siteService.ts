/**
 * Customers and sites (steps 15 and 3 of the flow): the customer + site pair is created on the first save of a lead's
 * site form, linked back to the lead, and carries the DISCOM bill facts that feed gate G12 (name match, pending dues)
 * and the special-category flag used by the CFA calculator.
 */
import type { Request } from 'express';
import {
  compareNames, stateInList,
  type Customer, type CustomerCreateInput, type CustomerUpdateInput, type DocumentRow, type Json, type Lead, type LeadSiteSaveInput, type RuleStatus, type Site, type SiteCreateInput, type SiteFieldsInput,
} from '@solar/shared';
import { isInternal, maskPii } from '../auth/access';
import type { AppContext } from '../auth/context';
import { audit } from '../lib/audit';
import { AppError, badRequest, conflict, forbidden, invalidState, notFound } from '../http/errors';
import { assertFilenameAllowed } from '../http/guards';
import { filesOf, storeDocument } from '../http/upload';
import { recomputeLeadScore } from './scoring';
import { actorId, assertCanReadViaLead, assertLeadEditable, canReadViaLead, getVisibleLead, listViaLead, logLeadEvent, type Hint } from './siteAccess';

const asJson = (v: unknown): Json => v as Json;

/* ───────────── rule-driven helpers ───────────── */

export interface SpecialCategoryInfo {
  state: string | null;
  /** is the state on the configured list? null when the list rule does not exist */
  listed: boolean | null;
  rule_active: boolean;
  rule_status: RuleStatus | null;
  /** the flag as stored on the site after this save */
  flag: boolean;
  basis: 'manual_override' | 'derived' | 'unchanged';
}

async function specialCategoryRule(ctx: AppContext, state: string | null): Promise<Pick<SpecialCategoryInfo, 'listed' | 'rule_active' | 'rule_status'>> {
  const rule = await ctx.svc.rules.path('pmsg.special_category_states');
  if (!rule || !Array.isArray(rule.value)) return { listed: null, rule_active: false, rule_status: rule?.status ?? null };
  const list = rule.value.filter((v): v is string => typeof v === 'string');
  return { listed: state ? stateInList(state, list) : null, rule_active: rule.isActive, rule_status: rule.status };
}

export const siteHints = (site: Site, special: Pick<SpecialCategoryInfo, 'listed' | 'rule_active'>): Hint[] => {
  const hints: Hint[] = [];
  if (site.name_match === false) {
    hints.push({ code: 'NAME_MISMATCH', gate: 'G12', severity: 'warning', advisory: true, message: `The name on the DISCOM bill ("${site.name_on_bill ?? ''}") does not match the applicant ("${site.applicant_name ?? ''}"). Fix this before DISCOM filing — it is a common reason for loan and subsidy rejection.` });
  }
  if (site.pending_dues) {
    hints.push({ code: 'PENDING_DUES', gate: 'G12', severity: 'warning', advisory: true, message: 'The consumer has pending electricity dues. Ask the customer to clear them before the DISCOM application.' });
  }
  if (special.listed && !special.rule_active && !site.special_category_state) {
    hints.push({ code: 'SPECIAL_CATEGORY_UNVERIFIED', severity: 'info', advisory: true, message: `${site.state ?? 'This state'} appears on the special-category list, but that list is unverified and switched off. Confirm with the compliance officer and set the special-category flag by hand if the higher CFA applies.` });
  }
  return hints;
};

async function resolveDiscomId(ctx: AppContext, id: string | null | undefined, code: string | null | undefined): Promise<string | null | undefined> {
  if (id) {
    if (!(await ctx.db.table('discoms').get(id))) throw notFound('DISCOM');
    return id;
  }
  if (code) {
    const d = await ctx.db.table('discoms').one({ code: code.toUpperCase() }) ?? (await ctx.db.table('discoms').all()).find((x) => x.code.toLowerCase() === code.toLowerCase()) ?? null;
    if (!d) throw new AppError(422, 'VALIDATION_ERROR', 'Unknown DISCOM code', [{ path: 'discom_code', message: `No DISCOM with code "${code}"` }]);
    return d.id;
  }
  return id === null || code === null ? null : undefined;
}

/* ───────────── customers ───────────── */

export function maskCustomer(ctx: AppContext, c: Customer): Customer {
  const m = maskPii(ctx, { mobile: c.phone, email: c.email });
  return { ...c, phone: m.mobile ?? null, email: m.email ?? null };
}

async function assertGstinFree(ctx: AppContext, gstin: string | null | undefined, exceptId?: string): Promise<void> {
  if (!gstin) return;
  const other = await ctx.db.table('customers').one({ gstin });
  if (other && other.id !== exceptId) throw conflict(`A customer with GSTIN ${gstin} already exists`, { customer_id: other.id });
}

export async function createCustomer(ctx: AppContext, input: CustomerCreateInput): Promise<Customer> {
  const { lead_id, ...fields } = input;
  const lead = lead_id ? await getVisibleLead(ctx, lead_id) : null;
  if (lead) assertLeadEditable(lead);
  if (!lead && !isInternal(ctx.user.role)) throw forbidden('Link the customer to one of your leads');
  await assertGstinFree(ctx, fields.gstin);
  const row = await ctx.db.table('customers').insert({
    legal_name: fields.legal_name, display_name: fields.display_name ?? null, customer_type: fields.customer_type ?? lead?.customer_type ?? null, gstin: fields.gstin ?? null, pan: fields.pan ?? null,
    email: fields.email ?? null, phone: fields.phone ?? null, billing_address: fields.billing_address ?? null, shipping_address: fields.shipping_address ?? null, state: fields.state ?? null,
    lead_id: lead?.id ?? null, aadhaar_last4: fields.aadhaar_last4 ?? null, anonymised_at: null, created_by: actorId(ctx),
  });
  if (lead && !lead.customer_id) await ctx.db.table('leads').update(lead.id, { customer_id: row.id });
  await audit(ctx, { action: 'customer.create', table: 'customers', record_id: row.id, new: asJson(row) });
  return row;
}

export async function assertCanReadCustomer(ctx: AppContext, c: Customer): Promise<void> {
  await assertCanReadViaLead(ctx, { leadId: c.lead_id, linkCol: 'customer_id', linkId: c.id });
}

export async function updateCustomer(ctx: AppContext, id: string, input: CustomerUpdateInput): Promise<Customer> {
  const before = await ctx.db.table('customers').get(id);
  if (!before) throw notFound('Customer');
  await assertCanReadCustomer(ctx, before);
  if (before.anonymised_at) throw invalidState('This customer has been anonymised and can no longer be edited');
  if (input.gstin !== undefined) await assertGstinFree(ctx, input.gstin, id);
  const patch: Partial<Customer> = {};
  for (const [k, v] of Object.entries(input)) if (v !== undefined) (patch as Record<string, unknown>)[k] = v;
  // GSTIN and PAN must agree even when only one of them is being changed
  const gstin = patch.gstin !== undefined ? patch.gstin : before.gstin;
  const pan = patch.pan !== undefined ? patch.pan : before.pan;
  if (gstin && pan && gstin.slice(2, 12) !== pan) {
    throw new AppError(422, 'VALIDATION_ERROR', 'The PAN inside the GSTIN does not match the PAN', [{ path: 'pan', message: 'The PAN inside the GSTIN does not match the PAN entered' }]);
  }
  const row = await ctx.db.table('customers').update(id, patch);
  await audit(ctx, { action: 'customer.update', table: 'customers', record_id: id, old: asJson(before), new: asJson(row) });
  return row;
}

export async function listCustomers(ctx: AppContext, req: Request) {
  const page = await listViaLead(ctx, req, {
    table: 'customers', filterCols: ['customer_type', 'state', 'lead_id'], searchCols: ['legal_name', 'display_name', 'gstin', 'pan', 'phone', 'email'], defaultSort: { col: 'created_at', dir: 'desc' },
  });
  return { ...page, rows: page.rows.map((c) => maskCustomer(ctx, c)) };
}

export async function getCustomerView(ctx: AppContext, id: string) {
  const c = await ctx.db.table('customers').get(id);
  if (!c) throw notFound('Customer');
  await assertCanReadCustomer(ctx, c);
  const sites = await ctx.db.table('sites').all({ customer_id: id }, { orderBy: { col: 'created_at', dir: 'desc' } });
  const leads = await ctx.db.table('leads').all({ customer_id: id });
  const visible: { id: string; name: string; status: string }[] = [];
  for (const l of leads) if (await canReadViaLead(ctx, { leadId: l.id })) visible.push({ id: l.id, name: l.name, status: l.status });
  return { ...maskCustomer(ctx, c), sites, leads: visible };
}

/* ───────────── sites ───────────── */

interface PatchResult { patch: Partial<Site>; special: SpecialCategoryInfo }

/** Turn client input into a column patch: normalise, derive name_match / special-category / geography, never touch what was not sent. */
async function buildSitePatch(ctx: AppContext, current: Site | null, lead: Lead | null, input: SiteFieldsInput, applicantFallback: string | null, discomId: string | null | undefined): Promise<PatchResult> {
  const patch: Partial<Site> = {};
  const set = <K extends keyof Site>(k: K, v: Site[K] | undefined): void => { if (v !== undefined) patch[k] = v; };

  set('applicant_name', input.applicant_name);
  set('name_on_bill', input.name_on_bill);
  if (input.consumer_no !== undefined) patch.consumer_no = input.consumer_no === null ? null : input.consumer_no.trim().toUpperCase();
  set('discom_id', discomId);
  set('sanctioned_load_kw', input.sanctioned_load_kw);
  set('contracted_demand_kva', input.contracted_demand_kva);
  set('phase', input.phase);
  set('address', input.address);
  set('pincode', input.pincode);
  set('city', input.city);
  set('district', input.district);
  set('state', input.state);
  set('lat', input.lat);
  set('lng', input.lng);
  set('roof_ownership', input.roof_ownership);
  set('title_ok', input.title_ok);
  set('pending_dues', input.pending_dues);
  set('existing_solar_kw', input.existing_solar_kw);
  set('category', input.category);
  set('roof_type', input.roof_type);
  set('load_type', input.load_type);

  if (input.address) {
    if (input.pincode === undefined) patch.pincode = input.address.pincode;
    if (input.city === undefined) patch.city = input.address.city;
    if (input.district === undefined && input.address.district) patch.district = input.address.district;
    if (input.state === undefined) patch.state = input.address.state;
  }
  const finalOf = <K extends 'pincode' | 'city' | 'district' | 'state'>(k: K): string | null => (patch[k] !== undefined ? patch[k] ?? null : current?.[k] ?? null);
  // fill the geography from the pincode table when it was typed without the rest
  if (patch.pincode && patch.pincode !== current?.pincode && (!finalOf('city') || !finalOf('state'))) {
    const hit = await ctx.providers.pincode.lookup(patch.pincode);
    if (hit) {
      if (!finalOf('city')) patch.city = hit.city;
      if (!finalOf('district')) patch.district = hit.district;
      if (!finalOf('state')) patch.state = hit.state;
    }
  }

  // name on the bill vs the applicant (gate G12 input)
  const bill = patch.name_on_bill !== undefined ? patch.name_on_bill : current?.name_on_bill ?? null;
  const applicant = (patch.applicant_name !== undefined ? patch.applicant_name : current?.applicant_name ?? null) ?? applicantFallback;
  const minScore = await ctx.svc.rules.value<number>('site.name_match_min_score', undefined, 0.85) ?? 0.85;
  const match = compareNames(bill, applicant, minScore);
  const nextMatch = match ? match.match : null;
  if (!current || current.name_match !== nextMatch) patch.name_match = nextMatch;
  if (!current && patch.applicant_name === undefined && applicantFallback) patch.applicant_name = applicantFallback;

  // special-category state: manual override wins; otherwise derive from the list ONLY while that rule is active
  const state = finalOf('state') ?? lead?.state ?? null;
  const rule = await specialCategoryRule(ctx, state);
  const stateChanged = (current?.state ?? null) !== (finalOf('state') ?? null);
  let flag = current?.special_category_state ?? false;
  let basis: SpecialCategoryInfo['basis'] = 'unchanged';
  if (typeof input.special_category_state === 'boolean') { flag = input.special_category_state; basis = 'manual_override'; }
  else if (rule.rule_active && rule.listed !== null && (input.special_category_state === null || stateChanged || !current)) { flag = rule.listed; basis = 'derived'; }
  if (!current || flag !== current.special_category_state) patch.special_category_state = flag;
  if (!current && state && patch.state === undefined) patch.state = state;

  return { patch, special: { state, listed: rule.listed, rule_active: rule.rule_active, rule_status: rule.rule_status, flag, basis } };
}

const emptySite = (customerId: string | null, leadId: string | null): Partial<Site> => ({
  customer_id: customerId, lead_id: leadId, name_on_bill: null, applicant_name: null, name_match: null, consumer_no: null, discom_id: null, sanctioned_load_kw: null, contracted_demand_kva: null, phase: null,
  address: null, pincode: null, city: null, district: null, state: null, lat: null, lng: null, roof_ownership: null, title_ok: null, pending_dues: false, existing_solar_kw: 0, category: 'general',
  special_category_state: false, roof_type: null, load_type: null, bill_doc_id: null,
});

/** The customer + site pair of a lead; created (once) the first time site details are saved. Safe to retry after a partial failure. */
async function ensureCustomerAndSite(ctx: AppContext, lead: Lead): Promise<{ customer: Customer; site: Site; created: { customer: boolean; site: boolean } }> {
  const created = { customer: false, site: false };
  let customer = lead.customer_id ? await ctx.db.table('customers').get(lead.customer_id) : await ctx.db.table('customers').one({ lead_id: lead.id });
  if (!customer) {
    customer = await ctx.db.table('customers').insert({
      legal_name: lead.name, display_name: lead.name, customer_type: lead.customer_type, gstin: null, pan: null, email: lead.email, phone: lead.mobile, billing_address: null, shipping_address: null,
      state: lead.state, lead_id: lead.id, aadhaar_last4: null, anonymised_at: null, created_by: actorId(ctx),
    });
    created.customer = true;
    await audit(ctx, { action: 'customer.create', table: 'customers', record_id: customer.id, new: asJson(customer), detail: { via: 'lead_site_save', lead_id: lead.id } });
  }
  let site = lead.site_id ? await ctx.db.table('sites').get(lead.site_id) : await ctx.db.table('sites').one({ lead_id: lead.id });
  if (!site) {
    site = await ctx.db.table('sites').insert({ ...emptySite(customer.id, lead.id), pincode: lead.pincode, city: lead.city, district: lead.district, state: lead.state, consumer_no: lead.consumer_no, created_by: actorId(ctx) });
    created.site = true;
  }
  // link both ways; retried saves converge because both lookups above also search by lead_id
  const link: Partial<Lead> = {};
  if (lead.customer_id !== customer.id) link.customer_id = customer.id;
  if (lead.site_id !== site.id) link.site_id = site.id;
  if (Object.keys(link).length) await ctx.db.table('leads').update(lead.id, link);
  if (site.customer_id !== customer.id) site = await ctx.db.table('sites').update(site.id, { customer_id: customer.id });
  await ctx.db.table('site_surveys').updateWhere({ lead_id: lead.id, site_id: null }, { site_id: site.id });
  await ctx.db.table('requirement_forms').updateWhere({ lead_id: lead.id, site_id: null }, { site_id: site.id });
  return { customer, site, created };
}

export interface SiteSaveResult { customer: Customer | null; site: Site; created: { customer: boolean; site: boolean }; hints: Hint[]; special_category: SpecialCategoryInfo }

async function persistSite(ctx: AppContext, lead: Lead | null, current: Site, input: SiteFieldsInput, applicantFallback: string | null, discomId: string | null | undefined, action: string, created: boolean): Promise<{ site: Site; hints: Hint[]; special: SpecialCategoryInfo }> {
  const { patch, special } = await buildSitePatch(ctx, created ? null : current, lead, input, applicantFallback, discomId);
  const site = Object.keys(patch).length ? await ctx.db.table('sites').update(current.id, patch) : current;
  if (lead && patch.consumer_no !== undefined && patch.consumer_no !== lead.consumer_no) await ctx.db.table('leads').update(lead.id, { consumer_no: patch.consumer_no });
  await audit(ctx, { action, table: 'sites', record_id: site.id, old: created ? null : asJson(current), new: asJson(site) });
  return { site, hints: siteHints(site, special), special };
}

/** PUT /leads/:id/site */
export async function saveLeadSite(ctx: AppContext, lead: Lead, input: LeadSiteSaveInput): Promise<SiteSaveResult> {
  assertLeadEditable(lead);
  const { customer: customerInput, ...siteInput } = input;
  // validate everything that can be refused BEFORE the customer / site are created, so a rejected save leaves nothing behind
  const discomId = await resolveDiscomId(ctx, siteInput.discom_id, siteInput.discom_code);
  if (customerInput?.gstin) await assertGstinFree(ctx, customerInput.gstin, lead.customer_id ?? undefined);
  const pair = await ensureCustomerAndSite(ctx, lead);
  let customer = pair.customer;
  if (customerInput && Object.keys(customerInput).length) customer = await updateCustomer(ctx, customer.id, customerInput);
  const { site, hints, special } = await persistSite(ctx, lead, pair.site, siteInput, customer.legal_name ?? lead.name, discomId, 'site.save', pair.created.site);
  if (pair.created.site || pair.created.customer) await logLeadEvent(ctx, lead.id, 'site_saved', 'Customer and site details created', { site_id: site.id, customer_id: customer.id });
  return { customer, site, created: pair.created, hints, special_category: special };
}

/** Apply form-derived fields (requirement capture) to the lead's site, creating the pair when needed. */
export async function applySiteFieldsForLead(ctx: AppContext, lead: Lead, fields: SiteFieldsInput): Promise<SiteSaveResult | null> {
  if (!Object.keys(fields).length) return null;
  return saveLeadSite(ctx, lead, fields);
}

export interface LeadSiteView {
  lead_id: string;
  customer: Customer | null;
  site: Site | null;
  bill: Pick<DocumentRow, 'id' | 'file_name' | 'mime' | 'size_bytes' | 'created_at'> | null;
  hints: Hint[];
  special_category: Omit<SpecialCategoryInfo, 'basis'> | null;
}

export async function getLeadSiteView(ctx: AppContext, lead: Lead): Promise<LeadSiteView> {
  const customer = lead.customer_id ? await ctx.db.table('customers').get(lead.customer_id) : null;
  const site = lead.site_id ? await ctx.db.table('sites').get(lead.site_id) : null;
  const bill = site?.bill_doc_id ? await ctx.db.table('documents').get(site.bill_doc_id) : null;
  let special: LeadSiteView['special_category'] = null;
  let hints: Hint[] = [];
  if (site) {
    const rule = await specialCategoryRule(ctx, site.state);
    special = { state: site.state, listed: rule.listed, rule_active: rule.rule_active, rule_status: rule.rule_status, flag: site.special_category_state };
    hints = siteHints(site, rule);
  }
  return {
    lead_id: lead.id, customer: customer ? maskCustomer(ctx, customer) : null, site, hints, special_category: special,
    bill: bill ? { id: bill.id, file_name: bill.file_name, mime: bill.mime, size_bytes: bill.size_bytes, created_at: bill.created_at } : null,
  };
}

/* ───────────── standalone /sites endpoints ───────────── */

export async function assertCanReadSite(ctx: AppContext, site: Site): Promise<void> {
  await assertCanReadViaLead(ctx, { leadId: site.lead_id, linkCol: 'site_id', linkId: site.id });
}

export async function listSites(ctx: AppContext, req: Request) {
  const page = await listViaLead(ctx, req, {
    table: 'sites', filterCols: ['customer_id', 'lead_id', 'discom_id', 'state', 'name_match', 'pending_dues', 'category', 'special_category_state', 'phase'],
    searchCols: ['consumer_no', 'name_on_bill', 'applicant_name', 'city', 'pincode'], defaultSort: { col: 'created_at', dir: 'desc' },
  });
  return page;
}

export async function getSiteView(ctx: AppContext, id: string) {
  const site = await ctx.db.table('sites').get(id);
  if (!site) throw notFound('Site');
  await assertCanReadSite(ctx, site);
  const customer = site.customer_id ? await ctx.db.table('customers').get(site.customer_id) : null;
  const lead = site.lead_id ? await ctx.db.table('leads').get(site.lead_id) : null;
  const discom = site.discom_id ? await ctx.db.table('discoms').get(site.discom_id) : null;
  const surveys = await ctx.db.table('site_surveys').all({ site_id: id }, { orderBy: { col: 'created_at', dir: 'desc' } });
  const rule = await specialCategoryRule(ctx, site.state);
  return {
    ...site,
    customer: customer ? maskCustomer(ctx, customer) : null,
    lead: lead ? { id: lead.id, name: lead.name, status: lead.status, segment: lead.segment, capacity_kw: lead.capacity_kw } : null,
    discom: discom ? { id: discom.id, code: discom.code, name: discom.name } : null,
    latest_survey: surveys[0] ?? null,
    has_bill: !!site.bill_doc_id,
    hints: siteHints(site, rule),
  };
}

export async function createSite(ctx: AppContext, input: SiteCreateInput): Promise<SiteSaveResult> {
  const { customer_id, lead_id, ...fields } = input;
  const lead = lead_id ? await getVisibleLead(ctx, lead_id) : null;
  if (!lead && !isInternal(ctx.user.role)) throw forbidden('Link the site to one of your leads (use PUT /leads/:id/site)');
  if (lead) {
    assertLeadEditable(lead);
    if (lead.site_id) throw conflict('This lead already has a site — update it with PUT /leads/:id/site', { site_id: lead.site_id });
    return saveLeadSite(ctx, lead, fields);
  }
  const customer = customer_id ? await ctx.db.table('customers').get(customer_id) : null;
  if (customer_id && !customer) throw notFound('Customer');
  const discomId = await resolveDiscomId(ctx, fields.discom_id, fields.discom_code);
  const base = await ctx.db.table('sites').insert({ ...emptySite(customer?.id ?? null, null), created_by: actorId(ctx) });
  const { site, hints, special } = await persistSite(ctx, null, base, fields, customer?.legal_name ?? null, discomId, 'site.create', true);
  return { customer, site, created: { customer: false, site: true }, hints, special_category: special };
}

export async function updateSite(ctx: AppContext, id: string, input: SiteFieldsInput): Promise<{ site: Site; hints: Hint[]; special_category: SpecialCategoryInfo }> {
  const current = await ctx.db.table('sites').get(id);
  if (!current) throw notFound('Site');
  await assertCanReadSite(ctx, current);
  const lead = current.lead_id ? await ctx.db.table('leads').get(current.lead_id) : null;
  if (lead) assertLeadEditable(lead);
  const customer = current.customer_id ? await ctx.db.table('customers').get(current.customer_id) : null;
  const discomId = await resolveDiscomId(ctx, input.discom_id, input.discom_code);
  const r = await persistSite(ctx, lead, current, input, customer?.legal_name ?? lead?.name ?? null, discomId, 'site.update', false);
  return { site: r.site, hints: r.hints, special_category: r.special };
}

/* ───────────── electricity bill ───────────── */

/** Upload the DISCOM bill for a lead's site (creates the customer + site pair if needed) and mark the lead's bill as captured. */
export async function uploadSiteBill(ctx: AppContext, lead: Lead, req: Request): Promise<{ document: DocumentRow; site: Site; bill_captured: true }> {
  assertLeadEditable(lead);
  const file = filesOf(req)[0];
  if (!file) throw badRequest('Attach the bill as the "file" field');
  assertFilenameAllowed(file.originalname); // before anything is created: a refused file must leave no customer / site behind
  const { site } = await ensureCustomerAndSite(ctx, lead);
  const { document } = await storeDocument(ctx, { file, bucket: 'lead-docs', entity_type: 'site', entity_id: site.id, doc_type: 'electricity_bill' });
  const updated = await ctx.db.table('sites').update(site.id, { bill_doc_id: document.id });
  if (!lead.bill_captured) {
    await ctx.db.table('leads').update(lead.id, { bill_captured: true });
    await recomputeLeadScore(ctx, lead.id); // the quality score has a 'bill captured' component (Appendix A)
  }
  await logLeadEvent(ctx, lead.id, 'bill_uploaded', 'Electricity bill uploaded', { site_id: site.id, document_id: document.id });
  await audit(ctx, { action: 'site.bill_upload', table: 'sites', record_id: site.id, detail: { document_id: document.id, lead_id: lead.id } });
  return { document, site: updated, bill_captured: true };
}

export async function siteBillUrl(ctx: AppContext, siteId: string): Promise<{ url: string; expires_at: string; file_name: string; mime: string | null }> {
  const site = await ctx.db.table('sites').get(siteId);
  if (!site) throw notFound('Site');
  await assertCanReadSite(ctx, site);
  if (!site.bill_doc_id) throw notFound('Bill');
  const doc = await ctx.db.table('documents').get(site.bill_doc_id);
  if (!doc) throw notFound('Bill');
  const signed = await ctx.providers.storage.signedUrl({ bucket: doc.bucket, path: doc.path, method: 'GET', expiresInSec: 300 });
  await audit(ctx, { action: 'document.view', table: 'documents', record_id: doc.id, detail: { site_id: siteId } });
  return { url: signed.url, expires_at: signed.expires_at, file_name: doc.file_name, mime: doc.mime };
}
