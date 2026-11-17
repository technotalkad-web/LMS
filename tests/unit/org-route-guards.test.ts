/**
 * Source scan for the org-route rule (every route.ts under app/):
 *
 *   a route handler that makes a service-role write, an auth admin call, a
 *   storage write, or an external fetch checks the caller's role explicitly
 *   BEFORE that call, or its route is on the short allow-list below with
 *   the reason it needs no org role.
 *
 * Reading the org row, or any members-visible row, on the caller's session
 * is not a role check: every member can read it. RLS on a later write is not
 * one either (an update or delete RLS refuses changes no row and returns no
 * error). Writes made only on the caller's session, relying on RLS, are
 * outside the rule.
 *
 * How it reads the code (TypeScript's parser, no type checker, no network):
 *   - handlers: the exported GET / POST / PUT / PATCH / DELETE / HEAD /
 *     OPTIONS, including `export const GET = POST` and `= handle`;
 *   - calls are followed into same-file helpers and into project modules
 *     (`@/…` and relative imports, re-exports included), so an effect inside
 *     lib (sso-admin, the Cloudflare client, notifyBackground…) counts at the
 *     route's call site. A helper declared inside the handler counts where it
 *     is called;
 *   - effects: a write (insert / update / upsert / delete / rpc / storage
 *     upload…) on a service-role client (createClient from supabase-js with
 *     the service-role key, named in place or held in a local; a helper
 *     returning one; one carried in a helper's answer, `c.svc` or
 *     `const { svc } = …`; passed along through parameters too), any
 *     `.auth.admin.*` call, a storage-adapter write (getStorage(): upload /
 *     getSignedUploadUrl / delete / deletePrefix), and any `fetch(`.
 *     Service-role READS are not effects;
 *   - guards, recognised only in the route file's own code: an `if` that
 *     tests the caller's role and returns (or throws) on the arm the
 *     refused caller takes, or a call to requirePlatformOwner (it redirects
 *     by itself). The role test is the answer of requireOrgAdminApi /
 *     isOrgAdminCaller / requirePlatformOwnerApi, a platform_owners lookup
 *     of the caller, or a
 *     comparison with a role name (`role === "admin"`,
 *     `[...roles].includes(role)`, canManage(role)…) of a value read from a
 *     lookup of the caller (an organization_members read selecting role
 *     with `.eq("user_id", …)`, requireOrgAccess, or loadTicketForCaller,
 *     whose `party` is "admin" only for an active admin of the ticket's
 *     org); directly in the condition or through a variable holding one. A
 *     comparison on anything else (a body field), a membership-only test
 *     (`if (!member) return`), requireOrgAccess alone (every member passes
 *     it) and a role helper whose answer is never tested are not guards. An
 *     exiting `if` inside a same-file helper (ctx()) protects that helper's
 *     own effects; for the caller the helper's answer is a role test it
 *     must still act on. A role test a helper computes without exiting
 *     counts only where the caller tests the part of the answer that
 *     carries it (`return { svc, admin }`: `if (!c.admin)` guards,
 *     `if ("error" in c)` does not);
 *   - control flow: a guard covers the effects after it in the block that
 *     holds its `if`, and the arm of the `if` that only an allowed caller
 *     reaches. A block, an `if` arm, a loop body, a try / catch block, a
 *     case clause and a callback body are each a scope: a guard inside one
 *     covers nothing after it. After an `if`, the code is covered when every
 *     arm that falls through ends covered (an admin check in both arms). The
 *     direction of the test is read for the plain forms (`"error" in auth`,
 *     `x.error`, `!`, `&&`, `||`, role `===` / `!==`, a role-test call or a
 *     variable holding one): an exit on the arm an allowed caller takes
 *     (`if (!("error" in auth)) return`) is not a guard, nor is a test that
 *     only refuses in some cases (`if (body.action === "x" && !admin)`). A
 *     same-file helper's guard is a role test for its caller only when it
 *     covers the end of the helper.
 *
 * The scan is a tripwire for the common mistakes (no check at all, an org
 * read taken for one, a check placed after the call or in one branch only,
 * an inverted test), not a proof: the route tests prove the refusals
 * (tests/unit/org-admin-routes.test.ts). Known limits: a condition form it
 * does not model (a role-test result compared with something else) still
 * counts as a guard when an arm exits, as it did before; a helper that
 * returns its success answer early, before its guard, is not seen. Planted
 * cases at the end prove each part of the scan fires.
 *
 * Run:  npx tsx tests/unit/org-route-guards.test.ts   (or npm run test:unit)
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
const rel = (abs: string) => path.relative(root, abs).split(path.sep).join("/");

/* ---------------- the allow-list ---------------- */

/**
 * Handlers whose effects need no org role, each entry with its reason.
 *   - `handlers` names exact "file METHOD" pairs: a new handler, even in a
 *     listed file or folder, is not covered until it is added here.
 *   - `prefix` covers every route.ts under a folder and is only for machine
 *     callers; it must carry `requires`, the authority the reason names,
 *     which every flagged route file under the prefix must contain.
 * An entry, or a listed handler, that no longer matches a flagged handler
 * fails the test, so the list stays short and current.
 */
type Allow = { reason: string; prefix?: string; requires?: RegExp; handlers?: string[] };
const ALLOW: Allow[] = [
  { prefix: "app/api/cron/", requires: /CRON_SECRET/,
    reason: "scheduled jobs: authorised by the cron secret, no user session" },
  { prefix: "app/api/integrations/", requires: /authenticateApiKey\(/,
    reason: "machine-to-machine: authorised by the org's API key, which fixes the org" },
  { prefix: "app/api/xapi/", requires: /bindXapi\(|fetch_token/,
    reason: "content runtime: authorised by the launch token bound to the learner's own attempt" },
  { handlers: ["app/api/scorm/[attemptId]/commit/route.ts POST"],
    reason: "content runtime: the signed-in learner's own attempt (its webhook and emails are about that attempt)" },
  { handlers: [
      "app/api/auth/forgot-password/request/route.ts POST",
      "app/api/auth/forgot-password/reset/route.ts POST",
      "app/api/auth/forgot-password/verify/route.ts POST",
      "app/api/auth/magic-link/route.ts POST",
    ],
    reason: "public sign-in and password-reset flows: no session yet, so no org role applies" },
  { handlers: [
      "app/api/auth/change-password/route.ts POST",
      "app/auth/callback/route.ts GET",
      "app/auth/sign-out/route.ts POST",
    ],
    reason: "the caller's own account and session: their own password, sign-in and sign-out" },
  { handlers: ["app/api/invitations/accept/route.ts POST"],
    reason: "authorised by the invitation token, not by an org role" },
  { handlers: ["app/api/tickets/route.ts POST"],
    reason: "raising a ticket: any member on their own session; a manager ticket checks active membership and that everyone it names is in the caller's reporting line" },
  { handlers: ["app/api/tickets/[id]/messages/route.ts POST"],
    reason: "a reply on a ticket thread by its requester or by an admin of its org (loadTicketForCaller refuses anyone else)" },
  { handlers: ["app/api/upload/image/route.ts POST"],
    reason: "kind avatar is the caller's own profile photo (an active member, when the org allows uploads); every other kind checks the admin role in its own branch" },
  { handlers: ["app/api/manager/remind/route.ts POST"],
    reason: "manager action: checked against the caller's reporting line, not an org role" },
  { handlers: ["app/api/attempt-requests/route.ts POST"],
    reason: "a learner asks for another attempt on their own record (membership checked)" },
  { handlers: ["app/api/courses/[courseId]/language-preference/route.ts PUT"],
    reason: "self-service: the caller's own language preference row" },
  { handlers: ["app/api/broadcasts/route.ts POST"],
    reason: "self-service: the caller marks a platform broadcast read on their own row" },
];

/* ---------------- parsing and resolution ---------------- */

type Imp = { spec: string; name: string };
type Mod = {
  file: string;
  sf: ts.SourceFile;
  imports: Map<string, Imp>;
  fns: Map<string, ts.FunctionLikeDeclaration>;
  aliases: Map<string, ts.Expression>;
  exports: Map<string, { local?: string; spec?: string; name?: string }>;
  stars: string[];
};
type Target =
  | { kind: "fn"; mod: Mod; fn: ts.FunctionLikeDeclaration; name: string }
  | { kind: "external"; spec: string; name: string };

const skipOuter = (e: ts.Expression): ts.Expression => {
  for (;;) {
    if (ts.isParenthesizedExpression(e) || ts.isAwaitExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e) || ts.isTypeAssertionExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
    else return e;
  }
};
const isFnExpr = (e: ts.Expression): e is ts.ArrowFunction | ts.FunctionExpression => ts.isArrowFunction(e) || ts.isFunctionExpression(e);
const modifiers = (n: ts.Node) => (ts.canHaveModifiers(n) ? ts.getModifiers(n) ?? [] : []);
const hasMod = (n: ts.Node, k: ts.SyntaxKind) => modifiers(n).some((m) => m.kind === k);

function parse(file: string, text: string): Mod {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const m: Mod = { file, sf, imports: new Map(), fns: new Map(), aliases: new Map(), exports: new Map(), stars: [] };
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const c = st.importClause;
      if (!c || c.isTypeOnly) continue;
      const spec = st.moduleSpecifier.text;
      if (c.name) m.imports.set(c.name.text, { spec, name: "default" });
      const nb = c.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) m.imports.set(nb.name.text, { spec, name: "*" });
      if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) if (!el.isTypeOnly) m.imports.set(el.name.text, { spec, name: (el.propertyName ?? el.name).text });
      continue;
    }
    const exported = hasMod(st, ts.SyntaxKind.ExportKeyword);
    if (ts.isFunctionDeclaration(st) && st.name) {
      m.fns.set(st.name.text, st);
      if (exported) m.exports.set(hasMod(st, ts.SyntaxKind.DefaultKeyword) ? "default" : st.name.text, { local: st.name.text });
      continue;
    }
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) continue;
        const init = skipOuter(d.initializer);
        if (isFnExpr(init)) m.fns.set(d.name.text, init);
        else m.aliases.set(d.name.text, d.initializer);
        if (exported) m.exports.set(d.name.text, { local: d.name.text });
      }
      continue;
    }
    if (ts.isExportDeclaration(st) && !st.isTypeOnly) {
      const spec = st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : undefined;
      if (!st.exportClause) { if (spec) m.stars.push(spec); continue; }
      if (ts.isNamedExports(st.exportClause)) {
        for (const el of st.exportClause.elements) {
          const src = (el.propertyName ?? el.name).text;
          m.exports.set(el.name.text, spec ? { spec, name: src } : { local: src });
        }
      }
    }
  }
  return m;
}

const modCache = new Map<string, Mod | null>();
function resolveSpec(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(root, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(root, path.dirname(fromFile), spec);
  else return null;
  for (const c of [base + ".ts", base + ".tsx", path.join(base, "index.ts"), path.join(base, "index.tsx"), base]) {
    if (/\.tsx?$/.test(c) && fs.existsSync(c) && fs.statSync(c).isFile()) return rel(c);
  }
  return null;
}
function modAt(file: string): Mod | null {
  if (!modCache.has(file)) {
    const abs = path.join(root, file);
    modCache.set(file, fs.existsSync(abs) ? parse(file, fs.readFileSync(abs, "utf8")) : null);
  }
  return modCache.get(file) ?? null;
}
function resolveName(m: Mod, name: string, depth = 0): Target | null {
  if (depth > 20) return null;
  const fn = m.fns.get(name);
  if (fn) return { kind: "fn", mod: m, fn, name };
  const al = m.aliases.get(name);
  if (al) {
    const e = skipOuter(al);
    return ts.isIdentifier(e) ? resolveName(m, e.text, depth + 1) : null;
  }
  const imp = m.imports.get(name);
  if (imp && imp.name !== "*") {
    const f = resolveSpec(m.file, imp.spec);
    if (!f) return { kind: "external", spec: imp.spec, name: imp.name };
    const tm = modAt(f);
    return tm ? resolveExport(tm, imp.name, depth + 1) : null;
  }
  return null;
}
function resolveExport(m: Mod, name: string, depth = 0): Target | null {
  if (depth > 20) return null;
  const e = m.exports.get(name);
  if (e) {
    if (e.spec) {
      const f = resolveSpec(m.file, e.spec);
      if (!f) return { kind: "external", spec: e.spec, name: e.name ?? name };
      const tm = modAt(f);
      return tm ? resolveExport(tm, e.name ?? name, depth + 1) : null;
    }
    return resolveName(m, e.local ?? name, depth + 1);
  }
  for (const s of m.stars) {
    const f = resolveSpec(m.file, s);
    const tm = f ? modAt(f) : null;
    const r = tm ? resolveExport(tm, name, depth + 1) : null;
    if (r) return r;
  }
  return null;
}

/* ---------------- the walk ---------------- */

/**
 * "effect" / "safe-effect": an effect with no guard covering it / one a
 * guard covers (in the walked function, or at the call site of a helper).
 * "ret-check" / "ret-prop": the walked function returns a role-test result
 * (whole, or in property `what`); lift() turns them into the caller's
 * "check" / "check-prop". "end": the last event of a walked function body,
 * `what` "covered" when a guard covers its end.
 */
type Ev = { kind: "effect" | "safe-effect" | "guard" | "lookup" | "check" | "check-prop" | "ret-check" | "ret-prop" | "end"; what: string };
type Ctx = {
  m: Mod;
  route: boolean; // walking the route file's own code: guards count here only
  /** A guard covers the code being walked (scoped: see visit()). */
  g: boolean;
  service: Set<string>;
  storage: Set<string>;
  closures: Map<string, ts.FunctionLikeDeclaration>;
  stack: ts.Node[];
  /** Names holding the caller's looked-up role (or a value derived from it). */
  roleVars: Set<string>;
  /** Names holding the result of a role test (`const canWrite = role === "admin"`). */
  checkVars: Set<string>;
  /** The checkVars whose value is true for a refused caller (`const denied = !canManage(role)`). */
  refuseVars: Set<string>;
  /** "name.prop" holding a role-test result in a helper's answer (`const c = await ctx()` → "c.admin"). */
  checkProps: Set<string>;
  /** Names holding an object with a service client in some properties (`const c = await ctx()` → c.svc). */
  serviceObjs: Map<string, Set<string>>;
};
/** svcObj entries are "param.prop": the parameter holds an object whose `prop` is a service client. */
type Params = { svc: string[]; storage: string[]; role: string[]; check: string[]; svcObj: string[] };
const NO_PARAMS: Params = { svc: [], storage: [], role: [], check: [], svcObj: [] };

const WRITE_METHODS = new Set(["insert", "update", "upsert", "delete"]);
const STORAGE_WRITES = new Set(["upload", "update", "remove", "move", "copy", "createSignedUploadUrl", "uploadToSignedUrl"]);
const ADAPTER_WRITES = new Set(["upload", "getSignedUploadUrl", "delete", "deletePrefix"]);
/** lib/auth helpers whose answer is the caller's role test (the route must act on it). */
const ROLE_GUARD_FNS = new Set(["requireOrgAdminApi", "isOrgAdminCaller", "requirePlatformOwnerApi"]);
/** lib/auth helpers that refuse by themselves (redirect). */
const SELF_GUARDS = new Set(["requirePlatformOwner"]);
/** Role tests that guard once the caller's role is known. */
const ROLE_TESTS = new Set(["canManage", "canManageOwners", "canViewReports", "isOrgAdminRole"]);
const ROLE_NAMES = new Set(["super_owner", "owner", "admin", "data_analyst", "user", "member"]);
/** The role names an admin-only check lets through: `=== "admin"` is true for an allowed caller, `=== "user"` for a refused one. */
const ADMIN_ROLE_NAMES = new Set(["super_owner", "owner", "admin"]);
/** "file name": lookups of the caller whose answer carries the caller's role (requireOrgAccess: `.role`; loadTicketForCaller: `.party`, "admin" only for an active admin of the ticket's org). */
const CALLER_LOOKUPS = new Set(["lib/auth/require-org-access.ts requireOrgAccess", "lib/tickets/auth.ts loadTicketForCaller"]);

/**
 * The receiver chain of a call: `a.from("t").select("x").eq(…)` → segs from,
 * select, eq; root `a`. `nodes` holds every receiver on the way down (so
 * `c.svc.from("t")` offers `c.svc` as well as `c`).
 */
function chainOf(expr: ts.Expression) {
  const segs: Array<{ name: string; args: readonly ts.Expression[] }> = [];
  const props: string[] = [];
  const nodes: ts.Expression[] = [];
  let e = skipOuter(expr);
  for (;;) {
    nodes.push(e);
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(skipOuter(e.expression))) {
      const pa = skipOuter(e.expression) as ts.PropertyAccessExpression;
      segs.unshift({ name: pa.name.text, args: e.arguments });
      props.unshift(pa.name.text);
      e = skipOuter(pa.expression);
    } else if (ts.isPropertyAccessExpression(e)) {
      props.unshift(e.name.text);
      e = skipOuter(e.expression);
    } else break;
  }
  return { segs, props, root: e, nodes };
}
const strArg = (a: ts.Expression | undefined) => (a && ts.isStringLiteralLike(a) ? a.text : null);

function calleeTarget(c: { m: Mod; closures?: Map<string, ts.FunctionLikeDeclaration> }, callee: ts.Expression): Target | null {
  const e = skipOuter(callee);
  if (ts.isIdentifier(e)) {
    const local = c.closures?.get(e.text);
    if (local) return { kind: "fn", mod: c.m, fn: local, name: e.text };
    return resolveName(c.m, e.text);
  }
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) {
    const imp = c.m.imports.get(e.expression.text);
    if (imp?.name === "*") {
      const f = resolveSpec(c.m.file, imp.spec);
      const tm = f ? modAt(f) : null;
      return tm ? resolveExport(tm, e.name.text) : { kind: "external", spec: imp.spec, name: e.name.text };
    }
  }
  return null;
}

const moduleServiceCache = new WeakMap<Mod, Set<string>>();
function moduleService(m: Mod): Set<string> {
  let s = moduleServiceCache.get(m);
  if (!s) {
    s = new Set();
    moduleServiceCache.set(m, s);
    for (const [name, e] of m.aliases) if (isServiceExpr(e, { m, service: s })) s.add(name);
  }
  return s;
}

type SvcScope = { m: Mod; service: Set<string>; serviceObjs?: Map<string, Set<string>>; closures?: Map<string, ts.FunctionLikeDeclaration> };

/** The initializer of the nearest `const name = …` in a block (or the module) enclosing `at`. */
function declInit(at: ts.Node, name: string): ts.Expression | null {
  for (let p: ts.Node | undefined = at.parent; p; p = p.parent) {
    if (!ts.isBlock(p) && !ts.isSourceFile(p)) continue;
    for (const st of p.statements) {
      if (!ts.isVariableStatement(st)) continue;
      for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer) return d.initializer;
    }
  }
  return null;
}
/** A createClient argument that is the service-role key: named in place, or a local bound to it (`const key = process.env.SUPABASE_SERVICE_ROLE_KEY`). */
const isServiceKeyArg = (a0: ts.Expression) => {
  const a = skipOuter(a0);
  if (/SERVICE_ROLE/.test(a.getText())) return true;
  if (!ts.isIdentifier(a)) return false;
  const init = declInit(a, a.text);
  return !!init && /SERVICE_ROLE/.test(init.getText());
};

function isServiceExpr(e0: ts.Expression, c: SvcScope): boolean {
  const e = skipOuter(e0);
  if (ts.isIdentifier(e)) return c.service.has(e.text) || moduleService(c.m).has(e.text);
  if (ts.isConditionalExpression(e)) return isServiceExpr(e.whenTrue, c) || isServiceExpr(e.whenFalse, c);
  if (ts.isBinaryExpression(e) && (e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || e.operatorToken.kind === ts.SyntaxKind.BarBarToken)) return isServiceExpr(e.left, c) || isServiceExpr(e.right, c);
  // `c.svc` where c holds a helper's answer carrying a service client, or `(await ctx()).svc`.
  if (ts.isPropertyAccessExpression(e)) {
    const obj = skipOuter(e.expression);
    if (ts.isIdentifier(obj)) return c.serviceObjs?.get(obj.text)?.has(e.name.text) ?? false;
    if (ts.isCallExpression(obj)) {
      const t = calleeTarget(c, obj.expression);
      return t?.kind === "fn" && serviceProps(t.fn, t.mod).has(e.name.text);
    }
    return false;
  }
  if (ts.isCallExpression(e)) {
    const callee = skipOuter(e.expression);
    const t = calleeTarget(c, callee);
    if (t?.kind === "external") {
      if (t.spec !== "@supabase/supabase-js" || t.name !== "createClient") return false;
      const local = ts.isIdentifier(callee) ? callee.text : "";
      return /service|admin/i.test(local) || e.arguments.some(isServiceKeyArg);
    }
    if (t?.kind === "fn") return returnsService(t.fn, t.mod);
  }
  return false;
}

/** Statement-level names a function body binds to a service client (`const svc = …`, `svc = …`). */
function noteServiceBinding(n: ts.Node, local: SvcScope) {
  if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && isServiceExpr(n.initializer, local)) local.service.add(n.name.text);
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left) && isServiceExpr(n.right, local)) local.service.add(n.left.text);
}

const servicePropsCache = new WeakMap<ts.Node, Set<string>>();
/** The properties of the object a function returns that hold a service client (`return { svc, org }` → svc). */
function serviceProps(fn: ts.FunctionLikeDeclaration, m: Mod): Set<string> {
  const hit = servicePropsCache.get(fn);
  if (hit) return hit;
  const out = new Set<string>();
  servicePropsCache.set(fn, out); // recursion guard
  const local: SvcScope = { m, service: new Set(moduleService(m)) };
  const fromObject = (e0: ts.Expression) => { for (const p of objectServiceProps(e0, local)) out.add(p); };
  if (fn.body && !ts.isBlock(fn.body)) fromObject(fn.body as ts.Expression);
  const v = (n: ts.Node): void => {
    if (n !== fn.body && ts.isFunctionLike(n)) return;
    noteServiceBinding(n, local);
    if (ts.isReturnStatement(n) && n.expression) fromObject(n.expression);
    ts.forEachChild(n, v);
  };
  if (fn.body && ts.isBlock(fn.body)) v(fn.body);
  return out;
}
/** Properties of an object literal whose values are service clients. */
function objectServiceProps(e0: ts.Expression, c: SvcScope): Set<string> {
  const e = skipOuter(e0);
  const out = new Set<string>();
  if (!ts.isObjectLiteralExpression(e)) return out;
  for (const p of e.properties) {
    if (ts.isShorthandPropertyAssignment(p) && isServiceExpr(p.name, c)) out.add(p.name.text);
    else if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && isServiceExpr(p.initializer, c)) out.add(p.name.text);
  }
  return out;
}
/** The service-holding properties of the value an initializer gives a name. */
function serviceObjectOf(init: ts.Expression, c: SvcScope): Set<string> {
  const e = skipOuter(init);
  if (ts.isIdentifier(e)) return c.serviceObjs?.get(e.text) ?? new Set();
  if (ts.isObjectLiteralExpression(e)) return objectServiceProps(e, c);
  if (ts.isCallExpression(e)) {
    const t = calleeTarget(c, e.expression);
    if (t?.kind === "fn") return serviceProps(t.fn, t.mod);
  }
  return new Set();
}

const returnsServiceCache = new WeakMap<ts.Node, boolean>();
function returnsService(fn: ts.FunctionLikeDeclaration, m: Mod): boolean {
  const hit = returnsServiceCache.get(fn);
  if (hit !== undefined) return hit;
  returnsServiceCache.set(fn, false); // recursion guard
  const local: SvcScope = { m, service: new Set(moduleService(m)) };
  let found = false;
  if (fn.body && !ts.isBlock(fn.body)) found = isServiceExpr(fn.body as ts.Expression, local);
  const v = (n: ts.Node): void => {
    if (found) return;
    if (n !== fn.body && ts.isFunctionLike(n)) return;
    noteServiceBinding(n, local);
    if (ts.isReturnStatement(n) && n.expression && isServiceExpr(n.expression, local)) found = true;
    ts.forEachChild(n, v);
  };
  if (fn.body && ts.isBlock(fn.body)) v(fn.body);
  returnsServiceCache.set(fn, found);
  return found;
}

function isStorageExpr(e0: ts.Expression, c: { m: Mod; storage: Set<string>; closures?: Map<string, ts.FunctionLikeDeclaration> }): boolean {
  const e = skipOuter(e0);
  if (ts.isIdentifier(e)) return c.storage.has(e.text);
  if (ts.isNewExpression(e)) return /StorageAdapter$/.test(e.expression.getText());
  if (ts.isCallExpression(e)) {
    const t = calleeTarget(c, e.expression);
    return t?.kind === "fn" && t.mod.file.startsWith("lib/storage/") && (t.name === "getStorage" || t.name === "getStorageFor");
  }
  return false;
}

const paramNames = (fn: ts.FunctionLikeDeclaration, args: readonly ts.Expression[], test: (a: ts.Expression) => boolean) => {
  const out: string[] = [];
  fn.parameters.forEach((p, i) => { if (ts.isIdentifier(p.name) && args[i] && test(args[i])) out.push(p.name.text); });
  return out;
};
/** "param.prop" for each parameter given an object that carries a service client in `prop`. */
const objParamNames = (fn: ts.FunctionLikeDeclaration, args: readonly ts.Expression[], c: Ctx) => {
  const out: string[] = [];
  fn.parameters.forEach((p, i) => {
    if (!ts.isIdentifier(p.name) || !args[i]) return;
    for (const prop of serviceObjectOf(args[i], c)) out.push(`${p.name.text}.${prop}`);
  });
  return out;
};
const objMap = (entries: string[], base?: Map<string, Set<string>>) => {
  const out = new Map<string, Set<string>>();
  for (const [k, v] of base ?? []) out.set(k, new Set(v));
  for (const s of entries) {
    const [name, prop] = s.split(".");
    if (!out.has(name)) out.set(name, new Set());
    out.get(name)!.add(prop);
  }
  return out;
};

const walkCache = new WeakMap<ts.Node, Map<string, Ev[]>>();
/** Events of a module-level function, walked with fresh scope (memoised). */
function walkFn(fn: ts.FunctionLikeDeclaration, m: Mod, route: boolean, params: Params, stack: ts.Node[]): Ev[] {
  if (stack.includes(fn) || stack.length > 40) return [];
  const key = `${route}|${[params.svc, params.storage, params.role, params.check, params.svcObj].map((l) => [...l].sort().join(",")).join("|")}`;
  let byKey = walkCache.get(fn);
  const hit = byKey?.get(key);
  if (hit) return hit;
  const out: Ev[] = [];
  const c: Ctx = { m, route, g: false, service: new Set([...moduleService(m), ...params.svc]), storage: new Set(params.storage), closures: new Map(), stack: [...stack, fn], roleVars: new Set(params.role), checkVars: new Set(params.check), refuseVars: new Set(), checkProps: new Set(), serviceObjs: objMap(params.svcObj) };
  runBody(fn, c, out);
  if (!byKey) { byKey = new Map(); walkCache.set(fn, byKey); }
  byKey.set(key, out);
  return out;
}
/** Walks a function body in `c`, then records whether a guard covers its end. */
function runBody(fn: ts.FunctionLikeDeclaration, c: Ctx, out: Ev[]) {
  if (!fn.body) return;
  if (ts.isBlock(fn.body)) for (const st of fn.body.statements) visit(st, c, out);
  else visit(fn.body, c, out);
  out.push({ kind: "end", what: c.g ? "covered" : "open" });
}

/** True when `e` reads one of `names` (property names do not count: `body.role` reads `body`). */
function reads(e: ts.Node, names: Set<string>): boolean {
  if (ts.isIdentifier(e)) return names.has(e.text);
  if (ts.isPropertyAccessExpression(e)) return reads(e.expression, names);
  let hit = false;
  ts.forEachChild(e, (ch) => { if (!hit && reads(ch, names)) hit = true; });
  return hit;
}
const referencesRole = (e: ts.Node, c: Ctx) => reads(e, c.roleVars);
/** reads(), but not into a call: what a query or helper returned is not the role-test result it was given. */
function readsOutsideCalls(e: ts.Node, names: Set<string>): boolean {
  if (ts.isCallExpression(e) || ts.isNewExpression(e)) return false;
  if (ts.isIdentifier(e)) return names.has(e.text);
  if (ts.isPropertyAccessExpression(e)) return readsOutsideCalls(e.expression, names);
  let hit = false;
  ts.forEachChild(e, (ch) => { if (!hit && readsOutsideCalls(ch, names)) hit = true; });
  return hit;
}
/**
 * True when `e` reads a role-test result: a name in checkVars, or a property
 * in checkProps (`c.admin`). With `throughCalls` false, a read inside a call
 * does not count (`await db.from(…).eq("org", auth.org.id)` is data, not the test).
 */
function readsCheck(e: ts.Node, c: Ctx, throughCalls = true): boolean {
  if (throughCalls ? reads(e, c.checkVars) : readsOutsideCalls(e, c.checkVars)) return true;
  let hit = false;
  const v = (n: ts.Node): void => {
    if (hit) return;
    if (!throughCalls && (ts.isCallExpression(n) || ts.isNewExpression(n))) return;
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(skipOuter(n.expression)) && c.checkProps.has(`${(skipOuter(n.expression) as ts.Identifier).text}.${n.name.text}`)) { hit = true; return; }
    ts.forEachChild(n, v);
  };
  v(e);
  return hit;
}
/** A statement that leaves the handler: return / throw, or a block holding one at its top level. */
const exits = (s: ts.Statement): boolean =>
  ts.isReturnStatement(s) || ts.isThrowStatement(s) || (ts.isBlock(s) && s.statements.some((x) => ts.isReturnStatement(x) || ts.isThrowStatement(x)));
const bindingNames = (b: ts.BindingName): string[] =>
  ts.isIdentifier(b) ? [b.text] : b.elements.flatMap((el) => (ts.isOmittedExpression(el) ? [] : bindingNames(el.name)));

/**
 * A helper's events as the caller sees them: an exiting `if` inside the
 * helper only leaves the helper, so it protects the helper's effects it
 * covers (already safe-effect) and, when it covers the end of the helper,
 * is for the caller a role test to act on (check); a guard in one branch of
 * the helper only is not. A role test the helper computes without exiting
 * reaches the caller only through what the helper returns: the whole
 * answer (`return isAdmin` → check) or one property of it
 * (`return { svc, admin }` → check-prop admin, so `if (!c.admin)` guards and
 * `if ("error" in c)` does not). Role tests that stay inside the helper,
 * and inner helpers' returns, are dropped. Events are new objects or passed
 * through unchanged: walkFn's cached lists are shared.
 */
function lift(sub: Ev[], helper: string): Ev[] {
  const out: Ev[] = [];
  const covered = sub.some((e) => e.kind === "end" && e.what === "covered");
  let lifted = false;
  for (const e of sub) {
    if (e.kind === "guard") { if (covered && !lifted) { out.push({ kind: "check", what: `${e.what} in ${helper}()` }); lifted = true; } }
    else if (e.kind === "check" || e.kind === "check-prop" || e.kind === "end") continue;
    else if (e.kind === "ret-check") out.push({ kind: "check", what: `${helper}() answers a role test` });
    else if (e.kind === "ret-prop") out.push({ kind: "check-prop", what: e.what });
    else out.push(e);
  }
  return out;
}
/** A helper's effects called where a guard covers the call are covered too. */
const atCallSite = (evs: Ev[], c: Ctx): Ev[] => (c.g ? evs.map((e) => (e.kind === "effect" ? { kind: "safe-effect", what: e.what } : e)) : evs);

function invoke(t: Target & { kind: "fn" }, args: readonly ts.Expression[], c: Ctx, out: Ev[], closure: boolean) {
  if (c.stack.includes(t.fn)) return;
  const svcParams = paramNames(t.fn, args, (a) => isServiceExpr(a, c));
  const storageParams = paramNames(t.fn, args, (a) => isStorageExpr(a, c));
  const roleParams = paramNames(t.fn, args, (a) => referencesRole(a, c));
  const checkParams = paramNames(t.fn, args, (a) => readsCheck(a, c));
  const objParams = objParamNames(t.fn, args, c);
  if (closure) {
    // A helper declared inside the handler sees the handler's bindings.
    const child: Ctx = {
      ...c,
      g: false, // its own guards; the call site's cover is added below
      service: new Set([...c.service, ...svcParams]),
      storage: new Set([...c.storage, ...storageParams]),
      closures: new Map(c.closures),
      stack: [...c.stack, t.fn],
      roleVars: new Set([...c.roleVars, ...roleParams]),
      checkVars: new Set([...c.checkVars, ...checkParams]),
      refuseVars: new Set(c.refuseVars),
      checkProps: new Set(c.checkProps),
      serviceObjs: objMap(objParams, c.serviceObjs),
    };
    const sub: Ev[] = [];
    runBody(t.fn, child, sub);
    out.push(...atCallSite(lift(sub, t.name), c));
    return;
  }
  out.push(...atCallSite(lift(walkFn(t.fn, t.mod, c.route && t.mod === c.m, { svc: svcParams, storage: storageParams, role: roleParams, check: checkParams, svcObj: objParams }, c.stack), t.name), c));
}

function onCall(call: ts.CallExpression, c: Ctx, out: Ev[]) {
  const callee = skipOuter(call.expression);
  // An effect is covered when a guard covers the code walked here.
  const fx = (what: string) => out.push({ kind: c.g ? "safe-effect" : "effect", what });
  if (ts.isPropertyAccessExpression(callee)) {
    const own = callee.name.text;
    const ch = chainOf(callee.expression);
    const has = (n: string) => ch.segs.some((s) => s.name === n);
    const table = strArg(ch.segs.find((s) => s.name === "from")?.args[0]) ?? "?";
    // The receiver is a service client anywhere down the chain: `svc.from(…)`, `c.svc.from(…)`, `admin().from(…)`.
    const svc = ch.nodes.some((x) => isServiceExpr(x, c));
    if (WRITE_METHODS.has(own) && has("from") && svc) fx(`service-role ${own} on ${ch.props.includes("storage") ? "storage" : table}`);
    if (own === "rpc" && ch.segs.length === 0 && svc) fx(`service-role rpc ${strArg(call.arguments[0]) ?? "?"}`);
    if (STORAGE_WRITES.has(own) && !WRITE_METHODS.has(own) && ch.props.includes("storage") && svc) fx(`service-role storage ${own}`);
    const recv = skipOuter(callee.expression);
    if (ts.isPropertyAccessExpression(recv) && recv.name.text === "admin" && ts.isPropertyAccessExpression(skipOuter(recv.expression)) && (skipOuter(recv.expression) as ts.PropertyAccessExpression).name.text === "auth") {
      fx(`auth.admin.${own}`);
    }
    if (ADAPTER_WRITES.has(own) && ch.segs.length === 0 && ch.props.length === 0 && isStorageExpr(ch.root, c)) fx(`storage ${own}`);
    if (own === "fetch" && ts.isIdentifier(recv) && recv.text === "globalThis") fx("fetch");
  }
  if (ts.isIdentifier(callee) && callee.text === "fetch" && !c.closures.has("fetch") && !resolveName(c.m, "fetch")) fx("fetch");

  // Guards: only in the route file's own code.
  const isTop = !(ts.isPropertyAccessExpression(call.parent) && call.parent.expression === call);
  if (c.route && isTop && ts.isPropertyAccessExpression(callee)) {
    const ch = chainOf(call);
    const table = strArg(ch.segs.find((s) => s.name === "from")?.args[0]);
    const byCaller = ch.segs.some((s) => s.name === "eq" && strArg(s.args[0]) === "user_id");
    const selectsRole = ch.segs.some((s) => s.name === "select" && /\brole\b/.test(strArg(s.args[0]) ?? ""));
    if (table === "organization_members" && byCaller && selectsRole) out.push({ kind: "lookup", what: "organization_members role lookup" });
    if (table === "platform_owners" && byCaller) out.push({ kind: "check", what: "platform_owners lookup" });
    // roles.includes(role) / ROLES.has(role)
    const own = callee.name.text;
    if ((own === "includes" || own === "has") && call.arguments.length === 1 && referencesRole(call.arguments[0], c)) {
      const recv = skipOuter(callee.expression);
      const listOfRoles =
        (ts.isArrayLiteralExpression(recv) && recv.elements.some((el) => ROLE_NAMES.has(strArg(el) ?? ""))) ||
        /ROLES$/i.test(recv.getText());
      if (listOfRoles) out.push({ kind: "check", what: `role list test (${call.getText().slice(0, 60)})` });
    }
  }

  const t = calleeTarget(c, callee);
  if (t?.kind === "fn") {
    if (c.route && t.mod.file.startsWith("lib/auth/")) {
      if (SELF_GUARDS.has(t.name)) { out.push({ kind: "guard", what: t.name }); c.g = true; }
      else if (ROLE_GUARD_FNS.has(t.name)) out.push({ kind: "check", what: t.name });
      else if (ROLE_TESTS.has(t.name) && call.arguments.some((a) => referencesRole(a, c))) out.push({ kind: "check", what: t.name });
    }
    if (c.route && CALLER_LOOKUPS.has(`${t.mod.file} ${t.name}`)) out.push({ kind: "lookup", what: t.name });
    invoke(t, call.arguments, c, out, ts.isIdentifier(callee) && c.closures.get(callee.text) === t.fn);
  }
  // A function passed by name (`ids.map(sendOne)`) runs there.
  for (const a of call.arguments) {
    if (!ts.isIdentifier(a)) continue;
    const at = calleeTarget(c, a);
    if (at?.kind === "fn") invoke(at, [], c, out, c.closures.get(a.text) === at.fn);
  }
}

function onCompare(b: ts.BinaryExpression, c: Ctx, out: Ev[]) {
  if (!c.route) return;
  const k = b.operatorToken.kind;
  if (k !== ts.SyntaxKind.EqualsEqualsEqualsToken && k !== ts.SyntaxKind.ExclamationEqualsEqualsToken && k !== ts.SyntaxKind.EqualsEqualsToken && k !== ts.SyntaxKind.ExclamationEqualsToken) return;
  const [l, r] = [skipOuter(b.left), skipOuter(b.right)];
  const lit = strArg(l) ?? strArg(r);
  const other = strArg(l) !== null ? r : l;
  if (lit !== null && ROLE_NAMES.has(lit) && referencesRole(other, c)) {
    out.push({ kind: "check", what: `role comparison (${b.getText().slice(0, 60)})` });
  }
}

/** Walks one arm (an `if` branch, a try / catch block) starting from cover `g`; answers whether its end is covered. */
function arm(s: ts.Statement, g: boolean, c: Ctx, out: Ev[]): boolean {
  const g0 = c.g;
  c.g = g;
  if (ts.isBlock(s)) for (const st of s.statements) visit(st, c, out);
  else visit(s, c, out);
  const end = c.g;
  c.g = g0;
  return end;
}

/**
 * Which way a condition points, for the plain forms. cov: true for every
 * refused caller (so past `if (cond) return`, the caller is allowed); imp:
 * true only for an allowed caller. known: false when it reads a role-test
 * result in a form not modelled here (then the old rule applies).
 */
type Pol = { known: boolean; cov: boolean; imp: boolean };
const P_NEUTRAL: Pol = { known: true, cov: false, imp: false };
const P_ALLOW: Pol = { known: true, cov: false, imp: true };
const P_REFUSE: Pol = { known: true, cov: true, imp: false };
const P_UNKNOWN: Pol = { known: false, cov: false, imp: false };
const EQUALITY = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken]);
function pol(e0: ts.Expression, c: Ctx): Pol {
  const e = skipOuter(e0);
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
    const p = pol(e.operand, c);
    return { known: p.known, cov: p.imp, imp: p.cov };
  }
  if (ts.isBinaryExpression(e)) {
    const k = e.operatorToken.kind;
    if (k === ts.SyntaxKind.AmpersandAmpersandToken || k === ts.SyntaxKind.BarBarToken) {
      const a = pol(e.left, c);
      const b = pol(e.right, c);
      const and = k === ts.SyntaxKind.AmpersandAmpersandToken;
      return { known: a.known && b.known, cov: and ? a.cov && b.cov : a.cov || b.cov, imp: and ? a.imp || b.imp : a.imp && b.imp };
    }
    // `"error" in auth`: requireOrgAdminApi's (or a helper's) refusal.
    if (k === ts.SyntaxKind.InKeyword && strArg(skipOuter(e.left)) === "error" && readsCheck(e.right, c)) return P_REFUSE;
    if (EQUALITY.has(k)) {
      const [l, r] = [skipOuter(e.left), skipOuter(e.right)];
      const lit = strArg(l) ?? strArg(r);
      const other = strArg(l) !== null ? r : l;
      if (lit !== null && ROLE_NAMES.has(lit) && referencesRole(other, c)) {
        const positive = k === ts.SyntaxKind.EqualsEqualsEqualsToken || k === ts.SyntaxKind.EqualsEqualsToken;
        return positive === ADMIN_ROLE_NAMES.has(lit) ? P_ALLOW : P_REFUSE;
      }
    }
  }
  // A role-test call: canManage(role), isOrgAdminCaller(…), roles.includes(role), a helper answering one.
  if (ts.isCallExpression(e)) {
    const probe: Ev[] = [];
    visit(e, c, probe);
    if (probe.some((x) => x.kind === "check")) return P_ALLOW;
  }
  if (ts.isIdentifier(e) && c.refuseVars.has(e.text)) return P_REFUSE;
  if (ts.isPropertyAccessExpression(e) && e.name.text === "error" && readsCheck(e.expression, c)) return P_REFUSE;
  if ((ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) && readsCheck(e, c)) return P_ALLOW;
  return readsCheck(e, c) ? P_UNKNOWN : P_NEUTRAL;
}

function visit(n: ts.Node, c: Ctx, out: Ev[]): void {
  // A function declared in the walked body runs where it is called.
  if (ts.isFunctionDeclaration(n) && n.name) { c.closures.set(n.name.text, n); return; }
  // A name bound to the caller's role lookup (or to a value read from one)
  // holds the role; a name bound to a role test holds its result.
  const bind = (names: string[], init: ts.Expression, before: number) => {
    if (!c.route) return;
    const fresh = out.slice(before);
    if (fresh.some((e) => e.kind === "lookup") || reads(init, c.roleVars)) for (const x of names) c.roleVars.add(x);
    // A copy or combination of a role-test result is one too; data a call
    // returned when given one (a query filtered by the checked org) is not.
    if (fresh.some((e) => e.kind === "check" || e.kind === "guard") || readsCheck(init, c, false)) {
      // Which way the result points: `const denied = !canManage(role)` is true for a refused caller.
      const p = pol(init, c);
      const refuse = p.known && p.cov && !p.imp;
      for (const x of names) {
        c.checkVars.add(x);
        if (refuse) c.refuseVars.add(x); else c.refuseVars.delete(x);
      }
    }
  };
  /** The role-test properties of a helper's answer this binding receives (`c.admin`, or `admin` destructured). */
  const bindProps = (name: ts.BindingName, init: ts.Expression, before: number) => {
    if (!c.route) return;
    const props = new Set(out.slice(before).filter((e) => e.kind === "check-prop").map((e) => e.what));
    // From a name already holding such an answer: `const { admin } = c`, `const d = c`.
    const src = skipOuter(init);
    if (ts.isIdentifier(src)) for (const k of c.checkProps) if (k.startsWith(`${src.text}.`)) props.add(k.slice(src.text.length + 1));
    if (!props.size) return;
    if (ts.isIdentifier(name)) for (const p of props) c.checkProps.add(`${name.text}.${p}`);
    else if (ts.isObjectBindingPattern(name)) {
      for (const el of name.elements) {
        const key = el.propertyName ? (ts.isIdentifier(el.propertyName) || ts.isStringLiteral(el.propertyName) ? el.propertyName.text : null) : ts.isIdentifier(el.name) ? el.name.text : null;
        if (key && props.has(key) && ts.isIdentifier(el.name)) c.checkVars.add(el.name.text);
      }
    }
  };
  if (ts.isVariableDeclaration(n) && n.initializer) {
    const init = skipOuter(n.initializer);
    if (ts.isIdentifier(n.name) && isFnExpr(init)) { c.closures.set(n.name.text, init); return; }
    const before = out.length;
    visit(n.initializer, c, out);
    bind(bindingNames(n.name), n.initializer, before);
    bindProps(n.name, n.initializer, before);
    if (ts.isIdentifier(n.name) && isServiceExpr(n.initializer, c)) c.service.add(n.name.text);
    if (ts.isIdentifier(n.name) && isStorageExpr(n.initializer, c)) c.storage.add(n.name.text);
    // `const c = await ctx()` (c.svc) or `const { svc } = await ctx()`.
    const props = serviceObjectOf(n.initializer, c);
    if (props.size && ts.isIdentifier(n.name)) c.serviceObjs.set(n.name.text, props);
    if (props.size && ts.isObjectBindingPattern(n.name)) {
      for (const el of n.name.elements) {
        const key = el.propertyName ? (ts.isIdentifier(el.propertyName) || ts.isStringLiteral(el.propertyName) ? el.propertyName.text : null) : ts.isIdentifier(el.name) ? el.name.text : null;
        if (key && props.has(key) && ts.isIdentifier(el.name)) c.service.add(el.name.text);
      }
    }
    return;
  }
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left)) {
    const before = out.length;
    visit(n.right, c, out);
    bind([n.left.text], n.right, before);
    bindProps(n.left, n.right, before);
    if (isServiceExpr(n.right, c)) c.service.add(n.left.text);
    if (isStorageExpr(n.right, c)) c.storage.add(n.left.text);
    return;
  }
  // The guard itself: an `if` testing the caller's role, whose arm taken by
  // a refused caller leaves the handler. It covers the arm only an allowed
  // caller reaches, and what follows the `if` in its block when every arm
  // that falls through ends covered.
  if (c.route && ts.isIfStatement(n)) {
    const before = out.length;
    visit(n.expression, c, out);
    const tested = out.slice(before).some((e) => e.kind === "check" || e.kind === "guard") || readsCheck(n.expression, c);
    const p = tested ? pol(n.expression, c) : P_NEUTRAL;
    const thenExits = exits(n.thenStatement);
    const elseExits = n.elseStatement !== undefined && exits(n.elseStatement);
    let thenOk = p.imp; // the then arm runs only for an allowed caller
    let elseOk = p.cov; // the else arm (or the fall-through) runs only for an allowed caller
    const guard = p.known ? (p.cov && thenExits) || (p.imp && elseExits) : tested && (thenExits || elseExits);
    if (guard) {
      out.push({ kind: "guard", what: `if (${n.expression.getText().replace(/\s+/g, " ").slice(0, 70)}) exits` });
      // A form the scan does not model: as before, the arm that does not exit is taken as covered.
      if (!p.known) { thenOk = elseExits; elseOk = thenExits; }
    }
    const g0 = c.g;
    const endThen = arm(n.thenStatement, g0 || thenOk, c, out);
    const endElse = n.elseStatement ? arm(n.elseStatement, g0 || elseOk, c, out) : g0 || elseOk;
    c.g = g0 || ((thenExits || endThen) && (elseExits || endElse));
    return;
  }
  // Scopes: a guard inside covers nothing after the scope ends.
  if (c.route && ts.isTryStatement(n)) {
    const g0 = c.g;
    const endTry = arm(n.tryBlock, g0, c, out) || exits(n.tryBlock);
    const endCatch = n.catchClause ? arm(n.catchClause.block, g0, c, out) || exits(n.catchClause.block) : true;
    let g = g0 || (endTry && endCatch);
    if (n.finallyBlock) g = arm(n.finallyBlock, g, c, out) || g;
    c.g = g;
    return;
  }
  if (ts.isBlock(n) || ts.isCaseClause(n) || ts.isDefaultClause(n) || ts.isIterationStatement(n, false)) {
    const g0 = c.g;
    ts.forEachChild(n, (ch) => visit(ch, c, out));
    c.g = g0;
    return;
  }
  // What a function returns: a role-test result, whole or in a property of
  // the returned object (lift() hands it to the caller).
  if (c.route && ts.isReturnStatement(n) && n.expression) {
    const e = skipOuter(n.expression);
    const tests = (before: number, val: ts.Node) => out.slice(before).some((x) => x.kind === "check" || x.kind === "guard") || readsCheck(val, c);
    if (ts.isObjectLiteralExpression(e)) {
      for (const p of e.properties) {
        const before = out.length;
        visit(p, c, out);
        const key = (ts.isShorthandPropertyAssignment(p) || ts.isPropertyAssignment(p)) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null;
        const val = ts.isShorthandPropertyAssignment(p) ? p.name : ts.isPropertyAssignment(p) ? p.initializer : null;
        if (key && val && tests(before, val)) out.push({ kind: "ret-prop", what: key });
      }
      return;
    }
    const before = out.length;
    visit(n.expression, c, out);
    if (tests(before, n.expression)) out.push({ kind: "ret-check", what: "return" });
    return;
  }
  ts.forEachChild(n, (ch) => visit(ch, c, out));
  if (ts.isCallExpression(n)) onCall(n, c, out);
  else if (ts.isBinaryExpression(n)) onCompare(n, c, out);
}

/* ---------------- routes ---------------- */

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
/** firstEffect: the first effect seen (covered or not); unguarded: the first effect no guard covers. */
type HandlerReport = { file: string; method: string; events: Ev[]; firstEffect: string | null; unguarded: string | null };

function handlers(m: Mod): HandlerReport[] {
  const out: HandlerReport[] = [];
  for (const method of METHODS) {
    if (!m.exports.has(method)) continue;
    const t = resolveExport(m, method);
    if (t?.kind !== "fn") { out.push({ file: m.file, method, events: [], firstEffect: "UNRESOLVED HANDLER", unguarded: "UNRESOLVED HANDLER" }); continue; }
    const events = walkFn(t.fn, t.mod, t.mod === m, NO_PARAMS, []);
    const first = events.find((e) => e.kind === "effect" || e.kind === "safe-effect");
    const open = events.find((e) => e.kind === "effect");
    out.push({ file: m.file, method, events, firstEffect: first?.what ?? null, unguarded: open?.what ?? null });
  }
  return out;
}
const flaggedOf = (hs: HandlerReport[]) => hs.filter((h) => h.unguarded !== null);
const keyOf = (h: { file: string; method: string }) => `${h.file} ${h.method}`;
const covers = (a: Allow, h: HandlerReport) => (a.prefix !== undefined && h.file.startsWith(a.prefix)) || (a.handlers ?? []).includes(keyOf(h));
const allowFor = (h: HandlerReport, allow: Allow[]) => allow.find((a) => covers(a, h));
/** Prefix entries that cover no flagged handler, and listed handlers that are not flagged (gone, or now guarded). */
const staleEntries = (allow: Allow[], flagged: HandlerReport[]) => [
  ...allow.filter((a) => a.prefix !== undefined && !flagged.some((h) => covers(a, h))).map((a) => a.prefix as string),
  ...allow.flatMap((a) => (a.handlers ?? []).filter((k) => !flagged.some((h) => keyOf(h) === k))),
];
/** A prefix entry with no `requires`, and a flagged route file under a prefix whose code (comments removed) lacks the authority it names. */
const prefixProblems = (allow: Allow[], flagged: HandlerReport[]) => [
  ...allow.filter((a) => a.prefix !== undefined && !a.requires).map((a) => `${a.prefix}: no requires`),
  ...flagged.flatMap((h) => {
    const a = allow.find((x) => x.prefix !== undefined && h.file.startsWith(x.prefix));
    return a?.requires && !a.requires.test(codeOf(h.file)) ? [`${keyOf(h)}: lacks ${a.requires}`] : [];
  }),
];
const allowLabel = (a: Allow) => a.prefix ?? (a.handlers ?? []).join(", ");

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...routeFiles(p));
    else if (ent.name === "route.ts" || ent.name === "route.tsx") out.push(rel(p));
  }
  return out.sort();
}

/** A planted route at a virtual path (default: a fresh folder under app/api); its imports resolve against the real repo. */
let plantN = 0;
const planted = new Map<string, string>();
function plant(src: string, file = `app/api/__planted_${++plantN}__/route.ts`): HandlerReport[] {
  planted.set(file, src);
  return handlers(parse(file, src));
}
function sourceOf(file: string): string {
  return planted.get(file) ?? fs.readFileSync(path.join(root, file), "utf8");
}
/** A file's code re-printed from its syntax tree without comments (strings kept): a name in a comment is not the code. */
const codePrinter = ts.createPrinter({ removeComments: true });
function codeOf(file: string): string {
  return codePrinter.printFile(parse(file, sourceOf(file)).sf);
}
const verdict = (hs: HandlerReport[]) => hs.map((h) => `${h.method}:${h.firstEffect === null ? "no-effect" : h.unguarded === null ? "guarded" : "FLAGGED"}`);

/* ---------------- the checks ---------------- */

console.log("\nevery route handler under app/");
const files = routeFiles(path.join(root, "app"));
const all: HandlerReport[] = [];
const noHandler: string[] = [];
for (const f of files) {
  const m = modAt(f)!;
  const hs = handlers(m);
  if (hs.length === 0) noHandler.push(f);
  all.push(...hs);
}
eq(`non-vacuous: at least 120 route files found (found ${files.length})`, files.length >= 120, true);
eq("every route file yields at least one handler", noHandler, []);
eq("every exported handler resolves to a function", all.filter((h) => h.firstEffect === "UNRESOLVED HANDLER").map((h) => `${h.file} ${h.method}`), []);
const flagged = flaggedOf(all);
const uncovered = flagged.filter((h) => !allowFor(h, ALLOW));
eq("no handler makes a service-role write, an auth admin call, a storage write or a fetch before an explicit role check (outside the allow-list)",
  uncovered.map((h) => `${keyOf(h)}: ${h.unguarded}`), []);
eq("every allow-list entry and listed handler still matches a flagged handler (nothing stale)", staleEntries(ALLOW, flagged), []);
eq("every allow-list entry has a reason, and names a prefix or handlers", ALLOW.filter((a) => a.reason.trim().length < 20 || (a.prefix === undefined) === (a.handlers === undefined)).map(allowLabel), []);
eq("a prefix entry carries `requires`, and every flagged route file under it contains that authority", prefixProblems(ALLOW, flagged), []);
const guardedCount = all.filter((h) => h.firstEffect !== null && h.unguarded === null).length;
const effectCount = all.filter((h) => h.firstEffect !== null).length;
console.log(`  (${files.length} route files, ${all.length} handlers; ${effectCount} with an effect: ${guardedCount} guarded first, ${flagged.length} on the allow-list)`);
for (const a of ALLOW) console.log(`  allow-list ${a.prefix ?? "handlers"}: ${flagged.filter((h) => covers(a, h)).length} handler(s) — ${a.reason}`);

console.log("\nthe routes fixed for this rule: an effect, and a role check before it");
{
  const FIXED: Array<[string, string]> = [
    ["app/api/org/sso/route.ts", "POST"],
    ["app/api/org/branding/route.ts", "POST"],
    ["app/api/org/branding/domain-status/route.ts", "POST"],
    ["app/api/assignments/[id]/route.ts", "DELETE"],
    ["app/api/learning-path-assignments/[id]/route.ts", "DELETE"],
    ["app/api/learning-path-assignments/route.ts", "POST"],
    ["app/api/learning-paths/[id]/courses/route.ts", "POST"],
    // ADR 0024 P2-8: ctx() checks the role with isOrgAdminCaller before the
    // publish's re-pin and the publish dry run.
    ["app/api/journey/program/route.ts", "POST"],
  ];
  for (const [f, method] of FIXED) {
    const h = all.find((x) => x.file === f && x.method === method);
    eq(`${f} ${method}: an effect is seen (${h?.firstEffect ?? "none"}) and a guard comes first`, [!!h?.firstEffect, h?.unguarded ?? null], [true, null]);
  }
  const sso = all.find((x) => x.file === "app/api/org/sso/route.ts")!;
  eq("…the sso effect is the Supabase Auth admin call inside lib/supabase/sso-admin (a fetch)", sso.firstEffect, "fetch");
  const del = all.find((x) => x.file === "app/api/assignments/[id]/route.ts")!;
  eq("…the assignment delete's effects include the notification log's service-role insert",
    del.events.some((e) => e.what === "service-role insert on notification_log"), true);
  const jp = all.filter((x) => x.file === "app/api/journey/program/route.ts");
  const jpPost = jp.find((x) => x.method === "POST");
  eq("…the journey program POST: its effects are the two service-role calls of journey_repin_enrollments (the publish's re-pin and the dry run), each after the role check",
    (jpPost?.events ?? []).filter((e) => e.kind === "effect" || e.kind === "safe-effect").map((e) => `${e.kind} ${e.what}`),
    ["safe-effect service-role rpc journey_repin_enrollments", "safe-effect service-role rpc journey_repin_enrollments"]);
  eq("…its PUT (the curriculum save), PATCH and DELETE write on the caller's session only",
    verdict(jp.filter((x) => x.method !== "POST")), ["PUT:no-effect", "PATCH:no-effect", "DELETE:no-effect"]);
  const jpSrc = fs.readFileSync(path.join(root, "app/api/journey/program/route.ts"), "utf8");
  const jpNoCheck = jpSrc.replace(/\s*const admin = await isOrgAdminCaller\([\s\S]*?return \{ error: refused\.error, status: refused\.status \};\s*\}/, "");
  eq("…planted: the same route with ctx()'s role check taken out is flagged (the check is what guards it)",
    [jpNoCheck !== jpSrc, verdict(plant(jpNoCheck)).filter((v) => v.startsWith("POST:"))], [true, ["POST:FLAGGED"]]);
}

console.log("\nthe detectors see what a text search sees in lib/ (no blind spot on fetch / auth.admin)");
{
  const libFiles: string[] = [];
  const walkDir = (d: string) => { for (const ent of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, ent.name); if (ent.isDirectory()) walkDir(p); else if (/\.tsx?$/.test(ent.name)) libFiles.push(rel(p)); } };
  walkDir(path.join(root, "lib"));
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
  const missed: string[] = [];
  let checked = 0;
  for (const f of libFiles) {
    const text = strip(fs.readFileSync(path.join(root, f), "utf8"));
    const wantFetch = /(^|[^.\w])fetch\(/m.test(text);
    const wantAdmin = /\.auth\.admin\./.test(text);
    if (!wantFetch && !wantAdmin) continue;
    checked++;
    const m = modAt(f)!;
    const evs: Ev[] = [];
    visit(m.sf, { m, route: false, g: false, service: new Set(moduleService(m)), storage: new Set(), closures: new Map(), stack: [], roleVars: new Set(), checkVars: new Set(), refuseVars: new Set(), checkProps: new Set(), serviceObjs: new Map() }, evs);
    // Functions declared at module level run when called; walk each once.
    for (const fn of m.fns.values()) evs.push(...walkFn(fn, m, false, NO_PARAMS, []));
    if (wantFetch && !evs.some((e) => e.what === "fetch")) missed.push(`${f}: fetch`);
    if (wantAdmin && !evs.some((e) => e.what.startsWith("auth.admin."))) missed.push(`${f}: auth.admin`);
  }
  eq(`every lib module calling fetch( or .auth.admin. is seen doing so (${checked} modules)`, missed, []);
  eq("non-vacuous: at least 10 such modules", checked >= 10, true);
}

console.log("\nplanted cases");
{
  const SSO_IMPORTS = `import { NextResponse } from "next/server";\nimport { createClient } from "@/lib/supabase/server";\nimport { deleteSamlProvider } from "@/lib/supabase/sso-admin";\n`;
  eq("the old sso shape (an org read on the session, then the provider call, then the RLS update) is flagged",
    verdict(plant(SSO_IMPORTS + `export async function POST(req: Request) {
      const supabase = await createClient();
      const { data: org } = await supabase.from("organizations").select("id, sso_provider_id").eq("slug", "x").maybeSingle();
      if (!org) return NextResponse.json({}, { status: 404 });
      await deleteSamlProvider(org.sso_provider_id);
      await supabase.from("organizations").update({ sso_enabled: false }).eq("id", org.id);
      return NextResponse.json({ ok: true });
    }`)), ["POST:FLAGGED"]);
  eq("…with requireOrgAdminApi first it passes",
    verdict(plant(SSO_IMPORTS + `import { requireOrgAdminApi } from "@/lib/auth/api-admin";
    export async function POST(req: Request) {
      const auth = await requireOrgAdminApi("x");
      if ("error" in auth) return NextResponse.json({}, { status: auth.status });
      await deleteSamlProvider("p");
      return NextResponse.json({ ok: true });
    }`)), ["POST:guarded"]);
  eq("…with the guard AFTER the provider call it is flagged",
    verdict(plant(SSO_IMPORTS + `import { requireOrgAdminApi } from "@/lib/auth/api-admin";
    export async function POST(req: Request) {
      await deleteSamlProvider("p");
      const auth = await requireOrgAdminApi("x");
      return NextResponse.json({ ok: "error" in auth });
    }`)), ["POST:FLAGGED"]);
  eq("…and so it is when an exiting role check follows the provider call",
    verdict(plant(SSO_IMPORTS + `import { requireOrgAdminApi } from "@/lib/auth/api-admin";
    export async function POST() {
      await deleteSamlProvider("p");
      const auth = await requireOrgAdminApi("x");
      if ("error" in auth) return NextResponse.json({}, { status: auth.status });
      return NextResponse.json({ ok: true });
    }`)), ["POST:FLAGGED"]);
  eq("a guard in a sibling handler only does not cover this one",
    verdict(plant(SSO_IMPORTS + `import { requireOrgAdminApi } from "@/lib/auth/api-admin";
    export async function GET() { const a = await requireOrgAdminApi("x"); if ("error" in a) return NextResponse.json({}, { status: 403 }); await deleteSamlProvider("p"); return NextResponse.json({}); }
    export async function POST() { await deleteSamlProvider("p"); return NextResponse.json({}); }`)), ["GET:guarded", "POST:FLAGGED"]);
  eq("requireOrgAdminApi whose answer is never tested is not a guard",
    verdict(plant(SSO_IMPORTS + `import { requireOrgAdminApi } from "@/lib/auth/api-admin";
    export async function POST() { const a = await requireOrgAdminApi("x"); await deleteSamlProvider(String(a)); return NextResponse.json({}); }`)), ["POST:FLAGGED"]);
  eq("a same-file helper that checks and returns early protects its own effects; the route that calls it passes",
    verdict(plant(SSO_IMPORTS + `import { requireOrgAdminApi } from "@/lib/auth/api-admin";
    async function handle() { const a = await requireOrgAdminApi("x"); if ("error" in a) return NextResponse.json({}, { status: 403 }); await deleteSamlProvider("p"); return NextResponse.json({}); }
    export async function POST() { return handle(); }`)), ["POST:guarded"]);
  eq("a guard named only in a comment or a string is not a guard",
    verdict(plant(SSO_IMPORTS + `export async function POST() {
      // await requireOrgAdminApi("x");
      const note = "requireOrgAdminApi(slug)";
      await deleteSamlProvider(note);
      return NextResponse.json({});
    }`)), ["POST:FLAGGED"]);

  const SVC_IMPORTS = `import { NextResponse } from "next/server";\nimport { createClient } from "@/lib/supabase/server";\nimport { createClient as createServiceClient } from "@supabase/supabase-js";\n`;
  const SVC = `createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })`;
  eq("a service-role insert with no role check is flagged",
    verdict(plant(SVC_IMPORTS + `export async function POST() { const svc = ${SVC}; await svc.from("x").insert({ a: 1 }); return NextResponse.json({}); }`)), ["POST:FLAGGED"]);
  eq("a service-role READ is not an effect",
    verdict(plant(SVC_IMPORTS + `export async function GET() { const svc = ${SVC}; const { data } = await svc.from("x").select("id"); return NextResponse.json({ data }); }`)), ["GET:no-effect"]);
  eq("a write on the caller's session (RLS decides) is not an effect",
    verdict(plant(SVC_IMPORTS + `export async function POST() { const s = await createClient(); await s.from("x").update({ a: 1 }).eq("id", "1"); return NextResponse.json({}); }`)), ["POST:no-effect"]);
  eq("the service client passed to a helper that writes on its parameter is flagged; the session client passed to it is not",
    verdict(plant(SVC_IMPORTS + `async function put(db: any, v: number) { await db.from("x").upsert({ v }); }
    export async function POST() { const svc = ${SVC}; await put(svc, 1); return NextResponse.json({}); }
    export async function PUT() { const s = await createClient(); await put(s, 1); return NextResponse.json({}); }`)), ["POST:FLAGGED", "PUT:no-effect"]);
  eq("a helper returning a service client, then a delete on it, is flagged",
    verdict(plant(SVC_IMPORTS + `function admin() { return ${SVC}; }
    export async function DELETE() { await admin().from("x").delete().eq("id", "1"); return NextResponse.json({}); }`)), ["DELETE:FLAGGED"]);
  eq("an auth admin call is flagged",
    verdict(plant(SVC_IMPORTS + `export async function POST() { const svc = ${SVC}; await svc.auth.admin.deleteUser("u"); return NextResponse.json({}); }`)), ["POST:FLAGGED"]);
  eq("a service-role storage upload is flagged",
    verdict(plant(SVC_IMPORTS + `export async function POST() { const svc = ${SVC}; await svc.storage.from("b").upload("k", "v"); return NextResponse.json({}); }`)), ["POST:FLAGGED"]);
  eq("a storage-adapter write is flagged",
    verdict(plant(`import { NextResponse } from "next/server";\nimport { getStorage } from "@/lib/storage";\n` +
      `export async function POST() { const store = await getStorage(); await store.deletePrefix("k/"); return NextResponse.json({}); }`)), ["POST:FLAGGED"]);
  eq("an external fetch is flagged",
    verdict(plant(`import { NextResponse } from "next/server";\nexport async function POST() { await fetch("https://third-party.example.test/hook", { method: "POST" }); return NextResponse.json({}); }`)), ["POST:FLAGGED"]);
  eq("an effect reached only through a lib helper (notifyBackground) is flagged",
    verdict(plant(`import { NextResponse } from "next/server";\nimport { notifyBackground } from "@/lib/notifications/send";\n` +
      `export async function POST() { await notifyBackground({} as never); return NextResponse.json({}); }`)), ["POST:FLAGGED"]);
  eq("a helper declared inside the handler counts where it is called (after the guard)",
    verdict(plant(SVC_IMPORTS + `import { requireOrgAdminApi } from "@/lib/auth/api-admin";
    export async function POST() {
      const svc = ${SVC};
      const notify = async () => { await svc.from("log").insert({}); };
      const auth = await requireOrgAdminApi("x");
      if ("error" in auth) return NextResponse.json({}, { status: 403 });
      await notify();
      return NextResponse.json({});
    }`)), ["POST:guarded"]);
  eq("`export const GET = POST` and `= handle` resolve to the function",
    verdict(plant(SVC_IMPORTS + `async function handle() { const svc = ${SVC}; await svc.from("x").insert({}); return NextResponse.json({}); }
    export async function POST() { return handle(); }
    export const GET = POST;
    export const PUT = handle;`)), ["GET:FLAGGED", "POST:FLAGGED", "PUT:FLAGGED"]);

  const MEM = `const { data: m } = await s.from("organization_members").select("role").eq("organization_id", "o").eq("user_id", u.id).maybeSingle();`;
  const USER = `const s = await createClient(); const { data: { user: u } } = await s.auth.getUser(); if (!u) return NextResponse.json({}, { status: 401 });`;
  eq("an organization_members role lookup followed by a role comparison is a guard",
    verdict(plant(SVC_IMPORTS + `export async function POST() { ${USER} ${MEM}
      if (m?.role !== "admin" && m?.role !== "super_owner") return NextResponse.json({}, { status: 403 });
      const svc = ${SVC}; await svc.from("x").insert({}); return NextResponse.json({}); }`)), ["POST:guarded"]);
  eq("…and so is a role list check after the lookup",
    verdict(plant(SVC_IMPORTS + `export async function POST() { ${USER} ${MEM}
      if (!["super_owner", "admin"].includes(m?.role as string)) return NextResponse.json({}, { status: 403 });
      const svc = ${SVC}; await svc.from("x").insert({}); return NextResponse.json({}); }`)), ["POST:guarded"]);
  eq("a role lookup with no comparison is not a guard",
    verdict(plant(SVC_IMPORTS + `export async function POST() { ${USER} ${MEM}
      const svc = ${SVC}; await svc.from("x").insert({ role: m?.role }); return NextResponse.json({}); }`)), ["POST:FLAGGED"]);
  eq("a role comparison on a body field, with no lookup of the caller, is not a guard",
    verdict(plant(SVC_IMPORTS + `export async function POST(req: Request) { const body = await req.json();
      if (body.role !== "admin") return NextResponse.json({}, { status: 403 });
      const svc = ${SVC}; await svc.from("x").insert({}); return NextResponse.json({}); }`)), ["POST:FLAGGED"]);
  eq("a members list read (no caller filter) is not a lookup of the caller",
    verdict(plant(SVC_IMPORTS + `export async function POST() { ${USER}
      const { data: ms } = await s.from("organization_members").select("user_id, role").eq("organization_id", "o");
      if (ms?.[0]?.role !== "admin") return NextResponse.json({}, { status: 403 });
      const svc = ${SVC}; await svc.from("x").insert({}); return NextResponse.json({}); }`)), ["POST:FLAGGED"]);
  eq("a role test stored in a variable and tested by an exiting `if` is a guard",
    verdict(plant(SVC_IMPORTS + `export async function POST() { ${USER} ${MEM}
      const r = m?.role as string | undefined;
      const canWrite = r === "super_owner" || r === "admin";
      if (!canWrite) return NextResponse.json({}, { status: 403 });
      const svc = ${SVC}; await svc.from("x").insert({}); return NextResponse.json({}); }`)), ["POST:guarded"]);
  eq("a role comparison that never leads to an exit is not a guard",
    verdict(plant(SVC_IMPORTS + `export async function POST() { ${USER} ${MEM}
      const label = m?.role === "admin" ? "Admin" : "Member";
      const svc = ${SVC}; await svc.from("x").insert({ label }); return NextResponse.json({}); }`)), ["POST:FLAGGED"]);
  eq("a role test in an `if` whose branches do not leave the handler is not a guard",
    verdict(plant(SVC_IMPORTS + `export async function POST() { ${USER} ${MEM}
      let note = ""; if (m?.role !== "admin") { note = "not an admin"; }
      const svc = ${SVC}; await svc.from("x").insert({ note }); return NextResponse.json({}); }`)), ["POST:FLAGGED"]);
  eq("requireOrgAdminApi's answer used but its refusal never tested: an exit on data read with it is not a guard",
    verdict(plant(SVC_IMPORTS + `import { requireOrgAdminApi } from "@/lib/auth/api-admin";
    export async function POST() {
      const auth = await requireOrgAdminApi("x");
      const { supabase, org } = auth as unknown as { supabase: any; org: { id: string } };
      const { data: row } = await supabase.from("paths").select("id").eq("organization_id", org.id).maybeSingle();
      if (!row) return NextResponse.json({}, { status: 404 });
      const svc = ${SVC}; await svc.from("x").insert({}); return NextResponse.json({}); }`)), ["POST:FLAGGED"]);
  eq("…while a copy of the test result (`const ok = !('error' in auth)`) tested by an exit is a guard",
    verdict(plant(SVC_IMPORTS + `import { requireOrgAdminApi } from "@/lib/auth/api-admin";
    export async function POST() {
      const auth = await requireOrgAdminApi("x");
      const ok = !("error" in auth);
      if (!ok) return NextResponse.json({}, { status: 403 });
      const svc = ${SVC}; await svc.from("x").insert({}); return NextResponse.json({}); }`)), ["POST:guarded"]);
  eq("a membership-only test (if (!member) return) is not a role check",
    verdict(plant(SVC_IMPORTS + `export async function POST() { ${USER} ${MEM}
      if (!m) return NextResponse.json({}, { status: 403 });
      const svc = ${SVC}; await svc.from("x").insert({}); return NextResponse.json({}); }`)), ["POST:FLAGGED"]);
  eq("the lookup and the comparison inside a same-file helper (ctx()) are a guard at the call",
    verdict(plant(SVC_IMPORTS + `async function ctx() { ${USER} ${MEM}
      if (m?.role !== "admin") return null; return { s }; }
    export async function POST() { const c = await ctx(); if (!c) return NextResponse.json({}, { status: 403 });
      const svc = ${SVC}; await svc.from("x").insert({}); return NextResponse.json({}); }`)), ["POST:guarded"]);
  eq("requireOrgAccess alone (any member passes) is not a guard; with canManage(role) it is",
    verdict(plant(SVC_IMPORTS + `import { requireOrgAccess } from "@/lib/auth/require-org-access";\nimport { canManage } from "@/lib/auth/permissions";
    export async function GET() { const a = await requireOrgAccess("x"); const svc = ${SVC}; await svc.from("x").insert({ o: a.org.id }); return NextResponse.json({}); }
    export async function POST() { const a = await requireOrgAccess("x"); if (!canManage(a.role)) return NextResponse.json({}, { status: 403 });
      const svc = ${SVC}; await svc.from("x").insert({}); return NextResponse.json({}); }`)), ["GET:FLAGGED", "POST:guarded"]);
  eq("a platform_owners lookup of the caller is a guard",
    verdict(plant(SVC_IMPORTS + `export async function POST() { ${USER} const svc = ${SVC};
      const { data: po } = await svc.from("platform_owners").select("user_id").eq("user_id", u.id).maybeSingle();
      if (!po) return NextResponse.json({}, { status: 403 });
      await svc.from("x").insert({}); return NextResponse.json({}); }`)), ["POST:guarded"]);
  eq("requirePlatformOwnerApi acted on (\"error\" in guard → return) is a guard; its answer left untested is not",
    verdict(plant(SVC_IMPORTS + `import { requirePlatformOwnerApi } from "@/lib/auth/require-platform-owner";
    export async function POST() { const guard = await requirePlatformOwnerApi("full");
      if ("error" in guard) return NextResponse.json({ error: guard.error }, { status: guard.status });
      const svc = ${SVC}; await svc.from("x").insert({}); return NextResponse.json({}); }
    export async function DELETE() { const guard = await requirePlatformOwnerApi("full");
      const svc = ${SVC}; await svc.from("x").delete().eq("id", "1"); return NextResponse.json({ guard }); }`)), ["POST:guarded", "DELETE:FLAGGED"]);
  eq("a role check inside a lib module other than lib/auth is not taken as the route's guard",
    verdict(plant(`import { NextResponse } from "next/server";\nimport { notifyBackground } from "@/lib/notifications/send";\nimport { sendNotification } from "@/lib/notifications/send";\n` +
      `export async function POST() { await sendNotification({} as never); await notifyBackground({} as never); return NextResponse.json({}); }`)), ["POST:FLAGGED"]);

  // A service client carried in a helper's answer, or built from a key held in a local.
  const CTX_SVC = `async function ctx() { const s = await createClient(); const svc = ${SVC}; return { s, svc, org: { id: "o" } }; }\n`;
  eq("a service client in a helper's answer (`c.svc`) is followed: a write on it with no role check is flagged",
    verdict(plant(SVC_IMPORTS + CTX_SVC + `export async function POST() { const c = await ctx(); await c.svc.from("x").insert({}); return NextResponse.json({}); }`)), ["POST:FLAGGED"]);
  eq("…and so is one destructured from it (`const { svc } = await ctx()`)",
    verdict(plant(SVC_IMPORTS + CTX_SVC + `export async function DELETE() { const { svc: db } = await ctx(); await db.from("x").delete().eq("id", "1"); return NextResponse.json({}); }`)), ["DELETE:FLAGGED"]);
  eq("…and `c.svc` handed to a helper that writes on its parameter",
    verdict(plant(SVC_IMPORTS + CTX_SVC + `async function put(db: any) { await db.rpc("do_it"); }
    export async function POST() { const c = await ctx(); await put(c.svc); return NextResponse.json({}); }`)), ["POST:FLAGGED"]);
  eq("…and `c` handed to a helper that writes on `c.svc`",
    verdict(plant(SVC_IMPORTS + CTX_SVC + `async function put(k: any) { await k.svc.from("x").upsert({}); }
    export async function POST() { const c = await ctx(); await put(c); return NextResponse.json({}); }`)), ["POST:FLAGGED"]);
  eq("a session client in a helper's answer (`c.s`) is still not a service client",
    verdict(plant(SVC_IMPORTS + CTX_SVC + `export async function POST() { const c = await ctx(); await c.s.from("x").insert({}); return NextResponse.json({}); }`)), ["POST:no-effect"]);
  eq("a service client built from a key held in a local (`createClient(url, key)`) is a service client",
    verdict(plant(`import { NextResponse } from "next/server";\nimport { createClient } from "@supabase/supabase-js";
    const admin = () => { const url = process.env.NEXT_PUBLIC_SUPABASE_URL!; const key = process.env.SUPABASE_SERVICE_ROLE_KEY!; return createClient(url, key); };
    export async function POST() { await admin().from("x").update({ a: 1 }).eq("id", "1"); return NextResponse.json({}); }`)), ["POST:FLAGGED"]);
  eq("…but one built from the anon key is not",
    verdict(plant(`import { NextResponse } from "next/server";\nimport { createClient } from "@supabase/supabase-js";
    const anon = () => { const url = process.env.NEXT_PUBLIC_SUPABASE_URL!; const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!; return createClient(url, key); };
    export async function POST() { await anon().from("x").update({ a: 1 }).eq("id", "1"); return NextResponse.json({}); }`)), ["POST:no-effect"]);
  eq("a service client assigned lazily to a module `let` and returned is a service client",
    verdict(plant(SVC_IMPORTS + `let cached: any = null;
    function db() { if (!cached) cached = ${SVC}; return cached; }
    export async function POST() { await db().from("x").insert({}); return NextResponse.json({}); }`)), ["POST:FLAGGED"]);

  // A role test a helper computes without exiting reaches the route only through its answer.
  const CTX_ROLE = `async function ctx() { ${USER} ${MEM} if (!m) return { error: "Forbidden" };
      const admin = ["super_owner", "owner", "admin"].includes(m.role as string); const svc = ${SVC}; return { svc, admin }; }\n`;
  eq("a helper that returns the role test in a property: testing only its error (membership) is not a guard",
    verdict(plant(SVC_IMPORTS + CTX_ROLE + `export async function PUT() { const c = await ctx(); if ("error" in c) return NextResponse.json({}, { status: 403 });
      await c.svc.from("x").delete().eq("id", "1"); return NextResponse.json({}); }`)), ["PUT:FLAGGED"]);
  eq("…testing that property (`if (!c.admin)`) before the write is",
    verdict(plant(SVC_IMPORTS + CTX_ROLE + `export async function PUT() { const c = await ctx(); if ("error" in c) return NextResponse.json({}, { status: 403 });
      if (!c.admin) return NextResponse.json({}, { status: 403 }); await c.svc.from("x").delete().eq("id", "1"); return NextResponse.json({}); }`)), ["PUT:guarded"]);
  eq("…and so is testing it destructured (`const { admin, svc } = …; if (!admin)`)",
    verdict(plant(SVC_IMPORTS + CTX_ROLE + `export async function PUT() { const c = await ctx(); if ("error" in c) return NextResponse.json({}, { status: 403 });
      const { admin, svc } = c; if (!admin) return NextResponse.json({}, { status: 403 }); await svc.from("x").delete().eq("id", "1"); return NextResponse.json({}); }`)), ["PUT:guarded"]);
  eq("a helper whose whole answer is the role test (`return m?.role === \"admin\"`), tested by the route, is a guard",
    verdict(plant(SVC_IMPORTS + `async function isAdmin() { ${USER} ${MEM} return m?.role === "admin"; }
    export async function POST() { if (!(await isAdmin())) return NextResponse.json({}, { status: 403 });
      const svc = ${SVC}; await svc.from("x").insert({}); return NextResponse.json({}); }`)), ["POST:guarded"]);

  // Control flow: a guard covers only what follows it in its own scope, and only when it points the right way.
  const ADMIN_IMP = `import { requireOrgAdminApi } from "@/lib/auth/api-admin";\n`;
  const DENY = `NextResponse.json({}, { status: 403 })`;
  eq("an admin check inside one action's branch does not cover the provider call after that branch",
    verdict(plant(SSO_IMPORTS + ADMIN_IMP + `export async function POST(req: Request) { const body = await req.json();
      if (body.action === "configure") { const auth = await requireOrgAdminApi("x"); if ("error" in auth) return ${DENY}; }
      await deleteSamlProvider("p"); return NextResponse.json({}); }`)), ["POST:FLAGGED"]);
  eq("…while the same check in both arms covers it",
    verdict(plant(SSO_IMPORTS + ADMIN_IMP + `export async function POST(req: Request) { const body = await req.json();
      if (body.action === "configure") { const a = await requireOrgAdminApi("x"); if ("error" in a) return ${DENY}; }
      else { const b = await requireOrgAdminApi("y"); if ("error" in b) return ${DENY}; }
      await deleteSamlProvider("p"); return NextResponse.json({}); }`)), ["POST:guarded"]);
  eq("a check whose exit is inside a callback (forEach) leaves only the callback: not a guard after it",
    verdict(plant(SSO_IMPORTS + ADMIN_IMP + `export async function POST() { const auth = await requireOrgAdminApi("x");
      [1].forEach(() => { if ("error" in auth) return; });
      await deleteSamlProvider("p"); return NextResponse.json({}); }`)), ["POST:FLAGGED"]);
  eq("an inverted test (`if (!(\"error\" in auth)) return`: the allowed caller leaves) is not a guard",
    verdict(plant(SSO_IMPORTS + ADMIN_IMP + `export async function POST() { const auth = await requireOrgAdminApi("x");
      if (!("error" in auth)) return NextResponse.json({ ok: true });
      await deleteSamlProvider("p"); return NextResponse.json({}); }`)), ["POST:FLAGGED"]);
  eq("a test that refuses in one case only (`body.action === \"x\" && \"error\" in auth`) is not a guard; `||` with a refusal is",
    verdict(plant(SSO_IMPORTS + ADMIN_IMP + `export async function POST(req: Request) { const body = await req.json(); const auth = await requireOrgAdminApi("x");
      if (body.action === "configure" && "error" in auth) return ${DENY};
      await deleteSamlProvider("p"); return NextResponse.json({}); }
    export async function PUT(req: Request) { const body = await req.json(); const auth = await requireOrgAdminApi("x");
      if (!body.orgSlug || "error" in auth) return ${DENY};
      await deleteSamlProvider("p"); return NextResponse.json({}); }`)), ["POST:FLAGGED", "PUT:guarded"]);
  eq("the arm only an allowed caller reaches is covered; the refused caller's arm is not",
    verdict(plant(SSO_IMPORTS + ADMIN_IMP + `export async function POST() { const auth = await requireOrgAdminApi("x");
      if (!("error" in auth)) { await deleteSamlProvider("p"); } return NextResponse.json({}); }
    export async function PUT() { const auth = await requireOrgAdminApi("x");
      if ("error" in auth) { await deleteSamlProvider("p"); } return NextResponse.json({}); }`)), ["POST:guarded", "PUT:FLAGGED"]);
  eq("a variable true for a refused caller (`const denied = \"error\" in auth`) is read that way round",
    verdict(plant(SSO_IMPORTS + ADMIN_IMP + `export async function POST() { const auth = await requireOrgAdminApi("x"); const denied = "error" in auth;
      if (denied) return ${DENY}; await deleteSamlProvider("p"); return NextResponse.json({}); }
    export async function PUT() { const auth = await requireOrgAdminApi("x"); const denied = "error" in auth;
      if (!denied) return ${DENY}; await deleteSamlProvider("p"); return NextResponse.json({}); }`)), ["POST:guarded", "PUT:FLAGGED"]);
  eq("the upload shape (membership on one branch, the admin check on the other, the write after both) is flagged",
    verdict(plant(SVC_IMPORTS + `export async function POST(req: Request) { const body = await req.json(); ${USER} ${MEM}
      if (body.kind === "avatar") { if (!m) return ${DENY}; }
      else { const canWrite = m?.role === "super_owner" || m?.role === "admin"; if (!canWrite) return ${DENY}; }
      const svc = ${SVC}; await svc.storage.from("b").upload("k", "v"); return NextResponse.json({}); }`)), ["POST:FLAGGED"]);
  eq("a guard inside try covers the rest of the try block, and what follows the try when the catch exits",
    verdict(plant(SSO_IMPORTS + ADMIN_IMP + `export async function POST() {
      try { const auth = await requireOrgAdminApi("x"); if ("error" in auth) return ${DENY}; await deleteSamlProvider("p"); }
      catch { return NextResponse.json({}, { status: 500 }); }
      return NextResponse.json({}); }
    export async function PUT() {
      try { const auth = await requireOrgAdminApi("x"); if ("error" in auth) return ${DENY}; }
      catch { return NextResponse.json({}, { status: 500 }); }
      await deleteSamlProvider("p"); return NextResponse.json({}); }`)), ["POST:guarded", "PUT:guarded"]);
  eq("…but not what follows the try when the catch falls through, nor what follows a loop holding the check",
    verdict(plant(SSO_IMPORTS + ADMIN_IMP + `export async function POST() {
      try { const auth = await requireOrgAdminApi("x"); if ("error" in auth) return ${DENY}; } catch { /* ignored */ }
      await deleteSamlProvider("p"); return NextResponse.json({}); }
    export async function PUT(req: Request) { const body = await req.json();
      for (const slug of body.slugs) { const a = await requireOrgAdminApi(slug); if ("error" in a) return ${DENY}; }
      await deleteSamlProvider("p"); return NextResponse.json({}); }`)), ["POST:FLAGGED", "PUT:FLAGGED"]);
  eq("a same-file helper whose check sits in one branch only is not a role test for its caller",
    verdict(plant(SSO_IMPORTS + ADMIN_IMP + `async function ctx(action: string) {
      if (action === "configure") { const a = await requireOrgAdminApi("x"); if ("error" in a) return null; }
      return { ok: true }; }
    export async function POST() { const c = await ctx("disable"); if (!c) return ${DENY};
      await deleteSamlProvider("p"); return NextResponse.json({}); }`)), ["POST:FLAGGED"]);

  // Tickets: loadTicketForCaller answers the caller's party, "admin" only for an active admin of the ticket's org.
  const TICKET_IMPORTS = `import { NextResponse } from "next/server";\nimport { isActionError } from "@/lib/actions/types";\nimport { loadTicketForCaller } from "@/lib/tickets/auth";\n`;
  eq("a ticket handler: loading the ticket is not a role check; `c.party !== \"admin\"` with an exit is; a requester-party test is not",
    verdict(plant(TICKET_IMPORTS + `export async function POST() { const c = await loadTicketForCaller("t"); if (isActionError(c)) return NextResponse.json({}, { status: c.status });
      if (c.party !== "admin") return ${DENY}; await c.svc.from("help_tickets").update({}).eq("id", "t"); return NextResponse.json({}); }
    export async function PUT() { const c = await loadTicketForCaller("t"); if (isActionError(c)) return NextResponse.json({}, { status: c.status });
      if (c.party !== "requester") return ${DENY}; await c.svc.from("help_tickets").update({}).eq("id", "t"); return NextResponse.json({}); }
    export async function PATCH() { const c = await loadTicketForCaller("t"); if (isActionError(c)) return NextResponse.json({}, { status: c.status });
      await c.svc.from("help_tickets").update({}).eq("id", "t"); return NextResponse.json({}); }`)), ["POST:guarded", "PUT:FLAGGED", "PATCH:FLAGGED"]);

  // The allow-list.
  const FLAGGED_SRC = SVC_IMPORTS + `export async function POST() { const svc = ${SVC}; await svc.from("x").insert({}); return NextResponse.json({}); }
    export async function DELETE() { const svc = ${SVC}; await svc.from("x").delete().eq("id", "1"); return NextResponse.json({}); }`;
  eq("a flagged handler outside every entry is uncovered",
    plant(FLAGGED_SRC).filter((h) => !allowFor(h, ALLOW)).map((h) => h.method), ["POST", "DELETE"]);
  eq("a new flagged route in a folder whose other handlers are listed (tickets) is uncovered",
    plant(FLAGGED_SRC, "app/api/tickets/[id]/__planted__/route.ts").filter((h) => !allowFor(h, ALLOW)).map((h) => h.method), ["POST", "DELETE"]);
  eq("a new flagged method in a listed file is uncovered; the listed method stays covered",
    plant(FLAGGED_SRC, "app/api/broadcasts/route.ts").filter((h) => !allowFor(h, ALLOW)).map((h) => h.method), ["DELETE"]);
  {
    const cronPlant = plant(FLAGGED_SRC, "app/api/cron/__planted__/route.ts");
    eq("a flagged route under a prefix entry is covered, but one lacking the authority the entry requires is reported",
      [cronPlant.every((h) => allowFor(h, ALLOW)?.prefix === "app/api/cron/"), prefixProblems(ALLOW, cronPlant)],
      [true, ["app/api/cron/__planted__/route.ts POST: lacks /CRON_SECRET/", "app/api/cron/__planted__/route.ts DELETE: lacks /CRON_SECRET/"]]);
  }
  {
    const body = `export async function POST(req: Request) { const svc = ${SVC}; await svc.from("x").insert({}); return NextResponse.json({ req }); }`;
    const commentOnly = plant(SVC_IMPORTS + `// the key check, authenticateApiKey(req), lives elsewhere\n` + body, "app/api/integrations/__planted_comment__/route.ts");
    const called = plant(SVC_IMPORTS + `import { authenticateApiKey } from "@/lib/integrations/auth";\n` + body.replace("{ const svc", "{ await authenticateApiKey(req); const svc"), "app/api/integrations/__planted_called__/route.ts");
    eq("a prefix entry's authority named only in a comment does not count; called in the code it does",
      [prefixProblems(ALLOW, commentOnly), prefixProblems(ALLOW, called)],
      [["app/api/integrations/__planted_comment__/route.ts POST: lacks /authenticateApiKey\\(/"], []]);
  }
  eq("a prefix entry without `requires` is reported",
    prefixProblems([{ prefix: "app/api/__loose__/", reason: "planted loose entry for the test" }], []), ["app/api/__loose__/: no requires"]);
  eq("a prefix entry that covers no flagged handler, and a listed handler that is not flagged, are reported stale",
    staleEntries([
      { prefix: "app/api/__nothing_here__/", requires: /x/, reason: "planted stale entry for the test" },
      { handlers: ["app/api/org/sso/route.ts POST", "app/api/__gone__/route.ts POST"], reason: "planted stale handlers for the test" },
      ...ALLOW,
    ], flagged),
    ["app/api/__nothing_here__/", "app/api/org/sso/route.ts POST", "app/api/__gone__/route.ts POST"]);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
