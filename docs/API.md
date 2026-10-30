# API reference

Base path `/api/v1`. JSON in, JSON out. Interactive per-module references (exact request/response shapes, roles, rules read) are in `docs/api/`:

| Module | Document |
|---|---|
| Lead capture, consent, messaging, follow-ups, public forms and webhooks | [`api/leads.md`](api/leads.md) |
| Customers, sites, surveys, requirement forms, feasibility, negotiation, opportunities, convert | [`api/sites-opportunities.md`](api/sites-opportunities.md) |
| SKUs and compliance register, prices, stock and serials, quotes, approvals, compliance engine | [`api/quotes.md`](api/quotes.md) |
| Proforma invoices, payments, credit, sales orders, dispatch, ERP export | [`api/orders.md`](api/orders.md), [`ERP_EXPORT.md`](ERP_EXPORT.md) |
| Installations, DISCOM, subsidy claims, loans, warranty, distributors, dealers, vendor registrations, SOP | [`api/postsale-channel.md`](api/postsale-channel.md) |
| Rules, clocks, notifications, compliance calendar, verify register, admin, documents, privacy, breaches, jobs | [`api/platform-admin.md`](api/platform-admin.md) |
| Dashboards, KPI exports, global search | [`api/dashboards.md`](api/dashboards.md), [`KPI_DEFINITIONS.md`](KPI_DEFINITIONS.md) |

## Conventions

* **Auth**: `Authorization: Bearer <JWT>` (Supabase access token; in demo mode a `demo.<id>.<time>` token from `POST /auth/demo-login`). Public routes (`/public/*`, `/webhooks/*`, `/files/:token`, `/auth/mode`, `/auth/demo-*`) need none; public lead capture needs a per-source `X-Api-Key`.
* **Success**: `{ "data": … }`. **Lists**: `{ "data": […], "total", "limit", "offset" }` with `?q=` (search), column filters (`?status=a,b`, `?created_at__gte=…`), `?sort=&order=asc|desc`, `?limit=&offset=`.
* **Errors**: `{ "error": { "code", "message", "details" } }` — codes: `VALIDATION_ERROR` (422, `details[] = { path, message }`), `UNAUTHENTICATED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), `CONFLICT` / `INVALID_STATE` (409), `GUARD_BLOCKED` (422 — a business guard such as the opportunity confirmations or the credit limit), `COMPLIANCE_BLOCKED` (422), `CONSENT_BLOCKED` (422), `AADHAAR_BLOCKED` (422), `RATE_LIMITED` (429), `INTERNAL` (500).
* **Scoping**: every query is pinned to the caller's organisation; external users (`distributor_user`, `dealer_user`) only ever receive their own party's rows; internal users restricted by `profile.territory_ids` see those territories.
* **Privacy**: mobile numbers and e-mails are masked in payloads for roles without a need to see them; `POST /leads/:id/unmask` reveals one and is audited.
* **Audit**: every mutation writes `audit_log` (business action, actor, request id) in addition to the database's own row-change trigger.
* **Time**: ISO-8601 UTC timestamps, `YYYY-MM-DD` dates, money as plain rupees.
