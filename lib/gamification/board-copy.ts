/**
 * Learner-facing engagement copy — single source of the built-in defaults
 * and the per-org override merge (migration 0057). Client-safe (no imports).
 *
 * Orgs override any subset via gamification_settings.board_labels /
 * leaderboard_title / welcome_message; anything unset falls back to these
 * defaults, so a fresh org needs no configuration.
 */

export const BOARD_KEYS = [
  "overall",
  "active",
  "scorer",
  "improved",
  "streak",
  "vertical",
] as const;
export type BoardCopyKey = (typeof BOARD_KEYS)[number];

export type BoardCopy = { name: string; tagline: string };

export const DEFAULT_BOARD_COPY: Record<BoardCopyKey, BoardCopy> = {
  overall: { name: "🏆 Champions", tagline: "Who's ruling the leaderboard?" },
  active: { name: "🔥 On Fire", tagline: "Who's putting in the work every day?" },
  scorer: { name: "🎯 Top Scorers", tagline: "Who's turning learning into points?" },
  improved: { name: "🚀 Rising Stars", tagline: "Who's leveling up the fastest?" },
  streak: { name: "⚡ Streak Masters", tagline: "Who just won't stop?" },
  vertical: { name: "🏢 Team Battle", tagline: "Which vertical is leading the race?" },
};

export const DEFAULT_LEADERBOARD_TITLE = "Leaderboard";
export const DEFAULT_WELCOME_MESSAGE =
  "A learning curve is essential to growth. Pick up where you left off.";

/** Org-nameable score (0066): e.g. "Gyanank" / "Knowledge Score". */
export const DEFAULT_SCORE_LABEL = "XP";
export const DEFAULT_SCORE_DESCRIPTION = "Experience Points";

export const COPY_LIMITS = {
  boardName: 40,
  boardTagline: 120,
  leaderboardTitle: 60,
  welcomeMessage: 200,
  scoreLabel: 24,
  scoreDescription: 80,
} as const;

/** The org's effective score naming, from a gamification_settings row. */
export function effectiveScoreLabel(
  gs: { score_label?: string | null; score_description?: string | null } | null | undefined
): { label: string; description: string } {
  const label =
    typeof gs?.score_label === "string" && gs.score_label.trim()
      ? gs.score_label.trim()
      : DEFAULT_SCORE_LABEL;
  const description =
    typeof gs?.score_description === "string" && gs.score_description.trim()
      ? gs.score_description.trim()
      : DEFAULT_SCORE_DESCRIPTION;
  return { label, description };
}

/** Raw jsonb from gamification_settings.board_labels (untrusted shape). */
export type BoardLabelOverrides = Partial<
  Record<BoardCopyKey, Partial<BoardCopy> | null>
> | null;

/** Defaults merged with an org's overrides; tolerant of malformed jsonb. */
export function effectiveBoardCopy(
  overrides: unknown
): Record<BoardCopyKey, BoardCopy> {
  const out = { ...DEFAULT_BOARD_COPY };
  if (overrides && typeof overrides === "object") {
    for (const key of BOARD_KEYS) {
      const o = (overrides as Record<string, unknown>)[key];
      if (!o || typeof o !== "object") continue;
      const name = (o as { name?: unknown }).name;
      const tagline = (o as { tagline?: unknown }).tagline;
      out[key] = {
        name:
          typeof name === "string" && name.trim()
            ? name.trim()
            : DEFAULT_BOARD_COPY[key].name,
        tagline:
          typeof tagline === "string" && tagline.trim()
            ? tagline.trim()
            : DEFAULT_BOARD_COPY[key].tagline,
      };
    }
  }
  return out;
}
