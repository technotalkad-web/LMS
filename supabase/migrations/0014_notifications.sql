-- Phase 9: notification engine schema.
--
-- Five tables:
--   notification_settings    - per-org SMTP credentials + global toggles
--   notification_templates   - per-org per-event subject + body markdown
--   notification_log         - audit trail of every send attempt
--   course_reminder_settings - per-course reminder cadence + cap
--   reminder_state           - per-(user, course) last-nudge tracking

-- 1) Per-org SMTP + channel config ----------------------------------------
create table if not exists public.notification_settings (
  organization_id   uuid primary key references public.organizations(id) on delete cascade,
  smtp_host         text,
  smtp_port         integer,
  smtp_user         text,
  smtp_password     text, -- encrypted-at-rest is recommended; for v1 we rely on RLS + service-role-only reads
  smtp_secure       boolean not null default true,
  from_email        text,
  from_name         text,
  whatsapp_enabled  boolean not null default false,
  whatsapp_token    text,
  reply_to          text,
  updated_at        timestamptz not null default now(),
  updated_by        uuid references auth.users(id)
);

-- 2) Templates per event type ---------------------------------------------
-- event types:
--   account_creation, asset_assignment, asset_unassignment,
--   asset_completion, asset_reminder, custom_broadcast
create table if not exists public.notification_templates (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  event_type      text not null
    check (event_type in (
      'account_creation', 'asset_assignment', 'asset_unassignment',
      'asset_completion', 'asset_reminder', 'custom_broadcast'
    )),
  subject         text not null,
  body_md         text not null,
  is_active       boolean not null default true,
  updated_at      timestamptz not null default now(),
  updated_by      uuid references auth.users(id),
  unique (organization_id, event_type)
);

-- 3) Send log -------------------------------------------------------------
create table if not exists public.notification_log (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  event_type      text not null,
  channel         text not null default 'email' check (channel in ('email','whatsapp')),
  to_user_id      uuid references auth.users(id) on delete set null,
  to_address      text not null,
  subject         text,
  status          text not null check (status in ('sent','failed','queued')),
  error           text,
  context         jsonb,
  sent_at         timestamptz not null default now()
);

create index if not exists notification_log_org_event_idx
  on public.notification_log(organization_id, event_type, sent_at desc);
create index if not exists notification_log_user_idx
  on public.notification_log(to_user_id, sent_at desc);

-- 4) Per-course reminder config -------------------------------------------
-- cadence_days: 1 = daily, 2 = bi-daily, 3 = tri-daily.
create table if not exists public.course_reminder_settings (
  course_id     uuid primary key references public.courses(id) on delete cascade,
  enabled       boolean not null default false,
  cadence_days  integer not null default 1
    check (cadence_days in (1, 2, 3)),
  cap_days      integer not null default 30
    check (cap_days > 0 and cap_days <= 365),
  updated_at    timestamptz not null default now(),
  updated_by    uuid references auth.users(id)
);

-- 5) Per-(user, course) reminder state ------------------------------------
-- Tracks last nudge so the cron job knows when to send again.
create table if not exists public.reminder_state (
  user_id          uuid not null references auth.users(id) on delete cascade,
  course_id        uuid not null references public.courses(id) on delete cascade,
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  first_assigned_at timestamptz not null default now(),
  last_nudge_at    timestamptz,
  nudge_count      integer not null default 0,
  stopped          boolean not null default false,
  primary key (user_id, course_id)
);
create index if not exists reminder_state_org_idx
  on public.reminder_state(organization_id, last_nudge_at);

-- RLS ----------------------------------------------------------------------
alter table public.notification_settings    enable row level security;
alter table public.notification_templates   enable row level security;
alter table public.notification_log         enable row level security;
alter table public.course_reminder_settings enable row level security;
alter table public.reminder_state           enable row level security;

-- Settings + templates: admin-only.
drop policy if exists "admins manage notif settings" on public.notification_settings;
create policy "admins manage notif settings"
  on public.notification_settings for all
  using (public.is_org_admin(organization_id))
  with check (public.is_org_admin(organization_id));

drop policy if exists "admins manage notif templates" on public.notification_templates;
create policy "admins manage notif templates"
  on public.notification_templates for all
  using (public.is_org_admin(organization_id))
  with check (public.is_org_admin(organization_id));

-- Log: admin read; service role writes.
drop policy if exists "admins read notif log" on public.notification_log;
create policy "admins read notif log"
  on public.notification_log for select
  using (public.is_org_admin(organization_id));

-- Reminder settings: admin manage; members read (so the course detail can show schedule).
drop policy if exists "members read reminder settings" on public.course_reminder_settings;
create policy "members read reminder settings"
  on public.course_reminder_settings for select
  using (
    exists (
      select 1 from public.courses c
      where c.id = course_reminder_settings.course_id
        and public.is_org_member(c.organization_id)
    )
  );
drop policy if exists "admins manage reminder settings" on public.course_reminder_settings;
create policy "admins manage reminder settings"
  on public.course_reminder_settings for all
  using (
    exists (
      select 1 from public.courses c
      where c.id = course_reminder_settings.course_id
        and public.is_org_admin(c.organization_id)
    )
  )
  with check (
    exists (
      select 1 from public.courses c
      where c.id = course_reminder_settings.course_id
        and public.is_org_admin(c.organization_id)
    )
  );

-- Reminder state: service-role writes; admins read their org.
drop policy if exists "admins read reminder state" on public.reminder_state;
create policy "admins read reminder state"
  on public.reminder_state for select
  using (public.is_org_admin(organization_id));

notify pgrst, 'reload schema';
