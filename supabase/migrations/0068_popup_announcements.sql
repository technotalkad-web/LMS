-- 0068_popup_announcements.sql
-- Targeted full-screen popup announcements (G2), extending the existing
-- org_announcements (0012) rather than adding a parallel system.
--
-- Product decisions (2026-09-03): popups overlay every learner page EXCEPT
-- inside a course player (learning is never interrupted); duration is hard-
-- capped at 30s with an always-visible ×; video promos are a poster + CTA;
-- audiences come from Custom Groups (0067) or default to everyone.
--
--   kind               'standard' (dashboard banner, unchanged) | 'popup'
--   media_landscape_url  16:9 creative (desktop/landscape screens)
--   media_portrait_url   9:16 creative (mobile/portrait screens)
--   cta_label/cta_href   button + target (course/journey/path URL or external)
--   starts_at            schedule start (expires_at was already the end)
--   duration_seconds     3..30, auto-close timer
--   frequency            'once' | 'daily' | 'always' (per learner)
--   audience_group_id    Custom Group audience; NULL = all members
--   audience_rules       reserved for inline rules (groups cover v1)
--
-- announcement_impressions powers 'once'/'daily' and gives admins
-- view/dismiss/click analytics. Learners write their OWN rows (RLS).

alter table public.org_announcements
  add column if not exists kind text not null default 'standard'
    check (kind in ('standard', 'popup')),
  add column if not exists media_landscape_url text,
  add column if not exists media_portrait_url text,
  add column if not exists cta_label text,
  add column if not exists cta_href text,
  add column if not exists starts_at timestamptz,
  add column if not exists duration_seconds integer not null default 15
    check (duration_seconds between 3 and 30),
  add column if not exists frequency text not null default 'once'
    check (frequency in ('once', 'daily', 'always')),
  add column if not exists audience_group_id uuid
    references public.org_groups(id) on delete set null,
  add column if not exists audience_rules jsonb;

create table if not exists public.announcement_impressions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  announcement_id uuid not null references public.org_announcements(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  shown_at timestamptz not null default now(),
  dismissed_at timestamptz,
  clicked_at timestamptz
);
create index if not exists announcement_impressions_lookup_idx
  on public.announcement_impressions (announcement_id, user_id, shown_at desc);

alter table public.announcement_impressions enable row level security;
drop policy if exists "own impressions" on public.announcement_impressions;
create policy "own impressions" on public.announcement_impressions
  for all using (user_id = auth.uid())
  with check (user_id = auth.uid() and public.is_org_member(organization_id));
drop policy if exists "admins read impressions" on public.announcement_impressions;
create policy "admins read impressions" on public.announcement_impressions
  for select using (public.is_org_admin(organization_id));

notify pgrst, 'reload schema';
