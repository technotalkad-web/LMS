/**
 * Attempt-request helpers (revision rule, Phase 2) — grant expiry + the two
 * notification fan-outs shared by the learner request route, the admin decide
 * route and the bulk-grant route.
 *
 * Emails go out as `custom_broadcast` with an override subject/body: that path
 * needs no new template, no widening of the notification_templates CHECK, and
 * is not silenced by the org pause toggles (these are explicit, low-volume
 * transactional messages a learner or admin is waiting on). Delivery is
 * fire-and-forget via notifyBackground — a mail hiccup never fails the action.
 */
import { resolveEmails } from "@/lib/users/emails";
import { notifyBackground } from "@/lib/notifications/send";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any;

import { DEFAULT_GRANT_EXPIRY_DAYS, GRANT_EXPIRY_CHOICES } from "./constants";
export { DEFAULT_GRANT_EXPIRY_DAYS, GRANT_EXPIRY_CHOICES };

/** An ISO expiry `days` from now, or null for "never". Invalid input → default. */
export function expiryFromDays(days: number | null | undefined): string | null {
  if (days === null) return null;
  const d = typeof days === "number" && Number.isFinite(days) && days > 0 ? Math.round(days) : DEFAULT_GRANT_EXPIRY_DAYS;
  return new Date(Date.now() + d * 24 * 60 * 60 * 1000).toISOString();
}

/** Admin role values that may approve/reject/bulk-grant. */
export const ADMIN_ROLES = ["super_owner", "owner", "admin"] as const;

const ADMIN_READ_ROLES = ["super_owner", "owner", "admin"];

/**
 * Email every admin of an org that a learner has asked for another attempt.
 * Fail-soft: a missing recipient or a mail error is logged, never thrown.
 */
export async function notifyAdminsOfRequest(
  svc: AnyClient,
  args: {
    orgId: string;
    orgName: string;
    orgSlug: string;
    origin: string;
    courseTitle: string;
    learnerEmail: string;
    learnerName?: string | null;
    reason: string | null;
  }
): Promise<void> {
  try {
    const { data: admins } = await svc
      .from("organization_members")
      .select("user_id")
      .eq("organization_id", args.orgId)
      .in("role", ADMIN_READ_ROLES);
    const ids = ((admins ?? []) as Array<{ user_id: string }>).map((a) => a.user_id);
    if (ids.length === 0) return;
    const emails = await resolveEmails(svc, ids);
    const link = args.origin ? `${args.origin}/${args.orgSlug}/attempt-requests` : "";
    const who = args.learnerName ? `${args.learnerName} (${args.learnerEmail})` : args.learnerEmail;
    const body =
      `**${who}** has requested another attempt at **${args.courseTitle}**.\n\n` +
      (args.reason ? `> ${args.reason}\n\n` : "") +
      `Review and approve or decline it in the Attempt Requests queue.`;
    for (const [uid, email] of emails) {
      await notifyBackground({
        organizationId: args.orgId,
        event: "custom_broadcast",
        to: { user_id: uid, email },
        context: {
          org_name: args.orgName,
          course_name: args.courseTitle,
          learner_email: args.learnerEmail,
          direct_link: link,
        },
        override: {
          subject: `Attempt request: ${args.courseTitle}`,
          body_md: body,
          buttons: link ? [{ label: "Review request", url: link }] : [],
        },
      });
    }
  } catch (e) {
    console.error("[attempt-requests] notifyAdminsOfRequest failed:", e);
  }
}

/**
 * Email a learner that their attempt request was approved or declined.
 * Fail-soft.
 */
export async function notifyLearnerOfDecision(
  svc: AnyClient,
  args: {
    orgId: string;
    orgName: string;
    orgSlug: string;
    origin: string;
    courseId: string;
    courseTitle: string;
    learner: { id: string; email: string };
    approved: boolean;
    note?: string | null;
    expiresAt?: string | null;
  }
): Promise<void> {
  try {
    if (!args.learner.email) return;
    const courseLink = args.origin ? `${args.origin}/${args.orgSlug}/courses/${args.courseId}` : "";
    const note = args.note?.trim();
    let body: string;
    let subject: string;
    if (args.approved) {
      subject = `Another attempt unlocked: ${args.courseTitle}`;
      const when = args.expiresAt
        ? `\n\nPlease use it before **${new Date(args.expiresAt).toLocaleDateString()}**.`
        : "";
      body =
        `Good news — you've been granted another official attempt at **${args.courseTitle}**.\n\n` +
        `Relaunch the course to start a fresh attempt. Your first result stays on record; this new attempt becomes your official one.${when}` +
        (note ? `\n\n_Note from your administrator:_ ${note}` : "");
    } else {
      subject = `Attempt request declined: ${args.courseTitle}`;
      body =
        `Your request for another attempt at **${args.courseTitle}** was not approved.` +
        (note ? `\n\n_Note from your administrator:_ ${note}` : "");
    }
    await notifyBackground({
      organizationId: args.orgId,
      event: "custom_broadcast",
      to: { user_id: args.learner.id, email: args.learner.email },
      context: {
        org_name: args.orgName,
        course_name: args.courseTitle,
        course_id: args.courseId,
        direct_link: courseLink,
      },
      override: {
        subject,
        body_md: body,
        buttons: args.approved && courseLink ? [{ label: "Go to course", url: courseLink }] : [],
      },
    });
  } catch (e) {
    console.error("[attempt-requests] notifyLearnerOfDecision failed:", e);
  }
}
