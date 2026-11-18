-- scripts/migration-rehearsal/plant-0115-off-list-command.sql
-- Scenario 0115-hand-made-off-list (ADR 0030, note "Hand-made databases,
-- 2026-11-18"), on the hand-made baseline: the first alias for another
-- command (all), with its text unchanged. It is not a known alias, so the
-- before-check marks "members can read their orgs" REFUSES and the alias
-- UNEXPECTED, and 0115's section 0c refuses the paste. Repaired by
-- repair-0115-off-list.sql.
drop policy "members_view_their_orgs" on public.organizations;
create policy "members_view_their_orgs"
  on public.organizations for all
  using (id in (select organization_members.organization_id
                  from public.organization_members
                 where organization_members.user_id = auth.uid()));
