import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/xapi/auth";

/**
 *   POST /api/xapi/fetch?fetch_token=<uuid>
 *
 * cmi5 launch flow:
 *   1. LMS embeds a fetch_token in the launch URL.
 *   2. AU calls this endpoint once with that fetch_token.
 *   3. We return { "auth-token": "<bearer>" }.
 *   4. AU includes Authorization: Bearer <bearer> on every xAPI call.
 *
 * Fetch tokens are one-shot. Once used, subsequent calls return 404.
 */
export async function POST(request: Request) {
  const { searchParams } = new URL(request.url);
  const fetchToken = searchParams.get("fetch_token") ?? searchParams.get("fetch");
  if (!fetchToken) {
    return NextResponse.json({ error: "Missing fetch_token" }, { status: 400 });
  }

  const svc = serviceClient();
  const { data: row } = await svc
    .from("cmi5_launch_tokens")
    .select("auth_token, used_at, expires_at")
    .eq("fetch_token", fetchToken)
    .maybeSingle();

  if (!row) {
    return NextResponse.json({ error: "Unknown fetch token" }, { status: 404 });
  }
  if (row.used_at) {
    return NextResponse.json({ error: "Fetch token already used" }, { status: 409 });
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return NextResponse.json({ error: "Fetch token expired" }, { status: 410 });
  }

  await svc
    .from("cmi5_launch_tokens")
    .update({ used_at: new Date().toISOString() })
    .eq("fetch_token", fetchToken);

  // cmi5 spec: the response key is "auth-token" and the value already
  // includes the "Bearer " prefix. AUs use it verbatim as the header.
  return NextResponse.json({ "auth-token": `Bearer ${row.auth_token}` });
}
