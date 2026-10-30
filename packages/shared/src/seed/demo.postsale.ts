import type { LoanRejectionCode, LoanStatus } from '../enums';
import type { DiscomApplication, Installation, InventorySerial, Loan, SubsidyClaim, WarrantyTicket } from '../rows';
import { DEMO_IDS } from './demo.ids';
import { customerIdOf, hasSite, OPP_OF_LEAD, siteIdOf } from './demo.leads';
import { specOf, type LeadKey } from './demo.leads.data';
import { VENDOR_REG_IDS } from './demo.people';
import { regulationVersionFor } from './demo.pipeline';
import { baseOf, demoId, DAY, type SeedEnv } from './util';

const I = DEMO_IDS;
const P = DEMO_IDS.profile;

const CHECKLIST_FULL = { id_proof_masked: true, address_proof: true, bank_statements_6m: true, electricity_bill: true, quotation: true, land_or_title_record: true, co_applicant_form: true };

export function buildLoans(env: SeedEnv): Loan[] {
  const rows: Loan[] = [];
  const add = (lead: LeadKey, status: LoanStatus, o: { code?: LoanRejectionCode; amount: number | null; agoDays: number; notes: string; co?: string | null; checklist?: Record<string, boolean>; disbursed?: boolean }): void => {
    const s = specOf(lead);
    rows.push({
      ...baseOf(env, demoId('loan', rows.length + 1), o.agoDays * DAY, s.owner), opportunity_id: OPP_OF_LEAD[lead] ?? null, lead_id: I.lead[lead], customer_id: hasSite(lead) ? customerIdOf(lead) : null, dealer_id: s.dealer, distributor_id: s.dist, owner_id: s.owner,
      bank: 'Demo Cooperative Bank', application_date: env.d(-o.agoDays), status, rejection_code: o.code ?? null, amount: o.amount, rate_pct: o.amount === null ? null : 5.75, rate_source_date: o.amount === null ? null : '2026-08-04',
      co_applicant: o.co ?? null, document_checklist: o.checklist ?? CHECKLIST_FULL, disbursed_at: o.disbursed ? env.t(-(o.agoDays - 12) * DAY) : null, notes: o.notes,
    });
  };
  add('won2', 'disbursed', { amount: 60000, agoDays: 66, notes: 'Collateral-free loan disbursed to the dealer account against the proforma invoice.', disbursed: true });
  add('oppPmsg', 'applied', { amount: 120000, agoDays: 6, notes: 'Application filed; bank has not yet asked for documents.', checklist: { ...CHECKLIST_FULL, bank_statements_6m: false } });
  add('oppPmsgOverLimit', 'approved', { amount: 120000, agoDays: 18, notes: 'Sanctioned; awaiting the customer\'s acceptance of the quotation.', co: 'Spouse (co-applicant)' });
  add('oppKusum', 'rejected', { code: 'name_mismatch', amount: 200000, agoDays: 14, notes: 'Electricity bill and land record are in the father\'s name; the applicant is the son.', checklist: { ...CHECKLIST_FULL, land_or_title_record: false } });
  add('contactedOptedOut', 'rejected', { code: 'arrears', amount: 120000, agoDays: 8, notes: 'Pending electricity dues found at credit check.' });
  add('acceptedKusum', 'rejected', { code: 'land_title', amount: 180000, agoDays: 5, notes: 'Land record still stands in a deceased relative\'s name.', checklist: { ...CHECKLIST_FULL, land_or_title_record: false } });
  add('won5', 'rejected', { code: 'collateral_demanded', amount: 150000, agoDays: 40, notes: 'Branch asked for collateral on a loan under ₹ 2 lakh, against the scheme guidelines; customer chose to pay in cash.' });
  add('won3', 'rejected', { code: 'missing_documents', amount: 100000, agoDays: 70, notes: 'Bank statements and co-applicant form were missing.', checklist: { ...CHECKLIST_FULL, bank_statements_6m: false, co_applicant_form: false } });
  return rows;
}

interface InstallSeed { n: number; lead: LeadKey; so: string; dealer: string; dist: string; reg: string; kw: number; status: Installation['status']; installAgo: number; certAgo: number; commissionedAgo: number | null; installer: string }
const INSTALLS: InstallSeed[] = [
  { n: 1, lead: 'won1', so: I.salesOrder.so1, dealer: I.dealer.d2, dist: I.distributor.sunrise, reg: VENDOR_REG_IDS.d2, kw: 3, status: 'commissioned', installAgo: 38, certAgo: 36, commissionedAgo: 24, installer: 'Bharat Sun Systems crew 2' },
  { n: 2, lead: 'won2', so: I.salesOrder.so2, dealer: I.dealer.d3, dist: I.distributor.sunrise, reg: VENDOR_REG_IDS.d3, kw: 3, status: 'certified', installAgo: 32, certAgo: 25, commissionedAgo: null, installer: 'Gandhinagar Green crew 1' },
  { n: 3, lead: 'won3', so: I.salesOrder.so3, dealer: I.dealer.d2, dist: I.distributor.sunrise, reg: VENDOR_REG_IDS.d2, kw: 2.4, status: 'commissioned', installAgo: 40, certAgo: 38, commissionedAgo: 28, installer: 'Bharat Sun Systems crew 1' },
];
const INSTALL_IDS = [I.installation.inst1, I.installation.inst2, I.installation.inst3];

export function buildInstallations(env: SeedEnv): Installation[] {
  return INSTALLS.map((x, i) => {
    const site = siteIdOf(x.lead);
    const geo = { lat: 23.03 + i * 0.01, lng: 72.57 + i * 0.01 };
    const installDate = env.d(-x.installAgo);
    return {
      ...baseOf(env, INSTALL_IDS[i]!, x.installAgo * DAY, P.dispatch), sales_order_id: x.so, site_id: site, customer_id: customerIdOf(x.lead), dealer_id: x.dealer, distributor_id: x.dist, vendor_registration_id: x.reg, installer_name: x.installer,
      status: x.status, install_date: installDate, certificate_at: env.t(-x.certAgo * DAY), photos: [
        { path: `demo/install/${x.n}/array.jpg`, lat: geo.lat, lng: geo.lng, taken_at: env.t(-x.installAgo * DAY) },
        { path: `demo/install/${x.n}/inverter.jpg`, lat: geo.lat, lng: geo.lng, taken_at: env.t(-x.installAgo * DAY) },
      ],
      agreement_status: 'not_required', regulation_version: regulationVersionFor(env.d(-(x.commissionedAgo ?? x.certAgo))), no_connectivity_agreement: true,
      commissioned_at: x.commissionedAgo === null ? null : env.t(-x.commissionedAgo * DAY), warranty_end: env.d(-x.installAgo + 12 * 365), om_end: env.d(-x.installAgo + 5 * 365), kw: x.kw,
    };
  });
}

export function buildDiscomApplications(env: SeedEnv): DiscomApplication[] {
  const rows: DiscomApplication[] = [];
  const discomOf = (lead: LeadKey): string | null => (specOf(lead).territory === I.territory.gandhinagar ? I.discom.ugvcl : I.discom.torrent);
  INSTALLS.forEach((x, i) => {
    const submittedAgo = x.installAgo + 20;
    const certAgo = x.certAgo;
    const dueAgo = certAgo - 15; // commissioning due 15 days after the installation certificate
    const breached = x.commissionedAgo === null;
    rows.push({
      ...baseOf(env, demoId('discom-application', i + 1), submittedAgo * DAY, P.dispatch), sales_order_id: x.so, installation_id: INSTALL_IDS[i]!, site_id: siteIdOf(x.lead), customer_id: customerIdOf(x.lead), discom_id: discomOf(x.lead), dealer_id: x.dealer, distributor_id: x.dist,
      application_no: `DEMO-APP-${String(x.n).padStart(5, '0')}`, applied_kw: x.kw, submitted_at: env.t(-submittedAgo * DAY), complete_at: env.t(-(submittedAgo - 1) * DAY), feasibility_due_at: null, feasibility_status: 'not_required',
      inspection_at: env.t(-(certAgo + 2) * DAY), meter_type: 'bidirectional', meter_at: breached ? null : env.t(-(x.commissionedAgo ?? 0) * DAY - 3 * DAY), certificate_submitted_at: env.t(-certAgo * DAY), commissioning_due_at: env.t(-dueAgo * DAY),
      commissioning_at: breached ? null : env.t(-(x.commissionedAgo ?? 0) * DAY), agreement_status: 'not_required', regulation_version: regulationVersionFor(env.d(-(x.commissionedAgo ?? certAgo))), deemed_breach: breached,
    });
  });
  // RWA project 4 (> 10 kW): feasibility approved, installation not started
  rows.push({
    ...baseOf(env, demoId('discom-application', 4), 60 * DAY, P.dispatch), sales_order_id: I.salesOrder.so4, installation_id: null, site_id: siteIdOf('won4'), customer_id: customerIdOf('won4'), discom_id: I.discom.dgvcl, dealer_id: I.dealer.d8, distributor_id: I.distributor.suryamitra,
    application_no: 'DEMO-APP-00004', applied_kw: 40.2, submitted_at: env.t(-70 * DAY), complete_at: env.t(-69 * DAY), feasibility_due_at: env.t(-54 * DAY), feasibility_status: 'approved', inspection_at: null, meter_type: null, meter_at: null,
    certificate_submitted_at: null, commissioning_due_at: null, commissioning_at: null, agreement_status: 'pending', regulation_version: null, deemed_breach: false,
  });
  return rows;
}

export function buildSubsidyClaims(env: SeedEnv): SubsidyClaim[] {
  const rows: SubsidyClaim[] = [];
  const deadline = '2026-11-30';
  const base = (n: number, x: { so: string; inst: string | null; lead: LeadKey; dealer: string; dist: string }, age: number): Pick<SubsidyClaim, 'id' | 'org_id' | 'created_at' | 'updated_at' | 'created_by' | 'sales_order_id' | 'installation_id' | 'opportunity_id' | 'customer_id' | 'dealer_id' | 'distributor_id'> => ({
    ...baseOf(env, demoId('subsidy-claim', n), age * DAY, P.dispatch), sales_order_id: x.so, installation_id: x.inst, opportunity_id: OPP_OF_LEAD[x.lead] ?? null, customer_id: customerIdOf(x.lead), dealer_id: x.dealer, distributor_id: x.dist,
  });
  const empty = { e_token: null, discom_approval_at: null, claim_at: null, released_at: null, rejection_reason: null, state_share_due_at: null, state_share_received_at: null, grievance_raised_at: null };
  rows.push({
    ...base(1, { so: I.salesOrder.so1, inst: I.installation.inst1, lead: 'won1', dealer: I.dealer.d2, dist: I.distributor.sunrise }, 24), ...empty, status: 'released', cohort: 'legacy', cfa_computed: 78000, state_share: 0, bank_proof_ok: true, photos_ok: true, inspection_ok: true,
    e_token: 'DEMO-ET-0001', discom_approval_at: env.t(-22 * DAY), claim_at: env.t(-21 * DAY), released_at: env.t(-8 * DAY), claim_deadline: deadline,
  });
  rows.push({
    ...base(2, { so: I.salesOrder.so2, inst: I.installation.inst2, lead: 'won2', dealer: I.dealer.d3, dist: I.distributor.sunrise }, 20), ...empty, status: 'rejected', cohort: 'legacy', cfa_computed: 78000, state_share: 0, bank_proof_ok: true, photos_ok: false, inspection_ok: true,
    e_token: 'DEMO-ET-0002', discom_approval_at: env.t(-10 * DAY), claim_at: env.t(-9 * DAY), rejection_reason: 'photos_unclear', claim_deadline: deadline, grievance_raised_at: env.t(-3 * DAY),
  });
  rows.push({
    ...base(3, { so: I.salesOrder.so3, inst: I.installation.inst3, lead: 'won3', dealer: I.dealer.d2, dist: I.distributor.sunrise }, 26), ...empty, status: 'ready', cohort: 'legacy', cfa_computed: 67200, state_share: 0, bank_proof_ok: true, photos_ok: true, inspection_ok: true,
    e_token: 'DEMO-ET-0003', discom_approval_at: env.t(-15 * DAY), claim_deadline: deadline,
  });
  rows.push({
    ...base(4, { so: I.salesOrder.so4, inst: null, lead: 'won4', dealer: I.dealer.d8, dist: I.distributor.suryamitra }, 60), ...empty, status: 'not_ready', cohort: 'current', cfa_computed: 723600, state_share: 0, bank_proof_ok: false, photos_ok: false, inspection_ok: false, claim_deadline: null,
  });
  rows.push({
    ...base(5, { so: I.salesOrder.so5, inst: null, lead: 'won5', dealer: I.dealer.d6, dist: I.distributor.saurashtra }, 40), ...empty, status: 'not_ready', cohort: 'current', cfa_computed: 78000, state_share: 0, bank_proof_ok: false, photos_ok: false, inspection_ok: false, claim_deadline: null,
  });
  return rows;
}

export function buildWarrantyTickets(env: SeedEnv, serials: InventorySerial[]): WarrantyTicket[] {
  const so1Modules = serials.filter((s) => s.sales_order_id === I.salesOrder.so1 && s.sku_id === I.sku.m1Dcr);
  const so1Inverter = serials.find((s) => s.sales_order_id === I.salesOrder.so1 && s.sku_id === I.sku.i1Residential);
  const so2Inverter = serials.find((s) => s.sales_order_id === I.salesOrder.so2 && s.sku_id === I.sku.i1Residential);
  const rmaSerial = so1Modules.find((s) => s.status === 'rma');
  const mk = (n: number, o: Partial<WarrantyTicket> & Pick<WarrantyTicket, 'type' | 'issue' | 'cost_bearer' | 'status'>, so: string, inst: string, lead: LeadKey, dealer: string, openedAgo: number): WarrantyTicket => ({
    ...baseOf(env, demoId('warranty-ticket', n), openedAgo * DAY, P.dispatch), ticket_no: `WT-DEMO-${String(n).padStart(4, '0')}`, serial_id: null, sales_order_id: so, installation_id: inst, customer_id: customerIdOf(lead), dealer_id: dealer,
    brand_claim_no: null, opened_at: env.t(-openedAgo * DAY), rma_due_at: null, closed_at: null, recovered_amount: 0, owner_id: P.dispatch, ...o,
  });
  return [
    mk(1, { type: 'rma', issue: 'Module shows a hot-spot and 12 % power loss.', serial_id: rmaSerial?.id ?? null, brand_claim_no: 'DEMO-BC-501', cost_bearer: 'brand', status: 'sent_to_brand', rma_due_at: env.t(10 * DAY) }, I.salesOrder.so1, I.installation.inst1, 'won1', I.dealer.d2, 20),
    mk(2, { type: 'complaint', issue: 'Inverter makes a humming noise and trips on high-voltage days.', serial_id: so2Inverter?.id ?? null, cost_bearer: 'unknown', status: 'open' }, I.salesOrder.so2, I.installation.inst2, 'won2', I.dealer.d3, 4),
    mk(3, { type: 'om_visit', issue: 'First-year O&M visit: cleaning and string-current check.', cost_bearer: 'dealer', status: 'closed', closed_at: env.t(-5 * DAY) }, I.salesOrder.so3, I.installation.inst3, 'won3', I.dealer.d2, 9),
    mk(4, { type: 'warranty', issue: 'Inverter display failure — replaced under warranty.', serial_id: so1Inverter?.id ?? null, brand_claim_no: 'DEMO-BC-377', cost_bearer: 'brand', status: 'replaced', closed_at: env.t(-3 * DAY), recovered_amount: 38500 }, I.salesOrder.so1, I.installation.inst1, 'won1', I.dealer.d2, 18),
  ];
}
