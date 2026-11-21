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

The two public credential events, `password_reset` and `magic_link`, are
tenant events too (`lib/auth/credential-mail.ts`), for accounts that are
not platform-served. `lib/notifications/routing.ts` holds the table of
tenant and platform events; `tests/unit/email-routing.test.ts` holds every
call site to it.

## Where tenant mail goes (ADR 0029)

- **Only through the organisation's own SMTP** (Settings → SMTP), posted to
  the `send-smtp` Edge Function. There is no fallback sender: a mail that
  cannot go is recorded as `failed` (or not attempted) with a message that
  names the organisation's SMTP, and no other sender is tried. Platform mail
  (administrators' codes and links, the console's welcome, SMTP alerts) is
  `lib/email/platform-sender.ts`, which never sends a tenant event.
- **In runs.** Every loop of sends opens one run for each organisation
  (`openRun` / `runMail` in `smtp-state.ts`): the settings and
  `tenant_mail_status` are read once, sends go 4 at a time, each waits at
  most 15 s, and the run carries the request's or the cron call's budget of
  outbound calls and time. What a run could not send is reported in the
  answer, never dropped in silence.
- **The organisation's state** (`tenant_smtp_state`, migration 0114):
  `not_configured`, `configured`, `healthy` or `failing`, written only when a
  send changes it. In a run, a `failing` organisation gets one probe; once the
  state flips to `failing` the rest are not attempted. The administrators get
  an Attention Center item, a banner and one platform alert (marked as due,
  mailed by the hourly `journey-nudges` call).
- **The daily limit** (rule FP4): each organisation's `sent` rows of the last
  24 hours against its limit (375 unless a platform owner sets another on
  `/super/email`). One tenth (at least 25) is held back for mail someone is
  expecting, such as reset codes; routine mail halts short of that reserve,
  and at the limit itself nothing more is attempted. A limit of 25 or less
  is all reserve, so routine mail never goes at it; the pages call that
  "routine mail off at this limit" (the notice `routine_off`).
- **Without migration 0114** (production until its sitting): no state is
  stored, every organisation with complete settings is treated as ready, and
  no daily limit applies; the send is attempted as before.
- Operations: `ops/RUNBOOK.md` §6.3 and §6.3b.

## Pause flow

Two flags on `notification_settings`:

- `email_paused boolean` — master kill switch. Stops every event,
  `custom_broadcast` included (broadcasts, ticket mail and attempt-request
  mail; the owner's decision of 2026-11-21). Exempt: `password_reset` and
  `magic_link`, which the person asked for (ADR 0029 section C); the
  exemption adds no sender, so those still use the tenant's SMTP and nothing
  else.
- `event_paused jsonb` — `{"asset_reminder": true, …}`. Pauses individual
  event types while letting others through; the same two are exempt.

Both are checked before each send (`gateSend` in `smtp-state.ts`) and give a
`paused` outcome that's logged for audit. A paused welcome is not sent, and
the administrator is told. A broadcast asks once, before its loop: under
either pause it answers 409 "Email is paused for this organisation. Nothing
was sent." and logs no row for any recipient. On Settings, the event pause
"Custom broadcast, ticket and attempt-request email" stops all three.
