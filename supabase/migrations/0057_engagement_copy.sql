-- =============================================================================
-- Org-editable engagement copy (Super Owner / admin flexibility)
-- =============================================================================
--
-- Each organization can now override the learner-facing engagement wording
-- from Gamification → Leaderboard & privacy:
--   - board_labels: jsonb map of per-board overrides, e.g.
--       { "overall": { "name": "🏆 Champions", "tagline": "Who's ruling…" } }
--     Keys: overall | active | scorer | improved | streak | vertical.
--     Missing keys / null column = the built-in defaults
--     (lib/gamification/board-copy.ts is the single source of defaults).
--   - leaderboard_title: the leaderboard page heading (null = "Leaderboard").
--   - welcome_message: the dashboard greeting subtitle (null = default line).
--
-- Writes go through the existing gamification_settings RLS (admins manage,
-- members read), so no new policies are needed.

alter table public.gamification_settings
  add column if not exists board_labels jsonb,
  add column if not exists leaderboard_title text,
  add column if not exists welcome_message text;

notify pgrst, 'reload schema';
