import type { SupabaseClient } from "@supabase/supabase-js";
import { grantExtraAttempts } from "@/lib/attempts/grant";
import { assignCourseDirect } from "@/lib/assignments/direct";
import { isActionError, type ActionError, type PerLearnerResult } from "@/lib/actions/types";
import { REQUESTER_HELD_CALLS, notifyRequesterOfTicket, type RequesterMailOutcome } from "./notify";
import type { MailOutcome } from "@/lib/notifications/send";
import { ADMIN_REQUEST_OWN_CALLS, requestBudget, spendCalls, type MailBudget, type MailRun } from "@/lib/notifications/smtp-state";
import { OUTCOME_LABEL, type TicketOutcome } from "./types";
import type { TicketRow } from "./auth";

export type TicketAction = "grant_retry" | "assign" | "extend_due" | "decline" | "resolve";

/** The ticket's close and its thread message: two calls after the action, made whatever its mail did. */
const TICKET_CLOSE_CALLS = 2;

/**
 * An admin acts on a manager's ticket from the inbox (Phase 4a §3): the
 * one-click actions run the same code the admin screens use, then the ticket
 * is closed with an outcome, a thread message and an email to the requester.
 * Nothing here checks the role — the route does (admin only).
 *
 * ADR 0029 rule FP2: the request is one budget and one run. `budget` is
 * the request's, its count holding the calls made before this (the route's
 * session, ticket and membership, and the middleware's). Every call made
 * here is counted on it: the people still active, the action's own reads
 * and writes, and its learners' mail, in a run it hands back. The ticket's
 * close and its thread message are held back on the count before the
 * action, and so is the requester's room (REQUESTER_HELD_CALLS: the least
 * their mail makes when it goes; ADR 0029, note of 2026-11-24), so the
 * learners' mail is sized without them. The requester's hold is given back
 * just before their mail, which then counts its own calls where it makes
 * them (fewer when their membership does not count or no address is
 * found); the close's two are always made. The requester's mail goes in
 * the same run (opened here when the action mailed nobody), or, with no
 * room left (the clock, or a last group that needed more of its tail), is
 * left and answered as such (`left`).
 */
export async function actOnTicket(
  svc: SupabaseClient,
  args: {
    ticket: TicketRow;
    admin: { id: string };
    org: { id: string; name: string; slug: string };
    origin: string;
    action: TicketAction;
    note?: string | null;
    dueAt?: string | null;
    expiresInDays?: number | null;
    budget?: MailBudget;
  }
): Promise<ActionError | { outcome: TicketOutcome; summary: string; results: PerLearnerResult[]; email?: MailOutcome | null; requester_email: RequesterMailOutcome | null }> {
  const { ticket } = args;
  const note = args.note?.trim() || null;
  const budget = args.budget ?? requestBudget({ spent: ADMIN_REQUEST_OWN_CALLS });
  // Held back: the close and its thread message come after the action's
  // mail, whatever it does (they are not counted again when made).
  spendCalls(budget, TICKET_CLOSE_CALLS);
  // Held back too: the requester's room, given back before their mail.
  spendCalls(budget, REQUESTER_HELD_CALLS);
  // The request's one run, when the action opened one for its learners' mail.
  let run: MailRun | undefined;
  // The context was verified when the ticket was raised; people may have left
  // since. Act only on those still active in the org (the admin acts org-wide).
  let ctx = ticket.context;
  if (ctx && ctx.userIds.length) {
    spendCalls(budget, 1);
    const { data: rows, error: rowsErr } = await svc
      .from("organization_members")
      .select("user_id")
      .eq("organization_id", args.org.id)
      .eq("status", "active")
      .in("user_id", ctx.userIds);
    // A failed read is never "nobody is active" (ADR 0029, part 3): the
    // action and its mail rest on it, so nothing is done.
    if (rowsErr) return { error: "Could not read who is on this ticket. Nothing was changed; try again.", status: 503 };
    const active = new Set(((rows ?? []) as Array<{ user_id: string }>).map((r) => r.user_id));
    ctx = { ...ctx, userIds: ctx.userIds.filter((id) => active.has(id)) };
    if (ctx.userIds.length === 0 && (args.action === "grant_retry" || args.action === "assign" || args.action === "extend_due")) {
      return { error: "None of the people on this ticket is an active member any more", status: 409 };
    }
  }
  let outcome: TicketOutcome;
  let summary: string;
  let results: PerLearnerResult[] = [];
  // The mail's outcome for the people on the ticket (an assignment's, or a
  // granted retry's), for the administrator at the screen (ADR 0029 rule T4).
  let email: MailOutcome | null | undefined;

  const wordsFor = (rs: PerLearnerResult[], done: PerLearnerResult["status"], verb: string) => {
    const ok = rs.filter((r) => r.status === done || (done === "assigned" && r.status === "already" && /updated/.test(r.reason ?? ""))).length;
    const skipped = rs.filter((r) => r.status !== done && !(done === "assigned" && r.status === "already" && /updated/.test(r.reason ?? "")));
    const reasons = [...new Set(skipped.map((r) => r.reason).filter(Boolean))];
    return { ok, text: `${verb} ${ok} of ${rs.length}` + (skipped.length ? ` · ${skipped.length} skipped${reasons.length ? ` (${reasons.join("; ")})` : ""}` : "") };
  };

  if (args.action === "grant_retry") {
    if (!ctx || ctx.contentKind !== "course" || !ctx.contentId || ctx.userIds.length === 0) return { error: "This ticket names no course and people to grant", status: 400 };
    const r = await grantExtraAttempts(svc, {
      orgId: args.org.id, orgName: args.org.name, orgSlug: args.org.slug, origin: args.origin,
      decidedBy: args.admin.id, source: "ticket", courseId: ctx.contentId, userIds: ctx.userIds, expiresInDays: args.expiresInDays,
      budget,
    });
    if (isActionError(r)) return r;
    results = r.results;
    email = r.email;
    run = r.run;
    const w = wordsFor(results, "granted", "Retry granted to");
    if (w.ok === 0) return { error: `Nobody could be granted a retry: ${w.text.replace(/^.*?· /, "")}`, status: 409 };
    outcome = "granted";
    summary = `${w.text} on ${r.courseTitle}.`;
  } else if (args.action === "assign" || args.action === "extend_due") {
    if (!ctx || ctx.contentKind !== "course" || !ctx.contentId || ctx.userIds.length === 0) return { error: "This ticket names no course and people to assign", status: 400 };
    const dueAt = args.dueAt ?? ctx.dueAt ?? null;
    if (args.action === "extend_due" && !dueAt) return { error: "A new due date is required", status: 400 };
    const r = await assignCourseDirect(svc, {
      orgId: args.org.id, orgName: args.org.name, orgSlug: args.org.slug, origin: args.origin,
      assignedBy: args.admin.id, courseId: ctx.contentId, userIds: ctx.userIds, dueAt,
      notify: args.action !== "extend_due",
      budget,
    });
    if (isActionError(r)) return r;
    results = r.results;
    email = r.email;
    run = r.run;
    if (args.action === "extend_due") {
      const n = results.filter((x) => x.status === "assigned" || (x.status === "already" && /updated/.test(x.reason ?? ""))).length;
      if (n === 0) return { error: "The due date could not be updated for anyone", status: 409 };
      outcome = "extended";
      // The new date lives on each person's DIRECT assignment (created if they
      // held the course via a team / group / org row); the Report Card treats a
      // direct date as the one that applies to that person.
      summary = `Due date set to ${r.dueAt?.slice(0, 10) ?? dueAt} for ${n} of ${results.length} on ${r.courseTitle} (as a direct assignment for each person).`;
    } else {
      const w = wordsFor(results, "assigned", "Assigned");
      if (w.ok === 0) return { error: `Nobody could be assigned: ${w.text.replace(/^.*?· /, "")}`, status: 409 };
      outcome = "assigned";
      summary = `${w.text} on ${r.courseTitle}${r.dueAt ? ` · due ${r.dueAt.slice(0, 10)}` : ""}.`;
    }
  } else if (args.action === "decline") {
    outcome = "declined";
    summary = note ? `Declined: ${note}` : "Declined.";
  } else {
    outcome = "resolved";
    summary = note ? `Resolved: ${note}` : "Resolved.";
  }

  const nowIso = new Date().toISOString();
  const adminNote = note && outcome !== "declined" && outcome !== "resolved" ? `${summary} ${note}` : summary;
  const { error } = await svc
    .from("help_tickets")
    .update({ status: "closed", closed_at: nowIso, updated_at: nowIso, outcome, outcome_at: nowIso, outcome_by: args.admin.id, admin_note: adminNote })
    .eq("id", ticket.id);
  if (error) return { error: error.message, status: 400 };
  await svc.from("help_ticket_messages").insert({
    organization_id: args.org.id, ticket_id: ticket.id, author_id: args.admin.id, author_role: "admin", body: adminNote,
  });
  // The requester's mail, in the request's one run and budget, and its
  // outcome for the administrator (rule T4): left, and said so, when the
  // request has no room for it after all. Its hold is given back first: it
  // counts its own calls where it makes them.
  spendCalls(budget, -REQUESTER_HELD_CALLS);
  const requesterEmail = await notifyRequesterOfTicket(
    svc,
    {
      orgId: args.org.id, orgName: args.org.name, orgSlug: args.org.slug, origin: args.origin,
      requester: { id: ticket.user_id },
      subject: ticket.subject, headline: OUTCOME_LABEL[outcome], message: adminNote,
    },
    { budget, run }
  );
  return { outcome, summary, results, ...(email !== undefined ? { email } : {}), requester_email: requesterEmail };
}
