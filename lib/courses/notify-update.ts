import { createClient as createServiceClient } from "@supabase/supabase-js";
import { resolveEmailsStrict } from "@/lib/users/emails";
import { RECIPIENTS_UNREADABLE, mailCounts, sendMany, type MailOutcome } from "@/lib/notifications/send";
import { ADMIN_REQUEST_OWN_CALLS, openRun, recordRecipientsUnreadable, requestBudget, spendCalls } from "@/lib/notifications/smtp-state";
import { originFromRequest } from "@/lib/http/origin";
import { countingMemberIds } from "@/lib/auth/org-membership";
import { assignedRecipientsStrict } from "@/lib/org/groups";

/**
 * "This course has a new version" email to every currently assigned learner
 * (direct, team, group and org-wide assignments) whose membership counts
 * (ADR 0030 rule 10). Shared by the legacy multipart upload and the
 * direct-upload finalise step. Never throws: a notification failure must
 * not fail a publish.
 *
 * One run within the request's budgets (ADR 0029 rule T4). The outcome says
 * how many learners were emailed and how many were not; null when the mail
 * part itself failed. A failed read of the recipients is never "nobody":
 * nobody is emailed, the skip is recorded, and the outcome says so.
 */
export async function notifyCourseUpdate(args: {
  org: { id: string; slug: string; name: string };
  courseId: string;
}): Promise<MailOutcome | null> {
  const { org, courseId } = args;
  try {
    const svc = createServiceClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } }
    );
    const budget = requestBudget({ spent: ADMIN_REQUEST_OWN_CALLS });
    spendCalls(budget, 1);
    const { data: courseRow } = await svc
      .from("courses")
      .select("title")
      .eq("id", courseId)
      .maybeSingle();
    const courseTitle = (courseRow as { title?: string } | null)?.title ?? "your course";

    // ADR 0030 rule 10: one read of the org's members that count, for this
    // request: the org-wide audience and the filter on every other one.
    spendCalls(budget, 2);
    const counting = await countingMemberIds(svc, org.id);
    if (counting === "unreadable") {
      await recordRecipientsUnreadable("course-update", org.id);
      return RECIPIENTS_UNREADABLE;
    }
    spendCalls(budget, 3);
    const learnerIds = await assignedRecipientsStrict(
      svc,
      org.id,
      { table: "course_assignments", column: "course_id", id: courseId },
      counting
    );
    if (learnerIds === "unreadable") {
      await recordRecipientsUnreadable("course-update", org.id);
      return RECIPIENTS_UNREADABLE;
    }
    if (learnerIds.size === 0) return mailCounts([]);

    spendCalls(budget, Math.ceil(learnerIds.size / 150));
    const emailById = await resolveEmailsStrict(svc, learnerIds);
    if (emailById === "unreadable") {
      await recordRecipientsUnreadable("course-update", org.id);
      return RECIPIENTS_UNREADABLE;
    }
    const portalBase = await originFromRequest();
    const directLink = portalBase
      ? `${portalBase}/${org.slug}/courses/${courseId}/launch`
      : `/${org.slug}/courses/${courseId}/launch`;

    const people = [...learnerIds].flatMap((uid) => {
      const address = emailById.get(uid);
      return address ? [{ uid, email: address }] : [];
    });
    const run = await openRun({ organizationId: org.id, budget, db: svc });
    const results = await sendMany(run, people, (p) => ({
      event: "asset_update",
      to: { user_id: p.uid, email: p.email },
      context: {
        learner_name: p.email,
        learner_email: p.email,
        course_name: courseTitle,
        course_id: courseId,
        // Empty string keeps the {Path_Name} placeholder visible in
        // templates where it's not relevant; templates can ignore it.
        path_name: "",
        org_name: org.name,
        direct_link: directLink,
      },
    }));
    return mailCounts(results, learnerIds.size - people.length);
  } catch (e) {
    console.warn(JSON.stringify({ event: "assignment_mail_failed", site: "course-update", org_id: org.id, error: e instanceof Error ? e.name : "unknown" }));
    return null;
  }
}
