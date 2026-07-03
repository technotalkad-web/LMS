-- 0047: Flip the reporting/platform views to security_invoker (fix
-- `security_definer_view` — Supabase Security Advisor lint 0010).
--
-- A Postgres view runs, by default, with the privileges and RLS context of its
-- OWNER, not the querying user (effectively SECURITY DEFINER). For a view over
-- tenant tables that means a query through the view can BYPASS row-level
-- security — a cross-tenant read hole if the view is ever hit by the authed
-- (anon/authenticated) client.
--
-- Today every consumer of these five views uses the service role (which bypasses
-- RLS anyway) or the SECURITY DEFINER refresh_report_views() function:
--   * tenant_usage                -> /super org page (service role)
--   * platform_tables_without_rls -> rls-audit cron (service role)
--   * v_course_enrollments_expanded / v_path_enrollments_expanded /
--     v_course_attempt_summary    -> feed the report matviews, refreshed by
--                                    refresh_report_views() (service role)
-- so setting security_invoker = on changes NO current behavior (service role and
-- the definer refresh still see every row) while closing the RLS-bypass hole for
-- any future authed reader. Requires Postgres 15+ (Supabase default).

alter view public.v_course_enrollments_expanded set (security_invoker = on);
alter view public.v_path_enrollments_expanded   set (security_invoker = on);
alter view public.v_course_attempt_summary      set (security_invoker = on);
alter view public.tenant_usage                  set (security_invoker = on);
alter view public.platform_tables_without_rls   set (security_invoker = on);
