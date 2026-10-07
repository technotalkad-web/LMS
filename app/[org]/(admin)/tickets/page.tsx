import { redirect } from "next/navigation";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { canManage } from "@/lib/auth/permissions";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { fetchByIds } from "@/lib/db/chunked";
import { memberIdsInOrg, namesAndEmails } from "@/lib/users/people";
import { TICKET_COLUMNS } from "@/lib/tickets/auth";
import type { TicketCategory, TicketContext, TicketMessage, TicketOutcome } from "@/lib/tickets/types";
import { TicketsInbox, type TicketView } from "./tickets-inbox";

export const dynamic = "force-dynamic";

type Row = {
  id: string; user_id: string; subject: string; body: string | null; status: TicketView["status"]; priority: TicketView["priority"];
  admin_note: string | null; created_at: string; updated_at: string;
  source?: "learner" | "manager"; category?: TicketCategory | null; context?: TicketContext | null;
  requested_by_level?: number | null; outcome?: TicketOutcome | null; outcome_at?: string | null;
};

/**
 * Admin ticket inbox. Manager tickets (Phase 4a) arrive with their context:
 * the people (links to Learner 360), the content (link to its admin page),
 * the exception and the thread; the admin acts from the card.
 */
export default async function TicketsPage({ params }: { params: Promise<{ org: string }> }) {
  const { org: orgSlug } = await params;
  const { org, role } = await requireOrgAccess(orgSlug);
  if (!canManage(role)) redirect(`/${orgSlug}/dashboard?denied=1`);

  const svc = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  // Pre-0095 the manager columns do not exist yet: fall back to the old shape.
  let rows: Row[] = [];
  {
    // The latest 500: the inbox is a work queue, not an archive.
    const full = await svc.from("help_tickets").select(TICKET_COLUMNS).eq("organization_id", org.id).order("created_at", { ascending: false }).limit(500);
    if (!full.error) rows = (full.data ?? []) as Row[];
    else {
      const old = await svc.from("help_tickets").select("id, user_id, subject, body, status, priority, admin_note, created_at, updated_at").eq("organization_id", org.id).order("created_at", { ascending: false }).limit(500);
      rows = (old.data ?? []) as Row[];
    }
  }

  const ticketIds = rows.map((r) => r.id);
  let messages: Array<TicketMessage & { ticket_id: string }> = [];
  try {
    messages = ticketIds.length
      ? await fetchByIds<TicketMessage & { ticket_id: string }>(svc, "help_ticket_messages", "id, ticket_id, author_id, author_role, body, created_at", "ticket_id", ticketIds, undefined, "created_at")
      : [];
  } catch {
    /* pre-0095 */
  }
  // Names only for people of THIS org (a context id that is not a member shows as "—").
  const ctxIds = new Set<string>();
  for (const r of rows) for (const id of r.context?.userIds ?? []) ctxIds.add(id);
  const members = await memberIdsInOrg(svc, org.id, ctxIds);
  const peopleIds = new Set<string>([...members]);
  for (const r of rows) peopleIds.add(r.user_id);
  for (const m of messages) peopleIds.add(m.author_id);
  const people = await namesAndEmails(svc, peopleIds);
  const nameOf = (id: string) => people.get(id)?.name ?? id.slice(0, 8);
  const byTicket = new Map<string, typeof messages>();
  for (const m of messages) byTicket.set(m.ticket_id, [...(byTicket.get(m.ticket_id) ?? []), m]);

  const contentHref = (ctx: TicketContext) =>
    !ctx.contentId ? null
      : ctx.contentKind === "course" ? `/${orgSlug}/library/${ctx.contentId}`
      : ctx.contentKind === "path" ? `/${orgSlug}/learning-paths`
      : `/${orgSlug}/journey-admin?program=${ctx.contentId}`;

  const tickets: TicketView[] = rows.map((r) => {
    const ctx = r.context ?? null;
    return {
      id: r.id, subject: r.subject, body: r.body, status: r.status, priority: r.priority, admin_note: r.admin_note,
      created_at: r.created_at, updated_at: r.updated_at,
      source: r.source ?? "learner", category: r.category ?? null, requestedByLevel: r.requested_by_level ?? null,
      outcome: r.outcome ?? null, outcomeAt: r.outcome_at ?? null,
      requester: { id: r.user_id, name: nameOf(r.user_id), email: people.get(r.user_id)?.email ?? "" },
      people: (ctx?.userIds ?? []).map((id) => ({ userId: id, name: members.has(id) ? nameOf(id) : "— (not a member)", href: `/${orgSlug}/analytics?learner=${id}` })),
      content: ctx?.contentId && ctx.contentKind ? { kind: ctx.contentKind, id: ctx.contentId, title: ctx.contentTitle ?? "", href: contentHref(ctx) } : null,
      exception: ctx?.exception ?? null,
      dueAt: ctx?.dueAt ?? null,
      messages: (byTicket.get(r.id) ?? []).map((m) => ({ id: m.id, role: m.author_role, author: nameOf(m.author_id), body: m.body, at: m.created_at })),
    };
  });

  return <TicketsInbox tickets={tickets} orgSlug={orgSlug} orgName={org.name} />;
}
