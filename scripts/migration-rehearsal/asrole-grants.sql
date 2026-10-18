-- scripts/migration-rehearsal/asrole-grants.sql
-- Scenario "asrole": Supabase-like default grants, so the audit can run as
-- authenticated. Row-level security then filters every D row to nothing
-- without an error; A04 (the role the audit ran as) must be the only mismatch.
grant usage on schema public to anon, authenticated;
grant select on all tables in schema public to anon, authenticated;
