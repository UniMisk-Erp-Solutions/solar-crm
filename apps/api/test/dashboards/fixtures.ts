import {
  seedId, type Approval, type Clock, type ComplianceCalendarItem, type ContactLog, type Dealer, type DealerReceivable, type Discom, type DiscomApplication, type Dispatch, type Followup, type InventorySerial, type Lead,
  type LeadAssignment, type LeadConsent, type Loan, type MessageLog, type Opportunity, type ProformaInvoice, type Quotation, type QuotationLine, type SalesOrder, type Sku, type SkuPrice, type SiteSurvey,
  type StockBatch, type SubsidyClaim, type VendorRegistration, type WarrantyTicket, type CreditCheck,
} from '@solar/shared';
import { createTestEnv, IDS, T0, type TestEnv } from '../helpers/env';
import dashboardsRouter from '../../src/routes/dashboards.routes';
import reportsRouter from '../../src/routes/reports.routes';
import searchRouter from '../../src/routes/search.routes';

export { IDS, T0 };
export const DAY = 86_400_000;
export const HOUR = 3_600_000;
export const MIN = 60_000;
/** ISO timestamp `days` days (and `hours` hours) before the fixed test clock (Mon 26-Oct-2026 10:30 IST). */
export const ago = (days: number, hours = 0, minutes = 0): string => new Date(T0.getTime() - days * DAY - hours * HOUR - minutes * MIN).toISOString();
export const ahead = (days: number, hours = 0, minutes = 0): string => new Date(T0.getTime() + days * DAY + hours * HOUR + minutes * MIN).toISOString();
/** YYYY-MM-DD, `days` from the test "today" (26-Oct-2026). */
export const dateOffset = (days: number): string => new Date(Date.UTC(2026, 9, 26) + days * DAY).toISOString().slice(0, 10);

export const id = (kind: string, n: number): string => seedId(`fx-${kind}`, n);

export function makeEnv(extra: { now?: Date } = {}): TestEnv {
  return createTestEnv({ authed: [dashboardsRouter, reportsRouter, searchRouter], now: extra.now });
}

/** Typed row inserters with sensible defaults; ids are deterministic (`id('lead', 1)`). */
export function seeder(env: TestEnv) {
  const db = env.ctx('admin').db;
  return {
    db,
    lead: (n: number, o: Partial<Lead> = {}) => db.table('leads').insert({
      id: id('lead', n), source: 'website', name: `Lead ${n}`, mobile: `+9198000${String(n).padStart(5, '0')}`, email: null, status: 'new', segment: null, temperature: null, distributor_id: null, dealer_id: null, territory_id: null,
      owner_id: null, city: 'Ahmedabad', capacity_kw: null, deleted_at: null, created_at: ago(10), first_contacted_at: null, sla_due_at: null, next_followup_at: null, dnd_status: 'clear', ...o,
    }),
    opp: (n: number, leadN: number, o: Partial<Opportunity> = {}) => db.table('opportunities').insert({
      id: id('opp', n), name: `Opportunity ${n}`, lead_id: id('lead', leadN), segment: 'pmsg_residential', kw: 3, stage: 'qualified', expected_value: 200_000, distributor_id: null, dealer_id: null, territory_id: null, created_at: ago(9), ...o,
    }),
    quote: (n: number, oppN: number, o: Partial<Quotation> = {}) => db.table('quotations').insert({
      id: id('quote', n), quote_no: `QT-${n}`, version: 1, opportunity_id: id('opp', oppN), lead_id: null, segment: 'pmsg_residential', kw: 3, status: 'draft', total: 200_000, subtotal: 190_000, compliance_findings: [], requote_reason: null,
      sent_at: null, owner_id: null, distributor_id: null, dealer_id: null, territory_id: null, created_at: ago(8), ...o,
    }),
    quoteLine: (n: number, quoteN: number, o: Partial<QuotationLine> = {}) => db.table('quotation_lines').insert({
      id: id('qline', n), quote_id: id('quote', quoteN), sku_id: null, description: 'Line', qty: 1, unit_price: 0, discount_pct: 0, line_total: 0, ...o,
    }),
    pi: (n: number, quoteN: number, o: Partial<ProformaInvoice> = {}) => db.table('proforma_invoices').insert({
      id: id('pi', n), pi_no: `PI-${n}`, quote_id: id('quote', quoteN), status: 'issued', total: 200_000, sales_order_id: null, distributor_id: null, dealer_id: null, legal_name: null, valid_till: null, created_at: ago(7), ...o,
    }),
    so: (n: number, piN: number, quoteN: number, o: Partial<SalesOrder> = {}) => db.table('sales_orders').insert({
      id: id('so', n), so_no: `SO-${n}`, pi_id: id('pi', piN), quote_id: id('quote', quoteN), segment: 'pmsg_residential', status: 'approved', total: 200_000, order_date: dateOffset(-6), distributor_id: null, dealer_id: null, territory_id: null,
      hold_reason: null, created_at: ago(6), ...o,
    }),
    survey: (n: number, leadN: number, o: Partial<SiteSurvey> = {}) => db.table('site_surveys').insert({ id: id('survey', n), lead_id: id('lead', leadN), status: 'completed', created_at: ago(9), ...o }),
    loan: (n: number, o: Partial<Loan> = {}) => db.table('loans').insert({ id: id('loan', n), bank: 'SBI', status: 'applied', application_date: dateOffset(-10), amount: 100_000, distributor_id: null, dealer_id: null, created_at: ago(10), ...o }),
    followup: (n: number, leadN: number, o: Partial<Followup> = {}) => db.table('followups').insert({ id: id('fu', n), lead_id: id('lead', leadN), kind: 'call', due_at: ago(1), status: 'open', done_at: null, owner_id: null, note: null, escalated_level: 0, ...o }),
    clock: (n: number, o: Partial<Clock> = {}) => db.table('clocks').insert({
      id: id('clock', n), entity_type: 'lead', entity_id: id('lead', n), clock_type: 'lead_acceptance', started_at: ago(5), due_at: ago(4), warn_at: null, status: 'running', escalated_level: 0, owner_id: null,
      warned_at: null, breached_at: null, resolved_at: null, last_escalated_at: null, meta: {}, ...o,
    }),
    assignment: (n: number, leadN: number, o: Partial<LeadAssignment> = {}) => db.table('lead_assignments').insert({ id: id('asg', n), lead_id: id('lead', leadN), status: 'pending', assigned_at: ago(5), due_at: ago(4), responded_at: null, assigned_to: null, ...o }),
    contactLog: (n: number, leadN: number, o: Partial<ContactLog> = {}) => db.table('contact_logs').insert({ id: id('contact', n), lead_id: id('lead', leadN), channel: 'call', direction: 'outbound', outcome: 'connected_interested', occurred_at: ago(5), ...o }),
    consent: (n: number, leadN: number, o: Partial<LeadConsent> = {}) => db.table('lead_consents').insert({
      id: id('consent', n), lead_id: id('lead', leadN), notice_version: 'v1', purposes: ['promotional'], channels: ['whatsapp'], recipients_named: [], granted_at: ago(10), withdrawn_at: null, withdrawal_channel: null, optout_suppress_until: null, created_at: ago(10), ...o,
    }),
    message: (n: number, leadN: number | null, o: Partial<MessageLog> = {}) => db.table('message_log').insert({
      id: id('msg', n), lead_id: leadN === null ? null : id('lead', leadN), channel: 'whatsapp', purpose: 'promotional', direction: 'outbound', status: 'sent', block_reason: null, created_at: ago(5), ...o,
    }),
    dealer: (n: number, distributorId: string, o: Partial<Dealer> = {}) => db.table('dealers').insert({
      id: id('dealer', n), distributor_id: distributorId, legal_name: `Dealer ${n}`, credit_limit: 1_000_000, portal_status: 'active', status: 'active', state: 'Gujarat', ...o,
    }),
    receivable: (n: number, dealerId: string, o: Partial<DealerReceivable> = {}) => db.table('dealer_receivables').insert({
      id: id('recv', n), dealer_id: dealerId, distributor_id: null, doc_ref: `INV-${n}`, amount: 100_000, paid_amount: 0, invoice_date: dateOffset(-30), due_date: dateOffset(-5), subsidy_linked: false, status: 'open', ...o,
    }),
    vendorReg: (n: number, dealerId: string, o: Partial<VendorRegistration> = {}) => db.table('vendor_registrations').insert({
      id: id('vreg', n), party_type: 'dealer', party_id: dealerId, level: 'state', portal_status: 'active', bank_guarantee_amount: 250_000, bank_guarantee_valid_till: null, ...o,
    }),
    sku: (n: number, o: Partial<Sku> = {}) => db.table('skus').insert({ id: id('sku', n), category: 'module', make: 'Waaree', model: `WSMD-${n}`, variant: null, wattage: 540, active: true, ...o }),
    price: (n: number, skuN: number, o: Partial<SkuPrice> = {}) => db.table('sku_prices').insert({ id: id('price', n), sku_id: id('sku', skuN), base_price: 10_000, valid_from: '2026-01-01', valid_to: null, ...o }),
    batch: (n: number, skuN: number, o: Partial<StockBatch> = {}) => db.table('stock_batches').insert({ id: id('batch', n), sku_id: id('sku', skuN), batch_no: `B-${n}`, received_at: '2026-09-01', qty: 100, supplier: 'Supplier', origin: 'import', unit_cost: null, ...o }),
    serial: (n: number, skuN: number, o: Partial<InventorySerial> = {}) => db.table('inventory_serials').insert({
      id: id('serial', n), serial: `SN-${n}`, sku_id: id('sku', skuN), batch_id: null, status: 'in_stock', compliance_snapshot: { almm_list1: true, almm_list2: false, dcr_verified: true, bis_ok: true, snapshot_date: '2026-10-20' }, ...o,
    }),
    discom: (n: number, code: string, name: string, o: Partial<Discom> = {}) => db.table('discoms').insert({ id: id('discom', n), code, name, state: 'Gujarat', kind: 'discom', ...o }),
    discomApp: (n: number, o: Partial<DiscomApplication> = {}) => db.table('discom_applications').insert({
      id: id('dapp', n), application_no: `DA-${n}`, discom_id: null, sales_order_id: null, dealer_id: null, distributor_id: null, submitted_at: ago(20), complete_at: null, feasibility_due_at: null, feasibility_status: 'not_required',
      inspection_at: null, meter_at: null, certificate_submitted_at: null, commissioning_due_at: null, commissioning_at: null, deemed_breach: false, created_at: ago(20), ...o,
    }),
    claim: (n: number, o: Partial<SubsidyClaim> = {}) => db.table('subsidy_claims').insert({
      id: id('claim', n), sales_order_id: null, dealer_id: null, distributor_id: null, status: 'claimed', cohort: 'current', cfa_computed: 78_000, state_share: 0, discom_approval_at: null, released_at: null, claim_deadline: null,
      state_share_due_at: null, state_share_received_at: null, created_at: ago(30), ...o,
    }),
    ticket: (n: number, o: Partial<WarrantyTicket> = {}) => db.table('warranty_tickets').insert({
      id: id('ticket', n), ticket_no: `WT-${n}`, dealer_id: null, type: 'rma', issue: 'Panel defect', brand_claim_no: null, cost_bearer: 'brand', status: 'open', opened_at: ago(20), closed_at: null, recovered_amount: 0, ...o,
    }),
    approval: (n: number, o: Partial<Approval> = {}) => db.table('approvals').insert({
      id: id('appr', n), entity_type: 'quotation', entity_id: id('quote', n), lane: 'commercial', step: 1, required_role: 'dsm', decision: 'pending', requested_at: ago(1), due_at: ahead(0, 4), meta: {}, ...o,
    }),
    creditCheck: (n: number, o: Partial<CreditCheck> = {}) => db.table('credit_checks').insert({ id: id('cc', n), dealer_id: null, distributor_id: null, result: 'pending', credit_limit: 500_000, outstanding: 100_000, basis: 'credit', ...o }),
    dispatch: (n: number, soN: number, o: Partial<Dispatch> = {}) => db.table('dispatches').insert({ id: id('disp', n), dispatch_no: `DN-${n}`, so_id: id('so', soN), status: 'blocked', compliance_status: 'blocked', compliance_findings: [], ...o }),
    calendar: (n: number, dueDate: string, o: Partial<ComplianceCalendarItem> = {}) => db.table('compliance_calendar_items').insert({ id: id('cal', n), due_date: dueDate, title: `Deadline ${n}`, category: 'regulatory', confidence: 'medium', active: true, escalate_days: [], ...o }),
  };
}

export type Seeder = ReturnType<typeof seeder>;
