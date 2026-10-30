import type { Json } from '../rows';
import type { RuleSeedInput } from './rules.types';

/**
 * Operating defaults owned by the seed module (not in prompt Section 6.2): escalation cadence, working calendar, the staleness
 * thresholds behind gates G1/G10, the lead-score weights (Appendix A) and the temperature deadline uplift.
 */

const OP = 'Future Solar operating default';
const REF = 'docs/AGENT_BRIEF.md Appendix A and B';

const operating = (path: string, value: Json, note: string, max: RuleSeedInput['max_severity'] = 'info'): RuleSeedInput => ({
  path, value, source_name: OP, source_ref: REF, confidence: 'high', status: 'verified', active: true, max_severity: max, notes: note,
});

export const rules_core: RuleSeedInput[] = [
  operating('sla.escalation_step_minutes', 240, 'Working minutes between escalation levels (owner → DSM → Sales Manager → Management) once a clock has breached.'),

  operating('work_calendar.hours', { days: [1, 2, 3, 4, 5, 6], start: '09:30', end: '18:30' }, 'Working days (0 = Sunday … 6 = Saturday) and hours in IST. SLA clocks only run inside these hours.'),
  // Flat keys read by the order/payment-reminder helpers; they mirror work_calendar.hours.
  operating('work_calendar.days', [1, 2, 3, 4, 5, 6], 'Working days (0 = Sunday … 6 = Saturday). Mirrors work_calendar.hours.days.'),
  operating('work_calendar.start', '09:30', 'Opening time in IST. Mirrors work_calendar.hours.start.'),
  operating('work_calendar.end', '18:30', 'Closing time in IST. Mirrors work_calendar.hours.end.'),
  {
    path: 'work_calendar.holidays',
    value: [
      '2026-11-08', '2026-11-10', '2026-11-11',
      '2027-01-14', '2027-01-26', '2027-04-14', '2027-05-01', '2027-08-15', '2027-10-02',
    ],
    source_name: 'Gujarat public holiday calendar (fixed-date holidays) and festival panchang (Diwali period)',
    source_ref: 'Gujarat General Administration Department holiday notifications — not retrieved; dates entered from general knowledge',
    confidence: 'medium', status: 'unverified', active: true, max_severity: 'info',
    notes: 'SLA clocks pause on these dates. Fixed-date: Uttarayan 14-Jan-2027, Republic Day 26-Jan-2027, Dr. Ambedkar Jayanti 14-Apr-2027, Gujarat Foundation Day 1-May-2027, Independence Day 15-Aug-2027, Gandhi Jayanti 2-Oct-2027. '
      + 'Diwali period 2026 (Lakshmi Pujan 8-Nov, Gujarati New Year 10-Nov, Bhai Beej 11-Nov) follows the panchang. Replace with the official annual list in Admin → Work calendar. Verify against primary source before relying',
  },

  operating('compliance.dnd_scrub_max_age_days', 30, 'A DND scrub result older than this many days is stale; promotional messages are blocked until the mobile is scrubbed again (gate G1).', 'hard_stop'),
  operating('compliance.almm_snapshot_max_age_days', 7, 'An ALMM compliance snapshot older than this many days raises gate G10 (warning).', 'warning'),

  operating('scoring.weights', {
    requirement_clarity: 20, mw_size: 15, timeline: 25, budget: 15, decision_maker: 10, consent_present: 10, bill_captured: 5,
  }, 'Lead quality score weights (sum 100). Appendix A of the engineering brief defines how each factor is scored from 0 to 1.'),

  operating('temperature.deadline_uplift_days', 60, 'A lead is raised one temperature level (cold → warm → hot) when a relevant compliance deadline is within this many days.'),
];
