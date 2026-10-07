/**
 * Support tickets raised from the Manager Report Card (Phase 4a, decision 12):
 * client-safe types and labels shared by the dialog, the API and the admin inbox.
 */

export const TICKET_CATEGORIES = [
  { value: "grant_retry", label: "Grant a retry", action: "Grant retry" },
  { value: "assign_content", label: "Assign content", action: "Assign" },
  { value: "extend_due", label: "Extend a due date", action: "Extend due date" },
  { value: "content_issue", label: "Content problem", action: "Review content" },
  { value: "other", label: "Something else", action: "Resolve" },
] as const;

export type TicketCategory = (typeof TICKET_CATEGORIES)[number]["value"];

export const CATEGORY_LABEL: Record<TicketCategory, string> = Object.fromEntries(
  TICKET_CATEGORIES.map((c) => [c.value, c.label])
) as Record<TicketCategory, string>;

export const isTicketCategory = (v: unknown): v is TicketCategory =>
  typeof v === "string" && TICKET_CATEGORIES.some((c) => c.value === v);

export type TicketContentKind = "course" | "path" | "journey";

/** What a manager ticket carries. Every id was checked against the manager's hierarchy on creation. */
export type TicketContext = {
  userIds: string[];
  contentKind: TicketContentKind | null;
  contentId: string | null;
  /** Title as stored at creation (resolved server-side, never trusted from the browser). */
  contentTitle: string | null;
  /** The exception the manager was looking at (failed, overdue, …), if any. */
  exception: string | null;
  /** Screen it came from, e.g. "team-performance" or "team-performance/<userId>". */
  origin: string | null;
  /** Requested new due date (YYYY-MM-DD) for extend_due. */
  dueAt?: string | null;
};

export type TicketOutcome = "granted" | "assigned" | "extended" | "declined" | "resolved";

export const OUTCOME_LABEL: Record<TicketOutcome, string> = {
  granted: "Retry granted",
  assigned: "Assigned",
  extended: "Due date extended",
  declined: "Declined",
  resolved: "Resolved",
};

/** Most people one ticket may name (the manager action limit from Phase 1). */
export const MAX_TICKET_PEOPLE = 50;

export type TicketMessage = {
  id: string;
  author_id: string;
  author_role: "requester" | "admin";
  body: string;
  created_at: string;
};
