import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isOrgAdminCaller } from "@/lib/auth/api-admin";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { resolveEmails } from "@/lib/users/emails";
import { notifyBackground } from "@/lib/notifications/send";
import { resolveManyGroups } from "@/lib/org/groups";

/**
 *   DELETE /api/learning-path-assignments/{id}
 *
 * Admin-only: the caller's role in the row's org is checked explicitly
 * before the delete and the service-role notification pass (members can
 * read many path assignment rows, and an RLS-refused delete removes nothing
 * without an error). Snapshots the row first so we can fire
 * path_unassignment, then deletes; a delete that removes no row is an
 * error, never ok. An id with no visible row answers 404; a failed read
 * answers 503.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // select("*") + separate name lookups would cost extra round trips; keep the
  // embed but request group_id via the wildcard on the parent table only.
  const { data: row, error: readErr } = await supabase
    .from("learning_path_assignments")
    .select("*, learning_paths(name), organizations(name)")
    .eq("id", id)
    .maybeSingle();
  // A failed read is not "gone": the admin pages treat 404 as already removed.
  if (readErr) {
    return NextResponse.json(
      { error: "Could not load the assignment. Nothing was removed; try again." },
      { status: 503 }
    );
  }
  if (!row) {
    return NextResponse.json({ error: "Assignment not found" }, { status: 404 });
  }
  const orgId = (row as { organization_id: string }).organization_id;
  if (!(await isOrgAdminCaller(supabase, orgId, user.id))) {
    return NextResponse.json({ error: "Forbidden: admins only" }, { status: 403 });
  }

  const { data: deleted, error } = await supabase
    .from("learning_path_assignments")
    .delete()
    .eq("id", id)
    .select("id");
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  if (!deleted?.length) {
    return NextResponse.json(
      { error: "The assignment was not removed." },
      { status: 403 }
    );
  }

  if (row) {
    await (async () => {
      try {
        const svc = createServiceClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.SUPABASE_SERVICE_ROLE_KEY!,
          { auth: { persistSession: false } }
        );
        const r = row as {
          path_id: string;
          organization_id: string;
          assignee_type: "user" | "team" | "org" | "group";
          user_id: string | null;
          team_id: string | null;
          group_id?: string | null;
          learning_paths?: { name?: string } | { name?: string }[];
          organizations?: { name?: string } | { name?: string }[];
        };
        const path = Array.isArray(r.learning_paths)
          ? r.learning_paths[0]
          : r.learning_paths;
        const orgInfo = Array.isArray(r.organizations)
          ? r.organizations[0]
          : r.organizations;

        const recipientIds = new Set<string>();
        if (r.assignee_type === "user" && r.user_id) {
          recipientIds.add(r.user_id);
        } else if (r.assignee_type === "team" && r.team_id) {
          const { data: tm } = await svc
            .from("team_members")
            .select("user_id")
            .eq("team_id", r.team_id);
          for (const m of tm ?? []) recipientIds.add(m.user_id as string);
        } else if (r.assignee_type === "group" && r.group_id) {
          for (const uid of await resolveManyGroups(svc, r.organization_id, [
            r.group_id,
          ])) {
            recipientIds.add(uid);
          }
        } else if (r.assignee_type === "org") {
          const { data: om } = await svc
            .from("organization_members")
            .select("user_id")
            .eq("organization_id", r.organization_id);
          for (const m of om ?? []) recipientIds.add(m.user_id as string);
        }
        if (recipientIds.size === 0) return;

        const emailById = await resolveEmails(svc, recipientIds);
        for (const uid of recipientIds) {
          const email = emailById.get(uid);
          if (!email) continue;
          await notifyBackground({
            organizationId: r.organization_id,
            event: "path_unassignment",
            to: { user_id: uid, email },
            context: {
              learner_name: email,
              learner_email: email,
              path_name: path?.name ?? "a learning path",
              org_name: orgInfo?.name ?? "your org",
            },
          });
        }
      } catch (e) {
        console.warn("[path-unassignment] notify failed:", e);
      }
    })();
  }

  return NextResponse.json({ ok: true });
}
