import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient, type SupabaseClient } from "@supabase/supabase-js";
import { ADMIN_ROLES } from "@/lib/attempts/requests";
import type { ActionError } from "@/lib/actions/types";
import type { TicketCategory, TicketContext, TicketOutcome } from "./types";

export type TicketRow = {
  id: string;
  organization_id: string;
  user_id: string;
  subject: string;
  body: string | null;
  status: "open" | "in_progress" | "closed";
  priority: "low" | "normal" | "high";
  admin_note: string | null;
  source: "learner" | "manager";
  category: TicketCategory | null;
  context: TicketContext | null;
  requested_by_level: number | null;
  outcome: TicketOutcome | null;
  created_at: string;
};

export const TICKET_COLUMNS =
  "id, organization_id, user_id, subject, body, status, priority, admin_note, source, category, context, requested_by_level, outcome, outcome_at, created_at, updated_at, closed_at";

export const svcClient = () =>
  createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });

export function normalizeRole(raw: string | null | undefined): string {
  if (raw === "owner") return "super_owner";
  if (raw === "member") return "user";
  return raw ?? "";
}

export const isAdminRole = (role: string | null | undefined) =>
  (ADMIN_ROLES as readonly string[]).includes(normalizeRole(role));

export type TicketCaller = {
  svc: SupabaseClient;
  user: { id: string; email: string | null };
  org: { id: string; name: string; slug: string };
  ticket: TicketRow;
  /** admin = may act / reply as the org; requester = the person who raised it. */
  party: "admin" | "requester";
};

/**
 * Session → ticket → the caller's standing on it. An active admin of the
 * ticket's org is "admin"; the person who raised it is "requester"; anyone
 * else gets 404 (the ticket's existence is not confirmed).
 */
export async function loadTicketForCaller(ticketId: string): Promise<TicketCaller | ActionError> {
  const session = await createClient();
  const { data: { user } } = await session.auth.getUser();
  if (!user) return { error: "Unauthorized", status: 401 };
  const svc = svcClient();
  let ticket: TicketRow | null = null;
  {
    const full = await svc.from("help_tickets").select(TICKET_COLUMNS).eq("id", ticketId).maybeSingle();
    if (!full.error) ticket = full.data as TicketRow | null;
    else {
      // Pre-0095: the manager columns do not exist yet; read the old shape.
      const old = await svc.from("help_tickets").select("id, organization_id, user_id, subject, body, status, priority, admin_note, created_at").eq("id", ticketId).maybeSingle();
      const o = old.data as Omit<TicketRow, "source" | "category" | "context" | "requested_by_level" | "outcome"> | null;
      ticket = o ? { ...o, source: "learner", category: null, context: null, requested_by_level: null, outcome: null } : null;
    }
  }
  if (!ticket) return { error: "Ticket not found", status: 404 };
  const { data: mem } = await svc
    .from("organization_members")
    .select("role, status")
    .eq("organization_id", ticket.organization_id)
    .eq("user_id", user.id)
    .maybeSingle();
  const m = mem as { role: string; status: string } | null;
  const active = !!m && m.status === "active";
  const party: TicketCaller["party"] | null = active && isAdminRole(m!.role) ? "admin" : active && ticket.user_id === user.id ? "requester" : null;
  if (!party) return { error: "Ticket not found", status: 404 };
  const { data: o } = await svc.from("organizations").select("id, name, slug").eq("id", ticket.organization_id).single();
  return { svc, user: { id: user.id, email: user.email ?? null }, org: o as { id: string; name: string; slug: string }, ticket, party };
}
