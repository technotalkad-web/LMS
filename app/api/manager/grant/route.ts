import { NextResponse } from "next/server";
import { authorizeManager, grantRetries, isActionError } from "@/lib/manager/actions";

/**
 *   POST /api/manager/grant
 *   body: { orgSlug, userIds: string[], courseId, expires_in_days? }
 *
 * Manager action "grant a retry" (Report Card, decision 6): one extra
 * official attempt for direct reports who FAILED the module (official rule)
 * and have used their window — the same approved-grant row the admin bulk
 * grant creates, with source='manager' (0092) and decided_by = the manager.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    userIds?: string[];
    courseId?: string;
    expires_in_days?: number | null;
  };
  const a = await authorizeManager(body.orgSlug);
  if (isActionError(a)) return NextResponse.json({ error: a.error }, { status: a.status });
  const r = await grantRetries(a, body);
  if (isActionError(r)) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ ok: true, ...r });
}
