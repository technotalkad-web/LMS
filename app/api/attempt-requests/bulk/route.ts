import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { originFromRequest } from "@/lib/http/origin";
import { computeScoring, type ScorableAttempt } from "@/lib/scoring/policy";
import { resolvePolicy } from "@/lib/scoring/resolve";
import {
  fetchPassRequired,
  grantSnapshotForUsers,
  readPagedWithOptionalColumn,
  type GrantSnapshot,
  type PgError,
} from "@/lib/scoring/attempt-kind";
import { bulkEligibility } from "@/lib/attempts/request-decision";
import { resolveEmails } from "@/lib/users/emails";
import {
  ADMIN_ROLES,
  expiryFromDays,
  notifyLearnerOfDecision,
} from "@/lib/attempts/requests";

/**
 *   POST /api/attempt-requests/bulk?orgSlug=acme
 *   body: { courseId, expires_in_days? }
 *
 * Grant one extra official attempt to EVERY learner who has an official
 * result on this module and did not pass — no individual request needed.
 * Each grant is an approved `source='bulk'` row the learner's next launch
 * consumes. Learners who already hold an open request or an unused grant are
 * skipped (the partial unique index would reject a second one), and so are
 * learners whose granted retake is still in progress (ADR 0014 step 11 (5),
 * counted in `skipped_live_retake`). A learner who passed is never granted
 * here: they ask from the course page and the admin approves with the
 * confirmation. Every read is error-checked (the versions, the attempts, the
 * grants, the open requests): any error answers 503 and nothing is inserted.
 */
/** `status` is a 0002 column; only `is_revision` (0103) can be missing (the narrower-select fallback). */
const ATTEMPT_COLUMNS = "id, user_id, status, score, started_at, completed_at, completion_status, success_status";
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

export async function POST(request: Request) {
  const orgSlug = new URL(request.url).searchParams.get("orgSlug");
  if (!orgSlug) return NextResponse.json({ error: "orgSlug required" }, { status: 400 });
  const body = (await request.json().catch(() => ({}))) as {
    courseId?: string;
    expires_in_days?: number | null;
  };
  if (!body.courseId) return NextResponse.json({ error: "courseId required" }, { status: 400 });

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
  const { data: course } = await s
    .from("courses")
    .select("id, title")
    .eq("id", body.courseId)
    .eq("organization_id", org.id)
    .maybeSingle();
  if (!course) return NextResponse.json({ error: "Course not found" }, { status: 404 });

  // ADR 0014 step 11 (5): every read before the insert fails closed.
  const unreadable = (read: string) => {
    console.warn(JSON.stringify({ event: "bulk_grant_records_unreadable", course_id: course.id, read }));
    return NextResponse.json({ error: "records_unreadable" }, { status: 503 });
  };

  // All version ids of the module (scoring spans versions/languages).
  const { data: verRows, error: verErr } = await s
    .from("course_versions")
    .select("id")
    .eq("course_id", course.id);
  if (verErr || !verRows) return unreadable("versions");
  const verIds = (verRows as Array<{ id: string }>).map((v) => v.id);
  if (verIds.length === 0) {
    return NextResponse.json({ ok: true, granted: 0, skipped: 0, skipped_live_retake: 0, failed_total: 0 });
  }

  // Every attempt on those versions, paginated, grouped by learner. The rows
  // carry `status` and `is_revision` (the narrower-select fallback,
  // readPagedWithOptionalColumn: the first page decides the column list for
  // the rest), so an abandoned or a revision visit's row never counts and a
  // live retake is seen. Any failed page, or a page with neither rows nor an
  // error, answers 503.
  type Att = ScorableAttempt & { user_id: string };
  const attemptsRead = await readPagedWithOptionalColumn<Att>(
    "is_revision",
    (cols, from, to) =>
      s
        .from("course_attempts")
        .select(cols)
        .eq("organization_id", org.id)
        .in("course_version_id", verIds)
        .order("id")
        .range(from, to) as unknown as PromiseLike<{ data: Att[] | null; error: PgError }>,
    ATTEMPT_COLUMNS,
    { nullIsError: true }
  );
  if (attemptsRead.error) return unreadable("attempts");
  const attempts = attemptsRead.data;
  const byUser = new Map<string, Att[]>();
  for (const a of attempts) byUser.set(a.user_id, [...(byUser.get(a.user_id) ?? []), a]);
  const userIds = [...byUser.keys()];
  if (userIds.length === 0) {
    return NextResponse.json({ ok: true, granted: 0, skipped: 0, skipped_live_retake: 0, failed_total: 0 });
  }

  const policy = await resolvePolicy(s, course.id);
  const passRequired = (await fetchPassRequired(s, [course.id])).has(course.id);
  let snapshots: Map<string, GrantSnapshot>;
  try {
    snapshots = await grantSnapshotForUsers(s, org.id, [course.id], userIds);
  } catch {
    return unreadable("grants");
  }

  // "Failed" = the official attempt exists and did not pass (a failed verdict,
  // or — on a pass-required module — anything short of a pass), and no
  // granted retake is live (bulkEligibility, the rule's one definition).
  const failedUserIds: string[] = [];
  let skippedLiveRetake = 0;
  const usedByUser = new Map<string, number>(); // 0085: completed official attempts at grant time
  for (const uid of userIds) {
    const list = byUser.get(uid)!;
    const sc = computeScoring(list, policy, snapshots.get(`${uid}:${course.id}`)?.retakeIds ?? []);
    const verdict = bulkEligibility({ scoring: sc, attempts: list, passRequired });
    if (verdict === "retake_live") skippedLiveRetake++;
    if (verdict !== "grant") continue;
    failedUserIds.push(uid);
    usedByUser.set(uid, sc.scoredAttempts);
  }
  if (failedUserIds.length === 0) {
    return NextResponse.json({ ok: true, granted: 0, skipped: 0, skipped_live_retake: skippedLiveRetake, failed_total: 0 });
  }

  // Skip learners who already hold an OPEN row (pending, or approved+unused) —
  // the partial unique index enforces one-open-per-learner anyway.
  const { data: openRows, error: openErr } = await s
    .from("attempt_requests")
    .select("user_id, status, used_at")
    .eq("course_id", course.id)
    .in("user_id", failedUserIds);
  if (openErr || !openRows) return unreadable("open requests");
  const alreadyOpen = new Set<string>();
  for (const r of openRows as Array<{ user_id: string; status: string; used_at: string | null }>) {
    if (r.status === "pending" || (r.status === "approved" && r.used_at === null)) alreadyOpen.add(r.user_id);
  }
  const grantTo = failedUserIds.filter((uid) => !alreadyOpen.has(uid));
  if (grantTo.length === 0) {
    return NextResponse.json({
      ok: true,
      granted: 0,
      skipped: failedUserIds.length,
      skipped_live_retake: skippedLiveRetake,
      failed_total: failedUserIds.length,
    });
  }

  const nowIso = new Date().toISOString();
  const expiresAt = expiryFromDays(body.expires_in_days);
  // 0085: attempts_used records the learner's completed official attempts at
  // grant time ("Nth attempt failed → granting (N+1)th"), kept for the history
  // and reports.
  const baseRows = grantTo.map((uid) => ({
    organization_id: org.id,
    course_id: course.id,
    user_id: uid,
    status: "approved",
    source: "bulk",
    decided_by: user.id,
    decided_at: nowIso,
    expires_at: expiresAt,
  }));
  const rows = baseRows.map((r, i) => ({ ...r, attempts_used: usedByUser.get(grantTo[i]) ?? null }));
  let { data: insertedRows, error: insErr } = await s
    .from("attempt_requests")
    .insert(rows)
    .select("user_id");
  // Fail-soft before 0085 lands: retry without the new column.
  if (insErr && (insErr as { code?: string }).code === "42703") {
    ({ data: insertedRows, error: insErr } = await s
      .from("attempt_requests")
      .insert(baseRows)
      .select("user_id"));
  }
  if (insErr) return NextResponse.json({ error: insErr.message }, { status: 400 });
  const grantedIds = ((insertedRows ?? []) as Array<{ user_id: string }>).map((r) => r.user_id);

  // Notify each granted learner (background).
  const [emailMap, origin] = await Promise.all([
    resolveEmails(s, grantedIds),
    originFromRequest(),
  ]);
  for (const uid of grantedIds) {
    await notifyLearnerOfDecision(s, {
      orgId: org.id as string,
      orgName: (org.name as string) ?? "your org",
      orgSlug,
      origin,
      courseId: course.id as string,
      courseTitle: (course.title as string) ?? "a course",
      learner: { id: uid, email: emailMap.get(uid) ?? "" },
      approved: true,
      note: null,
      expiresAt,
    });
  }

  return NextResponse.json({
    ok: true,
    granted: grantedIds.length,
    skipped: failedUserIds.length - grantedIds.length,
    skipped_live_retake: skippedLiveRetake,
    failed_total: failedUserIds.length,
  });
}
