/**
 * SCORM 1.2 CMI data model - flat key-value (string keys, string values).
 * We don't enforce the full schema; the course can read/write any key it
 * wants and we persist it. The fields we DO care about are extracted
 * server-side to update the attempt's status and score columns.
 */
export type CmiData = Record<string, string>;

export type CompletionStatus = "in_progress" | "completed";
export type SuccessStatus = "unknown" | "passed" | "failed";

/**
 * Legacy single-axis status, kept for UI convenience. Derived from the two
 * cleaner axes (completion_status, success_status) below.
 */
export type AttemptStatus = "in_progress" | "completed" | "passed" | "failed";

/**
 * Did the learner reach the end of the course?
 *   - completed: LMSFinish was called OR cmi.core.lesson_status is terminal
 *   - in_progress: still ongoing
 */
export function deriveCompletionStatus(
  cmi: CmiData,
  finished: boolean
): CompletionStatus {
  const s = (cmi["cmi.core.lesson_status"] || "").toLowerCase().trim();
  if (s === "passed" || s === "failed" || s === "completed") return "completed";
  // The SCO explicitly said it is NOT done — an exit (LMSFinish) must never
  // turn "incomplete" / "browsed" / "not attempted" into a completion.
  if (s === "incomplete" || s === "browsed" || s === "not attempted") {
    return "in_progress";
  }
  // SCORM 1.2 RTE: a SCO that never sets lesson_status is treated as
  // completed by the LMS when it finishes (legacy content that doesn't track).
  if (finished) return "completed";
  return "in_progress";
}

/**
 * Did the learner pass the assessment?
 *   - Trust SCORM's lesson_status if it explicitly says passed/failed.
 *   - Otherwise, if score >= mastery threshold => passed; else => failed.
 *   - If we don't have enough info yet => unknown.
 */
export function deriveSuccessStatus(
  cmi: CmiData,
  finished: boolean,
  masteryScore: number | null | undefined
): SuccessStatus {
  const s = (cmi["cmi.core.lesson_status"] || "").toLowerCase();
  if (s === "passed") return "passed";
  if (s === "failed") return "failed";

  if (!finished) return "unknown";

  const score = deriveScore(cmi);
  if (score !== null && typeof masteryScore === "number") {
    return score >= masteryScore ? "passed" : "failed";
  }
  return "unknown";
}

/**
 * Legacy combined status. completion + success collapsed into one value
 * for callers (sidebar badges, lists) that only render a single label.
 */
export function deriveAttemptStatus(
  cmi: CmiData,
  finished: boolean,
  masteryScore?: number | null
): AttemptStatus {
  const completion = deriveCompletionStatus(cmi, finished);
  const success = deriveSuccessStatus(cmi, finished, masteryScore);

  if (success === "passed") return "passed";
  if (success === "failed") return "failed";
  if (completion === "completed") return "completed";
  return "in_progress";
}

/**
 * ADR 0010: the SCORM commit route writes only SCORM attempts. SCORM 2004 is
 * not supported (docs/ARCHITECTURE.md §1), so "a SCORM attempt" is exactly a
 * version whose `course_versions.manifest_type` is the string "scorm12".
 * cmi5 and xAPI attempts are written at runtime only by the token-bound xAPI
 * statements and State routes.
 */
export function isScormRuntime(manifestType: string | null | undefined): boolean {
  return manifestType === "scorm12";
}

export type CommitRuntimeRefusal =
  | { status: 409; error: "wrong_runtime"; manifest_type: string; message: string }
  | { status: 503; error: "attempt_unreadable"; message: string };

/**
 * The commit route's runtime decision (ADR 0010 step 3; the route does the
 * I/O). `null` = a SCORM attempt, derive and write as before. A known,
 * non-SCORM type is refused with 409 and the type echoed; a type that could
 * not be established (no version embed, an empty value) is 503: nothing may
 * be written without knowing the attempt's runtime.
 */
export function commitRuntimeRefusal(
  manifestType: string | null | undefined
): CommitRuntimeRefusal | null {
  if (isScormRuntime(manifestType)) return null;
  if (typeof manifestType === "string" && manifestType !== "") {
    return {
      status: 409,
      error: "wrong_runtime",
      manifest_type: manifestType,
      message: "This attempt is not a SCORM attempt; its progress is saved through its own runtime.",
    };
  }
  return {
    status: 503,
    error: "attempt_unreadable",
    message: "The attempt could not be read; nothing was saved. Try again.",
  };
}

export function deriveScore(cmi: CmiData): number | null {
  const raw = cmi["cmi.core.score.raw"];
  if (raw === undefined || raw === "") return null;
  const n = parseFloat(raw);
  if (Number.isNaN(n)) return null;
  // SCORM 1.2 score.raw is usually 0-100. Normalize to 0-1 and round to
  // 4 decimal places (0.01 percent precision) so the stored value is
  // readable - JS division like 41.66/100 produces 0.41659999999999997.
  const normalized = n > 1 ? n / 100 : n;
  return Math.round(normalized * 10000) / 10000;
}
