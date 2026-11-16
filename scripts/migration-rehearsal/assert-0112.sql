-- scripts/migration-rehearsal/assert-0112.sql
-- Scenarios "0107-then-0112" (after 0112's two pastes, and again after 0108)
-- and "0107-0112-then-0107-then-0112" (after each paste of 0112): what
-- 0112_sweep_time_box.sql (ADR 0024 step 16, note of 2026-11-16, items 1 to
-- 3 and step S2) must have done.
--   (1) the objects: the five functions, their arguments, results,
--       language, volatility, security definer, search_path (and the timed
--       sweep's lock_timeout 1s), comments and execute matrix; one form of
--       each sweep name (a new name, not an overload); the refresh bodies
--       call the timed sweep with the 1500 ms box and never the unboxed
--       one; the wrapper calls it with 5000; in the timed sweep the
--       argument checks come before the advisory lock, and the lock before
--       the loop (read on the stored body: 'busy' itself cannot be shown in
--       one session, where an advisory lock is re-entrant; it is proven by
--       hand at the staging paste, S3)
--   (2) the arguments: a null or zero p_limit, and a null, zero or 6001 box,
--       raise 22023; 1 and 6000 are accepted; the wrapper keeps 0107's
--       22023 and message
--   (3) the time box, in a form that does not depend on the clock's grain:
--       inside a savepoint the writer is replaced by a body that sleeps
--       50 ms and stamps the row; over a queue of at least 6 rows a box of
--       120 ms answers 'time', handles at least 1 row and fewer than the
--       queue, and exactly the handled rows read stamped after the call,
--       the oldest by the sweep's own order; a box of 1 ms answers 'time'
--       and handles at most 1 row
--   (4) the real writer: p_limit 1 answers 'limit' and handles the oldest
--       row; the one-argument form answers exactly 0107's four keys; a
--       large box answers 'done', handles the rest, and the backlog reads 0;
--       the six keys of the answer; candidates = handled + failed
--   (5) a row whose writer call raises 55P03 (a lock wait past the 1 s
--       lock_timeout) is counted in failed with that code, stays a
--       candidate, and the rows after it are still handled
--   (6) both refresh functions answer seven and three entries, every view
--       entry refreshed with its error null, the five-key completion_sweep
--       entry last, its sweep the six-key answer; with a writer that sleeps
--       200 ms and at least 10 rows queued before each call, each refresh's
--       sweep stops on its 1500 ms box ('time', fewer rows handled than
--       queued)
--   (7) assert-0107-launch.sql (45b) with the timed sweep replaced: a sweep
--       that raises is the entry's own error (rows and sweep null), every
--       view still refreshed; after the rollback the real body is back
--   (8) completion_sweep_backlog() equals a count by 0107's predicate
--       (0107:5760-5765) and the smallest ordering key, and writes nothing
-- The fixture rows have ids whose last group starts 000112. The whole file
-- is one transaction that ends in ROLLBACK; every check runs in its own
-- savepoint, rolled back to it. Every check raises 'assert-0112: (n) ...' on
-- failure. PGlite runs as postgres (the owner).
begin;

create function pg_temp.u12(p text) returns uuid language sql immutable as $$
  select ('00000000-0000-0000-0000-' || p)::uuid
$$;

create function pg_temp.keys(p jsonb) returns text language sql immutable as $$
  select coalesce(string_agg(k, ',' order by k), '') from jsonb_object_keys(p) as k
$$;

-- One statement, undone: its SQLSTATE ('ok' when none)
create function pg_temp.state12(p_stmt text) returns text
language plpgsql as $$
declare
  st text;
begin
  begin
    execute p_stmt;
    raise exception using errcode = 'R0112', message = 'assert-0112: undo';
  exception when others then
    st := sqlstate;
  end;
  return case when st = 'R0112' then 'ok' else st end;
end
$$;

-- The sweep's queue in its own order (0107:5760-5766), as ids
create function pg_temp.queue12() returns uuid[] language sql stable as $$
  select coalesce(array_agg(q.id order by q.k, q.id), '{}')
    from (select ca.id, greatest(ca.started_at, ca.completed_at, ca.last_activity_at) as k
            from public.course_attempts ca
           where (ca.completion_status = 'completed' or ca.success_status = 'passed')
             and not ca.is_revision
             and ca.context_kind <> 'preview'
             and ca.status <> 'abandoned'
             and ca.side_effects_sig is distinct from ca.settle_sig
             and greatest(ca.started_at, ca.completed_at, ca.last_activity_at) < now() - interval '2 minutes') q
$$;

-- Whether a row is stamped (handled by the writer)
create function pg_temp.stamped12(p_id uuid) returns boolean language sql stable as $$
  select ca.side_effects_sig is not distinct from ca.settle_sig from public.course_attempts ca where ca.id = p_id
$$;

-- The fixture world, in Org A of seed.sql: six learners, course K12 with
-- one SCORM 1.2 version
insert into auth.users (id, email)
select pg_temp.u12('00011201000' || n), format('learner-%s-0112@example.test', n)
  from generate_series(1, 6) n;
insert into public.organization_members (organization_id, user_id, role)
select '00000000-0000-0000-0000-00000000000a', pg_temp.u12('00011201000' || n), 'user'
  from generate_series(1, 6) n;
insert into public.courses (id, organization_id, title, slug) values
  (pg_temp.u12('000112040001'), '00000000-0000-0000-0000-00000000000a', 'K12 (0112)', 'k12-0112');
insert into public.course_packages (id, course_id, language, is_active) values
  (pg_temp.u12('000112040101'), pg_temp.u12('000112040001'), null, true);
insert into public.course_versions (id, course_id, package_id, version_number, manifest_type, launch_url, storage_prefix, manifest_data) values
  (pg_temp.u12('000112040201'), pg_temp.u12('000112040001'), pg_temp.u12('000112040101'),
   1, 'scorm12', 'index.html', 'courses/k12-0112/v1/', '{"title":"K12 (0112)"}');
update public.course_packages set current_version_id = pg_temp.u12('000112040201') where id = pg_temp.u12('000112040101');
update public.courses set current_version_id = pg_temp.u12('000112040201') where id = pg_temp.u12('000112040001');

-- A completed Individual attempt of K12, the official one of its learner,
-- never handled; its ordering key p_days days back (older than every
-- fixture of the seeds, so the seeded queue stands at its head)
create function pg_temp.att12(p_id uuid, p_user uuid, p_days int) returns uuid
language sql as $$
  insert into public.course_attempts (id, course_version_id, user_id, organization_id, status, completion_status,
                                      success_status, score, started_at, completed_at, context_kind, launch_mode)
  values (p_id, pg_temp.u12('000112040201'), p_user, '00000000-0000-0000-0000-00000000000a',
          'completed', 'completed', 'unknown', null,
          now() - make_interval(days => 3650 - p_days, mins => 5), now() - make_interval(days => 3650 - p_days),
          'individual', 'Normal')
  returning id
$$;

-- n queued rows, numbered from first: row k is learner k's (1 to 6, then
-- new users), so each is the official attempt of its own learner; row k is
-- older than row k + 1
create function pg_temp.queue_rows12(n int, first int default 1) returns void
language plpgsql as $$
declare
  k int;
  u uuid;
begin
  for k in first .. first + n - 1 loop
    if k <= 6 then
      u := pg_temp.u12('00011201000' || k);
    else
      u := pg_temp.u12('0001120' || lpad(k::text, 5, '0'));
      insert into auth.users (id, email) values (u, format('learner-%s-0112@example.test', k)) on conflict do nothing;
    end if;
    perform pg_temp.att12(pg_temp.u12('0001128' || lpad(k::text, 5, '0')), u, k);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- (1) the objects
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
      ('public.sweep_completion_side_effects_timed(integer,integer)', 'p_limit integer, p_budget_ms integer', 'plpgsql', 'v',
       array['search_path=pg_catalog, public', 'lock_timeout=1s']),
      ('public.completion_sweep_backlog()',                           '',                                    'sql',     's',
       array['search_path=pg_catalog, public']),
      ('public.sweep_completion_side_effects(integer)',               'p_limit integer',                     'plpgsql', 'v',
       array['search_path=pg_catalog, public']),
      ('public.refresh_report_views()',                               '',                                    'plpgsql', 'v',
       array['search_path=pg_catalog, public']),
      ('public.refresh_gamification_views()',                         '',                                    'plpgsql', 'v',
       array['search_path=pg_catalog, public'])
    ) as t(fn, args, lang, vol, cfg)
  loop
    select pg_get_function_arguments(p.oid) as args, p.prorettype::regtype::text as ret, l.lanname::text as lang,
           p.provolatile::text as vol, p.prosecdef, p.proconfig, obj_description(p.oid, 'pg_proc') as cmt
      into g
      from pg_proc p join pg_language l on l.oid = p.prolang
     where p.oid = to_regprocedure(r.fn);
    if not found then
      bad := bad || format('%s is missing', r.fn);
      continue;
    end if;
    if g.args <> r.args or g.ret <> 'jsonb' or g.lang <> r.lang or g.vol <> r.vol or not g.prosecdef
       or g.proconfig is distinct from r.cfg or g.cmt is null then
      bad := bad || format('%s: (%s) %s %s %s definer %s config %s comment %s', r.fn, g.args, g.ret, g.lang, g.vol,
                           g.prosecdef, g.proconfig, g.cmt is not null);
    end if;
    if has_function_privilege('public', to_regprocedure(r.fn), 'EXECUTE')
       or has_function_privilege('anon', to_regprocedure(r.fn), 'EXECUTE')
       or has_function_privilege('authenticated', to_regprocedure(r.fn), 'EXECUTE')
       or not has_function_privilege('service_role', to_regprocedure(r.fn), 'EXECUTE') then
      bad := bad || format('%s: the execute matrix is not service_role only', r.fn);
    end if;
  end loop;

  if (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
         and p.proname = 'sweep_completion_side_effects') <> 1
     or (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
            and p.proname = 'sweep_completion_side_effects_timed') <> 1
     or (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
            and p.proname = 'completion_sweep_backlog') <> 1 then
    bad := bad || 'a sweep name has more than one form (0112 adds a name, not an overload)'::text;
  end if;

  for r in select * from (values ('public.refresh_report_views()'), ('public.refresh_gamification_views()')) as t(fn)
  loop
    select p.prosrc into src from pg_proc p where p.oid = to_regprocedure(r.fn);
    if (length(src) - length(replace(src, 'public.sweep_completion_side_effects_timed(200, 1500)', '')))
         / length('public.sweep_completion_side_effects_timed(200, 1500)') <> 1
       or position('sweep_completion_side_effects(' in src) > 0
       or position('purge_preview_data' in src) > 0 then
      bad := bad || format('%s does not call the timed sweep exactly once with (200, 1500), or still calls the '
                           || 'unboxed sweep, or names the purge', r.fn);
    end if;
  end loop;

  select p.prosrc into src from pg_proc p where p.oid = 'public.sweep_completion_side_effects(integer)'::regprocedure;
  if position('public.sweep_completion_side_effects_timed(p_limit, 5000)' in src) = 0 then
    bad := bad || 'the one-argument form does not call the timed sweep with a 5000 ms box'::text;
  end if;

  select p.prosrc into src from pg_proc p
   where p.oid = 'public.sweep_completion_side_effects_timed(integer,integer)'::regprocedure;
  if not (position('p_limit must be 1 or more' in src) > 0
          and position('p_limit must be 1 or more' in src) < position('p_budget_ms must be 1 to 6000' in src)
          and position('p_budget_ms must be 1 to 6000' in src) < position('pg_try_advisory_xact_lock(112, 16)' in src)
          and position('pg_try_advisory_xact_lock(112, 16)' in src) < position('for r in' in src)
          and position('for r in' in src) < position('clock_timestamp() >= v_deadline' in src)
          and position('clock_timestamp() >= v_deadline' in src) < position('v_found := v_found + 1' in src)) then
    bad := bad || 'the timed sweep does not check its arguments, then take the key, then loop with the deadline '
                  'tested before each row is counted'::text;
  end if;

  if cardinality(bad) > 0 then
    raise exception 'assert-0112: (1) %', array_to_string(bad, '; ');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (2) the arguments
-- ---------------------------------------------------------------------------
do $$
declare
  bad text[] := '{}';
  r   record;
  msg text;
begin
  for r in
    select * from (values
      ('select public.sweep_completion_side_effects_timed(null, 100)', '22023'),
      ('select public.sweep_completion_side_effects_timed(0, 100)',    '22023'),
      ('select public.sweep_completion_side_effects_timed(1, null)',   '22023'),
      ('select public.sweep_completion_side_effects_timed(1, 0)',      '22023'),
      ('select public.sweep_completion_side_effects_timed(1, 6001)',   '22023'),
      ('select public.sweep_completion_side_effects_timed(1, 1)',      'ok'),
      ('select public.sweep_completion_side_effects_timed(1, 6000)',   'ok'),
      ('select public.sweep_completion_side_effects(null)',            '22023'),
      ('select public.sweep_completion_side_effects(0)',               '22023'),
      ('select public.sweep_completion_side_effects(1)',               'ok')
    ) as t(stmt, want)
  loop
    if pg_temp.state12(r.stmt) <> r.want then
      bad := bad || format('%s answered %s, not %s', r.stmt, pg_temp.state12(r.stmt), r.want);
    end if;
  end loop;
  begin
    perform public.sweep_completion_side_effects(0);
  exception when others then
    msg := sqlerrm;
  end;
  if msg is distinct from 'sweep_completion_side_effects: p_limit must be 1 or more (ADR 0024)' then
    bad := bad || format('the one-argument form''s refusal reads %s, not 0107''s message', coalesce(msg, 'nothing'));
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0112: (2) %', array_to_string(bad, '; ');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (3) the time box (the writer replaced by a body that sleeps 50 ms and
-- stamps the row, inside a savepoint that is rolled back)
-- ---------------------------------------------------------------------------
savepoint s3;

create or replace function public.record_learning_activity(p_attempt_id uuid, p_activity boolean)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform pg_sleep(0.05);
  update public.course_attempts set side_effects_sig = settle_sig where id = p_attempt_id;
  return '{}'::jsonb;
end
$$;

do $$
declare
  bad     text[] := '{}';
  q       uuid[];
  a       jsonb;
  n       int;
  stamped uuid[];
begin
  perform pg_temp.queue_rows12(6);
  q := pg_temp.queue12();
  if cardinality(q) < 6 then
    raise exception 'assert-0112: (3) the seeded queue holds % rows, not at least 6', cardinality(q);
  end if;
  a := public.sweep_completion_side_effects_timed(100, 120);
  n := (a ->> 'handled')::int;
  if a ->> 'stopped' is distinct from 'time' or n < 1 or n >= cardinality(q)
     or (a ->> 'failed')::int <> 0 or (a ->> 'candidates')::int <> n
     or pg_temp.keys(a) <> 'candidates,errors,failed,handled,ms,stopped' or jsonb_typeof(a -> 'ms') <> 'number' then
    bad := bad || format('a 120 ms box over %s queued rows of 50 ms answered %s (expected time, at least 1 and fewer '
                         || 'than the queue handled)', cardinality(q), a);
  end if;
  select coalesce(array_agg(x order by i), '{}') into stamped
    from unnest(q) with ordinality as u(x, i) where pg_temp.stamped12(x);
  if stamped is distinct from q[1:n] then
    bad := bad || format('after the call the stamped rows are %s of the queue, not its %s oldest',
                         cardinality(stamped), n);
  end if;

  -- a 1 ms box: the deadline is tested before the first row too
  q := pg_temp.queue12();
  a := public.sweep_completion_side_effects_timed(100, 1);
  if a ->> 'stopped' is distinct from 'time' or (a ->> 'handled')::int > 1 or cardinality(q) < 2 then
    bad := bad || format('a 1 ms box answered %s over %s queued rows (expected time and at most 1 handled)',
                         a, cardinality(q));
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0112: (3) %', array_to_string(bad, '; ');
  end if;
end
$$;

rollback to savepoint s3;

-- ---------------------------------------------------------------------------
-- (4) the real writer: 'limit', the four keys, 'done'
-- ---------------------------------------------------------------------------
savepoint s4;
do $$
declare
  bad text[] := '{}';
  q   uuid[];
  a   jsonb;
  b   jsonb;
begin
  perform pg_temp.queue_rows12(6);
  q := pg_temp.queue12();
  a := public.sweep_completion_side_effects_timed(1, 6000);
  if a ->> 'stopped' is distinct from 'limit' or (a ->> 'candidates')::int <> 1 or (a ->> 'handled')::int <> 1
     or not pg_temp.stamped12(q[1]) or pg_temp.stamped12(q[2]) then
    bad := bad || format('p_limit 1 answered %s (expected limit, the oldest row handled and the next one not)', a);
  end if;
  b := public.sweep_completion_side_effects(1);
  if pg_temp.keys(b) <> 'candidates,errors,failed,handled' or (b ->> 'handled')::int <> 1 or not pg_temp.stamped12(q[2]) then
    bad := bad || format('the one-argument form answered %s (expected 0107''s four keys, the next row handled)', b);
  end if;
  a := public.sweep_completion_side_effects_timed(1000, 6000);
  if a ->> 'stopped' is distinct from 'done' or (a ->> 'handled')::int <> cardinality(q) - 2 or (a ->> 'failed')::int <> 0
     or (a ->> 'candidates')::int <> (a ->> 'handled')::int + (a ->> 'failed')::int
     or pg_temp.keys(a) <> 'candidates,errors,failed,handled,ms,stopped' or jsonb_typeof(a -> 'ms') <> 'number' then
    bad := bad || format('a large box answered %s over %s remaining rows (expected done, every row handled)',
                         a, cardinality(q) - 2);
  end if;
  if (public.completion_sweep_backlog() ->> 'candidates')::int <> 0 or cardinality(pg_temp.queue12()) <> 0 then
    bad := bad || format('after done the backlog reads %s', public.completion_sweep_backlog());
  end if;
  a := public.sweep_completion_side_effects_timed(10, 6000);
  if a ->> 'stopped' is distinct from 'done' or (a ->> 'candidates')::int <> 0 then
    bad := bad || format('an empty queue answered %s (expected done, 0 candidates)', a);
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0112: (4) %', array_to_string(bad, '; ');
  end if;
end
$$;
rollback to savepoint s4;

-- ---------------------------------------------------------------------------
-- (5) a row that waits on a lock past the lock_timeout (55P03)
-- ---------------------------------------------------------------------------
savepoint s5;

create or replace function public.record_learning_activity(p_attempt_id uuid, p_activity boolean)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_attempt_id = pg_temp.u12('000112800001') then
    raise exception 'assert-0112 (5): a lock wait past the lock_timeout' using errcode = '55P03';
  end if;
  update public.course_attempts set side_effects_sig = settle_sig where id = p_attempt_id;
  return '{}'::jsonb;
end
$$;

do $$
declare
  bad text[] := '{}';
  q   uuid[];
  a   jsonb;
begin
  perform pg_temp.queue_rows12(6);
  q := pg_temp.queue12();
  if q[1] is distinct from pg_temp.u12('000112800001') then
    raise exception 'assert-0112: (5) the row that waits is not at the head of the queue';
  end if;
  a := public.sweep_completion_side_effects_timed(100, 6000);
  if (a ->> 'failed')::int <> 1 or (a ->> 'handled')::int <> cardinality(q) - 1 or a ->> 'stopped' is distinct from 'done'
     or (a -> 'errors') <> jsonb_build_array(jsonb_build_object('attempt_id', q[1], 'sqlstate', '55P03')) then
    bad := bad || format('the sweep answered %s (expected the head row failed with 55P03 and the %s after it handled)',
                         a, cardinality(q) - 1);
  end if;
  if pg_temp.stamped12(q[1]) or exists (select 1 from unnest(q[2:]) x where not pg_temp.stamped12(x)) then
    bad := bad || 'the failed row was stamped, or a row after it was not handled'::text;
  end if;
  if pg_temp.queue12() is distinct from array[q[1]] then
    bad := bad || 'the failed row is not left as the only candidate'::text;
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0112: (5) %', array_to_string(bad, '; ');
  end if;
end
$$;

rollback to savepoint s5;

-- ---------------------------------------------------------------------------
-- (6) the two refresh functions: their entries, and the 1500 ms box
-- ---------------------------------------------------------------------------
savepoint s6;
do $$
declare
  bad  text[] := '{}';
  res  jsonb;
  v_sw jsonb;
  fn   text;
begin
  foreach fn in array array['refresh_report_views', 'refresh_gamification_views'] loop
    perform pg_temp.queue_rows12(2, case fn when 'refresh_report_views' then 1 else 3 end);
    execute format('select public.%I()', fn) into res;
    v_sw := res -> (jsonb_array_length(res) - 1);
    if jsonb_array_length(res) <> (case fn when 'refresh_report_views' then 7 else 3 end)
       or exists (select 1 from jsonb_array_elements(res) with ordinality as e(v, i)
                   where i < jsonb_array_length(res)
                     and (pg_temp.keys(v) <> 'error,ms,rows,view' or jsonb_typeof(v -> 'error') <> 'null'
                          or jsonb_typeof(v -> 'rows') <> 'number')) then
      bad := bad || format('%s() answered %s (expected every view entry refreshed, its error null)', fn, res);
    end if;
    if pg_temp.keys(v_sw) <> 'error,ms,rows,sweep,view' or v_sw ->> 'view' is distinct from 'completion_sweep'
       or jsonb_typeof(v_sw -> 'error') <> 'null'
       or pg_temp.keys(v_sw -> 'sweep') <> 'candidates,errors,failed,handled,ms,stopped'
       or v_sw -> 'sweep' ->> 'stopped' is distinct from 'done'
       or (v_sw ->> 'rows')::int <> (v_sw -> 'sweep' ->> 'handled')::int or (v_sw ->> 'rows')::int < 2 then
      bad := bad || format('%s() answered the sweep entry %s (expected the five keys, error null, the six-key '
                           || 'answer done with the queued rows handled)', fn, v_sw);
    end if;
  end loop;
  if cardinality(bad) > 0 then
    raise exception 'assert-0112: (6) %', array_to_string(bad, '; ');
  end if;
end
$$;
rollback to savepoint s6;

savepoint s6b;

create or replace function public.record_learning_activity(p_attempt_id uuid, p_activity boolean)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform pg_sleep(0.2);
  update public.course_attempts set side_effects_sig = settle_sig where id = p_attempt_id;
  return '{}'::jsonb;
end
$$;

do $$
declare
  bad  text[] := '{}';
  res  jsonb;
  v_sw jsonb;
  fn   text;
  q    int;
begin
  foreach fn in array array['refresh_report_views', 'refresh_gamification_views'] loop
    perform pg_temp.queue_rows12(10, case fn when 'refresh_report_views' then 1 else 11 end);
    q := cardinality(pg_temp.queue12());
    execute format('select public.%I()', fn) into res;
    v_sw := res -> (jsonb_array_length(res) - 1);
    if v_sw -> 'sweep' ->> 'stopped' is distinct from 'time' or (v_sw -> 'sweep' ->> 'handled')::int < 1
       or (v_sw -> 'sweep' ->> 'handled')::int >= q or jsonb_typeof(v_sw -> 'error') <> 'null'
       or exists (select 1 from jsonb_array_elements(res) e where jsonb_typeof(e.value -> 'error') <> 'null') then
      bad := bad || format('%s() over %s queued rows of 200 ms answered the sweep entry %s (expected its 1500 ms box '
                           || 'to stop it: time, fewer rows handled than queued, no error)', fn, q, v_sw);
    end if;
  end loop;
  if cardinality(bad) > 0 then
    raise exception 'assert-0112: (6) %', array_to_string(bad, '; ');
  end if;
end
$$;

rollback to savepoint s6b;

-- ---------------------------------------------------------------------------
-- (7) assert-0107-launch.sql (45b) with the timed sweep replaced: a sweep
-- that raises is the entry's own error
-- ---------------------------------------------------------------------------
create temp table t7_timed_body as
  select md5(p.prosrc) as h, p.prosecdef as secdef, p.proconfig as cfg
    from pg_proc p
   where p.oid = 'public.sweep_completion_side_effects_timed(integer,integer)'::regprocedure;

savepoint s7;

create or replace function public.sweep_completion_side_effects_timed(p_limit integer, p_budget_ms integer)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  raise exception 'assert-0112 (7): the sweep raised on purpose';
end
$$;

do $$
declare
  bad  text[] := '{}';
  res  jsonb;
  v_sw jsonb;
  fn   text;
  msg  constant text := 'assert-0112 (7): the sweep raised on purpose';
begin
  foreach fn in array array['refresh_report_views', 'refresh_gamification_views'] loop
    execute format('select public.%I()', fn) into res;
    v_sw := res -> (jsonb_array_length(res) - 1);
    if pg_temp.keys(v_sw) <> 'error,ms,rows,sweep,view' or v_sw ->> 'view' is distinct from 'completion_sweep'
       or v_sw ->> 'error' is distinct from msg or jsonb_typeof(v_sw -> 'rows') <> 'null'
       or jsonb_typeof(v_sw -> 'sweep') <> 'null' or jsonb_typeof(v_sw -> 'ms') <> 'number' then
      bad := bad || format('%s() answered the sweep entry %s (expected exactly view, ms, rows, error and sweep; '
                           || 'error "%s"; rows and sweep null)', fn, v_sw, msg);
    end if;
    if jsonb_array_length(res) <> (case fn when 'refresh_report_views' then 7 else 3 end)
       or exists (select 1 from jsonb_array_elements(res) with ordinality as e(v, i)
                   where i < jsonb_array_length(res)
                     and (pg_temp.keys(v) <> 'error,ms,rows,view' or jsonb_typeof(v -> 'error') <> 'null'
                          or jsonb_typeof(v -> 'rows') <> 'number')) then
      bad := bad || format('%s() answered %s (expected every view entry refreshed, its error null)', fn, res);
    end if;
  end loop;
  if cardinality(bad) > 0 then
    raise exception 'assert-0112: (7) %', array_to_string(bad, '; ');
  end if;
end
$$;

rollback to savepoint s7;

do $$
declare
  res jsonb;
begin
  if (select md5(p.prosrc) is distinct from t.h or p.prosecdef is distinct from t.secdef
                                                or p.proconfig is distinct from t.cfg
        from pg_proc p, t7_timed_body t
       where p.oid = 'public.sweep_completion_side_effects_timed(integer,integer)'::regprocedure) then
    raise exception 'assert-0112: (7) the timed sweep''s body was not restored by the rollback to the savepoint';
  end if;
  res := public.sweep_completion_side_effects_timed(1, 6000);
  if pg_temp.keys(res) <> 'candidates,errors,failed,handled,ms,stopped' then
    raise exception 'assert-0112: (7) the restored timed sweep answered %', res;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (8) the backlog read
-- ---------------------------------------------------------------------------
savepoint s8;
do $$
declare
  bad    text[] := '{}';
  b      jsonb;
  n      bigint;
  oldest timestamptz;
  h0     text;
  h1     text;
  x0     bigint;
begin
  perform pg_temp.queue_rows12(4);
  -- a row the predicate leaves out on each of its terms
  insert into public.course_attempts (id, course_version_id, user_id, organization_id, status, completion_status,
                                      success_status, started_at, completed_at, context_kind, launch_mode)
  values (pg_temp.u12('000112890001'), pg_temp.u12('000112040201'), pg_temp.u12('000112010006'),
          '00000000-0000-0000-0000-00000000000a', 'completed', 'completed', 'unknown',
          now() - interval '1 minute', now() - interval '1 minute', 'individual', 'Normal'),
         (pg_temp.u12('000112890002'), pg_temp.u12('000112040201'), pg_temp.u12('000112010005'),
          '00000000-0000-0000-0000-00000000000a', 'in_progress', 'in_progress', 'unknown',
          now() - interval '1 day', null, 'individual', 'Normal');
  select count(*), min(greatest(ca.started_at, ca.completed_at, ca.last_activity_at)) into n, oldest
    from public.course_attempts ca
   where (ca.completion_status = 'completed' or ca.success_status = 'passed')
     and not ca.is_revision
     and ca.context_kind <> 'preview'
     and ca.status <> 'abandoned'
     and ca.side_effects_sig is distinct from ca.settle_sig
     and greatest(ca.started_at, ca.completed_at, ca.last_activity_at) < now() - interval '2 minutes';
  select md5(coalesce(string_agg(to_jsonb(ca)::text, '|' order by ca.id), '')) into h0 from public.course_attempts ca;
  select count(*) into x0 from public.xp_events;
  b := public.completion_sweep_backlog();
  select md5(coalesce(string_agg(to_jsonb(ca)::text, '|' order by ca.id), '')) into h1 from public.course_attempts ca;
  if pg_temp.keys(b) <> 'candidates,oldest_at' or (b ->> 'candidates')::bigint <> n or n < 4
     or (b ->> 'oldest_at')::timestamptz is distinct from oldest then
    bad := bad || format('completion_sweep_backlog() answered %s; a count by 0107''s predicate reads %s, oldest %s', b, n, oldest);
  end if;
  if h0 is distinct from h1 or (select count(*) from public.xp_events) <> x0 then
    bad := bad || 'the backlog read changed a row'::text;
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0112: (8) %', array_to_string(bad, '; ');
  end if;
end
$$;
rollback to savepoint s8;

rollback;
