import type { RuleSeedInput } from './rules.types';

const OP = 'Future Solar operating default';
const SOURCE_REF = 'docs/api/platform-admin.md (platform module defaults)';
const VERIFY = 'Verify against primary source before relying.';

/** Operating defaults that are ours to choose: verified + active. */
const operating = (path: string, value: RuleSeedInput['value'], notes: string): RuleSeedInput => ({
  path, value, source_name: OP, source_ref: SOURCE_REF, confidence: 'high', status: 'verified', active: true, max_severity: 'info', notes,
});

/**
 * Retention periods are a legal judgement, not an engineering default. They are seeded UNVERIFIED and INACTIVE so the
 * nightly retention job only REPORTS candidates until counsel confirms the periods and a compliance officer activates them.
 */
const retention = (path: string, value: RuleSeedInput['value'], notes: string): RuleSeedInput => ({
  path, value, source_name: `${OP} (placeholder — counsel to confirm DPDP retention periods)`, source_ref: SOURCE_REF, confidence: 'hypothesis', status: 'unverified', active: false, max_severity: 'info',
  notes: `${notes} Seeded inactive: the retention job only reports candidates until this rule is activated. ${VERIFY}`,
});

/** Operational (non-regulatory) rule defaults needed by the platform module (jobs, documents, retention, work calendar, breach watch). */
export const rules_platform: RuleSeedInput[] = [
  /* ── data retention (report-only until a compliance officer activates) ── */
  retention('retention.lead_inactive_days', 730, 'Leads with no activity for this many days are anonymised by the nightly retention job (statuses opportunity and won are never touched).'),
  retention('retention.dnd_register_days', 180, 'DND scrub-cache entries (hashed mobile + result) older than this many days are deleted.'),
  retention('retention.message_body_days', 180, 'Message bodies in message_log older than this many days are cleared (the log line itself is kept).'),
  operating('retention.batch_size', 200, 'Maximum number of leads the retention job anonymises in one run, so a mistaken activation can be stopped.'),

  /* ── privacy ── */
  operating('privacy.erase_blocked_by_open_orders', true, 'When true, an erasure request is refused while the person has an open sales order — statutory and contractual records are needed until it closes.'),

  /* ── documents ── */
  operating('documents.signed_url_seconds', 300, 'Lifetime of a signed download URL (5 minutes). The API clamps this between 30 and 900 seconds.'),
  operating('documents.upload_url_seconds', 600, 'Lifetime of a signed upload URL (10 minutes). The API clamps this between 60 and 1800 seconds.'),

  /* ── job schedules (cron expressions, Asia/Kolkata) ── */
  operating('jobs.clock_tick_cron', '* * * * *', 'Clock engine tick — marks breaches, sends 70 % warnings and escalations. Read when the API starts.'),
  operating('jobs.nightly_cron', '0 2 * * *', 'Nightly run of every registered job that uses the default schedule (02:00 IST). Read when the API starts.'),
  operating('jobs.breach_watch_cron', '0 * * * *', 'Hourly check of open breach incidents against their 72-hour reporting deadline. Read when the API starts.'),

  /* ── compliance calendar and breach watch ── */
  operating('calendar.default_escalate_days', [14, 7, 3], 'Countdown notification points (days before the due date) given to a new calendar item that does not list its own.'),
  operating('breach.watch_hours', [24, 6], 'An open breach incident notifies compliance when this many hours remain before the reporting deadline (and again once it is overdue).'),

  /* ── work calendar (read by every SLA calculation through lib/time.ts) ── */
  operating('work_calendar.hours', { days: [1, 2, 3, 4, 5, 6], start: '09:30', end: '18:30' }, 'Working days (0 = Sunday … 6 = Saturday) and hours in IST. SLA clocks only run inside these hours.'),
  operating('work_calendar.holidays', [], 'Holiday dates (YYYY-MM-DD) on which SLA clocks pause. Add the company holiday list in Admin → Work calendar.'),

  /* ── data quality scan ── */
  operating('data_quality.sample_size', 20, 'How many example record ids the nightly data-quality scan lists per finding.'),
];
