/**
 * Findings: what every ALDS rule reports.
 *
 * Rule ids (one table; tier reasons in P4 come from `code`, so codes are the
 * stable vocabulary and ids group them by source paragraph):
 *
 * | id   | source                                   | entry point      | attribution |
 * |------|------------------------------------------|------------------|-------------|
 * | G1   | BLUEPRINT §5.2 G1 (actor/verb/object)     | checkStatement   | package     |
 * | S1   | §1.3 S1 contextTemplate as the base       | checkStatement   | lms         |
 * | S2   | §1.3 S2 cmi5-defined statements           | checkStatement   | package     |
 * | S3   | §1.3 S3 `answered` shape                  | checkStatement   | package     |
 * | S4   | §1.3 S4 quiz-run summary                  | checkStatement   | package     |
 * | S5   | §1.3 S5 text not truncated                | checkStatement   | package     |
 * | S6   | §1.3 S6 Browse/Review launch mode         | checkStatement   | package     |
 * | S7   | §1.3 S7 registration and session id       | checkStatement   | lms         |
 * | S8   | §1.3 S8 id and timestamp                  | checkStatement   | package     |
 * | S9   | §1.3 S9 no voiding, no StatementRef/Sub   | checkStatement   | package     |
 * | E1   | §1.3 table: engine-supplied extensions    | checkStatement   | package     |
 * | R10  | §7 R10 / §8.1 xAPI response grammar       | both             | package     |
 * | R3   | §7 R3 (qid, language) in the catalogue    | checkStatement   | package     |
 * | SEM  | ADR 0005 step 6 semantic check vs the key | checkStatement   | package     |
 * | POOL | ADR 0005 step 5 pools / drawn set         | both             | package     |
 * | G3   | §5.2 G3 order within a session            | checkSession     | package; `session_reinitialized` lms |
 * | R5   | §7 R5 once per registration               | checkSession     | package     |
 * | U1   | §2 U1 manifest parses, standardVersion    | checkPackage     | package     |
 * | U2   | §2 U2 publisherIds in the real XML        | checkPackage     | package     |
 * | U3   | §2 U3 contentHash recomputes              | checkPackage     | package     |
 * | U4   | §2 U4 language/script (informational)     | checkPackage     | package     |
 * | U5   | §2 U5 known rulesBundleHash               | checkPackage     | package     |
 * | U7   | §2 U7 exactly one AU                      | checkPackage     | package     |
 * | R4   | §7 R4 declared language vs the slot       | checkPackage     | package     |
 *
 * Attribution follows ADR 0005 step 7: package-attributable findings count
 * toward a version's revoke threshold; LMS-attributable ones (S1/S7 template,
 * missing LaunchData extensions, LMS-caused relaunch ordering) mark the
 * session unreliable and never revoke.
 *
 * Severity: `error` = a MUST is violated (fails certification); `warn` = a
 * SHOULD, or a case whose cause is not decidable from the data; `info` =
 * informational only (U4, ADR 0004 step 6).
 */

export type RuleId =
  | "G1" | "S1" | "S2" | "S3" | "S4" | "S5" | "S6" | "S7" | "S8" | "S9"
  | "E1" | "R10" | "R3" | "SEM" | "POOL"
  | "G3" | "R5"
  | "U1" | "U2" | "U3" | "U4" | "U5" | "U7" | "R4";

export const RULE_IDS: readonly RuleId[] = [
  "G1", "S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9",
  "E1", "R10", "R3", "SEM", "POOL",
  "G3", "R5",
  "U1", "U2", "U3", "U4", "U5", "U7", "R4",
];

export type Severity = "error" | "warn" | "info";
export type Attribution = "package" | "lms";

export interface Finding {
  rule: RuleId;
  /** Stable snake_case reason; P4 tier reasons and P5 finding ids use it. */
  code: string;
  severity: Severity;
  attribution: Attribution;
  message: string;
  /** Where in the input, e.g. "result.response" or "questions[3].contentHash". */
  path?: string;
  /** checkSession: index of the statement in the input array. */
  index?: number;
}

export interface CheckResult {
  /** True when no finding has severity `error`. */
  ok: boolean;
  findings: Finding[];
  /** Rules that were evaluated for this input (a rule absent here was not applicable). */
  checked: RuleId[];
}

/** Collects findings and the set of evaluated rules. */
export class Report {
  readonly findings: Finding[] = [];
  private readonly checkedSet = new Set<RuleId>();

  check(rule: RuleId): void {
    this.checkedSet.add(rule);
  }

  add(
    rule: RuleId,
    code: string,
    message: string,
    opts: { severity?: Severity; attribution?: Attribution; path?: string; index?: number } = {},
  ): void {
    this.checkedSet.add(rule);
    const f: Finding = {
      rule,
      code,
      severity: opts.severity ?? "error",
      attribution: opts.attribution ?? "package",
      message,
    };
    if (opts.path !== undefined) f.path = opts.path;
    if (opts.index !== undefined) f.index = opts.index;
    this.findings.push(f);
  }

  result(): CheckResult {
    const checked = RULE_IDS.filter((r) => this.checkedSet.has(r));
    return {
      ok: !this.findings.some((f) => f.severity === "error"),
      findings: this.findings.slice(),
      checked,
    };
  }
}
