import { NextResponse } from "next/server";

/**
 * Embedded-mode exit — the "Back to CRM" button. Clears the embed cookies
 * and sends the browser back to the CRM page it came from (validated https).
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const returnUrl = url.searchParams.get("to") ?? "";
  const safe =
    /^https:\/\//i.test(returnUrl) ||
    /^http:\/\/(127\.0\.0\.1|localhost)(:|\/)/i.test(returnUrl)
      ? returnUrl
      : url.origin;

  const res = NextResponse.redirect(safe);
  res.cookies.set("crm_embed", "", { path: "/", maxAge: 0 });
  res.cookies.set("crm_return", "", { path: "/", maxAge: 0 });
  return res;
}
