import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { computeScoring, type ScorableAttempt } from "@/lib/scoring/policy";
import { resolvePolicy } from "@/lib/scoring/resolve";
import { readWithOptionalColumn } from "@/lib/scoring/attempt-kind";
import { isUuid, officialResultStored } from "@/lib/learner/continue";

/**
 *   GET /api/attempts/{attemptId}/result-stored
 *   → 200 { stored: boolean }
 *
 * The launch bar's Continue state (ADR 0019, note of 2026-11-11): whether the
 * official result of the attempt's course is stored, with its verdict on a
 * pass-required course. The bar asks while Continue waits (a poll on cmi5 and
 * xAPI launches, one check after a terminal SCORM commit, a tap) and turns
 * Continue active on `{ stored: true }`.
 *
 * Learner-owned and read-only: the caller's session (the cookie-bound client),
 * the learner's own attempt rows only (`user_id = user.id`, under the
 * "members read own attempts" select policy), no service role, no write.
 * The answer is the continue address's own conclude test
 * (officialResultStored) over the continue address's own strict reads, so
 * the bar and the address never disagree.
 *
 * Answers, in this order, each with Cache-Control: no-store:
 *   404 {}                      the id is not a uuid (no read);
 *   401 { error: "unauthorized" } no session (the middleware redirects a
 *                               signed-out call first; this is the backstop);
 *   503 { error: "unreadable" } a read failed, or the attempt's version is no
 *                               longer readable to the learner (removed from
 *                               the organisation mid-session): never reported
 *                               as a verdict, `stored: false` would look like one;
 *   404 {}                      no such attempt of this learner (absent and
 *                               another learner's alike);
 *   200 { stored }              otherwise.
 */
const ATTEMPT_COLUMNS = "id, score, started_at, completed_at, completion_status, success_status, status";

const NO_STORE = { "Cache-Control": "no-store" };
const answer = (body: Record<string, unknown>, status: number) =>
  NextResponse.json(body, { status, headers: NO_STORE });

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ attemptId: string }> }
) {
  const { attemptId } = await params;
  if (!isUuid(attemptId)) return answer({}, 404);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return answer({ error: "unauthorized" }, 401);

  const unreadable = () => {
    console.warn(JSON.stringify({ event: "result_stored_unreadable", attempt_id: attemptId }));
    return answer({ error: "unreadable" }, 503);
  };

  // The learner's own attempt and its course.
  const { data: own, error: ownErr } = await supabase
    .from("course_attempts")
    .select("id, course_version_id, course_versions(course_id)")
    .eq("id", attemptId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (ownErr) return unreadable();
  if (!own) return answer({}, 404);
  const embed = (own as { course_versions?: { course_id?: string | null } | Array<{ course_id?: string | null }> | null })
    .course_versions;
  const courseId = (Array.isArray(embed) ? embed[0]?.course_id : embed?.course_id) ?? null;
  if (typeof courseId !== "string") return unreadable();

  // The continue address's strict reads, in its shape: an error is never read
  // as "not required" or "no grants".
  const { data: courseRow, error: courseErr } = await supabase
    .from("courses")
    .select("pass_required")
    .eq("id", courseId)
    .maybeSingle();
  if (courseErr || !courseRow) return unreadable();
  const passRequired = (courseRow as { pass_required?: boolean | null }).pass_required === true;

  const { data: verRows, error: verErr } = await supabase
    .from("course_versions")
    .select("id")
    .eq("course_id", courseId);
  const versionIds = ((verRows ?? []) as Array<{ id: string }>).map((r) => r.id);
  if (verErr || versionIds.length === 0) return unreadable();

  // The learner's own consumed grants on this course (0083 policy "learners
  // read their own attempt requests"): the ids computeScoring takes.
  const { data: grantRows, error: grantErr } = await supabase
    .from("attempt_requests")
    .select("used_attempt_id")
    .eq("user_id", user.id)
    .eq("course_id", courseId)
    .eq("status", "approved")
    .not("used_attempt_id", "is", null);
  if (grantErr) return unreadable();
  const retakeIds = new Set(
    ((grantRows ?? []) as Array<{ used_attempt_id: string | null }>)
      .map((r) => r.used_attempt_id)
      .filter((id): id is string => typeof id === "string")
  );

  // Fail-soft to the default policy, accepted for the continue address's
  // reason (ADR 0019 step 2).
  const policy = await resolvePolicy(supabase, courseId);

  const { data: rows, error: rowsErr } = await readWithOptionalColumn<unknown[]>(
    "is_revision",
    (columns) =>
      supabase
        .from("course_attempts")
        .select(columns)
        .eq("user_id", user.id)
        .in("course_version_id", versionIds),
    ATTEMPT_COLUMNS
  );
  if (rowsErr) return unreadable();
  const attempts = (rows ?? []) as ScorableAttempt[];
  const scoring = computeScoring(attempts, policy, retakeIds);
  return answer({ stored: officialResultStored(scoring, attempts, passRequired) }, 200);
}
