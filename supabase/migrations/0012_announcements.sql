-- Phase 8d: org-wide announcements (banner messages from admins to learners).
create table if not exists public.org_announcements (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  title           text not null,
  body            text,
  tone            text not null default 'info'
    check (tone in ('info', 'success', 'warning', 'critical')),
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz,
  is_active       boolean not null default true
);

create index if not exists org_announcements_org_active_idx
  on public.org_announcements(organization_id, is_active, created_at desc);

-- RLS ----------------------------------------------------------------------
alter table public.org_announcements enable row level security;

drop policy if exists "members read active announcements" on public.org_announcements;
create policy "members read active announcements"
  on public.org_announcements for select
  using (
    public.is_org_member(organization_id)
    and is_active
    and (expires_at is null or expires_at > now())
  );

drop policy if exists "admins manage announcements" on public.org_announcements;
create policy "admins manage announcements"
  on public.org_announcements for all
  using (public.is_org_admin(organization_id))
  with check (public.is_org_admin(organization_id));

notify pgrst, 'reload schema';
