import type { Customer, Lead, Site } from '@solar/shared';
import admin from '../../src/routes/admin.routes';
import documents from '../../src/routes/documents.routes';
import platform from '../../src/routes/platform.routes';
import privacy from '../../src/routes/privacy.routes';
import { IDS, createTestEnv, type TestEnv, type TestEnvOptions } from '../helpers/env';

/** Test environment with all four platform routers mounted. */
export const platformEnv = (opts: TestEnvOptions = {}): TestEnv => createTestEnv({ ...opts, authed: [platform, admin, documents, privacy] });

export async function mkLead(env: TestEnv, over: Partial<Lead> = {}): Promise<Lead> {
  const iso = env.now().toISOString();
  return env.ctx('admin').db.table('leads').insert({
    source: 'manual', source_ref: 'camp-1', source_detail: { form: 'website', ip: '203.0.113.7' }, notice_version: 'v1', name: 'Asha Patel', mobile: '+919812345678', email: 'asha@example.com',
    pincode: '380001', city: 'Ahmedabad', district: 'Ahmedabad', state: 'Gujarat', segment: 'pmsg_residential', customer_type: 'residential', capacity_kw: 3, product_interest: ['module'],
    status: 'assigned', temperature: 'warm', quality_score: 60, owner_id: IDS.profile('dsm'), distributor_id: IDS.distributorA, dealer_id: null, territory_id: IDS.territoryAhmedabad,
    customer_id: null, site_id: null, consumer_no: '12345678', last_action: 'Called', last_action_at: iso, next_action: 'Site visit', next_followup_at: new Date(env.now().getTime() + 86_400_000).toISOString(),
    assigned_at: iso, accepted_at: null, sla_due_at: null, first_contacted_at: null, language: 'en', lock_status: 'open', locked_by_dealer_id: null, duplicate_of: null, dnd_status: 'clear', dnd_checked_at: iso,
    requirement_text: 'Rooftop 3 kW for my home', timeline_bucket: 'within_30_days', budget_inr: 200000, decision_maker: 'self', decision_maker_access: true, bill_captured: true, nurture_until: null,
    nurture_reason: null, lost_reason: null, notes: 'Prefers evening calls', deadline_uplift: false, anonymised_at: null, deleted_at: null, ...over,
  });
}

export async function mkCustomer(env: TestEnv, lead: Lead, over: Partial<Customer> = {}): Promise<Customer> {
  return env.ctx('admin').db.table('customers').insert({
    legal_name: 'Asha Patel', display_name: 'Asha', customer_type: 'residential', gstin: null, pan: 'ABCDE1234F', email: 'asha@example.com', phone: '+919812345678',
    billing_address: { line1: '12 Lake Road', city: 'Ahmedabad', state: 'Gujarat', pincode: '380001' }, shipping_address: { line1: '12 Lake Road', city: 'Ahmedabad', state: 'Gujarat', pincode: '380001' },
    state: 'Gujarat', lead_id: lead.id, aadhaar_last4: '4321', anonymised_at: null, ...over,
  });
}

export async function mkSite(env: TestEnv, lead: Lead, customer: Customer | null, over: Partial<Site> = {}): Promise<Site> {
  return env.ctx('admin').db.table('sites').insert({
    customer_id: customer?.id ?? null, lead_id: lead.id, name_on_bill: 'Asha Patel', applicant_name: 'Asha Patel', name_match: true, consumer_no: '12345678', discom_id: null,
    sanctioned_load_kw: 5, contracted_demand_kva: null, phase: 'single', address: { line1: '12 Lake Road', city: 'Ahmedabad', state: 'Gujarat', pincode: '380001' }, pincode: '380001', city: 'Ahmedabad',
    district: 'Ahmedabad', state: 'Gujarat', lat: 23.02, lng: 72.57, roof_ownership: 'owned', title_ok: true, pending_dues: false, existing_solar_kw: 0, category: 'general',
    special_category_state: false, roof_type: 'rcc', load_type: 'home', bill_doc_id: null, ...over,
  });
}
