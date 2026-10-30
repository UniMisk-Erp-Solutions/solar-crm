import { describe, expect, it } from 'vitest';
import { LOAN_REJECTION_CODES } from '@solar/shared';
import { tickClocks } from '../../src/services/clockService';
import { API, IDS, newEnv } from './fixtures';
import type { TestEnv } from '../helpers/env';

const post = (env: TestEnv, who: string, body: Record<string, unknown>) => env.as(who).post(`${API}/loans`).send(body);

describe('loans — status ladder, picklists and free-input rate', () => {
  it('creates a draft pinned to the dealer’s own party and never defaults the interest rate', async () => {
    const env = newEnv();
    const r = await post(env, 'dealer_user', { bank: 'HDFC Bank', dealer_id: IDS.dealerB1, distributor_id: IDS.distributorB, co_applicant: 'Meena Patel', document_checklist: { pan: true, bank_statement: false } });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({
      status: 'draft', bank: 'HDFC Bank', dealer_id: IDS.dealerA1, distributor_id: IDS.distributorA, rate_pct: null, rate_source_date: null, rejection_code: null, application_date: null,
      co_applicant: 'Meena Patel', document_checklist: { pan: true, bank_statement: false },
    });
    expect(await env.db.table('clocks').count({ clock_type: 'loan_ageing' })).toBe(0);
  });

  it('a rate must come with the date it was sourced', async () => {
    const env = newEnv();
    const bad = await post(env, 'admin', { bank: 'SBI', rate_pct: 7 });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('GUARD_BLOCKED');
    const ok = await post(env, 'admin', { bank: 'SBI', rate_pct: 7, rate_source_date: '2026-10-01' });
    expect(ok.body.data).toMatchObject({ rate_pct: 7, rate_source_date: '2026-10-01' });
    const clear = await env.as('admin').patch(`${API}/loans/${ok.body.data.id}`).send({ rate_source_date: null });
    expect(clear.status).toBe(422);
  });

  it('follows the ladder and demands a rejection code from the picklist', async () => {
    const env = newEnv();
    const loan = (await post(env, 'admin', { bank: 'SBI' })).body.data;
    const patch = (body: Record<string, unknown>) => env.as('admin').patch(`${API}/loans/${loan.id}`).send(body);
    expect((await patch({ status: 'approved' })).status).toBe(422); // draft → approved is not allowed
    const applied = await patch({ status: 'applied' });
    expect(applied.body.data.status).toBe('applied');
    expect(applied.body.data.application_date).toBe('2026-10-26'); // today when not given
    expect((await patch({ status: 'rejected' })).status).toBe(422); // no code
    expect((await patch({ status: 'rejected', rejection_code: 'because' })).status).toBe(422); // not on the picklist
    for (const code of LOAN_REJECTION_CODES) expect(['name_mismatch', 'arrears', 'land_title', 'collateral_demanded', 'missing_documents', 'other']).toContain(code);
    const rej = await patch({ status: 'rejected', rejection_code: 'land_title' });
    expect(rej.body.data).toMatchObject({ status: 'rejected', rejection_code: 'land_title' });
    expect((await patch({ rejection_code: 'arrears' })).body.data.rejection_code).toBe('arrears'); // correctable while rejected
    const re = await patch({ status: 'applied' }); // re-apply with a co-applicant
    expect(re.body.data).toMatchObject({ status: 'applied', rejection_code: null });
    expect((await patch({ rejection_code: 'arrears' })).status).toBe(400);
    expect((await patch({ status: 'approved' })).body.data.status).toBe('approved');
    const disbursed = await patch({ status: 'disbursed' });
    expect(disbursed.body.data.disbursed_at).toBe(env.now().toISOString());
    expect((await patch({ status: 'applied' })).status).toBe(422);
    expect((await env.db.table('audit_log').all({ action: 'loan.status_change' })).length).toBeGreaterThanOrEqual(5);
  });
});

describe('loan ageing clock', () => {
  it('starts on applied (from the actual application date), completes on a decision', async () => {
    const env = newEnv();
    const loan = (await post(env, 'admin', { bank: 'Bank of Baroda', status: 'applied', application_date: '2026-10-20' })).body.data;
    const clock = (await env.db.table('clocks').all({ entity_id: loan.id, clock_type: 'loan_ageing' }))[0]!;
    expect(clock).toMatchObject({ status: 'running', entity_type: 'loan', started_at: '2026-10-19T18:30:00.000Z', due_at: '2026-11-04T18:29:59.999Z' }); // 20-Oct + 15 days
    await env.as('admin').patch(`${API}/loans/${loan.id}`).send({ status: 'approved' });
    expect((await env.db.table('clocks').get(clock.id))?.status).toBe('met');
  });

  it('the warning threshold comes from rule loan.ageing_warn_days', async () => {
    const env = newEnv();
    await env.rule('loan.ageing_warn_days', 30);
    const loan = (await post(env, 'admin', { bank: 'SBI', status: 'applied', application_date: '2026-10-20' })).body.data;
    expect((await env.db.table('clocks').all({ entity_id: loan.id }))[0]!.due_at).toBe('2026-11-19T18:29:59.999Z');
  });

  it('a stale application only warns (DSM + owner), once, and never escalates to Management', async () => {
    const env = newEnv();
    const loan = (await post(env, 'dsm', { bank: 'SBI', status: 'applied', application_date: '2026-10-01' })).body.data;
    env.setNow(new Date('2026-11-20T05:00:00Z'));
    await tickClocks(env.deps);
    expect(await env.db.table('notifications').count({ kind: 'loan.ageing', entity_id: loan.id })).toBe(1);
    const clock = (await env.db.table('clocks').all({ entity_id: loan.id }))[0]!;
    expect(clock.status).toBe('breached');
    expect(clock.resolved_at).not.toBeNull();
    env.setNow(new Date('2026-12-30T05:00:00Z'));
    expect((await tickClocks(env.deps)).escalated).toBe(0);
    const board = await env.as('dsm').get(`${API}/loans`);
    expect(board.body.data[0]).toMatchObject({ ageing_over_threshold: true, age_days: 90 });
  });
});

describe('loan summary — approved ÷ applied', () => {
  async function seed(env: TestEnv) {
    const mk = (bank: string, status: string, o: Record<string, unknown> = {}) => env.ctx().db.table('loans').insert({
      bank, status: status as never, dealer_id: IDS.dealerA1, distributor_id: IDS.distributorA, application_date: '2026-10-10', rejection_code: null, rate_pct: null, rate_source_date: null, document_checklist: {}, ...o,
    });
    await mk('HDFC Bank', 'approved'); await mk('HDFC Bank', 'rejected', { rejection_code: 'name_mismatch' });
    await mk('HDFC Bank', 'rejected', { rejection_code: 'name_mismatch' }); await mk('HDFC Bank', 'in_review');
    await mk('SBI', 'disbursed'); await mk('SBI', 'approved'); await mk('SBI', 'rejected', { rejection_code: 'arrears' });
    await mk('SBI', 'draft', { application_date: null });
    await mk('PNB', 'rejected', { dealer_id: IDS.dealerB1, distributor_id: IDS.distributorB });
  }

  it('groups by bank and dealer and breaks rejections down by code', async () => {
    const env = newEnv();
    await seed(env);
    const r = await env.as('sales_manager').get(`${API}/loans/summary`);
    expect(r.status).toBe(200);
    const s = r.body.data;
    expect(s.overall).toMatchObject({ applied: 8, approved: 3, rejected: 4, disbursed: 1, approval_rate_pct: 37.5 }); // the draft is not an application
    expect(s.by_bank.find((b: { label: string }) => b.label === 'HDFC Bank')).toMatchObject({ applied: 4, approved: 1, approval_rate_pct: 25 });
    expect(s.by_bank.find((b: { label: string }) => b.label === 'SBI')).toMatchObject({ applied: 3, approved: 2, approval_rate_pct: 66.7 });
    expect(s.rejection_codes).toEqual([{ code: 'name_mismatch', count: 2 }, { code: 'arrears', count: 1 }, { code: 'unspecified', count: 1 }]);
    expect(s.by_dealer.find((d: { key: string }) => d.key === IDS.dealerA1)).toMatchObject({ label: 'Sunrise Installers', applied: 7 });
    expect(s.ageing).toMatchObject({ warn_days: 15, pending: 1, over_threshold: 1 });
    const filtered = await env.as('sales_manager').get(`${API}/loans/summary?bank=SBI&dealer_id=${IDS.dealerA1}`);
    expect(filtered.body.data.overall.applied).toBe(3);
  });

  it('is scoped to the caller’s own loans', async () => {
    const env = newEnv();
    await seed(env);
    expect((await env.as('dealer_user').get(`${API}/loans/summary`)).body.data.overall.applied).toBe(7);
    expect((await env.as(IDS.dealerUserB).get(`${API}/loans/summary`)).body.data.overall.applied).toBe(1);
    expect((await env.as(IDS.distributorUserB).get(`${API}/loans`)).body.total).toBe(1);
  });
});
