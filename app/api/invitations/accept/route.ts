import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";

/**
 *   POST /api/invitations/accept
 *   body: { token: "<uuid>", password: "..." }
 *
 * Accept flow:
 *   1. Validate the token exists, isn't accepted, isn't expired.
 *   2. If an auth.users row already exists for the invitation's email, just
 *      sign the user in with the given password and write the membership.
 *   3. Otherwise create the auth user with that password (email pre-confirmed
 *      since the admin vouched for the address by inviting them), sign in,
 *      and write the membership.
 *   4. Mark invitation accepted.
 *
 * Sign-in happens via signInWithPassword on the cookie-bound supabase
 * client, so the response sets the auth cookies and the next page load
 * sees the new session.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    token?: string;
    password?: string;
  };
  const token = body.token?.trim();
  const password = body.password ?? "";

  if (!token || !password) {
    return NextResponse.json(
      { error: "token and password are required" },
      { status: 400 }
    );
  }
  if (password.length < 6) {
    return NextResponse.json(
      { error: "Password must be at least 6 characters" },
      { status: 400 }
    );
  }

  const svc = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  // 1) Validate token.
  const { data: invitation } = await svc
    .from("invitations")
    .select("id, organization_id, email, role, accepted_at, expires_at")
    .eq("token", token)
    .maybeSingle();

  if (!invitation) {
    return NextResponse.json({ error: "Invalid invitation" }, { status: 404 });
  }
  if (invitation.accepted_at) {
    return NextResponse.json(
      { error: "Invitation already accepted" },
      { status: 409 }
    );
  }
  if (new Date(invitation.expires_at).getTime() < Date.now()) {
    return NextResponse.json({ error: "Invitation expired" }, { status: 410 });
  }

  const email = invitation.email.toLowerCase();

  // 2) Look up or create the auth user.
  let userId: string | null = null;
  // The shortcut view we used to query is gone in newer Supabase; skip
  // straight to the admin API. (Old chained .then/.catch removed because
  // PostgrestThenable no longer exposes .catch in @supabase/supabase-js
  // 2.105+.)
  const existing: { data: null } = { data: null };
  void existing;
  // Use admin API instead.
  const { data: existingList } = await svc.auth.admin.listUsers({
    page: 1,
    perPage: 200,
  });
  const found = existingList?.users?.find(
    (u) => u.email?.toLowerCase() === email
  );

  if (found) {
    userId = found.id;
    // Existing user: optionally update password and confirm email. We don't
    // overwrite an existing password without consent - just confirm the
    // email and let them use their existing credentials. If their existing
    // password matches what they submitted, sign-in below succeeds.
    if (!found.email_confirmed_at) {
      await svc.auth.admin.updateUserById(found.id, {
        email_confirm: true,
      });
    }
  } else {
    const { data: created, error: createError } = await svc.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (createError || !created?.user) {
      return NextResponse.json(
        { error: createError?.message ?? "Failed to create user" },
        { status: 400 }
      );
    }
    userId = created.user.id;
  }
  if (!userId) {
    return NextResponse.json({ error: "Failed to resolve user" }, { status: 500 });
  }

  // 3) Write membership (idempotent).
  await svc
    .from("organization_members")
    .upsert(
      {
        organization_id: invitation.organization_id,
        user_id: userId,
        role: invitation.role,
      },
      { onConflict: "organization_id,user_id" }
    );

  // 4) Mark invitation accepted.
  await svc
    .from("invitations")
    .update({
      accepted_at: new Date().toISOString(),
      accepted_by: userId,
    })
    .eq("id", invitation.id);

  // 5) Sign the user in (cookie-bound) so the next page sees the session.
  const supabase = await createClient();
  const { error: signInError } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  if (signInError) {
    // The membership is still created, but the password didn't match an
    // existing user. Tell them to sign in manually.
    return NextResponse.json({
      ok: true,
      organizationId: invitation.organization_id,
      needsManualSignIn: true,
      message:
        "Invitation accepted, but the password didn't match your existing account. Sign in manually.",
    });
  }

  return NextResponse.json({
    ok: true,
    organizationId: invitation.organization_id,
  });
}
