-- scripts/migration-rehearsal/plant-0115-0006-policy.sql
-- Scenario 0115-extra-policy (ADR 0030 section C point 6, build
-- prerequisites point 3): the older select policy of 0006 on profiles,
-- planted in the form a renamed column leaves it in (0006 wrote it against
-- profiles.user_id; 0027 renamed that column to id, and 0027's drop loop is
-- what removes the policy where it ran). Policies of one command combine
-- with OR, so where it survives it keeps the old rule beside 0115's. 0115's
-- before-check must list it (B4a, UNEXPECTED) and 0115's after-check must
-- fail on it, which rolls the paste back whole.
create policy "users read all profiles in shared orgs"
  on public.profiles for select
  using (
    id = auth.uid()
    or exists (
      select 1
      from public.organization_members me
      join public.organization_members them on them.organization_id = me.organization_id
      where me.user_id = auth.uid() and them.user_id = profiles.id
    )
  );
