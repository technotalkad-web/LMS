/**
 * checkSession: ordering (G3) and once-per-registration (R5) over the
 * statements of one attempt, in stored order (BLUEPRINT §5.2 G3, §7 R5;
 * cmi5 §9.3). Registration = attempt id in the future-first profile.
 *
 *   per session (the cmi5 sessionid extension):
 *     G3 statement_before_initialized   anything before the AU `initialized`
 *     G3 initialized_twice              a second `initialized` while the session is open
 *     G3 statement_after_terminated     anything but `initialized` after `terminated`
 *     G3 session_reinitialized (warn, lms)
 *                                       `initialized` again after `terminated` under the
 *                                       same sessionid: a new launch that did not get a new
 *                                       sessionid (or the engine's reopen after a finalise,
 *                                       ADR 0006 step 4). The data cannot tell which, and the
 *                                       LMS issues the sessionid, so it is LMS-attributable
 *                                       and never counts toward a revoke (ADR 0005 step 7);
 *                                       the reopened session is then checked from scratch.
 *   per registration (context.registration):
 *     R5 completed_twice / passed_twice  at most one AU-level completed and one passed
 *     R5 failed_after_passed            no AU-level failed after passed
 *
 * Statements with the same `id` are one statement (write-once storage, ADR
 * 0003): only the first copy is checked. Quiz-run summaries (S4) are not
 * AU-level and do not count. A statement with a broken shape (G1) is skipped;
 * checkStatement reports it.
 */
import { CMI5_SESSION_EXT, VERB, type AldsLaunchData } from "../types";
import { Report, type CheckResult } from "./findings";
import { classifyStatement, expectedAuId } from "./statement";
import { get, getObj, isNonEmptyStr, isObj, isStr } from "./util";

export interface SessionContext {
  auActivityId?: string;
  launchData?: AldsLaunchData;
}

type SessionState = "before-init" | "open" | "closed";

export function checkSession(statements: readonly unknown[], ctx: SessionContext = {}): CheckResult {
  const r = new Report();
  r.check("G3");
  r.check("R5");
  if (!Array.isArray(statements)) {
    r.add("G3", "not_an_array", "checkSession expects an array of statements");
    return r.result();
  }

  const seenIds = new Set<string>();
  const sessions = new Map<string, SessionState>();
  const regs = new Map<string, { completed: number; passed: number; passedAt: number }>();

  statements.forEach((s, index) => {
    if (!isObj(s)) return;
    const verbId = get(getObj(s, "verb"), "id");
    if (!isStr(verbId) || !isObj(s.object)) return;
    if (isNonEmptyStr(s.id)) {
      if (seenIds.has(s.id)) return;
      seenIds.add(s.id);
    }
    const context = getObj(s, "context");
    const sessionKey = String(get(getObj(context, "extensions"), CMI5_SESSION_EXT) ?? "");
    const regKey = String(get(context, "registration") ?? "");
    const cls = classifyStatement(s, expectedAuId(s, ctx));
    const isAu = cls === "au-defined";
    const state = sessions.get(sessionKey) ?? "before-init";

    // G3: order within the session
    if (isAu && verbId === VERB.initialized) {
      if (state === "open") {
        r.add("G3", "initialized_twice", "a second initialized while the session is open", { index });
      } else if (state === "closed") {
        r.add("G3", "session_reinitialized", "initialized again after terminated under the same sessionid (new launch without a new sessionid, or an engine reopen)", {
          index,
          severity: "warn",
          attribution: "lms",
        });
      }
      sessions.set(sessionKey, "open");
    } else if (state === "before-init") {
      if (cls !== "lms-defined") r.add("G3", "statement_before_initialized", "a statement before initialized in its session", { index });
    } else if (state === "closed") {
      if (cls !== "lms-defined") r.add("G3", "statement_after_terminated", "a statement after terminated in its session", { index });
    } else if (isAu && verbId === VERB.terminated) {
      sessions.set(sessionKey, "closed");
    }

    // R5: once per registration (AU-level outcomes only)
    if (!isAu) return;
    const reg = regs.get(regKey) ?? { completed: 0, passed: 0, passedAt: -1 };
    regs.set(regKey, reg);
    if (verbId === VERB.completed) {
      reg.completed++;
      if (reg.completed > 1) r.add("R5", "completed_twice", "a second AU-level completed in one registration", { index });
    } else if (verbId === VERB.passed) {
      reg.passed++;
      if (reg.passed > 1) r.add("R5", "passed_twice", "a second AU-level passed in one registration", { index });
      if (reg.passedAt < 0) reg.passedAt = index;
    } else if (verbId === VERB.failed && reg.passedAt >= 0) {
      r.add("R5", "failed_after_passed", "an AU-level failed after passed in one registration", { index });
    }
  });

  return r.result();
}
