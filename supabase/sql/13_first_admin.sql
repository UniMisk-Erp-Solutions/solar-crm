-- =====================================================================================================
-- 13_first_admin.sql
-- Purpose : creates the CRM profile (role admin) for the first administrator, who must already exist in
--           Supabase Auth (Authentication > Users). Looks the user up by e-mail, so no uuid needs to be pasted.
-- Run after: 12_seed_reference.sql
-- To make a different person the admin, change the e-mail below. Safe to run again.
-- =====================================================================================================

begin;

do $$
declare
  v_email  text := 'admin@mistryandshah.com';
  v_name   text := 'Admin';
  v_uid    uuid;
  v_org    uuid := 'be9c92a8-c19c-4c09-8c39-000000000001';
begin
  select id into v_uid from auth.users where lower(email) = lower(v_email) limit 1;
  if v_uid is null then
    raise exception 'No Supabase Auth user with e-mail %. Create it first under Authentication > Users (tick "Auto Confirm User"), then run this file again.', v_email;
  end if;
  if not exists (select 1 from public.organizations where id = v_org) then
    raise exception 'Organization % is missing - run 12_seed_reference.sql first.', v_org;
  end if;

  insert into public.profiles (id, org_id, full_name, email, role, designation, active)
  values (v_uid, v_org, v_name, lower(v_email), 'admin', 'System administrator', true)
  on conflict (id) do update set role = 'admin', active = true, org_id = excluded.org_id;

  -- allow the password sign-in even if the confirmation e-mail was never clicked
  update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()) where id = v_uid;
end
$$;

commit;
