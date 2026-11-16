import { NextResponse } from "next/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import {
  MAX_VERIFY_ATTEMPTS,
  RESET_TOKEN_TTL_MINUTES,
  VERIFY_FAILED_MESSAGE,
  countGuess,
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
 * Each guess is counted before it is compared: countGuess() moves the row's
 * attempts up by one in a single compare-and-set and hands back the code
 * hash only to the guess that took that slot. A guess that did not take a
 * slot is answered the failure and never compared, so overlapping guesses
 * cannot compare more than MAX_VERIFY_ATTEMPTS times on one row. A row at
 * the limit is marked used and the user must request a fresh code.
 *
 * Every failure gets one answer: a missing, expired, used or wrong code and
 * too many attempts all answer 400 with VERIFY_FAILED_MESSAGE. The answer
 * names no remaining count and does not depend on whether the address has
 * an account.
 */
const failed = () =>
  NextResponse.json({ error: VERIFY_FAILED_MESSAGE }, { status: 400 });

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

  // Find the most recent active code for this email. The code hash is not
  // read here: it comes only from the counted guess below.
  const { data: rowRaw } = await svc
    .from("password_reset_otps")
    .select("id, expires_at, attempts")
    .eq("email", email)
    .is("used_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const row = rowRaw as
    | {
        id: string;
        expires_at: string;
        attempts: number;
      }
    | null;

  if (!row) return failed();
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await svc
      .from("password_reset_otps")
      .update({ used_at: new Date().toISOString() })
      .eq("id", row.id);
    return failed();
  }
  if (row.attempts >= MAX_VERIFY_ATTEMPTS) {
    await svc
      .from("password_reset_otps")
      .update({ used_at: new Date().toISOString() })
      .eq("id", row.id);
    return failed();
  }

  // Count the guess first. No slot, no compare.
  const codeHash = await countGuess(svc, row);
  if (codeHash === null) return failed();
  if (!safeHashEqual(codeHash, hashOtp(code))) return failed();

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
