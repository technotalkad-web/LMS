import { NextResponse } from "next/server";
import { authenticateApiKey, resolveMember } from "@/lib/integrations/auth";
import { originFromRequest } from "@/lib/http/origin";

/**
 * SSO handoff — the heart of the "CRM is the front door" integration.
 *
 *   POST /api/integrations/sso-link
 *   Authorization: Bearer ambk_...
 *   body: {
 *     employee_id? | email?,     who to sign in (active member of the key's org)
 *     target?,                   in-app path to land on, e.g. "/{org}/courses/<id>/launch"
 *     return_url?,               https URL of the CRM page to return to (arms
 *                                embedded mode: LMS chrome hidden, "Back" button)
 *   }
 *   → { login_url, expires_in }
 *
 * The CRM backend calls this server-to-server, then redirects the employee's
 * browser to login_url: one-time token → signed in → lands on target. No
 * password, no second login screen, nothing to remember.
 *
 * Security: LEARNER accounts only — admin/owner accounts can never be signed
 * in through the integration (a CRM compromise must not yield admin access).
 * Targets are confined to the key's own org paths. Links are single-use and
 * short-lived (Supabase OTP expiry).
 */
export async function POST(request: Request) {
  const auth = await authenticateApiKey(request);
  if (!auth) {
    return NextResponse.json({ error: "Invalid or revoked API key" }, { status: 401 });
  }
  const body = (await request.json().catch(() => ({}))) as {
    employee_id?: string;
    email?: string;
    target?: string;
    return_url?: string;
  };
  if (!body.employee_id && !body.email) {
    return NextResponse.json(
      { error: "employee_id or email required" },
      { status: 400 }
    );
  }

  const member = await resolveMember(auth.svc, auth.orgId, body);
  if (!member) {
    return NextResponse.json(
      { error: "No active LMS account for this employee — sync the user first" },
      { status: 404 }
    );
  }
  // Blocklist, not allowlist — legacy orgs store learners as 'member'.
  if (["super_owner", "owner", "admin"].includes(member.role)) {
    return NextResponse.json(
      { error: "Admin accounts cannot be signed in via the integration" },
      { status: 403 }
    );
  }

  // Email for the magic link.
  const { data: prof } = await auth.svc
    .from("profiles")
    .select("email")
    .eq("id", member.userId)
    .maybeSingle();
  const email = (prof as { email?: string | null } | null)?.email;
  if (!email) {
    return NextResponse.json({ error: "Member has no email on file" }, { status: 404 });
  }

  // Target: same-org in-app path only (no open redirects).
  const defaultTarget = `/${auth.orgSlug}/dashboard`;
  let target = defaultTarget;
  if (body.target) {
    const t = body.target.trim();
    if (t.startsWith(`/${auth.orgSlug}/`) && !t.startsWith("//")) target = t;
    else {
      return NextResponse.json(
        { error: `target must be a path within /${auth.orgSlug}/` },
        { status: 400 }
      );
    }
  }

  // Embedded mode: route through /api/integrations/enter, which sets the
  // embed cookies (hide LMS chrome, arm "Back to CRM") and then forwards.
  const returnUrl = (body.return_url ?? "").trim();
  if (returnUrl) {
    if (!/^https:\/\//i.test(returnUrl) && !/^http:\/\/(127\.0\.0\.1|localhost)(:|\/)/i.test(returnUrl)) {
      return NextResponse.json(
        { error: "return_url must be https" },
        { status: 400 }
      );
    }
    target = `/api/integrations/enter?to=${encodeURIComponent(target)}&return_url=${encodeURIComponent(returnUrl)}`;
  }

  const { data, error } = await auth.svc.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  const tokenHash = (data?.properties as { hashed_token?: string } | undefined)
    ?.hashed_token;
  if (error || !tokenHash) {
    return NextResponse.json(
      { error: error?.message ?? "Could not mint sign-in link" },
      { status: 500 }
    );
  }

  const origin = ((await originFromRequest()) || "").replace(/\/$/, "");
  const loginUrl =
    `${origin}/auth/callback?token_hash=${encodeURIComponent(tokenHash)}` +
    `&type=magiclink&next=${encodeURIComponent(target)}`;

  return NextResponse.json({
    login_url: loginUrl,
    // Supabase OTP default expiry — treat the link as redeem-immediately.
    expires_in: 3600,
    employee_id: member.employeeId,
  });
}
