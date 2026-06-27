import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { resolveEmails } from "@/lib/users/emails";
import { notifyBackground } from "@/lib/notifications/send";

/**
 *   DELETE /api/assignments/{id}
 *
 * Admin-only via RLS. Looks up the row before deleting so we can fire
 * an asset_unassignment notification to the affected learners.
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

  // Snapshot the row first so the notify pass knows who to email.
  const { data: row } = await supabase
    .from("course_assignments")
    .select(
      "course_id, organization_id, assignee_type, user_id, team_id, courses(title), organizations(name, slug)"
    )
    .eq("id", id)
    .maybeSingle();

  const { error } = await supabase
    .from("course_assignments")
    .delete()
    .eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  // Fire unassignment notifications (background).
  if (row) {
    await (async () => {
      try {
        const svc = createServiceClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.SUPABASE_SERVICE_ROLE_KEY!,
          { auth: { persistSession: false } }
        );
        const r = row as {
          course_id: string;
          organization_id: string;
          assignee_type: "user" | "team" | "org";
          user_id: string | null;
          team_id: string | null;
          courses?: { title?: string } | { title?: string }[];
          organizations?:
            | { name?: string; slug?: string }
            | { name?: string; slug?: string }[];
        };
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

        const emailById = await resolveEmails(svc, recipientIds);

        const course = Array.isArray(r.courses) ? r.courses[0] : r.courses;
        const orgInfo = Array.isArray(r.organizations)
          ? r.organizations[0]
          : r.organizations;

        for (const uid of recipientIds) {
          const email = emailById.get(uid);
          if (!email) continue;
          await notifyBackground({
            organizationId: r.organization_id,
            event: "asset_unassignment",
            to: { user_id: uid, email },
            context: {
              learner_name: email,
              learner_email: email,
              course_name: course?.title ?? "a course",
              org_name: orgInfo?.name ?? "your org",
            },
          });
        }
      } catch (e) {
        console.warn("[unassignment] notify failed:", e);
      }
    })();
  }

  return NextResponse.json({ ok: true });
}
