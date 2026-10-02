/**
 * Admin Attention Center — server-side collector. Runs the enabled providers
 * (lib/attention/types.ts registry) in parallel, drops dismissed items, and
 * returns everything sorted most-urgent-first. Every provider is fail-soft: a
 * broken or pre-migration source yields no items rather than breaking the page.
 */
import { resolveEmails } from "@/lib/users/emails";
import {
  ATTENTION_PROVIDERS,
  PRIORITY_RANK,
  effectiveConfig,
  type AttentionItem,
  type AttentionPriority,
} from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any;

function ordinal(n: number): string {
  const v = n % 100;
  const s = ["th", "st", "nd", "rd"];
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

async function resolveNames(svc: AnyClient, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const list = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < list.length; i += 300) {
    const { data } = await svc.from("profiles").select("id, first_name, last_name").in("id", list.slice(i, i + 300));
    for (const p of (data ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null }>) {
      const n = [p.first_name, p.last_name].filter(Boolean).join(" ").trim();
      if (n) out.set(p.id, n);
    }
  }
  return out;
}

async function courseTitles(svc: AnyClient, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const list = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < list.length; i += 300) {
    const { data } = await svc.from("courses").select("id, title").in("id", list.slice(i, i + 300));
    for (const c of (data ?? []) as Array<{ id: string; title: string }>) out.set(c.id, c.title);
  }
  return out;
}

// ---- providers -------------------------------------------------------------

async function attemptRequestItems(svc: AnyClient, orgId: string, orgSlug: string, priority: AttentionPriority): Promise<AttentionItem[]> {
  const { data } = await svc
    .from("attempt_requests")
    .select("id, user_id, course_id, created_at, attempts_used")
    .eq("organization_id", orgId)
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(200);
  const rows = (data ?? []) as Array<{ id: string; user_id: string; course_id: string; created_at: string; attempts_used: number | null }>;
  if (!rows.length) return [];
  const [emails, names, titles] = await Promise.all([
    resolveEmails(svc, rows.map((r) => r.user_id)),
    resolveNames(svc, rows.map((r) => r.user_id)),
    courseTitles(svc, rows.map((r) => r.course_id)),
  ]);
  return rows.map((r) => {
    const next = typeof r.attempts_used === "number" ? r.attempts_used + 1 : null;
    return {
      key: `attempt-request:${r.id}`,
      type: "attempt-request",
      priority,
      title: "Extra-attempt request",
      who: names.get(r.user_id) ?? emails.get(r.user_id) ?? r.user_id.slice(0, 8),
      context: `${titles.get(r.course_id) ?? "a course"}${next != null ? ` · requesting ${ordinal(next)} attempt` : ""}`,
      occurredAt: r.created_at,
      actionLabel: "Approve or reject",
      href: `/${orgSlug}/attempt-requests`,
      inline: { kind: "attempt-request", id: r.id },
      dismissible: true,
    };
  });
}

async function ticketItems(svc: AnyClient, orgId: string, orgSlug: string): Promise<AttentionItem[]> {
  const { data } = await svc
    .from("help_tickets")
    .select("id, user_id, subject, status, priority, created_at")
    .eq("organization_id", orgId)
    .in("status", ["open", "in_progress"])
    .order("created_at", { ascending: false })
    .limit(200);
  const rows = (data ?? []) as Array<{ id: string; user_id: string; subject: string; status: string; priority: string; created_at: string }>;
  if (!rows.length) return [];
  const [emails, names] = await Promise.all([
    resolveEmails(svc, rows.map((r) => r.user_id)),
    resolveNames(svc, rows.map((r) => r.user_id)),
  ]);
  // A ticket is prioritised by its own priority: high → High, normal → Normal, low → Low.
  const mapP: Record<string, AttentionPriority> = { high: "high", normal: "normal", low: "low" };
  return rows.map((r) => ({
    key: `ticket:${r.id}`,
    type: "ticket",
    priority: mapP[r.priority] ?? "normal",
    title: `${r.status === "in_progress" ? "Ticket in progress" : "Open ticket"}: ${r.subject}`,
    who: names.get(r.user_id) ?? emails.get(r.user_id) ?? r.user_id.slice(0, 8),
    context: `${r.priority} priority`,
    occurredAt: r.created_at,
    actionLabel: r.status === "open" ? "Triage & resolve" : "Resolve",
    href: `/${orgSlug}/tickets`,
    inline: { kind: "ticket", id: r.id },
    dismissible: true,
  }));
}

async function failedEmailItems(svc: AnyClient, orgId: string, orgSlug: string, priority: AttentionPriority): Promise<AttentionItem[]> {
  const since = new Date(Date.now() - 14 * 864e5).toISOString();
  const { data } = await svc
    .from("notification_log")
    .select("id, sent_at")
    .eq("organization_id", orgId)
    .eq("status", "failed")
    .gte("sent_at", since)
    .order("sent_at", { ascending: false })
    .limit(1000);
  const rows = (data ?? []) as Array<{ id: string; sent_at: string }>;
  if (!rows.length) return [];
  return [{
    key: "failed-email:recent",
    type: "failed-email",
    priority,
    title: `${rows.length} email${rows.length === 1 ? "" : "s"} failed to send`,
    who: null,
    context: "In the last 14 days",
    occurredAt: rows[0].sent_at,
    actionLabel: "Review delivery log",
    href: `/${orgSlug}/notifications`,
    inline: null,
    dismissible: true,
  }];
}

async function overdueItems(svc: AnyClient, orgId: string, orgSlug: string, priority: AttentionPriority): Promise<AttentionItem[]> {
  // Set-based count in Postgres (migration 0087) — correct (no truncation) and
  // fast (one indexed query, never blocks the landing). Fail-soft pre-0087.
  const { data, error } = await svc.rpc("attention_overdue_count", { p_org: orgId });
  if (error) return [];
  const row = Array.isArray(data) ? data[0] : data;
  const count = Number(row?.overdue_count ?? 0);
  if (!count) return [];
  return [{
    // Count in the key so the alert re-surfaces when the overdue population
    // changes after being marked read (a frozen due-date timestamp would not).
    key: `overdue:all:${count}`,
    type: "overdue",
    priority,
    title: `${count} learner${count === 1 ? "" : "s"} overdue on assigned courses`,
    who: null,
    context: "Past the due date, not completed",
    occurredAt: row?.latest_due ?? new Date().toISOString(),
    actionLabel: "Review at-risk learners",
    href: `/${orgSlug}/reports#at-risk`,
    inline: null,
    dismissible: true,
  }];
}

// ---- orchestration ---------------------------------------------------------

export async function collectAttention(args: {
  svc: AnyClient;
  orgId: string;
  orgSlug: string;
  settings: { enabled?: boolean | null; config?: Record<string, { enabled?: boolean; priority?: string }> | null } | null;
  dismissals: Map<string, string>; // item_key → dismissed_at (ISO)
}): Promise<{ items: AttentionItem[]; byPriority: Record<AttentionPriority, number>; total: number }> {
  const { svc, orgId, orgSlug, settings, dismissals } = args;
  const { masterEnabled, byType } = effectiveConfig(settings);
  const empty = { items: [], byPriority: { critical: 0, high: 0, normal: 0, low: 0 }, total: 0 };
  if (!masterEnabled) return empty;

  // No single provider may hang the admin landing: cap each at a few seconds,
  // after which it contributes nothing this render (defense-in-depth on top of
  // each provider's own .catch).
  const withTimeout = (p: Promise<AttentionItem[]>, ms: number): Promise<AttentionItem[]> => {
    let t: ReturnType<typeof setTimeout>;
    const timer = new Promise<AttentionItem[]>((res) => { t = setTimeout(() => res([]), ms); });
    return Promise.race([p.finally(() => clearTimeout(t)), timer]);
  };
  const PROVIDER_TIMEOUT_MS = 8000;
  const run = (p: AttentionItem[] | Promise<AttentionItem[]>) => withTimeout(Promise.resolve(p).catch(() => []), PROVIDER_TIMEOUT_MS);

  const jobs: Promise<AttentionItem[]>[] = [];
  for (const p of ATTENTION_PROVIDERS) {
    const c = byType[p.type];
    if (!c?.enabled) continue;
    if (p.type === "attempt-request") jobs.push(run(attemptRequestItems(svc, orgId, orgSlug, c.priority)));
    else if (p.type === "ticket") jobs.push(run(ticketItems(svc, orgId, orgSlug)));
    else if (p.type === "failed-email") jobs.push(run(failedEmailItems(svc, orgId, orgSlug, c.priority)));
    else if (p.type === "overdue") jobs.push(run(overdueItems(svc, orgId, orgSlug, c.priority)));
  }
  let items = (await Promise.all(jobs)).flat();

  // Mark-as-read: hide an item while a dismissal exists at/after its latest activity.
  items = items.filter((it) => {
    const d = dismissals.get(it.key);
    return !(d && new Date(d).getTime() >= new Date(it.occurredAt).getTime());
  });

  items.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || (a.occurredAt < b.occurredAt ? 1 : -1));
  const byPriority = { critical: 0, high: 0, normal: 0, low: 0 } as Record<AttentionPriority, number>;
  for (const it of items) byPriority[it.priority]++;
  return { items, byPriority, total: items.length };
}
