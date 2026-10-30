import type { RuleConfidence, RuleStatus, Severity } from '../enums';
import type { Json } from '../rows';
import type { RuleSeedInput } from './rules.types';

/**
 * Regulatory / policy values from the research report (prompt Section 6.2). Owned by the seed module.
 *
 * Conventions (docs/AGENT_BRIEF.md, Appendix B):
 *  - high / medium-high confidence AND active  ⇒ status "verified"
 *  - medium confidence, active but advisory     ⇒ status "unverified", active, max_severity warning (or info)
 *  - conflicting values                         ⇒ status "conflicting", inactive
 *  - the report only has four confidence levels in the schema, so "medium-high" is stored as "medium" with status "verified" and the
 *    original wording is kept in the notes.
 */

const REPORT = 'Research report 26-Oct-2026';
const VERIFY = 'Verify against primary source before relying';
const BLUEPRINT = 'India solar distributor CRM blueprint.md';

interface Src { name: string; ref: string }
const SRC = {
  chart: { name: 'Future Solar reference flow chart (company-defined SLA)', ref: 'Solar CRM flow diagrams.md §11.3; prompt.md §1.1' },
  pmsg: { name: `${REPORT} / MNRE PMSG guidelines (trade-press summary)`, ref: `${BLUEPRINT} §3.1 [S1][S2][S4]` },
  pmsgBg: { name: `${REPORT} / MNRE PMSG vendor guidelines (trade-press summary)`, ref: `${BLUEPRINT} §3.1 [S6]` },
  pmsgLegacy: { name: `${REPORT} / MNRE OM 31-Aug-2026 (trade-press summary; OM text not read)`, ref: `${BLUEPRINT} §3.1 [S3]` },
  pmsgEnd: { name: `${REPORT} / trade press (programme end)`, ref: `${BLUEPRINT} §3.1 [S2][S65]` },
  rwa: { name: `${REPORT} / MNRE PMSG guidelines, RWA-GHS component (trade-press summary)`, ref: `${BLUEPRINT} §3.1 [S1][S2][S4]` },
  discom: { name: `${REPORT} / Electricity (Rights of Consumers) Amendment Rules 2024 (trade-press summary)`, ref: `${BLUEPRINT} §3.3 [S34][S35][S36]` },
  sop: { name: `${REPORT} / MNRE SOP of 22-Jun-2026 (trade-press summary)`, ref: `${BLUEPRINT} §3.5 [S62]` },
  almm: { name: `${REPORT} / MNRE ALMM orders and 18-Jul-2026 OM (trade-press summary)`, ref: `${BLUEPRINT} §3.2 [S14][S15][S16]` },
  almm3: { name: `${REPORT} / MNRE ALMM List-III announcement (trade-press summary)`, ref: `${BLUEPRINT} §3.2 [S19]` },
  bis: { name: `${REPORT} / MoNRE S.O. 3706(E) of 3-Jul-2026 (secondary transcription)`, ref: `${BLUEPRINT} §3.2 [S23][S74]` },
  bisStd: { name: `${REPORT} / BIS Solar Systems Goods Order 2025, S.O. 492(E) (conflicting vendor sources)`, ref: `${BLUEPRINT} §3.2 [S23][S24]` },
  gst: { name: `${REPORT} / 56th GST Council, effective 22-Sep-2025 (trade-press summary)`, ref: `${BLUEPRINT} §3.2 [S30]` },
  gstInv: { name: `${REPORT} / GST on inverters (secondary sources, disputed)`, ref: `${BLUEPRINT} §3.2 [S31]` },
  gstBlog: { name: `${REPORT} / vendor blog (GST on structures, batteries, works-contract split)`, ref: `${BLUEPRINT} §3.2 [S32]` },
  customs: { name: `${REPORT} / customs duty (vendor blog)`, ref: `${BLUEPRINT} §3.2 [S26][S27][S28][S29]` },
  loan: { name: `${REPORT} / PMSG loan terms (conflicting government statements)`, ref: `${BLUEPRINT} §3.5 [S8][S66]` },
  trai: { name: `${REPORT} / TRAI TCCCPR amendment, PR No. 11 of 2025 (12-Feb-2025)`, ref: `${BLUEPRINT} §3.4 [S47][S48][S49]` },
  whatsapp: { name: `${REPORT} / Meta WhatsApp Business pricing and policy`, ref: `${BLUEPRINT} §3.4 [S53][S54]` },
  dpdp: { name: `${REPORT} / DPDP Rules 2025, G.S.R. 846(E) (law-firm commentary)`, ref: `${BLUEPRINT} §3.4 [S43][S44][S45][S46]` },
  kusum: { name: `${REPORT} / PM-KUSUM timelines (trade-press summary)`, ref: `${BLUEPRINT} §3.1 [S13]` },
  gujarat: { name: `${REPORT} / Gujarat subsidy and net-metering (news summary and vendor blog)`, ref: `${BLUEPRINT} §3.1, §3.3 [S10][S11]` },
  gujaratOa: { name: `${REPORT} / GERC Order 04 of 2025 (open-access additional surcharge)`, ref: `${BLUEPRINT} §3.3 [S40][S41]` },
  gerc: { name: `${REPORT} / GERC Net Metering Rooftop Regulations 2016 as amended (trade-press summary)`, ref: `${BLUEPRINT} §3.3 [S37][S38][S39]` },
} satisfies Record<string, Src>;

interface Opt {
  src: Src;
  conf: RuleConfidence;
  status: RuleStatus;
  active: boolean;
  max?: Severity;
  note: string;
  from?: string;
  to?: string | null;
}

const rule = (path: string, value: Json, o: Opt): RuleSeedInput => ({
  path, value,
  effective_from: o.from, effective_to: o.to ?? null,
  source_name: o.src.name, source_ref: o.src.ref,
  confidence: o.conf, status: o.status, active: o.active,
  max_severity: o.max ?? 'warning',
  notes: `${o.note} ${VERIFY}`,
});

/** Verified + active rule. */
const verified = (path: string, value: Json, src: Src, note: string, max: Severity = 'warning', conf: RuleConfidence = 'high', extra: Partial<Opt> = {}): RuleSeedInput =>
  rule(path, value, { src, conf, status: 'verified', active: true, max, note, ...extra });

/** Medium-confidence rule that is active but advisory (cannot block until a compliance officer enforces it). */
const advisory = (path: string, value: Json, src: Src, note: string, max: Severity = 'warning', extra: Partial<Opt> = {}): RuleSeedInput =>
  rule(path, value, { src, conf: 'medium', status: 'unverified', active: true, max, note, ...extra });

/** Low-confidence rule that is stored but switched off. */
const inactive = (path: string, value: Json, src: Src, note: string, extra: Partial<Opt> = {}): RuleSeedInput =>
  rule(path, value, { src, conf: 'low', status: 'unverified', active: false, max: 'info', note, ...extra });

/** Two or more sources disagree: stored with all candidates, inactive. */
const conflicting = (path: string, candidates: Json, src: Src, note: string, extra: Partial<Opt> = {}): RuleSeedInput =>
  rule(path, { status: 'conflicting', candidates }, { src, conf: 'low', status: 'conflicting', active: false, max: 'info', note, ...extra });

export const rules_regulatory: RuleSeedInput[] = [
  /* ───────── SLA (reference chart) ───────── */
  verified('sla.lead_acceptance_minutes.hot', 30, SRC.chart, 'HOT lead acceptance: 15–30 working minutes (30 used; chart range 15–30).', 'info'),
  verified('sla.lead_acceptance_minutes.warm', 120, SRC.chart, 'WARM lead acceptance: within 2 working hours.', 'info'),
  verified('sla.lead_acceptance.cold', 'end_of_working_day', SRC.chart, 'COLD lead acceptance: by the end of the same working day.', 'info'),
  verified('sla.followup_days.hot', 1, SRC.chart, 'HOT follow-up: same day / daily.', 'info'),
  verified('sla.followup_days.warm', 3, SRC.chart, 'WARM follow-up: every 2–5 days (3 used).', 'info'),
  verified('sla.followup_days.cold', 7, SRC.chart, 'COLD follow-up: weekly / nurture.', 'info'),
  verified('sla.quote_followup_days', [1, 3, 5, 7], SRC.chart, 'Quote follow-up on day 1, 3, 5 and 7, then escalation.', 'info'),

  /* ───────── PM Surya Ghar (residential) ───────── */
  verified('pmsg.cfa.per_kw_first_2kw', 30000, SRC.pmsg, 'CFA ₹30,000 per kW for the first 2 kW (60 % of benchmark cost), as reported for cl. 5(e).'),
  verified('pmsg.cfa.third_kw', 18000, SRC.pmsg, 'CFA ₹18,000 for the third kW (40 % of benchmark cost).'),
  verified('pmsg.cfa.max_total', 78000, SRC.pmsg, 'CFA capped at ₹78,000 per residential system; no CFA beyond 3 kW.'),
  verified('pmsg.cfa.max_kw_eligible', 3, SRC.pmsg, 'Capacity eligible for CFA is capped at 3 kW (existing solar counts against it).'),
  verified('pmsg.cfa.special_category.per_kw_first_2kw', 33000, SRC.pmsg, 'Special-category states: ₹33,000 per kW for the first 2 kW (cl. 5(h) as reported).'),
  verified('pmsg.cfa.special_category.third_kw', 19800, SRC.pmsg, 'Special-category states: ₹19,800 for the third kW.'),
  verified('pmsg.benchmark_cost.first_2kw', 50000, SRC.pmsg, 'Benchmark cost ₹50,000 per kW for the first 2 kW — the basis of the CFA computation, not a price cap.'),
  verified('pmsg.benchmark_cost.additional', 45000, SRC.pmsg, 'Benchmark cost ₹45,000 per kW for additional capacity.'),
  verified('rwa_ghs.cfa_per_kw', 18000, SRC.rwa, 'RWA / GHS common-facility CFA ₹18,000 per kW.'),
  verified('rwa_ghs.max_kw', 500, SRC.rwa, 'RWA / GHS common-facility capacity capped at 500 kW.'),
  verified('rwa_ghs.kw_per_household', 3, SRC.rwa, 'RWA / GHS: 3 kW per household; CFA is on the lower of (households × 3 kW) and installed capacity.'),
  verified('pmsg.dcr_required_for_cfa', true, SRC.pmsg, 'Domestic-content (DCR) cells are an essential condition for CFA (cl. 5(m)). A vendor guide disputes this — see V-6. Gate G2.', 'hard_stop'),
  advisory('pmsg.vendor_bg.national', 2500000, SRC.pmsgBg, 'Bank guarantee ₹25,00,000 for a national vendor registration.'),
  advisory('pmsg.vendor_bg.per_state', 250000, SRC.pmsgBg, 'Bank guarantee ₹2,50,000 per state for multi-state vendors (plus ₹2.5 lakh per added state).'),
  advisory('pmsg.vendor_bg.validity_years', 5, SRC.pmsgBg, 'Bank guarantee must be valid for at least 5 years (amendment reported 5-Jun-2024).'),
  advisory('pmsg.claim_deadline.legacy_cohort', '2026-11-30', SRC.pmsgLegacy, 'CFA claims for the legacy (Phase II) cohort must be received by 30-Nov-2026. Countdown and warning only — OM text not read (V-1).'),
  advisory('pmsg.programme_end', '2027-03-31', SRC.pmsgEnd, 'Programme end March 2027 per press. Informational — no extension found.', 'info'),

  /* ───────── DISCOM timelines ───────── */
  verified('discom.feasibility_study_exempt_up_to_kw', 10, SRC.discom, 'No feasibility study up to and including 10 kW.'),
  verified('discom.feasibility_study_days_above_10kw', 15, SRC.discom, 'Feasibility study within 15 days above 10 kW; deemed feasible on DISCOM silence. Start trigger (submission vs complete application) unverified.'),
  advisory('discom.commissioning_days', 15, SRC.discom, 'DISCOM commissioning within 15 days of the installation-certificate submission (was 30).'),
  advisory('pmsg.cfa_release_days_after_discom_approval', 15, SRC.pmsg, 'CFA released within 15 days of DISCOM approval — a policy statement; field reality is slower.'),
  verified('pmsg.grievance_days', 30, SRC.pmsg, 'Grievances to be resolved within 30 days (cl. 11(a)).'),

  /* ───────── MNRE SOP (dealer complaints) — tracker only ───────── */
  verified('mnre_sop.vendor_reply_days', 8, SRC.sop, 'Vendor must reply to the complaint notice within 8 days. Tracker only.', 'info'),
  verified('mnre_sop.reminder_days', 15, SRC.sop, 'Reminder stage runs to day 15. Tracker only.', 'info'),
  verified('mnre_sop.show_cause_days', 15, SRC.sop, 'Show-cause stage runs 15 days. Tracker only.', 'info'),
  verified('mnre_sop.deactivation_months', 1, SRC.sop, 'Portal deactivation for one month. Tracker only.', 'info'),
  verified('mnre_sop.appeal_days', 30, SRC.sop, 'Appeal within 30 days. Tracker only.', 'info'),

  /* ───────── ALMM ───────── */
  verified('almm.list2.effective_date', '2026-06-01', SRC.almm, 'ALMM List-II (cells) mandatory from 1-Jun-2026 per the Dec-2024 OM, reiterated 28-Jul-2025. Gate G4.', 'hard_stop'),
  verified('almm.list2.exemption_net_metering_open_access_until', '2026-12-31', SRC.almm, 'Net-metering / open-access projects commissioned on or before 31-Dec-2026 may use cells not on List-II (18-Jul-2026 OM; no blanket extension). High on date and scope. Gate G5.', 'hard_stop'),
  conflicting('almm.list2.bid_date_carveout', ['2024-12-09', '2025-08-31'], SRC.almm, 'Bid-date grandfathering for List-II: the 09-Dec-2024 and 31-Aug-2025 readings conflict (V-4). Stored with both candidates; inactive until a compliance officer settles it.'),
  verified('almm.list3.effective_date', '2028-06-01', SRC.almm3, 'ALMM List-III (ingots and wafers) from 1-Jun-2028; first list only after at least 3 independent units with 15 GW combined. Informational. Report confidence: medium-high.', 'info', 'medium'),
  verified('almm.list1.enforcement_date', '2024-04-01', SRC.almm, 'ALMM List-I (modules, model-level) enforcement resumed 1-Apr-2024 after suspension in FY2023-24. Added so gate G3 has a governing rule. Report confidence: medium-high.', 'hard_stop', 'medium'),
  advisory('almm.captive_behind_meter_exempt', true, SRC.almm, 'Captive behind-the-meter plants are reported to be exempt from ALMM for modules and cells; the definition is unverified. Warning only.'),

  /* ───────── BIS ───────── */
  verified('bis.inverter_self_cert_above_kw', 200, SRC.bis, 'Inverters above 200 kW may be self-certified. Report confidence: medium-high. Gate G7 (warning; becomes a stop after the end date if a compliance officer enforces it).', 'warning', 'medium'),
  verified('bis.inverter_self_cert_until', '2026-12-31', SRC.bis, 'Self-certification for inverters above 200 kW extended to 31-Dec-2026 (S.O. 3706(E) of 3-Jul-2026; earlier S.O. 3597(E) to 30-Jun-2026). Report confidence: medium-high.', 'warning', 'medium'),
  conflicting('bis.module_standard_no', ['IS 14286', 'IS 14086'], SRC.bisStd, 'The BIS standard for crystalline modules is quoted as IS 14286 in one source and IS 14086 in another (V-5). Inactive; gate G6 degrades to a warning meanwhile.'),

  /* ───────── GST ───────── */
  verified('gst.modules_cells_rate', 12, SRC.gst, 'Solar modules and cells were taxed at 12 % until 21-Sep-2025. Start date of the 12 % slab not captured; the version opens at the seed epoch.', 'warning', 'high', { to: '2025-09-21' }),
  verified('gst.modules_cells_rate', 5, SRC.gst, 'Solar modules and cells at 5 % from 22-Sep-2025 (56th GST Council). The rate follows time of supply, not order date.', 'warning', 'high', { from: '2025-09-22' }),
  conflicting('gst.inverter_rate', [5, 18], SRC.gstInv, 'Inverters: 5 % (Entry 234) versus 18 % (HSN 8504) is disputed; the Karnataka HC ruling (W.P. 9686 of 2025) is reported by a secondary source (V-21). Inactive: every inverter quote line needs an explicit CA tax-position approval (gate G9).'),
  inactive('gst.structures_rate', 18, SRC.gstBlog, 'Mounting structures at 18 % — vendor blog, not re-checked. Line-level CA approval required.'),
  inactive('gst.batteries_rate', 18, SRC.gstBlog, 'Batteries at 18 % — vendor blog, not re-checked. Line-level CA approval required.'),
  inactive('gst.works_contract_split_70_30', { goods_pct: 70, services_pct: 30 }, SRC.gstBlog, '70:30 goods/services works-contract split (about 8.9 % effective) — vendor blog, self-flagged as not re-checked.'),

  /* ───────── Customs ───────── */
  inactive('customs.adc_on_cells_modules', false, SRC.customs, 'Anti-dumping duty on Chinese cells/modules: DGTR final findings (30-Sep-2025) recommended it but the Finance Ministry notification is unconfirmed. Default OFF (V-2).'),
  advisory('customs.modules.bcd', 20, SRC.customs, 'Basic customs duty on modules 20 % (blog). Landed-cost helper only.', 'info', { active: false }),
  advisory('customs.modules.aidc', 20, SRC.customs, 'AIDC on modules 20 % plus SWS (blog). Landed-cost helper only.', 'info', { active: false }),

  /* ───────── Loan ───────── */
  conflicting('loan.interest_rate_display', [7, 5.75], SRC.loan, 'Collateral-free PMSG loans: about 7 % (Feb-2025 document) versus 5.75 % (ministry statement of 4-Aug-2026) (V-19). Do not print a rate on quotes; the loan rate is a free input with a source date.'),

  /* ───────── TRAI / WhatsApp ───────── */
  conflicting('trai.promotional_series', { promotional_calls: '140', transactional_service: ['160', '1600'] }, SRC.trai, 'Promotional calls on the 140 series; the transactional/service series is reported as 1600 (TRAI) and 160 (Bar & Bench) (V-17). Configurable.'),
  conflicting('trai.header_suffix', ['-P', '-F'], SRC.trai, 'Header suffix: -P/-S/-T/-G (Fone Arena) versus -F (TRAI release as summarised) (V-17). Configurable.'),
  verified('trai.optout_reconsent_block_days', 90, SRC.trai, '90-day bar on re-seeking promotional consent after an opt-out. Gate G1.', 'hard_stop'),
  verified('trai.transactional_consent_days', 7, SRC.trai, '7-day transactional consent window.', 'warning'),
  verified('whatsapp.service_window_hours', 24, SRC.whatsapp, 'Free-form WhatsApp session messages are allowed within 24 hours of the customer\'s last message; templates outside it.', 'warning'),
  verified('whatsapp.click_to_whatsapp_free_window_days', 7, SRC.whatsapp, 'Click-to-WhatsApp entry points open a free window of up to 7 days.', 'info'),

  /* ───────── DPDP (calendar only) ───────── */
  verified('dpdp.consent_manager_registration_date', '2026-11-13', SRC.dpdp, 'Consent Manager registration from about 13-Nov-2026 (some sources count a day later). Calendar only.', 'info'),
  verified('dpdp.core_duties_date', '2027-05-13', SRC.dpdp, 'DPDP core duties from about 13-May-2027. A compression to 12 months was proposed but not notified as of 08-Oct-2026. Calendar only.', 'info'),
  advisory('dpdp.breach_report_hours', 72, SRC.dpdp, 'Detailed breach report to the Board within 72 hours (Rule 7).'),
  advisory('dpdp.audit_log_retention_days', 365, SRC.dpdp, 'Access logs retained for at least one year (Rule 8(3)).'),

  /* ───────── PM-KUSUM (calendar only) ───────── */
  advisory('kusum.componentB_cpump_commissioning_deadline', '2026-09-30', SRC.kusum, 'Component B and C individual-pump commissioning deadline 30-Sep-2026 (passed); a later extension is unverified (V-7). Calendar only.', 'info'),
  advisory('kusum.componentAC_commissioning_deadline', '2027-03-31', SRC.kusum, 'Components A and C (feeder) commissioning by 31-Mar-2027 for sanctions up to 31-Dec-2025. Calendar only.', 'info'),

  /* ───────── Gujarat ───────── */
  inactive('gujarat.state_subsidy', {}, SRC.gujarat, 'Gujarat state top-up: only a news summary exists, the worked example is internally inconsistent and no GR was found (V-8). Modelled as an empty, configurable state-scheme object; the quote state share stays zero until a compliance officer fills and activates it.'),
  inactive('gujarat.net_metering.surplus_rate', 2.25, SRC.gujarat, 'Surplus energy at ₹2.25 per unit for 5 years — vendor blog (V-11). Unit: ₹ per kWh.'),
  inactive('gujarat.net_metering.delay_compensation', 500, SRC.gujarat, 'Delay compensation of at least ₹500 per day — vendor blog (V-11). Unit: ₹ per day.'),
  rule('gujarat.open_access.additional_surcharge_per_kwh', 1.0, {
    src: SRC.gujaratOa, conf: 'medium', status: 'unverified', active: false, max: 'info', from: '2025-10-01', to: '2026-03-31',
    note: 'Additional surcharge ₹1.00 per kWh for open-access consumers, 1-Oct-2025 to 31-Mar-2026 (GERC Order 04 of 2025). The period has expired and later values were not found (V-12).',
  }),
  rule('gerc.regulation_versions', [
    { from: '2016-01-01', label: 'GERC Net Metering Rooftop Solar PV Grid Interactive Systems Regulations 2016, as amended before the Fifth Amendment (effective date approximate)' },
    { from: '2025-11-04', label: 'GERC Net Metering Rooftop Solar PV Grid Interactive Systems Regulations 2016 — Fifth Amendment (effective 4-Nov-2025, as reported)' },
  ], {
    src: SRC.gerc, conf: 'low', status: 'unverified', active: true, max: 'info',
    note: 'Used only to LABEL which regulation version applies from the commissioning date. Dates and labels come from trade-press summaries; the Surya Roshni v. PGVCL dispute on which version governs banking charges is unresolved (V-10, V-26).',
  }),
];
