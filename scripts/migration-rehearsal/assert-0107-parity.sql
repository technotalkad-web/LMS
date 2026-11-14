-- scripts/migration-rehearsal/assert-0107-parity.sql
-- The SQL side of the twins' parity (ADR 0024 steps 62 and 63; build notes
-- N16 and N17; the twins contract, sections 6 and 7), after each
-- assert-0107-launch.sql. The cases are the four files under fixtures/,
-- which run.mjs's `cases` step loads through parity-cases.mjs into the
-- session's temporary table parity_cases (one jsonb document per pair); the
-- TypeScript twins run the same cases in tests/unit/context-parity.test.ts
-- and tests/unit/launch-context-facts.test.ts. Nothing here is generated or
-- committed beside the JSON.
--   (P0) the four documents are loaded
--   (P1) the official rule: per case, v_context_attempt_scoring and
--        v_context_attempt_summary for (learner, course, context_key),
--        official_attempt_in_context() equal to the view's official attempt,
--        and instance_pass_required() equal to the case's resolved rule
--   (P2) the path rule: v_path_step_status, v_path_progress and
--        v_path_enrollment_terms for (path, learner)
--   (P3) the journey credit rule: journey_credit_state(), with finished =
--        required_days > 0 and next_day is null, and journey_reminder_counts()
--        agreeing with it on done and credited; the TypeScript side of this
--        pair waits for phase 2 (N17)
--   (P4) launch_context()'s facts, compared as jsonb (timestamps as
--        timestamptz, numbers at 4 decimals)
-- A case marked writer then calls record_learning_activity on
-- call.writer_attempt_id and compares its answer with expect.writer
-- (contract 6.4; build notes N13, O1-c, O1-e).
--
-- Per pair, in one subtransaction that is undone at its end: the pair's
-- world; then each case with "sql" among its sides in a subtransaction of
-- its own (its given rows, the reads, the comparison), undone after it, so
-- no case sees another's rows. A generated column a row names
-- (course_attempts.context_key, attempt_requests.context_key) is left out of
-- the insert and compared with the value the database generated. Every
-- mismatch names the case, the field, the expected and the actual value
-- (ids, numbers and flags of synthetic rows only); the count of cases run
-- must equal the count the file gives the SQL side, and (H1 of the ADR's
-- note of 2026-11-14) each pair's count must equal the both-sided count
-- pinned in parity-cases.mjs (BOTH_SIDED) and in
-- tests/unit/context-parity.test.ts: the SQL side runs no case alone. One
-- transaction that ends in ROLLBACK.

begin;

-- ---------------------------------------------------------------------------
-- The scaffold (contract 6.3)
-- ---------------------------------------------------------------------------
-- The insert order: parents first. users is the scaffold's own: an
-- auth.users row (a synthetic address) and, with organization_id, an
-- organization_members row (role user and status active unless the row says
-- otherwise).
create function pg_temp.par_tables() returns text[] language sql immutable as $$
  select array['organizations', 'users', 'organization_members', 'teams', 'team_members', 'courses',
               'course_versions', 'learning_paths', 'learning_path_courses', 'journey_programs', 'journey_days',
               'journey_versions', 'journey_enrollments', 'course_assignments', 'learning_path_assignments',
               'course_attempts', 'attempt_requests', 'journey_day_progress', 'learning_path_completions',
               'learning_path_step_completions', 'gamification_settings']
$$;

-- The NOT NULL columns a case does not care about; the row overrides each.
create function pg_temp.par_defaults(p_table text, r jsonb) returns jsonb language sql immutable as $$
  select (case p_table
    when 'organizations' then jsonb_build_object('name', 'parity', 'slug', 'parity-' || (r ->> 'id'))
    when 'teams' then jsonb_build_object('name', 'parity', 'slug', 'parity-' || (r ->> 'id'))
    when 'courses' then jsonb_build_object('title', 'parity', 'slug', 'parity-' || (r ->> 'id'))
    when 'course_versions' then jsonb_build_object(
      'version_number', 1, 'manifest_type', 'scorm12', 'launch_url', 'index.html',
      'storage_prefix', 'parity/' || (r ->> 'id') || '/', 'manifest_data', '{}'::jsonb,
      'package_id', md5((r ->> 'id') || 'pkg')::uuid)
    when 'learning_paths' then jsonb_build_object('name', 'parity', 'slug', 'parity-' || (r ->> 'id'))
    when 'journey_programs' then jsonb_build_object('name', 'parity-' || (r ->> 'id'))
    when 'journey_versions' then jsonb_build_object('name', 'parity', 'completion_title', 'parity',
                                                    'version_number', 1, 'count_sundays', false)
    else '{}'::jsonb
  end) || r
$$;

-- One row into one table, through jsonb_populate_record: the insert names
-- exactly the row's keys and the defaults', never a generated column; then
-- each generated column the row names is compared with the stored value.
create function pg_temp.par_put(p_table text, r jsonb) returns void language plpgsql as $$
declare
  v_row  jsonb;
  v_gen  text[];
  v_cols text[];
  v_bad  text[];
  v_list text;
  g      text;
  v_got  text;
begin
  if p_table = 'users' then
    insert into auth.users (id, email)
    values ((r ->> 'id')::uuid, 'parity-' || right(r ->> 'id', 12) || '@example.test');
    if r ? 'organization_id' then
      insert into public.organization_members (organization_id, user_id, role, status)
      values ((r ->> 'organization_id')::uuid, (r ->> 'id')::uuid,
              coalesce(r ->> 'role', 'user')::public.org_role, coalesce(r ->> 'status', 'active'));
    end if;
    return;
  end if;
  if p_table = 'course_versions' then
    insert into public.course_packages (id, course_id)
    values (md5((r ->> 'id') || 'pkg')::uuid, (r ->> 'course_id')::uuid)
    on conflict (id) do nothing;
  end if;
  if p_table = 'gamification_settings' then
    -- an organisation's insert writes its default settings row (a trigger);
    -- the fixture's row replaces it
    delete from public.gamification_settings where organization_id = (r ->> 'organization_id')::uuid;
  end if;
  v_row := pg_temp.par_defaults(p_table, r);
  if p_table = 'journey_programs' then
    v_row := v_row - 'current_version_id';
  end if;
  select coalesce(array_agg(a.attname::text), '{}') into v_gen
    from pg_attribute a
   where a.attrelid = ('public.' || p_table)::regclass and a.attnum > 0 and not a.attisdropped
     and a.attgenerated <> '';
  select coalesce(array_agg(k order by k), '{}') into v_cols
    from jsonb_object_keys(v_row) as k
   where not (k = any(v_gen));
  select coalesce(array_agg(k), '{}') into v_bad
    from unnest(v_cols) as k
   where not exists (select 1 from pg_attribute a
                      where a.attrelid = ('public.' || p_table)::regclass and a.attname = k
                        and a.attnum > 0 and not a.attisdropped);
  if cardinality(v_bad) > 0 then
    raise exception 'assert-0107: (P) % has no column %', p_table, array_to_string(v_bad, ', ');
  end if;
  select string_agg(format('%I', k), ', ') into v_list from unnest(v_cols) as k;
  execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I, $1)',
                 p_table, v_list, v_list, p_table)
    using v_row;
  foreach g in array v_gen loop
    if r ? g then
      execute format('select %I::text from public.%I where id = $1', g, p_table) into v_got using (r ->> 'id')::uuid;
      if v_got is distinct from (r ->> g) then
        raise exception 'assert-0107: (P) %.% of % is generated as % (the fixture says %)',
          p_table, g, r ->> 'id', coalesce(v_got, 'null'), coalesce(r ->> g, 'null');
      end if;
    end if;
  end loop;
end
$$;

-- Every table of a world or of a case's given, in the scaffold's order;
-- then each journey program's current_version_id, once its versions exist.
create function pg_temp.par_load(p_tables jsonb) returns void language plpgsql as $$
declare
  t text;
  r jsonb;
  v_unknown text;
begin
  if p_tables is null or p_tables = '{}'::jsonb then
    return;
  end if;
  select string_agg(k, ', ') into v_unknown
    from jsonb_object_keys(p_tables) as k
   where not (k = any(pg_temp.par_tables()));
  if v_unknown is not null then
    raise exception 'assert-0107: (P) the scaffold has no table %', v_unknown;
  end if;
  foreach t in array pg_temp.par_tables() loop
    for r in select x from jsonb_array_elements(coalesce(p_tables -> t, '[]'::jsonb)) as x loop
      perform pg_temp.par_put(t, r);
    end loop;
  end loop;
  for r in select x from jsonb_array_elements(coalesce(p_tables -> 'journey_programs', '[]'::jsonb)) as x
            where x ? 'current_version_id' loop
    update public.journey_programs set current_version_id = (r ->> 'current_version_id')::uuid
     where id = (r ->> 'id')::uuid;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- The comparator (contract 6.2 rule 5): objects key by key (a key on one
-- side only is a mismatch), arrays in order, numbers at 4 decimals, an ISO
-- time against an ISO time as timestamptz, anything else as jsonb.
-- ---------------------------------------------------------------------------
create function pg_temp.par_diff(p text, want jsonb, got jsonb) returns setof text language plpgsql as $$
declare
  k  text;
  i  int;
  tw text := jsonb_typeof(want);
  tg text := jsonb_typeof(got);
  c_time constant text := '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}';
begin
  if tw = 'object' and tg = 'object' then
    for k in select x from jsonb_object_keys(want) as x union select x from jsonb_object_keys(got) as x order by 1 loop
      if not want ? k then
        return next format('%s.%s: not in expect (got %s)', p, k, got -> k);
      elsif not got ? k then
        return next format('%s.%s: expected %s, not produced', p, k, want -> k);
      else
        return query select * from pg_temp.par_diff(p || '.' || k, want -> k, got -> k);
      end if;
    end loop;
  elsif tw = 'array' and tg = 'array' then
    if jsonb_array_length(want) <> jsonb_array_length(got) then
      return next format('%s: expected %s, got %s', p, want, got);
    else
      for i in 0 .. jsonb_array_length(want) - 1 loop
        return query select * from pg_temp.par_diff(p || '[' || i || ']', want -> i, got -> i);
      end loop;
    end if;
  elsif tw = 'number' and tg = 'number' then
    if round((want #>> '{}')::numeric, 4) <> round((got #>> '{}')::numeric, 4) then
      return next format('%s: expected %s, got %s', p, want, got);
    end if;
  elsif tw = 'string' and tg = 'string' and (want #>> '{}') ~ c_time and (got #>> '{}') ~ c_time then
    if (want #>> '{}')::timestamptz <> (got #>> '{}')::timestamptz then
      return next format('%s: expected %s, got %s', p, want, got);
    end if;
  elsif want is distinct from got then
    return next format('%s: expected %s, got %s', p, coalesce(want::text, 'absent'), coalesce(got::text, 'absent'));
  end if;
end
$$;

-- An object restricted to some keys (the side's share of expect).
create function pg_temp.par_only(o jsonb, p_keys text[]) returns jsonb language sql immutable as $$
  select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) from jsonb_each(o) as e where e.key = any(p_keys)
$$;

-- record_learning_activity's answer, projected on expect.writer's fields
-- (build note O1-c: a path row's fact is present after the call; its
-- done_at is the call's now(), so only its presence is compared).
create function pg_temp.par_writer(p_attempt uuid) returns jsonb language plpgsql as $$
declare
  w jsonb;
  v_fact boolean;
begin
  w := public.record_learning_activity(p_attempt);
  select exists (
    select 1
      from public.course_attempts ca
      join public.course_versions cv on cv.id = ca.course_version_id
      join public.learning_path_step_completions f
        on f.path_id = ca.learning_path_id and f.user_id = ca.user_id and f.course_id = cv.course_id
     where ca.id = p_attempt and ca.context_kind = 'path') into v_fact;
  return jsonb_build_object(
    'official', w -> 'official', 'done', w -> 'done', 'passed_ever', w -> 'passed_ever',
    'passed_by_rule', w -> 'passed_by_rule', 'path_completed', w -> 'path_completed',
    'attempt_number', w -> 'attempt_number', 'fact_written', v_fact);
end
$$;

-- ---------------------------------------------------------------------------
-- The SQL answer of each pair for one case (contract 6.5)
-- ---------------------------------------------------------------------------
create function pg_temp.par_official(c jsonb) returns setof text language plpgsql as $$
declare
  v_user   uuid := (c #>> '{call,user_id}')::uuid;
  v_course uuid := (c #>> '{call,course_id}')::uuid;
  v_key    text := c #>> '{call,context_key}';
  s        record;
  m        record;
  v_fn     uuid;
  got      jsonb;
  c_fields constant text[] := array['official_attempt_id', 'official_status', 'official_score', 'first_score',
    'best_score', 'latest_score', 'completed_attempts', 'scored_attempts', 'practice_attempts', 'attempt_count',
    'live_attempt_count', 'pass_required'];
begin
  select * into s from public.v_context_attempt_scoring x
   where x.user_id = v_user and x.course_id = v_course and x.context_key = v_key;
  select * into m from public.v_context_attempt_summary x
   where x.user_id = v_user and x.course_id = v_course and x.context_key = v_key;
  got := jsonb_build_object(
    'official_attempt_id', s.official_attempt_id, 'official_status', s.official_status,
    'official_score', s.official_score, 'first_score', s.first_score, 'best_score', s.best_score,
    'latest_score', s.latest_score, 'completed_attempts', coalesce(s.completed_attempts, 0),
    'scored_attempts', coalesce(s.scored_attempts, 0), 'practice_attempts', coalesce(s.practice_attempts, 0),
    'attempt_count', coalesce(m.attempt_count, 0), 'live_attempt_count', coalesce(m.live_attempt_count, 0),
    'pass_required', public.instance_pass_required(v_course, v_key));
  return query select * from pg_temp.par_diff('expect', pg_temp.par_only(c -> 'expect', c_fields), got);
  v_fn := public.official_attempt_in_context(v_user, v_course, v_key);
  if v_fn is distinct from s.official_attempt_id then
    return next format('official_attempt_in_context: %s, the view: %s', coalesce(v_fn::text, 'null'),
                       coalesce(s.official_attempt_id::text, 'null'));
  end if;
  if (c ->> 'writer')::boolean then
    return query select * from pg_temp.par_diff('expect.writer', c #> '{expect,writer}',
                                                pg_temp.par_writer((c #>> '{call,writer_attempt_id}')::uuid));
  end if;
end
$$;

create function pg_temp.par_path(c jsonb) returns setof text language plpgsql as $$
declare
  v_path uuid := (c #>> '{call,path_id}')::uuid;
  v_user uuid := (c #>> '{call,user_id}')::uuid;
  got    jsonb;
begin
  got := jsonb_build_object(
    'steps', coalesce((
      select jsonb_agg(jsonb_build_object(
               'course_id', st.course_id, 'step_number', st.step_number, 'release_at', st.release_at,
               'pass_required', st.pass_required, 'passed_ever', st.passed_ever, 'passed_by_rule', st.passed_by_rule,
               'done_recorded_at', st.done_recorded_at, 'latest_result', st.latest_result,
               'latest_score', st.latest_score, 'done', st.done, 'official_attempt_id', st.official_attempt_id,
               'retake_live', st.retake_live, 'failed', st.failed, 'open_attempt', st.open_attempt)
             order by st.step_number, st.course_id)
        from public.v_path_step_status st
       where st.path_id = v_path and st.user_id = v_user), '[]'::jsonb),
    'progress', (
      select jsonb_build_object(
               'steps_total', pr.steps_total, 'steps_done', pr.steps_done, 'next_step', pr.next_step,
               'next_course_id', pr.next_course_id, 'path_score', pr.path_score, 'completed', pr.completed,
               'status', pr.status, 'due_at', pr.due_at, 'enrolled_at', pr.enrolled_at,
               'started_at', pr.started_at, 'completed_at', pr.completed_at, 'overdue', pr.overdue)
        from public.v_path_progress pr
       where pr.path_id = v_path and pr.user_id = v_user),
    'terms', (
      select jsonb_build_object('due_at', t.due_at, 'enrolled_at', t.enrolled_at)
        from public.v_path_enrollment_terms t
       where t.path_id = v_path and t.user_id = v_user));
  return query select * from pg_temp.par_diff('expect', pg_temp.par_only(c -> 'expect', array['steps', 'progress', 'terms']), got);
  if (c ->> 'writer')::boolean then
    return query select * from pg_temp.par_diff('expect.writer', c #> '{expect,writer}',
                                                pg_temp.par_writer((c #>> '{call,writer_attempt_id}')::uuid));
  end if;
end
$$;

create function pg_temp.par_journey(c jsonb) returns setof text language plpgsql as $$
declare
  v_enr uuid := (c #>> '{call,enrollment_id}')::uuid;
  s     record;
  rc    record;
  n     int;
begin
  select count(*) into n from public.journey_credit_state(array[v_enr]);
  if n <> 1 then
    return next format('journey_credit_state: %s rows for the enrolment (expected 1)', n);
    return;
  end if;
  select * into s from public.journey_credit_state(array[v_enr]);
  return query select * from pg_temp.par_diff('expect', c -> 'expect', jsonb_build_object(
    'required_days', s.required_days, 'credited_days', s.credited_days, 'credited', to_jsonb(s.credited),
    'credited_day_ids', to_jsonb(s.credited_day_ids), 'next_day', s.next_day, 'next_day_id', s.next_day_id,
    'finished', s.required_days > 0 and s.next_day is null, 'resumable_day_ids', to_jsonb(s.resumable_day_ids)));
  select * into rc from public.journey_reminder_counts(array[v_enr]);
  if rc.done is distinct from s.credited_days or rc.credited is distinct from s.credited then
    return next format('journey_reminder_counts: done %s credited %s, journey_credit_state: %s and %s',
                       rc.done, rc.credited, s.credited_days, s.credited);
  end if;
end
$$;

create function pg_temp.par_launch(c jsonb) returns setof text language plpgsql as $$
declare
  k jsonb := c -> 'call';
begin
  return query select * from pg_temp.par_diff('expect.facts', c #> '{expect,facts}', public.launch_context(
    (k ->> 'user_id')::uuid, (k ->> 'org_id')::uuid, (k ->> 'course_id')::uuid, (k ->> 'path_id')::uuid,
    (k ->> 'enrollment_id')::uuid, (k ->> 'day_id')::uuid, (k ->> 'day')::integer));
end
$$;

-- One case in a subtransaction undone after it: its rows, its reads, its
-- mismatches (a local variable keeps them past the undo).
create function pg_temp.par_case(p_pair text, c jsonb) returns text[] language plpgsql as $$
declare
  bad text[] := '{}';
begin
  begin
    perform pg_temp.par_load(c -> 'given');
    if p_pair = 'official' then
      bad := array(select * from pg_temp.par_official(c));
    elsif p_pair = 'path' then
      bad := array(select * from pg_temp.par_path(c));
    elsif p_pair = 'journey' then
      bad := array(select * from pg_temp.par_journey(c));
    else
      bad := array(select * from pg_temp.par_launch(c));
    end if;
    raise exception using errcode = 'R0107', message = 'assert-0107: undo';
  exception when others then
    if sqlstate <> 'R0107' then
      bad := bad || format('error %s: %s', sqlstate, sqlerrm);
    end if;
  end;
  return bad;
end
$$;

-- One pair: its world, then every case the SQL side runs, all undone.
create temporary table r0107_parity (pair text, name text, bad text[]);

-- The results are kept in a local variable and written after the undo.
create function pg_temp.par_pair(p_pair text) returns void language plpgsql as $$
declare
  d   jsonb;
  c   jsonb;
  res jsonb := '[]'::jsonb;
begin
  select doc into d from pg_temp.parity_cases where pair = p_pair;
  begin
    perform pg_temp.par_load(d -> 'world');
    for c in select x from jsonb_array_elements(d -> 'cases') as x where x -> 'sides' ? 'sql' loop
      res := res || jsonb_build_array(jsonb_build_object('name', c ->> 'name', 'bad', to_jsonb(pg_temp.par_case(p_pair, c))));
    end loop;
    raise exception using errcode = 'R0107', message = 'assert-0107: undo';
  exception when others then
    if sqlstate <> 'R0107' then
      res := res || jsonb_build_array(jsonb_build_object('name', '(the world)',
                                                         'bad', jsonb_build_array(format('error %s: %s', sqlstate, sqlerrm))));
    end if;
  end;
  insert into pg_temp.r0107_parity
  select p_pair, x ->> 'name', array(select jsonb_array_elements_text(x -> 'bad'))
    from jsonb_array_elements(res) as x;
end
$$;

-- ---------------------------------------------------------------------------
-- (P0) the four documents
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('pg_temp.parity_cases') is null then
    raise exception 'assert-0107: (P0) the parity cases are not loaded (run.mjs''s cases step comes first)';
  end if;
  if (select array_agg(pair order by pair) from pg_temp.parity_cases) is distinct from
     array['journey', 'launch', 'official', 'path'] then
    raise exception 'assert-0107: (P0) the parity documents loaded are % (expected the four pairs)',
      (select array_agg(pair order by pair) from pg_temp.parity_cases);
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (P1) to (P4)
-- ---------------------------------------------------------------------------
select pg_temp.par_pair('official');
select pg_temp.par_pair('path');
select pg_temp.par_pair('journey');
select pg_temp.par_pair('launch');

do $$
declare
  failed text;
  ran    text;
  want   text;
begin
  select string_agg(format('(P%s) %s: %s',
                           array_position(array['official', 'path', 'journey', 'launch'], r.pair), r.name,
                           array_to_string(r.bad, ' | ')), '; ' order by r.pair, r.name)
    into failed
    from pg_temp.r0107_parity r
   where cardinality(r.bad) > 0;
  if failed is not null then
    raise exception 'assert-0107: %', failed;
  end if;
  -- every case the files give the SQL side ran, once
  select string_agg(p.pair || '=' || (select count(*) from pg_temp.r0107_parity r
                                       where r.pair = p.pair and r.name <> '(the world)'), ' ' order by p.pair),
         string_agg(p.pair || '=' || (select count(*) from jsonb_array_elements(p.doc -> 'cases') as x
                                       where x -> 'sides' ? 'sql'), ' ' order by p.pair)
    into ran, want
    from pg_temp.parity_cases p;
  if ran is distinct from want then
    raise exception 'assert-0107: (P0) cases run on the SQL side: % (the files give %)', ran, want;
  end if;
  -- H1: the both-sided counts, pinned (parity-cases.mjs BOTH_SIDED)
  if ran is distinct from 'journey=17 launch=28 official=17 path=27' then
    raise exception 'assert-0107: (P0) cases run on the SQL side: % (pinned: journey=17 launch=28 official=17 path=27)', ran;
  end if;
  raise notice 'assert-0107: parity, the SQL side: % cases agree (%)', (select count(*) from pg_temp.r0107_parity), ran;
end
$$;

rollback;
