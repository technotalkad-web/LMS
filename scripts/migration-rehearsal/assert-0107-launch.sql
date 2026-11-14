-- scripts/migration-rehearsal/assert-0107-launch.sql
-- The four 0107 scenarios that apply it, after each assert-0107-writer.sql,
-- and 0107-then-0108 after the first paste: what section 6p of
-- 0107_learning_contexts.sql, launch_context (ADR 0024 step 18; build note
-- N15; twins contract 5.1, B7 and A10), must answer, and what 6m to 6o did.
-- One transaction that ends in ROLLBACK; every check raises
-- 'assert-0107: (4n) ...' on failure. It continues the numbering of
-- assert-0107-writer.sql:
--   (41) the object: arguments, result, plpgsql, stable, security definer,
--        the pinned search_path, a comment, execute for service_role alone
--   (42) on the committed seed, the facts equal direct selects (step 63):
--        P on P1 (sequence_mode, each step's step_number, release_at and
--        done, course_step, holders), O on the "Everyone" path P2 with its
--        self-enrolment row, J on enrolment EJ (start_date, unlock_mode,
--        count_sundays, the timezone, credited_days, next_day, the day by
--        id and by an old link's number, its credit, its open attempt,
--        resumable_day_ids, the holder days), and a3 of QA Org, who gets no
--        enrolment facts of Org A; the key tree of N15 exactly, at every
--        level, with found false carrying no other key
--   (43) the contract's edge cases on fixtures of their own (ids
--        …000107190…): a strict path with no step done, a random-mode path,
--        an unreleased step, a course assignment not yet released
--        (upcoming_at), an open attempt on a removed day (resume), a course
--        swapped on a credited day, a completed enrolment, a day of another
--        program, an inactive course and program (whose journey days are
--        then no holder, ruling A1 of 2026-11-14), a member who is not active
--   (44) build note O1-g, the launch_context legs: on a strict path, a step
--        done without a pass and recorded by the writer stays done in
--        steps[].done when its rule is tightened (1), at the course as well
--        (2); a step tightened before it was done reads not done (3), and
--        done again at once when relaxed (4); tightened again with no
--        completion it reads not done (8); a failed granted retake on a
--        step done by its fact keeps it done (11); a completed path whose
--        step is tightened stays completed with every step done (6); a step
--        removed and added again finds its fact (7)
-- and the other three parts of section 6 that slice 9 built beside it:
--   (45) 6m, the two refresh functions: their view entries in order, then
--        the completion sweep's entry, which counts the row it handled
--   (46) 6n, gamification_close_month's highest_scorer (step 35) on an
--        organisation of its own: last month's official Individual and path
--        results averaged per learner; revision, abandoned, preview and
--        journey rows and this month's results never count
--   (47) 6o, journey_auto_enroll: a new member reached by an auto-enrol
--        journey is enrolled with source audience

begin;

create function pg_temp.lc(p_user uuid, p_org uuid, p_course uuid, p_path uuid, p_enr uuid, p_day_id uuid, p_day int)
returns jsonb language sql stable as $$
  select public.launch_context(p_user, p_org, p_course, p_path, p_enr, p_day_id, p_day)
$$;
create function pg_temp.keys(p jsonb) returns text language sql immutable as $$
  select coalesce(string_agg(k, ',' order by k), '') from jsonb_object_keys(p) as k
$$;
create function pg_temp.u(p text) returns uuid language sql immutable as $$
  select ('00000000-0000-0000-0000-' || p)::uuid
$$;

-- ---------------------------------------------------------------------------
-- (41) the object
-- ---------------------------------------------------------------------------
do $$
declare
  g record;
begin
  select p.prorettype::regtype::text as ret, l.lanname::text as lang, p.provolatile, p.prosecdef, p.proconfig,
         pg_get_function_identity_arguments(p.oid) as args, p.pronargdefaults,
         obj_description(p.oid, 'pg_proc') as cmt
    into g
    from pg_proc p join pg_language l on l.oid = p.prolang
   where p.oid = to_regprocedure('public.launch_context(uuid,uuid,uuid,uuid,uuid,uuid,integer)');
  if not found then
    raise exception 'assert-0107: (41) launch_context(uuid, uuid, uuid, uuid, uuid, uuid, integer) is missing';
  end if;
  if (select count(*) from pg_proc where proname = 'launch_context' and pronamespace = 'public'::regnamespace) <> 1
     or g.ret <> 'jsonb' or g.lang <> 'plpgsql' or g.provolatile <> 's' or not g.prosecdef
     or g.proconfig is distinct from array['search_path=pg_catalog, public'] or g.pronargdefaults <> 0
     or g.args <> 'p_user uuid, p_org uuid, p_course uuid, p_path uuid, p_enrollment uuid, p_day_id uuid, p_day integer'
     or g.cmt is null
     or has_function_privilege('anon', 'public.launch_context(uuid,uuid,uuid,uuid,uuid,uuid,integer)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.launch_context(uuid,uuid,uuid,uuid,uuid,uuid,integer)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.launch_context(uuid,uuid,uuid,uuid,uuid,uuid,integer)', 'EXECUTE') then
    raise exception 'assert-0107: (41) launch_context reads %', row_to_json(g);
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (42) the committed seed: the facts equal direct selects
-- ---------------------------------------------------------------------------
do $$
declare
  bad  text[] := '{}';
  org  constant uuid := '00000000-0000-0000-0000-00000000000a';
  orgb constant uuid := '00000000-0000-0000-0000-00000000000b';
  c1   constant uuid := '00000000-0000-0000-0000-0000000000c1';
  c2   constant uuid := '00000000-0000-0000-0000-0000000000c2';
  k    constant uuid := pg_temp.u('000107040001');
  p1   constant uuid := pg_temp.u('000107050001');
  p2   constant uuid := pg_temp.u('000107050002');
  ej   constant uuid := pg_temp.u('000107063001');
  lp   constant uuid := pg_temp.u('000107010002');
  lo   constant uuid := pg_temp.u('000107010005');
  lj   constant uuid := pg_temp.u('000107010004');
  a3   constant uuid := '00000000-0000-0000-0000-0000000000a3';
  d1   constant uuid := pg_temp.u('000107061001');
  d2   constant uuid := pg_temp.u('000107061002');
  d3   constant uuid := pg_temp.u('000107061003');
  j    jsonb;
  want jsonb;
begin
  -- P on P1, launching C2 (step 2)
  j := pg_temp.lc(lp, org, c2, p1, null, null, null);
  if pg_temp.keys(j) <> 'course,holders,journey,member,path,run,v' or j -> 'v' <> '1'::jsonb
     or j -> 'run' <> 'null'::jsonb or j -> 'journey' <> 'null'::jsonb then
    bad := bad || format('P: the top level reads %s', j);
  end if;
  if pg_temp.keys(j -> 'member') <> 'active' or pg_temp.keys(j -> 'course') <> 'found,individual,is_active,visibility'
     or pg_temp.keys(j -> 'course' -> 'individual') <> 'enrolled,upcoming_at'
     or pg_temp.keys(j -> 'path') <> 'course_step,enrolled,found,is_active,self_row,sequence_mode,steps,visibility'
     or pg_temp.keys(j -> 'holders') <> 'journey_days,paths'
     or exists (select 1 from jsonb_array_elements(j -> 'path' -> 'steps') s
                 where pg_temp.keys(s) <> 'course_id,done,release_at,step_number')
     or exists (select 1 from jsonb_array_elements(j -> 'holders' -> 'paths') s
                 where pg_temp.keys(s) <> 'path_id,step_number') then
    bad := bad || format('P: the key tree reads %s', j);
  end if;
  want := jsonb_build_object(
    'found', true,
    'is_active', (select lp_.is_active from public.learning_paths lp_ where lp_.id = p1),
    'visibility', (select lp_.visibility from public.learning_paths lp_ where lp_.id = p1),
    'sequence_mode', (select lp_.sequence_mode from public.learning_paths lp_ where lp_.id = p1),
    'enrolled', true,
    'self_row', false,
    'course_step', 2,
    'steps', (select jsonb_agg(jsonb_build_object('course_id', lpc.course_id, 'step_number', lpc.step_number,
                                                  'release_at', lpc.release_at,
                                                  'done', coalesce((select s.done from public.v_path_step_status s
                                                                     where s.path_id = p1 and s.user_id = lp
                                                                       and s.course_id = lpc.course_id), false))
                               order by lpc.step_number)
                from public.learning_path_courses lpc where lpc.path_id = p1));
  if j -> 'path' <> want
     or j -> 'path' -> 'steps' <> jsonb_build_array(
          jsonb_build_object('course_id', c1, 'step_number', 1, 'release_at', null, 'done', true),
          jsonb_build_object('course_id', c2, 'step_number', 2, 'release_at', null, 'done', false)) then
    bad := bad || format('P: path %s (expected %s)', j -> 'path', want);
  end if;
  if j -> 'member' <> '{"active": true}'::jsonb
     or j -> 'course' <> jsonb_build_object('found', true, 'is_active', true, 'visibility', 'private',
                                            'individual', jsonb_build_object('enrolled', false, 'upcoming_at', null))
     or j -> 'holders' <> jsonb_build_object('paths', jsonb_build_array(jsonb_build_object('path_id', p1, 'step_number', 2)),
                                             'journey_days', '[]'::jsonb) then
    bad := bad || format('P: member, course or holders read %s', j);
  end if;

  -- O on P2 ("Everyone", org_public), self-enrolled: the row the launch's
  -- self-enrolment writes (source self, step 8)
  update public.learning_path_assignments set source = 'self' where id = pg_temp.u('000107051003');
  j := pg_temp.lc(lo, org, k, p2, null, null, null);
  if j -> 'path' <> jsonb_build_object('found', true, 'is_active', true, 'visibility', 'org_public',
                                       'sequence_mode', 'strict', 'enrolled', true, 'self_row', true,
                                       'course_step', 1,
                                       'steps', jsonb_build_array(jsonb_build_object('course_id', k, 'step_number', 1,
                                                                                     'release_at', null, 'done', false)))
     or j -> 'holders' -> 'paths' <> jsonb_build_array(jsonb_build_object('path_id', p2, 'step_number', 1)) then
    bad := bad || format('O: %s', j);
  end if;
  -- P launching K on P2: a path P is not enrolled on, and no holder
  j := pg_temp.lc(lp, org, k, p2, null, null, null);
  if (j -> 'path' ->> 'enrolled')::boolean or (j -> 'path' ->> 'self_row')::boolean
     or j -> 'holders' -> 'paths' <> '[]'::jsonb then
    bad := bad || format('P on P2: %s', j);
  end if;

  -- J on EJ, day 1 by its id (credited), launching C1
  j := pg_temp.lc(lj, org, c1, null, ej, d1, null);
  if pg_temp.keys(j -> 'journey') <> 'count_sundays,credited_days,day,day_credit,day_open_attempt,days_total,found,'
                                      || 'next_day,next_day_id,program_id,program_is_active,required_days,'
                                      || 'resumable_day_ids,start_date,status,timezone,unlock_mode,version_id'
     or pg_temp.keys(j -> 'journey' -> 'day') <> 'course_id,id,in_version,number,removed'
     or pg_temp.keys(j -> 'journey' -> 'day_credit') <> 'attempt_id,course_id,credit_kind,day_number'
     or j -> 'path' <> 'null'::jsonb then
    bad := bad || format('J: the key tree reads %s', j);
  end if;
  want := (select jsonb_build_object(
             'found', true, 'status', e.status, 'program_id', e.program_id, 'program_is_active', jp.is_active,
             'start_date', e.start_date, 'version_id', e.version_id, 'unlock_mode', v.unlock_mode,
             'count_sundays', v.count_sundays, 'days_total', v.days_total,
             'timezone', coalesce((select gs.timezone from public.gamification_settings gs where gs.organization_id = org),
                                  'Asia/Kolkata'),
             'day', jsonb_build_object('id', d1, 'number', 1, 'in_version', true, 'removed', false, 'course_id', c1),
             'day_credit', (select jsonb_build_object('course_id', p.course_id, 'attempt_id', p.attempt_id,
                                                      'credit_kind', p.credit_kind, 'day_number', p.day_number)
                              from public.journey_day_progress p where p.enrollment_id = ej and p.day_id = d1),
             'day_open_attempt', null,
             'required_days', cs.required_days, 'credited_days', cs.credited_days, 'next_day', cs.next_day,
             'next_day_id', cs.next_day_id, 'resumable_day_ids', to_jsonb(cs.resumable_day_ids))
             from public.journey_enrollments e
             join public.journey_programs jp on jp.id = e.program_id
             join public.journey_versions v on v.id = e.version_id
             cross join lateral public.journey_credit_state(array[e.id]) cs
            where e.id = ej);
  if j -> 'journey' <> want
     or j -> 'journey' ->> 'start_date' <> (current_date - 3)::text
     or j -> 'journey' -> 'credited_days' <> '1'::jsonb or j -> 'journey' -> 'next_day' <> '2'::jsonb
     or j -> 'journey' ->> 'next_day_id' <> d2::text
     or j -> 'journey' -> 'resumable_day_ids' <> jsonb_build_array(d2)
     or j -> 'journey' -> 'day_credit' ->> 'attempt_id' <> pg_temp.u('000107070011')::text
     or j -> 'journey' -> 'day_credit' ->> 'credit_kind' <> 'attempt' then
    bad := bad || format('J: journey %s (expected %s)', j -> 'journey', want);
  end if;
  -- the holder days: EJ's required days that hold C1 (days 1 and 3)
  if j -> 'holders' <> jsonb_build_object(
       'paths', '[]'::jsonb,
       'journey_days', jsonb_build_array(
         jsonb_build_object('enrollment_id', ej, 'day_id', d1, 'day_number', 1, 'credited', true),
         jsonb_build_object('enrollment_id', ej, 'day_id', d3, 'day_number', 3, 'credited', false))) then
    bad := bad || format('J: holders %s', j -> 'holders');
  end if;
  -- an old link's number, day 2: the open day, with its open attempt
  j := pg_temp.lc(lj, org, c2, null, ej, null, 2);
  if j -> 'journey' -> 'day' <> jsonb_build_object('id', d2, 'number', 2, 'in_version', true, 'removed', false,
                                                   'course_id', c2)
     or j -> 'journey' -> 'day_credit' <> 'null'::jsonb
     or j -> 'journey' -> 'day_open_attempt' <> jsonb_build_object('attempt_id', pg_temp.u('000107070012'), 'course_id', c2) then
    bad := bad || format('J by number: %s', j -> 'journey');
  end if;
  -- neither a day id nor a number: no day
  j := pg_temp.lc(lj, org, c1, null, ej, null, null);
  if j -> 'journey' -> 'day' <> '{"id": null, "number": null, "in_version": false, "removed": false, "course_id": null}'::jsonb
     or j -> 'journey' -> 'day_credit' <> 'null'::jsonb or j -> 'journey' -> 'day_open_attempt' <> 'null'::jsonb then
    bad := bad || format('J with no day: %s', j -> 'journey' -> 'day');
  end if;

  -- a3, a member of QA Org: no enrolment facts of Org A, whichever
  -- organisation is passed
  j := pg_temp.lc(a3, orgb, c1, p1, ej, d1, null);
  if j -> 'course' <> '{"found": false}'::jsonb or j -> 'path' <> '{"found": false}'::jsonb
     or j -> 'journey' <> '{"found": false}'::jsonb or j -> 'member' <> '{"active": true}'::jsonb
     or j -> 'holders' <> '{"paths": [], "journey_days": []}'::jsonb then
    bad := bad || format('a3 in QA Org: %s', j);
  end if;
  j := pg_temp.lc(a3, org, c1, p1, ej, d1, null);
  if j -> 'journey' <> '{"found": false}'::jsonb or j -> 'member' <> '{"active": false}'::jsonb
     or (j -> 'path' ->> 'enrolled')::boolean or (j -> 'course' -> 'individual' ->> 'enrolled')::boolean
     or exists (select 1 from jsonb_array_elements(j -> 'path' -> 'steps') s where (s ->> 'done')::boolean)
     or j -> 'holders' <> '{"paths": [], "journey_days": []}'::jsonb then
    bad := bad || format('a3 against Org A: %s', j);
  end if;
  -- J's enrolment asked for by another learner of the same organisation
  j := pg_temp.lc(lp, org, c1, null, ej, d1, null);
  if j -> 'journey' <> '{"found": false}'::jsonb then
    bad := bad || format('P asking for EJ: %s', j -> 'journey');
  end if;

  if cardinality(bad) > 0 then
    raise exception 'assert-0107: (42) %', array_to_string(bad, '; ');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (43) the edge cases of the twins contract (5.3), on fixtures of their own
-- ---------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000107190001', 'launch-l1-0107@example.test'),
  ('00000000-0000-0000-0000-000107190002', 'launch-l2-0107@example.test');
insert into public.organization_members (organization_id, user_id, role, status) values
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000107190001', 'user', 'active'),
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000107190002', 'user', 'suspended');
-- PL strict (C1 then C2, step 2 not released), PR random (C2)
insert into public.learning_paths (id, organization_id, name, slug, is_active, visibility, sequence_mode) values
  ('00000000-0000-0000-0000-000107190101', '00000000-0000-0000-0000-00000000000a', 'PL launch (0107)', 'launch-pl-0107', true, 'private', 'strict'),
  ('00000000-0000-0000-0000-000107190102', '00000000-0000-0000-0000-00000000000a', 'PR launch (0107)', 'launch-pr-0107', false, 'private', 'random');
insert into public.learning_path_courses (path_id, course_id, step_number, release_at) values
  ('00000000-0000-0000-0000-000107190101', '00000000-0000-0000-0000-0000000000c1', 1, null),
  ('00000000-0000-0000-0000-000107190101', '00000000-0000-0000-0000-0000000000c2', 2, '2999-01-01 00:00:00+00'),
  ('00000000-0000-0000-0000-000107190102', '00000000-0000-0000-0000-0000000000c2', 1, null);
insert into public.learning_path_assignments (id, path_id, organization_id, assignee_type, user_id, assigned_by) values
  ('00000000-0000-0000-0000-000107190201', '00000000-0000-0000-0000-000107190101', '00000000-0000-0000-0000-00000000000a',
   'user', '00000000-0000-0000-0000-000107190001', '00000000-0000-0000-0000-0000000000a2'),
  ('00000000-0000-0000-0000-000107190202', '00000000-0000-0000-0000-000107190102', '00000000-0000-0000-0000-00000000000a',
   'user', '00000000-0000-0000-0000-000107190001', '00000000-0000-0000-0000-0000000000a2');
-- C2 assigned to L1 directly, released in 2999 (not yet released)
insert into public.course_assignments (id, course_id, organization_id, assignee_type, user_id, assigned_by, release_at) values
  ('00000000-0000-0000-0000-000107190301', '00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-00000000000a',
   'user', '00000000-0000-0000-0000-000107190001', '00000000-0000-0000-0000-0000000000a2', '2999-01-01 00:00:00+00');
-- journey JL: days 1 C1, 2 C2, 3 K; version VL1 (all three), then VL2,
-- where day 1 holds C2 (a course swapped on a credited day)
insert into public.journey_programs (id, organization_id, name, days_total) values
  ('00000000-0000-0000-0000-000107190401', '00000000-0000-0000-0000-00000000000a', 'JL (0107)', 3),
  ('00000000-0000-0000-0000-000107190402', '00000000-0000-0000-0000-00000000000a', 'JM (0107)', 1);
insert into public.journey_days (id, program_id, organization_id, day_number, course_id) values
  ('00000000-0000-0000-0000-000107190411', '00000000-0000-0000-0000-000107190401', '00000000-0000-0000-0000-00000000000a', 1, '00000000-0000-0000-0000-0000000000c1'),
  ('00000000-0000-0000-0000-000107190412', '00000000-0000-0000-0000-000107190401', '00000000-0000-0000-0000-00000000000a', 2, '00000000-0000-0000-0000-0000000000c2'),
  ('00000000-0000-0000-0000-000107190413', '00000000-0000-0000-0000-000107190401', '00000000-0000-0000-0000-00000000000a', 3, '00000000-0000-0000-0000-000107040001'),
  ('00000000-0000-0000-0000-000107190421', '00000000-0000-0000-0000-000107190402', '00000000-0000-0000-0000-00000000000a', 1, '00000000-0000-0000-0000-0000000000c1');
insert into public.journey_versions (id, program_id, organization_id, version_number, name, days_total, count_sundays,
                                     completion_title, days, unlock_mode) values
  ('00000000-0000-0000-0000-000107190501', '00000000-0000-0000-0000-000107190401', '00000000-0000-0000-0000-00000000000a',
   1, 'JL (0107)', 3, true, 'Yoddha',
   '[{"day": 1, "course_id": "00000000-0000-0000-0000-0000000000c1"},
     {"day": 2, "course_id": "00000000-0000-0000-0000-0000000000c2"},
     {"day": 3, "course_id": "00000000-0000-0000-0000-000107040001"}]', 'progress'),
  ('00000000-0000-0000-0000-000107190502', '00000000-0000-0000-0000-000107190401', '00000000-0000-0000-0000-00000000000a',
   2, 'JL (0107)', 3, true, 'Yoddha',
   '[{"day": 1, "course_id": "00000000-0000-0000-0000-0000000000c2"},
     {"day": 2, "course_id": "00000000-0000-0000-0000-0000000000c2"},
     {"day": 3, "course_id": "00000000-0000-0000-0000-000107040001"}]', 'progress');
-- EL1 (L1, active, VL1): day 1 credited (self), an open attempt on day 2,
-- then day 2 removed; EL2 (L1, active, VL2): day 1 credited with C1, which
-- VL2 holds as C2 now; EL3 (L1, completed, VL1)
insert into public.journey_enrollments (id, program_id, version_id, organization_id, user_id, start_date, status, completed_at) values
  ('00000000-0000-0000-0000-000107190601', '00000000-0000-0000-0000-000107190401', '00000000-0000-0000-0000-000107190501',
   '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000107190001', '2000-01-03', 'active', null),
  ('00000000-0000-0000-0000-000107190602', '00000000-0000-0000-0000-000107190401', '00000000-0000-0000-0000-000107190502',
   '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000107190002', '2000-01-03', 'active', null),
  ('00000000-0000-0000-0000-000107190603', '00000000-0000-0000-0000-000107190401', '00000000-0000-0000-0000-000107190501',
   '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000107190002', '2000-01-03', 'completed', '2000-02-01');
insert into public.journey_day_progress (id, enrollment_id, organization_id, user_id, day_number, day_id, course_id,
                                         attempt_id, completed_at, credit_kind) values
  ('00000000-0000-0000-0000-000107190701', '00000000-0000-0000-0000-000107190601', '00000000-0000-0000-0000-00000000000a',
   '00000000-0000-0000-0000-000107190001', 1, '00000000-0000-0000-0000-000107190411', '00000000-0000-0000-0000-0000000000c1',
   null, '2000-01-03', 'self'),
  ('00000000-0000-0000-0000-000107190702', '00000000-0000-0000-0000-000107190602', '00000000-0000-0000-0000-00000000000a',
   '00000000-0000-0000-0000-000107190002', 1, '00000000-0000-0000-0000-000107190411', '00000000-0000-0000-0000-0000000000c1',
   null, '2000-01-03', 'admin');
insert into public.course_attempts (id, course_version_id, user_id, organization_id, status, completion_status,
                                    success_status, started_at, context_kind, journey_enrollment_id, journey_day,
                                    journey_day_id, journey_version_id, launch_mode)
values ('00000000-0000-0000-0000-000107190801', '00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-000107190001',
        '00000000-0000-0000-0000-00000000000a', 'in_progress', 'in_progress', 'unknown', '2000-01-04', 'journey',
        '00000000-0000-0000-0000-000107190601', 2, '00000000-0000-0000-0000-000107190412',
        '00000000-0000-0000-0000-000107190501', 'Normal');
update public.journey_days set day_number = null, removed_at = '2000-01-05'
 where id = '00000000-0000-0000-0000-000107190412';

do $$
declare
  bad  text[] := '{}';
  org  constant uuid := '00000000-0000-0000-0000-00000000000a';
  c1   constant uuid := '00000000-0000-0000-0000-0000000000c1';
  c2   constant uuid := '00000000-0000-0000-0000-0000000000c2';
  k    constant uuid := pg_temp.u('000107040001');
  l1   constant uuid := pg_temp.u('000107190001');
  l2   constant uuid := pg_temp.u('000107190002');
  pl   constant uuid := pg_temp.u('000107190101');
  pr   constant uuid := pg_temp.u('000107190102');
  el1  constant uuid := pg_temp.u('000107190601');
  el2  constant uuid := pg_temp.u('000107190602');
  el3  constant uuid := pg_temp.u('000107190603');
  dl1  constant uuid := pg_temp.u('000107190411');
  dl2  constant uuid := pg_temp.u('000107190412');
  dl3  constant uuid := pg_temp.u('000107190413');
  dm1  constant uuid := pg_temp.u('000107190421');
  a1   constant uuid := pg_temp.u('000107190801');
  j    jsonb;
begin
  -- a strict path, no step done, step 2 not yet released; C2 assigned and
  -- not yet released (upcoming_at)
  j := pg_temp.lc(l1, org, c2, pl, null, null, null);
  if j -> 'path' <> jsonb_build_object(
       'found', true, 'is_active', true, 'visibility', 'private', 'sequence_mode', 'strict', 'enrolled', true,
       'self_row', false, 'course_step', 2,
       'steps', jsonb_build_array(
         jsonb_build_object('course_id', c1, 'step_number', 1, 'release_at', null, 'done', false),
         jsonb_build_object('course_id', c2, 'step_number', 2, 'release_at', '2999-01-01 00:00:00+00'::timestamptz, 'done', false)))
     or (j -> 'path' -> 'steps' -> 1 ->> 'release_at')::timestamptz <> '2999-01-01 00:00:00+00'::timestamptz
     or j -> 'course' -> 'individual' -> 'enrolled' <> 'false'::jsonb
     or (j -> 'course' -> 'individual' ->> 'upcoming_at')::timestamptz is distinct from '2999-01-01 00:00:00+00'::timestamptz
     or j -> 'member' <> '{"active": true}'::jsonb then
    bad := bad || format('a strict path and an unreleased assignment: %s', j);
  end if;
  -- the holders of C2 for L1: PL only, because PR is not active
  if j -> 'holders' -> 'paths' <> jsonb_build_array(jsonb_build_object('path_id', pl, 'step_number', 2)) then
    bad := bad || format('the holder paths of C2: %s', j -> 'holders' -> 'paths');
  end if;
  -- a random-mode path, inactive: the facts say so, the launch decides
  j := pg_temp.lc(l1, org, c2, pr, null, null, null);
  if j -> 'path' ->> 'sequence_mode' <> 'random' or (j -> 'path' ->> 'is_active')::boolean
     or j -> 'path' -> 'course_step' <> '1'::jsonb then
    bad := bad || format('a random-mode path: %s', j -> 'path');
  end if;
  -- a course that is not a step: course_step null
  j := pg_temp.lc(l1, org, k, pl, null, null, null);
  if j -> 'path' -> 'course_step' <> 'null'::jsonb then
    bad := bad || format('a course that is not a step: %s', j -> 'path');
  end if;

  -- resume on a removed day: the pinned version still holds day 2, the day
  -- row is removed, the open attempt is named and resumable
  j := pg_temp.lc(l1, org, c2, null, el1, dl2, null);
  if j -> 'journey' -> 'day' <> jsonb_build_object('id', dl2, 'number', 2, 'in_version', true, 'removed', true, 'course_id', c2)
     or j -> 'journey' -> 'day_open_attempt' <> jsonb_build_object('attempt_id', a1, 'course_id', c2)
     or j -> 'journey' -> 'resumable_day_ids' <> jsonb_build_array(dl2)
     or j -> 'journey' -> 'unlock_mode' <> '"progress"'::jsonb or j -> 'journey' -> 'count_sundays' <> 'true'::jsonb
     or j -> 'journey' -> 'start_date' <> '"2000-01-03"'::jsonb or j -> 'journey' -> 'days_total' <> '3'::jsonb
     or j -> 'journey' -> 'credited_days' <> '1'::jsonb or j -> 'journey' -> 'required_days' <> '3'::jsonb
     or j -> 'journey' -> 'next_day' <> '2'::jsonb or j -> 'journey' ->> 'next_day_id' <> dl2::text then
    bad := bad || format('resume on a removed day: %s', j -> 'journey');
  end if;
  -- the same day asked for by an old link's number
  if pg_temp.lc(l1, org, c2, null, el1, null, 2) -> 'journey' -> 'day' <> j -> 'journey' -> 'day' then
    bad := bad || 'an old link''s number does not resolve to the same day'::text;
  end if;
  -- the open attempt of another course on the day is still named, with its
  -- course (the resolver compares it with the course launched)
  if pg_temp.lc(l1, org, k, null, el1, dl2, null) -> 'journey' -> 'day_open_attempt'
     <> jsonb_build_object('attempt_id', a1, 'course_id', c2) then
    bad := bad || 'the open attempt of another course on the day is not named'::text;
  end if;
  -- a credited day: the credit, and no open attempt
  j := pg_temp.lc(l1, org, c1, null, el1, dl1, null);
  if j -> 'journey' -> 'day_credit' <> jsonb_build_object('course_id', c1, 'attempt_id', null, 'credit_kind', 'self', 'day_number', 1)
     or j -> 'journey' -> 'day_open_attempt' <> 'null'::jsonb then
    bad := bad || format('a credited day: %s', j -> 'journey');
  end if;
  -- the holder days of C1 for L1: EL1's day 1, credited; of K: EL1's day 3
  if j -> 'holders' -> 'journey_days'
       <> jsonb_build_array(jsonb_build_object('enrollment_id', el1, 'day_id', dl1, 'day_number', 1, 'credited', true))
     or pg_temp.lc(l1, org, k, null, null, null, null) -> 'holders' -> 'journey_days'
        <> jsonb_build_array(jsonb_build_object('enrollment_id', el1, 'day_id', dl3, 'day_number', 3, 'credited', false)) then
    bad := bad || 'the holder days of C1 or K for L1'::text;
  end if;

  -- a course swapped on a credited day: VL2 holds C2 on day 1, the credit
  -- holds C1; L2 is not an active member
  j := pg_temp.lc(l2, org, c2, null, el2, dl1, null);
  if j -> 'journey' -> 'day' <> jsonb_build_object('id', dl1, 'number', 1, 'in_version', true, 'removed', false, 'course_id', c2)
     or j -> 'journey' -> 'day_credit' <> jsonb_build_object('course_id', c1, 'attempt_id', null, 'credit_kind', 'admin', 'day_number', 1)
     or j -> 'member' <> '{"active": false}'::jsonb then
    bad := bad || format('a course swapped on a credited day: %s', j);
  end if;
  -- a completed enrolment: its status; never a holder
  j := pg_temp.lc(l2, org, c2, null, el3, dl1, null);
  if j -> 'journey' -> 'status' <> '"completed"'::jsonb
     or exists (select 1 from jsonb_array_elements(j -> 'holders' -> 'journey_days') h where h ->> 'enrollment_id' = el3::text)
     or j -> 'holders' -> 'journey_days' <> jsonb_build_array(
          jsonb_build_object('enrollment_id', el2, 'day_id', dl1, 'day_number', 1, 'credited', true),
          jsonb_build_object('enrollment_id', el2, 'day_id', dl2, 'day_number', 2, 'credited', false)) then
    bad := bad || format('a completed enrolment: %s', j);
  end if;
  -- a day of another program
  j := pg_temp.lc(l1, org, c1, null, el1, dm1, null);
  if j -> 'journey' -> 'day' <> jsonb_build_object('id', dm1, 'number', null, 'in_version', false, 'removed', false, 'course_id', null)
     or j -> 'journey' -> 'day_credit' <> 'null'::jsonb then
    bad := bad || format('a day of another program: %s', j -> 'journey' -> 'day');
  end if;
  -- an inactive course and an inactive program: the facts say so
  update public.courses set is_active = false where id = c2;
  update public.journey_programs set is_active = false where id = pg_temp.u('000107190401');
  j := pg_temp.lc(l1, org, c2, null, el1, dl2, null);
  if j -> 'course' -> 'is_active' <> 'false'::jsonb or j -> 'journey' -> 'program_is_active' <> 'false'::jsonb then
    bad := bad || format('an inactive course or program: %s', j);
  end if;
  -- ruling A1 (2026-11-14): a journey of an inactive program is never a
  -- holder; the holder day of K for L1 (EL1's day 3, listed above while the
  -- program was active) is gone, and so is every other day of JL
  if pg_temp.lc(l1, org, k, null, null, null, null) -> 'holders' -> 'journey_days' <> '[]'::jsonb
     or pg_temp.lc(l1, org, c1, null, null, null, null) -> 'holders' -> 'journey_days' <> '[]'::jsonb then
    bad := bad || 'a day of a journey whose program is inactive is still a holder (ruling A1)'::text;
  end if;
  -- found false carries no other key, at every level
  j := pg_temp.lc(l1, org, pg_temp.u('000107199999'), pg_temp.u('000107199998'), pg_temp.u('000107199997'), null, null);
  if j -> 'course' <> '{"found": false}'::jsonb or j -> 'path' <> '{"found": false}'::jsonb
     or j -> 'journey' <> '{"found": false}'::jsonb
     or j -> 'holders' <> '{"paths": [], "journey_days": []}'::jsonb then
    bad := bad || format('found false: %s', j);
  end if;
  -- a learner with no row at all in the organisation
  if pg_temp.lc(pg_temp.u('000107199996'), org, c1, null, null, null, null) -> 'member' <> '{"active": false}'::jsonb then
    bad := bad || 'a stranger reads member.active true'::text;
  end if;

  if cardinality(bad) > 0 then
    raise exception 'assert-0107: (43) %', array_to_string(bad, '; ');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (44) build note O1-g, the launch_context legs, on path PO (strict: C1,
--      C2) of their own; the step facts are written by the writer
--      (record_learning_activity), as the routes and the sweep write them
-- ---------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000107190011', 'launch-l11-0107@example.test'),
  ('00000000-0000-0000-0000-000107190012', 'launch-l12-0107@example.test');
insert into public.organization_members (organization_id, user_id, role) values
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000107190011', 'user'),
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000107190012', 'user');
insert into public.learning_paths (id, organization_id, name, slug, is_active, visibility, sequence_mode) values
  ('00000000-0000-0000-0000-000107190103', '00000000-0000-0000-0000-00000000000a', 'PO launch (0107)', 'launch-po-0107', true, 'private', 'strict');
insert into public.learning_path_courses (path_id, course_id, step_number) values
  ('00000000-0000-0000-0000-000107190103', '00000000-0000-0000-0000-0000000000c1', 1),
  ('00000000-0000-0000-0000-000107190103', '00000000-0000-0000-0000-0000000000c2', 2);
insert into public.learning_path_assignments (id, path_id, organization_id, assignee_type, user_id, assigned_by) values
  ('00000000-0000-0000-0000-000107190203', '00000000-0000-0000-0000-000107190103', '00000000-0000-0000-0000-00000000000a',
   'user', '00000000-0000-0000-0000-000107190011', '00000000-0000-0000-0000-0000000000a2'),
  ('00000000-0000-0000-0000-000107190204', '00000000-0000-0000-0000-000107190103', '00000000-0000-0000-0000-00000000000a',
   'user', '00000000-0000-0000-0000-000107190012', '00000000-0000-0000-0000-0000000000a2');

do $$
declare
  bad  text[] := '{}';
  org  constant uuid := '00000000-0000-0000-0000-00000000000a';
  c1   constant uuid := '00000000-0000-0000-0000-0000000000c1';
  c2   constant uuid := '00000000-0000-0000-0000-0000000000c2';
  po   constant uuid := pg_temp.u('000107190103');
  l11  constant uuid := pg_temp.u('000107190011');
  l12  constant uuid := pg_temp.u('000107190012');
  rt   constant uuid := pg_temp.u('000107190902');
  got  text;
begin
  -- L11 completes C1 in PO without passing, while no pass is required; the
  -- writer records the step
  insert into public.course_attempts (id, course_version_id, user_id, organization_id, status, completion_status,
                                      success_status, score, started_at, completed_at, context_kind, learning_path_id,
                                      launch_mode)
  values (pg_temp.u('000107190901'), '00000000-0000-0000-0000-0000000000e1', l11, org, 'failed', 'completed', 'failed',
          0.3, now() - interval '1 hour', now() - interval '50 minutes', 'path', po, 'Normal');
  perform public.record_learning_activity(pg_temp.u('000107190901'));
  if not exists (select 1 from public.learning_path_step_completions f
                  where f.path_id = po and f.user_id = l11 and f.course_id = c1) then
    bad := bad || 'the writer recorded no fact for L11''s step 1'::text;
  end if;

  -- (1) tightened at the step: still done in launch_context, step 2 next
  update public.learning_path_courses set pass_required = true where path_id = po and course_id = c1;
  select string_agg((s ->> 'done'), ',' order by (s ->> 'step_number')::int) into got
    from jsonb_array_elements(pg_temp.lc(l11, org, c2, po, null, null, null) -> 'path' -> 'steps') s;
  if got is distinct from 'true,false'
     or (select string_agg(v.done::text, ',' order by v.step_number) from public.v_path_step_status v
          where v.path_id = po and v.user_id = l11) is distinct from 'true,false' then
    bad := bad || format('O1-g (1), tightened at the step: launch_context reads %s', got);
  end if;
  -- (2) the same tightening made at the course
  update public.learning_path_courses set pass_required = null where path_id = po and course_id = c1;
  update public.courses set pass_required = true where id = c1;
  select string_agg((s ->> 'done'), ',' order by (s ->> 'step_number')::int) into got
    from jsonb_array_elements(pg_temp.lc(l11, org, c2, po, null, null, null) -> 'path' -> 'steps') s;
  if got is distinct from 'true,false' then
    bad := bad || format('O1-g (2), tightened at the course: launch_context reads %s', got);
  end if;
  -- (11) a granted retake on step 1, failed: still done by its fact
  insert into public.course_attempts (id, course_version_id, user_id, organization_id, status, completion_status,
                                      success_status, score, started_at, context_kind, learning_path_id, launch_mode)
  values (rt, '00000000-0000-0000-0000-0000000000e1', l11, org, 'in_progress', 'in_progress', 'unknown', null,
          now() - interval '20 minutes', 'path', po, 'Normal');
  insert into public.attempt_requests (id, organization_id, course_id, user_id, status, decided_at, used_at,
                                       used_attempt_id, context_kind, learning_path_id)
  values (pg_temp.u('000107190903'), org, c1, l11, 'approved', now() - interval '30 minutes', now() - interval '20 minutes',
          rt, 'path', po);
  update public.course_attempts set status = 'failed', completion_status = 'completed', success_status = 'failed',
                                    score = 0.1, completed_at = now() - interval '10 minutes'
   where id = rt;
  select string_agg((s ->> 'done'), ',' order by (s ->> 'step_number')::int) into got
    from jsonb_array_elements(pg_temp.lc(l11, org, c2, po, null, null, null) -> 'path' -> 'steps') s;
  if got is distinct from 'true,false'
     or (select v.latest_result from public.v_path_step_status v where v.path_id = po and v.user_id = l11 and v.course_id = c1)
        is distinct from 'failed' then
    bad := bad || format('O1-g (11), a failed retake on a step done by its fact: launch_context reads %s', got);
  end if;
  -- (6) L11 completes C2 without a pass: every step is done, the writer
  -- records the step and the path completion; C2 is then made
  -- pass-required, and the path stays completed with both steps done
  insert into public.course_attempts (id, course_version_id, user_id, organization_id, status, completion_status,
                                      success_status, score, started_at, completed_at, context_kind, learning_path_id,
                                      launch_mode)
  values (pg_temp.u('000107190904'), '00000000-0000-0000-0000-0000000000e3', l11, org, 'failed', 'completed', 'failed',
          0.2, now() - interval '9 minutes', now() - interval '8 minutes', 'path', po, 'Normal');
  perform public.record_learning_activity(pg_temp.u('000107190904'));
  update public.learning_path_courses set pass_required = true where path_id = po and course_id = c2;
  select string_agg((s ->> 'done'), ',' order by (s ->> 'step_number')::int) into got
    from jsonb_array_elements(pg_temp.lc(l11, org, c2, po, null, null, null) -> 'path' -> 'steps') s;
  if got is distinct from 'true,true'
     or not exists (select 1 from public.learning_path_completions c where c.path_id = po and c.user_id = l11)
     or (select format('%s/%s %s', p.steps_done, p.steps_total, p.completed) from public.v_path_progress p
          where p.path_id = po and p.user_id = l11) is distinct from '2/2 t' then
    bad := bad || format('O1-g (6), a completed path tightened: launch_context reads %s', got);
  end if;
  -- (7) step 1 removed and added again finds its fact
  delete from public.learning_path_courses where path_id = po and course_id = c1;
  select string_agg((s ->> 'done'), ',' order by (s ->> 'step_number')::int) into got
    from jsonb_array_elements(pg_temp.lc(l11, org, c2, po, null, null, null) -> 'path' -> 'steps') s;
  if got is distinct from 'true' then
    bad := bad || format('O1-g (7), the step removed: launch_context reads %s', got);
  end if;
  insert into public.learning_path_courses (path_id, course_id, step_number) values (po, c1, 1);
  select string_agg((s ->> 'done'), ',' order by (s ->> 'step_number')::int) into got
    from jsonb_array_elements(pg_temp.lc(l11, org, c2, po, null, null, null) -> 'path' -> 'steps') s;
  if got is distinct from 'true,true' then
    bad := bad || format('O1-g (7), the step added again: launch_context reads %s', got);
  end if;
  update public.learning_path_courses set pass_required = null where path_id = po and course_id = c2;
  update public.courses set pass_required = false where id = c1;

  -- (3) L12: step 1 made pass-required first, then completed without a
  -- pass: no fact, not done
  update public.learning_path_courses set pass_required = true where path_id = po and course_id = c1;
  insert into public.course_attempts (id, course_version_id, user_id, organization_id, status, completion_status,
                                      success_status, score, started_at, completed_at, context_kind, learning_path_id,
                                      launch_mode)
  values (pg_temp.u('000107190911'), '00000000-0000-0000-0000-0000000000e1', l12, org, 'failed', 'completed', 'failed',
          0.4, now() - interval '1 hour', now() - interval '50 minutes', 'path', po, 'Normal');
  perform public.record_learning_activity(pg_temp.u('000107190911'));
  select string_agg((s ->> 'done'), ',' order by (s ->> 'step_number')::int) into got
    from jsonb_array_elements(pg_temp.lc(l12, org, c2, po, null, null, null) -> 'path' -> 'steps') s;
  if got is distinct from 'false,false'
     or exists (select 1 from public.learning_path_step_completions f where f.path_id = po and f.user_id = l12) then
    bad := bad || format('O1-g (3), tightened before done: launch_context reads %s', got);
  end if;
  -- (4) relaxed: done at once, with no fact
  update public.learning_path_courses set pass_required = false where path_id = po and course_id = c1;
  select string_agg((s ->> 'done'), ',' order by (s ->> 'step_number')::int) into got
    from jsonb_array_elements(pg_temp.lc(l12, org, c2, po, null, null, null) -> 'path' -> 'steps') s;
  if got is distinct from 'true,false' then
    bad := bad || format('O1-g (4), relaxed: launch_context reads %s', got);
  end if;
  -- (8) tightened again with no completion in between: not done
  update public.learning_path_courses set pass_required = true where path_id = po and course_id = c1;
  select string_agg((s ->> 'done'), ',' order by (s ->> 'step_number')::int) into got
    from jsonb_array_elements(pg_temp.lc(l12, org, c2, po, null, null, null) -> 'path' -> 'steps') s;
  if got is distinct from 'false,false' then
    bad := bad || format('O1-g (8), tightened again: launch_context reads %s', got);
  end if;

  if cardinality(bad) > 0 then
    raise exception 'assert-0107: (44) %', array_to_string(bad, '; ');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (45) 6m, the two refresh functions: the six (and two) view entries, then
--      the completion sweep's entry last; the sweep handles a completed row
--      whose writer call never ran, and its entry counts it; a second call
--      finds nothing left
-- ---------------------------------------------------------------------------
do $$
declare
  bad text[] := '{}';
  res jsonb;
  a   constant uuid := '00000000-0000-0000-0000-000107191001';
begin
  insert into public.course_attempts (id, course_version_id, user_id, organization_id, status, completion_status,
                                      success_status, score, started_at, completed_at, context_kind, launch_mode)
  values (a, '00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-000107010005',
          '00000000-0000-0000-0000-00000000000a', 'completed', 'completed', 'unknown', null,
          now() - interval '40 minutes', now() - interval '30 minutes', 'individual', 'Normal');
  res := public.refresh_report_views();
  if jsonb_array_length(res) <> 7 or res -> 6 ->> 'view' <> 'completion_sweep'
     or exists (select 1 from jsonb_array_elements(res) e where e ->> 'error' is not null)
     or (res -> 6 ->> 'rows')::int < 1 or (res -> 6 -> 'sweep' ->> 'handled')::int <> (res -> 6 ->> 'rows')::int
     or array(select e ->> 'view' from jsonb_array_elements(res) e) <> array[
          'mv_course_enrollment_status', 'mv_path_enrollment_status', 'mv_course_performance', 'mv_path_performance',
          'mv_course_interaction_breakdown', 'mv_course_interaction_top_wrong', 'completion_sweep'] then
    bad := bad || format('refresh_report_views() answered %s', res);
  end if;
  if (select c.side_effects_sig is distinct from c.settle_sig from public.course_attempts c where c.id = a) then
    bad := bad || 'the refresh''s sweep did not handle the completed row'::text;
  end if;
  res := public.refresh_gamification_views();
  if jsonb_array_length(res) <> 3
     or array(select e ->> 'view' from jsonb_array_elements(res) e) <> array['mv_leaderboard', 'mv_learner_metrics', 'completion_sweep']
     or exists (select 1 from jsonb_array_elements(res) e where e ->> 'error' is not null)
     or (res -> 2 ->> 'rows')::int <> 0 then
    bad := bad || format('refresh_gamification_views() answered %s', res);
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107: (45) %', array_to_string(bad, '; ');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (46) 6n, gamification_close_month's highest_scorer (step 35): in Org Z, of
--      its own (gamification on, UTC), last month's official results of the
--      Individual and path contexts are averaged per learner; a revision
--      row, an abandoned row, a preview and a journey row of last month, and
--      an official result of this month, never count
--   Z1: Individual C1 0.8 and path PZ C2 0.6, both official, last month; a
--       revision row 1.0 and an abandoned completed row 1.0 on C1, a
--       preview 1.0 on C2, last month                       -> 0.7, rank 1
--   Z2: Individual C1 0.5 last month; Individual C2 0.9 this month
--                                                           -> 0.5, rank 2
--   Z3: a journey row 1.0 last month only                   -> no row
-- ---------------------------------------------------------------------------
insert into public.organizations (id, name, slug) values
  ('00000000-0000-0000-0000-000107192000', 'Org Z (0107)', 'org-z-0107');
insert into public.gamification_settings (organization_id, enabled, timezone, allow_opt_out) values
  ('00000000-0000-0000-0000-000107192000', true, 'UTC', true)
on conflict (organization_id) do update set enabled = true, timezone = 'UTC', allow_opt_out = true;
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000107192001', 'z1-0107@example.test'),
  ('00000000-0000-0000-0000-000107192002', 'z2-0107@example.test'),
  ('00000000-0000-0000-0000-000107192003', 'z3-0107@example.test');
insert into public.profiles (id, email) values
  ('00000000-0000-0000-0000-000107192001', 'z1-0107@example.test'),
  ('00000000-0000-0000-0000-000107192002', 'z2-0107@example.test'),
  ('00000000-0000-0000-0000-000107192003', 'z3-0107@example.test')
on conflict (id) do nothing;
insert into public.organization_members (organization_id, user_id, role) values
  ('00000000-0000-0000-0000-000107192000', '00000000-0000-0000-0000-000107192001', 'user'),
  ('00000000-0000-0000-0000-000107192000', '00000000-0000-0000-0000-000107192002', 'user'),
  ('00000000-0000-0000-0000-000107192000', '00000000-0000-0000-0000-000107192003', 'user');
insert into public.user_gamification (organization_id, user_id) values
  ('00000000-0000-0000-0000-000107192000', '00000000-0000-0000-0000-000107192001'),
  ('00000000-0000-0000-0000-000107192000', '00000000-0000-0000-0000-000107192002'),
  ('00000000-0000-0000-0000-000107192000', '00000000-0000-0000-0000-000107192003');
insert into public.learning_paths (id, organization_id, name, slug) values
  ('00000000-0000-0000-0000-000107192101', '00000000-0000-0000-0000-000107192000', 'PZ (0107)', 'pz-0107');
insert into public.learning_path_courses (path_id, course_id, step_number) values
  ('00000000-0000-0000-0000-000107192101', '00000000-0000-0000-0000-0000000000c2', 1);
insert into public.journey_programs (id, organization_id, name, days_total) values
  ('00000000-0000-0000-0000-000107192201', '00000000-0000-0000-0000-000107192000', 'JZ (0107)', 1);
insert into public.journey_days (id, program_id, organization_id, day_number, course_id) values
  ('00000000-0000-0000-0000-000107192211', '00000000-0000-0000-0000-000107192201', '00000000-0000-0000-0000-000107192000',
   1, '00000000-0000-0000-0000-0000000000c1');
insert into public.journey_versions (id, program_id, organization_id, version_number, name, days_total, count_sundays,
                                     completion_title, days) values
  ('00000000-0000-0000-0000-000107192221', '00000000-0000-0000-0000-000107192201', '00000000-0000-0000-0000-000107192000',
   1, 'JZ (0107)', 1, false, 'Yoddha', '[{"day": 1, "course_id": "00000000-0000-0000-0000-0000000000c1"}]');
update public.journey_programs set current_version_id = '00000000-0000-0000-0000-000107192221'
 where id = '00000000-0000-0000-0000-000107192201';
insert into public.journey_enrollments (id, program_id, version_id, organization_id, user_id, start_date, status) values
  ('00000000-0000-0000-0000-000107192231', '00000000-0000-0000-0000-000107192201', '00000000-0000-0000-0000-000107192221',
   '00000000-0000-0000-0000-000107192000', '00000000-0000-0000-0000-000107192003', '2000-01-03', 'active');

do $$
declare
  bad  text[] := '{}';
  orgz constant uuid := '00000000-0000-0000-0000-000107192000';
  z1   constant uuid := '00000000-0000-0000-0000-000107192001';
  z2   constant uuid := '00000000-0000-0000-0000-000107192002';
  z3   constant uuid := '00000000-0000-0000-0000-000107192003';
  e1   constant uuid := '00000000-0000-0000-0000-0000000000e1';
  e3   constant uuid := '00000000-0000-0000-0000-0000000000e3';
  pz   constant uuid := '00000000-0000-0000-0000-000107192101';
  -- the middle of last month and of this month, in UTC (Org Z's zone)
  lm   constant timestamptz :=
         (date_trunc('month', (now() at time zone 'UTC')::date - interval '1 month') + interval '10 days')::timestamp
         at time zone 'UTC';
  tm   constant timestamptz := date_trunc('month', (now() at time zone 'UTC'))::timestamp at time zone 'UTC'
                               + interval '1 hour';
  got  text;
begin
  insert into public.course_attempts (id, course_version_id, user_id, organization_id, status, completion_status,
                                      success_status, score, started_at, completed_at, context_kind, learning_path_id,
                                      is_revision, is_preview, preview_kind, journey_enrollment_id, journey_day,
                                      journey_day_id, launch_mode)
  values
    -- Z1: official, Individual C1 0.8 and path PZ C2 0.6
    (pg_temp.u('000107192301'), e1, z1, orgz, 'completed', 'completed', 'unknown', 0.8, lm, lm + interval '5 minutes',
     'individual', null, false, false, null, null, null, null, 'Normal'),
    (pg_temp.u('000107192302'), e3, z1, orgz, 'completed', 'completed', 'unknown', 0.6, lm, lm + interval '6 minutes',
     'path', pz, false, false, null, null, null, null, 'Normal'),
    -- Z1: a revision row, an abandoned completed row, a preview: never
    (pg_temp.u('000107192303'), e1, z1, orgz, 'completed', 'completed', 'unknown', 1.0, lm + interval '1 day',
     lm + interval '1 day', 'individual', null, true, false, null, null, null, null, 'Review'),
    (pg_temp.u('000107192304'), e1, z1, orgz, 'abandoned', 'completed', 'unknown', 1.0, lm + interval '2 days',
     lm + interval '2 days', 'individual', null, false, false, null, null, null, null, 'Normal'),
    (pg_temp.u('000107192305'), e3, z1, orgz, 'completed', 'completed', 'unknown', 1.0, lm + interval '3 days',
     lm + interval '3 days', 'preview', null, false, true, 'course', null, null, null, 'Normal'),
    -- Z2: Individual C1 0.5 last month; Individual C2 0.9 this month
    (pg_temp.u('000107192306'), e1, z2, orgz, 'completed', 'completed', 'unknown', 0.5, lm, lm + interval '5 minutes',
     'individual', null, false, false, null, null, null, null, 'Normal'),
    (pg_temp.u('000107192307'), e3, z2, orgz, 'completed', 'completed', 'unknown', 0.9, tm, tm + interval '5 minutes',
     'individual', null, false, false, null, null, null, null, 'Normal'),
    -- Z3: a journey row only
    (pg_temp.u('000107192308'), e1, z3, orgz, 'completed', 'completed', 'unknown', 1.0, lm, lm + interval '5 minutes',
     'journey', null, false, false, null, pg_temp.u('000107192231'), 1, pg_temp.u('000107192211'), 'Normal');

  perform public.gamification_close_month();
  select string_agg(format('%s %s %s', r.rank, right(r.user_id::text, 1), round(r.metric_value, 4)), '; ' order by r.rank)
    into got
    from public.gamification_recognitions r
   where r.organization_id = orgz and r.category = 'highest_scorer'
     and r.period = to_char((now() at time zone 'UTC')::date - interval '1 month', 'YYYY-MM');
  if got is distinct from '1 1 0.7000; 2 2 0.5000' then
    bad := bad || format('highest_scorer of Org Z reads %s (expected 1 Z1 0.7000; 2 Z2 0.5000)', coalesce(got, 'nothing'));
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107: (46) %', array_to_string(bad, '; ');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (47) 6o, journey_auto_enroll: a new member of Org Z, whom JZ's audience
--      (none: everyone) reaches, is enrolled with source audience
-- ---------------------------------------------------------------------------
update public.journey_programs set auto_enroll_new_users = true
 where id = '00000000-0000-0000-0000-000107192201';
insert into auth.users (id, email) values ('00000000-0000-0000-0000-000107192004', 'z4-0107@example.test');
insert into public.organization_members (organization_id, user_id, role) values
  ('00000000-0000-0000-0000-000107192000', '00000000-0000-0000-0000-000107192004', 'user');

do $$
declare
  got text;
begin
  select string_agg(format('%s %s %s', e.source, right(e.version_id::text, 4), e.status), '; ') into got
    from public.journey_enrollments e
   where e.user_id = '00000000-0000-0000-0000-000107192004';
  if got is distinct from 'audience 2221 active' then
    raise exception 'assert-0107: (47) the audience enrolment reads %', coalesce(got, 'nothing');
  end if;
end
$$;

rollback;
