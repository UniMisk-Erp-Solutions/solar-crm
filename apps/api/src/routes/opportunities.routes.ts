/** Opportunities (steps 19–20, pipeline board) and POST /leads/:id/convert. Full resource paths, mounted under /api/v1. */
import { Router } from 'express';
import { leadConvertSchema, opportunityLoseSchema, opportunityReopenSchema, opportunityStageSchema, opportunityUpdateSchema } from '@solar/shared';
import { ALL_ROLES, SALES_ROLES, allow } from '../auth/authorize';
import { body, handle } from '../http/handler';
import { convertLead, getConvertReadiness } from '../services/opportunityConvert';
import { getOpportunityView, listOpportunities, loadOpportunity, loseOpportunity, pipeline, reopenOpportunity, setStage, updateOpportunity } from '../services/opportunityService';
import { getVisibleLead, idParam } from '../services/siteAccess';

const router = Router();
const READ = allow(...ALL_ROLES);
const WRITE = allow(...SALES_ROLES);

/* ───────────── lead → opportunity (step 19) ───────────── */

router.get('/leads/:id/convert-check', READ, handle(async (ctx, req) => getConvertReadiness(ctx, await getVisibleLead(ctx, idParam(req)))));

router.post('/leads/:id/convert', WRITE, handle(async (ctx, req, res) => {
  const lead = await getVisibleLead(ctx, idParam(req));
  const r = await convertLead(ctx, lead, body(leadConvertSchema, req));
  const opportunity = await getOpportunityView(ctx, r.opportunity, { warnings: r.warnings });
  res.status(r.created ? 201 : 200).json({
    data: { opportunity, created: r.created, already_converted: !r.created, expected_value_basis: r.expected_value_basis, indicative_rate_per_kw: r.indicative_rate_per_kw, warnings: opportunity.warnings },
  });
}));

/* ───────────── opportunities ───────────── */

router.get('/opportunities', READ, handle(async (ctx, req, res) => {
  const page = await listOpportunities(ctx, req);
  res.json({ data: page.rows, total: page.total, limit: page.limit, offset: page.offset });
}));
// declared before /:id so that "pipeline" is not read as an id
router.get('/opportunities/pipeline', READ, handle(async (ctx, req) => pipeline(ctx, req)));
router.get('/opportunities/:id', READ, handle(async (ctx, req) => getOpportunityView(ctx, await loadOpportunity(ctx, idParam(req)))));
router.patch('/opportunities/:id', WRITE, handle(async (ctx, req) => updateOpportunity(ctx, idParam(req), body(opportunityUpdateSchema, req))));
router.post('/opportunities/:id/stage', WRITE, handle(async (ctx, req) => setStage(ctx, idParam(req), body(opportunityStageSchema, req).stage)));
router.post('/opportunities/:id/lose', WRITE, handle(async (ctx, req) => loseOpportunity(ctx, idParam(req), body(opportunityLoseSchema, req))));
router.post('/opportunities/:id/reopen', WRITE, handle(async (ctx, req) => reopenOpportunity(ctx, idParam(req), body(opportunityReopenSchema, req))));

export default router;
