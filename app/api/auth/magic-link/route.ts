import { NextResponse } from "next/server";
import { originFromRequest } from "@/lib/http/origin";
import { safeNextPath } from "@/lib/auth/safe-next";
import { prepareCredentialRequest } from "@/lib/auth/credential-mail";
import { runAfterResponse } from "@/lib/http/after-response";

/**
 *   POST /api/auth/magic-link   body: { email, orgSlug?, next? }
 *
 * Asks for an emailed sign-in link (ADR 0029 sections C and D), the same
 * shape as the reset-code request: the page's organisation from orgSlug;
 * with none, or a slug that names no organisation, the page with no
 * organisation, which serves platform owners and administrators only.
 *
 * The answer is the same for every address that passes the format check
 * (lib/auth/credential-mail.ts): the same reads in the same order before
 * it, and 200 { ok, ready, message } by the organisation's reading, or 503
 * for every address when the account lookup, the organisation or its
 * settings could not be read. The link is minted and mailed after the
 * response, only for an address with an account, through the system rule 2
 * of section A gives it: the organisation's own SMTP or the platform sender.
 *
 * `next` (optional) is a same-app path to land on after sign-in, used by
 * deep links (a QR-code scan of a course) so the emailed link returns the
 * learner to the page they scanned. It keeps its query (a launch's Preview
 * mode, path, journey day and language) and goes through
 * lib/auth/safe-next.ts's open-redirect guard: one leading "/", no scheme
 * or host, no backslash or control character.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { email?: unknown; orgSlug?: unknown; next?: unknown };
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "A valid email is required" }, { status: 400 });
  }
  const orgSlug = typeof body.orgSlug === "string" && body.orgSlug.trim() ? body.orgSlug.trim() : null;
  const safeNext = safeNextPath(typeof body.next === "string" ? body.next : null);

  // Read from the request now: the job after the response has no request.
  const origin = (await originFromRequest()) || "";

  const prepared = await prepareCredentialRequest({ kind: "sign_in_link", email, orgSlug, origin, next: safeNext, ip: null, userAgent: null });
  if (prepared.job) runAfterResponse("sign-in-link", prepared.job);
  return NextResponse.json(prepared.body, { status: prepared.status });
}
