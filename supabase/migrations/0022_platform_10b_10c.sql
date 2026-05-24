-- Phase 10b + 10c: Broadcasts, quotas, MFA flags, impersonation audit.
--
-- This migration extends the Phase 10a platform schema with everything
-- the operational + security work in 10b/10c needs. We add:
--   * platform_broadcasts        — global announcements shown in every tenant
--   * platform_broadcast_reads   — per-user dismiss state
--   * tenant_usage view          — live user/storage/course counts per tenant
--   * billing flags              — last_billing_check_at on tenant_subscriptions
--   * MFA tracking               — platform_owners.mfa_required
--   * Impersonation audit        — dedicated table so we can show banners
--                                  + revoke a stolen impersonation cookie.
--   * Soft-delete reaper helper  — function that returns orgs past grace
--   * RLS audit helper           — view that lists tables missing tenant
--                                  scoping (used by /api/cron/rls-audit)

-- 1) Global broadcasts -------------------------------------------------
create table if not exists public.platform_broadcasts (
  id              uuid primary key default gen_random_uuid(),
  title           text not null,
  body_md         text not null,
  tone            text not null default 'info'
    check (tone in ('info', 'warning', 'critical', 'success')),
  posted_by       uuid references auth.users(id) on delete set null,
  posted_at       timestamptz not null default now(),
  expires_at      timestamptz,
  dismissable     boolean not null default true,
  audience        text not null default 'all'
    check (audience in ('all', 'admins_only', 'super_owners_only')),
  is_active       boolean not null default true
);

create index if not exists platform_broadcasts_active_idx
  on public.platform_broadcasts(is_active, expires_at);

alter table public.platform_broadcasts enable row level security;

-- Everyone signed in can READ active broadcasts (we filter audience
-- in application code based on the caller's role). Only platform owners
-- can WRITE.
drop policy if exists "anyone reads active broadcasts" on public.platform_broadcasts;
create policy "anyone reads active broadcasts"
  on public.platform_broadcasts for select
  using (
    is_active
    and (expires_at is null or expires_at > now())
  );

drop policy if exists "platform owners write broadcasts" on public.platform_broadcasts;
create policy "platform owners write broadcasts"
  on public.platform_broadcasts for all
  using (public.is_platform_owner())
  with check (public.is_platform_owner());

-- 2) Per-user dismissal tracking --------------------------------------
create table if not exists public.platform_broadcast_reads (
  broadcast_id    uuid not null references public.platform_broadcasts(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  dismissed_at    timestamptz not null default now(),
  primary key (broadcast_id, user_id)
);

alter table public.platform_broadcast_reads enable row level security;

drop policy if exists "users manage own dismissals" on public.platform_broadcast_reads;
create policy "users manage own dismissals"
  on public.platform_broadcast_reads for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- 3) Tenant usage view -------------------------------------------------
-- Computed on demand so quota enforcement is always against fresh
-- numbers. Storage is a coarse estimate from courses.thumbnail_url +
-- learning_paths.thumbnail_url presence (we don't track raw bytes per
-- tenant yet; the value is for display, not contractual billing).
create or replace view public.tenant_usage as
select
  o.id                            as organization_id,
  o.slug                          as organization_slug,
  coalesce(om.user_count, 0)      as user_count,
  coalesce(c.course_count, 0)     as course_count,
  coalesce(p.path_count, 0)       as path_count,
  -- Coarse storage estimate: 5MB per thumbnail row. Replace with real
  -- byte accounting if we ever introduce per-file size tracking.
  coalesce(c.course_count, 0) * 5 + coalesce(p.path_count, 0) * 5 as storage_mb_est
from public.organizations o
left join (
  select organization_id, count(*) as user_count
  from public.organization_members
  group by organization_id
) om on om.organization_id = o.id
left join (
  select organization_id, count(*) as course_count
  from public.courses
  group by organization_id
) c on c.organization_id = o.id
left join (
  select organization_id, count(*) as path_count
  from public.learning_paths
  group by organization_id
) p on p.organization_id = o.id
where o.deleted_at is null;

-- 4) Add billing-check timestamp + MFA + impersonation columns ---------
alter table public.tenant_subscriptions
  add column if not exists last_billing_check_at timestamptz;

alter table public.platform_owners
  add column if not exists mfa_required boolean not null default true,
  add column if not exists last_mfa_check_at timestamptz;

-- 5) Impersonation audit -----------------------------------------------
-- Separate from platform_audit_log because we want to show an active
-- impersonation banner and need to look up sessions quickly. Sessions
-- expire on their own; we also let an admin "end all" by setting
-- revoked_at on every row for an actor.
create table if not exists public.platform_impersonation_sessions (
  id              uuid primary key default gen_random_uuid(),
  actor_user_id   uuid not null references auth.users(id) on delete cascade,
  target_org_id   uuid not null references public.organizations(id) on delete cascade,
  target_user_id  uuid references auth.users(id) on delete set null,
  reason          text,
  started_at      timestamptz not null default now(),
  expires_at      timestamptz not null default (now() + interval '60 minutes'),
  ended_at        timestamptz,
  revoked_at      timestamptz,
  ip              text,
  user_agent      text
);

create index if not exists impersonation_active_idx
  on public.platform_impersonation_sessions(actor_user_id, expires_at)
  where ended_at is null and revoked_at is null;

alter table public.platform_impersonation_sessions enable row level security;
drop policy if exists "platform owners manage impersonation" on public.platform_impersonation_sessions;
create policy "platform owners manage impersonation"
  on public.platform_impersonation_sessions for all
  using (public.is_platform_owner())
  with check (public.is_platform_owner());

-- 6) Soft-delete reaper helper -----------------------------------------
-- Returns the org IDs whose grace period has expired. We don't hard
-- delete inside the migration — the cron endpoint calls this and
-- iterates with proper logging.
create or replace function public.platform_reapable_orgs()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.organizations
  where scheduled_deletion_at is not null
    and scheduled_deletion_at < now()
    and deleted_at is null;
$$;

-- 7) RLS audit view ----------------------------------------------------
-- Lists every base table in public that is NOT covered by row-level
-- security. The cron job that calls this should fail loudly if any
-- tenant-scoped table appears.
create or replace view public.platform_tables_without_rls as
select
  schemaname,
  tablename,
  rowsecurity      as rls_enabled
from pg_tables
where schemaname = 'public'
  and rowsecurity = false
order by tablename;

notify pgrst, 'reload schema';
