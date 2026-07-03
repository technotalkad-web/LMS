-- 0049: Supabase Security Advisor hardening (WARN-level lints).
--
-- After 0046-0048 cleared the ERROR-level findings, these WARN items remain.
-- Every statement is guarded (to_regclass / to_regprocedure) because these are
-- applied by hand across DBs in different states (e.g. prod may be missing the
-- 0031 report matviews / quota functions) — a missing object must no-op, not
-- abort the whole script.
--
-- WHAT THIS FIXES
--  A) materialized_view_in_api (REAL cross-tenant leak): the mv_* report matviews
--     carry no RLS but granted SELECT to anon/authenticated, so any signed-in
--     user could read EVERY tenant's aggregates via /rest/v1/mv_*. The course
--     reports page now reads them with the service role, so we revoke the API
--     roles and grant service_role explicitly.
--  B) anon/authenticated_security_definer_function_executable: revoke EXECUTE on
--     trigger + service-role-only definer functions. Triggers still fire (they
--     don't check EXECUTE); service-role callers get an explicit grant because
--     revoking from PUBLIC would otherwise strip service_role too.
--  C) function_search_path_mutable: pin set_updated_at's search_path.
--  D) public_bucket_allows_listing: drop the broad listing policy on the public
--     public-assets bucket (public URLs still serve objects; only enumeration
--     is removed).
--
-- DELIBERATELY LEFT ALONE: is_org_member(uuid) / is_org_admin(uuid) /
-- is_platform_owner() stay EXECUTE-able — they run inside RLS policies, so the
-- authed role must keep EXECUTE or every policy check fails (same posture as
-- Supabase's own auth.uid()).
--
-- NOT fixable in SQL: auth_leaked_password_protection — enable in
-- Dashboard → Authentication → Password → "Leaked password protection".

do $$
begin
  -- ── A) matviews: not exposed over the Data API ──────────────────────────
  if to_regclass('public.mv_course_enrollment_status') is not null then
    revoke select on public.mv_course_enrollment_status from anon, authenticated;
    grant  select on public.mv_course_enrollment_status to service_role;
  end if;
  if to_regclass('public.mv_path_enrollment_status') is not null then
    revoke select on public.mv_path_enrollment_status from anon, authenticated;
  end if;
  if to_regclass('public.mv_course_performance') is not null then
    revoke select on public.mv_course_performance from anon, authenticated;
    grant  select on public.mv_course_performance to service_role;
  end if;
  if to_regclass('public.mv_path_performance') is not null then
    revoke select on public.mv_path_performance from anon, authenticated;
  end if;
  if to_regclass('public.mv_course_interaction_breakdown') is not null then
    revoke select on public.mv_course_interaction_breakdown from anon, authenticated;
    grant  select on public.mv_course_interaction_breakdown to service_role;
  end if;
  if to_regclass('public.mv_course_interaction_top_wrong') is not null then
    revoke select on public.mv_course_interaction_top_wrong from anon, authenticated;
    grant  select on public.mv_course_interaction_top_wrong to service_role;
  end if;

  -- ── B) definer functions not meant for the public API ───────────────────
  -- trigger-only (no RPC caller; triggers fire regardless of EXECUTE):
  if to_regprocedure('public.handle_new_user()') is not null then
    revoke execute on function public.handle_new_user() from public, anon, authenticated;
  end if;
  if to_regprocedure('public.create_default_lrs_config()') is not null then
    revoke execute on function public.create_default_lrs_config() from public, anon, authenticated;
  end if;
  if to_regprocedure('public.enforce_row_quota()') is not null then
    revoke execute on function public.enforce_row_quota() from public, anon, authenticated;
  end if;

  -- service-role-only helpers (revoke API roles, keep service_role):
  if to_regprocedure('public.effective_cap(uuid, text)') is not null then
    revoke execute on function public.effective_cap(uuid, text) from public, anon, authenticated;
    grant  execute on function public.effective_cap(uuid, text) to service_role;
  end if;
  if to_regprocedure('public.current_quota_usage(uuid, text)') is not null then
    revoke execute on function public.current_quota_usage(uuid, text) from public, anon, authenticated;
    grant  execute on function public.current_quota_usage(uuid, text) to service_role;
  end if;
  if to_regprocedure('public.platform_reapable_orgs()') is not null then
    revoke execute on function public.platform_reapable_orgs() from public, anon, authenticated;
    grant  execute on function public.platform_reapable_orgs() to service_role;
  end if;
  if to_regprocedure('public.refresh_report_views()') is not null then
    revoke execute on function public.refresh_report_views() from public, anon, authenticated;
    grant  execute on function public.refresh_report_views() to service_role;
  end if;

  -- ── C) pin set_updated_at search_path ───────────────────────────────────
  -- pg_catalog,public (not '') so it stays safe if the body references public.
  if to_regprocedure('public.set_updated_at()') is not null then
    alter function public.set_updated_at() set search_path = pg_catalog, public;
  end if;
end $$;

-- ── D) public-assets listing policy (storage.objects always exists) ───────
drop policy if exists "public read public-assets" on storage.objects;
