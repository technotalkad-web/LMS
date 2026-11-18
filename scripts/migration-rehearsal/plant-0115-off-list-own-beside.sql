-- scripts/migration-rehearsal/plant-0115-off-list-own-beside.sql
-- Scenario 0115-hand-made-off-list (ADR 0030, note "Hand-made databases,
-- 2026-11-18"), on the hand-made baseline: the own-row alias beside its
-- repository name. "members can read own memberships" is put back as
-- 0001_initial.sql creates it, beside "View own membership". The alias is no
-- longer a known alias (the repository name is present), so the before-check
-- marks it UNEXPECTED and 0115's after-check A4 rolls the paste back.
-- Repaired by repair-0115-off-list.sql.
create policy "members can read own memberships"
  on public.organization_members for select
  using (user_id = auth.uid());
