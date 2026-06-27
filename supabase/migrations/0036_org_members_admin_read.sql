-- 0036: admins + data analysts can read ALL memberships in their own org.
--
-- BUG THIS FIXES
--   The only SELECT policy on organization_members (from 0001) was
--     "members can read own memberships"  USING (user_id = auth.uid())
--   so an admin reading the table through their own session saw only their
--   OWN row. The admin Users page (app/[org]/(admin)/users/page.tsx) lists
--   members via the caller's RLS-scoped client, so admins could never see the
--   learners in their organization (Total showed "1" — just the admin).
--
--   0001 explicitly deferred the org-wide read ("expose that later via a
--   security-definer helper"). 0010 added is_org_admin()/is_org_data_analyst()
--   (SECURITY DEFINER, so they read organization_members WITHOUT triggering
--   this policy — no recursion), but no policy was ever added to use them.
--
-- This policy is PERMISSIVE, so it ORs with the existing "own memberships"
-- policy: a learner still sees their own row; an admin/analyst sees every
-- member of orgs they administer. is_org_admin(organization_id) scopes the
-- read to the caller's own org, preserving tenant isolation.

drop policy if exists "admins read org memberships" on public.organization_members;
create policy "admins read org memberships"
  on public.organization_members for select
  using (
    public.is_org_admin(organization_id)
    or public.is_org_data_analyst(organization_id)
  );

notify pgrst, 'reload schema';
