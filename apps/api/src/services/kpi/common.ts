import type { Kpi, KpiBreakdownItem, KpiSeriesPoint, KpiTarget, KpiLink, KpiUnit } from '@solar/shared';
import type { AppContext } from '../../auth/context';
import { KPI_DEFS, kpiDef, type DashboardName } from './definitions';

/** One column of a KPI's detail table (xlsx data sheet). */
export interface DetailColumn { key: string; label: string; type: 'text' | 'int' | 'number' | 'pct' | 'inr' | 'date' | 'datetime' | 'days' | 'minutes' }
export type DetailCell = string | number | boolean | null;
export interface KpiDetail { title: string; columns: DetailColumn[]; rows: Record<string, DetailCell>[] }

/** What every KPI family returns: the tiles, the dashboard-specific payload, and full detail tables for export. */
export interface Family<E extends object> {
  kpis: Kpi[];
  extra: E;
  /** detail tables keyed by KPI key (export data sheets). KPIs without an entry export their breakdown / series. */
  details: Record<string, KpiDetail>;
}

export interface KpiValue {
  value: number | null;
  breakdown?: KpiBreakdownItem[];
  series?: KpiSeriesPoint[];
  links?: KpiLink[];
  secondary?: { label: string; value: number | null; unit?: KpiUnit };
  note?: string;
}

/** Builds Kpi objects from the definitions registry, attaching operating-default targets read from rule_config. */
export class KpiBuilder {
  private constructor(private targets: Map<string, number>) {}

  static async create(ctx: AppContext, dashboard?: DashboardName): Promise<KpiBuilder> {
    const targets = new Map<string, number>();
    const defs = KPI_DEFS.filter((d) => d.target && (!dashboard || d.dashboard === dashboard));
    for (const d of defs) {
      const t = d.target!;
      targets.set(d.key, (await ctx.svc.rules.value<number>(t.rule, undefined, t.fallback)) ?? t.fallback);
    }
    return new KpiBuilder(targets);
  }

  make(key: string, v: KpiValue): Kpi {
    const def = kpiDef(key);
    const kpi: Kpi = { key, label: def.label, value: v.value, unit: def.unit, definition: def.definition };
    if (def.target) {
      const value = this.targets.get(key) ?? def.target.fallback;
      const target: KpiTarget = {
        value, direction: def.target.direction, rule: def.target.rule, label: def.target.label,
        met: v.value === null ? null : def.target.direction === 'at_least' ? v.value >= value : v.value <= value,
      };
      kpi.target = target;
    }
    if (v.secondary) kpi.secondary = { label: v.secondary.label, value: v.secondary.value, unit: v.secondary.unit ?? def.unit };
    if (v.breakdown) kpi.breakdown = v.breakdown;
    if (v.series) kpi.series = v.series;
    if (v.links) kpi.links = v.links;
    if (v.note) kpi.note = v.note;
    return kpi;
  }
}

export const emptyFamily = <E extends object>(extra: E): Family<E> => ({ kpis: [], extra, details: {} });
