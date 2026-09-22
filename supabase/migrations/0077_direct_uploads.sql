-- 0077: direct browser-to-storage uploads + per-version storage driver.
--
-- Course content moves to Cloudflare R2 and is uploaded straight from the
-- admin's browser with short-lived signed URLs. A version row now exists
-- BEFORE its files do, so it carries an upload_status; only 'ready' versions
-- are ever pointed at by course_packages.current_version_id / courses.
-- current_version_id (finalise flips the pointer), and only 'ready' versions
-- can be activated for rollback.
--
-- storage_driver records where a version's files live, so the migration from
-- Supabase Storage to R2 can proceed version by version with no downtime:
-- the content route reads each version's own driver.
--
-- Hand-apply in the Supabase SQL editor (staging, then prod). Idempotent.

alter table public.course_versions
  add column if not exists upload_status text not null default 'ready',
  add column if not exists storage_driver text not null default 'supabase',
  add column if not exists file_count integer,
  add column if not exists upload_started_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'course_versions_upload_status_check'
  ) then
    alter table public.course_versions
      add constraint course_versions_upload_status_check
      check (upload_status in ('uploading', 'ready', 'failed'));
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'course_versions_storage_driver_check'
  ) then
    alter table public.course_versions
      add constraint course_versions_storage_driver_check
      check (storage_driver in ('supabase', 'r2'));
  end if;
end $$;

-- The reaper sweeps abandoned uploads; keep that scan cheap.
create index if not exists course_versions_pending_upload_idx
  on public.course_versions (upload_started_at)
  where upload_status <> 'ready';

comment on column public.course_versions.upload_status is
  'uploading = files still arriving from the browser (never current); ready = finalised; failed = abandoned or failed finalise (swept by the reaper)';
comment on column public.course_versions.storage_driver is
  'Where this version''s files live: supabase (legacy bucket) or r2';

notify pgrst, 'reload schema';
