import { NextResponse } from "next/server";
import { originFromRequest } from "@/lib/http/origin";
import { isActionError } from "@/lib/actions/types";
import { loadTicketForCaller } from "@/lib/tickets/auth";
import { actOnTicket, type TicketAction } from "@/lib/tickets/actions";

const ACTIONS: TicketAction[] = ["grant_retry", "assign", "extend_due", "decline", "resolve"];

/**
 *   POST /api/tickets/[id]/act
 *   body: { action: grant_retry | assign | extend_due | decline | resolve, note?, dueAt?, expires_in_days? }
 *
 * Admin-only (decision 12: managers raise, admins act). Runs the matching
 * admin operation on the ticket's context (same code as the admin screens),
 * closes the ticket with an outcome and emails the requester.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as {
    action?: string; note?: string; dueAt?: string | null; expires_in_days?: number | null;
  };
  if (!body.action || !ACTIONS.includes(body.action as TicketAction)) {
    return NextResponse.json({ error: `action must be one of ${ACTIONS.join(", ")}` }, { status: 400 });
  }
  const c = await loadTicketForCaller(id);
  if (isActionError(c)) return NextResponse.json({ error: c.error }, { status: c.status });
  if (c.party !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (c.ticket.status === "closed" && c.ticket.outcome) {
    return NextResponse.json({ error: "This ticket is already closed with an outcome" }, { status: 409 });
  }
  const r = await actOnTicket(c.svc, {
    ticket: c.ticket, admin: { id: c.user.id }, org: c.org, origin: await originFromRequest(),
    action: body.action as TicketAction,
    note: typeof body.note === "string" ? body.note.slice(0, 2000) : null,
    dueAt: typeof body.dueAt === "string" ? body.dueAt : null,
    expiresInDays: body.expires_in_days === null || typeof body.expires_in_days === "number" ? body.expires_in_days : undefined,
  });
  if (isActionError(r)) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ ok: true, ...r });
}
