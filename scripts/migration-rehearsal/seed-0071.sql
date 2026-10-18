-- scripts/migration-rehearsal/seed-0071.sql
-- Synthetic. Needs migration 0071 (org_integration_settings): a CRM webhook
-- whose URL carries a user, a password and a token, plus a secret. D07 must
-- show the host only; the runner fails if any of them appears in the grid.
insert into public.org_integration_settings (organization_id, webhook_url, webhook_secret) values
  ('00000000-0000-0000-0000-00000000000a', 'https://user:p4ss@crm.example.com:8443/hooks/lms?token=abc', 'never-printed');
