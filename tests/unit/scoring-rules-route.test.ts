/**
 * ADR 0014 step 9 (Q1, "Retire the multi-attempt setting"): the
 * scoring window and Block are retired.
 *
 *   - isDefaultRule(body), the pure twin of POST /api/scoring-rules' refusal
 *     (400 for any non-default value; an empty or
 *     default-valued body upserts the default row as before);
 *   - a source check of the route's wiring: it authenticates through the
 *     cookie-bound server client (no unit rig), so its proof is the twin plus
 *     this check plus spec 61 (the route-test reading);
 *   - source checks of the read-only card and of the launch page's removed
 *     block refusal (no React rig).
 *
 * Run:  npx tsx tests/unit/scoring-rules-route.test.ts   (or npm run test:unit)
 */
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_POLICY, isDefaultRule } from "../../lib/scoring/policy";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const root = path.resolve(__dirname, "../..");
/** Source with line and block comments blanked (strings kept), so a comment is never read as code. */
const code = (rel: string) =>
  fs
    .readFileSync(path.join(root, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

const ADR_TEXT = "Attempt rules are fixed by ADR 0014: one official attempt, then review-only revision visits; extra attempts by grant.";

console.log("\nisDefaultRule(body): the raw body's five rule fields (ADR 0014 step 9)");
{
  const base = { orgSlug: "acme", scope: "course", target_id: "c1" };
  eq("the platform default is one official attempt, first basis, no nth, first retained, then revision",
    [DEFAULT_POLICY.max_scored_attempts, DEFAULT_POLICY.official_basis, DEFAULT_POLICY.official_attempt_number, DEFAULT_POLICY.retain_first_attempt, DEFAULT_POLICY.after_limit],
    [1, "first", null, true, "practice"]);
  eq("{} passes", isDefaultRule({}), true);
  eq("a body with only the target fields passes (no rule field sent)", isDefaultRule(base), true);
  eq("a missing body (undefined / null) passes: the route reads it as {}", [isDefaultRule(undefined), isDefaultRule(null)], [true, true]);
  eq("the fully default body passes",
    isDefaultRule({ ...base, max_scored_attempts: 1, official_basis: "first", official_attempt_number: null, retain_first_attempt: true, after_limit: "practice" }), true);
  eq("{ max_scored_attempts: \"1\" } passes (a numeric string counts as its number)", isDefaultRule({ max_scored_attempts: "1" }), true);
  eq("explicit nulls pass (the route's fills read null as the default)",
    isDefaultRule({ max_scored_attempts: null, official_basis: null, official_attempt_number: null, retain_first_attempt: null, after_limit: null }), true);
  const deviations: Array<[string, Record<string, unknown>]> = [
    ["max_scored_attempts: 3", { max_scored_attempts: 3 }],
    ["max_scored_attempts: \"3\"", { max_scored_attempts: "3" }],
    ["max_scored_attempts: 0", { max_scored_attempts: 0 }],
    ["max_scored_attempts: 1.4 (today's fill would round it to 1; the raw body is not the default)", { max_scored_attempts: 1.4 }],
    ["max_scored_attempts: \"\"", { max_scored_attempts: "" }],
    ["max_scored_attempts: \"one\"", { max_scored_attempts: "one" }],
    ["max_scored_attempts: true", { max_scored_attempts: true }],
    ["official_basis: \"best\"", { official_basis: "best" }],
    ["official_basis: \"latest\"", { official_basis: "latest" }],
    ["official_basis: \"nth\"", { official_basis: "nth", official_attempt_number: 1 }],
    ["official_attempt_number: 2", { official_attempt_number: 2 }],
    ["official_attempt_number: 1 (the default is null)", { official_attempt_number: 1 }],
    ["retain_first_attempt: false", { retain_first_attempt: false }],
    ["retain_first_attempt: \"true\" (a string is not the boolean)", { retain_first_attempt: "true" }],
    ["after_limit: \"block\" (ADR 0014:193)", { after_limit: "block" }],
    ["after_limit: \"anything\"", { after_limit: "anything" }],
  ];
  for (const [what, b] of deviations) eq(`${what} fails`, isDefaultRule({ ...base, ...b }), false);
  eq("one deviation among default values still fails",
    isDefaultRule({ max_scored_attempts: 1, official_basis: "first", official_attempt_number: null, retain_first_attempt: true, after_limit: "block" }), false);
}

console.log("\nPOST /api/scoring-rules: the refusal's wiring (source check; cookie-bound client, no unit rig)");
{
  const src = code("app/api/scoring-rules/route.ts");
  const post = src.slice(src.indexOf("export async function POST("), src.indexOf("export async function DELETE("));
  const del = src.slice(src.indexOf("export async function DELETE("));
  eq("the route authenticates through the cookie-bound server client", /import \{ createClient \} from "@\/lib\/supabase\/server";/.test(src), true);
  eq("non-vacuous: POST and DELETE were found", [post.length > 200, del.length > 200], [true, true]);
  const guard = post.indexOf("if (!isDefaultRule(body)) {");
  const fill = post.indexOf("const max = Math.round(");
  const target = post.indexOf("await targetInOrg(");
  const upsert = post.indexOf(".upsert(");
  eq("POST calls isDefaultRule(body) on the raw body after the auth and target checks, before the fills and the upsert",
    [guard > 0, target > 0 && target < guard, fill > guard, upsert > fill], [true, true, true, true]);
  eq("…and answers 400 with the ADR's text",
    /if \(!isDefaultRule\(body\)\) \{\s*return NextResponse\.json\(\{ error: FIXED_RULE_ERROR \}, \{ status: 400 \}\);\s*\}/.test(post) &&
      src.includes(`const FIXED_RULE_ERROR =\n  "${ADR_TEXT}";`.replace(/\n/g, src.includes("\r\n") ? "\r\n" : "\n")), true);
  eq("the max_scored_attempts fill comes from DEFAULT_POLICY (never `?? 3`, which stored a non-default row from an empty body)",
    [/Number\(body\.max_scored_attempts \?\? DEFAULT_POLICY\.max_scored_attempts\)/.test(post), /\?\? 3\b/.test(post)], [true, false]);
  eq("DELETE is unchanged: admins only through ctx(), deletes the one target row of the caller's org, never calls isDefaultRule",
    [
      /const c = await ctx\(body\.orgSlug\);/.test(del),
      /\.from\("attempt_scoring_rules"\)\s*\.delete\(\)\s*\.eq\("organization_id", c\.orgId\)\s*\.eq\("scope", scope\)\s*\.eq\("target_id", targetId\);/.test(del),
      /isDefaultRule/.test(del),
    ],
    [true, true, false]);
  eq("ctx() still admits only super_owner, owner and admin", /\["super_owner", "owner", "admin"\]\.includes\(role\)/.test(src), true);
}

console.log("\nthe scoring-rules card is a read-only note (source check; no React rig)");
{
  const src = code("components/scoring/scoring-rules-card.tsx");
  eq("the read-only note, verbatim from ADR 0014:193", src.includes("One official attempt, then review-only revision visits; extra attempts by grant"), true);
  eq("the header sentence", src.includes("Attempt rules are the same for every module (ADR 0014)."), true);
  eq("the editor is gone: no POST, no number input, no radio rows, no Save, no \"In effect\" line",
    [/method: "POST"/.test(src), /type="number"/.test(src), /RadioRow/.test(src), /Save rules|Set rules/.test(src), /In effect:/.test(src)],
    [false, false, false, false, false]);
  eq("a legacy rule row is described and read as the default", /\{hasRule && initialRule && \([\s\S]*?A rule is stored on this \{targetNoun\[scope\]\} \(\{describePolicy\(initialRule\)\}\); it is\s*read as the default\./.test(src), true);
  eq("\"Remove rule\" is kept (DELETE) and its confirm text no longer names \"3 scored attempts\"",
    [/method: "DELETE"/.test(src), /Remove rule/.test(src), /3 scored attempts/.test(src)], [true, true, false]);
}

console.log("\nthe launch page's block refusal is removed (ADR 0014 step 9; source check)");
{
  const src = code("app/[org]/(learner)/courses/[courseId]/launch/page.tsx");
  eq("no scoring.blocked test and no ?limit=1 redirect", [/scoring\.blocked/.test(src), /\?limit=1/.test(src)], [false, false]);
  eq("non-vacuous: the evaluate step still returns the candidate", /return \{ my, scoring, candidate \};/.test(src), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
