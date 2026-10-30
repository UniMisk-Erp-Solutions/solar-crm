-- =====================================================================================================
-- 08_functions_triggers.sql
-- Purpose : business functions and triggers.
--             1. session helpers (current user id, maintenance switch), rule lookup
--             2. normalize_mobile, find_lead_duplicates, compute_lead_score, next_working_time
--             3. updated_at triggers, the generic AUDIT trigger, lead status -> lead_events
--             4. immutability of the ledgers (audit_log, lead_events, message_log, distributor_score_history,
--                lead_consents)
--             5. guard triggers (opportunity, sales order / gate G11, dispatch, rule source) that raise
--                SQLSTATE P0001 with a friendly message (the API maps P0001 to GUARD_BLOCKED / HTTP 422)
-- Run after: 07_platform_tables.sql
-- Idempotent: functions use `create or replace`; triggers are dropped then recreated.
--
-- MAINTENANCE SWITCH (for bulk seed / demo-data removal run by the database owner)
--   Inside a transaction, a database owner connected as `postgres` may run
--       begin;  set local app.maintenance = 'on';  ...  commit;
--   While it is on: (a) the audit trigger writes nothing (no audit noise for bulk loads), and (b) DELETE (never UPDATE,
--   never TRUNCATE) is allowed on the immutable ledgers. The switch is ignored for every other database role, including
--   the API's service_role. Separately, a database owner session (postgres / supabase_admin) may DELETE lead_consents rows
--   without the switch; API roles never can. (99_delete_demo_data.sql instead uses `alter table ... disable trigger user`
--   on the four ledgers, which also works for the table owner.)
-- =====================================================================================================

-- =====================================================================================================
-- 1. SESSION HELPERS AND RULE LOOKUP
-- =====================================================================================================

-- Current user id from the PostgREST / Supabase JWT claims (same logic as auth.uid(), without depending on the auth schema).
create or replace function app.current_uid() returns uuid
language sql stable
as $$
  select nullif(
    coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
    ),
    ''
  )::uuid
$$;

create or replace function app.is_maintenance() returns boolean
language sql stable
as $$
  select coalesce(current_setting('app.maintenance', true), '') = 'on'
     and session_user in ('postgres', 'supabase_admin')
$$;

-- The value in force on a date for an ACTIVE rule (category + key), newest effective_from wins. NULL when none.
create or replace function app.rule_value(p_org uuid, p_category text, p_key text, p_on date default null)
returns jsonb
language sql stable security definer
set search_path = public
as $$
  select r.value
    from public.rule_config r
   where r.org_id = p_org
     and r.category = p_category
     and r.key = p_key
     and r.is_active
     and r.effective_from <= coalesce(p_on, (now() at time zone 'Asia/Kolkata')::date)
     and (r.effective_to is null or r.effective_to >= coalesce(p_on, (now() at time zone 'Asia/Kolkata')::date))
   order by r.effective_from desc
   limit 1
$$;

-- =====================================================================================================
-- 2. NORMALISATION, DUPLICATES, SCORING, WORKING TIME
-- =====================================================================================================

-- Bare 10-digit Indian mobile number (or NULL when invalid). Same rules as normalizeMobile() in packages/shared.
create or replace function app.normalize_mobile(p_mobile text) returns text
language plpgsql immutable parallel safe
as $$
declare
  s text;
begin
  if p_mobile is null then
    return null;
  end if;
  s := regexp_replace(p_mobile, '[^0-9+]', '', 'g');
  if s like '+91%' then
    s := substr(s, 4);
  elsif s like '0091%' then
    s := substr(s, 5);
  elsif length(s) = 12 and s like '91%' then
    s := substr(s, 3);
  elsif length(s) = 11 and s like '0%' then
    s := substr(s, 2);
  end if;
  if s ~ '^[6-9][0-9]{9}$' then
    return s;
  end if;
  return null;
end
$$;

create index if not exists leads_org_mobile_norm_idx on public.leads (org_id, app.normalize_mobile(mobile));

-- Possible duplicates of a lead: exact normalised mobile, e-mail or consumer number, or a similar name
-- (pg_trgm similarity >= 0.6) in the same pincode. One row per (lead, reason); `reason` is one of
-- 'mobile', 'email', 'consumer_no', 'name_pincode'. Duplicate / merged leads are not returned.
create or replace function app.find_lead_duplicates(
  p_org uuid,
  p_mobile text,
  p_email text,
  p_consumer_no text,
  p_name text,
  p_pincode text,
  p_exclude uuid default null
) returns table (lead_id uuid, reason text, match_score real)
language plpgsql stable
set search_path = public, extensions
as $$
declare
  v_mobile text := app.normalize_mobile(p_mobile);
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_consumer text := nullif(upper(btrim(coalesce(p_consumer_no, ''))), '');
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
  v_pin text := nullif(btrim(coalesce(p_pincode, '')), '');
begin
  return query
  select m.id, 'mobile'::text, 1::real
    from public.leads m
   where v_mobile is not null
     and m.org_id = p_org and m.deleted_at is null and m.status not in ('duplicate', 'merged')
     and m.id is distinct from p_exclude
     and app.normalize_mobile(m.mobile) = v_mobile
  union all
  select e.id, 'email'::text, 1::real
    from public.leads e
   where v_email is not null
     and e.org_id = p_org and e.deleted_at is null and e.status not in ('duplicate', 'merged')
     and e.id is distinct from p_exclude
     and lower(btrim(e.email)) = v_email
  union all
  select c.id, 'consumer_no'::text, 1::real
    from public.leads c
   where v_consumer is not null
     and c.org_id = p_org and c.deleted_at is null and c.status not in ('duplicate', 'merged')
     and c.id is distinct from p_exclude
     and upper(btrim(c.consumer_no)) = v_consumer
  union all
  select n.id, 'name_pincode'::text, similarity(n.name, v_name)
    from public.leads n
   where v_name is not null and v_pin is not null
     and n.org_id = p_org and n.deleted_at is null and n.status not in ('duplicate', 'merged')
     and n.id is distinct from p_exclude
     and n.pincode = v_pin
     and n.name % v_name
     and similarity(n.name, v_name) >= 0.6;
end
$$;

-- Lead quality score 0-100 (docs/AGENT_BRIEF.md Appendix A). Weights come from rule scoring.weights, falling back
-- to requirement_clarity 20, mw_size 15, timeline 25, budget 15, decision_maker 10, consent_present 10, bill_captured 5.
-- Writes lead_scores (updates the latest row, or inserts the first) and leads.quality_score; returns the result as jsonb.
create or replace function app.compute_lead_score(p_lead uuid) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  l public.leads%rowtype;
  v_w jsonb;
  w_req numeric; w_mw numeric; w_time numeric; w_budget numeric; w_dm numeric; w_cons numeric; w_bill numeric;
  f_req numeric; f_mw numeric; f_time numeric; f_budget numeric; f_dm numeric; f_cons numeric; f_bill numeric;
  v_len integer;
  v_has_consent boolean;
  v_components jsonb;
  v_total numeric;
  v_score_id uuid;
begin
  select * into l from public.leads where id = p_lead;
  if not found then
    raise exception 'Lead % was not found.', p_lead using errcode = 'P0002';
  end if;

  v_w := coalesce(app.rule_value(l.org_id, 'scoring', 'weights'), '{}'::jsonb);
  if jsonb_typeof(v_w) <> 'object' then
    v_w := '{}'::jsonb;
  end if;
  w_req    := coalesce((v_w ->> 'requirement_clarity')::numeric, 20);
  w_mw     := coalesce((v_w ->> 'mw_size')::numeric, 15);
  w_time   := coalesce((v_w ->> 'timeline')::numeric, 25);
  w_budget := coalesce((v_w ->> 'budget')::numeric, 15);
  w_dm     := coalesce((v_w ->> 'decision_maker')::numeric, 10);
  w_cons   := coalesce((v_w ->> 'consent_present')::numeric, 10);
  w_bill   := coalesce((v_w ->> 'bill_captured')::numeric, 5);

  v_len := char_length(btrim(coalesce(l.requirement_text, '')));
  f_req := (case when v_len >= 20 then 0.6 when v_len >= 1 then 0.3 else 0 end)
         + (case when l.segment is not null then 0.2 else 0 end)
         + (case when l.capacity_kw is not null then 0.2 else 0 end);
  f_mw := case
            when l.capacity_kw is null then 0
            when l.capacity_kw < 3 then 0.3
            when l.capacity_kw < 10 then 0.5
            when l.capacity_kw < 100 then 0.75
            else 1
          end;
  f_time := case l.timeline_bucket
              when 'immediate' then 1
              when 'within_30_days' then 0.9
              when 'one_to_three_months' then 0.6
              when 'three_to_six_months' then 0.3
              when 'six_months_plus' then 0.1
              else 0
            end;
  f_budget := case
                when l.budget_inr is null then 0
                when l.capacity_kw is not null and l.budget_inr >= 40000 * l.capacity_kw then 1
                else 0.6
              end;
  f_dm := case l.decision_maker
            when 'self' then 1
            when 'family' then 0.8
            when 'committee' then 0.5
            else 0
          end;
  if l.decision_maker_access is false then
    f_dm := f_dm * 0.5;
  end if;
  select exists (select 1 from public.lead_consents c where c.lead_id = l.id and c.withdrawn_at is null) into v_has_consent;
  f_cons := case when v_has_consent then 1 else 0 end;
  f_bill := case when l.bill_captured then 1 else 0 end;

  v_components := jsonb_build_array(
    jsonb_build_object('key', 'requirement_clarity', 'label', 'Requirement clarity', 'weight', w_req, 'points', round(w_req * f_req, 2),
      'note', format('%s characters of requirement text; segment %s; capacity %s', v_len,
                     case when l.segment is not null then 'set' else 'missing' end,
                     case when l.capacity_kw is not null then 'set' else 'missing' end)),
    jsonb_build_object('key', 'mw_size', 'label', 'Project size', 'weight', w_mw, 'points', round(w_mw * f_mw, 2),
      'note', coalesce(l.capacity_kw::text || ' kW', 'capacity not captured')),
    jsonb_build_object('key', 'timeline', 'label', 'Timeline', 'weight', w_time, 'points', round(w_time * f_time, 2),
      'note', coalesce(l.timeline_bucket::text, 'timeline not captured')),
    jsonb_build_object('key', 'budget', 'label', 'Budget', 'weight', w_budget, 'points', round(w_budget * f_budget, 2),
      'note', case when l.budget_inr is null then 'budget not captured'
                   when l.capacity_kw is not null and l.budget_inr >= 40000 * l.capacity_kw then 'budget meets 40,000 per kW'
                   else 'budget below 40,000 per kW or capacity unknown' end),
    jsonb_build_object('key', 'decision_maker', 'label', 'Decision maker', 'weight', w_dm, 'points', round(w_dm * f_dm, 2),
      'note', coalesce(l.decision_maker, 'unknown') || case when l.decision_maker_access is false then ' (no direct access)' else '' end),
    jsonb_build_object('key', 'consent_present', 'label', 'Consent on file', 'weight', w_cons, 'points', round(w_cons * f_cons, 2),
      'note', case when v_has_consent then 'active consent recorded' else 'no active consent' end),
    jsonb_build_object('key', 'bill_captured', 'label', 'Electricity bill captured', 'weight', w_bill, 'points', round(w_bill * f_bill, 2),
      'note', case when l.bill_captured then 'bill captured' else 'bill not captured' end)
  );
  v_total := round(w_req * f_req + w_mw * f_mw + w_time * f_time + w_budget * f_budget + w_dm * f_dm + w_cons * f_cons + w_bill * f_bill);

  select s.id into v_score_id from public.lead_scores s where s.lead_id = l.id order by s.computed_at desc limit 1;
  if v_score_id is null then
    insert into public.lead_scores (org_id, lead_id, score, components, computed_at)
    values (l.org_id, l.id, v_total, v_components, now());
  else
    update public.lead_scores set score = v_total, components = v_components, computed_at = now(), updated_at = now() where id = v_score_id;
  end if;
  update public.leads set quality_score = v_total where id = l.id and quality_score is distinct from v_total;

  return jsonb_build_object('lead_id', l.id, 'score', v_total, 'components', v_components, 'computed_at', now());
end
$$;

-- Add `hours` of WORKING time to `ts` (IST calendar). Calendar comes from rule work_calendar.hours
-- ({ "days": [1,2,3,4,5,6], "start": "09:30", "end": "18:30" }, 0 = Sunday) and work_calendar.holidays
-- (["YYYY-MM-DD", ...]); default Monday-Saturday 09:30-18:30, no holidays. p_org defaults to the caller's
-- organisation, or the first organisation on a single-tenant database.
create or replace function app.next_working_time(ts timestamptz, hours numeric, p_org uuid default null)
returns timestamptz
language plpgsql stable
set search_path = public
as $$
declare
  v_org uuid := coalesce(
    p_org,
    (select pr.org_id from public.profiles pr where pr.id = app.current_uid() limit 1),
    (select o.id from public.organizations o order by o.created_at limit 1)
  );
  v_ref date := (ts at time zone 'Asia/Kolkata')::date;
  v_cal jsonb := coalesce(app.rule_value(v_org, 'work_calendar', 'hours', v_ref), '{}'::jsonb);
  v_hol jsonb := coalesce(app.rule_value(v_org, 'work_calendar', 'holidays', v_ref), '[]'::jsonb);
  v_days integer[] := array[1, 2, 3, 4, 5, 6];
  v_start time := time '09:30';
  v_end time := time '18:30';
  v_cur timestamp := ts at time zone 'Asia/Kolkata';
  v_remaining numeric := greatest(coalesce(hours, 0), 0) * 60;
  v_day date;
  v_open timestamp;
  v_close timestamp;
  v_avail numeric;
  v_guard integer := 0;
begin
  if jsonb_typeof(v_cal) = 'object' then
    if jsonb_typeof(v_cal -> 'days') = 'array' and jsonb_array_length(v_cal -> 'days') > 0 then
      v_days := array(select jsonb_array_elements_text(v_cal -> 'days')::integer);
    end if;
    if nullif(v_cal ->> 'start', '') is not null then
      v_start := (v_cal ->> 'start')::time;
    end if;
    if nullif(v_cal ->> 'end', '') is not null then
      v_end := (v_cal ->> 'end')::time;
    end if;
  end if;
  if jsonb_typeof(v_hol) <> 'array' then
    v_hol := '[]'::jsonb;
  end if;

  while v_guard < 800 loop
    v_guard := v_guard + 1;
    v_day := v_cur::date;
    if extract(dow from v_day)::integer = any (v_days) and not (v_hol @> jsonb_build_array(v_day::text)) then
      v_open := v_day + v_start;
      v_close := v_day + v_end;
      if v_cur < v_open then
        v_cur := v_open;
      end if;
      if v_cur < v_close then
        v_avail := extract(epoch from (v_close - v_cur)) / 60;
        if v_remaining <= v_avail then
          return (v_cur + (v_remaining::double precision) * interval '1 minute') at time zone 'Asia/Kolkata';
        end if;
        v_remaining := v_remaining - v_avail;
      end if;
    end if;
    v_cur := (v_day + 1)::timestamp;
  end loop;
  return ts;
end
$$;

-- =====================================================================================================
-- 3. updated_at, AUDIT and lead-status triggers
-- =====================================================================================================

-- Generic row audit: one audit_log row per INSERT / UPDATE / DELETE, source 'trigger', actor from the JWT (NULL for the
-- service role). No-op updates (only updated_at changed) are skipped. SECURITY DEFINER so that RLS on audit_log can never
-- make a business write fail.
create or replace function app.audit_row() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_row jsonb;
begin
  if app.is_maintenance() then
    return null;
  end if;
  if tg_op = 'INSERT' then
    v_new := to_jsonb(new);
    v_row := v_new;
  elsif tg_op = 'UPDATE' then
    v_old := to_jsonb(old);
    v_new := to_jsonb(new);
    v_row := v_new;
    if (v_old - 'updated_at') = (v_new - 'updated_at') then
      return null;
    end if;
  else
    v_old := to_jsonb(old);
    v_row := v_old;
  end if;
  insert into public.audit_log (org_id, actor_id, action, table_name, record_id, old_data, new_data, source)
  values ((v_row ->> 'org_id')::uuid, app.current_uid(), tg_table_name || '.' || lower(tg_op), tg_table_name, v_row ->> 'id', v_old, v_new, 'trigger');
  return null;
end
$$;

-- leads.status change -> lead_events row (same wording as the in-memory emulation used in demo mode and tests)
create or replace function app.lead_status_event() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status is distinct from old.status then
    insert into public.lead_events (org_id, lead_id, event_type, summary, actor_id, detail)
    values (new.org_id, new.id, 'status_changed',
            format('Status changed from %s to %s', old.status, new.status),
            app.current_uid(),
            jsonb_build_object('from', old.status, 'to', new.status));
  end if;
  return null;
end
$$;

drop trigger if exists trg_leads_status_event on public.leads;
create trigger trg_leads_status_event
  after update of status on public.leads
  for each row when (old.status is distinct from new.status)
  execute function app.lead_status_event();

-- updated_at triggers (every table that has an updated_at column)
drop trigger if exists trg_organizations_updated_at on public.organizations;
create trigger trg_organizations_updated_at before update on public.organizations for each row execute function app.set_updated_at();
drop trigger if exists trg_profiles_updated_at on public.profiles;
create trigger trg_profiles_updated_at before update on public.profiles for each row execute function app.set_updated_at();
drop trigger if exists trg_discoms_updated_at on public.discoms;
create trigger trg_discoms_updated_at before update on public.discoms for each row execute function app.set_updated_at();
drop trigger if exists trg_territories_updated_at on public.territories;
create trigger trg_territories_updated_at before update on public.territories for each row execute function app.set_updated_at();
drop trigger if exists trg_user_territories_updated_at on public.user_territories;
create trigger trg_user_territories_updated_at before update on public.user_territories for each row execute function app.set_updated_at();
drop trigger if exists trg_pincodes_updated_at on public.pincodes;
create trigger trg_pincodes_updated_at before update on public.pincodes for each row execute function app.set_updated_at();
drop trigger if exists trg_distributors_updated_at on public.distributors;
create trigger trg_distributors_updated_at before update on public.distributors for each row execute function app.set_updated_at();
drop trigger if exists trg_dealers_updated_at on public.dealers;
create trigger trg_dealers_updated_at before update on public.dealers for each row execute function app.set_updated_at();
drop trigger if exists trg_vendor_registrations_updated_at on public.vendor_registrations;
create trigger trg_vendor_registrations_updated_at before update on public.vendor_registrations for each row execute function app.set_updated_at();
drop trigger if exists trg_sop_cases_updated_at on public.sop_cases;
create trigger trg_sop_cases_updated_at before update on public.sop_cases for each row execute function app.set_updated_at();
drop trigger if exists trg_leads_updated_at on public.leads;
create trigger trg_leads_updated_at before update on public.leads for each row execute function app.set_updated_at();
drop trigger if exists trg_lead_consents_updated_at on public.lead_consents;
create trigger trg_lead_consents_updated_at before update on public.lead_consents for each row execute function app.set_updated_at();
drop trigger if exists trg_lead_assignments_updated_at on public.lead_assignments;
create trigger trg_lead_assignments_updated_at before update on public.lead_assignments for each row execute function app.set_updated_at();
drop trigger if exists trg_followups_updated_at on public.followups;
create trigger trg_followups_updated_at before update on public.followups for each row execute function app.set_updated_at();
drop trigger if exists trg_contact_logs_updated_at on public.contact_logs;
create trigger trg_contact_logs_updated_at before update on public.contact_logs for each row execute function app.set_updated_at();
drop trigger if exists trg_dnd_register_updated_at on public.dnd_register;
create trigger trg_dnd_register_updated_at before update on public.dnd_register for each row execute function app.set_updated_at();
drop trigger if exists trg_lead_scores_updated_at on public.lead_scores;
create trigger trg_lead_scores_updated_at before update on public.lead_scores for each row execute function app.set_updated_at();
drop trigger if exists trg_source_api_keys_updated_at on public.source_api_keys;
create trigger trg_source_api_keys_updated_at before update on public.source_api_keys for each row execute function app.set_updated_at();
drop trigger if exists trg_customers_updated_at on public.customers;
create trigger trg_customers_updated_at before update on public.customers for each row execute function app.set_updated_at();
drop trigger if exists trg_sites_updated_at on public.sites;
create trigger trg_sites_updated_at before update on public.sites for each row execute function app.set_updated_at();
drop trigger if exists trg_site_surveys_updated_at on public.site_surveys;
create trigger trg_site_surveys_updated_at before update on public.site_surveys for each row execute function app.set_updated_at();
drop trigger if exists trg_opportunities_updated_at on public.opportunities;
create trigger trg_opportunities_updated_at before update on public.opportunities for each row execute function app.set_updated_at();
drop trigger if exists trg_requirement_forms_updated_at on public.requirement_forms;
create trigger trg_requirement_forms_updated_at before update on public.requirement_forms for each row execute function app.set_updated_at();
drop trigger if exists trg_segment_form_config_updated_at on public.segment_form_config;
create trigger trg_segment_form_config_updated_at before update on public.segment_form_config for each row execute function app.set_updated_at();
drop trigger if exists trg_negotiation_logs_updated_at on public.negotiation_logs;
create trigger trg_negotiation_logs_updated_at before update on public.negotiation_logs for each row execute function app.set_updated_at();
drop trigger if exists trg_skus_updated_at on public.skus;
create trigger trg_skus_updated_at before update on public.skus for each row execute function app.set_updated_at();
drop trigger if exists trg_sku_compliance_updated_at on public.sku_compliance;
create trigger trg_sku_compliance_updated_at before update on public.sku_compliance for each row execute function app.set_updated_at();
drop trigger if exists trg_sku_prices_updated_at on public.sku_prices;
create trigger trg_sku_prices_updated_at before update on public.sku_prices for each row execute function app.set_updated_at();
drop trigger if exists trg_stock_batches_updated_at on public.stock_batches;
create trigger trg_stock_batches_updated_at before update on public.stock_batches for each row execute function app.set_updated_at();
drop trigger if exists trg_inventory_serials_updated_at on public.inventory_serials;
create trigger trg_inventory_serials_updated_at before update on public.inventory_serials for each row execute function app.set_updated_at();
drop trigger if exists trg_quotations_updated_at on public.quotations;
create trigger trg_quotations_updated_at before update on public.quotations for each row execute function app.set_updated_at();
drop trigger if exists trg_quotation_lines_updated_at on public.quotation_lines;
create trigger trg_quotation_lines_updated_at before update on public.quotation_lines for each row execute function app.set_updated_at();
drop trigger if exists trg_quote_discussions_updated_at on public.quote_discussions;
create trigger trg_quote_discussions_updated_at before update on public.quote_discussions for each row execute function app.set_updated_at();
drop trigger if exists trg_approval_rules_updated_at on public.approval_rules;
create trigger trg_approval_rules_updated_at before update on public.approval_rules for each row execute function app.set_updated_at();
drop trigger if exists trg_approvals_updated_at on public.approvals;
create trigger trg_approvals_updated_at before update on public.approvals for each row execute function app.set_updated_at();
drop trigger if exists trg_proforma_invoices_updated_at on public.proforma_invoices;
create trigger trg_proforma_invoices_updated_at before update on public.proforma_invoices for each row execute function app.set_updated_at();
drop trigger if exists trg_proforma_invoice_lines_updated_at on public.proforma_invoice_lines;
create trigger trg_proforma_invoice_lines_updated_at before update on public.proforma_invoice_lines for each row execute function app.set_updated_at();
drop trigger if exists trg_payments_updated_at on public.payments;
create trigger trg_payments_updated_at before update on public.payments for each row execute function app.set_updated_at();
drop trigger if exists trg_credit_checks_updated_at on public.credit_checks;
create trigger trg_credit_checks_updated_at before update on public.credit_checks for each row execute function app.set_updated_at();
drop trigger if exists trg_credit_overrides_updated_at on public.credit_overrides;
create trigger trg_credit_overrides_updated_at before update on public.credit_overrides for each row execute function app.set_updated_at();
drop trigger if exists trg_sales_orders_updated_at on public.sales_orders;
create trigger trg_sales_orders_updated_at before update on public.sales_orders for each row execute function app.set_updated_at();
drop trigger if exists trg_sales_order_lines_updated_at on public.sales_order_lines;
create trigger trg_sales_order_lines_updated_at before update on public.sales_order_lines for each row execute function app.set_updated_at();
drop trigger if exists trg_dispatches_updated_at on public.dispatches;
create trigger trg_dispatches_updated_at before update on public.dispatches for each row execute function app.set_updated_at();
drop trigger if exists trg_dispatch_serials_updated_at on public.dispatch_serials;
create trigger trg_dispatch_serials_updated_at before update on public.dispatch_serials for each row execute function app.set_updated_at();
drop trigger if exists trg_einvoice_status_updated_at on public.einvoice_status;
create trigger trg_einvoice_status_updated_at before update on public.einvoice_status for each row execute function app.set_updated_at();
drop trigger if exists trg_documents_updated_at on public.documents;
create trigger trg_documents_updated_at before update on public.documents for each row execute function app.set_updated_at();
drop trigger if exists trg_loans_updated_at on public.loans;
create trigger trg_loans_updated_at before update on public.loans for each row execute function app.set_updated_at();
drop trigger if exists trg_discom_applications_updated_at on public.discom_applications;
create trigger trg_discom_applications_updated_at before update on public.discom_applications for each row execute function app.set_updated_at();
drop trigger if exists trg_subsidy_claims_updated_at on public.subsidy_claims;
create trigger trg_subsidy_claims_updated_at before update on public.subsidy_claims for each row execute function app.set_updated_at();
drop trigger if exists trg_installations_updated_at on public.installations;
create trigger trg_installations_updated_at before update on public.installations for each row execute function app.set_updated_at();
drop trigger if exists trg_warranty_tickets_updated_at on public.warranty_tickets;
create trigger trg_warranty_tickets_updated_at before update on public.warranty_tickets for each row execute function app.set_updated_at();
drop trigger if exists trg_dealer_receivables_updated_at on public.dealer_receivables;
create trigger trg_dealer_receivables_updated_at before update on public.dealer_receivables for each row execute function app.set_updated_at();
drop trigger if exists trg_rule_config_updated_at on public.rule_config;
create trigger trg_rule_config_updated_at before update on public.rule_config for each row execute function app.set_updated_at();
drop trigger if exists trg_clocks_updated_at on public.clocks;
create trigger trg_clocks_updated_at before update on public.clocks for each row execute function app.set_updated_at();
drop trigger if exists trg_notifications_updated_at on public.notifications;
create trigger trg_notifications_updated_at before update on public.notifications for each row execute function app.set_updated_at();
drop trigger if exists trg_message_templates_updated_at on public.message_templates;
create trigger trg_message_templates_updated_at before update on public.message_templates for each row execute function app.set_updated_at();
drop trigger if exists trg_kpi_snapshots_updated_at on public.kpi_snapshots;
create trigger trg_kpi_snapshots_updated_at before update on public.kpi_snapshots for each row execute function app.set_updated_at();
drop trigger if exists trg_compliance_calendar_items_updated_at on public.compliance_calendar_items;
create trigger trg_compliance_calendar_items_updated_at before update on public.compliance_calendar_items for each row execute function app.set_updated_at();
drop trigger if exists trg_job_runs_updated_at on public.job_runs;
create trigger trg_job_runs_updated_at before update on public.job_runs for each row execute function app.set_updated_at();
drop trigger if exists trg_verify_register_updated_at on public.verify_register;
create trigger trg_verify_register_updated_at before update on public.verify_register for each row execute function app.set_updated_at();
drop trigger if exists trg_gate_applicability_updated_at on public.gate_applicability;
create trigger trg_gate_applicability_updated_at before update on public.gate_applicability for each row execute function app.set_updated_at();
drop trigger if exists trg_breach_incidents_updated_at on public.breach_incidents;
create trigger trg_breach_incidents_updated_at before update on public.breach_incidents for each row execute function app.set_updated_at();
drop trigger if exists trg_data_requests_updated_at on public.data_requests;
create trigger trg_data_requests_updated_at before update on public.data_requests for each row execute function app.set_updated_at();

-- audit triggers (every table in AUDITED_TABLES of packages/shared/src/enums.ts; audit_log itself and the high-volume /
-- ledger tables are excluded by design)
drop trigger if exists trg_profiles_audit on public.profiles;
create trigger trg_profiles_audit after insert or update or delete on public.profiles for each row execute function app.audit_row();
drop trigger if exists trg_discoms_audit on public.discoms;
create trigger trg_discoms_audit after insert or update or delete on public.discoms for each row execute function app.audit_row();
drop trigger if exists trg_territories_audit on public.territories;
create trigger trg_territories_audit after insert or update or delete on public.territories for each row execute function app.audit_row();
drop trigger if exists trg_user_territories_audit on public.user_territories;
create trigger trg_user_territories_audit after insert or update or delete on public.user_territories for each row execute function app.audit_row();
drop trigger if exists trg_pincodes_audit on public.pincodes;
create trigger trg_pincodes_audit after insert or update or delete on public.pincodes for each row execute function app.audit_row();
drop trigger if exists trg_distributors_audit on public.distributors;
create trigger trg_distributors_audit after insert or update or delete on public.distributors for each row execute function app.audit_row();
drop trigger if exists trg_dealers_audit on public.dealers;
create trigger trg_dealers_audit after insert or update or delete on public.dealers for each row execute function app.audit_row();
drop trigger if exists trg_vendor_registrations_audit on public.vendor_registrations;
create trigger trg_vendor_registrations_audit after insert or update or delete on public.vendor_registrations for each row execute function app.audit_row();
drop trigger if exists trg_sop_cases_audit on public.sop_cases;
create trigger trg_sop_cases_audit after insert or update or delete on public.sop_cases for each row execute function app.audit_row();
drop trigger if exists trg_distributor_score_history_audit on public.distributor_score_history;
create trigger trg_distributor_score_history_audit after insert or update or delete on public.distributor_score_history for each row execute function app.audit_row();
drop trigger if exists trg_leads_audit on public.leads;
create trigger trg_leads_audit after insert or update or delete on public.leads for each row execute function app.audit_row();
drop trigger if exists trg_lead_consents_audit on public.lead_consents;
create trigger trg_lead_consents_audit after insert or update or delete on public.lead_consents for each row execute function app.audit_row();
drop trigger if exists trg_lead_assignments_audit on public.lead_assignments;
create trigger trg_lead_assignments_audit after insert or update or delete on public.lead_assignments for each row execute function app.audit_row();
drop trigger if exists trg_followups_audit on public.followups;
create trigger trg_followups_audit after insert or update or delete on public.followups for each row execute function app.audit_row();
drop trigger if exists trg_contact_logs_audit on public.contact_logs;
create trigger trg_contact_logs_audit after insert or update or delete on public.contact_logs for each row execute function app.audit_row();
drop trigger if exists trg_source_api_keys_audit on public.source_api_keys;
create trigger trg_source_api_keys_audit after insert or update or delete on public.source_api_keys for each row execute function app.audit_row();
drop trigger if exists trg_customers_audit on public.customers;
create trigger trg_customers_audit after insert or update or delete on public.customers for each row execute function app.audit_row();
drop trigger if exists trg_sites_audit on public.sites;
create trigger trg_sites_audit after insert or update or delete on public.sites for each row execute function app.audit_row();
drop trigger if exists trg_site_surveys_audit on public.site_surveys;
create trigger trg_site_surveys_audit after insert or update or delete on public.site_surveys for each row execute function app.audit_row();
drop trigger if exists trg_opportunities_audit on public.opportunities;
create trigger trg_opportunities_audit after insert or update or delete on public.opportunities for each row execute function app.audit_row();
drop trigger if exists trg_requirement_forms_audit on public.requirement_forms;
create trigger trg_requirement_forms_audit after insert or update or delete on public.requirement_forms for each row execute function app.audit_row();
drop trigger if exists trg_segment_form_config_audit on public.segment_form_config;
create trigger trg_segment_form_config_audit after insert or update or delete on public.segment_form_config for each row execute function app.audit_row();
drop trigger if exists trg_negotiation_logs_audit on public.negotiation_logs;
create trigger trg_negotiation_logs_audit after insert or update or delete on public.negotiation_logs for each row execute function app.audit_row();
drop trigger if exists trg_skus_audit on public.skus;
create trigger trg_skus_audit after insert or update or delete on public.skus for each row execute function app.audit_row();
drop trigger if exists trg_sku_compliance_audit on public.sku_compliance;
create trigger trg_sku_compliance_audit after insert or update or delete on public.sku_compliance for each row execute function app.audit_row();
drop trigger if exists trg_sku_prices_audit on public.sku_prices;
create trigger trg_sku_prices_audit after insert or update or delete on public.sku_prices for each row execute function app.audit_row();
drop trigger if exists trg_stock_batches_audit on public.stock_batches;
create trigger trg_stock_batches_audit after insert or update or delete on public.stock_batches for each row execute function app.audit_row();
drop trigger if exists trg_inventory_serials_audit on public.inventory_serials;
create trigger trg_inventory_serials_audit after insert or update or delete on public.inventory_serials for each row execute function app.audit_row();
drop trigger if exists trg_quotations_audit on public.quotations;
create trigger trg_quotations_audit after insert or update or delete on public.quotations for each row execute function app.audit_row();
drop trigger if exists trg_quotation_lines_audit on public.quotation_lines;
create trigger trg_quotation_lines_audit after insert or update or delete on public.quotation_lines for each row execute function app.audit_row();
drop trigger if exists trg_quote_discussions_audit on public.quote_discussions;
create trigger trg_quote_discussions_audit after insert or update or delete on public.quote_discussions for each row execute function app.audit_row();
drop trigger if exists trg_approval_rules_audit on public.approval_rules;
create trigger trg_approval_rules_audit after insert or update or delete on public.approval_rules for each row execute function app.audit_row();
drop trigger if exists trg_approvals_audit on public.approvals;
create trigger trg_approvals_audit after insert or update or delete on public.approvals for each row execute function app.audit_row();
drop trigger if exists trg_proforma_invoices_audit on public.proforma_invoices;
create trigger trg_proforma_invoices_audit after insert or update or delete on public.proforma_invoices for each row execute function app.audit_row();
drop trigger if exists trg_proforma_invoice_lines_audit on public.proforma_invoice_lines;
create trigger trg_proforma_invoice_lines_audit after insert or update or delete on public.proforma_invoice_lines for each row execute function app.audit_row();
drop trigger if exists trg_payments_audit on public.payments;
create trigger trg_payments_audit after insert or update or delete on public.payments for each row execute function app.audit_row();
drop trigger if exists trg_credit_checks_audit on public.credit_checks;
create trigger trg_credit_checks_audit after insert or update or delete on public.credit_checks for each row execute function app.audit_row();
drop trigger if exists trg_credit_overrides_audit on public.credit_overrides;
create trigger trg_credit_overrides_audit after insert or update or delete on public.credit_overrides for each row execute function app.audit_row();
drop trigger if exists trg_sales_orders_audit on public.sales_orders;
create trigger trg_sales_orders_audit after insert or update or delete on public.sales_orders for each row execute function app.audit_row();
drop trigger if exists trg_sales_order_lines_audit on public.sales_order_lines;
create trigger trg_sales_order_lines_audit after insert or update or delete on public.sales_order_lines for each row execute function app.audit_row();
drop trigger if exists trg_dispatches_audit on public.dispatches;
create trigger trg_dispatches_audit after insert or update or delete on public.dispatches for each row execute function app.audit_row();
drop trigger if exists trg_dispatch_serials_audit on public.dispatch_serials;
create trigger trg_dispatch_serials_audit after insert or update or delete on public.dispatch_serials for each row execute function app.audit_row();
drop trigger if exists trg_einvoice_status_audit on public.einvoice_status;
create trigger trg_einvoice_status_audit after insert or update or delete on public.einvoice_status for each row execute function app.audit_row();
drop trigger if exists trg_documents_audit on public.documents;
create trigger trg_documents_audit after insert or update or delete on public.documents for each row execute function app.audit_row();
drop trigger if exists trg_loans_audit on public.loans;
create trigger trg_loans_audit after insert or update or delete on public.loans for each row execute function app.audit_row();
drop trigger if exists trg_discom_applications_audit on public.discom_applications;
create trigger trg_discom_applications_audit after insert or update or delete on public.discom_applications for each row execute function app.audit_row();
drop trigger if exists trg_subsidy_claims_audit on public.subsidy_claims;
create trigger trg_subsidy_claims_audit after insert or update or delete on public.subsidy_claims for each row execute function app.audit_row();
drop trigger if exists trg_installations_audit on public.installations;
create trigger trg_installations_audit after insert or update or delete on public.installations for each row execute function app.audit_row();
drop trigger if exists trg_warranty_tickets_audit on public.warranty_tickets;
create trigger trg_warranty_tickets_audit after insert or update or delete on public.warranty_tickets for each row execute function app.audit_row();
drop trigger if exists trg_dealer_receivables_audit on public.dealer_receivables;
create trigger trg_dealer_receivables_audit after insert or update or delete on public.dealer_receivables for each row execute function app.audit_row();
drop trigger if exists trg_rule_config_audit on public.rule_config;
create trigger trg_rule_config_audit after insert or update or delete on public.rule_config for each row execute function app.audit_row();
drop trigger if exists trg_message_templates_audit on public.message_templates;
create trigger trg_message_templates_audit after insert or update or delete on public.message_templates for each row execute function app.audit_row();
drop trigger if exists trg_compliance_calendar_items_audit on public.compliance_calendar_items;
create trigger trg_compliance_calendar_items_audit after insert or update or delete on public.compliance_calendar_items for each row execute function app.audit_row();
drop trigger if exists trg_verify_register_audit on public.verify_register;
create trigger trg_verify_register_audit after insert or update or delete on public.verify_register for each row execute function app.audit_row();
drop trigger if exists trg_gate_applicability_audit on public.gate_applicability;
create trigger trg_gate_applicability_audit after insert or update or delete on public.gate_applicability for each row execute function app.audit_row();
drop trigger if exists trg_breach_incidents_audit on public.breach_incidents;
create trigger trg_breach_incidents_audit after insert or update or delete on public.breach_incidents for each row execute function app.audit_row();
drop trigger if exists trg_data_requests_audit on public.data_requests;
create trigger trg_data_requests_audit after insert or update or delete on public.data_requests for each row execute function app.audit_row();

-- =====================================================================================================
-- 4. IMMUTABLE LEDGERS
-- =====================================================================================================

create or replace function app.block_ledger_mutation() returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' and app.is_maintenance() then
    return old;
  end if;
  raise exception '% is an append-only ledger: % is not allowed.', tg_table_name, lower(tg_op)
    using errcode = 'P0001', hint = 'Insert a new row instead of changing history.';
end
$$;

-- audit_log
drop trigger if exists trg_audit_log_immutable on public.audit_log;
create trigger trg_audit_log_immutable before update or delete on public.audit_log for each row execute function app.block_ledger_mutation();
drop trigger if exists trg_audit_log_no_truncate on public.audit_log;
create trigger trg_audit_log_no_truncate before truncate on public.audit_log for each statement execute function app.block_ledger_mutation();
-- lead_events
drop trigger if exists trg_lead_events_immutable on public.lead_events;
create trigger trg_lead_events_immutable before update or delete on public.lead_events for each row execute function app.block_ledger_mutation();
drop trigger if exists trg_lead_events_no_truncate on public.lead_events;
create trigger trg_lead_events_no_truncate before truncate on public.lead_events for each statement execute function app.block_ledger_mutation();
-- message_log
-- message_log is append-only EXCEPT that personal text may be cleared (never changed) so erasure requests and retention
-- timers can remove message bodies and masked numbers without rewriting history.
create or replace function app.message_log_redaction_only() returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if app.is_maintenance() then
      return old;
    end if;
    raise exception 'message_log is an append-only ledger: delete is not allowed.'
      using errcode = 'P0001', hint = 'Insert a new row instead of changing history.';
  end if;
  if (to_jsonb(new) - 'body_preview' - 'to_masked') is distinct from (to_jsonb(old) - 'body_preview' - 'to_masked') then
    raise exception 'message_log is an append-only ledger: only body_preview and to_masked may be cleared.'
      using errcode = 'P0001';
  end if;
  if (new.body_preview is not null and new.body_preview is distinct from old.body_preview)
     or (new.to_masked is not null and new.to_masked is distinct from old.to_masked) then
    raise exception 'message_log: personal fields may only be cleared, not changed.' using errcode = 'P0001';
  end if;
  return new;
end
$$;

drop trigger if exists trg_message_log_immutable on public.message_log;
create trigger trg_message_log_immutable before update or delete on public.message_log for each row execute function app.message_log_redaction_only();
drop trigger if exists trg_message_log_no_truncate on public.message_log;
create trigger trg_message_log_no_truncate before truncate on public.message_log for each statement execute function app.block_ledger_mutation();
-- distributor_score_history
drop trigger if exists trg_distributor_score_history_immutable on public.distributor_score_history;
create trigger trg_distributor_score_history_immutable before update or delete on public.distributor_score_history for each row execute function app.block_ledger_mutation();
drop trigger if exists trg_distributor_score_history_no_truncate on public.distributor_score_history;
create trigger trg_distributor_score_history_no_truncate before truncate on public.distributor_score_history for each statement execute function app.block_ledger_mutation();

-- lead_consents: a legal ledger. Only the withdrawal fields (+ updated_at) may ever change, and a withdrawal cannot be undone.
create or replace function app.guard_consent_change() returns trigger
language plpgsql
as $$
declare
  v_allowed text[] := array['withdrawn_at', 'withdrawn_by', 'withdrawal_channel', 'optout_suppress_until', 'updated_at'];
begin
  if tg_op = 'DELETE' then
    -- API roles (service_role / authenticated, which connect through PostgREST) can never delete a consent. A database owner
    -- working in the SQL editor (session user postgres / supabase_admin) may, e.g. 99_delete_demo_data.sql removing the demo block.
    if app.is_maintenance() or session_user in ('postgres', 'supabase_admin') then
      return old;
    end if;
    raise exception 'Consent records are a legal ledger and cannot be deleted.' using errcode = 'P0001';
  end if;
  if (to_jsonb(new) - v_allowed) is distinct from (to_jsonb(old) - v_allowed) then
    raise exception 'Consent records are immutable: only the withdrawal fields can be set.' using errcode = 'P0001';
  end if;
  if old.withdrawn_at is not null and new.withdrawn_at is distinct from old.withdrawn_at then
    raise exception 'This consent has already been withdrawn and cannot be changed.' using errcode = 'P0001';
  end if;
  return new;
end
$$;

drop trigger if exists trg_lead_consents_guard on public.lead_consents;
create trigger trg_lead_consents_guard before update or delete on public.lead_consents for each row execute function app.guard_consent_change();
drop trigger if exists trg_lead_consents_no_truncate on public.lead_consents;
create trigger trg_lead_consents_no_truncate before truncate on public.lead_consents for each statement execute function app.block_ledger_mutation();

-- =====================================================================================================
-- 5. GUARD TRIGGERS (defence in depth - the API enforces the same rules first and returns a friendly error)
-- =====================================================================================================

-- rule_config: every rule must carry a source reference.
create or replace function app.guard_rule_source() returns trigger
language plpgsql
as $$
begin
  if btrim(coalesce(new.source_ref, '')) = '' then
    raise exception 'A rule cannot be saved without a source reference (circular, gazette notification, order or URL).'
      using errcode = 'P0001', hint = 'Fill in source_ref with where this value was taken from.';
  end if;
  return new;
end
$$;

drop trigger if exists trg_rule_config_source on public.rule_config;
create trigger trg_rule_config_source before insert or update on public.rule_config for each row execute function app.guard_rule_source();

-- opportunities: only created when requirement, timeline and commercial potential are all confirmed.
create or replace function app.guard_opportunity() returns trigger
language plpgsql
as $$
declare
  v_missing text[] := '{}';
begin
  if not new.requirement_confirmed then
    v_missing := array_append(v_missing, 'requirement');
  end if;
  if not new.timeline_confirmed then
    v_missing := array_append(v_missing, 'timeline');
  end if;
  if not new.commercial_potential_confirmed then
    v_missing := array_append(v_missing, 'commercial potential');
  end if;
  if cardinality(v_missing) > 0 then
    raise exception 'An opportunity cannot be created until the requirement, timeline and commercial potential are all confirmed (not yet confirmed: %).', array_to_string(v_missing, ', ')
      using errcode = 'P0001', hint = 'Confirm all three on the lead first, or keep the lead in qualification or nurture.';
  end if;
  return new;
end
$$;

drop trigger if exists trg_opportunities_guard on public.opportunities;
create trigger trg_opportunities_guard before insert on public.opportunities for each row execute function app.guard_opportunity();

-- sales_orders: gate G11. exposure_after = outstanding (open + overdue dealer receivables) + max(0, order total - advance received).
-- Blocked when exposure_after > dealers.credit_limit OR the dealer's portal_status = 'deactivated', unless an APPROVED
-- credit_overrides row exists for the dealer (and, when it names one, this PI / order).
-- Orders that are 'on_hold' or 'cancelled' are not live and are not checked; moving an order out of on_hold (or changing its
-- money or dealer) re-runs the check.
create or replace function app.guard_sales_order() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dealer record;
  v_outstanding numeric;
  v_exposure numeric;
  v_override boolean;
begin
  if new.dealer_id is null or new.status in ('on_hold', 'cancelled') then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if old.status not in ('on_hold', 'cancelled')
       and new.dealer_id is not distinct from old.dealer_id
       and new.total is not distinct from old.total
       and new.advance_received is not distinct from old.advance_received then
      return new;
    end if;
  end if;

  select d.legal_name, d.credit_limit, d.portal_status into v_dealer from public.dealers d where d.id = new.dealer_id;
  if not found then
    return new;
  end if;

  select coalesce(sum(greatest(0, r.amount - r.paid_amount)), 0) into v_outstanding
    from public.dealer_receivables r
   where r.dealer_id = new.dealer_id and r.status in ('open', 'overdue');
  v_exposure := v_outstanding + greatest(0, new.total - new.advance_received);

  if v_dealer.portal_status <> 'deactivated' and v_exposure <= v_dealer.credit_limit then
    return new;
  end if;

  select exists (
    select 1
      from public.credit_overrides o
     where o.org_id = new.org_id
       and o.dealer_id = new.dealer_id
       and o.status = 'approved'
       and (o.pi_id is null or o.pi_id = new.pi_id)
       and (o.sales_order_id is null or o.sales_order_id = new.id)
  ) into v_override;
  if v_override then
    return new;
  end if;

  if v_dealer.portal_status = 'deactivated' then
    raise exception 'Dealer % is deactivated on the PM Surya Ghar portal, so a sales order cannot be created for it without an approved credit override.', v_dealer.legal_name
      using errcode = 'P0001', hint = 'Ask Accounts to raise a credit override request for this dealer.';
  end if;
  raise exception 'Dealer % would exceed its credit limit: exposure after this order is Rs %, limit is Rs %. An approved credit override is needed.',
      v_dealer.legal_name, to_char(round(v_exposure), 'FM999,999,999,990'), to_char(round(v_dealer.credit_limit), 'FM999,999,999,990')
    using errcode = 'P0001', hint = 'Collect an advance, reduce the order, or request a credit override from Accounts.';
end
$$;

drop trigger if exists trg_sales_orders_guard on public.sales_orders;
create trigger trg_sales_orders_guard before insert or update on public.sales_orders for each row execute function app.guard_sales_order();

-- Dispatch guard helpers -------------------------------------------------------------------------------------

-- An approved compliance-lane override for this dispatch (approvals.entity_type = 'compliance_override'; entity_id is the
-- dispatch or its sales order, or approvals.meta.dispatch_id names the dispatch).
create or replace function app.has_compliance_override(p_org uuid, p_dispatch uuid, p_so uuid) returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.approvals a
     where a.org_id = p_org
       and a.entity_type = 'compliance_override'
       and a.decision = 'approved'
       and (a.entity_id = p_dispatch or a.entity_id = p_so or a.meta ->> 'dispatch_id' = p_dispatch::text)
  )
$$;

-- Why a serial cannot ship for a segment, or NULL when it can. Only module serials are checked.
--   pmsg_residential / pm_kusum need dcr_verified; every segment except ci_captive needs almm_list1; pmsg_residential,
--   rwa_ghs and government_bid also need almm_list2 when the expected commissioning date is on/after the rule
--   almm.list2.effective_date (fallback 2026-06-01 when the rule is absent - verify against the primary source).
create or replace function app.serial_noncompliance(p_org uuid, p_serial uuid, p_segment public.segment, p_commissioning date)
returns text
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_serial text;
  v_category text;
  v_snap jsonb;
  v_list2_from date;
begin
  select s.serial, k.category::text, s.compliance_snapshot into v_serial, v_category, v_snap
    from public.inventory_serials s
    join public.skus k on k.id = s.sku_id
   where s.id = p_serial;
  if not found or v_category <> 'module' then
    return null;
  end if;
  if p_segment in ('pmsg_residential', 'pm_kusum') and not coalesce((v_snap ->> 'dcr_verified')::boolean, false) then
    return format('module %s is not DCR-verified, which %s projects require', v_serial, p_segment);
  end if;
  if p_segment <> 'ci_captive' and not coalesce((v_snap ->> 'almm_list1')::boolean, false) then
    return format('module %s is not on ALMM List-I, which %s projects require', v_serial, p_segment);
  end if;
  if p_segment in ('pmsg_residential', 'rwa_ghs', 'government_bid') then
    v_list2_from := coalesce(nullif(app.rule_value(p_org, 'almm', 'list2.effective_date') #>> '{}', '')::date, date '2026-06-01');
    if coalesce(p_commissioning, current_date) >= v_list2_from and not coalesce((v_snap ->> 'almm_list2')::boolean, false) then
      return format('module %s is not on ALMM List-II (cells), required for %s projects commissioned on or after %s', v_serial, p_segment, v_list2_from);
    end if;
  end if;
  return null;
end
$$;

-- dispatches: may not move to 'dispatched' while compliance_status = 'blocked', or with a non-compliant module serial,
-- unless an approved compliance override exists.
create or replace function app.guard_dispatch() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_so record;
  v_reason text;
  r record;
begin
  if new.status <> 'dispatched' then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status = 'dispatched' then
    return new;
  end if;
  if app.has_compliance_override(new.org_id, new.id, new.so_id) then
    return new;
  end if;
  if new.compliance_status = 'blocked' then
    raise exception 'Dispatch % is blocked by a compliance hard stop and cannot go out until a compliance officer approves an override.', new.dispatch_no
      using errcode = 'P0001', hint = 'Resolve the compliance findings or raise a compliance override approval.';
  end if;
  select o.segment, o.expected_commissioning_date into v_so from public.sales_orders o where o.id = new.so_id;
  if not found then
    return new;
  end if;
  for r in select ds.serial_id from public.dispatch_serials ds where ds.dispatch_id = new.id loop
    v_reason := app.serial_noncompliance(new.org_id, r.serial_id, v_so.segment, v_so.expected_commissioning_date);
    if v_reason is not null then
      raise exception 'Dispatch % cannot go out: %.', new.dispatch_no, v_reason
        using errcode = 'P0001', hint = 'Swap the serial for a compliant one, or raise a compliance override approval.';
    end if;
  end loop;
  return new;
end
$$;

drop trigger if exists trg_dispatches_guard on public.dispatches;
create trigger trg_dispatches_guard before insert or update on public.dispatches for each row execute function app.guard_dispatch();

-- dispatch_serials: serials added to a dispatch that has already shipped are checked too.
create or replace function app.guard_dispatch_serial() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dispatch record;
  v_so record;
  v_reason text;
begin
  select d.status, d.so_id, d.dispatch_no into v_dispatch from public.dispatches d where d.id = new.dispatch_id;
  if not found or v_dispatch.status <> 'dispatched' then
    return new;
  end if;
  if app.has_compliance_override(new.org_id, new.dispatch_id, v_dispatch.so_id) then
    return new;
  end if;
  select o.segment, o.expected_commissioning_date into v_so from public.sales_orders o where o.id = v_dispatch.so_id;
  if not found then
    return new;
  end if;
  v_reason := app.serial_noncompliance(new.org_id, new.serial_id, v_so.segment, v_so.expected_commissioning_date);
  if v_reason is not null then
    raise exception 'Dispatch % cannot include this serial: %.', v_dispatch.dispatch_no, v_reason
      using errcode = 'P0001', hint = 'Use a compliant serial, or raise a compliance override approval.';
  end if;
  return new;
end
$$;

drop trigger if exists trg_dispatch_serials_guard on public.dispatch_serials;
create trigger trg_dispatch_serials_guard before insert or update on public.dispatch_serials for each row execute function app.guard_dispatch_serial();
