import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";

/**
 *   POST /api/auth/change-password
 *   body: { new_password: string }
 *
 * Changes the current user's password and clears the
 * profiles.must_change_password flag so the next request stops bouncing
 * them to /change-password.
 *
 * We use the regular session client to call auth.updateUser — Supabase
 * verifies the JWT and only allows self-update. The service-role client
 * is used afterward to clear the profile flag because RLS on profiles
 * doesn't grant the user write access to that column directly.
 */
const MIN_LEN = 10;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { new_password?: string };
  const pw = body.new_password?.trim() ?? "";
  if (pw.length < MIN_LEN) {
    return NextResponse.json(
      { error: `Password must be at least ${MIN_LEN} characters.` },
      { status: 400 }
    );
  }
  // Light strength check: require at least 2 of {lower, upper, digit, symbol}.
  let classes = 0;
  if (/[a-z]/.test(pw)) classes++;
  if (/[A-Z]/.test(pw)) classes++;
  if (/[0-9]/.test(pw)) classes++;
  if (/[^A-Za-z0-9]/.test(pw)) classes++;
  if (classes < 2) {
    return NextResponse.json(
      {
        error:
          "Password must mix at least two of: lowercase, uppercase, digit, symbol.",
      },
      { status: 400 }
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Update the password via the user's session client (so Supabase
  // verifies it's a self-update).
  const { error: pwErr } = await supabase.auth.updateUser({ password: pw });
  if (pwErr) {
    return NextResponse.json({ error: pwErr.message }, { status: 400 });
  }

  // Clear the must_change_password flag with service-role.
  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  await svc
    .from("profiles")
    .update({ must_change_password: false })
    .eq("id", user.id);

  return NextResponse.json({ ok: true });
}
