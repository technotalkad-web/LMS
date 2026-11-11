-- 0105_enrolment_expansion.sql — course and path enrolments count every
-- assignment that reaches a learner: direct, team, org-wide, Custom Group
-- (static and dynamic, verticals included) and, for a course, a released
-- step of an assigned, active Learning Path; a learner an enforced path still
-- holds back (an unreleased step) does not count (ADR 0020; the owner's
-- decision of 2026-11-10: "A - Count from the release date", read as "count
-- what the learner can open"). Hand-apply in the SQL editor with the role
-- selector on postgres, staging first; never `supabase db push` (the CLI is
-- linked to production).
--
-- ORDER (ADR 0020 step 9): the CODE of ADR 0020 first on every deployment
-- that shares the database, this file after. Today's view (0031) expands
-- user, team and org-wide rows with no release gate, which is exactly what
-- the TypeScript loader expands today, so the new code reads the same
-- numbers until this file is pasted; pasted before the code, the matviews
-- would count path learners while the pages still ran the old expansion,
-- which is the drift this change removes. Exception: if Q7 reads false on
-- an environment (no select grant for authenticated on the 0031 views), this
-- file is pasted first there, and the matviews run ahead of the pages until
-- the code deploy; that is recorded under ADR 0020.
--   Staging: after the pull request is on both staging deployments.
--   Production: in a small owner sitting, explained beforehand and approved,
--   after the tag that carries the code is live. Production has no courses,
--   so every count below reads 0 there.
--
-- Independent of 0100, 0103 and 0104: nothing here names an object of those
-- files (the rehearsal's word rule checks the raw text), so the file applies
-- on a database at 0099 + 0103 + 0104 with or without 0100. Independent of
-- 0106 (Learner Feedback) as well.
--
-- NEVER paste 0031 again after this file: it restores the two 0031 view
-- bodies (no groups, no paths, no release gate). 0047 only sets view options
-- and stays harmless; 0056, 0073, 0090 and 0099 recreate matviews that READ
-- these views and stay harmless.
--
-- Idempotent and retry-safe: `create or replace` throughout; the grants and
-- revokes repeat cleanly; a second paste changes nothing. One transaction:
-- on a lock timeout nothing changed, paste it again. Staging: paste when no
-- spec, CI e2e run or harness is in progress. Production: paste at a minute
-- clear of 03:30 UTC (refresh_report_views, which reads these views) and of
-- the crons' :03 / :07 quarter-hour offsets (refresh_gamification_views reads
-- them through mv_learner_metrics).
--
-- Row writes: none. The file takes ACCESS EXCLUSIVE locks on the three views
-- until commit (a concurrent `refresh materialized view concurrently` would
-- queue behind it, hence the minute rule above); it writes no row, so it is
-- quick. No table is locked for longer than the catalog lookups take.
--
-- PREREQUISITES (the DO block below refuses to run without them):
--   0011  organization_members.status, date_of_joining, designation,
--         job_role, line_manager_id, city, state
--   0017  learning_paths.is_active
--   0031  v_course_enrollments_expanded (exactly course_id, user_id) and
--         v_path_enrollments_expanded (exactly path_id, user_id)
--   0033  learning_paths.visibility (the org_public hold-back of section 6)
--   0035  refresh_report_views()
--   0052  course_assignments.release_at, learning_path_courses.release_at
--   0056  organization_members.business_vertical, branch
--   0067  org_groups (group_type, rules, is_active), org_group_members
--   0069  course_assignments.group_id, learning_path_assignments.group_id
--   0090  mv_course_performance; 0099 mv_course_enrollment_status (both read
--         the course view and pick up its new body at their next refresh)
--   0096  organization_members.department, org_groups.system_key
--
-- What it does:
--   1. group_rule_values(jsonb, text): the rule list for one key, as
--      lib/org/groups.ts parseGroupRules reads it (strings only, trimmed at
--      both ends of any whitespace, empties dropped, the first 200); an empty
--      list is a wildcard.
--   2. group_rule_days(jsonb): joined_within_days when it is a number from
--      1 to 3650, rounded; otherwise null.
--   3. group_member_ids(uuid): the members of ONE group, the SQL twin of
--      resolveGroupMembers: static rows, or for a dynamic group every ACTIVE
--      member every rule admits (the rule arrays computed once per group,
--      team_ids through team_members, joined_within_days against the UTC
--      date). An inactive or unknown group answers no row. The views below
--      call it per assigned group (cross join lateral), so a one-course read
--      expands only the groups assigned to that course, never every group.
--   4. v_group_members_expanded (group_id, organization_id, user_id): every
--      active group with its members, through group_member_ids.
--   5. v_path_enrollments_expanded: the 0031 body plus a Custom Group branch.
--   6. v_course_enrollments_expanded: direct rows (user, team, org, group)
--      whose release_at is null or past, union the released steps of active
--      paths the learner is assigned to (through the path view, starting from
--      the course); then every pair an enforced path holds back is dropped:
--      a path that holds the course as a step with a future release_at and is
--      org_public or assigned to the learner (the launch page's gate,
--      app/[org]/(learner)/courses/[courseId]/launch/page.tsx 584-668).
--      Distinct (course_id, user_id). now() in a view is fine: the matviews
--      snapshot it at their scheduled refresh (cron.yml 03:30 UTC on
--      production; pg_cron 03:30 UTC on staging) and the pages read it live.
--
-- Accepted differences from the TypeScript twins (ADR 0020 Review):
--   a. Trim: JavaScript trim() also strips the no-break space and a few other
--      Unicode spaces; the \s class here does not. Q3b lists any rule value
--      that differs before the paste.
--   b. team_ids with a value that is not a uuid: TypeScript's .in() fails and
--      the group matches nobody; SQL matches the members of the valid ids.
--      Q3b lists such values.
--   c. The hold-back copies the launch page exactly: it does not filter
--      inactive paths (the page reads every path holding the course, 584-587
--      and 641-654), and the admin bypass (659) is not copied, so an admin
--      assigned as a learner counts while held back.
--
-- Grants (literal, none relies on default privileges; docs/MIGRATIONS.md,
-- scripts/check-migration-grants.mjs, which sees the relations only):
--   the three views          alter view ... set (security_invoker = on);
--                            revoke all from anon; grant select to
--                            authenticated, service_role (an admin session
--                            reads them through its own RLS; the matview
--                            refresh runs as the definer)
--   the three functions      revoke all from public, anon; grant execute to
--                            authenticated, service_role (the invoker views
--                            call them as the caller; a learner's session
--                            reads nothing through them, because org_groups
--                            and org_group_members admit admins only, 0067)
--
-- BEFORE the apply (read-only; role postgres; record ids and counts only;
-- on production every count is expected to be 0):
--   Q0  the environment: is this file already pasted, and what are the
--       course view's columns today?
--         select to_regclass('public.package_certifications') as has_0100,
--                to_regclass('public.revision_visits') as has_0103,
--                to_regclass('public.v_group_members_expanded') as has_0105,
--                (select string_agg(column_name, ',' order by ordinal_position)
--                   from information_schema.columns
--                  where table_schema = 'public'
--                    and table_name = 'v_course_enrollments_expanded') as course_view_columns;
--         expected: has_0105 null; course_view_columns 'course_id,user_id'.
--   Q1  assignment rows by kind, both tables (how many group and path rows
--       start counting):
--         select 'course' as tbl, assignee_type, count(*) from public.course_assignments group by 1, 2
--         union all
--         select 'path', assignee_type, count(*) from public.learning_path_assignments group by 1, 2
--         order by 1, 2;
--   Q2  rows the release gate holds back today, by course (these courses are
--       the only ones allowed to read less in A4):
--         select 'direct' as kind, ca.course_id, count(*) as rows
--         from public.course_assignments ca where ca.release_at > now() group by 1, 2
--         union all
--         select 'step', s.course_id, count(*)
--         from public.learning_path_courses s where s.release_at > now() group by 1, 2
--         order by 1, 2;
--       'direct': a direct row that stops counting until its date (owner
--       decision 7). 'step': a course some path still holds back; learners
--       reached otherwise who are assigned to that path, or any learner when
--       the path is org_public, stop counting until the step's date.
--   Q3  dynamic groups with a rule key outside the dialect of
--       lib/org/groups.ts (expected: no row; a row is reported before the
--       paste, never silently ignored):
--         select g.id, g.organization_id, k.key
--         from public.org_groups g
--         cross join lateral jsonb_object_keys(coalesce(g.rules, '{}'::jsonb)) as k(key)
--         where g.group_type = 'dynamic'
--           and k.key not in ('designations', 'job_roles', 'cities', 'states', 'verticals',
--                             'branches', 'departments', 'team_ids', 'l1_manager_ids',
--                             'joined_within_days');
--   Q3b rule values the two twins would read differently (header items a
--       and b; expected: no row; a row is reported before the paste):
--         select g.id, k.key, x.e #>> '{}' as value
--         from public.org_groups g
--         cross join lateral jsonb_each(coalesce(g.rules, '{}'::jsonb)) as k(key, val)
--         cross join lateral jsonb_array_elements(
--                 case when jsonb_typeof(k.val) = 'array' then k.val else '[]'::jsonb end) as x(e)
--         where g.group_type = 'dynamic'
--           and jsonb_typeof(x.e) = 'string'
--           and (
--             regexp_replace(x.e #>> '{}', '^\s+|\s+$', '', 'g')
--               ~ '^[   -     　﻿]|[   -     　﻿]$'
--             or (k.key = 'team_ids'
--                 and lower(regexp_replace(x.e #>> '{}', '^\s+|\s+$', '', 'g'))
--                     !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
--           );
--   Q4  the per-course count under today's view, kept for A4 and A8:
--         select course_id, count(*) as enrolled
--         from public.v_course_enrollments_expanded
--         group by course_id order by enrolled desc, course_id;
--       The first row is "the largest course" that A8 reads.
--   Q5  the matview's current numbers and age, kept for A1 and A6:
--         select course_id, total_enrolled, not_started, refreshed_at
--         from public.mv_course_enrollment_status order by course_id;
--       Also, for A1's budget, the last refresh durations if the environment
--       recorded them; otherwise run `select public.refresh_report_views();`
--       once before the paste and note each entry's ms.
--   Q6  inactive paths that still carry assignments (their learners stop
--       counting for the course through that path):
--         select lp.id, count(pa.id) as assignments
--         from public.learning_paths lp
--         join public.learning_path_assignments pa on pa.path_id = lp.id
--         where not lp.is_active group by lp.id;
--   Q7  the 0031 views are readable by authenticated today (0031 wrote no
--       grant and relied on default privileges; the new code reads the course
--       view with an admin session before this file is pasted):
--         select has_table_privilege('authenticated', 'public.v_course_enrollments_expanded', 'select') as course_view,
--                has_table_privilege('authenticated', 'public.v_path_enrollments_expanded', 'select') as path_view;
--       Both true: the code-first order holds. Either false: paste this file
--       BEFORE the code deploy on that environment (header, ORDER).
--   Q8  the roles' statement timeouts (an admin page reads the course view
--       as authenticated; a timed-out read fails soft to "Enrolled 0"):
--         select rolname, rolconfig from pg_roles
--         where rolname in ('anon', 'authenticated', 'service_role', 'authenticator');
--       Record the authenticated value beside A8.
--   On staging the Q1, Q2, Q3, Q3b, Q6, Q7 and Q8 results are recorded under
--   ADR 0020's acceptance note (ids and counts only).
--
-- AFTER the apply (read-only except the two refreshes):
--   A1  select public.refresh_report_views();
--         six entries, every one error = null; then
--       select public.refresh_gamification_views();
--         two entries (mv_leaderboard, mv_learner_metrics), every one
--         error = null. Note the `ms` of mv_course_enrollment_status,
--         mv_course_performance and mv_learner_metrics beside their Q5-era
--         values. Budget: each within ten times its previous value, or under
--         5 s. Over budget on staging: the owner is told before the
--         production paste is scheduled; nothing is undone.
--   A2  the three views keep security_invoker (both spellings accepted):
--         select relname from pg_class
--         where relname in ('v_course_enrollments_expanded', 'v_path_enrollments_expanded',
--                           'v_group_members_expanded')
--           and not (coalesce(reloptions::text, '') ~ 'security_invoker=(on|true)');
--         no row.
--   A3  the privilege matrix (every row returned is a privilege that differs
--       from the expectation; the expected result is no row; a row here is a
--       defect in this file, not an environment fact to note):
--         select r.rol, v.obj, 'select' as priv
--         from (values ('anon'), ('authenticated'), ('service_role')) as r(rol)
--         cross join (values ('public.v_course_enrollments_expanded'),
--                            ('public.v_path_enrollments_expanded'),
--                            ('public.v_group_members_expanded')) as v(obj)
--         where has_table_privilege(r.rol, v.obj, 'select')
--               is distinct from (r.rol in ('authenticated', 'service_role'))
--         union all
--         select r.rol, f.fn, 'execute'
--         from (values ('public.group_rule_values(jsonb,text)'),
--                      ('public.group_rule_days(jsonb)'),
--                      ('public.group_member_ids(uuid)')) as f(fn)
--         cross join (values ('anon'), ('authenticated'), ('service_role')) as r(rol)
--         where has_function_privilege(r.rol, f.fn, 'execute')
--               is distinct from (r.rol in ('authenticated', 'service_role'));
--         no row.
--   A4  the per-course count under the new view, beside Q4: every course
--       reads at least its Q4 value, except a course named in Q2 (a future
--       direct row, or a step some path still holds back), which may read
--       less. Any other course reading less is a defect, reported.
--         select course_id, count(*) as enrolled
--         from public.v_course_enrollments_expanded
--         group by course_id order by enrolled desc, course_id;
--   A5  the dynamic-group twin against the display cache (informational:
--       member_count is a cache written by the app, so a small difference
--       is age, not a defect; a large one is reported):
--         select g.id, g.group_type, g.member_count,
--                (select count(*) from public.v_group_members_expanded x where x.group_id = g.id) as view_count
--         from public.org_groups g where g.is_active order by g.id;
--   A6  the refreshed matview equals the view (same instant as A1, so a
--       step released between the two reads is the only admissible gap):
--         select m.course_id, m.total_enrolled, v.enrolled
--         from public.mv_course_enrollment_status m
--         full join (select course_id, count(*) as enrolled
--                    from public.v_course_enrollments_expanded group by course_id) v
--           on v.course_id = m.course_id
--         where m.total_enrolled is distinct from v.enrolled;
--         no row.
--   A7  the course view still has exactly its two columns (Q0's read again):
--         'course_id,user_id'; and the path view 'path_id,user_id'.
--   A8  one-course read cost, on the largest course of Q4 (the admin pages
--       read exactly this shape, as authenticated, under Q8's timeout):
--         explain (analyze, buffers)
--         select user_id from public.v_course_enrollments_expanded
--         where course_id = '<the first course_id of Q4>';
--       Budget: Execution Time under 1 s (the independent check of ADR 0020
--       read 6 to 18 ms on PGlite with 3,000 members and 41 dynamic groups;
--       native Postgres is faster). Over budget: the owner is told before the
--       code is left live with this file; the first remedy is an index on
--       course_assignments (course_id, assignee_type), in a later file.
--       Production has no course: A8 is recorded as not performed there.
--   On staging the A1 ms values, A4, A5 and A8's Execution Time are recorded
--   under ADR 0020's acceptance note.

begin;

-- A lock wait must never queue the app's reads behind this file: if a lock
-- is not granted within 5 s the whole transaction rolls back cleanly and can
-- simply be applied again.
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 0. Prerequisites
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
  v_cols text;
begin
  if to_regclass('public.v_course_enrollments_expanded') is null
     or to_regclass('public.v_path_enrollments_expanded') is null then
    raise exception '0105 refused: the 0031 enrolment views are missing (apply 0031 first).';
  end if;
  select string_agg(column_name, ',' order by ordinal_position) into v_cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'v_course_enrollments_expanded';
  if v_cols is distinct from 'course_id,user_id' then
    raise exception '0105 refused: v_course_enrollments_expanded has columns (%), not (course_id,user_id).', v_cols;
  end if;
  select string_agg(column_name, ',' order by ordinal_position) into v_cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'v_path_enrollments_expanded';
  if v_cols is distinct from 'path_id,user_id' then
    raise exception '0105 refused: v_path_enrollments_expanded has columns (%), not (path_id,user_id).', v_cols;
  end if;
  if to_regclass('public.org_groups') is null or to_regclass('public.org_group_members') is null then
    raise exception '0105 refused: org_groups / org_group_members are missing (apply 0067 first).';
  end if;
  if to_regclass('public.mv_course_enrollment_status') is null
     or to_regclass('public.mv_course_performance') is null then
    raise exception '0105 refused: the course report matviews are missing (apply 0090 and 0099 first).';
  end if;
  if to_regprocedure('public.refresh_report_views()') is null then
    raise exception '0105 refused: public.refresh_report_views() is missing (apply 0035 first).';
  end if;
  for r in
    select * from (values
      ('organization_members',      'status',            '0011'),
      ('organization_members',      'date_of_joining',   '0011'),
      ('organization_members',      'designation',       '0011'),
      ('organization_members',      'job_role',          '0011'),
      ('organization_members',      'line_manager_id',   '0011'),
      ('organization_members',      'city',              '0011'),
      ('organization_members',      'state',             '0011'),
      ('organization_members',      'business_vertical', '0056'),
      ('organization_members',      'branch',            '0056'),
      ('organization_members',      'department',        '0096'),
      ('learning_paths',            'is_active',         '0017'),
      ('learning_paths',            'visibility',        '0033'),
      ('course_assignments',        'release_at',        '0052'),
      ('learning_path_courses',     'release_at',        '0052'),
      ('course_assignments',        'group_id',          '0069'),
      ('learning_path_assignments', 'group_id',          '0069'),
      ('org_groups',                'group_type',        '0067'),
      ('org_groups',                'rules',             '0067'),
      ('org_groups',                'is_active',         '0067'),
      ('org_groups',                'system_key',        '0096')
    ) as t(tbl, col, mig)
  loop
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = r.tbl and column_name = r.col
    ) then
      raise exception '0105 refused: %.% is missing (apply % first).', r.tbl, r.col, r.mig;
    end if;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 1. group_rule_values(jsonb, text): one rule list, as parseGroupRules reads it
-- ---------------------------------------------------------------------------
-- lib/org/groups.ts parseGroupRules: for each known key, keep the array's
-- string elements, trim them, drop the empty ones, keep the first of the
-- remaining values up to the cap. A missing key, a non-array value or an
-- empty result is a wildcard (an empty array here). The trim strips any
-- whitespace at both ends (the \s class), as JavaScript trim() does for the
-- ASCII cases; header item a records the residual difference. Immutable: it
-- reads only its arguments. It holds an aggregate, so the planner cannot
-- inline it; section 3 therefore calls it once per key per group, never per
-- member.
create or replace function public.group_rule_values(p_rules jsonb, p_key text)
returns text[]
language sql
immutable
as $$
  select coalesce(array_agg(t.v order by t.ord), '{}'::text[])
  from (
    select regexp_replace(x.e #>> '{}', '^\s+|\s+$', '', 'g') as v, x.ord
    from jsonb_array_elements(
           case when jsonb_typeof(p_rules -> p_key) = 'array' then p_rules -> p_key else '[]'::jsonb end
         ) with ordinality as x(e, ord)
    where jsonb_typeof(x.e) = 'string'
      and regexp_replace(x.e #>> '{}', '^\s+|\s+$', '', 'g') <> ''
    order by x.ord
    limit 200
  ) t;
$$;

comment on function public.group_rule_values(jsonb, text) is
  'The SQL twin of lib/org/groups.ts parseGroupRules for one array key (0105, ADR 0020): strings only, trimmed of whitespace at both ends, empties dropped, the first 200; an empty array is a wildcard.';

revoke all on function public.group_rule_values(jsonb, text) from public, anon;
grant execute on function public.group_rule_values(jsonb, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. group_rule_days(jsonb): joined_within_days, or null
-- ---------------------------------------------------------------------------
-- parseGroupRules keeps joined_within_days when it is a finite number from 1
-- to the ten-year cap, rounded (Math.round and round(numeric) agree on
-- positive values).
create or replace function public.group_rule_days(p_rules jsonb)
returns integer
language sql
immutable
as $$
  select case
    when jsonb_typeof(p_rules -> 'joined_within_days') = 'number'
     and (p_rules ->> 'joined_within_days')::numeric >= 1
     and (p_rules ->> 'joined_within_days')::numeric <= 3650
    then round((p_rules ->> 'joined_within_days')::numeric)::integer
  end;
$$;

comment on function public.group_rule_days(jsonb) is
  'The SQL twin of lib/org/groups.ts parseGroupRules for joined_within_days (0105, ADR 0020): a number from 1 to 3650, rounded; otherwise null (no rule).';

revoke all on function public.group_rule_days(jsonb) from public, anon;
grant execute on function public.group_rule_days(jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. group_member_ids(uuid): the members of one group, the twin of
--    resolveGroupMembers
-- ---------------------------------------------------------------------------
-- Static groups: their membership rows, whatever the member's status (as the
-- TypeScript resolver reads them). Dynamic groups: every ACTIVE member of the
-- group's organisation whom every rule admits (fetchActiveMembers reads
-- status = 'active'; the rules AND together; inList: an empty list matches
-- everyone, otherwise the member's value, null read as '', must be listed).
-- team_ids: a member of any listed team (the resolver's teamSet), the rule
-- values and the team ids both compared in lower case: the resolver's .in()
-- casts each value to uuid, which ignores case, so an upper-case team uuid
-- matches there and must match here. ARRAY(...) of no row is '{}', so a group
-- without the rule stays a wildcard.
-- joined_within_days: date_of_joining on or after the UTC date N days ago
-- (the resolver's new Date(Date.now() - N days).toISOString().slice(0, 10)).
-- An inactive group answers no row, as every caller of the resolver filters
-- inactive groups out; an unknown id answers no row.
--
-- The rule arrays are computed ONCE per group in the lateral subquery
-- (`offset 0` keeps the planner from folding it into the member filter, which
-- would call group_rule_values for every member row). The views call this
-- function per assigned group, so a read for one course expands only that
-- course's groups. Not security definer: it reads as the caller, under the
-- caller's RLS, like the invoker views that call it.
--
-- The vertical and department assignment of 0096 is a dynamic group with
-- system_key and the rule { verticals: [v], departments: [d] }
-- (lib/org/scope-groups.ts), so it is covered by the verticals and
-- departments lines below.
create or replace function public.group_member_ids(p_group_id uuid)
returns table (user_id uuid)
language sql
stable
as $$
  -- static membership rows
  select gm.user_id
  from public.org_groups g
  join public.org_group_members gm on gm.group_id = g.id
  where g.id = p_group_id
    and g.is_active
    and g.group_type = 'static'
  union all
  -- dynamic: active members every rule admits
  select m.user_id
  from public.org_groups g
  cross join lateral (
    select public.group_rule_values(g.rules, 'designations')   as des,
           public.group_rule_values(g.rules, 'job_roles')      as jr,
           public.group_rule_values(g.rules, 'cities')         as ci,
           public.group_rule_values(g.rules, 'states')         as st,
           public.group_rule_values(g.rules, 'verticals')      as ve,
           public.group_rule_values(g.rules, 'branches')       as br,
           public.group_rule_values(g.rules, 'departments')    as de,
           public.group_rule_values(g.rules, 'l1_manager_ids') as l1,
           array(select lower(t.v)
                 from unnest(public.group_rule_values(g.rules, 'team_ids')) as t(v)) as te,
           public.group_rule_days(g.rules)                     as days
    offset 0
  ) r
  join public.organization_members m
    on m.organization_id = g.organization_id
   and m.status = 'active'
  where g.id = p_group_id
    and g.is_active
    and g.group_type = 'dynamic'
    and (cardinality(r.des) = 0 or coalesce(m.designation, '')            = any (r.des))
    and (cardinality(r.jr)  = 0 or coalesce(m.job_role, '')               = any (r.jr))
    and (cardinality(r.ci)  = 0 or coalesce(m.city, '')                   = any (r.ci))
    and (cardinality(r.st)  = 0 or coalesce(m.state, '')                  = any (r.st))
    and (cardinality(r.ve)  = 0 or coalesce(m.business_vertical, '')      = any (r.ve))
    and (cardinality(r.br)  = 0 or coalesce(m.branch, '')                 = any (r.br))
    and (cardinality(r.de)  = 0 or coalesce(m.department, '')             = any (r.de))
    and (cardinality(r.l1)  = 0 or coalesce(m.line_manager_id::text, '')  = any (r.l1))
    and (
      cardinality(r.te) = 0
      or exists (
        select 1 from public.team_members tm
        where tm.user_id = m.user_id
          and lower(tm.team_id::text) = any (r.te)
      )
    )
    and (
      r.days is null
      or (
        m.date_of_joining is not null
        and m.date_of_joining >= (timezone('utc', now()) - make_interval(days => r.days))::date
      )
    );
$$;

comment on function public.group_member_ids(uuid) is
  'The members of one Custom Group, live (0105, ADR 0020): static rows, or for a dynamic group every active member its rules admit; the SQL twin of lib/org/groups.ts resolveGroupMembers. An inactive or unknown group answers no row. Reads as the caller.';

revoke all on function public.group_member_ids(uuid) from public, anon;
grant execute on function public.group_member_ids(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. v_group_members_expanded: every active group with its members
-- ---------------------------------------------------------------------------
-- security_invoker: org_groups and org_group_members admit admins only
-- (0067), so a learner's session reads nothing through this view; the
-- matview refresh runs as the definer and sees every row. The function
-- already answers no row for an inactive group; the where clause repeats the
-- rule so the view reads it plainly.
create or replace view public.v_group_members_expanded with (security_invoker = on) as
select
  g.id as group_id,
  g.organization_id,
  x.user_id
from public.org_groups g
cross join lateral public.group_member_ids(g.id) as x
where g.is_active;

alter view public.v_group_members_expanded set (security_invoker = on);

comment on view public.v_group_members_expanded is
  'Custom Group membership, live (0105, ADR 0020): static rows, and for a dynamic group every active member its rules admit; the SQL twin of lib/org/groups.ts resolveGroupMembers, through group_member_ids. Inactive groups are absent.';

revoke all on public.v_group_members_expanded from anon;
grant select on public.v_group_members_expanded to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. v_path_enrollments_expanded: the 0031 body plus Custom Groups
-- ---------------------------------------------------------------------------
-- Same two columns (path_id, user_id), same first three branches as 0031,
-- byte for byte in effect; the fourth closes the 0069 "KNOWN v1 GAP" for
-- path assignments. The matviews that read it (mv_path_enrollment_status,
-- mv_path_performance, mv_learner_metrics) keep working and show the new
-- rows at their next refresh (A1).
create or replace view public.v_path_enrollments_expanded with (security_invoker = on) as
-- direct user assignments
select
  pa.path_id,
  pa.user_id
from public.learning_path_assignments pa
where pa.assignee_type = 'user'
  and pa.user_id is not null
union
-- team assignments
select
  pa.path_id,
  tm.user_id
from public.learning_path_assignments pa
join public.team_members tm on tm.team_id = pa.team_id
where pa.assignee_type = 'team'
  and pa.team_id is not null
union
-- org-wide assignments
select
  pa.path_id,
  om.user_id
from public.learning_path_assignments pa
join public.learning_paths lp on lp.id = pa.path_id
join public.organization_members om on om.organization_id = lp.organization_id
where pa.assignee_type = 'org'
union
-- 0105: Custom Group assignments (0069), one function call per assigned group
select
  pa.path_id,
  x.user_id
from public.learning_path_assignments pa
cross join lateral public.group_member_ids(pa.group_id) as x
where pa.assignee_type = 'group'
  and pa.group_id is not null;

alter view public.v_path_enrollments_expanded set (security_invoker = on);

comment on view public.v_path_enrollments_expanded is
  'Learners a Learning Path assignment reaches (0031; 0105 adds Custom Groups, ADR 0020): user, team, org-wide and group rows. Distinct (path_id, user_id). Read by the path report matviews and the course enrolment view.';

revoke all on public.v_path_enrollments_expanded from anon;
grant select on public.v_path_enrollments_expanded to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. v_course_enrollments_expanded: direct and path learners, released only,
--    minus the pairs an enforced path still holds back
-- ---------------------------------------------------------------------------
-- Same two columns (course_id, user_id). A learner counts for a course when
-- any assignment reaches them: a direct row of any kind whose release_at is
-- null or past (0052: null = released now), or a step of an ACTIVE path they
-- are assigned to whose own release_at is null or past (the owner's option
-- A). Then the launch page's second gate is applied (launch/page.tsx
-- 584-668): while ANY enforced path (one the learner is assigned to, or an
-- org_public one) holds this course as a step with a future release_at, the
-- learner cannot open the course and does not count. The page reads every
-- path holding the course, active or not, and so does the hold-back here;
-- the admin bypass of the page (659) is not copied (header item c).
-- A learner reached directly and through two paths counts once (union is
-- distinct). The path branch starts from the course (learning_path_courses)
-- so a one-course read expands only the paths holding that course.
--
-- now() is evaluated when the view is read: the two course matviews snapshot
-- it at their scheduled refresh and the admin pages read it live, so a step
-- that releases at 09:00 is in the page from 09:00 and in the matviews from
-- the next refresh. Journey days, org_public visibility and content_scopes
-- are not assignments and are not counted (unchanged); org_public matters
-- here only as a hold-back.
create or replace view public.v_course_enrollments_expanded with (security_invoker = on) as
select
  e.course_id,
  e.user_id
from (
  -- direct user assignments, released
  select
    ca.course_id,
    ca.user_id
  from public.course_assignments ca
  where ca.assignee_type = 'user'
    and ca.user_id is not null
    and (ca.release_at is null or ca.release_at <= now())
  union
  -- team assignments expanded via team_members, released
  select
    ca.course_id,
    tm.user_id
  from public.course_assignments ca
  join public.team_members tm on tm.team_id = ca.team_id
  where ca.assignee_type = 'team'
    and ca.team_id is not null
    and (ca.release_at is null or ca.release_at <= now())
  union
  -- org-wide assignments expanded via organization_members, released
  select
    ca.course_id,
    om.user_id
  from public.course_assignments ca
  join public.courses c on c.id = ca.course_id
  join public.organization_members om on om.organization_id = c.organization_id
  where ca.assignee_type = 'org'
    and (ca.release_at is null or ca.release_at <= now())
  union
  -- 0105: Custom Group assignments (0069), released, one call per group
  select
    ca.course_id,
    x.user_id
  from public.course_assignments ca
  cross join lateral public.group_member_ids(ca.group_id) as x
  where ca.assignee_type = 'group'
    and ca.group_id is not null
    and (ca.release_at is null or ca.release_at <= now())
  union
  -- 0105: released steps of active Learning Paths the learner is assigned
  -- to, from the course (ADR 0020, the owner's option A)
  select
    lpc.course_id,
    pe.user_id
  from public.learning_path_courses lpc
  join public.learning_paths lp on lp.id = lpc.path_id and lp.is_active
  cross join lateral (
    select pe0.user_id
    from public.v_path_enrollments_expanded pe0
    where pe0.path_id = lpc.path_id
    offset 0
  ) as pe
  where lpc.release_at is null or lpc.release_at <= now()
) as e
where not exists (
  -- the launch page's hold-back: an enforced path (assigned, or org_public)
  -- still holds this course as an unreleased step
  select 1
  from public.learning_path_courses s
  join public.learning_paths sp on sp.id = s.path_id
  where s.course_id = e.course_id
    and s.release_at > now()
    and (
      sp.visibility = 'org_public'
      or exists (
        select 1
        from public.v_path_enrollments_expanded pe
        where pe.path_id = s.path_id
          and pe.user_id = e.user_id
      )
    )
);

alter view public.v_course_enrollments_expanded set (security_invoker = on);

comment on view public.v_course_enrollments_expanded is
  'Learners enrolled on a course (0031; 0105, ADR 0020): every released direct assignment (user, team, org-wide, Custom Group) and every released step of an active Learning Path assigned to the learner, minus the learners an enforced path (assigned or org_public) still holds back with an unreleased step. Distinct (course_id, user_id). The one definition of "enrolled" for the course report matviews and lib/scoring/status.ts loadEnrolledCourseStatus.';

revoke all on public.v_course_enrollments_expanded from anon;
grant select on public.v_course_enrollments_expanded to authenticated, service_role;

notify pgrst, 'reload schema';

commit;
