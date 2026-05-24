import { NextResponse } from "next/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { notifyBackground } from "@/lib/notifications/send";
import {
  OTP_TTL_MINUTES,
  MAX_REQUESTS_PER_HOUR,
  generateOtpCode,
  hashOtp,
} from "@/lib/auth/password-reset";

/**
 *   POST /api/auth/forgot-password/request
 *   body: { email }
 *
 * Always returns 200 (never reveals whether the email exists).
 * Rate-limited: 5 requests per email per hour. Sends a 6-digit code
 * via the user's home-org SMTP if they're a member of an org, or
 * via the platform default SMTP otherwise.
 *
 * If the email doesn't match any auth.user, we still spend a few
 * milliseconds hashing a dummy code so the response time doesn't
 * leak account existence.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { email?: string };
  const email = body.email?.trim().toLowerCase() ?? "";

  // Reject obviously bad input early but still return 200 below.
  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  if (validEmail) {
    // Rate-limit lookup.
    const { count } = await svc
      .from("password_reset_otps")
      .select("id", { count: "exact", head: true })
      .eq("email", email)
      .gte("created_at", new Date(Date.now() - 60 * 60 * 1000).toISOString());

    if ((count ?? 0) < MAX_REQUESTS_PER_HOUR) {
      // Look up the user. We don't fail if they don't exist — we still
      // act like we sent a code so attackers can't enumerate accounts.
      const { data: listed } = await svc.auth.admin.listUsers({
        page: 1,
        perPage: 1000,
      });
      const user = listed?.users?.find((u) => u.email?.toLowerCase() === email);

      if (!user) {
        console.warn(
          `[forgot-password] no auth.user for email=${email} — silently returning 200`
        );
      }
      if (user) {
        const code = generateOtpCode();
        const codeHash = hashOtp(code);
        // DEV ONLY: log the code so you can verify the flow end-to-end
        // even without SMTP set up. Strip this for production.
        if (process.env.NODE_ENV !== "production") {
          console.log(`\n[forgot-password] DEV CODE for ${email}: ${code}\n`);
        }
        const expiresAt = new Date(
          Date.now() + OTP_TTL_MINUTES * 60_000
        ).toISOString();

        const ip =
          request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
          null;
        const ua = request.headers.get("user-agent") ?? null;

        // Invalidate any active prior codes for this email.
        await svc
          .from("password_reset_otps")
          .update({ used_at: new Date().toISOString() })
          .eq("email", email)
          .is("used_at", null);

        await svc.from("password_reset_otps").insert({
          email,
          code_hash: codeHash,
          expires_at: expiresAt,
          ip,
          user_agent: ua,
        });

        // Pick an org to attribute the email to — the user's first org
        // membership, or any org if none. We need an organization_id
        // for notifyBackground() to resolve SMTP + branding.
        const { data: mem } = await svc
          .from("organization_members")
          .select("organization_id, organizations(name)")
          .eq("user_id", user.id)
          .limit(1)
          .maybeSingle();
        type MemOrg = { name: string };
        const memRow = mem as
          | {
              organization_id: string;
              organizations: MemOrg | MemOrg[] | null;
            }
          | null;
        const orgObj: MemOrg | undefined = memRow
          ? Array.isArray(memRow.organizations)
            ? memRow.organizations[0]
            : memRow.organizations ?? undefined
          : undefined;
        const organizationId = memRow?.organization_id;
        const orgName = orgObj?.name ?? "your workspace";

        if (!organizationId) {
          console.warn(
            `[forgot-password] user ${user.id} (${email}) is not in any org — cannot resolve SMTP. Email NOT sent.`
          );
        } else {
          console.log(
            `[forgot-password] dispatching password_reset email to ${email} via org=${organizationId} (${orgName})`
          );
          try {
            const result = await notifyBackground({
              organizationId,
              event: "password_reset",
              to: { user_id: user.id, email },
              context: {
                learner_name: email,
                learner_email: email,
                otp_code: code,
                otp_minutes: String(OTP_TTL_MINUTES),
                org_name: orgName,
              },
            });
            console.log(
              `[forgot-password] notifyBackground result:`,
              result ?? "(no return value)"
            );
          } catch (e) {
            console.error(`[forgot-password] notifyBackground threw:`, e);
          }
        }
      }
    }
  }

  return NextResponse.json({
    ok: true,
    message:
      "If an account exists with that email, we just sent a 6-digit code. It expires in 10 minutes.",
  });
}
