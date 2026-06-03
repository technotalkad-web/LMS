-- Phase 11 polish: optional dedicated favicon_url.
--
-- Why: the main logo_url field doubles as the browser tab favicon, but
-- non-square logos look stretched at favicon dimensions. Adding a
-- separate favicon_url lets tenants upload a square 32×32 / 64×64 icon
-- without compromising their wide marketing logo.
--
-- Behavior in app/[org]/layout.tsx: if favicon_url is set, use it for
-- the browser tab icon. Otherwise fall back to logo_url (existing
-- behavior). If neither is set, fall back to the static
-- app/favicon.ico (platform default).

alter table public.organizations
  add column if not exists favicon_url text;

notify pgrst, 'reload schema';
