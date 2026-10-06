-- 0088: Journey unlock modes (calendar vs progress) + admin-configurable
-- daily reminder time.
--
-- UNLOCK MODE — how a journey's daily missions release:
--   'calendar' (default, == today's behaviour): day N opens on its calendar
--     day; missed days can be caught up IN ORDER; a learner can never get
--     ahead of the calendar.
--   'progress': the calendar ceiling is removed — the next day opens as soon
--     as the previous one is completed (self-paced, still strictly in order).
--     Day 1 still waits for the enrollment's start_date.
-- Like count_sundays, unlock_mode is edited on the PROGRAM and SNAPSHOTTED
-- into the VERSION at publish, and every enrollment is pinned to a version —
-- so changing it only affects new/republished enrollments, never disturbs an
-- in-flight learner.
--
-- REMINDER TIME — the daily behind/pending reminder (the journey-nudges cron)
-- becomes admin-schedulable per journey. reminder_hour is the org-local hour
-- (0-23, default 11 = 11:00). The cron runs hourly and sends at most once per
-- learner per day, on the first run at/after this hour in the org timezone;
-- last_daily_reminder_on is the per-enrollment once-a-day guard. These live on
-- the PROGRAM (live, not version-pinned), like the other nudge knobs.

alter table public.journey_programs
  add column if not exists unlock_mode text not null default 'calendar'
    check (unlock_mode in ('calendar', 'progress'));
alter table public.journey_programs
  add column if not exists reminder_hour smallint not null default 11
    check (reminder_hour between 0 and 23);

alter table public.journey_versions
  add column if not exists unlock_mode text not null default 'calendar'
    check (unlock_mode in ('calendar', 'progress'));

alter table public.journey_enrollments
  add column if not exists last_daily_reminder_on date;

-- Pre-filter index for the hourly reminder cron: active enrollments not yet
-- reminded today.
create index if not exists journey_enrollments_daily_reminder_idx
  on public.journey_enrollments (program_id, status, last_daily_reminder_on);

-- ---- journey_record_completion: honour unlock_mode --------------------------
-- Same body as 0081, with one change: the "never ahead of the calendar" guard
-- in the untagged auto-credit branch is applied only in CALENDAR mode. In
-- PROGRESS mode the sequential "is this the next mission?" check (offset by the
-- completed count) is the only gate — completing a day immediately qualifies
-- the next, with no calendar ceiling. Day 1 still requires today >= start_date
-- because allowedDay math is irrelevant here (the offset check + the launch
-- gate already enforce start_date on the tagged path).
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
           v.days, v.days_total, v.count_sundays, v.unlock_mode
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
           v.days, v.days_total, v.count_sundays, v.unlock_mode
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
    -- Calendar guard mirrors the launch gate: never ahead of the drip. Applied
    -- only in CALENDAR mode; PROGRESS journeys have no calendar ceiling (the
    -- sequential offset check above is the whole gate).
    if coalesce(v_enr.unlock_mode, 'calendar') = 'calendar' then
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

notify pgrst, 'reload schema';
