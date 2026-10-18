-- scripts/migration-rehearsal/shim.sql
-- The smallest Supabase surface the repository's migrations and the v1.3.0
-- audit need on a plain Postgres (PGlite): Supabase's roles, auth.users,
-- auth.uid()/role()/jwt(), storage.buckets/objects and the storage helper
-- functions. Not Supabase: no grants, no default privileges, no extensions,
-- no PostgREST. Synthetic, local, in-memory only.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create role authenticator noinherit;
create role supabase_admin;
create role dashboard_user;
create schema if not exists auth;
create schema if not exists storage;
create schema if not exists extensions;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text, phone text,
  raw_user_meta_data jsonb default '{}'::jsonb,
  raw_app_meta_data jsonb default '{}'::jsonb,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  last_sign_in_at timestamptz, email_confirmed_at timestamptz,
  banned_until timestamptz, deleted_at timestamptz, is_anonymous boolean default false
);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(coalesce(current_setting('request.jwt.claim.sub', true),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'), '')::uuid $$;
create function auth.role() returns text language sql stable as $$
  select coalesce(current_setting('request.jwt.claim.role', true),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role') $$;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create table storage.buckets (
  id text primary key, name text not null, owner uuid, public boolean default false,
  file_size_limit bigint, allowed_mime_types text[], created_at timestamptz default now(),
  updated_at timestamptz default now(), avif_autodetection boolean default false, owner_id text);
create table storage.objects (
  id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id),
  name text, owner uuid, owner_id text, metadata jsonb,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  last_accessed_at timestamptz, version text, user_metadata jsonb);
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable as $$
  select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
create function storage.filename(name text) returns text language sql immutable as $$
  select (string_to_array(name, '/'))[array_length(string_to_array(name, '/'), 1)] $$;
create function storage.extension(name text) returns text language sql immutable as $$
  select reverse(split_part(reverse(name), '.', 1)) $$;
