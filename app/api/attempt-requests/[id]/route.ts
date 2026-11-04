import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { originFromRequest } from "@/lib/http/origin";
import {
  ADMIN_ROLES,
  expiryFromDays,
  notifyLearnerOfDecision,
} from "@/lib/attempts/requests";
import {
  OVERRIDE_NOTE_MAX,
  REQUEST_MESSAGES,
  approvalDecision,
  resultStands,
} from "@/lib/attempts/request-decision";
import { computeScoring, type ScorableAttempt, type ScoringResult } from "@/lib/scoring/policy";
import { resolvePolicy } from "@/lib/scoring/resolve";
import { grantSnapshotFor, isMissingColumn, readWithOptionalColumn, type PgError } from "@/lib/scoring/attempt-kind";
import { resolveEmails } from "@/lib/users/emails";

/**
 *   PATCH /api/attempt-requests/{id}?orgSlug=acme
 *   body: { action: "approve" | "reject", note?, expires_in_days?, override_passed? }
 *
 * Admin decides one pending request. Approve turns the row into a GRANT the
 * learner's next launch consumes (status=approved, expires_at set); reject
 * closes it. Writes run on the service-role client after the admin check, and
 * the learner is emailed in the background.
 *
 * ADR 0014 step 11 (3): an approval first computes the learner's official
 * result from strict reads (the versions, the attempts, the grants, the
 * module's pass mark; any error answers 503). No official result yet, or a
 * granted retake still in progress, answers 409. When the result stands
 * (passed, or completed on a module without a pass mark), approval needs
 * `override_passed: true` and a reason of 3 to 2000 characters, stored
 * whole in decision_note, and the same update sets override_confirmed (the
 * marker consume_grant's `stands` refusal reads); a database without that
 * column refuses with 503, never an approval without the marker.
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

function normalizeRole(raw: string | null | undefined): string {
  if (raw === "owner") return "super_owner";
  if (raw === "member") return "user";
  return raw ?? "";
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const orgSlug = new URL(request.url).searchParams.get("orgSlug");
  if (!orgSlug) return NextResponse.json({ error: "orgSlug required" }, { status: 400 });

  const body = (await request.json().catch(() => ({}))) as {
    action?: "approve" | "reject";
    note?: string;
    expires_in_days?: number | null;
    override_passed?: boolean;
  };
  if (body.action !== "approve" && body.action !== "reject") {
    return NextResponse.json({ error: "action must be approve or reject" }, { status: 400 });
  }
  // A reject and a plain approve store the note cut to 2000 characters, as
  // before. The override path (ADR 0014 step 11 (3)) reads the untruncated
  // note; whether the approval is on that path is known only after the reads.
  const noteFull = (body.note ?? "").trim();
  const note = noteFull.slice(0, 2000) || null;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: org } = await supabase
    .from("organizations")
    .select("id, name")
    .eq("slug", orgSlug)
    .maybeSingle();
  if (!org) return NextResponse.json({ error: "Org not found" }, { status: 404 });

  const { data: caller } = await supabase
    .from("organization_members")
    .select("role")
    .eq("organization_id", org.id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!ADMIN_ROLES.includes(normalizeRole(caller?.role as string) as (typeof ADMIN_ROLES)[number])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const s = svc();
  // Load the request and confirm it's a pending one in THIS org.
  const { data: reqRow } = await s
    .from("attempt_requests")
    .select("id, organization_id, course_id, user_id, status")
    .eq("id", id)
    .maybeSingle();
  if (!reqRow || reqRow.organization_id !== org.id) {
    return NextResponse.json({ error: "Request not found" }, { status: 404 });
  }
  if (reqRow.status !== "pending") {
    return NextResponse.json({ error: "This request has already been decided." }, { status: 409 });
  }

  // ADR 0014 step 11 (3): the approval rule, on the learner's official result.
  let override = false;
  if (body.action === "approve") {
    let attempts: ScorableAttempt[] = [];
    let scoring: ScoringResult;
    let passRequired = false;
    try {
      const { data: verRows, error: verErr } = await s.from("course_versions").select("id").eq("course_id", reqRow.course_id);
      if (verErr || !verRows) throw new Error("versions");
      const vIds = (verRows as Array<{ id: string }>).map((v) => v.id);
      if (vIds.length > 0) {
        const { data: attRows, error: attErr } = await readWithOptionalColumn<ScorableAttempt[]>(
          "is_revision",
          (columns) =>
            s.from("course_attempts").select(columns).eq("user_id", reqRow.user_id).in("course_version_id", vIds) as unknown as PromiseLike<{
              data: ScorableAttempt[] | null;
              error: PgError;
            }>,
          ATTEMPT_COLUMNS
        );
        if (attErr || !attRows) throw new Error("attempts");
        attempts = attRows;
      }
      const snapshot = await grantSnapshotFor(s, reqRow.user_id, reqRow.course_id);
      // The module's pass mark (0081), error-checked: a database without the
      // column has no pass mark; any other error is a 503.
      const { data: courseRow, error: courseErr } = await s
        .from("courses")
        .select("pass_required")
        .eq("id", reqRow.course_id)
        .maybeSingle();
      if (courseErr && !isMissingColumn(courseErr, "pass_required")) throw new Error("course");
      passRequired = !courseErr && (courseRow as { pass_required?: boolean | null } | null)?.pass_required === true;
      const policy = await resolvePolicy(s, reqRow.course_id);
      scoring = computeScoring(attempts, policy, snapshot.retakeIds);
    } catch (e) {
      console.warn(
        JSON.stringify({ event: "attempt_request_records_unreadable", request_id: id, read: e instanceof Error ? e.message : "error" })
      );
      return NextResponse.json({ error: "records_unreadable" }, { status: 503 });
    }
    const stands = resultStands(scoring, passRequired);
    // 3 to 2000 characters on the override path only; the
    // queue's textarea stops at 2000, so this answers an API caller.
    if (stands && noteFull.length > OVERRIDE_NOTE_MAX) {
      return NextResponse.json({ error: "note must be at most 2000 characters" }, { status: 400 });
    }
    const decision = approvalDecision({
      scoring,
      attempts,
      passRequired,
      overridePassed: body.override_passed === true,
      note: noteFull,
    });
    if (decision === "no_official_result") {
      return NextResponse.json({ error: REQUEST_MESSAGES.no_official_result }, { status: 409 });
    }
    if (decision === "retake_live") {
      return NextResponse.json({ error: REQUEST_MESSAGES.retake_live }, { status: 409 });
    }
    if (decision === "needs_override") {
      const text =
        scoring.officialStatus === "completed" ? REQUEST_MESSAGES.needs_override_completed : REQUEST_MESSAGES.needs_override_passed;
      return NextResponse.json({ error: text }, { status: 409 });
    }
    override = decision === "approve_with_override";
  }

  const nowIso = new Date().toISOString();
  const expiresAt = body.action === "approve" ? expiryFromDays(body.expires_in_days) : null;
  // The override approval stores the reason whole (3-2000 characters) and
  // sets the marker in the same statement, so it is never approved without it.
  const decisionNote = override ? noteFull : note;
  const { data: updated, error } = await s
    .from("attempt_requests")
    .update({
      status: body.action === "approve" ? "approved" : "rejected",
      decided_by: user.id,
      decision_note: decisionNote,
      decided_at: nowIso,
      expires_at: expiresAt,
      ...(override ? { override_confirmed: true } : {}),
    })
    .eq("id", id)
    .eq("status", "pending") // single-decide guard under concurrency
    .select("id")
    .maybeSingle();
  if (error) {
    if (override && isMissingColumn(error, "override_confirmed")) {
      console.warn(JSON.stringify({ event: "schema_missing", column: "override_confirmed", request_id: id }));
      return NextResponse.json({ error: "schema_missing" }, { status: 503 });
    }
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  if (!updated) {
    return NextResponse.json({ error: "This request has already been decided." }, { status: 409 });
  }

  // Email the learner (background).
  const [{ data: course }, emailMap, origin] = await Promise.all([
    s.from("courses").select("title").eq("id", reqRow.course_id).maybeSingle(),
    resolveEmails(s, [reqRow.user_id]),
    originFromRequest(),
  ]);
  await notifyLearnerOfDecision(s, {
    orgId: org.id as string,
    orgName: (org.name as string) ?? "your org",
    orgSlug,
    origin,
    courseId: reqRow.course_id,
    courseTitle: (course?.title as string) ?? "a course",
    learner: { id: reqRow.user_id, email: emailMap.get(reqRow.user_id) ?? "" },
    approved: body.action === "approve",
    note: decisionNote,
    expiresAt,
  });

  return NextResponse.json({ ok: true });
}
