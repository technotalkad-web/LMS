-- scripts/migration-rehearsal/plant-0115-off-list-other-name.sql
-- Scenario 0115-hand-made-off-list (ADR 0030, note "Hand-made databases,
-- 2026-11-18"), on the hand-made baseline: an alias-like name that is not on
-- the list ("View own memberships"), with the repository name absent and the
-- known alias's text. Names match exactly, so the before-check marks it
-- UNEXPECTED and 0115's after-check A4 rolls the paste back. Repaired by
-- repair-0115-off-list.sql.
alter policy "View own membership" on public.organization_members rename to "View own memberships";
