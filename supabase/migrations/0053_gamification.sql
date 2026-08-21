-- =============================================================================
-- Gamification & Learner Recognition Engine — Phase 1 schema + engine
-- =============================================================================
--
-- Design (see plan): append-only XP ledger (xp_events, unique dedupe_key for
-- idempotency) + a live per-(org,user) rollup (user_gamification), both
-- maintained by ONE SECURITY DEFINER RPC called fail-isolated from the SCORM
-- commit and xAPI statement routes. Leaderboards are org-keyed matviews
-- refreshed every 15 min by cron (0031/0049 house pattern: unique index for
-- CONCURRENTLY, revoked from authenticated, service-role reads). Monthly
-- recognition snapshots close via gamification_close_month().
--
-- Learning is never interrupted: the engine only ever runs inside try/catch
-- service-role blocks in the API routes; a failure here never fails a commit.
--
-- All DDL guarded/idempotent. Companion backfill: 0054.

begin;

-- ── 1) Signal + identity columns ────────────────────────────────────────────

-- Activity signal for streaks / "most active": stamped by the SCORM commit and
-- xAPI statement routes on every write (started_at alone under-counts resumes).
alter table public.course_attempts
  add column if not exists last_activity_at timestamptz;
create index if not exists course_attempts_org_user_activity_idx
  on public.course_attempts (organization_id, user_id, last_activity_at desc);

-- Learner photo (podium / leaderboard / profile). Global by design: profiles
-- are already peer-readable within shared orgs, so no new RLS surface.
alter table public.profiles
  add column if not exists avatar_url text;

-- ── 2) Per-org settings (template: notification_settings) ───────────────────

create table if not exists public.gamification_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  enabled boolean not null default true,
  leaderboard_enabled boolean not null default true,
  allow_opt_out boolean not null default true,
  allow_avatar_uploads boolean not null default true,
  -- Per-board toggles (board hidden when false; master switch above wins).
  board_overall boolean not null default true,
  board_most_active boolean not null default true,
  board_highest_scorer boolean not null default true,
  board_most_improved boolean not null default true,
  board_longest_streak boolean not null default true,
  board_team boolean not null default true,
  timezone text not null default 'Asia/Kolkata',
  -- XP rule values (flat columns, admin-editable).
  xp_course_completion integer not null default 100 check (xp_course_completion >= 0),
  xp_perfect_score_bonus integer not null default 50 check (xp_perfect_score_bonus >= 0),
  xp_high_score_bonus integer not null default 25 check (xp_high_score_bonus >= 0),
  xp_daily_activity integer not null default 10 check (xp_daily_activity >= 0),
  xp_streak_7_bonus integer not null default 50 check (xp_streak_7_bonus >= 0),
  xp_streak_30_bonus integer not null default 200 check (xp_streak_30_bonus >= 0),
  daily_xp_cap integer not null default 500 check (daily_xp_cap >= 0), -- 0 = uncapped
  min_completion_seconds integer not null default 0 check (min_completion_seconds >= 0),
  -- NULL = the global default ladder baked into gamification_level_for().
  level_thresholds jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

alter table public.gamification_settings enable row level security;
drop policy if exists "admins manage gamification settings" on public.gamification_settings;
create policy "admins manage gamification settings"
  on public.gamification_settings for all
  using (public.is_org_admin(organization_id))
  with check (public.is_org_admin(organization_id));
drop policy if exists "members read gamification settings" on public.gamification_settings;
create policy "members read gamification settings"
  on public.gamification_settings for select
  using (public.is_org_member(organization_id));

-- Auto-provision a row per org (template: tenant_lrs_config).
create or replace function public.create_default_gamification_settings()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.gamification_settings (organization_id)
  values (new.id)
  on conflict (organization_id) do nothing;
  return new;
end;
$$;
drop trigger if exists organizations_default_gamification on public.organizations;
create trigger organizations_default_gamification
  after insert on public.organizations
  for each row execute function public.create_default_gamification_settings();

insert into public.gamification_settings (organization_id)
select id from public.organizations
on conflict (organization_id) do nothing;

-- ── 3) XP ledger (append-only, service-role writes) ─────────────────────────

create table if not exists public.xp_events (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  rule text not null check (rule in (
    'course_completed','perfect_score','high_score','daily_activity',
    'streak_7','streak_30','manual','import','adjustment')),
  xp integer not null,
  course_id uuid references public.courses(id) on delete set null,
  attempt_id uuid references public.course_attempts(id) on delete set null,
  source_day date,
  dedupe_key text not null,
  metadata jsonb,
  awarded_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create unique index if not exists xp_events_dedupe_idx on public.xp_events (dedupe_key);
create index if not exists xp_events_org_user_time_idx
  on public.xp_events (organization_id, user_id, created_at desc);
create index if not exists xp_events_org_time_idx
  on public.xp_events (organization_id, created_at desc);

alter table public.xp_events enable row level security;
drop policy if exists "own xp events read" on public.xp_events;
create policy "own xp events read" on public.xp_events
  for select using (user_id = auth.uid());
drop policy if exists "admins read org xp events" on public.xp_events;
create policy "admins read org xp events" on public.xp_events
  for select using (public.is_org_admin(organization_id));
-- No insert/update/delete policies: engine RPC + service role only.

-- Append-only guarantee even for service_role (RLS bypass doesn't skip
-- triggers). Corrections are compensating negative 'adjustment' rows.
-- FK actions must still work: org/user deletion cascades a DELETE here, and
-- course/attempt deletion fires an UPDATE (on delete set null). Both arrive
-- via the RI constraint trigger, so pg_trigger_depth() > 1 there, while a
-- direct UPDATE/DELETE hits this trigger at depth 1.
create or replace function public.xp_events_append_only()
returns trigger language plpgsql as $$
begin
  if pg_trigger_depth() > 1 then
    return case tg_op when 'DELETE' then old else new end;
  end if;
  raise exception 'xp_events is append-only; insert an adjustment row instead';
end;
$$;
drop trigger if exists xp_events_no_mutation on public.xp_events;
create trigger xp_events_no_mutation
  before update or delete on public.xp_events
  for each row execute function public.xp_events_append_only();

-- ── 4) Live per-user rollup ─────────────────────────────────────────────────

create table if not exists public.user_gamification (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  total_xp integer not null default 0,
  current_level integer not null default 1,
  current_streak_days integer not null default 0,
  longest_streak_days integer not null default 0,
  last_active_day date,
  streak_started_day date,
  courses_completed integer not null default 0,
  perfect_scores integer not null default 0,
  assessments_passed integer not null default 0,
  opted_out boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);
alter table public.user_gamification enable row level security;
drop policy if exists "own gamification read" on public.user_gamification;
create policy "own gamification read" on public.user_gamification
  for select using (user_id = auth.uid());
drop policy if exists "admins read org gamification" on public.user_gamification;
create policy "admins read org gamification" on public.user_gamification
  for select using (public.is_org_admin(organization_id));
-- Writes via engine RPCs only.

-- ── 5) Badge catalog (global seed + per-org override by slug) ───────────────

create table if not exists public.gamification_badges (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade, -- NULL = global
  slug text not null,
  name text not null,
  description text,
  icon text, -- emoji in v1
  criteria_type text not null check (criteria_type in (
    'perfect_score','streak_days','courses_completed','assessments_passed',
    'completion_speed','monthly_top3','monthly_improved','monthly_champion','manual')),
  threshold numeric,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index if not exists gamification_badges_global_slug_idx
  on public.gamification_badges (slug) where organization_id is null;
create unique index if not exists gamification_badges_org_slug_idx
  on public.gamification_badges (organization_id, slug) where organization_id is not null;

alter table public.gamification_badges enable row level security;
drop policy if exists "members read badges" on public.gamification_badges;
create policy "members read badges" on public.gamification_badges
  for select using (
    organization_id is null or public.is_org_member(organization_id)
  );
drop policy if exists "admins manage org badges" on public.gamification_badges;
create policy "admins manage org badges" on public.gamification_badges
  for all
  using (organization_id is not null and public.is_org_admin(organization_id))
  with check (organization_id is not null and public.is_org_admin(organization_id));

insert into public.gamification_badges (organization_id, slug, name, description, icon, criteria_type, threshold)
values
  (null, 'perfect_score',     'Perfect Score',     'Score 100% on a course',                    '💯', 'perfect_score',      1),
  (null, 'streak_7',          '7-Day Streak',      'Learn on 7 days in a row',                  '🔥', 'streak_days',        7),
  (null, 'knowledge_hunter',  'Knowledge Hunter',  'Complete 10 courses',                       '🎯', 'courses_completed', 10),
  (null, 'assessment_ace',    'Assessment Ace',    'Pass 5 assessments',                        '🏅', 'assessments_passed', 5),
  (null, 'speed_learner',     'Speed Learner',     'Finish a course within 30 minutes',         '⚡', 'completion_speed',  30),
  (null, 'top_3',             'Top 3',             'Finish a month in the org Top 3',           '🏆', 'monthly_top3',    null),
  (null, 'most_improved',     'Most Improved',     'Biggest XP climb of the month',             '📈', 'monthly_improved', null),
  (null, 'learning_champion', 'Learning Champion', 'Rank #1 for the month',                     '👑', 'monthly_champion', null)
on conflict do nothing;

-- ── 6) Earned badges ────────────────────────────────────────────────────────

create table if not exists public.user_badges (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  badge_slug text not null,
  period text, -- 'YYYY-MM' for monthly badges; NULL = lifetime
  awarded_at timestamptz not null default now(),
  revoked_at timestamptz,
  awarded_by uuid references auth.users(id),
  metadata jsonb
);
create unique index if not exists user_badges_once_idx
  on public.user_badges (organization_id, user_id, badge_slug, coalesce(period, ''));
create index if not exists user_badges_org_user_idx
  on public.user_badges (organization_id, user_id, awarded_at desc);

alter table public.user_badges enable row level security;
drop policy if exists "own badges read" on public.user_badges;
create policy "own badges read" on public.user_badges
  for select using (user_id = auth.uid());
drop policy if exists "admins read org user badges" on public.user_badges;
create policy "admins read org user badges" on public.user_badges
  for select using (public.is_org_admin(organization_id));
-- Writes via engine/service role only.

-- ── 7) Monthly recognition history ──────────────────────────────────────────

create table if not exists public.gamification_recognitions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  period text not null, -- 'YYYY-MM' (org-local month)
  category text not null check (category in (
    'top_overall','most_active','highest_scorer','most_improved','longest_streak','team_top')),
  rank integer not null check (rank between 1 and 3),
  user_id uuid references auth.users(id) on delete set null,
  team_id uuid references public.teams(id) on delete set null,
  metric_value numeric not null,
  -- Frozen display data (name, avatar_url, xp, level) so history survives
  -- renames and account deletion.
  snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (organization_id, period, category, rank)
);
alter table public.gamification_recognitions enable row level security;
drop policy if exists "members read recognitions" on public.gamification_recognitions;
create policy "members read recognitions" on public.gamification_recognitions
  for select using (public.is_org_member(organization_id));
drop policy if exists "admins manage recognitions" on public.gamification_recognitions;
create policy "admins manage recognitions" on public.gamification_recognitions
  for all
  using (public.is_org_admin(organization_id))
  with check (public.is_org_admin(organization_id));

-- ── 8) Level ladder helper ──────────────────────────────────────────────────

-- Default ladder; per-org override via gamification_settings.level_thresholds
-- (same jsonb shape). Returns the level for a given XP plus the next rung.
create or replace function public.gamification_level_for(p_xp integer, p_thresholds jsonb)
returns table (level integer, name text, next_level_xp integer)
language sql stable as $$
  with ladder as (
    select (e->>'level')::int as lvl, e->>'name' as nm, (e->>'xp')::int as xp
    from jsonb_array_elements(
      coalesce(
        p_thresholds,
        '[{"level":1,"name":"Starter","xp":0},
          {"level":2,"name":"Explorer","xp":100},
          {"level":3,"name":"Learner","xp":300},
          {"level":4,"name":"Performer","xp":700},
          {"level":5,"name":"Professional","xp":1500},
          {"level":6,"name":"Expert","xp":3000},
          {"level":7,"name":"Yodha","xp":6000},
          {"level":8,"name":"Master Yodha","xp":12000}]'::jsonb
      )
    ) e
  ),
  cur as (
    select lvl, nm from ladder where xp <= greatest(p_xp, 0)
    order by xp desc limit 1
  ),
  nxt as (
    select min(xp) as xp from ladder where xp > greatest(p_xp, 0)
  )
  select coalesce(cur.lvl, 1), coalesce(cur.nm, 'Starter'), nxt.xp
  from cur full join nxt on true;
$$;

-- ── 9) The engine RPC ───────────────────────────────────────────────────────

create or replace function public.gamification_record_activity(p_attempt_id uuid)
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
  v_speed_minutes numeric;
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

    -- Candidate 3: score bonuses. Perfect requires a non-suspect pass
    -- (a raw SCORM score of 1/100 stores as 1.0 with success 'failed').
    if v_att.score is not null and v_att.score >= 0.999
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
    elsif v_att.score is not null and v_att.score >= 0.90 and v_att.score < 0.999 then
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

  -- Counters + level (level never demotes).
  v_new_completed := v_ug.courses_completed + case when v_completed_event then 1 else 0 end;
  v_new_perfect := v_ug.perfect_scores + case when v_perfect_event then 1 else 0 end;
  v_new_passed := v_ug.assessments_passed
    + case when v_completed_event and v_att.success_status = 'passed' then 1 else 0 end;
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
    'ok', true, 'awarded_xp', v_inserted, 'streak', v_streak, 'awards', v_awards);
end;
$$;
revoke all on function public.gamification_record_activity(uuid) from public, anon, authenticated;
grant execute on function public.gamification_record_activity(uuid) to service_role;

-- Manual / imported XP (admin awards; the LPL/challenges extension point).
create or replace function public.gamification_award_manual(
  p_org uuid, p_user uuid, p_xp integer, p_rule text,
  p_dedupe_key text, p_metadata jsonb, p_awarded_by uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_set record;
  v_total integer;
  v_level integer;
begin
  if p_rule not in ('manual', 'import', 'adjustment') then
    return jsonb_build_object('ok', false, 'reason', 'invalid_rule');
  end if;
  select * into v_set from public.gamification_settings where organization_id = p_org;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'org_not_provisioned');
  end if;

  insert into public.xp_events (organization_id, user_id, rule, xp, dedupe_key, metadata, awarded_by)
  values (p_org, p_user, p_rule, p_xp, p_dedupe_key, p_metadata, p_awarded_by)
  on conflict (dedupe_key) do nothing;
  if not found then
    return jsonb_build_object('ok', true, 'skipped', 'duplicate');
  end if;

  insert into public.user_gamification (organization_id, user_id)
  values (p_org, p_user) on conflict (organization_id, user_id) do nothing;
  update public.user_gamification ug set
    total_xp = ug.total_xp + p_xp,
    updated_at = now()
  where ug.organization_id = p_org and ug.user_id = p_user
  returning ug.total_xp into v_total;
  select l.level into v_level from public.gamification_level_for(v_total, v_set.level_thresholds) l;
  update public.user_gamification set current_level = greatest(current_level, coalesce(v_level, 1))
  where organization_id = p_org and user_id = p_user;

  return jsonb_build_object('ok', true, 'awarded_xp', p_xp, 'total_xp', v_total);
end;
$$;
revoke all on function public.gamification_award_manual(uuid, uuid, integer, text, text, jsonb, uuid)
  from public, anon, authenticated;
grant execute on function public.gamification_award_manual(uuid, uuid, integer, text, text, jsonb, uuid)
  to service_role;

-- Learner opt-out toggle (authenticated; respects org allow_opt_out).
create or replace function public.set_gamification_opt_out(p_org uuid, p_opt_out boolean)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_allow boolean;
begin
  if not exists (
    select 1 from public.organization_members
    where organization_id = p_org and user_id = auth.uid() and status = 'active'
  ) then
    return jsonb_build_object('ok', false, 'reason', 'not_a_member');
  end if;
  select allow_opt_out into v_allow from public.gamification_settings
   where organization_id = p_org;
  if p_opt_out and coalesce(v_allow, true) is not true then
    return jsonb_build_object('ok', false, 'reason', 'opt_out_disabled');
  end if;
  insert into public.user_gamification (organization_id, user_id, opted_out)
  values (p_org, auth.uid(), p_opt_out)
  on conflict (organization_id, user_id) do update set opted_out = excluded.opted_out, updated_at = now();
  return jsonb_build_object('ok', true, 'opted_out', p_opt_out);
end;
$$;
grant execute on function public.set_gamification_opt_out(uuid, boolean) to authenticated;

-- ── 10) Leaderboard matviews (house rules from 0031/0049) ───────────────────

drop materialized view if exists public.mv_leaderboard;
create materialized view public.mv_leaderboard as
with settings as (
  select organization_id, allow_opt_out from public.gamification_settings
),
xp_windows as (
  select e.organization_id, e.user_id,
    coalesce(sum(e.xp) filter (where e.created_at >= now() - interval '30 days'), 0) as xp_30d,
    coalesce(sum(e.xp) filter (where e.created_at >= now() - interval '60 days'
                                 and e.created_at <  now() - interval '30 days'), 0) as xp_prev_30d,
    count(*) filter (where e.rule = 'daily_activity'
                       and e.created_at >= now() - interval '30 days') as active_days_30d,
    max(e.created_at) as last_event_at
  from public.xp_events e
  group by 1, 2
),
scores as (
  select om.organization_id, s.user_id,
    avg(s.best_score) filter (
      where s.latest_completion = 'completed' or s.latest_success = 'passed'
    ) as avg_score
  from public.v_course_attempt_summary s
  join public.organization_members om on om.user_id = s.user_id
  group by 1, 2
),
badge_counts as (
  select organization_id, user_id, count(*) as badges_count
  from public.user_badges where revoked_at is null
  group by 1, 2
),
base as (
  select
    ug.organization_id, ug.user_id,
    p.first_name, p.last_name, p.email, p.avatar_url,
    ug.total_xp, ug.current_level, ug.current_streak_days, ug.longest_streak_days,
    ug.courses_completed,
    coalesce(b.badges_count, 0) as badges_count,
    coalesce(w.xp_30d, 0) as xp_30d,
    coalesce(w.xp_prev_30d, 0) as xp_prev_30d,
    coalesce(w.active_days_30d, 0) as active_days_30d,
    sc.avg_score,
    w.last_event_at,
    (ug.opted_out and coalesce(s.allow_opt_out, true)) as hidden
  from public.user_gamification ug
  join public.profiles p on p.id = ug.user_id
  left join settings s on s.organization_id = ug.organization_id
  left join xp_windows w
    on w.organization_id = ug.organization_id and w.user_id = ug.user_id
  left join scores sc
    on sc.organization_id = ug.organization_id and sc.user_id = ug.user_id
  left join badge_counts b
    on b.organization_id = ug.organization_id and b.user_id = ug.user_id
)
select
  base.*,
  case when hidden then null else
    rank() over (partition by organization_id, hidden
      order by total_xp desc, courses_completed desc, last_event_at asc nulls last, user_id)
  end as rank_overall,
  case when hidden then null else
    rank() over (partition by organization_id, hidden
      order by active_days_30d desc, xp_30d desc, user_id)
  end as rank_most_active,
  case when hidden or avg_score is null then null else
    rank() over (partition by organization_id, hidden, (avg_score is null)
      order by avg_score desc nulls last, courses_completed desc, user_id)
  end as rank_highest_scorer,
  case when hidden or xp_prev_30d < 50 then null else
    rank() over (partition by organization_id, hidden, (xp_prev_30d >= 50)
      order by (xp_30d - xp_prev_30d) desc, xp_30d desc, user_id)
  end as rank_most_improved,
  case when hidden then null else
    rank() over (partition by organization_id, hidden
      order by current_streak_days desc, longest_streak_days desc, user_id)
  end as rank_longest_streak,
  now() as refreshed_at
from base;
create unique index mv_leaderboard_idx on public.mv_leaderboard (organization_id, user_id);
revoke all on public.mv_leaderboard from anon, authenticated;
grant select on public.mv_leaderboard to service_role;

drop materialized view if exists public.mv_team_leaderboard;
create materialized view public.mv_team_leaderboard as
select
  t.organization_id,
  t.id as team_id,
  t.name as team_name,
  count(tm.user_id) as member_count,
  coalesce(sum(ug.total_xp), 0) as total_xp,
  coalesce(avg(ug.total_xp), 0)::numeric(12, 2) as avg_xp,
  rank() over (partition by t.organization_id
    order by coalesce(avg(ug.total_xp), 0) desc, count(tm.user_id) desc, t.id) as rank_team,
  now() as refreshed_at
from public.teams t
join public.team_members tm on tm.team_id = t.id
left join public.user_gamification ug
  on ug.user_id = tm.user_id and ug.organization_id = t.organization_id
group by t.organization_id, t.id, t.name;
create unique index mv_team_leaderboard_idx on public.mv_team_leaderboard (organization_id, team_id);
revoke all on public.mv_team_leaderboard from anon, authenticated;
grant select on public.mv_team_leaderboard to service_role;

create or replace function public.refresh_gamification_views()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  view_name text;
  t0 timestamptz;
  ms numeric;
  rowcount bigint;
  err text;
  result jsonb := '[]'::jsonb;
begin
  foreach view_name in array array['mv_leaderboard', 'mv_team_leaderboard']
  loop
    t0 := clock_timestamp(); err := null; rowcount := null;
    begin
      execute format('refresh materialized view concurrently public.%I', view_name);
      execute format('select count(*) from public.%I', view_name) into rowcount;
    exception when others then
      err := sqlerrm;
    end;
    ms := extract(milliseconds from (clock_timestamp() - t0));
    result := result || jsonb_build_object('view', view_name, 'ms', ms, 'rows', rowcount, 'error', err);
  end loop;
  return result;
end;
$$;
revoke all on function public.refresh_gamification_views() from public, anon, authenticated;
grant execute on function public.refresh_gamification_views() to service_role;

-- ── 11) Personal strip RPC (authenticated; one round trip) ──────────────────

create or replace function public.get_my_gamification(p_org uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_ug record;
  v_set record;
  v_lvl record;
  v_rank bigint;
  v_tenth integer;
  v_next_badge jsonb;
  v_badges jsonb;
begin
  if not exists (
    select 1 from public.organization_members
    where organization_id = p_org and user_id = auth.uid() and status = 'active'
  ) then
    return jsonb_build_object('ok', false, 'reason', 'not_a_member');
  end if;
  select * into v_set from public.gamification_settings where organization_id = p_org;
  if v_set is null or v_set.enabled is distinct from true then
    return jsonb_build_object('ok', true, 'enabled', false);
  end if;

  select * into v_ug from public.user_gamification
   where organization_id = p_org and user_id = auth.uid();
  if not found then
    select l.level as level, l.name as name, l.next_level_xp as next_level_xp
      into v_lvl from public.gamification_level_for(0, v_set.level_thresholds) l;
    return jsonb_build_object(
      'ok', true, 'enabled', true, 'zero', true,
      'total_xp', 0, 'level', 1, 'level_name', v_lvl.name,
      'xp_to_next_level', v_lvl.next_level_xp,
      'streak_days', 0, 'rank', null, 'opted_out', false,
      'leaderboard_enabled', v_set.leaderboard_enabled,
      'badges', '[]'::jsonb, 'next_badge', null, 'xp_to_top10', null);
  end if;

  select l.level as level, l.name as name, l.next_level_xp as next_level_xp
    into v_lvl
    from public.gamification_level_for(v_ug.total_xp, v_set.level_thresholds) l;

  select rank_overall into v_rank from public.mv_leaderboard
   where organization_id = p_org and user_id = auth.uid();

  -- XP needed to enter the top 10 (null when already there or board too small).
  select min(total_xp) into v_tenth from public.mv_leaderboard
   where organization_id = p_org and rank_overall is not null and rank_overall <= 10
  having count(*) >= 10;

  -- Nearest count-based badge not yet earned.
  select jsonb_build_object(
      'slug', c.slug, 'name', c.name, 'icon', c.icon,
      'remaining', c.remaining, 'unit', c.unit)
    into v_next_badge
  from (
    select b.slug, b.name, b.icon,
      case b.criteria_type
        when 'streak_days'        then b.threshold - v_ug.current_streak_days
        when 'courses_completed'  then b.threshold - v_ug.courses_completed
        when 'assessments_passed' then b.threshold - v_ug.assessments_passed
        when 'perfect_score'      then coalesce(b.threshold, 1) - v_ug.perfect_scores
      end as remaining,
      case b.criteria_type
        when 'streak_days' then 'days'
        when 'courses_completed' then 'courses'
        when 'assessments_passed' then 'assessments'
        when 'perfect_score' then 'perfect scores'
      end as unit
    from (
      select distinct on (slug) slug, name, icon, criteria_type, threshold
        from public.gamification_badges
       where enabled and (organization_id is null or organization_id = p_org)
         and criteria_type in ('streak_days','courses_completed','assessments_passed','perfect_score')
       order by slug, organization_id nulls last
    ) b
    where not exists (
      select 1 from public.user_badges ub
      where ub.organization_id = p_org and ub.user_id = auth.uid()
        and ub.badge_slug = b.slug and ub.revoked_at is null
    )
  ) c
  where c.remaining is not null and c.remaining > 0
  order by c.remaining asc
  limit 1;

  select coalesce(jsonb_agg(jsonb_build_object(
      'slug', ub.badge_slug, 'awarded_at', ub.awarded_at,
      'name', cat.name, 'icon', cat.icon)
      order by ub.awarded_at desc), '[]'::jsonb)
    into v_badges
  from (
    select badge_slug, max(awarded_at) as awarded_at
      from public.user_badges
     where organization_id = p_org and user_id = auth.uid() and revoked_at is null
     group by badge_slug
     order by max(awarded_at) desc
     limit 3
  ) ub
  left join lateral (
    select name, icon from public.gamification_badges
     where slug = ub.badge_slug and (organization_id is null or organization_id = p_org)
     order by organization_id nulls last limit 1
  ) cat on true;

  return jsonb_build_object(
    'ok', true, 'enabled', true, 'zero', false,
    'total_xp', v_ug.total_xp,
    'level', v_ug.current_level,
    'level_name', v_lvl.name,
    'xp_to_next_level', case when v_lvl.next_level_xp is null then null
                             else greatest(v_lvl.next_level_xp - v_ug.total_xp, 0) end,
    'streak_days', v_ug.current_streak_days,
    'rank', v_rank,
    'opted_out', v_ug.opted_out,
    'leaderboard_enabled', v_set.leaderboard_enabled,
    'xp_to_top10', case when v_tenth is null or v_ug.total_xp >= v_tenth then null
                        else v_tenth - v_ug.total_xp + 1 end,
    'next_badge', v_next_badge,
    'badges', v_badges);
end;
$$;
grant execute on function public.get_my_gamification(uuid) to authenticated;

-- ── 12) Monthly close (recognitions + monthly badges) ───────────────────────

create or replace function public.gamification_close_month()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_org record;
  v_period text;
  v_start timestamptz;
  v_end timestamptz;
  v_row record;
  v_written integer := 0;
  v_result jsonb := '[]'::jsonb;
begin
  for v_org in
    select gs.organization_id, gs.timezone, gs.allow_opt_out
      from public.gamification_settings gs
     where gs.enabled
  loop
    v_period := to_char(((now() at time zone v_org.timezone)::date - interval '1 month'), 'YYYY-MM');
    v_start := date_trunc('month', (now() at time zone v_org.timezone)::date - interval '1 month')::timestamp
               at time zone v_org.timezone;
    v_end := (date_trunc('month', (now() at time zone v_org.timezone)::date - interval '1 month')
              + interval '1 month')::timestamp at time zone v_org.timezone;

    -- top_overall (+ monthly badges for its winners).
    v_written := 0;
    for v_row in
      select e.user_id, sum(e.xp) as metric,
             row_number() over (order by sum(e.xp) desc, min(e.created_at) asc, e.user_id) as rn
        from public.xp_events e
        join public.user_gamification ug
          on ug.organization_id = e.organization_id and ug.user_id = e.user_id
       where e.organization_id = v_org.organization_id
         and e.created_at >= v_start and e.created_at < v_end
         and not (ug.opted_out and v_org.allow_opt_out)
       group by e.user_id
       order by 2 desc, e.user_id
       limit 3
    loop
      insert into public.gamification_recognitions
        (organization_id, period, category, rank, user_id, metric_value, snapshot)
      select v_org.organization_id, v_period, 'top_overall', v_row.rn, v_row.user_id, v_row.metric,
             jsonb_build_object('name', trim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')),
                                'email', p.email, 'avatar_url', p.avatar_url,
                                'xp', v_row.metric)
        from public.profiles p where p.id = v_row.user_id
      on conflict (organization_id, period, category, rank) do nothing;
      if found then v_written := v_written + 1; end if;

      insert into public.user_badges (organization_id, user_id, badge_slug, period, metadata)
      values (v_org.organization_id, v_row.user_id, 'top_3', v_period,
              jsonb_build_object('rank', v_row.rn))
      on conflict (organization_id, user_id, badge_slug, coalesce(period, '')) do nothing;
      if v_row.rn = 1 then
        insert into public.user_badges (organization_id, user_id, badge_slug, period)
        values (v_org.organization_id, v_row.user_id, 'learning_champion', v_period)
        on conflict (organization_id, user_id, badge_slug, coalesce(period, '')) do nothing;
      end if;
    end loop;

    -- most_active: distinct active days in the month.
    for v_row in
      select e.user_id, count(distinct e.source_day) as metric,
             row_number() over (order by count(distinct e.source_day) desc, e.user_id) as rn
        from public.xp_events e
        join public.user_gamification ug
          on ug.organization_id = e.organization_id and ug.user_id = e.user_id
       where e.organization_id = v_org.organization_id and e.rule = 'daily_activity'
         and e.created_at >= v_start and e.created_at < v_end
         and not (ug.opted_out and v_org.allow_opt_out)
       group by e.user_id order by 2 desc, e.user_id limit 3
    loop
      insert into public.gamification_recognitions
        (organization_id, period, category, rank, user_id, metric_value, snapshot)
      select v_org.organization_id, v_period, 'most_active', v_row.rn, v_row.user_id, v_row.metric,
             jsonb_build_object('name', trim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')),
                                'email', p.email, 'avatar_url', p.avatar_url,
                                'active_days', v_row.metric)
        from public.profiles p where p.id = v_row.user_id
      on conflict (organization_id, period, category, rank) do nothing;
    end loop;

    -- highest_scorer: avg score of courses completed in the month (>=1).
    for v_row in
      select ca.user_id, avg(ca.score) as metric,
             row_number() over (order by avg(ca.score) desc, ca.user_id) as rn
        from public.course_attempts ca
        join public.user_gamification ug
          on ug.organization_id = ca.organization_id and ug.user_id = ca.user_id
       where ca.organization_id = v_org.organization_id
         and ca.completed_at >= v_start and ca.completed_at < v_end
         and ca.score is not null
         and (ca.completion_status = 'completed' or ca.success_status = 'passed')
         and not (ug.opted_out and v_org.allow_opt_out)
       group by ca.user_id order by 2 desc, ca.user_id limit 3
    loop
      insert into public.gamification_recognitions
        (organization_id, period, category, rank, user_id, metric_value, snapshot)
      select v_org.organization_id, v_period, 'highest_scorer', v_row.rn, v_row.user_id, v_row.metric,
             jsonb_build_object('name', trim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')),
                                'email', p.email, 'avatar_url', p.avatar_url,
                                'avg_score', round(v_row.metric * 100))
        from public.profiles p where p.id = v_row.user_id
      on conflict (organization_id, period, category, rank) do nothing;
    end loop;

    -- most_improved: month XP vs previous month XP (qualifier: prev >= 50).
    for v_row in
      with month_xp as (
        select e.user_id,
          sum(e.xp) filter (where e.created_at >= v_start and e.created_at < v_end) as cur_xp,
          sum(e.xp) filter (where e.created_at >= v_start - interval '1 month'
                              and e.created_at < v_start) as prev_xp
          from public.xp_events e
          join public.user_gamification ug
            on ug.organization_id = e.organization_id and ug.user_id = e.user_id
         where e.organization_id = v_org.organization_id
           and e.created_at >= v_start - interval '1 month' and e.created_at < v_end
           and not (ug.opted_out and v_org.allow_opt_out)
         group by e.user_id
      )
      select user_id, (coalesce(cur_xp,0) - coalesce(prev_xp,0)) as metric,
             row_number() over (order by (coalesce(cur_xp,0) - coalesce(prev_xp,0)) desc, user_id) as rn
        from month_xp
       where coalesce(prev_xp, 0) >= 50
       order by 2 desc, user_id limit 3
    loop
      insert into public.gamification_recognitions
        (organization_id, period, category, rank, user_id, metric_value, snapshot)
      select v_org.organization_id, v_period, 'most_improved', v_row.rn, v_row.user_id, v_row.metric,
             jsonb_build_object('name', trim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')),
                                'email', p.email, 'avatar_url', p.avatar_url,
                                'xp_gain', v_row.metric)
        from public.profiles p where p.id = v_row.user_id
      on conflict (organization_id, period, category, rank) do nothing;
      if v_row.rn = 1 then
        insert into public.user_badges (organization_id, user_id, badge_slug, period)
        values (v_org.organization_id, v_row.user_id, 'most_improved', v_period)
        on conflict (organization_id, user_id, badge_slug, coalesce(period, '')) do nothing;
      end if;
    end loop;

    -- longest_streak: streak state as of close (v1 approximation, documented).
    for v_row in
      select ug.user_id, ug.current_streak_days as metric,
             row_number() over (order by ug.current_streak_days desc, ug.longest_streak_days desc, ug.user_id) as rn
        from public.user_gamification ug
       where ug.organization_id = v_org.organization_id
         and ug.current_streak_days > 0
         and not (ug.opted_out and v_org.allow_opt_out)
       order by ug.current_streak_days desc, ug.user_id limit 3
    loop
      insert into public.gamification_recognitions
        (organization_id, period, category, rank, user_id, metric_value, snapshot)
      select v_org.organization_id, v_period, 'longest_streak', v_row.rn, v_row.user_id, v_row.metric,
             jsonb_build_object('name', trim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')),
                                'email', p.email, 'avatar_url', p.avatar_url,
                                'streak_days', v_row.metric)
        from public.profiles p where p.id = v_row.user_id
      on conflict (organization_id, period, category, rank) do nothing;
    end loop;

    -- team_top: month XP summed per team.
    for v_row in
      select t.id as team_id, t.name as team_name, sum(e.xp) as metric,
             row_number() over (order by sum(e.xp) desc, t.id) as rn
        from public.teams t
        join public.team_members tm on tm.team_id = t.id
        join public.xp_events e
          on e.user_id = tm.user_id and e.organization_id = t.organization_id
       where t.organization_id = v_org.organization_id
         and e.created_at >= v_start and e.created_at < v_end
       group by t.id, t.name order by 3 desc, t.id limit 3
    loop
      insert into public.gamification_recognitions
        (organization_id, period, category, rank, team_id, metric_value, snapshot)
      values (v_org.organization_id, v_period, 'team_top', v_row.rn, v_row.team_id, v_row.metric,
              jsonb_build_object('team_name', v_row.team_name, 'xp', v_row.metric))
      on conflict (organization_id, period, category, rank) do nothing;
    end loop;

    v_result := v_result || jsonb_build_object(
      'organization_id', v_org.organization_id, 'period', v_period, 'written', v_written);
  end loop;

  return v_result;
end;
$$;
revoke all on function public.gamification_close_month() from public, anon, authenticated;
grant execute on function public.gamification_close_month() to service_role;

notify pgrst, 'reload schema';

commit;
