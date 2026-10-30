-- =====================================================================================================
-- 14_cron.sql
-- Purpose : the scheduler. The whole backend runs in Supabase, so Supabase itself calls the API function on a timetable:
--             every minute   clock engine (reminders at 70 % of the time, DSM alert, auto-reassignment, SLA escalation)
--             every hour     breach watch
--             02:00 IST      nightly jobs (distributor scores, KPI snapshots, compliance calendar, data quality ...)
-- Run after: 13_first_admin.sql, AND after the API function is deployed (docs/DEPLOY.md).
-- Idempotent: cron.schedule() replaces a job of the same name.
--
-- BEFORE running this file, store two secrets once (SQL Editor), with your own values:
--     select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
--     select vault.create_secret('<the same value you gave the function as CRON_SECRET>', 'cron_secret');
-- =====================================================================================================

-- pg_cron (timetable) and pg_net (HTTP calls from the database). On Supabase both are available; pg_net lives in the `extensions` schema.
do $$
begin
  create extension if not exists pg_cron;
  create extension if not exists pg_net with schema extensions;
exception when feature_not_supported then
  raise notice 'pg_cron / pg_net are not available in this database (only expected outside Supabase): %', sqlerrm;
end
$$;

do $$
declare
  v_call text;
begin
  if not exists (select 1 from vault.decrypted_secrets where name = 'project_url') or not exists (select 1 from vault.decrypted_secrets where name = 'cron_secret') then
    raise exception 'Create the two vault secrets first (project_url and cron_secret) - see the comment at the top of this file.';
  end if;

  -- one HTTP GET to the function per tick; the URL and the secret are read from the vault when the job runs
  v_call := $call$
    select net.http_get(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/api/api/v1/internal/cron?kind=%KIND%',
      headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
      timeout_milliseconds := 55000
    )
  $call$;

  perform cron.schedule('solar-clock-tick', '* * * * *',  replace(v_call, '%KIND%', 'tick'));
  perform cron.schedule('solar-breach-watch', '0 * * * *',  replace(v_call, '%KIND%', 'hourly'));
  perform cron.schedule('solar-nightly',      '30 20 * * *', replace(v_call, '%KIND%', 'nightly'));   -- 20:30 UTC = 02:00 IST
end
$$;
