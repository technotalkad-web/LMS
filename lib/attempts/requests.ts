/**
 * Attempt-request helpers (revision rule, Phase 2) — grant expiry + the two
 * notification fan-outs shared by the learner request route, the admin decide
 * route and the bulk-grant route.
 *
 * Emails go out as `custom_broadcast` with an override subject/body: that path
 * needs no new template and no widening of the notification_templates CHECK.
 * The organisation's pause, master or per event, stops them as it stops every
 * event but a reset code and a sign-in link (ADR 0029, the owner's decision
 * of 2026-11-21). A mail hiccup never fails the action.
 *
 * ADR 0030 rule 10: both go only to people whose membership in the org counts
 * (active, in an organisation that is not deleted).
 *
 * ADR 0029 (note of 2026-11-19; part 3 of the note of 2026-11-20): a failed
 * read of the recipients or of their addresses is never "nobody": nobody is
 * mailed and the skip is recorded (recordRecipientsUnreadable). The
 * administrators' mail is one run (rule FP7). A learner's decision mail is
 * one send, inside the caller's run when it sends several.
 */
import { resolveEmailsStrict } from "@/lib/users/emails";
import { RECIPIENTS_UNREADABLE, addMailOutcome, mailCounts, sendMany, sendNotification, type MailOutcome } from "@/lib/notifications/send";
import { ADMIN_REQUEST_OWN_CALLS, openRun, recordRecipientsUnreadable, requestBudget, type MailBudget, type MailRun } from "@/lib/notifications/smtp-state";
import { countingMemberIds, resolveOrgMembership } from "@/lib/auth/org-membership";
// Type only: the forced restart takes its notifier as an argument.
import type { ForceRestartNotify } from "./force-restart";

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
 * asked for another attempt, in one run. A failed read of the
 * administrators or of their addresses mails nobody and records the skip:
 * the request itself still shows in the queue and the Attention Center.
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
    // Rule 10: the administrators whose membership counts.
    const admins = await countingMemberIds(svc, args.orgId, ADMIN_READ_ROLES);
    if (admins === "unreadable") {
      await recordRecipientsUnreadable("attempt-request", args.orgId);
      return;
    }
    const ids = [...admins];
    if (ids.length === 0) return;
    const emails = await resolveEmailsStrict(svc, ids);
    if (emails === "unreadable") {
      await recordRecipientsUnreadable("attempt-request", args.orgId);
      return;
    }
    const link = args.origin ? `${args.origin}/${args.orgSlug}/attempt-requests` : "";
    const who = args.learnerName ? `${args.learnerName} (${args.learnerEmail})` : args.learnerEmail;
    const body =
      `**${who}** has requested another attempt at **${args.courseTitle}**.\n\n` +
      (args.reason ? `> ${args.reason}\n\n` : "") +
      `Review and approve or decline it in the Attempt Requests queue.`;
    const run = await openRun({ organizationId: args.orgId, budget: requestBudget({ spent: 8 }), db: svc });
    await sendMany(run, [...emails], ([uid, email]) => ({
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
    }));
  } catch (e) {
    console.error(JSON.stringify({ event: "attempt_request_mail_failed", site: "attempt-request", org_id: args.orgId, error: e instanceof Error ? e.name : "unknown" }));
  }
}

/**
 * ADR 0030 rule 10: true when the person's membership in the org counts.
 * `counting` is the org's members that count when the caller read them once
 * for several mails (countingMemberIds); else the person's own membership is
 * read here. A failed read is never "counts": no mail, the skip recorded
 * once, and the answer "unreadable".
 */
async function recipientCounts(
  svc: AnyClient,
  orgId: string,
  userId: string,
  counting: ReadonlySet<string> | undefined
): Promise<boolean | "unreadable"> {
  if (counting) return counting.has(userId);
  const m = await resolveOrgMembership(svc, { id: orgId }, userId);
  if (m === "unreadable") {
    await recordRecipientsUnreadable("attempt-decision", orgId);
    return "unreadable";
  }
  return m !== "none";
}

/**
 * Email a learner that their attempt request was approved or declined (or
 * that an administrator granted them an attempt), when their membership in
 * the org counts. Fail-soft.
 *
 * The outcome is for the administrator at the screen (ADR 0029 rule T4):
 * emailed or not, or nobody emailed because the learner's membership could
 * not be read. A learner whose membership does not count is not mailed and
 * not counted (rule 10). Null when the mail part itself failed.
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
    /** The caller's run, when it sends several of these in one request: they share its stop rule and budgets. */
    run?: MailRun;
  }
): Promise<MailOutcome | null> {
  try {
    if (!args.learner.email) return mailCounts([], 1);
    const counts = await recipientCounts(svc, args.orgId, args.learner.id, args.counting);
    if (counts === "unreadable") return RECIPIENTS_UNREADABLE;
    if (!counts) return mailCounts([]);
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
    const sent = await sendNotification(
      {
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
      },
      args.run ? { run: args.run } : {}
    );
    return mailCounts([sent]);
  } catch (e) {
    console.error(JSON.stringify({ event: "attempt_request_mail_failed", site: "attempt-decision", org_id: args.orgId, error: e instanceof Error ? e.name : "unknown" }));
    return null;
  }
}

/**
 * The notifier a forced restart's re-issue takes (ADR 0014 step 8), built
 * on notifyLearnerOfDecision, the strict address reader and the skip helper
 * (ADR 0029), and keeping the mails' outcome for the administrator at the
 * screen (rule T4): emailed and not, or nobody emailed because the
 * recipients could not be read. The route answers the outcome beside the
 * restart's report, never inside it. Undefined when no re-issue was mailed.
 *
 * The re-issue mails of one request are one run (rule T4), as every other
 * loop of mail an administrator starts: one read of the organisation's
 * state, its stop rule (an organisation already failing is tried once, by
 * the probe) and the request's budgets. The run opens at the first mail
 * that has someone to reach, never for nobody. `budget`: the request's,
 * when the request sends other mail too, so all of it draws on one count
 * and one clock; else one for this request.
 */
export function reissueNotifier(opts: { budget?: MailBudget } = {}): { notify: ForceRestartNotify; outcome: () => MailOutcome | undefined } {
  let outcome: MailOutcome | undefined;
  const budget = opts.budget ?? requestBudget({ spent: ADMIN_REQUEST_OWN_CALLS });
  let run: MailRun | undefined;
  const notify: ForceRestartNotify = {
    decision: async (svc, args) => {
      if (args.learner.email && (!args.counting || args.counting.has(args.learner.id))) {
        run ??= await openRun({ organizationId: args.orgId, budget, db: svc });
      }
      const one = await notifyLearnerOfDecision(svc, { ...args, run });
      outcome = addMailOutcome(outcome && !outcome.recipients_unreadable ? outcome : mailCounts([]), one);
      return one;
    },
    emails: resolveEmailsStrict,
    skipped: async (site, organizationId) => {
      outcome = RECIPIENTS_UNREADABLE;
      await recordRecipientsUnreadable(site, organizationId);
    },
  };
  return { notify, outcome: () => outcome };
}

