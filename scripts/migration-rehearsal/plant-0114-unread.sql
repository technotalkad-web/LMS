-- scripts/migration-rehearsal/plant-0114-unread.sql
-- Last step of scenario 0114-drift (ADR 0029, checklist D4): things on
-- public.notification_log that 0114 never looks at, namely a spare column,
-- a spare index and a spare policy. The pre-check must stay all ok or
-- info, and the paste must succeed.
alter table public.notification_log add column planted_note text;
create index notification_log_planted_idx on public.notification_log (event_type);
create policy "planted extra policy" on public.notification_log for select using (false);
