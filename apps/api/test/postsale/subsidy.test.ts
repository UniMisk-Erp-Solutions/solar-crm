import { describe, expect, it } from 'vitest';
import { computeDealerExposure } from '../../src/services/exposure';
import { tickClocks } from '../../src/services/clockService';
import { sendLegacyClaimReminders } from '../../src/services/subsidyService';
import { API, IDS, newEnv, seedProject, seedRules } from './fixtures';
import type { TestEnv } from '../helpers/env';

async function claimFor(env: TestEnv, n: number, body: Record<string, unknown> = {}, projectOpts: Parameters<typeof seedProject>[1] = {}) {
  const p = await seedProject(env, { n, ...projectOpts });
  const inst = (await env.as('admin').post(`${API}/installations`).send({ sales_order_id: p.soId, install_date: '2026-10-20' })).body.data;
  const res = await env.as('admin').post(`${API}/subsidy-claims`).send({ installation_id: inst.id, ...body });
  return { p, inst, res, claim: res.body.data };
}

async function legacyRules(env: TestEnv) {
  await seedRules(env);
  await env.rule('pmsg.claim_deadline.legacy_cohort', '2026-11-30', { status: 'unverified', confidence: 'medium' });
}

describe('creating a subsidy claim from an installation', () => {
  it('computes CFA with the rule engine and the state share from rule gujarat.state_subsidy (empty object ⇒ 0)', async () => {
    const env = newEnv();
    await seedRules(env);
    await env.rule('gujarat.state_subsidy', {}, { status: 'unverified', confidence: 'low' });
    const { res, claim } = await claimFor(env, 1);
    expect(res.status).toBe(201);
    expect(claim).toMatchObject({ status: 'not_ready', cohort: 'current', cfa_computed: 78000, state_share: 0, customer_name: 'Customer 1' });
    expect(claim.blockers).toEqual(['Bank proof not validated', 'Geo-tagged photos not accepted', 'DISCOM inspection approval pending', 'e-token not recorded']);

    const rule = (await env.db.table('rule_config').all({ key: 'state_subsidy' }))[0]!;
    await env.db.table('rule_config').update(rule.id, { value: { per_kw: 5000, max_total: 12000 } });
    const second = await claimFor(env, 2);
    expect(second.claim.state_share).toBe(12000); // 3 kW × 5 000 capped at 12 000
    await env.db.table('rule_config').update(rule.id, { is_active: false });
    const third = await claimFor(env, 3);
    expect(third.claim.state_share).toBe(0); // inactive rules never alter an amount
    const quoted = await claimFor(env, 4, {}, { stateShare: 9000 });
    expect(quoted.claim.state_share).toBe(9000); // what the customer was quoted wins
  });

  it('inactive CFA rules leave cfa_computed at 0 and say so; one claim per installation; non-subsidy segments are refused', async () => {
    const env = newEnv();
    await seedRules(env);
    const rule = (await env.db.table('rule_config').all({ key: 'cfa.per_kw_first_2kw' }))[0]!;
    await env.db.table('rule_config').update(rule.id, { is_active: false });
    const { inst, claim } = await claimFor(env, 1);
    expect(claim.cfa_computed).toBe(0);
    expect(claim.warnings.join(' ')).toMatch(/not active/);
    const dup = await env.as('admin').post(`${API}/subsidy-claims`).send({ installation_id: inst.id });
    expect(dup.status).toBe(409);
    const p2 = await seedProject(env, { n: 2, segment: 'ci_net_metered' });
    const i2 = (await env.as('admin').post(`${API}/installations`).send({ sales_order_id: p2.soId })).body.data;
    expect((await env.as('admin').post(`${API}/subsidy-claims`).send({ installation_id: i2.id })).status).toBe(422);
  });

  it('cohort: manual flag by default; derived from pmsg.legacy_cohort_cutoff only while that rule is active', async () => {
    const env = newEnv();
    await legacyRules(env);
    await env.rule('pmsg.legacy_cohort_cutoff', '2026-10-01', { status: 'unverified', confidence: 'low', is_active: false });
    const inactive = await claimFor(env, 1);
    expect(inactive.claim.cohort).toBe('current');
    expect(inactive.claim.warnings.join(' ')).toMatch(/legacy_cohort_cutoff is not active/);
    const manual = await claimFor(env, 2, { cohort: 'legacy' });
    expect(manual.claim).toMatchObject({ cohort: 'legacy', claim_deadline: '2026-11-30' });
    const rule = (await env.db.table('rule_config').all({ key: 'legacy_cohort_cutoff' }))[0]!;
    await env.db.table('rule_config').update(rule.id, { is_active: true });
    const derived = await claimFor(env, 3); // order_date 2026-09-20 < cutoff 2026-10-01
    expect(derived.claim.cohort).toBe('legacy');
    const clock = (await env.db.table('clocks').all({ entity_id: derived.claim.id, clock_type: 'legacy_cfa_claim_deadline' }))[0]!;
    expect(clock).toMatchObject({ status: 'running', due_at: '2026-11-30T18:29:59.999Z' });
    expect(clock.warn_at).toBe('2026-11-15T18:30:00.000Z'); // D-14
    const later = await claimFor(env, 4, { application_date: '2026-10-05' });
    expect(later.claim.cohort).toBe('current');
  });
});

describe('readiness → DISCOM approval → claim → release', () => {
  it('walks the whole ladder, starts the 15-day CFA clock on DISCOM approval and closes clocks and subsidy-linked receivables on release', async () => {
    const env = newEnv();
    await legacyRules(env);
    const { p, claim } = await claimFor(env, 1, { cohort: 'legacy' });
    // not ready → submit refused with the blockers
    const early = await env.as('admin').post(`${API}/subsidy-claims/${claim.id}/claim`).send({});
    expect(early.status).toBe(422);
    expect(early.body.error.details.blockers).toHaveLength(4);

    const patched = await env.as('admin').patch(`${API}/subsidy-claims/${claim.id}`).send({ bank_proof_ok: true, photos_ok: true, e_token: 'ET-0001' });
    expect(patched.body.data.status).toBe('not_ready');
    expect(patched.body.data.blockers).toEqual(['DISCOM inspection approval pending']);
    expect(await env.db.table('clocks').count({ entity_id: claim.id, clock_type: 'cfa_release' })).toBe(0);

    const approved = await env.as('dsm').post(`${API}/subsidy-claims/${claim.id}/discom-approval`).send({ approved_at: '2026-11-02' });
    expect(approved.status).toBe(200);
    expect(approved.body.data).toMatchObject({ status: 'ready', inspection_ok: true, discom_approval_at: '2026-11-01T18:30:00.000Z', blockers: [] });
    const cfaClock = (await env.db.table('clocks').all({ entity_id: claim.id, clock_type: 'cfa_release' }))[0]!;
    expect(cfaClock).toMatchObject({ status: 'running', entity_type: 'subsidy_claim', due_at: '2026-11-17T18:29:59.999Z' }); // approval + 15 days

    const claimed = await env.as('admin').post(`${API}/subsidy-claims/${claim.id}/claim`).send({});
    expect(claimed.body.data).toMatchObject({ status: 'claimed' });
    expect((await env.db.table('clocks').all({ entity_id: claim.id, clock_type: 'legacy_cfa_claim_deadline' }))[0]!.status).toBe('met');
    expect((await env.as('admin').post(`${API}/subsidy-claims/${claim.id}/claim`).send({})).status).toBe(409);

    // a subsidy-linked receivable on the project is released with the subsidy
    const rec = await env.ctx().db.table('dealer_receivables').insert({ dealer_id: IDS.dealerA1, distributor_id: IDS.distributorA, doc_ref: 'INV-1', amount: 100000, paid_amount: 0, invoice_date: '2026-09-25', due_date: '2026-12-25', subsidy_linked: true, linked_project_id: p.soId, status: 'open' });
    const other = await env.ctx().db.table('dealer_receivables').insert({ dealer_id: IDS.dealerA1, distributor_id: IDS.distributorA, doc_ref: 'INV-2', amount: 50000, paid_amount: 0, invoice_date: '2026-09-25', due_date: '2026-12-25', subsidy_linked: false, linked_project_id: p.soId, status: 'open' });
    expect((await computeDealerExposure(env.ctx(), IDS.dealerA1)).subsidy_linked).toBe(100000);
    await env.as('accounts').post(`${API}/subsidy-claims/${claim.id}/grievance`).send({});
    const released = await env.as('accounts').post(`${API}/subsidy-claims/${claim.id}/release`).send({ released_at: '2026-11-10' });
    expect(released.status).toBe(200);
    expect(released.body.data).toMatchObject({ status: 'released', receivables_closed: 1 });
    expect(await env.db.table('dealer_receivables').get(rec.id)).toMatchObject({ status: 'paid', paid_amount: 100000 });
    expect((await env.db.table('dealer_receivables').get(other.id))?.status).toBe('open'); // not subsidy-linked
    expect((await computeDealerExposure(env.ctx(), IDS.dealerA1)).subsidy_linked).toBe(0);
    const open = await env.db.table('clocks').all({ entity_id: claim.id, resolved_at: null });
    expect(open).toHaveLength(0); // cfa_release, legacy deadline and grievance are all closed
    expect((await env.db.table('clocks').all({ entity_id: claim.id, clock_type: 'cfa_release' }))[0]!.status).toBe('met');
    expect((await env.as('admin').post(`${API}/subsidy-claims/${claim.id}/release`).send({})).status).toBe(409);
    expect((await env.as('admin').patch(`${API}/subsidy-claims/${claim.id}`).send({ e_token: 'x' })).status).toBe(409);
  });

  it('the CFA release clock breaches after 15 days and notifies Accounts; release can only follow a submitted claim', async () => {
    const env = newEnv();
    await seedRules(env);
    const { claim } = await claimFor(env, 1);
    expect((await env.as('admin').post(`${API}/subsidy-claims/${claim.id}/release`).send({})).status).toBe(409);
    await env.as('admin').patch(`${API}/subsidy-claims/${claim.id}`).send({ bank_proof_ok: true, photos_ok: true, e_token: 'ET-9', discom_approval_at: '2026-10-20' });
    env.setNow(new Date('2026-11-06T05:00:00Z'));
    const t = await tickClocks(env.deps);
    expect(t.breached).toBe(1);
    expect(await env.db.table('notifications').count({ kind: 'subsidy.cfa_release_overdue' })).toBeGreaterThan(0);
  });

  it('the CFA release length is rule-driven: change the rule and the due date moves; inactive ⇒ warning and no clock', async () => {
    const env = newEnv();
    await seedRules(env);
    await env.rule('pmsg.cfa_release_days_after_discom_approval', 30, { effective_from: '2026-01-01', status: 'unverified' });
    const { claim } = await claimFor(env, 1);
    await env.as('admin').post(`${API}/subsidy-claims/${claim.id}/discom-approval`).send({ approved_at: '2026-11-02' });
    expect((await env.db.table('clocks').all({ entity_id: claim.id, clock_type: 'cfa_release' }))[0]!.due_at).toBe('2026-12-02T18:29:59.999Z');

    const env2 = newEnv();
    await seedRules(env2);
    const r = (await env2.db.table('rule_config').all({ key: 'cfa_release_days_after_discom_approval' }))[0]!;
    await env2.db.table('rule_config').update(r.id, { is_active: false });
    const c2 = await claimFor(env2, 1);
    const res = await env2.as('admin').post(`${API}/subsidy-claims/${c2.claim.id}/discom-approval`).send({});
    expect(res.body.data.warnings.join(' ')).toMatch(/not active/);
    expect(await env2.db.table('clocks').count({ clock_type: 'cfa_release' })).toBe(0);
  });
});

describe('rejection, re-opening, grievance and state share', () => {
  it('uses the rejection-reason picklist and can be re-opened', async () => {
    const env = newEnv();
    await legacyRules(env);
    const { claim } = await claimFor(env, 1, { cohort: 'legacy' });
    expect((await env.as('admin').post(`${API}/subsidy-claims/${claim.id}/reject`).send({ reason: 'because' })).status).toBe(422);
    const rej = await env.as('admin').post(`${API}/subsidy-claims/${claim.id}/reject`).send({ reason: 'bank_proof_invalid', note: 'cancelled cheque is blurred' });
    expect(rej.body.data).toMatchObject({ status: 'rejected', rejection_reason: 'bank_proof_invalid' });
    expect((await env.db.table('audit_log').all({ action: 'subsidy_claim.reject' }))[0]!.detail).toMatchObject({ reason: 'bank_proof_invalid', note: 'cancelled cheque is blurred' });
    expect((await env.as('admin').post(`${API}/subsidy-claims/${claim.id}/claim`).send({})).status).toBe(409);
    const re = await env.as('admin').post(`${API}/subsidy-claims/${claim.id}/reopen`).send({});
    expect(re.body.data).toMatchObject({ status: 'not_ready', rejection_reason: null });
    expect(await env.db.table('clocks').count({ entity_id: claim.id, clock_type: 'legacy_cfa_claim_deadline', status: 'running' })).toBe(1);
  });

  it('grievance runs 30 days (rule) and can be resolved', async () => {
    const env = newEnv();
    await seedRules(env);
    const { claim } = await claimFor(env, 1);
    const g = await env.as('admin').post(`${API}/subsidy-claims/${claim.id}/grievance`).send({ raised_at: '2026-10-26', note: 'No response from DISCOM' });
    expect(g.body.data.grievance_raised_at).toBe('2026-10-25T18:30:00.000Z');
    const clock = (await env.db.table('clocks').all({ entity_id: claim.id, clock_type: 'grievance' }))[0]!;
    expect(clock.due_at).toBe('2026-11-25T18:29:59.999Z'); // 26-Oct + 30 days
    await env.as('admin').post(`${API}/subsidy-claims/${claim.id}/grievance/resolve`).send({});
    expect((await env.db.table('clocks').get(clock.id))?.status).toBe('met');
  });

  it('tracks the state-share receivable and its ageing', async () => {
    const env = newEnv();
    await seedRules(env);
    await env.rule('gujarat.state_subsidy', { fixed: 10000 }, { status: 'unverified', confidence: 'low' });
    const a = await claimFor(env, 1, { state_share_due_at: '2026-10-01' });
    const b = await claimFor(env, 2);
    const c = await claimFor(env, 3);
    expect(a.claim.state_share).toBe(10000);
    await env.db.table('subsidy_claims').update(b.claim.id, { released_at: '2026-06-01T00:00:00.000Z' }); // 147 days ago, no due date
    const ageing = await env.as('accounts').get(`${API}/subsidy-claims/state-share-ageing`);
    expect(ageing.body.outstanding).toBe(30000);
    expect(ageing.body.buckets).toMatchObject({ d0_30: 20000, d90_plus: 10000 });
    expect(ageing.body.data.find((r: { claim_id: string }) => r.claim_id === a.claim.id)).toMatchObject({ days_overdue: 25, bucket: 'd0_30' });
    await env.as('accounts').post(`${API}/subsidy-claims/${a.claim.id}/state-share`).send({ received_at: '2026-10-25' });
    expect((await env.as('accounts').get(`${API}/subsidy-claims/state-share-ageing`)).body.outstanding).toBe(20000);
    void c;
  });
});

describe('daily work-list — legacy cohort first', () => {
  async function seedWorklist(env: TestEnv) {
    await legacyRules(env);
    const mk = async (n: number, cohort: 'legacy' | 'current') => (await claimFor(env, n, { cohort })).claim.id as string;
    const overdue = await mk(1, 'legacy'), soon = await mk(2, 'legacy'), later = await mk(3, 'legacy'), submitted = await mk(4, 'legacy'), current = await mk(5, 'current');
    const set = (id: string, patch: Record<string, unknown>) => env.db.table('subsidy_claims').update(id, patch);
    await set(overdue, { claim_deadline: '2026-10-24' });
    await set(soon, { claim_deadline: '2026-10-31', bank_proof_ok: true, photos_ok: true, inspection_ok: true, e_token: 'T', status: 'ready' });
    await set(later, { claim_deadline: '2026-11-30' });
    await set(submitted, { status: 'claimed', bank_proof_ok: true, photos_ok: true, inspection_ok: true, e_token: 'T', claim_deadline: '2026-10-28' });
    return { overdue, soon, later, submitted, current };
  }

  it('lists legacy claims first, soonest deadline first, with blockers and deadline state', async () => {
    const env = newEnv();
    const ids = await seedWorklist(env);
    const r = await env.as('dsm').get(`${API}/subsidy-claims/worklist`);
    expect(r.status).toBe(200);
    expect(r.body.data.map((x: { claim_id: string }) => x.claim_id)).toEqual([ids.overdue, ids.soon, ids.later, ids.submitted, ids.current]);
    const [o, s, l, sub, cur] = r.body.data;
    expect(o).toMatchObject({ days_to_deadline: -2, deadline_state: 'overdue', phase: 'prepare', cohort: 'legacy' });
    expect(o.blockers).toHaveLength(4);
    expect(s).toMatchObject({ days_to_deadline: 5, deadline_state: 'urgent', phase: 'submit', blockers: [], next_action: 'Submit the claim on the portal' });
    expect(l).toMatchObject({ days_to_deadline: 35, deadline_state: 'ok' });
    expect(sub).toMatchObject({ phase: 'await_release', deadline_met: true, deadline_state: null });
    expect(cur).toMatchObject({ cohort: 'current', days_to_deadline: null });
    expect(r.body.summary).toMatchObject({ legacy: 4, legacy_at_risk: 2, current: 1, ready_to_claim: 1, awaiting_release: 1, blocked: 3 });
    const onlyCurrent = await env.as('dsm').get(`${API}/subsidy-claims/worklist?cohort=current`);
    expect(onlyCurrent.body.data).toHaveLength(1);
  });

  it('a dealer sees only its own claims on the work-list', async () => {
    const env = newEnv();
    await legacyRules(env);
    await claimFor(env, 1, { cohort: 'legacy' });
    await claimFor(env, 2, { cohort: 'legacy' }, { dealerId: IDS.dealerB1, distributorId: IDS.distributorB });
    expect((await env.as('dealer_user').get(`${API}/subsidy-claims/worklist`)).body.total).toBe(1);
    expect((await env.as('distributor_user').get(`${API}/subsidy-claims/worklist`)).body.total).toBe(1);
    expect((await env.as('admin').get(`${API}/subsidy-claims/worklist`)).body.total).toBe(2);
  });

  it('D-14 / D-7 / D-3 reminders escalate DSM → Sales Manager → Management, once each; D-7 reaches the Sales Manager', async () => {
    const env = newEnv();
    await legacyRules(env);
    const { claim } = await claimFor(env, 1, { cohort: 'legacy' });
    const who = async (kind: string) => (await env.db.table('notifications').all({ kind, entity_id: claim.id })).map((n) => n.user_id);

    env.setNow(new Date('2026-11-10T05:00:00Z')); // D-20: nothing yet
    expect(await sendLegacyClaimReminders(env.systemCtx())).toMatchObject({ checked: 1, notified: 0 });

    env.setNow(new Date('2026-11-16T05:00:00Z')); // D-14
    expect((await sendLegacyClaimReminders(env.systemCtx())).notified).toBeGreaterThan(0);
    expect(await who('subsidy.legacy_deadline.d14')).toEqual(expect.arrayContaining([IDS.profile('dsm'), IDS.profile('accounts')]));
    expect(await who('subsidy.legacy_deadline.d14')).not.toContain(IDS.profile('sales_manager'));
    expect((await sendLegacyClaimReminders(env.systemCtx())).notified).toBe(0); // not repeated

    env.setNow(new Date('2026-11-23T05:00:00Z')); // D-7
    await sendLegacyClaimReminders(env.systemCtx());
    expect(await who('subsidy.legacy_deadline.d7')).toEqual(expect.arrayContaining([IDS.profile('dsm'), IDS.profile('sales_manager')]));
    expect(await who('subsidy.legacy_deadline.d7')).not.toContain(IDS.profile('management'));
    const d7 = (await env.db.table('notifications').all({ kind: 'subsidy.legacy_deadline.d7' }))[0]!;
    expect(d7.severity).toBe('critical');
    expect(d7.body).toMatch(/Still blocked/);

    env.setNow(new Date('2026-11-27T05:00:00Z')); // D-3
    await sendLegacyClaimReminders(env.systemCtx());
    expect(await who('subsidy.legacy_deadline.d3')).toContain(IDS.profile('management'));

    env.setNow(new Date('2026-12-01T05:00:00Z')); // missed
    await sendLegacyClaimReminders(env.systemCtx());
    expect((await who('subsidy.legacy_deadline.overdue')).length).toBeGreaterThan(0);

    // a submitted claim is no longer at risk
    await env.db.table('subsidy_claims').update(claim.id, { status: 'claimed' });
    expect(await sendLegacyClaimReminders(env.systemCtx())).toMatchObject({ checked: 0 });
  });

  it('the clock engine warns at D-14 and notifies Sales Management when the legacy deadline passes', async () => {
    const env = newEnv();
    await legacyRules(env);
    const { claim } = await claimFor(env, 1, { cohort: 'legacy' });
    env.setNow(new Date('2026-11-16T05:00:00Z'));
    expect((await tickClocks(env.deps)).warned).toBe(1);
    env.setNow(new Date('2026-12-01T05:00:00Z'));
    expect((await tickClocks(env.deps)).breached).toBeGreaterThanOrEqual(1);
    const missed = await env.db.table('notifications').all({ kind: 'subsidy.legacy_deadline.missed', entity_id: claim.id });
    expect(missed.map((n) => n.user_id)).toEqual(expect.arrayContaining([IDS.profile('sales_manager'), IDS.profile('management')]));
  });
});

describe('subsidy roles', () => {
  it('viewers cannot write; other dealers cannot touch a claim', async () => {
    const env = newEnv();
    await seedRules(env);
    const { claim, inst } = await claimFor(env, 1);
    expect((await env.as('viewer').post(`${API}/subsidy-claims`).send({ installation_id: inst.id })).status).toBe(403);
    expect((await env.as('viewer').patch(`${API}/subsidy-claims/${claim.id}`).send({ e_token: 'x' })).status).toBe(403);
    expect((await env.as(IDS.dealerUserB).patch(`${API}/subsidy-claims/${claim.id}`).send({ e_token: 'x' })).status).toBe(403);
    expect((await env.as('viewer').get(`${API}/subsidy-claims/${claim.id}`)).status).toBe(200);
    expect((await env.as(IDS.dealerUserB).get(`${API}/subsidy-claims/${claim.id}`)).status).toBe(403);
  });
});
