import type { SupabaseClient } from "@supabase/supabase-js";
import { getStorage, getStorageFor, type StorageAdapter } from "@/lib/storage";
import { ATTEMPT_ABANDONED, AttemptAbandonedError } from "@/lib/attempts/abandon";
import { isMissingColumn } from "@/lib/scoring/attempt-kind";
import { countLearningUnits, launchBodyAllowed, MAX_LAUNCH_READ_BYTES } from "./units";
import { engineVersionForManifest, type EngineReadError } from "./engine-version";

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
  /** The 0077 column: the driver this version's files were written to. */
  storage_driver?: string | null;
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
 * What a stored manifest_data asks of ensureUnitCount (ADR 0016 step 2): a
 * number stands; a null with unitCountAlgo 2 is final; anything else (a null
 * from the matcher before ADR 0016, or no key) is counted from the launch file.
 */
export function unitCountPlan(
  md: Record<string, unknown>
): { kind: "number"; value: number | null } | { kind: "final" } | { kind: "recount" } {
  if (typeof md.unitCount === "number") {
    return { kind: "number", value: md.unitCount > 0 ? md.unitCount : null };
  }
  if (md.unitCount === null && md.unitCountAlgo === 2) return { kind: "final" };
  return { kind: "recount" };
}

/**
 * The stored launch file's text, or null. This runs inside a learner's request,
 * so storage is asked for the object's size before anything is fetched (ADR
 * 0016 step 2): no object, or a size outside MAX_LAUNCH_READ_BYTES, answers
 * null without the signed fetch. It reads through the active driver.
 */
async function readLaunchHtmlFromStorage(version: VersionLite): Promise<string | null> {
  if (!version.storage_prefix || !version.launch_url) return null;
  const storage = await getStorage();
  const key =
    version.storage_prefix.replace(/\/$/, "") +
    "/" +
    version.launch_url.replace(/^\/+/, "").split("?")[0].split("#")[0];
  const head = await storage.head(key);
  if (!head || !launchBodyAllowed(head.size, MAX_LAUNCH_READ_BYTES)) return null;
  const url = await storage.getSignedDownloadUrl(key, 300);
  const res = await fetch(url);
  return res.ok ? await res.text() : null;
}

/**
 * The module's unit count. Cached in manifest_data.unitCount (number, or
 * null once we've looked and found nothing), with unitCountAlgo recording the
 * matcher that looked. Versions uploaded before 0075 are counted lazily from
 * their stored launch file. That happens once per matcher: a null written by
 * the matcher before ADR 0016 (no unitCountAlgo) is recounted one more time and
 * then marked (ADR 0016 step 2), on whichever of a learner's statement
 * (lib/xapi/process-statement.ts) or State write (updateProgressFromState,
 * below) arrives first.
 *
 * A failed read caches its null as it always has, now with the marker in the
 * same update, so that one attempt is final for the version. `deps` is the unit
 * test's seam.
 */
export async function ensureUnitCount(
  svc: SupabaseClient,
  version: VersionLite | null | undefined,
  deps?: { readLaunchHtml?: (v: VersionLite) => Promise<string | null> }
): Promise<number | null> {
  if (!version?.id) return null;
  const md = ((version.manifest_data ?? {}) as Record<string, unknown>) ?? {};
  const plan = unitCountPlan(md);
  if (plan.kind === "number") return plan.value;
  if (plan.kind === "final") return null;

  const readLaunchHtml = deps?.readLaunchHtml ?? readLaunchHtmlFromStorage;
  let count: number | null = null;
  try {
    const html = await readLaunchHtml(version);
    if (html !== null) count = countLearningUnits(html);
  } catch {
    count = null;
  }
  try {
    await svc
      .from("course_versions")
      .update({ manifest_data: { ...md, unitCount: count, unitCountAlgo: 2 } })
      .eq("id", version.id);
  } catch {
    /* cache miss is harmless — recounted next time */
  }
  return count;
}

/** What a read of the stored launch file found, for the engine stamp (ADR 0017 step 5). */
export type LaunchFileRead =
  | { kind: "ok"; html: string }
  | { kind: "no_object" }
  | { kind: "too_large"; size: number }
  | { kind: "failed"; error: EngineReadError; detail?: string };

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The stored launch file, for the engine stamp, as one of four outcomes: the
 * stamp has to tell them apart, where readLaunchHtmlFromStorage's null means
 * "looked, nothing" for the unit count. Same key, same size check and same cap
 * as that reader. It reads through the version's own storage driver, so a
 * version stored before a driver change still reads. No key to look at is no
 * object at the key. A size is too large only when it is a number above the cap; 0
 * or a non-number is a failed read, because the stores answer 0 for a size they do not
 * know (ADR 0017's note of 2026-11-06), and it caches nothing. `storage` is the unit
 * test's seam; `signal` lets the bound in ensureEngineVersion let go of the signed
 * fetch, its body included.
 */
export async function readLaunchFileForStamp(
  version: VersionLite,
  storage?: Pick<StorageAdapter, "head" | "getSignedDownloadUrl">,
  signal?: AbortSignal
): Promise<LaunchFileRead> {
  if (!version.storage_prefix || !version.launch_url) return { kind: "no_object" };
  const adapter = storage ?? (await getStorageFor(version.storage_driver ?? null));
  const key =
    version.storage_prefix.replace(/\/$/, "") +
    "/" +
    version.launch_url.replace(/^\/+/, "").split("?")[0].split("#")[0];
  const head = await adapter.head(key);
  if (!head) return { kind: "no_object" };
  if (!launchBodyAllowed(head.size, MAX_LAUNCH_READ_BYTES)) {
    return Number.isFinite(head.size) && head.size > MAX_LAUNCH_READ_BYTES
      ? { kind: "too_large", size: head.size }
      : { kind: "failed", error: "bad_size", detail: `size ${String(head.size)}` };
  }
  const url = await adapter.getSignedDownloadUrl(key, 300);
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return { kind: "failed", error: "fetch_failed", detail: `fetch ${res.status}` };
    return { kind: "ok", html: await res.text() };
  } catch (e) {
    return { kind: "failed", error: "fetch_failed", detail: messageOf(e) };
  }
}

/** The lazy read runs inside a learner's request: the webhook's own bound. */
const ENGINE_READ_TIMEOUT_MS = 5000;

/**
 * The version's engine stamp (ADR 0017 step 5), cached in
 * manifest_data.engineVersion: a stamp, the literal `unknown` (a KIVO build whose
 * stamp is missing or does not parse), or null (read, and not a KIVO build). A
 * version uploaded before the stamping is read the first time the guard needs it.
 *
 * Modelled on ensureUnitCount above, and it departs from it on purpose, because
 * here a cached null would read as "not a KIVO build" and keep the one-time
 * upgrade silently on what may be a new-engine version:
 *   - a storage error, a failed fetch, a head with no usable size or no object at the
 *     key caches NOTHING and answers `error`, which the verdict reads as unreadable,
 *     and the next candidate reads again. `error` is always a class
 *     (ENGINE_READ_ERRORS), because the guard writes it on the row; the store's raw
 *     text stays in the engine_version_unreadable log line;
 *   - a file over MAX_LAUNCH_READ_BYTES makes no signed fetch and caches the
 *     engineVersionRead marker with the cap, never engineVersion: null, so a
 *     later cap change reads it again;
 *   - it reads through the version's own storage driver, where ensureUnitCount
 *     reads through the active one;
 *   - a read that has not answered after ENGINE_READ_TIMEOUT_MS is a failed read:
 *     a stalled store must not hold the learner's request, and with it the
 *     engine's queue or the SCORM commit chain. Nothing is cached, and the next
 *     candidate reads again.
 *
 * `deps` is the unit test's seam. The three lazy writers of manifest_data may
 * lose each other's key; each key is recomputed from the stored bytes next time.
 */
export async function ensureEngineVersion(
  svc: SupabaseClient,
  version: VersionLite | null | undefined,
  deps?: { readLaunchFile?: (v: VersionLite, signal?: AbortSignal) => Promise<LaunchFileRead>; readTimeoutMs?: number }
): Promise<{ stamp: string | null; cached: boolean; error?: EngineReadError }> {
  const unreadable = (error: EngineReadError, detail?: string) => {
    console.warn(JSON.stringify({ event: "engine_version_unreadable", version_id: version?.id ?? null, error, ...(detail ? { detail } : {}) }));
    return { stamp: null, cached: false, error };
  };
  if (!version?.id) return unreadable("no_object");
  const md = ((version.manifest_data ?? {}) as Record<string, unknown>) ?? {};
  if (typeof md.engineVersion === "string" || md.engineVersion === null) {
    return { stamp: md.engineVersion, cached: true };
  }
  const marker = md.engineVersionRead as { too_large?: unknown; cap?: unknown } | null | undefined;
  if (marker?.too_large === true && marker.cap === MAX_LAUNCH_READ_BYTES) {
    return { stamp: null, cached: true, error: "too_large" };
  }

  const readLaunchFile = deps?.readLaunchFile ?? ((v: VersionLite, signal?: AbortSignal) => readLaunchFileForStamp(v, undefined, signal));
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let read: LaunchFileRead;
  try {
    read = await Promise.race([
      readLaunchFile(version, controller.signal),
      new Promise<LaunchFileRead>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve({ kind: "failed", error: "timeout" });
        }, deps?.readTimeoutMs ?? ENGINE_READ_TIMEOUT_MS);
      }),
    ]);
  } catch (e) {
    read = { kind: "failed", error: "storage_error", detail: messageOf(e) };
  } finally {
    clearTimeout(timer);
  }
  if (read.kind === "no_object") return unreadable("no_object");
  if (read.kind === "failed") return unreadable(read.error, read.detail);

  const stamp = read.kind === "ok" ? (engineVersionForManifest(read.html) ?? null) : null;
  const patch =
    read.kind === "ok"
      ? { engineVersion: stamp }
      : { engineVersionRead: { too_large: true, cap: MAX_LAUNCH_READ_BYTES } };
  let cached = false;
  try {
    const { error } = await svc
      .from("course_versions")
      .update({ manifest_data: { ...md, ...patch } })
      .eq("id", version.id);
    cached = !error;
  } catch {
    /* a cache miss is harmless: read again next time */
  }
  if (cached) {
    console.warn(
      JSON.stringify({
        event: "engine_version_cached",
        version_id: version.id,
        engine_version: read.kind === "ok" ? stamp : "too_large",
      })
    );
  }
  return read.kind === "ok" ? { stamp, cached } : { stamp: null, cached, error: "too_large" };
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
 * Update an attempt, tolerating a database that hasn't run 0075 or 0104 yet: if
 * the write fails because progress_pct or ignored_pass doesn't exist, retry
 * without it. The error can name either column first, so the retries run in a
 * bounded loop. Without ignored_pass the record is lost and logged, and nothing
 * else changes: the guard reads success_status, so the hold never depends on 0104.
 * Only a missing column drops the record (ADR 0017 step 12: 42703 or PGRST204
 * naming it). Any other error is a real failure and stands: a transient outage's
 * retry must not lose the record of a pass the engine will not send again.
 *
 * ALDS step 0 (P4): the write is conditional on `status <> 'abandoned'` —
 * an abandoned attempt is terminal and no content write may revive it. A
 * write that matches no row returns `{ abandoned: true }` (callers answer
 * 410 attempt_abandoned); callers read the attempt first, so "no row" here
 * means it was abandoned in between.
 *
 * ADR 0009: `svc` is always a service client (attempt rows are written by
 * the server only), so RLS no longer checks ownership. `extra.userId` is
 * mandatory for a user-session caller (the SCORM commit passes the session
 * user); the token-bound xAPI callers have none, their launch token binds
 * the attempt.
 */
export async function updateAttemptFailSoft(
  svc: SupabaseClient,
  attemptId: string,
  update: Record<string, unknown>,
  extra?: { userId?: string }
): Promise<{ message: string; abandoned?: true } | null> {
  const run = async (u: Record<string, unknown>) => {
    let q = svc
      .from("course_attempts")
      .update(u)
      .eq("id", attemptId)
      .neq("status", "abandoned");
    if (extra?.userId) q = q.eq("user_id", extra.userId);
    const { data, error } = await q.select("id");
    return { error, rows: Array.isArray(data) ? data.length : 0 };
  };
  const unrecorded = (reason: string) =>
    console.warn(JSON.stringify({ event: "ignored_pass_unrecorded", attempt_id: attemptId, reason }));
  let current = update;
  let res = await run(current);
  for (let retry = 0; retry < 2 && res.error; retry++) {
    const rest = { ...current };
    if ("progress_pct" in current && /progress_pct/i.test(res.error.message)) {
      delete rest.progress_pct;
    } else if ("ignored_pass" in current && isMissingColumn(res.error, "ignored_pass")) {
      delete rest.ignored_pass;
      unrecorded(res.error.message);
    } else {
      break;
    }
    current = rest;
    res = await run(current);
  }
  if (res.error) {
    if ("ignored_pass" in current) unrecorded(res.error.message);
    return { message: res.error.message };
  }
  if (res.rows === 0) return { message: ATTEMPT_ABANDONED, abandoned: true };
  return null;
}

/**
 * Raise an attempt's progress from its saved state (never lowers it).
 * Throws AttemptAbandonedError when the attempt is abandoned (P4) — the
 * State route answers 410.
 */
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
  if (r.status === "abandoned") throw new AttemptAbandonedError(attemptId);
  // ADR 0014 step 4: a revision visit's row records no progress (the State
  // document itself is still stored by the State route). select("*"):
  // undefined on a database without 0103.
  if (r.is_revision === true) return null;
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
  const err = await updateAttemptFailSoft(svc, attemptId, update);
  if (err?.abandoned) throw new AttemptAbandonedError(attemptId);
  return (update.progress_pct as number | undefined) ?? current;
}
