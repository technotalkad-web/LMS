import { NextRequest } from "next/server";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { createClient } from "@/lib/supabase/server";
import {
  contentNotFound,
  legacyCourseVersion,
  serveVersionFile,
} from "@/lib/courses/content-delivery";

/**
 * LEGACY auth-gated content delivery — kept for one release (ALDS step 0,
 * P1) for tabs opened before the launch page switched to the versioned
 * route `content/v/[versionId]/[...path]`; removed in the release after
 * ALDS step 2.
 *
 *   GET /[org]/courses/[courseId]/content/[...path]
 *
 * Serves the version of the learner's latest non-abandoned attempt on this
 * course, else the course's current version (blueprint §0 P1). Before P1 this
 * route always served the current version — the last published one of ANY
 * language — so a tab opened before the deploy by a learner on another
 * language or a grandfathered version was already running the wrong package;
 * its lazily-loaded files now come from the attempt's package, and a reload
 * (which uses the versioned URLs) puts the whole session on it. Streaming,
 * Range and the edge cache (keyed by storage key) are shared with the
 * versioned route.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ org: string; courseId: string; path: string[] }> }
) {
  const { org: orgSlug, courseId, path: pathSegments } = await params;

  // Auth
  const { user, org } = await requireOrgAccess(orgSlug);

  const supabase = await createClient();
  const version = await legacyCourseVersion(supabase, org.id, user.id, courseId);
  if (!version) return contentNotFound();
  return serveVersionFile(request, version, pathSegments);
}
