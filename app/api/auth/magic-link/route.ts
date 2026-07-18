import { NextResponse } from "next/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { originFromRequest } from "@/lib/http/origin";
import { sendAuthEmail } from "@/lib/auth/auth-email";
import { dispatchResend, resendConfigured } from "@/lib/email/resend";

/**
 *   POST /api/auth/magic-link   body: { email, orgSlug?, next? }
 *
 * White-label magic-link sign-in. Mints the link via the Admin API (no Supabase
 * auto-send) and emails it:
 *   - tenant context (orgSlug) → the tenant's branded SMTP (Resend fallback)
 *   - platform login (no orgSlug) → global Resend sender
 *
 * `next` (optional) is a same-app path to land on after sign-in — used by
 * deep links (e.g. QR-code scans of a course) so the emailed link returns the
 * learner to the exact page they scanned, not the dashboard. Validated to a
 * single leading "/" so it can't become an open redirect.
 *
 * Always returns { ok: true } so the form can't be used to enumerate accounts.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    email?: string;
    orgSlug?: string;
    next?: string;
  };
  const email = (body.email ?? "").trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "A valid email is required" }, { status: 400 });
  }
  const safeNext =
    body.next && body.next.startsWith("/") && !body.next.startsWith("//")
      ? body.next
      : null;

  const origin = (await originFromRequest()) || "";

  // Tenant path: branded login carries orgSlug → white-label via tenant SMTP.
  if (body.orgSlug) {
    const svc = createServiceClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } }
    );
    const { data: org } = await svc
      .from("organizations")
      .select("id, slug")
      .eq("slug", body.orgSlug)
      .maybeSingle();
    if (org) {
      await sendAuthEmail({
        organizationId: org.id as string,
        email,
        type: "magiclink",
        origin,
        next: safeNext ?? `/${org.slug}/dashboard`,
      });
      // Enumeration-safe regardless of whether the user exists.
      return NextResponse.json({ ok: true });
    }
    // Unknown org → fall through to generic (still don't leak anything).
  }

  // Platform path (no org context): generic link via global Resend.
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  const { data, error } = await svc.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (!error && data && resendConfigured()) {
    const tokenHash = (data.properties as { hashed_token?: string }).hashed_token;
    if (tokenHash) {
      const link =
        `${origin.replace(/\/$/, "")}/auth/callback?token_hash=${encodeURIComponent(tokenHash)}` +
        `&type=magiclink&next=${encodeURIComponent("/select-org")}`;
      await dispatchResend({
        to: email,
        subject: "Your sign-in link",
        html: `<p>Click to sign in:</p><p><a href="${link}">Sign in</a></p><p>If you didn't request this, you can ignore this email.</p>`,
        text: `Sign in: ${link}`,
      });
    }
  }
  return NextResponse.json({ ok: true });
}
