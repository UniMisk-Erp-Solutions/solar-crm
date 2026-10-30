-- =====================================================================================================
-- 04_opportunity_catalogue.sql
-- Purpose : opportunities (+ requirement forms, segment form configuration, negotiation log) and the product
--           catalogue / stock layer (skus, sku_compliance, sku_prices, stock_batches, inventory_serials).
-- Run after: 03_lead_tables.sql
-- Idempotent: `create table if not exists` / `create ... index if not exists`.
--
-- Notes
--   * An opportunity can only be created once requirement, timeline and commercial potential are all confirmed
--     (guard trigger in 08 + service-layer check).
--   * inventory_serials points at quotations / sales_orders / sales_order_lines / dispatches, which are created
--     in file 05; those foreign keys are added at the end of 05.
--   * site_surveys.opportunity_id (created in 03) gets its foreign key here.
--   * sku_compliance holds the ALMM List-I / List-II, DCR and BIS facts used by compliance gates G2-G6/G10;
--     serial rows carry a SNAPSHOT of those facts taken at receipt (compliance_snapshot).
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- opportunities
-- -----------------------------------------------------------------------------------------------------
create table if not exists opportunities (
  id                              uuid primary key default gen_random_uuid(),
  org_id                          uuid not null references organizations (id) on delete restrict,
  name                            text not null,
  lead_id                         uuid not null references leads (id) on delete restrict,
  customer_id                     uuid references customers (id) on delete set null,
  site_id                         uuid references sites (id) on delete set null,
  segment                         segment not null,
  kw                              numeric(10,3) not null,
  scheme_route                    scheme_route not null default 'other',
  funding_mix                     jsonb not null default '{"consumer_pct": 100, "loan_pct": 0, "subsidy_pct": 0}'::jsonb,
  probability                     numeric(6,2) not null default 10 check (probability >= 0 and probability <= 100),
  expected_value                  numeric(14,2) not null default 0,
  expected_close_date             date,
  expected_commissioning_date     date,
  competitor                      text,
  regulation_version              text,
  exemption_reliance              boolean not null default false,
  requirement_confirmed           boolean not null default false,
  timeline_confirmed              boolean not null default false,
  commercial_potential_confirmed  boolean not null default false,
  stage                           opportunity_stage not null default 'qualified',
  lost_reason                     text,
  owner_id                        uuid,
  distributor_id                  uuid references distributors (id) on delete set null,
  dealer_id                       uuid references dealers (id) on delete set null,
  territory_id                    uuid references territories (id) on delete set null,
  created_at                      timestamptz not null default now(),
  updated_at                      timestamptz not null default now(),
  created_by                      uuid
);
create index if not exists opportunities_org_stage_idx   on opportunities (org_id, stage);
create index if not exists opportunities_lead_idx        on opportunities (lead_id);
create index if not exists opportunities_owner_idx       on opportunities (org_id, owner_id);
create index if not exists opportunities_distributor_idx on opportunities (distributor_id);
create index if not exists opportunities_dealer_idx      on opportunities (dealer_id);
create index if not exists opportunities_territory_idx   on opportunities (territory_id);
create index if not exists opportunities_segment_idx     on opportunities (org_id, segment);
create index if not exists opportunities_close_idx       on opportunities (org_id, expected_close_date);

alter table site_surveys drop constraint if exists site_surveys_opportunity_id_fkey;
alter table site_surveys add  constraint site_surveys_opportunity_id_fkey foreign key (opportunity_id) references opportunities (id) on delete set null deferrable initially deferred;
create index if not exists site_surveys_opportunity_idx on site_surveys (opportunity_id) where opportunity_id is not null;

-- -----------------------------------------------------------------------------------------------------
-- requirement_forms  (segment-specific requirement capture)
-- -----------------------------------------------------------------------------------------------------
create table if not exists requirement_forms (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references organizations (id) on delete restrict,
  lead_id          uuid not null references leads (id) on delete cascade,
  opportunity_id   uuid references opportunities (id) on delete set null,
  site_id          uuid references sites (id) on delete set null,
  segment          segment not null,
  data             jsonb not null default '{}'::jsonb,
  completed_at     timestamptz,
  completed_by     uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid
);
create index if not exists requirement_forms_lead_idx on requirement_forms (org_id, lead_id);
create index if not exists requirement_forms_opp_idx  on requirement_forms (opportunity_id);

-- -----------------------------------------------------------------------------------------------------
-- segment_form_config  (versioned field definitions per segment)
-- -----------------------------------------------------------------------------------------------------
create table if not exists segment_form_config (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations (id) on delete restrict,
  segment     segment not null,
  version     integer not null default 1,
  fields      jsonb not null default '[]'::jsonb,    -- FormFieldDef[]
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid
);
create unique index if not exists segment_form_config_uq on segment_form_config (org_id, segment, version);

-- -----------------------------------------------------------------------------------------------------
-- negotiation_logs  (rate negotiation with the end customer)
-- -----------------------------------------------------------------------------------------------------
create table if not exists negotiation_logs (
  id                        uuid primary key default gen_random_uuid(),
  org_id                    uuid not null references organizations (id) on delete restrict,
  lead_id                   uuid not null references leads (id) on delete cascade,
  opportunity_id            uuid references opportunities (id) on delete set null,
  quoted_rate_per_kw        numeric(14,2),
  customer_counter_per_kw   numeric(14,2),
  notes                     text,
  logged_by                 uuid,
  logged_at                 timestamptz not null default now(),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  created_by                uuid
);
create index if not exists negotiation_logs_lead_idx on negotiation_logs (org_id, lead_id, logged_at desc);
create index if not exists negotiation_logs_opp_idx  on negotiation_logs (opportunity_id);

-- -----------------------------------------------------------------------------------------------------
-- skus
-- -----------------------------------------------------------------------------------------------------
create table if not exists skus (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations (id) on delete restrict,
  category        sku_category not null,
  make            text not null,
  model           text not null,
  variant         text,
  wattage         numeric(10,2),
  hsn             text,
  uom             text not null default 'nos',
  active          boolean not null default true,
  demo            boolean not null default false,        -- demo rows are removed by 99_delete_demo_data.sql
  description     text,
  warranty_years  numeric(5,1),
  brand_usp       jsonb,                                 -- { quality, warranty, certifications, service_support, delivery_reliability }
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid
);
create index if not exists skus_org_category_idx on skus (org_id, category, active);
create index if not exists skus_make_model_idx   on skus (org_id, make, model);
create index if not exists skus_demo_idx         on skus (org_id) where demo;

-- -----------------------------------------------------------------------------------------------------
-- sku_compliance  (one row per SKU)
-- -----------------------------------------------------------------------------------------------------
create table if not exists sku_compliance (
  id                      uuid primary key default gen_random_uuid(),
  org_id                  uuid not null references organizations (id) on delete restrict,
  sku_id                  uuid not null references skus (id) on delete cascade,
  almm_list1              boolean not null default false,
  almm_list1_ref          text,
  almm_list1_valid_till   date,
  almm_snapshot_date      date,
  cell_maker              text,
  almm_list2              boolean not null default false,
  dcr_verified            boolean not null default false,
  cell_origin             text,
  bis_licence_no          text,
  bis_licensed_model      text,
  bis_standard_no         text,
  bis_valid_till          date,
  inverter_kw             numeric(10,3),
  self_certified          boolean not null default false,
  thin_film               boolean not null default false,
  verified_by             uuid,
  verified_at             timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  created_by              uuid
);
create unique index if not exists sku_compliance_sku_uq on sku_compliance (sku_id);
create index if not exists sku_compliance_org_idx on sku_compliance (org_id, almm_list1, almm_list2, dcr_verified);

-- -----------------------------------------------------------------------------------------------------
-- sku_prices  (dated price snapshots with landed-cost components)
-- -----------------------------------------------------------------------------------------------------
create table if not exists sku_prices (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations (id) on delete restrict,
  sku_id          uuid not null references skus (id) on delete cascade,
  base_price      numeric(14,2) not null,
  valid_from      date not null default current_date,
  valid_to        date,
  landed_cost     jsonb not null default '{}'::jsonb,    -- { bcd, aidc, sws, adc, freight }
  source          text,
  snapshot_label  text,
  floor_price     numeric(14,2),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid,
  constraint sku_prices_validity_ck check (valid_to is null or valid_to >= valid_from)
);
create index if not exists sku_prices_sku_idx on sku_prices (org_id, sku_id, valid_from desc);

-- -----------------------------------------------------------------------------------------------------
-- stock_batches
-- -----------------------------------------------------------------------------------------------------
create table if not exists stock_batches (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations (id) on delete restrict,
  sku_id       uuid not null references skus (id) on delete restrict,
  batch_no     text not null,
  received_at  date not null default current_date,
  qty          numeric(12,3) not null default 0,
  supplier     text,
  origin       text not null default 'domestic' check (origin in ('import', 'domestic')),
  boe_no       text,
  unit_cost    numeric(14,2),
  location     text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid
);
create unique index if not exists stock_batches_sku_batch_uq on stock_batches (org_id, sku_id, batch_no);
create index if not exists stock_batches_received_idx on stock_batches (org_id, received_at desc);

-- -----------------------------------------------------------------------------------------------------
-- inventory_serials  (one row per physical serial-numbered unit)
-- -----------------------------------------------------------------------------------------------------
create table if not exists inventory_serials (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null references organizations (id) on delete restrict,
  serial                 text not null,
  sku_id                 uuid not null references skus (id) on delete restrict,
  batch_id               uuid references stock_batches (id) on delete set null,
  status                 serial_status not null default 'in_stock',
  quote_id               uuid,                           -- FK added in 05
  sales_order_id         uuid,                           -- FK added in 05
  sales_order_line_id    uuid,                           -- FK added in 05
  dispatch_id            uuid,                           -- FK added in 05
  site_id                uuid references sites (id) on delete set null,
  compliance_snapshot    jsonb not null default '{"almm_list1": false, "almm_list2": false, "dcr_verified": false, "bis_ok": false, "snapshot_date": null}'::jsonb,
  invoice_chain          jsonb not null default '[]'::jsonb,
  installed_at           timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  created_by             uuid
);
create unique index if not exists inventory_serials_serial_uq on inventory_serials (org_id, serial);
create index if not exists inventory_serials_sku_status_idx on inventory_serials (org_id, sku_id, status);
create index if not exists inventory_serials_batch_idx      on inventory_serials (batch_id);
create index if not exists inventory_serials_so_idx         on inventory_serials (sales_order_id) where sales_order_id is not null;
create index if not exists inventory_serials_dispatch_idx   on inventory_serials (dispatch_id) where dispatch_id is not null;
create index if not exists inventory_serials_quote_idx      on inventory_serials (quote_id) where quote_id is not null;
