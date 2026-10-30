# Database setup - run order

These files build the Future Solar CRM database on **Supabase Postgres**. You run them by hand in the Supabase **SQL Editor**
(Dashboard -> SQL Editor -> New query -> paste the whole file -> Run). Nothing in this repository connects to your database by itself.

* Run the files **in numeric order, one at a time**, and wait for "Success" before starting the next one.
* All files are **idempotent** (re-running is safe) and never delete data.
* Before shipping, `npm run check:sql` (syntax + contract) and `npm run sql:local -- --whole --twice` (really executes every file,
  twice, inside a throw-away in-memory Postgres on your machine) must both pass.
* There is **no demo data** and no file 99 any more. File 12 holds real reference data only.

## The files

| Run | File | What it does |
|----:|------|--------------|
| 1 | `01_extensions_enums.sql` | Extensions, the `app` helper schema, all enum types. |
| 2 | `02_core_tables.sql` | organizations, profiles, discoms, territories, pincodes, distributors, dealers ... |
| 3 | `03_lead_tables.sql` | leads, consents, events, assignments, followups, customers, sites ... |
| 4 | `04_opportunity_catalogue.sql` | opportunities, requirement forms, SKUs, stock ... |
| 5 | `05_commercial_tables.sql` | documents, quotations, approvals, invoices, sales orders, payments, dispatches ... |
| 6 | `06_postsale_tables.sql` | loans, installations, DISCOM applications, subsidy, warranty ... |
| 7 | `07_platform_tables.sql` | rule_config, clocks, notifications, templates, audit log, compliance calendar ... |
| 8 | `08_functions_triggers.sql` | triggers, ledger immutability, consent guard, duplicate detection, scoring, working-time maths, guard triggers. |
| 9 | `09_rls_policies.sql` | Row level security and policies. |
| 10 | `10_views.sql` | Dashboard views. |
| 11 | `11_storage_buckets.sql` | Five private Storage buckets and their policies. |
| 12 | `12_seed_reference.sql` | **Generated** (`npm run seed:sql`). Organization, DISCOMs, rules, templates, compliance calendar, verify register, gates, approval rules, forms, Gujarat pincodes and sales territories. |
| 13 | `13_first_admin.sql` | Creates the CRM profile (role `admin`) of `admin@mistryandshah.com` from Supabase Auth. |
| 14 | `14_cron.sql` | The scheduler (pg_cron): clock engine every minute, breach watch hourly, nightly jobs at 02:00 IST. Run it **after** the API function is deployed and after storing the two vault secrets described at the top of the file (see docs/DEPLOY.md). |

## Creating the first admin (file 13)

1. Supabase Dashboard -> Authentication -> Users -> **Add user** -> e-mail `admin@mistryandshah.com`, your password, tick
   **Auto Confirm User**. (Or sign up in the app and confirm the e-mail.)
2. Run `13_first_admin.sql`. It finds the user by e-mail, inserts the `profiles` row with role `admin`, and marks the e-mail confirmed.
3. For a different admin, change `v_email` at the top of file 13.

## Connecting the API

The API is a Supabase Edge Function; see docs/DEPLOY.md. It receives SUPABASE_URL and the service_role key from Supabase itself. The web app needs only the URL, the anon key and the function address (apps/web/.env.local).

## Quick checks after running 01-13

```sql
select count(*) from public.organizations;                       -- 1
select count(*) from public.rule_config;                         -- > 0
select count(*) from public.territories;                         -- 5
select email, role from public.profiles;                         -- your admin
```
