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

async function countOverdue(svc: AnyClient, orgId: string): Promise<{ count: number; latestDue: string | null }> {
  const nowIso = new Date().toISOString();
  const { data: caRows } = await svc
    .from("course_assignments")
    .select("course_id, assignee_type, user_id, team_id, due_at")
    .eq("organization_id", orgId)
    .not("due_at", "is", null)
    .lt("due_at", nowIso)
    .limit(5000);
  const assigns = (caRows ?? []) as Array<{ course_id: string; assignee_type: string; user_id: string | null; team_id: string | null; due_at: string }>;
  if (!assigns.length) return { count: 0, latestDue: null };

  const { data: memRows } = await svc.from("organization_members").select("user_id").eq("organization_id", orgId).eq("status", "active");
  const activeUsers = new Set<string>(((memRows ?? []) as Array<{ user_id: string }>).map((m) => m.user_id));
  const teamIds = [...new Set(assigns.filter((a) => a.assignee_type === "team" && a.team_id).map((a) => a.team_id as string))];
  const teamUsers = new Map<string, string[]>();
  if (teamIds.length) {
    const { data: tm } = await svc.from("team_members").select("team_id, user_id").in("team_id", teamIds);
    for (const r of (tm ?? []) as Array<{ team_id: string; user_id: string }>) teamUsers.set(r.team_id, [...(teamUsers.get(r.team_id) ?? []), r.user_id]);
  }

  const dueByUC = new Map<string, string>(); // `${uid}:${cid}` → earliest past-due
  const courseIds = new Set<string>();
  const add = (uid: string, cid: string, due: string) => {
    if (!activeUsers.has(uid)) return;
    courseIds.add(cid);
    const k = `${uid}:${cid}`;
    const prev = dueByUC.get(k);
    if (!prev || due < prev) dueByUC.set(k, due);
  };
  for (const a of assigns) {
    if (a.assignee_type === "user" && a.user_id) add(a.user_id, a.course_id, a.due_at);
    else if (a.assignee_type === "org") for (const uid of activeUsers) add(uid, a.course_id, a.due_at);
    else if (a.assignee_type === "team" && a.team_id) for (const uid of teamUsers.get(a.team_id) ?? []) add(uid, a.course_id, a.due_at);
    // group assignments (0069) are approximated out of this aggregate for v1.
  }
  if (!dueByUC.size) return { count: 0, latestDue: null };

  const cids = [...courseIds];
  const verToCourse = new Map<string, string>();
  for (let i = 0; i < cids.length; i += 200) {
    const { data: vrows } = await svc.from("course_versions").select("id, course_id").in("course_id", cids.slice(i, i + 200));
    for (const v of (vrows ?? []) as Array<{ id: string; course_id: string }>) verToCourse.set(v.id, v.course_id);
  }
  const verIds = [...verToCourse.keys()];
  const candidateUsers = [...new Set([...dueByUC.keys()].map((k) => k.split(":")[0]))];
  const completed = new Set<string>();
  if (verIds.length && candidateUsers.length) {
    for (let u = 0; u < candidateUsers.length; u += 300) {
      const uslice = candidateUsers.slice(u, u + 300);
      for (let v = 0; v < verIds.length; v += 150) {
        const vslice = verIds.slice(v, v + 150);
        const { data: arows } = await svc
          .from("course_attempts")
          .select("user_id, course_version_id")
          .in("course_version_id", vslice)
          .in("user_id", uslice)
          .or("completion_status.eq.completed,success_status.eq.passed")
          .limit(10000);
        for (const a of (arows ?? []) as Array<{ user_id: string; course_version_id: string }>) {
          const cid = verToCourse.get(a.course_version_id);
          if (cid) completed.add(`${a.user_id}:${cid}`);
        }
      }
    }
  }

  let count = 0;
  let latestDue: string | null = null;
  for (const [k, due] of dueByUC) {
    if (completed.has(k)) continue;
    count++;
    if (!latestDue || due > latestDue) latestDue = due;
  }
  return { count, latestDue };
}

async function overdueItems(svc: AnyClient, orgId: string, orgSlug: string, priority: AttentionPriority): Promise<AttentionItem[]> {
  const { count, latestDue } = await countOverdue(svc, orgId);
  if (!count) return [];
  return [{
    key: "overdue:all",
    type: "overdue",
    priority,
    title: `${count} learner${count === 1 ? "" : "s"} overdue on assigned courses`,
    who: null,
    context: "Past the due date, not completed",
    occurredAt: latestDue ?? new Date().toISOString(),
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

  const jobs: Promise<AttentionItem[]>[] = [];
  for (const p of ATTENTION_PROVIDERS) {
    const c = byType[p.type];
    if (!c?.enabled) continue;
    if (p.type === "attempt-request") jobs.push(attemptRequestItems(svc, orgId, orgSlug, c.priority).catch(() => []));
    else if (p.type === "ticket") jobs.push(ticketItems(svc, orgId, orgSlug).catch(() => []));
    else if (p.type === "failed-email") jobs.push(failedEmailItems(svc, orgId, orgSlug, c.priority).catch(() => []));
    else if (p.type === "overdue") jobs.push(overdueItems(svc, orgId, orgSlug, c.priority).catch(() => []));
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
