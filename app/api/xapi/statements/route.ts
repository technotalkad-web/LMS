import { NextResponse } from "next/server";
import { bindXapi, serviceClient } from "@/lib/xapi/auth";
import { deterministicStatementId } from "@/lib/lrs/statement-id";
import { decideResend } from "@/lib/xapi/statement-equality";
import { attemptAbandonedResponse, isAttemptAbandonedError } from "@/lib/attempts/abandon";
import { processStatement } from "@/lib/xapi/process-statement";
import { mirrorToExternalLrs } from "@/lib/lrs/enqueue";
import { classifyAttempt } from "@/lib/scoring/attempt-kind";
import { isCompletedAttempt } from "@/lib/scoring/policy";
import { fireCompletionWebhookForAttempt } from "@/lib/integrations/webhook";
import { decideCompletionWebhook, normalizeSuccess } from "@/lib/integrations/webhook-hold";
import { VERBS, type XapiStatement } from "@/lib/xapi/types";
import { isUuid, registrationVerdict } from "@/lib/xapi/registration";
import { LMS_OFFICIAL_RESULT_STATE_ID } from "@/lib/alds/rpc";
import { buildOfficialResult } from "@/lib/attempts/revision-seed";

/**
 *   POST /api/xapi/statements   (write one or more statements)
 *   GET  /api/xapi/statements   (read statements bound to this attempt)
 *   PUT  /api/xapi/statements?statementId=<uuid>  (write a single statement)
 *
 * Auth: Authorization: Bearer <auth_token from /api/xapi/fetch>
 *
 * ADR 0014 (steps 4 and 5): the bound attempt row is read once, error-checked,
 * before any insert (503 attempt_unreadable on an error or no row, so the
 * AU's queue retries). Then, per statement, before the upsert:
 *   R-3  a `context.registration` naming ANOTHER attempt of the same learner
 *        on the same course is answered with its id and not stored,
 *        processed or mirrored (log `registration_changed`, ids only); the
 *        learner's attempt ids are read before any insert, and a failed read
 *        answers 503 (registration_unreadable) like the bound-row read;
 *   R-5  on a revision visit's row (is_revision) only `initialized` and
 *        `terminated` are stored; every other statement is answered with its
 *        id and not stored (log `revision_ignored`). Nothing on such a row
 *        moves XP, the streak, a journey day or the webhook (`officialRun`).
 *
 * ADR 0015 step 3: an AU completion without a result is held (log `webhook_held`)
 * until its pass/fail, a `terminated` or the cron sweep releases it; an attempt that
 * becomes passed after a not-passed message re-fires once (log `webhook_refired`). Ids only.
 *
 * ADR 0017 step 19: when a request changes an official attempt's success_status or
 * score, LMS.OfficialResult is upserted for its own registration, last and fail-soft
 * (log `official_result_write_failed`). A result the guard held changes neither.
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

  // ADR 0014 step 4: the bound row, read once and error-checked BEFORE any
  // insert. `isRevision` comes from the row, never from the token. A read
  // error or no row → 503, so a revision visit's `answered` can never be
  // stored because the flag was unreadable. select("*"): a key absent from
  // the row means the column is absent (ADR 0015 step 3 reads its `before`
  // from this same row).
  const { data: boundRow, error: boundErr } = await svc
    .from("course_attempts")
    .select("*")
    .eq("id", session.attemptId)
    .maybeSingle();
  if (boundErr || !boundRow) {
    if (boundErr) console.warn("[xapi/statements] attempt read failed:", boundErr.message);
    return NextResponse.json({ error: "attempt_unreadable" }, { status: 503 });
  }
  const row = boundRow as {
    user_id: string;
    course_version_id: string;
    completion_status?: string | null;
    success_status?: string | null;
    score?: number | null;
    completion_webhook_at?: string | null;
    is_revision?: boolean | null;
  };
  // ADR 0015 step 3: the row before the batch, for the webhook decision below.
  // `webhookAt` is null on a 0082 database when not latched and undefined when
  // the column is absent (the key is missing from a select("*") row), the
  // distinction the decision's `terminated` branch relies on.
  const before = {
    complete: isCompletedAttempt(row),
    successStatus: normalizeSuccess(row.success_status),
    webhookAt: row.completion_webhook_at,
    score: row.score ?? null,
  };
  const isRevision = row.is_revision === true;

  // After the batch: fail-soft, as before (errors here never block statements).
  const afterStatus = async () => {
    const { data } = await svc
      .from("course_attempts")
      .select("completion_status, success_status, score, completed_at, course_version_id")
      .eq("id", session.attemptId)
      .maybeSingle();
    const a = data as {
      completion_status?: string | null;
      success_status?: string | null;
      score?: number | null;
      completed_at?: string | null;
      course_version_id?: string | null;
    } | null;
    return {
      complete: a?.completion_status === "completed" || a?.success_status === "passed",
      successStatus: normalizeSuccess(a?.success_status),
      row: a,
    };
  };

  // R-3 (ADR 0014 step 5): the learner's attempt ids on the bound attempt's
  // course, read once per request and BEFORE any insert, only when a
  // statement of the batch names a UUID registration other than the bound
  // attempt. A failed read answers 503, like the bound-row read, so the AU's
  // queue retries: without the set a sibling cannot be told from an unknown
  // registration, and storing the statement would be the write R-3 exists to
  // stop. Logged with ids only.
  const foreignRegistration = (s: unknown): string | null => {
    const registration = (s as { context?: { registration?: unknown } } | null | undefined)?.context?.registration;
    return isUuid(registration) && registration.toLowerCase() !== session.attemptId.toLowerCase() ? registration : null;
  };
  let siblingIds: ReadonlySet<string> = new Set<string>();
  if (statements.some((s) => foreignRegistration(s) !== null)) {
    const out = new Set<string>();
    try {
      const { data: ver, error: verErr } = await svc
        .from("course_versions")
        .select("course_id")
        .eq("id", row.course_version_id)
        .maybeSingle();
      const courseId = (ver as { course_id?: string } | null)?.course_id;
      if (verErr || !courseId) throw new Error(verErr?.message ?? "no course");
      const { data: vers, error: versErr } = await svc.from("course_versions").select("id").eq("course_id", courseId);
      if (versErr || !vers) throw new Error(versErr?.message ?? "no versions");
      const verIds = (vers as Array<{ id: string }>).map((v) => v.id);
      if (verIds.length > 0) {
        const { data: atts, error: attErr } = await svc
          .from("course_attempts")
          .select("id")
          .eq("user_id", row.user_id)
          .in("course_version_id", verIds);
        if (attErr || !atts) throw new Error(attErr?.message ?? "no attempts");
        for (const a of atts as Array<{ id: string }>) out.add(a.id);
      }
    } catch (e) {
      console.warn(
        JSON.stringify({
          event: "registration_check_failed",
          attempt_id: session.attemptId,
          reason: e instanceof Error ? e.message : String(e),
        })
      );
      return NextResponse.json({ error: "registration_unreadable" }, { status: 503 });
    }
    siblingIds = out;
  }

  // What reaches the tenant LRS mirror: the statements as stored. A resent id
  // with different content is left out (ADR 0003 step 5).
  const mirror: XapiStatement[] = [];

  // ADR 0015 step 3: two flags over the statements this batch processed. One
  // dropped by R-3 or R-5, or ignored as a conflicting resend, sets neither.
  let terminated = false;
  let completingStatementCarriedSuccess = false;

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

    // (a) R-3, first: a registration naming a sibling attempt is answered
    // and dropped, whether or not that attempt already stores the id.
    const registration = foreignRegistration(statement);
    if (registration !== null) {
      const verdict = registrationVerdict({
        registration,
        attemptId: session.attemptId,
        siblingAttemptIds: siblingIds,
      });
      if (verdict === "sibling") {
        ids.push(statementId);
        console.warn(
          JSON.stringify({
            event: "registration_changed",
            attempt_id: session.attemptId,
            statement_id: statementId,
            named_attempt_id: registration,
          })
        );
        continue;
      }
    }
    // (b) R-5: a revision visit's row stores the session bookends only.
    if (isRevision && statement.verb.id !== VERBS.initialized && statement.verb.id !== VERBS.terminated) {
      ids.push(statementId);
      console.warn(
        JSON.stringify({
          event: "revision_ignored",
          attempt_id: session.attemptId,
          statement_id: statementId,
          verb: statement.verb.id,
        })
      );
      continue;
    }

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
      // the same id is ignored and logged. A stored copy that cannot be read
      // is not a difference: the statement is processed as received, like
      // the insert-error branch above (decideResend).
      const { data: storedRow, error: readErr } = await svc
        .from("xapi_statements")
        .select("raw")
        .eq("attempt_id", session.attemptId)
        .eq("statement_id", statementId)
        .maybeSingle();
      const storedRaw = (storedRow as { raw?: unknown } | null)?.raw;
      const decision = decideResend({ raw: storedRaw, error: readErr }, received);
      if (decision === "process-stored") {
        toProcess = storedRaw as XapiStatement;
      } else if (decision === "process-received") {
        console.warn("[xapi/statements] stored statement unreadable; processed as received:", readErr?.message ?? "no row");
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
      const verbId = toProcess.verb?.id;
      if (verbId === VERBS.terminated) terminated = true;
      if (
        (verbId === VERBS.completed || verbId === VERBS.passed || verbId === VERBS.failed) &&
        typeof toProcess.result?.success === "boolean"
      ) {
        completingStatementCarriedSuccess = true;
      }
    }

    ids.push(statementId);
  }

  // 0081 revision rule: once complete, only an OFFICIAL attempt (inside the
  // scoring window) moves journey days, XP and the CRM webhook; a revision
  // run changes nothing but its own row.
  const after = await afterStatus().catch(() => ({ complete: false, successStatus: null, row: null }));
  const nowComplete = after.complete;
  let kind: Awaited<ReturnType<typeof classifyAttempt>> = null;
  if (nowComplete) {
    try {
      kind = await classifyAttempt(svc, session.attemptId);
    } catch (e) {
      console.warn("[xapi/statements] attempt classification failed (treated as official):", e);
    }
  }
  // ADR 0014 step 4: a revision visit's row is never an official run, so
  // neither RPC is called for it (gamification_record_activity moves the
  // streak and last_active_day on every call) and no webhook fires.
  const officialRun = !isRevision && (!nowComplete || !kind || kind.official);

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
  // CRM completion webhook, official attempts only (ADR 0015 steps 3 and 4).
  // The boolean the fire function answers is the sweep's, and is ignored here.
  const decision = decideCompletionWebhook({
    official: officialRun,
    before,
    after,
    batch: { completingStatementCarriedSuccess, terminated },
  });
  if (decision === "fire") {
    await fireCompletionWebhookForAttempt(session.attemptId, kind?.attemptNumber ?? null);
  } else if (decision === "refire" && typeof before.webhookAt === "string") {
    console.warn(JSON.stringify({ event: "webhook_refired", attempt_id: session.attemptId }));
    await fireCompletionWebhookForAttempt(session.attemptId, kind?.attemptNumber ?? null, { refireFrom: before.webhookAt });
  } else if (decision === "hold") {
    console.warn(JSON.stringify({ event: "webhook_held", attempt_id: session.attemptId }));
  }

  // Fan-out: mirror these statements to the org's external LRS if configured.
  // Fail-isolated + non-blocking — never affects this response or our own copy.
  await mirrorToExternalLrs(session.attemptId, mirror);

  // ADR 0017 step 19: the result note on the official registration, the lock
  // source of the next engine release's pre-claim read; the A.1 engine reads it
  // only in revision mode. Last, so an inert document can never take the last
  // subrequest before the message or the outbox row. The row read above says
  // whether anything moved; a failed read writes nothing.
  if (
    officialRun &&
    after.row &&
    (after.successStatus !== before.successStatus || (after.row.score ?? null) !== before.score)
  ) {
    const failed = () => console.warn(JSON.stringify({ event: "official_result_write_failed", attempt_id: session.attemptId }));
    try {
      const writtenAt = new Date().toISOString();
      const { error: orErr } = await svc.from("xapi_state").upsert(
        {
          attempt_id: session.attemptId,
          state_id: LMS_OFFICIAL_RESULT_STATE_ID,
          content: buildOfficialResult({
            scoring: {
              officialStatus: after.successStatus ?? (after.complete ? "completed" : null),
              officialScore: after.row.score ?? null,
              officialAttempt: {
                id: session.attemptId,
                completed_at: after.row.completed_at ?? null,
                course_version_id: after.row.course_version_id ?? null,
              },
            },
            writtenAt,
          }),
          content_type: "application/json",
          updated_at: writtenAt,
        },
        { onConflict: "attempt_id,state_id" }
      );
      if (orErr) failed();
    } catch {
      failed();
    }
  }

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
