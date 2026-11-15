/**
 * Unit tests for learnerCanAccessCourse's journey branch
 * (lib/auth/course-access.ts) as ADR 0024 phase 2 slice P2-6 builds it
 * (step 23, "Access to a started or credited journey day"; steps 22 and 93;
 * step 62's row for the access check; the owner's O5 answer of 2026-11-14).
 *
 * The branch grants a course through a journey enrolment of the learner that
 * is active or completed, on an active program, in three ways: (a) a credit
 * row of the enrolment holds the course, whatever the pinned version and the
 * ceiling (review); (b) for an active enrolment, the open day holds the course
 * in the pinned version (open); (c) the enrolment holds an open official
 * journey attempt of the course (resume), read once and only when (a) and (b)
 * did not grant. On a stub client:
 *
 *   (a) step 23's five cases: a started day removed by a publish, a started
 *       day whose course a publish swapped, a started day moved past the
 *       ceiling (behind a day inserted before it, and beyond the calendar),
 *       a completed enrolment's resume, and the swapped day's review; each
 *       with its counter-case (no open attempt, or the day's new course);
 *   (b) the started-day read: its filters (the learner, the course through
 *       its versions, the eligible enrolments, in progress, not a revision
 *       row, the journey context, one row, its own abort signal); made only
 *       when (a) and (b) did not grant; rows it must not count (a revision
 *       row, a completed row, a preview row, another enrolment's row);
 *   (c) the fallback without 0107 (a missing-column error naming
 *       context_kind: the same read once more without that filter, a state
 *       of the call only), and any other error, which grants nothing and is
 *       not retried;
 *   (d) O5 and the fail-closed reads: an inactive program's enrolment is not
 *       read at all (no credits, no started read), active or completed; a
 *       failed credit read grants nothing through the journey and makes no
 *       started read.
 *
 * The credit-day cases over the twin (a credited day above, at or below the
 * open day; by number without 0107; the caller's own read) are in
 * tests/unit/journey-state.test.ts (f). The launch's own decision for the
 * same five cases is in tests/unit/launch-context.test.ts (e).
 *
 * No database, no network.
 *
 * Run:  npx tsx tests/unit/course-access.test.ts   (or npm run test:unit)
 */
import { learnerCanAccessCourse } from "../../lib/auth/course-access";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

// Day ids (lower-case uuids).
const D = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const NEW = "00000000-0000-0000-0000-0000000000aa";

type PgErr = { code: string; message: string };
type Req = { table: string; select: string; ops: Array<[string, unknown[]]>; signal: AbortSignal | null };
type Enrolment = { id: string; status?: "active" | "completed"; programActive?: boolean; version?: string; start?: string };
type Version = { days: Array<[number, string | null]>; dayIds?: Record<string, string>; total?: number; mode?: "calendar" | "progress" };
/** [enrolment, day id, number when credited, the course on the row]. */
type Credit = [string, string, number, string | null];
type Open = { enr: string; course: string; kind?: string; status?: string; revision?: boolean };
type World = {
  enrolments?: Enrolment[];
  versions?: Record<string, Version>;
  credits?: Credit[];
  open?: Open[];
  /** A database without 0107: a credits select naming day_id and an attempts filter on context_kind answer 42703. */
  no0107?: boolean;
  progressError?: PgErr;
  attemptsError?: PgErr;
};

const START_LONG_AGO = "2026-01-01";

function stub(w: World) {
  const reqs: Req[] = [];
  const enrolments = w.enrolments ?? [{ id: "e1" }];
  const versionOf = (id: string): Version | undefined => (w.versions ?? {})[id];
  const answerOf = (r: Req, single: boolean): { data: unknown; error: PgErr | null } => {
    const opsOf = (op: string) => r.ops.filter(([o]) => o === op).map(([, a]) => a);
    const inOf = (col: string) => (opsOf("in").find((a) => a[0] === col)?.[1] ?? null) as string[] | null;
    const eqOf = new Map(opsOf("eq").map((a) => [String(a[0]), a[1]]));
    const rows = ((): unknown[] | PgErr => {
      switch (r.table) {
        case "journey_enrollments":
          return enrolments.map((e) => ({
            id: e.id,
            version_id: e.version ?? "v1",
            start_date: e.start ?? START_LONG_AGO,
            status: e.status ?? "active",
            journey_programs: { is_active: e.programActive !== false },
          }));
        case "journey_versions": {
          const ids = inOf("id") ?? [];
          return ids.flatMap((id) => {
            const v = versionOf(id);
            if (!v) return [];
            const days = v.days.map(([day, course_id]) => ({ day, course_id, mission_title: null }));
            return [{
              id, days, days_total: v.total ?? Math.max(...v.days.map(([d]) => d)), count_sundays: true,
              unlock_mode: v.mode ?? "calendar", day_ids: v.dayIds ?? {},
            }];
          });
        }
        case "journey_day_progress": {
          if (w.progressError) return w.progressError;
          const withDayId = r.select.includes("day_id");
          if (w.no0107 && withDayId) return { code: "42703", message: "column journey_day_progress.day_id does not exist" };
          const ids = inOf("enrollment_id") ?? [];
          return (w.credits ?? [])
            .filter(([enr]) => ids.includes(enr))
            .map(([enr, dayId, n, course]) => ({
              enrollment_id: enr, day_number: n, course_id: course, completed_at: "2026-01-02T10:00:00Z",
              ...(withDayId ? { day_id: dayId } : {}),
            }));
        }
        case "course_attempts": {
          if (w.attemptsError) return w.attemptsError;
          if (w.no0107 && eqOf.has("context_kind")) return { code: "42703", message: "column course_attempts.context_kind does not exist" };
          const enr = inOf("journey_enrollment_id") ?? [];
          const found = (w.open ?? []).filter((o) =>
            enr.includes(o.enr) &&
            eqOf.get("user_id") === "u1" &&
            eqOf.get("course_versions.course_id") === o.course &&
            (!eqOf.has("status") || eqOf.get("status") === (o.status ?? "in_progress")) &&
            (!eqOf.has("is_revision") || eqOf.get("is_revision") === (o.revision ?? false)) &&
            (!eqOf.has("context_kind") || eqOf.get("context_kind") === (o.kind ?? "journey"))
          );
          const limit = (opsOf("limit")[0]?.[0] as number | undefined) ?? found.length;
          return found.slice(0, limit).map((o, i) => ({ id: `a${i}`, course_versions: { course_id: o.course } }));
        }
        default:
          return [];
      }
    })();
    if (!Array.isArray(rows)) return { data: null, error: rows };
    return { data: single ? rows[0] ?? null : rows, error: null };
  };
  const from = (table: string) => {
    const r: Req = { table, select: "", ops: [], signal: null };
    reqs.push(r);
    let single = false;
    const b: Record<string, unknown> = {};
    for (const op of ["eq", "in", "neq", "is", "limit", "order", "range"]) b[op] = (...a: unknown[]) => (r.ops.push([op, a]), b);
    b.abortSignal = (s: AbortSignal) => ((r.signal = s), b);
    b.select = (s: string) => ((r.select = s), b);
    b.maybeSingle = () => ((single = true), b);
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(answerOf(r, single)).then(res, rej);
    return b;
  };
  return { client: { from }, reqs };
}

async function access(w: World, courseId: string) {
  const s = stub(w);
  const res = await learnerCanAccessCourse({
    supabase: s.client as never, orgId: "org-1", userId: "u1", courseId, preview: false, visibility: "private",
  });
  const attempts = s.reqs.filter((q) => q.table === "course_attempts");
  return {
    allowed: res.allowed,
    creditReads: s.reqs.filter((q) => q.table === "journey_day_progress").length,
    attemptReads: attempts.length,
    attempts,
  };
}

async function main() {
  const quiet = console.warn;
  console.warn = () => {};

  console.log("\n(a) step 23's five cases");
  {
    // 1. A started day removed by a publish. v1 had days 1 A, 2 B, 3 R, 4 C;
    //    the learner credited d1 and d2 and started d3 (course R). The
    //    publish removed d3: the pinned version now holds 1 A, 2 B, 3 C (d4),
    //    and R is on no day of it. The open day is 3 (C).
    const removed: Version = { days: [[1, "A"], [2, "B"], [3, "C"]], dayIds: { "1": D(1), "2": D(2), "3": D(4) } };
    const credits: Credit[] = [["e1", D(1), 1, "A"], ["e1", D(2), 2, "B"]];
    const w: World = { versions: { v1: removed }, credits, open: [{ enr: "e1", course: "R" }] };
    eq("removed: the started day's course R, on no day of the pinned version, resumes (its open official journey attempt)",
      (await access(w, "R")).allowed, true);
    eq("…without the open attempt R is closed", (await access({ ...w, open: [] }, "R")).allowed, false);
    eq("…the open day's course C opens as before, with no started-day read", [(await access(w, "C")).allowed, (await access(w, "C")).attemptReads], [true, 0]);

    // 2. A started day whose course a publish swapped: the learner credited
    //    d1, d2 and started d3 on course S; the publish swapped d3's course
    //    to T in place. d3 is still day 3, the open day, holding T.
    const swapped: Version = { days: [[1, "A"], [2, "B"], [3, "T"]], dayIds: { "1": D(1), "2": D(2), "3": D(3) } };
    const sw: World = { versions: { v1: swapped }, credits, open: [{ enr: "e1", course: "S" }] };
    eq("swapped: the course the learner started on the day, S, resumes though the day holds T now",
      (await access(sw, "S")).allowed, true);
    eq("…without the open attempt S is closed (it is no day's course and holds no credit)", (await access({ ...sw, open: [] }, "S")).allowed, false);
    eq("…T, the open day's course, is granted here; the launch's resolver decides between them (step 22)", (await access(sw, "T")).allowed, true);

    // 3. A started day moved past the ceiling: a publish inserted a day N at
    //    2 before the started d2 (course M), so d2 is day 3 now, above the
    //    open day 2.
    const moved: Version = { days: [[1, "A"], [2, "N"], [3, "M"], [4, "C"]], dayIds: { "1": D(1), "2": NEW, "3": D(2), "4": D(3) } };
    const mv: World = { versions: { v1: moved }, credits: [["e1", D(1), 1, "A"]], open: [{ enr: "e1", course: "M" }] };
    for (const mode of ["calendar", "progress"] as const) {
      const vm: World = { ...mv, versions: { v1: { ...moved, mode } } };
      eq(`moved past the ceiling (${mode}): the started day 3's course M resumes above the open day 2`, (await access(vm, "M")).allowed, true);
      eq(`…(${mode}) without the open attempt M is closed: day 3 is past the open day and holds no credit`, (await access({ ...vm, open: [] }, "M")).allowed, false);
      eq(`…(${mode}) the open day's course N opens`, (await access(vm, "N")).allowed, true);
    }
    // …and beyond the calendar: the enrolment started today, so the calendar
    // allows day 1 only; a publish moved the started d1 to day 3.
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
    const beyond: World = {
      enrolments: [{ id: "e1", start: today }],
      versions: { v1: { days: [[1, "N"], [2, "O"], [3, "M"]], dayIds: { "1": NEW, "2": D(9), "3": D(1) } } },
      credits: [],
      open: [{ enr: "e1", course: "M" }],
    };
    eq("moved beyond the calendar: the started day, now day 3 while the calendar allows day 1, resumes", (await access(beyond, "M")).allowed, true);
    eq("…without the open attempt it is closed", (await access({ ...beyond, open: [] }, "M")).allowed, false);

    // 4. A completed enrolment's resume: a publish removed the started day
    //    and so completed the enrolment (every remaining required day
    //    credited); the attempt that was open stays resumable (step 95's row
    //    "A day removed", step 22's row for a completed E).
    const finished: Version = { days: [[1, "A"], [2, "B"]], dayIds: { "1": D(1), "2": D(2) } };
    const cw: World = { enrolments: [{ id: "e1", status: "completed" }], versions: { v1: finished }, credits, open: [{ enr: "e1", course: "R" }] };
    eq("a completed enrolment's resume: the attempt open when a publish completed it resumes", (await access(cw, "R")).allowed, true);
    eq("…without it, nothing new opens in a completed enrolment", (await access({ ...cw, open: [] }, "R")).allowed, false);
    eq("…a completed enrolment reviews the courses on its credit rows", (await access(cw, "B")).allowed, true);
    {
      // A completed enrolment's version holding a course on a day without a
      // credit (a day the version did not require when it completed): no
      // open day in a completed enrolment.
      const extra: World = { enrolments: [{ id: "e1", status: "completed" }], versions: { v1: { days: [[1, "A"], [2, "B"], [3, "Z"]], dayIds: { "1": D(1), "2": D(2), "3": D(3) } } }, credits };
      eq("…and opens no day of its pinned version that holds no credit (no new official attempt)", (await access(extra, "Z")).allowed, false);
    }

    // 5. The swapped day's review: the learner credited d2 on course P; a
    //    publish swapped d2's course to Q in place. The open day is 3 (C).
    const review: Version = { days: [[1, "A"], [2, "Q"], [3, "C"]], dayIds: { "1": D(1), "2": D(2), "3": D(3) } };
    const rw: World = { versions: { v1: review }, credits: [["e1", D(1), 1, "A"], ["e1", D(2), 2, "P"]] };
    const p = await access(rw, "P");
    eq("the swapped day's review: P, the course on the credit row, is open, with no started-day read", [p.allowed, p.attemptReads], [true, 0]);
    const q = await access(rw, "Q");
    eq("…Q, the day's new course, is not offered to the learner who completed the day (one started-day read, none found)", [q.allowed, q.attemptReads], [false, 1]);
  }

  console.log("\n(b) the started-day read");
  {
    const v: Version = { days: [[1, "A"], [2, "B"]], dayIds: { "1": D(1), "2": D(2) } };
    const w: World = {
      enrolments: [{ id: "e1" }, { id: "e2", status: "completed" }, { id: "e3", programActive: false }],
      versions: { v1: v },
      credits: [],
      open: [{ enr: "e2", course: "R" }],
    };
    const r = await access(w, "R");
    eq("one read, and it grants", [r.allowed, r.attemptReads], [true, 1]);
    const a = r.attempts[0];
    eq("…its select names the course through its versions", a?.select, "id, course_versions!inner(course_id)");
    eq("…its filters: the learner, the course, the enrolments of active programs (active and completed), in progress, not a revision row, the journey context",
      a?.ops.filter(([op]) => op === "eq" || op === "in").map(([op, args]) => [op, ...args]),
      [
        ["eq", "user_id", "u1"],
        ["eq", "course_versions.course_id", "R"],
        ["in", "journey_enrollment_id", ["e1", "e2"]],
        ["eq", "status", "in_progress"],
        ["eq", "is_revision", false],
        ["eq", "context_kind", "journey"],
      ]);
    eq("…one row, with its own abort signal", [a?.ops.find(([op]) => op === "limit")?.[1], a?.signal instanceof AbortSignal], [[1], true]);

    const none = async (o: Open) => (await access({ ...w, open: [o] }, "R")).allowed;
    eq("a revision row is no open official attempt", await none({ enr: "e1", course: "R", revision: true }), false);
    eq("…nor a completed row", await none({ enr: "e1", course: "R", status: "completed" }), false);
    eq("…nor a preview row", await none({ enr: "e1", course: "R", kind: "preview" }), false);
    eq("…nor another enrolment's row (here e3's, whose program is inactive)", await none({ enr: "e3", course: "R" }), false);
    eq("…nor a row of another course", await none({ enr: "e1", course: "Z" }), false);
    const granted = await access({ ...w, credits: [["e1", D(1), 1, "R"]] }, "R");
    eq("not made when a credit row already grants", [granted.allowed, granted.attemptReads], [true, 0]);
  }

  console.log("\n(c) without 0107, and on any other error");
  {
    const v: Version = { days: [[1, "A"], [2, "B"]], dayIds: { "1": D(1), "2": D(2) } };
    const w: World = { no0107: true, versions: { v1: v }, credits: [["e1", D(1), 1, "A"]], open: [{ enr: "e1", course: "R" }] };
    const r = await access(w, "R");
    eq("no 0107: a 42703 naming context_kind, then the same read once without that filter, which grants", [r.allowed, r.attemptReads], [true, 2]);
    eq("…the first read filters the journey context, the second does not",
      r.attempts.map((q) => q.ops.some(([op, args]) => op === "eq" && args[0] === "context_kind")), [true, false]);
    eq("…the second keeps every other filter", r.attempts[1]?.ops.filter(([op]) => op === "eq" || op === "in").map(([, args]) => args[0]),
      ["user_id", "course_versions.course_id", "journey_enrollment_id", "status", "is_revision"]);
    eq("…without an open row nothing is granted", (await access({ ...w, open: [] }, "R")).allowed, false);
    const other = await access({ versions: { v1: v }, credits: [], open: [{ enr: "e1", course: "R" }], attemptsError: { code: "XX000", message: "boom" } }, "R");
    eq("any other error grants nothing and is not retried", [other.allowed, other.attemptReads], [false, 1]);
    const otherColumn = await access({ versions: { v1: v }, credits: [], open: [{ enr: "e1", course: "R" }], attemptsError: { code: "42703", message: "column course_attempts.is_revision does not exist" } }, "R");
    eq("…a missing column that is not context_kind is such an error", [otherColumn.allowed, otherColumn.attemptReads], [false, 1]);
  }

  console.log("\n(d) O5 and the fail-closed reads");
  {
    const v: Version = { days: [[1, "A"], [2, "B"]], dayIds: { "1": D(1), "2": D(2) } };
    for (const status of ["active", "completed"] as const) {
      const r = await access({ enrolments: [{ id: "e1", status, programActive: false }], versions: { v1: v }, credits: [["e1", D(1), 1, "A"]], open: [{ enr: "e1", course: "R" }] }, "R");
      eq(`an inactive program (${status} enrolment): its open attempt grants nothing, and neither the credits nor the attempts are read`,
        [r.allowed, r.creditReads, r.attemptReads], [false, 0, 0]);
      const a = await access({ enrolments: [{ id: "e1", status, programActive: false }], versions: { v1: v }, credits: [["e1", D(1), 1, "A"]] }, "A");
      eq(`…(${status}) nor its credit row`, a.allowed, false);
    }
    const failed = await access({ versions: { v1: v }, progressError: { code: "XX000", message: "boom" }, open: [{ enr: "e1", course: "R" }] }, "R");
    eq("a failed credit read grants nothing through the journey and makes no started-day read", [failed.allowed, failed.attemptReads], [false, 0]);
  }

  console.warn = quiet;
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
