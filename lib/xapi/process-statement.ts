import { VERBS, type XapiStatement } from "./types";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CMI5_PROGRESS_EXT,
  clampPct,
  ensureUnitCount,
  partialPct,
  updateAttemptFailSoft,
  type VersionLite,
} from "@/lib/courses/progress";

/**
 * Inspect a single xAPI statement and update the bound attempt's
 * completion_status / success_status / score / progress accordingly.
 * Mirrors the "never downgrade" semantics of the SCORM commit route.
 *
 * COMPLETION CRITERIA (cmi5): only a completed / passed / failed statement
 * about the AU ITSELF counts. Authoring tools also emit per-screen
 * statements ("completed" slide 1, "experienced" slide 16 …) about
 * sub-activities; those never decide the module's completion — treating
 * them as such marked modules complete seconds after launch. The AU is
 * identified by the ids the LMS launched it with (manifest auId, the
 * course id some packages use instead, or the version urn fallback).
 *
 * PROGRESS (0075) is a separate axis: sub-activity statements advance it
 * (screens completed ÷ the module's unit count), the cmi5 `progress`
 * result extension sets it directly, and AU completion makes it 100.
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
  // apply non-downgrade rules and scope completion to the AU. select("*")
  // keeps this deploy-safe across attempt-column migrations (0075).
  const { data: row, error: readErr } = await supabase
    .from("course_attempts")
    .select("*, course_versions(id, manifest_data, launch_url, storage_prefix)")
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
  const r = row as Record<string, unknown> & {
    completion_status: string;
    success_status: string;
    status: string;
    completed_at: string | null;
    score: number | null;
    course_version_id: string;
  };

  const version = (Array.isArray(r.course_versions)
    ? r.course_versions[0]
    : r.course_versions) as VersionLite | null;
  const auIds = launchedActivityIds(version, r.course_version_id);
  const aboutAu = isAboutAu(statement, auIds);

  const update: Record<string, unknown> = {};
  const outcomeVerbs: string[] = [VERBS.completed, VERBS.passed, VERBS.failed];
  const isOutcome = outcomeVerbs.includes(verbId);

  if (isOutcome && !aboutAu) {
    // Sub-activity outcome (a slide, a question block): progress + activity
    // signal only.
    console.warn(
      `[xapi] ignored ${verbId.split("/").pop()} for non-AU object ${
        statement.object?.id ?? "(none)"
      } on attempt ${attemptId}`
    );
  }

  // Completion side — AU-level outcomes only.
  if (isOutcome && aboutAu && r.completion_status !== "completed") {
    update.completion_status = "completed";
  }

  // Success side — AU-level outcomes only.
  if (aboutAu && verbId === VERBS.passed && r.success_status !== "passed") {
    update.success_status = "passed";
  } else if (
    aboutAu &&
    verbId === VERBS.failed &&
    r.success_status !== "passed" // don't downgrade a previous passed
  ) {
    update.success_status = "failed";
  }

  // Score: result.score.scaled is 0..1 in cmi5. Only the AU's own result
  // counts — a per-question scaled score must not become the module score.
  const scaled = statement.result?.score?.scaled;
  if (aboutAu && typeof scaled === "number" && !Number.isNaN(scaled)) {
    const rounded = Math.round(scaled * 10000) / 10000;
    if (r.score === null || r.score === undefined || rounded > r.score) {
      update.score = rounded;
    }
  }

  // completed_at marks WHEN completion happened — stamped only when the
  // attempt is (or just became) complete. A plain terminated/exit never
  // stamps it: an incomplete attempt has no completion time.
  const nowComplete =
    (update.completion_status as string | undefined) === "completed" ||
    r.completion_status === "completed";
  if (!r.completed_at && nowComplete && (isOutcome || verbId === VERBS.terminated)) {
    update.completed_at = new Date().toISOString();
  }

  // ---- Progress (0075) ----
  const currentPct = typeof r.progress_pct === "number" ? r.progress_pct : null;
  let pct: number | null = null;
  if (nowComplete) {
    pct = 100;
  } else {
    // cmi5 result extension (0–100) on an AU-level statement.
    const ext = (statement.result?.extensions as Record<string, unknown> | undefined)?.[
      CMI5_PROGRESS_EXT
    ];
    if (aboutAu && typeof ext === "number" && Number.isFinite(ext)) {
      pct = Math.min(99, clampPct(ext));
    }
    // Per-screen statements: remember which units this attempt has reached.
    const unitId = unitIdOf(statement, auIds);
    if (unitId) {
      const cmi = ((r.cmi_data ?? {}) as Record<string, unknown>) ?? {};
      const cmi5 = ((cmi.cmi5 ?? {}) as Record<string, unknown>) ?? {};
      const units = { ...((cmi5.units ?? {}) as Record<string, string>) };
      const level =
        verbId === VERBS.completed || verbId === VERBS.passed || verbId === VERBS.failed
          ? "completed"
          : "seen";
      if (units[unitId] !== "completed" && (level === "completed" || !units[unitId])) {
        units[unitId] = level;
        update.cmi_data = { ...cmi, cmi5: { ...cmi5, units } };
      }
      const done = Object.values(units).filter((v) => v === "completed").length;
      if (done > 0) {
        const total = await ensureUnitCount(supabase, version);
        const fromUnits = total ? partialPct(done, total) : null;
        if (fromUnits !== null && (pct === null || fromUnits > pct)) pct = fromUnits;
      }
    }
  }
  if (pct !== null && (currentPct === null || pct > currentPct)) {
    update.progress_pct = pct;
  }

  // Recompute legacy combined `status` from the (possibly updated) axes.
  const newCompletion =
    (update.completion_status as string | undefined) ?? r.completion_status;
  const newSuccess =
    (update.success_status as string | undefined) ?? r.success_status;
  let derivedStatus: string;
  if (newSuccess === "passed") derivedStatus = "passed";
  else if (newSuccess === "failed") derivedStatus = "failed";
  else if (newCompletion === "completed") derivedStatus = "completed";
  else derivedStatus = "in_progress";

  if (derivedStatus !== r.status) update.status = derivedStatus;

  // Every statement counts as learning activity (streaks / "most active") —
  // stamp unconditionally, so the update below always runs.
  update.last_activity_at = new Date().toISOString();

  const updErr = await updateAttemptFailSoft(supabase, attemptId, update);
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

/**
 * The sub-activity ("screen") id when the statement is about something
 * inside the AU — e.g. `<courseId>/12` → "12". Null for the AU itself or
 * for unrelated objects.
 */
export function unitIdOf(statement: XapiStatement, auIds: string[]): string | null {
  const object = statement.object as { id?: string; objectType?: string } | undefined;
  if (object?.objectType && object.objectType !== "Activity") return null;
  const oid = normalizeActivityId(object?.id);
  if (!oid || auIds.includes(oid)) return null;
  // Longest matching parent wins (auId is usually courseId + "/au/1").
  const parents = [...auIds].sort((a, b) => b.length - a.length);
  for (const p of parents) {
    if (oid.startsWith(`${p}/`)) {
      const rest = oid.slice(p.length + 1);
      return rest || null;
    }
  }
  return null;
}
