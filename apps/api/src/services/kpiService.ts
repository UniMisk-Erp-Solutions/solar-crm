import type { DashboardFilterInput, Kpi, ReportCatalogItem } from '@solar/shared';
import type { AppContext } from '../auth/context';
import { forbidden, notFound } from '../http/errors';
import type { KpiDetail } from './kpi/common';
import { KPI_BY_KEY, KPI_DEFS, type KpiDef } from './kpi/definitions';
import { runDashboard, type DashboardRun } from './dashboardService';

export { KPI_DEFS, KPI_BY_KEY } from './kpi/definitions';
export type { KpiDef, DashboardName } from './kpi/definitions';

const isExternal = (ctx: AppContext): boolean => ctx.user.role === 'distributor_user' || ctx.user.role === 'dealer_user';

/** KPI definitions the signed-in user may see / export (internal-only KPIs are hidden from distributor and dealer users). */
export function visibleKpiDefs(ctx: AppContext): KpiDef[] {
  return KPI_DEFS.filter((d) => !(d.internalOnly && isExternal(ctx)));
}

/** `GET /reports/catalog` — every KPI that can be exported as xlsx. */
export function reportCatalog(ctx: AppContext): ReportCatalogItem[] {
  return visibleKpiDefs(ctx).map((d) => ({
    key: d.key, label: d.label, dashboard: d.dashboard, unit: d.unit, definition: d.definition, formula: d.formula, source_tables: d.sources, exclusions: d.exclusions,
    formats: ['xlsx'], export_path: `/reports/export?kpi=${d.key}&format=xlsx`,
  }));
}

export interface KpiResult { def: KpiDef; kpi: Kpi; detail: KpiDetail | null; run: DashboardRun }

/** Computes one KPI (by running its dashboard family) together with its full detail table. */
export async function computeKpi(ctx: AppContext, key: string, input: DashboardFilterInput): Promise<KpiResult> {
  const def = KPI_BY_KEY.get(key);
  if (!def) throw notFound('KPI');
  if (def.internalOnly && isExternal(ctx)) throw forbidden('This report is available to internal users only');
  const run = await runDashboard(ctx, def.dashboard, input);
  const kpi = run.response.kpis.find((k) => k.key === key);
  if (!kpi) throw notFound('KPI');
  return { def, kpi, detail: run.details[key] ?? null, run };
}
