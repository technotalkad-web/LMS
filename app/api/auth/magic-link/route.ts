import { NextResponse } from "next/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { originFromRequest } from "@/lib/http/origin";
import { sendAuthEmail, sendPlatformMagicLink } from "@/lib/auth/auth-email";
import { safeNextPath } from "@/lib/auth/safe-next";

/**
 *   POST /api/auth/magic-link   body: { email, orgSlug?, next? }
 *
 * White-label magic-link sign-in. Mints the link via the Admin API (no Supabase
 * auto-send) and emails it:
 *   - tenant context (orgSlug) → the tenant's branded SMTP (Resend fallback),
 *     only when the address belongs to a member of that organisation
 *     (lib/auth/auth-email.ts states the rule); anyone else gets the generic
 *     platform email
 *   - platform login (no orgSlug, or an unknown one) → global Resend sender
 *
 * `next` (optional) is a same-app path to land on after sign-in — used by
 * deep links (e.g. QR-code scans of a course) so the emailed link returns the
 * learner to the exact page they scanned, not the dashboard. It passes only
 * when it is an address on this site (lib/auth/safe-next.ts); anything else
 * falls back to the dashboard.
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
  const safeNext = safeNextPath(body.next);

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
  await sendPlatformMagicLink({ email, origin });
  return NextResponse.json({ ok: true });
}
