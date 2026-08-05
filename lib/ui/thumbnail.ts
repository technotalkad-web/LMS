import type { CSSProperties } from "react";

export type ThumbFit = "cover" | "contain";

/** The three per-course display columns, as they come back from Supabase. */
export type ThumbDisplay = {
  thumbnail_fit?: string | null;
  thumbnail_pos_x?: number | null;
  thumbnail_pos_y?: number | null;
};

function clampPct(n: number | null | undefined): number {
  if (typeof n !== "number" || Number.isNaN(n)) return 50;
  return Math.min(100, Math.max(0, Math.round(n)));
}

/**
 * Inline styles for a card thumbnail <img>, honoring the admin's display
 * choice. Defaults (no row values) reproduce the old behavior: centre-cropped
 * cover. Callers keep their own sizing classes (w-full h-full / aspect-video).
 */
export function thumbImgStyle(d: ThumbDisplay | null | undefined): CSSProperties {
  return {
    objectFit: d?.thumbnail_fit === "contain" ? "contain" : "cover",
    objectPosition: `${clampPct(d?.thumbnail_pos_x)}% ${clampPct(d?.thumbnail_pos_y)}%`,
  };
}
