import { NextRequest, NextResponse } from "next/server";
import { requireOrgAdminApi } from "@/lib/auth/api-admin";
import { finalizeDirectUpload } from "@/lib/courses/direct-upload";

/**
 *   POST /api/courses/upload/finalize   { orgSlug, versionId, notify_update? }
 *
 * Step 3 of a direct upload: verifies the files are in storage, counts
 * learning units, marks the version ready and makes it current. A 409 with
 * `retryable: true` means files are still missing — the browser re-sends
 * them and calls finalize again.
 */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as null | {
    orgSlug?: string;
    versionId?: string;
    notify_update?: boolean;
    mode?: string;
  };
  if (!body?.versionId) return NextResponse.json({ error: "versionId required" }, { status: 400 });
  const auth = await requireOrgAdminApi(body.orgSlug);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const result = await finalizeDirectUpload({
    supabase: auth.supabase,
    org: auth.org,
    userId: auth.userId,
    versionId: body.versionId,
    notifyUpdate: body.notify_update === true,
    restartMode: body.mode === "force_restart" ? "force_restart" : "grandfather",
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error, retryable: result.retryable ?? false }, { status: result.status });
  }
  return NextResponse.json(result);
}
