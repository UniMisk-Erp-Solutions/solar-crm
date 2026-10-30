import type { KpiUnit } from '@solar/shared';

/**
 * Single source of truth for every KPI's label, plain-language definition (shown on hover), formula, source tables and exclusions.
 * Used by the dashboards (tile hover), the report catalogue, the xlsx definition sheet and docs/KPI_DEFINITIONS.md.
 */
export const DASHBOARD_NAMES = ['funnel', 'sla', 'discom-ageing', 'cfa-pending', 'dealer-exposure', 'stock-exposure', 'compliance', 'consent'] as const;
export type DashboardName = (typeof DASHBOARD_NAMES)[number];

export interface KpiDef {
  key: string;
  label: string;
  dashboard: DashboardName;
  unit: KpiUnit;
  /** plain language, one or two sentences */
  definition: string;
  /** precise formula */
  formula: string;
  sources: string[];
  exclusions: string[];
  /** hidden from distributor_user / dealer_user (data is not party-scoped) */
  internalOnly?: boolean;
  /** operating-default target read from rule_config (advisory only) */
  target?: { rule: string; direction: 'at_least' | 'at_most'; fallback: number; label: string };
}

const D = (def: KpiDef): KpiDef => def;
const LEAD_EXCL = 'Duplicate and merged leads; soft-deleted leads';
const SCOPE_EXCL = 'Rows outside the signed-in user\'s party/territory scope and outside the dashboard filters (segment, distributor, dealer)';

export const KPI_DEFS: KpiDef[] = [
  /* ───────────── funnel ───────────── */
  D({ key: 'funnel_gates', label: 'Funnel — leads reaching each gate', dashboard: 'funnel', unit: 'count',
    definition: 'How many leads created in the period reached each of the six conversion gates: Valid Lead, Qualified Lead, Opportunity, Quotation, PI and Sales Order.',
    formula: 'Distinct leads created in the period, counted at each gate. Valid Lead = not a duplicate/merged record. Qualified = status qualified, site_visit, opportunity or won, or a site survey or opportunity exists. Opportunity = an opportunity exists (or status opportunity/won). Quotation = at least one quotation on the lead\'s opportunities. PI = at least one non-cancelled proforma invoice on those quotations. Sales Order = at least one non-cancelled sales order on those quotations/PIs. A lead that reached a later gate is counted at every earlier gate.',
    sources: ['leads', 'site_surveys', 'opportunities', 'quotations', 'proforma_invoices', 'sales_orders'], exclusions: [LEAD_EXCL, SCOPE_EXCL] }),
  D({ key: 'conv_inquiry_to_qualified', label: 'Inquiry → Qualified Lead', dashboard: 'funnel', unit: 'pct',
    definition: 'Of the valid leads created in the period, the share that became qualified leads.',
    formula: 'Qualified Lead gate ÷ Valid Lead gate × 100, same lead cohort. Split by segment in the breakdown.', sources: ['leads', 'site_surveys', 'opportunities'], exclusions: [LEAD_EXCL, SCOPE_EXCL] }),
  D({ key: 'conv_qualified_to_opportunity', label: 'Qualified Lead → Opportunity', dashboard: 'funnel', unit: 'pct',
    definition: 'Of the qualified leads, the share converted to an opportunity (requirement, timeline and commercial potential confirmed).',
    formula: 'Opportunity gate ÷ Qualified Lead gate × 100, same lead cohort. Split by segment.', sources: ['leads', 'opportunities'], exclusions: [LEAD_EXCL, SCOPE_EXCL] }),
  D({ key: 'conv_opportunity_to_quotation', label: 'Opportunity → Quotation', dashboard: 'funnel', unit: 'pct',
    definition: 'Of the opportunities, the share for which a quotation was prepared.',
    formula: 'Quotation gate ÷ Opportunity gate × 100, same lead cohort. Split by segment.', sources: ['opportunities', 'quotations'], exclusions: [LEAD_EXCL, SCOPE_EXCL] }),
  D({ key: 'conv_quotation_to_pi', label: 'Quotation → PI', dashboard: 'funnel', unit: 'pct',
    definition: 'Of the quotations prepared, the share that moved to a proforma invoice.',
    formula: 'PI gate ÷ Quotation gate × 100, same lead cohort. Cancelled PIs are not counted. Split by segment.', sources: ['quotations', 'proforma_invoices'], exclusions: [LEAD_EXCL, 'Cancelled proforma invoices', SCOPE_EXCL] }),
  D({ key: 'conv_pi_to_sales_order', label: 'PI → Sales Order', dashboard: 'funnel', unit: 'pct',
    definition: 'Of the proforma invoices raised, the share that became a sales order (advance received or credit approved).',
    formula: 'Sales Order gate ÷ PI gate × 100, same lead cohort. Cancelled sales orders are not counted. Split by segment.', sources: ['proforma_invoices', 'sales_orders'], exclusions: [LEAD_EXCL, 'Cancelled sales orders', SCOPE_EXCL] }),
  D({ key: 'survey_to_quote_pct', label: 'Survey → Quote', dashboard: 'funnel', unit: 'pct',
    definition: 'Of the leads whose site survey was completed, the share that received a quotation.',
    formula: 'Leads (created in period) with a completed site survey AND at least one quotation ÷ leads with a completed site survey × 100.', sources: ['site_surveys', 'quotations', 'opportunities', 'leads'], exclusions: [LEAD_EXCL, 'Scheduled and cancelled surveys', SCOPE_EXCL] }),
  D({ key: 'loan_approval_pct', label: 'Loan approved ÷ applied', dashboard: 'funnel', unit: 'pct',
    definition: 'Of the loan applications made in the period, the share the bank approved.',
    formula: 'Loans with status approved or disbursed ÷ loans with status other than draft × 100. Loan date = application_date (created date when blank).', sources: ['loans'], exclusions: ['Draft loans (not yet applied)', SCOPE_EXCL] }),

  /* ───────────── sla ───────────── */
  D({ key: 'lead_acceptance_sla_pct', label: 'Lead acceptance within SLA', dashboard: 'sla', unit: 'pct',
    definition: 'Share of assigned leads that the distributor accepted before the acceptance clock ran out.',
    formula: 'lead_acceptance clocks started in the period: met ÷ (met + breached) × 100. A clock that breached and was accepted later still counts as breached. Running clocks not yet due are excluded.',
    sources: ['clocks', 'lead_assignments'], exclusions: ['Cancelled clocks', 'Clocks still running and not yet due', SCOPE_EXCL], target: { rule: 'kpi.target.lead_acceptance_sla_pct', direction: 'at_least', fallback: 90, label: 'Operating default' } }),
  D({ key: 'lead_acceptance_breaches', label: 'Lead acceptance SLA breaches', dashboard: 'sla', unit: 'count',
    definition: 'Number of leads whose acceptance deadline passed without the distributor accepting in time.',
    formula: 'lead_acceptance clocks started in the period with status breached (or running past due), plus expired lead_assignments that have no clock.',
    sources: ['clocks', 'lead_assignments'], exclusions: ['Cancelled clocks', SCOPE_EXCL] }),
  D({ key: 'first_response_24h_pct', label: 'First response within 24 h', dashboard: 'sla', unit: 'pct',
    definition: 'Share of new leads that were contacted for the first time within 24 hours of the inquiry.',
    formula: 'Leads created in the period whose response is due (contacted, or 24 h elapsed): first_contacted_at − created_at ≤ 24 h ÷ leads whose response is due × 100. First contact = first_contacted_at, or the earliest outbound contact log.',
    sources: ['leads', 'contact_logs'], exclusions: [LEAD_EXCL, 'Leads still inside their 24-hour window and not yet contacted', SCOPE_EXCL], target: { rule: 'kpi.target.first_response_24h_pct', direction: 'at_least', fallback: 95, label: 'Operating default' } }),
  D({ key: 'first_response_hot_30min_pct', label: 'HOT leads first response within 30 min', dashboard: 'sla', unit: 'pct',
    definition: 'Share of HOT leads that were contacted for the first time within 30 minutes of the inquiry.',
    formula: 'HOT leads created in the period whose response is due (contacted, or 30 min elapsed): first contact − created_at ≤ 30 min ÷ HOT leads whose response is due × 100.',
    sources: ['leads', 'contact_logs'], exclusions: [LEAD_EXCL, 'Non-HOT leads', 'HOT leads still inside their 30-minute window and not yet contacted', SCOPE_EXCL], target: { rule: 'kpi.target.first_response_hot_30min_pct', direction: 'at_least', fallback: 90, label: 'Operating default' } }),
  D({ key: 'first_response_median_minutes', label: 'Median time to first response', dashboard: 'sla', unit: 'minutes',
    definition: 'Typical time between a lead being captured and the first contact with the customer.',
    formula: 'Median of (first contact − created_at) in minutes over leads created in the period that have been contacted. 90th percentile shown alongside.',
    sources: ['leads', 'contact_logs'], exclusions: [LEAD_EXCL, 'Leads not yet contacted', SCOPE_EXCL] }),
  D({ key: 'followup_compliance_pct', label: 'Follow-up compliance', dashboard: 'sla', unit: 'pct',
    definition: 'Share of follow-ups that were completed on or before their due time.',
    formula: 'Follow-ups due in the period (due_at ≤ now, not cancelled): status done with done_at ≤ due_at ÷ follow-ups due × 100. Late, missed and still-open overdue follow-ups are not on time.',
    sources: ['followups', 'leads'], exclusions: ['Cancelled follow-ups', 'Follow-ups not yet due', SCOPE_EXCL], target: { rule: 'kpi.target.follow_up_compliance_pct', direction: 'at_least', fallback: 90, label: 'Operating default' } }),
  D({ key: 'overdue_followups', label: 'Overdue follow-ups', dashboard: 'sla', unit: 'count',
    definition: 'Follow-ups that are still open and past their due time right now.',
    formula: 'Count of follow-ups with status open and due_at < now (not limited to the period).', sources: ['followups', 'leads'], exclusions: [SCOPE_EXCL] }),
  D({ key: 'sla_breaches_open', label: 'Open SLA breaches', dashboard: 'sla', unit: 'count',
    definition: 'Clocks of any kind (acceptance, follow-up, approval, DISCOM, CFA …) that are past their deadline and still unresolved.',
    formula: 'Count of unresolved clocks with status breached, or running with due_at < now (not limited to the period).', sources: ['clocks'], exclusions: ['Met and cancelled clocks', 'Entity types the user cannot see', SCOPE_EXCL] }),
  D({ key: 'escalations_open', label: 'Escalated beyond DSM', dashboard: 'sla', unit: 'count',
    definition: 'Open breaches that have been escalated past the DSM to the Sales Manager or Management.',
    formula: 'Count of unresolved breached clocks with escalated_level ≥ 2. Breakdown shows level 1 (DSM), 2 (Sales Manager) and 3 (Management).', sources: ['clocks'], exclusions: [SCOPE_EXCL] }),

  /* ───────────── discom-ageing ───────────── */
  D({ key: 'discom_feasibility_ageing', label: 'DISCOM feasibility — days', dashboard: 'discom-ageing', unit: 'days',
    definition: 'How long DISCOMs take to clear technical feasibility, from a complete application. Median, with the 90th percentile alongside.',
    formula: 'Fractional days from complete_at (submitted_at if blank) to the feasibility outcome: the discom_feasibility clock resolved_at, or its due date when it lapsed (deemed). Median and p90 (linear interpolation, as Postgres percentile_cont) over completed applications, by DISCOM. Applications whose feasibility is still pending are reported as open (with the age of the oldest). Same chain as discomStageAgeing() on the post-sale board.',
    sources: ['discom_applications', 'discoms'], exclusions: ['Feasibility not required (≤ 10 kW)', 'Applications whose submitted/certificate date is outside the period', SCOPE_EXCL] }),
  D({ key: 'discom_inspection_ageing', label: 'DISCOM inspection — days', dashboard: 'discom-ageing', unit: 'days',
    definition: 'How long DISCOMs take to inspect after the installation certificate is submitted. Median, with the 90th percentile alongside.',
    formula: 'Fractional days from certificate_submitted_at to inspection_at. Median and p90 over completed applications, by DISCOM. Applications with a certificate but no inspection yet are open.',
    sources: ['discom_applications', 'discoms'], exclusions: ['Applications without a certificate date', 'Applications whose submitted/certificate date is outside the period', SCOPE_EXCL] }),
  D({ key: 'discom_meter_ageing', label: 'DISCOM meter installation — days', dashboard: 'discom-ageing', unit: 'days',
    definition: 'How long DISCOMs take to install the meter after inspection. Median, with the 90th percentile alongside.',
    formula: 'Fractional days from inspection_at (certificate_submitted_at if no inspection date) to meter_at. Median and p90 over completed applications, by DISCOM. Applications waiting for a meter are open.',
    sources: ['discom_applications', 'discoms'], exclusions: ['Applications without an inspection or certificate date', 'Applications whose submitted/certificate date is outside the period', SCOPE_EXCL] }),
  D({ key: 'discom_commissioning_ageing', label: 'DISCOM commissioning — days', dashboard: 'discom-ageing', unit: 'days',
    definition: 'How long DISCOMs take to commission after the meter is installed. Median, with the 90th percentile alongside.',
    formula: 'Fractional days from certificate_submitted_at to commissioning_at — the statutory 15-day measure. Median and p90 over completed applications, by DISCOM. Applications waiting to be commissioned are open.',
    sources: ['discom_applications', 'discoms'], exclusions: ['Applications without a certificate date', 'Applications whose submitted/certificate date is outside the period', SCOPE_EXCL] }),
  D({ key: 'discom_deemed_breaches', label: 'DISCOM deemed-clock breaches', dashboard: 'discom-ageing', unit: 'count',
    definition: 'Applications where the DISCOM has overshot its 15-day feasibility or commissioning clock (the project is deemed cleared).',
    formula: 'Applications with (discom_feasibility clock breached, or feasibility pending and now > feasibility_due_at) OR (certificate submitted and commissioning_at — or now if not yet commissioned — later than commissioning_due_at) OR the deemed_breach flag set. Each application counted once.',
    sources: ['discom_applications', 'discoms', 'clocks'], exclusions: ['Applications whose submitted/certificate date is outside the period', SCOPE_EXCL] }),

  /* ───────────── cfa-pending ───────────── */
  D({ key: 'cfa_pending_value', label: 'CFA pending — value', dashboard: 'cfa-pending', unit: 'inr',
    definition: 'Central subsidy (CFA) that DISCOM has approved but which has not yet been released to the consumer / vendor.',
    formula: 'Sum of cfa_computed for subsidy claims with discom_approval_at set, released_at empty and status not released/rejected. Point-in-time (today).', sources: ['subsidy_claims'], exclusions: ['Released and rejected claims', 'Claims without DISCOM approval', SCOPE_EXCL] }),
  D({ key: 'cfa_pending_age_days', label: 'CFA pending — age (days)', dashboard: 'cfa-pending', unit: 'days',
    definition: 'How long approved CFA claims have been waiting since the DISCOM approval. Median, with the 90th percentile alongside.',
    formula: 'Median / p90 of calendar days (IST) from discom_approval_at to today over pending CFA claims. Breakdown by age band.', sources: ['subsidy_claims'], exclusions: ['Released and rejected claims', 'Claims without DISCOM approval', SCOPE_EXCL] }),
  D({ key: 'cfa_release_overdue', label: 'CFA release overdue', dashboard: 'cfa-pending', unit: 'count',
    definition: 'Pending CFA claims that have waited longer than the policy release period (15 days after DISCOM approval).',
    formula: 'Pending CFA claims with age > rule pmsg.cfa_release_days_after_discom_approval (default 15). Value in the secondary figure.', sources: ['subsidy_claims', 'rule_config'], exclusions: ['Released and rejected claims', SCOPE_EXCL] }),
  D({ key: 'legacy_claims_at_risk', label: 'Legacy CFA claims at risk', dashboard: 'cfa-pending', unit: 'count',
    definition: 'Legacy-cohort subsidy claims that are not yet released and are racing the 30-Nov-2026 claim deadline.',
    formula: 'Count of subsidy claims with cohort legacy and status not_ready, ready or claimed (not released, not rejected). Days to deadline = claim_deadline (or rule pmsg.claim_deadline.legacy_cohort) − today.', sources: ['subsidy_claims', 'rule_config'], exclusions: ['Current-cohort claims', 'Released and rejected claims', SCOPE_EXCL] }),
  D({ key: 'legacy_claims_at_risk_value', label: 'Legacy CFA claims at risk — value', dashboard: 'cfa-pending', unit: 'inr',
    definition: 'Rupee value of legacy-cohort subsidy claims not yet released.',
    formula: 'Sum of cfa_computed over the legacy claims counted in "Legacy CFA claims at risk".', sources: ['subsidy_claims'], exclusions: ['Current-cohort claims', 'Released and rejected claims', SCOPE_EXCL] }),
  D({ key: 'legacy_days_to_deadline', label: 'Days to legacy claim deadline', dashboard: 'cfa-pending', unit: 'days',
    definition: 'Days left until the legacy-cohort CFA claim deadline (negative once passed). Advisory — the date is a medium-confidence rule.',
    formula: 'Rule pmsg.claim_deadline.legacy_cohort (fallback 2026-11-30) − today, in calendar days (IST).', sources: ['rule_config'], exclusions: ['Not filtered by dashboard filters — a single date'] }),
  D({ key: 'state_share_receivable', label: 'State-share receivable', dashboard: 'cfa-pending', unit: 'inr',
    definition: 'State subsidy share still to be received, aged by how long it is past its due date.',
    formula: 'Sum of state_share for claims with state_share > 0, state_share_received_at empty and status not rejected. Ageing by days past state_share_due_at (not yet due / 1–30 / 31–60 / 61–90 / 90+).', sources: ['subsidy_claims'], exclusions: ['Rejected claims', 'Claims where the state share has been received', SCOPE_EXCL] }),

  /* ───────────── dealer-exposure ───────────── */
  D({ key: 'dealer_outstanding', label: 'Dealer outstanding', dashboard: 'dealer-exposure', unit: 'inr',
    definition: 'Total unpaid dealer receivables (open and overdue), with ageing by days past due. Credit limit alongside.',
    formula: 'Sum over dealers of Σ(amount − paid_amount) for receivables with status open/overdue. Ageing buckets: current (not due), 1–30, 31–60, 61–90, 90+ days past due_date. Same arithmetic as the credit lane (computeDealerExposure).', sources: ['dealer_receivables', 'dealers'], exclusions: ['Paid and written-off receivables', 'Dealers outside the scope or filters'] }),
  D({ key: 'dealer_overdue_pct', label: 'Dealer overdue %', dashboard: 'dealer-exposure', unit: 'pct',
    definition: 'Share of dealer outstanding that is already past its due date.',
    formula: 'Overdue amount (all ageing buckets beyond current) ÷ total outstanding × 100.', sources: ['dealer_receivables', 'dealers'], exclusions: ['Paid and written-off receivables'] }),
  D({ key: 'dealer_dso_days', label: 'Dealer DSO', dashboard: 'dealer-exposure', unit: 'days',
    definition: 'Days of sales outstanding — how many days of the last 90 days\' billing is still unpaid.',
    formula: 'Total outstanding ÷ invoices raised in the last 90 days (invoice_date) × 90, rounded. Per dealer in the table; portfolio figure here.', sources: ['dealer_receivables'], exclusions: ['Dealers with no billing in the last 90 days have no DSO'] }),
  D({ key: 'subsidy_linked_exposure', label: 'Subsidy-linked exposure', dashboard: 'dealer-exposure', unit: 'inr',
    definition: 'Dealer outstanding that is only recoverable once a government subsidy is released. Shown against the total credit limit.',
    formula: 'Σ(amount − paid_amount) of open/overdue receivables flagged subsidy_linked. Percentage of limit = subsidy-linked ÷ total credit limit × 100.', sources: ['dealer_receivables', 'dealers'], exclusions: ['Receivables not flagged subsidy-linked'] }),
  D({ key: 'dealers_under_sop', label: 'Dealers under SOP', dashboard: 'dealer-exposure', unit: 'count',
    definition: 'Dealers with an MNRE SOP review in progress on the PM Surya Ghar portal.',
    formula: 'Dealers whose portal status (dealer record or any vendor registration) is under_sop and who are not deactivated.', sources: ['dealers', 'vendor_registrations', 'sop_cases'], exclusions: ['Deactivated dealers (counted separately)'] }),
  D({ key: 'dealers_deactivated', label: 'Dealers deactivated', dashboard: 'dealer-exposure', unit: 'count',
    definition: 'Dealers deactivated on the PM Surya Ghar portal — new sales orders are blocked for them.',
    formula: 'Dealers whose portal status (dealer record or any vendor registration) is deactivated.', sources: ['dealers', 'vendor_registrations'], exclusions: [] }),
  D({ key: 'dealers_over_limit', label: 'Dealers over credit limit', dashboard: 'dealer-exposure', unit: 'count',
    definition: 'Dealers whose outstanding is higher than their approved credit limit.',
    formula: 'Dealers with outstanding > credit_limit.', sources: ['dealers', 'dealer_receivables'], exclusions: [] }),
  D({ key: 'dealer_bg_expiring', label: 'Bank guarantees expiring', dashboard: 'dealer-exposure', unit: 'count',
    definition: 'Dealers whose bank guarantee has expired or expires within 60 days.',
    formula: 'Dealers whose latest vendor-registration bank_guarantee_valid_till is within reporting.bg_expiry_alert_days (default 60) of today or already past.', sources: ['vendor_registrations', 'dealers'], exclusions: ['Dealers with no bank guarantee on record'] }),

  /* ───────────── stock-exposure ───────────── */
  D({ key: 'non_list2_stock_value', label: 'Non-List-II cell stock — value', dashboard: 'stock-exposure', unit: 'inr',
    definition: 'Rupee value of module stock whose cells are not on ALMM List-II, sitting in the warehouse ahead of the exemption end date.',
    formula: 'Σ unit cost of in-stock module serials whose receipt snapshot has almm_list2 = false. Unit cost = stock_batches.unit_cost, else the sku_prices base price in force today; serials with neither are counted as unpriced units (value 0).',
    sources: ['inventory_serials', 'skus', 'stock_batches', 'sku_prices'], exclusions: ['Non-module SKUs', 'Reserved, dispatched, installed and RMA serials', 'Serials whose snapshot says List-II compliant'], internalOnly: true }),
  D({ key: 'non_list2_stock_units', label: 'Non-List-II cell stock — units', dashboard: 'stock-exposure', unit: 'count',
    definition: 'Number of module serials in stock whose cells are not on ALMM List-II.',
    formula: 'Count of in-stock module serials with compliance_snapshot.almm_list2 = false. Breakdown by SKU and batch in the dashboard.', sources: ['inventory_serials', 'skus'], exclusions: ['Non-module SKUs', 'Reserved, dispatched, installed and RMA serials'], internalOnly: true }),
  D({ key: 'list2_exemption_days_left', label: 'Days to List-II exemption end', dashboard: 'stock-exposure', unit: 'days',
    definition: 'Days left until the ALMM List-II exemption for net-metering / open-access projects ends (commissioning date). Negative once passed.',
    formula: 'Rule almm.list2.exemption_net_metering_open_access_until (fallback 2026-12-31) − today, in calendar days (IST).', sources: ['rule_config'], exclusions: ['Not filtered by dashboard filters — a single date'], internalOnly: true }),

  /* ───────────── compliance ───────────── */
  D({ key: 'compliance_block_rate_pct', label: 'Compliance-block rate', dashboard: 'compliance', unit: 'pct',
    definition: 'Share of drafted quotations that were stopped by a hard compliance gate (G2–G6: DCR, ALMM List-I, List-II, exemption date, BIS).',
    formula: 'Quotations created in the period with at least one hard_stop finding for gates G2–G6 ÷ all quotations created in the period × 100. Overridden hard stops still count (the quote was blocked). Breakdown: quotes per gate.',
    sources: ['quotations'], exclusions: ['Hard stops from other gates (G1, G7–G14)', SCOPE_EXCL] }),
  D({ key: 'requote_rate_pct', label: 'Re-quote rate', dashboard: 'compliance', unit: 'pct',
    definition: 'Share of issued quotations that had to be re-quoted because a price, duty, GST or compliance rule changed.',
    formula: 'Quotations created in the period flagged requote_required (status or requote_reason) ÷ quotations issued (sent_at set, or status sent/negotiation/accepted/requote_required/expired/revised, or flagged) × 100.',
    sources: ['quotations'], exclusions: ['Quotations never issued (draft, blocked, pending approval)', SCOPE_EXCL] }),
  D({ key: 'price_change_margin_leakage', label: 'Re-quote price-change leakage', dashboard: 'compliance', unit: 'inr',
    definition: 'Rupees of margin at risk on re-quote-flagged quotations if the old prices were honoured at today\'s price list.',
    formula: 'For each flagged quotation: Σ over lines with a SKU price in force today of qty × base_price × (1 − line discount %) (other lines at their quoted total) − quoted subtotal; leakage = Σ max(0, difference). Pre-tax.',
    sources: ['quotations', 'quotation_lines', 'sku_prices'], exclusions: ['Quotations not flagged for re-quote', 'Negative differences (price falls) are reported per quote but not counted as leakage', SCOPE_EXCL], internalOnly: true }),
  D({ key: 'rma_turnaround_days', label: 'RMA turnaround', dashboard: 'compliance', unit: 'days',
    definition: 'Typical time to close a return/replacement (RMA) ticket. Median, with the 90th percentile alongside.',
    formula: 'Median / p90 of (closed_at − opened_at) in days over RMA tickets closed in the period.', sources: ['warranty_tickets'], exclusions: ['Open tickets', 'Non-RMA ticket types', SCOPE_EXCL] }),
  D({ key: 'rma_brand_recovery', label: 'RMA claim recovery from brand', dashboard: 'compliance', unit: 'inr',
    definition: 'Rupees recovered from the brand against warranty / RMA claims raised in the period.',
    formula: 'Σ recovered_amount of tickets opened in the period that carry a brand claim number or have the brand as cost bearer.', sources: ['warranty_tickets'], exclusions: ['Tickets with no brand claim', SCOPE_EXCL] }),
  D({ key: 'rma_brand_recovery_rate_pct', label: 'RMA brand claims recovered', dashboard: 'compliance', unit: 'pct',
    definition: 'Share of brand warranty claims raised in the period against which money has actually been recovered.',
    formula: 'Brand-claim tickets with recovered_amount > 0 ÷ brand-claim tickets × 100.', sources: ['warranty_tickets'], exclusions: ['Tickets with no brand claim', SCOPE_EXCL] }),
  D({ key: 'open_overrides', label: 'Open overrides', dashboard: 'compliance', unit: 'count',
    definition: 'Compliance and credit overrides requested and still waiting for a decision.',
    formula: 'Pending approvals of type compliance_override plus credit_overrides with status pending.', sources: ['approvals', 'credit_overrides'], exclusions: ['Decided overrides'], internalOnly: true }),

  /* ───────────── consent ───────────── */
  D({ key: 'consent_coverage_pct', label: 'Consent coverage', dashboard: 'consent', unit: 'pct',
    definition: 'Share of leads that had a valid, un-withdrawn consent on record before we first contacted them.',
    formula: 'Valid leads created in the period with a consent row (granted_at ≤ first outbound message, not withdrawn before it; or simply not withdrawn when nothing has been sent yet) ÷ valid leads × 100. First outbound = earliest sent/queued outbound message_log row.',
    sources: ['leads', 'lead_consents', 'message_log'], exclusions: [LEAD_EXCL, 'Blocked messages (they never reached the customer)', SCOPE_EXCL], target: { rule: 'kpi.target.consent_coverage_pct', direction: 'at_least', fallback: 100, label: 'Operating default' } }),
  D({ key: 'consent_withdrawn', label: 'Consents withdrawn', dashboard: 'consent', unit: 'count',
    definition: 'Consents withdrawn by customers in the period (one-click withdrawal or STOP keyword).',
    formula: 'Count of lead_consents with withdrawn_at in the period. Breakdown by withdrawal channel.', sources: ['lead_consents', 'leads'], exclusions: [SCOPE_EXCL] }),
  D({ key: 'consent_suppressed', label: 'Leads under opt-out suppression', dashboard: 'consent', unit: 'count',
    definition: 'Leads currently inside the 90-day post-opt-out window in which promotional contact is blocked.',
    formula: 'Distinct leads with a consent row whose optout_suppress_until is later than now.', sources: ['lead_consents', 'leads'], exclusions: [SCOPE_EXCL] }),
  D({ key: 'dnd_blocked_messages', label: 'Messages blocked by DND', dashboard: 'consent', unit: 'count',
    definition: 'Outbound messages the system refused to send because the number is on the DND register or the DND check was missing/stale.',
    formula: 'Count of message_log rows with status blocked in the period whose block reason is DND_REGISTERED, DND_UNCHECKED or DND_STALE. Secondary figure: leads currently marked registered/blocked on DND.', sources: ['message_log', 'leads'], exclusions: ['Messages not linked to a visible lead', SCOPE_EXCL] }),
  D({ key: 'blocked_messages', label: 'Blocked messages', dashboard: 'consent', unit: 'count',
    definition: 'All outbound messages the consent pipeline refused to send in the period, by reason.',
    formula: 'Count of message_log rows with status blocked in the period. Breakdown by block reason code.', sources: ['message_log', 'leads'], exclusions: ['Messages not linked to a visible lead', SCOPE_EXCL] }),
];

export const KPI_BY_KEY: ReadonlyMap<string, KpiDef> = new Map(KPI_DEFS.map((d) => [d.key, d]));
export const kpiDef = (key: string): KpiDef => {
  const d = KPI_BY_KEY.get(key);
  if (!d) throw new Error(`Unknown KPI "${key}"`);
  return d;
};
export const kpisOf = (dashboard: DashboardName): KpiDef[] => KPI_DEFS.filter((d) => d.dashboard === dashboard);
