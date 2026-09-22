import { NextRequest, NextResponse } from "next/server";
import { requireOrgAdminApi } from "@/lib/auth/api-admin";
import { abortDirectUpload } from "@/lib/courses/direct-upload";

/**
 *   POST /api/courses/upload/abort   { orgSlug, versionId }
 *
 * Cancels an in-progress direct upload: deletes whatever landed under the
 * version's prefix and the 'uploading' row. Ready versions cannot be
 * aborted (use the version list to roll back instead).
 */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as null | { orgSlug?: string; versionId?: string };
  if (!body?.versionId) return NextResponse.json({ error: "versionId required" }, { status: 400 });
  const auth = await requireOrgAdminApi(body.orgSlug);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const result = await abortDirectUpload({ supabase: auth.supabase, org: auth.org, versionId: body.versionId });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true });
}
