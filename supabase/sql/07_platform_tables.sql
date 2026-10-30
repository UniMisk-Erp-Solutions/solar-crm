-- =====================================================================================================
-- 07_platform_tables.sql
-- Purpose : platform tables - rule_config (the configurable rule engine), clocks (SLA / statutory timers),
--           notifications, message_templates, message_log, kpi_snapshots, audit_log, compliance_calendar_items,
--           job_runs, verify_register, gate_applicability, breach_incidents, data_requests.
-- Run after: 06_postsale_tables.sql
-- Idempotent: `create table if not exists` / `create ... index if not exists`.
--
-- Notes
--   * audit_log and message_log are IMMUTABLE ledgers (created_at only; update/delete are blocked by triggers in 08
--     and revoked in 09). audit_log is written by the audit trigger (source 'trigger') and by the API (source 'api').
--   * rule_config is versioned by effective_from. A rule that is inactive or not verified is ADVISORY ONLY - the
--     API enforces that; the database simply refuses a rule without a source reference.
--   * clocks is the generic timer table; the cron job in the API marks breaches and escalates.
--   * gate_applicability is the gate x segment applicability matrix (G1..G14 x 7 segments).
--   * breach_incidents carries the 72-hour reporting countdown (report_due_at defaults to detected + 72 hours).
-- =====================================================================================================

-- -----------------------------------------------------------------------------------------------------
-- rule_config
-- -----------------------------------------------------------------------------------------------------
create table if not exists rule_config (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organizations (id) on delete restrict,
  category          text not null,
  key               text not null,
  value             jsonb not null,
  effective_from    date not null default current_date,
  effective_to      date,
  source_name       text not null,
  source_ref        text not null,
  confidence        rule_confidence not null default 'medium',
  status            rule_status not null default 'unverified',
  is_active         boolean not null default false,
  max_severity      severity not null default 'warning',
  enforce_hard_stop boolean not null default false,
  notes             text,
  updated_by        uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid,
  constraint rule_config_source_ref_nonblank_ck check (btrim(source_ref) <> ''),
  constraint rule_config_effective_ck check (effective_to is null or effective_to >= effective_from)
);
create unique index if not exists rule_config_version_uq on rule_config (org_id, category, key, effective_from);
create index if not exists rule_config_lookup_idx on rule_config (org_id, category, key, effective_from desc) where is_active;
create index if not exists rule_config_status_idx on rule_config (org_id, status, confidence);

-- -----------------------------------------------------------------------------------------------------
-- clocks
-- -----------------------------------------------------------------------------------------------------
create table if not exists clocks (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references organizations (id) on delete restrict,
  entity_type        text not null,
  entity_id          uuid not null,
  clock_type         clock_type not null,
  started_at         timestamptz not null default now(),
  due_at             timestamptz not null,
  warn_at            timestamptz,
  status             clock_status not null default 'running',
  escalated_level    integer not null default 0,
  owner_id           uuid,
  warned_at          timestamptz,
  breached_at        timestamptz,
  resolved_at        timestamptz,
  last_escalated_at  timestamptz,
  meta               jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  created_by         uuid
);
create index if not exists clocks_running_due_idx on clocks (org_id, due_at) where status = 'running';
create index if not exists clocks_entity_idx      on clocks (org_id, entity_type, entity_id);
create index if not exists clocks_type_status_idx on clocks (org_id, clock_type, status);
create index if not exists clocks_owner_idx       on clocks (owner_id) where status = 'running';

-- -----------------------------------------------------------------------------------------------------
-- notifications  (user_id null + target_role set = broadcast to a role)
-- -----------------------------------------------------------------------------------------------------
create table if not exists notifications (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations (id) on delete restrict,
  user_id      uuid,
  target_role  app_role,
  kind         text not null,
  title        text not null,
  body         text,
  severity     notification_severity not null default 'info',
  link         text,
  entity_type  text,
  entity_id    text,
  read_at      timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid
);
create index if not exists notifications_user_idx   on notifications (org_id, user_id, created_at desc) where user_id is not null;
create index if not exists notifications_role_idx   on notifications (org_id, target_role, created_at desc) where target_role is not null;
create index if not exists notifications_unread_idx on notifications (user_id) where read_at is null;
create index if not exists notifications_entity_idx on notifications (org_id, entity_type, entity_id);

-- -----------------------------------------------------------------------------------------------------
-- message_templates
-- -----------------------------------------------------------------------------------------------------
create table if not exists message_templates (
  id                      uuid primary key default gen_random_uuid(),
  org_id                  uuid not null references organizations (id) on delete restrict,
  key                     text not null,
  channel                 message_channel not null,
  category                template_category not null,
  purpose                 message_purpose not null,
  language                text not null default 'en' check (language in ('en', 'hi', 'gu')),
  subject                 text,
  body                    text not null,
  dlt_template_id         text,
  dlt_header              text,
  whatsapp_template_name  text,
  version                 integer not null default 1,
  active                  boolean not null default true,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  created_by              uuid
);
create unique index if not exists message_templates_uq on message_templates (org_id, key, language, version);
create index if not exists message_templates_channel_idx on message_templates (org_id, channel, active);

-- -----------------------------------------------------------------------------------------------------
-- message_log  (IMMUTABLE ledger: every send attempt, including blocked ones, with the reason)
-- -----------------------------------------------------------------------------------------------------
create table if not exists message_log (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations (id) on delete restrict,
  lead_id       uuid references leads (id) on delete restrict,
  channel       message_channel not null,
  purpose       message_purpose not null,
  category      template_category,
  template_key  text,
  direction     text not null default 'outbound' check (direction in ('outbound', 'inbound')),
  to_masked     text,
  body_preview  text,
  status        message_status not null default 'queued',
  block_reason  text,
  consent_id    uuid references lead_consents (id) on delete restrict,
  provider      text,
  provider_ref  text,
  created_by    uuid,
  created_at    timestamptz not null default now()
);
create index if not exists message_log_lead_idx   on message_log (org_id, lead_id, created_at desc);
create index if not exists message_log_status_idx on message_log (org_id, status, created_at desc);
create index if not exists message_log_inbound_idx on message_log (lead_id, created_at desc) where direction = 'inbound';
create index if not exists message_log_consent_idx on message_log (consent_id) where consent_id is not null;

-- -----------------------------------------------------------------------------------------------------
-- kpi_snapshots
-- -----------------------------------------------------------------------------------------------------
create table if not exists kpi_snapshots (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations (id) on delete restrict,
  kpi_key      text not null,
  period       text not null,
  value        numeric(18,4) not null,
  dims         jsonb not null default '{}'::jsonb,
  computed_at  timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid
);
create index if not exists kpi_snapshots_key_idx on kpi_snapshots (org_id, kpi_key, period);
create index if not exists kpi_snapshots_dims_gin on kpi_snapshots using gin (dims);

-- -----------------------------------------------------------------------------------------------------
-- audit_log  (IMMUTABLE ledger; trigger-written (source 'trigger') and API-written (source 'api'))
-- -----------------------------------------------------------------------------------------------------
create table if not exists audit_log (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations (id) on delete restrict,
  actor_id    uuid,
  action      text not null,
  table_name  text,
  record_id   text,
  old_data    jsonb,
  new_data    jsonb,
  detail      jsonb,
  source      text not null default 'api' check (source in ('trigger', 'api')),
  request_id  text,
  ip          text,
  created_at  timestamptz not null default now()
);
create index if not exists audit_log_org_time_idx on audit_log (org_id, created_at desc);
create index if not exists audit_log_record_idx   on audit_log (org_id, table_name, record_id);
create index if not exists audit_log_actor_idx    on audit_log (org_id, actor_id, created_at desc);
create index if not exists audit_log_action_idx   on audit_log (org_id, action);

-- -----------------------------------------------------------------------------------------------------
-- compliance_calendar_items
-- -----------------------------------------------------------------------------------------------------
create table if not exists compliance_calendar_items (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations (id) on delete restrict,
  due_date       date not null,
  title          text not null,
  description    text,
  category       text not null,
  confidence     rule_confidence not null default 'medium',
  source_ref     text,
  escalate_days  integer[] not null default '{}',
  rule_key       text,
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid
);
create index if not exists compliance_calendar_due_idx on compliance_calendar_items (org_id, due_date) where active;
create index if not exists compliance_calendar_rule_idx on compliance_calendar_items (org_id, rule_key) where rule_key is not null;
create index if not exists compliance_calendar_escalate_gin on compliance_calendar_items using gin (escalate_days);

-- -----------------------------------------------------------------------------------------------------
-- job_runs
-- -----------------------------------------------------------------------------------------------------
create table if not exists job_runs (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations (id) on delete restrict,
  job_name     text not null,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  status       text not null default 'running' check (status in ('running', 'ok', 'failed')),
  details      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid
);
create index if not exists job_runs_name_idx on job_runs (org_id, job_name, started_at desc);
create index if not exists job_runs_status_idx on job_runs (org_id, status) where status <> 'ok';

-- -----------------------------------------------------------------------------------------------------
-- verify_register  ("verify before relying" register)
-- -----------------------------------------------------------------------------------------------------
create table if not exists verify_register (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references organizations (id) on delete restrict,
  code                text not null,
  title               text not null,
  detail              text not null,
  where_to_check      text not null,
  confidence          rule_confidence not null default 'medium',
  owner               text,
  status              text not null default 'open' check (status in ('open', 'closed')),
  closing_source_url  text,
  closed_at           date,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid
);
create unique index if not exists verify_register_code_uq on verify_register (org_id, code);
create index if not exists verify_register_status_idx on verify_register (org_id, status);

-- -----------------------------------------------------------------------------------------------------
-- gate_applicability  (gate x segment matrix)
-- -----------------------------------------------------------------------------------------------------
create table if not exists gate_applicability (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations (id) on delete restrict,
  gate          gate not null,
  segment       segment not null,
  applicability applicability not null default 'applies',
  note          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid
);
create unique index if not exists gate_applicability_uq on gate_applicability (org_id, gate, segment);

-- -----------------------------------------------------------------------------------------------------
-- breach_incidents  (DPDP personal-data breach register; 72-hour countdown)
-- -----------------------------------------------------------------------------------------------------
create table if not exists breach_incidents (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations (id) on delete restrict,
  title          text not null,
  description    text,
  detected_at    timestamptz not null default now(),
  report_due_at  timestamptz not null default (now() + interval '72 hours'),
  status         text not null default 'open' check (status in ('open', 'reported', 'closed')),
  evidence       jsonb not null default '[]'::jsonb,       -- [{ at, by, note }]
  reported_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid
);
create index if not exists breach_incidents_status_idx on breach_incidents (org_id, status, report_due_at);

-- -----------------------------------------------------------------------------------------------------
-- data_requests  (DPDP access / erasure requests)
-- -----------------------------------------------------------------------------------------------------
create table if not exists data_requests (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations (id) on delete restrict,
  lead_id       uuid references leads (id) on delete set null,
  customer_id   uuid references customers (id) on delete set null,
  kind          text not null check (kind in ('export', 'erasure')),
  status        text not null default 'requested' check (status in ('requested', 'completed', 'rejected')),
  requested_at  timestamptz not null default now(),
  completed_at  timestamptz,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid
);
create index if not exists data_requests_status_idx on data_requests (org_id, status, requested_at);
create index if not exists data_requests_lead_idx   on data_requests (lead_id) where lead_id is not null;
create index if not exists data_requests_customer_idx on data_requests (customer_id) where customer_id is not null;
