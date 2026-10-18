/**
 * checkSession: ordering (G3) and once-per-registration (R5) over the
 * statements of one attempt, in stored order (BLUEPRINT §5.2 G3, §7 R5;
 * cmi5 §9.3). Registration = attempt id in the future-first profile.
 *
 *   per session (the cmi5 sessionid extension):
 *     G3 statement_before_initialized   anything before the AU `initialized`
 *     G3 initialized_twice              a second `initialized` while the session is open
 *     G3 statement_after_terminated     anything but `initialized` after `terminated`
 *     G3 session_reopened (warn)        `initialized` again after `terminated` under the
 *                                       same sessionid. OPEN DECISION (owner/architect):
 *                                       ADR 0006 step 4 has the engine open "a new session
 *                                       (new initialized, same registration)" after a
 *                                       finalise without a relaunch, so without a new
 *                                       sessionid, while G3/R5 allow one `initialized` per
 *                                       session and S7 takes the sessionid from the
 *                                       template unchanged. Until that is decided the
 *                                       reopen has its own code, is package-attributed
 *                                       (the engine reopened; the LMS issues a new
 *                                       sessionid per launch) and is a warning, so it
 *                                       neither fails a check nor hides an engine cause
 *                                       behind the LMS; P5 decides by code whether it
 *                                       counts toward a revoke. The reopened session is
 *                                       then checked from scratch.
 *   per registration (context.registration):
 *     R5 completed_twice / passed_twice  at most one AU-level completed and one passed
 *                                       (§7 R5's per-registration clause, which §5.2 G3
 *                                       also states)
 *     G3 failed_after_passed            no AU-level failed after passed (§5.2 G3 only)
 *
 * Origin: rows the LMS itself recorded (cmi5 LMS-defined verbs such as
 * `launched`, `satisfied`, `abandoned`, `waived`) are outside the AU's
 * ordering. The caller names them in `lmsStatementIds`; every other row is
 * treated as sent by content, including a content-sent LMS-only verb (which
 * checkStatement reports as S2 lms_verb_from_content). Rows without an id
 * cannot be named and count as content.
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
  /** Ids of the rows the LMS itself recorded (not sent by content); default none. */
  lmsStatementIds?: readonly string[];
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

  const lmsIds = new Set(Array.isArray(ctx.lmsStatementIds) ? ctx.lmsStatementIds.filter(isStr) : []);
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
      if (lmsIds.has(s.id)) return; // recorded by the LMS: outside the AU's ordering
    }
    const context = getObj(s, "context");
    const sessionKey = String(get(getObj(context, "extensions"), CMI5_SESSION_EXT) ?? "");
    const regKey = String(get(context, "registration") ?? "");
    const isAu = classifyStatement(s, expectedAuId(s, ctx)) === "au-defined";
    const state = sessions.get(sessionKey) ?? "before-init";

    // G3: order within the session
    if (isAu && verbId === VERB.initialized) {
      if (state === "open") {
        r.add("G3", "initialized_twice", "a second initialized while the session is open", { index });
      } else if (state === "closed") {
        r.add("G3", "session_reopened", "initialized again after terminated under the same sessionid (an engine reopen after a finalise, ADR 0006 step 4, or a relaunch without a new sessionid); an open decision", {
          index,
          severity: "warn",
        });
      }
      sessions.set(sessionKey, "open");
    } else if (state === "before-init") {
      r.add("G3", "statement_before_initialized", "a statement before initialized in its session", { index });
    } else if (state === "closed") {
      r.add("G3", "statement_after_terminated", "a statement after terminated in its session", { index });
    } else if (isAu && verbId === VERB.terminated) {
      sessions.set(sessionKey, "closed");
    }

    // once per registration (AU-level outcomes only)
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
      r.add("G3", "failed_after_passed", "an AU-level failed after passed in one registration", { index });
    }
  });

  return r.result();
}
