import { Router } from 'express';
import { dashboardFilterSchema } from '@solar/shared';
import { ALL_ROLES, INTERNAL_ONLY, allow } from '../auth/authorize';
import { handle, query } from '../http/handler';
import { cfaPendingDashboard, complianceDashboard, consentDashboard, dealerExposureDashboard, discomAgeingDashboard, funnelDashboard, slaDashboard, stockExposureDashboard } from '../services/dashboardService';
import { homeDashboard } from '../services/homeQueueService';

/**
 * /dashboards/* — KPI dashboards. Every endpoint accepts ?from=&to= (YYYY-MM-DD, default last 90 days), ?segment=, ?distributor_id=, ?dealer_id=.
 * Numbers respect row-level scope: distributor / dealer users only ever see their own party's data.
 */
const router = Router();

router.get('/dashboards/home', allow(...ALL_ROLES), handle((ctx, req) => homeDashboard(ctx, query(dashboardFilterSchema, req))));
router.get('/dashboards/funnel', allow(...ALL_ROLES), handle((ctx, req) => funnelDashboard(ctx, query(dashboardFilterSchema, req))));
router.get('/dashboards/sla', allow(...ALL_ROLES), handle((ctx, req) => slaDashboard(ctx, query(dashboardFilterSchema, req))));
router.get('/dashboards/discom-ageing', allow(...ALL_ROLES), handle((ctx, req) => discomAgeingDashboard(ctx, query(dashboardFilterSchema, req))));
router.get('/dashboards/cfa-pending', allow(...ALL_ROLES), handle((ctx, req) => cfaPendingDashboard(ctx, query(dashboardFilterSchema, req))));
router.get('/dashboards/dealer-exposure', allow(...ALL_ROLES), handle((ctx, req) => dealerExposureDashboard(ctx, query(dashboardFilterSchema, req))));
router.get('/dashboards/stock-exposure', allow(...INTERNAL_ONLY), handle((ctx, req) => stockExposureDashboard(ctx, query(dashboardFilterSchema, req))));
router.get('/dashboards/compliance', allow(...ALL_ROLES), handle((ctx, req) => complianceDashboard(ctx, query(dashboardFilterSchema, req))));
router.get('/dashboards/consent', allow(...ALL_ROLES), handle((ctx, req) => consentDashboard(ctx, query(dashboardFilterSchema, req))));

export default router;
