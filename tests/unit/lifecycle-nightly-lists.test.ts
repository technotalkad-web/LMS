/**
 * The lifecycle nightly in two jobs (ADR 0024 step 73; phase 2 slice P2-1):
 * scripts/lifecycle-nightly.sh holds two spec lists, DEFAULT_SPECS for the
 * workflow's first job and PRODUCT_SPECS for its second, and
 * .github/workflows/lifecycle-nightly.yml runs the second job after the
 * first, never beside it, with its own timeout.
 *
 *   - each list is two-digit spec numbers, each with exactly one spec file,
 *     and no number is in both lists;
 *   - the workflow: the first job's timeout is 90 minutes; the second job
 *     needs the first, runs unless the run was cancelled, has a 60-minute
 *     timeout, selects its list in a step that holds no secret, and every
 *     later step runs only when that step says so;
 *   - the script's selection, run in bash: both early exits (no product
 *     specs yet; specs given by a dispatch) come before anything is built,
 *     before the secrets are checked, and write run=false for the workflow.
 *
 * Run:  npx tsx tests/unit/lifecycle-nightly-lists.test.ts   (or npm run test:unit)
 * (No DB, no build.)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const root = path.resolve(__dirname, "../..");
const SCRIPT = path.join(root, "scripts/lifecycle-nightly.sh");
const WORKFLOW = path.join(root, ".github/workflows/lifecycle-nightly.yml");
const src = fs.readFileSync(SCRIPT, "utf8").replace(/\r\n/g, "\n");
const yml = fs.readFileSync(WORKFLOW, "utf8").replace(/\r\n/g, "\n");

// ── the two lists ────────────────────────────────────────────────────────────
function list(name: string): string[] {
  const all = [...src.matchAll(new RegExp(`^${name}="([^"]*)"$`, "gm"))];
  eq(`${name} is assigned once, as a plain string`, all.length, 1);
  return (all[0]?.[1] ?? "").split(/\s+/).filter(Boolean);
}
console.log("\nthe two spec lists in scripts/lifecycle-nightly.sh");
const DEFAULT = list("DEFAULT_SPECS");
const PRODUCTS = list("PRODUCT_SPECS");
const specDir = path.join(root, "tests/bot/lifecycle");
const specFiles = fs.readdirSync(specDir).filter((f) => f.endsWith(".spec.ts"));
for (const [name, l] of [["DEFAULT_SPECS", DEFAULT], ["PRODUCT_SPECS", PRODUCTS]] as const) {
  eq(`${name}: every entry is a two-digit number`, l.filter((n) => !/^\d{2}$/.test(n)), []);
  eq(`${name}: no number twice`, l.filter((n, i) => l.indexOf(n) !== i), []);
  eq(
    `${name}: every number has exactly one tests/bot/lifecycle/<n>-*.spec.ts`,
    l.filter((n) => specFiles.filter((f) => f.startsWith(`${n}-`)).length !== 1),
    []
  );
}
eq("DEFAULT_SPECS is not empty", DEFAULT.length > 0, true);
eq("no spec number is in both lists", DEFAULT.filter((n) => PRODUCTS.includes(n)), []);

// ── the workflow ─────────────────────────────────────────────────────────────
console.log("\n.github/workflows/lifecycle-nightly.yml: two jobs, one after the other");
const jobsAt = yml.indexOf("\njobs:\n");
eq("one jobs: block", jobsAt > 0 && yml.indexOf("\njobs:\n", jobsAt + 1) < 0, true);
const jobsText = yml.slice(jobsAt + 7);
const jobNames = [...jobsText.matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm)].map((m) => m[1]);
eq("exactly the jobs lifecycle and lifecycle-products", jobNames, ["lifecycle", "lifecycle-products"]);
function job(name: string): string {
  const start = jobsText.search(new RegExp(`^ {2}${name}:\\s*$`, "m"));
  if (start < 0) return "";
  const rest = jobsText.slice(start + 1);
  const next = rest.search(/^ {2}[A-Za-z0-9_-]+:\s*$/m);
  return next < 0 ? rest : rest.slice(0, next);
}
const first = job("lifecycle");
const second = job("lifecycle-products");
const field = (j: string, key: string) => (j.match(new RegExp(`^ {4}${key}: (.+)$`, "m")) ?? [])[1]?.trim();
eq("the first job: timeout 90 minutes", field(first, "timeout-minutes"), "90");
eq("the first job does not set LIFECYCLE_LIST (it runs DEFAULT_SPECS)", /LIFECYCLE_LIST/.test(first), false);
eq("the second job: needs the first", field(second, "needs"), "lifecycle");
eq("the second job: runs unless the run was cancelled", field(second, "if"), "${{ !cancelled() }}");
eq("the second job: timeout 60 minutes", field(second, "timeout-minutes"), "60");
eq("the second job: the same runner image as the first", field(second, "runs-on"), field(first, "runs-on"));

// The second job's steps, split at each "      - " item.
const steps = second.split(/\n(?= {6}- )/).filter((s) => /^ {6}- /.test(s));
const planIdx = steps.findIndex((s) => /\n {8}id: plan\n/.test(s));
eq("a selection step with id plan", planIdx >= 0, true);
const plan = steps[planIdx] ?? "";
eq("it runs the script with LIFECYCLE_LIST=products", /\n {10}LIFECYCLE_LIST: products\n/.test(plan), true);
eq("it runs the script with LIFECYCLE_PLAN_ONLY set", /\n {10}LIFECYCLE_PLAN_ONLY: "1"\n/.test(plan), true);
eq("it passes the dispatch's specs, so given specs skip the job", plan.includes("LIFECYCLE_SPECS: ${{ inputs.specs }}"), true);
eq("it holds no secret", plan.includes("secrets."), false);
eq("it runs scripts/lifecycle-nightly.sh", /run: bash scripts\/lifecycle-nightly\.sh/.test(plan), true);
eq("only the checkout comes before it", steps.slice(0, planIdx).map((s) => (s.match(/uses: (\S+)/) ?? [])[1] ?? "run"), ["actions/checkout@v4"]);
const later = steps.slice(planIdx + 1);
eq("every later step runs only when the selection says so", later.filter((s) => !s.includes("if: steps.plan.outputs.run == 'true'")).length, 0);
eq("the later steps install, build and run (four steps)", later.length, 4);
const runStep = later[later.length - 1] ?? "";
eq("the last step runs the script with LIFECYCLE_LIST=products", /\n {10}LIFECYCLE_LIST: products\n/.test(runStep) && runStep.includes("run: bash scripts/lifecycle-nightly.sh"), true);
eq("the staging secrets reach that last step only", later.slice(0, -1).some((s) => s.includes("secrets.")), false);

// ── the selection, run in bash ───────────────────────────────────────────────
console.log("\nthe script's selection (bash; nothing is built and no secret is set)");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-lists-"));
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([k]) => !k.startsWith("LIFECYCLE_") && !/SUPABASE|GITHUB_OUTPUT|RUNNER_TEMP/.test(k)
  )
) as NodeJS.ProcessEnv;
function run(env: Record<string, string>, script = SCRIPT) {
  const out = path.join(tmp, `out-${pass + fail}.txt`);
  fs.writeFileSync(out, "");
  const r = spawnSync("bash", [script.replace(/\\/g, "/")], {
    env: { ...cleanEnv, GITHUB_OUTPUT: out, ...env },
    encoding: "utf8",
    timeout: 30_000,
  });
  return {
    status: r.status,
    stdout: (r.stdout ?? "").replace(/\r/g, "").trim(),
    output: fs.readFileSync(out, "utf8").replace(/\r/g, "").trim(),
    error: r.error?.message,
  };
}
const probe = spawnSync("bash", ["-c", "echo ok"], { encoding: "utf8" });
if (probe.status !== 0) {
  fail++;
  console.log(`  ✗ bash is not available to run the script (${probe.error?.message ?? probe.stderr}); the CI runner has it`);
} else {
  const defaultLine = `lifecycle-nightly: list 'default' will run: ${DEFAULT.join(" ")}`;
  let r = run({ LIFECYCLE_PLAN_ONLY: "1" });
  eq("plan, first job: runs DEFAULT_SPECS", [r.status, r.stdout, r.output], [0, defaultLine, "run=true"]);
  r = run({ LIFECYCLE_PLAN_ONLY: "1", LIFECYCLE_SPECS: "32 53" });
  eq("plan, first job with given specs: runs them", [r.status, r.stdout, r.output], [0, "lifecycle-nightly: list 'default' will run: 32 53", "run=true"]);
  r = run({ LIFECYCLE_PLAN_ONLY: "1", LIFECYCLE_LIST: "products", LIFECYCLE_SPECS: "32" });
  eq("plan, second job with given specs: skipped, run=false", [r.status, r.stdout, r.output], [0, "lifecycle-nightly: skipped: specs given (they run in the first job)", "run=false"]);
  r = run({ LIFECYCLE_PLAN_ONLY: "1", LIFECYCLE_LIST: "products" });
  eq(
    "plan, second job: PRODUCT_SPECS, or 'no product specs yet' while it is empty",
    [r.status, r.stdout, r.output],
    PRODUCTS.length
      ? [0, `lifecycle-nightly: list 'products' will run: ${PRODUCTS.join(" ")}`, "run=true"]
      : [0, "lifecycle-nightly: no product specs yet", "run=false"]
  );
  r = run({ LIFECYCLE_PLAN_ONLY: "1", LIFECYCLE_LIST: "products", LIFECYCLE_SPECS: "  " });
  eq("blank given specs count as none", r.output, PRODUCTS.length ? "run=true" : "run=false");
  r = run({ LIFECYCLE_PLAN_ONLY: "1", LIFECYCLE_LIST: "everything" });
  eq("an unknown list is refused (exit 2)", [r.status, r.output], [2, ""]);

  // A copy of the script with a product list, to run the non-empty branch.
  const copy = path.join(tmp, "lifecycle-nightly.sh");
  fs.writeFileSync(copy, src.replace(/^PRODUCT_SPECS=""$/m, 'PRODUCT_SPECS="68 69"'));
  r = run({ LIFECYCLE_PLAN_ONLY: "1", LIFECYCLE_LIST: "products" }, copy);
  eq("with a product list, plan, second job: runs it", [r.status, r.stdout, r.output], [0, "lifecycle-nightly: list 'products' will run: 68 69", "run=true"]);

  // Not plan-only: the early exits still come before the secrets check.
  r = run({ LIFECYCLE_LIST: "products", LIFECYCLE_SPECS: "32" });
  eq("second job with given specs passes before the secrets check", [r.status, r.stdout], [0, "lifecycle-nightly: skipped: specs given (they run in the first job)"]);
  if (!PRODUCTS.length) {
    r = run({ LIFECYCLE_LIST: "products" });
    eq("second job with no product specs passes before the secrets check", [r.status, r.stdout], [0, "lifecycle-nightly: no product specs yet"]);
  }
  r = run({});
  eq("the first job without secrets still stops at the secrets check (exit 2)", [r.status, r.stdout], [2, "lifecycle-nightly: NEXT_PUBLIC_SUPABASE_URL is not set"]);
}
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
