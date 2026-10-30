/**
 * Row types — one interface per table, snake_case, exactly as stored in Postgres.
 * This file is the CONTRACT between the SQL files, the seed data, the API and the web app.
 * Conventions: uuid/timestamptz/date columns are `string` (ISO 8601 / YYYY-MM-DD); numeric is `number`;
 * jsonb is `Json` or a named shape; nullable columns are `T | null`.
 */
import type {
  AgreementStatusValue, ApprovalDecision, ApprovalEntity, ApprovalLane, Applicability, AppRole, AssignmentStatus, ClockStatus, ClockType,
  ComplianceStatus, ConsentChannel, ConsentPurpose, ContactChannel, ContactOutcome, CreditResult, CustomerType, DispatchStatus, DndStatus,
  DocumentBucket, EinvoiceStatusValue, FeasibilityStatus, FollowupKind, FollowupStatus, Gate, InstallationStatus, LeadSource, LeadStatus,
  LoanRejectionCode, LoanStatus, LockStatus, MessageChannel, MessagePurpose, MessageStatus, NotificationSeverity, OpportunityStage, PartyStatus,
  PaymentKind, PiStatus, PortalStatus, QuoteStatus, ReceivableStatus, RoofOwnership, RuleConfidence, RuleStatus, SchemeRoute, Segment, Severity,
  SerialStatus, SiteCategory, SkuCategory, SoStatus, SopStage, SubsidyCohort, SubsidyStatus, SurveyStatus, Temperature, TemplateCategory,
  TimelineBucket, VendorLevel, WarrantyStatus, TableName,
} from './enums';

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type Uuid = string;
export type Iso = string;
export type DateOnly = string;

export interface Address { line1: string; line2?: string; city: string; district?: string; state: string; pincode: string }
export interface Base { id: Uuid; org_id: Uuid; created_at: Iso; updated_at: Iso; created_by: Uuid | null }
export interface BaseImmutable { id: Uuid; org_id: Uuid; created_at: Iso }

/* ───────────────────────── Identity and org ───────────────────────── */
export interface Organization { id: Uuid; name: string; legal_name: string; gstin: string | null; pan: string | null; address: Address | null; state: string; settings: Json; created_at: Iso; updated_at: Iso }
export interface Profile { id: Uuid; org_id: Uuid; full_name: string; email: string; phone: string | null; role: AppRole; designation: string | null; distributor_id: Uuid | null; dealer_id: Uuid | null; territory_ids: Uuid[]; reports_to: Uuid | null; language: 'en' | 'hi' | 'gu'; active: boolean; created_at: Iso; updated_at: Iso; created_by: Uuid | null }
export interface Discom extends Base { code: string; name: string; state: string; kind: 'discom' | 'licensee' }
export interface PincodeRange { from: string; to: string }
export interface Territory extends Base { name: string; state: string; district: string | null; pincode_ranges: PincodeRange[]; discom_id: Uuid | null; dsm_id: Uuid | null; active: boolean }
export interface UserTerritory extends Base { user_id: Uuid; territory_id: Uuid }
export interface Pincode extends Base { pincode: string; city: string; district: string; state: string; discom_id: Uuid | null; territory_id: Uuid | null }

/* ───────────────────────── Parties ───────────────────────── */
export interface Distributor extends Base {
  legal_name: string; trade_name: string | null; gstin: string | null; pan: string | null; contact_name: string | null; phone: string | null; email: string | null;
  address: Address | null; state: string; city: string | null; territory_ids: Uuid[];
  capacity_band_min_kw: number; capacity_band_max_kw: number; capability_tags: string[]; score: number; status: PartyStatus;
  credit_days: number; credit_limit: number; rebate_slab_key: string | null;
}
export interface Dealer extends Base {
  distributor_id: Uuid; legal_name: string; trade_name: string | null; gstin: string | null; pan: string | null; contact_name: string | null; phone: string | null; email: string | null;
  territory_id: Uuid | null; city: string | null; district: string | null; state: string;
  credit_limit: number; security_type: 'pdc' | 'bank_guarantee' | 'cheque' | 'none'; security_amount: number; status: PartyStatus;
  portal_status: PortalStatus; complaint_count: number; rebate_accrued: number;
}
export interface VendorRegistration extends Base {
  party_type: 'distributor' | 'dealer'; party_id: Uuid; level: VendorLevel; portal_vendor_id: string | null; states: string[]; districts: string[];
  bank_guarantee_amount: number; bank_guarantee_valid_till: DateOnly | null; portal_status: PortalStatus; deactivated_from: DateOnly | null; deactivated_to: DateOnly | null; complaint_count: number; notes: string | null;
}
export interface SopCase extends Base {
  dealer_id: Uuid; vendor_registration_id: Uuid | null; complaint_ref: string; summary: string | null; notice_at: Iso; stage: SopStage;
  reply_due_at: Iso | null; replied_at: Iso | null; reminder_at: Iso | null; show_cause_at: Iso | null; show_cause_due_at: Iso | null; deactivated_at: Iso | null; appeal_due_at: Iso | null; closed_at: Iso | null; outcome: string | null;
}
export interface DistributorScoreHistory extends BaseImmutable { distributor_id: Uuid; score: number; components: Json; computed_at: Iso }

/* ───────────────────────── Lead layer ───────────────────────── */
export interface Lead extends Base {
  source: LeadSource; source_ref: string | null; source_detail: Json; notice_version: string | null;
  name: string; mobile: string; email: string | null; pincode: string | null; city: string | null; district: string | null; state: string | null;
  segment: Segment | null; customer_type: CustomerType | null; capacity_kw: number | null; product_interest: string[];
  status: LeadStatus; temperature: Temperature | null; quality_score: number | null;
  owner_id: Uuid | null; distributor_id: Uuid | null; dealer_id: Uuid | null; territory_id: Uuid | null; customer_id: Uuid | null; site_id: Uuid | null; consumer_no: string | null;
  last_action: string | null; last_action_at: Iso | null; next_action: string | null; next_followup_at: Iso | null;
  assigned_at: Iso | null; accepted_at: Iso | null; sla_due_at: Iso | null; first_contacted_at: Iso | null;
  language: 'en' | 'hi' | 'gu'; lock_status: LockStatus; locked_by_dealer_id: Uuid | null; duplicate_of: Uuid | null; dnd_status: DndStatus; dnd_checked_at: Iso | null;
  requirement_text: string | null; timeline_bucket: TimelineBucket | null; budget_inr: number | null; decision_maker: 'self' | 'family' | 'committee' | 'unknown' | null; decision_maker_access: boolean | null;
  bill_captured: boolean; nurture_until: DateOnly | null; nurture_reason: string | null; lost_reason: string | null; notes: string | null;
  deadline_uplift: boolean; anonymised_at: Iso | null; deleted_at: Iso | null;
}
export interface LeadConsent extends Base {
  lead_id: Uuid; notice_version: string; purposes: ConsentPurpose[]; channels: ConsentChannel[]; recipients_named: string[]; granted_at: Iso; ip: string | null; user_agent: string | null; proof_ref: string | null; capture_source: string | null;
  withdrawn_at: Iso | null; withdrawn_by: Uuid | null; withdrawal_channel: string | null; optout_suppress_until: Iso | null;
}
export interface LeadEvent extends BaseImmutable { lead_id: Uuid; event_type: string; summary: string; actor_id: Uuid | null; detail: Json }
export interface LeadAssignment extends Base { lead_id: Uuid; distributor_id: Uuid | null; dealer_id: Uuid | null; assigned_to: Uuid | null; step: 'auto' | 'manual' | 'escalation' | 'reassignment'; status: AssignmentStatus; reason: string | null; assigned_at: Iso; due_at: Iso | null; responded_at: Iso | null; score_snapshot: Json }
export interface Followup extends Base { lead_id: Uuid; kind: FollowupKind; due_at: Iso; note: string | null; status: FollowupStatus; done_at: Iso | null; owner_id: Uuid | null; outcome: string | null; reminder_sent_at: Iso | null; escalated_level: number }
export interface ContactLog extends Base { lead_id: Uuid; channel: ContactChannel; direction: 'outbound' | 'inbound'; outcome: ContactOutcome; notes: string | null; duration_min: number | null; occurred_at: Iso; logged_by: Uuid | null }
export interface DndRegister extends Base { mobile_hash: string; status: 'clear' | 'registered' | 'blocked'; checked_at: Iso; source: string }
export interface LeadScoreComponent { key: string; label: string; weight: number; points: number; note?: string }
export interface LeadScore extends Base { lead_id: Uuid; score: number; components: LeadScoreComponent[]; computed_at: Iso }
export interface SourceApiKey extends Base { source: LeadSource; label: string; key_hash: string; key_prefix: string; active: boolean; last_used_at: Iso | null }

/* ───────────────────────── Customer and site ───────────────────────── */
export interface Customer extends Base { legal_name: string; display_name: string | null; customer_type: CustomerType | null; gstin: string | null; pan: string | null; email: string | null; phone: string | null; billing_address: Address | null; shipping_address: Address | null; state: string | null; lead_id: Uuid | null; aadhaar_last4: string | null; anonymised_at: Iso | null }
export interface Site extends Base {
  customer_id: Uuid | null; lead_id: Uuid | null; name_on_bill: string | null; applicant_name: string | null; name_match: boolean | null; consumer_no: string | null; discom_id: Uuid | null;
  sanctioned_load_kw: number | null; contracted_demand_kva: number | null; phase: 'single' | 'three' | null;
  address: Address | null; pincode: string | null; city: string | null; district: string | null; state: string | null; lat: number | null; lng: number | null;
  roof_ownership: RoofOwnership | null; title_ok: boolean | null; pending_dues: boolean; existing_solar_kw: number; category: SiteCategory; special_category_state: boolean; roof_type: string | null; load_type: string | null; bill_doc_id: Uuid | null;
}
export interface SurveyPhoto { path: string; lat: number | null; lng: number | null; taken_at: Iso | null; caption?: string | null }
export interface SiteSurvey extends Base {
  site_id: Uuid | null; lead_id: Uuid; opportunity_id: Uuid | null; status: SurveyStatus; scheduled_at: Iso | null; surveyed_at: Iso | null; surveyor_id: Uuid | null;
  photos: SurveyPhoto[]; shading: 'none' | 'low' | 'medium' | 'high' | null; roof_type: string | null; roof_area_sqm: number | null; sld_ref: string | null; notes: string | null;
  feasibility_status: FeasibilityStatus; feasibility_application_submitted_at: Iso | null; feasibility_application_complete_at: Iso | null; feasibility_due_at: Iso | null;
}

/* ───────────────────────── Opportunity ───────────────────────── */
export interface FundingMix { consumer_pct: number; loan_pct: number; subsidy_pct: number; loan_rate_pct?: number | null; loan_rate_source_date?: DateOnly | null; bank?: string | null }
export interface Opportunity extends Base {
  name: string; lead_id: Uuid; customer_id: Uuid | null; site_id: Uuid | null; segment: Segment; kw: number; scheme_route: SchemeRoute; funding_mix: FundingMix;
  probability: number; expected_value: number; expected_close_date: DateOnly | null; expected_commissioning_date: DateOnly | null; competitor: string | null;
  regulation_version: string | null; exemption_reliance: boolean; requirement_confirmed: boolean; timeline_confirmed: boolean; commercial_potential_confirmed: boolean;
  stage: OpportunityStage; lost_reason: string | null; owner_id: Uuid | null; distributor_id: Uuid | null; dealer_id: Uuid | null; territory_id: Uuid | null;
}
export interface RequirementForm extends Base { lead_id: Uuid; opportunity_id: Uuid | null; site_id: Uuid | null; segment: Segment; data: { [key: string]: Json }; completed_at: Iso | null; completed_by: Uuid | null }
export interface FormFieldDef { key: string; label: string; type: 'text' | 'number' | 'select' | 'boolean' | 'date' | 'textarea' | 'file'; required: boolean; options?: string[]; help?: string; group?: string }
export interface SegmentFormConfig extends Base { segment: Segment; version: number; fields: FormFieldDef[] }
export interface NegotiationLog extends Base { lead_id: Uuid; opportunity_id: Uuid | null; quoted_rate_per_kw: number | null; customer_counter_per_kw: number | null; notes: string | null; logged_by: Uuid | null; logged_at: Iso }

/* ───────────────────────── Catalogue and stock ───────────────────────── */
export interface BrandUsp { quality: string; warranty: string; certifications: string; service_support: string; delivery_reliability: string }
export interface Sku extends Base { category: SkuCategory; make: string; model: string; variant: string | null; wattage: number | null; hsn: string | null; uom: string; active: boolean; demo: boolean; description: string | null; warranty_years: number | null; brand_usp: BrandUsp | null }
export interface SkuCompliance extends Base {
  sku_id: Uuid; almm_list1: boolean; almm_list1_ref: string | null; almm_list1_valid_till: DateOnly | null; almm_snapshot_date: DateOnly | null;
  cell_maker: string | null; almm_list2: boolean; dcr_verified: boolean; cell_origin: string | null;
  bis_licence_no: string | null; bis_licensed_model: string | null; bis_standard_no: string | null; bis_valid_till: DateOnly | null;
  inverter_kw: number | null; self_certified: boolean; thin_film: boolean; verified_by: Uuid | null; verified_at: Iso | null;
}
export interface LandedCost { bcd?: number; aidc?: number; sws?: number; adc?: number; freight?: number }
export interface SkuPrice extends Base { sku_id: Uuid; base_price: number; valid_from: DateOnly; valid_to: DateOnly | null; landed_cost: LandedCost; source: string | null; snapshot_label: string | null; floor_price: number | null }
export interface StockBatch extends Base { sku_id: Uuid; batch_no: string; received_at: DateOnly; qty: number; supplier: string | null; origin: 'import' | 'domestic'; boe_no: string | null; unit_cost: number | null; location: string | null }
export interface SerialSnapshot { almm_list1: boolean; almm_list2: boolean; dcr_verified: boolean; bis_ok: boolean; snapshot_date: DateOnly | null }
export interface InvoiceChainLink { from: string; to: string; invoice_no: string; date: DateOnly }
export interface InventorySerial extends Base { serial: string; sku_id: Uuid; batch_id: Uuid | null; status: SerialStatus; quote_id: Uuid | null; sales_order_id: Uuid | null; sales_order_line_id: Uuid | null; dispatch_id: Uuid | null; site_id: Uuid | null; compliance_snapshot: SerialSnapshot; invoice_chain: InvoiceChainLink[]; installed_at: Iso | null }

/* ───────────────────────── Quote, approval, order ───────────────────────── */
export interface Finding { gate: Gate; severity: Severity; message: string; ruleIds: Uuid[]; fieldRefs: string[]; overridden?: boolean; ruleStatus?: RuleStatus | null; ruleConfidence?: RuleConfidence | null; ruleSource?: string | null; advisory?: boolean }
export interface FloorCheck { ok: boolean; lines: { sku_id: Uuid; unit_price: number; floor_price: number | null; below_floor: boolean }[]; margin_pct: number | null }
export interface Quotation extends Base {
  quote_no: string; version: number; parent_quote_id: Uuid | null; opportunity_id: Uuid; lead_id: Uuid | null; customer_id: Uuid | null; site_id: Uuid | null; segment: Segment; kw: number; expected_commissioning_date: DateOnly | null;
  status: QuoteStatus; validity_date: DateOnly; price_snapshot_at: Iso; tax_position_approved: boolean; clause_keys: string[]; place_of_supply: string | null; payment_terms: string | null;
  subtotal: number; discount_pct: number; discount_amount: number; freight: number; tax_total: number; total: number; margin_pct: number | null; floor_check: FloorCheck | null;
  cfa_entitlement: number; state_share: number; loan_share: number; consumer_share: number; cfa_breakdown: Json; loan_rate_pct: number | null; loan_rate_source_date: DateOnly | null;
  exemption_reliance: boolean; compliance_status: ComplianceStatus; compliance_findings: Finding[]; compliance_evaluated_at: Iso | null; rule_ids_used: Uuid[]; requote_reason: string | null;
  owner_id: Uuid | null; distributor_id: Uuid | null; dealer_id: Uuid | null; territory_id: Uuid | null; sent_at: Iso | null; accepted_at: Iso | null; rejected_reason: string | null; pdf_document_id: Uuid | null; terms_confirmed_at: Iso | null;
}
export interface QuotationLine extends Base { quote_id: Uuid; sku_id: Uuid | null; description: string; hsn: string | null; gst_rate: number | null; gst_as_of: DateOnly | null; tax_position_approved: boolean; tax_approved_by: Uuid | null; qty: number; uom: string; unit_price: number; discount_pct: number; line_total: number; price_id: Uuid | null; sort_order: number }
export interface QuoteDiscussion extends Base { quote_id: Uuid; kind: 'call' | 'whatsapp' | 'meeting' | 'email'; outcome: string | null; notes: string | null; logged_by: Uuid | null; logged_at: Iso; next_followup_at: Iso | null }
export interface ApprovalRule extends Base { lane: ApprovalLane; name: string; min_value: number; max_value: number | null; role_chain: AppRole[]; sla_hours: number; active: boolean; conditions: Json }
export interface Approval extends Base { entity_type: ApprovalEntity; entity_id: Uuid; lane: ApprovalLane; step: number; required_role: AppRole; approver_id: Uuid | null; decision: ApprovalDecision; comment: string | null; decided_at: Iso | null; due_at: Iso | null; requested_by: Uuid | null; requested_at: Iso; meta: Json }

export interface PreFlightChecklist { legal_name: boolean; billing_address: boolean; shipping_address: boolean; gst: boolean; product: boolean; quantity: boolean; price: boolean; freight: boolean; payment_terms: boolean }
export interface ProformaInvoice extends Base {
  pi_no: string; quote_id: Uuid; opportunity_id: Uuid | null; customer_id: Uuid | null; dealer_id: Uuid | null; distributor_id: Uuid | null; status: PiStatus;
  legal_name: string | null; gstin: string | null; billing_address: Address | null; shipping_address: Address | null; payment_terms: string | null;
  subtotal: number; freight: number; tax_total: number; total: number; consumer_share: number; loan_share: number; subsidy_receivable: number;
  pre_pi_checklist: PreFlightChecklist; issue_date: DateOnly | null; valid_till: DateOnly | null; approved_by: Uuid | null; issued_at: Iso | null; sales_order_id: Uuid | null;
}
export interface ProformaInvoiceLine extends Base { pi_id: Uuid; sku_id: Uuid | null; description: string; hsn: string | null; gst_rate: number | null; qty: number; unit_price: number; line_total: number; sort_order: number }
export interface Payment extends Base { pi_id: Uuid | null; sales_order_id: Uuid | null; kind: PaymentKind; amount: number; mode: string; reference: string | null; received_at: Iso; recorded_by: Uuid | null; status: 'received' | 'pending' | 'bounced' }
export interface CreditAgeing { current: number; d1_30: number; d31_60: number; d61_90: number; d90_plus: number }
export interface CreditCheck extends Base { pi_id: Uuid | null; sales_order_id: Uuid | null; dealer_id: Uuid | null; distributor_id: Uuid | null; basis: 'advance' | 'credit'; result: CreditResult; credit_limit: number; outstanding: number; ageing: CreditAgeing; subsidy_linked: number; bg_valid: boolean | null; portal_status: PortalStatus | null; notes: string | null; decided_by: Uuid | null; decided_at: Iso | null }
export interface CreditOverride extends Base { dealer_id: Uuid; pi_id: Uuid | null; sales_order_id: Uuid | null; reason: string; status: 'pending' | 'approved' | 'rejected'; requested_by: Uuid | null; approved_by: Uuid | null; approved_at: Iso | null }
export interface SalesOrder extends Base {
  so_no: string; pi_id: Uuid; quote_id: Uuid; opportunity_id: Uuid | null; customer_id: Uuid | null; site_id: Uuid | null; dealer_id: Uuid | null; distributor_id: Uuid | null; territory_id: Uuid | null; segment: Segment; status: SoStatus;
  customer_po_no: string | null; customer_po_date: DateOnly | null; po_document_id: Uuid | null; hold_reason: string | null; order_date: DateOnly; total: number; advance_received: number; credit_basis: 'advance' | 'credit' | null;
  circulated_at: Iso | null; approved_by: Uuid | null; dispatch_handover_at: Iso | null; expected_commissioning_date: DateOnly | null;
}
export interface SalesOrderLine extends Base { so_id: Uuid; sku_id: Uuid | null; description: string; hsn: string | null; gst_rate: number | null; qty: number; unit_price: number; line_total: number; qty_dispatched: number; sort_order: number }
export interface Dispatch extends Base { dispatch_no: string; so_id: Uuid; status: DispatchStatus; planned_at: Iso | null; dispatched_at: Iso | null; vehicle_no: string | null; transporter: string | null; ewb_no: string | null; ewb_status: EinvoiceStatusValue; invoice_no: string | null; invoice_chain: InvoiceChainLink[]; compliance_status: ComplianceStatus; compliance_findings: Finding[]; dispatch_note_document_id: Uuid | null; ship_to: Address | null }
export interface DispatchSerial extends Base { dispatch_id: Uuid; serial_id: Uuid; so_line_id: Uuid | null }
export interface EinvoiceStatus extends Base { entity_type: 'dispatch' | 'proforma_invoice'; entity_id: Uuid; irn: string | null; ack_no: string | null; ack_date: Iso | null; status: EinvoiceStatusValue; provider: string; payload: Json }
export interface DocumentRow extends Base { entity_type: string; entity_id: string; bucket: DocumentBucket; path: string; doc_type: string; file_name: string; mime: string | null; size_bytes: number | null; uploaded_by: Uuid | null }

/* ───────────────────────── Post-sale ───────────────────────── */
export interface Loan extends Base { opportunity_id: Uuid | null; lead_id: Uuid | null; customer_id: Uuid | null; dealer_id: Uuid | null; distributor_id: Uuid | null; owner_id: Uuid | null; bank: string; application_date: DateOnly | null; status: LoanStatus; rejection_code: LoanRejectionCode | null; amount: number | null; rate_pct: number | null; rate_source_date: DateOnly | null; co_applicant: string | null; document_checklist: { [doc: string]: boolean }; disbursed_at: Iso | null; notes: string | null }
export interface DiscomApplication extends Base {
  sales_order_id: Uuid | null; installation_id: Uuid | null; site_id: Uuid | null; customer_id: Uuid | null; discom_id: Uuid | null; dealer_id: Uuid | null; distributor_id: Uuid | null; application_no: string | null; applied_kw: number;
  submitted_at: Iso | null; complete_at: Iso | null; feasibility_due_at: Iso | null; feasibility_status: FeasibilityStatus; inspection_at: Iso | null; meter_type: string | null; meter_at: Iso | null;
  certificate_submitted_at: Iso | null; commissioning_due_at: Iso | null; commissioning_at: Iso | null; agreement_status: AgreementStatusValue; regulation_version: string | null; deemed_breach: boolean;
}
export interface SubsidyClaim extends Base {
  sales_order_id: Uuid | null; installation_id: Uuid | null; opportunity_id: Uuid | null; customer_id: Uuid | null; dealer_id: Uuid | null; distributor_id: Uuid | null; status: SubsidyStatus; cohort: SubsidyCohort;
  cfa_computed: number; state_share: number; bank_proof_ok: boolean; photos_ok: boolean; inspection_ok: boolean; e_token: string | null; discom_approval_at: Iso | null; claim_at: Iso | null; released_at: Iso | null;
  rejection_reason: string | null; state_share_due_at: Iso | null; state_share_received_at: Iso | null; claim_deadline: DateOnly | null; grievance_raised_at: Iso | null;
}
export interface InstallPhoto { path: string; lat: number | null; lng: number | null; taken_at: Iso | null }
export interface Installation extends Base { sales_order_id: Uuid; site_id: Uuid | null; customer_id: Uuid | null; dealer_id: Uuid | null; distributor_id: Uuid | null; vendor_registration_id: Uuid | null; installer_name: string | null; status: InstallationStatus; install_date: DateOnly | null; certificate_at: Iso | null; photos: InstallPhoto[]; agreement_status: AgreementStatusValue; regulation_version: string | null; no_connectivity_agreement: boolean; commissioned_at: Iso | null; warranty_end: DateOnly | null; om_end: DateOnly | null; kw: number | null }
export interface WarrantyTicket extends Base { ticket_no: string; serial_id: Uuid | null; sales_order_id: Uuid | null; installation_id: Uuid | null; customer_id: Uuid | null; dealer_id: Uuid | null; type: 'warranty' | 'rma' | 'om_visit' | 'complaint'; issue: string; brand_claim_no: string | null; cost_bearer: 'distributor' | 'dealer' | 'brand' | 'consumer' | 'unknown'; status: WarrantyStatus; opened_at: Iso; rma_due_at: Iso | null; closed_at: Iso | null; recovered_amount: number; owner_id: Uuid | null }
export interface DealerReceivable extends Base { dealer_id: Uuid; distributor_id: Uuid | null; doc_ref: string; amount: number; paid_amount: number; invoice_date: DateOnly; due_date: DateOnly; subsidy_linked: boolean; linked_project_id: Uuid | null; status: ReceivableStatus }

/* ───────────────────────── Platform ───────────────────────── */
export interface RuleConfig extends Base {
  category: string; key: string; value: Json; effective_from: DateOnly; effective_to: DateOnly | null; source_name: string; source_ref: string; confidence: RuleConfidence; status: RuleStatus;
  is_active: boolean; max_severity: Severity; enforce_hard_stop: boolean; notes: string | null; updated_by: Uuid | null;
}
export interface Clock extends Base { entity_type: string; entity_id: Uuid; clock_type: ClockType; started_at: Iso; due_at: Iso; warn_at: Iso | null; status: ClockStatus; escalated_level: number; owner_id: Uuid | null; warned_at: Iso | null; breached_at: Iso | null; resolved_at: Iso | null; last_escalated_at: Iso | null; meta: Json }
export interface NotificationRow extends Base { user_id: Uuid | null; target_role: AppRole | null; kind: string; title: string; body: string | null; severity: NotificationSeverity; link: string | null; entity_type: string | null; entity_id: string | null; read_at: Iso | null }
export interface MessageTemplate extends Base { key: string; channel: MessageChannel; category: TemplateCategory; purpose: MessagePurpose; language: 'en' | 'hi' | 'gu'; subject: string | null; body: string; dlt_template_id: string | null; dlt_header: string | null; whatsapp_template_name: string | null; version: number; active: boolean }
export interface MessageLog extends BaseImmutable { lead_id: Uuid | null; channel: MessageChannel; purpose: MessagePurpose; category: TemplateCategory | null; template_key: string | null; direction: 'outbound' | 'inbound'; to_masked: string | null; body_preview: string | null; status: MessageStatus; block_reason: string | null; consent_id: Uuid | null; provider: string | null; provider_ref: string | null; created_by: Uuid | null }
export interface KpiSnapshot extends Base { kpi_key: string; period: string; value: number; dims: Json; computed_at: Iso }
export interface AuditLog extends BaseImmutable { actor_id: Uuid | null; action: string; table_name: string | null; record_id: string | null; old_data: Json | null; new_data: Json | null; detail: Json | null; source: 'trigger' | 'api'; request_id: string | null; ip: string | null }
export interface ComplianceCalendarItem extends Base { due_date: DateOnly; title: string; description: string | null; category: string; confidence: RuleConfidence; source_ref: string | null; escalate_days: number[]; rule_key: string | null; active: boolean }
export interface JobRun extends Base { job_name: string; started_at: Iso; finished_at: Iso | null; status: 'running' | 'ok' | 'failed'; details: Json }
export interface VerifyRegisterItem extends Base { code: string; title: string; detail: string; where_to_check: string; confidence: RuleConfidence; owner: string | null; status: 'open' | 'closed'; closing_source_url: string | null; closed_at: DateOnly | null }
export interface GateApplicability extends Base { gate: Gate; segment: Segment; applicability: Applicability; note: string | null }
export interface BreachIncident extends Base { title: string; description: string | null; detected_at: Iso; report_due_at: Iso; status: 'open' | 'reported' | 'closed'; evidence: { at: Iso; by: Uuid | null; note: string }[]; reported_at: Iso | null }
export interface DataRequest extends Base { lead_id: Uuid | null; customer_id: Uuid | null; kind: 'export' | 'erasure'; status: 'requested' | 'completed' | 'rejected'; requested_at: Iso; completed_at: Iso | null; notes: string | null }

/** Table name → row type */
export interface TableRowMap {
  organizations: Organization; profiles: Profile; discoms: Discom; territories: Territory; user_territories: UserTerritory; pincodes: Pincode;
  distributors: Distributor; dealers: Dealer; vendor_registrations: VendorRegistration; sop_cases: SopCase; distributor_score_history: DistributorScoreHistory;
  leads: Lead; lead_consents: LeadConsent; lead_events: LeadEvent; lead_assignments: LeadAssignment; followups: Followup; contact_logs: ContactLog; dnd_register: DndRegister; lead_scores: LeadScore; source_api_keys: SourceApiKey;
  customers: Customer; sites: Site; site_surveys: SiteSurvey; opportunities: Opportunity; requirement_forms: RequirementForm; segment_form_config: SegmentFormConfig; negotiation_logs: NegotiationLog;
  skus: Sku; sku_compliance: SkuCompliance; sku_prices: SkuPrice; stock_batches: StockBatch; inventory_serials: InventorySerial;
  quotations: Quotation; quotation_lines: QuotationLine; quote_discussions: QuoteDiscussion; approval_rules: ApprovalRule; approvals: Approval;
  proforma_invoices: ProformaInvoice; proforma_invoice_lines: ProformaInvoiceLine; payments: Payment; credit_checks: CreditCheck; credit_overrides: CreditOverride;
  sales_orders: SalesOrder; sales_order_lines: SalesOrderLine; dispatches: Dispatch; dispatch_serials: DispatchSerial; einvoice_status: EinvoiceStatus; documents: DocumentRow;
  loans: Loan; discom_applications: DiscomApplication; subsidy_claims: SubsidyClaim; installations: Installation; warranty_tickets: WarrantyTicket; dealer_receivables: DealerReceivable;
  rule_config: RuleConfig; clocks: Clock; notifications: NotificationRow; message_templates: MessageTemplate; message_log: MessageLog; kpi_snapshots: KpiSnapshot; audit_log: AuditLog;
  compliance_calendar_items: ComplianceCalendarItem; job_runs: JobRun; verify_register: VerifyRegisterItem; gate_applicability: GateApplicability; breach_incidents: BreachIncident; data_requests: DataRequest;
}
export type TableRow<K extends TableName> = TableRowMap[K];
