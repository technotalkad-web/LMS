-- scripts/migration-rehearsal/assert-0107-plpgsql.sql
-- Scenarios "0105-0106-then-0107" and "0106-then-0105-then-0107" (after the
-- first paste and again after the second), "0107-refused-q8" and
-- "0107-refused-q2" (after the two pastes that follow the repair): what
-- section 6 of 0107_learning_contexts.sql (ADR 0024 section B, creation
-- order item 6) must have done for the functions this build holds beside
-- the day_ids trigger (which assert-0107.sql checks): the two delete guards
-- (step 7), record_revision_visit (step 11), consume_grant (step 10, note
-- N9), journey_save_days (step 92) and journey_repin_enrollments (steps 94,
-- 95 and 47). It runs after assert-0107-functions.sql, so the seed is read as
-- committed. The checks continue the numbering of the 0107 files:
--   (26) the objects: arguments, result, language, security, search_path,
--        no argument default, comments and the execute matrix; the guards'
--        stored bodies (legacy_role, the service-role return) and their two
--        0098 triggers still bound; the lock order of both consume_grant
--        forms, read on their stored bodies (one connection cannot race)
--   (27) the delete guards at work: rows flagged by role block a delete on
--        any session but the service role's; previews of the new kinds do
--        not; learner attempts still do
--   (28) record_revision_visit: the dedupe per (learner, course, context),
--        and the six-argument wrapper writes individual
--   (29) consume_grant in the Individual context through the eight-argument
--        wrapper, on the rows of seed.sql: assert-0103.sql's outcome matrix
--        (opened, used, retake_live, over a revision row, stands, stands
--        with the confirmation, stale, expired, unavailable, the 22023
--        consistency check, the course's pass rule), and the 0103 chain
--        query, filtered by context, as an oracle for
--        official_attempt_in_context on every context of every attempt
--   (30) consume_grant in the path and journey contexts: the grant's context
--        at the lock, the abandon and the insert per context, the live
--        retake on the retake row's own context (note N9), stands by the
--        step's rule and by the lenient journey rule (R14), the day id
--        through the wrapper and through the nine-argument form, and the
--        atomicity of a refused insert
--   (31) journey_save_days: moves, inserts and removals by identity, its
--        refusals, the old editor's upsert, and as the API roles (an admin
--        of the organisation, a learner, another organisation's admin,
--        anon)
--   (32) journey_repin_enrollments: the two forms and their refusals; step
--        63's re-pin cases (a) to (h) as far as this build reaches, each with
--        the dry run's counts equal to the real run's, no attempt or credit
--        row updated or deleted, and the credit state after; the credit of
--        a relaxed rule (its columns) and its negative controls (no
--        change, a day that inherits a pass-required course, a day whose
--        credit is only pending); late false in a progress journey and
--        before the counted date; a second real run writes nothing; one
--        call over three enrolments (re-pinned, kept and completed,
--        enrolled after the publish)
-- The fixture rows have ids whose last group starts 00010717. The whole file
-- is one transaction that ends in ROLLBACK; every case runs in its own
-- savepoint, rolled back to it, so no case sees another's writes. Every check
-- raises 'assert-0107: (n) …' on failure; the runner then reports the file
-- as failed and stops the scenario.
--
-- The real run of journey_repin_enrollments calls the completion core of
-- section 6 (6g), which writes the badge and the claim of each enrolment it
-- completes; assert-0107-writer.sql checks those writes, and step 63's
-- cases that need journey_record_completion (an open attempt that completes
-- after a re-pin).
--
-- PGlite runs as postgres. grants-0107.sql gave anon and authenticated
-- usage on public and select on every table; where (31) runs as
-- authenticated it also grants, in this transaction only, insert and update
-- on journey_days (Supabase's defaults give the API roles every table
-- privilege, and row-level security decides).
begin;

create function pg_temp.u7(p text) returns uuid language sql immutable as $$
  select ('00000000-0000-0000-0000-' || p)::uuid
$$;

-- One statement, undone: its SQLSTATE (ok when none), its message and, when
-- given, a probe read after it, both rolled back.
create function pg_temp.probe7(p_stmt text, p_claims text, p_probe text,
                               out state text, out msg text, out probe text)
language plpgsql as $$
begin
  begin
    perform set_config('request.jwt.claims', coalesce(p_claims, ''), true);
    execute p_stmt;
    if p_probe is not null then
      execute p_probe into probe;
    end if;
    raise exception using errcode = 'R0107', message = 'assert-0107: undo';
  exception when others then
    get stacked diagnostics state = returned_sqlstate, msg = message_text;
  end;
  perform set_config('request.jwt.claims', '', true);
  if state = 'R0107' then
    state := 'ok';
    msg := null;
  end if;
end
$$;

-- An approved grant (or another status) in a context
create function pg_temp.grant7(p_id uuid, p_user uuid, p_course uuid, p_kind text, p_path uuid, p_enr uuid,
                               p_day int, p_day_id uuid, p_decided timestamptz, p_override boolean default false,
                               p_status text default 'approved', p_used uuid default null) returns void
language sql as $$
  insert into public.attempt_requests
    (id, organization_id, course_id, user_id, status, source, decided_at, override_confirmed, context_kind,
     learning_path_id, journey_enrollment_id, journey_day, journey_day_id, used_at, used_attempt_id)
  select p_id, c.organization_id, p_course, p_user, p_status, 'bulk', p_decided, p_override, p_kind,
         p_path, p_enr, p_day, p_day_id, case when p_used is not null then now() end, p_used
    from public.courses c where c.id = p_course;
$$;

-- consume_grant through the eight-argument wrapper, with the course's
-- organisation; one line: outcome, the new row's id or '-', the abandoned ids
create function pg_temp.cg8(p_grant uuid, p_user uuid, p_course uuid, p_version uuid, p_path uuid, p_enr uuid,
                            p_day int) returns table (outcome text, attempt_id uuid, abandoned_ids uuid[])
language sql as $$
  select g.outcome, g.attempt_id, g.abandoned_ids
    from public.courses c
   cross join lateral public.consume_grant(p_grant, p_user, p_course, p_version, c.organization_id,
                                           p_path, p_enr, p_day) g
   where c.id = p_course;
$$;
create function pg_temp.cg9(p_grant uuid, p_user uuid, p_course uuid, p_version uuid, p_path uuid, p_enr uuid,
                            p_day int, p_day_id uuid) returns table (outcome text, attempt_id uuid, abandoned_ids uuid[])
language sql as $$
  select g.outcome, g.attempt_id, g.abandoned_ids
    from public.courses c
   cross join lateral public.consume_grant(p_grant, p_user, p_course, p_version, c.organization_id,
                                           p_path, p_enr, p_day, p_day_id) g
   where c.id = p_course;
$$;

-- the minute the note suffixes print
create function pg_temp.when7(p timestamptz) returns text language sql as $$
  select to_char(p at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC';
$$;

-- An attempt of the fixture world: p_res passed, failed, completed (no
-- verdict), in_progress, abandoned or revision; its context from its tags
create function pg_temp.att7(p_id uuid, p_version uuid, p_user uuid, p_res text, p_path uuid, p_enr uuid,
                             p_day int, p_day_id uuid, p_jver uuid, p_minutes int) returns uuid
language plpgsql as $$
declare
  v_st   timestamptz := now() - make_interval(mins => p_minutes);
  v_done boolean := p_res in ('passed', 'failed', 'completed');
begin
  insert into public.course_attempts (id, course_version_id, user_id, organization_id, status, completion_status,
                                      success_status, score, started_at, completed_at, context_kind, is_preview,
                                      is_revision, learning_path_id, journey_enrollment_id, journey_day,
                                      journey_day_id, journey_version_id, launch_mode)
  values (p_id, p_version, p_user, '00000000-0000-0000-0000-00000000000a',
          case when p_res = 'revision' then 'in_progress' else p_res end,
          case when v_done then 'completed' else 'in_progress' end,
          case p_res when 'passed' then 'passed' when 'failed' then 'failed' else 'unknown' end,
          case when v_done then 0.5 end, v_st, case when v_done then v_st + interval '1 minute' end,
          case when p_enr is not null then 'journey' when p_path is not null then 'path' else 'individual' end,
          false, p_res = 'revision', p_path, p_enr, p_day, p_day_id, p_jver, 'Normal');
  return p_id;
end
$$;

-- The 0103 chain query (0103:813-842), with context_key added to its
-- filter: the oracle for official_attempt_in_context in the 'first' policy
-- every course has (effective_attempt_policy answers constants)
create function pg_temp.chain7(p_user uuid, p_course uuid, p_key text) returns uuid language sql stable as $$
  with chain_rows as (
    select ca.id as row_id,
           ca.completed_at as row_completed,
           ca.started_at as row_started,
           exists (
             select 1 from public.attempt_requests ar3
              where ar3.used_attempt_id = ca.id and ar3.status = 'approved'
           ) as row_is_retake
      from public.course_attempts ca
      join public.course_versions cv on cv.id = ca.course_version_id
     where ca.user_id = p_user
       and cv.course_id = p_course
       and ca.context_key = p_key
       and ca.status <> 'abandoned'
       and not ca.is_revision
       and (ca.completion_status = 'completed' or ca.success_status = 'passed')
  ),
  first_base as (
    select cr.row_id
      from chain_rows cr
     where not cr.row_is_retake
     order by coalesce(cr.row_completed, cr.row_started), cr.row_started, cr.row_id
     limit 1
  )
  select cr.row_id
    from chain_rows cr
   where cr.row_is_retake
      or cr.row_id in (select fb.row_id from first_base fb)
   order by coalesce(cr.row_completed, cr.row_started) desc, cr.row_started desc, cr.row_id desc
   limit 1
$$;

-- journey_credit_state of one enrolment, as one line
create function pg_temp.jcs7(p_enr uuid) returns text language sql stable as $$
  select coalesce((
    select format('req=%s done=%s cred={%s} next=%s', s.required_days, s.credited_days,
                  array_to_string(s.credited, ','), coalesce(s.next_day::text, '-'))
      from public.journey_credit_state(array[p_enr]) s), 'none')
$$;

-- The rows of an enrolment that a publish must never change: its attempts
-- and its credits, as text (ordered by id)
create function pg_temp.rows7(p_enr uuid, p_what text) returns text language sql stable as $$
  select case p_what
    when 'attempts' then (select coalesce(string_agg(a::text, '|' order by a.id), '')
                            from public.course_attempts a where a.journey_enrollment_id = p_enr)
    else (select coalesce(string_agg(p::text, '|' order by p.id), '')
            from public.journey_day_progress p where p.enrollment_id = p_enr)
  end
$$;

-- ---------------------------------------------------------------------------
-- (26) the objects
-- ---------------------------------------------------------------------------
do $$
declare
  bad text[] := '{}';
  r   record;
  g   record;
  src text;
  p_ar int;
  p_fu1 int;
  p_je int;
  p_fu2 int;
begin
  for r in
    select * from (values
      ('public.guard_learner_history_course_versions()', '', 'trigger', true, 'svc', false),
      ('public.guard_learner_history_courses()', '', 'trigger', true, 'svc', false),
      ('public.record_revision_visit(uuid,uuid,uuid,uuid,uuid,text,text)',
       'p_org uuid, p_user uuid, p_course uuid, p_version uuid, p_attempt uuid, p_kind text, p_context_key text',
       'boolean', true, 'svc', true),
      ('public.record_revision_visit(uuid,uuid,uuid,uuid,uuid,text)',
       'p_org uuid, p_user uuid, p_course uuid, p_version uuid, p_attempt uuid, p_kind text',
       'boolean', true, 'svc', false),
      ('public.consume_grant(uuid,uuid,uuid,uuid,uuid,uuid,uuid,integer,uuid)',
       'p_grant_id uuid, p_user_id uuid, p_course_id uuid, p_version_id uuid, p_org_id uuid, p_learning_path_id uuid, '
       || 'p_journey_enrollment_id uuid, p_journey_day integer, p_journey_day_id uuid',
       'TABLE(outcome text, attempt_id uuid, abandoned_ids uuid[])', true, 'svc', true),
      ('public.consume_grant(uuid,uuid,uuid,uuid,uuid,uuid,uuid,integer)',
       'p_grant_id uuid, p_user_id uuid, p_course_id uuid, p_version_id uuid, p_org_id uuid, p_learning_path_id uuid, '
       || 'p_journey_enrollment_id uuid, p_journey_day integer',
       'TABLE(outcome text, attempt_id uuid, abandoned_ids uuid[])', true, 'svc', false),
      ('public.journey_save_days(uuid,jsonb)', 'p_program_id uuid, p_days jsonb', 'jsonb', false, 'auth', true),
      ('public.journey_repin_enrollments(uuid,uuid,jsonb,boolean)',
       'p_program_id uuid, p_version_id uuid, p_draft jsonb, p_dry_run boolean', 'jsonb', true, 'svc', true)
    ) as t(fn, args, result, secdef, grantees, commented)
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
    if g.lang <> 'plpgsql' or g.prosecdef <> r.secdef or g.pronargdefaults <> 0
       or g.proconfig is distinct from array['search_path=pg_catalog, public'] then
      bad := bad || format('%s: language %s, security definer %s, %s default(s), proconfig %s',
                           r.fn, g.lang, g.prosecdef, g.pronargdefaults, coalesce(g.proconfig::text, 'null'));
    end if;
    if r.commented and g.comment is null then
      bad := bad || format('%s has no comment', r.fn);
    end if;
    if has_function_privilege('public', r.fn, 'execute')
       or has_function_privilege('anon', r.fn, 'execute')
       or has_function_privilege('authenticated', r.fn, 'execute') <> (r.grantees = 'auth')
       or not has_function_privilege('service_role', r.fn, 'execute') then
      bad := bad || format('%s: execute public %s, anon %s, authenticated %s, service_role %s (expected %s)',
                           r.fn, has_function_privilege('public', r.fn, 'execute'),
                           has_function_privilege('anon', r.fn, 'execute'),
                           has_function_privilege('authenticated', r.fn, 'execute'),
                           has_function_privilege('service_role', r.fn, 'execute'),
                           case r.grantees when 'auth' then 'authenticated and service_role' else 'service_role only' end);
    end if;
  end loop;
  -- exactly these forms, no third
  for r in
    select * from (values ('consume_grant', 2), ('record_revision_visit', 2), ('journey_save_days', 1),
                          ('journey_repin_enrollments', 1), ('guard_learner_history_courses', 1),
                          ('guard_learner_history_course_versions', 1)) as t(name, n)
  loop
    if (select count(*) from pg_proc where proname = r.name and pronamespace = 'public'::regnamespace) <> r.n then
      bad := bad || format('public.%s has %s form(s) (expected %s)', r.name,
                           (select count(*) from pg_proc where proname = r.name and pronamespace = 'public'::regnamespace), r.n);
    end if;
  end loop;

  -- the guards: the stored bodies count rows flagged by role and keep the
  -- service-role return; the 0098 triggers are bound to them
  for r in select * from (values ('public.guard_learner_history_course_versions()'),
                                 ('public.guard_learner_history_courses()')) as t(fn)
  loop
    src := pg_get_functiondef(to_regprocedure(r.fn));
    if src not like '%(not a.is_preview or a.preview_kind = ''legacy_role'')%'
       or src not like '%if claim_role = ''service_role'' then%return old;%'
       or src not like '%raise exception ''learner_history_exists''%'
       or src not like '%ADR 0024%' then
      bad := bad || format('%s: the stored body is not the 0107 one', r.fn);
    end if;
  end loop;
  if not exists (select 1 from pg_trigger t
                  where t.tgrelid = 'public.course_versions'::regclass
                    and t.tgname = 'course_versions_guard_learner_history'
                    and t.tgfoid = to_regprocedure('public.guard_learner_history_course_versions()'))
     or not exists (select 1 from pg_trigger t
                     where t.tgrelid = 'public.courses'::regclass
                       and t.tgname = 'courses_guard_learner_history'
                       and t.tgfoid = to_regprocedure('public.guard_learner_history_courses()')) then
    bad := bad || 'a 0098 delete-guard trigger is not bound to its guard'::text;
  end if;

  -- the lock order of both consume_grant forms: the grant row (for update),
  -- then the enrolment row (for update)
  for r in select * from (values ('public.consume_grant(uuid,uuid,uuid,uuid,uuid,uuid,uuid,integer,uuid)'),
                                 ('public.consume_grant(uuid,uuid,uuid,uuid,uuid,uuid,uuid,integer)')) as t(fn)
  loop
    select p.prosrc into src from pg_proc p where p.oid = to_regprocedure(r.fn);
    p_ar := strpos(src, 'from public.attempt_requests ar');
    p_fu1 := p_ar + strpos(substr(src, p_ar + 1), 'for update');
    p_je := strpos(src, 'from public.journey_enrollments e');
    p_fu2 := p_je + strpos(substr(src, p_je + 1), 'for update');
    if p_ar = 0 or p_je = 0 or not (p_ar < p_fu1 and p_fu1 < p_je and p_je < p_fu2)
       or strpos(substr(src, p_ar, p_fu1 - p_ar), ';') > 0 or strpos(substr(src, p_je, p_fu2 - p_je), ';') > 0 then
      bad := bad || format('%s: the grant is not locked before the enrolment (%s, %s, %s, %s)',
                           r.fn, p_ar, p_fu1, p_je, p_fu2);
    end if;
  end loop;

  if cardinality(bad) > 0 then
    raise exception 'assert-0107: (26) %', array_to_string(bad, '; ');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- The fixture world (ids 00010717…), inside Org A: learners L1 to L4 and
-- L9, an admin of another organisation X; courses CA and CB (no pass
-- required) and CC (pass required), CA with two versions; path P7 (CA step
-- 1 with pass_required true over its course's false, CB step 2 inheriting,
-- CC step 3); program J7 with days D1 to D4 (CA, CB, CA, CC) and its
-- versions JV0 (day 1 CA with pass_required false) and JV1 (current, days
-- 1 to 4, day 1 with pass_required true); enrolment E7 of L2 on JV1.
-- ---------------------------------------------------------------------------
do $$
declare
  org constant uuid := '00000000-0000-0000-0000-00000000000a';
  i   int;
begin
  insert into public.organizations (id, name, slug) values (pg_temp.u7('000107170900'), 'Org X (0107 plpgsql)', 'org-x-0107p');
  for i in 1..4 loop
    insert into auth.users (id, email)
    values (pg_temp.u7('00010717000' || i), format('learner-%s-0107p@example.test', i));
    insert into public.organization_members (organization_id, user_id, role)
    values (org, pg_temp.u7('00010717000' || i), 'user');
  end loop;
  insert into auth.users (id, email) values (pg_temp.u7('000107170009'), 'admin-x-0107p@example.test');
  insert into public.organization_members (organization_id, user_id, role)
  values (pg_temp.u7('000107170900'), pg_temp.u7('000107170009'), 'admin');

  insert into public.courses (id, organization_id, title, slug, pass_required) values
    (pg_temp.u7('000107171001'), org, 'CA (0107 plpgsql)', 'ca-0107p', false),
    (pg_temp.u7('000107171002'), org, 'CB (0107 plpgsql)', 'cb-0107p', false),
    (pg_temp.u7('000107171003'), org, 'CC (0107 plpgsql)', 'cc-0107p', true);
  insert into public.course_packages (id, course_id, language, is_active) values
    (pg_temp.u7('000107171101'), pg_temp.u7('000107171001'), null, true),
    (pg_temp.u7('000107171102'), pg_temp.u7('000107171002'), null, true),
    (pg_temp.u7('000107171103'), pg_temp.u7('000107171003'), null, true);
  insert into public.course_versions (id, course_id, package_id, version_number, manifest_type, launch_url,
                                      storage_prefix, manifest_data) values
    (pg_temp.u7('000107171201'), pg_temp.u7('000107171001'), pg_temp.u7('000107171101'), 1, 'scorm12', 'index.html',
     'courses/ca-0107p/v1/', '{"title":"0107 plpgsql"}'),
    (pg_temp.u7('000107171202'), pg_temp.u7('000107171001'), pg_temp.u7('000107171101'), 2, 'scorm12', 'index.html',
     'courses/ca-0107p/v2/', '{"title":"0107 plpgsql"}'),
    (pg_temp.u7('000107171203'), pg_temp.u7('000107171002'), pg_temp.u7('000107171102'), 1, 'scorm12', 'index.html',
     'courses/cb-0107p/v1/', '{"title":"0107 plpgsql"}'),
    (pg_temp.u7('000107171204'), pg_temp.u7('000107171003'), pg_temp.u7('000107171103'), 1, 'scorm12', 'index.html',
     'courses/cc-0107p/v1/', '{"title":"0107 plpgsql"}');

  insert into public.learning_paths (id, organization_id, name, slug, is_active, visibility)
  values (pg_temp.u7('000107172001'), org, 'P7 (0107 plpgsql)', 'p7-0107p', true, 'private');
  insert into public.learning_path_courses (path_id, course_id, step_number, pass_required) values
    (pg_temp.u7('000107172001'), pg_temp.u7('000107171001'), 1, true),
    (pg_temp.u7('000107172001'), pg_temp.u7('000107171002'), 2, null),
    (pg_temp.u7('000107172001'), pg_temp.u7('000107171003'), 3, null);

  insert into public.journey_programs (id, organization_id, name, days_total)
  values (pg_temp.u7('000107173001'), org, 'J7 (0107 plpgsql)', 4);
  insert into public.journey_days (id, program_id, organization_id, day_number, course_id) values
    (pg_temp.u7('000107173101'), pg_temp.u7('000107173001'), org, 1, pg_temp.u7('000107171001')),
    (pg_temp.u7('000107173102'), pg_temp.u7('000107173001'), org, 2, pg_temp.u7('000107171002')),
    (pg_temp.u7('000107173103'), pg_temp.u7('000107173001'), org, 3, pg_temp.u7('000107171001')),
    (pg_temp.u7('000107173104'), pg_temp.u7('000107173001'), org, 4, pg_temp.u7('000107171003'));
  insert into public.journey_versions (id, program_id, organization_id, version_number, name, days_total,
                                       count_sundays, completion_title, days, day_ids, day_ids_source) values
    (pg_temp.u7('000107173300'), pg_temp.u7('000107173001'), org, 1, 'J7 (0107 plpgsql)', 1, true, 'Done',
     jsonb_build_array(jsonb_build_object('day', 1, 'course_id', pg_temp.u7('000107171001')::text,
                                          'mission_title', null, 'pass_required', false)),
     jsonb_build_object('1', pg_temp.u7('000107173101')::text), 'editor'),
    (pg_temp.u7('000107173301'), pg_temp.u7('000107173001'), org, 2, 'J7 (0107 plpgsql)', 4, true, 'Done',
     jsonb_build_array(
       jsonb_build_object('day', 1, 'course_id', pg_temp.u7('000107171001')::text, 'mission_title', null,
                          'pass_required', true),
       jsonb_build_object('day', 2, 'course_id', pg_temp.u7('000107171002')::text, 'mission_title', null),
       jsonb_build_object('day', 3, 'course_id', pg_temp.u7('000107171001')::text, 'mission_title', null),
       jsonb_build_object('day', 4, 'course_id', pg_temp.u7('000107171003')::text, 'mission_title', null)),
     jsonb_build_object('1', pg_temp.u7('000107173101')::text, '2', pg_temp.u7('000107173102')::text,
                        '3', pg_temp.u7('000107173103')::text, '4', pg_temp.u7('000107173104')::text), 'editor');
  update public.journey_programs set current_version_id = pg_temp.u7('000107173301')
   where id = pg_temp.u7('000107173001');
  insert into public.journey_enrollments (id, program_id, version_id, organization_id, user_id, start_date, status)
  values (pg_temp.u7('000107173401'), pg_temp.u7('000107173001'), pg_temp.u7('000107173301'), org,
          pg_temp.u7('000107170002'), current_date - 10, 'active');
end
$$;

-- ---------------------------------------------------------------------------
-- (27) the delete guards at work. Courses G1 (one row flagged by role, a
--      legacy_role preview), G2 (one course preview, preview_kind course)
--      and G3 (one learner attempt), each with one version. On a session
--      that is not the service role's, a delete of G1 or of its version is
--      refused with learner_history_exists (the detail counts the row, the
--      hint names ADR 0024), and so is the same delete with no claim (the
--      SQL editor); with the service-role claim it passes and the row goes
--      with the course. G2 deletes on any session, its preview with it. G3
--      is refused as before (control).
-- ---------------------------------------------------------------------------
savepoint s27;
do $$
declare
  bad text[] := '{}';
  r   record;
  t   record;
  org constant uuid := '00000000-0000-0000-0000-00000000000a';
  i   int;
begin
  for i in 1..3 loop
    insert into public.courses (id, organization_id, title, slug)
    values (pg_temp.u7('00010717500' || i), org, format('G%s (0107 plpgsql)', i), format('g%s-0107p', i));
    insert into public.course_packages (id, course_id, language, is_active)
    values (pg_temp.u7('00010717510' || i), pg_temp.u7('00010717500' || i), null, true);
    insert into public.course_versions (id, course_id, package_id, version_number, manifest_type, launch_url,
                                        storage_prefix, manifest_data)
    values (pg_temp.u7('00010717520' || i), pg_temp.u7('00010717500' || i), pg_temp.u7('00010717510' || i), 1,
            'scorm12', 'index.html', format('courses/g%s-0107p/v1/', i), '{"title":"0107 plpgsql"}');
  end loop;
  insert into public.course_attempts (id, course_version_id, user_id, organization_id, status, completion_status,
                                      success_status, started_at, completed_at, context_kind, is_preview,
                                      preview_kind, launch_mode) values
    (pg_temp.u7('000107175301'), pg_temp.u7('000107175201'), '00000000-0000-0000-0000-000107010006', org,
     'completed', 'completed', 'unknown', now() - interval '1 hour', now(), 'preview', true, 'legacy_role', 'Normal'),
    (pg_temp.u7('000107175302'), pg_temp.u7('000107175202'), '00000000-0000-0000-0000-000107010006', org,
     'completed', 'completed', 'unknown', now() - interval '1 hour', now(), 'preview', true, 'course', 'Normal'),
    (pg_temp.u7('000107175303'), pg_temp.u7('000107175203'), pg_temp.u7('000107170001'), org,
     'completed', 'completed', 'unknown', now() - interval '1 hour', now(), 'individual', false, null, 'Normal');

  for r in
    select * from (values
      ('G1 (by role) on a session', 'delete from public.courses where id = ''00000000-0000-0000-0000-000107175001''',
       '{"role": "authenticated"}', 'P0001 learner_history_exists'),
      ('G1''s version on a session', 'delete from public.course_versions where id = ''00000000-0000-0000-0000-000107175201''',
       '{"role": "authenticated"}', 'P0001 learner_history_exists'),
      ('G1 with no claim (the SQL editor)', 'delete from public.courses where id = ''00000000-0000-0000-0000-000107175001''',
       null, 'P0001 learner_history_exists'),
      ('G1 for the service role', 'delete from public.courses where id = ''00000000-0000-0000-0000-000107175001''',
       '{"role": "service_role"}', 'ok 2'),
      ('G2 (a course preview) on a session', 'delete from public.courses where id = ''00000000-0000-0000-0000-000107175002''',
       '{"role": "authenticated"}', 'ok 2'),
      ('G2''s version on a session', 'delete from public.course_versions where id = ''00000000-0000-0000-0000-000107175202''',
       '{"role": "authenticated"}', 'ok 2'),
      ('G3 (a learner attempt) on a session (control)',
       'delete from public.courses where id = ''00000000-0000-0000-0000-000107175003''',
       '{"role": "authenticated"}', 'P0001 learner_history_exists')
    ) as v(what, stmt, claims, expected)
  loop
    -- the probe: how many of the three attempts are left after the delete
    select * into t from pg_temp.probe7(r.stmt, r.claims,
      'select count(*)::text from public.course_attempts where id in (''00000000-0000-0000-0000-000107175301'', '
      || '''00000000-0000-0000-0000-000107175302'', ''00000000-0000-0000-0000-000107175303'')');
    if t.state || ' ' || coalesce(case when t.state = 'P0001' then t.msg end, coalesce(t.probe, '-'))
       <> r.expected then
      bad := bad || format('%s: %s %s, probe %s (expected %s)', r.what, t.state, coalesce(t.msg, ''),
                           coalesce(t.probe, 'null'), r.expected);
    end if;
  end loop;

  -- the refusal's detail and hint
  begin
    perform set_config('request.jwt.claims', '{"role": "authenticated"}', true);
    delete from public.courses where id = pg_temp.u7('000107175001');
    bad := bad || 'G1 deleted on a session'::text;
  exception when others then
    declare
      v_detail text;
      v_hint   text;
    begin
      get stacked diagnostics v_detail = pg_exception_detail, v_hint = pg_exception_hint;
      if v_detail not like '%holds 1 learner attempt(s)%' or v_hint not like '%ADR 0024%' then
        bad := bad || format('G1''s refusal: detail %s, hint %s', v_detail, v_hint);
      end if;
    end;
  end;
  perform set_config('request.jwt.claims', '', true);
  if (select count(*) from public.course_attempts
       where id in (pg_temp.u7('000107175301'), pg_temp.u7('000107175302'), pg_temp.u7('000107175303'))) <> 3 then
    bad := bad || 'a probe of (27) was not undone'::text;
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107: (27) %', array_to_string(bad, '; ');
  end if;
end
$$;
rollback to savepoint s27;

-- ---------------------------------------------------------------------------
-- (28) record_revision_visit: per (learner, course, context) within 10
--      seconds. L1 on CA: path:P7 (true), path:P7 again (false), individual
--      (true: another context), the six-argument form (false: it writes
--      individual), the six-argument form on CB (true, row individual), a
--      visit of another path (true); a null context raises 23502 and writes
--      nothing; a visit older than 10 seconds does not deduplicate.
-- ---------------------------------------------------------------------------
savepoint s28;
do $$
declare
  bad  text[] := '{}';
  got  text := '';
  org  constant uuid := '00000000-0000-0000-0000-00000000000a';
  l1   constant uuid := '00000000-0000-0000-0000-000107170001';
  ca   constant uuid := '00000000-0000-0000-0000-000107171001';
  cb   constant uuid := '00000000-0000-0000-0000-000107171002';
  va1  constant uuid := '00000000-0000-0000-0000-000107171201';
  p7   constant text := 'path:00000000-0000-0000-0000-000107172001';
  st   text := 'no error';
begin
  got := got || public.record_revision_visit(org, l1, ca, va1, null, 'scorm12', p7)::text || ' ';
  got := got || public.record_revision_visit(org, l1, ca, va1, null, 'scorm12', p7)::text || ' ';
  got := got || public.record_revision_visit(org, l1, ca, va1, null, 'scorm12', 'individual')::text || ' ';
  got := got || public.record_revision_visit(org, l1, ca, va1, null, 'scorm12')::text || ' ';
  got := got || public.record_revision_visit(org, l1, cb, null, null, 'scorm12')::text || ' ';
  got := got || public.record_revision_visit(org, l1, ca, va1, null, 'scorm12',
                                             'path:00000000-0000-0000-0000-000107179999')::text;
  if got <> 'true false true false true true' then
    bad := bad || format('the six calls answered %s (expected true false true false true true)', got);
  end if;
  if (select string_agg(v.context_key || '/' || right(v.course_id::text, 4), ',' order by v.context_key, v.course_id)
        from public.revision_visits v where v.user_id = l1)
     is distinct from 'individual/1001,individual/1002,' || p7 || '/1001,path:00000000-0000-0000-0000-000107179999/1001' then
    bad := bad || format('the visit rows read %s', (select string_agg(v.context_key || '/' || right(v.course_id::text, 4), ','
                                                                       order by v.context_key, v.course_id)
                                                     from public.revision_visits v where v.user_id = l1));
  end if;
  begin
    perform public.record_revision_visit(org, l1, cb, null, null, 'scorm12', null);
  exception when others then
    st := sqlstate;
  end;
  if st <> '23502' or (select count(*) from public.revision_visits where user_id = l1) <> 4 then
    bad := bad || format('a null context: %s (expected 23502, nothing written)', st);
  end if;
  update public.revision_visits set launched_at = now() - interval '11 seconds' where user_id = l1;
  if public.record_revision_visit(org, l1, ca, va1, null, 'scorm12', p7) is distinct from true then
    bad := bad || 'a visit 11 seconds after the last in its context was deduplicated'::text;
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107: (28) %', array_to_string(bad, '; ');
  end if;
end
$$;
rollback to savepoint s28;

-- ---------------------------------------------------------------------------
-- (29) consume_grant, Individual, through the eight-argument wrapper, on the
--      rows of seed.sql (assert-0103.sql (7) and (8), the cases of learner
--      a1: f1 open on e2 of c1, f3 completed with no verdict on e3 of c2;
--      a2's rows are previews flagged by role since 0100, so a2 holds no
--      official result). Then the chain oracle.
-- ---------------------------------------------------------------------------
-- opened, used, retake_live
savepoint s29a;
select pg_temp.grant7('00000000-0000-0000-0000-000107176001', '00000000-0000-0000-0000-0000000000a1',
                      '00000000-0000-0000-0000-0000000000c1', 'individual', null, null, null, null, now());
do $$
declare
  g record;
  a record;
  q record;
begin
  select * into g from pg_temp.cg8('00000000-0000-0000-0000-000107176001', '00000000-0000-0000-0000-0000000000a1',
                                   '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1',
                                   null, null, null);
  if g.outcome is distinct from 'opened' or g.attempt_id is null
     or g.abandoned_ids is distinct from array['00000000-0000-0000-0000-0000000000f1'::uuid]
     or (select status from public.course_attempts where id = '00000000-0000-0000-0000-0000000000f1') <> 'abandoned' then
    raise exception 'assert-0107: (29) opened: % % % (expected opened, a new id, {f1} abandoned)',
      g.outcome, g.attempt_id, g.abandoned_ids;
  end if;
  select * into a from public.course_attempts where id = g.attempt_id;
  if a.course_version_id is distinct from '00000000-0000-0000-0000-0000000000e1'::uuid
     or a.status is distinct from 'in_progress' or a.is_revision or a.cmi_data is distinct from '{}'::jsonb
     or a.context_kind is distinct from 'individual' or a.context_key is distinct from 'individual'
     or a.learning_path_id is not null or a.journey_enrollment_id is not null or a.journey_day is not null
     or a.journey_day_id is not null or a.journey_version_id is not null or a.is_preview then
    raise exception 'assert-0107: (29) opened: the new row is not a fresh Individual attempt on e1';
  end if;
  select * into q from public.attempt_requests where id = '00000000-0000-0000-0000-000107176001';
  if q.used_at is null or q.used_attempt_id is distinct from g.attempt_id or q.status <> 'approved' then
    raise exception 'assert-0107: (29) opened: the grant is not stamped used';
  end if;
  select * into g from pg_temp.cg8('00000000-0000-0000-0000-000107176001', '00000000-0000-0000-0000-0000000000a1',
                                   '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1',
                                   null, null, null);
  if g.outcome is distinct from 'used' or g.attempt_id is not null then
    raise exception 'assert-0107: (29) used: % (expected used)', g.outcome;
  end if;
  perform pg_temp.grant7('00000000-0000-0000-0000-000107176002', '00000000-0000-0000-0000-0000000000a1',
                         '00000000-0000-0000-0000-0000000000c1', 'individual', null, null, null, null, now());
  select * into g from pg_temp.cg8('00000000-0000-0000-0000-000107176002', '00000000-0000-0000-0000-0000000000a1',
                                   '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e1',
                                   null, null, null);
  select * into q from public.attempt_requests where id = '00000000-0000-0000-0000-000107176002';
  if g.outcome is distinct from 'retake_live' or q.used_at is not null or q.decision_note is not null
     or (select status from public.course_attempts where id = a.id) <> 'in_progress' then
    raise exception 'assert-0107: (29) retake_live: % (expected retake_live, nothing written)', g.outcome;
  end if;
end
$$;
rollback to savepoint s29a;

-- opened over an open revision row (it is abandoned too)
savepoint s29b;
update public.course_attempts set is_revision = true where id = '00000000-0000-0000-0000-0000000000f1';
select pg_temp.grant7('00000000-0000-0000-0000-000107176003', '00000000-0000-0000-0000-0000000000a1',
                      '00000000-0000-0000-0000-0000000000c1', 'individual', null, null, null, null, now());
do $$
declare
  g record;
begin
  select * into g from pg_temp.cg8('00000000-0000-0000-0000-000107176003', '00000000-0000-0000-0000-0000000000a1',
                                   '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000e2',
                                   null, null, null);
  if g.outcome is distinct from 'opened' or g.abandoned_ids is distinct from array['00000000-0000-0000-0000-0000000000f1'::uuid]
     or (select is_revision from public.course_attempts where id = g.attempt_id) then
    raise exception 'assert-0107: (29) opened over a revision row: % %', g.outcome, g.abandoned_ids;
  end if;
end
$$;
rollback to savepoint s29b;

-- stands (f3: completed, no verdict, c2 requires no pass), with the note
-- suffix; with the post-pass confirmation, opened; stale; expired;
-- unavailable (pending, wrong learner, wrong course, unknown id, an expired
-- row); and c2 made pass-required: opened
savepoint s29c;
do $$
declare
  g   record;
  q   record;
  t3  timestamptz;
  got text := '';
  a1  constant uuid := '00000000-0000-0000-0000-0000000000a1';
  c1  constant uuid := '00000000-0000-0000-0000-0000000000c1';
  c2  constant uuid := '00000000-0000-0000-0000-0000000000c2';
  e1  constant uuid := '00000000-0000-0000-0000-0000000000e1';
  e3  constant uuid := '00000000-0000-0000-0000-0000000000e3';
begin
  select completed_at into t3 from public.course_attempts where id = '00000000-0000-0000-0000-0000000000f3';

  perform pg_temp.grant7(pg_temp.u7('000107176004'), a1, c2, 'individual', null, null, null, null, now());
  update public.attempt_requests set decision_note = 'approved in the rehearsal' where id = pg_temp.u7('000107176004');
  select * into g from pg_temp.cg8(pg_temp.u7('000107176004'), a1, c2, e3, null, null, null);
  select * into q from public.attempt_requests where id = pg_temp.u7('000107176004');
  if g.outcome is distinct from 'stands' or q.status <> 'expired' or q.used_at is not null
     or q.decision_note is distinct from 'approved in the rehearsal expired unused: the learner''s official result of '
          || pg_temp.when7(t3) || ' stands and this grant carries no post-pass confirmation' then
    raise exception 'assert-0107: (29) stands: % / % / %', g.outcome, q.status, q.decision_note;
  end if;

  perform pg_temp.grant7(pg_temp.u7('000107176005'), a1, c2, 'individual', null, null, null, null, now(), true);
  select * into g from pg_temp.cg8(pg_temp.u7('000107176005'), a1, c2, e3, null, null, null);
  if g.outcome is distinct from 'opened' or g.abandoned_ids is distinct from '{}'::uuid[] then
    raise exception 'assert-0107: (29) stands with override_confirmed: % % (expected opened, {})', g.outcome, g.abandoned_ids;
  end if;
end
$$;
rollback to savepoint s29c;
savepoint s29d;
do $$
declare
  g   record;
  q   record;
  t3  timestamptz;
  got text := '';
  o   text;
  a1  constant uuid := '00000000-0000-0000-0000-0000000000a1';
  a2  constant uuid := '00000000-0000-0000-0000-0000000000a2';
  c1  constant uuid := '00000000-0000-0000-0000-0000000000c1';
  c2  constant uuid := '00000000-0000-0000-0000-0000000000c2';
  e1  constant uuid := '00000000-0000-0000-0000-0000000000e1';
  e3  constant uuid := '00000000-0000-0000-0000-0000000000e3';
begin
  select completed_at into t3 from public.course_attempts where id = '00000000-0000-0000-0000-0000000000f3';
  -- stale: decided before f3
  perform pg_temp.grant7(pg_temp.u7('000107176006'), a1, c2, 'individual', null, null, null, null, t3 - interval '1 hour');
  select * into g from pg_temp.cg8(pg_temp.u7('000107176006'), a1, c2, e3, null, null, null);
  select * into q from public.attempt_requests where id = pg_temp.u7('000107176006');
  if g.outcome is distinct from 'stale' or q.status <> 'expired'
     or q.decision_note is distinct from 'expired unused: decided before the learner''s current official result of '
          || pg_temp.when7(t3) then
    raise exception 'assert-0107: (29) stale: % / %', g.outcome, q.decision_note;
  end if;
  -- expired: expires_at passed; the grant untouched, f1 open (then the
  -- grant is removed: it still holds the one open-request slot of (a1, c1,
  -- individual), ADR 0014 addendum note)
  perform pg_temp.grant7(pg_temp.u7('000107176007'), a1, c1, 'individual', null, null, null, null, now() - interval '31 days');
  update public.attempt_requests set expires_at = now() - interval '1 day' where id = pg_temp.u7('000107176007');
  select * into g from pg_temp.cg8(pg_temp.u7('000107176007'), a1, c1, e1, null, null, null);
  if g.outcome is distinct from 'expired'
     or (select status from public.attempt_requests where id = pg_temp.u7('000107176007')) <> 'approved'
     or (select status from public.course_attempts where id = '00000000-0000-0000-0000-0000000000f1') <> 'in_progress' then
    raise exception 'assert-0107: (29) expired: %', g.outcome;
  end if;
  delete from public.attempt_requests where id = pg_temp.u7('000107176007');
  -- unavailable: pending (then removed, for the same slot); wrong learner;
  -- wrong course; unknown id; an expired row
  perform pg_temp.grant7(pg_temp.u7('000107176008'), a1, c1, 'individual', null, null, null, null, null,
                         false, 'pending');
  select g2.outcome into o from pg_temp.cg8(pg_temp.u7('000107176008'), a1, c1, e1, null, null, null) g2;
  got := got || o || ' ';
  if (select status from public.attempt_requests where id = pg_temp.u7('000107176008')) <> 'pending' then
    raise exception 'assert-0107: (29) unavailable (pending): the request was written';
  end if;
  delete from public.attempt_requests where id = pg_temp.u7('000107176008');
  perform pg_temp.grant7(pg_temp.u7('000107176009'), a1, c1, 'individual', null, null, null, null, now());
  perform pg_temp.grant7(pg_temp.u7('000107176010'), a1, c2, 'individual', null, null, null, null, now(),
                         false, 'expired');
  select g2.outcome into o from pg_temp.cg8(pg_temp.u7('000107176009'), a2, c1, e1, null, null, null) g2;
  got := got || o || ' ';
  select g2.outcome into o from pg_temp.cg8(pg_temp.u7('000107176009'), a1, c2, e3, null, null, null) g2;
  got := got || o || ' ';
  select g2.outcome into o from pg_temp.cg8(gen_random_uuid(), a1, c1, e1, null, null, null) g2;
  got := got || o || ' ';
  select g2.outcome into o from pg_temp.cg8(pg_temp.u7('000107176010'), a1, c2, e3, null, null, null) g2;
  got := got || o;
  if got <> 'unavailable unavailable unavailable unavailable unavailable'
     or exists (select 1 from public.attempt_requests where id = pg_temp.u7('000107176009') and used_at is not null)
     or (select status from public.course_attempts where id = '00000000-0000-0000-0000-0000000000f1') <> 'in_progress' then
    raise exception 'assert-0107: (29) unavailable: % (or something was written)', got;
  end if;
end
$$;
rollback to savepoint s29d;

-- the consistency check: a version of another course or organisation, or a
-- null version or organisation, raises 22023 and writes nothing
savepoint s29e;
select pg_temp.grant7('00000000-0000-0000-0000-000107176011', '00000000-0000-0000-0000-0000000000a1',
                      '00000000-0000-0000-0000-0000000000c1', 'individual', null, null, null, null, now());
do $$
declare
  got  text;
  args text;
begin
  foreach args in array array[
    '''00000000-0000-0000-0000-0000000000e5'', ''00000000-0000-0000-0000-00000000000a''',
    '''00000000-0000-0000-0000-0000000000e3'', ''00000000-0000-0000-0000-00000000000a''',
    '''00000000-0000-0000-0000-0000000000e1'', ''00000000-0000-0000-0000-00000000000b''',
    'null, ''00000000-0000-0000-0000-00000000000a''',
    '''00000000-0000-0000-0000-0000000000e1'', null'
  ] loop
    got := 'no error';
    begin
      execute 'select * from public.consume_grant(''00000000-0000-0000-0000-000107176011'', '
        || '''00000000-0000-0000-0000-0000000000a1'', ''00000000-0000-0000-0000-0000000000c1'', '
        || args || ', null, null, null)';
    exception when others then
      got := sqlstate;
    end;
    if got <> '22023' then
      raise exception 'assert-0107: (29) consistency (%): % (expected 22023)', args, got;
    end if;
  end loop;
  if (select status from public.course_attempts where id = '00000000-0000-0000-0000-0000000000f1') <> 'in_progress'
     or exists (select 1 from public.attempt_requests where id = '00000000-0000-0000-0000-000107176011' and used_at is not null) then
    raise exception 'assert-0107: (29) consistency: something was written';
  end if;
end
$$;
rollback to savepoint s29e;

-- c2 made pass-required: f3 (no verdict) no longer stands
savepoint s29f;
update public.courses set pass_required = true where id = '00000000-0000-0000-0000-0000000000c2';
select pg_temp.grant7('00000000-0000-0000-0000-000107176012', '00000000-0000-0000-0000-0000000000a1',
                      '00000000-0000-0000-0000-0000000000c2', 'individual', null, null, null, null, now());
do $$
declare
  o text;
begin
  select g.outcome into o from pg_temp.cg8('00000000-0000-0000-0000-000107176012', '00000000-0000-0000-0000-0000000000a1',
                                           '00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000e3',
                                           null, null, null) g;
  if o is distinct from 'opened' then
    raise exception 'assert-0107: (29) pass_required on c2: % (expected opened)', o;
  end if;
end
$$;
rollback to savepoint s29f;

-- the oracle: on every (learner, course, context) that holds an attempt
-- that is not a preview, official_attempt_in_context equals the 0103 chain
-- query filtered by the context; then the same on a granted retake chain
-- (a completed failed retake after a base row: the retake is official)
do $$
declare
  n bigint;
  m bigint;
begin
  select count(*), count(*) filter (where public.official_attempt_in_context(k.user_id, k.course_id, k.context_key)
                                          is distinct from pg_temp.chain7(k.user_id, k.course_id, k.context_key))
    into n, m
    from (select distinct ca.user_id, cv.course_id, ca.context_key
            from public.course_attempts ca
            join public.course_versions cv on cv.id = ca.course_version_id
           where ca.context_kind <> 'preview') k;
  if m <> 0 or n < 10 then
    raise exception 'assert-0107: (29) official_attempt_in_context differs from the 0103 chain on % of % contexts', m, n;
  end if;
end
$$;
savepoint s29g;
do $$
declare
  t3 timestamptz;
  o  uuid;
begin
  select completed_at into t3 from public.course_attempts where id = '00000000-0000-0000-0000-0000000000f3';
  insert into public.course_attempts
    (id, course_version_id, user_id, organization_id, status, completion_status, success_status, score, started_at,
     completed_at, context_kind)
  values (pg_temp.u7('000107176101'), '00000000-0000-0000-0000-0000000000e4', '00000000-0000-0000-0000-0000000000a1',
          '00000000-0000-0000-0000-00000000000a', 'failed', 'completed', 'failed', 0.4, t3 + interval '1 hour',
          t3 + interval '2 hours', 'individual');
  perform pg_temp.grant7(pg_temp.u7('000107176013'), '00000000-0000-0000-0000-0000000000a1',
                         '00000000-0000-0000-0000-0000000000c2', 'individual', null, null, null, null,
                         t3 + interval '30 minutes', false, 'approved', pg_temp.u7('000107176101'));
  o := public.official_attempt_in_context('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c2',
                                          'individual');
  if o is distinct from pg_temp.u7('000107176101')
     or o is distinct from pg_temp.chain7('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c2',
                                          'individual') then
    raise exception 'assert-0107: (29) the retake chain: % (expected the completed retake, as the chain)', o;
  end if;
end
$$;
rollback to savepoint s29g;

-- ---------------------------------------------------------------------------
-- (30) consume_grant in the path and journey contexts (the fixture world)
-- ---------------------------------------------------------------------------
-- (a) a path grant through the wrapper: opened in path:P7, abandoning only
--     the open row of that context (L1's open Individual row on VA1 stays
--     open); the new row carries the path tag and no journey tag
savepoint s30a;
do $$
declare
  g  record;
  a  record;
  l1 constant uuid := '00000000-0000-0000-0000-000107170001';
  ca constant uuid := '00000000-0000-0000-0000-000107171001';
  p7 constant uuid := '00000000-0000-0000-0000-000107172001';
begin
  perform pg_temp.att7(pg_temp.u7('000107177001'), pg_temp.u7('000107171201'), l1, 'in_progress', null, null, null, null, null, 60);
  perform pg_temp.att7(pg_temp.u7('000107177002'), pg_temp.u7('000107171202'), l1, 'in_progress', p7, null, null, null, null, 50);
  perform pg_temp.grant7(pg_temp.u7('000107177101'), l1, ca, 'path', p7, null, null, null, now());
  select * into g from pg_temp.cg8(pg_temp.u7('000107177101'), l1, ca, pg_temp.u7('000107171201'), p7, null, null);
  select * into a from public.course_attempts where id = g.attempt_id;
  if g.outcome is distinct from 'opened' or g.abandoned_ids is distinct from array[pg_temp.u7('000107177002')]
     or (select status from public.course_attempts where id = pg_temp.u7('000107177001')) <> 'in_progress'
     or a.context_kind is distinct from 'path' or a.learning_path_id is distinct from p7
     or a.journey_enrollment_id is not null or a.journey_day is not null or a.journey_day_id is not null then
    raise exception 'assert-0107: (30a) a path grant: % % (expected opened, {the open path row}, a path row, the Individual row open)',
      g.outcome, g.abandoned_ids;
  end if;
end
$$;
rollback to savepoint s30a;

-- (b) the grant's context at the lock: an Individual grant called with the
--     path tag, a path grant called with no tag, and a path grant of
--     another path answer unavailable and write nothing
savepoint s30b;
do $$
declare
  got text := '';
  o   text;
  l1 constant uuid := '00000000-0000-0000-0000-000107170001';
  ca constant uuid := '00000000-0000-0000-0000-000107171001';
  p7 constant uuid := '00000000-0000-0000-0000-000107172001';
begin
  perform pg_temp.grant7(pg_temp.u7('000107177102'), l1, ca, 'individual', null, null, null, null, now());
  perform pg_temp.grant7(pg_temp.u7('000107177103'), l1, ca, 'path', p7, null, null, null, now());
  select g.outcome into o from pg_temp.cg8(pg_temp.u7('000107177102'), l1, ca, pg_temp.u7('000107171201'), p7, null, null) g;
  got := got || o || ' ';
  select g.outcome into o from pg_temp.cg8(pg_temp.u7('000107177103'), l1, ca, pg_temp.u7('000107171201'), null, null, null) g;
  got := got || o || ' ';
  select g.outcome into o from pg_temp.cg8(pg_temp.u7('000107177103'), l1, ca, pg_temp.u7('000107171201'),
                                           '00000000-0000-0000-0000-000107120101', null, null) g;
  got := got || o;
  if got <> 'unavailable unavailable unavailable'
     or exists (select 1 from public.attempt_requests where id in (pg_temp.u7('000107177102'), pg_temp.u7('000107177103'))
                  and (used_at is not null or status <> 'approved'))
     or exists (select 1 from public.course_attempts where user_id = l1) then
    raise exception 'assert-0107: (30b) the context at the lock: % (expected unavailable three times, nothing written)', got;
  end if;
end
$$;
rollback to savepoint s30b;

-- (c) note N9: an open legacy path retake R (path:P7) whose grant reads
--     individual. A second path grant answers retake_live and abandons
--     nothing; an Individual grant does not see R as live in its context,
--     opens an Individual row and leaves R open
savepoint s30c;
do $$
declare
  g  record;
  l1 constant uuid := '00000000-0000-0000-0000-000107170001';
  ca constant uuid := '00000000-0000-0000-0000-000107171001';
  p7 constant uuid := '00000000-0000-0000-0000-000107172001';
begin
  perform pg_temp.att7(pg_temp.u7('000107177003'), pg_temp.u7('000107171201'), l1, 'in_progress', p7, null, null, null, null, 30);
  perform pg_temp.grant7(pg_temp.u7('000107177104'), l1, ca, 'individual', null, null, null, null,
                         now() - interval '1 hour', false, 'approved', pg_temp.u7('000107177003'));
  perform pg_temp.grant7(pg_temp.u7('000107177105'), l1, ca, 'path', p7, null, null, null, now());
  select * into g from pg_temp.cg8(pg_temp.u7('000107177105'), l1, ca, pg_temp.u7('000107171201'), p7, null, null);
  if g.outcome is distinct from 'retake_live' or g.abandoned_ids is distinct from '{}'::uuid[]
     or (select status from public.course_attempts where id = pg_temp.u7('000107177003')) <> 'in_progress'
     or (select used_at from public.attempt_requests where id = pg_temp.u7('000107177105')) is not null then
    raise exception 'assert-0107: (30c) a second path grant over a legacy path retake: % % (expected retake_live, nothing written)',
      g.outcome, g.abandoned_ids;
  end if;
  perform pg_temp.grant7(pg_temp.u7('000107177106'), l1, ca, 'individual', null, null, null, null, now());
  select * into g from pg_temp.cg8(pg_temp.u7('000107177106'), l1, ca, pg_temp.u7('000107171202'), null, null, null);
  if g.outcome is distinct from 'opened' or g.abandoned_ids is distinct from '{}'::uuid[]
     or (select status from public.course_attempts where id = pg_temp.u7('000107177003')) <> 'in_progress'
     or (select context_kind from public.course_attempts where id = g.attempt_id) <> 'individual' then
    raise exception 'assert-0107: (30c) an Individual grant beside the path retake: % % (expected opened, {}, R open)',
      g.outcome, g.abandoned_ids;
  end if;
end
$$;
rollback to savepoint s30c;

-- (d) stands by the context's rule: L3's official path row on CA (step 1,
--     pass required) is completed with no verdict, so a path grant opens;
--     L3's Individual row on CA (the course requires no pass) stands
savepoint s30d;
do $$
declare
  o1 text;
  o2 text;
  l3 constant uuid := '00000000-0000-0000-0000-000107170003';
  ca constant uuid := '00000000-0000-0000-0000-000107171001';
  p7 constant uuid := '00000000-0000-0000-0000-000107172001';
begin
  perform pg_temp.att7(pg_temp.u7('000107177004'), pg_temp.u7('000107171201'), l3, 'completed', p7, null, null, null, null, 300);
  perform pg_temp.att7(pg_temp.u7('000107177005'), pg_temp.u7('000107171201'), l3, 'completed', null, null, null, null, null, 200);
  perform pg_temp.grant7(pg_temp.u7('000107177107'), l3, ca, 'path', p7, null, null, null, now());
  perform pg_temp.grant7(pg_temp.u7('000107177108'), l3, ca, 'individual', null, null, null, null, now());
  select g.outcome into o1 from pg_temp.cg8(pg_temp.u7('000107177107'), l3, ca, pg_temp.u7('000107171201'), p7, null, null) g;
  select g.outcome into o2 from pg_temp.cg8(pg_temp.u7('000107177108'), l3, ca, pg_temp.u7('000107171201'), null, null, null) g;
  if o1 is distinct from 'opened' or o2 is distinct from 'stands' then
    raise exception 'assert-0107: (30d) path step pass-required %, Individual %, (expected opened, stands)', o1, o2;
  end if;
end
$$;
rollback to savepoint s30d;

-- (e) a journey grant through the wrapper: E7, day 2 by number, a path tag
--     sent beside it; the day id is resolved through the pinned JV1 under
--     the enrolment's lock; the retake carries the journey tags, the day
--     id, the pinned version and no path tag. (f) the nine-argument form
--     with day D3 for a grant of D2: unavailable. (g) the wrapper with a
--     day JV1 does not map (9): unavailable. Nothing written by (f) or (g).
savepoint s30e;
do $$
declare
  g   record;
  a   record;
  got text := '';
  o   text;
  l2  constant uuid := '00000000-0000-0000-0000-000107170002';
  cb  constant uuid := '00000000-0000-0000-0000-000107171002';
  vb  constant uuid := '00000000-0000-0000-0000-000107171203';
  p7  constant uuid := '00000000-0000-0000-0000-000107172001';
  e7  constant uuid := '00000000-0000-0000-0000-000107173401';
  d2  constant uuid := '00000000-0000-0000-0000-000107173102';
  d3  constant uuid := '00000000-0000-0000-0000-000107173103';
begin
  perform pg_temp.grant7(pg_temp.u7('000107177109'), l2, cb, 'journey', null, e7, 2, d2, now());
  select g2.outcome into o from pg_temp.cg9(pg_temp.u7('000107177109'), l2, cb, vb, null, e7, 2, d3) g2;
  got := got || o || ' ';
  select g2.outcome into o from pg_temp.cg8(pg_temp.u7('000107177109'), l2, cb, vb, null, e7, 9) g2;
  got := got || o || ' ';
  select g2.outcome into o from pg_temp.cg9(pg_temp.u7('000107177109'), l2, cb, vb, null, e7, 2, null) g2;
  got := got || o;
  if got <> 'unavailable unavailable unavailable'
     or exists (select 1 from public.course_attempts where user_id = l2)
     or (select used_at from public.attempt_requests where id = pg_temp.u7('000107177109')) is not null then
    raise exception 'assert-0107: (30f, g) another day id, a day the pinned version does not map, no day id: % (expected unavailable three times, nothing written)', got;
  end if;
  select * into g from pg_temp.cg8(pg_temp.u7('000107177109'), l2, cb, vb, p7, e7, 2);
  select * into a from public.course_attempts where id = g.attempt_id;
  if g.outcome is distinct from 'opened' or a.context_kind is distinct from 'journey'
     or a.learning_path_id is not null or a.journey_enrollment_id is distinct from e7 or a.journey_day is distinct from 2
     or a.journey_day_id is distinct from d2 or a.journey_version_id is distinct from pg_temp.u7('000107173301')
     or a.context_key is distinct from 'journey:' || e7 || ':' || d2 then
    raise exception 'assert-0107: (30e) a journey grant through the wrapper: % (expected opened, a journey row of E7 on D2 pinned JV1, no path tag)',
      g.outcome;
  end if;
end
$$;
rollback to savepoint s30e;

-- (h) the lenient journey rule (R14): L2's official row on day 1 (CA)
--     completed with no verdict. JV1 (pinned) requires a pass on day 1;
--     launched under JV0, where day 1 requires none, it stands; with no
--     launched version it does not (opened); failed, it does not either
savepoint s30h;
do $$
declare
  got text := '';
  o   text;
  r   record;
  l2  constant uuid := '00000000-0000-0000-0000-000107170002';
  ca  constant uuid := '00000000-0000-0000-0000-000107171001';
  e7  constant uuid := '00000000-0000-0000-0000-000107173401';
  d1  constant uuid := '00000000-0000-0000-0000-000107173101';
begin
  for r in select * from (values (1, 'completed', '000107173300'), (2, 'completed', null), (3, 'failed', '000107173300'))
                            as t(n, res, jver)
  loop
    perform pg_temp.att7(pg_temp.u7('00010717702' || r.n), pg_temp.u7('000107171201'), l2, r.res, null, e7, 1, d1,
                         case when r.jver is not null then pg_temp.u7(r.jver) end, 100);
    perform pg_temp.grant7(pg_temp.u7('00010717712' || r.n), l2, ca, 'journey', null, e7, 1, d1, now());
    select g.outcome into o from pg_temp.cg9(pg_temp.u7('00010717712' || r.n), l2, ca, pg_temp.u7('000107171201'),
                                             null, e7, 1, d1) g;
    got := got || o || ' ';
    delete from public.attempt_requests where id = pg_temp.u7('00010717712' || r.n);
    delete from public.course_attempts where journey_enrollment_id = e7;
  end loop;
  if got <> 'stands opened opened ' then
    raise exception 'assert-0107: (30h) the lenient rule: % (expected stands opened opened)', got;
  end if;
end
$$;
rollback to savepoint s30h;

-- (i) atomicity: a journey call whose insert fails after the abandon (no
--     day number: the shape check, 23514) rolls the abandon back with it
--     and leaves the grant unused
savepoint s30i;
do $$
declare
  st text := 'no error';
  l2 constant uuid := '00000000-0000-0000-0000-000107170002';
  cb constant uuid := '00000000-0000-0000-0000-000107171002';
  e7 constant uuid := '00000000-0000-0000-0000-000107173401';
  d2 constant uuid := '00000000-0000-0000-0000-000107173102';
begin
  perform pg_temp.att7(pg_temp.u7('000107177030'), pg_temp.u7('000107171203'), l2, 'in_progress', null, e7, 2, d2,
                       pg_temp.u7('000107173301'), 40);
  perform pg_temp.grant7(pg_temp.u7('000107177130'), l2, cb, 'journey', null, e7, 2, d2, now());
  begin
    perform public.consume_grant(pg_temp.u7('000107177130'), l2, cb, pg_temp.u7('000107171203'),
                                 '00000000-0000-0000-0000-00000000000a', null, e7, null, d2);
  exception when others then
    st := sqlstate;
  end;
  if st <> '23514'
     or (select status from public.course_attempts where id = pg_temp.u7('000107177030')) <> 'in_progress'
     or (select count(*) from public.course_attempts where user_id = l2) <> 1
     or (select used_at from public.attempt_requests where id = pg_temp.u7('000107177130')) is not null then
    raise exception 'assert-0107: (30i) atomicity: % (expected 23514 and the abandon undone, the grant unused)', st;
  end if;
end
$$;
rollback to savepoint s30i;

-- ---------------------------------------------------------------------------
-- (31) journey_save_days. Program JS with days S1, S2, S3 (numbers 1 to 3;
--      CA, CB, CC). As postgres, in one savepoint, in order (spike 5): swap
--      S1 and S2 by identity; insert a day at 2 (later days shift); remove
--      S1 and move S3 from 4 to 3 (the inserted day keeps 2, unnamed); the
--      content is written (course, title, pass rule). The refusals, each
--      leaving the days as they were. The old editor's upsert on (program,
--      day number) still works. Then as the API roles.
-- ---------------------------------------------------------------------------
savepoint s31;
do $$
declare
  org constant uuid := '00000000-0000-0000-0000-00000000000a';
begin
  insert into public.journey_programs (id, organization_id, name, days_total)
  values (pg_temp.u7('000107174001'), org, 'JS (0107 plpgsql)', 3);
  insert into public.journey_days (id, program_id, organization_id, day_number, course_id) values
    (pg_temp.u7('000107174101'), pg_temp.u7('000107174001'), org, 1, pg_temp.u7('000107171001')),
    (pg_temp.u7('000107174102'), pg_temp.u7('000107174001'), org, 2, pg_temp.u7('000107171002')),
    (pg_temp.u7('000107174103'), pg_temp.u7('000107174001'), org, 3, pg_temp.u7('000107171003'));
  -- another program's day, for a refusal
  insert into public.journey_days (id, program_id, organization_id, day_number, course_id) values
    (pg_temp.u7('000107174109'), pg_temp.u7('000107173001'), org, 9, null);
end
$$;
create function pg_temp.days7() returns text language sql stable as $$
  select string_agg(case when d.id::text like '%00010717410_' then 'S' || right(d.id::text, 1) else 'new' end
                    || '=' || coalesce(d.day_number::text, '-') || case when d.removed_at is not null then 'r' else '' end,
                    ' ' order by d.day_number nulls last, d.id)
    from public.journey_days d where d.program_id = '00000000-0000-0000-0000-000107174001'
$$;
create function pg_temp.save7(p_days text) returns text language plpgsql as $$
declare
  got jsonb;
begin
  got := public.journey_save_days('00000000-0000-0000-0000-000107174001', p_days::jsonb);
  return got::text || ' ' || pg_temp.days7();
end
$$;
do $$
declare
  bad text[] := '{}';
  got text;
  r   record;
  t   record;
  s1  constant text := '"00000000-0000-0000-0000-000107174101"';
  s2  constant text := '"00000000-0000-0000-0000-000107174102"';
  s3  constant text := '"00000000-0000-0000-0000-000107174103"';
  ca  constant text := '"00000000-0000-0000-0000-000107171001"';
  cb  constant text := '"00000000-0000-0000-0000-000107171002"';
  cc  constant text := '"00000000-0000-0000-0000-000107171003"';
  before text;
begin
  got := pg_temp.save7(format('[{"id": %s, "day_number": 2, "course_id": %s}, {"id": %s, "day_number": 1, "course_id": %s}, '
                              || '{"id": %s, "day_number": 3, "course_id": %s}]', s1, ca, s2, cb, s3, cc));
  if got <> '{"saved": 3, "removed": 0, "inserted": 0, "renumbered": 2} S2=1 S1=2 S3=3' then
    bad := bad || format('a swap by identity: %s', got);
  end if;
  got := pg_temp.save7(format('[{"id": %s, "day_number": 1, "course_id": %s}, {"id": null, "day_number": 2, "course_id": %s, '
                              || '"mission_title": "New day", "pass_required": true}, {"id": %s, "day_number": 3, "course_id": %s}, '
                              || '{"id": %s, "day_number": 4, "course_id": %s}]', s2, cb, ca, s1, ca, s3, cc));
  if got <> '{"saved": 4, "removed": 0, "inserted": 1, "renumbered": 2} S2=1 new=2 S1=3 S3=4' then
    bad := bad || format('a day inserted at 2: %s', got);
  end if;
  if (select format('%s/%s/%s', right(course_id::text, 4), mission_title, pass_required) from public.journey_days
       where program_id = pg_temp.u7('000107174001') and day_number = 2) <> '1001/New day/t' then
    bad := bad || 'the inserted day''s content is not as saved'::text;
  end if;
  got := pg_temp.save7(format('[{"id": %s, "removed": true}, {"id": %s, "day_number": 3, "course_id": %s, '
                              || '"pass_required": false}]', s1, s3, cb));
  if got <> '{"saved": 2, "removed": 1, "inserted": 0, "renumbered": 1} S2=1 new=2 S3=3 S1=-r' then
    bad := bad || format('a day removed and another moved: %s', got);
  end if;
  if (select format('%s/%s', right(course_id::text, 4), pass_required) from public.journey_days
       where id = pg_temp.u7('000107174103')) <> '1002/f'
     or (select format('%s/%s', right(course_id::text, 4), removed_at is not null) from public.journey_days
          where id = pg_temp.u7('000107174101')) <> '1001/t' then
    bad := bad || 'the moved day''s content or the removed day''s is not as saved'::text;
  end if;

  -- the refusals: each leaves the days as they are
  before := pg_temp.days7();
  for r in
    select * from (values
      ('not an array', '{"id": null}', '22023'),
      ('an element that is not an object', '[1]', '22023'),
      ('a new day removed', '[{"id": null, "removed": true}]', '22023'),
      ('a day named twice', format('[{"id": %s, "day_number": 1}, {"id": %s, "day_number": 2}]', s2, s2), '22023'),
      ('two days on one number', format('[{"id": %s, "day_number": 1}, {"id": null, "day_number": 1}]', s2), '22023'),
      ('an id of no day', '[{"id": "00000000-0000-0000-0000-000107179999", "day_number": 5}]', '22023'),
      ('a day of another program', '[{"id": "00000000-0000-0000-0000-000107174109", "day_number": 5}]', '22023'),
      ('a removed day given a number', format('[{"id": %s, "day_number": 5}]', s1), '22023'),
      ('a day left without a number', format('[{"id": %s, "day_number": null}]', s3), '22023'),
      ('a move onto a number an unnamed day holds', format('[{"id": %s, "day_number": 2}]', s3), '23505'),
      ('a number above 365', '[{"id": null, "day_number": 400}]', '23514'),
      ('an id that is not a uuid', '[{"id": "x", "day_number": 5}]', '22P02')
    ) as v(what, payload, expected)
  loop
    select * into t from pg_temp.probe7(
      format('select public.journey_save_days(''00000000-0000-0000-0000-000107174001'', %L::jsonb)', r.payload),
      null, null);
    if t.state <> r.expected then
      bad := bad || format('%s: %s %s (expected %s)', r.what, t.state, coalesce(t.msg, ''), r.expected);
    end if;
    if t.state = '22023' and t.msg ~* 'does not exist|schema cache|could not find the' then
      bad := bad || format('%s: the message reads like a missing schema: %s', r.what, t.msg);
    end if;
  end loop;
  if pg_temp.days7() is distinct from before then
    bad := bad || format('a refused save changed the days: %s (before %s)', pg_temp.days7(), before);
  end if;

  -- the old editor's upsert on (program_id, day_number), unchanged key
  insert into public.journey_days (program_id, organization_id, day_number, course_id)
  values (pg_temp.u7('000107174001'), '00000000-0000-0000-0000-00000000000a', 1, pg_temp.u7('000107171003'))
  on conflict (program_id, day_number) do update set course_id = excluded.course_id;
  if (select course_id from public.journey_days where id = pg_temp.u7('000107174102'))
     is distinct from pg_temp.u7('000107171003') then
    bad := bad || 'the old editor''s upsert did not update day 1 in place'::text;
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107: (31) %', array_to_string(bad, '; ');
  end if;
end
$$;

-- as the API roles (the days now: S2=1 new=2 S3=3 S1 removed). The admin S
-- of Org A swaps S2 and S3; the learner L1 and the admin L9 of another
-- organisation are refused with 22023 and write nothing; anon is refused
-- execute (42501)
create temporary table r0107p_roles (who text, state text, msg text, days text);
grant select, insert on pg_temp.r0107p_roles to authenticated, anon;
grant execute on all functions in schema pg_temp to authenticated, anon;
grant insert, update on public.journey_days to authenticated;

create function pg_temp.try7(p_who text, p_stmt text) returns void language plpgsql as $$
declare
  v_state text := 'ok';
  v_msg   text;
begin
  begin
    execute p_stmt;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  end;
  insert into pg_temp.r0107p_roles values (p_who, v_state, v_msg, null);
end
$$;
grant execute on function pg_temp.try7(text, text) to authenticated, anon;

select set_config('request.jwt.claims', '{"sub": "00000000-0000-0000-0000-000107010006", "role": "authenticated"}', true);
set local role authenticated;
select pg_temp.try7('S', 'select public.journey_save_days(''00000000-0000-0000-0000-000107174001'', '
  || '''[{"id": "00000000-0000-0000-0000-000107174102", "day_number": 3}, '
  || '{"id": "00000000-0000-0000-0000-000107174103", "day_number": 1}]''::jsonb)');
reset role;
update pg_temp.r0107p_roles set days = pg_temp.days7() where who = 'S';

select set_config('request.jwt.claims', '{"sub": "00000000-0000-0000-0000-000107170001", "role": "authenticated"}', true);
set local role authenticated;
select pg_temp.try7('L1', 'select public.journey_save_days(''00000000-0000-0000-0000-000107174001'', '
  || '''[{"id": "00000000-0000-0000-0000-000107174102", "day_number": 1}, '
  || '{"id": "00000000-0000-0000-0000-000107174103", "day_number": 3}]''::jsonb)');
select pg_temp.try7('L1 insert', 'select public.journey_save_days(''00000000-0000-0000-0000-000107174001'', '
  || '''[{"id": null, "day_number": 7}]''::jsonb)');
reset role;
update pg_temp.r0107p_roles set days = pg_temp.days7() where who like 'L1%';

select set_config('request.jwt.claims', '{"sub": "00000000-0000-0000-0000-000107170009", "role": "authenticated"}', true);
set local role authenticated;
select pg_temp.try7('L9', 'select public.journey_save_days(''00000000-0000-0000-0000-000107174001'', '
  || '''[{"id": null, "day_number": 7}]''::jsonb)');
reset role;
update pg_temp.r0107p_roles set days = pg_temp.days7() where who = 'L9';

select set_config('request.jwt.claims', '{"role": "anon"}', true);
set local role anon;
select pg_temp.try7('anon', 'select public.journey_save_days(''00000000-0000-0000-0000-000107174001'', ''[]''::jsonb)');
reset role;
select set_config('request.jwt.claims', '', true);

do $$
declare
  got text;
begin
  select string_agg(format('%s:%s:%s', who, state, coalesce(days, '')), ' | ' order by who collate "C") into got
    from pg_temp.r0107p_roles;
  if got is distinct from
     'L1:22023:S3=1 new=2 S2=3 S1=-r | L1 insert:42501:S3=1 new=2 S2=3 S1=-r | L9:22023:S3=1 new=2 S2=3 S1=-r | '
     || 'S:ok:S3=1 new=2 S2=3 S1=-r | anon:42501:' then
    raise exception 'assert-0107: (31) as the API roles: % (expected the admin to save, the learner, the other organisation''s admin and anon refused)',
      got;
  end if;
end
$$;
rollback to savepoint s31;

-- ---------------------------------------------------------------------------
-- (32) journey_repin_enrollments
-- ---------------------------------------------------------------------------
-- The re-pin world of one case: program JR with days R1 to R6 (numbers 1 to
-- 6: CA, CB, CA, CC, CB, CA); version VR1 (days 1 to 4, days_total 4, day 3
-- requiring a pass in mode strict), current, with its day_ids source given;
-- enrolment ER of L4 on VR1 (status given), started p_start days ago; days
-- 1 to 3 completed by official journey rows and credited, and an open
-- official row on day 4, except: strict, day 3's row failed and holds no
-- credit; pending, day 3's row completed and its credit is not written yet
-- (the writer's call pending); inherit, day 4's row failed (CC requires a
-- pass and the day inherits it) and no row is open. With p_extra, also a
-- slot_backfill version VR0 (version 9, VR1's days) and on it enrolment EK
-- of L1, every required day credited with no attempt (complete under its
-- own version, not yet marked)
create function pg_temp.repin_world7(p_source text, p_status text, p_mode text, p_start int, p_extra boolean)
returns void
language plpgsql as $$
declare
  org constant uuid := '00000000-0000-0000-0000-00000000000a';
  jr  constant uuid := '00000000-0000-0000-0000-000107178001';
  er  constant uuid := '00000000-0000-0000-0000-000107178401';
  l4  constant uuid := '00000000-0000-0000-0000-000107170004';
  c   uuid[] := array[pg_temp.u7('000107171001'), pg_temp.u7('000107171002'), pg_temp.u7('000107171001'),
                      pg_temp.u7('000107171003'), pg_temp.u7('000107171002'), pg_temp.u7('000107171001')];
  v   uuid[] := array[pg_temp.u7('000107171201'), pg_temp.u7('000107171203'), pg_temp.u7('000107171201'),
                      pg_temp.u7('000107171204'), pg_temp.u7('000107171203'), pg_temp.u7('000107171201')];
  i   int;
begin
  insert into public.journey_programs (id, organization_id, name, days_total)
  values (jr, org, 'JR (0107 plpgsql)', 4);
  for i in 1..6 loop
    insert into public.journey_days (id, program_id, organization_id, day_number, course_id, pass_required)
    values (pg_temp.u7('00010717810' || i), jr, org, i, c[i], case when i = 3 and p_mode = 'strict' then true end);
  end loop;
  insert into public.journey_versions (id, program_id, organization_id, version_number, name, days_total,
                                       count_sundays, completion_title, days, day_ids, day_ids_source)
  select pg_temp.u7('000107178301'), jr, org, 1, 'JR (0107 plpgsql)', 4, true, 'Done',
         jsonb_agg(jsonb_build_object('day', d.day_number, 'course_id', d.course_id::text, 'mission_title', null,
                                      'pass_required', d.pass_required) order by d.day_number),
         jsonb_object_agg(d.day_number::text, d.id::text), p_source
    from public.journey_days d where d.program_id = jr and d.day_number <= 4;
  update public.journey_programs set current_version_id = pg_temp.u7('000107178301') where id = jr;
  insert into public.journey_enrollments (id, program_id, version_id, organization_id, user_id, start_date, status,
                                          completed_at)
  values (er, jr, pg_temp.u7('000107178301'), org, l4, current_date - p_start, p_status,
          case when p_status = 'completed' then now() end);
  for i in 1..4 loop
    perform pg_temp.att7(pg_temp.u7('00010717850' || i), v[i], l4,
                         case when i = 4 then case when p_mode = 'inherit' then 'failed' else 'in_progress' end
                              when i = 3 and p_mode = 'strict' then 'failed' else 'completed' end,
                         null, er, i, pg_temp.u7('00010717810' || i), pg_temp.u7('000107178301'), 1000 - i * 100);
    if i <= 3 and not (i = 3 and p_mode in ('strict', 'pending')) then
      insert into public.journey_day_progress (id, enrollment_id, organization_id, user_id, day_number, day_id,
                                               course_id, attempt_id, completed_at)
      values (pg_temp.u7('00010717860' || i), er, org, l4, i, pg_temp.u7('00010717810' || i), c[i],
              pg_temp.u7('00010717850' || i), now() - make_interval(days => 10 - i));
    end if;
  end loop;
  if p_extra then
    insert into public.journey_versions (id, program_id, organization_id, version_number, name, days_total,
                                         count_sundays, completion_title, days, day_ids, day_ids_source)
    select pg_temp.u7('000107178309'), jr, org, 9, 'JR (0107 plpgsql)', 4, true, 'Done', jv.days, jv.day_ids,
           'slot_backfill'
      from public.journey_versions jv where jv.id = pg_temp.u7('000107178301');
    insert into public.journey_enrollments (id, program_id, version_id, organization_id, user_id, start_date, status)
    values (pg_temp.u7('000107178402'), jr, pg_temp.u7('000107178309'), org, pg_temp.u7('000107170001'),
            current_date - 10, 'active');
    for i in 1..4 loop
      insert into public.journey_day_progress (id, enrollment_id, organization_id, user_id, day_number, day_id,
                                               course_id, completed_at)
      values (pg_temp.u7('00010717870' || i), pg_temp.u7('000107178402'), org, pg_temp.u7('000107170001'), i,
              pg_temp.u7('00010717810' || i), c[i], now() - make_interval(days => 10 - i));
    end loop;
  end if;
end
$$;

-- The draft of JR as the publish would freeze it: its active days by number
create function pg_temp.draft7(p_days_total int) returns jsonb language sql stable as $$
  select jsonb_build_object(
           'days', coalesce(jsonb_agg(jsonb_build_object('day', d.day_number, 'course_id', d.course_id::text,
                                                         'mission_title', d.mission_title,
                                                         'pass_required', d.pass_required) order by d.day_number),
                            '[]'::jsonb),
           'day_ids', coalesce(jsonb_object_agg(d.day_number::text, d.id::text), '{}'::jsonb),
           'days_total', p_days_total)
    from public.journey_days d
   where d.program_id = '00000000-0000-0000-0000-000107178001' and d.removed_at is null and d.day_number is not null
$$;

-- One case: the save (if any), the dry run on the draft, the publish of the
-- draft as a version (editor, current, unlock mode given), a hook (an
-- enrolment made after the publish, when given), the real run; answers the
-- dry run's
-- counts, whether the real run's equal them, whether the dry run wrote
-- nothing and whether the real run updated or deleted no attempt or credit
-- row, then the version ER is pinned to and its credit state
create function pg_temp.repin_case7(p_save text, p_days_total int, p_unlock text, p_hook text) returns text
language plpgsql as $$
declare
  jr    constant uuid := '00000000-0000-0000-0000-000107178001';
  er    constant uuid := '00000000-0000-0000-0000-000107178401';
  draft jsonb;
  v_dry  jsonb;
  v_real jsonb;
  a0    text;
  p0    text;
  pin0  uuid;
  same_dry boolean;
  kept_rows boolean;
begin
  if p_save is not null then
    perform public.journey_save_days(jr, p_save::jsonb);
  end if;
  draft := pg_temp.draft7(p_days_total);
  a0 := pg_temp.rows7(er, 'attempts');
  p0 := pg_temp.rows7(er, 'credits');
  select version_id into pin0 from public.journey_enrollments where id = er;
  v_dry := public.journey_repin_enrollments(jr, null, draft, true);
  same_dry := pg_temp.rows7(er, 'attempts') = a0 and pg_temp.rows7(er, 'credits') = p0
              and (select version_id from public.journey_enrollments where id = er) = pin0;
  insert into public.journey_versions (id, program_id, organization_id, version_number, name, days_total,
                                       count_sundays, completion_title, days, day_ids, day_ids_source, unlock_mode)
  values ('00000000-0000-0000-0000-000107178302', jr, '00000000-0000-0000-0000-00000000000a', 2, 'JR (0107 plpgsql)',
          p_days_total, true, 'Done', draft -> 'days', draft -> 'day_ids', 'editor', p_unlock);
  update public.journey_programs set current_version_id = '00000000-0000-0000-0000-000107178302' where id = jr;
  if p_hook is not null then
    execute p_hook;
  end if;
  v_real := public.journey_repin_enrollments(jr, '00000000-0000-0000-0000-000107178302', null, false);
  kept_rows := pg_temp.rows7(er, 'attempts') = a0
               and (select bool_and(strpos(pg_temp.rows7(er, 'credits'), x) > 0)
                      from unnest(string_to_array(p0, '|')) as u(x));
  return format('%s same=%s dry_wrote_nothing=%s rows_kept=%s pin=%s state=%s',
                (v_dry - 'dry_run')::text, (v_dry - 'dry_run') = (v_real - 'dry_run'), same_dry, coalesce(kept_rows, true),
                right((select version_id::text from public.journey_enrollments where id = er), 4),
                pg_temp.jcs7(er));
end
$$;

-- the two forms and their refusals (22023, nothing written)
savepoint s32f;
select pg_temp.repin_world7('editor', 'active', 'normal', 10, false);
do $$
declare
  bad text[] := '{}';
  r   record;
  t   record;
  ok  jsonb := pg_temp.draft7(4);
begin
  for r in
    select * from (values
      ('a version and a draft', format('select public.journey_repin_enrollments(''00000000-0000-0000-0000-000107178001'', '
         || '''00000000-0000-0000-0000-000107178301'', %L::jsonb, false)', ok)),
      ('no version and no draft', 'select public.journey_repin_enrollments(''00000000-0000-0000-0000-000107178001'', '
         || 'null, null, false)'),
      ('a dry run naming a version', 'select public.journey_repin_enrollments(''00000000-0000-0000-0000-000107178001'', '
         || '''00000000-0000-0000-0000-000107178301'', null, true)'),
      ('a real run with a draft', format('select public.journey_repin_enrollments(''00000000-0000-0000-0000-000107178001'', '
         || 'null, %L::jsonb, false)', ok)),
      ('a null dry-run flag', 'select public.journey_repin_enrollments(''00000000-0000-0000-0000-000107178001'', '
         || '''00000000-0000-0000-0000-000107178301'', null, null)'),
      ('a version of another program', 'select public.journey_repin_enrollments(''00000000-0000-0000-0000-000107178001'', '
         || '''00000000-0000-0000-0000-000107173301'', null, false)'),
      ('a version that is not current', 'select public.journey_repin_enrollments(''00000000-0000-0000-0000-000107173001'', '
         || '''00000000-0000-0000-0000-000107173300'', null, false)'),
      ('a draft without day_ids', 'select public.journey_repin_enrollments(''00000000-0000-0000-0000-000107178001'', '
         || 'null, ''{"days": [], "days_total": 4}''::jsonb, true)'),
      ('a draft whose days_total is no whole number', 'select public.journey_repin_enrollments('
         || '''00000000-0000-0000-0000-000107178001'', null, ''{"days": [], "day_ids": {}, "days_total": 4.5}''::jsonb, true)')
    ) as v(what, stmt)
  loop
    select * into t from pg_temp.probe7(r.stmt, null, null);
    if t.state <> '22023' or t.msg ~* 'does not exist|schema cache|could not find the' then
      bad := bad || format('%s: %s %s (expected 22023)', r.what, t.state, coalesce(t.msg, ''));
    end if;
  end loop;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107: (32) the forms: %', array_to_string(bad, '; ');
  end if;
end
$$;
rollback to savepoint s32f;


-- step 63's cases. Each runs in a subtransaction that is undone after it
-- (pg_temp.case7), so no case sees another's rows; its answer is kept.
-- Expected counts are the dry run's; same=true says the real run's are
-- equal (format prints a boolean as t or f).
create function pg_temp.case7(p_source text, p_status text, p_mode text, p_save text, p_days_total int,
                              p_after text, p_start int default 10, p_unlock text default 'calendar',
                              p_extra boolean default false, p_hook text default null)
returns text language plpgsql as $$
declare
  v     text;
  after text;
begin
  begin
    perform pg_temp.repin_world7(p_source, p_status, p_mode, p_start, p_extra);
    v := pg_temp.repin_case7(p_save, p_days_total, p_unlock, p_hook);
    if p_after is not null then
      execute p_after into after;
      v := v || ' || ' || coalesce(after, 'null');
    end if;
    raise exception using errcode = 'R0107', message = 'assert-0107: undo';
  exception when others then
    if sqlstate <> 'R0107' then
      v := 'error ' || sqlstate || ': ' || sqlerrm;
    end if;
  end;
  return v;
end
$$;

create temporary table r0107p_repin (k text, got text, want text);

insert into pg_temp.r0107p_repin values
-- no change at all (control): re-pinned, nothing else
('none', pg_temp.case7('editor', 'active', 'normal', null, 4, null),
 '{"repinned": 1, "sent_back": 0, "completed_now": 0, "kept_on_version": 0, "started_days_kept": 0, '
 || '"credits_now_history": 0, "credited_by_rule_change": 0} same=t dry_wrote_nothing=t rows_kept=t '
 || 'pin=8302 state=req=4 done=3 cred={1,2,3} next=4'),
-- (a) a day inserted at number 2: the credits and the open attempt keep
-- their day ids; the inserted day is the open day; the open attempt's day
-- moved from 4 to 5 (started_days_kept); sent back from 4 to 2
('a', pg_temp.case7('editor', 'active', 'normal',
  '[{"id": "00000000-0000-0000-0000-000107178101", "day_number": 1, "course_id": "00000000-0000-0000-0000-000107171001"},'
  || ' {"id": null, "day_number": 2, "course_id": "00000000-0000-0000-0000-000107171003"},'
  || ' {"id": "00000000-0000-0000-0000-000107178102", "day_number": 3, "course_id": "00000000-0000-0000-0000-000107171002"},'
  || ' {"id": "00000000-0000-0000-0000-000107178103", "day_number": 4, "course_id": "00000000-0000-0000-0000-000107171001"},'
  || ' {"id": "00000000-0000-0000-0000-000107178104", "day_number": 5, "course_id": "00000000-0000-0000-0000-000107171003"},'
  || ' {"id": "00000000-0000-0000-0000-000107178105", "day_number": 6, "course_id": "00000000-0000-0000-0000-000107171002"},'
  || ' {"id": "00000000-0000-0000-0000-000107178106", "day_number": 7, "course_id": "00000000-0000-0000-0000-000107171001"}]',
  5, null),
 '{"repinned": 1, "sent_back": 1, "completed_now": 0, "kept_on_version": 0, "started_days_kept": 1, '
 || '"credits_now_history": 0, "credited_by_rule_change": 0} same=t dry_wrote_nothing=t rows_kept=t '
 || 'pin=8302 state=req=5 done=3 cred={1,3,4} next=2'),
-- (b) days 2 and 3 swapped: the credits follow their days; no credited day
-- is the open day; nothing sent back, the open day 4 unmoved
('b', pg_temp.case7('editor', 'active', 'normal',
  '[{"id": "00000000-0000-0000-0000-000107178102", "day_number": 3, "course_id": "00000000-0000-0000-0000-000107171002"},'
  || ' {"id": "00000000-0000-0000-0000-000107178103", "day_number": 2, "course_id": "00000000-0000-0000-0000-000107171001"}]',
  4, null),
 '{"repinned": 1, "sent_back": 0, "completed_now": 0, "kept_on_version": 0, "started_days_kept": 0, '
 || '"credits_now_history": 0, "credited_by_rule_change": 0} same=t dry_wrote_nothing=t rows_kept=t '
 || 'pin=8302 state=req=4 done=3 cred={1,2,3} next=4'),
-- (c) the course on day 4 swapped (CC to CB): the open attempt is a started
-- day kept; the day stays the open day
('c', pg_temp.case7('editor', 'active', 'normal',
  '[{"id": "00000000-0000-0000-0000-000107178104", "day_number": 4, "course_id": "00000000-0000-0000-0000-000107171002"}]',
  4, null),
 '{"repinned": 1, "sent_back": 0, "completed_now": 0, "kept_on_version": 0, "started_days_kept": 1, '
 || '"credits_now_history": 0, "credited_by_rule_change": 0} same=t dry_wrote_nothing=t rows_kept=t '
 || 'pin=8302 state=req=4 done=3 cred={1,2,3} next=4'),
-- (d) day 4 removed (days_total kept at 4): the remaining required days are
-- credited, so the publish completes the enrolment; the open attempt on the
-- removed day is a started day kept (it stays resumable)
('d', pg_temp.case7('editor', 'active', 'normal',
  '[{"id": "00000000-0000-0000-0000-000107178104", "removed": true}]', 4, null),
 '{"repinned": 1, "sent_back": 0, "completed_now": 1, "kept_on_version": 0, "started_days_kept": 1, '
 || '"credits_now_history": 0, "credited_by_rule_change": 0} same=t dry_wrote_nothing=t rows_kept=t '
 || 'pin=8302 state=req=3 done=3 cred={1,2,3} next=-'),
-- (e) the new version is shorter (days_total 3) and every remaining
-- required day is credited: completed at once; day 4 is beyond the cut
('e', pg_temp.case7('editor', 'active', 'normal', null, 3, null),
 '{"repinned": 1, "sent_back": 0, "completed_now": 1, "kept_on_version": 0, "started_days_kept": 1, '
 || '"credits_now_history": 0, "credited_by_rule_change": 0} same=t dry_wrote_nothing=t rows_kept=t '
 || 'pin=8302 state=req=3 done=3 cred={1,2,3} next=-'),
-- (f) a completed enrolment is not re-pinned
('f', pg_temp.case7('editor', 'completed', 'normal', null, 3, null),
 '{"repinned": 0, "sent_back": 0, "completed_now": 0, "kept_on_version": 0, "started_days_kept": 0, '
 || '"credits_now_history": 0, "credited_by_rule_change": 0} same=t dry_wrote_nothing=t rows_kept=t '
 || 'pin=8301 state=req=4 done=3 cred={1,2,3} next=4'),
-- (g) pinned to a slot_backfill version: the course of day 2 swapped (at or
-- below the furthest day, 4) keeps it on its version
('g1', pg_temp.case7('slot_backfill', 'active', 'normal',
  '[{"id": "00000000-0000-0000-0000-000107178102", "day_number": 2, "course_id": "00000000-0000-0000-0000-000107171003"}]',
  4, null),
 '{"repinned": 0, "sent_back": 0, "completed_now": 0, "kept_on_version": 1, "started_days_kept": 0, '
 || '"credits_now_history": 0, "credited_by_rule_change": 0} same=t dry_wrote_nothing=t rows_kept=t '
 || 'pin=8301 state=req=4 done=3 cred={1,2,3} next=4'),
-- (g) the same pin, a day added at 5 (above the furthest day): re-pinned
('g2', pg_temp.case7('slot_backfill', 'active', 'normal', null, 5, null),
 '{"repinned": 1, "sent_back": 0, "completed_now": 0, "kept_on_version": 0, "started_days_kept": 0, '
 || '"credits_now_history": 0, "credited_by_rule_change": 0} same=t dry_wrote_nothing=t rows_kept=t '
 || 'pin=8302 state=req=5 done=3 cred={1,2,3} next=4'),
-- (g) the same pin, the pass rule of day 2 tightened (course unchanged): a
-- difference at day 2, so kept
('g3', pg_temp.case7('slot_backfill', 'active', 'normal',
  '[{"id": "00000000-0000-0000-0000-000107178102", "day_number": 2, "course_id": "00000000-0000-0000-0000-000107171002",'
  || ' "pass_required": true}]', 4, null),
 '{"repinned": 0, "sent_back": 0, "completed_now": 0, "kept_on_version": 1, "started_days_kept": 0, '
 || '"credits_now_history": 0, "credited_by_rule_change": 0} same=t dry_wrote_nothing=t rows_kept=t '
 || 'pin=8301 state=req=4 done=3 cred={1,2,3} next=4'),
-- (h) day 3 required a pass and its official row failed (no credit, day 3
-- open); the publish relaxes day 3: the re-pin credits it with that row
-- (credited_by_rule_change), and the open day moves on to 4. After it, the
-- credit's columns: the attempt's own course and row, the day's number in
-- the new version, credit_kind attempt, completed_at now (the credit's own
-- clock, the column default) and late, since day 3's counted date (the 3rd
-- counted day from a start 10 days ago, Sundays counted) has passed; then a
-- second real run on the same version, which writes nothing new
('h', pg_temp.case7('editor', 'active', 'strict',
  '[{"id": "00000000-0000-0000-0000-000107178103", "day_number": 3, "course_id": "00000000-0000-0000-0000-000107171001",'
  || ' "pass_required": false}]', 4,
  'select (select format(''%s/%s/%s/%s/%s/%s/%s'', right(p.course_id::text, 4), right(p.attempt_id::text, 4), '
  || 'p.day_number, right(p.day_id::text, 4), p.credit_kind, p.completed_at = now(), p.late) '
  || 'from public.journey_day_progress p where p.enrollment_id = ''00000000-0000-0000-0000-000107178401'' '
  || 'and p.day_id = ''00000000-0000-0000-0000-000107178103'') || '' || '' || '
  || 'public.journey_repin_enrollments(''00000000-0000-0000-0000-000107178001'', '
  || '''00000000-0000-0000-0000-000107178302'', null, false)::text'),
 '{"repinned": 1, "sent_back": 0, "completed_now": 0, "kept_on_version": 0, "started_days_kept": 0, '
 || '"credits_now_history": 0, "credited_by_rule_change": 1} same=t dry_wrote_nothing=t rows_kept=t '
 || 'pin=8302 state=req=4 done=3 cred={1,2,3} next=4 || 1001/8503/3/8103/attempt/t/t || '
 || '{"dry_run": false, "repinned": 0, "sent_back": 0, "completed_now": 0, "kept_on_version": 0, '
 || '"started_days_kept": 0, "credits_now_history": 0, "credited_by_rule_change": 0}'),
-- day 2 made a rest day (its course cleared): its credit now counts towards
-- nothing (credits_now_history); the open day stays 4
('history', pg_temp.case7('editor', 'active', 'normal',
  '[{"id": "00000000-0000-0000-0000-000107178102", "day_number": 2, "course_id": null}]', 4, null),
 '{"repinned": 1, "sent_back": 0, "completed_now": 0, "kept_on_version": 0, "started_days_kept": 0, '
 || '"credits_now_history": 1, "credited_by_rule_change": 0} same=t dry_wrote_nothing=t rows_kept=t '
 || 'pin=8302 state=req=3 done=2 cred={1,3} next=4'),
-- the negative controls of the relaxed-rule credit. h0: the strict world
-- published with no change: day 3's failed row satisfies neither rule, no
-- credit, day 3 stays open
('h0', pg_temp.case7('editor', 'active', 'strict', null, 4, null),
 '{"repinned": 1, "sent_back": 0, "completed_now": 0, "kept_on_version": 0, "started_days_kept": 0, '
 || '"credits_now_history": 0, "credited_by_rule_change": 0} same=t dry_wrote_nothing=t rows_kept=t '
 || 'pin=8302 state=req=4 done=2 cred={1,2} next=3'),
-- inherit: day 4 inherits CC's pass rule and its row failed; published with
-- no change, nothing is credited (the target's rule is the course's, not
-- false)
('inherit', pg_temp.case7('editor', 'active', 'inherit', null, 4, null),
 '{"repinned": 1, "sent_back": 0, "completed_now": 0, "kept_on_version": 0, "started_days_kept": 0, '
 || '"credits_now_history": 0, "credited_by_rule_change": 0} same=t dry_wrote_nothing=t rows_kept=t '
 || 'pin=8302 state=req=4 done=3 cred={1,2,3} next=4'),
-- pending: day 3's row completed under a rule it satisfies and its credit
-- is not written yet; the re-pin does not write it (no rule changed: it is
-- journey_record_completion's, by the writer or the sweep)
('pending', pg_temp.case7('editor', 'active', 'pending', null, 4, null),
 '{"repinned": 1, "sent_back": 0, "completed_now": 0, "kept_on_version": 0, "started_days_kept": 0, '
 || '"credits_now_history": 0, "credited_by_rule_change": 0} same=t dry_wrote_nothing=t rows_kept=t '
 || 'pin=8302 state=req=4 done=2 cred={1,2} next=3'),
-- late is false for the same relaxed-rule credit in a progress journey, and
-- in a calendar journey that started today (day 3's counted date is ahead)
('h progress', pg_temp.case7('editor', 'active', 'strict',
  '[{"id": "00000000-0000-0000-0000-000107178103", "day_number": 3, "course_id": "00000000-0000-0000-0000-000107171001",'
  || ' "pass_required": false}]', 4,
  'select (select format(''%s/%s'', p.credit_kind, p.late) from public.journey_day_progress p '
  || 'where p.enrollment_id = ''00000000-0000-0000-0000-000107178401'' '
  || 'and p.day_id = ''00000000-0000-0000-0000-000107178103'')', 10, 'progress'),
 '{"repinned": 1, "sent_back": 0, "completed_now": 0, "kept_on_version": 0, "started_days_kept": 0, '
 || '"credits_now_history": 0, "credited_by_rule_change": 1} same=t dry_wrote_nothing=t rows_kept=t '
 || 'pin=8302 state=req=4 done=3 cred={1,2,3} next=4 || attempt/f'),
('h today', pg_temp.case7('editor', 'active', 'strict',
  '[{"id": "00000000-0000-0000-0000-000107178103", "day_number": 3, "course_id": "00000000-0000-0000-0000-000107171001",'
  || ' "pass_required": false}]', 4,
  'select (select format(''%s/%s'', p.credit_kind, p.late) from public.journey_day_progress p '
  || 'where p.enrollment_id = ''00000000-0000-0000-0000-000107178401'' '
  || 'and p.day_id = ''00000000-0000-0000-0000-000107178103'')', 0, 'calendar'),
 '{"repinned": 1, "sent_back": 0, "completed_now": 0, "kept_on_version": 0, "started_days_kept": 0, '
 || '"credits_now_history": 0, "credited_by_rule_change": 1} same=t dry_wrote_nothing=t rows_kept=t '
 || 'pin=8302 state=req=4 done=3 cred={1,2,3} next=4 || attempt/f'),
-- one call over three enrolments: ER (editor pin) re-pinned; EK (a
-- slot_backfill pin, every required day credited, course of day 2 changed
-- at or below its furthest day) kept on its version and completed by the
-- publish; ET, enrolled on the new version after it was published (the
-- hook), neither re-pinned nor completed. The dry run, made before ET
-- existed, counts the same
('multi', pg_temp.case7('editor', 'active', 'normal',
  '[{"id": "00000000-0000-0000-0000-000107178102", "day_number": 2, "course_id": "00000000-0000-0000-0000-000107171003"}]', 4,
  'select string_agg(right(e.id::text, 4) || '':'' || right(e.version_id::text, 4) || '':'' || e.status, '' '' '
  || 'order by e.id) from public.journey_enrollments e '
  || 'where e.program_id = ''00000000-0000-0000-0000-000107178001''', 10, 'calendar', true,
  'insert into public.journey_enrollments (id, program_id, version_id, organization_id, user_id, start_date, status) '
  || 'values (''00000000-0000-0000-0000-000107178403'', ''00000000-0000-0000-0000-000107178001'', '
  || '''00000000-0000-0000-0000-000107178302'', ''00000000-0000-0000-0000-00000000000a'', '
  || '''00000000-0000-0000-0000-000107170003'', current_date, ''active'')'),
 '{"repinned": 1, "sent_back": 0, "completed_now": 1, "kept_on_version": 1, "started_days_kept": 0, '
 || '"credits_now_history": 0, "credited_by_rule_change": 0} same=t dry_wrote_nothing=t rows_kept=t '
 || 'pin=8302 state=req=4 done=3 cred={1,2,3} next=4 || 8401:8302:active 8402:8309:completed 8403:8302:active');

do $$
declare
  failed text;
begin
  select string_agg(format('%s: %s (expected %s)', r.k, coalesce(r.got, 'null'), r.want), '; ' order by r.k) into failed
    from pg_temp.r0107p_repin r
   where r.got is distinct from r.want;
  if failed is not null then
    raise exception 'assert-0107: (32) %', failed;
  end if;
  if (select count(*) from pg_temp.r0107p_repin) <> 18 then
    raise exception 'assert-0107: (32) % cases ran (expected 18)', (select count(*) from pg_temp.r0107p_repin);
  end if;
  -- every case was undone: no JR program is left
  if exists (select 1 from public.journey_programs where id = '00000000-0000-0000-0000-000107178001') then
    raise exception 'assert-0107: (32) a case was not undone';
  end if;
end
$$;

rollback;
