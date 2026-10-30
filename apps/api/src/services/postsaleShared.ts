/**
 * Small helpers shared by the post-sale and channel services: rule look-ups with documented fallbacks,
 * calendar-day arithmetic in IST, "notify once" and basic statistics.
 */
import { istDateString, type AppRole, type Json, type TableName, type TableRow } from '@solar/shared';
import type { AppContext } from '../auth/context';
import { istEndOfDay } from '../lib/time';
import type { NotifyInput } from './contracts';

/** Roles that administer the channel (distributors, dealers, vendor registrations, SOP cases, receivables). `admin` is always allowed. */
export const CHANNEL_ADMIN_ROLES: AppRole[] = ['accounts', 'management', 'sales_manager', 'dsm', 'regional_head'];
/** Roles that record installations, DISCOM, subsidy and warranty work. */
export const FIELD_ROLES: AppRole[] = ['dispatch', 'techno_commercial', 'dealer_user', 'distributor_user'];
export const POSTSALE_WRITE_ROLES: AppRole[] = [...CHANNEL_ADMIN_ROLES, ...FIELD_ROLES];

export const actorId = (ctx: AppContext): string | null => (ctx.system ? null : ctx.user.id);
export const isExternal = (ctx: AppContext): boolean => ctx.user.role === 'distributor_user' || ctx.user.role === 'dealer_user';

/* ───────────── rule look-ups ───────────── */
/**
 * rule      — an ACTIVE rule supplied the value
 * default   — the rule row does not exist; the documented fallback was used
 * inactive  — the rule exists but is inactive (advisory only): no value, the caller must skip the behaviour and warn
 * missing   — no rule and no fallback
 */
export type RuleBasis = 'rule' | 'default' | 'inactive' | 'missing';
export interface RuleNumber { path: string; value: number | null; basis: RuleBasis; rule_id: string | null; warning: string | null }
export interface RuleText { path: string; value: string | null; basis: RuleBasis; rule_id: string | null; warning: string | null }

function unusable(path: string, basis: RuleBasis, rule_id: string | null, what: string): { warning: string } & { basis: RuleBasis; rule_id: string | null; path: string } {
  return { path, basis, rule_id, warning: basis === 'inactive' ? `Rule ${path} is not active — ${what}` : `Rule ${path} is not configured — ${what}` };
}

export async function ruleNumber(ctx: AppContext, path: string, fallback: number | null, what: string, ref?: Date | string): Promise<RuleNumber> {
  const r = await ctx.svc.rules.path(path, ref);
  if (r) {
    if (!r.isActive) return { value: null, ...unusable(path, 'inactive', r.id, what) };
    if (typeof r.value === 'number' && Number.isFinite(r.value)) return { path, value: r.value, basis: 'rule', rule_id: r.id, warning: null };
    return { value: null, ...unusable(path, 'missing', r.id, what) };
  }
  if (fallback === null) return { value: null, ...unusable(path, 'missing', null, what) };
  return { path, value: fallback, basis: 'default', rule_id: null, warning: null };
}

export async function ruleDate(ctx: AppContext, path: string, what: string, ref?: Date | string): Promise<RuleText> {
  const r = await ctx.svc.rules.path(path, ref);
  if (!r) return { value: null, ...unusable(path, 'missing', null, what) };
  if (!r.isActive) return { value: null, ...unusable(path, 'inactive', r.id, what) };
  if (typeof r.value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(r.value)) return { path, value: r.value.slice(0, 10), basis: 'rule', rule_id: r.id, warning: null };
  return { value: null, ...unusable(path, 'missing', r.id, what) };
}

/** Active rule value as a plain object (null when absent, inactive or not an object). */
export async function ruleObject(ctx: AppContext, path: string, ref?: Date | string): Promise<Record<string, Json> | null> {
  const v = await ctx.svc.rules.value<Json>(path, ref);
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, Json>) : null;
}

/* ───────────── dates (IST calendar) ───────────── */
export const istDay = (d: Date | string): string => istDateString(typeof d === 'string' ? new Date(d) : d);

/** YYYY-MM-DD plus whole calendar days. */
export function addCalendarDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** YYYY-MM-DD plus whole months (day clamped to the end of a shorter month). */
export function addCalendarMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(d, last))).toISOString().slice(0, 10);
}

/** "Within N days": the end of the IST calendar day that is N days after `from`. */
export function dueAfterDays(from: Date | string, days: number): Date {
  return istEndOfDay(addCalendarDays(istDay(from), days));
}

/** First day of a reporting period containing `d` (IST): month, quarter or Indian financial year (1 April). */
export function periodBounds(d: Date, period: 'month' | 'quarter' | 'fy'): { start: string; end: string } {
  const [y, m] = istDay(d).split('-').map(Number) as [number, number];
  const pad = (n: number) => String(n).padStart(2, '0');
  if (period === 'month') return { start: `${y}-${pad(m)}-01`, end: addCalendarDays(`${m === 12 ? y + 1 : y}-${pad(m === 12 ? 1 : m + 1)}-01`, -1) };
  if (period === 'quarter') {
    const qStartMonth = Math.floor((m - 1) / 3) * 3 + 1;
    const nextQ = qStartMonth + 3;
    return { start: `${y}-${pad(qStartMonth)}-01`, end: addCalendarDays(`${nextQ > 12 ? y + 1 : y}-${pad(nextQ > 12 ? nextQ - 12 : nextQ)}-01`, -1) };
  }
  const fyStartYear = m >= 4 ? y : y - 1;
  return { start: `${fyStartYear}-04-01`, end: `${fyStartYear + 1}-03-31` };
}

/* ───────────── notifications ───────────── */
/** Notify unless an identical notification (same kind + entity) was already created within `windowDays` — keeps nightly jobs from repeating themselves. */
export async function notifyOnce(ctx: AppContext, input: NotifyInput, windowDays = 7): Promise<number> {
  if (input.entity_id) {
    const since = new Date(ctx.now().getTime() - windowDays * 86400000).toISOString();
    const recent = await ctx.db.table('notifications').count({ kind: input.kind, entity_id: input.entity_id, created_at: { gte: since } });
    if (recent > 0) return 0;
  }
  return ctx.svc.notify.notify(input);
}

/* ───────────── statistics ───────────── */
export const round1 = (n: number): number => Math.round(n * 10) / 10;
export const round2 = (n: number): number => Math.round(n * 100) / 100;

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Nearest-rank percentile (p in 0–100). */
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}

export const daysFractional = (from: string, to: string): number => (new Date(to).getTime() - new Date(from).getTime()) / 86400000;

/** Distinct, non-null ids. */
export const uniq = (ids: (string | null | undefined)[]): string[] => [...new Set(ids.filter((x): x is string => !!x))];

/** Rows by id (empty id list → no query). */
export async function loadByIds<K extends TableName>(ctx: AppContext, table: K, ids: (string | null | undefined)[]): Promise<TableRow<K>[]> {
  const list = uniq(ids);
  return list.length ? ctx.db.table(table).all({ id: list }) : [];
}
export const mapById = <T extends { id: string }>(rows: T[]): Map<string, T> => new Map(rows.map((r) => [r.id, r]));
