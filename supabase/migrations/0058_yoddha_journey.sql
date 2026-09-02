-- =============================================================================
-- 90-Day Yoddha Journey — versioned, fully admin-configurable onboarding
-- =============================================================================
--
-- Model (user decisions, 2026-09-02):
--   - NOTHING hard-coded: the Super Owner edits journey name, icon, day
--     count, the working-day rule, curriculum (create/edit/reorder), all
--     milestones and every learner-facing text from the admin dashboard.
--     lib/journey/journey.ts holds only the DEFAULTS.
--   - VERSIONED: admins edit a DRAFT (journey_programs + journey_days);
--     "Publish" freezes it into journey_versions. Every enrollment pins the
--     version current at enroll time, so later edits never affect employees
--     already progressing or completed. Enrollment requires ≥1 published
--     version.
--   - Day counting default: working days Mon–Sat, per-learner start dates,
--     catch-up allowed, never ahead of the calendar (math in
--     lib/journey/journey.ts; enforced server-side at launch).
--   - Enrollment is ADMIN-DRIVEN (+ optional auto-enroll toggle for new
--     members). Journey attempts award NO competitive XP (engine wrapper
--     below). Completion = every version day that has a module → the
--     enrollment completes and the permanent 'yoddha' badge is awarded.
--
-- DEPENDS ON: 0053 (gamification engine/badges) and 0056's is_org_admin
-- re-assert.

-- ── 1) Program = the editable DRAFT ─────────────────────────────────────────

create table if not exists public.journey_programs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null default '90-Day Yoddha Journey',
  icon text not null default '🏹',
  days_total integer not null default 90 check (days_total between 1 and 365),
  -- false = working days Mon–Sat (Sundays don't count toward the drip).
  count_sundays boolean not null default false,
  auto_enroll_new_users boolean not null default false,
  -- [{ "day": 30, "icon": "🛡️", "name": "Foundation Builder", "message": "…" }]
  milestones jsonb,
  -- Learner-facing text overrides { mission_label, mission_subtitle, … };
  -- null/missing keys = defaults in lib/journey/journey.ts.
  copy jsonb,
  completion_title text not null default 'Yoddha',
  -- Pause switch: learners keep their place but can't launch while off.
  is_active boolean not null default true,
  current_version_id uuid, -- fk added after journey_versions exists
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists journey_programs_one_per_org_idx
  on public.journey_programs (organization_id);

alter table public.journey_programs enable row level security;
drop policy if exists "members read journey programs" on public.journey_programs;
create policy "members read journey programs" on public.journey_programs
  for select using (public.is_org_member(organization_id));
drop policy if exists "admins manage journey programs" on public.journey_programs;
create policy "admins manage journey programs" on public.journey_programs
  for all using (public.is_org_admin(organization_id))
  with check (public.is_org_admin(organization_id));

-- ── 2) Draft curriculum: one module per day ─────────────────────────────────

create table if not exists public.journey_days (
  id uuid primary key default gen_random_uuid(),
  program_id uuid not null references public.journey_programs(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  day_number integer not null check (day_number between 1 and 365),
  -- The same course MAY appear on multiple days (content ramps up over time).
  course_id uuid references public.courses(id) on delete set null,
  -- "Master Customer Discovery" — shown as TODAY'S MISSION; null = course title.
  mission_title text,
  unique (program_id, day_number)
);
create index if not exists journey_days_program_idx
  on public.journey_days (program_id, day_number);

alter table public.journey_days enable row level security;
drop policy if exists "members read journey days" on public.journey_days;
create policy "members read journey days" on public.journey_days
  for select using (public.is_org_member(organization_id));
drop policy if exists "admins manage journey days" on public.journey_days;
create policy "admins manage journey days" on public.journey_days
  for all using (public.is_org_admin(organization_id))
  with check (public.is_org_admin(organization_id));

-- ── 3) Published, immutable versions ────────────────────────────────────────
-- A frozen snapshot of everything a learner's run depends on. Enrollments
-- pin one; edits to the draft only reach NEW enrollments after a publish.

create table if not exists public.journey_versions (
  id uuid primary key default gen_random_uuid(),
  program_id uuid not null references public.journey_programs(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  version_number integer not null,
  name text not null,
  icon text not null default '🏹',
  days_total integer not null,
  count_sundays boolean not null,
  milestones jsonb,
  copy jsonb,
  completion_title text not null,
  -- [{ "day": 1, "course_id": "…", "mission_title": "…" }, …]
  days jsonb not null,
  published_by uuid references auth.users(id),
  published_at timestamptz not null default now(),
  unique (program_id, version_number)
);
create index if not exists journey_versions_program_idx
  on public.journey_versions (program_id, version_number desc);
-- Journey entitlement lookups ask "which of my versions contain course X?".
create index if not exists journey_versions_days_gin_idx
  on public.journey_versions using gin (days jsonb_path_ops);

alter table public.journey_versions enable row level security;
drop policy if exists "members read journey versions" on public.journey_versions;
create policy "members read journey versions" on public.journey_versions
  for select using (public.is_org_member(organization_id));
-- Published versions are IMMUTABLE: admins may only publish (insert). No
-- update/delete policies exist, so nobody — not even an admin hitting the
-- REST API directly — can rewrite history under a pinned enrollment.
drop policy if exists "admins manage journey versions" on public.journey_versions;
drop policy if exists "admins publish journey versions" on public.journey_versions;
create policy "admins publish journey versions" on public.journey_versions
  for insert with check (public.is_org_admin(organization_id));

alter table public.journey_programs
  drop constraint if exists journey_programs_current_version_fk;
alter table public.journey_programs
  add constraint journey_programs_current_version_fk
  foreign key (current_version_id) references public.journey_versions(id)
  on delete set null;

-- ── 4) Enrollments (admin-driven; pinned to a version) ──────────────────────

create table if not exists public.journey_enrollments (
  id uuid primary key default gen_random_uuid(),
  program_id uuid not null references public.journey_programs(id) on delete cascade,
  version_id uuid not null references public.journey_versions(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  start_date date not null,
  status text not null default 'active' check (status in ('active', 'completed', 'reset')),
  completed_at timestamptz,
  enrolled_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create unique index if not exists journey_enrollments_one_active_idx
  on public.journey_enrollments (program_id, user_id) where status = 'active';
create index if not exists journey_enrollments_org_user_idx
  on public.journey_enrollments (organization_id, user_id);

alter table public.journey_enrollments enable row level security;
drop policy if exists "own journey enrollment" on public.journey_enrollments;
create policy "own journey enrollment" on public.journey_enrollments
  for select using (user_id = auth.uid());
drop policy if exists "admins manage journey enrollments" on public.journey_enrollments;
create policy "admins manage journey enrollments" on public.journey_enrollments
  for all using (public.is_org_admin(organization_id))
  with check (public.is_org_admin(organization_id));

-- ── 5) Per-day progress (service-role writes via the RPC only) ──────────────

create table if not exists public.journey_day_progress (
  id uuid primary key default gen_random_uuid(),
  enrollment_id uuid not null references public.journey_enrollments(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  day_number integer not null,
  course_id uuid references public.courses(id) on delete set null,
  attempt_id uuid references public.course_attempts(id) on delete set null,
  completed_at timestamptz not null default now(),
  unique (enrollment_id, day_number)
);
create index if not exists journey_day_progress_enrollment_idx
  on public.journey_day_progress (enrollment_id, day_number);

alter table public.journey_day_progress enable row level security;
drop policy if exists "own journey progress" on public.journey_day_progress;
create policy "own journey progress" on public.journey_day_progress
  for select using (user_id = auth.uid());
drop policy if exists "admins read journey progress" on public.journey_day_progress;
create policy "admins read journey progress" on public.journey_day_progress
  for select using (public.is_org_admin(organization_id));
-- No insert/update/delete policies: journey_record_completion + service role.

-- ── 6) Attempt tagging (set at launch when opened from the journey) ─────────

alter table public.course_attempts
  add column if not exists journey_enrollment_id uuid
    references public.journey_enrollments(id) on delete set null,
  add column if not exists journey_day integer;
create index if not exists course_attempts_journey_idx
  on public.course_attempts (journey_enrollment_id)
  where journey_enrollment_id is not null;

-- ── 7) Journey attempts award NO competitive XP ─────────────────────────────
-- Wrap (not copy) 0053's engine: rename the original once, then install a
-- same-named wrapper that skips journey-tagged attempts and delegates
-- everything else. Hook call sites stay untouched.
--
-- ⚠ ORDERING HAZARD: if migration 0053 is ever RE-applied after this one
-- (e.g. an idempotent prod catch-up run twice), its `create or replace
-- gamification_record_activity` overwrites this wrapper and journey
-- attempts would earn XP again. Always re-run THIS section afterwards —
-- the whole file is idempotent, so re-running all of 0058 is safe.

do $$
begin
  if to_regprocedure('public.gamification_record_activity_core(uuid)') is null then
    alter function public.gamification_record_activity(uuid)
      rename to gamification_record_activity_core;
  end if;
end $$;

create or replace function public.gamification_record_activity(p_attempt_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_att record;
begin
  select a.user_id, a.journey_enrollment_id, cv.course_id
    into v_att
    from public.course_attempts a
    join public.course_versions cv on cv.id = a.course_version_id
   where a.id = p_attempt_id;
  -- Mandatory onboarding earns no XP/streaks/leaderboard points — and that
  -- must hold for EVERY entry point, not just journey-tagged launches. Any
  -- course that appears in one of this learner's journey versions (active
  -- OR completed — reviews don't farm either) is XP-exempt for them, which
  -- closes the untagged-relaunch farming hole while leaving the same course
  -- fully XP-eligible for learners who aren't on the journey.
  if v_att.journey_enrollment_id is not null or exists (
    select 1
      from public.journey_enrollments e
      join public.journey_versions v on v.id = e.version_id
     where e.user_id = v_att.user_id
       and e.status in ('active', 'completed')
       and v.days @> jsonb_build_array(
             jsonb_build_object('course_id', v_att.course_id::text))
  ) then
    return jsonb_build_object('ok', true, 'skipped', 'journey_course');
  end if;
  return public.gamification_record_activity_core(p_attempt_id);
end;
$$;
revoke all on function public.gamification_record_activity(uuid) from public, anon, authenticated;
grant execute on function public.gamification_record_activity(uuid) to service_role;
revoke all on function public.gamification_record_activity_core(uuid) from public, anon, authenticated;
grant execute on function public.gamification_record_activity_core(uuid) to service_role;

-- ── 8) The Yoddha badge (global seed; org-overridable like the others) ──────

insert into public.gamification_badges
  (organization_id, slug, name, description, icon, criteria_type, threshold)
values
  (null, 'yoddha', 'Yoddha', 'Completed the 90-Day Yoddha Journey', '👑', 'manual', null)
on conflict do nothing;

-- ── 9) Progress recorder (called fail-isolated from SCORM/xAPI hooks) ───────
-- Idempotent per (enrollment, day). Reads the enrollment's PINNED VERSION,
-- so a later publish never changes what counts as complete for an in-flight
-- run. Progression walks COURSE DAYS only — days without a module are rest
-- days that are skipped, never blockers. Completion = every course day done.
--
-- ENTRY-POINT AGNOSTIC: a tagged attempt credits its tagged day; an
-- UNTAGGED completion of exactly the learner's next mission (and only up to
-- the calendar-allowed day — catch-up yes, getting ahead no) is auto-
-- credited and retro-tagged, so finishing today's module from the course
-- page counts instead of forcing the learner to redo it from the journey.

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
revoke all on function public.journey_record_completion(uuid) from public, anon, authenticated;
grant execute on function public.journey_record_completion(uuid) to service_role;

-- ── 10) Optional auto-enrollment of NEW members (admin toggle) ──────────────
-- Pins the program's current published version; silently skips when nothing
-- has been published yet (an unpublished journey can't enroll anyone).

create or replace function public.journey_auto_enroll()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_prog record;
  v_tz text;
begin
  select id, current_version_id into v_prog
    from public.journey_programs
   where organization_id = new.organization_id
     and is_active and auto_enroll_new_users
     and current_version_id is not null
   limit 1;
  if v_prog.id is null then return new; end if;
  select coalesce(gs.timezone, 'Asia/Kolkata') into v_tz
    from public.gamification_settings gs
   where gs.organization_id = new.organization_id;
  insert into public.journey_enrollments
    (program_id, version_id, organization_id, user_id, start_date, enrolled_by)
  values
    (v_prog.id, v_prog.current_version_id, new.organization_id, new.user_id,
     (now() at time zone coalesce(v_tz, 'Asia/Kolkata'))::date, null)
  on conflict do nothing;
  return new;
end;
$$;
drop trigger if exists organization_members_journey_enroll on public.organization_members;
create trigger organization_members_journey_enroll
  after insert on public.organization_members
  for each row execute function public.journey_auto_enroll();

notify pgrst, 'reload schema';
