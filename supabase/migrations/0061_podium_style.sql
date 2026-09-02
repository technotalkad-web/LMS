-- 0061_podium_style.sql
-- Org-customizable leaderboard podium (Admin → Gamification → Leaderboard
-- & privacy → Podium style).
--
--   gamification_settings.podium_style jsonb — NULL = the built-in look.
--   {
--     "bg_from": "#6366f1", "bg_via": "#4338ca", "bg_to": "#1e1b4b",
--     "confetti_enabled": true,
--     "confetti_colors": ["#fcd34d", "..."],       -- 1..12 hex colors
--     "confetti_density": 20,                      -- 6..60 pieces
--     "confetti_speed": 1,                         -- 0.25..3 (fall speed)
--     "frames": [                                  -- index 0 = 1st place
--       { "ring": "#fcd34d", "chip": "#fcd34d", "label": "1st", "topper": "👑" },
--       { "ring": "#e2e8f0", "chip": "#e2e8f0", "label": "2nd", "topper": "" },
--       { "ring": "#fdba74", "chip": "#fdba74", "label": "3rd", "topper": "" }
--     ]
--   }
--
-- Validated strictly by /api/gamification/settings (section "podium");
-- learner reads are lenient (invalid fields fall back to defaults in
-- lib/gamification/podium-style.ts). Writes ride the existing admin RLS
-- policy on gamification_settings. Drift-safe: idempotent.

alter table public.gamification_settings
  add column if not exists podium_style jsonb;
