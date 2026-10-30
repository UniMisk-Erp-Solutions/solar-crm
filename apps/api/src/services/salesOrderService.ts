/**
 * Stage 5, steps 30-34: payment / credit decision, gate G11 (credit exposure guard), sales order, approval, circulation and hand-over.
 *
 *  Guard G11 (Appendix A):  exposure_after = outstanding(open + overdue dealer receivables) + max(0, order_total - advance_received)
 *  The order is blocked when exposure_after > dealer credit_limit OR the dealer is deactivated on the portal (under_sop only warns),
 *  unless an approved credit override exists for the dealer and this PI. The SQL trigger enforces the same rule.
 */
import {
  type Approval, type AppRole, type Clock, type CreditCheck, type CreditGuardResult, type CreateSalesOrderInput, type Json, type ProformaInvoice,
  type SalesOrder, type SalesOrderDetail, type SalesOrderLine, type SalesOrderLineDetail, type SalesOrderSummary, isSerialTracked,
} from '@solar/shared';
import type { AppContext } from '../auth/context';
import { assertCanRead } from '../auth/access';
import { AppError, conflict, guardBlocked, invalidState, notFound } from '../http/errors';
import { audit } from '../lib/audit';
import { cancelOpenDispatches } from './dispatchService';
import { computeDealerExposure } from './exposure';
import { registerApprovalHandler, registerClockHandlers, type ApprovalOutcome } from './hooks';
import {
  actorId, activateNextStep, advanceReceived, advanceSatisfied, findApprovedOverride, insertNumbered, leadEvent, managementApprovalAbove, minAdvancePct, money, nextNumber, nextWorkingAfter, openApproval,
  partyUserIds, reminderEscalation, reminderHours, requiredAdvance, roundState, round2, skipPending, todayIst, toJson, yy,
} from './orderSupport';
import { PI_ISSUED_STATUSES } from './piService';

/* ───────────── gate G11 ───────────── */

export async function evaluateCreditGuard(ctx: AppContext, pi: ProformaInvoice, advance: number): Promise<CreditGuardResult> {
  const out: CreditGuardResult = {
    gate: 'G11', blocked: false, reasons: [], warnings: [], order_total: pi.total, advance_received: advance, outstanding: 0, exposure_after: 0, credit_limit: 0, portal_status: null, override_id: null,
  };
  if (!pi.dealer_id) return out; // distributor-direct order: no dealer credit exposure
  const exposure = await computeDealerExposure(ctx, pi.dealer_id);
  const exposureAfter = round2(exposure.outstanding + Math.max(0, pi.total - advance));
  Object.assign(out, { outstanding: exposure.outstanding, exposure_after: exposureAfter, credit_limit: exposure.credit_limit, portal_status: exposure.portal_status });
  if (exposureAfter > exposure.credit_limit) out.reasons.push(`Exposure after this order (${money(exposureAfter)}) would exceed the dealer's credit limit (${money(exposure.credit_limit)})`);
  if (exposure.portal_status === 'deactivated') out.reasons.push('Dealer is deactivated on the PM Surya Ghar portal');
  if (exposure.portal_status === 'under_sop') out.warnings.push('Dealer is under an MNRE SOP review — the order is allowed, but watch the dealer closely');
  if (exposure.bank_guarantee.expiring_soon) out.warnings.push(`Dealer bank guarantee expires in ${exposure.bank_guarantee.days_left} days`);
  if (out.reasons.length) {
    const override = await findApprovedOverride(ctx, pi.dealer_id, pi.id);
    if (override) { out.override_id = override.id; out.warnings.push('Credit guard bypassed by an approved credit override'); } else out.blocked = true;
  }
  return out;
}

/* ───────────── payment / credit position ───────────── */

export interface PaymentPosition { advance: number; pct: number; required: number; advanceOk: boolean; creditCheck: CreditCheck | null; creditOk: boolean; satisfied: boolean }
export async function paymentPosition(ctx: AppContext, pi: ProformaInvoice): Promise<PaymentPosition> {
  const [advance, pct, checks] = await Promise.all([
    advanceReceived(ctx, pi.id), minAdvancePct(ctx),
    ctx.db.table('credit_checks').all({ pi_id: pi.id, basis: 'credit', result: 'approved' }, { orderBy: { col: 'created_at', dir: 'desc' } }),
  ]);
  const advanceOk = advanceSatisfied(advance, pi.total, pct);
  return { advance, pct, required: requiredAdvance(pi.total, pct), advanceOk, creditCheck: checks[0] ?? null, creditOk: checks.length > 0, satisfied: advanceOk || checks.length > 0 };
}

const holdReason = (p: PaymentPosition, total: number): string =>
  `Awaiting advance of ${money(p.required)} (${p.pct}% of ${money(total)}) — ${money(p.advance)} received — or an approved credit decision`;

/* ───────────── loading / hydration ───────────── */

export async function loadSalesOrder(ctx: AppContext, id: string): Promise<SalesOrder> {
  const so = await ctx.db.table('sales_orders').get(id);
  if (!so) throw notFound('Sales order');
  await assertCanRead(ctx, 'sales_orders', so);
  return so;
}

export async function hydrateSalesOrders(ctx: AppContext, orders: SalesOrder[]): Promise<SalesOrderSummary[]> {
  if (!orders.length) return [];
  const [pis, dealers] = await Promise.all([
    ctx.db.table('proforma_invoices').all({ id: [...new Set(orders.map((o) => o.pi_id))] }),
    ctx.db.table('dealers').all({ id: [...new Set(orders.map((o) => o.dealer_id).filter((x): x is string => !!x))] }),
  ]);
  return orders.map((o) => {
    const pi = pis.find((p) => p.id === o.pi_id);
    return { ...o, pi_no: pi?.pi_no ?? null, customer_name: pi?.legal_name ?? null, dealer_name: dealers.find((d) => d.id === o.dealer_id)?.legal_name ?? null };
  });
}

export async function salesOrderDetail(ctx: AppContext, id: string): Promise<SalesOrderDetail> {
  const so = await loadSalesOrder(ctx, id);
  const [summary] = await hydrateSalesOrders(ctx, [so]);
  const [lines, pi, payments, approvals, checks, dispatches, installation, quote, reserved] = await Promise.all([
    ctx.db.table('sales_order_lines').all({ so_id: so.id }, { orderBy: { col: 'sort_order' } }),
    ctx.db.table('proforma_invoices').get(so.pi_id),
    ctx.db.table('payments').all({ pi_id: so.pi_id }, { orderBy: { col: 'received_at', dir: 'asc' } }),
    ctx.db.table('approvals').all({ entity_type: 'sales_order', entity_id: so.id }, { orderBy: [{ col: 'requested_at' }, { col: 'step' }] }),
    ctx.db.table('credit_checks').all({ pi_id: so.pi_id }, { orderBy: { col: 'created_at', dir: 'desc' } }),
    ctx.db.table('dispatches').all({ so_id: so.id }, { orderBy: { col: 'created_at', dir: 'asc' } }),
    ctx.db.table('installations').one({ sales_order_id: so.id }),
    ctx.db.table('quotations').get(so.quote_id),
    ctx.db.table('inventory_serials').all({ sales_order_id: so.id, status: 'reserved' }),
  ]);
  const skus = await ctx.db.table('skus').all({ id: [...new Set(lines.map((l) => l.sku_id).filter((x): x is string => !!x))] });
  const serialCounts = await ctx.db.table('dispatch_serials').all({ dispatch_id: dispatches.map((d) => d.id) });
  const lineDetail: SalesOrderLineDetail[] = lines.map((l: SalesOrderLine) => {
    const tracked = isSerialTracked(skus.find((s) => s.id === l.sku_id)?.category);
    const res = reserved.filter((r) => r.sales_order_line_id === l.id).length;
    return { ...l, serial_tracked: tracked, reserved_qty: res, remaining_qty: Math.max(0, l.qty - l.qty_dispatched - res) };
  });
  const warnings: string[] = [];
  if (pi && ['on_hold', 'pending_approval', 'approved', 'dispatch_planning'].includes(so.status)) {
    warnings.push(...(await evaluateCreditGuard(ctx, pi, so.advance_received)).warnings);
    if (pi.valid_till && pi.valid_till < todayIst(ctx) && !so.dispatch_handover_at) warnings.push(`Proforma invoice validity ended on ${pi.valid_till}`);
  }
  return {
    ...summary!, lines: lineDetail, pi, payments, approvals, credit_checks: checks,
    dispatches: dispatches.map((d) => ({ ...d, serial_count: serialCounts.filter((s) => s.dispatch_id === d.id).length })), installation_id: installation?.id ?? null,
    compliance_snapshot: {
      quote: quote ? { quote_id: quote.id, status: quote.compliance_status, evaluated_at: quote.compliance_evaluated_at, findings: quote.compliance_findings } : null,
      dispatches: dispatches.map((d) => ({ dispatch_id: d.id, dispatch_no: d.dispatch_no, status: d.status, compliance_status: d.compliance_status, findings: d.compliance_findings })),
    },
    warnings,
  };
}

/* ───────────── create (steps 31-32) ───────────── */

export async function createSalesOrder(ctx: AppContext, input: CreateSalesOrderInput): Promise<SalesOrderDetail> {
  const pi = await ctx.db.table('proforma_invoices').get(input.pi_id);
  if (!pi) throw notFound('Proforma invoice');
  await assertCanRead(ctx, 'proforma_invoices', pi);
  if (!PI_ISSUED_STATUSES.includes(pi.status)) throw invalidState(`A sales order needs an issued proforma invoice (this one is "${pi.status}")`, { status: pi.status });
  const existing = await ctx.db.table('sales_orders').one({ pi_id: pi.id, status: { nin: ['cancelled'] } });
  if (existing) throw conflict(`Sales order ${existing.so_no} already exists for ${pi.pi_no}`, { so_id: existing.id, so_no: existing.so_no });
  if (input.po_document_id && !(await ctx.db.table('documents').get(input.po_document_id))) throw notFound('Customer PO document');

  const pos = await paymentPosition(ctx, pi);
  const guard = await evaluateCreditGuard(ctx, pi, pos.advance);
  if (guard.blocked) {
    throw guardBlocked(`Gate G11 — sales order blocked: ${guard.reasons.join('; ')}. A credit override approved by Management is needed.`, { ...guard, override_available: false });
  }

  const quote = await ctx.db.table('quotations').getOrThrow(pi.quote_id);
  const piLines = await ctx.db.table('proforma_invoice_lines').all({ pi_id: pi.id }, { orderBy: { col: 'sort_order' } });
  const onHold = !pos.satisfied;
  const prefix = `FS/SO/${yy(ctx)}/`;
  const so = await insertNumbered(async () => {
    const nos = (await ctx.db.table('sales_orders').all({ so_no: { like: `${prefix}%` } })).map((r) => r.so_no);
    return ctx.db.table('sales_orders').insert({
      so_no: nextNumber(nos, prefix), pi_id: pi.id, quote_id: quote.id, opportunity_id: pi.opportunity_id, customer_id: pi.customer_id, site_id: quote.site_id, dealer_id: pi.dealer_id,
      distributor_id: pi.distributor_id, territory_id: quote.territory_id, segment: quote.segment, status: onHold ? 'on_hold' : 'pending_approval', customer_po_no: input.customer_po_no,
      customer_po_date: input.customer_po_date, po_document_id: input.po_document_id ?? null, hold_reason: onHold ? holdReason(pos, pi.total) : null, order_date: todayIst(ctx), total: pi.total,
      advance_received: pos.advance, credit_basis: pos.advanceOk ? 'advance' : pos.creditOk ? 'credit' : null, circulated_at: null, approved_by: null, dispatch_handover_at: null,
      expected_commissioning_date: quote.expected_commissioning_date, created_by: actorId(ctx),
    });
  });
  await ctx.db.table('sales_order_lines').insertMany(piLines.map((l, i) => ({
    so_id: so.id, sku_id: l.sku_id, description: l.description, hsn: l.hsn, gst_rate: l.gst_rate, qty: l.qty, unit_price: l.unit_price, line_total: l.line_total, qty_dispatched: 0, sort_order: l.sort_order ?? i, created_by: actorId(ctx),
  })));
  await ctx.db.table('proforma_invoices').update(pi.id, { sales_order_id: so.id });
  await ctx.db.table('payments').updateWhere({ pi_id: pi.id, sales_order_id: null }, { sales_order_id: so.id });
  if (pos.creditCheck && !pos.creditCheck.sales_order_id) await ctx.db.table('credit_checks').update(pos.creditCheck.id, { sales_order_id: so.id });
  if (guard.override_id) await ctx.db.table('credit_overrides').update(guard.override_id, { sales_order_id: so.id });

  if (onHold) {
    await startReminderClock(ctx, so, 1);
    await ctx.svc.notify.notify({ roles: ['accounts'], kind: 'so.on_hold', title: `Sales order ${so.so_no} is on hold`, body: so.hold_reason ?? undefined, severity: 'warning', entity_type: 'sales_order', entity_id: so.id });
  } else {
    await requestSoApproval(ctx, so);
  }
  await audit(ctx, { action: 'so.create', table: 'sales_orders', record_id: so.id, new: toJson(so), detail: { guard: toJson(guard), on_hold: onHold, credit_basis: so.credit_basis } });
  await leadEvent(ctx, quote.lead_id, 'sales_order_created', `Sales order ${so.so_no} created${onHold ? ' (on hold — payment/credit pending)' : ''}`, { so_id: so.id, pi_no: pi.pi_no });
  return salesOrderDetail(ctx, so.id);
}

async function requestSoApproval(ctx: AppContext, so: SalesOrder): Promise<Approval[]> {
  const chain: AppRole[] = so.total >= (await managementApprovalAbove(ctx)) ? ['accounts', 'management'] : ['accounts'];
  return openApproval(ctx, { entity_type: 'sales_order', entity_id: so.id, lane: 'credit', chain, label: `Sales order ${so.so_no}`, extra: { so_no: so.so_no, total: so.total } });
}

/* ───────────── hold / release ───────────── */

export async function releaseHold(ctx: AppContext, id: string, opts: { auto?: boolean; note?: string } = {}): Promise<SalesOrderDetail> {
  const so = await loadSalesOrder(ctx, id);
  if (so.status !== 'on_hold') throw invalidState(`Only a sales order on hold can be released (this one is "${so.status}")`, { status: so.status });
  const pi = await ctx.db.table('proforma_invoices').getOrThrow(so.pi_id);
  const pos = await paymentPosition(ctx, pi);
  const guard = await evaluateCreditGuard(ctx, pi, pos.advance);
  if (guard.blocked) throw guardBlocked(`Gate G11 — cannot release: ${guard.reasons.join('; ')}`, { ...guard, override_available: false });
  if (!pos.satisfied) throw guardBlocked(`Neither the advance nor an approved credit decision is in place yet — ${holdReason(pos, pi.total)}`, { required: pos.required, received: pos.advance, advance_pct: pos.pct });

  await requestSoApproval(ctx, so);
  const row = await ctx.db.table('sales_orders').update(so.id, { status: 'pending_approval', hold_reason: null, advance_received: pos.advance, credit_basis: pos.advanceOk ? 'advance' : 'credit' });
  await ctx.svc.clocks.complete('sales_order', so.id, 'payment_reminder', { released: true });
  await audit(ctx, { action: opts.auto ? 'so.release_hold_auto' : 'so.release_hold', table: 'sales_orders', record_id: so.id, old: toJson(so), new: toJson(row), detail: { note: opts.note ?? null, basis: row.credit_basis } });
  const quote = await ctx.db.table('quotations').get(so.quote_id);
  await leadEvent(ctx, quote?.lead_id, 'sales_order_released', `Sales order ${so.so_no} released from hold (${row.credit_basis})`, { so_id: so.id });
  return salesOrderDetail(ctx, so.id);
}

/** Called after a payment or a credit decision: keeps SO.advance_received current and releases a held order when the conditions are now met. */
export async function afterMoneyOrCreditChange(ctx: AppContext, piId: string): Promise<void> {
  const pi = await ctx.db.table('proforma_invoices').get(piId);
  if (!pi?.sales_order_id) return;
  const so = await ctx.db.table('sales_orders').get(pi.sales_order_id);
  if (!so || so.status === 'cancelled') return;
  const advance = await advanceReceived(ctx, pi.id);
  if (so.advance_received !== advance) await ctx.db.table('sales_orders').update(so.id, { advance_received: advance });
  await ctx.db.table('payments').updateWhere({ pi_id: pi.id, sales_order_id: null }, { sales_order_id: so.id });
  if (so.status === 'on_hold') {
    try { await releaseHold(ctx, so.id, { auto: true }); } catch (e) { if (!(e instanceof AppError && e.code === 'GUARD_BLOCKED')) throw e; }
  }
}

/* ───────────── hand-over (step 34) and cancel ───────────── */

export async function handoverSalesOrder(ctx: AppContext, id: string, note?: string): Promise<SalesOrderDetail> {
  const so = await loadSalesOrder(ctx, id);
  if (so.status !== 'approved') throw invalidState(`Only an approved sales order can be handed over to dispatch planning (this one is "${so.status}")`, { status: so.status });
  const now = ctx.now().toISOString();
  const row = await ctx.db.table('sales_orders').update(so.id, { status: 'dispatch_planning', dispatch_handover_at: now });
  const quote = await ctx.db.table('quotations').get(so.quote_id);
  const oppId = so.opportunity_id ?? quote?.opportunity_id ?? null;
  const opp = oppId ? await ctx.db.table('opportunities').get(oppId) : null;
  if (opp && opp.stage !== 'won') await ctx.db.table('opportunities').update(opp.id, { stage: 'won' });
  const leadId = quote?.lead_id ?? opp?.lead_id ?? null;
  if (leadId) await ctx.db.table('leads').update(leadId, { status: 'won', last_action: `Order ${so.so_no} handed over to dispatch`, last_action_at: now });
  await audit(ctx, { action: 'so.handover', table: 'sales_orders', record_id: so.id, old: toJson(so), new: toJson(row), detail: { note: note ?? null, opportunity_id: oppId, lead_id: leadId } });
  await leadEvent(ctx, leadId, 'order_handover', `Order ${so.so_no} handed over to dispatch planning`, { so_id: so.id });
  await ctx.svc.notify.notify({ roles: ['dispatch'], kind: 'so.handover', title: `Order ${so.so_no} is ready for dispatch planning`, body: note, severity: 'info', entity_type: 'sales_order', entity_id: so.id });
  return salesOrderDetail(ctx, so.id);
}

export async function cancelSalesOrder(ctx: AppContext, id: string, note?: string): Promise<SalesOrderDetail> {
  const so = await loadSalesOrder(ctx, id);
  if (so.status === 'cancelled') throw invalidState('This sales order is already cancelled');
  if (['partially_dispatched', 'dispatched', 'closed'].includes(so.status)) throw invalidState(`A sales order that has shipped ("${so.status}") cannot be cancelled`, { status: so.status });
  await cancelOpenDispatches(ctx, so.id, `Sales order ${so.so_no} cancelled`);
  await skipPending(ctx, 'sales_order', so.id);
  await ctx.svc.clocks.cancel('sales_order', so.id);
  const row = await ctx.db.table('sales_orders').update(so.id, { status: 'cancelled', hold_reason: note ?? so.hold_reason });
  const pi = await ctx.db.table('proforma_invoices').get(so.pi_id);
  if (pi?.sales_order_id === so.id) await ctx.db.table('proforma_invoices').update(pi.id, { sales_order_id: null });
  await audit(ctx, { action: 'so.cancel', table: 'sales_orders', record_id: so.id, old: toJson(so), new: toJson(row), detail: { note: note ?? null } });
  return salesOrderDetail(ctx, so.id);
}

/* ───────────── approval handler (step 33) ───────────── */

async function onSoApproval(ctx: AppContext, approval: Approval, outcome: ApprovalOutcome): Promise<void> {
  const so = await ctx.db.table('sales_orders').get(approval.entity_id);
  if (!so || so.status !== 'pending_approval') return;
  const state = await roundState(ctx, approval);
  const requester = approval.requested_by ? [approval.requested_by] : [];

  if (outcome === 'rejected' || state.rejected) {
    const why = (state.rejected ?? approval).comment ?? 'No reason given';
    await skipPending(ctx, 'sales_order', so.id);
    await ctx.db.table('sales_orders').update(so.id, { status: 'cancelled', hold_reason: `Rejected at approval: ${why}` });
    const pi = await ctx.db.table('proforma_invoices').get(so.pi_id);
    if (pi?.sales_order_id === so.id) await ctx.db.table('proforma_invoices').update(pi.id, { sales_order_id: null });
    await audit(ctx, { action: 'so.approval_rejected', table: 'sales_orders', record_id: so.id, detail: { comment: why } });
    if (requester.length) await ctx.svc.notify.notify({ user_ids: requester, kind: 'so.rejected', title: `Sales order ${so.so_no} was rejected`, body: why, severity: 'warning', entity_type: 'sales_order', entity_id: so.id });
    return;
  }
  if (!(outcome === 'lane_approved' || state.allApproved)) {
    if (outcome === 'step_approved') await activateNextStep(ctx, approval);
    return;
  }

  const now = ctx.now().toISOString();
  const row = await ctx.db.table('sales_orders').update(so.id, { status: 'approved', approved_by: state.lastApprover, circulated_at: now });
  await audit(ctx, { action: 'so.approve', table: 'sales_orders', record_id: so.id, old: toJson(so), new: toJson(row) });
  // circulation: distributor, dealer, dispatch and accounts
  const parties = await partyUserIds(ctx, { distributor_id: so.distributor_id, dealer_id: so.dealer_id });
  const base = { kind: 'so.circulated', title: `Sales order ${so.so_no} approved`, body: 'The order is approved and circulated.', severity: 'success' as const, entity_type: 'sales_order', entity_id: so.id };
  await ctx.svc.notify.notify({ ...base, roles: ['dispatch', 'accounts'], user_ids: [...new Set([...parties, ...requester])] });
  const quote = await ctx.db.table('quotations').get(so.quote_id);
  await leadEvent(ctx, quote?.lead_id, 'sales_order_approved', `Sales order ${so.so_no} approved and circulated`, { so_id: so.id });
}
registerApprovalHandler('sales_order', onSoApproval);

/* ───────────── payment reminder clock (hold) ───────────── */

async function startReminderClock(ctx: AppContext, so: SalesOrder, cycle: number, owner: string | null = actorId(ctx)): Promise<Clock> {
  const due = await nextWorkingAfter(ctx, await reminderHours(ctx));
  return ctx.svc.clocks.start({ entity_type: 'sales_order', entity_id: so.id, clock_type: 'payment_reminder', due_at: due, owner_id: owner, meta: { cycle, so_no: so.so_no, pi_id: so.pi_id } as Json });
}

/** Daily: remind the customer (transactional message through the consent-aware pipeline), escalate by day count, schedule the next day's reminder. */
async function onReminderBreach(ctx: AppContext, clock: Clock): Promise<void> {
  const so = await ctx.db.table('sales_orders').get(clock.entity_id);
  if (!so || so.status !== 'on_hold') { await ctx.svc.clocks.cancel('sales_order', clock.entity_id, 'payment_reminder'); return; }
  const cycle = Number((clock.meta as { cycle?: number } | null)?.cycle ?? 1);
  const pi = await ctx.db.table('proforma_invoices').get(so.pi_id);
  const quote = await ctx.db.table('quotations').get(so.quote_id);
  const pos = pi ? await paymentPosition(ctx, pi) : null;
  const due = pos ? Math.max(0, round2(pos.required - pos.advance)) : 0;
  const firstName = ((quote?.lead_id ? await ctx.db.table('leads').get(quote.lead_id) : null)?.name ?? 'Customer').split(/s+/)[0] ?? 'Customer';
  let delivered = false;
  if (quote?.lead_id) {
    try {
      const res = await ctx.svc.messaging.send({
        // the approved template (seeded as wa.payment_reminder: {{1}} name, {{2}} amount, {{3}} proforma invoice) is what WhatsApp may send outside the 24 h window
        lead_id: quote.lead_id, channel: 'whatsapp', purpose: 'transactional', template_key: 'wa.payment_reminder',
        vars: { '1': firstName, '2': money(due), '3': pi?.pi_no ?? '', pi_no: pi?.pi_no ?? '', so_no: so.so_no, amount_due: money(due) },
      });
      delivered = !res.blocked;
      if (res.blocked) ctx.log.warn({ so: so.id, reasons: res.reasons }, 'payment reminder blocked by consent pipeline');
    } catch (e) { ctx.log.error({ err: e, so: so.id }, 'payment reminder could not be sent'); }
  }
  await audit(ctx, { action: 'so.payment_reminder', table: 'sales_orders', record_id: so.id, detail: { cycle, delivered, due } });
  await leadEvent(ctx, quote?.lead_id, 'payment_reminder', `Payment reminder #${cycle} for ${so.so_no}${delivered ? '' : ' (not delivered)'}`, { so_id: so.id, cycle });
  const esc = await reminderEscalation(ctx);
  const targets: AppRole[] = [];
  if (cycle >= esc.sales_manager_after) targets.push('sales_manager');
  if (cycle >= esc.management_after) targets.push('management');
  if (targets.length) {
    await ctx.svc.notify.notify({ roles: targets, kind: `so.payment_overdue.${cycle}`, title: `Order ${so.so_no} is still on hold — ${cycle} reminders sent`, body: so.hold_reason ?? undefined, severity: 'critical', entity_type: 'sales_order', entity_id: so.id });
  }
  if (!delivered) await ctx.svc.notify.notify({ user_ids: clock.owner_id ? [clock.owner_id] : undefined, roles: clock.owner_id ? undefined : ['accounts'], kind: 'so.reminder_not_delivered', title: `Payment reminder for ${so.so_no} could not be delivered`, body: 'Follow up with the customer directly.', severity: 'warning', entity_type: 'sales_order', entity_id: so.id });
  await startReminderClock(ctx, so, cycle + 1, clock.owner_id);
}
registerClockHandlers('payment_reminder', { onBreach: onReminderBreach });

