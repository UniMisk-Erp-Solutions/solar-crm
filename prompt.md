MASTER BUILD PROMPT — Future Solar CRM (React + Node.js + Supabase)

Paste everything below the line into Claude Code (or any coding agent with file and shell access) from an empty repository folder. Everything above the line is a note for you and is not part of the prompt.

Before you run it: the prompt tells the agent to write all SQL to /supabase/sql/ and never to execute it. You run the files manually in the Supabase SQL editor, in numeric order, after the code is finished.

ROLE AND OPERATING RULES

You are a senior full-stack engineer and solution architect. Build, end to end and in one run, a production-grade Solar Lead-to-Order CRM for the Indian market using React (Vite + TypeScript), Node.js (Express + TypeScript) and Supabase (Postgres, Auth, Storage). Do not stop to ask questions. Where something is ambiguous, take the most reasonable reading, record it in /docs/ASSUMPTIONS.md, and continue.

Hard rules:

Never run SQL against any database. Write all SQL as numbered files in /supabase/sql/ (order and contents in Section 5). The owner will run them manually in the Supabase SQL editor after the code is finished. Do not use the Supabase CLI to push migrations. Do not call any live Supabase project.
No placeholders, no "TODO: implement", no stub screens. Every screen, endpoint, engine and job listed below must exist and work against the schema. The only permitted stubs are the external-provider adapters in Section 12, and those must still have a working mock implementation and a typed interface.
Never invent regulatory facts. Every legal or policy value (dates, rates, thresholds, clock lengths, scheme amounts) lives in the rule_config table (Section 6) with a source, confidence and status. Values marked unverified are seeded with is_active = false and must not block or alter any transaction until a compliance user activates them in the Admin UI. Do not hard-code any such value in application code.
No secrets in the repo. Provide .env.example files only. The service-role key is used only by the Node API, never by the browser.
Do not store Aadhaar numbers or Aadhaar images anywhere (database, storage, logs). Enforce this in validation (Section 13).
Work in the phases of Section 17, run lint, type-check and tests after each phase, and fix failures before moving on. Finish with the deliverables in Section 18.
Use em dashes and an Indian professional register in user-facing copy. Currency in INR with Indian digit grouping (₹ 12,34,567). Dates as DD-MMM-YYYY. Time zone Asia/Kolkata.
1. PRODUCT CONTEXT

The tenant is Future Solar, a solar brand that sells through distributors, who sell through dealers/installers, to end customers (residential, housing societies, commercial and industrial, farmers). The CRM must implement the following reference flow exactly, and extend it with the Indian regulatory and commercial controls in Sections 6 to 9.

1.1 Reference flow (six stages, 34 numbered steps) — implement all of it
Stage	Steps
1. Inquiry capture and allocation	1 Inquiry captured (Website / Call / WhatsApp / Campaign / Referral) → 2 Validate and de-duplicate (mobile and email validity, duplicate check, existing customer check) → 3 Capture details (pincode, city, state, MW scale, customer type, product interest) → 4 Territory and capability match (territory, MW capacity, product capability, distributor score) → decision Distributor available and eligible? YES → 5 Auto-assign to distributor / DSM → 7 Lead acceptance by distributor → decision Accepted within SLA? YES → Lead accepted. NO → Reminder and escalation loop (Reminder 1, DSM alert, auto-reassignment). Not eligible → 6 Escalate to DSM / reassign territory.
2. Follow-up and lead classification	8 Initial customer contact → 9 Qualification call (requirement, timeline, budget, decision maker) → 10 Lead temperature (COLD: long-term / low urgency; WARM: 1–3 months; HOT: 0–30 days / immediate) → 11 Lead quality score (requirement, MW, timeline, budget, decision maker) → 12 CRM follow-up engine → 13 Auto reminders and notifications → decision Next action completed on time? YES → On track; NO → escalation to DSM / Sales Manager. Mandatory fields on every lead: Last Action, Next Action, Next Follow-up Date, Owner.
3. Site visit and opportunity development	14 Customer site visit → 15 Requirement capture form (site, MW, load type, timeline, specs, documents) → 16 Product recommendation and brand USP (quality, warranty, certifications, service support, delivery reliability) → 17 Technical discussion and solution fit → 18 Rate negotiation with end customer → decision Qualified project / real opportunity? YES → 19 Convert to opportunity in CRM → 20 Update opportunity (probability %, expected MW, revenue, closing date, competitor). NO → Nurture / recycle lead. Work instruction: do not convert to an opportunity unless requirement, timeline and commercial potential are confirmed.
4. Quotation and approval	21 Prepare techno-commercial offer / quotation → 22 Internal price review → decision Special pricing / discount needed? YES → 23 Approval matrix (DSM, Regional Head, Management) → 24 Send quotation to customer → 25 Customer discussion / negotiation → decision Quotation accepted? YES → 27 Commercial terms confirmed. NO → 26 Revise quote / follow-up (loops back to 21). Quote follow-up cadence: Day 1, Day 3, Day 5, Day 7, then escalation.
5. PI, payment and sales order	28 Prepare proforma invoice → 29 PI approval and issue → 30 Payment / credit verification → decision Advance received OR credit approved? YES → 31 Customer PO / order confirmation → 32 Create sales order → 33 SO approval and stakeholder circulation → 34 Hand over to dispatch planning. NO → SO on hold / reminder to customer. Work instruction: before PI, confirm legal name, billing and shipping address, GST, product, quantity, price, freight, payment terms.
6. Controls, escalation and KPIs	Escalation matrix across Distributor → DSM → Sales Manager → Management for: unaccepted lead, overdue follow-up, pending approval, pending payment / credit, no customer response. Conversion gates: Valid Lead → Qualified Lead → Opportunity → Quotation → PI → Sales Order. KPIs: Inquiry→Qualified Lead, Qualified Lead→Opportunity, Opportunity→Quotation, Quotation→PI, PI→Sales Order, First-response SLA, Follow-up compliance. All activities must be logged in the CRM with accurate data.

SLAs from the reference chart (make them configurable in rule_config, category sla):

Lead acceptance: HOT 15–30 min, WARM within 2 hrs, COLD same working day. Escalation path: Reminder 1 → DSM alert → auto-reassignment.
Follow-up: HOT same day / daily, WARM every 2–5 days, COLD weekly / nurture.
Quote follow-up: Day 1, 3, 5, 7, then escalation.

Ownership legend (use these as role groups and colour-code stages): System/CRM; Distributor/DSM; End Customer; Sales/Techno-Commercial; Management/Sales Ops/Accounts.

1.2 Extensions required for the Indian market (the generic flow stops at dispatch; real work does not)

Add these stages after dispatch and these gates before it. All are specified in later sections:

Stage 0 — Lead capture with consent and provenance (consent ledger, DND scrub, WhatsApp opt-in, named recipients).
Segmentation fork — PMSG residential, RWA/GHS, C&I captive, net-metered C&I, open access, PM-KUSUM, government/bid — each with its own rule pack.
Bill, load and ownership capture and DISCOM feasibility tracking.
Product compliance validation (ALMM List-I model, List-II cells, DCR, BIS) at quote time.
Quote price-lock, GST line logic and re-quote engine.
Loan and subsidy tracking, vendor-of-record tracking, dealer credit and subsidy-linked receivables.
Serial-number dispatch, installation and DISCOM commissioning clocks, subsidy claim, warranty / RMA / 5-year O&M, channel scorecards, compliance calendar.
2. TECH STACK AND REPOSITORY LAYOUT (use exactly this)

Frontend: React 18, Vite, TypeScript (strict), React Router 6, TanStack Query 5, React Hook Form + Zod, Tailwind CSS, shadcn/ui-style components built locally, Recharts, date-fns, react-i18next, @dnd-kit (kanban), TanStack Table. Supabase JS used only for auth (sign-in, session, password reset). All data calls go to the Node API with the user's JWT.

Backend: Node 20, Express, TypeScript (strict), Zod validation on every route, @supabase/supabase-js with the service-role key, pino logging, helmet, cors, express-rate-limit, node-cron, multer (memory storage, then upload to Supabase Storage), exceljs (exports), pdfkit (quote and PI PDFs), vitest + supertest.

Database: Supabase Postgres. Manual SQL files only.

/
├─ apps/
│  ├─ web/            # React app
│  └─ api/            # Express API
├─ packages/
│  └─ shared/         # Zod schemas, enums, types shared by web and api
├─ supabase/
│  └─ sql/            # 01_… to 12_… manual SQL files (Section 5)
├─ docs/              # ASSUMPTIONS.md, ARCHITECTURE.md, API.md, RULES.md, RUNBOOK.md, VERIFY_BEFORE_RELYING.md
├─ .env.example
├─ package.json       # npm workspaces
└─ README.md

Provide npm run dev (web + api concurrently), npm run build, npm run test, npm run lint, npm run typecheck.

3. ROLES AND ACCESS

Roles (enum app_role): admin, management, regional_head, sales_manager, dsm, distributor_user, dealer_user, techno_commercial, accounts, compliance_officer, dispatch, viewer.

Every table has org_id. A user belongs to one org, has one role, and optionally a distributor_id and/or dealer_id (external users are scoped to their own party).
distributor_user sees only leads, opportunities, quotes, orders and dealers of their distributor. dealer_user sees only their own. Internal roles see the whole org, subject to territory_ids if set on the profile.
Approvals: discount approval lane (DSM → Regional Head → Management), compliance lane (compliance_officer), credit lane (accounts).
Enforce access in both the Node API (middleware: authenticate JWT → load profile → authorise by role and scope) and Postgres RLS (defence in depth). The API uses the service role, so its authorisation middleware is the primary control and must be unit-tested.
4. CORE DOMAIN MODEL (summary — full DDL goes in the SQL files)

Create the following tables with primary keys (uuid default gen_random_uuid()), org_id, created_at, updated_at, created_by, soft-delete where noted, and sensible indexes and foreign keys. Use Postgres enums for all status fields.

Identity and org: organizations, profiles, territories (state, district, pincode ranges, discom_id), discoms (code, name, state; seed Gujarat: UGVCL, DGVCL, MGVCL, PGVCL, plus Torrent Power as a licensee), user_territories.

Parties: distributors (legal name, GSTIN, PAN, MW capacity band, product capability tags, score, status, credit terms), dealers (distributor_id, legal name, GSTIN, territory, credit_limit, security type/amount, status), vendor_registrations (party_id, level state|multi_state|national, portal vendor id, districts, bank guarantee amount and valid-till, portal status active|deactivated|under_sop, deactivation dates, complaint count), distributor_score_history.

Lead layer: leads (source, source_ref, name, mobile, email, pincode, city, state, district, segment, customer_type, mw_scale, product_interest, status, temperature, quality_score, owner_id, distributor_id, dealer_id, last_action, next_action, next_followup_at, accepted_at, sla_due_at, language, lock_status, duplicate_of), lead_consents (notice_version, purposes[], channels[], recipients_named[], granted_at, ip, user_agent, proof_ref, withdrawn_at, optout_suppress_until), lead_events (immutable timeline), lead_assignments, followups, dnd_register (mobile hash, status, checked_at), lead_scores (components jsonb).

Customer and site: customers (legal name, GSTIN, PAN, billing/shipping addresses), sites (name as on DISCOM bill, consumer_no, discom_id, sanctioned_load_kw, contracted_demand_kva, phase, geo lat/lng, roof_ownership, title_ok, pending_dues flag, existing_solar_kw, category general|sc|st, special_category_state flag), site_surveys (date, photos[], shading, roof_type, sld_ref, notes, feasibility_application_submitted_at, feasibility_application_complete_at).

Opportunity: opportunities (lead_id, customer_id, site_id, segment, kw, scheme_route, funding_mix jsonb, probability, expected_value, expected_close_date, expected_commissioning_date, competitor, regulation_version, exemption_reliance boolean, requirement_confirmed, timeline_confirmed, commercial_potential_confirmed, stage, lost_reason), requirement_forms.

Catalogue and stock: skus (category module|inverter|structure|battery|cable|other, make, model, variant, wattage, hsn, uom, active), sku_compliance (sku_id, almm_list1 bool, almm_list1_ref, almm_list1_valid_till, almm_snapshot_date, cell_maker, almm_list2 bool, dcr_verified bool, cell_origin, bis_licence_no, bis_licensed_model, bis_standard_no, bis_valid_till, inverter_kw, self_certified bool, thin_film bool, verified_by, verified_at), sku_prices (price snapshot: base, valid_from, valid_to, landed cost components jsonb: bcd, aidc, sws, adc, freight), stock_batches, inventory_serials (serial, sku_id, batch_id, status in_stock|reserved|dispatched|installed|rma, quote_id/so_id reservation, ALMM/DCR/BIS status snapshot at receipt, invoice chain ids).

Quote, approval, order: quotations (version, parent_quote_id, opportunity_id, status, validity_date, price_snapshot_at, tax_position_approved, clause_set jsonb, totals, cfa_entitlement, state_share, loan_share, consumer_share, compliance_status, compliance_findings jsonb), quotation_lines, approval_rules (lane, threshold, role chain), approvals (entity, lane, step, approver, decision, comment, decided_at), proforma_invoices (+ lines; funding split consumer/loan/subsidy; pre-PI checklist jsonb), payments, credit_checks, sales_orders (+ lines), dispatches (+ serial links), einvoice_status (IRN placeholder fields, status), documents (entity, storage path, type, uploaded_by).

Post-sale: loans (bank, application_date, status, rejection_code, co_applicant, document_checklist jsonb), discom_applications (submitted_at, complete_at, feasibility_due_at, inspection_at, meter_type, meter_at, commissioning_at, agreement_status), subsidy_claims (cfa_computed, state_share, claim_at, e_token, bank_proof_ok, released_at, rejection_reason, cohort legacy|current), installations (installer/vendor of record, install_date, certificate_at, geo photos[], warranty_end, om_end), warranty_tickets (serial, type, brand_claim_no, cost_bearer, sop_clock fields, status), dealer_receivables (dealer_id, doc ref, amount, due_date, subsidy_linked boolean, linked_project_id, status).

Platform: rule_config, clocks (generic timer table), notifications, message_templates, message_log, kpi_snapshots, audit_log (immutable, trigger-written), compliance_calendar_items, job_runs.

Create these views for dashboards: v_funnel, v_lead_sla_breaches, v_followup_overdue, v_discom_stage_ageing, v_cfa_pending, v_dealer_exposure (limit, outstanding, ageing buckets, subsidy-linked exposure, DSO), v_stock_exposure_non_list2, v_compliance_block_rate, v_consent_coverage.

5. SQL FILES TO PRODUCE (never execute them)

Write these in /supabase/sql/, each idempotent where practical (create … if not exists, drop policy if exists before create), with a header comment stating purpose and "run after file N".

File	Contents
01_extensions_enums.sql	pgcrypto, pg_trgm, btree_gin; all enums; helper set_updated_at() trigger function
02_core_tables.sql	org, profiles, territories, discoms, distributors, dealers, vendor_registrations
03_lead_tables.sql	leads, consents, events, assignments, followups, dnd, scores, customers, sites, surveys
04_opportunity_catalogue.sql	opportunities, requirement forms, skus, sku_compliance, sku_prices, stock, serials
05_commercial_tables.sql	quotes, lines, approval rules, approvals, PI, payments, credit checks, SO, dispatch, einvoice, documents
06_postsale_tables.sql	loans, discom applications, subsidy claims, installations, warranty tickets, dealer receivables
07_platform_tables.sql	rule_config, clocks, notifications, templates, message_log, kpi_snapshots, audit_log, calendar items, job_runs
08_functions_triggers.sql	updated_at triggers; audit trigger on all business tables; lead_events auto-insert on status change; duplicate-detection function (normalised mobile, e-mail, pg_trgm similarity on name + pincode); compute_lead_score(lead_id); next_working_time(ts, hours); guard trigger blocking opportunity creation unless requirement_confirmed AND timeline_confirmed AND commercial_potential_confirmed; guard trigger blocking sales_orders insert when the dealer is over limit or portal_status = 'deactivated' unless an approved credit override exists; guard blocking dispatches for serials whose compliance snapshot is non-compliant for the order's segment
09_rls_policies.sql	helper functions app.current_org(), app.current_role(), app.current_distributor(), app.current_dealer(); enable RLS on every table; policies per Section 3; audit_log and lead_events insert-only
10_views.sql	the views in Section 4
11_storage_buckets.sql	private buckets lead-docs, site-photos, quote-pdfs, compliance-docs, invoices with policies scoped by org_id/ path prefix
12_seed_reference.sql	org row template, discoms, roles reference, SLA and approval-rule seeds, rule_config seeds from Section 6, message templates, compliance calendar items from Section 6.4, demo SKU rows flagged demo = true, and a demo dataset (20 leads across segments, 3 distributors, 8 dealers) wrapped in a clearly marked block the owner can delete

Also write /supabase/sql/RUN_ORDER.md explaining: run 01 → 12 in order; create the first admin by signing up in Supabase Auth, then run the supplied one-line insert into profiles … snippet with their user UUID; how to rotate keys; how to delete the demo block.

6. CONFIGURABLE RULE ENGINE (the heart of the system)
6.1 rule_config table

Columns: id, org_id, category, key, value jsonb, effective_from, effective_to, source_name, source_ref, confidence (high|medium|low|hypothesis), status (verified|unverified|conflicting), is_active boolean, notes, updated_by, updated_at. Versioned by effective_from: the engine always resolves the value in force on a given reference date (commissioning date for compliance gates, quote date for pricing, today for SLAs). Admin UI (Section 11) lets a compliance_officer edit, activate, deactivate and add new effective-dated versions, with a mandatory source reference. Every change is audited.

Rule: a rule with status ≠ verified or is_active = false is advisory only — it may produce a warning but never a hard stop, unless a compliance officer explicitly activates it as a hard stop.

6.2 Seed values (set is_active = true only where the status is "verified-ish" below; everything else false)

These come from a research report dated 26-Oct-2026 whose sources were mostly trade press. Seed them with the confidence shown and put the text "Verify against primary source before relying" in notes.

Category / key	Value	Confidence	Seed active?
sla.lead_acceptance_minutes.hot	30 (range 15–30)	from reference chart	yes
sla.lead_acceptance_minutes.warm	120	from reference chart	yes
sla.lead_acceptance.cold	next working day end	from reference chart	yes
sla.followup_days.hot / warm / cold	1 / 2–5 (use 3) / 7	from reference chart	yes
sla.quote_followup_days	[1,3,5,7] then escalate	from reference chart	yes
pmsg.cfa.per_kw_first_2kw	30000	high	yes
pmsg.cfa.third_kw	18000	high	yes
pmsg.cfa.max_total	78000	high	yes
pmsg.cfa.max_kw_eligible	3	high	yes
pmsg.cfa.special_category.per_kw_first_2kw / third_kw	33000 / 19800	high	yes
pmsg.benchmark_cost.first_2kw / additional	50000 / 45000 per kW	high	yes
rwa_ghs.cfa_per_kw	18000 (cap 500 kW; 3 kW per house)	high	yes
pmsg.dcr_required_for_cfa	true	high	yes (hard stop G2)
pmsg.vendor_bg.national / per_state	25,00,000 / 2,50,000; validity ≥ 5 years	medium	yes (warning only)
pmsg.claim_deadline.legacy_cohort	2026-11-30	medium (OM not read)	yes (warning/countdown only)
pmsg.programme_end	2027-03-31	medium (press)	yes (informational)
discom.feasibility_study_exempt_up_to_kw	10	high	yes
discom.feasibility_study_days_above_10kw	15 (deemed feasible on silence)	high	yes
discom.commissioning_days	15 from installation-certificate submission	medium	yes
pmsg.cfa_release_days_after_discom_approval	15 (policy statement; field reality slower)	medium	yes
pmsg.grievance_days	30	high (clause exists)	yes
mnre_sop.vendor_reply_days / reminder / show_cause	8 / 15 / 15; deactivation 1 month; appeal 30 days	high per trade press	yes (tracker only)
almm.list2.effective_date	2026-06-01	high	yes
almm.list2.exemption_net_metering_open_access_until	2026-12-31 (commissioning date)	high on date and scope	yes (hard stop G5)
almm.list2.bid_date_carveout	conflict: 2024-12-09 vs 2025-08-31	low	no — status = conflicting
almm.list3.effective_date	2028-06-01	medium-high	informational
almm.captive_behind_meter_exempt	true (definition unverified)	medium	yes (warning only)
bis.inverter_self_cert_above_kw	200 until 2026-12-31	medium-high	yes (warning, becomes stop after date if activated)
bis.module_standard_no	conflict: IS 14286 vs IS 14086	low	no — status = conflicting
gst.modules_cells_rate	5% from 2025-09-22	high	yes
gst.inverter_rate	disputed: 5% vs 18%	low	no — status = conflicting; quote lines for inverters require explicit CA tax-position approval
gst.structures / batteries	18% (vendor blog)	low	no
gst.works_contract_split_70_30	vendor blog	low	no
customs.adc_on_cells_modules (ADD)	DGTR recommended; notification unconfirmed	low	no — default off
customs.modules.bcd / aidc	20% / 20% + SWS (blog)	medium	no (landed-cost helper only)
loan.interest_rate_display	conflict: 7% vs 5.75%	low	no — loan rate is a free input with source date
trai.promotional_series / header_suffix	conflict (140 series; 1600 vs 160; -P vs -F)	low	no — configurable
trai.optout_reconsent_block_days	90	high	yes
trai.transactional_consent_days	7	high	yes
whatsapp.service_window_hours	24	high	yes
whatsapp.click_to_whatsapp_free_window_days	up to 7	high	yes
dpdp.consent_manager_registration_date	2026-11-13	high	calendar only
dpdp.core_duties_date	2027-05-13 (compression to 12 months proposed, not notified as of 08-Oct-2026)	high	calendar only
dpdp.breach_report_hours	72	medium	yes
dpdp.audit_log_retention_days	365	medium	yes
kusum.componentB_cpump_commissioning_deadline	2026-09-30 (passed; later extension unverified)	medium	calendar only
kusum.componentAC_commissioning_deadline	2027-03-31	medium	calendar only
gujarat.state_subsidy	unverified; no GR found	low	no — modelled as an empty configurable "state scheme" object
gujarat.net_metering.surplus_rate / delay_compensation	vendor blog	low	no
gujarat.open_access.additional_surcharge_per_kwh	1.00 for 2025-10-01 to 2026-03-31; later unknown	medium	no (expired period)
channel.margins / credit_days / conversion_rates	hypotheses from one vendor blog	hypothesis	never seeded as rules
6.3 Rule resolution API

ruleService.get(category, key, referenceDate) returns { value, status, confidence, isActive, source }. Every gate result stores the exact rule_config.ids it used (in compliance_findings) so any decision can be reproduced later.

6.4 Compliance calendar (seed in compliance_calendar_items, show on dashboard with countdown and confidence tag)

13-Nov-2026 DPDP Consent Manager registration — 30-Nov-2026 CFA claim deadline, legacy cohort — 31-Dec-2026 ALMM List-II exemption ends (commissioning) — 31-Dec-2026 BIS inverter >200 kW self-certification ends unless extended — 31-Dec-2026 WhatsApp India INR billing migration — 31-Mar-2027 PMSG programme end and KUSUM A/C commissioning — 13-May-2027 DPDP core duties — 01-Jun-2028 ALMM List-III. Countdown escalation notifications at D-14, D-7, D-3 for the first three.

7. THE COMPLIANCE ENGINE

Implement complianceService.evaluateQuote(quoteId) and evaluateDispatch(soId) returning a list of findings { gate, severity: 'hard_stop'|'warning'|'info', message, ruleIds[], fieldRefs[] }. A quote cannot move to sent and an SO cannot be dispatched while any hard_stop exists. Overrides require the compliance lane approval with a written reason, stored and audited.

Gates (all evaluated against the project segment, the expected commissioning date and the rule versions in force):

Gate	Condition	Severity (if its rule is active and verified)
G1	Outbound promotional message without valid consent, or DND scrub missing / stale, or within 90-day opt-out suppression	hard stop
G2	PMSG or KUSUM quote containing a non-DCR-verified module SKU	hard stop
G3	ALMM-applicable project (net-metered, open access, subsidy, government) with a module whose model is not ALMM List-I	hard stop
G4	Subsidy or government project with cells not on ALMM List-II (commissioning on/after List-II effective date)	hard stop
G5	Net-metering / open-access job relying on the List-II exemption with expected commissioning after 2026-12-31	hard stop (or approval override)
G6	BIS licence missing, expired, or licensed model ≠ quoted model	hard stop
G7	Inverter > 200 kW on self-certification after the configured end date	warning, hard stop after date
G8	Quote validity date later than the price/duty horizon (price snapshot age, exemption date)	warning
G9	GST rate or HSN missing, or line's tax position not approved by a CA user (mandatory for inverters and bundled lines)	warning; hard stop for inverter lines while the inverter rule is conflicting
G10	ALMM snapshot older than N days (config, default 7)	warning
G11	Dealer over credit limit, or vendor registration deactivated / under_sop	hard stop on SO creation
G12	Name on DISCOM bill ≠ applicant name, or pending dues flag	warning
G13	PMSG system above 3 kW	warning (no CFA beyond 3 kW)
G14	Any Aadhaar number or image uploaded or typed into a free-text field	hard stop (policy)

Include a segment applicability matrix (rule table gate_applicability: gate × segment → applies / not applies / warning) so, for example, captive behind-the-meter jobs skip G3/G4 with a warning.

Re-quote engine: a nightly job and on-change hooks detect changes in rule_config (GST, duty, ALMM list, exemption dates), sku_compliance or sku_prices; flag all open quotes that depend on the changed value as requote_required, notify the owner, and show an exposure report of open quotes by SKU.

8. THE CLOCK ENGINE

Table clocks (entity_type, entity_id, clock_type, started_at, due_at, status running|met|breached|cancelled, warn_at, escalated_level). Clock types and their start triggers: lead_acceptance, followup, quote_followup, approval, discom_feasibility (starts when the application is complete; stores both submitted and complete dates), discom_commissioning (from installation-certificate submission), cfa_release (from DISCOM approval), legacy_cfa_claim_deadline, sop_reply, sop_show_cause, grievance, loan_ageing, warranty_rma, almm_exemption_commissioning. Lengths come from rule_config. A cron job runs every minute (node-cron) to mark breaches, send warnings at 70 percent and 100 percent, and escalate by level (owner → DSM → Sales Manager → Management). All times respect working hours and holidays (work_calendar config).

9. WORKFLOW BEHAVIOUR (implement as server-side state machines, one service per stage)

Stage 0/1 — Lead capture and allocation.

Public endpoints (rate-limited, signed with a per-source API key): website form, Meta/Google campaign webhook, WhatsApp inbound webhook (adapter), call-centre entry, referral entry, dealer-uploaded lead. Internal manual lead form too.
Capture: source, provenance, notice version shown, purpose-specific consent checkboxes (call, SMS, WhatsApp), recipients named (distributor and dealer legal names), timestamp, IP and device, and proof reference. No outbound promotional message until a consent record exists.
Validate mobile (+91, 10 digits, starts 6–9) and e-mail. DND scrub through the adapter. Duplicate check (mobile, e-mail, consumer number, fuzzy name + pincode); show existing-customer matches; ownership lock across dealers with a manager-override workflow.
Capture details: pincode (auto-fill city/district/state from a pincode table), MW scale, customer type, product interest, segment (required before any quote).
Territory and capability match: match pincode → territory → eligible distributors by territory, MW capacity band, product capability tags, vendor-registration level and districts, and distributor score (configurable weights). Decision node: if an eligible distributor exists, auto-assign (step 5) and start the acceptance clock; if none, escalate to DSM to reassign territory (step 6).
Lead acceptance (step 7): distributor accepts or rejects within SLA. Missed SLA triggers Reminder 1 → DSM alert → auto-reassignment to the next best distributor, all logged in lead_events.

Stage 2 — Follow-up and classification.

Initial contact log (call, WhatsApp, visit) with outcome picklists. Qualification call form: requirement, timeline, budget, decision maker. Temperature derived from timeline (HOT 0–30 days, WARM 1–3 months, COLD long-term/low urgency) and adjusted upward when a compliance deadline is within 60 days (e.g. CFA claim date, exemption commissioning date) — configurable.
Lead quality score 0–100: weights in rule_config.scoring (requirement clarity, MW size, timeline, budget, decision-maker access, consent present, bill captured). Show the component breakdown.
Mandatory on every save: Last Action, Next Action, Next Follow-up Date, Owner. The API rejects updates that leave them empty. Follow-up engine auto-creates the next reminder by temperature SLA; reminders go to in-app notifications, e-mail and WhatsApp (only inside the 24-hour window, or by approved template with valid consent). Missed next action → escalation to DSM / Sales Manager.

Stage 3 — Site visit and opportunity.

Site-visit scheduling and completion form with geo-tagged photo upload (photos stored in site-photos, EXIF geo captured if present). Requirement capture form per segment (dynamic fields from segment_form_config): consumer number, DISCOM, sanctioned load / contracted demand, phase, bill upload, name match, roof ownership and title, pending dues, existing solar kW, category, special-category state, load type, specs, documents.
DISCOM feasibility tracking: none needed ≤ 10 kW; for > 10 kW record submitted and complete dates and start the 15-day clock (deemed feasibility on silence).
Product recommendation (step 16) picks only from the validated SKU catalogue and shows brand USP fields (quality, warranty, certifications, service support, delivery reliability); the compliance panel shows live gate results as the user selects SKUs.
Rate negotiation log (step 18). Decision: Qualified project / real opportunity? — convert only when the three confirmation flags are true (also enforced by DB trigger); otherwise route to Nurture / recycle with a re-engagement date.
Opportunity (steps 19–20): probability %, expected MW, revenue, closing date, competitor, expected commissioning date, funding mix, regulation version (set from the expected commissioning date), exemption-reliance flag.

Stage 4 — Quotation and approval.

Quote builder: lines from SKU catalogue; per line HSN, GST rate with as-of date, quantity, price; price snapshot id; CFA entitlement computed from the rule engine (kW, category, state, special-category), state share (from the configurable state-scheme object), loan share, consumer net share; freight; payment terms; validity date (default capped at the price/duty horizon or the exemption date, whichever is earlier); change clause text (duty, GST, ALMM change) selected from templates; place of supply from site state.
Internal price review (step 22): margin and floor-price check from price_floor config. Approval matrix (step 23): lanes — Commercial (discount thresholds → DSM → Regional Head → Management), Compliance (any substitution, exemption reliance, non-verified rule dependency → compliance officer), Credit (dealer limit, ageing, deactivation → accounts). Parallel lanes where independent. SLA clock per lane.
Generate branded PDF (navy 
#1F3864, gold 
#BF9000, Arial) with the compliance summary, tax lines, CFA split and clauses; send by e-mail/WhatsApp adapter only if no hard stop and consent valid. Quote follow-up cadence Day 1/3/5/7 then escalation. Customer discussion log; accepted → commercial terms confirmed (step 27); rejected → revise (step 26), creating version n+1 and linking parent_quote_id.

Stage 5 — PI, payment, sales order.

Pre-PI checklist (blocking): legal name, billing and shipping address, GST, product, quantity, price, freight, payment terms. PI with funding split (consumer share / loan share / subsidy receivable), PI approval and issue (steps 28–29).
Payment / credit verification (step 30): record advance payments; credit lane checks dealer limit, ageing buckets, subsidy-linked receivables, bank-guarantee validity, portal status. Decision: advance received OR credit approved? YES → customer PO / order confirmation (31) → create SO (32) → SO approval and stakeholder circulation (33) → hand over to dispatch planning (34). NO → SO on hold, reminder to customer, escalation by the clock engine.
Serial-number dispatch: reserve serials by batch against SO lines, run evaluateDispatch, record invoice chain (brand → distributor → dealer → site), e-way bill and e-invoice status fields (provider adapter, manual entry fallback), generate dispatch note PDF.

Stage 6 (after dispatch) — Installation, DISCOM, subsidy, loan, warranty.

Installation record: installer / vendor of record, certificate date, geo-tagged photos, vendor-consumer agreement status. Starting the certificate triggers the DISCOM commissioning clock. Gujarat PMSG systems: record which GERC regulation version applies from the commissioning date (no separate connectivity agreement is a configurable flag).
Subsidy claim: readiness checklist (bank proof, photos, DISCOM inspection approval, e-token), CFA clock, cohort flag legacy with the 30-Nov-2026 countdown and daily work-list, rejection reasons picklist, state-share receivable tracking with ageing.
Loan: bank, application date, status, rejection code picklist (name mismatch, arrears, land title, collateral demanded, missing documents), co-applicant, document checklist, loan ageing clock.
Warranty / RMA: ticket by serial, type, brand claim number, cost-bearer field (unknown split — leave as a free picklist distributor|dealer|brand|consumer|unknown), RMA turnaround clock, 5-year O&M register (vendor-of-record duty).
MNRE SOP tracker for dealer complaints: reply (8 days), reminder (15), show-cause (15), deactivation (1 month), appeal (30 days) — driven by rule_config, shown on the dealer panel.

Channel management loop. Dealer scorecard: DSO, overdue %, subsidy-linked exposure vs limit, deactivations, complaint count, portal status, bank-guarantee expiry alerts (60 days), rebate accrual (configurable slabs; no defaults), territory.

10. API (Express, /api/v1, JSON, Zod-validated, paginated lists with filter/sort, consistent error shape { error: { code, message, details } })

Implement route modules (with unit/integration tests for the starred ones):

/auth (me, profile) · /leads* (create, list, get, update, accept, reject, reassign, merge, convert, nurture, timeline, consent, followups) · /public/leads (source-key auth) · /webhooks/whatsapp, /webhooks/campaign · /customers · /sites · /surveys · /opportunities* · /skus and /skus/:id/compliance* · /prices · /quotes* (create, version, lines, evaluate, request-approval, send, accept, reject, pdf) · /approvals* (inbox, decide) · /pis · /payments · /credit-checks* · /sales-orders* · /dispatches* · /serials · /loans · /discom-applications · /subsidy-claims · /installations · /warranty-tickets · /distributors · /dealers* · /vendor-registrations · /rules* (list, resolve, create version, activate) · /clocks · /notifications · /calendar · /dashboards/* (funnel, sla, discom-ageing, cfa-pending, dealer-exposure, stock-exposure, compliance, consent) · /reports/export (xlsx) · /documents (signed upload and download URLs) · /admin/users, /admin/territories, /admin/templates, /admin/audit.

All mutations write audit_log. All list endpoints support ?q=, filters, limit/offset. Document access uses short-lived signed URLs.

11. FRONTEND (React) — pages and behaviour

Layout: left navigation by role, top bar with global search, notification bell, language switcher (English / हिन्दी / ગુજરાતી — translate all static UI strings; provide the three JSON files fully populated), and a persistent Compliance Calendar strip showing the next three deadlines with countdown and confidence badge.

Pages (each with loading, empty, error states; responsive; keyboard accessible; WCAG AA contrast):

Login / reset.
Home dashboard by role: funnel (six conversion gates), lead SLA breaches, overdue follow-ups, approvals waiting, compliance-block count, CFA pending value and age, legacy-claim countdown, dealer exposure, stock exposure to the ALMM exemption date, consent coverage.
Leads: table + kanban by stage; filters (source, segment, temperature, owner, distributor, territory, SLA state); lead detail with timeline, consent panel, duplicate panel, mandatory-fields banner (Last Action / Next Action / Next Follow-up / Owner), qualification form, score breakdown, assign/accept/reject, convert-to-opportunity (disabled with reasons until the three confirmations are true).
Lead intake form (internal) and public intake form (embeddable, consent text from template with versioning).
Site & survey: survey form with photo capture/upload, bill upload, DISCOM and load fields, feasibility clock.
Opportunities: pipeline board, detail with funding mix and regulation-version display.
SKU catalogue and compliance register: CRUD, compliance flags, validity dates, snapshot date, verifier; "stale snapshot" filter.
Quote builder: split-pane — lines on the left, live compliance panel on the right (gate results colour-coded: red hard stop, amber warning, grey info) with the rule used and its confidence; CFA computation card; validity and clause pickers; version history; PDF preview; request approvals; send.
Approvals inbox (three lanes) with decision comments and SLA timers.
PI / payments / credit: pre-PI checklist, funding split, credit panel (limit, ageing buckets, subsidy-linked exposure, BG validity, portal status).
Sales orders and dispatch: serial picker with compliance status per serial, invoice chain, e-way/e-invoice status, dispatch note.
Post-sale board: installations, DISCOM applications (per-DISCOM ageing), loans (rejection codes), subsidy claims (legacy cohort first), warranty tickets with clocks.
Dealers and distributors: scorecards, vendor registration and portal-status panel, SOP tracker, BG expiry alerts, territory management.
Reports: KPI pages listed in Section 14 with xlsx export.
Admin: users and roles, territories and pincodes, Rule Config (versioned editor: value, effective dates, source, confidence, status, active toggle; diff view; "unverified/conflicting" badges), gate applicability matrix, approval rules, message templates (with DLT template id and WhatsApp category fields), SLA settings, work calendar, audit log viewer, "Verify before relying" register (Section 15).

Design: clean, data-dense, navy (
#1F3864) primary and gold (
#BF9000) accent, Arial, light and dark themes, tabular numerals, no emoji in UI.

12. EXTERNAL INTEGRATIONS (adapters with interfaces + working mocks; real credentials supplied later by env)

Define a TypeScript interface and a Mock implementation (writes to message_log and returns success) for each; select by env var:

WhatsAppProvider (send template, send session message, inbound webhook parser; enforce the 24-hour window and template categories marketing/utility/authentication/service in code before calling the provider).
SmsProvider (DLT template id and header required in the call signature).
EmailProvider (SMTP via nodemailer; mock logs to console).
DndRegistry (check mobile against the preference register; mock uses a local table).
EInvoiceProvider and EwayBillProvider (generate IRN / EWB; mock returns a clearly fake reference and marks status manual_pending).
ErpExport (CSV/xlsx export of PI, SO and invoice lines compatible with Tally and SAP Business One import templates — provide two documented column layouts in /docs/RUNBOOK.md).
Geocoder / PincodeLookup (local table first; adapter for an external API later).

Never call a real provider from tests.

13. DATA PROTECTION, CONSENT AND SECURITY REQUIREMENTS
Consent ledger: immutable rows; withdrawal as easy as granting (one-click in the lead record and via an unsubscribe keyword on WhatsApp/SMS). On opt-out: suppress promotional contact for 90 days (optout_suppress_until), propagate suppression to all named recipients (distributor and dealer), and log it.
Purpose limitation: consent purposes are enumerated; the send pipeline checks purpose and channel before every outbound message.
Erasure and retention: purpose-based retention timers in rule_config.retention; an erasure job anonymises personal data (keeps aggregates and statutory financial records) and logs the action; export endpoint for a data-principal access request.
Breach workflow: incident record, 72-hour countdown, notification template, evidence log (admin and compliance roles).
Aadhaar: no Aadhaar number or image fields. Add a server-side detector (12-digit pattern with Verhoeff check) on free-text and document filenames; block and warn (G14). If a customer insists, the UI offers "last four digits only" as a separate masked field.
Security: Zod validation everywhere, parameterised queries only, helmet, strict CORS from env, rate limits on public endpoints and login, file-type and size limits (images/PDF only, 10 MB), virus-scan hook placeholder with a documented extension point, signed URLs, secrets from env only, PII masking in logs, audit log immutable, session timeout configurable.
Privacy by default: mobile numbers masked in lists for roles without need; unmask action is logged.
14. KPIs AND DASHBOARDS (tie to real bottlenecks; implement as SQL views + API + charts)

Funnel conversions per gate (split by segment): Inquiry→Qualified Lead, Qualified Lead→Opportunity, Opportunity→Quotation, Quotation→PI, PI→Sales Order; plus Survey→Quote and Loan-approved/Loan-applied · First response within the 24-hour window and within 30 minutes for HOT · Follow-up compliance · Compliance-block rate (quotes blocked by G2–G6 ÷ quotes drafted) · Consent coverage · Non-List-II cell stock exposure (value and units) ahead of 31-Dec-2026 · DISCOM stage ageing (median and 90th percentile by DISCOM: feasibility, inspection, meter, commissioning) and deemed-clock breaches · CFA pending value and age; legacy claims at risk · Dealer DSO, overdue %, subsidy-linked exposure vs limit; dealers under SOP or deactivated · RMA turnaround and claim recovery from brand · Re-quote rate and price-change margin leakage. Every KPI tile shows its definition on hover. Provide xlsx export for each.

15. "VERIFY BEFORE RELYING" REGISTER

Create /docs/VERIFY_BEFORE_RELYING.md and seed the same items into a verify_register table (shown in Admin → Verify register with owner, status open/closed, closing source URL, and date closed). Seed these open items exactly:

PMSG CFA claim deadline 30-Nov-2026 and Phase II scope — OM text not read — check MNRE OM 31-Aug-2026.
ADD on Chinese cells/modules — DGTR recommended; Finance Ministry notification unconfirmed — check CBIC customs (ADD) notifications.
ALMM 18-Jul-2026 OM and 04-Aug-2026 clarification; OM numbers not supported — check MNRE ALMM page.
List-II bid-date carve-out: 09-Dec-2024 vs 31-Aug-2025 — conflicting.
BIS module standard: IS 14286 vs IS 14086; full QCO list under S.O. 492(E) — conflicting.
DCR: a vendor guide says PMSG needs no DCR, contradicted by MNRE guideline text and press — check current clause.
PM-KUSUM sales after 30-Sep-2026 — extension unknown.
Gujarat state subsidy figures — summary-only, internally inconsistent, no GR found.
Whether a distributor or unregistered installer may work under a registered vendor in PMSG — no clause found.
Surya Roshni v. PGVCL outcome; banking-charge rule by regulation version.
Gujarat net-metering specifics (₹2.25/unit, ₹500/day, GEDA role, Solar Policy end) — vendor blog.
Gujarat open-access surcharge and banking charge after Mar-2026; wheeling charges.
Gross metering above 10 kW — headline only.
TCS/TDS (194Q, 206C(1H)), e-way bill, s.17(5) ITC blocks, GST on inverters/structures/batteries, 70:30 split — not researched or low.
Module warranty and performance-cover mandate — headline only.
All vendor-sourced CRM feature and pricing claims.
TRAI: 140/160/1600 series, header suffix (-P vs -F), Third Amendment status, IndiaMART case.
DPDP: exact commencement date count; compression to 12 months; s.7 deemed consent; grievance timelines; exemptions.
PMSG loan rate: 7% vs 5.75%.
Installation count figures conflict (2.36M / 4M / ~4.5M / 50.06 lakh).
Inverter GST 5% vs 18%; Karnataka HC ruling (W.P. 9686/2025).
Vendor-enforcement claims (66 deactivations, 60-day rule, Vendor-Consumer Agreement from 23-Sep-2026, 15-day defect rule) — blog with internal errors.
Accelerated depreciation 40% under s.34 Income-tax Act 2025 — secondary source; CA to confirm.
Distributor margins, credit days, working capital, conversion rates — hypotheses; never coded.
DISCOM-specific timelines for UGVCL, DGVCL, MGVCL, PGVCL and Torrent Power — not found.
16. TESTING AND QUALITY
Unit tests (vitest) for: rule resolution by effective date; CFA calculator (1 kW, 2 kW, 3 kW, 4 kW, special-category, RWA); every gate G1–G14 on pass/fail/warn paths and on rule-inactive paths (must degrade to warning); lead score; temperature with deadline uplift; clock start/breach/escalation; duplicate detection; Aadhaar detector (Verhoeff); consent propagation and 90-day suppression; WhatsApp window logic; credit check; re-quote flagging.
Integration tests (supertest) with an in-memory/mock Supabase layer for: auth and role scoping (distributor user cannot read another distributor's lead), lead→opportunity guard, quote→approval→send, PI pre-checklist, SO block on over-limit dealer, dispatch block on non-compliant serial.
Frontend: component tests for the quote compliance panel and lead mandatory-field banner; one Playwright smoke script is optional but include the config.
Seed data in 12_seed_reference.sql must exercise every gate (at least one demo quote per gate outcome).
Lint and type-check clean; no any in shared packages.
17. BUILD PHASES (do all of them in this one run; run checks after each)
Scaffold monorepo, tooling, shared package, env examples.
SQL files 01–12 and RUN_ORDER.md.
API core: auth middleware, role/scope authorisation, audit, rule service, clock service, notification service, adapters + mocks.
Stages 0–3 services, routes, tests.
Compliance engine, quote builder, approvals, PI, credit, SO, dispatch services, routes, tests.
Post-sale modules, channel management, KPI views and report endpoints.
Frontend: shell, auth, i18n, dashboards, then each page in Section 11.
Docs, README, VERIFY register, final checks.
18. DELIVERABLES AND DEFINITION OF DONE

Deliver: the full repository; /supabase/sql/01…12 + RUN_ORDER.md; README.md with exact steps (create Supabase project → run SQL files in order in the SQL editor → create first admin → copy .env.example files → npm install → npm run dev); /docs/* listed in Section 2; a final summary in /docs/BUILD_REPORT.md listing what was built per section, tests passed, assumptions, and any item you could not complete (there should be none).

Done means: all pages and endpoints exist; npm run typecheck, lint and test pass; with the mock adapters and the demo seed, a user can capture a lead with consent, get it auto-assigned and accepted, classify and follow it up, survey the site, convert to an opportunity, build a compliant quote that is blocked when a non-DCR module is added to a PMSG quote, approve it through the three lanes, issue a PI, verify credit, create an SO, dispatch serials, track DISCOM, loan and subsidy clocks, raise a warranty ticket, and see every step on the dashboards, with the compliance calendar visible throughout, and with unverified rules behaving as warnings only.