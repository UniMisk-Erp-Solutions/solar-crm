# Assumptions and decisions

Where the master prompt was ambiguous we took the most reasonable reading, recorded here. Change any of these deliberately — most are one rule or one line of code.

## Product and data
1. **Capacity is stored in kW** (`capacity_kw`), not "MW scale": a 3 kW rooftop would otherwise be 0.003 MW. MW is shown for ≥ 1 000 kW.
2. **Dashboards are computed in TypeScript** from base tables (portable between the demo store and Supabase); the SQL views in `10_views.sql` are equivalent definitions for BI. Both use `percentile_cont`-style (interpolated) p90.
3. **No database transactions** through the REST layer; writes are ordered to be recoverable and guards run in both the service and a SQL trigger.
4. **`profiles.id` has no foreign key to `auth.users`** so demo personas can exist without Auth accounts. For real users `profiles.id` must equal the Auth user's UUID (`RUN_ORDER.md` has the snippet).
5. **All versions of a quote share one `quote_no`**; uniqueness is `(org_id, quote_no, version)`.
6. **Consent ledger**: rows are immutable except the withdrawal fields (`withdrawn_at/by/channel`, `optout_suppress_until`). **`message_log`** is append-only except that `body_preview` and `to_masked` may be *cleared* (never changed) so erasure and retention can remove personal text.
7. Dates `YYYY-MM-DD` / ISO-8601 UTC in storage; displayed `DD-MMM-YYYY` in Asia/Kolkata. Default working calendar Mon–Sat 09:30–18:30 IST (rule `work_calendar.*`).
8. Mobile numbers are stored in E.164 (`+91XXXXXXXXXX`); a duplicate fuzzy match is name + pincode bigram similarity ≥ 0.6 (same intent as `pg_trgm`).

## Rules and compliance
9. Rule path = `category.key` where the category is the first dotted segment (`pmsg.cfa.max_total` → category `pmsg`, key `cfa.max_total`).
10. **Status convention for seeds**: high / medium-high confidence and active ⇒ `verified`; medium-confidence trackers that are active ⇒ `unverified` + `max_severity: warning|info`; conflicting ⇒ `conflicting` + inactive. "Medium-high" is stored as `medium` with the original wording in the notes.
11. CFA for special-category states is not capped by the general `pmsg.cfa.max_total` (no separate special-category cap was supplied).
12. **G1** on a quote checks consent for the quotation/service purpose and the 90-day suppression; a stale DND scrub is a warning. **G11** is a warning on a quote (it triggers the credit lane) and a hard stop on sales-order creation. The **dispatch serial check** applies DCR/ALMM to *module* serials only (inverters and structures have no ALMM List-I/DCR status).
13. The ALMM-exemption flag defaults to true for net-metered/open-access jobs whose expected commissioning is on or before the exemption date; the user can change it.
14. Extra rule `almm.list1.enforcement_date` was added so gate G3 has a governing rule. Unlisted legal values such as `pmsg.legacy_cohort_cutoff` (2025-04-01) and `pmsg.special_category_states` are seeded **unverified and inactive**.
15. Loan interest rate is always a **free input with a source date** (the 7 % vs 5.75 % conflict is unresolved); rebate slabs have **no defaults** (accrual is 0 with a "not configured" flag); channel margins, credit days and conversion rates are never coded.

## Messaging, privacy, security
16. DND is applied to call / SMS / WhatsApp, not e-mail. Anonymous callers of public endpoints receive a generic response that never reveals duplicates or routing.
17. **Aadhaar guard**: any 12-digit number (first digit 2–9) that passes the Verhoeff checksum in free text or a file name is refused with `AADHAAR_BLOCKED`. Structured identifier fields (e-way bill no., UPI references, consumer numbers, serials) and UUIDs / `*_id` fields are exempt because they legitimately contain long digit runs.
18. Only mock providers exist for WhatsApp, SMS, DND, e-invoice and e-way bill. SMTP e-mail and Supabase Storage are real adapters. DLT template ids in seeded SMS templates are the literal `TO-BE-REGISTERED`.
19. Quote and PI PDFs use Helvetica (metric-compatible with Arial) and print "Rs." because the standard PDF fonts have no rupee glyph; embed Arial/Noto Sans if the ₹ symbol is required.
20. Erasure anonymises personal fields but keeps statutory financial records and aggregates; retention timers are rules (`retention.*`) that are *report-only* until activated.

## Build and verification
21. SQL was **never executed** by us. It is validated by parsing with the PostgreSQL grammar (`libpg-query`) and a contract check against the TypeScript model (`npm run check:sql`). The generated demo block tries `session_replication_role = replica`; if Supabase refuses it, no guard can reject the demo rows (checked), and only extra audit rows are written.
22. "Today" in all research notes is 26-Oct-2026; the compliance calendar and countdowns are computed from the real current date.
23. The session timeout (default 480 min) is enforced from the JWT `iat`; demo tokens do not expire.
24. **Hindi and Gujarati translations are deferred** at the owner's request. The language switcher and the translation plumbing (`t(key, English default)` everywhere, `npm run i18n:extract`) are in place and every screen is readable in English; `hi.json` and `gu.json` are intentionally empty until translations are commissioned.

25. **UI scope (rebuilt 27-Oct-2026)**: the screens are limited to what the flow chart PDF contains and only the admin role is exposed; backend capabilities beyond the PDF (post-sale, dealers, distributors, catalogue, rule admin, reports, compliance calendar) are retained but have no screens. Compliance findings surface only as one plain "Cannot be sent yet" message.
