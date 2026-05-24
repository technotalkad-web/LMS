import { NextResponse } from "next/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import {
  MAX_VERIFY_ATTEMPTS,
  RESET_TOKEN_TTL_MINUTES,
  hashOtp,
  hashResetToken,
  mintResetToken,
  safeHashEqual,
} from "@/lib/auth/password-reset";

/**
 *   POST /api/auth/forgot-password/verify
 *   body: { email, code }
 *
 * Verifies the 6-digit code. On success, mints a reset token (returned
 * to the client) that is required by the /reset endpoint. The reset
 * token expires in 15 minutes — separate from the OTP expiry — so the
 * user has time to choose a password without re-entering the code.
 *
 * After MAX_VERIFY_ATTEMPTS wrong guesses on the same row, the row is
 * marked used and the user must request a fresh code.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    email?: string;
    code?: string;
  };
  const email = body.email?.trim().toLowerCase() ?? "";
  const code = (body.code ?? "").replace(/\D/g, "");

  if (!email || code.length !== 6) {
    return NextResponse.json(
      { error: "Email and 6-digit code required" },
      { status: 400 }
    );
  }

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  // Find the most recent active code for this email.
  const { data: rowRaw } = await svc
    .from("password_reset_otps")
    .select("id, code_hash, expires_at, attempts, used_at")
    .eq("email", email)
    .is("used_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const row = rowRaw as
    | {
        id: string;
        code_hash: string;
        expires_at: string;
        attempts: number;
        used_at: string | null;
      }
    | null;

  if (!row) {
    return NextResponse.json(
      { error: "No active code. Request a new one." },
      { status: 400 }
    );
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await svc
      .from("password_reset_otps")
      .update({ used_at: new Date().toISOString() })
      .eq("id", row.id);
    return NextResponse.json(
      { error: "Code expired. Request a new one." },
      { status: 400 }
    );
  }
  if (row.attempts >= MAX_VERIFY_ATTEMPTS) {
    await svc
      .from("password_reset_otps")
      .update({ used_at: new Date().toISOString() })
      .eq("id", row.id);
    return NextResponse.json(
      { error: "Too many wrong attempts. Request a new code." },
      { status: 429 }
    );
  }

  const ok = safeHashEqual(row.code_hash, hashOtp(code));
  if (!ok) {
    await svc
      .from("password_reset_otps")
      .update({ attempts: row.attempts + 1 })
      .eq("id", row.id);
    const left = Math.max(0, MAX_VERIFY_ATTEMPTS - row.attempts - 1);
    return NextResponse.json(
      {
        error:
          left > 0
            ? `Incorrect code. ${left} attempt${left === 1 ? "" : "s"} remaining.`
            : "Incorrect code. Request a new one.",
      },
      { status: 400 }
    );
  }

  // Mint a reset token. Hash it before storing so a DB dump can't
  // be used to reset arbitrary passwords.
  const token = mintResetToken();
  const tokenExpires = new Date(
    Date.now() + RESET_TOKEN_TTL_MINUTES * 60_000
  ).toISOString();
  await svc
    .from("password_reset_otps")
    .update({
      reset_token_hash: hashResetToken(token),
      reset_token_expires: tokenExpires,
    })
    .eq("id", row.id);

  return NextResponse.json({
    ok: true,
    reset_token: token,
    expires_in_minutes: RESET_TOKEN_TTL_MINUTES,
  });
}
