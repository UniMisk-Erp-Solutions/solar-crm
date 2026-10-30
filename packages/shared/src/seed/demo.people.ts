import type { AppRole } from '../enums';
import type { Dealer, Distributor, DistributorScoreHistory, Profile, SopCase, Territory, UserTerritory, VendorRegistration } from '../rows';
import { DEMO_IDS } from './demo.ids';
import { baseOf, demoId, fakeMobile, DAY, type SeedEnv } from './util';

const I = DEMO_IDS;
const P = DEMO_IDS.profile;
const DOMAIN = 'demo.futuresolar.local';

/** Format-valid but fictional PAN / GSTIN (prefix "DM…" cannot be a real entity code pattern in practice; the digits are sequential). */
export const fakePan = (prefix5: string, n: number, letter: string): string => `${prefix5}${String(n).padStart(4, '0')}${letter}`;
export const fakeGstin = (pan: string): string => `24${pan}1Z5`;

/* ───────────────────────── profiles ───────────────────────── */

interface ProfileSeed { id: string; name: string; email: string; role: AppRole; designation: string; reports_to: string | null; territories: string[]; language: Profile['language']; distributor_id?: string; dealer_id?: string }

const PROFILE_SEEDS: ProfileSeed[] = [
  { id: P.admin, name: 'Demo Admin', email: `admin@${DOMAIN}`, role: 'admin', designation: 'System administrator', reports_to: null, territories: [], language: 'en' },
  { id: P.management, name: 'Demo Management', email: `management@${DOMAIN}`, role: 'management', designation: 'Director — Sales', reports_to: null, territories: [], language: 'en' },
  { id: P.regional_head, name: 'Demo Regional Head', email: `regional.head@${DOMAIN}`, role: 'regional_head', designation: 'Regional Head — Gujarat', reports_to: P.management, territories: [], language: 'en' },
  { id: P.sales_manager, name: 'Demo Sales Manager', email: `sales.manager@${DOMAIN}`, role: 'sales_manager', designation: 'Sales Manager — Gujarat', reports_to: P.regional_head, territories: [], language: 'hi' },
  { id: P.dsm, name: 'Demo DSM West', email: `dsm.west@${DOMAIN}`, role: 'dsm', designation: 'District Sales Manager — Ahmedabad and Gandhinagar', reports_to: P.sales_manager, territories: [I.territory.ahmedabad, I.territory.gandhinagar], language: 'gu' },
  { id: P.dsm2, name: 'Demo DSM South', email: `dsm.south@${DOMAIN}`, role: 'dsm', designation: 'District Sales Manager — Surat, Vadodara and Rajkot', reports_to: P.sales_manager, territories: [I.territory.surat, I.territory.vadodara, I.territory.rajkot], language: 'gu' },
  { id: P.techno_commercial, name: 'Demo Techno-Commercial', email: `technocommercial@${DOMAIN}`, role: 'techno_commercial', designation: 'Techno-commercial engineer', reports_to: P.sales_manager, territories: [], language: 'en' },
  { id: P.accounts, name: 'Demo Accounts', email: `accounts@${DOMAIN}`, role: 'accounts', designation: 'Accounts and credit control', reports_to: P.management, territories: [], language: 'en' },
  { id: P.compliance_officer, name: 'Demo Compliance Officer', email: `compliance@${DOMAIN}`, role: 'compliance_officer', designation: 'Compliance officer', reports_to: P.management, territories: [], language: 'en' },
  { id: P.dispatch, name: 'Demo Dispatch', email: `dispatch@${DOMAIN}`, role: 'dispatch', designation: 'Dispatch planner', reports_to: P.sales_manager, territories: [], language: 'gu' },
  { id: P.viewer, name: 'Demo Viewer', email: `viewer@${DOMAIN}`, role: 'viewer', designation: 'Read-only observer', reports_to: null, territories: [], language: 'en' },
  { id: P.distributor_user, name: 'Demo Sunrise Distribution User', email: `sunrise.ops@${DOMAIN}`, role: 'distributor_user', designation: 'Sales coordinator', reports_to: P.dsm, territories: [I.territory.ahmedabad, I.territory.gandhinagar], language: 'gu', distributor_id: I.distributor.sunrise },
  { id: P.distributor_user_b, name: 'Demo Suryamitra Distribution User', email: `suryamitra.ops@${DOMAIN}`, role: 'distributor_user', designation: 'Sales coordinator', reports_to: P.dsm2, territories: [I.territory.surat], language: 'gu', distributor_id: I.distributor.suryamitra },
  { id: P.distributor_user_c, name: 'Demo Saurashtra Distribution User', email: `saurashtra.ops@${DOMAIN}`, role: 'distributor_user', designation: 'Sales coordinator', reports_to: P.dsm2, territories: [I.territory.rajkot], language: 'hi', distributor_id: I.distributor.saurashtra },
  { id: P.dealer_user, name: 'Demo Dealer 1 User', email: `dealer1@${DOMAIN}`, role: 'dealer_user', designation: 'Installer partner', reports_to: null, territories: [I.territory.ahmedabad], language: 'gu', dealer_id: I.dealer.d1 },
  { id: P.dealer_user_2, name: 'Demo Dealer 2 User', email: `dealer2@${DOMAIN}`, role: 'dealer_user', designation: 'Installer partner', reports_to: null, territories: [I.territory.ahmedabad], language: 'gu', dealer_id: I.dealer.d2 },
  { id: P.dealer_user_3, name: 'Demo Dealer 3 User', email: `dealer3@${DOMAIN}`, role: 'dealer_user', designation: 'Installer partner', reports_to: null, territories: [I.territory.gandhinagar], language: 'gu', dealer_id: I.dealer.d3 },
];

export function buildProfiles(env: SeedEnv): Profile[] {
  return PROFILE_SEEDS.map((p, i) => ({
    id: p.id, org_id: env.org, full_name: p.name, email: p.email, phone: fakeMobile(900 + i), role: p.role, designation: p.designation,
    distributor_id: p.distributor_id ?? null, dealer_id: p.dealer_id ?? null, territory_ids: [...p.territories], reports_to: p.reports_to, language: p.language, active: true,
    created_at: env.t(-60 * DAY), updated_at: env.t(-30 * DAY), created_by: null,
  }));
}

/* ───────────────────────── territories ───────────────────────── */

export function buildTerritories(env: SeedEnv, withDsm = true): Territory[] {
  const mk = (id: string, name: string, district: string, ranges: [string, string][], discom: string, dsm: string): Territory => ({
    ...baseOf(env, id, 60 * DAY), name, state: 'Gujarat', district, pincode_ranges: ranges.map(([from, to]) => ({ from, to })), discom_id: discom, dsm_id: withDsm ? dsm : null, active: true,
  });
  return [
    mk(I.territory.ahmedabad, 'Ahmedabad', 'Ahmedabad', [['380001', '380063']], I.discom.torrent, P.dsm),
    mk(I.territory.gandhinagar, 'Gandhinagar', 'Gandhinagar', [['382006', '382030']], I.discom.ugvcl, P.dsm),
    mk(I.territory.surat, 'Surat', 'Surat', [['395001', '395023'], ['394210', '394210']], I.discom.dgvcl, P.dsm2),
    mk(I.territory.vadodara, 'Vadodara', 'Vadodara', [['390001', '390025']], I.discom.mgvcl, P.dsm2),
    mk(I.territory.rajkot, 'Rajkot', 'Rajkot', [['360001', '360007']], I.discom.pgvcl, P.dsm2),
  ];
}

export function buildUserTerritories(env: SeedEnv): UserTerritory[] {
  const rows: UserTerritory[] = [];
  PROFILE_SEEDS.forEach((p) => {
    p.territories.forEach((territory_id) => {
      rows.push({ ...baseOf(env, demoId('user-territory', rows.length + 1), 60 * DAY), user_id: p.id, territory_id });
    });
  });
  return rows;
}

/* ───────────────────────── distributors ───────────────────────── */

export function buildDistributors(env: SeedEnv): Distributor[] {
  const mk = (id: string, n: number, legal: string, trade: string, panPrefix: string, city: string, territories: string[], band: [number, number], tags: string[], score: number, creditDays: number, creditLimit: number): Distributor => {
    const pan = fakePan(panPrefix, n, String.fromCharCode(64 + n));
    return {
      ...baseOf(env, id, 120 * DAY), legal_name: legal, trade_name: trade, gstin: fakeGstin(pan), pan, contact_name: `Demo Contact ${trade}`, phone: fakeMobile(100 + n), email: `contact@${trade.toLowerCase().replace(/[^a-z]+/g, '')}.${DOMAIN}`,
      address: { line1: `${10 + n}, Demo Industrial Estate`, city, district: city, state: 'Gujarat', pincode: n === 1 ? '380015' : n === 2 ? '395006' : '360002' },
      state: 'Gujarat', city, territory_ids: territories, capacity_band_min_kw: band[0], capacity_band_max_kw: band[1], capability_tags: tags, score,
      status: 'active', credit_days: creditDays, credit_limit: creditLimit, rebate_slab_key: null,
    };
  };
  return [
    mk(I.distributor.sunrise, 1, 'Sunrise Solar Distribution Pvt. Ltd. (Demo)', 'Sunrise Solar', 'DMSUN', 'Ahmedabad', [I.territory.ahmedabad, I.territory.gandhinagar], [1, 150], ['residential', 'rwa', 'pmsg', 'rooftop', 'small_commercial'], 84, 30, 25_000_000),
    mk(I.distributor.suryamitra, 2, 'Suryamitra Energy Distribution Pvt. Ltd. (Demo)', 'Suryamitra Energy', 'DMSUR', 'Surat', [I.territory.surat], [5, 1000], ['commercial', 'industrial', 'net_metering', 'open_access', 'captive', 'rwa'], 71, 45, 15_000_000),
    mk(I.distributor.saurashtra, 3, 'Saurashtra Kiran Distributors LLP (Demo)', 'Saurashtra Kiran', 'DMSAU', 'Rajkot', [I.territory.rajkot], [1, 500], ['residential', 'kusum', 'government', 'rooftop', 'commercial'], 58, 21, 7_500_000),
  ];
}

export function buildScoreHistory(env: SeedEnv): DistributorScoreHistory[] {
  const rows: DistributorScoreHistory[] = [];
  const comp = (accept: number, response: number, capacity: number, compliance: number): DistributorScoreHistory['components'] => ({ acceptance_rate: accept, response_time: response, capacity_fit: capacity, compliance_record: compliance });
  const series: [string, number, number, ReturnType<typeof comp>, ReturnType<typeof comp>][] = [
    [I.distributor.sunrise, 80, 84, comp(0.9, 0.82, 0.8, 0.85), comp(0.93, 0.86, 0.8, 0.88)],
    [I.distributor.suryamitra, 74, 71, comp(0.8, 0.7, 0.9, 0.62), comp(0.76, 0.68, 0.9, 0.6)],
    [I.distributor.saurashtra, 52, 58, comp(0.6, 0.55, 0.7, 0.5), comp(0.66, 0.6, 0.7, 0.55)],
  ];
  series.forEach(([distributor_id, s0, s1, c0, c1]) => {
    rows.push({ id: demoId('score-history', rows.length + 1), org_id: env.org, created_at: env.t(-30 * DAY), distributor_id, score: s0, components: c0, computed_at: env.t(-30 * DAY) });
    rows.push({ id: demoId('score-history', rows.length + 1), org_id: env.org, created_at: env.t(-DAY), distributor_id, score: s1, components: c1, computed_at: env.t(-DAY) });
  });
  return rows;
}

/* ───────────────────────── dealers ───────────────────────── */

interface DealerSeed {
  id: string; n: number; legal: string; trade: string; distributor: string; territory: string; city: string; district: string;
  limit: number; security: Dealer['security_type']; securityAmount: number; status: Dealer['status']; portal: Dealer['portal_status']; complaints: number; rebate: number;
  level: VendorRegistration['level']; states: string[]; districts: string[]; bgAmount: number; bgDays: number;
}

const DEALER_SEEDS: DealerSeed[] = [
  { id: I.dealer.d1, n: 1, legal: 'Anand Rooftop Solutions (Demo)', trade: 'Anand Rooftop', distributor: I.distributor.sunrise, territory: I.territory.ahmedabad, city: 'Ahmedabad', district: 'Ahmedabad', limit: 2_000_000, security: 'pdc', securityAmount: 500_000, status: 'active', portal: 'active', complaints: 0, rebate: 0, level: 'state', states: ['Gujarat'], districts: ['Ahmedabad'], bgAmount: 250_000, bgDays: 300 },
  { id: I.dealer.d2, n: 2, legal: 'Bharat Sun Systems (Demo)', trade: 'Bharat Sun', distributor: I.distributor.sunrise, territory: I.territory.ahmedabad, city: 'Ahmedabad', district: 'Ahmedabad', limit: 3_000_000, security: 'cheque', securityAmount: 750_000, status: 'active', portal: 'active', complaints: 0, rebate: 42_000, level: 'state', states: ['Gujarat'], districts: ['Ahmedabad', 'Gandhinagar'], bgAmount: 250_000, bgDays: 600 },
  { id: I.dealer.d3, n: 3, legal: 'Gandhinagar Green Power (Demo)', trade: 'Gandhinagar Green', distributor: I.distributor.sunrise, territory: I.territory.gandhinagar, city: 'Gandhinagar', district: 'Gandhinagar', limit: 1_500_000, security: 'bank_guarantee', securityAmount: 250_000, status: 'active', portal: 'active', complaints: 1, rebate: 0, level: 'state', states: ['Gujarat'], districts: ['Gandhinagar'], bgAmount: 250_000, bgDays: 40 },
  { id: I.dealer.d4, n: 4, legal: 'Tapi Solar Installers (Demo)', trade: 'Tapi Solar', distributor: I.distributor.suryamitra, territory: I.territory.surat, city: 'Surat', district: 'Surat', limit: 2_500_000, security: 'pdc', securityAmount: 600_000, status: 'active', portal: 'under_sop', complaints: 3, rebate: 0, level: 'state', states: ['Gujarat'], districts: ['Surat'], bgAmount: 250_000, bgDays: 200 },
  { id: I.dealer.d5, n: 5, legal: 'Surat Surya Works (Demo)', trade: 'Surat Surya', distributor: I.distributor.suryamitra, territory: I.territory.surat, city: 'Surat', district: 'Surat', limit: 1_000_000, security: 'cheque', securityAmount: 200_000, status: 'on_hold', portal: 'deactivated', complaints: 5, rebate: 0, level: 'state', states: ['Gujarat'], districts: ['Surat'], bgAmount: 250_000, bgDays: 250 },
  { id: I.dealer.d6, n: 6, legal: 'Rajkot Urja Services (Demo)', trade: 'Rajkot Urja', distributor: I.distributor.saurashtra, territory: I.territory.rajkot, city: 'Rajkot', district: 'Rajkot', limit: 1_800_000, security: 'pdc', securityAmount: 400_000, status: 'active', portal: 'active', complaints: 0, rebate: 15_000, level: 'state', states: ['Gujarat'], districts: ['Rajkot', 'Jamnagar'], bgAmount: 250_000, bgDays: 400 },
  { id: I.dealer.d7, n: 7, legal: 'Saurashtra Panel House (Demo)', trade: 'Saurashtra Panel', distributor: I.distributor.saurashtra, territory: I.territory.rajkot, city: 'Rajkot', district: 'Rajkot', limit: 2_200_000, security: 'bank_guarantee', securityAmount: 500_000, status: 'active', portal: 'active', complaints: 0, rebate: 0, level: 'multi_state', states: ['Gujarat', 'Maharashtra'], districts: ['Rajkot', 'Bhavnagar'], bgAmount: 500_000, bgDays: 700 },
  { id: I.dealer.d8, n: 8, legal: 'Hazira Industrial Solar (Demo)', trade: 'Hazira Industrial', distributor: I.distributor.suryamitra, territory: I.territory.surat, city: 'Surat', district: 'Surat', limit: 5_000_000, security: 'bank_guarantee', securityAmount: 1_000_000, status: 'active', portal: 'active', complaints: 0, rebate: 0, level: 'state', states: ['Gujarat'], districts: ['Surat'], bgAmount: 250_000, bgDays: 500 },
];

export function buildDealers(env: SeedEnv): Dealer[] {
  return DEALER_SEEDS.map((d) => {
    const pan = fakePan('DMDLR', d.n, String.fromCharCode(68 + (d.n % 8)));
    return {
      ...baseOf(env, d.id, 90 * DAY), distributor_id: d.distributor, legal_name: d.legal, trade_name: d.trade, gstin: fakeGstin(pan), pan, contact_name: `Demo Contact ${d.trade}`,
      phone: fakeMobile(200 + d.n), email: `contact@${d.trade.toLowerCase().replace(/[^a-z]+/g, '')}.${DOMAIN}`, territory_id: d.territory, city: d.city, district: d.district, state: 'Gujarat',
      credit_limit: d.limit, security_type: d.security, security_amount: d.securityAmount, status: d.status, portal_status: d.portal, complaint_count: d.complaints, rebate_accrued: d.rebate,
    };
  });
}

/** Vendor registrations: one per distributor and per dealer. Ids: distributors 1–3, dealers 11–18. */
export const VENDOR_REG_IDS = {
  sunrise: demoId('vendor-reg', 1), suryamitra: demoId('vendor-reg', 2), saurashtra: demoId('vendor-reg', 3),
  d1: demoId('vendor-reg', 11), d2: demoId('vendor-reg', 12), d3: demoId('vendor-reg', 13), d4: demoId('vendor-reg', 14),
  d5: demoId('vendor-reg', 15), d6: demoId('vendor-reg', 16), d7: demoId('vendor-reg', 17), d8: demoId('vendor-reg', 18),
} as const;

export function buildVendorRegistrations(env: SeedEnv): VendorRegistration[] {
  const rows: VendorRegistration[] = [];
  const distributors: [string, string, VendorRegistration['level'], string[], string[], number, number][] = [
    [VENDOR_REG_IDS.sunrise, I.distributor.sunrise, 'multi_state', ['Gujarat', 'Rajasthan'], ['Ahmedabad', 'Gandhinagar'], 500_000, 900],
    [VENDOR_REG_IDS.suryamitra, I.distributor.suryamitra, 'national', ['Gujarat', 'Maharashtra', 'Madhya Pradesh'], ['Surat', 'Vadodara'], 2_500_000, 1400],
    [VENDOR_REG_IDS.saurashtra, I.distributor.saurashtra, 'state', ['Gujarat'], ['Rajkot', 'Jamnagar', 'Bhavnagar'], 250_000, 500],
  ];
  distributors.forEach(([id, party, level, states, districts, bg, days], i) => {
    rows.push({
      ...baseOf(env, id, 120 * DAY), party_type: 'distributor', party_id: party, level, portal_vendor_id: `DEMO-VND-D${i + 1}`, states, districts, bank_guarantee_amount: bg,
      bank_guarantee_valid_till: env.d(days), portal_status: 'active', deactivated_from: null, deactivated_to: null, complaint_count: 0,
      notes: 'Demo registration. Guarantee amounts follow the reported PMSG vendor norms (₹25 lakh national; ₹2.5 lakh per state); the state-level amount is not confirmed.',
    });
  });
  const regIds = [VENDOR_REG_IDS.d1, VENDOR_REG_IDS.d2, VENDOR_REG_IDS.d3, VENDOR_REG_IDS.d4, VENDOR_REG_IDS.d5, VENDOR_REG_IDS.d6, VENDOR_REG_IDS.d7, VENDOR_REG_IDS.d8];
  DEALER_SEEDS.forEach((d, i) => {
    const deactivated = d.portal === 'deactivated';
    rows.push({
      ...baseOf(env, regIds[i]!, 90 * DAY), party_type: 'dealer', party_id: d.id, level: d.level, portal_vendor_id: `DEMO-VND-R${d.n}`, states: d.states, districts: d.districts,
      bank_guarantee_amount: d.bgAmount, bank_guarantee_valid_till: env.d(d.bgDays), portal_status: d.portal,
      deactivated_from: deactivated ? env.d(-12) : null, deactivated_to: deactivated ? env.d(18) : null, complaint_count: d.complaints,
      notes: d.n === 3 ? 'Bank guarantee expires in 40 days — renewal reminder due.' : d.n === 4 ? 'Under MNRE SOP review (complaint DEMO-SOP-2026-014).' : deactivated ? 'Deactivated on the portal for one month under the MNRE SOP; appeal window open.' : null,
    });
  });
  return rows;
}

export function buildSopCases(env: SeedEnv): SopCase[] {
  return [
    {
      ...baseOf(env, demoId('sop-case', 1), 12 * DAY), dealer_id: I.dealer.d4, vendor_registration_id: VENDOR_REG_IDS.d4, complaint_ref: 'DEMO-SOP-2026-014',
      summary: 'Consumer complaint: structure fitted before DISCOM approval and no installation photos uploaded.', notice_at: env.t(-12 * DAY), stage: 'reminder',
      reply_due_at: env.t(-4 * DAY), replied_at: null, reminder_at: env.t(-3 * DAY), show_cause_at: null, show_cause_due_at: null, deactivated_at: null, appeal_due_at: null, closed_at: null, outcome: null,
    },
    {
      ...baseOf(env, demoId('sop-case', 2), 45 * DAY), dealer_id: I.dealer.d5, vendor_registration_id: VENDOR_REG_IDS.d5, complaint_ref: 'DEMO-SOP-2026-009',
      summary: 'Repeated consumer complaints: system not commissioned 90 days after payment; no reply to the notice.', notice_at: env.t(-45 * DAY), stage: 'deactivation',
      reply_due_at: env.t(-37 * DAY), replied_at: null, reminder_at: env.t(-30 * DAY), show_cause_at: env.t(-30 * DAY), show_cause_due_at: env.t(-15 * DAY), deactivated_at: env.t(-12 * DAY),
      appeal_due_at: env.t(18 * DAY), closed_at: null, outcome: 'Portal deactivation for one month; appeal window open.',
    },
  ];
}
