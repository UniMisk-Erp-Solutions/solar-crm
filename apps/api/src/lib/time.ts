/**
 * Working-time arithmetic in Asia/Kolkata (UTC+05:30, no DST).
 * All SLA clocks respect working hours and holidays from the `work_calendar` rule category.
 */
import { istDateString } from '@solar/shared';

export interface WorkCalendar {
  /** 0 = Sunday … 6 = Saturday */
  days: number[];
  start: string; // HH:MM IST
  end: string; // HH:MM IST
  holidays: string[]; // YYYY-MM-DD
}

export const DEFAULT_WORK_CALENDAR: WorkCalendar = { days: [1, 2, 3, 4, 5, 6], start: '09:30', end: '18:30', holidays: [] };

const IST_OFFSET_MS = 5.5 * 3600 * 1000;
const MIN = 60_000;

const toWall = (d: Date): Date => new Date(d.getTime() + IST_OFFSET_MS); // read with getUTC* = IST fields
const fromWall = (w: Date): Date => new Date(w.getTime() - IST_OFFSET_MS);
const hm = (s: string): number => { const [h = '0', m = '0'] = s.split(':'); return Number(h) * 60 + Number(m); };

function isWorkingDay(wall: Date, cal: WorkCalendar): boolean {
  const ds = `${wall.getUTCFullYear()}-${String(wall.getUTCMonth() + 1).padStart(2, '0')}-${String(wall.getUTCDate()).padStart(2, '0')}`;
  return cal.days.includes(wall.getUTCDay()) && !cal.holidays.includes(ds);
}

function minutesOfDay(wall: Date): number { return wall.getUTCHours() * 60 + wall.getUTCMinutes(); }

function setMinutes(wall: Date, mins: number): Date {
  const w = new Date(wall.getTime());
  w.setUTCHours(0, 0, 0, 0);
  return new Date(w.getTime() + mins * MIN);
}

export function isWorkingTime(d: Date, cal: WorkCalendar = DEFAULT_WORK_CALENDAR): boolean {
  const w = toWall(d);
  const m = minutesOfDay(w);
  return isWorkingDay(w, cal) && m >= hm(cal.start) && m < hm(cal.end);
}

/** The next moment (>= d) at which working time is running. */
export function nextWorkingStart(d: Date, cal: WorkCalendar = DEFAULT_WORK_CALENDAR): Date {
  let w = toWall(d);
  for (let i = 0; i < 400; i++) {
    const m = minutesOfDay(w);
    if (isWorkingDay(w, cal)) {
      if (m < hm(cal.start)) return fromWall(setMinutes(w, hm(cal.start)));
      if (m < hm(cal.end)) return fromWall(w);
    }
    w = setMinutes(new Date(w.getTime() + 24 * 3600 * 1000), 0);
  }
  return d;
}

/** Adds `minutes` of working time to `from`. Time outside working hours does not count. */
export function addWorkingMinutes(from: Date, minutes: number, cal: WorkCalendar = DEFAULT_WORK_CALENDAR): Date {
  let cursor = nextWorkingStart(from, cal);
  let remaining = Math.max(0, minutes);
  for (let guard = 0; guard < 1000; guard++) {
    const w = toWall(cursor);
    const left = hm(cal.end) - minutesOfDay(w);
    if (remaining <= left) return new Date(cursor.getTime() + remaining * MIN);
    remaining -= left;
    cursor = nextWorkingStart(new Date(cursor.getTime() + left * MIN + MIN), cal);
  }
  return cursor;
}

/** End of the working day that `d` falls in (or the next working day when `d` is outside hours). */
export function endOfWorkingDay(d: Date, cal: WorkCalendar = DEFAULT_WORK_CALENDAR): Date {
  const start = nextWorkingStart(d, cal);
  return fromWall(setMinutes(toWall(start), hm(cal.end)));
}

/** Add whole calendar days, returned at the same IST wall-clock time. */
export function addDays(d: Date, days: number): Date { return new Date(d.getTime() + days * 24 * 3600 * 1000); }

/** Same instant → next working day at the opening time (used for follow-up due times). */
export function nextWorkingDayStart(d: Date, cal: WorkCalendar = DEFAULT_WORK_CALENDAR): Date {
  return nextWorkingStart(fromWall(setMinutes(new Date(toWall(d).getTime() + 24 * 3600 * 1000), 0)), cal);
}

export const todayIst = (d: Date = new Date()): string => istDateString(d);

/** Parse 'YYYY-MM-DD' (IST calendar date) to the instant at 00:00 IST. */
export function istMidnight(date: string): Date { return new Date(new Date(`${date}T00:00:00Z`).getTime() - IST_OFFSET_MS); }
/** End of an IST calendar date (23:59:59.999). */
export function istEndOfDay(date: string): Date { return new Date(istMidnight(date).getTime() + 24 * 3600 * 1000 - 1); }
