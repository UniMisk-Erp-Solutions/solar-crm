import type { RuleSeedInput } from './rules.types';

const SOURCE = 'Future Solar operating default';
const REF = 'docs/api/postsale-channel.md — operating defaults for the post-sale and channel modules';
const VERIFY = 'Verify against primary source before relying.';

/** Operating default (an internal choice, not a regulatory value): active, informational — never blocks or alters a transaction. */
const operating = (path: string, value: RuleSeedInput['value'], note: string, max: RuleSeedInput['max_severity'] = 'info'): RuleSeedInput => ({
  path, value, source_name: SOURCE, source_ref: REF, confidence: 'high', status: 'verified', active: true, max_severity: max, notes: `Operating default — ${note}`,
});

/**
 * Operational (non-regulatory) rule defaults needed by the post-sale and channel modules.
 * Regulatory values the same modules READ (discom.*, pmsg.cfa_*, pmsg.grievance_days, mnre_sop.*, pmsg.claim_deadline.legacy_cohort, pmsg.vendor_bg.*,
 * gujarat.state_subsidy, gerc.regulation_versions) are owned by rules.regulatory.ts.
 * Deliberately NOT seeded: channel.rebate_slabs — dealer rebate slabs have no sourced values (prompt Section 6.2: channel economics are hypotheses, never coded).
 * Until a slab set is configured, rebate accrual is 0 and the scorecard says "slabs not configured".
 */
export const rules_postsale: RuleSeedInput[] = [
  {
    path: 'gujarat.pmsg_no_connectivity_agreement', value: true, effective_from: '2025-11-04', source_name: 'GERC Net Metering Rooftop Regulations — Fifth Amendment (as reported)',
    source_ref: 'India solar distributor CRM blueprint.md §3.3 (S37, S38)', confidence: 'medium', status: 'unverified', active: false, max_severity: 'info',
    notes: `Gujarat PMSG rooftop systems commissioned on/after the Fifth Amendment need no separate written connectivity agreement; the agreement begins on the commissioning date. While this rule is inactive the installation flag "no_connectivity_agreement" is a manual entry only. ${VERIFY}`,
  },
  {
    path: 'pmsg.om_years', value: 5, source_name: 'PM Surya Ghar guideline — vendor duties (cl. 7(d), as reported)', source_ref: 'India solar distributor CRM blueprint.md §3.1 (S1)',
    confidence: 'high', status: 'verified', active: true, max_severity: 'info',
    notes: `Vendor-of-record duty: free comprehensive maintenance for this many years from commissioning. Drives installations.om_end and the O&M register. ${VERIFY}`,
  },
  {
    path: 'pmsg.legacy_cohort_cutoff', value: '2025-04-01', source_name: 'MNRE OM of 31-Aug-2026 (as reported; OM text not read)', source_ref: 'India solar distributor CRM blueprint.md §3.1 (S3)',
    confidence: 'low', status: 'unverified', active: false, max_severity: 'info',
    notes: `Applications made before this date are treated as the legacy cohort (30-Nov-2026 claim deadline). The date is an unconfirmed reading of the OM. While inactive the subsidy-claim cohort is a manual flag only. ${VERIFY}`,
  },
  operating('subsidy.legacy_reminder_days', [14, 7, 3], 'days before the legacy CFA claim deadline at which reminders escalate: first value to the DSM, next to the Sales Manager, last to Management.'),
  operating('loan.ageing_warn_days', 15, 'a loan application that has waited this many days without a decision is flagged on the post-sale board (no statutory SLA exists).', 'warning'),
  operating('warranty.rma_tat_days', 21, 'target turnaround, in days, for a warranty / RMA ticket (starts the warranty_rma clock). Brand-specific turnaround is unknown.'),
  operating('postsale.om_expiring_days', 90, 'an installation counts as "expiring" in the 5-year O&M register when this many days (or fewer) remain.'),
  operating('distributor.score_weights', { acceptance_rate: 30, acceptance_time: 15, conversion: 25, compliance: 20, load: 10 }, 'weights (sum 100) of the 0–100 distributor score: lead acceptance rate, on-time acceptance, lead-to-opportunity conversion, compliance record, open-lead load.'),
  operating('distributor.score_params', { window_days: 90, min_sample: 3, conversion_full_credit_rate: 0.4, max_open_leads: 25, complaint_penalty: 0.05, open_sop_penalty: 0.15, deactivated_penalty: 0.5, expired_bg_penalty: 0.2 },
    'tuning for the distributor score: look-back window (days), minimum assignments before the rate is trusted, conversion rate that earns full marks, open-lead count that earns zero for load, and compliance penalties (fraction of the compliance factor).'),
];
