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
 * LMS.OfficialResult are LMS-owned), and launchModeFor(), whose isPreview
 * the launch page also reads outside the flag to decide the revision visit
 * record (ADR 0014 step 3: staff previews record no visit).
 *
 * Privacy: the LaunchData document carries ids and the slot language only,
 * never a name or an email.
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
  EXT,
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
import { canManage } from "@/lib/auth/permissions";
import type { OrgRole } from "@/lib/auth/require-org-access";

/** The LMS-issued AU id of a package (BLUEPRINT §1.2; one AU per package, U7). */
export function lmsAuActivityId(packageId: string): string {
  return auActivityId(packageId);
}

/**
 * The launch mode, decided by the row (ADR 0014 step 3, "Row-driven
 * decisions"; replaces previewLaunch): staff launches are previews (ADR
 * 0006 step 17, BLUEPRINT §10.4: the same roles as the 0100 backfill),
 * `Browse`; otherwise a revision visit's row (is_revision) is `Review`;
 * else `Normal`. Every launch from the launch page; there is no
 * learner-view exception. No grading code reads the mode: every gate reads
 * is_revision.
 */
export function launchModeFor(i: { role: OrgRole; revision: boolean }): { isPreview: boolean; launchMode: LaunchMode } {
  if (canManage(i.role) || i.role === "data_analyst") return { isPreview: true, launchMode: "Browse" };
  return { isPreview: false, launchMode: i.revision ? "Review" : "Normal" };
}

/**
 * The three 0100 columns of a launch's attempt row (ADR 0006 note (c); ADR
 * 0014 step 3), for the launch page's insert and for its update after
 * consume_grant opens a retake. Only with ALDS_P4 on: the page calls it
 * under `p4`. The attempt column stores the raw slot language (null when
 * unlabeled), never the LaunchData "und".
 */
export function p4AttemptColumns(i: { role: OrgRole; revision: boolean; language: string | null | undefined }): {
  served_language: string | null;
  launch_mode: LaunchMode;
  is_preview: boolean;
} {
  const mode = launchModeFor({ role: i.role, revision: i.revision });
  return {
    served_language: attemptServedLanguage(i.language),
    launch_mode: mode.launchMode,
    is_preview: mode.isPreview,
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

/** The cmi5 LMS.LaunchData body (cmi5 §10.1; registration = attempt id, ADR 0002). */
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
}): AldsLaunchData {
  return {
    contextTemplate: {
      registration: i.attemptId,
      contextActivities: {
        grouping: [
          ...(i.publisherCourseId ? [{ id: i.publisherCourseId }] : []),
          ...(i.courseUlid ? [{ id: courseFamily(i.courseUlid) }] : []),
        ],
      },
      extensions: {
        [CMI5_SESSION_EXT]: i.sessionId,
        [EXT.attemptId]: i.attemptId,
        [EXT.registrationKind]: i.registrationKind,
        [EXT.attemptIndex]: 1,
        [EXT.packageId]: i.packageId,
        [EXT.versionId]: i.versionId,
        [EXT.language]: i.servedLanguage,
      },
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
