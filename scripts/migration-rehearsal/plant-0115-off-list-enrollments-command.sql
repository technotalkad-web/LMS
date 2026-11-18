-- scripts/migration-rehearsal/plant-0115-off-list-enrollments-command.sql
-- Scenario 0115-hand-made-off-list (ADR 0030, note "Hand-made databases,
-- 2026-11-18"), on the hand-made baseline: the legacy policy on
-- public.enrollments for another command (all), with its text unchanged.
-- Only a permissive policy for select is the legacy policy, so the
-- before-check marks it UNEXPECTED and 0115's after-check A4 rolls the paste
-- back. Repaired by repair-0115-off-list.sql.
drop policy "admins_view_org_enrollments" on public.enrollments;
create policy "admins_view_org_enrollments"
  on public.enrollments for all
  using (organization_id in (
    select organization_members.organization_id
      from public.organization_members
     where organization_members.user_id = auth.uid()
       and organization_members.role::text in ('owner', 'super_owner', 'admin')));
