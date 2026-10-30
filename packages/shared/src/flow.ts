import type { AppRole, LeadStatus, Segment } from './enums';

/** Ownership legend from the reference chart — used for colour-coding stages and steps. */
export const OWNER_GROUPS = ['system', 'distributor', 'customer', 'sales', 'management'] as const;
export type OwnerGroup = (typeof OWNER_GROUPS)[number];
export const OWNER_LABEL: Record<OwnerGroup, string> = {
  system: 'System / CRM',
  distributor: 'Distributor / DSM',
  customer: 'End customer',
  sales: 'Sales / Techno-commercial',
  management: 'Management / Sales Ops / Accounts',
};

export interface FlowStep { no: number | null; key: string; name: string; owner: OwnerGroup; addition?: boolean }
export interface FlowStage { id: number; key: string; name: string; steps: FlowStep[] }

/** The company's six stages / 34 numbered steps, plus the research additions (no = null). */
export const FLOW_STAGES: FlowStage[] = [
  { id: 1, key: 'inquiry', name: 'Inquiry capture and allocation', steps: [
    { no: 1, key: 'inquiry_captured', name: 'Inquiry captured', owner: 'system' },
    { no: 2, key: 'validate_dedupe', name: 'Validate and de-duplicate', owner: 'system' },
    { no: 3, key: 'capture_details', name: 'Capture details', owner: 'system' },
    { no: 4, key: 'territory_match', name: 'Territory and capability match', owner: 'system' },
    { no: 5, key: 'auto_assign', name: 'Auto-assign to distributor / DSM', owner: 'distributor' },
    { no: 6, key: 'escalate_reassign', name: 'Escalate to DSM / reassign territory', owner: 'distributor' },
    { no: 7, key: 'lead_acceptance', name: 'Lead acceptance by distributor', owner: 'distributor' },
  ] },
  { id: 2, key: 'followup', name: 'Follow-up and lead classification', steps: [
    { no: 8, key: 'initial_contact', name: 'Initial customer contact', owner: 'distributor' },
    { no: 9, key: 'qualification_call', name: 'Qualification call', owner: 'distributor' },
    { no: 10, key: 'temperature', name: 'Lead temperature', owner: 'system' },
    { no: 11, key: 'quality_score', name: 'Lead quality score', owner: 'system' },
    { no: 12, key: 'followup_engine', name: 'CRM follow-up engine', owner: 'system' },
    { no: 13, key: 'auto_reminders', name: 'Auto reminders and notifications', owner: 'system' },
  ] },
  { id: 3, key: 'site', name: 'Site visit and opportunity development', steps: [
    { no: 14, key: 'site_visit', name: 'Customer site visit', owner: 'sales' },
    { no: 15, key: 'requirement_form', name: 'Requirement capture form', owner: 'sales' },
    { no: 16, key: 'product_recommendation', name: 'Product recommendation and brand USP', owner: 'sales' },
    { no: 17, key: 'technical_discussion', name: 'Technical discussion and solution fit', owner: 'sales' },
    { no: 18, key: 'rate_negotiation', name: 'Rate negotiation with end customer', owner: 'customer' },
    { no: 19, key: 'convert_opportunity', name: 'Convert to opportunity', owner: 'sales' },
    { no: 20, key: 'update_opportunity', name: 'Update opportunity', owner: 'sales' },
  ] },
  { id: 4, key: 'quotation', name: 'Quotation and approval', steps: [
    { no: 21, key: 'prepare_quote', name: 'Prepare techno-commercial offer', owner: 'sales' },
    { no: 22, key: 'price_review', name: 'Internal price review', owner: 'sales' },
    { no: 23, key: 'approval_matrix', name: 'Approval matrix', owner: 'management' },
    { no: 24, key: 'send_quote', name: 'Send quotation to customer', owner: 'sales' },
    { no: 25, key: 'customer_discussion', name: 'Customer discussion / negotiation', owner: 'customer' },
    { no: 26, key: 'revise_quote', name: 'Revise quote / follow-up', owner: 'sales' },
    { no: 27, key: 'terms_confirmed', name: 'Commercial terms confirmed', owner: 'sales' },
  ] },
  { id: 5, key: 'order', name: 'PI, payment and sales order', steps: [
    { no: 28, key: 'prepare_pi', name: 'Prepare proforma invoice', owner: 'management' },
    { no: 29, key: 'pi_approval', name: 'PI approval and issue', owner: 'management' },
    { no: 30, key: 'payment_credit', name: 'Payment / credit verification', owner: 'management' },
    { no: 31, key: 'customer_po', name: 'Customer PO / order confirmation', owner: 'customer' },
    { no: 32, key: 'create_so', name: 'Create sales order', owner: 'system' },
    { no: 33, key: 'so_approval', name: 'SO approval and stakeholder circulation', owner: 'management' },
    { no: 34, key: 'dispatch_handover', name: 'Hand over to dispatch planning', owner: 'management' },
  ] },
  { id: 6, key: 'after', name: 'Dispatch, installation and subsidy', steps: [
    { no: null, key: 'serial_dispatch', name: 'Serial-number dispatch', owner: 'system', addition: true },
    { no: null, key: 'installation', name: 'Installation and DISCOM commissioning', owner: 'distributor', addition: true },
    { no: null, key: 'subsidy_loan', name: 'Subsidy claim and loan tracking', owner: 'management', addition: true },
    { no: null, key: 'warranty', name: 'Warranty, RMA and 5-year O&M', owner: 'distributor', addition: true },
  ] },
];

/** The six conversion gates from Stage 6 of the chart. */
export const CONVERSION_GATES = ['Valid Lead', 'Qualified Lead', 'Opportunity', 'Quotation', 'PI', 'Sales Order'] as const;

/** Lead statuses in kanban order. */
export const LEAD_KANBAN_COLUMNS: { status: LeadStatus; label: string }[] = [
  { status: 'new', label: 'New' },
  { status: 'unassigned', label: 'Needs assignment' },
  { status: 'assigned', label: 'Awaiting acceptance' },
  { status: 'accepted', label: 'Accepted' },
  { status: 'contacted', label: 'Contacted' },
  { status: 'qualified', label: 'Qualified' },
  { status: 'site_visit', label: 'Site visit' },
  { status: 'nurture', label: 'Nurture' },
];

/** The reference-chart step a lead is currently at, by status. */
export const LEAD_STATUS_STEP: Record<LeadStatus, number> = {
  new: 2, validated: 3, duplicate: 2, merged: 2, unassigned: 6, assigned: 7, accepted: 8, contacted: 9, qualified: 12, site_visit: 14, nurture: 18, opportunity: 19, lost: 18, won: 32,
};

export const SEGMENT_LABEL: Record<Segment, string> = {
  pmsg_residential: 'PM Surya Ghar — residential',
  rwa_ghs: 'Housing society / RWA',
  ci_captive: 'C&I — captive (behind the meter)',
  ci_net_metered: 'C&I — net-metered',
  open_access: 'Open access',
  pm_kusum: 'PM-KUSUM (farmer)',
  government_bid: 'Government / bid',
};

export const ROLE_LABEL: Record<AppRole, string> = {
  admin: 'Administrator', management: 'Management', regional_head: 'Regional Head', sales_manager: 'Sales Manager', dsm: 'District Sales Manager',
  distributor_user: 'Distributor', dealer_user: 'Dealer / Installer', techno_commercial: 'Techno-commercial', accounts: 'Accounts',
  compliance_officer: 'Compliance Officer', dispatch: 'Dispatch', viewer: 'Viewer',
};

export const INTERNAL_ROLES: readonly AppRole[] = ['admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial', 'accounts', 'compliance_officer', 'dispatch', 'viewer'];
export const EXTERNAL_ROLES: readonly AppRole[] = ['distributor_user', 'dealer_user'];
export const isExternalRole = (r: AppRole): boolean => EXTERNAL_ROLES.includes(r);
/** Roles who may see full (unmasked) mobile numbers in lists. */
export const MOBILE_VISIBLE_ROLES: readonly AppRole[] = ['admin', 'sales_manager', 'regional_head', 'dsm', 'distributor_user', 'dealer_user', 'techno_commercial'];
/** Management-type roles who can see everything and approve at the top of each lane. */
export const LEADERSHIP_ROLES: readonly AppRole[] = ['admin', 'management', 'regional_head', 'sales_manager'];
