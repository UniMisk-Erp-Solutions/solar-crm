/**
 * Channel-management routes (mounted under /api/v1): distributors (+ score), dealers (+ scorecard, exposure), vendor registrations
 * and the MNRE SOP tracker. Reference: docs/api/postsale-channel.md
 */
import { Router } from 'express';
import { z } from 'zod';
import {
  dealerCreateSchema, dealerUpdateSchema, distributorCreateSchema, distributorUpdateSchema, sopCaseCreateSchema, sopCaseUpdateSchema, sopReplySchema, sopTransitionSchema,
  uuidSchema, vendorRegistrationCreateSchema, vendorRegistrationUpdateSchema,
} from '@solar/shared';
import { assertCanRead } from '../auth/access';
import { allow } from '../auth/authorize';
import { crudRouter, runList } from '../http/crud';
import { notFound } from '../http/errors';
import { body, handle, param, query, respondPage, wrap } from '../http/handler';
import { audit } from '../lib/audit';
import {
  dealerExposureList, dealerScorecard, hydrateDealers, prepareDealerCreate, prepareDealerUpdate, recomputeDealerRebate,
} from '../services/dealerService';
import { hydrateDistributors, prepareDistributorCreate, recomputeDistributorScore } from '../services/distributorService';
import { CHANNEL_ADMIN_ROLES } from '../services/postsaleShared';
import { hydrateSopCases, openSopCase, recordSopReply, transitionSopCase } from '../services/sopService';
import { afterVendorWrite, hydrateVendorRegistrations, prepareVendorCreate, prepareVendorUpdate, scanBankGuarantees } from '../services/vendorService';

const router = Router();

/** Channel administrators; compliance officers join for the portal / SOP records they police. */
const ADMIN = allow(...CHANNEL_ADMIN_ROLES);
const COMPLIANCE_ADMIN = [...CHANNEL_ADMIN_ROLES, 'compliance_officer'] as const;

/* ───────────────────────── distributors ───────────────────────── */
router.post('/distributors/:id/score/recompute', ADMIN, handle(async (ctx, req) => recomputeDistributorScore(ctx, param(req, 'id'))));
router.get('/distributors/:id/score-history', handle(async (ctx, req) => {
  const dist = await ctx.db.table('distributors').get(param(req, 'id'));
  if (!dist) throw notFound('Distributor');
  await assertCanRead(ctx, 'distributors', dist);
  return ctx.db.table('distributor_score_history').all({ distributor_id: dist.id }, { orderBy: { col: 'computed_at', dir: 'desc' } });
}));
router.use(crudRouter({
  table: 'distributors', path: '/distributors', entity: 'distributor', writeRoles: [...CHANNEL_ADMIN_ROLES],
  list: {
    searchCols: ['legal_name', 'trade_name', 'city', 'gstin', 'contact_name'],
    filterCols: ['status', 'state', 'city', 'score', 'credit_days', 'credit_limit'],
    defaultSort: { col: 'score', dir: 'desc' },
  },
  createSchema: distributorCreateSchema, updateSchema: distributorUpdateSchema,
  prepareCreate: (_ctx, input) => prepareDistributorCreate(input),
  afterCreate: async (ctx, row) => { await recomputeDistributorScore(ctx, row.id); },
  hydrate: hydrateDistributors,
}));

/* ───────────────────────── dealers ───────────────────────── */
router.get('/dealers/exposure', handle(async (ctx, req) => {
  const q = query(z.object({ distributor_id: uuidSchema.optional(), over_limit: z.enum(['true', 'false']).transform((v) => v === 'true').optional() }), req);
  const rows = await dealerExposureList(ctx, q);
  return rows;
}));
router.get('/dealers/:id/scorecard', handle((ctx, req) => dealerScorecard(ctx, param(req, 'id'))));
router.post('/dealers/:id/rebate/recompute', ADMIN, handle((ctx, req) => recomputeDealerRebate(ctx, param(req, 'id'))));
router.use(crudRouter({
  table: 'dealers', path: '/dealers', entity: 'dealer', writeRoles: [...CHANNEL_ADMIN_ROLES, 'distributor_user'],
  list: {
    searchCols: ['legal_name', 'trade_name', 'city', 'district', 'gstin', 'contact_name'],
    filterCols: ['distributor_id', 'status', 'portal_status', 'territory_id', 'state', 'district', 'city', 'credit_limit', 'complaint_count'],
    defaultSort: { col: 'legal_name', dir: 'asc' },
  },
  createSchema: dealerCreateSchema, updateSchema: dealerUpdateSchema,
  prepareCreate: (ctx, input) => prepareDealerCreate(ctx, input),
  prepareUpdate: (ctx, input) => prepareDealerUpdate(ctx, input),
  hydrate: hydrateDealers,
}));

/* ───────────────────────── vendor registrations ───────────────────────── */
router.post('/vendor-registrations/scan-bank-guarantees', ADMIN, handle((ctx) => scanBankGuarantees(ctx)));
router.use(crudRouter({
  table: 'vendor_registrations', path: '/vendor-registrations', entity: 'vendor_registration', writeRoles: [...COMPLIANCE_ADMIN],
  list: {
    searchCols: ['portal_vendor_id', 'notes'],
    filterCols: ['party_type', 'party_id', 'level', 'portal_status', 'bank_guarantee_valid_till', 'deactivated_from', 'deactivated_to'],
    defaultSort: { col: 'created_at', dir: 'desc' },
  },
  createSchema: vendorRegistrationCreateSchema, updateSchema: vendorRegistrationUpdateSchema,
  prepareCreate: (ctx, input) => prepareVendorCreate(ctx, input),
  prepareUpdate: (ctx, input, current) => prepareVendorUpdate(ctx, input, current),
  afterCreate: (ctx, row) => afterVendorWrite(ctx, row, null),
  afterUpdate: (ctx, row, before) => afterVendorWrite(ctx, row, before),
  hydrate: hydrateVendorRegistrations,
}));

/* ───────────────────────── MNRE SOP tracker ───────────────────────── */
const sopWrite = allow(...COMPLIANCE_ADMIN);

router.get('/sop-cases', wrap(async (req, res) => {
  const ctx = req.ctx!;
  const page = await runList(ctx, req, {
    table: 'sop_cases', searchCols: ['complaint_ref', 'summary', 'outcome'], filterCols: ['stage', 'dealer_id', 'vendor_registration_id', 'notice_at', 'closed_at'],
    defaultSort: { col: 'notice_at', dir: 'desc' },
  });
  respondPage(res, await hydrateSopCases(ctx, page.rows as never), page.total, page.limit, page.offset);
}));
router.get('/sop-cases/:id', handle(async (ctx, req) => {
  const row = await ctx.db.table('sop_cases').get(param(req, 'id'));
  if (!row) throw notFound('SOP case');
  await assertCanRead(ctx, 'sop_cases', row);
  return (await hydrateSopCases(ctx, [row]))[0];
}));
router.post('/sop-cases', sopWrite, handle(async (ctx, req, res) => {
  const row = await openSopCase(ctx, body(sopCaseCreateSchema, req));
  res.status(201);
  return { ...(await hydrateSopCases(ctx, [row]))[0], warnings: row.warnings };
}));
router.patch('/sop-cases/:id', sopWrite, handle(async (ctx, req) => {
  const id = param(req, 'id');
  const before = await ctx.db.table('sop_cases').get(id);
  if (!before) throw notFound('SOP case');
  const input = body(sopCaseUpdateSchema, req);
  const patch = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
  const row = Object.keys(patch).length ? await ctx.db.table('sop_cases').update(id, patch) : before;
  await audit(ctx, { action: 'sop_case.update', table: 'sop_cases', record_id: id, old: before as never, new: row as never });
  return (await hydrateSopCases(ctx, [row]))[0];
}));
router.post('/sop-cases/:id/transition', sopWrite, handle(async (ctx, req) => {
  const row = await transitionSopCase(ctx, param(req, 'id'), body(sopTransitionSchema, req));
  return { ...(await hydrateSopCases(ctx, [row]))[0], warnings: row.warnings };
}));
router.post('/sop-cases/:id/reply', sopWrite, handle(async (ctx, req) => {
  const row = await recordSopReply(ctx, param(req, 'id'), body(sopReplySchema, req).replied_at);
  return (await hydrateSopCases(ctx, [row]))[0];
}));

export default router;
