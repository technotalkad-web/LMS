import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { originFromRequest } from "@/lib/http/origin";
import { notifyAdminsOfRequest } from "@/lib/attempts/requests";
import { REQUEST_MESSAGES, requestDecision } from "@/lib/attempts/request-decision";
import { computeScoring, type ScorableAttempt, type ScoringResult } from "@/lib/scoring/policy";
import { resolvePolicy } from "@/lib/scoring/resolve";
import { grantSnapshotFor, readWithOptionalColumn, type PgError } from "@/lib/scoring/attempt-kind";

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
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: org } = await supabase
    .from("organizations")
    .select("id, name")
    .eq("slug", body.orgSlug)
    .maybeSingle();
  if (!org) return NextResponse.json({ error: "Org not found" }, { status: 404 });

  // The caller must be a member of this org.
  const { data: membership } = await supabase
    .from("organization_members")
    .select("role")
    .eq("organization_id", org.id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // The course must belong to this org.
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
    const { data: verRows, error: verErr } = await s.from("course_versions").select("id").eq("course_id", course.id);
    if (verErr || !verRows) throw new Error("versions");
    const vIds = (verRows as Array<{ id: string }>).map((v) => v.id);
    if (vIds.length > 0) {
      const { data: attRows, error: attErr } = await readWithOptionalColumn<ScorableAttempt[]>(
        "is_revision",
        (columns) =>
          s.from("course_attempts").select(columns).eq("user_id", user.id).in("course_version_id", vIds) as unknown as PromiseLike<{
            data: ScorableAttempt[] | null;
            error: PgError;
          }>,
        ATTEMPT_COLUMNS
      );
      if (attErr || !attRows) throw new Error("attempts");
      attempts = attRows;
    }
    const snapshot = await grantSnapshotFor(s, user.id, course.id);
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
      await s.from("attempt_requests").update({ attempts_used: scoring.scoredAttempts }).eq("id", inserted.id);
    }
  } catch (e) {
    console.warn("[attempt-requests] attempts_used not recorded (request still created):", e);
  }

  // Tell the admins (background; a mail failure never fails the request).
  const origin = await originFromRequest();
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
  });

  return NextResponse.json({ ok: true, id: inserted?.id ?? null });
}
