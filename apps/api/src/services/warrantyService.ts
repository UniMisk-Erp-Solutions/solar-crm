/**
 * Warranty / RMA tickets: raised by serial (ticket_no FS/W/<yy>/<nnnn>), brand claim number, free cost-bearer picklist (split unknown),
 * RMA turnaround clock (`warranty_rma`, rule warranty.rma_tat_days default 21), status ladder, brand-claim recovery, and the
 * serial's journey to `rma` and back.
 */
import { daysBetween, istDateString, type InventorySerial, type Json, type WarrantyStatus, type WarrantyTicket, type WarrantyTicketCreateInput, type WarrantyTicketUpdateInput } from '@solar/shared';
import type { AppContext } from '../auth/context';
import { assertCanRead } from '../auth/access';
import { guardBlocked, notFound } from '../http/errors';
import { audit } from '../lib/audit';
import type { WithWarnings } from './installationService';
import { actorId, dueAfterDays, istDay, loadByIds, mapById, ruleNumber } from './postsaleShared';

export const WARRANTY_NEXT: Record<WarrantyStatus, WarrantyStatus[]> = {
  open: ['inspected', 'sent_to_brand', 'replaced', 'rejected', 'closed'],
  inspected: ['sent_to_brand', 'replaced', 'rejected', 'closed'],
  sent_to_brand: ['replaced', 'rejected', 'closed'],
  replaced: ['closed'],
  rejected: ['sent_to_brand', 'closed'],
  closed: [],
};
const CLOCKED_TYPES: WarrantyTicket['type'][] = ['warranty', 'rma'];
const RESOLVING: WarrantyStatus[] = ['replaced', 'rejected', 'closed'];

/** Next ticket number FS/W/<yy>/<nnnn> (yy = IST year, nnnn restarts every year). */
export async function nextTicketNo(ctx: AppContext): Promise<string> {
  const yy = istDay(ctx.now()).slice(2, 4);
  const prefix = `FS/W/${yy}/`;
  const used = await ctx.db.table('warranty_tickets').all({ ticket_no: { like: `${prefix}%` } });
  const max = used.reduce((m, t) => Math.max(m, Number(t.ticket_no.slice(prefix.length)) || 0), 0);
  return `${prefix}${String(max + 1).padStart(4, '0')}`;
}

async function findSerial(ctx: AppContext, input: Pick<WarrantyTicketCreateInput, 'serial' | 'serial_id'>): Promise<InventorySerial | null> {
  if (input.serial_id) { const s = await ctx.db.table('inventory_serials').get(input.serial_id); if (!s) throw notFound('Serial'); return s; }
  if (input.serial) { const s = await ctx.db.table('inventory_serials').one({ serial: input.serial }); if (!s) throw notFound(`Serial ${input.serial}`); return s; }
  return null;
}

/** Serial returns to the installed base (or stock-out state) after an RMA that did not replace the unit. */
const restoredStatus = (s: InventorySerial): InventorySerial['status'] => (s.installed_at ? 'installed' : 'dispatched');

export async function createWarrantyTicket(ctx: AppContext, input: WarrantyTicketCreateInput): Promise<WithWarnings<WarrantyTicket>> {
  const warnings: string[] = [];
  const serial = await findSerial(ctx, input);
  const soId = serial?.sales_order_id ?? input.sales_order_id ?? null;
  const so = soId ? await ctx.db.table('sales_orders').get(soId) : null;
  if (soId && !so) throw notFound('Sales order');
  if (so) await assertCanRead(ctx, 'sales_orders', so);
  const inst = input.installation_id ? await ctx.db.table('installations').get(input.installation_id) : so ? await ctx.db.table('installations').one({ sales_order_id: so.id }) : null;
  if (input.installation_id && !inst) throw notFound('Installation');
  if (inst) await assertCanRead(ctx, 'installations', inst);
  if (serial && serial.status === 'in_stock') throw guardBlocked(`Serial ${serial.serial} is still in stock — it has not been sold or installed`);

  const opened = ctx.now();
  let rma_due_at: string | null = null;
  if (CLOCKED_TYPES.includes(input.type)) {
    const days = await ruleNumber(ctx, 'warranty.rma_tat_days', 21, 'RMA turnaround clock not started');
    if (days.warning) warnings.push(days.warning);
    if (days.value !== null) rma_due_at = dueAfterDays(opened, days.value).toISOString();
  }
  // a warranty claim is only a warranty claim while the product is in warranty
  if (serial && inst?.warranty_end && inst.warranty_end < istDay(opened) && (input.type === 'warranty' || input.type === 'rma')) {
    warnings.push(`The installation's warranty ended on ${inst.warranty_end} — confirm the brand will accept this claim and who bears the cost.`);
  }
  const external = ctx.user.role === 'dealer_user';
  const row = await ctx.db.table('warranty_tickets').insert({
    ticket_no: await nextTicketNo(ctx), serial_id: serial?.id ?? null, sales_order_id: so?.id ?? null, installation_id: inst?.id ?? null,
    customer_id: input.customer_id ?? so?.customer_id ?? inst?.customer_id ?? null, dealer_id: external ? ctx.user.dealer_id : input.dealer_id ?? so?.dealer_id ?? inst?.dealer_id ?? null,
    type: input.type, issue: input.issue, brand_claim_no: input.brand_claim_no ?? null, cost_bearer: input.cost_bearer ?? 'unknown', status: 'open', opened_at: opened.toISOString(),
    rma_due_at, closed_at: null, recovered_amount: 0, owner_id: input.owner_id ?? actorId(ctx), created_by: actorId(ctx),
  });
  if (rma_due_at) {
    await ctx.svc.clocks.start({ entity_type: 'warranty_ticket', entity_id: row.id, clock_type: 'warranty_rma', due_at: rma_due_at, started_at: opened, owner_id: row.owner_id, meta: { ticket_no: row.ticket_no, type: row.type } as Json });
  }
  if (serial && input.type === 'rma') await ctx.db.table('inventory_serials').update(serial.id, { status: 'rma' });
  await audit(ctx, { action: 'warranty_ticket.create', table: 'warranty_tickets', record_id: row.id, new: row as unknown as Json });
  return { ...row, warnings };
}

export async function updateWarrantyTicket(ctx: AppContext, id: string, input: WarrantyTicketUpdateInput): Promise<WithWarnings<WarrantyTicket>> {
  const warnings: string[] = [];
  const before = await ctx.db.table('warranty_tickets').get(id);
  if (!before) throw notFound('Warranty ticket');
  await assertCanRead(ctx, 'warranty_tickets', before);
  const patch: Partial<WarrantyTicket> = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as Partial<WarrantyTicket>;
  if (input.status && input.status !== before.status) {
    if (!WARRANTY_NEXT[before.status].includes(input.status)) throw guardBlocked(`A ticket cannot move from ${before.status.replace(/_/g, ' ')} to ${input.status.replace(/_/g, ' ')}`, { allowed: WARRANTY_NEXT[before.status] });
    if (input.status === 'closed') patch.closed_at = ctx.now().toISOString();
  } else delete patch.status;
  const recovered = patch.recovered_amount ?? before.recovered_amount;
  if (recovered > 0 && !(patch.brand_claim_no ?? before.brand_claim_no)) warnings.push('Recovery recorded without a brand claim number — add the brand claim number so Accounts can reconcile it.');
  if (!Object.keys(patch).length) return { ...before, warnings };
  const row = await ctx.db.table('warranty_tickets').update(id, patch);

  if (patch.status) {
    if (RESOLVING.includes(patch.status)) await ctx.svc.clocks.complete('warranty_ticket', id, 'warranty_rma', { status: patch.status });
    if (before.serial_id) {
      const serial = await ctx.db.table('inventory_serials').get(before.serial_id);
      if (serial) {
        if (patch.status === 'sent_to_brand' && serial.status !== 'rma') await ctx.db.table('inventory_serials').update(serial.id, { status: 'rma' });
        // a replaced unit stays out of the installed base; a closed / rejected ticket sends the (repaired or returned) unit back
        else if ((patch.status === 'closed' && before.status !== 'replaced') || patch.status === 'rejected') {
          if (serial.status === 'rma') await ctx.db.table('inventory_serials').update(serial.id, { status: restoredStatus(serial) });
        }
      }
    }
  }
  await audit(ctx, { action: patch.status ? 'warranty_ticket.status_change' : 'warranty_ticket.update', table: 'warranty_tickets', record_id: id, old: before as unknown as Json, new: row as unknown as Json });
  return { ...row, warnings };
}

export async function hydrateWarrantyTickets(ctx: AppContext, rows: WarrantyTicket[]): Promise<WarrantyTicket[]> {
  const now = ctx.now();
  const today = istDateString(now);
  const [serials, dealers, customers] = await Promise.all([
    loadByIds(ctx, 'inventory_serials', rows.map((r) => r.serial_id)).then(mapById),
    loadByIds(ctx, 'dealers', rows.map((r) => r.dealer_id)).then(mapById),
    loadByIds(ctx, 'customers', rows.map((r) => r.customer_id)).then(mapById),
  ]);
  return rows.map((r) => {
    const end = r.closed_at ?? now.toISOString();
    const done = RESOLVING.includes(r.status);
    const cu = customers.get(r.customer_id ?? '');
    return {
      ...r, serial_no: serials.get(r.serial_id ?? '')?.serial ?? null, dealer_name: dealers.get(r.dealer_id ?? '')?.legal_name ?? null, customer_name: cu?.display_name ?? cu?.legal_name ?? null,
      turnaround_days: Math.max(0, daysBetween(r.opened_at, end)), rma_overdue: !done && !!r.rma_due_at && new Date(r.rma_due_at) < now,
      days_to_rma_due: !done && r.rma_due_at ? daysBetween(today, r.rma_due_at) : null,
    } as WarrantyTicket;
  });
}

