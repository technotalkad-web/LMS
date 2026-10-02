-- 0081: the revision rule (Phase 1).
--
--   1. Platform default becomes ONE official attempt (was 3): the first
--      completed attempt is official; every further launch is revision
--      (practice) that never changes scores, status, points or reports.
--   2. courses.pass_required: when true, a learning-path step or journey
--      day is complete only once the OFFICIAL attempt passed. When false
--      (default), a failed official attempt still counts as learning done.
--   3. journey_record_completion() honours pass_required.
--   4. mv_path_enrollment_status counts pass-required steps as completed
--      only when passed.
--
-- The app reads pass_required fail-soft, so it works before and after this
-- migration. Explicit module rules set in Configure → Assessment & attempt
-- rules are untouched; only the default for modules without a rule changes.

alter table public.courses
  add column if not exists pass_required boolean not null default false;

comment on column public.courses.pass_required is
  'When true, a learning-path step / journey day completes only when the official attempt PASSED (0081).';

-- ---- 1. default window: 1 official attempt ---------------------------------
create or replace function public.effective_attempt_policy(p_course_id uuid)
returns table (
  max_scored_attempts     integer,
  official_basis          text,
  official_attempt_number integer,
  retain_first_attempt    boolean,
  after_limit             text,
  source                  text,
  source_id               uuid
)
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce(x.max_scored_attempts, 1),
    coalesce(x.official_basis, 'first'),
    x.official_attempt_number,
    coalesce(x.retain_first_attempt, true),
    coalesce(x.after_limit, 'practice'),
    coalesce(x.scope, 'default'),
    x.target_id
  from (values (1)) as one(n)
  left join lateral (
    select r.scope, r.target_id, r.max_scored_attempts, r.official_basis,
           r.official_attempt_number, r.retain_first_attempt, r.after_limit,
           r.created_at, r.prio
    from (
      select r.*, 1 as prio
        from public.attempt_scoring_rules r
       where r.scope = 'course' and r.target_id = p_course_id
      union all
      select r.*, 2 as prio
        from public.attempt_scoring_rules r
        join public.learning_path_courses lpc on lpc.path_id = r.target_id
       where r.scope = 'path' and lpc.course_id = p_course_id
      union all
      select r.*, 3 as prio
        from public.attempt_scoring_rules r
       where r.scope = 'journey'
         and (
           exists (
             select 1 from public.journey_days jd
              where jd.program_id = r.target_id and jd.course_id = p_course_id
           )
           or exists (
             select 1 from public.journey_versions jv
              where jv.program_id = r.target_id
                and jv.days @> jsonb_build_array(
                      jsonb_build_object('course_id', p_course_id::text))
           )
         )
    ) r
    order by r.prio, r.max_scored_attempts, r.created_at
    limit 1
  ) x on true;
$$;
-- effective_attempt_policies(uuid[]) wraps the function above; unchanged.

-- ---- 2./3. journey day credit honours pass_required -------------------------
-- Same body as 0058/0063 plus one guard after the completion check: a
-- pass-required module credits its day only when the attempt PASSED.
create or replace function public.journey_record_completion(p_attempt_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_att record;
  v_enr record;
  v_day integer;
  v_done integer;
  v_required integer;
  v_next integer;
  v_next_course text;
  v_tz text;
  v_today date;
  v_allowed integer;
  v_pass_required boolean;
begin
  select a.id, a.user_id, a.organization_id, a.journey_enrollment_id,
         a.journey_day, a.completion_status, a.success_status, cv.course_id
    into v_att
    from public.course_attempts a
    join public.course_versions cv on cv.id = a.course_version_id
   where a.id = p_attempt_id;
  if v_att.id is null then
    return jsonb_build_object('ok', true, 'skipped', 'no_attempt');
  end if;
  if v_att.completion_status <> 'completed' and v_att.success_status <> 'passed' then
    return jsonb_build_object('ok', true, 'skipped', 'not_complete');
  end if;

  -- 0081: "Pass required" modules complete their journey day only on a pass.
  select coalesce(c.pass_required, false) into v_pass_required
    from public.courses c where c.id = v_att.course_id;
  if coalesce(v_pass_required, false) and v_att.success_status <> 'passed' then
    return jsonb_build_object('ok', true, 'skipped', 'pass_required');
  end if;

  if v_att.journey_enrollment_id is not null then
    select e.id, e.organization_id, e.program_id, e.status, e.start_date,
           v.days, v.days_total, v.count_sundays
      into v_enr
      from public.journey_enrollments e
      join public.journey_versions v on v.id = e.version_id
     where e.id = v_att.journey_enrollment_id and e.user_id = v_att.user_id;
    if v_enr.id is null or v_enr.status <> 'active' then
      return jsonb_build_object('ok', true, 'skipped', 'enrollment_inactive');
    end if;
    v_day := v_att.journey_day;
  else
    -- Untagged completion: is this the learner's next mission?
    select e.id, e.organization_id, e.program_id, e.status, e.start_date,
           v.days, v.days_total, v.count_sundays
      into v_enr
      from public.journey_enrollments e
      join public.journey_versions v on v.id = e.version_id
     where e.user_id = v_att.user_id
       and e.organization_id = v_att.organization_id
       and e.status = 'active'
     limit 1;
    if v_enr.id is null then
      return jsonb_build_object('ok', true, 'skipped', 'not_journey');
    end if;
    select count(*) into v_done
      from public.journey_day_progress where enrollment_id = v_enr.id;
    select (d->>'day')::int, d->>'course_id'
      into v_next, v_next_course
      from jsonb_array_elements(v_enr.days) d
     where coalesce(d->>'course_id', '') <> ''
       and (d->>'day')::int <= v_enr.days_total
     order by (d->>'day')::int
    offset v_done limit 1;
    if v_next is null or v_next_course <> v_att.course_id::text then
      return jsonb_build_object('ok', true, 'skipped', 'not_current_mission');
    end if;
    -- Calendar guard mirrors the launch gate: never ahead of the drip.
    select coalesce(gs.timezone, 'Asia/Kolkata') into v_tz
      from public.gamification_settings gs
     where gs.organization_id = v_enr.organization_id;
    v_today := (now() at time zone coalesce(v_tz, 'Asia/Kolkata'))::date;
    select count(*) into v_allowed
      from generate_series(v_enr.start_date::timestamp, v_today::timestamp, interval '1 day') g
     where v_enr.count_sundays or extract(dow from g) <> 0;
    if v_next > least(v_allowed, v_enr.days_total) then
      return jsonb_build_object('ok', true, 'skipped', 'ahead_of_calendar');
    end if;
    v_day := v_next;
    update public.course_attempts
       set journey_enrollment_id = v_enr.id, journey_day = v_day
     where id = v_att.id;
  end if;

  insert into public.journey_day_progress
    (enrollment_id, organization_id, user_id, day_number, course_id, attempt_id)
  values
    (v_enr.id, v_enr.organization_id, v_att.user_id, v_day, v_att.course_id, v_att.id)
  on conflict (enrollment_id, day_number) do nothing;

  select count(*) into v_done
    from public.journey_day_progress where enrollment_id = v_enr.id;
  select count(*) into v_required
    from jsonb_array_elements(v_enr.days) d
   where coalesce(d->>'course_id', '') <> ''
     and (d->>'day')::int <= v_enr.days_total;

  if v_required > 0 and v_done >= v_required then
    update public.journey_enrollments
       set status = 'completed', completed_at = now()
     where id = v_enr.id and status = 'active';
    insert into public.user_badges (organization_id, user_id, badge_slug, metadata)
    values (v_enr.organization_id, v_att.user_id, 'yoddha',
            jsonb_build_object('journey_program', v_enr.program_id))
    on conflict (organization_id, user_id, badge_slug, coalesce(period, '')) do nothing;
    return jsonb_build_object('ok', true, 'day', v_day, 'yoddha_unlocked', true);
  end if;

  return jsonb_build_object('ok', true, 'day', v_day);
end;
$$;

-- ---- 4. path enrollment status: pass-required steps complete only on pass --
drop materialized view if exists public.mv_path_enrollment_status;
create materialized view public.mv_path_enrollment_status as
with path_course_count as (
  select path_id, count(*) as total_courses
  from public.learning_path_courses
  group by path_id
),
user_path_progress as (
  select
    pe.path_id,
    pe.user_id,
    pcc.total_courses,
    count(distinct lpc.course_id) filter (
      where case when coalesce(c.pass_required, false) then s.ever_passed else s.ever_completed end
    ) as completed_courses,
    bool_or(s.user_id is not null) as any_attempt
  from public.v_path_enrollments_expanded pe
  join public.learning_path_courses lpc on lpc.path_id = pe.path_id
  join path_course_count pcc on pcc.path_id = pe.path_id
  join public.courses c on c.id = lpc.course_id
  left join public.v_course_attempt_summary s
    on s.course_id = lpc.course_id and s.user_id = pe.user_id
  group by pe.path_id, pe.user_id, pcc.total_courses
)
select
  path_id,
  count(distinct user_id) as total_enrolled,
  count(distinct user_id) filter (where completed_courses >= total_courses) as completed,
  count(distinct user_id) filter (where any_attempt and completed_courses < total_courses) as in_progress,
  count(distinct user_id) filter (where not any_attempt) as not_started,
  now() as refreshed_at
from user_path_progress
group by path_id;
create unique index mv_path_enrollment_status_idx
  on public.mv_path_enrollment_status (path_id);
revoke select on public.mv_path_enrollment_status from anon, authenticated;
grant select on public.mv_path_enrollment_status to service_role;

notify pgrst, 'reload schema';
