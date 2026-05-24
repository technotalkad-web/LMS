import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { notifyBackground } from "@/lib/notifications/send";

/**
 *   DELETE /api/learning-path-assignments/{id}
 *
 * Snapshots the row first so we can fire path_unassignment, then deletes.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: row } = await supabase
    .from("learning_path_assignments")
    .select(
      "path_id, organization_id, assignee_type, user_id, team_id, learning_paths(name), organizations(name)"
    )
    .eq("id", id)
    .maybeSingle();

  const { error } = await supabase
    .from("learning_path_assignments")
    .delete()
    .eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

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
          assignee_type: "user" | "team" | "org";
          user_id: string | null;
          team_id: string | null;
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
        } else if (r.assignee_type === "org") {
          const { data: om } = await svc
            .from("organization_members")
            .select("user_id")
            .eq("organization_id", r.organization_id);
          for (const m of om ?? []) recipientIds.add(m.user_id as string);
        }
        if (recipientIds.size === 0) return;

        const { data: listed } = await svc.auth.admin.listUsers({
          page: 1,
          perPage: 1500,
        });
        const emailById = new Map<string, string>();
        for (const u of listed?.users ?? []) {
          if (u.email && recipientIds.has(u.id)) emailById.set(u.id, u.email);
        }
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
