import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { isSupportedLanguage } from "@/lib/i18n/languages";

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

  // Look for in-progress attempts on this course in a DIFFERENT language.
  const { data: cvs } = await svc
    .from("course_versions")
    .select("id, package_id, course_packages!inner(language)")
    .eq("package_id", body.language); // placeholder; real query below
  void cvs;
  // Need to: find all versions of THIS course where the version\'s package
  // is NOT the chosen language, then count in-progress attempts by this user.
  const { data: otherVersions } = await svc
    .from("course_versions")
    .select("id, package_id")
    .neq("package_id", targetPkg.id);
  // Restrict to versions of THIS course via a second filter:
  const { data: thisCourseVersions } = await svc
    .from("course_versions").select("id, package_id").eq("course_id", courseId);
  const thisCourseVerIds = ((thisCourseVersions ?? []) as Array<{ id: string; package_id: string }>);
  const otherLangVerIds = thisCourseVerIds
    .filter((v) => v.package_id !== targetPkg.id)
    .map((v) => v.id);

  let inProgressCount = 0;
  if (otherLangVerIds.length > 0) {
    const { count } = await svc
      .from("course_attempts")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .in("course_version_id", otherLangVerIds)
      .neq("completion_status", "completed")
      .or("success_status.neq.passed,success_status.is.null");
    inProgressCount = count ?? 0;
  }
  void otherVersions;

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

  // If the caller confirmed restart, mark old-language attempts as abandoned.
  if (body.restart_if_in_progress && otherLangVerIds.length > 0) {
    await svc
      .from("course_attempts")
      .update({ status: "abandoned" })
      .eq("user_id", user.id)
      .in("course_version_id", otherLangVerIds)
      .neq("completion_status", "completed")
      .or("success_status.neq.passed,success_status.is.null");
  }

  return NextResponse.json({ ok: true, abandoned: inProgressCount });
}
