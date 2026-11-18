-- scripts/migration-rehearsal/plant-0115-off-list-enrollments-other-name.sql
-- Scenario 0115-hand-made-off-list (ADR 0030, note "Hand-made databases,
-- 2026-11-18"), on the hand-made baseline: another name on
-- public.enrollments that reads organization_members (the legacy policy
-- renamed). Only the exact name is the legacy policy, so the before-check
-- marks it UNEXPECTED and 0115's after-check A4 rolls the paste back.
-- Repaired by repair-0115-off-list.sql.
alter policy "admins_view_org_enrollments" on public.enrollments rename to "org_admins_view_enrollments";
