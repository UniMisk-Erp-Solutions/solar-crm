import type {
  CfaPendingDashboard, ComplianceDashboard, ConsentDashboard, DashboardBase, DashboardFilterInput, DealerExposureDashboard, DiscomAgeingDashboard, FunnelDashboard,
  Kpi, SlaDashboard, StockExposureDashboard,
} from '@solar/shared';
import type { AppContext } from '../auth/context';
import { forbidden } from '../http/errors';
import { computeCfaPending } from './kpi/cfa';
import type { Family, KpiDetail } from './kpi/common';
import { computeCompliance } from './kpi/compliance';
import { computeConsent } from './kpi/consent';
import { KPI_BY_KEY, type DashboardName } from './kpi/definitions';
import { computeDealerExposureDashboard } from './kpi/dealer';
import { computeDiscomAgeing } from './kpi/discom';
import { computeFunnel } from './kpi/funnel';
import { KpiScope, resolveFilters, type ResolvedFilters } from './kpi/scope';
import { computeSla } from './kpi/sla';
import { computeStockExposure } from './kpi/stock';

/** Dashboards whose data is not party-scoped (stock) — internal users only. */
const INTERNAL_ONLY: DashboardName[] = ['stock-exposure'];

export interface DashboardRun<R extends DashboardBase = DashboardBase> {
  name: DashboardName;
  filters: ResolvedFilters;
  response: R;
  /** detail tables by KPI key, for export */
  details: Record<string, KpiDetail>;
}

export function assertDashboardAllowed(ctx: AppContext, name: DashboardName): void {
  if (INTERNAL_ONLY.includes(name) && (ctx.user.role === 'distributor_user' || ctx.user.role === 'dealer_user')) throw forbidden('This dashboard is available to internal users only');
}

const baseOf = (f: ResolvedFilters): Omit<DashboardBase, 'kpis'> => ({
  generated_at: f.now.toISOString(), period: { from: f.from, to: f.to, days: f.days },
  filters: { segment: f.segment, distributor_id: f.distributor_id, dealer_id: f.dealer_id },
});

/** KPIs flagged internalOnly are removed for distributor / dealer users (their data is not party-scoped). */
const visibleKpis = (ctx: AppContext, kpis: Kpi[]): Kpi[] =>
  ctx.user.role === 'distributor_user' || ctx.user.role === 'dealer_user' ? kpis.filter((k) => !KPI_BY_KEY.get(k.key)?.internalOnly) : kpis;

async function assemble<E extends object>(ctx: AppContext, name: DashboardName, scope: KpiScope, fam: Family<E>): Promise<DashboardRun<DashboardBase & E>> {
  const response = { ...baseOf(scope.filters), kpis: visibleKpis(ctx, fam.kpis), ...fam.extra } as DashboardBase & E;
  return { name, filters: scope.filters, response, details: fam.details };
}

/**
 * Runs one dashboard. Pass an existing `scope` to share the memoised data reads between dashboards (the home queue does).
 * Everything is fetched once and aggregated in TypeScript — no per-row queries.
 */
export async function runDashboard(ctx: AppContext, name: DashboardName, input: DashboardFilterInput, scope?: KpiScope): Promise<DashboardRun> {
  assertDashboardAllowed(ctx, name);
  const s = scope ?? new KpiScope(ctx, await resolveFilters(ctx, input));
  switch (name) {
    case 'funnel': return assemble(ctx, name, s, await computeFunnel(s));
    case 'sla': return assemble(ctx, name, s, await computeSla(s));
    case 'discom-ageing': return assemble(ctx, name, s, await computeDiscomAgeing(s));
    case 'cfa-pending': return assemble(ctx, name, s, await computeCfaPending(s));
    case 'dealer-exposure': return assemble(ctx, name, s, await computeDealerExposureDashboard(s));
    case 'stock-exposure': return assemble(ctx, name, s, await computeStockExposure(s));
    case 'compliance': return assemble(ctx, name, s, await computeCompliance(s));
    case 'consent': return assemble(ctx, name, s, await computeConsent(s));
  }
}

/* typed entry points used by the routes and tests */
export const funnelDashboard = async (ctx: AppContext, input: DashboardFilterInput): Promise<FunnelDashboard> => (await runDashboard(ctx, 'funnel', input)).response as FunnelDashboard;
export const slaDashboard = async (ctx: AppContext, input: DashboardFilterInput): Promise<SlaDashboard> => (await runDashboard(ctx, 'sla', input)).response as SlaDashboard;
export const discomAgeingDashboard = async (ctx: AppContext, input: DashboardFilterInput): Promise<DiscomAgeingDashboard> => (await runDashboard(ctx, 'discom-ageing', input)).response as DiscomAgeingDashboard;
export const cfaPendingDashboard = async (ctx: AppContext, input: DashboardFilterInput): Promise<CfaPendingDashboard> => (await runDashboard(ctx, 'cfa-pending', input)).response as CfaPendingDashboard;
export const dealerExposureDashboard = async (ctx: AppContext, input: DashboardFilterInput): Promise<DealerExposureDashboard> => (await runDashboard(ctx, 'dealer-exposure', input)).response as DealerExposureDashboard;
export const stockExposureDashboard = async (ctx: AppContext, input: DashboardFilterInput): Promise<StockExposureDashboard> => (await runDashboard(ctx, 'stock-exposure', input)).response as StockExposureDashboard;
export const complianceDashboard = async (ctx: AppContext, input: DashboardFilterInput): Promise<ComplianceDashboard> => (await runDashboard(ctx, 'compliance', input)).response as ComplianceDashboard;
export const consentDashboard = async (ctx: AppContext, input: DashboardFilterInput): Promise<ConsentDashboard> => (await runDashboard(ctx, 'consent', input)).response as ConsentDashboard;
