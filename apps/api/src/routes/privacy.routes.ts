/**
 * /privacy/* (data-principal export, erasure, unmask log, data requests) and /breaches (DPDP breach incidents).
 * Everything here is limited to compliance_officer and admin.
 */
import { Router } from 'express';
import {
  platformBreachCloseSchema, platformBreachCreateSchema, platformBreachEvidenceSchema, platformBreachListQuerySchema, platformBreachPatchSchema, platformBreachReportSchema,
  platformDataRequestQuerySchema, platformPrivacyEraseSchema, platformPrivacyExportSchema, platformUnmaskAuditQuerySchema, type DataRequest,
} from '@solar/shared';
import { allow } from '../auth/authorize';
import type { Where } from '../db/types';
import { runList } from '../http/crud';
import { body, handle, param, query, respondPage, wrap } from '../http/handler';
import { addEvidence, breachDraft, closeBreach, createBreach, getBreach, listBreaches, markReported, patchBreach } from '../services/breachService';
import { eraseLead, exportPersonalData, listUnmaskEvents } from '../services/privacyService';

const router = Router();
const DPO = allow('compliance_officer');

/* ═════════════════════════ privacy ═════════════════════════ */
/** Data-principal access request: everything held about the person in one JSON bundle (message bodies masked). */
router.post('/privacy/export', DPO, handle(async (ctx, req) => exportPersonalData(ctx, body(platformPrivacyExportSchema, req))));

/** Erasure: anonymises personal data, keeps aggregates, the consent ledger and statutory financial records. */
router.post('/privacy/erase', DPO, handle(async (ctx, req) => {
  const b = body(platformPrivacyEraseSchema, req);
  return eraseLead(ctx, b.lead_id, { reason: b.reason, trigger: 'request' });
}));

router.get('/privacy/requests', DPO, wrap(async (req, res) => {
  const ctx = req.ctx!;
  const f = query(platformDataRequestQuerySchema, req);
  const baseWhere: Where = {};
  if (f.kind) baseWhere['kind'] = f.kind;
  if (f.status) baseWhere['status'] = f.status;
  const page = await runList<DataRequest>(ctx, req, { table: 'data_requests', unscoped: true, baseWhere, sortCols: ['requested_at', 'status', 'kind'], defaultSort: { col: 'requested_at', dir: 'desc' } });
  respondPage(res, page.rows, page.total, page.limit, page.offset);
}));

/** Who revealed a full mobile number / e-mail, when, and for which record (privacy by default is audited). */
router.get('/privacy/audit-unmask', DPO, wrap(async (req, res) => {
  const q = query(platformUnmaskAuditQuerySchema, req);
  const { rows, total } = await listUnmaskEvents(req.ctx!, q);
  respondPage(res, rows, total, q.limit, q.offset);
}));

/* ═════════════════════════ breach incidents ═════════════════════════ */
router.get('/breaches', DPO, wrap(async (req, res) => {
  const q = query(platformBreachListQuerySchema, req);
  const { rows, total } = await listBreaches(req.ctx!, q);
  respondPage(res, rows, total, q.limit, q.offset);
}));
router.post('/breaches', DPO, handle(async (ctx, req, res) => { res.status(201).json({ data: await createBreach(ctx, body(platformBreachCreateSchema, req)) }); }));
router.get('/breaches/:id', DPO, handle(async (ctx, req) => getBreach(ctx, param(req, 'id'))));
router.patch('/breaches/:id', DPO, handle(async (ctx, req) => patchBreach(ctx, param(req, 'id'), body(platformBreachPatchSchema, req))));
router.post('/breaches/:id/evidence', DPO, handle(async (ctx, req) => addEvidence(ctx, param(req, 'id'), body(platformBreachEvidenceSchema, req))));
router.get('/breaches/:id/notification-draft', DPO, handle(async (ctx, req) => breachDraft(ctx, param(req, 'id'))));
router.post('/breaches/:id/report', DPO, handle(async (ctx, req) => markReported(ctx, param(req, 'id'), body(platformBreachReportSchema, req))));
router.post('/breaches/:id/close', DPO, handle(async (ctx, req) => closeBreach(ctx, param(req, 'id'), body(platformBreachCloseSchema, req))));

export default router;
