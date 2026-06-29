import { createClient as createServiceClient } from "@supabase/supabase-js";
import { notifyBackground } from "@/lib/notifications/send";

/**
 * White-label auth emails.
 *
 * Instead of letting Supabase auto-send invite / magic-link emails (opaque
 * sender, no tenant branding), we mint the link ourselves with the Admin API
 * `generateLink` (which NEVER sends) and dispatch a branded email through the
 * normal notification pipeline — tenant SMTP first, global Resend as fallback.
 *
 * The link uses the cross-device-safe token_hash form our /auth/callback
 * verifies (no PKCE verifier needed), so it works from any device / email app.
 *
 *   invite    → creates the user (if new) + "Activate account" email
 *   magiclink → existing user + "Sign in" email
 *
 * Password reset stays on its existing custom-OTP flow (already tenant SMTP +
 * Resend fallback via the same pipeline).
 */

type AuthLinkType = "invite" | "magiclink";

function svc() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}

export type SendAuthEmailResult = {
  ok: boolean;
  /** True when the email pipeline reported a successful send. */
  sent: boolean;
  userId?: string | null;
  error?: string;
  /** True when generateLink reported the address has no account (magiclink). */
  unknownUser?: boolean;
};

/**
 * Generate a Supabase auth link and email it via the tenant's branded pipeline.
 *
 * @param origin  Live request origin (from originFromRequest()) so the link
 *                points at the host the user is actually on.
 */
export async function sendAuthEmail(opts: {
  organizationId: string;
  email: string;
  type: AuthLinkType;
  origin: string;
  next?: string;
  learnerName?: string;
}): Promise<SendAuthEmailResult> {
  const client = svc();
  const { data, error } = await client.auth.admin.generateLink({
    type: opts.type,
    email: opts.email,
  });

  if (error || !data) {
    // For magic-link login we must not leak whether an account exists — callers
    // treat unknownUser as a silent success (no email, but "if you have an
    // account, we sent a link").
    const msg = error?.message ?? "generateLink failed";
    const unknownUser =
      opts.type === "magiclink" && /not.*found|no.*user|user.*exist/i.test(msg);
    return { ok: unknownUser, sent: false, error: msg, unknownUser };
  }

  const tokenHash = (data.properties as { hashed_token?: string }).hashed_token;
  if (!tokenHash) {
    return { ok: false, sent: false, error: "generateLink returned no token_hash" };
  }

  const next = opts.next ?? "/select-org";
  const base = opts.origin.replace(/\/$/, "");
  const link =
    `${base}/auth/callback?token_hash=${encodeURIComponent(tokenHash)}` +
    `&type=${opts.type}&next=${encodeURIComponent(next)}`;

  const event = opts.type === "invite" ? "account_invite" : "magic_link";
  const res = await notifyBackground({
    organizationId: opts.organizationId,
    event,
    to: { user_id: data.user?.id ?? null, email: opts.email },
    context: {
      learner_name: opts.learnerName,
      // Both keys point at the link; layout uses direct_link/portal_url as the
      // primary CTA target.
      direct_link: link,
      portal_url: link,
    },
  });

  return {
    ok: res?.status === "sent",
    sent: res?.status === "sent",
    userId: data.user?.id ?? null,
    error: res?.error,
  };
}
