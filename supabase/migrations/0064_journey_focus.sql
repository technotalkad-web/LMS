-- 0064_journey_focus.sql
-- Personalised Learning Journeys, Phase 2: the FOCUSED DASHBOARD.
--
-- While a learner has an active MANDATORY journey with focus enabled, their
-- dashboard leads with the journey + admin-pinned courses and collapses all
-- other assigned learning into a closed disclosure (product decision
-- 2026-09-03: collapse, never hide — deadlined courses stay reachable so
-- their reminders never point at invisible content). Group-specific by
-- construction: only that journey's enrollees are affected, and the
-- dashboard restores itself the moment the journey completes.
--
--   journey_programs.focus_enabled  bool   default false
--   journey_programs.focus_pinned   jsonb  ["<course_id>", ...] — courses the
--                                   admin keeps visible alongside the journey
--                                   (validated org-owned by the API).
--
-- Drift-safe: idempotent; no behavior change until an admin enables focus.

alter table public.journey_programs
  add column if not exists focus_enabled boolean not null default false,
  add column if not exists focus_pinned jsonb;

notify pgrst, 'reload schema';
