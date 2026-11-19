import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_POLICY, computeScoring, hasLiveGrantedRetake, type ScorableAttempt } from "@/lib/scoring/policy";
import { resolvePolicy } from "@/lib/scoring/resolve";
import {
  fetchPassRequired,
  grantSnapshotForUsers,
  readPagedWithOptionalColumn,
  type GrantSnapshot,
  type PgError,
} from "@/lib/scoring/attempt-kind";
import { readWithContextFilter, withoutPreviews, type ContextFilterState } from "@/lib/scoring/context-read";
import { GRANT_EXPIRY_CHOICES, expiryFromDays, notifyLearnerOfDecision } from "./requests";
import { countingMemberIds } from "@/lib/auth/org-membership";
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
 *
 * ADR 0014 step 11 (5): the reads fail closed. A failed versions, attempts,
 * grants or open-request read reports every named learner `failed` ("could
 * not read the learner's records") and inserts nothing; the expiry sweep
 * stays fail-soft.
 *
 * ADR 0024 P2-5: a Preview is never an official result. The attempts read
 * drops `context_kind = 'preview'` rows (readWithContextFilter and
 * withoutPreviews, one decision for every page of the call), as the queue
 * page does, so a learner whose only failed row is a Preview is skipped as
 * not failed and `attempts_used` counts real attempts only. On a database
 * without 0107 the filter's missing-column error reads today's select once;
 * any other error reports every learner failed, as before. Phase 4 (step 37)
 * moves this read to readContextResult.
 *
 * ADR 0030 rule 10: each granted learner is mailed only while their
 * membership counts. The organisation's members that count are read once
 * for the call (countingMemberIds), never once per learner; when that read
 * fails no mail is sent and the grants stand.
 */
/** `status` is a 0002 column; only `is_revision` (0103) can be missing (the narrower-select fallback). */
const ATTEMPT_COLUMNS = "id, user_id, status, score, started_at, completed_at, completion_status, success_status";
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

  const unreadable = (read: string) => {
    console.warn(JSON.stringify({ event: "grant_records_unreadable", course_id: course.id, read }));
    return {
      results: ids.map((uid): PerLearnerResult => ({ userId: uid, status: "failed", reason: "could not read the learner's records" })),
      courseTitle: course.title,
    };
  };

  const { data: verRows, error: verErr } = await svc.from("course_versions").select("id").eq("course_id", course.id);
  if (verErr || !verRows) return unreadable("versions");
  const verIds = (verRows as Array<{ id: string }>).map((v) => v.id);
  type Att = ScorableAttempt & { user_id: string };
  const attempts: Att[] = [];
  if (verIds.length) {
    // The rows carry `is_revision` (the narrower-select fallback,
    // readPagedWithOptionalColumn: the first page decides the column list
    // for the rest). Any failed page, or a page with neither rows nor an
    // error, reports every learner failed. Previews are dropped (the header).
    const previews: ContextFilterState = { applies: null };
    const attemptsRead = await readPagedWithOptionalColumn<Att>(
      "is_revision",
      (cols, from, to) =>
        readWithContextFilter(previews, (apply) =>
          withoutPreviews(
            svc.from("course_attempts").select(cols).eq("organization_id", args.orgId).in("user_id", ids).in("course_version_id", verIds),
            apply
          )
            .order("id")
            .range(from, to)
        ) as unknown as PromiseLike<{ data: Att[] | null; error: PgError }>,
      ATTEMPT_COLUMNS,
      { nullIsError: true }
    );
    if (attemptsRead.error) return unreadable("attempts");
    attempts.push(...attemptsRead.data);
  }
  const byUser = new Map<string, Att[]>();
  for (const x of attempts) byUser.set(x.user_id, [...(byUser.get(x.user_id) ?? []), x]);
  const policy = (await resolvePolicy(svc, course.id).catch(() => DEFAULT_POLICY)) ?? DEFAULT_POLICY;
  const passRequired = (await fetchPassRequired(svc, [course.id])).has(course.id);
  let retakes: Map<string, GrantSnapshot>;
  try {
    retakes = await grantSnapshotForUsers(svc, args.orgId, [course.id], ids);
  } catch {
    return unreadable("grants");
  }

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
  const { data: openRows, error: openErr } = await svc
    .from("attempt_requests")
    .select("user_id, status, used_at")
    .eq("course_id", course.id)
    .in("user_id", ids);
  if (openErr || !openRows) return unreadable("open requests");
  const open = new Set<string>();
  for (const r of openRows as Array<{ user_id: string; status: string; used_at: string | null }>) {
    if (r.status === "pending" || (r.status === "approved" && r.used_at === null)) open.add(r.user_id);
  }

  const results: PerLearnerResult[] = [];
  const nowIso = new Date().toISOString();
  const days = args.expiresInDays;
  const expiresAt = expiryFromDays(days === null || (typeof days === "number" && GRANT_EXPIRY_CHOICES.includes(days)) ? days : undefined);
  const people = await namesAndEmails(svc, ids);
  let counting: ReadonlySet<string> | "unreadable" | undefined;
  for (const uid of ids) {
    const mine = byUser.get(uid) ?? [];
    const retakeIds = retakes.get(`${uid}:${course.id}`)?.retakeIds ?? new Set<string>();
    const sc = computeScoring(mine, policy, retakeIds);
    const failed = sc.officialStatus === "failed" || (passRequired && sc.officialStatus !== null && sc.officialStatus !== "passed");
    if (!sc.officialAttempt || !failed) { results.push({ userId: uid, status: "skipped", reason: "has not failed this module" }); continue; }
    if (!sc.limitReached) { results.push({ userId: uid, status: "skipped", reason: "still has an official attempt available" }); continue; }
    // Only a LIVE granted retake blocks a new grant: one a force restart reset
    // (status 'abandoned') is closed for good (ADR 0004 step 11).
    if (hasLiveGrantedRetake(mine, retakeIds)) {
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
    // ADR 0030 rule 10: the organisation's members that count, read once for
    // this call at its first grant. Unreadable: no mail; the grants stand.
    if (counting === undefined) {
      counting = await countingMemberIds(svc, args.orgId);
      if (counting === "unreadable") {
        console.warn(JSON.stringify({ event: "mail_recipients_unreadable", site: "attempt-grant", org_id: args.orgId }));
      }
    }
    if (counting === "unreadable") continue;
    const who = people.get(uid);
    await notifyLearnerOfDecision(svc, {
      orgId: args.orgId, orgName: args.orgName, orgSlug: args.orgSlug, origin: args.origin,
      courseId: course.id, courseTitle: course.title,
      learner: { id: uid, email: who?.email ?? "" }, approved: true, note: null, expiresAt,
      counting,
    });
  }
  return { results, courseTitle: course.title };
}
