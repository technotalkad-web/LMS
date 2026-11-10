-- scripts/migration-rehearsal/assert-0106.sql
-- Scenarios "0103-0104-0100-then-0106" and "0100-0103-0104-then-0106": what
-- 0106_learner_feedback.sql (ADR 0021 step 1) must have done, on the `prod`
-- scenario's synthetic rows (seed.sql ids), after it was pasted twice.
-- The whole file is one transaction that ends in ROLLBACK, so nothing it
-- writes reaches the audit that follows (its row counts stay pinned). Every
-- check raises 'assert-0106: …' on failure; the runner then reports the file
-- as failed and stops the scenario.
--
-- PGlite runs as postgres, the owner of every table. The shim's anon,
-- authenticated and service_role are plain roles and the shim sets no default
-- privileges (pg_default_acl is empty), so check (3) sees exactly what 0106's
-- grants and revokes leave; its matrix is the after-apply A3 query of the
-- 0106 header, with the same expectation on PGlite and on Supabase. Where a
-- check runs as one of those roles, schema usage is granted inside its
-- savepoint (as Supabase grants it), so a refusal can only come from the
-- view or function privilege.
--
-- Seed (seed.sql): organisation A (…0a); learner a1 and staff member a2
-- (admin; 0100's backfill marks a2's attempts is_preview); a3 of the qa
-- organisation B; course c2 of A with versions e3 and e4 of package d3
-- (language null); attempt f3 = a1 completed on e3; f6 = a3 abandoned on e1
-- (course c1). This file adds three attempts, whose ids' last group starts
-- 000000106: a granted-retake-like eligible row for a1 on e4 (completed), a
-- staff preview for a2 on e3 and a revision visit for a1 on e3 (both
-- in_progress; neither learner has another in-progress row on e3, 0062).
-- It adds responded statements in the four A.1 shapes (ADR 0021 Context):
-- on f3, s1 likert-na `likert_3`, s2 stars `star_4`, s3 yes-no `yes`, s4
-- long-fill-in, s6 likert-na left unanswered; on the retake, s1 again with
-- `likert_1` and newer wording; one long-fill-in each on the preview, the
-- revision visit and f6 (abandoned), reading EXCLUDED-….
begin;

-- One responded statement in the A.1 engine's shape (engine decode and
-- statement build, ADR 0021 Context "What KIVO sends"). A null response is
-- an item left blank: no result.response, the unanswered extension true.
create function pg_temp.responded(
  p_attempt uuid, p_slide text, p_type text, p_response text, p_stored timestamptz,
  p_definition jsonb default '{}'::jsonb, p_question text default null
) returns void language sql as $$
  insert into public.xapi_statements (attempt_id, statement_id, verb, stored, raw)
  values (
    p_attempt, gen_random_uuid(), 'http://adlnet.gov/expapi/verbs/responded', p_stored,
    jsonb_build_object(
      'verb', jsonb_build_object('id', 'http://adlnet.gov/expapi/verbs/responded'),
      'object', jsonb_build_object(
        'id', 'https://kivo.example/course/beta/au/1/' || p_slide,
        'objectType', 'Activity',
        'definition', jsonb_build_object(
          'type', 'http://adlnet.gov/expapi/activities/cmi.interaction',
          'interactionType', p_type,
          'name', jsonb_build_object('en-US', 'Slide ' || p_slide),
          'description', jsonb_build_object('en-US', coalesce(p_question, 'Question ' || p_slide))
        ) || p_definition),
      'result', case
        when p_response is null then jsonb_build_object(
          'extensions', jsonb_build_object('https://ambak.com/xapi/ext/question/unanswered', true))
        else jsonb_build_object(
          'response', p_response,
          'extensions', jsonb_build_object('https://e-learning-engine/extensions/raw-response', p_response))
      end,
      'context', jsonb_build_object('registration', p_attempt),
      'timestamp', to_char(p_stored at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')));
$$;

create function pg_temp.likert_def() returns jsonb language sql as $$
  select jsonb_build_object('scale', jsonb_build_array(
    jsonb_build_object('id', 'likert_0', 'description', jsonb_build_object('en-US', 'Not Applicable')),
    jsonb_build_object('id', 'likert_1', 'description', jsonb_build_object('en-US', 'Strongly Disagree')),
    jsonb_build_object('id', 'likert_2', 'description', jsonb_build_object('en-US', 'Disagree')),
    jsonb_build_object('id', 'likert_3', 'description', jsonb_build_object('en-US', 'Agree')),
    jsonb_build_object('id', 'likert_4', 'description', jsonb_build_object('en-US', 'Strongly Agree'))));
$$;

-- ---------------------------------------------------------------------------
-- (0) every 0106 object exists, once, with its attributes and comments
-- ---------------------------------------------------------------------------
do $$
declare
  bad text[] := '{}';
  n bigint;
begin
  if to_regclass('public.v_course_feedback_responses') is null then
    bad := bad || 'view public.v_course_feedback_responses is missing'::text;
  elsif (select c.relkind from pg_class c where c.oid = 'public.v_course_feedback_responses'::regclass) <> 'v' then
    bad := bad || 'public.v_course_feedback_responses is not a view'::text;
  end if;
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'public' and p.proname = 'course_feedback_summary';
  if n <> 1 then
    bad := bad || format('%s functions named course_feedback_summary (expected 1)', n);
  elsif to_regprocedure('public.course_feedback_summary(uuid)') is null then
    bad := bad || 'course_feedback_summary(uuid) has another signature'::text;
  elsif exists (
    select 1 from pg_proc p join pg_language l on l.oid = p.prolang
     where p.oid = 'public.course_feedback_summary(uuid)'::regprocedure
       and (p.prosecdef or p.provolatile <> 's' or l.lanname <> 'sql' or not p.proretset)
  ) then
    bad := bad || 'course_feedback_summary(uuid) is not language sql stable security invoker returning a set'::text;
  end if;
  select count(*) into n from pg_indexes
   where schemaname = 'public' and indexname = 'xapi_statements_responded_attempt_idx';
  if n <> 1 then
    bad := bad || format('%s indexes named xapi_statements_responded_attempt_idx (expected 1)', n);
  end if;
  if coalesce(obj_description('public.v_course_feedback_responses'::regclass, 'pg_class'), '')
     not like 'Eligible learner feedback statements%(ADR 0021)%' then
    bad := bad || 'the view has not the ADR''s comment'::text;
  end if;
  if coalesce(obj_description('public.course_feedback_summary(uuid)'::regprocedure, 'pg_proc'), '')
     not like 'Learner feedback figures per question and bucket%(ADR 0021)%' then
    bad := bad || 'the function has not the ADR''s comment'::text;
  end if;
  if coalesce(obj_description('public.xapi_statements_responded_attempt_idx'::regclass, 'pg_class'), '')
     not like 'Feedback statements (verb responded) by attempt%(ADR 0021)%' then
    bad := bad || 'the index has not the ADR''s comment'::text;
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0106: (0) %', array_to_string(bad, '; ');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (1) the fixture: three attempts and the responded statements
-- ---------------------------------------------------------------------------
insert into public.course_attempts
  (id, course_version_id, user_id, organization_id, status, completion_status, success_status,
   started_at, completed_at, is_preview, is_revision)
values
  -- eligible: a second official attempt of a1 on the course (another version of the slot)
  ('00000000-0000-0000-0000-000000106001', '00000000-0000-0000-0000-0000000000e4', '00000000-0000-0000-0000-0000000000a1',
   '00000000-0000-0000-0000-00000000000a', 'completed', 'completed', 'unknown', now() - interval '90 minutes', now() - interval '30 minutes', false, false),
  -- excluded: a staff preview
  ('00000000-0000-0000-0000-000000106002', '00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-0000000000a2',
   '00000000-0000-0000-0000-00000000000a', 'in_progress', 'in_progress', 'unknown', now() - interval '10 minutes', null, true, false),
  -- excluded: a revision visit (what the launch page writes: in_progress)
  ('00000000-0000-0000-0000-000000106003', '00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-0000000000a1',
   '00000000-0000-0000-0000-00000000000a', 'in_progress', 'in_progress', 'unknown', now() - interval '10 minutes', null, false, true);

select pg_temp.responded('00000000-0000-0000-0000-0000000000f3', 's1', 'likert', 'likert_3', now() - interval '2 hours', pg_temp.likert_def());
select pg_temp.responded('00000000-0000-0000-0000-0000000000f3', 's2', 'likert', 'star_4', now() - interval '2 hours' + interval '1 minute',
  jsonb_build_object('scale', (select jsonb_agg(jsonb_build_object('id', 'star_' || i, 'description', jsonb_build_object('en-US', i::text)) order by i)
                               from generate_series(1, 5) as i)));
select pg_temp.responded('00000000-0000-0000-0000-0000000000f3', 's3', 'choice', 'yes', now() - interval '2 hours' + interval '2 minutes',
  jsonb_build_object('choices', jsonb_build_array(
    jsonb_build_object('id', 'yes', 'description', jsonb_build_object('en-US', 'Yes')),
    jsonb_build_object('id', 'no', 'description', jsonb_build_object('en-US', 'No')))));
select pg_temp.responded('00000000-0000-0000-0000-0000000000f3', 's4', 'long-fill-in', '=SUM(1)+1 clear, "well" paced',
  now() - interval '2 hours' + interval '3 minutes');
select pg_temp.responded('00000000-0000-0000-0000-0000000000f3', 's6', 'likert', null, now() - interval '2 hours' + interval '4 minutes', pg_temp.likert_def());
-- the second attempt answers s1 again, later, with newer wording
select pg_temp.responded('00000000-0000-0000-0000-000000106001', 's1', 'likert', 'likert_1', now() - interval '40 minutes',
  pg_temp.likert_def(), 'Question s1, newer wording');
-- the three excluded attempt classes
select pg_temp.responded('00000000-0000-0000-0000-000000106002', 's4', 'long-fill-in', 'EXCLUDED-PREVIEW', now() - interval '5 minutes');
select pg_temp.responded('00000000-0000-0000-0000-000000106003', 's4', 'long-fill-in', 'EXCLUDED-REVISION', now() - interval '5 minutes');
select pg_temp.responded('00000000-0000-0000-0000-0000000000f6', 's4', 'long-fill-in', 'EXCLUDED-RESET', now() - interval '5 minutes');

-- ---------------------------------------------------------------------------
-- (2) the view keeps the eligible rows only, with is_latest and the profile
-- ---------------------------------------------------------------------------
do $$
declare
  bad text[] := '{}';
  n bigint;
begin
  select count(*) into n from public.xapi_statements
   where verb = 'http://adlnet.gov/expapi/verbs/responded';
  if n <> 9 then
    bad := bad || format('%s responded statements in the fixture (expected 9)', n);
  end if;
  select count(*) into n from public.v_course_feedback_responses;
  if n <> 6 then
    bad := bad || format('the view holds %s rows (expected 6: five on f3, one on the second attempt)', n);
  end if;
  if exists (select 1 from public.v_course_feedback_responses
             where attempt_id not in ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-000000106001')) then
    bad := bad || 'the view holds a row of an excluded attempt'::text;
  end if;
  if exists (select 1 from public.v_course_feedback_responses where response like 'EXCLUDED-%') then
    bad := bad || 'an EXCLUDED- response is in the view'::text;
  end if;
  if exists (select 1 from public.v_course_feedback_responses
             where course_id <> '00000000-0000-0000-0000-0000000000c2'
                or user_id <> '00000000-0000-0000-0000-0000000000a1'
                or organization_id <> '00000000-0000-0000-0000-00000000000a'
                or package_id <> '00000000-0000-0000-0000-0000000000d3'
                or email is distinct from 'learner@example.test'
                or slot_language is not null) then
    bad := bad || 'a row''s course, learner, organisation, package, email or slot language is wrong'::text;
  end if;
  -- is_latest: only f3's s1 answer is superseded (by the second attempt's)
  select count(*) into n from public.v_course_feedback_responses where not is_latest;
  if n <> 1 or not exists (
    select 1 from public.v_course_feedback_responses
     where not is_latest and attempt_id = '00000000-0000-0000-0000-0000000000f3'
       and interaction_id = 'https://kivo.example/course/beta/au/1/s1' and response = 'likert_3') then
    bad := bad || format('%s rows are not is_latest (expected exactly f3''s s1 likert_3)', n);
  end if;
  -- the unanswered item: no response, the flag set; every other row answered
  if (select count(*) from public.v_course_feedback_responses where unanswered) <> 1
     or exists (select 1 from public.v_course_feedback_responses
                where unanswered <> (response is null)
                   or (unanswered and interaction_id <> 'https://kivo.example/course/beta/au/1/s6')) then
    bad := bad || 'the unanswered flag is not exactly the s6 row without a response'::text;
  end if;
  -- the definition columns and the engine timestamp
  if exists (select 1 from public.v_course_feedback_responses
             where interaction_type is null or question is null or question_name is null or responded_at is null
                or (interaction_type = 'likert' and jsonb_typeof(scale) <> 'array')
                or (interaction_type = 'choice' and jsonb_typeof(choices) <> 'array')) then
    bad := bad || 'a row misses its interaction type, question, name, scale, choices or timestamp'::text;
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0106: (2) %', array_to_string(bad, '; ');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (3) course_feedback_summary: buckets, __text__, the null bucket, learners,
--     responses and the newest wording
-- ---------------------------------------------------------------------------
do $$
declare
  bad text[] := '{}';
  n bigint;
  r record;
begin
  create temporary table want (interaction_id text, interaction_type text, response text, learners bigint, responses bigint) on commit drop;
  insert into want values
    ('https://kivo.example/course/beta/au/1/s1', 'likert', 'likert_1', 1, 2),
    ('https://kivo.example/course/beta/au/1/s2', 'likert', 'star_4', 1, 1),
    ('https://kivo.example/course/beta/au/1/s3', 'choice', 'yes', 1, 1),
    ('https://kivo.example/course/beta/au/1/s4', 'long-fill-in', '__text__', 1, 1),
    ('https://kivo.example/course/beta/au/1/s6', 'likert', null, 1, 1);
  create temporary table got on commit drop as
    select * from public.course_feedback_summary('00000000-0000-0000-0000-0000000000c2');
  select count(*) into n from got;
  if n <> 5 then
    bad := bad || format('summary(c2) returned %s rows (expected 5)', n);
  end if;
  for r in
    select 'missing' as side, w.* from want w
     where not exists (select 1 from got g
                       where g.interaction_id = w.interaction_id and g.interaction_type = w.interaction_type
                         and g.response is not distinct from w.response
                         and g.learners = w.learners and g.responses = w.responses)
    union all
    select 'unexpected', g.interaction_id, g.interaction_type, g.response, g.learners, g.responses from got g
     where not exists (select 1 from want w
                       where g.interaction_id = w.interaction_id and g.interaction_type = w.interaction_type
                         and g.response is not distinct from w.response
                         and g.learners = w.learners and g.responses = w.responses)
  loop
    bad := bad || format('%s row (%s, %s, %s, learners %s, responses %s)',
                         r.side, r.interaction_id, r.interaction_type, coalesce(r.response, 'null'), r.learners, r.responses);
  end loop;
  -- the comment text never reaches the summary for KIVO's types
  if exists (select 1 from got where response like '%SUM%' or response like 'EXCLUDED-%') then
    bad := bad || 'comment text reached the summary'::text;
  end if;
  -- the newest eligible statement's wording and labels
  if (select question ->> 'en-US' from got where interaction_id = 'https://kivo.example/course/beta/au/1/s1')
     is distinct from 'Question s1, newer wording' then
    bad := bad || 's1''s question is not the newest statement''s'::text;
  end if;
  if (select jsonb_array_length(scale) from got where interaction_id = 'https://kivo.example/course/beta/au/1/s2') <> 5
     or (select jsonb_array_length(choices) from got where interaction_id = 'https://kivo.example/course/beta/au/1/s3') <> 2 then
    bad := bad || 'the star scale or the yes/no choices did not come through'::text;
  end if;
  if exists (select 1 from got where slot_languages <> '{}'::text[] or first_at is null or last_at is null) then
    bad := bad || 'slot_languages, first_at or last_at is wrong'::text;
  end if;
  -- the abandoned attempt's course, another organisation's course and an unknown id: nothing
  if exists (select 1 from public.course_feedback_summary('00000000-0000-0000-0000-0000000000c1'))
     or exists (select 1 from public.course_feedback_summary('00000000-0000-0000-0000-0000000000c3'))
     or exists (select 1 from public.course_feedback_summary(gen_random_uuid())) then
    bad := bad || 'summary(c1), summary(c3) or summary(unknown id) returned a row'::text;
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0106: (3) %', array_to_string(bad, '; ');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (4) privileges: the A3 matrix of the 0106 header (expected no row), then
--     real attempts as authenticated and anon
-- ---------------------------------------------------------------------------
do $$
declare
  bad text[] := '{}';
  m record;
begin
  for m in
    select r.rol, 'public.v_course_feedback_responses' as obj, p.priv
    from (values ('anon'), ('authenticated'), ('service_role')) as r(rol)
    cross join (values ('select'), ('insert'), ('update'), ('delete'), ('truncate'), ('references'), ('trigger')) as p(priv)
    where has_table_privilege(r.rol, 'public.v_course_feedback_responses', p.priv)
          is distinct from (r.rol = 'service_role' and p.priv = 'select')
    union all
    select r.rol, 'public.course_feedback_summary(uuid)', 'execute'
    from (values ('anon'), ('authenticated'), ('service_role')) as r(rol)
    where has_function_privilege(r.rol, 'public.course_feedback_summary(uuid)', 'execute')
          is distinct from (r.rol = 'service_role')
  loop
    bad := bad || format('%s %s on %s differs from the expectation', m.rol, m.priv, m.obj);
  end loop;
  if has_function_privilege('public', 'public.course_feedback_summary(uuid)', 'execute') then
    bad := bad || 'PUBLIC can execute course_feedback_summary(uuid)'::text;
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0106: (4) %', array_to_string(bad, '; ');
  end if;
end
$$;

savepoint s4b;
grant usage on schema public to anon, authenticated, service_role;
set local role authenticated;
do $$
declare
  got text;
  stmt text;
begin
  if current_user <> 'authenticated' then
    raise exception 'assert-0106: (4b) running as % (expected authenticated)', current_user;
  end if;
  foreach stmt in array array[
    'select count(*) from public.v_course_feedback_responses',
    'select count(*) from public.course_feedback_summary(''00000000-0000-0000-0000-0000000000c2'')'
  ] loop
    got := 'no error';
    begin
      execute stmt;
    exception when others then
      got := sqlstate;
    end;
    if got <> '42501' then
      raise exception 'assert-0106: (4b) authenticated: % → % (expected 42501)', left(stmt, 70), got;
    end if;
  end loop;
end
$$;
reset role;
set local role anon;
do $$
declare
  got text;
  stmt text;
begin
  if current_user <> 'anon' then
    raise exception 'assert-0106: (4b) running as % (expected anon)', current_user;
  end if;
  foreach stmt in array array[
    'select count(*) from public.v_course_feedback_responses',
    'select count(*) from public.course_feedback_summary(''00000000-0000-0000-0000-0000000000c2'')'
  ] loop
    got := 'no error';
    begin
      execute stmt;
    exception when others then
      got := sqlstate;
    end;
    if got <> '42501' then
      raise exception 'assert-0106: (4b) anon: % → % (expected 42501)', left(stmt, 70), got;
    end if;
  end loop;
end
$$;
reset role;
rollback to savepoint s4b;

-- ---------------------------------------------------------------------------
-- (5) A4 security_invoker kept; A5 the index present, partial, valid, on
--     attempt_id, with the view's verb filter as its predicate
-- ---------------------------------------------------------------------------
do $$
declare
  bad text[] := '{}';
  def text;
begin
  if exists (
    select 1 from pg_class
     where relname = 'v_course_feedback_responses'
       and not (coalesce(reloptions::text, '') ~ 'security_invoker=(on|true)')
  ) then
    bad := bad || 'the view lost security_invoker'::text;
  end if;
  select indexdef into def from pg_indexes
   where schemaname = 'public' and indexname = 'xapi_statements_responded_attempt_idx';
  if def is null
     or def not like '%ON public.xapi_statements USING btree (attempt_id) WHERE%'
     or def not like '%http://adlnet.gov/expapi/verbs/responded%'
     or def not like '%''responded''%' then
    bad := bad || format('the index definition is not the partial one: %s', coalesce(def, 'missing'));
  end if;
  if not coalesce((select i.indisvalid from pg_index i
                    where i.indexrelid = 'public.xapi_statements_responded_attempt_idx'::regclass), false) then
    bad := bad || 'the index is not valid (indisvalid)'::text;
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0106: (5) %', array_to_string(bad, '; ');
  end if;
end
$$;

rollback;
