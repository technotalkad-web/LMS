/**
 * Global Resend transport — the platform-level fallback sender for emails when
 * a tenant has no SMTP configured (or its SMTP send fails). Resend is an HTTP
 * API, so it works from Cloudflare Workers (no raw sockets, unlike tenant SMTP
 * which goes through the send-smtp Edge Function).
 *
 * Inert until configured: RESEND_API_KEY (Worker secret) + RESEND_FROM
 * (e.g. "Ambak University <no-reply@ambak.com>"). When unset, dispatchResend
 * returns { ok: false } so callers treat it as "no fallback available".
 */

export function resendConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM);
}

export type ResendPayload = {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  /** Override the global RESEND_FROM (rarely needed). */
  from?: string;
};

export async function dispatchResend(
  payload: ResendPayload
): Promise<{ ok: boolean; error?: string }> {
  const key = process.env.RESEND_API_KEY;
  const from = payload.from || process.env.RESEND_FROM;
  if (!key) return { ok: false, error: "RESEND_API_KEY not set" };
  if (!from) return { ok: false, error: "RESEND_FROM not set" };

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [payload.to],
        subject: payload.subject,
        html: payload.html,
        text: payload.text,
        ...(payload.replyTo ? { reply_to: payload.replyTo } : {}),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `Resend HTTP ${res.status}: ${body.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Resend fetch failed" };
  }
}
