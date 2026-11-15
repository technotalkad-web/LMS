import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { originFromRequest } from "@/lib/http/origin";
import { endImpersonationForSessionChange } from "@/lib/auth/impersonation";

export async function POST(request: Request) {
  // End an impersonation first, while the platform owner who started it is
  // still signed in (the row is stamped only for them). It never throws, so
  // sign-out always goes ahead.
  await endImpersonationForSessionChange();
  const supabase = await createClient();
  await supabase.auth.signOut();
  // Public origin from the live headers — behind a proxy request.url holds
  // the container's listening address (see app/auth/callback/route.ts).
  const origin = (await originFromRequest()) || new URL(request.url).origin;

  // Preserve tenant context: a learner signing out of /ambak/... should land
  // back on /ambak/login, not the global /login. The org slug is posted as a
  // hidden form field; sanitize it to a safe slug to avoid open redirects.
  let dest = "/login";
  const form = await request.formData().catch(() => null);
  const org = form?.get("org");
  if (typeof org === "string" && /^[a-z0-9-]+$/.test(org)) {
    dest = `/${org}/login`;
  }

  return NextResponse.redirect(`${origin}${dest}`, { status: 303 });
}
