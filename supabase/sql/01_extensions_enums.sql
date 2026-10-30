-- =====================================================================================================
-- 01_extensions_enums.sql
-- Future Solar CRM - Postgres / Supabase schema
--
-- Purpose : extensions, the `app` helper schema, EVERY enum type, and the shared updated_at trigger function.
-- Run after: nothing - this is the first file. (Then 02, 03, ... 11, and finally 12.)
-- Idempotent: safe to re-run. Each `create type` is wrapped so an existing type is left untouched.
--
-- Contract: every enum below mirrors one `export const X = [...] as const` array in
--           packages/shared/src/enums.ts 1:1 (same values, same order). The SQL name is the snake_case
--           singular of the TypeScript constant (APP_ROLES -> app_role, LEAD_STATUSES -> lead_status, ...).
--           One deliberate exception: EINVOICE_STATUSES -> einvoice_state, because a TABLE called
--           einvoice_status exists and Postgres types and tables share one namespace.
--           `npm run check:sql` verifies the lists are identical.
--
-- Adding a value later: `alter type public.<name> add value if not exists '<new_value>';` (never remove
--           or rename values on a live database; create a new type and migrate instead).
-- =====================================================================================================

-- Extensions live in the `extensions` schema (Supabase convention; keeps `public` clean).
create schema if not exists extensions;
create extension if not exists pgcrypto  with schema extensions;   -- digest()/crypt() helpers; gen_random_uuid() is built into Postgres 13+
create extension if not exists pg_trgm    with schema extensions;   -- fuzzy lead-name duplicate detection (similarity, GIN trigram index)
create extension if not exists btree_gin  with schema extensions;   -- mixed scalar + array GIN indexes

-- `app` holds helper functions (session helpers, guards, RLS helpers). It is NOT exposed through the REST API
-- (only the `public` schema is), so these functions cannot be called by clients as RPC.
create schema if not exists app;
grant usage on schema app to authenticated, service_role;

-- -----------------------------------------------------------------------------------------------------
-- Shared trigger function: keep updated_at honest. Attached to every table that has an updated_at column
-- by 08_functions_triggers.sql.
-- -----------------------------------------------------------------------------------------------------
create or replace function app.set_updated_at() returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

-- -----------------------------------------------------------------------------------------------------
-- Enum types (67)
-- -----------------------------------------------------------------------------------------------------
-- AGREEMENT_STATUSES
do $$ begin
  create type public.agreement_status as enum ('pending', 'signed', 'not_required');
exception when duplicate_object then null;
end $$;

-- APPLICABILITIES
do $$ begin
  create type public.applicability as enum ('applies', 'not_applies', 'warning');
exception when duplicate_object then null;
end $$;

-- APPROVAL_DECISIONS
do $$ begin
  create type public.approval_decision as enum ('pending', 'approved', 'rejected', 'skipped');
exception when duplicate_object then null;
end $$;

-- APPROVAL_ENTITIES
do $$ begin
  create type public.approval_entity as enum ('quotation', 'proforma_invoice', 'sales_order', 'credit_override', 'compliance_override');
exception when duplicate_object then null;
end $$;

-- APPROVAL_LANES
do $$ begin
  create type public.approval_lane as enum ('commercial', 'compliance', 'credit');
exception when duplicate_object then null;
end $$;

-- APP_ROLES
do $$ begin
  create type public.app_role as enum ('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'distributor_user', 'dealer_user', 'techno_commercial', 'accounts', 'compliance_officer', 'dispatch', 'viewer');
exception when duplicate_object then null;
end $$;

-- ASSIGNMENT_STATUSES
do $$ begin
  create type public.assignment_status as enum ('pending', 'accepted', 'rejected', 'expired', 'reassigned');
exception when duplicate_object then null;
end $$;

-- CLOCK_STATUSES
do $$ begin
  create type public.clock_status as enum ('running', 'met', 'breached', 'cancelled');
exception when duplicate_object then null;
end $$;

-- CLOCK_TYPES
do $$ begin
  create type public.clock_type as enum ('lead_acceptance', 'followup', 'quote_followup', 'approval', 'discom_feasibility', 'discom_commissioning', 'cfa_release', 'legacy_cfa_claim_deadline', 'sop_reply', 'sop_show_cause', 'grievance', 'loan_ageing', 'warranty_rma', 'almm_exemption_commissioning', 'payment_reminder');
exception when duplicate_object then null;
end $$;

-- COMPLIANCE_STATUSES
do $$ begin
  create type public.compliance_status as enum ('pending', 'clear', 'warnings', 'blocked');
exception when duplicate_object then null;
end $$;

-- CONSENT_CHANNELS
do $$ begin
  create type public.consent_channel as enum ('call', 'sms', 'whatsapp', 'email');
exception when duplicate_object then null;
end $$;

-- CONSENT_PURPOSES
do $$ begin
  create type public.consent_purpose as enum ('service', 'promotional', 'quotation', 'subsidy_processing', 'financing');
exception when duplicate_object then null;
end $$;

-- CONTACT_CHANNELS
do $$ begin
  create type public.contact_channel as enum ('call', 'whatsapp', 'visit', 'sms', 'email');
exception when duplicate_object then null;
end $$;

-- CONTACT_OUTCOMES
do $$ begin
  create type public.contact_outcome as enum ('connected_interested', 'connected_not_now', 'connected_not_interested', 'no_answer', 'busy_call_back', 'wrong_number', 'message_delivered', 'message_replied', 'visit_done', 'visit_rescheduled');
exception when duplicate_object then null;
end $$;

-- COST_BEARERS
do $$ begin
  create type public.cost_bearer as enum ('distributor', 'dealer', 'brand', 'consumer', 'unknown');
exception when duplicate_object then null;
end $$;

-- CREDIT_RESULTS
do $$ begin
  create type public.credit_result as enum ('pending', 'approved', 'rejected');
exception when duplicate_object then null;
end $$;

-- CUSTOMER_TYPES
do $$ begin
  create type public.customer_type as enum ('residential', 'housing_society', 'commercial', 'industrial', 'farmer', 'government');
exception when duplicate_object then null;
end $$;

-- DISPATCH_STATUSES
do $$ begin
  create type public.dispatch_status as enum ('planned', 'blocked', 'ready', 'dispatched', 'delivered', 'cancelled');
exception when duplicate_object then null;
end $$;

-- DND_STATUSES
do $$ begin
  create type public.dnd_status as enum ('unchecked', 'clear', 'registered', 'blocked');
exception when duplicate_object then null;
end $$;

-- DOCUMENT_BUCKETS
do $$ begin
  create type public.document_bucket as enum ('lead-docs', 'site-photos', 'quote-pdfs', 'compliance-docs', 'invoices');
exception when duplicate_object then null;
end $$;

-- EINVOICE_STATUSES
do $$ begin
  create type public.einvoice_state as enum ('not_required', 'manual_pending', 'generated', 'failed');
exception when duplicate_object then null;
end $$;

-- FEASIBILITY_STATUSES
do $$ begin
  create type public.feasibility_status as enum ('not_required', 'pending', 'deemed', 'approved', 'rejected');
exception when duplicate_object then null;
end $$;

-- FOLLOWUP_KINDS
do $$ begin
  create type public.followup_kind as enum ('call', 'whatsapp', 'visit', 'email', 'task');
exception when duplicate_object then null;
end $$;

-- FOLLOWUP_STATUSES
do $$ begin
  create type public.followup_status as enum ('open', 'done', 'missed', 'cancelled');
exception when duplicate_object then null;
end $$;

-- GATES
do $$ begin
  create type public.gate as enum ('G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10', 'G11', 'G12', 'G13', 'G14');
exception when duplicate_object then null;
end $$;

-- INSTALLATION_STATUSES
do $$ begin
  create type public.installation_status as enum ('planned', 'installed', 'certified', 'commissioned');
exception when duplicate_object then null;
end $$;

-- LEAD_SOURCES
do $$ begin
  create type public.lead_source as enum ('website', 'call_centre', 'whatsapp', 'campaign', 'referral', 'dealer_upload', 'manual');
exception when duplicate_object then null;
end $$;

-- LEAD_STATUSES
do $$ begin
  create type public.lead_status as enum ('new', 'validated', 'duplicate', 'merged', 'unassigned', 'assigned', 'accepted', 'contacted', 'qualified', 'site_visit', 'nurture', 'opportunity', 'lost', 'won');
exception when duplicate_object then null;
end $$;

-- LOAN_REJECTION_CODES
do $$ begin
  create type public.loan_rejection_code as enum ('name_mismatch', 'arrears', 'land_title', 'collateral_demanded', 'missing_documents', 'other');
exception when duplicate_object then null;
end $$;

-- LOAN_STATUSES
do $$ begin
  create type public.loan_status as enum ('draft', 'applied', 'in_review', 'approved', 'rejected', 'disbursed', 'withdrawn');
exception when duplicate_object then null;
end $$;

-- LOCK_STATUSES
do $$ begin
  create type public.lock_status as enum ('open', 'locked', 'override_pending');
exception when duplicate_object then null;
end $$;

-- MESSAGE_CHANNELS
do $$ begin
  create type public.message_channel as enum ('whatsapp', 'sms', 'email', 'call', 'in_app');
exception when duplicate_object then null;
end $$;

-- MESSAGE_PURPOSES
do $$ begin
  create type public.message_purpose as enum ('promotional', 'service', 'transactional');
exception when duplicate_object then null;
end $$;

-- MESSAGE_STATUSES
do $$ begin
  create type public.message_status as enum ('queued', 'sent', 'blocked', 'failed');
exception when duplicate_object then null;
end $$;

-- NOTIFICATION_SEVERITIES
do $$ begin
  create type public.notification_severity as enum ('info', 'success', 'warning', 'critical');
exception when duplicate_object then null;
end $$;

-- OPPORTUNITY_STAGES
do $$ begin
  create type public.opportunity_stage as enum ('qualified', 'quotation', 'negotiation', 'pi_stage', 'won', 'lost');
exception when duplicate_object then null;
end $$;

-- PARTY_STATUSES
do $$ begin
  create type public.party_status as enum ('onboarding', 'active', 'on_hold', 'inactive');
exception when duplicate_object then null;
end $$;

-- PAYMENT_KINDS
do $$ begin
  create type public.payment_kind as enum ('advance', 'balance', 'loan_disbursal', 'subsidy');
exception when duplicate_object then null;
end $$;

-- PAYMENT_MODES
do $$ begin
  create type public.payment_mode as enum ('upi', 'neft_rtgs', 'cheque', 'cash', 'card', 'loan', 'other');
exception when duplicate_object then null;
end $$;

-- PHASES
do $$ begin
  create type public.phase as enum ('single', 'three');
exception when duplicate_object then null;
end $$;

-- PI_STATUSES
do $$ begin
  create type public.pi_status as enum ('draft', 'pending_approval', 'issued', 'partially_paid', 'paid', 'cancelled');
exception when duplicate_object then null;
end $$;

-- PORTAL_STATUSES
do $$ begin
  create type public.portal_status as enum ('active', 'deactivated', 'under_sop');
exception when duplicate_object then null;
end $$;

-- QUOTE_STATUSES
do $$ begin
  create type public.quote_status as enum ('draft', 'blocked', 'price_review', 'pending_approval', 'approved', 'sent', 'negotiation', 'accepted', 'rejected', 'revised', 'requote_required', 'expired');
exception when duplicate_object then null;
end $$;

-- RECEIVABLE_STATUSES
do $$ begin
  create type public.receivable_status as enum ('open', 'paid', 'overdue', 'written_off');
exception when duplicate_object then null;
end $$;

-- ROOF_OWNERSHIPS
do $$ begin
  create type public.roof_ownership as enum ('owned', 'rented', 'society', 'leased', 'government');
exception when duplicate_object then null;
end $$;

-- ROOF_TYPES
do $$ begin
  create type public.roof_type as enum ('rcc', 'metal_sheet', 'asbestos', 'tile', 'ground_mount', 'other');
exception when duplicate_object then null;
end $$;

-- RULE_CONFIDENCES
do $$ begin
  create type public.rule_confidence as enum ('high', 'medium', 'low', 'hypothesis');
exception when duplicate_object then null;
end $$;

-- RULE_STATUSES
do $$ begin
  create type public.rule_status as enum ('verified', 'unverified', 'conflicting');
exception when duplicate_object then null;
end $$;

-- SCHEME_ROUTES
do $$ begin
  create type public.scheme_route as enum ('pmsg', 'rwa_ghs', 'kusum', 'net_metering', 'open_access', 'captive', 'government_bid', 'other');
exception when duplicate_object then null;
end $$;

-- SECURITY_TYPES
do $$ begin
  create type public.security_type as enum ('pdc', 'bank_guarantee', 'cheque', 'none');
exception when duplicate_object then null;
end $$;

-- SEGMENTS
do $$ begin
  create type public.segment as enum ('pmsg_residential', 'rwa_ghs', 'ci_captive', 'ci_net_metered', 'open_access', 'pm_kusum', 'government_bid');
exception when duplicate_object then null;
end $$;

-- SERIAL_STATUSES
do $$ begin
  create type public.serial_status as enum ('in_stock', 'reserved', 'dispatched', 'installed', 'rma');
exception when duplicate_object then null;
end $$;

-- SEVERITIES
do $$ begin
  create type public.severity as enum ('info', 'warning', 'hard_stop');
exception when duplicate_object then null;
end $$;

-- SITE_CATEGORIES
do $$ begin
  create type public.site_category as enum ('general', 'sc', 'st');
exception when duplicate_object then null;
end $$;

-- SKU_CATEGORIES
do $$ begin
  create type public.sku_category as enum ('module', 'inverter', 'structure', 'battery', 'cable', 'other');
exception when duplicate_object then null;
end $$;

-- SOP_STAGES
do $$ begin
  create type public.sop_stage as enum ('reply', 'reminder', 'show_cause', 'deactivation', 'appeal', 'closed');
exception when duplicate_object then null;
end $$;

-- SO_STATUSES
do $$ begin
  create type public.so_status as enum ('draft', 'on_hold', 'pending_approval', 'approved', 'dispatch_planning', 'partially_dispatched', 'dispatched', 'closed', 'cancelled');
exception when duplicate_object then null;
end $$;

-- SUBSIDY_COHORTS
do $$ begin
  create type public.subsidy_cohort as enum ('legacy', 'current');
exception when duplicate_object then null;
end $$;

-- SUBSIDY_REJECTION_REASONS
do $$ begin
  create type public.subsidy_rejection_reason as enum ('bank_proof_invalid', 'photos_unclear', 'inspection_pending', 'dcr_mismatch', 'name_mismatch', 'duplicate_claim', 'deadline_missed', 'other');
exception when duplicate_object then null;
end $$;

-- SUBSIDY_STATUSES
do $$ begin
  create type public.subsidy_status as enum ('not_ready', 'ready', 'claimed', 'released', 'rejected');
exception when duplicate_object then null;
end $$;

-- SURVEY_STATUSES
do $$ begin
  create type public.survey_status as enum ('scheduled', 'completed', 'cancelled');
exception when duplicate_object then null;
end $$;

-- TEMPERATURES
do $$ begin
  create type public.temperature as enum ('hot', 'warm', 'cold');
exception when duplicate_object then null;
end $$;

-- TEMPLATE_CATEGORIES
do $$ begin
  create type public.template_category as enum ('marketing', 'utility', 'authentication', 'service');
exception when duplicate_object then null;
end $$;

-- TIMELINE_BUCKETS
do $$ begin
  create type public.timeline_bucket as enum ('immediate', 'within_30_days', 'one_to_three_months', 'three_to_six_months', 'six_months_plus', 'unknown');
exception when duplicate_object then null;
end $$;

-- VENDOR_LEVELS
do $$ begin
  create type public.vendor_level as enum ('state', 'multi_state', 'national');
exception when duplicate_object then null;
end $$;

-- WARRANTY_STATUSES
do $$ begin
  create type public.warranty_status as enum ('open', 'inspected', 'sent_to_brand', 'replaced', 'rejected', 'closed');
exception when duplicate_object then null;
end $$;

-- WARRANTY_TYPES
do $$ begin
  create type public.warranty_type as enum ('warranty', 'rma', 'om_visit', 'complaint');
exception when duplicate_object then null;
end $$;
