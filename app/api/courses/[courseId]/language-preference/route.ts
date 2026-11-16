import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { isSupportedLanguage } from "@/lib/i18n/languages";
import { expireLaunchTokens } from "@/lib/attempts/abandon";
import { contextEntitlement, type LaunchContextFacts } from "@/lib/attempts/launch-context";
import { auditLog } from "@/lib/auth/require-platform-owner";
import { enqueueAbandonedStatements } from "@/lib/lrs/abandoned";
import { isMissingColumn, isSchemaMissing } from "@/lib/scoring/attempt-kind";
import { contextKeyOf } from "@/lib/scoring/context";
import { isMissingContextColumn } from "@/lib/scoring/context-read";
import {
  finishCheckAttemptIds,
  languageSwitchAudit,
  languageSwitchDecision,
  parseSwitchContext,
  resettableSwitchRows,
  type SwitchRow,
} from "@/lib/courses/slot-routing";
import { VERBS } from "@/lib/xapi/types";

/**
 * PUT /api/courses/{courseId}/language-preference
 *
 * Saves the learner\'s chosen language for this course. Used by:
 *  - The Phase 2 launch picker (first-time selection, and since ADR 0024
 *    P2-9 the switch inside the launch's own product context)
 *  - The Phase 3 "Change language" UI on the course page (the Individual
 *    course)
 *
 *   body: {
 *     orgSlug: string,
 *     language: string,
 *     restart_if_in_progress?: boolean,
 *     context?: { kind: "individual" }
 *             | { kind: "path", path_id }
 *             | { kind: "journey", journey_enrollment_id, day_id }
 *   }
 *
 * Behavior:
 *  - ADR 0024 step 27 (P2-9; decisions A24 and A37): a switch counts and
 *    abandons the open attempts of ONE product context, the body's
 *    `context` (absent: the Individual course; a journey day by its id,
 *    section U). An open attempt of another product on the old language is
 *    left alone and continues in that language (ADR 0004 step 9, rule (2), at
 *    that product's next launch). The saved preference stays one per learner
 *    and course. A `preview` context answers 400 (P2-5: a Preview saves no
 *    preference and resets nothing), and so does a malformed one, both
 *    before any read or write (lib/courses/slot-routing.ts
 *    parseSwitchContext). A path or journey context is checked with the
 *    entitlement part of the launch's resolver (contextEntitlement), from
 *    one launch_context call on the service client with the session's user
 *    and the organisation of `orgSlug`; a context the learner does not hold
 *    answers 400 and nothing is saved, closed or audited. The Individual
 *    course makes no such call, as before (any member saves their own
 *    preference).
 *  - If user has NO in-progress attempts of that context in a DIFFERENT
 *    language: save the preference, return 200.
 *  - If user has such in-progress attempts AND restart_if_in_progress is
 *    false (default): return 409 with
 *    { requires_confirm: true, in_progress_attempts: N }. The Phase 4
 *    progress-reset confirmation modal consumes this to show the
 *    warning copy.
 *  - If restart_if_in_progress is true: save the preference, then mark
 *    those attempts (that context's only) as abandoned (status =
 *    \'abandoned\') so the next launch of that context starts fresh. The
 *    rows and their data, statements and State stay (ADR 0024 step 27,
 *    "What a language switch keeps"); nothing is deleted.
 *  - Consumed grant retakes are never abandoned (ALDS Decision 9) and do
 *    not count towards requires_confirm; abandoning also expires the
 *    attempts\' cmi5/xAPI launch tokens (ALDS step 0, P4).
 *  - ADR 0014 step 3: a revision visit\'s row (is_revision) is neither
 *    counted nor abandoned (it stays open and is re-seeded at its next
 *    revisit).
 *  - ADR 0014 step 18: an official cmi5 attempt of that context on the other
 *    language that has already taken an assessment (a stored passed or
 *    failed statement) is not resettable: 409 { requires_finish, error,
 *    message } and nothing is written, not the preference either, whatever
 *    restart_if_in_progress says. The check runs over the same in-context
 *    rows, after the resettable set is known, before the requires_confirm
 *    409 and before the upsert. Its reads, and the two selects it widens,
 *    answer 503 on an error and write nothing.
 *  - ADR 0024 P2-9 (review F1): a journey day whose launch would open no
 *    new official attempt once its open attempt is closed
 *    (contextEntitlement's `freshAfterClose` is false: a completed
 *    enrolment, a removed or credited day, a day whose course was swapped, a
 *    day that is not the open day) answers the same 409 { requires_finish,
 *    error, message } with RESTART_NOT_ADMITTED_MESSAGE when the switch
 *    would close a row, after step 18's check and before the
 *    requires_confirm 409, on both values of restart_if_in_progress, and
 *    writes nothing. A switch that would close nothing there (the open
 *    attempt's own language) saves the preference as before.
 *  - ADR 0024 decision A37: a switch that closed at least one row writes one
 *    audit row, `course.language_switched`, through auditLog (as the
 *    per-version restart route does): the course, the organisation, the
 *    context, the old and new language and the closed attempt ids; ids
 *    only. It is written before the answer; a failed audit write is logged
 *    (ids only) and does not fail the switch, whose writes are already made.
 *  - ADR 0024 decision A19: the in-progress read and the abandon filter on
 *    the context's key (`context_key`, a 0107 column, the key P2-6's launch
 *    reads and closes by), and a path or journey context needs
 *    launch_context (0107). On a database without 0107 the switch answers
 *    503 and writes nothing: no fallback to the course-wide read for a
 *    write. A course with no version on another language reads no attempts
 *    and saves the preference as before.
 *  - The decision itself is lib/courses/slot-routing.ts
 *    languageSwitchDecision() (unit-tested).
 *
 * Auth: any org member can call for their own preference (RLS handles
 * the per-user scope on course_language_preferences); every attempts read
 * and write names the session's user.
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
    /** ADR 0024 step 27 (P2-9): the product the switch is made in; parseSwitchContext reads it. */
    context?: unknown;
  };
  // ADR 0024 P2-5 and P2-9: a Preview never reaches this route (decision 3),
  // and a context that is not one of the three forms is refused; for either,
  // nothing is read and nothing is written.
  const parsed = parseSwitchContext(body.context);
  if (!parsed.ok) {
    return parsed.reason === "preview"
      ? NextResponse.json({ error: "A preview saves no language preference and resets nothing." }, { status: 400 })
      : NextResponse.json({ error: "Unknown learning context." }, { status: 400 });
  }
  const context = parsed.context;
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

  // The course's packages (one read): the target language must have exactly
  // one active package (the unique index on course and language allows no
  // more), and the audit row names the language each closed attempt was on.
  const { data: pkgRows } = await supabase
    .from("course_packages")
    .select("id, language, is_active")
    .eq("course_id", courseId);
  const packages = (pkgRows ?? []) as Array<{ id: string; language: string | null; is_active: boolean | null }>;
  const targets = packages.filter((p) => p.is_active === true && p.language === body.language);
  if (targets.length !== 1) {
    return NextResponse.json(
      { error: `Course has no active "${body.language}" package` },
      { status: 404 }
    );
  }
  const targetPkg = targets[0];
  const languageOfPackage = new Map(packages.map((p) => [p.id, p.language]));

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  const unreadable = (what: string, message: string) => {
    console.error(`[language-preference] ${what} read failed:`, message);
    return NextResponse.json({ error: "Could not check your progress. Please try again." }, { status: 503 });
  };
  // ADR 0024 decision A19: a database without 0107 cannot scope a switch to
  // one context, and a switch never falls back to the course-wide read.
  const no0107 = (what: string) => {
    console.error(JSON.stringify({ event: "language_switch_refused", reason: "schema_missing", what, course_id: courseId, user_id: user.id }));
    return NextResponse.json({ error: "Changing the language is not available yet. Please try again later." }, { status: 503 });
  };

  // ADR 0024 step 27: a path or journey context is the learner's only when
  // the entitlement rows of the launch's resolver say so, read from one
  // launch_context call (a POST, never memoized) for this very context. The
  // same answer says whether the context would open a fresh official attempt
  // after the close (review F1); the Individual course always does.
  let restartAdmitted = true;
  if (context.kind !== "individual") {
    const { data: lc, error: lcErr } = await svc.rpc("launch_context", {
      p_user: user.id,
      p_org: org.id,
      p_course: courseId,
      p_path: context.kind === "path" ? context.pathId : null,
      p_enrollment: context.kind === "journey" ? context.enrollmentId : null,
      p_day_id: context.kind === "journey" ? context.dayId : null,
      p_day: null,
    });
    if (lcErr) return isSchemaMissing(lcErr) ? no0107("launch_context") : unreadable("launch_context", lcErr.message);
    const facts = lc as LaunchContextFacts | null;
    if (!facts || typeof facts !== "object" || facts.v !== 1) return unreadable("launch_context", "an answer it cannot read");
    const entitlement = contextEntitlement({ courseId: courseId.toLowerCase(), context, facts, now: new Date().toISOString() });
    if (!entitlement.held) {
      console.warn(JSON.stringify({ event: "language_switch_refused", reason: entitlement.reason, kind: context.kind, course_id: courseId, user_id: user.id }));
      return NextResponse.json({ error: "You are not enrolled in this learning path or journey day for this course." }, { status: 400 });
    }
    restartAdmitted = entitlement.freshAfterClose;
  }
  // The context's key, the generated column course_attempts.context_key
  // (0107), as the launch reads and closes by it (lib/scoring/context.ts).
  const contextKey = contextKeyOf(context);

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
  const packageOfVersion = new Map(courseVersions.map((v) => [v.id, v.package_id]));

  // The context's open rows on the other language's versions: a consumed
  // grant retake (an extra OFFICIAL attempt an admin granted) is never
  // abandoned by a language switch (ALDS Decision 9): it stays resumable in
  // its own language, so it is neither counted as "progress you will lose"
  // nor reset below. A revision visit's row (ADR 0014 step 3) neither:
  // `is_revision = false`. The key filter keeps every other product's row
  // and every Preview out (a preview's key is `preview…`, ADR 0024 P2-5),
  // and the abandon below takes the same key. Both name 0107 columns with no
  // fallback (A19): a missing column answers 503 before anything is written.
  let ipRowsRead: SwitchRow[] = [];
  if (otherLangVerIds.length > 0) {
    const { data: ipRows, error: ipErr } = await svc
      .from("course_attempts")
      .select("id, course_version_id")
      .eq("user_id", user.id)
      .in("course_version_id", otherLangVerIds)
      .eq("status", "in_progress")
      .eq("context_key", contextKey)
      .eq("is_revision", false);
    if (ipErr) {
      // 0107 requires 0103, so a database without is_revision has no 0107 either.
      if (isMissingContextColumn(ipErr) || isMissingColumn(ipErr, "is_revision")) return no0107("in-progress attempts");
      return unreadable("in-progress attempts", ipErr.message);
    }
    ipRowsRead = (ipRows ?? []) as SwitchRow[];
  }
  const ipIds = ipRowsRead.map((r) => r.id);

  // Only when there is something to reset: fail CLOSED — abandoning is
  // irreversible, so if the grant lookup errors we refuse the switch rather
  // than risk abandoning a granted retake. (A database without attempt_requests
  // — pre-0083 — has no grants.) A retake is known by its grant's
  // used_attempt_id, whatever the grant's context (note N9).
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
  // full verb IRI, so the filter names VERBS.passed and VERBS.failed. The
  // rows are the context's (ADR 0024 step 27): another product's assessed
  // attempt never holds this one's switch.
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

  // The answer (lib/courses/slot-routing.ts): requires_finish first (an
  // assessed attempt, or a close the context could not start again after),
  // on both values of restart_if_in_progress, then today's confirm, then
  // proceed.
  const decision = languageSwitchDecision({
    rows: ipRowsRead,
    retakeIds,
    assessedAttemptIds,
    restartIfInProgress: Boolean(body.restart_if_in_progress),
    restartAdmitted,
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

  // If the caller confirmed restart, mark the context's old-language attempts
  // as abandoned so its next launch starts fresh in the new language —
  // except consumed grant retakes (above). ALDS step 0 (P4): abandoning
  // writes status only (the reason/at columns arrive with 0098) and expires
  // the attempts' launch tokens in the same path, so a stale tab can no
  // longer reach the xAPI endpoints; its SCORM commits answer 410.
  let abandoned = 0;
  if (body.restart_if_in_progress && resettableIds.length > 0) {
    // Exactly the attempts evaluated above (grant retakes already excluded),
    // still in progress, still this learner's, still in this context.
    const { data: abRows, error: abErr } = await svc
      .from("course_attempts")
      .update({ status: "abandoned" })
      .in("id", resettableIds)
      .eq("user_id", user.id)
      .eq("status", "in_progress")
      .eq("context_key", contextKey)
      .select("id, course_version_id");
    if (abErr) {
      return NextResponse.json(
        { error: `Saved preference but failed to reset progress: ${abErr.message}` },
        { status: 500 }
      );
    }
    const closed = (abRows ?? []) as Array<{ id: string; course_version_id: string }>;
    const abIds = closed.map((r) => r.id);
    abandoned = abIds.length;
    const tokErr = await expireLaunchTokens(svc, abIds);
    if (tokErr) console.warn("[language-preference] token expiry failed:", tokErr.message);
    // Tenant LRS: queue "abandoned" (fail-soft; nothing when forwarding is off).
    await enqueueAbandonedStatements(svc, abIds);
    // ADR 0024 decision A37: the record of what this switch closed, ids only.
    if (abIds.length > 0) {
      const row = languageSwitchAudit({
        courseId,
        organizationId: org.id,
        context,
        contextKey,
        toLanguage: body.language,
        closed: closed.map((r) => ({ id: r.id, language: languageOfPackage.get(packageOfVersion.get(r.course_version_id) ?? "") ?? null })),
      });
      const audit = await auditLog({ actorUserId: user.id, ...row });
      if (audit.error) {
        console.error(JSON.stringify({ event: "language_switch_audit_failed", course_id: courseId, user_id: user.id, attempt_ids: abIds }));
      }
    }
  }

  return NextResponse.json({ ok: true, abandoned, kept_grant_retakes: keptRetakes });
}
