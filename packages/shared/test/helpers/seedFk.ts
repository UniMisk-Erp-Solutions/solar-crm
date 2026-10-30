import type { TableName } from '../../src/enums';

/**
 * Explicit foreign-key map for the seed: table → column → referenced table. Maintained by hand on purpose, so a new column or
 * table in the seed must be added here (the "every table is covered" test fails otherwise).
 * Columns holding a USER id (created_by, owner_id, …) are listed in USER_COLUMNS and checked against profiles.
 */
export const FK: Partial<Record<TableName, Record<string, TableName>>> = {
  discoms: {},
  territories: { discom_id: 'discoms' },
  user_territories: { user_id: 'profiles', territory_id: 'territories' },
  pincodes: { discom_id: 'discoms' },
  distributors: {},
  dealers: { distributor_id: 'distributors', territory_id: 'territories' },
  profiles: { distributor_id: 'distributors', dealer_id: 'dealers' },
  sop_cases: { dealer_id: 'dealers', vendor_registration_id: 'vendor_registrations' },
  distributor_score_history: { distributor_id: 'distributors' },
  leads: { distributor_id: 'distributors', dealer_id: 'dealers', territory_id: 'territories', customer_id: 'customers', site_id: 'sites', locked_by_dealer_id: 'dealers', duplicate_of: 'leads' },
  lead_consents: { lead_id: 'leads' },
  lead_events: { lead_id: 'leads' },
  lead_assignments: { lead_id: 'leads', distributor_id: 'distributors', dealer_id: 'dealers' },
  followups: { lead_id: 'leads' },
  contact_logs: { lead_id: 'leads' },
  lead_scores: { lead_id: 'leads' },
  customers: { lead_id: 'leads' },
  sites: { customer_id: 'customers', lead_id: 'leads', discom_id: 'discoms', bill_doc_id: 'documents' },
  site_surveys: { site_id: 'sites', lead_id: 'leads', opportunity_id: 'opportunities' },
  opportunities: { lead_id: 'leads', customer_id: 'customers', site_id: 'sites', distributor_id: 'distributors', dealer_id: 'dealers', territory_id: 'territories' },
  requirement_forms: { lead_id: 'leads', opportunity_id: 'opportunities', site_id: 'sites' },
  negotiation_logs: { lead_id: 'leads', opportunity_id: 'opportunities' },
  sku_compliance: { sku_id: 'skus' },
  sku_prices: { sku_id: 'skus' },
  stock_batches: { sku_id: 'skus' },
  inventory_serials: { sku_id: 'skus', batch_id: 'stock_batches', quote_id: 'quotations', sales_order_id: 'sales_orders', sales_order_line_id: 'sales_order_lines', dispatch_id: 'dispatches', site_id: 'sites' },
  quotations: { parent_quote_id: 'quotations', opportunity_id: 'opportunities', lead_id: 'leads', customer_id: 'customers', site_id: 'sites', distributor_id: 'distributors', dealer_id: 'dealers', territory_id: 'territories', pdf_document_id: 'documents' },
  quotation_lines: { quote_id: 'quotations', sku_id: 'skus', price_id: 'sku_prices' },
  quote_discussions: { quote_id: 'quotations' },
  proforma_invoices: { quote_id: 'quotations', opportunity_id: 'opportunities', customer_id: 'customers', dealer_id: 'dealers', distributor_id: 'distributors', sales_order_id: 'sales_orders' },
  proforma_invoice_lines: { pi_id: 'proforma_invoices', sku_id: 'skus' },
  payments: { pi_id: 'proforma_invoices', sales_order_id: 'sales_orders' },
  credit_checks: { pi_id: 'proforma_invoices', sales_order_id: 'sales_orders', dealer_id: 'dealers', distributor_id: 'distributors' },
  credit_overrides: { dealer_id: 'dealers', pi_id: 'proforma_invoices', sales_order_id: 'sales_orders' },
  sales_orders: { pi_id: 'proforma_invoices', quote_id: 'quotations', opportunity_id: 'opportunities', customer_id: 'customers', site_id: 'sites', dealer_id: 'dealers', distributor_id: 'distributors', territory_id: 'territories', po_document_id: 'documents' },
  sales_order_lines: { so_id: 'sales_orders', sku_id: 'skus' },
  dispatches: { so_id: 'sales_orders', dispatch_note_document_id: 'documents' },
  dispatch_serials: { dispatch_id: 'dispatches', serial_id: 'inventory_serials', so_line_id: 'sales_order_lines' },
  loans: { opportunity_id: 'opportunities', lead_id: 'leads', customer_id: 'customers', dealer_id: 'dealers', distributor_id: 'distributors' },
  installations: { sales_order_id: 'sales_orders', site_id: 'sites', customer_id: 'customers', dealer_id: 'dealers', distributor_id: 'distributors', vendor_registration_id: 'vendor_registrations' },
  discom_applications: { sales_order_id: 'sales_orders', installation_id: 'installations', site_id: 'sites', customer_id: 'customers', discom_id: 'discoms', dealer_id: 'dealers', distributor_id: 'distributors' },
  subsidy_claims: { sales_order_id: 'sales_orders', installation_id: 'installations', opportunity_id: 'opportunities', customer_id: 'customers', dealer_id: 'dealers', distributor_id: 'distributors' },
  warranty_tickets: { serial_id: 'inventory_serials', sales_order_id: 'sales_orders', installation_id: 'installations', customer_id: 'customers', dealer_id: 'dealers' },
  dealer_receivables: { dealer_id: 'dealers', distributor_id: 'distributors' },
  message_log: { lead_id: 'leads', consent_id: 'lead_consents' },
  data_requests: { lead_id: 'leads', customer_id: 'customers' },
};

/** Columns that hold a user (profile) id. Plain uuid in SQL (no FK), but they must still point at a seeded profile. */
export const USER_COLUMNS: readonly string[] = [
  'created_by', 'updated_by', 'owner_id', 'dsm_id', 'reports_to', 'assigned_to', 'logged_by', 'uploaded_by', 'recorded_by', 'decided_by', 'requested_by', 'approver_id', 'approved_by',
  'tax_approved_by', 'surveyor_id', 'verified_by', 'actor_id', 'completed_by', 'withdrawn_by',
];

/** Array columns whose elements are foreign keys. */
export const FK_ARRAYS: Partial<Record<TableName, Record<string, TableName>>> = {
  profiles: { territory_ids: 'territories' },
  distributors: { territory_ids: 'territories' },
  quotations: { rule_ids_used: 'rule_config' },
};

/** Polymorphic references: the table is chosen by another column. */
export const POLYMORPHIC: { table: TableName; typeColumn: string; idColumn: string; map: Record<string, TableName> }[] = [
  { table: 'vendor_registrations', typeColumn: 'party_type', idColumn: 'party_id', map: { distributor: 'distributors', dealer: 'dealers' } },
  { table: 'approvals', typeColumn: 'entity_type', idColumn: 'entity_id', map: { quotation: 'quotations', proforma_invoice: 'proforma_invoices', sales_order: 'sales_orders', credit_override: 'credit_overrides' } },
  { table: 'einvoice_status', typeColumn: 'entity_type', idColumn: 'entity_id', map: { dispatch: 'dispatches', proforma_invoice: 'proforma_invoices' } },
  { table: 'documents', typeColumn: 'entity_type', idColumn: 'entity_id', map: { quotation: 'quotations' } },
  {
    table: 'clocks', typeColumn: 'entity_type', idColumn: 'entity_id',
    map: { lead: 'leads', quotation: 'quotations', site_survey: 'site_surveys', installation: 'installations', subsidy_claim: 'subsidy_claims', opportunity: 'opportunities', sop_case: 'sop_cases', loan: 'loans', warranty_ticket: 'warranty_tickets', sales_order: 'sales_orders' },
  },
  {
    table: 'notifications', typeColumn: 'entity_type', idColumn: 'entity_id',
    map: { lead: 'leads', approval: 'quotations', dealer: 'dealers', subsidy_claim: 'subsidy_claims', sop_case: 'sop_cases', dispatch: 'dispatches', sales_order: 'sales_orders', quotation: 'quotations', calendar: 'compliance_calendar_items' },
  },
];

/** Enum-typed columns: table → column → allowed values (arrays are checked element by element). */
export type EnumMap = Partial<Record<TableName, Record<string, readonly string[]>>>;
