-- 0049: Supabase Security Advisor hardening (WARN-level lints).
--
-- After 0046-0048 cleared the ERROR-level findings, these WARN items remain.
-- This migration fixes the ones that are safe and/or real; see the notes for
-- the two classes we deliberately DO NOT touch.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- A) materialized_view_in_api  — REAL cross-tenant leak.
--    The mv_* report matviews carry no RLS, yet SELECT was granted to anon /
--    authenticated, so any signed-in user could read EVERY tenant's aggregates
--    directly via /rest/v1/mv_* (bypassing the app's per-org WHERE filter).
--    Revoke client access. The course reports page now reads them with the
--    service role (app/[org]/(admin)/library/[courseId]/reports/page.tsx), so we
--    grant service_role explicitly to guarantee it keeps working after the
--    revoke. The mv_path_* views are unused by the app.
--    ORDER OF OPS: deploy the page change BEFORE applying this, or the reports
--    page (still on the authed client) loses matview access in the gap.

revoke select on public.mv_course_enrollment_status      from anon, authenticated;
revoke select on public.mv_path_enrollment_status        from anon, authenticated;
revoke select on public.mv_course_performance            from anon, authenticated;
revoke select on public.mv_path_performance              from anon, authenticated;
revoke select on public.mv_course_interaction_breakdown  from anon, authenticated;
revoke select on public.mv_course_interaction_top_wrong  from anon, authenticated;

grant select on public.mv_course_enrollment_status     to service_role;
grant select on public.mv_course_performance           to service_role;
grant select on public.mv_course_interaction_breakdown to service_role;
grant select on public.mv_course_interaction_top_wrong to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- B) anon/authenticated_security_definer_function_executable
--    SECURITY DEFINER functions exposed as RPC to the API roles. Lock down the
--    ones that are triggers or service-role-only. Trigger functions still fire
--    after the revoke (Postgres triggers do NOT check EXECUTE); service-role
--    callers get an explicit grant because revoking from PUBLIC would otherwise
--    strip it from service_role too (all roles inherit PUBLIC).
--
--    DELIBERATELY LEFT EXECUTABLE: public.is_org_member(uuid),
--    public.is_org_admin(uuid), public.is_platform_owner() — these are invoked
--    INSIDE RLS policies (47 + 15 + platform policy references), so the authed
--    role MUST keep EXECUTE or every policy evaluation fails. Their advisor WARN
--    is expected (same posture as Supabase's own auth.uid()/auth.role()).

-- trigger-only (no RPC caller; triggers fire regardless of EXECUTE):
revoke execute on function public.handle_new_user()           from public, anon, authenticated;
revoke execute on function public.create_default_lrs_config() from public, anon, authenticated;
revoke execute on function public.enforce_row_quota()         from public, anon, authenticated;

-- service-role-only helpers (revoke from API roles, keep for service_role):
revoke execute on function public.effective_cap(uuid, text)       from public, anon, authenticated;
revoke execute on function public.current_quota_usage(uuid, text) from public, anon, authenticated;
revoke execute on function public.platform_reapable_orgs()        from public, anon, authenticated;
revoke execute on function public.refresh_report_views()          from public, anon, authenticated;

grant execute on function public.effective_cap(uuid, text)       to service_role;
grant execute on function public.current_quota_usage(uuid, text) to service_role;
grant execute on function public.platform_reapable_orgs()        to service_role;
grant execute on function public.refresh_report_views()          to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- C) function_search_path_mutable — pin set_updated_at's search_path.
--    (This trigger fn predates the migrations — created via the dashboard — so
--    we ALTER it in place. pg_catalog,public is used rather than '' so it stays
--    safe even if the body references an unqualified public object.)

alter function public.set_updated_at() set search_path = pg_catalog, public;

-- ─────────────────────────────────────────────────────────────────────────────
-- D) public_bucket_allows_listing — public-assets.
--    public-assets is a PUBLIC bucket: its objects are served via their public
--    URL with no policy check, so this broad SELECT policy on storage.objects
--    only enables directory LISTING of every file. The app never lists it
--    (writes are service-role; reads are by known public URL), so drop it.

drop policy if exists "public read public-assets" on storage.objects;

-- ─────────────────────────────────────────────────────────────────────────────
-- NOT fixable in SQL:
--   auth_leaked_password_protection — enable in Dashboard → Authentication →
--   Sign In / Providers → Password → "Leaked password protection" (HaveIBeenPwned).
