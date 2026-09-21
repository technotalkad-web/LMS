/**
 * Dashboard background themes (0074) — client-safe helpers shared by the
 * learner dashboard, the admin Settings section and the API.
 */

export type BackgroundKind = "image" | "svg" | "gif" | "lottie";
export type BackgroundFit = "cover" | "contain" | "tile";

export type DashboardBackground = {
  id: string;
  organization_id: string;
  name: string;
  asset_url: string;
  asset_kind: BackgroundKind;
  fit: BackgroundFit;
  opacity: number;
  is_enabled: boolean;
  starts_at: string | null;
  ends_at: string | null;
  created_at: string;
  updated_at: string;
};

export type BackgroundStatus = "live" | "scheduled" | "expired" | "disabled";

export const BACKGROUND_FITS: Array<{ value: BackgroundFit; label: string; hint: string }> = [
  { value: "cover", label: "Fill the screen", hint: "Scales to cover the whole dashboard; edges may crop." },
  { value: "contain", label: "Fit inside", hint: "Whole artwork visible, centred, may leave empty margins." },
  { value: "tile", label: "Repeat as a pattern", hint: "Tiles the image — best for small seamless patterns." },
];

export const BACKGROUND_DEFAULT_OPACITY = 0.35;

/** Asset kind from the stored URL (the upload route fixes the extension). */
export function backgroundKindFromUrl(url: string): BackgroundKind {
  const clean = url.split("?")[0].split("#")[0].toLowerCase();
  if (clean.endsWith(".json") || clean.endsWith(".lottie")) return "lottie";
  if (clean.endsWith(".svg")) return "svg";
  if (clean.endsWith(".gif")) return "gif";
  return "image";
}

function ts(iso: string | null): number | null {
  if (!iso) return null;
  const n = Date.parse(iso);
  return Number.isFinite(n) ? n : null;
}

export function backgroundStatus(
  b: Pick<DashboardBackground, "is_enabled" | "starts_at" | "ends_at">,
  nowMs: number
): BackgroundStatus {
  if (!b.is_enabled) return "disabled";
  const start = ts(b.starts_at);
  const end = ts(b.ends_at);
  if (end !== null && end <= nowMs) return "expired";
  if (start !== null && start > nowMs) return "scheduled";
  return "live";
}

/**
 * The theme learners see right now: enabled, inside its window, and — when
 * several qualify — the most recently updated one, so an admin's latest
 * change always wins without a separate priority field.
 */
export function pickActiveBackground<T extends DashboardBackground>(
  rows: T[],
  nowMs: number
): T | null {
  const live = rows.filter((r) => backgroundStatus(r, nowMs) === "live");
  if (live.length === 0) return null;
  return [...live].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))[0];
}

export function normalizeBackground(raw: unknown): DashboardBackground | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.asset_url !== "string") return null;
  const opacity = Number(r.opacity);
  const fit = r.fit as BackgroundFit;
  return {
    id: r.id,
    organization_id: String(r.organization_id ?? ""),
    name: typeof r.name === "string" ? r.name : "Theme",
    asset_url: r.asset_url,
    asset_kind: ["image", "svg", "gif", "lottie"].includes(r.asset_kind as string)
      ? (r.asset_kind as BackgroundKind)
      : backgroundKindFromUrl(r.asset_url),
    fit: ["cover", "contain", "tile"].includes(fit) ? fit : "cover",
    opacity: Number.isFinite(opacity) && opacity > 0 && opacity <= 1 ? opacity : BACKGROUND_DEFAULT_OPACITY,
    is_enabled: r.is_enabled !== false,
    starts_at: typeof r.starts_at === "string" ? r.starts_at : null,
    ends_at: typeof r.ends_at === "string" ? r.ends_at : null,
    created_at: typeof r.created_at === "string" ? r.created_at : "",
    updated_at: typeof r.updated_at === "string" ? r.updated_at : "",
  };
}
