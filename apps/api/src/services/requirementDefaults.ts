/**
 * Built-in requirement-capture forms (step 15), used for any segment that has no row in `segment_form_config` yet.
 * An administrator can publish a new version with PUT /segments/:segment/form; the newest version always wins.
 */
import { PHASES, ROOF_OWNERSHIPS, ROOF_TYPES, SITE_CATEGORIES, type FormFieldDef, type Segment } from '@solar/shared';

const f = (key: string, label: string, type: FormFieldDef['type'], required: boolean, extra: Partial<Pick<FormFieldDef, 'options' | 'help' | 'group'>> = {}): FormFieldDef => ({ key, label, type, required, ...extra });

const LOAD_TYPES = ['residential', 'commercial', 'industrial', 'agricultural', 'institutional', 'mixed'];

const applicant = (labelBill = 'Name as on electricity bill'): FormFieldDef[] => [
  f('applicant_name', 'Applicant name', 'text', true, { group: 'Applicant', help: 'The person or entity that will apply for the scheme / DISCOM approval' }),
  f('name_on_bill', labelBill, 'text', true, { group: 'Applicant', help: 'Spell it exactly as printed on the DISCOM bill — a mismatch is a common reason for rejection' }),
];

const supply = (required: boolean): FormFieldDef[] => [
  f('consumer_no', 'Consumer number', 'text', required, { group: 'Electricity connection' }),
  // options are filled from the DISCOM master when the form is served
  f('discom_code', 'DISCOM', 'select', required, { group: 'Electricity connection', options: [] }),
  f('sanctioned_load_kw', 'Sanctioned load (kW)', 'number', required, { group: 'Electricity connection' }),
  f('phase', 'Phase', 'select', required, { group: 'Electricity connection', options: [...PHASES] }),
  f('avg_monthly_units', 'Average monthly consumption (kWh)', 'number', false, { group: 'Electricity connection' }),
  f('load_type', 'Load type', 'select', false, { group: 'Electricity connection', options: LOAD_TYPES }),
];

const demand = (required: boolean): FormFieldDef[] => [
  f('contracted_demand_kva', 'Contracted demand (kVA)', 'number', required, { group: 'Electricity connection' }),
  f('tariff_category', 'Tariff category', 'text', false, { group: 'Electricity connection' }),
];

const roof = (): FormFieldDef[] => [
  f('roof_ownership', 'Roof ownership', 'select', true, { group: 'Roof and title', options: [...ROOF_OWNERSHIPS] }),
  f('title_ok', 'Ownership documents / title in order', 'boolean', true, { group: 'Roof and title' }),
  f('roof_type', 'Roof type', 'select', false, { group: 'Roof and title', options: [...ROOF_TYPES] }),
  f('roof_area_sqm', 'Usable roof area (sq m)', 'number', false, { group: 'Roof and title' }),
  f('pending_dues', 'Any pending electricity dues?', 'boolean', true, { group: 'Roof and title', help: 'Dues must be cleared before the DISCOM application' }),
  f('existing_solar_kw', 'Existing solar capacity (kW)', 'number', false, { group: 'Roof and title', help: 'Counts against the 3 kW subsidy cap for residential customers' }),
];

const closing = (): FormFieldDef[] => [
  f('target_install_date', 'Preferred installation date', 'date', false, { group: 'Project' }),
  f('bill_document', 'Electricity bill (document reference)', 'file', false, { group: 'Project', help: 'Upload the bill from the Site tab; this field only stores the reference' }),
  f('notes', 'Notes', 'textarea', false, { group: 'Project' }),
];

export function defaultSegmentForm(segment: Segment): FormFieldDef[] {
  switch (segment) {
    case 'pmsg_residential':
      return [
        ...applicant(), ...supply(true), ...roof(),
        f('category', 'Category', 'select', true, { group: 'Applicant', options: [...SITE_CATEGORIES], help: 'General / SC / ST — affects subsidy rules in special-category states' }),
        f('loan_required', 'Customer wants a loan', 'boolean', false, { group: 'Funding' }),
        f('preferred_bank', 'Preferred bank', 'text', false, { group: 'Funding' }),
        f('subsidy_bank_account_ready', 'Bank account for the subsidy is ready', 'boolean', false, { group: 'Funding' }),
        ...closing(),
      ];
    case 'rwa_ghs':
      return [
        ...applicant('Society name as on electricity bill'), ...supply(true), ...roof(),
        f('society_name', 'Society / RWA name', 'text', true, { group: 'Society' }),
        f('society_registration_no', 'Society registration number', 'text', false, { group: 'Society' }),
        f('households', 'Number of households', 'number', true, { group: 'Society' }),
        f('common_area_load_kw', 'Common-facility load (kW)', 'number', true, { group: 'Society', help: 'Only common facilities (lifts, pumps, lighting) are eligible' }),
        f('society_noc', 'Society NOC / resolution obtained', 'boolean', true, { group: 'Society' }),
        ...closing(),
      ];
    case 'ci_captive':
      return [
        ...applicant('Company name as on electricity bill'), ...supply(true), ...demand(true), ...roof(),
        f('daytime_load_kw', 'Average daytime load (kW)', 'number', false, { group: 'Load profile' }),
        f('operating_hours', 'Operating hours per day', 'text', false, { group: 'Load profile' }),
        f('battery_required', 'Battery storage required', 'boolean', false, { group: 'Load profile' }),
        ...closing(),
      ];
    case 'ci_net_metered':
      return [
        ...applicant('Company name as on electricity bill'), ...supply(true), ...demand(true), ...roof(),
        f('voltage_level_kv', 'Connection voltage (kV)', 'number', false, { group: 'Electricity connection' }),
        f('target_commissioning_date', 'Target commissioning date', 'date', false, { group: 'Project', help: 'Drives the regulation version and the ALMM List-II exemption check' }),
        ...closing(),
      ];
    case 'open_access':
      return [
        ...applicant('Company name as on electricity bill'), ...supply(true), ...demand(true), ...roof(),
        f('injection_voltage_kv', 'Injection voltage (kV)', 'number', true, { group: 'Open access' }),
        f('wheeling_arrangement', 'Arrangement', 'select', true, { group: 'Open access', options: ['group_captive', 'third_party', 'self_use'] }),
        f('target_commissioning_date', 'Target commissioning date', 'date', false, { group: 'Project' }),
        ...closing(),
      ];
    case 'pm_kusum':
      return [
        ...applicant('Farmer name as on land / connection record'), ...supply(false),
        f('kusum_component', 'PM-KUSUM component', 'select', true, { group: 'Farm', options: ['A', 'B', 'C'] }),
        f('land_survey_no', 'Land survey number', 'text', true, { group: 'Farm' }),
        f('land_area_acres', 'Land area (acres)', 'number', true, { group: 'Farm' }),
        f('pump_hp', 'Pump capacity (HP)', 'number', false, { group: 'Farm' }),
        f('water_source', 'Water source', 'select', false, { group: 'Farm', options: ['borewell', 'open_well', 'canal', 'pond', 'other'] }),
        f('title_ok', 'Land title / 7-12 extract in order', 'boolean', true, { group: 'Farm' }),
        f('pending_dues', 'Any pending electricity dues?', 'boolean', false, { group: 'Farm' }),
        ...closing(),
      ];
    case 'government_bid':
      return [
        f('department', 'Department / organisation', 'text', true, { group: 'Tender' }),
        f('tender_no', 'Tender / bid number', 'text', true, { group: 'Tender' }),
        f('bid_due_date', 'Bid due date', 'date', true, { group: 'Tender' }),
        f('emd_amount_inr', 'EMD amount (INR)', 'number', false, { group: 'Tender' }),
        f('site_count', 'Number of sites', 'number', false, { group: 'Tender' }),
        ...supply(false), ...demand(false),
        f('roof_ownership', 'Roof ownership', 'select', false, { group: 'Roof and title', options: [...ROOF_OWNERSHIPS] }),
        f('pending_dues', 'Any pending electricity dues?', 'boolean', false, { group: 'Roof and title' }),
        ...closing(),
      ];
  }
}

/** Form keys that overlap with columns of the `sites` table; their values are mirrored into the site on every save. */
export const SITE_MIRROR_KEYS: readonly string[] = [
  'applicant_name', 'name_on_bill', 'consumer_no', 'discom_code', 'sanctioned_load_kw', 'contracted_demand_kva', 'phase', 'load_type', 'roof_ownership', 'title_ok', 'roof_type', 'pending_dues', 'existing_solar_kw', 'category',
];
