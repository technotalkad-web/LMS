import { createHash } from "crypto";

/** Namespace for every LMS-derived statement id (RFC 4122 v5, fixed). */
export const LMS_STATEMENT_NAMESPACE = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

/**
 * Deterministic UUID v5 — the same (namespace, name) always yields the same
 * id, so LMS-derived statements (launched, path satisfied, XP earned …) are
 * idempotent across sweeps, backfills and retries: an LRS that already holds
 * the id simply keeps the first copy.
 */
export function uuid5(name: string, namespace = LMS_STATEMENT_NAMESPACE): string {
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const hash = createHash("sha1").update(ns).update(name, "utf8").digest();
  const b = Buffer.from(hash.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
