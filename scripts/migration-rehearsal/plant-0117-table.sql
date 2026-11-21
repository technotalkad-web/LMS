-- scripts/migration-rehearsal/plant-0117-table.sql
-- Scenario 0117-no-defaults (ADR 0029, D4): a table public.account_setup_links
-- already there with another shape (P16). create table if not exists would
-- pass over it in silence.
create table public.account_setup_links (
  id      uuid primary key,
  user_id uuid
);
