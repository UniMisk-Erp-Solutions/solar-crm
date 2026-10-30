/**
 * Platform routes: /rules, /clocks, /notifications, /calendar, /verify-register.
 * Rule changes are limited to compliance_officer + admin; everything else is read-only for other internal roles.
 */
import { Router } from 'express';
import {
  entityPath, istDateString, platformCalendarCreateSchema, platformCalendarListQuerySchema, platformCalendarPatchSchema, platformClockListQuerySchema,
  platformNotificationListQuerySchema, platformRuleActivateSchema, platformRuleCreateSchema, platformRuleDiffQuerySchema, platformRuleHistoryQuerySchema,
  platformRuleListQuerySchema, platformRulePatchSchema, platformRuleResolveQuerySchema, platformVerifyPatchSchema, platformVerifyQuerySchema, splitRulePath,
  type Clock, type Json, type PlatformClockView, type PlatformRuleDiff, type PlatformRuleEffect, type PlatformRuleResolution, type RuleConfig, type RuleStatus, type Severity,
  type VerifyRegisterItem,
} from '@solar/shared';
import { allow, INTERNAL_ONLY } from '../auth/authorize';
import type { AppContext } from '../auth/context';
import type { Where } from '../db/types';
import { AppError, conflict, guardBlocked, notFound } from '../http/errors';
import { runList } from '../http/crud';
import { body, handle, param, query, respondPage, wrap } from '../http/handler';
import { audit } from '../lib/audit';
import { toRuleRows } from '../services/adminService';
import { createCalendarItem, deleteCalendarItem, listCalendar, updateCalendarItem } from '../services/calendarService';
import { CLOCK_LABEL } from '../services/clockService';
import { assertEntityAccess } from '../services/documentService';
import { decideSeverity } from '../services/severity';

const router = Router();
const COMPLIANCE = allow('compliance_officer');
const READERS = allow(...INTERNAL_ONLY);

const fieldError = (path: string, message: string) => new AppError(422, 'VALIDATION_ERROR', 'Please check the highlighted fields', [{ path, message }]);

/* ═════════════════════════ rules ═════════════════════════ */
/** An unverified or conflicting rule may block only when a compliance officer asks for a hard stop explicitly. */
function assertHardStopConsent(status: RuleStatus, maxSeverity: Severity | undefined, enforce: boolean | undefined): void {
  if (status !== 'verified' && maxSeverity === 'hard_stop' && enforce !== true) {
    throw guardBlocked(`This rule is ${status}. To let it block transactions as a hard stop, confirm explicitly with enforce_hard_stop: true.`, { code: 'HARD_STOP_NEEDS_CONFIRMATION', status });
  }
}

const RULE_DIFF_FIELDS = ['category', 'key', 'value', 'effective_from', 'effective_to', 'source_name', 'source_ref', 'confidence', 'status', 'is_active', 'max_severity', 'enforce_hard_stop', 'notes'] as const;
const isObj = (v: Json | undefined): v is { [k: string]: Json } => typeof v === 'object' && v !== null && !Array.isArray(v);

function diffJson(a: Json | undefined, b: Json | undefined, path: string, out: PlatformRuleDiff['value_changes']): void {
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  if (isObj(a) && isObj(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffJson(a[k], b[k], path ? `${path}.${k}` : k, out);
  } else if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) diffJson(a[i], b[i], `${path}[${i}]`, out);
  } else out.push({ path: path || '(value)', a, b });
}

function diffRules(a: RuleConfig, b: RuleConfig): PlatformRuleDiff {
  const changes: PlatformRuleDiff['changes'] = [];
  for (const f of RULE_DIFF_FIELDS) {
    const av = a[f] as Json | undefined, bv = b[f] as Json | undefined;
    if (JSON.stringify(av) !== JSON.stringify(bv)) changes.push({ field: f, a: av, b: bv });
  }
  const value_changes: PlatformRuleDiff['value_changes'] = [];
  diffJson(a.value, b.value, '', value_changes);
  return { a, b, identical: changes.length === 0, changes, value_changes };
}

router.get('/rules', READERS, wrap(async (req, res) => {
  const ctx = req.ctx!;
  const q = query(platformRuleListQuerySchema, req);
  const on = q.date ?? istDateString(ctx.now());
  let rows = toRuleRows(await ctx.svc.rules.list({ category: q.category, status: q.status, active: q.active, q: q.q }), on);
  if (q.current) rows = rows.filter((r) => r.in_force);
  respondPage(res, rows.slice(q.offset, q.offset + q.limit), rows.length, q.limit, q.offset);
}));

router.get('/rules/resolve', READERS, handle(async (ctx, req): Promise<PlatformRuleResolution> => {
  const q = query(platformRuleResolveQuerySchema, req);
  const date = q.date ?? istDateString(ctx.now());
  const rule = await ctx.svc.rules.path(q.path, date);
  const decision = rule ? decideSeverity(rule, 'hard_stop') : null;
  const effect: PlatformRuleEffect = !rule ? 'none' : !rule.isActive ? 'inactive' : decision?.advisory ? 'advisory' : 'active';
  const message = {
    none: `No version of ${q.path} covers ${date}; the engine uses the documented default written in code (or skips the check).`,
    inactive: `The version from ${rule?.effective_from} is inactive: reference data only, it never changes a transaction.`,
    advisory: `The version from ${rule?.effective_from} is active but ${rule?.status}: it may raise warnings, never a hard stop, until it is verified or enforced.`,
    active: `The version from ${rule?.effective_from} is verified and active: the engine uses it (maximum severity ${decision?.severity}).`,
  }[effect];
  return { path: q.path, date, found: !!rule, rule, effect, max_effective_severity: decision && effect !== 'inactive' ? decision.severity : null, message };
}));

router.get('/rules/history', READERS, handle(async (ctx, req) => {
  const q = query(platformRuleHistoryQuerySchema, req);
  const { category, key } = q.path ? splitRulePath(q.path) : { category: q.category!, key: q.key! };
  return toRuleRows(await ctx.svc.rules.history(category, key), istDateString(ctx.now()));
}));

router.get('/rules/diff', READERS, handle(async (ctx, req) => {
  const q = query(platformRuleDiffQuerySchema, req);
  const [a, b] = await Promise.all([ctx.db.table('rule_config').get(q.a), ctx.db.table('rule_config').get(q.b)]);
  if (!a || !b) throw notFound('Rule version');
  return diffRules(a, b);
}));

router.get('/rules/:id', READERS, handle(async (ctx, req) => {
  const row = await ctx.db.table('rule_config').get(param(req, 'id'));
  if (!row) throw notFound('Rule version');
  return toRuleRows([row], istDateString(ctx.now()))[0];
}));

router.post('/rules', COMPLIANCE, handle(async (ctx, req, res) => {
  const b = body(platformRuleCreateSchema, req);
  const { category, key } = b.path ? splitRulePath(b.path) : { category: b.category!, key: b.key! };
  const maxSeverity = b.max_severity ?? (b.enforce_hard_stop ? 'hard_stop' : undefined);
  assertHardStopConsent(b.status, maxSeverity, b.enforce_hard_stop);
  if ((await ctx.svc.rules.history(category, key)).some((r) => r.effective_from === b.effective_from)) {
    throw conflict(`A version of ${category}.${key} already starts on ${b.effective_from} — edit that version instead`);
  }
  const row = await ctx.svc.rules.createVersion({
    category, key, value: b.value, effective_from: b.effective_from, effective_to: b.effective_to ?? null, source_name: b.source_name, source_ref: b.source_ref, confidence: b.confidence,
    status: b.status, is_active: b.is_active, max_severity: maxSeverity, enforce_hard_stop: b.enforce_hard_stop, notes: b.notes ?? null,
  });
  res.status(201).json({ data: toRuleRows([row], istDateString(ctx.now()))[0] });
}));

router.patch('/rules/:id', COMPLIANCE, handle(async (ctx, req) => {
  const id = param(req, 'id');
  const patch = body(platformRulePatchSchema, req);
  const cur = await ctx.db.table('rule_config').get(id);
  if (!cur) throw notFound('Rule version');
  assertHardStopConsent(patch.status ?? cur.status, patch.max_severity, patch.enforce_hard_stop ?? cur.enforce_hard_stop);
  if (patch.effective_from && patch.effective_from !== cur.effective_from) {
    const clash = (await ctx.svc.rules.history(cur.category, cur.key)).find((r) => r.id !== id && r.effective_from === patch.effective_from);
    if (clash) throw conflict(`Another version of ${cur.category}.${cur.key} already starts on ${patch.effective_from}`);
  }
  const clean: Parameters<typeof ctx.svc.rules.update>[1] = {};
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) (clean as Record<string, unknown>)[k] = v;
  const row = await ctx.svc.rules.update(id, clean);
  return toRuleRows([row], istDateString(ctx.now()))[0];
}));

router.post('/rules/:id/activate', COMPLIANCE, handle(async (ctx, req) => {
  const id = param(req, 'id');
  const b = body(platformRuleActivateSchema, req);
  const cur = await ctx.db.table('rule_config').get(id);
  if (!cur) throw notFound('Rule version');
  assertHardStopConsent(cur.status, b.max_severity, b.enforce_hard_stop);
  const row = await ctx.svc.rules.setActive(id, true, { enforceHardStop: b.enforce_hard_stop, maxSeverity: b.max_severity });
  if (b.enforce_hard_stop && cur.status !== 'verified') {
    await audit(ctx, { action: 'rule.hard_stop_enforced', table: 'rule_config', record_id: id, detail: { status: cur.status, confidence: cur.confidence, reason: b.reason ?? null } });
  }
  return toRuleRows([row], istDateString(ctx.now()))[0];
}));

router.post('/rules/:id/deactivate', COMPLIANCE, handle(async (ctx, req) => {
  const id = param(req, 'id');
  if (!(await ctx.db.table('rule_config').get(id))) throw notFound('Rule version');
  const row = await ctx.svc.rules.setActive(id, false, { enforceHardStop: false });
  return toRuleRows([row], istDateString(ctx.now()))[0];
}));

/* ═════════════════════════ clocks ═════════════════════════ */
async function hydrateClocks(ctx: AppContext, clocks: Clock[]): Promise<PlatformClockView[]> {
  const ownerIds = [...new Set(clocks.map((c) => c.owner_id).filter((x): x is string => !!x))];
  const owners = ownerIds.length ? await ctx.db.table('profiles').all({ id: ownerIds }) : [];
  const now = ctx.now().getTime();
  return clocks.map((c) => {
    const start = new Date(c.started_at).getTime(), due = new Date(c.due_at).getTime();
    const label = c.meta && typeof c.meta === 'object' && !Array.isArray(c.meta) && typeof c.meta['label'] === 'string' ? (c.meta['label'] as string) : CLOCK_LABEL[c.clock_type];
    return {
      ...c, label, entity_link: entityPath(c.entity_type, c.entity_id), owner_name: owners.find((o) => o.id === c.owner_id)?.full_name ?? null,
      remaining_minutes: Math.round((due - now) / 60000), percent_used: due > start ? Math.max(0, Math.round(((now - start) / (due - start)) * 100)) : 100, breached: c.status === 'breached',
    };
  });
}

router.get('/clocks', READERS, wrap(async (req, res) => {
  const ctx = req.ctx!;
  const q = query(platformClockListQuerySchema, req);
  const base: Where = {};
  if (q.entity) base['entity_type'] = q.entity;
  if (q.entity_id) base['entity_id'] = q.entity_id;
  if (q.type) base['clock_type'] = q.type;
  if (q.status) base['status'] = q.status;
  else if (q.breached !== undefined) base['status'] = q.breached ? 'breached' : { neq: 'breached' };
  if (q.owner) base['owner_id'] = q.owner === 'me' ? ctx.user.id : q.owner;
  if (q.open) base['resolved_at'] = null;
  const page = await runList<Clock>(ctx, req, { table: 'clocks', baseWhere: base, sortCols: ['due_at', 'started_at', 'status', 'escalated_level', 'clock_type'], defaultSort: { col: 'due_at', dir: 'asc' } });
  respondPage(res, await hydrateClocks(ctx, page.rows), page.total, page.limit, page.offset);
}));

router.get('/clocks/entity/:type/:id', READERS, handle(async (ctx, req) => {
  const type = param(req, 'type'), id = param(req, 'id');
  await assertEntityAccess(ctx, type, id, 'read');
  return hydrateClocks(ctx, await ctx.svc.clocks.forEntity(type, id));
}));

/* ═════════════════════════ notifications (always the caller's own) ═════════════════════════ */
router.get('/notifications/unread-count', handle(async (ctx) => ({ count: await ctx.db.table('notifications').count({ user_id: ctx.user.id, read_at: null }) })));

router.get('/notifications', wrap(async (req, res) => {
  const ctx = req.ctx!;
  const q = query(platformNotificationListQuerySchema, req);
  const where: Where = { user_id: ctx.user.id };
  if (q.unread === true) where['read_at'] = null;
  if (q.unread === false) where['read_at'] = { is_null: false };
  if (q.severity) where['severity'] = q.severity;
  if (q.kind) where['kind'] = { ilike: `${q.kind.replace(/[%_\\]/g, '')}%` };
  const { rows, total } = await ctx.db.table('notifications').list({ where, orderBy: { col: 'created_at', dir: 'desc' }, limit: q.limit, offset: q.offset });
  respondPage(res, rows, total, q.limit, q.offset);
}));

router.post('/notifications/read-all', handle(async (ctx) => {
  const done = await ctx.db.table('notifications').updateWhere({ user_id: ctx.user.id, read_at: null }, { read_at: ctx.now().toISOString() });
  return { updated: done.length };
}));

router.post('/notifications/:id/read', handle(async (ctx, req) => {
  const row = await ctx.db.table('notifications').get(param(req, 'id'));
  if (!row || row.user_id !== ctx.user.id) throw notFound('Notification');
  return row.read_at ? row : ctx.db.table('notifications').update(row.id, { read_at: ctx.now().toISOString() });
}));

/* ═════════════════════════ compliance calendar ═════════════════════════ */
router.get('/calendar', handle(async (ctx, req) => listCalendar(ctx, query(platformCalendarListQuerySchema, req))));

router.post('/calendar', COMPLIANCE, handle(async (ctx, req, res) => {
  res.status(201).json({ data: await createCalendarItem(ctx, body(platformCalendarCreateSchema, req)) });
}));
router.patch('/calendar/:id', COMPLIANCE, handle(async (ctx, req) => updateCalendarItem(ctx, param(req, 'id'), body(platformCalendarPatchSchema, req))));
router.delete('/calendar/:id', COMPLIANCE, handle(async (ctx, req) => deleteCalendarItem(ctx, param(req, 'id'))));

/* ═════════════════════════ verify-before-relying register ═════════════════════════ */
router.get('/verify-register', READERS, wrap(async (req, res) => {
  const ctx = req.ctx!;
  const q = query(platformVerifyQuerySchema, req);
  const where: Where = {};
  if (q.status) where['status'] = q.status;
  if (q.confidence) where['confidence'] = q.confidence;
  if (q.owner) where['owner'] = q.owner;
  const { rows, total } = await ctx.db.table('verify_register').list({
    where, orderBy: [{ col: 'status', dir: 'desc' }, { col: 'code', dir: 'asc' }], limit: q.limit, offset: q.offset, search: q.q ? { cols: ['code', 'title', 'detail', 'where_to_check'], text: q.q } : undefined,
  });
  respondPage(res, rows, total, q.limit, q.offset);
}));

router.patch('/verify-register/:id', COMPLIANCE, handle(async (ctx, req) => {
  const id = param(req, 'id');
  const patch = body(platformVerifyPatchSchema, req);
  const cur = await ctx.db.table('verify_register').get(id);
  if (!cur) throw notFound('Register item');
  const status = patch.status ?? cur.status;
  const next: Partial<VerifyRegisterItem> = {};
  if (patch.owner !== undefined) next.owner = patch.owner;
  if (status === 'closed') {
    const url = patch.closing_source_url !== undefined ? patch.closing_source_url : cur.closing_source_url;
    if (!url) throw fieldError('closing_source_url', 'Closing an item needs the URL of the primary source that settles it');
    next.status = 'closed';
    next.closing_source_url = url;
    next.closed_at = patch.closed_at ?? cur.closed_at ?? istDateString(ctx.now());
  } else {
    if (patch.closing_source_url || patch.closed_at) throw fieldError('closing_source_url', 'Closing details apply only when the item is closed');
    if (cur.status === 'closed') { next.status = 'open'; next.closed_at = null; next.closing_source_url = null; }
  }
  const row = await ctx.db.table('verify_register').update(id, next);
  await audit(ctx, { action: status === 'closed' && cur.status !== 'closed' ? 'verify_register.close' : cur.status === 'closed' && status === 'open' ? 'verify_register.reopen' : 'verify_register.update', table: 'verify_register', record_id: id, old: cur as unknown as Json, new: row as unknown as Json });
  return row;
}));

export default router;
