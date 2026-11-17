-- scripts/migration-rehearsal/plant-0115-comment-body.sql
-- Scenario 0115-undone-then-0115: is_org_member with 0002's body, whose two
-- tests of the rule appear only in comments. 0115's after-check A1 reads a
-- helper's body with its comments dropped, so ops/0115-after-checks.sql
-- must fail on it and name both tests; 0115 pasted again restores the rule.
create or replace function public.is_org_member(org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  -- the rule: m.status = 'active' and o.deleted_at is null
  select exists (
    select 1 from public.organization_members m
    where m.organization_id = org_id
      and m.user_id = auth.uid() /* status = 'active', deleted_at is null */
  );
$$;
