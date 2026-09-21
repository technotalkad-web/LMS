import { VERBS, type XapiStatement } from "./types";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Inspect a single xAPI statement and update the bound attempt's
 * completion_status / success_status / score accordingly. Mirrors the
 * "never downgrade" semantics of the SCORM commit route.
 *
 * COMPLETION CRITERIA (cmi5): only a completed / passed / failed statement
 * about the AU ITSELF counts. Authoring tools also emit per-screen
 * statements ("completed" slide 1, "experienced" slide 16 …) about
 * sub-activities; those never decide the module's completion — treating
 * them as such marked modules complete seconds after launch. The AU is
 * identified by the ids the LMS launched it with (manifest auId, the
 * course id some packages use instead, or the version urn fallback).
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

  // Read current attempt state (+ the launched AU's identity) so we can
  // apply non-downgrade rules and scope completion to the AU.
  const { data: row, error: readErr } = await supabase
    .from("course_attempts")
    .select(
      "completion_status, success_status, status, completed_at, score, course_version_id, course_versions(id, manifest_data)"
    )
    .eq("id", attemptId)
    .maybeSingle();
  // Distinguish a real query error from "no such attempt". On error we must NOT
  // silently swallow it — that previously dropped cmi5/xAPI completions on a
  // transient read failure. Throw so the route surfaces/logs it (the AU retries).
  if (readErr) {
    throw new Error(
      `processStatement: failed to load attempt ${attemptId}: ${readErr.message}`
    );
  }
  if (!row) return null;

  const version = Array.isArray(row.course_versions)
    ? row.course_versions[0]
    : row.course_versions;
  const auIds = launchedActivityIds(
    (version as { id?: string; manifest_data?: unknown } | null) ?? null,
    row.course_version_id as string
  );
  const aboutAu = isAboutAu(statement, auIds);

  const update: Record<string, unknown> = {};
  const outcomeVerbs: string[] = [VERBS.completed, VERBS.passed, VERBS.failed];
  const isOutcome = outcomeVerbs.includes(verbId);

  if (isOutcome && !aboutAu) {
    // Sub-activity outcome (a slide, a question block): activity signal only.
    console.warn(
      `[xapi] ignored ${verbId.split("/").pop()} for non-AU object ${
        statement.object?.id ?? "(none)"
      } on attempt ${attemptId}`
    );
  }

  // Completion side — AU-level outcomes only.
  if (isOutcome && aboutAu && row.completion_status !== "completed") {
    update.completion_status = "completed";
  }

  // Success side — AU-level outcomes only.
  if (aboutAu && verbId === VERBS.passed && row.success_status !== "passed") {
    update.success_status = "passed";
  } else if (
    aboutAu &&
    verbId === VERBS.failed &&
    row.success_status !== "passed" // don't downgrade a previous passed
  ) {
    update.success_status = "failed";
  }

  // Score: result.score.scaled is 0..1 in cmi5. Only the AU's own result
  // counts — a per-question scaled score must not become the module score.
  const scaled = statement.result?.score?.scaled;
  if (aboutAu && typeof scaled === "number" && !Number.isNaN(scaled)) {
    const rounded = Math.round(scaled * 10000) / 10000;
    if (row.score === null || row.score === undefined || rounded > row.score) {
      update.score = rounded;
    }
  }

  // completed_at marks WHEN completion happened — stamped only when the
  // attempt is (or just became) complete. A plain terminated/exit never
  // stamps it: an incomplete attempt has no completion time.
  const nowComplete =
    (update.completion_status as string | undefined) === "completed" ||
    row.completion_status === "completed";
  if (!row.completed_at && nowComplete && (isOutcome || verbId === VERBS.terminated)) {
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

  // Every statement counts as learning activity (streaks / "most active") —
  // stamp unconditionally, so the update below always runs.
  update.last_activity_at = new Date().toISOString();

  const { error: updErr } = await supabase
    .from("course_attempts")
    .update(update)
    .eq("id", attemptId);
  if (updErr) {
    throw new Error(
      `processStatement: failed to update attempt ${attemptId}: ${updErr.message}`
    );
  }
  return update;
}

/** Normalized activity id: trim, drop trailing slashes, case-insensitive. */
export function normalizeActivityId(id: string | undefined | null): string {
  return (id ?? "").trim().replace(/\/+$/, "").toLowerCase();
}

/**
 * The ids under which this attempt's AU was launched — mirrors the launch
 * page's `activityId` choice (manifest auId → courseId → urn:uuid:version)
 * and also accepts the manifest course id, which some tools use for their
 * cmi5-defined statements instead of the AU id.
 */
export function launchedActivityIds(
  version: { id?: string; manifest_data?: unknown } | null,
  versionId: string
): string[] {
  const raw =
    ((version?.manifest_data as { raw?: Record<string, unknown> } | undefined)?.raw ??
      {}) as Record<string, unknown>;
  const ids = [raw.auId, raw.courseId, `urn:uuid:${version?.id ?? versionId}`]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map(normalizeActivityId);
  return [...new Set(ids)];
}

/** Is this statement about the AU (not one of its screens/questions)? */
export function isAboutAu(statement: XapiStatement, auIds: string[]): boolean {
  const object = statement.object as { id?: string; objectType?: string } | undefined;
  if (object?.objectType && object.objectType !== "Activity") return false;
  const oid = normalizeActivityId(object?.id);
  if (!oid) return false;
  return auIds.includes(oid);
}
