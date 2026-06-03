import { AuthCallbackFragment } from "./AuthCallbackFragment";

/**
 * Magic-link finish page.
 *
 * Why this page exists separately from /auth/callback:
 *
 * Supabase Auth returns both successful tokens AND error info in the
 * URL fragment (`#access_token=...` or `#error=...`). Fragments are
 * browser-only — never sent to the server — so /auth/callback (which
 * is a server route handler) cannot see them. When /auth/callback
 * receives a request with no query params (because all the data is
 * in the fragment), it redirects here instead of bouncing the user
 * to /login with a cryptic ?error=missing_code.
 *
 * The fragment survives the redirect — browsers preserve `#...` when
 * the server replies with a 302 Location header that has no fragment
 * of its own. So when this page renders, window.location.hash still
 * holds whatever Supabase put there.
 *
 * AuthCallbackFragment (client component) parses the hash:
 *   - Success → calls supabase.auth.setSession() → redirects to /select-org
 *   - Error   → renders a friendly "your link expired" page with a
 *               "Request a new sign-in link" button
 *
 * This page is opt-out of any caching. Each visit must re-evaluate
 * the hash on a fresh server-rendered shell.
 */

export const dynamic = "force-dynamic";

export default function AuthFinishPage() {
  return <AuthCallbackFragment />;
}
