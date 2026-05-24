-- Phase 8b part 1: add new role values to the org_role enum.
--
-- Postgres rule: an enum value added by ALTER TYPE ... ADD VALUE cannot be
-- used inside the same transaction. We add the new values here and do the
-- data backfill / helper rewrites in 0010_rbac_expansion_part2.sql, which
-- runs in a separate transaction.

alter type public.org_role add value if not exists 'super_owner';
alter type public.org_role add value if not exists 'data_analyst';
alter type public.org_role add value if not exists 'user';

notify pgrst, 'reload schema';
