-- scripts/migration-rehearsal/plant-0114-state-table.sql
-- Scenario 0114-drift (ADR 0029, D4): a table public.tenant_smtp_state already
-- there with other columns (P11), as a database set up by hand could hold
-- one. create table if not exists would pass over it in silence.
create table public.tenant_smtp_state (
  organization_id uuid primary key,
  state           text
);
