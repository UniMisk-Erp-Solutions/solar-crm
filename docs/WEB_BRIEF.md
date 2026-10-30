# Front-end brief v2 — the simple, flow-first CRM (read this completely)

The owner rejected the first UI as "messy, too many menus, too much data". This is a **rebuild around one picture: `Future_Solar_CRM_Flow Final.pdf`** (its text is reproduced in `Solar CRM flow diagrams.md` §1 and §17 — steps 1–34, the SLA boxes, the work instructions, the escalation matrix, conversion gates and KPIs).

## Product rules
1. **Admin only.** One role (admin) uses the app for now. No role switching, no role-based hiding, no external-user screens.
2. **The flow chart is the product.** The dashboard is five flow cards in order, each module has **2 sections (tabs) at most**, and every step of the PDF must be doable somewhere in those sections. Anything not in the PDF has no screen (no catalogue admin, dealers, distributors, post-sale, reports, calendar, admin tools…). The backend keeps all of that logic; the UI simply does not expose it.
3. **Engines stay in the backend.** Routing, de-duplication, lead score and temperature, reminders, escalation clocks, follow-up cadence, price validation / compliance checks, product recommendation are automatic. The UI shows their *results* in one plain line ("Assigned to Alpha Solar — must accept within 30 min", "Score 72 · Warm", "Next reminder: Day 3") and never exposes their internals (no gate codes G1–G14, rule ids, confidence tags, clocks tables).
4. **Plain words.** Use the PDF's wording (Inquiry, Qualification call, Temperature, Convert to opportunity, Approval matrix, Proforma invoice, Sales order, Hand over to dispatch planning). No jargon, no emoji. ₹ with Indian grouping (`formatINR`), dates `DD-MMM-YYYY` (`formatDate`).

## Module map (routes already exist in `src/routes.tsx`; do not edit it — you only replace the placeholder files)
| Module (dashboard card) | Sections (tabs via `<ModulePage module=… >`) | PDF steps |
|---|---|---|
| **Leads** `/leads`, `/leads/:id` | **Inquiries**, **Follow-ups** | 1–7, 8–13 |
| **Site & Opportunity** `/site` | **Site visits**, **Opportunities** | 14–18, 19–20 |
| **Quotation** `/quotes`, `/quotes/:id` | **Quotations**, **Approvals** | 21–22, 24–27 · 23 |
| **Order** `/orders`, `/orders/pi/:id`, `/orders/so/:id` | **Proforma & payment**, **Sales orders** | 28–30 · 31–34 |
| **Control** `/control`, `/settings` | **KPIs**, **Escalations** | stage 6 |

`ModulePage` (in `components/layout/ModulePage.tsx`) renders the breadcrumb, title, tabs and "steps of the flow" line; you render the content of each tab. Keep detail views (`/leads/:id` …) as one calm page.

## Design rules (strict)
* **Light theme only**: white cards on a warm off-white page; **olive green** (`primary`) for the main action and highlights; **near-black** (`accent`, buttons with `variant="accent"`, the dashboard pills) as the small contrast; greys for text. Use only the semantic Tailwind tokens (`bg-surface`, `bg-bg`, `border-border`, `text-fg`, `text-muted`, `text-subtle`, `bg-primary`, `bg-primary-soft`, `text-primary-text`, `bg-accent`, `text-danger-text` …). Never raw hex.
* **Typography**: headings and big numbers use the display serif (`font-display` / `.display`, Fraunces); body and controls use Manrope (default); reference numbers / codes use `.code` (IBM Plex Mono). Page title 34–36 px, section titles 18–22 px, body 15 px, labels 13–14 px semibold.
* **Breathing space**: cards `p-6`, 24–32 px between sections (`space-y-8`), forms `gap-5`, table rows ≥ 56 px tall. **Maximum content width 1120 px** (the `Page`/`.page` wrapper already does that).
* **Less on every screen**: a list shows 4–6 columns; a form shows ≤ 7 fields at once (put the rest under a "More details" toggle); a detail page shows ≤ 3 cards above the fold. Never show a field that the flow does not need. Numbers: tabular (`.tabular`, `Money`, `DateText`, `Kw`).
* **One primary button per screen** (olive), everything else secondary/ghost. Destructive → `ConfirmDialog`. If an action is blocked, say why in one sentence next to the button.
* **Every list**: search box + at most **one** row of status pills (`FilterPills`) — no filter bars. Click a row to open it. Loading skeleton, empty state with the next action, error state with retry (`DataTable` handles all three).
* **Every record page** starts with a one-line **"Next step"** statement and one button (what the PDF says comes next), then the content.
* Accessible: labels on every control, visible focus, keyboard-friendly, AA contrast (tokens already comply).
* **Do not use a browser of any kind** (no Playwright, Chromium, Claude-in-Chrome, preview tools). Verify with `tsc`, `eslint`, Vitest and curl against the API only.

## Toolkit (import with `@/`)
`@/lib/query` (`useGet`, `useList`, `useAction({ method, path, invalidate, successMessage })`), `@/lib/api` (`api`, `ApiError`, `.fieldErrors`), `@/lib/auth`, `@/lib/hooks` (`useUrlState`, `useDebounced`), `@/components/ui/*` (`Button`, `Field`/`Input`/`Select`/`Textarea`/`Checkbox`, `Card`/`CardHeader`/`CardBody`, `Page`/`PageHeader`, `Callout`, `EmptyState`, `ErrorState`, `StatTile`, `KeyValue`, `Tabs`, `Modal`/`Drawer`/`ConfirmDialog`, `Menu`, `Badge`, `DataTable`, `SearchInput`, `FilterPills`), `@/components/domain/status` (`StatusBadge`, `TemperatureBadge`), `@/components/domain/values` (`Money`, `DateText`, `DateTimeText`, `Kw`, `Pct`, `SlaTimer`, `RelativeDay`), `@/components/domain/timeline`, `@/components/layout/ModulePage`, `@solar/shared` (row types, enums, `formatINR`, `formatDate`, validators, Zod schemas in `schemas/*`). Forms: React Hook Form + Zod. i18n: wrap visible text as `t('area.key', 'English text')` with literal key and literal default (translations are deferred, English only). The previous implementation is kept for **reference of API usage only** at `C:\Users\Galaxy\AppData\Local\Temp\claude\c--Users-Galaxy-Desktop-Preet-Internship-Solar-CRM\946c99eb-a333-4cb0-9fb1-39d0b0081c70\scratchpad\old-web-src` (copy the request/response handling, **not** the layout or density).

## API
Exact shapes: `docs/api/leads.md`, `docs/api/sites-opportunities.md`, `docs/api/quotes.md`, `docs/api/orders.md`, `docs/api/dashboards.md`, `docs/api/platform-admin.md` (rules/SLA). Start the real API for curl checks with `cd apps/api && PORT=4000 npx tsx src/server.ts` (demo mode with seed data; sign in via `POST /api/v1/auth/demo-login {profile_id}`, the admin profile is in `GET /api/v1/auth/demo-users`). The API is final — if something is missing or wrong, work around it in the UI and report it; do not edit `apps/api`.

## Checks (repo root) and report
`npx tsc --noEmit -p apps/web` clean for your files; `npx eslint <your folders>` clean; Vitest + Testing Library tests next to your pages using `renderPage` from `src/test/utils.tsx` (test the key behaviours named in your task, incl. empty/error states). Do not touch files outside your ownership, `package.json`, `routes.tsx`, `lib/*`, `components/ui/*`. Be economical — read only the doc sections you need. Final report ≤ 200 words: files, endpoints used, gaps in the API.
