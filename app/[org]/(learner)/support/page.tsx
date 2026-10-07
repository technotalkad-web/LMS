import { LifeBuoy } from "lucide-react";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { fetchByIds } from "@/lib/db/chunked";
import { memberIdsInOrg, namesAndEmails } from "@/lib/users/people";
import type { TicketCategory, TicketContext, TicketMessage, TicketOutcome } from "@/lib/tickets/types";
import { SupportClient, type LearnerTicket } from "./support-client";

export const dynamic = "force-dynamic";

type Row = {
  id: string; subject: string; body: string | null; status: LearnerTicket["status"]; priority: LearnerTicket["priority"];
  admin_note: string | null; created_at: string; updated_at: string;
  source?: "learner" | "manager"; category?: TicketCategory | null; context?: TicketContext | null; outcome?: TicketOutcome | null;
};

export default async function SupportPage({ params }: { params: Promise<{ org: string }> }) {
  const { org: orgSlug } = await params;
  const { user, org } = await requireOrgAccess(orgSlug);

  const supabase = await createClient();
  // Own tickets, under RLS. Pre-0095 the manager columns do not exist yet: fall back.
  let rows: Row[] = [];
  {
    const full = await supabase
      .from("help_tickets")
      .select("id, subject, body, status, priority, admin_note, created_at, updated_at, source, category, context, outcome")
      .eq("organization_id", org.id).eq("user_id", user.id).order("created_at", { ascending: false });
    if (!full.error) rows = (full.data ?? []) as Row[];
    else {
      const old = await supabase
        .from("help_tickets")
        .select("id, subject, body, status, priority, admin_note, created_at, updated_at")
        .eq("organization_id", org.id).eq("user_id", user.id).order("created_at", { ascending: false });
      rows = (old.data ?? []) as Row[];
    }
  }

  // Thread + the names a manager ticket refers to (people the requester named themselves).
  const svc = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  let messages: Array<TicketMessage & { ticket_id: string }> = [];
  try {
    messages = rows.length
      ? await fetchByIds<TicketMessage & { ticket_id: string }>(svc, "help_ticket_messages", "id, ticket_id, author_id, author_role, body, created_at", "ticket_id", rows.map((r) => r.id), undefined, "created_at")
      : [];
  } catch {
    /* pre-0095 */
  }
  const ids = new Set<string>();
  for (const r of rows) for (const id of r.context?.userIds ?? []) ids.add(id);
  const names = await namesAndEmails(svc, await memberIdsInOrg(svc, org.id, ids));

  const tickets: LearnerTicket[] = rows.map((r) => ({
    id: r.id, subject: r.subject, body: r.body, status: r.status, priority: r.priority, admin_note: r.admin_note,
    created_at: r.created_at, updated_at: r.updated_at,
    source: r.source ?? "learner", category: r.category ?? null, outcome: r.outcome ?? null,
    context: r.context
      ? {
          contentTitle: r.context.contentTitle,
          contentKind: r.context.contentKind,
          people: (r.context.userIds ?? []).map((id) => names.get(id)?.name ?? "—"),
          exception: r.context.exception,
          dueAt: r.context.dueAt ?? null,
        }
      : null,
    messages: messages.filter((m) => m.ticket_id === r.id).map((m) => ({ id: m.id, role: m.author_role, body: m.body, at: m.created_at })),
  }));
  const isManagerUser = tickets.some((t) => t.source === "manager");

  return (
    <div className="max-w-2xl mx-auto space-y-8">
      <div className="text-center">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-indigo-100 text-indigo-600 mb-4">
          <LifeBuoy className="w-8 h-8" />
        </div>
        <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight">How can we help?</h1>
        <p className="text-muted mt-2 text-sm">
          Open a ticket and a {org.name} admin will get back to you.
          {isManagerUser ? " Requests you raise from Team Performance arrive here too." : ""}
        </p>
      </div>

      <SupportClient orgSlug={orgSlug} tickets={tickets} />
    </div>
  );
}
