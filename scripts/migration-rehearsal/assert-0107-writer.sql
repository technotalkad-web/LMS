-- scripts/migration-rehearsal/assert-0107-writer.sql
-- Scenarios "0105-0106-then-0107" and "0106-then-0105-then-0107" (after the
-- first paste and again after the second), "0107-refused-q8" and
-- "0107-refused-q2" (after the two pastes that follow the repair): what
-- section 6 of 0107_learning_contexts.sql must have done for the functions
-- of 6g to 6l: the journey completion core and its two wrappers (step 13),
-- journey_record_completion (step 13, R13, R14), the XP core and its
-- wrapper (steps 17 and 33 to 36), record_learning_activity (step 12; build
-- notes N13, N18, O1-c, O1-e), sweep_completion_side_effects (step 16) and
-- purge_preview_data (steps 79 and 81). It runs after
-- assert-0107-plpgsql.sql. The checks continue the numbering of the 0107
-- files:
--   (33) the objects: arguments, result, language, security, search_path,
--        argument defaults, comments and the execute matrix; the forms of
--        each name; no function but purge_preview_data deletes from
--        course_attempts or preview_runs (step 81, R6-a), read from pg_proc;
--        the writer and the sweep take no row lock of their own and
--        journey_record_completion locks the enrolment first, read on their
--        stored bodies
--   (34) the completion core and its two wrappers: one completion, one
--        badge per enrolment, one claim with its origin
--   (35) journey_record_completion: journey rows only, the credit by day
--        identity (a moved day, a removed day as history), the lenient pass
--        rule of R14, late, a completed enrolment, a reset enrolment, and
--        step 63's open attempt that completes after a re-pin completed its
--        enrolment, and a completion when the credit was already there
--   (36) the XP core and its wrapper: the wrapper's two skips and no
--        membership exemption; points under D8(c) through the writer (paid
--        once per course, an event row per context, the context on every
--        row); the activity part and the reward part apart
--   (37) record_learning_activity on Individual rows: the skips, the
--        activity branch on an incomplete row, the completion branch and
--        its stamp, again when completed becomes passed, nothing on a
--        stamped row, not_official, a history row, gamification off, a
--        pass-required course
--   (38) record_learning_activity on path and journey rows: the step facts
--        and the path completion (build note O1-g (1), (3) to (5), (9) and
--        (10), the writer halves), the journey credit and completion with
--        their claim, and D14 (a live granted retake, then a failed one,
--        after a pass and a path completion)
--   (39) sweep_completion_side_effects: no row from before the paste, the
--        two-minute floor, the completion branch only, a path row's step
--        fact, one raising row
--   (40) purge_preview_data: the scopes and their refusals, the dry run,
--        the hash, the isolation check on each of its seven tables, the
--        audit row, rows flagged by role never selected, every row that is
--        not new-kind preview data unchanged (each base table's rows and
--        checksum), the product deletes, the user's and the organisation's
--        cascades, the API roles
-- The fixture rows have ids whose last group starts 00010718. The whole file
-- is one transaction that ends in ROLLBACK; every check runs in its own
-- savepoint, rolled back to it, so no check sees another's writes. Every
-- check raises 'assert-0107: (n) …' on failure; the runner then reports the
-- file as failed and stops the scenario. PGlite runs as postgres (the
-- owner); role cases switch with set local role.
begin;

create function pg_temp.u8(p text) returns uuid language sql immutable as $$
  select ('00000000-0000-0000-0000-' || p)::uuid
$$;

-- One statement, undone: its SQLSTATE (ok when none), under the given claims
create function pg_temp.state8(p_stmt text, p_claims text default null) returns text
language plpgsql as $$
declare
  st text;
begin
  begin
    perform set_config('request.jwt.claims', coalesce(p_claims, ''), true);
    execute p_stmt;
    raise exception using errcode = 'R0107', message = 'assert-0107: undo';
  exception when others then
    st := sqlstate;
  end;
  perform set_config('request.jwt.claims', '', true);
  return case when st = 'R0107' then 'ok' else st end;
end
$$;

-- An attempt of the fixture world in Org A: p_res passed, failed, completed
-- (no verdict), in_progress, abandoned (completed, then closed) or
-- revision; the context from p_kind and the tags
create function pg_temp.att8(p_id uuid, p_version uuid, p_user uuid, p_res text, p_kind text, p_path uuid,
                             p_enr uuid, p_day int, p_day_id uuid, p_jver uuid, p_minutes int,
                             p_score numeric default 0.5) returns uuid
language plpgsql as $$
declare
  v_st   timestamptz := now() - make_interval(mins => p_minutes);
  v_done boolean := p_res in ('passed', 'failed', 'completed', 'abandoned');
begin
  insert into public.course_attempts (id, course_version_id, user_id, organization_id, status, completion_status,
                                      success_status, score, started_at, completed_at, context_kind, is_preview,
                                      is_revision, learning_path_id, journey_enrollment_id, journey_day,
                                      journey_day_id, journey_version_id, launch_mode)
  values (p_id, p_version, p_user, '00000000-0000-0000-0000-00000000000a',
          case when p_res = 'revision' then 'in_progress' else p_res end,
          case when v_done then 'completed' else 'in_progress' end,
          case p_res when 'passed' then 'passed' when 'failed' then 'failed' else 'unknown' end,
          case when v_done then p_score end, v_st, case when v_done then v_st + interval '1 minute' end,
          p_kind, false, p_res = 'revision', p_path, p_enr, p_day, p_day_id, p_jver, 'Normal');
  return p_id;
end
$$;

-- A preview attempt of a new kind (or legacy_role) in Org A
create function pg_temp.prev8(p_id uuid, p_version uuid, p_user uuid, p_kind text, p_run uuid, p_day_id uuid,
                              p_days_ago int, p_org uuid default '00000000-0000-0000-0000-00000000000a') returns uuid
language sql as $$
  insert into public.course_attempts (id, course_version_id, user_id, organization_id, status, completion_status,
                                      success_status, score, started_at, completed_at, context_kind, is_preview,
                                      preview_kind, preview_run_id, journey_day_id, launch_mode)
  values (p_id, p_version, p_user, p_org, 'completed', 'completed', 'passed', 0.8,
          now() - make_interval(days => p_days_ago), now() - make_interval(days => p_days_ago),
          'preview', true, p_kind, p_run, p_day_id, 'Normal')
  returning id
$$;

-- The xp_events rows of one learner and course, as one line: rule/xp/kind
-- of each paid row, then each event row's key suffix, ordered
create function pg_temp.xp8(p_user uuid, p_course uuid) returns text language sql stable as $$
  select coalesce(string_agg(x.v, ' ' order by x.v), '')
    from (select case when e.event_only
                      then 'ev:' || e.rule || '@' || coalesce(e.context_kind, 'null')
                      else 'paid:' || e.rule || '=' || e.xp || '@' || coalesce(e.context_kind, 'null') end as v
            from public.xp_events e
           where e.user_id = p_user and e.course_id = p_course) x
$$;

-- ---------------------------------------------------------------------------
-- (33) the objects
-- ---------------------------------------------------------------------------
do $$
declare
  bad text[] := '{}';
  r   record;
  g   record;
  src text;
begin
  for r in
    select * from (values
      ('public.journey_complete_enrollments_core(uuid[],text)', 'p_ids uuid[], p_origin text', 'SETOF uuid', 0),
      ('public.journey_complete_enrollment(uuid)', 'p_enrollment_id uuid', 'boolean', 0),
      ('public.journey_complete_enrollments(uuid)', 'p_program_id uuid', 'SETOF uuid', 0),
      ('public.journey_record_completion(uuid)', 'p_attempt_id uuid', 'jsonb', 0),
      ('public.gamification_record_activity_core(uuid,boolean,boolean)',
       'p_attempt_id uuid, p_activity boolean, p_rewards boolean', 'jsonb', 0),
      ('public.gamification_record_activity_core(uuid)', 'p_attempt_id uuid', 'jsonb', 0),
      ('public.gamification_record_activity(uuid)', 'p_attempt_id uuid', 'jsonb', 0),
      ('public.record_learning_activity(uuid,boolean)', 'p_attempt_id uuid, p_activity boolean', 'jsonb', 0),
      ('public.record_learning_activity(uuid)', 'p_attempt_id uuid', 'jsonb', 0),
      ('public.sweep_completion_side_effects(integer)', 'p_limit integer', 'jsonb', 0),
      ('public.purge_preview_data(uuid,jsonb,text,uuid,boolean,text)',
       'p_org uuid, p_scope jsonb, p_reason text, p_actor uuid, p_dry_run boolean, p_expect_hash text', 'jsonb', 1)
    ) as t(fn, args, result, ndefaults)
  loop
    select p.oid, pg_get_function_identity_arguments(p.oid) as args, pg_get_function_result(p.oid) as result,
           l.lanname::text as lang, p.prosecdef, p.proconfig, p.pronargdefaults,
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
    if g.lang <> 'plpgsql' or not g.prosecdef or g.pronargdefaults <> r.ndefaults
       or g.proconfig is distinct from array['search_path=pg_catalog, public'] then
      bad := bad || format('%s: language %s, security definer %s, %s default(s), proconfig %s',
                           r.fn, g.lang, g.prosecdef, g.pronargdefaults, coalesce(g.proconfig::text, 'null'));
    end if;
    if g.comment is null then
      bad := bad || format('%s has no comment', r.fn);
    end if;
    if has_function_privilege('public', r.fn, 'execute')
       or has_function_privilege('anon', r.fn, 'execute')
       or has_function_privilege('authenticated', r.fn, 'execute')
       or not has_function_privilege('service_role', r.fn, 'execute') then
      bad := bad || format('%s: execute public %s, anon %s, authenticated %s, service_role %s (expected service_role only)',
                           r.fn, has_function_privilege('public', r.fn, 'execute'),
                           has_function_privilege('anon', r.fn, 'execute'),
                           has_function_privilege('authenticated', r.fn, 'execute'),
                           has_function_privilege('service_role', r.fn, 'execute'));
    end if;
  end loop;
  -- exactly these forms
  for r in
    select * from (values ('journey_complete_enrollments_core', 1), ('journey_complete_enrollment', 1),
                          ('journey_complete_enrollments', 1), ('journey_record_completion', 1),
                          ('gamification_record_activity_core', 2), ('gamification_record_activity', 1),
                          ('record_learning_activity', 2), ('sweep_completion_side_effects', 1),
                          ('purge_preview_data', 1)) as t(name, n)
  loop
    if (select count(*) from pg_proc where proname = r.name and pronamespace = 'public'::regnamespace) <> r.n then
      bad := bad || format('public.%s has %s form(s) (expected %s)', r.name,
                           (select count(*) from pg_proc where proname = r.name and pronamespace = 'public'::regnamespace), r.n);
    end if;
  end loop;
  -- R6-a: no function of the schema but purge_preview_data deletes from
  -- course_attempts or preview_runs
  for g in
    select p.oid::regprocedure::text as fn
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.prosrc ~* 'delete\s+from\s+(public\.)?(course_attempts|preview_runs)\M'
  loop
    if g.fn <> 'purge_preview_data(uuid,jsonb,text,uuid,boolean,text)' then
      bad := bad || format('%s deletes from course_attempts or preview_runs', g.fn);
    end if;
  end loop;
  if (select count(*) from pg_proc p where p.oid = to_regprocedure('public.purge_preview_data(uuid,jsonb,text,uuid,boolean,text)')
        and p.prosrc ~* 'delete\s+from\s+public\.course_attempts\M'
        and p.prosrc ~* 'delete\s+from\s+public\.preview_runs\M') <> 1 then
    bad := bad || 'purge_preview_data does not delete from course_attempts and preview_runs'::text;
  end if;
  -- the refresh functions name no purge (step 81)
  for g in select p.oid::regprocedure::text as fn, p.prosrc from pg_proc p
            where p.oid in (to_regprocedure('public.refresh_report_views()'), to_regprocedure('public.refresh_gamification_views()'))
  loop
    if g.prosrc ~* 'purge_preview_data' then
      bad := bad || format('%s names purge_preview_data', g.fn);
    end if;
  end loop;
  -- lock order: the writer and the sweep lock no row of their own; the
  -- journey credit locks the enrolment in its first statement
  for g in select p.oid::regprocedure::text as fn, p.prosrc from pg_proc p
            where p.oid in (to_regprocedure('public.record_learning_activity(uuid,boolean)'),
                            to_regprocedure('public.sweep_completion_side_effects(integer)'))
  loop
    if g.prosrc ~* 'for\s+update' then
      bad := bad || format('%s takes a row lock of its own', g.fn);
    end if;
  end loop;
  select p.prosrc into src from pg_proc p where p.oid = to_regprocedure('public.journey_record_completion(uuid)');
  if strpos(src, 'for update of e') = 0
     or strpos(src, 'for update of e') > strpos(src, 'into v_att')
     or (select count(*) from regexp_matches(src, 'for\s+update', 'gi')) <> 1 then
    bad := bad || 'journey_record_completion does not lock the enrolment first'::text;
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107: (33) %', array_to_string(bad, '; ');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- The fixture world (ids 00010718…), inside Org A: learners U1 to U9;
-- courses WA and WB (no pass required) and WC (pass required), each with one
-- version; path PW (WA step 1, WB step 2) with U2 and U3 enrolled, path PQ
-- (WA step 1); program JW with days W1 to W3 (WA, WB, WC), its versions VW1
-- (current: days 1 to 3, calendar, Sundays counted) and VW0 (day 3 with
-- pass_required false), and enrolment EW of U5 on VW1, started 10 days ago.
-- ---------------------------------------------------------------------------
do $$
declare
  org constant uuid := '00000000-0000-0000-0000-00000000000a';
  i   int;
  c   text[] := array['000107181001', '000107181002', '000107181003'];
begin
  for i in 1..9 loop
    insert into auth.users (id, email)
    values (pg_temp.u8('00010718000' || i), format('learner-%s-0107w@example.test', i));
    insert into public.organization_members (organization_id, user_id, role)
    values (org, pg_temp.u8('00010718000' || i), 'user');
  end loop;

  insert into public.courses (id, organization_id, title, slug, pass_required) values
    (pg_temp.u8(c[1]), org, 'WA (0107 writer)', 'wa-0107w', false),
    (pg_temp.u8(c[2]), org, 'WB (0107 writer)', 'wb-0107w', false),
    (pg_temp.u8(c[3]), org, 'WC (0107 writer)', 'wc-0107w', true);
  for i in 1..3 loop
    insert into public.course_packages (id, course_id, language, is_active)
    values (pg_temp.u8('00010718110' || i), pg_temp.u8(c[i]), null, true);
    insert into public.course_versions (id, course_id, package_id, version_number, manifest_type, launch_url,
                                        storage_prefix, manifest_data)
    values (pg_temp.u8('00010718120' || i), pg_temp.u8(c[i]), pg_temp.u8('00010718110' || i), 1, 'scorm12',
            'index.html', format('courses/w%s-0107w/v1/', i), '{"title":"0107 writer"}');
  end loop;

  insert into public.learning_paths (id, organization_id, name, slug, is_active, visibility) values
    (pg_temp.u8('000107182001'), org, 'PW (0107 writer)', 'pw-0107w', true, 'private'),
    (pg_temp.u8('000107182002'), org, 'PQ (0107 writer)', 'pq-0107w', true, 'private');
  insert into public.learning_path_courses (path_id, course_id, step_number, pass_required) values
    (pg_temp.u8('000107182001'), pg_temp.u8(c[1]), 1, null),
    (pg_temp.u8('000107182001'), pg_temp.u8(c[2]), 2, null),
    (pg_temp.u8('000107182002'), pg_temp.u8(c[1]), 1, null);
  insert into public.learning_path_assignments (id, path_id, organization_id, assignee_type, user_id) values
    (pg_temp.u8('000107182101'), pg_temp.u8('000107182001'), org, 'user', pg_temp.u8('000107180002')),
    (pg_temp.u8('000107182102'), pg_temp.u8('000107182001'), org, 'user', pg_temp.u8('000107180003'));

  insert into public.journey_programs (id, organization_id, name, days_total)
  values (pg_temp.u8('000107183001'), org, 'JW (0107 writer)', 3);
  for i in 1..3 loop
    insert into public.journey_days (id, program_id, organization_id, day_number, course_id)
    values (pg_temp.u8('00010718310' || i), pg_temp.u8('000107183001'), org, i, pg_temp.u8(c[i]));
  end loop;
  insert into public.journey_versions (id, program_id, organization_id, version_number, name, days_total,
                                       count_sundays, completion_title, days, day_ids, day_ids_source, unlock_mode) values
    (pg_temp.u8('000107183300'), pg_temp.u8('000107183001'), org, 1, 'JW (0107 writer)', 3, true, 'Done',
     jsonb_build_array(
       jsonb_build_object('day', 1, 'course_id', pg_temp.u8(c[1])::text),
       jsonb_build_object('day', 2, 'course_id', pg_temp.u8(c[2])::text),
       jsonb_build_object('day', 3, 'course_id', pg_temp.u8(c[3])::text, 'pass_required', false)),
     jsonb_build_object('1', pg_temp.u8('000107183101')::text, '2', pg_temp.u8('000107183102')::text,
                        '3', pg_temp.u8('000107183103')::text), 'editor', 'calendar'),
    (pg_temp.u8('000107183301'), pg_temp.u8('000107183001'), org, 2, 'JW (0107 writer)', 3, true, 'Done',
     jsonb_build_array(
       jsonb_build_object('day', 1, 'course_id', pg_temp.u8(c[1])::text),
       jsonb_build_object('day', 2, 'course_id', pg_temp.u8(c[2])::text),
       jsonb_build_object('day', 3, 'course_id', pg_temp.u8(c[3])::text)),
     jsonb_build_object('1', pg_temp.u8('000107183101')::text, '2', pg_temp.u8('000107183102')::text,
                        '3', pg_temp.u8('000107183103')::text), 'editor', 'calendar');
  update public.journey_programs set current_version_id = pg_temp.u8('000107183301')
   where id = pg_temp.u8('000107183001');
  insert into public.journey_enrollments (id, program_id, version_id, organization_id, user_id, start_date, status)
  values (pg_temp.u8('000107183401'), pg_temp.u8('000107183001'), pg_temp.u8('000107183301'), org,
          pg_temp.u8('000107180005'), current_date - 10, 'active');
end
$$;

-- ---------------------------------------------------------------------------
-- (34) the completion core and its two wrappers
-- ---------------------------------------------------------------------------
savepoint s34;
do $$
declare
  bad  text[] := '{}';
  org  constant uuid := '00000000-0000-0000-0000-00000000000a';
  jw   constant uuid := '00000000-0000-0000-0000-000107183001';
  ew   constant uuid := '00000000-0000-0000-0000-000107183401';
  e2   constant uuid := '00000000-0000-0000-0000-000107183402';
  e3   constant uuid := '00000000-0000-0000-0000-000107183403';
  got  text;
  i    int;
begin
  if pg_temp.state8('select * from public.journey_complete_enrollments_core(''{}''::uuid[], ''admin'')') <> '22023'
     or pg_temp.state8('select * from public.journey_complete_enrollments_core(''{}''::uuid[], null)') <> '22023' then
    bad := bad || 'an origin other than learner or publish is not refused with 22023'::text;
  end if;

  -- EW: every required day credited, no attempt (an enrolment completed by
  -- its credits alone)
  for i in 1..3 loop
    insert into public.journey_day_progress (enrollment_id, organization_id, user_id, day_number, day_id, course_id,
                                             credit_kind)
    values (ew, org, '00000000-0000-0000-0000-000107180005', i, pg_temp.u8('00010718310' || i),
            pg_temp.u8('00010718100' || i), 'admin');
  end loop;
  if not public.journey_complete_enrollment(ew) then
    bad := bad || 'journey_complete_enrollment answers false on the first call'::text;
  end if;
  if public.journey_complete_enrollment(ew) then
    bad := bad || 'journey_complete_enrollment answers true on a second call'::text;
  end if;
  select format('%s/%s', e.status, e.completed_at is not null) into got from public.journey_enrollments e where e.id = ew;
  if got <> 'completed/t' then
    bad := bad || format('EW reads %s (expected completed with completed_at)', got);
  end if;
  select string_agg(format('%s|%s|%s', b.badge_slug, b.period, b.metadata ->> 'program_name'), ',') into got
    from public.user_badges b where b.user_id = '00000000-0000-0000-0000-000107180005';
  if got is distinct from 'yoddha|enr:' || ew::text || '|JW (0107 writer)' then
    bad := bad || format('the badges of U5: %s (expected one yoddha with period enr:EW and the program name)', got);
  end if;
  select string_agg(format('%s|%s|%s|%s|%s', n.product_kind, n.instance_id = ew, n.event_type, n.origin,
                           coalesce(n.attempt_id::text, 'null')), ',') into got
    from public.completion_notices n where n.user_id = '00000000-0000-0000-0000-000107180005';
  if got is distinct from 'journey|t|journey_completion|learner|null' then
    bad := bad || format('the claims of U5: %s (expected one journey claim, origin learner)', got);
  end if;

  -- the set-based wrapper: E2 (U6) every day credited, E3 (U7) one day; a
  -- completed and a reset enrolment are never selected
  insert into public.journey_enrollments (id, program_id, version_id, organization_id, user_id, start_date, status) values
    (e2, jw, '00000000-0000-0000-0000-000107183301', org, '00000000-0000-0000-0000-000107180006', current_date, 'active'),
    (e3, jw, '00000000-0000-0000-0000-000107183301', org, '00000000-0000-0000-0000-000107180007', current_date, 'active'),
    ('00000000-0000-0000-0000-000107183404', jw, '00000000-0000-0000-0000-000107183301', org,
     '00000000-0000-0000-0000-000107180008', current_date, 'reset');
  for i in 1..3 loop
    insert into public.journey_day_progress (enrollment_id, organization_id, user_id, day_number, day_id, course_id,
                                             credit_kind)
    values (e2, org, '00000000-0000-0000-0000-000107180006', i, pg_temp.u8('00010718310' || i),
            pg_temp.u8('00010718100' || i), 'admin'),
           ('00000000-0000-0000-0000-000107183404', org, '00000000-0000-0000-0000-000107180008', i,
            pg_temp.u8('00010718310' || i), pg_temp.u8('00010718100' || i), 'admin');
  end loop;
  insert into public.journey_day_progress (enrollment_id, organization_id, user_id, day_number, day_id, course_id, credit_kind)
  values (e3, org, '00000000-0000-0000-0000-000107180007', 1, pg_temp.u8('000107183101'), pg_temp.u8('000107181001'), 'admin');
  select coalesce(string_agg(right(x::text, 4), ',' order by x), '') into got from public.journey_complete_enrollments(jw) as c(x);
  if got <> '3402' then
    bad := bad || format('journey_complete_enrollments completed %s (expected E2 only)', got);
  end if;
  select coalesce(string_agg(right(x::text, 4), ',' order by x), '') into got from public.journey_complete_enrollments(jw) as c(x);
  if got <> '' then
    bad := bad || format('a second journey_complete_enrollments completed %s (expected none)', got);
  end if;
  select string_agg(format('%s:%s', right(n.instance_id::text, 4), n.origin), ',' order by n.instance_id) into got
    from public.completion_notices n where n.product_kind = 'journey' and n.instance_id in (e2, e3, '00000000-0000-0000-0000-000107183404');
  if got is distinct from '3402:publish' then
    bad := bad || format('the publish claims: %s (expected one for E2, origin publish)', got);
  end if;
  if (select count(*) from public.user_badges b where b.period = 'enr:' || e2::text) <> 1
     or exists (select 1 from public.user_badges b where b.period in ('enr:' || e3::text, 'enr:00000000-0000-0000-0000-000107183404')) then
    bad := bad || 'the publish badges are not one for E2 and none for E3 and the reset enrolment'::text;
  end if;
  if (select status from public.journey_enrollments where id = '00000000-0000-0000-0000-000107183404') <> 'reset' then
    bad := bad || 'a reset enrolment was completed'::text;
  end if;

  -- zero required days: never complete
  update public.journey_versions set days = '[{"day": 1, "course_id": ""}]'::jsonb
   where id = '00000000-0000-0000-0000-000107183300';
  update public.journey_enrollments set version_id = '00000000-0000-0000-0000-000107183300' where id = e3;
  if public.journey_complete_enrollment(e3) then
    bad := bad || 'an enrolment pinned to a version with no required day was completed'::text;
  end if;

  if cardinality(bad) > 0 then
    raise exception 'assert-0107: (34) %', array_to_string(bad, '; ');
  end if;
end
$$;
rollback to savepoint s34;

-- ---------------------------------------------------------------------------
-- (35) journey_record_completion
-- ---------------------------------------------------------------------------
savepoint s35;
do $$
declare
  bad  text[] := '{}';
  org  constant uuid := '00000000-0000-0000-0000-00000000000a';
  jw   constant uuid := '00000000-0000-0000-0000-000107183001';
  ew   constant uuid := '00000000-0000-0000-0000-000107183401';
  u5   constant uuid := '00000000-0000-0000-0000-000107180005';
  vw1  constant uuid := '00000000-0000-0000-0000-000107183301';
  got  text;
  a    jsonb;
begin
  -- not a journey row, a revision row, an incomplete row
  perform pg_temp.att8(pg_temp.u8('000107184001'), pg_temp.u8('000107181201'), u5, 'completed', 'individual',
                       null, null, null, null, null, 60);
  perform pg_temp.att8(pg_temp.u8('000107184002'), pg_temp.u8('000107181201'), u5, 'revision', 'journey',
                       null, ew, 1, pg_temp.u8('000107183101'), vw1, 50);
  perform pg_temp.att8(pg_temp.u8('000107184003'), pg_temp.u8('000107181203'), u5, 'in_progress', 'journey',
                       null, ew, 3, pg_temp.u8('000107183103'), vw1, 50);
  select string_agg(public.journey_record_completion(x) ->> 'skipped', ',' order by x) into got
    from unnest(array[pg_temp.u8('000107184001'), pg_temp.u8('000107184002'), pg_temp.u8('000107184003'),
                      pg_temp.u8('000107184999')]) as x;
  if got is distinct from 'not_journey,revision,not_complete,no_attempt' then
    bad := bad || format('the skips: %s (expected not_journey, revision, not_complete, no_attempt)', got);
  end if;

  -- day 1 completed: credited, late (day 1 was 10 days ago), by its id; a
  -- second call writes nothing
  perform pg_temp.att8(pg_temp.u8('000107184011'), pg_temp.u8('000107181201'), u5, 'completed', 'journey',
                       null, ew, 1, pg_temp.u8('000107183101'), vw1, 40);
  a := public.journey_record_completion(pg_temp.u8('000107184011'));
  if a ->> 'credited' <> 'true' or a ->> 'late' <> 'true' or a ->> 'day_removed' <> 'false'
     or a ->> 'day' <> '1' or a ->> 'yoddha_unlocked' <> 'false' then
    bad := bad || format('day 1: %s', a);
  end if;
  a := public.journey_record_completion(pg_temp.u8('000107184011'));
  if a ->> 'credited' <> 'false' then
    bad := bad || format('day 1 again: %s (expected credited false)', a);
  end if;
  select string_agg(format('%s/%s/%s/%s/%s', p.day_number, right(p.day_id::text, 4), p.credit_kind, p.late,
                           right(p.attempt_id::text, 4)), ',') into got
    from public.journey_day_progress p where p.enrollment_id = ew;
  if got is distinct from '1/3101/attempt/t/4011' then
    bad := bad || format('the credits after day 1: %s', got);
  end if;

  -- day 3 (WC, pass required by the course) failed: refused under the
  -- pinned version's rule; launched under VW0, whose day 3 requires no pass,
  -- it is credited (R14)
  perform pg_temp.att8(pg_temp.u8('000107184013'), pg_temp.u8('000107181203'), u5, 'failed', 'journey',
                       null, ew, 3, pg_temp.u8('000107183103'), vw1, 35);
  a := public.journey_record_completion(pg_temp.u8('000107184013'));
  if a ->> 'skipped' is distinct from 'pass_required' then
    bad := bad || format('day 3 failed under the pinned rule: %s (expected skipped pass_required)', a);
  end if;
  update public.course_attempts set status = 'abandoned' where id = pg_temp.u8('000107184003');
  perform pg_temp.att8(pg_temp.u8('000107184023'), pg_temp.u8('000107181203'), u5, 'failed', 'journey',
                       null, ew, 3, pg_temp.u8('000107183103'), '00000000-0000-0000-0000-000107183300', 30);
  a := public.journey_record_completion(pg_temp.u8('000107184023'));
  if a ->> 'credited' is distinct from 'true' then
    bad := bad || format('day 3 failed, launched under a version that requires no pass: %s (expected credited)', a);
  end if;

  -- day 2 moved: a version where W2 is day 3 and W3 day 2; the attempt
  -- launched as day 2 credits its own day under its new number
  insert into public.journey_versions (id, program_id, organization_id, version_number, name, days_total,
                                       count_sundays, completion_title, days, day_ids, day_ids_source, unlock_mode)
  values (pg_temp.u8('000107183302'), jw, org, 3, 'JW (0107 writer)', 3, true, 'Done',
          jsonb_build_array(
            jsonb_build_object('day', 1, 'course_id', '00000000-0000-0000-0000-000107181001'),
            jsonb_build_object('day', 2, 'course_id', '00000000-0000-0000-0000-000107181003'),
            jsonb_build_object('day', 3, 'course_id', '00000000-0000-0000-0000-000107181002')),
          jsonb_build_object('1', '00000000-0000-0000-0000-000107183101', '2', '00000000-0000-0000-0000-000107183103',
                             '3', '00000000-0000-0000-0000-000107183102'), 'editor', 'progress');
  perform pg_temp.att8(pg_temp.u8('000107184012'), pg_temp.u8('000107181202'), u5, 'completed', 'journey',
                       null, ew, 2, pg_temp.u8('000107183102'), vw1, 20);
  update public.journey_enrollments set version_id = pg_temp.u8('000107183302') where id = ew;
  a := public.journey_record_completion(pg_temp.u8('000107184012'));
  -- every required day of the moved version is now credited: the enrolment
  -- completes, by the core, with its badge and its claim
  if a ->> 'credited' <> 'true' or a ->> 'day' <> '3' or a ->> 'day_removed' <> 'false' or a ->> 'late' <> 'false'
     or a ->> 'yoddha_unlocked' <> 'true' then
    bad := bad || format('day 2 moved to number 3 in a progress journey: %s (expected credited as day 3, not late, completed)', a);
  end if;
  if (select status from public.journey_enrollments where id = ew) <> 'completed'
     or (select count(*) from public.completion_notices n where n.instance_id = ew and n.origin = 'learner') <> 1
     or (select count(*) from public.user_badges b where b.period = 'enr:' || ew::text) <> 1 then
    bad := bad || 'the completion by the last credit did not complete EW with one claim and one badge'::text;
  end if;

  -- a completed enrolment: a further credit is history (a day the version
  -- no longer requires), with no second badge or claim
  insert into public.journey_days (id, program_id, organization_id, day_number, course_id, removed_at)
  values (pg_temp.u8('000107183104'), jw, org, null, '00000000-0000-0000-0000-000107181002', now());
  perform pg_temp.att8(pg_temp.u8('000107184014'), pg_temp.u8('000107181202'), u5, 'completed', 'journey',
                       null, ew, 4, pg_temp.u8('000107183104'), pg_temp.u8('000107183302'), 10);
  a := public.journey_record_completion(pg_temp.u8('000107184014'));
  if a ->> 'credited' <> 'true' or a ->> 'history' <> 'true' or a ->> 'day_removed' <> 'true'
     or a ->> 'yoddha_unlocked' <> 'false' then
    bad := bad || format('a credit on a completed enrolment: %s (expected a history credit, day removed)', a);
  end if;
  if (select count(*) from public.completion_notices n where n.instance_id = ew) <> 1
     or (select count(*) from public.user_badges b where b.period = 'enr:' || ew::text) <> 1 then
    bad := bad || 'a history credit wrote a second claim or badge'::text;
  end if;

  if cardinality(bad) > 0 then
    raise exception 'assert-0107: (35) %', array_to_string(bad, '; ');
  end if;
end
$$;
rollback to savepoint s35;

-- (35b) a removed day on an active enrolment, a reset enrolment, another
-- learner's attempt
savepoint s35b;
do $$
declare
  bad  text[] := '{}';
  org  constant uuid := '00000000-0000-0000-0000-00000000000a';
  ew   constant uuid := '00000000-0000-0000-0000-000107183401';
  u5   constant uuid := '00000000-0000-0000-0000-000107180005';
  vw1  constant uuid := '00000000-0000-0000-0000-000107183301';
  a    jsonb;
  got  text;
begin
  -- day 2 cleared to a rest day in the pinned version: the credit is history
  update public.journey_versions
     set days = jsonb_set(days, '{1,course_id}', '""'::jsonb)
   where id = vw1;
  perform pg_temp.att8(pg_temp.u8('000107184031'), pg_temp.u8('000107181202'), u5, 'completed', 'journey',
                       null, ew, 2, pg_temp.u8('000107183102'), vw1, 20);
  a := public.journey_record_completion(pg_temp.u8('000107184031'));
  if a ->> 'credited' <> 'true' or a ->> 'day_removed' <> 'true' or a ->> 'history' <> 'false' then
    bad := bad || format('a rest day: %s (expected a credit, day removed)', a);
  end if;
  select format('req=%s done=%s', s.required_days, s.credited_days) into got
    from public.journey_credit_state(array[ew]) s;
  if got <> 'req=2 done=0' then
    bad := bad || format('the credit of a rest day counts: %s (expected req=2 done=0)', got);
  end if;

  -- another learner's attempt on EW, and EW reset
  perform pg_temp.att8(pg_temp.u8('000107184032'), pg_temp.u8('000107181201'), pg_temp.u8('000107180006'),
                       'completed', 'journey', null, ew, 1, pg_temp.u8('000107183101'), vw1, 15);
  a := public.journey_record_completion(pg_temp.u8('000107184032'));
  if a ->> 'skipped' is distinct from 'enrollment_inactive' then
    bad := bad || format('another learner''s attempt: %s (expected skipped enrollment_inactive)', a);
  end if;
  update public.journey_enrollments set status = 'reset' where id = ew;
  perform pg_temp.att8(pg_temp.u8('000107184033'), pg_temp.u8('000107181201'), u5, 'completed', 'journey',
                       null, ew, 1, pg_temp.u8('000107183101'), vw1, 10);
  a := public.journey_record_completion(pg_temp.u8('000107184033'));
  if a ->> 'skipped' is distinct from 'enrollment_inactive' then
    bad := bad || format('a reset enrolment: %s (expected skipped enrollment_inactive)', a);
  end if;
  if (select count(*) from public.journey_day_progress p where p.enrollment_id = ew) <> 1 then
    bad := bad || 'a refused credit wrote a row'::text;
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107: (35) %', array_to_string(bad, '; ');
  end if;
end
$$;
rollback to savepoint s35b;

-- (35c) step 63: the new version is shorter, every remaining required day
-- is credited and the learner holds an open attempt on the removed day:
-- the re-pin completes the enrolment (origin publish), the open attempt
-- then completes, and journey_record_completion writes a history credit on
-- the completed enrolment with no second badge or claim
savepoint s35c;
do $$
declare
  bad  text[] := '{}';
  org  constant uuid := '00000000-0000-0000-0000-00000000000a';
  jw   constant uuid := '00000000-0000-0000-0000-000107183001';
  ew   constant uuid := '00000000-0000-0000-0000-000107183401';
  u5   constant uuid := '00000000-0000-0000-0000-000107180005';
  vw1  constant uuid := '00000000-0000-0000-0000-000107183301';
  a    jsonb;
  got  text;
begin
  perform pg_temp.att8(pg_temp.u8('000107184041'), pg_temp.u8('000107181201'), u5, 'completed', 'journey',
                       null, ew, 1, pg_temp.u8('000107183101'), vw1, 60);
  perform pg_temp.att8(pg_temp.u8('000107184042'), pg_temp.u8('000107181202'), u5, 'completed', 'journey',
                       null, ew, 2, pg_temp.u8('000107183102'), vw1, 50);
  perform pg_temp.att8(pg_temp.u8('000107184043'), pg_temp.u8('000107181203'), u5, 'in_progress', 'journey',
                       null, ew, 3, pg_temp.u8('000107183103'), vw1, 40);
  perform public.journey_record_completion(pg_temp.u8('000107184041'));
  perform public.journey_record_completion(pg_temp.u8('000107184042'));
  insert into public.journey_versions (id, program_id, organization_id, version_number, name, days_total,
                                       count_sundays, completion_title, days, day_ids, day_ids_source, unlock_mode)
  values (pg_temp.u8('000107183303'), jw, org, 4, 'JW (0107 writer)', 2, true, 'Done',
          jsonb_build_array(jsonb_build_object('day', 1, 'course_id', '00000000-0000-0000-0000-000107181001'),
                            jsonb_build_object('day', 2, 'course_id', '00000000-0000-0000-0000-000107181002')),
          jsonb_build_object('1', '00000000-0000-0000-0000-000107183101', '2', '00000000-0000-0000-0000-000107183102'),
          'editor', 'calendar');
  update public.journey_programs set current_version_id = pg_temp.u8('000107183303') where id = jw;
  a := public.journey_repin_enrollments(jw, pg_temp.u8('000107183303'), null, false);
  if a ->> 'completed_now' <> '1' or a ->> 'started_days_kept' <> '1' then
    bad := bad || format('the re-pin: %s (expected one completion and one started day kept)', a);
  end if;
  select format('%s|%s', e.status, (select string_agg(n.origin, ',') from public.completion_notices n where n.instance_id = ew))
    into got from public.journey_enrollments e where e.id = ew;
  if got is distinct from 'completed|publish' then
    bad := bad || format('EW after the re-pin: %s (expected completed with one publish claim)', got);
  end if;
  update public.course_attempts set status = 'completed', completion_status = 'completed', success_status = 'passed',
                                    completed_at = now()
   where id = pg_temp.u8('000107184043');
  a := public.journey_record_completion(pg_temp.u8('000107184043'));
  if a ->> 'credited' <> 'true' or a ->> 'history' <> 'true' or a ->> 'day_removed' <> 'true'
     or a ->> 'yoddha_unlocked' <> 'false' then
    bad := bad || format('the open attempt completed after the re-pin: %s (expected a history credit)', a);
  end if;
  if (select count(*) from public.completion_notices n where n.instance_id = ew) <> 1
     or (select count(*) from public.user_badges b where b.period = 'enr:' || ew::text) <> 1
     or (select count(*) from public.journey_day_progress p where p.enrollment_id = ew) <> 3 then
    bad := bad || 'the history credit wrote a second claim or badge, or no credit'::text;
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107: (35) %', array_to_string(bad, '; ');
  end if;
end
$$;
rollback to savepoint s35c;

-- (35d) completion after a credit that was already there: every required
-- day of EW holds a credit (the day 3 credit written earlier, its
-- completion not run) and EW is still active; the attempt's own call finds
-- its credit in place and still completes EW through the core
savepoint s35d;
do $$
declare
  org  constant uuid := '00000000-0000-0000-0000-00000000000a';
  ew   constant uuid := '00000000-0000-0000-0000-000107183401';
  u5   constant uuid := '00000000-0000-0000-0000-000107180005';
  vw1  constant uuid := '00000000-0000-0000-0000-000107183301';
  a    jsonb;
  i    int;
begin
  perform pg_temp.att8(pg_temp.u8('000107184053'), pg_temp.u8('000107181203'), u5, 'passed', 'journey',
                       null, ew, 3, pg_temp.u8('000107183103'), vw1, 30);
  for i in 1..3 loop
    insert into public.journey_day_progress (enrollment_id, organization_id, user_id, day_number, day_id, course_id,
                                             attempt_id, credit_kind)
    values (ew, org, u5, i, pg_temp.u8('00010718310' || i), pg_temp.u8('00010718100' || i),
            case when i = 3 then pg_temp.u8('000107184053') end, case when i = 3 then 'attempt' else 'admin' end);
  end loop;
  a := public.journey_record_completion(pg_temp.u8('000107184053'));
  if a ->> 'credited' <> 'false' or a ->> 'yoddha_unlocked' <> 'true'
     or (select status from public.journey_enrollments where id = ew) <> 'completed' then
    raise exception 'assert-0107: (35) a credit already in place: % (expected no new credit and the completion)', a;
  end if;
end
$$;
rollback to savepoint s35d;

-- ---------------------------------------------------------------------------
-- (36) the XP core and its wrapper
-- ---------------------------------------------------------------------------
savepoint s36;
do $$
declare
  bad  text[] := '{}';
  ew   constant uuid := '00000000-0000-0000-0000-000107183401';
  u4   constant uuid := '00000000-0000-0000-0000-000107180004';
  u5   constant uuid := '00000000-0000-0000-0000-000107180005';
  u6   constant uuid := '00000000-0000-0000-0000-000107180006';
  wa   constant uuid := '00000000-0000-0000-0000-000107181001';
  a    jsonb;
  got  text;
  ug   record;
begin
  delete from public.gamification_settings where organization_id = '00000000-0000-0000-0000-00000000000a';

  -- the wrapper: nothing for a journey row or a preview
  perform pg_temp.att8(pg_temp.u8('000107185001'), pg_temp.u8('000107181201'), u5, 'completed', 'journey',
                       null, ew, 1, pg_temp.u8('000107183101'), null, 30);
  perform pg_temp.prev8(pg_temp.u8('000107185002'), pg_temp.u8('000107181201'), u5, 'course', null, null, 0);
  select string_agg(public.gamification_record_activity(x) ->> 'skipped', ',' order by x) into got
    from unnest(array[pg_temp.u8('000107185001'), pg_temp.u8('000107185002')]) as x;
  if got is distinct from 'journey_course,preview' or exists (select 1 from public.xp_events e where e.user_id = u5) then
    bad := bad || format('the wrapper on a journey row and a preview: %s (expected journey_course, preview, no row)', got);
  end if;
  -- no membership exemption: U5 is on JW, whose version holds WA; an
  -- Individual completion of WA through the wrapper earns
  perform pg_temp.att8(pg_temp.u8('000107185003'), pg_temp.u8('000107181201'), u5, 'completed', 'individual',
                       null, null, null, null, null, 20, 0.5);
  a := public.gamification_record_activity(pg_temp.u8('000107185003'));
  got := pg_temp.xp8(u5, wa);
  if got <> 'ev:course_completed@individual paid:course_completed=100@individual' then
    bad := bad || format('a journey member''s Individual completion: %s', got);
  end if;
  -- a later passed row of the same context is not official: through the
  -- wrapper it earns no reward (no pass marker, no event row)
  perform pg_temp.att8(pg_temp.u8('000107185004'), pg_temp.u8('000107181201'), u5, 'passed', 'individual',
                       null, null, null, null, null, 10, 1.0);
  a := public.gamification_record_activity(pg_temp.u8('000107185004'));
  got := pg_temp.xp8(u5, wa);
  if got <> 'ev:course_completed@individual paid:course_completed=100@individual' then
    bad := bad || format('the wrapper on a row that is not official: %s (expected no reward)', got);
  end if;

  -- D8(c), through the writer: U4 completes WA at 0.95 individually, then
  -- at 1.0 in PW, then at 1.0 in PQ
  perform pg_temp.att8(pg_temp.u8('000107185011'), pg_temp.u8('000107181201'), u4, 'passed', 'individual',
                       null, null, null, null, null, 30, 0.95);
  perform pg_temp.att8(pg_temp.u8('000107185012'), pg_temp.u8('000107181201'), u4, 'passed', 'path',
                       pg_temp.u8('000107182001'), null, null, null, null, 20, 1.0);
  perform pg_temp.att8(pg_temp.u8('000107185013'), pg_temp.u8('000107181201'), u4, 'passed', 'path',
                       pg_temp.u8('000107182002'), null, null, null, null, 10, 1.0);
  perform public.record_learning_activity(pg_temp.u8('000107185011'));
  perform public.record_learning_activity(pg_temp.u8('000107185012'));
  perform public.record_learning_activity(pg_temp.u8('000107185013'));
  got := pg_temp.xp8(u4, wa);
  if got <> 'ev:course_completed@individual ev:course_completed@path ev:course_completed@path '
            || 'ev:course_passed@individual ev:course_passed@path ev:course_passed@path '
            || 'ev:high_score@individual ev:perfect_score@path ev:perfect_score@path '
            || 'paid:course_completed=100@individual paid:course_passed=0@individual '
            || 'paid:high_score=25@individual paid:perfect_score=50@path' then
    bad := bad || format('D8(c): %s', got);
  end if;
  select string_agg(format('%s=%s', e.dedupe_key, right(e.attempt_id::text, 4)), ',' order by e.dedupe_key) into got
    from public.xp_events e where e.user_id = u4 and e.rule = 'perfect_score' and not e.event_only;
  if got is distinct from format('perfect:%s:%s=5012', u4, wa) then
    bad := bad || format('the paid perfect row: %s (expected from the PW row)', got);
  end if;
  if exists (select 1 from public.xp_events e where e.user_id = u4
              and (e.context_kind is null or e.context_key is null
                   or (e.event_only and (e.xp <> 0 or e.dedupe_key not like '%:' || e.context_key)))) then
    bad := bad || 'a row without its context, or an event row with points or another key'::text;
  end if;
  if exists (select 1 from public.xp_events e where e.attempt_id = pg_temp.u8('000107185013') and not e.event_only) then
    bad := bad || 'the PQ row paid something'::text;
  end if;
  select * into ug from public.user_gamification where user_id = u4;
  if ug.total_xp <> 185 or ug.courses_completed <> 1 or ug.perfect_scores <> 1 or ug.assessments_passed <> 1 then
    bad := bad || format('U4''s rollup: xp %s, completed %s, perfect %s, passed %s (expected 185, 1, 1, 1)',
                         ug.total_xp, ug.courses_completed, ug.perfect_scores, ug.assessments_passed);
  end if;

  -- the two parts apart, on U6's completed official row: the activity part
  -- writes the daily row only; the reward part writes no daily row and
  -- leaves the day of last activity as it is
  perform pg_temp.att8(pg_temp.u8('000107185021'), pg_temp.u8('000107181201'), u6, 'completed', 'individual',
                       null, null, null, null, null, 30);
  perform public.gamification_record_activity_core(pg_temp.u8('000107185021'), false, true);
  select string_agg(e.rule, ',' order by e.rule) into got from public.xp_events e where e.user_id = u6;
  if got is distinct from 'course_completed,course_completed'
     or (select last_active_day from public.user_gamification where user_id = u6) is not null then
    bad := bad || format('the reward part: %s, last active %s (expected the completion rows only, no day)',
                         got, (select last_active_day from public.user_gamification where user_id = u6));
  end if;
  perform public.gamification_record_activity_core(pg_temp.u8('000107185021'), true, false);
  select string_agg(e.rule, ',' order by e.rule) into got from public.xp_events e where e.user_id = u6;
  if got is distinct from 'course_completed,course_completed,daily_activity'
     or (select last_active_day from public.user_gamification where user_id = u6) is null then
    bad := bad || format('the activity part: %s (expected one daily row more, and the day)', got);
  end if;

  if cardinality(bad) > 0 then
    raise exception 'assert-0107: (36) %', array_to_string(bad, '; ');
  end if;
end
$$;
rollback to savepoint s36;

-- ---------------------------------------------------------------------------
-- (37) record_learning_activity on Individual rows
-- ---------------------------------------------------------------------------
savepoint s37;
do $$
declare
  bad  text[] := '{}';
  org  constant uuid := '00000000-0000-0000-0000-00000000000a';
  u1   constant uuid := '00000000-0000-0000-0000-000107180001';
  u3   constant uuid := '00000000-0000-0000-0000-000107180003';
  u7   constant uuid := '00000000-0000-0000-0000-000107180007';
  u8   constant uuid := '00000000-0000-0000-0000-000107180008';
  wa   constant uuid := '00000000-0000-0000-0000-000107181001';
  wb   constant uuid := '00000000-0000-0000-0000-000107181002';
  a    jsonb;
  got  text;
  n    bigint;
  at0  timestamptz;
  r    record;
begin
  delete from public.gamification_settings where organization_id = org;

  -- the skips: nothing written
  perform pg_temp.prev8(pg_temp.u8('000107186001'), pg_temp.u8('000107181202'), u1, 'course', null, null, 0);
  perform pg_temp.att8(pg_temp.u8('000107186002'), pg_temp.u8('000107181203'), u1, 'revision', 'individual',
                       null, null, null, null, null, 50);
  perform pg_temp.att8(pg_temp.u8('000107186003'), pg_temp.u8('000107181202'), u1, 'abandoned', 'individual',
                       null, null, null, null, null, 55);
  select string_agg(public.record_learning_activity(x) ->> 'skipped', ',' order by x) into got
    from unnest(array[pg_temp.u8('000107186001'), pg_temp.u8('000107186002'), pg_temp.u8('000107186003'),
                      pg_temp.u8('000107186999')]) as x;
  if got is distinct from 'preview,revision,abandoned,no_attempt'
     or exists (select 1 from public.xp_events e where e.user_id = u1)
     or exists (select 1 from public.course_attempts c where c.id in (pg_temp.u8('000107186001'), pg_temp.u8('000107186003'))
                   and c.side_effects_sig is not null) then
    bad := bad || format('the skips: %s (expected preview, revision, abandoned, no_attempt and nothing written)', got);
  end if;

  -- an incomplete row with no official attempt: the activity branch only
  perform pg_temp.att8(pg_temp.u8('000107186011'), pg_temp.u8('000107181202'), u1, 'in_progress', 'individual',
                       null, null, null, null, null, 40);
  a := public.record_learning_activity(pg_temp.u8('000107186011'));
  if a ->> 'activity' <> 'true' or a ->> 'official' <> 'false' or a -> 'attempt_number' <> 'null'::jsonb
     or a -> 'notices' <> '[]'::jsonb or a ->> 'done' <> 'false' or a -> 'passed_ever' <> 'null'::jsonb
     or (a #>> '{context,kind}') <> 'individual' then
    bad := bad || format('an incomplete row: %s', a);
  end if;
  if pg_temp.xp8(u1, wb) <> '' or (select count(*) from public.xp_events e where e.user_id = u1 and e.rule = 'daily_activity') <> 1
     or (select side_effects_sig from public.course_attempts where id = pg_temp.u8('000107186011')) is not null then
    bad := bad || 'an incomplete row did not write exactly its daily row, or was stamped'::text;
  end if;

  -- it completes: the completion branch, the claim, the stamp
  update public.course_attempts
     set status = 'completed', completion_status = 'completed', completed_at = now() - interval '30 minutes', score = 0.6
   where id = pg_temp.u8('000107186011');
  a := public.record_learning_activity(pg_temp.u8('000107186011'));
  if a ->> 'official' <> 'true' or a ->> 'attempt_number' <> '1' or a ->> 'done' <> 'true'
     or jsonb_array_length(a -> 'notices') <> 1
     or (a #>> '{notices,0,product_kind}') <> 'individual' or (a #>> '{notices,0,event_type}') <> 'asset_completion'
     or (a #>> '{notices,0,instance_id}') <> wb::text then
    bad := bad || format('the completion: %s', a);
  end if;
  select (c.side_effects_sig = c.settle_sig) as stamped, c.side_effects_at, c.webhook_skip_reason into r
    from public.course_attempts c where c.id = pg_temp.u8('000107186011');
  if not coalesce(r.stamped, false) or r.side_effects_at is null or r.webhook_skip_reason is not null then
    bad := bad || 'the completed row is not stamped, or carries a skip reason'::text;
  end if;
  at0 := r.side_effects_at;
  if pg_temp.xp8(u1, wb) <> 'ev:course_completed@individual paid:course_completed=100@individual' then
    bad := bad || format('the completion''s points: %s', pg_temp.xp8(u1, wb));
  end if;

  -- a second call on the stamped row: nothing more
  select count(*) into n from public.xp_events e where e.user_id = u1;
  a := public.record_learning_activity(pg_temp.u8('000107186011'));
  if a -> 'notices' <> '[]'::jsonb or (select count(*) from public.xp_events e where e.user_id = u1) <> n
     or (select side_effects_at from public.course_attempts where id = pg_temp.u8('000107186011')) <> at0
     or (select count(*) from public.completion_notices where user_id = u1) <> 1 then
    bad := bad || format('a stamped row was touched: %s', a);
  end if;

  -- completed becomes passed: the branch runs again (the pass marker)
  update public.course_attempts set success_status = 'passed' where id = pg_temp.u8('000107186011');
  a := public.record_learning_activity(pg_temp.u8('000107186011'));
  if pg_temp.xp8(u1, wb) <> 'ev:course_completed@individual ev:course_passed@individual '
                            || 'paid:course_completed=100@individual paid:course_passed=0@individual'
     or a -> 'notices' <> '[]'::jsonb
     or (select side_effects_sig <> settle_sig from public.course_attempts where id = pg_temp.u8('000107186011')) then
    bad := bad || format('completed then passed: %s, %s', pg_temp.xp8(u1, wb), a);
  end if;

  -- a later completed row of the context that is not official: no points,
  -- no claim, not_official, stamped; its number is 2
  perform pg_temp.att8(pg_temp.u8('000107186012'), pg_temp.u8('000107181202'), u1, 'passed', 'individual',
                       null, null, null, null, null, 10, 1.0);
  select count(*) into n from public.xp_events e where e.user_id = u1;
  a := public.record_learning_activity(pg_temp.u8('000107186012'));
  if a ->> 'official' <> 'false' or a ->> 'activity' <> 'false' or a ->> 'attempt_number' <> '2'
     or a -> 'notices' <> '[]'::jsonb or (select count(*) from public.xp_events e where e.user_id = u1) <> n
     or (select webhook_skip_reason from public.course_attempts where id = pg_temp.u8('000107186012')) is distinct from 'not_official'
     or (select side_effects_sig <> settle_sig from public.course_attempts where id = pg_temp.u8('000107186012')) then
    bad := bad || format('a row that is not official: %s', a);
  end if;

  -- a history row (stamped as by the backfill, official, never paid): the
  -- daily row only, no completion key, no claim
  perform pg_temp.att8(pg_temp.u8('000107186021'), pg_temp.u8('000107181201'), u3, 'completed', 'individual',
                       null, null, null, null, null, 60);
  update public.course_attempts set side_effects_sig = settle_sig, side_effects_at = completed_at
   where id = pg_temp.u8('000107186021');
  a := public.record_learning_activity(pg_temp.u8('000107186021'));
  select string_agg(e.rule, ',' order by e.rule) into got from public.xp_events e where e.user_id = u3;
  if got is distinct from 'daily_activity' or a -> 'notices' <> '[]'::jsonb or a ->> 'official' <> 'true' then
    bad := bad || format('a history row: rows %s, answer %s (expected the daily row only)', got, a);
  end if;

  -- gamification off: no points, the claim and the stamp still happen
  insert into public.gamification_settings (organization_id, enabled) values (org, false)
  on conflict (organization_id) do update set enabled = false;
  perform pg_temp.att8(pg_temp.u8('000107186031'), pg_temp.u8('000107181201'), u7, 'completed', 'individual',
                       null, null, null, null, null, 60);
  a := public.record_learning_activity(pg_temp.u8('000107186031'));
  if (a #>> '{xp,skipped}') is distinct from 'disabled' or jsonb_array_length(a -> 'notices') <> 1
     or exists (select 1 from public.xp_events e where e.user_id = u7)
     or (select side_effects_sig <> settle_sig from public.course_attempts where id = pg_temp.u8('000107186031')) then
    bad := bad || format('gamification off: %s', a);
  end if;
  update public.gamification_settings set enabled = true where organization_id = org;

  -- a pass-required course failed: official, not done, no claim
  perform pg_temp.att8(pg_temp.u8('000107186041'), pg_temp.u8('000107181203'), u8, 'failed', 'individual',
                       null, null, null, null, null, 60);
  a := public.record_learning_activity(pg_temp.u8('000107186041'));
  if a ->> 'official' <> 'true' or a ->> 'done' <> 'false' or a -> 'notices' <> '[]'::jsonb then
    bad := bad || format('a failed pass-required course: %s', a);
  end if;

  if cardinality(bad) > 0 then
    raise exception 'assert-0107: (37) %', array_to_string(bad, '; ');
  end if;
end
$$;
rollback to savepoint s37;

-- ---------------------------------------------------------------------------
-- (38) record_learning_activity on path and journey rows
-- ---------------------------------------------------------------------------
savepoint s38;
do $$
declare
  bad  text[] := '{}';
  org  constant uuid := '00000000-0000-0000-0000-00000000000a';
  pw   constant uuid := '00000000-0000-0000-0000-000107182001';
  u2   constant uuid := '00000000-0000-0000-0000-000107180002';
  u3   constant uuid := '00000000-0000-0000-0000-000107180003';
  u5   constant uuid := '00000000-0000-0000-0000-000107180005';
  wa   constant uuid := '00000000-0000-0000-0000-000107181001';
  wb   constant uuid := '00000000-0000-0000-0000-000107181002';
  ew   constant uuid := '00000000-0000-0000-0000-000107183401';
  vw1  constant uuid := '00000000-0000-0000-0000-000107183301';
  a    jsonb;
  got  text;
  d0   timestamptz;
begin
  -- O1-g (1): U2 completes WA in PW without a pass while no pass is
  -- required: the fact is written, the step is done
  perform pg_temp.att8(pg_temp.u8('000107187001'), pg_temp.u8('000107181201'), u2, 'failed', 'path',
                       pw, null, null, null, null, 50);
  a := public.record_learning_activity(pg_temp.u8('000107187001'));
  if a ->> 'official' <> 'true' or a ->> 'done' <> 'true' or a ->> 'passed_ever' <> 'true'
     or a ->> 'passed_by_rule' <> 'true' or a -> 'done_recorded_at' = 'null'::jsonb or a ->> 'path_completed' <> 'false'
     or a -> 'notices' <> '[]'::jsonb or (a #>> '{context,learning_path_id}') <> pw::text then
    bad := bad || format('O1-g (1), the writer on step 1: %s', a);
  end if;
  select string_agg(format('%s/%s/%s', right(f.course_id::text, 4), f.rule_pass_required, right(f.attempt_id::text, 4)), ',')
    into got from public.learning_path_step_completions f where f.path_id = pw and f.user_id = u2;
  if got is distinct from '1001/f/7001' then
    bad := bad || format('the facts of U2: %s (expected WA under no pass rule, attempt 7001)', got);
  end if;
  select f.done_at into d0 from public.learning_path_step_completions f where f.path_id = pw and f.user_id = u2;
  -- the rule tightened after: still done, with the standing result
  update public.learning_path_courses set pass_required = true where path_id = pw and course_id = wa;
  select format('%s/%s/%s/%s/%s', st.passed_by_rule, st.done_recorded_at is not null, st.done, st.failed, st.latest_result)
    into got from public.v_path_step_status st where st.path_id = pw and st.user_id = u2 and st.course_id = wa;
  if got is distinct from 'f/t/t/f/failed' then
    bad := bad || format('O1-g (1), tightened after: %s', got);
  end if;
  a := public.record_learning_activity(pg_temp.u8('000107187001'));
  if a ->> 'done' <> 'true' or a ->> 'passed_by_rule' <> 'false' or a ->> 'passed_ever' <> 'true'
     or a -> 'done_recorded_at' = 'null'::jsonb then
    bad := bad || format('O1-g (1), the writer''s answer after the tightening: %s (expected done by the fact)', a);
  end if;
  -- step 2: the path completes, with its steps and its claim
  perform pg_temp.att8(pg_temp.u8('000107187002'), pg_temp.u8('000107181202'), u2, 'completed', 'path',
                       pw, null, null, null, null, 40, 0.8);
  a := public.record_learning_activity(pg_temp.u8('000107187002'));
  if a ->> 'path_completed' <> 'true' or jsonb_array_length(a -> 'notices') <> 1
     or (a #>> '{notices,0,product_kind}') <> 'path' or (a #>> '{notices,0,event_type}') <> 'path_completion' then
    bad := bad || format('step 2 completes the path: %s', a);
  end if;
  select format('%s|%s', lc.path_score = 0.65, (select string_agg(format('%s:%s:%s', s.e ->> 'step_number',
                                                                         right(s.e ->> 'attempt_id', 4), s.e ->> 'score'),
                                                                  ',' order by s.n)
                                                   from jsonb_array_elements(lc.steps) with ordinality s(e, n)))
    into got from public.learning_path_completions lc where lc.path_id = pw and lc.user_id = u2;
  if got is distinct from 't|1:7001:0.5,2:7002:0.8' then
    bad := bad || format('the path completion row: %s (expected score 0.65 and both steps with their attempts)', got);
  end if;
  -- O1-g (5): step 1 passes later (the branch runs again): one fact, the
  -- same done_at, no second completion or claim
  update public.course_attempts set success_status = 'passed' where id = pg_temp.u8('000107187001');
  a := public.record_learning_activity(pg_temp.u8('000107187001'));
  if a ->> 'path_completed' <> 'false' or a -> 'notices' <> '[]'::jsonb
     or (select count(*) from public.learning_path_step_completions f where f.path_id = pw and f.user_id = u2) <> 2
     or (select done_at from public.learning_path_step_completions f where f.path_id = pw and f.user_id = u2 and f.course_id = wa) <> d0
     or (select count(*) from public.completion_notices n where n.user_id = u2) <> 1 then
    bad := bad || format('O1-g (5), a second branch: %s', a);
  end if;
  if pg_temp.state8('update public.learning_path_step_completions set done_at = now() where user_id = '''
                    || u2 || '''', '{"role": "service_role"}') <> 'P0001'
     or pg_temp.state8('delete from public.learning_path_step_completions where user_id = ''' || u2 || '''',
                       '{"role": "service_role"}') <> 'P0001' then
    bad := bad || 'a direct update or delete of a step fact is not refused'::text;
  end if;

  -- O1-g (3) and (4): U3, the rule tightened before: no fact, not done;
  -- relaxed: done at once with no fact; the next official completion in
  -- the path writes the fact for it
  perform pg_temp.att8(pg_temp.u8('000107187011'), pg_temp.u8('000107181201'), u3, 'failed', 'path',
                       pw, null, null, null, null, 50);
  a := public.record_learning_activity(pg_temp.u8('000107187011'));
  if a ->> 'done' <> 'false' or a ->> 'passed_ever' <> 'false'
     or exists (select 1 from public.learning_path_step_completions f where f.user_id = u3) then
    bad := bad || format('O1-g (3), tightened before: %s', a);
  end if;
  update public.learning_path_courses set pass_required = false where path_id = pw and course_id = wa;
  if not (select st.done from public.v_path_step_status st where st.path_id = pw and st.user_id = u3 and st.course_id = wa) then
    bad := bad || 'O1-g (4), relaxed: the step is not done'::text;
  end if;
  perform pg_temp.att8(pg_temp.u8('000107187012'), pg_temp.u8('000107181202'), u3, 'completed', 'path',
                       pw, null, null, null, null, 40);
  a := public.record_learning_activity(pg_temp.u8('000107187012'));
  select string_agg(right(f.course_id::text, 4), ',' order by f.course_id) into got
    from public.learning_path_step_completions f where f.user_id = u3;
  if got is distinct from '1001,1002' or a ->> 'path_completed' <> 'true' then
    bad := bad || format('O1-g (4), the next completion: facts %s, %s', got, a);
  end if;
  -- the user's delete passes over the facts (N19)
  if pg_temp.state8('delete from auth.users where id = ''' || u3 || '''') <> 'ok' then
    bad := bad || 'a learner''s delete over step facts and a path completion is refused'::text;
  end if;

  -- the journey: U5's last day through the writer credits it and completes
  -- EW, with the journey claim among the notices
  insert into public.journey_day_progress (enrollment_id, organization_id, user_id, day_number, day_id, course_id, credit_kind)
  values (ew, org, u5, 1, pg_temp.u8('000107183101'), wa, 'admin'),
         (ew, org, u5, 2, pg_temp.u8('000107183102'), wb, 'admin');
  perform pg_temp.att8(pg_temp.u8('000107187021'), pg_temp.u8('000107181203'), u5, 'passed', 'journey',
                       null, ew, 3, pg_temp.u8('000107183103'), vw1, 30, 1.0);
  a := public.record_learning_activity(pg_temp.u8('000107187021'));
  if a ->> 'official' <> 'true' or a ->> 'journey_credited' <> 'true' or a ->> 'journey_completed' <> 'true'
     or a ->> 'done' <> 'true' or a -> 'xp' <> 'null'::jsonb or a ->> 'activity' <> 'false'
     or jsonb_array_length(a -> 'notices') <> 1 or (a #>> '{notices,0,product_kind}') <> 'journey'
     or (a #>> '{notices,0,instance_id}') <> ew::text or (a #>> '{context,journey_day_id}') <> pg_temp.u8('000107183103')::text then
    bad := bad || format('the journey''s last day: %s', a);
  end if;
  if exists (select 1 from public.xp_events e where e.user_id = u5) then
    bad := bad || 'a journey row earned points'::text;
  end if;
  a := public.record_learning_activity(pg_temp.u8('000107187021'));
  if a ->> 'journey_completed' <> 'false' or a -> 'notices' <> '[]'::jsonb then
    bad := bad || format('the journey''s last day again: %s', a);
  end if;

  if cardinality(bad) > 0 then
    raise exception 'assert-0107: (38) %', array_to_string(bad, '; ');
  end if;
end
$$;
rollback to savepoint s38;

-- (38b) O1-g (9) and (10): the course cascade over a fact, and a lone path
-- delete refused by a fact
savepoint s38b;
do $$
declare
  bad  text[] := '{}';
  org  constant uuid := '00000000-0000-0000-0000-00000000000a';
  u9   constant uuid := '00000000-0000-0000-0000-000107180009';
  st   text;
begin
  -- no points rows: rows inserted in this transaction would make the
  -- course's cascade re-check their attempt key (a key is re-checked on any
  -- update of a row its own transaction inserted), which no real cascade
  -- meets
  insert into public.gamification_settings (organization_id, enabled) values (org, false)
  on conflict (organization_id) do update set enabled = false;
  insert into public.courses (id, organization_id, title, slug)
  values (pg_temp.u8('000107181004'), org, 'WD (0107 writer)', 'wd-0107w');
  insert into public.course_packages (id, course_id, language, is_active)
  values (pg_temp.u8('000107181104'), pg_temp.u8('000107181004'), null, true);
  insert into public.course_versions (id, course_id, package_id, version_number, manifest_type, launch_url,
                                      storage_prefix, manifest_data)
  values (pg_temp.u8('000107181204'), pg_temp.u8('000107181004'), pg_temp.u8('000107181104'), 1, 'scorm12',
          'index.html', 'courses/wd-0107w/v1/', '{"title":"0107 writer"}');
  insert into public.learning_paths (id, organization_id, name, slug, is_active, visibility) values
    (pg_temp.u8('000107182003'), org, 'PZ (0107 writer)', 'pz-0107w', true, 'private'),
    (pg_temp.u8('000107182004'), org, 'PX (0107 writer)', 'px-0107w', true, 'private');
  insert into public.learning_path_courses (path_id, course_id, step_number) values
    (pg_temp.u8('000107182003'), pg_temp.u8('000107181004'), 1);
  insert into public.learning_path_assignments (id, path_id, organization_id, assignee_type, user_id)
  values (pg_temp.u8('000107182103'), pg_temp.u8('000107182003'), org, 'user', u9);
  perform pg_temp.att8(pg_temp.u8('000107187031'), pg_temp.u8('000107181204'), u9, 'completed', 'path',
                       pg_temp.u8('000107182003'), null, null, null, null, 30);
  perform public.record_learning_activity(pg_temp.u8('000107187031'));
  if (select count(*) from public.learning_path_step_completions f where f.user_id = u9) <> 1 then
    bad := bad || 'the WD fact was not written'::text;
  end if;
  -- (9) a session that is not the service role's: refused, the fact stays
  st := pg_temp.state8('delete from public.courses where id = ''00000000-0000-0000-0000-000107181004''',
                       '{"role": "authenticated"}');
  if st <> 'P0001' then
    bad := bad || format('O1-g (9), the course delete on a session: %s (expected learner_history_exists, P0001)', st);
  end if;
  -- with the service-role claim: the course goes with its attempt and fact
  perform set_config('request.jwt.claims', '{"role": "service_role"}', true);
  delete from public.courses where id = pg_temp.u8('000107181004');
  perform set_config('request.jwt.claims', '', true);
  if exists (select 1 from public.course_attempts where id = pg_temp.u8('000107187031'))
     or exists (select 1 from public.learning_path_step_completions f where f.user_id = u9) then
    bad := bad || 'O1-g (9): the attempt or the fact survived the course''s cascade'::text;
  end if;
  -- (10) a fact seeded alone refuses its path's delete
  insert into public.learning_path_step_completions (organization_id, path_id, course_id, user_id, rule_pass_required)
  values (org, pg_temp.u8('000107182004'), pg_temp.u8('000107181001'), u9, false);
  st := pg_temp.state8('delete from public.learning_paths where id = ''00000000-0000-0000-0000-000107182004''');
  if st <> '23503' then
    bad := bad || format('O1-g (10), a lone path delete over a fact: %s (expected 23503)', st);
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107: (38) %', array_to_string(bad, '; ');
  end if;
end
$$;
rollback to savepoint s38b;

-- (38c) D14 through the writer: U2 passes WA and completes WB in PW (the
-- path completes); a grant read as Individual (as every grant from before
-- 0107, note N9) is used by a retake of WA in PW. While the retake is live
-- it is the context's official candidate (the activity branch runs); it
-- then fails at 0.95: it is the official attempt, number 2, the step stays
-- done by its earlier pass, the path completion stands, and the high bonus
-- is paid from it, because the consumed grant widens the scored window of
-- the retake row's own context
savepoint s38c;
do $$
declare
  bad  text[] := '{}';
  org  constant uuid := '00000000-0000-0000-0000-00000000000a';
  pw   constant uuid := '00000000-0000-0000-0000-000107182001';
  u2   constant uuid := '00000000-0000-0000-0000-000107180002';
  wa   constant uuid := '00000000-0000-0000-0000-000107181001';
  a    jsonb;
begin
  perform pg_temp.att8(pg_temp.u8('000107187041'), pg_temp.u8('000107181201'), u2, 'passed', 'path',
                       pw, null, null, null, null, 60, 0.5);
  perform public.record_learning_activity(pg_temp.u8('000107187041'));
  perform pg_temp.att8(pg_temp.u8('000107187042'), pg_temp.u8('000107181202'), u2, 'completed', 'path',
                       pw, null, null, null, null, 55, 0.7);
  a := public.record_learning_activity(pg_temp.u8('000107187042'));
  if a ->> 'path_completed' <> 'true' then
    bad := bad || format('the path before the retake: %s', a);
  end if;
  perform pg_temp.att8(pg_temp.u8('000107187043'), pg_temp.u8('000107181201'), u2, 'in_progress', 'path',
                       pw, null, null, null, null, 20);
  insert into public.attempt_requests (id, organization_id, course_id, user_id, status, source, decided_at,
                                       context_kind, used_at, used_attempt_id)
  values (pg_temp.u8('000107187401'), org, wa, u2, 'approved', 'bulk', now() - interval '30 minutes', 'individual',
          now() - interval '20 minutes', pg_temp.u8('000107187043'));
  a := public.record_learning_activity(pg_temp.u8('000107187043'));
  if a ->> 'activity' <> 'true' or a ->> 'official' <> 'false' or a -> 'attempt_number' <> 'null'::jsonb then
    bad := bad || format('the live retake: %s (expected the activity branch, not official)', a);
  end if;
  update public.course_attempts
     set status = 'failed', completion_status = 'completed', success_status = 'failed', score = 0.95,
         completed_at = now()
   where id = pg_temp.u8('000107187043');
  a := public.record_learning_activity(pg_temp.u8('000107187043'));
  if a ->> 'official' <> 'true' or a ->> 'attempt_number' <> '2' or a ->> 'done' <> 'true'
     or a ->> 'passed_ever' <> 'true' or a ->> 'path_completed' <> 'false' or a -> 'notices' <> '[]'::jsonb then
    bad := bad || format('the failed retake: %s', a);
  end if;
  if (select count(*) from public.learning_path_completions lc where lc.path_id = pw and lc.user_id = u2) <> 1
     or not (select pp.completed from public.v_path_progress pp where pp.path_id = pw and pp.user_id = u2) then
    bad := bad || 'the failed retake removed or blocked the path completion'::text;
  end if;
  if not exists (select 1 from public.xp_events e
                  where e.dedupe_key = format('high:%s:%s', u2, wa) and e.attempt_id = pg_temp.u8('000107187043')) then
    bad := bad || 'the granted retake''s high bonus was not paid (the grant did not widen its context''s window)'::text;
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107: (38) %', array_to_string(bad, '; ');
  end if;
end
$$;
rollback to savepoint s38c;

-- ---------------------------------------------------------------------------
-- (39) sweep_completion_side_effects
-- ---------------------------------------------------------------------------
savepoint s39;
create function public.zz_0107w_refuse() returns trigger language plpgsql as $$
begin
  if new.attempt_id = '00000000-0000-0000-0000-000107188002' then
    raise exception 'assert-0107: a refused claim' using errcode = 'P0001';
  end if;
  return new;
end
$$;
create trigger zz_0107w_refuse before insert on public.completion_notices
  for each row execute function public.zz_0107w_refuse();
do $$
declare
  bad  text[] := '{}';
  u1   constant uuid := '00000000-0000-0000-0000-000107180001';
  u2   constant uuid := '00000000-0000-0000-0000-000107180002';
  u3   constant uuid := '00000000-0000-0000-0000-000107180003';
  a    jsonb;
  st   text;
begin
  if pg_temp.state8('select public.sweep_completion_side_effects(null)') <> '22023'
     or pg_temp.state8('select public.sweep_completion_side_effects(0)') <> '22023' then
    bad := bad || 'a null or zero limit is not refused with 22023'::text;
  end if;
  -- no row the paste stamped is a candidate: every candidate before the
  -- fixtures was never handled
  if exists (select 1 from public.course_attempts ca
              where (ca.completion_status = 'completed' or ca.success_status = 'passed')
                and not ca.is_revision and ca.context_kind <> 'preview' and ca.status <> 'abandoned'
                and ca.side_effects_sig is distinct from ca.settle_sig
                and ca.side_effects_at is not null) then
    bad := bad || 'a row the paste or a writer stamped is a sweep candidate'::text;
  end if;

  -- S1 handled; S2 raising (its claim is refused); S3 too fresh; S4 a
  -- preview; S5 a revision row; S6 abandoned; S7 below
  perform pg_temp.att8(pg_temp.u8('000107188001'), pg_temp.u8('000107181201'), u1, 'completed', 'individual',
                       null, null, null, null, null, 30);
  perform pg_temp.att8(pg_temp.u8('000107188002'), pg_temp.u8('000107181201'), u2, 'completed', 'individual',
                       null, null, null, null, null, 30);
  insert into public.course_attempts (id, course_version_id, user_id, organization_id, status, completion_status,
                                      success_status, started_at, completed_at, context_kind, launch_mode)
  values (pg_temp.u8('000107188003'), pg_temp.u8('000107181201'), u3, '00000000-0000-0000-0000-00000000000a',
          'completed', 'completed', 'unknown', now() - interval '10 minutes', now(), 'individual', 'Normal');
  perform pg_temp.prev8(pg_temp.u8('000107188004'), pg_temp.u8('000107181202'), u1, 'course', null, null, 1);
  perform pg_temp.att8(pg_temp.u8('000107188005'), pg_temp.u8('000107181202'), u2, 'revision', 'individual',
                       null, null, null, null, null, 30);
  update public.course_attempts set completion_status = 'completed' where id = pg_temp.u8('000107188005');
  perform pg_temp.att8(pg_temp.u8('000107188006'), pg_temp.u8('000107181203'), u2, 'abandoned', 'individual',
                       null, null, null, null, null, 30);

  -- S7: U2's completed official row in PW, never handled: the sweep's
  -- completion branch writes its step fact (O1-g (5), the sweep)
  perform pg_temp.att8(pg_temp.u8('000107188007'), pg_temp.u8('000107181201'), u2, 'completed', 'path',
                       pg_temp.u8('000107182001'), null, null, null, null, 30);

  a := public.sweep_completion_side_effects(1000);
  if (a ->> 'failed')::int < 1
     or not exists (select 1 from jsonb_array_elements(a -> 'errors') e
                     where e ->> 'attempt_id' = '00000000-0000-0000-0000-000107188002' and e ->> 'sqlstate' = 'P0001')
     or (a ->> 'candidates')::int <> (a ->> 'handled')::int + (a ->> 'failed')::int then
    bad := bad || format('the sweep''s answer: %s', a);
  end if;
  select string_agg(right(c.id::text, 4) || '=' || (c.side_effects_sig is not distinct from c.settle_sig), ',' order by c.id)
    into st from public.course_attempts c where c.id::text like '%-0001071880__';
  if st is distinct from '8001=true,8002=false,8003=false,8004=false,8005=false,8006=false,8007=true' then
    bad := bad || format('the rows after the sweep: %s (expected S1 and S7 handled only)', st);
  end if;
  if (select string_agg(right(f.attempt_id::text, 4), ',') from public.learning_path_step_completions f
       where f.user_id = u2) is distinct from '8007' then
    bad := bad || 'the sweep did not write S7''s step fact'::text;
  end if;
  -- a second sweep: S1 and S7 are no longer candidates; S2 still is
  a := public.sweep_completion_side_effects(1000);
  if not exists (select 1 from jsonb_array_elements(a -> 'errors') e
                  where e ->> 'attempt_id' = '00000000-0000-0000-0000-000107188002')
     or (select count(*) from public.learning_path_step_completions f where f.user_id = u2) <> 1 then
    bad := bad || format('the second sweep: %s', a);
  end if;
  -- the completion branch only: S1's points without a daily row or a day
  if exists (select 1 from public.xp_events e where e.user_id = u1 and e.rule = 'daily_activity')
     or not exists (select 1 from public.xp_events e where e.attempt_id = pg_temp.u8('000107188001') and e.rule = 'course_completed')
     or (select last_active_day from public.user_gamification g where g.user_id = u1) is not null then
    bad := bad || 'the sweep paid a daily row, moved a day, or paid no completion'::text;
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107: (39) %', array_to_string(bad, '; ');
  end if;
end
$$;
rollback to savepoint s39;

-- ---------------------------------------------------------------------------
-- (40) purge_preview_data
-- ---------------------------------------------------------------------------
-- The purge world, in an organisation of its own, Org P (so the seed's rows
-- of Org A, the second paste's preview among them, are outside every
-- scope): tester S (U1) and tester T (U2); courses PA and PB; path PP (PA)
-- and path PP2 (PA); program JP with day JD1 (PA), its version and U5's
-- enrolment on it; PA's course preview K1 of S two years old (with a
-- statement, a State row, a launch token, a session and an outbox row) and
-- K2 of S new; PP's test run R1 of S with its attempt K3 (on PB); JP's test
-- run R2 of S with its attempt K4 (on PA); PP2's run R3 of S with no
-- attempt; T's course preview K5; a breach K6 of S on PB (a points row
-- points at it); rows flagged by role (legacy_role) L1 completed, L2 the
-- target of a used grant, L3 with a points row and a day credit, L4 with no
-- result; an official attempt O1.
savepoint s40w;
do $$
declare
  org constant uuid := '00000000-0000-0000-0000-000107189900';
  s   constant uuid := '00000000-0000-0000-0000-000107180001';
  t   constant uuid := '00000000-0000-0000-0000-000107180002';
  i   int;
  c   text[] := array['000107189501', '000107189502'];
begin
  insert into public.organizations (id, name, slug) values (org, 'Org P (0107 writer)', 'org-p-0107w');
  for i in 1..2 loop
    insert into public.courses (id, organization_id, title, slug)
    values (pg_temp.u8(c[i]), org, format('P%s (0107 writer)', i), format('p%s-0107w', i));
    insert into public.course_packages (id, course_id, language, is_active)
    values (pg_temp.u8('00010718951' || i), pg_temp.u8(c[i]), null, true);
    insert into public.course_versions (id, course_id, package_id, version_number, manifest_type, launch_url,
                                        storage_prefix, manifest_data)
    values (pg_temp.u8('00010718952' || i), pg_temp.u8(c[i]), pg_temp.u8('00010718951' || i), 1, 'scorm12',
            'index.html', format('courses/p%s-0107w/v1/', i), '{"title":"0107 writer"}');
  end loop;
  insert into public.learning_paths (id, organization_id, name, slug, is_active, visibility) values
    (pg_temp.u8('000107189601'), org, 'PP (0107 writer)', 'pp-0107w', true, 'private'),
    (pg_temp.u8('000107189602'), org, 'PP2 (0107 writer)', 'pp2-0107w', true, 'private');
  insert into public.learning_path_courses (path_id, course_id, step_number) values
    (pg_temp.u8('000107189601'), pg_temp.u8(c[1]), 1),
    (pg_temp.u8('000107189602'), pg_temp.u8(c[1]), 1);
  insert into public.journey_programs (id, organization_id, name, days_total)
  values (pg_temp.u8('000107189701'), org, 'JP (0107 writer)', 1);
  insert into public.journey_days (id, program_id, organization_id, day_number, course_id)
  values (pg_temp.u8('000107189711'), pg_temp.u8('000107189701'), org, 1, pg_temp.u8(c[1]));
  insert into public.journey_versions (id, program_id, organization_id, version_number, name, days_total,
                                       count_sundays, completion_title, days, day_ids, day_ids_source)
  values (pg_temp.u8('000107189721'), pg_temp.u8('000107189701'), org, 1, 'JP (0107 writer)', 1, true, 'Done',
          jsonb_build_array(jsonb_build_object('day', 1, 'course_id', pg_temp.u8(c[1])::text)),
          jsonb_build_object('1', pg_temp.u8('000107189711')::text), 'editor');
  update public.journey_programs set current_version_id = pg_temp.u8('000107189721')
   where id = pg_temp.u8('000107189701');
  insert into public.journey_enrollments (id, program_id, version_id, organization_id, user_id, start_date, status)
  values (pg_temp.u8('000107189731'), pg_temp.u8('000107189701'), pg_temp.u8('000107189721'), org,
          '00000000-0000-0000-0000-000107180005', current_date, 'active');

  insert into public.preview_runs (id, organization_id, user_id, kind, learning_path_id, journey_program_id,
                                   journey_version_id) values
    (pg_temp.u8('000107189101'), org, s, 'path', pg_temp.u8('000107189601'), null, null),
    (pg_temp.u8('000107189102'), org, s, 'journey', null, pg_temp.u8('000107189701'), pg_temp.u8('000107189721')),
    (pg_temp.u8('000107189103'), org, s, 'path', pg_temp.u8('000107189602'), null, null);
  perform pg_temp.prev8(pg_temp.u8('000107189001'), pg_temp.u8('000107189521'), s, 'course', null, null, 730, '00000000-0000-0000-0000-000107189900');
  perform pg_temp.prev8(pg_temp.u8('000107189002'), pg_temp.u8('000107189521'), s, 'course', null, null, 0, '00000000-0000-0000-0000-000107189900');
  perform pg_temp.prev8(pg_temp.u8('000107189003'), pg_temp.u8('000107189522'), s, 'path_run',
                        pg_temp.u8('000107189101'), null, 1, '00000000-0000-0000-0000-000107189900');
  perform pg_temp.prev8(pg_temp.u8('000107189004'), pg_temp.u8('000107189521'), s, 'journey_run',
                        pg_temp.u8('000107189102'), pg_temp.u8('000107189711'), 1, '00000000-0000-0000-0000-000107189900');
  perform pg_temp.prev8(pg_temp.u8('000107189005'), pg_temp.u8('000107189521'), t, 'course', null, null, 3, '00000000-0000-0000-0000-000107189900');
  perform pg_temp.prev8(pg_temp.u8('000107189006'), pg_temp.u8('000107189522'), s, 'course', null, null, 2, '00000000-0000-0000-0000-000107189900');
  for i in 1..4 loop
    perform pg_temp.prev8(pg_temp.u8('00010718920' || i), pg_temp.u8('000107189521'), s, 'legacy_role', null, null, 400, '00000000-0000-0000-0000-000107189900');
  end loop;
  update public.course_attempts set status = 'in_progress', completion_status = 'in_progress', success_status = 'unknown',
                                    score = null, completed_at = null
   where id = pg_temp.u8('000107189204');
  perform pg_temp.att8(pg_temp.u8('000107189301'), pg_temp.u8('000107189521'), pg_temp.u8('000107180004'),
                       'completed', 'individual', null, null, null, null, null, 60);

  insert into public.xapi_statements (attempt_id, statement_id, verb, raw)
  values (pg_temp.u8('000107189001'), gen_random_uuid(), 'completed', '{}');
  insert into public.xapi_state (attempt_id, state_id, content) values (pg_temp.u8('000107189001'), 'bookmark', '{}');
  insert into public.cmi5_launch_tokens (auth_token, attempt_id) values ('token-0107w-k1', pg_temp.u8('000107189001'));
  insert into public.learning_sessions (organization_id, attempt_id, launch_kind, activity_id, launch_mode)
  values (org, pg_temp.u8('000107189001'), 'cmi5', 'activity-0107w', 'Normal');
  insert into public.lrs_forward_outbox (organization_id, attempt_id, statement_id, payload)
  values (org, pg_temp.u8('000107189001'), 'stmt-0107w-k1', '{}');

  insert into public.xp_events (organization_id, user_id, rule, xp, attempt_id, dedupe_key)
  values (org, s, 'adjustment', 0, pg_temp.u8('000107189006'), 'assert-0107w-breach'),
         (org, s, 'adjustment', 0, pg_temp.u8('000107189203'), 'assert-0107w-legacy');
  insert into public.attempt_requests (id, organization_id, course_id, user_id, status, source, decided_at, context_kind,
                                       used_at, used_attempt_id)
  values (pg_temp.u8('000107189401'), org, pg_temp.u8('000107189501'), s, 'approved', 'bulk', now(), 'individual',
          now(), pg_temp.u8('000107189202'));
  insert into public.journey_day_progress (enrollment_id, organization_id, user_id, day_number, day_id, course_id,
                                           attempt_id, credit_kind)
  values ('00000000-0000-0000-0000-000107189731', org, '00000000-0000-0000-0000-000107180005', 1,
          pg_temp.u8('000107189711'), pg_temp.u8('000107189501'), pg_temp.u8('000107189203'), 'legacy_cross_context');
end
$$;

-- a preview launched after a dry run, then the real call with that dry
-- run's hash
create function pg_temp.launch_then_purge8(p_hash text) returns jsonb language plpgsql as $$
begin
  perform pg_temp.prev8('00000000-0000-0000-0000-000107189007', '00000000-0000-0000-0000-000107189522',
                        '00000000-0000-0000-0000-000107180001', 'course', null, null, 0, '00000000-0000-0000-0000-000107189900');
  return public.purge_preview_data('00000000-0000-0000-0000-000107189900', '{"organization": true}', 'manual',
                                   '00000000-0000-0000-0000-000107180009', false, p_hash);
end
$$;

create function pg_temp.kept8() returns text language plpgsql as $$
-- every base table of public and auth: its row count and an md5 over its
-- rows, leaving out only new-kind preview data (the preview attempts of the
-- kinds course, path_run and journey_run, the rows of the five tables that
-- hang on them by attempt_id, the test runs and the purge's own audit rows)
declare
  r    record;
  v    text;
  acc  text := '';
  prev constant text := '(select c.id from public.course_attempts c where c.context_kind = ''preview'' '
                        || 'and c.preview_kind in (''course'', ''path_run'', ''journey_run''))';
begin
  for r in
    select n.nspname, c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where c.relkind in ('r', 'p')
       and n.nspname in ('public', 'auth')
       and c.relname not in ('preview_runs', 'preview_purge_log')
     order by 1, 2
  loop
    execute format('select count(*) || '':'' || md5(coalesce(string_agg(t::text, ''|'' order by t::text), '''')) '
                   || 'from %I.%I t %s', r.nspname, r.relname,
                   case
                     when r.nspname = 'public' and r.relname = 'course_attempts' then 'where t.id not in ' || prev
                     when r.nspname = 'public' and r.relname in ('xapi_statements', 'xapi_state', 'cmi5_launch_tokens',
                                                                 'learning_sessions', 'lrs_forward_outbox')
                       then 'where t.attempt_id is null or t.attempt_id not in ' || prev
                     else ''
                   end)
      into v;
    acc := acc || r.nspname || '.' || r.relname || '=' || v || ';';
  end loop;
  return md5(acc);
end
$$;

create function pg_temp.left8() returns text language sql stable as $$
  select coalesce((select string_agg(right(c.id::text, 4), ',' order by c.id) from public.course_attempts c
                    where c.id::text like '%-00010718900_'), '')
         || ' runs ' || coalesce((select string_agg(right(r.id::text, 4), ',' order by r.id) from public.preview_runs r
                                   where r.id::text like '%-0001071891__'), '')
$$;

-- one scope: the dry run, then the real call with its hash; answers what
-- is left of the purge world, the counts, the excluded count and the log row
create function pg_temp.purge8(p_scope jsonb, p_reason text default 'manual') returns text
language plpgsql as $$
declare
  dry  jsonb;
  v_real jsonb;
  lg   record;
begin
  dry := public.purge_preview_data('00000000-0000-0000-0000-000107189900', p_scope, p_reason,
                                   '00000000-0000-0000-0000-000107180009', true);
  v_real := public.purge_preview_data('00000000-0000-0000-0000-000107189900', p_scope, p_reason,
                                    '00000000-0000-0000-0000-000107180009', false, dry ->> 'selection_hash');
  select * into lg from public.preview_purge_log l where l.id = (v_real ->> 'log_id')::uuid;
  return format('left %s | counts %s | excluded %s | same=%s | log %s',
                pg_temp.left8(), v_real -> 'counts', v_real ->> 'excluded', (dry -> 'counts') = (v_real -> 'counts'),
                case when lg.id is null then 'none'
                     else format('%s/%s/%s/%s', lg.reason, right(lg.actor_user_id::text, 4), cardinality(lg.attempt_ids),
                                 coalesce(cardinality(lg.run_ids), 0)) end);
end
$$;

do $$
declare
  bad  text[] := '{}';
  org  constant uuid := '00000000-0000-0000-0000-000107189900';
  act  constant uuid := '00000000-0000-0000-0000-000107180009';
  r    record;
  st   text;
  k0   text;
  l0   text;
  dry  jsonb;
  got  text;
  n    bigint;
begin
  k0 := pg_temp.kept8();
  l0 := pg_temp.left8();
  -- the refusals: 22023, nothing deleted
  for r in
    select * from (values
      ('null organisation', 'select public.purge_preview_data(null, ''{"organization": true}'', ''manual'', ''' || act || ''', true)'),
      ('null actor', 'select public.purge_preview_data(''' || org || ''', ''{"organization": true}'', ''manual'', null, true)'),
      ('unknown reason', 'select public.purge_preview_data(''' || org || ''', ''{"organization": true}'', ''age'', ''' || act || ''', true)'),
      ('null dry run', 'select public.purge_preview_data(''' || org || ''', ''{"organization": true}'', ''manual'', ''' || act || ''', null)'),
      ('real call, null hash', 'select public.purge_preview_data(''' || org || ''', ''{"organization": true}'', ''manual'', ''' || act || ''', false)'),
      ('null scope', 'select public.purge_preview_data(''' || org || ''', null, ''manual'', ''' || act || ''', true)'),
      ('empty scope', 'select public.purge_preview_data(''' || org || ''', ''{}'', ''manual'', ''' || act || ''', true)'),
      ('a list', 'select public.purge_preview_data(''' || org || ''', ''["00000000-0000-0000-0000-000107189001"]'', ''manual'', ''' || act || ''', true)'),
      ('unknown key', 'select public.purge_preview_data(''' || org || ''', ''{"legacy_role": true}'', ''manual'', ''' || act || ''', true)'),
      ('id list', 'select public.purge_preview_data(''' || org || ''', ''{"attempt_ids": ["00000000-0000-0000-0000-000107189001"]}'', ''manual'', ''' || act || ''', true)'),
      ('null value', 'select public.purge_preview_data(''' || org || ''', ''{"attempt_id": null}'', ''manual'', ''' || act || ''', true)'),
      ('not a uuid', 'select public.purge_preview_data(''' || org || ''', ''{"attempt_id": "x"}'', ''manual'', ''' || act || ''', true)'),
      ('two products', 'select public.purge_preview_data(''' || org || ''', ''{"course_id": "00000000-0000-0000-0000-000107189501", "learning_path_id": "00000000-0000-0000-0000-000107189601"}'', ''manual'', ''' || act || ''', true)'),
      ('attempt and run', 'select public.purge_preview_data(''' || org || ''', ''{"attempt_id": "00000000-0000-0000-0000-000107189001", "run_id": "00000000-0000-0000-0000-000107189101"}'', ''manual'', ''' || act || ''', true)'),
      ('organization false', 'select public.purge_preview_data(''' || org || ''', ''{"organization": false}'', ''manual'', ''' || act || ''', true)'),
      ('organization and user', 'select public.purge_preview_data(''' || org || ''', ''{"organization": true, "user_id": "00000000-0000-0000-0000-000107180001"}'', ''manual'', ''' || act || ''', true)'),
      ('product delete, a tester', 'select public.purge_preview_data(''' || org || ''', ''{"user_id": "00000000-0000-0000-0000-000107180001"}'', ''product_delete'', ''' || act || ''', true)'),
      ('product delete, tester and course', 'select public.purge_preview_data(''' || org || ''', ''{"user_id": "00000000-0000-0000-0000-000107180001", "course_id": "00000000-0000-0000-0000-000107189501"}'', ''product_delete'', ''' || act || ''', true)')
    ) as t(what, stmt)
  loop
    st := pg_temp.state8(r.stmt);
    if st <> '22023' then
      bad := bad || format('%s: %s (expected 22023)', r.what, st);
    end if;
  end loop;
  if pg_temp.kept8() <> k0 or pg_temp.left8() <> l0 or exists (select 1 from public.preview_purge_log l where l.organization_id = org) then
    bad := bad || 'a refused call changed something'::text;
  end if;

  -- another organisation's call selects nothing of Org P
  dry := public.purge_preview_data('00000000-0000-0000-0000-00000000000a',
                                   '{"attempt_id": "00000000-0000-0000-0000-000107189001"}', 'manual', act, true);
  if (dry #>> '{counts,total}') <> '0' or dry ->> 'excluded' <> '0' then
    bad := bad || format('Org A''s call over an attempt of Org P: %s (expected nothing)', dry);
  end if;

  -- the dry run: the counts, the excluded breach, nothing written
  dry := public.purge_preview_data(org, '{"organization": true}', 'manual', act, true);
  if dry -> 'counts' <> '{"attempts": 5, "test_runs": 3, "statements": 1, "state": 1, "launch_tokens": 1, "sessions": 1, "outbox": 1, "total": 13}'::jsonb
     or dry ->> 'excluded' <> '1'
     or dry -> 'excluded_attempts' <> '[{"attempt_id": "00000000-0000-0000-0000-000107189006", "tables": ["xp_events"]}]'::jsonb
     or length(dry ->> 'selection_hash') <> 64 then
    bad := bad || format('the dry run: %s', dry);
  end if;
  if pg_temp.kept8() <> k0 or pg_temp.left8() <> l0 or exists (select 1 from public.preview_purge_log l where l.organization_id = org)
     or (select count(*) from public.xapi_statements where attempt_id = pg_temp.u8('000107189001')) <> 1 then
    bad := bad || 'the dry run changed something'::text;
  end if;
  -- a wrong hash, and a preview launched after the dry run: 40001, nothing
  st := pg_temp.state8('select public.purge_preview_data(''' || org || ''', ''{"organization": true}'', ''manual'', '''
                       || act || ''', false, ''' || repeat('0', 64) || ''')');
  if st <> '40001' then
    bad := bad || format('a wrong hash: %s (expected 40001)', st);
  end if;
  st := pg_temp.state8('select pg_temp.launch_then_purge8(''' || (dry ->> 'selection_hash') || ''')');
  if st <> '40001' then
    bad := bad || format('a preview launched after the dry run: %s (expected 40001)', st);
  end if;
  if pg_temp.kept8() <> k0 or pg_temp.left8() <> l0 or exists (select 1 from public.preview_purge_log l where l.organization_id = org) then
    bad := bad || 'a refused real call changed something'::text;
  end if;

  -- (R6-a) the refresh functions and the sweep leave Preview data alone
  perform public.refresh_report_views();
  perform public.refresh_gamification_views();
  perform public.sweep_completion_side_effects(1000);
  if pg_temp.left8() <> l0 or exists (select 1 from public.preview_purge_log l where l.organization_id = org) then
    bad := bad || 'a refresh or the sweep removed Preview data'::text;
  end if;

  if cardinality(bad) > 0 then
    raise exception 'assert-0107: (40) %', array_to_string(bad, '; ');
  end if;
end
$$;

-- the scopes, each from the purge world as seeded
create temporary table r0107w_purge (k text primary key, got text, want text);
do $$
declare
  r   record;
  got text;
begin
  for r in
    select * from (values
      ('attempt K2', '{"attempt_id": "00000000-0000-0000-0000-000107189002"}', 'manual',
       'left 9001,9003,9004,9005,9006 runs 9101,9102,9103 | counts {"state": 0, "total": 1, "outbox": 0, "attempts": 1, "sessions": 0, "test_runs": 0, "statements": 0, "launch_tokens": 0} | excluded 0 | same=t | log manual/0009/1/0'),
      ('run R1', '{"run_id": "00000000-0000-0000-0000-000107189101"}', 'manual',
       'left 9001,9002,9004,9005,9006 runs 9102,9103 | counts {"state": 0, "total": 2, "outbox": 0, "attempts": 1, "sessions": 0, "test_runs": 1, "statements": 0, "launch_tokens": 0} | excluded 0 | same=t | log manual/0009/1/1'),
      ('run R3 (no attempt)', '{"run_id": "00000000-0000-0000-0000-000107189103"}', 'manual',
       'left 9001,9002,9003,9004,9005,9006 runs 9101,9102 | counts {"state": 0, "total": 1, "outbox": 0, "attempts": 0, "sessions": 0, "test_runs": 1, "statements": 0, "launch_tokens": 0} | excluded 0 | same=t | log manual/0009/0/1'),
      ('tester T', '{"user_id": "00000000-0000-0000-0000-000107180002"}', 'manual',
       'left 9001,9002,9003,9004,9006 runs 9101,9102,9103 | counts {"state": 0, "total": 1, "outbox": 0, "attempts": 1, "sessions": 0, "test_runs": 0, "statements": 0, "launch_tokens": 0} | excluded 0 | same=t | log manual/0009/1/0'),
      ('tester S with course WA', '{"user_id": "00000000-0000-0000-0000-000107180001", "course_id": "00000000-0000-0000-0000-000107189501"}', 'manual',
       'left 9003,9005,9006 runs 9101,9103 | counts {"state": 1, "total": 9, "outbox": 1, "attempts": 3, "sessions": 1, "test_runs": 1, "statements": 1, "launch_tokens": 1} | excluded 0 | same=t | log manual/0009/3/1'),
      ('tester S', '{"user_id": "00000000-0000-0000-0000-000107180001"}', 'manual',
       'left 9005,9006 runs  | counts {"state": 1, "total": 12, "outbox": 1, "attempts": 4, "sessions": 1, "test_runs": 3, "statements": 1, "launch_tokens": 1} | excluded 1 | same=t | log manual/0009/4/3'),
      ('path PW, product delete', '{"learning_path_id": "00000000-0000-0000-0000-000107189601"}', 'product_delete',
       'left 9001,9002,9004,9005,9006 runs 9102,9103 | counts {"state": 0, "total": 2, "outbox": 0, "attempts": 1, "sessions": 0, "test_runs": 1, "statements": 0, "launch_tokens": 0} | excluded 0 | same=t | log product_delete/0009/1/1'),
      ('program JW, product delete', '{"journey_program_id": "00000000-0000-0000-0000-000107189701"}', 'product_delete',
       'left 9001,9002,9003,9005,9006 runs 9101,9103 | counts {"state": 0, "total": 2, "outbox": 0, "attempts": 1, "sessions": 0, "test_runs": 1, "statements": 0, "launch_tokens": 0} | excluded 0 | same=t | log product_delete/0009/1/1'),
      ('course WB, product delete (the breach kept)', '{"course_id": "00000000-0000-0000-0000-000107189502"}', 'product_delete',
       'left 9001,9002,9004,9005,9006 runs 9102,9103 | counts {"state": 0, "total": 2, "outbox": 0, "attempts": 1, "sessions": 0, "test_runs": 1, "statements": 0, "launch_tokens": 0} | excluded 1 | same=t | log product_delete/0009/1/1'),
      ('tester T with path PP2 (S''s run with no attempt stays)',
       '{"user_id": "00000000-0000-0000-0000-000107180002", "learning_path_id": "00000000-0000-0000-0000-000107189602"}', 'manual',
       'left 9001,9002,9003,9004,9005,9006 runs 9101,9102,9103 | counts {"state": 0, "total": 0, "outbox": 0, "attempts": 0, "sessions": 0, "test_runs": 0, "statements": 0, "launch_tokens": 0} | excluded 0 | same=t | log none'),
      ('the organisation', '{"organization": true}', 'manual',
       'left 9006 runs  | counts {"state": 1, "total": 13, "outbox": 1, "attempts": 5, "sessions": 1, "test_runs": 3, "statements": 1, "launch_tokens": 1} | excluded 1 | same=t | log manual/0009/5/3')
    ) as t(k, scope, reason, want)
  loop
    begin
      got := pg_temp.purge8(r.scope::jsonb, r.reason);
      raise exception using errcode = 'R0107', message = 'assert-0107: undo';
    exception when others then
      if sqlstate <> 'R0107' then
        got := 'error ' || sqlstate || ': ' || sqlerrm;
      end if;
    end;
    insert into pg_temp.r0107w_purge values (r.k, got, r.want);
  end loop;
end
$$;

do $$
declare
  failed text;
begin
  select string_agg(format('%s: %s (expected %s)', r.k, coalesce(r.got, 'null'), r.want), '; ' order by r.k) into failed
    from pg_temp.r0107w_purge r
   where r.got is distinct from r.want;
  if failed is not null then
    raise exception 'assert-0107: (40) %', failed;
  end if;
  if (select count(*) from pg_temp.r0107w_purge) <> 11 then
    raise exception 'assert-0107: (40) % scopes ran (expected 11)', (select count(*) from pg_temp.r0107w_purge);
  end if;
end
$$;

-- a run named by the scope whose only attempt is set aside (a points row
-- points at K3): the attempt and its run stay, the audit row names the
-- excluded attempt and deletes nothing
do $$
declare
  got text;
begin
  begin
    insert into public.xp_events (organization_id, user_id, rule, xp, attempt_id, dedupe_key)
    values ('00000000-0000-0000-0000-000107189900', '00000000-0000-0000-0000-000107180001', 'adjustment', 0,
            '00000000-0000-0000-0000-000107189003', 'assert-0107w-breach-k3');
    got := pg_temp.purge8('{"run_id": "00000000-0000-0000-0000-000107189101"}');
    raise exception using errcode = 'R0107', message = 'assert-0107: undo';
  exception when others then
    if sqlstate <> 'R0107' then
      got := 'error ' || sqlstate || ': ' || sqlerrm;
    end if;
  end;
  if got is distinct from 'left 9001,9002,9003,9004,9005,9006 runs 9101,9102,9103 | counts {"state": 0, "total": 0, '
                          || '"outbox": 0, "attempts": 0, "sessions": 0, "test_runs": 0, "statements": 0, '
                          || '"launch_tokens": 0} | excluded 1 | same=t | log manual/0009/0/0' then
    raise exception 'assert-0107: (40) a run whose attempt is set aside: % (expected the run kept)', got;
  end if;
end
$$;

-- step 63 case (5), arm by arm: a new-kind preview pointed at from each of
-- the seven tables the isolation check reads is set aside with that table
-- (B1 in R1 beside K3, B7 in R2 beside K4); a run scope deletes the clean
-- K3 and keeps B1 with its run; the path and the program product deletes
-- find their breach in the dry run; the organisation's call deletes none of
-- B1 to B7 and changes no row that is not new-kind preview data; then the
-- user's and the organisation's cascades pass over the test runs (case (8))
do $$
declare
  bad  text[] := '{}';
  org  constant uuid := '00000000-0000-0000-0000-000107189900';
  act  constant uuid := '00000000-0000-0000-0000-000107180009';
  s    constant uuid := '00000000-0000-0000-0000-000107180001';
  t    constant uuid := '00000000-0000-0000-0000-000107180002';
  pa   constant uuid := '00000000-0000-0000-0000-000107189501';
  pp   constant uuid := '00000000-0000-0000-0000-000107189601';
  got  text;
  dry  jsonb;
  k0   text;
  st   text;
begin
  begin
    perform pg_temp.prev8(pg_temp.u8('000107189801'), pg_temp.u8('000107189522'), s, 'path_run',
                          pg_temp.u8('000107189101'), null, 1, org);
    insert into public.journey_enrollments (id, program_id, version_id, organization_id, user_id, start_date, status)
    values (pg_temp.u8('000107189732'), pg_temp.u8('000107189701'), pg_temp.u8('000107189721'), org,
            '00000000-0000-0000-0000-000107180006', current_date, 'active');
    insert into public.journey_day_progress (enrollment_id, organization_id, user_id, day_number, day_id, course_id,
                                             attempt_id, credit_kind)
    values (pg_temp.u8('000107189732'), org, '00000000-0000-0000-0000-000107180006', 1, pg_temp.u8('000107189711'), pa,
            pg_temp.u8('000107189801'), 'legacy_cross_context');
    perform pg_temp.prev8(pg_temp.u8('000107189802'), pg_temp.u8('000107189521'), s, 'course', null, null, 1, org);
    insert into public.completion_notices (organization_id, user_id, product_kind, instance_id, attempt_id, event_type)
    values (org, s, 'individual', pa, pg_temp.u8('000107189802'), 'asset_completion');
    perform pg_temp.prev8(pg_temp.u8('000107189803'), pg_temp.u8('000107189521'), s, 'course', null, null, 1, org);
    insert into public.learning_path_completions (organization_id, path_id, user_id, steps)
    values (org, pp, t, jsonb_build_array(jsonb_build_object('step_number', 1, 'course_id', pa,
                                                             'attempt_id', pg_temp.u8('000107189803'), 'score', 0.8)));
    perform pg_temp.prev8(pg_temp.u8('000107189804'), pg_temp.u8('000107189521'), s, 'course', null, null, 1, org);
    insert into public.learning_path_step_completions (organization_id, path_id, course_id, user_id, attempt_id,
                                                       rule_pass_required)
    values (org, pp, pa, s, pg_temp.u8('000107189804'), false);
    perform pg_temp.prev8(pg_temp.u8('000107189805'), pg_temp.u8('000107189521'), s, 'course', null, null, 1, org);
    insert into public.attempt_requests (id, organization_id, course_id, user_id, status, source, decided_at,
                                         context_kind, used_at, used_attempt_id)
    values (pg_temp.u8('000107189402'), org, pa, t, 'approved', 'bulk', now(), 'individual', now(),
            pg_temp.u8('000107189805'));
    perform pg_temp.prev8(pg_temp.u8('000107189806'), pg_temp.u8('000107189521'), s, 'course', null, null, 1, org);
    insert into public.revision_visits (organization_id, user_id, course_id, course_version_id, attempt_id, launch_kind)
    values (org, s, pa, pg_temp.u8('000107189521'), pg_temp.u8('000107189806'), 'scorm12');
    perform pg_temp.prev8(pg_temp.u8('000107189807'), pg_temp.u8('000107189521'), s, 'journey_run',
                          pg_temp.u8('000107189102'), pg_temp.u8('000107189711'), 1, org);
    insert into public.xp_events (organization_id, user_id, rule, xp, attempt_id, dedupe_key)
    values (org, s, 'adjustment', 0, pg_temp.u8('000107189807'), 'assert-0107w-breach-b7');

    -- a run scope: the clean K3 goes, B1 and its run R1 stay
    got := pg_temp.purge8('{"run_id": "00000000-0000-0000-0000-000107189101"}');
    if got is distinct from 'left 9001,9002,9004,9005,9006 runs 9101,9102,9103 | counts {"state": 0, "total": 1, '
                            || '"outbox": 0, "attempts": 1, "sessions": 0, "test_runs": 0, "statements": 0, '
                            || '"launch_tokens": 0} | excluded 1 | same=t | log manual/0009/1/0' then
      bad := bad || format('a run with a clean and a set-aside attempt: %s', got);
    end if;
    -- the product deletes find their breach
    dry := public.purge_preview_data(org, jsonb_build_object('learning_path_id', pp), 'product_delete', act, true);
    if dry ->> 'excluded' <> '1' or (dry #>> '{counts,attempts}') <> '0' then
      bad := bad || format('the path product delete''s dry run: %s (expected B1 excluded)', dry);
    end if;
    dry := public.purge_preview_data(org, '{"journey_program_id": "00000000-0000-0000-0000-000107189701"}',
                                     'product_delete', act, true);
    if dry ->> 'excluded' <> '1' or (dry #>> '{counts,attempts}') <> '1' then
      bad := bad || format('the program product delete''s dry run: %s (expected K4 and B7 excluded)', dry);
    end if;
    -- the organisation: each set-aside attempt with its table
    dry := public.purge_preview_data(org, '{"organization": true}', 'manual', act, true);
    select string_agg(format('%s:%s', right(e ->> 'attempt_id', 4), (e -> 'tables')->>0), ',' order by e ->> 'attempt_id')
      into got from jsonb_array_elements(dry -> 'excluded_attempts') e;
    if got is distinct from '9006:xp_events,9801:journey_day_progress,9802:completion_notices,'
                            || '9803:learning_path_completions,9804:learning_path_step_completions,'
                            || '9805:attempt_requests,9806:revision_visits,9807:xp_events' then
      bad := bad || format('the set-aside attempts and their tables: %s', got);
    end if;
    k0 := pg_temp.kept8();
    perform public.purge_preview_data(org, '{"organization": true}', 'manual', act, false, dry ->> 'selection_hash');
    if pg_temp.kept8() <> k0
       or (select count(*) from public.course_attempts c where c.id::text like '%-00010718980_') <> 7 then
      bad := bad || 'the organisation''s purge deleted a set-aside attempt or changed an official row'::text;
    end if;
    -- case (8): the cascades pass over the test runs that are left
    st := pg_temp.state8('delete from auth.users where id = ''' || s || '''');
    if st <> 'ok' then
      bad := bad || format('the tester''s delete over test runs: %s', st);
    end if;
    -- the organisation's delete, on an organisation of its own (Org Q: a
    -- course, a path, a test run with its attempt and a statement, no points
    -- row, because a cascade re-checks the attempt key of points rows this
    -- transaction inserted), with the service role, as the e2e purge
    -- deletes an organisation (on any other session the delete guards refuse
    -- the courses' cascade)
    insert into public.organizations (id, name, slug)
    values (pg_temp.u8('000107189950'), 'Org Q (0107 writer)', 'org-q-0107w');
    insert into public.courses (id, organization_id, title, slug)
    values (pg_temp.u8('000107189951'), pg_temp.u8('000107189950'), 'Q1 (0107 writer)', 'q1-0107w');
    insert into public.course_packages (id, course_id, language, is_active)
    values (pg_temp.u8('000107189952'), pg_temp.u8('000107189951'), null, true);
    insert into public.course_versions (id, course_id, package_id, version_number, manifest_type, launch_url,
                                        storage_prefix, manifest_data)
    values (pg_temp.u8('000107189953'), pg_temp.u8('000107189951'), pg_temp.u8('000107189952'), 1, 'scorm12',
            'index.html', 'courses/q1-0107w/v1/', '{"title":"0107 writer"}');
    insert into public.learning_paths (id, organization_id, name, slug, is_active, visibility)
    values (pg_temp.u8('000107189954'), pg_temp.u8('000107189950'), 'PQ1 (0107 writer)', 'pq1-0107w', true, 'private');
    insert into public.preview_runs (id, organization_id, user_id, kind, learning_path_id)
    values (pg_temp.u8('000107189955'), pg_temp.u8('000107189950'), t, 'path', pg_temp.u8('000107189954'));
    perform pg_temp.prev8(pg_temp.u8('000107189956'), pg_temp.u8('000107189953'), t, 'path_run',
                          pg_temp.u8('000107189955'), null, 1, pg_temp.u8('000107189950'));
    insert into public.xapi_statements (attempt_id, statement_id, verb, raw)
    values (pg_temp.u8('000107189956'), gen_random_uuid(), 'completed', '{}');
    st := pg_temp.state8('delete from public.organizations where id = ''00000000-0000-0000-0000-000107189950''',
                         '{"role": "service_role"}');
    if st <> 'ok' then
      bad := bad || format('the organisation''s delete over a test run: %s', st);
    end if;
    raise exception using errcode = 'R0107', message = 'assert-0107: undo';
  exception when others then
    if sqlstate <> 'R0107' then
      bad := bad || format('error %s: %s', sqlstate, sqlerrm);
    end if;
  end;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107: (40) %', array_to_string(bad, '; ');
  end if;
end
$$;

-- the organisation's scope, kept: the audit row, the excluded breach, the
-- rows flagged by role and every official row untouched; then the course
-- whose only attempts were new-kind previews deletes on a session, and a
-- path that held only a test run deletes
do $$
declare
  bad  text[] := '{}';
  org  constant uuid := '00000000-0000-0000-0000-000107189900';
  act  constant uuid := '00000000-0000-0000-0000-000107180009';
  k0   text;
  dry  jsonb;
  v_real jsonb;
  lg   record;
  st   text;
begin
  k0 := pg_temp.kept8();
  dry := public.purge_preview_data(org, '{"organization": true}', 'manual', act, true);
  v_real := public.purge_preview_data(org, '{"organization": true}', 'manual', act, false, dry ->> 'selection_hash');
  if pg_temp.kept8() <> k0 then
    bad := bad || 'a row that is not new-kind preview data changed'::text;
  end if;
  if (select count(*) from public.course_attempts c where c.preview_kind = 'legacy_role'
        and c.id::text like '%-00010718920_') <> 4 then
    bad := bad || 'a row flagged by role was deleted'::text;
  end if;
  select * into lg from public.preview_purge_log l where l.id = (v_real ->> 'log_id')::uuid;
  if lg.id is null or lg.actor_user_id <> act or lg.reason <> 'manual' or lg.counts <> (dry -> 'counts')
     or lg.ran_at is null or lg.scope <> '{"organization": true}'::jsonb
     or lg.excluded <> '[{"attempt_id": "00000000-0000-0000-0000-000107189006", "tables": ["xp_events"]}]'::jsonb
     or (select string_agg(right(x::text, 4), ',' order by x) from unnest(lg.attempt_ids) x) <> '9001,9002,9003,9004,9005'
     or (select string_agg(right(x::text, 4), ',' order by x) from unnest(lg.run_ids) x) <> '9101,9102,9103' then
    bad := bad || format('the audit row: %s', to_jsonb(lg));
  end if;
  if exists (select 1 from public.lrs_forward_outbox o where o.attempt_id = pg_temp.u8('000107189001'))
     or exists (select 1 from public.learning_sessions s where s.attempt_id = pg_temp.u8('000107189001'))
     or exists (select 1 from public.xapi_state s where s.attempt_id = pg_temp.u8('000107189001')) then
    bad := bad || 'a child row of a deleted preview is left'::text;
  end if;
  if not exists (select 1 from public.xp_events e where e.attempt_id = pg_temp.u8('000107189006')) then
    bad := bad || 'the breach''s points row is gone'::text;
  end if;
  -- a dry run after it: nothing left but the breach, no log row
  dry := public.purge_preview_data(org, '{"organization": true}', 'manual', act, true);
  if (dry #>> '{counts,total}') <> '0' or dry ->> 'excluded' <> '1' then
    bad := bad || format('the dry run after the purge: %s', dry);
  end if;
  -- an empty selection still has a hash and a real call with it writes no
  -- audit row
  v_real := public.purge_preview_data(org, '{"user_id": "00000000-0000-0000-0000-000107180007"}', 'manual', act, false,
                                    (public.purge_preview_data(org, '{"user_id": "00000000-0000-0000-0000-000107180007"}',
                                                               'manual', act, true)) ->> 'selection_hash');
  if v_real -> 'log_id' <> 'null'::jsonb then
    bad := bad || 'a real call that deleted nothing wrote an audit row'::text;
  end if;
  -- path PQ held only a test run: after the purge it deletes on a session
  st := pg_temp.state8('delete from public.learning_paths where id = ''00000000-0000-0000-0000-000107189602''',
                       '{"role": "authenticated"}');
  if st <> 'ok' then
    bad := bad || format('a path whose test run was purged: %s (expected its delete to pass)', st);
  end if;
  -- the append-only audit
  if pg_temp.state8('update public.preview_purge_log set reason = ''manual''', '{"role": "service_role"}') <> 'P0001'
     or pg_temp.state8('delete from public.preview_purge_log', '{"role": "service_role"}') <> 'P0001' then
    bad := bad || 'the audit row can be changed or removed'::text;
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107: (40) %', array_to_string(bad, '; ');
  end if;
end
$$;

-- a course whose only attempts were new-kind previews: the product delete's
-- purge, then the course's delete on a session (the guard lets it through)
do $$
declare
  org  constant uuid := '00000000-0000-0000-0000-000107189900';
  act  constant uuid := '00000000-0000-0000-0000-000107180009';
  dry  jsonb;
  st   text;
begin
  insert into public.courses (id, organization_id, title, slug)
  values (pg_temp.u8('000107181005'), org, 'WE (0107 writer)', 'we-0107w');
  insert into public.course_packages (id, course_id, language, is_active)
  values (pg_temp.u8('000107181105'), pg_temp.u8('000107181005'), null, true);
  insert into public.course_versions (id, course_id, package_id, version_number, manifest_type, launch_url,
                                      storage_prefix, manifest_data)
  values (pg_temp.u8('000107181205'), pg_temp.u8('000107181005'), pg_temp.u8('000107181105'), 1, 'scorm12',
          'index.html', 'courses/we-0107w/v1/', '{"title":"0107 writer"}');
  perform pg_temp.prev8(pg_temp.u8('000107189011'), pg_temp.u8('000107181205'), pg_temp.u8('000107180001'),
                        'course', null, null, 0, '00000000-0000-0000-0000-000107189900');
  dry := public.purge_preview_data(org, jsonb_build_object('course_id', pg_temp.u8('000107181005')), 'product_delete',
                                   act, true);
  perform public.purge_preview_data(org, jsonb_build_object('course_id', pg_temp.u8('000107181005')), 'product_delete',
                                    act, false, dry ->> 'selection_hash');
  st := pg_temp.state8('delete from public.courses where id = ''00000000-0000-0000-0000-000107181005''',
                       '{"role": "authenticated"}');
  if st <> 'ok' or (dry #>> '{counts,attempts}') <> '1' then
    raise exception 'assert-0107: (40) a course whose previews were purged: % (expected its delete to pass), dry run %', st, dry;
  end if;
end
$$;

-- the API roles: a call as anon or authenticated raises 42501
create temporary table r0107w_roles (who text, got text);
grant all on pg_temp.r0107w_roles to anon, authenticated;
select set_config('request.jwt.claims', '{"role": "anon"}', true);
set local role anon;
insert into pg_temp.r0107w_roles
select 'anon', pg_temp.state8('select public.purge_preview_data(''00000000-0000-0000-0000-000107189900'', '
                              || '''{"organization": true}'', ''manual'', ''00000000-0000-0000-0000-000107180009'', true)',
                              '{"role": "anon"}');
reset role;
select set_config('request.jwt.claims', '{"role": "authenticated"}', true);
set local role authenticated;
insert into pg_temp.r0107w_roles
select 'authenticated', pg_temp.state8('select public.purge_preview_data(''00000000-0000-0000-0000-000107189900'', '
                                       || '''{"organization": true}'', ''manual'', ''00000000-0000-0000-0000-000107180009'', true)',
                                       '{"role": "authenticated"}');
insert into pg_temp.r0107w_roles
select 'authenticated, the writer', pg_temp.state8('select public.record_learning_activity(''00000000-0000-0000-0000-000107189301'')',
                                                   '{"role": "authenticated"}');
reset role;
select set_config('request.jwt.claims', '', true);
do $$
declare
  v text;
begin
  select string_agg(r.who || '=' || r.got, ', ' order by r.who) into v from pg_temp.r0107w_roles r;
  if v is distinct from 'anon=42501, authenticated=42501, authenticated, the writer=42501' then
    raise exception 'assert-0107: (40) as the API roles: % (expected 42501 each)', v;
  end if;
end
$$;
rollback to savepoint s40w;

rollback;
