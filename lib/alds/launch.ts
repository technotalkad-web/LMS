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
 * unconditionally (cmi5 §10.1: LMS.LaunchData is LMS-owned).
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
import { LEARNING_SESSIONS_TABLE, LMS_LAUNCH_DATA_STATE_ID } from "@/lib/alds/rpc";
import { canManage } from "@/lib/auth/permissions";
import type { OrgRole } from "@/lib/auth/require-org-access";

/** The LMS-issued AU id of a package (BLUEPRINT §1.2; one AU per package, U7). */
export function lmsAuActivityId(packageId: string): string {
  return auActivityId(packageId);
}

/**
 * Staff launches are previews (ADR 0006 step 17, BLUEPRINT §10.4): the same
 * roles as the 0100 backfill. Every launch from the launch page; there is no
 * learner-view exception.
 */
export function previewLaunch(role: OrgRole): { isPreview: boolean; launchMode: LaunchMode } {
  return canManage(role) || role === "data_analyst"
    ? { isPreview: true, launchMode: "Browse" }
    : { isPreview: false, launchMode: "Normal" };
}

/**
 * registration/kind of this launch (ADR 0006 note (b)): grant_retake when a
 * grant is consumed on this launch, retake when it is a revision run, else
 * enrollment.
 */
export function registrationKindFor(i: { consumeGrantId: string | null; practiceLaunch: boolean }): RegistrationKind {
  if (i.consumeGrantId) return "grant_retake";
  if (i.practiceLaunch) return "retake";
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

/** The State route's read-only guard: exact, case-sensitive (cmi5 §10.1). */
export function isLaunchDataStateId(stateId: string | null): boolean {
  return stateId === LMS_LAUNCH_DATA_STATE_ID;
}

/** A fresh cmi5 session id, one per launch. */
export function newSessionId(): string {
  return randomUUID();
}
