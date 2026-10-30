import { describe, expect, it } from 'vitest';
import type { Kpi, SlaDashboard } from '@solar/shared';
import { IDS, MIN, ago, ahead, id, makeEnv, seeder, type Seeder } from './fixtures';
import type { TestEnv } from '../helpers/env';

const plus = (iso: string, minutes: number): string => new Date(Date.parse(iso) + minutes * MIN).toISOString();

/**
 * SLA fixture ("now" = Mon 26-Oct-2026 10:30 IST):
 *  first response — L1 hot, 10 min · L2 hot, 45 min · L3 warm, 30 h · L4 warm, never (5 days) · L5 hot, 1 h old, never · L6 hot, 10 min old · L7 warm, contact log after 20 min · L8 duplicate
 *  follow-ups     — due & counted: F1 done early ✓, F2 done late ✗, F3 missed ✗, F4 open overdue ✗, F7 done exactly on time ✓ → 2 of 5 = 40 %
 *  clocks         — acceptance: C1 met, C2 breached (resolved), C3 breached L2 open, C4 running past due, C5 running not due, C6 cancelled; + approval clock C7 breached L3 open
 */
async function seedSla(s: Seeder) {
  const A = IDS.distributorA, B = IDS.distributorB;
  const created = ago(5);
  await s.lead(1, { temperature: 'hot', distributor_id: A, created_at: created, first_contacted_at: plus(created, 10), source: 'website' });
  await s.lead(2, { temperature: 'hot', distributor_id: A, created_at: created, first_contacted_at: plus(created, 45), source: 'website' });
  await s.lead(3, { temperature: 'warm', distributor_id: B, created_at: created, first_contacted_at: plus(created, 30 * 60), source: 'call_centre' });
  await s.lead(4, { temperature: 'warm', distributor_id: B, created_at: created, source: 'call_centre' });
  await s.lead(5, { temperature: 'hot', distributor_id: B, created_at: ago(0, 1), source: 'website' });
  await s.lead(6, { temperature: 'hot', distributor_id: B, created_at: ago(0, 0, 10), source: 'website' });
  await s.lead(7, { temperature: 'warm', distributor_id: B, created_at: created, source: 'referral' });
  await s.contactLog(1, 7, { occurred_at: plus(created, 20) });
  await s.lead(8, { status: 'duplicate', distributor_id: B, created_at: created });
  await s.lead(9, { distributor_id: B, created_at: ago(200) }); // older lead, only used for an expired assignment

  const dsm = IDS.profile('dsm');
  await s.followup(1, 1, { due_at: ago(3), status: 'done', done_at: plus(ago(3), -60) });
  await s.followup(2, 1, { due_at: ago(2), status: 'done', done_at: plus(ago(2), 120) });
  await s.followup(3, 2, { due_at: ago(2), status: 'missed' });
  await s.followup(4, 3, { due_at: ago(1), status: 'open', owner_id: dsm });
  await s.followup(5, 3, { due_at: ahead(1), status: 'open' });
  await s.followup(6, 4, { due_at: ago(4), status: 'cancelled' });
  await s.followup(7, 4, { due_at: ago(1, 3), status: 'done', done_at: ago(1, 3) });

  await s.clock(1, { entity_id: id('lead', 1), status: 'met', resolved_at: ago(5), started_at: created, due_at: plus(created, 30) });
  await s.clock(2, { entity_id: id('lead', 2), status: 'breached', escalated_level: 1, resolved_at: ago(4), started_at: created, due_at: plus(created, 30) });
  await s.clock(3, { entity_id: id('lead', 3), status: 'breached', escalated_level: 2, owner_id: dsm, started_at: ago(4), due_at: ago(3) });
  await s.clock(4, { entity_id: id('lead', 4), status: 'running', started_at: ago(2), due_at: ago(1) });
  await s.clock(5, { entity_id: id('lead', 5), status: 'running', started_at: ago(0, 1), due_at: ahead(0, 1) });
  await s.clock(6, { entity_id: id('lead', 6), status: 'cancelled', started_at: ago(1), due_at: ago(0, 20) });
  await s.quote(7, 99, { quote_no: 'QT-7' });
  await s.clock(7, { entity_type: 'quotation', entity_id: id('quote', 7), clock_type: 'approval', status: 'breached', escalated_level: 3, started_at: ago(3), due_at: ago(2) });
  await s.assignment(1, 9, { status: 'expired', assigned_at: ago(3), due_at: ago(3) });
}

const kpi = (d: SlaDashboard, key: string): Kpi => d.kpis.find((k) => k.key === key)!;
const get = async (env: TestEnv, who: string, qs = ''): Promise<SlaDashboard> => (await env.as(who).get(`/api/v1/dashboards/sla${qs}`).expect(200)).body.data;

describe('GET /dashboards/sla', () => {
  it('computes first response within 24 h, HOT within 30 min, and the median time', async () => {
    const env = makeEnv();
    await seedSla(seeder(env));
    const d = await get(env, 'management');

    // due: L1 L2 L3 L4 L7 (L5/L6 still inside their 24 h window; the duplicate is ignored) → 3 on time
    expect(kpi(d, 'first_response_24h_pct')).toMatchObject({ value: 60, secondary: { value: 5 } });
    // HOT & due: L1 (contacted), L2 (contacted), L5 (30 min elapsed) → only L1 within 30 min
    expect(kpi(d, 'first_response_hot_30min_pct')).toMatchObject({ value: 33.3, secondary: { value: 3 } });
    // contacted: 10, 20, 45, 1800 minutes
    expect(kpi(d, 'first_response_median_minutes')).toMatchObject({ value: 32.5, unit: 'minutes', secondary: { value: 1273.5 } });
    const bySource = kpi(d, 'first_response_24h_pct').breakdown!;
    expect(bySource.find((b) => b.key === 'website')).toMatchObject({ numerator: 2, denominator: 2, value: 100 });
    expect(bySource.find((b) => b.key === 'call_centre')).toMatchObject({ numerator: 0, denominator: 2, value: 0 });
  });

  it('computes follow-up compliance (on-time ÷ due) and lists overdue follow-ups with owner and age', async () => {
    const env = makeEnv();
    await seedSla(seeder(env));
    const d = await get(env, 'management');

    expect(kpi(d, 'followup_compliance_pct')).toMatchObject({ value: 40, unit: 'pct', secondary: { value: 5 } });
    // operating-default target 90 (rule absent → documented fallback) is not met
    expect(kpi(d, 'followup_compliance_pct').target).toMatchObject({ value: 90, direction: 'at_least', met: false, rule: 'kpi.target.follow_up_compliance_pct' });
    expect(kpi(d, 'overdue_followups').value).toBe(1);
    expect(d.overdue_followups).toHaveLength(1);
    expect(d.overdue_followups[0]).toMatchObject({ lead_name: 'Lead 3', owner_name: 'Test dsm', kind: 'call', path: `/leads/${id('lead', 3)}` });
    expect(d.overdue_followups[0]!.overdue_minutes).toBe(Math.round(((env.now().getTime() - Date.parse(ago(1))) / 60000)));
  });

  it('target comes from rule_config when set', async () => {
    const env = makeEnv();
    await seedSla(seeder(env));
    await env.rule('kpi.target.follow_up_compliance_pct', 30);
    const d = await get(env, 'management');
    expect(kpi(d, 'followup_compliance_pct').target).toMatchObject({ value: 30, met: true });
  });

  it('computes lead-acceptance SLA from clocks and expired assignments', async () => {
    const env = makeEnv();
    await seedSla(seeder(env));
    const d = await get(env, 'management');
    // met: C1 · breached: C2, C3, C4 (running past due) + the expired assignment that never had a clock · pending C5 and cancelled C6 excluded
    expect(kpi(d, 'lead_acceptance_breaches').value).toBe(4);
    expect(kpi(d, 'lead_acceptance_sla_pct')).toMatchObject({ value: 20, secondary: { value: 1 } });
  });

  it('lists open SLA breaches with owner and age, and counts escalations by level', async () => {
    const env = makeEnv();
    await seedSla(seeder(env));
    const d = await get(env, 'management');

    expect(kpi(d, 'sla_breaches_open').value).toBe(3); // C3, C4, C7 (C2 is resolved, C5 not due, C6 cancelled)
    expect(d.breaches.map((b) => b.clock_id)).toEqual([id('clock', 3), id('clock', 7), id('clock', 4)]); // oldest deadline first
    const c3 = d.breaches.find((b) => b.clock_id === id('clock', 3))!;
    expect(c3).toMatchObject({ clock_type: 'lead_acceptance', owner_name: 'Test dsm', escalated_level: 2, level_label: 'Level 2 — Sales Manager', entity_label: 'Lead 3' });
    expect(c3.age_minutes).toBe(Math.round((env.now().getTime() - Date.parse(ago(3))) / 60000));
    expect(d.breaches.find((b) => b.clock_id === id('clock', 7))).toMatchObject({ entity_label: 'QT-7', level_label: 'Level 3 — Management' });

    expect(d.escalations_by_level.map((e) => e.count)).toEqual([1, 1, 1]);
    expect(kpi(d, 'escalations_open').value).toBe(2);
    expect(d.escalation_triggers.find((t) => t.trigger === 'Unaccepted lead')!.count).toBe(2);
    expect(d.escalation_triggers.find((t) => t.trigger === 'Pending approval')!.count).toBe(1);
  });

  it('weekly series are emitted for the on-time KPIs', async () => {
    const env = makeEnv();
    await seedSla(seeder(env));
    const d = await get(env, 'management');
    const series = kpi(d, 'followup_compliance_pct').series!;
    expect(series.length).toBeGreaterThan(0);
    for (const p of series) expect(p.x).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('a distributor user sees only the breaches, follow-ups and responses of their own leads', async () => {
    const env = makeEnv();
    await seedSla(seeder(env));
    const d = await get(env, 'distributor_user'); // distributor A owns L1 and L2
    expect(kpi(d, 'first_response_24h_pct')).toMatchObject({ value: 100, secondary: { value: 2 } });
    expect(kpi(d, 'first_response_hot_30min_pct')).toMatchObject({ value: 50 });
    expect(kpi(d, 'followup_compliance_pct')).toMatchObject({ value: 33.3, secondary: { value: 3 } });
    expect(kpi(d, 'overdue_followups').value).toBe(0);
    expect(kpi(d, 'sla_breaches_open').value).toBe(0);
    expect(d.breaches).toEqual([]);
    expect(kpi(d, 'lead_acceptance_breaches').value).toBe(1); // C2 only
    // and the other distributor's user sees theirs, not A's
    const b = await get(env, IDS.distributorUserB);
    expect(b.overdue_followups.map((x) => x.lead_name)).toEqual(['Lead 3']);
    expect(b.breaches.map((x) => x.clock_id).sort()).toEqual([id('clock', 3), id('clock', 4)].sort()); // the quotation clock (C7) is not visible to either external party
  });

  it('the period filter limits the response cohort', async () => {
    const env = makeEnv();
    await seedSla(seeder(env));
    // a window that only covers the last 12 hours sees only L5 and L6 (both inside their 24 h window → no response due)
    const today = env.now().toISOString().slice(0, 10);
    const d = await get(env, 'management', `?from=${today}&to=${today}`);
    expect(kpi(d, 'first_response_24h_pct').value).toBeNull();
    expect(kpi(d, 'first_response_hot_30min_pct')).toMatchObject({ value: 0, secondary: { value: 1 } }); // L5 only (1 h old, never contacted)
  });
});
