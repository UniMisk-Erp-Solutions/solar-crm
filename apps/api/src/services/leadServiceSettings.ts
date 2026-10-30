/**
 * Rule-driven settings the lead module reads (SLA lengths, work calendar, thresholds). Every value has a documented
 * fallback so the module works on an empty rule table; rules that are inactive never change behaviour (rules.value → fallback).
 */
import type { Temperature } from '@solar/shared';
import type { AppContext } from '../auth/context';
import { DEFAULT_WORK_CALENDAR, addDays, addWorkingMinutes, endOfWorkingDay, nextWorkingStart, type WorkCalendar } from '../lib/time';

/** Active rule value or the fallback. */
export async function ruleOr<T>(ctx: AppContext, path: string, fallback: T, ref?: Date | string): Promise<T> {
  const v = await ctx.svc.rules.value<T>(path, ref, null);
  return v === null || v === undefined ? fallback : v;
}

/**
 * Working calendar from the `work_calendar.*` rules. The platform seed stores `work_calendar.hours = { days, start, end }`
 * plus `work_calendar.holidays`; separate `days` / `start` / `end` keys are honoured too.
 */
export async function loadWorkCalendar(ctx: AppContext): Promise<WorkCalendar> {
  const hours = await ctx.svc.rules.value<Partial<Pick<WorkCalendar, 'days' | 'start' | 'end'>>>('work_calendar.hours', undefined, null);
  const [days, start, end, holidays] = await Promise.all([
    ctx.svc.rules.value<number[]>('work_calendar.days', undefined, null), ctx.svc.rules.value<string>('work_calendar.start', undefined, null),
    ctx.svc.rules.value<string>('work_calendar.end', undefined, null), ctx.svc.rules.value<string[]>('work_calendar.holidays', undefined, null),
  ]);
  return {
    days: hours?.days ?? days ?? DEFAULT_WORK_CALENDAR.days,
    start: hours?.start ?? start ?? DEFAULT_WORK_CALENDAR.start,
    end: hours?.end ?? end ?? DEFAULT_WORK_CALENDAR.end,
    holidays: holidays ?? DEFAULT_WORK_CALENDAR.holidays,
  };
}

export const DEFAULT_ACCEPTANCE_MINUTES = { hot: 30, warm: 120 } as const;
/** Minutes after the DSM alert before an unaccepted lead is auto-reassigned (rules sla.lead_acceptance_reassign_minutes.*). */
export const DEFAULT_REASSIGN_MINUTES = { hot: 15, warm: 60, cold: 120 } as const;
export const DEFAULT_FOLLOWUP_DAYS: Record<Temperature, number> = { hot: 1, warm: 3, cold: 7 };

/** Appendix A: hot = sla.lead_acceptance_minutes.hot working minutes, warm = …warm, cold = end of the working day. */
export async function acceptanceDueAt(ctx: AppContext, temperature: Temperature | null, from: Date = ctx.now()): Promise<Date> {
  const cal = await loadWorkCalendar(ctx);
  const t = temperature ?? 'warm';
  if (t === 'cold') return endOfWorkingDay(from, cal);
  const minutes = await ruleOr<number>(ctx, `sla.lead_acceptance_minutes.${t}`, DEFAULT_ACCEPTANCE_MINUTES[t], from);
  return addWorkingMinutes(from, minutes, cal);
}

/** sla.followup_days.hot|warm|cold (1 | 3 | 7). */
export async function followupDays(ctx: AppContext, temperature: Temperature | null, from: Date = ctx.now()): Promise<number> {
  const t = temperature ?? 'warm';
  return ruleOr<number>(ctx, `sla.followup_days.${t}`, DEFAULT_FOLLOWUP_DAYS[t], from);
}

/** Default next follow-up: N days after `from` (rounded forward into working hours). */
export async function defaultFollowupAt(ctx: AppContext, temperature: Temperature | null, from: Date = ctx.now()): Promise<Date> {
  const cal = await loadWorkCalendar(ctx);
  return nextWorkingStart(addDays(from, await followupDays(ctx, temperature, from)), cal);
}

/** `from` + N working minutes. */
export async function workingMinutesFrom(ctx: AppContext, minutes: number, from: Date = ctx.now()): Promise<Date> {
  return addWorkingMinutes(from, minutes, await loadWorkCalendar(ctx));
}

export const TELECOM_CHANNELS = ['call', 'sms', 'whatsapp'] as const;
