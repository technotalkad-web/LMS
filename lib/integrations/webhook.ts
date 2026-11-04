import { createHmac } from "crypto";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { fetchReferenceCodes } from "@/lib/reference-codes";
import { isMissingColumn } from "@/lib/scoring/attempt-kind";

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
 *
 * cmi5 / xAPI (ADR 0015 step 4). fireCompletionWebhookForAttempt is called by
 * the statements route and by the sweep of /api/cron/gamification-refresh
 * when lib/integrations/webhook-hold.ts decides to fire, and again with
 * `refireFrom` for the re-fire: when an attempt becomes passed after a
 * message that said not passed, one second message, `passed: true`, the same
 * `attempt_number`. So at most two messages go out per official attempt, and
 * the latch (`completion_webhook_at`) means "fired, and moved once by the
 * re-fire" rather than "fired once". The 0082 column comment ("Set once when
 * the CRM course_completed webhook is fired") is therefore stale on re-fired
 * rows; no migration is written for a comment.
 *
 * The order (ADR 0015 step 4). Every read comes first: the payload row, the
 * reference code, the organisation, member and profile, then the settings.
 * The compare-and-set on the latch comes next, immediately before the POST.
 * On a first fire, a failed payload-row, organisation, member, profile or
 * settings read returns false with the latch untouched, so the row stays a
 * candidate for the next request or the next sweep. A re-fire has no retry: a
 * failed organisation, member or profile read still sends its message, with
 * that field blank and user_id in the payload, because `passed: true` must not
 * be lost for a blank identity field; a failed payload-row or settings read
 * loses the re-fire, and learner-summary stays authoritative. The reference
 * code stays fail-soft on both (course_code null, fetchReferenceCodes' own
 * rule). The latch is taken whether or not the organisation has a webhook URL,
 * so a null latch keeps meaning "the decision to fire was never taken" and an
 * organisation without a URL is not re-swept.
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

/** An organisation's webhook settings row; null when the organisation has none. */
type WebhookSettings = { webhook_url: string | null; webhook_secret: string | null };

/**
 * Build and fire the completion webhook for an attempt from the database
 * alone (no request session): used by the cmi5 / xAPI completion path.
 * Caller has already decided the attempt is OFFICIAL. With `refireFrom` this
 * is the re-fire of ADR 0015 step 4: the latch moves only if it still holds
 * the value the caller read before its batch.
 *
 * Returns true when this call took the latch and handed the message to the
 * dispatch (on a database without 0082, where the latch update answers a
 * missing column, a first fire falls through to the dispatch and also returns
 * true); false when it did not take the latch (another caller holds it, or a
 * read failed before it, or the latch update answered any other error, or a
 * re-fire's compare-and-set errored).
 */
export async function fireCompletionWebhookForAttempt(
  attemptId: string,
  attemptNumber: number | null,
  opts?: { refireFrom: string }
): Promise<boolean> {
  try {
    const svc = createServiceClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } }
    );
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
      return false;
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
    if (!r) return false;
    const cv = Array.isArray(r.course_versions) ? r.course_versions[0] : r.course_versions;
    const course = cv ? (Array.isArray(cv.courses) ? cv.courses[0] : cv.courses) : undefined;
    const courseCode = cv?.course_id ? (await fetchReferenceCodes(svc, "courses", [cv.course_id])).get(cv.course_id) ?? null : null;
    const [{ data: orgRow, error: orgErr }, { data: memRow, error: memErr }, { data: prof, error: profErr }] = await Promise.all([
      svc.from("organizations").select("slug").eq("id", r.organization_id).maybeSingle(),
      svc.from("organization_members").select("employee_id").eq("organization_id", r.organization_id).eq("user_id", r.user_id).maybeSingle(),
      svc.from("profiles").select("email").eq("id", r.user_id).maybeSingle(),
    ]);
    // ADR 0015 step 4. A first fire is retried, so a failed read stops it here
    // with the latch untouched. A re-fire is not: it goes on with the field
    // blank, because `passed: true` must not be lost for a blank identity field.
    const identityErr = orgErr ?? memErr ?? profErr;
    if (identityErr) {
      console.warn("[integrations] completion webhook (attempt) organisation, member or profile read failed:", identityErr.message);
      if (!opts?.refireFrom) return false;
    }
    // The settings are read here, before the latch, and handed to the
    // dispatch, so a failed settings read leaves the latch untouched. A
    // missing settings row is data null with no error: the latch is still
    // taken below.
    const { data: settingsRow, error: settingsErr } = await svc
      .from("org_integration_settings")
      .select("webhook_url, webhook_secret")
      .eq("organization_id", r.organization_id)
      .maybeSingle();
    if (settingsErr) {
      console.warn("[integrations] completion webhook (attempt) settings read failed:", settingsErr.message);
      return false;
    }
    const cfg = settingsRow as WebhookSettings | null;
    const payload: CompletionWebhookPayload = {
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
    };
    // Single-fire latch (0082), taken last, immediately before the dispatch
    // (ADR 0015 step 4): the cmi5/xAPI route can't serialize the content
    // package's concurrent statement POSTs the way the SCORM runtime
    // serializes commits, so two requests could both decide to fire. An
    // atomic update on completion_webhook_at lets exactly one caller win:
    // null -> now() for a first fire; for the re-fire, a compare-and-set on
    // the value the caller read before its batch, so of two requests that see
    // the same change to passed exactly one moves the latch and fires. The
    // latch therefore records "fired, and moved once by the re-fire"; the
    // 0082 column comment ("Set once ...") is stale on re-fired rows. One
    // chain, one write site. Fail-soft for one case only (ADR 0015 steps 2 and
    // 4): on a pre-0082 database the update answers a missing column and a
    // first fire falls through to firing, the same at-most-once-ish behaviour
    // as before. Any other error answers false: no POST, the latch null, the
    // row retried, because a null latch re-arms the `terminated` branch and the
    // sweep, so a fall-through would repeat the message on each later request
    // and run. A re-fire never falls through. The residual: a PATCH that
    // applied and whose response was lost gives no message and a set latch, the
    // same class as a cut between the compare-and-set and the POST, and
    // learner-summary stays authoritative.
    let latchQuery = svc.from("course_attempts").update({ completion_webhook_at: new Date().toISOString() }).eq("id", attemptId);
    latchQuery = opts?.refireFrom
      ? latchQuery.eq("completion_webhook_at", opts.refireFrom)
      : latchQuery.is("completion_webhook_at", null);
    const latch = await latchQuery.select("id");
    if (latch.error) {
      if (opts?.refireFrom || !isMissingColumn(latch.error, "completion_webhook_at")) {
        console.warn("[integrations] completion webhook (attempt) latch update failed:", attemptId, latch.error.code);
        return false;
      }
    } else if ((latch.data?.length ?? 0) === 0) {
      // Column exists and another request already latched (or moved) it → it fires; we stop.
      return false;
    }
    await fireCompletionWebhook(r.organization_id, payload, cfg);
    return true;
  } catch (e) {
    console.warn("[integrations] completion webhook (attempt) failed:", e);
    return false;
  }
}

/**
 * `cfg`: the organisation's settings when the caller has already read them
 * (ADR 0015 step 4); given means `cfg !== undefined`, and `null` is a given
 * value meaning "no settings row", so a missing row is not read twice. The
 * SCORM commit route passes nothing and the settings are read here.
 */
export async function fireCompletionWebhook(
  organizationId: string,
  payload: CompletionWebhookPayload,
  cfg?: WebhookSettings | null
): Promise<void> {
  try {
    let settings: WebhookSettings | null;
    if (cfg !== undefined) {
      settings = cfg;
    } else {
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
      settings = data as WebhookSettings | null;
    }
    const url = settings?.webhook_url?.trim();
    // https only — except loopback, so integration tests can run a local
    // listener. Never plain http to a real host.
    const allowed =
      !!url &&
      (/^https:\/\//i.test(url) ||
        /^http:\/\/(127\.0\.0\.1|localhost)(:|\/)/i.test(url));
    if (!allowed) return;

    const body = JSON.stringify(payload);
    const signature = settings?.webhook_secret
      ? `sha256=${createHmac("sha256", settings.webhook_secret).update(body).digest("hex")}`
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
