-- scripts/migration-rehearsal/plant-0114-default.sql
-- Scenario 0114-drift (ADR 0029, D2 and D4): a look-alike
-- public.tenant_smtp_state that is 0114's own table in every point but one:
-- daily_limit defaults to 1, so a state row written without a cap would hold
-- its organisation to one mail a day. Its columns, keys and checks are the
-- file's, so the pre-check reads P11 as present and refuses nothing, and
-- section 0 lets the paste go on; the file's after-checks must roll the paste
-- back. repair-0114-drift.sql drops it.
create table public.tenant_smtp_state (
  organization_id   uuid primary key references public.organizations(id) on delete cascade,
  state             text check (state in ('healthy', 'failing')),
  state_changed_at  timestamptz not null default now(),
  last_success_at   timestamptz,
  last_failure_at   timestamptz,
  last_error_code   text,
  failed_recipients uuid[] not null default '{}',
  last_alert_at     timestamptz,
  alert_due_at      timestamptz,
  daily_limit       integer default 1 check (daily_limit is null or daily_limit between 1 and 100000),
  updated_at        timestamptz not null default now()
);
