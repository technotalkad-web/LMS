import { NextResponse } from "next/server";
import type { User } from "@supabase/supabase-js";
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
 *
 * The CRM sign-in rule: a link signs in exactly the member the request
 * named. It goes to that member's own login address as the auth server
 * holds it; an email in the request must be that same address; and the
 * link is handed back only when the auth server issued it to that member.
 * A member whose account signs in through an identity provider (single
 * sign-on) gets no link: that person signs in through the provider, and no
 * link is requested for their address.
 */

/** One answer for "no such member", whatever the reason. */
function noMember() {
  return NextResponse.json(
    { error: "No active LMS account for this employee — sync the user first" },
    { status: 404 }
  );
}

/**
 * True when the account signs in through an identity provider. The auth
 * server names such a provider "sso:<provider id>" on the account's
 * app_metadata (provider, providers) and on its identities; any one of them
 * is enough. Never throws on a missing or odd field.
 */
function signsInThroughIdentityProvider(user: User | null | undefined): boolean {
  if (!user) return false;
  const viaProvider = (p: unknown) => typeof p === "string" && p.startsWith("sso:");
  const meta = (user.app_metadata ?? {}) as { provider?: unknown; providers?: unknown };
  if (viaProvider(meta.provider)) return true;
  if (Array.isArray(meta.providers) && meta.providers.some(viaProvider)) return true;
  return (
    Array.isArray(user.identities) &&
    user.identities.some((i) => viaProvider((i as { provider?: unknown } | null)?.provider))
  );
}

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
  if (!member) return noMember();
  // Blocklist, not allowlist — legacy orgs store learners as 'member'.
  if (["super_owner", "owner", "admin"].includes(member.role)) {
    return NextResponse.json(
      { error: "Admin accounts cannot be signed in via the integration" },
      { status: 403 }
    );
  }

  // The CRM sign-in rule: the member's login address comes from the auth
  // server, by user id, never from the profile copy. If that read fails or
  // gives no address, no link is issued.
  let email = "";
  let account: User | null = null;
  let unreadable = "no_email";
  try {
    const { data: acct, error: acctErr } = await auth.svc.auth.admin.getUserById(member.userId);
    if (acctErr) unreadable = acctErr.code ?? `status_${acctErr.status ?? "unknown"}`;
    else {
      account = acct?.user ?? null;
      email = account?.email?.trim() ?? "";
    }
  } catch {
    unreadable = "thrown";
  }
  if (!email) {
    console.warn(JSON.stringify({ event: "sso_link_account_unreadable", code: unreadable }));
    return NextResponse.json({ error: "account_lookup_unavailable" }, { status: 503 });
  }
  // An account that signs in through an identity provider gets no link, and
  // no link is requested for its address: the same answer as no member.
  if (signsInThroughIdentityProvider(account)) {
    console.warn(JSON.stringify({ event: "sso_link_identity_provider_account" }));
    return noMember();
  }
  // Named by email (resolveMember matches on email only without an
  // employee_id): the address asked for must be that person's sign-in
  // address, compared without case. Otherwise the answer is the same as for
  // no member, and nothing is minted.
  if (!body.employee_id && body.email && body.email.trim().toLowerCase() !== email.toLowerCase()) {
    return noMember();
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
  // The auth server must report the same user id the request named. Any
  // other answer, a missing user id included, hands back no link.
  if (data?.user?.id !== member.userId) {
    console.warn(JSON.stringify({ event: "sso_link_user_mismatch" }));
    return NextResponse.json({ error: "Could not mint sign-in link" }, { status: 500 });
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
