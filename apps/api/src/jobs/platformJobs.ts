import { registerJob } from '../services/hooks';
import { runBreachWatch } from '../services/breachService';
import { runCalendarCountdown } from '../services/calendarService';
import { runRetention } from '../services/privacyService';
import { runDataQualityScan } from './dataQuality';

export const NIGHTLY_CRON = '0 2 * * *';
export const HOURLY_CRON = '0 * * * *';

/** What each platform job does — shown in Admin → Jobs. */
export const JOB_DESCRIPTIONS: Record<string, string> = {
  'calendar.countdown': 'Compliance-calendar countdown notifications (D-14, D-7, D-3 or each item’s own points).',
  'privacy.retention': 'Retention and erasure: anonymises long-inactive leads and clears expired DND / message data — reports only until its rules are verified and active.',
  'platform.data_quality': 'Scans for leads and quotes with missing or inconsistent data and notifies admin and compliance.',
  'breach.watch': 'Warns compliance as the 72-hour reporting deadline of an open breach incident approaches or passes.',
};

/* Registered at module load; jobs/index.ts imports this file so the job runner always knows them. */
registerJob({ name: 'calendar.countdown', schedule: NIGHTLY_CRON, run: async (ctx) => ({ ...(await runCalendarCountdown(ctx)) }) });
registerJob({ name: 'privacy.retention', schedule: NIGHTLY_CRON, run: async (ctx) => ({ ...(await runRetention(ctx)) }) });
registerJob({ name: 'platform.data_quality', schedule: NIGHTLY_CRON, run: async (ctx) => ({ ...(await runDataQualityScan(ctx)) }) });
registerJob({ name: 'breach.watch', schedule: HOURLY_CRON, run: async (ctx) => ({ ...(await runBreachWatch(ctx)) }) });
