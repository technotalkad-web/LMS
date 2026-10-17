import { NextRequest, NextResponse } from "next/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { requireOrgAdminApi } from "@/lib/auth/api-admin";
import { auditLog } from "@/lib/auth/require-platform-owner";
import { expireLaunchTokens } from "@/lib/attempts/abandon";
import {
  byRoleClass,
  isStaffRole,
  memberKey,
  parseRestartReason,
  planRestart,
  restartRefusal,
  type RestartAttempt,
} from "@/lib/attempts/restart";
import { fetchAll } from "@/lib/db/chunked";
import { enqueueAbandonedStatements } from "@/lib/lrs/abandoned";

/**
 *   POST /api/courses/[courseId]/packages/[packageId]/versions/[versionId]/restart
 *   { orgSlug, reason, dry_run? }
 *
 * Per-version restart (ADR 0008 decision A, steps 1–5): closes the
 * in-progress attempts on ONE version so those learners start the current
 * version at their next launch. Learners on any other version, completed /
 * passed / failed / abandoned attempts and grant retakes are never touched.
 *
 * - dry_run: true → the per-attempt list (ids and role classes only); writes
 *   nothing, no audit row. `reason` is not needed.
 * - real run → `reason` required (trimmed, 1–500 chars); conditional update
 *   (id in the selection, this version, still in progress, so a completion
 *   that lands first wins), launch tokens expired, the tenant LRS
 *   "abandoned" statement queued, audit row `course.version.attempts_restarted`.
 *
 * Refused (409, nothing changed): a version that is not fully uploaded; the
 * current version of an ACTIVE package. The current version of an inactive
 * package is allowed. Admin-only, tenant-guarded like the activate route.
 *
 * Response: { dry_run, version_id, attempt_ids, excluded_grant_retake_ids,
 *             by_role: { learner, staff }, restarted? } — `attempt_ids` is
 * the selection on a dry run and the attempts actually reset on a real run.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ courseId: string; packageId: string; versionId: string }> }
) {
  const { courseId, packageId, versionId } = await params;
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    reason?: unknown;
    dry_run?: unknown;
  };
  const auth = await requireOrgAdminApi(body.orgSlug ?? request.nextUrl.searchParams.get("orgSlug"));
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { supabase, org, userId } = auth;
  const dryRun = body.dry_run === true;

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
  const version = v as { id: string; version_number: number; upload_status?: string | null } | null;
  if (!version) return NextResponse.json({ error: "Version not found on this package" }, { status: 404 });

  let reason = "";
  if (!dryRun) {
    const r = parseRestartReason(body.reason);
    if (!r.ok) return NextResponse.json({ error: "reason_required", message: r.message }, { status: 400 });
    reason = r.reason;
  }

  const { data: pkgRow } = await supabase
    .from("course_packages")
    .select("id, current_version_id, is_active")
    .eq("id", packageId)
    .eq("course_id", courseId)
    .maybeSingle();
  const pkg = pkgRow as { current_version_id: string | null; is_active: boolean | null } | null;
  if (!pkg) return NextResponse.json({ error: "Package not found" }, { status: 404 });

  const refusal = restartRefusal({
    versionId,
    uploadStatus: version.upload_status,
    packageCurrentVersionId: pkg.current_version_id,
    packageActive: pkg.is_active !== false,
  });
  if (refusal) {
    return NextResponse.json({ error: refusal.error, message: refusal.message }, { status: refusal.status });
  }

  // ---- Selection (service role: the attempts belong to other users) ----
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  let inProgress: RestartAttempt[];
  try {
    inProgress = await fetchAll<RestartAttempt>(svc, "course_attempts", "id, user_id, organization_id", (q) =>
      q.eq("course_version_id", versionId).eq("status", "in_progress")
    );
  } catch (e) {
    console.error("[restart] attempts read failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Could not read the attempts on this version." }, { status: 500 });
  }
  const ids = inProgress.map((a) => a.id);

  // Grant retakes are excluded by attempt id (the launch page's shape). Fail
  // CLOSED: restarting is irreversible, so a grant lookup error other than a
  // missing table (pre-0083: no grants) changes nothing.
  const grantRetakeIds = new Set<string>();
  for (let i = 0; i < ids.length; i += 150) {
    const { data: grantRows, error: grantErr } = await svc
      .from("attempt_requests")
      .select("used_attempt_id")
      .in("used_attempt_id", ids.slice(i, i + 150))
      .eq("status", "approved");
    if (grantErr) {
      if ((grantErr as { code?: string }).code === "42P01") break;
      console.error("[restart] grant lookup failed:", grantErr.message);
      return NextResponse.json(
        { error: "Could not check granted retakes; nothing was restarted. Try again." },
        { status: 503 }
      );
    }
    for (const r of (grantRows ?? []) as Array<{ used_attempt_id: string | null }>) {
      if (r.used_attempt_id) grantRetakeIds.add(r.used_attempt_id);
    }
  }

  // Role classes (ids only): staff = super_owner / admin / data_analyst in
  // the attempt's organisation; anyone else, or a former member, is a learner.
  const staffKeys = new Set<string>();
  const usersByOrg = new Map<string, Set<string>>();
  for (const a of inProgress) {
    (usersByOrg.get(a.organization_id) ?? usersByOrg.set(a.organization_id, new Set()).get(a.organization_id)!).add(a.user_id);
  }
  for (const [orgId, users] of usersByOrg) {
    const list = [...users];
    for (let i = 0; i < list.length; i += 150) {
      const { data: mems } = await svc
        .from("organization_members")
        .select("user_id, role")
        .eq("organization_id", orgId)
        .in("user_id", list.slice(i, i + 150));
      for (const m of (mems ?? []) as Array<{ user_id: string; role: string | null }>) {
        if (isStaffRole(m.role)) staffKeys.add(memberKey(orgId, m.user_id));
      }
    }
  }

  const plan = planRestart(inProgress, grantRetakeIds, staffKeys);

  if (dryRun) {
    return NextResponse.json({
      dry_run: true,
      version_id: versionId,
      attempt_ids: plan.attemptIds,
      excluded_grant_retake_ids: plan.excludedGrantRetakeIds,
      by_role: plan.byRole,
    });
  }

  // ---- Real run: conditional update, one version, in progress only ----
  const restartedIds: string[] = [];
  let updateError: string | null = null;
  for (let i = 0; i < plan.attemptIds.length; i += 150) {
    const { data: abRows, error: abErr } = await svc
      .from("course_attempts")
      .update({ status: "abandoned" })
      .in("id", plan.attemptIds.slice(i, i + 150))
      .eq("course_version_id", versionId)
      .eq("status", "in_progress")
      .select("id");
    if (abErr) {
      // Stop; whatever was already reset still gets its tokens expired, its
      // LRS statement and its audit row below.
      updateError = abErr.message;
      console.error("[restart] update failed:", abErr.message);
      break;
    }
    restartedIds.push(...((abRows ?? []) as Array<{ id: string }>).map((r) => r.id));
  }
  restartedIds.sort();

  const tokErr = await expireLaunchTokens(svc, restartedIds);
  if (tokErr) console.warn("[restart] token expiry failed:", tokErr.message);
  // Tenant LRS: queue "abandoned" (fail-soft; nothing when forwarding is off).
  await enqueueAbandonedStatements(svc, restartedIds);

  await auditLog({
    actorUserId: userId,
    action: "course.version.attempts_restarted",
    targetType: "course_version",
    targetId: versionId,
    metadata: {
      courseId,
      packageId,
      versionNumber: version.version_number,
      reason,
      attemptIds: restartedIds,
      excludedGrantRetakeIds: plan.excludedGrantRetakeIds,
      requestedCount: plan.attemptIds.length,
    },
  });

  const restartedSet = new Set(restartedIds);
  return NextResponse.json(
    {
      ...(updateError
        ? { error: `Restart stopped part-way: ${restartedIds.length} of ${plan.attemptIds.length} attempts were reset. Run it again to finish.` }
        : {}),
      dry_run: false,
      version_id: versionId,
      attempt_ids: restartedIds,
      excluded_grant_retake_ids: plan.excludedGrantRetakeIds,
      by_role: byRoleClass(plan.selected.filter((a) => restartedSet.has(a.id)), staffKeys),
      restarted: restartedIds.length,
    },
    { status: updateError ? 500 : 200 }
  );
}
