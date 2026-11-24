import type { SupabaseClient } from "@supabase/supabase-js";
import { RECIPIENTS_UNREADABLE, mailCounts, sendMany, sendNotification, type MailCounts, type MailOutcome } from "@/lib/notifications/send";
import {
  ADMIN_REQUEST_OWN_CALLS,
  GROUP_TAIL_CALLS,
  MAIL_CALL_COSTS,
  hasRoom,
  openRun,
  recordRecipientsUnreadable,
  requestBudget,
  spendCalls,
  type MailBudget,
  type MailRun,
} from "@/lib/notifications/smtp-state";
import { resolveEmailsStrict } from "@/lib/users/emails";
import { resolveOrgMembership } from "@/lib/auth/org-membership";

/**
 * Ticket emails (Phase 4a). Like the attempt-request mails these go out as
 * `custom_broadcast` with an override subject/body: no new template, stopped
 * by the organisation's pause like every event but a reset code and a
 * sign-in link (ADR 0029, the owner's decision of 2026-11-21), and a mail
 * hiccup never fails the ticket. Admin roles as in lib/attempts/requests.ts.
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
 * administrators' mail is one run (rule FP7); the requester's is one send,
 * in the request's own run when the request mails others too (a ticket's
 * action: one run per request).
 */
const ADMIN_READ_ROLES = ["super_owner", "owner", "admin"];

/**
 * The administrators' mail about a new manager ticket, in one run.
 *
 * ADR 0029 rule FP2: `budget` is the request's, its count holding the calls
 * the request made before this (POST /api/tickets counts from its first
 * call, the middleware's). The reads made here are counted on it where they
 * are made, and the run is opened on it, so the mail is sized on the calls
 * really made; what it has no room for is left. Without one, the count
 * starts at the route's own calls.
 */
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
    /** The request's budget, its count holding the request's calls so far. */
    budget?: MailBudget;
  }
): Promise<void> {
  try {
    const budget = args.budget ?? requestBudget({ spent: ADMIN_REQUEST_OWN_CALLS });
    // The administrators: one call (at most 25 rows).
    spendCalls(budget, 1);
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
    // Their addresses: one call (25 ids fit one).
    spendCalls(budget, 1);
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
    const run = await openRun({ organizationId: args.orgId, budget, db: svc });
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

/** The requester's membership: the organisation and the member row, read together. */
const MEMBERSHIP_CALLS = 2;
/** The calls the requester's mail reads before its send: their membership and their address. */
export const REQUESTER_READ_CALLS = MEMBERSHIP_CALLS + 1;
/** The least the requester's mail makes when it goes: its three reads, its send and its log row (ADR 0029, note of 2026-11-24). */
export const REQUESTER_HELD_CALLS = REQUESTER_READ_CALLS + MAIL_CALL_COSTS.send + MAIL_CALL_COSTS.logInsert;

/**
 * The requester's outcome when the request had no room left for their mail
 * (ADR 0029 rules T4 and FP2): one mail not emailed, and `left` says why.
 * Never dropped in silence. Only this answer carries `left`.
 */
export type RequesterMailOutcome = MailOutcome | (MailCounts & { left: 1 });
const LEFT_FOR_ROOM: MailCounts & { left: 1 } = { recipients_unreadable: false, emailed: 0, not_emailed: 1, not_confirmed: 0, left: 1 };

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
 *
 * `budget` and `run`: the request's, when it sent other mail before this
 * one (a ticket's action), so the request is one run with one count (rule
 * FP2). The reads are then counted on it, and are made only while it has
 * room for them, for the run's opening when no run is open yet, and for
 * one send with its group's tail; the mail goes in that run, opened on the
 * budget when the request had none. A mail with no room is left: not
 * attempted, no row, and answered as not emailed with `left`. Without
 * them, the mail is one send on its own, as before.
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
  },
  opts: { budget?: MailBudget; run?: MailRun } = {}
): Promise<RequesterMailOutcome | null> {
  try {
    const budget = opts.run?.budget ?? opts.budget;
    if (budget) {
      const opening = opts.run ? 0 : MAIL_CALL_COSTS.open;
      if (!hasRoom(budget, REQUESTER_READ_CALLS + opening + MAIL_CALL_COSTS.send + GROUP_TAIL_CALLS)) return LEFT_FOR_ROOM;
      spendCalls(budget, MEMBERSHIP_CALLS);
    }
    // Rule 10: a requester whose membership does not count gets no mail.
    const m = await resolveOrgMembership(svc, { id: args.orgId }, args.requester.id);
    if (m === "unreadable") {
      await recordRecipientsUnreadable("ticket-requester", args.orgId);
      return RECIPIENTS_UNREADABLE;
    }
    if (m === "none") return mailCounts([]);
    // The address: one call.
    if (budget) spendCalls(budget, 1);
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
    const run = budget ? (opts.run ?? (await openRun({ organizationId: args.orgId, budget, db: svc }))) : undefined;
    const sent = await sendNotification(
      {
        organizationId: args.orgId,
        event: "custom_broadcast",
        to: { user_id: args.requester.id, email },
        context: { org_name: args.orgName, direct_link: link },
        override: {
          subject: `${args.headline}: ${args.subject}`,
          body_md: body,
          buttons: link ? [{ label: "Open Help & Support", url: link }] : [],
        },
      },
      run ? { run } : {}
    );
    return sent.errorClass === "left" ? LEFT_FOR_ROOM : mailCounts([sent]);
  } catch (e) {
    console.error(JSON.stringify({ event: "ticket_mail_failed", site: "ticket-requester", org_id: args.orgId, error: e instanceof Error ? e.name : "unknown" }));
    return null;
  }
}
