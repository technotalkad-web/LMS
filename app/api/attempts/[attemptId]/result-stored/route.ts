import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { readWithOptionalColumn } from "@/lib/scoring/attempt-kind";
import { readContextResult } from "@/lib/scoring/context-read";
import { contextKindOfKey } from "@/lib/scoring/context";
import { resolvedStepRule } from "@/lib/paths/progress";
import { readPathStepFacts } from "@/lib/paths/facts-read";
import { isUuid, pathStepDone, waitRead } from "@/lib/learner/continue";

/**
 *   GET /api/attempts/{attemptId}/result-stored
 *   → 200 { stored: boolean }
 *
 * The launch bar's Continue state (ADR 0019, note of 2026-11-11): whether the
 * official result of the attempt's course is stored, with its verdict on a
 * pass-required step. The bar asks while Continue waits (a poll on cmi5 and
 * xAPI launches, one check after a terminal SCORM commit, a tap) and turns
 * Continue active on `{ stored: true }`.
 *
 * Learner-owned and read-only: the caller's session (the cookie-bound client),
 * the learner's own attempt rows only (`user_id = user.id`, under the
 * "members read own attempts" select policy), no service role, no write.
 * The answer is the continue address's own conclude test
 * (officialResultStored) over the continue address's own strict read, so
 * the bar and the address never disagree.
 *
 * ADR 0024 step 27 (P2-7): the route scores the attempt's own context only.
 * The attempt's context_key (a 0107 column, read through the narrower-select
 * fallback) names the context, and readContextResult reads the learner's rows
 * of that context and the course's grants, each read with its own abort
 * signal; rows of another context (the Individual one, another path, a
 * journey day, a Preview) never answer `stored`. The rule is the context's
 * resolved rule: for a path attempt the step's own pass_required, else the
 * course's (step 8), as the continue address reads it. On a database without
 * 0107 the attempt carries no key and the read is `individual`, which
 * readContextResult answers with today's undivided rows of the course.
 *
 * The answer is the continue address's: waitRead's `stored` answers true and
 * `not_stored` false. On `verdict_pending` (a pass-required step completed
 * without its pass or fail yet), a path attempt answers whether the path
 * rule already makes the step done (pathStepDone: an earlier pass, D14, or,
 * read only then, the step's stored fact), because no verdict can undo that
 * and the continue address moves such a learner on (the P2-7 review, F1);
 * any other attempt answers false. A failed facts read is 503. Without 0107
 * the key is `individual` and this case answers false, as before.
 *
 * `{ stored: false }` without scoring (the result would turn Continue on
 * toward content the learner may not open, or is no official result):
 *   - a Preview's attempt: a Preview has no Continue and is never an official
 *     result (P2-5); its context is read by Preview Reports only;
 *   - the attempt's course is inactive, or, for a path attempt, its path is
 *     inactive or not readable (O5-d: the answer never turns Continue on
 *     toward inactive content). Whether the NEXT step is shown is the
 *     continue address's call; this answer does not look at it (P2-Q1).
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
const OWN_COLUMNS = "id, course_version_id, learning_path_id, course_versions(course_id)";

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

  // The learner's own attempt, its course and its context.
  const { data: own, error: ownErr } = await readWithOptionalColumn<Record<string, unknown>>(
    "context_key",
    (columns) =>
      supabase
        .from("course_attempts")
        .select(columns)
        .eq("id", attemptId)
        .eq("user_id", user.id)
        .maybeSingle(),
    OWN_COLUMNS
  );
  if (ownErr) return unreadable();
  if (!own) return answer({}, 404);
  const embed = (own as { course_versions?: { course_id?: string | null } | Array<{ course_id?: string | null }> | null })
    .course_versions;
  const courseId = (Array.isArray(embed) ? embed[0]?.course_id : embed?.course_id) ?? null;
  if (typeof courseId !== "string") return unreadable();
  const ownKey = typeof own.context_key === "string" && own.context_key !== "" ? own.context_key : null;
  const key = ownKey ?? "individual";
  const kind = contextKindOfKey(key);
  if (kind === "preview") return answer({ stored: false }, 200);
  // The path the attempt belongs to: its key's, or, on a database without
  // 0107, its tag (the path's activity is still checked there).
  const tag = typeof own.learning_path_id === "string" ? own.learning_path_id : null;
  const pathId = kind === "path" ? key.slice("path:".length) : ownKey === null ? tag : null;

  // The continue address's strict reads, in its shape: an error is never read
  // as "not required" or "no grants".
  const { data: courseRow, error: courseErr } = await supabase
    .from("courses")
    .select("pass_required, is_active")
    .eq("id", courseId)
    .maybeSingle();
  if (courseErr || !courseRow) return unreadable();
  const course = courseRow as { pass_required?: boolean | null; is_active?: boolean | null };
  if (course.is_active !== true) return answer({ stored: false }, 200);

  let stepRule: boolean | null = null;
  let stepNumber: number | null = null;
  if (pathId !== null) {
    const { data: pathRow, error: pathErr } = await supabase
      .from("learning_paths")
      .select("is_active")
      .eq("id", pathId)
      .maybeSingle();
    if (pathErr) return unreadable();
    if (!pathRow || (pathRow as { is_active?: boolean | null }).is_active === false) return answer({ stored: false }, 200);
    const { data: stepRow, error: stepErr } = await readWithOptionalColumn<Record<string, unknown>>(
      "pass_required",
      (columns) =>
        supabase
          .from("learning_path_courses")
          .select(columns)
          .eq("path_id", pathId)
          .eq("course_id", courseId)
          .maybeSingle(),
      "course_id, step_number"
    );
    if (stepErr) return unreadable();
    stepRule = typeof stepRow?.pass_required === "boolean" ? stepRow.pass_required : null;
    stepNumber = typeof stepRow?.step_number === "number" ? stepRow.step_number : null;
  }
  const passRequired = resolvedStepRule(stepRule, course.pass_required);

  const { data: verRows, error: verErr } = await supabase
    .from("course_versions")
    .select("id")
    .eq("course_id", courseId);
  const versionIds = ((verRows ?? []) as Array<{ id: string }>).map((r) => r.id);
  if (verErr || versionIds.length === 0) return unreadable();

  const read = await readContextResult(supabase, { userId: user.id, courseId, key, passRequired, versionIds });
  if (!read.ok) return unreadable();
  const w = waitRead(read.result.scoring, read.result.rows, passRequired);
  if (w !== "verdict_pending" || kind !== "path" || pathId === null || stepNumber === null) {
    return answer({ stored: w === "stored" }, 200);
  }
  // The verdict is pending on a path step: stored when the path rule already
  // makes the step done (the continue address's own test, F1).
  const step = await pathStepDone({
    pathId,
    step: { course_id: courseId, step_number: stepNumber, release_at: null, pass_required: passRequired },
    attempts: read.result.rows,
    grants: read.grants,
    now: new Date().toISOString(),
    loadFacts: () => readPathStepFacts(supabase, user.id, [pathId]),
  });
  if (!step.ok) return unreadable();
  return answer({ stored: step.done }, 200);
}
