import { describe, expect, it } from 'vitest';
import type { ComplianceDashboard, ConsentDashboard, Finding, Kpi } from '@solar/shared';
import { IDS, ago, ahead, id, makeEnv, seeder, type Seeder } from './fixtures';
import type { TestEnv } from '../helpers/env';

const finding = (gate: Finding['gate'], severity: Finding['severity'], overridden = false): Finding => ({ gate, severity, message: `${gate} finding`, ruleIds: [], fieldRefs: [], overridden });
const kpi = (d: { kpis: Kpi[] }, key: string): Kpi => d.kpis.find((k) => k.key === key)!;

/**
 * Compliance fixture (quotes created in the period):
 *  Q1 hard stop G2 · Q2 hard stops G3+G4 · Q3 hard stop G11 + warning G7 (not G2–G6) · Q4 hard stop G6, overridden · Q5 sent, clean · Q6 re-quote required (list price up) ·
 *  Q7 draft · Q9 accepted · Q10 re-quote required (list price down) · Q8 outside the period (G2 hard stop, ignored)
 *  → 9 drafted, 3 blocked (Q1, Q2, Q4) = 33.3 % · issued Q5 Q6 Q9 Q10, flagged Q6 Q10 = 50 % · leakage = ₹10,000 (Q6 only; Q10's price fell)
 */
async function seedCompliance(s: Seeder) {
  const A = IDS.distributorA, B = IDS.distributorB;
  await s.quote(1, 91, { status: 'blocked', distributor_id: A, compliance_findings: [finding('G2', 'hard_stop')] });
  await s.quote(2, 91, { status: 'blocked', distributor_id: A, compliance_findings: [finding('G3', 'hard_stop'), finding('G4', 'hard_stop')] });
  await s.quote(3, 91, { distributor_id: B, compliance_findings: [finding('G11', 'hard_stop'), finding('G7', 'warning')] });
  await s.quote(4, 91, { status: 'approved', distributor_id: B, compliance_findings: [finding('G6', 'hard_stop', true)] });
  await s.quote(5, 91, { status: 'sent', sent_at: ago(5), distributor_id: B });
  await s.quote(6, 91, { status: 'requote_required', sent_at: ago(6), requote_reason: 'GST rate changed', distributor_id: B, total: 200_000 });
  await s.quote(7, 91, { distributor_id: B });
  await s.quote(8, 91, { created_at: ago(200), distributor_id: B, compliance_findings: [finding('G2', 'hard_stop')] });
  await s.quote(9, 91, { status: 'accepted', sent_at: ago(7), distributor_id: B });
  await s.quote(10, 91, { status: 'requote_required', sent_at: ago(6), requote_reason: 'Price list updated', distributor_id: B });
  await s.price(1, 1, { base_price: 10_000 }); await s.price(2, 2, { base_price: 11_000 });
  await s.quoteLine(1, 6, { sku_id: id('sku', 1), qty: 10, unit_price: 9_000, line_total: 90_000 }); // today's list ₹10,000 → +₹10,000
  await s.quoteLine(2, 6, { sku_id: null, qty: 1, unit_price: 20_000, line_total: 20_000 });
  await s.quoteLine(3, 10, { sku_id: id('sku', 2), qty: 5, unit_price: 12_000, line_total: 60_000 }); // today's list ₹11,000 → −₹5,000

  // RMA: T1 10 d (brand claim, ₹5,000 recovered) · T2 30 d (dealer) · T3 4 d (brand claim, nothing recovered) · T4 open · T5 warranty type · T6 closed before the period
  await s.ticket(1, { opened_at: ago(30), closed_at: ago(20), status: 'closed', cost_bearer: 'brand', brand_claim_no: 'BC-1', recovered_amount: 5_000 });
  await s.ticket(2, { opened_at: ago(40), closed_at: ago(10), status: 'closed', cost_bearer: 'dealer' });
  await s.ticket(3, { opened_at: ago(25), closed_at: ago(21), status: 'closed', cost_bearer: 'brand', brand_claim_no: 'BC-3' });
  await s.ticket(4, { opened_at: ago(5), cost_bearer: 'distributor' });
  await s.ticket(5, { type: 'warranty', opened_at: ago(15), closed_at: ago(14), status: 'closed', cost_bearer: 'consumer' });
  await s.ticket(6, { opened_at: ago(260), closed_at: ago(250), status: 'closed', cost_bearer: 'consumer' });

  // overrides: one compliance override pending, one credit override pending, one decided
  await s.approval(1, { entity_type: 'compliance_override', entity_id: id('quote', 1), lane: 'compliance', required_role: 'compliance_officer', requested_at: ago(3), meta: { quote_id: id('quote', 1), reason: 'Module substitution' } });
  await s.approval(2, { entity_type: 'compliance_override', entity_id: id('quote', 2), lane: 'compliance', required_role: 'compliance_officer', decision: 'approved' });
  await s.db.table('credit_overrides').insert({ dealer_id: IDS.dealerA1, reason: 'Festival order', status: 'pending', created_at: ago(2) });
  await s.db.table('credit_overrides').insert({ dealer_id: IDS.dealerA1, reason: 'Old', status: 'approved' });
}
const getCompliance = async (env: TestEnv, who: string, qs = ''): Promise<ComplianceDashboard> => (await env.as(who).get(`/api/v1/dashboards/compliance${qs}`).expect(200)).body.data;

describe('GET /dashboards/compliance', () => {
  it('computes the compliance-block rate (quotes with G2–G6 hard stops ÷ quotes drafted) and blocked quotes by gate', async () => {
    const env = makeEnv();
    await seedCompliance(seeder(env));
    const d = await getCompliance(env, 'compliance_officer');

    expect(kpi(d, 'compliance_block_rate_pct')).toMatchObject({ value: 33.3, unit: 'pct', secondary: { value: 3 } });
    expect(d.blocked_by_gate.map((g) => [g.gate, g.quotes])).toEqual([['G2', 1], ['G3', 1], ['G4', 1], ['G5', 0], ['G6', 1]]);
    expect(kpi(d, 'compliance_block_rate_pct').breakdown!.find((b) => b.key === 'G6')).toMatchObject({ quotes: 1, value: 11.1 });
  });

  it('computes the re-quote rate and the price-change margin leakage', async () => {
    const env = makeEnv();
    await seedCompliance(seeder(env));
    const d = await getCompliance(env, 'compliance_officer');

    expect(kpi(d, 'requote_rate_pct')).toMatchObject({ value: 50, secondary: { value: 2 } });
    expect(kpi(d, 'price_change_margin_leakage')).toMatchObject({ value: 10_000, unit: 'inr' });
    expect(d.requotes.map((r) => [r.quote_no, r.repriced_difference, r.leakage])).toEqual([['QT-6', 10_000, 10_000], ['QT-10', -5_000, 0]]);
    expect(d.requotes[0]).toMatchObject({ reason: 'GST rate changed', status: 'requote_required', path: `/quotes/${id('quote', 6)}` });
  });

  it('computes RMA turnaround (median / p90) and claim recovery from the brand', async () => {
    const env = makeEnv();
    await seedCompliance(seeder(env));
    const d = await getCompliance(env, 'compliance_officer');

    expect(kpi(d, 'rma_turnaround_days')).toMatchObject({ value: 10, unit: 'days', secondary: { value: 26 } }); // 4, 10, 30 days
    expect(kpi(d, 'rma_brand_recovery')).toMatchObject({ value: 5_000, secondary: { value: 2 } });
    expect(kpi(d, 'rma_brand_recovery_rate_pct').value).toBe(50);
  });

  it('lists open overrides (compliance + credit) for internal users', async () => {
    const env = makeEnv();
    await seedCompliance(seeder(env));
    const d = await getCompliance(env, 'compliance_officer');
    expect(kpi(d, 'open_overrides').value).toBe(2);
    expect(d.open_overrides.map((o) => o.kind).sort()).toEqual(['compliance_override', 'credit_override']);
    expect(d.open_overrides.find((o) => o.kind === 'compliance_override')).toMatchObject({ label: 'Compliance override — Module substitution', age_days: 3, path: `/quotes/${id('quote', 1)}` });
  });

  it('external users only see their own quotes and no internal-only KPIs', async () => {
    const env = makeEnv();
    await seedCompliance(seeder(env));
    const d = await getCompliance(env, 'distributor_user'); // distributor A: Q1, Q2 (both blocked)
    expect(kpi(d, 'compliance_block_rate_pct')).toMatchObject({ value: 100, secondary: { value: 2 } });
    expect(d.kpis.find((k) => k.key === 'open_overrides')).toBeUndefined();
    expect(d.kpis.find((k) => k.key === 'price_change_margin_leakage')).toBeUndefined();
    expect(d.open_overrides).toEqual([]);
    const b = await getCompliance(env, IDS.distributorUserB);
    expect(kpi(b, 'compliance_block_rate_pct')).toMatchObject({ value: 14.3, secondary: { value: 1 } }); // Q4 of the 7 quotes B drafted in the period
  });
});

/**
 * Consent fixture (leads captured in the period):
 *  L1 consent, nothing sent yet ✓ · L2 consent before first message ✓ · L3 consent granted AFTER the first message ✗ · L4 consent withdrawn before the first message ✗ ·
 *  L5 no consent ✗ · L6 consent withdrawn after the first message ✓ · L7 duplicate (ignored)  → 3 of 6 = 50 %
 *  blocked messages: DND_REGISTERED, NO_CONSENT, DND_STALE, SUPPRESSED_90_DAY (+ one without a lead, ignored)
 */
async function seedConsent(s: Seeder) {
  const A = IDS.distributorA, B = IDS.distributorB;
  await s.lead(1, { distributor_id: A, created_at: ago(10), source: 'website' });
  await s.lead(2, { distributor_id: A, created_at: ago(10), source: 'website' });
  await s.lead(3, { distributor_id: B, created_at: ago(10), source: 'call_centre' });
  await s.lead(4, { distributor_id: B, created_at: ago(10), source: 'call_centre' });
  await s.lead(5, { distributor_id: B, created_at: ago(10), source: 'referral', dnd_status: 'registered' });
  await s.lead(6, { distributor_id: B, created_at: ago(10), source: 'referral' });
  await s.lead(7, { distributor_id: B, created_at: ago(10), status: 'duplicate' });
  await s.consent(1, 1, { granted_at: ago(10, 1), created_at: ago(10, 1) });
  await s.consent(2, 2, { granted_at: ago(10, 1), created_at: ago(10, 1) });
  await s.consent(3, 3, { granted_at: ago(3), created_at: ago(3) });
  await s.consent(4, 4, { granted_at: ago(10, 1), created_at: ago(10, 1), withdrawn_at: ago(7), withdrawal_channel: 'whatsapp_stop', optout_suppress_until: ahead(30) });
  await s.consent(6, 6, { granted_at: ago(10, 1), created_at: ago(10, 1), withdrawn_at: ago(2), withdrawal_channel: 'ui' });
  for (const [n, lead] of [[1, 2], [2, 3], [3, 4], [4, 6]] as const) await s.message(n, lead, { status: 'sent', created_at: ago(5) });
  await s.message(5, 5, { status: 'blocked', block_reason: 'DND_REGISTERED', created_at: ago(4) });
  await s.message(6, 5, { status: 'blocked', block_reason: 'NO_CONSENT: no consent record for promotional messages', created_at: ago(4) });
  await s.message(7, 3, { status: 'blocked', block_reason: 'DND_STALE', created_at: ago(3) });
  await s.message(8, 4, { status: 'blocked', block_reason: 'SUPPRESSED_90_DAY', created_at: ago(3) });
  await s.message(9, null, { status: 'blocked', block_reason: 'NO_CONSENT', created_at: ago(3) });
}
const getConsent = async (env: TestEnv, who: string, qs = ''): Promise<ConsentDashboard> => (await env.as(who).get(`/api/v1/dashboards/consent${qs}`).expect(200)).body.data;

describe('GET /dashboards/consent', () => {
  it('computes consent coverage before outbound contact', async () => {
    const env = makeEnv();
    await seedConsent(seeder(env));
    const d = await getConsent(env, 'compliance_officer');

    expect(d.coverage).toEqual({ leads: 6, covered: 3, uncovered: 3 });
    expect(kpi(d, 'consent_coverage_pct')).toMatchObject({ value: 50, secondary: { value: 3 } });
    expect(kpi(d, 'consent_coverage_pct').target).toMatchObject({ value: 100, direction: 'at_least', met: false });
    expect(d.uncovered_leads.map((l) => l.name).sort()).toEqual(['Lead 3', 'Lead 4', 'Lead 5']);
    const bySource = kpi(d, 'consent_coverage_pct').breakdown!;
    expect(bySource.find((b) => b.key === 'website')).toMatchObject({ value: 100, numerator: 2, denominator: 2 });
    expect(bySource.find((b) => b.key === 'call_centre')).toMatchObject({ value: 0, numerator: 0, denominator: 2 });
  });

  it('counts withdrawn consents, suppressed leads, DND-blocked and blocked messages with reasons', async () => {
    const env = makeEnv();
    await seedConsent(seeder(env));
    const d = await getConsent(env, 'compliance_officer');

    expect(kpi(d, 'consent_withdrawn').value).toBe(2);
    expect(kpi(d, 'consent_withdrawn').breakdown!.map((b) => b.key).sort()).toEqual(['ui', 'whatsapp_stop']);
    expect(kpi(d, 'consent_suppressed').value).toBe(1);
    expect(kpi(d, 'dnd_blocked_messages')).toMatchObject({ value: 2, secondary: { value: 1 } });
    expect(kpi(d, 'blocked_messages').value).toBe(4);
    expect(d.blocked_reasons.map((r) => [r.code, r.count]).sort()).toEqual([['DND_REGISTERED', 1], ['DND_STALE', 1], ['NO_CONSENT', 1], ['SUPPRESSED_90_DAY', 1]]);
    expect(d.blocked_reasons.find((r) => r.code === 'DND_REGISTERED')!.label).toBe('Number on DND register');
  });

  it('target comes from rule_config; external users only see their own leads', async () => {
    const env = makeEnv();
    await seedConsent(seeder(env));
    await env.rule('kpi.target.consent_coverage_pct', 40);
    const d = await getConsent(env, 'compliance_officer');
    expect(kpi(d, 'consent_coverage_pct').target).toMatchObject({ value: 40, met: true });
    const a = await getConsent(env, 'distributor_user'); // L1, L2
    expect(a.coverage).toEqual({ leads: 2, covered: 2, uncovered: 0 });
    expect(kpi(a, 'blocked_messages').value).toBe(0);
    const b = await getConsent(env, IDS.distributorUserB);
    expect(b.coverage).toEqual({ leads: 4, covered: 1, uncovered: 3 });
    expect(kpi(b, 'blocked_messages').value).toBe(4);
  });
});
