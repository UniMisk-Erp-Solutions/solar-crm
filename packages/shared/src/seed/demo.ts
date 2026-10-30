import type { SeedData } from './types';
import { buildSkuCompliance, buildSkuPrices, buildSkus, buildStockBatches } from './demo.catalogue';
import { buildLeadLayer } from './demo.leads';
import { buildOrders, buildSerials } from './demo.orders';
import { buildDealers, buildDistributors, buildProfiles, buildScoreHistory, buildSopCases, buildUserTerritories, buildVendorRegistrations } from './demo.people';
import { buildNegotiationLogs, buildOpportunities, buildRequirementForms } from './demo.pipeline';
import { buildAuditLog, buildBreachIncidents, buildClocks, buildDataRequests, buildJobRuns, buildKpis, buildMessageLog, buildNotifications } from './demo.platform';
import { buildDiscomApplications, buildInstallations, buildLoans, buildSubsidyClaims, buildWarrantyTickets } from './demo.postsale';
import { buildQuotes } from './demo.quotes';
import { makeEnv } from './util';

/** The demo dataset (all fictional): depends on reference ids only. Every row carries an id from the `demo:` namespace. */
export function buildDemoSeed(now: Date = new Date()): SeedData {
  const env = makeEnv(now);
  const leads = buildLeadLayer(env);
  const quotes = buildQuotes(env);
  const orders = buildOrders(env, quotes, leads, quotes.approvals.length);
  const { serials, dispatchLinks } = buildSerials(env, quotes.quotes);
  return {
    profiles: buildProfiles(env),
    user_territories: buildUserTerritories(env),
    distributors: buildDistributors(env),
    dealers: buildDealers(env),
    vendor_registrations: buildVendorRegistrations(env),
    sop_cases: buildSopCases(env),
    distributor_score_history: buildScoreHistory(env),
    leads: leads.leads,
    lead_consents: leads.consents,
    lead_events: leads.events,
    lead_assignments: leads.assignments,
    followups: leads.followups,
    contact_logs: leads.contactLogs,
    dnd_register: leads.dnd,
    lead_scores: leads.scores,
    customers: leads.customers,
    sites: leads.sites,
    site_surveys: leads.surveys,
    opportunities: buildOpportunities(env),
    requirement_forms: buildRequirementForms(env, leads.sites),
    negotiation_logs: buildNegotiationLogs(env),
    skus: buildSkus(env),
    sku_compliance: buildSkuCompliance(env),
    sku_prices: buildSkuPrices(env),
    stock_batches: buildStockBatches(env),
    documents: quotes.documents,
    quotations: quotes.quotes,
    quotation_lines: quotes.lines,
    quote_discussions: quotes.discussions,
    approvals: [...quotes.approvals, ...orders.approvals],
    proforma_invoices: orders.pis,
    proforma_invoice_lines: orders.piLines,
    sales_orders: orders.salesOrders,
    sales_order_lines: orders.soLines,
    payments: orders.payments,
    credit_checks: orders.creditChecks,
    credit_overrides: orders.overrides,
    dispatches: orders.dispatches,
    inventory_serials: serials,
    dispatch_serials: dispatchLinks,
    einvoice_status: orders.einvoices,
    loans: buildLoans(env),
    installations: buildInstallations(env),
    discom_applications: buildDiscomApplications(env),
    subsidy_claims: buildSubsidyClaims(env),
    warranty_tickets: buildWarrantyTickets(env, serials),
    dealer_receivables: orders.receivables,
    clocks: buildClocks(env, leads),
    notifications: buildNotifications(env),
    message_log: buildMessageLog(env, leads),
    kpi_snapshots: buildKpis(env),
    audit_log: buildAuditLog(env),
    job_runs: buildJobRuns(env),
    breach_incidents: buildBreachIncidents(env),
    data_requests: buildDataRequests(env),
  };
}
