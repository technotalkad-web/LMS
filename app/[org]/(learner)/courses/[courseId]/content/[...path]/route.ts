import { NextRequest, NextResponse } from "next/server";
import { lookup as lookupMime } from "mime-types";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { createClient } from "@/lib/supabase/server";
import { getStorageFor } from "@/lib/storage";
import { sanitizeStorageKey } from "@/lib/storage/keys";
import { StorageRangeError } from "@/lib/storage/types";

/**
 * Auth-gated content delivery for course packages.
 *
 *   GET /[org]/courses/[courseId]/content/[...path]
 *
 * Verifies the user has access to the org and that the course belongs to it,
 * then STREAMS the file from the course version's storage (Supabase Storage
 * or R2, per course_versions.storage_driver). SCORM / cmi5 / xAPI runtimes
 * issue relative-path requests against this URL space.
 *
 *   - Range requests are honoured (206 + Content-Range), so video and audio
 *     seek and mobile browsers can fetch in chunks.
 *   - Whole-file responses are cached at the Cloudflare edge after the auth
 *     check. Version folders are immutable, so cached bytes never go stale;
 *     a new version is a new path.
 *   - Nothing is buffered in Worker memory: the storage body is passed
 *     through as a stream.
 *
 * Always serves the course's CURRENT version.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ org: string; courseId: string; path: string[] }> }
) {
  const { org: orgSlug, courseId, path: pathSegments } = await params;

  // Auth
  const { org } = await requireOrgAccess(orgSlug);

  // Resolve course & current version
  const supabase = await createClient();
  const { data: course } = await supabase
    .from("courses")
    .select("id, organization_id, current_version_id")
    .eq("id", courseId)
    .eq("organization_id", org.id)
    .maybeSingle();
  if (!course || !course.current_version_id) {
    return new NextResponse("Not Found", { status: 404 });
  }
  // select("*"): storage_driver arrives with migration 0077; older rows read
  // as the env default.
  const { data: versionRow } = await supabase
    .from("course_versions")
    .select("*")
    .eq("id", course.current_version_id)
    .maybeSingle();
  const version = versionRow as { storage_prefix: string; storage_driver?: string | null } | null;
  if (!version) return new NextResponse("Not Found", { status: 404 });

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
  // after the auth check above. Unavailable in local dev → skip.
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
