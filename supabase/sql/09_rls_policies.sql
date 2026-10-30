-- =====================================================================================================
-- 09_rls_policies.sql
-- Purpose : Row Level Security - helper functions, RLS enabled on EVERY table, and the policies.
-- Run after: 08_functions_triggers.sql
-- Idempotent: functions use `create or replace`; every policy is dropped then recreated.
--
-- IMPORTANT - how this fits with the Node API
--   The API connects with the Supabase SERVICE-ROLE key, which BYPASSES row level security. The API's own
--   authorisation middleware (apps/api/src/auth/access.ts) is therefore the primary control. These policies are
--   DEFENCE IN DEPTH for anyone who reaches the database directly with a user JWT (the anon / authenticated roles):
--   the policies mirror access.ts:
--     * INTERNAL roles (admin, management, regional_head, sales_manager, dsm, techno_commercial, accounts,
--       compliance_officer, dispatch, viewer) see their whole organisation - except that a profile with
--       territory_ids set only sees leads / opportunities / quotations / sales_orders in those territories.
--     * EXTERNAL roles see only their own party's rows on the mapped tables and nothing else (apart from harmless
--       reference data: discoms, pincodes, segment form config, active SKUs):
--         distributor_user : leads, opportunities, quotations, sales_orders, proforma_invoices, credit_checks, loans,
--                            discom_applications, subsidy_claims, installations, dealer_receivables (distributor_id = own),
--                            warranty_tickets (dealers of own distributor), dealers (own), distributors (own)
--         dealer_user      : the same tables via dealer_id = own dealer; dealers (self); distributors (own parent)
--     * WRITE policies exist for internal roles only (per table, see below). External users never write directly.
--     * audit_log, lead_events, message_log (and distributor_score_history) are INSERT-ONLY: no update / delete
--       policy exists, UPDATE / DELETE / TRUNCATE are revoked, and triggers (08) block them for everyone.
--   Helper functions are SECURITY DEFINER with a fixed search_path and read `profiles` by the JWT user id, so policies
--   cannot be bypassed by editing client-side claims.
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- Helper functions
-- -----------------------------------------------------------------------------------------------------
create or replace function app.current_org() returns uuid
language sql stable security definer
set search_path = public
as $$
  select p.org_id from public.profiles p where p.id = app.current_uid() and p.active
$$;

create or replace function app.current_role() returns public.app_role
language sql stable security definer
set search_path = public
as $$
  select p.role from public.profiles p where p.id = app.current_uid() and p.active
$$;

create or replace function app.current_distributor() returns uuid
language sql stable security definer
set search_path = public
as $$
  select p.distributor_id from public.profiles p where p.id = app.current_uid() and p.active
$$;

create or replace function app.current_dealer() returns uuid
language sql stable security definer
set search_path = public
as $$
  select p.dealer_id from public.profiles p where p.id = app.current_uid() and p.active
$$;

-- True for the ten internal roles (everything except distributor_user and dealer_user).
create or replace function app.is_internal() returns boolean
language sql stable security definer
set search_path = public
as $$
  select coalesce(
    (select p.role not in ('distributor_user', 'dealer_user') from public.profiles p where p.id = app.current_uid() and p.active),
    false
  )
$$;

-- True when the current user's role is one of the listed roles, e.g. app.role_in('admin', 'dsm').
create or replace function app.role_in(variadic p_roles text[]) returns boolean
language sql stable security definer
set search_path = public
as $$
  select coalesce(
    (select p.role::text = any (p_roles) from public.profiles p where p.id = app.current_uid() and p.active),
    false
  )
$$;

-- Territory restriction: a profile with no territory_ids sees everything; otherwise only rows in its territories
-- (rows without a territory are hidden from restricted users, exactly like access.ts).
create or replace function app.territory_ok(p_territory uuid) returns boolean
language sql stable security definer
set search_path = public
as $$
  select coalesce(
    (select cardinality(p.territory_ids) = 0 or p_territory = any (p.territory_ids)
       from public.profiles p where p.id = app.current_uid() and p.active),
    false
  )
$$;

-- Dealer ids that belong to the current user's distributor.
create or replace function app.distributor_dealer_ids() returns setof uuid
language sql stable security definer
set search_path = public
as $$
  select d.id
    from public.dealers d
   where d.distributor_id = (select p.distributor_id from public.profiles p where p.id = app.current_uid() and p.active)
$$;

-- Plain table privileges: the CRM has no anonymous access (public lead capture goes through the API's service role).
revoke all on all tables in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;

grant execute on function app.current_uid(), app.current_org(), app.current_role(), app.current_distributor(), app.current_dealer(),
  app.is_internal(), app.role_in(variadic text[]), app.territory_ok(uuid), app.distributor_dealer_ids(),
  app.rule_value(uuid, text, text, date) to authenticated, service_role;

-- Row level security enabled on EVERY table
alter table public.organizations enable row level security;
alter table public.profiles enable row level security;
alter table public.discoms enable row level security;
alter table public.territories enable row level security;
alter table public.user_territories enable row level security;
alter table public.pincodes enable row level security;
alter table public.distributors enable row level security;
alter table public.dealers enable row level security;
alter table public.vendor_registrations enable row level security;
alter table public.sop_cases enable row level security;
alter table public.distributor_score_history enable row level security;
alter table public.leads enable row level security;
alter table public.lead_consents enable row level security;
alter table public.lead_events enable row level security;
alter table public.lead_assignments enable row level security;
alter table public.followups enable row level security;
alter table public.contact_logs enable row level security;
alter table public.dnd_register enable row level security;
alter table public.lead_scores enable row level security;
alter table public.source_api_keys enable row level security;
alter table public.customers enable row level security;
alter table public.sites enable row level security;
alter table public.site_surveys enable row level security;
alter table public.opportunities enable row level security;
alter table public.requirement_forms enable row level security;
alter table public.segment_form_config enable row level security;
alter table public.negotiation_logs enable row level security;
alter table public.skus enable row level security;
alter table public.sku_compliance enable row level security;
alter table public.sku_prices enable row level security;
alter table public.stock_batches enable row level security;
alter table public.inventory_serials enable row level security;
alter table public.quotations enable row level security;
alter table public.quotation_lines enable row level security;
alter table public.quote_discussions enable row level security;
alter table public.approval_rules enable row level security;
alter table public.approvals enable row level security;
alter table public.proforma_invoices enable row level security;
alter table public.proforma_invoice_lines enable row level security;
alter table public.payments enable row level security;
alter table public.credit_checks enable row level security;
alter table public.credit_overrides enable row level security;
alter table public.sales_orders enable row level security;
alter table public.sales_order_lines enable row level security;
alter table public.dispatches enable row level security;
alter table public.dispatch_serials enable row level security;
alter table public.einvoice_status enable row level security;
alter table public.documents enable row level security;
alter table public.loans enable row level security;
alter table public.discom_applications enable row level security;
alter table public.subsidy_claims enable row level security;
alter table public.installations enable row level security;
alter table public.warranty_tickets enable row level security;
alter table public.dealer_receivables enable row level security;
alter table public.rule_config enable row level security;
alter table public.clocks enable row level security;
alter table public.notifications enable row level security;
alter table public.message_templates enable row level security;
alter table public.message_log enable row level security;
alter table public.kpi_snapshots enable row level security;
alter table public.audit_log enable row level security;
alter table public.compliance_calendar_items enable row level security;
alter table public.job_runs enable row level security;
alter table public.verify_register enable row level security;
alter table public.gate_applicability enable row level security;
alter table public.breach_incidents enable row level security;
alter table public.data_requests enable row level security;

-- Policies (one block per table: read rule, then write rule)
-- organizations
drop policy if exists organizations_select on public.organizations;
create policy organizations_select on public.organizations for select to authenticated
  using (id = (select app.current_org()));
drop policy if exists organizations_update on public.organizations;
create policy organizations_update on public.organizations for update to authenticated
  using (id = (select app.current_org()) and app.role_in('admin'))
  with check (id = (select app.current_org()) and app.role_in('admin'));
-- profiles
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = (select app.current_uid()) or (org_id = (select app.current_org()) and (select app.is_internal())));
drop policy if exists profiles_write on public.profiles;
create policy profiles_write on public.profiles for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin'))
  with check (org_id = (select app.current_org()) and app.role_in('admin'));
-- discoms
drop policy if exists discoms_select on public.discoms;
create policy discoms_select on public.discoms for select to authenticated
  using (org_id = (select app.current_org()));
drop policy if exists discoms_write on public.discoms;
create policy discoms_write on public.discoms for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin'))
  with check (org_id = (select app.current_org()) and app.role_in('admin'));
-- territories
drop policy if exists territories_select on public.territories;
create policy territories_select on public.territories for select to authenticated
  using (org_id = (select app.current_org()) and (select app.is_internal()));
drop policy if exists territories_write on public.territories;
create policy territories_write on public.territories for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head'))
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head'));
-- user_territories
drop policy if exists user_territories_select on public.user_territories;
create policy user_territories_select on public.user_territories for select to authenticated
  using (org_id = (select app.current_org()) and (select app.is_internal()));
drop policy if exists user_territories_write on public.user_territories;
create policy user_territories_write on public.user_territories for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin'))
  with check (org_id = (select app.current_org()) and app.role_in('admin'));
-- pincodes
drop policy if exists pincodes_select on public.pincodes;
create policy pincodes_select on public.pincodes for select to authenticated
  using (org_id = (select app.current_org()));
drop policy if exists pincodes_write on public.pincodes;
create policy pincodes_write on public.pincodes for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin'))
  with check (org_id = (select app.current_org()) and app.role_in('admin'));
-- distributors
drop policy if exists distributors_select on public.distributors;
create policy distributors_select on public.distributors for select to authenticated
  using (org_id = (select app.current_org())
    and (
      (select app.is_internal())
      or (app.current_role() in ('distributor_user', 'dealer_user') and id = (select app.current_distributor()))
    ));
drop policy if exists distributors_write on public.distributors;
create policy distributors_write on public.distributors for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager'))
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager'));
-- dealers
drop policy if exists dealers_select on public.dealers;
create policy dealers_select on public.dealers for select to authenticated
  using (org_id = (select app.current_org())
    and (
      (select app.is_internal())
      or (app.current_role() = 'distributor_user' and distributor_id = (select app.current_distributor()))
      or (app.current_role() = 'dealer_user' and id = (select app.current_dealer()))
    ));
drop policy if exists dealers_write on public.dealers;
create policy dealers_write on public.dealers for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'accounts'))
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'accounts'));
-- vendor_registrations
drop policy if exists vendor_registrations_select on public.vendor_registrations;
create policy vendor_registrations_select on public.vendor_registrations for select to authenticated
  using (org_id = (select app.current_org()) and (select app.is_internal()));
drop policy if exists vendor_registrations_write on public.vendor_registrations;
create policy vendor_registrations_write on public.vendor_registrations for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'compliance_officer', 'sales_manager', 'regional_head'))
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'compliance_officer', 'sales_manager', 'regional_head'));
-- sop_cases
drop policy if exists sop_cases_select on public.sop_cases;
create policy sop_cases_select on public.sop_cases for select to authenticated
  using (org_id = (select app.current_org()) and (select app.is_internal()));
drop policy if exists sop_cases_write on public.sop_cases;
create policy sop_cases_write on public.sop_cases for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'compliance_officer'))
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'compliance_officer'));
-- distributor_score_history
drop policy if exists distributor_score_history_select on public.distributor_score_history;
create policy distributor_score_history_select on public.distributor_score_history for select to authenticated
  using (org_id = (select app.current_org()) and (select app.is_internal()));
drop policy if exists distributor_score_history_insert on public.distributor_score_history;
create policy distributor_score_history_insert on public.distributor_score_history for insert to authenticated
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager'));
-- leads
drop policy if exists leads_select on public.leads;
create policy leads_select on public.leads for select to authenticated
  using (org_id = (select app.current_org())
    and (
      ((select app.is_internal()) and app.territory_ok(territory_id))
      or (app.current_role() = 'distributor_user' and distributor_id = (select app.current_distributor()))
      or (app.current_role() = 'dealer_user' and dealer_id = (select app.current_dealer()))
    ));
drop policy if exists leads_write on public.leads;
create policy leads_write on public.leads for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial') and app.territory_ok(territory_id))
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial') and app.territory_ok(territory_id));
-- lead_consents
drop policy if exists lead_consents_select on public.lead_consents;
create policy lead_consents_select on public.lead_consents for select to authenticated
  using (org_id = (select app.current_org()) and (select app.is_internal()));
drop policy if exists lead_consents_insert on public.lead_consents;
create policy lead_consents_insert on public.lead_consents for insert to authenticated
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial', 'compliance_officer'));
drop policy if exists lead_consents_update on public.lead_consents;
create policy lead_consents_update on public.lead_consents for update to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial', 'compliance_officer'))
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial', 'compliance_officer'));
-- lead_events
drop policy if exists lead_events_select on public.lead_events;
create policy lead_events_select on public.lead_events for select to authenticated
  using (org_id = (select app.current_org()) and (select app.is_internal()));
drop policy if exists lead_events_insert on public.lead_events;
create policy lead_events_insert on public.lead_events for insert to authenticated
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial', 'accounts', 'compliance_officer', 'dispatch'));
-- lead_assignments
drop policy if exists lead_assignments_select on public.lead_assignments;
create policy lead_assignments_select on public.lead_assignments for select to authenticated
  using (org_id = (select app.current_org()) and (select app.is_internal()));
drop policy if exists lead_assignments_write on public.lead_assignments;
create policy lead_assignments_write on public.lead_assignments for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial'))
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial'));
-- followups
drop policy if exists followups_select on public.followups;
create policy followups_select on public.followups for select to authenticated
  using (org_id = (select app.current_org()) and (select app.is_internal()));
drop policy if exists followups_write on public.followups;
create policy followups_write on public.followups for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial'))
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial'));
-- contact_logs
drop policy if exists contact_logs_select on public.contact_logs;
create policy contact_logs_select on public.contact_logs for select to authenticated
  using (org_id = (select app.current_org()) and (select app.is_internal()));
drop policy if exists contact_logs_write on public.contact_logs;
create policy contact_logs_write on public.contact_logs for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial'))
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial'));
-- dnd_register
drop policy if exists dnd_register_select on public.dnd_register;
create policy dnd_register_select on public.dnd_register for select to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'compliance_officer', 'management', 'sales_manager', 'dsm'));
drop policy if exists dnd_register_write on public.dnd_register;
create policy dnd_register_write on public.dnd_register for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'compliance_officer'))
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'compliance_officer'));
-- lead_scores
drop policy if exists lead_scores_select on public.lead_scores;
create policy lead_scores_select on public.lead_scores for select to authenticated
  using (org_id = (select app.current_org()) and (select app.is_internal()));
drop policy if exists lead_scores_write on public.lead_scores;
create policy lead_scores_write on public.lead_scores for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial'))
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial'));
-- source_api_keys
drop policy if exists source_api_keys_select on public.source_api_keys;
create policy source_api_keys_select on public.source_api_keys for select to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin'));
drop policy if exists source_api_keys_write on public.source_api_keys;
create policy source_api_keys_write on public.source_api_keys for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin'))
  with check (org_id = (select app.current_org()) and app.role_in('admin'));
-- customers
drop policy if exists customers_select on public.customers;
create policy customers_select on public.customers for select to authenticated
  using (org_id = (select app.current_org()) and (select app.is_internal()));
drop policy if exists customers_write on public.customers;
create policy customers_write on public.customers for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial'))
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial'));
-- sites
drop policy if exists sites_select on public.sites;
create policy sites_select on public.sites for select to authenticated
  using (org_id = (select app.current_org()) and (select app.is_internal()));
drop policy if exists sites_write on public.sites;
create policy sites_write on public.sites for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial'))
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial'));
-- site_surveys
drop policy if exists site_surveys_select on public.site_surveys;
create policy site_surveys_select on public.site_surveys for select to authenticated
  using (org_id = (select app.current_org()) and (select app.is_internal()));
drop policy if exists site_surveys_write on public.site_surveys;
create policy site_surveys_write on public.site_surveys for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial'))
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial'));
-- opportunities
drop policy if exists opportunities_select on public.opportunities;
create policy opportunities_select on public.opportunities for select to authenticated
  using (org_id = (select app.current_org())
    and (
      ((select app.is_internal()) and app.territory_ok(territory_id))
      or (app.current_role() = 'distributor_user' and distributor_id = (select app.current_distributor()))
      or (app.current_role() = 'dealer_user' and dealer_id = (select app.current_dealer()))
    ));
drop policy if exists opportunities_write on public.opportunities;
create policy opportunities_write on public.opportunities for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial') and app.territory_ok(territory_id))
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial') and app.territory_ok(territory_id));
-- requirement_forms
drop policy if exists requirement_forms_select on public.requirement_forms;
create policy requirement_forms_select on public.requirement_forms for select to authenticated
  using (org_id = (select app.current_org()) and (select app.is_internal()));
drop policy if exists requirement_forms_write on public.requirement_forms;
create policy requirement_forms_write on public.requirement_forms for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial'))
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial'));
-- segment_form_config
drop policy if exists segment_form_config_select on public.segment_form_config;
create policy segment_form_config_select on public.segment_form_config for select to authenticated
  using (org_id = (select app.current_org()));
drop policy if exists segment_form_config_write on public.segment_form_config;
create policy segment_form_config_write on public.segment_form_config for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin'))
  with check (org_id = (select app.current_org()) and app.role_in('admin'));
-- negotiation_logs
drop policy if exists negotiation_logs_select on public.negotiation_logs;
create policy negotiation_logs_select on public.negotiation_logs for select to authenticated
  using (org_id = (select app.current_org()) and (select app.is_internal()));
drop policy if exists negotiation_logs_write on public.negotiation_logs;
create policy negotiation_logs_write on public.negotiation_logs for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial'))
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial'));
-- skus
drop policy if exists skus_select on public.skus;
create policy skus_select on public.skus for select to authenticated
  using (org_id = (select app.current_org()) and ((select app.is_internal()) or active));
drop policy if exists skus_write on public.skus;
create policy skus_write on public.skus for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'techno_commercial'))
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'techno_commercial'));
-- sku_compliance
drop policy if exists sku_compliance_select on public.sku_compliance;
create policy sku_compliance_select on public.sku_compliance for select to authenticated
  using (org_id = (select app.current_org()) and (select app.is_internal()));
drop policy if exists sku_compliance_write on public.sku_compliance;
create policy sku_compliance_write on public.sku_compliance for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'compliance_officer', 'techno_commercial'))
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'compliance_officer', 'techno_commercial'));
-- sku_prices
drop policy if exists sku_prices_select on public.sku_prices;
create policy sku_prices_select on public.sku_prices for select to authenticated
  using (org_id = (select app.current_org()) and (select app.is_internal()));
drop policy if exists sku_prices_write on public.sku_prices;
create policy sku_prices_write on public.sku_prices for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'techno_commercial'))
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'techno_commercial'));
-- stock_batches
drop policy if exists stock_batches_select on public.stock_batches;
create policy stock_batches_select on public.stock_batches for select to authenticated
  using (org_id = (select app.current_org()) and (select app.is_internal()));
drop policy if exists stock_batches_write on public.stock_batches;
create policy stock_batches_write on public.stock_batches for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'sales_manager', 'techno_commercial', 'dispatch'))
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'sales_manager', 'techno_commercial', 'dispatch'));
-- inventory_serials
drop policy if exists inventory_serials_select on public.inventory_serials;
create policy inventory_serials_select on public.inventory_serials for select to authenticated
  using (org_id = (select app.current_org()) and (select app.is_internal()));
drop policy if exists inventory_serials_write on public.inventory_serials;
create policy inventory_serials_write on public.inventory_serials for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'sales_manager', 'techno_commercial', 'dispatch'))
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'sales_manager', 'techno_commercial', 'dispatch'));
-- quotations
drop policy if exists quotations_select on public.quotations;
create policy quotations_select on public.quotations for select to authenticated
  using (org_id = (select app.current_org())
    and (
      ((select app.is_internal()) and app.territory_ok(territory_id))
      or (app.current_role() = 'distributor_user' and distributor_id = (select app.current_distributor()))
      or (app.current_role() = 'dealer_user' and dealer_id = (select app.current_dealer()))
    ));
drop policy if exists quotations_write on public.quotations;
create policy quotations_write on public.quotations for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial') and app.territory_ok(territory_id))
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial') and app.territory_ok(territory_id));
-- quotation_lines
drop policy if exists quotation_lines_select on public.quotation_lines;
create policy quotation_lines_select on public.quotation_lines for select to authenticated
  using (org_id = (select app.current_org()) and (select app.is_internal()));
drop policy if exists quotation_lines_write on public.quotation_lines;
create policy quotation_lines_write on public.quotation_lines for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial'))
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial'));
-- quote_discussions
drop policy if exists quote_discussions_select on public.quote_discussions;
create policy quote_discussions_select on public.quote_discussions for select to authenticated
  using (org_id = (select app.current_org()) and (select app.is_internal()));
drop policy if exists quote_discussions_write on public.quote_discussions;
create policy quote_discussions_write on public.quote_discussions for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial'))
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial'));
-- approval_rules
drop policy if exists approval_rules_select on public.approval_rules;
create policy approval_rules_select on public.approval_rules for select to authenticated
  using (org_id = (select app.current_org()) and (select app.is_internal()));
drop policy if exists approval_rules_write on public.approval_rules;
create policy approval_rules_write on public.approval_rules for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin'))
  with check (org_id = (select app.current_org()) and app.role_in('admin'));
-- approvals
drop policy if exists approvals_select on public.approvals;
create policy approvals_select on public.approvals for select to authenticated
  using (org_id = (select app.current_org()) and (select app.is_internal()));
drop policy if exists approvals_write on public.approvals;
create policy approvals_write on public.approvals for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial', 'accounts', 'compliance_officer', 'dispatch'))
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial', 'accounts', 'compliance_officer', 'dispatch'));
-- proforma_invoices
drop policy if exists proforma_invoices_select on public.proforma_invoices;
create policy proforma_invoices_select on public.proforma_invoices for select to authenticated
  using (org_id = (select app.current_org())
    and (
      (select app.is_internal())
      or (app.current_role() = 'distributor_user' and distributor_id = (select app.current_distributor()))
      or (app.current_role() = 'dealer_user' and dealer_id = (select app.current_dealer()))
    ));
drop policy if exists proforma_invoices_write on public.proforma_invoices;
create policy proforma_invoices_write on public.proforma_invoices for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial', 'accounts'))
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial', 'accounts'));
-- proforma_invoice_lines
drop policy if exists proforma_invoice_lines_select on public.proforma_invoice_lines;
create policy proforma_invoice_lines_select on public.proforma_invoice_lines for select to authenticated
  using (org_id = (select app.current_org()) and (select app.is_internal()));
drop policy if exists proforma_invoice_lines_write on public.proforma_invoice_lines;
create policy proforma_invoice_lines_write on public.proforma_invoice_lines for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial', 'accounts'))
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial', 'accounts'));
-- payments
drop policy if exists payments_select on public.payments;
create policy payments_select on public.payments for select to authenticated
  using (org_id = (select app.current_org()) and (select app.is_internal()));
drop policy if exists payments_write on public.payments;
create policy payments_write on public.payments for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'sales_manager', 'accounts'))
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'sales_manager', 'accounts'));
-- credit_checks
drop policy if exists credit_checks_select on public.credit_checks;
create policy credit_checks_select on public.credit_checks for select to authenticated
  using (org_id = (select app.current_org())
    and (
      (select app.is_internal())
      or (app.current_role() = 'distributor_user' and distributor_id = (select app.current_distributor()))
      or (app.current_role() = 'dealer_user' and dealer_id = (select app.current_dealer()))
    ));
drop policy if exists credit_checks_write on public.credit_checks;
create policy credit_checks_write on public.credit_checks for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'sales_manager', 'accounts'))
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'sales_manager', 'accounts'));
-- credit_overrides
drop policy if exists credit_overrides_select on public.credit_overrides;
create policy credit_overrides_select on public.credit_overrides for select to authenticated
  using (org_id = (select app.current_org()) and (select app.is_internal()));
drop policy if exists credit_overrides_write on public.credit_overrides;
create policy credit_overrides_write on public.credit_overrides for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'sales_manager', 'accounts'))
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'sales_manager', 'accounts'));
-- sales_orders
drop policy if exists sales_orders_select on public.sales_orders;
create policy sales_orders_select on public.sales_orders for select to authenticated
  using (org_id = (select app.current_org())
    and (
      ((select app.is_internal()) and app.territory_ok(territory_id))
      or (app.current_role() = 'distributor_user' and distributor_id = (select app.current_distributor()))
      or (app.current_role() = 'dealer_user' and dealer_id = (select app.current_dealer()))
    ));
drop policy if exists sales_orders_write on public.sales_orders;
create policy sales_orders_write on public.sales_orders for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial', 'accounts') and app.territory_ok(territory_id))
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial', 'accounts') and app.territory_ok(territory_id));
-- sales_order_lines
drop policy if exists sales_order_lines_select on public.sales_order_lines;
create policy sales_order_lines_select on public.sales_order_lines for select to authenticated
  using (org_id = (select app.current_org()) and (select app.is_internal()));
drop policy if exists sales_order_lines_write on public.sales_order_lines;
create policy sales_order_lines_write on public.sales_order_lines for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial', 'accounts'))
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial', 'accounts'));
-- dispatches
drop policy if exists dispatches_select on public.dispatches;
create policy dispatches_select on public.dispatches for select to authenticated
  using (org_id = (select app.current_org()) and (select app.is_internal()));
drop policy if exists dispatches_write on public.dispatches;
create policy dispatches_write on public.dispatches for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'sales_manager', 'techno_commercial', 'dispatch'))
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'sales_manager', 'techno_commercial', 'dispatch'));
-- dispatch_serials
drop policy if exists dispatch_serials_select on public.dispatch_serials;
create policy dispatch_serials_select on public.dispatch_serials for select to authenticated
  using (org_id = (select app.current_org()) and (select app.is_internal()));
drop policy if exists dispatch_serials_write on public.dispatch_serials;
create policy dispatch_serials_write on public.dispatch_serials for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'sales_manager', 'techno_commercial', 'dispatch'))
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'sales_manager', 'techno_commercial', 'dispatch'));
-- einvoice_status
drop policy if exists einvoice_status_select on public.einvoice_status;
create policy einvoice_status_select on public.einvoice_status for select to authenticated
  using (org_id = (select app.current_org()) and (select app.is_internal()));
drop policy if exists einvoice_status_write on public.einvoice_status;
create policy einvoice_status_write on public.einvoice_status for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'sales_manager', 'accounts', 'dispatch'))
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'sales_manager', 'accounts', 'dispatch'));
-- documents
drop policy if exists documents_select on public.documents;
create policy documents_select on public.documents for select to authenticated
  using (org_id = (select app.current_org()) and (select app.is_internal()));
drop policy if exists documents_write on public.documents;
create policy documents_write on public.documents for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial', 'accounts', 'compliance_officer', 'dispatch'))
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial', 'accounts', 'compliance_officer', 'dispatch'));
-- loans
drop policy if exists loans_select on public.loans;
create policy loans_select on public.loans for select to authenticated
  using (org_id = (select app.current_org())
    and (
      (select app.is_internal())
      or (app.current_role() = 'distributor_user' and distributor_id = (select app.current_distributor()))
      or (app.current_role() = 'dealer_user' and dealer_id = (select app.current_dealer()))
    ));
drop policy if exists loans_write on public.loans;
create policy loans_write on public.loans for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial', 'accounts'))
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial', 'accounts'));
-- discom_applications
drop policy if exists discom_applications_select on public.discom_applications;
create policy discom_applications_select on public.discom_applications for select to authenticated
  using (org_id = (select app.current_org())
    and (
      (select app.is_internal())
      or (app.current_role() = 'distributor_user' and distributor_id = (select app.current_distributor()))
      or (app.current_role() = 'dealer_user' and dealer_id = (select app.current_dealer()))
    ));
drop policy if exists discom_applications_write on public.discom_applications;
create policy discom_applications_write on public.discom_applications for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial', 'accounts'))
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial', 'accounts'));
-- subsidy_claims
drop policy if exists subsidy_claims_select on public.subsidy_claims;
create policy subsidy_claims_select on public.subsidy_claims for select to authenticated
  using (org_id = (select app.current_org())
    and (
      (select app.is_internal())
      or (app.current_role() = 'distributor_user' and distributor_id = (select app.current_distributor()))
      or (app.current_role() = 'dealer_user' and dealer_id = (select app.current_dealer()))
    ));
drop policy if exists subsidy_claims_write on public.subsidy_claims;
create policy subsidy_claims_write on public.subsidy_claims for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial', 'accounts'))
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial', 'accounts'));
-- installations
drop policy if exists installations_select on public.installations;
create policy installations_select on public.installations for select to authenticated
  using (org_id = (select app.current_org())
    and (
      (select app.is_internal())
      or (app.current_role() = 'distributor_user' and distributor_id = (select app.current_distributor()))
      or (app.current_role() = 'dealer_user' and dealer_id = (select app.current_dealer()))
    ));
drop policy if exists installations_write on public.installations;
create policy installations_write on public.installations for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial', 'accounts'))
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial', 'accounts'));
-- warranty_tickets
drop policy if exists warranty_tickets_select on public.warranty_tickets;
create policy warranty_tickets_select on public.warranty_tickets for select to authenticated
  using (org_id = (select app.current_org())
    and (
      (select app.is_internal())
      or (app.current_role() = 'distributor_user' and dealer_id in (select app.distributor_dealer_ids()))
      or (app.current_role() = 'dealer_user' and dealer_id = (select app.current_dealer()))
    ));
drop policy if exists warranty_tickets_write on public.warranty_tickets;
create policy warranty_tickets_write on public.warranty_tickets for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial', 'accounts', 'dispatch'))
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial', 'accounts', 'dispatch'));
-- dealer_receivables
drop policy if exists dealer_receivables_select on public.dealer_receivables;
create policy dealer_receivables_select on public.dealer_receivables for select to authenticated
  using (org_id = (select app.current_org())
    and (
      (select app.is_internal())
      or (app.current_role() = 'distributor_user' and distributor_id = (select app.current_distributor()))
      or (app.current_role() = 'dealer_user' and dealer_id = (select app.current_dealer()))
    ));
drop policy if exists dealer_receivables_write on public.dealer_receivables;
create policy dealer_receivables_write on public.dealer_receivables for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'sales_manager', 'accounts'))
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'sales_manager', 'accounts'));
-- rule_config
drop policy if exists rule_config_select on public.rule_config;
create policy rule_config_select on public.rule_config for select to authenticated
  using (org_id = (select app.current_org()) and (select app.is_internal()));
drop policy if exists rule_config_write on public.rule_config;
create policy rule_config_write on public.rule_config for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'compliance_officer'))
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'compliance_officer'));
-- clocks
drop policy if exists clocks_select on public.clocks;
create policy clocks_select on public.clocks for select to authenticated
  using (org_id = (select app.current_org()) and (select app.is_internal()));
drop policy if exists clocks_write on public.clocks;
create policy clocks_write on public.clocks for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial', 'accounts', 'compliance_officer', 'dispatch'))
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial', 'accounts', 'compliance_officer', 'dispatch'));
-- notifications
drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications for select to authenticated
  using (org_id = (select app.current_org()) and (user_id = (select app.current_uid()) or (user_id is null and target_role = app.current_role())));
drop policy if exists notifications_update on public.notifications;
create policy notifications_update on public.notifications for update to authenticated
  using (org_id = (select app.current_org()) and (user_id = (select app.current_uid()) or (user_id is null and target_role = app.current_role())))
  with check (org_id = (select app.current_org()) and (user_id = (select app.current_uid()) or (user_id is null and target_role = app.current_role())));
drop policy if exists notifications_insert on public.notifications;
create policy notifications_insert on public.notifications for insert to authenticated
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial', 'accounts', 'compliance_officer', 'dispatch'));
-- message_templates
drop policy if exists message_templates_select on public.message_templates;
create policy message_templates_select on public.message_templates for select to authenticated
  using (org_id = (select app.current_org()) and (select app.is_internal()));
drop policy if exists message_templates_write on public.message_templates;
create policy message_templates_write on public.message_templates for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'compliance_officer'))
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'compliance_officer'));
-- message_log
drop policy if exists message_log_select on public.message_log;
create policy message_log_select on public.message_log for select to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'compliance_officer', 'management', 'regional_head', 'sales_manager', 'dsm'));
drop policy if exists message_log_insert on public.message_log;
create policy message_log_insert on public.message_log for insert to authenticated
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial', 'accounts', 'compliance_officer', 'dispatch'));
-- kpi_snapshots
drop policy if exists kpi_snapshots_select on public.kpi_snapshots;
create policy kpi_snapshots_select on public.kpi_snapshots for select to authenticated
  using (org_id = (select app.current_org()) and (select app.is_internal()));
drop policy if exists kpi_snapshots_write on public.kpi_snapshots;
create policy kpi_snapshots_write on public.kpi_snapshots for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin'))
  with check (org_id = (select app.current_org()) and app.role_in('admin'));
-- audit_log
drop policy if exists audit_log_select on public.audit_log;
create policy audit_log_select on public.audit_log for select to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'compliance_officer'));
drop policy if exists audit_log_insert on public.audit_log;
create policy audit_log_insert on public.audit_log for insert to authenticated
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial', 'accounts', 'compliance_officer', 'dispatch'));
-- compliance_calendar_items
drop policy if exists compliance_calendar_items_select on public.compliance_calendar_items;
create policy compliance_calendar_items_select on public.compliance_calendar_items for select to authenticated
  using (org_id = (select app.current_org()) and (select app.is_internal()));
drop policy if exists compliance_calendar_items_write on public.compliance_calendar_items;
create policy compliance_calendar_items_write on public.compliance_calendar_items for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'compliance_officer'))
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'compliance_officer'));
-- job_runs
drop policy if exists job_runs_select on public.job_runs;
create policy job_runs_select on public.job_runs for select to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin'));
drop policy if exists job_runs_write on public.job_runs;
create policy job_runs_write on public.job_runs for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin'))
  with check (org_id = (select app.current_org()) and app.role_in('admin'));
-- verify_register
drop policy if exists verify_register_select on public.verify_register;
create policy verify_register_select on public.verify_register for select to authenticated
  using (org_id = (select app.current_org()) and (select app.is_internal()));
drop policy if exists verify_register_write on public.verify_register;
create policy verify_register_write on public.verify_register for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'compliance_officer'))
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'compliance_officer'));
-- gate_applicability
drop policy if exists gate_applicability_select on public.gate_applicability;
create policy gate_applicability_select on public.gate_applicability for select to authenticated
  using (org_id = (select app.current_org()) and (select app.is_internal()));
drop policy if exists gate_applicability_write on public.gate_applicability;
create policy gate_applicability_write on public.gate_applicability for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'compliance_officer'))
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'compliance_officer'));
-- breach_incidents
drop policy if exists breach_incidents_select on public.breach_incidents;
create policy breach_incidents_select on public.breach_incidents for select to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'compliance_officer'));
drop policy if exists breach_incidents_write on public.breach_incidents;
create policy breach_incidents_write on public.breach_incidents for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'compliance_officer'))
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'compliance_officer'));
-- data_requests
drop policy if exists data_requests_select on public.data_requests;
create policy data_requests_select on public.data_requests for select to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'compliance_officer'));
drop policy if exists data_requests_write on public.data_requests;
create policy data_requests_write on public.data_requests for all to authenticated
  using (org_id = (select app.current_org()) and app.role_in('admin', 'compliance_officer'))
  with check (org_id = (select app.current_org()) and app.role_in('admin', 'compliance_officer'));

-- -----------------------------------------------------------------------------------------------------
-- Append-only ledgers: no update / delete policy exists (above); also revoke the privileges.
-- (Triggers in 08 block UPDATE / DELETE / TRUNCATE for every role as well.)
-- -----------------------------------------------------------------------------------------------------
revoke update, delete, truncate on public.audit_log, public.lead_events, public.message_log, public.distributor_score_history from anon, authenticated;
revoke delete, truncate on public.lead_consents from anon, authenticated;
revoke truncate on all tables in schema public from anon, authenticated;
