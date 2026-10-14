import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { lookup as lookupMime } from "mime-types";
import { getStorageFor } from "@/lib/storage";
import { sanitizeStorageKey } from "@/lib/storage/keys";
import { StorageRangeError } from "@/lib/storage/types";

/**
 * Course package delivery, shared by the two content routes (ALDS step 0, P1):
 *
 *   /[org]/courses/[courseId]/content/v/[versionId]/[...path]
 *       Versioned. The launch page builds every content URL from the
 *       attempt's course_version_id, so an attempt is always served the
 *       package it was opened on (another language, a retired version).
 *   /[org]/courses/[courseId]/content/[...path]
 *       Legacy, kept for one release for tabs opened before the versioned
 *       URLs shipped: serves the learner's latest non-abandoned attempt's
 *       version, else courses.current_version_id.
 *
 * Both stream from storage with Range support and the edge cache keyed by
 * the STORAGE key (never the URL), unchanged from the original route.
 */

export type DeliveryVersion = {
  id: string;
  course_id?: string;
  storage_prefix: string;
  /** Arrives with migration 0077; older rows read as the env default. */
  storage_driver?: string | null;
  /** 0077: 'uploading' | 'ready' | 'failed'; absent before the migration. */
  upload_status?: string | null;
};

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Attempt statuses the legacy route honours (everything but "abandoned"). */
const LIVE_ATTEMPT_STATUSES = ["in_progress", "completed", "passed", "failed"];

/**
 * The version row for `versionId`, only when it belongs to `courseId`, that
 * course belongs to the org, and the version's upload is finished. null →
 * the caller answers 404.
 */
export async function orgCourseVersion(
  supabase: SupabaseClient,
  orgId: string,
  courseId: string,
  versionId: string
): Promise<DeliveryVersion | null> {
  if (!UUID_RE.test(courseId) || !UUID_RE.test(versionId)) return null;
  const [{ data: course }, { data: versionRow }] = await Promise.all([
    supabase
      .from("courses")
      .select("id")
      .eq("id", courseId)
      .eq("organization_id", orgId)
      .maybeSingle(),
    // select("*"): storage_driver arrives with migration 0077.
    supabase
      .from("course_versions")
      .select("*")
      .eq("id", versionId)
      .eq("course_id", courseId)
      .maybeSingle(),
  ]);
  if (!course || !versionRow) return null;
  const v = versionRow as DeliveryVersion;
  // Only finished uploads are servable (0077): a direct upload's row exists
  // while its files are still arriving. Pre-0077 rows carry no status.
  if (v.upload_status != null && v.upload_status !== "ready") return null;
  return v;
}

/**
 * Pure rule for the legacy route: the newest attempt (callers pass rows
 * sorted by started_at, newest first) that is not abandoned decides the
 * version; with none, the course's current version.
 */
export function pickLegacyVersionId(
  attempts: Array<{ course_version_id: string | null; status: string | null }>,
  currentVersionId: string | null
): string | null {
  const live = attempts.find(
    (a) => !!a.course_version_id && LIVE_ATTEMPT_STATUSES.includes(a.status ?? "")
  );
  return live?.course_version_id ?? currentVersionId ?? null;
}

/** Legacy route resolution (see the module comment). */
export async function legacyCourseVersion(
  supabase: SupabaseClient,
  orgId: string,
  userId: string,
  courseId: string
): Promise<DeliveryVersion | null> {
  if (!UUID_RE.test(courseId)) return null;
  const { data: course } = await supabase
    .from("courses")
    .select("id, current_version_id")
    .eq("id", courseId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (!course) return null;
  const { data: attemptRows } = await supabase
    .from("course_attempts")
    .select("course_version_id, status, started_at, course_versions!inner(course_id)")
    .eq("user_id", userId)
    .eq("course_versions.course_id", courseId)
    .in("status", LIVE_ATTEMPT_STATUSES)
    .order("started_at", { ascending: false })
    .limit(1);
  const versionId = pickLegacyVersionId(
    (attemptRows ?? []) as Array<{ course_version_id: string | null; status: string | null }>,
    (course as { current_version_id: string | null }).current_version_id
  );
  if (!versionId) return null;
  const { data: versionRow } = await supabase
    .from("course_versions")
    .select("*")
    .eq("id", versionId)
    .eq("course_id", courseId)
    .maybeSingle();
  return (versionRow as DeliveryVersion | null) ?? null;
}

export function contentNotFound(): Response {
  return new NextResponse("Not Found", { status: 404 });
}

/**
 * Stream `storage_prefix + path` of one version.
 *   - Range requests are honoured (206 + Content-Range), so video and audio
 *     seek and mobile browsers can fetch in chunks.
 *   - Whole-file responses are cached at the Cloudflare edge after the
 *     caller's auth check, keyed by storage key. Version folders are
 *     immutable, so cached bytes never go stale.
 *   - Nothing is buffered in Worker memory: the storage body is passed
 *     through as a stream.
 */
export async function serveVersionFile(
  request: Request,
  version: DeliveryVersion,
  pathSegments: string[]
): Promise<Response> {
  // Build the storage key. Defend against path traversal — paths with ..
  // would let the iframe peek into other course versions or org prefixes.
  const relativePath = pathSegments.map(decodeURIComponent).join("/");
  if (relativePath.includes("..")) {
    return new NextResponse("Forbidden", { status: 403 });
  }
  const key = version.storage_prefix + sanitizeStorageKey(relativePath);

  const guess = lookupMime(relativePath);
  const contentType = typeof guess === "string" ? guess : "application/octet-stream";
  const range = request.headers.get("range");

  // Edge cache (Workers Cache API). Keyed by storage key, consulted only
  // after the caller's auth check. Unavailable in local dev → skip.
  const cache = await edgeCache();
  const cacheKey = new Request(`https://lms-content.cache/${encodeURI(key)}`);
  if (!range && cache) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const h = new Headers(hit.headers);
      h.set("cache-control", "private, max-age=3600");
      h.set("x-lms-cache", "hit");
      return new Response(hit.body, { status: 200, headers: h });
    }
  }

  const storage = await getStorageFor(version.storage_driver ?? null);
  let obj;
  try {
    obj = await storage.getObject(key, range);
  } catch (e) {
    if (e instanceof StorageRangeError) {
      return new Response(null, {
        status: 416,
        headers: { "content-range": `bytes */${e.size}`, "accept-ranges": "bytes" },
      });
    }
    console.error("[content] storage read failed:", e instanceof Error ? e.message : e, key);
    return new NextResponse("Not Found", { status: 404 });
  }
  if (!obj) {
    console.error("[content] object missing:", key);
    return new NextResponse("Not Found", { status: 404 });
  }

  const headers = new Headers({
    "content-type": contentType,
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=3600",
    "x-lms-cache": "miss",
  });
  if (obj.contentLength >= 0) headers.set("content-length", String(obj.contentLength));
  if (obj.etag) headers.set("etag", obj.etag);
  if (obj.status === 206 && obj.contentRange) headers.set("content-range", obj.contentRange);

  // Whole-file responses up to 100 MB are kept at the edge for a year (the
  // path is immutable). Range responses pass straight through.
  if (obj.status === 200 && cache && obj.size <= 100 * 1024 * 1024 && obj.body) {
    const [toClient, toCache] = obj.body.tee();
    const cacheHeaders = new Headers(headers);
    cacheHeaders.set("cache-control", "public, max-age=31536000, immutable");
    cacheHeaders.delete("x-lms-cache");
    await inBackground(cache.put(cacheKey, new Response(toCache, { status: 200, headers: cacheHeaders })));
    return new Response(toClient, { status: 200, headers });
  }
  return new Response(obj.body, { status: obj.status, headers });
}

async function edgeCache(): Promise<Cache | null> {
  try {
    const c = (globalThis as unknown as { caches?: { default?: Cache } }).caches;
    return c?.default ?? null;
  } catch {
    return null;
  }
}

/** Run after the response is sent when a Workers execution context exists. */
async function inBackground(job: Promise<unknown>): Promise<void> {
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    getCloudflareContext().ctx.waitUntil(job);
  } catch {
    // Local dev / no execution context: let it run detached; a failed cache
    // write is harmless.
    job.catch(() => {});
  }
}
