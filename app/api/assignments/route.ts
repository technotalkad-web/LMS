import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { notifyBackground } from "@/lib/notifications/send";
import { originFromRequest } from "@/lib/http/origin";

/**
 *   POST /api/assignments
 *   body: {
 *     orgSlug, courseId,
 *     assignToOrg?, userIds?, teamIds?,
 *     dueAt?
 *   }
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    courseId?: string;
    assignToOrg?: boolean;
    userIds?: string[];
    teamIds?: string[];
    dueAt?: string | null;
  };

  if (!body.orgSlug || !body.courseId) {
    return NextResponse.json(
      { error: "orgSlug and courseId required" },
      { status: 400 }
    );
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
    .select("id, name")
    .eq("slug", body.orgSlug)
    .maybeSingle();
  if (!org) return NextResponse.json({ error: "Org not found" }, { status: 404 });

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
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data: course } = await supabase
    .from("courses")
    .select("id, organization_id")
    .eq("id", body.courseId)
    .eq("organization_id", org.id)
    .maybeSingle();
  if (!course) {
    return NextResponse.json({ error: "Course not found" }, { status: 404 });
  }

  const dueAt =
    body.dueAt && body.dueAt.trim() ? new Date(body.dueAt).toISOString() : null;

  type Row = {
    course_id: string;
    organization_id: string;
    assignee_type: "user" | "org" | "team";
    user_id: string | null;
    team_id: string | null;
    due_at: string | null;
    assigned_by: string;
  };
  const rows: Row[] = [];

  if (body.assignToOrg) {
    rows.push({
      course_id: course.id,
      organization_id: org.id,
      assignee_type: "org",
      user_id: null,
      team_id: null,
      due_at: dueAt,
      assigned_by: user.id,
    });
  }
  for (const uid of body.userIds ?? []) {
    if (!uid) continue;
    rows.push({
      course_id: course.id,
      organization_id: org.id,
      assignee_type: "user",
      user_id: uid,
      team_id: null,
      due_at: dueAt,
      assigned_by: user.id,
    });
  }
  for (const tid of body.teamIds ?? []) {
    if (!tid) continue;
    rows.push({
      course_id: course.id,
      organization_id: org.id,
      assignee_type: "team",
      user_id: null,
      team_id: tid,
      due_at: dueAt,
      assigned_by: user.id,
    });
  }

  if (rows.length === 0) {
    return NextResponse.json(
      { error: "No assignees specified" },
      { status: 400 }
    );
  }

  const inserted: unknown[] = [];
  for (const row of rows) {
    const { data, error } = await supabase
      .from("course_assignments")
      .insert(row)
      .select("id, assignee_type, user_id, team_id, due_at, assigned_at")
      .maybeSingle();
    if (data) inserted.push(data);
    else if (error && error.code !== "23505") {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
  }

  // Fire assignment notifications in the background.
  if (inserted.length > 0) {
    await (async () => {
      try {
        const svc = createServiceClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.SUPABASE_SERVICE_ROLE_KEY!,
          { auth: { persistSession: false } }
        );
        // Course title
        const { data: courseRow } = await svc
          .from("courses")
          .select("title, id")
          .eq("id", course.id)
          .maybeSingle();
        const courseTitle = (courseRow as { title?: string } | null)?.title ?? "a course";

        // Resolve recipient user_ids per inserted row.
        const recipientUserIds = new Set<string>();
        for (const row of rows) {
          if (row.assignee_type === "user" && row.user_id) {
            recipientUserIds.add(row.user_id);
          } else if (row.assignee_type === "team" && row.team_id) {
            const { data: tm } = await svc
              .from("team_members")
              .select("user_id")
              .eq("team_id", row.team_id);
            for (const m of tm ?? []) recipientUserIds.add(m.user_id as string);
          } else if (row.assignee_type === "org") {
            const { data: om } = await svc
              .from("organization_members")
              .select("user_id")
              .eq("organization_id", org.id);
            for (const m of om ?? []) recipientUserIds.add(m.user_id as string);
          }
        }

        // Resolve emails for those user_ids.
        const { data: listed } = await svc.auth.admin.listUsers({
          page: 1,
          perPage: 1500,
        });
        const emailById = new Map<string, string>();
        for (const u of listed?.users ?? []) {
          if (u.email && recipientUserIds.has(u.id)) emailById.set(u.id, u.email);
        }

        const portalBase = await originFromRequest();
        const directLink = portalBase
          ? `${portalBase}/${body.orgSlug}/courses/${course.id}/launch`
          : `/${body.orgSlug}/courses/${course.id}/launch`;
        const dueLine = dueAt
          ? `Due ${new Date(dueAt).toISOString().slice(0, 10)}.`
          : "";

        for (const uid of recipientUserIds) {
          const email = emailById.get(uid);
          if (!email) continue;
          await notifyBackground({
            organizationId: org.id,
            event: "asset_assignment",
            to: { user_id: uid, email },
            context: {
              learner_name: email,
              learner_email: email,
              course_name: courseTitle,
              course_id: course.id,
              org_name: (org as { name?: string } | null)?.name ?? "your org",
              direct_link: directLink,
              due_date: dueLine,
            },
          });
        }
      } catch (e) {
        console.warn("[assignments] notify failed:", e);
      }
    })();
  }

  return NextResponse.json({ assigned: inserted.length, assignments: inserted });
}
