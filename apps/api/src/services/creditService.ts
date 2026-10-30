/**
 * Stage 5, step 30 (credit side): the "advance received OR credit approved?" decision, dealer credit position and credit overrides.
 *  - basis "advance": decided immediately from the payments received against the PI (rule order.min_advance_pct, default 30 %).
 *  - basis "credit": snapshots the dealer's exposure (limit, ageing, subsidy-linked, bank guarantee, portal status) and waits for Accounts.
 *  - credit override: request + approval chain (Accounts -> Management); an APPROVED row is what the sales-order guard (G11) looks for.
 */
import type { Approval, CreditAgeing, CreditCheck, CreditCheckDetail, CreditOverride, ProformaInvoice } from '@solar/shared';
import type { AppContext } from '../auth/context';
import { assertCanRead } from '../auth/access';
import { badRequest, conflict, invalidState, notFound } from '../http/errors';
import { audit } from '../lib/audit';
import { computeDealerExposure, type DealerExposure } from './exposure';
import { registerApprovalHandler, type ApprovalOutcome } from './hooks';
import { actorId, activateNextStep, advanceReceived, leadEvent, minAdvancePct, money, openApproval, requiredAdvance, roundState, round2, skipPending, toJson } from './orderSupport';
import { PI_ISSUED_STATUSES, loadPi } from './piService';
import { afterMoneyOrCreditChange, evaluateCreditGuard } from './salesOrderService';

const NO_AGEING: CreditAgeing = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };

/* ───────────── hydration ───────────── */

export async function hydrateCreditChecks(ctx: AppContext, rows: CreditCheck[], opts: { withGuard?: boolean } = {}): Promise<CreditCheckDetail[]> {
  if (!rows.length) return [];
  const [pis, dealers, pct] = await Promise.all([
    ctx.db.table('proforma_invoices').all({ id: [...new Set(rows.map((r) => r.pi_id).filter((x): x is string => !!x))] }),
    ctx.db.table('dealers').all({ id: [...new Set(rows.map((r) => r.dealer_id).filter((x): x is string => !!x))] }),
    minAdvancePct(ctx),
  ]);
  const out: CreditCheckDetail[] = [];
  for (const r of rows) {
    const pi = pis.find((p) => p.id === r.pi_id) ?? null;
    const advance = pi ? await advanceReceived(ctx, pi.id) : 0;
    const guard = opts.withGuard && pi ? await evaluateCreditGuard(ctx, pi, advance) : null;
    out.push({
      ...r, pi_no: pi?.pi_no ?? null, dealer_name: dealers.find((d) => d.id === r.dealer_id)?.legal_name ?? null, pi_total: pi?.total ?? null, advance_received: advance,
      required_advance: pi ? requiredAdvance(pi.total, pct) : 0, exposure_after: guard ? guard.exposure_after : pi && r.dealer_id ? round2(r.outstanding + Math.max(0, pi.total - advance)) : null, guard,
    });
  }
  return out;
}

export async function creditCheckDetail(ctx: AppContext, id: string): Promise<CreditCheckDetail> {
  const cc = await ctx.db.table('credit_checks').get(id);
  if (!cc) throw notFound('Credit check');
  await assertCanRead(ctx, 'credit_checks', cc);
  return (await hydrateCreditChecks(ctx, [cc], { withGuard: true }))[0]!;
}

/* ───────────── run / decide ───────────── */

async function snapshot(ctx: AppContext, pi: ProformaInvoice): Promise<Pick<CreditCheck, 'credit_limit' | 'outstanding' | 'ageing' | 'subsidy_linked' | 'bg_valid' | 'portal_status'> & { exposure: DealerExposure | null }> {
  if (!pi.dealer_id) return { credit_limit: 0, outstanding: 0, ageing: NO_AGEING, subsidy_linked: 0, bg_valid: null, portal_status: null, exposure: null };
  const e = await computeDealerExposure(ctx, pi.dealer_id);
  return { credit_limit: e.credit_limit, outstanding: e.outstanding, ageing: e.ageing, subsidy_linked: e.subsidy_linked, bg_valid: e.bank_guarantee.valid, portal_status: e.portal_status, exposure: e };
}

export async function runCreditCheck(ctx: AppContext, piId: string, basis: 'advance' | 'credit'): Promise<CreditCheckDetail> {
  const pi = await loadPi(ctx, piId);
  if (!PI_ISSUED_STATUSES.includes(pi.status)) throw invalidState(`A credit check needs an issued proforma invoice (this one is "${pi.status}")`, { status: pi.status });
  const { exposure, ...snap } = await snapshot(ctx, pi);
  const base = { pi_id: pi.id, sales_order_id: pi.sales_order_id, dealer_id: pi.dealer_id, distributor_id: pi.distributor_id, basis, ...snap, created_by: actorId(ctx) };
  let row: CreditCheck;

  if (basis === 'advance') {
    const [advance, pct] = await Promise.all([advanceReceived(ctx, pi.id), minAdvancePct(ctx)]);
    const required = requiredAdvance(pi.total, pct);
    const ok = advance + 0.005 >= required;
    row = await ctx.db.table('credit_checks').insert({
      ...base, result: ok ? 'approved' : 'rejected', decided_by: null, decided_at: ctx.now().toISOString(),
      notes: `Automatic: ${money(advance)} received against a required advance of ${money(required)} (${pct}% of ${money(pi.total)}) — ${ok ? 'advance satisfied' : 'advance not yet received'}`,
    });
  } else {
    if (!pi.dealer_id) throw badRequest('Credit basis is available only for dealer orders — this PI has no dealer. Use the advance basis.');
    const open = await ctx.db.table('credit_checks').one({ pi_id: pi.id, basis: 'credit', result: 'pending' });
    if (open) throw conflict('A credit check for this PI is already waiting for Accounts to decide', { credit_check_id: open.id });
    row = await ctx.db.table('credit_checks').insert({
      ...base, result: 'pending', decided_by: null, decided_at: null,
      notes: exposure ? `Dealer exposure ${money(exposure.outstanding)} of ${money(exposure.credit_limit)} limit; overdue ${money(exposure.overdue_amount)}; subsidy-linked ${money(exposure.subsidy_linked)}${exposure.blocked_reasons.length ? `; flags: ${exposure.blocked_reasons.join(', ')}` : ''}` : null,
    });
    await ctx.svc.notify.notify({ roles: ['accounts', 'management'], kind: 'credit_check.pending', title: `Credit decision needed — ${pi.pi_no}`, body: `${exposure?.dealer_name ?? ''}: order ${money(pi.total)}`, severity: 'info', link: `/invoices/${pi.id}`, entity_type: 'credit_check', entity_id: row.id });
  }
  await audit(ctx, { action: `credit_check.${basis}`, table: 'credit_checks', record_id: row.id, new: toJson(row), detail: { pi_no: pi.pi_no, result: row.result } });
  if (row.result === 'approved') await afterMoneyOrCreditChange(ctx, pi.id);
  return creditCheckDetail(ctx, row.id);
}

export async function decideCreditCheck(ctx: AppContext, id: string, input: { result: 'approved' | 'rejected'; notes?: string }): Promise<CreditCheckDetail> {
  const cc = await ctx.db.table('credit_checks').get(id);
  if (!cc) throw notFound('Credit check');
  await assertCanRead(ctx, 'credit_checks', cc);
  if (cc.result !== 'pending') throw conflict(`This credit check was already decided (${cc.result})`, { result: cc.result });
  const row = await ctx.db.table('credit_checks').update(id, {
    result: input.result, notes: [cc.notes, input.notes ? `Decision: ${input.notes}` : null].filter(Boolean).join(' | ') || null, decided_by: actorId(ctx), decided_at: ctx.now().toISOString(),
  });
  await audit(ctx, { action: `credit_check.${input.result}`, table: 'credit_checks', record_id: id, old: toJson(cc), new: toJson(row) });
  const pi = cc.pi_id ? await ctx.db.table('proforma_invoices').get(cc.pi_id) : null;
  if (cc.created_by && cc.created_by !== ctx.user.id) {
    await ctx.svc.notify.notify({ user_ids: [cc.created_by], kind: `credit_check.${input.result}`, title: `Credit ${input.result} for ${pi?.pi_no ?? 'the order'}`, body: input.notes, severity: input.result === 'approved' ? 'success' : 'warning', entity_type: 'credit_check', entity_id: id });
  }
  const quote = pi ? await ctx.db.table('quotations').get(pi.quote_id) : null;
  await leadEvent(ctx, quote?.lead_id, 'credit_decision', `Credit ${input.result} for ${pi?.pi_no ?? ''}`, { credit_check_id: id });
  if (pi) {
    if (input.result === 'approved') await afterMoneyOrCreditChange(ctx, pi.id);
    else if (pi.sales_order_id) {
      const so = await ctx.db.table('sales_orders').get(pi.sales_order_id);
      if (so?.status === 'on_hold') await ctx.db.table('sales_orders').update(so.id, { hold_reason: `${so.hold_reason ?? 'On hold'} | Credit rejected${input.notes ? `: ${input.notes}` : ''}` });
    }
  }
  return creditCheckDetail(ctx, id);
}

/* ───────────── dealer credit position ───────────── */

export async function creditPosition(ctx: AppContext, dealerId: string): Promise<DealerExposure & { overrides: CreditOverride[]; recent_checks: CreditCheck[] }> {
  const dealer = await ctx.db.table('dealers').get(dealerId);
  if (!dealer) throw notFound('Dealer');
  await assertCanRead(ctx, 'dealers', dealer);
  const [exposure, overrides, checks] = await Promise.all([
    computeDealerExposure(ctx, dealerId),
    ctx.db.table('credit_overrides').all({ dealer_id: dealerId }, { orderBy: { col: 'created_at', dir: 'desc' } }),
    ctx.db.table('credit_checks').all({ dealer_id: dealerId }, { orderBy: { col: 'created_at', dir: 'desc' } }),
  ]);
  return { ...exposure, overrides, recent_checks: checks.slice(0, 10) };
}

/* ───────────── credit override (Accounts -> Management) ───────────── */

export async function requestCreditOverride(ctx: AppContext, input: { dealer_id: string; pi_id: string; reason: string }): Promise<{ override: CreditOverride; approvals: Approval[] }> {
  const dealer = await ctx.db.table('dealers').get(input.dealer_id);
  if (!dealer) throw notFound('Dealer');
  const pi = await loadPi(ctx, input.pi_id);
  if (pi.dealer_id !== dealer.id) throw badRequest('This proforma invoice does not belong to that dealer');
  const dup = (await ctx.db.table('credit_overrides').all({ dealer_id: dealer.id, pi_id: pi.id, status: ['pending', 'approved'] }))[0];
  if (dup) throw conflict(`A credit override for this PI is already ${dup.status}`, { credit_override_id: dup.id, status: dup.status });
  const row = await ctx.db.table('credit_overrides').insert({
    dealer_id: dealer.id, pi_id: pi.id, sales_order_id: pi.sales_order_id, reason: input.reason, status: 'pending', requested_by: actorId(ctx), approved_by: null, approved_at: null, created_by: actorId(ctx),
  });
  const approvals = await openApproval(ctx, {
    entity_type: 'credit_override', entity_id: row.id, lane: 'credit', chain: ['accounts', 'management'], label: `Credit override — ${dealer.legal_name} (${pi.pi_no})`,
    extra: { dealer_id: dealer.id, pi_id: pi.id, reason: input.reason },
  });
  await audit(ctx, { action: 'credit_override.request', table: 'credit_overrides', record_id: row.id, new: toJson(row), detail: { pi_no: pi.pi_no } });
  return { override: row, approvals };
}

export async function creditOverrideDetail(ctx: AppContext, id: string): Promise<{ override: CreditOverride; dealer_name: string | null; pi_no: string | null; approvals: Approval[] }> {
  const o = await ctx.db.table('credit_overrides').get(id);
  if (!o) throw notFound('Credit override');
  const [dealer, pi, approvals] = await Promise.all([
    ctx.db.table('dealers').get(o.dealer_id), o.pi_id ? ctx.db.table('proforma_invoices').get(o.pi_id) : Promise.resolve(null),
    ctx.db.table('approvals').all({ entity_type: 'credit_override', entity_id: id }, { orderBy: [{ col: 'requested_at' }, { col: 'step' }] }),
  ]);
  return { override: o, dealer_name: dealer?.legal_name ?? null, pi_no: pi?.pi_no ?? null, approvals };
}

async function onOverrideApproval(ctx: AppContext, approval: Approval, outcome: ApprovalOutcome): Promise<void> {
  const o = await ctx.db.table('credit_overrides').get(approval.entity_id);
  if (!o || o.status !== 'pending') return;
  const state = await roundState(ctx, approval);
  const requester = o.requested_by ? [o.requested_by] : [];
  if (outcome === 'rejected' || state.rejected) {
    await skipPending(ctx, 'credit_override', o.id);
    await ctx.db.table('credit_overrides').update(o.id, { status: 'rejected' });
    await audit(ctx, { action: 'credit_override.rejected', table: 'credit_overrides', record_id: o.id, detail: { comment: (state.rejected ?? approval).comment ?? null } });
    if (requester.length) await ctx.svc.notify.notify({ user_ids: requester, kind: 'credit_override.rejected', title: 'Credit override rejected', body: (state.rejected ?? approval).comment ?? undefined, severity: 'warning', entity_type: 'credit_override', entity_id: o.id });
    return;
  }
  if (!(outcome === 'lane_approved' || state.allApproved)) {
    if (outcome === 'step_approved') await activateNextStep(ctx, approval);
    return;
  }
  const row = await ctx.db.table('credit_overrides').update(o.id, { status: 'approved', approved_by: state.lastApprover, approved_at: ctx.now().toISOString() });
  await audit(ctx, { action: 'credit_override.approved', table: 'credit_overrides', record_id: o.id, old: toJson(o), new: toJson(row) });
  if (requester.length) await ctx.svc.notify.notify({ user_ids: requester, kind: 'credit_override.approved', title: 'Credit override approved', body: 'You can now create the sales order for this PI.', severity: 'success', entity_type: 'credit_override', entity_id: o.id });
}
registerApprovalHandler('credit_override', onOverrideApproval);

