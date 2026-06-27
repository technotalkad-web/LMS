import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { resolveEmails } from "@/lib/users/emails";
import { notifyBackground } from "@/lib/notifications/send";
import { originFromRequest } from "@/lib/http/origin";

/**
 *   POST /api/learning-path-assignments
 *   body: { orgSlug, pathId, assignToOrg?, userIds?, teamIds?, dueAt? }
 *
 * After successful inserts, expands each row to the affected learners and
 * fires path_assignment notifications in the background.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    pathId?: string;
    assignToOrg?: boolean;
    userIds?: string[];
    teamIds?: string[];
    dueAt?: string | null;
  };
  if (!body.orgSlug || !body.pathId) {
    return NextResponse.json(
      { error: "orgSlug and pathId required" },
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
    .select("id, name, slug")
    .eq("slug", body.orgSlug)
    .maybeSingle();
  if (!org) return NextResponse.json({ error: "Org not found" }, { status: 404 });

  const dueAt =
    body.dueAt && body.dueAt.trim() ? new Date(body.dueAt).toISOString() : null;

  type Row = {
    path_id: string;
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
      path_id: body.pathId,
      organization_id: org.id,
      assignee_type: "org",
      user_id: null,
      team_id: null,
      due_at: dueAt,
      assigned_by: user.id,
    });
  }
  for (const uid of body.userIds ?? []) {
    rows.push({
      path_id: body.pathId,
      organization_id: org.id,
      assignee_type: "user",
      user_id: uid,
      team_id: null,
      due_at: dueAt,
      assigned_by: user.id,
    });
  }
  for (const tid of body.teamIds ?? []) {
    rows.push({
      path_id: body.pathId,
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
      .from("learning_path_assignments")
      .insert(row)
      .select("id, assignee_type, user_id, team_id, due_at, assigned_at")
      .maybeSingle();
    if (data) inserted.push(data);
    else if (error && error.code !== "23505") {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
  }

  // Fire path_assignment notifications in the background.
  if (inserted.length > 0) {
    await (async () => {
      try {
        const svc = createServiceClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.SUPABASE_SERVICE_ROLE_KEY!,
          { auth: { persistSession: false } }
        );
        const { data: pathRow } = await svc
          .from("learning_paths")
          .select("name")
          .eq("id", body.pathId)
          .maybeSingle();
        const pathName =
          (pathRow as { name?: string } | null)?.name ?? "a learning path";

        const recipientIds = new Set<string>();
        for (const row of rows) {
          if (row.assignee_type === "user" && row.user_id) {
            recipientIds.add(row.user_id);
          } else if (row.assignee_type === "team" && row.team_id) {
            const { data: tm } = await svc
              .from("team_members")
              .select("user_id")
              .eq("team_id", row.team_id);
            for (const m of tm ?? []) recipientIds.add(m.user_id as string);
          } else if (row.assignee_type === "org") {
            const { data: om } = await svc
              .from("organization_members")
              .select("user_id")
              .eq("organization_id", org.id);
            for (const m of om ?? []) recipientIds.add(m.user_id as string);
          }
        }

        const emailById = await resolveEmails(svc, recipientIds);

        const portalBase = await originFromRequest();
        const directLink = portalBase
          ? `${portalBase}/${org.slug}/dashboard`
          : `/${org.slug}/dashboard`;

        for (const uid of recipientIds) {
          const email = emailById.get(uid);
          if (!email) continue;
          await notifyBackground({
            organizationId: org.id,
            event: "path_assignment",
            to: { user_id: uid, email },
            context: {
              learner_name: email,
              learner_email: email,
              path_name: pathName,
              path_id: body.pathId,
              org_name: org.name,
              direct_link: directLink,
              due_date: dueAt
                ? `Due ${new Date(dueAt).toISOString().slice(0, 10)}.`
                : "",
            },
          });
        }
      } catch (e) {
        console.warn("[path-assignment] notify failed:", e);
      }
    })();
  }

  return NextResponse.json({ assigned: inserted.length, assignments: inserted });
}
