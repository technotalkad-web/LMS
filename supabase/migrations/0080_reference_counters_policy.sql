-- 0080: a read policy on org_reference_counters.
--
-- 0079 enabled RLS on the counter table with no policies, because only the
-- security-definer function next_reference_code() ever touches it. The RLS
-- cross-tenant audit (tests/rls-audit/audit.sql) treats "RLS on, zero
-- policies" on any table carrying organization_id as a failure, so the PR
-- check went red. This gives the table one tenant-scoped policy: admins of
-- an organisation may READ their own counters (useful for support anyway).
-- Writes still happen only through the definer function.

drop policy if exists "org admins read their reference counters" on public.org_reference_counters;
create policy "org admins read their reference counters"
  on public.org_reference_counters
  for select
  using (public.is_org_admin(organization_id));

notify pgrst, 'reload schema';
