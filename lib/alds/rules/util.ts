/**
 * Small pure helpers shared by the rules: JSON access, value formats and the
 * text normalisation of the canonical content hash (BLUEPRINT §1.1).
 */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Obj = { [k: string]: unknown };

export function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isStr(v: unknown): v is string {
  return typeof v === "string";
}

export function isNonEmptyStr(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

export function isInt(v: unknown, min: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= min;
}

export function hasOwn(o: Obj, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

/** o[k] when o is an object, else undefined. */
export function get(o: unknown, k: string): unknown {
  return isObj(o) && hasOwn(o, k) ? o[k] : undefined;
}

export function getObj(o: unknown, k: string): Obj | undefined {
  const v = get(o, k);
  return isObj(v) ? v : undefined;
}

export function getArr(o: unknown, k: string): unknown[] | undefined {
  const v = get(o, k);
  return Array.isArray(v) ? v : undefined;
}

// --- formats ----------------------------------------------------------------

/** ULID: 26 Crockford base32 characters, upper case, first ≤ 7 (128-bit limit). */
export const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
/** RFC 4122 UUID (any version 1–8, variant 10xx), case-insensitive. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
export const SEMVER_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
/** KIVO option id: "o" + 1..N (BLUEPRINT §1.1). */
export const OID_RE = /^o[1-9][0-9]*$/;
/** ISO 8601 date-time; group 1 is the offset (Z or ±hh[:]mm) when present. */
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
/** ISO 8601 duration (xAPI result.duration). */
const DURATION_RE =
  /^P(?=\d|T\d)(?:\d+(?:\.\d+)?Y)?(?:\d+(?:\.\d+)?M)?(?:\d+(?:\.\d+)?W)?(?:\d+(?:\.\d+)?D)?(?:T(?=\d)(?:\d+(?:\.\d+)?H)?(?:\d+(?:\.\d+)?M)?(?:\d+(?:\.\d+)?S)?)?$/;

export function isUlid(v: unknown): v is string {
  return typeof v === "string" && ULID_RE.test(v);
}
export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}
export function isSha256(v: unknown): v is string {
  return typeof v === "string" && SHA256_RE.test(v);
}
export function isSemver(v: unknown): v is string {
  return typeof v === "string" && SEMVER_RE.test(v);
}
export function isOid(v: unknown): v is string {
  return typeof v === "string" && OID_RE.test(v);
}
export function isDuration(v: unknown): v is string {
  return typeof v === "string" && DURATION_RE.test(v);
}

/** "ok" | "missing_offset" | "invalid" for an xAPI timestamp (S8). */
export function timestampState(v: unknown): "ok" | "missing_offset" | "invalid" {
  if (typeof v !== "string") return "invalid";
  const m = TIMESTAMP_RE.exec(v);
  if (!m) return "invalid";
  if (!m[1]) return "missing_offset";
  return Number.isNaN(Date.parse(v)) ? "invalid" : "ok";
}

// --- BCP 47 -------------------------------------------------------------------

/** RFC 5646 langtag (no grandfathered or private-use-only tags), case-insensitive. */
const BCP47_RE =
  /^[a-z]{2,3}(?:-[a-z]{3}){0,3}(?:-[a-z]{4})?(?:-(?:[a-z]{2}|\d{3}))?(?:-(?:[a-z\d]{5,8}|\d[a-z\d]{3}))*(?:-[0-9a-wy-z](?:-[a-z\d]{2,8})+)*(?:-x(?:-[a-z\d]{1,8})+)?$/i;

export function isBcp47(v: unknown): v is string {
  return typeof v === "string" && BCP47_RE.test(v);
}

/** Canonical case: language lower, script Title, region upper ("hi-latn" → "hi-Latn"). */
export function canonicalBcp47(tag: string): string {
  const parts = tag.split("-");
  let pastSingleton = false;
  return parts
    .map((p, i) => {
      if (i === 0) return p.toLowerCase();
      if (pastSingleton) return p.toLowerCase();
      if (p.length === 1) {
        pastSingleton = true;
        return p.toLowerCase();
      }
      if (p.length === 4 && /^[a-z]{4}$/i.test(p)) return p[0].toUpperCase() + p.slice(1).toLowerCase();
      if (p.length === 2 && /^[a-z]{2}$/i.test(p)) return p.toUpperCase();
      return p.toLowerCase();
    })
    .join("-");
}

export function primarySubtag(tag: string): string {
  return tag.split("-")[0].toLowerCase();
}

export function sameLanguageTag(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

// --- text ---------------------------------------------------------------------

/**
 * The text normalisation of the canonical content hash (BLUEPRINT §1.1:
 * "NFC, trimmed, single spaces"): Unicode NFC, every whitespace run → one
 * space, trimmed. Also used to compare a statement's text with the manifest.
 */
export function normalizeText(s: string): string {
  return s.normalize("NFC").replace(/\s+/g, " ").trim();
}

/** Deep equality for JSON values (object key order ignored). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!jsonEqual(a[i], b[i])) return false;
    return true;
  }
  if (isObj(a)) {
    if (!isObj(b)) return false;
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (!hasOwn(b, k) || !jsonEqual(a[k], b[k])) return false;
    return true;
  }
  return false;
}

/** Duplicates in a string list (each reported once, in first-seen order). */
export function duplicates(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const s of list) {
    if (seen.has(s)) dup.add(s);
    seen.add(s);
  }
  return Array.from(dup);
}

export function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
}
