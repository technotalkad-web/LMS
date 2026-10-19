/**
 * Unit test for the lifecycle nightly's public summary
 * (scripts/lifecycle-summary.mjs, run by scripts/lifecycle-nightly.sh):
 *
 *   - the per-spec counts, the headline and the exit codes (0 green, 1 a
 *     failure / top-level error / nothing ran, 2 no or bad report) are as
 *     before;
 *   - each failed, timed-out, interrupted or flaky test gets one line with
 *     its spec file, title path and the file:line:column of its first error
 *     (an error location inside tests/, else a tests/ stack frame, else the
 *     test's declaration), repository-relative, on stdout and in the job
 *     summary under "Failing tests (location only)"; only a location that
 *     names an existing file of this checkout counts, so a frame-shaped line
 *     in a message (which Playwright reports back as the error's location)
 *     never prints;
 *   - nothing else from the report reaches either: markers planted in error
 *     messages, stacks, stdout/stderr, attachments and top-level errors never
 *     appear, and a title that looks like data prints as `<title redacted>`.
 *
 * Run:  npx tsx tests/unit/lifecycle-summary.test.ts   (or npm run test:unit)
 *
 * The script runs as a child process on synthetic reports in a temp folder.
 * No browser, no database.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const ROOT = path.resolve(__dirname, "../..");
const SCRIPT = path.join(ROOT, "scripts", "lifecycle-summary.mjs");
const TESTDIR = path.join(ROOT, "tests", "bot", "lifecycle");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-summary-"));

// Planted where the report keeps data; none may reach the output.
const EMAIL = "leak.marker@lifecycle.test";
const JWT = "eyJleakmarkerAAAAAAAAAAAA.eyJzdWIiOiJ4In0.sig";
const KEY = "sb_secret_leakmarker0123456789";
const UUID = "3f2b1c0d-aaaa-4bbb-8ccc-0123456789ab";
const BODY = "RESPONSE-BODY-MARKER";
// Message text shaped like stack frames (a password, an org slug).
const FRAMED = ["secretpw123", "lifecycle-orgslug-zz9", "sekrit"];
const MARKERS = [EMAIL, JWT, KEY, UUID, BODY, ...FRAMED, "Expected:", "Received:"];
const message = `Error: expect(received).toBe(expected)\n\nExpected: "x"\nReceived: {"email":"${EMAIL}","token":"${JWT}","key":"${KEY}","id":"${UUID}","body":"${BODY}"}`;

type Loc = { file: string; line: number; column: number };
type Result = Record<string, unknown>;

/** One run's result with every data-carrying field populated. */
function result(status: string, errors: { location?: Loc }[] = [], stack?: string): Result {
  return {
    workerIndex: 0, parallelIndex: 0, status, duration: 1000, retry: 0, startTime: "2026-10-19T00:00:00.000Z",
    error: errors.length || stack ? { message, stack: `${message}\n${stack ?? ""}` } : undefined,
    errors: errors.map((e) => ({ message, ...e })),
    stdout: [{ text: `stdout ${EMAIL} ${BODY}\n` }],
    stderr: [{ text: `stderr ${JWT}\n` }],
    attachments: [
      { name: "screenshot", contentType: "image/png", body: Buffer.from(KEY).toString("base64") },
      { name: `trace ${UUID}`, contentType: "application/zip", path: `/tmp/${UUID}/trace.zip` },
    ],
    annotations: [],
  };
}
const testOf = (status: string, results: Result[]) => ({ timeout: 600000, annotations: [], expectedStatus: "passed", projectId: "chromium", projectName: "chromium", results, status });
const spec = (file: string, title: string, line: number, tests: unknown[]) => ({ title, ok: true, tags: [], tests, id: `${file}-${line}`, file, line, column: 7 });
const passed = (file: string, title: string, line: number) => spec(file, title, line, [testOf("expected", [result("passed")])]);
const fileSuite = (file: string, describe: string | null, specs: unknown[]) =>
  describe === null
    ? { title: file, file, column: 0, line: 0, specs }
    : { title: file, file, column: 0, line: 0, specs: [], suites: [{ title: describe, file, column: 6, line: 10, specs }] };
const report = (suites: unknown[], extra: Record<string, unknown> = {}) =>
  ({ config: { rootDir: TESTDIR }, suites, errors: [], stats: { startTime: "2026-10-19T00:00:00.000Z", duration: 61_400 }, ...extra });
const inRepo = (rel: string) => path.join(ROOT, ...rel.split("/"));

function run(name: string, rep: unknown, raw?: string) {
  const file = path.join(tmp, `${name}.json`);
  if (rep !== undefined || raw !== undefined) fs.writeFileSync(file, raw ?? JSON.stringify(rep));
  const summary = path.join(tmp, `${name}.md`);
  let code = 0, out = "";
  try {
    out = execFileSync(process.execPath, [SCRIPT, file], { encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: summary }, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    code = err.status ?? -1;
    out = err.stdout ?? "";
  }
  return { code, out, md: fs.existsSync(summary) ? fs.readFileSync(summary, "utf8") : "" };
}
const lines = (s: string) => s.split(/\r?\n/);
const leaks = (s: string) => MARKERS.filter((m) => s.includes(m));

console.log("\nfailures: one line each, location only");
{
  const r = run("mixed", report([
    fileSuite("43-xapi-resume.spec.ts", "xAPI resume", [
      passed("43-xapi-resume.spec.ts", "seed", 40),
      // Timed out: the timeout error has no location, the pending expect has one (a Linux runner path).
      spec("43-xapi-resume.spec.ts", "browser", 120, [testOf("unexpected", [result("timedOut", [
        {},
        { location: { file: "/home/runner/work/LMS/LMS/tests/bot/lifecycle/43-xapi-resume.spec.ts", line: 151, column: 26 } },
      ])])]),
    ]),
    fileSuite("50-record-guard.spec.ts", null, [
      // No errors[] location: the first tests/ frame of the stack (after a node_modules frame), a Windows path.
      spec("50-record-guard.spec.ts", "guard", 30, [testOf("unexpected", [result("failed", [], [
        `    at fetchIt (${inRepo("node_modules/@supabase/auth-js/dist/main/lib/fetch.js")}:5:9)`,
        "    at C:\\Users\\someone\\LMS\\tests\\bot\\fixtures\\make-packages.mjs:222:9",
      ].join("\n"))])]),
    ]),
    fileSuite("51-no-overwrite.spec.ts", "Overwrite", [
      // Interrupted: counted as skipped, located at its declaration.
      spec("51-no-overwrite.spec.ts", "webhook", 41, [testOf("skipped", [result("interrupted")])]),
    ]),
    fileSuite("52-integrity-check.spec.ts", "Integrity", [
      spec("52-integrity-check.spec.ts", "retry", 80, [testOf("flaky", [
        result("failed", [{ location: { file: inRepo("tests/bot/lifecycle/52-integrity-check.spec.ts"), line: 88, column: 5 } }]),
        result("passed"),
      ])]),
    ]),
    fileSuite("54-course-default.spec.ts", "ADR 0008 B — explicit course default", [
      passed("54-course-default.spec.ts", "seed", 112),
      spec("54-course-default.spec.ts", "Set as default from the Library → moves, audit row; again → noop", 224, [
        testOf("unexpected", [result("failed", [{ location: { file: inRepo("tests/bot/lifecycle/54-course-default.spec.ts"), line: 239, column: 56 } }])]),
      ]),
      // A serial skip after the failure: counted, never listed.
      spec("54-course-default.spec.ts", "Set as default: another organisation", 263, [testOf("skipped", [result("skipped")])]),
    ]),
    fileSuite("55-attempt-row-guard.spec.ts", "Guards", [
      spec("55-attempt-row-guard.spec.ts", `mails ${EMAIL}`, 10, [testOf("unexpected", [result("failed", [{ location: { file: inRepo("tests/bot/lifecycle/55-attempt-row-guard.spec.ts"), line: 11, column: 3 } }])])]),
      spec("55-attempt-row-guard.spec.ts", "any @ hides it", 20, [testOf("unexpected", [result("failed", [{ location: { file: inRepo("tests/bot/lifecycle/55-attempt-row-guard.spec.ts"), line: 21, column: 3 } }])])]),
      spec("55-attempt-row-guard.spec.ts", "token eyJhbGciOi", 30, [testOf("unexpected", [result("failed", [{ location: { file: inRepo("tests/bot/lifecycle/55-attempt-row-guard.spec.ts"), line: 31, column: 3 } }])])]),
      spec("55-attempt-row-guard.spec.ts", "key sb_publishable", 40, [testOf("unexpected", [result("failed", [{ location: { file: inRepo("tests/bot/lifecycle/55-attempt-row-guard.spec.ts"), line: 41, column: 3 } }])])]),
      spec("55-attempt-row-guard.spec.ts", `row ${UUID.toUpperCase()}`, 50, [testOf("unexpected", [result("failed", [{ location: { file: inRepo("tests/bot/lifecycle/55-attempt-row-guard.spec.ts"), line: 51, column: 3 } }])])]),
      spec("55-attempt-row-guard.spec.ts", "line\nbreak", 60, [testOf("unexpected", [result("failed", [{ location: { file: inRepo("tests/bot/lifecycle/55-attempt-row-guard.spec.ts"), line: 61, column: 3 } }])])]),
      // No tests/ candidate: a scoped package prints; a path outside the repository and an
      // email-shaped file name no file of this checkout, so the test's declaration prints.
      spec("55-attempt-row-guard.spec.ts", "in a package", 70, [testOf("unexpected", [result("failed", [{ location: { file: inRepo("node_modules/@supabase/auth-js/dist/main/lib/fetch.js"), line: 5, column: 9 } }])])]),
      spec("55-attempt-row-guard.spec.ts", "outside", 80, [testOf("unexpected", [result("failed", [{ location: { file: "/home/runner/private/lib/x.ts", line: 3, column: 4 } }])])]),
      spec("55-attempt-row-guard.spec.ts", "odd file", 90, [testOf("unexpected", [result("failed", [{ location: { file: "C:/x/jane@example.test.ts", line: 1, column: 2 } }])])]),
      // A message with frame-shaped lines and no real frame: Playwright reports
      // the first of them as errors[0].location, errorLocation and in the stack.
      spec("55-attempt-row-guard.spec.ts", "framed message", 100, [testOf("unexpected", [{
        ...result("failed", [{ location: { file: `/x/tests/${FRAMED[0]}`, line: 1, column: 2 } }],
          `    at /x/tests/${FRAMED[0]}:1:2\n    at ${FRAMED[1]}/${FRAMED[2]}:4:5`),
        errorLocation: { file: `/x/tests/${FRAMED[0]}`, line: 1, column: 2 },
      }])]),
      // A path that climbs out of the repository, even back to a real file of it.
      spec("55-attempt-row-guard.spec.ts", "escape", 110, [testOf("unexpected", [result("failed", [{ location: { file: `${ROOT.replace(/\\/g, "/")}/tests/../../${path.basename(ROOT)}/package.json`, line: 1, column: 1 } }])])]),
    ]),
  ]));
  const out = lines(r.out);
  eq("exit 1 on a failure", r.code, 1);
  eq("headline unchanged", out[0], "lifecycle: 2 passed, 14 failed, 1 flaky, 2 skipped in 6 spec file(s), 61 s; top-level errors 0");
  eq("counts line unchanged", out[6], "  55-attempt-row-guard.spec.ts         passed 0  failed 11  flaky 0  skipped 0");
  eq("section heading after the counts", out[7], "lifecycle: failing tests (location only)");
  const want = [
    "  timedOut    43-xapi-resume.spec.ts › xAPI resume › browser  (tests/bot/lifecycle/43-xapi-resume.spec.ts:151:26)",
    "  failed      50-record-guard.spec.ts › guard  (tests/bot/fixtures/make-packages.mjs:222:9)",
    "  interrupted 51-no-overwrite.spec.ts › Overwrite › webhook  (no error location; test at tests/bot/lifecycle/51-no-overwrite.spec.ts:41:7)",
    "  flaky       52-integrity-check.spec.ts › Integrity › retry  (tests/bot/lifecycle/52-integrity-check.spec.ts:88:5)",
    "  failed      54-course-default.spec.ts › ADR 0008 B — explicit course default › Set as default from the Library → moves, audit row; again → noop  (tests/bot/lifecycle/54-course-default.spec.ts:239:56)",
    "  failed      55-attempt-row-guard.spec.ts › <title redacted>  (tests/bot/lifecycle/55-attempt-row-guard.spec.ts:11:3)",
    "  failed      55-attempt-row-guard.spec.ts › <title redacted>  (tests/bot/lifecycle/55-attempt-row-guard.spec.ts:21:3)",
    "  failed      55-attempt-row-guard.spec.ts › <title redacted>  (tests/bot/lifecycle/55-attempt-row-guard.spec.ts:31:3)",
    "  failed      55-attempt-row-guard.spec.ts › <title redacted>  (tests/bot/lifecycle/55-attempt-row-guard.spec.ts:41:3)",
    "  failed      55-attempt-row-guard.spec.ts › <title redacted>  (tests/bot/lifecycle/55-attempt-row-guard.spec.ts:51:3)",
    "  failed      55-attempt-row-guard.spec.ts › <title redacted>  (tests/bot/lifecycle/55-attempt-row-guard.spec.ts:61:3)",
    "  failed      55-attempt-row-guard.spec.ts › Guards › in a package  (node_modules/@supabase/auth-js/dist/main/lib/fetch.js:5:9)",
    "  failed      55-attempt-row-guard.spec.ts › Guards › outside  (no error location; test at tests/bot/lifecycle/55-attempt-row-guard.spec.ts:80:7)",
    "  failed      55-attempt-row-guard.spec.ts › Guards › odd file  (no error location; test at tests/bot/lifecycle/55-attempt-row-guard.spec.ts:90:7)",
    "  failed      55-attempt-row-guard.spec.ts › Guards › framed message  (no error location; test at tests/bot/lifecycle/55-attempt-row-guard.spec.ts:100:7)",
    "  failed      55-attempt-row-guard.spec.ts › Guards › escape  (no error location; test at tests/bot/lifecycle/55-attempt-row-guard.spec.ts:110:7)",
  ];
  eq("one line per failing test, in report order", out.slice(8, 8 + want.length), want);
  eq("then the skip warning", out[8 + want.length], "::warning title=Lifecycle nightly skipped tests::2 test(s) skipped in 51-no-overwrite.spec.ts, 54-course-default.spec.ts; a healthy run skips none");
  eq("nothing else on stdout", out.length, 8 + want.length + 2);
  eq("stdout: no planted data", leaks(r.out), []);
  eq("stdout: no runner or home path", /home\/runner|Users[\\/]someone|private/.test(r.out), false);

  const md = lines(r.md);
  const at = md.indexOf("### Failing tests (location only)");
  eq("summary: the section follows the table", md[at - 2]?.startsWith("| 55-attempt-row-guard.spec.ts |"), true);
  eq("summary: the same lines as an indented code block", md.slice(at + 2, at + 2 + want.length), want.map((l) => `  ${l}`));
  eq("summary: footer after the section", md[at + 3 + want.length]?.startsWith("Error messages, test output and attachments are not published"), true);
  eq("summary: no planted data", leaks(r.md), []);
}

console.log("\nexit codes and the green path unchanged");
{
  const green = run("green", report([fileSuite("00-engine.spec.ts", "Engine", [passed("00-engine.spec.ts", "a", 10), passed("00-engine.spec.ts", "b", 20)])]));
  eq("green: exit 0", green.code, 0);
  eq("green: headline and counts only", lines(green.out), [
    "lifecycle: 2 passed, 0 failed, 0 flaky, 0 skipped in 1 spec file(s), 61 s; top-level errors 0",
    "  00-engine.spec.ts                    passed 2  failed 0  flaky 0  skipped 0",
    "",
  ]);
  eq("green: no failing section in the summary", green.md.includes("Failing tests"), false);
  eq("green: green footer", green.md.includes("All specs passed against this commit"), true);

  // Interrupted only: counted as skipped, so the summary's exit stays 0 (the
  // nightly fails on Playwright's own exit code), but the line still prints.
  const cut = run("interrupted", report([fileSuite("51-no-overwrite.spec.ts", "Overwrite", [
    passed("51-no-overwrite.spec.ts", "seed", 20),
    spec("51-no-overwrite.spec.ts", "webhook", 41, [testOf("skipped", [result("interrupted")])]),
  ])]));
  eq("interrupted only: exit 0 as before", cut.code, 0);
  eq("interrupted only: listed", cut.out.includes("  interrupted 51-no-overwrite.spec.ts › Overwrite › webhook  (no error location; test at tests/bot/lifecycle/51-no-overwrite.spec.ts:41:7)"), true);

  const top = run("top-errors", report([fileSuite("00-engine.spec.ts", "Engine", [passed("00-engine.spec.ts", "a", 10)])], { errors: [{ message, stack: message }] }));
  eq("top-level error: exit 1", top.code, 1);
  eq("top-level error: counted, not printed", lines(top.out)[0], "lifecycle: 1 passed, 0 failed, 0 flaky, 0 skipped in 1 spec file(s), 61 s; top-level errors 1");
  eq("top-level error: no planted data", leaks(top.out + top.md), []);

  const none = run("none-ran", report([]));
  eq("nothing ran: exit 1", none.code, 1);
  eq("nothing ran: says so", none.out.includes("lifecycle-summary: no test ran"), true);

  eq("missing report: exit 2", run("missing", undefined).code, 2);
  eq("unparsable report: exit 2", run("garbled", undefined, "{ not json").code, 2);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
