import type { SupabaseClient } from "@supabase/supabase-js";
import { getStorage } from "@/lib/storage";
import { countLearningUnits } from "./units";

/**
 * Attempt progress % (0075) — server-side helpers shared by the cmi5
 * statement processor, the xAPI State API and the SCORM commit route.
 *
 * Progress is a separate axis from completion: it can only be raised by
 * real in-module signals, it is capped at 99 until the attempt is complete
 * (100 == complete), and it never decreases within an attempt.
 */

export const CMI5_PROGRESS_EXT = "https://w3id.org/xapi/cmi5/result/extensions/progress";

export type VersionLite = {
  id: string;
  manifest_data?: unknown;
  launch_url?: string | null;
  storage_prefix?: string | null;
};

export function clampPct(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** Progress % from a fraction done/total, capped at 99 (100 == complete). */
export function partialPct(done: number, total: number): number | null {
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0 || done <= 0) return null;
  return Math.min(99, clampPct((100 * done) / total));
}

/**
 * The module's unit count. Cached in manifest_data.unitCount (number, or
 * null once we've looked and found nothing). Versions uploaded before 0075
 * are counted lazily from their stored launch file, once.
 */
export async function ensureUnitCount(
  svc: SupabaseClient,
  version: VersionLite | null | undefined
): Promise<number | null> {
  if (!version?.id) return null;
  const md = ((version.manifest_data ?? {}) as Record<string, unknown>) ?? {};
  if (typeof md.unitCount === "number") return md.unitCount > 0 ? md.unitCount : null;
  if (md.unitCount === null) return null;

  let count: number | null = null;
  try {
    if (version.storage_prefix && version.launch_url) {
      const storage = await getStorage();
      const key =
        version.storage_prefix.replace(/\/$/, "") +
        "/" +
        version.launch_url.replace(/^\/+/, "").split("?")[0].split("#")[0];
      const url = await storage.getSignedDownloadUrl(key, 300);
      const res = await fetch(url);
      if (res.ok) count = countLearningUnits(await res.text());
    }
  } catch {
    count = null;
  }
  try {
    await svc
      .from("course_versions")
      .update({ manifest_data: { ...md, unitCount: count } })
      .eq("id", version.id);
  } catch {
    /* cache miss is harmless — recounted next time */
  }
  return count;
}

/**
 * Best-effort progress from a saved resume-state document. Understands the
 * common shapes: `{ completed: [ids] }` (KIVO engine), `{ completedSlides,
 * totalSlides }`, `{ progress: 0..1 | 0..100 }`.
 */
export function progressFromState(content: unknown): {
  done: number | null;
  pct: number | null;
  /** Completed screen ids when the state lists them (merged with statements). */
  completedIds: string[] | null;
} {
  const none = { done: null, pct: null, completedIds: null };
  let doc = content;
  if (typeof doc === "string") {
    try {
      doc = JSON.parse(doc);
    } catch {
      return none;
    }
  }
  if (!doc || typeof doc !== "object") return none;
  const o = doc as Record<string, unknown>;
  const completedIds = Array.isArray(o.completed)
    ? o.completed
        .filter((v): v is string | number => typeof v === "string" || typeof v === "number")
        .map((v) => String(v).trim().toLowerCase())
        .filter(Boolean)
    : null;
  if (typeof o.completedSlides === "number" && typeof o.totalSlides === "number" && o.totalSlides > 0) {
    return { done: o.completedSlides, pct: partialPct(o.completedSlides, o.totalSlides), completedIds };
  }
  if (typeof o.progress === "number" && Number.isFinite(o.progress)) {
    const p = o.progress <= 1 ? o.progress * 100 : o.progress;
    return { done: null, pct: Math.min(99, clampPct(p)), completedIds };
  }
  if (completedIds) return { done: completedIds.length, pct: null, completedIds };
  return none;
}

/**
 * Update an attempt, tolerating a database that hasn't run 0075 yet: if
 * the write fails because progress_pct doesn't exist, retry without it.
 */
export async function updateAttemptFailSoft(
  svc: SupabaseClient,
  attemptId: string,
  update: Record<string, unknown>,
  extra?: { userId?: string }
): Promise<{ message: string } | null> {
  const run = async (u: Record<string, unknown>) => {
    let q = svc.from("course_attempts").update(u).eq("id", attemptId);
    if (extra?.userId) q = q.eq("user_id", extra.userId);
    const { error } = await q;
    return error;
  };
  let error = await run(update);
  if (error && "progress_pct" in update && /progress_pct/i.test(error.message)) {
    const rest = { ...update };
    delete rest.progress_pct;
    error = await run(rest);
  }
  return error ? { message: error.message } : null;
}

/** Raise an attempt's progress from its saved state (never lowers it). */
export async function updateProgressFromState(
  svc: SupabaseClient,
  attemptId: string,
  content: unknown
): Promise<number | null> {
  const p = progressFromState(content);
  if (p.done === null && p.pct === null) return null;
  const { data: row } = await svc
    .from("course_attempts")
    .select("*, course_versions(id, manifest_data, launch_url, storage_prefix)")
    .eq("id", attemptId)
    .maybeSingle();
  if (!row) return null;
  const r = row as Record<string, unknown>;
  if (r.completion_status === "completed") return 100;
  const update: Record<string, unknown> = {};
  let pct = p.pct;
  // Screens the state lists as completed count exactly like per-screen
  // statements — merge them into the attempt's unit map so both signals
  // agree (a screen reached in one session isn't "lost" to the other).
  let done = p.done;
  if (p.completedIds && p.completedIds.length > 0) {
    const cmi = ((r.cmi_data ?? {}) as Record<string, unknown>) ?? {};
    const cmi5 = ((cmi.cmi5 ?? {}) as Record<string, unknown>) ?? {};
    const units = { ...((cmi5.units ?? {}) as Record<string, string>) };
    let changed = false;
    for (const id of p.completedIds) {
      if (units[id] !== "completed") {
        units[id] = "completed";
        changed = true;
      }
    }
    if (changed) update.cmi_data = { ...cmi, cmi5: { ...cmi5, units } };
    done = Object.values(units).filter((v) => v === "completed").length;
  }
  if (pct === null && done !== null) {
    const version = (Array.isArray(r.course_versions) ? r.course_versions[0] : r.course_versions) as VersionLite | null;
    const total = await ensureUnitCount(svc, version);
    if (total) pct = partialPct(done, total);
  }
  const current = typeof r.progress_pct === "number" ? r.progress_pct : null;
  if (pct !== null && (current === null || pct > current)) update.progress_pct = pct;
  if (Object.keys(update).length === 0) return current;
  await updateAttemptFailSoft(svc, attemptId, update);
  return (update.progress_pct as number | undefined) ?? current;
}
