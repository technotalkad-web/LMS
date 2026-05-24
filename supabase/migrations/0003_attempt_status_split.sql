-- Phase 3.5: split attempt status into completion + success axes.
--
-- SCORM 1.2 jams "did they finish?" and "did they pass?" into one field
-- (cmi.core.lesson_status). SCORM 2004 / xAPI / cmi5 separate them. We
-- adopt the cleaner model and track both axes.
--
--   completion_status — did the learner navigate through the course?
--     'in_progress' | 'completed'
--
--   success_status — did they meet the mastery threshold?
--     'unknown' | 'passed' | 'failed'
--
-- `status` (the legacy column) is kept for backward compatibility but its
-- value is now derived from the two axes above.

alter table public.course_attempts
  add column if not exists completion_status text not null default 'in_progress'
    check (completion_status in ('in_progress','completed'));

alter table public.course_attempts
  add column if not exists success_status text not null default 'unknown'
    check (success_status in ('unknown','passed','failed'));

-- Backfill from existing rows.
update public.course_attempts
set completion_status = case
  when completed_at is not null then 'completed'
  else 'in_progress'
end
where completion_status is null or completion_status = 'in_progress';

update public.course_attempts
set success_status = case
  when status = 'passed' then 'passed'
  when status = 'failed' then 'failed'
  else 'unknown'
end
where success_status is null or success_status = 'unknown';
