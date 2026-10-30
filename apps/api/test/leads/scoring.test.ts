import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCORE_WEIGHTS, baseTemperature, computeLeadScore, deriveTemperature, normaliseWeights, raiseTemperature, scoreFactors, type ScoreInput,
} from '../../src/services/scoring';
import { API, IDS, leadEnv, person } from './helpers';

const empty: ScoreInput = {
  requirement_text: null, segment: null, capacity_kw: null, timeline_bucket: null, budget_inr: null, decision_maker: null, decision_maker_access: null, bill_captured: false, has_active_consent: false,
};
const points = (i: Partial<ScoreInput>, key: keyof typeof DEFAULT_SCORE_WEIGHTS) => computeLeadScore({ ...empty, ...i }).components.find((c) => c.key === key)!.points;

describe('lead quality score — Appendix A, component by component', () => {
  it('weights sum to 100 and an empty lead scores 0', () => {
    expect(Object.values(DEFAULT_SCORE_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
    const r = computeLeadScore(empty);
    expect(r.score).toBe(0);
    expect(r.components.map((c) => c.key)).toEqual(['requirement_clarity', 'mw_size', 'timeline', 'budget', 'decision_maker', 'consent_present', 'bill_captured']);
    expect(r.components.every((c) => c.label && typeof c.weight === 'number' && typeof c.note === 'string')).toBe(true);
  });

  it('requirement clarity: text length (0.6 / 0.3 / 0) + segment 0.2 + capacity 0.2, weight 20', () => {
    expect(points({ requirement_text: 'x'.repeat(20) }, 'requirement_clarity')).toBe(12);
    expect(points({ requirement_text: 'x'.repeat(19) }, 'requirement_clarity')).toBe(6);
    expect(points({ requirement_text: '   ' }, 'requirement_clarity')).toBe(0);
    expect(points({ segment: 'rwa_ghs' }, 'requirement_clarity')).toBe(4);
    expect(points({ capacity_kw: 5 }, 'requirement_clarity')).toBe(4);
    expect(points({ requirement_text: 'x'.repeat(30), segment: 'rwa_ghs', capacity_kw: 5 }, 'requirement_clarity')).toBe(20);
  });

  it('system size: <3 → 0.3, 3–<10 → 0.5, 10–<100 → 0.75, ≥100 → 1, unknown → 0 (weight 15)', () => {
    const p = (kw: number | null) => points({ capacity_kw: kw }, 'mw_size');
    expect([p(null), p(0.5), p(2.99), p(3), p(9.99), p(10), p(99.9), p(100), p(2500)]).toEqual([0, 4.5, 4.5, 7.5, 7.5, 11.25, 11.25, 15, 15]);
  });

  it('timeline buckets (weight 25)', () => {
    const p = (t: ScoreInput['timeline_bucket']) => points({ timeline_bucket: t }, 'timeline');
    expect([p('immediate'), p('within_30_days'), p('one_to_three_months'), p('three_to_six_months'), p('six_months_plus'), p('unknown'), p(null)]).toEqual([25, 22.5, 15, 7.5, 2.5, 0, 0]);
  });

  it('budget: none → 0; ≥ ₹ 40,000 × kW → 1; otherwise (or size unknown) 0.6 (weight 15)', () => {
    expect(points({ budget_inr: null, capacity_kw: 5 }, 'budget')).toBe(0);
    expect(points({ budget_inr: 200_000, capacity_kw: 5 }, 'budget')).toBe(15);
    expect(points({ budget_inr: 199_999, capacity_kw: 5 }, 'budget')).toBe(9);
    expect(points({ budget_inr: 500_000, capacity_kw: null }, 'budget')).toBe(9);
    expect(points({ budget_inr: 0, capacity_kw: 5 }, 'budget')).toBe(9);
  });

  it('decision maker: self 1, family 0.8, committee 0.5, unknown 0; no access halves it (weight 10)', () => {
    const p = (d: ScoreInput['decision_maker'], access: boolean | null = null) => points({ decision_maker: d, decision_maker_access: access }, 'decision_maker');
    expect([p('self'), p('family'), p('committee'), p('unknown'), p(null)]).toEqual([10, 8, 5, 0, 0]);
    expect([p('self', false), p('family', false), p('self', true)]).toEqual([5, 4, 10]);
  });

  it('consent (10) and bill (5) are all-or-nothing', () => {
    expect(points({ has_active_consent: true }, 'consent_present')).toBe(10);
    expect(points({ has_active_consent: false }, 'consent_present')).toBe(0);
    expect(points({ bill_captured: true }, 'bill_captured')).toBe(5);
  });

  it('a complete lead scores 100; the total is the rounded sum; weights from the rule are normalised', () => {
    const full: ScoreInput = { requirement_text: 'x'.repeat(40), segment: 'pmsg_residential', capacity_kw: 100, timeline_bucket: 'immediate', budget_inr: 5_000_000, decision_maker: 'self', decision_maker_access: true, bill_captured: true, has_active_consent: true };
    expect(computeLeadScore(full).score).toBe(100);
    expect(computeLeadScore({ ...empty, capacity_kw: 5, timeline_bucket: 'one_to_three_months' }).score).toBe(Math.round(0.2 * 20 + 7.5 + 15)); // 4 + 7.5 + 15 = 26.5 → 27
    const w = normaliseWeights({ timeline: 50, requirement_clarity: 50, mw_size: 0, budget: 0, decision_maker: 0, consent_present: 0, bill_captured: 0 });
    expect(Object.values(w).reduce((a, b) => a + b, 0)).toBeCloseTo(100);
    expect(computeLeadScore(full, w).score).toBe(100);
    expect(normaliseWeights(null)).toEqual(DEFAULT_SCORE_WEIGHTS);
    expect(scoreFactors({ ...empty, capacity_kw: 5 }).mw_size.note).toBe('5 kW');
  });
});

describe('temperature and deadline uplift', () => {
  it('timeline → temperature; a missing timeline defaults to warm', () => {
    expect([baseTemperature('immediate'), baseTemperature('within_30_days'), baseTemperature('one_to_three_months'), baseTemperature('three_to_six_months'), baseTemperature('six_months_plus'), baseTemperature('unknown'), baseTemperature(null)])
      .toEqual(['hot', 'hot', 'warm', 'cold', 'cold', 'cold', 'warm']);
    expect([raiseTemperature('cold'), raiseTemperature('warm'), raiseTemperature('hot')]).toEqual(['warm', 'hot', 'hot']);
  });

  it('PMSG residential/RWA: raised one level when the legacy claim deadline is within 60 days', async () => {
    const env = leadEnv();
    await env.rule('pmsg.claim_deadline.legacy_cohort', '2026-11-30'); // 35 days after 26-Oct-2026
    const ctx = env.ctx();
    const t = (timeline: ScoreInput['timeline_bucket'], segment: 'pmsg_residential' | 'rwa_ghs' | 'ci_captive' = 'pmsg_residential') => deriveTemperature(ctx, { timeline_bucket: timeline, segment });
    expect(await t('six_months_plus')).toMatchObject({ temperature: 'warm', base: 'cold', deadline_uplift: true, deadline: { days_left: 35 } });
    expect(await t('one_to_three_months')).toMatchObject({ temperature: 'hot', deadline_uplift: true });
    expect(await t('immediate')).toMatchObject({ temperature: 'hot', deadline_uplift: false }); // already hot
    expect(await t('three_to_six_months', 'rwa_ghs')).toMatchObject({ temperature: 'warm', deadline_uplift: true });
    expect(await t('six_months_plus', 'ci_captive')).toMatchObject({ temperature: 'cold', deadline_uplift: false }); // no relevant deadline
    expect(await t(null)).toMatchObject({ temperature: 'warm', deadline_uplift: false }); // not qualified yet
  });

  it('net-metered / open access use the ALMM List-II exemption date; the window is configurable; inactive or passed deadlines do nothing', async () => {
    const env = leadEnv();
    await env.rule('almm.list2.exemption_net_metering_open_access_until', '2026-12-31'); // 66 days away
    const ctx = () => env.ctx();
    const t = (segment: 'ci_net_metered' | 'open_access') => deriveTemperature(ctx(), { timeline_bucket: 'three_to_six_months', segment });
    expect((await t('ci_net_metered')).deadline_uplift).toBe(false); // 66 > 60
    await env.rule('temperature.deadline_uplift_days', 90);
    expect(await t('ci_net_metered')).toMatchObject({ temperature: 'warm', deadline_uplift: true });
    expect((await t('open_access')).deadline_uplift).toBe(true);
    env.setNow(new Date('2027-01-05T05:00:00Z')); // deadline passed
    expect((await t('open_access')).deadline_uplift).toBe(false);

    const env2 = leadEnv();
    await env2.rule('pmsg.claim_deadline.legacy_cohort', '2026-11-30', { is_active: false, status: 'unverified' });
    expect((await deriveTemperature(env2.ctx(), { timeline_bucket: 'six_months_plus', segment: 'pmsg_residential' })).deadline_uplift).toBe(false);
  });
});

describe('qualification → temperature, score, status, follow-up (API)', () => {
  const answers = { requirement_text: 'Want a 5 kW rooftop system for my home with net metering', timeline_bucket: 'within_30_days', budget_inr: 250000, decision_maker: 'self', decision_maker_access: true, bill_captured: true };

  it('derives hot + 90/100 with every component stored, marks the lead qualified and plans the follow-up', async () => {
    const env = leadEnv();
    const id = (await env.capture(person())).body.data.lead_id as string;
    const res = await env.u('distributor_user').post(`${API}/leads/${id}/qualification`).send(answers);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ qualified: true, score: 90, temperature: 'hot', deadline_uplift: false, gaps: [] });
    expect(res.body.data.lead).toMatchObject({ status: 'qualified', quality_score: 90, temperature: 'hot', requirement_text: answers.requirement_text });
    const rows = await env.db.table('lead_scores').all({ lead_id: id });
    expect(rows).toHaveLength(2); // one at intake, one after the qualification call
    const final = rows.find((r) => r.score === 90)!;
    expect(Object.fromEntries(final.components.map((c) => [c.key, c.points]))).toEqual({ requirement_clarity: 20, mw_size: 7.5, timeline: 22.5, budget: 15, decision_maker: 10, consent_present: 10, bill_captured: 5 });

    const lead = await env.lead(id);
    expect(lead.first_contacted_at).not.toBeNull();
    expect(lead.next_action).toBe('Schedule the site visit');
    expect(lead.next_followup_at).toBe(new Date(env.now().getTime() + 86_400_000).toISOString()); // hot → sla.followup_days.hot = 1 day
    const fu = await env.db.table('followups').all({ lead_id: id, status: 'open' });
    expect(fu).toHaveLength(1);
    expect(fu[0]!.due_at).toBe(lead.next_followup_at);
    const clocks = await env.db.table('clocks').all({ entity_id: id, clock_type: 'followup', resolved_at: null });
    expect(clocks).toHaveLength(1);
    expect(clocks[0]).toMatchObject({ status: 'running', due_at: lead.next_followup_at });
    expect((await env.db.table('lead_events').all({ lead_id: id })).map((e) => e.event_type)).toEqual(expect.arrayContaining(['accepted', 'qualified', 'scored']));
  });

  it('GET /score shows the breakdown; recompute stores a new row and follows consent withdrawal', async () => {
    const env = leadEnv();
    const id = (await env.capture(person())).body.data.lead_id as string;
    await env.u('distributor_user').post(`${API}/leads/${id}/qualification`).send(answers);
    const s = await env.u('admin').get(`${API}/leads/${id}/score`);
    expect(s.body.data).toMatchObject({ score: 90, temperature: 'hot', deadline_uplift: false });
    expect(s.body.data.components).toHaveLength(7);
    await env.u('admin').post(`${API}/leads/${id}/consents/withdraw`).send({});
    const r = await env.u('admin').post(`${API}/leads/${id}/score/recompute`).send({});
    expect(r.body.data.score).toBe(80);
    expect(r.body.data.components.find((c: { key: string }) => c.key === 'consent_present').points).toBe(0);
    expect(r.body.data.history.length).toBeGreaterThanOrEqual(2);
    expect((await env.lead(id)).quality_score).toBe(80);
    expect((await env.u(IDS.distributorUserB).get(`${API}/leads/${id}/score`)).status).toBe(403);
  });

  it('a cold timeline close to the PMSG claim deadline is raised to warm and flagged', async () => {
    const env = leadEnv();
    await env.rule('pmsg.claim_deadline.legacy_cohort', '2026-11-30');
    const id = (await env.capture(person())).body.data.lead_id as string;
    const res = await env.u('distributor_user').post(`${API}/leads/${id}/qualification`).send({ ...answers, timeline_bucket: 'six_months_plus' });
    expect(res.body.data).toMatchObject({ temperature: 'warm', deadline_uplift: true });
    expect(await env.lead(id)).toMatchObject({ temperature: 'warm', deadline_uplift: true });
    expect(res.body.data.lead.next_followup_at).toBe(new Date(env.now().getTime() + 3 * 86_400_000).toISOString()); // warm → 3 days
  });

  it('missing information keeps the lead at Contacted and says what is needed', async () => {
    const env = leadEnv();
    const id = (await env.capture(person({ capacity_kw: undefined }))).body.data.lead_id as string;
    const res = await env.u('distributor_user').post(`${API}/leads/${id}/qualification`).send({ ...answers, decision_maker: 'unknown' });
    expect(res.body.data.qualified).toBe(false);
    expect(res.body.data.gaps).toEqual(['system size (kW)']); // "not known yet" is a recorded answer, so it is not a gap
    expect(res.body.data.lead.status).toBe('contacted');
    expect((await env.lead(id)).next_action).toMatch(/still needed: system size/);
  });

  it('qualification needs the answers and an accepted lead', async () => {
    const env = leadEnv();
    const id = (await env.capture(person())).body.data.lead_id as string;
    const bad = await env.u('distributor_user').post(`${API}/leads/${id}/qualification`).send({ timeline_bucket: 'immediate' });
    expect(bad.status).toBe(422);
    const dup = (await env.capture(person())).body.data.lead_id as string; // a duplicate cannot be worked
    expect((await env.u('admin').post(`${API}/leads/${dup}/qualification`).send(answers)).status).toBe(409);
  });
});
