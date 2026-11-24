-- scripts/migration-rehearsal/seed-0114.sql
-- Scenario 0114-0117-sitting (ADR 0029, D4), after seed-0115.sql and before
-- the pre-check: three rows of public.notification_log for seed-0115.sql's
-- first live organisation (two sent now, one failed now), COMMITTED, so that
-- the pre-check's P10 counts read real rows. Synthetic addresses only.
insert into public.notification_log (organization_id, event_type, to_address, status, sent_at)
values ('00000000-0115-4000-8000-0000000000f1', 'custom_broadcast', 'n1-0114@example.test', 'sent',   now()),
       ('00000000-0115-4000-8000-0000000000f1', 'custom_broadcast', 'n2-0114@example.test', 'sent',   now()),
       ('00000000-0115-4000-8000-0000000000f1', 'custom_broadcast', 'n3-0114@example.test', 'failed', now());
