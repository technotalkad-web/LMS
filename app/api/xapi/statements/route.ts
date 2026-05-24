import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import {
  authenticateXapi,
  serviceClient,
  unauthorizedResponse,
} from "@/lib/xapi/auth";
import { processStatement } from "@/lib/xapi/process-statement";
import type { XapiStatement } from "@/lib/xapi/types";

/**
 *   POST /api/xapi/statements   (write one or more statements)
 *   GET  /api/xapi/statements   (read statements bound to this attempt)
 *   PUT  /api/xapi/statements?statementId=<uuid>  (write a single statement)
 *
 * Auth: Authorization: Bearer <auth_token from /api/xapi/fetch>
 */
export async function POST(request: Request) {
  const session = await authenticateXapi(request);
  if (!session) return unauthorizedResponse();

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

  for (const raw of statements) {
    const statement: XapiStatement = { ...raw };
    if (!statement.id) statement.id = randomUUID();
    if (!statement.timestamp) statement.timestamp = new Date().toISOString();

    if (!statement.verb?.id) {
      return NextResponse.json(
        { error: "Statement missing verb.id" },
        { status: 400 }
      );
    }

    await svc.from("xapi_statements").upsert(
      {
        attempt_id: session.attemptId,
        statement_id: statement.id,
        verb: statement.verb.id,
        raw: statement,
      },
      { onConflict: "attempt_id,statement_id" }
    );

    await processStatement({
      statement,
      attemptId: session.attemptId,
      supabase: svc,
    });

    ids.push(statement.id);
  }

  return NextResponse.json(ids, { status: 200 });
}

export async function PUT(request: Request) {
  // PUT with a single statement is allowed in xAPI 1.0.3 alongside POST.
  // Delegate to POST after wrapping the body if it's not an array.
  return POST(request);
}

export async function GET(request: Request) {
  const session = await authenticateXapi(request);
  if (!session) return unauthorizedResponse();

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
