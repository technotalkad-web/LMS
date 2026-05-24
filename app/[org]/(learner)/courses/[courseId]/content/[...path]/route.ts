import { NextRequest, NextResponse } from "next/server";
import { lookup as lookupMime } from "mime-types";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { createClient } from "@/lib/supabase/server";
import { getStorage } from "@/lib/storage";
import { sanitizeStorageKey } from "@/lib/storage/keys";
import { createClient as createServiceClient } from "@supabase/supabase-js";

/**
 * Auth-gated content proxy for course packages.
 *
 *   GET /[org]/courses/[courseId]/content/[...path]
 *
 * Verifies the user has access to the org and that the course belongs to it,
 * then streams the file from the course version's storage prefix. SCORM
 * runtimes can issue relative-path requests against this URL space.
 *
 * For Phase 3 we always serve from the course's CURRENT version. Later we'll
 * accept ?v={versionNumber} to serve historical versions.
 */
export async function GET(
  request: NextRequest,
  {
    params,
  }: {
    params: Promise<{ org: string; courseId: string; path: string[] }>;
  }
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

  const { data: version } = await supabase
    .from("course_versions")
    .select("storage_prefix")
    .eq("id", course.current_version_id)
    .maybeSingle();

  if (!version) return new NextResponse("Not Found", { status: 404 });

  // Build the storage key
  const relativePath = pathSegments.map(decodeURIComponent).join("/");
  // Defend against path traversal — paths with .. would let the iframe peek
  // into other course versions or org prefixes.
  if (relativePath.includes("..")) {
    return new NextResponse("Forbidden", { status: 403 });
  }
  // Apply the same sanitization that the uploader used so we round-trip.
  const key = version.storage_prefix + sanitizeStorageKey(relativePath);

  // Fetch the file via signed URL (works for both Supabase Storage and R2).
  // For Supabase Storage we can also use the service-role client directly
  // to skip the signed-URL hop, which is faster for small assets.
  const driver = (process.env.STORAGE_DRIVER ?? "supabase").toLowerCase();
  let body: ArrayBuffer;
  if (driver === "supabase") {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const key2 = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const bucket = process.env.SUPABASE_STORAGE_BUCKET ?? "course-content";
    const svc = createServiceClient(url, key2, {
      auth: { persistSession: false },
    });
    const { data, error } = await svc.storage.from(bucket).download(key);
    if (error || !data) {
      console.error("[content] storage download failed:", error?.message, key);
      return new NextResponse("Not Found", { status: 404 });
    }
    body = await data.arrayBuffer();
  } else {
    // R2 or other: use the adapter's signed URL and fetch
    const storage = await getStorage();
    const url = await storage.getSignedDownloadUrl(key, 60);
    const res = await fetch(url);
    if (!res.ok) {
      return new NextResponse("Not Found", { status: 404 });
    }
    body = await res.arrayBuffer();
  }

  const guess = lookupMime(relativePath);
  const contentType = typeof guess === "string" ? guess : "application/octet-stream";

  return new NextResponse(body, {
    headers: {
      "content-type": contentType,
      "cache-control": "private, max-age=60",
    },
  });
}
