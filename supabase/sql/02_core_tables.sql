-- =====================================================================================================
-- 02_core_tables.sql
-- Purpose : identity and organisation (organizations, profiles, discoms, territories, user_territories,
--           pincodes) and the channel parties (distributors, dealers, vendor_registrations, sop_cases,
--           distributor_score_history).
-- Run after: 01_extensions_enums.sql
-- Idempotent: `create table if not exists` / `create ... index if not exists`.
--
-- SCHEMA CONVENTIONS (apply to files 02 - 07)
--   * Column names, nullability and types mirror packages/shared/src/rows.ts exactly (`npm run check:sql`
--     enforces this). `T | null` in rows.ts = nullable column; everything else is NOT NULL, with a DEFAULT
--     wherever the API may legitimately omit the value on insert.
--   * Every table: id uuid primary key default gen_random_uuid(); org_id -> organizations(id);
--     created_at / updated_at where rows.ts has them (the four immutable ledgers have created_at only).
--   * created_by / updated_by / actor_id / uploaded_by / owner_id / approver_id ... (any column holding a
--     USER id) are plain uuid with NO foreign key: users live in Supabase Auth, demo users have no
--     auth.users row, and an FK would make deleting a user impossible.
--   * Real foreign keys between business tables use deliberate ON DELETE behaviour:
--       - parent -> owned child rows (lines, logs, follow-ups, scores)  : ON DELETE CASCADE
--       - reference to a party/master that can disappear (dealer, SKU)   : ON DELETE SET NULL (optional)
--                                                                          or RESTRICT (mandatory)
--       - rows that are legal/financial records (quotes, PIs, orders)     : RESTRICT (history is never lost)
--       - append-only ledgers (audit_log, lead_events, message_log,
--         distributor_score_history) : RESTRICT, because the immutability triggers forbid the
--         UPDATE/DELETE that CASCADE or SET NULL would perform.
--   * Every FK that points at a table appearing LATER in TABLE_NAMES (packages/shared/src/enums.ts - the order the seed and the
--     in-memory store use) is DEFERRABLE INITIALLY DEFERRED, so a seed written in TABLE_NAMES order loads inside one transaction.
--     (The Supabase SQL editor runs a multi-statement script as one implicit transaction.)
--   * Forward / circular references are added later with
--       `alter table ... drop constraint if exists ...; alter table ... add constraint ...` (idempotent).
--   * Soft delete exists only where rows.ts has deleted_at (leads).
--   * Numeric conventions: money numeric(14,2); percentages numeric(6,2); kW numeric(10,3); quantities numeric(12,3).
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- organizations  (tenant root; single tenant today, multi-tenant ready)
-- -----------------------------------------------------------------------------------------------------
create table if not exists organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  legal_name  text not null,
  gstin       text,
  pan         text,
  address     jsonb,                                   -- { line1, line2?, city, district?, state, pincode }
  state       text not null default 'Gujarat',
  settings    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- -----------------------------------------------------------------------------------------------------
-- discoms  (Gujarat DISCOMs + licensees such as Torrent Power)
-- -----------------------------------------------------------------------------------------------------
create table if not exists discoms (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations (id) on delete restrict,
  code        text not null,
  name        text not null,
  state       text not null,
  kind        text not null default 'discom' check (kind in ('discom', 'licensee')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid
);
create unique index if not exists discoms_org_code_uq on discoms (org_id, code);

-- -----------------------------------------------------------------------------------------------------
-- territories  (sales territories; dsm_id is a user id, no FK)
-- -----------------------------------------------------------------------------------------------------
create table if not exists territories (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations (id) on delete restrict,
  name            text not null,
  state           text not null,
  district        text,
  pincode_ranges  jsonb not null default '[]'::jsonb,   -- [{ "from": "380001", "to": "380060" }]
  discom_id       uuid references discoms (id) on delete set null,
  dsm_id          uuid,
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid
);
create index if not exists territories_org_state_idx on territories (org_id, state, district);
create index if not exists territories_discom_idx on territories (discom_id);

-- -----------------------------------------------------------------------------------------------------
-- distributors
-- -----------------------------------------------------------------------------------------------------
create table if not exists distributors (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references organizations (id) on delete restrict,
  legal_name            text not null,
  trade_name            text,
  gstin                 text,
  pan                   text,
  contact_name          text,
  phone                 text,
  email                 text,
  address               jsonb,
  state                 text not null,
  city                  text,
  territory_ids         uuid[] not null default '{}',
  capacity_band_min_kw  numeric(10,3) not null default 0,
  capacity_band_max_kw  numeric(10,3) not null default 0,
  capability_tags       text[] not null default '{}',
  score                 numeric(6,2) not null default 50,
  status                party_status not null default 'onboarding',
  credit_days           integer not null default 0,
  credit_limit          numeric(14,2) not null default 0,
  rebate_slab_key       text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  created_by            uuid,
  constraint distributors_capacity_band_ck check (capacity_band_max_kw >= capacity_band_min_kw)
);
create index if not exists distributors_org_status_idx on distributors (org_id, status);
create index if not exists distributors_territory_gin on distributors using gin (territory_ids);
create index if not exists distributors_capability_gin on distributors using gin (capability_tags);

-- -----------------------------------------------------------------------------------------------------
-- dealers  (installers / resellers under a distributor)
-- -----------------------------------------------------------------------------------------------------
create table if not exists dealers (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references organizations (id) on delete restrict,
  distributor_id   uuid not null references distributors (id) on delete restrict,
  legal_name       text not null,
  trade_name       text,
  gstin            text,
  pan              text,
  contact_name     text,
  phone            text,
  email            text,
  territory_id     uuid references territories (id) on delete set null,
  city             text,
  district         text,
  state            text not null,
  credit_limit     numeric(14,2) not null default 0,
  security_type    text not null default 'none' check (security_type in ('pdc', 'bank_guarantee', 'cheque', 'none')),
  security_amount  numeric(14,2) not null default 0,
  status           party_status not null default 'onboarding',
  portal_status    portal_status not null default 'active',
  complaint_count  integer not null default 0,
  rebate_accrued   numeric(14,2) not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid
);
create index if not exists dealers_org_distributor_idx on dealers (org_id, distributor_id);
create index if not exists dealers_org_status_idx on dealers (org_id, status, portal_status);
create index if not exists dealers_territory_idx on dealers (territory_id);

-- -----------------------------------------------------------------------------------------------------
-- profiles  (application users)
--   id is a plain uuid primary key that EQUALS auth.users.id for real users. There is deliberately NO foreign
--   key to auth.users so demo / seeded profiles can exist without an Auth account. The first administrator is
--   created by signing up in Supabase Auth and inserting a profiles row with that user's UUID (see RUN_ORDER.md).
-- -----------------------------------------------------------------------------------------------------
create table if not exists profiles (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations (id) on delete restrict,
  full_name       text not null,
  email           text not null,
  phone           text,
  role            app_role not null default 'viewer',
  designation     text,
  distributor_id  uuid references distributors (id) on delete set null deferrable initially deferred,
  dealer_id       uuid references dealers (id) on delete set null deferrable initially deferred,
  territory_ids   uuid[] not null default '{}',
  reports_to      uuid,
  language        text not null default 'en' check (language in ('en', 'hi', 'gu')),
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid
);
comment on column profiles.id is 'Equals auth.users.id for real users. No FK to auth.users on purpose, so demo profiles can exist.';
create unique index if not exists profiles_org_email_uq on profiles (org_id, lower(email));
create index if not exists profiles_org_role_idx on profiles (org_id, role);
create index if not exists profiles_distributor_idx on profiles (distributor_id);
create index if not exists profiles_dealer_idx on profiles (dealer_id);
create index if not exists profiles_territory_gin on profiles using gin (territory_ids);

-- -----------------------------------------------------------------------------------------------------
-- user_territories  (explicit user <-> territory assignments)
-- -----------------------------------------------------------------------------------------------------
create table if not exists user_territories (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations (id) on delete restrict,
  user_id       uuid not null references profiles (id) on delete cascade,
  territory_id  uuid not null references territories (id) on delete cascade,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid
);
create unique index if not exists user_territories_user_territory_uq on user_territories (user_id, territory_id);
create index if not exists user_territories_org_idx on user_territories (org_id, territory_id);

-- -----------------------------------------------------------------------------------------------------
-- pincodes  (pincode -> city / district / DISCOM / territory)
-- -----------------------------------------------------------------------------------------------------
create table if not exists pincodes (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations (id) on delete restrict,
  pincode       text not null check (pincode ~ '^[1-9][0-9]{5}$'),
  city          text not null,
  district      text not null,
  state         text not null,
  discom_id     uuid references discoms (id) on delete set null,
  territory_id  uuid references territories (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid
);
create unique index if not exists pincodes_org_pincode_uq on pincodes (org_id, pincode);
create index if not exists pincodes_territory_idx on pincodes (territory_id);
create index if not exists pincodes_discom_idx on pincodes (discom_id);

-- -----------------------------------------------------------------------------------------------------
-- vendor_registrations  (PM Surya Ghar vendor registration of a distributor or dealer)
--   party_id is polymorphic (distributor or dealer, see party_type) so it carries no FK.
-- -----------------------------------------------------------------------------------------------------
create table if not exists vendor_registrations (
  id                        uuid primary key default gen_random_uuid(),
  org_id                    uuid not null references organizations (id) on delete restrict,
  party_type                text not null check (party_type in ('distributor', 'dealer')),
  party_id                  uuid not null,
  level                     vendor_level not null default 'state',
  portal_vendor_id          text,
  states                    text[] not null default '{}',
  districts                 text[] not null default '{}',
  bank_guarantee_amount     numeric(14,2) not null default 0,
  bank_guarantee_valid_till date,
  portal_status             portal_status not null default 'active',
  deactivated_from          date,
  deactivated_to            date,
  complaint_count           integer not null default 0,
  notes                     text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  created_by                uuid
);
create index if not exists vendor_registrations_party_idx on vendor_registrations (org_id, party_type, party_id);
create index if not exists vendor_registrations_status_idx on vendor_registrations (org_id, portal_status);
create index if not exists vendor_registrations_states_gin on vendor_registrations using gin (states);
create index if not exists vendor_registrations_districts_gin on vendor_registrations using gin (districts);

-- -----------------------------------------------------------------------------------------------------
-- sop_cases  (MNRE SOP complaint workflow against a dealer)
-- -----------------------------------------------------------------------------------------------------
create table if not exists sop_cases (
  id                       uuid primary key default gen_random_uuid(),
  org_id                   uuid not null references organizations (id) on delete restrict,
  dealer_id                uuid not null references dealers (id) on delete restrict,
  vendor_registration_id   uuid references vendor_registrations (id) on delete set null,
  complaint_ref            text not null,
  summary                  text,
  notice_at                timestamptz not null default now(),
  stage                    sop_stage not null default 'reply',
  reply_due_at             timestamptz,
  replied_at               timestamptz,
  reminder_at              timestamptz,
  show_cause_at            timestamptz,
  show_cause_due_at        timestamptz,
  deactivated_at           timestamptz,
  appeal_due_at            timestamptz,
  closed_at                timestamptz,
  outcome                  text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  created_by               uuid
);
create index if not exists sop_cases_org_stage_idx on sop_cases (org_id, stage);
create index if not exists sop_cases_dealer_idx on sop_cases (dealer_id);

-- -----------------------------------------------------------------------------------------------------
-- distributor_score_history  (IMMUTABLE ledger: insert only, created_at only - see 08 for the trigger)
-- -----------------------------------------------------------------------------------------------------
create table if not exists distributor_score_history (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations (id) on delete restrict,
  distributor_id  uuid not null references distributors (id) on delete restrict,
  score           numeric(6,2) not null,
  components      jsonb not null default '{}'::jsonb,
  computed_at     timestamptz not null default now(),
  created_at      timestamptz not null default now()
);
create index if not exists distributor_score_history_idx on distributor_score_history (org_id, distributor_id, computed_at desc);
