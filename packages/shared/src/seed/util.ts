import { DEMO_ORG_ID, seedId } from '../ids';
import { istDateString } from '../format';
import type { Base } from '../rows';

/**
 * Everything in the seed is expressed relative to one anchor instant (`now`), so a given anchor always yields byte-identical data.
 * `t(-30)` = thirty minutes ago, `d(3)` = the IST calendar date three days from now.
 */
export interface SeedEnv {
  now: Date;
  org: string;
  /** ISO-8601 UTC timestamp `minutes` from the anchor (negative = in the past). */
  t(minutes: number): string;
  /** `YYYY-MM-DD` (IST calendar date) `days` from the anchor. */
  d(days: number): string;
}

export const MIN = 1;
export const HOUR = 60;
export const DAY = 1440;

export function makeEnv(now: Date): SeedEnv {
  const base = now.getTime();
  return {
    now,
    org: DEMO_ORG_ID,
    t: (minutes) => new Date(base + minutes * 60_000).toISOString(),
    d: (days) => istDateString(new Date(base + days * 86_400_000)),
  };
}

/** Ids for demo rows. Distinct namespace from reference ids so the delete script can never touch reference data. */
export const demoId = (kind: string, n: number): string => seedId(`demo:${kind}`, n);
/** Ids for reference (production-safe) rows. */
export const refId = (kind: string, n: number): string => seedId(`ref:${kind}`, n);

/** Standard columns of a mutable table. `ageMinutes` = how long ago the row was created. */
export function baseOf(env: SeedEnv, id: string, ageMinutes = 0, createdBy: string | null = null): Base {
  return { id, org_id: env.org, created_at: env.t(-ageMinutes), updated_at: env.t(-Math.floor(ageMinutes / 2)), created_by: createdBy };
}

export const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Adds whole days to a `YYYY-MM-DD` date string (UTC arithmetic — dates carry no time zone). */
export function addDaysTo(date: string, days: number): string {
  const ms = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** The later of two `YYYY-MM-DD` dates. */
export const laterOf = (a: string, b: string): string => (a >= b ? a : b);
/** The earlier of two `YYYY-MM-DD` dates. */
export const earlierOf = (a: string, b: string): string => (a <= b ? a : b);

/** Builds `{ key: seedId(namespace, index+1) }` for a fixed list of keys, preserving literal key types. */
export function named<const K extends readonly string[]>(kind: string, keys: K): { [P in K[number]]: string } {
  const out: Record<string, string> = {};
  keys.forEach((k, i) => { out[k] = demoId(kind, i + 1); });
  return out as { [P in K[number]]: string };
}

/** `+91` + a fictional 10-digit number built from an obviously fake 90000xxxxx block. */
export const fakeMobile = (n: number): string => `+9190000${String(10000 + n).slice(-5)}`;
