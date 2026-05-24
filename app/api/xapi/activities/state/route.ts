import { NextResponse } from "next/server";
import {
  authenticateXapi,
  serviceClient,
  unauthorizedResponse,
} from "@/lib/xapi/auth";

/**
 *   GET    /api/xapi/activities/state?stateId=...&activityId=...&agent=...
 *   PUT    /api/xapi/activities/state?stateId=...
 *   POST   /api/xapi/activities/state?stateId=...
 *   DELETE /api/xapi/activities/state?stateId=...
 *
 * State documents are AU-private storage scoped to (attempt, stateId).
 * cmi5 AUs use this for resume data; activity/agent params are required
 * by the xAPI spec but for our purposes (single attempt = single session)
 * stateId alone is the meaningful key.
 *
 * Auth: Bearer token from /api/xapi/fetch.
 */
export async function GET(request: Request) {
  const session = await authenticateXapi(request);
  if (!session) return unauthorizedResponse();

  const { searchParams } = new URL(request.url);
  const stateId = searchParams.get("stateId");
  if (!stateId) {
    return NextResponse.json({ error: "Missing stateId" }, { status: 400 });
  }

  const svc = serviceClient();
  const { data } = await svc
    .from("xapi_state")
    .select("content, content_type")
    .eq("attempt_id", session.attemptId)
    .eq("state_id", stateId)
    .maybeSingle();

  if (!data) return new Response("Not Found", { status: 404 });

  const contentType = data.content_type || "application/json";
  const body =
    typeof data.content === "string"
      ? data.content
      : JSON.stringify(data.content);
  return new Response(body, {
    status: 200,
    headers: { "content-type": contentType },
  });
}

export async function PUT(request: Request) {
  const session = await authenticateXapi(request);
  if (!session) return unauthorizedResponse();

  const { searchParams } = new URL(request.url);
  const stateId = searchParams.get("stateId");
  if (!stateId) {
    return NextResponse.json({ error: "Missing stateId" }, { status: 400 });
  }

  const contentType = request.headers.get("content-type") ?? "application/json";
  const rawBody = await request.text();
  let content: unknown = rawBody;
  if (contentType.includes("application/json")) {
    try {
      content = JSON.parse(rawBody);
    } catch {
      // Keep as string if it doesn't parse.
    }
  }

  const svc = serviceClient();
  await svc.from("xapi_state").upsert(
    {
      attempt_id: session.attemptId,
      state_id: stateId,
      content,
      content_type: contentType,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "attempt_id,state_id" }
  );

  return new Response(null, { status: 204 });
}

// POST in xAPI semantics is "merge if existing", but for simplicity (and
// because most AUs use PUT) we treat POST as full replace too.
export async function POST(request: Request) {
  return PUT(request);
}

export async function DELETE(request: Request) {
  const session = await authenticateXapi(request);
  if (!session) return unauthorizedResponse();

  const { searchParams } = new URL(request.url);
  const stateId = searchParams.get("stateId");
  if (!stateId) {
    return NextResponse.json({ error: "Missing stateId" }, { status: 400 });
  }

  const svc = serviceClient();
  await svc
    .from("xapi_state")
    .delete()
    .eq("attempt_id", session.attemptId)
    .eq("state_id", stateId);

  return new Response(null, { status: 204 });
}
