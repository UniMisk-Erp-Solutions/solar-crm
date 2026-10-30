/** Small, dependency-free statistics helpers shared by every KPI family (and by the discom ageing view). */

/** Round half away from zero to `decimals` places without binary-float surprises (2.345 → 2.35). */
export const round = (n: number, decimals = 1): number => {
  if (!Number.isFinite(n)) return n;
  const text = String(Math.abs(n));
  if (text.includes('e')) return Math.round(n * 10 ** decimals) / 10 ** decimals;
  const r = Number(`${Math.round(Number(`${text}e${decimals}`))}e-${decimals}`);
  return n < 0 ? -r : r;
};

/** num ÷ den as a percentage rounded to 1 decimal; null when the denominator is zero. */
export const ratioPct = (num: number, den: number): number | null => (den > 0 ? round((num / den) * 100, 1) : null);

export const sum = (values: readonly number[]): number => values.reduce((s, v) => s + v, 0);

/**
 * Percentile with linear interpolation between closest ranks — identical to Postgres `percentile_cont(p/100)` and Excel `PERCENTILE.INC`.
 * `p` is 0–100. Returns null for an empty list.
 */
export function percentile(values: readonly number[], p: number): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  if (v.length === 1) return v[0]!;
  const rank = (Math.min(100, Math.max(0, p)) / 100) * (v.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return v[lo]! + (v[hi]! - v[lo]!) * (rank - lo);
}

export const median = (values: readonly number[]): number | null => percentile(values, 50);

export interface Summary { n: number; median: number | null; p90: number | null; mean: number | null; max: number | null }
export function summarise(values: readonly number[], decimals = 1): Summary {
  const v = values.filter((x) => Number.isFinite(x));
  const r = (x: number | null): number | null => (x === null ? null : round(x, decimals));
  return { n: v.length, median: r(median(v)), p90: r(percentile(v, 90)), mean: v.length ? r(sum(v) / v.length) : null, max: v.length ? r(Math.max(...v)) : null };
}

export function groupBy<T, K extends string>(rows: readonly T[], key: (row: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const r of rows) {
    const k = key(r);
    const cur = m.get(k);
    if (cur) cur.push(r); else m.set(k, [r]);
  }
  return m;
}

/** Index rows by id (or any key). */
export function indexBy<T, K extends string>(rows: readonly T[], key: (row: T) => K): Map<K, T> {
  const m = new Map<K, T>();
  for (const r of rows) m.set(key(r), r);
  return m;
}

/** Epoch milliseconds of an ISO string (timestamptz formats from Postgres and JS both parse). NaN-safe: returns null for empty/invalid. */
export function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

/** Split an array into chunks (for `in` lists that must stay URL-safe on Supabase). */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** ISO week-start (Monday, IST) label YYYY-MM-DD for a timestamp — used for weekly series. */
export function weekStartIst(t: number): string {
  const ist = new Date(t + 5.5 * HOUR);
  const dow = (ist.getUTCDay() + 6) % 7; // Monday = 0
  const monday = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() - dow));
  return monday.toISOString().slice(0, 10);
}
