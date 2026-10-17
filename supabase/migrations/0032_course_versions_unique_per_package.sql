-- Hotfix: course_versions uniqueness should be per-package, not per-course.
--
-- Migration 0030 added course_packages and made each course_version belong
-- to a package, but it didn't relax the legacy UNIQUE (course_id,
-- version_number) constraint that was created when each course had at most
-- one package. The result: uploading v1 of a Hindi package, then trying to
-- upload v1 of a Gujarati package on the same course, errors with
--   duplicate key value violates unique constraint
--   "course_versions_course_id_version_number_key"
-- because (course_id, 1) already exists.
--
-- Per the RFC, version_number sequences PER PACKAGE — uploading v3 of the
-- English variant should not make a fresh Hindi upload come out as v4.
-- The app-level fix already sequences correctly (see lib/courses/upload.ts
-- after #158 Phase 1c fix), but the DB constraint still blocks it.
--
-- This migration:
--   1. Drops the legacy (course_id, version_number) unique constraint
--   2. Adds a (package_id, version_number) unique constraint in its place
--
-- History (ADR 0003 step 7): this file was written on the unmerged branch
-- fix/158-versions-unique-per-package (commit 5ce6264, 2026-06-04) and
-- hand-applied to staging from there; the sequence on main skipped 0032.
-- It is committed under its original name so a migration replay matches
-- the live schema. Made idempotent at commit time: re-applying it where the
-- hotfix already ran (staging; production if the P1 audit finds it there)
-- is a no-op. 0098_record_protection.sql repeats both statements under the
-- same guards.

begin;

-- A lock wait must never queue the app's reads of course_versions behind
-- this file: if a lock is not granted within 5 s the whole transaction rolls
-- back cleanly and can simply be applied again.
set local lock_timeout = '5s';

-- Drop the legacy constraint. The constraint name is the Postgres default
-- ("<table>_<col1>_<col2>_key") — verified by inspecting pg_constraint on
-- the live DB. If a migration ever renamed it, this DROP will no-op
-- silently because of IF EXISTS.
alter table public.course_versions
  drop constraint if exists course_versions_course_id_version_number_key;

-- Add the new per-package uniqueness. package_id is NOT NULL since 0030,
-- so this constraint behaves cleanly (no NULL-quirky semantics). Guarded so
-- a second apply does not fail on the existing constraint.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'course_versions_package_id_version_number_key'
      and conrelid = 'public.course_versions'::regclass
  ) then
    alter table public.course_versions
      add constraint course_versions_package_id_version_number_key
      unique (package_id, version_number);
  end if;
end
$$;

notify pgrst, 'reload schema';

commit;
