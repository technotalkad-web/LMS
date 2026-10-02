-- 0084: "course_passed" milestone — credit the learner's FIRST genuine pass
-- of a course, regardless of which official attempt it lands on.
--
-- Why: the gamification engine keyed the pass counter/badge off the FIRST
-- COMPLETION event (v_completed_event). A learner who fails their official
-- attempt (a failed attempt is still a "completion") and later PASSES on an
-- admin-granted retake therefore never had `assessments_passed` incremented —
-- the retake pass went uncredited for the counter and the "assessments passed"
-- badge. (Completion XP and the score bonuses were already correct: one-time
-- per course, and the bonus fires on whichever scored attempt first reaches
-- the tier — including a granted retake.)
--
-- Fix: a once-per-course PASS marker (dedupe `passed:<user>:<course>`), a 0-XP
-- bookkeeping event in the ledger, inserted whenever a completed attempt is a
-- genuine pass (success_status = 'passed'). The pass COUNTER + badge now derive
-- from that marker, decoupled from first-completion. It is idempotent (the
-- commit route fires on every commit; the unique dedupe_key makes repeat
-- commits no-ops) and one-time per course (multiple granted retakes never
-- double-count). No new XP is awarded — completion XP stays one-time and score
-- bonuses stay one-time, exactly as before.
--
-- DB-only: the SCORM commit and xAPI statement routes already invoke this RPC
-- for OFFICIAL completions (a granted retake classifies as official), so no app
-- redeploy is needed — behaviour changes the moment this migration lands.
--
-- Journey courses stay XP-exempt: the `gamification_record_activity` wrapper
-- (0058) returns before calling _core for any journey course, so the pass
-- marker is never recorded for mandatory-onboarding modules. Unchanged here.
--
-- ⚠ ORDERING HAZARD: re-applying 0073 after this overwrites _core with the
-- pass-less version. This whole file is idempotent — re-run it afterwards.
--
-- Forward-only: historical passes that landed after a prior completion are not
-- back-credited. A one-off backfill can be run separately if desired (count
-- distinct courses each learner has a 'passed' attempt for, vs. the marker).

-- Allow the new ledger rule value.
alter table public.xp_events drop constraint if exists xp_events_rule_check;
alter table public.xp_events add constraint xp_events_rule_check
  check (rule in (
    'course_completed','perfect_score','high_score','daily_activity',
    'streak_7','streak_30','course_passed','manual','import','adjustment'));

-- Redefine the engine core (based on 0073) with the pass milestone. Only two
-- things change vs 0073: the new "Candidate 2b" pass marker, and v_new_passed
-- now derives from it instead of from the first-completion event.
create or replace function public.gamification_record_activity_core(p_attempt_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_att record;
  v_set record;
  v_day date;
  v_ug record;
  v_streak integer;
  v_streak_start date;
  v_longest integer;
  v_headroom integer;
  v_completed boolean;
  v_completion_ok boolean;
  v_inserted integer := 0;
  v_awards jsonb := '[]'::jsonb;
  v_amt integer;
  v_new_completed integer;
  v_new_perfect integer;
  v_new_passed integer;
  v_total integer;
  v_level integer;
  v_b record;
  v_earn boolean;
  v_completed_event boolean := false;
  v_perfect_event boolean := false;
  v_passed_event boolean := false;
  v_speed_minutes numeric;
  v_pol record;
  v_attempt_no integer;
  v_scored boolean := false;
begin
  select ca.id, ca.organization_id, ca.user_id, ca.score,
         ca.completion_status, ca.success_status, ca.started_at, ca.completed_at,
         cv.course_id
    into v_att
    from public.course_attempts ca
    join public.course_versions cv on cv.id = ca.course_version_id
   where ca.id = p_attempt_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'attempt_not_found');
  end if;

  select * into v_set from public.gamification_settings
   where organization_id = v_att.organization_id;
  if not found then
    insert into public.gamification_settings (organization_id)
    values (v_att.organization_id) on conflict (organization_id) do nothing;
    select * into v_set from public.gamification_settings
     where organization_id = v_att.organization_id;
  end if;
  if v_set.enabled is distinct from true then
    return jsonb_build_object('ok', true, 'skipped', 'disabled');
  end if;

  v_day := (now() at time zone v_set.timezone)::date;

  -- Row-lock the rollup (creates it on first activity).
  insert into public.user_gamification (organization_id, user_id)
  values (v_att.organization_id, v_att.user_id)
  on conflict (organization_id, user_id) do nothing;
  select * into v_ug from public.user_gamification
   where organization_id = v_att.organization_id and user_id = v_att.user_id
   for update;

  -- Streak math (org-local days).
  if v_ug.last_active_day is null then
    v_streak := 1; v_streak_start := v_day;
  elsif v_ug.last_active_day = v_day then
    v_streak := greatest(v_ug.current_streak_days, 1);
    v_streak_start := coalesce(v_ug.streak_started_day, v_day);
  elsif v_ug.last_active_day = v_day - 1 then
    v_streak := v_ug.current_streak_days + 1;
    v_streak_start := coalesce(v_ug.streak_started_day, v_day - v_ug.current_streak_days);
  else
    v_streak := 1; v_streak_start := v_day;
  end if;
  v_longest := greatest(coalesce(v_ug.longest_streak_days, 0), v_streak);

  -- Daily XP cap headroom (org-local day window).
  if v_set.daily_xp_cap > 0 then
    select v_set.daily_xp_cap - coalesce(sum(xp), 0) into v_headroom
      from public.xp_events
     where organization_id = v_att.organization_id
       and user_id = v_att.user_id
       and created_at >= (v_day::timestamp at time zone v_set.timezone);
    v_headroom := greatest(coalesce(v_headroom, v_set.daily_xp_cap), 0);
  else
    v_headroom := 2147483647;
  end if;

  -- House completion definition (R1).
  v_completed := (v_att.completion_status = 'completed' or v_att.success_status = 'passed');
  -- Anti-gaming: optional minimum-duration guard for score-less completions.
  v_completion_ok := v_completed and not (
    v_set.min_completion_seconds > 0
    and v_att.score is null
    and v_att.completed_at is not null
    and extract(epoch from (v_att.completed_at - v_att.started_at)) < v_set.min_completion_seconds
  );

  -- 0073: is this one of the learner's first N completed attempts for the
  -- course? Same ordering as v_course_attempt_scoring.
  if v_completed then
    select * into v_pol from public.effective_attempt_policy(v_att.course_id);
    select count(*) into v_attempt_no
      from public.course_attempts ca2
      join public.course_versions cv2 on cv2.id = ca2.course_version_id
     where cv2.course_id = v_att.course_id
       and ca2.user_id = v_att.user_id
       and (ca2.completion_status = 'completed' or ca2.success_status = 'passed')
       and (coalesce(ca2.completed_at, ca2.started_at), ca2.started_at, ca2.id)
           <= (coalesce(v_att.completed_at, v_att.started_at), v_att.started_at, v_att.id);
    v_scored := coalesce(v_attempt_no, 1) <= coalesce(v_pol.max_scored_attempts, 3);
  end if;

  -- Candidate 1: daily activity.
  v_amt := least(v_set.xp_daily_activity, v_headroom);
  if v_amt > 0 then
    insert into public.xp_events (organization_id, user_id, rule, xp, attempt_id, source_day, dedupe_key)
    values (v_att.organization_id, v_att.user_id, 'daily_activity', v_amt, v_att.id, v_day,
            format('daily:%s:%s:%s', v_att.organization_id, v_att.user_id, v_day))
    on conflict (dedupe_key) do nothing;
    if found then
      v_inserted := v_inserted + v_amt; v_headroom := v_headroom - v_amt;
      v_awards := v_awards || jsonb_build_object('rule', 'daily_activity', 'xp', v_amt);
    end if;
  end if;

  -- Candidate 2: first-ever completion of this course.
  if v_completion_ok then
    v_amt := least(v_set.xp_course_completion, v_headroom);
    if v_amt > 0 then
      insert into public.xp_events (organization_id, user_id, rule, xp, course_id, attempt_id, source_day, dedupe_key)
      values (v_att.organization_id, v_att.user_id, 'course_completed', v_amt, v_att.course_id, v_att.id, v_day,
              format('complete:%s:%s', v_att.user_id, v_att.course_id))
      on conflict (dedupe_key) do nothing;
      if found then
        v_inserted := v_inserted + v_amt; v_headroom := v_headroom - v_amt;
        v_completed_event := true;
        v_awards := v_awards || jsonb_build_object('rule', 'course_completed', 'xp', v_amt);
      end if;
    end if;

    -- Candidate 2b (0084): first genuine PASS of this course, recorded ONCE
    -- regardless of which official attempt it lands on (e.g. an admin-granted
    -- retake that finally passes). A 0-XP marker — it drives the pass counter
    -- and badge below, decoupled from the first-completion event. No XP, so
    -- completion XP stays one-time and score bonuses stay one-time.
    if v_att.success_status = 'passed' then
      insert into public.xp_events (organization_id, user_id, rule, xp, course_id, attempt_id, source_day, dedupe_key)
      values (v_att.organization_id, v_att.user_id, 'course_passed', 0, v_att.course_id, v_att.id, v_day,
              format('passed:%s:%s', v_att.user_id, v_att.course_id))
      on conflict (dedupe_key) do nothing;
      if found then
        v_passed_event := true;
      end if;
    end if;

    -- Candidate 3: score bonuses — SCORED attempts only (0073). Perfect
    -- requires a non-suspect pass (a raw SCORM score of 1/100 stores as
    -- 1.0 with success 'failed').
    if v_scored and v_att.score is not null and v_att.score >= 0.999
       and v_att.success_status is distinct from 'failed' then
      v_amt := least(v_set.xp_perfect_score_bonus, v_headroom);
      if v_amt > 0 then
        insert into public.xp_events (organization_id, user_id, rule, xp, course_id, attempt_id, source_day, dedupe_key)
        values (v_att.organization_id, v_att.user_id, 'perfect_score', v_amt, v_att.course_id, v_att.id, v_day,
                format('perfect:%s:%s', v_att.user_id, v_att.course_id))
        on conflict (dedupe_key) do nothing;
        if found then
          v_inserted := v_inserted + v_amt; v_headroom := v_headroom - v_amt;
          v_perfect_event := true;
          v_awards := v_awards || jsonb_build_object('rule', 'perfect_score', 'xp', v_amt);
        end if;
      end if;
    elsif v_scored and v_att.score is not null and v_att.score >= 0.90 and v_att.score < 0.999 then
      v_amt := least(v_set.xp_high_score_bonus, v_headroom);
      if v_amt > 0 then
        insert into public.xp_events (organization_id, user_id, rule, xp, course_id, attempt_id, source_day, dedupe_key)
        values (v_att.organization_id, v_att.user_id, 'high_score', v_amt, v_att.course_id, v_att.id, v_day,
                format('high:%s:%s', v_att.user_id, v_att.course_id))
        on conflict (dedupe_key) do nothing;
        if found then
          v_inserted := v_inserted + v_amt; v_headroom := v_headroom - v_amt;
          v_awards := v_awards || jsonb_build_object('rule', 'high_score', 'xp', v_amt);
        end if;
      end if;
    end if;
  end if;

  -- Candidate 4: streak milestones (re-earnable per streak run).
  if v_streak >= 7 then
    v_amt := least(v_set.xp_streak_7_bonus, v_headroom);
    if v_amt > 0 then
      insert into public.xp_events (organization_id, user_id, rule, xp, source_day, dedupe_key)
      values (v_att.organization_id, v_att.user_id, 'streak_7', v_amt, v_day,
              format('streak7:%s:%s:%s', v_att.organization_id, v_att.user_id, v_streak_start))
      on conflict (dedupe_key) do nothing;
      if found then
        v_inserted := v_inserted + v_amt; v_headroom := v_headroom - v_amt;
        v_awards := v_awards || jsonb_build_object('rule', 'streak_7', 'xp', v_amt);
      end if;
    end if;
  end if;
  if v_streak >= 30 then
    v_amt := least(v_set.xp_streak_30_bonus, v_headroom);
    if v_amt > 0 then
      insert into public.xp_events (organization_id, user_id, rule, xp, source_day, dedupe_key)
      values (v_att.organization_id, v_att.user_id, 'streak_30', v_amt, v_day,
              format('streak30:%s:%s:%s', v_att.organization_id, v_att.user_id, v_streak_start))
      on conflict (dedupe_key) do nothing;
      if found then
        v_inserted := v_inserted + v_amt; v_headroom := v_headroom - v_amt;
        v_awards := v_awards || jsonb_build_object('rule', 'streak_30', 'xp', v_amt);
      end if;
    end if;
  end if;

  -- Counters + level (level never demotes). The pass counter now follows the
  -- once-per-course PASS marker (0084), so a granted-retake pass credits it too.
  v_new_completed := v_ug.courses_completed + case when v_completed_event then 1 else 0 end;
  v_new_perfect := v_ug.perfect_scores + case when v_perfect_event then 1 else 0 end;
  v_new_passed := v_ug.assessments_passed + case when v_passed_event then 1 else 0 end;
  v_total := v_ug.total_xp + v_inserted;
  select l.level into v_level from public.gamification_level_for(v_total, v_set.level_thresholds) l;
  v_level := greatest(coalesce(v_level, 1), v_ug.current_level);

  update public.user_gamification set
    total_xp = v_total,
    current_level = v_level,
    current_streak_days = v_streak,
    longest_streak_days = v_longest,
    last_active_day = v_day,
    streak_started_day = v_streak_start,
    courses_completed = v_new_completed,
    perfect_scores = v_new_perfect,
    assessments_passed = v_new_passed,
    updated_at = now()
  where organization_id = v_att.organization_id and user_id = v_att.user_id;

  -- Threshold badges from the resolved catalog (org override beats global).
  if v_att.completed_at is not null then
    v_speed_minutes := extract(epoch from (v_att.completed_at - v_att.started_at)) / 60.0;
  end if;
  for v_b in
    select distinct on (slug) slug, criteria_type, threshold
      from public.gamification_badges
     where enabled
       and (organization_id is null or organization_id = v_att.organization_id)
     order by slug, organization_id nulls last
  loop
    v_earn := case v_b.criteria_type
      when 'perfect_score'      then v_new_perfect >= coalesce(v_b.threshold, 1)
      when 'streak_days'        then v_streak >= coalesce(v_b.threshold, 7)
      when 'courses_completed'  then v_new_completed >= coalesce(v_b.threshold, 10)
      when 'assessments_passed' then v_new_passed >= coalesce(v_b.threshold, 5)
      when 'completion_speed'   then v_completed_event and v_speed_minutes is not null
                                     and v_speed_minutes > 0
                                     and v_speed_minutes <= coalesce(v_b.threshold, 30)
      else false
    end;
    if v_earn then
      insert into public.user_badges (organization_id, user_id, badge_slug)
      values (v_att.organization_id, v_att.user_id, v_b.slug)
      on conflict (organization_id, user_id, badge_slug, coalesce(period, '')) do nothing;
      if found then
        v_awards := v_awards || jsonb_build_object('badge', v_b.slug);
      end if;
    end if;
  end loop;

  return jsonb_build_object(
    'ok', true, 'awarded_xp', v_inserted, 'streak', v_streak, 'awards', v_awards,
    'scored_attempt', v_scored, 'passed_recorded', v_passed_event);
end;
$$;
revoke all on function public.gamification_record_activity_core(uuid) from public, anon, authenticated;
grant execute on function public.gamification_record_activity_core(uuid) to service_role;

notify pgrst, 'reload schema';
