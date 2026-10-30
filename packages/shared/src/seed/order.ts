import { TABLE_NAMES, type TableName } from '../enums';

/**
 * FK-safe insert order for every table (parents before children). The three circular references are broken by DEFERRED_COLUMNS:
 * those columns are inserted as NULL and patched with an UPDATE once the referenced table is loaded.
 */
export const INSERT_ORDER: readonly TableName[] = [
  // reference data
  'organizations', 'discoms', 'rule_config', 'message_templates', 'compliance_calendar_items', 'verify_register', 'gate_applicability', 'approval_rules', 'segment_form_config', 'pincodes',
  // parties and people
  'distributors', 'territories', 'dealers', 'profiles', 'user_territories', 'vendor_registrations', 'sop_cases', 'distributor_score_history',
  // leads, customers, sites, opportunities
  'leads', 'customers', 'sites', 'opportunities', 'site_surveys', 'requirement_forms', 'negotiation_logs',
  'lead_consents', 'lead_events', 'lead_assignments', 'followups', 'contact_logs', 'dnd_register', 'lead_scores', 'source_api_keys',
  // catalogue and stock (serials come after orders and dispatches, which they reference)
  'skus', 'sku_compliance', 'sku_prices', 'stock_batches', 'documents',
  // quotes and approvals
  'quotations', 'quotation_lines', 'quote_discussions', 'approvals',
  // PI, payment, credit, orders, dispatch
  'proforma_invoices', 'proforma_invoice_lines', 'sales_orders', 'sales_order_lines', 'payments', 'credit_checks', 'credit_overrides',
  'dispatches', 'inventory_serials', 'dispatch_serials', 'einvoice_status',
  // post-sale
  'loans', 'installations', 'discom_applications', 'subsidy_claims', 'warranty_tickets', 'dealer_receivables',
  // platform
  'clocks', 'notifications', 'message_log', 'kpi_snapshots', 'audit_log', 'job_runs', 'breach_incidents', 'data_requests',
];

/** Tables whose rows are production-safe reference data (never removed by 99_delete_demo_data.sql). */
export const REFERENCE_TABLES: readonly TableName[] = [
  'organizations', 'discoms', 'rule_config', 'message_templates', 'compliance_calendar_items', 'verify_register', 'gate_applicability', 'approval_rules', 'segment_form_config', 'pincodes', 'territories', 'distributors', 'skus', 'sku_compliance', 'sku_prices',
];

/** Columns inserted as NULL first and patched afterwards, because the referenced row is inserted later (circular references). */
export const DEFERRED_COLUMNS: readonly { table: TableName; column: string; after: TableName }[] = [
  { table: 'leads', column: 'customer_id', after: 'customers' },
  { table: 'leads', column: 'site_id', after: 'sites' },
  { table: 'proforma_invoices', column: 'sales_order_id', after: 'sales_orders' },
];

/** Sanity check used by tests: INSERT_ORDER lists every table exactly once. */
export function insertOrderIsComplete(): boolean {
  return INSERT_ORDER.length === TABLE_NAMES.length && TABLE_NAMES.every((t) => INSERT_ORDER.includes(t)) && new Set(INSERT_ORDER).size === INSERT_ORDER.length;
}
