import type { SupabaseClient } from "@supabase/supabase-js";
import { loadManagerContext } from "@/lib/manager/access";
import { namesAndEmails } from "@/lib/users/people";
import { CATEGORY_LABEL, MAX_TICKET_PEOPLE, type TicketCategory, type TicketContext } from "./types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ContextError = { error: string; status: 400 | 403 };

/**
 * Validate a manager ticket's context against the server's view of the
 * viewer's hierarchy (decision 3): every named person must be in scope, the
 * content must belong to the org (its title is taken from the database), and
 * the viewer must be a manager at all. Refuses the whole ticket on any
 * out-of-scope id — never a partial ticket.
 */
export async function validateManagerContext(
  svc: SupabaseClient,
  orgId: string,
  viewerId: string,
  raw: unknown
): Promise<{ context: TicketContext; level: number } | ContextError> {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const idsRaw = Array.isArray(r.userIds) ? r.userIds : [];
  if (idsRaw.length > MAX_TICKET_PEOPLE) return { error: `At most ${MAX_TICKET_PEOPLE} people per ticket`, status: 400 };
  if (!idsRaw.every((x) => typeof x === "string" && UUID_RE.test(x))) return { error: "userIds must be ids", status: 400 };
  const userIds = [...new Set(idsRaw as string[])];

  const ctx = await loadManagerContext(svc, orgId, viewerId);
  if (!ctx.isManager) return { error: "Only a manager may raise a ticket from the Report Card", status: 403 };
  if (userIds.some((id) => !ctx.scope.all.has(id))) return { error: "Someone named is outside your reporting line", status: 403 };

  const kindRaw = r.contentKind;
  const contentKind = kindRaw === "course" || kindRaw === "path" || kindRaw === "journey" ? kindRaw : null;
  const contentIdRaw = typeof r.contentId === "string" && UUID_RE.test(r.contentId) ? r.contentId : null;
  let contentId: string | null = null;
  let contentTitle: string | null = null;
  if (contentKind && contentIdRaw) {
    const table = contentKind === "course" ? "courses" : contentKind === "path" ? "learning_paths" : "journey_programs";
    const col = contentKind === "course" ? "id, title" : "id, name";
    const { data } = await svc.from(table).select(col).eq("id", contentIdRaw).eq("organization_id", orgId).maybeSingle();
    const row = data as { id: string; title?: string; name?: string } | null;
    if (!row) return { error: "Content not found", status: 400 };
    contentId = row.id;
    contentTitle = row.title ?? row.name ?? null;
  }
  const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
  const dueAt = typeof r.dueAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.dueAt) && new Date(`${r.dueAt}T00:00:00Z`).toISOString().slice(0, 10) === r.dueAt ? r.dueAt : null;
  return {
    level: ctx.scope.level,
    context: {
      userIds,
      contentKind: contentId ? contentKind : null,
      contentId,
      contentTitle,
      exception: str(r.exception, 40),
      origin: str(r.origin, 200),
      dueAt,
    },
  };
}

/** "Grant a retry · Objection Handling · Priya Nair" / "· 4 people". */
export async function describeTicket(
  svc: SupabaseClient,
  category: TicketCategory,
  context: TicketContext
): Promise<{ subject: string; lines: string[]; names: Map<string, string> }> {
  const people = await namesAndEmails(svc, context.userIds);
  const names = new Map([...people].map(([id, p]) => [id, p.name]));
  const who =
    context.userIds.length === 0 ? null
      : context.userIds.length === 1 ? names.get(context.userIds[0]) ?? "1 person"
      : `${context.userIds.length} people`;
  const subject = [CATEGORY_LABEL[category], context.contentTitle, who].filter(Boolean).join(" · ");
  const lines: string[] = [];
  if (context.contentTitle) lines.push(`${context.contentKind === "journey" ? "Journey" : context.contentKind === "path" ? "Learning path" : "Course"}: ${context.contentTitle}`);
  if (context.userIds.length) lines.push(`People: ${context.userIds.map((id) => names.get(id) ?? "—").slice(0, 10).join(", ")}${context.userIds.length > 10 ? ` +${context.userIds.length - 10}` : ""}`);
  if (context.exception) lines.push(`Flagged as: ${context.exception.replace(/_/g, " ")}`);
  if (context.dueAt) lines.push(`Requested due date: ${context.dueAt}`);
  return { subject, lines, names };
}
