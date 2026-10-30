import type { RuleSeedInput } from './rules.types';

const SOURCE = 'Future Solar operating default';
const REF = 'Reporting module default — change under Admin → Rule Config';

/** Operating default (internal choice, not a regulatory value): active, informational only — never blocks or alters a transaction. */
const operating = (path: string, value: number, note: string): RuleSeedInput => ({
  path, value, source_name: SOURCE, source_ref: REF, confidence: 'high', status: 'verified', active: true, max_severity: 'info',
  notes: `Operating default — ${note}`,
});

/**
 * Operational (non-regulatory) rule defaults needed by the reporting module. Add entries here; the seed assembler merges them.
 * Deliberately NOT seeded: conversion-rate, margin, credit-day or DSO targets — prompt Section 6.2 classes those as hypotheses that are never coded.
 */
export const rules_reporting: RuleSeedInput[] = [
  operating('kpi.target.follow_up_compliance_pct', 90, 'target for follow-up compliance (on-time ÷ due). Shown on the KPI tile; does not block anything.'),
  operating('kpi.target.first_response_24h_pct', 95, 'target for leads first contacted within the 24-hour window.'),
  operating('kpi.target.first_response_hot_30min_pct', 90, 'target for HOT leads first contacted within 30 minutes.'),
  operating('kpi.target.lead_acceptance_sla_pct', 90, 'target for leads accepted by the distributor within the acceptance SLA.'),
  operating('kpi.target.consent_coverage_pct', 100, 'no outbound contact without a valid consent record, so the expected coverage is 100%.'),
  operating('reporting.default_period_days', 90, 'length of the default dashboard period when no from/to dates are given.'),
  operating('reporting.first_response_window_hours', 24, 'window for the "first response" KPI (matches the WhatsApp 24-hour service window).'),
  operating('reporting.first_response_hot_minutes', 30, 'window for the HOT-lead "first response" KPI.'),
  operating('reporting.deadline_alert_days', 3, 'a DISCOM / CFA clock is "near deadline" on the Today queue when this many days (or fewer) are left.'),
  operating('reporting.legacy_claim_alert_days', 30, 'legacy-cohort CFA claims turn critical on the Today queue when this many days (or fewer) are left to the claim deadline.'),
  operating('reporting.bg_expiry_alert_days', 60, 'a dealer bank guarantee is flagged "expiring" when this many days (or fewer) remain.'),
  operating('reporting.stock_exposure_alert_days', 90, 'non-List-II stock exposure turns amber when the exemption date is this many days away (red at 30).'),
  operating('reporting.calendar_lookahead_days', 60, 'compliance-calendar items due within this many days appear on the Today queue.'),
];
