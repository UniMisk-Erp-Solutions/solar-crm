import { describe, expect, it } from 'vitest';
import { tickClocks } from '../../src/services/clockService';
import { computeDealerExposure } from '../../src/services/exposure';
import { API, IDS, newEnv } from '../postsale/fixtures';
import type { TestEnv } from '../helpers/env';

async function sopRules(env: TestEnv) {
  await env.rule('mnre_sop.vendor_reply_days', 8); await env.rule('mnre_sop.reminder_days', 15); await env.rule('mnre_sop.show_cause_days', 15);
  await env.rule('mnre_sop.deactivation_months', 1); await env.rule('mnre_sop.appeal_days', 30);
}
async function registration(env: TestEnv, dealerId = IDS.dealerA1) {
  return (await env.as('dsm').post(`${API}/vendor-registrations`).send({ party_type: 'dealer', party_id: dealerId, level: 'state', portal_vendor_id: 'GJ-001', states: ['Gujarat'] })).body.data;
}
const open = (env: TestEnv, body: Record<string, unknown> = {}) => env.as('dsm').post(`${API}/sop-cases`).send({ dealer_id: IDS.dealerA1, complaint_ref: 'MNRE/C/2026/88', summary: 'Consumer complaint on delayed commissioning', notice_at: '2026-10-26', ...body });
const go = (env: TestEnv, id: string, to: string, at?: string, extra: Record<string, unknown> = {}) => env.as('dsm').post(`${API}/sop-cases/${id}/transition`).send({ to, ...(at ? { at } : {}), ...extra });

describe('MNRE SOP tracker', () => {
  it('opens a case from a complaint: reply stage, 8-day reply clock, complaint count and "under SOP" status', async () => {
    const env = newEnv();
    await sopRules(env);
    const reg = await registration(env);
    const r = await open(env);
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({
      stage: 'reply', dealer_id: IDS.dealerA1, vendor_registration_id: reg.id, reply_due_at: '2026-11-03T18:29:59.999Z', next_stages: ['reminder', 'closed'], next_due_at: '2026-11-03T18:29:59.999Z', dealer_name: 'Sunrise Installers',
    });
    const clock = (await env.db.table('clocks').all({ entity_id: r.body.data.id }))[0]!;
    expect(clock).toMatchObject({ clock_type: 'sop_reply', entity_type: 'sop_case', status: 'running', due_at: '2026-11-03T18:29:59.999Z' });
    expect((await env.db.table('dealers').get(IDS.dealerA1))).toMatchObject({ complaint_count: 1, portal_status: 'under_sop' });
    expect((await env.db.table('vendor_registrations').get(reg.id))).toMatchObject({ complaint_count: 1, portal_status: 'under_sop' });
    expect(await env.db.table('notifications').count({ kind: 'sop.opened' })).toBeGreaterThan(0);
    // the tracker never blocks: credit limit untouched, G11 only sees a warning-grade status
    const x = await computeDealerExposure(env.ctx(), IDS.dealerA1);
    expect(x).toMatchObject({ portal_status: 'under_sop', deactivated: false, sop_open: 1, credit_limit: 1_000_000 });
  });

  it('progresses reply → reminder → show-cause → deactivation → appeal → closed with every duration from rule_config', async () => {
    const env = newEnv();
    await sopRules(env);
    const reg = await registration(env);
    const id = (await open(env)).body.data.id;

    const rem = await go(env, id, 'reminder', '2026-11-04');
    expect(rem.body.data).toMatchObject({ stage: 'reminder', reminder_at: '2026-11-03T18:30:00.000Z', next_due_at: '2026-11-10T18:29:59.999Z' }); // notice + 15 days
    const sc = await go(env, id, 'show_cause', '2026-11-12');
    expect(sc.body.data).toMatchObject({ stage: 'show_cause', show_cause_due_at: '2026-11-27T18:29:59.999Z' }); // + 15 days
    const clocks = await env.db.table('clocks').all({ entity_id: id });
    expect(clocks.find((c) => c.clock_type === 'sop_show_cause')).toMatchObject({ status: 'running', due_at: '2026-11-27T18:29:59.999Z' });
    expect(clocks.filter((c) => c.clock_type === 'sop_reply').every((c) => c.resolved_at)).toBe(true);

    const deact = await go(env, id, 'deactivation', '2026-11-30');
    expect(deact.body.data).toMatchObject({ stage: 'deactivation', deactivated_at: '2026-11-29T18:30:00.000Z', appeal_due_at: '2026-12-30T18:29:59.999Z' }); // + 30 days
    expect(await env.db.table('vendor_registrations').get(reg.id)).toMatchObject({ portal_status: 'deactivated', deactivated_from: '2026-11-30', deactivated_to: '2026-12-30' }); // 1 month
    expect((await env.db.table('dealers').get(IDS.dealerA1))?.portal_status).toBe('deactivated');
    expect((await computeDealerExposure(env.ctx(), IDS.dealerA1)).deactivated).toBe(true);

    expect((await go(env, id, 'appeal', '2026-12-10', { outcome: 'Appeal filed with MNRE' })).body.data).toMatchObject({ stage: 'appeal', outcome: 'Appeal filed with MNRE' });
    const closed = await go(env, id, 'closed', '2026-12-15', { outcome: 'Appeal allowed — vendor reinstated' });
    expect(closed.body.data).toMatchObject({ stage: 'closed', closed_at: '2026-12-14T18:30:00.000Z', next_stages: [], next_due_at: null });
    expect(await env.db.table('vendor_registrations').get(reg.id)).toMatchObject({ portal_status: 'active', deactivated_to: '2026-12-15' });
    expect((await env.db.table('dealers').get(IDS.dealerA1))?.portal_status).toBe('active');
    expect((await env.db.table('audit_log').all({ action: 'sop_case.transition' })).length).toBe(5);
    expect((await env.db.table('audit_log').all({ action: 'dealer.portal_status_change' })).length).toBeGreaterThanOrEqual(3);
    expect((await env.db.table('clocks').all({ entity_id: id, resolved_at: null }))).toHaveLength(0);
  });

  it('works for a dealer with no vendor registration (status set on the dealer itself)', async () => {
    const env = newEnv();
    await sopRules(env);
    const id = (await open(env)).body.data.id;
    expect((await env.db.table('dealers').get(IDS.dealerA1))?.portal_status).toBe('under_sop');
    await go(env, id, 'reminder'); await go(env, id, 'show_cause'); await go(env, id, 'deactivation');
    expect((await env.db.table('dealers').get(IDS.dealerA1))?.portal_status).toBe('deactivated');
    await go(env, id, 'closed');
    expect((await env.db.table('dealers').get(IDS.dealerA1))?.portal_status).toBe('active');
  });

  it('changing the rules changes every due date', async () => {
    const env = newEnv();
    await sopRules(env);
    await env.rule('mnre_sop.vendor_reply_days', 5, { effective_from: '2026-01-01' });
    await env.rule('mnre_sop.show_cause_days', 7, { effective_from: '2026-01-01' });
    await env.rule('mnre_sop.deactivation_months', 2, { effective_from: '2026-01-01' });
    await env.rule('mnre_sop.appeal_days', 10, { effective_from: '2026-01-01' });
    const created = await open(env);
    expect(created.body.data.reply_due_at).toBe('2026-10-31T18:29:59.999Z');
    const id = created.body.data.id;
    await go(env, id, 'reminder', '2026-11-01');
    expect((await go(env, id, 'show_cause', '2026-11-05')).body.data.show_cause_due_at).toBe('2026-11-12T18:29:59.999Z');
    const d = await go(env, id, 'deactivation', '2026-11-20');
    expect(d.body.data.appeal_due_at).toBe('2026-11-30T18:29:59.999Z');
    expect((await env.db.table('dealers').get(IDS.dealerA1))?.portal_status).toBe('deactivated');
    // the 2-month period is on the registration when one exists
    const env2 = newEnv();
    await sopRules(env2);
    await env2.rule('mnre_sop.deactivation_months', 2, { effective_from: '2026-01-01' });
    const reg = await registration(env2);
    const id2 = (await open(env2)).body.data.id;
    await go(env2, id2, 'reminder'); await go(env2, id2, 'show_cause'); await go(env2, id2, 'deactivation', '2026-11-30');
    expect((await env2.db.table('vendor_registrations').get(reg.id))?.deactivated_to).toBe('2027-01-30');
  });

  it('an inactive rule gives a warning and no clock; the tracker still records the case', async () => {
    const env = newEnv();
    await sopRules(env);
    for (const key of ['vendor_reply_days', 'show_cause_days', 'deactivation_months']) {
      const rule = (await env.db.table('rule_config').all({ key }))[0]!;
      await env.db.table('rule_config').update(rule.id, { is_active: false });
    }
    const created = await open(env);
    expect(created.status).toBe(201);
    expect(created.body.data.warnings.join(' ')).toMatch(/mnre_sop\.vendor_reply_days is not active/);
    expect(created.body.data.reply_due_at).toBeNull();
    expect(await env.db.table('clocks').count({ clock_type: 'sop_reply' })).toBe(0);
    const id = created.body.data.id;
    await go(env, id, 'reminder');
    const sc = await go(env, id, 'show_cause');
    expect(sc.body.data.warnings.join(' ')).toMatch(/mnre_sop\.show_cause_days is not active/);
    expect(sc.body.data.show_cause_due_at).toBeNull();
    expect(await env.db.table('clocks').count({ clock_type: 'sop_show_cause' })).toBe(0);
    const d = await go(env, id, 'deactivation', '2026-11-30');
    expect(d.body.data.warnings.join(' ')).toMatch(/deactivation_months is not active/);
    expect((await env.db.table('dealers').get(IDS.dealerA1))?.portal_status).toBe('deactivated'); // the status mirrors what MNRE did
  });

  it('refuses out-of-order moves and a reply outside the reply stages', async () => {
    const env = newEnv();
    await sopRules(env);
    const id = (await open(env)).body.data.id;
    const skip = await go(env, id, 'deactivation');
    expect(skip.status).toBe(409);
    expect(skip.body.error.details.allowed).toEqual(['reminder', 'closed']);
    expect((await go(env, id, 'closed')).body.data.stage).toBe('closed');
    expect((await go(env, id, 'reminder')).status).toBe(409);
    expect((await env.as('dsm').post(`${API}/sop-cases/${id}/reply`).send({})).status).toBe(409);
    expect((await go(env, id, 'bogus')).status).toBe(422);
    expect((await go(env, 'e1111111-1111-4111-8111-111111111111', 'closed')).status).toBe(404);
  });

  it('records the vendor’s reply (clock met), escalates silence through the clock engine, and keeps the status when another case is open', async () => {
    const env = newEnv();
    await sopRules(env);
    const a = (await open(env)).body.data.id;
    const rep = await env.as('dsm').post(`${API}/sop-cases/${a}/reply`).send({ replied_at: '2026-10-30' });
    expect(rep.body.data.replied_at).toBe('2026-10-29T18:30:00.000Z');
    expect((await env.db.table('clocks').all({ entity_id: a }))[0]!.status).toBe('met');

    const b = (await open(env, { complaint_ref: 'MNRE/C/2026/91' })).body.data.id;
    env.setNow(new Date('2026-11-05T05:00:00Z'));
    expect((await tickClocks(env.deps)).breached).toBe(1);
    expect(await env.db.table('notifications').count({ kind: 'sop.reply_overdue', entity_id: b })).toBeGreaterThan(0);
    const closedA = await go(env, a, 'closed');
    expect(closedA.body.data.warnings.join(' ')).toMatch(/Another SOP notice/);
    expect((await env.db.table('dealers').get(IDS.dealerA1))?.portal_status).toBe('under_sop');
    await go(env, b, 'closed');
    expect((await env.db.table('dealers').get(IDS.dealerA1))?.portal_status).toBe('active');
  });

  it('shows open cases on the dealer panel and keeps the tracker internal', async () => {
    const env = newEnv();
    await sopRules(env);
    const id = (await open(env)).body.data.id;
    const panel = await env.as('distributor_user').get(`${API}/dealers/${IDS.dealerA1}`);
    expect(panel.status).toBe(200);
    expect(panel.body.data.open_sop_cases.map((c: { id: string }) => c.id)).toEqual([id]);
    expect(panel.body.data.portal_status).toBe('under_sop');
    await go(env, id, 'closed');
    expect((await env.as('distributor_user').get(`${API}/dealers/${IDS.dealerA1}`)).body.data.open_sop_cases).toEqual([]);
    expect((await env.as('dealer_user').get(`${API}/sop-cases`)).status).toBe(403);
    expect((await env.as('dealer_user').post(`${API}/sop-cases`).send({ dealer_id: IDS.dealerA1, complaint_ref: 'x' })).status).toBe(403);
    expect((await env.as('viewer').post(`${API}/sop-cases`).send({ dealer_id: IDS.dealerA1, complaint_ref: 'x' })).status).toBe(403);
    const list = await env.as('compliance_officer').get(`${API}/sop-cases?stage=closed`);
    expect(list.body.total).toBe(1);
    expect((await env.as('compliance_officer').post(`${API}/sop-cases`).send({ dealer_id: IDS.dealerA2, complaint_ref: 'MNRE/C/2026/92' })).status).toBe(201);
  });
});
