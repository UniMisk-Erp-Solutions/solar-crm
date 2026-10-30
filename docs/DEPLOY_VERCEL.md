> Alternative only. The recommended setup is Vercel for the web app and Render for the API: see docs/DEPLOY.md.

# Deploying to Vercel

Two Vercel projects from the same GitHub repository: **solar-crm-api** (Express as one serverless function) and **solar-crm-web** (the React app).
Deploy the API first, then the web app (it needs the API address).

## 0. Database (once)
Run `supabase/sql/01 … 13` in the Supabase SQL Editor (see `supabase/sql/RUN_ORDER.md`), and create the first admin user in Supabase Auth.

## 1. API project
Vercel → Add New → Project → import the repo → **Root Directory: `apps/api`** (leave "Include source files outside of the Root Directory" ON).
Framework preset: *Other*. Build/output settings come from `apps/api/vercel.json`.

Environment variables (Production, and Preview if you use it):

| Name | Value |
|---|---|
| `NODE_ENV` | `production` |
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | the **service_role** key (Supabase → Project Settings → API). Secret; never in the web project |
| `CORS_ORIGINS` | the web app address, e.g. `https://solar-crm-web.vercel.app` (comma-separate several; include a custom domain) |
| `PUBLIC_API_URL` | the API address, e.g. `https://solar-crm-api.vercel.app` |
| `CRON_SECRET` | a long random string. Vercel sends it to the cron endpoints |
| `FILE_TOKEN_SECRET` | a long random string. Signs download links; without it every function instance invents its own and links break |
| `UNSUBSCRIBE_TOKEN_SECRET` | another long random string (unsubscribe links in messages) |
| `RUN_JOBS` | `false` (the in-process scheduler cannot run on serverless; Vercel Cron does it) |
| `MAX_UPLOAD_MB` | `4` (a Vercel function accepts at most 4.5 MB per request) |
| `SESSION_TIMEOUT_MINUTES` | `480` (optional) |
| `AUTH_RATE_LIMIT_PER_15MIN`, `PUBLIC_RATE_LIMIT_PER_MIN` | optional, defaults 30 / 30 |
| `WHATSAPP_PROVIDER`, `SMS_PROVIDER`, `DND_PROVIDER`, `EINVOICE_PROVIDER`, `EWAYBILL_PROVIDER` | `mock` (only mock providers exist today) |
| `EMAIL_PROVIDER` | `mock`, or `smtp` with `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` |

Do **not** set `DEMO_MODE` (leave it out) so the API runs in live mode.

Check: `https://<api>/health` returns `{"ok":true,"mode":"live"}`.

### Scheduled work (Vercel Cron)
`apps/api/vercel.json` registers three crons: every minute (clock engine: reminders, DSM alerts, auto-reassignment), hourly (breach watch) and 02:00 IST (nightly jobs).
Per-minute crons need the **Pro** plan; on Hobby, Vercel allows only one run per day, so the reminder / escalation loop will not tick often enough there.
Alternative on Hobby: call `GET https://<api>/api/v1/internal/cron?kind=tick` every minute from an external scheduler with the header `Authorization: Bearer <CRON_SECRET>`.

## 2. Web project
Add New → Project → same repo → **Root Directory: `apps/web`**. Framework preset: *Vite* (from `apps/web/vercel.json`).

| Name | Value |
|---|---|
| `VITE_API_URL` | the API address, e.g. `https://solar-crm-api.vercel.app` (no trailing slash) |
| `VITE_SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | the **anon / public** key (never the service_role key) |

These are baked into the build, so redeploy the web project after changing them.

## 3. Supabase Auth settings
Authentication → URL Configuration: set **Site URL** to the web address and add it (and `https://<web>/login`) to **Redirect URLs**, so confirmation and password-reset e-mails come back to the app.

## 4. After the first deploy
1. Open the web address and sign in with the admin user.
2. If sign-in shows "no CRM access", run `supabase/sql/13_first_admin.sql` (or insert the profile row).
3. Add the web address to `CORS_ORIGINS` if you used a custom domain, then redeploy the API.

## Limits to know
- Uploads through the API are limited to about 4 MB per file on Vercel.
- The rate limiter keeps its counters in each function instance's memory, so limits are approximate across instances.
- `RUN_JOBS=true` only applies to the long-running `npm start` server, not to Vercel.
