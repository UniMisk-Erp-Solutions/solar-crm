import type { RuleSeedInput } from './rules.types';

const OPS = 'Future Solar operating default';
const VERIFY = 'Verify against primary source before relying.';

/**
 * Operational (non-regulatory) rule defaults needed by the quotes / compliance module.
 *
 * Two kinds of rows live here:
 *  - plain operating parameters (validity days, price-snapshot age, SLA hours, margin floor, discount bands) — these are Future Solar
 *    policy, not claims about the outside world;
 *  - one GATE SWITCH (`compliance.aadhaar_block`, gate G14) — a policy gate with no regulatory parameter. A compliance officer can
 *    deactivate it (the gate then degrades to a warning).
 * Regulatory dates/amounts (CFA, ALMM dates, BIS dates, GST rates, …) are seeded by the regulatory fragment, never here; gates read them:
 *   G1 trai.optout_reconsent_block_days · G2 pmsg.dcr_required_for_cfa · G3 almm.list1.enforcement_date · G4 almm.list2.effective_date ·
 *   G5 almm.list2.exemption_net_metering_open_access_until · G6 bis.module_standard_no · G7 bis.inverter_self_cert_* · G13 pmsg.cfa.max_kw_eligible ·
 *   G9 gst.<category>_rate · G10 compliance.almm_snapshot_max_age_days (platform seed).
 */
export const rules_quotes: RuleSeedInput[] = [
  { path: 'quote.default_validity_days', value: 7, source_name: OPS, source_ref: 'prompt.md §9 Stage 4 (default quote validity)', confidence: 'high', status: 'verified', active: true,
    notes: 'Default quote validity in calendar days. The actual default is capped at the price horizon and, when relying on the exemption, the exemption date.' },
  { path: 'quote.max_price_snapshot_age_days', value: 14, source_name: OPS, source_ref: 'prompt.md §7 gate G8 (price snapshot age limit)', confidence: 'medium', status: 'verified', active: true,
    notes: 'A quote must not stay valid beyond price snapshot date + this many days (gate G8 warning; also caps the default validity).' },
  { path: 'quote.approval_sla_hours', value: { commercial: 24, compliance: 24, credit: 24 }, source_name: OPS, source_ref: 'prompt.md §9 Stage 4 (SLA clock per lane)', confidence: 'medium', status: 'verified', active: true,
    notes: 'Fallback SLA (working hours) per approval step when approval_rules has no sla_hours for the lane.' },
  { path: 'quote.discount_bands', value: [
      { min_pct: 0, max_pct: 2, role_chain: [] },
      { min_pct: 2, max_pct: 5, role_chain: ['dsm'] },
      { min_pct: 5, max_pct: 8, role_chain: ['dsm', 'regional_head'] },
      { min_pct: 8, max_pct: null, role_chain: ['dsm', 'regional_head', 'management'] },
    ], source_name: OPS, source_ref: 'prompt.md §9 Stage 4 (approval matrix DSM → Regional Head → Management)', confidence: 'hypothesis', status: 'unverified', active: true,
    notes: 'Fallback commercial-lane discount bands, used only when approval_rules has no active commercial rows. Placeholder thresholds — Management to confirm. Sequential steps within a band.' },
  { path: 'quote.credit_overdue_days', value: 60, source_name: OPS, source_ref: 'prompt.md §9 Stage 4 (credit lane: ageing)', confidence: 'hypothesis', status: 'unverified', active: true,
    notes: 'Dealer receivables overdue by more than this many days open the credit approval lane on a quote. Placeholder — Accounts to confirm.' },
  { path: 'quote.default_clauses', value: ['clause.price_validity', 'clause.duty_change', 'clause.gst_change', 'clause.almm_change'], source_name: OPS, source_ref: 'prompt.md §9 Stage 4 (change clause text from templates)', confidence: 'high', status: 'verified', active: true,
    notes: 'message_templates keys attached to a new quote. Keys that do not exist as active templates are skipped.' },
  { path: 'price_floor.min_margin_pct', value: 6, source_name: OPS, source_ref: 'prompt.md §9 Stage 4 (internal price review: margin and floor-price check)', confidence: 'hypothesis', status: 'unverified', active: true,
    notes: 'Minimum quote margin over landed cost. Placeholder — Management to set. Advisory until verified: a breach is shown in the price review but does not change approval routing.' },
  { path: 'price_floor.breach_role_chain', value: ['dsm', 'regional_head', 'management'], source_name: OPS, source_ref: 'prompt.md §9 Stage 4 (approval matrix)', confidence: 'medium', status: 'verified', active: true,
    notes: 'Commercial-lane chain forced when a line is priced below sku_prices.floor_price.' },
  { path: 'compliance.aadhaar_block', value: true, source_name: OPS, source_ref: 'prompt.md §13 (Aadhaar policy); blueprint §5b G14', confidence: 'medium', status: 'verified', active: true, max_severity: 'hard_stop',
    notes: `Gate switch for G14 — an Aadhaar number typed into free text or an Aadhaar-named upload is a hard stop (safe-default policy). ${VERIFY}` },
];
