import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { isSupportedLanguage } from "@/lib/i18n/languages";
import { expireLaunchTokens } from "@/lib/attempts/abandon";
import { enqueueAbandonedStatements } from "@/lib/lrs/abandoned";
import { isMissingColumn } from "@/lib/scoring/attempt-kind";
import { finishCheckAttemptIds, languageSwitchDecision, resettableSwitchRows, type SwitchRow } from "@/lib/courses/slot-routing";
import { VERBS } from "@/lib/xapi/types";

/**
 * PUT /api/courses/{courseId}/language-preference
 *
 * Saves the learner\'s chosen language for this course. Used by:
 *  - The Phase 2 launch picker (first-time selection)
 *  - The Phase 3 "Change language" UI (later re-selection)
 *
 *   body: {
 *     orgSlug: string,
 *     language: string,
 *     restart_if_in_progress?: boolean
 *   }
 *
 * Behavior:
 *  - If user has NO in-progress attempts in a DIFFERENT language:
 *    save the preference, return 200.
 *  - If user has in-progress attempts in a different language AND
 *    restart_if_in_progress is false (default): return 409 with
 *    { requires_confirm: true, in_progress_attempts: N }. The Phase 4
 *    progress-reset confirmation modal consumes this to show the
 *    warning copy.
 *  - If restart_if_in_progress is true: save the preference, then
 *    mark all the user\'s in-progress attempts on this course as
 *    abandoned (status = \'abandoned\') so the next launch starts
 *    fresh. (Phase 4 — implemented here so the foundation is ready
 *    even before the confirmation modal ships.)
 *  - Consumed grant retakes are never abandoned (ALDS Decision 9) and do
 *    not count towards requires_confirm; abandoning also expires the
 *    attempts\' cmi5/xAPI launch tokens (ALDS step 0, P4).
 *  - ADR 0014 step 3: a revision visit\'s row (is_revision) is neither
 *    counted nor abandoned (it stays open and is re-seeded at its next
 *    revisit); the filter is dropped on a database without the column.
 *  - ADR 0014 step 18: an official cmi5 attempt on the other language that
 *    has already taken an assessment (a stored passed or failed statement)
 *    is not resettable: 409 { requires_finish, error, message } and nothing
 *    is written, not the preference either, whatever restart_if_in_progress
 *    says. The check runs after the resettable set is known, before the
 *    requires_confirm 409 and before the upsert. Its reads, and the two
 *    selects it widens, answer 503 on an error and write nothing.
 *  - The decision itself is lib/courses/slot-routing.ts
 *    languageSwitchDecision() (unit-tested).
 *
 * Auth: any org member can call for their own preference (RLS handles
 * the per-user scope on course_language_preferences).
 *
 * Closes #158 Phase 3.
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ courseId: string }> }
) {
  const { courseId } = await params;
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    language?: string;
    restart_if_in_progress?: boolean;
  };
  if (!body.orgSlug) return NextResponse.json({ error: "orgSlug required" }, { status: 400 });
  if (!body.language) return NextResponse.json({ error: "language required" }, { status: 400 });
  if (!isSupportedLanguage(body.language)) {
    return NextResponse.json({ error: `Unsupported language code "${body.language}"` }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: org } = await supabase
    .from("organizations").select("id").eq("slug", body.orgSlug).maybeSingle();
  if (!org) return NextResponse.json({ error: "Org not found" }, { status: 404 });

  // Verify the course exists in this org.
  const { data: course } = await supabase
    .from("courses").select("id").eq("id", courseId).eq("organization_id", org.id).maybeSingle();
  if (!course) return NextResponse.json({ error: "Course not found" }, { status: 404 });

  // Verify the target language has an active package on this course.
  const { data: targetPkg } = await supabase
    .from("course_packages")
    .select("id, language")
    .eq("course_id", courseId)
    .eq("language", body.language)
    .eq("is_active", true)
    .maybeSingle();
  if (!targetPkg) {
    return NextResponse.json(
      { error: `Course has no active "${body.language}" package` },
      { status: 404 }
    );
  }

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  const unreadable = (what: string, message: string) => {
    console.error(`[language-preference] ${what} read failed:`, message);
    return NextResponse.json({ error: "Could not check your progress. Please try again." }, { status: 503 });
  };

  // Find all versions of THIS course whose package is NOT the chosen language,
  // then count this user's in-progress attempts on them. manifest_type (ADR
  // 0014 step 18) maps each attempt to its runtime; an error writes nothing.
  const { data: thisCourseVersions, error: versionsErr } = await svc
    .from("course_versions")
    .select("id, package_id, manifest_type")
    .eq("course_id", courseId);
  if (versionsErr) return unreadable("versions", versionsErr.message);
  const courseVersions = (thisCourseVersions ?? []) as Array<{ id: string; package_id: string; manifest_type: string | null }>;
  const otherLangVerIds = courseVersions.filter((v) => v.package_id !== targetPkg.id).map((v) => v.id);
  const manifestTypeOfVersion = new Map(courseVersions.map((v) => [v.id, v.manifest_type]));

  // A consumed grant retake (an extra OFFICIAL attempt an admin granted) is
  // never abandoned by a language switch (ALDS Decision 9): it stays
  // resumable in its own language, so it is neither counted as "progress you
  // will lose" nor reset below. A revision visit's row (ADR 0014 step 3)
  // neither: `is_revision = false`, the filter dropped on a database without
  // the column (where no row can be flagged).
  let ipRowsRead: SwitchRow[] = [];
  if (otherLangVerIds.length > 0) {
    const readInProgress = (withFlagFilter: boolean) => {
      let q = svc
        .from("course_attempts")
        .select("id, course_version_id")
        .eq("user_id", user.id)
        .in("course_version_id", otherLangVerIds)
        .eq("status", "in_progress");
      if (withFlagFilter) q = q.eq("is_revision", false);
      return q;
    };
    let { data: ipRows, error: ipErr } = await readInProgress(true);
    if (ipErr && isMissingColumn(ipErr, "is_revision")) ({ data: ipRows, error: ipErr } = await readInProgress(false));
    if (ipErr) return unreadable("in-progress attempts", ipErr.message);
    ipRowsRead = (ipRows ?? []) as SwitchRow[];
  }
  const ipIds = ipRowsRead.map((r) => r.id);

  // Only when there is something to reset: fail CLOSED — abandoning is
  // irreversible, so if the grant lookup errors we refuse the switch rather
  // than risk abandoning a granted retake. (A database without attempt_requests
  // — pre-0083 — has no grants.)
  const retakeIds = new Set<string>();
  if (ipIds.length > 0) {
    const { data: grantRows, error: grantErr } = await svc
      .from("attempt_requests")
      .select("used_attempt_id")
      .eq("user_id", user.id)
      .eq("course_id", courseId)
      .eq("status", "approved")
      .not("used_attempt_id", "is", null);
    if (grantErr && (grantErr as { code?: string }).code !== "42P01") {
      console.error("[language-preference] grant lookup failed:", grantErr.message);
      return NextResponse.json(
        { error: "Could not check your granted attempts. Please try again." },
        { status: 503 }
      );
    }
    for (const r of (grantRows ?? []) as Array<{ used_attempt_id: string | null }>) {
      if (r.used_attempt_id) retakeIds.add(r.used_attempt_id);
    }
  }
  // ADR 0014 step 18: an official cmi5 attempt that has taken an assessment
  // (a stored passed or failed run summary: on an in-progress row only a
  // sub-activity outcome can be one) is not resettable. One error-checked
  // read, only when there is a cmi5 attempt to check; the route stores the
  // full verb IRI, so the filter names VERBS.passed and VERBS.failed.
  const finishCheckIds = finishCheckAttemptIds(resettableSwitchRows(ipRowsRead, retakeIds), manifestTypeOfVersion);
  const assessedAttemptIds = new Set<string>();
  if (finishCheckIds.length > 0) {
    const { data: outcomeRows, error: outcomeErr } = await svc
      .from("xapi_statements")
      .select("attempt_id")
      .in("attempt_id", finishCheckIds)
      .in("verb", [VERBS.passed, VERBS.failed]);
    if (outcomeErr) return unreadable("statements", outcomeErr.message);
    for (const r of (outcomeRows ?? []) as Array<{ attempt_id: string }>) assessedAttemptIds.add(r.attempt_id);
  }

  // The answer (lib/courses/slot-routing.ts): requires_finish first, on both
  // values of restart_if_in_progress, then today's confirm, then proceed.
  const decision = languageSwitchDecision({
    rows: ipRowsRead,
    retakeIds,
    assessedAttemptIds,
    restartIfInProgress: Boolean(body.restart_if_in_progress),
  });
  if (decision.kind === "requires_finish") {
    return NextResponse.json(
      { requires_finish: true, error: decision.message, message: decision.message },
      { status: 409 }
    );
  }
  if (decision.kind === "requires_confirm") {
    return NextResponse.json(
      {
        requires_confirm: true,
        in_progress_attempts: decision.inProgressAttempts,
        message:
          "We will retain your chosen language when you continue the course. If you switch languages during the course, your progress will be reset.",
      },
      { status: 409 }
    );
  }
  const resettableIds = decision.resettableIds;
  const keptRetakes = decision.keptRetakes;

  // Upsert the preference (composite PK = user_id + course_id).
  const { error: upErr } = await svc.from("course_language_preferences").upsert(
    {
      user_id: user.id,
      course_id: courseId,
      language: body.language,
      set_at: new Date().toISOString(),
    },
    { onConflict: "user_id,course_id" }
  );
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 400 });

  // If the caller confirmed restart, mark old-language attempts as abandoned so
  // the next launch starts fresh in the new language — except consumed grant
  // retakes (above). ALDS step 0 (P4): abandoning writes status only (the
  // reason/at columns arrive with 0098) and expires the attempts' launch
  // tokens in the same path, so a stale tab can no longer reach the xAPI
  // endpoints; its SCORM commits answer 410.
  let abandoned = 0;
  if (body.restart_if_in_progress && resettableIds.length > 0) {
    // Exactly the attempts evaluated above (grant retakes already excluded),
    // still in progress, still this learner's.
    const { data: abRows, error: abErr } = await svc
      .from("course_attempts")
      .update({ status: "abandoned" })
      .in("id", resettableIds)
      .eq("user_id", user.id)
      .eq("status", "in_progress")
      .select("id");
    if (abErr) {
      return NextResponse.json(
        { error: `Saved preference but failed to reset progress: ${abErr.message}` },
        { status: 500 }
      );
    }
    const abIds = ((abRows ?? []) as Array<{ id: string }>).map((r) => r.id);
    abandoned = abIds.length;
    const tokErr = await expireLaunchTokens(svc, abIds);
    if (tokErr) console.warn("[language-preference] token expiry failed:", tokErr.message);
    // Tenant LRS: queue "abandoned" (fail-soft; nothing when forwarding is off).
    await enqueueAbandonedStatements(svc, abIds);
  }

  return NextResponse.json({ ok: true, abandoned, kept_grant_retakes: keptRetakes });
}
