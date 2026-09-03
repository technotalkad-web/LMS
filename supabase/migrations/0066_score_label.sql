-- 0066_score_label.sql
-- Phase 5 (Personalised Journeys program): the org names its own score.
--
-- "Gyanank — Knowledge Score" instead of XP, editable from Admin →
-- Gamification → Names & messages like the rest of the engagement copy
-- (0057). NULL = the built-in "XP" / "Experience Points". The label swaps
-- across every learner surface (motivation strip, leaderboard boards +
-- podium metric, admin KPIs); scoring RULES were already admin-editable.
--
-- Drift-safe: idempotent, additive only.

alter table public.gamification_settings
  add column if not exists score_label text,
  add column if not exists score_description text;

notify pgrst, 'reload schema';
