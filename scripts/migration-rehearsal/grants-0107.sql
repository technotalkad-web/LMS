-- scripts/migration-rehearsal/grants-0107.sql
-- Every 0107 scenario, before the first paste (ADR 0024 step 63, "Grants
-- first"). shim.sql gives the Supabase roles no grants and no default
-- privileges, so on it a write as authenticated raises 42501 before 0107 as
-- well, and a view read as authenticated raises 42501 from the base tables
-- instead of returning rows: the privilege checks of 0107 would pass or fail
-- for the wrong reason. These are the grants the project defaults gave the
-- tables 0107 reads, in the form of asrole-grants.sql, and the table-level
-- privileges the defaults gave org_api_keys (0071 wrote none; step 8).
-- Relations 0107 creates get nothing from this file: it runs before them.
grant usage on schema public to anon, authenticated;
grant select on all tables in schema public to anon, authenticated;
grant insert, update, delete on public.org_api_keys to authenticated;
