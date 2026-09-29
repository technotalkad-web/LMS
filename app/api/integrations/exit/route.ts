import { NextResponse } from "next/server";
import { originFromRequest } from "@/lib/http/origin";

/**
 * Embedded-mode exit — the "Back to CRM" button. Clears the embed cookies
 * and sends the browser back to the CRM page it came from (validated https).
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  // Public origin from the live Host / x-forwarded-proto headers: behind a
  // proxy (Cloud Run) request.url is the listening address (https://0.0.0.0:8080).
  const origin = (await originFromRequest()) || url.origin;
  const returnUrl = url.searchParams.get("to") ?? "";
  const safe =
    /^https:\/\//i.test(returnUrl) ||
    /^http:\/\/(127\.0\.0\.1|localhost)(:|\/)/i.test(returnUrl)
      ? returnUrl
      : origin;

  const res = NextResponse.redirect(safe);
  res.cookies.set("crm_embed", "", { path: "/", maxAge: 0 });
  res.cookies.set("crm_return", "", { path: "/", maxAge: 0 });
  return res;
}
