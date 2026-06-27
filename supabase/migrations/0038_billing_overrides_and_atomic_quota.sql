-- 0038: billing correctness + super-owner overrides (audit B1/B3/B5 + feature #5).
--
-- 1) Super-owner override columns on tenant_subscriptions (feature #5).
-- 2) Real per-file storage accounting (B5): course_versions.size_bytes + a
--    tenant_usage view that sums actual bytes instead of a flat 5MB estimate.
-- 3) Centralized cap resolution in SQL (effective_cap / current_quota_usage):
--    override → plan → BASIC default (B3), honoring a manual grace period.
-- 4) ATOMIC quota enforcement (B1): BEFORE INSERT triggers that lock the org row
--    FOR UPDATE and re-count inside the insert's own transaction, eliminating
--    the check-then-create TOCTOU race (concurrent multi-tab creates are queued
--    and validated in sequence). The app-level checkQuota stays as a friendly
--    pre-flight; this is the hard guarantee.

-- ── 1) Override columns ────────────────────────────────────────────────────
alter table public.tenant_subscriptions
  add column if not exists custom_user_limit_override    integer,
  add column if not exists custom_storage_limit_override integer,     -- in MB
  add column if not exists manual_grace_period_until      timestamptz,
  add column if not exists owner_notes                    text;

-- ── 2) Real storage footprint ──────────────────────────────────────────────
alter table public.course_versions
  add column if not exists size_bytes bigint not null default 0;

create or replace view public.tenant_usage as
select
  o.id                            as organization_id,
  o.slug                          as organization_slug,
  coalesce(om.user_count, 0)      as user_count,
  coalesce(c.course_count, 0)     as course_count,
  coalesce(p.path_count, 0)       as path_count,
  -- Real storage: sum of uploaded package bytes for the org, in MB.
  floor(coalesce(s.bytes, 0) / 1048576.0)::bigint as storage_mb_est
from public.organizations o
left join (
  select organization_id, count(*) as user_count
  from public.organization_members group by organization_id
) om on om.organization_id = o.id
left join (
  select organization_id, count(*) as course_count
  from public.courses group by organization_id
) c on c.organization_id = o.id
left join (
  select organization_id, count(*) as path_count
  from public.learning_paths group by organization_id
) p on p.organization_id = o.id
left join (
  select c2.organization_id, sum(cv.size_bytes) as bytes
  from public.course_versions cv
  join public.courses c2 on c2.id = cv.course_id
  group by c2.organization_id
) s on s.organization_id = o.id;

-- ── 3) Cap resolution: override → plan → basic default (B3) ─────────────────
-- Returns the cap for `kind` ∈ {users,courses,storage_mb}; NULL = unlimited.
create or replace function public.effective_cap(org_id uuid, kind text)
returns integer
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  sub   public.tenant_subscriptions%rowtype;
  plan  public.subscription_plans%rowtype;
  found_sub boolean := false;
begin
  select * into sub from public.tenant_subscriptions where organization_id = org_id;
  found_sub := found;

  if found_sub then
    -- Manual grace period → no caps while active.
    if sub.manual_grace_period_until is not null
       and sub.manual_grace_period_until > now() then
      return null;
    end if;
    -- Explicit per-tenant overrides win over the plan.
    if kind = 'users'      and sub.custom_user_limit_override    is not null then
      return sub.custom_user_limit_override;
    end if;
    if kind = 'storage_mb' and sub.custom_storage_limit_override is not null then
      return sub.custom_storage_limit_override;
    end if;
  end if;

  -- Resolve the plan; fall back to BASIC when there is no sub/plan (B3).
  if found_sub and sub.plan_id is not null then
    select * into plan from public.subscription_plans where id = sub.plan_id;
  end if;
  if plan.id is null then
    select * into plan from public.subscription_plans where slug = 'basic' limit 1;
  end if;
  if plan.id is null then
    return null; -- no plans defined at all → unlimited (shouldn't happen)
  end if;

  if kind = 'users'   then return plan.max_users; end if;
  if kind = 'courses' then return plan.max_courses; end if;
  if kind = 'storage_mb' then
    return case when plan.max_storage_gb is null then null
                else plan.max_storage_gb * 1024 end;
  end if;
  return null;
end;
$$;

create or replace function public.current_quota_usage(org_id uuid, kind text)
returns bigint
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if kind = 'users' then
    return (select count(*) from public.organization_members where organization_id = org_id);
  elsif kind = 'courses' then
    return (select count(*) from public.courses where organization_id = org_id);
  elsif kind = 'storage_mb' then
    return floor(coalesce((
      select sum(cv.size_bytes)
      from public.course_versions cv
      join public.courses c on c.id = cv.course_id
      where c.organization_id = org_id
    ), 0) / 1048576.0);
  end if;
  return 0;
end;
$$;

-- ── 4) Atomic enforcement triggers (B1) ────────────────────────────────────
-- Generic guard: lock the org row FOR UPDATE so concurrent inserts for the same
-- org serialize, then re-count under the lock. Raising aborts the insert in the
-- same transaction — no TOCTOU window.
create or replace function public.enforce_row_quota()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  kind text := tg_argv[0];
  cap  integer;
  cur  bigint;
begin
  -- Serialize per-org (org row always exists, even with no subscription).
  perform 1 from public.organizations where id = new.organization_id for update;
  cap := public.effective_cap(new.organization_id, kind);
  if cap is null then
    return new; -- unlimited
  end if;
  cur := public.current_quota_usage(new.organization_id, kind);
  if cur + 1 > cap then
    raise exception 'quota_exceeded: % at %/%', kind, cur, cap
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_user_quota on public.organization_members;
create trigger enforce_user_quota
  before insert on public.organization_members
  for each row execute function public.enforce_row_quota('users');

drop trigger if exists enforce_course_quota on public.courses;
create trigger enforce_course_quota
  before insert on public.courses
  for each row execute function public.enforce_row_quota('courses');

notify pgrst, 'reload schema';
