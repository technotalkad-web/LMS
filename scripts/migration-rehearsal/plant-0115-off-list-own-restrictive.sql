-- scripts/migration-rehearsal/plant-0115-off-list-own-restrictive.sql
-- Scenario 0115-hand-made-off-list (ADR 0030, note "Hand-made databases,
-- 2026-11-18"), on the hand-made baseline: the own-row alias made
-- restrictive, for select, with its text unchanged. It is not a known alias,
-- so the before-check marks it UNEXPECTED and 0115's after-check A4 rolls
-- the paste back. Repaired by repair-0115-off-list.sql.
drop policy "View own membership" on public.organization_members;
create policy "View own membership"
  on public.organization_members as restrictive for select
  using (auth.uid() = user_id);
