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
import { ADMIN_REQUEST_OWN_CALLS, countCalls, openRun, recordRecipientsUnreadable, requestBudget, spendCalls, type MailBudget, type MailRun } from "@/lib/notifications/smtp-state";
import { RECIPIENTS_UNREADABLE, addMailOutcome, mailCounts, type MailCounts, type MailOutcome } from "@/lib/notifications/send";
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
 *
 * ADR 0029 rule T4: the answer carries the mails' outcome (`email`) for the
 * administrator at the screen: how many were emailed and not, or nobody
 * emailed because the recipients could not be read. Absent when nothing
 * was granted.
 *
 * ADR 0029 rule FP2: every call this makes is counted on the request's
 * budget where it is made, every page and fallback included, so the
 * learners' mail is sized on the calls really made. `budget` is the
 * caller's when the request does more after this (a ticket's action);
 * else one for this call, which starts at the route's own calls. The mails
 * share one run, opened on that budget at the first learner to mail, and
 * the answer hands it back (`run`) so the rest of the request's mail goes
 * in the same run.
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
    /** The request's budget, its count holding the request's calls so far. */
    budget?: MailBudget;
  }
): Promise<ActionError | { results: PerLearnerResult[]; courseTitle: string; email?: MailOutcome; run?: MailRun }> {
  const ids = [...new Set(args.userIds)];
  if (ids.length === 0) return { error: "No learners named", status: 400 };
  const budget = args.budget ?? requestBudget({ spent: ADMIN_REQUEST_OWN_CALLS });
  spendCalls(budget, 1);
  const course = await orgCourse(svc, args.orgId, args.courseId);
  if (!course) return { error: "Course not found", status: 404 };

  const unreadable = (read: string) => {
    console.warn(JSON.stringify({ event: "grant_records_unreadable", course_id: course.id, read }));
    return {
      results: ids.map((uid): PerLearnerResult => ({ userId: uid, status: "failed", reason: "could not read the learner's records" })),
      courseTitle: course.title,
    };
  };

  spendCalls(budget, 1);
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
    // Each call is counted where it is built: every page and each fallback.
    const previews: ContextFilterState = { applies: null };
    const attemptsRead = await readPagedWithOptionalColumn<Att>(
      "is_revision",
      (cols, from, to) =>
        readWithContextFilter(previews, (apply) => {
          spendCalls(budget, 1);
          return withoutPreviews(
            svc.from("course_attempts").select(cols).eq("organization_id", args.orgId).in("user_id", ids).in("course_version_id", verIds),
            apply
          )
            .order("id")
            .range(from, to);
        }) as unknown as PromiseLike<{ data: Att[] | null; error: PgError }>,
      ATTEMPT_COLUMNS,
      { nullIsError: true }
    );
    if (attemptsRead.error) return unreadable("attempts");
    attempts.push(...attemptsRead.data);
  }
  const byUser = new Map<string, Att[]>();
  for (const x of attempts) byUser.set(x.user_id, [...(byUser.get(x.user_id) ?? []), x]);
  // One call each: the policy of one course, and its pass mark.
  spendCalls(budget, 1);
  const policy = (await resolvePolicy(svc, course.id).catch(() => DEFAULT_POLICY)) ?? DEFAULT_POLICY;
  spendCalls(budget, 1);
  const passRequired = (await fetchPassRequired(svc, [course.id])).has(course.id);
  let retakes: Map<string, GrantSnapshot>;
  try {
    retakes = await grantSnapshotForUsers(svc, args.orgId, [course.id], ids, undefined, countCalls(budget));
  } catch {
    return unreadable("grants");
  }

  // A lapsed grant (approved, unused, expired) still occupies the one-open
  // slot; close it so a new grant can be made.
  spendCalls(budget, 1);
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
  spendCalls(budget, 1);
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
  // The addresses are read for the mail only: a failed read is never "no
  // address" and never stops a grant. It mails nobody (ADR 0029). One call
  // for each 150 learners.
  spendCalls(budget, Math.ceil(ids.length / 150));
  const people = await namesAndEmails(svc, ids).catch(() => "unreadable" as const);
  let counting: ReadonlySet<string> | "unreadable" | undefined;
  let run: MailRun | undefined;
  /** The granted learners' mails, for the answer (rule T4). */
  let mailed: MailCounts = mailCounts([]);
  /** The learners to grant, each with their place in `results` and their row. */
  const grants: Array<{ at: number; uid: string; row: Record<string, unknown> }> = [];
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
    grants.push({ at: results.length, uid, row: { ...base, attempts_used: sc.scoredAttempts } });
    // Granted unless the insert below says otherwise.
    results.push({ userId: uid, status: "granted" });
  }

  // The grants (ADR 0029 gate G3: one call, not one per learner). Degrade
  // only as far as the database requires: an older source CHECK rejects
  // 'ticket' / 'manager' (23514 → record as a bulk-style grant; decided_by
  // still names the admin), pre-0085 has no attempts_used (42703). The one
  // insert holds every row, so it degrades as each row's own insert would.
  // Any error it still answers is each learner's own again: then each row
  // is inserted on its own, as before, and a learner whose row fails (23505:
  // a grant made since the read) is failed while the others are granted.
  const insertGrant = async (first: Record<string, unknown> | Record<string, unknown>[]) => {
    let rows = Array.isArray(first) ? first : [first];
    const send = () => {
      spendCalls(budget, 1);
      return svc.from("attempt_requests").insert(Array.isArray(first) ? rows : rows[0]);
    };
    let { error } = await send();
    for (let i = 0; error && i < 2; i++) {
      const code = (error as { code?: string }).code;
      if (code === "23514" && rows.some((r) => r.source !== "bulk")) rows = rows.map((r) => ({ ...r, source: "bulk" }));
      else if (code === "42703" && rows.some((r) => "attempts_used" in r)) {
        rows = rows.map((r) => {
          const { attempts_used: _dropped, ...rest } = r;
          void _dropped;
          return rest;
        });
      } else break;
      ({ error } = await send());
    }
    return error;
  };
  const failedGrant = (g: (typeof grants)[number], error: unknown): PerLearnerResult => ({
    userId: g.uid,
    status: "failed",
    reason: (error as { code?: string }).code === "23505" ? "already has an open request or grant" : "the grant could not be saved",
  });
  if (grants.length === 1) {
    const error = await insertGrant(grants[0].row);
    if (error) results[grants[0].at] = failedGrant(grants[0], error);
  } else if (grants.length > 1) {
    const batchError = await insertGrant(grants.map((g) => g.row));
    if (batchError) {
      for (const g of grants) {
        const error = await insertGrant(g.row);
        if (error) results[g.at] = failedGrant(g, error);
      }
    }
  }

  for (const g of grants) {
    if (results[g.at].status !== "granted") continue;
    const uid = g.uid;
    // ADR 0030 rule 10: the organisation's members that count, read once for
    // this call at its first grant. A failed read of them or of the
    // addresses mails nobody and records the skip once; the grants stand.
    if (counting === undefined) {
      counting = await countingMemberIds(svc, args.orgId, undefined, countCalls(budget));
      if (counting === "unreadable" || people === "unreadable") {
        counting = "unreadable";
        await recordRecipientsUnreadable("attempt-grant", args.orgId);
      }
    }
    if (counting === "unreadable" || people === "unreadable") continue;
    // Rule 10: a learner whose membership does not count gets no mail, and
    // no run is opened for nobody.
    if (!counting.has(uid)) continue;
    run ??= await openRun({ organizationId: args.orgId, budget, db: svc });
    const who = people.get(uid);
    const one = await notifyLearnerOfDecision(svc, {
      orgId: args.orgId, orgName: args.orgName, orgSlug: args.orgSlug, origin: args.origin,
      courseId: course.id, courseTitle: course.title,
      learner: { id: uid, email: who?.email ?? "" }, approved: true, note: null, expiresAt,
      counting, run,
    });
    mailed = addMailOutcome(mailed, one);
  }
  // Nothing granted: no mail to speak of. A failed read of the recipients:
  // nobody was emailed, and the answer says why.
  if (counting === undefined) return { results, courseTitle: course.title };
  return { results, courseTitle: course.title, email: counting === "unreadable" ? RECIPIENTS_UNREADABLE : mailed, ...(run ? { run } : {}) };
}
