import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { uploadCoursePackage } from "@/lib/courses/upload";
import { isSupportedLanguage } from "@/lib/i18n/languages";

/**
 *   POST /api/courses/{courseId}/packages
 *
 *   multipart/form-data:
 *     file:         the SCORM/cmi5 zip for this language variant
 *     orgSlug:      tenant org slug (for auth)
 *     language:     ISO 639-1 / BCP-47 code ('en', 'hi', 'zh-Hans', etc.)
 *     display_name: optional human-friendly label
 *
 * Adds a new language variant to an existing course. Behavior:
 *   1. Verifies caller is an admin of the org that owns the course
 *   2. Validates the language code against the curated SUPPORTED_LANGUAGES
 *   3. Refuses if a package with this language already exists on the
 *      course (admins should upload a NEW VERSION of that package via
 *      /api/courses/upload?courseId=... + ?packageId=... instead)
 *   4. Creates a course_packages row, then runs the standard
 *      uploadCoursePackage helper to extract + persist the zip
 *   5. Links the resulting course_version to the new package
 *   6. Sets the new version as the package's current_version_id
 *
 * Returns: { package_id, version_id, version_number }
 *
 * Companion endpoints (deferred per RFC phasing):
 *   GET   /api/courses/{courseId}/languages         (Phase 1, shipping with this commit)
 *   PUT   /api/courses/{courseId}/language-preference (Phase 3 — needed by launch picker)
 *   PATCH /api/courses/{courseId}/packages/{packageId} (Phase 1c — admin UI)
 *   DELETE /api/courses/{courseId}/packages/{packageId} (Phase 1c — admin UI)
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ courseId: string }> }
) {
  const { courseId } = await params;
  const form = await request.formData();

  const file = form.get("file");
  const orgSlug = (form.get("orgSlug") as string | null)?.trim();
  const language = (form.get("language") as string | null)?.trim();
  const displayName = (form.get("display_name") as string | null)?.trim() || null;

  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: "file required" }, { status: 400 });
  }
  if (!orgSlug) {
    return NextResponse.json({ error: "orgSlug required" }, { status: 400 });
  }
  if (!language) {
    return NextResponse.json({ error: "language required" }, { status: 400 });
  }
  if (!isSupportedLanguage(language)) {
    return NextResponse.json(
      {
        error: `Unsupported language code "${language}". See lib/i18n/languages.ts for the supported list.`,
      },
      { status: 400 }
    );
  }

  // ---- Caller auth + admin check ----
  const supabase = await createClient();
  const {
    data: { user: caller },
  } = await supabase.auth.getUser();
  if (!caller) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: org } = await supabase
    .from("organizations")
    .select("id")
    .eq("slug", orgSlug)
    .maybeSingle();
  if (!org) {
    return NextResponse.json({ error: "Org not found" }, { status: 404 });
  }

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
    .select("id, organization_id")
    .eq("id", courseId)
    .eq("organization_id", org.id)
    .maybeSingle();
  if (!course) {
    return NextResponse.json({ error: "Course not found" }, { status: 404 });
  }

  // ---- Refuse if this language already exists on the course ----
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  const { data: existingPkg } = await svc
    .from("course_packages")
    .select("id")
    .eq("course_id", courseId)
    .eq("language", language)
    .maybeSingle();
  if (existingPkg) {
    return NextResponse.json(
      {
        error: `Course already has a "${language}" package. Upload a new VERSION instead, or DELETE the existing package first.`,
        existing_package_id: (existingPkg as { id: string }).id,
      },
      { status: 409 }
    );
  }

  // ---- Create the new package ----
  const { data: newPkg, error: pkgErr } = await svc
    .from("course_packages")
    .insert({
      course_id: courseId,
      language,
      display_name: displayName,
      is_active: true,
    })
    .select("id")
    .single();
  if (pkgErr || !newPkg) {
    return NextResponse.json(
      { error: pkgErr?.message ?? "Could not create package" },
      { status: 500 }
    );
  }
  const newPackageId = (newPkg as { id: string }).id;

  // ---- Run the standard zip-upload helper ----
  // Note: uploadCoursePackage creates a NEW course OR appends to an
  // existing one. We pass courseId so it appends. The version it
  // creates needs its package_id retargeted at our new package
  // (uploadCoursePackage doesn't know about packages yet; that's a
  // follow-up refactor for the unified upload path).
  let uploadResult;
  try {
    const ab = await (file as File).arrayBuffer();
    uploadResult = await uploadCoursePackage({
      zipBytes: new Uint8Array(ab),
      organizationId: org.id,
      uploaderId: caller.id,
      courseId,
      supabase: svc,
    });
  } catch (e) {
    // Roll back the package row on upload failure to keep state clean.
    await svc.from("course_packages").delete().eq("id", newPackageId);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Upload failed" },
      { status: 500 }
    );
  }

  // Retarget the new version at our new package + set as current.
  await svc
    .from("course_versions")
    .update({ package_id: newPackageId })
    .eq("id", uploadResult.versionId);
  await svc
    .from("course_packages")
    .update({ current_version_id: uploadResult.versionId })
    .eq("id", newPackageId);

  return NextResponse.json({
    package_id: newPackageId,
    version_id: uploadResult.versionId,
    version_number: uploadResult.versionNumber,
    language,
    display_name: displayName,
  });
}
