import { NextRequest } from "next/server";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { createClient } from "@/lib/supabase/server";
import {
  UUID_RE,
  contentNotFound,
  legacyCourseVersion,
  orgCourseVersion,
  serveVersionFile,
} from "@/lib/courses/content-delivery";

/**
 * Versioned, auth-gated content delivery (ALDS step 0, P1).
 *
 *   GET /[org]/courses/[courseId]/content/v/[versionId]/[...path]
 *
 * The launch page builds every content URL from the attempt's
 * course_version_id, so the iframe always runs the package the attempt was
 * opened on — never whatever is current for the course. 404 unless the
 * version belongs to this course and the course belongs to the org. The
 * bytes stream from `storage_prefix + path` (Range + edge cache keyed by
 * storage key, as before).
 */
export async function GET(
  request: NextRequest,
  {
    params,
  }: {
    params: Promise<{ org: string; courseId: string; versionId: string; path: string[] }>;
  }
) {
  const { org: orgSlug, courseId, versionId, path: pathSegments } = await params;
  const { user, org } = await requireOrgAccess(orgSlug);
  const supabase = await createClient();

  // A pre-versioning package whose top-level folder is literally "v" lands
  // here from a legacy URL (/content/v/<folder>/…): keep serving it under
  // the legacy rule while that route exists. Version ids are always UUIDs.
  if (!UUID_RE.test(versionId)) {
    const legacy = await legacyCourseVersion(supabase, org.id, user.id, courseId);
    if (!legacy) return contentNotFound();
    return serveVersionFile(request, legacy, ["v", versionId, ...pathSegments]);
  }

  const version = await orgCourseVersion(supabase, org.id, courseId, versionId);
  if (!version) return contentNotFound();
  return serveVersionFile(request, version, pathSegments);
}
