-- 0089: follow-ups to 0088 (journey unlock modes + daily reminder).
--
-- (A) journey_record_completion — enforce the start_date floor in PROGRESS mode
--     too. In 0088 the floor lived inside the calendar-only guard, so an
--     untagged (off-journey) completion of a Day-1 course on a future-dated
--     progress enrollment could credit Day 1 before the journey had started.
--     Now both modes reject a completion before start_date; the per-day
--     CALENDAR ceiling still applies to calendar journeys only.
--
-- (B) journey_reminder_counts(uuid[]) — one set-based query the hourly reminder
--     cron calls per page instead of a per-learner round-trip (Workers
--     subrequest budget). Returns, per enrollment: completed-day count and
--     whether a day was completed TODAY in the org's timezone (how progress
--     journeys decide "caught up for today").

-- ---- (A) ------------------------------------------------------------------
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
    -- Start-date floor: BOTH modes. A journey never credits a day before it
    -- has begun, even for an off-journey (untagged) completion.
    select coalesce(gs.timezone, 'Asia/Kolkata') into v_tz
      from public.gamification_settings gs
     where gs.organization_id = v_enr.organization_id;
    v_today := (now() at time zone coalesce(v_tz, 'Asia/Kolkata'))::date;
    if v_today < v_enr.start_date then
      return jsonb_build_object('ok', true, 'skipped', 'before_start');
    end if;
    -- Per-day calendar ceiling: CALENDAR mode only (never ahead of the drip).
    -- Progress journeys rely on the sequential offset check above.
    if coalesce(v_enr.unlock_mode, 'calendar') = 'calendar' then
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

-- ---- (B) ------------------------------------------------------------------
-- Per-enrollment completed-day count + "completed a day today?" (org-local),
-- computed set-based for a page of enrollments. Lets the reminder cron decide
-- "due" without a round-trip per learner.
create or replace function public.journey_reminder_counts(p_ids uuid[])
returns table (enrollment_id uuid, done integer, done_today boolean)
language sql
stable
security definer
set search_path = public
as $$
  select e.id as enrollment_id,
         count(p.id)::int as done,
         coalesce(
           bool_or(
             p.completed_at is not null
             and (p.completed_at at time zone coalesce(gs.timezone, 'Asia/Kolkata'))::date
                 = (now() at time zone coalesce(gs.timezone, 'Asia/Kolkata'))::date
           ),
           false
         ) as done_today
    from public.journey_enrollments e
    left join public.gamification_settings gs on gs.organization_id = e.organization_id
    left join public.journey_day_progress p on p.enrollment_id = e.id
   where e.id = any(p_ids)
   group by e.id;
$$;

revoke all on function public.journey_reminder_counts(uuid[]) from public, anon, authenticated;
grant execute on function public.journey_reminder_counts(uuid[]) to service_role;

notify pgrst, 'reload schema';
