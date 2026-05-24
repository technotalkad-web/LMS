-- Phase 9.4: thumbnails for courses + paths, plus per-org branding.

-- 1) Thumbnails ----------------------------------------------------------
alter table public.courses
  add column if not exists thumbnail_url text;

alter table public.learning_paths
  add column if not exists thumbnail_url text;

-- 2) Branding on the organization ---------------------------------------
alter table public.organizations
  add column if not exists logo_url      text,
  add column if not exists brand_color   text default '#4f46e5',
  add column if not exists brand_font    text default 'sans',
  add column if not exists custom_domain text;

-- Optional uniqueness so two orgs can't claim the same domain.
create unique index if not exists organizations_custom_domain_unique
  on public.organizations(lower(custom_domain))
  where custom_domain is not null;

-- 3) Storage bucket for branding assets (idempotent) --------------------
-- The bucket itself must be created via Supabase UI or CLI; we create a
-- public read policy here so img tags can load directly.
do $$
begin
  if not exists (
    select 1 from storage.buckets where id = 'public-assets'
  ) then
    insert into storage.buckets (id, name, public)
    values ('public-assets', 'public-assets', true);
  end if;
end$$;

-- Anyone can read public-assets; only admins write (via service role from
-- our /api/upload/image endpoint).
drop policy if exists "public read public-assets" on storage.objects;
create policy "public read public-assets"
  on storage.objects for select
  using (bucket_id = 'public-assets');

notify pgrst, 'reload schema';
