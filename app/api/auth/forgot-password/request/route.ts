import { NextResponse } from "next/server";
import { prepareCredentialRequest } from "@/lib/auth/credential-mail";
import { runAfterResponse } from "@/lib/http/after-response";
import { originFromRequest } from "@/lib/http/origin";

/**
 *   POST /api/auth/forgot-password/request
 *   body: { email, orgSlug? }
 *
 * Asks for a 6-digit reset code (ADR 0029 sections C and D). The page names
 * its organisation (orgSlug, from /forgot-password?org=<slug>); with none,
 * or with a slug that names no organisation, it is the page with no
 * organisation, which serves platform owners and administrators only.
 *
 * The answer is the same for every address that passes the format check:
 * the same reads in the same order before it (lib/auth/credential-mail.ts),
 * and a status and body that depend on the organisation's reading only:
 *   - 200 { ok, ready, message } with section C's sentence for a ready or a
 *     not-ready organisation, or for the page with no organisation;
 *   - 503 { error: "account_lookup_unavailable" } when the account lookup
 *     failed, and 503 { error: "email_unavailable" } when the organisation
 *     or its settings could not be read.
 * Everything that depends on the account (rule 2, the limits, the code row,
 * the send and its records) runs after the response, through
 * runAfterResponse, and only for an address with an account. The code goes
 * only by email.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { email?: unknown; orgSlug?: unknown };
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "A valid email is required" }, { status: 400 });
  }
  const orgSlug = typeof body.orgSlug === "string" && body.orgSlug.trim() ? body.orgSlug.trim() : null;

  // Read from the request now: the job after the response has no request.
  const origin = (await originFromRequest()) || "";
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
  const userAgent = request.headers.get("user-agent") ?? null;

  const prepared = await prepareCredentialRequest({ kind: "reset_code", email, orgSlug, origin, next: null, ip, userAgent });
  if (prepared.job) runAfterResponse("reset-code", prepared.job);
  return NextResponse.json(prepared.body, { status: prepared.status });
}
