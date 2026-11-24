import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { CHECK_FAILED } from "@/lib/auth/api-admin";
import { resolveOrgMembership } from "@/lib/auth/org-membership";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { originFromRequest } from "@/lib/http/origin";
import { notifyAdminsOfRequest } from "@/lib/attempts/requests";
import { REQUEST_MESSAGES, requestDecision } from "@/lib/attempts/request-decision";
import { computeScoring, type ScorableAttempt, type ScoringResult } from "@/lib/scoring/policy";
import { resolvePolicy } from "@/lib/scoring/resolve";
import { grantSnapshotFor, readWithOptionalColumn, type PgError } from "@/lib/scoring/attempt-kind";
import { readWithContextFilter, withoutPreviews, type ContextFilterState } from "@/lib/scoring/context-read";
import { MIDDLEWARE_CALLS, countCalls, requestBudget, spendCalls } from "@/lib/notifications/smtp-state";

/**
 *   POST /api/attempt-requests   body: { orgSlug, courseId, reason }
 *
 * A learner asks for another official attempt at a module whose official
 * result exists, passed or not (ADR 0014 step 11, Q2: a learner who passed
 * may ask; the admin approves with a confirmation and a reason). The route
 * checks what the course page checks (requestDecision, one function), with
 * the service client and strict reads (the versions, the attempts, the
 * grants): any read error answers 503 and nothing is inserted; no official
 * result yet, or a granted retake still in progress, answers 409. The row is
 * inserted on the service-role client after the session check
 * (attempt_requests has read-only RLS). The partial unique index allows
 * only one OPEN request per learner+course, so a duplicate returns a friendly
 * 409 rather than a constraint error. Admins are emailed in the background.
 *
 * ADR 0024 P2-5: one person can hold a Preview row and a real row of a
 * course, and the course page that offers the request drops Previews. So
 * does the attempts read here (readWithContextFilter and withoutPreviews):
 * a Preview is never the official result, never makes one exist, and is
 * never counted in `attempts_used`. On a database without 0107 the filter's
 * missing-column error reads today's select once; any other error answers
 * 503 as before. Phase 4 (step 37) moves this read to readContextResult.
 *
 * ADR 0029 rule FP2: the request's one budget starts with the request and
 * counts from its first call (the middleware's), each call where it is
 * made, fallbacks included, so the administrators' mail is sized on the
 * calls really made (notifyAdminsOfRequest). Its 45 seconds start there too.
 */
/** `status` is a 0002 column; only `is_revision` (0103) can be missing (the narrower-select fallback). */
const ATTEMPT_COLUMNS = "id, score, started_at, completed_at, completion_status, success_status, status";

function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}

export async function POST(request: Request) {
  const budget = requestBudget({ spent: MIDDLEWARE_CALLS });
  const body = (await request.json().catch(() => ({}))) as {
    orgSlug?: string;
    courseId?: string;
    reason?: string;
  };
  if (!body.orgSlug || !body.courseId) {
    return NextResponse.json({ error: "orgSlug and courseId are required" }, { status: 400 });
  }
  const reason = (body.reason ?? "").trim();
  if (reason.length < 3) {
    return NextResponse.json({ error: "Please add a short reason for your request." }, { status: 400 });
  }
  if (reason.length > 2000) {
    return NextResponse.json({ error: "Reason is too long." }, { status: 400 });
  }

  const supabase = await createClient();
  spendCalls(budget, 1);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // The caller must hold a membership in this org that counts (ADR 0030):
  // anything else is answered as a signed-in non-member is. Two calls: the
  // organisation by its slug, then the caller's member row.
  spendCalls(budget, 2);
  const membership = await resolveOrgMembership<{ id: string; name: string }>(
    supabase,
    { slug: body.orgSlug },
    user.id,
    "id, name"
  );
  if (membership === "unreadable") return NextResponse.json({ error: CHECK_FAILED }, { status: 503 });
  if (membership === "none") return NextResponse.json({ error: "Org not found" }, { status: 404 });
  const org = membership.org;

  // The course must belong to this org.
  spendCalls(budget, 1);
  const { data: course } = await supabase
    .from("courses")
    .select("id, title")
    .eq("id", body.courseId)
    .eq("organization_id", org.id)
    .maybeSingle();
  if (!course) return NextResponse.json({ error: "Course not found" }, { status: 404 });

  const s = svc();
  // ADR 0014 step 11 (2): the learner's official result, from strict reads
  // made before the insert. Any error (a failed versions or attempts read,
  // GrantReadError) answers 503: the request is never decided on a guess.
  let attempts: ScorableAttempt[] = [];
  let scoring: ScoringResult;
  try {
    spendCalls(budget, 1);
    const { data: verRows, error: verErr } = await s.from("course_versions").select("id").eq("course_id", course.id);
    if (verErr || !verRows) throw new Error("versions");
    const vIds = (verRows as Array<{ id: string }>).map((v) => v.id);
    if (vIds.length > 0) {
      // One decision of the preview filter for this request, never kept between requests.
      const previews: ContextFilterState = { applies: null };
      const { data: attRows, error: attErr } = await readWithOptionalColumn<ScorableAttempt[]>(
        "is_revision",
        (columns) =>
          readWithContextFilter(previews, (apply) => {
            spendCalls(budget, 1);
            return withoutPreviews(s.from("course_attempts").select(columns).eq("user_id", user.id).in("course_version_id", vIds), apply);
          }) as unknown as PromiseLike<{
            data: ScorableAttempt[] | null;
            error: PgError;
          }>,
        ATTEMPT_COLUMNS
      );
      if (attErr || !attRows) throw new Error("attempts");
      attempts = attRows;
    }
    const snapshot = await grantSnapshotFor(s, user.id, course.id, undefined, countCalls(budget));
    // One call: the policy of one course.
    spendCalls(budget, 1);
    const policy = await resolvePolicy(s, course.id);
    scoring = computeScoring(attempts, policy, snapshot.retakeIds);
  } catch (e) {
    console.warn(
      JSON.stringify({ event: "attempt_request_records_unreadable", course_id: course.id, read: e instanceof Error ? e.message : "error" })
    );
    return NextResponse.json({ error: "records_unreadable" }, { status: 503 });
  }
  const decision = requestDecision({ scoring, attempts });
  if (decision === "no_official_result") {
    return NextResponse.json({ error: REQUEST_MESSAGES.no_official_result }, { status: 409 });
  }
  if (decision === "retake_live") {
    return NextResponse.json({ error: REQUEST_MESSAGES.retake_live }, { status: 409 });
  }

  spendCalls(budget, 1);
  const { data: inserted, error } = await s
    .from("attempt_requests")
    .insert({
      organization_id: org.id,
      course_id: course.id,
      user_id: user.id,
      status: "pending",
      source: "request",
      reason,
    })
    .select("id")
    .maybeSingle();

  if (error) {
    // 23505 = the partial unique index: an open request/grant already exists.
    if ((error as { code?: string }).code === "23505") {
      return NextResponse.json(
        { error: "You already have an open attempt request for this course." },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  // 0085: record the learner's completed OFFICIAL attempts at request time, so
  // the admin sees "Nth attempt failed → Requesting (N+1)th attempt" and the
  // history/reports keep that context, from the scoring above (no second
  // read). Best-effort: a pre-0085 database must never fail the learner's
  // request.
  try {
    if (inserted?.id) {
      spendCalls(budget, 1);
      await s.from("attempt_requests").update({ attempts_used: scoring.scoredAttempts }).eq("id", inserted.id);
    }
  } catch (e) {
    console.warn("[attempt-requests] attempts_used not recorded (request still created):", e);
  }

  // Tell the admins (background; a mail failure never fails the request).
  const origin = await originFromRequest();
  spendCalls(budget, 1);
  const { data: profile } = await s
    .from("profiles")
    .select("first_name, last_name")
    .eq("id", user.id)
    .maybeSingle();
  const name = [profile?.first_name, profile?.last_name].filter(Boolean).join(" ").trim() || null;
  await notifyAdminsOfRequest(s, {
    orgId: org.id as string,
    orgName: (org.name as string) ?? "your org",
    orgSlug: body.orgSlug,
    origin,
    courseTitle: (course.title as string) ?? "a course",
    learnerEmail: user.email ?? "",
    learnerName: name,
    reason,
    budget,
  });

  return NextResponse.json({ ok: true, id: inserted?.id ?? null });
}
