-- scripts/migration-rehearsal/repair-0115-off-list.sql
-- Scenario 0115-hand-made-off-list, after each variant's refused paste: the
-- hand-made baseline of plant-0115-hand-made.sql back, whichever variant was
-- planted (the scenario then compares schema public with its fingerprint of
-- that baseline). Every policy a variant adds or changes is removed, and the
-- two aliases and the legacy policy are made again with the baseline's
-- command, roles and text.
drop policy if exists "members can read their orgs" on public.organizations;
drop policy if exists "members_view_their_orgs" on public.organizations;
create policy "members_view_their_orgs"
  on public.organizations for select
  using (id in (select organization_members.organization_id
                  from public.organization_members
                 where organization_members.user_id = auth.uid()));

drop policy if exists "members can read own memberships" on public.organization_members;
drop policy if exists "View own memberships" on public.organization_members;
drop policy if exists "View own membership" on public.organization_members;
create policy "View own membership"
  on public.organization_members for select
  using (auth.uid() = user_id);

drop policy if exists "org_admins_view_enrollments" on public.enrollments;
drop policy if exists "admins_view_org_enrollments" on public.enrollments;
create policy "admins_view_org_enrollments"
  on public.enrollments for select
  using (organization_id in (
    select organization_members.organization_id
      from public.organization_members
     where organization_members.user_id = auth.uid()
       and organization_members.role::text in ('owner', 'super_owner', 'admin')));

drop policy if exists "admins_view_org_enrollments" on public.courses;
