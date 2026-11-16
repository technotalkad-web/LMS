/**
 * The journey page's launch links (ADR 0024 step 22; P2-6 item 7; the P2-6
 * review, lens tests T1 = lens access F2, and T2), with the real page run.
 *
 * A credited day is reviewed on the course on its credit row, never on the
 * day's current course after a publish swapped it, and every journey link
 * carries the day: its id where the pinned version has day_ids (0107), its
 * number on a database without the column. The launch's resolver refuses a
 * credited day launched on its swapped course and a review without a day
 * (day_not_open), so a link that drifts back to the day's course, or loses
 * `&day=`, locks the learner out of reviewing a course they finished.
 *
 * The page is called as Next calls a server component. requireOrgAccess and
 * the server Supabase client are stubbed at module load; everything else is
 * the real code (the credits reader, readWithOptionalColumn, the journey
 * twin). The returned element tree is walked, not rendered: the review links
 * are inline in it. On the stub client:
 *
 *   (a) an active enrolment whose day 2 a publish swapped from P (credited)
 *       to B: the week list's done-day rows and the day grid's cells link
 *       day 1 to A and day 2 to P, each with its day id; no journey link
 *       names B; today's mission and its row link day 3's course with its id;
 *   (b) a completed enrolment: "Revisit your missions" lists only the
 *       credited days, in day order, each on its credit row's course with
 *       its day id (day 2 on P, never B; day 3, uncredited, absent); an
 *       inactive program shows no list;
 *   (c) a database without the day_ids column (production before 0107; the
 *       T2 fallback): the version read is answered 42703 naming day_ids and
 *       read once more without it, the credits are read by number, and the
 *       page renders with every journey link carrying the day's number, day
 *       2 still on P;
 *   (d) the planted cases: the same checks run over trees built from a
 *       wrong page (a done-day link on the day's current course, a link
 *       without `&day=`, a link with the number where the id is owed), and
 *       each check flags it, so (a) to (c) cannot pass vacuously;
 *   (e) ADR 0024 P2-9's "Change language" under today's mission
 *       (data-testid mission-change-language; the review's F2 and F3): shown
 *       for a course with two active packages, absent for one, linking the
 *       launch's own picker in the day's context (?switch=choose); on a day
 *       whose open attempt is on another course only (the day's course
 *       swapped after the learner started it) no link is shown, whatever
 *       either course's languages; with the mission's course open too, the
 *       link names the mission's course.
 *
 * No database, no network.
 *
 * Run:  npx tsx tests/unit/journey-review-links.test.ts   (or npm run test:unit)
 */
import Module from "node:module";
import React from "react";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const ORG = "org-1";
const USER = "u1";
const ENR = "e1000000-0000-4000-8000-000000000001";
const VER = "e2000000-0000-4000-8000-000000000001";
// Day ids (lower case).
const D1 = "d0000000-0000-4000-8000-000000000001";
const D2 = "d0000000-0000-4000-8000-000000000002";
const D3 = "d0000000-0000-4000-8000-000000000003";
const D4 = "d0000000-0000-4000-8000-000000000004";
const DAY_IDS = { "1": D1, "2": D2, "3": D3, "4": D4 };
// Courses: day 2 holds B now; the learner credited day 2 on P before a publish swapped it.
const A = "c0000000-0000-4000-8000-00000000000a";
const B = "c0000000-0000-4000-8000-00000000000b";
const C = "c0000000-0000-4000-8000-00000000000c";
const D = "c0000000-0000-4000-8000-00000000000d";
const P = "c0000000-0000-4000-8000-0000000000aa";
const DAYS = [
  { day: 1, course_id: A, mission_title: null },
  { day: 2, course_id: B, mission_title: null },
  { day: 3, course_id: C, mission_title: null },
  { day: 4, course_id: D, mission_title: null },
];

type PgErr = { code: string; message: string };
type Credit = { day: number; dayId: string; course: string };
type World = {
  status: "active" | "completed";
  programActive: boolean;
  credits: Credit[];
  /** A database without 0107: a select naming day_ids or day_id answers 42703. */
  no0107: boolean;
  /** Active packages per course (none when absent): the "Change language" count. */
  packages?: Record<string, number>;
  /** The learner's open journey attempts, oldest first: their day's number and course. */
  open?: Array<{ day: number; course: string }>;
};
type Req = { table: string; select: string; ops: Array<[string, unknown[]]> };

/** A recording query builder answering from `w`. */
function stubClient(w: World) {
  const reqs: Req[] = [];
  const answer = (r: Req, single: boolean): { data: unknown; error: PgErr | null; count?: number } => {
    const range = r.ops.find(([o]) => o === "range")?.[1] as [number, number] | undefined;
    const rows = ((): unknown[] | PgErr => {
      switch (r.table) {
        case "journey_enrollments":
          return [{
            id: ENR, program_id: "jp1", version_id: VER, start_date: "2026-01-01", status: w.status,
            completed_at: w.status === "completed" ? "2026-03-01T10:00:00Z" : null, created_at: "2026-01-01T00:00:00Z",
            journey_programs: { is_active: w.programActive, name: "Yoddha", icon: "🏹" },
          }];
        case "journey_versions": {
          if (w.no0107 && /\bday_ids\b/.test(r.select)) return { code: "42703", message: "column journey_versions.day_ids does not exist" };
          const row: Record<string, unknown> = {
            id: VER, name: "Yoddha", icon: "🏹", days_total: 4, count_sundays: true, milestones: null,
            completion_title: "Yoddha", days: DAYS, unlock_mode: "calendar",
          };
          if (/\bday_ids\b/.test(r.select)) row.day_ids = DAY_IDS;
          return [row];
        }
        case "journey_day_progress": {
          if (w.no0107 && /\bday_id\b/.test(r.select)) return { code: "42703", message: "column journey_day_progress.day_id does not exist" };
          const withId = /\bday_id\b/.test(r.select);
          const all = w.credits.map((c) => ({
            enrollment_id: ENR, day_number: c.day, completed_at: "2026-02-01T10:00:00Z", course_id: c.course,
            ...(withId ? { day_id: c.dayId } : {}),
          }));
          return range ? all.slice(range[0], range[1] + 1) : all;
        }
        case "gamification_settings":
          return [{ timezone: "Asia/Kolkata" }];
        case "courses": {
          const ids = (r.ops.find(([o, a]) => o === "in" && a[0] === "id")?.[1][1] ?? []) as string[];
          return ids.map((id) => ({ id, title: `Course ${id.slice(-2)}` }));
        }
        case "course_attempts": {
          const day = r.ops.find(([o, a]) => o === "eq" && a[0] === "journey_day")?.[1][1];
          return (w.open ?? []).filter((a) => a.day === day).map((a, i) => ({ id: `open-${i}`, course_versions: { course_id: a.course } }));
        }
        default:
          return [];
      }
    })();
    if (!Array.isArray(rows)) return { data: null, error: rows };
    if (r.table === "course_packages") {
      const course = r.ops.find(([o, a]) => o === "eq" && a[0] === "course_id")?.[1][1] as string | undefined;
      return { data: null, error: null, count: (course && w.packages?.[course]) || 0 };
    }
    return { data: single ? rows[0] ?? null : rows, error: null };
  };
  const from = (table: string) => {
    const r: Req = { table, select: "", ops: [] };
    reqs.push(r);
    let single = false;
    const b: Record<string, unknown> = {};
    for (const op of ["eq", "in", "neq", "is", "limit", "order", "range", "or", "gt", "lt"]) b[op] = (...a: unknown[]) => (r.ops.push([op, a]), b);
    b.abortSignal = () => b;
    b.select = (s: string) => ((r.select = s), b);
    b.maybeSingle = () => ((single = true), b);
    b.single = () => ((single = true), b);
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(answer(r, single)).then(res, rej);
    return b;
  };
  return { client: { from }, reqs };
}

/** One link of the tree: its href, and whether it sits inside the "View all days" grid (<details>). */
type Found = { href: string; inGrid: boolean; label: string | null };

/** Every element with an href, walking children and fragments (function components are not called). */
function linksOf(node: unknown, inGrid = false, out: Found[] = []): Found[] {
  if (node === null || node === undefined || typeof node === "boolean" || typeof node === "string" || typeof node === "number") return out;
  if (Array.isArray(node)) {
    for (const n of node) linksOf(n, inGrid, out);
    return out;
  }
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (!el.props) return out;
  const grid = inGrid || el.type === "details";
  if (typeof el.props.href === "string") {
    out.push({ href: el.props.href, inGrid: grid, label: typeof el.props["aria-label"] === "string" ? (el.props["aria-label"] as string) : null });
  }
  linksOf(el.props.children, grid, out);
  return out;
}

/** The tree's text: every string and number child, joined. */
function textOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const el = node as { props?: Record<string, unknown> };
  return el.props ? textOf(el.props.children) : "";
}

/** The journey launch links: `/o/courses/<course>/launch?journey=<E>&day=<day>` → {course, journey, day}. */
function journeyLinks(found: Found[]) {
  return found
    .filter((f) => f.href.includes("/launch?journey="))
    .map((f) => {
      const m = /^\/o\/courses\/([^/]+)\/launch\?(.*)$/.exec(f.href);
      const q = new URLSearchParams(m?.[2] ?? "");
      return { course: m?.[1] ?? null, journey: q.get("journey"), day: q.get("day"), inGrid: f.inGrid, label: f.label, href: f.href };
    });
}

/**
 * The review checks of (a), over a tree's links; each returns the problems
 * it found (none = the links are right). Run over the real page in (a) to
 * (c) and over planted wrong trees in (d).
 */
function reviewProblems(found: Found[], expect: { byId: boolean; credited: Array<[number, string, string]>; uncreditedNotLinked: number[]; swappedCourse: string }) {
  const links = journeyLinks(found);
  const problems: string[] = [];
  for (const l of links) {
    if (l.journey !== ENR) problems.push(`${l.href}: journey`);
    if (l.day === null || l.day === "") problems.push(`${l.href}: no day`);
    else if (expect.byId && !/^[0-9a-f-]{36}$/.test(l.day)) problems.push(`${l.href}: the day's number where its id is owed`);
    else if (!expect.byId && !/^\d+$/.test(l.day)) problems.push(`${l.href}: not a day number`);
  }
  for (const [n, dayId, course] of expect.credited) {
    const dayKey = expect.byId ? dayId : String(n);
    for (const where of ["row", "grid"] as const) {
      const hit = links.filter((l) => l.label === `Revise day ${n}` && l.inGrid === (where === "grid"));
      if (hit.length !== 1) { problems.push(`day ${n}: ${hit.length} ${where} review link(s)`); continue; }
      if (hit[0].course !== course) problems.push(`day ${n} ${where}: course ${hit[0].course}, owed ${course} (the credit row's)`);
      if (hit[0].day !== dayKey) problems.push(`day ${n} ${where}: day ${hit[0].day}, owed ${dayKey}`);
    }
  }
  for (const n of expect.uncreditedNotLinked) {
    if (links.some((l) => l.label === `Revise day ${n}`)) problems.push(`day ${n}: a review link on an uncredited day`);
  }
  const swappedDay = expect.byId ? D2 : "2";
  if (links.some((l) => l.course === expect.swappedCourse && l.day === swappedDay)) problems.push(`day 2: a link to the swapped-in course ${expect.swappedCourse}`);
  return problems;
}

/** The checks of (b) over the completed page's links: the Revisit list (no aria-label, not in the grid). */
function revisitProblems(found: Found[], want: Array<[string, string]>) {
  const got = journeyLinks(found).map((l) => [l.course, l.day]);
  return JSON.stringify(got) === JSON.stringify(want) ? [] : [`Revisit links ${JSON.stringify(got)}, owed ${JSON.stringify(want)}`];
}

async function main() {
  const quiet = console.warn;
  console.warn = () => {};
  let client: { from: (t: string) => unknown } | null = null;
  const realLoad = (Module as unknown as { _load: (...a: unknown[]) => unknown })._load;
  (Module as unknown as { _load: (...a: unknown[]) => unknown })._load = function (this: unknown, request: unknown, ...rest: unknown[]) {
    if (request === "@/lib/auth/require-org-access") {
      return { requireOrgAccess: async () => ({ user: { id: USER }, org: { id: ORG, name: "Org" }, role: "user", impersonation: null }) };
    }
    if (request === "@/lib/supabase/server") return { createClient: async () => client };
    return realLoad.call(this, request, ...rest);
  };
  (globalThis as { React?: unknown }).React = React;
  const page = (await import("../../app/[org]/(learner)/journey/page")).default as (a: unknown) => Promise<unknown>;

  const run = async (w: World) => {
    const s = stubClient(w);
    client = s.client;
    const tree = await page({ params: Promise.resolve({ org: "o" }), searchParams: Promise.resolve({}) });
    return { found: linksOf(tree), reqs: s.reqs, text: textOf(tree) };
  };
  const CREDITS: Credit[] = [
    { day: 1, dayId: D1, course: A },
    { day: 2, dayId: D2, course: P },
  ];

  console.log("\n(a) an active enrolment, day 2 credited on P and swapped to B by a publish");
  {
    const r = await run({ status: "active", programActive: true, credits: CREDITS, no0107: false });
    const links = journeyLinks(r.found);
    eq("the review checks find nothing wrong", reviewProblems(r.found, { byId: true, credited: [[1, D1, A], [2, D2, P]], uncreditedNotLinked: [3, 4], swappedCourse: B }), []);
    eq("the week list's done-day rows: day 1 on A, day 2 on P (the credit row's course), each with its day id",
      links.filter((l) => !l.inGrid && l.label?.startsWith("Revise")).map((l) => [l.label, l.course, l.day]),
      [["Revise day 1", A, D1], ["Revise day 2", P, D2]]);
    eq("the day grid's cells: the same two, inside \"View all days\"",
      links.filter((l) => l.inGrid).map((l) => [l.label, l.course, l.day]),
      [["Revise day 1", A, D1], ["Revise day 2", P, D2]]);
    eq("today's mission (day 3) and its row link C with day 3's id",
      links.filter((l) => !l.label).map((l) => [l.course, l.day]),
      [[C, D3], [C, D3]]);
    eq("no journey link names B, the day's swapped-in course", links.some((l) => l.course === B), false);
    eq("the version was read once, with day_ids", r.reqs.filter((q) => q.table === "journey_versions" && /day_ids/.test(q.select) && q.select.includes("days_total")).length, 1);
  }

  console.log("\n(b) a completed enrolment: \"Revisit your missions\"");
  {
    const credits: Credit[] = [...CREDITS, { day: 4, dayId: D4, course: D }];
    const r = await run({ status: "completed", programActive: true, credits, no0107: false });
    eq("the list holds the credited days only, in order, each on its credit row's course with its day id (day 3, uncredited, absent; day 2 on P, never B)",
      revisitProblems(r.found, [[A, D1], [P, D2], [D, D4]]), []);
    eq("…and the celebration rendered (the page did not stop at a missing version)", r.text.includes("UNLOCKED"), true);
    const off = await run({ status: "completed", programActive: false, credits, no0107: false });
    eq("an inactive program: no Revisit list, no journey link at all", journeyLinks(off.found).length, 0);
  }

  console.log("\n(c) a database without day_ids (no 0107): the version read's fallback");
  {
    const r = await run({ status: "active", programActive: true, credits: CREDITS, no0107: true });
    const versionReads = r.reqs.filter((q) => q.table === "journey_versions" && q.select.includes("days_total"));
    eq("the version is read twice: with day_ids (42703), then without it",
      versionReads.map((q) => /\bday_ids\b/.test(q.select)), [true, false]);
    eq("the page renders the journey, not \"This journey version is no longer available\"",
      [r.text.includes("no longer available"), r.text.includes("Week 1 roadmap")], [false, true]);
    eq("the review checks by number find nothing wrong (day 2 still on P)",
      reviewProblems(r.found, { byId: false, credited: [[1, D1, A], [2, D2, P]], uncreditedNotLinked: [3, 4], swappedCourse: B }), []);
    eq("every journey link carries the day's number",
      journeyLinks(r.found).map((l) => [l.label ?? "mission", l.course, l.day]),
      // In tree order: today's mission, the week list (day 1, day 2, day 3's row), the grid.
      [["mission", C, "3"], ["Revise day 1", A, "1"], ["Revise day 2", P, "2"], ["mission", C, "3"], ["Revise day 1", A, "1"], ["Revise day 2", P, "2"]]);
    const done = await run({ status: "completed", programActive: true, credits: CREDITS, no0107: true });
    eq("…and the completed enrolment's Revisit list carries the numbers", revisitProblems(done.found, [[A, "1"], [P, "2"]]), []);
  }

  console.log("\n(d) planted cases: each check flags a wrong page");
  {
    const link = (course: string, day: string | null, label: string | null, inGrid: boolean): Found => ({
      href: `/o/courses/${course}/launch?journey=${ENR}${day === null ? "" : `&day=${day}`}`, inGrid, label,
    });
    const good = [
      link(A, D1, "Revise day 1", false), link(P, D2, "Revise day 2", false), link(C, D3, null, false),
      link(A, D1, "Revise day 1", true), link(P, D2, "Revise day 2", true),
    ];
    const opts = { byId: true, credited: [[1, D1, A], [2, D2, P]] as Array<[number, string, string]>, uncreditedNotLinked: [3, 4], swappedCourse: B };
    eq("the right links pass", reviewProblems(good, opts), []);
    eq("planted: the done-day row on the day's current course (entry.course_id) is flagged",
      reviewProblems(good.map((f) => (f.label === "Revise day 2" && !f.inGrid ? link(B, D2, f.label, false) : f)), opts),
      [`day 2 row: course ${B}, owed ${P} (the credit row's)`, `day 2: a link to the swapped-in course ${B}`]);
    eq("planted: the grid cell on the day's current course is flagged",
      reviewProblems(good.map((f) => (f.label === "Revise day 2" && f.inGrid ? link(B, D2, f.label, true) : f)), opts),
      [`day 2 grid: course ${B}, owed ${P} (the credit row's)`, `day 2: a link to the swapped-in course ${B}`]);
    eq("planted: a link without &day= is flagged",
      reviewProblems(good.map((f) => (f.label === "Revise day 1" && f.inGrid ? link(A, null, f.label, true) : f)), opts).length > 0, true);
    eq("planted: the day's number where its id is owed is flagged",
      reviewProblems(good.map((f) => (f.label === "Revise day 1" && !f.inGrid ? link(A, "1", f.label, false) : f)), opts).length > 0, true);
    eq("planted: a review link on an uncredited day is flagged",
      reviewProblems([...good, link(C, D3, "Revise day 3", false)], opts).length > 0, true);
    eq("planted: a Revisit list on the day's current course, or without &day=, is flagged",
      [revisitProblems([link(A, D1, null, false), link(B, D2, null, false)], [[A, D1], [P, D2]]).length > 0,
       revisitProblems([link(A, D1, null, false), link(P, null, null, false)], [[A, D1], [P, D2]]).length > 0], [true, true]);
  }

  console.log("\n(e) P2-9: \"Change language\" under today's mission (the review's F2 and F3)");
  {
    /** The tree's "Change language" links (data-testid mission-change-language). */
    const switchLinks = (node: unknown, out: string[] = []): string[] => {
      if (node === null || node === undefined || typeof node !== "object") return out;
      if (Array.isArray(node)) {
        for (const n of node) switchLinks(n, out);
        return out;
      }
      const props = (node as { props?: Record<string, unknown> }).props;
      if (!props) return out;
      if (props["data-testid"] === "mission-change-language" && typeof props.href === "string") out.push(props.href);
      switchLinks(props.children, out);
      return out;
    };
    const runTree = async (w: World) => {
      const s = stubClient(w);
      client = s.client;
      const tree = await page({ params: Promise.resolve({ org: "o" }), searchParams: Promise.resolve({}) });
      return { links: switchLinks(tree), reqs: s.reqs };
    };
    const base: World = { status: "active", programActive: true, credits: CREDITS, no0107: false };
    /** The course day 3 held when the learner started it, before a publish swapped it to C. */
    const S = "c0000000-0000-4000-8000-0000000000ab";
    const picker = (course: string) => `/o/courses/${course}/launch?journey=${ENR}&day=${D3}&switch=choose`;
    const two = await runTree({ ...base, packages: { [C]: 2 } });
    eq("today's mission (day 3, course C) with two active packages: one link, the launch's own picker in day 3's context",
      two.links, [picker(C)]);
    eq("…one count of C's active packages", two.reqs.filter((q) => q.table === "course_packages").map((q) => q.ops.find(([o, a]) => o === "eq" && a[0] === "course_id")?.[1][1]), [C]);
    eq("one active package: no link", (await runTree({ ...base, packages: { [C]: 1 } })).links, []);
    eq("F2: day 3 started on S before a publish swapped it to C; S has two languages, C one: no link (the day would not reopen S, so every other language is refused)",
      (await runTree({ ...base, packages: { [C]: 1, [S]: 2 }, open: [{ day: 3, course: S }] })).links, []);
    eq("F2: …both S and C have two languages: still no link (a swapped day never offers the switch)",
      (await runTree({ ...base, packages: { [C]: 2, [S]: 2 }, open: [{ day: 3, course: S }] })).links, []);
    eq("…open attempts of S (older) and of C on day 3: the mission's course first, as launch_context picks it",
      (await runTree({ ...base, packages: { [C]: 2, [S]: 2 }, open: [{ day: 3, course: S }, { day: 3, course: C }] })).links, [picker(C)]);
    eq("…an open attempt of today's own course: the link names it", (await runTree({ ...base, packages: { [C]: 2 }, open: [{ day: 3, course: C }] })).links, [picker(C)]);
  }

  console.warn = quiet;
  (Module as unknown as { _load: (...a: unknown[]) => unknown })._load = realLoad;
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
