-- 0060_learner_themes.sql
-- Admin-controlled learner-view themes.
--
-- The organization picks ONE theme for its whole learner experience
-- (Settings → Workspace → Learner theme): a home-financing preset from the
-- brand palette, or a fully custom palette. Learners cannot change it.
--
--   learner_theme         text   preset id ('foundation', 'griha-pravesh',
--                                'first-key', 'blueprint', 'prosperity',
--                                'skyline'), 'custom', or NULL = default look.
--   learner_theme_custom  jsonb  custom palette {name, canvas, paper, ink,
--                                muted, line, accent} — hex values validated
--                                by the API (/api/org/branding).
--
-- Values are validated in the API layer (preset list may grow without DDL);
-- writes go through the existing admin-gated organizations UPDATE RLS.
-- Drift-safe: idempotent, no dependencies on other migrations.

alter table public.organizations
  add column if not exists learner_theme text,
  add column if not exists learner_theme_custom jsonb;
