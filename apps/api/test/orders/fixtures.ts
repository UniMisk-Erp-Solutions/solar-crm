import { decideApproval } from '../../src/services/approvalService';
import type { ComplianceService, MessagingService, SendInput } from '../../src/services/contracts';
import type { ApprovalEntity, Address, Approval, CustomerType, Finding, InventorySerial, Lead, Opportunity, Quotation, Segment, SerialSnapshot, Sku } from '@solar/shared';
import approvals from '../../src/routes/approvals.routes';
import commercial from '../../src/routes/commercial.routes';
import { IDS, createTestEnv, type TestEnv, type TestEnvOptions } from '../helpers/env';

export const ADDR: Address = { line1: '12 Satellite Road', city: 'Ahmedabad', district: 'Ahmedabad', state: 'Gujarat', pincode: '380015' };
export const SNAP_OK: SerialSnapshot = { almm_list1: true, almm_list2: true, dcr_verified: true, bis_ok: true, snapshot_date: '2026-10-01' };
export const GSTIN = '24ABCDE1234F1Z5';

/** Controllable compliance + messaging for the order tests (never touches a real provider). */
export function fakes() {
  const compliance = { hardStop: false, calls: [] as { soId: string; dispatchId?: string; serialIds?: string[] }[] };
  const sent: SendInput[] = [];
  const msg = { blocked: false };
  const svc: ComplianceService = {
    evaluateQuote: async () => { throw new Error('evaluateQuote is not used by the orders module'); },
    evaluateDispatch: async (soId, opts) => {
      compliance.calls.push({ soId, dispatchId: opts?.dispatchId, serialIds: opts?.serialIds });
      const at = new Date().toISOString();
      const f: Finding = { gate: 'G3', severity: 'hard_stop', message: 'Module is not on ALMM List-I (fake)', ruleIds: [], fieldRefs: [] };
      return compliance.hardStop
        ? { findings: [f], hasHardStop: true, status: 'blocked', ruleIdsUsed: [], evaluated_at: at }
        : { findings: [], hasHardStop: false, status: 'clear', ruleIdsUsed: [], evaluated_at: at };
    },
  };
  const messaging: MessagingService = {
    send: async (i) => { sent.push(i); return { status: msg.blocked ? 'blocked' : 'sent', blocked: msg.blocked, reasons: [], message_log_id: 'ml-1', template_category: 'utility' }; },
  };
  return { compliance, sent, msg, overrides: { compliance: () => svc, messaging: () => messaging } as NonNullable<TestEnvOptions['serviceOverrides']> };
}

export type Fakes = ReturnType<typeof fakes>;
export function orderEnv(f: Fakes = fakes()): { env: TestEnv; f: Fakes } {
  return { env: createTestEnv({ authed: [commercial, approvals], serviceOverrides: f.overrides }), f };
}

export interface WorldOptions {
  dealerId?: string | null; distributorId?: string | null; segment?: Segment; customerType?: CustomerType; gstin?: string | null; shipping?: Address | null | undefined;
  paymentTerms?: string | null; quoteStatus?: Quotation['status']; expectedCommissioning?: string | null;
}

/** An accepted quote (10 modules + 1 inverter + 1 structure kit; total Rs 5,00,000) with its customer, lead, site and opportunity. */
export async function seedWorld(env: TestEnv, o: WorldOptions = {}) {
  const db = env.ctx('admin').db;
  const segment = o.segment ?? 'ci_net_metered';
  const customerType = o.customerType ?? 'commercial';
  const customer = await db.table('customers').insert({
    legal_name: 'Patel Textiles Pvt Ltd', display_name: 'Patel Textiles', customer_type: customerType, gstin: o.gstin === undefined ? GSTIN : o.gstin, email: 'accounts@patel.test', phone: '+919876543210',
    billing_address: ADDR, shipping_address: o.shipping === undefined ? ADDR : o.shipping, state: 'Gujarat',
  });
  const lead = await db.table('leads').insert({
    name: 'Patel Textiles', mobile: '+919876543210', source: 'manual', status: 'opportunity', customer_type: customerType, segment, customer_id: customer.id, notes: null, last_action: 'Quote accepted',
  } as Partial<Lead>);
  const site = await db.table('sites').insert({ customer_id: customer.id, lead_id: lead.id, address: ADDR, pincode: ADDR.pincode, city: 'Ahmedabad', state: 'Gujarat', existing_solar_kw: 0, pending_dues: false, category: 'general', special_category_state: false });
  const opp = await db.table('opportunities').insert({
    name: 'Patel 10 kW', lead_id: lead.id, customer_id: customer.id, site_id: site.id, segment, kw: 10, stage: 'quotation', probability: 80, expected_value: 500000,
    requirement_confirmed: true, timeline_confirmed: true, commercial_potential_confirmed: true,
  } as Partial<Opportunity>);
  const mk = (category: Sku['category'], model: string, hsn: string) => db.table('skus').insert({ category, make: 'Waaree', model, variant: null, wattage: category === 'module' ? 545 : null, hsn, uom: 'NOS', active: true, demo: false, description: null, warranty_years: 10, brand_usp: null });
  const [module, inverter, structure] = [await mk('module', 'WS-545', '85414200'), await mk('inverter', 'INV-10K', '85044010'), await mk('structure', 'MMS-KIT', '73089090')];
  const dealerId = o.dealerId === undefined ? IDS.dealerA1 : o.dealerId;
  const distributorId = o.distributorId === undefined ? IDS.distributorA : o.distributorId;
  const quote = await db.table('quotations').insert({
    quote_no: 'FS/Q/26/0001', version: 1, opportunity_id: opp.id, lead_id: lead.id, customer_id: customer.id, site_id: site.id, segment, kw: 10, expected_commissioning_date: o.expectedCommissioning === undefined ? '2026-12-15' : o.expectedCommissioning,
    status: o.quoteStatus ?? 'accepted', validity_date: '2026-11-30', price_snapshot_at: env.now().toISOString(), tax_position_approved: true, clause_keys: [], place_of_supply: 'Gujarat',
    payment_terms: o.paymentTerms === undefined ? '30% advance, balance before dispatch' : o.paymentTerms, subtotal: 450000, discount_pct: 0, discount_amount: 0, freight: 8000, tax_total: 42000, total: 500000,
    cfa_entitlement: 78000, state_share: 0, loan_share: 100000, consumer_share: 322000, compliance_status: 'clear', compliance_findings: [], rule_ids_used: [],
    owner_id: IDS.profile('sales_manager'), distributor_id: distributorId, dealer_id: dealerId, territory_id: IDS.territoryAhmedabad, accepted_at: env.now().toISOString(),
  } as Partial<Quotation>);
  const line = (sku: Sku, description: string, qty: number, unit: number, gst: number, n: number) =>
    db.table('quotation_lines').insert({ quote_id: quote.id, sku_id: sku.id, description, hsn: sku.hsn, gst_rate: gst, tax_position_approved: true, qty, uom: 'NOS', unit_price: unit, discount_pct: 0, line_total: qty * unit, sort_order: n });
  const lines = [await line(module, 'Waaree 545 Wp DCR module', 10, 30000, 5, 1), await line(inverter, '10 kW string inverter', 1, 100000, 18, 2), await line(structure, 'Mounting structure kit', 1, 50000, 18, 3)];
  return { customer, lead, site, opp, quote, lines, skus: { module, inverter, structure }, dealerId, distributorId };
}
export type World = Awaited<ReturnType<typeof seedWorld>>;

/** Two module batches (older first-in) inserted in the "wrong" order, plus inverter serials. Returns serials by label. */
export async function seedStock(env: TestEnv, w: World, snap: Partial<SerialSnapshot> = {}) {
  const db = env.ctx('admin').db;
  const snapshot = { ...SNAP_OK, ...snap };
  const newer = await db.table('stock_batches').insert({ sku_id: w.skus.module.id, batch_no: 'B-MAR', received_at: '2026-03-01', qty: 6, origin: 'domestic', supplier: 'Waaree' });
  const older = await db.table('stock_batches').insert({ sku_id: w.skus.module.id, batch_no: 'B-JAN', received_at: '2026-01-01', qty: 6, origin: 'domestic', supplier: 'Waaree' });
  const invBatch = await db.table('stock_batches').insert({ sku_id: w.skus.inverter.id, batch_no: 'B-INV', received_at: '2026-02-01', qty: 2, origin: 'domestic', supplier: 'Waaree' });
  const serial = (sku: Sku, batchId: string, no: string, s: SerialSnapshot = snapshot) =>
    db.table('inventory_serials').insert({ serial: no, sku_id: sku.id, batch_id: batchId, status: 'in_stock', compliance_snapshot: s, invoice_chain: [] } as Partial<InventorySerial>);
  const out: Record<string, InventorySerial> = {};
  for (let i = 1; i <= 6; i++) { const no = `MAR-${String(i).padStart(3, '0')}`; out[no] = await serial(w.skus.module, newer.id, no); } // newer batch inserted first
  for (let i = 1; i <= 6; i++) { const no = `JAN-${String(i).padStart(3, '0')}`; out[no] = await serial(w.skus.module, older.id, no); }
  for (let i = 1; i <= 2; i++) { const no = `INV-${i}`; out[no] = await serial(w.skus.inverter, invBatch.id, no); }
  return { serials: out, batches: { older, newer, invBatch } };
}

/** Decides the next pending approval of an entity through the real approvals engine (turn, role and comment checks, SLA clock, entity handler). */
export async function decide(env: TestEnv, entity: ApprovalEntity, entityId: string, decision: 'approved' | 'rejected', comment = 'Approved'): Promise<Approval> {
  const rows = await env.ctx('admin').db.table('approvals').all({ entity_type: entity, entity_id: entityId, decision: 'pending' }, { orderBy: { col: 'step' } });
  const next = rows[0];
  if (!next) throw new Error(`no pending approval for ${entity} ${entityId}`);
  const res = await decideApproval(env.ctx(next.required_role), next.id, { decision, comment });
  return res.approval;
}
export async function decideAll(env: TestEnv, entity: ApprovalEntity, entityId: string): Promise<void> {
  for (;;) {
    const pending = await env.ctx('admin').db.table('approvals').count({ entity_type: entity, entity_id: entityId, decision: 'pending' });
    if (!pending) return;
    await decide(env, entity, entityId, 'approved');
  }
}

/** quote -> PI (issued) via the API. */
export async function issuePi(env: TestEnv, w: World, extra: Record<string, unknown> = {}) {
  const accounts = env.as('accounts');
  const created = await accounts.post('/api/v1/pis').send({ quote_id: w.quote.id, ...extra });
  if (created.status !== 201) throw new Error(`create PI failed: ${JSON.stringify(created.body)}`);
  const id = created.body.data.id as string;
  const submitted = await accounts.post(`/api/v1/pis/${id}/submit`).send({});
  if (submitted.status !== 200) throw new Error(`submit PI failed: ${JSON.stringify(submitted.body)}`);
  await decideAll(env, 'proforma_invoice', id);
  const pi = await accounts.get(`/api/v1/pis/${id}`);
  return pi.body.data as { id: string; pi_no: string; status: string; total: number };
}

export const pay = (env: TestEnv, piId: string, amount: number, kind = 'advance') =>
  env.as('accounts').post(`/api/v1/pis/${piId}/payments`).send({ kind, amount, mode: 'neft_rtgs', reference: `UTR${amount}` });

/** PI issued, 30% advance paid, SO created, approved and handed over -> ready for dispatch planning. */
export async function readyForDispatch(env: TestEnv, w: World, advance = 150000, piExtra: Record<string, unknown> = {}) {
  const pi = await issuePi(env, w, piExtra);
  if (advance > 0) {
    const p = await pay(env, pi.id, advance);
    if (p.status !== 201) throw new Error(`payment failed: ${JSON.stringify(p.body)}`);
  }
  const so = await env.as('accounts').post('/api/v1/sales-orders').send({ pi_id: pi.id, customer_po_no: 'PO-7781', customer_po_date: '2026-10-25' });
  if (so.status !== 201) throw new Error(`create SO failed: ${JSON.stringify(so.body)}`);
  const soId = so.body.data.id as string;
  await decideAll(env, 'sales_order', soId);
  const h = await env.as('management').post(`/api/v1/sales-orders/${soId}/handover`).send({});
  if (h.status !== 200) throw new Error(`handover failed: ${JSON.stringify(h.body)}`);
  return { pi, soId, so: h.body.data as { id: string; so_no: string; lines: { id: string; sku_id: string; qty: number }[] } };
}
