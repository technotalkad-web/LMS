import type { SupabaseClient } from "@supabase/supabase-js";
import { RECIPIENTS_UNREADABLE, mailCounts, sendMany, sendNotification, type MailOutcome } from "@/lib/notifications/send";
import { openRun, recordRecipientsUnreadable, requestBudget } from "@/lib/notifications/smtp-state";
import { resolveEmailsStrict } from "@/lib/users/emails";
import { resolveOrgMembership } from "@/lib/auth/org-membership";

/**
 * Ticket emails (Phase 4a). Like the attempt-request mails these go out as
 * `custom_broadcast` with an override subject/body: no new template, not
 * silenced by the org pause toggles, and a mail hiccup never fails the
 * ticket. Admin roles as in lib/attempts/requests.ts.
 *
 * ADR 0030 rule 10: both go only to people whose membership in the org counts
 * (active, in an organisation that is not deleted). The admins' read filters
 * the status; the org was found live by the route's own membership check in
 * the same request. The requester's own membership is read before their mail.
 *
 * ADR 0029 (note of 2026-11-19, and part 3 of the note of 2026-11-20): a
 * failed read of the recipients or of their addresses is never "nobody".
 * Nobody is mailed, the skip is recorded (recordRecipientsUnreadable), and
 * the ticket itself still shows in the inbox and the Attention Center. The
 * administrators' mail is one run (rule FP7); the requester's is one send.
 */
const ADMIN_READ_ROLES = ["super_owner", "owner", "admin"];

export async function notifyAdminsOfTicket(
  svc: SupabaseClient,
  args: {
    orgId: string;
    orgName: string;
    orgSlug: string;
    origin: string;
    subject: string;
    requester: { name: string; email: string | null };
    categoryLabel: string;
    lines: string[];
    note: string | null;
  }
): Promise<void> {
  try {
    const { data: admins, error: adminsErr } = await svc
      .from("organization_members")
      .select("user_id")
      .eq("organization_id", args.orgId)
      .eq("status", "active")
      .in("role", ADMIN_READ_ROLES)
      .order("user_id")
      .limit(25);
    if (adminsErr || !Array.isArray(admins)) {
      await recordRecipientsUnreadable("ticket-admins", args.orgId);
      return;
    }
    // Bounded: a large tenant with dozens of admins gets the first 25 (the
    // inbox and the Attention Center carry the ticket for everyone else).
    const ids = (admins as Array<{ user_id: string }>).map((a) => a.user_id).slice(0, 25);
    if (ids.length === 0) return;
    const emails = await resolveEmailsStrict(svc, ids);
    if (emails === "unreadable") {
      await recordRecipientsUnreadable("ticket-admins", args.orgId);
      return;
    }
    const link = args.origin ? `${args.origin}/${args.orgSlug}/tickets` : "";
    const who = args.requester.email ? `${args.requester.name} (${args.requester.email})` : args.requester.name;
    const body =
      `**${who}** raised a support request from their Report Card: **${args.categoryLabel}**.\n\n` +
      args.lines.map((l) => `- ${l}`).join("\n") +
      (args.note ? `\n\n> ${args.note}` : "") +
      `\n\nReview it in Tickets → Manager requests and act from the ticket.`;
    const run = await openRun({ organizationId: args.orgId, budget: requestBudget({ spent: 8 }), db: svc });
    await sendMany(run, [...emails], ([uid, email]) => ({
      event: "custom_broadcast",
      to: { user_id: uid, email },
      context: { org_name: args.orgName, direct_link: link },
      override: {
        subject: `Manager request: ${args.subject}`,
        body_md: body,
        buttons: link ? [{ label: "Open tickets", url: link }] : [],
      },
    }));
  } catch (e) {
    console.error(JSON.stringify({ event: "ticket_mail_failed", site: "ticket-admins", org_id: args.orgId, error: e instanceof Error ? e.name : "unknown" }));
  }
}

/**
 * The requester's mail about their ticket. Their address is read here, by
 * the strict reader, after the caller's save; a failed read of it, or of
 * their membership, mails nothing and records the skip.
 *
 * The outcome is for the administrator at the screen (ADR 0029 rule T4;
 * the hand-over note of 2026-11-19, point 1): emailed or not, or nobody
 * emailed because the recipient could not be read. A requester whose
 * membership does not count is not mailed and not counted (rule 10). Null
 * when the mail part itself failed.
 */
export async function notifyRequesterOfTicket(
  svc: SupabaseClient,
  args: {
    orgId: string;
    orgName: string;
    orgSlug: string;
    origin: string;
    requester: { id: string };
    subject: string;
    /** What happened, in one line: "Retry granted", "Reply from your admin", … */
    headline: string;
    message: string | null;
  }
): Promise<MailOutcome | null> {
  try {
    // Rule 10: a requester whose membership does not count gets no mail.
    const m = await resolveOrgMembership(svc, { id: args.orgId }, args.requester.id);
    if (m === "unreadable") {
      await recordRecipientsUnreadable("ticket-requester", args.orgId);
      return RECIPIENTS_UNREADABLE;
    }
    if (m === "none") return mailCounts([]);
    const emails = await resolveEmailsStrict(svc, [args.requester.id]);
    if (emails === "unreadable") {
      await recordRecipientsUnreadable("ticket-requester", args.orgId);
      return RECIPIENTS_UNREADABLE;
    }
    const email = emails.get(args.requester.id);
    if (!email) return mailCounts([], 1);
    const link = args.origin ? `${args.origin}/${args.orgSlug}/support` : "";
    const body =
      `**${args.headline}** on your ticket **${args.subject}**.` +
      (args.message ? `\n\n> ${args.message}` : "") +
      `\n\nOpen Help & Support to see the full thread.`;
    const sent = await sendNotification({
      organizationId: args.orgId,
      event: "custom_broadcast",
      to: { user_id: args.requester.id, email },
      context: { org_name: args.orgName, direct_link: link },
      override: {
        subject: `${args.headline}: ${args.subject}`,
        body_md: body,
        buttons: link ? [{ label: "Open Help & Support", url: link }] : [],
      },
    });
    return mailCounts([sent]);
  } catch (e) {
    console.error(JSON.stringify({ event: "ticket_mail_failed", site: "ticket-requester", org_id: args.orgId, error: e instanceof Error ? e.name : "unknown" }));
    return null;
  }
}
