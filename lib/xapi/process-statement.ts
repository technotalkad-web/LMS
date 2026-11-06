import { VERBS, type XapiStatement } from "./types";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CMI5_PROGRESS_EXT,
  clampPct,
  ensureEngineVersion,
  ensureUnitCount,
  partialPct,
  updateAttemptFailSoft,
  type VersionLite,
} from "@/lib/courses/progress";
import { AttemptAbandonedError } from "@/lib/attempts/abandon";
import { CMI5_SESSION_EXT, auActivityId } from "@/lib/alds/types";
import { OUTCOME_FINAL_FLOOR, outcomeFinalVerdict } from "@/lib/courses/engine-version";
import {
  mergeIgnoredResult,
  newIgnoredRecord,
  readIgnoredRecord,
  type IgnoredEntry,
  type IgnoredRecord,
} from "./ignored-pass";

/**
 * The attempt's version as the read below embeds it: VersionLite plus the
 * package id, from which the LMS-issued AU id is derived (ADR 0006 note (d)
 * of 2026-10-19). Local on purpose: lib/courses/progress.ts is not edited.
 */
type LaunchedVersion = VersionLite & { package_id?: string | null; manifest_type?: string | null };

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
 * tincan.xml activity id for standalone xAPI packages, the course id some
 * packages use instead, or the version urn fallback).
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
    .select("*, course_versions(id, manifest_data, manifest_type, launch_url, storage_prefix, storage_driver, package_id)")
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
  // ALDS step 0 (P4): abandoned is terminal. Never derive a status for it
  // (that is exactly how stale tabs revived abandoned attempts); the
  // statements route answers 410.
  if (r.status === "abandoned") throw new AttemptAbandonedError(attemptId);

  // ADR 0014 step 4, rule R-5: a revision visit's row records nothing. It
  // never derives completion, success, score, completed_at or progress;
  // only last_activity_at is stamped (conditional on status <> 'abandoned',
  // as every write here). `select("*")` above: undefined on a database
  // without 0103, so the row derives as before.
  if (r.is_revision === true) {
    const revErr = await updateAttemptFailSoft(supabase, attemptId, { last_activity_at: new Date().toISOString() });
    if (revErr?.abandoned) throw new AttemptAbandonedError(attemptId);
    if (revErr) {
      throw new Error(`processStatement: failed to update attempt ${attemptId}: ${revErr.message}`);
    }
    return null;
  }

  const version = (Array.isArray(r.course_versions)
    ? r.course_versions[0]
    : r.course_versions) as LaunchedVersion | null;
  const auIds = launchedActivityIds(version, r.course_version_id);
  const aboutAu = isAboutAu(statement, auIds);

  const scaled = statement.result?.score?.scaled;
  const roundedScore = typeof scaled === "number" && !Number.isNaN(scaled) ? Math.round(scaled * 10000) / 10000 : null;

  // ADR 0017 step 8: a final fail from the new engine never becomes passed in
  // this row. The guard is keyed on the row (step 7) and answers whether this
  // statement's result is held, and what to write on the row's record.
  const guard =
    aboutAu && r.success_status === "failed"
      ? await newEngineGuard({ statement, verbId, roundedScore, row: r, version, attemptId, auIds, supabase })
      : NOT_HELD;

  const update: Record<string, unknown> = {};
  if (guard.record) update.ignored_pass = guard.record;
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
  if (guard.held) {
    // Held: success_status, score and status stay as the final fail left them.
  } else if (aboutAu && verbId === VERBS.passed && r.success_status !== "passed") {
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
  if (!guard.held && aboutAu && roundedScore !== null) {
    if (r.score === null || r.score === undefined || roundedScore > r.score) {
      update.score = roundedScore;
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

  // Conditional on status <> 'abandoned' (P4): abandoned in between → 410.
  const updErr = await updateAttemptFailSoft(supabase, attemptId, update);
  if (updErr?.abandoned) throw new AttemptAbandonedError(attemptId);
  if (updErr) {
    throw new Error(
      `processStatement: failed to update attempt ${attemptId}: ${updErr.message}`
    );
  }
  return update;
}

const NOT_HELD: { held: boolean; record: IgnoredRecord | null } = { held: false, record: null };

function sessionIdOf(statement: XapiStatement): string | undefined {
  const extensions = statement.context?.extensions as Record<string, unknown> | undefined;
  const id = extensions?.[CMI5_SESSION_EXT];
  return typeof id === "string" && id ? id : undefined;
}

/**
 * A string of the received statement the record may keep. Postgres refuses a NUL in
 * jsonb, so a hand-made value would fail the record's write and the POST on every
 * resend, where the row's update without the record carries no such string.
 */
function withoutNul(s: unknown): string | undefined {
  return typeof s === "string" && s && !s.includes("\u0000") ? s : undefined;
}

/** The attempt's first stored AU-level `failed`, or null. A failed read is treated as not found: fail-soft. */
async function findFailingStatement(supabase: SupabaseClient, attemptId: string, auIds: string[]) {
  try {
    const { data, error } = await supabase
      .from("xapi_statements")
      .select("statement_id, raw")
      .eq("attempt_id", attemptId)
      .eq("verb", VERBS.failed)
      .order("stored", { ascending: true })
      // Up to 20 rows, because assessment run summaries also carry `failed` about a sub-activity.
      .limit(20);
    if (error) return null;
    for (const stored of (data ?? []) as Array<{ statement_id: string; raw: XapiStatement }>) {
      if (isAboutAu(stored.raw, auIds)) {
        const sessionId = sessionIdOf(stored.raw);
        return {
          statement_id: stored.statement_id,
          ...(stored.raw.timestamp ? { timestamp: stored.raw.timestamp } : {}),
          ...(sessionId ? { session_id: sessionId } : {}),
        };
      }
    }
  } catch {
    /* fail-soft: the record carries no ids */
  }
  return null;
}

/**
 * ADR 0017 steps 6, 8 and 12, on an AU-level statement about a `failed` row. A
 * statement is held when it is a `passed` or carries a score other than the row's.
 * Only a `final` verdict holds. A statement carrying the failing statement's id
 * with another score is held and records nothing: step 1 says the score does not
 * move, and step 8 (ii) says it gets no entry, because the engine re-sends the
 * failing pair with the same ids after a network error and that retry must raise
 * no item. When its score is above the row's it logs one line of ids, a trace of a
 * hand-made statement or of the double fault; a genuine retry carries the row's own
 * score or one below it and stays silent. Every other verdict keeps today's one-time
 * upgrade; when a `passed` is upgraded it is logged, and the two verdicts under which
 * a stamp may exist and could not be read also go on the row. The failing-statement
 * lookup runs only on a held result, or on an upgrade that writes an applied entry.
 */
async function newEngineGuard(i: {
  statement: XapiStatement;
  verbId: string;
  roundedScore: number | null;
  row: { score: number | null; completed_at: string | null; course_version_id: string; ignored_pass?: unknown };
  version: LaunchedVersion | null;
  attemptId: string;
  auIds: string[];
  supabase: SupabaseClient;
}): Promise<{ held: boolean; record: IgnoredRecord | null }> {
  const { statement, verbId, roundedScore, row, version, attemptId, auIds, supabase } = i;
  const isPass = verbId === VERBS.passed;
  if (!isPass && (roundedScore === null || roundedScore === row.score)) return NOT_HELD;

  const read = await ensureEngineVersion(supabase, version);
  const verdict = outcomeFinalVerdict({ stamp: read.stamp, readError: read.error });
  const runtime = version?.manifest_type === "xapi" ? "xapi" : "cmi5";
  const statementId = statement.id ?? null;

  if (verdict !== "final" && !isPass) return NOT_HELD;
  if (verdict !== "final") {
    console.warn(
      JSON.stringify({
        event: "pass_upgraded",
        attempt_id: attemptId,
        statement_id: statementId,
        runtime,
        engine_version: read.stamp,
        reason: verdict,
        ...(read.error ? { error: read.error } : {}),
      })
    );
    if (verdict !== "unknown" && verdict !== "unreadable") return NOT_HELD;
  }

  const failing = await findFailingStatement(supabase, attemptId, auIds);
  if (!isPass && failing && failing.statement_id === statement.id) {
    if (typeof row.score !== "number" || roundedScore! > row.score) {
      console.warn(
        JSON.stringify({
          event: "result_ignored",
          attempt_id: attemptId,
          statement_id: statementId,
          runtime,
          engine_version: read.stamp,
          failing_id: true,
        })
      );
    }
    return { held: true, record: null };
  }

  const sessionId = withoutNul(sessionIdOf(statement));
  const timestamp = withoutNul(statement.timestamp);
  const shortVerb = verbId.split("/").pop() ?? verbId;
  const entry: IgnoredEntry = {
    // A foreign verb that merely ends in "passed" is not an ignored pass.
    verb: isPass || shortVerb !== "passed" ? shortVerb : verbId,
    received_at: new Date().toISOString(),
    score: roundedScore,
    ...(timestamp ? { timestamp } : {}),
    ...(sessionId ? { session_id: sessionId } : {}),
    same_session: runtime === "cmi5" && sessionId && failing?.session_id ? sessionId === failing.session_id : null,
  };
  const existing =
    readIgnoredRecord(row.ignored_pass) ??
    newIgnoredRecord({
      runtime,
      course_version_id: row.course_version_id,
      engine_version: read.stamp,
      floor: OUTCOME_FINAL_FLOOR,
      failed: { at: row.completed_at, score: row.score, ...(failing ?? {}) },
    });

  if (verdict !== "final") {
    // The upgrade applied because the engine version could not be read. Never
    // counted, and with no statement id: the statement was applied.
    const { record, changed } = mergeIgnoredResult(existing, {
      ...entry,
      verb: "passed",
      applied: true,
      reason: verdict === "unknown" ? "unknown" : "unreadable",
      ...(read.error ? { error: read.error } : {}),
    });
    return { held: false, record: changed ? record : null };
  }

  const { record, changed, capped } = mergeIgnoredResult(existing, { ...entry, ...(statement.id ? { statement_id: statement.id } : {}) });
  if (changed || capped) {
    console.warn(
      JSON.stringify({
        event: isPass ? "pass_ignored" : "result_ignored",
        attempt_id: attemptId,
        statement_id: statementId,
        runtime,
        engine_version: read.stamp,
        ...(isPass ? {} : { verb: entry.verb }),
        ...(capped ? { capped } : {}),
      })
    );
  }
  return { held: true, record: changed ? record : null };
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
 *
 * ADR 0006 step 17 / note (d) of 2026-10-19: when the version has a
 * package, the LMS-issued AU id (BLUEPRINT §1.2) is accepted too, in every
 * deploy and whatever ALDS_P4 says (only SENDING it is flag-gated, on the
 * launch page). Additive: the publisher ids stay in the list.
 */
export function launchedActivityIds(
  version: { id?: string; manifest_data?: unknown; package_id?: string | null } | null,
  versionId: string
): string[] {
  const raw =
    ((version?.manifest_data as { raw?: Record<string, unknown> } | undefined)?.raw ??
      {}) as Record<string, unknown>;
  const lmsAuId =
    typeof version?.package_id === "string" && version.package_id ? auActivityId(version.package_id) : null;
  const ids = [raw.auId, raw.activityId, raw.courseId, `urn:uuid:${version?.id ?? versionId}`, lmsAuId]
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
