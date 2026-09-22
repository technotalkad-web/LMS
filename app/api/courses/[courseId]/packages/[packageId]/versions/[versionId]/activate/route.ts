import { NextRequest, NextResponse } from "next/server";
import { requireOrgAdminApi } from "@/lib/auth/api-admin";
import { auditLog } from "@/lib/auth/require-platform-owner";
import { publishVersion } from "@/lib/courses/upload";

/**
 *   POST /api/courses/[courseId]/packages/[packageId]/versions/[versionId]/activate
 *   { orgSlug }
 *
 * Rollback / roll-forward: makes an existing, fully uploaded version the
 * current one for its language package. Version folders are immutable, so
 * this is a pointer change; learners get the chosen version on their next
 * launch and open attempts keep the version they started on.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ courseId: string; packageId: string; versionId: string }> }
) {
  const { courseId, packageId, versionId } = await params;
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

  const { data: v } = await supabase
    .from("course_versions")
    .select("*")
    .eq("id", versionId)
    .eq("course_id", courseId)
    .eq("package_id", packageId)
    .maybeSingle();
  const version = v as { id: string; version_number: number; upload_status?: string } | null;
  if (!version) return NextResponse.json({ error: "Version not found on this package" }, { status: 404 });
  if (version.upload_status && version.upload_status !== "ready") {
    return NextResponse.json(
      { error: `Only fully uploaded versions can be activated (this one is ${version.upload_status}).` },
      { status: 409 }
    );
  }

  const { data: pkg } = await supabase
    .from("course_packages")
    .select("id, current_version_id")
    .eq("id", packageId)
    .maybeSingle();
  const previous = (pkg as { current_version_id: string | null } | null)?.current_version_id ?? null;

  await publishVersion(supabase, { courseId, packageId, versionId });
  await auditLog({
    actorUserId: userId,
    action: "course.version.activated",
    targetType: "course_version",
    targetId: versionId,
    metadata: { courseId, packageId, versionNumber: version.version_number, previousVersionId: previous },
  });
  return NextResponse.json({ ok: true, versionId, versionNumber: version.version_number, previousVersionId: previous });
}
