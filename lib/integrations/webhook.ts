import { createHmac } from "crypto";
import { createClient as createServiceClient } from "@supabase/supabase-js";

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
  course_title: string;
  score: number | null; // 0-100
  passed: boolean;
  completed_at: string; // ISO
};

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
