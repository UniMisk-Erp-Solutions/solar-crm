# Build report

Position: 27-Oct-2026. Verified by running the commands below on the finished repository.

## What was built
| Area | Result |
|---|---|
| Shared contract (`packages/shared`) | 67 tables and 67 enums as TypeScript types, Zod schemas, formatting, Aadhaar guard, seed data (145 rules, calendar, 17 demo users, 23 leads, 24 quotes incl. one per compliance gate) |
| API (`apps/api`) | Express + TypeScript: auth and party scoping, rule engine, compliance engine G1–G14, clock engine, consent-aware messaging, lead → quote → PI → order → dispatch → post-sale services, dashboards and exports, jobs, providers (mocks + SMTP + Supabase Storage). About 450 endpoints; reference in `docs/api/` |
| SQL (`supabase/sql`) | Files 01–11, generated 12 (seed) and 99 (delete demo), `RUN_ORDER.md`. Validated by parsing and a contract check; **never executed** |
| Web (`apps/web`) | Rebuilt around the flow PDF: dashboard of five flow modules, two tabs each, light olive theme, admin only |
| Docs | README, ARCHITECTURE, ASSUMPTIONS, API, RULES (generated), RUNBOOK, KPI_DEFINITIONS, VERIFY_BEFORE_RELYING, DEMO_SCENARIOS, FLOW_TRACEABILITY, ERP_EXPORT |

## Verification (all run on 27-Oct-2026)
* `eslint .` — clean. `npm run typecheck` — clean (shared, API, web).
* Tests — shared 93, API 735 (59 files), web 53 (9 files): **all pass**.
* `npm run check:sql` — PASS: 67/67 enums, 67/67 tables (1 151 columns) match the TypeScript model; RLS on all tables; audit triggers on all 57 audited tables.
* `npm run build` — shared, API and web build; the built API starts and serves `/health` and the demo users.
* **Flow conformance**: `apps/api/test/e2e/flow*.ts` drives a project through `Solar CRM flow diagrams.md` and fails if any of the 34 steps or extension nodes has no assertion (traceability in `docs/FLOW_TRACEABILITY.md`).
* Admin screens: every endpoint the five modules call on load answers for the admin on the seed data (`test/e2e/pagesApi.test.ts`), and the admin can accept, contact, qualify and approve (`adminActions.test.ts`).

## Not done / limits
* **No browser testing**: by instruction the screens were verified with unit tests and API calls only; nobody has clicked through them in a browser yet. Expect cosmetic fixes on first use.
* SQL has not been run on a real Supabase project; run it on a fresh project first.
* Hindi and Gujarati translations are deferred (English only).
* Only mock providers exist for WhatsApp, SMS, DND, e-invoice and e-way bill.
* Regulatory values are trade-press summaries seeded as advisory until a Compliance Officer verifies them (`docs/VERIFY_BEFORE_RELYING.md`).
* Screens for roles other than admin, post-sale, dealers, distributors, catalogue admin, rule admin and reports were removed from the UI at the owner's request; the backend for them remains.
* Known small gaps reported by the engineers: no signed-in consent-notice endpoint (the staff form uses built-in text); the Escalations tab lists breached clocks and overdue follow-ups only; the shortlist of recommended products is on-screen only.
