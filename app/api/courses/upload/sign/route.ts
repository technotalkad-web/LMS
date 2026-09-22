import { NextRequest, NextResponse } from "next/server";
import { requireOrgAdminApi } from "@/lib/auth/api-admin";
import { signUploadBatch } from "@/lib/courses/direct-upload";

/**
 *   POST /api/courses/upload/sign   { orgSlug, versionId, files: [{ path, contentType? }] }
 *
 * Step 2 of a direct upload: signed PUT URLs for a BATCH of the version's
 * files. The browser calls this right before uploading each batch, so a
 * backend that needs a network call per signature (Supabase Storage) never
 * exceeds the Worker's per-request budget; R2 signs locally and takes the
 * whole package in one call. Only 'uploading' versions in the caller's org
 * can be signed for, and every key stays under the version's own prefix.
 */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as null | {
    orgSlug?: string;
    versionId?: string;
    files?: Array<{ path: string; contentType?: string }>;
  };
  if (!body?.versionId || !Array.isArray(body.files)) {
    return NextResponse.json({ error: "versionId and files required" }, { status: 400 });
  }
  const auth = await requireOrgAdminApi(body.orgSlug);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const result = await signUploadBatch({
    supabase: auth.supabase,
    org: auth.org,
    versionId: body.versionId,
    files: body.files,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json(result);
}
