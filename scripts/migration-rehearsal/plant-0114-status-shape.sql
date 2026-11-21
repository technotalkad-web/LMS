-- scripts/migration-rehearsal/plant-0114-status-shape.sql
-- Scenario 0114-drift (ADR 0029, D3, fact P8): a second check on
-- public.notification_log.status that does let 'sent' and 'failed' through,
-- but names each word on its own, joined by or, instead of the stored list
-- of `status in (...)`. P8 recognises only the list shape, so this check
-- must read REFUSES and stop the paste as well. Not validated, so rows
-- already there are not read; repair-0114-drift.sql drops it.
alter table public.notification_log
  add constraint notification_log_status_planted_shape
  check (status = 'sent' or status = 'failed' or status = 'queued') not valid;
