/** Generic approvals inbox and decision endpoint (every entity type: quotation, PI, sales order, credit / compliance override). */
import { Router } from 'express';
import { approvalDecisionSchema, approvalListQuerySchema } from '@solar/shared';
import { ALL_ROLES, allow } from '../auth/authorize';
import { body, handle, param, query, respondPage, wrap } from '../http/handler';
import { approvalSummary, decideApproval, getApprovalView, listApprovals } from '../services/approvalService';

const router = Router();
const APPROVERS = ['management', 'regional_head', 'sales_manager', 'dsm', 'accounts', 'compliance_officer', 'techno_commercial'] as const;

// sidebar badge (every signed-in role; 0 for roles that do not approve) — registered before /approvals/:id
router.get('/approvals/summary', allow(...ALL_ROLES), handle((ctx) => approvalSummary(ctx)));

router.get('/approvals', allow(...APPROVERS), wrap(async (req, res) => {
  const ctx = req.ctx!;
  const q = query(approvalListQuerySchema, req);
  const { rows, total } = await listApprovals(ctx, q);
  respondPage(res, rows, total, q.limit, q.offset);
}));

router.get('/approvals/:id', allow(...APPROVERS), handle((ctx, req) => getApprovalView(ctx, param(req, 'id'))));

router.post('/approvals/:id/decide', allow(...APPROVERS), handle((ctx, req) => decideApproval(ctx, param(req, 'id'), body(approvalDecisionSchema, req))));

export default router;
