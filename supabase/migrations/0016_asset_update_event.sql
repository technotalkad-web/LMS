-- Phase 9.2: "course / path was updated" notification event.
--
-- ARCHITECTURE NOTE (Course vs Learning Path):
--   * A `course` row corresponds to exactly one uploaded SCORM 1.2 or cmi5
--     package (via course_versions, where each version stores one
--     manifest). Courses are the base unit of learning content and can be
--     assigned to learners directly.
--   * A `learning_path` is a container — an ordered playlist that points
--     to multiple courses via `learning_path_courses`. A path NEVER owns
--     its own SCORM/cmi5 manifest.
--   * Completion of a path is always COMPUTED LIVE from the child courses'
--     completion. It is not stored as a denormalized boolean. This means:
--       - If new courses are added to a previously-completed path, the
--         learner's original course completions persist; only the path's
--         derived completion percentage changes.
--       - Reports, dashboards, and CSV exports must read from
--         course_attempts directly, never from a cached column.

alter table public.notification_templates
  drop constraint if exists notification_templates_event_type_check;
alter table public.notification_templates
  add constraint notification_templates_event_type_check
    check (event_type in (
      'account_creation',
      'asset_assignment',
      'asset_unassignment',
      'asset_completion',
      'asset_reminder',
      'asset_update',
      'custom_broadcast',
      'path_assignment',
      'path_unassignment',
      'path_completion'
    ));

notify pgrst, 'reload schema';
