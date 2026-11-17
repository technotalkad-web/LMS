-- scripts/migration-rehearsal/repair-0115-view.sql
-- Scenario 0115-undone-then-0115: removes the view of plant-0115-view.sql,
-- after which ops/0115-after-checks.sql passes again.
drop view public.v_rehearsal_my_orgs;
