import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isOrgAdminCaller, notAdminAnswer } from "@/lib/auth/api-admin";
import { countingMemberIds } from "@/lib/auth/org-membership";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { resolveEmails } from "@/lib/users/emails";
import { notifyBackground } from "@/lib/notifications/send";
import { resolveManyGroups } from "@/lib/org/groups";

/**
 *   DELETE /api/assignments/{id}
 *
 * Admin-only: the caller's role in the row's org is checked explicitly
 * before the delete and the service-role notification pass (members can
 * read many assignment rows, and an RLS-refused delete removes nothing
 * without an error). Looks up the row before deleting so we can fire an
 * asset_unassignment notification to the affected learners; a delete that
 * removes no row is an error, never ok, unless the row is gone by then (a
 * delete that crossed another one): 404. An id with no visible row answers
 * 404; a failed read, the role read included, answers 503.
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
  // Wildcard on the parent table for 0069 deploy safety (group_id).
  const { data: row, error: readErr } = await supabase
    .from("course_assignments")
    .select("*, courses(title), organizations(name, slug)")
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
  const admin = await isOrgAdminCaller(supabase, orgId, user.id);
  if (!admin) {
    const refused = notAdminAnswer(admin);
    return NextResponse.json({ error: refused.error }, { status: refused.status });
  }

  const { data: deleted, error } = await supabase
    .from("course_assignments")
    .delete()
    .eq("id", id)
    .select("id");
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  if (!deleted?.length) {
    // No row changed. A delete that crossed another one (two tabs, two
    // admins) finds the row already gone: read it again, fresh, and answer
    // 404 then, which the admin pages take as removed. A row still there
    // was not removed: 403.
    const { data: still, error: againErr } = await supabase
      .from("course_assignments")
      .select("id")
      .eq("id", id)
      .abortSignal(new AbortController().signal)
      .maybeSingle();
    if (againErr) {
      return NextResponse.json(
        { error: "Could not confirm the assignment was removed; try again." },
        { status: 503 }
      );
    }
    if (!still) {
      return NextResponse.json({ error: "Assignment not found" }, { status: 404 });
    }
    return NextResponse.json(
      { error: "The assignment was not removed." },
      { status: 403 }
    );
  }

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
          assignee_type: "user" | "team" | "org" | "group";
          user_id: string | null;
          team_id: string | null;
          group_id?: string | null;
          courses?: { title?: string } | { title?: string }[];
          organizations?:
            | { name?: string; slug?: string }
            | { name?: string; slug?: string }[];
        };
        // ADR 0030 rule 10: the organisation mails only members that count
        // (active, in an organisation that is not deleted). One read of them
        // for this request: it is the org-wide audience and the filter on
        // every other one. Unreadable: no mail.
        const counting = await countingMemberIds(svc, r.organization_id);
        if (counting === "unreadable") {
          console.warn(JSON.stringify({ event: "mail_recipients_unreadable", site: "assignments/[id]", org_id: r.organization_id }));
          return;
        }
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
          for (const uid of counting) recipientIds.add(uid);
        }
        // A person named directly, in a team or in a static group may hold a
        // row that does not count: they get no mail.
        for (const uid of recipientIds) if (!counting.has(uid)) recipientIds.delete(uid);
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
