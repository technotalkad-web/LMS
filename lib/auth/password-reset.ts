import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/**
 * Helpers for the OTP-based password-reset flow. All comparisons are
 * constant-time and codes are stored hashed in the DB.
 */

export const OTP_LENGTH = 6;
export const OTP_TTL_MINUTES = 10;
export const MAX_VERIFY_ATTEMPTS = 5;
export const MAX_REQUESTS_PER_HOUR = 5;
export const RESET_TOKEN_TTL_MINUTES = 15;

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
