/**
 * Guard for .github/workflows/content-backup.yml (ADR 0003 step 2). The repository
 * is public, so its run logs and job summaries are public, and the nightly must
 * keep its flags while the restore drill stays read-only.
 *
 *   - the workflow text: a scheduled run takes the copy, a drill run takes the
 *     drill; no run block holds an expression; drill_prefix is read from the event
 *     file and sits in no step's env, because GitHub prints a step's env in the
 *     public log; the drill's rclone commands cannot write to a remote;
 *   - the copy step, fed a log whose keys hold markers: 0 markers in stdout and
 *     the summary, and exact counts for each error class;
 *   - the drill step on canned listings: what fails it, what passes it, and a
 *     rejected drill_prefix stopping before rclone is called;
 *   - the preflight step, with the real curl and jq, against a stand-in on
 *     127.0.0.1 that answers in the shapes of Backblaze's v4 API: every way the key
 *     or the lock can be wrong fails with a fixed line and no rclone call, and
 *     nothing marked in an answer or a secret reaches stdout, stderr or the summary.
 *
 * The run blocks are taken from the workflow byte for byte and run with a fake
 * rclone first on PATH, so this needs bash with grep, awk, jq and curl, as the CI
 * runner has. Without them, off CI only, those cases are skipped and say so.
 *
 * Run:  npx tsx tests/unit/content-backup-workflow.test.ts   (or npm run test:unit)
 * (No DB. A curl wrapper first on PATH points Backblaze's two addresses at the
 * stand-in and refuses any other address that names backblazeb2. Any other
 * address goes to the real curl: this file names only .invalid hosts of that
 * kind, and the step refuses them without calling them.)
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const root = path.resolve(__dirname, "../..");
const yml = fs.readFileSync(path.join(root, ".github/workflows/content-backup.yml"), "utf8").replace(/\r\n/g, "\n");

// ── The steps, by a line reading of the job's fixed indentation ─────────────
type Step = { name: string; cond: string | null; env: Record<string, string>; run: string };
function readSteps(text: string): Step[] {
  const steps: Step[] = [];
  let cur: Step | null = null;
  let mode: "env" | "run" | null = null;
  for (const line of text.split("\n")) {
    const start = line.match(/^ {6}- name: (.*)$/);
    if (start) { cur = { name: start[1], cond: null, env: {}, run: "" }; steps.push(cur); mode = null; continue; }
    if (!cur) continue;
    if (mode === "run") {
      if (line.startsWith(" ".repeat(10)) || line.trim() === "") { cur.run += line.slice(10) + "\n"; continue; }
      mode = null;
    }
    const cond = line.match(/^ {8}if: (.*)$/);
    if (cond) { cur.cond = cond[1]; continue; }
    if (/^ {8}env:$/.test(line)) { mode = "env"; continue; }
    if (/^ {8}run: \|$/.test(line)) { mode = "run"; continue; }
    const entry = line.match(/^ {10}([A-Z0-9_]+): (.*)$/);
    if (mode === "env" && entry) cur.env[entry[1]] = entry[2];
  }
  return steps;
}
const steps = readSteps(yml);
const step = (prefix: string): Step => {
  const s = steps.find((x) => x.name.startsWith(prefix));
  if (!s) throw new Error(`no step named ${prefix}`);
  return s;
};
const copy = step("Copy Supabase");
const drill = step("Restore drill");
const counter = step("Write the public-safe");
// Not step(): a missing step fails its own assertion and each case below, one by one.
const preflight: Step = steps.find((x) => x.name.startsWith("Preflight")) ?? { name: "Preflight", cond: null, env: {}, run: "" };
const unquoted = (v: string | undefined) => (v ?? "").replace(/^"|"$/g, "");

console.log("the workflow text");
eq("step order: the preflight runs before rclone is fetched", steps.map((s) => s.name.split(" ")[0]), ["Check", "Preflight", "Install", "Write", "Copy", "Restore"]);
eq("a scheduled run has no inputs, so it takes the copy", copy.cond, "${{ !inputs.restore_drill }}");
eq("the drill runs only when asked", drill.cond, "${{ inputs.restore_drill }}");
eq("no other step has a condition", steps.filter((s) => s.cond).length, 2);
eq("nothing runs on after a failed step", /continue-on-error|always\(\)|failure\(\)/.test(yml), false);
eq("no run block holds an expression", steps.filter((s) => s.run.includes("${{")).map((s) => s.name), []);
eq("secrets reach only the check, the preflight, the copy and the drill",
  steps.filter((s) => Object.values(s.env).some((v) => v.includes("secrets."))).map((s) => s.name.split(" ")[0]),
  ["Check", "Preflight", "Copy", "Restore"]);
eq("drill_prefix is in no step's env: GitHub prints a step's env in the public log", steps.filter((s) => "DRILL_PREFIX" in s.env).map((s) => s.name), []);
eq("no expression reads it", /\$\{\{[^}]*drill_prefix/.test(yml), false);
eq("the drill reads it from the event file", drill.run.includes(`DRILL_PREFIX="$(jq -r '.inputs.drill_prefix // ""' "$GITHUB_EVENT_PATH")"`), true);
eq("before the validation", drill.run.includes("$GITHUB_EVENT_PATH") && drill.run.indexOf("$GITHUB_EVENT_PATH") < drill.run.indexOf("=~ ^${shape}$"), true);
eq("the drill's remotes are the copy's",
  drill.env,
  Object.fromEntries(Object.entries(copy.env).filter(([k]) => k !== "DRY_RUN")));
eq("the copy signs for B2_REGION", copy.env.RCLONE_CONFIG_B2_REGION, "${{ secrets.B2_REGION }}");
eq("the drill signs for B2_REGION", drill.env.RCLONE_CONFIG_B2_REGION, "${{ secrets.B2_REGION }}");

console.log("\nthe nightly keeps its flags");
eq("copy, never sync", copy.run.includes('rclone copy "supa:course-content" "$dest" "${flags[@]}" > "$log" 2>&1'), true);
eq("the comparison and age flags", copy.run.includes("--immutable --checksum --min-age 1h --use-server-modtime --fast-list"), true);
eq("the destination", copy.run.includes('dest="b2:${B2_CONTENT_BUCKET}/content/prod/supabase/course-content"'), true);
eq("the dry run's flag", copy.run.includes("flags+=(--dry-run)"), true);
eq("no sync anywhere in a command", /^\s*rclone sync\b/m.test(yml), false);
eq("no HEAD per object uploaded", /--s3-no-check-bucket --s3-no-head$/m.test(copy.run), true);
eq("rclone size writes its errors to the file, not the public log", copy.run.includes('rclone size "$dest" --fast-list 2>> "$log"'), true);

console.log("\nthe drill cannot write to a remote");
const drillCommands = drill.run.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("rclone "));
eq("its only rclone commands", drillCommands.map((l) => l.split(" ").slice(0, 2).join(" ")), ['rclone "${listing[@]}"', "rclone copy", "rclone check"]);
eq("the listing is lsf", /listing=\(lsf -R --files-only --fast-list /.test(drill.run), true);
eq("the one copy's destination is the runner's folder", drill.run.includes('rclone copy "${backup_root}/${chosen}" "$restored" '), true);
eq("the restored folder is under RUNNER_TEMP", /^restored="\$work\/restored"$/m.test(drill.run) && /^work="\$RUNNER_TEMP\/restore-drill"$/m.test(drill.run), true);
eq("the comparison downloads, one way: an object only on the backup is not a failure", /rclone check "\$\{source_root\}\/\$\{chosen\}" "\$restored" --download --one-way /.test(drill.run), true);
eq("each command writes to a file, never the log", drillCommands.every((l) => /\s>>? "\$/.test(l)), true);
eq("--min-age on the source listing only", (drill.run.match(/--min-age/g) ?? []).length, 1);
eq("that listing is the source's", drill.run.includes('read_listing "$work/source-due.tsv" --min-age 1h "$source_root"'), true);

console.log("\nthe preflight step's text");
eq("the step exists", preflight.run !== "", true);
eq("it uses the copy's key id", preflight.env.B2_KEY_ID, copy.env.RCLONE_CONFIG_B2_ACCESS_KEY_ID);
eq("it uses the copy's application key", preflight.env.B2_APPLICATION_KEY, copy.env.RCLONE_CONFIG_B2_SECRET_ACCESS_KEY);
eq("the expected mode stands in its env", unquoted(preflight.env.EXPECT_RETENTION_MODE), "governance");
eq("the expected days stand in its env", unquoted(preflight.env.EXPECT_RETENTION_DAYS), "90");
eq("it signs in by the v4 path", preflight.run.includes("https://api.backblazeb2.com/b2api/v4/b2_authorize_account"), true);
eq("it lists by the v4 path", preflight.run.includes("/b2api/v4/b2_list_buckets"), true);
const curlLines = preflight.run.split("\n").filter((l) => /(^\s*|[|;&]\s*|\$\(\s*)curl\b/.test(l));
eq("one curl command", curlLines.length, 1);
eq("options and credentials go on stdin", curlLines.every((l) => /\| curl --disable --config - /.test(l)), true);
eq("its stderr is dropped: curl names the address there", curlLines.every((l) => l.includes("2>/dev/null")), true);
eq("it has a time limit", curlLines.every((l) => /--connect-timeout \d+ --max-time \d+ /.test(l)), true);
eq("the limit is the 30 seconds the PR text states", curlLines.every((l) => l.includes("--connect-timeout 10 --max-time 30 ")), true);
eq("no credential in curl's arguments", curlLines.some((l) => /B2_KEY_ID|B2_APPLICATION_KEY|token/.test(l)), false);
eq("the token reaches no later step", /GITHUB_ENV|GITHUB_OUTPUT|\bexport\b(?! LC_ALL=C)/.test(preflight.run), false);
eq("the token is masked", preflight.run.includes('echo "::add-mask::${token}"'), true);
eq("the account id is masked", preflight.run.includes('echo "::add-mask::${account}"'), true);
eq("no trace of the script", /set -[a-z]*x/.test(preflight.run), false);
eq("curl follows no redirect, so the token goes where it was checked", /--location|\s-L/.test(preflight.run), false);

console.log("\nthe header");
const headerLines = yml.slice(0, yml.indexOf("name: Nightly"));
for (const name of ["SUPABASE_S3_ENDPOINT", "SUPABASE_S3_REGION", "SUPABASE_S3_ACCESS_KEY_ID", "SUPABASE_S3_SECRET_ACCESS_KEY", "B2_CONTENT_BUCKET", "B2_CONTENT_KEY_ID", "B2_CONTENT_APPLICATION_KEY"]) {
  eq(`lists ${name} as required`, new RegExp(`^#   ${name}\\b`, "m").test(headerLines), true);
}
const header = headerLines.replace(/\n#\s*/g, " ");
eq("says the key is made by API, and why", /made through the API because the console's Read and Write holds bypassGovernance/.test(header), true);
eq("says to change the expected mode and days with the bucket", /change EXPECT_RETENTION_MODE and EXPECT_RETENTION_DAYS with the bucket/i.test(header), true);
eq("says --s3-no-head's cost and what still compares", /--s3-no-head/.test(header) && /compared the next night/.test(header), true);
eq("says a drill is no restored course", /no course is launched from the restored files/.test(header), true);
eq("says a hidden file looks missing and its version remains", /hidden file looks missing/.test(header) && /version remains/.test(header), true);

// ── The run blocks, with a fake rclone first on PATH ────────────────────────
const probe = spawnSync("bash", ["-c", "for t in grep awk jq curl; do command -v $t >/dev/null || exit 1; done; echo ok"], { encoding: "utf8" });
const hasBash = probe.status === 0 && probe.stdout.trim() === "ok";
if (!hasBash) {
  console.log("\nbash with grep, awk, jq and curl is not on PATH: the run blocks were NOT exercised");
  eq("skipped only off CI", Boolean(process.env.CI), false);
} else {
  const slash = (p: string) => p.replace(/\\/g, "/");
  const base = slash(fs.mkdtempSync(path.join(os.tmpdir(), "content-backup-")));
  const bin = `${base}/bin`;
  fs.mkdirSync(bin);
  // lsf: the canned listings. copy: one file per expected object. check: the canned report.
  // A log file, when FAKE_LOG is set, stands for a failed copy: it goes to the step's own log.
  fs.writeFileSync(`${bin}/rclone`, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_DIR/calls.txt"
if [ -n "\${FAKE_LOG:-}" ]; then cat "$FAKE_LOG"; exit 1; fi
case "$1" in
  lsf)
    case "$*" in
      *--min-age*) cat "$FAKE_DIR/source-due.tsv" ;;
      *supa:*) cat "$FAKE_DIR/source.tsv" ;;
      *) cat "$FAKE_DIR/backup.tsv" ;;
    esac
    exit "\${FAKE_LSF_RC:-0}" ;;
  copy)
    case "$3" in b2:*) exit "\${FAKE_COPY_RC:-0}" ;; esac
    mkdir -p "$3"
    for i in $(seq 1 "\${FAKE_COPY_FILES:-1}"); do printf 'x' > "$3/restored-$i.bin"; done
    exit "\${FAKE_COPY_RC:-0}" ;;
  size)
    echo "Total objects: 3"
    echo "2026/11/05 08:47:44 NOTICE: MARKER-size-notice" >&2
    if [ -n "\${FAKE_SIZE_RC:-}" ]; then echo "2026/11/05 08:47:44 Failed to size: Get \"https://s3.example.invalid/MARKER-url\"" >&2; exit "$FAKE_SIZE_RC"; fi
    exit 0 ;;
  check)
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--combined" ]; then cat "$FAKE_DIR/combined.txt" > "$2"; fi
      shift
    done
    exit "\${FAKE_CHECK_RC:-0}" ;;
esac
`, { mode: 0o755 });

  let caseNo = 0;
  const sandbox = () => {
    const dir = `${base}/case${++caseNo}`;
    fs.mkdirSync(`${dir}/tmp`, { recursive: true });
    fs.writeFileSync(`${dir}/summary.md`, "");
    fs.writeFileSync(`${dir}/calls.txt`, "");
    for (const f of ["source.tsv", "source-due.tsv", "backup.tsv", "combined.txt"]) fs.writeFileSync(`${dir}/${f}`, "");
    return dir;
  };
  const runBlock = (dir: string, s: Step, env: Record<string, string>, event: unknown = {}) => {
    const file = `${dir}/${s.name.split(" ")[0]}.sh`;
    fs.writeFileSync(file, s.run);
    fs.writeFileSync(`${dir}/event.json`, JSON.stringify(event));
    return spawnSync("bash", ["--noprofile", "--norc", "-e", file], {
      encoding: "utf8",
      timeout: 120_000,
      env: {
        ...process.env,
        PATH: `${path.resolve(bin)}${path.delimiter}${process.env.PATH ?? ""}`,
        LC_ALL: "C",
        RUNNER_TEMP: `${dir}/tmp`,
        GITHUB_STEP_SUMMARY: `${dir}/summary.md`,
        GITHUB_EVENT_PATH: `${dir}/event.json`,
        FAKE_DIR: dir,
        B2_CONTENT_BUCKET: "bucket",
        ...env,
      },
    });
  };
  const prepared = () => {
    const dir = sandbox();
    eq("the counter step runs", runBlock(dir, counter, {}).status, 0);
    return dir;
  };
  const summaryOf = (dir: string) => fs.readFileSync(`${dir}/summary.md`, "utf8");
  const classesIn = (text: string) => (text.match(/Log lines per error class: ([^\n]*?)\.?\n/) ?? [])[1]?.split(" ").sort() ?? [];

  const FOLDER = "courses/11111111-2222-4333-8444-555555555555/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/v2/";
  const OTHER = "courses/11111111-2222-4333-8444-555555555555/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/v1/";

  console.log("\nthe copy step, fed a log whose keys hold markers (the shapes of rclone v1.68.2)");
  {
    const dir = prepared();
    const log = `${dir}/fed.log`;
    const stamp = "2026/11/05 08:47:44";
    fs.writeFileSync(log, [
      `${stamp} ERROR : ${FOLDER}MARKER-a.html: Failed to copy: operation error S3: PutObject, https response error StatusCode: 400, RequestID: MARKER-req, HostID: MARKER-host, api error BadDigest: The Content-MD5 you specified did not match what we received.`,
      `${stamp} ERROR : loose/MARKER-AccessDenied-403.html: Failed to copy: operation error S3: PutObject, https response error StatusCode: 403, RequestID: , HostID: , api error AccessDenied: Access Denied`,
      `${stamp} ERROR : ${FOLDER}MARKER-b.html: Failed to copy: operation error S3: PutObject, https response error StatusCode: 0, RequestID: , HostID: , request send failed, Put "https://s3.example.invalid/bucket/MARKER-url": dial tcp: lookup s3.example.invalid: no such host`,
      `${stamp} ERROR : ${FOLDER}MARKER-c.html: Failed to copy: request send failed, Get "https://s3.example.invalid/MARKER-url": net/http: timeout awaiting response headers`,
      `${stamp} ERROR : ${FOLDER}MARKER-d.html: Failed to copy: dial tcp 192.0.2.1:443: connect: connection refused`,
      `${stamp} ERROR : ${FOLDER}MARKER-e.html: Source and destination exist but do not match: immutable file modified`,
      `${stamp} ERROR : loose/MARKER-f.html: a failure no class knows MARKER-text`,
      `${stamp} ERROR : ${FOLDER}MARKER-g.html: Failed to copy: operation error S3: PutObject, https response error StatusCode: 418, RequestID: , HostID: , api error MARKER-name: MARKER-message`,
      `${stamp} ERROR : Attempt 1/3 failed with 8 errors and: immutable file modified`,
      `${stamp} ERROR : Can't retry any of the errors - not attempting retries`,
      `${stamp} NOTICE: Failed to copy: MARKER-fatal`,
      `${stamp} ERROR : ${FOLDER}MARKER-h.html: file not in Local file system at /tmp/MARKER-dir`,
      `${stamp} NOTICE: Failed to check with 5 errors: last error was: 5 differences found`,
      "",
    ].join("\n"));
    const r = runBlock(dir, copy, { DRY_RUN: "false", FAKE_LOG: log });
    const out = r.stdout + r.stderr;
    const summary = summaryOf(dir);
    eq("the step fails", r.status, 1);
    eq("0 markers in stdout", (out.match(/MARKER/g) ?? []).length, 0);
    eq("0 markers in the summary", (summary.match(/MARKER/g) ?? []).length, 0);
    const want = ["AccessDenied=1", "BadDigest=1", "api_error_other=1", "connection_refused=1", "content_md5=1", "http_400=1", "http_403=1", "http_other=1", "no_such_host=1", "timeout=1", "unclassified=2"];
    eq("the classes in stdout", classesIn(out), want);
    eq("the classes in the summary", classesIn(summary), want);
    eq("the conflict still counts by itself", /immutable conflicts 1;/.test(out), true);
    eq("and by its folder alone", summary.includes(`| \`${FOLDER}\` | 1 |`), true);
  }
  {
    const dir = prepared();
    const log = `${dir}/fed.log`;
    fs.writeFileSync(log, "");
    const r = runBlock(dir, copy, { DRY_RUN: "false", FAKE_LOG: log });
    eq("an empty log reads as none", classesIn(r.stdout + summaryOf(dir)).filter((x) => x === "none").length, 1);
  }

  {
    const dir = prepared();
    const log = `${dir}/fed.log`;
    fs.writeFileSync(log, `2026/11/05 08:47:44 CRITICAL: Failed to create file system for "supa:MARKER-bucket": MARKER-reason\n`);
    const r = runBlock(dir, copy, { DRY_RUN: "false", FAKE_LOG: log });
    eq("a fatal rclone line counts as unclassified, never none", classesIn(r.stdout), ["unclassified=1"]);
    eq("and is not printed", /MARKER/.test(r.stdout + r.stderr + summaryOf(dir)), false);
  }

  console.log("\nthe copy step's table prints only a folder the drill accepts");
  {
    const dir = prepared();
    const log = `${dir}/fed.log`;
    const keys = [
      `${FOLDER}a.html`,
      "courses/backup-drill/test/v1/a.txt",
      "courses/MARKER board minutes.pdf/x/v1/real.html",
      "courses/MARKER/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/v1/real.html",
      "courses/11111111-2222-4333-8444-555555555555/MARKER/v1/real.html",
      "courses/backup-drill/test/v2/MARKER.txt",
      "courses/backup-drill/MARKER/v1/real.txt",
      "MARKER-loose.txt",
    ];
    fs.writeFileSync(log, keys.map((k) => `2026/11/05 08:47:44 ERROR : ${k}: Source and destination exist but do not match: immutable file modified\n`).join(""));
    const r = runBlock(dir, copy, { DRY_RUN: "false", FAKE_LOG: log });
    const summary = summaryOf(dir);
    const rows = summary.split("\n").filter((l) => l.startsWith("| `")).sort();
    eq("the rows", rows, [`| \`(other)\` | 6 |`, `| \`${FOLDER}\` | 1 |`, "| `courses/backup-drill/test/v1/` | 1 |"].sort());
    eq("0 markers in the summary", /MARKER/.test(summary), false);
    eq("0 markers in stdout", /MARKER/.test(r.stdout + r.stderr), false);
  }

  console.log("\nthe copy step after a clean copy: rclone size");
  {
    const dir = prepared();
    const r = runBlock(dir, copy, { DRY_RUN: "false" });
    eq("a clean copy passes", r.status, 0);
    eq("the totals still print", r.stdout.includes("Total objects: 3"), true);
    eq("rclone's own notice stays out of the public log", /MARKER/.test(r.stdout + r.stderr), false);
    eq("the real copy skips the HEAD per object", /^copy supa:course-content .*--s3-no-head/m.test(fs.readFileSync(`${dir}/calls.txt`, "utf8")), true);
  }
  {
    const dir = prepared();
    const r = runBlock(dir, copy, { DRY_RUN: "false", FAKE_SIZE_RC: "1" });
    eq("rclone size fails: the step fails", r.status, 1);
    eq("rclone size fails: no raw line in the public log", /MARKER|example\.invalid/.test(r.stdout + r.stderr + summaryOf(dir)), false);
  }

  console.log("\na rejected drill_prefix stops before rclone and is not printed");
  const bad = [
    "MARKER",
    `courses/MARKER/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/v1/`,
    `courses/11111111-2222-4333-8444-555555555555/MARKER/v1/`,
    FOLDER.slice(0, -1),
    FOLDER.replace("/v2/", "/v0/"),
    `${FOLDER}MARKER`,
    `${FOLDER}/`,
    `/${FOLDER}`,
    `../${FOLDER}`,
    FOLDER.toUpperCase().replace("COURSES", "courses").replace("/V2/", "/v2/"),
    `${FOLDER} `,
    `${FOLDER}\nMARKER`,
    "$(echo MARKER)",
    "`echo MARKER`",
    "::error::MARKER",
    // Beside the uuid shape, exactly one test folder: these are near misses of it.
    "courses/backup-drill/test/v2/",
    "courses/backup-drill/test/v1",
    "courses/backup-drill/test/v1/MARKER",
    "courses/backup-drill/MARKER/v1/",
    "courses/backup-drill/other/v1/",
    "courses/other/test/v1/",
    "courses/MARKER/test/v1/",
    "../courses/backup-drill/test/v1/",
    "courses/backup-drill/test/v1/\nMARKER",
    "courses/backup-drill/test/v1/$(echo MARKER)",
    "courses/backup-drill/test/v1//",
  ];
  for (const value of bad) {
    const dir = prepared();
    const r = runBlock(dir, drill, {}, { inputs: { drill_prefix: value } });
    eq(`refused: ${JSON.stringify(value)}`, r.status, 1);
    eq("  rclone was not called", fs.readFileSync(`${dir}/calls.txt`, "utf8"), "");
    eq("  the value is not printed", /MARKER/.test(r.stdout + r.stderr + summaryOf(dir)), false);
    eq("  it says why", /drill_prefix is not courses\//.test(r.stdout), true);
  }
  {
    const dir = prepared();
    const r = runBlock(dir, drill, {}, { inputs: { drill_prefix: 5 } });
    eq("refused: a number in the event file", r.status, 1);
    eq("  rclone was not called", fs.readFileSync(`${dir}/calls.txt`, "utf8"), "");
  }
  {
    // A trailing newline is dropped by the read; what is left is validated like any other value.
    const dir = prepared();
    const r = runBlock(dir, drill, {}, { inputs: { drill_prefix: `${FOLDER}\n` } });
    eq("a trailing newline: read as the folder itself", r.stdout.includes(`the folder \`${FOLDER}\` is not on the backup`), true);
  }
  for (const [what, event] of [["a schedule's event, no inputs", { schedule: "30 2 * * *" }], ["no drill_prefix", { inputs: { restore_drill: "true" } }], ["an empty drill_prefix", { inputs: { drill_prefix: "" } }]] as const) {
    const dir = prepared();
    const r = runBlock(dir, drill, {}, event);
    eq(`${what}: the job chooses`, r.status, 0);
    eq(`${what}: nothing refused`, /drill_prefix is not courses\//.test(r.stdout), false);
  }

  console.log("\nthe drill on canned listings");
  const a = `${FOLDER}a.html`, b = `${FOLDER}b.html`, c = `${OTHER}c.html`;
  const tsv = (...rows: [number, string][]) => rows.map(([size, key]) => `${size}\t${key}\n`).join("");
  type Listing = { source?: string; due?: string; backup?: string; combined?: string; prefix?: string; env?: Record<string, string> };
  const runDrill = (l: Listing) => {
    const dir = prepared();
    fs.writeFileSync(`${dir}/source.tsv`, l.source ?? "");
    fs.writeFileSync(`${dir}/source-due.tsv`, l.due ?? l.source ?? "");
    fs.writeFileSync(`${dir}/backup.tsv`, l.backup ?? "");
    fs.writeFileSync(`${dir}/combined.txt`, l.combined ?? "");
    const r = runBlock(dir, drill, { ...l.env }, { inputs: { drill_prefix: l.prefix ?? "" } });
    return { status: r.status, out: r.stdout + r.stderr, summary: summaryOf(dir), calls: fs.readFileSync(`${dir}/calls.txt`, "utf8") };
  };
  const all = tsv([10, a], [20, b], [5, c]);
  const same = "= a.html\n= b.html\n";
  {
    const r = runDrill({ source: all, backup: all, combined: same, env: { FAKE_COPY_FILES: "2" } });
    eq("clean: passes", r.status, 0);
    eq("clean: the folder with most objects", r.out.includes(`Byte comparison of \`${FOLDER}\`: downloaded from B2 to the runner 2 objects, 2 bytes; byte-identical to the live folder 2; differing 0; only live 0; only on the backup 0 `), true);
    eq("clean: says so in the summary", r.summary.includes("Restore drill passed"), true);
    eq("clean: three listings, one copy, one comparison", r.calls.split("\n").filter(Boolean).map((l) => l.split(" ")[0]).sort(), ["check", "copy", "lsf", "lsf", "lsf"]);
  }
  {
    const r = runDrill({ source: all, backup: tsv([10, a], [20, b]), combined: same });
    eq("one missing: fails", r.status, 1);
    eq("one missing: counted", r.out.includes("missing on the backup 1; differing by size 0"), true);
    eq("one missing: the other folder is still compared", r.out.includes(`Byte comparison of \`${FOLDER}\``), true);
  }
  {
    const r = runDrill({ source: all, backup: tsv([10, a], [21, b], [5, c]), combined: "= c.html\n" });
    eq("a size differs: fails", r.status, 1);
    eq("a size differs: counted", r.out.includes("missing on the backup 0; differing by size 1"), true);
    eq("a size differs: that folder is not the one downloaded", r.out.includes(`Byte comparison of \`${OTHER}\``), true);
  }
  {
    const r = runDrill({ source: all, backup: all, combined: "= a.html\n* b.html\n" });
    eq("a byte differs: fails", r.status, 1);
    eq("a byte differs: counted", r.out.includes("byte-identical to the live folder 1; differing 1"), true);
  }
  {
    const r = runDrill({ source: all, backup: all, combined: "= a.html\n" });
    eq("fewer objects compared than listed: fails", r.status, 1);
  }
  // Each of these alone, with every listed object compared identical, still fails.
  for (const [what, line] of [["differs", "* x.html"], ["only live", "+ x.html"], ["a read error", "! x.html"]]) {
    const r = runDrill({ source: all, backup: all, combined: `${same}${line}\n` });
    eq(`one more object, ${what}: fails`, r.status, 1);
    eq(`one more object, ${what}: says so`, r.out.includes("did not come back byte for byte"), true);
  }
  {
    // The copy never deletes, so an object only on the backup fails nothing, named or not.
    const r = runDrill({ source: all, backup: all, combined: `${same}- x.html\n` });
    eq("one more object, only on the backup: passes", r.status, 0);
  }
  {
    const r = runDrill({ source: all, backup: all + tsv([7, `${OTHER}swept.html`]), combined: "= c.html\n", prefix: OTHER, env: { FAKE_COPY_FILES: "2" } });
    eq("named, an object only on the backup: passes", r.status, 0);
    eq("named, an object only on the backup: counted", r.out.includes("byte-identical to the live folder 1; differing 0; only live 0; only on the backup 1 "), true);
  }
  {
    const r = runDrill({ source: all + tsv([6, `${OTHER}more.html`]), backup: all + tsv([7, `${OTHER}swept.html`]), combined: "= c.html\n+ more.html\n", prefix: OTHER, env: { FAKE_COPY_FILES: "2" } });
    eq("named, an object only live and one only on the backup: fails", r.status, 1);
    eq("named, an object only live and one only on the backup: says so", r.out.includes("did not come back byte for byte"), true);
  }
  {
    const r = runDrill({ source: all, backup: all, combined: "= c.html\n* d.html\n", prefix: OTHER, env: { FAKE_COPY_FILES: "2" } });
    eq("named, a byte differs: fails", r.status, 1);
  }
  {
    const r = runDrill({ source: all, backup: all, combined: "", prefix: OTHER, env: { FAKE_COPY_FILES: "2" } });
    eq("named, nothing compared: fails", r.status, 1);
  }
  {
    const r = runDrill({ source: all, backup: all, combined: same, env: { FAKE_COPY_RC: "1" } });
    eq("a download that fails: fails", r.status, 1);
    eq("a download that fails: its exit code", r.out.includes("rclone exit codes: download 1, comparison 0"), true);
  }
  {
    const r = runDrill({ source: all, backup: all, combined: same, env: { FAKE_CHECK_RC: "1" } });
    eq("a comparison that fails: fails", r.status, 1);
    eq("a comparison that fails: its exit code", r.out.includes("rclone exit codes: download 0, comparison 1"), true);
  }
  {
    const r = runDrill({ source: all, backup: all, combined: same, env: { FAKE_LSF_RC: "3" } });
    eq("a listing that fails: fails", r.status, 1);
    eq("a listing that fails: never reads as empty", r.out.includes("a listing failed (rclone exit code 3)"), true);
    eq("a listing that fails: nothing downloaded", /^copy /m.test(r.calls), false);
  }
  {
    const r = runDrill({ source: all, due: tsv([10, a], [5, c]), backup: tsv([10, a], [5, c]), combined: "= c.html\n" });
    eq("under an hour old and not copied yet: passes", r.status, 0);
    eq("under an hour old: counted, not missing", r.out.includes("missing on the backup 0; differing by size 0; under an hour old and not copied yet 1"), true);
    eq("under an hour old: that folder is not the one downloaded", r.out.includes(`Byte comparison of \`${OTHER}\``), true);
  }
  {
    const r = runDrill({ source: tsv([10, a]), due: "", backup: "" });
    eq("only objects under an hour old: passes", r.status, 0);
    eq("only objects under an hour old: nothing proven", r.out.includes("Nothing was proven about restoring a file"), true);
    eq("only objects under an hour old: nothing downloaded", /^copy /m.test(r.calls), false);
  }
  {
    // Objects are due and no folder could be compared: green would read as a proven restore.
    const stray = tsv([10, "loose/x.html"]);
    const r = runDrill({ source: stray, backup: stray });
    eq("objects due, all outside a version folder: fails", r.status, 1);
    eq("objects due, all outside a version folder: says why", r.out.includes("the live bucket holds objects that are due, and none could be compared byte for byte"), true);
    eq("objects due, all outside a version folder: nothing downloaded", /^copy /m.test(r.calls), false);
  }
  {
    const odd = tsv([10, "courses/MARKER/x/v1/a.html"]);
    const r = runDrill({ source: odd, backup: odd });
    eq("objects due, only a folder of another shape: fails", r.status, 1);
    eq("objects due, only a folder of another shape: nothing downloaded", /^copy /m.test(r.calls), false);
    eq("objects due, only a folder of another shape: not printed", /MARKER/.test(r.out + r.summary), false);
  }
  {
    const r = runDrill({ source: tsv([10, a]), backup: tsv([10, a], [7, `${FOLDER}gone.html`]) });
    eq("objects due, every folder skipped: fails", r.status, 1);
    eq("objects due, every folder skipped: says why", r.out.includes("none could be compared byte for byte"), true);
    eq("objects due, every folder skipped: the message is true", r.out.includes("no courses/<course id>/<package id>/v<n>/ folder has matching listings and every object over an hour old"), true);
  }
  {
    const r = runDrill({ source: all, backup: all + tsv([7, `${OTHER}swept.html`]), combined: same });
    eq("an object only on the backup: passes", r.status, 0);
    eq("an object only on the backup: counted", r.out.includes("only on the backup 1 "), true);
    eq("an object only on the backup: its folder is not the one downloaded", r.out.includes(`Byte comparison of \`${FOLDER}\``), true);
  }
  {
    const r = runDrill({});
    eq("both empty: passes", r.status, 0);
    eq("both empty: says nothing was proven", r.out.includes("both empty. Nothing was proven"), true);
    eq("both empty: in the summary too", r.summary.includes("both empty. Nothing was proven"), true);
    eq("both empty: nothing downloaded", /^(copy|check) /m.test(r.calls), false);
  }
  {
    const r = runDrill({ backup: all });
    eq("live empty, backup not: fails", r.status, 1);
    eq("live empty, backup not: says so", r.out.includes("the live bucket is empty but the backup holds 3 objects"), true);
    eq("live empty, backup not: names test files just removed", /test files .*removed/.test(r.out), true);
  }
  {
    const r = runDrill({ source: all, backup: "" });
    eq("backup empty, live not: fails", r.status, 1);
    eq("backup empty, live not: all missing", r.out.includes("missing on the backup 3"), true);
  }
  {
    const r = runDrill({ source: all, backup: all, combined: "= c.html\n", prefix: OTHER });
    eq("named: passes", r.status, 0);
    eq("named: that folder", r.out.includes(`Byte comparison of \`${OTHER}\``), true);
  }
  {
    const TEST_FOLDER = "courses/backup-drill/test/v1/";
    const files = tsv([5, `${TEST_FOLDER}tiny.txt`], [10485760, `${TEST_FOLDER}ten.bin`]);
    const compared = "= tiny.txt\n= ten.bin\n";
    const chosen = runDrill({ source: files, backup: files, combined: compared, env: { FAKE_COPY_FILES: "2" } });
    eq("the test folder: the job can choose it", chosen.status, 0);
    eq("the test folder: compared byte for byte", chosen.out.includes(`Byte comparison of \`${TEST_FOLDER}\``), true);
    const named = runDrill({ source: files, backup: files, combined: compared, prefix: TEST_FOLDER, env: { FAKE_COPY_FILES: "2" } });
    eq("the test folder: it can be named", named.status, 0);
    eq("the test folder: named, compared byte for byte", named.out.includes(`Byte comparison of \`${TEST_FOLDER}\``), true);
  }
  {
    const absent = OTHER.replace("/v1/", "/v9/");
    const r = runDrill({ source: all, backup: all, prefix: absent });
    eq("named, not on the backup: fails", r.status, 1);
    eq("named, not on the backup: nothing downloaded", /^copy /m.test(r.calls), false);
  }
  {
    const r = runDrill({ source: tsv([10, a], [20, b]), backup: all, prefix: OTHER });
    eq("named, not in the live bucket: fails", r.status, 1);
    eq("named, not in the live bucket: says so", r.out.includes("is not in the live bucket"), true);
  }
  {
    const r = runDrill({ source: all, due: tsv([20, b], [5, c]), backup: all, prefix: FOLDER });
    eq("named, holds an object under an hour old: fails", r.status, 1);
    eq("named, holds an object under an hour old: says so", r.out.includes("holds objects under an hour old"), true);
    eq("named, holds an object under an hour old: nothing downloaded", /^copy /m.test(r.calls), false);
  }
  {
    const big = tsv(...Array.from({ length: 501 }, (_, i): [number, string] => [1, `${FOLDER}${i}.html`]));
    const r = runDrill({ source: big, backup: big });
    eq("over the object budget: fails", r.status, 1);
    eq("over the object budget: says what to do", /over the job's own budget .*drill_prefix/.test(r.out), true);
    eq("over the object budget: nothing downloaded", /^copy /m.test(r.calls), false);
  }
  {
    const big = tsv([1073741825, a]);
    const r = runDrill({ source: big, backup: big });
    eq("over the byte budget: fails", r.status, 1);
    eq("over the byte budget: nothing downloaded", /^copy /m.test(r.calls), false);
  }
  {
    const fine = tsv(...Array.from({ length: 500 }, (_, i): [number, string] => [1, `${FOLDER}${i}.html`]));
    const combined = Array.from({ length: 500 }, (_, i) => `= ${i}.html\n`).join("");
    const r = runDrill({ source: fine, backup: fine, combined });
    eq("at the budget: passes", r.status, 0);
  }

  console.log("\nthe preflight, the real curl and jq against a stand-in with the v4 shapes");
  const standinDir = `${base}/standin`;
  fs.mkdirSync(standinDir);
  // Answers from plan.json, keyed by call; records what it was sent. It ends when this test does: its stdin closes.
  fs.writeFileSync(`${standinDir}/standin.cjs`, String.raw`
const http = require("node:http"), fs = require("node:fs");
const dir = process.argv[2];
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    fs.appendFileSync(dir + "/requests.jsonl", JSON.stringify({ method: req.method, url: req.url, authorization: req.headers.authorization ?? "", contentType: req.headers["content-type"] ?? "", body: Buffer.concat(chunks).toString() }) + "\n");
    const call = (req.url.match(/^\/b2api\/v4\/(\w+)$/) ?? [])[1] ?? "";
    const answer = JSON.parse(fs.readFileSync(dir + "/plan.json", "utf8"))[call];
    if (!answer) { res.writeHead(404); res.end(); return; }
    if (answer.stall) return;
    res.writeHead(answer.status, { "content-type": "application/json" });
    res.end(answer.body);
  });
});
server.listen(0, "127.0.0.1", () => {
  fs.writeFileSync(dir + "/port.tmp", JSON.stringify(server.address()));
  fs.renameSync(dir + "/port.tmp", dir + "/port.json");
});
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
`);
  const standin = spawn(process.execPath, [`${standinDir}/standin.cjs`, standinDir], { stdio: ["pipe", "ignore", "ignore"] });
  const sleep = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
  for (let i = 0; i < 200 && !fs.existsSync(`${standinDir}/port.json`); i++) sleep(50);
  const listening = JSON.parse(fs.readFileSync(`${standinDir}/port.json`, "utf8")) as { address: string; port: number };
  eq("the stand-in binds 127.0.0.1 only", listening.address, "127.0.0.1");
  const STANDIN_URL = `http://127.0.0.1:${listening.port}`;

  const KEY_ID = "MARKERKEYID";
  const APP_KEY = "MARKERAPPKEY";
  const TOKEN = "4_MARKERTOKEN_acct_abc-def=";
  const ACCOUNT = "MARKERACCOUNT";
  const BUCKET = "MARKERBUCKET";
  const BUCKET_ID = "MARKERBUCKETID";
  const REGION = "markerregion-004";
  const API_URL = "https://apimarker.backblazeb2.com";
  const S3_URL = `https://s3.${REGION}.backblazeb2.com`;

  // The real curl, pointed at the stand-in. It records its arguments and its stdin, and refuses any other address that
  // names backblazeb2, so no case here can reach the real service. Any other address goes to the real curl: this file
  // names only .invalid hosts of that kind, and the step refuses them without calling them. FAKE_MAX_TIME shortens the
  // time limit, so a stall costs seconds.
  const realCurl = spawnSync("bash", ["-c", "command -v curl"], { encoding: "utf8" }).stdout.trim();
  fs.writeFileSync(`${bin}/curl`, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_DIR/curl-args.txt"
config="$(cat)"
printf '%s\\n' "$config" >> "$FAKE_DIR/curl-stdin.txt"
config="\${config//https:\\/\\/api.backblazeb2.com/${STANDIN_URL}}"
config="\${config//${API_URL.replace(/\//g, "\\/")}/${STANDIN_URL}}"
case "$config" in *backblazeb2*) exit 99 ;; esac
args=()
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--max-time" ]; then args+=("$1" "\${FAKE_MAX_TIME:-$2}"); shift 2; else args+=("$1"); shift; fi
done
printf '%s\\n' "$config" | "${realCurl}" "\${args[@]}"
`, { mode: 0o755 });

  type Answer = { status?: number; body?: string; stall?: boolean };
  const answer = (o: unknown): Answer => ({ status: 200, body: JSON.stringify(o) });
  const WRITER = ["listBuckets", "readBuckets", "readBucketRetentions", "listFiles", "readFiles", "readFileRetentions", "writeFiles"];
  // The owner's key as Backblaze answers for it: this bucket only, exactly these 7 capabilities.
  const signIn = (over: Record<string, unknown> = {}) => {
    const v = { capabilities: WRITER, buckets: [{ id: BUCKET_ID, name: BUCKET }], namePrefix: null, apiUrl: API_URL, s3ApiUrl: S3_URL, token: TOKEN, account: ACCOUNT, ...over };
    return answer({
      accountId: v.account,
      apiInfo: {
        groupsApi: {},
        storageApi: {
          absoluteMinimumPartSize: 5000000,
          allowed: { buckets: v.buckets, capabilities: v.capabilities, namePrefix: v.namePrefix },
          apiUrl: v.apiUrl,
          downloadUrl: "https://fmarker.backblazeb2.com",
          infoType: "storageApi",
          recommendedPartSize: 100000000,
          s3ApiUrl: v.s3ApiUrl,
        },
      },
      applicationKeyExpirationTimestamp: null,
      authorizationToken: v.token,
    });
  };
  const LOCK = { isClientAuthorizedToRead: true, value: { defaultRetention: { mode: "governance", period: { duration: 90, unit: "days" } }, isFileLockEnabled: true } };
  const retention = (mode: unknown, duration: unknown, unit: unknown) => ({ ...LOCK, value: { ...LOCK.value, defaultRetention: { mode, period: { duration, unit } } } });
  const oneBucket = (over: Record<string, unknown> = {}) => ({
    accountId: ACCOUNT,
    bucketId: BUCKET_ID,
    bucketInfo: {},
    bucketName: BUCKET,
    bucketType: "allPrivate",
    corsRules: [],
    defaultServerSideEncryption: { isClientAuthorizedToRead: true, value: { algorithm: null, mode: null } },
    fileLockConfiguration: LOCK,
    lifecycleRules: [],
    options: ["s3"],
    replicationConfiguration: { isClientAuthorizedToRead: true, value: null },
    revision: 3,
    ...over,
  });
  const listing = (over: Record<string, unknown> = {}) => answer({ buckets: [oneBucket(over)] });

  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]));
  const runPreflight = (authorize: Answer, list: Answer, env: Record<string, string> = {}) => {
    fs.writeFileSync(`${standinDir}/plan.json`, JSON.stringify({ b2_authorize_account: authorize, b2_list_buckets: list }));
    fs.writeFileSync(`${standinDir}/requests.jsonl`, "");
    const dir = sandbox();
    for (const f of ["github-env", "github-output", "curl-args.txt", "curl-stdin.txt"]) fs.writeFileSync(`${dir}/${f}`, "");
    const r = runBlock(dir, preflight, {
      EXPECT_RETENTION_MODE: unquoted(preflight.env.EXPECT_RETENTION_MODE),
      EXPECT_RETENTION_DAYS: unquoted(preflight.env.EXPECT_RETENTION_DAYS),
      B2_KEY_ID: KEY_ID,
      B2_APPLICATION_KEY: APP_KEY,
      B2_CONTENT_BUCKET: BUCKET,
      B2_REGION: REGION,
      GITHUB_ENV: `${dir}/github-env`,
      GITHUB_OUTPUT: `${dir}/github-output`,
      ...env,
    });
    const lines = r.stdout.split("\n").filter(Boolean);
    return {
      dir,
      status: r.status,
      lines,
      // ::add-mask:: is the one line that must name them: the runner consumes it, and it never reaches the log.
      shown: lines.filter((l) => !l.startsWith("::add-mask::")).join("\n") + r.stderr,
      summary: summaryOf(dir),
      calls: fs.readFileSync(`${dir}/calls.txt`, "utf8"),
      requests: fs.readFileSync(`${standinDir}/requests.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { method: string; url: string; authorization: string; contentType: string; body: string }),
      args: fs.readFileSync(`${dir}/curl-args.txt`, "utf8"),
      stdin: fs.readFileSync(`${dir}/curl-stdin.txt`, "utf8"),
    };
  };
  const SHOWN_NOWHERE = /marker|backblazeb2|127\.0\.0\.1|:\/\/|example\.invalid/i;
  const FIXED_LINE = /^(PASS: |FAIL: |::add-mask::|::error title=content-backup preflight failed::|Preflight)/;
  const mustFail = (what: string, authorize: Answer, list: Answer, line: string, env: Record<string, string> = {}) => {
    const r = runPreflight(authorize, list, env);
    eq(`${what}: fails`, r.status, 1);
    eq(`${what}: the fixed line`, r.lines.includes(line) ? line : r.lines.filter((l) => l.startsWith("FAIL")), line);
    eq(`${what}: in the summary`, r.summary.includes(`- ${line}\n`), true);
    eq(`${what}: nothing was copied, it says`, r.lines.some((l) => /^::error title=content-backup preflight failed::.*Nothing was copied/.test(l)), true);
    eq(`${what}: no rclone call`, r.calls, "");
    eq(`${what}: every line is a fixed one`, r.lines.filter((l) => !FIXED_LINE.test(l)), []);
    eq(`${what}: nothing marked and no address in stdout or stderr`, r.shown.match(SHOWN_NOWHERE)?.[0] ?? null, null);
    eq(`${what}: nor in the summary`, r.summary.match(SHOWN_NOWHERE)?.[0] ?? null, null);
    return r;
  };

  {
    const r = runPreflight(signIn(), listing());
    eq("the owner's key and lock: passes", r.status, 0);
    eq("the owner's key and lock: no check fails", r.lines.filter((l) => l.startsWith("FAIL")), []);
    eq("the owner's key and lock: says it passed", r.lines.includes("Preflight passed."), true);
    eq("the owner's key and lock: each check has its line, in the summary too", r.lines.filter((l) => l.startsWith("PASS")).every((l) => r.summary.includes(`- ${l}\n`)) && r.lines.filter((l) => l.startsWith("PASS")).length, 22);
    eq("every line is a fixed one", r.lines.filter((l) => !FIXED_LINE.test(l)), []);
    eq("nothing marked and no address in stdout or stderr", r.shown.match(SHOWN_NOWHERE)?.[0] ?? null, null);
    eq("nor in the summary", r.summary.match(SHOWN_NOWHERE)?.[0] ?? null, null);
    eq("the token and the account id are masked, and nothing else", r.lines.filter((l) => l.startsWith("::add-mask::")), [`::add-mask::${TOKEN}`, `::add-mask::${ACCOUNT}`]);
    eq("masked before any check is reported", r.lines.findIndex((l) => l.startsWith("::add-mask::")) < r.lines.findIndex((l) => l.startsWith("PASS")), true);
    eq("two calls", r.requests.map((q) => `${q.method} ${q.url}`), ["GET /b2api/v4/b2_authorize_account", "POST /b2api/v4/b2_list_buckets"]);
    eq("sign-in carries the key, by basic auth", Buffer.from(r.requests[0]?.authorization.replace(/^Basic /, "") ?? "", "base64").toString(), `${KEY_ID}:${APP_KEY}`);
    eq("the listing carries the token", r.requests[1]?.authorization, TOKEN);
    eq("the listing names the account and the bucket", JSON.parse(r.requests[1]?.body ?? "null"), { accountId: ACCOUNT, bucketName: BUCKET });
    eq("the listing is JSON", r.requests[1]?.contentType, "application/json");
    eq("no credential in curl's arguments", r.args.match(/marker/i)?.[0] ?? null, null);
    eq("the credentials did go on stdin", r.stdin.includes(`${KEY_ID}:${APP_KEY}`) && r.stdin.includes(TOKEN), true);
    eq("no file holds the token or the key", walk(`${r.dir}/tmp`).filter((f) => /marker/i.test(fs.readFileSync(f, "utf8"))), []);
    eq("nothing for a later step: GITHUB_ENV", fs.readFileSync(`${r.dir}/github-env`, "utf8"), "");
    eq("nothing for a later step: GITHUB_OUTPUT", fs.readFileSync(`${r.dir}/github-output`, "utf8"), "");
    eq("rclone is not the preflight's", r.calls, "");
    runBlock(r.dir, counter, {});
    const next = runBlock(r.dir, copy, { DRY_RUN: "false" });
    eq("and the job goes on to the copy", next.status === 0 && /^copy /m.test(fs.readFileSync(`${r.dir}/calls.txt`, "utf8")), true);
  }

  const FORBIDDEN = ["bypassGovernance", "deleteFiles", "deleteBuckets", "writeBuckets", "writeBucketRetentions", "writeFileRetentions", "writeBucketLifecycleRules", "writeKeys", "deleteKeys", "shareFiles"];
  for (const cap of FORBIDDEN) {
    mustFail(`the key holds ${cap}`, signIn({ capabilities: [...WRITER, cap] }), listing(), `FAIL: the key does not hold ${cap}.`);
  }
  for (const cap of ["writeFiles", "listFiles", "readFiles"]) {
    mustFail(`the key lacks ${cap}`, signIn({ capabilities: WRITER.filter((c) => c !== cap) }), listing(), `FAIL: the key holds ${cap}.`);
  }
  const ONE_BUCKET = "FAIL: the key is limited to exactly one bucket, the content bucket.";
  mustFail("the key has two buckets", signIn({ buckets: [{ id: BUCKET_ID, name: BUCKET }, { id: "MARKEROTHERID", name: "MARKEROTHER" }] }), listing(), ONE_BUCKET);
  mustFail("the key has no bucket limit: buckets null", signIn({ buckets: null }), listing(), ONE_BUCKET);
  mustFail("the key's buckets are empty", signIn({ buckets: [] }), listing(), ONE_BUCKET);
  mustFail("the key is limited to another bucket, by name", signIn({ buckets: [{ id: BUCKET_ID, name: "MARKEROTHER" }] }), listing(), ONE_BUCKET);
  mustFail("the key is limited to another bucket, by id", signIn({ buckets: [{ id: "MARKEROTHERID" }] }), listing(), "FAIL: the listing holds one bucket, the content bucket, and it is the one the key is limited to.");
  mustFail("the key has a name prefix", signIn({ namePrefix: "MARKERPREFIX/" }), listing(), "FAIL: the key has no name prefix.");
  const S3_LINE = "FAIL: the S3 endpoint is the one for B2_REGION.";
  mustFail("a wrong S3 endpoint", signIn({ s3ApiUrl: "https://s3.markerother-001.backblazeb2.com" }), listing(), S3_LINE);
  mustFail("an S3 endpoint over http", signIn({ s3ApiUrl: `http://s3.${REGION}.backblazeb2.com` }), listing(), S3_LINE);
  mustFail("no S3 endpoint", signIn({ s3ApiUrl: null }), listing(), S3_LINE);
  mustFail("the capabilities are null", signIn({ capabilities: null }), listing(), "FAIL: the key holds writeFiles.");
  mustFail("the lock is off", signIn(), listing({ fileLockConfiguration: { isClientAuthorizedToRead: true, value: { defaultRetention: { mode: null, period: null }, isFileLockEnabled: false } } }), "FAIL: Object Lock is on.");
  const RETENTION = "FAIL: the default retention is governance, 90 days.";
  mustFail("compliance", signIn(), listing({ fileLockConfiguration: retention("compliance", 90, "days") }), RETENTION);
  mustFail("30 days", signIn(), listing({ fileLockConfiguration: retention("governance", 30, "days") }), RETENTION);
  mustFail("90 years", signIn(), listing({ fileLockConfiguration: retention("governance", 90, "years") }), RETENTION);
  mustFail("no default retention", signIn(), listing({ fileLockConfiguration: retention(null, null, null) }), RETENTION);
  mustFail("the days as a string", signIn(), listing({ fileLockConfiguration: retention("governance", "90", "days") }), RETENTION);
  mustFail("the mode in another case", signIn(), listing({ fileLockConfiguration: retention("Governance", 90, "days") }), RETENTION);
  mustFail("the lock on, as a string", signIn(), listing({ fileLockConfiguration: { ...LOCK, value: { ...LOCK.value, isFileLockEnabled: "true" } } }), "FAIL: Object Lock is on.");
  mustFail("authorized to read, as a string", signIn(), listing({ fileLockConfiguration: { ...LOCK, isClientAuthorizedToRead: "true" } }), "FAIL: the key can read the lock settings.");
  mustFail("the capabilities a string naming all three", signIn({ capabilities: "writeFiles listFiles readFiles" }), listing(), "FAIL: the key holds writeFiles.");
  mustFail("sign-in: a 201 with a good answer", { ...signIn(), status: 201 }, listing(), "FAIL: sign-in: HTTP 201.");
  mustFail("the listing: a 201 with a good answer", signIn(), { ...listing(), status: 201 }, "FAIL: b2_list_buckets: HTTP 201.");
  mustFail("the retention cannot be read", signIn(), listing({ fileLockConfiguration: { isClientAuthorizedToRead: false, value: null } }), "FAIL: the key can read the lock settings.");
  mustFail("no lock settings in the answer", signIn(), answer({ buckets: [{ bucketId: BUCKET_ID, bucketName: BUCKET }] }), "FAIL: the key can read the lock settings.");
  const IN_LIST = "FAIL: the listing holds one bucket, the content bucket, and it is the one the key is limited to.";
  mustFail("the listing holds two buckets", signIn(), answer({ buckets: [oneBucket(), oneBucket({ bucketId: "MARKEROTHERID", bucketName: "MARKEROTHER" })] }), IN_LIST);
  mustFail("the listing holds no bucket", signIn(), answer({ buckets: [] }), IN_LIST);
  mustFail("the listing's buckets are null", signIn(), answer({ buckets: null }), IN_LIST);
  mustFail("the listing holds another bucket", signIn(), listing({ bucketName: "MARKEROTHER" }), IN_LIST);

  const errorBody = (status: number, code: string) => ({ status, body: JSON.stringify({ code, message: `MARKERERROR ${STANDIN_URL}/${KEY_ID}/${BUCKET}`, status }) });
  mustFail("sign-in: 401", errorBody(401, "unauthorized"), listing(), "FAIL: sign-in: HTTP 401.");
  mustFail("sign-in: 500", errorBody(500, "internal_error"), listing(), "FAIL: sign-in: HTTP 500.");
  mustFail("sign-in: a stall", { stall: true }, listing(), "FAIL: sign-in: no answer (curl exit code 28).", { FAKE_MAX_TIME: "2" });
  mustFail("sign-in: invalid JSON", { status: 200, body: `{"authorizationToken":"${TOKEN}",MARKERJUNK` }, listing(), "FAIL: sign-in: the answer could not be read.");
  mustFail("sign-in: JSON of the wrong shape", answer([TOKEN]), listing(), "FAIL: sign-in: the answer could not be read.");
  mustFail("sign-in: no token", signIn({ token: null }), listing(), "FAIL: sign-in: the answer could not be read.");
  mustFail("sign-in: a token with a space", signIn({ token: "MARKERTOKEN two" }), listing(), "FAIL: sign-in: the answer could not be read.");
  mustFail("sign-in: no account id", signIn({ account: null }), listing(), "FAIL: sign-in: the answer could not be read.");
  mustFail("sign-in: an empty answer", { status: 200, body: "" }, listing(), "FAIL: sign-in: the answer could not be read.");
  mustFail("sign-in: a bucket of the wrong shape", signIn({ buckets: ["MARKERJUNK"] }), listing(), "FAIL: sign-in: the answer could not be read.");
  {
    // No answer that the first read accepts can make these checks fail to run, so this one takes a jq that fails on them.
    const realJq = spawnSync("bash", ["-c", "command -v jq"], { encoding: "utf8" }).stdout.trim();
    const failing = `${base}/bin-jq`;
    fs.mkdirSync(failing);
    fs.writeFileSync(`${failing}/jq`, `#!/usr/bin/env bash
case " $* " in *" --arg s3 "*) exit 5 ;; esac
exec "${realJq}" "$@"
`, { mode: 0o755 });
    mustFail("the checks on the key cannot run", signIn(), listing(), "FAIL: sign-in: the answer could not be read.", { PATH: `${path.resolve(failing)}${path.delimiter}${path.resolve(bin)}${path.delimiter}${process.env.PATH ?? ""}` });
  }
  mustFail("the listing: 401", signIn(), errorBody(401, "unauthorized"), "FAIL: b2_list_buckets: HTTP 401.");
  mustFail("the listing: 500", signIn(), errorBody(500, "internal_error"), "FAIL: b2_list_buckets: HTTP 500.");
  mustFail("the listing: a stall", signIn(), { stall: true }, "FAIL: b2_list_buckets: no answer (curl exit code 28).", { FAKE_MAX_TIME: "2" });
  mustFail("the listing: invalid JSON", signIn(), { status: 200, body: `{"buckets":[MARKERJUNK` }, "FAIL: b2_list_buckets: the answer could not be read.");

  mustFail("the listing: an empty answer", signIn(), { status: 200, body: "" }, "FAIL: b2_list_buckets: the answer could not be read.");
  mustFail("the listing: a bucket of the wrong shape", signIn(), answer({ buckets: ["MARKERJUNK"] }), "FAIL: b2_list_buckets: the answer could not be read.");

  for (const [what, apiUrl] of [["http", API_URL.replace("https:", "http:")], ["another host", "https://marker.example.invalid"], ["a look-alike host", "https://api.backblazeb2.com.marker.example.invalid"], ["a path after the host", `${API_URL}/marker`], ["the host only in a path", "https://marker.example.invalid/x.backblazeb2.com"], ["none", null]] as const) {
    const r = mustFail(`the API address is ${what}`, signIn({ apiUrl }), listing(), "FAIL: the API address in the answer is Backblaze's, over https.");
    eq(`the API address is ${what}: the token is not sent`, r.requests.map((q) => q.url), ["/b2api/v4/b2_authorize_account"]);
  }
  for (const [what, env] of [["a newline at the end of the application key", { B2_APPLICATION_KEY: `${APP_KEY}\n` }], ["a space in the key id", { B2_KEY_ID: "MARKER KEY" }]] as const) {
    const r = mustFail(`${what}`, signIn(), listing(), "FAIL: the key id and application key hold only printable characters.", env);
    eq(`${what}: no call`, r.requests.length, 0);
  }
  {
    // Quoted for curl's config format: the value arrives unchanged, and cannot add an option.
    const odd = `MARKER"a\\b\\"c`;
    const r = runPreflight(signIn(), listing(), { B2_APPLICATION_KEY: odd });
    eq("a key with a quote and a backslash: passes", r.status, 0);
    eq("a key with a quote and a backslash: sent unchanged", Buffer.from(r.requests[0]?.authorization.replace(/^Basic /, "") ?? "", "base64").toString(), `${KEY_ID}:${odd}`);
  }

  standin.stdin?.end();
  standin.kill();
  let gone = false;
  for (let i = 0; i < 50 && !gone; i++) {
    gone = spawnSync("bash", ["-c", `curl --silent --max-time 2 -o /dev/null ${STANDIN_URL}/`]).status !== 0;
    if (!gone) sleep(100);
  }
  eq("the stand-in has stopped", gone, true);

  fs.rmSync(base, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
