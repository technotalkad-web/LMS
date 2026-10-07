import { NextResponse } from "next/server";
import { originFromRequest } from "@/lib/http/origin";
import { isActionError } from "@/lib/actions/types";
import { loadTicketForCaller } from "@/lib/tickets/auth";
import { notifyRequesterOfTicket } from "@/lib/tickets/notify";
import { namesAndEmails } from "@/lib/users/people";

/**
 *   PATCH /api/tickets/[id]
 *   body: { status?, priority?, admin_note? }
 *
 * Admin-only (checked here, not only by RLS, so a non-admin gets 403 instead
 * of a silent no-op). Status can be open / in_progress / closed. A reply
 * (admin_note) or a close emails the requester; the reply is also kept on
 * the thread.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as {
    status?: "open" | "in_progress" | "closed";
    priority?: "low" | "normal" | "high";
    admin_note?: string;
  };
  const c = await loadTicketForCaller(id);
  if (isActionError(c)) return NextResponse.json({ error: c.error }, { status: c.status });
  if (c.party !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { svc, ticket, org, user } = c;

  const nowIso = new Date().toISOString();
  const update: Record<string, unknown> = { updated_at: nowIso };
  if (body.status && ["open", "in_progress", "closed"].includes(body.status)) {
    update.status = body.status;
    update.closed_at = body.status === "closed" ? nowIso : null;
  }
  if (body.priority && ["low", "normal", "high"].includes(body.priority)) update.priority = body.priority;
  const note = typeof body.admin_note === "string" ? body.admin_note.trim() : undefined;
  if (note !== undefined) update.admin_note = note || null;

  const { error } = await svc.from("help_tickets").update(update).eq("id", ticket.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  const replied = !!note && note !== (ticket.admin_note ?? "");
  if (replied) {
    await svc.from("help_ticket_messages").insert({
      organization_id: org.id, ticket_id: ticket.id, author_id: user.id, author_role: "admin", body: note,
    }).then(({ error: e }) => { if (e && (e as { code?: string }).code !== "42P01") console.warn("[tickets] thread insert:", e.message); });
  }
  const closedNow = update.status === "closed" && ticket.status !== "closed";
  if (replied || closedNow) {
    const who = (await namesAndEmails(svc, [ticket.user_id])).get(ticket.user_id);
    await notifyRequesterOfTicket(svc, {
      orgId: org.id, orgName: org.name, orgSlug: org.slug, origin: await originFromRequest(),
      requester: { id: ticket.user_id, email: who?.email ?? null },
      subject: ticket.subject,
      headline: closedNow ? "Ticket closed" : "Reply from your admin",
      message: replied ? note! : ticket.admin_note,
    });
  }
  return NextResponse.json({ ok: true });
}
