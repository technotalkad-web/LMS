-- scripts/migration-rehearsal/assert-0107-functions.sql
-- Scenarios "0105-0106-then-0107" and "0106-then-0105-then-0107" (after the
-- first paste and again after the second), "0107-refused-q8" and
-- "0107-refused-q2" (after the two pastes that follow the repair): what
-- section 5 of 0107_learning_contexts.sql (ADR 0024 section B, creation
-- order item 5: the language sql functions of steps 9 and 13, with build
-- note N14) must have done. It runs after assert-0107-views.sql, so the
-- seed is read as committed. The checks continue the numbering of the 0107
-- files:
--   (20) the objects: each function's arguments, result, language,
--        volatility, security, search_path, comment and execute privilege
--        (service_role only; journey_reminder_counts is dropped and created
--        on every paste, so its privileges are checked after each paste)
--   (21) official_attempt_in_context: equal to the scoring view on every
--        context row of the seed and the fixtures, and the seed's cases
--   (22) instance_pass_required: equal to v_path_step_status.pass_required
--        on every step row, and the path, journey and other keys
--   (23) journey_attempt_satisfies: the target's rule, the launched
--        version's rule (R14), and the edges
--   (24) journey_credit_state and journey_reminder_counts (note N14; twins
--        contract 4.1 and 4.5): the seed's enrolments and the fixture
--        enrolments, credits counted by day identity
--   (25) as the API roles: anon and authenticated are refused every
--        function with 42501; service_role, given the table privileges the
--        project defaults give it, reads what postgres reads
-- The fixture rows have ids whose last group starts 00010716. The whole file
-- is one transaction that ends in ROLLBACK. Every check raises
-- 'assert-0107: (n) …' on failure; the runner then reports the file as
-- failed and stops the scenario.
--
-- PGlite runs as postgres. The shim gives service_role no table privilege
-- at all (Supabase's defaults give it every table), so (25) grants it, in
-- this transaction only, what those defaults give.
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

create function pg_temp.id_0107f(p text) returns uuid language sql immutable as $$
  select ('00000000-0000-0000-0000-' || p)::uuid
$$;

-- Readable ids: the seed's journey days d01 to d05, the fixture days D01 to
-- D09 and Z01, Z02; any other id reads its last six characters.
create function pg_temp.lbl_0107f(p uuid) returns text language sql immutable as $$
  select case
    when p is null then '-'
    when p::text like '00000000-0000-0000-0000-0001070610__' then 'd' || right(p::text, 2)
    when p::text like '00000000-0000-0000-0000-0001071631__' then 'D' || right(p::text, 2)
    when p::text like '00000000-0000-0000-0000-0001071632__' then 'Z' || right(p::text, 2)
    else right(p::text, 6)
  end
$$;

create function pg_temp.ids_0107f(p uuid[]) returns text language sql immutable as $$
  select coalesce(string_agg(pg_temp.lbl_0107f(u.x), ',' order by u.o), '')
  from unnest(p) with ordinality as u(x, o)
$$;

-- journey_credit_state for one enrolment, as one line ('none' = no row)
create function pg_temp.jcs_0107f(p_enr uuid) returns text language sql stable as $$
  select coalesce((
    select string_agg(format('req=%s done=%s cred={%s} ids={%s} next=%s/%s res={%s}',
                             s.required_days, s.credited_days, array_to_string(s.credited, ','),
                             pg_temp.ids_0107f(s.credited_day_ids), coalesce(s.next_day::text, '-'),
                             pg_temp.lbl_0107f(s.next_day_id), pg_temp.ids_0107f(s.resumable_day_ids)), ' | ')
      from public.journey_credit_state(array[p_enr]) s), 'none')
$$;

-- journey_reminder_counts for one enrolment, as one line ('none' = no row)
create function pg_temp.jrc_0107f(p_enr uuid) returns text language sql stable as $$
  select coalesce((
    select string_agg(format('done=%s today=%s cred={%s}', r.done,
                             case when r.done_today then 'T' when not r.done_today then 'F' else 'null' end,
                             array_to_string(r.credited, ',')), ' | ')
      from public.journey_reminder_counts(array[p_enr]) r), 'none')
$$;

-- ---------------------------------------------------------------------------
-- (20) the objects: the five functions of section 5, each exactly once
-- ---------------------------------------------------------------------------
do $$
declare
  bad text[] := '{}';
  r   record;
  g   record;
begin
  for r in
    select * from (values
      ('official_attempt_in_context', 'public.official_attempt_in_context(uuid,uuid,text)',
       'p_user uuid, p_course uuid, p_context_key text', 'uuid', false, true),
      ('instance_pass_required', 'public.instance_pass_required(uuid,text)',
       'p_course uuid, p_context_key text', 'boolean', false, true),
      ('journey_attempt_satisfies', 'public.journey_attempt_satisfies(uuid,boolean)',
       'p_attempt_id uuid, p_target_rule boolean', 'boolean', false, true),
      ('journey_credit_state', 'public.journey_credit_state(uuid[])',
       'p_ids uuid[]',
       'TABLE(enrollment_id uuid, required_days integer, credited_days integer, credited integer[], '
       || 'credited_day_ids uuid[], next_day integer, next_day_id uuid, resumable_day_ids uuid[])', false, true),
      ('journey_reminder_counts', 'public.journey_reminder_counts(uuid[])',
       'p_ids uuid[]', 'TABLE(enrollment_id uuid, done integer, done_today boolean, credited integer[])', true, false)
    ) as t(name, fn, args, result, secdef, commented)
  loop
    if (select count(*) from pg_proc
         where proname = r.name and pronamespace = 'public'::regnamespace) <> 1 then
      bad := bad || format('public.%s is not exactly one function', r.name);
      continue;
    end if;
    select p.oid, pg_get_function_identity_arguments(p.oid) as args, pg_get_function_result(p.oid) as result,
           l.lanname::text as lang, p.provolatile, p.prosecdef, p.proisstrict, p.proconfig,
           obj_description(p.oid, 'pg_proc') as comment
      into g
      from pg_proc p
      join pg_language l on l.oid = p.prolang
     where p.oid = to_regprocedure(r.fn);
    if not found then
      bad := bad || format('%s is missing', r.fn);
      continue;
    end if;
    if g.args <> r.args or g.result <> r.result then
      bad := bad || format('%s: (%s) returns %s', r.fn, g.args, g.result);
    end if;
    if g.lang <> 'sql' or g.provolatile <> 's' or g.prosecdef <> r.secdef or g.proisstrict
       or g.proconfig is distinct from array['search_path=pg_catalog, public'] then
      bad := bad || format('%s: language %s, volatility %s, security definer %s, strict %s, proconfig %s',
                           r.fn, g.lang, g.provolatile, g.prosecdef, g.proisstrict, coalesce(g.proconfig::text, 'null'));
    end if;
    if r.commented and g.comment is null then
      bad := bad || format('%s has no comment', r.fn);
    end if;
    if has_function_privilege('public', r.fn, 'execute')
       or has_function_privilege('anon', r.fn, 'execute')
       or has_function_privilege('authenticated', r.fn, 'execute')
       or not has_function_privilege('service_role', r.fn, 'execute') then
      bad := bad || format('%s: execute is not service_role only (public %s, anon %s, authenticated %s, service_role %s)',
                           r.fn, has_function_privilege('public', r.fn, 'execute'),
                           has_function_privilege('anon', r.fn, 'execute'),
                           has_function_privilege('authenticated', r.fn, 'execute'),
                           has_function_privilege('service_role', r.fn, 'execute'));
    end if;
  end loop;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107: (20) %', array_to_string(bad, '; ');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- The fixture world (ids 00010716…), inside Org A: learners U01 to U05;
-- courses F1 to F5, each with one SCORM 1.2 version, pass_required false,
-- true, true, true, false; path PF (F1 step 1 with pass_required true over
-- its course's false, F2 step 2 inheriting its course's true, F3 step 3
-- false over its course's true), U01 enrolled by a user row; program JF with
-- journey_days D01 to D08 (numbers 1 to 8) and D09 (removed: no number);
-- its versions
--   VA  days_total 6: day 1 F1 true; day 2 F2 false, then day 2 again, F5
--       true (one number listed twice); day 3 F1 null; day 4 a rest day;
--       day 5 F2 "true" (a string, not a boolean); day 6 F5; day 7 F1, above
--       days_total. Required: 1, 2, 3, 5, 6
--   VB  days_total 3: day 1 F1 false, day 2 F2 true, day 3 F1 null
--   VC  days_total 2: day 2 F2 only
-- program JZ (Z01, Z02) with VZ, two rest days (zero required days);
-- enrolments E1 (U01, VA, active), E2 (U02, VA, completed), E3 (U03, VZ,
-- active), E4 (U04, VA, reset), E5 (U05, VA, active)
-- ---------------------------------------------------------------------------
do $$
declare
  org constant uuid := '00000000-0000-0000-0000-00000000000a';
  i   int;
  f   text[];
  d   text[];
begin
  for i in 1..5 loop
    insert into auth.users (id, email)
    values (pg_temp.id_0107f('0001071600' || lpad(i::text, 2, '0')), format('learner-%s-0107f@example.test', i));
    insert into public.organization_members (organization_id, user_id, role)
    values (org, pg_temp.id_0107f('0001071600' || lpad(i::text, 2, '0')), 'user');
    insert into public.courses (id, organization_id, title, slug, pass_required)
    values (pg_temp.id_0107f('0001071610' || lpad(i::text, 2, '0')), org, format('F%s (0107 functions)', i),
            format('f%s-0107f', i), i in (2, 3, 4));
    insert into public.course_packages (id, course_id, language, is_active)
    values (pg_temp.id_0107f('0001071611' || lpad(i::text, 2, '0')),
            pg_temp.id_0107f('0001071610' || lpad(i::text, 2, '0')), null, true);
    insert into public.course_versions (id, course_id, package_id, version_number, manifest_type, launch_url,
                                        storage_prefix, manifest_data)
    values (pg_temp.id_0107f('0001071612' || lpad(i::text, 2, '0')),
            pg_temp.id_0107f('0001071610' || lpad(i::text, 2, '0')),
            pg_temp.id_0107f('0001071611' || lpad(i::text, 2, '0')), 1, 'scorm12', 'index.html',
            format('courses/f%s-0107f/v1/', i), '{"title":"0107 functions"}');
  end loop;
  f := array[pg_temp.id_0107f('000107161001')::text, pg_temp.id_0107f('000107161002')::text,
             pg_temp.id_0107f('000107161003')::text, pg_temp.id_0107f('000107161004')::text,
             pg_temp.id_0107f('000107161005')::text];

  -- path PF
  insert into public.learning_paths (id, organization_id, name, slug, is_active, visibility)
  values (pg_temp.id_0107f('000107162001'), org, 'PF (0107 functions)', 'pf-0107f', true, 'private');
  insert into public.learning_path_courses (path_id, course_id, step_number, pass_required) values
    (pg_temp.id_0107f('000107162001'), f[1]::uuid, 1, true),
    (pg_temp.id_0107f('000107162001'), f[2]::uuid, 2, null),
    (pg_temp.id_0107f('000107162001'), f[3]::uuid, 3, false);
  insert into public.learning_path_assignments (id, path_id, organization_id, assignee_type, user_id)
  values (pg_temp.id_0107f('000107162101'), pg_temp.id_0107f('000107162001'), org, 'user',
          pg_temp.id_0107f('000107160001'));

  -- programs JF and JZ, their days
  insert into public.journey_programs (id, organization_id, name, days_total) values
    (pg_temp.id_0107f('000107163001'), org, 'JF (0107 functions)', 8),
    (pg_temp.id_0107f('000107163002'), org, 'JZ (0107 functions)', 2);
  for i in 1..8 loop
    insert into public.journey_days (id, program_id, organization_id, day_number, course_id)
    values (pg_temp.id_0107f('0001071631' || lpad(i::text, 2, '0')), pg_temp.id_0107f('000107163001'), org, i,
            f[1 + (i - 1) % 5]::uuid);
  end loop;
  insert into public.journey_days (id, program_id, organization_id, day_number, course_id, removed_at)
  values (pg_temp.id_0107f('000107163109'), pg_temp.id_0107f('000107163001'), org, null, f[5]::uuid, now());
  insert into public.journey_days (id, program_id, organization_id, day_number, course_id) values
    (pg_temp.id_0107f('000107163201'), pg_temp.id_0107f('000107163002'), org, 1, null),
    (pg_temp.id_0107f('000107163202'), pg_temp.id_0107f('000107163002'), org, 2, null);
  d := array(select pg_temp.id_0107f('0001071631' || lpad(g.n::text, 2, '0'))::text
               from generate_series(1, 9) as g(n) order by g.n);

  -- versions (day_ids given, as the new editor's publish gives them)
  insert into public.journey_versions (id, program_id, organization_id, version_number, name, days_total,
                                       count_sundays, completion_title, days, day_ids, day_ids_source) values
    (pg_temp.id_0107f('000107163301'), pg_temp.id_0107f('000107163001'), org, 1, 'JF (0107 functions)', 6, true,
     'Done',
     jsonb_build_array(
       jsonb_build_object('day', 1, 'course_id', f[1], 'mission_title', null, 'pass_required', true),
       jsonb_build_object('day', 2, 'course_id', f[2], 'mission_title', null, 'pass_required', false),
       jsonb_build_object('day', 2, 'course_id', f[5], 'mission_title', null, 'pass_required', true),
       jsonb_build_object('day', 3, 'course_id', f[1], 'mission_title', null, 'pass_required', null),
       jsonb_build_object('day', 4, 'course_id', null, 'mission_title', 'Rest'),
       jsonb_build_object('day', 5, 'course_id', f[2], 'mission_title', null, 'pass_required', 'true'),
       jsonb_build_object('day', 6, 'course_id', f[5], 'mission_title', null),
       jsonb_build_object('day', 7, 'course_id', f[1], 'mission_title', null)),
     jsonb_build_object('1', d[1], '2', d[2], '3', d[3], '4', d[4], '5', d[5], '6', d[6], '7', d[7]), 'editor'),
    (pg_temp.id_0107f('000107163302'), pg_temp.id_0107f('000107163001'), org, 2, 'JF (0107 functions)', 3, true,
     'Done',
     jsonb_build_array(
       jsonb_build_object('day', 1, 'course_id', f[1], 'mission_title', null, 'pass_required', false),
       jsonb_build_object('day', 2, 'course_id', f[2], 'mission_title', null, 'pass_required', true),
       jsonb_build_object('day', 3, 'course_id', f[1], 'mission_title', null, 'pass_required', null)),
     jsonb_build_object('1', d[1], '2', d[2], '3', d[3]), 'editor'),
    (pg_temp.id_0107f('000107163303'), pg_temp.id_0107f('000107163001'), org, 3, 'JF (0107 functions)', 2, true,
     'Done',
     jsonb_build_array(jsonb_build_object('day', 2, 'course_id', f[2], 'mission_title', null)),
     jsonb_build_object('2', d[2]), 'editor'),
    (pg_temp.id_0107f('000107163304'), pg_temp.id_0107f('000107163002'), org, 1, 'JZ (0107 functions)', 2, true,
     'Done',
     '[{"day": 1, "course_id": null, "mission_title": "Rest"}, {"day": 2, "course_id": "", "mission_title": "Rest"}]',
     jsonb_build_object('1', pg_temp.id_0107f('000107163201')::text, '2', pg_temp.id_0107f('000107163202')::text),
     'editor');

  insert into public.journey_enrollments (id, program_id, version_id, organization_id, user_id, start_date, status,
                                          completed_at) values
    (pg_temp.id_0107f('000107163401'), pg_temp.id_0107f('000107163001'), pg_temp.id_0107f('000107163301'), org,
     pg_temp.id_0107f('000107160001'), current_date - 10, 'active', null),
    (pg_temp.id_0107f('000107163402'), pg_temp.id_0107f('000107163001'), pg_temp.id_0107f('000107163301'), org,
     pg_temp.id_0107f('000107160002'), current_date - 20, 'completed', now() - interval '1 day'),
    (pg_temp.id_0107f('000107163403'), pg_temp.id_0107f('000107163002'), pg_temp.id_0107f('000107163304'), org,
     pg_temp.id_0107f('000107160003'), current_date - 5, 'active', null),
    (pg_temp.id_0107f('000107163404'), pg_temp.id_0107f('000107163001'), pg_temp.id_0107f('000107163301'), org,
     pg_temp.id_0107f('000107160004'), current_date - 30, 'reset', null),
    (pg_temp.id_0107f('000107163405'), pg_temp.id_0107f('000107163001'), pg_temp.id_0107f('000107163301'), org,
     pg_temp.id_0107f('000107160005'), current_date - 2, 'active', null);
end
$$;

-- An attempt of the fixture world: p_kind passed, failed, completed (no
-- verdict), in_progress, abandoned or revision (an open revision row); a
-- journey row when p_enr is given (its day id, its number at launch and the
-- version it was launched under), else an Individual row.
create function pg_temp.att_0107f(p_n int, p_course int, p_user int, p_enr int, p_day int, p_day_number int,
                                  p_version int, p_kind text, p_minutes int) returns uuid
language plpgsql as $$
declare
  v_id   uuid := pg_temp.id_0107f('000107164' || lpad(p_n::text, 3, '0'));
  v_st   timestamptz := now() - make_interval(mins => p_minutes);
  v_done boolean := p_kind in ('passed', 'failed', 'completed');
begin
  insert into public.course_attempts (id, course_version_id, user_id, organization_id, status, completion_status,
                                      success_status, score, started_at, completed_at, context_kind, is_preview,
                                      is_revision, journey_enrollment_id, journey_day, journey_day_id,
                                      journey_version_id, launch_mode)
  values (v_id, pg_temp.id_0107f('0001071612' || lpad(p_course::text, 2, '0')),
          pg_temp.id_0107f('0001071600' || lpad(p_user::text, 2, '0')), '00000000-0000-0000-0000-00000000000a',
          case when p_kind = 'revision' then 'in_progress' else p_kind end,
          case when v_done then 'completed' else 'in_progress' end,
          case p_kind when 'passed' then 'passed' when 'failed' then 'failed' else 'unknown' end,
          case when v_done then 0.5 end, v_st, case when v_done then v_st + interval '1 minute' end,
          case when p_enr is null then 'individual' else 'journey' end, false, p_kind = 'revision',
          case when p_enr is not null then pg_temp.id_0107f('0001071634' || lpad(p_enr::text, 2, '0')) end,
          case when p_enr is not null then p_day_number end,
          case when p_enr is not null then pg_temp.id_0107f('0001071631' || lpad(p_day::text, 2, '0')) end,
          case when p_version is not null then pg_temp.id_0107f('0001071633' || lpad(p_version::text, 2, '0')) end,
          'Normal');
  return v_id;
end
$$;

-- A credit of the fixture world (day p_day of JF; p_day 0 = JZ's Z01)
create function pg_temp.credit_0107f(p_n int, p_enr int, p_user int, p_day int, p_day_number int, p_kind text,
                                     p_at timestamptz) returns void
language sql as $$
  insert into public.journey_day_progress (id, enrollment_id, organization_id, user_id, day_number, day_id,
                                           course_id, attempt_id, completed_at, credit_kind)
  values (pg_temp.id_0107f('000107165' || lpad(p_n::text, 3, '0')),
          pg_temp.id_0107f('0001071634' || lpad(p_enr::text, 2, '0')), '00000000-0000-0000-0000-00000000000a',
          pg_temp.id_0107f('0001071600' || lpad(p_user::text, 2, '0')), p_day_number,
          case when p_day = 0 then pg_temp.id_0107f('000107163201')
               else pg_temp.id_0107f('0001071631' || lpad(p_day::text, 2, '0')) end,
          null, null, p_at, p_kind)
$$;

do $$
begin
  -- E1: credits on D01; D03 under another number (7, its number when
  -- credited); D04, a rest day, stamped now; D05, legacy_cross_context; D07,
  -- above days_total; D08, a day VA does not hold; D09, removed
  perform pg_temp.credit_0107f(1, 1, 1, 1, 1, 'attempt', now() - interval '9 days');
  perform pg_temp.credit_0107f(2, 1, 1, 3, 7, 'attempt', now() - interval '8 days');
  perform pg_temp.credit_0107f(3, 1, 1, 4, 4, 'self', now());
  perform pg_temp.credit_0107f(4, 1, 1, 5, 5, 'legacy_cross_context', now() - interval '7 days');
  perform pg_temp.credit_0107f(5, 1, 1, 7, 7, 'admin', now() - interval '6 days');
  perform pg_temp.credit_0107f(6, 1, 1, 8, 8, 'attempt', now() - interval '5 days');
  perform pg_temp.credit_0107f(7, 1, 1, 9, 9, 'attempt', now() - interval '4 days');
  -- E2 (completed): every required day credited
  perform pg_temp.credit_0107f(11, 2, 2, 1, 1, 'attempt', now() - interval '19 days');
  perform pg_temp.credit_0107f(12, 2, 2, 2, 2, 'attempt', now() - interval '18 days');
  perform pg_temp.credit_0107f(13, 2, 2, 3, 3, 'attempt', now() - interval '17 days');
  perform pg_temp.credit_0107f(14, 2, 2, 5, 5, 'attempt', now() - interval '16 days');
  perform pg_temp.credit_0107f(15, 2, 2, 6, 6, 'attempt', now() - interval '15 days');
  -- E3: a credit on a rest day of a version with no required day
  perform pg_temp.credit_0107f(21, 3, 3, 0, 1, 'self', now() - interval '3 days');

  -- E1's attempts: open on D02 and on the removed D09 (both resumable); an
  -- abandoned row on D06, an open revision row on D01 and a completed row on
  -- D03 (none resumable); a preview flagged by role that carries E1's tag
  perform pg_temp.att_0107f(1, 2, 1, 1, 2, 2, 1, 'in_progress', 60);
  perform pg_temp.att_0107f(2, 5, 1, 1, 9, 9, 1, 'in_progress', 120);
  perform pg_temp.att_0107f(3, 5, 1, 1, 6, 6, 1, 'abandoned', 180);
  perform pg_temp.att_0107f(4, 1, 1, 1, 1, 1, 1, 'revision', 30);
  perform pg_temp.att_0107f(5, 1, 1, 1, 3, 7, 1, 'passed', 600);
  insert into public.course_attempts (id, course_version_id, user_id, organization_id, status, completion_status,
                                      success_status, started_at, context_kind, is_preview, preview_kind,
                                      journey_enrollment_id, journey_day, launch_mode)
  values (pg_temp.id_0107f('000107164006'), pg_temp.id_0107f('000107161201'), pg_temp.id_0107f('000107160001'),
          '00000000-0000-0000-0000-00000000000a', 'in_progress', 'in_progress', 'unknown', now() - interval '20 minutes',
          'preview', true, 'legacy_role', pg_temp.id_0107f('000107163401'), 1, 'Browse');

  -- E5's attempts, for journey_attempt_satisfies (VA is pinned): s11 day 1
  -- launched under VB (day 1 false there), failed; s12 day 2 under VB (true
  -- there), failed; s13 day 1 under VA, failed; s14 day 3 under VA (null:
  -- F1's false), failed; s15 day 1 with no launched version, failed; s16
  -- day 2 under VB, passed; s17 day 2 under VA, open; s18 day 5 on F5 under
  -- VA (the string "true" is no rule: F5's false), completed with no
  -- verdict; s19 day 1 under VC, which does not hold day 1, failed; s20 an
  -- Individual row on F1, failed; s21 day 2 under VA, failed (VA lists day
  -- 2 twice: the first entry's false is its rule, not the second's true)
  perform pg_temp.att_0107f(11, 1, 5, 5, 1, 1, 2, 'failed', 600);
  perform pg_temp.att_0107f(12, 2, 5, 5, 2, 2, 2, 'failed', 590);
  perform pg_temp.att_0107f(13, 1, 5, 5, 1, 1, 1, 'failed', 580);
  perform pg_temp.att_0107f(14, 1, 5, 5, 3, 3, 1, 'failed', 570);
  perform pg_temp.att_0107f(15, 1, 5, 5, 1, 1, null, 'failed', 560);
  perform pg_temp.att_0107f(16, 2, 5, 5, 2, 2, 2, 'passed', 550);
  perform pg_temp.att_0107f(17, 2, 5, 5, 2, 2, 1, 'in_progress', 540);
  perform pg_temp.att_0107f(18, 5, 5, 5, 5, 5, 1, 'completed', 530);
  perform pg_temp.att_0107f(19, 1, 5, 5, 1, 1, 3, 'failed', 520);
  perform pg_temp.att_0107f(20, 1, 5, null, null, null, null, 'failed', 510);
  perform pg_temp.att_0107f(21, 2, 5, 5, 2, 2, 1, 'failed', 500);
end
$$;

-- ---------------------------------------------------------------------------
-- (21) official_attempt_in_context: the scoring view's official attempt on
--      every context row of the seed and the fixtures (null where the
--      context has none), and the seed's cases: one official attempt per
--      context, no preview, no revision row and no abandoned row official
-- ---------------------------------------------------------------------------
do $$
declare
  bad  text[] := '{}';
  r    record;
  got  uuid;
  n    bigint;
  m    bigint;
  n_ind  bigint;
  n_path bigint;
  n_jour bigint;
  n_none bigint;
  c1   constant uuid := '00000000-0000-0000-0000-0000000000c1';
  c2   constant uuid := '00000000-0000-0000-0000-0000000000c2';
  k    constant uuid := '00000000-0000-0000-0000-000107040001';
  p1   constant text := 'path:00000000-0000-0000-0000-000107050001';
begin
  select count(*), count(*) filter (where public.official_attempt_in_context(s.user_id, s.course_id, s.context_key)
                                          is distinct from s.official_attempt_id)
    into n, m
    from public.v_context_attempt_summary s;
  if m <> 0 then
    bad := bad || format('%s of %s context rows: the function differs from the summary''s official_attempt_id', m, n);
  end if;
  select count(*) into m
    from public.v_context_attempt_scoring s
   where public.official_attempt_in_context(s.user_id, s.course_id, s.context_key) is distinct from s.official_attempt_id;
  if m <> 0 then
    bad := bad || format('%s scoring row(s): the function differs from the view', m);
  end if;
  select count(*) filter (where official_attempt_id is not null and context_kind = 'individual'),
         count(*) filter (where official_attempt_id is not null and context_kind = 'path'),
         count(*) filter (where official_attempt_id is not null and context_kind = 'journey'),
         count(*) filter (where official_attempt_id is null)
    into n_ind, n_path, n_jour, n_none
    from public.v_context_attempt_summary;
  -- the comparison is not vacuous: on the first paste 6 Individual, 2 path
  -- and 6 journey contexts hold an official attempt, and 11 hold none
  if n_ind < 6 or n_path < 2 or n_jour < 6 or n_none < 11 then
    bad := bad || format('the comparison ran on too few rows (official: %s Individual, %s path, %s journey; '
                         || 'none: %s)', n_ind, n_path, n_jour, n_none);
  end if;

  for r in
    select * from (values
      ('B on C1, Individual (a live granted retake beside it)', '00000000-0000-0000-0000-000107010003', c1,
       'individual', '00000000-0000-0000-0000-000107070007'),
      ('B on C1, path P1', '00000000-0000-0000-0000-000107010003', c1, p1, '00000000-0000-0000-0000-000107070008'),
      ('B on C2, path P1 (an abandoned row only)', '00000000-0000-0000-0000-000107010003', c2, p1, null),
      ('J on C1, journey EJ day 1', '00000000-0000-0000-0000-000107010004', c1,
       'journey:00000000-0000-0000-0000-000107063001:00000000-0000-0000-0000-000107061001',
       '00000000-0000-0000-0000-000107070011'),
      ('J on C1, a journey day J holds no row on', '00000000-0000-0000-0000-000107010004', c1,
       'journey:00000000-0000-0000-0000-000107063001:00000000-0000-0000-0000-000107061003', null),
      ('I on C1, Individual (beside a revision row)', '00000000-0000-0000-0000-000107010001', c1, 'individual',
       '00000000-0000-0000-0000-000107070001'),
      ('S on K, Individual', '00000000-0000-0000-0000-000107010006', k, 'individual',
       '00000000-0000-0000-0000-000107070018'),
      ('S on K, the preview key (a passed preview, the target of a used grant)',
       '00000000-0000-0000-0000-000107010006', k, 'preview', null),
      ('a3 on C1 (the abandoned completed row f6 only)', '00000000-0000-0000-0000-0000000000a3', c1, 'individual',
       null),
      ('U05 on F1, JF day 1 (s11, s13, s15 and s19 completed; the first is official)',
       '00000000-0000-0000-0000-000107160005', '00000000-0000-0000-0000-000107161001',
       'journey:00000000-0000-0000-0000-000107163405:00000000-0000-0000-0000-000107163101',
       '00000000-0000-0000-0000-000107164011'),
      ('U05 on F1, Individual', '00000000-0000-0000-0000-000107160005', '00000000-0000-0000-0000-000107161001',
       'individual', '00000000-0000-0000-0000-000107164020'),
      ('U01 on F2, JF day 2 (an open row only)', '00000000-0000-0000-0000-000107160001',
       '00000000-0000-0000-0000-000107161002',
       'journey:00000000-0000-0000-0000-000107163401:00000000-0000-0000-0000-000107163102', null)
    ) as t(what, user_id, course_id, ctx, expect)
  loop
    got := public.official_attempt_in_context(r.user_id::uuid, r.course_id, r.ctx);
    if got is distinct from r.expect::uuid then
      bad := bad || format('%s: %s (expected %s)', r.what, coalesce(got::text, 'null'), coalesce(r.expect, 'null'));
    end if;
  end loop;
  if public.official_attempt_in_context(null, c1, 'individual') is not null
     or public.official_attempt_in_context('00000000-0000-0000-0000-000107010003', null, 'individual') is not null
     or public.official_attempt_in_context('00000000-0000-0000-0000-000107010003', c1, null) is not null
     or public.official_attempt_in_context('00000000-0000-0000-0000-000107010003', c1, 'path:not-a-uuid') is not null then
    bad := bad || 'a null argument or an unknown key answers an attempt'::text;
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107: (21) %', array_to_string(bad, '; ');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (22) instance_pass_required: the view's resolved rule on every step row;
--      a path key, a journey key, the other keys and malformed ones; never
--      null
-- ---------------------------------------------------------------------------
do $$
declare
  bad text[] := '{}';
  r   record;
  got boolean;
  n   bigint;
  m   bigint;
  pf  constant text := '00000000-0000-0000-0000-000107162001';
  e1  constant text := '00000000-0000-0000-0000-000107163401';
  e4  constant text := '00000000-0000-0000-0000-000107163404';
begin
  select count(*), count(*) filter (where public.instance_pass_required(s.course_id, 'path:' || s.path_id::text)
                                          is distinct from s.pass_required)
    into n, m
    from public.v_path_step_status s;
  if m <> 0 then
    bad := bad || format('%s of %s step rows: the function differs from v_path_step_status.pass_required', m, n);
  end if;
  if (select count(*) from public.v_path_step_status where path_id = pf::uuid) <> 3 then
    bad := bad || 'PF does not read three step rows'::text;
  end if;

  for r in
    select * from (values
      ('F1 on PF: the step''s true over the course''s false', 1, 'path:' || pf, true),
      ('F2 on PF: the step inherits the course''s true', 2, 'path:' || pf, true),
      ('F3 on PF: the step''s false over the course''s true', 3, 'path:' || pf, false),
      ('F4, no step of PF: the course''s true', 4, 'path:' || pf, true),
      ('F5, no step of PF: the course''s false', 5, 'path:' || pf, false),
      ('F3 on an unknown path: the course''s true', 3, 'path:00000000-0000-0000-0000-000107169999', true),
      ('F1 on PF with a trailing space (no key form): the course''s false', 1, 'path:' || pf || ' ', false),
      ('F1 on E1 day 1: the day''s true over the course''s false', 1,
       'journey:' || e1 || ':00000000-0000-0000-0000-000107163101', true),
      ('F2 on E1 day 2: the first entry''s false, not the second''s true, over the course''s true', 2,
       'journey:' || e1 || ':00000000-0000-0000-0000-000107163102', false),
      ('F1 on E1 day 3: null, the course''s false', 1, 'journey:' || e1 || ':00000000-0000-0000-0000-000107163103', false),
      ('F3 on E1 day 3: null, the given course''s true', 3,
       'journey:' || e1 || ':00000000-0000-0000-0000-000107163103', true),
      ('F5 on E1 day 5: the string "true" is no rule, the course''s false', 5,
       'journey:' || e1 || ':00000000-0000-0000-0000-000107163105', false),
      ('F3 on E1 day 8, which VA does not hold: the course''s true', 3,
       'journey:' || e1 || ':00000000-0000-0000-0000-000107163108', true),
      ('F1 on E1 day 8: the course''s false', 1, 'journey:' || e1 || ':00000000-0000-0000-0000-000107163108', false),
      ('F1 on E1 day 9, removed: the course''s false', 1,
       'journey:' || e1 || ':00000000-0000-0000-0000-000107163109', false),
      ('F1 on E4 day 1 (a reset enrolment pinned to VA): the day''s true', 1,
       'journey:' || e4 || ':00000000-0000-0000-0000-000107163101', true),
      ('F2 on an unknown enrolment: the course''s true', 2,
       'journey:00000000-0000-0000-0000-000107169999:00000000-0000-0000-0000-000107163102', true),
      ('F1, journey key without a day: the course''s false', 1, 'journey:' || e1, false),
      ('F2, Individual: the course''s true', 2, 'individual', true),
      ('F1, Individual: the course''s false', 1, 'individual', false),
      ('F2, preview: the course''s true', 2, 'preview', true),
      ('F1, a test run''s key: the course''s false', 1, 'preview:00000000-0000-0000-0000-000107169999', false),
      ('F2, path:not-a-uuid: the course''s true', 2, 'path:not-a-uuid', true),
      ('F2, a null key: the course''s true', 2, null, true),
      ('seed C1 on P1: no step rule, the course''s false', 0, 'path:00000000-0000-0000-0000-000107050001', false)
    ) as t(what, course_n, ctx, expect)
  loop
    got := public.instance_pass_required(
             case when r.course_n = 0 then '00000000-0000-0000-0000-0000000000c1'::uuid
                  else pg_temp.id_0107f('0001071610' || lpad(r.course_n::text, 2, '0')) end, r.ctx);
    if got is distinct from r.expect then
      bad := bad || format('%s: %s (expected %s)', r.what, coalesce(got::text, 'null'), r.expect);
    end if;
  end loop;
  if public.instance_pass_required(null, 'individual') is distinct from false
     or public.instance_pass_required('00000000-0000-0000-0000-000107169999', 'individual') is distinct from false
     or public.instance_pass_required(null, null) is distinct from false then
    bad := bad || 'an unknown or null course does not answer false'::text;
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107: (22) %', array_to_string(bad, '; ');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (23) journey_attempt_satisfies (step 13, R14): the caller's rule, or the
--      rule of the day in the version the attempt was launched under
-- ---------------------------------------------------------------------------
do $$
declare
  bad text[] := '{}';
  r   record;
  got boolean;
begin
  for r in
    select * from (values
      ('s11 failed, launched under VB (day 1 false), target true', 11, true, true),
      ('s11, target null (read as pass required; VB still relaxes)', 11, null, true),
      ('s12 failed, launched under VB (day 2 true), target false', 12, false, true),
      ('s12, target true', 12, true, false),
      ('s13 failed, launched under VA (day 1 true), target true', 13, true, false),
      ('s13, target false', 13, false, true),
      ('s14 failed, launched under VA (day 3 null: F1''s false), target true', 14, true, true),
      ('s15 failed, no launched version, target true', 15, true, false),
      ('s15, target false', 15, false, true),
      ('s15, target null (pass required)', 15, null, false),
      ('s16 passed, target true', 16, true, true),
      ('s16 passed, target null', 16, null, true),
      ('s17 open, target false', 17, false, false),
      ('s18 completed with no verdict, launched under VA (day 5 "true": F5''s false), target true', 18, true, true),
      ('s18, target false', 18, false, true),
      ('s19 failed, launched under VC (no day 1), target true', 19, true, false),
      ('s19, target false', 19, false, true),
      ('s20 an Individual row, failed, target false', 20, false, true),
      ('s20, target true', 20, true, false),
      ('s21 failed, launched under VA (day 2 listed twice: the first entry''s false), target true', 21, true, true),
      ('E1''s open row on D02, target false', 1, false, false),
      ('E1''s passed row on D03, target true', 5, true, true)
    ) as t(what, n, target, expect)
  loop
    got := public.journey_attempt_satisfies(pg_temp.id_0107f('000107164' || lpad(r.n::text, 3, '0')), r.target);
    if got is distinct from r.expect then
      bad := bad || format('%s: %s (expected %s)', r.what, coalesce(got::text, 'null'), r.expect);
    end if;
  end loop;
  if public.journey_attempt_satisfies('00000000-0000-0000-0000-000107169999', false) is distinct from false
     or public.journey_attempt_satisfies(null, false) is distinct from false
     or public.journey_attempt_satisfies(null, null) is distinct from false then
    bad := bad || 'an unknown or null attempt does not answer false'::text;
  end if;
  -- the seed: J's passed day-1 row, launched before 0107 (no launched version)
  if public.journey_attempt_satisfies('00000000-0000-0000-0000-000107070011', true) is distinct from true
     or public.journey_attempt_satisfies('00000000-0000-0000-0000-000107070012', false) is distinct from false then
    bad := bad || 'the seed''s journey rows are judged wrongly'::text;
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107: (23) %', array_to_string(bad, '; ');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (24) journey_credit_state and journey_reminder_counts (step 13; note N14;
--      twins contract 4.1 and 4.5)
-- ---------------------------------------------------------------------------
do $$
declare
  bad text[] := '{}';
  r   record;
  got text;
  n   bigint;
  r4  constant boolean := exists (select 1 from public.journey_day_progress
                                   where id = '00000000-0000-0000-0000-000107120004');
begin
  for r in
    select * from (values
      -- the seed (V1: days 1 to 4 required)
      ('EJ: day 1 credited, day 2 open', '00000000-0000-0000-0000-000107063001',
       'req=4 done=1 cred={1} ids={d01} next=2/d02 res={d02}', 'done=1 today=F cred={1}'),
      ('ES: a credit a preview row backs (legacy_cross_context) counts', '00000000-0000-0000-0000-000107063002',
       'req=4 done=1 cred={1} ids={d01} next=2/d02 res={}', 'done=1 today=F cred={1}'),
      ('EB (completed): day 5 is beyond its pinned version; r4 credits day 4 between the pastes',
       '00000000-0000-0000-0000-000107063003',
       case when r4 then 'req=4 done=4 cred={1,2,3,4} ids={d01,d02,d03,d04} next=-/- res={}'
            else 'req=4 done=3 cred={1,2,3} ids={d01,d02,d03} next=4/d04 res={}' end,
       case when r4 then 'done=4 today=% cred={1,2,3,4}' else 'done=3 today=F cred={1,2,3}' end),
      ('EI (reset): no credit', '00000000-0000-0000-0000-000107063004',
       'req=4 done=0 cred={} ids={} next=1/d01 res={}', 'done=0 today=F cred={}'),
      -- the fixtures (VA: days 1, 2, 3, 5 and 6 required)
      ('E1: credits by identity; D03 credited as number 7; rest-day, above-total, unheld and removed credits count '
       || 'nothing; resumable on D02 and the removed D09', '00000000-0000-0000-0000-000107163401',
       'req=5 done=3 cred={1,3,5} ids={D01,D03,D05} next=2/D02 res={D02,D09}', 'done=3 today=T cred={1,3,5}'),
      ('E2 (completed): every required day credited', '00000000-0000-0000-0000-000107163402',
       'req=5 done=5 cred={1,2,3,5,6} ids={D01,D02,D03,D05,D06} next=-/- res={}', 'done=5 today=F cred={1,2,3,5,6}'),
      ('E3: zero required days, never complete', '00000000-0000-0000-0000-000107163403',
       'req=0 done=0 cred={} ids={} next=-/- res={}', 'done=0 today=F cred={}'),
      ('E4 (reset): no credit', '00000000-0000-0000-0000-000107163404',
       'req=5 done=0 cred={} ids={} next=1/D01 res={}', 'done=0 today=F cred={}'),
      ('E5: one open row (s17 on D02)', '00000000-0000-0000-0000-000107163405',
       'req=5 done=0 cred={} ids={} next=1/D01 res={D02}', 'done=0 today=F cred={}'),
      ('an unknown enrolment', '00000000-0000-0000-0000-000107169999', 'none', 'none')
    ) as t(what, enr, jcs, jrc)
  loop
    got := pg_temp.jcs_0107f(r.enr::uuid);
    if got is distinct from r.jcs then
      bad := bad || format('%s: journey_credit_state %s (expected %s)', r.what, got, r.jcs);
    end if;
    got := pg_temp.jrc_0107f(r.enr::uuid);
    if not (got like r.jrc) then
      bad := bad || format('%s: journey_reminder_counts %s (expected %s)', r.what, got, r.jrc);
    end if;
  end loop;

  -- E1: the count of 0089 would read 7; done is the credited days
  if (select count(*) from public.journey_day_progress
       where enrollment_id = '00000000-0000-0000-0000-000107163401') <> 7 then
    bad := bad || 'E1 does not hold seven credit rows'::text;
  end if;

  -- one row per enrolment that exists, in enrollment_id order; duplicates
  -- and unknown ids add none; an empty or null array answers no row
  select string_agg(right(o.enrollment_id::text, 6), ',' order by o.n) into got
    from (select x.enrollment_id, row_number() over () as n
            from public.journey_credit_state(array[
              '00000000-0000-0000-0000-000107163402', '00000000-0000-0000-0000-000107163401',
              '00000000-0000-0000-0000-000107163402', '00000000-0000-0000-0000-000107169999']::uuid[]) x) o;
  if got is distinct from '163401,163402' then
    bad := bad || format('journey_credit_state over (E2, E1, E2, unknown) answers %s (expected 163401,163402)',
                         coalesce(got, 'no row'));
  end if;
  if exists (select 1 from public.journey_credit_state('{}'::uuid[]))
     or exists (select 1 from public.journey_credit_state(null))
     or exists (select 1 from public.journey_reminder_counts('{}'::uuid[]))
     or exists (select 1 from public.journey_reminder_counts(null)) then
    bad := bad || 'an empty or null array answers a row'::text;
  end if;

  -- the shape on every enrolment of the database: one row each, arrays
  -- never null, credited ascending and parallel to its ids, the count and
  -- next_day consistent, resumable ascending; and journey_reminder_counts
  -- agrees with it on done and credited
  select count(*) into n
    from public.journey_enrollments e
    full join public.journey_credit_state(array(select id from public.journey_enrollments)) s
      on s.enrollment_id = e.id
   where e.id is null or s.enrollment_id is null
      or s.credited is null or s.credited_day_ids is null or s.resumable_day_ids is null
      or s.required_days is null or s.credited_days is null
      or cardinality(s.credited) <> s.credited_days or cardinality(s.credited_day_ids) <> s.credited_days
      or s.credited_days > s.required_days
      or (s.next_day is null) <> (s.credited_days = s.required_days)
      or (s.next_day is null) <> (s.next_day_id is null)
      or s.credited <> array(select x from unnest(s.credited) as x order by x)
      or s.resumable_day_ids <> array(select x from unnest(s.resumable_day_ids) as x order by x)
      or s.credited_day_ids <> array(
           select (jv.day_ids ->> c.x::text)::uuid
             from unnest(s.credited) with ordinality as c(x, o)
             join public.journey_versions jv on jv.id = e.version_id
            order by c.o);
  if n <> 0 then
    bad := bad || format('%s enrolment(s) break the shape of journey_credit_state', n);
  end if;
  select count(*) into n
    from public.journey_credit_state(array(select id from public.journey_enrollments)) s
    full join public.journey_reminder_counts(array(select id from public.journey_enrollments)) c
      on c.enrollment_id = s.enrollment_id
   where s.enrollment_id is null or c.enrollment_id is null
      or c.done is distinct from s.credited_days or c.credited is distinct from s.credited or c.done_today is null;
  if n <> 0 then
    bad := bad || format('%s enrolment(s): journey_reminder_counts disagrees with journey_credit_state', n);
  end if;

  if cardinality(bad) > 0 then
    raise exception 'assert-0107: (24) %', array_to_string(bad, '; ');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (25) as the API roles (after-check A1 to A16's privilege matrix): anon and
--      authenticated are refused each function with 42501; service_role,
--      given the privileges Supabase's defaults give it on the tables (the
--      shim gives none), calls each and reads what postgres reads. The
--      statements name ids, never auth.uid().
-- ---------------------------------------------------------------------------
create temporary table r0107f_roles (who text, what text, got text);
grant select, insert on pg_temp.r0107f_roles to authenticated, anon, service_role;
grant execute on all functions in schema pg_temp to authenticated, anon, service_role;

create temporary table r0107f_calls (what text, stmt text);
grant select on pg_temp.r0107f_calls to authenticated, anon, service_role;
insert into pg_temp.r0107f_calls values
  ('official_attempt_in_context', 'select public.official_attempt_in_context(''00000000-0000-0000-0000-000107010003'', '
     || '''00000000-0000-0000-0000-0000000000c1'', ''individual'')'),
  ('instance_pass_required', 'select public.instance_pass_required(''00000000-0000-0000-0000-000107161001'', '
     || '''path:00000000-0000-0000-0000-000107162001'')'),
  ('journey_attempt_satisfies', 'select public.journey_attempt_satisfies(''00000000-0000-0000-0000-000107164011'', true)'),
  ('journey_credit_state', 'select * from public.journey_credit_state(''{00000000-0000-0000-0000-000107163401}'')'),
  ('journey_reminder_counts', 'select * from public.journey_reminder_counts(''{00000000-0000-0000-0000-000107163401}'')');

select set_config('request.jwt.claims', '{"role": "anon"}', true);
set local role anon;
insert into pg_temp.r0107f_roles select 'anon', c.what, pg_temp.as_owner_state(c.stmt) from pg_temp.r0107f_calls c;
reset role;

select set_config('request.jwt.claims',
  '{"sub": "00000000-0000-0000-0000-000107160001", "role": "authenticated"}', true);
set local role authenticated;
insert into pg_temp.r0107f_roles select 'authenticated', c.what, pg_temp.as_owner_state(c.stmt) from pg_temp.r0107f_calls c;
reset role;

grant usage on schema public to service_role;
grant select on all tables in schema public to service_role;
select set_config('request.jwt.claims', '{"role": "service_role"}', true);
set local role service_role;
insert into pg_temp.r0107f_roles select 'service_role', c.what, pg_temp.as_owner_state(c.stmt) from pg_temp.r0107f_calls c;
insert into pg_temp.r0107f_roles values
  ('service_role', 'official_attempt_in_context, the answer',
   public.official_attempt_in_context('00000000-0000-0000-0000-000107010003', '00000000-0000-0000-0000-0000000000c1',
                                      'path:00000000-0000-0000-0000-000107050001')::text),
  ('service_role', 'instance_pass_required, the answer',
   public.instance_pass_required('00000000-0000-0000-0000-000107161002',
                                 'journey:00000000-0000-0000-0000-000107163401:00000000-0000-0000-0000-000107163102')::text),
  ('service_role', 'journey_attempt_satisfies, the answer',
   public.journey_attempt_satisfies('00000000-0000-0000-0000-000107164011', true)::text),
  ('service_role', 'journey_credit_state, the answer', pg_temp.jcs_0107f('00000000-0000-0000-0000-000107163401')),
  ('service_role', 'journey_reminder_counts, the answer', pg_temp.jrc_0107f('00000000-0000-0000-0000-000107163401'));
reset role;
select set_config('request.jwt.claims', '', true);

do $$
declare
  bad text[] := '{}';
  r   record;
  exp text;
begin
  if (select count(*) from pg_temp.r0107f_roles) <> 20 then
    bad := bad || format('%s of the 20 role cases ran', (select count(*) from pg_temp.r0107f_roles));
  end if;
  for r in select * from pg_temp.r0107f_roles loop
    exp := case
      when r.who in ('anon', 'authenticated') then '42501'
      when r.what = 'official_attempt_in_context, the answer' then '00000000-0000-0000-0000-000107070008'
      when r.what = 'instance_pass_required, the answer' then 'false'
      when r.what = 'journey_attempt_satisfies, the answer' then 'true'
      when r.what = 'journey_credit_state, the answer' then pg_temp.jcs_0107f('00000000-0000-0000-0000-000107163401')
      when r.what = 'journey_reminder_counts, the answer' then pg_temp.jrc_0107f('00000000-0000-0000-0000-000107163401')
      else 'no error, 1 row(s)'
    end;
    if r.got is distinct from exp then
      bad := bad || format('as %s, %s: %s (expected %s)', r.who, r.what, coalesce(r.got, 'null'), exp);
    end if;
  end loop;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107: (25) %', array_to_string(bad, '; ');
  end if;
end
$$;

rollback;
