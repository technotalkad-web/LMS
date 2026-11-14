-- scripts/migration-rehearsal/assert-0107-owner.sql
-- Scenario "0107-0108-reverse-then-0107", after 0107 is pasted again over
-- seed-0107-owner.sql: the control of the ADR 0024 note of 2026-11-14, the
-- ruling "A user delete can be refused (23503)", on a cross-learner row
-- written before the paste (learner X's attempt AX naming learner Y's
-- enrolment EY).
--   (1) the paste kept AX as it was (principle 5): X's, tagged EY, day 1;
--       the backfill labelled it journey with the day id of V1's day 1
--   (2) the count section 0b of 0107 reads as Q2.cross_owner, on the same
--       predicate: 1 (the paste's after-check A8 compared it before and
--       after the paste)
--   (3) a delete of Y is refused: 23503 on the attempt's key
--       course_attempts_journey_enrollment_id_fkey, because AX stays while
--       EY would go
--   (4) the same delete passes once AX is gone (so AX alone refused it)
--   (5) the owner trigger refuses the same row written now: P0001, nothing
--       written
--   (6) a delete of X passes: X's own row goes with X
-- One transaction that ends in ROLLBACK; every check that writes runs in a
-- block undone at its end. Every check raises 'assert-0107: (owner n) ...'
-- on failure.
begin;

do $$
declare
  bad text[] := '{}';
  st  text;
  con text;
  n   bigint;
  org constant uuid := '00000000-0000-0000-0000-00000000000a';
  x   constant uuid := '00000000-0000-0000-0000-000107015001';
  y   constant uuid := '00000000-0000-0000-0000-000107015002';
  ey  constant uuid := '00000000-0000-0000-0000-000107015101';
  ax  constant uuid := '00000000-0000-0000-0000-000107015201';
  d1  constant uuid := '00000000-0000-0000-0000-000107061001';
begin
  -- (1)
  if not exists (select 1 from public.course_attempts a
                  where a.id = ax and a.user_id = x and a.journey_enrollment_id = ey and a.journey_day = 1
                    and a.context_kind = 'journey' and a.journey_day_id = d1
                    and a.context_key = 'journey:' || ey || ':' || d1) then
    bad := bad || '(owner 1) the row from before the paste was not kept as it was, or not labelled journey on day 1'::text;
  end if;

  -- (2)
  select count(*) into n from public.course_attempts ca
   where ca.journey_enrollment_id is not null
     and exists (select 1 from public.journey_enrollments e
                  where e.id = ca.journey_enrollment_id
                    and (e.user_id is distinct from ca.user_id or e.organization_id is distinct from ca.organization_id));
  if n <> 1 then
    bad := bad || format('(owner 2) %s rows name another learner''s or organisation''s enrolment (expected 1, AX)', n);
  end if;

  -- (3)
  st := null; con := null;
  begin
    delete from auth.users where id = y;
    set constraints all immediate;
    raise exception using errcode = 'R0107', message = 'assert-0107: undo';
  exception when others then
    get stacked diagnostics st = returned_sqlstate, con = constraint_name;
  end;
  if st is distinct from '23503' or con is distinct from 'course_attempts_journey_enrollment_id_fkey' then
    bad := bad || format('(owner 3) a delete of Y answered %s on %s (expected 23503 on course_attempts_journey_enrollment_id_fkey)',
                         coalesce(st, 'nothing'), coalesce(con, 'no constraint'));
  end if;

  -- (4)
  st := null;
  begin
    delete from public.course_attempts where id = ax;
    delete from auth.users where id = y;
    set constraints all immediate;
    if exists (select 1 from public.journey_enrollments where id = ey) then
      raise exception using errcode = 'R0108', message = 'assert-0107: EY survived the delete of Y';
    end if;
    raise exception using errcode = 'R0107', message = 'assert-0107: undo';
  exception when others then
    st := sqlstate;
  end;
  if st is distinct from 'R0107' then
    bad := bad || format('(owner 4) with AX gone, the delete of Y answered %s (expected it to pass and take EY)', st);
  end if;

  -- (5)
  st := 'no error';
  begin
    insert into public.course_attempts (course_version_id, user_id, organization_id, status, completion_status,
                                        success_status, context_kind, journey_enrollment_id, journey_day, journey_day_id)
    values ('00000000-0000-0000-0000-0000000000e1', x, org, 'completed', 'completed', 'unknown', 'journey', ey, 1, d1);
    raise exception using errcode = 'R0107', message = 'assert-0107: undo';
  exception when others then
    st := sqlstate;
  end;
  if st is distinct from 'P0001' then
    bad := bad || format('(owner 5) the same row written now answered %s (expected P0001 from the owner trigger)', st);
  end if;
  if (select count(*) from public.course_attempts where journey_enrollment_id = ey) <> 1 then
    bad := bad || '(owner 5) a row naming EY was written'::text;
  end if;

  -- (6)
  st := null;
  begin
    delete from auth.users where id = x;
    set constraints all immediate;
    if exists (select 1 from public.course_attempts where id = ax) then
      raise exception using errcode = 'R0108', message = 'assert-0107: AX survived the delete of X';
    end if;
    raise exception using errcode = 'R0107', message = 'assert-0107: undo';
  exception when others then
    st := sqlstate;
  end;
  if st is distinct from 'R0107' then
    bad := bad || format('(owner 6) the delete of X answered %s (expected it to pass and take AX)', st);
  end if;

  if cardinality(bad) > 0 then
    raise exception 'assert-0107: %', array_to_string(bad, '; ');
  end if;
end
$$;

rollback;
