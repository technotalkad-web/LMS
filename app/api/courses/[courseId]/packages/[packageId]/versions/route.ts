import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { uploadCoursePackage } from "@/lib/courses/upload";

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
 *     launch).
 *
 * Admin-only; tenant-guarded (course + package must belong to the caller's org).
 *
 * Returns: { version_id, version_number, mode, restarted? }
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

  // ---- Upload a new version under this package ----
  let result;
  try {
    const ab = await (file as File).arrayBuffer();
    result = await uploadCoursePackage({
      zipBytes: new Uint8Array(ab),
      organizationId: org.id,
      uploaderId: caller.id,
      courseId,
      packageId,
      supabase: svc,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Upload failed" },
      { status: 500 }
    );
  }

  // ---- Force-restart: silently abandon old in-progress attempts ----
  // After this, the launcher finds no resumable attempt on the package's old
  // versions, so each learner starts fresh on the new version. Grandfather mode
  // skips this — the launcher keeps routing them to their retired version.
  let restarted = 0;
  if (mode === "force_restart") {
    const { data: pkgVers } = await svc
      .from("course_versions")
      .select("id")
      .eq("package_id", packageId);
    const oldVerIds = ((pkgVers ?? []) as Array<{ id: string }>)
      .map((r) => r.id)
      .filter((id) => id !== result.versionId);
    if (oldVerIds.length > 0) {
      const { count, error: abErr } = await svc
        .from("course_attempts")
        .update({ status: "abandoned" }, { count: "exact" })
        .in("course_version_id", oldVerIds)
        .eq("status", "in_progress");
      if (abErr) {
        return NextResponse.json(
          { error: `New version uploaded, but restart failed: ${abErr.message}` },
          { status: 500 }
        );
      }
      restarted = count ?? 0;
    }
  }

  return NextResponse.json({
    ok: true,
    version_id: result.versionId,
    version_number: result.versionNumber,
    mode,
    restarted,
  });
}
