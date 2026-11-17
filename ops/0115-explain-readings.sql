-- ops/0115-explain-readings.sql — the two speed readings of ADR 0030
-- section C point 5, taken on STAGING by the owner in the SQL editor (role
-- selector on postgres): once BEFORE the 0115 paste and once AFTER it, with
-- the same two blocks. READ-ONLY: `explain (analyze, buffers)` of a select
-- writes nothing, and the role change lasts only for the run.
--
-- Paste and run ONE block at a time (the editor shows the last result only).
-- Each block reads as an active member's session, because a read as
-- postgres skips the row-level policies that 0115 changes. Change 'ambak' to
-- another organisation's slug if staging has no organisation by that name.
-- Keep the two "Execution Time" lines of each run (before and after); the
-- architect compares them before the code half of ADR 0030 goes to staging.

-- ---------------------------------------------------------------------------
-- Block A: an active administrator, the Library list (the heaviest session
-- read of the admin Library page).
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', json_build_object(
  'sub', (select m.user_id::text
            from public.organization_members m
            join public.organizations o on o.id = m.organization_id
           where o.slug = 'ambak' and m.status = 'active'
             and m.role::text in ('super_owner', 'admin')
           limit 1),
  'role', 'authenticated')::text, true);
set local role authenticated;
explain (analyze, buffers)
select id, slug, title, description, status, updated_at, current_version_id,
       thumbnail_url, duration_minutes, is_active
  from public.courses
 where organization_id = (select id from public.organizations where slug = 'ambak')
 order by updated_at desc;

-- ---------------------------------------------------------------------------
-- Block B: an active learner, the dashboard's assignment read.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', json_build_object(
  'sub', (select m.user_id::text
            from public.organization_members m
            join public.organizations o on o.id = m.organization_id
           where o.slug = 'ambak' and m.status = 'active'
             and m.role::text in ('user', 'member')
           limit 1),
  'role', 'authenticated')::text, true);
set local role authenticated;
explain (analyze, buffers)
select *
  from public.course_assignments
 where organization_id = (select id from public.organizations where slug = 'ambak');
