#!/usr/bin/env node
/**
 * Counts-only summary of a Playwright JSON report (scripts/lifecycle-nightly.sh).
 *
 *   node scripts/lifecycle-summary.mjs <results.json>
 *
 * Prints totals and per-spec-file counts (passed / failed / flaky / skipped)
 * to stdout and, in GitHub Actions, to the job summary. Never prints test
 * output, error messages or attachments: the repository is public and spec
 * failure messages embed response bodies and test emails.
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

function walk(suite, fileName) {
  for (const spec of suite.specs ?? []) {
    const name = path.basename(spec.file ?? fileName ?? "unknown");
    if (!perFile.has(name)) perFile.set(name, blank());
    const row = perFile.get(name);
    for (const t of spec.tests ?? []) row[STATUS[t.status] ?? "failed"]++;
  }
  for (const child of suite.suites ?? []) walk(child, suite.file ?? fileName);
}
for (const s of report.suites ?? []) walk(s, s.file);

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
    "",
    ok
      ? skipNote
        ? "No test failed, but some were skipped: the run does not cover the whole subset."
        : "All specs passed against this commit, built and started in the runner, on the staging database."
      : "Failure details are not published (public repository). Reproduce with `bash scripts/lifecycle-nightly.sh` against staging.",
  ];
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
}

if (ran === 0) console.log("lifecycle-summary: no test ran");
process.exit(ok ? 0 : 1);
