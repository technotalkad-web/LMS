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
 *   - every `updateAttemptFailSoft(` call is listed the same way, and the
 *     functions that pass a parameter through (processStatement,
 *     updateProgressFromState, forceRestartOlderVersions) are checked at
 *     their call sites;
 *   - the sites ADR 0009 steps 2-4 moved carry their explicit filters, and
 *     every package_validations write names organization_id.
 *
 * A receiver is resolved lexically with the TypeScript parser: the binding
 * or parameter of that name in scope at the write (the enclosing functions'
 * parameters and the bindings declared before it in the enclosing blocks),
 * not the first binding of the name anywhere in the file.
 *
 * Run:  npx tsx tests/unit/attempt-write-sites.test.ts   (or npm run test:unit)
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

type Write = { receiver: string; stmt: string; method: string; at: number };
function writesOn(table: string): Map<string, Write[]> {
  const re = new RegExp(`\\.from\\(\\s*["'\`]${table}["'\`]\\s*\\)`, "g");
  const out = new Map<string, Write[]>();
  for (const [file, src] of sources) {
    for (const m of src.matchAll(re)) {
      const stmt = statementFrom(src, (m.index ?? 0) + m[0].length);
      const w = /\.(insert|update|upsert|delete)\(/.exec(stmt);
      if (!w) continue;
      const list = out.get(file) ?? [];
      list.push({ receiver: receiverBefore(src, m.index ?? 0), stmt, method: w[1], at: m.index ?? 0 });
      out.set(file, list);
    }
  }
  return out;
}

type Call = { args: string; at: number };
function callsOf(fn: string): Map<string, Call[]> {
  const re = new RegExp(`(?<!function\\s)\\b${fn}\\(`, "g");
  const out = new Map<string, Call[]>();
  for (const [file, src] of sources) {
    for (const m of src.matchAll(re)) {
      const args = statementFrom(src, (m.index ?? 0) + m[0].length);
      const list = out.get(file) ?? [];
      list.push({ args: args.replace(/\s+/g, " ").trim(), at: m.index ?? 0 });
      out.set(file, list);
    }
  }
  return out;
}

const asts = new Map<string, ts.SourceFile>();
function ast(file: string): ts.SourceFile {
  let sf = asts.get(file);
  if (!sf) {
    sf = ts.createSourceFile(file, sources.get(file) ?? "", ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    asts.set(file, sf);
  }
  return sf;
}
function bindsName(name: ts.BindingName, id: string): boolean {
  if (ts.isIdentifier(name)) return name.text === id;
  return name.elements.some((e) => !ts.isOmittedExpression(e) && bindsName(e.name, id));
}
type Decl = { kind: "binding"; init: string } | { kind: "param" } | null;
/**
 * The declaration of `id` in scope at offset `at`: walking out from the
 * innermost node, an enclosing function's parameter, or a `const`/`let`
 * declared before `at` directly in an enclosing block (or the file).
 */
function declarationAt(file: string, at: number, id: string): Decl {
  const sf = ast(file);
  const chain: ts.Node[] = [];
  let node: ts.Node = sf;
  for (;;) {
    chain.push(node);
    const child = node.getChildren(sf).find((c) => c.getStart(sf) <= at && at < c.getEnd());
    if (!child) break;
    node = child;
  }
  for (let i = chain.length - 1; i >= 0; i--) {
    const n = chain[i];
    if (ts.isFunctionLike(n) && n.parameters.some((p) => bindsName(p.name, id))) return { kind: "param" };
    const stmts = ts.isBlock(n) || ts.isSourceFile(n) || ts.isCaseClause(n) || ts.isDefaultClause(n) ? n.statements : null;
    if (!stmts) continue;
    let found: Decl = null;
    for (const st of stmts) {
      if (st.getStart(sf) >= at) break;
      if (!ts.isVariableStatement(st)) continue;
      for (const d of st.declarationList.declarations) {
        if (bindsName(d.name, id)) found = { kind: "binding", init: d.initializer ? d.initializer.getText(sf) : "" };
      }
    }
    if (found) {
      // `const { supabase } = opts` with `opts` a parameter: a pass-through.
      if (found.kind === "binding" && /^[A-Za-z_$][\w$]*$/.test(found.init) && !ts.isSourceFile(n)) {
        const outer = declarationAt(file, stmtStartOf(n, at, sf), found.init);
        if (outer?.kind === "param") return { kind: "param" };
      }
      return found;
    }
  }
  return null;
}
/** An offset inside `block` before `at` (used to resolve a destructuring source). */
function stmtStartOf(block: ts.Node, at: number, sf: ts.SourceFile): number {
  const stmts = (block as ts.Block).statements ?? [];
  const first = stmts.find((st) => st.getStart(sf) < at);
  return first ? first.getStart(sf) : at;
}
const isParamAt = (file: string, at: number, id: string) => declarationAt(file, at, id)?.kind === "param";

/**
 * A receiver is a service client at offset `at` when the binding in scope
 * there is createServiceClient(...) / serviceClient(), and the file's
 * serviceClient() is the service-role one (local, or lib/xapi/auth's).
 * `serviceClient()` itself is checked the same way. A parameter is never a
 * service client here: pass-throughs are listed as such and checked at
 * their callers below.
 */
function isServiceReceiver(file: string, receiver: string, at: number): boolean {
  const src = sources.get(file) ?? "";
  const localServiceFn =
    /function serviceClient\(\)[^{]*\{[^}]*SUPABASE_SERVICE_ROLE_KEY/.test(src) ||
    /import \{[^}]*\bserviceClient\b[^}]*\} from "@\/lib\/xapi\/auth"/.test(src);
  if (receiver === "serviceClient()") return localServiceFn;
  if (!/^[A-Za-z_$][\w$]*$/.test(receiver)) return false;
  const decl = declarationAt(file, at, receiver);
  if (!decl || decl.kind !== "binding") return false;
  const init = decl.init.replace(/^await\s+/, "");
  if (init === "serviceClient()") return localServiceFn;
  // createServiceClient must be supabase-js's, used with the service-role key.
  return init.startsWith("createServiceClient(") &&
    /import \{[^}]*createClient as createServiceClient[^}]*\} from "@supabase\/supabase-js"/.test(src) &&
    /SUPABASE_SERVICE_ROLE_KEY/.test(init);
}

// ---------------------------------------------------------------- course_attempts
type Site = { receivers: string[]; params?: string[]; what: string };
const ATTEMPT_WRITES: Record<string, Site> = {
  "app/[org]/(learner)/courses/[courseId]/launch/page.tsx": {
    receivers: ["svcReset", "svcSlot", "svcAttempt", "svcAttempt"],
    what: "grant-retake reset, deactivated-slot close, journey tag, attempt insert",
  },
  "app/api/courses/[courseId]/language-preference/route.ts": { receivers: ["svc"], what: "language switch abandon" },
  "app/api/courses/[courseId]/packages/[packageId]/versions/[versionId]/restart/route.ts": { receivers: ["svc"], what: "per-version restart" },
  // ADR 0011 step 12: the force-restart writes of versions/route.ts (multipart)
  // and lib/courses/direct-upload.ts (direct upload) moved here, one write
  // for both paths; its client is the parameter, checked at both callers below.
  "lib/attempts/force-restart.ts": { receivers: ["svc"], params: ["svc"], what: "forced restart (both replace paths)" },
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
  const writes = attemptWrites.get(file) ?? [];
  eq(`${site.what}: receivers in file order`, writes.map((w) => w.receiver), site.receivers);
  eq(
    `${site.what}: each receiver is the service client in scope at its write`,
    writes.map((w) => (site.params?.includes(w.receiver) ? isParamAt(file, w.at, w.receiver) : isServiceReceiver(file, w.receiver, w.at))),
    writes.map(() => true)
  );
}
const unlistedAttemptWrites = [...attemptWrites.keys()].filter((f) => !(f in ATTEMPT_WRITES));
eq("no other file under app/, lib/, components/ writes course_attempts", unlistedAttemptWrites, []);

const failSoft = callsOf("updateAttemptFailSoft");
for (const [file, site] of Object.entries(FAILSOFT_CALLS)) {
  const calls = failSoft.get(file) ?? [];
  const firstArg = (c: Call) => c.args.split(",")[0].trim();
  eq(`updateAttemptFailSoft in ${site.what}: first arguments`, calls.map(firstArg), site.receivers);
  eq(
    `updateAttemptFailSoft in ${site.what}: each client is the service client (or the listed parameter) in scope`,
    calls.map((c) => (site.params?.includes(firstArg(c)) ? isParamAt(file, c.at, firstArg(c)) : isServiceReceiver(file, firstArg(c), c.at))),
    calls.map(() => true)
  );
}
const unlistedFailSoft = [...failSoft.keys()].filter((f) => !(f in FAILSOFT_CALLS) && f !== "lib/courses/progress.ts");
eq("no other file calls updateAttemptFailSoft", unlistedFailSoft, []);

console.log("\ncourse_attempts: parameter pass-throughs receive a service client at every call");
{
  const ps = callsOf("processStatement");
  const psFiles = [...ps.keys()].filter((f) => f !== "lib/xapi/process-statement.ts");
  eq("processStatement is called from the xAPI statements route only", psFiles, ["app/api/xapi/statements/route.ts"]);
  const psCalls = ps.get("app/api/xapi/statements/route.ts") ?? [];
  eq("processStatement receives supabase: svc", psCalls.length > 0 && psCalls.every((c) => /\bsupabase:\s*svc\b/.test(c.args)), true);
  eq(
    "statements route: `svc` is the service client in scope at every processStatement call",
    psCalls.map((c) => isServiceReceiver("app/api/xapi/statements/route.ts", "svc", c.at)),
    psCalls.map(() => true)
  );

  const up = callsOf("updateProgressFromState");
  const upFiles = [...up.keys()].filter((f) => f !== "lib/courses/progress.ts");
  eq("updateProgressFromState is called from the xAPI state route only", upFiles, ["app/api/xapi/activities/state/route.ts"]);
  const upCalls = up.get("app/api/xapi/activities/state/route.ts") ?? [];
  eq("updateProgressFromState receives svc", upCalls.length > 0 && upCalls.every((c) => /^svc\b/.test(c.args)), true);
  eq(
    "state route: `svc` is the service client in scope at every updateProgressFromState call",
    upCalls.map((c) => isServiceReceiver("app/api/xapi/activities/state/route.ts", "svc", c.at)),
    upCalls.map(() => true)
  );

  // ADR 0011 step 12: forceRestartOlderVersions(svc, …) writes with its
  // parameter; its two callers must pass the service client.
  const fr = callsOf("forceRestartOlderVersions");
  const MULTIPART = "app/api/courses/[courseId]/packages/[packageId]/versions/route.ts";
  const DIRECT = "lib/courses/direct-upload.ts";
  eq("forceRestartOlderVersions is called from the two replace paths only", [...fr.keys()].sort(), [MULTIPART, DIRECT].sort());
  const firstArgOf = (c: Call) => c.args.split(",")[0].trim();
  const mpCalls = fr.get(MULTIPART) ?? [];
  eq("multipart replace: one call, first argument svc", mpCalls.map(firstArgOf), ["svc"]);
  eq(
    "multipart replace: `svc` is the service client in scope at the call",
    mpCalls.map((c) => isServiceReceiver(MULTIPART, "svc", c.at)),
    mpCalls.map(() => true)
  );
  const duCalls = fr.get(DIRECT) ?? [];
  eq("direct finalize: one call, first argument serviceClient()", duCalls.map(firstArgOf), ["serviceClient()"]);
  eq(
    "direct finalize: serviceClient() is the service-role one",
    duCalls.map((c) => isServiceReceiver(DIRECT, "serviceClient()", c.at)),
    duCalls.map(() => true)
  );
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
  // ADR 0011: the forced restart's update is id-bound and keeps today's conditions.
  const fr = (attemptWrites.get("lib/attempts/force-restart.ts") ?? [])[0];
  eq("forced restart: .update({ status: abandoned }) .in(id) .in(course_version_id) .eq(status, in_progress)", !!fr &&
    /\.update\(\{ status: "abandoned" \}\)/.test(fr.stmt) &&
    /\.in\("id", ids\)/.test(fr.stmt) &&
    /\.in\("course_version_id", versionIds\)/.test(fr.stmt) &&
    /\.eq\("status", "in_progress"\)/.test(fr.stmt), true);
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
  eq(
    `${site.what}: each receiver is the service client in scope at its write`,
    writes.map((w) => isServiceReceiver(file, w.receiver, w.at)),
    writes.map(() => true)
  );
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
