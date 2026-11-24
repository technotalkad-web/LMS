import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Helpers for the OTP-based password-reset flow. All comparisons are
 * constant-time and codes are stored hashed in the DB.
 */

export const OTP_LENGTH = 6;
export const OTP_TTL_MINUTES = 10;
export const MAX_VERIFY_ATTEMPTS = 5;
export const MAX_REQUESTS_PER_HOUR = 5;
/** One account's codes or links in 24 hours (ADR 0029 section G), in both systems. */
export const MAX_REQUESTS_PER_DAY = 10;
export const RESET_TOKEN_TTL_MINUTES = 15;

/**
 * The one failure answer of the verify step (status 400): the same for a
 * missing, expired, used or wrong code and for too many attempts. It names
 * no count and nothing about the account.
 */
export const VERIFY_FAILED_MESSAGE =
  "That code is incorrect or has expired. Request a new one.";

/**
 * The one failure answer of the reset step before the password is set
 * (status 400): the same for a missing, expired or wrong reset session.
 */
export const RESET_SESSION_INVALID_MESSAGE =
  "This reset session is no longer valid. Request a new code.";

/** Generate a uniformly random 6-digit code, zero-padded. */
export function generateOtpCode(): string {
  const n = randomInt(0, 1_000_000); // 0 … 999999 inclusive of 0, exclusive of 1e6
  return n.toString().padStart(OTP_LENGTH, "0");
}

/** SHA-256 of the code. */
export function hashOtp(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

/** Constant-time compare two hex strings. */
export function safeHashEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

/**
 * Mint a single-use reset token. Returned to the client after a
 * successful OTP verify; required to call the reset endpoint.
 * 32 bytes of randomness, encoded as 64 hex chars.
 */
export function mintResetToken(): string {
  return randomBytes(32).toString("hex");
}

/** SHA-256 of the reset token (we never store the raw token). */
export function hashResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Counts one guess on an active code row BEFORE the code is compared.
 *
 * One compare-and-set through PostgREST: the row's attempts move from
 * `row.attempts` to `row.attempts + 1` only while the row still holds
 * `row.attempts`, is unused and has not expired, and the update returns the
 * row it changed. Of any number of overlapping guesses that read the same
 * count, exactly one gets the row back. Only that caller may compare, and
 * only against the hash this call returned.
 *
 * Returns the code hash when this guess took the slot; null when it did not
 * (the limit is reached, another guess took the slot, the row closed, or the
 * call failed). On null the caller answers the failure and compares nothing.
 */
export async function countGuess(
  svc: SupabaseClient,
  row: { id: string; attempts: number }
): Promise<string | null> {
  if (!(row.attempts >= 0) || row.attempts >= MAX_VERIFY_ATTEMPTS) return null;
  const { data, error } = await svc
    .from("password_reset_otps")
    .update({ attempts: row.attempts + 1 })
    .eq("id", row.id)
    .eq("attempts", row.attempts)
    .is("used_at", null)
    .gt("expires_at", new Date().toISOString())
    .select("id, code_hash");
  if (error || !Array.isArray(data) || data.length !== 1) return null;
  const hit = data[0] as { id?: unknown; code_hash?: unknown };
  if (hit.id !== row.id || typeof hit.code_hash !== "string") return null;
  return hit.code_hash;
}
