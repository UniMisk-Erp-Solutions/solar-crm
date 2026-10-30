# Deployment: everything on Supabase, the web app on Vercel

| Part | Where |
|---|---|
| Web app (React) | **Vercel**: frontend only |
| Database, sign-in, file storage | **Supabase** |
| API (approvals, compliance, lead routing, exports) | **Supabase Edge Function** named `api` |
| Scheduler (reminders, DSM alerts, auto-reassignment, nightly jobs) | **Supabase** `pg_cron` calling the function |

Vercel never sees a secret: it only holds the public Supabase URL and anon key.

## 1. Database
SQL Editor: run `supabase/sql/01` to `13` in order (`RUN_ORDER.md`). Create the first admin in Authentication, then run `13_first_admin.sql`.

## 2. Deploy the API (Edge Function)
One time, on your machine (Node 20+), from the repository root:

```
npm ci
npx supabase login
npx supabase link --project-ref <project-ref>
npx supabase secrets set CORS_ORIGINS=https://<your-vercel-address> PUBLIC_API_URL=https://<project-ref>.supabase.co/functions/v1/api CRON_SECRET=<long random string> FILE_TOKEN_SECRET=<long random string> UNSUBSCRIBE_TOKEN_SECRET=<long random string>
npm run deploy:api
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected into the function by Supabase; you do not set them.
Do not set `DEMO_MODE`. Check: `https://<project-ref>.supabase.co/functions/v1/api/health` returns `{"ok":true,"mode":"live"}`.

API paths look like `https://<project-ref>.supabase.co/functions/v1/api/api/v1/auth/mode` (the first `api` is the function name, the rest is the API's own `/api/v1/...`).
When the web address changes (custom domain, new Vercel project), update the allowed origin: `npx supabase secrets set CORS_ORIGINS=https://<web address>` (comma-separate several), no redeploy needed beyond the next function start.

Automatic deploys: add the repository secrets `SUPABASE_ACCESS_TOKEN` and `SUPABASE_PROJECT_REF` on GitHub; `.github/workflows/deploy-api.yml` then redeploys the function on every push to `main` that changes backend code.

## 3. Turn on the scheduler
SQL Editor, once, with your values (the cron secret must equal the `CRON_SECRET` you gave the function):

```
select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
select vault.create_secret('<the same CRON_SECRET>', 'cron_secret');
```

Then run `supabase/sql/14_cron.sql`. It registers three jobs: every minute (clock engine), hourly (breach watch) and 02:00 IST (nightly jobs).
Check under Database > Cron that the three `solar-*` jobs exist, and under Edge Functions > api > Logs that calls arrive.

## 4. Web app on Vercel
Vercel lists two apps it found (api and web). Deploy only the web app: click **Import single project** next to **web** (this sets Root Directory to `apps/web`; framework Vite). The api app is NOT deployed on Vercel, it is already running on Supabase. (If you import at the repository root instead, the root `vercel.json` builds only the web app too.) Environment variables:

| Variable | Value |
|---|---|
| `VITE_SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | the anon (public) key |
| `VITE_API_URL` | `https://<project-ref>.supabase.co/functions/v1/api` |

Redeploy after changing a variable (they are built in).

## 5. Supabase Auth
Authentication > URL Configuration: Site URL = the Vercel address; add it and `<vercel address>/login` to Redirect URLs.

## Local development
`npm run dev` still runs the API as a normal Node server (port 4000) next to the web app, and uses in-memory demo data until the Supabase variables are in `apps/api/.env`.

## Limits and checks
- The function is one bundle built from `apps/api` (`npm run build:edge`, about 2.4 MB). It is generated, not committed.
- Supabase limits an Edge Function request to a few seconds of CPU time; heavy exports on very large data may need narrowing by date.
- PDF and Excel export load `pdfkit` and `exceljs` from npm inside the function. Try one quotation PDF and one report export after the first deploy.
- Rate limiting keeps its counters in memory per function instance, so limits are approximate.
- Built-in checks done on the live project: health in live mode, sign-in and /auth/me, a list read, an Excel export, CORS, and the per-minute scheduler call (HTTP 200). PDF generation was verified inside the Supabase runtime with a test document.
