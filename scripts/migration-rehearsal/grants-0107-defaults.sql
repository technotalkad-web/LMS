-- scripts/migration-rehearsal/grants-0107-defaults.sql
-- Five of the six 0107 scenarios that run grants-0107.sql, right after it
-- and before the first paste: every one but 0106-then-0105-then-0107 (the
-- ADR 0024 note of 2026-11-14, final review, F5). The default privileges a
-- Supabase project gives the objects postgres creates in public, as a
-- worst-case stand-in: shim.sql gives none, so without this file every
-- relation and function 0107 creates starts with no privilege for anon or
-- authenticated, and every "nothing for anon or authenticated" check on
-- them (0107's own A5 and A23, and the matrices of the 0107 assertion
-- files) passes whether or not 0107 revokes. With it, a new object holds
-- everything until 0107 takes it back, so those checks fail when a revoke
-- is missing or too narrow.
-- Which default privileges staging and production hold today was not read
-- (Supabase stopped granting new public relations by default on
-- 2026-10-30); 0107 must be right under either, so the other direction is
-- kept too: 0106-then-0105-then-0107 runs without this file, where a grant
-- 0107 must give (select for authenticated, execute for service_role) is
-- held only if 0107 gives it.
-- Objects created before this file keep their privileges: default
-- privileges apply to objects created afterwards, by this role.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
