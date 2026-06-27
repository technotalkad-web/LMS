import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { uploadCoursePackage } from "@/lib/courses/upload";
import { notifyBackground } from "@/lib/notifications/send";
import { checkQuota } from "@/lib/billing/enforce-quota";
import { originFromRequest } from "@/lib/http/origin";

/**
 * Course package upload endpoint.
 *
 *   POST /api/courses/upload
 *   form-data:
 *     file: <the .zip>
 *     orgSlug: "acme"
 *     courseId?: "..."             (omit for new course; provide to add a version)
 *     notify_update?: "1" | "0"   (when truthy + courseId given, fires asset_update
 *                                  email to every currently-assigned learner)
 *
 * Returns: { courseId, versionId, versionNumber, manifest }
 */
export async function POST(request: NextRequest) {
  const form = await request.formData();
  const file = form.get("file");
  const orgSlug = form.get("orgSlug");
  const courseIdRaw = form.get("courseId");
  const notifyRaw = form.get("notify_update");

  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: "Missing 'file'" }, { status: 400 });
  }
  if (typeof orgSlug !== "string" || !orgSlug) {
    return NextResponse.json({ error: "Missing 'orgSlug'" }, { status: 400 });
  }

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: org } = await supabase
    .from("organizations")
    .select("id, name, slug")
    .eq("slug", orgSlug)
    .maybeSingle();
  if (!org) {
    return NextResponse.json({ error: "Organization not found" }, { status: 404 });
  }

  const { data: membership } = await supabase
    .from("organization_members")
    .select("role")
    .eq("organization_id", org.id)
    .eq("user_id", user.id)
    .maybeSingle();
  const callerRole = membership?.role as string | undefined;
  const canWrite =
    callerRole === "super_owner" ||
    callerRole === "owner" || // legacy compat
    callerRole === "admin";
  if (!canWrite) {
    return NextResponse.json(
      { error: "Forbidden: only super owners and admins can upload courses" },
      { status: 403 }
    );
  }

  const zipBytes = Buffer.from(await file.arrayBuffer());
  const courseId =
    typeof courseIdRaw === "string" && courseIdRaw ? courseIdRaw : undefined;

  // Only check quota when creating a NEW course (versions don't consume).
  if (!courseId) {
    const quota = await checkQuota(org.id as string, "courses");
    if (!quota.ok) {
      return NextResponse.json(
        { error: quota.message, reason: quota.reason },
        { status: 402 }
      );
    }
  }
  // Storage quota on real bytes (B5): every upload — new course OR new version —
  // adds the package's footprint, so check it for all uploads.
  const deltaMb = Math.ceil(zipBytes.length / (1024 * 1024));
  if (deltaMb > 0) {
    const storageQuota = await checkQuota(org.id as string, "storage_mb", deltaMb);
    if (!storageQuota.ok) {
      return NextResponse.json(
        { error: storageQuota.message, reason: storageQuota.reason },
        { status: 402 }
      );
    }
  }
  const thumbnailUrlRaw = form.get("thumbnail_url");
  const thumbnailUrl =
    typeof thumbnailUrlRaw === "string" && thumbnailUrlRaw.trim()
      ? thumbnailUrlRaw.trim()
      : null;
  const wantsNotify =
    typeof notifyRaw === "string" &&
    (notifyRaw === "1" || notifyRaw === "true" || notifyRaw === "on");

  let result: Awaited<ReturnType<typeof uploadCoursePackage>>;
  try {
    result = await uploadCoursePackage({
      zipBytes,
      organizationId: org.id,
      uploaderId: user.id,
      courseId,
      supabase,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upload failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  // If a thumbnail URL was sent along with the upload, persist it.
  if (thumbnailUrl && result.courseId) {
    await supabase
      .from("courses")
      .update({ thumbnail_url: thumbnailUrl })
      .eq("id", result.courseId);
  }

  // Update notification: only meaningful when this was a new version of an
  // existing course (i.e., learners already had the old version assigned).
  if (wantsNotify && courseId) {
    await (async () => {
      try {
        const svc = createServiceClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.SUPABASE_SERVICE_ROLE_KEY!,
          { auth: { persistSession: false } }
        );
        const { data: courseRow } = await svc
          .from("courses")
          .select("title")
          .eq("id", courseId)
          .maybeSingle();
        const courseTitle =
          (courseRow as { title?: string } | null)?.title ?? "your course";

        // Resolve all currently-assigned learners (direct, team, org-wide).
        const learnerIds = await resolveAssignedUserIds({
          svc,
          orgId: org.id,
          table: "course_assignments",
          targetCol: "course_id",
          targetId: courseId,
        });
        if (learnerIds.size === 0) return;

        const { data: listed } = await svc.auth.admin.listUsers({
          page: 1,
          perPage: 1500,
        });
        const emailById = new Map<string, string>();
        for (const u of listed?.users ?? []) {
          if (u.email && learnerIds.has(u.id)) emailById.set(u.id, u.email);
        }

        const portalBase = await originFromRequest();
        const directLink = portalBase
          ? `${portalBase}/${org.slug}/courses/${courseId}/launch`
          : `/${org.slug}/courses/${courseId}/launch`;

        for (const uid of learnerIds) {
          const email = emailById.get(uid);
          if (!email) continue;
          await notifyBackground({
            organizationId: org.id,
            event: "asset_update",
            to: { user_id: uid, email },
            context: {
              learner_name: email,
              learner_email: email,
              course_name: courseTitle,
              course_id: courseId,
              // Empty string keeps the {Path_Name} placeholder visible in
              // templates where it's not relevant; templates can ignore it.
              path_name: "",
              org_name: org.name,
              direct_link: directLink,
            },
          });
        }
      } catch (e) {
        console.warn("[course/upload] update-notify failed:", e);
      }
    })();
  }

  return NextResponse.json(result);
}

/**
 * Expand a course or path assignment row set into the unique set of
 * learner user_ids. Handles user, team, and org-wide rows.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
async function resolveAssignedUserIds(args: {
  svc: any;
  orgId: string;
  table: "course_assignments" | "learning_path_assignments";
  targetCol: "course_id" | "path_id";
  targetId: string;
}): Promise<Set<string>> {
  const { svc, orgId, table, targetCol, targetId } = args;
  const out = new Set<string>();
  const { data: rows } = await svc
    .from(table)
    .select("assignee_type, user_id, team_id")
    .eq(targetCol, targetId);
  const teamIds = new Set<string>();
  let coversOrg = false;
  for (const r of (rows ?? []) as Array<{
    assignee_type: "user" | "team" | "org";
    user_id: string | null;
    team_id: string | null;
  }>) {
    if (r.assignee_type === "user" && r.user_id) out.add(r.user_id);
    else if (r.assignee_type === "team" && r.team_id) teamIds.add(r.team_id);
    else if (r.assignee_type === "org") coversOrg = true;
  }
  if (teamIds.size > 0) {
    const { data: tm } = await svc
      .from("team_members")
      .select("user_id")
      .in("team_id", Array.from(teamIds));
    for (const m of tm ?? []) out.add(m.user_id as string);
  }
  if (coversOrg) {
    const { data: om } = await svc
      .from("organization_members")
      .select("user_id")
      .eq("organization_id", orgId);
    for (const m of om ?? []) out.add(m.user_id as string);
  }
  return out;
}
