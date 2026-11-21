import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isOrgAdminCaller, notAdminAnswer } from "@/lib/auth/api-admin";
import { countingMemberIds } from "@/lib/auth/org-membership";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { resolveEmailsStrict } from "@/lib/users/emails";
import { RECIPIENTS_UNREADABLE, mailCounts, sendMany, type MailOutcome } from "@/lib/notifications/send";
import { ADMIN_REQUEST_OWN_CALLS, countCalls, openRun, recordRecipientsUnreadable, requestBudget, spendCalls } from "@/lib/notifications/smtp-state";
import { assigneeRecipientsStrict } from "@/lib/org/groups";

/**
 *   DELETE /api/learning-path-assignments/{id}
 *
 * Admin-only: the caller's role in the row's org is checked explicitly
 * before the delete and the service-role notification pass (members can
 * read many path assignment rows, and an RLS-refused delete removes nothing
 * without an error). Snapshots the row first so we can fire
 * path_unassignment, then deletes; a delete that removes no row is an
 * error, never ok, unless the row is gone by then (a delete that crossed
 * another one): 404. An id with no visible row answers 404; a failed read,
 * the role read included, answers 503.
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
  const admin = await isOrgAdminCaller(supabase, orgId, user.id);
  if (!admin) {
    const refused = notAdminAnswer(admin);
    return NextResponse.json({ error: refused.error }, { status: refused.status });
  }

  const { data: deleted, error } = await supabase
    .from("learning_path_assignments")
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
      .from("learning_path_assignments")
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

  // Path unassignment mail (ADR 0029 rule T4): one run, within this
  // request's budgets; the answer says how many were emailed and how many
  // were not. A failed read of the recipients mails nobody, records the skip
  // and says so.
  let email: MailOutcome | null = null;
  if (row) {
    email = await (async (): Promise<MailOutcome | null> => {
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
      try {
        const svc = createServiceClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.SUPABASE_SERVICE_ROLE_KEY!,
          { auth: { persistSession: false } }
        );
        const budget = requestBudget({ spent: ADMIN_REQUEST_OWN_CALLS });
        const path = Array.isArray(r.learning_paths)
          ? r.learning_paths[0]
          : r.learning_paths;
        const orgInfo = Array.isArray(r.organizations)
          ? r.organizations[0]
          : r.organizations;

        // ADR 0030 rule 10: the organisation mails only members that count
        // (active, in an organisation that is not deleted). One read of them
        // for this request: it is the org-wide audience and the filter on
        // every other one.
        const counting = await countingMemberIds(svc, r.organization_id, undefined, countCalls(budget));
        if (counting === "unreadable") {
          await recordRecipientsUnreadable("learning-path-assignments/[id]", r.organization_id);
          return RECIPIENTS_UNREADABLE;
        }
        const recipients = await assigneeRecipientsStrict(svc, r.organization_id, [r], counting, countCalls(budget));
        if (recipients === "unreadable") {
          await recordRecipientsUnreadable("learning-path-assignments/[id]", r.organization_id);
          return RECIPIENTS_UNREADABLE;
        }
        if (recipients.size === 0) return mailCounts([]);

        spendCalls(budget, Math.ceil(recipients.size / 150));
        const emailById = await resolveEmailsStrict(svc, recipients);
        if (emailById === "unreadable") {
          await recordRecipientsUnreadable("learning-path-assignments/[id]", r.organization_id);
          return RECIPIENTS_UNREADABLE;
        }
        const people = [...recipients].flatMap((uid) => {
          const address = emailById.get(uid);
          return address ? [{ uid, email: address }] : [];
        });
        const run = await openRun({ organizationId: r.organization_id, budget, db: svc });
        const results = await sendMany(run, people, (p) => ({
          event: "path_unassignment",
          to: { user_id: p.uid, email: p.email },
          context: {
            learner_name: p.email,
            learner_email: p.email,
            path_name: path?.name ?? "a learning path",
            org_name: orgInfo?.name ?? "your org",
          },
        }));
        return mailCounts(results, recipients.size - people.length);
      } catch (e) {
        console.warn(JSON.stringify({ event: "assignment_mail_failed", site: "learning-path-assignments/[id]", org_id: r.organization_id, error: e instanceof Error ? e.name : "unknown" }));
        return null;
      }
    })();
  }

  return NextResponse.json({ ok: true, email });
}
