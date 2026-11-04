/**
 * The revision seed's contents (ADR 0014 step 3, "Seed, keyed on the row",
 * and "SCORM runtime"), as pure functions the launch page applies on every
 * launch whose resolved row is a revision visit's. The source is always the
 * learner's OFFICIAL attempt (scoring.officialAttempt), whatever version or
 * language slot the revision row is on: a revisit shows the official
 * attempt's progress, answers and result, which no revisit can touch.
 *
 * Deliberately free of next/* and Supabase runtime imports so unit tests can
 * load it.
 */
import type { CmiData } from "@/lib/scorm/types";

/** The SCORM 1.2 keys copied from the official attempt when present. */
export const REVISION_CMI_COPIED_KEYS = [
  "cmi.suspend_data",
  "cmi.core.lesson_location",
  "cmi.core.lesson_status",
  "cmi.core.score.raw",
  "cmi.core.score.min",
  "cmi.core.score.max",
] as const;

/**
 * SCORM: the served `cmi` and the revision row's `cmi_data`, rebuilt from
 * the official attempt ALONE (a resumed row would otherwise serve a previous
 * revisit's whole map again): the copied keys, then `entry = resume`,
 * `lesson_mode = review` and `credit = no-credit` always. The SCO may still
 * overwrite any key at runtime; the commit route records nothing for a
 * revision row (R-5), whatever it sends.
 */
export function buildRevisionCmi(official: { cmi_data?: CmiData | null } | null | undefined): CmiData {
  const src = (official?.cmi_data ?? {}) as CmiData;
  const out: CmiData = {};
  for (const k of REVISION_CMI_COPIED_KEYS) {
    const v = src[k];
    if (typeof v === "string" && v !== "") out[k] = v;
  }
  out["cmi.core.entry"] = "resume";
  out["cmi.core.lesson_mode"] = "review";
  out["cmi.core.credit"] = "no-credit";
  return out;
}

/** The LMS.OfficialResult State document (LMS-owned; the AU may only GET it). */
export type OfficialResultDocument = {
  status: "passed" | "failed" | "completed" | null;
  /** Integer percent 0–100, rounded exactly as learner-summary rounds it; null without a score. */
  score: number | null;
  completed_at: string | null;
  course_version_id: string | null;
  attempt_id: string | null;
  written_at: string;
};

/**
 * cmi5/xAPI: the official-result document for the revision registration
 * (ADR 0014 step 3). `score` is an integer percent because
 * course_attempts.score is stored 0..1 and the engine reads the document's
 * score as the Results percentage. `course_version_id` and `attempt_id` are
 * the OFFICIAL attempt's, whatever version the revision row is on. Ids, a
 * status, a score and dates only, never a name.
 */
export function buildOfficialResult(i: {
  scoring: {
    officialStatus: "passed" | "failed" | "completed" | null;
    officialScore: number | null;
    officialAttempt: { id: string; completed_at: string | null; course_version_id?: string | null } | null;
  };
  writtenAt: string;
}): OfficialResultDocument {
  const s = i.scoring;
  return {
    status: s.officialStatus,
    score: s.officialScore === null ? null : Math.round(s.officialScore * 100),
    completed_at: s.officialAttempt?.completed_at ?? null,
    course_version_id: s.officialAttempt?.course_version_id ?? null,
    attempt_id: s.officialAttempt?.id ?? null,
    written_at: i.writtenAt,
  };
}
