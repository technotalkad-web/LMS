/**
 * ADR 0006 §C launch contract, LMS side (steps 16–17; ADR 0006 notes (b)–(e)
 * of 2026-10-19; BLUEPRINT §1.2, §1.3, §4, §10.4).
 *
 * Pure helpers plus two service-client writers. Server-only (imports the
 * flag module); never imported from lib/alds/rules/ or lib/alds/types.ts,
 * which stay the frozen, hashed rules tree.
 *
 * Everything here runs only behind ALDS_P4 (lib/alds/flag.ts) except
 * isLaunchDataStateId(), which the State route's read-only guard uses
 * unconditionally (cmi5 §10.1: LMS.LaunchData and, from ADR 0014,
 * LMS.OfficialResult are LMS-owned), launchModeFor(), whose isPreview
 * the launch page also reads outside the flag to decide the revision visit
 * record and the bar's preview line (ADR 0014 step 3: a preview records no
 * visit), and previewAttemptColumns(), the 0100 columns of a Preview by mode
 * (ADR 0024 step 22, P2-5), which every preview insert names whatever the
 * flag: 0107's shape check ties is_preview to context_kind = 'preview'.
 *
 * Privacy: the LaunchData document carries ids and the slot language only
 * (from ADR 0024 step 26 also the launch's context kind and journey day
 * number), never a name or an email.
 *
 * Grading: nothing here is read by scoring, completion, the Report Card,
 * CRM or journeys (ADR 0005 D1). is_preview and launch_mode are written on
 * the attempt row by the launch page; completion keeps deriving from
 * AU-level statements exactly as today.
 */
import { randomUUID } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  auActivityId,
  CMI5_SESSION_EXT,
  courseFamily,
  E,
  EXT,
  type AldsContextTemplate,
  type AldsLaunchData,
  type LaunchMode,
  type RegistrationKind,
} from "@/lib/alds/types";
import { isAldsSchemaMissing, logAldsSkip } from "@/lib/alds/flag";
import {
  LEARNING_SESSIONS_TABLE,
  LMS_LAUNCH_DATA_STATE_ID,
  LMS_OFFICIAL_RESULT_STATE_ID,
} from "@/lib/alds/rpc";
/** The launch's `?mode=` parameter as the launch page reads it: `preview`, or none. */
export type LaunchModeParam = "preview" | null;

/** The LMS-issued AU id of a package (BLUEPRINT §1.2; one AU per package, U7). */
export function lmsAuActivityId(packageId: string): string {
  return auActivityId(packageId);
}

/**
 * The launch mode, decided by the launch's mode and the row (ADR 0024 step
 * 23 and P2-5 item 1, the owner's R6 answer of 2026-11-13; ADR 0014 step 3,
 * "Row-driven decisions"): `?mode=preview` is a preview in `Normal`
 * (decision A32), so the module behaves as it does for a learner; without
 * the mode every role is a learner with a real row, and a revision visit's
 * row (is_revision) is `Review`, else `Normal`. The role decides nothing
 * here: who may preview is the launch-context resolver's preview row
 * (canViewReports). No grading code reads the mode: every gate reads
 * is_revision and context_kind.
 */
export function launchModeFor(i: { mode: LaunchModeParam; revision: boolean }): { isPreview: boolean; launchMode: LaunchMode } {
  if (i.mode === "preview") return { isPreview: true, launchMode: "Normal" };
  return { isPreview: false, launchMode: i.revision ? "Review" : "Normal" };
}

/**
 * The three 0100 columns of a Start's attempt row (ADR 0006 note (c); ADR
 * 0014 step 3), for the launch page's insert and for its update after
 * consume_grant opens a retake. Only with ALDS_P4 on: the page calls it
 * under `p4`. A Start is never a preview (ADR 0024 step 23: without the mode
 * every role is a learner), so is_preview is false and the mode follows the
 * row; a preview's row names previewAttemptColumns instead. The attempt
 * column stores the raw slot language (null when unlabeled), never the
 * LaunchData "und".
 */
export function p4AttemptColumns(i: { revision: boolean; language: string | null | undefined }): {
  served_language: string | null;
  launch_mode: LaunchMode;
  is_preview: boolean;
} {
  const mode = launchModeFor({ mode: null, revision: i.revision });
  return {
    served_language: attemptServedLanguage(i.language),
    launch_mode: mode.launchMode,
    is_preview: mode.isPreview,
  };
}

/**
 * The 0100 columns of a Preview by mode's row (ADR 0024 step 22's preview
 * row, P2-5 item 3): is_preview true and launch_mode `Normal` (decision
 * A32), with the slot language as p4AttemptColumns stores it. Not behind
 * ALDS_P4: the preview insert also names context_kind = 'preview' and
 * preview_kind (0107), whose shape check requires is_preview on that row,
 * and a database with 0107 has 0100. The page names context_kind and
 * preview_kind on the insert itself.
 */
export function previewAttemptColumns(i: { language: string | null | undefined }): {
  served_language: string | null;
  launch_mode: LaunchMode;
  is_preview: true;
} {
  const mode = launchModeFor({ mode: "preview", revision: false });
  return {
    served_language: attemptServedLanguage(i.language),
    launch_mode: mode.launchMode,
    is_preview: true,
  };
}

/**
 * registration/kind (ADR 0006 notes (b) and (h)): grant_retake when a grant
 * is consumed on this launch or the attempt (= the registration) is a grant
 * retake by its row's link (attempt_requests.used_attempt_id), so a relaunch
 * of an in-progress grant retake keeps its kind; retake when the row is a
 * revision visit's (ADR 0014 step 3: a flagged row stays `retake`), else
 * enrollment.
 */
export function registrationKindFor(i: {
  consumeGrantId: string | null;
  /** The launched row is a revision visit's (course_attempts.is_revision). */
  revision: boolean;
  /** The launched attempt is a consumed grant's retake (the launch's grant snapshot). */
  attemptIsGrantRetake: boolean;
}): RegistrationKind {
  if (i.consumeGrantId || i.attemptIsGrantRetake) return "grant_retake";
  if (i.revision) return "retake";
  return "enrollment";
}

/**
 * course_attempts.served_language: the slot's BCP 47 tag, or null for the
 * unlabeled legacy slot and a version without a package. One encoding with
 * the 0100 backfill and column comment ("Null = no language slot"); "und" is
 * the LaunchData extension's value only (servedLanguageFor).
 */
export function attemptServedLanguage(language: string | null | undefined): string | null {
  const tag = typeof language === "string" ? language.trim() : "";
  return tag || null;
}

/** The LaunchData content/language value: the slot's BCP 47 tag; "und" (undetermined) for the unlabeled legacy slot. */
export function servedLanguageFor(language: string | null | undefined): string {
  return attemptServedLanguage(language) ?? "und";
}

/**
 * The launch's learning context in LMS.LaunchData (ADR 0024 step 26): three
 * additive context-template extensions. An engine that bases every
 * statement's context on the template, as cmi5 §10.2.1 and the ALDS rule S1
 * require, sends them as it sends the others. Kept here, outside the hashed
 * rules tree: adding them to EXT (lib/alds/types.ts) would move the rules
 * bundle hash. No rule holds a closed list of extension keys: S1 compares
 * only the template keys a statement carries, so a statement without them
 * passes as before. The tenant LRS profile lists the same IRIs
 * (lib/lrs/profile.ts, ext.contextKind, ext.contextId, ext.contextDay).
 */
export const LAUNCH_CONTEXT_EXT = {
  kind: `${E}context/kind`,
  id: `${E}context/id`,
  day: `${E}context/day`,
} as const;

/**
 * The context buildLaunchData stamps: `kind` is the attempt row's
 * context_kind (individual, path, journey or preview); `id` the row's
 * learning_path_id on a path, its journey_enrollment_id on a journey, else
 * null; `day` the row's journey_day (the day number the attempt was launched
 * on) on a journey, else null. Taken from the launched row, whose context
 * columns never change (0107's immutability trigger), so a relaunch writes
 * the same values and rule S1 finds no template value changed.
 */
export type LaunchDataContext = { kind: string; id: string | null; day: number | null };

/**
 * The context extensions of LaunchData: `context/kind` when a kind is given,
 * `context/id` and `context/day` only when they hold a value (an id; a day
 * number of 1 or more), never null. Ids and a number only: no name.
 */
export function launchContextExtensions(c: LaunchDataContext | null | undefined): Record<string, string | number> {
  const kind = typeof c?.kind === "string" ? c.kind.trim() : "";
  if (!c || !kind) return {};
  const out: Record<string, string | number> = { [LAUNCH_CONTEXT_EXT.kind]: kind };
  const id = typeof c.id === "string" ? c.id.trim() : "";
  if (id) out[LAUNCH_CONTEXT_EXT.id] = id;
  if (typeof c.day === "number" && Number.isInteger(c.day) && c.day >= 1) out[LAUNCH_CONTEXT_EXT.day] = c.day;
  return out;
}

/**
 * The cmi5 LMS.LaunchData body (cmi5 §10.1; registration = attempt id, ADR 0002).
 * `context` (ADR 0024 step 26) adds launchContextExtensions after the seven
 * template keys; a call without it builds exactly the document it built before.
 */
export function buildLaunchData(i: {
  attemptId: string;
  packageId: string;
  versionId: string;
  servedLanguage: string;
  launchMode: LaunchMode;
  registrationKind: RegistrationKind;
  sessionId: string;
  publisherCourseId?: string | null;
  courseUlid?: string | null;
  masteryScore?: number | null;
  returnURL?: string | null;
  context?: LaunchDataContext | null;
}): AldsLaunchData {
  // Built apart, then assigned: AldsContextTemplate's extensions type lists the
  // seven keys of the frozen types file, and the context keys are additive.
  const extensions: AldsContextTemplate["extensions"] & Record<string, string | number> = {
    [CMI5_SESSION_EXT]: i.sessionId,
    [EXT.attemptId]: i.attemptId,
    [EXT.registrationKind]: i.registrationKind,
    [EXT.attemptIndex]: 1,
    [EXT.packageId]: i.packageId,
    [EXT.versionId]: i.versionId,
    [EXT.language]: i.servedLanguage,
    ...launchContextExtensions(i.context),
  };
  return {
    contextTemplate: {
      registration: i.attemptId,
      contextActivities: {
        grouping: [
          ...(i.publisherCourseId ? [{ id: i.publisherCourseId }] : []),
          ...(i.courseUlid ? [{ id: courseFamily(i.courseUlid) }] : []),
        ],
      },
      extensions,
    },
    launchMode: i.launchMode,
    moveOn: "CompletedOrPassed",
    ...(typeof i.masteryScore === "number" ? { masteryScore: i.masteryScore } : {}),
    ...(i.returnURL ? { returnURL: i.returnURL } : {}),
  };
}

/**
 * Upsert the LMS.LaunchData State document of an attempt (service client;
 * the 0004 primary key (attempt_id, state_id)). Never throws: a failure is
 * returned for the caller to log, and the launch proceeds.
 */
export async function writeLaunchData(
  svc: SupabaseClient,
  attemptId: string,
  data: AldsLaunchData
): Promise<{ error: { code?: string; message: string } | null }> {
  try {
    const { error } = await svc.from("xapi_state").upsert(
      {
        attempt_id: attemptId,
        state_id: LMS_LAUNCH_DATA_STATE_ID,
        content: data,
        content_type: "application/json",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "attempt_id,state_id" }
    );
    return { error: error ? { code: error.code, message: error.message } : null };
  } catch (e) {
    return { error: { message: e instanceof Error ? e.message : String(e) } };
  }
}

/**
 * Record the cmi5/xAPI learning session of this launch (0100
 * learning_sessions; id = the LaunchData sessionid). Fail-soft: logs ids
 * only and never throws.
 */
export async function recordLearningSession(
  svc: SupabaseClient,
  i: {
    sessionId: string;
    organizationId: string;
    attemptId: string;
    launchKind: "cmi5" | "xapi";
    fetchToken: string | null;
    activityId: string;
    launchMode: LaunchMode;
  }
): Promise<void> {
  try {
    const { error } = await svc.from(LEARNING_SESSIONS_TABLE).insert({
      id: i.sessionId,
      organization_id: i.organizationId,
      attempt_id: i.attemptId,
      launch_kind: i.launchKind,
      fetch_token: i.fetchToken,
      activity_id: i.activityId,
      launch_mode: i.launchMode,
    });
    if (error) {
      logAldsSkip("learning_session", isAldsSchemaMissing(error) ? "schema_missing" : error.message, {
        attemptId: i.attemptId,
      });
    }
  } catch (e) {
    logAldsSkip("learning_session", e instanceof Error ? e.message : String(e), { attemptId: i.attemptId });
  }
}

/**
 * The State route's read-only guard: exact, case-sensitive (cmi5 §10.1).
 * It keeps its name; from ADR 0014 step 4 it covers both LMS-owned
 * documents, LMS.LaunchData and LMS.OfficialResult. GET serves both.
 */
export function isLaunchDataStateId(stateId: string | null): boolean {
  return stateId === LMS_LAUNCH_DATA_STATE_ID || stateId === LMS_OFFICIAL_RESULT_STATE_ID;
}

/** A fresh cmi5 session id, one per launch. */
export function newSessionId(): string {
  return randomUUID();
}
