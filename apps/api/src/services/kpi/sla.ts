import {
  entityPath, formatDuration, type Clock, type ClockType, type EscalationLevelRow, type EscalationTriggerRow, type Followup, type Kpi, type Lead,
  type OverdueFollowupRow, type SlaBreachRow, type SlaDashboard,
} from '@solar/shared';
import { CLOCK_LABEL } from '../clockService';
import { KpiBuilder, type Family, type KpiDetail } from './common';
import { entityLabels } from './labels';
import type { KpiScope } from './scope';
import { HOUR, MINUTE, ms, ratioPct, summarise, weekStartIst, round } from './stats';

const LEVEL_LABEL: Record<number, string> = { 1: 'Level 1 — DSM', 2: 'Level 2 — Sales Manager', 3: 'Level 3 — Management' };

/** Escalation-matrix triggers (reference chart Stage 6) mapped to the clock types that raise them. */
const TRIGGERS: { trigger: string; clock_types: ClockType[] }[] = [
  { trigger: 'Unaccepted lead', clock_types: ['lead_acceptance'] },
  { trigger: 'Overdue follow-up', clock_types: ['followup'] },
  { trigger: 'Pending approval', clock_types: ['approval'] },
  { trigger: 'Pending payment or credit', clock_types: ['payment_reminder'] },
  { trigger: 'No customer response', clock_types: ['quote_followup'] },
  { trigger: 'DISCOM clock breach', clock_types: ['discom_feasibility', 'discom_commissioning'] },
  { trigger: 'Legacy CFA claim / CFA release', clock_types: ['legacy_cfa_claim_deadline', 'cfa_release'] },
  { trigger: 'Dealer SOP', clock_types: ['sop_reply', 'sop_show_cause'] },
  { trigger: 'Other (grievance, loan, RMA, ALMM exemption)', clock_types: ['grievance', 'loan_ageing', 'warranty_rma', 'almm_exemption_commissioning'] },
];

const isOverdueClock = (c: Clock, nowMs: number): boolean => c.status === 'breached' || (c.status === 'running' && (ms(c.due_at) ?? Infinity) < nowMs);
const levelOf = (c: Clock): number => (c.status === 'breached' ? Math.max(1, c.escalated_level) : 1);

interface Tally { num: number; den: number }
const bump = (m: Map<string, Tally>, key: string, ok: boolean): void => {
  const t = m.get(key) ?? { num: 0, den: 0 };
  t.den++; if (ok) t.num++;
  m.set(key, t);
};
const tallyItems = (m: Map<string, Tally>, labelOf: (k: string) => string, top = 10) =>
  [...m].sort((a, b) => b[1].den - a[1].den).slice(0, top).map(([k, v]) => ({ key: k, label: labelOf(k), value: ratioPct(v.num, v.den), numerator: v.num, denominator: v.den }));

export async function computeSla(scope: KpiScope): Promise<Family<Pick<SlaDashboard, 'breaches' | 'overdue_followups' | 'escalations_by_level' | 'escalation_triggers'>>> {
  const { ctx, filters: f } = scope;
  const kb = await KpiBuilder.create(ctx, 'sla');
  const windowH = (await ctx.svc.rules.value<number>('reporting.first_response_window_hours', undefined, 24)) ?? 24;
  const hotMin = (await ctx.svc.rules.value<number>('reporting.first_response_hot_minutes', undefined, 30)) ?? 30;
  const leadMap = await scope.leadMap();

  /* ───────── first response ───────── */
  const cohort = (await scope.rows('leads', { created_at: { gte: f.fromIso, lte: f.toIso }, deleted_at: null })).filter((l) => l.status !== 'duplicate' && l.status !== 'merged');
  const cohortIds = new Set(cohort.map((l) => l.id));
  const logs = cohortIds.size ? await ctx.db.table('contact_logs').all({ direction: 'outbound', occurred_at: { gte: f.fromIso } }) : [];
  const firstLog = new Map<string, number>();
  for (const lg of logs) {
    if (!cohortIds.has(lg.lead_id)) continue;
    const t = ms(lg.occurred_at);
    if (t !== null && t < (firstLog.get(lg.lead_id) ?? Infinity)) firstLog.set(lg.lead_id, t);
  }
  interface Resp { lead: Lead; createdMs: number; firstMs: number | null; minutes: number | null }
  const resp: Resp[] = cohort.map((lead) => {
    const createdMs = ms(lead.created_at) ?? 0;
    const cands = [ms(lead.first_contacted_at), firstLog.get(lead.id) ?? null].filter((x): x is number => x !== null);
    const firstMs = cands.length ? Math.min(...cands) : null;
    return { lead, createdMs, firstMs, minutes: firstMs === null ? null : Math.max(0, (firstMs - createdMs) / MINUTE) };
  });
  const due24 = resp.filter((r) => r.firstMs !== null || r.createdMs + windowH * HOUR <= f.nowMs);
  const ok24 = (r: Resp) => r.minutes !== null && r.minutes <= windowH * 60;
  const dueHot = resp.filter((r) => r.lead.temperature === 'hot' && (r.firstMs !== null || r.createdMs + hotMin * MINUTE <= f.nowMs));
  const okHot = (r: Resp) => r.minutes !== null && r.minutes <= hotMin;
  const bySource24 = new Map<string, Tally>();
  for (const r of due24) bump(bySource24, r.lead.source, ok24(r));
  const bySourceHot = new Map<string, Tally>();
  for (const r of dueHot) bump(bySourceHot, r.lead.source, okHot(r));
  const weekly24 = new Map<string, Tally>();
  for (const r of due24) bump(weekly24, weekStartIst(r.createdMs), ok24(r));
  const contacted = resp.filter((r) => r.minutes !== null);
  const respStats = summarise(contacted.map((r) => r.minutes!));
  const bySourceMinutes = new Map<string, number[]>();
  for (const r of contacted) { const a = bySourceMinutes.get(r.lead.source) ?? []; a.push(r.minutes!); bySourceMinutes.set(r.lead.source, a); }

  /* ───────── clocks: lead acceptance (period) + open breaches (now) ───────── */
  const visibleOk = async (type: string, id: string): Promise<boolean> => {
    const ids = await scope.entityIds(type);
    return ids === 'all' || (ids !== null && ids.has(id));
  };
  const accClocksAll = await ctx.db.table('clocks').all({ clock_type: 'lead_acceptance', started_at: { gte: f.fromIso, lte: f.toIso } });
  const accClocks: Clock[] = [];
  for (const c of accClocksAll) if (c.status !== 'cancelled' && (await visibleOk('lead', c.entity_id))) accClocks.push(c);
  const accOutcome = (c: Clock): 'met' | 'breached' | 'pending' => (c.status === 'met' ? 'met' : isOverdueClock(c, f.nowMs) ? 'breached' : 'pending');
  const accResolved = accClocks.filter((c) => accOutcome(c) !== 'pending');
  const accMet = accResolved.filter((c) => accOutcome(c) === 'met').length;
  let accBreach = accResolved.length - accMet;
  const accOwner = new Map<string, Tally>();
  for (const c of accResolved) bump(accOwner, c.owner_id ?? 'unassigned', accOutcome(c) === 'met');
  // expired assignments that never got a clock row still count as breaches
  const clockLeads = new Set(accClocksAll.map((c) => c.entity_id));
  const expired = (await ctx.db.table('lead_assignments').all({ status: 'expired', assigned_at: { gte: f.fromIso, lte: f.toIso } })).filter((a) => !clockLeads.has(a.lead_id) && leadMap.has(a.lead_id));
  for (const a of expired) { accBreach++; bump(accOwner, a.assigned_to ?? 'unassigned', false); }

  const openClocksRaw = await ctx.db.table('clocks').all({ resolved_at: null, status: ['running', 'breached'] });
  const openBreaches: Clock[] = [];
  for (const c of openClocksRaw) if (isOverdueClock(c, f.nowMs) && (await visibleOk(c.entity_type, c.entity_id))) openBreaches.push(c);
  openBreaches.sort((a, b) => (ms(a.due_at) ?? 0) - (ms(b.due_at) ?? 0));

  /* ───────── follow-ups ───────── */
  const dueFollowupsAll = await ctx.db.table('followups').all({ due_at: { gte: f.fromIso, lte: f.toIso } });
  const dueFollowups = dueFollowupsAll.filter((fu) => fu.status !== 'cancelled' && (ms(fu.due_at) ?? Infinity) <= f.nowMs && leadMap.has(fu.lead_id));
  const onTime = (fu: Followup): boolean => fu.status === 'done' && (ms(fu.done_at) ?? Infinity) <= (ms(fu.due_at) ?? 0);
  const fuOwner = new Map<string, Tally>();
  const fuWeek = new Map<string, Tally>();
  for (const fu of dueFollowups) {
    bump(fuOwner, fu.owner_id ?? 'unassigned', onTime(fu));
    bump(fuWeek, weekStartIst(ms(fu.due_at) ?? 0), onTime(fu));
  }
  const overdueFus = (await ctx.db.table('followups').all({ status: 'open', due_at: { lt: f.now.toISOString() } }))
    .filter((fu) => leadMap.has(fu.lead_id))
    .sort((a, b) => (ms(a.due_at) ?? 0) - (ms(b.due_at) ?? 0));

  /* ───────── names / labels ───────── */
  const BREACH_CAP = 100;
  const shownBreaches = openBreaches.slice(0, BREACH_CAP);
  const shownFus = overdueFus.slice(0, BREACH_CAP);
  const ownerNames = await scope.names('profiles', [
    ...openBreaches.map((c) => c.owner_id), ...overdueFus.map((x) => x.owner_id), ...accResolved.map((c) => c.owner_id), ...dueFollowups.map((x) => x.owner_id), ...expired.map((a) => a.assigned_to),
  ]);
  const ownerLabel = (k: string): string => (k === 'unassigned' ? 'Unassigned' : ownerNames.get(k) ?? 'Unknown user');
  const labels = await entityLabels(ctx, shownBreaches.map((c) => ({ type: c.entity_type, id: c.entity_id })));

  const toBreachRow = (c: Clock): SlaBreachRow => {
    const ageMs = Math.max(0, f.nowMs - (ms(c.due_at) ?? f.nowMs));
    const level = levelOf(c);
    return {
      clock_id: c.id, clock_type: c.clock_type, label: CLOCK_LABEL[c.clock_type], entity_type: c.entity_type, entity_id: c.entity_id,
      entity_label: labels.get(`${c.entity_type}:${c.entity_id}`) ?? null, owner_id: c.owner_id, owner_name: c.owner_id ? ownerNames.get(c.owner_id) ?? null : null,
      due_at: c.due_at, age_minutes: Math.round(ageMs / MINUTE), age_label: formatDuration(ageMs), escalated_level: level, level_label: LEVEL_LABEL[Math.min(3, level)]!, status: c.status, path: entityPath(c.entity_type, c.entity_id),
    };
  };
  const toFuRow = (fu: Followup): OverdueFollowupRow => {
    const overMs = Math.max(0, f.nowMs - (ms(fu.due_at) ?? f.nowMs));
    return {
      followup_id: fu.id, lead_id: fu.lead_id, lead_name: leadMap.get(fu.lead_id)?.name ?? 'Lead', kind: fu.kind, due_at: fu.due_at, overdue_minutes: Math.round(overMs / MINUTE), overdue_label: formatDuration(overMs),
      owner_id: fu.owner_id, owner_name: fu.owner_id ? ownerNames.get(fu.owner_id) ?? null : null, escalated_level: fu.escalated_level, path: entityPath('lead', fu.lead_id),
    };
  };
  const breaches = shownBreaches.map(toBreachRow);
  const overdue_followups = shownFus.map(toFuRow);

  const levelCounts = [1, 2, 3].map((lv) => openBreaches.filter((c) => Math.min(3, levelOf(c)) === lv).length);
  const escalations_by_level: EscalationLevelRow[] = [1, 2, 3].map((lv, i) => ({ level: lv as 1 | 2 | 3, label: LEVEL_LABEL[lv]!, count: levelCounts[i]! }));
  const escalation_triggers: EscalationTriggerRow[] = TRIGGERS.map((t) => ({ ...t, count: openBreaches.filter((c) => t.clock_types.includes(c.clock_type)).length }));
  const byType = new Map<ClockType, number>();
  for (const c of openBreaches) byType.set(c.clock_type, (byType.get(c.clock_type) ?? 0) + 1);

  /* ───────── KPI tiles ───────── */
  const kpis: Kpi[] = [];
  kpis.push(kb.make('lead_acceptance_sla_pct', {
    value: ratioPct(accMet, accMet + accBreach), breakdown: tallyItems(accOwner, ownerLabel),
    secondary: { label: 'Accepted in time', value: accMet, unit: 'count' },
  }));
  kpis.push(kb.make('lead_acceptance_breaches', {
    value: accBreach,
    breakdown: [...accOwner].filter(([, v]) => v.den - v.num > 0).sort((a, b) => (b[1].den - b[1].num) - (a[1].den - a[1].num)).slice(0, 10).map(([k, v]) => ({ key: k, label: ownerLabel(k), value: v.den - v.num })),
    links: [{ label: 'Leads awaiting acceptance', path: '/leads?status=assigned' }],
  }));
  kpis.push(kb.make('first_response_24h_pct', {
    value: ratioPct(due24.filter(ok24).length, due24.length), breakdown: tallyItems(bySource24, (k) => k.replace(/_/g, ' ')),
    series: [...weekly24].sort((a, b) => a[0].localeCompare(b[0])).map(([x, v]) => ({ x, y: ratioPct(v.num, v.den) })),
    secondary: { label: 'Responses due', value: due24.length, unit: 'count' },
  }));
  kpis.push(kb.make('first_response_hot_30min_pct', {
    value: ratioPct(dueHot.filter(okHot).length, dueHot.length), breakdown: tallyItems(bySourceHot, (k) => k.replace(/_/g, ' ')),
    secondary: { label: 'HOT responses due', value: dueHot.length, unit: 'count' },
  }));
  kpis.push(kb.make('first_response_median_minutes', {
    value: respStats.median, secondary: { label: '90th percentile', value: respStats.p90 },
    breakdown: [...bySourceMinutes].map(([k, v]) => ({ key: k, label: k.replace(/_/g, ' '), value: summarise(v).median, n: v.length })),
  }));
  kpis.push(kb.make('followup_compliance_pct', {
    value: ratioPct(dueFollowups.filter(onTime).length, dueFollowups.length), breakdown: tallyItems(fuOwner, ownerLabel),
    series: [...fuWeek].sort((a, b) => a[0].localeCompare(b[0])).map(([x, v]) => ({ x, y: ratioPct(v.num, v.den) })),
    secondary: { label: 'Follow-ups due', value: dueFollowups.length, unit: 'count' },
  }));
  const fuOwnerOverdue = new Map<string, number>();
  for (const fu of overdueFus) fuOwnerOverdue.set(fu.owner_id ?? 'unassigned', (fuOwnerOverdue.get(fu.owner_id ?? 'unassigned') ?? 0) + 1);
  kpis.push(kb.make('overdue_followups', {
    value: overdueFus.length, breakdown: [...fuOwnerOverdue].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => ({ key: k, label: ownerLabel(k), value: v })),
    links: [{ label: 'Overdue follow-ups', path: '/leads?followup=overdue' }],
  }));
  kpis.push(kb.make('sla_breaches_open', {
    value: openBreaches.length, breakdown: [...byType].sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ key: k, label: CLOCK_LABEL[k], value: v })),
  }));
  kpis.push(kb.make('escalations_open', {
    value: levelCounts[1]! + levelCounts[2]!, breakdown: escalations_by_level.map((e) => ({ key: String(e.level), label: e.label, value: e.count })),
  }));

  /* ───────── export details ───────── */
  const details: Record<string, KpiDetail> = {};
  const accDetail: KpiDetail = {
    title: 'Lead acceptance clocks',
    columns: [{ key: 'lead', label: 'Lead', type: 'text' }, { key: 'owner', label: 'Owner', type: 'text' }, { key: 'started', label: 'Assigned at', type: 'datetime' }, { key: 'due', label: 'Accept by', type: 'datetime' }, { key: 'status', label: 'Clock status', type: 'text' }, { key: 'outcome', label: 'Outcome', type: 'text' }],
    rows: accClocks.map((c) => ({ lead: leadMap.get(c.entity_id)?.name ?? 'Lead', owner: c.owner_id ? ownerNames.get(c.owner_id) ?? null : null, started: c.started_at, due: c.due_at, status: c.status, outcome: accOutcome(c) })),
  };
  details['lead_acceptance_sla_pct'] = accDetail;
  details['lead_acceptance_breaches'] = { ...accDetail, rows: accDetail.rows.filter((r) => r['outcome'] === 'breached') };
  const respDetail: KpiDetail = {
    title: 'First response per lead',
    columns: [{ key: 'lead', label: 'Lead', type: 'text' }, { key: 'source', label: 'Source', type: 'text' }, { key: 'temperature', label: 'Temperature', type: 'text' }, { key: 'created', label: 'Captured at', type: 'datetime' }, { key: 'first', label: 'First contact', type: 'datetime' }, { key: 'minutes', label: 'Minutes to first response', type: 'minutes' }, { key: 'within_window', label: `Within ${windowH} h`, type: 'text' }, { key: 'within_hot', label: `Within ${hotMin} min`, type: 'text' }],
    rows: resp.map((r) => ({ lead: r.lead.name, source: r.lead.source, temperature: r.lead.temperature, created: r.lead.created_at, first: r.firstMs === null ? null : new Date(r.firstMs).toISOString(), minutes: r.minutes === null ? null : round(r.minutes, 1), within_window: r.firstMs === null ? 'Not contacted' : ok24(r) ? 'Yes' : 'No', within_hot: r.lead.temperature !== 'hot' ? 'n/a' : r.firstMs === null ? 'Not contacted' : okHot(r) ? 'Yes' : 'No' })),
  };
  details['first_response_24h_pct'] = respDetail; details['first_response_hot_30min_pct'] = respDetail; details['first_response_median_minutes'] = respDetail;
  details['followup_compliance_pct'] = {
    title: 'Follow-ups due in the period',
    columns: [{ key: 'lead', label: 'Lead', type: 'text' }, { key: 'kind', label: 'Kind', type: 'text' }, { key: 'owner', label: 'Owner', type: 'text' }, { key: 'due', label: 'Due at', type: 'datetime' }, { key: 'done', label: 'Done at', type: 'datetime' }, { key: 'status', label: 'Status', type: 'text' }, { key: 'on_time', label: 'On time', type: 'text' }],
    rows: dueFollowups.map((fu) => ({ lead: leadMap.get(fu.lead_id)?.name ?? 'Lead', kind: fu.kind, owner: fu.owner_id ? ownerNames.get(fu.owner_id) ?? null : null, due: fu.due_at, done: fu.done_at, status: fu.status, on_time: onTime(fu) ? 'Yes' : 'No' })),
  };
  details['overdue_followups'] = {
    title: 'Overdue follow-ups',
    columns: [{ key: 'lead', label: 'Lead', type: 'text' }, { key: 'kind', label: 'Kind', type: 'text' }, { key: 'owner', label: 'Owner', type: 'text' }, { key: 'due', label: 'Was due', type: 'datetime' }, { key: 'overdue', label: 'Overdue by', type: 'text' }, { key: 'level', label: 'Escalation level', type: 'int' }],
    rows: overdueFus.map((fu) => { const r = toFuRow(fu); return { lead: r.lead_name, kind: r.kind, owner: r.owner_name, due: r.due_at, overdue: r.overdue_label, level: r.escalated_level }; }),
  };
  const allLabels = await entityLabels(ctx, openBreaches.slice(0, 2000).map((c) => ({ type: c.entity_type, id: c.entity_id })));
  const breachDetail: KpiDetail = {
    title: 'Open SLA breaches',
    columns: [{ key: 'clock', label: 'Clock', type: 'text' }, { key: 'entity', label: 'Record', type: 'text' }, { key: 'owner', label: 'Owner', type: 'text' }, { key: 'due', label: 'Was due', type: 'datetime' }, { key: 'age', label: 'Overdue by', type: 'text' }, { key: 'level', label: 'Escalation level', type: 'text' }],
    rows: openBreaches.map((c) => ({ clock: CLOCK_LABEL[c.clock_type], entity: allLabels.get(`${c.entity_type}:${c.entity_id}`) ?? c.entity_type, owner: c.owner_id ? ownerNames.get(c.owner_id) ?? null : null, due: c.due_at, age: formatDuration(Math.max(0, f.nowMs - (ms(c.due_at) ?? f.nowMs))), level: LEVEL_LABEL[Math.min(3, levelOf(c))]! })),
  };
  details['sla_breaches_open'] = breachDetail; details['escalations_open'] = breachDetail;

  return { kpis, extra: { breaches, overdue_followups, escalations_by_level, escalation_triggers }, details };
}
