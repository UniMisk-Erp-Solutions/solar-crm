import { DISCOM_STAGES, daysBetween, istDateString, entityPath, type Clock, type DeemedBreachRow, type DiscomAgeingDashboard, type DiscomAgeingRow, type DiscomApplication, type DiscomStage, type DiscomStageStats } from '@solar/shared';
import { KpiBuilder, type Family, type KpiDetail } from './common';
import { dateInPeriod, type KpiScope } from './scope';
import { DAY, ms, round, summarise } from './stats';

const STAGE_LABEL: Record<DiscomStage, string> = { feasibility: 'Feasibility', inspection: 'Inspection', meter: 'Meter installation', commissioning: 'Commissioning' };
const KPI_KEY: Record<DiscomStage, string> = { feasibility: 'discom_feasibility_ageing', inspection: 'discom_inspection_ageing', meter: 'discom_meter_ageing', commissioning: 'discom_commissioning_ageing' };
interface StageObs { durationDays: number | null; open: boolean; openAgeDays: number | null }

const fdays = (from: string, to: string): number => Math.max(0, ((ms(to) ?? 0) - (ms(from) ?? 0)) / DAY);
const observe = (from: string | null, to: string | null, nowMs: number): StageObs | null => {
  if (!from) return null;
  if (to) return { durationDays: fdays(from, to), open: false, openAgeDays: null };
  return { durationDays: null, open: true, openAgeDays: Math.max(0, (nowMs - (ms(from) ?? nowMs)) / DAY) };
};

/**
 * Stage timing for one application, in fractional days. Same milestone chain as `discomStageAgeing` in services/discomService.ts
 * (the post-sale board) so the dashboard and the board agree — see docs/KPI_DEFINITIONS.md:
 *   feasibility   complete_at (submitted_at) → feasibility outcome (the discom_feasibility clock: resolved_at, or its due date when it lapsed/deemed)
 *   inspection    certificate_submitted_at → inspection_at
 *   meter         inspection_at (else certificate) → meter_at
 *   commissioning certificate_submitted_at → commissioning_at   (the statutory 15-day measure)
 * A stage that started but has no end yet is "open".
 */
export function stageObservations(a: DiscomApplication, feasClock: Clock | null | undefined, nowMs: number): Record<DiscomStage, StageObs | null> {
  let feas: StageObs | null = null;
  if (a.feasibility_status !== 'not_required') {
    const start = a.complete_at ?? a.submitted_at;
    const decided = ['approved', 'rejected', 'deemed'].includes(a.feasibility_status);
    const end = decided ? (feasClock ? (feasClock.status === 'breached' ? feasClock.due_at : feasClock.resolved_at) : null) : null;
    feas = observe(start, end, nowMs);
  }
  return {
    feasibility: feas,
    inspection: observe(a.certificate_submitted_at, a.inspection_at, nowMs),
    meter: observe(a.inspection_at ?? a.certificate_submitted_at, a.meter_at, nowMs),
    commissioning: observe(a.certificate_submitted_at, a.commissioning_at, nowMs),
  };
}

/** Deemed-clock breaches for one application: feasibility 15-day silence clock and the 15-day commissioning clock (or the flag set by the post-sale module). */
export function deemedBreaches(a: DiscomApplication, feasClock: Clock | null | undefined, nowMs: number): { clock: 'feasibility' | 'commissioning'; due_at: string; days_over: number }[] {
  const out: { clock: 'feasibility' | 'commissioning'; due_at: string; days_over: number }[] = [];
  const over = (due: string, endMs: number): number => Math.max(0, daysBetween(due, new Date(endMs)));
  if (feasClock?.status === 'breached') out.push({ clock: 'feasibility', due_at: feasClock.due_at, days_over: over(feasClock.due_at, ms(feasClock.resolved_at) ?? nowMs) });
  else if (a.feasibility_due_at && a.feasibility_status === 'pending' && (ms(a.feasibility_due_at) ?? Infinity) < nowMs) out.push({ clock: 'feasibility', due_at: a.feasibility_due_at, days_over: over(a.feasibility_due_at, nowMs) });
  if (a.certificate_submitted_at && a.commissioning_due_at) {
    const due = ms(a.commissioning_due_at) ?? Infinity;
    const end = a.commissioning_at ? ms(a.commissioning_at) ?? nowMs : nowMs;
    if (end > due) out.push({ clock: 'commissioning', due_at: a.commissioning_due_at, days_over: over(a.commissioning_due_at, end) });
  }
  if (!out.some((b) => b.clock === 'commissioning') && a.deemed_breach) out.push({ clock: 'commissioning', due_at: a.commissioning_due_at ?? a.created_at, days_over: 0 });
  return out;
}

const emptyStats = (): DiscomStageStats => ({ n: 0, median_days: null, p90_days: null, open: 0, oldest_open_days: null });
function statsFor(obs: (StageObs | null)[]): DiscomStageStats {
  const done = obs.filter((o): o is StageObs => !!o && !o.open && o.durationDays !== null).map((o) => o.durationDays!);
  const open = obs.filter((o): o is StageObs => !!o && o.open);
  const s = summarise(done);
  return { n: s.n, median_days: s.median, p90_days: s.p90, open: open.length, oldest_open_days: open.length ? round(Math.max(...open.map((o) => o.openAgeDays ?? 0)), 1) : null };
}

export async function computeDiscomAgeing(scope: KpiScope): Promise<Family<Pick<DiscomAgeingDashboard, 'rows' | 'overall' | 'deemed_breach_list'>>> {
  const f = scope.filters;
  const kb = await KpiBuilder.create(scope.ctx, 'discom-ageing');
  const apps = (await scope.rows('discom_applications')).filter((a) => dateInPeriod(istDateString(new Date(a.submitted_at ?? a.certificate_submitted_at ?? a.created_at)), f));
  const appIds = new Set(apps.map((a) => a.id));
  const feasClock = new Map<string, Clock>();
  if (apps.length) {
    for (const c of await scope.ctx.db.table('clocks').all({ entity_type: 'discom_application', clock_type: 'discom_feasibility' })) {
      if (!appIds.has(c.entity_id)) continue;
      const cur = feasClock.get(c.entity_id);
      if (!cur || c.started_at > cur.started_at) feasClock.set(c.entity_id, c);
    }
  }
  const discoms = await scope.reference('discoms');
  const dName = new Map(discoms.map((d) => [d.id, d]));
  const nameOf = (id: string | null): string => (id ? dName.get(id)?.name ?? 'Unknown DISCOM' : 'DISCOM not set');

  const obsByApp = new Map<string, Record<DiscomStage, StageObs | null>>();
  for (const a of apps) obsByApp.set(a.id, stageObservations(a, feasClock.get(a.id), f.nowMs));
  const breachesByApp = new Map(apps.map((a) => [a.id, deemedBreaches(a, feasClock.get(a.id), f.nowMs)]));

  const groups = new Map<string, DiscomApplication[]>();
  for (const a of apps) { const k = a.discom_id ?? 'none'; const g = groups.get(k) ?? []; g.push(a); groups.set(k, g); }

  const rows: DiscomAgeingRow[] = [...groups].map(([k, list]) => {
    const stages = {} as Record<DiscomStage, DiscomStageStats>;
    for (const st of DISCOM_STAGES) stages[st] = statsFor(list.map((a) => obsByApp.get(a.id)![st]));
    const d = k === 'none' ? null : dName.get(k) ?? null;
    return { discom_id: k === 'none' ? null : k, discom_code: d?.code ?? null, discom_name: nameOf(k === 'none' ? null : k), applications: list.length, stages, deemed_breaches: list.filter((a) => breachesByApp.get(a.id)!.length > 0).length };
  }).sort((a, b) => a.discom_name.localeCompare(b.discom_name));

  const overallStages = {} as Record<DiscomStage, DiscomStageStats>;
  for (const st of DISCOM_STAGES) overallStages[st] = apps.length ? statsFor(apps.map((a) => obsByApp.get(a.id)![st])) : emptyStats();
  const deemedApps = apps.filter((a) => breachesByApp.get(a.id)!.length > 0);
  const overall = { applications: apps.length, stages: overallStages, deemed_breaches: deemedApps.length };

  const breachList: DeemedBreachRow[] = [];
  for (const a of apps) {
    for (const b of breachesByApp.get(a.id)!) {
      breachList.push({ application_id: a.id, application_no: a.application_no, discom_id: a.discom_id, discom_name: nameOf(a.discom_id), clock: b.clock, due_at: b.due_at, days_over: b.days_over, sales_order_id: a.sales_order_id, path: entityPath('discom_application', a.id) });
    }
  }
  breachList.sort((x, y) => y.days_over - x.days_over);

  const kpis = DISCOM_STAGES.map((st) => kb.make(KPI_KEY[st], {
    value: overallStages[st].median_days,
    secondary: { label: '90th percentile', value: overallStages[st].p90_days },
    breakdown: rows.filter((r) => r.stages[st].n > 0 || r.stages[st].open > 0).map((r) => ({ key: r.discom_id ?? 'none', label: r.discom_name, value: r.stages[st].median_days, p90: r.stages[st].p90_days, n: r.stages[st].n, open: r.stages[st].open, oldest_open_days: r.stages[st].oldest_open_days })),
    note: overallStages[st].n === 0 ? (apps.length ? `No completed ${STAGE_LABEL[st].toLowerCase()} stages in the period` : 'No DISCOM applications submitted in the period') : undefined,
    links: [{ label: 'DISCOM applications', path: '/post-sale?tab=discom' }],
  }));
  kpis.push(kb.make('discom_deemed_breaches', {
    value: deemedApps.length,
    breakdown: rows.filter((r) => r.deemed_breaches > 0).map((r) => ({ key: r.discom_id ?? 'none', label: r.discom_name, value: r.deemed_breaches })),
    links: [{ label: 'DISCOM applications', path: '/post-sale?tab=discom' }],
  }));

  const details: Record<string, KpiDetail> = {};
  for (const st of DISCOM_STAGES) {
    details[KPI_KEY[st]] = {
      title: `${STAGE_LABEL[st]} ageing by DISCOM`,
      columns: [{ key: 'discom', label: 'DISCOM', type: 'text' }, { key: 'applications', label: 'Applications', type: 'int' }, { key: 'n', label: 'Completed', type: 'int' }, { key: 'median', label: 'Median days', type: 'days' }, { key: 'p90', label: '90th percentile days', type: 'days' }, { key: 'open', label: 'Open', type: 'int' }, { key: 'oldest', label: 'Oldest open (days)', type: 'days' }],
      rows: [...rows.map((r) => ({ discom: r.discom_name, applications: r.applications, n: r.stages[st].n, median: r.stages[st].median_days, p90: r.stages[st].p90_days, open: r.stages[st].open, oldest: r.stages[st].oldest_open_days })),
        { discom: 'All DISCOMs', applications: overall.applications, n: overallStages[st].n, median: overallStages[st].median_days, p90: overallStages[st].p90_days, open: overallStages[st].open, oldest: overallStages[st].oldest_open_days }],
    };
  }
  details['discom_deemed_breaches'] = {
    title: 'Deemed-clock breaches',
    columns: [{ key: 'application', label: 'Application', type: 'text' }, { key: 'discom', label: 'DISCOM', type: 'text' }, { key: 'clock', label: 'Clock', type: 'text' }, { key: 'due', label: 'Was due', type: 'datetime' }, { key: 'days_over', label: 'Days over', type: 'days' }],
    rows: breachList.map((b) => ({ application: b.application_no ?? b.application_id, discom: b.discom_name, clock: b.clock, due: b.due_at, days_over: b.days_over })),
  };
  return { kpis, extra: { rows, overall, deemed_breach_list: breachList }, details };
}
