import { NextResponse } from "next/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { readSetupLink, setPasswordWithSetupLink } from "@/lib/auth/setup-link";

/**
 *   POST /api/auth/set-password
 *   body: { token }             the page's read of a link: spends nothing
 *   body: { token, password }   the set step
 *
 * The LMS's own "set your password" link (ADR 0029, rule N9). Public, like
 * the other sign-in flows: the token is the authority, and every check is
 * made in lib/auth/setup-link.ts with the service role, in rule N14's order.
 *
 *   - A link that cannot be used (unknown, used, ended, expired, or refused
 *     under rule N11 or N14) gets rule N10's one answer: the same status and
 *     body whatever the reason, and nothing about any account.
 *   - A read that failed answers 503 and ends nothing.
 *   - The set step claims the link, then sets the password and the confirmed
 *     mark in one call. It creates no session: the answer names the
 *     organisation's sign-in page.
 *
 * The request body is never logged.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { token?: unknown; password?: unknown };
  const svc = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });
  const answer =
    body.password === undefined
      ? await readSetupLink(svc, body.token)
      : await setPasswordWithSetupLink(svc, body.token, body.password);
  return NextResponse.json(answer.body, { status: answer.status, headers: { "Cache-Control": "no-store" } });
}
