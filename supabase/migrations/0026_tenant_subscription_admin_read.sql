-- =============================================================================
-- 0026: Tenant admins can READ their own subscription (read-only)
-- =============================================================================
--
-- Background:
--   Migration 0021 created `public.tenant_subscriptions` with a single
--   policy "platform owners manage subscriptions" gated by
--   `is_platform_owner()`. The comment in that file explicitly deferred
--   tenant-side read access:
--
--     "Org admins don't see their own subscription row from this table —
--      for that we'd expose a read-only view in a follow-up phase."
--
--   This migration is that follow-up. We give org `owner` and `admin`
--   roles SELECT access — and ONLY SELECT — on their own org's row.
--   Writes remain platform-owner-only, so plan/MRR/billing_status can't
--   be tampered with from the tenant side.
--
-- Cross-tenant safety:
--   The new policy joins through `organization_members` and filters on
--   `tenant_subscriptions.organization_id`, so a tenant admin in Org A
--   cannot see Org B's subscription row. The RLS audit
--   (tests/rls-audit/audit.sql) will verify this at runtime after this
--   migration is applied.
--
-- Why a policy and not a view:
--   A view would require duplicating the row-filter logic and granting
--   on the view; a dedicated SELECT policy is the simpler, idiomatic
--   Supabase pattern and keeps the audit script's table-discovery query
--   honest (it keys off `organization_id`, which the underlying table
--   already has).
-- =============================================================================


-- Tenant owners + admins can read their own subscription. SELECT only.
drop policy if exists "tenant admins read own subscription"
  on public.tenant_subscriptions;
create policy "tenant admins read own subscription"
  on public.tenant_subscriptions
  for select
  to authenticated
  using (
    exists (
      select 1 from public.organization_members m
      where m.organization_id = tenant_subscriptions.organization_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'admin')
    )
  );

-- Refresh PostgREST schema cache so the new policy takes effect immediately.
notify pgrst, 'reload schema';
