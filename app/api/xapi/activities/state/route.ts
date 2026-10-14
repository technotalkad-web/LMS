import { NextResponse } from "next/server";
import { bindXapi, serviceClient } from "@/lib/xapi/auth";
import { attemptAbandonedResponse, isAttemptAbandonedError } from "@/lib/attempts/abandon";
import { updateProgressFromState } from "@/lib/courses/progress";

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
 * Auth: Bearer token from /api/xapi/fetch. An abandoned attempt answers 410
 * attempt_abandoned on every method (ALDS step 0, P4).
 */
export async function GET(request: Request) {
  const bound = await bindXapi(request);
  if (!bound.ok) return bound.response;
  const session = bound.session;

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
  const bound = await bindXapi(request);
  if (!bound.ok) return bound.response;
  const session = bound.session;

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

  // 0075: the resume blob is the most current picture of how far the
  // learner is — raise progress from it (never lowers, never completes).
  // P4: that write is conditional on status <> 'abandoned'; abandoned since
  // the bind → 410.
  try {
    await updateProgressFromState(svc, session.attemptId, content);
  } catch (e) {
    if (isAttemptAbandonedError(e)) return attemptAbandonedResponse();
    console.warn("[xapi/state] progress update failed:", e);
  }

  return new Response(null, { status: 204 });
}

// POST in xAPI semantics is "merge if existing", but for simplicity (and
// because most AUs use PUT) we treat POST as full replace too.
export async function POST(request: Request) {
  return PUT(request);
}

export async function DELETE(request: Request) {
  const bound = await bindXapi(request);
  if (!bound.ok) return bound.response;
  const session = bound.session;

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
