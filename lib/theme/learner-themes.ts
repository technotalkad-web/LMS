/**
 * Learner-view themes (learner-selectable, per-device).
 *
 * Each theme is a full design-token palette defined in globals.css under
 * `[data-lms-theme="<id>"]`. The learner layout stamps that attribute on the
 * learner shell from the `lms_theme` cookie, so a theme restyles the entire
 * learner experience while the admin view keeps its standard look.
 *
 * Six themes, each objective-driven:
 *  - classic  → calm, distraction-free focus (the default look)
 *  - midnight → late-night deep work, eye comfort
 *  - sunrise  → warm energy for building momentum
 *  - growth   → consistency mindset, natural greens
 *  - arena    → competition mode, leaderboard adrenaline
 *  - zen      → soft, low-contrast reading calm
 *
 * This module is client-safe (constants only) — imported by both the server
 * layout (cookie validation) and the theme picker in the profile dropdown.
 */

export const LEARNER_THEME_COOKIE = "lms_theme";

export type LearnerThemeId =
  | "classic"
  | "midnight"
  | "sunrise"
  | "growth"
  | "arena"
  | "zen";

export type LearnerTheme = {
  id: LearnerThemeId;
  emoji: string;
  name: string;
  tagline: string;
  /** [canvas, accent] — used to draw the picker swatch. */
  swatch: [string, string];
};

export const LEARNER_THEMES: LearnerTheme[] = [
  {
    id: "classic",
    emoji: "🌿",
    name: "Classic",
    tagline: "Clean and calm — pure focus.",
    swatch: ["#faf8f4", "#3a5a40"],
  },
  {
    id: "midnight",
    emoji: "🌙",
    name: "Midnight",
    tagline: "Easy on the eyes for late-night learning.",
    swatch: ["#14110e", "#7ea884"],
  },
  {
    id: "sunrise",
    emoji: "🌅",
    name: "Sunrise",
    tagline: "Warm energy to start strong.",
    swatch: ["#fff5eb", "#ea580c"],
  },
  {
    id: "growth",
    emoji: "🌲",
    name: "Growth",
    tagline: "Fresh greens for steady progress.",
    swatch: ["#f2f7f1", "#1c7c3f"],
  },
  {
    id: "arena",
    emoji: "🏆",
    name: "Arena",
    tagline: "Game on — built for the leaderboard.",
    swatch: ["#0c1022", "#a78bfa"],
  },
  {
    id: "zen",
    emoji: "🧘",
    name: "Zen",
    tagline: "Soft and quiet — read without strain.",
    swatch: ["#f6f3ec", "#7d7258"],
  },
];

export function isLearnerTheme(value: unknown): value is LearnerThemeId {
  return (
    typeof value === "string" && LEARNER_THEMES.some((t) => t.id === value)
  );
}
