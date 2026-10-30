-- =====================================================================================================
-- 06_postsale_tables.sql
-- Purpose : post-sale lifecycle - loans, installations, DISCOM applications, subsidy (CFA) claims, warranty / RMA
--           tickets, dealer receivables.
-- Run after: 05_commercial_tables.sql
-- Idempotent: `create table if not exists` / `create ... index if not exists`.
--
-- Notes
--   * installations is created BEFORE discom_applications because discom_applications.installation_id references it.
--   * dealer_receivables.linked_project_id is polymorphic (opportunity / sales order / installation) and has no FK.
--   * dealer_receivables feeds credit exposure: outstanding = sum(amount - paid_amount) over status in (open, overdue).
--     It is the basis of gate G11 (sales-order guard in 08) and of the v_dealer_exposure view (10).
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- loans
-- -----------------------------------------------------------------------------------------------------
create table if not exists loans (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references organizations (id) on delete restrict,
  opportunity_id      uuid references opportunities (id) on delete set null,
  lead_id             uuid references leads (id) on delete set null,
  customer_id         uuid references customers (id) on delete set null,
  dealer_id           uuid references dealers (id) on delete set null,
  distributor_id      uuid references distributors (id) on delete set null,
  owner_id            uuid,
  bank                text not null,
  application_date    date,
  status              loan_status not null default 'draft',
  rejection_code      loan_rejection_code,
  amount              numeric(14,2),
  rate_pct            numeric(6,2),
  rate_source_date    date,
  co_applicant        text,
  document_checklist  jsonb not null default '{}'::jsonb,
  disbursed_at        timestamptz,
  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid
);
create index if not exists loans_org_status_idx   on loans (org_id, status);
create index if not exists loans_opportunity_idx  on loans (opportunity_id);
create index if not exists loans_customer_idx     on loans (customer_id);
create index if not exists loans_distributor_idx  on loans (distributor_id);
create index if not exists loans_dealer_idx       on loans (dealer_id);
create index if not exists loans_application_idx  on loans (org_id, application_date);

-- -----------------------------------------------------------------------------------------------------
-- installations
-- -----------------------------------------------------------------------------------------------------
create table if not exists installations (
  id                      uuid primary key default gen_random_uuid(),
  org_id                  uuid not null references organizations (id) on delete restrict,
  sales_order_id          uuid not null references sales_orders (id) on delete restrict,
  site_id                 uuid references sites (id) on delete set null,
  customer_id             uuid references customers (id) on delete set null,
  dealer_id               uuid references dealers (id) on delete set null,
  distributor_id          uuid references distributors (id) on delete set null,
  vendor_registration_id  uuid references vendor_registrations (id) on delete set null,
  installer_name          text,
  status                  installation_status not null default 'planned',
  install_date            date,
  certificate_at          timestamptz,
  photos                  jsonb not null default '[]'::jsonb,       -- [{ path, lat, lng, taken_at }]
  agreement_status        agreement_status not null default 'pending',
  regulation_version      text,
  no_connectivity_agreement boolean not null default false,
  commissioned_at         timestamptz,
  warranty_end            date,
  om_end                  date,
  kw                      numeric(10,3),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  created_by              uuid
);
create index if not exists installations_so_idx           on installations (org_id, sales_order_id);
create index if not exists installations_org_status_idx   on installations (org_id, status);
create index if not exists installations_distributor_idx  on installations (distributor_id);
create index if not exists installations_dealer_idx       on installations (dealer_id);
create index if not exists installations_warranty_idx     on installations (org_id, warranty_end);

-- -----------------------------------------------------------------------------------------------------
-- discom_applications  (net-metering / feasibility / commissioning with the DISCOM)
-- -----------------------------------------------------------------------------------------------------
create table if not exists discom_applications (
  id                        uuid primary key default gen_random_uuid(),
  org_id                    uuid not null references organizations (id) on delete restrict,
  sales_order_id            uuid references sales_orders (id) on delete set null,
  installation_id           uuid references installations (id) on delete set null deferrable initially deferred,
  site_id                   uuid references sites (id) on delete set null,
  customer_id               uuid references customers (id) on delete set null,
  discom_id                 uuid references discoms (id) on delete set null,
  dealer_id                 uuid references dealers (id) on delete set null,
  distributor_id            uuid references distributors (id) on delete set null,
  application_no            text,
  applied_kw                numeric(10,3) not null,
  submitted_at              timestamptz,
  complete_at               timestamptz,
  feasibility_due_at        timestamptz,
  feasibility_status        feasibility_status not null default 'pending',
  inspection_at             timestamptz,
  meter_type                text,
  meter_at                  timestamptz,
  certificate_submitted_at  timestamptz,
  commissioning_due_at      timestamptz,
  commissioning_at          timestamptz,
  agreement_status          agreement_status not null default 'pending',
  regulation_version        text,
  deemed_breach             boolean not null default false,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  created_by                uuid
);
create index if not exists discom_applications_org_discom_idx on discom_applications (org_id, discom_id);
create index if not exists discom_applications_so_idx         on discom_applications (sales_order_id);
create index if not exists discom_applications_install_idx    on discom_applications (installation_id);
create index if not exists discom_applications_feas_due_idx   on discom_applications (feasibility_due_at) where feasibility_status = 'pending';
create index if not exists discom_applications_comm_due_idx   on discom_applications (commissioning_due_at) where commissioning_at is null;
create index if not exists discom_applications_distributor_idx on discom_applications (distributor_id);
create index if not exists discom_applications_dealer_idx     on discom_applications (dealer_id);

-- -----------------------------------------------------------------------------------------------------
-- subsidy_claims  (PM Surya Ghar CFA claims)
-- -----------------------------------------------------------------------------------------------------
create table if not exists subsidy_claims (
  id                          uuid primary key default gen_random_uuid(),
  org_id                      uuid not null references organizations (id) on delete restrict,
  sales_order_id              uuid references sales_orders (id) on delete set null,
  installation_id             uuid references installations (id) on delete set null deferrable initially deferred,
  opportunity_id              uuid references opportunities (id) on delete set null,
  customer_id                 uuid references customers (id) on delete set null,
  dealer_id                   uuid references dealers (id) on delete set null,
  distributor_id              uuid references distributors (id) on delete set null,
  status                      subsidy_status not null default 'not_ready',
  cohort                      subsidy_cohort not null default 'current',
  cfa_computed                numeric(14,2) not null default 0,
  state_share                 numeric(14,2) not null default 0,
  bank_proof_ok               boolean not null default false,
  photos_ok                   boolean not null default false,
  inspection_ok               boolean not null default false,
  e_token                     text,
  discom_approval_at          timestamptz,
  claim_at                    timestamptz,
  released_at                 timestamptz,
  rejection_reason            text,
  state_share_due_at          timestamptz,
  state_share_received_at     timestamptz,
  claim_deadline              date,
  grievance_raised_at         timestamptz,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  created_by                  uuid
);
create index if not exists subsidy_claims_org_status_idx   on subsidy_claims (org_id, status, cohort);
create index if not exists subsidy_claims_so_idx           on subsidy_claims (sales_order_id);
create index if not exists subsidy_claims_deadline_idx     on subsidy_claims (org_id, claim_deadline) where status in ('not_ready', 'ready', 'claimed');
create index if not exists subsidy_claims_distributor_idx  on subsidy_claims (distributor_id);
create index if not exists subsidy_claims_dealer_idx       on subsidy_claims (dealer_id);

-- -----------------------------------------------------------------------------------------------------
-- warranty_tickets  (warranty / RMA / O&M / complaints)
-- -----------------------------------------------------------------------------------------------------
create table if not exists warranty_tickets (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organizations (id) on delete restrict,
  ticket_no         text not null,
  serial_id         uuid references inventory_serials (id) on delete set null,
  sales_order_id    uuid references sales_orders (id) on delete set null,
  installation_id   uuid references installations (id) on delete set null,
  customer_id       uuid references customers (id) on delete set null,
  dealer_id         uuid references dealers (id) on delete set null,
  type              text not null default 'warranty' check (type in ('warranty', 'rma', 'om_visit', 'complaint')),
  issue             text not null,
  brand_claim_no    text,
  cost_bearer       text not null default 'unknown' check (cost_bearer in ('distributor', 'dealer', 'brand', 'consumer', 'unknown')),
  status            warranty_status not null default 'open',
  opened_at         timestamptz not null default now(),
  rma_due_at        timestamptz,
  closed_at         timestamptz,
  recovered_amount  numeric(14,2) not null default 0,
  owner_id          uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid
);
create unique index if not exists warranty_tickets_org_ticket_no_uq on warranty_tickets (org_id, ticket_no);
create index if not exists warranty_tickets_org_status_idx on warranty_tickets (org_id, status);
create index if not exists warranty_tickets_dealer_idx     on warranty_tickets (dealer_id);
create index if not exists warranty_tickets_serial_idx     on warranty_tickets (serial_id);
create index if not exists warranty_tickets_rma_due_idx    on warranty_tickets (rma_due_at) where closed_at is null;

-- -----------------------------------------------------------------------------------------------------
-- dealer_receivables  (open invoices owed by dealers; drives credit exposure and ageing)
-- -----------------------------------------------------------------------------------------------------
create table if not exists dealer_receivables (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references organizations (id) on delete restrict,
  dealer_id          uuid not null references dealers (id) on delete restrict,
  distributor_id     uuid references distributors (id) on delete set null,
  doc_ref            text not null,
  amount             numeric(14,2) not null,
  paid_amount        numeric(14,2) not null default 0 check (paid_amount >= 0),
  invoice_date       date not null,
  due_date           date not null,
  subsidy_linked     boolean not null default false,
  linked_project_id  uuid,
  status             receivable_status not null default 'open',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  created_by         uuid
);
create index if not exists dealer_receivables_dealer_idx      on dealer_receivables (org_id, dealer_id, status);
create index if not exists dealer_receivables_distributor_idx on dealer_receivables (distributor_id);
create index if not exists dealer_receivables_due_idx         on dealer_receivables (org_id, due_date) where status in ('open', 'overdue');
create index if not exists dealer_receivables_invoice_idx     on dealer_receivables (dealer_id, invoice_date);
