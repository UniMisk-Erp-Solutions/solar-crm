-- =====================================================================================================
-- 10_views.sql
-- Purpose : dashboard / KPI views (prompt.md Section 14).
--             v_funnel, v_lead_sla_breaches, v_followup_overdue, v_discom_stage_ageing, v_cfa_pending,
--             v_dealer_exposure, v_stock_exposure_non_list2, v_compliance_block_rate, v_consent_coverage
-- Run after: 09_rls_policies.sql
-- Idempotent: `create or replace view`.
--
-- PARITY NOTE
--   The Node API computes the same KPIs in TypeScript (services/reporting, services/exposure) so that demo mode (in-memory
--   store) and live mode (Supabase) return identical numbers. These views are the SQL / BI-tool equivalent: they serve
--   SQL consoles, Metabase / Power BI style tools and ad-hoc analysis, and they are the reference definition if the two
--   ever disagree.
--
-- SECURITY
--   Every view is `security_invoker = true`: it runs with the privileges (and therefore the row level security) of the
--   caller, so a direct client only sees rows its policies allow. The API's service role sees everything, as designed.
--   All dates use the IST calendar (Asia/Kolkata).
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- v_funnel : counts at the six conversion gates, by segment (Valid Lead -> Qualified Lead -> Opportunity ->
--            Quotation -> PI -> Sales Order) plus the five stage-to-stage conversion percentages.
--   valid_leads      : live (not deleted) leads that are neither duplicate nor merged
--   qualified_leads  : valid leads whose status is qualified / site_visit / opportunity / won, or that already have an opportunity
--   opportunities    : opportunities
--   quotations       : distinct opportunities with at least one quotation (any version)
--   proforma_invoices: distinct opportunities with at least one non-cancelled PI
--   sales_orders     : distinct opportunities with at least one non-cancelled sales order
--   Leads without a segment are reported under segment 'unknown'.
-- -----------------------------------------------------------------------------------------------------
create or replace view v_funnel with (security_invoker = true) as
with stage_events as (
  select l.org_id, coalesce(l.segment::text, 'unknown') as segment, 'valid_lead'::text as stage, l.id as entity_key
    from leads l
   where l.deleted_at is null and l.status not in ('duplicate', 'merged')
  union all
  select l.org_id, coalesce(l.segment::text, 'unknown'), 'qualified_lead', l.id
    from leads l
   where l.deleted_at is null and l.status not in ('duplicate', 'merged')
     and (l.status in ('qualified', 'site_visit', 'opportunity', 'won')
          or exists (select 1 from opportunities o where o.lead_id = l.id))
  union all
  select o.org_id, o.segment::text, 'opportunity', o.id
    from opportunities o
  union all
  select q.org_id, q.segment::text, 'quotation', q.opportunity_id
    from quotations q
  union all
  select qp.org_id, qp.segment::text, 'proforma_invoice', qp.opportunity_id
    from proforma_invoices p
    join quotations qp on qp.id = p.quote_id
   where p.status <> 'cancelled'
  union all
  select qs.org_id, s.segment::text, 'sales_order', coalesce(s.opportunity_id, qs.opportunity_id)
    from sales_orders s
    join quotations qs on qs.id = s.quote_id
   where s.status <> 'cancelled'
),
counts as (
  select e.org_id, e.segment,
         count(distinct e.entity_key) filter (where e.stage = 'valid_lead')        as valid_leads,
         count(distinct e.entity_key) filter (where e.stage = 'qualified_lead')    as qualified_leads,
         count(distinct e.entity_key) filter (where e.stage = 'opportunity')       as opportunities,
         count(distinct e.entity_key) filter (where e.stage = 'quotation')         as quotations,
         count(distinct e.entity_key) filter (where e.stage = 'proforma_invoice')  as proforma_invoices,
         count(distinct e.entity_key) filter (where e.stage = 'sales_order')       as sales_orders
    from stage_events e
   group by e.org_id, e.segment
)
select c.org_id, c.segment,
       c.valid_leads, c.qualified_leads, c.opportunities, c.quotations, c.proforma_invoices, c.sales_orders,
       round(100.0 * c.qualified_leads   / nullif(c.valid_leads, 0), 1)       as inquiry_to_qualified_pct,
       round(100.0 * c.opportunities     / nullif(c.qualified_leads, 0), 1)   as qualified_to_opportunity_pct,
       round(100.0 * c.quotations        / nullif(c.opportunities, 0), 1)     as opportunity_to_quotation_pct,
       round(100.0 * c.proforma_invoices / nullif(c.quotations, 0), 1)        as quotation_to_pi_pct,
       round(100.0 * c.sales_orders      / nullif(c.proforma_invoices, 0), 1) as pi_to_so_pct
  from counts c;

-- -----------------------------------------------------------------------------------------------------
-- v_lead_sla_breaches : leads currently breaching an SLA.
--   sla_kind 'acceptance'     : assigned, not yet accepted, and sla_due_at has passed
--   sla_kind 'first_response' : no first contact yet and the window has passed (30 minutes for HOT leads, otherwise 24 hours,
--                               counted from lead creation)
-- -----------------------------------------------------------------------------------------------------
create or replace view v_lead_sla_breaches with (security_invoker = true) as
select l.org_id, l.id as lead_id, l.name, l.segment, l.temperature, l.status,
       l.owner_id, l.distributor_id, l.dealer_id, l.territory_id,
       'acceptance'::text as sla_kind,
       l.assigned_at as started_at,
       l.sla_due_at as due_at,
       round(extract(epoch from (now() - l.sla_due_at)) / 60)::integer as minutes_overdue
  from leads l
 where l.deleted_at is null and l.accepted_at is null and l.status = 'assigned'
   and l.sla_due_at is not null and l.sla_due_at < now()
union all
select f.org_id, f.id, f.name, f.segment, f.temperature, f.status,
       f.owner_id, f.distributor_id, f.dealer_id, f.territory_id,
       'first_response'::text,
       f.created_at,
       f.created_at + case when f.temperature = 'hot' then interval '30 minutes' else interval '24 hours' end,
       round(extract(epoch from (now() - (f.created_at + case when f.temperature = 'hot' then interval '30 minutes' else interval '24 hours' end))) / 60)::integer
  from leads f
 where f.deleted_at is null and f.first_contacted_at is null
   and f.status not in ('duplicate', 'merged', 'lost', 'won', 'nurture')
   and f.created_at + case when f.temperature = 'hot' then interval '30 minutes' else interval '24 hours' end < now();

-- -----------------------------------------------------------------------------------------------------
-- v_followup_overdue : open follow-ups past due, plus leads whose mandatory next_followup_at has passed with no open
--                      follow-up record. source is 'followup' or 'lead_next_followup'.
-- -----------------------------------------------------------------------------------------------------
create or replace view v_followup_overdue with (security_invoker = true) as
select fu.org_id, 'followup'::text as source, fu.id as followup_id, fu.lead_id, ld.name as lead_name,
       fu.kind::text as kind, fu.due_at, fu.owner_id, fu.escalated_level,
       ld.distributor_id, ld.dealer_id, ld.territory_id,
       round((extract(epoch from (now() - fu.due_at)) / 3600)::numeric, 1) as hours_overdue
  from followups fu
  join leads ld on ld.id = fu.lead_id
 where fu.status = 'open' and fu.due_at < now()
   and ld.deleted_at is null and ld.status not in ('lost', 'won', 'duplicate', 'merged')
union all
select nl.org_id, 'lead_next_followup'::text, null::uuid, nl.id, nl.name,
       'task'::text, nl.next_followup_at, nl.owner_id, 0,
       nl.distributor_id, nl.dealer_id, nl.territory_id,
       round((extract(epoch from (now() - nl.next_followup_at)) / 3600)::numeric, 1)
  from leads nl
 where nl.deleted_at is null and nl.next_followup_at is not null and nl.next_followup_at < now()
   and nl.status not in ('lost', 'won', 'duplicate', 'merged')
   and not exists (select 1 from followups f2 where f2.lead_id = nl.id and f2.status = 'open');

-- -----------------------------------------------------------------------------------------------------
-- v_discom_stage_ageing : median and 90th-percentile days per DISCOM per stage, plus deemed-clock breaches.
--   Stage intervals (completed intervals only):
--     feasibility   : application complete (complete_at)        -> inspection (inspection_at)
--     inspection    : inspection (inspection_at)                -> meter installed (meter_at)
--     meter         : meter installed (meter_at)                -> commissioning (commissioning_at)
--     commissioning : certificate submitted (certificate_submitted_at) -> commissioning (commissioning_at)
--   Breach columns are PER DISCOM and repeated on each of its stage rows:
--     deemed_breaches            : applications flagged deemed_breach
--     feasibility_overdue_open   : feasibility still pending after feasibility_due_at
--     commissioning_overdue_open : not yet commissioned after commissioning_due_at
-- -----------------------------------------------------------------------------------------------------
create or replace view v_discom_stage_ageing with (security_invoker = true) as
with stage_durations as (
  select a.org_id, a.discom_id, s.stage,
         extract(epoch from (s.finished_at - s.started_at)) / 86400.0 as days
    from discom_applications a
   cross join lateral (values
           ('feasibility'::text,   a.complete_at,               a.inspection_at),
           ('inspection'::text,    a.inspection_at,             a.meter_at),
           ('meter'::text,         a.meter_at,                  a.commissioning_at),
           ('commissioning'::text, a.certificate_submitted_at,  a.commissioning_at)
         ) as s (stage, started_at, finished_at)
   where s.started_at is not null and s.finished_at is not null and s.finished_at >= s.started_at
),
breaches as (
  select b.org_id, b.discom_id,
         count(*) as applications,
         count(*) filter (where b.deemed_breach) as deemed_breaches,
         count(*) filter (where b.feasibility_status = 'pending' and b.feasibility_due_at < now()) as feasibility_overdue_open,
         count(*) filter (where b.commissioning_at is null and b.commissioning_due_at < now()) as commissioning_overdue_open
    from discom_applications b
   group by b.org_id, b.discom_id
)
select d.org_id, d.discom_id, dc.code as discom_code, dc.name as discom_name, d.stage,
       count(*) as sample_size,
       round((percentile_cont(0.5) within group (order by d.days))::numeric, 1) as median_days,
       round((percentile_cont(0.9) within group (order by d.days))::numeric, 1) as p90_days,
       max(br.applications) as applications,
       max(br.deemed_breaches) as deemed_breaches,
       max(br.feasibility_overdue_open) as feasibility_overdue_open,
       max(br.commissioning_overdue_open) as commissioning_overdue_open
  from stage_durations d
  left join discoms dc on dc.id = d.discom_id
  left join breaches br on br.org_id = d.org_id and br.discom_id is not distinct from d.discom_id
 group by d.org_id, d.discom_id, dc.code, dc.name, d.stage;

-- -----------------------------------------------------------------------------------------------------
-- v_cfa_pending : central financial assistance not yet released - value and age since DISCOM approval, with the legacy
--   cohort flag. legacy_at_risk = legacy cohort, claim not released, and the claim deadline is past or within
--   temperature.deadline_uplift_days (rule, default 60) days.
-- -----------------------------------------------------------------------------------------------------
create or replace view v_cfa_pending with (security_invoker = true) as
select c.org_id, c.id as claim_id, c.sales_order_id, c.customer_id, c.dealer_id, c.distributor_id,
       c.cohort, c.status, c.cfa_computed, c.state_share, c.discom_approval_at,
       case when c.discom_approval_at is null then null
            else (timezone('Asia/Kolkata', now()))::date - (timezone('Asia/Kolkata', c.discom_approval_at))::date
       end as age_days_since_discom_approval,
       (c.cohort = 'legacy') as is_legacy_cohort,
       c.claim_deadline,
       case when c.claim_deadline is null then null
            else c.claim_deadline - (timezone('Asia/Kolkata', now()))::date
       end as days_to_claim_deadline,
       (c.cohort = 'legacy'
        and c.claim_deadline is not null
        and c.claim_deadline - (timezone('Asia/Kolkata', now()))::date
            <= coalesce((app.rule_value(c.org_id, 'temperature', 'deadline_uplift_days') #>> '{}')::integer, 60)) as legacy_at_risk
  from subsidy_claims c
 where c.status in ('not_ready', 'ready', 'claimed');

-- -----------------------------------------------------------------------------------------------------
-- v_dealer_exposure : per dealer - limit, outstanding (open + overdue receivables), ageing buckets by days past due,
--   overdue amount / %, subsidy-linked exposure (and as % of limit), DSO and portal / SOP status.
--   DSO = outstanding / invoices raised in the last 90 days * 90 (NULL when nothing was billed).
-- -----------------------------------------------------------------------------------------------------
create or replace view v_dealer_exposure with (security_invoker = true) as
with open_items as (
  select r.org_id, r.dealer_id,
         greatest(0, r.amount - r.paid_amount) as open_amount,
         (timezone('Asia/Kolkata', now()))::date - r.due_date as days_past_due,
         r.subsidy_linked
    from dealer_receivables r
   where r.status in ('open', 'overdue') and r.amount > r.paid_amount
),
open_agg as (
  select oi.org_id, oi.dealer_id,
         sum(oi.open_amount) as outstanding,
         coalesce(sum(oi.open_amount) filter (where oi.days_past_due <= 0), 0) as age_current,
         coalesce(sum(oi.open_amount) filter (where oi.days_past_due between 1 and 30), 0) as age_1_30,
         coalesce(sum(oi.open_amount) filter (where oi.days_past_due between 31 and 60), 0) as age_31_60,
         coalesce(sum(oi.open_amount) filter (where oi.days_past_due between 61 and 90), 0) as age_61_90,
         coalesce(sum(oi.open_amount) filter (where oi.days_past_due > 90), 0) as age_90_plus,
         coalesce(sum(oi.open_amount) filter (where oi.subsidy_linked), 0) as subsidy_linked,
         count(*) as invoices_open
    from open_items oi
   group by oi.org_id, oi.dealer_id
),
billed as (
  select b.org_id, b.dealer_id, sum(b.amount) as billed_90d
    from dealer_receivables b
   where b.invoice_date >= (timezone('Asia/Kolkata', now()))::date - 90
   group by b.org_id, b.dealer_id
)
select dl.org_id, dl.id as dealer_id, dl.legal_name as dealer_name, dl.distributor_id,
       dl.credit_limit,
       coalesce(a.outstanding, 0) as outstanding,
       dl.credit_limit - coalesce(a.outstanding, 0) as available,
       (coalesce(a.outstanding, 0) > dl.credit_limit) as over_limit,
       round(100.0 * coalesce(a.outstanding, 0) / nullif(dl.credit_limit, 0), 1) as utilisation_pct,
       coalesce(a.age_current, 0) as age_current,
       coalesce(a.age_1_30, 0) as age_1_30,
       coalesce(a.age_31_60, 0) as age_31_60,
       coalesce(a.age_61_90, 0) as age_61_90,
       coalesce(a.age_90_plus, 0) as age_90_plus,
       coalesce(a.age_1_30 + a.age_31_60 + a.age_61_90 + a.age_90_plus, 0) as overdue_amount,
       round(100.0 * coalesce(a.age_1_30 + a.age_31_60 + a.age_61_90 + a.age_90_plus, 0) / nullif(a.outstanding, 0), 1) as overdue_pct,
       coalesce(a.subsidy_linked, 0) as subsidy_linked,
       round(100.0 * coalesce(a.subsidy_linked, 0) / nullif(dl.credit_limit, 0), 1) as subsidy_linked_pct_of_limit,
       round(coalesce(a.outstanding, 0) / nullif(bl.billed_90d, 0) * 90) as dso_days,
       coalesce(a.invoices_open, 0) as invoices_open,
       dl.portal_status,
       dl.status as dealer_status,
       (select count(*) from sop_cases sc
         where sc.dealer_id = dl.id and sc.stage in ('reply', 'reminder', 'show_cause', 'deactivation', 'appeal')) as sop_open
  from dealers dl
  left join open_agg a on a.dealer_id = dl.id
  left join billed bl on bl.dealer_id = dl.id;

-- -----------------------------------------------------------------------------------------------------
-- v_stock_exposure_non_list2 : in-stock MODULE serials whose compliance snapshot is not ALMM List-II - units and value
--   by SKU - with the exemption end date (rule almm.list2.exemption_net_metering_open_access_until, fallback 2026-12-31)
--   and the days left. Value = batch unit cost, else the SKU's current base price, else 0.
-- -----------------------------------------------------------------------------------------------------
create or replace view v_stock_exposure_non_list2 with (security_invoker = true) as
select se.org_id, se.sku_id, k.make, k.model, k.variant,
       count(*) as units,
       sum(coalesce(b.unit_cost, p.base_price, 0)) as value,
       coalesce(nullif(app.rule_value(se.org_id, 'almm', 'list2.exemption_net_metering_open_access_until') #>> '{}', '')::date, date '2026-12-31') as exemption_end_date,
       coalesce(nullif(app.rule_value(se.org_id, 'almm', 'list2.exemption_net_metering_open_access_until') #>> '{}', '')::date, date '2026-12-31')
         - (timezone('Asia/Kolkata', now()))::date as days_to_exemption_end
  from inventory_serials se
  join skus k on k.id = se.sku_id
  left join stock_batches b on b.id = se.batch_id
  left join lateral (
    select pr.base_price
      from sku_prices pr
     where pr.sku_id = se.sku_id
       and pr.valid_from <= (timezone('Asia/Kolkata', now()))::date
       and (pr.valid_to is null or pr.valid_to >= (timezone('Asia/Kolkata', now()))::date)
     order by pr.valid_from desc
     limit 1
  ) p on true
 where se.status = 'in_stock'
   and k.category = 'module'
   and coalesce((se.compliance_snapshot ->> 'almm_list2')::boolean, false) = false
 group by se.org_id, se.sku_id, k.make, k.model, k.variant;

-- -----------------------------------------------------------------------------------------------------
-- v_compliance_block_rate : per month - quotes drafted, and quotes carrying a hard-stop finding from gates G2-G6
--   (overridden or not), with the block rate and the count per gate. A quote counts once per gate it was stopped by.
-- -----------------------------------------------------------------------------------------------------
create or replace view v_compliance_block_rate with (security_invoker = true) as
select q.org_id,
       date_trunc('month', timezone('Asia/Kolkata', q.created_at))::date as month,
       count(*) as quotes_drafted,
       count(*) filter (where g.g2 or g.g3 or g.g4 or g.g5 or g.g6) as quotes_blocked_g2_g6,
       round(100.0 * count(*) filter (where g.g2 or g.g3 or g.g4 or g.g5 or g.g6) / nullif(count(*), 0), 1) as block_rate_pct,
       count(*) filter (where g.g2) as blocked_g2_dcr,
       count(*) filter (where g.g3) as blocked_g3_almm_list1,
       count(*) filter (where g.g4) as blocked_g4_almm_list2,
       count(*) filter (where g.g5) as blocked_g5_exemption,
       count(*) filter (where g.g6) as blocked_g6_bis
  from quotations q
 cross join lateral (
   select coalesce(bool_or((f ->> 'gate') = 'G2' and (f ->> 'severity') = 'hard_stop'), false) as g2,
          coalesce(bool_or((f ->> 'gate') = 'G3' and (f ->> 'severity') = 'hard_stop'), false) as g3,
          coalesce(bool_or((f ->> 'gate') = 'G4' and (f ->> 'severity') = 'hard_stop'), false) as g4,
          coalesce(bool_or((f ->> 'gate') = 'G5' and (f ->> 'severity') = 'hard_stop'), false) as g5,
          coalesce(bool_or((f ->> 'gate') = 'G6' and (f ->> 'severity') = 'hard_stop'), false) as g6
     from jsonb_array_elements(case when jsonb_typeof(q.compliance_findings) = 'array' then q.compliance_findings else '[]'::jsonb end) as f
 ) g
 group by q.org_id, date_trunc('month', timezone('Asia/Kolkata', q.created_at))::date;

-- -----------------------------------------------------------------------------------------------------
-- v_consent_coverage : by organisation and lead source - how many valid leads have an active (non-withdrawn) consent, a
--   promotional consent, a clear DND status, and how many are inside a 90-day opt-out suppression window.
-- -----------------------------------------------------------------------------------------------------
create or replace view v_consent_coverage with (security_invoker = true) as
select l.org_id, l.source,
       count(*) as leads_total,
       count(*) filter (where c.active_consent) as with_active_consent,
       round(100.0 * count(*) filter (where c.active_consent) / nullif(count(*), 0), 1) as consent_coverage_pct,
       count(*) filter (where c.promotional_consent) as with_promotional_consent,
       count(*) filter (where c.has_any and not c.active_consent) as all_consents_withdrawn,
       count(*) filter (where l.dnd_status = 'clear') as dnd_clear,
       count(*) filter (where c.suppressed) as opt_out_suppressed
  from leads l
 cross join lateral (
   select coalesce(bool_or(lc.withdrawn_at is null), false) as active_consent,
          coalesce(bool_or(lc.withdrawn_at is null and 'promotional' = any (lc.purposes)), false) as promotional_consent,
          coalesce(bool_or(lc.optout_suppress_until is not null and lc.optout_suppress_until > now()), false) as suppressed,
          (count(*) > 0) as has_any
     from lead_consents lc
    where lc.lead_id = l.id
 ) c
 where l.deleted_at is null and l.status not in ('duplicate', 'merged')
 group by l.org_id, l.source;

-- -----------------------------------------------------------------------------------------------------
-- Privileges: signed-in users read through RLS (security_invoker); anonymous users get nothing.
-- -----------------------------------------------------------------------------------------------------
revoke all on v_funnel, v_lead_sla_breaches, v_followup_overdue, v_discom_stage_ageing, v_cfa_pending,
  v_dealer_exposure, v_stock_exposure_non_list2, v_compliance_block_rate, v_consent_coverage from anon;
grant select on v_funnel, v_lead_sla_breaches, v_followup_overdue, v_discom_stage_ageing, v_cfa_pending,
  v_dealer_exposure, v_stock_exposure_non_list2, v_compliance_block_rate, v_consent_coverage to authenticated, service_role;
