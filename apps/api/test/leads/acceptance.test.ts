import { describe, expect, it } from 'vitest';
import { tickClocks } from '../../src/services/clockService';
import { API, IDS, leadEnv, person, type LeadEnv } from './helpers';

const MIN = 60_000;
async function newLead(env: LeadEnv, over: Record<string, unknown> = {}) {
  const r = await env.capture(person(over));
  return r.body.data.lead_id as string;
}
const types = async (env: LeadEnv, id: string) => (await env.db.table('lead_events').all({ lead_id: id })).map((e) => e.event_type);
const acceptanceClocks = (env: LeadEnv, id: string) => env.db.table('clocks').all({ entity_id: id, clock_type: 'lead_acceptance' }, { orderBy: { col: 'started_at', dir: 'asc' } });

describe('accept / reject (step 7)', () => {
  it('the assigned distributor accepts within the SLA: clock met, assignment accepted, owner set, first follow-up planned', async () => {
    const env = leadEnv();
    const id = await newLead(env);
    env.advance(20 * MIN);
    const r = await env.u('distributor_user').post(`${API}/leads/${id}/accept`).send({ note: 'Will call today' });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ status: 'accepted', owner_id: IDS.profile('distributor_user'), owner_name: 'Test distributor_user' });
    const lead = await env.lead(id);
    expect(lead.accepted_at).toBe(env.now().toISOString());
    expect(lead.next_action).toMatch(/initial contact/);
    expect(new Date(lead.next_followup_at!).getTime()).toBeGreaterThan(env.now().getTime());
    expect((await acceptanceClocks(env, id))[0]).toMatchObject({ status: 'met' });
    expect((await env.db.table('lead_assignments').all({ lead_id: id }))[0]).toMatchObject({ status: 'accepted' });
    expect(await types(env, id)).toEqual(expect.arrayContaining(['accepted', 'followup_scheduled']));
    expect(await env.db.table('audit_log').count({ action: 'lead.accept', record_id: id })).toBe(1);
    // accepting twice is refused
    expect((await env.u('distributor_user').post(`${API}/leads/${id}/accept`).send({})).status).toBe(409);
  });

  it('role scoping: another distributor’s user can neither read nor accept; a DSM can accept on behalf', async () => {
    const env = leadEnv();
    const id = await newLead(env);
    const other = env.u(IDS.distributorUserB);
    expect((await other.get(`${API}/leads/${id}`)).status).toBe(403);
    expect((await other.post(`${API}/leads/${id}/accept`).send({})).status).toBe(403);
    expect((await other.post(`${API}/leads/${id}/reject`).send({ reason: 'not mine' })).status).toBe(403);
    expect((await other.get(`${API}/leads`)).body.total).toBe(0);
    expect((await env.u('distributor_user').get(`${API}/leads`)).body.total).toBe(1);
    expect((await env.u('techno_commercial').post(`${API}/leads/${id}/accept`).send({})).status).toBe(403);
    expect((await env.u('dsm').post(`${API}/leads/${id}/accept`).send({})).status).toBe(200);
    expect((await env.lead(id)).owner_id).toBe(IDS.profile('distributor_user')); // ownership stays with the distributor’s user
  });

  it('a dealer’s user accepts only leads of their own dealer', async () => {
    const env = leadEnv();
    const key = await env.key('dealer_upload');
    const id = (await env.capture(person({ dealer_id: IDS.dealerA1 }), key)).body.data.lead_id as string;
    expect((await env.u(IDS.dealerUserB).post(`${API}/leads/${id}/accept`).send({})).status).toBe(403);
    expect((await env.u('dealer_user').post(`${API}/leads/${id}/accept`).send({})).status).toBe(200);
  });

  it('accepting after the SLA is recorded as late (the clock stays breached)', async () => {
    const env = leadEnv();
    const id = await newLead(env);
    env.advance(130 * MIN); // the minute tick has not run yet
    await env.u('distributor_user').post(`${API}/leads/${id}/accept`).send({});
    expect((await acceptanceClocks(env, id))[0]!.status).toBe('breached');
    const accepted = (await env.db.table('lead_events').all({ lead_id: id, event_type: 'accepted' }))[0]!;
    expect(accepted.detail).toMatchObject({ within_sla: false });
  });

  it('reject → logged with the reason and re-routed to the next best distributor; a second rejection leaves it with the DSM', async () => {
    const env = leadEnv();
    const id = await newLead(env);
    expect((await env.u('distributor_user').post(`${API}/leads/${id}/reject`).send({ reason: '' })).status).toBe(422);
    const r = await env.u('distributor_user').post(`${API}/leads/${id}/reject`).send({ reason: 'Outside our delivery area' });
    expect(r.status).toBe(200);
    expect(r.body.data.reassigned).toBe(true);
    const lead = await env.lead(id);
    expect(lead).toMatchObject({ status: 'assigned', distributor_id: IDS.distributorB, owner_id: IDS.distributorUserB });
    const a = await env.db.table('lead_assignments').all({ lead_id: id }, { orderBy: { col: 'assigned_at', dir: 'asc' } });
    expect(a.map((x) => [x.distributor_id, x.status, x.step])).toEqual([[IDS.distributorA, 'rejected', 'auto'], [IDS.distributorB, 'pending', 'reassignment']]);
    expect(a[0]!.reason).toBe('Outside our delivery area');
    expect(await types(env, id)).toEqual(expect.arrayContaining(['rejected', 'assigned']));
    expect(await env.db.table('notifications').count({ kind: 'lead.rejected', user_id: IDS.profile('dsm') })).toBe(1);

    const r2 = await env.u(IDS.distributorUserB).post(`${API}/leads/${id}/reject`).send({ reason: 'No capacity' });
    expect(r2.body.data.reassigned).toBe(false);
    expect(await env.lead(id)).toMatchObject({ status: 'unassigned', distributor_id: null, owner_id: IDS.profile('dsm') });
    expect(await env.db.table('notifications').count({ kind: 'lead.unassigned', user_id: IDS.profile('dsm') })).toBe(1);
  });

  it('the number of automatic assignments is capped by routing.max_auto_reassignments', async () => {
    const env = leadEnv();
    await env.rule('routing.max_auto_reassignments', 1);
    const id = await newLead(env);
    await env.u('distributor_user').post(`${API}/leads/${id}/reject`).send({ reason: 'Not for us' });
    expect((await env.lead(id)).status).toBe('unassigned');
  });
});

describe('acceptance loop: Reminder 1 → DSM alert → auto-reassignment (clock engine)', () => {
  it('runs through tickClocks and logs every step in lead_events', async () => {
    const env = leadEnv();
    await env.rule('sla.escalation_step_minutes', 60);
    const id = await newLead(env); // warm → 120 working minutes, warn at 84
    const first = (await acceptanceClocks(env, id))[0]!;
    expect(first).toMatchObject({ status: 'running', owner_id: IDS.profile('distributor_user') });

    env.advance(85 * MIN);
    expect(await tickClocks(env.deps)).toMatchObject({ warned: 1, breached: 0 });
    const reminder = (await env.db.table('notifications').all({ kind: 'lead.acceptance.reminder1' }))[0]!;
    expect(reminder).toMatchObject({ user_id: IDS.profile('distributor_user'), entity_id: id });
    expect(env.providers.calls.email.some((m) => m.to === 'distributor_user@test.local' && /Reminder/.test(m.subject))).toBe(true);
    expect(await types(env, id)).toContain('acceptance_reminder');

    env.advance(40 * MIN);
    expect(await tickClocks(env.deps)).toMatchObject({ breached: 1 });
    const alert = (await env.db.table('notifications').all({ kind: 'lead.acceptance.dsm_alert' }))[0]!;
    expect(alert).toMatchObject({ user_id: IDS.profile('dsm'), severity: 'critical' });
    expect(await types(env, id)).toContain('acceptance_breached');
    expect((await env.lead(id)).distributor_id).toBe(IDS.distributorA); // not reassigned yet

    env.advance(61 * MIN);
    expect(await tickClocks(env.deps)).toMatchObject({ escalated: 1 });
    const lead = await env.lead(id);
    expect(lead).toMatchObject({ status: 'assigned', distributor_id: IDS.distributorB, owner_id: IDS.distributorUserB });
    const assignments = await env.db.table('lead_assignments').all({ lead_id: id }, { orderBy: { col: 'assigned_at', dir: 'asc' } });
    expect(assignments.map((a) => [a.distributor_id, a.status, a.step])).toEqual([[IDS.distributorA, 'expired', 'auto'], [IDS.distributorB, 'pending', 'reassignment']]);
    expect(await types(env, id)).toEqual(expect.arrayContaining(['acceptance_expired', 'auto_reassigned']));
    const clocks = await acceptanceClocks(env, id);
    expect(clocks[0]).toMatchObject({ status: 'breached' }); // the missed SLA stays on record for KPIs
    expect(clocks[0]!.resolved_at).not.toBeNull();
    expect(clocks[1]).toMatchObject({ status: 'running', owner_id: IDS.distributorUserB });
    expect(await env.db.table('notifications').count({ kind: 'lead.assigned', user_id: IDS.distributorUserB })).toBe(1);

    // the new owner accepts in time → loop ends
    expect((await env.u(IDS.distributorUserB).post(`${API}/leads/${id}/accept`).send({})).status).toBe(200);
    expect((await acceptanceClocks(env, id))[1]!.status).toBe('met');
  });

  it('when the last eligible distributor also sits on it, the lead goes back to the DSM as unassigned', async () => {
    const env = leadEnv();
    await env.rule('sla.escalation_step_minutes', 60);
    const id = await newLead(env);
    for (let round = 0; round < 2; round++) {
      env.advance(85 * MIN); await tickClocks(env.deps);
      env.advance(40 * MIN); await tickClocks(env.deps);
      env.advance(61 * MIN); await tickClocks(env.deps);
    }
    const lead = await env.lead(id);
    expect(lead).toMatchObject({ status: 'unassigned', distributor_id: null, owner_id: IDS.profile('dsm') });
    const assignments = await env.db.table('lead_assignments').all({ lead_id: id }, { orderBy: { col: 'assigned_at', dir: 'asc' } });
    expect(assignments.map((a) => a.status)).toEqual(['expired', 'expired', 'pending']);
    expect(assignments[2]).toMatchObject({ step: 'escalation', assigned_to: IDS.profile('dsm') });
    expect(await env.db.table('notifications').count({ kind: 'lead.unassigned', entity_id: id })).toBe(1);
    expect(await types(env, id)).toContain('unassigned');
    expect(await env.db.table('clocks').count({ entity_id: id, clock_type: 'lead_acceptance', status: 'running' })).toBe(0);
  });

  it('an accepted lead is not touched by later ticks', async () => {
    const env = leadEnv();
    await env.rule('sla.escalation_step_minutes', 60);
    const id = await newLead(env);
    await env.u('distributor_user').post(`${API}/leads/${id}/accept`).send({});
    env.advance(300 * MIN);
    await tickClocks(env.deps);
    expect((await env.lead(id)).distributor_id).toBe(IDS.distributorA);
    expect(await env.db.table('notifications').count({ kind: 'lead.acceptance.dsm_alert' })).toBe(0);
  });
});

describe('manual reassignment (DSM and above)', () => {
  it('moves the lead, closes the old assignment, restarts the clock', async () => {
    const env = leadEnv();
    const id = await newLead(env);
    expect((await env.u('distributor_user').post(`${API}/leads/${id}/reassign`).send({ distributor_id: IDS.distributorB, reason: 'swap' })).status).toBe(403);
    const r = await env.u('dsm').post(`${API}/leads/${id}/reassign`).send({ distributor_id: IDS.distributorB, owner_id: IDS.distributorUserB, reason: 'Better fit for this customer' });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ status: 'assigned', distributor_id: IDS.distributorB, owner_id: IDS.distributorUserB });
    const a = await env.db.table('lead_assignments').all({ lead_id: id }, { orderBy: { col: 'assigned_at', dir: 'asc' } });
    expect(a.map((x) => [x.status, x.step])).toEqual([['reassigned', 'auto'], ['pending', 'manual']]);
    expect(a[1]!.score_snapshot).toMatchObject({ mode: 'manual', forced_by: IDS.profile('dsm') });
    const clocks = await acceptanceClocks(env, id);
    expect(clocks.filter((c) => c.status === 'running')).toHaveLength(1);
    expect(await env.db.table('audit_log').count({ action: 'lead.reassign', record_id: id })).toBe(1);
    // now invisible to distributor A, visible to B
    expect((await env.u('distributor_user').get(`${API}/leads/${id}`)).status).toBe(403);
    expect((await env.u(IDS.distributorUserB).get(`${API}/leads/${id}`)).status).toBe(200);
  });

  it('auto=true asks the engine for the next best distributor, excluding the current one', async () => {
    const env = leadEnv();
    const id = await newLead(env);
    const r = await env.u('sales_manager').post(`${API}/leads/${id}/reassign`).send({ auto: true, reason: 'Distributor A is on leave' });
    expect(r.body.data.distributor_id).toBe(IDS.distributorB);
  });

  it('a lead already being worked cannot be re-routed; validation of the target', async () => {
    const env = leadEnv();
    const id = await newLead(env);
    expect((await env.u('dsm').post(`${API}/leads/${id}/reassign`).send({ reason: 'no target' })).status).toBe(422);
    expect((await env.u('dsm').post(`${API}/leads/${id}/reassign`).send({ distributor_id: IDS.distributorB, dealer_id: IDS.dealerA1, reason: 'wrong dealer' })).status).toBe(422);
    await env.u('distributor_user').post(`${API}/leads/${id}/contacts`).send({ channel: 'call', outcome: 'connected_interested' });
    expect((await env.lead(id)).status).toBe('contacted');
    const r = await env.u('dsm').post(`${API}/leads/${id}/reassign`).send({ distributor_id: IDS.distributorB, reason: 'late change' });
    expect(r.status).toBe(409);
  });
});

describe('Stage 1 as drawn in the flow chart: urgency sets the SLA, then Reminder 1 → DSM alert → auto-reassignment', () => {
  it('a HOT inquiry gets the 30-minute window; Reminder 1 at 70 %, DSM alert at 100 %, auto-reassignment 15 minutes later (all configurable)', async () => {
    const env = leadEnv();
    const id = await newLead(env, { timeline_bucket: 'immediate' });
    const lead = await env.lead(id);
    expect(lead.temperature).toBe('hot');
    expect(lead.status).toBe('assigned');
    expect(new Date(lead.sla_due_at!).getTime() - env.now().getTime()).toBe(30 * MIN);
    const clock = (await acceptanceClocks(env, id))[0]!;
    expect((clock.meta as { step_minutes: number }).step_minutes).toBe(15);

    env.advance(22 * MIN); await tickClocks(env.deps);
    expect(await types(env, id)).toContain('acceptance_reminder');          // Reminder 1
    env.advance(9 * MIN); await tickClocks(env.deps);
    expect(await types(env, id)).toContain('acceptance_breached');          // DSM alert
    expect((await env.lead(id)).distributor_id).toBe(IDS.distributorA);
    env.advance(16 * MIN); await tickClocks(env.deps);
    expect(await types(env, id)).toEqual(expect.arrayContaining(['acceptance_expired', 'auto_reassigned'])); // Auto reassignment
    expect((await env.lead(id)).distributor_id).toBe(IDS.distributorB);
  });

  it('the reassign time is a rule: changing it moves the auto-reassignment', async () => {
    const env = leadEnv();
    await env.rule('sla.lead_acceptance_reassign_minutes.hot', 5);
    const id = await newLead(env, { timeline_bucket: 'immediate' });
    env.advance(31 * MIN); await tickClocks(env.deps);
    env.advance(6 * MIN); await tickClocks(env.deps);
    expect(await types(env, id)).toContain('auto_reassigned');
  });

  it('no urgency given → WARM (within 2 hours); a long timeline → COLD', async () => {
    const env = leadEnv();
    expect((await env.lead(await newLead(env))).temperature).toBe('warm');
    expect((await env.lead(await newLead(env, { mobile: '9810000002', name: 'Another Customer', timeline_bucket: 'six_months_plus' }))).temperature).toBe('cold');
  });
});

describe('Reminder 1 is never skipped', () => {
  it('a tick that lands after both the 70 % mark and the deadline still sends Reminder 1 before the DSM alert', async () => {
    const env = leadEnv();
    const id = await newLead(env, { timeline_bucket: 'immediate' });
    env.advance(31 * MIN); // the first tick of the minute only runs after the whole window has passed
    await tickClocks(env.deps);
    const types2 = await types(env, id);
    expect(types2).toContain('acceptance_reminder');
    expect(types2).toContain('acceptance_breached');
    expect(types2.indexOf('acceptance_reminder')).toBeLessThan(types2.indexOf('acceptance_breached'));
  });
});
