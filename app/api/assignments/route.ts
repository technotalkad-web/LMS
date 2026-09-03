import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { resolveEmails } from "@/lib/users/emails";
import { notifyBackground } from "@/lib/notifications/send";
import { originFromRequest } from "@/lib/http/origin";
import { resolveManyGroups } from "@/lib/org/groups";

/**
 *   POST /api/assignments
 *   body: {
 *     orgSlug, courseId,
 *     assignToOrg?, userIds?, teamIds?, groupIds?,
 *     dueAt?, releaseAt?
 *   }
 *
 * releaseAt (scheduled release) is the "available from" moment: the assignment
 * is visible to the learner as "Coming soon" but can't be launched until then.
 * Clients send a full ISO string (converted from the admin's local time in the
 * browser). Re-assigning an existing assignee UPDATES due_at/release_at rather
 * than silently no-op'ing on the unique-index conflict.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    courseId?: string;
    assignToOrg?: boolean;
    userIds?: string[];
    teamIds?: string[];
    groupIds?: string[];
    dueAt?: string | null;
    releaseAt?: string | null;
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

  let releaseAt: string | null = null;
  if (body.releaseAt && body.releaseAt.trim()) {
    const parsed = new Date(body.releaseAt);
    if (Number.isNaN(parsed.getTime())) {
      return NextResponse.json(
        { error: "releaseAt must be an ISO datetime" },
        { status: 400 }
      );
    }
    releaseAt = parsed.toISOString();
  }
  if (dueAt && releaseAt && new Date(dueAt).getTime() < new Date(releaseAt).getTime()) {
    return NextResponse.json(
      { error: "Due date can't be earlier than the release date" },
      { status: 400 }
    );
  }

  type Row = {
    course_id: string;
    organization_id: string;
    assignee_type: "user" | "org" | "team" | "group";
    user_id: string | null;
    team_id: string | null;
    // Optional so pre-0069 databases never see the column on non-group rows.
    group_id?: string | null;
    due_at: string | null;
    release_at: string | null;
    assigned_by: string;
  };
  const rows: Row[] = [];

  // Tenant guard: keep only assignees that actually belong to this org. The
  // rows are inserted and the assignees are then emailed via the service-role
  // notifier, so unvalidated user_ids/team_ids would leak assignments + PII to
  // another tenant's users.
  const reqUserIds = (body.userIds ?? []).filter(Boolean);
  const reqTeamIds = (body.teamIds ?? []).filter(Boolean);
  const reqGroupIds = (body.groupIds ?? []).filter(Boolean);
  let validUserIds: string[] = [];
  let validTeamIds: string[] = [];
  let validGroupIds: string[] = [];
  if (reqUserIds.length) {
    const { data: m } = await supabase
      .from("organization_members")
      .select("user_id")
      .eq("organization_id", org.id)
      .in("user_id", reqUserIds);
    validUserIds = ((m ?? []) as Array<{ user_id: string }>).map((r) => r.user_id);
  }
  if (reqTeamIds.length) {
    const { data: t } = await supabase
      .from("teams")
      .select("id")
      .eq("organization_id", org.id)
      .in("id", reqTeamIds);
    validTeamIds = ((t ?? []) as Array<{ id: string }>).map((r) => r.id);
  }
  if (reqGroupIds.length) {
    const { data: g } = await supabase
      .from("org_groups")
      .select("id")
      .eq("organization_id", org.id)
      .in("id", reqGroupIds);
    validGroupIds = ((g ?? []) as Array<{ id: string }>).map((r) => r.id);
  }

  if (body.assignToOrg) {
    rows.push({
      course_id: course.id,
      organization_id: org.id,
      assignee_type: "org",
      user_id: null,
      team_id: null,
      due_at: dueAt,
      release_at: releaseAt,
      assigned_by: user.id,
    });
  }
  for (const uid of validUserIds) {
    rows.push({
      course_id: course.id,
      organization_id: org.id,
      assignee_type: "user",
      user_id: uid,
      team_id: null,
      due_at: dueAt,
      release_at: releaseAt,
      assigned_by: user.id,
    });
  }
  for (const tid of validTeamIds) {
    rows.push({
      course_id: course.id,
      organization_id: org.id,
      assignee_type: "team",
      user_id: null,
      team_id: tid,
      due_at: dueAt,
      release_at: releaseAt,
      assigned_by: user.id,
    });
  }
  for (const gid of validGroupIds) {
    rows.push({
      course_id: course.id,
      organization_id: org.id,
      assignee_type: "group",
      user_id: null,
      team_id: null,
      group_id: gid,
      due_at: dueAt,
      release_at: releaseAt,
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
  let rescheduled = 0;
  // select("*") for 0069 deploy safety (group_id).
  const SELECT_COLS = "*";
  for (const row of rows) {
    const { data, error } = await supabase
      .from("course_assignments")
      .insert(row)
      .select(SELECT_COLS)
      .maybeSingle();
    if (data) {
      inserted.push(data);
      continue;
    }
    if (!error) continue;
    if (error.code !== "23505") {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    // Already assigned (unique index). Re-assigning is how an admin changes
    // the schedule, so apply the new dates instead of silently doing nothing.
    // No notification: the learner was already told about this assignment.
    if (dueAt === null && releaseAt === null) continue;
    let q = supabase
      .from("course_assignments")
      .update({ due_at: dueAt, release_at: releaseAt })
      .eq("course_id", row.course_id)
      .eq("organization_id", row.organization_id)
      .eq("assignee_type", row.assignee_type);
    q = row.user_id ? q.eq("user_id", row.user_id) : q.is("user_id", null);
    q = row.team_id ? q.eq("team_id", row.team_id) : q.is("team_id", null);
    // Only group rows carry group_id (pre-0069 DBs never see the column).
    if (row.group_id) q = q.eq("group_id", row.group_id);
    const { data: updated, error: updErr } = await q.select("id");
    if (updErr) {
      return NextResponse.json({ error: updErr.message }, { status: 400 });
    }
    rescheduled += updated?.length ?? 0;
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

        // Resolve recipient user_ids — only for rows we ACTUALLY inserted, so a
        // re-assignment that hit a 23505 duplicate (already assigned) doesn't
        // re-email that learner.
        const recipientUserIds = new Set<string>();
        for (const ins of inserted as Array<{
          assignee_type: string;
          user_id: string | null;
          team_id: string | null;
          group_id?: string | null;
        }>) {
          if (ins.assignee_type === "user" && ins.user_id) {
            recipientUserIds.add(ins.user_id);
          } else if (ins.assignee_type === "team" && ins.team_id) {
            const { data: tm } = await svc
              .from("team_members")
              .select("user_id")
              .eq("team_id", ins.team_id);
            for (const m of tm ?? []) recipientUserIds.add(m.user_id as string);
          } else if (ins.assignee_type === "group" && ins.group_id) {
            for (const uid of await resolveManyGroups(svc, org.id, [ins.group_id])) {
              recipientUserIds.add(uid);
            }
          } else if (ins.assignee_type === "org") {
            const { data: om } = await svc
              .from("organization_members")
              .select("user_id")
              .eq("organization_id", org.id);
            for (const m of om ?? []) recipientUserIds.add(m.user_id as string);
          }
        }

        // Resolve emails (indexed via profiles; no listUsers pagination cap).
        const emailById = await resolveEmails(svc, recipientUserIds);

        const portalBase = await originFromRequest();
        const directLink = portalBase
          ? `${portalBase}/${body.orgSlug}/courses/${course.id}/launch`
          : `/${body.orgSlug}/courses/${course.id}/launch`;
        // Scheduled release rides along in the {Due_Date} slot so admins get
        // the "available from" line without a new template token.
        const dueLine = [
          releaseAt
            ? `Available from ${new Date(releaseAt).toISOString().slice(0, 10)}.`
            : "",
          dueAt ? `Due ${new Date(dueAt).toISOString().slice(0, 10)}.` : "",
        ]
          .filter(Boolean)
          .join(" ");

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

  return NextResponse.json({
    assigned: inserted.length,
    rescheduled,
    assignments: inserted,
  });
}
