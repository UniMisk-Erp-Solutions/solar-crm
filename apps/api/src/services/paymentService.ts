/**
 * Stage 5, step 30 (money side): record advance / balance / loan / subsidy payments against an issued PI,
 * keep the PI status (issued -> partially_paid -> paid) and the sales order's advance_received in step.
 */
import type { Payment, PiDetail, RecordPaymentInput } from '@solar/shared';
import type { AppContext } from '../auth/context';
import { assertCanRead } from '../auth/access';
import { guardBlocked, invalidState, notFound } from '../http/errors';
import { audit } from '../lib/audit';
import { actorId, advanceReceived, leadEvent, money, round2, toJson } from './orderSupport';
import { PI_ISSUED_STATUSES, loadPi, piDetail } from './piService';
import { afterMoneyOrCreditChange } from './salesOrderService';

/** issued / partially_paid / paid from the payments actually received. */
export async function syncPiPaymentStatus(ctx: AppContext, piId: string): Promise<void> {
  const pi = await ctx.db.table('proforma_invoices').get(piId);
  if (!pi || !PI_ISSUED_STATUSES.includes(pi.status)) return;
  const paid = await advanceReceived(ctx, pi.id);
  const next = paid + 0.005 >= pi.total ? 'paid' : paid > 0 ? 'partially_paid' : 'issued';
  if (next !== pi.status) await ctx.db.table('proforma_invoices').update(pi.id, { status: next });
}

export async function recordPayment(ctx: AppContext, piId: string, input: RecordPaymentInput): Promise<{ payment: Payment; pi: PiDetail }> {
  const pi = await loadPi(ctx, piId);
  if (!PI_ISSUED_STATUSES.includes(pi.status)) throw invalidState(`Payments can be recorded only against an issued proforma invoice (this one is "${pi.status}")`, { status: pi.status });
  if (input.status === 'received') {
    const paid = await advanceReceived(ctx, pi.id);
    const balance = round2(pi.total - paid);
    if (input.amount > balance + 0.005) throw guardBlocked(`This payment (${money(input.amount)}) is more than the outstanding balance of ${money(Math.max(0, balance))}`, { balance, amount: input.amount });
  }
  const payment = await ctx.db.table('payments').insert({
    pi_id: pi.id, sales_order_id: pi.sales_order_id, kind: input.kind, amount: round2(input.amount), mode: input.mode, reference: input.reference ?? null,
    received_at: input.received_at ?? ctx.now().toISOString(), recorded_by: actorId(ctx), status: input.status, created_by: actorId(ctx),
  });
  await syncPiPaymentStatus(ctx, pi.id);
  await afterMoneyOrCreditChange(ctx, pi.id);
  await audit(ctx, { action: 'payment.record', table: 'payments', record_id: payment.id, new: toJson(payment), detail: { pi_no: pi.pi_no } });
  const quote = await ctx.db.table('quotations').get(pi.quote_id);
  await leadEvent(ctx, quote?.lead_id, 'payment_recorded', `${input.kind} payment of ${money(payment.amount)} ${input.status === 'received' ? 'received' : 'noted as pending'} against ${pi.pi_no}`, { payment_id: payment.id });
  return { payment, pi: await piDetail(ctx, pi.id) };
}

export async function updatePayment(ctx: AppContext, id: string, patch: { status?: 'received' | 'pending' | 'bounced'; reference?: string }): Promise<{ payment: Payment; pi: PiDetail | null }> {
  const before = await ctx.db.table('payments').get(id);
  if (!before) throw notFound('Payment');
  if (before.pi_id) await assertCanRead(ctx, 'proforma_invoices', await ctx.db.table('proforma_invoices').getOrThrow(before.pi_id));
  if (patch.status === 'received' && before.status !== 'received' && before.pi_id) {
    const pi = await ctx.db.table('proforma_invoices').getOrThrow(before.pi_id);
    const balance = round2(pi.total - (await advanceReceived(ctx, pi.id)));
    if (before.amount > balance + 0.005) throw guardBlocked(`Marking this payment received would exceed the outstanding balance of ${money(Math.max(0, balance))}`, { balance });
  }
  const payment = await ctx.db.table('payments').update(id, { ...(patch.status ? { status: patch.status } : {}), ...(patch.reference !== undefined ? { reference: patch.reference } : {}) });
  if (before.pi_id) {
    await syncPiPaymentStatus(ctx, before.pi_id);
    await afterMoneyOrCreditChange(ctx, before.pi_id);
  }
  await audit(ctx, { action: before.status !== payment.status ? `payment.${payment.status}` : 'payment.update', table: 'payments', record_id: id, old: toJson(before), new: toJson(payment) });
  return { payment, pi: before.pi_id ? await piDetail(ctx, before.pi_id) : null };
}

export async function hydratePayments(ctx: AppContext, rows: Payment[]): Promise<(Payment & { pi_no: string | null })[]> {
  const pis = await ctx.db.table('proforma_invoices').all({ id: [...new Set(rows.map((r) => r.pi_id).filter((x): x is string => !!x))] });
  return rows.map((r) => ({ ...r, pi_no: pis.find((p) => p.id === r.pi_id)?.pi_no ?? null }));
}
