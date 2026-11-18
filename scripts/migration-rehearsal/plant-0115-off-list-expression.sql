-- scripts/migration-rehearsal/plant-0115-off-list-expression.sql
-- Scenario 0115-hand-made-off-list (ADR 0030, note "Hand-made databases,
-- 2026-11-18"), on the hand-made baseline: the second alias with another
-- expression (the reader's own row, or any active row). Only (auth.uid() =
-- user_id) or (user_id = auth.uid()) makes it the known alias, so the
-- before-check marks it UNEXPECTED and 0115's after-check A4 rolls the
-- paste back. Repaired by repair-0115-off-list.sql.
alter policy "View own membership" on public.organization_members
  using (auth.uid() = user_id or status = 'active');
