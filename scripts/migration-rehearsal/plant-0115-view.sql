-- scripts/migration-rehearsal/plant-0115-view.sql
-- Scenario 0115-undone-then-0115, after 0115: a view that reads the
-- reader's own membership rows with auth.uid() and no test of the rule. A
-- reader's own rows stay readable whatever their status, so such a view
-- takes a helper instead: 0115's before-check must list it (B4d,
-- UNEXPECTED) and ops/0115-after-checks.sql must fail and name it.
create view public.v_rehearsal_my_orgs with (security_invoker = true) as
  select m.organization_id
  from public.organization_members m
  where m.user_id = auth.uid();
