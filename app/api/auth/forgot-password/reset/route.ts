import { NextResponse } from "next/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { hashResetToken, safeHashEqual } from "@/lib/auth/password-reset";

/**
 *   POST /api/auth/forgot-password/reset
 *   body: { email, reset_token, new_password }
 *
 * Final step. Verifies the reset_token from /verify, updates the
 * user's password via the service-role admin API, marks the OTP row
 * used. Returns 200 with the email so the client can call
 * supabase.auth.signInWithPassword(...) and drop the user on their
 * dashboard without making them re-type anything.
 *
 * Also clears profiles.must_change_password if it was set so the
 * gate doesn't bounce them back to /change-password.
 */
const MIN_LEN = 10;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    email?: string;
    reset_token?: string;
    new_password?: string;
  };
  const email = body.email?.trim().toLowerCase() ?? "";
  const resetToken = body.reset_token ?? "";
  const newPw = body.new_password ?? "";

  if (!email || !resetToken) {
    return NextResponse.json(
      { error: "Email and reset_token required" },
      { status: 400 }
    );
  }
  if (newPw.length < MIN_LEN) {
    return NextResponse.json(
      { error: `Password must be at least ${MIN_LEN} characters.` },
      { status: 400 }
    );
  }
  // Light strength check (2 of {lower, upper, digit, symbol}).
  let classes = 0;
  if (/[a-z]/.test(newPw)) classes++;
  if (/[A-Z]/.test(newPw)) classes++;
  if (/[0-9]/.test(newPw)) classes++;
  if (/[^A-Za-z0-9]/.test(newPw)) classes++;
  if (classes < 2) {
    return NextResponse.json(
      {
        error:
          "Password must mix at least two of: lowercase, uppercase, digit, symbol.",
      },
      { status: 400 }
    );
  }

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  const { data: rowRaw } = await svc
    .from("password_reset_otps")
    .select(
      "id, reset_token_hash, reset_token_expires, used_at"
    )
    .eq("email", email)
    .is("used_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const row = rowRaw as
    | {
        id: string;
        reset_token_hash: string | null;
        reset_token_expires: string | null;
        used_at: string | null;
      }
    | null;

  if (!row || !row.reset_token_hash || !row.reset_token_expires) {
    return NextResponse.json(
      { error: "No active reset session. Start over." },
      { status: 400 }
    );
  }
  if (new Date(row.reset_token_expires).getTime() < Date.now()) {
    return NextResponse.json(
      { error: "Reset window expired. Request a new code." },
      { status: 400 }
    );
  }
  if (!safeHashEqual(row.reset_token_hash, hashResetToken(resetToken))) {
    return NextResponse.json(
      { error: "Invalid reset token." },
      { status: 401 }
    );
  }

  // Look up the user.
  const { data: listed } = await svc.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });
  const user = listed?.users?.find((u) => u.email?.toLowerCase() === email);
  if (!user) {
    // Shouldn't happen — the OTP row implies the user existed at request time.
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Update password.
  const { error: pwErr } = await svc.auth.admin.updateUserById(user.id, {
    password: newPw,
  });
  if (pwErr) {
    return NextResponse.json({ error: pwErr.message }, { status: 400 });
  }

  // Clear must_change_password if it was set (we just satisfied that flow too).
  await svc
    .from("profiles")
    .update({ must_change_password: false })
    .eq("id", user.id);

  // Mark this row used so the token can't be replayed.
  await svc
    .from("password_reset_otps")
    .update({ used_at: new Date().toISOString() })
    .eq("id", row.id);

  return NextResponse.json({ ok: true, email });
}
