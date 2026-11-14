-- scripts/migration-rehearsal/assert-0107-rulechange.sql
-- Every 0107 scenario that applies it, after each assert-0107-parity.sql:
-- what section 6q of 0107_learning_contexts.sql, the rule-change trigger
-- function learning_path_step_facts_before_rule_change() and its three
-- triggers, must do (the owner's O3 answer of 2026-11-14: "Once a learner
-- completes a Learning Path step, their completed status must remain
-- preserved in all situations, even if the Admin changes the step's rules
-- later"; the ADR 0024 note of 2026-11-14, items O3-a to O3-i).
-- One transaction that ends in ROLLBACK; every check raises
-- 'assert-0107-rulechange: (Rn) ...' on failure. The fixture world is an
-- organisation of its own, Org R (ids …000107210…), so a course rule change
-- here reaches no seed path. Each of (R1) to (R11) asserts the facts
-- (rule_pass_required, attempt_id, or that none was written), the view row,
-- v_path_progress and launch_context's steps[].done (ADR 0024 O3-i); (R0)
-- reads the catalog and (R12) the deletes.
--   (R0)  after any paste: the function once, exactly three triggers bound
--         to it
--   (R1)  O1-h (1), a step finished before 0107 (attempt rows that make the
--         step done, no fact, the writer never called), tightened through
--         binding (1) from the step's own null to true under a course rule
--         of false (the "is distinct from" case): the fact is there under
--         the rule before the change, the step stays done; the controls on
--         the same step: a learner with no attempt and a learner with only
--         an open attempt get no fact, and the open attempt completed
--         without a pass after the change is judged by the new rule (not
--         done, no fact)
--   (R2)  O1-h (1) through binding (3): the course's rule tightened, the
--         step's own rule null; the same course is a step with a rule of
--         its own (false) on another path, where the change writes nothing
--   (R3)  O1-h (2) through binding (1): tightened, completed without a pass
--         (no fact, not done), relaxed (done, still no fact), tightened
--         again: done, by a fact under rule false
--   (R4)  O1-h (2) through binding (3), at the course
--   (R5)  O1-h (3) through binding (1): a completion the writer has not
--         processed, tightened; then the writer runs and answers done with
--         the one fact row, the trigger's: the same id and
--         rule_pass_required false, read before the writer (not "the same
--         done_at", which defaults to now() and is one instant for every
--         write of this transaction, so it could not fail)
--   (R6)  O1-h (3) through binding (3), the fact identified the same way;
--         the writer then completes the path
--   (R7)  a relaxation records too, with rule_pass_required true
--   (R8)  a step removed (binding (2) records it), the course tightened,
--         the step added again: done by its fact
--   (R9)  a reorder, a release date, an update to the same value, and an
--         update of another column write nothing
--   (R10) as an authenticated admin of Org R the rule change succeeds and
--         records a learner whom only a Custom Group reaches; a direct
--         insert into the table as authenticated still raises 42501; an
--         authenticated learner's update of the step's or the course's rule
--         changes no row and writes no fact
--   (R11) the depth test: a rule change made from inside a trigger (depth
--         2) records nothing, so the learner then reads by the new rule
--         (the phase 2 rule of O3-a: never change a rule from a trigger);
--         the same change made as a statement records the step (the
--         control). The cascades of (R12) pass with or without the depth
--         test, because by the time a step row leaves in a cascade its
--         parent is gone and the view shows no row for it
--   (R12) the deletes behave as before and write nothing: a user delete,
--         a course delete with the service-role claim over a step done by
--         its rule with no fact (the step row leaves in the cascade, where
--         the depth test writes nothing), a lone delete of a path with no
--         attempt, a lone delete of a path whose attempts name it (23503,
--         the attempt key), and the organisation delete
begin;

-- Supabase's default grants on the two tables the rule changes write (the
-- form of asrole-grants.sql; grants-0107.sql gives select only): row-level
-- security, not a missing grant, decides who may change a rule. Rolled back
-- with the transaction.
grant update, delete on public.learning_path_courses to authenticated;
grant update on public.courses to authenticated;

create function pg_temp.rc(p text) returns uuid language sql immutable as $$
  select ('00000000-0000-0000-0000-000107' || p)::uuid
$$;
create function pg_temp.rcu(n int) returns uuid language sql immutable as $$
  select pg_temp.rc('2101' || lpad(n::text, 2, '0'))
$$;
create function pg_temp.rcc(n int) returns uuid language sql immutable as $$
  select pg_temp.rc('2102' || lpad(n::text, 2, '0'))
$$;
create function pg_temp.rcv(n int) returns uuid language sql immutable as $$
  select pg_temp.rc('2104' || lpad(n::text, 2, '0'))
$$;
create function pg_temp.rcp(n int) returns uuid language sql immutable as $$
  select pg_temp.rc('2105' || lpad(n::text, 2, '0'))
$$;
create function pg_temp.rca(n int) returns uuid language sql immutable as $$
  select pg_temp.rc('2107' || lpad(n::text, 2, '0'))
$$;
create function pg_temp.tf(b boolean) returns text language sql immutable as $$
  select case when b is null then '-' when b then 'T' else 'F' end
$$;
-- an attempt's label: a and the last two digits of its id
create function pg_temp.lbl(p uuid) returns text language sql immutable as $$
  select case when p is null then '-' else 'a' || right(p::text, 2) end
$$;

-- one path row of Org R: kind passed, failed, completed or in_progress
create function pg_temp.rc_att(p_n int, p_course int, p_user int, p_path int, p_kind text, p_score numeric)
returns uuid language plpgsql as $$
declare
  v_id   uuid := pg_temp.rca(p_n);
  v_st   timestamptz := now() - make_interval(mins => 200 - p_n);
  v_done boolean := p_kind <> 'in_progress';
begin
  insert into public.course_attempts (id, course_version_id, user_id, organization_id, status, completion_status,
                                      success_status, score, started_at, completed_at, context_kind, is_preview,
                                      learning_path_id, launch_mode)
  values (v_id, pg_temp.rcv(p_course), pg_temp.rcu(p_user), pg_temp.rc('210000'), p_kind,
          case when v_done then 'completed' else 'in_progress' end,
          case p_kind when 'passed' then 'passed' when 'failed' then 'failed' else 'unknown' end,
          p_score, v_st, case when v_done then v_st + interval '1 minute' end,
          'path', false, pg_temp.rcp(p_path), 'Normal');
  return v_id;
end
$$;

-- the view row of one step, and its fact
create function pg_temp.rc_step(p_path int, p_user int, p_course int) returns text language sql stable as $$
  select coalesce((
    select format('pr=%s pbr=%s fact=%s done=%s failed=%s res=%s off=%s', pg_temp.tf(s.pass_required),
                  pg_temp.tf(s.passed_by_rule), pg_temp.tf(s.done_recorded_at is not null), pg_temp.tf(s.done),
                  pg_temp.tf(s.failed), coalesce(s.latest_result, '-'), pg_temp.lbl(s.official_attempt_id))
      from public.v_path_step_status s
     where s.path_id = pg_temp.rcp(p_path) and s.user_id = pg_temp.rcu(p_user) and s.course_id = pg_temp.rcc(p_course)),
    'no row')
$$;
create function pg_temp.rc_fact(p_path int, p_user int, p_course int) returns text language sql stable as $$
  select coalesce((
    select string_agg(format('rule=%s att=%s', pg_temp.tf(f.rule_pass_required), pg_temp.lbl(f.attempt_id)), '; ')
      from public.learning_path_step_completions f
     where f.path_id = pg_temp.rcp(p_path) and f.user_id = pg_temp.rcu(p_user) and f.course_id = pg_temp.rcc(p_course)),
    'none')
$$;
create function pg_temp.rc_prog(p_path int, p_user int) returns text language sql stable as $$
  select coalesce((
    select format('%s/%s next=%s status=%s', p.steps_done, p.steps_total, coalesce(p.next_step::text, '-'), p.status)
      from public.v_path_progress p
     where p.path_id = pg_temp.rcp(p_path) and p.user_id = pg_temp.rcu(p_user)),
    'no row')
$$;
-- launch_context's steps[].done, in step order
create function pg_temp.rc_lc(p_path int, p_user int, p_course int) returns text language sql stable as $$
  select coalesce(string_agg(s ->> 'done', ',' order by (s ->> 'step_number')::int), '-')
    from jsonb_array_elements(
           public.launch_context(pg_temp.rcu(p_user), pg_temp.rc('210000'), pg_temp.rcc(p_course), pg_temp.rcp(p_path),
                                 null, null, null) -> 'path' -> 'steps') s
$$;
create function pg_temp.rc_nf() returns bigint language sql stable as $$
  select count(*) from public.learning_path_step_completions f where f.organization_id = pg_temp.rc('210000')
$$;
-- 'ok', or 'sqlstate|constraint' (a failed statement is undone by the
-- block's own subtransaction; a successful one stays)
create function pg_temp.rc_try(p_sql text, p_claims text) returns text language plpgsql as $$
declare
  s text; c text;
begin
  perform set_config('request.jwt.claims', coalesce(p_claims, ''), true);
  execute p_sql;
  perform set_config('request.jwt.claims', '', true);
  return 'ok';
exception when others then
  get stacked diagnostics s = returned_sqlstate, c = constraint_name;
  perform set_config('request.jwt.claims', '', true);
  return s || '|' || coalesce(c, '');
end
$$;

-- ---------------------------------------------------------------------------
-- The fixture world: Org R; AR its admin (u01); learners u11 to u24, Org R
-- members; courses C01 to C16, each with one SCORM 1.2 version, every
-- course rule false but C06's (true); a static Custom Group GR holding u20
-- only. Paths, each assigned by user rows unless said otherwise (own rule
-- of each step in brackets, null = inherit):
--   P01 C01 (null), C02 (null): u11, u12, u13      (R1)
--   P02 C03 (null), C04 (null): u14                (R2, R12)
--   P03 C03 (false): u15                           (R2, R11)
--   P04 C05 (true): u16                            (R3)
--   P05 C06 (null): u17                            (R4)
--   P06 C07 (null), C08 (null): u18                (R5)
--   P07 C09 (null): u19                            (R6)
--   P08 C10 (true): u21                            (R7)
--   P09 C11 (null), C12 (null): u22                (R8)
--   P10 C13 (false), C14 (null): u23               (R9, R12)
--   P11 C15 (null): group GR only                  (R10)
--   P12 C16 (null): u24                            (R10, R11)
--   P13 C01 (null): u12, no attempt                (R12)
-- ---------------------------------------------------------------------------
do $$
declare
  org constant uuid := pg_temp.rc('210000');
  i   int;
  v_steps int[][] := array[
    -- path, course, step number, own rule (0 null, 1 false, 2 true)
    [1, 1, 1, 0], [1, 2, 2, 0], [2, 3, 1, 0], [2, 4, 2, 0], [3, 3, 1, 1], [4, 5, 1, 2], [5, 6, 1, 0],
    [6, 7, 1, 0], [6, 8, 2, 0], [7, 9, 1, 0], [8, 10, 1, 2], [9, 11, 1, 0], [9, 12, 2, 0],
    [10, 13, 1, 1], [10, 14, 2, 0], [11, 15, 1, 0], [12, 16, 1, 0], [13, 1, 1, 0]];
  v_assign int[][] := array[
    [1, 11], [1, 12], [1, 13], [2, 14], [3, 15], [4, 16], [5, 17], [6, 18], [7, 19], [8, 21], [9, 22],
    [10, 23], [12, 24], [13, 12]];
begin
  insert into public.organizations (id, name, slug) values (org, 'Org R (0107 rule change)', 'org-r-0107rc');
  insert into auth.users (id, email) values (pg_temp.rcu(1), 'admin-r-0107rc@example.test');
  insert into public.organization_members (organization_id, user_id, role) values (org, pg_temp.rcu(1), 'admin');
  for i in 11..24 loop
    insert into auth.users (id, email) values (pg_temp.rcu(i), format('learner-%s-0107rc@example.test', i));
    insert into public.organization_members (organization_id, user_id, role) values (org, pg_temp.rcu(i), 'user');
  end loop;
  for i in 1..16 loop
    insert into public.courses (id, organization_id, title, slug, pass_required)
    values (pg_temp.rcc(i), org, format('C%s (0107 rule change)', lpad(i::text, 2, '0')), format('c%s-0107rc', i), i = 6);
    insert into public.course_packages (id, course_id, language, is_active)
    values (pg_temp.rc('2103' || lpad(i::text, 2, '0')), pg_temp.rcc(i), null, true);
    insert into public.course_versions (id, course_id, package_id, version_number, manifest_type, launch_url,
                                        storage_prefix, manifest_data)
    values (pg_temp.rcv(i), pg_temp.rcc(i), pg_temp.rc('2103' || lpad(i::text, 2, '0')), 1, 'scorm12', 'index.html',
            format('courses/c%s-0107rc/v1/', i), '{"title":"0107 rule change"}');
    update public.course_packages set current_version_id = pg_temp.rcv(i)
     where id = pg_temp.rc('2103' || lpad(i::text, 2, '0'));
    update public.courses set current_version_id = pg_temp.rcv(i) where id = pg_temp.rcc(i);
  end loop;
  for i in 1..13 loop
    insert into public.learning_paths (id, organization_id, name, slug, is_active, visibility, sequence_mode)
    values (pg_temp.rcp(i), org, format('P%s (0107 rule change)', lpad(i::text, 2, '0')), format('p%s-0107rc', i),
            true, 'private', 'strict');
  end loop;
  for i in 1..array_length(v_steps, 1) loop
    insert into public.learning_path_courses (path_id, course_id, step_number, pass_required)
    values (pg_temp.rcp(v_steps[i][1]), pg_temp.rcc(v_steps[i][2]), v_steps[i][3],
            case v_steps[i][4] when 1 then false when 2 then true end);
  end loop;
  for i in 1..array_length(v_assign, 1) loop
    insert into public.learning_path_assignments (id, path_id, organization_id, assignee_type, user_id, assigned_by)
    values (pg_temp.rc('2106' || lpad(i::text, 2, '0')), pg_temp.rcp(v_assign[i][1]), org, 'user',
            pg_temp.rcu(v_assign[i][2]), pg_temp.rcu(1));
  end loop;
  insert into public.org_groups (id, organization_id, name, group_type, rules, is_active, system_key)
  values (pg_temp.rc('210801'), org, 'GR (0107 rule change)', 'static', null, true, null);
  insert into public.org_group_members (group_id, organization_id, user_id) values (pg_temp.rc('210801'), org, pg_temp.rcu(20));
  insert into public.learning_path_assignments (id, path_id, organization_id, assignee_type, group_id, assigned_by)
  values (pg_temp.rc('210699'), pg_temp.rcp(11), org, 'group', pg_temp.rc('210801'), pg_temp.rcu(1));
end
$$;

-- ---------------------------------------------------------------------------
-- (R0) the function and its three triggers, once each
-- ---------------------------------------------------------------------------
do $$
begin
  if (select count(*) from pg_proc p
       where p.pronamespace = 'public'::regnamespace and p.proname = 'learning_path_step_facts_before_rule_change') <> 1
     or (select count(*) from pg_trigger t
          where not t.tgisinternal
            and t.tgfoid = to_regprocedure('public.learning_path_step_facts_before_rule_change()')) <> 3
     or (select string_agg(t.tgrelid::regclass::text || '.' || t.tgname, ', ' order by t.tgname) from pg_trigger t
          where not t.tgisinternal
            and t.tgfoid = to_regprocedure('public.learning_path_step_facts_before_rule_change()'))
        is distinct from 'courses.courses_facts_before_rule_update, '
                         || 'learning_path_courses.learning_path_courses_facts_before_rule_update, '
                         || 'learning_path_courses.learning_path_courses_facts_before_step_delete' then
    raise exception 'assert-0107-rulechange: (R0) the function or its triggers are not there exactly once: %',
      (select string_agg(t.tgrelid::regclass::text || '.' || t.tgname, ', ') from pg_trigger t
        where not t.tgisinternal and t.tgfoid = to_regprocedure('public.learning_path_step_facts_before_rule_change()'));
  end if;
  if pg_temp.rc_nf() <> 0 then
    raise exception 'assert-0107-rulechange: (R0) the fixture world wrote % fact(s)', pg_temp.rc_nf();
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (R1) a step finished before 0107, tightened at the step (null to true)
-- ---------------------------------------------------------------------------
do $$
declare
  bad text[] := '{}';
  got text;
  w   jsonb;
begin
  perform pg_temp.rc_att(1, 1, 11, 1, 'failed', 0.3);       -- u11: done by the rule, no fact, no writer call
  perform pg_temp.rc_att(2, 1, 13, 1, 'in_progress', null); -- u13: an open row only
  got := pg_temp.rc_step(1, 11, 1) || ' / ' || pg_temp.rc_fact(1, 11, 1);
  if got is distinct from 'pr=F pbr=T fact=F done=T failed=F res=failed off=a01 / none' then
    bad := bad || format('before: u11 reads %s', got);
  end if;
  update public.learning_path_courses set pass_required = true where path_id = pg_temp.rcp(1) and course_id = pg_temp.rcc(1);
  got := pg_temp.rc_step(1, 11, 1) || ' / ' || pg_temp.rc_fact(1, 11, 1) || ' / ' || pg_temp.rc_prog(1, 11)
         || ' / ' || pg_temp.rc_lc(1, 11, 1);
  if got is distinct from 'pr=T pbr=F fact=T done=T failed=F res=failed off=a01 / rule=F att=a01 / '
                          || '1/2 next=2 status=in_progress / true,false' then
    bad := bad || format('after: u11 reads %s (expected done by a fact under rule false naming a01)', got);
  end if;
  -- the controls: no attempt, and an open row only, had not satisfied the old rule
  got := pg_temp.rc_fact(1, 12, 1) || ' ' || pg_temp.rc_step(1, 12, 1) || ' / ' || pg_temp.rc_fact(1, 13, 1) || ' '
         || pg_temp.rc_step(1, 13, 1);
  if got is distinct from 'none pr=T pbr=F fact=F done=F failed=F res=- off=- / none pr=T pbr=F fact=F done=F failed=F res=- off=-' then
    bad := bad || format('the controls u12 and u13 read %s (expected no fact, not done)', got);
  end if;
  -- u13's open row completes without a pass after the change: judged by the
  -- new rule
  update public.course_attempts set status = 'failed', completion_status = 'completed', success_status = 'failed',
                                    score = 0.2, completed_at = now()
   where id = pg_temp.rca(2);
  w := public.record_learning_activity(pg_temp.rca(2));
  got := format('done=%s', w ->> 'done') || ' ' || pg_temp.rc_fact(1, 13, 1) || ' ' || pg_temp.rc_step(1, 13, 1)
         || ' / ' || pg_temp.rc_lc(1, 13, 1);
  if got is distinct from 'done=false none pr=T pbr=F fact=F done=F failed=T res=failed off=a02 / false,false' then
    bad := bad || format('u13, completed without a pass after the tightening, reads %s (expected not done, no fact)', got);
  end if;
  if pg_temp.rc_nf() <> 1 then
    bad := bad || format('%s fact(s) in Org R (expected 1: u11 on P01)', pg_temp.rc_nf());
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107-rulechange: (R1) O1-h (1) through binding (1): %', array_to_string(bad, '; ');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (R2) a step finished before 0107, tightened at the course; the same
--      course with a rule of its own on another path
-- ---------------------------------------------------------------------------
do $$
declare
  bad text[] := '{}';
  got text;
  n0  bigint := pg_temp.rc_nf();
begin
  perform pg_temp.rc_att(3, 3, 14, 2, 'failed', 0.4); -- u14 on P02 (inherits C03's rule)
  perform pg_temp.rc_att(4, 3, 15, 3, 'failed', 0.5); -- u15 on P03 (its own rule, false)
  update public.courses set pass_required = true where id = pg_temp.rcc(3);
  got := pg_temp.rc_step(2, 14, 3) || ' / ' || pg_temp.rc_fact(2, 14, 3) || ' / ' || pg_temp.rc_prog(2, 14)
         || ' / ' || pg_temp.rc_lc(2, 14, 3);
  if got is distinct from 'pr=T pbr=F fact=T done=T failed=F res=failed off=a03 / rule=F att=a03 / '
                          || '1/2 next=2 status=in_progress / true,false' then
    bad := bad || format('u14 on P02 reads %s (expected done by a fact under rule false naming a03)', got);
  end if;
  got := pg_temp.rc_step(3, 15, 3) || ' / ' || pg_temp.rc_fact(3, 15, 3);
  if got is distinct from 'pr=F pbr=T fact=F done=T failed=F res=failed off=a04 / none' then
    bad := bad || format('u15 on P03, a step with a rule of its own, reads %s (expected done by its own rule, no fact)', got);
  end if;
  if pg_temp.rc_nf() - n0 <> 1 then
    bad := bad || format('the course change wrote %s fact(s) (expected 1: u14 on P02)', pg_temp.rc_nf() - n0);
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107-rulechange: (R2) O1-h (1) through binding (3): %', array_to_string(bad, '; ');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (R3) relaxed with nothing completed, tightened again, at the step
-- ---------------------------------------------------------------------------
do $$
declare
  bad text[] := '{}';
  got text;
  w   jsonb;
begin
  perform pg_temp.rc_att(5, 5, 16, 4, 'failed', 0.4);
  w := public.record_learning_activity(pg_temp.rca(5));
  got := format('done=%s ', w ->> 'done') || pg_temp.rc_step(4, 16, 5) || ' / ' || pg_temp.rc_fact(4, 16, 5);
  if got is distinct from 'done=false pr=T pbr=F fact=F done=F failed=T res=failed off=a05 / none' then
    bad := bad || format('tightened before done (O1-g (3)): %s', got);
  end if;
  update public.learning_path_courses set pass_required = false where path_id = pg_temp.rcp(4);
  got := pg_temp.rc_step(4, 16, 5) || ' / ' || pg_temp.rc_fact(4, 16, 5);
  if got is distinct from 'pr=F pbr=T fact=F done=T failed=F res=failed off=a05 / none' then
    bad := bad || format('relaxed: %s (expected done by the rule, no fact: the old rule was not satisfied)', got);
  end if;
  update public.learning_path_courses set pass_required = true where path_id = pg_temp.rcp(4);
  got := pg_temp.rc_step(4, 16, 5) || ' / ' || pg_temp.rc_fact(4, 16, 5) || ' / ' || pg_temp.rc_prog(4, 16)
         || ' / ' || pg_temp.rc_lc(4, 16, 5);
  if got is distinct from 'pr=T pbr=F fact=T done=T failed=F res=failed off=a05 / rule=F att=a05 / '
                          || '1/1 next=- status=in_progress / true' then
    bad := bad || format('tightened again: %s (expected done by a fact under rule false)', got);
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107-rulechange: (R3) O1-h (2) through binding (1): %', array_to_string(bad, '; ');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (R4) relaxed with nothing completed, tightened again, at the course
-- ---------------------------------------------------------------------------
do $$
declare
  bad text[] := '{}';
  got text;
  w   jsonb;
begin
  perform pg_temp.rc_att(6, 6, 17, 5, 'failed', 0.4);
  w := public.record_learning_activity(pg_temp.rca(6));
  got := format('done=%s ', w ->> 'done') || pg_temp.rc_step(5, 17, 6) || ' / ' || pg_temp.rc_fact(5, 17, 6);
  if got is distinct from 'done=false pr=T pbr=F fact=F done=F failed=T res=failed off=a06 / none' then
    bad := bad || format('tightened before done: %s', got);
  end if;
  update public.courses set pass_required = false where id = pg_temp.rcc(6);
  got := pg_temp.rc_step(5, 17, 6) || ' / ' || pg_temp.rc_fact(5, 17, 6);
  if got is distinct from 'pr=F pbr=T fact=F done=T failed=F res=failed off=a06 / none' then
    bad := bad || format('relaxed at the course: %s', got);
  end if;
  update public.courses set pass_required = true where id = pg_temp.rcc(6);
  got := pg_temp.rc_step(5, 17, 6) || ' / ' || pg_temp.rc_fact(5, 17, 6) || ' / ' || pg_temp.rc_prog(5, 17)
         || ' / ' || pg_temp.rc_lc(5, 17, 6);
  if got is distinct from 'pr=T pbr=F fact=T done=T failed=F res=failed off=a06 / rule=F att=a06 / '
                          || '1/1 next=- status=in_progress / true' then
    bad := bad || format('tightened again at the course: %s', got);
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107-rulechange: (R4) O1-h (2) through binding (3): %', array_to_string(bad, '; ');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (R5) a completion the writer has not processed, tightened at the step;
--      the writer then runs. The trigger's fact is identified by its id and
--      its rule_pass_required, read before the writer: a fact the writer
--      wrote or rewrote would carry a new id, and the writer writes only
--      under the rule as it stands (true here). done_at cannot tell them
--      apart: it defaults to now(), the same instant for every write of
--      this one transaction (the final review of 2026-11-14, F7)
-- ---------------------------------------------------------------------------
do $$
declare
  bad text[] := '{}';
  got text;
  w   jsonb;
  d0  timestamptz;
  f0  uuid;
  r0  boolean;
begin
  perform pg_temp.rc_att(7, 7, 18, 6, 'failed', 0.3);
  update public.learning_path_courses set pass_required = true where path_id = pg_temp.rcp(6) and course_id = pg_temp.rcc(7);
  select f.done_at, f.id, f.rule_pass_required into d0, f0, r0 from public.learning_path_step_completions f
   where f.path_id = pg_temp.rcp(6) and f.user_id = pg_temp.rcu(18);
  got := pg_temp.rc_step(6, 18, 7) || ' / ' || pg_temp.rc_fact(6, 18, 7) || ' / ' || pg_temp.rc_prog(6, 18)
         || ' / ' || pg_temp.rc_lc(6, 18, 7);
  if got is distinct from 'pr=T pbr=F fact=T done=T failed=F res=failed off=a07 / rule=F att=a07 / '
                          || '1/2 next=2 status=in_progress / true,false' or f0 is null or r0 is distinct from false then
    bad := bad || format('before the writer: %s (fact %s, rule %s)', got, f0, r0);
  end if;
  w := public.record_learning_activity(pg_temp.rca(7));
  if w ->> 'done' is distinct from 'true' or w ->> 'passed_ever' is distinct from 'true'
     or w ->> 'passed_by_rule' is distinct from 'false' or (w ->> 'done_recorded_at')::timestamptz is distinct from d0
     or (select count(*) from public.learning_path_step_completions f
          where f.path_id = pg_temp.rcp(6) and f.user_id = pg_temp.rcu(18)) <> 1
     or (select f.id from public.learning_path_step_completions f
          where f.path_id = pg_temp.rcp(6) and f.user_id = pg_temp.rcu(18)) is distinct from f0
     or (select f.rule_pass_required from public.learning_path_step_completions f
          where f.path_id = pg_temp.rcp(6) and f.user_id = pg_temp.rcu(18)) is distinct from r0 then
    bad := bad || format('the writer answered %s (expected done and passed_ever true, passed_by_rule false, '
                         || 'done_recorded_at the fact''s, one fact row: the trigger''s, same id and rule false)', w);
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107-rulechange: (R5) O1-h (3) through binding (1): %', array_to_string(bad, '; ');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (R6) a completion the writer has not processed, tightened at the course;
--      the writer then runs and completes the one-step path. The fact is
--      identified by its id and rule_pass_required, as in (R5)
-- ---------------------------------------------------------------------------
do $$
declare
  bad text[] := '{}';
  got text;
  w   jsonb;
  d0  timestamptz;
  f0  uuid;
  r0  boolean;
begin
  perform pg_temp.rc_att(8, 9, 19, 7, 'failed', 0.3);
  update public.courses set pass_required = true where id = pg_temp.rcc(9);
  select f.done_at, f.id, f.rule_pass_required into d0, f0, r0 from public.learning_path_step_completions f
   where f.path_id = pg_temp.rcp(7) and f.user_id = pg_temp.rcu(19);
  got := pg_temp.rc_step(7, 19, 9) || ' / ' || pg_temp.rc_fact(7, 19, 9) || ' / ' || pg_temp.rc_prog(7, 19)
         || ' / ' || pg_temp.rc_lc(7, 19, 9);
  if got is distinct from 'pr=T pbr=F fact=T done=T failed=F res=failed off=a08 / rule=F att=a08 / '
                          || '1/1 next=- status=in_progress / true' or f0 is null or r0 is distinct from false then
    bad := bad || format('before the writer: %s (fact %s, rule %s)', got, f0, r0);
  end if;
  w := public.record_learning_activity(pg_temp.rca(8));
  if w ->> 'done' is distinct from 'true' or w ->> 'passed_ever' is distinct from 'true'
     or (w ->> 'done_recorded_at')::timestamptz is distinct from d0 or w ->> 'path_completed' is distinct from 'true'
     or (select count(*) from public.learning_path_step_completions f
          where f.path_id = pg_temp.rcp(7) and f.user_id = pg_temp.rcu(19)) <> 1
     or (select f.id from public.learning_path_step_completions f
          where f.path_id = pg_temp.rcp(7) and f.user_id = pg_temp.rcu(19)) is distinct from f0
     or (select f.rule_pass_required from public.learning_path_step_completions f
          where f.path_id = pg_temp.rcp(7) and f.user_id = pg_temp.rcu(19)) is distinct from r0
     or pg_temp.rc_prog(7, 19) is distinct from '1/1 next=- status=completed' then
    bad := bad || format('the writer answered %s, the path reads %s (expected done, the fact''s done_at, one fact row: '
                         || 'the trigger''s, same id and rule false; the path completed)', w, pg_temp.rc_prog(7, 19));
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107-rulechange: (R6) O1-h (3) through binding (3): %', array_to_string(bad, '; ');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (R7) a relaxation records too, under the rule before it (true)
-- ---------------------------------------------------------------------------
do $$
declare
  got text;
begin
  perform pg_temp.rc_att(9, 10, 21, 8, 'passed', 0.9);
  update public.learning_path_courses set pass_required = false where path_id = pg_temp.rcp(8);
  -- one step, done, and no completion row (the writer is not called), so
  -- the path reads in_progress, as (R6) does before its writer
  got := pg_temp.rc_step(8, 21, 10) || ' / ' || pg_temp.rc_fact(8, 21, 10) || ' / ' || pg_temp.rc_prog(8, 21)
         || ' / ' || pg_temp.rc_lc(8, 21, 10);
  if got is distinct from 'pr=F pbr=T fact=T done=T failed=F res=passed off=a09 / rule=T att=a09 / '
                          || '1/1 next=- status=in_progress / true' then
    raise exception 'assert-0107-rulechange: (R7) a relaxed step reads % (expected a fact under rule true naming a09)', got;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (R8) the step removed (binding (2)), the course tightened, the step added
--      again
-- ---------------------------------------------------------------------------
do $$
declare
  bad text[] := '{}';
  got text;
begin
  perform pg_temp.rc_att(10, 11, 22, 9, 'failed', 0.3);
  delete from public.learning_path_courses where path_id = pg_temp.rcp(9) and course_id = pg_temp.rcc(11);
  got := pg_temp.rc_fact(9, 22, 11) || ' / ' || pg_temp.rc_step(9, 22, 11);
  if got is distinct from 'rule=F att=a10 / no row' then
    bad := bad || format('the step removed: %s (expected the fact under rule false, no view row)', got);
  end if;
  update public.courses set pass_required = true where id = pg_temp.rcc(11);
  insert into public.learning_path_courses (path_id, course_id, step_number) values (pg_temp.rcp(9), pg_temp.rcc(11), 1);
  got := pg_temp.rc_step(9, 22, 11) || ' / ' || pg_temp.rc_fact(9, 22, 11) || ' / ' || pg_temp.rc_prog(9, 22)
         || ' / ' || pg_temp.rc_lc(9, 22, 11);
  if got is distinct from 'pr=T pbr=F fact=T done=T failed=F res=failed off=a10 / rule=F att=a10 / '
                          || '1/2 next=2 status=in_progress / true,false' then
    bad := bad || format('the step added again under the course''s new rule: %s', got);
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107-rulechange: (R8) removed, tightened, added again: %', array_to_string(bad, '; ');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (R9) what fires nothing
-- ---------------------------------------------------------------------------
do $$
declare
  bad text[] := '{}';
  n0  bigint;
  got text;
begin
  perform pg_temp.rc_att(11, 13, 23, 10, 'failed', 0.3);
  perform pg_temp.rc_att(12, 14, 23, 10, 'failed', 0.3);
  n0 := pg_temp.rc_nf();
  update public.learning_path_courses set step_number = step_number + 10 where path_id = pg_temp.rcp(10);
  update public.learning_path_courses set release_at = now() + interval '1 day' where path_id = pg_temp.rcp(10);
  update public.learning_path_courses set pass_required = false where path_id = pg_temp.rcp(10) and course_id = pg_temp.rcc(13);
  update public.learning_path_courses set pass_required = null where path_id = pg_temp.rcp(10) and course_id = pg_temp.rcc(14);
  update public.learning_path_courses set pass_required = pass_required where path_id = pg_temp.rcp(10);
  update public.courses set pass_required = false where id = pg_temp.rcc(14);
  update public.courses set title = title || ' (renamed)' where id = pg_temp.rcc(14);
  if pg_temp.rc_nf() <> n0 then
    bad := bad || format('%s fact(s) written (expected none)', pg_temp.rc_nf() - n0);
  end if;
  got := pg_temp.rc_step(10, 23, 13) || ' / ' || pg_temp.rc_step(10, 23, 14) || ' / ' || pg_temp.rc_prog(10, 23)
         || ' / ' || pg_temp.rc_lc(10, 23, 13);
  if got is distinct from 'pr=F pbr=T fact=F done=T failed=F res=failed off=a11 / pr=F pbr=T fact=F done=T failed=F res=failed off=a12 / '
                          || '2/2 next=- status=in_progress / true,true' then
    bad := bad || format('P10 reads %s (expected both steps done by the rule, no fact, live rows and no completion '
                         || 'row: in_progress; the release date does not change done)', got);
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107-rulechange: (R9) a reorder, a release date, the same value: %', array_to_string(bad, '; ');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (R10) as the API roles
-- ---------------------------------------------------------------------------
do $$
declare
  v_me  text := current_user;
  bad   text[] := '{}';
  n     bigint;
  n0    bigint;
  st    text;
  got   text;
begin
  perform pg_temp.rc_att(13, 15, 20, 11, 'failed', 0.3); -- u20, reached by group GR only
  perform pg_temp.rc_att(14, 16, 24, 12, 'failed', 0.3); -- u24, done by the rule on P12
  if pg_temp.rc_step(11, 20, 15) is distinct from 'pr=F pbr=T fact=F done=T failed=F res=failed off=a13' then
    bad := bad || format('u20 is not enrolled on P11 through GR: %s', pg_temp.rc_step(11, 20, 15));
  end if;
  n0 := pg_temp.rc_nf();

  -- the admin AR of Org R
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.rcu(1), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  update public.learning_path_courses set pass_required = true
   where path_id = '00000000-0000-0000-0000-000107210511' and course_id = '00000000-0000-0000-0000-000107210215';
  get diagnostics n = row_count;
  st := 'ok';
  begin
    insert into public.learning_path_step_completions (organization_id, path_id, course_id, user_id, rule_pass_required)
    values ('00000000-0000-0000-0000-000107210000', '00000000-0000-0000-0000-000107210512',
            '00000000-0000-0000-0000-000107210216', '00000000-0000-0000-0000-000107210124', false);
  exception when others then
    st := sqlstate;
  end;
  execute format('set local role %I', v_me);
  perform set_config('request.jwt.claims', '', true);
  got := pg_temp.rc_step(11, 20, 15) || ' / ' || pg_temp.rc_fact(11, 20, 15) || ' / ' || pg_temp.rc_prog(11, 20)
         || ' / ' || pg_temp.rc_lc(11, 20, 15);
  if n <> 1 or got is distinct from 'pr=T pbr=F fact=T done=T failed=F res=failed off=a13 / rule=F att=a13 / '
                                    || '1/1 next=- status=in_progress / true' then
    bad := bad || format('the admin''s change updated %s row(s); u20 reads %s (expected 1 row, a fact under rule false)', n, got);
  end if;
  if st is distinct from '42501' then
    bad := bad || format('a direct insert of a fact as authenticated answered %s (expected 42501)', st);
  end if;
  if pg_temp.rc_nf() - n0 <> 1 then
    bad := bad || format('%s fact(s) written by the admin''s change (expected 1)', pg_temp.rc_nf() - n0);
  end if;

  -- the learner u24, on the step it is done on and on the course
  n0 := pg_temp.rc_nf();
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.rcu(24), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  update public.learning_path_courses set pass_required = true where path_id = '00000000-0000-0000-0000-000107210512';
  get diagnostics n = row_count;
  got := n::text;
  update public.courses set pass_required = true where id = '00000000-0000-0000-0000-000107210216';
  get diagnostics n = row_count;
  got := got || ',' || n;
  execute format('set local role %I', v_me);
  perform set_config('request.jwt.claims', '', true);
  if got is distinct from '0,0' or pg_temp.rc_nf() <> n0
     or (select lpc.pass_required from public.learning_path_courses lpc
          where lpc.path_id = pg_temp.rcp(12) and lpc.course_id = pg_temp.rcc(16)) is not null
     or (select c.pass_required from public.courses c where c.id = pg_temp.rcc(16)) is distinct from false then
    bad := bad || format('the learner''s updates changed %s row(s) and wrote %s fact(s) (expected 0,0 and none)',
                         got, pg_temp.rc_nf() - n0);
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107-rulechange: (R10) as the API roles: %', array_to_string(bad, '; ');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (R11) the depth test
-- ---------------------------------------------------------------------------
create temporary table rc_fire (path_id uuid, course_id uuid, rule boolean);
create function pg_temp.rc_fire_fn() returns trigger language plpgsql as $$
begin
  update public.learning_path_courses set pass_required = new.rule
   where path_id = new.path_id and course_id = new.course_id;
  return new;
end
$$;
create trigger rc_fire_trg after insert on pg_temp.rc_fire for each row execute function pg_temp.rc_fire_fn();

do $$
declare
  bad text[] := '{}';
  got text;
  n0  bigint := pg_temp.rc_nf();
begin
  -- u24 on P12 (C16, its own rule null, the course's false) is done by the
  -- rule with no fact (R10 left it so); the step is tightened from inside a
  -- trigger
  insert into pg_temp.rc_fire values (pg_temp.rcp(12), pg_temp.rcc(16), true);
  got := pg_temp.rc_step(12, 24, 16) || ' / ' || pg_temp.rc_fact(12, 24, 16) || ' / ' || pg_temp.rc_prog(12, 24)
         || ' / ' || pg_temp.rc_lc(12, 24, 16);
  if got is distinct from 'pr=T pbr=F fact=F done=F failed=T res=failed off=a14 / none / '
                          || '0/1 next=1 status=failed / false' or pg_temp.rc_nf() <> n0 then
    bad := bad || format('a tightening from inside a trigger: u24 reads %s, %s fact(s) written (expected none, '
                         || 'not done by the new rule)', got, pg_temp.rc_nf() - n0);
  end if;
  -- the control: u15 on P03 (C03, its own rule false), done by the rule with
  -- no fact, tightened by a statement
  update public.learning_path_courses set pass_required = true where path_id = pg_temp.rcp(3) and course_id = pg_temp.rcc(3);
  got := pg_temp.rc_step(3, 15, 3) || ' / ' || pg_temp.rc_fact(3, 15, 3) || ' / ' || pg_temp.rc_prog(3, 15)
         || ' / ' || pg_temp.rc_lc(3, 15, 3);
  if got is distinct from 'pr=T pbr=F fact=T done=T failed=F res=failed off=a04 / rule=F att=a04 / '
                          || '1/1 next=- status=in_progress / true' then
    bad := bad || format('the control, the same tightening as a statement: u15 reads %s', got);
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107-rulechange: (R11) the depth test: %', array_to_string(bad, '; ');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- (R12) the deletes write nothing and behave as before
-- ---------------------------------------------------------------------------
do $$
declare
  bad text[] := '{}';
  n0  bigint;
  got text;
  svc constant text := '{"role": "service_role"}';
begin
  -- a user delete: u11's fact leaves with u11, no other fact moves
  n0 := pg_temp.rc_nf();
  got := pg_temp.rc_try(format('delete from auth.users where id = %L', pg_temp.rcu(11)), svc);
  if got <> 'ok' or pg_temp.rc_nf() <> n0 - 1 or pg_temp.rc_fact(1, 11, 1) <> 'none' then
    bad := bad || format('the user delete of u11: %s, %s fact(s) left of %s', got, pg_temp.rc_nf(), n0);
  end if;

  -- a course delete with the service-role claim over a step done by its
  -- rule with no fact (u14's completed row on C04, step 2 of P02): the step
  -- row leaves in the cascade, where the function writes nothing
  perform pg_temp.rc_att(15, 4, 14, 2, 'failed', 0.3);
  n0 := pg_temp.rc_nf();
  got := pg_temp.rc_try(format('delete from public.courses where id = %L', pg_temp.rcc(4)), svc);
  if got <> 'ok' or pg_temp.rc_nf() <> n0
     or exists (select 1 from public.learning_path_step_completions f where f.course_id = pg_temp.rcc(4))
     or exists (select 1 from public.course_attempts a where a.id = pg_temp.rca(15))
     or exists (select 1 from public.learning_path_courses lpc where lpc.course_id = pg_temp.rcc(4)) then
    bad := bad || format('the course delete of C04: %s, facts %s then %s', got, n0, pg_temp.rc_nf());
  end if;

  -- a lone delete of P13 (no attempt names it): its step row leaves in the
  -- cascade, nothing is written
  n0 := pg_temp.rc_nf();
  got := pg_temp.rc_try(format('delete from public.learning_paths where id = %L', pg_temp.rcp(13)), null);
  if got <> 'ok' or pg_temp.rc_nf() <> n0 then
    bad := bad || format('the lone delete of P13: %s, facts %s then %s (expected ok, none written)', got, n0, pg_temp.rc_nf());
  end if;

  -- a lone delete of P10, whose attempts name it: refused by the attempt key
  -- as before, P10 and its steps stay, no fact
  got := pg_temp.rc_try(format('delete from public.learning_paths where id = %L', pg_temp.rcp(10)), null);
  if got <> '23503|course_attempts_learning_path_id_fkey'
     or (select count(*) from public.learning_path_courses lpc where lpc.path_id = pg_temp.rcp(10)) <> 2
     or exists (select 1 from public.learning_path_step_completions f where f.path_id = pg_temp.rcp(10)) then
    bad := bad || format('the lone delete of P10: %s (expected 23503 course_attempts_learning_path_id_fkey, P10 kept, no fact)', got);
  end if;

  -- the organisation delete: every row of Org R leaves, the facts with them
  got := pg_temp.rc_try(format('delete from public.organizations where id = %L', pg_temp.rc('210000')), svc);
  if got <> 'ok' or pg_temp.rc_nf() <> 0
     or exists (select 1 from public.learning_path_courses lpc
                 where lpc.path_id in (select pg_temp.rcp(i) from generate_series(1, 13) as i)) then
    bad := bad || format('the organisation delete of Org R: %s, %s fact(s) left', got, pg_temp.rc_nf());
  end if;
  if cardinality(bad) > 0 then
    raise exception 'assert-0107-rulechange: (R12) the deletes: %', array_to_string(bad, '; ');
  end if;
end
$$;

rollback;
