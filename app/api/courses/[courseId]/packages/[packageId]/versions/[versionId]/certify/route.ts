import { NextRequest, NextResponse } from "next/server";
import { requireOrgAdminApi } from "@/lib/auth/api-admin";
import { auditLog } from "@/lib/auth/require-platform-owner";
import { aldsP4Enabled } from "@/lib/alds/flag";
import { runPackageGuardian } from "@/lib/alds/guardian";

/**
 *   POST /api/courses/[courseId]/packages/[packageId]/versions/[versionId]/certify
 *   { orgSlug, reason }
 *
 * Re-run the Package Guardian static check on one stored version (ADR 0005
 * step 1 "Re-run", step 2 "super_owner may re-run … with an audited reason";
 * note (f) of 2026-10-19). super_owner only (an admin answers 403, the legacy
 * "owner" alias is not accepted), tenant-guarded like the activate route.
 * The check is warn-only: it changes the version's analytics tier and
 * nothing else (no grading, completion or learner data; D1).
 *
 *   200 { tier, reasonCode, reason, certificationId }
 *   400 reason missing or longer than 500 characters
 *   403 super_owner_required · 404 course / version not found
 *   409 p4_disabled (ALDS_P4 off) · not_ready (upload not finished) · no_manifest (Level 1: nothing to certify)
 *   503 schema_missing (0100 not on this database) · unavailable (a read or write failed; nothing changed)
 *
 * The audit row `course.version.certification_rerun` is written before the
 * run, so an attempted re-run is recorded even when it is refused below.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ courseId: string; packageId: string; versionId: string }> }
) {
  const { courseId, packageId, versionId } = await params;
  const body = (await request.json().catch(() => ({}))) as { orgSlug?: string; reason?: unknown };
  const auth = await requireOrgAdminApi(body.orgSlug ?? request.nextUrl.searchParams.get("orgSlug"));
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { supabase, org, userId, role } = auth;
  if (role !== "super_owner") {
    return NextResponse.json({ error: "super_owner_required" }, { status: 403 });
  }

  // ---- Tenant guard (as the activate route) ----
  const { data: course } = await supabase
    .from("courses")
    .select("id")
    .eq("id", courseId)
    .eq("organization_id", org.id)
    .maybeSingle();
  if (!course) return NextResponse.json({ error: "Course not found" }, { status: 404 });

  // select("*") for 0077 deploy safety (upload_status).
  const { data: v } = await supabase
    .from("course_versions")
    .select("*")
    .eq("id", versionId)
    .eq("course_id", courseId)
    .eq("package_id", packageId)
    .maybeSingle();
  const version = v as { id: string; upload_status?: string | null } | null;
  if (!version) return NextResponse.json({ error: "Version not found on this package" }, { status: 404 });

  if (!aldsP4Enabled()) return NextResponse.json({ error: "p4_disabled" }, { status: 409 });
  if (version.upload_status && version.upload_status !== "ready") {
    return NextResponse.json({ error: "not_ready" }, { status: 409 });
  }
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!reason || reason.length > 500) {
    return NextResponse.json({ error: "reason is required (1 to 500 characters)" }, { status: 400 });
  }

  await auditLog({
    actorUserId: userId,
    action: "course.version.certification_rerun",
    targetType: "course_version",
    targetId: versionId,
    metadata: { courseId, packageId, reason },
  });

  const outcome = await runPackageGuardian({
    versionId,
    organizationId: org.id,
    trigger: "rerun",
    requestedBy: userId,
  });
  if ("skipped" in outcome) {
    switch (outcome.skipped) {
      case "no_manifest":
        return NextResponse.json({ error: "no_manifest" }, { status: 409 });
      case "not_ready":
        return NextResponse.json({ error: "not_ready" }, { status: 409 });
      case "flag_off":
        return NextResponse.json({ error: "p4_disabled" }, { status: 409 });
      case "not_found":
        return NextResponse.json({ error: "Version not found on this package" }, { status: 404 });
      case "schema_missing":
        return NextResponse.json({ error: "schema_missing" }, { status: 503 });
      default:
        return NextResponse.json({ error: "unavailable" }, { status: 503 });
    }
  }
  return NextResponse.json(outcome);
}
