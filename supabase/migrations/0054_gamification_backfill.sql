-- =============================================================================
-- Gamification backfill — award XP for historical learning so leaderboards are
-- alive and honest on day one (user decision: backfill history).
-- =============================================================================
--
-- Idempotent: every insert uses the same dedupe keys as the live engine
-- (unique index + on conflict do nothing), so re-running is a no-op.
-- Events are BACKDATED to the historical activity time so the 30-day windows
-- (Most Active / Most Improved) are truthful at launch. The daily XP cap is
-- deliberately NOT applied to backfill — it is historical truth, not gaming.
-- Streaks are reconstructed via gaps-and-islands over historical active days.
-- Monthly recognitions are NOT backfilled (history starts at launch month).

begin;

do $$
declare
  v_org record;
begin
  for v_org in
    select gs.organization_id, gs.timezone,
           gs.xp_course_completion, gs.xp_perfect_score_bonus, gs.xp_high_score_bonus,
           gs.xp_daily_activity, gs.xp_streak_7_bonus, gs.xp_streak_30_bonus,
           gs.level_thresholds
      from public.gamification_settings gs
     where gs.enabled
  loop

    -- 1) First completion per (user, course): completion + score bonus events,
    --    backdated to the completion moment.
    with firsts as (
      select distinct on (ca.user_id, cv.course_id)
        ca.user_id, cv.course_id, ca.id as attempt_id, ca.score, ca.success_status,
        coalesce(ca.completed_at, ca.started_at) as at
      from public.course_attempts ca
      join public.course_versions cv on cv.id = ca.course_version_id
      where ca.organization_id = v_org.organization_id
        and (ca.completion_status = 'completed' or ca.success_status = 'passed')
      order by ca.user_id, cv.course_id, coalesce(ca.completed_at, ca.started_at) asc
    )
    insert into public.xp_events
      (organization_id, user_id, rule, xp, course_id, attempt_id, source_day, dedupe_key, created_at, metadata)
    select v_org.organization_id, f.user_id, 'course_completed', v_org.xp_course_completion,
           f.course_id, f.attempt_id, (f.at at time zone v_org.timezone)::date,
           format('complete:%s:%s', f.user_id, f.course_id), f.at,
           '{"backfill": true}'::jsonb
      from firsts f
    on conflict (dedupe_key) do nothing;

    with firsts as (
      select distinct on (ca.user_id, cv.course_id)
        ca.user_id, cv.course_id, ca.id as attempt_id, ca.score, ca.success_status,
        coalesce(ca.completed_at, ca.started_at) as at
      from public.course_attempts ca
      join public.course_versions cv on cv.id = ca.course_version_id
      where ca.organization_id = v_org.organization_id
        and (ca.completion_status = 'completed' or ca.success_status = 'passed')
      order by ca.user_id, cv.course_id, coalesce(ca.completed_at, ca.started_at) asc
    )
    insert into public.xp_events
      (organization_id, user_id, rule, xp, course_id, attempt_id, source_day, dedupe_key, created_at, metadata)
    select v_org.organization_id, f.user_id,
           case when f.score >= 0.999 then 'perfect_score' else 'high_score' end,
           case when f.score >= 0.999 then v_org.xp_perfect_score_bonus else v_org.xp_high_score_bonus end,
           f.course_id, f.attempt_id, (f.at at time zone v_org.timezone)::date,
           format(case when f.score >= 0.999 then 'perfect:%s:%s' else 'high:%s:%s' end,
                  f.user_id, f.course_id),
           f.at, '{"backfill": true}'::jsonb
      from firsts f
     where f.score is not null and f.score >= 0.90
       and not (f.score >= 0.999 and f.success_status = 'failed')
    on conflict (dedupe_key) do nothing;

    -- 2) One daily-activity event per historical active org-local day
    --    (started_at, completed_at and last_activity_at all count as activity).
    with days as (
      select ca.user_id, (x.at at time zone v_org.timezone)::date as d, min(x.at) as first_at
      from public.course_attempts ca
      cross join lateral (
        values (ca.started_at), (ca.completed_at), (ca.last_activity_at)
      ) as x(at)
      where ca.organization_id = v_org.organization_id and x.at is not null
      group by ca.user_id, (x.at at time zone v_org.timezone)::date
    )
    insert into public.xp_events
      (organization_id, user_id, rule, xp, source_day, dedupe_key, created_at, metadata)
    select v_org.organization_id, d.user_id, 'daily_activity', v_org.xp_daily_activity,
           d.d, format('daily:%s:%s:%s', v_org.organization_id, d.user_id, d.d),
           d.first_at, '{"backfill": true}'::jsonb
      from days d
    on conflict (dedupe_key) do nothing;

    -- 3) Streak reconstruction (gaps-and-islands over the backfilled days) +
    --    historical streak-run bonuses, then the rollup row.
    with days as (
      select user_id, source_day as d
        from public.xp_events
       where organization_id = v_org.organization_id and rule = 'daily_activity'
       group by user_id, source_day
    ),
    islands as (
      select user_id, d,
             d - (row_number() over (partition by user_id order by d))::int as grp
        from days
    ),
    runs as (
      select user_id, min(d) as run_start, max(d) as run_end,
             (max(d) - min(d) + 1) as run_len
        from islands group by user_id, grp
    ),
    streak_bonuses as (
      insert into public.xp_events
        (organization_id, user_id, rule, xp, source_day, dedupe_key, created_at, metadata)
      select v_org.organization_id, r.user_id, b.rule, b.xp,
             r.run_start + (b.days - 1), format(b.key_fmt, v_org.organization_id, r.user_id, r.run_start),
             (r.run_start + (b.days - 1))::timestamp at time zone v_org.timezone,
             '{"backfill": true}'::jsonb
        from runs r
        cross join lateral (
          values ('streak_7',  v_org.xp_streak_7_bonus,  7,  'streak7:%s:%s:%s'),
                 ('streak_30', v_org.xp_streak_30_bonus, 30, 'streak30:%s:%s:%s')
        ) as b(rule, xp, days, key_fmt)
       where r.run_len >= b.days and b.xp > 0
      on conflict (dedupe_key) do nothing
      returning user_id
    ),
    latest_run as (
      select distinct on (user_id) user_id, run_start, run_end, run_len
        from runs order by user_id, run_end desc
    ),
    longest_run as (
      select user_id, max(run_len) as longest from runs group by user_id
    )
    insert into public.user_gamification
      (organization_id, user_id, current_streak_days, longest_streak_days,
       last_active_day, streak_started_day)
    select v_org.organization_id, lr.user_id,
           -- A historical streak only "continues" if it reaches today or yesterday
           -- in org-local time; otherwise the current streak is 0 at launch.
           case when lr.run_end >= (now() at time zone v_org.timezone)::date - 1
                then lr.run_len else 0 end,
           lo.longest,
           lr.run_end,
           case when lr.run_end >= (now() at time zone v_org.timezone)::date - 1
                then lr.run_start else null end
      from latest_run lr
      join longest_run lo on lo.user_id = lr.user_id
    on conflict (organization_id, user_id) do update set
      current_streak_days = excluded.current_streak_days,
      longest_streak_days = greatest(user_gamification.longest_streak_days, excluded.longest_streak_days),
      last_active_day = excluded.last_active_day,
      streak_started_day = excluded.streak_started_day,
      updated_at = now();

    -- 4) Totals + counters + levels from the ledger.
    with sums as (
      select user_id,
             sum(xp) as total_xp,
             count(*) filter (where rule = 'course_completed') as completed,
             count(*) filter (where rule = 'perfect_score') as perfects
        from public.xp_events
       where organization_id = v_org.organization_id
       group by user_id
    ),
    passed as (
      select ca.user_id, count(distinct cv.course_id) as n
        from public.course_attempts ca
        join public.course_versions cv on cv.id = ca.course_version_id
       where ca.organization_id = v_org.organization_id and ca.success_status = 'passed'
       group by ca.user_id
    )
    update public.user_gamification ug set
      total_xp = s.total_xp,
      courses_completed = s.completed,
      perfect_scores = s.perfects,
      assessments_passed = coalesce(pa.n, 0),
      current_level = greatest(ug.current_level,
        (select l.level from public.gamification_level_for(s.total_xp::int, v_org.level_thresholds) l)),
      updated_at = now()
    from sums s
    left join passed pa on pa.user_id = s.user_id
    where ug.organization_id = v_org.organization_id and ug.user_id = s.user_id;

    -- 5) Historical threshold badges from the rebuilt counters.
    insert into public.user_badges (organization_id, user_id, badge_slug, metadata)
    select v_org.organization_id, ug.user_id, b.slug, '{"backfill": true}'::jsonb
      from public.user_gamification ug
      cross join (
        select distinct on (slug) slug, criteria_type, threshold
          from public.gamification_badges
         where enabled and (organization_id is null or organization_id = v_org.organization_id)
           and criteria_type in ('perfect_score','streak_days','courses_completed','assessments_passed')
         order by slug, organization_id nulls last
      ) b
     where ug.organization_id = v_org.organization_id
       and case b.criteria_type
             when 'perfect_score'      then ug.perfect_scores >= coalesce(b.threshold, 1)
             when 'streak_days'        then ug.longest_streak_days >= coalesce(b.threshold, 7)
             when 'courses_completed'  then ug.courses_completed >= coalesce(b.threshold, 10)
             when 'assessments_passed' then ug.assessments_passed >= coalesce(b.threshold, 5)
           end
    on conflict (organization_id, user_id, badge_slug, coalesce(period, '')) do nothing;

  end loop;
end;
$$;

select public.refresh_gamification_views();

commit;
