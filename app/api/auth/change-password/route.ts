import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { endImpersonationForSessionChange } from "@/lib/auth/impersonation";
import { checkPassword } from "@/lib/auth/password-policy";
import { endOpenSetupLinks } from "@/lib/auth/setup-link";

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
 *
 * The new password meets the one shared policy (lib/auth/password-policy.ts,
 * ADR 0029 safeguard S7). Once it is set, the account's open setup link is
 * ended (rule N9); that write never fails the change.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { new_password?: string };
  const pw = body.new_password?.trim() ?? "";
  const policy = checkPassword(pw);
  if (!policy.ok) {
    return NextResponse.json({ error: policy.error }, { status: 400 });
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

  // A changed password ends an impersonation this user started on this
  // browser; they can start a new one. Never throws.
  await endImpersonationForSessionChange();

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

  // The changed password ends the account's open setup link. Never throws;
  // a failure, a database without 0117 among them, is logged with its class.
  await endOpenSetupLinks(svc, user.id, "change-password");

  return NextResponse.json({ ok: true });
}
