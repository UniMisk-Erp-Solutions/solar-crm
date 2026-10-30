# Architecture

## 1. Shape of the system

```
Browser (React)  ──JWT──►  Node API (Express)  ──service-role──►  Supabase Postgres / Storage
   │  Supabase JS: sign-in only                │  routes → services → Repo (data layer)
   └──────────────────────────────────────────► Supabase Auth (JWT issuer)
```

* The browser talks **only** to the Node API (`/api/v1`). Supabase JS in the browser is used for sign-in, session and password reset — nothing else. The service-role key lives only in the API's environment.
* The API authenticates the JWT, loads the user's `profile` (one org, one role, optional distributor/dealer), builds a per-request **`AppContext`** and authorises by role **and** by party/territory scope. Postgres RLS mirrors the same rules as defence in depth.
* **Demo mode**: with no Supabase variables the same API runs on an in-memory implementation of the data layer seeded from `packages/shared/src/seed`, with a role-switcher login and mock providers. Nothing else changes — services never know which store they use.

## 2. The data contract

`packages/shared/src/enums.ts` and `rows.ts` are the single definition of every table, column and enum (snake_case, exactly as stored). The SQL files are written from them and `npm run check:sql` proves they still match (67 enums, 67 tables, 1 151 columns, RLS and audit triggers on every table). The seed, API and web all import the same types, so a column rename is a compile error everywhere.

## 3. API layers

| Layer | Where | Responsibility |
|---|---|---|
| Edge | `app.ts`, `http/guards.ts` | helmet, CORS, rate limits, JSON limit, **Aadhaar guard (G14)** on every body, error shape `{ error: { code, message, details } }` |
| Auth | `auth/authenticate.ts`, `authorize.ts`, `access.ts` | JWT → profile → context; `allow(roles)`; `scopeWhere` gives each role/party its row-level filter (internal roles by territory; distributor/dealer by party) |
| Routes | `routes/*.routes.ts` | thin: Zod-parse → authorise → call a service → respond `{ data }` / `{ data, total, limit, offset }` |
| Services | `services/*.ts` | business rules and state machines, one module per stage; they call each other through `ctx.svc` contracts (rules, clocks, notify, consent, messaging, compliance) so tests can swap any of them |
| Data | `db/` | `Repo<T>` over a portable query model (no joins, no raw SQL): `MemoryDb` (demo + tests, emulates the SQL triggers that matter) and `SupabaseDb`; `scopeDb` pins every call to the organisation |
| Providers | `providers/` | WhatsApp, SMS, e-mail, DND, e-invoice, e-way bill, pincode, storage: typed interfaces, working mocks, SMTP and Supabase Storage adapters |
| Jobs | `jobs/`, `services/hooks.ts` | node-cron: clock tick every minute; nightly jobs registered by modules (re-quote scan, BG expiry, calendar countdowns, nurture re-activation, retention) |

There are **no database transactions** through the REST layer, so every multi-step write is ordered to stay recoverable and every guard is enforced twice: in the service (friendly error first) and in a SQL trigger (defence in depth).

## 4. The rule engine (heart of the system)

`rule_config` holds every legal/policy value: `category.key`, JSON value, `effective_from/to`, source name + reference, confidence (high/medium/low/hypothesis), status (verified/unverified/conflicting), `is_active`, `max_severity`, `enforce_hard_stop`. `ruleService.get(category, key, referenceDate)` returns the version in force on the reference date (commissioning date for compliance gates, quote date for pricing, today for SLAs).

**One decision point** turns a violated gate into a severity — `decideSeverity()` in `services/severity.ts`:

| Rule state | Result |
|---|---|
| verified **and** active | the gate's base severity (capped by `max_severity`) |
| active and `enforce_hard_stop` | the base severity — a Compliance Officer explicitly chose to enforce it |
| anything else (unverified, conflicting, inactive) | **advisory**: hard stops degrade to a *warning*, nothing blocks |
| no governing rule | information |

Every finding stores the exact `rule_config` ids it used, so any decision can be reproduced. The one documented inversion is **G9 for inverters** while `gst.inverter_rate` is *conflicting*: a conflicting rule demands a human tax decision, so the line is blocked until a CA-type user records the tax position.

## 5. Compliance engine

`complianceService.evaluateQuote` / `evaluateDispatch` run gates **G1–G14** against the project's segment, its expected commissioning date and the rules in force. Applicability by segment comes from the editable `gate_applicability` matrix (e.g. captive behind-the-meter jobs skip G3/G4 with a warning). A quote cannot be **sent**, and a sales order cannot be **dispatched**, while an un-overridden hard stop exists; overrides need a compliance-lane approval with a written reason. A **re-quote engine** flags open quotes when a rule, SKU compliance record or price snapshot they depend on changes.

## 6. Clocks and escalation

One generic `clocks` table drives every timer: lead acceptance, follow-up, quote follow-up, approval SLA, DISCOM feasibility (15-day deemed feasibility) and commissioning, CFA release, the legacy CFA claim deadline, MNRE SOP stages, grievance, loan ageing, RMA, ALMM-exemption commissioning, payment reminders. `tickClocks` (every minute) warns at 70 %, marks breaches at 100 %, then escalates owner → DSM → Sales Manager → Management. Lengths come from rules; all arithmetic respects the IST working calendar and holidays. Modules react to clock events through registered handlers (e.g. lead acceptance: Reminder 1 → DSM alert → auto-reassignment).

## 7. Consent and messaging

Customer messages go through one pipeline (`messagingService.send`): consent ledger (immutable rows; withdrawal fields only), purpose × channel check, DND freshness, 90-day post-opt-out suppression propagated to every named recipient, WhatsApp 24-hour window vs approved template category, SMS DLT template id + header — and every attempt, blocked or sent, is written to `message_log`.

## 8. Front end

`apps/web/src`: `components/ui` (design system), `components/domain` (status badges, SLA timers, timeline), `components/layout` (shell, module frame), `lib` (API client, auth, query hooks, module map), `pages/*` (home, leads, site, quotes, orders, control, settings, auth, public form).

The screens follow `Future_Solar_CRM_Flow Final.pdf`: a dashboard of five flow modules (Leads, Site & Opportunity, Quotation, Order, Control), each with two tabs covering steps 1–34 and stage 6. Light theme (white, olive green, near-black accent); Fraunces for headings, Manrope for text, IBM Plex Mono for codes, all self-hosted. Admin-only for now. The backend modules for other roles, post-sale, channel management, catalogue admin, rules admin and reports remain available through the API but have no screens.

## 9. KPIs

Dashboards and exports (52 KPIs, each with a plain-language definition and an `.xlsx` export) are computed in TypeScript from the base tables so demo and live behave identically; `supabase/sql/10_views.sql` carries equivalent SQL views for BI use. Definitions: `docs/KPI_DEFINITIONS.md`.
