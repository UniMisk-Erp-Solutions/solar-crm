/**
 * Admin routes (/admin/*): users, territories, templates, approval rules, gate applicability, work calendar, SLA,
 * audit viewer, lead-source API keys, jobs and the demo reset.
 * Writes are admin-only unless a route says compliance_officer may also change it; reads follow the notes per route.
 */
import { Router } from 'express';
import { z } from 'zod';
import {
  adminApiKeyCreateSchema, adminApprovalRuleCreateSchema, adminApprovalRuleUpdateSchema, adminAuditQuerySchema, adminGateCellSchema, adminSlaUpdateSchema,
  adminTemplateCreateSchema, adminTemplateUpdateSchema, adminTerritoryCreateSchema, adminTerritoryUpdateSchema, adminTerritoryUsersSchema, adminUserCreateSchema,
  adminUserDeactivateSchema, adminUserUpdateSchema, adminWorkCalendarUpdateSchema, listQuerySchema, platformQueryBool,
  type ApprovalRule, type MessageTemplate, type Profile, type Territory,
} from '@solar/shared';
import { allow, INTERNAL_ONLY } from '../auth/authorize';
import type { Where } from '../db/types';
import type { AppDeps } from '../deps';
import { AppError, notFound } from '../http/errors';
import { crudRouter, runList } from '../http/crud';
import { body, handle, param, parse, query, respondPage, wrap } from '../http/handler';
import { audit } from '../lib/audit';
import { depsFromContext, getPlatformDeps, listJobStatus, runJob } from '../jobs';
import { registeredJobs } from '../services/hooks';
import {
  apiKeyView, createApiKey, createTemplate, createTerritory, createUser, deleteTerritory, gateMatrix, getAuditEntry, getTerritoryUsers, getWorkCalendar, hydrateTerritories, hydrateUsers,
  listSla, queryAudit, resetDemo, reviseTemplate, revokeApiKey, rotateApiKey, setGateCell, setTemplateActive, setTerritoryUsers, setUserActive, templateHistory, updateSla,
  updateTerritory, updateUser, updateWorkCalendar,
} from '../services/adminService';

const router = Router();
const ADMIN = allow();
const COMPLIANCE = allow('compliance_officer');
const READERS = allow(...INTERNAL_ONLY);

const fieldError = (path: string, message: string) => new AppError(422, 'VALIDATION_ERROR', 'Please check the highlighted fields', [{ path, message }]);

/* ═════════════════════════ users ═════════════════════════ */
router.get('/admin/users', ADMIN, wrap(async (req, res) => {
  const ctx = req.ctx!;
  const page = await runList<Profile>(ctx, req, {
    table: 'profiles', searchCols: ['full_name', 'email', 'designation'], filterCols: ['role', 'active', 'distributor_id', 'dealer_id', 'language'], sortCols: ['full_name', 'role', 'email', 'active'], defaultSort: { col: 'full_name', dir: 'asc' },
  });
  respondPage(res, await hydrateUsers(ctx, page.rows), page.total, page.limit, page.offset);
}));
router.get('/admin/users/:id', ADMIN, handle(async (ctx, req) => {
  const row = await ctx.db.table('profiles').get(param(req, 'id'));
  if (!row) throw notFound('User');
  return (await hydrateUsers(ctx, [row]))[0];
}));
router.post('/admin/users', ADMIN, handle(async (ctx, req, res) => { res.status(201).json({ data: await createUser(ctx, body(adminUserCreateSchema, req)) }); }));
router.patch('/admin/users/:id', ADMIN, handle(async (ctx, req) => updateUser(ctx, param(req, 'id'), body(adminUserUpdateSchema, req))));
router.post('/admin/users/:id/deactivate', ADMIN, handle(async (ctx, req) => setUserActive(ctx, param(req, 'id'), false, body(adminUserDeactivateSchema, req).reason)));
router.post('/admin/users/:id/activate', ADMIN, handle(async (ctx, req) => setUserActive(ctx, param(req, 'id'), true)));

/* ═════════════════════════ territories ═════════════════════════ */
router.get('/admin/discoms', READERS, handle(async (ctx) => ctx.db.table('discoms').all({}, { orderBy: [{ col: 'state' }, { col: 'name' }] })));

router.get('/admin/territories', READERS, wrap(async (req, res) => {
  const ctx = req.ctx!;
  const page = await runList<Territory>(ctx, req, {
    table: 'territories', unscoped: true, searchCols: ['name', 'state', 'district'], filterCols: ['state', 'district', 'active', 'discom_id', 'dsm_id'], sortCols: ['name', 'state', 'district'], defaultSort: { col: 'name', dir: 'asc' },
  });
  respondPage(res, await hydrateTerritories(ctx, page.rows), page.total, page.limit, page.offset);
}));
router.get('/admin/territories/:id', READERS, handle(async (ctx, req) => {
  const row = await ctx.db.table('territories').get(param(req, 'id'));
  if (!row) throw notFound('Territory');
  return (await hydrateTerritories(ctx, [row]))[0];
}));
router.post('/admin/territories', ADMIN, handle(async (ctx, req, res) => { res.status(201).json({ data: await createTerritory(ctx, body(adminTerritoryCreateSchema, req)) }); }));
router.patch('/admin/territories/:id', ADMIN, handle(async (ctx, req) => updateTerritory(ctx, param(req, 'id'), body(adminTerritoryUpdateSchema, req))));
router.delete('/admin/territories/:id', ADMIN, handle(async (ctx, req) => deleteTerritory(ctx, param(req, 'id'))));
router.get('/admin/territories/:id/users', READERS, handle(async (ctx, req) => hydrateUsers(ctx, await getTerritoryUsers(ctx, param(req, 'id')))));
router.put('/admin/territories/:id/users', ADMIN, handle(async (ctx, req) => hydrateUsers(ctx, await setTerritoryUsers(ctx, param(req, 'id'), body(adminTerritoryUsersSchema, req).user_ids))));

/* ═════════════════════════ message templates ═════════════════════════ */
const templateListQuery = z.object({
  channel: z.string().optional(), key: z.string().optional(), language: z.string().optional(), category: z.string().optional(), purpose: z.string().optional(),
  active: platformQueryBool.optional(), latest: platformQueryBool.optional(),
});

router.get('/admin/templates', READERS, wrap(async (req, res) => {
  const ctx = req.ctx!;
  const f = parse(templateListQuery, req.query);
  const p = parse(listQuerySchema.extend({ limit: z.coerce.number().int().min(1).max(500).default(100) }), req.query);
  const where: Where = {};
  for (const k of ['channel', 'key', 'language', 'category', 'purpose'] as const) if (f[k]) where[k] = f[k];
  if (f.active !== undefined) where['active'] = f.active;
  let rows = await ctx.db.table('message_templates').all(where, { orderBy: [{ col: 'key' }, { col: 'channel' }, { col: 'language' }, { col: 'version', dir: 'desc' }], search: p.q ? { cols: ['key', 'body', 'subject'], text: p.q } : undefined });
  if (f.latest) {
    const seen = new Set<string>();
    rows = rows.filter((r) => { const k = `${r.key}|${r.channel}|${r.language}`; if (seen.has(k)) return false; seen.add(k); return true; });
  }
  respondPage<MessageTemplate>(res, rows.slice(p.offset, p.offset + p.limit), rows.length, p.limit, p.offset);
}));
router.get('/admin/templates/:id/history', READERS, handle(async (ctx, req) => templateHistory(ctx, param(req, 'id'))));
router.get('/admin/templates/:id', READERS, handle(async (ctx, req) => {
  const row = await ctx.db.table('message_templates').get(param(req, 'id'));
  if (!row) throw notFound('Template');
  return row;
}));
router.post('/admin/templates', COMPLIANCE, handle(async (ctx, req, res) => { res.status(201).json({ data: await createTemplate(ctx, body(adminTemplateCreateSchema, req)) }); }));
router.patch('/admin/templates/:id', COMPLIANCE, handle(async (ctx, req) => reviseTemplate(ctx, param(req, 'id'), body(adminTemplateUpdateSchema, req))));
router.post('/admin/templates/:id/activate', COMPLIANCE, handle(async (ctx, req) => setTemplateActive(ctx, param(req, 'id'), true)));
router.post('/admin/templates/:id/deactivate', COMPLIANCE, handle(async (ctx, req) => setTemplateActive(ctx, param(req, 'id'), false)));

/* ═════════════════════════ approval rules ═════════════════════════ */
const rangeCheck = (min: number, max: number | null | undefined) => {
  if (max !== null && max !== undefined && max < min) throw fieldError('max_value', 'The upper limit cannot be below the lower limit');
};
router.use(crudRouter<'approval_rules'>({
  table: 'approval_rules', path: '/admin/approval-rules', entity: 'approval_rule', unscoped: true, allowDelete: true,
  readRoles: ['management', 'regional_head', 'sales_manager', 'accounts', 'compliance_officer'], writeRoles: [],
  list: { searchCols: ['name'], filterCols: ['lane', 'active'], sortCols: ['lane', 'min_value', 'name'], defaultSort: { col: 'lane', dir: 'asc' } },
  createSchema: adminApprovalRuleCreateSchema, updateSchema: adminApprovalRuleUpdateSchema,
  prepareCreate: (_ctx, input) => { const i = input as z.output<typeof adminApprovalRuleCreateSchema>; rangeCheck(i.min_value, i.max_value); return {} as Partial<ApprovalRule>; },
  prepareUpdate: (_ctx, input, current) => {
    const i = input as z.output<typeof adminApprovalRuleUpdateSchema>;
    rangeCheck(i.min_value ?? current.min_value, i.max_value !== undefined ? i.max_value : current.max_value);
    return {};
  },
}));

/* ═════════════════════════ gate applicability ═════════════════════════ */
router.get('/admin/gate-applicability', READERS, handle(async (ctx) => gateMatrix(ctx)));
router.put('/admin/gate-applicability', COMPLIANCE, handle(async (ctx, req) => setGateCell(ctx, body(adminGateCellSchema, req))));

/* ═════════════════════════ work calendar and SLA (rule-backed) ═════════════════════════ */
router.get('/admin/work-calendar', READERS, handle(async (ctx) => getWorkCalendar(ctx)));
router.put('/admin/work-calendar', COMPLIANCE, handle(async (ctx, req) => updateWorkCalendar(ctx, body(adminWorkCalendarUpdateSchema, req))));
router.get('/admin/sla', READERS, handle(async (ctx) => listSla(ctx)));
router.put('/admin/sla', COMPLIANCE, handle(async (ctx, req) => updateSla(ctx, body(adminSlaUpdateSchema, req))));

/* ═════════════════════════ audit viewer (admin + compliance only) ═════════════════════════ */
router.get('/admin/audit', COMPLIANCE, wrap(async (req, res) => {
  const ctx = req.ctx!;
  const q = query(adminAuditQuerySchema, req);
  const { rows, total } = await queryAudit(ctx, q);
  respondPage(res, rows, total, q.limit, q.offset);
}));
router.get('/admin/audit/:id', COMPLIANCE, handle(async (ctx, req) => getAuditEntry(ctx, param(req, 'id'), req.query['reveal'] === 'true')));

/* ═════════════════════════ lead-source API keys ═════════════════════════ */
router.get('/admin/api-keys', ADMIN, handle(async (ctx) => (await ctx.db.table('source_api_keys').all({}, { orderBy: { col: 'created_at', dir: 'desc' } })).map(apiKeyView)));
/** The plaintext key is in this response only — it is stored as a SHA-256 hash and can never be shown again. */
router.post('/admin/api-keys', ADMIN, handle(async (ctx, req, res) => { res.status(201).json({ data: await createApiKey(ctx, body(adminApiKeyCreateSchema, req)) }); }));
router.post('/admin/api-keys/:id/revoke', ADMIN, handle(async (ctx, req) => revokeApiKey(ctx, param(req, 'id'))));
router.post('/admin/api-keys/:id/rotate', ADMIN, handle(async (ctx, req, res) => { res.status(201).json({ data: await rotateApiKey(ctx, param(req, 'id')) }); }));

/* ═════════════════════════ jobs ═════════════════════════ */
router.get('/admin/jobs', COMPLIANCE, handle(async (ctx) => listJobStatus(ctx)));
router.get('/admin/jobs/:name/runs', COMPLIANCE, wrap(async (req, res) => {
  const ctx = req.ctx!;
  const name = param(req, 'name');
  if (!registeredJobs().some((j) => j.name === name)) throw notFound(`Job "${name}"`);
  const page = await runList(ctx, req, { table: 'job_runs', baseWhere: { job_name: name }, unscoped: true, sortCols: ['started_at', 'status'], defaultSort: { col: 'started_at', dir: 'desc' } });
  respondPage(res, page.rows, page.total, page.limit, page.offset);
}));
router.post('/admin/jobs/:name/run', COMPLIANCE, handle(async (ctx, req) => {
  const name = param(req, 'name');
  const [summary] = await runJob(depsFromContext(ctx), name, { orgId: ctx.org_id, trigger: 'manual', triggeredBy: ctx.user.id });
  await audit(ctx, { action: 'job.run', detail: { job: name, status: summary?.status ?? 'unknown', run_id: summary?.run_id ?? null } });
  return summary;
}));

/* ═════════════════════════ demo reset (demo mode only) ═════════════════════════ */
router.post('/admin/demo/reset', ADMIN, handle(async (ctx, req) => {
  const appDeps = req.app.get('deps') as AppDeps | undefined;
  return resetDemo(ctx, appDeps ?? getPlatformDeps());
}));

export default router;
