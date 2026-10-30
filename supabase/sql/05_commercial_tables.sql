-- =====================================================================================================
-- 05_commercial_tables.sql
-- Purpose : the commercial chain - documents, quotations (+ lines, discussions), approval rules and approvals,
--           proforma invoices (+ lines), sales orders (+ lines), payments, credit checks, credit overrides,
--           dispatches (+ serial links), e-invoice / e-way bill status.
-- Run after: 04_opportunity_catalogue.sql
-- Idempotent: `create table if not exists` / `create ... index if not exists`; forward FKs use drop-if-exists + add.
--
-- Notes
--   * documents is created FIRST so quotations / sales_orders / dispatches can reference it directly.
--   * proforma_invoices.sales_order_id <-> sales_orders.pi_id is circular. sales_orders.pi_id is a normal FK
--     (a sales order cannot exist without its PI); the back-reference proforma_invoices.sales_order_id is added at
--     the end of this file as DEFERRABLE INITIALLY DEFERRED, so a PI and its order can be written in either order
--     inside one transaction. Outside a transaction, insert the PI with sales_order_id = NULL and update it after.
--   * Guard triggers (08): sales_orders (gate G11 credit limit / deactivated dealer), dispatches (compliance gate).
--   * Money columns are numeric(14,2); all totals are plain rupees.
--   * Unique, organisation-scoped document numbers: (quote_no, version), pi_no, so_no, dispatch_no. All versions of a quote share one quote_no.
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- documents  (metadata for objects held in the private Storage buckets; uploaded_by is a user id, no FK)
-- -----------------------------------------------------------------------------------------------------
create table if not exists documents (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations (id) on delete restrict,
  entity_type  text not null,
  entity_id    text not null,
  bucket       document_bucket not null,
  path         text not null,
  doc_type     text not null default 'other',
  file_name    text not null,
  mime         text,
  size_bytes   bigint check (size_bytes is null or size_bytes >= 0),
  uploaded_by  uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid
);
create unique index if not exists documents_bucket_path_uq on documents (org_id, bucket, path);
create index if not exists documents_entity_idx on documents (org_id, entity_type, entity_id);
create index if not exists documents_type_idx   on documents (org_id, doc_type);

-- Forward FK from sites (file 03)
alter table sites drop constraint if exists sites_bill_doc_id_fkey;
alter table sites add  constraint sites_bill_doc_id_fkey foreign key (bill_doc_id) references documents (id) on delete set null deferrable initially deferred;

-- -----------------------------------------------------------------------------------------------------
-- quotations
-- -----------------------------------------------------------------------------------------------------
create table if not exists quotations (
  id                          uuid primary key default gen_random_uuid(),
  org_id                      uuid not null references organizations (id) on delete restrict,
  quote_no                    text not null,
  version                     integer not null default 1,
  parent_quote_id             uuid references quotations (id) on delete set null,
  opportunity_id              uuid not null references opportunities (id) on delete restrict,
  lead_id                     uuid references leads (id) on delete set null,
  customer_id                 uuid references customers (id) on delete set null,
  site_id                     uuid references sites (id) on delete set null,
  segment                     segment not null,
  kw                          numeric(10,3) not null default 0,
  expected_commissioning_date date,
  status                      quote_status not null default 'draft',
  validity_date               date not null,
  price_snapshot_at           timestamptz not null default now(),
  tax_position_approved       boolean not null default false,
  clause_keys                 text[] not null default '{}',
  place_of_supply             text,
  payment_terms               text,
  subtotal                    numeric(14,2) not null default 0,
  discount_pct                numeric(6,2) not null default 0,
  discount_amount             numeric(14,2) not null default 0,
  freight                     numeric(14,2) not null default 0,
  tax_total                   numeric(14,2) not null default 0,
  total                       numeric(14,2) not null default 0,
  margin_pct                  numeric(6,2),
  floor_check                 jsonb,                      -- { ok, lines: [...], margin_pct }
  cfa_entitlement             numeric(14,2) not null default 0,
  state_share                 numeric(14,2) not null default 0,
  loan_share                  numeric(14,2) not null default 0,
  consumer_share              numeric(14,2) not null default 0,
  cfa_breakdown               jsonb not null default '{}'::jsonb,
  loan_rate_pct               numeric(6,2),
  loan_rate_source_date       date,
  exemption_reliance          boolean not null default false,
  compliance_status           compliance_status not null default 'pending',
  compliance_findings         jsonb not null default '[]'::jsonb,   -- Finding[]
  compliance_evaluated_at     timestamptz,
  rule_ids_used               uuid[] not null default '{}',
  requote_reason              text,
  owner_id                    uuid,
  distributor_id              uuid references distributors (id) on delete set null,
  dealer_id                   uuid references dealers (id) on delete set null,
  territory_id                uuid references territories (id) on delete set null,
  sent_at                     timestamptz,
  accepted_at                 timestamptz,
  rejected_reason             text,
  pdf_document_id             uuid references documents (id) on delete set null deferrable initially deferred,
  terms_confirmed_at          timestamptz,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  created_by                  uuid
);
create unique index if not exists quotations_org_quote_no_uq on quotations (org_id, quote_no, version);
create index if not exists quotations_org_status_idx   on quotations (org_id, status);
create index if not exists quotations_opportunity_idx  on quotations (opportunity_id, version);
create index if not exists quotations_parent_idx       on quotations (parent_quote_id) where parent_quote_id is not null;
create index if not exists quotations_owner_idx        on quotations (org_id, owner_id);
create index if not exists quotations_distributor_idx  on quotations (distributor_id);
create index if not exists quotations_dealer_idx       on quotations (dealer_id);
create index if not exists quotations_territory_idx    on quotations (territory_id);
create index if not exists quotations_validity_idx     on quotations (org_id, validity_date) where status in ('sent', 'negotiation', 'approved');
create index if not exists quotations_compliance_idx   on quotations (org_id, compliance_status);
create index if not exists quotations_rule_ids_gin     on quotations using gin (rule_ids_used);
create index if not exists quotations_clause_keys_gin  on quotations using gin (clause_keys);

alter table inventory_serials drop constraint if exists inventory_serials_quote_id_fkey;
alter table inventory_serials add  constraint inventory_serials_quote_id_fkey foreign key (quote_id) references quotations (id) on delete set null deferrable initially deferred;

-- -----------------------------------------------------------------------------------------------------
-- quotation_lines
-- -----------------------------------------------------------------------------------------------------
create table if not exists quotation_lines (
  id                      uuid primary key default gen_random_uuid(),
  org_id                  uuid not null references organizations (id) on delete restrict,
  quote_id                uuid not null references quotations (id) on delete cascade,
  sku_id                  uuid references skus (id) on delete set null,
  description             text not null,
  hsn                     text,
  gst_rate                numeric(5,2),
  gst_as_of               date,
  tax_position_approved   boolean not null default false,
  tax_approved_by         uuid,
  qty                     numeric(12,3) not null default 1,
  uom                     text not null default 'nos',
  unit_price              numeric(14,2) not null default 0,
  discount_pct            numeric(6,2) not null default 0,
  line_total              numeric(14,2) not null default 0,
  price_id                uuid references sku_prices (id) on delete set null,
  sort_order              integer not null default 0,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  created_by              uuid
);
create index if not exists quotation_lines_quote_idx on quotation_lines (org_id, quote_id, sort_order);
create index if not exists quotation_lines_sku_idx   on quotation_lines (sku_id);

-- -----------------------------------------------------------------------------------------------------
-- quote_discussions
-- -----------------------------------------------------------------------------------------------------
create table if not exists quote_discussions (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organizations (id) on delete restrict,
  quote_id          uuid not null references quotations (id) on delete cascade,
  kind              text not null default 'call' check (kind in ('call', 'whatsapp', 'meeting', 'email')),
  outcome           text,
  notes             text,
  logged_by         uuid,
  logged_at         timestamptz not null default now(),
  next_followup_at  timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid
);
create index if not exists quote_discussions_quote_idx on quote_discussions (org_id, quote_id, logged_at desc);
create index if not exists quote_discussions_next_idx  on quote_discussions (next_followup_at) where next_followup_at is not null;

-- -----------------------------------------------------------------------------------------------------
-- approval_rules  (discount approval matrix: DSM -> Regional Head -> Management; compliance lane; credit lane)
-- -----------------------------------------------------------------------------------------------------
create table if not exists approval_rules (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations (id) on delete restrict,
  lane        approval_lane not null,
  name        text not null,
  min_value   numeric(14,2) not null default 0,
  max_value   numeric(14,2),
  role_chain  app_role[] not null default '{}',
  sla_hours   numeric(6,2) not null default 24,
  active      boolean not null default true,
  conditions  jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid
);
create index if not exists approval_rules_lane_idx on approval_rules (org_id, lane, active, min_value);
create index if not exists approval_rules_role_chain_gin on approval_rules using gin (role_chain);

-- -----------------------------------------------------------------------------------------------------
-- approvals  (polymorphic: entity_type + entity_id; no FK on entity_id)
-- -----------------------------------------------------------------------------------------------------
create table if not exists approvals (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations (id) on delete restrict,
  entity_type    approval_entity not null,
  entity_id      uuid not null,
  lane           approval_lane not null,
  step           integer not null default 1,
  required_role  app_role not null,
  approver_id    uuid,
  decision       approval_decision not null default 'pending',
  comment        text,
  decided_at     timestamptz,
  due_at         timestamptz,
  requested_by   uuid,
  requested_at   timestamptz not null default now(),
  meta           jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid
);
create index if not exists approvals_entity_idx   on approvals (org_id, entity_type, entity_id);
create index if not exists approvals_pending_idx  on approvals (org_id, decision, required_role, due_at);
create index if not exists approvals_approver_idx on approvals (approver_id) where approver_id is not null;

-- -----------------------------------------------------------------------------------------------------
-- proforma_invoices
-- -----------------------------------------------------------------------------------------------------
create table if not exists proforma_invoices (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references organizations (id) on delete restrict,
  pi_no               text not null,
  quote_id            uuid not null references quotations (id) on delete restrict,
  opportunity_id      uuid references opportunities (id) on delete set null,
  customer_id         uuid references customers (id) on delete set null,
  dealer_id           uuid references dealers (id) on delete set null,
  distributor_id      uuid references distributors (id) on delete set null,
  status              pi_status not null default 'draft',
  legal_name          text,
  gstin               text,
  billing_address     jsonb,
  shipping_address    jsonb,
  payment_terms       text,
  subtotal            numeric(14,2) not null default 0,
  freight             numeric(14,2) not null default 0,
  tax_total           numeric(14,2) not null default 0,
  total               numeric(14,2) not null default 0,
  consumer_share      numeric(14,2) not null default 0,
  loan_share          numeric(14,2) not null default 0,
  subsidy_receivable  numeric(14,2) not null default 0,
  pre_pi_checklist    jsonb not null default '{}'::jsonb,
  issue_date          date,
  valid_till          date,
  approved_by         uuid,
  issued_at           timestamptz,
  sales_order_id      uuid,                              -- deferrable FK to sales_orders added at the end of this file
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid
);
create unique index if not exists proforma_invoices_org_pi_no_uq on proforma_invoices (org_id, pi_no);
create index if not exists proforma_invoices_org_status_idx on proforma_invoices (org_id, status);
create index if not exists proforma_invoices_quote_idx      on proforma_invoices (quote_id);
create index if not exists proforma_invoices_distributor_idx on proforma_invoices (distributor_id);
create index if not exists proforma_invoices_dealer_idx     on proforma_invoices (dealer_id);
create index if not exists proforma_invoices_so_idx         on proforma_invoices (sales_order_id) where sales_order_id is not null;

-- -----------------------------------------------------------------------------------------------------
-- proforma_invoice_lines
-- -----------------------------------------------------------------------------------------------------
create table if not exists proforma_invoice_lines (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations (id) on delete restrict,
  pi_id        uuid not null references proforma_invoices (id) on delete cascade,
  sku_id       uuid references skus (id) on delete set null,
  description  text not null,
  hsn          text,
  gst_rate     numeric(5,2),
  qty          numeric(12,3) not null default 1,
  unit_price   numeric(14,2) not null default 0,
  line_total   numeric(14,2) not null default 0,
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid
);
create index if not exists proforma_invoice_lines_pi_idx on proforma_invoice_lines (org_id, pi_id, sort_order);

-- -----------------------------------------------------------------------------------------------------
-- sales_orders
-- -----------------------------------------------------------------------------------------------------
create table if not exists sales_orders (
  id                           uuid primary key default gen_random_uuid(),
  org_id                       uuid not null references organizations (id) on delete restrict,
  so_no                        text not null,
  pi_id                        uuid not null references proforma_invoices (id) on delete restrict,
  quote_id                     uuid not null references quotations (id) on delete restrict,
  opportunity_id               uuid references opportunities (id) on delete set null,
  customer_id                  uuid references customers (id) on delete set null,
  site_id                      uuid references sites (id) on delete set null,
  dealer_id                    uuid references dealers (id) on delete set null,
  distributor_id               uuid references distributors (id) on delete set null,
  territory_id                 uuid references territories (id) on delete set null,
  segment                      segment not null,
  status                       so_status not null default 'draft',
  customer_po_no               text,
  customer_po_date             date,
  po_document_id               uuid references documents (id) on delete set null deferrable initially deferred,
  hold_reason                  text,
  order_date                   date not null default current_date,
  total                        numeric(14,2) not null default 0,
  advance_received             numeric(14,2) not null default 0,
  credit_basis                 text check (credit_basis in ('advance', 'credit')),
  circulated_at                timestamptz,
  approved_by                  uuid,
  dispatch_handover_at         timestamptz,
  expected_commissioning_date  date,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),
  created_by                   uuid
);
create unique index if not exists sales_orders_org_so_no_uq on sales_orders (org_id, so_no);
create index if not exists sales_orders_org_status_idx   on sales_orders (org_id, status);
create index if not exists sales_orders_pi_idx           on sales_orders (pi_id);
create index if not exists sales_orders_quote_idx        on sales_orders (quote_id);
create index if not exists sales_orders_distributor_idx  on sales_orders (distributor_id);
create index if not exists sales_orders_dealer_idx       on sales_orders (dealer_id);
create index if not exists sales_orders_territory_idx    on sales_orders (territory_id);
create index if not exists sales_orders_segment_idx      on sales_orders (org_id, segment);

-- -----------------------------------------------------------------------------------------------------
-- sales_order_lines
-- -----------------------------------------------------------------------------------------------------
create table if not exists sales_order_lines (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations (id) on delete restrict,
  so_id          uuid not null references sales_orders (id) on delete cascade,
  sku_id         uuid references skus (id) on delete set null,
  description    text not null,
  hsn            text,
  gst_rate       numeric(5,2),
  qty            numeric(12,3) not null default 1,
  unit_price     numeric(14,2) not null default 0,
  line_total     numeric(14,2) not null default 0,
  qty_dispatched numeric(12,3) not null default 0,
  sort_order     integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid
);
create index if not exists sales_order_lines_so_idx  on sales_order_lines (org_id, so_id, sort_order);
create index if not exists sales_order_lines_sku_idx on sales_order_lines (sku_id);

-- -----------------------------------------------------------------------------------------------------
-- payments
-- -----------------------------------------------------------------------------------------------------
create table if not exists payments (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations (id) on delete restrict,
  pi_id           uuid references proforma_invoices (id) on delete set null,
  sales_order_id  uuid references sales_orders (id) on delete set null deferrable initially deferred,
  kind            payment_kind not null,
  amount          numeric(14,2) not null check (amount >= 0),
  mode            text not null default 'other',
  reference       text,
  received_at     timestamptz not null default now(),
  recorded_by     uuid,
  status          text not null default 'received' check (status in ('received', 'pending', 'bounced')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid
);
create index if not exists payments_pi_idx     on payments (org_id, pi_id);
create index if not exists payments_so_idx     on payments (org_id, sales_order_id);
create index if not exists payments_status_idx on payments (org_id, status, received_at desc);

-- -----------------------------------------------------------------------------------------------------
-- credit_checks
-- -----------------------------------------------------------------------------------------------------
create table if not exists credit_checks (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations (id) on delete restrict,
  pi_id           uuid references proforma_invoices (id) on delete set null,
  sales_order_id  uuid references sales_orders (id) on delete set null deferrable initially deferred,
  dealer_id       uuid references dealers (id) on delete set null,
  distributor_id  uuid references distributors (id) on delete set null,
  basis           text not null default 'advance' check (basis in ('advance', 'credit')),
  result          credit_result not null default 'pending',
  credit_limit    numeric(14,2) not null default 0,
  outstanding     numeric(14,2) not null default 0,
  ageing          jsonb not null default '{"current": 0, "d1_30": 0, "d31_60": 0, "d61_90": 0, "d90_plus": 0}'::jsonb,
  subsidy_linked  numeric(14,2) not null default 0,
  bg_valid        boolean,
  portal_status   portal_status,
  notes           text,
  decided_by      uuid,
  decided_at      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid
);
create index if not exists credit_checks_pi_idx          on credit_checks (org_id, pi_id);
create index if not exists credit_checks_dealer_idx      on credit_checks (dealer_id, result);
create index if not exists credit_checks_distributor_idx on credit_checks (distributor_id);
create index if not exists credit_checks_so_idx          on credit_checks (sales_order_id);

-- -----------------------------------------------------------------------------------------------------
-- credit_overrides  (an APPROVED row lets gate G11 pass for that dealer / PI)
-- -----------------------------------------------------------------------------------------------------
create table if not exists credit_overrides (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations (id) on delete restrict,
  dealer_id       uuid not null references dealers (id) on delete restrict,
  pi_id           uuid references proforma_invoices (id) on delete set null,
  sales_order_id  uuid references sales_orders (id) on delete set null deferrable initially deferred,
  reason          text not null,
  status          text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  requested_by    uuid,
  approved_by     uuid,
  approved_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid
);
create index if not exists credit_overrides_dealer_idx on credit_overrides (org_id, dealer_id, status);
create index if not exists credit_overrides_pi_idx     on credit_overrides (pi_id) where pi_id is not null;

-- -----------------------------------------------------------------------------------------------------
-- dispatches  (+ serial links)
-- -----------------------------------------------------------------------------------------------------
create table if not exists dispatches (
  id                        uuid primary key default gen_random_uuid(),
  org_id                    uuid not null references organizations (id) on delete restrict,
  dispatch_no               text not null,
  so_id                     uuid not null references sales_orders (id) on delete restrict,
  status                    dispatch_status not null default 'planned',
  planned_at                timestamptz,
  dispatched_at             timestamptz,
  vehicle_no                text,
  transporter               text,
  ewb_no                    text,
  ewb_status                einvoice_state not null default 'not_required',
  invoice_no                text,
  invoice_chain             jsonb not null default '[]'::jsonb,
  compliance_status         compliance_status not null default 'pending',
  compliance_findings       jsonb not null default '[]'::jsonb,
  dispatch_note_document_id uuid references documents (id) on delete set null deferrable initially deferred,
  ship_to                   jsonb,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  created_by                uuid
);
create unique index if not exists dispatches_org_dispatch_no_uq on dispatches (org_id, dispatch_no);
create index if not exists dispatches_so_idx          on dispatches (org_id, so_id);
create index if not exists dispatches_org_status_idx  on dispatches (org_id, status);
create index if not exists dispatches_planned_idx     on dispatches (org_id, planned_at);

create table if not exists dispatch_serials (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations (id) on delete restrict,
  dispatch_id  uuid not null references dispatches (id) on delete cascade,
  serial_id    uuid not null references inventory_serials (id) on delete restrict,
  so_line_id   uuid references sales_order_lines (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid
);
create unique index if not exists dispatch_serials_dispatch_serial_uq on dispatch_serials (dispatch_id, serial_id);
create index if not exists dispatch_serials_org_idx    on dispatch_serials (org_id, dispatch_id);
create index if not exists dispatch_serials_serial_idx on dispatch_serials (serial_id);
create index if not exists dispatch_serials_line_idx   on dispatch_serials (so_line_id) where so_line_id is not null;

-- -----------------------------------------------------------------------------------------------------
-- einvoice_status  (IRN / e-way bill tracking; polymorphic entity_type + entity_id)
-- -----------------------------------------------------------------------------------------------------
create table if not exists einvoice_status (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations (id) on delete restrict,
  entity_type  text not null check (entity_type in ('dispatch', 'proforma_invoice')),
  entity_id    uuid not null,
  irn          text,
  ack_no       text,
  ack_date     timestamptz,
  status       einvoice_state not null default 'not_required',
  provider     text not null default 'mock',
  payload      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid
);
create index if not exists einvoice_status_entity_idx on einvoice_status (org_id, entity_type, entity_id);
create index if not exists einvoice_status_status_idx on einvoice_status (org_id, status);

-- -----------------------------------------------------------------------------------------------------
-- Forward / circular foreign keys (idempotent: drop-if-exists then add)
-- -----------------------------------------------------------------------------------------------------
alter table proforma_invoices drop constraint if exists proforma_invoices_sales_order_id_fkey;
alter table proforma_invoices add  constraint proforma_invoices_sales_order_id_fkey
  foreign key (sales_order_id) references sales_orders (id) on delete set null deferrable initially deferred;

alter table inventory_serials drop constraint if exists inventory_serials_sales_order_id_fkey;
alter table inventory_serials add  constraint inventory_serials_sales_order_id_fkey foreign key (sales_order_id) references sales_orders (id) on delete set null deferrable initially deferred;
alter table inventory_serials drop constraint if exists inventory_serials_sales_order_line_id_fkey;
alter table inventory_serials add  constraint inventory_serials_sales_order_line_id_fkey foreign key (sales_order_line_id) references sales_order_lines (id) on delete set null deferrable initially deferred;
alter table inventory_serials drop constraint if exists inventory_serials_dispatch_id_fkey;
alter table inventory_serials add  constraint inventory_serials_dispatch_id_fkey foreign key (dispatch_id) references dispatches (id) on delete set null deferrable initially deferred;
