-- Phase 9.4 fix: bring the organizations UPDATE policy in line with the
-- 4-tier RBAC model. The original 0001 policy still only allowed
-- ('owner', 'admin'), which silently filtered out super_owners after the
-- Phase 8b rename — admins flipping the brand color, logo, name, etc.
-- from Settings → Workspace saw the save succeed but nothing changed,
-- because RLS dropped the UPDATE on the floor.
--
-- We cast `role` to text so this works whether or not 'super_owner' has
-- been added to the org_role enum yet (Phase 8b part 1 / 0009). On a
-- pre-Phase-8b DB, the role column still uses the legacy 'owner' value
-- and that's enough to pass the check.

drop policy if exists "owners and admins can update orgs" on public.organizations;
create policy "owners and admins can update orgs"
  on public.organizations for update
  using (
    exists (
      select 1 from public.organization_members m
      where m.organization_id = organizations.id
        and m.user_id = auth.uid()
        and m.role::text = any (array['super_owner', 'owner', 'admin'])
    )
  )
  with check (
    exists (
      select 1 from public.organization_members m
      where m.organization_id = organizations.id
        and m.user_id = auth.uid()
        and m.role::text = any (array['super_owner', 'owner', 'admin'])
    )
  );

notify pgrst, 'reload schema';
