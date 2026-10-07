import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_POLICY, computeScoring, type ScorableAttempt } from "@/lib/scoring/policy";
import { resolvePolicy } from "@/lib/scoring/resolve";
import { fetchGrantRetakeIdsForUsers, fetchPassRequired } from "@/lib/scoring/attempt-kind";
import { GRANT_EXPIRY_CHOICES, expiryFromDays, notifyLearnerOfDecision } from "./requests";
import { orgCourse } from "@/lib/courses/lookup";
import { namesAndEmails } from "@/lib/users/people";
import type { ActionError, PerLearnerResult } from "@/lib/actions/types";

/**
 * Grant one extra official attempt to named learners on a module — the same
 * approved `attempt_requests` row the admin bulk grant creates, per person.
 * Eligibility: the learner's official attempt failed (or a pass-required
 * module is not passed), their official window is used up, no granted retake
 * is still in progress, and no open request/grant exists.
 *
 * Phase 1 exposed this to managers; since Phase 4a (decision 12) only an admin
 * calls it — from the Attempt Requests queue or from a manager's ticket
 * (`source: "ticket"`). Scope and role are the caller's responsibility.
 */
export async function grantExtraAttempts(
  svc: SupabaseClient,
  args: {
    orgId: string;
    orgName: string;
    orgSlug: string;
    origin: string;
    decidedBy: string;
    source: "ticket" | "manager" | "bulk";
    courseId: string | null | undefined;
    userIds: string[];
    expiresInDays?: number | null;
  }
): Promise<ActionError | { results: PerLearnerResult[]; courseTitle: string }> {
  const ids = [...new Set(args.userIds)];
  if (ids.length === 0) return { error: "No learners named", status: 400 };
  const course = await orgCourse(svc, args.orgId, args.courseId);
  if (!course) return { error: "Course not found", status: 404 };

  const { data: verRows } = await svc.from("course_versions").select("id").eq("course_id", course.id);
  const verIds = ((verRows ?? []) as Array<{ id: string }>).map((v) => v.id);
  type Att = ScorableAttempt & { user_id: string };
  const attempts: Att[] = [];
  if (verIds.length) {
    for (let from = 0; ; from += 1000) {
      const { data } = await svc
        .from("course_attempts")
        .select("id, user_id, score, started_at, completed_at, completion_status, success_status")
        .eq("organization_id", args.orgId)
        .in("user_id", ids)
        .in("course_version_id", verIds)
        .order("id")
        .range(from, from + 999);
      const page = (data ?? []) as Att[];
      attempts.push(...page);
      if (page.length < 1000) break;
    }
  }
  const byUser = new Map<string, Att[]>();
  for (const x of attempts) byUser.set(x.user_id, [...(byUser.get(x.user_id) ?? []), x]);
  const policy = (await resolvePolicy(svc, course.id).catch(() => DEFAULT_POLICY)) ?? DEFAULT_POLICY;
  const passRequired = (await fetchPassRequired(svc, [course.id])).has(course.id);
  const retakes = await fetchGrantRetakeIdsForUsers(svc, args.orgId, ids);

  // A lapsed grant (approved, unused, expired) still occupies the one-open
  // slot; close it so a new grant can be made.
  await svc
    .from("attempt_requests")
    .update({ status: "expired" })
    .eq("organization_id", args.orgId)
    .eq("course_id", course.id)
    .in("user_id", ids)
    .eq("status", "approved")
    .is("used_at", null)
    .lt("expires_at", new Date().toISOString())
    .then(({ error }) => {
      if (error && (error as { code?: string }).code !== "23514") console.warn("[grant] expiry sweep:", error.message);
    });
  const { data: openRows } = await svc
    .from("attempt_requests")
    .select("user_id, status, used_at")
    .eq("course_id", course.id)
    .in("user_id", ids);
  const open = new Set<string>();
  for (const r of (openRows ?? []) as Array<{ user_id: string; status: string; used_at: string | null }>) {
    if (r.status === "pending" || (r.status === "approved" && r.used_at === null)) open.add(r.user_id);
  }

  const results: PerLearnerResult[] = [];
  const nowIso = new Date().toISOString();
  const days = args.expiresInDays;
  const expiresAt = expiryFromDays(days === null || (typeof days === "number" && GRANT_EXPIRY_CHOICES.includes(days)) ? days : undefined);
  const people = await namesAndEmails(svc, ids);
  for (const uid of ids) {
    const mine = byUser.get(uid) ?? [];
    const retakeIds = retakes.get(`${uid}:${course.id}`) ?? new Set<string>();
    const sc = computeScoring(mine, policy, retakeIds);
    const failed = sc.officialStatus === "failed" || (passRequired && sc.officialStatus !== null && sc.officialStatus !== "passed");
    if (!sc.officialAttempt || !failed) { results.push({ userId: uid, status: "skipped", reason: "has not failed this module" }); continue; }
    if (!sc.limitReached) { results.push({ userId: uid, status: "skipped", reason: "still has an official attempt available" }); continue; }
    if (mine.some((x) => retakeIds.has(x.id) && !(x.completion_status === "completed" || x.success_status === "passed"))) {
      results.push({ userId: uid, status: "skipped", reason: "a granted retake is still in progress" });
      continue;
    }
    if (open.has(uid)) { results.push({ userId: uid, status: "already", reason: "already has an open request or grant" }); continue; }
    const base = {
      organization_id: args.orgId,
      course_id: course.id,
      user_id: uid,
      status: "approved",
      source: args.source,
      decided_by: args.decidedBy,
      decided_at: nowIso,
      expires_at: expiresAt,
    };
    // Degrade only as far as the database requires: an older source CHECK
    // rejects 'ticket' / 'manager' (23514 → record as a bulk-style grant;
    // decided_by still names the admin), pre-0085 has no attempts_used (42703).
    let row: Record<string, unknown> = { ...base, attempts_used: sc.scoredAttempts };
    let { error } = await svc.from("attempt_requests").insert(row);
    for (let i = 0; error && i < 2; i++) {
      const code = (error as { code?: string }).code;
      if (code === "23514" && row.source !== "bulk") row = { ...row, source: "bulk" };
      else if (code === "42703" && "attempts_used" in row) {
        const { attempts_used: _dropped, ...rest } = row;
        void _dropped;
        row = rest;
      } else break;
      ({ error } = await svc.from("attempt_requests").insert(row));
    }
    if (error) {
      results.push({ userId: uid, status: "failed", reason: (error as { code?: string }).code === "23505" ? "already has an open request or grant" : "the grant could not be saved" });
      continue;
    }
    results.push({ userId: uid, status: "granted" });
    const who = people.get(uid);
    await notifyLearnerOfDecision(svc, {
      orgId: args.orgId, orgName: args.orgName, orgSlug: args.orgSlug, origin: args.origin,
      courseId: course.id, courseTitle: course.title,
      learner: { id: uid, email: who?.email ?? "" }, approved: true, note: null, expiresAt,
    });
  }
  return { results, courseTitle: course.title };
}
