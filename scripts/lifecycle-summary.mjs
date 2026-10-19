#!/usr/bin/env node
/**
 * Counts-and-locations summary of a Playwright JSON report
 * (scripts/lifecycle-nightly.sh).
 *
 *   node scripts/lifecycle-summary.mjs <results.json>
 *
 * Prints totals and per-spec-file counts (passed / failed / flaky / skipped)
 * to stdout and, in GitHub Actions, to the job summary. Under them, one line
 * per failed, timed-out, interrupted or flaky test: its status, spec file,
 * title path and the file:line:column of its first error (the test's own
 * declaration when no error has one), so a red run names the failing line;
 * a location prints only when it names an existing file of this checkout.
 * Never prints error messages, stack text, test output or attachments: the
 * repository is public and spec failure messages embed response bodies and
 * test emails. Titles are static strings here; one that looks like data
 * (an email, a JWT, a Supabase key, a UUID) prints as `<title redacted>`.
 *
 * Exit 1 when a test failed, the report holds top-level errors (a global
 * setup that threw), or no test ran at all; 2 when the report is missing.
 *
 * Skips: a healthy run of the subset skips nothing (spec 51's server-log
 * case gets LIFECYCLE_SERVER_LOG; the has0098/has0099 probes throw instead
 * of skipping on an environment error). Any skip prints a GitHub
 * `::warning::` annotation and a line in the job summary, so a run that
 * passed with cases skipped is never mistaken for a full pass. Serial
 * skips after a failure already fail the run through the failure.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..").replace(/\\/g, "/");

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.log("lifecycle-summary: no JSON report (Playwright did not start or crashed)");
  process.exit(2);
}

let report;
try {
  report = JSON.parse(fs.readFileSync(file, "utf8"));
} catch {
  console.log("lifecycle-summary: the JSON report does not parse");
  process.exit(2);
}

const STATUS = { expected: "passed", unexpected: "failed", flaky: "flaky", skipped: "skipped" };
const blank = () => ({ passed: 0, failed: 0, flaky: 0, skipped: 0 });
const perFile = new Map();
const failing = [];

// The families redact() masks in scripts/lifecycle-nightly.sh (emails, JWTs,
// Supabase API keys), plus UUIDs (row ids).
const DATA_LIKE = [
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  /eyJ[A-Za-z0-9._-]{10,}/,
  /sb_(secret|publishable)_[A-Za-z0-9_-]+/,
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
];
const looksLikeData = (s) => DATA_LIKE.some((re) => re.test(s));

// A title path holding any "@", "eyJ" or "sb_", data, or a control character
// (which would split the line) is hidden whole, never partly masked.
function safeTitle(titles) {
  const t = titles.filter(Boolean).join(" › ");
  return /[@\p{Cc}]|eyJ|sb_/u.test(t) || looksLikeData(t) ? "<title redacted>" : t;
}

// file:line:column, repository-relative (else from the last tests/ segment,
// else the base name), never a runner or home directory; null unless the
// path names an existing file of this checkout and holds plain path
// characters only. Playwright parses every location it reports out of the
// error's stack, which starts with the message, so a message line shaped
// like a stack frame comes back as a location: only a real file of this
// (public) repository is ever printed, never a path made of message text.
function repoLocation({ file: f, line, column }) {
  let p = String(f);
  if (p.startsWith("file:")) {
    try { p = fileURLToPath(p); } catch { /* left as it is; checked below */ }
  }
  p = p.replace(/\\/g, "/");
  if (p.toLowerCase().startsWith(`${repoRoot.toLowerCase()}/`)) p = p.slice(repoRoot.length + 1);
  else if (p.lastIndexOf("/tests/") >= 0) p = p.slice(p.lastIndexOf("/tests/") + 1);
  else p = path.posix.basename(p);
  p = path.posix.normalize(p);
  if (p === ".." || p.startsWith("../") || !fs.statSync(path.join(repoRoot, p), { throwIfNoEntry: false })?.isFile()) return null;
  const loc = `${p}:${line}:${column ?? 0}`;
  const SEGMENTS = /^@?[A-Za-z0-9._-]+(\/@?[A-Za-z0-9._-]+)*:\d+:\d+$/; // "@" only opens a scoped package
  return SEGMENTS.test(loc) && !looksLikeData(loc) ? loc : null;
}

// "at <file>:<line>:<col>" frames of a stack, as locations. A frame-shaped
// message line is among them, so each is used only through repoLocation().
function stackFrames(stack) {
  const frames = [];
  for (const l of String(stack ?? "").split("\n")) {
    const m = /^\s*at (?:.*\()?(.+?):(\d+):(\d+)\)?\s*$/.exec(l);
    if (m) frames.push({ file: m[1], line: Number(m[2]), column: Number(m[3]) });
  }
  return frames;
}

// One line for a test that failed, timed out, was interrupted or was flaky,
// from its first such result; null for any other test. Of the error
// locations that name a file of this checkout, the first error's wins when
// it is inside tests/ (else the first tests/ frame of its stack, else any of
// them); a result with none (an interrupted test) points at the test's
// declaration.
function failingLine(fileName, titles, spec, t) {
  const res = (t.results ?? []).find((r) => r.status !== t.expectedStatus && r.status !== "skipped");
  if (!res || !(t.status === "unexpected" || t.status === "flaky" || res.status === "interrupted")) return null;
  const [first, ...rest] = res.errors ?? [];
  const candidates = [first?.location, res.errorLocation, ...stackFrames(res.error?.stack), ...rest.map((e) => e?.location)]
    .filter((l) => l?.file && Number.isInteger(l.line))
    .map(repoLocation)
    .filter(Boolean);
  const loc = candidates.find((l) => l.startsWith("tests/")) ?? candidates[0];
  const declared = repoLocation({ file: path.join(report.config?.rootDir ?? "", spec.file ?? fileName), line: spec.line, column: spec.column });
  const where = loc ?? `no error location; test at ${declared ?? "<location redacted>"}`;
  // "passed" only under test.fail(); a status Playwright does not write reads "failed".
  const status = t.status === "flaky" ? "flaky" : ["failed", "timedOut", "interrupted", "passed"].includes(res.status) ? res.status : "failed";
  return `${status.padEnd(11)} ${fileName} › ${safeTitle(titles)}  (${where})`;
}

function walk(suite, fileName, titles) {
  for (const spec of suite.specs ?? []) {
    const name = path.basename(spec.file ?? fileName ?? "unknown");
    if (!perFile.has(name)) perFile.set(name, blank());
    const row = perFile.get(name);
    for (const t of spec.tests ?? []) {
      row[STATUS[t.status] ?? "failed"]++;
      const line = failingLine(name, [...titles, spec.title], spec, t);
      if (line) failing.push(line);
    }
  }
  // The file suite's own title is the file name: the path starts below it.
  for (const child of suite.suites ?? []) walk(child, suite.file ?? fileName, [...titles, child.title]);
}
for (const s of report.suites ?? []) walk(s, s.file, []);

const total = blank();
for (const row of perFile.values()) for (const k of Object.keys(total)) total[k] += row[k];
const topErrors = (report.errors ?? []).length;
const seconds = Math.round((report.stats?.duration ?? 0) / 1000);
const ran = total.passed + total.failed + total.flaky;

const headline =
  `lifecycle: ${total.passed} passed, ${total.failed} failed, ${total.flaky} flaky, ` +
  `${total.skipped} skipped in ${perFile.size} spec file(s), ${seconds} s; top-level errors ${topErrors}`;
console.log(headline);
const names = [...perFile.keys()].sort();
for (const n of names) {
  const r = perFile.get(n);
  console.log(`  ${n.padEnd(36)} passed ${r.passed}  failed ${r.failed}  flaky ${r.flaky}  skipped ${r.skipped}`);
}
if (failing.length) {
  console.log("lifecycle: failing tests (location only)");
  for (const l of failing) console.log(`  ${l}`);
}

const ok = total.failed === 0 && topErrors === 0 && ran > 0;
const skippedFiles = names.filter((n) => perFile.get(n).skipped > 0);
const skipNote =
  total.skipped > 0
    ? `${total.skipped} test(s) skipped in ${skippedFiles.join(", ")}; a healthy run skips none`
    : "";
// A GitHub workflow command: an annotation on the run, a plain line elsewhere.
if (skipNote) console.log(`::warning title=Lifecycle nightly skipped tests::${skipNote}`);
if (process.env.GITHUB_STEP_SUMMARY) {
  const lines = [
    `## Lifecycle nightly ${ok ? (skipNote ? "⚠️" : "✅") : "❌"}`,
    "",
    headline,
    ...(skipNote ? ["", `**Warning:** ${skipNote}.`] : []),
    "",
    "| spec file | passed | failed | flaky | skipped |",
    "|---|---:|---:|---:|---:|",
    ...names.map((n) => {
      const r = perFile.get(n);
      return `| ${n} | ${r.passed} | ${r.failed} | ${r.flaky} | ${r.skipped} |`;
    }),
    // An indented code block: shown verbatim, no Markdown or HTML in a title is rendered.
    ...(failing.length ? ["", "### Failing tests (location only)", "", ...failing.map((l) => `    ${l}`)] : []),
    "",
    ok
      ? skipNote
        ? "No test failed, but some were skipped: the run does not cover the whole subset."
        : "All specs passed against this commit, built and started in the runner, on the staging database."
      : "Error messages, test output and attachments are not published (public repository). Reproduce with `bash scripts/lifecycle-nightly.sh` against staging.",
  ];
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
}

if (ran === 0) console.log("lifecycle-summary: no test ran");
process.exit(ok ? 0 : 1);
