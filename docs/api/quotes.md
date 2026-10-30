# API — Catalogue, compliance engine, quotations, approvals (Stage 4)

Base path `/api/v1`. All responses are `{ data }`; lists are `{ data, total, limit, offset }`; errors are `{ error: { code, message, details } }`.
Row types (`Sku`, `SkuCompliance`, `SkuPrice`, `StockBatch`, `InventorySerial`, `Quotation`, `QuotationLine`, `QuoteDiscussion`, `Approval`, `Finding`, `FloorCheck`, `Clock`) are in `packages/shared/src/rows.ts`;
request schemas (Zod) are in `packages/shared/src/schemas/catalogue.ts` and `quotes.ts`.
`admin` may call everything. "internal" = every role except `distributor_user` / `dealer_user`. Money is rupees (number); dates `YYYY-MM-DD`; timestamps ISO-8601 UTC.

Error codes used here: `VALIDATION_ERROR` 422, `FORBIDDEN` 403, `NOT_FOUND` 404, `CONFLICT` 409, `INVALID_STATE` 409 (wrong status), `GUARD_BLOCKED` 422 (business guard),
`COMPLIANCE_BLOCKED` 422 (`details.findings` = the hard stops), `CONSENT_BLOCKED` 422 (`details.reasons`), `AADHAAR_BLOCKED` 422 (edge guard on any JSON body).

---

## 1. Compliance engine — concepts

* **Finding** `{ gate: 'G1'..'G14', severity: 'info'|'warning'|'hard_stop', message, ruleIds: uuid[], fieldRefs: string[], overridden?, ruleStatus?, ruleConfidence?, ruleSource?, advisory? }`.
  `fieldRefs` look like `line:<quotation_lines.id>`, `serial:<serial no>`, `dealer:<id>`, `validity_date`, `kw`, `lead_id`, `site.name_match`, `document:<id>`.
* **Evaluation** (`POST /quotes/:id/evaluate`, `POST /compliance/preview`) returns
  `{ findings, hasHardStop, status: 'clear'|'warnings'|'blocked', ruleIdsUsed, evaluated_at, gates: GateSummary[], overridesApplied, overridesStale }` where
  `GateSummary = { gate, title, applicability: 'applies'|'not_applies'|'warning', status: 'pass'|'warn'|'fail'|'skipped', severity, messages[] }`.
  `ruleIdsUsed` = every rule version consulted (also the ones that passed) — this is what the re-quote engine matches on.
* **Severity** is decided only by the rule that governs the gate: a rule that is not `verified` + `active` can never produce a hard stop — it degrades to a `warning` with `advisory: true`
  (unless a compliance officer set `enforce_hard_stop`). Governing rules: G1 `trai.optout_reconsent_block_days` · G2 `pmsg.dcr_required_for_cfa` · G3 `almm.list1.enforcement_date` ·
  G4 `almm.list2.effective_date` · G5 `almm.list2.exemption_net_metering_open_access_until` · G6 `bis.module_standard_no` · G7 `bis.inverter_self_cert_above_kw` + `_until` ·
  G8 `quote.max_price_snapshot_age_days` · G9 `gst.<category>_rate` · G10 `compliance.almm_snapshot_max_age_days` · G13 `pmsg.cfa.max_kw_eligible` · G14 `compliance.aadhaar_block` · G11, G12 design rules.
  **G9 inversion (deliberate):** an inverter line whose tax position is not approved by a CA-type user is a HARD STOP while `gst.inverter_rate` is `conflicting` — a conflicting rule needs a human tax decision, so here it blocks.
* **Applicability** per gate × segment comes from the `gate_applicability` table (cells missing there use the built-in fallback matrix, identical to the seeded one): `not_applies` → one `info` finding saying why; `warning` → severity capped at `warning`.
* **Reference dates:** compliance rules resolve on the expected commissioning date (today when unknown); pricing/GST rules on the quote date (= the date of the price snapshot).
* **Overrides:** a compliance-lane approval on entity `compliance_override` (`approvals.meta = { kind:'override', target:'quotation'|'dispatch'|'sales_order', gates, reason, line_signature? }`).
  Once `approved`, findings of those gates get `overridden: true` and stop blocking. A quote override stops applying if the set of SKUs on the quote changes (`overridesStale`).
  The dispatch module's own override approvals (meta `{ round, dispatch_id, so_id, reason }`) are honoured as blanket overrides of that dispatch.
* **`ctx.svc.compliance.evaluateDispatch(soId, { dispatchId?, serialIds?, persist? })`** — serial-level G2/G3/G4/G5/G6/G7/G10 from each serial's `compliance_snapshot`, plus G11 (deactivated dealer = hard stop, over limit = warning) and G14.
  It writes `dispatches.compliance_*` only when `persist === true` and `dispatchId` is given; the dispatch service normally sets them itself from the returned findings.

---

## 2. Compliance endpoints

### POST `/compliance/preview` — roles: all
Live gate results without a quote (recommendation screen, quote builder). Body:
`{ segment, kw, expected_commissioning_date?: date|null, exemption_reliance?: bool, sku_ids?: uuid[] (≤50), dealer_id?, lead_id?, site_id?, validity_date?, free_text?: string[] }`.
Partners (distributor/dealer users) have `dealer_id` forced to their own and `site_id` ignored. Response: the evaluation above plus `cfa: { eligible, cfa, eligible_kw, benchmark_cost, lines[], ruleIds[], warnings[] }`.

### GET `/compliance/gates` — roles: all
`{ gates: [{ gate, title, applicability: { [segment]: { applicability, note, source: 'default'|'table' } } }], segments: Segment[] }`.

### POST `/compliance/overrides` — roles: sales roles, dispatch, compliance_officer
Body `{ entity_type: 'quotation'|'dispatch'|'sales_order', entity_id, gates: Gate[] (1–14), reason (≥10 chars, mandatory) }`.
For a quote each gate must currently have an open (non-info, not overridden) finding, else `GUARD_BLOCKED`; one pending override per record (`CONFLICT`). → 201 `{ approval: Approval, quote: QuoteDetail | null }`.
The compliance officer then decides it via `POST /approvals/:id/decide` (a comment is mandatory).

### GET `/compliance/overrides?entity_id=uuid` — internal → `ApprovalView[]` (override approvals of that record, newest first). GET `/compliance/overrides/:id` → `ApprovalView`.

---

## 3. Catalogue

`SkuView = Sku & { compliance: SkuCompliance | null, price: SkuPrice | null, snapshot_stale: boolean }`. For partners `price` has no `landed_cost` / `floor_price`.

| Method + path | Roles | Notes |
|---|---|---|
| GET `/skus` | all | query `q` (make/model/variant/hsn/description), `category`, `active=true|false`, `demo=true|false`, `stale_snapshot=true` (ALMM snapshot older than `compliance.almm_snapshot_max_age_days`, default 7, or no register entry), `limit`, `offset`, `sort` (make/model/category/created_at/updated_at/wattage), `order`. → `SkuView[]` |
| GET `/skus/recommend` | all | step 16. query `segment` (req), `kw` (req), `commissioning?`, `category?`, `compliant_only=true`. ONLY active SKUs that have a compliance row. → `(SkuView & { usp: BrandUsp|null, warranty_years, gates: GateSummary[], has_hard_stop, compliance_status })[]` (gates G2–G7, G9, G10) |
| GET `/skus/:id` | all | `SkuView & { prices: SkuPrice[] (latest 10), in_stock: number }` |
| POST `/skus` | techno_commercial, compliance_officer, management | `{ category, make, model, variant?, wattage?, hsn? (4–8 digits), uom?, active?, demo?, description?, warranty_years?, brand_usp? { quality, warranty, certifications, service_support, delivery_reliability } }` → 201 `SkuView`; duplicate make+model+variant → 409 |
| PATCH `/skus/:id` | same | any subset; deactivating or changing the HSN flags open quotes for re-quote |
| GET `/skus/:id/compliance` | all | `SkuCompliance | null` |
| PUT `/skus/:id/compliance` | compliance_officer, techno_commercial | `{ almm_list1, almm_list1_ref?, almm_list1_valid_till?, almm_snapshot_date (REQUIRED), cell_maker?, almm_list2, dcr_verified, cell_origin?, bis_licence_no?, bis_licensed_model?, bis_standard_no?, bis_valid_till?, inverter_kw?, self_certified?, thin_film? }` → `SkuCompliance` (sets `verified_by` / `verified_at`); a change to any register field flags open quotes with this SKU `requote_required` |
| GET `/prices` | internal | `sku_id?`, `active=true|false`, paging → `SkuPrice[]` (newest `valid_from` first) |
| POST `/prices` | management, techno_commercial, accounts | `{ sku_id, base_price, valid_from, valid_to?, landed_cost: { [component]: number } (the SUM is the landed cost used for margin), floor_price?, source?, snapshot_label? }` → 201 `SkuPrice`. Closes the previous snapshot (`valid_to` = day before `valid_from`); same start date → 409; flags open quotes with the SKU |
| GET `/stock-batches` | internal | `sku_id?`, `origin?`, `q` → `(StockBatch & { sku, serial_count, in_stock, serials_pending })[]` |
| POST `/stock-batches` | dispatch, techno_commercial, management, accounts | `{ sku_id, batch_no, received_at, qty, supplier?, origin?: 'import'|'domestic', boe_no?, unit_cost?, location?, serials?: string[] (≤ qty) }` → 201 `{ batch, serials: number, serials_pending, compliance_snapshot: SerialSnapshot|null, warnings: string[] }`. Each serial copies the SKU's ALMM/DCR/BIS position at receipt; duplicate serial or batch → 409 |
| POST `/serials` | same | `{ batch_id, serials: string[] }` → 201 `{ added, compliance_snapshot, serials }`; exceeding the batch qty → 409 |
| GET `/serials` | internal | `status`, `sku_id`, `batch_id`, `sales_order_id`, `q` (serial no.) → `(InventorySerial & { sku_label, sku_category, batch_no, received_at })[]` |
| GET `/serials/exposure` | internal | `status=in_stock` exposure helper: `{ as_of, exemption_until, days_left, exemption_rule_status, total_units, total_value, non_list2_units, non_list2_value, by_sku[] }` (value = batch `unit_cost`) |

---

## 4. Quotations

Status: `draft ⇄ blocked` (hard stop) → `price_review` → `pending_approval` → `approved` → `sent` → `negotiation` → `accepted`; also `rejected`, `requote_required`, `expired`, `revised`.
Editable (lines, header, tax position): `draft, blocked, price_review, requote_required` (a `requote_required` quote that was already sent must be revised). Every version of a quote shares `quote_no` (`FS/Q/<yy>/<nnnn>`); `version` and `parent_quote_id` tell them apart.
Roles: **sales roles** = management, regional_head, sales_manager, dsm, techno_commercial, distributor_user, dealer_user. Partners only reach their own party's quotes (row-level) and never see `margin_pct` / `floor_check` (returned as `null`).

`QuoteDetail = Quotation & {`
`lines: (QuotationLine & { gross, tax_amount, sku: {id,category,make,model,variant,wattage,hsn,uom,brand_usp,warranty_years}|null, compliance: SkuCompliance|null })[]`,
`findings: Finding[]` (= `compliance_findings`), `approvals: ApprovalView[]` (quotation lanes, every round), `overrides: ApprovalView[]`, `discussions: QuoteDiscussion[]`,
`versions: { id, version, status, total, parent_quote_id, created_at }[]`, `cfa: { entitlement, state_share, loan_share, consumer_share, breakdown }`,
`followups: { id, due_at, status, escalated_level, resolved_at, day }[]`, `opportunity`, `customer`, `site`, `owner`, `dealer`, `documents: DocumentRow[]`, `editable: boolean }`.
`cfa.breakdown = { cfa: { eligible, eligible_kw, amount, benchmark_cost, lines[], warnings[] }, state: { amount, note }, loan: { pct, amount }, consumer: { amount }, funding_mix, reference_date, ruleIds[] }`.

| Method + path | Roles | Notes |
|---|---|---|
| GET `/quotes` | internal + partners (scoped) | `q` (quote no.), `status` (comma list), `segment`, `opportunity_id`, `owner_id`, `dealer_id`, `distributor_id`, `compliance_status`, `latest_only=true`, `sort` (quote_no,total,validity_date,status,kw,created_at), paging → `(Quotation & { opportunity_name, customer_name, owner_name, dealer_name, line_count })[]` |
| POST `/quotes` | sales roles | `{ opportunity_id, validity_date?, payment_terms?, clause_keys? (clause.*), freight? }` → 201 `QuoteDetail`. Copies kW/segment/site/customer/owner/dealer/distributor/territory from the opportunity (stage `qualified` → `quotation`), version 1. Default validity = earliest of quote date + `quote.default_validity_days` (7), the price horizon (`quote.max_price_snapshot_age_days`, lines' `sku_prices.valid_to`) and, when relying on the exemption, the exemption date |
| GET `/quotes/:id` | internal + partners | `QuoteDetail` |
| PATCH `/quotes/:id` | sales roles | `{ validity_date?, payment_terms?, clause_keys?, freight?, expected_commissioning_date?, exemption_reliance?, loan_rate_pct?, loan_rate_source_date? }`; recalculates and re-evaluates → `QuoteDetail` |
| PUT `/quotes/:id/lines` | sales roles | `{ lines: [{ sku_id?, description?, hsn?, qty, unit_price?, discount_pct? (default 0), uom? }], validity_date?, reset_validity? }` replaces all lines. Unit price defaults to the active `sku_prices` snapshot on today's date (refreshes `price_snapshot_at`); GST rate + `gst_as_of` come from the `gst.*` rules in force on that date — an inactive rule gives `gst_rate: null` and a G9 warning, never a silent rate. Recomputes subtotal / discount / tax / total / margin vs landed cost / floor check, CFA via the rule engine, state share (`gujarat.state_subsidy`, empty ⇒ 0), loan share (opportunity funding mix), consumer share = total − CFA − state − loan, place of supply (site state). Re-evaluates compliance: status → `blocked` (hard stop) or `draft`. Inactive SKU → 422, SKU without a price → 422, unknown SKU → 404 |
| POST `/quotes/:id/tax-position` | accounts, compliance_officer | the CA-type decision: `{ lines: [{ line_id, approved, gst_rate?, hsn? }], note? }` — the only way to set a rate by hand (e.g. inverter lines while the rule is conflicting). Approval is kept across line re-saves while rate/HSN are unchanged |
| POST `/quotes/:id/evaluate` | sales roles, compliance_officer, accounts | runs G1–G14, persists findings / status / `rule_ids_used`; `draft|blocked|price_review` quotes move to `blocked` or `price_review`. → evaluation + `{ quote: QuoteDetail }` |
| POST `/quotes/:id/request-approval` | sales roles | `{ note? }` (steps 22 → 23). Needs ≥1 line and no un-overridden hard stop (`COMPLIANCE_BLOCKED`). Opens lanes in parallel: **commercial** by effective discount % from `approval_rules` (fallback rule `quote.discount_bands`; a line below `floor_price` or a verified margin-floor breach forces DSM → Regional Head → Management), sequential steps; **compliance** (exemption reliance, SKU substitution vs the parent version, finding that depends on a non-verified rule) → compliance_officer; **credit** (dealer over limit, receivables overdue > `quote.credit_overdue_days`, portal deactivated / under SOP, expired bank guarantee) → accounts. Each active step has an `approval` clock from `approval_rules.sla_hours` (fallback `quote.approval_sla_hours`). No lane needed ⇒ `approved`. → `QuoteDetail` with `status: 'pending_approval'` |
| POST `/quotes/:id/send` | sales roles | `{ channels?: ('email'|'whatsapp')[] (default both), message? }`. Refused unless `approved` (409), validity not passed (409), no un-overridden hard stop other than G1 (`COMPLIANCE_BLOCKED`) and consent valid for ≥1 channel (`CONSENT_BLOCKED`; channels without consent are skipped and reported). Generates the branded PDF (stored in bucket `quote-pdfs`, `documents` row, `pdf_document_id`), sends via `ctx.svc.messaging.send` (purpose `service`; e-mail carries the composed message and the PDF; WhatsApp sends the approved template `wa.quote_sent`, which also works outside the 24 h window), status → `sent`, starts one `quote_followup` clock per cadence day (`sla.quote_followup_days`, default 1/3/5/7) owned by the quote owner. → `{ quote: QuoteDetail, deliveries: { channel, status, blocked, reasons[] }[], followup_clocks, document_id }` |
| GET `/quotes/:id/pdf` | internal + partners | streams `application/pdf` (`?download=1` for attachment). The stored PDF after sending, otherwise a draft-marked rendering |
| GET `/quotes/:id/discussions` | internal + partners | `QuoteDiscussion[]` |
| POST `/quotes/:id/discussions` | sales roles | `{ kind: 'call'|'whatsapp'|'meeting'|'email', outcome?, notes?, next_followup_at? }` (only after `sent`) → 201 `QuoteDiscussion`. First one moves the quote to `negotiation` (opportunity too) and satisfies the next follow-up clock |
| POST `/quotes/:id/accept` | sales roles | `{ note? }` (step 27) from `sent|negotiation`: `accepted`, `accepted_at` + `terms_confirmed_at`, opportunity → `pi_stage`, follow-up clocks cancelled |
| POST `/quotes/:id/reject` | sales roles | `{ reason }` (customer declined; `sent|negotiation`) → `rejected` |
| POST `/quotes/:id/revise` | sales roles | `{ reprice?, note? }` (step 26) from `sent, negotiation, rejected, requote_required, expired, approved` → 201 new `QuoteDetail`: version n+1, same `quote_no`, `parent_quote_id`, copy of lines (re-priced on current snapshot + rules by default when the source is `requote_required` / `expired`), fresh validity; the old version becomes `revised`; a version that already has a child → 409 |
| GET `/reports/requote-exposure` | management, regional_head, sales_manager, dsm, techno_commercial, compliance_officer, accounts, viewer | `only_flagged=true`. → `{ rows: [{ sku_id, make, model, category, open_quotes, requote_required, value, flagged_value, quotes[] }], totals: { open_quotes, requote_required, value, flagged_value } }` (value = quoted line value incl. GST) |

### Re-quote engine
Open quotes (`draft … negotiation`) are set to `requote_required` (+ `requote_reason`, owner + DSM notified, audited, pending approvals skipped, follow-up clocks cancelled) when
(a) a rule of category `gst, customs, almm, bis, pmsg, rwa_ghs, kusum, gujarat` that appears in the quote's `rule_ids_used` (any version of the same `category.key`) is created / updated / (de)activated,
(b) `PUT /skus/:id/compliance` changes a register field or `PATCH /skus/:id` deactivates the SKU / changes its HSN, (c) `POST /prices` publishes a new snapshot for a SKU on the quote.
Nightly jobs: `quotes.requote_scan` (01:55 IST — catches rule/register/price changes made without a hook) and `quotes.expire` (01:45 IST — validity passed ⇒ `expired`).

---

## 5. Approvals (generic inbox — all entity types)

`ApprovalView = Approval & { actionable: boolean, sla: { state: 'waiting'|'running'|'overdue'|'done', due_at, remaining_minutes, overdue, clock: {id,status,escalated_level}|null }, entity: { entity_type, entity_id, title, subtitle, value, segment, link, territory_id, owner_id }|null, chain: { step, required_role, decision, decided_at, approver_id }[] }`.
Roles: management, regional_head, sales_manager, dsm, accounts, compliance_officer, techno_commercial (+ admin) for every endpoint below except `/approvals/summary`, which any signed-in role may call (it returns `0` for roles that do not approve).

| Method + path | Notes |
|---|---|
| GET `/approvals/summary` | `{ mine: number }` — pending approvals the signed-in user can act on right now (their turn in the chain, their role or a lower commercial step they outrank). Sidebar badge |
| GET `/approvals` | `scope=mine|all` (default mine; admin sees all), `lane=commercial|compliance|credit`, `entity_type`, `decision` (default `pending`), `actionable=true`, `q`, paging → `ApprovalView[]` (soonest due first). DSMs with `territory_ids` only see records in their territories |
| GET `/approvals/:id` | `ApprovalView` |
| POST `/approvals/:id/decide` | `{ decision: 'approved'|'rejected', comment? }` → `{ approval: ApprovalView, outcome: 'step_approved'|'lane_approved'|'rejected' }`. The comment is mandatory on every rejection and on any decision about an override (`compliance_override`, `credit_override`) (min. 3 characters). The user's role must equal `required_role` (or be a higher commercial authority: management > regional_head / sales_manager > dsm); an earlier step in the same lane/round must be done first (409); an already-decided approval → 409. Then the entity's registered handler runs: quotation — a rejection rejects the quote (`rejected_reason` = lane + comment), a finished lane starts the next step's SLA clock or, when every lane of the round is approved, moves the quote to `approved` and notifies the owner |

Handlers registered by this module: `quotation`, `compliance_override`. PI / sales-order / credit-override handlers are registered by the order module and are called by the same endpoint.
