# Notification engine — architecture notes

## System hierarchy: Course vs Learning Path

**Course** = exactly one uploaded SCORM 1.2 or cmi5 package. Tracked via
`courses` + `course_versions` (one row per uploaded zip; the current
version is whichever `courses.current_version_id` points at). Courses are
the base unit of learning content. They can be assigned directly to a
learner, a team, or org-wide via `course_assignments`.

**Learning Path** = a *container* — an ordered playlist that points to
multiple courses via `learning_path_courses`. A path **never** owns its own
SCORM/cmi5 manifest. Assignment to a path is via
`learning_path_assignments`.

The relationship is strictly one-to-many: **one path → many courses.**

## Completion is computed, never cached

Every "is this learner done?" question for a path is derived live by
querying `course_attempts` against the courses in
`learning_path_courses`. We do **not** denormalize a `path_status` column
anywhere.

Consequences (all desirable):

1. **Smart updates** are free. If a path that a learner has completed
   later gains a new course, their original 5 (say) course completions
   in `course_attempts` are untouched; the live computation simply shows
   5/6 complete. They only need to take the new course.

2. **Reporting is always live.** The Reports page, learner dashboard,
   CSV exports, and learner transcripts all query the same source. There
   is no cache to invalidate.

3. **No drift between views.** Admin "X learners completed this path"
   and the learner's own "you're done" status will always agree.

## Event types

Triggers map to a single notification event each. Default templates are
in `templates.ts`; admins can override per-event in Settings.

| Event              | Source                                                | Fired to                |
|--------------------|-------------------------------------------------------|-------------------------|
| `account_creation` | `/api/users` (POST), `/api/users/bulk`                | The new learner         |
| `asset_assignment` | `/api/assignments` (POST)                             | Affected learners       |
| `asset_unassignment`| `/api/assignments/[id]` (DELETE)                     | Affected learners       |
| `asset_completion` | `/api/scorm/[id]/commit` on first-time terminal state | The completing learner  |
| `asset_reminder`   | `/api/cron/reminders` (POST)                          | Assigned, not-yet-done  |
| `asset_update`     | `/api/courses/upload` (with `notify_update`) and `/api/learning-paths/[id]/courses` (with `notify_update`) | Assigned learners       |
| `path_assignment`  | `/api/learning-path-assignments` (POST)               | Affected learners       |
| `path_unassignment`| `/api/learning-path-assignments/[id]` (DELETE)        | Affected learners       |
| `path_completion`  | `/api/scorm/[id]/commit` (derived path-done check)    | The completing learner  |
| `custom_broadcast` | `/api/notifications/broadcast` (admin-initiated)      | Selected audience       |

## Pause flow

Two flags on `notification_settings`:

- `email_paused boolean` — master kill switch. Stops ALL automatic
  events. `custom_broadcast` is exempt (explicit admin action).
- `event_paused jsonb` — `{"asset_reminder": true, …}`. Pauses individual
  event types while letting others through.

Both are checked at the top of `sendNotification()` and short-circuit
with a `paused` outcome that's logged for audit.
