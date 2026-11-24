/**
 * Admin Attention Center — server-side collector. Runs the enabled providers
 * (lib/attention/types.ts registry) in parallel, drops dismissed items, and
 * returns everything sorted most-urgent-first. Every provider is fail-soft: a
 * broken or pre-migration source yields no items rather than breaking the page.
 */
import { resolveEmails } from "@/lib/users/emails";
import { defaultSlotFinding, isReadyVersion } from "@/lib/courses/default-rule";
import { heldWebhookItem, heldWebhookSummary } from "@/lib/integrations/webhook-hold";
import { classifyAttempt, type PgError } from "@/lib/scoring/attempt-kind";
import { readWithContextFilter, withoutPreviews } from "@/lib/scoring/context-read";
import { NOT_APPLIED_TITLE, attentionContextLine, ignoredPassCount, readIgnoredRecord } from "@/lib/xapi/ignored-pass";
import { readTenantMailNotice, smtpSettingsPath, type TenantMailNotice } from "@/lib/notifications/smtp-state";
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
  // source / category arrive with 0095; fall back to the old shape before it.
  let data: unknown[] | null = null;
  {
    const r = await svc
      .from("help_tickets")
      .select("id, user_id, subject, status, priority, created_at, source, category")
      .eq("organization_id", orgId)
      .in("status", ["open", "in_progress"])
      .order("created_at", { ascending: false })
      .limit(200);
    if (!r.error) data = r.data;
    else {
      const o = await svc
        .from("help_tickets")
        .select("id, user_id, subject, status, priority, created_at")
        .eq("organization_id", orgId)
        .in("status", ["open", "in_progress"])
        .order("created_at", { ascending: false })
        .limit(200);
      data = o.data;
    }
  }
  const rows = (data ?? []) as Array<{ id: string; user_id: string; subject: string; status: string; priority: string; created_at: string; source?: string; category?: string | null }>;
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
    title: `${r.source === "manager" ? (r.status === "in_progress" ? "Manager request in progress" : "Manager request") : r.status === "in_progress" ? "Ticket in progress" : "Open ticket"}: ${r.subject}`,
    who: names.get(r.user_id) ?? emails.get(r.user_id) ?? r.user_id.slice(0, 8),
    context: `${r.priority} priority${r.source === "manager" ? " · raised from the Report Card" : ""}`,
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

function ageLabel(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 864e5);
  if (days < 1) return "today";
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

/**
 * ADR 0004 step 3a: integrity blocks a super owner overrode, naming the
 * overriding super owner and the colliding course. Fail-soft before 0098
 * (no override columns -> no items).
 */
async function integrityOverrideItems(svc: AnyClient, orgId: string, orgSlug: string, priority: AttentionPriority): Promise<AttentionItem[]> {
  const { data, error } = await svc
    .from("package_validations")
    .select("id, file_name, course_id, overridden_by, overridden_at, override_reason, integrity:report->integrity")
    .eq("organization_id", orgId)
    .not("overridden_at", "is", null)
    .order("overridden_at", { ascending: false })
    .limit(100);
  if (error) return [];
  const rows = (data ?? []) as Array<{
    id: string;
    file_name: string | null;
    course_id: string | null;
    overridden_by: string | null;
    overridden_at: string;
    override_reason: string | null;
    integrity: {
      context?: { courseId?: string | null } | null;
      collisions?: Array<{ courseId: string; courseTitle?: string | null }> | null;
    } | null;
  }>;
  if (!rows.length) return [];
  const actorIds = rows.map((r) => r.overridden_by).filter((x): x is string => !!x);
  const targetIds = rows.map((r) => r.course_id ?? r.integrity?.context?.courseId ?? null).filter((x): x is string => !!x);
  const [emails, names, titles] = await Promise.all([
    resolveEmails(svc, actorIds),
    resolveNames(svc, actorIds),
    courseTitles(svc, targetIds),
  ]);
  return rows.map((r) => {
    const collisions = r.integrity?.collisions ?? [];
    const colliding = collisions[0]?.courseTitle ?? (collisions[0]?.courseId ? collisions[0].courseId.slice(0, 8) : "another course");
    const more = collisions.length > 1 ? ` (+${collisions.length - 1} more)` : "";
    const target = r.course_id ?? r.integrity?.context?.courseId ?? null;
    const actor = r.overridden_by ? names.get(r.overridden_by) ?? emails.get(r.overridden_by) ?? r.overridden_by.slice(0, 8) : "A super owner";
    return {
      key: `integrity-override:${r.id}`,
      type: "integrity-override",
      priority,
      title: `Integrity block overridden${r.file_name ? `: ${r.file_name}` : ""}`,
      who: actor,
      context: `Matched "${colliding}"${more}${target ? ` · uploaded to "${titles.get(target) ?? "a new course"}"` : ""}${r.override_reason ? ` · reason: ${r.override_reason}` : ""}`,
      occurredAt: r.overridden_at,
      actionLabel: "Check the module is in the right course",
      href: target ? `/${orgSlug}/library/${target}` : `/${orgSlug}/library`,
      inline: null,
      dismissible: true,
    };
  });
}

/**
 * ADR 0004 step 8 (decision 5): versions with upload_status 'ready' that are
 * not the current version of their package and are older than 24 hours,
 * with the reason and the age. No migration; fail-soft.
 */
async function unpublishedVersionItems(svc: AnyClient, orgId: string, orgSlug: string, priority: AttentionPriority): Promise<AttentionItem[]> {
  const { data: pkgData, error: pkgErr } = await svc
    .from("course_packages")
    .select("id, course_id, language, display_name, current_version_id, is_active, courses!inner(organization_id, title)")
    .eq("courses.organization_id", orgId)
    .limit(2000);
  if (pkgErr) return [];
  const pkgs = (pkgData ?? []) as Array<{
    id: string;
    course_id: string;
    language: string | null;
    display_name: string | null;
    current_version_id: string | null;
    is_active: boolean;
    courses: { title?: string | null } | Array<{ title?: string | null }> | null;
  }>;
  if (!pkgs.length) return [];
  const byPkg = new Map(pkgs.map((p) => [p.id, p]));
  const cutoff = new Date(Date.now() - 864e5).toISOString();
  type V = { id: string; package_id: string; version_number: number; uploaded_at: string };
  const versions: V[] = [];
  const ids = pkgs.map((p) => p.id);
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await svc
      .from("course_versions")
      .select("id, package_id, version_number, uploaded_at")
      .in("package_id", ids.slice(i, i + 200))
      .eq("upload_status", "ready")
      .lt("uploaded_at", cutoff)
      .limit(2000);
    if (error) return [];
    versions.push(...((data ?? []) as V[]));
  }
  // The current version's number per package (it may be younger than 24 h,
  // in which case it is not in `versions`: read it separately).
  const currentNumber = new Map<string, number>();
  for (const v of versions) if (byPkg.get(v.package_id)?.current_version_id === v.id) currentNumber.set(v.package_id, v.version_number);
  const missing = pkgs.filter((p) => p.current_version_id && !currentNumber.has(p.id)).map((p) => p.current_version_id as string);
  for (let i = 0; i < missing.length; i += 200) {
    const { data } = await svc.from("course_versions").select("id, package_id, version_number").in("id", missing.slice(i, i + 200));
    for (const v of (data ?? []) as Array<{ package_id: string; version_number: number }>) currentNumber.set(v.package_id, v.version_number);
  }
  const items: AttentionItem[] = [];
  for (const v of versions) {
    const p = byPkg.get(v.package_id);
    if (!p || p.current_version_id === v.id) continue;
    const course = Array.isArray(p.courses) ? p.courses[0] : p.courses;
    const slot = p.display_name ?? p.language ?? "default language";
    const cur = currentNumber.get(v.package_id);
    const reason =
      cur == null
        ? "its language has no current version"
        : v.version_number > cur
          ? `uploaded after v${cur}, which learners still get; never made current`
          : `superseded by v${cur}`;
    items.push({
      key: `unpublished-version:${v.id}`,
      type: "unpublished-versions",
      priority,
      title: `v${v.version_number} is not the current version (${slot})`,
      who: null,
      context: `${course?.title ?? "a course"} · ${reason}${p.is_active ? "" : " · language hidden from learners"} · uploaded ${ageLabel(v.uploaded_at)}`,
      occurredAt: v.uploaded_at,
      actionLabel: "Make it current or leave it as history",
      href: `/${orgSlug}/library/${p.course_id}`,
      inline: null,
      dismissible: true,
    });
  }
  return items.slice(0, 200);
}

/**
 * ADR 0008 step 15: courses whose default (`courses.current_version_id`) is
 * null while an active language has a ready version, whose default version's
 * language is hidden from learners, or whose default version is not its
 * language's current version. No migration; fail-soft.
 */
async function defaultSlotItems(svc: AnyClient, orgId: string, orgSlug: string, priority: AttentionPriority): Promise<AttentionItem[]> {
  const { data: courseData, error: courseErr } = await svc
    .from("courses")
    .select("id, title, current_version_id, updated_at")
    .eq("organization_id", orgId)
    .limit(2000);
  if (courseErr) return [];
  const courses = (courseData ?? []) as Array<{ id: string; title: string; current_version_id: string | null; updated_at: string }>;
  if (!courses.length) return [];
  const { data: pkgData, error: pkgErr } = await svc
    .from("course_packages")
    .select("id, course_id, language, display_name, current_version_id, is_active, courses!inner(organization_id)")
    .eq("courses.organization_id", orgId)
    .limit(4000);
  if (pkgErr) return [];
  const pkgs = (pkgData ?? []) as Array<{
    id: string;
    course_id: string;
    language: string | null;
    display_name: string | null;
    current_version_id: string | null;
    is_active: boolean;
  }>;
  // The default versions and every package's current version: package and readiness.
  const versionIds = [
    ...new Set([...courses.map((c) => c.current_version_id), ...pkgs.map((p) => p.current_version_id)].filter((x): x is string => !!x)),
  ];
  const versionInfo = new Map<string, { package_id: string | null; ready: boolean }>();
  for (let i = 0; i < versionIds.length; i += 200) {
    // select("*") for 0077 deploy safety (upload_status).
    const { data, error } = await svc.from("course_versions").select("*").in("id", versionIds.slice(i, i + 200));
    if (error) return [];
    for (const v of (data ?? []) as Array<{ id: string; package_id: string | null; upload_status?: string | null }>) {
      versionInfo.set(v.id, { package_id: v.package_id, ready: isReadyVersion(v.upload_status) });
    }
  }
  const pkgsByCourse = new Map<string, typeof pkgs>();
  for (const p of pkgs) (pkgsByCourse.get(p.course_id) ?? pkgsByCourse.set(p.course_id, []).get(p.course_id)!).push(p);
  const slotLabel = (p: { language: string | null; display_name: string | null } | undefined) =>
    p ? p.display_name?.trim() || p.language || "unlabeled language" : "a language";

  const items: AttentionItem[] = [];
  for (const c of courses) {
    const coursePkgs = pkgsByCourse.get(c.id) ?? [];
    if (!coursePkgs.length) continue;
    const finding = defaultSlotFinding({
      defaultVersionId: c.current_version_id,
      defaultPackageId: c.current_version_id ? versionInfo.get(c.current_version_id)?.package_id ?? null : null,
      packages: coursePkgs.map((p) => ({
        id: p.id,
        is_active: p.is_active,
        current_version_id: p.current_version_id,
        currentReady: !!p.current_version_id && (versionInfo.get(p.current_version_id)?.ready ?? false),
      })),
    });
    if (!finding) continue;
    const slot = finding.kind === "no_default" ? undefined : coursePkgs.find((p) => p.id === finding.packageId);
    const title =
      finding.kind === "no_default"
        ? "Course has no default language"
        : finding.kind === "default_hidden"
          ? `Default language is hidden from learners (${slotLabel(slot)})`
          : `Course default is not the current version of ${slotLabel(slot)}`;
    items.push({
      key: `default-slot:${c.id}:${finding.kind}:${c.current_version_id ?? "none"}`,
      type: "default-slot",
      priority,
      title,
      who: null,
      context: `${c.title} · the catalogue and Library show the default; set the right language as the default`,
      occurredAt: c.updated_at,
      actionLabel: "Set a default language",
      href: `/${orgSlug}/library/${c.id}`,
      inline: null,
      dismissible: true,
    });
  }
  return items.slice(0, 200);
}

/**
 * ADR 0015 step 6: official cmi5/xAPI completions whose CRM webhook has not
 * fired after 24 hours, as one item with the count. The selection, the summary
 * and the item live in webhook-hold.ts, which the sweep shares; no opts, so its
 * page size and scan cap apply. Fail-soft: any error, a database without 0082
 * included, yields no items.
 */
async function heldWebhookItems(svc: AnyClient, orgId: string, orgSlug: string, priority: AttentionPriority): Promise<AttentionItem[]> {
  try {
    const { count, oldestCompletedAt } = await heldWebhookSummary(svc, orgId, { classify: classifyAttempt });
    const item = heldWebhookItem({ count, oldestCompletedAt, orgSlug, priority });
    return item ? [item] : [];
  } catch {
    return [];
  }
}

/**
 * ADR 0017 step 13: attempts whose new-engine guard held a pass, one item per
 * attempt. `occurredAt` is the record's last_at, so a later ignored pass brings a
 * marked-read item back and a repeat of the same SCORM dictionary does not.
 * Fail-soft: supabase-js answers `{ error }` on a database without 0104 and does
 * not throw, so the fetcher checks it and answers no items. A preview is never
 * an item (ADR 0024 steps 49 and 80, P2-3): the read drops `context_kind =
 * 'preview'` rows, and on a database without 0107 the filter's missing-column
 * error reads today's select once (readWithContextFilter).
 */
async function ignoredPassItems(svc: AnyClient, orgId: string, orgSlug: string, priority: AttentionPriority): Promise<AttentionItem[]> {
  const { data, error } = await readWithContextFilter<{ data: unknown[] | null; error: PgError }>({ applies: null }, (apply) =>
    withoutPreviews(
      svc
        .from("course_attempts")
        .select("id, user_id, course_version_id, score, completed_at, ignored_pass, course_versions(course_id)")
        .eq("organization_id", orgId),
      apply
    )
      .not("ignored_pass", "is", null)
      .eq("success_status", "failed")
      .order("ignored_pass->>last_at", { ascending: false })
      .limit(200)
  );
  if (error) return [];
  const courseIdOf = (r: { course_versions: { course_id: string } | Array<{ course_id: string }> | null }) =>
    (Array.isArray(r.course_versions) ? r.course_versions[0] : r.course_versions)?.course_id ?? null;
  const rows = ((data ?? []) as Array<{
    id: string;
    user_id: string;
    ignored_pass: unknown;
    course_versions: { course_id: string } | Array<{ course_id: string }> | null;
  }>).filter((r) => ignoredPassCount(r.ignored_pass) > 0);
  if (!rows.length) return [];
  const [emails, names, titles] = await Promise.all([
    resolveEmails(svc, rows.map((r) => r.user_id)),
    resolveNames(svc, rows.map((r) => r.user_id)),
    courseTitles(svc, rows.map((r) => courseIdOf(r)).filter((x): x is string => !!x)),
  ]);
  const items: AttentionItem[] = [];
  for (const r of rows) {
    const record = readIgnoredRecord(r.ignored_pass);
    if (!record?.last_at) continue;
    const courseId = courseIdOf(r);
    items.push({
      key: `ignored-pass:${r.id}`,
      type: "ignored-pass",
      priority,
      title: NOT_APPLIED_TITLE,
      who: names.get(r.user_id) ?? emails.get(r.user_id) ?? r.user_id.slice(0, 8),
      context: attentionContextLine(record, courseId ? titles.get(courseId) : null),
      occurredAt: record.last_at,
      actionLabel: "Review the attempt",
      href: courseId ? `/${orgSlug}/courses/${courseId}/attempts/${r.id}` : `/${orgSlug}/reports#not-applied`,
      inline: null,
      dismissible: true,
    });
  }
  return items;
}

/**
 * The organisation's own email (ADR 0029 section E; rule FP4): one item
 * while it is not ready (its SMTP is not set up, or failing), or while its
 * daily count is near the limit (a warning from eight tenths), past the
 * line where routine mail stops, or at the limit itself (critical, with the
 * count and the limit). It cannot be marked as read; it goes when the cause
 * is gone. A state that cannot be read (migration 0114 not pasted included)
 * gives no item, while settings that are incomplete still give the
 * not-configured item from the settings alone. Never throws.
 */
export function tenantSmtpItem(notice: TenantMailNotice | null, orgSlug: string, priority: AttentionPriority, nowIso: string): AttentionItem | null {
  if (!notice) return null;
  // Section E: the item links to the SMTP tab of Settings.
  const base = { type: "tenant-smtp", who: null, href: smtpSettingsPath(orgSlug), inline: null, dismissible: false } as const;
  switch (notice.kind) {
    case "not_configured":
      return { ...base, key: "tenant-smtp:not_configured", priority, title: "Email is not set up: no email reaches your learners", context: "Set the SMTP host, port and From address on the SMTP tab of Settings.", occurredAt: nowIso, actionLabel: "Set up SMTP" };
    case "failing":
      return {
        ...base,
        key: "tenant-smtp:failing",
        priority,
        title: "Email is failing: your learners' email is not being sent",
        context: `Failing since ${notice.since ? notice.since.slice(0, 16).replace("T", " ") + " UTC" : "a time not recorded"}${notice.lastErrorClass ? ` · last error: ${notice.lastErrorClass}` : ""}`,
        occurredAt: notice.since ?? nowIso,
        actionLabel: "Check the SMTP settings and send a test",
      };
    case "limit_reached":
      return { ...base, key: "tenant-smtp:daily_limit", priority, title: "All email has stopped: the daily email limit is reached", context: `${notice.sent24h} of ${notice.limit} sent in the last 24 hours. Email starts again as the 24 hours move on.`, occurredAt: nowIso, actionLabel: "Review today's email" };
    case "routine_stopped":
      return { ...base, key: "tenant-smtp:daily_limit", priority, title: "Routine email has stopped for today", context: `${notice.sent24h} of ${notice.limit} sent in the last 24 hours. Reset codes, sign-in links and welcome mail still go until the limit.`, occurredAt: nowIso, actionLabel: "Review today's email" };
    case "routine_off":
      // The limit's setting, not a stop for today: a warning, as near_limit.
      return { ...base, key: "tenant-smtp:routine_off", priority: priority === "critical" ? "high" : priority, title: "Routine email is off at this daily limit", context: `The daily limit of ${notice.limit} is no more than the part kept for reset codes, sign-in links and welcome mail, so reminders, announcements and assignment email are never sent. ${notice.sent24h} sent in the last 24 hours. A platform owner sets the limit.`, occurredAt: nowIso, actionLabel: "Review today's email" };
    case "near_limit":
      return { ...base, key: "tenant-smtp:near_limit", priority: priority === "critical" ? "high" : priority, title: "Email is near today's limit", context: `${notice.sent24h} of ${notice.limit} sent in the last 24 hours. Routine email stops before the limit.`, occurredAt: nowIso, actionLabel: "Review today's email" };
  }
}

async function tenantSmtpItems(svc: AnyClient, orgId: string, orgSlug: string, priority: AttentionPriority): Promise<AttentionItem[]> {
  const item = tenantSmtpItem(await readTenantMailNotice(svc, orgId), orgSlug, priority, new Date().toISOString());
  return item ? [item] : [];
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
    if (p.type === "tenant-smtp") jobs.push(run(tenantSmtpItems(svc, orgId, orgSlug, c.priority)));
    else if (p.type === "attempt-request") jobs.push(run(attemptRequestItems(svc, orgId, orgSlug, c.priority)));
    else if (p.type === "ticket") jobs.push(run(ticketItems(svc, orgId, orgSlug)));
    else if (p.type === "failed-email") jobs.push(run(failedEmailItems(svc, orgId, orgSlug, c.priority)));
    else if (p.type === "overdue") jobs.push(run(overdueItems(svc, orgId, orgSlug, c.priority)));
    else if (p.type === "integrity-override") jobs.push(run(integrityOverrideItems(svc, orgId, orgSlug, c.priority)));
    else if (p.type === "unpublished-versions") jobs.push(run(unpublishedVersionItems(svc, orgId, orgSlug, c.priority)));
    else if (p.type === "default-slot") jobs.push(run(defaultSlotItems(svc, orgId, orgSlug, c.priority)));
    else if (p.type === "held-webhooks") jobs.push(run(heldWebhookItems(svc, orgId, orgSlug, c.priority)));
    else if (p.type === "ignored-pass") jobs.push(run(ignoredPassItems(svc, orgId, orgSlug, c.priority)));
  }
  let items = (await Promise.all(jobs)).flat();

  // Mark-as-read: hide an item while a dismissal exists at/after its latest
  // activity. An item that cannot be marked as read is never hidden.
  items = items.filter((it) => {
    if (!it.dismissible) return true;
    const d = dismissals.get(it.key);
    return !(d && new Date(d).getTime() >= new Date(it.occurredAt).getTime());
  });

  items.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || (a.occurredAt < b.occurredAt ? 1 : -1));
  const byPriority = { critical: 0, high: 0, normal: 0, low: 0 } as Record<AttentionPriority, number>;
  for (const it of items) byPriority[it.priority]++;
  return { items, byPriority, total: items.length };
}
