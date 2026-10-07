import { NextResponse } from "next/server";
import { originFromRequest } from "@/lib/http/origin";
import { isActionError } from "@/lib/actions/types";
import { loadTicketForCaller } from "@/lib/tickets/auth";
import { notifyRequesterOfTicket } from "@/lib/tickets/notify";
import { namesAndEmails } from "@/lib/users/people";

/**
 *   POST /api/tickets/[id]/messages
 *   body: { body }
 *
 * A reply on the ticket thread by either party: the requester (learner or
 * manager who raised it) or an admin of the org. The other side is emailed.
 * A closed ticket that gets a requester reply reopens as in_progress.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { body?: string };
  const text = body.body?.trim() ?? "";
  if (!text) return NextResponse.json({ error: "body required" }, { status: 400 });
  if (text.length > 4000) return NextResponse.json({ error: "Reply is too long (4000 characters max)" }, { status: 400 });

  const c = await loadTicketForCaller(id);
  if (isActionError(c)) return NextResponse.json({ error: c.error }, { status: c.status });
  const { svc, ticket, org, user, party } = c;
  const nowIso = new Date().toISOString();
  const { data, error } = await svc
    .from("help_ticket_messages")
    .insert({ organization_id: org.id, ticket_id: ticket.id, author_id: user.id, author_role: party, body: text })
    .select("id")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  const patch: Record<string, unknown> = { updated_at: nowIso };
  if (party === "admin") patch.admin_note = text;
  else if (ticket.status === "closed") { patch.status = "in_progress"; patch.closed_at = null; }
  await svc.from("help_tickets").update(patch).eq("id", ticket.id);

  const origin = await originFromRequest();
  if (party === "admin") {
    const who = (await namesAndEmails(svc, [ticket.user_id])).get(ticket.user_id);
    await notifyRequesterOfTicket(svc, {
      orgId: org.id, orgName: org.name, orgSlug: org.slug, origin,
      requester: { id: ticket.user_id, email: who?.email ?? null },
      subject: ticket.subject, headline: "Reply from your admin", message: text,
    });
  }
  // A requester reply reopens the ticket (above) and shows in the inbox and
  // the Attention Center; admins are emailed only when a ticket is raised.
  return NextResponse.json({ id: data.id, status: patch.status ?? ticket.status });
}
