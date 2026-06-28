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
 *
 * Replaces / updates the content of an EXISTING language package by uploading a
 * new version under it. The helper sequences the version number per package
 * (v2, v3, …), writes to a package-scoped storage prefix (so other languages are
 * untouched), and repoints course_packages.current_version_id at the new
 * version. Prior versions and all attempts/reporting are preserved.
 *
 * Admin-only; tenant-guarded (course + package must belong to the caller's org).
 *
 * Returns: { version_id, version_number }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ courseId: string; packageId: string }> }
) {
  const { courseId, packageId } = await params;
  const form = await request.formData();
  const file = form.get("file");
  const orgSlug = (form.get("orgSlug") as string | null)?.trim();

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
  try {
    const ab = await (file as File).arrayBuffer();
    const result = await uploadCoursePackage({
      zipBytes: new Uint8Array(ab),
      organizationId: org.id,
      uploaderId: caller.id,
      courseId,
      packageId,
      supabase: svc,
    });
    return NextResponse.json({
      ok: true,
      version_id: result.versionId,
      version_number: result.versionNumber,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Upload failed" },
      { status: 500 }
    );
  }
}
