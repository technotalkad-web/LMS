-- 0065_journey_escalation.sql
-- Personalised Learning Journeys, Phase 3: DEADLINE + MANAGER ESCALATION.
--
-- Product decisions (2026-09-03): early reminders go to the learner only
-- (the 0059 nudges); once a learner has been behind for the configured
-- number of days — or has blown the journey deadline — the daily run ALSO
-- emails their L1 manager (organization_members.line_manager_id, the same
-- mapping that powers the Verticals board). Reminders stop automatically on
-- completion (only active enrollments are ever scanned). All knobs are
-- admin-editable; both emails are ordinary org-customizable templates.
--
--   journey_programs.deadline_days          int  null — complete within N
--                     counted days of start (same working-day math as the
--                     drip); null = no deadline.
--   journey_programs.escalation_enabled     bool default false
--   journey_programs.escalation_after_days  int  default 3 (1..30) — CC the
--                     L1 manager once behind_days ≥ this (deadline overrun
--                     always escalates).
--
--   'journey_escalation' joins the notification event catalog (house
--   pattern: re-assert the full event_type list + the new one).
--
-- Drift-safe: idempotent; nothing changes until an admin enables escalation
-- or sets a deadline.

alter table public.journey_programs
  add column if not exists deadline_days integer
    check (deadline_days between 1 and 730),
  add column if not exists escalation_enabled boolean not null default false,
  add column if not exists escalation_after_days integer not null default 3
    check (escalation_after_days between 1 and 30);

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
      'path_completion',
      'password_reset',
      'magic_link',
      'account_invite',
      'journey_nudge',
      'journey_escalation'
    ));

notify pgrst, 'reload schema';
