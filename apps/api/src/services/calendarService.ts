import {
  CONFIDENCE_LABEL, daysBetween, formatDate, istDateString,
  type ComplianceCalendarItem, type Json, type NotificationSeverity, type PlatformCalendarItem, type PlatformUrgency,
} from '@solar/shared';
import type { z } from 'zod';
import type { platformCalendarCreateSchema, platformCalendarPatchSchema } from '@solar/shared';
import type { AppContext } from '../auth/context';
import { notFound } from '../http/errors';
import { audit } from '../lib/audit';

/** Roles told about compliance countdowns. */
export const CALENDAR_AUDIENCE = ['compliance_officer', 'management', 'admin'] as const;
const FALLBACK_ESCALATE_DAYS = [14, 7, 3];

export function countdownLabel(daysLeft: number): string {
  if (daysLeft > 1) return `${daysLeft} days left`;
  if (daysLeft === 1) return '1 day left';
  if (daysLeft === 0) return 'Due today';
  return daysLeft === -1 ? 'Overdue by 1 day' : `Overdue by ${-daysLeft} days`;
}
export const countdownShort = (daysLeft: number): string => (daysLeft > 0 ? `D-${daysLeft}` : daysLeft === 0 ? 'D-day' : `D+${-daysLeft}`);

export function urgencyFor(daysLeft: number): PlatformUrgency {
  if (daysLeft < 0) return 'overdue';
  if (daysLeft <= 3) return 'critical';
  if (daysLeft <= 14) return 'warning';
  return 'info';
}

export function toCalendarView(item: ComplianceCalendarItem, today: string): PlatformCalendarItem {
  const days = daysBetween(today, item.due_date);
  return {
    ...item, days_left: days, countdown_label: countdownLabel(days), countdown_short: countdownShort(days), urgency: urgencyFor(days),
    confidence_label: CONFIDENCE_LABEL[item.confidence], is_past: days < 0,
  };
}

export interface CalendarQuery { next?: number; upcoming?: boolean; category?: string; include_inactive?: boolean }

/** Calendar items with days_left / countdown / confidence tag, soonest first. `next=N` returns the next N upcoming items (the persistent strip). */
export async function listCalendar(ctx: AppContext, q: CalendarQuery = {}): Promise<PlatformCalendarItem[]> {
  const where: Record<string, string | boolean> = {};
  if (!q.include_inactive) where['active'] = true;
  if (q.category) where['category'] = q.category;
  const items = await ctx.db.table('compliance_calendar_items').all(where, { orderBy: [{ col: 'due_date', dir: 'asc' }, { col: 'title', dir: 'asc' }] });
  const today = istDateString(ctx.now());
  let views = items.map((i) => toCalendarView(i, today));
  if (q.upcoming || q.next) views = views.filter((v) => !v.is_past);
  return q.next ? views.slice(0, q.next) : views;
}

type CalendarCreate = z.output<typeof platformCalendarCreateSchema>;
type CalendarPatch = z.output<typeof platformCalendarPatchSchema>;

export async function createCalendarItem(ctx: AppContext, input: CalendarCreate): Promise<PlatformCalendarItem> {
  const escalate = input.escalate_days ?? (await ctx.svc.rules.value<number[]>('calendar.default_escalate_days', undefined, FALLBACK_ESCALATE_DAYS)) ?? FALLBACK_ESCALATE_DAYS;
  const row = await ctx.db.table('compliance_calendar_items').insert({
    due_date: input.due_date, title: input.title, description: input.description ?? null, category: input.category, confidence: input.confidence,
    source_ref: input.source_ref ?? null, escalate_days: [...escalate].sort((a, b) => b - a), rule_key: input.rule_key ?? null, active: input.active, created_by: ctx.user.id,
  });
  await audit(ctx, { action: 'calendar.create', table: 'compliance_calendar_items', record_id: row.id, new: row as unknown as Json });
  return toCalendarView(row, istDateString(ctx.now()));
}

export async function updateCalendarItem(ctx: AppContext, id: string, patch: CalendarPatch): Promise<PlatformCalendarItem> {
  const before = await ctx.db.table('compliance_calendar_items').get(id);
  if (!before) throw notFound('Calendar item');
  const clean: Partial<ComplianceCalendarItem> = {};
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) (clean as Record<string, unknown>)[k] = v;
  if (clean.escalate_days) clean.escalate_days = [...clean.escalate_days].sort((a, b) => b - a);
  const row = await ctx.db.table('compliance_calendar_items').update(id, clean);
  await audit(ctx, { action: 'calendar.update', table: 'compliance_calendar_items', record_id: id, old: before as unknown as Json, new: row as unknown as Json });
  return toCalendarView(row, istDateString(ctx.now()));
}

export async function deleteCalendarItem(ctx: AppContext, id: string): Promise<{ id: string }> {
  const before = await ctx.db.table('compliance_calendar_items').get(id);
  if (!before) throw notFound('Calendar item');
  await ctx.db.table('compliance_calendar_items').delete(id);
  await audit(ctx, { action: 'calendar.delete', table: 'compliance_calendar_items', record_id: id, old: before as unknown as Json });
  return { id };
}

/* ───────────── countdown notifications (nightly job) ───────────── */
const stageSeverity = (stageDays: number): NotificationSeverity => (stageDays <= 3 ? 'critical' : stageDays <= 7 ? 'warning' : 'info');

export interface CountdownResult {
  today: string; checked: number;
  notified: { item_id: string; title: string; stage_days: number; days_left: number; severity: NotificationSeverity; recipients: number }[];
  already_sent: number;
}

/**
 * Sends the D-14 / D-7 / D-3 style countdown notifications (points come from each item's `escalate_days`).
 * Idempotent: one notification set per item and stage, however many times the job runs. If a night was missed the
 * stage still fires the next time the job runs while the item is within that stage (the title shows the real days left).
 */
export async function runCalendarCountdown(ctx: AppContext): Promise<CountdownResult> {
  const today = istDateString(ctx.now());
  const items = await ctx.db.table('compliance_calendar_items').all({ active: true }, { orderBy: { col: 'due_date', dir: 'asc' } });
  const result: CountdownResult = { today, checked: items.length, notified: [], already_sent: 0 };
  for (const item of items) {
    const left = daysBetween(today, item.due_date);
    if (left < 0 || !item.escalate_days.length) continue;
    const stage = [...new Set(item.escalate_days)].sort((a, b) => a - b).find((d) => left <= d);
    if (stage === undefined) continue;
    const kind = `calendar.countdown.d${stage}`;
    if (await ctx.db.table('notifications').count({ kind, entity_type: 'compliance_calendar_item', entity_id: item.id })) { result.already_sent++; continue; }
    const severity = stageSeverity(stage);
    const recipients = await ctx.svc.notify.notify({
      roles: [...CALENDAR_AUDIENCE], kind, severity, entity_type: 'compliance_calendar_item', entity_id: item.id, link: '/calendar',
      title: `${item.title} — ${countdownLabel(left).toLowerCase()}`,
      body: `Due ${formatDate(item.due_date)} (${countdownShort(left)}). Confidence: ${CONFIDENCE_LABEL[item.confidence]}.${item.source_ref ? ` Source: ${item.source_ref}.` : ''} Verify against primary source before relying.`,
    });
    result.notified.push({ item_id: item.id, title: item.title, stage_days: stage, days_left: left, severity, recipients });
  }
  return result;
}
