import type { NotificationContext } from "./types";

/**
 * Substitutes {Placeholder_Name} tokens in `s` with values from `ctx`.
 * Matching is case-insensitive. Unknown tokens are left untouched so the
 * admin can spot typos at preview time.
 */
export function substitute(s: string, ctx: NotificationContext): string {
  return s.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (full, key: string) => {
    const k = key.toLowerCase();
    const v = ctx[k];
    if (v === undefined || v === null || v === "") return full;
    return String(v);
  });
}

/**
 * Default tokens we always know we can offer in the editor's helper UI.
 * Admins can use any subset of these; templates that reference a token
 * not provided by the trigger context render the literal `{Token}` so
 * mistakes are visible rather than silently empty.
 */
export const KNOWN_TOKENS = [
  "Learner_Name",
  "Learner_Email",
  "Course_Name",
  "Path_Name",
  "Username",
  "Login_ID",
  "Password",
  "Org_Name",
  "Direct_Link",
  "Portal_URL",
  "Due_Date",
  "Score",
] as const;
