/**
 * Guard for ADR 0009 step 5 (attempt rows are written only by the server) and
 * ADR 0008 C (package_validations likewise). Migration 0099 drops the
 * learner/admin write policies on both tables; any write left on a caller
 * (RLS) client would then fail on every launch, commit or upload. This reads
 * the sources instead of a database:
 *
 *   - every `.from("course_attempts")` / `.from("package_validations")` chain
 *     under app/, lib/ and components/ that calls .insert/.update/.upsert/
 *     .delete is listed below with its receiver, in file order; a new write
 *     site, a moved one or a receiver that is not a service client fails;
 *   - every `updateAttemptFailSoft(` call is listed the same way, and the two
 *     functions that pass a parameter through (processStatement,
 *     updateProgressFromState) are checked at their call sites;
 *   - the sites ADR 0009 steps 2-4 moved carry their explicit filters, and
 *     every package_validations write names organization_id.
 *
 * Run:  npx tsx tests/unit/attempt-write-sites.test.ts   (or npm run test:unit)
 */
import fs from "node:fs";
import path from "node:path";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const root = path.resolve(__dirname, "../..");
const SCAN_DIRS = ["app", "lib", "components"];

function walk(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(e.name)) out.push(p);
  }
}
const files: string[] = [];
for (const d of SCAN_DIRS) walk(path.join(root, d), files);
const rel = (f: string) => path.relative(root, f).split(path.sep).join("/");
const sources = new Map<string, string>(files.map((f) => [rel(f), fs.readFileSync(f, "utf8")]));

/** The statement that starts at `start`: up to a `;` or an unmatched closer at depth 0, skipping strings. */
function statementFrom(src: string, start: number): string {
  let depth = 0;
  let i = start;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      for (i++; i < src.length && src[i] !== ch; i++) if (src[i] === "\\") i++;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) break;
      depth--;
    } else if (ch === ";" && depth === 0) break;
  }
  return src.slice(start, i);
}

/** The expression the call at `at` is made on: `svc`, `opts.supabase`, `serviceClient()`. */
function receiverBefore(src: string, at: number): string {
  const before = src.slice(Math.max(0, at - 120), at).replace(/\s+$/, "");
  return (before.match(/([\w$.]+(?:\(\))?)$/) ?? [])[1] ?? "?";
}

type Write = { receiver: string; stmt: string; method: string };
function writesOn(table: string): Map<string, Write[]> {
  const re = new RegExp(`\\.from\\(\\s*["'\`]${table}["'\`]\\s*\\)`, "g");
  const out = new Map<string, Write[]>();
  for (const [file, src] of sources) {
    for (const m of src.matchAll(re)) {
      const stmt = statementFrom(src, (m.index ?? 0) + m[0].length);
      const w = /\.(insert|update|upsert|delete)\(/.exec(stmt);
      if (!w) continue;
      const list = out.get(file) ?? [];
      list.push({ receiver: receiverBefore(src, m.index ?? 0), stmt, method: w[1] });
      out.set(file, list);
    }
  }
  return out;
}

function callsOf(fn: string): Map<string, string[]> {
  const re = new RegExp(`(?<!function\\s)\\b${fn}\\(`, "g");
  const out = new Map<string, string[]>();
  for (const [file, src] of sources) {
    for (const m of src.matchAll(re)) {
      const args = statementFrom(src, (m.index ?? 0) + m[0].length);
      const list = out.get(file) ?? [];
      list.push(args.replace(/\s+/g, " ").trim());
      out.set(file, list);
    }
  }
  return out;
}

/**
 * A receiver is a service client in its file when the file binds it to
 * createServiceClient(...) / serviceClient(), and its serviceClient() is the
 * service-role one (local, or lib/xapi/auth's). `serviceClient()` itself is
 * checked the same way. Parameters are listed as such and checked at their
 * callers below.
 */
function isServiceReceiver(file: string, receiver: string): boolean {
  const src = sources.get(file) ?? "";
  const localServiceFn =
    /function serviceClient\(\)[^{]*\{[^}]*SUPABASE_SERVICE_ROLE_KEY/.test(src) ||
    /import \{[^}]*\bserviceClient\b[^}]*\} from "@\/lib\/xapi\/auth"/.test(src);
  if (receiver === "serviceClient()") return localServiceFn;
  const id = receiver.replace(/[.$]/g, (c) => `\\${c}`);
  const bound = new RegExp(`\\b(?:const|let)\\s+${id}\\s*(?::[^=]+)?=\\s*(createServiceClient\\(|serviceClient\\(\\))`).exec(src);
  if (!bound) return false;
  if (bound[1] === "serviceClient()") return localServiceFn;
  // createServiceClient must be supabase-js's, used with the service-role key.
  return /import \{[^}]*createClient as createServiceClient[^}]*\} from "@supabase\/supabase-js"/.test(src) &&
    /SUPABASE_SERVICE_ROLE_KEY/.test(src);
}

// ---------------------------------------------------------------- course_attempts
type Site = { receivers: string[]; params?: string[]; what: string };
const ATTEMPT_WRITES: Record<string, Site> = {
  "app/[org]/(learner)/courses/[courseId]/launch/page.tsx": {
    receivers: ["svcReset", "svcSlot", "svcAttempt", "svcAttempt"],
    what: "grant-retake reset, deactivated-slot close, journey tag, attempt insert",
  },
  "app/api/courses/[courseId]/language-preference/route.ts": { receivers: ["svc"], what: "language switch abandon" },
  "app/api/courses/[courseId]/packages/[packageId]/versions/route.ts": { receivers: ["svc"], what: "force-restart replace (multipart)" },
  "app/api/courses/[courseId]/packages/[packageId]/versions/[versionId]/restart/route.ts": { receivers: ["svc"], what: "per-version restart" },
  "lib/courses/direct-upload.ts": { receivers: ["svc"], what: "force-restart replace (direct upload)" },
  "lib/integrations/webhook.ts": { receivers: ["svc"], what: "webhook latch" },
  // updateAttemptFailSoft's own write: its client is the parameter, checked at every call below.
  "lib/courses/progress.ts": { receivers: ["svc"], params: ["svc"], what: "updateAttemptFailSoft" },
};
const FAILSOFT_CALLS: Record<string, Site> = {
  "app/api/scorm/[attemptId]/commit/route.ts": { receivers: ["svc"], what: "SCORM commit" },
  // updateProgressFromState(svc, …) passes its parameter on; its callers are checked below.
  "lib/courses/progress.ts": { receivers: ["svc"], params: ["svc"], what: "updateProgressFromState" },
  // processStatement({ supabase }) passes its parameter on; its caller is checked below.
  "lib/xapi/process-statement.ts": { receivers: ["supabase"], params: ["supabase"], what: "processStatement" },
};

console.log("\ncourse_attempts: every write site is a listed service-client write (ADR 0009 step 5)");
const attemptWrites = writesOn("course_attempts");
for (const [file, site] of Object.entries(ATTEMPT_WRITES)) {
  const got = (attemptWrites.get(file) ?? []).map((w) => w.receiver);
  eq(`${site.what}: receivers in file order`, got, site.receivers);
  for (const r of new Set(site.receivers)) {
    if (site.params?.includes(r)) continue;
    eq(`${site.what}: \`${r}\` is a service client`, isServiceReceiver(file, r), true);
  }
}
const unlistedAttemptWrites = [...attemptWrites.keys()].filter((f) => !(f in ATTEMPT_WRITES));
eq("no other file under app/, lib/, components/ writes course_attempts", unlistedAttemptWrites, []);

const failSoft = callsOf("updateAttemptFailSoft");
for (const [file, site] of Object.entries(FAILSOFT_CALLS)) {
  const got = (failSoft.get(file) ?? []).map((a) => a.split(",")[0].trim());
  eq(`updateAttemptFailSoft in ${site.what}: first arguments`, got, site.receivers);
  for (const r of new Set(site.receivers)) {
    if (site.params?.includes(r)) continue;
    eq(`updateAttemptFailSoft in ${site.what}: \`${r}\` is a service client`, isServiceReceiver(file, r), true);
  }
}
const unlistedFailSoft = [...failSoft.keys()].filter((f) => !(f in FAILSOFT_CALLS) && f !== "lib/courses/progress.ts");
eq("no other file calls updateAttemptFailSoft", unlistedFailSoft, []);

console.log("\ncourse_attempts: parameter pass-throughs receive a service client at every call");
{
  const ps = callsOf("processStatement");
  const psFiles = [...ps.keys()].filter((f) => f !== "lib/xapi/process-statement.ts");
  eq("processStatement is called from the xAPI statements route only", psFiles, ["app/api/xapi/statements/route.ts"]);
  const psArgs = ps.get("app/api/xapi/statements/route.ts") ?? [];
  eq("processStatement receives supabase: svc", psArgs.length > 0 && psArgs.every((a) => /\bsupabase:\s*svc\b/.test(a)), true);
  eq("statements route: `svc` is a service client", isServiceReceiver("app/api/xapi/statements/route.ts", "svc"), true);

  const up = callsOf("updateProgressFromState");
  const upFiles = [...up.keys()].filter((f) => f !== "lib/courses/progress.ts");
  eq("updateProgressFromState is called from the xAPI state route only", upFiles, ["app/api/xapi/activities/state/route.ts"]);
  const upArgs = up.get("app/api/xapi/activities/state/route.ts") ?? [];
  eq("updateProgressFromState receives svc", upArgs.length > 0 && upArgs.every((a) => /^svc\b/.test(a)), true);
  eq("state route: `svc` is a service client", isServiceReceiver("app/api/xapi/activities/state/route.ts", "svc"), true);
  eq(
    "lib/xapi/auth serviceClient() uses the service-role key",
    /const serviceClient = \(\) => \{[^}]*SUPABASE_SERVICE_ROLE_KEY/.test(sources.get("lib/xapi/auth.ts") ?? "") &&
      /export \{[^}]*\bserviceClient\b[^}]*\}/.test(sources.get("lib/xapi/auth.ts") ?? ""),
    true
  );
}

console.log("\ncourse_attempts: the moved writes carry their explicit filters (ADR 0009 steps 2-4)");
{
  const launch = attemptWrites.get("app/[org]/(learner)/courses/[courseId]/launch/page.tsx") ?? [];
  const tag = launch.find((w) => w.receiver === "svcAttempt" && w.method === "update");
  const ins = launch.find((w) => w.receiver === "svcAttempt" && w.method === "insert");
  eq("journey tag: .eq(id) .eq(user_id) .eq(organization_id)", !!tag &&
    /\.eq\("id", existing\.id\)/.test(tag.stmt) &&
    /\.eq\("user_id", user\.id\)/.test(tag.stmt) &&
    /\.eq\("organization_id", org\.id\)/.test(tag.stmt), true);
  eq("attempt insert: user_id = session user, organization_id = org", !!ins &&
    /\buser_id: user\.id\b/.test(ins.stmt) &&
    /\borganization_id: org\.id\b/.test(ins.stmt) &&
    /\bcourse_version_id: v\.id\b/.test(ins.stmt), true);
  const commit = sources.get("app/api/scorm/[attemptId]/commit/route.ts") ?? "";
  eq("SCORM commit: updateAttemptFailSoft(svc, attemptId, update, { userId: user.id })",
    /updateAttemptFailSoft\(svc, attemptId, update, \{ userId: user\.id \}\)/.test(commit), true);
  eq("SCORM commit: the attempt read stays on the caller client, own rows only",
    /await supabase\s*\.from\("course_attempts"\)\s*\.select\([\s\S]*?\)\s*\.eq\("id", attemptId\)\s*\.eq\("user_id", user\.id\)/.test(commit), true);
  eq("SCORM commit: an abandoned attempt still answers 410",
    /if \(a\?\.status === "abandoned"\) return attemptAbandonedResponse\(\);/.test(commit) &&
    /if \(error\?\.abandoned\) return attemptAbandonedResponse\(\);/.test(commit), true);
  const progress = sources.get("lib/courses/progress.ts") ?? "";
  eq("updateAttemptFailSoft: .eq(id) .neq(status, abandoned) and the user_id filter",
    /\.eq\("id", attemptId\)\s*\.neq\("status", "abandoned"\)/.test(progress) &&
    /if \(extra\?\.userId\) q = q\.eq\("user_id", extra\.userId\);/.test(progress), true);
}

// ---------------------------------------------------------------- package_validations
const VALIDATION_WRITES: Record<string, Site> = {
  "app/api/courses/validate-package/route.ts": {
    receivers: ["serviceClient()", "serviceClient()", "serviceClient()", "serviceClient()"],
    what: "override, validate_existing, reject, pending insert",
  },
  "lib/courses/validation/gate.ts": {
    receivers: ["serviceClient()", "serviceClient()", "serviceClient()", "svc", "serviceClient()"],
    what: "accept, blocked insert, inline insert, accept-time recheck, link to version",
  },
  "lib/courses/direct-upload.ts": {
    receivers: ["svc", "svc", "serviceClient()", "serviceClient()"],
    what: "finalize integrity (2), consume, acknowledge",
  },
};

console.log("\npackage_validations: every write site is a listed service-client write (ADR 0008 C)");
const validationWrites = writesOn("package_validations");
for (const [file, site] of Object.entries(VALIDATION_WRITES)) {
  const writes = validationWrites.get(file) ?? [];
  eq(`${site.what}: receivers in file order`, writes.map((w) => w.receiver), site.receivers);
  for (const r of new Set(site.receivers)) {
    eq(`${site.what}: \`${r}\` is a service client`, isServiceReceiver(file, r), true);
  }
  eq(
    `${site.what}: every write names organization_id`,
    writes.map((w) =>
      w.method === "insert"
        ? /\borganization_id:/.test(w.stmt)
        : /\.eq\("organization_id",/.test(w.stmt) && /\.eq\("id",/.test(w.stmt)
    ),
    writes.map(() => true)
  );
}
const unlistedValidationWrites = [...validationWrites.keys()].filter((f) => !(f in VALIDATION_WRITES));
eq("no other file under app/, lib/, components/ writes package_validations", unlistedValidationWrites, []);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
