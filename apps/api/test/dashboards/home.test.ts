import { describe, expect, it } from 'vitest';
import type { HomeDashboard, HomeSection } from '@solar/shared';
import { IDS, ago, ahead, dateOffset, id, makeEnv, seeder, type Seeder } from './fixtures';
import type { TestEnv } from '../helpers/env';

/**
 * Home-queue fixture — distributor A's world plus a little of distributor B's:
 *  leads: L1 (A, assigned, HOT, acceptance deadline 30 min ago) · L2 (A, assigned, acceptance in 2 h) · L3 (B, assigned)
 *  follow-ups: F1 L1 overdue (owner dsm) · F2 L2 due this afternoon · F3 L3 (B) overdue · F4 L1 done
 *  approvals: ap1 commercial step 1 (dsm, due in 4 h) · ap2 step 2 (sales manager, not yet actionable) · ap3 commercial (dsm, overdue) · ap4 credit (accounts)
 *  quotes: q1 re-quote required (A) · q2 approved (A) · q3 blocked (A) · q4 approved (B)
 *  money: PI-1 issued awaiting advance (A) · PI-2 already has an SO · credit check pending (dealer A1) · SO-1 on hold · dispatch DN-1 blocked (A) and DN-2 blocked (B)
 *  DISCOM/CFA: feasibility clock ends in 2 d · commissioning overdue · CFA release due tomorrow · legacy claim K1 (₹78,000)
 *  dealer: A2 over its limit · calendar: one item in 10 days, one in 100 days
 */
async function seedHome(s: Seeder) {
  const A = IDS.distributorA, B = IDS.distributorB, dsm = IDS.profile('dsm');
  await s.lead(1, { status: 'assigned', temperature: 'hot', distributor_id: A, created_at: ago(1), sla_due_at: ago(0, 0, 30), city: 'Surat', capacity_kw: 5 });
  await s.lead(2, { status: 'assigned', temperature: 'warm', distributor_id: A, created_at: ago(1), sla_due_at: ahead(0, 2) });
  await s.lead(3, { status: 'assigned', temperature: 'warm', distributor_id: B, created_at: ago(1), sla_due_at: ahead(1) });
  await s.followup(1, 1, { due_at: ago(0, 2), owner_id: dsm, note: 'Call back about roof photos' });
  await s.followup(2, 2, { due_at: ahead(0, 3) });
  await s.followup(3, 3, { due_at: ago(0, 1) });
  await s.followup(4, 1, { due_at: ago(0, 5), status: 'done', done_at: ago(0, 5) });

  await s.opp(1, 1, { distributor_id: A, stage: 'qualified', expected_value: 200_000 });
  await s.opp(2, 2, { distributor_id: A, stage: 'won', expected_value: 999_999 });
  await s.quote(1, 1, { status: 'requote_required', requote_reason: 'GST rate changed', distributor_id: A, owner_id: dsm });
  await s.quote(2, 1, { status: 'approved', distributor_id: A });
  await s.quote(3, 1, { status: 'blocked', distributor_id: A });
  await s.quote(4, 1, { status: 'approved', distributor_id: B });
  await s.approval(1, { entity_id: id('quote', 1), step: 1, required_role: 'dsm', due_at: ahead(0, 4) });
  await s.approval(2, { entity_id: id('quote', 1), step: 2, required_role: 'sales_manager', due_at: ahead(1) });
  await s.approval(3, { entity_id: id('quote', 2), step: 1, required_role: 'dsm', due_at: ago(0, 1) });
  await s.approval(4, { entity_id: id('quote', 4), lane: 'credit', step: 1, required_role: 'accounts', due_at: ahead(2) });

  await s.pi(1, 1, { distributor_id: A, status: 'issued', legal_name: 'Patel Foods' });
  await s.pi(2, 2, { distributor_id: A, status: 'issued', sales_order_id: id('so', 2) });
  await s.creditCheck(1, { dealer_id: IDS.dealerA1, distributor_id: A });
  await s.so(1, 1, 1, { distributor_id: A, status: 'on_hold', hold_reason: 'Waiting for advance' });
  await s.so(2, 2, 2, { distributor_id: A, status: 'approved' });
  await s.so(3, 2, 4, { distributor_id: B, status: 'approved' });
  await s.dispatch(1, 1, { compliance_findings: [{ gate: 'G3', severity: 'hard_stop', message: 'Serial SN-9 is not on ALMM List-I', ruleIds: [], fieldRefs: [] }] });
  await s.dispatch(2, 3);

  await s.discomApp(1, { distributor_id: A, feasibility_status: 'pending', feasibility_due_at: ahead(2) });
  await s.discomApp(2, { distributor_id: A, certificate_submitted_at: ago(20), commissioning_due_at: ago(1) });
  await s.claim(1, { distributor_id: A, dealer_id: IDS.dealerA1, status: 'claimed', cohort: 'legacy', cfa_computed: 78_000 });
  await s.claim(2, { distributor_id: A, dealer_id: IDS.dealerA1, status: 'claimed', discom_approval_at: ago(14) });

  await s.db.table('dealers').update(IDS.dealerA2, { credit_limit: 100_000 });
  await s.receivable(1, IDS.dealerA2, { distributor_id: A, amount: 150_000, invoice_date: dateOffset(-20), due_date: dateOffset(-5) });
  await s.calendar(1, dateOffset(10), { title: 'DPDP Consent Manager registration' });
  await s.calendar(2, dateOffset(100), { title: 'Far future date' });
}

const get = async (env: TestEnv, who: string, qs = ''): Promise<HomeDashboard> => (await env.as(who).get(`/api/v1/dashboards/home${qs}`).expect(200)).body.data;
const section = (d: HomeDashboard, key: string): HomeSection => d.sections.find((s) => s.key === key)!;

describe('GET /dashboards/home — role-aware Today queue', () => {
  it('a distributor user gets leads awaiting acceptance (with time left), follow-ups, quotes, payments, holds, blocked dispatch and deadlines for their own party only', async () => {
    const env = makeEnv();
    await seedHome(seeder(env));
    const d = await get(env, 'distributor_user');

    expect(d.user).toMatchObject({ role: 'distributor_user', role_label: 'Distributor' });
    const accept = section(d, 'leads_awaiting_acceptance');
    expect(accept.count).toBe(2); // L3 belongs to distributor B
    expect(accept.items[0]).toMatchObject({ title: 'Lead 1', overdue: true, path: `/leads/${id('lead', 1)}`, badge: 'Hot' });
    expect(accept.items[0]!.time_left_minutes).toBe(-30);
    expect(accept.items[0]!.time_left_label).toBe('30 min overdue');
    expect(accept.items[1]).toMatchObject({ title: 'Lead 2', overdue: false, time_left_minutes: 120, time_left_label: '2 h left' });
    expect(accept.severity).toBe('critical');

    const fu = section(d, 'followups_due');
    expect(fu.count).toBe(2);
    expect(fu.items.map((i) => i.title)).toEqual(['Call — Lead 1', 'Call — Lead 2']);
    expect(fu.meta).toMatchObject({ overdue: 1, due_today: 1 });

    const quotes = section(d, 'quotes_to_send');
    expect(quotes.count).toBe(2);
    expect(quotes.items[0]).toMatchObject({ badge: 'Re-quote required', path: `/quotes/${id('quote', 1)}` });
    expect(quotes.meta).toMatchObject({ requote_required: 1, ready_to_send: 1, blocked: 1 });

    const pay = section(d, 'payments_credit');
    expect(pay.count).toBe(2);
    expect(pay.meta).toMatchObject({ invoices: 1, credit_checks: 1 });
    expect(section(d, 'so_on_hold').items[0]).toMatchObject({ title: 'SO-1 on hold', subtitle: 'Waiting for advance', path: `/orders/${id('so', 1)}` });
    const blocked = section(d, 'dispatch_blocked');
    expect(blocked.count).toBe(1); // DN-2 is distributor B's
    expect(blocked.items[0]!.subtitle).toBe('G3: Serial SN-9 is not on ALMM List-I');
    expect(blocked.severity).toBe('critical');

    const near = section(d, 'discom_cfa_deadlines');
    expect(near.count).toBe(3); // feasibility clock (2 d), commissioning overdue, CFA release due tomorrow
    expect(near.items[0]).toMatchObject({ overdue: true });
    expect(near.items.map((i) => i.badge).sort()).toEqual(['CFA', 'DISCOM', 'DISCOM']);

    const legacy = section(d, 'legacy_cfa_claims');
    expect(legacy.count).toBe(1);
    expect(legacy.headline).toContain('35 days to 30-Nov-2026');
    expect(legacy.meta).toMatchObject({ days_to_deadline: 35, deadline: '2026-11-30', value: 78_000, advisory: true });
    expect(legacy.severity).toBe('warning');

    const dealers = section(d, 'dealer_alerts');
    expect(dealers.count).toBe(1);
    expect(dealers.items[0]).toMatchObject({ title: 'Bright Roofs', path: `/dealers/${IDS.dealerA2}` });
    expect(dealers.items[0]!.subtitle).toBe('Over limit by ₹ 50,000');

    const cal = section(d, 'compliance_calendar');
    expect(cal.items.map((i) => i.title)).toEqual(['DPDP Consent Manager registration']);

    // not for external users
    for (const k of ['approvals_waiting', 'stock_exposure']) expect(d.sections.find((s) => s.key === k)).toBeUndefined();
  });

  it('summary tiles and next-best-action', async () => {
    const env = makeEnv();
    await seedHome(seeder(env));
    const d = await get(env, 'distributor_user');
    const tile = (k: string) => d.summary.find((t) => t.key === k)!;
    expect(tile('open_leads').value).toBe(2);
    expect(tile('hot_leads').value).toBe(1);
    expect(tile('pipeline_inr').value).toBe(200_000); // the won opportunity is not pipeline
    expect(tile('orders_this_month').value).toBe(2);
    expect(d.next_best_action).toMatchObject({ severity: 'critical', path: `/leads/${id('lead', 1)}` });
    expect(d.next_best_action!.text).toContain('Accept "Lead 1"');
  });

  it('a DSM sees approvals waiting for their role with SLA time left, only the current step', async () => {
    const env = makeEnv();
    await seedHome(seeder(env));
    const dsm = await get(env, 'dsm');
    const ap = section(dsm, 'approvals_waiting');
    expect(ap.count).toBe(2);
    expect(ap.items.map((i) => [i.title, i.overdue])).toEqual([['Commercial approval — QT-2', true], ['Commercial approval — QT-1', false]]);
    expect(ap.items[1]).toMatchObject({ time_left_minutes: 240, time_left_label: '4 h left', path: `/quotes/${id('quote', 1)}` });
    // the DSM sees all assigned leads in scope (internal, no territory restriction)
    expect(section(dsm, 'leads_awaiting_acceptance').count).toBe(3);
    // the sales manager's step is not actionable until the DSM has approved
    const sm = await get(env, 'sales_manager');
    expect(section(sm, 'approvals_waiting').count).toBe(0);
    const acc = await get(env, 'accounts');
    expect(section(acc, 'approvals_waiting').items.map((i) => i.title)).toEqual(['Credit approval — QT-4']);
    expect(dsm.next_best_action!.text).toMatch(/Accept "Lead 1"|Decide on/);
  });

  it('sections follow the role: accounts get payments/credit, dispatch gets blocked dispatches, viewers get headlines only', async () => {
    const env = makeEnv();
    await seedHome(seeder(env));
    const keys = async (who: string) => (await get(env, who)).sections.map((s) => s.key);
    const acc = await keys('accounts');
    expect(acc).toContain('payments_credit');
    expect(acc).not.toContain('leads_awaiting_acceptance');
    expect((await get(env, 'accounts')).sections.find((s) => s.key === 'payments_credit')!.items[0]!.badge).toBe('Credit lane'); // credit decisions first for accounts
    const disp = await keys('dispatch');
    expect(disp).toContain('dispatch_blocked');
    expect(disp).not.toContain('payments_credit');
    const co = await keys('compliance_officer');
    expect(co).toEqual(expect.arrayContaining(['approvals_waiting', 'dispatch_blocked', 'consent_coverage', 'compliance_calendar']));
    const viewer = await keys('viewer');
    expect(viewer).not.toContain('approvals_waiting');
    expect(viewer).toContain('compliance_calendar');
    const admin = await keys('admin');
    expect(admin.length).toBe(13);
    // internal roles with stock responsibility see the headline
    const mgmt = await get(env, 'management');
    expect(section(mgmt, 'stock_exposure').headline).toMatch(/non-List-II unit/);
    expect(section(mgmt, 'consent_coverage').headline).toBeTruthy();
  });

  it('shows only the top 5 items per section but the full count, and calls out an all-clear', async () => {
    const env = makeEnv();
    const s = seeder(env);
    for (let n = 1; n <= 8; n++) await s.lead(n, { status: 'assigned', distributor_id: IDS.distributorA, created_at: ago(1), sla_due_at: ahead(0, n) });
    const d = await get(env, 'distributor_user');
    const accept = section(d, 'leads_awaiting_acceptance');
    expect(accept.count).toBe(8);
    expect(accept.items).toHaveLength(5);
    expect(accept.items.map((i) => i.title)).toEqual(['Lead 1', 'Lead 2', 'Lead 3', 'Lead 4', 'Lead 5']); // soonest deadline first

    const quiet = await get(makeEnv(), 'dealer_user');
    expect(quiet.next_best_action).toMatchObject({ severity: 'info', path: '/leads' });
    expect(quiet.next_best_action!.text).toMatch(/all caught up/i);
  });

  it('a dealer user only gets their own dealer\'s items', async () => {
    const env = makeEnv();
    await seedHome(seeder(env));
    const d = await get(env, 'dealer_user'); // dealer A1
    // leads are scoped by dealer_id: none of the fixture leads carry dealer A1 → nothing to accept, but their claims and credit check show
    expect(section(d, 'followups_due').count).toBe(0);
    expect(section(d, 'legacy_cfa_claims').count).toBe(1);
    expect(section(d, 'dealer_alerts').count).toBe(0); // dealer A2's over-limit position is not theirs
    expect(d.sections.find((s) => s.key === 'leads_awaiting_acceptance')).toBeUndefined();
  });
});
