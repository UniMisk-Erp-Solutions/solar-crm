/** Compliance engine endpoints: live preview, gate catalogue, override requests. */
import { Router } from 'express';
import { GATES, SEGMENTS, complianceOverrideRequestSchema, compliancePreviewSchema, isExternalRole } from '@solar/shared';
import { assertCanRead } from '../auth/access';
import { ALL_ROLES, INTERNAL_ONLY, SALES_ROLES, allow } from '../auth/authorize';
import { body, handle, param, query } from '../http/handler';
import { forbidden, notFound } from '../http/errors';
import { z } from 'zod';
import { loadApplicability } from '../services/compliance/applicability';
import { GATE_TITLE } from '../services/compliance/types';
import { hydrateApprovals } from '../services/approvalService';
import { previewCompliance } from '../services/complianceService';
import { requestOverride } from '../services/quoteService';

const router = Router();

// live gate results without a quote (product recommendation screen and quote builder)
router.post('/compliance/preview', allow(...ALL_ROLES), handle(async (ctx, req) => {
  const input = body(compliancePreviewSchema, req);
  if (isExternalRole(ctx.user.role)) {
    // partners see the gates for their own business only
    input.dealer_id = ctx.user.dealer_id ?? null;
    input.site_id = null;
    if (input.lead_id) {
      const lead = await ctx.db.table('leads').get(input.lead_id);
      if (!lead) throw notFound('Lead');
      await assertCanRead(ctx, 'leads', lead);
    }
  }
  return previewCompliance(ctx, input);
}));

// gate catalogue and the effective gate × segment applicability matrix
router.get('/compliance/gates', allow(...ALL_ROLES), handle(async (ctx) => {
  const matrix = await loadApplicability(ctx);
  return {
    gates: GATES.map((g) => ({ gate: g, title: GATE_TITLE[g], applicability: Object.fromEntries(SEGMENTS.map((s) => [s, { applicability: matrix[g][s].applicability, note: matrix[g][s].note, source: matrix[g][s].source }])) })),
    segments: SEGMENTS,
  };
}));

// request a compliance-lane override (written reason mandatory) for a quote, dispatch or sales order
router.post('/compliance/overrides', allow(...SALES_ROLES, 'dispatch', 'compliance_officer'), handle(async (ctx, req, res) => {
  const out = await requestOverride(ctx, body(complianceOverrideRequestSchema, req));
  res.status(201).json({ data: out });
}));

const overrideQuery = z.object({ entity_id: z.string().uuid() });
router.get('/compliance/overrides', allow(...INTERNAL_ONLY), handle(async (ctx, req) => {
  const { entity_id } = query(overrideQuery, req);
  const rows = await ctx.db.table('approvals').all({ entity_type: 'compliance_override', entity_id }, { orderBy: [{ col: 'requested_at', dir: 'desc' }] });
  return hydrateApprovals(ctx, rows);
}));

router.get('/compliance/overrides/:id', allow(...INTERNAL_ONLY), handle(async (ctx, req) => {
  const a = await ctx.db.table('approvals').get(param(req, 'id'));
  if (!a || a.entity_type !== 'compliance_override') throw notFound('Override');
  if (isExternalRole(ctx.user.role)) throw forbidden();
  return (await hydrateApprovals(ctx, [a]))[0];
}));

export default router;
