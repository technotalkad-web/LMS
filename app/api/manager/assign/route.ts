import { NextResponse } from "next/server";
import { assignCourse, authorizeManager, isActionError } from "@/lib/manager/actions";

/**
 *   POST /api/manager/assign
 *   body: { orgSlug, userIds: string[], courseId, dueAt? }
 *
 * Manager action "assign a course" (Report Card, decision 6): a direct
 * per-learner assignment of an active course to the manager's own reports,
 * assigned_by = the manager, with the usual assignment email.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    userIds?: string[];
    courseId?: string;
    dueAt?: string | null;
  };
  const a = await authorizeManager(body.orgSlug);
  if (isActionError(a)) return NextResponse.json({ error: a.error }, { status: a.status });
  const r = await assignCourse(a, body);
  if (isActionError(r)) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ ok: true, ...r });
}
