-- 0075: Progress % on attempts, tracked separately from completion.
--
-- completion_status answers "did the learner finish?" and is set only by
-- the module's own course-level completion signal (AU-level cmi5 statement,
-- SCORM lesson_status). progress_pct answers "how far through are they?"
-- and comes from real in-module signals: per-screen statements, the
-- module's saved resume state, the cmi5 `progress` result extension, or
-- SCORM 2004 progress_measure. It never exceeds 99 until the attempt is
-- actually complete, and 100 means complete. NULL = the package gives no
-- usable progress signal (plain SCORM 1.2), in which case the UI shows the
-- status without a percentage.
--
-- The module's learning-unit count (denominator) lives in
-- course_versions.manifest_data.unitCount (jsonb; no column needed).
-- Deploy-safe: writers retry without the column until this is applied.

alter table public.course_attempts
  add column if not exists progress_pct smallint
    check (progress_pct between 0 and 100);

notify pgrst, 'reload schema';
