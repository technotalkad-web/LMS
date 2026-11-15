/**
 * The Start of a course reached only through an "Everyone" path (ADR 0024
 * ruling A3; the P2-6 review, lens launch F2).
 *
 * Since P2-6 a Start with no product parameter is decided by the launch's
 * resolver, whose path holders are the paths the learner has an assignment
 * row on. A learner who reaches a course only through an active "Everyone"
 * (org_public) path with no row of theirs is refused (`not_enrolled`) by a
 * plain Start. The dashboard's path-only card and the course page now carry
 * that path's `?lp=`, so the resolver's path row enrols them first (A3);
 * every other Start stays plain. One pure picker decides it for both pages
 * (everyonePathStart, lib/auth/course-access.ts):
 *
 *   (a) the picker: an Everyone-only course gets its path; an individually
 *       held course, an "Everyone" course, a course also on a path the
 *       learner has a row on (released or not), a path that is not
 *       "Everyone", and an unreleased step get none; of several, the lowest
 *       path id whatever the input order;
 *   (b) the course page's access check (learnerCanAccessCourse) on a stub
 *       client: startPathId in exactly that case; never for a course with a
 *       direct assignment row (released, or future-dated: the resolver's
 *       "not yet released" stays), an assigned path or its own "Everyone"
 *       visibility; an inactive or another organisation's path is no
 *       candidate;
 *   (c) `allowed` and `upcomingAt` are unchanged by the two-pass path loop:
 *       every combination of five step kinds and three direct-assignment
 *       states, in both orders, against today's one-pass rule;
 *   (d) the dashboard card's href (courseCardHref): `&lp=` for a card naming
 *       a path, a plain Start otherwise, "View details" for a completed card;
 *   (e) source scans with planted cases: the grid's only launch href is
 *       courseCardHref's; the dashboard calls the picker once, in the
 *       path-only card loop, from the assigned-path set read before the
 *       "Everyone" fold, and only that loop's card carries startPathId; the
 *       course page's Start reads access.startPathId and its Preview links
 *       carry no `lp`.
 *
 * No database, no network.
 *
 * Run:  npx tsx tests/unit/course-path-start.test.ts   (or npm run test:unit)
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { everyonePathStart, learnerCanAccessCourse } from "../../lib/auth/course-access";
import { courseCardHref } from "../../app/[org]/(learner)/dashboard/dashboard-grid";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const root = path.resolve(__dirname, "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const NOW = Date.parse("2026-11-15T12:00:00Z");
const PAST = "2020-01-01T00:00:00Z";
const FUTURE = "2999-01-01T00:00:00Z";

/* ---------------- (a) the picker ---------------- */

function pickerCases() {
  console.log("\n(a) everyonePathStart");
  const step = (pathId: string, o: { everyone?: boolean; enrolled?: boolean; releaseAt?: string | null } = {}) => ({
    pathId, everyone: o.everyone ?? true, enrolled: o.enrolled ?? false, releaseAt: o.releaseAt ?? null,
  });
  const pick = (steps: ReturnType<typeof step>[], o: { courseIsEveryone?: boolean; directlyHeld?: boolean } = {}) =>
    everyonePathStart({ courseIsEveryone: o.courseIsEveryone ?? false, directlyHeld: o.directlyHeld ?? false, steps, now: NOW });

  eq("Everyone-only: the course's one released Everyone step names its path", pick([step("pe")]), "pe");
  eq("…a past release date is released", pick([step("pe", { releaseAt: PAST })]), "pe");
  eq("an individually held course (a released direct assignment): plain", pick([step("pe")], { directlyHeld: true }), null);
  eq("an \"Everyone\" course: plain (a plain Start self-enrols on the course)", pick([step("pe")], { courseIsEveryone: true }), null);
  eq("also on a path the learner has a row on (released): plain", pick([step("pe"), step("pa", { everyone: false, enrolled: true })]), null);
  eq("…on that path's unreleased step: plain (the resolver redirects into it)", pick([step("pe"), step("pa", { everyone: false, enrolled: true, releaseAt: FUTURE })]), null);
  eq("…an \"Everyone\" path the learner has a row on (e.g. a team's): plain", pick([step("pe", { enrolled: true })]), null);
  eq("an unreleased Everyone step: none", pick([step("pe", { releaseAt: FUTURE })]), null);
  eq("a private path with no row: none", pick([step("pp", { everyone: false })]), null);
  eq("no step at all: none", pick([]), null);
  eq("two Everyone paths: the lowest path id", pick([step("p-b"), step("p-a")]), "p-a");
  eq("…in either input order", pick([step("p-a"), step("p-b")]), "p-a");
  eq("…compared in lower case, the id returned as given", pick([step("P-B"), step("p-c"), step("P-A")]), "P-A");
  eq("…an unreleased lower id is skipped for a released one", pick([step("p-a", { releaseAt: FUTURE }), step("p-b")]), "p-b");
}

/* ---------------- (b), (c) the course page's access check on a stub client ---------------- */

const ORG = "org-1";
const USER = "u1";
type StepRow = { path: string; everyone: boolean; release?: string | null; active?: boolean; org?: string };
type Direct = { type: "user" | "team" | "org"; release?: string | null; user?: string };
type PathRow = { path: string; type: "user" | "team" | "org"; user?: string };
type World = { steps?: StepRow[]; direct?: Direct[]; pathRows?: PathRow[]; visibility?: string };

function stub(w: World) {
  const tables: string[] = [];
  const rowsOf = (table: string, ops: Array<[string, unknown[]]>): unknown[] => {
    switch (table) {
      case "team_members":
        return [{ team_id: "t1", teams: { organization_id: ORG } }];
      case "course_assignments":
        return (w.direct ?? []).map((d) => ({
          assignee_type: d.type, user_id: d.type === "user" ? d.user ?? USER : null, team_id: d.type === "team" ? "t1" : null,
          group_id: null, release_at: d.release ?? null,
        }));
      case "learning_path_courses":
        return (w.steps ?? []).map((s) => ({
          path_id: s.path, release_at: s.release ?? null,
          learning_paths: { id: s.path, is_active: s.active !== false, visibility: s.everyone ? "org_public" : "private", organization_id: s.org ?? ORG },
        }));
      case "learning_path_assignments": {
        const ids = (ops.find(([o, a]) => o === "in" && a[0] === "path_id")?.[1][1] ?? []) as string[];
        return (w.pathRows ?? []).filter((r) => ids.includes(r.path)).map((r) => ({
          path_id: r.path, assignee_type: r.type, user_id: r.type === "user" ? r.user ?? USER : null,
          team_id: r.type === "team" ? "t1" : null, group_id: null,
        }));
      }
      default:
        return []; // journey_enrollments: none, so the journey branch grants nothing
    }
  };
  const from = (table: string) => {
    tables.push(table);
    const ops: Array<[string, unknown[]]> = [];
    let single = false;
    const b: Record<string, unknown> = {};
    for (const op of ["select", "eq", "in", "neq", "is", "limit", "order", "range"]) b[op] = (...a: unknown[]) => (ops.push([op, a]), b);
    b.abortSignal = () => b;
    b.maybeSingle = () => ((single = true), b);
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
      const rows = rowsOf(table, ops);
      return Promise.resolve({ data: single ? rows[0] ?? null : rows, error: null }).then(res, rej);
    };
    return b;
  };
  return { client: { from }, tables };
}

async function access(w: World) {
  const s = stub(w);
  const r = await learnerCanAccessCourse({
    supabase: s.client as never, orgId: ORG, userId: USER, courseId: "c1", preview: false, visibility: w.visibility ?? "private",
  });
  return { allowed: r.allowed, upcomingAt: r.upcomingAt, startPathId: r.startPathId ?? null, tables: s.tables };
}

async function accessCases() {
  console.log("\n(b) learnerCanAccessCourse: startPathId, the course page's Start");
  const only = await access({ steps: [{ path: "pe", everyone: true }] });
  eq("Everyone-only: allowed, the Start carries pe's ?lp=", [only.allowed, only.startPathId], [true, "pe"]);
  eq("…with no further read than today's (no journey read: the path granted)",
    only.tables, ["team_members", "course_assignments", "learning_path_courses", "learning_path_assignments"]);
  eq("an individually held course (own released assignment) beside the Everyone path: plain",
    (await access({ steps: [{ path: "pe", everyone: true }], direct: [{ type: "user" }] })).startPathId, null);
  eq("…a team's released assignment: plain",
    (await access({ steps: [{ path: "pe", everyone: true }], direct: [{ type: "team" }] })).startPathId, null);
  eq("…an org-wide released assignment: plain",
    (await access({ steps: [{ path: "pe", everyone: true }], direct: [{ type: "org" }] })).startPathId, null);
  const dated = await access({ steps: [{ path: "pe", everyone: true }], direct: [{ type: "user", release: FUTURE }] });
  eq("a future-dated own assignment beside the Everyone path: allowed through pe, but plain (the resolver's \"not yet released\" is not the not_enrolled case; the dashboard shows the course's own card as Coming soon)",
    [dated.allowed, dated.startPathId], [true, null]);
  eq("…a team's future-dated assignment: plain too",
    (await access({ steps: [{ path: "pe", everyone: true }], direct: [{ type: "team", release: FUTURE }] })).startPathId, null);
  eq("an \"Everyone\" course: allowed, plain (a plain Start self-enrols on the course)",
    [(await access({ steps: [{ path: "pe", everyone: true }], visibility: "org_public" })).allowed, (await access({ steps: [{ path: "pe", everyone: true }], visibility: "org_public" })).startPathId], [true, null]);
  eq("also a step of a path the learner is assigned (own row): plain",
    (await access({ steps: [{ path: "pe", everyone: true }, { path: "pa", everyone: false }], pathRows: [{ path: "pa", type: "user" }] })).startPathId, null);
  eq("…assigned through a team, its step unreleased: allowed through pe, still plain (the resolver redirects into pa)",
    await access({ steps: [{ path: "pe", everyone: true }, { path: "pa", everyone: false, release: FUTURE }], pathRows: [{ path: "pa", type: "team" }] })
      .then((r) => [r.allowed, r.startPathId]), [true, null]);
  eq("an Everyone path the learner has an org-wide row on: plain (the resolver's holder)",
    (await access({ steps: [{ path: "pe", everyone: true }], pathRows: [{ path: "pe", type: "org" }] })).startPathId, null);
  eq("another learner's own row on the Everyone path does not count as the learner's",
    (await access({ steps: [{ path: "pe", everyone: true }], pathRows: [{ path: "pe", type: "user", user: "u2" }] })).startPathId, "pe");
  eq("two Everyone paths: the lowest id, in either row order",
    [(await access({ steps: [{ path: "p-b", everyone: true }, { path: "p-a", everyone: true }] })).startPathId,
     (await access({ steps: [{ path: "p-a", everyone: true }, { path: "p-b", everyone: true }] })).startPathId], ["p-a", "p-a"]);
  eq("…the unreleased one skipped",
    (await access({ steps: [{ path: "p-a", everyone: true, release: FUTURE }, { path: "p-b", everyone: true }] })).startPathId, "p-b");
  const inactive = await access({ steps: [{ path: "pe", everyone: true, active: false }] });
  eq("an inactive Everyone path grants nothing and names nothing", [inactive.allowed, inactive.startPathId], [false, null]);
  const other = await access({ steps: [{ path: "pe", everyone: true, org: "org-2" }] });
  eq("another organisation's Everyone path grants nothing and names nothing", [other.allowed, other.startPathId], [false, null]);
  const later = await access({ steps: [{ path: "pe", everyone: true, release: FUTURE }] });
  eq("an unreleased Everyone step: not allowed, upcomingAt its date, nothing named", [later.allowed, later.upcomingAt, later.startPathId], [false, FUTURE, null]);

  console.log("\n(c) allowed and upcomingAt unchanged by the two-pass path loop");
  // Five step kinds, each on its own path; today's one-pass rule as the reference.
  const KINDS = {
    E_rel: { path: "pe1", everyone: true, release: null },
    E_fut: { path: "pe2", everyone: true, release: "2999-03-01T00:00:00Z" },
    A_rel: { path: "pa1", everyone: false, release: PAST },
    A_fut: { path: "pa2", everyone: false, release: "2997-01-01T00:00:00Z" },
    N: { path: "pn", everyone: false, release: null },
  } as const;
  const PATH_ROWS: PathRow[] = [{ path: "pa1", type: "user" }, { path: "pa2", type: "team" }];
  const DIRECTS: Record<string, Direct[]> = { none: [], released: [{ type: "user" }], dated: [{ type: "user", release: "2998-01-01T00:00:00Z" }] };
  const names = Object.keys(KINDS) as Array<keyof typeof KINDS>;
  let cases = 0;
  const mismatches: string[] = [];
  for (let mask = 0; mask < 1 << names.length; mask++) {
    const chosen = names.filter((_, i) => mask & (1 << i));
    for (const [dName, direct] of Object.entries(DIRECTS)) {
      for (const order of ["forward", "reverse"] as const) {
        const list = order === "forward" ? chosen : [...chosen].reverse();
        const steps: StepRow[] = list.map((k) => ({ ...KINDS[k] }));
        // Today's rule (one pass over the steps, before P2-6's review).
        const entitled = list.filter((k) => k !== "N");
        const directReleased = dName === "released";
        const pathReleased = entitled.some((k) => k.endsWith("_rel"));
        const allowed = directReleased || pathReleased;
        const pending = [
          ...(dName === "dated" ? ["2998-01-01T00:00:00Z"] : []),
          ...entitled.filter((k) => k.endsWith("_fut")).map((k) => KINDS[k].release as string),
        ].sort();
        const wantUpcoming = allowed ? null : pending[0] ?? null;
        // The Start: Everyone-only (no direct row, released or not; no assigned path) and released.
        const wantStart = allowed && dName === "none" && !list.some((k) => k.startsWith("A_")) && list.includes("E_rel") ? "pe1" : null;
        const got = await access({ steps, direct, pathRows: PATH_ROWS });
        cases++;
        const want = [allowed, wantUpcoming, wantStart];
        const have = [got.allowed, got.upcomingAt, got.startPathId];
        if (JSON.stringify(want) !== JSON.stringify(have)) mismatches.push(`${list.join("+") || "no step"} / direct ${dName} / ${order}: got ${JSON.stringify(have)}, want ${JSON.stringify(want)}`);
      }
    }
  }
  eq(`all ${cases} combinations (32 step sets × 3 direct states × 2 orders) answer today's allowed and upcomingAt, and startPathId only Everyone-only`, mismatches, []);
}

/* ---------------- (d) the dashboard card's href ---------------- */

function hrefCases() {
  console.log("\n(d) courseCardHref, the dashboard card's button");
  eq("a path-only card naming an Everyone path: the launch with &lp=",
    courseCardHref("o", { course_id: "c1", status: "not_started", startPathId: "pe" }), "/o/courses/c1/launch?back=dashboard&lp=pe");
  eq("…in progress (Resume) too", courseCardHref("o", { course_id: "c1", status: "in_progress", startPathId: "pe" }), "/o/courses/c1/launch?back=dashboard&lp=pe");
  eq("…failed (Try again / Revise) too", courseCardHref("o", { course_id: "c1", status: "failed", startPathId: "pe" }), "/o/courses/c1/launch?back=dashboard&lp=pe");
  eq("an individually held course (no startPathId): a plain Start", courseCardHref("o", { course_id: "c1", status: "not_started" }), "/o/courses/c1/launch?back=dashboard");
  eq("…startPathId null: a plain Start", courseCardHref("o", { course_id: "c1", status: "in_progress", startPathId: null }), "/o/courses/c1/launch?back=dashboard");
  eq("completed or passed: \"View details\", the course page, whatever the path",
    [courseCardHref("o", { course_id: "c1", status: "completed", startPathId: "pe" }), courseCardHref("o", { course_id: "c1", status: "passed" })],
    ["/o/courses/c1", "/o/courses/c1"]);
  eq("the path id is encoded", courseCardHref("o", { course_id: "c1", status: "not_started", startPathId: "a b&c" }), "/o/courses/c1/launch?back=dashboard&lp=a%20b%26c");
}

/* ---------------- (e) source scans ---------------- */

const GRID = "app/[org]/(learner)/dashboard/dashboard-grid.tsx";
const DASH = "app/[org]/(learner)/dashboard/page.tsx";
const COURSE = "app/[org]/(learner)/courses/[courseId]/page.tsx";

const parse = (name: string, src: string) => ts.createSourceFile(name, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function each(node: ts.Node, fn: (n: ts.Node) => void) {
  fn(node);
  ts.forEachChild(node, (c) => each(c, fn));
}
const enclosing = <T extends ts.Node>(n: ts.Node, test: (x: ts.Node) => x is T): T | null => {
  for (let p = n.parent; p; p = p.parent) if (test(p)) return p;
  return null;
};
const fnName = (n: ts.Node): string | null => {
  const f = enclosing(n, (x): x is ts.FunctionDeclaration => ts.isFunctionDeclaration(x));
  return f?.name?.text ?? null;
};

/** The grid: every launch href is built inside courseCardHref, and the Card's Link uses it. */
function gridProblems(src: string): string[] {
  const sf = parse(GRID, src);
  const problems: string[] = [];
  let uses = 0;
  each(sf, (n) => {
    if ((ts.isTemplateExpression(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isStringLiteral(n)) && n.getText().includes("/launch")) {
      if (fnName(n) !== "courseCardHref") problems.push(`a launch href outside courseCardHref: ${n.getText().slice(0, 60)}`);
    }
    if (ts.isJsxAttribute(n) && n.name.getText() === "href" && n.initializer && /courseCardHref\(/.test(n.initializer.getText())) uses++;
  });
  if (uses !== 1) problems.push(`courseCardHref used by ${uses} href(s), owed 1`);
  return problems;
}

/** The dashboard: one picker call, in the path-only loop, fed from the assigned set; only that loop's card carries startPathId. */
function dashboardProblems(src: string): string[] {
  const sf = parse(DASH, src);
  const problems: string[] = [];
  const calls: ts.CallExpression[] = [];
  const pushes: Array<{ obj: ts.ObjectLiteralExpression; loop: string | null; fn: string | null }> = [];
  let assignedInit: string | null = null;
  each(sf, (n) => {
    if (ts.isCallExpression(n) && n.expression.getText() === "everyonePathStart") calls.push(n);
    if (ts.isCallExpression(n) && n.expression.getText() === "cards.push" && n.arguments[0] && ts.isObjectLiteralExpression(n.arguments[0])) {
      const loop = enclosing(n, (x): x is ts.ForOfStatement => ts.isForOfStatement(x));
      pushes.push({ obj: n.arguments[0], loop: loop ? loop.expression.getText() : null, fn: fnName(n) });
    }
    if (ts.isVariableDeclaration(n) && n.name.getText() === "assignedPathIds") assignedInit = n.initializer?.getText() ?? null;
  });
  if (calls.length !== 1) problems.push(`everyonePathStart called ${calls.length} time(s), owed 1`);
  for (const c of calls) {
    const loop = enclosing(c, (x): x is ts.ForOfStatement => ts.isForOfStatement(x));
    if (loop?.expression.getText() !== "pathNameByCourseId") problems.push("the picker is called outside the path-only card loop");
    const arg = c.arguments[0]?.getText() ?? "";
    if (!/enrolled:\s*assignedPathIds\.has\(/.test(arg)) problems.push("the picker's enrolled is not read from assignedPathIds");
    if (!/everyone:\s*everyonePathIds\.has\(/.test(arg)) problems.push("the picker's everyone is not read from everyonePathIds");
    if (!/courseIsEveryone:\s*orgPublicCourseIds\.includes\(/.test(arg)) problems.push("the picker's courseIsEveryone is not read from orgPublicCourseIds");
  }
  if (assignedInit === null || !/^new Set\(myPathAssigns\./.test(assignedInit)) problems.push(`assignedPathIds is not built from myPathAssigns (got ${assignedInit})`);
  const has = (o: ts.ObjectLiteralExpression, name: string) => o.properties.some((p) => p.name?.getText() === name);
  const pathOnly = pushes.filter((p) => p.loop === "pathNameByCourseId");
  const others = pushes.filter((p) => p.loop !== "pathNameByCourseId");
  if (pathOnly.length !== 1 || !has(pathOnly[0].obj, "startPathId")) problems.push("the path-only card does not carry startPathId");
  if (pathOnly.length === 1 && !/startPathName/.test(pathOnly[0].obj.properties.find((p) => p.name?.getText() === "pathName")?.getText() ?? "")) {
    problems.push("the path-only card's badge does not name the picked path");
  }
  for (const p of others) if (has(p.obj, "startPathId")) problems.push(`a card outside the path-only loop carries startPathId (${p.fn ?? p.loop})`);
  if (others.length === 0) problems.push("pushCard's card not found");
  return problems;
}

/** The course page: the Start reads access.startPathId into ?lp=; no Preview link carries lp. */
function coursePageProblems(src: string): string[] {
  const sf = parse(COURSE, src);
  const problems: string[] = [];
  let starts = 0;
  each(sf, (n) => {
    if (!ts.isJsxAttribute(n) || n.name.getText() !== "href" || !n.initializer) return;
    const h = n.initializer.getText();
    if (!h.includes("/launch")) return;
    if (h.includes("mode=preview")) {
      if (/[?&]lp=|startPathId/.test(h)) problems.push(`a Preview link carries lp: ${h}`);
      return;
    }
    starts++;
    if (!/access\.startPathId\s*\?\s*`\?lp=\$\{encodeURIComponent\(access\.startPathId\)\}`\s*:\s*""/.test(h)) problems.push(`a Start without access.startPathId's ?lp=: ${h}`);
  });
  if (starts !== 1) problems.push(`${starts} Start link(s), owed 1`);
  return problems;
}

function scanCases() {
  console.log("\n(e) source scans");
  const grid = read(GRID);
  const dash = read(DASH);
  const course = read(COURSE);
  eq("dashboard-grid.tsx: the only launch href is courseCardHref's, used by the Card's Start", gridProblems(grid), []);
  eq("dashboard/page.tsx: one picker call, in the path-only loop, from the assigned set; only that card carries startPathId", dashboardProblems(dash), []);
  eq("courses/[courseId]/page.tsx: the Start carries access.startPathId's ?lp=, the Preview links no lp", coursePageProblems(course), []);

  console.log("\n(e) planted cases");
  const inlineGrid = grid.replace("href={courseCardHref(orgSlug, card)}", "href={`/${orgSlug}/courses/${card.course_id}/launch?back=dashboard`}");
  eq("planted: the grid's Start back on an inline launch href is flagged", gridProblems(inlineGrid).length, 2);
  const noStart = dash.replace(/\n(\s*)startPathId,\r?\n/, "\n");
  eq("planted: the path-only card without startPathId is flagged", dashboardProblems(noStart).includes("the path-only card does not carry startPathId"), true);
  const onPushCard = dash.replace("      pathName: pathNameByCourseId.get(course.id) ?? null,", "      pathName: pathNameByCourseId.get(course.id) ?? null,\n      startPathId: null,");
  eq("planted: startPathId on pushCard's card is flagged", dashboardProblems(onPushCard).some((p) => p.startsWith("a card outside the path-only loop")), true);
  const afterFold = dash.replace("new Set(myPathAssigns.map((a) => a.path_id))", "new Set(myPathIds)");
  eq("planted: the assigned set built after the Everyone fold is flagged", dashboardProblems(afterFold).some((p) => p.startsWith("assignedPathIds is not built")), true);
  const badge = dash.replace("pathName: startPathName ?? pathName,", "pathName,");
  eq("planted: a badge that may name another path is flagged", dashboardProblems(badge).includes("the path-only card's badge does not name the picked path"), true);
  const plain = course.replace(/\$\{access\.startPathId \? `\?lp=\$\{encodeURIComponent\(access\.startPathId\)\}` : ""\}/, "");
  eq("planted: the course page's Start back to a plain /launch is flagged", coursePageProblems(plain).some((p) => p.startsWith("a Start without")), true);
  const lpPreview = course.replace("launch?mode=preview`}\n", "launch?mode=preview&lp=${access.startPathId}`}\n").replace("launch?mode=preview`}\r\n", "launch?mode=preview&lp=${access.startPathId}`}\r\n");
  eq("planted: a Preview link carrying lp is flagged", coursePageProblems(lpPreview).some((p) => p.startsWith("a Preview link carries lp")), true);
}

async function main() {
  const quiet = console.warn;
  console.warn = () => {};
  pickerCases();
  await accessCases();
  hrefCases();
  scanCases();
  console.warn = quiet;
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
