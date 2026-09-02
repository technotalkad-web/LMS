/**
 * Org-customizable leaderboard podium (0061).
 *
 * gamification_settings.podium_style jsonb holds the org's overrides; null =
 * the built-in look (which mirrors the original hard-coded podium exactly).
 * Two consumers:
 *  - the learner Podium reads via effectivePodiumStyle() — LENIENT: any
 *    invalid field silently falls back to its default so a hand-edited row
 *    can never break the leaderboard;
 *  - the admin save API validates via validatePodiumStyle() — STRICT: bad
 *    input returns an actionable error instead of being silently "fixed".
 *
 * Confetti is generated deterministically from (density, speed, colors) so
 * the server-rendered markup is stable (no hydration mismatch, no client JS).
 */

export const PODIUM_HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export type PodiumFrame = {
  /** Ring color around the avatar. */
  ring: string;
  /** Rank chip background (text color auto-picked for contrast). */
  chip: string;
  /** Chip text, e.g. "1st" (≤ 12 chars). */
  label: string;
  /** Emoji floated above the avatar, "" = none (≤ 8 chars). */
  topper: string;
};

export type PodiumStyle = {
  bg_from: string;
  bg_via: string;
  bg_to: string;
  confetti_enabled: boolean;
  confetti_colors: string[];
  confetti_density: number;
  confetti_speed: number;
  /** Index 0 = 1st place, 1 = 2nd, 2 = 3rd. */
  frames: [PodiumFrame, PodiumFrame, PodiumFrame];
};

export const CONFETTI_LIMITS = {
  minDensity: 6,
  maxDensity: 60,
  minSpeed: 0.25,
  maxSpeed: 3,
  maxColors: 12,
} as const;

export const DEFAULT_PODIUM_STYLE: PodiumStyle = {
  bg_from: "#6366f1",
  bg_via: "#4338ca",
  bg_to: "#1e1b4b",
  confetti_enabled: true,
  confetti_colors: ["#fcd34d", "#f9a8d4", "#ffffff", "#5eead4", "#c7d2fe"],
  confetti_density: 20,
  confetti_speed: 1,
  frames: [
    { ring: "#fcd34d", chip: "#fcd34d", label: "1st", topper: "👑" },
    { ring: "#e2e8f0", chip: "#e2e8f0", label: "2nd", topper: "" },
    { ring: "#fdba74", chip: "#fdba74", label: "3rd", topper: "" },
  ],
};

const hexOr = (v: unknown, fallback: string): string =>
  typeof v === "string" && PODIUM_HEX_RE.test(v.trim()) ? v.trim() : fallback;

function frameOr(raw: unknown, fallback: PodiumFrame): PodiumFrame {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    ring: hexOr(r.ring, fallback.ring),
    chip: hexOr(r.chip, fallback.chip),
    label:
      typeof r.label === "string" && r.label.trim()
        ? r.label.trim().slice(0, 12)
        : fallback.label,
    topper: typeof r.topper === "string" ? r.topper.trim().slice(0, 8) : fallback.topper,
  };
}

/** Lenient reader for the learner podium — never throws, never breaks. */
export function effectivePodiumStyle(raw: unknown): PodiumStyle {
  const d = DEFAULT_PODIUM_STYLE;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return d;
  const r = raw as Record<string, unknown>;
  const colors = Array.isArray(r.confetti_colors)
    ? r.confetti_colors
        .filter((c): c is string => typeof c === "string" && PODIUM_HEX_RE.test(c.trim()))
        .map((c) => c.trim())
        .slice(0, CONFETTI_LIMITS.maxColors)
    : [];
  const num = (v: unknown, min: number, max: number, fallback: number) =>
    typeof v === "number" && Number.isFinite(v)
      ? Math.min(max, Math.max(min, v))
      : fallback;
  const framesRaw = Array.isArray(r.frames) ? r.frames : [];
  return {
    bg_from: hexOr(r.bg_from, d.bg_from),
    bg_via: hexOr(r.bg_via, d.bg_via),
    bg_to: hexOr(r.bg_to, d.bg_to),
    confetti_enabled: r.confetti_enabled !== false,
    confetti_colors: colors.length > 0 ? colors : d.confetti_colors,
    confetti_density: Math.round(
      num(r.confetti_density, CONFETTI_LIMITS.minDensity, CONFETTI_LIMITS.maxDensity, d.confetti_density)
    ),
    confetti_speed: num(r.confetti_speed, CONFETTI_LIMITS.minSpeed, CONFETTI_LIMITS.maxSpeed, d.confetti_speed),
    frames: [
      frameOr(framesRaw[0], d.frames[0]),
      frameOr(framesRaw[1], d.frames[1]),
      frameOr(framesRaw[2], d.frames[2]),
    ],
  };
}

/** Strict validator for the admin save API. */
export function validatePodiumStyle(
  raw: unknown
): { ok: true; value: PodiumStyle } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "podium_style must be an object" };
  }
  const r = raw as Record<string, unknown>;
  for (const k of ["bg_from", "bg_via", "bg_to"] as const) {
    if (typeof r[k] !== "string" || !PODIUM_HEX_RE.test((r[k] as string).trim())) {
      return { ok: false, error: `${k} must be a hex color like #473391` };
    }
  }
  if (typeof r.confetti_enabled !== "boolean") {
    return { ok: false, error: "confetti_enabled must be true or false" };
  }
  if (
    !Array.isArray(r.confetti_colors) ||
    r.confetti_colors.length < 1 ||
    r.confetti_colors.length > CONFETTI_LIMITS.maxColors ||
    r.confetti_colors.some(
      (c) => typeof c !== "string" || !PODIUM_HEX_RE.test(c.trim())
    )
  ) {
    return {
      ok: false,
      error: `confetti_colors must be 1–${CONFETTI_LIMITS.maxColors} hex colors`,
    };
  }
  const dRaw = r.confetti_density;
  if (
    typeof dRaw !== "number" ||
    !Number.isFinite(dRaw) ||
    dRaw < CONFETTI_LIMITS.minDensity ||
    dRaw > CONFETTI_LIMITS.maxDensity
  ) {
    return {
      ok: false,
      error: `confetti_density must be between ${CONFETTI_LIMITS.minDensity} and ${CONFETTI_LIMITS.maxDensity}`,
    };
  }
  const sRaw = r.confetti_speed;
  if (
    typeof sRaw !== "number" ||
    !Number.isFinite(sRaw) ||
    sRaw < CONFETTI_LIMITS.minSpeed ||
    sRaw > CONFETTI_LIMITS.maxSpeed
  ) {
    return {
      ok: false,
      error: `confetti_speed must be between ${CONFETTI_LIMITS.minSpeed} and ${CONFETTI_LIMITS.maxSpeed}`,
    };
  }
  if (!Array.isArray(r.frames) || r.frames.length !== 3) {
    return { ok: false, error: "frames must be an array of exactly 3 entries (1st, 2nd, 3rd)" };
  }
  const places = ["1st", "2nd", "3rd"];
  for (let i = 0; i < 3; i++) {
    const f = r.frames[i] as Record<string, unknown> | null;
    if (!f || typeof f !== "object") {
      return { ok: false, error: `frames[${i}] (${places[i]}) must be an object` };
    }
    for (const k of ["ring", "chip"] as const) {
      if (typeof f[k] !== "string" || !PODIUM_HEX_RE.test((f[k] as string).trim())) {
        return { ok: false, error: `${places[i]} ${k} must be a hex color` };
      }
    }
    if (typeof f.label !== "string" || !f.label.trim() || f.label.trim().length > 12) {
      return { ok: false, error: `${places[i]} label must be 1–12 characters` };
    }
    if (typeof f.topper !== "string" || f.topper.trim().length > 8) {
      return { ok: false, error: `${places[i]} topper must be at most 8 characters (an emoji, or empty)` };
    }
  }
  // Normalize through the lenient reader so stored JSON is always canonical.
  return { ok: true, value: effectivePodiumStyle(raw) };
}

export type ConfettiPiece = {
  left: number;
  size: number;
  delay: number;
  duration: number;
  color: string;
  round: boolean;
};

/**
 * Deterministic confetti field from the style — same input, same output, so
 * SSR markup is stable. Prime-number striding gives an even, organic spread
 * without stored coordinates.
 */
export function confettiPieces(style: PodiumStyle): ConfettiPiece[] {
  const { confetti_colors: colors, confetti_density: n, confetti_speed: speed } = style;
  const pieces: ConfettiPiece[] = [];
  for (let i = 0; i < n; i++) {
    const duration = (8 + ((i * 29) % 45) / 10) / speed;
    pieces.push({
      left: (3 + i * 97) % 100,
      size: 5 + ((i * 37) % 4),
      delay: -(((i * 53) % 110) / 10),
      duration: Math.round(duration * 10) / 10,
      color: colors[i % colors.length],
      round: i % 3 === 1,
    });
  }
  return pieces;
}

/** Black-or-white text for a chip background, by relative luminance. */
export function chipTextColor(hex: string): string {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#1c1917" : "#ffffff";
}
