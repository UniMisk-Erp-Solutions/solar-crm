import type { RuleSeedInput } from './rules.types';

const OP = 'Future Solar operating default';
const SOURCE_REF = 'docs/api/leads.md (leads module defaults)';

/** Operating defaults that are ours to choose: verified + active, never able to block on their own (max severity info). */
const operating = (path: string, value: RuleSeedInput['value'], notes: string): RuleSeedInput => ({
  path, value, source_name: OP, source_ref: SOURCE_REF, confidence: 'high', status: 'verified', active: true, max_severity: 'info', notes,
});

/** Operational (non-regulatory) rule defaults needed by the leads module. Add entries here; the seed assembler merges them. */
export const rules_leads: RuleSeedInput[] = [
  /* ── routing (Stage 1, steps 4–7) ── */
  operating('sla.lead_acceptance_reassign_minutes.hot', 15, 'Minutes after the DSM alert before an unaccepted HOT lead is auto-reassigned (Reminder 1 → DSM alert → auto-reassignment).'),
  operating('sla.lead_acceptance_reassign_minutes.warm', 60, 'Minutes after the DSM alert before an unaccepted WARM lead is auto-reassigned.'),
  operating('sla.lead_acceptance_reassign_minutes.cold', 120, 'Minutes after the DSM alert before an unaccepted COLD lead is auto-reassigned.'),
  operating('routing.score_weights', { score: 0.6, load: 0.2, band_fit: 0.2 },
    'Weights used to rank eligible distributors: distributor score (0–100 scaled to 0–1), spare capacity (fewer open leads is better) and how centrally the lead size sits in the distributor’s MW band. The three weights are normalised before use.'),
  operating('routing.load_reference_leads', 20,
    'Number of open leads at which a distributor’s load factor drops to zero in the ranking above.'),
  operating('routing.max_auto_reassignments', 3,
    'After this many automatic assignments (first assignment included) a lead that is rejected or not accepted in time goes to the DSM as unassigned instead of being routed again.'),

  /* ── duplicate detection (Stage 1, step 2) ── */
  operating('lead.dedupe_similarity_threshold', 0.6,
    'Bigram-Jaccard similarity (0–1) at or above which two names in the same pincode are treated as a possible duplicate — the same intent as pg_trgm similarity in the database function.'),

  /* ── qualification (Stage 2, step 9) ── */
  operating('lead.qualification_required_fields', ['requirement_text', 'timeline_bucket', 'decision_maker', 'capacity_kw'],
    'Lead fields that must be known (timeline and decision maker not “unknown”) before a lead moves to Qualified. Allowed keys: requirement_text, timeline_bucket, decision_maker, capacity_kw, budget_inr, segment.'),

  /* ── follow-up engine (Stage 2, steps 12–13) ── */
  operating('followup.email_reminders', true,
    'When true, follow-up reminders and acceptance reminders are also e-mailed to the lead owner (and the DSM on breach), in addition to the in-app notification. Staff e-mails need no customer consent.'),
  operating('followup.retry_minutes', 240,
    'Working minutes after which a retry is scheduled when a call is not answered or the customer asks to be called back later.'),
  operating('followup.max_days_ahead', 180,
    'The furthest ahead a next follow-up date may be set (guards against typing the wrong year).'),
];
