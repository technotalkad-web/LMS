/**
 * Guard for ADR 0007 step 7 and the order rule of docs/ARCHITECTURE.md §9:
 * CRON_CADENCE_MIN in app/api/ops/health/route.ts against the schedules of
 * .github/workflows/cron.yml and the cron routes. A cron.yml schedule fires on
 * production as soon as it is on main, and a cadence entry whose schedule is
 * not firing pages the watchdog, so:
 *
 *   - every cadence entry has a cron.yml schedule (a case arm mapping it to
 *     /api/cron/<name>) and a route app/api/cron/<name>/route.ts that records
 *     its heartbeat under that exact name (else the entry reads never-seen);
 *   - every scheduled job has a cadence entry, except the jobs listed in
 *     PENDING_NEXT_TAG, whose entry waits for the next tag (report-card-refresh:
 *     its route reaches production only with v1.3.0);
 *   - each threshold is longer than its schedule's nominal interval;
 *   - every schedule line has exactly one case arm and every arm a schedule;
 *   - SUBDAILY_STALE_WARN is exactly the cadence entries whose schedule fires
 *     more than once a day, and its ceiling is at least a day.
 *
 * A job scheduled outside cron.yml (pg_cron, ADR 0007 step 11) would need its
 * own list here.
 *
 * Run:  npx tsx tests/unit/cron-cadence.test.ts   (or npm run test:unit)
 * (No DB.)
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const root = path.resolve(__dirname, "../..");
const HEALTH_ROUTE = "app/api/ops/health/route.ts";
const CRON_YML = ".github/workflows/cron.yml";

/** Scheduled jobs whose cadence entry ships in the next tag (ADR 0007 step 7). */
const PENDING_NEXT_TAG = ["report-card-refresh"];

// ── CRON_CADENCE_MIN, read with the TypeScript parser ────────────────────────
function numeric(e: ts.Expression): number {
  if (ts.isNumericLiteral(e)) return Number(e.text);
  if (ts.isParenthesizedExpression(e)) return numeric(e.expression);
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AsteriskToken) {
    return numeric(e.left) * numeric(e.right);
  }
  throw new Error(`unsupported cadence expression: ${e.getText()}`);
}

function readCadence(): Map<string, number> {
  const file = path.join(root, HEALTH_ROUTE);
  const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const out = new Map<string, number>();
  let found = 0;
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "CRON_CADENCE_MIN" &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      found++;
      for (const p of node.initializer.properties) {
        if (!ts.isPropertyAssignment(p)) throw new Error(`unsupported property: ${p.getText()}`);
        const key = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : p.name.getText();
        out.set(key, numeric(p.initializer));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (found !== 1) throw new Error(`expected one CRON_CADENCE_MIN object literal in ${HEALTH_ROUTE}, found ${found}`);
  return out;
}

/** SUBDAILY_STALE_WARN (an array of string literals) and SUBDAILY_STALE_DEGRADED_MIN. */
function readSubdaily(): { warnOnly: string[]; ceilingMin: number } {
  const file = path.join(root, HEALTH_ROUTE);
  const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const warnOnly: string[][] = [];
  const ceiling: number[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (node.name.text === "SUBDAILY_STALE_WARN") {
        if (!ts.isArrayLiteralExpression(node.initializer)) throw new Error("SUBDAILY_STALE_WARN is not an array literal");
        warnOnly.push(
          node.initializer.elements.map((e) => {
            if (!ts.isStringLiteral(e)) throw new Error(`unsupported SUBDAILY_STALE_WARN element: ${e.getText()}`);
            return e.text;
          })
        );
      }
      if (node.name.text === "SUBDAILY_STALE_DEGRADED_MIN") ceiling.push(numeric(node.initializer));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (warnOnly.length !== 1 || ceiling.length !== 1) {
    throw new Error(`expected one SUBDAILY_STALE_WARN and one SUBDAILY_STALE_DEGRADED_MIN in ${HEALTH_ROUTE}`);
  }
  return { warnOnly: warnOnly[0], ceilingMin: ceiling[0] };
}

// ── cron.yml: schedule lines and the case arms that map them to a route ──────
const yml = fs.readFileSync(path.join(root, CRON_YML), "utf8");
const schedules = [...yml.matchAll(/^\s*-\s*cron:\s*"([^"]+)"/gm)].map((m) => m[1]);
const arms = [...yml.matchAll(/^\s*"([^"]+)"\)\s*P=\/api\/cron\/([a-z0-9-]+)\s*;;/gm)].map((m) => ({
  expr: m[1],
  job: m[2],
}));
const exprByJob = new Map(arms.map((a) => [a.job, a.expr]));

/** Nominal interval of the cron shapes cron.yml uses, in minutes; null = a shape this test does not know. */
function intervalMin(expr: string): number | null {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [min, hour, dom, mon, dow] = f;
  const step = /^(?:\*|\d+-\d+)\/(\d+)$/.exec(min);
  if (step && hour === "*" && dom === "*" && mon === "*" && dow === "*") return Number(step[1]);
  if (!/^\d+$/.test(min) || mon !== "*") return null;
  if (hour === "*" && dom === "*" && dow === "*") return 60;
  if (!/^\d+$/.test(hour)) return null;
  if (dom === "*" && dow === "*") return 24 * 60;
  if (dom === "*" && /^\d$/.test(dow)) return 7 * 24 * 60;
  if (/^\d+$/.test(dom) && dow === "*") return 31 * 24 * 60; // longest month
  return null;
}

const cadence = readCadence();
const cadenceJobs = [...cadence.keys()];
const scheduledJobs = arms.map((a) => a.job);

console.log("\ncron.yml: schedule lines and case arms agree");
eq("at least one schedule line", schedules.length > 0, true);
eq("every schedule line has exactly one case arm", schedules.filter((s) => arms.filter((a) => a.expr === s).length !== 1), []);
// Removing a job from cron.yml means removing its schedule line AND its case
// arm in the same push (docs/release/v1.3.0.md §2.1 item 4).
eq("every case arm has a schedule line", arms.filter((a) => !schedules.includes(a.expr)).map((a) => a.job), []);
eq("no job has two case arms", scheduledJobs.filter((j, i) => scheduledJobs.indexOf(j) !== i), []);

console.log("\nCRON_CADENCE_MIN: an entry only for a schedule that fires (ADR 0007 step 7)");
eq("every cadence entry has a cron.yml schedule", cadenceJobs.filter((j) => !exprByJob.has(j)), []);
eq(
  "every scheduled job has a cadence entry or waits for the next tag",
  scheduledJobs.filter((j) => !cadence.has(j) && !PENDING_NEXT_TAG.includes(j)),
  []
);
eq("no next-tag job has a cadence entry", PENDING_NEXT_TAG.filter((j) => cadence.has(j)), []);
eq(
  "gamification-refresh, gamification-monthly and journey-nudges have entries",
  ["gamification-refresh", "gamification-monthly", "journey-nudges"].filter((j) => !cadence.has(j)),
  []
);

console.log("\neach threshold is longer than its schedule's interval");
for (const [job, minutes] of cadence) {
  const expr = exprByJob.get(job);
  if (!expr) continue; // reported above
  const iv = intervalMin(expr);
  eq(`${job} ("${expr}"): known schedule shape`, iv !== null, true);
  if (iv !== null) eq(`${job}: ${minutes} min > ${iv} min`, minutes > iv, true);
  eq(`${job}: positive whole minutes`, Number.isInteger(minutes) && minutes > 0, true);
}

// The owner's decision of 2026-11-14 (ADR 0007, note on decision 4): a stale
// heartbeat of a job scheduled more than once a day reads "warn", up to a
// ceiling. The list must be exactly the cadence entries whose schedule fires
// more than once a day, so a new frequent job cannot page and a daily one
// cannot be quietened by accident.
console.log("\nSUBDAILY_STALE_WARN: exactly the cadence entries scheduled more than once a day");
const subdaily = readSubdaily();
const firesSubDaily = cadenceJobs.filter((j) => {
  const expr = exprByJob.get(j);
  const iv = expr ? intervalMin(expr) : null;
  return iv !== null && iv < 24 * 60;
});
eq("the list equals the sub-daily cadence entries", [...subdaily.warnOnly].sort(), [...firesSubDaily].sort());
eq("no job is listed twice", subdaily.warnOnly.filter((j, i) => subdaily.warnOnly.indexOf(j) !== i), []);
eq("the list names lrs-forward, gamification-refresh and journey-nudges", [...subdaily.warnOnly].sort(), [
  "gamification-refresh",
  "journey-nudges",
  "lrs-forward",
]);
eq(`the ceiling (${subdaily.ceilingMin} min) is at least a day`, subdaily.ceilingMin >= 24 * 60, true);
eq(
  "the ceiling is above every listed job's threshold",
  subdaily.warnOnly.filter((j) => !((cadence.get(j) ?? Infinity) < subdaily.ceilingMin)),
  []
);

console.log("\neach cadence entry's route records its heartbeat under that name");
for (const job of cadenceJobs) {
  const rel = `app/api/cron/${job}/route.ts`;
  const file = path.join(root, rel);
  const src = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  eq(`${rel} exists`, src.length > 0, true);
  eq(`${rel} calls recordHeartbeat("${job}")`, src.includes(`recordHeartbeat("${job}"`), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
