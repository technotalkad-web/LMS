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
 *
 * ADR 0030 rule 10: both go only to people whose membership in the org counts
 * (active, in an organisation that is not deleted). A failed membership read
 * sends nothing.
 */
import { resolveEmails } from "@/lib/users/emails";
import { notifyBackground } from "@/lib/notifications/send";
import { countingMemberIds, resolveOrgMembership } from "@/lib/auth/org-membership";

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
 * Email every admin of an org, whose membership counts, that a learner has
 * asked for another attempt. Fail-soft: a missing recipient or a mail error
 * is logged, never thrown.
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
    // Rule 10: the administrators whose membership counts. Unreadable: no mail.
    const admins = await countingMemberIds(svc, args.orgId, ADMIN_READ_ROLES);
    if (admins === "unreadable") {
      console.warn(JSON.stringify({ event: "mail_recipients_unreadable", site: "attempt-request", org_id: args.orgId }));
      return;
    }
    const ids = [...admins];
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
 * ADR 0030 rule 10: true when the person's membership in the org counts.
 * `counting` is the org's members that count when the caller read them once
 * for several mails (countingMemberIds); else the person's own membership is
 * read here. A failed read is never "counts": no mail.
 */
async function recipientCounts(
  svc: AnyClient,
  orgId: string,
  userId: string,
  counting: ReadonlySet<string> | undefined
): Promise<boolean> {
  if (counting) return counting.has(userId);
  const m = await resolveOrgMembership(svc, { id: orgId }, userId);
  if (m === "unreadable") {
    console.warn(JSON.stringify({ event: "mail_recipients_unreadable", site: "attempt-decision", org_id: orgId }));
    return false;
  }
  return m !== "none";
}

/**
 * Email a learner that their attempt request was approved or declined (or
 * that an administrator granted them an attempt), when their membership in
 * the org counts. Fail-soft.
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
    /** The org's members that count, when the caller sends several of these in one request. */
    counting?: ReadonlySet<string>;
  }
): Promise<void> {
  try {
    if (!args.learner.email) return;
    if (!(await recipientCounts(svc, args.orgId, args.learner.id, args.counting))) return;
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
