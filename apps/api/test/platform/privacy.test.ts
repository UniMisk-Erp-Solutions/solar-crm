import { describe, expect, it } from 'vitest';
import type { Lead } from '@solar/shared';
import { runJob } from '../../src/jobs';
import { IDS, type TestEnv } from '../helpers/env';
import { mkCustomer, mkLead, mkSite, platformEnv } from './fixtures';

const api = '/api/v1';
const PHONE = '9812345678';

/** One person with a trail in every area: consent, timeline, contact log, messages, customer, site, quote, PI, order, documents. */
async function seedPerson(env: TestEnv, opts: { leadOver?: Partial<Lead>; withOrder?: 'closed' | 'approved' | null; issuedPi?: boolean } = {}) {
  const c = env.ctx('admin');
  const iso = env.now().toISOString();
  const lead = await mkLead(env, opts.leadOver);
  const customer = await mkCustomer(env, lead, opts.issuedPi ? { gstin: '24ABCDE1234F1Z5' } : {});
  await c.db.table('leads').update(lead.id, { customer_id: customer.id });
  const site = await mkSite(env, lead, customer);
  await c.db.table('lead_consents').insert({ lead_id: lead.id, notice_version: 'v1', purposes: ['service', 'promotional'], channels: ['whatsapp', 'call'], recipients_named: ['Alpha Solar Distributors'], granted_at: iso, ip: '203.0.113.7', user_agent: 'jest', proof_ref: 'form-1', capture_source: 'website', withdrawn_at: null, withdrawn_by: null, withdrawal_channel: null, optout_suppress_until: null });
  await c.db.table('lead_events').insert({ lead_id: lead.id, event_type: 'created', summary: 'Lead captured', actor_id: null, detail: {} });
  await c.db.table('contact_logs').insert({ lead_id: lead.id, channel: 'call', direction: 'outbound', outcome: 'connected_interested', notes: 'Asha wants a quote before Diwali', duration_min: 4, occurred_at: iso, logged_by: IDS.profile('dsm') });
  await c.db.table('followups').insert({ lead_id: lead.id, kind: 'call', due_at: iso, note: 'Call back about roof', status: 'open', done_at: null, owner_id: IDS.profile('dsm'), outcome: null, reminder_sent_at: null, escalated_level: 0 });
  await c.db.table('message_log').insert({ lead_id: lead.id, channel: 'whatsapp', purpose: 'service', category: 'utility', template_key: 'quote.sent', direction: 'outbound', to_masked: '+91 ••••• ••678', body_preview: `Hi Asha, call us on ${PHONE} or write to asha@example.com`, status: 'sent', block_reason: null, consent_id: null, provider: 'fake', provider_ref: 'm1', created_by: null });
  await c.db.table('notifications').insert({ user_id: IDS.profile('dsm'), target_role: null, kind: 'lead.assigned', title: 'Asha Patel assigned', body: null, severity: 'info', link: null, entity_type: 'lead', entity_id: lead.id, read_at: null });
  const quote = await c.db.table('quotations').insert({ quote_no: 'Q-1', version: 1, parent_quote_id: null, opportunity_id: IDS.org, lead_id: lead.id, customer_id: customer.id, site_id: site.id, segment: 'pmsg_residential', kw: 3, status: 'accepted', validity_date: '2026-12-01', price_snapshot_at: iso, subtotal: 180000, tax_total: 9000, total: 189000, rejected_reason: 'Too costly, Asha said', gst: null } as never);
  await c.db.table('quotation_lines').insert({ quote_id: quote.id, sku_id: null, description: '540 Wp module', hsn: '85414300', gst_rate: 5, gst_as_of: '2026-10-26', tax_approved_by: null, tax_position_approved: true, qty: 6, uom: 'nos', unit_price: 30000, discount_pct: 0, line_total: 180000, price_id: null, sort_order: 1 } as never);
  const draftPi = await c.db.table('proforma_invoices').insert({ pi_no: 'PI-D', quote_id: quote.id, customer_id: customer.id, status: 'draft', legal_name: 'Asha Patel', gstin: null, billing_address: customer.billing_address, shipping_address: customer.shipping_address, subtotal: 100, tax_total: 5, total: 105 } as never);
  const issuedPi = opts.issuedPi ? await c.db.table('proforma_invoices').insert({ pi_no: 'PI-1', quote_id: quote.id, customer_id: customer.id, status: 'issued', legal_name: 'Asha Patel', gstin: '24ABCDE1234F1Z5', billing_address: customer.billing_address, shipping_address: customer.shipping_address, subtotal: 180000, tax_total: 9000, total: 189000 } as never) : null;
  const order = opts.withOrder ? await c.db.table('sales_orders').insert({ so_no: 'SO-1', pi_id: (issuedPi ?? draftPi).id, quote_id: quote.id, customer_id: customer.id, status: opts.withOrder, segment: 'pmsg_residential', order_date: '2026-10-01', total: 189000, advance_received: 189000 } as never) : null;
  const doc = (bucket: 'lead-docs' | 'invoices' | 'site-photos', entity_type: string, entity_id: string, name: string) => {
    const path = `${IDS.org}/${entity_type}/${entity_id}/${name}`;
    env.providers.files.set(`${bucket}/${path}`, Buffer.from(name));
    return c.db.table('documents').insert({ entity_type, entity_id, bucket, path, doc_type: 'other', file_name: name, mime: 'application/pdf', size_bytes: 10, uploaded_by: null });
  };
  const bill = await doc('lead-docs', 'lead', lead.id, 'bill.pdf');
  const photo = await doc('site-photos', 'site', site.id, 'roof.jpg');
  const invoicePdf = await doc('invoices', 'proforma_invoice', (issuedPi ?? draftPi).id, 'pi.pdf');
  return { lead, customer, site, quote, draftPi, issuedPi, order, bill, photo, invoicePdf };
}

describe('data-principal access request (export)', () => {
  it('compiles every personal-data record linked to the person into one JSON and records the request', async () => {
    const env = platformEnv();
    const p = await seedPerson(env, { issuedPi: true, withOrder: 'closed' });
    const r = await env.as('compliance_officer').post(`${api}/privacy/export`).send({ lead_id: p.lead.id });
    expect(r.status).toBe(200);
    const { request, export: bundle } = r.body.data;
    expect(request).toMatchObject({ kind: 'export', status: 'completed', lead_id: p.lead.id });
    expect(bundle.subject).toEqual({ lead_ids: [p.lead.id], customer_ids: [p.customer.id] });
    expect(bundle.summary).toMatchObject({ leads: 1, consents: 1, events: 1, contact_logs: 1, followups: 1, messages: 1, customers: 1, sites: 1, quotes: 1, proforma_invoices: 2, sales_orders: 1, documents: 3 });
    const d = bundle.data;
    expect(d.leads[0]).toMatchObject({ name: 'Asha Patel', mobile: '+919812345678', email: 'asha@example.com' }); // the person’s own data, unmasked
    expect(d.consents[0]).toMatchObject({ purposes: ['service', 'promotional'], channels: ['whatsapp', 'call'] });
    expect(d.contact_logs[0].notes).toBe('Asha wants a quote before Diwali');
    expect(d.customers[0]).toMatchObject({ legal_name: 'Asha Patel', aadhaar_last4: '4321' });
    expect(d.sites[0].name_on_bill).toBe('Asha Patel');
    expect(d.quotes[0]).toMatchObject({ total: 189000 });
    expect(d.quotes[0].lines).toHaveLength(1);
    expect(d.documents.map((x: { file_name: string }) => x.file_name).sort()).toEqual(['bill.pdf', 'pi.pdf', 'roof.jpg']);
    expect(d.documents[0].path).toBeUndefined();
    // message bodies are masked
    const body = d.messages[0].body_preview as string;
    expect(body).not.toContain(PHONE);
    expect(body).not.toContain('asha@example.com');
    expect(body).toContain('••');
    expect(d.messages[0].to_masked).toBe('+91 ••••• ••678');

    expect(await env.db.table('data_requests').count({ kind: 'export', status: 'completed' })).toBe(1);
    const audited = await env.db.table('audit_log').all({ action: 'privacy.export' });
    expect(audited).toHaveLength(1);
    expect(JSON.stringify(audited[0])).not.toContain(PHONE);
    // nothing was changed
    expect((await env.db.table('leads').get(p.lead.id))!.name).toBe('Asha Patel');
  });

  it('finds the same person from the customer id, is limited to compliance/admin and validates input', async () => {
    const env = platformEnv();
    const p = await seedPerson(env);
    const byCustomer = await env.as('admin').post(`${api}/privacy/export`).send({ customer_id: p.customer.id });
    expect(byCustomer.body.data.export.subject.lead_ids).toEqual([p.lead.id]);
    expect((await env.as('admin').post(`${api}/privacy/export`).send({ lead_id: p.lead.id, customer_id: p.customer.id })).status).toBe(422);
    expect((await env.as('admin').post(`${api}/privacy/export`).send({})).status).toBe(422);
    expect((await env.as('admin').post(`${api}/privacy/export`).send({ lead_id: IDS.org })).status).toBe(404);
    for (const role of ['management', 'dsm', 'sales_manager', 'distributor_user']) {
      expect((await env.as(role).post(`${api}/privacy/export`).send({ lead_id: p.lead.id })).status, role).toBe(403);
    }
    const list = await env.as('compliance_officer').get(`${api}/privacy/requests?kind=export`);
    expect(list.body.total).toBe(1);
  });
});

describe('erasure (anonymisation)', () => {
  it('anonymises personal data, withdraws consent, removes bills and photos, and keeps financial aggregates', async () => {
    const env = platformEnv();
    const p = await seedPerson(env, { issuedPi: true, withOrder: 'closed' });
    const r = await env.as('compliance_officer').post(`${api}/privacy/erase`).send({ lead_id: p.lead.id, reason: 'Data principal request DPR-2026-014' });
    expect(r.status).toBe(200);
    const { request, report } = r.body.data;
    expect(request).toMatchObject({ kind: 'erasure', status: 'completed' });
    expect(report.counts).toMatchObject({ leads: 1, consents_withdrawn: 1, contact_logs: 1, documents_deleted: 2, documents_retained: 1 });
    expect(report.message_log.total).toBe(1);
    expect(report.message_log.scrubbed + report.message_log.retained_append_only).toBe(1);
    expect(report.retained.map((x: { table: string }) => x.table)).toEqual(expect.arrayContaining(['lead_consents', 'sales_orders', 'proforma_invoices', 'customers']));

    const lead = (await env.db.table('leads').get(p.lead.id))!;
    expect(lead).toMatchObject({ name: 'Erased', email: null, pincode: null, city: null, consumer_no: null, requirement_text: null, notes: null, budget_inr: null, source_ref: null, source_detail: {}, next_action: null, next_followup_at: null, status: 'lost' });
    expect(lead.mobile).toMatch(/^erased-[0-9a-f]{8}$/);
    expect(lead.mobile).not.toContain('9812');
    expect(lead.anonymised_at).toBe(env.now().toISOString());
    // aggregates survive
    expect(lead).toMatchObject({ segment: 'pmsg_residential', capacity_kw: 3, state: 'Gujarat', district: 'Ahmedabad', source: 'manual', temperature: 'warm', distributor_id: IDS.distributorA });

    // consent ledger: withdrawn, but metadata kept
    const consents = await env.db.table('lead_consents').all({ lead_id: p.lead.id });
    expect(consents).toHaveLength(1);
    expect(consents[0]).toMatchObject({ purposes: ['service', 'promotional'], channels: ['whatsapp', 'call'], notice_version: 'v1', withdrawal_channel: 'erasure' });
    expect(consents[0]!.withdrawn_at).not.toBeNull();

    // free text and personal child records
    expect((await env.db.table('contact_logs').all({ lead_id: p.lead.id }))[0]).toMatchObject({ notes: null, channel: 'call', outcome: 'connected_interested' });
    expect((await env.db.table('followups').all({ lead_id: p.lead.id }))[0]).toMatchObject({ note: null, status: 'cancelled' });
    expect(await env.db.table('site_surveys').count()).toBe(0);
    expect(await env.db.table('sites').get(p.site.id)).toMatchObject({ name_on_bill: null, applicant_name: null, consumer_no: null, address: null, lat: null, lng: null, state: 'Gujarat', sanctioned_load_kw: 5 });
    expect(await env.db.table('notifications').count({ entity_id: p.lead.id })).toBe(0);
    expect(await env.db.table('lead_events').count({ lead_id: p.lead.id, event_type: 'privacy_erased' })).toBe(1);

    // personal documents deleted from storage and table; the statutory invoice PDF stays
    expect(await env.db.table('documents').get(p.bill.id)).toBeNull();
    expect(await env.db.table('documents').get(p.photo.id)).toBeNull();
    expect(env.providers.files.has(`lead-docs/${p.bill.path}`)).toBe(false);
    expect(env.providers.files.has(`site-photos/${p.photo.path}`)).toBe(false);
    expect(await env.db.table('documents').get(p.invoicePdf.id)).not.toBeNull();
    expect(env.providers.files.has(`invoices/${p.invoicePdf.path}`)).toBe(true);

    // statutory financial records keep amounts and GST data
    const quote = (await env.db.table('quotations').get(p.quote.id))!;
    expect(quote).toMatchObject({ subtotal: 180000, tax_total: 9000, total: 189000, rejected_reason: null });
    expect(await env.db.table('quotation_lines').count({ quote_id: p.quote.id })).toBe(1);
    expect(await env.db.table('proforma_invoices').get(p.issuedPi!.id)).toMatchObject({ total: 189000, tax_total: 9000, gstin: '24ABCDE1234F1Z5', status: 'issued' });
    expect(await env.db.table('proforma_invoices').get(p.draftPi.id)).toMatchObject({ legal_name: 'Erased', gstin: null, billing_address: null }); // a draft is not a statutory record
    expect(await env.db.table('sales_orders').get(p.order!.id)).toMatchObject({ total: 189000, advance_received: 189000 });
    const customer = (await env.db.table('customers').get(p.customer.id))!;
    expect(customer).toMatchObject({ email: null, phone: null, aadhaar_last4: null, display_name: null, legal_name: 'Asha Patel', gstin: '24ABCDE1234F1Z5' }); // tax identity kept
    expect(customer.anonymised_at).not.toBeNull();

    // audited without personal data; running it again is refused
    const audited = await env.db.table('audit_log').all({ action: 'privacy.erase' });
    expect(audited).toHaveLength(1);
    expect(JSON.stringify(audited)).not.toContain('Asha');
    expect((await env.as('compliance_officer').post(`${api}/privacy/erase`).send({ lead_id: p.lead.id, reason: 'Again please' })).status).toBe(409);
  });

  it('fully anonymises a customer with no statutory records, and closes open work for the lead', async () => {
    const env = platformEnv();
    const p = await seedPerson(env);
    const c = env.ctx('admin');
    await c.svc.clocks.start({ entity_type: 'lead', entity_id: p.lead.id, clock_type: 'followup', due_at: new Date(env.now().getTime() + 3600_000) });
    const r = await env.as('admin').post(`${api}/privacy/erase`).send({ lead_id: p.lead.id, reason: 'Withdrew from the programme' });
    expect(r.status).toBe(200);
    expect(await env.db.table('customers').get(p.customer.id)).toMatchObject({ legal_name: 'Erased', gstin: null, pan: null, billing_address: null, shipping_address: null, email: null, phone: null });
    expect((await env.db.table('clocks').all({ entity_id: p.lead.id }))[0]!.status).toBe('cancelled');
    expect(await env.db.table('proforma_invoices').get(p.draftPi.id)).toMatchObject({ legal_name: 'Erased' });
  });

  it('erases duplicates of the same person together', async () => {
    const env = platformEnv();
    const p = await seedPerson(env);
    const twin = await mkLead(env, { name: 'Asha P.', mobile: '+919812345678', status: 'duplicate', duplicate_of: p.lead.id });
    const r = await env.as('admin').post(`${api}/privacy/erase`).send({ lead_id: p.lead.id, reason: 'Request covers all records' });
    expect(r.body.data.report.lead_ids.sort()).toEqual([p.lead.id, twin.id].sort());
    expect((await env.db.table('leads').get(twin.id))).toMatchObject({ name: 'Erased', status: 'duplicate' });
  });

  it('is refused while an order is open, unless the rule allows it; and limited to compliance/admin', async () => {
    const env = platformEnv();
    const p = await seedPerson(env, { issuedPi: true, withOrder: 'approved' });
    const blocked = await env.as('compliance_officer').post(`${api}/privacy/erase`).send({ lead_id: p.lead.id, reason: 'Request while order is open' });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('GUARD_BLOCKED');
    expect((await env.db.table('leads').get(p.lead.id))!.name).toBe('Asha Patel');
    expect(await env.db.table('data_requests').count()).toBe(0);
    for (const role of ['management', 'dsm', 'accounts']) {
      expect((await env.as(role).post(`${api}/privacy/erase`).send({ lead_id: p.lead.id, reason: 'Not allowed to do this' })).status, role).toBe(403);
    }
    expect((await env.as('admin').post(`${api}/privacy/erase`).send({ lead_id: p.lead.id, reason: 'x' })).status).toBe(422); // reason too short
    await env.rule('privacy.erase_blocked_by_open_orders', false);
    expect((await env.as('admin').post(`${api}/privacy/erase`).send({ lead_id: p.lead.id, reason: 'Override agreed with counsel' })).status).toBe(200);
  });
});

describe('retention job', () => {
  const OLD = '2026-01-01T00:00:00.000Z';
  async function staleLeads(env: TestEnv) {
    const old = await mkLead(env, { name: 'Long gone', mobile: '+919000000031', status: 'lost', last_action_at: OLD, next_followup_at: null, updated_at: OLD });
    const recent = await mkLead(env, { name: 'Recent', mobile: '+919000000032', status: 'lost' });
    const opp = await mkLead(env, { name: 'Open opportunity', mobile: '+919000000033', status: 'opportunity', last_action_at: OLD, next_followup_at: null, updated_at: OLD });
    const scheduled = await mkLead(env, { name: 'Has a follow-up booked', mobile: '+919000000034', status: 'nurture', last_action_at: OLD, updated_at: OLD });
    return { old, recent, opp, scheduled };
  }
  const details = (r: { details: unknown }) => r.details as { lead_inactive: { mode: string; candidates: number; acted: number; failed: number; sample_ids: string[]; days: number | null }; dnd_register: { mode: string; candidates: number; acted: number }; message_bodies: { mode: string; candidates: number; acted: number; failed: number }; note: string };

  it('only REPORTS candidates while its rule is inactive or unverified, and never changes data', async () => {
    const env = platformEnv();
    const { old } = await staleLeads(env);
    const rule = await env.rule('retention.lead_inactive_days', 90, { status: 'unverified', is_active: false, confidence: 'hypothesis' });
    await env.rule('retention.dnd_register_days', 30, { status: 'unverified', is_active: false });
    await env.ctx('admin').db.table('dnd_register').insert({ mobile_hash: 'h1', status: 'clear', checked_at: OLD, source: 'mock' });

    const [first] = await runJob(env.deps, 'privacy.retention');
    expect(first!.status).toBe('ok');
    expect(details(first!).lead_inactive).toMatchObject({ mode: 'report', days: 90, candidates: 1, acted: 0, sample_ids: [old.id] });
    expect(details(first!).dnd_register).toMatchObject({ mode: 'report', candidates: 1, acted: 0 });
    expect(details(first!).message_bodies.mode).toBe('skipped'); // no rule at all
    expect(details(first!).note).toMatch(/report only/i);
    expect((await env.db.table('leads').get(old.id))).toMatchObject({ name: 'Long gone', anonymised_at: null });
    expect(await env.db.table('dnd_register').count()).toBe(1);
    expect(await env.db.table('data_requests').count()).toBe(0);

    // active but still unverified → still advisory
    await env.db.table('rule_config').update(rule.id, { is_active: true });
    expect(details((await runJob(env.deps, 'privacy.retention'))[0]!).lead_inactive.mode).toBe('report');
    expect((await env.db.table('leads').get(old.id))!.anonymised_at).toBeNull();
  });

  it('acts once the rule is verified and active — anonymising only genuinely inactive leads', async () => {
    const env = platformEnv();
    const { old, recent, opp, scheduled } = await staleLeads(env);
    const leadRule = await env.rule('retention.lead_inactive_days', 90, { status: 'unverified', is_active: false });
    const dndRule = await env.rule('retention.dnd_register_days', 30, { status: 'unverified', is_active: false });
    const msgRule = await env.rule('retention.message_body_days', 30, { status: 'unverified', is_active: false });
    await env.ctx('admin').db.table('dnd_register').insert({ mobile_hash: 'h1', status: 'clear', checked_at: OLD, source: 'mock' });
    await env.ctx('admin').db.table('dnd_register').insert({ mobile_hash: 'h2', status: 'clear', checked_at: env.now().toISOString(), source: 'mock' });
    await env.ctx('admin').db.table('message_log').insert({ lead_id: old.id, channel: 'sms', purpose: 'service', category: null, template_key: null, direction: 'outbound', to_masked: '+91 ••••• ••031', body_preview: 'Old text', status: 'sent', block_reason: null, consent_id: null, provider: 'fake', provider_ref: null, created_by: null, created_at: OLD });

    // a compliance officer activates the rules through the API
    for (const r of [leadRule, dndRule, msgRule]) {
      await env.as('compliance_officer').patch(`${api}/rules/${r.id}`).send({ status: 'verified', source_ref: 'Counsel opinion 2026-10-20' });
      expect((await env.as('compliance_officer').post(`${api}/rules/${r.id}/activate`).send({})).status).toBe(200);
    }
    const [run] = await runJob(env.deps, 'privacy.retention');
    const d = details(run!);
    expect(d.lead_inactive).toMatchObject({ mode: 'apply', candidates: 1, acted: 1, failed: 0 });
    expect(d.dnd_register).toMatchObject({ mode: 'apply', candidates: 1, acted: 1 });
    expect(d.message_bodies.mode).toBe('apply');
    expect(d.message_bodies.acted + d.message_bodies.failed).toBe(d.message_bodies.candidates); // append-only ledgers may refuse; the job reports it
    expect((await env.db.table('leads').get(old.id))).toMatchObject({ name: 'Erased', status: 'lost' });
    for (const keep of [recent, opp, scheduled]) expect((await env.db.table('leads').get(keep.id))!.anonymised_at, keep.name).toBeNull();
    expect(await env.db.table('dnd_register').count()).toBe(1);
    expect((await env.db.table('dnd_register').all())[0]!.mobile_hash).toBe('h2');
    const req = await env.db.table('data_requests').all();
    expect(req).toHaveLength(1);
    expect(req[0]).toMatchObject({ kind: 'erasure', status: 'completed' });
    expect(req[0]!.notes).toContain('retention.lead_inactive_days');
    expect(await env.db.table('audit_log').count({ action: 'privacy.erase_retention' })).toBe(1);
    // idempotent
    expect(details((await runJob(env.deps, 'privacy.retention'))[0]!).lead_inactive.candidates).toBe(0);
  });

  it('honours the batch size, and an explicitly enforced unverified rule may act', async () => {
    const env = platformEnv();
    for (let i = 0; i < 3; i++) {
      await mkLead(env, { name: `Old ${i}`, mobile: `+91900000004${i}`, status: 'lost', last_action_at: OLD, next_followup_at: null, updated_at: OLD });
    }
    await env.rule('retention.lead_inactive_days', 90, { status: 'unverified', is_active: true, enforce_hard_stop: true });
    await env.rule('retention.batch_size', 2);
    const d = details((await runJob(env.deps, 'privacy.retention'))[0]!);
    expect(d.lead_inactive).toMatchObject({ mode: 'apply', candidates: 3, acted: 2 });
    expect(await env.db.table('leads').count({ anonymised_at: { is_null: false } })).toBe(2);
  });

  it('skips people with an open order', async () => {
    const env = platformEnv();
    const p = await seedPerson(env, { withOrder: 'approved', leadOver: { status: 'lost', last_action_at: OLD, next_followup_at: null, updated_at: OLD } });
    await env.rule('retention.lead_inactive_days', 90);
    const d = details((await runJob(env.deps, 'privacy.retention'))[0]!);
    expect(d.lead_inactive.candidates).toBe(0);
    expect((await env.db.table('leads').get(p.lead.id))!.anonymised_at).toBeNull();
  });
});

describe('unmask audit', () => {
  it('lists who revealed personal data, restricted to compliance/admin', async () => {
    const env = platformEnv();
    const lead = await mkLead(env);
    const log = (actor: string, action: string, at: Date) => env.db.table('audit_log').insert({ org_id: IDS.org, actor_id: actor, action, table_name: 'leads', record_id: lead.id, old_data: null, new_data: null, detail: { field: 'mobile' }, source: 'api', request_id: null, ip: '10.0.0.5', created_at: at.toISOString() });
    await log(IDS.profile('dsm'), 'mobile.unmask', new Date('2026-10-25T05:00:00Z'));
    await log(IDS.profile('sales_manager'), 'lead.unmask_mobile', new Date('2026-10-26T05:00:00Z'));
    await log(IDS.profile('dsm'), 'lead.update', new Date('2026-10-26T05:00:00Z'));
    const r = await env.as('compliance_officer').get(`${api}/privacy/audit-unmask`);
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(2);
    expect(r.body.data[0]).toMatchObject({ action: 'lead.unmask_mobile', actor_name: 'Test sales_manager', actor_role: 'sales_manager', record_id: lead.id, ip: '10.0.0.5' });
    expect((await env.as('admin').get(`${api}/privacy/audit-unmask?actor=${IDS.profile('dsm')}`)).body.total).toBe(1);
    expect((await env.as('admin').get(`${api}/privacy/audit-unmask?from=2026-10-26T00:00:00Z`)).body.total).toBe(1);
    expect((await env.as('admin').get(`${api}/privacy/audit-unmask?record=${lead.id}&limit=1`)).body.data).toHaveLength(1);
    for (const role of ['management', 'dsm', 'viewer', 'distributor_user']) expect((await env.as(role).get(`${api}/privacy/audit-unmask`)).status, role).toBe(403);
  });
});
