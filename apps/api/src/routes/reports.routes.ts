import { Router } from 'express';
import { reportExportQuerySchema, type Json } from '@solar/shared';
import { ALL_ROLES, allow } from '../auth/authorize';
import { audit } from '../lib/audit';
import { handle, query, wrap } from '../http/handler';
import { computeKpi, reportCatalog } from '../services/kpiService';
import { buildReportWorkbook } from '../services/reportExport';

const router = Router();

/** The list of KPI reports that can be exported (role-aware: internal-only KPIs are hidden from distributor / dealer users). */
router.get('/reports/catalog', allow(...ALL_ROLES), handle(async (ctx) => reportCatalog(ctx)));

/**
 * GET /reports/export?kpi=<key>&format=xlsx&from=&to=&segment=&distributor_id=&dealer_id=
 * Streams an .xlsx workbook (Summary, KPI definition, Data, [Breakdown], [Series], Filters applied) as an attachment. Every export is audited.
 */
router.get('/reports/export', allow(...ALL_ROLES), wrap(async (req, res) => {
  const ctx = req.ctx!;
  const { kpi: key, format, ...filters } = query(reportExportQuerySchema, req);
  const result = await computeKpi(ctx, key, filters);
  const built = await buildReportWorkbook(ctx, result);
  await audit(ctx, {
    action: 'report.export', detail: { kpi: key, format, rows: built.rows, period: { from: result.run.filters.from, to: result.run.filters.to }, segment: result.run.filters.segment, distributor_id: result.run.filters.distributor_id, dealer_id: result.run.filters.dealer_id } as Json,
  });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${built.filename}"`);
  res.setHeader('Content-Length', String(built.buffer.length));
  res.setHeader('Cache-Control', 'no-store');
  res.end(built.buffer);
}));

export default router;
