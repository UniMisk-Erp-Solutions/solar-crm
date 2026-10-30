/**
 * Dealer receivables (dealer_receivables): status maths, create / update preparation for the CRUD router,
 * the nightly overdue sweep and closure of subsidy-linked receivables when the subsidy is released.
 */
import { daysBetween, istDateString, type DealerReceivable, type Json, type ReceivableStatus } from '@solar/shared';
import type { AppContext } from '../auth/context';
import { badRequest, guardBlocked } from '../http/errors';
import { audit } from '../lib/audit';
import { registerJob } from './hooks';
import { loadByIds, mapById, uniq } from './postsaleShared';

/** The status a receivable SHOULD have on `today` (YYYY-MM-DD, IST). Written-off is terminal; fully paid is `paid`; past due and unpaid is `overdue`. */
export function effectiveReceivableStatus(r: Pick<DealerReceivable, 'amount' | 'paid_amount' | 'due_date' | 'status'>, today: string): ReceivableStatus {
  if (r.status === 'written_off') return 'written_off';
  if (r.paid_amount >= r.amount) return 'paid';
  return r.due_date < today ? 'overdue' : 'open';
}

export interface ReceivableDerived { open_amount: number; days_overdue: number; effective_status: ReceivableStatus }
export function receivableDerived(r: DealerReceivable, today: string): ReceivableDerived {
  const status = effectiveReceivableStatus(r, today);
  const open = status === 'paid' || status === 'written_off' ? 0 : Math.max(0, r.amount - r.paid_amount);
  return { open_amount: open, days_overdue: status === 'overdue' ? Math.max(0, daysBetween(r.due_date, today)) : 0, effective_status: status };
}

/** Rows returned by GET /receivables: the stored row with `status` already recalculated, plus open amount, days overdue and the dealer name. */
export async function hydrateReceivables(ctx: AppContext, rows: DealerReceivable[]): Promise<DealerReceivable[]> {
  const today = istDateString(ctx.now());
  const dealers = mapById(await loadByIds(ctx, 'dealers', rows.map((r) => r.dealer_id)));
  return rows.map((r) => {
    const d = receivableDerived(r, today);
    return { ...r, status: d.effective_status, open_amount: d.open_amount, days_overdue: d.days_overdue, dealer_name: dealers.get(r.dealer_id)?.legal_name ?? null } as DealerReceivable;
  });
}

export async function prepareReceivableCreate(ctx: AppContext, input: { dealer_id: string; amount: number; paid_amount?: number; due_date: string; status?: ReceivableStatus; linked_project_id?: string | null; subsidy_linked?: boolean }): Promise<Partial<DealerReceivable>> {
  const dealer = await ctx.db.table('dealers').get(input.dealer_id);
  if (!dealer) throw badRequest('Dealer not found');
  if ((input.paid_amount ?? 0) > input.amount) throw guardBlocked('Paid amount cannot exceed the invoice amount');
  const paid = input.paid_amount ?? 0;
  const status = effectiveReceivableStatus({ amount: input.amount, paid_amount: paid, due_date: input.due_date, status: input.status ?? 'open' }, istDateString(ctx.now()));
  return { distributor_id: dealer.distributor_id, paid_amount: paid, status, subsidy_linked: input.subsidy_linked ?? false, linked_project_id: input.linked_project_id ?? null };
}

export async function prepareReceivableUpdate(ctx: AppContext, input: Partial<Pick<DealerReceivable, 'amount' | 'paid_amount' | 'due_date' | 'status' | 'subsidy_linked'>>, current: DealerReceivable): Promise<Partial<DealerReceivable>> {
  const next = { amount: input.amount ?? current.amount, paid_amount: input.paid_amount ?? current.paid_amount, due_date: input.due_date ?? current.due_date, status: input.status ?? current.status };
  if (next.paid_amount > next.amount) throw guardBlocked('Paid amount cannot exceed the invoice amount');
  // an explicit write-off is respected; every other status is recalculated from the amounts and the due date
  return { status: effectiveReceivableStatus(next, istDateString(ctx.now())) };
}

/** Persist open → overdue (and overdue → open / paid) for every live receivable. Runs nightly; the exposure maths does not depend on it. */
export async function refreshReceivableStatuses(ctx: AppContext): Promise<{ scanned: number; updated: number }> {
  const today = istDateString(ctx.now());
  const rows = await ctx.db.table('dealer_receivables').all({ status: ['open', 'overdue'] });
  let updated = 0;
  for (const r of rows) {
    const next = effectiveReceivableStatus(r, today);
    if (next !== r.status) { await ctx.db.table('dealer_receivables').update(r.id, { status: next }); updated++; }
  }
  return { scanned: rows.length, updated };
}

/**
 * Close every subsidy-linked receivable tied to the project(s): the subsidy has reached the consumer / loan account, so the dealer's
 * subsidy-linked exposure is released. `linked_project_id` may hold a sales order, installation or opportunity id.
 */
export async function closeSubsidyLinkedReceivables(ctx: AppContext, projectIds: (string | null | undefined)[], reason: string): Promise<number> {
  const ids = uniq(projectIds);
  if (!ids.length) return 0;
  const rows = await ctx.db.table('dealer_receivables').all({ subsidy_linked: true, linked_project_id: ids, status: ['open', 'overdue'] });
  for (const r of rows) {
    const updated = await ctx.db.table('dealer_receivables').update(r.id, { paid_amount: r.amount, status: 'paid' });
    await audit(ctx, { action: 'receivable.close_subsidy_released', table: 'dealer_receivables', record_id: r.id, old: r as unknown as Json, new: updated as unknown as Json, detail: { reason, project_ids: ids } });
  }
  return rows.length;
}

registerJob({ name: 'receivables.overdue_sweep', schedule: '30 1 * * *', run: (ctx) => refreshReceivableStatuses(ctx) });
