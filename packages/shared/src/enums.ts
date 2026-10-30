import { z } from 'zod';

/**
 * Single source of truth for every enumerated value used by the CRM.
 * The SQL enums in /supabase/sql/01_extensions_enums.sql mirror these arrays 1:1.
 */

function en<const T extends readonly [string, ...string[]]>(values: T) {
  return { values, schema: z.enum(values) };
}

export const APP_ROLES = ['admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'distributor_user', 'dealer_user', 'techno_commercial', 'accounts', 'compliance_officer', 'dispatch', 'viewer'] as const;
export type AppRole = (typeof APP_ROLES)[number];
export const appRoleSchema = z.enum(APP_ROLES);

export const SEGMENTS = ['pmsg_residential', 'rwa_ghs', 'ci_captive', 'ci_net_metered', 'open_access', 'pm_kusum', 'government_bid'] as const;
export type Segment = (typeof SEGMENTS)[number];
export const segmentSchema = z.enum(SEGMENTS);

export const LEAD_SOURCES = ['website', 'call_centre', 'whatsapp', 'campaign', 'referral', 'dealer_upload', 'manual'] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];
export const leadSourceSchema = z.enum(LEAD_SOURCES);

export const CUSTOMER_TYPES = ['residential', 'housing_society', 'commercial', 'industrial', 'farmer', 'government'] as const;
export type CustomerType = (typeof CUSTOMER_TYPES)[number];
export const customerTypeSchema = z.enum(CUSTOMER_TYPES);

export const LEAD_STATUSES = ['new', 'validated', 'duplicate', 'merged', 'unassigned', 'assigned', 'accepted', 'contacted', 'qualified', 'site_visit', 'nurture', 'opportunity', 'lost', 'won'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];
export const leadStatusSchema = z.enum(LEAD_STATUSES);

export const TEMPERATURES = ['hot', 'warm', 'cold'] as const;
export type Temperature = (typeof TEMPERATURES)[number];
export const temperatureSchema = z.enum(TEMPERATURES);

export const LOCK_STATUSES = ['open', 'locked', 'override_pending'] as const;
export type LockStatus = (typeof LOCK_STATUSES)[number];

export const DND_STATUSES = ['unchecked', 'clear', 'registered', 'blocked'] as const;
export type DndStatus = (typeof DND_STATUSES)[number];

export const CONSENT_CHANNELS = ['call', 'sms', 'whatsapp', 'email'] as const;
export type ConsentChannel = (typeof CONSENT_CHANNELS)[number];
export const consentChannelSchema = z.enum(CONSENT_CHANNELS);

export const CONSENT_PURPOSES = ['service', 'promotional', 'quotation', 'subsidy_processing', 'financing'] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];
export const consentPurposeSchema = z.enum(CONSENT_PURPOSES);

/** Message purpose used by the send pipeline. `promotional` needs consent + DND clear + no suppression. */
export const MESSAGE_PURPOSES = ['promotional', 'service', 'transactional'] as const;
export type MessagePurpose = (typeof MESSAGE_PURPOSES)[number];

export const TIMELINE_BUCKETS = ['immediate', 'within_30_days', 'one_to_three_months', 'three_to_six_months', 'six_months_plus', 'unknown'] as const;
export type TimelineBucket = (typeof TIMELINE_BUCKETS)[number];
export const timelineBucketSchema = z.enum(TIMELINE_BUCKETS);

export const ASSIGNMENT_STATUSES = ['pending', 'accepted', 'rejected', 'expired', 'reassigned'] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

export const FOLLOWUP_KINDS = ['call', 'whatsapp', 'visit', 'email', 'task'] as const;
export type FollowupKind = (typeof FOLLOWUP_KINDS)[number];
export const FOLLOWUP_STATUSES = ['open', 'done', 'missed', 'cancelled'] as const;
export type FollowupStatus = (typeof FOLLOWUP_STATUSES)[number];

export const CONTACT_CHANNELS = ['call', 'whatsapp', 'visit', 'sms', 'email'] as const;
export type ContactChannel = (typeof CONTACT_CHANNELS)[number];
export const CONTACT_OUTCOMES = ['connected_interested', 'connected_not_now', 'connected_not_interested', 'no_answer', 'busy_call_back', 'wrong_number', 'message_delivered', 'message_replied', 'visit_done', 'visit_rescheduled'] as const;
export type ContactOutcome = (typeof CONTACT_OUTCOMES)[number];

export const PHASES = ['single', 'three'] as const;
export const ROOF_OWNERSHIPS = ['owned', 'rented', 'society', 'leased', 'government'] as const;
export type RoofOwnership = (typeof ROOF_OWNERSHIPS)[number];
export const SITE_CATEGORIES = ['general', 'sc', 'st'] as const;
export type SiteCategory = (typeof SITE_CATEGORIES)[number];
export const ROOF_TYPES = ['rcc', 'metal_sheet', 'asbestos', 'tile', 'ground_mount', 'other'] as const;
export const SURVEY_STATUSES = ['scheduled', 'completed', 'cancelled'] as const;
export type SurveyStatus = (typeof SURVEY_STATUSES)[number];
export const FEASIBILITY_STATUSES = ['not_required', 'pending', 'deemed', 'approved', 'rejected'] as const;
export type FeasibilityStatus = (typeof FEASIBILITY_STATUSES)[number];

export const SCHEME_ROUTES = ['pmsg', 'rwa_ghs', 'kusum', 'net_metering', 'open_access', 'captive', 'government_bid', 'other'] as const;
export type SchemeRoute = (typeof SCHEME_ROUTES)[number];
export const OPPORTUNITY_STAGES = ['qualified', 'quotation', 'negotiation', 'pi_stage', 'won', 'lost'] as const;
export type OpportunityStage = (typeof OPPORTUNITY_STAGES)[number];

export const SKU_CATEGORIES = ['module', 'inverter', 'structure', 'battery', 'cable', 'other'] as const;
export type SkuCategory = (typeof SKU_CATEGORIES)[number];
export const SERIAL_STATUSES = ['in_stock', 'reserved', 'dispatched', 'installed', 'rma'] as const;
export type SerialStatus = (typeof SERIAL_STATUSES)[number];

export const QUOTE_STATUSES = ['draft', 'blocked', 'price_review', 'pending_approval', 'approved', 'sent', 'negotiation', 'accepted', 'rejected', 'revised', 'requote_required', 'expired'] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];
export const COMPLIANCE_STATUSES = ['pending', 'clear', 'warnings', 'blocked'] as const;
export type ComplianceStatus = (typeof COMPLIANCE_STATUSES)[number];

export const APPROVAL_LANES = ['commercial', 'compliance', 'credit'] as const;
export type ApprovalLane = (typeof APPROVAL_LANES)[number];
export const APPROVAL_DECISIONS = ['pending', 'approved', 'rejected', 'skipped'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];
export const APPROVAL_ENTITIES = ['quotation', 'proforma_invoice', 'sales_order', 'credit_override', 'compliance_override'] as const;
export type ApprovalEntity = (typeof APPROVAL_ENTITIES)[number];

export const PI_STATUSES = ['draft', 'pending_approval', 'issued', 'partially_paid', 'paid', 'cancelled'] as const;
export type PiStatus = (typeof PI_STATUSES)[number];
export const PAYMENT_KINDS = ['advance', 'balance', 'loan_disbursal', 'subsidy'] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];
export const PAYMENT_MODES = ['upi', 'neft_rtgs', 'cheque', 'cash', 'card', 'loan', 'other'] as const;
export const CREDIT_RESULTS = ['pending', 'approved', 'rejected'] as const;
export type CreditResult = (typeof CREDIT_RESULTS)[number];

export const SO_STATUSES = ['draft', 'on_hold', 'pending_approval', 'approved', 'dispatch_planning', 'partially_dispatched', 'dispatched', 'closed', 'cancelled'] as const;
export type SoStatus = (typeof SO_STATUSES)[number];
export const DISPATCH_STATUSES = ['planned', 'blocked', 'ready', 'dispatched', 'delivered', 'cancelled'] as const;
export type DispatchStatus = (typeof DISPATCH_STATUSES)[number];
export const EINVOICE_STATUSES = ['not_required', 'manual_pending', 'generated', 'failed'] as const;
export type EinvoiceStatusValue = (typeof EINVOICE_STATUSES)[number];

export const LOAN_STATUSES = ['draft', 'applied', 'in_review', 'approved', 'rejected', 'disbursed', 'withdrawn'] as const;
export type LoanStatus = (typeof LOAN_STATUSES)[number];
export const LOAN_REJECTION_CODES = ['name_mismatch', 'arrears', 'land_title', 'collateral_demanded', 'missing_documents', 'other'] as const;
export type LoanRejectionCode = (typeof LOAN_REJECTION_CODES)[number];

export const AGREEMENT_STATUSES = ['pending', 'signed', 'not_required'] as const;
export type AgreementStatusValue = (typeof AGREEMENT_STATUSES)[number];
export const SUBSIDY_STATUSES = ['not_ready', 'ready', 'claimed', 'released', 'rejected'] as const;
export type SubsidyStatus = (typeof SUBSIDY_STATUSES)[number];
export const SUBSIDY_COHORTS = ['legacy', 'current'] as const;
export type SubsidyCohort = (typeof SUBSIDY_COHORTS)[number];
export const SUBSIDY_REJECTION_REASONS = ['bank_proof_invalid', 'photos_unclear', 'inspection_pending', 'dcr_mismatch', 'name_mismatch', 'duplicate_claim', 'deadline_missed', 'other'] as const;
export const INSTALLATION_STATUSES = ['planned', 'installed', 'certified', 'commissioned'] as const;
export type InstallationStatus = (typeof INSTALLATION_STATUSES)[number];

export const WARRANTY_TYPES = ['warranty', 'rma', 'om_visit', 'complaint'] as const;
export const WARRANTY_STATUSES = ['open', 'inspected', 'sent_to_brand', 'replaced', 'rejected', 'closed'] as const;
export type WarrantyStatus = (typeof WARRANTY_STATUSES)[number];
export const COST_BEARERS = ['distributor', 'dealer', 'brand', 'consumer', 'unknown'] as const;

export const PARTY_STATUSES = ['onboarding', 'active', 'on_hold', 'inactive'] as const;
export type PartyStatus = (typeof PARTY_STATUSES)[number];
export const SECURITY_TYPES = ['pdc', 'bank_guarantee', 'cheque', 'none'] as const;
export const VENDOR_LEVELS = ['state', 'multi_state', 'national'] as const;
export type VendorLevel = (typeof VENDOR_LEVELS)[number];
export const PORTAL_STATUSES = ['active', 'deactivated', 'under_sop'] as const;
export type PortalStatus = (typeof PORTAL_STATUSES)[number];
export const SOP_STAGES = ['reply', 'reminder', 'show_cause', 'deactivation', 'appeal', 'closed'] as const;
export type SopStage = (typeof SOP_STAGES)[number];
export const RECEIVABLE_STATUSES = ['open', 'paid', 'overdue', 'written_off'] as const;
export type ReceivableStatus = (typeof RECEIVABLE_STATUSES)[number];

export const CLOCK_TYPES = ['lead_acceptance', 'followup', 'quote_followup', 'approval', 'discom_feasibility', 'discom_commissioning', 'cfa_release', 'legacy_cfa_claim_deadline', 'sop_reply', 'sop_show_cause', 'grievance', 'loan_ageing', 'warranty_rma', 'almm_exemption_commissioning', 'payment_reminder'] as const;
export type ClockType = (typeof CLOCK_TYPES)[number];
export const CLOCK_STATUSES = ['running', 'met', 'breached', 'cancelled'] as const;
export type ClockStatus = (typeof CLOCK_STATUSES)[number];

export const RULE_CONFIDENCES = ['high', 'medium', 'low', 'hypothesis'] as const;
export type RuleConfidence = (typeof RULE_CONFIDENCES)[number];
export const RULE_STATUSES = ['verified', 'unverified', 'conflicting'] as const;
export type RuleStatus = (typeof RULE_STATUSES)[number];
export const SEVERITIES = ['info', 'warning', 'hard_stop'] as const;
export type Severity = (typeof SEVERITIES)[number];
export const severitySchema = z.enum(SEVERITIES);

export const GATES = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10', 'G11', 'G12', 'G13', 'G14'] as const;
export type Gate = (typeof GATES)[number];
export const APPLICABILITIES = ['applies', 'not_applies', 'warning'] as const;
export type Applicability = (typeof APPLICABILITIES)[number];

export const NOTIFICATION_SEVERITIES = ['info', 'success', 'warning', 'critical'] as const;
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];
export const TEMPLATE_CATEGORIES = ['marketing', 'utility', 'authentication', 'service'] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];
export const MESSAGE_STATUSES = ['queued', 'sent', 'blocked', 'failed'] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];
export const MESSAGE_CHANNELS = ['whatsapp', 'sms', 'email', 'call', 'in_app'] as const;
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number];

export const DOCUMENT_BUCKETS = ['lead-docs', 'site-photos', 'quote-pdfs', 'compliance-docs', 'invoices'] as const;
export type DocumentBucket = (typeof DOCUMENT_BUCKETS)[number];
export const CONFIDENCE_LABEL: Record<RuleConfidence, string> = { high: 'High', medium: 'Medium', low: 'Low', hypothesis: 'Hypothesis' };

export const TABLE_NAMES = [
  'organizations', 'profiles', 'discoms', 'territories', 'user_territories', 'pincodes',
  'distributors', 'dealers', 'vendor_registrations', 'sop_cases', 'distributor_score_history',
  'leads', 'lead_consents', 'lead_events', 'lead_assignments', 'followups', 'contact_logs', 'dnd_register', 'lead_scores', 'source_api_keys',
  'customers', 'sites', 'site_surveys', 'opportunities', 'requirement_forms', 'segment_form_config', 'negotiation_logs',
  'skus', 'sku_compliance', 'sku_prices', 'stock_batches', 'inventory_serials',
  'quotations', 'quotation_lines', 'quote_discussions', 'approval_rules', 'approvals',
  'proforma_invoices', 'proforma_invoice_lines', 'payments', 'credit_checks', 'credit_overrides',
  'sales_orders', 'sales_order_lines', 'dispatches', 'dispatch_serials', 'einvoice_status', 'documents',
  'loans', 'discom_applications', 'subsidy_claims', 'installations', 'warranty_tickets', 'dealer_receivables',
  'rule_config', 'clocks', 'notifications', 'message_templates', 'message_log', 'kpi_snapshots', 'audit_log',
  'compliance_calendar_items', 'job_runs', 'verify_register', 'gate_applicability', 'breach_incidents', 'data_requests',
] as const;
export type TableName = (typeof TABLE_NAMES)[number];

/** Tables that never have updated_at and cannot be edited (insert-only ledgers). */
export const IMMUTABLE_TABLES: readonly TableName[] = ['audit_log', 'lead_events', 'distributor_score_history', 'message_log'];
/** Tables with an audit trigger in SQL (and the same emulation in the in-memory store). */
export const AUDITED_TABLES: readonly TableName[] = TABLE_NAMES.filter(
  (t) => !['audit_log', 'lead_events', 'message_log', 'job_runs', 'kpi_snapshots', 'notifications', 'clocks', 'dnd_register', 'lead_scores', 'organizations'].includes(t),
);

// keep helper exported so downstream packages can build their own enum helpers if needed
export const makeEnum = en;
