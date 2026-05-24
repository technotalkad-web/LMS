-- Phase 9.5: per-org customisation for the login page hero panel.
alter table public.organizations
  add column if not exists login_hero_image_url text,
  add column if not exists login_hero_title    text,
  add column if not exists login_hero_subtitle text;

notify pgrst, 'reload schema';
