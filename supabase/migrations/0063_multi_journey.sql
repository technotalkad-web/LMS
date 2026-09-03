-- 0063_multi_journey.sql
-- Personalised Learning Journeys, Phase 1: MULTIPLE journeys per org.
--
-- The Yoddha engine becomes a platform: an org can run several role-based
-- journeys at once (Sales Advisor Journey, ABM Journey, …). Product
-- decisions (2026-09-03): a learner may hold several active journeys;
-- programs carry an admin-set priority RANK (1 = highest) that decides
-- which journey leads the learner's journey page and dashboard banner.
--
--   1) The one-per-org unique index is replaced by uniqueness on the
--      journey NAME within the org.
--   2) journey_programs gains:
--        priority      int  (rank, 1 = highest; default 100)
--        is_mandatory  bool (default true — journeys are mandatory unless
--                            the admin relaxes one; drives focus/escalation
--                            in later phases)
--        audience      jsonb — WHO the journey targets, keyed off governed
--                      profile fields + teams:
--                        { "designations": [], "job_roles": [], "cities": [],
--                          "verticals": [], "branches": [], "team_ids": [] }
--                      null / all-empty = every active member. Values are
--                      the org's governed master values (0055/0056).
--   3) journey_auto_enroll() is rewritten to be multi-program and
--      audience-aware: a new member is auto-enrolled into EVERY active,
--      published, auto-enroll journey whose audience matches their profile
--      fields. (team_ids can't match at member-insert time — team
--      memberships don't exist yet; the admin "Sync audience" action
--      covers team-based audiences.)
--
-- Backward compatible: existing single programs keep priority 100,
-- audience null (= everyone), is_mandatory true — behavior unchanged.
-- Drift-safe: idempotent; existing enrollments untouched.

drop index if exists public.journey_programs_one_per_org_idx;
create unique index if not exists journey_programs_org_name_idx
  on public.journey_programs (organization_id, lower(name));

alter table public.journey_programs
  add column if not exists priority integer not null default 100
    check (priority between 1 and 999),
  add column if not exists is_mandatory boolean not null default true,
  add column if not exists audience jsonb;

-- Audience match helper: does a member row match a program's audience?
-- Empty/missing arrays are wildcards; a non-empty array must contain the
-- member's value (exact canonical string — governance stores canonically).
create or replace function public.journey_audience_matches(
  p_audience jsonb,
  p_designation text,
  p_job_role text,
  p_city text,
  p_vertical text,
  p_branch text
) returns boolean language sql immutable as $$
  select p_audience is null
    or (
      (coalesce(jsonb_array_length(p_audience->'designations'), 0) = 0
        or p_audience->'designations' ? coalesce(p_designation, ''))
      and (coalesce(jsonb_array_length(p_audience->'job_roles'), 0) = 0
        or p_audience->'job_roles' ? coalesce(p_job_role, ''))
      and (coalesce(jsonb_array_length(p_audience->'cities'), 0) = 0
        or p_audience->'cities' ? coalesce(p_city, ''))
      and (coalesce(jsonb_array_length(p_audience->'verticals'), 0) = 0
        or p_audience->'verticals' ? coalesce(p_vertical, ''))
      and (coalesce(jsonb_array_length(p_audience->'branches'), 0) = 0
        or p_audience->'branches' ? coalesce(p_branch, ''))
    );
$$;

-- Multi-program, audience-aware auto-enrollment (replaces 0058's single-
-- program version; same trigger name/binding).
create or replace function public.journey_auto_enroll()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_prog record;
  v_tz text;
begin
  select coalesce(gs.timezone, 'Asia/Kolkata') into v_tz
    from public.gamification_settings gs
   where gs.organization_id = new.organization_id;
  for v_prog in
    select id, current_version_id
      from public.journey_programs
     where organization_id = new.organization_id
       and is_active and auto_enroll_new_users
       and current_version_id is not null
       and public.journey_audience_matches(
             audience, new.designation, new.job_role, new.city,
             new.business_vertical, new.branch)
  loop
    insert into public.journey_enrollments
      (program_id, version_id, organization_id, user_id, start_date, enrolled_by)
    values
      (v_prog.id, v_prog.current_version_id, new.organization_id, new.user_id,
       (now() at time zone coalesce(v_tz, 'Asia/Kolkata'))::date, null)
    on conflict do nothing;
  end loop;
  return new;
end;
$$;
drop trigger if exists organization_members_journey_enroll on public.organization_members;
create trigger organization_members_journey_enroll
  after insert on public.organization_members
  for each row execute function public.journey_auto_enroll();

notify pgrst, 'reload schema';
