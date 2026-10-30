# KPI definitions

Every KPI on the dashboards, the report catalogue and the xlsx exports, with its exact formula. The text below is generated from the single registry in
`apps/api/src/services/kpi/definitions.ts` — the same strings shown on hover in the UI and on the "KPI definition" sheet of every export — so the three never drift.
The SQL views (`v_funnel`, `v_lead_sla_breaches`, `v_followup_overdue`, `v_discom_stage_ageing`, `v_cfa_pending`, `v_dealer_exposure`, `v_stock_exposure_non_list2`,
`v_compliance_block_rate`, `v_consent_coverage`) are expected to implement the same formulas; the API computes them in TypeScript through `ctx.db` so it works identically on the
in-memory demo store and on Supabase.

## Conventions (apply to every KPI)

* **Period** — `from`/`to` are inclusive IST calendar dates (Asia/Kolkata); default = the last 90 days (rule `reporting.default_period_days`). "Created in the period" means `created_at` between 00:00 IST of `from` and 23:59:59 IST of `to`. Point-in-time KPIs (marked *today*) ignore the period and use `ctx.now()`.
* **Scope** — every read goes through `scopeWhere`: `distributor_user` / `dealer_user` only ever see their own party's rows; internal users restricted by `territory_ids` only see those territories. The dashboard filters `segment`, `distributor_id` and `dealer_id` narrow further and can never widen the scope.
* **Segment** is the lead/opportunity/quotation/order segment; for records without their own segment column (PI, loan, DISCOM application, subsidy claim, installation, warranty ticket) it is the segment of the parent quotation / opportunity / sales order.
* **Percentages** are `numerator ÷ denominator × 100`, rounded to 1 decimal; a zero denominator gives `null` (shown as "no data"), never 0.
* **Percentiles** use linear interpolation between closest ranks — identical to Postgres `percentile_cont(p)` and Excel `PERCENTILE.INC`. (The post-sale board's `discomStageAgeing()` uses nearest-rank for p90; medians agree, p90 can differ by interpolation.)
* **Days** between dates are calendar days in IST; durations between timestamps are fractional days (rounded to 1 decimal in the output).
* **Targets** shown on a tile are *operating defaults* read from `rule_config` (`kpi.target.*`); they are advisory, never block anything. Conversion-rate, margin, DSO and credit-day targets are deliberately **not** seeded (prompt Section 6.2: hypotheses are never coded).
* **Rules** — thresholds come from `ctx.svc.rules`: `reporting.*` (operating defaults), `pmsg.claim_deadline.legacy_cohort`, `pmsg.cfa_release_days_after_discom_approval`, `almm.list2.exemption_net_metering_open_access_until`. When a rule is absent the documented fallback is used and the response says so (`fallback_used`).
* **Exclusions that apply everywhere** — soft-deleted records; for lead cohorts, duplicate and merged leads.

### Funnel gate definitions

| Gate | A lead (created in the period) has reached it when … |
|---|---|
| 1 Valid Lead | its status is not `duplicate` / `merged` |
| 2 Qualified Lead | status is `qualified`, `site_visit`, `opportunity` or `won`, **or** a (non-cancelled) site survey or an opportunity exists |
| 3 Opportunity | an opportunity exists for the lead (or status `opportunity` / `won`) |
| 4 Quotation | at least one quotation exists on the lead's opportunities (any status or version) |
| 5 PI | at least one non-cancelled proforma invoice exists on those quotations |
| 6 Sales Order | at least one non-cancelled sales order exists on those quotations / PIs |

A lead that reached gate *n* is counted at every gate before *n*, so counts never increase down the funnel.

### Known approximations

* The DISCOM feasibility outcome date comes from the `discom_feasibility` clock (`resolved_at`, or its due date when the clock lapsed). A decided application with no clock row is reported as *open* for that stage. A dedicated `feasibility_decided_at` column on `discom_applications` would make this exact.
* "Open overrides" counts pending `compliance_override` approvals plus pending `credit_overrides`; the contract has no separate compliance-override table.

---

## Funnel and conversion gates

`GET /dashboards/funnel`

### Funnel — leads reaching each gate

* **Key:** `funnel_gates`
* **Unit:** count
* **Definition:** How many leads created in the period reached each of the six conversion gates: Valid Lead, Qualified Lead, Opportunity, Quotation, PI and Sales Order.
* **Formula:** Distinct leads created in the period, counted at each gate. Valid Lead = not a duplicate/merged record. Qualified = status qualified, site_visit, opportunity or won, or a site survey or opportunity exists. Opportunity = an opportunity exists (or status opportunity/won). Quotation = at least one quotation on the lead's opportunities. PI = at least one non-cancelled proforma invoice on those quotations. Sales Order = at least one non-cancelled sales order on those quotations/PIs. A lead that reached a later gate is counted at every earlier gate.
* **Source tables:** `leads`, `site_surveys`, `opportunities`, `quotations`, `proforma_invoices`, `sales_orders`
* **Exclusions:** Duplicate and merged leads; soft-deleted leads; Rows outside the signed-in user's party/territory scope and outside the dashboard filters (segment, distributor, dealer)

### Inquiry → Qualified Lead

* **Key:** `conv_inquiry_to_qualified`
* **Unit:** % (0–100, 1 decimal)
* **Definition:** Of the valid leads created in the period, the share that became qualified leads.
* **Formula:** Qualified Lead gate ÷ Valid Lead gate × 100, same lead cohort. Split by segment in the breakdown.
* **Source tables:** `leads`, `site_surveys`, `opportunities`
* **Exclusions:** Duplicate and merged leads; soft-deleted leads; Rows outside the signed-in user's party/territory scope and outside the dashboard filters (segment, distributor, dealer)

### Qualified Lead → Opportunity

* **Key:** `conv_qualified_to_opportunity`
* **Unit:** % (0–100, 1 decimal)
* **Definition:** Of the qualified leads, the share converted to an opportunity (requirement, timeline and commercial potential confirmed).
* **Formula:** Opportunity gate ÷ Qualified Lead gate × 100, same lead cohort. Split by segment.
* **Source tables:** `leads`, `opportunities`
* **Exclusions:** Duplicate and merged leads; soft-deleted leads; Rows outside the signed-in user's party/territory scope and outside the dashboard filters (segment, distributor, dealer)

### Opportunity → Quotation

* **Key:** `conv_opportunity_to_quotation`
* **Unit:** % (0–100, 1 decimal)
* **Definition:** Of the opportunities, the share for which a quotation was prepared.
* **Formula:** Quotation gate ÷ Opportunity gate × 100, same lead cohort. Split by segment.
* **Source tables:** `opportunities`, `quotations`
* **Exclusions:** Duplicate and merged leads; soft-deleted leads; Rows outside the signed-in user's party/territory scope and outside the dashboard filters (segment, distributor, dealer)

### Quotation → PI

* **Key:** `conv_quotation_to_pi`
* **Unit:** % (0–100, 1 decimal)
* **Definition:** Of the quotations prepared, the share that moved to a proforma invoice.
* **Formula:** PI gate ÷ Quotation gate × 100, same lead cohort. Cancelled PIs are not counted. Split by segment.
* **Source tables:** `quotations`, `proforma_invoices`
* **Exclusions:** Duplicate and merged leads; soft-deleted leads; Cancelled proforma invoices; Rows outside the signed-in user's party/territory scope and outside the dashboard filters (segment, distributor, dealer)

### PI → Sales Order

* **Key:** `conv_pi_to_sales_order`
* **Unit:** % (0–100, 1 decimal)
* **Definition:** Of the proforma invoices raised, the share that became a sales order (advance received or credit approved).
* **Formula:** Sales Order gate ÷ PI gate × 100, same lead cohort. Cancelled sales orders are not counted. Split by segment.
* **Source tables:** `proforma_invoices`, `sales_orders`
* **Exclusions:** Duplicate and merged leads; soft-deleted leads; Cancelled sales orders; Rows outside the signed-in user's party/territory scope and outside the dashboard filters (segment, distributor, dealer)

### Survey → Quote

* **Key:** `survey_to_quote_pct`
* **Unit:** % (0–100, 1 decimal)
* **Definition:** Of the leads whose site survey was completed, the share that received a quotation.
* **Formula:** Leads (created in period) with a completed site survey AND at least one quotation ÷ leads with a completed site survey × 100.
* **Source tables:** `site_surveys`, `quotations`, `opportunities`, `leads`
* **Exclusions:** Duplicate and merged leads; soft-deleted leads; Scheduled and cancelled surveys; Rows outside the signed-in user's party/territory scope and outside the dashboard filters (segment, distributor, dealer)

### Loan approved ÷ applied

* **Key:** `loan_approval_pct`
* **Unit:** % (0–100, 1 decimal)
* **Definition:** Of the loan applications made in the period, the share the bank approved.
* **Formula:** Loans with status approved or disbursed ÷ loans with status other than draft × 100. Loan date = application_date (created date when blank).
* **Source tables:** `loans`
* **Exclusions:** Draft loans (not yet applied); Rows outside the signed-in user's party/territory scope and outside the dashboard filters (segment, distributor, dealer)

---

## SLA, first response and follow-up compliance

`GET /dashboards/sla`

### Lead acceptance within SLA

* **Key:** `lead_acceptance_sla_pct`
* **Unit:** % (0–100, 1 decimal)
* **Definition:** Share of assigned leads that the distributor accepted before the acceptance clock ran out.
* **Formula:** lead_acceptance clocks started in the period: met ÷ (met + breached) × 100. A clock that breached and was accepted later still counts as breached. Running clocks not yet due are excluded.
* **Source tables:** `clocks`, `lead_assignments`
* **Exclusions:** Cancelled clocks; Clocks still running and not yet due; Rows outside the signed-in user's party/territory scope and outside the dashboard filters (segment, distributor, dealer)
* **Target:** at least 90 (Operating default; rule `kpi.target.lead_acceptance_sla_pct`, advisory)

### Lead acceptance SLA breaches

* **Key:** `lead_acceptance_breaches`
* **Unit:** count
* **Definition:** Number of leads whose acceptance deadline passed without the distributor accepting in time.
* **Formula:** lead_acceptance clocks started in the period with status breached (or running past due), plus expired lead_assignments that have no clock.
* **Source tables:** `clocks`, `lead_assignments`
* **Exclusions:** Cancelled clocks; Rows outside the signed-in user's party/territory scope and outside the dashboard filters (segment, distributor, dealer)

### First response within 24 h

* **Key:** `first_response_24h_pct`
* **Unit:** % (0–100, 1 decimal)
* **Definition:** Share of new leads that were contacted for the first time within 24 hours of the inquiry.
* **Formula:** Leads created in the period whose response is due (contacted, or 24 h elapsed): first_contacted_at − created_at ≤ 24 h ÷ leads whose response is due × 100. First contact = first_contacted_at, or the earliest outbound contact log.
* **Source tables:** `leads`, `contact_logs`
* **Exclusions:** Duplicate and merged leads; soft-deleted leads; Leads still inside their 24-hour window and not yet contacted; Rows outside the signed-in user's party/territory scope and outside the dashboard filters (segment, distributor, dealer)
* **Target:** at least 95 (Operating default; rule `kpi.target.first_response_24h_pct`, advisory)

### HOT leads first response within 30 min

* **Key:** `first_response_hot_30min_pct`
* **Unit:** % (0–100, 1 decimal)
* **Definition:** Share of HOT leads that were contacted for the first time within 30 minutes of the inquiry.
* **Formula:** HOT leads created in the period whose response is due (contacted, or 30 min elapsed): first contact − created_at ≤ 30 min ÷ HOT leads whose response is due × 100.
* **Source tables:** `leads`, `contact_logs`
* **Exclusions:** Duplicate and merged leads; soft-deleted leads; Non-HOT leads; HOT leads still inside their 30-minute window and not yet contacted; Rows outside the signed-in user's party/territory scope and outside the dashboard filters (segment, distributor, dealer)
* **Target:** at least 90 (Operating default; rule `kpi.target.first_response_hot_30min_pct`, advisory)

### Median time to first response

* **Key:** `first_response_median_minutes`
* **Unit:** minutes
* **Definition:** Typical time between a lead being captured and the first contact with the customer.
* **Formula:** Median of (first contact − created_at) in minutes over leads created in the period that have been contacted. 90th percentile shown alongside.
* **Source tables:** `leads`, `contact_logs`
* **Exclusions:** Duplicate and merged leads; soft-deleted leads; Leads not yet contacted; Rows outside the signed-in user's party/territory scope and outside the dashboard filters (segment, distributor, dealer)

### Follow-up compliance

* **Key:** `followup_compliance_pct`
* **Unit:** % (0–100, 1 decimal)
* **Definition:** Share of follow-ups that were completed on or before their due time.
* **Formula:** Follow-ups due in the period (due_at ≤ now, not cancelled): status done with done_at ≤ due_at ÷ follow-ups due × 100. Late, missed and still-open overdue follow-ups are not on time.
* **Source tables:** `followups`, `leads`
* **Exclusions:** Cancelled follow-ups; Follow-ups not yet due; Rows outside the signed-in user's party/territory scope and outside the dashboard filters (segment, distributor, dealer)
* **Target:** at least 90 (Operating default; rule `kpi.target.follow_up_compliance_pct`, advisory)

### Overdue follow-ups

* **Key:** `overdue_followups`
* **Unit:** count
* **Definition:** Follow-ups that are still open and past their due time right now.
* **Formula:** Count of follow-ups with status open and due_at < now (not limited to the period).
* **Source tables:** `followups`, `leads`
* **Exclusions:** Rows outside the signed-in user's party/territory scope and outside the dashboard filters (segment, distributor, dealer)

### Open SLA breaches

* **Key:** `sla_breaches_open`
* **Unit:** count
* **Definition:** Clocks of any kind (acceptance, follow-up, approval, DISCOM, CFA …) that are past their deadline and still unresolved.
* **Formula:** Count of unresolved clocks with status breached, or running with due_at < now (not limited to the period).
* **Source tables:** `clocks`
* **Exclusions:** Met and cancelled clocks; Entity types the user cannot see; Rows outside the signed-in user's party/territory scope and outside the dashboard filters (segment, distributor, dealer)

### Escalated beyond DSM

* **Key:** `escalations_open`
* **Unit:** count
* **Definition:** Open breaches that have been escalated past the DSM to the Sales Manager or Management.
* **Formula:** Count of unresolved breached clocks with escalated_level ≥ 2. Breakdown shows level 1 (DSM), 2 (Sales Manager) and 3 (Management).
* **Source tables:** `clocks`
* **Exclusions:** Rows outside the signed-in user's party/territory scope and outside the dashboard filters (segment, distributor, dealer)

---

## DISCOM stage ageing

`GET /dashboards/discom-ageing`

### DISCOM feasibility — days

* **Key:** `discom_feasibility_ageing`
* **Unit:** days
* **Definition:** How long DISCOMs take to clear technical feasibility, from a complete application. Median, with the 90th percentile alongside.
* **Formula:** Fractional days from complete_at (submitted_at if blank) to the feasibility outcome: the discom_feasibility clock resolved_at, or its due date when it lapsed (deemed). Median and p90 (linear interpolation, as Postgres percentile_cont) over completed applications, by DISCOM. Applications whose feasibility is still pending are reported as open (with the age of the oldest). Same chain as discomStageAgeing() on the post-sale board.
* **Source tables:** `discom_applications`, `discoms`
* **Exclusions:** Feasibility not required (≤ 10 kW); Applications whose submitted/certificate date is outside the period; Rows outside the signed-in user's party/territory scope and outside the dashboard filters (segment, distributor, dealer)

### DISCOM inspection — days

* **Key:** `discom_inspection_ageing`
* **Unit:** days
* **Definition:** How long DISCOMs take to inspect after the installation certificate is submitted. Median, with the 90th percentile alongside.
* **Formula:** Fractional days from certificate_submitted_at to inspection_at. Median and p90 over completed applications, by DISCOM. Applications with a certificate but no inspection yet are open.
* **Source tables:** `discom_applications`, `discoms`
* **Exclusions:** Applications without a certificate date; Applications whose submitted/certificate date is outside the period; Rows outside the signed-in user's party/territory scope and outside the dashboard filters (segment, distributor, dealer)

### DISCOM meter installation — days

* **Key:** `discom_meter_ageing`
* **Unit:** days
* **Definition:** How long DISCOMs take to install the meter after inspection. Median, with the 90th percentile alongside.
* **Formula:** Fractional days from inspection_at (certificate_submitted_at if no inspection date) to meter_at. Median and p90 over completed applications, by DISCOM. Applications waiting for a meter are open.
* **Source tables:** `discom_applications`, `discoms`
* **Exclusions:** Applications without an inspection or certificate date; Applications whose submitted/certificate date is outside the period; Rows outside the signed-in user's party/territory scope and outside the dashboard filters (segment, distributor, dealer)

### DISCOM commissioning — days

* **Key:** `discom_commissioning_ageing`
* **Unit:** days
* **Definition:** How long DISCOMs take to commission after the meter is installed. Median, with the 90th percentile alongside.
* **Formula:** Fractional days from certificate_submitted_at to commissioning_at — the statutory 15-day measure. Median and p90 over completed applications, by DISCOM. Applications waiting to be commissioned are open.
* **Source tables:** `discom_applications`, `discoms`
* **Exclusions:** Applications without a certificate date; Applications whose submitted/certificate date is outside the period; Rows outside the signed-in user's party/territory scope and outside the dashboard filters (segment, distributor, dealer)

### DISCOM deemed-clock breaches

* **Key:** `discom_deemed_breaches`
* **Unit:** count
* **Definition:** Applications where the DISCOM has overshot its 15-day feasibility or commissioning clock (the project is deemed cleared).
* **Formula:** Applications with (discom_feasibility clock breached, or feasibility pending and now > feasibility_due_at) OR (certificate submitted and commissioning_at — or now if not yet commissioned — later than commissioning_due_at) OR the deemed_breach flag set. Each application counted once.
* **Source tables:** `discom_applications`, `discoms`, `clocks`
* **Exclusions:** Applications whose submitted/certificate date is outside the period; Rows outside the signed-in user's party/territory scope and outside the dashboard filters (segment, distributor, dealer)

---

## CFA pending, legacy claims and state share

`GET /dashboards/cfa-pending`

### CFA pending — value

* **Key:** `cfa_pending_value`
* **Unit:** ₹ (rupees)
* **Definition:** Central subsidy (CFA) that DISCOM has approved but which has not yet been released to the consumer / vendor.
* **Formula:** Sum of cfa_computed for subsidy claims with discom_approval_at set, released_at empty and status not released/rejected. Point-in-time (today).
* **Source tables:** `subsidy_claims`
* **Exclusions:** Released and rejected claims; Claims without DISCOM approval; Rows outside the signed-in user's party/territory scope and outside the dashboard filters (segment, distributor, dealer)

### CFA pending — age (days)

* **Key:** `cfa_pending_age_days`
* **Unit:** days
* **Definition:** How long approved CFA claims have been waiting since the DISCOM approval. Median, with the 90th percentile alongside.
* **Formula:** Median / p90 of calendar days (IST) from discom_approval_at to today over pending CFA claims. Breakdown by age band.
* **Source tables:** `subsidy_claims`
* **Exclusions:** Released and rejected claims; Claims without DISCOM approval; Rows outside the signed-in user's party/territory scope and outside the dashboard filters (segment, distributor, dealer)

### CFA release overdue

* **Key:** `cfa_release_overdue`
* **Unit:** count
* **Definition:** Pending CFA claims that have waited longer than the policy release period (15 days after DISCOM approval).
* **Formula:** Pending CFA claims with age > rule pmsg.cfa_release_days_after_discom_approval (default 15). Value in the secondary figure.
* **Source tables:** `subsidy_claims`, `rule_config`
* **Exclusions:** Released and rejected claims; Rows outside the signed-in user's party/territory scope and outside the dashboard filters (segment, distributor, dealer)

### Legacy CFA claims at risk

* **Key:** `legacy_claims_at_risk`
* **Unit:** count
* **Definition:** Legacy-cohort subsidy claims that are not yet released and are racing the 30-Nov-2026 claim deadline.
* **Formula:** Count of subsidy claims with cohort legacy and status not_ready, ready or claimed (not released, not rejected). Days to deadline = claim_deadline (or rule pmsg.claim_deadline.legacy_cohort) − today.
* **Source tables:** `subsidy_claims`, `rule_config`
* **Exclusions:** Current-cohort claims; Released and rejected claims; Rows outside the signed-in user's party/territory scope and outside the dashboard filters (segment, distributor, dealer)

### Legacy CFA claims at risk — value

* **Key:** `legacy_claims_at_risk_value`
* **Unit:** ₹ (rupees)
* **Definition:** Rupee value of legacy-cohort subsidy claims not yet released.
* **Formula:** Sum of cfa_computed over the legacy claims counted in "Legacy CFA claims at risk".
* **Source tables:** `subsidy_claims`
* **Exclusions:** Current-cohort claims; Released and rejected claims; Rows outside the signed-in user's party/territory scope and outside the dashboard filters (segment, distributor, dealer)

### Days to legacy claim deadline

* **Key:** `legacy_days_to_deadline`
* **Unit:** days
* **Definition:** Days left until the legacy-cohort CFA claim deadline (negative once passed). Advisory — the date is a medium-confidence rule.
* **Formula:** Rule pmsg.claim_deadline.legacy_cohort (fallback 2026-11-30) − today, in calendar days (IST).
* **Source tables:** `rule_config`
* **Exclusions:** Not filtered by dashboard filters — a single date

### State-share receivable

* **Key:** `state_share_receivable`
* **Unit:** ₹ (rupees)
* **Definition:** State subsidy share still to be received, aged by how long it is past its due date.
* **Formula:** Sum of state_share for claims with state_share > 0, state_share_received_at empty and status not rejected. Ageing by days past state_share_due_at (not yet due / 1–30 / 31–60 / 61–90 / 90+).
* **Source tables:** `subsidy_claims`
* **Exclusions:** Rejected claims; Claims where the state share has been received; Rows outside the signed-in user's party/territory scope and outside the dashboard filters (segment, distributor, dealer)

---

## Dealer credit exposure

`GET /dashboards/dealer-exposure`

### Dealer outstanding

* **Key:** `dealer_outstanding`
* **Unit:** ₹ (rupees)
* **Definition:** Total unpaid dealer receivables (open and overdue), with ageing by days past due. Credit limit alongside.
* **Formula:** Sum over dealers of Σ(amount − paid_amount) for receivables with status open/overdue. Ageing buckets: current (not due), 1–30, 31–60, 61–90, 90+ days past due_date. Same arithmetic as the credit lane (computeDealerExposure).
* **Source tables:** `dealer_receivables`, `dealers`
* **Exclusions:** Paid and written-off receivables; Dealers outside the scope or filters

### Dealer overdue %

* **Key:** `dealer_overdue_pct`
* **Unit:** % (0–100, 1 decimal)
* **Definition:** Share of dealer outstanding that is already past its due date.
* **Formula:** Overdue amount (all ageing buckets beyond current) ÷ total outstanding × 100.
* **Source tables:** `dealer_receivables`, `dealers`
* **Exclusions:** Paid and written-off receivables

### Dealer DSO

* **Key:** `dealer_dso_days`
* **Unit:** days
* **Definition:** Days of sales outstanding — how many days of the last 90 days' billing is still unpaid.
* **Formula:** Total outstanding ÷ invoices raised in the last 90 days (invoice_date) × 90, rounded. Per dealer in the table; portfolio figure here.
* **Source tables:** `dealer_receivables`
* **Exclusions:** Dealers with no billing in the last 90 days have no DSO

### Subsidy-linked exposure

* **Key:** `subsidy_linked_exposure`
* **Unit:** ₹ (rupees)
* **Definition:** Dealer outstanding that is only recoverable once a government subsidy is released. Shown against the total credit limit.
* **Formula:** Σ(amount − paid_amount) of open/overdue receivables flagged subsidy_linked. Percentage of limit = subsidy-linked ÷ total credit limit × 100.
* **Source tables:** `dealer_receivables`, `dealers`
* **Exclusions:** Receivables not flagged subsidy-linked

### Dealers under SOP

* **Key:** `dealers_under_sop`
* **Unit:** count
* **Definition:** Dealers with an MNRE SOP review in progress on the PM Surya Ghar portal.
* **Formula:** Dealers whose portal status (dealer record or any vendor registration) is under_sop and who are not deactivated.
* **Source tables:** `dealers`, `vendor_registrations`, `sop_cases`
* **Exclusions:** Deactivated dealers (counted separately)

### Dealers deactivated

* **Key:** `dealers_deactivated`
* **Unit:** count
* **Definition:** Dealers deactivated on the PM Surya Ghar portal — new sales orders are blocked for them.
* **Formula:** Dealers whose portal status (dealer record or any vendor registration) is deactivated.
* **Source tables:** `dealers`, `vendor_registrations`
* **Exclusions:** none

### Dealers over credit limit

* **Key:** `dealers_over_limit`
* **Unit:** count
* **Definition:** Dealers whose outstanding is higher than their approved credit limit.
* **Formula:** Dealers with outstanding > credit_limit.
* **Source tables:** `dealers`, `dealer_receivables`
* **Exclusions:** none

### Bank guarantees expiring

* **Key:** `dealer_bg_expiring`
* **Unit:** count
* **Definition:** Dealers whose bank guarantee has expired or expires within 60 days.
* **Formula:** Dealers whose latest vendor-registration bank_guarantee_valid_till is within reporting.bg_expiry_alert_days (default 60) of today or already past.
* **Source tables:** `vendor_registrations`, `dealers`
* **Exclusions:** Dealers with no bank guarantee on record

---

## Non-List-II stock exposure

`GET /dashboards/stock-exposure`

### Non-List-II cell stock — value

* **Key:** `non_list2_stock_value`
* **Unit:** ₹ (rupees)
* **Definition:** Rupee value of module stock whose cells are not on ALMM List-II, sitting in the warehouse ahead of the exemption end date.
* **Formula:** Σ unit cost of in-stock module serials whose receipt snapshot has almm_list2 = false. Unit cost = stock_batches.unit_cost, else the sku_prices base price in force today; serials with neither are counted as unpriced units (value 0).
* **Source tables:** `inventory_serials`, `skus`, `stock_batches`, `sku_prices`
* **Exclusions:** Non-module SKUs; Reserved, dispatched, installed and RMA serials; Serials whose snapshot says List-II compliant
* **Visibility:** internal users only (hidden from distributor and dealer users)

### Non-List-II cell stock — units

* **Key:** `non_list2_stock_units`
* **Unit:** count
* **Definition:** Number of module serials in stock whose cells are not on ALMM List-II.
* **Formula:** Count of in-stock module serials with compliance_snapshot.almm_list2 = false. Breakdown by SKU and batch in the dashboard.
* **Source tables:** `inventory_serials`, `skus`
* **Exclusions:** Non-module SKUs; Reserved, dispatched, installed and RMA serials
* **Visibility:** internal users only (hidden from distributor and dealer users)

### Days to List-II exemption end

* **Key:** `list2_exemption_days_left`
* **Unit:** days
* **Definition:** Days left until the ALMM List-II exemption for net-metering / open-access projects ends (commissioning date). Negative once passed.
* **Formula:** Rule almm.list2.exemption_net_metering_open_access_until (fallback 2026-12-31) − today, in calendar days (IST).
* **Source tables:** `rule_config`
* **Exclusions:** Not filtered by dashboard filters — a single date
* **Visibility:** internal users only (hidden from distributor and dealer users)

---

## Compliance, re-quote and RMA

`GET /dashboards/compliance`

### Compliance-block rate

* **Key:** `compliance_block_rate_pct`
* **Unit:** % (0–100, 1 decimal)
* **Definition:** Share of drafted quotations that were stopped by a hard compliance gate (G2–G6: DCR, ALMM List-I, List-II, exemption date, BIS).
* **Formula:** Quotations created in the period with at least one hard_stop finding for gates G2–G6 ÷ all quotations created in the period × 100. Overridden hard stops still count (the quote was blocked). Breakdown: quotes per gate.
* **Source tables:** `quotations`
* **Exclusions:** Hard stops from other gates (G1, G7–G14); Rows outside the signed-in user's party/territory scope and outside the dashboard filters (segment, distributor, dealer)

### Re-quote rate

* **Key:** `requote_rate_pct`
* **Unit:** % (0–100, 1 decimal)
* **Definition:** Share of issued quotations that had to be re-quoted because a price, duty, GST or compliance rule changed.
* **Formula:** Quotations created in the period flagged requote_required (status or requote_reason) ÷ quotations issued (sent_at set, or status sent/negotiation/accepted/requote_required/expired/revised, or flagged) × 100.
* **Source tables:** `quotations`
* **Exclusions:** Quotations never issued (draft, blocked, pending approval); Rows outside the signed-in user's party/territory scope and outside the dashboard filters (segment, distributor, dealer)

### Re-quote price-change leakage

* **Key:** `price_change_margin_leakage`
* **Unit:** ₹ (rupees)
* **Definition:** Rupees of margin at risk on re-quote-flagged quotations if the old prices were honoured at today's price list.
* **Formula:** For each flagged quotation: Σ over lines with a SKU price in force today of qty × base_price × (1 − line discount %) (other lines at their quoted total) − quoted subtotal; leakage = Σ max(0, difference). Pre-tax.
* **Source tables:** `quotations`, `quotation_lines`, `sku_prices`
* **Exclusions:** Quotations not flagged for re-quote; Negative differences (price falls) are reported per quote but not counted as leakage; Rows outside the signed-in user's party/territory scope and outside the dashboard filters (segment, distributor, dealer)
* **Visibility:** internal users only (hidden from distributor and dealer users)

### RMA turnaround

* **Key:** `rma_turnaround_days`
* **Unit:** days
* **Definition:** Typical time to close a return/replacement (RMA) ticket. Median, with the 90th percentile alongside.
* **Formula:** Median / p90 of (closed_at − opened_at) in days over RMA tickets closed in the period.
* **Source tables:** `warranty_tickets`
* **Exclusions:** Open tickets; Non-RMA ticket types; Rows outside the signed-in user's party/territory scope and outside the dashboard filters (segment, distributor, dealer)

### RMA claim recovery from brand

* **Key:** `rma_brand_recovery`
* **Unit:** ₹ (rupees)
* **Definition:** Rupees recovered from the brand against warranty / RMA claims raised in the period.
* **Formula:** Σ recovered_amount of tickets opened in the period that carry a brand claim number or have the brand as cost bearer.
* **Source tables:** `warranty_tickets`
* **Exclusions:** Tickets with no brand claim; Rows outside the signed-in user's party/territory scope and outside the dashboard filters (segment, distributor, dealer)

### RMA brand claims recovered

* **Key:** `rma_brand_recovery_rate_pct`
* **Unit:** % (0–100, 1 decimal)
* **Definition:** Share of brand warranty claims raised in the period against which money has actually been recovered.
* **Formula:** Brand-claim tickets with recovered_amount > 0 ÷ brand-claim tickets × 100.
* **Source tables:** `warranty_tickets`
* **Exclusions:** Tickets with no brand claim; Rows outside the signed-in user's party/territory scope and outside the dashboard filters (segment, distributor, dealer)

### Open overrides

* **Key:** `open_overrides`
* **Unit:** count
* **Definition:** Compliance and credit overrides requested and still waiting for a decision.
* **Formula:** Pending approvals of type compliance_override plus credit_overrides with status pending.
* **Source tables:** `approvals`, `credit_overrides`
* **Exclusions:** Decided overrides
* **Visibility:** internal users only (hidden from distributor and dealer users)

---

## Consent coverage and blocked messages

`GET /dashboards/consent`

### Consent coverage

* **Key:** `consent_coverage_pct`
* **Unit:** % (0–100, 1 decimal)
* **Definition:** Share of leads that had a valid, un-withdrawn consent on record before we first contacted them.
* **Formula:** Valid leads created in the period with a consent row (granted_at ≤ first outbound message, not withdrawn before it; or simply not withdrawn when nothing has been sent yet) ÷ valid leads × 100. First outbound = earliest sent/queued outbound message_log row.
* **Source tables:** `leads`, `lead_consents`, `message_log`
* **Exclusions:** Duplicate and merged leads; soft-deleted leads; Blocked messages (they never reached the customer); Rows outside the signed-in user's party/territory scope and outside the dashboard filters (segment, distributor, dealer)
* **Target:** at least 100 (Operating default; rule `kpi.target.consent_coverage_pct`, advisory)

### Consents withdrawn

* **Key:** `consent_withdrawn`
* **Unit:** count
* **Definition:** Consents withdrawn by customers in the period (one-click withdrawal or STOP keyword).
* **Formula:** Count of lead_consents with withdrawn_at in the period. Breakdown by withdrawal channel.
* **Source tables:** `lead_consents`, `leads`
* **Exclusions:** Rows outside the signed-in user's party/territory scope and outside the dashboard filters (segment, distributor, dealer)

### Leads under opt-out suppression

* **Key:** `consent_suppressed`
* **Unit:** count
* **Definition:** Leads currently inside the 90-day post-opt-out window in which promotional contact is blocked.
* **Formula:** Distinct leads with a consent row whose optout_suppress_until is later than now.
* **Source tables:** `lead_consents`, `leads`
* **Exclusions:** Rows outside the signed-in user's party/territory scope and outside the dashboard filters (segment, distributor, dealer)

### Messages blocked by DND

* **Key:** `dnd_blocked_messages`
* **Unit:** count
* **Definition:** Outbound messages the system refused to send because the number is on the DND register or the DND check was missing/stale.
* **Formula:** Count of message_log rows with status blocked in the period whose block reason is DND_REGISTERED, DND_UNCHECKED or DND_STALE. Secondary figure: leads currently marked registered/blocked on DND.
* **Source tables:** `message_log`, `leads`
* **Exclusions:** Messages not linked to a visible lead; Rows outside the signed-in user's party/territory scope and outside the dashboard filters (segment, distributor, dealer)

### Blocked messages

* **Key:** `blocked_messages`
* **Unit:** count
* **Definition:** All outbound messages the consent pipeline refused to send in the period, by reason.
* **Formula:** Count of message_log rows with status blocked in the period. Breakdown by block reason code.
* **Source tables:** `message_log`, `leads`
* **Exclusions:** Messages not linked to a visible lead; Rows outside the signed-in user's party/territory scope and outside the dashboard filters (segment, distributor, dealer)

