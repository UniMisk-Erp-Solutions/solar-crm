/** Stage 4 — quotations: builder, compliance evaluation, approvals, send, follow-up, versions; plus the re-quote exposure report. */
import { Router } from 'express';
import {
  quoteAcceptSchema, quoteCreateSchema, quoteDiscussionSchema, quoteLinesReplaceSchema, quoteListQuerySchema, quotePatchSchema, quoteRejectSchema, quoteReviseSchema,
  quoteSendSchema, requestApprovalSchema, requoteExposureQuerySchema, taxPositionSchema, type Quotation,
} from '@solar/shared';
import { INTERNAL_ONLY, SALES_ROLES, allow } from '../auth/authorize';
import { runList } from '../http/crud';
import { body, handle, param, query, respondPage, wrap } from '../http/handler';
import { requoteExposure } from '../services/requoteService';
import {
  acceptQuote, addDiscussion, createQuote, evaluateQuote, getQuoteDetail, hydrateQuoteList, patchQuote, quotePdfBuffer, rejectQuote, replaceLines, requestApproval,
  reviseQuote, sendQuote, setTaxPosition, supersededQuoteIds,
} from '../services/quoteService';

const router = Router();
const READERS = [...INTERNAL_ONLY, 'distributor_user', 'dealer_user'] as const;
const EVALUATORS = [...SALES_ROLES, 'compliance_officer', 'accounts'] as const;
const REPORT_ROLES = ['management', 'regional_head', 'sales_manager', 'dsm', 'techno_commercial', 'compliance_officer', 'accounts', 'viewer'] as const;

router.get('/quotes', allow(...READERS), wrap(async (req, res) => {
  const ctx = req.ctx!;
  const q = query(quoteListQuerySchema, req);
  const baseWhere = q.latest_only ? { id: { nin: await supersededQuoteIds(ctx) } } : undefined;
  const page = await runList<Quotation>(ctx, req, {
    table: 'quotations', searchCols: ['quote_no'], baseWhere, defaultSort: { col: 'created_at', dir: 'desc' },
    filterCols: ['status', 'segment', 'opportunity_id', 'owner_id', 'dealer_id', 'distributor_id', 'compliance_status'], sortCols: ['quote_no', 'total', 'validity_date', 'status', 'kw'],
  });
  respondPage(res, await hydrateQuoteList(ctx, page.rows), page.total, page.limit, page.offset);
}));

router.post('/quotes', allow(...SALES_ROLES), handle(async (ctx, req, res) => {
  res.status(201).json({ data: await createQuote(ctx, body(quoteCreateSchema, req)) });
}));

router.get('/reports/requote-exposure', allow(...REPORT_ROLES), handle((ctx, req) => requoteExposure(ctx, query(requoteExposureQuerySchema, req))));

router.get('/quotes/:id', allow(...READERS), handle((ctx, req) => getQuoteDetail(ctx, param(req, 'id'))));
router.patch('/quotes/:id', allow(...SALES_ROLES), handle((ctx, req) => patchQuote(ctx, param(req, 'id'), body(quotePatchSchema, req))));
router.put('/quotes/:id/lines', allow(...SALES_ROLES), handle((ctx, req) => replaceLines(ctx, param(req, 'id'), body(quoteLinesReplaceSchema, req))));
// a CA-type decision: GST rate, HSN and approval of a line's tax position (mandatory for inverter and bundled lines)
router.post('/quotes/:id/tax-position', allow('accounts', 'compliance_officer'), handle((ctx, req) => setTaxPosition(ctx, param(req, 'id'), body(taxPositionSchema, req))));
router.post('/quotes/:id/evaluate', allow(...EVALUATORS), handle((ctx, req) => evaluateQuote(ctx, param(req, 'id'))));
router.post('/quotes/:id/request-approval', allow(...SALES_ROLES), handle((ctx, req) => requestApproval(ctx, param(req, 'id'), body(requestApprovalSchema, req).note)));
router.post('/quotes/:id/send', allow(...SALES_ROLES), handle((ctx, req) => sendQuote(ctx, param(req, 'id'), body(quoteSendSchema, req))));

router.get('/quotes/:id/pdf', allow(...READERS), wrap(async (req, res) => {
  const { buffer, file_name } = await quotePdfBuffer(req.ctx!, param(req, 'id'));
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${req.query['download'] === '1' ? 'attachment' : 'inline'}; filename="${file_name}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(buffer);
}));

router.get('/quotes/:id/discussions', allow(...READERS), handle(async (ctx, req) => (await getQuoteDetail(ctx, param(req, 'id'))).discussions));
router.post('/quotes/:id/discussions', allow(...SALES_ROLES), handle(async (ctx, req, res) => {
  res.status(201).json({ data: await addDiscussion(ctx, param(req, 'id'), body(quoteDiscussionSchema, req)) });
}));
router.post('/quotes/:id/accept', allow(...SALES_ROLES), handle((ctx, req) => acceptQuote(ctx, param(req, 'id'), body(quoteAcceptSchema, req).note)));
router.post('/quotes/:id/reject', allow(...SALES_ROLES), handle((ctx, req) => rejectQuote(ctx, param(req, 'id'), body(quoteRejectSchema, req).reason)));
router.post('/quotes/:id/revise', allow(...SALES_ROLES), handle(async (ctx, req, res) => {
  const input = body(quoteReviseSchema, req);
  res.status(201).json({ data: await reviseQuote(ctx, param(req, 'id'), input) });
}));

export default router;
