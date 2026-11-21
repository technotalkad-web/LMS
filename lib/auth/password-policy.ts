/**
 * The one password policy (ADR 0029, safeguard S7): at least 10 characters,
 * with at least two of lowercase, uppercase, digit and symbol. It is the
 * rule a password change has always had; the set-password route and the
 * change-password route take it from here, so the two cannot drift apart.
 *
 * The check is pure: no read, no log line, and the password is never part
 * of an answer.
 */

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MIN_CLASSES = 2;

/** The rule in words, for a page that asks for a new password. */
export const PASSWORD_RULE_TEXT =
  "At least 10 characters, with at least two of: lowercase, uppercase, digit, symbol.";

export const PASSWORD_TOO_SHORT_MESSAGE = `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
export const PASSWORD_TOO_PLAIN_MESSAGE = "Password must mix at least two of: lowercase, uppercase, digit, symbol.";

/** How many of the four kinds of character the password holds. */
function characterClasses(pw: string): number {
  let classes = 0;
  if (/[a-z]/.test(pw)) classes++;
  if (/[A-Z]/.test(pw)) classes++;
  if (/[0-9]/.test(pw)) classes++;
  if (/[^A-Za-z0-9]/.test(pw)) classes++;
  return classes;
}

/** Whether a new password meets the policy; when it does not, the one message to show. */
export function checkPassword(pw: unknown): { ok: true } | { ok: false; error: string } {
  if (typeof pw !== "string" || pw.length < PASSWORD_MIN_LENGTH) return { ok: false, error: PASSWORD_TOO_SHORT_MESSAGE };
  if (characterClasses(pw) < PASSWORD_MIN_CLASSES) return { ok: false, error: PASSWORD_TOO_PLAIN_MESSAGE };
  return { ok: true };
}
