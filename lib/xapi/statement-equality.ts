/**
 * Write-once statements (ADR 0003 step 5): when a statement id already
 * exists on the attempt, is the incoming statement an exact retry of the
 * stored one, or different content under a reused id?
 *
 * The stored `raw` carries the fields the LMS filled on the first write (a
 * deterministic `id` for an id-less statement, a `timestamp` when the content
 * sent none). The comparison is made against the statement AS RECEIVED, so
 * those LMS-filled fields are ignored exactly when the incoming statement
 * lacks them. jsonb does not keep key order, hence the canonical form.
 *
 * Pure; no next/* imports (unit-testable).
 */

/** JSON with object keys sorted at every level (arrays keep their order). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v === undefined) continue;
      out[k] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/**
 * True when `received` (the body the content sent, untouched) is the same
 * statement as `stored` (the raw the LMS stored on the first write).
 */
export function isSameStatementAsReceived(stored: unknown, received: unknown): boolean {
  if (!stored || typeof stored !== "object" || !received || typeof received !== "object") return false;
  const s = { ...(stored as Record<string, unknown>) };
  const r = { ...(received as Record<string, unknown>) };
  // Fields the LMS fills when absent are not part of what the content sent.
  for (const k of ["id", "timestamp"]) {
    if (r[k] === undefined || r[k] === null || r[k] === "") {
      delete s[k];
      delete r[k];
    }
  }
  return canonicalJson(s) === canonicalJson(r);
}

/** What the statements route does with a statement whose id already exists. */
export type ResendDecision =
  /** An exact retry: re-run the (idempotent) derivation on the stored copy. */
  | "process-stored"
  /** The stored copy could not be read: process the statement as received, as the insert-error branch does (a read that never happened is not a difference). */
  | "process-received"
  /** Different content under a reused id: skip it, keep it out of the LRS mirror, log statement_conflict. */
  | "conflict";

/**
 * ADR 0003 step 5: processing is skipped ONLY when the stored statement was
 * read and differs from the one received. `read` is the result of reading
 * the stored row (`raw` undefined/null when no row came back).
 */
export function decideResend(read: { raw: unknown; error: unknown }, received: unknown): ResendDecision {
  if (read.error || read.raw === undefined || read.raw === null) return "process-received";
  return isSameStatementAsReceived(read.raw, received) ? "process-stored" : "conflict";
}
