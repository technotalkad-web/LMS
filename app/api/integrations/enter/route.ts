import { NextResponse } from "next/server";
import { originFromRequest } from "@/lib/http/origin";

/**
 * Embedded-mode entry (0071). The sso-link target routes through here when
 * the CRM supplied a return_url: sets the embed cookies (learner layout
 * hides LMS chrome and shows "Back to CRM"), then forwards to the real
 * in-app destination. Cookies are session-scoped, path=/ so the whole
 * learner surface stays in embedded mode until /api/integrations/exit.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  // Public origin from the live Host / x-forwarded-proto headers: behind a
  // proxy (Cloud Run) request.url is the listening address (https://0.0.0.0:8080).
  const origin = (await originFromRequest()) || url.origin;
  const to = url.searchParams.get("to") ?? "/";
  const returnUrl = url.searchParams.get("return_url") ?? "";

  const safeTo = to.startsWith("/") && !to.startsWith("//") ? to : "/";
  const safeReturn =
    /^https:\/\//i.test(returnUrl) ||
    /^http:\/\/(127\.0\.0\.1|localhost)(:|\/)/i.test(returnUrl)
      ? returnUrl
      : "";

  const res = NextResponse.redirect(new URL(safeTo, origin));
  const opts = {
    path: "/",
    httpOnly: true,
    sameSite: "lax" as const,
    secure: origin.startsWith("https:"),
  };
  res.cookies.set("crm_embed", "1", opts);
  if (safeReturn) res.cookies.set("crm_return", safeReturn, opts);
  return res;
}
