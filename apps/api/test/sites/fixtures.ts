import type { Lead, Opportunity, Site, SiteSurvey } from '@solar/shared';
import customersRouter from '../../src/routes/customers.routes';
import opportunitiesRouter from '../../src/routes/opportunities.routes';
import { IDS, createTestEnv, type TestEnv } from '../helpers/env';

export const API = '/api/v1';

/** A test environment with the site + opportunity routers mounted (plus DISCOM masters). */
export async function makeEnv(): Promise<TestEnv> {
  const env = createTestEnv({ authed: [customersRouter, opportunitiesRouter] });
  const c = env.ctx();
  for (const [code, name] of [['UGVCL', 'Uttar Gujarat Vij Company Ltd'], ['DGVCL', 'Dakshin Gujarat Vij Company Ltd']] as const) {
    await c.db.table('discoms').insert({ code, name, state: 'Gujarat', kind: 'discom' });
  }
  return env;
}

/** Feasibility rules as the seed ships them (verified, active). */
export async function feasibilityRules(env: TestEnv): Promise<void> {
  await env.rule('discom.feasibility_study_exempt_up_to_kw', 10);
  await env.rule('discom.feasibility_study_days_above_10kw', 15);
}

export function seedLead(env: TestEnv, o: Partial<Lead> = {}): Promise<Lead> {
  return env.ctx().db.table('leads').insert({
    source: 'manual', source_ref: null, source_detail: {}, notice_version: null, name: 'Ramesh Patel', mobile: '+919876543210', email: 'ramesh@example.com',
    pincode: '380001', city: 'Ahmedabad', district: 'Ahmedabad', state: 'Gujarat', segment: 'pmsg_residential', customer_type: 'residential', capacity_kw: 5, product_interest: [],
    status: 'qualified', temperature: 'warm', quality_score: 60, owner_id: IDS.profile('dsm'), distributor_id: IDS.distributorA, dealer_id: IDS.dealerA1, territory_id: IDS.territoryAhmedabad,
    customer_id: null, site_id: null, consumer_no: null, language: 'en', lock_status: 'open', dnd_status: 'clear', bill_captured: false, deadline_uplift: false, ...o,
  });
}

/** A lead owned by distributor B (for isolation tests). */
export const seedLeadB = (env: TestEnv, o: Partial<Lead> = {}): Promise<Lead> => seedLead(env, { name: 'Bina Shah', distributor_id: IDS.distributorB, dealer_id: IDS.dealerB1, ...o });

export const in2days = (env: TestEnv): string => new Date(env.now().getTime() + 2 * 86_400_000).toISOString();

/** Save the site form through the API (creates customer + site). */
export async function saveSite(env: TestEnv, lead: Lead, body: Record<string, unknown> = {}, as = 'dsm'): Promise<{ customer_id: string; site: Site }> {
  const r = await env.as(as).put(`${API}/leads/${lead.id}/site`).send({ name_on_bill: lead.name, consumer_no: '12345678', sanctioned_load_kw: 6, phase: 'single', ...body });
  if (r.status >= 300) throw new Error(`saveSite failed: ${r.status} ${JSON.stringify(r.body)}`);
  return { customer_id: r.body.data.customer.id as string, site: r.body.data.site as Site };
}

export async function scheduleSurvey(env: TestEnv, lead: Lead, o: Record<string, unknown> = {}, as = 'dsm'): Promise<SiteSurvey> {
  const r = await env.as(as).post(`${API}/surveys`).send({ lead_id: lead.id, scheduled_at: in2days(env), surveyor_id: IDS.profile('techno_commercial'), ...o });
  if (r.status >= 300) throw new Error(`scheduleSurvey failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data as SiteSurvey;
}

export const completeBody = { status: 'completed', shading: 'low', roof_type: 'rcc', roof_area_sqm: 42, sld_ref: 'SLD-001', notes: 'Clear south-facing roof' };

/** Lead with a saved site (ready to convert). */
export async function convertibleLead(env: TestEnv, o: Partial<Lead> = {}): Promise<Lead> {
  const lead = await seedLead(env, { ...o, status: 'qualified' }); // the site form refuses merged/duplicate leads, so set the wanted status afterwards
  await saveSite(env, lead);
  if (o.status && o.status !== 'qualified') await env.db.table('leads').update(lead.id, { status: o.status });
  return (await env.db.table('leads').get(lead.id))!;
}

export const allConfirmed = { requirement_confirmed: true, timeline_confirmed: true, commercial_potential_confirmed: true };

/** Convert a lead through the API (all three confirmations true unless overridden) and return the hydrated opportunity. */
export async function convert(env: TestEnv, lead: Lead, body: Record<string, unknown> = {}, as = 'dsm'): Promise<Opportunity & { [k: string]: unknown }> {
  const r = await env.as(as).post(`${API}/leads/${lead.id}/convert`).send({ ...allConfirmed, ...body });
  if (r.status >= 300) throw new Error(`convert failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data.opportunity;
}

/** A converted opportunity on a fresh lead. */
export async function seedOpportunity(env: TestEnv, leadOverrides: Partial<Lead> = {}, body: Record<string, unknown> = {}, as = 'dsm'): Promise<Opportunity & { [k: string]: unknown }> {
  return convert(env, await convertibleLead(env, leadOverrides), body, as);
}
