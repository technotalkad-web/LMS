-- scripts/migration-rehearsal/plant-0115-off-list-other-table.sql
-- Scenario 0115-hand-made-off-list (ADR 0030, note "Hand-made databases,
-- 2026-11-18"), on the hand-made baseline: the legacy policy's name on
-- another table (public.courses), beside the legacy policy itself. Only that
-- name on exactly public.enrollments is the legacy policy, so the
-- before-check marks the one on courses UNEXPECTED (and still DROPS the one
-- on enrollments), and 0115's after-check A4 rolls the paste back. Repaired
-- by repair-0115-off-list.sql.
create policy "admins_view_org_enrollments"
  on public.courses for select
  using (organization_id in (
    select organization_members.organization_id
      from public.organization_members
     where organization_members.user_id = auth.uid()
       and organization_members.role::text in ('owner', 'super_owner', 'admin')));
