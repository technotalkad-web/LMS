import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { EmailOtpType } from "@supabase/supabase-js";

/**
 * Handles the redirect from a Supabase email link.
 *
 * Magic links can arrive in two shapes depending on the auth flow Supabase
 * picks:
 *   - PKCE flow (preferred):  ?code=xxx
 *   - Email OTP flow:         ?token_hash=xxx&type=magiclink
 *
 * We try whichever is present, then forward to /select-org (or ?next=).
 */

/**
 * Tenant magic links carry next=/{org}/dashboard. Derive the org slug so error
 * paths can return the learner to their branded /{org}/login instead of the
 * global /login.
 */
function orgFromNext(next: string): string | null {
  const m = /^\/([a-z0-9-]+)\//.exec(next);
  return m ? m[1] : null;
}

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const next = searchParams.get("next") ?? "/select-org";
  const org = orgFromNext(next);
  const loginPath = org ? `/${org}/login` : "/login";

  const supabase = await createClient();

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(`${origin}${next}`);
    console.error("[auth/callback] exchangeCodeForSession failed:", error.message);
    return NextResponse.redirect(`${origin}${loginPath}?error=exchange&msg=${encodeURIComponent(error.message)}`);
  }

  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) return NextResponse.redirect(`${origin}${next}`);
    console.error("[auth/callback] verifyOtp failed:", error.message);
    return NextResponse.redirect(`${origin}${loginPath}?error=verify&msg=${encodeURIComponent(error.message)}`);
  }

  // No query params from Supabase usually means the auth payload
  // (success tokens or error info) is in the URL fragment, which we
  // can't read server-side. Hand off to /auth/finish, a client
  // component that reads window.location.hash and either completes
  // setSession() or renders a friendly error UI. The fragment is
  // preserved across this 302 by the browser. We forward `next` so the
  // error UI can route back to the correct tenant login.
  console.warn("[auth/callback] no code or token_hash — handing off to /auth/finish for fragment parsing:", request.url);
  return NextResponse.redirect(`${origin}/auth/finish?next=${encodeURIComponent(next)}`);
}
