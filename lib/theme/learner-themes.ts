/**
 * Learner-view themes — ADMIN-controlled, org-wide.
 *
 * The organization picks one theme for its whole learner experience in
 * Settings → Workspace → "Learner theme" (organizations.learner_theme +
 * learner_theme_custom, migration 0060). Learners cannot change it.
 *
 * Every preset tells a home-financing story and is built strictly from the
 * Ambak brand palette:
 *   purples #473391 #6E55B8 #9578E0 #E6C4FF · blues #0059B3 #0078C3
 *   teals   #00ADB7 #2AC3A9
 * (neutral tints/shades of those hues are used for canvas/ink/line so text
 * stays WCAG-readable).
 *
 * Rendering: the learner layout resolves the org's theme to CSS custom
 * properties via resolveLearnerTheme() and inlines them on the learner shell
 * (single source of truth — the admin preview reuses the same tokens). The
 * shell also gets data-lms-theme="<id>" so globals.css can add per-theme
 * ambience (Blueprint's drafting grid, Skyline's glow, Griha Pravesh's wash).
 *
 * This module is client-safe: constants + pure helpers only.
 */

export type ThemeTokens = {
  canvas: string;
  paper: string;
  ink: string;
  muted: string;
  line: string;
  accent: string;
};

export type LearnerThemeId =
  | "foundation"
  | "griha-pravesh"
  | "first-key"
  | "blueprint"
  | "prosperity"
  | "skyline";

export type LearnerTheme = {
  id: LearnerThemeId;
  emoji: string;
  name: string;
  tagline: string;
  /** Dark canvas — the admin gallery renders these cards on their own colors. */
  dark: boolean;
  tokens: ThemeTokens;
};

export const LEARNER_THEMES: LearnerTheme[] = [
  {
    id: "foundation",
    emoji: "🏡",
    name: "Foundation",
    tagline: "Strong foundations build strong futures.",
    dark: false,
    tokens: {
      canvas: "#f8f7fb",
      paper: "#ffffff",
      ink: "#221c3a",
      muted: "#6b6486",
      line: "#e6e2f0",
      accent: "#473391",
    },
  },
  {
    id: "griha-pravesh",
    emoji: "🪔",
    name: "Griha Pravesh",
    tagline: "Every day here is a housewarming.",
    dark: false,
    tokens: {
      canvas: "#faf5ff",
      paper: "#ffffff",
      ink: "#33224e",
      muted: "#7d6a99",
      line: "#ecdcf9",
      accent: "#6E55B8",
    },
  },
  {
    id: "first-key",
    emoji: "🔑",
    name: "First Key",
    tagline: "The moment the keys change hands.",
    dark: false,
    tokens: {
      canvas: "#f2f7fc",
      paper: "#ffffff",
      ink: "#12293e",
      muted: "#55708a",
      line: "#d9e6f2",
      accent: "#0059B3",
    },
  },
  {
    id: "blueprint",
    emoji: "📐",
    name: "Blueprint",
    tagline: "Plan it. Build it. Own it.",
    dark: true,
    tokens: {
      canvas: "#0d1b2e",
      paper: "#14263c",
      ink: "#e8f1fb",
      muted: "#8fa9c4",
      line: "#24405c",
      accent: "#00ADB7",
    },
  },
  {
    id: "prosperity",
    emoji: "🌱",
    name: "Prosperity",
    tagline: "Watch every investment grow.",
    dark: false,
    tokens: {
      canvas: "#f0f9f7",
      paper: "#ffffff",
      ink: "#123230",
      muted: "#4f7a74",
      line: "#d6ece8",
      accent: "#00806e",
    },
  },
  {
    id: "skyline",
    emoji: "🌃",
    name: "Skyline",
    tagline: "Every window in the night sky is a dream home.",
    dark: true,
    tokens: {
      canvas: "#17102b",
      paper: "#201739",
      ink: "#efeafd",
      muted: "#a396c9",
      line: "#322659",
      accent: "#9578E0",
    },
  },
];

export const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function isLearnerThemeId(value: unknown): value is LearnerThemeId {
  return (
    typeof value === "string" && LEARNER_THEMES.some((t) => t.id === value)
  );
}

export type CustomTheme = ThemeTokens & { name?: string };

/**
 * Validates a stored custom-theme jsonb. Returns null unless every token is
 * a well-formed hex color (a half-saved or hand-edited row silently falls
 * back to the default look rather than breaking the learner view).
 */
export function customThemeFrom(raw: unknown): CustomTheme | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const tokens: Partial<ThemeTokens> = {};
  for (const k of ["canvas", "paper", "ink", "muted", "line", "accent"] as const) {
    const v = r[k];
    if (typeof v !== "string" || !HEX_RE.test(v.trim())) return null;
    tokens[k] = v.trim();
  }
  return {
    ...(tokens as ThemeTokens),
    name: typeof r.name === "string" ? r.name.slice(0, 60) : undefined,
  };
}

/** Tokens → inline CSS custom properties for the learner shell / previews. */
export function themeVars(t: ThemeTokens): Record<string, string> {
  return {
    "--canvas": t.canvas,
    "--paper": t.paper,
    "--ink": t.ink,
    "--muted": t.muted,
    "--line": t.line,
    "--accent": t.accent,
  };
}

/**
 * Resolves the org's stored theme choice to what the learner layout renders:
 * a data-lms-theme id (for per-theme ambience CSS) + inline token vars.
 * Null → default look, exactly as before this feature.
 */
export function resolveLearnerTheme(
  theme: unknown,
  custom: unknown
): { id: string; vars: Record<string, string> } | null {
  if (isLearnerThemeId(theme)) {
    const preset = LEARNER_THEMES.find((t) => t.id === theme)!;
    return { id: preset.id, vars: themeVars(preset.tokens) };
  }
  if (theme === "custom") {
    const c = customThemeFrom(custom);
    if (c) return { id: "custom", vars: themeVars(c) };
  }
  return null;
}
