import { NextRequest, NextResponse } from "next/server";
import { requireOrgAdminApi } from "@/lib/auth/api-admin";
import { finalizeAnswer, finalizeDirectUpload } from "@/lib/courses/direct-upload";

/**
 *   POST /api/courses/upload/finalize   { orgSlug, versionId, notify_update?, mode? }
 *
 * Step 3 of a direct upload: verifies the files are in storage, counts
 * learning units, marks the version ready and makes it current. A 409 with
 * `retryable: true` means files are still missing — the browser re-sends
 * them and calls finalize again.
 *
 * Three outcomes (ADR 0011 step 6):
 *   - refused: `{ error, retryable }` with its status; nothing was published;
 *   - published: 200 with the result; with `mode: "force_restart"` it carries
 *     `restart` (status "ok", the counts and a message);
 *   - published, but the forced restart failed: 500 with the result plus
 *     `ok: false`, `published: true`, `error` (the restart's message) and
 *     `retryable: false`. The version IS ready and current; the retry is
 *     "Restart learners on this version" on each older version. A client
 *     must not abort the upload on this answer.
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
  const answer = finalizeAnswer(result);
  return NextResponse.json(answer.body, { status: answer.status });
}
