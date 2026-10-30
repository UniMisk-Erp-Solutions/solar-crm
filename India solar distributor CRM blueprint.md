# Redesigning the Solar CRM for Indian distributors

**Prepared for:** Mistry & Shah LLP, Ahmedabad — advisory/build brief for solar distributor clients | **Position as of:** 26 October 2026 | **Basis:** five research note files (subsidy, product compliance, DISCOM/grid, channel/finance, data law/CRM landscape) plus the "Future Solar CRM Flow" PDF (six stages, 34 numbered steps)

**Bottom line.** The generic Inquiry > Qualification > Opportunity > Quotation > PI > Sales Order flow is a sales-pipeline template. It has no gate for any of the things that actually make or lose money for an Indian solar distributor in late 2026: (i) whether the SKU is eligible for the project category (ALMM List-I/List-II, DCR, BIS), (ii) which clock is running (CFA claim deadline 30 Nov 2026 for legacy cases; ALMM List-II exemption ending with commissioning by 31 Dec 2026; DPDP Phase 3 on 13 May 2027), (iii) who is the vendor of record on the PM Surya Ghar portal, (iv) whether leads were collected with consent that survives DPDP/TRAI/WhatsApp rules, and (v) how much credit exposure the distributor carries while dealers wait on loans, DISCOM inspection and subsidy. The recommended redesign keeps the six stages as the spine but expands it to 14 stages with hard-stop compliance gates, a quote price-lock/re-quote engine, serial-number inventory with ALMM/DCR status, a dealer credit-and-subsidy-ageing module, and DISCOM/subsidy clocks. Most regulatory facts in the notes rest on trade press and vendor blogs, not on gazette or OM text; this report therefore tags every claim and puts the unresolved items in a Verify-before-relying table (Section 10). No OM, GR or notification number is stated unless the notes support it.

**How to read this report.**
- **[F]** = sourced fact from the notes (with confidence tag High / Medium / Low). **[I]** = my inference or design recommendation. **[H]** = hypothesis with no reliable data (treat as unverified).
- Source codes `[S#]` map to the URLs in Section 10b. Confidence tags are those given in the notes; where the notes tag a figure Low, I keep it Low.

---

## 1. Executive summary: where the generic flow fails and the headline redesign

| # | Failure of the generic flow | Why it matters (evidence) | Conf. |
|---|---|---|---|
| 1 | **No product-eligibility gate.** Step 16 "Product Recommendation & Brand USP" is marketing-led; nothing checks ALMM List-I model, List-II cells, DCR verification or BIS licence. | DCR is "an essential condition" for PM Surya Ghar CFA [S1]; List-II cells apply from 1 Jun 2026 with an exemption for eligible net-metering/open-access projects only up to commissioning by 31 Dec 2026 [S15][S16]; unverified DCR modules reportedly not accepted in government programmes [Mercom headline, S22 context] | High / Med-High |
| 2 | **No project-category segmentation.** One flow for all leads, but PMSG residential, RWA/GHS, C&I captive, net-metering, open access and PM-KUSUM have different subsidy, ALMM and DISCOM rules. | CFA is residential-only (Rs 30,000/kW first 2 kW; Rs 18,000 for 3rd kW; max Rs 78,000) [S1][S2]; RWA/GHS Rs 18,000/kW up to 500 kW [S2][S4]; captive behind-the-meter outside ALMM [S14] | High / Med |
| 3 | **No "vendor of record" concept.** Distributor > dealer > installer chain is invisible; scheme liabilities sit with the portal-registered vendor. | Only National Portal-registered vendors may implement; 5-year free maintenance, de-registration, penalties sit with the vendor [S1]; bank guarantees Rs 25 lakh national / Rs 2.5 lakh per state [S6]; MNRE SOP 22 Jun 2026 on vendor deactivation [S62] | High / Med |
| 4 | **Stage 5 ends at "Hand over to Dispatch".** The real value chain continues: installation, DISCOM inspection and commissioning, subsidy claim, loan release, 5-year O&M. | ~3 in 5 rooftop applications pending approval and ~7% rejected (Feb 2026) [S9]; DISCOM commissioning clock 15 days [S34][S36]; CFA ~15 days after DISCOM approval (policy statement) [S1][S8] | Med-High |
| 5 | **Quotation has no price-lock, GST or customs logic.** Follow-up cadence (Day 1/3/5/7) ignores price validity. | DCR module prices reportedly +20-23% after 1 Jun 2026 [S18]; GST on modules cut 12% to 5% on 22 Sep 2025 [S30]; inverter rate disputed [S31]; ADD on cells/modules recommended but notification unconfirmed [S27] | Med / High / Low |
| 6 | **Lead capture ignores consent law.** "Website / Call / WhatsApp / Campaign / Referral" with no consent, provenance or channel rules. | DPDP Rules: notice/consent/erasure/breach duties from 13 May 2027 [S43][S44]; TRAI TCCCPR Feb 2025 amendment [S47]; WhatsApp opt-in and template rules [S53][S54] | High / Med |
| 7 | **Credit control is a single box** ("Payment / Credit Verification"). A distributor funds dealers who wait on loans and subsidy. | Vendor fronts costs then awaits subsidy/loan [S9]; bank collateral demands, name mismatches [S9][S61]; dealer deactivation risk [S62][S63] | High (process) / Med |
| 8 | **Time-bound cliffs not modelled.** | CFA claim deadline 30 Nov 2026 (35 days away) [S3]; List-II exemption commissioning by 31 Dec 2026 (66 days) [S15]; PM Surya Ghar target period to Mar 2027 [S65] | Med / High |

**Headline redesign [I]:** a 14-stage flow (Section 4) with five structural changes: (1) a **segmentation fork** at stage 3 that routes each lead to a category-specific rule pack; (2) a **compliance engine** that evaluates SKU x project category x commissioning date x list-snapshot date before any quote leaves; (3) a **clock engine** that holds statutory/policy clocks (DISCOM 15 days; CFA 15 days; SOP 8/15/15 days; deadlines) and escalates on actual dates, because the notes found no statutory DISCOM stage SLA for <=10 kW [S1]; (4) a **channel ledger** linking each dealer's credit exposure to the subsidy/loan stage of the projects behind it; (5) a **consent ledger** at lead capture that governs every later SMS, call and WhatsApp message.

---

## 2. Gap analysis: existing flow vs. real-world rule or issue

| Generic stage / step | What the flow assumes | Real-world rule or issue it ignores | Source area | Conf. | Impact |
|---|---|---|---|---|---|
| 1. Inquiry capture (steps 1-3) | Any channel; capture pincode, MW, customer type | No consent or lead-source provenance; no notice record; TRAI DLT/DND, WhatsApp opt-in, DPDP notice/consent [S43][S47][S54] | Data law | High (DPDP dates) / Med (TRAI) | High — legal exposure; penalty ceilings up to Rs 250 crore under DPDP for safeguard failures (from 13 May 2027) [S43] |
| 1. Dedupe (step 2) | Mobile/email match | Portal "may assign one consumer to 2-3 vendors" (claim, Low) [S68]; same consumer via several dealers of one distributor [I] | Channel | Low | Med — double-quotes, lead conflict |
| 1. Territory/capability match (step 4) | Territory, MW capacity, product capability | Territory should reflect DISCOM area (UGVCL/DGVCL/MGVCL/PGVCL in Gujarat), vendor registration level (state/multi-state/national) and districts of operation [S6]; no source on territorial exclusivity disputes (gap) | Subsidy / DISCOM | Med | High |
| 1. Auto-assign + SLA 15-30 min / 2 hrs / same day | Time-based SLA | Reasonable for WhatsApp: 24-hour customer-service window lets free-form replies; after that approved templates only [S53][S54] — SLA should be tied to the window [I] | WhatsApp | High (structure) | Med |
| 2. Qualification (steps 8-9) | Requirement, timeline, budget, decision maker | Missing: segment, DISCOM, consumer number, sanctioned load/contracted demand, phase, roof ownership/title, category (general/SC/ST), existing solar (3 kW cap on CFA incl. pre-existing) [S1], financing route | Subsidy / DISCOM | Med-High | High |
| 2. Lead temperature (step 10): hot 0-30 days | Pure urgency | Urgency in 2026 is regulatory: CFA claim date, ALMM exemption commissioning date; hot/warm should incorporate deadline proximity [I] | Subsidy / ALMM | Med | Med |
| 3. Site visit (steps 14-15) | Site, MW, load type, timeline, specs, documents | No shading/roof structure/photo capture standard; DISCOM feasibility: none for <=10 kW, 15-day study for larger with deemed feasibility on silence [S34][S35]; "state-operationalised" [S1] | DISCOM | High | High |
| 3. Rate negotiation with end customer (step 18) | Free negotiation | PMSG: consumer picks vendor at mutually agreed price [S1]; benchmark cost Rs 50,000/kW (first 2 kW), Rs 45,000/kW (additional) governs CFA computation [S1]; Gujarat state cost-share unverified [S10] | Subsidy | High / Low | Med |
| 4. Quotation (step 21) | "Techno-commercial offer" | No GST by line (modules 5%; inverters disputed; structures/batteries unverified), no place-of-supply/70:30 treatment, no ALMM/DCR/BIS fields, no price validity or customs clause [S30][S31][S32] | Product compliance | High / Low | High |
| 4. Approval matrix (step 23): DSM / Regional Head / Management | Discount-based approval only | Needs compliance approval (non-DCR substitution, exemption reliance) and credit approval (dealer ageing/limit) as separate lanes [I] | Channel | Inference | High |
| 4. Quote follow-up Day 1/3/5/7 | Fixed cadence | Marketing messages need template/consent; follow-ups after opt-out barred for 90 days (re-consent) [S47]; Day-7 expiry irrelevant when stock price/duty changes sooner [I] | Data law | Med | Med |
| 5. PI (steps 28-29) | PI then payment | No loan/CFA mechanics: CFA is paid to the consumer's account (or loan account) after DISCOM approval; PI should split consumer share, loan share, subsidy receivable [S5][S9] | Subsidy / Finance | Med | High |
| 5. Credit verification (step 30) | Binary approved/not | Dealer limit, ageing, subsidy-linked receivable, deactivation status [I]; margins 3-6% claimed by a vendor blog [S59] (Low, H) | Channel | Low | High |
| 5. SO creation SAP/CRM (step 32) | Order header | Missing: serial/batch allocation with ALMM/DCR/BIS status, e-invoice/e-way bill linkage (e-invoicing above Rs 5 crore AATO, Medium) [S33], TDS/TCS (not researched — flagged) | GST / Inventory | Med / Gap | High |
| 5. Dispatch handover (step 34) | End of flow | No installation, DISCOM inspection, meter, commissioning, subsidy claim, warranty/RMA, 5-year maintenance clock [S1][S36] | DISCOM / Subsidy | High | Critical |
| 6. Controls/KPIs | Funnel conversions, SLA, follow-up | No KPI for compliance-block rate, DISCOM ageing, claim-pending value, dealer DSO, RMA TAT, consent coverage | All | Inference | High |

---

## 3. Regulatory and commercial clause map

Format per table: **Rule [F]** (source, confidence) | **Meaning for the distributor** | **CRM field / gate / trigger [I]**. Every "CRM implication" column is my inference.

### 3.1 Subsidy

| Rule [F] | Meaning for the distributor | CRM implication [I] |
|---|---|---|
| PMSG residential CFA: 60% of benchmark for first 2 kWp and 40% for additional up to 3 kWp; Rs 30,000/kW (first 2 kW), Rs 18,000 (3rd kW); max Rs 78,000; none beyond 3 kW; special-category states Rs 33,000/19,800 (cl. 5(e)/5(h) as reported). **High** [S1][S2] | Quote must show consumer share net of CFA; sizing above 3 kW gets no extra CFA | Field: CFA entitlement computed from kW, category, state; warning if kW > 3 |
| Benchmark cost Rs 50,000/kW first 2 kW; Rs 45,000/kW additional. **High** [S1] | Basis for CFA computation, not a price cap per the notes (cap not stated) | Store benchmark used in computation |
| DCR is an essential condition for CFA (cl. 5(m)); Annex 3 para 1.1 — domestic cells. **High** [S1]; consumers forgoing CFA not bound by DCR (cl. 5(p)). **Medium** [S1] | Non-DCR SKUs cannot go on subsidised quotes | **Hard stop:** non-DCR SKU on PMSG/KUSUM quote |
| Registered vendors only (7(a)); state (DISCOM) or national/multi-state registration (7(b)); consumer picks vendor (6(c)). **High** [S1] | Distributor not on the portal cannot be vendor of record | Entity: vendor of record, portal vendor ID, level, districts, BG validity |
| BG: Rs 25 lakh national; Rs 2.5 lakh per state multi-state, +Rs 2.5 lakh per added state; BG valid >= 5 years; amendment reported 5 Jun 2024. **Medium** [S6]. State-level DISCOM registration BG/fees: **not found** | Dealer BG strength affects counterparty risk | Dealer master: BG validity date alert |
| Vendor duties: free 5-year comprehensive maintenance (7(d)); de-registration/penalties (7(e)); public ratings. **High** (clause exists) [S1][S5] | O&M liability sits with the vendor; distributor's exposure is contractual (my inference) | Installed-base register; 5-year O&M clock |
| Distributor sub-contracting rule: **not found in notes.** | Cannot assert whether unregistered installers may work under a registered vendor | **Unresolved** — Verify table V-9 |
| Process: install only after DISCOM approval [S8]; ≤10 kW deemed feasible "pending state operationalisation" (6(h)); geo-tagged photos (6(j)); DISCOM inspection, agreements, approval (6(k)); bank proof (6(s)); e-token after inspection (6(p)); CFA "within 15 days of approval by the concerned DISCOM" (6(t)); grievances 30 days (11(a)). **High** (clauses exist) / **Medium** (numbering) [S1] | Stage-wise ageing is the controllable variable; no statutory DISCOM stage SLA was found in the guideline text | Stage timestamps; ageing per DISCOM |
| Legacy cohort: 31 Aug 2026 OM (reported 1 Sep 2026): CFA claims must be received by **30 Nov 2026** for Phase II-governed applications at redeemed/inspected/installed stage; applications not installed on 1 Apr 2025 deleted. **Medium** [S3]. Earlier 7 Jul 2025 OM set 31 Dec 2025. **Medium** [S3][S4] | 35 days left on 26 Oct 2026; distributor's receivables tied to legacy jobs at risk | Flag: legacy cohort; countdown; daily work-list |
| Scheme period: FY2026-27 target (1 crore households); programme end March 2027 (press). **Medium** [S2][S65]; no extension beyond found | Planning horizon for MVP | Config: scheme end date (editable) |
| State top-ups allowed (5(i)); MoU needed (12(c)). **High** [S1]; 7 Jul 2025 amendment made explicit. **Medium** [S4] | State share may be paid late (Goa, Assam, UP examples) [S61] | Field: state top-up applicable; state share receivable and ageing |
| Gujarat Oct 2026 push: ~Rs 1,000 crore, 3 lakh+ households; general households pay 10% of benchmark for up to 2 kW, SC/ST 5% (summary of a Gujarat report). **Low-Medium**; worked example internally inconsistent; no GR, deadline or procedure [S10] | Cannot be encoded yet | **Unresolved** — V-8; keep as a configurable "state scheme" object |
| RWA/GHS: Rs 18,000/kW for common facilities, cap 500 kW, 3 kW/house; connection for common facilities only (5(f)); CFA to resident entity; capped at lower of (households x 3 kW, installed capacity). **High** [S1][S2][S4] | Society leads need a different quote and document set | Segment = RWA/GHS: households count, common-load check, entity type |
| Accelerated depreciation 40% WDV under s.34, Income-tax Act 2025 (from 1 Apr 2026), 180-day half-rate rule mentioned. **Medium-Low** [S12] | Relevant to C&I buyers' economics and to our advisory role | C&I fields: entity, block, commissioning date; marked "CA to confirm" |
| PM-KUSUM: for projects with PPAs/NITPs issued on/before 31 Dec 2025 — Components A and C (feeder) financial closure by 30 Sep 2026, commissioning by 31 Mar 2027; Component B and C (individual pump) commissioning by 30 Sep 2026; later extension case-by-case. **Medium** [S13]. Whether farmer-pump sales still open after 30 Sep 2026: **not verified** | KUSUM leads may be stranded | Flag: sanction/PPA date <= 31 Dec 2025; deadline countdown; V-7 |

### 3.2 Product compliance (ALMM, DCR, BIS, customs/ADD, GST)

| Rule [F] | Meaning for the distributor | CRM implication [I] |
|---|---|---|
| ALMM List-I (modules): first published 10 Mar 2021; expanded in 2022 to net-metering/open-access; enforcement suspended FY2023-24, resumed 1 Apr 2024. **Medium** [S14]. Listings model-specific; delisting/suspension possible. **Medium** [S14] | Match **manufacturer and model**, not brand | SKU: ALMM List-I Y/N, listing ref, validity, snapshot date; model-level validation |
| Captive behind-the-meter plants exempt from ALMM for modules and cells. **Medium** (definition unverified) [S14][S17] | Segment drives whether ALMM gate applies | Gate applicability matrix by segment |
| ALMM List-II (cells): mandatory from 1 Jun 2026 per Dec 2024 OM (reiterated 28 Jul 2025); first list 31 Jul 2025. **High** [S14]. 18 Jul 2026 OM: eligible net-metering/open-access projects may be commissioned without List-II cells until **31 Dec 2026**; thereafter List-I modules + List-II cells; supersedes five earlier OMs (25 May, 8 Jun x2, 15 Jun, 23 Jun 2026); "no blanket extension". **High** on date/scope [S15][S16]. OM number: **not supported** (blog numbers Low) [S17] | Stock built on non-List-II cells has an expiry for net-metering/open-access sales | Gate: commissioning date vs 31 Dec 2026; quote-validity cap; stock ageing flag |
| Exemption does not cover subsidy schemes (blog; **Low-Medium**) [S17]. Government rooftop projects awarded after 31 Aug 2025 and commissioned from 1 Jun 2026 need List-II cells (headline summary, **Medium**) [S75] | Subsidy and government jobs need compliant stock now | Gate by project category |
| List-II bid-date carve-out conflict (9 Dec 2024 vs 31 Aug 2025). **Low** [S14] | Cannot determine which grandfathering date applies | **Unresolved** — V-4 |
| List-III (ingots/wafers): effective 1 Jun 2028; first list only after >= 3 independent units with 15 GW combined. **Medium-High** [S19] | Long-dated; relevant to SKU master design, not 2026 operations | Optional field: wafer origin |
| DCR (subsidy schemes): Indian cells from undiffused wafers (customs head 3818) and every step in India; thin-film exempt (Mar 2025 norm). **Medium-High** [S20][S21]; DCR portal for manufacturers; integrated with PMSG (Apr 2025, headline). **Medium-Low** [S22]. **Conflict:** a vendor guide says PMSG "does not require" DCR [S25] — contradicted by [S1][S18] (Low for vendor guide) | Three independent proofs per SKU: List-I model, DCR portal verification, cell-origin evidence | SKU flags: List-I, DCR-verified (per serial/batch), cell origin |
| Market stress: DCR module prices +20-23% since 1 Jun 2026 per vendors; cells ~30 GW vs modules ~60-65 GW; 25-30 day waits. **Medium** [S18]. Pre-deadline procurement rush [S76] | Price and delivery volatility | Price-lock engine; supplier lead-time field |
| BIS: Solar Systems, Devices and Components Goods Order, 2025 (S.O. 492(E), 27 Jan 2025). **High** (notification summary) [S23]. Inverters >200 kW self-certification extended to 31 Dec 2026 (S.O. 3706(E), 3 Jul 2026; earlier S.O. 3597(E), 5 Aug 2025 to 30 Jun 2026). **Medium-High** (secondary transcription) [S23]. Module standard number: IS 14286 vs IS 14086 — **unresolved** [S24] | Licence-model-label mismatch can cause rejection (Low) [S24] | SKU: BIS licence no., licensed model, IS no., expiry; inverter >200 kW flag expiring 31 Dec 2026 |
| Customs: modules BCD 20% + AIDC 20% + SWS; cells BCD 20% + AIDC 7.5% + SWS; ~44% effective on modules (blog, "2026" label unverified). **Medium** [S26]. Budget 2026-27 changes: **not checked** | Landed-cost model per bill of entry | Import SKU: BoE no., duty components, origin |
| ADD on Chinese cells/modules: DGTR final findings (signed 30 Sep 2025) — 3 years; Jinko/Trina 0%; Aiko 23%; cooperating non-sampled 23%; others 30%. **High** on recommendation [S27]; imposition: **Low / UNVERIFIED** (Mercom headline says "slaps"; InfoLink says MoF notification not confirmed; 2014 precedent of lapse) [S27][S28][S29] | Do not hard-code ADD in prices until CBIC notification checked | Config: ADD status switch (default off); origin/transshipment field |
| Solar glass ADD (provisional Dec 2024; later final reportedly). **Medium**, rates not captured [S27 context] | Component-cost inputs | Not modelled in MVP |
| GST: modules/cells 5% from 22 Sep 2025 (56th Council; was 12%). **High** [S30]. Inverters: 5% (Entry 234) vs 18% (HSN 8504) disputed; Karnataka HC quashed Rs 120 crore demand against ABB India (W.P. 9686 of 2025, 15 Dec 2025, per secondary source). **Medium** (ruling), **Low** (wider rate position) [S31]. 70:30 works-contract split (~8.9% effective), structures/batteries 18%: vendor guide **Low**, self-flagged "not re-checked" [S32] | Rate by line item needs CA-approved tax positions; the Sep 2025 change shows rate follows time of supply, not order date (my inference) | HSN, rate, as-of date per line; "tax position approved" flag; re-price trigger on rate change |
| E-invoicing: AATO > Rs 5 crore; 30-day reporting limit for AATO >= Rs 10 crore; 2FA from 1 Apr 2025. **Medium** (vendor blog) [S33] | SO-to-invoice integration | E-invoice status on SO/invoice |
| TDS 194Q, TCS 206C(1H), e-way bill, s.17(5) blocks: **not researched** (background knowledge only) | Cash-flow and compliance impact on distributors | Placeholders; flagged for CA review (V-14) |

### 3.3 DISCOM, net metering, GERC (Gujarat)

| Rule [F] | Meaning for the distributor | CRM implication [I] |
|---|---|---|
| Electricity (Rights of Consumers) Amendment Rules 2024 — Rule 11 (prosumer): no feasibility study up to 10 kW; 15 days (from 20) for larger; deemed feasibility on silence; DISCOM commissioning within 15 days (from 30); upgrades up to 5 kW at DISCOM cost. **High** (10 kW, 15-day study, deemed feasibility) / **Medium** (rest) [S34][S35] | Feasibility is a clock only above 10 kW; deemed-feasibility start trigger (complete application vs submission) unverified | Clock engine: feasibility 15 d (>10 kW); commissioning 15 d from installation-certificate submission; store both application-submitted and application-complete dates |
| Housing societies: individual or single-point connection by ballot; separate metering for common area. **Medium** [S34] | RWA deals need a ballot/decision record | RWA documents checklist |
| MNRE/MoP PMSG DISCOM guidance (Sept 2024): agreement, meter, commissioning within 15 days of installation certificate; load increase up to 10 kW auto-approved; smart meters at no extra charge; fees at commissioning. **Medium** [S36] | Delay claims can be documented | Clock + evidence log |
| GERC Net Metering Rooftop Regulations 2016 as amended; Fifth Amendment effective 4 Nov 2025: no separate written connectivity agreement for PMSG systems; agreement begins on commissioning date; connectivity per Supply Code 2015 (4th Amendment 23 Sep 2024: LT up to 100 kVA/kW contracted demand, or 150 if applicant opts). **High** [S37][S38] | Gujarat PMSG paperwork lighter; applicable regulation version depends on commissioning date | Field: regulation version = commissioning date; contracted demand; phase |
| Pending/decided dispute (Surya Roshni v. PGVCL — banking charges Rs 42.98 lakh on 750 kWp; which regulation version applies; outcome unknown). **Medium** [S39] | Larger Gujarat rooftop jobs can attract banking charges | C&I quote: banking-charge assumption field; V-10 |
| Gujarat net-metering details from a vendor blog: 1-1,000 kW; surplus at Rs 2.25/unit for 5 years; delay compensation >= Rs 500/day; GEDA commissioning certificate; Solar Policy 2021 ran to 31 Dec 2025. **Low-Medium** [S11] | Not safe to encode | **Unresolved** — V-11 |
| Open access (Gujarat): additional surcharge Rs 1.00/kWh (GERC Order 04 of 2025, 1 Oct 2025-31 Mar 2026, six-monthly revision); green energy banking charge Rs 1.5/kWh retained Sep 2025-Mar 2026. **Medium** [S40][S41]. Post-March 2026 values: **not found** | C&I open-access economics stale | Config with effective-from dates; V-12 |
| Gross metering for >10 kW (MoP Dec 2020 headline). **Low** [not opened] | Do not assume | V-13 |

### 3.4 Data law (DPDP, TRAI, WhatsApp, Aadhaar)

| Rule [F] | Meaning for the distributor | CRM implication [I] |
|---|---|---|
| DPDP Rules 2025 notified 13 Nov 2025 (G.S.R. 846(E)); Board established immediately; Consent Manager registration from ~13 Nov 2026; core duties (notice/consent Rule 3, safeguards Rule 6, breach Rule 7, erasure Rule 8, contact person Rule 9, rights Rule 14, penalties) from ~13 May 2027. **High** on dates, **Medium** on clause detail [S43][S44]. Date counting differs by a day in some sources [S45]. MeitY compression proposal (to 12 months) **not notified** as of 8 Oct 2026 [S44][S45] | ~199 days to 13 May 2027 from 26 Oct 2026 (my arithmetic); build to the earlier date as option | Compliance calendar entries with confidence tags |
| Consent: free, specific, informed, unconditional, unambiguous, affirmative; withdrawal as easy as giving. **Medium** [S43]. Notice: itemised data, purpose, withdrawal/complaint means. **Medium** [S43][S46] | Lead form text and WhatsApp opt-in must be purpose-specific | Consent ledger: text version, timestamp, IP, purpose, recipients |
| Breach: notify Principals and Board; detailed report within 72 hours (Rule 7). **Medium** [S43][S46]. Penalty ceilings: Rs 250 crore (safeguards), Rs 200 crore (breach-notification, children), Rs 150 crore (SDF). **Medium** [S43][S45] | CRM vendor is processor; fiduciary remains responsible (s.8(1)) [S43] | Breach workflow; access logs >= 1 year (Rule 8(3)) |
| Erasure on withdrawal/purpose end; the fixed "3 years" rule applies only to large e-commerce/gaming/social entities. **Medium** [S46][S43] | Solar distributor retention is purpose-based | Retention timers; erasure job |
| Fiduciary characterisation of distributor/installer, onward sharing with installers: **my inference**, confirm with counsel [S43 inference] | Lead sharing needs naming of recipients in notice | Per-lead: fiduciary entity, recipients named, purpose |
| Deemed consent s.7, grievance timelines (90 days), small-business exemptions: **not verified** | Do not rely | V-5 |
| TRAI TCCCPR Feb 2025 amendment (PR 11 of 2025, 12 Feb 2025): promotional calls on 140 series; transactional/service on a new series; no telemarketing from 10-digit mobiles; 90-day bar on re-seeking consent after opt-out; 7-day transactional consent; first violation = 15-day outgoing bar, repeat = 1-year disconnection and blacklisting. **High** [S47]. Series: "1600" (TRAI) vs "160" (Bar & Bench) — **unresolved** [S47][S49]. Header suffix: -P/-S/-T/-G (Fone Arena) vs "-F" (TRAI PR as summarised) — **unresolved** [S47][S48] | Personal mobiles of sales staff cannot be used for promotional calls | Dialler channel config; DND scrub; opt-out suppression 90 days; separate promo vs service flows |
| Draft Third Amendment 2026 (consultation Mar-Apr 2026): final status **not found**. **Medium** [S52]. IndiaMART challenge to B2B application, outcome unknown [S49]. DCA pilot with RBI (Dec 2025). **Medium** [S51] | Rules may tighten | Config-driven rules |
| WhatsApp Business: per-delivered-message pricing since 1 Jul 2025; categories Marketing/Utility/Authentication/Service; user opt-in required; templates outside 24-hour window; India INR billing from 1 Jan 2026 with migration by 31 Dec 2026; service/utility-in-window charging from 1 Oct 2026. **High** (structure) [S53][S54]. INR rates (marketing 1.09; utility 0.145) **Low** (BSP page) [S55] | Template category governance; cost control | 24-hour window countdown; category tag per template |
| Aadhaar: UIDAI advisory 27 May 2022 against unlicensed entities keeping copies, withdrawn by MeitY 29 May 2022 — advisory not binding; Aadhaar Act specifics not verified. **Medium-Low** [S56][S57]; authentication rules relaxed 2025 for private entities with approval [S58] | Safe default is to avoid storing Aadhaar | Policy [I]: no Aadhaar number/image; at most last 4 digits |

### 3.5 Finance and channel

| Rule / evidence [F] | Meaning for the distributor | CRM implication [I] |
|---|---|---|
| Collateral-free loans ~7% for systems up to 3 kW (Feb 2025 govt document). **Medium** [S8]. Ministry statement 4 Aug 2026: concessional loans at **5.75%**; 17.5 lakh installations supported; 21.87 lakh loan applicants. **Medium** [S66]. Rate conflict **unresolved** | Do not print a rate on quotes | Loan rate as free input with source date |
| Banks asking collateral for loans under Rs 2 lakh against guidelines; rejections for missing documents, land records in deceased relatives' names, missed electricity payments; co-applicant fix. **High** (wire, quoting govt data) [S9]; name-vs-Aadhaar mismatch anecdote **Medium** [S61] | Loan stage is a distinct funnel step | Loan object with rejection-reason picklist; document checklist |
| ~3 in 5 applications pending, ~7% rejected (Feb 2026). **Medium-High** [S9] | Drives working-capital need | Stage ageing per DISCOM |
| Installation count figures conflict: 2.36 million (Feb 2026) [S9]; 4 million (1 Jun 2026 Mercom) [S67]; ~4.5 million (June, PV Magazine) [S65]; 50.06 lakh households (Aug 2026, ministry) [S66]; 25.02 lakh vs 63.26 lakh applications (Rajya Sabha via blog, Low) [S64] — **unresolved** (definitions differ) | Do not use any as a market-size number | Not needed in CRM |
| Enforcement: MNRE SOP 22 Jun 2026 — vendor reply 8 days, reminder to 15 days, show-cause 15 days, one-month portal deactivation, appeal 30 days. **High** (official process per trade press) [S62]. UPNEDA blacklisting and Rs 2.5 lakh BG forfeiture (Mar 2026). **Medium** [S63]. 66 vendors deactivated Aug 2026; applications not held beyond 60 days; Vendor-Consumer Agreement from 23 Sep 2026; 15 days defect rectification (Oct 2026): **Low** (blog with internal errors) [S64] | Dealer deactivation is a counterparty risk | Dealer compliance panel; V-6 |
| Distributor margins 3-6% gross (2-3% net); dealer ~10%; credit 30-60 days; working capital bands — vendor blog, unsourced, internally inconsistent. **Low — hypothesis [H]** [S59] | Use as interview prompts only | None coded |
| Brands operate named authorised-distributor lists and tie warranty to the channel (Trina, 2021). **High** as manufacturer statement (dated) [S60] | Warranty chain of custody needs serial-level invoicing | Serial-to-invoice chain brand > distributor > dealer > site |
| Warranty: Mercom headline "MNRE mandates 10-year warranty, 25-year performance cover for modules" — article/date not retrieved. **Low** [S77] | Cannot assert | **Unresolved** — V-15 |
| Credit/finance gaps: no sourced data on cheque/RTGS/PDC practice, channel finance, rebates, territory disputes, brand-distributor contract terms, bounced cheques, installer insolvency. | CRM design here is hypothesis-led | Interview programme (Section 9) |

---

## 4. Redesigned end-to-end flow: before vs after

**Legend.** Owner: **D** distributor; **DL** dealer/installer; **RV** registered vendor (portal); **DISCOM**; **BK** bank; **BR** brand/manufacturer; **CU** consumer; **CA** compliance/finance function. Clocks: **[F]** from notes, **[I]** my proposal. All "After" content is design recommendation [I] built on the facts in Section 3.

| New stage | Generic flow (before) | Redesigned (after) | Owner | Clock / SLA | Gate |
|---|---|---|---|---|---|
| 0. Lead capture with consent and provenance | Steps 1-3: capture channel, pincode, MW | Capture source (portal, WhatsApp, Meta click-to-WhatsApp, IndiaMART, referral, dealer-uploaded), notice version, purpose-specific consent, WhatsApp opt-in, DND scrub result, recipient list (dealer/installer named) [I]. Free entry window of up to 7 days for click-to-WhatsApp replies [S53] | D / DL | Respond inside 24-hour WhatsApp window [F: S53]; inbound SLA 15-30 min hot [generic] | **Hard stop:** no outbound promo without consent ID; **warning:** missing WhatsApp opt-in |
| 1. Dedupe and lead ownership | Mobile/email match | Phone + consumer number + site address match; ownership lock across dealers; conflict workflow; portal-assigned duplicates (claim only, Low) [S68] | D | Lock decision same day [I] | Warning on duplicate; manager override |
| 2. Eligibility and segmentation fork | Not present (steps 3-4 capture "customer type") | Segment: **PMSG residential**, **RWA/GHS**, **C&I captive (behind-the-meter)**, **net-metered C&I**, **open access/GEOA**, **PM-KUSUM**, **government/bid**. Each assigns a rule pack (CFA, ALMM applicability, DISCOM path, tax fields). Category: general/SC/ST, special-category state | D / DL | Same day [I] | Hard stop if segment blank before quote |
| 3. Bill, load and ownership capture | Step 15 "load type" | Consumer number, DISCOM, sanctioned load/contracted demand, phase, bill (OCR as hypothesis), name-match vs applicant, roof ownership/title, pending dues, existing solar kW (CFA cap) [S1] | DL / CU | Complete before survey [I] | Warning: name mismatch; hard stop: no consumer number for PMSG |
| 4. Roof/site survey and DISCOM feasibility | Steps 14-17: visit, form, recommendation | Geo-tagged survey photos, shading, structure, SLD draft; feasibility: **none for <=10 kW**; **15-day study clock >10 kW with deemed feasibility** [S34][S35]; per-DISCOM setting for the 10 kW rule "pending state operationalisation" [S1] | DL / DISCOM | 15 d (>10 kW) [F, Medium-High]; survey SLA [I] | Warning if >10 kW and no feasibility application |
| 5. Product selection with compliance validation | Step 16: brand USP | Select SKU from validated catalogue: List-I model (by model), List-II cells, DCR-verified, BIS licence, inverter flag; segment-aware (e.g., block non-DCR on PMSG/KUSUM) [S1][S14][S15][S20] | D | At quote [I] | **Hard stop:** non-DCR on PMSG/KUSUM; List-I fail on ALMM-applicable projects; **warning:** snapshot older than 7 days [I]; expiry warning if relying on 31 Dec 2026 exemption |
| 6. Quotation with tax, validity and price-volatility clauses | Steps 21-27 | Line-wise HSN/GST with as-of date; CFA/state share/loan split; price-validity date (cap at exemption deadline for non-List-II stock); duty/GST/ALMM change clause; ADD status switch; place of supply; 70:30 only if CA approves [S30][S31][S32] | D / DL | Validity [I]: default 7 days for DCR-volatile SKUs [H] | Hard stop: validity beyond exemption date; warning: tax position unapproved |
| 7. Approval matrix (three lanes) | Step 23: DSM > Regional Head > Management (discount) | Commercial lane (discount/margin), Compliance lane (substitution, exemption reliance), Credit lane (dealer limit/ageing/deactivation) | D / CA | Approval SLA [I] | Hard stop: no quote release without compliance lane clearance if flagged |
| 8. Finance, loan and subsidy tracking | Not present (step 30 is a credit check) | Loan: bank, application date, status, rejection reason code (name mismatch, arrears, land title, collateral) [S9][S61]; subsidy receivable plan: CFA, state share; funding mix on PI | BK / CU / RV | Loan SLA tracked from actual dates (no statutory SLA found) | Warning: loan ageing > threshold [I] |
| 9. Order, PI and credit control | Steps 28-34 | PI with consumer share/loan/subsidy split; dealer credit check (limit, ageing, subsidy-linked receivable, deactivation flag); SO with e-invoice linkage | D / CA | PI within [I] | Hard stop: dealer over limit; hold on deactivated vendor |
| 10. Dispatch with serial-number capture | Step 34 | Serial allocation by batch with ALMM/DCR/BIS status, invoice chain brand > D > DL > site; DCR portal serial check where available [S22] | D | Dispatch SLA [I] | Hard stop: serial not mapped to compliant SKU |
| 11. Installation and DISCOM commissioning | Not present | Installation certificate, geo-tagged photos (6(j)), vendor-consumer agreement status [S1][S64-Low]; DISCOM agreement/meter/commissioning **15 days** from certificate submission [S36]; Gujarat PMSG: no separate connectivity agreement under 5th Amendment [S37] | RV / DISCOM | 15 d [F, Medium] | Warning at day 10; escalate at day 15 [I] |
| 12. Subsidy claim and receipt | Not present | Claim readiness checklist (bank proof, photos, DISCOM inspection approval); e-token; CFA ~15 days after approval [S1] (policy; field reality differs [S9]); legacy cohort: claim must be received by 30 Nov 2026 [S3] | RV / CU | 15 d [F, Medium]; 30 Nov 2026 hard date [F, Medium] | Hard stop: legacy claim not submitted by D-7 [I] |
| 13. Warranty, RMA and O&M | Not present | Installed-base record: serials, commissioning date, warranty ends, 5-year free maintenance clock (vendor duty) [S1]; RMA ticket with brand claim, cost-bearer field (unknown split — gap) | RV / BR / D | SOP clocks 8/15/15 days for vendor complaints [S62] | Escalate on SOP clock |
| 14. Channel management loop | Step 6 KPIs only | Dealer scorecard: DSO, ageing, deactivations, complaint count, portal status, rebate accrual, territory | D | Monthly review [I] | Credit tightening rules |

---

## 5. Data model

**All field lists in this section are inference [I]** unless a source tag is attached. Sources inform *why* a field exists; the portal's actual field list was not retrieved (gap in notes).

### 5a. Entities and mandatory fields by stage

| Entity | Mandatory fields (by the stage that requires them) | Basis |
|---|---|---|
| **Lead** | Source, source ref, created time, consent ID, language, segment, assigned owner, lock status | I; DPDP/TRAI [S43][S47] |
| **Consent record** | Notice version, purpose(s), channel(s) (call/SMS/WhatsApp), recipients named, timestamp, IP/device, proof, withdrawal date, opt-out start date (90-day bar) | I; [S43][S47][S54] |
| **Customer/Site** | Name as on DISCOM bill, consumer no., DISCOM, sanctioned load/contracted demand, phase, address/geo, roof ownership/title, category (gen/SC/ST), special-category state, existing solar kW | I; [S1][S37] |
| **Opportunity** | Segment, kW, scheme route, funding mix, expected commissioning date, regulation version, exemption reliance flag | I; [S14][S15][S37] |
| **Survey** | Date, geo-tagged photos, shading, roof type, SLD, feasibility application dates (submitted / complete) | I; [S34] |
| **SKU master** | Make, model, wattage variant, ALMM List-I (listing, validity, snapshot date), cell maker and List-II, DCR verified, cell origin, BIS licence/model/IS no./expiry, inverter kW flag, HSN, GST rate and as-of date, import/domestic, BoE no., duty paid, ADD flag, warranty docs | Derived list in product-compliance note (inference) |
| **Quote** | Version, validity date, price snapshot, line HSN/GST, CFA entitlement, state share, loan share, clause set (duty/GST/ALMM change), approvals, ALMM snapshot date | I |
| **Vendor of record** | Entity, portal vendor ID, level (state/multi-state/national), districts, BG validity, portal status, complaint count, deactivation dates | I; [S1][S6][S62] |
| **Dealer/installer** | Territory, credit limit, ageing, security (PDC/BG), rebate scheme, portal status link | I |
| **Loan** | Bank, application date, status, rejection code, co-applicant, document checklist | I; [S9] |
| **DISCOM application** | Submission/complete dates, feasibility due date, inspection date, meter type/date, commissioning date, agreement status | I; [S34][S36] |
| **Subsidy claim** | CFA computed, state share, claim date, e-token, bank proof validated, release date, rejection reason | I; [S1] |
| **Order/Invoice** | SO, PI, invoice, e-invoice status, tax position approved, place of supply | I; [S33] |
| **Serial/Installed asset** | Serial, batch, invoice chain, site, install date, warranty end, claim history | I; [S60] |
| **Ticket/RMA** | Type, serial, brand claim no., cost-bearer, SOP clock | I; [S62] |

### 5b. Validation gates

| Gate | Condition | Type | Basis |
|---|---|---|---|
| G1 | Outbound promotional message without valid consent/DND scrub | **Hard stop** | [S47][S54] |
| G2 | PMSG/KUSUM quote with non-DCR SKU | **Hard stop** | [S1][S20] |
| G3 | ALMM-applicable project with module not in List-I (model-level) | **Hard stop** | [S14] |
| G4 | List-II cell missing and project is subsidy/government, or commissioning after 31 Dec 2026 | **Hard stop** | [S15][S75] |
| G5 | Exemption-reliant job with expected commissioning > 31 Dec 2026 | **Hard stop** (or approval override) | [S15] |
| G6 | BIS licence missing/expired/model mismatch | **Hard stop** | [S23][S24 Low] |
| G7 | Inverter >200 kW self-certified after 31 Dec 2026 | Warning, becomes stop after date | [S23] |
| G8 | Quote validity beyond price/duty horizon | Warning | [I] |
| G9 | GST rate/HSN mismatch or tax position unapproved | Warning (hard for inverter/bundle lines) | [S31] |
| G10 | ALMM snapshot older than set period | Warning | [S25 Low practice] |
| G11 | Dealer over credit limit or portal-deactivated | **Hard stop** on SO | [S62][I] |
| G12 | Name on bill ≠ applicant; pending dues | Warning | [S9][S61] |
| G13 | kW > 3 on PMSG | Warning (no CFA beyond 3 kW) | [S1] |
| G14 | Aadhaar number/image upload | **Hard stop** (policy) | [S56][S57 inference] |

### 5c. Automation triggers

| Trigger | Action | Basis |
|---|---|---|
| Opt-out received | Suppress promo for 90 days; propagate to installers | [S47][S43] |
| WhatsApp 24-hour window <2 h left | Alert owner; template fallback | [S53][S54] |
| >10 kW feasibility submitted | Start 15-day clock; alert on lapse (deemed feasibility) | [S34][S35] |
| Installation certificate submitted | Start 15-day DISCOM clock | [S36] |
| DISCOM approval recorded | Start 15-day CFA clock | [S1] |
| Duty/GST/ALMM list change | Flag open quotes; require re-quote | [I] |
| BG or licence expiry within 60 days | Alert CA/ops | [I] |
| Complaint/SOP notice on dealer | Auto-open 8/15/15-day tracker | [S62] |
| 30 Nov 2026 minus 14/7/3 days | Escalation on legacy claims | [S3] |

---

## 6. Distributor-specific modules

| Module | Contents [I] | Evidence |
|---|---|---|
| **Channel/dealer management** | Territory by DISCOM and district; credit limit and ageing; security cheques/BG; rebate schemes (volume slabs — no sourced data, H); dealer portal-status/complaint feed; dealer scorecard | Vendor deactivations [S62][S63]; margins/credit [H, S59]; distributor hierarchy features claimed by a vendor [S70] |
| **Quote price-lock and re-quote engine** | Price snapshot per SKU, validity, re-quote triggers on duty (BCD/AIDC/ADD), GST rate/HSN, ALMM/DCR status change; "stock-or-order" flag; exposure report of open quotes by SKU | 20-23% DCR price rise [S18]; GST 12>5% [S30]; ADD unverified [S27] |
| **Inventory by serial** | Serial/batch with ALMM/DCR/BIS status; aged non-List-II stock report ahead of 31 Dec 2026; import vs domestic; reservation against quotes | [S14][S15][S22] |
| **Warranty claim chain** | Brand > distributor > dealer > consumer routing; authorised-channel proof; RMA cost-bearer field (split unknown) | Trina example [S60]; gap on cost split [channel note] |
| **Subsidy-linked receivables** | Per project: loan stage, inspection, claim, credit; map to dealer exposure | [S9] |
| **Compliance calendar** | See table below | — |

### Compliance calendar (as of 26 Oct 2026; days from today are my arithmetic)

| Date | Event | Conf. | Source |
|---|---|---|---|
| 13 Nov 2026 (18 d) | DPDP: Consent Manager registration (Rule 4) | High (date) / Medium (detail); some sources count a day later | [S44][S45] |
| 30 Nov 2026 (35 d) | CFA claims must be received — Phase II legacy cohort (31 Aug 2026 OM) | Medium (OM not read) | [S3] |
| 31 Dec 2026 (66 d) | Net-metering/open-access commissioning limit without List-II cells (18 Jul 2026 OM); no blanket extension | High (date/scope) | [S15][S16] |
| 31 Dec 2026 | BIS self-certification for inverters >200 kW (S.O. 3706(E)) ends unless extended | Medium-High | [S23] |
| 31 Dec 2026 | WhatsApp India INR billing migration deadline | High (Meta docs) | [S53] |
| 1 Jan, 1 Apr, 1 Jul, 1 Oct | Meta rate-change dates | High | [S53] |
| 31 Mar 2027 (156 d) | PMSG programme end; KUSUM Components A/C commissioning (for sanctions by 31 Dec 2025) | Medium | [S65][S13] |
| 13 May 2027 (199 d) | DPDP core duties (consent, safeguards, breach, erasure, rights, penalties); compression to 12 months proposed but not notified (as of 8 Oct 2026) | High / Medium | [S43][S44][S45] |
| 1 Jun 2028 | ALMM List-III (wafers/ingots) | Medium-High | [S19] |
| Past: 30 Sep 2026 | KUSUM Component B/C-IPS commissioning (for sanctions by 31 Dec 2025); later extension unverified | Medium | [S13] |

---

## 7. KPIs and controls

| Layer | Replace/extend generic KPI | Definition [I] | Why (evidence) |
|---|---|---|---|
| Funnel | Keep six conversions but split by **segment** | Conversion by PMSG/RWA/C&I/KUSUM | Different rules per segment |
| Funnel | Add **Loan-approved / Loan-applied** and **Survey-to-quote** | Per bank, per dealer | Bank bottleneck [S9] |
| Speed | First response within WhatsApp window | % replies inside 24 h and inside 30 min (hot) | [S53] |
| Compliance | **Compliance-block rate** | Quotes blocked by G2-G6 / quotes drafted | Prevents rework and clawback risk [S14] |
| Compliance | **Consent coverage** | % leads with valid consent before outbound | [S43][S47] |
| Compliance | Stock exposure to 31 Dec 2026 | Non-List-II cell stock value and units | [S15] |
| DISCOM | **Stage ageing by DISCOM** | Median/90th-percentile days: feasibility, inspection, meter, commissioning | No statutory SLA found for some stages [S1] |
| DISCOM | **Deemed-clock breaches** | Count where DISCOM exceeded 15 d | [S34][S36] |
| Subsidy | **CFA pending value and age** | Rs and days since DISCOM approval | [S1][S9] |
| Subsidy | Legacy claims at risk | Count and value not received by 30 Nov 2026 | [S3] |
| Credit | **Dealer DSO, overdue %, subsidy-linked exposure** | Per dealer, vs limit | [I]; margins thin per vendor blog (H) [S59] |
| Credit | Dealers deactivated/under SOP | Count and exposure | [S62] |
| Quality | RMA turnaround, claim recovery from brand | Days; % recovered | [S60] gap |
| Pricing | Re-quote rate and price-change loss | Quotes re-priced; margin leakage | [S18] |

**Controls.** Replace "pending payment/credit" escalation with a credit committee lane; add compliance officer lane; add "legal hold" for breach incidents (72-hour report) [S43].

---

## 8. Build vs buy and competitor landscape

All evidence below is **vendor-sourced or vendor-authored (Low-Medium)**; two competing vendors disclose commercial ties [S70][S72].

| Tool | What the notes say it covers | Uncovered / unverified | Conf. |
|---|---|---|---|
| Quickest Solar CRM (QuickEstimate) | Free plan; Pro Rs 6,999/user/year (3-user minimum); PMSG subsidy calc, WhatsApp, Facebook/IndiaMART capture, dealer hierarchy, DISCOM stages, GST incl. 70:30 — self-reported [S70][S71] | Its own comparison page says no CRM verified for direct PMSG portal integration; ALMM/DCR/GST handling unconfirmed for any product; WhatsApp consent/DPDP/offline untested [S70] | Low |
| OpenSolar | Free core; API/connectors paid from 16 Apr 2026 [S70] | India tariffs/DISCOM workflow unverified | Low-Med |
| Aurora, SolarEdge Designer, Pylon, SolarPlus, Sunbase | Design/proposal or generic solar CRM, USD pricing; Sunbase page lists no subsidy/DISCOM/ALMM/WhatsApp/GST [S71][S73] | India localisation weak | Low |
| Zoho, Salesforce, HubSpot, Odoo | Generic CRM/ERP; need customisation [S70][S72] | No PMSG stages, no native WhatsApp logging (claim), English-first (claim) [S72] | Low |
| Tally / Zoho Books | GST invoicing [S71] | Not CRM | Low |

**Uncovered gaps (inference from absence in sources):** (1) ALMM/DCR validation at quote; (2) PMSG/DISCOM status sync; (3) lead routing with consent propagation to installers; (4) DPDP consent ledger and erasure; (5) TRAI DLT/DND workflow; (6) WhatsApp 24-hour window and template governance; (7) GST-compliant tax invoices with e-invoice linkage; (8) Gujarati/Hindi UI; (9) offline survey with bill OCR [S70-S72 inference]. "No evidence found" does not mean the capability does not exist.

**Recommendation [I]:** **Buy-and-extend** for commodity layers (CRM shell, WhatsApp BSP, e-invoicing via the client's existing ERP — the user's ecosystem includes Tally, SAP Business One, Business Central, per the brief); **build** the differentiated layer: SKU compliance engine, clock engine, channel/credit-subsidy ledger, consent ledger. Reason: the unmet gaps are precisely the rule-heavy modules. Verify with demos before committing (V-16).

---

## 9. Implementation roadmap

| Phase | Scope (risk reduction first) | Rationale | Target timing [I] |
|---|---|---|---|
| **MVP (0-6 weeks)** | SKU master with ALMM/DCR/BIS flags and hard-stops G2-G6; quote validity and re-quote on rate/ALMM change; legacy-CFA countdown (30 Nov 2026) and 31 Dec 2026 commissioning tracker; dealer credit limit and ageing; consent-at-capture with DND scrub and 90-day suppression; segmentation fork | Cliffs: 35 and 66 days; exposure to wrong-SKU claims and thin margins | Before 31 Dec 2026 |
| **Phase 2 (6-16 weeks)** | DISCOM/CFA clock engine; loan tracking with rejection reasons; serial-level inventory and dispatch; vendor-of-record and dealer portal-status panel; WhatsApp window and template governance; PI funding split | Bottlenecks documented in notes | Q1 2027, before DPDP 13 May 2027 |
| **Phase 3 (16+ weeks)** | DPDP full stack (breach workflow, erasure, rights); warranty/RMA chain and installed base; rebate engine; analytics; Gujarati/Hindi UI; C&I/open access modules (surcharge/banking config) | Lower urgency; depends on evidence from interviews | Q2-Q3 2027 |

**Evidence to obtain (closes the notes' gaps).**

| Item | Purpose |
|---|---|
| 5-10 Gujarat distributors (interview guide: margins, credit days, cheque/RTGS/PDC, rebates, territory disputes, agreements, RMA cost split, dealer defaults) | Replace H items |
| MNRE PMSG Operational Guidelines (full), 7 Jul 2025 and 31 Aug 2026 OMs, 22 Jun 2026 SOP, vendor manual, portal field list | Subsidy gaps, V-1, V-9 |
| MNRE ALMM OMs: 9 Dec 2024, 23 Sep 2025 FAQ, 18 Jul and 4 Aug 2026; current List-I/II PDFs | V-3, V-4 |
| CBIC customs/ADD notifications Oct 2025 onward; Budget 2026-27 customs changes; GST notifications (22 Sep 2025 cut, inverter position) | V-2, V-12 |
| BIS: IS number for modules, QCO list under S.O. 492(E) | V-5 |
| GERC: Net Metering regulations incl. Fifth Amendment gazette, GEDA/GR for Gujarat state scheme, post-March 2026 open-access charges | V-8, V-11, V-12 |
| DPDP Rules gazette (G.S.R. 846(E)) and any post-8 Oct 2026 amendment; TRAI gazette (Feb 2025 amendment) and Third Amendment status; DoT number series | V-5, V-6 |
| Brand-distributor agreements; Waaree/Premier/Emmvee/Saatvik/Vikram RHPs (channel/receivable disclosures) | Channel evidence |
| Written legal opinion on fiduciary characterisation and enquiry-as-consent | Data law |

---

## 10. Verify-before-relying table and sources

### 10a. Consolidated verification table

| ID | Item | Why unresolved | What to check | Primary source |
|---|---|---|---|---|
| V-1 | PMSG CFA claim deadline 30 Nov 2026 and Phase II scope | OM PDF not read; trade-press only [S3] | OM text, file no., stage definitions | MNRE / pmsuryaghar.gov.in |
| V-2 | ADD on Chinese cells/modules | DGTR recommendation High; notification unconfirmed; Mercom headline contradicts InfoLink [S27][S28] | CBIC customs (ADD) notifications Oct 2025-Jan 2026 | CBIC / Finance Ministry |
| V-3 | ALMM 18 Jul 2026 OM and 4 Aug clarification; OM numbers; "tenth List-II revision 28 Sep 2026" | Blog numbers unsupported [S17] | OM text and numbers | MNRE ALMM page |
| V-4 | List-II bid-date carve-outs (9 Dec 2024 vs 31 Aug 2025) | AZB flags inconsistency [S14] | 9 Dec 2024 OM, 23 Sep 2025 FAQ | MNRE |
| V-5 | BIS module standard: IS 14286 vs IS 14086; full QCO list | Conflicting sources [S24] | Standard number; 2025 Order schedule | BIS / MNRE gazette S.O. 492(E) |
| V-6 | DCR sources conflict (vendor says PMSG needs no DCR) | [S25] vs [S1][S18] | Current PMSG DCR clause; KUSUM DCR | MNRE guidelines |
| V-7 | PM-KUSUM sales after 30 Sep 2026 | Extension unknown [S13] | MNRE KUSUM OMs | MNRE |
| V-8 | Gujarat state subsidy figures | Summary-only; inconsistent example; no GR [S10] | GR, scheme name, procedure, deadline | GEDA / Gujarat Energy Dept |
| V-9 | Distributor/unregistered installer role under PMSG | No clause found | Guideline Annexures; vendor manual | MNRE / REC |
| V-10 | Surya Roshni v. PGVCL outcome and banking charge rule | Outcome not seen [S39] | GERC order | GERC |
| V-11 | Gujarat net-metering specifics (Rs 2.25/unit, Rs 500/day, GEDA role, policy end) | Vendor blog [S11] | Regulations and amendments | GERC gazette; GEDA |
| V-12 | Open-access surcharge/banking after Mar 2026; wheeling | Not found [S40][S41] | GERC orders | GERC |
| V-13 | Gross metering >10 kW | Headline only [Renewable Watch 2020] | MoP rule text | MoP gazette |
| V-14 | TCS/TDS (194Q/206C(1H)), e-way bill, s.17(5), inverter/structure/battery GST rates, 70:30 | Not researched or Low [S31][S32] | Notifications and CA review | CBIC; Income-tax |
| V-15 | Module warranty/performance mandate | Headline only [S77] | MNRE order | MNRE |
| V-16 | Vendor claims (all CRM feature/pricing) | Vendor-sourced [S70-S73] | Demos, official pricing | Vendors |
| V-17 | TRAI: 140/160/1600 series; header suffix (-P vs -F); Third Amendment status; IndiaMART case | Conflicts and no final text [S47][S48][S49][S52] | Gazette and DoT allotment | TRAI / DoT |
| V-18 | DPDP: exact date count; compression; s.7, grievance timeline, exemptions | Commentary-only [S43][S45] | Rules gazette; any amendment | MeitY / egazette |
| V-19 | Loan rate 7% vs 5.75% | Conflicting dates/sources [S8][S66] | Current Jan Samarth/bank terms | DFS / banks |
| V-20 | Installation counts (2.36M, 4M, 4.5M, 50.06 lakh, 25.02 lakh) | Definitions differ [S9][S65-S67] | Parliament replies, ministry dashboard | PIB / pmsuryaghar.gov.in |
| V-21 | Inverter GST 5% vs 18%; Karnataka HC ruling | Secondary; author's view [S31] | Judgment W.P. 9686/2025; any CBIC clarification | Karnataka HC; CBIC |
| V-22 | Vendor-enforcement claims (66 deactivations, 60-day rule, Vendor-Consumer Agreement 23 Sep 2026, 15-day defect rule) | Blog with internal errors [S64][S42] | MNRE SOP and portal notices | MNRE |
| V-23 | Accelerated depreciation s.34 (Income-tax Act 2025) | Secondary [S12] | Section text and rules | CBDT |
| V-24 | Distributor margins, credit days, working capital, conversion rates, CPL | Unsourced vendor blog [S59][S68][S69] — **[H]** | Interviews, RHPs | Primary research |
| V-25 | Gujarat DISCOM-specific timelines (UGVCL/DGVCL/MGVCL/PGVCL; Torrent) | Not found | DISCOM circulars | DISCOMs |

### 10b. Sources (from the notes only)

| ID | Source | URL |
|---|---|---|
| S1 | MNRE PM Surya Ghar Operational Guidelines, 7 Jun 2024 (DISCOM-hosted copy) | https://jbvnl.co.in/SOLAR/Operational%20Guidelines%20to%20PM%20Suryaghar%207%20June%2024.pdf |
| S2 | SolarQuarter, 1 Sep 2026 | https://solarquarter.com/2026/09/01/pm-surya-ghar-scheme-mnre-details-rooftop-solar-subsidy-guidelines-for-residential-consumers/ |
| S3 | Energetica India — CFA deadline 30 Nov 2026 | https://www.energetica-india.net/news/mnre-extends-pm-surya-ghar-cfa-claim-deadline-to-november-30-2026 |
| S4 | Renewable Watch, 9 Jul 2025 | https://renewablewatch.in/2025/07/09/mnre-notifies-amended-guidelines-for-pm-surya-ghar-yojana/ |
| S5 | SolarQuarter, 8 Jul 2025 | https://solarquarter.com/2025/07/08/mnre-amends-pm-surya-ghar-yojana-to-simplify-cfa-process-for-residential-rooftop-solar-installations/ |
| S6 | Energetica India — multi-state vendors, BG | https://energetica-india.net/news/mnre-amends-pm-surya-ghar-program-allows-multi-state-vendor-registration-for-rooftop-solar |
| S7 | Mercom, vendor registration, 8 May 2024 | https://mercomindia.com/pm-surya-ghar-vendor-registration |
| S8 | PIB document, Feb 2025 | https://static.pib.gov.in/WriteReadData/specificdocs/documents/2025/feb/doc2025212499601.pdf |
| S9 | Bloomberg/Reuters via BusinessDay, 16 Feb 2026 | https://www.businessday.co.za/world/asia/2026-02-16-indias-rooftop-solar-goals-slowed-by-loan-delays/ |
| S10 | NewsBytes (summary of DeshGujarat), Gujarat subsidy | https://www.newsbytesapp.com/news/india/gujarat-unveils-rs1000-cr-solar-subsidy-for-3l-households/tldr |
| S11 | Heaven Green Energy — Gujarat regulations (vendor blog) | https://www.heavengreenenergy.com/blog/solar-regulations-gujarat |
| S12 | TaxGuru — accelerated depreciation | https://taxguru.in/?p=1036553 |
| S13 | Renewable Watch, 31 Mar 2026 — PM-KUSUM | https://renewablewatch.in/2026/03/31/mnre-extends-timelines-for-projects-under-pm-kusum-scheme/ |
| S14 | AZB & Partners — ALMM/RLMM | https://www.azbpartners.com/bank/almm-rlmm-compliance-a-regulatory-deep-dive/ |
| S15 | Energetica India — 18 Jul 2026 OM | https://www.energetica-india.net/news/mnre-extends-almm-list-ii-exemption-for-net-metering-open-access-projects-till-dec-2026-no-blanket-relief |
| S16 | PV Tech — List-II exemption | https://www.pv-tech.org/mnre-extends-almm-list-ii-exemption-for-net-metering-and-open-access-solar-projects/ |
| S17 | Heaven Green Energy — ALMM List-II (vendor blog) | https://www.heavengreenenergy.com/blog/almm-list-2-exemption-window-2026 |
| S18 | Vision IAS summary of Indian Express, 12 Jun 2026 | https://visionias.in/current-affairs/upsc-daily-news-summary/article/2026-06-12/the-indian-express/environment/domestic-cell-mandate-triggers-supply-crunch-may-hit-rooftop-solar-installation |
| S19 | Powerline, 19 Mar 2026 — List-III | https://powerline.net.in/2026/03/19/mnre-extends-almm-framework-to-solar-ingots-and-wafers/ |
| S20 | Renewable Watch, 12 Mar 2025 — DCR norms | https://renewablewatch.in/2025/03/12/mnre-updates-dcr-norms-for-solar-cells/ |
| S21 | PV Magazine India, 11 Mar 2025 — blue wafers | https://pv-magazine-india.com/2025/03/11/solar-cells-using-blue-wafers-will-not-qualify-as-domestically-manufactured |
| S22 | SolarQuarter, Apr 2025 — DCR portal integration (headline) | https://solarquarter.com/2025/04/15/mnre-integrates-dcr-portal-with-pm-surya-ghar-scheme-to-curb-serial-number-issues-and-boost-traceability/ |
| S23 | WorldTradeScanner transcription, S.O. 3706(E) | https://worldtradescanner.com/MoN&RE%20Notification%20S.O.%203706(E)%20dated%203%20July,%202026.htm |
| S24 | SurgePV BIS guide (vendor) | https://www.surgepv.com/solar-compliance/india/guides/bis-certification |
| S25 | SurgePV ALMM guide (vendor) | https://www.surgepv.com/solar-compliance/india/guides/almm-compliance |
| S26 | QuickEstimate — import duty (vendor blog) | https://quickestimate.co/blog/import-duty-solar-modules-india |
| S27 | DGTR coverage: SMM; InfoLink; Outlook Business | https://news.metal.com/newscontent/103558246/[SMM-Analysis]-India-Imposes-Three-Year-Anti-Dumping-Tariffs-on-Solar-Cells-and-Modules-from-China ; https://www.infolink-group.com/energy-article/solar-topic-indias-anti-dumping-investigation-into-chinese-pv-cells-modules-analytical-overview ; https://www.outlookbusiness.com/news/comm-min-recommends-anti-dumping-duty-on-solar-cells-from-china-for-3-yrs |
| S28 | Mercom headline — 30% ADD | https://www.mercomindia.com/india-slaps-30-antidumping-duty-on-solar-cell-imports-from-china |
| S29 | Down To Earth, 2014 precedent | https://www.downtoearth.org.in/amp/story/environment/centre-wont-impose-antidumping-duties-on-imported-solar-cells-and-modules-45984 |
| S30 | PV Magazine, 4 Sep 2025 — GST cut | https://www.pv-magazine.com/2025/09/04/india-cuts-gst-on-solar-cells-and-modules-to-lower-costs/ |
| S31 | TaxGuru — inverter GST | https://taxguru.in/?p=1034743 |
| S32 | Heaven Green Energy — GST (vendor blog) | https://www.heavengreenenergy.com/blog/gst-rate-on-solar |
| S33 | Tally Solutions — e-invoicing | https://tallysolutions.com/business-guides/e-invoicing-compliance-rules-in-2026/ |
| S34 | Business Standard, Rights of Consumers amendment | https://www.business-standard.com/india-news/govt-tweaks-rules-for-speedy-electricity-connection-rooftop-installation-124022300594_1.html ; Indian Infrastructure: https://indianinfrastructure.com/2024/03/20/mop-notifies-electricity-rights-of-consumers-amendment-rules-2024-2/ |
| S35 | SCC Online | https://www.scconline.com/blog/post/2024/02/27/mop-notifies-electricity-rights-of-consumer-amendment-rules-2024-legal-news/ |
| S36 | SolarQuarter, Sep 2024 — DISCOM guidance | https://solarquarter.com/2024/09/19/pm-surya-ghar-streamlining-rooftop-solar-installations-with-new-guidelines-for-discoms |
| S37 | GERC explanatory note, Fifth Amendment | https://gercin.org/wp-content/uploads/2025/10/Explanatory-Note-for-Draft-GERC-Net-Metering-Rooftop-Solar-PV-Grid-Interactive-Systems-5th-Amendment-Regulations-2025.pdf |
| S38 | SolarQuarter, 10 Nov 2025 — Fifth Amendment | https://solarquarter.com/2025/11/10/gerc-approves-fifth-amendment-to-net-metering-regulations-2025-for-rooftop-solar-systems-in-gujarat |
| S39 | SolarQuarter, 22 Jul 2025 — Surya Roshni v. PGVCL | https://solarquarter.com/2025/07/22/gerc-reviews-dispute-on-applicable-net-metering-regulations-and-banking-charges-for-rooftop-solar-project-in-gujarat/ |
| S40 | SolarQuarter, 20 Sep 2025 — additional surcharge | https://solarquarter.com/2025/09/20/gerc-imposes-%e2%82%b91-kwh-additional-surcharge-for-open-access-consumers-from-october-2025/ |
| S41 | Mercom, 16 Oct 2025 — banking charge | https://www.mercomindia.com/gujarat-retains-banking-charges-of-₹1-5-kwh-for-open-access-consumers |
| S42 | Reslink — PMSG guide (vendor marketing) | https://www.reslink.org/blogs/pm-surya-ghar-muft-bijli-yojana-the-complete-2026-guide-for-solar-epcs/ |
| S43 | Taxmann — DPDP analysis | https://www.taxmann.com/post/blog/analysis-indias-dpdp-act-and-rules/ |
| S44 | Privacy Labs — DPDP 13 Nov 2026 | https://theprivacylabs.com/blogs/dpdp-13-november-2026-what-starts |
| S45 | MirvoLegal — DPDP timeline | https://www.mirvolegal.com/insights/dpdp-rules-2025-compliance-timeline/ |
| S46 | JSA Prism, Nov 2025 | https://www.jsalaw.com/?p=55573 |
| S47 | TRAI PR No. 11 of 2025 | https://cms.trai.gov.in/sites/default/files/2025-02/PR_No.11of2025.pdf |
| S48 | Fone Arena — TCCCPR 2025 | https://www.fonearena.com/blog/446114/trai-tcccpr-2025-tougher-rules-spam-calls-sms.html |
| S49 | Bar & Bench — TRAI crackdown | https://www.barandbench.com/view-point/trais-crackdown-on-spam-calls-and-ai-driven-telemarketing |
| S50 | MediaNama, Feb 2026 | https://www.medianama.com/2026/02/223-trai-issued-731000-notices-unregistered-telemarketers-2025/ |
| S51 | IndiaLaw — TRAI-RBI digital consent pilot | https://www.indialaw.in/blog/data-privacy/trai-rbi-digital-consent-pilot/ |
| S52 | Indian Infrastructure, 16 Mar 2026 — TRAI draft Third Amendment | https://indianinfrastructure.com/2026/03/16/trai-releases-draft-telecom-commercial-communication-preference-third-amendment-regulations-2026-for-consultation/ |
| S53 | Meta WhatsApp pricing docs | https://developers.facebook.com/docs/whatsapp/pricing |
| S54 | WhatsApp Business Policy | https://whatsappbusiness.com/policy/ |
| S55 | AiSensy (BSP) | https://m.aisensy.com/blog/whatsapp-business-pricing/ |
| S56 | LiveLaw — UIDAI advisory | https://www.livelaw.in/amp/news-updates/dont-share-photocopies-of-aadhaar-unlicensed-entities-like-hotels-cant-keep-aadhaar-cards-uidai-200366 |
| S57 | TaxGuru — withdrawal of advisory | https://taxguru.in/corporate-law/advisory-sharing-photocopy-aadhaar-withdrawal.html |
| S58 | Khaitan & Co — Aadhaar authentication | https://www.khaitanco.com/thought-leadership/Aadhaar-authentication-for-private-entities |
| S59 | QuickEstimate — dealer vs distributor vs EPC (vendor) | https://quickestimate.co/blog/solar-dealer-vs-distributor-vs-epc |
| S60 | Trina Solar India, 1 Jun 2021 | https://www.trinasolar.com/en-apac/resources/newsroom/aptrina-solar-warns-against-buying-unauthorized-distributors-india/ |
| S61 | Mongabay India, Aug 2025 | http://india.mongabay.com/2025/08/rooftop-solar-dreams-turn-sour-for-consumers/ |
| S62 | SolarQuarter, 25 Jun 2026 — MNRE SOP | https://solarquarter.com/2026/06/25/mnre-introduces-strict-sop-to-address-consumer-complaints-against-solar-vendors-under-pm-surya-ghar-scheme/ |
| S63 | Power Peak Digest — UPNEDA blacklisting | https://powerpeakdigest.com/upneda-blacklists-rooftop-solar-vendor-under-pm-surya-ghar-scheme/ |
| S64 | Reslink — blacklisting blog (vendor) | https://www.reslink.org/blogs/pm-surya-ghar-is-blacklisting-bad-vendors-here-is-how-to-win-on-trust/ |
| S65 | PV Magazine, 31 Aug 2026 | https://www.pv-magazine.com/2026/08/31/india-adds-6-6-gw-of-rooftop-solar-in-h1-2026/ |
| S66 | Deccan Herald, 4 Aug 2026 | https://www.deccanherald.com/amp/story/india/pm-surya-ghar-scheme-crosses-50-lakh-household-milestone-in-rooftop-solar-drive-4098827 |
| S67 | Mercom, 1 Jun 2026 | https://www.mercomindia.com/pm-surya-ghar-crosses-four-million-but-fy-2027-target-remains-distant |
| S68 | QuickEstimate — CPL (vendor) | https://quickestimate.co/blog/cost-per-solar-lead-india |
| S69 | QuickEstimate — lead management (vendor) | https://quickestimate.co/blog/solar-lead-management-in-india |
| S70 | QuickEstimate — best solar CRM (vendor) | https://quickestimate.co/blog/best-solar-crm-software-in-india |
| S71 | QuickEstimate — software stack (vendor) | https://quickestimate.co/blog/solar-installer-software-stack |
| S72 | SurgePV — India vs global CRM (vendor) | https://www.surgepv.com/compare/solar-crm-india-vs-global |
| S73 | Sunbase blog (vendor) | https://www.sunbasedata.com/blog/best-solar-crm-for-indian-epcs-in-2026-features-that-actually-matter |
| S74 | Energetica India — BIS 200 kW inverter extension (headline) | https://www.energetica-india.net/news/mnre-extends-bis-certification-deadline-for-above-200-kw-solar-inverters-till-december-31 |
| S75 | Mercom — government rooftop ALMM-II | https://mercomindia.com/daily-news-wrap-up-mnre-clarifies-almm-ii-norms-for-government-rooftop-solar |
| S76 | Mercom — module prices rising before ALMM-II deadline | https://mercomindia.com/solar-module-prices-set-to-rise-as-procurement-rush-builds-ahead-of-almm-ii-deadline |
| S77 | Mercom — 10-year warranty headline | https://mercomindia.com/mnre-mandates-10-year-warranty-25-year-performance-cover-for-solar-modules |

---

## Conclusion

The generic flow treats an Indian solar order as a sales event; the evidence shows it is a **compliance-and-cash-cycle event** that stays open for months after dispatch. The distributor's real risks — stranded non-List-II stock, non-DCR modules on subsidised jobs, dealer credit tied to slow loans and DISCOM approvals, and consent exposure under DPDP from May 2027 — sit exactly where the generic flow is silent. The three dates that should shape the first build are 30 Nov 2026, 31 Dec 2026 and 13 May 2027.

The honest limit of this brief: most of the regulatory layer rests on trade press and vendor blogs, and the commercial layer (margins, credit days, conversion) rests on one vendor's unsourced estimates. The roadmap therefore front-loads configurable rule packs (so a corrected OM number, rate or date is a data change, not a rebuild) and an interview-and-primary-document programme to convert the "Verify before relying" items into fact before any client advice is signed off.
