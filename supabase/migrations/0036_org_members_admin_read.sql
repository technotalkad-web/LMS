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
-- policy: a learner still sees their own row; an admin/super_owner sees every
-- member of orgs they administer. is_org_admin(organization_id) scopes the
-- read to the caller's own org, preserving tenant isolation. (is_org_admin
-- already covers super_owner + admin + legacy owner.)
--
-- NOTE: we intentionally use ONLY is_org_admin here. is_org_data_analyst()
-- (defined in 0010) is not present on all deployed databases, and the admin
-- Users page is gated to admins/super_owners (canManage) anyway, so the
-- analyst branch is unnecessary for this fix and would fail where the helper
-- was never applied.

drop policy if exists "admins read org memberships" on public.organization_members;
create policy "admins read org memberships"
  on public.organization_members for select
  using (public.is_org_admin(organization_id));

notify pgrst, 'reload schema';
