-- 0074: Admin-controlled decorative background themes for the learner
-- dashboard (festivals, campaigns, special sessions).
--
-- An org keeps any number of saved themes. Each carries an uploaded asset
-- (PNG/JPG/WebP image, SVG, GIF or Lottie JSON — all validated by the
-- upload route), display options (fit, opacity), a manual on/off switch and
-- an optional start/end window. The learner dashboard shows the most
-- recently updated theme that is enabled AND inside its window; nothing
-- else in the learner UI is touched — the layer is decorative and never
-- receives pointer events.
--
-- Deploy-safe: the app reads this table fail-soft (no theme) until it
-- exists. Idempotent.

create table if not exists public.dashboard_backgrounds (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  name             text not null check (char_length(name) between 1 and 80),
  asset_url        text not null,
  asset_kind       text not null check (asset_kind in ('image', 'svg', 'gif', 'lottie')),
  fit              text not null default 'cover' check (fit in ('cover', 'contain', 'tile')),
  opacity          numeric(3, 2) not null default 0.35 check (opacity > 0 and opacity <= 1),
  is_enabled       boolean not null default true,
  starts_at        timestamptz,
  ends_at          timestamptz,
  created_by       uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (starts_at is null or ends_at is null or ends_at > starts_at)
);

create index if not exists dashboard_backgrounds_org_idx
  on public.dashboard_backgrounds (organization_id, is_enabled);

alter table public.dashboard_backgrounds enable row level security;

drop policy if exists "members read dashboard backgrounds" on public.dashboard_backgrounds;
create policy "members read dashboard backgrounds"
  on public.dashboard_backgrounds for select
  using (public.is_org_member(organization_id));

drop policy if exists "admins manage dashboard backgrounds" on public.dashboard_backgrounds;
create policy "admins manage dashboard backgrounds"
  on public.dashboard_backgrounds for all
  using (public.is_org_admin(organization_id))
  with check (public.is_org_admin(organization_id));

-- Data API grants (explicit since Supabase stops auto-granting new public
-- tables on 2026-10-30; idempotent where the defaults already applied). RLS
-- above still decides which rows a role can touch.
grant select on public.dashboard_backgrounds to anon;
grant select, insert, update, delete on public.dashboard_backgrounds to authenticated;
grant select, insert, update, delete on public.dashboard_backgrounds to service_role;

notify pgrst, 'reload schema';
