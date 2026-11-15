/**
 * Guard for ADR 0024 step 62's row "preview-mode-sites.test.ts" and step
 * 23's "Start and Preview" and "Buttons" bullets, as phase 2 slice P2-5
 * builds them (decision D7, the owner's R6 answer of 2026-11-13): Start is
 * a real attempt for every role, and a Preview is a mode the caller names
 * on the launch link (`?mode=preview`), never a role.
 *
 * It reads the sources, not a database. The .ts and .tsx files of app/,
 * lib/ and components/ are parsed with the TypeScript parser.
 *
 *   (a) the Preview addresses. A preview address is a string or template
 *       literal that names `mode=preview`. Each one is a whole launch
 *       address whose query is exactly `?mode=preview`
 *       (`/<org>/courses/<course>/launch?mode=preview` and nothing after it):
 *       no product parameter (`lp`, `journey`, `day`, `run`) and no other,
 *       so a step's or a day's preview opens the course outside the path or
 *       the journey and has no Continue (the owner's A21 answer). The
 *       addresses found are exactly SITES, by file and count, so a new
 *       Preview site is listed here and held to the rule.
 *   (b) each address is the href of a link whose text says Preview, so no
 *       Start, Resume, dashboard card or Continue previews ("Dashboard cards
 *       and Continue never preview"). On the learner pages, which every role
 *       opens, each one sits under a `canPreview` condition, and the file
 *       binds `const canPreview = canViewReports(role)` (the report-viewing
 *       roles, lib/auth/permissions.ts). The admin pages are canManage
 *       pages. The journey page offers its DayPreview on every day it lists.
 *   (c) the inverse: a link to a launch address whose text says Preview
 *       carries the mode (the Library's "Preview launch" did not before
 *       P2-5, and would now open a real attempt).
 *   (d) the learner course page decides by role only where step 23 keeps
 *       the role: `isAdmin` is read at the attempts section, the Library
 *       link and the "Hidden from learners" badge, and nowhere else; the
 *       access call, the inactive-course redirect and the "Request another
 *       attempt" button name no role.
 *   (e) the other D7 sites of step 23 decide by the mode or by the row's
 *       context: launchModeFor and p4AttemptColumns take no role and
 *       lib/alds/launch.ts calls no canManage; the launch page calls no
 *       canManage, passes no role to launchModeFor or p4AttemptColumns, and
 *       each canViewReports call there sits beside the preview mode; the
 *       continue page has no staff branch (no isStaff, no launchModeFor)
 *       and lib/learner/continue.ts no isStaff; the restart helper, the
 *       restart route's count and the history check name no role set and
 *       read no membership role (they tell a preview by `context_kind`);
 *       the restart dialog calls the dry run's `by_role.staff` previews.
 *   (f) planted sources: the scanner flags what it must, a negated or
 *       wrong-branch canPreview included, and two mutants of the real
 *       sources (the journey's DayPreview and the course page's card with
 *       the condition inverted) are flagged.
 *   (g) the sign-in bounce (lib/supabase/middleware.ts): a signed-out
 *       Preview link comes back with its mode. Each `next` the middleware
 *       sets is signInNext(<path>, request.nextUrl.searchParams), the path
 *       and its query (tests/unit/sign-in-next.test.ts runs it), never the
 *       path alone, which would open a Start.
 *
 * (b)'s canPreview condition is positive: the bare name, or an `&&` chain
 * with the bare name as one operand, on the side that shows the link
 * (`&&`'s right, `?:`'s true branch, `if`'s then). A negation, `||`, a
 * comparison or the false branch does not count.
 *
 * Run:  npx tsx tests/unit/preview-mode-sites.test.ts   (or npm run test:unit)
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
const rel = (f: string) => path.relative(root, f).split(path.sep).join("/");
function walk(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
}
const parse = (name: string, src: string) =>
  ts.createSourceFile(name, src, ts.ScriptTarget.Latest, true, /\.tsx$/.test(name) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
const files: string[] = [];
for (const d of ["app", "lib", "components"]) walk(path.join(root, d), files);
const sources = new Map<string, string>(files.map((f) => [rel(f), fs.readFileSync(f, "utf8")]));

/** Every Preview address in the tree, by file (step 23's buttons). */
const SITES: Record<string, { count: number; what: string }> = {
  "app/[org]/(learner)/courses/[courseId]/page.tsx": { count: 2, what: "Preview beside Start, and \"Preview instead\" on the preview-only card (not enrolled, not released, or impersonating)" },
  "app/[org]/(learner)/paths/[pathId]/page.tsx": { count: 1, what: "each step (StepCard)" },
  "app/[org]/(learner)/journey/page.tsx": { count: 1, what: "each day (DayPreview)" },
  "app/[org]/(admin)/library/[courseId]/page.tsx": { count: 1, what: "the Library course page's \"Preview launch\"" },
  "app/[org]/(admin)/learning-paths/learning-paths-client.tsx": { count: 1, what: "the path editor's step rows" },
  "app/[org]/(admin)/journey-admin/journey-client.tsx": { count: 1, what: "the journey program editor's day rows" },
};
/** Pages every role opens: a Preview there is for the report-viewing roles only. */
const isLearnerPage = (file: string) => file.startsWith("app/[org]/(learner)/");

// ---------------------------------------------------------------------------
// The scanner. Pure over (file name, text), so the planted cases of (f) run
// through exactly the code that reads the repository.
// ---------------------------------------------------------------------------

/** A literal's text with each `${…}` written `${}`: the shape of an address. */
function shapeOf(n: ts.Node | undefined): string | null {
  if (!n) return null;
  if (ts.isParenthesizedExpression(n)) return shapeOf(n.expression);
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isTemplateExpression(n)) return n.head.text + n.templateSpans.map((s) => "${}" + s.literal.text).join("");
  return null;
}
/** The one form a Preview address takes: the org, the course, the mode, nothing else. */
const PREVIEW_ADDRESS = /^\/\$\{\}\/courses\/\$\{\}\/launch\?mode=preview$/;
const LAUNCH_ADDRESS = /\/courses\/\$\{\}\/launch(?:[?#]|$)/;

/** The element whose `href` attribute holds `n`, or null. */
function hrefElement(n: ts.Node): ts.JsxOpeningElement | ts.JsxSelfClosingElement | null {
  let p: ts.Node = n.parent;
  if (p && ts.isJsxExpression(p)) p = p.parent;
  if (!p || !ts.isJsxAttribute(p) || p.name.getText() !== "href") return null;
  const owner = p.parent.parent;
  return ts.isJsxOpeningElement(owner) || ts.isJsxSelfClosingElement(owner) ? owner : null;
}
/** The visible text of an element: its JSX text and its string children, spaces collapsed. */
function textOf(el: ts.JsxOpeningElement | ts.JsxSelfClosingElement): string {
  if (ts.isJsxSelfClosingElement(el)) return "";
  const parts: string[] = [];
  const visit = (x: ts.Node) => {
    if (ts.isJsxText(x)) parts.push(x.text);
    else if (ts.isJsxExpression(x) && x.expression && (ts.isStringLiteral(x.expression) || ts.isNoSubstitutionTemplateLiteral(x.expression))) parts.push(x.expression.text);
    else ts.forEachChild(x, visit);
  };
  for (const c of (el.parent as ts.JsxElement).children) visit(c);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}
/**
 * Whether a condition holds only when `canPreview` does: the bare name, or an
 * `&&` chain with the bare name as one operand. `!canPreview`,
 * `canPreview || x`, `canPreview === false` and the like do not.
 */
function requiresCanPreview(x: ts.Expression): boolean {
  while (ts.isParenthesizedExpression(x)) x = x.expression;
  if (ts.isIdentifier(x)) return x.text === "canPreview";
  if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    return requiresCanPreview(x.left) || requiresCanPreview(x.right);
  }
  return false;
}
/** The nearest condition `n` sits under, on the side that shows it (`&&`, `?:` or `if`), or null. */
function guardOf(n: ts.Node): ts.Expression | null {
  for (let c: ts.Node = n, p = n.parent; p; c = p, p = p.parent) {
    if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && p.right === c) return p.left;
    if (ts.isConditionalExpression(p) && p.whenTrue === c) return p.condition;
    if (ts.isIfStatement(p) && p.thenStatement === c) return p.expression;
  }
  return null;
}
/** Whether `n` sits under a positive canPreview condition (`&&`, `?:` or `if`; see requiresCanPreview). */
function underCanPreview(n: ts.Node): boolean {
  for (let c: ts.Node = n, p = n.parent; p; c = p, p = p.parent) {
    if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && p.right === c && requiresCanPreview(p.left)) return true;
    if (ts.isConditionalExpression(p) && p.whenTrue === c && requiresCanPreview(p.condition)) return true;
    if (ts.isIfStatement(p) && p.thenStatement === c && requiresCanPreview(p.expression)) return true;
  }
  return false;
}
/** Each Preview address's nearest condition, as text (spaces collapsed). */
function previewGuards(file: string, src: string): string[] {
  const sf = parse(file, src);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    const shape = ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n) ? shapeOf(n) : null;
    if (shape !== null && /mode=preview/.test(shape)) out.push(guardOf(n)?.getText(sf).replace(/\s+/g, " ") ?? "(none)");
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

type Site = { file: string; line: number; shape: string; problems: string[] };

/** (a) and (b): every literal that names `mode=preview`, with what is wrong with it. */
function previewSites(file: string, src: string): Site[] {
  const sf = parse(file, src);
  const out: Site[] = [];
  const visit = (n: ts.Node) => {
    const shape = ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n) ? shapeOf(n) : null;
    if (shape !== null && /mode=preview/.test(shape)) {
      const problems: string[] = [];
      if (!PREVIEW_ADDRESS.test(shape)) problems.push(`not a bare preview address: ${shape}`);
      const el = hrefElement(n);
      if (!el) problems.push("not a link's href");
      else if (!/\bPreview\b/.test(textOf(el))) problems.push(`the link's text does not say Preview: "${textOf(el)}"`);
      if (isLearnerPage(file) && !underCanPreview(n)) problems.push("not under a canPreview condition");
      out.push({ file, line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, shape, problems });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** (c): links to a launch address whose text says Preview but whose address names no mode. */
function unmarkedPreviewLinks(file: string, src: string): string[] {
  const sf = parse(file, src);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isJsxOpeningElement(n) && ["Link", "a"].includes(n.tagName.getText())) {
      const href = n.attributes.properties.find((a) => ts.isJsxAttribute(a) && a.name.getText() === "href") as ts.JsxAttribute | undefined;
      const init = href?.initializer;
      const shape = init ? shapeOf(ts.isJsxExpression(init) ? init.expression : init) : null;
      if (shape !== null && LAUNCH_ADDRESS.test(shape) && !/mode=preview/.test(shape) && /\bpreview\b/i.test(textOf(n))) {
        out.push(`${file}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1} "${textOf(n)}" → ${shape}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const calleeName = (c: ts.CallExpression): string | null =>
  ts.isIdentifier(c.expression) ? c.expression.text : ts.isPropertyAccessExpression(c.expression) ? c.expression.name.text : null;
function callsOf(sf: ts.SourceFile, name: string): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && calleeName(n) === name) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
/** Identifier names in a subtree (property names included). */
function idsIn(n: ts.Node): Set<string> {
  const out = new Set<string>();
  const visit = (x: ts.Node) => {
    if (ts.isIdentifier(x)) out.add(x.text);
    ts.forEachChild(x, visit);
  };
  visit(n);
  return out;
}
/** Property names an object-literal argument gives (shorthand included). */
const argProps = (c: ts.CallExpression): string[] =>
  c.arguments.flatMap((a) => (ts.isObjectLiteralExpression(a) ? a.properties.map((p) => p.name?.getText() ?? "") : []));
const line = (sf: ts.SourceFile, n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
const ROLE_NAMES = ["role", "isAdmin", "canManage", "canViewReports", "canPreview"];

/** (d): the learner course page's role reads. */
function coursePageRoleUses(file: string, src: string): string[] {
  const sf = parse(file, src);
  const problems: string[] = [];
  // isAdmin: read at the three uses step 23 keeps on the role, nowhere else.
  const reads: ts.Identifier[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isIdentifier(n) && n.text === "isAdmin" && !(ts.isVariableDeclaration(n.parent) && n.parent.name === n) && !(ts.isPropertyAssignment(n.parent) && n.parent.name === n)) reads.push(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  const KEPT = [
    /^const showAttemptsSection = isAdmin \|\| !attemptsHidden;$/,
    /^\{isAdmin && \(\s*<Link\s+href=\{`\/\$\{orgSlug\}\/library\/\$\{c\.id\}`\}/,
    /^\{isAdmin && attemptsHidden && \(/,
  ];
  const isUse = (p: ts.Node) =>
    ts.isJsxExpression(p) || ts.isVariableStatement(p) || ts.isIfStatement(p) || ts.isExpressionStatement(p) || ts.isReturnStatement(p);
  for (const r of reads) {
    let p: ts.Node = r;
    while (p.parent && !isUse(p)) p = p.parent;
    const text = p.getText().replace(/\s+/g, " ");
    if (!KEPT.some((k) => k.test(text))) problems.push(`isAdmin read at ${line(sf, r)}: ${text.slice(0, 80)}`);
  }
  if (reads.length !== KEPT.length) problems.push(`isAdmin is read ${reads.length} times, want ${KEPT.length}`);
  // The access call, the inactive redirect and the request button name no role.
  // The values the access call is given (a property's name is the
  // function's option, not a read; a shorthand property reads its name).
  for (const c of callsOf(sf, "learnerCanAccessCourse")) {
    const read = new Set<string>();
    for (const a of c.arguments) {
      if (!ts.isObjectLiteralExpression(a)) { idsIn(a).forEach((i) => read.add(i)); continue; }
      for (const p of a.properties) {
        if (ts.isShorthandPropertyAssignment(p)) read.add(p.name.text);
        else if (ts.isPropertyAssignment(p)) idsIn(p.initializer).forEach((i) => read.add(i));
        else idsIn(p).forEach((i) => read.add(i));
      }
    }
    const named = [...read].filter((i) => ROLE_NAMES.includes(i));
    if (named.length) problems.push(`the access call at ${line(sf, c)} names ${named.join(", ")}`);
  }
  const ifs: ts.IfStatement[] = [];
  const visitIf = (n: ts.Node) => {
    if (ts.isIfStatement(n) && /is_active === false/.test(n.expression.getText())) ifs.push(n);
    ts.forEachChild(n, visitIf);
  };
  visitIf(sf);
  if (ifs.length !== 1) problems.push(`want one inactive-course check, found ${ifs.length}`);
  for (const i of ifs) {
    const named = [...idsIn(i.expression)].filter((x) => ROLE_NAMES.includes(x));
    if (named.length) problems.push(`the inactive-course check at ${line(sf, i)} names ${named.join(", ")}`);
  }
  const reqDecl: ts.VariableDeclaration[] = [];
  const visitReq = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && n.name.getText() === "canRequestAttempt") reqDecl.push(n);
    ts.forEachChild(n, visitReq);
  };
  visitReq(sf);
  if (reqDecl.length !== 1) problems.push(`want one canRequestAttempt, found ${reqDecl.length}`);
  for (const d of reqDecl) {
    const named = d.initializer ? [...idsIn(d.initializer)].filter((x) => ROLE_NAMES.includes(x)) : [];
    if (named.length) problems.push(`canRequestAttempt names ${named.join(", ")}`);
  }
  const manages = callsOf(sf, "canManage");
  const asIsAdmin = (c: ts.CallExpression) => ts.isVariableDeclaration(c.parent) && c.parent.name.getText() === "isAdmin";
  if (manages.length !== 1 || !asIsAdmin(manages[0])) {
    problems.push(`canManage is called ${manages.length} times; want once, as isAdmin's initializer`);
  }
  return problems;
}

/** (e) lib/alds/launch.ts: launchModeFor and p4AttemptColumns take no role; no canManage call. */
function launchModuleRoleChecks(file: string, src: string): string[] {
  const sf = parse(file, src);
  const problems: string[] = [];
  for (const name of ["launchModeFor", "p4AttemptColumns"]) {
    let found = false;
    const visit = (n: ts.Node) => {
      if (ts.isFunctionDeclaration(n) && n.name?.text === name) {
        found = true;
        const t = n.parameters[0]?.type;
        const members = t && ts.isTypeLiteralNode(t) ? t.members.map((m) => m.name?.getText() ?? "") : [];
        if (members.includes("role")) problems.push(`${name} takes a role`);
        if (n.parameters.some((p) => /\brole\b/.test(p.name.getText()))) problems.push(`${name} has a role parameter`);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    if (!found) problems.push(`${name} is not declared here`);
  }
  if (callsOf(sf, "canManage").length) problems.push("calls canManage");
  return problems;
}

/** (e) the launch page: no canManage, no role into the mode, canViewReports only beside the preview mode. */
function launchPageRoleChecks(file: string, src: string): string[] {
  const sf = parse(file, src);
  const problems: string[] = [];
  for (const c of callsOf(sf, "canManage")) problems.push(`canManage called at ${line(sf, c)}`);
  for (const name of ["launchModeFor", "p4AttemptColumns"]) {
    for (const c of callsOf(sf, name)) if (argProps(c).includes("role")) problems.push(`${name} given the role at ${line(sf, c)}`);
  }
  for (const c of callsOf(sf, "canViewReports")) {
    // The whole condition it sits in (through &&, ||, ! and parentheses)
    // must read the preview mode itself. The name the value is bound to does
    // not count: `preview: canViewReports(role)` is a role-only bypass.
    let top: ts.Node = c;
    while (top.parent && (ts.isParenthesizedExpression(top.parent) || ts.isPrefixUnaryExpression(top.parent) ||
      (ts.isBinaryExpression(top.parent) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(top.parent.operatorToken.kind)))) top = top.parent;
    const rest = top.getText().replace(c.getText(), "");
    if (!/preview/i.test(rest)) problems.push(`canViewReports at ${line(sf, c)} decides without the mode: ${top.getText().replace(/\s+/g, " ").slice(0, 80)}`);
  }
  return problems;
}

/** (e) the continue page and continueTarget: no staff branch. */
function continueStaffBranch(file: string, src: string): string[] {
  const sf = parse(file, src);
  const problems: string[] = [];
  if (idsIn(sf).has("isStaff")) problems.push("names isStaff");
  for (const c of callsOf(sf, "launchModeFor")) problems.push(`calls launchModeFor at ${line(sf, c)}`);
  return problems;
}

/**
 * (e) The read that tells a preview by its context, in code (comments are not
 * read): a readWithContextFilter call whose callback passes a
 * `.from("course_attempts")` query to withoutPreviews (lib/scoring/context-read.ts,
 * whose default column is context_kind), with the request's own state.
 */
function contextSplitReads(file: string, src: string): number {
  const sf = parse(file, src);
  return callsOf(sf, "readWithContextFilter").filter((c) => {
    const cb = c.arguments[1];
    if (!cb) return false;
    let ok = false;
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && calleeName(n) === "withoutPreviews" && n.arguments[0]) {
        const q = n.arguments[0];
        const hasFrom = (x: ts.Node): boolean =>
          (ts.isCallExpression(x) && calleeName(x) === "from" && !!x.arguments[0] && shapeOf(x.arguments[0]) === "course_attempts") ||
          (ts.forEachChild(x, (y) => (hasFrom(y) ? true : undefined)) ?? false);
        if (hasFrom(q)) ok = true;
      }
      ts.forEachChild(n, visit);
    };
    visit(cb);
    return ok;
  }).length;
}

/** (e) the restart helper, the restart route and the history check: no role set, no membership role read. */
function roleSets(file: string, src: string): string[] {
  const sf = parse(file, src);
  const problems: string[] = [];
  for (const id of ["STAFF_ROLES", "isStaffRole"]) if (idsIn(sf).has(id)) problems.push(`names ${id}`);
  const visit = (n: ts.Node) => {
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && ["super_owner", "admin", "data_analyst"].includes(n.text)) {
      problems.push(`names the role "${n.text}" at ${line(sf, n)}`);
    }
    if (ts.isCallExpression(n) && calleeName(n) === "from" && n.arguments[0] && shapeOf(n.arguments[0]) === "organization_members") {
      problems.push(`reads organization_members at ${line(sf, n)}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return problems;
}

/**
 * (g) the sign-in bounce: every `next` the middleware sets (a `.set` or
 * `.append` whose first argument is "next"), with what is wrong with it.
 * Right is `signInNext(<path>, request.nextUrl.searchParams)`: the path and
 * the query of the request's parsed URL.
 */
function signInBounceSites(file: string, src: string): Array<{ line: number; problems: string[] }> {
  const sf = parse(file, src);
  const out: Array<{ line: number; problems: string[] }> = [];
  for (const c of [...callsOf(sf, "set"), ...callsOf(sf, "append")]) {
    const [key, value] = c.arguments;
    if (!key || shapeOf(key) !== "next") continue;
    const problems: string[] = [];
    if (!value || !ts.isCallExpression(value) || calleeName(value) !== "signInNext") {
      problems.push(`next is not signInNext(…): ${value?.getText(sf) ?? "(none)"}`);
    } else if (value.arguments[1]?.getText(sf) !== "request.nextUrl.searchParams") {
      problems.push(`signInNext is not given the request's query: ${value.getText(sf)}`);
    }
    out.push({ line: line(sf, c), problems });
  }
  return out;
}

// ---------------------------------------------------------------------------
console.log("\n(a) every Preview address is a listed site, a bare launch address with the mode and no product parameter");
const allSites: Site[] = [];
for (const [file, src] of sources) if (src.includes("mode=preview")) allSites.push(...previewSites(file, src));
{
  const byFile = new Map<string, number>();
  for (const s of allSites) byFile.set(s.file, (byFile.get(s.file) ?? 0) + 1);
  eq("the Preview addresses found are SITES, by file and count",
    [...byFile.entries()].map(([f, n]) => `${f}: ${n}`).sort(),
    Object.entries(SITES).map(([f, s]) => `${f}: ${s.count}`).sort());
  for (const [file, s] of Object.entries(SITES)) {
    const mine = allSites.filter((x) => x.file === file);
    eq(`${s.what}: each address is \`/<org>/courses/<course>/launch?mode=preview\``, mine.filter((x) => !PREVIEW_ADDRESS.test(x.shape)).map((x) => `${x.line}: ${x.shape}`), []);
  }
}

console.log("\n(b) each one is a link that says Preview; on a learner page, only for the report-viewing roles");
{
  for (const [file, s] of Object.entries(SITES)) {
    eq(`${s.what}: no problem`, allSites.filter((x) => x.file === file).flatMap((x) => x.problems.map((p) => `${x.line}: ${p}`)), []);
  }
  for (const file of Object.keys(SITES).filter(isLearnerPage)) {
    eq(`${file}: binds canPreview to canViewReports(role)`, /const canPreview = canViewReports\(role\);/.test(sources.get(file) ?? ""), true);
    eq(`${file}: imports canViewReports from lib/auth/permissions`, /import \{[^}]*\bcanViewReports\b[^}]*\} from "@\/lib\/auth\/permissions";/.test(sources.get(file) ?? ""), true);
  }
  const journey = sources.get("app/[org]/(learner)/journey/page.tsx") ?? "";
  eq("the journey page offers DayPreview on each day it lists: the revisit list and the completed, current and not-yet-open week rows",
    (journey.match(/<DayPreview canPreview=\{canPreview\}/g) ?? []).length, 4);
  const COURSE_PAGE = "app/[org]/(learner)/courses/[courseId]/page.tsx";
  const coursePage = sources.get(COURSE_PAGE) ?? "";
  eq("the course page: the card's \"Preview instead\" is gated like the Preview beside Start (a version and an active language)",
    previewGuards(COURSE_PAGE, coursePage), ["canPreview && current && !noActiveLanguage", "canPreview && current && !noActiveLanguage"]);
  {
    const at = (s: string) => coursePage.indexOf(s);
    const order = [
      at("if (previewOnly && !canPreview) {"),
      at('.from("course_versions")'),
      at('.from("course_packages")'),
      at("const noActiveLanguage ="),
      at("if (previewOnly) {"),
    ];
    eq("…a role that may not preview is sent away before the version and language reads; the card comes after them",
      order.every((x, i) => x > -1 && (i === 0 || x > order[i - 1])), true);
  }
  eq("the course page: an impersonation has its own line on the card, never \"not enrolled\"",
    [/data-testid=\{impersonation \? "impersonation-preview-only" : "not-enrolled"\}/.test(coursePage),
      /\{impersonation\s*\?\s*"You're impersonating, so this course opens as a preview only\."\s*:\s*access\.upcomingAt\s*\?\s*"This course is not released to you yet\."\s*:\s*"You're not enrolled in this course\."\s*\}/.test(coursePage)],
    [true, true]);
  eq("…and the card without a version or an active language says why, with no link",
    /\) : \(\s*<p className="text-sm text-muted" data-testid="preview-unavailable">\s*\{current\s*\?\s*"Not available right now: every language of this course is hidden\."\s*:\s*"This course doesn't have a version yet\."\s*\}\s*<\/p>\s*\)\}/.test(coursePage), true);
  const pathPage = sources.get("app/[org]/(learner)/paths/[pathId]/page.tsx") ?? "";
  eq("the path page hands canPreview to every StepCard", /<StepCard[\s\S]{0,400}?canPreview=\{canPreview\}[\s\S]{0,40}?\/>/.test(pathPage), true);
  eq("the path page's step Preview sits outside the Start/Locked/Coming soon choice (every step)",
    /\{inProgress \? "Resume" : "Launch"\}\s*<\/Link>\s*\)\}[\s\S]{0,300}?\{canPreview && \(\s*<Link\s+href=\{`\/\$\{orgSlug\}\/courses\/\$\{step\.course_id\}\/launch\?mode=preview`\}/.test(pathPage), true);
}

console.log("\n(c) a launch link that says Preview carries the mode");
{
  const found: string[] = [];
  for (const [file, src] of sources) if (/\.tsx$/.test(file) && /\/launch/.test(src)) found.push(...unmarkedPreviewLinks(file, src));
  eq("no launch link labelled Preview without ?mode=preview", found, []);
}

console.log("\n(d) the learner course page reads the role only where step 23 keeps it");
{
  const file = "app/[org]/(learner)/courses/[courseId]/page.tsx";
  eq("isAdmin at the attempts section, the Library link and the badge only; no role at the access call, the inactive redirect or the request button",
    coursePageRoleUses(file, sources.get(file) ?? ""), []);
}

console.log("\n(e) the other D7 sites of step 23 decide by the mode or the row's context, never by the role");
{
  eq("lib/alds/launch.ts: launchModeFor and p4AttemptColumns take no role; no canManage",
    launchModuleRoleChecks("lib/alds/launch.ts", sources.get("lib/alds/launch.ts") ?? ""), []);
  const launch = "app/[org]/(learner)/courses/[courseId]/launch/page.tsx";
  eq("the launch page: no canManage, no role into the launch mode, canViewReports only beside the preview mode",
    launchPageRoleChecks(launch, sources.get(launch) ?? ""), []);
  for (const file of ["app/[org]/(learner)/continue/page.tsx", "lib/learner/continue.ts"]) {
    eq(`${file}: no staff branch`, continueStaffBranch(file, sources.get(file) ?? ""), []);
  }
  const RESTART_ROUTE = "app/api/courses/[courseId]/packages/[packageId]/versions/[versionId]/restart/route.ts";
  for (const file of ["lib/attempts/restart.ts", RESTART_ROUTE, "lib/courses/learner-history.ts"]) {
    eq(`${file}: no role set and no membership role read`, roleSets(file, sources.get(file) ?? ""), []);
  }
  // In code, not in comments: the route's count and the history check each
  // read through readWithContextFilter over withoutPreviews (context_kind,
  // with step 72's fallback), and the route's classes come from previewIdsOf.
  const routeSrc = sources.get(RESTART_ROUTE) ?? "";
  const routeSf = parse(RESTART_ROUTE, routeSrc);
  eq("the restart count and the history check tell a preview by context_kind (a context-filtered read in code)",
    [contextSplitReads(RESTART_ROUTE, routeSrc) >= 1,
      callsOf(routeSf, "previewIdsOf").length === 1 &&
        callsOf(routeSf, "planRestart").every((c) => c.arguments[2]?.getText(routeSf) === "previewIds"),
      contextSplitReads("lib/courses/learner-history.ts", sources.get("lib/courses/learner-history.ts") ?? "") >= 1], [true, true, true]);
  // The API keeps the key `by_role.staff`; what it counts is previews, so the
  // dialog the admin approves says "previews" (spec 34 reads the sentence).
  const DIALOG = "app/[org]/(admin)/library/[courseId]/version-actions.tsx";
  const dialog = sources.get(DIALOG) ?? "";
  eq("the restart dialog calls by_role.staff previews, never staff",
    [/data-testid="restart-counts">[\s\S]{0,200}?\{previewCount\(plan\.by_role\.staff\)\};/.test(dialog),
      /const previewCount = \(n: number \| null\) =>\s*typeof n === "number" \? plural\(n, "preview", "previews"\) : "previews not counted";/.test(dialog),
      /\bstaff;/.test(dialog.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""))],
    [true, true, false]);
  eq("non-vacuous: every scanned D7 file exists", [
    "lib/alds/launch.ts", launch, "app/[org]/(learner)/continue/page.tsx", "lib/learner/continue.ts",
    "lib/attempts/restart.ts", RESTART_ROUTE, "lib/courses/learner-history.ts", DIALOG,
  ].filter((f) => !sources.has(f)), []);
}

console.log("\n(f) planted sources");
{
  const L = "app/[org]/(learner)/planted/page.tsx";
  const A = "app/[org]/(admin)/planted/page.tsx";
  const problemsOf = (file: string, src: string) => previewSites(file, src).map((s) => s.problems);
  eq("a learner page's Preview under canPreview, with the bare address: no problem",
    problemsOf(L, "const x = <div>{canPreview && (<Link href={`/${o}/courses/${c}/launch?mode=preview`}>Preview</Link>)}</div>;"), [[]]);
  eq("…in a component that returns it under `canPreview ? … : null`: no problem",
    problemsOf(L, "function P({ canPreview }) { return canPreview ? (<Link href={`/${o}/courses/${c}/launch?mode=preview`}><Eye /> Preview</Link>) : null; }"), [[]]);
  eq("…in an early return under `if (canPreview)`: no problem",
    problemsOf(L, "function P() { if (canPreview) { return (<Link href={`/${o}/courses/${c}/launch?mode=preview`}>Preview instead</Link>); } return null; }"), [[]]);
  eq("?lp= beside the mode is flagged (a product parameter)",
    problemsOf(A, "const x = <Link href={`/${o}/courses/${c}/launch?lp=${p}&mode=preview`}>Preview</Link>;"), [["not a bare preview address: /${}/courses/${}/launch?lp=${}&mode=preview"]]);
  eq("the mode followed by &journey= and &day= is flagged",
    problemsOf(A, "const x = <Link href={`/${o}/courses/${c}/launch?mode=preview&journey=${e}&day=${d}`}>Preview</Link>;"), [["not a bare preview address: /${}/courses/${}/launch?mode=preview&journey=${}&day=${}"]]);
  eq("a run named beside the mode is flagged (phase P)",
    problemsOf(A, "const x = <Link href={`/${o}/courses/${c}/launch?mode=preview&run=${r}`}>Preview</Link>;"), [["not a bare preview address: /${}/courses/${}/launch?mode=preview&run=${}"]]);
  eq("a mode fragment outside a whole address is flagged",
    problemsOf(A, "const q = \"?mode=preview\";"), [["not a bare preview address: ?mode=preview", "not a link's href"]]);
  eq("a Start link carrying the mode is flagged",
    problemsOf(A, "const x = <Link href={`/${o}/courses/${c}/launch?mode=preview`}>Start</Link>;"), [["the link's text does not say Preview: \"Start\""]]);
  eq("a redirect to a preview address is flagged (not a link)",
    problemsOf(A, "redirect(`/${o}/courses/${c}/launch?mode=preview`);"), [["not a link's href"]]);
  eq("a learner page's Preview without a canPreview condition is flagged",
    problemsOf(L, "const x = <div>{isAdmin && (<Link href={`/${o}/courses/${c}/launch?mode=preview`}>Preview</Link>)}</div>;"), [["not under a canPreview condition"]]);
  eq("…canPreview on the wrong side of `?:` is flagged",
    problemsOf(L, "const x = canPreview ? null : (<Link href={`/${o}/courses/${c}/launch?mode=preview`}>Preview</Link>);"), [["not under a canPreview condition"]]);
  eq("…a negated canPreview before `&&` is flagged",
    problemsOf(L, "const x = <div>{!canPreview && (<Link href={`/${o}/courses/${c}/launch?mode=preview`}>Preview</Link>)}</div>;"), [["not under a canPreview condition"]]);
  eq("…a negated canPreview in `?:` is flagged (the link on the true branch)",
    problemsOf(L, "function P({ canPreview }) { return !canPreview ? (<Link href={`/${o}/courses/${c}/launch?mode=preview`}>Preview</Link>) : null; }"), [["not under a canPreview condition"]]);
  eq("…a negated canPreview inside an `&&` chain is flagged",
    problemsOf(L, "const x = <div>{!canPreview && current && (<Link href={`/${o}/courses/${c}/launch?mode=preview`}>Preview</Link>)}</div>;"), [["not under a canPreview condition"]]);
  eq("…canPreview under `||`, or compared, is flagged",
    [problemsOf(L, "const x = <div>{(canPreview || isAdmin) && (<Link href={`/${o}/courses/${c}/launch?mode=preview`}>Preview</Link>)}</div>;"),
      problemsOf(L, "const x = canPreview === false ? (<Link href={`/${o}/courses/${c}/launch?mode=preview`}>Preview</Link>) : null;"),
      problemsOf(L, "function P() { if (!canPreview) { return (<Link href={`/${o}/courses/${c}/launch?mode=preview`}>Preview</Link>); } return null; }")],
    [[["not under a canPreview condition"]], [["not under a canPreview condition"]], [["not under a canPreview condition"]]]);
  eq("…a positive `&&` chain on `?:`'s true branch, in a fragment, passes",
    problemsOf(L, "const x = <div>{canPreview && current && !noActiveLanguage ? (<><Link href={`/${o}/courses/${c}/launch?mode=preview`}>Preview instead</Link><p>x</p></>) : (<p>Not available</p>)}</div>;"), [[]]);
  // Mutants of the real sources, fed to the scanner in memory (no file is
  // changed): each inverted condition must be flagged.
  {
    const J = "app/[org]/(learner)/journey/page.tsx";
    const journeySrc = sources.get(J) ?? "";
    const journeyMutant = journeySrc.replace("return canPreview ? (", "return !canPreview ? (");
    eq("mutant: the journey's DayPreview with `return !canPreview ? (` is flagged",
      [journeyMutant !== journeySrc, problemsOf(J, journeyMutant).flat()], [true, ["not under a canPreview condition"]]);
    const CP = "app/[org]/(learner)/courses/[courseId]/page.tsx";
    const courseSrc = sources.get(CP) ?? "";
    const cardMutant = courseSrc.replace("{canPreview && current && !noActiveLanguage ? (", "{!canPreview && current && !noActiveLanguage ? (");
    eq("mutant: the course page's card with `!canPreview && current && …` is flagged",
      [cardMutant !== courseSrc, problemsOf(CP, cardMutant).flat()], [true, ["not under a canPreview condition"]]);
  }
  eq("a Preview-labelled launch link without the mode is flagged (the Library's link before P2-5)",
    unmarkedPreviewLinks(A, "const x = <Link href={`/${o}/courses/${c.id}/launch`}>Preview launch</Link>;"), ["app/[org]/(admin)/planted/page.tsx:1 \"Preview launch\" → /${}/courses/${}/launch"]);
  eq("…a Start link without the mode is not",
    unmarkedPreviewLinks(A, "const x = <Link href={`/${o}/courses/${c.id}/launch?lp=${p}`}>Start</Link>;"), []);

  eq("(d) planted: isAdmin at the access call, the inactive check and the request button is flagged",
    coursePageRoleUses("planted.tsx", [
      "const isAdmin = canManage(role);",
      "if (course.is_active === false && !isAdmin) redirect(x);",
      "const access = await learnerCanAccessCourse({ supabase, isAdmin });",
      "const canRequestAttempt = !isAdmin && ok;",
    ].join("\n")), [
      "isAdmin read at 2: if (course.is_active === false && !isAdmin) redirect(x);",
      "isAdmin read at 3: const access = await learnerCanAccessCourse({ supabase, isAdmin });",
      "isAdmin read at 4: const canRequestAttempt = !isAdmin && ok;",
      "the access call at 3 names isAdmin",
      "the inactive-course check at 2 names isAdmin",
      "canRequestAttempt names isAdmin",
    ]);
  eq("(d) planted: the option named isAdmin given `false` passes; given canPreview it is flagged",
    coursePageRoleUses("planted.tsx", [
      "const isAdmin = canManage(role);",
      "const a = await learnerCanAccessCourse({ supabase, isAdmin: false });",
      "const b = await learnerCanAccessCourse({ supabase, isAdmin: canPreview });",
      "if (course.is_active === false) redirect(x);",
      "const canRequestAttempt = ok;",
      "const showAttemptsSection = isAdmin || !attemptsHidden;",
    ].join("\n")).filter((p) => !/^isAdmin is read/.test(p)), ["the access call at 3 names canPreview"]);
  eq("(e) planted: launchModeFor by role is flagged",
    launchModuleRoleChecks("planted.ts", [
      "export function launchModeFor(i: { role: OrgRole; revision: boolean }) { if (canManage(i.role)) return 1; return 2; }",
      "export function p4AttemptColumns(i: { mode: string | null; revision: boolean }) { return 3; }",
    ].join("\n")), ["launchModeFor takes a role", "calls canManage"]);
  eq("…by mode passes",
    launchModuleRoleChecks("planted.ts", [
      "export function launchModeFor(i: { preview: boolean; revision: boolean }) { return i.preview ? 1 : 2; }",
      "export function p4AttemptColumns(i: { preview: boolean; revision: boolean; language: string | null }) { return launchModeFor(i); }",
    ].join("\n")), []);
  eq("(e) planted: the launch page's role checks are flagged",
    launchPageRoleChecks("planted.tsx", [
      "const a = await learnerCanAccessCourse({ isAdmin: canManage(role) });",
      "const b = launchModeFor({ role, revision: false });",
      "const c = p4AttemptColumns({ role: role, revision: false, language });",
      "if (canViewReports(role)) skipGate();",
      "const d = await learnerCanAccessCourse({ preview: canViewReports(role) });",
      "const previewAllowed = canViewReports(role);",
    ].join("\n")), [
      "canManage called at 1",
      "launchModeFor given the role at 2",
      "p4AttemptColumns given the role at 3",
      "canViewReports at 4 decides without the mode: canViewReports(role)",
      "canViewReports at 5 decides without the mode: canViewReports(role)",
      "canViewReports at 6 decides without the mode: canViewReports(role)",
    ]);
  eq("…the bypass beside the mode passes",
    launchPageRoleChecks("planted.tsx", [
      "const a = await learnerCanAccessCourse({ preview: canViewReports(role) && modeParam === \"preview\" });",
      "const e = await learnerCanAccessCourse({ preview: canViewReports(role) && preview });",
      "const b = launchModeFor({ mode, revision: false });",
    ].join("\n")), []);
  eq("(e) planted: Continue's staff branch is flagged",
    continueStaffBranch("planted.tsx", "const isStaff = launchModeFor({ role, revision: false }).isPreview; if (isStaff) redirect(x);"),
    ["names isStaff", "calls launchModeFor at 1"]);
  eq("(e) planted: a role set and a membership role read are flagged",
    roleSets("planted.ts", [
      "export const STAFF_ROLES = new Set([\"super_owner\", \"admin\", \"data_analyst\"]);",
      "const { data } = await svc.from(\"organization_members\").select(\"user_id, role\");",
    ].join("\n")), [
      "names STAFF_ROLES",
      "names the role \"super_owner\" at 1",
      "names the role \"admin\" at 1",
      "names the role \"data_analyst\" at 1",
      "reads organization_members at 2",
    ]);
  eq("…a count by context_kind passes",
    roleSets("planted.ts", "const staff = rows.filter((a) => a.context_kind === \"preview\").length;"), []);
  eq("a context-filtered read in code counts once",
    contextSplitReads("planted.ts",
      "const r = await readWithContextFilter(previews, (apply) => withoutPreviews(svc.from(\"course_attempts\").select(\"id\").in(\"id\", ids), apply));"), 1);
  eq("…context_kind named only in a comment, or a filter on another table, counts nothing",
    [contextSplitReads("planted.ts", "// the read drops context_kind = 'preview' rows\nconst r = await svc.from(\"course_attempts\").select(\"id\");"),
      contextSplitReads("planted.ts", "const r = await readWithContextFilter(p, (apply) => withoutPreviews(svc.from(\"courses\").select(\"id\"), apply));")], [0, 0]);
  eq("(g) planted: a bounce that sets next from the path alone is flagged; signInNext with the request's query passes",
    signInBounceSites("planted.ts", [
      "url.searchParams.set(\"next\", path);",
      "url.searchParams.set(\"next\", signInNext(path, request.nextUrl.searchParams));",
      "url.searchParams.append(\"next\", cleanNext);",
      "url.searchParams.set(\"next\", signInNext(path, new URLSearchParams()));",
      "response.cookies.set(name, value);",
    ].join("\n")).sort((a, b) => a.line - b.line).map((s) => `${s.line}: ${s.problems.join("; ") || "ok"}`), [
      "1: next is not signInNext(…): path",
      "2: ok",
      "3: next is not signInNext(…): cleanNext",
      "4: signInNext is not given the request's query: signInNext(path, new URLSearchParams())",
    ]);
}

console.log("\n(g) the sign-in bounce keeps the Preview mode: each next the middleware sets is the path and its query");
{
  const MW = "lib/supabase/middleware.ts";
  const mw = sources.get(MW) ?? "";
  const bounces = signInBounceSites(MW, mw);
  eq("lib/supabase/middleware.ts sets next twice (the org or platform login, and a white-label domain's /login)", bounces.length, 2);
  eq("…each through signInNext(<path>, request.nextUrl.searchParams), never the path alone",
    bounces.flatMap((b) => b.problems.map((p) => `${b.line}: ${p}`)), []);
  eq("…imported from lib/auth/safe-next", /import \{[^}]*\bsignInNext\b[^}]*\} from "@\/lib\/auth\/safe-next";/.test(mw), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
