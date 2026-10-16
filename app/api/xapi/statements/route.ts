import { NextResponse } from "next/server";
import { bindXapi, serviceClient } from "@/lib/xapi/auth";
import { deterministicStatementId } from "@/lib/lrs/statement-id";
import { isSameStatementAsReceived } from "@/lib/xapi/statement-equality";
import { attemptAbandonedResponse, isAttemptAbandonedError } from "@/lib/attempts/abandon";
import { processStatement } from "@/lib/xapi/process-statement";
import { mirrorToExternalLrs } from "@/lib/lrs/enqueue";
import { classifyAttempt } from "@/lib/scoring/attempt-kind";
import { fireCompletionWebhookForAttempt } from "@/lib/integrations/webhook";
import type { XapiStatement } from "@/lib/xapi/types";

/**
 *   POST /api/xapi/statements   (write one or more statements)
 *   GET  /api/xapi/statements   (read statements bound to this attempt)
 *   PUT  /api/xapi/statements?statementId=<uuid>  (write a single statement)
 *
 * Auth: Authorization: Bearer <auth_token from /api/xapi/fetch>
 */
export async function POST(request: Request) {
  // P4: an abandoned attempt (or its expired token) → 410 before any write.
  const bound = await bindXapi(request);
  if (!bound.ok) return bound.response;
  const session = bound.session;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const statements: XapiStatement[] = Array.isArray(body)
    ? (body as XapiStatement[])
    : [body as XapiStatement];

  const svc = serviceClient();
  const ids: string[] = [];

  // 0081: remember whether the attempt was already complete, so a completion
  // in this batch is reported exactly once (webhook) and only for OFFICIAL
  // attempts (journey day, XP). Fail-soft: errors here never block statements.
  const attemptStatus = async () => {
    const { data } = await svc
      .from("course_attempts")
      .select("completion_status, success_status")
      .eq("id", session.attemptId)
      .maybeSingle();
    const a = data as { completion_status?: string | null; success_status?: string | null } | null;
    return a?.completion_status === "completed" || a?.success_status === "passed";
  };
  const wasComplete = await attemptStatus().catch(() => false);

  // What reaches the tenant LRS mirror: the statements as stored. A resent id
  // with different content is left out (ADR 0003 step 5).
  const mirror: XapiStatement[] = [];

  for (const received of statements) {
    // The deterministic id below is derived from verb.id, so the 400 comes first.
    if (!received || typeof received !== "object" || !received.verb?.id) {
      return NextResponse.json(
        { error: "Statement missing verb.id" },
        { status: 400 }
      );
    }
    const statement: XapiStatement = { ...received };
    // ADR 0003 step 6: an id-less statement gets a deterministic id, computed
    // from the statement AS SENT (before a missing timestamp is filled), so
    // the engine's re-POST of the same queued object collapses to one row.
    if (!statement.id) statement.id = deterministicStatementId(session.attemptId, received);
    if (!statement.timestamp) statement.timestamp = new Date().toISOString();
    const statementId = statement.id;

    // ADR 0003 step 5: statements are write-once (ON CONFLICT DO NOTHING).
    // A resent id never changes the stored raw.
    const { data: inserted, error: insertErr } = await svc
      .from("xapi_statements")
      .upsert(
        {
          attempt_id: session.attemptId,
          statement_id: statementId,
          verb: statement.verb.id,
          raw: statement,
        },
        { onConflict: "attempt_id,statement_id", ignoreDuplicates: true }
      )
      .select("statement_id");

    let toProcess: XapiStatement | null = statement;
    if (insertErr) {
      // Unchanged from before write-once: a storage error never blocks the
      // learner's progress from being derived.
      console.warn("[xapi/statements] statement insert failed:", insertErr.message);
    } else if (!inserted || inserted.length === 0) {
      // The id already exists on this attempt. An exact retry re-runs the
      // (idempotent) derivation on the stored copy; different content under
      // the same id is ignored and logged.
      const { data: storedRow } = await svc
        .from("xapi_statements")
        .select("raw")
        .eq("attempt_id", session.attemptId)
        .eq("statement_id", statementId)
        .maybeSingle();
      const storedRaw = (storedRow as { raw?: unknown } | null)?.raw;
      if (storedRaw && isSameStatementAsReceived(storedRaw, received)) {
        toProcess = storedRaw as XapiStatement;
      } else {
        toProcess = null;
        console.warn(
          JSON.stringify({
            event: "statement_conflict",
            attempt_id: session.attemptId,
            statement_id: statementId,
          })
        );
      }
    }

    if (toProcess) {
      // The attempt update inside is conditional on status <> 'abandoned';
      // abandoned since the bind (another tab switched language) → 410.
      try {
        await processStatement({
          statement: toProcess,
          attemptId: session.attemptId,
          supabase: svc,
        });
      } catch (e) {
        if (isAttemptAbandonedError(e)) return attemptAbandonedResponse();
        throw e;
      }
      mirror.push(toProcess);
    }

    ids.push(statementId);
  }

  // 0081 revision rule: once complete, only an OFFICIAL attempt (inside the
  // scoring window) moves journey days, XP and the CRM webhook; a revision
  // run changes nothing but its own row.
  const nowComplete = await attemptStatus().catch(() => false);
  let kind: Awaited<ReturnType<typeof classifyAttempt>> = null;
  if (nowComplete) {
    try {
      kind = await classifyAttempt(svc, session.attemptId);
    } catch (e) {
      console.warn("[xapi/statements] attempt classification failed (treated as official):", e);
    }
  }
  const officialRun = !nowComplete || !kind || kind.official;

  // Gamification engine: one fail-isolated RPC per request (idempotent —
  // dedupe keys make replays award-neutral). cmi5 parity with the SCORM
  // commit hook; a failure here never affects the learner's statements.
  if (officialRun) {
    try {
      await svc.rpc("gamification_record_activity", {
        p_attempt_id: session.attemptId,
      });
      // Yoddha journey (0058): credits the tagged day; no-ops otherwise.
      await svc.rpc("journey_record_completion", {
        p_attempt_id: session.attemptId,
      });
    } catch (e) {
      console.warn("[xapi/statements] gamification failed:", e);
    }
  }
  // CRM completion webhook: first transition to complete, official attempts only
  // (cmi5 / xAPI parity with the SCORM commit path).
  if (nowComplete && !wasComplete && officialRun) {
    await fireCompletionWebhookForAttempt(session.attemptId, kind?.attemptNumber ?? null);
  }

  // Fan-out: mirror these statements to the org's external LRS if configured.
  // Fail-isolated + non-blocking — never affects this response or our own copy.
  await mirrorToExternalLrs(session.attemptId, mirror);

  return NextResponse.json(ids, { status: 200 });
}

export async function PUT(request: Request) {
  // PUT with a single statement is allowed in xAPI 1.0.3 alongside POST.
  // Delegate to POST after wrapping the body if it's not an array.
  return POST(request);
}

export async function GET(request: Request) {
  const bound = await bindXapi(request);
  if (!bound.ok) return bound.response;
  const session = bound.session;

  const { searchParams } = new URL(request.url);
  const verb = searchParams.get("verb");
  const limit = Math.min(
    parseInt(searchParams.get("limit") || "100", 10) || 100,
    1000
  );

  const svc = serviceClient();
  let q = svc
    .from("xapi_statements")
    .select("raw, stored")
    .eq("attempt_id", session.attemptId)
    .order("stored", { ascending: false })
    .limit(limit);
  if (verb) q = q.eq("verb", verb);

  const { data } = await q;
  const xapiStatementResult = {
    statements: (data ?? []).map((r) => r.raw),
    more: "",
  };
  return NextResponse.json(xapiStatementResult);
}
