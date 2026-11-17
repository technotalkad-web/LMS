-- scripts/migration-rehearsal/fixtures/0056_business_verticals.section0.sql
-- REHEARSAL FIXTURE, not a migration. Everything below the separator line is
-- lines 28-54 of supabase/migrations/0056_business_verticals.sql, byte for
-- byte: its section 0, which restates is_org_admin (the body without 0115's
-- tests) and "admins read org memberships". Why it is kept: scenario
-- 0115-undone-then-0115 proves the re-paste rule of ADR 0030 (after 0115 an
-- older file pasted again restores an old helper; 0115 is pasted again
-- directly after it). 0056 does not apply whole on a database at 0104 or
-- later (a later statement of the file stops with 42P10), so the rehearsal
-- pastes the statements that matter, as the 0073 fixture of this folder
-- does. Never paste this file anywhere.
-- ---------------------------------------------------------------------------
-- ── 0) Drift-safe role helpers (staging confirmed stale 2026-09-01) ──────────
-- Hand-applied environments can still carry 0002's is_org_admin, which lacks
-- 'super_owner' — leaving Super Owners unable to read other members' rows
-- (edit-user 404s) or write gamification_settings. Re-assert the 0010
-- definition; create or replace is a no-op where it's already current.

create or replace function public.is_org_admin(org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.organization_members m
    where m.organization_id = org_id
      and m.user_id = auth.uid()
      and m.role::text in ('owner', 'super_owner', 'admin')
  );
$$;

-- 0036's admin-read policy on organization_members, re-asserted so it exists
-- and binds to the helper above (missing/stale on drifted environments).
drop policy if exists "admins read org memberships" on public.organization_members;
create policy "admins read org memberships"
  on public.organization_members for select
  using (public.is_org_admin(organization_id));
