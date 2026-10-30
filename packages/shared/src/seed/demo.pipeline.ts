import type { OpportunityStage, SchemeRoute } from '../enums';
import type { FundingMix, NegotiationLog, Opportunity, RequirementForm, Site } from '../rows';
import { DEMO_IDS } from './demo.ids';
import { customerIdOf, OPP_OF_LEAD, siteIdOf } from './demo.leads';
import { specOf, type LeadKey } from './demo.leads.data';
import { baseOf, demoId, earlierOf, laterOf, round2, DAY, type SeedEnv } from './util';

const I = DEMO_IDS;
const P = DEMO_IDS.profile;

/** Which GERC regulation version applies from a commissioning date (labels come from the gerc.regulation_versions rule). */
export const regulationVersionFor = (commissioningDate: string | null): string | null => {
  if (!commissioningDate) return null;
  return commissioningDate >= '2025-11-04'
    ? 'GERC Net Metering Rooftop Regulations 2016 — Fifth Amendment (effective 4-Nov-2025)'
    : 'GERC Net Metering Rooftop Regulations 2016, as amended before the Fifth Amendment';
};

const ROUTE: Record<string, SchemeRoute> = { pmsg_residential: 'pmsg', rwa_ghs: 'rwa_ghs', ci_captive: 'captive', ci_net_metered: 'net_metering', open_access: 'open_access', pm_kusum: 'kusum', government_bid: 'government_bid' };

interface OppSpec {
  lead: LeadKey; stage: OpportunityStage; probability: number; perKw: number; closeInDays: number; commissioning: (env: SeedEnv) => string; exemption: boolean;
  competitor: string | null; funding: FundingMix; aged: number;
}

const pmsgFunding: FundingMix = { consumer_pct: 59, loan_pct: 0, subsidy_pct: 41 };
const afterExemption = (env: SeedEnv): string => laterOf('2027-02-15', env.d(110));
const beforeExemption = (env: SeedEnv): string => earlierOf(env.d(35), '2026-12-15');

const OPP_SPECS: OppSpec[] = [
  { lead: 'oppPmsg', stage: 'quotation', probability: 70, perKw: 63000, closeInDays: 10, commissioning: (e) => e.d(45), exemption: false, competitor: null, funding: pmsgFunding, aged: 12 },
  { lead: 'oppPmsgOverLimit', stage: 'quotation', probability: 55, perKw: 62000, closeInDays: 14, commissioning: (e) => e.d(45), exemption: false, competitor: 'Local installer', funding: { consumer_pct: 20, loan_pct: 39, subsidy_pct: 41, loan_rate_pct: 5.75, loan_rate_source_date: '2026-08-04', bank: 'Demo Cooperative Bank' }, aged: 9 },
  { lead: 'oppRwa', stage: 'quotation', probability: 60, perKw: 52000, closeInDays: 20, commissioning: (e) => e.d(60), exemption: false, competitor: null, funding: { consumer_pct: 67, loan_pct: 0, subsidy_pct: 33 }, aged: 18 },
  { lead: 'oppNetMetered', stage: 'negotiation', probability: 75, perKw: 41000, closeInDays: 12, commissioning: beforeExemption, exemption: true, competitor: 'Regional EPC', funding: { consumer_pct: 100, loan_pct: 0, subsidy_pct: 0 }, aged: 23 },
  { lead: 'oppOpenAccess', stage: 'quotation', probability: 45, perKw: 40000, closeInDays: 25, commissioning: afterExemption, exemption: true, competitor: 'National EPC', funding: { consumer_pct: 100, loan_pct: 0, subsidy_pct: 0 }, aged: 28 },
  { lead: 'oppKusum', stage: 'quotation', probability: 50, perKw: 45000, closeInDays: 18, commissioning: (e) => e.d(60), exemption: false, competitor: null, funding: { consumer_pct: 40, loan_pct: 0, subsidy_pct: 60 }, aged: 16 },
  { lead: 'oppCaptiveDnd', stage: 'quotation', probability: 50, perKw: 43000, closeInDays: 21, commissioning: (e) => e.d(60), exemption: false, competitor: null, funding: { consumer_pct: 100, loan_pct: 0, subsidy_pct: 0 }, aged: 14 },
  { lead: 'oppGovernment', stage: 'negotiation', probability: 65, perKw: 42000, closeInDays: 30, commissioning: (e) => e.d(90), exemption: false, competitor: 'Two other bidders', funding: { consumer_pct: 100, loan_pct: 0, subsidy_pct: 0 }, aged: 33 },
  { lead: 'won1', stage: 'won', probability: 100, perKw: 63000, closeInDays: -62, commissioning: (e) => e.d(-35), exemption: false, competitor: null, funding: pmsgFunding, aged: 66 },
  { lead: 'won2', stage: 'won', probability: 100, perKw: 63000, closeInDays: -70, commissioning: (e) => e.d(-30), exemption: false, competitor: null, funding: { consumer_pct: 20, loan_pct: 39, subsidy_pct: 41, loan_rate_pct: 5.75, loan_rate_source_date: '2026-08-04', bank: 'Demo Cooperative Bank' }, aged: 75 },
  { lead: 'won3', stage: 'won', probability: 100, perKw: 66000, closeInDays: -78, commissioning: (e) => e.d(-40), exemption: false, competitor: null, funding: pmsgFunding, aged: 80 },
  { lead: 'won4', stage: 'won', probability: 100, perKw: 47000, closeInDays: -68, commissioning: (e) => e.d(20), exemption: false, competitor: null, funding: { consumer_pct: 67, loan_pct: 0, subsidy_pct: 33 }, aged: 70 },
  { lead: 'won5', stage: 'won', probability: 100, perKw: 63000, closeInDays: -43, commissioning: (e) => e.d(30), exemption: false, competitor: null, funding: pmsgFunding, aged: 45 },
];

export function buildOpportunities(env: SeedEnv): Opportunity[] {
  return OPP_SPECS.map((o) => {
    const s = specOf(o.lead);
    const commissioning = o.commissioning(env);
    return {
      ...baseOf(env, OPP_OF_LEAD[o.lead]!, o.aged * DAY, s.owner), name: `${s.name.replace(' (Demo)', '')} — ${s.kw} kW`, lead_id: I.lead[o.lead], customer_id: customerIdOf(o.lead), site_id: siteIdOf(o.lead),
      segment: s.segment, kw: s.kw, scheme_route: ROUTE[s.segment]!, funding_mix: o.funding, probability: o.probability, expected_value: round2(s.kw * o.perKw),
      expected_close_date: env.d(o.closeInDays), expected_commissioning_date: commissioning, competitor: o.competitor, regulation_version: s.segment === 'pmsg_residential' || s.segment === 'ci_net_metered' ? regulationVersionFor(commissioning) : null,
      exemption_reliance: o.exemption, requirement_confirmed: true, timeline_confirmed: true, commercial_potential_confirmed: true, stage: o.stage, lost_reason: null,
      owner_id: s.segment === 'pmsg_residential' ? s.owner : P.techno_commercial, distributor_id: s.dist, dealer_id: s.dealer, territory_id: s.territory,
    };
  });
}

export function buildRequirementForms(env: SeedEnv, sites: Site[]): RequirementForm[] {
  return OPP_SPECS.map((o, i) => {
    const s = specOf(o.lead);
    const site = sites.find((x) => x.id === siteIdOf(o.lead))!;
    const data: RequirementForm['data'] = {
      consumer_no: site.consumer_no, discom: site.discom_id === I.discom.torrent ? 'Torrent Power' : site.discom_id === I.discom.ugvcl ? 'UGVCL' : site.discom_id === I.discom.dgvcl ? 'DGVCL' : site.discom_id === I.discom.mgvcl ? 'MGVCL' : 'PGVCL',
      sanctioned_load_kw: site.sanctioned_load_kw, contracted_demand_kva: site.contracted_demand_kva, phase: site.phase, name_on_bill: site.name_on_bill, name_match: site.name_match,
      roof_ownership: site.roof_ownership, title_ok: site.title_ok, pending_dues: site.pending_dues, existing_solar_kw: site.existing_solar_kw, category: site.category,
      special_category_state: site.special_category_state, roof_type: site.roof_type, load_type: site.load_type, specs: `${s.kw} kW as per the site survey; standard design`,
    };
    if (s.segment === 'rwa_ghs') Object.assign(data, { rwa_households: o.lead === 'won4' ? 14 : 25, rwa_registration_no: `DEMO-CHS-${String(i + 1).padStart(4, '0')}`, rwa_common_load_kw: s.kw * 0.8, rwa_ballot_record: 'ballot-record-demo.pdf' });
    if (s.segment === 'pm_kusum') Object.assign(data, { kusum_component: 'B', pump_hp: 7.5, sanction_date: '2025-12-12', land_ownership: 'family', survey_number: 'DEMO-SURVEY-118/2', water_source: 'borewell' });
    if (s.segment === 'ci_captive' || s.segment === 'ci_net_metered' || s.segment === 'open_access') Object.assign(data, { tariff_category: 'LTMD', entity_type: 'private_limited', behind_the_meter: s.segment === 'ci_captive' });
    if (s.segment === 'open_access') Object.assign(data, { voltage_level: '11 kV', wheeling_discom: 'DGVCL', banking_charge_assumption: null });
    if (s.segment === 'government_bid') Object.assign(data, { bid_reference: 'DEMO-TENDER-2026-041', bid_date: env.d(-40), tender_authority: 'District Health Society (Demo)', emd_amount: 150000, entity_type: 'state_government' });
    return {
      ...baseOf(env, demoId('requirement-form', i + 1), (o.aged - 2) * DAY, s.owner), lead_id: I.lead[o.lead], opportunity_id: OPP_OF_LEAD[o.lead]!, site_id: site.id, segment: s.segment, data,
      completed_at: env.t(-(o.aged - 3) * DAY), completed_by: P.techno_commercial,
    };
  });
}

export function buildNegotiationLogs(env: SeedEnv): NegotiationLog[] {
  const rows: NegotiationLog[] = [];
  const add = (lead: LeadKey, quoted: number, counter: number, notes: string, agoDays: number): void => {
    rows.push({
      ...baseOf(env, demoId('negotiation', rows.length + 1), agoDays * DAY, P.techno_commercial), lead_id: I.lead[lead], opportunity_id: OPP_OF_LEAD[lead] ?? null, quoted_rate_per_kw: quoted, customer_counter_per_kw: counter,
      notes, logged_by: P.techno_commercial, logged_at: env.t(-agoDays * DAY),
    });
  };
  add('oppPmsg', 63000, 60000, 'Customer compared two quotes and asked for ₹ 60,000 per kW.', 5);
  add('oppNetMetered', 41000, 38500, 'MD wants ₹ 38,500 per kW for a 120 kW plant and commissioning before 31 December.', 6);
  add('oppNetMetered', 40000, 39000, 'Second round: agreed to hold the price if the advance is 40 %.', 3);
  add('oppGovernment', 42000, 40500, 'Hospital procurement committee asked for ₹ 40,500 per kW.', 4);
  add('oppRwa', 52000, 49000, 'Society treasurer asked for a 6 % reduction.', 8);
  add('won1', 63000, 60500, 'Agreed at a 4 % discount.', 64);
  add('won2', 63000, 55400, 'Customer asked for 12 % off; settled at 6 % with a bank loan.', 74);
  add('oppOpenAccess', 40000, 37000, 'Plant head wants the price held until the exemption position is clear.', 9);
  return rows;
}

