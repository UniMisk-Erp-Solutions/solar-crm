import { SEGMENTS, type Segment } from '../enums';
import type { FormFieldDef, SegmentFormConfig } from '../rows';
import { baseOf, refId, type SeedEnv } from './util';

const DISCOMS = ['UGVCL', 'DGVCL', 'MGVCL', 'PGVCL', 'Torrent Power'];
const f = (key: string, label: string, type: FormFieldDef['type'], required: boolean, extra: Partial<FormFieldDef> = {}): FormFieldDef => ({ key, label, type, required, ...extra });

/** Fields every segment collects (prompt Section 9, Stage 3). */
const site = (required: { load: boolean; owner: boolean }): FormFieldDef[] => [
  f('consumer_no', 'Consumer number (as on the DISCOM bill)', 'text', true, { group: 'Electricity connection' }),
  f('discom', 'DISCOM', 'select', true, { options: DISCOMS, group: 'Electricity connection' }),
  f('sanctioned_load_kw', 'Sanctioned load (kW)', 'number', required.load, { group: 'Electricity connection' }),
  f('phase', 'Phase', 'select', true, { options: ['single', 'three'], group: 'Electricity connection' }),
  f('bill_doc', 'Latest electricity bill (PDF or photo)', 'file', true, { help: 'Photo or PDF of the bill. Do not upload Aadhaar.', group: 'Documents' }),
  f('name_on_bill', 'Name as on the electricity bill', 'text', true, { group: 'Ownership' }),
  f('name_match', 'Name on bill matches the applicant', 'boolean', true, { group: 'Ownership' }),
  f('roof_ownership', 'Roof ownership', 'select', required.owner, { options: ['owned', 'rented', 'society', 'leased', 'government'], group: 'Ownership' }),
  f('title_ok', 'Ownership / title documents in order', 'boolean', required.owner, { group: 'Ownership' }),
  f('pending_dues', 'Pending electricity dues', 'boolean', true, { group: 'Ownership' }),
  f('existing_solar_kw', 'Existing solar capacity (kW)', 'number', true, { help: 'Existing solar counts against the 3 kW subsidy cap.', group: 'Site' }),
  f('roof_type', 'Roof type', 'select', false, { options: ['rcc', 'metal_sheet', 'asbestos', 'tile', 'ground_mount', 'other'], group: 'Site' }),
  f('load_type', 'Load type', 'select', false, { options: ['residential', 'commercial', 'industrial', 'agricultural', 'common_facility'], group: 'Site' }),
];

const subsidy: FormFieldDef[] = [
  f('category', 'Applicant category', 'select', true, { options: ['general', 'sc', 'st'], group: 'Subsidy' }),
  f('special_category_state', 'Site is in a special-category state', 'boolean', true, { group: 'Subsidy' }),
];

const common: FormFieldDef[] = [
  f('specs', 'Technical specifications / client requirements', 'textarea', false, { group: 'Requirement' }),
  f('documents', 'Supporting documents', 'file', false, { help: 'Layouts, sanction letters, previous quotations. Do not upload Aadhaar.', group: 'Documents' }),
];

const BY_SEGMENT: Record<Segment, FormFieldDef[]> = {
  pmsg_residential: [...site({ load: true, owner: true }), ...subsidy, ...common],
  rwa_ghs: [
    ...site({ load: false, owner: true }), ...subsidy,
    f('rwa_households', 'Number of households', 'number', true, { help: 'CFA is capped at 3 kW per household.', group: 'Society' }),
    f('rwa_registration_no', 'Society registration number', 'text', true, { group: 'Society' }),
    f('rwa_common_load_kw', 'Common-facility connected load (kW)', 'number', true, { help: 'CFA applies to common facilities only.', group: 'Society' }),
    f('rwa_ballot_record', 'Ballot / general-body resolution record', 'file', true, { help: 'Decision record for the connection and the installer.', group: 'Society' }),
    ...common,
  ],
  ci_captive: [
    ...site({ load: false, owner: true }),
    f('contracted_demand_kva', 'Contracted demand (kVA)', 'number', true, { group: 'Electricity connection' }),
    f('tariff_category', 'Tariff category', 'text', true, { group: 'Electricity connection' }),
    f('entity_type', 'Entity type', 'select', true, { options: ['proprietorship', 'partnership', 'llp', 'private_limited', 'public_limited', 'trust', 'other'], group: 'Entity' }),
    f('behind_the_meter', 'Plant is behind the meter (captive consumption)', 'boolean', true, { group: 'Entity' }),
    f('annual_consumption_kwh', 'Annual consumption (kWh)', 'number', false, { group: 'Electricity connection' }),
    ...common,
  ],
  ci_net_metered: [
    ...site({ load: false, owner: true }),
    f('contracted_demand_kva', 'Contracted demand (kVA)', 'number', true, { group: 'Electricity connection' }),
    f('tariff_category', 'Tariff category', 'text', true, { group: 'Electricity connection' }),
    f('entity_type', 'Entity type', 'select', true, { options: ['proprietorship', 'partnership', 'llp', 'private_limited', 'public_limited', 'trust', 'other'], group: 'Entity' }),
    f('feasibility_submitted_on', 'DISCOM feasibility application submitted on', 'date', false, { help: 'Required above 10 kW; the 15-day deemed-feasibility clock starts when the application is complete.', group: 'DISCOM' }),
    f('feasibility_complete_on', 'DISCOM feasibility application complete on', 'date', false, { group: 'DISCOM' }),
    ...common,
  ],
  open_access: [
    ...site({ load: false, owner: true }),
    f('contracted_demand_kva', 'Contracted demand (kVA)', 'number', true, { group: 'Electricity connection' }),
    f('voltage_level', 'Connection voltage', 'select', true, { options: ['LT', '11 kV', '33 kV', '66 kV', '132 kV'], group: 'Electricity connection' }),
    f('tariff_category', 'Tariff category', 'text', true, { group: 'Electricity connection' }),
    f('entity_type', 'Entity type', 'select', true, { options: ['proprietorship', 'partnership', 'llp', 'private_limited', 'public_limited', 'trust', 'other'], group: 'Entity' }),
    f('wheeling_discom', 'Wheeling DISCOM', 'select', false, { options: DISCOMS, group: 'Open access' }),
    f('banking_charge_assumption', 'Banking-charge assumption (₹/kWh)', 'number', false, { help: 'Charges vary by GERC regulation version and order date — record the source.', group: 'Open access' }),
    ...common,
  ],
  pm_kusum: [
    f('consumer_no', 'Agricultural consumer number (if any)', 'text', false, { group: 'Electricity connection' }),
    f('discom', 'DISCOM', 'select', true, { options: DISCOMS, group: 'Electricity connection' }),
    f('name_on_bill', 'Name as on the electricity bill / land record', 'text', true, { group: 'Ownership' }),
    f('name_match', 'Name matches the applicant', 'boolean', true, { group: 'Ownership' }),
    f('pending_dues', 'Pending electricity dues', 'boolean', true, { group: 'Ownership' }),
    f('kusum_component', 'PM-KUSUM component', 'select', true, { options: ['A', 'B', 'C'], group: 'Scheme' }),
    f('pump_hp', 'Pump capacity (HP)', 'number', true, { group: 'Scheme' }),
    f('sanction_date', 'Sanction / PPA date', 'date', true, { help: 'Deadlines depend on sanctions issued up to 31-Dec-2025.', group: 'Scheme' }),
    f('land_ownership', 'Land ownership', 'select', true, { options: ['owned', 'leased', 'family', 'other'], group: 'Ownership' }),
    f('survey_number', 'Land survey / khata number', 'text', true, { group: 'Ownership' }),
    f('water_source', 'Water source', 'select', false, { options: ['borewell', 'open_well', 'canal', 'other'], group: 'Site' }),
    f('existing_solar_kw', 'Existing solar capacity (kW)', 'number', false, { group: 'Site' }),
    ...common,
  ],
  government_bid: [
    f('bid_reference', 'Tender / bid reference', 'text', true, { group: 'Tender' }),
    f('bid_date', 'Bid date', 'date', true, { help: 'Decides which ALMM List-II grandfathering date applies (unresolved, V-4).', group: 'Tender' }),
    f('tender_authority', 'Tendering authority', 'text', true, { group: 'Tender' }),
    f('emd_amount', 'EMD amount (₹)', 'number', false, { group: 'Tender' }),
    f('entity_type', 'Entity type', 'select', true, { options: ['central_government', 'state_government', 'psu', 'local_body', 'educational', 'other'], group: 'Entity' }),
    f('consumer_no', 'Consumer number (if metered)', 'text', false, { group: 'Electricity connection' }),
    f('discom', 'DISCOM', 'select', false, { options: DISCOMS, group: 'Electricity connection' }),
    f('contracted_demand_kva', 'Contracted demand (kVA)', 'number', false, { group: 'Electricity connection' }),
    f('roof_ownership', 'Roof ownership', 'select', true, { options: ['government', 'leased', 'owned'], group: 'Ownership' }),
    ...common,
  ],
};

export function buildSegmentForms(env: SeedEnv): SegmentFormConfig[] {
  return SEGMENTS.map((segment, i) => ({ ...baseOf(env, refId('segment-form', i + 1), 30 * 1440), segment, version: 1, fields: BY_SEGMENT[segment].map((x) => ({ ...x })) }));
}
