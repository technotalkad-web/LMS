import { ALDS_NS as ALDS_NAMESPACE, EXT } from "../alds/types";
import { uuid5 } from "./uuid5";

/**
 * Deterministic ids for statements the content sent without one (ADR 0003
 * step 6, BLUEPRINT §5.3).
 *
 * The KIVO engine never sets statement ids and re-POSTs the same queued
 * object after a 5xx; a random id per POST stored every retry as a new row.
 * The engine stamps `timestamp` before the first send and re-queues the same
 * object, so an exact retry hashes to the same id (one row) while statements
 * from separate launches or separate tries never collapse.
 *
 * Both constants now live in lib/alds/types.ts (moved in P3, as ADR 0003
 * step 6 planned); re-exported here under their old names, values unchanged.
 */

/** ALDS statement namespace (BLUEPRINT §5.3). Not LMS_STATEMENT_NAMESPACE. */
export const ALDS_NS: string = ALDS_NAMESPACE;

/** Context extension carrying the question try number (BLUEPRINT §1.3). */
export const ALDS_QUESTION_TRY_EXT: string = EXT.questionTry;

type StatementLike = {
  verb?: { id?: string } | null;
  object?: { id?: string } | null;
  timestamp?: string | null;
  result?: unknown;
  context?: { extensions?: Record<string, unknown> | null } | Record<string, unknown> | null;
};

/** The uuid5 name: attempt | verb | object | timestamp as sent | result | try. */
export function statementIdName(attemptId: string, statement: StatementLike): string {
  const ext = (statement.context as { extensions?: Record<string, unknown> | null } | null | undefined)
    ?.extensions;
  return [
    attemptId,
    statement.verb?.id ?? "",
    statement.object?.id ?? "",
    // As sent by the content: computed BEFORE the route fills a missing one.
    typeof statement.timestamp === "string" ? statement.timestamp : "",
    JSON.stringify(statement.result ?? null),
    JSON.stringify(ext?.[ALDS_QUESTION_TRY_EXT] ?? null),
  ].join("|");
}

/** Deterministic statement id for an id-less statement on this attempt. */
export function deterministicStatementId(attemptId: string, statement: StatementLike): string {
  return uuid5(statementIdName(attemptId, statement), ALDS_NS);
}

/**
 * Id of the LMS-derived "abandoned" statement for one attempt. The LRS
 * sweeper (srcAttempts) and the live enqueue at every abandon site
 * (lib/lrs/abandoned.ts) both use it, so the outbox (unique on org +
 * statement id) and a conformant LRS keep one copy. LMS namespace
 * (uuid5's default), not ALDS_NS: it names an LMS event, not a content
 * statement.
 */
export function abandonedStatementId(attemptId: string): string {
  return uuid5(`abandoned:${attemptId}`);
}
