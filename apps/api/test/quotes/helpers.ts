/** Shared fixtures for the compliance and quote tests. Nothing here talks to a real provider. */
import { seedId, verhoeffCheckDigit, type Lead, type Opportunity, type Quotation, type Segment, type Sku, type SkuCompliance, type SkuPrice, type Site, type Json } from '@solar/shared';
import type { AppContext } from '../../src/auth/context';
import approvalsRouter from '../../src/routes/approvals.routes';
import complianceRouter from '../../src/routes/compliance.routes';
import quotesRouter from '../../src/routes/quotes.routes';
import skusRouter from '../../src/routes/skus.routes';
import type { OutboundCheck } from '../../src/services/contracts';
import { IDS, T0, createTestEnv, type TestEnv } from '../helpers/env';

export const TODAY = '2026-10-26';
const iso = T0.toISOString();

export interface Stubs {
  /** consent decision per channel; default: allowed */
  consent: (channel: string) => OutboundCheck;
  sent: { channel: string; subject?: string; body?: string; template_key?: string; attachments?: number; lead_id: string }[];
  /** messaging result override */
  blocked: boolean;
}

export const allowed = (): OutboundCheck => ({ allowed: true, consent_id: 'consent-1', reasons: [] });
export const denied = (code: 'NO_CONSENT' | 'SUPPRESSED_90_DAY' | 'DND_STALE', message: string): OutboundCheck => ({ allowed: false, consent_id: null, reasons: [{ code, message }] });

export interface World {
  env: TestEnv;
  stubs: Stubs;
  /** a FRESH admin context (the rule service caches per context, so take a new one after changing rules) */
  c(role?: string): AppContext;
  ids: { lead: string; customer: string; site: string; opp: string };
}

export interface WorldOpts {
  segment?: Segment; kw?: number; commissioning?: string | null; exemption?: boolean; dealerId?: string | null; fundingLoanPct?: number; siteOver?: Partial<Site>; oppOver?: Partial<Opportunity>;
  /** seed the standard regulatory rules (default true) */
  rules?: boolean;
}

/** Verified + active rules a healthy tenant has, at the values the research report gives. */
export async function seedStandardRules(env: TestEnv): Promise<void> {
  const r = env.rule.bind(env);
  await r('pmsg.dcr_required_for_cfa', true);
  await r('almm.list1.enforcement_date', '2024-04-01');
  await r('almm.list2.effective_date', '2026-06-01');
  await r('almm.list2.exemption_net_metering_open_access_until', '2026-12-31');
  await r('bis.module_standard_no', 'IS 14286');
  await r('bis.inverter_self_cert_above_kw', 200);
  await r('bis.inverter_self_cert_until', '2026-12-31');
  await r('gst.modules_cells_rate', 5);
  await r('pmsg.cfa.max_kw_eligible', 3);
  await r('trai.optout_reconsent_block_days', 90);
  await r('compliance.aadhaar_block', true);
  await r('compliance.almm_snapshot_max_age_days', 7, { max_severity: 'warning' });
  await r('quote.default_validity_days', 7, { max_severity: 'warning' });
  await r('quote.max_price_snapshot_age_days', 14, { max_severity: 'warning' });
  // CFA
  await r('pmsg.cfa.per_kw_first_2kw', 30000, { max_severity: 'warning' });
  await r('pmsg.cfa.third_kw', 18000, { max_severity: 'warning' });
  await r('pmsg.cfa.max_total', 78000, { max_severity: 'warning' });
  await r('pmsg.cfa.special_category.per_kw_first_2kw', 33000, { max_severity: 'warning' });
  await r('pmsg.cfa.special_category.third_kw', 19800, { max_severity: 'warning' });
  await r('rwa_ghs.cfa_per_kw', 18000, { max_severity: 'warning' });
  await r('rwa_ghs.max_kw', 500, { max_severity: 'warning' });
  await r('rwa_ghs.kw_per_household', 3, { max_severity: 'warning' });
}

export async function makeWorld(o: WorldOpts = {}): Promise<World> {
  const stubs: Stubs = { consent: () => allowed(), sent: [], blocked: false };
  const env = createTestEnv({
    authed: [skusRouter, quotesRouter, approvalsRouter, complianceRouter],
    serviceOverrides: {
      consent: () => ({ checkOutbound: async (_lead, input) => stubs.consent(input.channel) }),
      messaging: () => ({
        send: async (input) => {
          stubs.sent.push({ channel: input.channel, subject: input.subject, body: input.body, template_key: input.template_key, attachments: input.attachments?.length ?? 0, lead_id: input.lead_id });
          return stubs.blocked
            ? { status: 'blocked', blocked: true, reasons: [{ code: 'NO_CONSENT', message: 'blocked by test' }], message_log_id: 'm', template_category: null }
            : { status: 'sent', blocked: false, reasons: [], message_log_id: 'm', template_category: null };
        },
      }),
    },
  });
  if (o.rules !== false) await seedStandardRules(env);
  const ctx = env.ctx('admin');
  const lead = await ctx.db.table('leads').insert({
    name: 'Ravi Patel', mobile: '+919876543210', email: 'ravi@example.com', source: 'manual', status: 'qualified', segment: o.segment ?? 'pmsg_residential', capacity_kw: o.kw ?? 3, state: 'Gujarat', product_interest: [],
    owner_id: IDS.profile('dsm'), distributor_id: IDS.distributorA, dealer_id: IDS.dealerA1, territory_id: IDS.territoryAhmedabad,
  } as Partial<Lead>);
  const customer = await ctx.db.table('customers').insert({ legal_name: 'Ravi Patel', customer_type: 'residential', state: 'Gujarat', lead_id: lead.id, email: 'ravi@example.com' });
  const site = await ctx.db.table('sites').insert({
    customer_id: customer.id, lead_id: lead.id, name_on_bill: 'Ravi Patel', applicant_name: 'Ravi Patel', name_match: true, state: 'Gujarat', city: 'Ahmedabad', pincode: '380001', pending_dues: false,
    existing_solar_kw: 0, category: 'general', special_category_state: false, ...(o.siteOver ?? {}),
  } as Partial<Site>);
  const opp = await ctx.db.table('opportunities').insert({
    name: 'Patel rooftop', lead_id: lead.id, customer_id: customer.id, site_id: site.id, segment: o.segment ?? 'pmsg_residential', kw: o.kw ?? 3, scheme_route: 'pmsg',
    funding_mix: { consumer_pct: 100 - (o.fundingLoanPct ?? 0), loan_pct: o.fundingLoanPct ?? 0, subsidy_pct: 0 }, probability: 60, expected_value: 200000,
    expected_close_date: '2026-11-30', expected_commissioning_date: o.commissioning === undefined ? '2026-12-01' : o.commissioning, competitor: null, regulation_version: null,
    exemption_reliance: o.exemption ?? false, requirement_confirmed: true, timeline_confirmed: true, commercial_potential_confirmed: true, stage: 'qualified', lost_reason: null,
    owner_id: IDS.profile('dsm'), distributor_id: IDS.distributorA, dealer_id: o.dealerId === undefined ? IDS.dealerA1 : o.dealerId, territory_id: IDS.territoryAhmedabad, ...(o.oppOver ?? {}),
  } as Partial<Opportunity>);
  return { env, stubs, c: (role = 'admin') => env.ctx(role), ids: { lead: lead.id, customer: customer.id, site: site.id, opp: opp.id } };
}

export interface SkuOpts {
  category?: Sku['category']; make?: string; model?: string; hsn?: string | null; active?: boolean;
  /** null = no compliance register entry */
  compliance?: Partial<SkuCompliance> | null;
  /** null = no price snapshot */
  price?: Partial<SkuPrice> | null;
}
let skuCounter = 0;

/** A SKU that passes every product gate unless you override a field. */
export async function addSku(w: World, o: SkuOpts = {}): Promise<Sku> {
  const ctx = w.c();
  const n = ++skuCounter;
  const category = o.category ?? 'module';
  const model = o.model ?? `TOPCon-${n}`;
  const sku = await ctx.db.table('skus').insert({
    category, make: o.make ?? 'Waaree', model, variant: null, wattage: category === 'module' ? 540 : null, hsn: o.hsn === undefined ? (category === 'module' ? '85414300' : '85044090') : o.hsn, uom: 'nos',
    active: o.active ?? true, demo: false, description: null, warranty_years: 25,
    brand_usp: { quality: 'Tier-1 cells', warranty: '25-year performance', certifications: 'IEC, BIS', service_support: 'Pan-India', delivery_reliability: '98% on time' },
  } as Partial<Sku>);
  if (o.compliance !== null) {
    await ctx.db.table('sku_compliance').insert({
      sku_id: sku.id, almm_list1: true, almm_list1_ref: 'ALMM/1', almm_list1_valid_till: '2027-12-31', almm_snapshot_date: TODAY, cell_maker: 'Waaree', almm_list2: true, dcr_verified: true, cell_origin: 'India',
      bis_licence_no: `BIS-${n}`, bis_licensed_model: model, bis_standard_no: 'IS 14286', bis_valid_till: '2027-12-31', inverter_kw: null, self_certified: false, thin_film: false, verified_by: null, verified_at: iso,
      ...(o.compliance ?? {}),
    } as Partial<SkuCompliance>);
  }
  if (o.price !== null) {
    await ctx.db.table('sku_prices').insert({ sku_id: sku.id, base_price: 20000, valid_from: '2026-01-01', valid_to: null, landed_cost: { basic: 12000, bcd: 1000, freight: 500 }, floor_price: 15000, source: 'test', snapshot_label: 'Q4', ...(o.price ?? {}) } as Partial<SkuPrice>);
  }
  return sku;
}

/** Create a quote through the service and put the SKUs on it (qty 1 each unless given). */
export async function quoteWith(w: World, skus: Sku[], opts: { qty?: number; discount_pct?: number; unit_price?: number } = {}): Promise<Quotation> {
  const { createQuote, replaceLines } = await import('../../src/services/quoteService');
  const created = await createQuote(w.c(), { opportunity_id: w.ids.opp });
  await replaceLines(w.c(), created.id, { lines: skus.map((s) => ({ sku_id: s.id, qty: opts.qty ?? 1, discount_pct: opts.discount_pct ?? 0, unit_price: opts.unit_price })) });
  return w.c().db.table('quotations').getOrThrow(created.id);
}

/** Evaluate with a fresh context so rules changed by the test are seen. */
export async function evaluate(w: World, quoteId: string) {
  return w.c().svc.compliance.evaluateQuote(quoteId);
}
export const gate = <T extends { gate: string }>(r: { findings: T[] }, g: string): T[] => r.findings.filter((f) => f.gate === g);
export const real = <T extends { gate: string; severity: string }>(r: { findings: T[] }, g: string): T[] => gate(r, g).filter((f) => f.severity !== 'info');

/** A Verhoeff-valid, Aadhaar-shaped 12-digit number built for tests only. */
export const FAKE_AADHAAR = (() => { const p = '23456789012'; return `${p}${verhoeffCheckDigit(p)}`; })();

export { IDS, T0, seedId };
export type { Json };
