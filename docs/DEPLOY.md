# Deployment

Where each part lives:

| Part | Where |
|---|---|
| Web app (React) | **Vercel** (frontend only) |
| Database, sign-in, file storage | **Supabase** |
| API (Node/Express: approvals, compliance, lead routing, reminders, exports) | **Render** (an always-on Node host) |

The API cannot run inside Supabase (it is a Node program, Supabase Edge Functions run Deno) and it should not run on Vercel, which only suits the frontend and cannot run the reminder engine every minute on the free plan.

## 1. Supabase
Run supabase/sql/01 to 13 in the SQL Editor. Create the first admin in Authentication, then run 13_first_admin.sql.
Authentication > URL Configuration: Site URL = the Vercel address; add it and <vercel address>/login to Redirect URLs.

## 2. API on Render
Render > New > Blueprint > this repo (it reads render.yaml). Fill in:

| Variable | Value |
|---|---|
| SUPABASE_URL | https://<project-ref>.supabase.co |
| SUPABASE_SERVICE_ROLE_KEY | the service_role key (secret, only here) |
| CORS_ORIGINS | the Vercel address, e.g. https://solar-crm.vercel.app |
| PUBLIC_API_URL | the Render address, e.g. https://solar-crm-api.onrender.com |

Already set by the blueprint: NODE_ENV=production, RUN_JOBS=true (reminder engine and nightly jobs run inside the service), MAX_UPLOAD_MB=10, and generated FILE_TOKEN_SECRET / UNSUBSCRIBE_TOKEN_SECRET.
Do not set DEMO_MODE. Check https://<render address>/health shows "mode":"live".

## 3. Web on Vercel
Import the repo, Root Directory = apps/web (framework Vite, settings come from apps/web/vercel.json). Variables:

| Variable | Value |
|---|---|
| VITE_SUPABASE_URL | https://<project-ref>.supabase.co |
| VITE_SUPABASE_ANON_KEY | the anon (public) key |
| VITE_API_URL | the Render address, no trailing slash |

Redeploy the web project after changing a variable (they are built in).

## Notes
- The service_role key is only ever in Render. The Vercel project holds only public values.
- docs/DEPLOY_VERCEL.md describes the alternative of running the API on Vercel too (serverless + Vercel Cron). It is not needed with Render.
