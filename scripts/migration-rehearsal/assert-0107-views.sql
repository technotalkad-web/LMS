-- scripts/migration-rehearsal/assert-0107-views.sql
-- Scenarios "0105-0106-then-0107" and "0106-then-0105-then-0107" (after the
-- first paste and again after the second), "0107-refused-q8" and
-- "0107-refused-q2" (after the two pastes that follow the repair): what
-- section 4 of 0107_learning_contexts.sql (ADR 0024 section B, creation
-- order item 4: the views of steps 9 and 18, with build notes N8 to N12 and
-- O1-d) must have done. Its own file, because the checks of
-- assert-0107.sql leave rows in their transaction (paths, completions, step
-- facts, attempts) that the views read; here every view is read on the
-- committed rows first. The checks continue assert-0107.sql's numbering:
--   (13) the objects: each view's columns, security_invoker, privileges,
--        comment and what its body reads
--   (14) refresh_report_views() on the recreated views: six view entries
--        and the completion sweep's entry last (step 16), none with an
--        error, and the LIVE course and path matviews equal the views they
--        read
--   (15) the seed through the views, and the invariants of the official
--        rule on every row (run again after the fixtures)
--   (16) the terms views (decision A9) on fixture assignments
--   (17) the path views on fixture rows: the cases of the twins contract
--        (section 3.5) and notes N9 to N12
--   (18) the stored step fact (build note O1-d; the static halves of O1-g
--        (1) to (4), (6) to (8) and (11)): a fact is inserted by the
--        writer's own statement (O1-c), run here as postgres, because the
--        writer of step 12 comes with a later slice
--   (19) as the API roles: a learner and an admin read the same rows as
--        postgres, a member of another organisation reads none, anon is
--        refused (42501)
-- The fixture rows have ids whose last group starts 00010715. The whole file
-- is one transaction that ends in ROLLBACK. Every check raises
-- 'assert-0107: (n) …' on failure; the runner then reports the file as
-- failed and stops the scenario.
--
-- PGlite runs as postgres. grants-0107.sql gave anon and authenticated
-- select on every table that existed before the paste; the views of section
-- 4 hold what 0107 grants them. Timestamps compared with now() are at or
-- before 2001-01-01 or at or after 2999-01-01 (twins contract 1.5).
begin;

create function pg_temp.as_owner_state(p_stmt text) returns text
language plpgsql as $$
declare
  got text := 'no error';
  n   bigint;
begin
  begin
    execute p_stmt;
    get diagnostics n = row_count;
    got := 'no error, ' || n || ' row(s)';
  exception when others then
    got := sqlstate;
  end;
  return got;
end
$$;

-- Readable renderings of the views (ids of the fixture courses read C01 to
-- C11 and of its attempts a01 to a99; any other id reads its last six
-- characters).
create function pg_temp.lbl_0107v(p uuid) returns text language sql immutable as $$
  select case
    when p is null then '-'
    when p::text like '00000000-0000-0000-0000-0001071510__' then 'C' || right(p::text, 2)
    when p::text like '00000000-0000-0000-0000-0001071530__' then 'a' || right(p::text, 2)
    else right(p::text, 6)
  end
$$;

create function pg_temp.b_0107v(p boolean) returns text language sql immutable as $$
  select case when p then 'T' when not p then 'F' else 'null' end
$$;

create function pg_temp.steps_0107v(p_path uuid, p_user uuid) returns text language sql stable as $$
  select coalesce(string_agg(
           format('%s#%s pr=%s pbr=%s fact=%s pe=%s done=%s res=%s sc=%s off=%s rl=%s f=%s open=%s',
                  pg_temp.lbl_0107v(s.course_id), s.step_number, pg_temp.b_0107v(s.pass_required),
                  pg_temp.b_0107v(s.passed_by_rule), pg_temp.b_0107v(s.done_recorded_at is not null),
                  pg_temp.b_0107v(s.passed_ever), pg_temp.b_0107v(s.done), coalesce(s.latest_result, '-'),
                  coalesce(s.latest_score::text, '-'), pg_temp.lbl_0107v(s.official_attempt_id),
                  pg_temp.b_0107v(s.retake_live), pg_temp.b_0107v(s.failed), pg_temp.b_0107v(s.open_attempt)),
           '; ' order by s.step_number), 'none')
  from public.v_path_step_status s
  where s.path_id = p_path and s.user_id = p_user
$$;

create function pg_temp.prog_0107v(p_path uuid, p_user uuid) returns text language sql stable as $$
  select coalesce(string_agg(
           format('%s/%s next=%s nc=%s score=%s comp=%s status=%s due=%s started=%s done_at=%s over=%s',
                  p.steps_done, p.steps_total, coalesce(p.next_step::text, '-'), pg_temp.lbl_0107v(p.next_course_id),
                  coalesce(round(p.path_score, 4)::text, '-'), pg_temp.b_0107v(p.completed), p.status,
                  coalesce(to_char(p.due_at at time zone 'UTC', 'YYYY-MM-DD'), '-'),
                  pg_temp.b_0107v(p.started_at is not null), pg_temp.b_0107v(p.completed_at is not null),
                  pg_temp.b_0107v(p.overdue)),
           ' | '), 'none')
  from public.v_path_progress p
  where p.path_id = p_path and p.user_id = p_user
$$;

create function pg_temp.allprog_0107v(p_path uuid) returns text language sql stable as $$
  select coalesce(string_agg(pg_temp.lbl_0107v(p.user_id) || ': ' || pg_temp.prog_0107v(p.path_id, p.user_id), '; '
                             order by p.user_id), 'none')
  from public.v_path_progress p
  where p.path_id = p_path
$$;

create function pg_temp.terms_0107v(p_kind text, p_id uuid, p_user uuid) returns text language sql stable as $$
  select coalesce(string_agg(format('due=%s at=%s', coalesce(to_char(t.due_at at time zone 'UTC', 'YYYY-MM-DD'), '-'),
                                    to_char(t.enrolled_at at time zone 'UTC', 'YYYY-MM-DD')), ' | '), 'none')
  from (
    select due_at, enrolled_at from public.v_course_enrollment_terms
     where p_kind = 'course' and course_id = p_id and user_id = p_user
    union all
    select due_at, enrolled_at from public.v_path_enrollment_terms
     where p_kind = 'path' and path_id = p_id and user_id = p_user
  ) t
$$;

create function pg_temp.ctx_0107v(p_user uuid) returns text language sql stable as $$
  select coalesce(string_agg(format('%s %s off=%s st=%s n=%s live=%s piw=%s', pg_temp.lbl_0107v(s.course_id),
                                    s.context_key, pg_temp.lbl_0107v(s.official_attempt_id), coalesce(s.official_status, '-'),
                                    s.attempt_count, s.live_attempt_count, pg_temp.b_0107v(s.passed_in_window)),
                             '; ' order by s.course_id, s.context_key), 'none')
  from public.v_context_attempt_summary s
  where s.user_id = p_user
$$;

-- The invariants of section 4 on every row, whatever the fixture: each grain
-- holds; the old-name views are the Individual rows of the context views,
-- column for column; every official attempt is a row of its own context
-- under the official rule; no preview is any context's row; a context's
-- tags agree with its key; the path views have a row exactly per enrolled
-- learner and their counts agree; each terms view has a row exactly where
-- its enrolment view has one.
create function pg_temp.invariants_0107v() returns text[] language plpgsql as $$
declare
  bad text[] := '{}';
  n   bigint;
begin
  select count(*) - count(distinct (course_id, user_id, context_key)) into n from public.v_context_attempt_summary;
  if n <> 0 then bad := bad || format('v_context_attempt_summary repeats %s (course, learner, context_key)', n); end if;
  select count(*) - count(distinct (course_id, user_id, context_key)) into n from public.v_context_attempt_scoring;
  if n <> 0 then bad := bad || format('v_context_attempt_scoring repeats %s (course, learner, context_key)', n); end if;
  select count(*) - count(distinct (course_id, user_id)) into n from public.v_course_attempt_summary;
  if n <> 0 then bad := bad || format('v_course_attempt_summary repeats %s (course, learner)', n); end if;
  select count(*) - count(distinct (course_id, user_id)) into n from public.v_course_attempt_scoring;
  if n <> 0 then bad := bad || format('v_course_attempt_scoring repeats %s (course, learner)', n); end if;

  select count(*) into n from (
    (select course_id, user_id, latest_completion, latest_success, best_score, total_time_seconds, attempt_count,
            ever_completed, ever_passed, official_score, first_score, latest_score, scored_attempts, practice_attempts,
            official_basis, max_scored_attempts, first_completed_passed, official_status, official_attempt_id,
            live_attempt_count, latest_live_completion, latest_live_success
       from public.v_course_attempt_summary
     except
     select course_id, user_id, latest_completion, latest_success, best_score, total_time_seconds, attempt_count,
            ever_completed, ever_passed, official_score, first_score, latest_score, scored_attempts, practice_attempts,
            official_basis, max_scored_attempts, first_completed_passed, official_status, official_attempt_id,
            live_attempt_count, latest_live_completion, latest_live_success
       from public.v_context_attempt_summary where context_key = 'individual')
    union all
    (select course_id, user_id, latest_completion, latest_success, best_score, total_time_seconds, attempt_count,
            ever_completed, ever_passed, official_score, first_score, latest_score, scored_attempts, practice_attempts,
            official_basis, max_scored_attempts, first_completed_passed, official_status, official_attempt_id,
            live_attempt_count, latest_live_completion, latest_live_success
       from public.v_context_attempt_summary where context_key = 'individual'
     except
     select course_id, user_id, latest_completion, latest_success, best_score, total_time_seconds, attempt_count,
            ever_completed, ever_passed, official_score, first_score, latest_score, scored_attempts, practice_attempts,
            official_basis, max_scored_attempts, first_completed_passed, official_status, official_attempt_id,
            live_attempt_count, latest_live_completion, latest_live_success
       from public.v_course_attempt_summary)
  ) d;
  if n <> 0 then
    bad := bad || format('v_course_attempt_summary differs from the Individual rows of v_context_attempt_summary in %s row(s)', n);
  end if;

  select count(*) into n from (
    (select course_id, user_id, max_scored_attempts, official_basis, official_attempt_number, completed_attempts,
            scored_attempts, practice_attempts, first_score, best_score, latest_score, official_score, official_status,
            official_attempt_id
       from public.v_course_attempt_scoring
     except
     select course_id, user_id, max_scored_attempts, official_basis, official_attempt_number, completed_attempts,
            scored_attempts, practice_attempts, first_score, best_score, latest_score, official_score, official_status,
            official_attempt_id
       from public.v_context_attempt_scoring where context_key = 'individual')
    union all
    (select course_id, user_id, max_scored_attempts, official_basis, official_attempt_number, completed_attempts,
            scored_attempts, practice_attempts, first_score, best_score, latest_score, official_score, official_status,
            official_attempt_id
       from public.v_context_attempt_scoring where context_key = 'individual'
     except
     select course_id, user_id, max_scored_attempts, official_basis, official_attempt_number, completed_attempts,
            scored_attempts, practice_attempts, first_score, best_score, latest_score, official_score, official_status,
            official_attempt_id
       from public.v_course_attempt_scoring)
  ) d;
  if n <> 0 then
    bad := bad || format('v_course_attempt_scoring differs from the Individual rows of v_context_attempt_scoring in %s row(s)', n);
  end if;

  select count(*) into n
    from public.v_context_attempt_scoring s
    left join public.course_attempts ca on ca.id = s.official_attempt_id
    left join public.course_versions cv on cv.id = ca.course_version_id
   where s.official_attempt_id is not null
     and (ca.id is null or cv.course_id <> s.course_id or ca.user_id <> s.user_id
          or ca.context_key <> s.context_key or ca.context_kind = 'preview' or ca.status = 'abandoned'
          or ca.is_revision
          or not (ca.completion_status = 'completed' or ca.success_status = 'passed'));
  if n <> 0 then
    bad := bad || format('%s official attempt(s) outside their context or the official rule', n);
  end if;
  select count(*) into n
    from public.v_context_attempt_summary s
   where s.official_attempt_id is distinct from
         (select c.official_attempt_id from public.v_context_attempt_scoring c
           where c.course_id = s.course_id and c.user_id = s.user_id and c.context_key = s.context_key);
  if n <> 0 then
    bad := bad || format('%s summary row(s) whose official attempt is not the scoring view''s', n);
  end if;

  select count(*) into n
    from public.v_context_attempt_summary s
   where s.context_kind = 'preview' or s.context_key like 'preview%'
      or s.context_key is distinct from (case s.context_kind
           when 'individual' then 'individual'
           when 'path' then 'path:' || s.learning_path_id::text
           when 'journey' then 'journey:' || s.journey_enrollment_id::text || ':' || s.journey_day_id::text
         end)
      or (s.context_kind <> 'path' and s.learning_path_id is not null)
      or (s.context_kind <> 'journey' and (s.journey_enrollment_id is not null or s.journey_day_id is not null
                                           or s.journey_day is not null));
  if n <> 0 then
    bad := bad || format('%s summary row(s) whose tags disagree with the key, or a preview', n);
  end if;

  select count(*) - count(distinct (path_id, user_id, course_id)) into n from public.v_path_step_status;
  if n <> 0 then bad := bad || format('v_path_step_status repeats %s (path, learner, course)', n); end if;
  select count(*) into n from (
    (select path_id, user_id from public.v_path_progress
     except select path_id, user_id from public.v_path_enrollments_expanded)
    union all
    (select path_id, user_id from public.v_path_enrollments_expanded
     except select path_id, user_id from public.v_path_progress)) d;
  if n <> 0 or (select count(*) - count(distinct (path_id, user_id)) from public.v_path_progress) <> 0 then
    bad := bad || 'v_path_progress does not have exactly one row per enrolled (path, learner)'::text;
  end if;
  select count(*) into n
    from public.v_path_progress p
   where p.steps_total <> (select count(*) from public.v_path_step_status s
                            where s.path_id = p.path_id and s.user_id = p.user_id)
      or p.steps_done <> (select count(*) from public.v_path_step_status s
                           where s.path_id = p.path_id and s.user_id = p.user_id and s.done)
      or p.next_step is distinct from (select min(s.step_number) from public.v_path_step_status s
                                        where s.path_id = p.path_id and s.user_id = p.user_id and not s.done)
      or p.completed is null or p.overdue is null or p.status is null
      or p.status not in ('not_started', 'in_progress', 'failed', 'completed');
  if n <> 0 then bad := bad || format('%s v_path_progress row(s) disagree with their step rows', n); end if;
  select count(*) into n
    from public.v_path_step_status s
   where s.passed_ever is null or s.passed_by_rule is null or s.done is null or s.retake_live is null
      or s.failed is null or s.open_attempt is null or s.pass_required is null
      or s.done <> s.passed_ever
      or s.passed_ever <> (s.passed_by_rule or s.done_recorded_at is not null)
      or s.failed <> (not s.passed_ever and coalesce(s.latest_result = 'failed', false) and not s.retake_live);
  if n <> 0 then bad := bad || format('%s v_path_step_status row(s) break step 44''s rule or hold a null', n); end if;

  select count(*) into n from (
    (select course_id, user_id from public.v_course_enrollment_terms
     except select course_id, user_id from public.v_course_enrollments_expanded)
    union all
    (select course_id, user_id from public.v_course_enrollments_expanded
     except select course_id, user_id from public.v_course_enrollment_terms)) d;
  if n <> 0 or (select count(*) - count(distinct (course_id, user_id)) from public.v_course_enrollment_terms) <> 0 then
    bad := bad || 'v_course_enrollment_terms does not have exactly one row per enrolled (course, learner)'::text;
  end if;
  select count(*) into n from (
    (select path_id, user_id from public.v_path_enrollment_terms
     except select path_id, user_id from public.v_path_enrollments_expanded)
    union all
    (select path_id, user_id from public.v_path_enrollments_expanded
     except select path_id, user_id from public.v_path_enrollment_terms)) d;
  if n <> 0 or (select count(*) - count(distinct (path_id, user_id)) from public.v_path_enrollment_terms) <> 0 then
    bad := bad || 'v_path_enrollment_terms does not have exactly one row per enrolled (path, learner)'::text;
  end if;
  return bad;
end
$$;

-- ---------------------------------------------------------------------------
-- (13) the objects: the nine views of section 4 with exactly their columns
--      (names, types, order; the old-name views and the course enrolment
--      view exactly as before, the context views the old lists with their
--      appended columns), security_invoker, the privilege matrix
--      (has_table_privilege per privilege), the comments, and what each body
--      reads
-- ---------------------------------------------------------------------------
do $$
declare
  bad      text[] := '{}';
  r        record;
  got      text;
  old_scor constant text :=
    'course_id uuid, user_id uuid, max_scored_attempts integer, official_basis text, official_attempt_number integer, '
    || 'completed_attempts integer, scored_attempts integer, practice_attempts integer, first_score numeric, '
    || 'best_score numeric, latest_score numeric, official_score numeric, official_status text, official_attempt_id uuid';
  old_summ constant text :=
    'course_id uuid, user_id uuid, latest_completion text, latest_success text, best_score numeric, '
    || 'total_time_seconds numeric, attempt_count bigint, ever_completed boolean, ever_passed boolean, '
    || 'official_score numeric, first_score numeric, latest_score numeric, scored_attempts integer, '
    || 'practice_attempts integer, official_basis text, max_scored_attempts integer, first_completed_passed boolean, '
    || 'official_status text, official_attempt_id uuid, live_attempt_count bigint, latest_live_completion text, '
    || 'latest_live_success text';
begin
  for r in
    select * from (values
      ('v_course_attempt_scoring', old_scor, 'old'),
      ('v_course_attempt_summary', old_summ, 'old'),
      ('v_course_enrollments_expanded', 'course_id uuid, user_id uuid', 'old'),
      ('v_context_attempt_scoring', old_scor || ', context_key text, passed_in_window boolean', 'new'),
      ('v_context_attempt_summary', old_summ || ', context_kind text, context_key text, learning_path_id uuid, '
       || 'journey_enrollment_id uuid, journey_day integer, journey_day_id uuid, passed_in_window boolean', 'new'),
      ('v_course_enrollment_terms', 'course_id uuid, user_id uuid, organization_id uuid, '
       || 'due_at timestamp with time zone, enrolled_at timestamp with time zone', 'new'),
      ('v_path_enrollment_terms', 'path_id uuid, user_id uuid, organization_id uuid, '
       || 'due_at timestamp with time zone, enrolled_at timestamp with time zone', 'new'),
      ('v_path_step_status', 'path_id uuid, user_id uuid, course_id uuid, organization_id uuid, step_number integer, '
       || 'release_at timestamp with time zone, pass_required boolean, passed_ever boolean, passed_by_rule boolean, '
       || 'done_recorded_at timestamp with time zone, latest_result text, latest_score numeric, done boolean, '
       || 'official_attempt_id uuid, retake_live boolean, failed boolean, open_attempt boolean', 'new'),
      ('v_path_progress', 'path_id uuid, user_id uuid, organization_id uuid, steps_total integer, steps_done integer, '
       || 'next_step integer, next_course_id uuid, path_score numeric, completed boolean, status text, '
       || 'due_at timestamp with time zone, enrolled_at timestamp with time zone, '
       || 'started_at timestamp with time zone, completed_at timestamp with time zone, overdue boolean', 'new')
    ) as t(v, cols, age)
  loop
    select string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod), ', ' order by a.attnum) into got
      from pg_attribute a
     where a.attrelid = to_regclass('public.' || r.v) and a.attnum > 0 and not a.attisdropped;
    if got is distinct from r.cols then
      bad := bad || format('%s has columns (%s), expected (%s)', r.v, coalesce(got, 'missing'), r.cols);
      continue;
    end if;
    if (select relkind from pg_class where oid = ('public.' || r.v)::regclass) <> 'v' then
      bad := bad || format('%s is not a view', r.v);
    end if;
    if not exists (select 1 from pg_class c, unnest(c.reloptions) o
                    where c.oid = ('public.' || r.v)::regclass and o in ('security_invoker=on', 'security_invoker=true')) then
      bad := bad || format('%s is not security_invoker', r.v);
    end if;
    -- privileges: select for authenticated and service_role on all nine;
    -- on the six new views nothing else for anyone and nothing for anon;
    -- anon never reads the course enrolment view (0105's revoke, restated)
    if not has_table_privilege('authenticated', ('public.' || r.v)::regclass, 'select')
       or not has_table_privilege('service_role', ('public.' || r.v)::regclass, 'select') then
      bad := bad || format('%s: authenticated or service_role cannot select', r.v);
    end if;
    if (r.age = 'new' or r.v = 'v_course_enrollments_expanded')
       and has_table_privilege('anon', ('public.' || r.v)::regclass, 'select') then
      bad := bad || format('%s: anon holds select', r.v);
    end if;
    if r.age = 'new' then
      select string_agg(x.who || ' ' || x.priv, ', ') into got
        from (values ('anon'), ('authenticated'), ('service_role')) w(who)
        cross join (values ('insert'), ('update'), ('delete'), ('truncate'), ('references'), ('trigger')) p(priv)
        cross join lateral (select w.who, p.priv) x
       where has_table_privilege(w.who, ('public.' || r.v)::regclass, p.priv);
      if got is not null then
        bad := bad || format('%s: privileges beyond select: %s', r.v, got);
      end if;
      if obj_description(('public.' || r.v)::regclass, 'pg_class') is null then
        bad := bad || format('%s has no comment', r.v);
      end if;
    end if;
  end loop;

  -- what each body reads (pg_get_viewdef prints the stored query)
  for r in
    select * from (values
      ('v_course_enrollments_expanded', 'learning_path', false,
       'the course enrolment view still reads a path table (its path arm or hold-back)'),
      ('v_course_enrollments_expanded', 'course_assignments', true, 'the course enrolment view lost its direct arms'),
      ('v_course_attempt_scoring', '''individual''', true, 'the old scoring view is not the Individual context'),
      ('v_course_attempt_scoring', '''abandoned''', true, 'the old scoring view does not leave abandoned rows out'),
      ('v_course_attempt_summary', '''individual''', true, 'the old summary is not the Individual context'),
      ('v_course_attempt_summary', 'v_course_attempt_scoring', true, 'the old summary does not join the old scoring view'),
      ('v_context_attempt_scoring', '''abandoned''', true, 'the context scoring view does not leave abandoned rows out'),
      ('v_context_attempt_scoring', '''preview''', true, 'the context scoring view does not leave previews out'),
      ('v_context_attempt_summary', 'v_context_attempt_scoring', true, 'the context summary does not join the context scoring view'),
      ('v_path_step_status', 'v_context_attempt_summary', true, 'the step view does not read the context summary'),
      ('v_path_step_status', 'learning_path_step_completions', true, 'the step view does not read the stored step facts'),
      ('v_path_step_status', 'instance_pass_required', false, 'the step view calls instance_pass_required'),
      ('v_path_progress', 'v_path_step_status', true, 'the path progress does not read the step view'),
      ('v_path_progress', 'learning_path_completions', true, 'the path progress does not read the completions'),
      ('v_path_progress', 'v_path_enrollment_terms', true, 'the path progress does not read the path terms')
    ) as t(v, token, present, what)
  loop
    if (strpos(pg_get_viewdef(('public.' || r.v)::regclass), r.token) > 0) <> r.present then
      bad := bad || r.what;
    end if;
  end loop;
  -- the abandoned filter of the context summary is in the live columns only
  if (select count(*) from regexp_matches(pg_get_viewdef('public.v_context_attempt_summary'::regclass),
                                          '''abandoned''', 'g')) <> 3 then
    bad := bad || 'the context summary does not read abandoned exactly in its three live columns'::text;
  end if;

  if cardinality(bad) > 0 then
    raise exception 'assert-0107: (13) %', array_to_string(bad, '; ');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (14) refresh_report_views() on the recreated views (before any fixture
--      row): six view entries and the completion sweep's entry last (step
--      16), none with an error; then the LIVE matviews equal
--      the views they read: per course, mv_course_enrollment_status and
--      mv_course_performance count the learners of
--      v_course_enrollments_expanded, and mv_course_enrollment_status's
--      completed counts those whose Individual summary is completed; per
--      path, mv_path_enrollment_status counts the learners of
--      v_path_enrollments_expanded
-- ---------------------------------------------------------------------------
do $$
declare
  res jsonb;
  bad text;
begin
  res := public.refresh_report_views();
  if jsonb_array_length(res) <> 7
     or res -> 6 ->> 'view' is distinct from 'completion_sweep'
     or exists (select 1 from jsonb_array_elements(res) e where e ->> 'error' is not null) then
    raise exception 'assert-0107: (14) refresh_report_views(): %', res;
  end if;

  select string_agg(format('%s: view %s/%s, mv_course_enrollment_status %s/%s, mv_course_performance %s',
                           coalesce(v.course_id, s.course_id, p.course_id), v.n, v.done, s.total_enrolled, s.completed,
                           p.total_enrolled), '; ')
    into bad
  from (select e.course_id, count(*) as n, count(*) filter (where su.ever_completed) as done
          from public.v_course_enrollments_expanded e
          left join public.v_course_attempt_summary su on su.course_id = e.course_id and su.user_id = e.user_id
         group by e.course_id) v
  full join public.mv_course_enrollment_status s on s.course_id = v.course_id
  full join public.mv_course_performance p on p.course_id = coalesce(v.course_id, s.course_id)
  where s.total_enrolled is distinct from v.n
     or s.completed is distinct from v.done
     or p.total_enrolled is distinct from v.n;
  if bad is not null then
    raise exception 'assert-0107: (14) the course matviews differ from the views: %', bad;
  end if;

  select string_agg(format('%s: view %s, mv_path_enrollment_status %s', coalesce(v.path_id, s.path_id), v.n,
                           s.total_enrolled), '; ')
    into bad
  from (select path_id, count(*) as n from public.v_path_enrollments_expanded group by path_id) v
  full join public.mv_path_enrollment_status s on s.path_id = v.path_id
  where s.total_enrolled is distinct from v.n;
  if bad is not null then
    raise exception 'assert-0107: (14) the path matview differs from the view: %', bad;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (15) the seed through the views (seed-0107.sql; the rows written between
--      the pastes change none of these): the invariants; the abandoned
--      completed row of seed.sql (f6) is no official attempt (note N8) and
--      its learner keeps a summary row with live_attempt_count 0; a preview
--      is never official (S's used-grant preview on K); learner B's course
--      C1 has one official attempt per context; J's journey row carries its
--      tags; the course enrolment view holds the direct arms only (P, B on
--      C2 and O on K were enrolled through paths by 0105); the path views
--      for P and B on P1 and O on P2
-- ---------------------------------------------------------------------------
do $$
declare
  bad  text[] := pg_temp.invariants_0107v();
  r    record;
  got  text;
  org  constant uuid := '00000000-0000-0000-0000-00000000000a';
  c1   constant uuid := '00000000-0000-0000-0000-0000000000c1';
  c2   constant uuid := '00000000-0000-0000-0000-0000000000c2';
  k    constant uuid := '00000000-0000-0000-0000-000107040001';
  a3   constant uuid := '00000000-0000-0000-0000-0000000000a3';
  u_b  constant uuid := '00000000-0000-0000-0000-000107010003';
  u_j  constant uuid := '00000000-0000-0000-0000-000107010004';
  u_s  constant uuid := '00000000-0000-0000-0000-000107010006';
  p1   constant uuid := '00000000-0000-0000-0000-000107050001';
  p2   constant uuid := '00000000-0000-0000-0000-000107050002';
begin
  -- f6: abandoned and completed, the only row of (C1, a3)
  if exists (select 1 from public.v_context_attempt_scoring where course_id = c1 and user_id = a3)
     or exists (select 1 from public.v_course_attempt_scoring where course_id = c1 and user_id = a3) then
    bad := bad || 'the abandoned completed row f6 is still scored'::text;
  end if;
  select format('%s off=%s n=%s live=%s compl=%s', context_key, coalesce(official_attempt_id::text, '-'), attempt_count,
                live_attempt_count, ever_completed)
    into got from public.v_context_attempt_summary where course_id = c1 and user_id = a3;
  if got is distinct from 'individual off=- n=1 live=0 compl=t' then
    bad := bad || format('(C1, a3) reads %s (expected individual off=- n=1 live=0 compl=t)', coalesce(got, 'no row'));
  end if;
  -- K, S: the used-grant preview (…070017, passed, later) is not official;
  -- the official row …070018 is
  if (select official_attempt_id from public.v_course_attempt_summary where course_id = k and user_id = u_s)
     is distinct from '00000000-0000-0000-0000-000107070018'::uuid then
    bad := bad || 'S''s official attempt on K is not the official row 070018'::text;
  end if;
  -- B on C1: Individual 070007 (0.95, with a live granted retake), path P1 070008 (1.0)
  got := pg_temp.ctx_0107v(u_b);
  if got is distinct from
     '0000c1 individual off=070007 st=passed n=2 live=2 piw=T; 0000c1 path:00000000-0000-0000-0000-000107050001 '
     || 'off=070008 st=passed n=1 live=1 piw=T; 0000c2 path:00000000-0000-0000-0000-000107050001 off=- st=- n=1 live=0 piw=F' then
    bad := bad || format('B''s contexts read %s', got);
  end if;
  -- J's journey row and its tags
  select format('%s %s je=%s jd=%s jdid=%s lp=%s off=%s', context_kind, context_key, right(journey_enrollment_id::text, 6),
                journey_day, right(journey_day_id::text, 6), coalesce(learning_path_id::text, '-'),
                right(official_attempt_id::text, 6))
    into got from public.v_context_attempt_summary where course_id = c1 and user_id = u_j;
  if got is distinct from 'journey journey:00000000-0000-0000-0000-000107063001:00000000-0000-0000-0000-000107061001 '
                          || 'je=063001 jd=1 jdid=061001 lp=- off=070011' then
    bad := bad || format('J''s journey context on C1 reads %s', coalesce(got, 'no row'));
  end if;
  -- the course enrolment view on the seed's courses: the direct rows only
  select string_agg(right(course_id::text, 6) || '/' || right(user_id::text, 6), ',' order by course_id, user_id)
    into got from public.v_course_enrollments_expanded where course_id in (c1, c2, k);
  if got is distinct from '0000c1/010001,0000c1/010003,0000c2/010001' then
    bad := bad || format('v_course_enrollments_expanded on C1, C2, K reads %s (expected the three direct rows)', got);
  end if;
  -- the path views on the seed
  for r in
    select * from (values
      (p1, '00000000-0000-0000-0000-000107010002',
       '0000c1#1 pr=F pbr=T fact=F pe=T done=T res=passed sc=0.8 off=070004 rl=F f=F open=F; '
       || '0000c2#2 pr=F pbr=F fact=F pe=F done=F res=- sc=- off=- rl=F f=F open=T',
       '1/2 next=2 nc=0000c2 score=0.8000 comp=F status=in_progress due=- started=T done_at=F over=F'),
      (p1, '00000000-0000-0000-0000-000107010003',
       '0000c1#1 pr=F pbr=T fact=F pe=T done=T res=passed sc=1.0 off=070008 rl=F f=F open=F; '
       || '0000c2#2 pr=F pbr=F fact=F pe=F done=F res=- sc=- off=- rl=F f=F open=F',
       '1/2 next=2 nc=0000c2 score=1.0000 comp=F status=in_progress due=- started=T done_at=F over=F'),
      (p2, '00000000-0000-0000-0000-000107010005',
       '040001#1 pr=F pbr=F fact=F pe=F done=F res=- sc=- off=- rl=F f=F open=T',
       '0/1 next=1 nc=040001 score=- comp=F status=in_progress due=- started=T done_at=F over=F')
    ) as t(path_id, user_id, steps, prog)
  loop
    got := pg_temp.steps_0107v(r.path_id, r.user_id::uuid);
    if got is distinct from r.steps then
      bad := bad || format('steps of %s on %s read %s (expected %s)', right(r.user_id, 6), right(r.path_id::text, 6), got, r.steps);
    end if;
    got := pg_temp.prog_0107v(r.path_id, r.user_id::uuid);
    if got is distinct from r.prog then
      bad := bad || format('progress of %s on %s reads %s (expected %s)', right(r.user_id, 6), right(r.path_id::text, 6), got, r.prog);
    end if;
  end loop;
  -- B's path context starts with 070008, not the later abandoned 070009
  if (select started_at from public.v_path_progress where path_id = p1 and user_id = u_b)
     is distinct from (select started_at from public.course_attempts where id = '00000000-0000-0000-0000-000107070008') then
    bad := bad || 'B''s started_at on P1 is not 070008''s'::text;
  end if;
  if exists (select 1 from public.v_path_step_status where organization_id <> org and path_id in (p1, p2))
     or exists (select 1 from public.v_path_progress where organization_id <> org and path_id in (p1, p2)) then
    bad := bad || 'a seed path row carries another organisation'::text;
  end if;

  if cardinality(bad) > 0 then
    raise exception 'assert-0107: (15) %', array_to_string(bad, '; ');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- The fixture world (ids 00010715…): learners L01 to L16 (Org A members);
-- courses C01 to C12, each with one SCORM 1.2 version; teams T1 (L01, L02)
-- and T2 (L02); a static Custom Group G (L07); paths PA (C01 step 1 with pass_required true, C02 step 2
-- inheriting its course's true, C03 step 3 false over its course's true),
-- PB (C05, C06), PC (C07, pass_required true), PD (C08, C09) and PT (no
-- step; for the terms) and PG (no step; assigned to G only)
-- ---------------------------------------------------------------------------
create function pg_temp.id_0107v(p text) returns uuid language sql immutable as $$
  select ('00000000-0000-0000-0000-' || p)::uuid
$$;
create function pg_temp.u_0107v(n int) returns uuid language sql immutable as $$
  select pg_temp.id_0107v('0001071500' || lpad(n::text, 2, '0'))
$$;
create function pg_temp.c_0107v(n int) returns uuid language sql immutable as $$
  select pg_temp.id_0107v('0001071510' || lpad(n::text, 2, '0'))
$$;
create function pg_temp.att_0107v(p_n int, p_course int, p_user uuid, p_path uuid, p_kind text, p_minutes int,
                                  p_score numeric) returns uuid
language plpgsql as $$
declare
  v_id   uuid := pg_temp.id_0107v('0001071530' || lpad(p_n::text, 2, '0'));
  v_st   timestamptz := now() - make_interval(mins => p_minutes);
  v_done boolean := p_kind in ('passed', 'failed', 'completed', 'abandoned_passed');
begin
  insert into public.course_attempts (id, course_version_id, user_id, organization_id, status, completion_status,
                                      success_status, score, started_at, completed_at, context_kind, is_preview,
                                      learning_path_id, launch_mode)
  values (v_id, pg_temp.id_0107v('0001071512' || lpad(p_course::text, 2, '0')), p_user,
          '00000000-0000-0000-0000-00000000000a',
          case when p_kind in ('passed', 'failed', 'completed', 'in_progress') then p_kind else 'abandoned' end,
          case when v_done then 'completed' else 'in_progress' end,
          case when p_kind in ('passed', 'abandoned_passed') then 'passed' when p_kind = 'failed' then 'failed'
               else 'unknown' end,
          p_score, v_st, case when v_done then v_st + interval '1 minute' end,
          case when p_path is null then 'individual' else 'path' end, false, p_path, 'Normal');
  return v_id;
end
$$;
-- an approved grant, used by p_used (the retake): the grant reads
-- individual, as every grant from before 0107 does (note N9)
create function pg_temp.grant_0107v(p_n int, p_course int, p_user uuid, p_used uuid) returns void
language sql as $$
  insert into public.attempt_requests (id, organization_id, course_id, user_id, status, decided_at, used_at,
                                       used_attempt_id)
  values (pg_temp.id_0107v('0001071540' || lpad(p_n::text, 2, '0')), '00000000-0000-0000-0000-00000000000a',
          pg_temp.c_0107v(p_course), p_user, 'approved', now() - interval '3 hours', now() - interval '2 hours', p_used)
$$;
-- the writer's own statement (build note O1-c), run as postgres until the
-- writer of step 12 exists: a fact for every current step of this learner
-- on this path that satisfies its rule now and has none yet
create function pg_temp.write_facts_0107v(p_path uuid, p_user uuid) returns bigint
language plpgsql as $$
declare
  n bigint;
begin
  insert into public.learning_path_step_completions (organization_id, path_id, course_id, user_id, attempt_id,
                                                     rule_pass_required)
  select s.organization_id, s.path_id, s.course_id, s.user_id, s.official_attempt_id, s.pass_required
    from public.v_path_step_status s
   where s.path_id = p_path and s.user_id = p_user and s.passed_by_rule and s.done_recorded_at is null
  on conflict (path_id, user_id, course_id) do nothing;
  get diagnostics n = row_count;
  return n;
end
$$;

do $$
declare
  org constant uuid := '00000000-0000-0000-0000-00000000000a';
  i   int;
begin
  for i in 1..16 loop
    insert into auth.users (id, email) values (pg_temp.u_0107v(i), format('learner-%s-0107v@example.test', i));
    insert into public.organization_members (organization_id, user_id, role) values (org, pg_temp.u_0107v(i), 'user');
  end loop;
  for i in 1..12 loop
    insert into public.courses (id, organization_id, title, slug, pass_required)
    values (pg_temp.c_0107v(i), org, format('C%s (0107 views)', lpad(i::text, 2, '0')), format('c%s-0107v', i),
            i in (2, 3));
    insert into public.course_packages (id, course_id, language, is_active)
    values (pg_temp.id_0107v('0001071511' || lpad(i::text, 2, '0')), pg_temp.c_0107v(i), null, true);
    insert into public.course_versions (id, course_id, package_id, version_number, manifest_type, launch_url,
                                        storage_prefix, manifest_data)
    values (pg_temp.id_0107v('0001071512' || lpad(i::text, 2, '0')), pg_temp.c_0107v(i),
            pg_temp.id_0107v('0001071511' || lpad(i::text, 2, '0')), 1, 'scorm12', 'index.html',
            format('courses/c%s-0107v/v1/', i), '{"title":"0107 views"}');
  end loop;
  insert into public.teams (id, organization_id, name, slug) values
    (pg_temp.id_0107v('000107156001'), org, 'T1 (0107 views)', 't1-0107v'),
    (pg_temp.id_0107v('000107156002'), org, 'T2 (0107 views)', 't2-0107v');
  insert into public.team_members (team_id, user_id) values
    (pg_temp.id_0107v('000107156001'), pg_temp.u_0107v(1)),
    (pg_temp.id_0107v('000107156001'), pg_temp.u_0107v(2)),
    (pg_temp.id_0107v('000107156002'), pg_temp.u_0107v(2));
  insert into public.learning_paths (id, organization_id, name, slug, is_active, visibility) values
    (pg_temp.id_0107v('000107152001'), org, 'PA (0107 views)', 'pa-0107v', true, 'private'),
    (pg_temp.id_0107v('000107152002'), org, 'PB (0107 views)', 'pb-0107v', true, 'private'),
    (pg_temp.id_0107v('000107152003'), org, 'PC (0107 views)', 'pc-0107v', true, 'private'),
    (pg_temp.id_0107v('000107152004'), org, 'PD (0107 views)', 'pd-0107v', true, 'private'),
    (pg_temp.id_0107v('000107152005'), org, 'PT (0107 views)', 'pt-0107v', true, 'private'),
    (pg_temp.id_0107v('000107152006'), org, 'PG (0107 views)', 'pg-0107v', true, 'private');
  insert into public.org_groups (id, organization_id, name, group_type, rules, is_active, system_key) values
    (pg_temp.id_0107v('000107159001'), org, 'G (0107 views)', 'static', null, true, null);
  insert into public.org_group_members (group_id, organization_id, user_id) values
    (pg_temp.id_0107v('000107159001'), org, pg_temp.u_0107v(7));
  insert into public.learning_path_courses (path_id, course_id, step_number, pass_required) values
    (pg_temp.id_0107v('000107152001'), pg_temp.c_0107v(1), 1, true),
    (pg_temp.id_0107v('000107152001'), pg_temp.c_0107v(2), 2, null),
    (pg_temp.id_0107v('000107152001'), pg_temp.c_0107v(3), 3, false),
    (pg_temp.id_0107v('000107152002'), pg_temp.c_0107v(5), 1, null),
    (pg_temp.id_0107v('000107152002'), pg_temp.c_0107v(6), 2, null),
    (pg_temp.id_0107v('000107152003'), pg_temp.c_0107v(7), 1, true),
    (pg_temp.id_0107v('000107152004'), pg_temp.c_0107v(8), 1, null),
    (pg_temp.id_0107v('000107152004'), pg_temp.c_0107v(9), 2, null);
  -- PA: L01 to L13 and S, by user rows (L02, L07 and L13 with a past due date)
  for i in 1..13 loop
    insert into public.learning_path_assignments (id, path_id, organization_id, assignee_type, user_id, due_at)
    values (pg_temp.id_0107v('0001071580' || lpad(i::text, 2, '0')), pg_temp.id_0107v('000107152001'), org,
            'user', pg_temp.u_0107v(i), case when i in (2, 7, 13) then '2000-01-01 00:00:00+00'::timestamptz end);
  end loop;
  insert into public.learning_path_assignments (id, path_id, organization_id, assignee_type, user_id) values
    (pg_temp.id_0107v('000107158070'), pg_temp.id_0107v('000107152001'), org, 'user',
     '00000000-0000-0000-0000-000107010006'),
    (pg_temp.id_0107v('000107158071'), pg_temp.id_0107v('000107152002'), org, 'user', pg_temp.u_0107v(14)),
    (pg_temp.id_0107v('000107158072'), pg_temp.id_0107v('000107152003'), org, 'user', pg_temp.u_0107v(15)),
    (pg_temp.id_0107v('000107158073'), pg_temp.id_0107v('000107152004'), org, 'user', pg_temp.u_0107v(16));
end
$$;

-- ---------------------------------------------------------------------------
-- (16) the terms views (step 18, decision A9). Course C10: a user row for
--      L01 (due 2999-06-01, assigned 2000-01-04); a self user row for L03
--      (no due date, assigned 2000-01-05); team T1 (L01, L02; due
--      2999-02-01, assigned 2000-01-02); team T2 (L02) not yet released
--      (release 2999-01-01, due 2999-01-15, assigned 1999-12-31); org-wide
--      (due 2999-03-01, assigned 2000-01-03); group G (L07; due 2999-01-20,
--      assigned 2000-01-01). Course C11: one unreleased row of each arm
--      (user, team T2, org-wide, group G; release 2999-01-01). Course C12
--      and path PG: group G only (due 2999-01-25). Path PT: a user row for
--      L05 (2999-06-01, 2000-01-04), a self user row for L06, team T1
--      (2999-02-01, 2000-01-02), org-wide (2999-03-01, 2000-01-03) and
--      group G (2999-01-20, 2000-01-01). The learner's own row wins, even
--      with no date; else the earliest of the others; enrolled_at is the
--      first assigned_at; an unreleased course assignment, of any arm, sets
--      nothing and enrols no one
-- ---------------------------------------------------------------------------
do $$
declare
  bad text[] := '{}';
  r   record;
  got text;
  org constant uuid := '00000000-0000-0000-0000-00000000000a';
  ct  constant uuid := pg_temp.c_0107v(10);
  cu  constant uuid := pg_temp.c_0107v(11);
  cg  constant uuid := pg_temp.c_0107v(12);
  pt  constant uuid := pg_temp.id_0107v('000107152005');
  pg  constant uuid := pg_temp.id_0107v('000107152006');
  g   constant uuid := pg_temp.id_0107v('000107159001');
  t1  constant uuid := pg_temp.id_0107v('000107156001');
  t2  constant uuid := pg_temp.id_0107v('000107156002');
begin
  insert into public.course_assignments (id, course_id, organization_id, assignee_type, user_id, team_id, due_at,
                                         assigned_at, release_at, source) values
    (pg_temp.id_0107v('000107155001'), ct, org, 'user', pg_temp.u_0107v(1), null, '2999-06-01 00:00:00+00',
     '2000-01-04 00:00:00+00', null, 'admin'),
    (pg_temp.id_0107v('000107155002'), ct, org, 'user', pg_temp.u_0107v(3), null, null,
     '2000-01-05 00:00:00+00', null, 'self'),
    (pg_temp.id_0107v('000107155003'), ct, org, 'team', null, t1, '2999-02-01 00:00:00+00',
     '2000-01-02 00:00:00+00', null, 'admin'),
    (pg_temp.id_0107v('000107155004'), ct, org, 'team', null, t2, '2999-01-15 00:00:00+00',
     '1999-12-31 00:00:00+00', '2999-01-01 00:00:00+00', 'admin'),
    (pg_temp.id_0107v('000107155005'), ct, org, 'org', null, null, '2999-03-01 00:00:00+00',
     '2000-01-03 00:00:00+00', null, 'admin'),
    (pg_temp.id_0107v('000107155006'), cu, org, 'team', null, t2, '2999-01-15 00:00:00+00',
     '1999-12-31 00:00:00+00', '2999-01-01 00:00:00+00', 'admin');
  insert into public.course_assignments (id, course_id, organization_id, assignee_type, user_id, group_id, due_at,
                                         assigned_at, release_at, source) values
    (pg_temp.id_0107v('000107155007'), ct, org, 'group', null, g, '2999-01-20 00:00:00+00',
     '2000-01-01 00:00:00+00', null, 'admin'),
    (pg_temp.id_0107v('000107155008'), cu, org, 'user', pg_temp.u_0107v(1), null, '2999-01-15 00:00:00+00',
     '1999-12-31 00:00:00+00', '2999-01-01 00:00:00+00', 'admin'),
    (pg_temp.id_0107v('000107155009'), cu, org, 'org', null, null, '2999-01-15 00:00:00+00',
     '1999-12-31 00:00:00+00', '2999-01-01 00:00:00+00', 'admin'),
    (pg_temp.id_0107v('000107155010'), cu, org, 'group', null, g, '2999-01-15 00:00:00+00',
     '1999-12-31 00:00:00+00', '2999-01-01 00:00:00+00', 'admin'),
    (pg_temp.id_0107v('000107155016'), cg, org, 'group', null, g, '2999-01-25 00:00:00+00',
     '2000-01-01 00:00:00+00', null, 'admin');
  insert into public.learning_path_assignments (id, path_id, organization_id, assignee_type, user_id, team_id, due_at,
                                                assigned_at, source) values
    (pg_temp.id_0107v('000107155011'), pt, org, 'user', pg_temp.u_0107v(5), null, '2999-06-01 00:00:00+00',
     '2000-01-04 00:00:00+00', 'admin'),
    (pg_temp.id_0107v('000107155012'), pt, org, 'user', pg_temp.u_0107v(6), null, null,
     '2000-01-05 00:00:00+00', 'self'),
    (pg_temp.id_0107v('000107155013'), pt, org, 'team', null, t1, '2999-02-01 00:00:00+00',
     '2000-01-02 00:00:00+00', 'admin'),
    (pg_temp.id_0107v('000107155014'), pt, org, 'org', null, null, '2999-03-01 00:00:00+00',
     '2000-01-03 00:00:00+00', 'admin');
  insert into public.learning_path_assignments (id, path_id, organization_id, assignee_type, group_id, due_at,
                                                assigned_at, source) values
    (pg_temp.id_0107v('000107155015'), pt, org, 'group', g, '2999-01-20 00:00:00+00', '2000-01-01 00:00:00+00', 'admin'),
    (pg_temp.id_0107v('000107155017'), pg, org, 'group', g, '2999-01-25 00:00:00+00', '2000-01-01 00:00:00+00', 'admin');

  for r in
    select * from (values
      ('course', ct, 1, 'due=2999-06-01 at=2000-01-02', 'L01: their own row wins over the earlier team and org dates'),
      ('course', ct, 2, 'due=2999-02-01 at=2000-01-02', 'L02: the earliest of team T1 and org; unreleased T2 ignored'),
      ('course', ct, 3, 'due=- at=2000-01-03', 'L03: their own self row has no date, so none (never overdue)'),
      ('course', ct, 4, 'due=2999-03-01 at=2000-01-03', 'L04: org-wide only'),
      ('course', ct, 7, 'due=2999-01-20 at=2000-01-01', 'L07: the group''s earlier date and assigned_at over org-wide'),
      ('course', cu, 2, 'none', 'L02 on C11: an unreleased assignment enrols no one and sets no date'),
      ('course', cg, 7, 'due=2999-01-25 at=2000-01-01', 'L07 on C12: the group arm alone'),
      ('path', pt, 7, 'due=2999-01-20 at=2000-01-01', 'L07 on PT: the group''s earlier date over org-wide'),
      ('path', pg, 7, 'due=2999-01-25 at=2000-01-01', 'L07 on PG: the group arm alone'),
      ('path', pt, 1, 'due=2999-02-01 at=2000-01-02', 'L01 on PT: the earliest of team T1 and org'),
      ('path', pt, 5, 'due=2999-06-01 at=2000-01-03', 'L05 on PT: their own row wins'),
      ('path', pt, 6, 'due=- at=2000-01-03', 'L06 on PT: their own self row, no date'),
      ('path', pt, 4, 'due=2999-03-01 at=2000-01-03', 'L04 on PT: org-wide only')
    ) as t(kind, id, n, expected, what)
  loop
    got := pg_temp.terms_0107v(r.kind, r.id, pg_temp.u_0107v(r.n));
    if got is distinct from r.expected then
      bad := bad || format('%s: %s (expected %s)', r.what, got, r.expected);
    end if;
  end loop;
  -- every member of Org A is enrolled on C10 and PT (the org rows), once
  if (select count(*) from public.v_course_enrollment_terms where course_id = ct)
     <> (select count(*) from public.organization_members where organization_id = org)
     or (select count(*) from public.v_path_enrollment_terms where path_id = pt)
     <> (select count(*) from public.organization_members where organization_id = org) then
    bad := bad || 'C10 or PT does not hold one terms row per member of Org A'::text;
  end if;
  if exists (select 1 from public.v_course_enrollments_expanded where course_id = cu)
     or exists (select 1 from public.v_course_enrollment_terms where course_id = cu) then
    bad := bad || 'C11, assigned only by unreleased rows of every arm, enrols someone or has a terms row'::text;
  end if;
  if (select string_agg(pg_temp.lbl_0107v(user_id), ',') from public.v_course_enrollments_expanded where course_id = cg)
     is distinct from right(pg_temp.u_0107v(7)::text, 6)
     or (select string_agg(pg_temp.lbl_0107v(user_id), ',') from public.v_path_enrollment_terms where path_id = pg)
     is distinct from right(pg_temp.u_0107v(7)::text, 6) then
    bad := bad || 'C12 or PG, assigned to group G only, does not reach exactly L07'::text;
  end if;
  got := pg_temp.prog_0107v(pg, pg_temp.u_0107v(7));
  if got is distinct from '0/0 next=- nc=- score=- comp=F status=not_started due=2999-01-25 started=F done_at=F over=F' then
    bad := bad || format('L07''s progress on PG, reached by the group only, reads %s', got);
  end if;
  if exists (select 1 from public.v_course_enrollment_terms where course_id = ct and organization_id <> org)
     or exists (select 1 from public.v_path_enrollment_terms where path_id = pt and organization_id <> org) then
    bad := bad || 'a terms row carries another organisation'::text;
  end if;
  -- PT has no step: a progress row per learner, 0 of 0, not started, the
  -- terms' due date, not overdue
  got := pg_temp.prog_0107v(pt, pg_temp.u_0107v(5));
  if got is distinct from '0/0 next=- nc=- score=- comp=F status=not_started due=2999-06-01 started=F done_at=F over=F' then
    bad := bad || format('L05''s progress on PT, a path with no step, reads %s', got);
  end if;

  if cardinality(bad) > 0 then
    raise exception 'assert-0107: (16) %', array_to_string(bad, '; ');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (17) the path views on PA (twins contract 3.5; notes N9 to N12), one
--      learner per case, each read as its three step rows and its progress
--      row. C01 is pass-required by the step, C02 by its course, and C03 is
--      not, although its course is (the step overrides the course)
-- ---------------------------------------------------------------------------
do $$
declare
  bad text[] := '{}';
  r   record;
  got text;
  pa  constant uuid := pg_temp.id_0107v('000107152001');
  e1  constant text := 'C01#1 pr=T pbr=F fact=F pe=F done=F res=- sc=- off=- rl=F f=F open=F';
  e2  constant text := 'C02#2 pr=T pbr=F fact=F pe=F done=F res=- sc=- off=- rl=F f=F open=F';
  e3  constant text := 'C03#3 pr=F pbr=F fact=F pe=F done=F res=- sc=- off=- rl=F f=F open=F';
  a   uuid;
begin
  -- L01, D14: a pass, then a granted retake that failed
  perform pg_temp.att_0107v(1, 1, pg_temp.u_0107v(1), pa, 'passed', 100, 1.0);
  a := pg_temp.att_0107v(2, 1, pg_temp.u_0107v(1), pa, 'failed', 50, 0.3);
  perform pg_temp.grant_0107v(1, 1, pg_temp.u_0107v(1), a);
  -- L02: failed where a pass is required, no grant; past its due date
  perform pg_temp.att_0107v(3, 1, pg_temp.u_0107v(2), pa, 'failed', 60, 0.4);
  -- L03: failed, and a granted retake live
  perform pg_temp.att_0107v(4, 1, pg_temp.u_0107v(3), pa, 'failed', 100, 0.4);
  a := pg_temp.att_0107v(5, 1, pg_temp.u_0107v(3), pa, 'in_progress', 10, null);
  perform pg_temp.grant_0107v(2, 1, pg_temp.u_0107v(3), a);
  -- L04: completed and failed on C03, where the step requires no pass
  perform pg_temp.att_0107v(6, 3, pg_temp.u_0107v(4), pa, 'failed', 60, 0.2);
  -- L05: C01 passed only as an Individual course
  perform pg_temp.att_0107v(7, 1, pg_temp.u_0107v(5), null, 'passed', 60, 0.9);
  -- L06: on C02 a failed official row, a passed practice row and a passed
  -- abandoned row: ever_passed, but no pass in the scored window
  perform pg_temp.att_0107v(8, 2, pg_temp.u_0107v(6), pa, 'failed', 100, 0.5);
  perform pg_temp.att_0107v(9, 2, pg_temp.u_0107v(6), pa, 'passed', 80, 0.9);
  perform pg_temp.att_0107v(10, 2, pg_temp.u_0107v(6), pa, 'abandoned_passed', 60, 0.95);
  -- L07: a completion row and no attempt, past its due date
  insert into public.learning_path_completions (id, organization_id, path_id, user_id, completed_at)
  values (pg_temp.id_0107v('000107157007'), '00000000-0000-0000-0000-00000000000a', pa, pg_temp.u_0107v(7),
          '2001-01-01 00:00:00+00');
  -- L08: every step done, no completion row
  perform pg_temp.att_0107v(11, 1, pg_temp.u_0107v(8), pa, 'passed', 90, 1.0);
  perform pg_temp.att_0107v(12, 2, pg_temp.u_0107v(8), pa, 'passed', 80, 0.8);
  perform pg_temp.att_0107v(13, 3, pg_temp.u_0107v(8), pa, 'completed', 70, 0.6);
  -- L09: a path attempt on C04, which is not a step of PA
  perform pg_temp.att_0107v(14, 4, pg_temp.u_0107v(9), pa, 'passed', 60, 0.9);
  -- L10: C01 failed, C02 passed
  perform pg_temp.att_0107v(15, 1, pg_temp.u_0107v(10), pa, 'failed', 90, 0.3);
  perform pg_temp.att_0107v(16, 2, pg_temp.u_0107v(10), pa, 'passed', 80, 0.8);
  -- L11: as L10, and a granted retake live on C01
  perform pg_temp.att_0107v(17, 1, pg_temp.u_0107v(11), pa, 'failed', 90, 0.3);
  perform pg_temp.att_0107v(18, 2, pg_temp.u_0107v(11), pa, 'passed', 80, 0.8);
  a := pg_temp.att_0107v(19, 1, pg_temp.u_0107v(11), pa, 'in_progress', 10, null);
  perform pg_temp.grant_0107v(3, 1, pg_temp.u_0107v(11), a);
  -- L12: a reset attempt only
  perform pg_temp.att_0107v(20, 1, pg_temp.u_0107v(12), pa, 'abandoned', 30, null);
  -- L13: a completed path, a failed step and a granted retake live; past due
  insert into public.learning_path_completions (id, organization_id, path_id, user_id, completed_at)
  values (pg_temp.id_0107v('000107157013'), '00000000-0000-0000-0000-00000000000a', pa, pg_temp.u_0107v(13),
          '2001-01-01 00:00:00+00');
  perform pg_temp.att_0107v(21, 1, pg_temp.u_0107v(13), pa, 'failed', 90, 0.3);
  a := pg_temp.att_0107v(22, 1, pg_temp.u_0107v(13), pa, 'in_progress', 10, null);
  perform pg_temp.grant_0107v(4, 1, pg_temp.u_0107v(13), a);
  -- S: a preview flagged by role (legacy_role) that carries PA's tag
  insert into public.course_attempts (id, course_version_id, user_id, organization_id, status, completion_status,
                                      success_status, score, started_at, completed_at, context_kind, is_preview,
                                      preview_kind, learning_path_id, launch_mode)
  values (pg_temp.id_0107v('000107153023'), pg_temp.id_0107v('000107151201'), '00000000-0000-0000-0000-000107010006',
          '00000000-0000-0000-0000-00000000000a', 'passed', 'completed', 'passed', 1.0, now() - interval '1 hour',
          now() - interval '50 minutes', 'preview', true, 'legacy_role', pa, 'Browse');

  for r in
    select * from (values
      ('L01: a pass, then a granted retake that failed (D14)', 1,
       'C01#1 pr=T pbr=T fact=F pe=T done=T res=failed sc=0.3 off=a02 rl=F f=F open=F; ' || e2 || '; ' || e3,
       '1/3 next=2 nc=C02 score=0.3000 comp=F status=in_progress due=- started=T done_at=F over=F'),
      ('L02: failed where a pass is required, no grant, past due', 2,
       'C01#1 pr=T pbr=F fact=F pe=F done=F res=failed sc=0.4 off=a03 rl=F f=T open=F; ' || e2 || '; ' || e3,
       '0/3 next=1 nc=C01 score=0.4000 comp=F status=failed due=2000-01-01 started=T done_at=F over=T'),
      ('L03: failed, with a granted retake live', 3,
       'C01#1 pr=T pbr=F fact=F pe=F done=F res=failed sc=0.4 off=a04 rl=T f=F open=T; ' || e2 || '; ' || e3,
       '0/3 next=1 nc=C01 score=0.4000 comp=F status=in_progress due=- started=T done_at=F over=F'),
      ('L04: completed and failed where the step requires no pass', 4,
       e1 || '; ' || e2 || '; C03#3 pr=F pbr=T fact=F pe=T done=T res=failed sc=0.2 off=a06 rl=F f=F open=F',
       '1/3 next=1 nc=C01 score=0.2000 comp=F status=in_progress due=- started=T done_at=F over=F'),
      ('L05: passed only as an Individual course', 5,
       e1 || '; ' || e2 || '; ' || e3,
       '0/3 next=1 nc=C01 score=- comp=F status=not_started due=- started=F done_at=F over=F'),
      ('L06: ever_passed by practice and abandoned rows, no pass in the window', 6,
       e1 || '; C02#2 pr=T pbr=F fact=F pe=F done=F res=failed sc=0.5 off=a08 rl=F f=T open=F; ' || e3,
       '0/3 next=1 nc=C01 score=0.5000 comp=F status=failed due=- started=T done_at=F over=F'),
      ('L07: a completion row and no step done, past due', 7,
       e1 || '; ' || e2 || '; ' || e3,
       '0/3 next=1 nc=C01 score=- comp=T status=completed due=2000-01-01 started=F done_at=T over=F'),
      ('L08: every step done, no completion row', 8,
       'C01#1 pr=T pbr=T fact=F pe=T done=T res=passed sc=1.0 off=a11 rl=F f=F open=F; '
       || 'C02#2 pr=T pbr=T fact=F pe=T done=T res=passed sc=0.8 off=a12 rl=F f=F open=F; '
       || 'C03#3 pr=F pbr=T fact=F pe=T done=T res=completed sc=0.6 off=a13 rl=F f=F open=F',
       '3/3 next=- nc=- score=0.8000 comp=F status=in_progress due=- started=T done_at=F over=F'),
      ('L09: a path attempt on a course that is not a step', 9,
       e1 || '; ' || e2 || '; ' || e3,
       '0/3 next=1 nc=C01 score=- comp=F status=not_started due=- started=F done_at=F over=F'),
      ('L10: one step failed, another passed', 10,
       'C01#1 pr=T pbr=F fact=F pe=F done=F res=failed sc=0.3 off=a15 rl=F f=T open=F; '
       || 'C02#2 pr=T pbr=T fact=F pe=T done=T res=passed sc=0.8 off=a16 rl=F f=F open=F; ' || e3,
       '1/3 next=1 nc=C01 score=0.5500 comp=F status=failed due=- started=T done_at=F over=F'),
      ('L11: as L10, with a granted retake live on the failed step', 11,
       'C01#1 pr=T pbr=F fact=F pe=F done=F res=failed sc=0.3 off=a17 rl=T f=F open=T; '
       || 'C02#2 pr=T pbr=T fact=F pe=T done=T res=passed sc=0.8 off=a18 rl=F f=F open=F; ' || e3,
       '1/3 next=1 nc=C01 score=0.5500 comp=F status=in_progress due=- started=T done_at=F over=F'),
      ('L12: a reset attempt only', 12,
       e1 || '; ' || e2 || '; ' || e3,
       '0/3 next=1 nc=C01 score=- comp=F status=not_started due=- started=F done_at=F over=F'),
      ('L13: a completed path with a granted retake live, past due', 13,
       'C01#1 pr=T pbr=F fact=F pe=F done=F res=failed sc=0.3 off=a21 rl=T f=F open=T; ' || e2 || '; ' || e3,
       '0/3 next=1 nc=C01 score=0.3000 comp=T status=in_progress due=2000-01-01 started=T done_at=T over=F')
    ) as t(what, n, steps, prog)
  loop
    got := pg_temp.steps_0107v(pa, pg_temp.u_0107v(r.n));
    if got is distinct from r.steps then
      bad := bad || format('%s: steps %s (expected %s)', r.what, got, r.steps);
    end if;
    got := pg_temp.prog_0107v(pa, pg_temp.u_0107v(r.n));
    if got is distinct from r.prog then
      bad := bad || format('%s: progress %s (expected %s)', r.what, got, r.prog);
    end if;
  end loop;
  -- S: the legacy_role preview tagged with PA is no row of path:PA
  got := pg_temp.steps_0107v(pa, '00000000-0000-0000-0000-000107010006');
  if got is distinct from e1 || '; ' || e2 || '; ' || e3 then
    bad := bad || format('S, whose only PA row is a preview by role: steps %s', got);
  end if;
  got := pg_temp.prog_0107v(pa, '00000000-0000-0000-0000-000107010006');
  if got is distinct from '0/3 next=1 nc=C01 score=- comp=F status=not_started due=- started=F done_at=F over=F' then
    bad := bad || format('S, whose only PA row is a preview by role: progress %s', got);
  end if;
  -- L06 on C02: ever_passed (practice and abandoned) is not passed_in_window
  select format('ep=%s piw=%s scored=%s practice=%s n=%s live=%s', ever_passed, passed_in_window, scored_attempts,
                practice_attempts, attempt_count, live_attempt_count)
    into got from public.v_context_attempt_summary
   where course_id = pg_temp.c_0107v(2) and user_id = pg_temp.u_0107v(6) and context_key = 'path:' || pa::text;
  if got is distinct from 'ep=t piw=f scored=1 practice=1 n=3 live=2' then
    bad := bad || format('L06''s C02 summary reads %s (expected ep=t piw=f scored=1 practice=1 n=3 live=2)', got);
  end if;
  -- L05: the Individual context holds the pass; the path context nothing
  got := pg_temp.ctx_0107v(pg_temp.u_0107v(5));
  if got is distinct from 'C01 individual off=a07 st=passed n=1 live=1 piw=T' then
    bad := bad || format('L05''s contexts read %s', got);
  end if;
  -- L01: the old-name views know nothing of a path-only learner
  if exists (select 1 from public.v_course_attempt_summary where user_id = pg_temp.u_0107v(1))
     or exists (select 1 from public.v_course_attempt_scoring where user_id = pg_temp.u_0107v(1)) then
    bad := bad || 'the old-name views read L01''s path rows'::text;
  end if;
  -- the next course and started_at of the progress row
  if (select started_at from public.v_path_progress where path_id = pa and user_id = pg_temp.u_0107v(8))
     is distinct from (select started_at from public.course_attempts where id = pg_temp.id_0107v('000107153011')) then
    bad := bad || 'L08''s started_at is not its earliest current-step row''s'::text;
  end if;
  -- a learner's journey day: two rows of one day launched under two numbers
  -- read as one context, with the newest row's number (journey_day is for
  -- display; the key names the day id)
  insert into public.course_attempts (id, course_version_id, user_id, organization_id, status, completion_status,
                                      success_status, score, started_at, completed_at, context_kind, is_preview,
                                      journey_enrollment_id, journey_day, journey_day_id, launch_mode) values
    (pg_temp.id_0107v('000107153024'), '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-000107010004',
     '00000000-0000-0000-0000-00000000000a', 'failed', 'completed', 'failed', 0.2, now() - interval '300 minutes',
     now() - interval '299 minutes', 'journey', false, '00000000-0000-0000-0000-000107063001', 3,
     '00000000-0000-0000-0000-000107061003', 'Normal'),
    (pg_temp.id_0107v('000107153025'), '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-000107010004',
     '00000000-0000-0000-0000-00000000000a', 'passed', 'completed', 'passed', 0.9, now() - interval '200 minutes',
     now() - interval '199 minutes', 'journey', false, '00000000-0000-0000-0000-000107063001', 6,
     '00000000-0000-0000-0000-000107061003', 'Normal');
  select format('rows=%s jd=%s n=%s off=%s', count(*), max(journey_day), max(attempt_count),
                max(pg_temp.lbl_0107v(official_attempt_id)))
    into got from public.v_context_attempt_summary
   where user_id = '00000000-0000-0000-0000-000107010004'
     and context_key = 'journey:00000000-0000-0000-0000-000107063001:00000000-0000-0000-0000-000107061003';
  if got is distinct from 'rows=1 jd=6 n=2 off=a24' then
    bad := bad || format('J''s day D3 under two numbers reads %s (expected rows=1 jd=6 n=2 off=a24)', got);
  end if;

  bad := bad || pg_temp.invariants_0107v();
  if cardinality(bad) > 0 then
    raise exception 'assert-0107: (17) %', array_to_string(bad, '; ');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (18) the stored step fact (the owner's O1 answer; build note O1-d): the
--      view halves of O1-g, on PB (L14), PC (L15) and PD (L16). A fact is
--      written by the writer's statement (O1-c) as postgres; rule changes
--      are updates of learning_path_courses and courses, as the admin's
--      editor makes them. The writer halves (a fact written by
--      record_learning_activity, its answer's keys, the sweep) come with the
--      writer.
-- ---------------------------------------------------------------------------
do $$
declare
  bad  text[] := '{}';
  got  text;
  n    bigint;
  pb   constant uuid := pg_temp.id_0107v('000107152002');
  pc   constant uuid := pg_temp.id_0107v('000107152003');
  pd   constant uuid := pg_temp.id_0107v('000107152004');
  l14  constant uuid := pg_temp.u_0107v(14);
  l15  constant uuid := pg_temp.u_0107v(15);
  l16  constant uuid := pg_temp.u_0107v(16);
  f06  constant text := 'C06#2 pr=F pbr=F fact=F pe=F done=F res=- sc=- off=- rl=F f=F open=F';
  kept constant text := 'C05#1 pr=T pbr=F fact=T pe=T done=T res=failed sc=0.3 off=a30 rl=F f=F open=F; '
                        || 'C06#2 pr=F pbr=F fact=F pe=F done=F res=- sc=- off=- rl=F f=F open=F';
  v_done_at timestamptz;
  a    uuid;
begin
  -- PB, L14: C05 completed without a pass while none is required
  perform pg_temp.att_0107v(30, 5, l14, pb, 'failed', 100, 0.3);
  got := pg_temp.steps_0107v(pb, l14);
  if got is distinct from 'C05#1 pr=F pbr=T fact=F pe=T done=T res=failed sc=0.3 off=a30 rl=F f=F open=F; ' || f06 then
    bad := bad || format('O1-g (1), before the fact: %s', got);
  end if;
  n := pg_temp.write_facts_0107v(pb, l14);
  if n <> 1 then
    bad := bad || format('O1-c: the writer''s statement wrote %s fact(s) for L14 (expected 1, C05)', n);
  end if;
  select format('%s rule=%s', pg_temp.lbl_0107v(attempt_id), rule_pass_required), f.done_at into got, v_done_at
    from public.learning_path_step_completions f where f.path_id = pb and f.user_id = l14;
  if got is distinct from 'a30 rule=f' then
    bad := bad || format('L14''s fact reads %s (expected a30 rule=f)', got);
  end if;
  -- (1) the step is made pass-required: still done, by its fact; the
  -- standing result is unchanged; step 2 is next
  update public.learning_path_courses set pass_required = true where path_id = pb and course_id = pg_temp.c_0107v(5);
  got := pg_temp.steps_0107v(pb, l14);
  if got is distinct from kept then
    bad := bad || format('O1-g (1), tightened at the step: %s (expected %s)', got, kept);
  end if;
  got := pg_temp.prog_0107v(pb, l14);
  if got is distinct from '1/2 next=2 nc=C06 score=0.3000 comp=F status=in_progress due=- started=T done_at=F over=F' then
    bad := bad || format('O1-g (1), tightened at the step: progress %s', got);
  end if;
  -- (2) the same tightening made at the course
  update public.learning_path_courses set pass_required = null where path_id = pb and course_id = pg_temp.c_0107v(5);
  update public.courses set pass_required = true where id = pg_temp.c_0107v(5);
  got := pg_temp.steps_0107v(pb, l14);
  if got is distinct from kept then
    bad := bad || format('O1-g (2), tightened at the course: %s (expected %s)', got, kept);
  end if;
  -- (7) the step removed and added again finds its fact
  delete from public.learning_path_courses where path_id = pb and course_id = pg_temp.c_0107v(5);
  got := pg_temp.steps_0107v(pb, l14);
  if got is distinct from f06 then
    bad := bad || format('O1-g (7), the step removed: %s (expected %s)', got, f06);
  end if;
  insert into public.learning_path_courses (path_id, course_id, step_number) values (pb, pg_temp.c_0107v(5), 1);
  got := pg_temp.steps_0107v(pb, l14);
  if got is distinct from kept then
    bad := bad || format('O1-g (7), the step added again: %s (expected %s)', got, kept);
  end if;
  -- (11) a granted retake on the step done by its fact: live, then failed
  a := pg_temp.att_0107v(31, 5, l14, pb, 'in_progress', 10, null);
  perform pg_temp.grant_0107v(10, 5, l14, a);
  got := pg_temp.steps_0107v(pb, l14);
  if got is distinct from 'C05#1 pr=T pbr=F fact=T pe=T done=T res=failed sc=0.3 off=a30 rl=T f=F open=T; ' || f06 then
    bad := bad || format('O1-g (11), the retake live: %s', got);
  end if;
  got := pg_temp.prog_0107v(pb, l14);
  if got is distinct from '1/2 next=2 nc=C06 score=0.3000 comp=F status=in_progress due=- started=T done_at=F over=F' then
    bad := bad || format('O1-g (11), the retake live: progress %s', got);
  end if;
  update public.course_attempts
     set status = 'failed', completion_status = 'completed', success_status = 'failed', score = 0.1,
         completed_at = now()
   where id = a;
  got := pg_temp.steps_0107v(pb, l14);
  if got is distinct from 'C05#1 pr=T pbr=F fact=T pe=T done=T res=failed sc=0.1 off=a31 rl=F f=F open=F; ' || f06 then
    bad := bad || format('O1-g (11), the retake failed: %s', got);
  end if;
  -- (5), static half: the writer's statement again writes nothing, and the
  -- fact is the one written first
  n := pg_temp.write_facts_0107v(pb, l14);
  select format('%s %s rule=%s same_time=%s', count(*), max(pg_temp.lbl_0107v(attempt_id)), bool_and(rule_pass_required),
                bool_and(f.done_at = v_done_at))
    into got from public.learning_path_step_completions f where f.path_id = pb and f.user_id = l14;
  if n <> 0 or got is distinct from '1 a30 rule=f same_time=t' then
    bad := bad || format('O1-g (5): the second run wrote %s and the facts read %s', n, got);
  end if;

  -- PC, L15: C07 requires a pass; failed
  perform pg_temp.att_0107v(32, 7, l15, pc, 'failed', 60, 0.4);
  n := pg_temp.write_facts_0107v(pc, l15);
  got := pg_temp.steps_0107v(pc, l15);
  if n <> 0 or got is distinct from 'C07#1 pr=T pbr=F fact=F pe=F done=F res=failed sc=0.4 off=a32 rl=F f=T open=F' then
    bad := bad || format('O1-g (3), tightened before done: %s fact(s), %s', n, got);
  end if;
  got := pg_temp.prog_0107v(pc, l15);
  if got is distinct from '0/1 next=1 nc=C07 score=0.4000 comp=F status=failed due=- started=T done_at=F over=F' then
    bad := bad || format('O1-g (3): progress %s', got);
  end if;
  -- (4) relaxed: done at once, with no fact and no writer call
  update public.learning_path_courses set pass_required = false where path_id = pc;
  got := pg_temp.steps_0107v(pc, l15);
  if got is distinct from 'C07#1 pr=F pbr=T fact=F pe=T done=T res=failed sc=0.4 off=a32 rl=F f=F open=F'
     or exists (select 1 from public.learning_path_step_completions where path_id = pc) then
    bad := bad || format('O1-g (4), relaxed: %s', got);
  end if;
  -- (8) tightened again with no completion in between: done, by the fact
  -- the rule-change trigger of section 6q records before the change (the
  -- owner's O3 answer closes the limit of O1-h (2), which this case pinned
  -- as not done before it): the rule before the change, false, and the
  -- step's official attempt
  update public.learning_path_courses set pass_required = true where path_id = pc;
  got := pg_temp.steps_0107v(pc, l15);
  if got is distinct from 'C07#1 pr=T pbr=F fact=T pe=T done=T res=failed sc=0.4 off=a32 rl=F f=F open=F' then
    bad := bad || format('O1-g (8), tightened again: %s', got);
  end if;
  select format('%s %s rule=%s', count(*), max(pg_temp.lbl_0107v(attempt_id)), bool_and(rule_pass_required))
    into got from public.learning_path_step_completions f where f.path_id = pc and f.user_id = l15;
  if got is distinct from '1 a32 rule=f' then
    bad := bad || format('O1-g (8): the rule-change fact reads %s (expected 1 a32 rule=f)', got);
  end if;
  -- (4), second half: relaxed again, the writer's statement finds the fact
  -- the trigger wrote and writes nothing, and a later tightening leaves the
  -- step done
  update public.learning_path_courses set pass_required = false where path_id = pc;
  n := pg_temp.write_facts_0107v(pc, l15);
  update public.learning_path_courses set pass_required = true where path_id = pc;
  got := pg_temp.steps_0107v(pc, l15);
  if n <> 0 or got is distinct from 'C07#1 pr=T pbr=F fact=T pe=T done=T res=failed sc=0.4 off=a32 rl=F f=F open=F' then
    bad := bad || format('O1-g (4), recorded then tightened: %s fact(s), %s', n, got);
  end if;

  -- PD, L16 (6): a completed path whose step is tightened stays completed
  perform pg_temp.att_0107v(33, 8, l16, pd, 'failed', 90, 0.5);
  perform pg_temp.att_0107v(34, 9, l16, pd, 'passed', 80, 0.9);
  n := pg_temp.write_facts_0107v(pd, l16);
  insert into public.learning_path_completions (id, organization_id, path_id, user_id, path_score)
  values (pg_temp.id_0107v('000107157016'), '00000000-0000-0000-0000-00000000000a', pd, l16, 0.7);
  update public.learning_path_courses set pass_required = true where path_id = pd and course_id = pg_temp.c_0107v(8);
  got := pg_temp.steps_0107v(pd, l16) || ' / ' || pg_temp.prog_0107v(pd, l16);
  if n <> 2 or got is distinct from
     'C08#1 pr=T pbr=F fact=T pe=T done=T res=failed sc=0.5 off=a33 rl=F f=F open=F; '
     || 'C09#2 pr=F pbr=T fact=T pe=T done=T res=passed sc=0.9 off=a34 rl=F f=F open=F / '
     || '2/2 next=- nc=- score=0.7000 comp=T status=completed due=- started=T done_at=T over=F' then
    bad := bad || format('O1-g (6), a completed path tightened: %s fact(s), %s', n, got);
  end if;

  bad := bad || pg_temp.invariants_0107v();
  if cardinality(bad) > 0 then
    raise exception 'assert-0107: (18) %', array_to_string(bad, '; ');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (19) as the API roles (after-check A1 to A16's privilege matrix and its
--      reads of the terms and path views): L01, a learner, reads their own
--      rows of the context summary, the terms views and the path views
--      exactly as postgres reads them, and no other learner's; S, an admin
--      of Org A, reads every learner's progress on PA exactly as postgres
--      does; a3, a member of QA Org, reads none of Org A's rows (the control:
--      their own context row); anon is refused every view of section 4 with
--      42501 (the control: a table it holds select on). Pinned, not chosen
--      here: L07, reached by group G only on C12 and PG, reads neither row on
--      their own session (a learner's session reads no group membership, the
--      0067 policies under 0105's invoker group_member_ids, as assert-0105.sql
--      (2c) pins for the enrolment views), while the admin S reads them as
--      postgres does. The statements name ids, never auth.uid() (the shim
--      gives the API roles no usage on schema auth).
-- ---------------------------------------------------------------------------
create temporary table r0107v_roles (who text, what text, got text);
grant select, insert on pg_temp.r0107v_roles to authenticated, anon;
grant execute on all functions in schema pg_temp to authenticated, anon;

select set_config('request.jwt.claims',
  '{"sub": "00000000-0000-0000-0000-000107150001", "role": "authenticated"}', true);
set local role authenticated;
insert into pg_temp.r0107v_roles values
  ('L01', 'steps PA', pg_temp.steps_0107v('00000000-0000-0000-0000-000107152001', '00000000-0000-0000-0000-000107150001')),
  ('L01', 'progress PA', pg_temp.prog_0107v('00000000-0000-0000-0000-000107152001', '00000000-0000-0000-0000-000107150001')),
  ('L01', 'progress PT', pg_temp.prog_0107v('00000000-0000-0000-0000-000107152005', '00000000-0000-0000-0000-000107150001')),
  ('L01', 'terms C10', pg_temp.terms_0107v('course', '00000000-0000-0000-0000-000107151010', '00000000-0000-0000-0000-000107150001')),
  ('L01', 'terms PT', pg_temp.terms_0107v('path', '00000000-0000-0000-0000-000107152005', '00000000-0000-0000-0000-000107150001')),
  ('L01', 'contexts', pg_temp.ctx_0107v('00000000-0000-0000-0000-000107150001')),
  ('L01', 'another learner''s step rows on PA', pg_temp.as_owner_state(
     'select 1 from public.v_path_step_status where path_id = ''00000000-0000-0000-0000-000107152001'' '
     || 'and user_id <> ''00000000-0000-0000-0000-000107150001''')),
  ('L01', 'another learner''s scoring rows', pg_temp.as_owner_state(
     'select 1 from public.v_context_attempt_scoring where user_id <> ''00000000-0000-0000-0000-000107150001''')),
  ('L01', 'another learner''s summary rows', pg_temp.as_owner_state(
     'select 1 from public.v_context_attempt_summary where user_id <> ''00000000-0000-0000-0000-000107150001''')),
  ('L01', 'its own scoring rows', pg_temp.as_owner_state(
     'select 1 from public.v_context_attempt_scoring where user_id = ''00000000-0000-0000-0000-000107150001'''));
reset role;

select set_config('request.jwt.claims',
  '{"sub": "00000000-0000-0000-0000-000107010006", "role": "authenticated"}', true);
set local role authenticated;
insert into pg_temp.r0107v_roles values
  ('S', 'progress PA, every learner', pg_temp.allprog_0107v('00000000-0000-0000-0000-000107152001')),
  ('S', 'steps PA of L13', pg_temp.steps_0107v('00000000-0000-0000-0000-000107152001', '00000000-0000-0000-0000-000107150013')),
  ('S', 'terms C12 of L07', pg_temp.terms_0107v('course', '00000000-0000-0000-0000-000107151012', '00000000-0000-0000-0000-000107150007')),
  ('S', 'progress PG of L07', pg_temp.prog_0107v('00000000-0000-0000-0000-000107152006', '00000000-0000-0000-0000-000107150007'));
reset role;

select set_config('request.jwt.claims',
  '{"sub": "00000000-0000-0000-0000-000107150007", "role": "authenticated"}', true);
set local role authenticated;
insert into pg_temp.r0107v_roles values
  ('L07', 'terms C12 (group only)', pg_temp.terms_0107v('course', '00000000-0000-0000-0000-000107151012', '00000000-0000-0000-0000-000107150007')),
  ('L07', 'progress PG (group only)', pg_temp.prog_0107v('00000000-0000-0000-0000-000107152006', '00000000-0000-0000-0000-000107150007')),
  ('L07', 'terms C10 (org-wide and group)', pg_temp.terms_0107v('course', '00000000-0000-0000-0000-000107151010', '00000000-0000-0000-0000-000107150007'));
reset role;

select set_config('request.jwt.claims',
  '{"sub": "00000000-0000-0000-0000-0000000000a3", "role": "authenticated"}', true);
set local role authenticated;
insert into pg_temp.r0107v_roles
select 'a3', s.what, pg_temp.as_owner_state(s.stmt)
from (values
  ('v_path_step_status', 'select 1 from public.v_path_step_status'),
  ('v_path_progress', 'select 1 from public.v_path_progress'),
  ('v_course_enrollment_terms', 'select 1 from public.v_course_enrollment_terms'),
  ('v_path_enrollment_terms', 'select 1 from public.v_path_enrollment_terms'),
  ('v_course_enrollments_expanded', 'select 1 from public.v_course_enrollments_expanded'),
  ('v_context_attempt_summary, another learner',
   'select 1 from public.v_context_attempt_summary where user_id <> ''00000000-0000-0000-0000-0000000000a3'''),
  ('v_context_attempt_scoring, another learner',
   'select 1 from public.v_context_attempt_scoring where user_id <> ''00000000-0000-0000-0000-0000000000a3'''),
  ('v_context_attempt_summary, their own (control)', 'select 1 from public.v_context_attempt_summary')
) as s(what, stmt);
reset role;

select set_config('request.jwt.claims', '{"role": "anon"}', true);
set local role anon;
insert into pg_temp.r0107v_roles
select 'anon', s.what, pg_temp.as_owner_state(s.stmt)
from (values
  ('v_context_attempt_scoring', 'select 1 from public.v_context_attempt_scoring'),
  ('v_context_attempt_summary', 'select 1 from public.v_context_attempt_summary'),
  ('v_course_enrollments_expanded', 'select 1 from public.v_course_enrollments_expanded'),
  ('v_course_enrollment_terms', 'select 1 from public.v_course_enrollment_terms'),
  ('v_path_enrollment_terms', 'select 1 from public.v_path_enrollment_terms'),
  ('v_path_step_status', 'select 1 from public.v_path_step_status'),
  ('v_path_progress', 'select 1 from public.v_path_progress'),
  ('a table it holds select on (control)', 'select 1 from public.courses where false')
) as s(what, stmt);
reset role;
select set_config('request.jwt.claims', '', true);

do $$
declare
  bad text[] := '{}';
  r   record;
  exp text;
  pa  constant uuid := '00000000-0000-0000-0000-000107152001';
  pt  constant uuid := '00000000-0000-0000-0000-000107152005';
  l01 constant uuid := '00000000-0000-0000-0000-000107150001';
begin
  if (select count(*) from pg_temp.r0107v_roles) <> 33 then
    bad := bad || format('%s of the 33 role cases ran', (select count(*) from pg_temp.r0107v_roles));
  end if;
  for r in select * from pg_temp.r0107v_roles loop
    exp := case r.who || '/' || r.what
      when 'L01/steps PA' then pg_temp.steps_0107v(pa, l01)
      when 'L01/progress PA' then pg_temp.prog_0107v(pa, l01)
      when 'L01/progress PT' then pg_temp.prog_0107v(pt, l01)
      when 'L01/terms C10' then pg_temp.terms_0107v('course', pg_temp.c_0107v(10), l01)
      when 'L01/terms PT' then pg_temp.terms_0107v('path', pt, l01)
      when 'L01/contexts' then pg_temp.ctx_0107v(l01)
      when 'L01/its own scoring rows' then 'no error, 1 row(s)'
      when 'S/progress PA, every learner' then pg_temp.allprog_0107v(pa)
      when 'S/steps PA of L13' then pg_temp.steps_0107v(pa, pg_temp.u_0107v(13))
      when 'S/terms C12 of L07' then pg_temp.terms_0107v('course', pg_temp.c_0107v(12), pg_temp.u_0107v(7))
      when 'S/progress PG of L07' then pg_temp.prog_0107v('00000000-0000-0000-0000-000107152006', pg_temp.u_0107v(7))
      when 'L07/terms C12 (group only)' then 'none'
      when 'L07/progress PG (group only)' then 'none'
      when 'L07/terms C10 (org-wide and group)' then 'due=2999-03-01 at=2000-01-03'
      when 'a3/v_context_attempt_summary, their own (control)' then 'no error, 1 row(s)'
      when 'anon/a table it holds select on (control)' then 'no error, 0 row(s)'
      else case when r.who = 'anon' then '42501' else 'no error, 0 row(s)' end
    end;
    if r.got is distinct from exp then
      bad := bad || format('as %s, %s: %s (expected %s)', r.who, r.what, coalesce(r.got, 'null'), exp);
    end if;
  end loop;
  -- postgres reads L07's group-only rows (the control of the pinned gap)
  if pg_temp.terms_0107v('course', pg_temp.c_0107v(12), pg_temp.u_0107v(7)) = 'none'
     or pg_temp.prog_0107v('00000000-0000-0000-0000-000107152006', pg_temp.u_0107v(7)) = 'none' then
    bad := bad || 'postgres reads no group-only row for L07'::text;
  end if;
  -- the learner's reads are not empty (the control that the session reads)
  if (select got from pg_temp.r0107v_roles where who = 'L01' and what = 'steps PA') not like 'C01#1 % off=a02 %' then
    bad := bad || 'L01''s own step rows on PA read empty'::text;
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107: (19) %', array_to_string(bad, '; ');
  end if;
end
$$;

rollback;
