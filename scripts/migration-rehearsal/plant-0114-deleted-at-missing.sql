-- scripts/migration-rehearsal/plant-0114-deleted-at-missing.sql
-- Scenario 0114-drift (ADR 0029, D4): public.organizations without a
-- deleted_at column (P3). The column is renamed, not dropped, so the views,
-- policies and functions that read it keep it; repair-0114-drift.sql
-- renames it back.
alter table public.organizations rename column deleted_at to deleted_at_planted;
