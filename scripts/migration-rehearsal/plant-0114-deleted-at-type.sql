-- scripts/migration-rehearsal/plant-0114-deleted-at-type.sql
-- Scenario 0114-drift (ADR 0029, D4): public.organizations.deleted_at of
-- another type, text (P3). The real column is renamed aside, so what reads
-- it keeps it, and a text column takes its name; repair-0114-drift.sql
-- drops the text column and renames the real one back.
alter table public.organizations rename column deleted_at to deleted_at_planted;
alter table public.organizations add column deleted_at text;
