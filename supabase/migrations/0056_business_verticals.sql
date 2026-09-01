-- =============================================================================
-- Business verticals + hierarchical performance leaderboard (verticals board)
-- =============================================================================
--
-- Model (user decisions, 2026-08-31):
--   - business_vertical is a per-membership profile field, governed by the
--     Master data lists (0055). Seeded with Retail / Institutional /
--     Fulfillment per org; admins can rename/extend the list. The field is
--     RESTRICTED to master values but not mandatory (unassigned users land
--     in an admin-visible "Unassigned" bucket).
--   - The hierarchy City → Branch → Team Leader → Team Members derives
--     entirely from profile fields (city + branch + line_manager_id). branch
--     is a new governed master-data field (e.g. Thane / Borivali / Vashi
--     under Mumbai) — optional, so unbranched members group under
--     "No branch set" within their city. No parallel structures; profile
--     edits reflect on the board automatically.
--   - Per-learner course metrics (assigned / completed / avg score) are
--     precomputed in mv_learner_metrics on the 15-min gamification refresh;
--     identity + hierarchy are read LIVE at render so name/photo/city/team
--     changes appear immediately.
--   - gamification_settings.leaderboard_team_leader_view: admin toggle for
--     whether team leaders can see member-level rows of their own reports.
--
-- DEPENDS ON: 0031 (v_course_enrollments_expanded / v_path_enrollments_expanded
-- / v_course_attempt_summary) and 0053/0055. In the prod catch-up bundle this
-- file must run after those or the matview CREATE below aborts.

-- ── 0) Drift-safe role helpers (staging confirmed stale 2026-09-01) ──────────
-- Hand-applied environments can still carry 0002's is_org_admin, which lacks
-- 'super_owner' — leaving Super Owners unable to read other members' rows
-- (edit-user 404s) or write gamification_settings. Re-assert the 0010
-- definition; create or replace is a no-op where it's already current.

create or replace function public.is_org_admin(org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.organization_members m
    where m.organization_id = org_id
      and m.user_id = auth.uid()
      and m.role::text in ('owner', 'super_owner', 'admin')
  );
$$;

-- 0036's admin-read policy on organization_members, re-asserted so it exists
-- and binds to the helper above (missing/stale on drifted environments).
drop policy if exists "admins read org memberships" on public.organization_members;
create policy "admins read org memberships"
  on public.organization_members for select
  using (public.is_org_admin(organization_id));

-- ── 1) The vertical field ────────────────────────────────────────────────────

alter table public.organization_members
  add column if not exists business_vertical text,
  add column if not exists branch text;
create index if not exists organization_members_vertical_idx
  on public.organization_members (organization_id, business_vertical);

-- Allow 'business_vertical' + 'branch' in the governed master lists.
-- Drop the old field-list check by CATALOG LOOKUP, not by assumed name —
-- 0055 declared it inline, so its auto-generated name may vary per env and
-- a name-based drop could silently leave the old constraint rejecting the
-- new field values. (Postgres rewrites IN to "= ANY", hence the pattern.)
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.org_field_options'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%field = ANY%'
  loop
    execute format('alter table public.org_field_options drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.org_field_options
  add constraint org_field_options_field_check
  check (field in ('designation', 'node_id', 'job_role', 'city', 'state', 'business_vertical', 'branch'));

-- Default vertical seeding. ONE owner of the value list: this function is
-- called by the backfill below AND by the new-org trigger, so existing and
-- future orgs can never drift apart when the defaults change.
create or replace function public.seed_default_field_options(p_org uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.org_field_options (organization_id, field, value)
  select p_org, 'business_vertical', v.val
  from (values ('Retail'), ('Institutional'), ('Fulfillment')) as v(val)
  on conflict (organization_id, field, lower(value)) do nothing;
end;
$$;
revoke all on function public.seed_default_field_options(uuid) from public, anon, authenticated;

-- Backfill every existing org (idempotent; admins can edit values later).
select public.seed_default_field_options(o.id) from public.organizations o;

-- Auto-seed for organizations created after this migration.
create or replace function public.create_default_field_options()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.seed_default_field_options(new.id);
  return new;
end;
$$;
drop trigger if exists organizations_default_verticals on public.organizations;
create trigger organizations_default_verticals
  after insert on public.organizations
  for each row execute function public.create_default_field_options();

-- ── 2) Leader visibility toggle ──────────────────────────────────────────────

alter table public.gamification_settings
  add column if not exists leaderboard_team_leader_view boolean not null default true;

-- ── 3) Per-learner course metrics (matview, 15-min refresh) ──────────────────
-- Entitlements = direct + team + org-wide course assignments PLUS courses
-- reached through assigned learning paths (0031 expansion views). Metrics
-- only — identity/hierarchy stay live in organization_members/profiles.

drop materialized view if exists public.mv_learner_metrics;
create materialized view public.mv_learner_metrics as
with ent as (
  select c.organization_id, e.course_id, e.user_id
  from public.v_course_enrollments_expanded e
  join public.courses c on c.id = e.course_id and c.is_active
  union
  select c.organization_id, lpc.course_id, pe.user_id
  from public.v_path_enrollments_expanded pe
  join public.learning_path_courses lpc on lpc.path_id = pe.path_id
  join public.courses c on c.id = lpc.course_id and c.is_active
),
-- STICKY completion (matches the dashboard + gamification engine): once ANY
-- attempt completed/passed, the course stays completed — a relaunch opening
-- a fresh in-progress attempt must not un-complete it. (The 0031 report
-- views use latest-attempt semantics, which would disagree with the
-- learner-facing dashboard here.)
done as (
  select distinct cv.course_id, ca.user_id
  from public.course_attempts ca
  join public.course_versions cv on cv.id = ca.course_version_id
  where ca.completion_status = 'completed' or ca.success_status = 'passed'
)
select
  om.organization_id,
  om.user_id,
  count(distinct ent.course_id)::int as courses_assigned,
  count(distinct ent.course_id) filter (where d.user_id is not null)::int as courses_completed,
  avg(s.best_score) filter (where s.best_score is not null)::numeric(6, 4) as avg_score,
  now() as refreshed_at
from public.organization_members om
left join ent
  on ent.organization_id = om.organization_id and ent.user_id = om.user_id
left join done d
  on d.user_id = om.user_id and d.course_id = ent.course_id
left join public.v_course_attempt_summary s
  on s.user_id = om.user_id and s.course_id = ent.course_id
group by om.organization_id, om.user_id;

create unique index mv_learner_metrics_idx
  on public.mv_learner_metrics (organization_id, user_id);
revoke all on public.mv_learner_metrics from anon, authenticated;
grant select on public.mv_learner_metrics to service_role;

-- ── 4) Retire the old Teams board matview ────────────────────────────────────
-- The Verticals board replaces the Teams (avg-XP) board; nothing reads
-- mv_team_leaderboard any more, so stop paying its 15-min refresh. Old code
-- deployed between this migration and the code release degrades gracefully
-- (its query errors → the Teams tab renders the empty state, not a 500).

drop materialized view if exists public.mv_team_leaderboard;

-- ── 5) Fold into the 15-min refresh (per-view exception trapping) ────────────

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
  foreach view_name in array array['mv_leaderboard', 'mv_learner_metrics']
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

notify pgrst, 'reload schema';
