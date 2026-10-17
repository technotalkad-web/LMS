import { NextRequest, NextResponse } from "next/server";
import { requireOrgAdminApi } from "@/lib/auth/api-admin";
import { auditLog } from "@/lib/auth/require-platform-owner";
import { setDefaultRefusal } from "@/lib/courses/default-rule";

/**
 *   POST /api/courses/[courseId]/packages/[packageId]/default
 *   { orgSlug }
 *
 * "Set as default" (ADR 0008 step 10): makes this language package the
 * course's default slot, i.e. `courses.current_version_id` becomes the
 * package's current version. Uploads and "Make current" never move the
 * default to another slot (step 9); this is the one deliberate action that
 * does. The default never chooses a learner's language at launch (step 13).
 *
 * Refused (409, nothing changed): the package is hidden from learners
 * (`package_inactive`), has no current version (`no_current_version`), or
 * its current version is not fully uploaded (`version_not_ready`).
 * Already the default → 200 `noop`, no audit row. Admin-only,
 * tenant-guarded like the activate route.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ courseId: string; packageId: string }> }
) {
  const { courseId, packageId } = await params;
  const body = (await request.json().catch(() => ({}))) as { orgSlug?: string };
  const auth = await requireOrgAdminApi(body.orgSlug ?? request.nextUrl.searchParams.get("orgSlug"));
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { supabase, org, userId } = auth;

  const { data: course } = await supabase
    .from("courses")
    .select("id, current_version_id")
    .eq("id", courseId)
    .eq("organization_id", org.id)
    .maybeSingle();
  if (!course) return NextResponse.json({ error: "Course not found" }, { status: 404 });
  const previous = (course as { current_version_id: string | null }).current_version_id ?? null;

  const { data: p } = await supabase
    .from("course_packages")
    .select("id, language, is_active, current_version_id")
    .eq("id", packageId)
    .eq("course_id", courseId)
    .maybeSingle();
  const pkg = p as { id: string; language: string | null; is_active: boolean | null; current_version_id: string | null } | null;
  if (!pkg) return NextResponse.json({ error: "Package not found" }, { status: 404 });

  // select("*") for 0077 deploy safety (upload_status).
  const { data: v } = pkg.current_version_id
    ? await supabase
        .from("course_versions")
        .select("*")
        .eq("id", pkg.current_version_id)
        .eq("course_id", courseId)
        .eq("package_id", packageId)
        .maybeSingle()
    : { data: null };
  const version = v as { id: string; upload_status?: string | null } | null;

  const refusal = setDefaultRefusal({
    packageActive: pkg.is_active !== false,
    currentVersionId: pkg.current_version_id,
    currentVersionFound: !!version,
    currentVersionUploadStatus: version?.upload_status,
  });
  if (refusal) {
    return NextResponse.json({ error: refusal.error, message: refusal.message }, { status: refusal.status });
  }
  const versionId = version!.id;

  if (previous === versionId) {
    return NextResponse.json({ ok: true, noop: true, packageId, versionId });
  }

  let previousPackageId: string | null = null;
  if (previous) {
    const { data: pv } = await supabase.from("course_versions").select("package_id").eq("id", previous).maybeSingle();
    previousPackageId = (pv as { package_id: string | null } | null)?.package_id ?? null;
  }

  // Conditional on the default read above, like publishVersion(): a
  // concurrent change of the default makes this a 409, never a silent overwrite.
  const update = supabase
    .from("courses")
    .update({ current_version_id: versionId, updated_at: new Date().toISOString() })
    .eq("id", courseId)
    .eq("organization_id", org.id);
  const { data: written, error } = await (previous
    ? update.eq("current_version_id", previous)
    : update.is("current_version_id", null)
  ).select("id");
  if (error) return NextResponse.json({ error: `Could not set the default: ${error.message}` }, { status: 500 });
  if (!written || written.length === 0) {
    return NextResponse.json(
      { error: "default_changed", message: "The course default changed while you were setting it. Reload and try again." },
      { status: 409 }
    );
  }

  await auditLog({
    actorUserId: userId,
    action: "course.default_slot_set",
    targetType: "course",
    targetId: courseId,
    metadata: { packageId, language: pkg.language, versionId, previousVersionId: previous, previousPackageId },
  });
  return NextResponse.json({ ok: true, packageId, versionId, previousVersionId: previous });
}
