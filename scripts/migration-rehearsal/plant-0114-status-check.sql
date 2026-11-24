-- scripts/migration-rehearsal/plant-0114-status-check.sql
-- Scenario 0114-drift (ADR 0029, D4): a check on public.notification_log.status
-- that does not admit 'sent' (P8), beside the table's own check. Not
-- validated, so rows already there are not read; repair-0114-drift.sql
-- drops it.
alter table public.notification_log
  add constraint notification_log_status_planted check (status in ('failed', 'queued')) not valid;
