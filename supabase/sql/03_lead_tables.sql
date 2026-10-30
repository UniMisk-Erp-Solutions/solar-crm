-- =====================================================================================================
-- 03_lead_tables.sql
-- Purpose : the lead layer (leads, lead_consents, lead_events, lead_assignments, followups, contact_logs,
--           dnd_register, lead_scores, source_api_keys) and the customer / site layer (customers, sites,
--           site_surveys).
-- Run after: 02_core_tables.sql
-- Idempotent: `create table if not exists` / `create ... index if not exists`.
--
-- Notes
--   * leads <-> customers <-> sites reference each other. leads is created first without the two forward FKs
--     (customer_id, site_id); they are added at the end of this file.
--   * sites.bill_doc_id -> documents and site_surveys.opportunity_id -> opportunities are added in files 05 / 04
--     (the referenced tables do not exist yet).
--   * lead_consents is a legal ledger: rows are immutable apart from the withdrawal fields (trigger in 08).
--   * lead_events is an append-only ledger (created_at only).
--   * leads.deleted_at is the only soft delete in the system.
--   * No Aadhaar number / image columns exist anywhere. customers.aadhaar_last4 holds the LAST FOUR DIGITS ONLY.
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- leads
-- -----------------------------------------------------------------------------------------------------
create table if not exists leads (
  id                      uuid primary key default gen_random_uuid(),
  org_id                  uuid not null references organizations (id) on delete restrict,
  source                  lead_source not null default 'manual',
  source_ref              text,
  source_detail           jsonb not null default '{}'::jsonb,
  notice_version          text,
  name                    text not null,
  mobile                  text not null,                       -- E.164 (+91XXXXXXXXXX); see app.normalize_mobile()
  email                   text,
  pincode                 text,
  city                    text,
  district                text,
  state                   text,
  segment                 segment,
  customer_type           customer_type,
  capacity_kw             numeric(10,3),
  product_interest        text[] not null default '{}',
  status                  lead_status not null default 'new',
  temperature             temperature,
  quality_score           numeric(6,2),
  owner_id                uuid,
  distributor_id          uuid references distributors (id) on delete set null,
  dealer_id               uuid references dealers (id) on delete set null,
  territory_id            uuid references territories (id) on delete set null,
  customer_id             uuid,                                -- FK added below (customers is created later in this file)
  site_id                 uuid,                                -- FK added below (sites is created later in this file)
  consumer_no             text,
  last_action             text,
  last_action_at          timestamptz,
  next_action             text,
  next_followup_at        timestamptz,
  assigned_at             timestamptz,
  accepted_at             timestamptz,
  sla_due_at              timestamptz,
  first_contacted_at      timestamptz,
  language                text not null default 'en' check (language in ('en', 'hi', 'gu')),
  lock_status             lock_status not null default 'open',
  locked_by_dealer_id     uuid references dealers (id) on delete set null,
  duplicate_of            uuid references leads (id) on delete set null,
  dnd_status              dnd_status not null default 'unchecked',
  dnd_checked_at          timestamptz,
  requirement_text        text,
  timeline_bucket         timeline_bucket,
  budget_inr              numeric(14,2),
  decision_maker          text check (decision_maker in ('self', 'family', 'committee', 'unknown')),
  decision_maker_access   boolean,
  bill_captured           boolean not null default false,
  nurture_until           date,
  nurture_reason          text,
  lost_reason             text,
  notes                   text,
  deadline_uplift         boolean not null default false,
  anonymised_at           timestamptz,
  deleted_at              timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  created_by              uuid
);
create index if not exists leads_org_status_idx        on leads (org_id, status) where deleted_at is null;
create index if not exists leads_org_created_idx       on leads (org_id, created_at desc) where deleted_at is null;
create index if not exists leads_owner_idx             on leads (org_id, owner_id) where deleted_at is null;
create index if not exists leads_distributor_idx       on leads (distributor_id) where deleted_at is null;
create index if not exists leads_dealer_idx            on leads (dealer_id) where deleted_at is null;
create index if not exists leads_territory_idx         on leads (territory_id) where deleted_at is null;
create index if not exists leads_next_followup_idx     on leads (next_followup_at) where deleted_at is null and next_followup_at is not null;
create index if not exists leads_sla_due_idx           on leads (sla_due_at) where deleted_at is null and accepted_at is null and sla_due_at is not null;
create index if not exists leads_org_mobile_idx        on leads (org_id, mobile);
create index if not exists leads_org_email_idx         on leads (org_id, lower(email)) where email is not null;
create index if not exists leads_org_consumer_no_idx   on leads (org_id, upper(consumer_no)) where consumer_no is not null;
create index if not exists leads_pincode_idx           on leads (org_id, pincode);
create index if not exists leads_segment_idx           on leads (org_id, segment);
create index if not exists leads_duplicate_of_idx      on leads (duplicate_of) where duplicate_of is not null;
create index if not exists leads_product_interest_gin  on leads using gin (product_interest);
create index if not exists leads_name_trgm_gin         on leads using gin (name extensions.gin_trgm_ops);
-- The full "live leads" partial index requested for list screens (soft-deleted rows excluded):
create index if not exists leads_live_idx              on leads (org_id, status, next_followup_at) where deleted_at is null;

-- -----------------------------------------------------------------------------------------------------
-- lead_consents  (DPDP / TRAI consent ledger; immutable except the withdrawal fields)
-- -----------------------------------------------------------------------------------------------------
create table if not exists lead_consents (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null references organizations (id) on delete restrict,
  lead_id                uuid not null references leads (id) on delete restrict,
  notice_version         text not null,
  purposes               consent_purpose[] not null default '{}',
  channels               consent_channel[] not null default '{}',
  recipients_named       text[] not null default '{}',
  granted_at             timestamptz not null default now(),
  ip                     text,
  user_agent             text,
  proof_ref              text,
  capture_source         text,
  withdrawn_at           timestamptz,
  withdrawn_by           uuid,
  withdrawal_channel     text,
  optout_suppress_until  timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  created_by             uuid
);
create index if not exists lead_consents_lead_idx        on lead_consents (org_id, lead_id);
create index if not exists lead_consents_active_idx      on lead_consents (lead_id) where withdrawn_at is null;
create index if not exists lead_consents_suppress_idx    on lead_consents (optout_suppress_until) where optout_suppress_until is not null;
create index if not exists lead_consents_purposes_gin    on lead_consents using gin (purposes);
create index if not exists lead_consents_channels_gin    on lead_consents using gin (channels);
create index if not exists lead_consents_recipients_gin  on lead_consents using gin (recipients_named);

-- -----------------------------------------------------------------------------------------------------
-- lead_events  (IMMUTABLE timeline: insert only, created_at only)
-- -----------------------------------------------------------------------------------------------------
create table if not exists lead_events (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations (id) on delete restrict,
  lead_id     uuid not null references leads (id) on delete restrict,
  event_type  text not null,
  summary     text not null,
  actor_id    uuid,
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists lead_events_lead_idx on lead_events (org_id, lead_id, created_at desc);
create index if not exists lead_events_type_idx on lead_events (org_id, event_type);

-- -----------------------------------------------------------------------------------------------------
-- lead_assignments  (allocation / escalation / reassignment history)
-- -----------------------------------------------------------------------------------------------------
create table if not exists lead_assignments (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations (id) on delete restrict,
  lead_id         uuid not null references leads (id) on delete cascade,
  distributor_id  uuid references distributors (id) on delete set null,
  dealer_id       uuid references dealers (id) on delete set null,
  assigned_to     uuid,
  step            text not null default 'auto' check (step in ('auto', 'manual', 'escalation', 'reassignment')),
  status          assignment_status not null default 'pending',
  reason          text,
  assigned_at     timestamptz not null default now(),
  due_at          timestamptz,
  responded_at    timestamptz,
  score_snapshot  jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid
);
create index if not exists lead_assignments_lead_idx        on lead_assignments (org_id, lead_id, assigned_at desc);
create index if not exists lead_assignments_distributor_idx on lead_assignments (distributor_id, status);
create index if not exists lead_assignments_dealer_idx      on lead_assignments (dealer_id);
create index if not exists lead_assignments_due_idx         on lead_assignments (due_at) where status = 'pending';

-- -----------------------------------------------------------------------------------------------------
-- followups
-- -----------------------------------------------------------------------------------------------------
create table if not exists followups (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organizations (id) on delete restrict,
  lead_id           uuid not null references leads (id) on delete cascade,
  kind              followup_kind not null default 'call',
  due_at            timestamptz not null,
  note              text,
  status            followup_status not null default 'open',
  done_at           timestamptz,
  owner_id          uuid,
  outcome           text,
  reminder_sent_at  timestamptz,
  escalated_level   integer not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid
);
create index if not exists followups_lead_idx   on followups (org_id, lead_id);
create index if not exists followups_due_idx    on followups (org_id, status, due_at);
create index if not exists followups_owner_idx  on followups (org_id, owner_id, status);

-- -----------------------------------------------------------------------------------------------------
-- contact_logs
-- -----------------------------------------------------------------------------------------------------
create table if not exists contact_logs (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations (id) on delete restrict,
  lead_id       uuid not null references leads (id) on delete cascade,
  channel       contact_channel not null,
  direction     text not null default 'outbound' check (direction in ('outbound', 'inbound')),
  outcome       contact_outcome not null,
  notes         text,
  duration_min  integer,
  occurred_at   timestamptz not null default now(),
  logged_by     uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid
);
create index if not exists contact_logs_lead_idx on contact_logs (org_id, lead_id, occurred_at desc);

-- -----------------------------------------------------------------------------------------------------
-- dnd_register  (hashed mobile numbers only - never the number itself)
--   Not unique on purpose: a re-scrub may insert a newer row; readers take the latest checked_at.
-- -----------------------------------------------------------------------------------------------------
create table if not exists dnd_register (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations (id) on delete restrict,
  mobile_hash  text not null,
  status       text not null check (status in ('clear', 'registered', 'blocked')),
  checked_at   timestamptz not null default now(),
  source       text not null default 'manual',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid
);
create index if not exists dnd_register_hash_idx on dnd_register (org_id, mobile_hash, checked_at desc);

-- -----------------------------------------------------------------------------------------------------
-- lead_scores  (quality score history; app.compute_lead_score() in 08 writes here)
-- -----------------------------------------------------------------------------------------------------
create table if not exists lead_scores (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations (id) on delete restrict,
  lead_id      uuid not null references leads (id) on delete cascade,
  score        numeric(6,2) not null,
  components   jsonb not null default '[]'::jsonb,         -- [{ key, label, weight, points, note }]
  computed_at  timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid
);
create index if not exists lead_scores_lead_idx on lead_scores (org_id, lead_id, computed_at desc);

-- -----------------------------------------------------------------------------------------------------
-- source_api_keys  (per-source ingestion keys; only the SHA-256 hash is stored)
-- -----------------------------------------------------------------------------------------------------
create table if not exists source_api_keys (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations (id) on delete restrict,
  source        lead_source not null,
  label         text not null,
  key_hash      text not null,
  key_prefix    text not null,
  active        boolean not null default true,
  last_used_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid
);
create unique index if not exists source_api_keys_hash_uq on source_api_keys (key_hash);
create index if not exists source_api_keys_org_idx on source_api_keys (org_id, source) where active;

-- -----------------------------------------------------------------------------------------------------
-- customers
-- -----------------------------------------------------------------------------------------------------
create table if not exists customers (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organizations (id) on delete restrict,
  legal_name        text not null,
  display_name      text,
  customer_type     customer_type,
  gstin             text,
  pan               text,
  email             text,
  phone             text,
  billing_address   jsonb,
  shipping_address  jsonb,
  state             text,
  lead_id           uuid references leads (id) on delete set null,
  aadhaar_last4     text check (aadhaar_last4 ~ '^[0-9]{4}$'),     -- last four digits ONLY; never a full Aadhaar number
  anonymised_at     timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid
);
create index if not exists customers_org_name_idx on customers (org_id, legal_name);
create index if not exists customers_lead_idx     on customers (lead_id);
create index if not exists customers_name_trgm    on customers using gin (legal_name extensions.gin_trgm_ops);

-- -----------------------------------------------------------------------------------------------------
-- sites  (the electricity connection / installation address)
-- -----------------------------------------------------------------------------------------------------
create table if not exists sites (
  id                      uuid primary key default gen_random_uuid(),
  org_id                  uuid not null references organizations (id) on delete restrict,
  customer_id             uuid references customers (id) on delete set null,
  lead_id                 uuid references leads (id) on delete set null,
  name_on_bill            text,
  applicant_name          text,
  name_match              boolean,
  consumer_no             text,
  discom_id               uuid references discoms (id) on delete set null,
  sanctioned_load_kw      numeric(10,3),
  contracted_demand_kva   numeric(10,3),
  phase                   text check (phase in ('single', 'three')),
  address                 jsonb,
  pincode                 text,
  city                    text,
  district                text,
  state                   text,
  lat                     numeric(9,6),
  lng                     numeric(9,6),
  roof_ownership          roof_ownership,
  title_ok                boolean,
  pending_dues            boolean not null default false,
  existing_solar_kw       numeric(10,3) not null default 0,
  category                site_category not null default 'general',
  special_category_state  boolean not null default false,
  roof_type               text,
  load_type               text,
  bill_doc_id             uuid,                                  -- FK to documents added in 05
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  created_by              uuid
);
create index if not exists sites_customer_idx     on sites (org_id, customer_id);
create index if not exists sites_lead_idx         on sites (lead_id);
create index if not exists sites_discom_idx       on sites (discom_id);
create index if not exists sites_consumer_no_idx  on sites (org_id, upper(consumer_no)) where consumer_no is not null;
create index if not exists sites_pincode_idx      on sites (org_id, pincode);

-- -----------------------------------------------------------------------------------------------------
-- site_surveys
-- -----------------------------------------------------------------------------------------------------
create table if not exists site_surveys (
  id                                    uuid primary key default gen_random_uuid(),
  org_id                                uuid not null references organizations (id) on delete restrict,
  site_id                               uuid references sites (id) on delete set null,
  lead_id                               uuid not null references leads (id) on delete cascade,
  opportunity_id                        uuid,                    -- FK to opportunities added in 04
  status                                survey_status not null default 'scheduled',
  scheduled_at                          timestamptz,
  surveyed_at                           timestamptz,
  surveyor_id                           uuid,
  photos                                jsonb not null default '[]'::jsonb,   -- [{ path, lat, lng, taken_at, caption? }]
  shading                               text check (shading in ('none', 'low', 'medium', 'high')),
  roof_type                             text,
  roof_area_sqm                         numeric(10,2),
  sld_ref                               text,
  notes                                 text,
  feasibility_status                    feasibility_status not null default 'not_required',
  feasibility_application_submitted_at  timestamptz,
  feasibility_application_complete_at   timestamptz,
  feasibility_due_at                    timestamptz,
  created_at                            timestamptz not null default now(),
  updated_at                            timestamptz not null default now(),
  created_by                            uuid
);
create index if not exists site_surveys_lead_idx    on site_surveys (org_id, lead_id);
create index if not exists site_surveys_site_idx    on site_surveys (site_id);
create index if not exists site_surveys_status_idx  on site_surveys (org_id, status, scheduled_at);

-- -----------------------------------------------------------------------------------------------------
-- Forward foreign keys on leads (idempotent: drop-if-exists then add)
-- -----------------------------------------------------------------------------------------------------
alter table leads drop constraint if exists leads_customer_id_fkey;
alter table leads add  constraint leads_customer_id_fkey foreign key (customer_id) references customers (id) on delete set null deferrable initially deferred;
alter table leads drop constraint if exists leads_site_id_fkey;
alter table leads add  constraint leads_site_id_fkey foreign key (site_id) references sites (id) on delete set null deferrable initially deferred;
create index if not exists leads_customer_idx on leads (customer_id) where customer_id is not null;
create index if not exists leads_site_idx     on leads (site_id) where site_id is not null;
