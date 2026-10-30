import type { CustomerType, DndStatus, LeadSource, LeadStatus, Segment, Temperature, TimelineBucket } from '../enums';
import type { Lead } from '../rows';
import { DEMO_IDS } from './demo.ids';
import { DAY, HOUR } from './util';

const I = DEMO_IDS;
const P = DEMO_IDS.profile;

export type LeadKey = keyof typeof DEMO_IDS.lead;
export type Step = 'captured' | 'validated' | 'assigned' | 'accepted' | 'contacted' | 'qualified' | 'site_visit' | 'opportunity' | 'won';
/** standard = service + quotation + promotional on call/WhatsApp/SMS · service_only = no promotional purpose · none = no consent row · withdrawn = opted out 5 days ago */
export type ConsentKind = 'standard' | 'service_only' | 'none' | 'withdrawn';

export interface LeadSpec {
  key: LeadKey;
  name: string;
  email: string | null;
  source: LeadSource;
  segment: Segment;
  ctype: CustomerType;
  kw: number;
  pin: string;
  city: string;
  territory: string;
  status: LeadStatus;
  temp: Temperature | null;
  uplift?: boolean;
  dist: string | null;
  dealer: string | null;
  owner: string | null;
  /** minutes since the lead was captured */
  ageMin: number;
  /** explicit "minutes ago" for individual milestones */
  fixed?: Partial<Record<Step, number>>;
  timeline: TimelineBucket | null;
  budget: number | null;
  dm: Lead['decision_maker'];
  access: boolean | null;
  req: string | null;
  bill: boolean;
  lang: Lead['language'];
  consent: ConsentKind;
  dnd: DndStatus;
  dndAgeDays?: number;
  /** ownership lock held by a dealer */
  locked?: boolean;
  nurtureInDays?: number;
  nurtureReason?: string;
  lostReason?: string;
}

const CITY = {
  ahmedabad: { city: 'Ahmedabad', district: 'Ahmedabad' }, gandhinagar: { city: 'Gandhinagar', district: 'Gandhinagar' }, surat: { city: 'Surat', district: 'Surat' },
  vadodara: { city: 'Vadodara', district: 'Vadodara' }, rajkot: { city: 'Rajkot', district: 'Rajkot' },
} as const;
export type CityKey = keyof typeof CITY;
export const districtOf = (city: string): string => (Object.values(CITY).find((c) => c.city === city)?.district ?? city);

export const LEAD_SPECS: readonly LeadSpec[] = [
  /* ───────── the status ladder ───────── */
  { key: 'newNoConsent', name: 'Hiral Mehta', email: 'hiral.mehta@example.com', source: 'website', segment: 'pmsg_residential', ctype: 'residential', kw: 3, pin: '380015', city: 'Ahmedabad', territory: I.territory.ahmedabad, status: 'new', temp: null, dist: null, dealer: null, owner: null, ageMin: 20, timeline: null, budget: null, dm: null, access: null, req: 'Roof is RCC, around 3 kW needed for home use.', bill: false, lang: 'gu', consent: 'none', dnd: 'unchecked' },
  { key: 'unassignedVadodara', name: 'Vasant Industrial Works (Demo)', email: 'accounts@vasant-works.example.com', source: 'call_centre', segment: 'ci_net_metered', ctype: 'commercial', kw: 60, pin: '390007', city: 'Vadodara', territory: I.territory.vadodara, status: 'unassigned', temp: 'warm', dist: null, dealer: null, owner: P.dsm2, ageMin: 3 * HOUR, timeline: 'one_to_three_months', budget: 2_600_000, dm: 'committee', access: true, req: 'Factory roof 60 kW net metering; monthly electricity bill about ₹2.4 lakh.', bill: true, lang: 'en', consent: 'service_only', dnd: 'clear', dndAgeDays: 1 },
  { key: 'assignedRwa', name: 'Shreeji Residency CHS (Demo)', email: 'secretary@shreeji-chs.example.com', source: 'campaign', segment: 'rwa_ghs', ctype: 'housing_society', kw: 45, pin: '382010', city: 'Gandhinagar', territory: I.territory.gandhinagar, status: 'assigned', temp: 'warm', dist: I.distributor.sunrise, dealer: null, owner: P.distributor_user, ageMin: 1 * HOUR, fixed: { assigned: 45, validated: 52 }, timeline: 'one_to_three_months', budget: null, dm: 'committee', access: true, req: 'Society wants common-area solar for 36 households; AGM next month.', bill: false, lang: 'gu', consent: 'standard', dnd: 'clear', dndAgeDays: 1 },
  { key: 'assignedAboutToBreach', name: 'Jignesh Parmar', email: null, source: 'whatsapp', segment: 'pmsg_residential', ctype: 'residential', kw: 3, pin: '380009', city: 'Ahmedabad', territory: I.territory.ahmedabad, status: 'assigned', temp: 'hot', dist: I.distributor.sunrise, dealer: I.dealer.d2, owner: P.distributor_user, ageMin: 40, fixed: { validated: 30, assigned: 22 }, timeline: 'immediate', budget: 220_000, dm: 'self', access: true, req: 'Wants a 3 kW rooftop system this month under PM Surya Ghar.', bill: true, lang: 'gu', consent: 'standard', dnd: 'clear', dndAgeDays: 1 },
  { key: 'acceptedKusum', name: 'Ramesh Chavda', email: null, source: 'call_centre', segment: 'pm_kusum', ctype: 'farmer', kw: 5, pin: '360005', city: 'Rajkot', territory: I.territory.rajkot, status: 'accepted', temp: 'warm', dist: I.distributor.saurashtra, dealer: I.dealer.d6, owner: P.distributor_user_c, ageMin: 5 * HOUR, fixed: { validated: 290, assigned: 158, accepted: 40 }, timeline: 'one_to_three_months', budget: null, dm: 'self', access: true, req: 'Farmer needs a 5 HP solar pump; sanction letter dated December 2025.', bill: false, lang: 'gu', consent: 'standard', dnd: 'clear', dndAgeDays: 2 },
  { key: 'contactedOptedOut', name: 'Nirav Desai', email: 'nirav.desai@example.com', source: 'referral', segment: 'pmsg_residential', ctype: 'residential', kw: 3, pin: '395009', city: 'Surat', territory: I.territory.surat, status: 'contacted', temp: 'warm', dist: I.distributor.suryamitra, dealer: I.dealer.d8, owner: P.distributor_user_b, ageMin: 9 * DAY, fixed: { contacted: 6 * DAY }, timeline: 'one_to_three_months', budget: 160_000, dm: 'family', access: true, req: 'Interested in 3 kW; will decide after discussing with the family.', bill: true, lang: 'gu', consent: 'withdrawn', dnd: 'clear', dndAgeDays: 9 },
  { key: 'qualifiedOpenAccess', name: 'Kalpataru Textiles (Demo)', email: 'energy@kalpataru-textiles.example.com', source: 'website', segment: 'open_access', ctype: 'industrial', kw: 500, pin: '395006', city: 'Surat', territory: I.territory.surat, status: 'qualified', temp: 'hot', dist: I.distributor.suryamitra, dealer: null, owner: P.distributor_user_b, ageMin: 6 * DAY, timeline: 'within_30_days', budget: 21_000_000, dm: 'committee', access: true, req: 'Open-access solar for a textile unit; contracted demand 2,500 kVA; board approval expected within 30 days.', bill: true, lang: 'en', consent: 'standard', dnd: 'clear', dndAgeDays: 6 },
  { key: 'siteVisitFeasibility', name: 'Rudra Plastics (Demo)', email: 'works@rudra-plastics.example.com', source: 'campaign', segment: 'ci_net_metered', ctype: 'industrial', kw: 150, pin: '394210', city: 'Surat', territory: I.territory.surat, status: 'site_visit', temp: 'warm', dist: I.distributor.suryamitra, dealer: I.dealer.d8, owner: P.distributor_user_b, ageMin: 12 * DAY, timeline: 'one_to_three_months', budget: 6_500_000, dm: 'committee', access: true, req: 'Rooftop 150 kW net-metered; feasibility application with DGVCL is in progress.', bill: true, lang: 'en', consent: 'standard', dnd: 'clear', dndAgeDays: 12 },
  { key: 'nurture', name: 'Dhruv Shah', email: 'dhruv.shah@example.com', source: 'dealer_upload', segment: 'pmsg_residential', ctype: 'residential', kw: 3, pin: '382024', city: 'Gandhinagar', territory: I.territory.gandhinagar, status: 'nurture', temp: 'cold', dist: I.distributor.sunrise, dealer: I.dealer.d3, owner: P.distributor_user, ageMin: 40 * DAY, timeline: 'six_months_plus', budget: null, dm: 'family', access: false, req: 'Roof repair planned; revisit after the monsoon.', bill: false, lang: 'gu', consent: 'standard', dnd: 'clear', dndAgeDays: 45, locked: true, nurtureInDays: 120, nurtureReason: 'Roof repair planned; revisit after the monsoon.' },
  { key: 'lost', name: 'Municipal School Trust (Demo)', email: 'trustees@municipal-school.example.com', source: 'manual', segment: 'government_bid', ctype: 'government', kw: 80, pin: '360002', city: 'Rajkot', territory: I.territory.rajkot, status: 'lost', temp: 'cold', dist: I.distributor.saurashtra, dealer: null, owner: P.distributor_user_c, ageMin: 60 * DAY, timeline: 'three_to_six_months', budget: 3_800_000, dm: 'committee', access: true, req: 'School trust tender for an 80 kW rooftop plant.', bill: true, lang: 'en', consent: 'standard', dnd: 'clear', dndAgeDays: 20, lostReason: 'Tender awarded to another bidder at a lower rate.' },

  /* ───────── open pipeline: one opportunity family per gate scenario ───────── */
  { key: 'oppPmsg', name: 'Kavita Joshi', email: 'kavita.joshi@example.com', source: 'website', segment: 'pmsg_residential', ctype: 'residential', kw: 3, pin: '380013', city: 'Ahmedabad', territory: I.territory.ahmedabad, status: 'opportunity', temp: 'hot', uplift: true, dist: I.distributor.sunrise, dealer: I.dealer.d2, owner: P.distributor_user, ageMin: 14 * DAY, timeline: 'one_to_three_months', budget: 190_000, dm: 'self', access: true, req: 'Three-bedroom house, RCC roof, monthly bill about ₹3,800. Wants the CFA claimed before the legacy deadline.', bill: true, lang: 'gu', consent: 'standard', dnd: 'clear', dndAgeDays: 3 },
  { key: 'oppPmsgOverLimit', name: 'Sanjay Rathod', email: null, source: 'call_centre', segment: 'pmsg_residential', ctype: 'residential', kw: 3, pin: '380051', city: 'Ahmedabad', territory: I.territory.ahmedabad, status: 'opportunity', temp: 'warm', dist: I.distributor.sunrise, dealer: I.dealer.d1, owner: P.distributor_user, ageMin: 10 * DAY, timeline: 'one_to_three_months', budget: 180_000, dm: 'self', access: true, req: 'Bungalow with a south-facing terrace; wants a 3 kW system with subsidy.', bill: true, lang: 'gu', consent: 'standard', dnd: 'clear', dndAgeDays: 4 },
  { key: 'oppRwa', name: 'Sunrise Heights CHS (Demo)', email: 'chairman@sunrise-heights.example.com', source: 'campaign', segment: 'rwa_ghs', ctype: 'housing_society', kw: 60, pin: '380054', city: 'Ahmedabad', territory: I.territory.ahmedabad, status: 'opportunity', temp: 'warm', dist: I.distributor.sunrise, dealer: I.dealer.d2, owner: P.distributor_user, ageMin: 20 * DAY, timeline: 'one_to_three_months', budget: 3_200_000, dm: 'committee', access: true, req: 'Society of 25 households; common-area load about 40 kW; ballot held and passed.', bill: true, lang: 'en', consent: 'standard', dnd: 'clear', dndAgeDays: 5 },
  { key: 'oppNetMetered', name: 'Shah Engineering Works (Demo)', email: 'md@shah-engineering.example.com', source: 'referral', segment: 'ci_net_metered', ctype: 'industrial', kw: 120, pin: '395003', city: 'Surat', territory: I.territory.surat, status: 'opportunity', temp: 'hot', dist: I.distributor.suryamitra, dealer: I.dealer.d8, owner: P.distributor_user_b, ageMin: 25 * DAY, timeline: 'within_30_days', budget: 5_000_000, dm: 'self', access: true, req: 'Machine shop, 120 kW rooftop net metering, wants commissioning before 31 December 2026.', bill: true, lang: 'en', consent: 'standard', dnd: 'clear', dndAgeDays: 6 },
  { key: 'oppOpenAccess', name: 'Tapovan Chemicals (Demo)', email: 'procurement@tapovan-chemicals.example.com', source: 'website', segment: 'open_access', ctype: 'industrial', kw: 290, pin: '395007', city: 'Surat', territory: I.territory.surat, status: 'opportunity', temp: 'warm', dist: I.distributor.suryamitra, dealer: null, owner: P.distributor_user_b, ageMin: 30 * DAY, timeline: 'one_to_three_months', budget: 12_000_000, dm: 'committee', access: true, req: 'Open-access plant of about 300 kW; stock of non-List-II cells proposed; commissioning planned for February 2027.', bill: true, lang: 'en', consent: 'standard', dnd: 'clear', dndAgeDays: 7 },
  { key: 'oppKusum', name: 'Bhikhabhai Rabari', email: null, source: 'call_centre', segment: 'pm_kusum', ctype: 'farmer', kw: 10, pin: '360007', city: 'Rajkot', territory: I.territory.rajkot, status: 'opportunity', temp: 'warm', dist: I.distributor.saurashtra, dealer: I.dealer.d6, owner: P.distributor_user_c, ageMin: 18 * DAY, timeline: 'one_to_three_months', budget: 450_000, dm: 'family', access: true, req: 'Farm pump set 7.5 HP; electricity bill stands in the father\'s name.', bill: true, lang: 'gu', consent: 'standard', dnd: 'clear', dndAgeDays: 8 },
  { key: 'oppCaptiveDnd', name: 'Vraj Packaging (Demo)', email: 'owner@vraj-packaging.example.com', source: 'whatsapp', segment: 'ci_captive', ctype: 'commercial', kw: 90, pin: '360001', city: 'Rajkot', territory: I.territory.rajkot, status: 'opportunity', temp: 'warm', dist: I.distributor.saurashtra, dealer: I.dealer.d7, owner: P.distributor_user_c, ageMin: 16 * DAY, timeline: 'one_to_three_months', budget: 3_900_000, dm: 'self', access: true, req: 'Packaging unit, behind-the-meter captive plant of about 90 kW.', bill: true, lang: 'hi', consent: 'service_only', dnd: 'registered', dndAgeDays: 16 },
  { key: 'oppGovernment', name: 'District Hospital Rajkot (Demo)', email: 'superintendent@district-hospital.example.com', source: 'manual', segment: 'government_bid', ctype: 'government', kw: 250, pin: '360005', city: 'Rajkot', territory: I.territory.rajkot, status: 'opportunity', temp: 'warm', dist: I.distributor.saurashtra, dealer: null, owner: P.distributor_user_c, ageMin: 35 * DAY, timeline: 'one_to_three_months', budget: 10_500_000, dm: 'committee', access: true, req: 'Government hospital rooftop of 250 kW awarded to the lowest bidder; technical bid accepted.', bill: true, lang: 'en', consent: 'standard', dnd: 'clear', dndAgeDays: 10 },

  /* ───────── won: carry the order-to-cash chain ───────── */
  { key: 'won1', name: 'Meera Pandya', email: 'meera.pandya@example.com', source: 'website', segment: 'pmsg_residential', ctype: 'residential', kw: 3, pin: '380008', city: 'Ahmedabad', territory: I.territory.ahmedabad, status: 'won', temp: 'hot', dist: I.distributor.sunrise, dealer: I.dealer.d2, owner: P.distributor_user, ageMin: 70 * DAY, timeline: 'immediate', budget: 200_000, dm: 'self', access: true, req: 'Wants the 3 kW system installed before summer.', bill: true, lang: 'gu', consent: 'standard', dnd: 'clear', dndAgeDays: 15 },
  { key: 'won2', name: 'Harshad Solanki', email: 'harshad.solanki@example.com', source: 'referral', segment: 'pmsg_residential', ctype: 'residential', kw: 3, pin: '382016', city: 'Gandhinagar', territory: I.territory.gandhinagar, status: 'won', temp: 'hot', dist: I.distributor.sunrise, dealer: I.dealer.d3, owner: P.distributor_user, ageMin: 80 * DAY, timeline: 'within_30_days', budget: 195_000, dm: 'family', access: true, req: 'Referred by a neighbour; wants a 3 kW system with a bank loan.', bill: true, lang: 'gu', consent: 'standard', dnd: 'clear', dndAgeDays: 18 },
  { key: 'won3', name: 'Pooja Trivedi', email: 'pooja.trivedi@example.com', source: 'website', segment: 'pmsg_residential', ctype: 'residential', kw: 2.4, pin: '380004', city: 'Ahmedabad', territory: I.territory.ahmedabad, status: 'won', temp: 'warm', dist: I.distributor.sunrise, dealer: I.dealer.d2, owner: P.distributor_user, ageMin: 85 * DAY, timeline: 'one_to_three_months', budget: 150_000, dm: 'self', access: true, req: 'Small terrace; 2.4 kW is all the roof allows.', bill: true, lang: 'en', consent: 'standard', dnd: 'clear', dndAgeDays: 20 },
  { key: 'won4', name: 'Ganesh Park CHS (Demo)', email: 'committee@ganesh-park.example.com', source: 'campaign', segment: 'rwa_ghs', ctype: 'housing_society', kw: 40, pin: '395001', city: 'Surat', territory: I.territory.surat, status: 'won', temp: 'warm', dist: I.distributor.suryamitra, dealer: I.dealer.d8, owner: P.distributor_user_b, ageMin: 75 * DAY, timeline: 'one_to_three_months', budget: 2_300_000, dm: 'committee', access: true, req: 'Society of 14 households; common-area solar for lifts and pumps.', bill: true, lang: 'gu', consent: 'standard', dnd: 'clear', dndAgeDays: 22 },
  { key: 'won5', name: 'Lalji Gohil', email: null, source: 'call_centre', segment: 'pmsg_residential', ctype: 'residential', kw: 3, pin: '360004', city: 'Rajkot', territory: I.territory.rajkot, status: 'won', temp: 'warm', dist: I.distributor.saurashtra, dealer: I.dealer.d6, owner: P.distributor_user_c, ageMin: 50 * DAY, timeline: 'one_to_three_months', budget: 185_000, dm: 'self', access: true, req: 'Wants the 3 kW system; will pay the advance once the proforma invoice arrives.', bill: true, lang: 'gu', consent: 'standard', dnd: 'clear', dndAgeDays: 12 },
];

/** Leads that have a customer, site and survey: the site-visit lead, all open-pipeline leads and all won leads. */
export const SITE_LEAD_KEYS: readonly LeadKey[] = [
  'siteVisitFeasibility', 'oppPmsg', 'oppPmsgOverLimit', 'oppRwa', 'oppNetMetered', 'oppOpenAccess', 'oppKusum', 'oppCaptiveDnd', 'oppGovernment', 'won1', 'won2', 'won3', 'won4', 'won5',
];

export const leadIndex = (key: LeadKey): number => LEAD_SPECS.findIndex((s) => s.key === key) + 1;
export const specOf = (key: LeadKey): LeadSpec => {
  const s = LEAD_SPECS.find((x) => x.key === key);
  if (!s) throw new Error(`Unknown lead ${key}`);
  return s;
};
