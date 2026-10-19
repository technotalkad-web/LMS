import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { isVersionConflictError, uploadCoursePackage } from "@/lib/courses/upload";
import {
  forceRestartOlderVersions,
  forceRestartReplaceAnswer,
  forceRestartReport,
} from "@/lib/attempts/force-restart";
import { runPackageGuardian } from "@/lib/alds/guardian";
import {
  enforcePackageValidation,
  linkValidationToVersion,
} from "@/lib/courses/validation/gate";

/**
 *   POST /api/courses/{courseId}/packages/{packageId}/versions
 *
 *   multipart/form-data:
 *     file:     the new SCORM/cmi5 zip to become this package's current version
 *     orgSlug:  tenant org slug (for auth)
 *     mode:     'grandfather' (default) | 'force_restart'
 *
 * Replaces / updates the content of an EXISTING language package by uploading a
 * new version under it. The helper sequences the version number per package
 * (v2, v3, …), writes to a package-scoped storage prefix (so other languages are
 * untouched), and repoints course_packages.current_version_id at the new
 * version. Prior versions and all attempts/reporting are preserved.
 *
 * Versioning mode (silent, no learner-facing notice — enterprise behavior):
 *   - 'grandfather' (default): in-progress attempts keep routing to their
 *     retired version (bookmarks intact); only NEW attempts get the new version.
 *     This is the launcher's natural behavior — no action needed here.
 *   - 'force_restart': mark this package's old in-progress attempts 'abandoned'
 *     so the launcher starts each learner fresh on the new version (0% on next
 *     launch). lib/attempts/force-restart.ts, shared with the direct-upload
 *     finalize (ADR 0011).
 *
 * Admin-only; tenant-guarded (course + package must belong to the caller's org).
 *
 * The new version is published BEFORE the restart runs, and the restart is
 * reported separately from it (ADR 0011): it is a success only when every
 * selected in-progress attempt is, by the database's answers, no longer in
 * progress, and "nobody was in progress" only when the selection read
 * succeeded and found none.
 *
 * Returns:
 *   grandfather:          200 { ok, version_id, version_number, mode, restarted: 0 }
 *   force_restart, reset: 200 { ok, version_id, version_number, mode, restarted,
 *                               expected, resolved, message, tokens_expired?: false }
 *   force_restart, reset failed (the new version IS published and current):
 *                         500 { error, published: true, version_id, version_number,
 *                               mode, restart: "failed", expected, restarted,
 *                               resolved, unresolved, unresolved_version_ids,
 *                               retry } — `retry` is the per-version restart
 *                               route (ADR 0008 A) to run for each entry of
 *                               unresolved_version_ids ("Restart learners on
 *                               this version" in the Library).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ courseId: string; packageId: string }> }
) {
  const { courseId, packageId } = await params;
  const form = await request.formData();
  const file = form.get("file");
  const orgSlug = (form.get("orgSlug") as string | null)?.trim();
  const mode = (form.get("mode") as string | null)?.trim() === "force_restart"
    ? "force_restart"
    : "grandfather";

  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: "file required" }, { status: 400 });
  }
  if (!orgSlug) {
    return NextResponse.json({ error: "orgSlug required" }, { status: 400 });
  }

  // ---- Caller auth + admin check ----
  const supabase = await createClient();
  const {
    data: { user: caller },
  } = await supabase.auth.getUser();
  if (!caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: org } = await supabase
    .from("organizations")
    .select("id")
    .eq("slug", orgSlug)
    .maybeSingle();
  if (!org) return NextResponse.json({ error: "Org not found" }, { status: 404 });

  const { data: callerMem } = await supabase
    .from("organization_members")
    .select("role")
    .eq("organization_id", org.id)
    .eq("user_id", caller.id)
    .maybeSingle();
  const cr = callerMem?.role as string | undefined;
  if (!(cr === "super_owner" || cr === "owner" || cr === "admin")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // ---- Verify course is in this org ----
  const { data: course } = await supabase
    .from("courses")
    .select("id")
    .eq("id", courseId)
    .eq("organization_id", org.id)
    .maybeSingle();
  if (!course) return NextResponse.json({ error: "Course not found" }, { status: 404 });

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  // ---- Verify the package belongs to this course ----
  const { data: pkg } = await svc
    .from("course_packages")
    .select("id, course_id")
    .eq("id", packageId)
    .eq("course_id", courseId)
    .maybeSingle();
  if (!pkg) {
    return NextResponse.json({ error: "Package not found" }, { status: 404 });
  }

  // ---- Pre-Upload Validation gate (0070) ----
  // A broken REPLACEMENT is worse than a broken new course — learners are
  // mid-flight — so the replace flow gets the exact same gate.
  const zipAb = new Uint8Array(await (file as File).arrayBuffer());
  const validationIdRaw = form.get("validation_id");
  const gate = await enforcePackageValidation({
    supabase,
    organizationId: org.id as string,
    userId: caller.id,
    courseId,
    zipBytes: zipAb,
    fileName: (file as File).name ?? null,
    validationId:
      typeof validationIdRaw === "string" && validationIdRaw ? validationIdRaw : null,
    acknowledge: form.get("acknowledge") === "1",
    packageId,
  });
  if (!gate.ok) {
    // A 'blocked' package (ADR 0004 step 3) answers 409 with the validation_id
    // a super_owner override can target.
    return NextResponse.json(
      { error: gate.error, ...(gate.validationId !== undefined ? { validation_id: gate.validationId } : {}) },
      { status: gate.status }
    );
  }

  // ---- Upload a new version under this package ----
  let result;
  try {
    result = await uploadCoursePackage({
      zipBytes: zipAb,
      organizationId: org.id,
      uploaderId: caller.id,
      courseId,
      packageId,
      supabase: svc,
    });
  } catch (e) {
    // ADR 0003 step 8: a concurrent upload holds this package's next version.
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Upload failed" },
      { status: isVersionConflictError(e) ? 409 : 500 }
    );
  }
  await linkValidationToVersion({
    organizationId: org.id as string,
    validationId: gate.validationId,
    courseId,
    versionId: result.versionId,
  });

  let answer: { status: 200 | 500; body: Record<string, unknown> };
  if (mode === "grandfather") {
    answer = {
      status: 200,
      body: {
        ok: true,
        version_id: result.versionId,
        version_number: result.versionNumber,
        mode,
        restarted: 0,
      },
    };
  } else {
    // ---- Force-restart: silently abandon old in-progress attempts ----
    // After this, the launcher finds no resumable attempt on the package's old
    // versions, so each learner starts fresh on the new version. The outcome
    // is a value (never a throw): the version above stays published whatever
    // it says, and a failed reset answers 500 with published: true.
    const run = await forceRestartOlderVersions(svc, { packageId, newVersionId: result.versionId });
    answer = forceRestartReplaceAnswer({
      courseId,
      packageId,
      versionId: result.versionId,
      versionNumber: result.versionNumber,
      report: forceRestartReport(run),
    });
  }

  // ADR 0005 note (e), additions of 2026-10-19: the Package Guardian static
  // gate, warn-only (flag ALDS_P4, default off), LAST, after the forced
  // restart, as finalizeDirectUpload runs it, so a slow gate or a worker
  // killed inside it can never cost the ADR 0011 restart or its report. It
  // never changes this answer.
  try {
    await runPackageGuardian({ versionId: result.versionId, organizationId: org.id, trigger: "upload" });
  } catch (e) {
    console.warn("[alds] guardian failed", e instanceof Error ? e.message : e);
  }

  return NextResponse.json(answer.body, { status: answer.status });
}
