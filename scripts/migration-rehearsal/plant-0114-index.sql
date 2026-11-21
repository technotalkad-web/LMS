-- scripts/migration-rehearsal/plant-0114-index.sql
-- Scenario 0114-drift (ADR 0029, D4): an index of 0114's name on other columns
-- of public.notification_log (P13). create index if not exists would pass
-- over it in silence.
create index notification_log_org_sent_at_idx on public.notification_log (organization_id, event_type);
