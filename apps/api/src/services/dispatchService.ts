/**
 * Serial-number dispatch (after step 34): reserve serials FIFO by batch against sales-order lines, evaluate dispatch compliance,
 * swap non-compliant serials, dispatch with the invoice chain (brand -> distributor -> dealer -> site), e-invoice / e-way bill
 * (provider with MANUAL ENTRY fallback) and the dispatch note PDF.
 *
 * Dispatch guard (Appendix A): a dispatch may not move to `dispatched` while compliance_status = 'blocked' unless an approved
 * compliance override exists; and every module serial must satisfy the order's segment:
 *   pmsg_residential / pm_kusum need DCR; every segment except ci_captive needs ALMM List-I;
 *   pmsg_residential / rwa_ghs / government_bid also need ALMM List-II when the expected commissioning date is on/after almm.list2.effective_date.
 * ALMM / DCR govern PV modules; inverters, batteries and other serials are reported as "not applicable".
 */
import { randomUUID } from 'node:crypto';
import {
  GSTIN_UNREGISTERED, isSerialTracked,
  type Address, type Approval, type ComplianceStatus, type CreateDispatchInput, type Dispatch, type DispatchActionInput, type DispatchDetail, type DispatchSerialDetail, type EditDispatchSerialsInput,
  type EinvoiceStatus, type EinvoiceStatusValue, type Finding, type InvoiceChainInput, type InvoiceChainLink, type InventorySerial, type Json, type ManualEinvoiceInput, type SalesOrder,
  type SalesOrderLine, type Segment, type SerialComplianceDetail, type SerialSnapshot, type Sku, type SkuCategory,
} from '@solar/shared';
import type { AppContext } from '../auth/context';
import { assertCanRead, scopedWhere } from '../auth/access';
import { AppError, badRequest, complianceBlocked, conflict, invalidState, notFound } from '../http/errors';
import { audit } from '../lib/audit';
import { renderDispatchNotePdf } from './orderPdf';
import { actorId, insertNumbered, leadEvent, nextNumber, openApproval, partyUserIds, round2, todayIst, toJson, yy } from './orderSupport';

export const OPEN_DISPATCH_STATUSES: Dispatch['status'][] = ['planned', 'blocked', 'ready'];
const SHIPPING_ORDER_STATUSES: SalesOrder['status'][] = ['dispatch_planning', 'partially_dispatched'];
const SHIPPED_SERIAL_STATUSES: InventorySerial['status'][] = ['dispatched', 'installed', 'rma'];

const DCR_SEGMENTS: Segment[] = ['pmsg_residential', 'pm_kusum'];
const LIST2_SEGMENTS: Segment[] = ['pmsg_residential', 'rwa_ghs', 'government_bid'];
const isTracked = isSerialTracked;

/* ───────────── serial compliance (Appendix A) ───────────── */

export function evaluateSerial(snapshot: SerialSnapshot, category: SkuCategory | null, segment: Segment, list2Applies: boolean): SerialComplianceDetail {
  if (category !== null && category !== 'module') return { compliant: true, applicable: false, missing: [] };
  const missing: string[] = [];
  if (DCR_SEGMENTS.includes(segment) && !snapshot.dcr_verified) missing.push('DCR verification');
  if (segment !== 'ci_captive' && !snapshot.almm_list1) missing.push('ALMM List-I listing');
  if (LIST2_SEGMENTS.includes(segment) && list2Applies && !snapshot.almm_list2) missing.push('ALMM List-II (cell) listing');
  return { compliant: missing.length === 0, applicable: true, missing };
}

async function list2Applies(ctx: AppContext, so: SalesOrder): Promise<boolean> {
  const effective = await ctx.svc.rules.value<string>('almm.list2.effective_date');
  if (typeof effective !== 'string') return false; // inactive / absent rule is advisory only
  return (so.expected_commissioning_date ?? todayIst(ctx)) >= effective;
}

const GATE_FOR: Record<string, Finding['gate']> = { 'DCR verification': 'G2', 'ALMM List-I listing': 'G3', 'ALMM List-II (cell) listing': 'G4' };

/* ───────────── loading ───────────── */

export async function loadDispatch(ctx: AppContext, id: string): Promise<{ dispatch: Dispatch; so: SalesOrder }> {
  const dispatch = await ctx.db.table('dispatches').get(id);
  if (!dispatch) throw notFound('Dispatch');
  const so = await ctx.db.table('sales_orders').get(dispatch.so_id);
  if (!so) throw notFound('Sales order');
  await assertCanRead(ctx, 'sales_orders', so);
  return { dispatch, so };
}

/** External users reach dispatches only through the sales orders they may read. */
export async function dispatchVisibility(ctx: AppContext): Promise<string[] | null> {
  const scope = await scopedWhere(ctx, 'sales_orders', {});
  if (!Object.keys(scope).length) return null;
  return (await ctx.db.table('sales_orders').all(scope)).map((s) => s.id);
}

const skuLabel = (s: Sku | undefined): string => (s ? `${s.make} ${s.model}${s.variant ? ` ${s.variant}` : ''}` : '—');

async function serialDetails(ctx: AppContext, dispatch: Dispatch, so: SalesOrder): Promise<DispatchSerialDetail[]> {
  const links = await ctx.db.table('dispatch_serials').all({ dispatch_id: dispatch.id });
  if (!links.length) return [];
  const serials = await ctx.db.table('inventory_serials').all({ id: links.map((l) => l.serial_id) });
  const [skus, batches, l2] = await Promise.all([
    ctx.db.table('skus').all({ id: [...new Set(serials.map((s) => s.sku_id))] }),
    ctx.db.table('stock_batches').all({ id: [...new Set(serials.map((s) => s.batch_id).filter((x): x is string => !!x))] }),
    list2Applies(ctx, so),
  ]);
  return links.map((l) => {
    const s = serials.find((x) => x.id === l.serial_id)!;
    const sku = skus.find((k) => k.id === s.sku_id);
    const batch = batches.find((b) => b.id === s.batch_id);
    return {
      ...l, serial: s.serial, sku_id: s.sku_id, sku_label: skuLabel(sku), category: sku?.category ?? null, batch_id: s.batch_id, batch_no: batch?.batch_no ?? null, received_at: batch?.received_at ?? null,
      status: s.status, compliance_snapshot: s.compliance_snapshot, invoice_chain: s.invoice_chain, compliance: evaluateSerial(s.compliance_snapshot, sku?.category ?? null, so.segment, l2),
    };
  }).sort((a, b) => a.serial.localeCompare(b.serial));
}

/** An approved compliance override for this dispatch (or its sales order): the latest approval round is fully approved. */
export async function complianceOverride(ctx: AppContext, dispatch: Dispatch, so: SalesOrder): Promise<{ approved: boolean; pending: boolean; approval_ids: string[] }> {
  const rows: Approval[] = (await ctx.db.table('approvals').all({ entity_type: 'compliance_override', entity_id: [dispatch.id, so.id] }));
  const round = (a: Approval): number => Number((a.meta as { round?: number } | null)?.round ?? 1);
  const max = rows.reduce((m, a) => Math.max(m, round(a)), 0);
  const live = rows.filter((a) => round(a) === max && a.decision !== 'skipped');
  return { approved: live.length > 0 && live.every((a) => a.decision === 'approved'), pending: live.some((a) => a.decision === 'pending'), approval_ids: live.map((a) => a.id) };
}

export async function dispatchDetail(ctx: AppContext, id: string): Promise<DispatchDetail> {
  const { dispatch, so } = await loadDispatch(ctx, id);
  const [serials, soLines, einvoice, override] = await Promise.all([
    serialDetails(ctx, dispatch, so),
    ctx.db.table('sales_order_lines').all({ so_id: so.id }, { orderBy: { col: 'sort_order' } }),
    ctx.db.table('einvoice_status').one({ entity_type: 'dispatch', entity_id: dispatch.id }),
    complianceOverride(ctx, dispatch, so),
  ]);
  const skus = await ctx.db.table('skus').all({ id: [...new Set(soLines.map((l) => l.sku_id).filter((x): x is string => !!x))] });
  return {
    ...dispatch, so_no: so.so_no, segment: so.segment, so_status: so.status, serials,
    lines: soLines.map((l) => ({
      so_line_id: l.id, description: l.description, serial_tracked: isTracked(skus.find((s) => s.id === l.sku_id)?.category), qty_ordered: l.qty, qty_dispatched: l.qty_dispatched,
      qty_in_this_dispatch: serials.filter((s) => s.so_line_id === l.id).length,
    })),
    einvoice, hard_stops: dispatch.compliance_findings.filter((f) => f.severity === 'hard_stop'), override,
  };
}

export async function hydrateDispatches(ctx: AppContext, rows: Dispatch[]): Promise<(Dispatch & { so_no: string | null; serial_count: number })[]> {
  if (!rows.length) return [];
  const [sos, links] = await Promise.all([
    ctx.db.table('sales_orders').all({ id: [...new Set(rows.map((r) => r.so_id))] }),
    ctx.db.table('dispatch_serials').all({ dispatch_id: rows.map((r) => r.id) }),
  ]);
  return rows.map((r) => ({ ...r, so_no: sos.find((s) => s.id === r.so_id)?.so_no ?? null, serial_count: links.filter((l) => l.dispatch_id === r.id).length }));
}

/* ───────────── serial reservation (FIFO by batch) ───────────── */

async function fifoCandidates(ctx: AppContext, skuId: string): Promise<InventorySerial[]> {
  const serials = await ctx.db.table('inventory_serials').all({ sku_id: skuId, status: 'in_stock' });
  const batches = await ctx.db.table('stock_batches').all({ id: [...new Set(serials.map((s) => s.batch_id).filter((x): x is string => !!x))] });
  const rank = new Map(batches.map((b) => [b.id, `${b.received_at}|${b.created_at}|${b.batch_no}`]));
  const key = (s: InventorySerial): string => (s.batch_id ? rank.get(s.batch_id) ?? '~' : '~'); // serials without a batch go last
  return serials.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.serial < b.serial ? -1 : a.serial > b.serial ? 1 : 0));
}

/** Optimistic claim: only succeeds while the serial is still in stock (no DB transactions, so a parallel request can lose the race). */
async function claimSerial(ctx: AppContext, serialId: string, so: SalesOrder, lineId: string, dispatchId: string): Promise<boolean> {
  const rows = await ctx.db.table('inventory_serials').updateWhere({ id: serialId, status: 'in_stock' }, {
    status: 'reserved', quote_id: so.quote_id, sales_order_id: so.id, sales_order_line_id: lineId, dispatch_id: dispatchId,
  });
  return rows.length === 1;
}
async function releaseSerial(ctx: AppContext, serialId: string): Promise<void> {
  await ctx.db.table('inventory_serials').updateWhere({ id: serialId, status: 'reserved' }, { status: 'in_stock', quote_id: null, sales_order_id: null, sales_order_line_id: null, dispatch_id: null });
}

async function lineCapacity(ctx: AppContext, line: SalesOrderLine): Promise<number> {
  const reserved = await ctx.db.table('inventory_serials').count({ sales_order_line_id: line.id, status: 'reserved' });
  return Math.max(0, line.qty - line.qty_dispatched - reserved);
}

const insufficient = (message: string, details: unknown): AppError => new AppError(422, 'INSUFFICIENT_STOCK', message, details);

/* ───────────── create ───────────── */

export async function createDispatch(ctx: AppContext, input: CreateDispatchInput): Promise<DispatchDetail> {
  const so = await ctx.db.table('sales_orders').get(input.so_id);
  if (!so) throw notFound('Sales order');
  await assertCanRead(ctx, 'sales_orders', so);
  if (!SHIPPING_ORDER_STATUSES.includes(so.status)) throw invalidState(`Dispatch can be planned only after hand-over to dispatch planning (this order is "${so.status}")`, { status: so.status });

  const lines = await ctx.db.table('sales_order_lines').all({ so_id: so.id }, { orderBy: { col: 'sort_order' } });
  const skus = await ctx.db.table('skus').all({ id: [...new Set(lines.map((l) => l.sku_id).filter((x): x is string => !!x))] });
  const trackedLines = lines.filter((l) => isTracked(skus.find((s) => s.id === l.sku_id)?.category));
  if (trackedLines.length && !input.lines.length) throw badRequest('Add at least one order line with a quantity or serial numbers');

  // 1) validate and pick serials without touching anything
  const plan: { line: SalesOrderLine; serials: InventorySerial[] }[] = [];
  const picked = new Set<string>();
  for (const req of input.lines) {
    const line = lines.find((l) => l.id === req.so_line_id);
    if (!line) throw badRequest('One of the lines does not belong to this sales order', { so_line_id: req.so_line_id });
    if (!trackedLines.includes(line)) throw badRequest(`"${line.description}" is not serial-tracked — structures, cables and other bulk items ship with the first consignment, do not add them here`);
    if (plan.some((p) => p.line.id === line.id)) throw badRequest(`Line "${line.description}" appears twice`);
    const capacity = await lineCapacity(ctx, line);
    const qty = req.serial_ids ? req.serial_ids.length : req.qty!;
    if (req.qty !== undefined && req.serial_ids && req.qty !== req.serial_ids.length) throw badRequest('qty does not match the number of serial ids');
    if (qty > capacity) throw badRequest(`"${line.description}": ${qty} requested but only ${capacity} remain to be planned`, { so_line_id: line.id, requested: qty, remaining: capacity });
    let chosen: InventorySerial[];
    if (req.serial_ids) {
      if (new Set(req.serial_ids).size !== req.serial_ids.length) throw badRequest('Duplicate serial ids in the request');
      const rows = await ctx.db.table('inventory_serials').all({ id: req.serial_ids });
      if (rows.length !== req.serial_ids.length) throw notFound('One or more serials');
      const bad = rows.find((r) => r.status !== 'in_stock' || r.sku_id !== line.sku_id || picked.has(r.id));
      if (bad) throw badRequest(`Serial ${bad.serial} is not available for "${line.description}" (${bad.sku_id !== line.sku_id ? 'different product' : `status ${bad.status}`})`, { serial_id: bad.id });
      chosen = rows;
    } else {
      const pool = (await fifoCandidates(ctx, line.sku_id!)).filter((s) => !picked.has(s.id));
      if (pool.length < qty) throw insufficient(`"${line.description}": ${qty} requested but only ${pool.length} serial(s) are in stock`, { so_line_id: line.id, requested: qty, in_stock: pool.length });
      chosen = pool.slice(0, qty);
    }
    chosen.forEach((s) => picked.add(s.id));
    plan.push({ line, serials: chosen });
  }

  // 2) create the dispatch, then claim serials (rolled back if a parallel request wins a serial)
  const pi = await ctx.db.table('proforma_invoices').get(so.pi_id);
  const prefix = `FS/DSP/${yy(ctx)}/`;
  const planned = input.planned_at ? (input.planned_at.length === 10 ? new Date(`${input.planned_at}T00:00:00+05:30`).toISOString() : input.planned_at) : ctx.now().toISOString();
  const dispatch = await insertNumbered(async () => {
    const nos = (await ctx.db.table('dispatches').all({ dispatch_no: { like: `${prefix}%` } })).map((r) => r.dispatch_no);
    return ctx.db.table('dispatches').insert({
      dispatch_no: nextNumber(nos, prefix), so_id: so.id, status: 'planned', planned_at: planned, dispatched_at: null, vehicle_no: input.vehicle_no ?? null, transporter: input.transporter ?? null,
      ewb_no: null, ewb_status: 'not_required', invoice_no: null, invoice_chain: [], compliance_status: 'pending', compliance_findings: [], dispatch_note_document_id: null,
      ship_to: pi?.shipping_address ?? null, created_by: actorId(ctx),
    });
  });
  const claimed: { serial: InventorySerial; line: SalesOrderLine }[] = [];
  try {
    for (const p of plan) {
      const want = p.serials.length;
      const explicit = !!input.lines.find((l) => l.so_line_id === p.line.id)?.serial_ids;
      let got = 0;
      for (const s of p.serials) {
        if (await claimSerial(ctx, s.id, so, p.line.id, dispatch.id)) { claimed.push({ serial: s, line: p.line }); got++; }
      }
      if (got < want && !explicit) {
        // a parallel request took one of the planned serials: top up from the next in FIFO order
        for (const s of (await fifoCandidates(ctx, p.line.sku_id!)).filter((x) => !picked.has(x.id))) {
          if (got >= want) break;
          picked.add(s.id);
          if (await claimSerial(ctx, s.id, so, p.line.id, dispatch.id)) { claimed.push({ serial: s, line: p.line }); got++; }
        }
      }
      if (got < want) throw insufficient(`"${p.line.description}": stock changed while reserving — please retry`, { so_line_id: p.line.id, requested: want, reserved: got });
    }
    if (claimed.length) await ctx.db.table('dispatch_serials').insertMany(claimed.map((c) => ({ dispatch_id: dispatch.id, serial_id: c.serial.id, so_line_id: c.line.id, created_by: actorId(ctx) })));
  } catch (e) {
    for (const c of claimed) await releaseSerial(ctx, c.serial.id);
    for (const l of await ctx.db.table('dispatch_serials').all({ dispatch_id: dispatch.id })) await ctx.db.table('dispatch_serials').delete(l.id);
    await ctx.db.table('dispatches').delete(dispatch.id);
    throw e;
  }
  await audit(ctx, { action: 'dispatch.create', table: 'dispatches', record_id: dispatch.id, new: toJson(dispatch), detail: { so_no: so.so_no, serials: claimed.length } });
  return dispatchDetail(ctx, dispatch.id);
}

/* ───────────── evaluate ───────────── */

interface Evaluation { findings: Finding[]; hasHardStop: boolean; status: ComplianceStatus; override: { approved: boolean; pending: boolean; approval_ids: string[] } }

async function runEvaluation(ctx: AppContext, dispatch: Dispatch, so: SalesOrder): Promise<Evaluation> {
  const links = await ctx.db.table('dispatch_serials').all({ dispatch_id: dispatch.id });
  const result = await ctx.svc.compliance.evaluateDispatch(so.id, { persist: false, dispatchId: dispatch.id, serialIds: links.map((l) => l.serial_id) });
  const details = await serialDetails(ctx, dispatch, so);
  const own: Finding[] = [];
  for (const d of details) {
    for (const m of d.compliance.missing) {
      own.push({ gate: GATE_FOR[m] ?? 'G3', severity: 'hard_stop', message: `Serial ${d.serial} (${d.sku_label}) lacks ${m} for a ${so.segment.replace(/_/g, ' ')} order — replace the serial or get a compliance override`, ruleIds: [], fieldRefs: [`serial:${d.serial_id}`] });
    }
  }
  const override = await complianceOverride(ctx, dispatch, so);
  const mark = (f: Finding): Finding => (override.approved && f.severity === 'hard_stop' ? { ...f, overridden: true } : f);
  const findings = [...result.findings, ...own].map(mark);
  const hasHardStop = result.hasHardStop || own.length > 0;
  return { findings, hasHardStop, status: hasHardStop ? 'blocked' : result.status, override };
}

export async function evaluateDispatch(ctx: AppContext, id: string): Promise<DispatchDetail> {
  const { dispatch, so } = await loadDispatch(ctx, id);
  if (!OPEN_DISPATCH_STATUSES.includes(dispatch.status)) throw invalidState(`Only a planned dispatch can be evaluated (this one is "${dispatch.status}")`, { status: dispatch.status });
  const ev = await runEvaluation(ctx, dispatch, so);
  const blocked = ev.hasHardStop && !ev.override.approved;
  const row = await ctx.db.table('dispatches').update(dispatch.id, { compliance_findings: ev.findings, compliance_status: ev.status, status: blocked ? 'blocked' : 'ready' });
  await audit(ctx, { action: 'dispatch.evaluate', table: 'dispatches', record_id: dispatch.id, old: toJson(dispatch), new: toJson(row), detail: { hard_stops: ev.findings.filter((f) => f.severity === 'hard_stop').length, override: ev.override.approved } });
  return dispatchDetail(ctx, dispatch.id);
}

export async function requestComplianceOverride(ctx: AppContext, id: string, reason: string): Promise<DispatchDetail> {
  const { dispatch, so } = await loadDispatch(ctx, id);
  if (!OPEN_DISPATCH_STATUSES.includes(dispatch.status)) throw invalidState(`A compliance override can be requested only for a planned dispatch (this one is "${dispatch.status}")`);
  const current = await complianceOverride(ctx, dispatch, so);
  if (current.pending) throw conflict('A compliance override for this dispatch is already waiting for the compliance officer');
  await openApproval(ctx, { entity_type: 'compliance_override', entity_id: dispatch.id, lane: 'compliance', chain: ['compliance_officer'], label: `Compliance override — dispatch ${dispatch.dispatch_no}`, extra: { dispatch_id: dispatch.id, so_id: so.id, reason } });
  await audit(ctx, { action: 'dispatch.override_request', table: 'dispatches', record_id: dispatch.id, detail: { reason } });
  return dispatchDetail(ctx, dispatch.id);
}

/* ───────────── add / swap / remove serials ───────────── */

export async function editDispatchSerials(ctx: AppContext, id: string, input: EditDispatchSerialsInput): Promise<DispatchDetail> {
  const { dispatch, so } = await loadDispatch(ctx, id);
  if (!OPEN_DISPATCH_STATUSES.includes(dispatch.status)) throw invalidState(`Serials can be changed only on a planned dispatch (this one is "${dispatch.status}")`, { status: dispatch.status });
  const lines = await ctx.db.table('sales_order_lines').all({ so_id: so.id });
  const current = await ctx.db.table('dispatch_serials').all({ dispatch_id: dispatch.id });
  const reservedSerial = async (serialId: string) => {
    const link = current.find((c) => c.serial_id === serialId);
    if (!link) throw badRequest('That serial is not on this dispatch', { serial_id: serialId });
    return link;
  };
  const claimOn = async (serialId: string, lineId: string | undefined): Promise<void> => {
    const s = await ctx.db.table('inventory_serials').get(serialId);
    if (!s) throw notFound('Serial');
    if (s.status !== 'in_stock') throw badRequest(`Serial ${s.serial} is not in stock (status ${s.status})`, { serial_id: s.id });
    let line = lineId ? lines.find((l) => l.id === lineId) : undefined;
    if (lineId && !line) throw badRequest('That order line does not belong to this sales order');
    if (!line) { for (const l of lines.filter((x) => x.sku_id === s.sku_id)) { if ((await lineCapacity(ctx, l)) > 0) { line = l; break; } } }
    if (!line || line.sku_id !== s.sku_id) throw badRequest(`Serial ${s.serial} does not match any open line of this order`, { serial_id: s.id });
    if ((await lineCapacity(ctx, line)) < 1) throw badRequest(`"${line.description}" is already fully planned`, { so_line_id: line.id });
    if (!(await claimSerial(ctx, s.id, so, line.id, dispatch.id))) throw conflict(`Serial ${s.serial} was just taken by another dispatch`, { serial_id: s.id });
    await ctx.db.table('dispatch_serials').insert({ dispatch_id: dispatch.id, serial_id: s.id, so_line_id: line.id, created_by: actorId(ctx) });
  };

  for (const serialId of input.remove ?? []) {
    const link = await reservedSerial(serialId);
    await releaseSerial(ctx, serialId);
    await ctx.db.table('dispatch_serials').delete(link.id);
  }
  for (const r of input.replace ?? []) {
    const link = await reservedSerial(r.old_serial_id);
    const incoming = await ctx.db.table('inventory_serials').get(r.new_serial_id);
    const outgoing = await ctx.db.table('inventory_serials').get(r.old_serial_id);
    if (!incoming || !outgoing) throw notFound('Serial');
    if (incoming.sku_id !== outgoing.sku_id) throw badRequest('A replacement must be the same product as the serial it replaces');
    if (incoming.status !== 'in_stock') throw badRequest(`Serial ${incoming.serial} is not in stock (status ${incoming.status})`);
    if (!(await claimSerial(ctx, incoming.id, so, link.so_line_id!, dispatch.id))) throw conflict(`Serial ${incoming.serial} was just taken by another dispatch`);
    await releaseSerial(ctx, outgoing.id);
    await ctx.db.table('dispatch_serials').delete(link.id);
    await ctx.db.table('dispatch_serials').insert({ dispatch_id: dispatch.id, serial_id: incoming.id, so_line_id: link.so_line_id, created_by: actorId(ctx) });
  }
  for (const a of input.add ?? []) await claimOn(a.serial_id, a.so_line_id);

  await ctx.db.table('dispatches').update(dispatch.id, { status: 'planned', compliance_status: 'pending', compliance_findings: [] });
  await audit(ctx, { action: 'dispatch.serials', table: 'dispatches', record_id: dispatch.id, detail: toJson({ add: input.add?.length ?? 0, remove: input.remove?.length ?? 0, replace: input.replace?.length ?? 0 }) });
  return dispatchDetail(ctx, dispatch.id);
}

/* ───────────── cancel (unreserve) ───────────── */

export async function cancelDispatch(ctx: AppContext, id: string, reason?: string): Promise<DispatchDetail> {
  const { dispatch } = await loadDispatch(ctx, id);
  if (!OPEN_DISPATCH_STATUSES.includes(dispatch.status)) throw invalidState(`Only a planned dispatch can be cancelled (this one is "${dispatch.status}")`, { status: dispatch.status });
  await unreserveAndCancel(ctx, dispatch, reason);
  return dispatchDetail(ctx, id);
}

async function unreserveAndCancel(ctx: AppContext, dispatch: Dispatch, reason?: string): Promise<void> {
  const links = await ctx.db.table('dispatch_serials').all({ dispatch_id: dispatch.id });
  for (const l of links) { await releaseSerial(ctx, l.serial_id); await ctx.db.table('dispatch_serials').delete(l.id); }
  const row = await ctx.db.table('dispatches').update(dispatch.id, { status: 'cancelled', compliance_status: 'pending' });
  await audit(ctx, { action: 'dispatch.cancel', table: 'dispatches', record_id: dispatch.id, old: toJson(dispatch), new: toJson(row), detail: { reason: reason ?? null, unreserved: links.length } });
}

export async function cancelOpenDispatches(ctx: AppContext, soId: string, reason: string): Promise<number> {
  const open = await ctx.db.table('dispatches').all({ so_id: soId, status: OPEN_DISPATCH_STATUSES });
  for (const d of open) await unreserveAndCancel(ctx, d, reason);
  return open.length;
}

/* ───────────── dispatch ───────────── */

function buildChain(names: { brand: string; distributor: string | null; dealer: string | null; site: string }, inv: { brand: string; distributor_to_dealer?: string; dealer_to_site?: string }, date: string): InvoiceChainLink[] {
  const hops: { key: string; name: string }[] = [{ key: 'brand', name: names.brand }];
  if (names.distributor) hops.push({ key: 'distributor', name: names.distributor });
  if (names.dealer) hops.push({ key: 'dealer', name: names.dealer });
  hops.push({ key: 'site', name: names.site });
  const invoiceFor = (from: string, to: string): string => {
    if (from === 'brand') return inv.brand;
    if (to === 'dealer') return inv.distributor_to_dealer ?? 'PENDING';
    return inv.dealer_to_site ?? 'PENDING';
  };
  return hops.slice(0, -1).map((h, i) => ({ from: h.name, to: hops[i + 1]!.name, invoice_no: invoiceFor(h.key, hops[i + 1]!.key), date }));
}

async function chainNames(ctx: AppContext, so: SalesOrder) {
  const [org, dist, dealer, pi] = await Promise.all([
    ctx.db.table('organizations').get(ctx.org_id), so.distributor_id ? ctx.db.table('distributors').get(so.distributor_id) : Promise.resolve(null),
    so.dealer_id ? ctx.db.table('dealers').get(so.dealer_id) : Promise.resolve(null), ctx.db.table('proforma_invoices').get(so.pi_id),
  ]);
  return { org, pi, names: { brand: org?.name ?? 'Future Solar', distributor: dist?.legal_name ?? null, dealer: dealer?.legal_name ?? null, site: `${pi?.legal_name ?? 'Customer'} (site)` } };
}

/** Taxable value + GST of what this consignment carries (bulk lines are carried by the first consignment). */
function consignmentValue(lines: SalesOrderLine[], counts: Map<string, number>, tracked: Set<string>, includeBulk: boolean): number {
  let v = 0;
  for (const l of lines) {
    const qty = tracked.has(l.id) ? counts.get(l.id) ?? 0 : includeBulk ? l.qty : 0;
    v += qty * l.unit_price * (1 + (l.gst_rate ?? 0) / 100);
  }
  return round2(v);
}

async function recordEinvoice(ctx: AppContext, dispatchId: string, result: { status: EinvoiceStatusValue; irn: string | null; ack_no: string | null; ack_date: string | null }, provider: string, payload: Json): Promise<EinvoiceStatus> {
  const existing = await ctx.db.table('einvoice_status').one({ entity_type: 'dispatch', entity_id: dispatchId });
  const real = result.status === 'generated';
  const fields = { irn: real ? result.irn : null, ack_no: real ? result.ack_no : null, ack_date: real ? result.ack_date : null, status: result.status, provider, payload };
  return existing ? ctx.db.table('einvoice_status').update(existing.id, fields) : ctx.db.table('einvoice_status').insert({ entity_type: 'dispatch', entity_id: dispatchId, ...fields, created_by: actorId(ctx) });
}

export async function dispatchNow(ctx: AppContext, id: string, input: DispatchActionInput): Promise<DispatchDetail> {
  const { dispatch, so } = await loadDispatch(ctx, id);
  if (dispatch.status === 'dispatched' || dispatch.status === 'delivered') throw invalidState('This dispatch has already gone out');
  if (dispatch.status === 'cancelled') throw invalidState('This dispatch was cancelled');
  if (!SHIPPING_ORDER_STATUSES.includes(so.status)) throw invalidState(`The sales order is "${so.status}" — dispatch is not possible`, { status: so.status });

  const lines = await ctx.db.table('sales_order_lines').all({ so_id: so.id }, { orderBy: { col: 'sort_order' } });
  const skus = await ctx.db.table('skus').all({ id: [...new Set(lines.map((l) => l.sku_id).filter((x): x is string => !!x))] });
  const trackedIds = new Set(lines.filter((l) => isTracked(skus.find((s) => s.id === l.sku_id)?.category)).map((l) => l.id));
  const links = await ctx.db.table('dispatch_serials').all({ dispatch_id: dispatch.id });
  if (trackedIds.size && !links.length) throw badRequest('This dispatch has no serial numbers — add serials before dispatching');

  // compliance gate: always evaluated fresh
  const ev = await runEvaluation(ctx, dispatch, so);
  await ctx.db.table('dispatches').update(dispatch.id, { compliance_findings: ev.findings, compliance_status: ev.status, status: ev.hasHardStop && !ev.override.approved ? 'blocked' : 'ready' });
  if (ev.hasHardStop && !ev.override.approved) {
    const stops = ev.findings.filter((f) => f.severity === 'hard_stop');
    throw complianceBlocked(`Dispatch blocked — ${stops.length} compliance hard stop(s): ${stops.map((f) => f.message).join('; ')}`, { gate: 'DISPATCH', dispatch_id: dispatch.id, findings: stops, override_pending: ev.override.pending });
  }
  const serials = await ctx.db.table('inventory_serials').all({ id: links.map((l) => l.serial_id) });
  const stray = serials.find((s) => s.dispatch_id !== dispatch.id || !(s.status === 'reserved' || SHIPPED_SERIAL_STATUSES.includes(s.status)));
  if (stray) throw conflict(`Serial ${stray.serial} is no longer reserved for this dispatch`, { serial_id: stray.id });

  const today = todayIst(ctx);
  const nowIso = ctx.now().toISOString();
  const { org, pi, names } = await chainNames(ctx, so);
  let invoiceNo = input.invoice_no ?? dispatch.invoice_no;
  if (input.invoice_no) {
    const clash = await ctx.db.table('dispatches').one({ invoice_no: input.invoice_no });
    if (clash && clash.id !== dispatch.id) throw conflict(`Invoice number ${input.invoice_no} is already used by dispatch ${clash.dispatch_no}`);
  }
  if (!invoiceNo) {
    const prefix = `FS/INV/${yy(ctx)}/`;
    invoiceNo = nextNumber((await ctx.db.table('dispatches').all({ invoice_no: { like: `${prefix}%` } })).map((d) => d.invoice_no), prefix);
  }
  const chain = buildChain(names, { brand: invoiceNo, distributor_to_dealer: input.chain_invoices?.dealer, dealer_to_site: input.chain_invoices?.site }, today);
  await ctx.db.table('dispatches').update(dispatch.id, { vehicle_no: input.vehicle_no ?? dispatch.vehicle_no, transporter: input.transporter ?? dispatch.transporter, invoice_no: invoiceNo });
  const vehicle = input.vehicle_no ?? dispatch.vehicle_no;

  // bulk lines (structures, cables …) ride with the first consignment that actually ships
  const shippedBefore = await ctx.db.table('dispatches').count({ so_id: so.id, status: ['dispatched', 'delivered'] });
  const includeBulk = shippedBefore === 0;
  const counts = new Map<string, number>();
  for (const l of links) if (l.so_line_id) counts.set(l.so_line_id, (counts.get(l.so_line_id) ?? 0) + 1);
  const value = consignmentValue(lines, counts, trackedIds, includeBulk);

  // e-invoice and e-way bill: provider first, manual-entry fallback when it cannot generate
  let einvoice: Awaited<ReturnType<typeof ctx.providers.einvoice.generateIrn>>;
  try {
    einvoice = await ctx.providers.einvoice.generateIrn({ invoice_no: invoiceNo, invoice_date: today, seller_gstin: org?.gstin ?? null, buyer_gstin: pi?.gstin && pi.gstin !== GSTIN_UNREGISTERED ? pi.gstin : null, total: value });
  } catch (e) { einvoice = { status: 'failed', irn: null, ack_no: null, ack_date: null, message: e instanceof Error ? e.message : 'e-invoice provider error' }; }
  let eway: Awaited<ReturnType<typeof ctx.providers.ewayBill.generate>>;
  try {
    eway = await ctx.providers.ewayBill.generate({ invoice_no: invoiceNo, vehicle_no: vehicle ?? null, from_pincode: org?.address?.pincode ?? null, to_pincode: (dispatch.ship_to as Address | null)?.pincode ?? null, value });
  } catch (e) { eway = { status: 'failed', ewb_no: null, message: e instanceof Error ? e.message : 'e-way bill provider error' }; }
  await recordEinvoice(ctx, dispatch.id, einvoice, ctx.providers.einvoice.name, toJson({ ...einvoice, value }));

  // serials -> dispatched with the invoice chain (idempotent: a retry after a partial failure just re-applies)
  for (const s of serials) {
    if (s.status === 'reserved') await ctx.db.table('inventory_serials').update(s.id, { status: 'dispatched', invoice_chain: chain });
  }
  // SO lines: recomputed from facts so a retry cannot double count
  let allDone = true;
  for (const l of lines) {
    const qtyDone = trackedIds.has(l.id)
      ? await ctx.db.table('inventory_serials').count({ sales_order_line_id: l.id, status: SHIPPED_SERIAL_STATUSES })
      : includeBulk ? l.qty : l.qty_dispatched;
    if (qtyDone !== l.qty_dispatched) await ctx.db.table('sales_order_lines').update(l.id, { qty_dispatched: qtyDone });
    if (qtyDone < l.qty) allDone = false;
  }
  const soRow = await ctx.db.table('sales_orders').update(so.id, { status: allDone ? 'dispatched' : 'partially_dispatched' });
  const row = await ctx.db.table('dispatches').update(dispatch.id, {
    status: 'dispatched', dispatched_at: nowIso, invoice_chain: chain, ewb_no: eway.status === 'generated' ? eway.ewb_no : null, ewb_status: eway.status,
    compliance_findings: ev.findings, compliance_status: ev.status,
  });
  await audit(ctx, { action: 'dispatch.dispatch', table: 'dispatches', record_id: dispatch.id, old: toJson(dispatch), new: toJson(row), detail: { invoice_no: invoiceNo, einvoice: einvoice.status, ewb: eway.status, serials: serials.length, so_status: soRow.status, overridden: ev.override.approved } });
  const quote = await ctx.db.table('quotations').get(so.quote_id);
  await leadEvent(ctx, quote?.lead_id, 'dispatched', `Dispatch ${dispatch.dispatch_no} shipped (${serials.length} serial(s)) — order ${so.so_no} is ${soRow.status.replace('_', ' ')}`, { dispatch_id: dispatch.id });
  const parties = await partyUserIds(ctx, { distributor_id: so.distributor_id, dealer_id: so.dealer_id });
  await ctx.svc.notify.notify({ user_ids: parties, roles: ['accounts'], kind: 'dispatch.dispatched', title: `Dispatch ${dispatch.dispatch_no} is on its way`, body: `Order ${so.so_no}, invoice ${invoiceNo}.`, severity: 'success', entity_type: 'dispatch', entity_id: dispatch.id });
  if (einvoice.status !== 'generated' || eway.status !== 'generated') {
    await ctx.svc.notify.notify({ roles: ['accounts', 'dispatch'], kind: 'dispatch.einvoice_manual', title: `Enter e-invoice / e-way bill details for ${dispatch.dispatch_no}`, body: 'The provider could not generate them automatically — record the IRN and e-way bill number manually.', severity: 'warning', entity_type: 'dispatch', entity_id: dispatch.id });
  }
  return dispatchDetail(ctx, dispatch.id);
}

/* ───────────── manual e-invoice / e-way bill, invoice chain ───────────── */

export async function manualEinvoice(ctx: AppContext, id: string, input: ManualEinvoiceInput): Promise<DispatchDetail> {
  const { dispatch } = await loadDispatch(ctx, id);
  if (dispatch.status === 'cancelled') throw invalidState('This dispatch was cancelled');
  if (input.irn) {
    await recordEinvoice(ctx, dispatch.id, { status: 'generated', irn: input.irn.toLowerCase(), ack_no: input.ack_no ?? null, ack_date: input.ack_date ? (input.ack_date.length === 10 ? `${input.ack_date}T00:00:00+05:30` : input.ack_date) : null }, 'manual', toJson({ manual: true, entered_by: actorId(ctx), entered_at: ctx.now().toISOString() }));
  }
  if (input.ewb_no) await ctx.db.table('dispatches').update(dispatch.id, { ewb_no: input.ewb_no, ewb_status: 'generated' });
  await audit(ctx, { action: 'dispatch.einvoice_manual', table: 'dispatches', record_id: dispatch.id, detail: { irn: !!input.irn, ewb_no: input.ewb_no ?? null } });
  return dispatchDetail(ctx, dispatch.id);
}

export async function updateInvoiceChain(ctx: AppContext, id: string, input: InvoiceChainInput): Promise<DispatchDetail> {
  const { dispatch, so } = await loadDispatch(ctx, id);
  if (dispatch.status === 'cancelled') throw invalidState('This dispatch was cancelled');
  if (!dispatch.invoice_chain.length) throw invalidState('The invoice chain is recorded when the dispatch goes out');
  const chain = dispatch.invoice_chain.map((l) => ({ ...l }));
  const hasDealer = !!so.dealer_id;
  if (hasDealer) {
    if (input.distributor_to_dealer && chain[1]) chain[1].invoice_no = input.distributor_to_dealer;
    if (input.dealer_to_site && chain[2]) chain[2].invoice_no = input.dealer_to_site;
  } else if (input.dealer_to_site && chain[1]) chain[1].invoice_no = input.dealer_to_site;
  const links = await ctx.db.table('dispatch_serials').all({ dispatch_id: dispatch.id });
  for (const l of links) await ctx.db.table('inventory_serials').update(l.serial_id, { invoice_chain: chain });
  await ctx.db.table('dispatches').update(dispatch.id, { invoice_chain: chain });
  await audit(ctx, { action: 'dispatch.invoice_chain', table: 'dispatches', record_id: dispatch.id, old: toJson(dispatch.invoice_chain), new: toJson(chain) });
  return dispatchDetail(ctx, dispatch.id);
}

/* ───────────── dispatch note PDF ───────────── */

export async function dispatchNote(ctx: AppContext, id: string): Promise<{ document_id: string; content: Buffer; url: string; expires_at: string; file_name: string }> {
  const { dispatch, so } = await loadDispatch(ctx, id);
  const sign = async (path: string) => ctx.providers.storage.signedUrl({ bucket: 'invoices', path, method: 'GET', expiresInSec: 600 });
  const [details, einvoice, ctxNames] = await Promise.all([serialDetails(ctx, dispatch, so), ctx.db.table('einvoice_status').one({ entity_type: 'dispatch', entity_id: dispatch.id }), chainNames(ctx, so)]);
  const lines = await ctx.db.table('sales_order_lines').all({ id: [...new Set(details.map((d) => d.so_line_id).filter((x): x is string => !!x))] });
  const content = await renderDispatchNotePdf({
    org: { name: ctxNames.org?.name ?? 'Future Solar', legal_name: ctxNames.org?.legal_name ?? 'Future Solar', gstin: ctxNames.org?.gstin ?? null, address: ctxNames.org?.address ?? null },
    dispatch, so_no: so.so_no, pi_no: ctxNames.pi?.pi_no ?? null, customer: ctxNames.pi?.legal_name ?? '—', gstin: ctxNames.pi?.gstin && ctxNames.pi.gstin !== GSTIN_UNREGISTERED ? ctxNames.pi.gstin : null,
    ship_to: dispatch.ship_to, vehicle_no: dispatch.vehicle_no, transporter: dispatch.transporter, segment: so.segment,
    rows: details.map((d) => ({ serial: d.serial, item: d.sku_label, batch: d.batch_no ?? '—', so_line: lines.find((l) => l.id === d.so_line_id)?.description ?? '' })),
    einvoice, chain: dispatch.invoice_chain,
  });
  const fileName = `${dispatch.dispatch_no.replace(/\//g, '-')}-note.pdf`;
  const path = `${ctx.org_id}/dispatch/${dispatch.id}/${randomUUID()}-${fileName}`;
  await ctx.providers.storage.upload({ bucket: 'invoices', path, content, contentType: 'application/pdf' });
  const doc = await ctx.db.table('documents').insert({
    entity_type: 'dispatch', entity_id: dispatch.id, bucket: 'invoices', path, doc_type: 'dispatch_note', file_name: fileName, mime: 'application/pdf', size_bytes: content.length, uploaded_by: actorId(ctx), created_by: actorId(ctx),
  });
  await ctx.db.table('dispatches').update(dispatch.id, { dispatch_note_document_id: doc.id });
  if (dispatch.dispatch_note_document_id) {
    // the note is a derived document: replace the previous version rather than piling them up
    const prior = await ctx.db.table('documents').get(dispatch.dispatch_note_document_id);
    if (prior) { await ctx.providers.storage.remove({ bucket: 'invoices', path: prior.path }); await ctx.db.table('documents').delete(prior.id); }
  }
  await audit(ctx, { action: 'dispatch.note', table: 'documents', record_id: doc.id, detail: { dispatch_id: dispatch.id, bytes: content.length } });
  const s = await sign(path);
  return { document_id: doc.id, content, url: s.url, expires_at: s.expires_at, file_name: fileName };
}
