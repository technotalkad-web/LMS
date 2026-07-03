-- 0046: Enable RLS on subscription_plans (the global plan catalog).
--
-- subscription_plans was created in 0021 WITHOUT row-level security. It has no
-- organization_id (it's a single global catalog of plans), so the cross-tenant
-- RLS audit — which only inspects org-scoped tables — never flagged it. But
-- Supabase's Security Advisor scans EVERY public table and correctly reports
-- `rls_disabled_in_public`: with RLS off, anyone holding the public anon key can
-- read, INSERT, UPDATE, and DELETE plan rows (including prices). Real hole.
--
-- Every code path that touches this table uses the service role (the /super
-- plan pages and /api/super/plans writes all use SUPABASE_SERVICE_ROLE_KEY),
-- and service-role bypasses RLS — so enabling RLS breaks nothing.
--
--   * enable RLS  -> closes the anon read/write/delete hole (deny-by-default),
--   * platform-owner SELECT policy -> gives policy_count > 0 and lets an authed
--     platform owner read the catalog if a page ever switches off service-role,
--   * NO write policies -> INSERT/UPDATE/DELETE stay service-role-only, exactly
--     matching how the app already mutates plans.

alter table public.subscription_plans enable row level security;

drop policy if exists "platform owners read plans" on public.subscription_plans;
create policy "platform owners read plans"
  on public.subscription_plans for select
  using (public.is_platform_owner());
