import { VERBS, type XapiStatement } from "./types";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Inspect a single xAPI statement and update the bound attempt's
 * completion_status / success_status / score accordingly. Mirrors the
 * "never downgrade" semantics of the SCORM commit route.
 *
 * Returns the delta we wrote (for logging / debugging) or null if the
 * statement was a no-op.
 */
export async function processStatement(opts: {
  statement: XapiStatement;
  attemptId: string;
  supabase: SupabaseClient;
}) {
  const { statement, attemptId, supabase } = opts;
  const verbId = statement.verb?.id;
  if (!verbId) return null;

  // Read current attempt state so we can apply non-downgrade rules.
  const { data: row } = await supabase
    .from("course_attempts")
    .select("completion_status, success_status, status, completed_at, score")
    .eq("id", attemptId)
    .maybeSingle();
  if (!row) return null;

  const update: Record<string, unknown> = {};

  // Completion side
  const completionVerbs: string[] = [VERBS.completed, VERBS.passed, VERBS.failed];
  if (completionVerbs.includes(verbId) && row.completion_status !== "completed") {
    update.completion_status = "completed";
  }

  // Success side
  if (verbId === VERBS.passed && row.success_status !== "passed") {
    update.success_status = "passed";
  } else if (
    verbId === VERBS.failed &&
    row.success_status !== "passed" // don't downgrade a previous passed
  ) {
    update.success_status = "failed";
  }

  // Score: result.score.scaled is 0..1 in cmi5
  const scaled = statement.result?.score?.scaled;
  if (typeof scaled === "number" && !Number.isNaN(scaled)) {
    const rounded = Math.round(scaled * 10000) / 10000;
    if (row.score === null || row.score === undefined || rounded > row.score) {
      update.score = rounded;
    }
  }

  // Terminated / completed verbs stamp completed_at if not already set.
  const terminalVerbs: string[] = [
    VERBS.completed,
    VERBS.passed,
    VERBS.failed,
    VERBS.terminated,
  ];
  if (!row.completed_at && terminalVerbs.includes(verbId)) {
    update.completed_at = new Date().toISOString();
  }

  // Recompute legacy combined `status` from the (possibly updated) axes.
  const newCompletion =
    (update.completion_status as string | undefined) ?? row.completion_status;
  const newSuccess =
    (update.success_status as string | undefined) ?? row.success_status;
  let derivedStatus: string;
  if (newSuccess === "passed") derivedStatus = "passed";
  else if (newSuccess === "failed") derivedStatus = "failed";
  else if (newCompletion === "completed") derivedStatus = "completed";
  else derivedStatus = "in_progress";

  if (derivedStatus !== row.status) update.status = derivedStatus;

  if (Object.keys(update).length === 0) return null;

  await supabase.from("course_attempts").update(update).eq("id", attemptId);
  return update;
}
