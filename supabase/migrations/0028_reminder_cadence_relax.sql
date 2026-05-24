-- =============================================================================
-- 0028 — Allow custom reminder cadence (1-30 days, not just 1/2/3)
-- =============================================================================
--
-- WHY THIS EXISTS:
--   Migration 0014 capped `course_reminder_settings.cadence_days` to (1, 2, 3)
--   via a hardcoded CHECK constraint. Admins doing UAT pushed back: they want
--   to nudge learners weekly, bi-weekly, or monthly (not just daily). Relaxing
--   the constraint to 1-30 days covers every reasonable cadence with no
--   meaningful tradeoff. The reminders cron job (/api/cron/reminders) already
--   reads cadence_days as an integer and compares with last_sent_at, so no
--   code change is needed in the cron worker — only the API validation and
--   the admin UI.
-- =============================================================================

alter table public.course_reminder_settings
  drop constraint if exists course_reminder_settings_cadence_days_check;

alter table public.course_reminder_settings
  add constraint course_reminder_settings_cadence_days_check
  check (cadence_days >= 1 and cadence_days <= 30);

notify pgrst, 'reload schema';
