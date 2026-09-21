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
export function progressFromState(content: unknown): { done: number | null; pct: number | null } {
  let doc = content;
  if (typeof doc === "string") {
    try {
      doc = JSON.parse(doc);
    } catch {
      return { done: null, pct: null };
    }
  }
  if (!doc || typeof doc !== "object") return { done: null, pct: null };
  const o = doc as Record<string, unknown>;
  if (typeof o.completedSlides === "number" && typeof o.totalSlides === "number" && o.totalSlides > 0) {
    return { done: o.completedSlides, pct: partialPct(o.completedSlides, o.totalSlides) };
  }
  if (typeof o.progress === "number" && Number.isFinite(o.progress)) {
    const p = o.progress <= 1 ? o.progress * 100 : o.progress;
    return { done: null, pct: Math.min(99, clampPct(p)) };
  }
  if (Array.isArray(o.completed)) return { done: o.completed.length, pct: null };
  return { done: null, pct: null };
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
  let pct = p.pct;
  if (pct === null && p.done !== null) {
    const version = (Array.isArray(r.course_versions) ? r.course_versions[0] : r.course_versions) as VersionLite | null;
    const total = await ensureUnitCount(svc, version);
    if (total) pct = partialPct(p.done, total);
  }
  if (pct === null) return null;
  const current = typeof r.progress_pct === "number" ? r.progress_pct : null;
  if (current !== null && current >= pct) return current;
  await updateAttemptFailSoft(svc, attemptId, { progress_pct: pct });
  return pct;
}
