import { createClient as createServiceClient } from "@supabase/supabase-js";
import { resolveEmails } from "@/lib/users/emails";
import { notifyBackground } from "@/lib/notifications/send";
import { originFromRequest } from "@/lib/http/origin";

/**
 * "This course has a new version" email to every currently assigned learner
 * (direct, team and org-wide assignments). Shared by the legacy multipart
 * upload and the direct-upload finalise step. Never throws: a notification
 * failure must not fail a publish.
 */
export async function notifyCourseUpdate(args: {
  org: { id: string; slug: string; name: string };
  courseId: string;
}): Promise<void> {
  const { org, courseId } = args;
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
    const courseTitle = (courseRow as { title?: string } | null)?.title ?? "your course";

    const learnerIds = await resolveAssignedUserIds({
      svc,
      orgId: org.id,
      table: "course_assignments",
      targetCol: "course_id",
      targetId: courseId,
    });
    if (learnerIds.size === 0) return;

    const emailById = await resolveEmails(svc, learnerIds);
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
}

/**
 * Expand a course or path assignment row set into the unique set of
 * learner user_ids. Handles user, team, and org-wide rows.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export async function resolveAssignedUserIds(args: {
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
