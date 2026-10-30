import { istDateString } from '@solar/shared';

/** `YYYY-MM-DD` arithmetic on IST calendar dates (no time-zone surprises: pure UTC date math on the date string). */
export function addDaysStr(date: string, days: number): string {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export const minDateStr = (...dates: string[]): string => dates.reduce((a, b) => (a <= b ? a : b));
export const maxDateStr = (...dates: string[]): string => dates.reduce((a, b) => (a >= b ? a : b));
/** IST calendar date of an ISO timestamp. */
export const istDate = (iso: string): string => istDateString(new Date(iso));
/** Whole days from `a` to `b` (positive when b is later). */
export function diffDays(a: string, b: string): number {
  return Math.round((Date.parse(`${b.slice(0, 10)}T00:00:00Z`) - Date.parse(`${a.slice(0, 10)}T00:00:00Z`)) / 86400000);
}
