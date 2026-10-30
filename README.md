# Future Solar CRM

A lead-to-order CRM for the Indian solar channel (brand → distributor → dealer/installer → end customer), built to the company's six-stage, 34-step flow and extended with the compliance, subsidy and post-dispatch controls that real Indian solar work needs: consent and DND, ALMM / DCR / BIS product gates, GST and price-validity, dealer credit, DISCOM and subsidy clocks, warranty and the compliance calendar.

* **Web**: React 18 + Vite + TypeScript, Tailwind, TanStack Query/Table, React Hook Form + Zod, Recharts, dnd-kit, react-i18next (English now; Hindi and Gujarati translations are deferred)
* **API**: Node 20 + Express + TypeScript, Zod on every route, pino, helmet, rate limits, node-cron, pdfkit, exceljs
* **Database**: Supabase Postgres, Auth and Storage — **SQL is supplied as numbered files that you run yourself**; nothing in this repo ever executes SQL

## 1. Try it now — demo mode (no Supabase needed)

```bash
npm install
npm run dev          # API on :4000, web on :5173
```

Open <http://localhost:5173> and press **Enter as Admin**. With no Supabase keys the app starts in **demo mode**: sample data lives in memory (it resets when the API restarts), and WhatsApp / SMS / e-mail / DND / e-invoice providers are safe mocks.

The UI is the company flow chart: the dashboard shows five modules in order — **Leads → Site & Opportunity → Quotation → Order → Control** — each with two tabs. Start with *Leads → Inquiries → New inquiry* and follow the **Next step** line on every record. Scoring, routing, reminders, escalation, recommendations and compliance checks run in the backend and only their results are shown. For now the app is **admin-only**.

## 2. Go live on Supabase

1. **Create a Supabase project** (supabase.com → New project). Note the *Project URL*, the *anon* key and the *service_role* key (Project Settings → API).
2. **Run the SQL files in order** in *SQL Editor* — `supabase/sql/01_…sql` to `12_seed_reference.sql`. The order, what each file does, and how to remove the demo data are in [`supabase/sql/RUN_ORDER.md`](supabase/sql/RUN_ORDER.md). (The files were validated by parsing and a column-by-column contract check against the TypeScript model — `npm run check:sql` — but never executed by us. Run them on a fresh project first.)
3. **Create the first administrator**: Authentication → Users → *Add user* (e-mail + password), copy the user's UUID, then run the one-line `insert into profiles …` snippet from `RUN_ORDER.md`.
4. **Configure the API**: copy `.env.example` to `apps/api/.env` and fill `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (**server only — never in the browser**), `CORS_ORIGINS`, and your provider settings.
5. **Configure the web app**: copy `apps/web/.env.example` to `apps/web/.env.local` and set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (the web app uses Supabase **only for sign-in**; all data goes through the API with the user's JWT).
6. `npm install` then `npm run dev`. Sign in with the administrator you created, add users under *Admin & rules → Users*, and review every rule in *Rule configuration* (see below).

## 3. Commands

| Command | What it does |
|---|---|
| `npm run dev` | API + web with hot reload |
| `npm run build` | Production build of shared, API and web |
| `npm run typecheck` | TypeScript strict across all workspaces |
| `npm run lint` | ESLint |
| `npm run test` | Vitest for shared, API and web |
| `npm run check:sql` | Parse-only validation of `supabase/sql/*.sql` + contract check against `rows.ts` |
| `npm run seed:sql` | Regenerate `12_seed_reference.sql` / `99_delete_demo_data.sql` from the TypeScript seed |
| `npm run i18n:extract` | Collect UI strings into `locales/en.json` and report missing Hindi / Gujarati |

## 4. How it is organised

```
apps/api        Express API (routes → services → data layer), cron jobs, provider adapters
apps/web        React app (design system, shell, one page per screen)
packages/shared Row types for every table, enums, Zod schemas, formatting, Aadhaar guard, seed data
supabase/sql    01–11 schema / functions / RLS / views / storage, 12 seed, 99 delete-demo, RUN_ORDER.md
docs            ARCHITECTURE, ASSUMPTIONS, RULES, RUNBOOK, API reference (docs/api/*), VERIFY_BEFORE_RELYING, BUILD_REPORT
```

Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) first.

## 5. The rules you must review before relying on any compliance result

Every legal or policy value (dates, rates, thresholds, clock lengths, scheme amounts) lives in the `rule_config` table with a **source, confidence and status** — nothing is hard-coded. Most values come from trade-press summaries, not gazette text. They are seeded with *"Verify against primary source before relying"*. **Unverified or conflicting rules are advisory only — they produce warnings and never block a transaction — until a Compliance Officer verifies and activates them** in *Admin & rules → Rule configuration*. The open questions are tracked in *Verify before relying* (`docs/VERIFY_BEFORE_RELYING.md`).

## 6. Security and privacy in one paragraph

JWT authentication on every route, role **and** party scoping in the API (a distributor sees only their own leads, quotes, orders and dealers) plus Postgres RLS as defence in depth; the service-role key exists only on the server; helmet, strict CORS, rate limits on public endpoints and login, 10 MB image/PDF upload limit with a virus-scan hook, short-lived signed URLs for documents, PII masked in logs and in lists (unmasking is an audited action), an immutable audit log, an append-only consent ledger with one-click withdrawal and 90-day suppression, DSAR export and erasure, a 72-hour breach workflow, and a hard block on Aadhaar numbers anywhere in the system.
