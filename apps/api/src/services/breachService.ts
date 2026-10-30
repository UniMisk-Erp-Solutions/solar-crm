import { formatDateTime, formatDuration, type BreachIncident, type Clock, type NotificationSeverity } from '@solar/shared';
import type { z } from 'zod';
import type { platformBreachCloseSchema, platformBreachCreateSchema, platformBreachEvidenceSchema, platformBreachPatchSchema, platformBreachReportSchema } from '@solar/shared';
import type { AppContext } from '../auth/context';
import { badRequest, guardBlocked, invalidState, notFound } from '../http/errors';
import { audit } from '../lib/audit';

/** Rule dpdp.breach_report_hours (72 by default) — fallback used when the rule is absent or inactive. */
export const DEFAULT_BREACH_REPORT_HOURS = 72;
export const BREACH_AUDIENCE = ['compliance_officer', 'management', 'admin'] as const;
const FALLBACK_WATCH_HOURS = [24, 6];
const HOUR = 3_600_000;

/**
 * The shared clock enum has no dedicated breach type, so the 72-hour timer is a `grievance`-type clock on
 * entity_type `breach_incident` with `meta.kind = 'dpdp_breach_report'` and its own label (see docs/api/platform-admin.md).
 */
const CLOCK_TYPE = 'grievance' as const;
const ENTITY = 'breach_incident';

export interface BreachView extends BreachIncident {
  hours_left: number; overdue: boolean; countdown_label: string; clock: Clock | null;
}

function viewOf(ctx: AppContext, b: BreachIncident, clock: Clock | null): BreachView {
  const open = b.status === 'open';
  const ms = new Date(b.report_due_at).getTime() - (b.reported_at && !open ? new Date(b.reported_at).getTime() : ctx.now().getTime());
  const hoursLeft = Math.round((ms / HOUR) * 10) / 10;
  const label = b.status === 'open'
    ? (ms >= 0 ? `${formatDuration(ms)} left to report` : `Overdue by ${formatDuration(-ms)}`)
    : b.status === 'reported' ? (ms >= 0 ? `Reported ${formatDuration(ms)} before the deadline` : `Reported ${formatDuration(-ms)} after the deadline`) : 'Closed';
  return { ...b, hours_left: hoursLeft, overdue: open && ms < 0, countdown_label: label, clock };
}

async function clockFor(ctx: AppContext, id: string): Promise<Clock | null> {
  const clocks = await ctx.svc.clocks.forEntity(ENTITY, id);
  return clocks.find((c) => c.clock_type === CLOCK_TYPE) ?? null;
}

async function load(ctx: AppContext, id: string): Promise<BreachIncident> {
  const b = await ctx.db.table('breach_incidents').get(id);
  if (!b) throw notFound('Breach incident');
  return b;
}

const entry = (ctx: AppContext, note: string, at?: string): BreachIncident['evidence'][number] => ({ at: at ?? ctx.now().toISOString(), by: ctx.system ? null : ctx.user.id, note });

export async function createBreach(ctx: AppContext, input: z.output<typeof platformBreachCreateSchema>): Promise<BreachView> {
  const now = ctx.now();
  const detected = input.detected_at ? new Date(input.detected_at) : now;
  if (detected.getTime() > now.getTime() + 5 * 60_000) throw badRequest('The detection time cannot be in the future');
  const hours = Math.max(1, (await ctx.svc.rules.value<number>('dpdp.breach_report_hours', detected, DEFAULT_BREACH_REPORT_HOURS)) ?? DEFAULT_BREACH_REPORT_HOURS);
  const dueAt = new Date(detected.getTime() + hours * HOUR);
  const evidence = [entry(ctx, `Incident logged. Reporting deadline: ${hours} hours from detection (${formatDateTime(dueAt)}).`)];
  if (input.evidence_note) evidence.push(entry(ctx, input.evidence_note));
  const row = await ctx.db.table('breach_incidents').insert({
    title: input.title, description: input.description ?? null, detected_at: detected.toISOString(), report_due_at: dueAt.toISOString(), status: 'open', evidence, reported_at: null, created_by: ctx.user.id,
  });
  const clock = await ctx.svc.clocks.start({
    entity_type: ENTITY, entity_id: row.id, clock_type: CLOCK_TYPE, started_at: detected, due_at: dueAt, owner_id: ctx.system ? null : ctx.user.id,
    meta: { kind: 'dpdp_breach_report', label: `DPDP breach report (${hours} h)` },
  });
  await audit(ctx, { action: 'breach.create', table: 'breach_incidents', record_id: row.id, detail: { report_due_at: row.report_due_at, hours } });
  await ctx.svc.notify.notify({
    roles: [...BREACH_AUDIENCE], kind: 'breach.opened', severity: 'critical', entity_type: ENTITY, entity_id: row.id, link: '/admin/breaches',
    title: `Personal data breach logged — report within ${hours} hours`, body: `${row.title}. Reporting deadline ${formatDateTime(dueAt)}.`,
  });
  return viewOf(ctx, row, clock);
}

export async function listBreaches(ctx: AppContext, q: { status?: BreachIncident['status']; overdue?: boolean; limit: number; offset: number }): Promise<{ rows: BreachView[]; total: number }> {
  const where = q.status ? { status: q.status } : {};
  const order = { col: 'detected_at', dir: 'desc' as const };
  // 'overdue' is computed from the clock, so filter in memory before paginating
  const { rows, total } = q.overdue === undefined
    ? await ctx.db.table('breach_incidents').list({ where, orderBy: order, limit: q.limit, offset: q.offset })
    : await ctx.db.table('breach_incidents').list({ where, orderBy: order });
  const clocks = rows.length ? await ctx.db.table('clocks').all({ entity_type: ENTITY, entity_id: rows.map((r) => r.id) }) : [];
  let views = rows.map((r) => viewOf(ctx, r, clocks.find((c) => c.entity_id === r.id && c.clock_type === CLOCK_TYPE) ?? null));
  if (q.overdue === undefined) return { rows: views, total };
  views = views.filter((v) => v.overdue === q.overdue);
  return { rows: views.slice(q.offset, q.offset + q.limit), total: views.length };
}

export async function getBreach(ctx: AppContext, id: string): Promise<BreachView> {
  const b = await load(ctx, id);
  return viewOf(ctx, b, await clockFor(ctx, id));
}

export async function patchBreach(ctx: AppContext, id: string, patch: z.output<typeof platformBreachPatchSchema>): Promise<BreachView> {
  const before = await load(ctx, id);
  if (before.status === 'closed') throw invalidState('A closed incident can no longer be edited');
  const clean: Partial<BreachIncident> = {};
  if (patch.title !== undefined) clean.title = patch.title;
  if (patch.description !== undefined) clean.description = patch.description;
  const row = await ctx.db.table('breach_incidents').update(id, clean);
  await audit(ctx, { action: 'breach.update', table: 'breach_incidents', record_id: id, detail: { fields: Object.keys(clean) } });
  return viewOf(ctx, row, await clockFor(ctx, id));
}

export async function addEvidence(ctx: AppContext, id: string, input: z.output<typeof platformBreachEvidenceSchema>): Promise<BreachView> {
  const before = await load(ctx, id);
  if (before.status === 'closed') throw invalidState('A closed incident can no longer take new evidence');
  const row = await ctx.db.table('breach_incidents').update(id, { evidence: [...before.evidence, entry(ctx, input.note)] });
  await audit(ctx, { action: 'breach.evidence', table: 'breach_incidents', record_id: id, detail: { entries: row.evidence.length } });
  return viewOf(ctx, row, await clockFor(ctx, id));
}

/** open → reported. Completes the countdown clock. */
export async function markReported(ctx: AppContext, id: string, input: z.output<typeof platformBreachReportSchema>): Promise<BreachView> {
  const before = await load(ctx, id);
  if (before.status !== 'open') throw invalidState(`This incident is already ${before.status}`);
  const reportedAt = input.reported_at ? new Date(input.reported_at) : ctx.now();
  if (reportedAt.getTime() > ctx.now().getTime() + 5 * 60_000) throw badRequest('The report time cannot be in the future');
  const late = reportedAt.getTime() > new Date(before.report_due_at).getTime();
  const evidence = [...before.evidence, entry(ctx, `Reported to the Data Protection Board${input.reference ? ` — reference ${input.reference}` : ''}${late ? ' (after the deadline)' : ''}.`, reportedAt.toISOString())];
  if (input.note) evidence.push(entry(ctx, input.note));
  const row = await ctx.db.table('breach_incidents').update(id, { status: 'reported', reported_at: reportedAt.toISOString(), evidence });
  await ctx.svc.clocks.complete(ENTITY, id, CLOCK_TYPE, { reported_at: row.reported_at, late });
  await audit(ctx, { action: 'breach.report', table: 'breach_incidents', record_id: id, detail: { late, reference: input.reference ?? null } });
  return viewOf(ctx, row, await clockFor(ctx, id));
}

/** reported → closed. An incident still open can be closed only with a written reason (assessed as not reportable). */
export async function closeBreach(ctx: AppContext, id: string, input: z.output<typeof platformBreachCloseSchema>): Promise<BreachView> {
  const before = await load(ctx, id);
  if (before.status === 'closed') throw invalidState('This incident is already closed');
  if (before.status === 'open' && !input.reason) throw guardBlocked('Report the incident first, or give the reason it was assessed as not reportable');
  const evidence = [...before.evidence, entry(ctx, before.status === 'open' ? `Closed without a Board report — ${input.reason}` : `Incident closed${input.reason ? ` — ${input.reason}` : ''}.`)];
  const row = await ctx.db.table('breach_incidents').update(id, { status: 'closed', evidence });
  await ctx.svc.clocks.cancel(ENTITY, id, CLOCK_TYPE);
  await audit(ctx, { action: 'breach.close', table: 'breach_incidents', record_id: id, detail: { from: before.status, reason: input.reason ?? null } });
  return viewOf(ctx, row, await clockFor(ctx, id));
}

/* ───────────── notification draft ───────────── */
export interface BreachDraft { subject: string; body: string; source: 'template' | 'default'; template_key: string | null; report_due_at: string; hours_left: number }

const fill = (tpl: string, vars: Record<string, string>): string => tpl.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k: string) => vars[k] ?? m);

/**
 * A ready-to-edit intimation for the Data Protection Board and affected data principals. Uses the active e-mail template
 * with key `breach.notification` when the company has written one (Admin → Templates), otherwise a built-in default.
 */
export async function breachDraft(ctx: AppContext, id: string): Promise<BreachDraft> {
  const b = await load(ctx, id);
  const view = viewOf(ctx, b, null);
  const evidence = b.evidence.map((e) => `- ${formatDateTime(e.at)}: ${e.note}`).join('\n');
  const vars = {
    title: b.title, description: b.description ?? 'To be completed', detected_at: formatDateTime(b.detected_at), report_due_at: formatDateTime(b.report_due_at),
    evidence, hours_left: String(view.hours_left),
  };
  const tpl = await ctx.db.table('message_templates').one({ key: 'breach.notification', channel: 'email', active: true });
  if (tpl) return { subject: fill(tpl.subject ?? `Personal data breach — ${b.title}`, vars), body: fill(tpl.body, vars), source: 'template', template_key: tpl.key, report_due_at: b.report_due_at, hours_left: view.hours_left };
  const body = [
    'DRAFT — review with the Data Protection Officer / counsel before sending.',
    '',
    `Incident: ${b.title}`,
    `Detected: ${vars.detected_at}`,
    `Reporting deadline: ${vars.report_due_at}`,
    '',
    'Nature, extent and timing of the breach:',
    vars.description,
    '',
    'Likely impact on affected data principals:',
    'To be completed.',
    '',
    'Measures taken and proposed to contain and mitigate the breach:',
    'To be completed.',
    '',
    'Evidence log:',
    evidence,
    '',
    'Contact for queries: the Data Protection Officer, Future Solar.',
  ].join('\n');
  return { subject: `Personal data breach intimation — ${b.title}`, body, source: 'default', template_key: null, report_due_at: b.report_due_at, hours_left: view.hours_left };
}

/* ───────────── deadline watch (hourly job) ───────────── */
export interface BreachWatchResult { open: number; notified: { incident_id: string; kind: string; hours_left: number }[]; already_sent: number }

/** Warns compliance as the reporting deadline of every still-open incident approaches (rule breach.watch_hours, default 24 h and 6 h) and once when it is overdue. */
export async function runBreachWatch(ctx: AppContext): Promise<BreachWatchResult> {
  const open = await ctx.db.table('breach_incidents').all({ status: 'open' });
  const stages = [...((await ctx.svc.rules.value<number[]>('breach.watch_hours', undefined, FALLBACK_WATCH_HOURS)) ?? FALLBACK_WATCH_HOURS)].sort((a, b) => a - b);
  const result: BreachWatchResult = { open: open.length, notified: [], already_sent: 0 };
  for (const b of open) {
    const left = (new Date(b.report_due_at).getTime() - ctx.now().getTime()) / HOUR;
    const stage = left <= 0 ? 0 : stages.find((h) => left <= h);
    if (stage === undefined) continue;
    const kind = stage === 0 ? 'breach.overdue' : `breach.watch.h${stage}`;
    if (await ctx.db.table('notifications').count({ kind, entity_type: ENTITY, entity_id: b.id })) { result.already_sent++; continue; }
    const severity: NotificationSeverity = stage <= 6 ? 'critical' : 'warning';
    await ctx.svc.notify.notify({
      roles: [...BREACH_AUDIENCE], kind, severity, entity_type: ENTITY, entity_id: b.id, link: '/admin/breaches',
      title: stage === 0 ? `Breach report overdue — ${b.title}` : `Breach report due in ${formatDuration(left * HOUR)} — ${b.title}`,
      body: `The Data Protection Board must be informed by ${formatDateTime(b.report_due_at)}.`,
    });
    result.notified.push({ incident_id: b.id, kind, hours_left: Math.round(left * 10) / 10 });
  }
  return result;
}

