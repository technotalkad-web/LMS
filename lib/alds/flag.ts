/**
 * ALDS P4 feature flag (ADR 0005 note (h) of 2026-10-19; ADR 0006 note (a)).
 *
 * Server-only: import from route handlers, server components and lib/ only;
 * never from lib/alds/rules/ or lib/alds/types.ts (the pure, hashed rules
 * tree; scripts/build-alds-rules.mjs --check) and never from a client
 * component (no NEXT_PUBLIC_ prefix, so the value is never inlined into a
 * browser bundle).
 *
 * Default OFF. ALDS_P4 is absent from wrangler.toml and from the Cloud Run
 * environment on main; it is set per environment only after
 * 0100_alds_core.sql is confirmed there (staging first; production after
 * v1.4.0 and 0100, in a later tag). It gates the Package Guardian writes,
 * the tier surfaces and the ADR 0006 §C launch contract.
 */
export const ALDS_P4_ENV = "ALDS_P4" as const;

/** True only when ALDS_P4 is "on", "1" or "true" (trimmed, case-insensitive). */
export function aldsP4Enabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = (env[ALDS_P4_ENV] ?? "").trim().toLowerCase();
  return v === "on" || v === "1" || v === "true";
}

/**
 * A PostgREST / supabase-js error meaning a 0100 column, relation or
 * function is not on this database yet. Every P4 caller treats it as
 * "skip": the gate logs and returns, the launch page retries its insert
 * without the P4 columns, the UI shows no badge. Upload and launch never
 * fail for it.
 */
export function isAldsSchemaMissing(
  error: { code?: string | null; message?: string | null } | null | undefined
): boolean {
  if (!error) return false;
  const code = error.code ?? "";
  if (code === "42703" || code === "42P01" || code === "42883" || code === "PGRST204" || code === "PGRST202") return true;
  return /schema cache|does not exist|could not find the/i.test(error.message ?? "");
}

/** One warning line, ids only, when a P4 step is skipped. */
export function logAldsSkip(
  where: string,
  why: string,
  ids: Record<string, string | null | undefined> = {}
): void {
  const parts = Object.entries(ids)
    .filter(([, v]) => !!v)
    .map(([k, v]) => `${k}=${v}`);
  console.warn(`[alds] ${where} skipped: ${why}${parts.length ? ` (${parts.join(" ")})` : ""}`);
}
