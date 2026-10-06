import { redirect } from "next/navigation";
import { requireOrgAccess } from "@/lib/auth/require-org-access";
import { canManage } from "@/lib/auth/permissions";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { computeScoring, type ScorableAttempt } from "@/lib/scoring/policy";
import { resolvePolicies } from "@/lib/scoring/resolve";
import { fetchGrantRetakeIdsForUsers } from "@/lib/scoring/attempt-kind";
import { fetchReferenceCodes } from "@/lib/reference-codes";
import { resolveEmails } from "@/lib/users/emails";
import { AttemptRequestsQueue, type AttemptRequestRow, type BulkCourse } from "./attempt-requests-queue";

export const dynamic = "force-dynamic";

export default async function AttemptRequestsPage({
  params,
}: {
  params: Promise<{ org: string }>;
}) {
  const { org: orgSlug } = await params;
  const { org, role } = await requireOrgAccess(orgSlug);
  if (!canManage(role)) {
    redirect(`/${orgSlug}/dashboard?denied=1`);
  }

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  // All requests for the org, newest first. Fail-soft on a pre-0083 DB so the
  // page renders empty instead of 500ing before the migration lands.
  let raw: Array<{
    id: string;
    user_id: string;
    course_id: string;
    status: "pending" | "approved" | "rejected" | "expired";
    source: "request" | "bulk" | "manager";
    reason: string | null;
    decision_note: string | null;
    decided_by: string | null;
    decided_at: string | null;
    expires_at: string | null;
    used_at: string | null;
    created_at: string;
    /** 0085 — undefined before the migration. */
    attempts_used?: number | null;
  }> = [];
  try {
    // select("*") for deploy safety across the 0085 attempts_used column.
    const { data, error } = await svc
      .from("attempt_requests")
      .select("*")
      .eq("organization_id", org.id)
      .order("created_at", { ascending: false });
    if (!error) raw = (data ?? []) as typeof raw;
  } catch {
    /* pre-0083 */
  }

  const courseIds = [...new Set(raw.map((r) => r.course_id))];
  const userIds = [...new Set(raw.map((r) => r.user_id))];
  const deciderIds = [...new Set(raw.map((r) => r.decided_by).filter((x): x is string => !!x))];

  // Course titles + human-readable codes.
  const courseTitle = new Map<string, string>();
  if (courseIds.length) {
    const { data } = await svc.from("courses").select("id, title").in("id", courseIds);
    for (const c of (data ?? []) as Array<{ id: string; title: string }>) courseTitle.set(c.id, c.title);
  }
  const courseCodes = await fetchReferenceCodes(svc, "courses", courseIds);

  // Emails + names for learners and deciders.
  const emailMap = await resolveEmails(svc, [...userIds, ...deciderIds]);
  const nameByUser = new Map<string, string>();
  if (userIds.length) {
    const { data } = await svc.from("profiles").select("id, first_name, last_name").in("id", userIds);
    for (const p of (data ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null }>) {
      const n = [p.first_name, p.last_name].filter(Boolean).join(" ").trim();
      if (n) nameByUser.set(p.id, n);
    }
  }

  // Current official score/status per (learner, course) across all versions.
  const current = new Map<string, { score: number | null; status: string | null; used: number }>();
  if (courseIds.length && userIds.length) {
    const { data: verRows } = await svc
      .from("course_versions")
      .select("id, course_id")
      .in("course_id", courseIds);
    const verToCourse = new Map<string, string>();
    const verIds: string[] = [];
    for (const v of (verRows ?? []) as Array<{ id: string; course_id: string }>) {
      verToCourse.set(v.id, v.course_id);
      verIds.push(v.id);
    }
    const attByUserCourse = new Map<string, ScorableAttempt[]>();
    if (verIds.length) {
      const PAGE = 1000;
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await svc
          .from("course_attempts")
          .select("id, user_id, course_version_id, score, started_at, completed_at, completion_status, success_status")
          .in("course_version_id", verIds)
          .in("user_id", userIds)
          .order("id")
          .range(from, from + PAGE - 1);
        if (error) break;
        const page = (data ?? []) as Array<ScorableAttempt & { user_id: string; course_version_id: string }>;
        for (const a of page) {
          const cid = verToCourse.get(a.course_version_id);
          if (!cid) continue;
          const key = `${a.user_id}:${cid}`;
          attByUserCourse.set(key, [...(attByUserCourse.get(key) ?? []), a]);
        }
        if (page.length < PAGE) break;
      }
    }
    const policies = await resolvePolicies(svc, courseIds);
    const retakeByUser = await fetchGrantRetakeIdsForUsers(svc, org.id, userIds);
    for (const r of raw) {
      const key = `${r.user_id}:${r.course_id}`;
      if (current.has(key)) continue;
      const list = attByUserCourse.get(key) ?? [];
      const sc = computeScoring(list, policies.get(r.course_id)!, retakeByUser.get(key) ?? []);
      current.set(key, {
        score: sc.officialScore !== null ? Math.round(sc.officialScore * 100) : null,
        status: sc.officialStatus,
        used: sc.scoredAttempts,
      });
    }
  }

  const rows: AttemptRequestRow[] = raw.map((r) => {
    const key = `${r.user_id}:${r.course_id}`;
    const cur = current.get(key) ?? { score: null, status: null, used: 0 };
    // Attempts used when the request was made: the stored value is the truth for
    // the history (live scoring moves on after a grant); fall back to live for
    // pending rows and any row written before 0085.
    const used = typeof r.attempts_used === "number" ? r.attempts_used : cur.used;
    return {
      id: r.id,
      status: r.status,
      source: r.source,
      reason: r.reason,
      decision_note: r.decision_note,
      decided_at: r.decided_at,
      decided_by_email: r.decided_by ? emailMap.get(r.decided_by) ?? null : null,
      expires_at: r.expires_at,
      used_at: r.used_at,
      created_at: r.created_at,
      user_id: r.user_id,
      learner_name: nameByUser.get(r.user_id) ?? null,
      learner_email: emailMap.get(r.user_id) ?? r.user_id.slice(0, 8),
      course_id: r.course_id,
      course_title: courseTitle.get(r.course_id) ?? "Untitled course",
      course_code: courseCodes.get(r.course_id) ?? null,
      current_score: cur.score,
      current_status: cur.status,
      attempts_used: used,
    };
  });

  // Course list for the bulk-grant panel (all active modules in the org).
  const { data: allCourses } = await svc
    .from("courses")
    .select("id, title")
    .eq("organization_id", org.id)
    .order("title");
  const bulkCourses: BulkCourse[] = ((allCourses ?? []) as Array<{ id: string; title: string }>).map((c) => ({
    id: c.id,
    title: c.title,
    code: courseCodes.get(c.id) ?? null,
  }));

  return (
    <AttemptRequestsQueue
      rows={rows}
      courses={bulkCourses}
      orgSlug={orgSlug}
      orgName={org.name}
    />
  );
}
