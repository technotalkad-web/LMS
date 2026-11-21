-- scripts/migration-rehearsal/plant-0114-sent-at-type.sql
-- Scenario 0114-drift (ADR 0029, D4): public.notification_log.sent_at of
-- another type, text (P7). The real column is renamed aside (its indexes keep
-- it) and a text column takes its name; repair-0114-drift.sql drops the text
-- column and renames the real one back.
alter table public.notification_log rename column sent_at to sent_at_planted;
alter table public.notification_log add column sent_at text;
