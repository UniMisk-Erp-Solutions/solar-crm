import type { ComplianceStatus, DispatchStatus, PiStatus, SoStatus } from '../enums';
import { daysBetween } from '../format';
import type {
  Approval, CreditAgeing, CreditCheck, CreditOverride, DealerReceivable, Dispatch, DispatchSerial, EinvoiceStatus, InventorySerial, InvoiceChainLink, Payment,
  PreFlightChecklist, ProformaInvoice, ProformaInvoiceLine, Quotation, SalesOrder, SalesOrderLine, SerialSnapshot,
} from '../rows';
import { BATCH_IDS, type SkuKey } from './demo.catalogue';
import { DEMO_IDS, soLineId } from './demo.ids';
import type { LeadLayer } from './demo.leads';
import { siteIdOf, customerIdOf } from './demo.leads';
import { specOf, type LeadKey } from './demo.leads.data';
import { buildDealers, buildDistributors } from './demo.people';
import type { QuoteKey, QuoteSet } from './demo.quotes';
import { ruleSeedId } from './rules.build';
import { baseOf, demoId, round2, DAY, type SeedEnv } from './util';

const I = DEMO_IDS;
const P = DEMO_IDS.profile;

type SoKey = keyof typeof DEMO_IDS.salesOrder;
type PiKey = keyof typeof DEMO_IDS.proformaInvoice;
type DispatchKey = keyof typeof DEMO_IDS.dispatch;

/** The five won projects that carry the order-to-cash chain. n = SO number. */
interface WonProject { n: number; lead: LeadKey; quote: QuoteKey; so: SoKey; pi: PiKey; dispatch: DispatchKey | null; dealer: string; ageDays: number }
export const WON_PROJECTS: readonly WonProject[] = [
  { n: 1, lead: 'won1', quote: 'w1', so: 'so1', pi: 'pi1', dispatch: 'dsp1', dealer: I.dealer.d2, ageDays: 60 },
  { n: 2, lead: 'won2', quote: 'w2', so: 'so2', pi: 'pi2', dispatch: 'dsp2', dealer: I.dealer.d3, ageDays: 68 },
  { n: 3, lead: 'won3', quote: 'w3', so: 'so3', pi: 'pi3', dispatch: 'dsp3', dealer: I.dealer.d2, ageDays: 76 },
  { n: 4, lead: 'won4', quote: 'w4', so: 'so4', pi: 'pi4', dispatch: 'dsp4', dealer: I.dealer.d8, ageDays: 66 },
  { n: 5, lead: 'won5', quote: 'w5', so: 'so5', pi: 'pi5', dispatch: null, dealer: I.dealer.d6, ageDays: 42 },
];

const CHECKLIST: PreFlightChecklist = { legal_name: true, billing_address: true, shipping_address: true, gst: true, product: true, quantity: true, price: true, freight: true, payment_terms: true };

/* ───────────────────────── dealer receivables (and the credit position derived from them) ───────────────────────── */

interface ReceivableSeed { dealer: string; ref: string; amount: number; paid: number; invoiceAgo: number; dueIn: number; subsidy: boolean; project?: string; status: DealerReceivable['status'] }

const RECEIVABLES: ReceivableSeed[] = [
  // d1 — over its ₹ 20 lakh limit: ₹ 22.5 lakh outstanding, of which ₹ 14.5 lakh is subsidy-linked, with a 60+ day bucket
  { dealer: I.dealer.d1, ref: 'DEMO-INV-D1-1001', amount: 950000, paid: 0, invoiceAgo: 100, dueIn: -70, subsidy: true, status: 'overdue' },
  { dealer: I.dealer.d1, ref: 'DEMO-INV-D1-1002', amount: 800000, paid: 0, invoiceAgo: 50, dueIn: -20, subsidy: false, status: 'overdue' },
  { dealer: I.dealer.d1, ref: 'DEMO-INV-D1-1003', amount: 500000, paid: 0, invoiceAgo: 10, dueIn: 20, subsidy: true, status: 'open' },
  { dealer: I.dealer.d1, ref: 'DEMO-INV-D1-0990', amount: 400000, paid: 400000, invoiceAgo: 140, dueIn: -110, subsidy: false, status: 'paid' },
  { dealer: I.dealer.d2, ref: 'DEMO-INV-D2-1001', amount: 300000, paid: 0, invoiceAgo: 12, dueIn: 18, subsidy: false, status: 'open' },
  { dealer: I.dealer.d2, ref: 'DEMO-INV-D2-0990', amount: 600000, paid: 600000, invoiceAgo: 90, dueIn: -60, subsidy: true, status: 'paid' },
  { dealer: I.dealer.d3, ref: 'DEMO-INV-D3-1001', amount: 250000, paid: 0, invoiceAgo: 45, dueIn: -15, subsidy: false, status: 'overdue' },
  { dealer: I.dealer.d3, ref: 'DEMO-INV-D3-1002', amount: 150000, paid: 0, invoiceAgo: 8, dueIn: 22, subsidy: true, status: 'open' },
  { dealer: I.dealer.d4, ref: 'DEMO-INV-D4-1001', amount: 700000, paid: 0, invoiceAgo: 75, dueIn: -45, subsidy: false, status: 'overdue' },
  { dealer: I.dealer.d4, ref: 'DEMO-INV-D4-1002', amount: 300000, paid: 0, invoiceAgo: 105, dueIn: -75, subsidy: true, status: 'overdue' },
  { dealer: I.dealer.d5, ref: 'DEMO-INV-D5-1001', amount: 400000, paid: 50000, invoiceAgo: 150, dueIn: -120, subsidy: false, status: 'overdue' },
  { dealer: I.dealer.d5, ref: 'DEMO-INV-D5-1002', amount: 200000, paid: 0, invoiceAgo: 95, dueIn: -65, subsidy: true, status: 'overdue' },
  { dealer: I.dealer.d6, ref: 'DEMO-INV-D6-1001', amount: 650000, paid: 0, invoiceAgo: 95, dueIn: -65, subsidy: true, status: 'overdue' },
  { dealer: I.dealer.d6, ref: 'DEMO-INV-D6-1002', amount: 200000, paid: 0, invoiceAgo: 6, dueIn: 24, subsidy: false, status: 'open' },
  { dealer: I.dealer.d7, ref: 'DEMO-INV-D7-1001', amount: 500000, paid: 0, invoiceAgo: 9, dueIn: 21, subsidy: false, status: 'open' },
  { dealer: I.dealer.d8, ref: 'DEMO-INV-D8-1001', amount: 1000000, paid: 0, invoiceAgo: 14, dueIn: 16, subsidy: false, status: 'open' },
  { dealer: I.dealer.d8, ref: 'DEMO-INV-D8-1002', amount: 400000, paid: 0, invoiceAgo: 40, dueIn: -10, subsidy: true, status: 'overdue' },
];

export function buildReceivables(env: SeedEnv): DealerReceivable[] {
  const distOf = new Map(buildDealers(env).map((d) => [d.id, d.distributor_id]));
  const projects: Record<string, string> = { [I.dealer.d2]: I.salesOrder.so1, [I.dealer.d3]: I.salesOrder.so2, [I.dealer.d8]: I.salesOrder.so4, [I.dealer.d6]: I.salesOrder.so5 };
  return RECEIVABLES.map((r, i) => ({
    ...baseOf(env, demoId('receivable', i + 1), r.invoiceAgo * DAY, P.accounts), dealer_id: r.dealer, distributor_id: distOf.get(r.dealer) ?? null, doc_ref: r.ref, amount: r.amount, paid_amount: r.paid,
    invoice_date: env.d(-r.invoiceAgo), due_date: env.d(r.dueIn), subsidy_linked: r.subsidy, linked_project_id: r.subsidy ? (projects[r.dealer] ?? null) : null, status: r.status,
  }));
}

/** Same arithmetic as the API's dealer-exposure service: open amount bucketed by days past due. */
function creditPosition(env: SeedEnv, dealerId: string): { outstanding: number; subsidy: number; ageing: CreditAgeing } {
  const ageing: CreditAgeing = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
  let outstanding = 0, subsidy = 0;
  for (const r of RECEIVABLES.filter((x) => x.dealer === dealerId && (x.status === 'open' || x.status === 'overdue'))) {
    const open = Math.max(0, r.amount - r.paid);
    if (open <= 0) continue;
    outstanding += open;
    if (r.subsidy) subsidy += open;
    const pastDue = daysBetween(env.d(r.dueIn), env.d(0));
    if (pastDue <= 0) ageing.current += open;
    else if (pastDue <= 30) ageing.d1_30 += open;
    else if (pastDue <= 60) ageing.d31_60 += open;
    else if (pastDue <= 90) ageing.d61_90 += open;
    else ageing.d90_plus += open;
  }
  return { outstanding, subsidy, ageing };
}

/* ───────────────────────── serials ───────────────────────── */

const SNAP = (env: SeedEnv): Record<SkuKey, SerialSnapshot> => {
  const fresh = env.d(-2);
  const mk = (l1: boolean, l2: boolean, dcr: boolean, date: string): SerialSnapshot => ({ almm_list1: l1, almm_list2: l2, dcr_verified: dcr, bis_ok: true, snapshot_date: date });
  return {
    m1Dcr: mk(true, true, true, fresh), m2NonDcr: mk(true, true, false, fresh), m3NotListI: mk(false, true, false, fresh), m4BisExpired: mk(true, true, false, fresh), m5BisModelMismatch: mk(true, true, false, fresh),
    m6NoListII: mk(true, false, true, env.d(-30)), m7ThinFilm: mk(true, false, false, fresh), m8StaleSnapshot: mk(true, true, true, env.d(-12)),
    i1Residential: mk(false, false, false, fresh), i2Large250: mk(false, false, false, fresh), i3Commercial100: mk(false, false, false, fresh), s1Structure: mk(false, false, false, fresh), c1Cable: mk(false, false, false, fresh), b1Battery: mk(false, false, false, fresh),
  };
};

const SERIAL_PREFIX: Partial<Record<SkuKey, [string, number]>> = {
  m1Dcr: ['DS600D26-', 10001], m6NoListII: ['DS580K26-', 20001], m2NonDcr: ['DS600S26-', 30001], m3NotListI: ['NP590-26-', 40001], i1Residential: ['GM5K26-', 50001], i3Commercial100: ['GM100K26-', 60001],
};

export interface SerialPlan { serials: InventorySerial[]; dispatchLinks: DispatchSerial[] }

export function buildSerials(env: SeedEnv, quotes: Quotation[]): SerialPlan {
  const snap = SNAP(env);
  const counters: Partial<Record<SkuKey, number>> = {};
  const serials: InventorySerial[] = [];
  const dispatchLinks: DispatchSerial[] = [];
  const dist = new Map(buildDistributors(env).map((d) => [d.id, d.legal_name]));
  const dealers = new Map(buildDealers(env).map((d) => [d.id, d.legal_name]));
  const batchOf: Partial<Record<SkuKey, string>> = { m1Dcr: BATCH_IDS.m1, m2NonDcr: BATCH_IDS.m2, m3NotListI: BATCH_IDS.m3, m6NoListII: BATCH_IDS.m6, i1Residential: BATCH_IDS.i1, i3Commercial100: BATCH_IDS.i3 };

  const chain = (n: number, dealerId: string, distId: string, agoDays: number, full: boolean): InvoiceChainLink[] => {
    const links: InvoiceChainLink[] = [{ from: 'Future Solar Pvt. Ltd.', to: dist.get(distId) ?? 'Distributor', invoice_no: `DEMO-INV-B-${String(n).padStart(4, '0')}`, date: env.d(-agoDays - 10) }];
    if (full) {
      links.push({ from: dist.get(distId) ?? 'Distributor', to: dealers.get(dealerId) ?? 'Dealer', invoice_no: `DEMO-INV-D-${String(n).padStart(4, '0')}`, date: env.d(-agoDays - 5) });
      links.push({ from: dealers.get(dealerId) ?? 'Dealer', to: 'End customer', invoice_no: `DEMO-INV-R-${String(n).padStart(4, '0')}`, date: env.d(-agoDays) });
    }
    return links;
  };

  const add = (sku: SkuKey, o: Partial<InventorySerial> & { status: InventorySerial['status'] }): InventorySerial => {
    const [prefix, start] = SERIAL_PREFIX[sku] ?? [`${sku}-`, 90001];
    counters[sku] = (counters[sku] ?? 0) + 1;
    const row: InventorySerial = {
      ...baseOf(env, demoId('serial', serials.length + 1), 60 * DAY, P.dispatch), serial: `${prefix}${start + (counters[sku] ?? 1) - 1}`, sku_id: I.sku[sku], batch_id: batchOf[sku] ?? null,
      quote_id: null, sales_order_id: null, sales_order_line_id: null, dispatch_id: null, site_id: null, compliance_snapshot: snap[sku], invoice_chain: [], installed_at: null, ...o,
    };
    serials.push(row);
    return row;
  };

  // installed projects (SO 1–3): modules on line 1, inverter on line 2
  const installed: { n: number; lead: LeadKey; modules: number; so: string; dispatch: string; dealer: string; dist: string; ago: number }[] = [
    { n: 1, lead: 'won1', modules: 5, so: I.salesOrder.so1, dispatch: I.dispatch.dsp1, dealer: I.dealer.d2, dist: I.distributor.sunrise, ago: 42 },
    { n: 2, lead: 'won2', modules: 5, so: I.salesOrder.so2, dispatch: I.dispatch.dsp2, dealer: I.dealer.d3, dist: I.distributor.sunrise, ago: 36 },
    { n: 3, lead: 'won3', modules: 4, so: I.salesOrder.so3, dispatch: I.dispatch.dsp3, dealer: I.dealer.d2, dist: I.distributor.sunrise, ago: 44 },
  ];
  for (const p of installed) {
    const common = { sales_order_id: p.so, dispatch_id: p.dispatch, site_id: siteIdOf(p.lead), invoice_chain: chain(p.n, p.dealer, p.dist, p.ago, true), installed_at: env.t(-(p.ago - 4) * DAY) };
    for (let k = 0; k < p.modules; k++) {
      const spare = p.n === 2 && k === p.modules - 1; // a spare module shipped with project 2 but not yet installed
      const row = add('m1Dcr', { ...common, status: p.n === 1 && k === 0 ? 'rma' : spare ? 'dispatched' : 'installed', installed_at: spare ? null : common.installed_at, sales_order_line_id: soLineId(p.n, 1) });
      dispatchLinks.push({ ...baseOf(env, demoId('dispatch-serial', dispatchLinks.length + 1), p.ago * DAY, P.dispatch), dispatch_id: p.dispatch, serial_id: row.id, so_line_id: soLineId(p.n, 1) });
    }
    const inv = add('i1Residential', { ...common, status: 'installed', sales_order_line_id: soLineId(p.n, 2) });
    dispatchLinks.push({ ...baseOf(env, demoId('dispatch-serial', dispatchLinks.length + 1), p.ago * DAY, P.dispatch), dispatch_id: p.dispatch, serial_id: inv.id, so_line_id: soLineId(p.n, 2) });
  }

  // SO 4 (RWA): serials picked from the non-List-II batch — the dispatch is blocked by gate G4
  for (let k = 0; k < 8; k++) {
    const row = add('m6NoListII', { status: 'reserved', sales_order_id: I.salesOrder.so4, sales_order_line_id: soLineId(4, 1), dispatch_id: I.dispatch.dsp4, invoice_chain: chain(4, I.dealer.d8, I.distributor.suryamitra, 0, false) });
    dispatchLinks.push({ ...baseOf(env, demoId('dispatch-serial', dispatchLinks.length + 1), 2 * DAY, P.dispatch), dispatch_id: I.dispatch.dsp4, serial_id: row.id, so_line_id: soLineId(4, 1) });
  }
  const inv4 = add('i3Commercial100', { status: 'reserved', sales_order_id: I.salesOrder.so4, sales_order_line_id: soLineId(4, 2), dispatch_id: I.dispatch.dsp4, invoice_chain: chain(4, I.dealer.d8, I.distributor.suryamitra, 0, false) });
  dispatchLinks.push({ ...baseOf(env, demoId('dispatch-serial', dispatchLinks.length + 1), 2 * DAY, P.dispatch), dispatch_id: I.dispatch.dsp4, serial_id: inv4.id, so_line_id: soLineId(4, 2) });

  // SO 5 (on hold): reserved against the order
  for (let k = 0; k < 5; k++) add('m1Dcr', { status: 'reserved', sales_order_id: I.salesOrder.so5, sales_order_line_id: soLineId(5, 1), quote_id: I.quote.w5, invoice_chain: chain(5, I.dealer.d6, I.distributor.saurashtra, 0, false) });
  add('i1Residential', { status: 'reserved', sales_order_id: I.salesOrder.so5, sales_order_line_id: soLineId(5, 2), quote_id: I.quote.w5, invoice_chain: chain(5, I.dealer.d6, I.distributor.saurashtra, 0, false) });

  // reserved against an open quote
  const cleanQuote = quotes.find((q) => q.id === I.quote.clean1);
  for (let k = 0; k < 5; k++) add('m1Dcr', { status: 'reserved', quote_id: cleanQuote ? cleanQuote.id : null });

  // free stock — the m6 batch is the non-List-II exposure ahead of 31-Dec-2026
  for (let k = 0; k < 8; k++) add('m1Dcr', { status: 'in_stock' });
  for (let k = 0; k < 12; k++) add('m6NoListII', { status: 'in_stock' });
  for (let k = 0; k < 4; k++) add('m2NonDcr', { status: 'in_stock' });
  for (let k = 0; k < 3; k++) add('m3NotListI', { status: 'in_stock' });
  for (let k = 0; k < 3; k++) add('i1Residential', { status: 'in_stock' });
  for (let k = 0; k < 2; k++) add('i3Commercial100', { status: 'in_stock' });

  return { serials, dispatchLinks };
}

export const serialsOfSo = (serials: InventorySerial[], soId: string, skuKey: SkuKey): InventorySerial[] => serials.filter((s) => s.sales_order_id === soId && s.sku_id === I.sku[skuKey]);

/* ───────────────────────── PIs, payments, credit, SOs, dispatches ───────────────────────── */

export interface OrderSet {
  pis: ProformaInvoice[]; piLines: ProformaInvoiceLine[]; payments: Payment[]; creditChecks: CreditCheck[]; overrides: CreditOverride[]; approvals: Approval[];
  salesOrders: SalesOrder[]; soLines: SalesOrderLine[]; dispatches: Dispatch[]; einvoices: EinvoiceStatus[]; receivables: DealerReceivable[];
}

export function buildOrders(env: SeedEnv, quoteSet: QuoteSet, leads: LeadLayer, approvalOffset: number): OrderSet {
  const out: OrderSet = { pis: [], piLines: [], payments: [], creditChecks: [], overrides: [], approvals: [], salesOrders: [], soLines: [], dispatches: [], einvoices: [], receivables: buildReceivables(env) };
  const dealerRows = new Map(buildDealers(env).map((d) => [d.id, d]));

  for (const w of WON_PROJECTS) {
    const q = quoteSet.quotes.find((x) => x.id === I.quote[w.quote])!;
    const qLines = quoteSet.lines.filter((l) => l.quote_id === q.id);
    const spec = specOf(w.lead);
    const customer = leads.customers.find((c) => c.id === customerIdOf(w.lead))!;
    const age = w.ageDays * DAY;
    const netSubtotal = round2(q.subtotal - q.discount_amount);
    const status: PiStatus = w.n === 4 ? 'partially_paid' : w.n === 5 ? 'issued' : 'paid';
    const piId = I.proformaInvoice[w.pi];
    const soId = I.salesOrder[w.so];

    out.pis.push({
      ...baseOf(env, piId, age, P.techno_commercial), pi_no: `PI-DEMO-W${w.n}`, quote_id: q.id, opportunity_id: q.opportunity_id, customer_id: customer.id, dealer_id: w.dealer, distributor_id: spec.dist, status,
      legal_name: customer.legal_name, gstin: customer.gstin, billing_address: customer.billing_address, shipping_address: customer.shipping_address, payment_terms: q.payment_terms,
      subtotal: netSubtotal, freight: q.freight, tax_total: q.tax_total, total: q.total, consumer_share: q.consumer_share, loan_share: q.loan_share, subsidy_receivable: q.cfa_entitlement,
      pre_pi_checklist: CHECKLIST, issue_date: env.d(-w.ageDays + 2), valid_till: env.d(-w.ageDays + 17), approved_by: P.sales_manager, issued_at: env.t(-age + 2 * DAY), sales_order_id: soId,
    });
    qLines.forEach((l, i) => {
      const unit = round2(l.unit_price * (1 - q.discount_pct / 100));
      out.piLines.push({
        ...baseOf(env, demoId('pi-line', w.n * 10 + i + 1), age, P.techno_commercial), pi_id: piId, sku_id: l.sku_id, description: l.description, hsn: l.hsn, gst_rate: l.gst_rate, qty: l.qty, unit_price: unit, line_total: round2(l.qty * unit), sort_order: i + 1,
      });
      out.soLines.push({
        ...baseOf(env, soLineId(w.n, i + 1), age, P.techno_commercial), so_id: soId, sku_id: l.sku_id, description: l.description, hsn: l.hsn, gst_rate: l.gst_rate, qty: l.qty, unit_price: unit, line_total: round2(l.qty * unit),
        qty_dispatched: w.n <= 3 ? l.qty : 0, sort_order: i + 1,
      });
    });

    // payments
    const adv = round2(q.total * 0.3);
    const pay = (kind: Payment['kind'], amount: number, mode: string, ref: string, agoDays: number, status: Payment['status']): void => {
      out.payments.push({ ...baseOf(env, demoId('payment', out.payments.length + 1), agoDays * DAY, P.accounts), pi_id: piId, sales_order_id: soId, kind, amount, mode, reference: ref, received_at: env.t(-agoDays * DAY), recorded_by: P.accounts, status });
    };
    let advanceReceived = 0;
    if (w.n === 1 || w.n === 3) {
      pay('advance', adv, 'upi', `DEMO-UPI-${w.n}001`, w.ageDays - 3, 'received');
      pay('balance', round2(q.total - adv), 'neft_rtgs', `DEMO-NEFT-${w.n}002`, w.ageDays - 14, 'received');
      advanceReceived = q.total;
    } else if (w.n === 2) {
      pay('advance', adv, 'upi', 'DEMO-UPI-2001', w.ageDays - 3, 'received');
      pay('loan_disbursal', 60000, 'loan', 'DEMO-LOAN-2002', w.ageDays - 20, 'received');
      pay('balance', round2(q.total - adv - 60000), 'neft_rtgs', 'DEMO-NEFT-2003', w.ageDays - 22, 'received');
      advanceReceived = q.total;
    } else if (w.n === 4) {
      pay('advance', adv, 'cheque', 'DEMO-CHQ-4001', w.ageDays - 3, 'bounced');
      pay('advance', adv, 'upi', 'DEMO-UPI-4002', w.ageDays - 6, 'received');
      advanceReceived = adv;
    } else {
      pay('advance', adv, 'cheque', 'DEMO-CHQ-5001', 1, 'pending');
    }

    // credit check
    const dealer = dealerRows.get(w.dealer)!;
    const pos = creditPosition(env, w.dealer);
    const basis: CreditCheck['basis'] = w.n === 5 ? 'credit' : 'advance';
    const result: CreditCheck['result'] = w.n === 5 ? 'rejected' : 'approved';
    out.creditChecks.push({
      ...baseOf(env, demoId('credit-check', out.creditChecks.length + 1), age, P.accounts), pi_id: piId, sales_order_id: soId, dealer_id: w.dealer, distributor_id: dealer.distributor_id, basis, result,
      credit_limit: dealer.credit_limit, outstanding: pos.outstanding, ageing: pos.ageing, subsidy_linked: pos.subsidy, bg_valid: dealer.security_type === 'bank_guarantee' || w.dealer === I.dealer.d3 ? true : null, portal_status: dealer.portal_status,
      notes: w.n === 5 ? 'Credit not approved: dealer has a 61–90 day overdue subsidy-linked invoice. Advance required.' : w.n === 2 ? 'Approved on advance; dealer bank guarantee expires in 40 days — renewal reminder raised.' : 'Approved on advance basis.',
      decided_by: P.accounts, decided_at: env.t(-age + DAY),
    });

    // sales order
    const soStatus: SoStatus = w.n === 1 || w.n === 3 ? 'closed' : w.n === 2 ? 'dispatched' : w.n === 4 ? 'dispatch_planning' : 'on_hold';
    out.salesOrders.push({
      ...baseOf(env, soId, age - 2 * DAY, P.techno_commercial), so_no: `SO-DEMO-W${w.n}`, pi_id: piId, quote_id: q.id, opportunity_id: q.opportunity_id, customer_id: customer.id, site_id: siteIdOf(w.lead), dealer_id: w.dealer,
      distributor_id: spec.dist, territory_id: spec.territory, segment: spec.segment, status: soStatus, customer_po_no: `DEMO-PO-${String(w.n).padStart(4, '0')}`, customer_po_date: env.d(-w.ageDays + 5), po_document_id: null,
      hold_reason: w.n === 5 ? 'Awaiting the 30 % advance — the cheque is pending clearance and credit was not approved.' : null, order_date: env.d(-w.ageDays + 6), total: q.total, advance_received: advanceReceived,
      credit_basis: basis, circulated_at: w.n === 5 ? null : env.t(-age + 7 * DAY), approved_by: w.n === 5 ? null : P.sales_manager, dispatch_handover_at: w.n === 5 ? null : env.t(-age + 8 * DAY), expected_commissioning_date: q.expected_commissioning_date,
    });

    // dispatch
    if (w.dispatch) {
      const dsp = w.dispatch;
      const blocked = dsp === 'dsp4';
      const dStatus: DispatchStatus = blocked ? 'blocked' : dsp === 'dsp2' ? 'dispatched' : 'delivered';
      const compl: ComplianceStatus = blocked ? 'blocked' : 'clear';
      const agoDispatch = blocked ? 0 : w.n === 1 ? 43 : w.n === 2 ? 37 : 45;
      out.dispatches.push({
        ...baseOf(env, I.dispatch[dsp], blocked ? 2 * DAY : agoDispatch * DAY, P.dispatch), dispatch_no: `DSP-DEMO-${String(w.n).padStart(3, '0')}`, so_id: soId, status: dStatus, planned_at: env.t(blocked ? 2 * DAY : -(agoDispatch + 1) * DAY),
        dispatched_at: blocked ? null : env.t(-agoDispatch * DAY), vehicle_no: blocked ? null : `GJ00DM${String(1000 + w.n)}`, transporter: blocked ? null : 'Demo Logistics Pvt. Ltd.', ewb_no: blocked ? null : `DEMO-EWB-${100000000 + w.n}`,
        ewb_status: blocked ? 'not_required' : dsp === 'dsp2' ? 'manual_pending' : 'generated', invoice_no: blocked ? null : `DEMO-INV-R-${String(w.n).padStart(4, '0')}`,
        invoice_chain: blocked ? [] : [{ from: 'Future Solar Pvt. Ltd.', to: 'Distributor', invoice_no: `DEMO-INV-B-${String(w.n).padStart(4, '0')}`, date: env.d(-agoDispatch - 10) }],
        compliance_status: compl,
        compliance_findings: blocked
          ? [{ gate: 'G4', severity: 'hard_stop', message: 'Serials from batch DS580K-2026-03 have cells that are not on ALMM List-II; this subsidised RWA / GHS project commissions after the List-II effective date.', ruleIds: [ruleSeedId('almm.list2.effective_date')], fieldRefs: ['dispatch_serials.serial'], advisory: false, ruleStatus: 'verified', ruleConfidence: 'high', ruleSource: 'MNRE ALMM orders (trade-press summary)' }]
          : [],
        dispatch_note_document_id: null, ship_to: customer.shipping_address,
      });
      const einv: EinvoiceStatus['status'] = blocked ? 'failed' : dsp === 'dsp2' ? 'manual_pending' : 'generated';
      out.einvoices.push({
        ...baseOf(env, demoId('einvoice', out.einvoices.length + 1), agoDispatch * DAY, P.accounts), entity_type: 'dispatch', entity_id: I.dispatch[dsp], irn: einv === 'generated' ? `DEMO-IRN-${'0123456789abcdef'.repeat(4).slice(0, 56)}${w.n}` : null,
        ack_no: einv === 'generated' ? `DEMO-ACK-${w.n}` : null, ack_date: einv === 'generated' ? env.t(-agoDispatch * DAY) : null, status: einv, provider: 'mock', payload: einv === 'failed' ? { error: 'Mock provider timeout — retry or enter manually' } : {},
      });
    }
  }
  out.einvoices.push({ ...baseOf(env, demoId('einvoice', out.einvoices.length + 1), 3 * DAY, P.accounts), entity_type: 'proforma_invoice', entity_id: I.proformaInvoice.pi5, irn: null, ack_no: null, ack_date: null, status: 'not_required', provider: 'mock', payload: { reason: 'Proforma invoice — no IRN required' } });

  // a superseded proforma invoice for project 5 (customer address corrected)
  const q5 = quoteSet.quotes.find((x) => x.id === I.quote.w5)!;
  const c5 = leads.customers.find((c) => c.id === customerIdOf('won5'))!;
  out.pis.push({
    ...baseOf(env, I.proformaInvoice.piCancelled, 44 * DAY, P.techno_commercial), pi_no: 'PI-DEMO-W5-0', quote_id: q5.id, opportunity_id: q5.opportunity_id, customer_id: c5.id, dealer_id: I.dealer.d6, distributor_id: I.distributor.saurashtra, status: 'cancelled',
    legal_name: c5.legal_name, gstin: null, billing_address: c5.billing_address, shipping_address: null, payment_terms: q5.payment_terms, subtotal: round2(q5.subtotal - q5.discount_amount), freight: q5.freight, tax_total: q5.tax_total, total: q5.total,
    consumer_share: q5.consumer_share, loan_share: 0, subsidy_receivable: q5.cfa_entitlement, pre_pi_checklist: { ...CHECKLIST, shipping_address: false }, issue_date: null, valid_till: null, approved_by: null, issued_at: null, sales_order_id: null,
  });

  // credit overrides: approved / pending / rejected
  const ov = (key: keyof typeof I.creditOverride, dealer: string, pi: string | null, status: CreditOverride['status'], reason: string, so: string | null): CreditOverride => ({
    ...baseOf(env, I.creditOverride[key], 20 * DAY, P.dsm), dealer_id: dealer, pi_id: pi, sales_order_id: so, reason, status, requested_by: P.dsm, approved_by: status === 'pending' ? null : P.accounts, approved_at: status === 'pending' ? null : env.t(-19 * DAY),
  });
  out.overrides.push(
    ov('approved', I.dealer.d3, I.proformaInvoice.pi2, 'approved', 'Bank guarantee expires in 40 days; renewal letter received and the project is covered by a bank loan.', I.salesOrder.so2),
    ov('pending', I.dealer.d1, null, 'pending', 'Customer insists on credit; the dealer is ₹ 2.5 lakh over its limit with a 60+ day subsidy-linked invoice.', null),
    ov('rejected', I.dealer.d5, null, 'rejected', 'Dealer is deactivated on the PM Surya Ghar portal; no orders may be created.', null),
  );
  out.creditChecks.push({
    ...baseOf(env, demoId('credit-check', out.creditChecks.length + 1), 3 * DAY, P.accounts), pi_id: null, sales_order_id: null, dealer_id: I.dealer.d1, distributor_id: I.distributor.sunrise, basis: 'credit', result: 'rejected',
    credit_limit: 2_000_000, outstanding: creditPosition(env, I.dealer.d1).outstanding, ageing: creditPosition(env, I.dealer.d1).ageing, subsidy_linked: creditPosition(env, I.dealer.d1).subsidy, bg_valid: null, portal_status: 'active',
    notes: 'Over the approved credit limit (gate G11). A credit override has been requested.', decided_by: P.accounts, decided_at: env.t(-3 * DAY),
  });
  out.creditChecks.push({
    ...baseOf(env, demoId('credit-check', out.creditChecks.length + 1), 1 * DAY, P.accounts), pi_id: null, sales_order_id: null, dealer_id: I.dealer.d4, distributor_id: I.distributor.suryamitra, basis: 'credit', result: 'pending',
    credit_limit: 2_500_000, outstanding: creditPosition(env, I.dealer.d4).outstanding, ageing: creditPosition(env, I.dealer.d4).ageing, subsidy_linked: creditPosition(env, I.dealer.d4).subsidy, bg_valid: true, portal_status: 'under_sop',
    notes: 'Dealer is under an MNRE SOP review — accounts to decide.', decided_by: null, decided_at: null,
  });

  // approvals: credit lane on the overrides, commercial on the PI
  let n = approvalOffset;
  const approval = (entity: Approval['entity_type'], id: string, lane: Approval['lane'], role: Approval['required_role'], approver: string | null, decision: Approval['decision'], comment: string | null, agoDays: number, dueHours: number | null): void => {
    n += 1;
    out.approvals.push({
      ...baseOf(env, demoId('approval', n), agoDays * DAY, P.dsm), entity_type: entity, entity_id: id, lane, step: 1, required_role: role, approver_id: approver, decision, comment,
      decided_at: decision === 'pending' ? null : env.t(-agoDays * DAY + 3 * 60), due_at: dueHours === null ? env.t(-agoDays * DAY + 24 * 60) : env.t(dueHours * 60), requested_by: P.dsm, requested_at: env.t(-agoDays * DAY), meta: {},
    });
  };
  approval('credit_override', I.creditOverride.approved, 'credit', 'accounts', P.accounts, 'approved', 'Approved — renewal letter on file.', 19, null);
  approval('credit_override', I.creditOverride.pending, 'credit', 'accounts', null, 'pending', null, 1, 18);
  approval('credit_override', I.creditOverride.rejected, 'credit', 'accounts', P.accounts, 'rejected', 'Rejected — dealer deactivated on the portal.', 19, null);
  approval('proforma_invoice', I.proformaInvoice.pi4, 'commercial', 'sales_manager', P.sales_manager, 'approved', 'PI approved for issue.', 64, null);
  return out;
}
