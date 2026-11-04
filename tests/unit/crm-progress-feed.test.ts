/**
 * Unit tests for ADR 0014 PR 1b: the CRM `progress` feed
 * (lib/integrations/progress.ts buildProgress, run under tsx against a
 * by-table fake) and the wiring of its two routes (source checks).
 *
 *   - a revision visit's row changes no `attempts`, `first_access`,
 *     `last_access`, `status` or `progress_pct` (steps 7 and 12);
 *   - a running granted retake: `status: in_progress`, the standing `score`,
 *     the retake's `progress_pct`, `official_retake: in_progress`,
 *     `completed_at` the standing attempt's, `overdue: false`, and the path
 *     object's `steps_completed` unchanged (step 10; ADR 0014:195);
 *   - a completed granted retake: its `score`, `previous_official_*`,
 *     `completed_at` the retake's;
 *   - a failed grant read throws GrantReadError (the route's 503);
 *   - `revision_visits` / `last_revision_at` from the visits, null/null when
 *     the read fails (or stops at the page cap), 0/null when the table is
 *     missing; the shape of every new field.
 *
 * learner-summary computes the same per-course fields inline (it has no
 * callable pure half: it authenticates by API key and does its reads in the
 * route), so its proof is this file's buildProgress cases (the same rules)
 * plus source checks that its expressions are the feed's, character for
 * character, and of its 503.
 *
 * Run:  npx tsx tests/unit/crm-progress-feed.test.ts   (or npm run test:unit)
 * (No DB.)
 */
import fs from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildProgress, type CourseProgress, type LearnerProgress, type MemberRow, type ProgressFilters } from "../../lib/integrations/progress";
import { GrantReadError } from "../../lib/scoring/attempt-kind";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

/* ---------------- the by-table fake ---------------- */

type Row = Record<string, unknown>;
type Op = { op: string; args: unknown[] };
type Q = { table: string; ops: Op[] };
type Fault = (q: Q) => { code: string; message: string } | null;
/**
 * Answers by table name, honours .eq / .in on top-level columns a row
 * carries (embedded and .or filters are ignored), and ignores ranges unless
 * `pageOf` says otherwise; `fault` may answer any query with an error; rpc
 * answers no policy rows (DEFAULT_POLICY).
 */
function fakeDb(tables: Record<string, Row[]>, opts: { fault?: Fault; pageOf?: (q: Q) => Row[] | null } = {}) {
  const queries: Q[] = [];
  const keep = (o: Op, r: Row) => {
    const [col, v] = o.args as [unknown, unknown];
    if (typeof col !== "string" || col.includes(".") || !(col in r)) return true;
    if (o.op === "eq") return r[col] === v;
    if (o.op === "in") return (v as unknown[]).includes(r[col]);
    return true;
  };
  const from = (table: string) => {
    const q: Q = { table, ops: [] };
    queries.push(q);
    let single = false;
    const answer = () => {
      const err = opts.fault?.(q) ?? null;
      if (err) return { data: null, error: err };
      const paged = opts.pageOf?.(q) ?? null;
      const rows = paged ?? (tables[table] ?? []).filter((r) => q.ops.every((o) => keep(o, r)));
      return { data: single ? rows[0] ?? null : rows, error: null };
    };
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            const value = answer();
            return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(value).then(res, rej);
          }
          if (prop === "maybeSingle" || prop === "single") return () => ((single = true), proxy);
          return (...args: unknown[]) => {
            q.ops.push({ op: String(prop), args });
            return proxy;
          };
        },
      }
    );
    return proxy;
  };
  const db = { from, rpc: async () => ({ data: [], error: null }) } as unknown as SupabaseClient;
  return { db, queries };
}

/* ---------------- the fixture: one learner, one course, one path ---------------- */

const ORG = "org-1";
const USER = "user-1";
const COURSE = "course-1";
const VERSION = "ver-1";
const PATH_ID = "path-1";
const day = (d: number, h = 9) => `2026-10-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:00:00.000Z`;
const PAST_DUE = day(3);

const attempt = (id: string, d: number, ss: "passed" | "failed" | null, over: Row = {}): Row => ({
  id,
  user_id: USER,
  organization_id: ORG,
  course_version_id: VERSION,
  score: ss === "passed" ? 0.85 : ss === "failed" ? 0.6 : null,
  started_at: day(d),
  completed_at: ss ? day(d, 10) : null,
  last_activity_at: ss ? day(d, 10) : day(d, 9),
  completion_status: ss ? "completed" : "in_progress",
  success_status: ss ?? "unknown",
  status: ss ? "completed" : "in_progress",
  progress_pct: ss ? 100 : 30,
  is_revision: false,
  ...over,
});
const grant = (id: string, usedAttemptId: string): Row => ({
  id,
  organization_id: ORG,
  user_id: USER,
  course_id: COURSE,
  status: "approved",
  used_attempt_id: usedAttemptId,
  used_at: day(9),
  expires_at: null,
  created_at: day(8),
  decided_by: "admin-1",
  decided_at: day(8),
  decision_note: "re-certification",
  reason: "please",
  reissued_from: null,
});
/** A revision visit's row: flagged, open, newest, with progress and a late last_activity_at. */
const revisionRow = attempt("v1", 14, null, { is_revision: true, progress_pct: 40, last_activity_at: day(14, 12) });

const tables = (attempts: Row[], extra: Partial<Record<string, Row[]>> = {}): Record<string, Row[]> => ({
  course_attempts: attempts,
  course_versions: [{ id: VERSION, course_id: COURSE }],
  course_assignments: [{ id: "ca1", organization_id: ORG, course_id: COURSE, assignee_type: "user", user_id: USER, team_id: null, group_id: null, due_at: PAST_DUE, release_at: null, assigned_at: day(1, 8) }],
  learning_path_assignments: [{ id: "pa1", organization_id: ORG, path_id: PATH_ID, assignee_type: "user", user_id: USER, team_id: null, group_id: null, due_at: null, assigned_at: day(1, 8) }],
  team_members: [],
  learning_path_courses: [{ path_id: PATH_ID, course_id: COURSE, step_number: 1 }],
  learning_paths: [{ id: PATH_ID, name: "Path One", is_active: true }],
  journey_enrollments: [],
  journey_day_progress: [],
  courses: [{ id: COURSE, title: "Course One", is_active: true, pass_required: true }],
  attempt_requests: [],
  revision_visits: [],
  ...extra,
});

const MEMBER: MemberRow = { user_id: USER, employee_id: "E1", role: "user", status: "active", email: "learner@example.test", first_name: "Lee", last_name: "Arner" };
const NO_FILTERS: ProgressFilters = {
  employeeIds: [],
  emails: [],
  courseIds: [],
  journeyIds: [],
  completedFrom: null,
  completedTo: null,
  lastAccessFrom: null,
  lastAccessTo: null,
  includeInactive: false,
};
const run = (t: Record<string, Row[]>, opts: Parameters<typeof fakeDb>[1] = {}) => {
  const f = fakeDb(t, opts);
  return { ...f, out: buildProgress(f.db, ORG, "org", [MEMBER], NO_FILTERS, "Asia/Kolkata") };
};
const courseOf = (out: LearnerProgress[]): CourseProgress => out[0].courses[0];
const BOOM = { code: "XX000", message: "boom" };
const MISSING_TABLE = { code: "42P01", message: 'relation "public.revision_visits" does not exist' };

async function main() {
  console.log("\na revision visit's row changes nothing in the course object (ADR 0014 steps 7, 12)");
  {
    const base = courseOf(await run(tables([attempt("a1", 1, "passed")])).out);
    const withVisit = courseOf(await run(tables([attempt("a1", 1, "passed"), revisionRow])).out);
    const pick = (c: CourseProgress) => ({
      attempts: c.attempts,
      first_access: c.first_access,
      last_access: c.last_access,
      status: c.status,
      progress_pct: c.progress_pct,
      score: c.score,
      completed_at: c.completed_at,
      practice_attempts: c.practice_attempts,
    });
    eq("attempts, first/last access, status, progress_pct, score, completed_at are as without the row", pick(withVisit), pick(base));
    eq("…and they read the official attempt's values", pick(base), {
      attempts: 1,
      first_access: day(1),
      last_access: day(1, 10),
      status: "passed",
      progress_pct: 100,
      score: 85,
      completed_at: day(1, 10),
      practice_attempts: 0,
    });
  }

  console.log("\na running granted retake (ADR 0014 step 10; the roll-ups keep the standing result, ADR 0014:195)");
  {
    const t = tables([attempt("a1", 1, "passed"), attempt("r1", 10, null, { progress_pct: 30 })], { attempt_requests: [grant("g1", "r1")] });
    const out = await run(t).out;
    const c = courseOf(out);
    eq("status in_progress, the standing score, the retake's progress_pct", [c.status, c.score, c.official_score, c.progress_pct], ["in_progress", 85, 85, 30]);
    eq("official_retake in_progress; no previous official result while it runs", [c.official_retake, c.previous_official_score, c.previous_official_status], ["in_progress", null, null]);
    eq("completed_at is the standing official attempt's; overdue stays false although the due date passed", [c.completed_at, c.due_at, c.overdue], [day(1, 10), PAST_DUE, false]);
    eq("attempts counts the official attempt and the retake", c.attempts, 2);
    eq("the path object keeps the standing result: steps_completed 1, status completed", [out[0].learning_paths[0].steps_completed, out[0].learning_paths[0].status], [1, "completed"]);
    eq("summary.completed counts the course as not completed meanwhile", out[0].summary.completed, 0);
    // Without the grant link the in-progress row is not a retake: the feed would read "passed".
    const unlinked = courseOf(await run(tables([attempt("a1", 1, "passed"), attempt("r1", 10, null)])).out);
    eq("contrast: the same rows without the grant read passed / 100 (why the grant read is strict)", [unlinked.status, unlinked.progress_pct, unlinked.official_retake], ["passed", 100, "none"]);
  }

  console.log("\na completed granted retake replaces the result, whether higher or lower");
  {
    const t = tables([attempt("a1", 1, "passed"), attempt("r1", 10, "failed")], { attempt_requests: [grant("g1", "r1")] });
    const out = await run(t).out;
    const c = courseOf(out);
    eq("status failed, the retake's score, progress_pct 100", [c.status, c.score, c.progress_pct], ["failed", 60, 100]);
    eq("official_retake completed; previous_official_score / status are the replaced pass", [c.official_retake, c.previous_official_score, c.previous_official_status], ["completed", 85, "passed"]);
    eq("completed_at is the retake's (not the earliest completion)", c.completed_at, day(10, 10));
    eq("first_score keeps the baseline", c.first_score, 85);
    eq("on a pass-required module the path step reverts to not done", out[0].learning_paths[0].steps_completed, 0);
  }

  console.log("\nthe grant read is strict: a failed read throws GrantReadError (the route answers 503)");
  {
    let thrown: unknown = null;
    try {
      await run(tables([attempt("a1", 1, "passed")]), { fault: (q) => (q.table === "attempt_requests" ? BOOM : null) }).out;
    } catch (e) {
      thrown = e;
    }
    eq("buildProgress rejects with GrantReadError (code XX000)", [thrown instanceof GrantReadError, (thrown as GrantReadError | null)?.code], [true, "XX000"]);
    const { queries, out } = run(tables([attempt("a1", 1, "passed")]));
    await out;
    const g = queries.find((q) => q.table === "attempt_requests");
    eq("one bulk read: the org, approved, the batch's users, no course filter (courseIds null)", [
      g?.ops.some((o) => o.op === "eq" && o.args[0] === "organization_id" && o.args[1] === ORG),
      g?.ops.some((o) => o.op === "eq" && o.args[0] === "status" && o.args[1] === "approved"),
      JSON.stringify(g?.ops.find((o) => o.op === "in" && o.args[0] === "user_id")?.args[1]),
      g?.ops.some((o) => o.op === "in" && o.args[0] === "course_id"),
      queries.filter((q) => q.table === "attempt_requests").length,
    ], [true, true, JSON.stringify([USER]), false, 1]);
    // A database without attempt_requests (pre-0083) has no grants: not an error.
    const c = courseOf(await run(tables([attempt("a1", 1, "passed")]), { fault: (q) => (q.table === "attempt_requests" ? { code: "42P01", message: "relation does not exist" } : null) }).out);
    eq("a missing attempt_requests relation reads as no grants", [c.status, c.official_retake], ["passed", "none"]);
  }

  console.log("\nrevision_visits / last_revision_at (ADR 0014 step 7; never a silent 0)");
  {
    const visits = [
      { id: "rv1", organization_id: ORG, user_id: USER, course_id: COURSE, launched_at: day(12) },
      { id: "rv2", organization_id: ORG, user_id: USER, course_id: COURSE, launched_at: day(14) },
      { id: "rv3", organization_id: ORG, user_id: USER, course_id: "other-course", launched_at: day(15) },
    ];
    const { queries, out } = run(tables([attempt("a1", 1, "passed"), revisionRow], { revision_visits: visits }));
    const c = courseOf(await out);
    eq("the count and the latest visit, per course", [c.revision_visits, c.last_revision_at], [2, day(14)]);
    const v = queries.filter((q) => q.table === "revision_visits");
    eq("one visits read per batch, scoped to the org and the batch's users", [
      v.length,
      v[0]?.ops.some((o) => o.op === "eq" && o.args[0] === "organization_id" && o.args[1] === ORG),
      JSON.stringify(v[0]?.ops.find((o) => o.op === "in" && o.args[0] === "user_id")?.args[1]),
    ], [1, true, JSON.stringify([USER])]);
    const none = courseOf(await run(tables([attempt("a1", 1, "passed")])).out);
    eq("no visit → 0 and null", [none.revision_visits, none.last_revision_at], [0, null]);
    const failed = courseOf(await run(tables([attempt("a1", 1, "passed")], { revision_visits: visits }), { fault: (q) => (q.table === "revision_visits" ? BOOM : null) }).out);
    eq("a failed visits read (not schema-missing) → null and null", [failed.revision_visits, failed.last_revision_at], [null, null]);
    eq("…and the rest of the course object is unaffected", [failed.status, failed.score], ["passed", 85]);
    const missing = courseOf(await run(tables([attempt("a1", 1, "passed")]), { fault: (q) => (q.table === "revision_visits" ? MISSING_TABLE : null) }).out);
    eq("a database without revision_visits (before 0103) → 0 and null", [missing.revision_visits, missing.last_revision_at], [0, null]);
    // Every page full: the reader stops at its 100-page cap; a floor is not reported.
    const fullPage = Array.from({ length: 1000 }, (_, i) => ({ id: `rv-${i}`, organization_id: ORG, user_id: USER, course_id: COURSE, launched_at: day(12) }));
    const capped = run(tables([attempt("a1", 1, "passed")]), { pageOf: (q) => (q.table === "revision_visits" ? fullPage : null) });
    const cc = courseOf(await capped.out);
    eq("a read that reaches the page cap → null and null (a floor would be a guess)", [cc.revision_visits, cc.last_revision_at, capped.queries.filter((q) => q.table === "revision_visits").length], [null, null, 100]);
  }

  console.log("\nthe shape of every new field");
  {
    const c = courseOf(await run(tables([attempt("a1", 1, "passed")])).out);
    const keys = Object.keys(c);
    eq("the five new fields are present", ["revision_visits", "last_revision_at", "official_retake", "previous_official_score", "previous_official_status"].every((k) => keys.includes(k)), true);
    eq("…typed: number, null, none, null, null for a learner with no retake and no visit", [c.revision_visits, c.last_revision_at, c.official_retake, c.previous_official_score, c.previous_official_status], [0, null, "none", null, null]);
    eq("practice_attempts is kept", keys.includes("practice_attempts"), true);
  }

  /* ---------------- the routes: source checks ---------------- */

  const root = path.resolve(__dirname, "../..");
  const raw = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");
  const code = (rel: string) =>
    raw(rel)
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
      .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
  const FEED = code("lib/integrations/progress.ts");
  const SUMMARY = code("app/api/integrations/learner-summary/route.ts");
  const ROUTE = code("app/api/integrations/progress/route.ts");

  console.log("\nthe progress route: a GrantReadError answers 503, anything else 500 as before");
  {
    const catchAt = ROUTE.indexOf("} catch (e) {");
    const tail = ROUTE.slice(catchAt);
    eq("the catch tests instanceof GrantReadError first and answers 503 grants_unreadable",
      /^\} catch \(e\) \{\s*if \(e instanceof GrantReadError\) \{[\s\S]*?\{ error: "grants_unreadable" \}, \{ status: 503 \}/.test(tail), true);
    eq("…before the 500", tail.indexOf("status: 503") < tail.indexOf("status: 500"), true);
    eq("the feed reads the grants strictly, with no try (the must pattern)", /const grantsByUserCourse = await grantSnapshotForUsers\(svc, orgId, null, uids\);/.test(FEED) && !/fetchGrantRetakeIdsForUsers/.test(FEED), true);
  }

  console.log("\nlearner-summary: the feed's rules, its 503 (ADR 0014:187-188)");
  {
    eq("one strict grant read for the learner's courses, in a try: GrantReadError → 503 grants_unreadable",
      /try \{\s*grantsByCourse = await grantSnapshotForUsers\(svc, orgId, allCourseIds, \[uid\]\);\s*\} catch \(e\) \{\s*if \(!\(e instanceof GrantReadError\)\) throw e;[\s\S]*?\{ error: "grants_unreadable" \}, \{ status: 503 \}/.test(SUMMARY), true);
    eq("the fail-soft fetchGrantRetakeIds is gone", /fetchGrantRetakeIds\(/.test(SUMMARY), false);
    eq("the fold: a revision visit's row moves no last-active value, then is skipped after the row push",
      /const revision = isRevisionAttempt\(a\);\s*const t = a\.last_activity_at \?\? a\.completed_at \?\? a\.started_at;\s*if \(!revision && t &&/.test(SUMMARY) &&
        /is_revision: a\.is_revision \?\? null,\s*\}\);\s*if \(revision\) continue;\s*row\.attempts\+\+;/.test(SUMMARY), true);
    eq("the feed's fold: the row push carries the flag, then a revision visit's row is skipped",
      /is_revision: a\.is_revision \?\? null \}\);[\s\S]{0,400}?if \(isRevisionAttempt\(a\)\) continue;\s*row\.n\+\+;/.test(FEED), true);
    // The per-course expressions, character for character the feed's.
    const SHARED = [
      "const live = hasLiveGrantedRetake(st.list, sc.retakeIds);",
      "const history = officialHistory(st.list, grants?.rows ?? []);",
      "const retake = officialRetakeState(history);",
      "const visitsKnown = !visits.failed && !visits.capped;",
      "progress_pct: done && !live ? 100 : st.progress,",
      "completed_at: done ? sc.officialAttempt?.completed_at ?? null : null,",
      "revision_visits: visitsKnown ? visit?.count ?? 0 : null,",
      "last_revision_at: visitsKnown ? visit?.last ?? null : null,",
      "official_retake: retake.state,",
      'previous_official_score: retake.state === "completed" ? pct(retake.previous?.score ?? null) : null,',
      'previous_official_status: retake.state === "completed" ? retake.previous?.status ?? null : null,',
      "const status = courseStatus(sc, st.list);",
      "const done = sc.officialAttempt !== null;",
      "overdue: !!due && due < nowIso && !done,",
    ];
    eq("each per-course rule is written identically in the feed and in learner-summary", SHARED.map((s) => [FEED.includes(s), SUMMARY.includes(s)]), SHARED.map(() => [true, true]));
    eq("learner-summary gains a per-course completed_at, and its path objects still read officialDone",
      [/completed_at: done \? sc\.officialAttempt\?\.completed_at \?\? null : null,/.test(SUMMARY), /stepDone\.set\(cr\.id, officialDone\(sc, passRequired\.has\(cr\.id\)\)\);/.test(SUMMARY)], [true, true]);
    eq("one visits read for the learner", /fetchRevisionVisitStats\(svc, \{ orgId, userIds: \[uid\] \}\)/.test(SUMMARY), true);
  }

  console.log("\nthe tier guard: no launch_mode / is_preview under lib/integrations or the two CRM routes (alds-tier-read-sites (ii))");
  {
    const hit = (s: string) => /\b(is_preview|launch_mode)\b/.test(s);
    eq("none of the three files names them", [hit(FEED), hit(SUMMARY), hit(ROUTE)], [false, false, false]);
  }
}

main()
  .catch((e) => {
    fail++;
    console.log("  ✗ crm-progress-feed cases threw:", e);
  })
  .finally(() => {
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
  });
