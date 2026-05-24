-- Phase 8d: help/support tickets.
create table if not exists public.help_tickets (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  subject         text not null,
  body            text,
  status          text not null default 'open'
    check (status in ('open', 'in_progress', 'closed')),
  priority        text not null default 'normal'
    check (priority in ('low', 'normal', 'high')),
  admin_note      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  closed_at       timestamptz
);

create index if not exists help_tickets_org_status_idx
  on public.help_tickets(organization_id, status, created_at desc);
create index if not exists help_tickets_user_idx
  on public.help_tickets(user_id, created_at desc);

-- RLS ----------------------------------------------------------------------
alter table public.help_tickets enable row level security;

drop policy if exists "users read own tickets" on public.help_tickets;
create policy "users read own tickets"
  on public.help_tickets for select
  using (
    user_id = auth.uid()
    or public.is_org_admin(organization_id)
  );

drop policy if exists "users insert own tickets" on public.help_tickets;
create policy "users insert own tickets"
  on public.help_tickets for insert
  with check (
    user_id = auth.uid()
    and public.is_org_member(organization_id)
  );

drop policy if exists "admins update tickets" on public.help_tickets;
create policy "admins update tickets"
  on public.help_tickets for update
  using (public.is_org_admin(organization_id))
  with check (public.is_org_admin(organization_id));

drop policy if exists "admins delete tickets" on public.help_tickets;
create policy "admins delete tickets"
  on public.help_tickets for delete
  using (public.is_org_admin(organization_id));

notify pgrst, 'reload schema';
