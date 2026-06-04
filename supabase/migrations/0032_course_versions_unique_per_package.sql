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

begin;

-- Drop the legacy constraint. The constraint name is the Postgres default
-- ("<table>_<col1>_<col2>_key") — verified by inspecting pg_constraint on
-- the live DB. If a migration ever renamed it, this DROP will no-op
-- silently because of IF EXISTS.
alter table public.course_versions
  drop constraint if exists course_versions_course_id_version_number_key;

-- Add the new per-package uniqueness. package_id is NOT NULL since 0030,
-- so this constraint behaves cleanly (no NULL-quirky semantics).
alter table public.course_versions
  add constraint course_versions_package_id_version_number_key
  unique (package_id, version_number);

notify pgrst, 'reload schema';

commit;
