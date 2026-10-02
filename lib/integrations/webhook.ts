import { createHmac } from "crypto";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { fetchReferenceCodes } from "@/lib/reference-codes";

/**
 * Completion webhook to the CRM (0071). Fired fail-isolated from the SCORM
 * commit path when an attempt first transitions to completed/passed, so the
 * employee's record in the CRM updates without polling.
 *
 * Delivery contract (document to the CRM team):
 *   POST <webhook_url>
 *   content-type: application/json
 *   x-ambak-event: course_completed
 *   x-ambak-signature: sha256=<hex hmac of the raw body, keyed by webhook_secret>
 *
 * Best-effort, 5s timeout, one attempt — the CRM can always reconcile via
 * GET /api/integrations/learner-summary. A failure here must NEVER affect
 * the learner's commit.
 */

export type CompletionWebhookPayload = {
  event: "course_completed";
  organization: string; // org slug
  employee_id: string | null;
  email: string | null;
  user_id: string;
  course_id: string;
  /** Human-readable reference code (MOD0015), null before migration 0079. */
  course_code: string | null;
  course_title: string;
  score: number | null; // 0-100
  passed: boolean;
  completed_at: string; // ISO
  /** 1-based number of this completed attempt among the learner's attempts on the course. */
  attempt_number: number | null;
  /** Always true: revision (practice) attempts never fire this webhook. */
  official: boolean;
};

/**
 * Build and fire the completion webhook for an attempt from the database
 * alone (no request session): used by the cmi5 / xAPI completion path.
 * Caller has already decided the attempt is OFFICIAL.
 */
export async function fireCompletionWebhookForAttempt(
  attemptId: string,
  attemptNumber: number | null
): Promise<void> {
  try {
    const svc = createServiceClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } }
    );
    // Single-fire latch (0082): the cmi5/xAPI route can't serialize the
    // content package's concurrent statement POSTs the way the SCORM runtime
    // serializes commits, so two requests could both pass the in-memory
    // "was it already complete" check and fire twice. An atomic null->now()
    // update on completion_webhook_at lets exactly one caller win. Fail-soft:
    // on a pre-0082 database (column absent) the update errors and we fall
    // through to firing — same at-most-once-ish behaviour as before.
    const latch = await svc
      .from("course_attempts")
      .update({ completion_webhook_at: new Date().toISOString() })
      .eq("id", attemptId)
      .is("completion_webhook_at", null)
      .select("id");
    if (!latch.error && (latch.data?.length ?? 0) === 0) {
      // Column exists and another request already latched → it fires; we stop.
      return;
    }
    // Deploy-safety: do NOT embed reference_code (0079) here — on a pre-0079
    // database that column is absent and the whole query would error, so
    // supabase-js returns {data:null} and the webhook would be silently
    // dropped. Select only long-standing columns; resolve the code fail-soft
    // with fetchReferenceCodes, exactly as the SCORM commit path does.
    const { data: row, error: rowErr } = await svc
      .from("course_attempts")
      .select(
        "organization_id, user_id, score, success_status, completed_at, course_versions(course_id, courses!course_versions_course_id_fkey(title))"
      )
      .eq("id", attemptId)
      .maybeSingle();
    if (rowErr) {
      console.warn("[integrations] completion webhook (attempt) row fetch failed:", rowErr.message);
      return;
    }
    const r = row as {
      organization_id: string;
      user_id: string;
      score: number | null;
      success_status: string | null;
      completed_at: string | null;
      course_versions?: {
        course_id: string;
        courses?: { title?: string } | Array<{ title?: string }>;
      } | Array<{ course_id: string; courses?: { title?: string } | Array<{ title?: string }> }>;
    } | null;
    if (!r) return;
    const cv = Array.isArray(r.course_versions) ? r.course_versions[0] : r.course_versions;
    const course = cv ? (Array.isArray(cv.courses) ? cv.courses[0] : cv.courses) : undefined;
    const courseCode = cv?.course_id ? (await fetchReferenceCodes(svc, "courses", [cv.course_id])).get(cv.course_id) ?? null : null;
    const [{ data: orgRow }, { data: memRow }, { data: prof }] = await Promise.all([
      svc.from("organizations").select("slug").eq("id", r.organization_id).maybeSingle(),
      svc.from("organization_members").select("employee_id").eq("organization_id", r.organization_id).eq("user_id", r.user_id).maybeSingle(),
      svc.from("profiles").select("email").eq("id", r.user_id).maybeSingle(),
    ]);
    await fireCompletionWebhook(r.organization_id, {
      event: "course_completed",
      organization: (orgRow as { slug?: string } | null)?.slug ?? "",
      employee_id: (memRow as { employee_id?: string | null } | null)?.employee_id ?? null,
      email: (prof as { email?: string | null } | null)?.email ?? null,
      user_id: r.user_id,
      course_id: cv?.course_id ?? "",
      course_code: courseCode,
      course_title: course?.title ?? "",
      score: typeof r.score === "number" ? Math.round(r.score * 100) : null,
      passed: r.success_status === "passed",
      completed_at: r.completed_at ?? new Date().toISOString(),
      attempt_number: attemptNumber,
      official: true,
    });
  } catch (e) {
    console.warn("[integrations] completion webhook (attempt) failed:", e);
  }
}

export async function fireCompletionWebhook(
  organizationId: string,
  payload: CompletionWebhookPayload
): Promise<void> {
  try {
    const svc = createServiceClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } }
    );
    const { data } = await svc
      .from("org_integration_settings")
      .select("webhook_url, webhook_secret")
      .eq("organization_id", organizationId)
      .maybeSingle();
    const cfg = data as { webhook_url: string | null; webhook_secret: string | null } | null;
    const url = cfg?.webhook_url?.trim();
    // https only — except loopback, so integration tests can run a local
    // listener. Never plain http to a real host.
    const allowed =
      !!url &&
      (/^https:\/\//i.test(url) ||
        /^http:\/\/(127\.0\.0\.1|localhost)(:|\/)/i.test(url));
    if (!allowed) return;

    const body = JSON.stringify(payload);
    const signature = cfg?.webhook_secret
      ? `sha256=${createHmac("sha256", cfg.webhook_secret).update(body).digest("hex")}`
      : "";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-ambak-event": payload.event,
          ...(signature ? { "x-ambak-signature": signature } : {}),
        },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    console.warn("[integrations] completion webhook failed:", e);
  }
}
