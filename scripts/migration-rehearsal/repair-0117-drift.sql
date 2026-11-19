-- scripts/migration-rehearsal/repair-0117-drift.sql
-- Scenario 0117-no-defaults (ADR 0029, D4), after each planted shape and its
-- refused paste: back to the base, as the fingerprint taken before the first
-- plant reads it.
drop table if exists public.account_setup_links;
drop index if exists public.account_setup_links_one_open_idx;
drop index if exists public.account_setup_links_org_created_idx;
