import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { isSupportedLanguage } from "@/lib/i18n/languages";
import { expireLaunchTokens } from "@/lib/attempts/abandon";

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

  // Find all versions of THIS course whose package is NOT the chosen language,
  // then count this user's in-progress attempts on them.
  const { data: thisCourseVersions } = await svc
    .from("course_versions")
    .select("id, package_id")
    .eq("course_id", courseId);
  const otherLangVerIds = ((thisCourseVersions ?? []) as Array<{ id: string; package_id: string }>)
    .filter((v) => v.package_id !== targetPkg.id)
    .map((v) => v.id);

  // A consumed grant retake (an extra OFFICIAL attempt an admin granted) is
  // never abandoned by a language switch (ALDS Decision 9): it stays
  // resumable in its own language, so it is neither counted as "progress you
  // will lose" nor reset below.
  let ipIds: string[] = [];
  if (otherLangVerIds.length > 0) {
    const { data: ipRows } = await svc
      .from("course_attempts")
      .select("id")
      .eq("user_id", user.id)
      .in("course_version_id", otherLangVerIds)
      .eq("status", "in_progress");
    ipIds = ((ipRows ?? []) as Array<{ id: string }>).map((r) => r.id);
  }

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
  const resettableIds = ipIds.filter((id) => !retakeIds.has(id));
  const keptRetakes = ipIds.length - resettableIds.length;
  const inProgressCount = resettableIds.length;

  if (inProgressCount > 0 && !body.restart_if_in_progress) {
    return NextResponse.json(
      {
        requires_confirm: true,
        in_progress_attempts: inProgressCount,
        message:
          "We will retain your chosen language when you continue the course. If you switch languages during the course, your progress will be reset.",
      },
      { status: 409 }
    );
  }

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
  }

  return NextResponse.json({ ok: true, abandoned, kept_grant_retakes: keptRetakes });
}
