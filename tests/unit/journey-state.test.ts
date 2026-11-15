/**
 * Unit tests for the journey twin by day identity (ADR 0024 phase 2, P2-4;
 * step 45, step 62's row "journey-state.test.ts", decision A27, section U,
 * build notes N14 and N18) and its reader:
 *
 *   (a) no re-pin: for credits that run unbroken from the first course day,
 *       every output of computeJourneyState on creditedDays equals the old
 *       count-based twin's (copied below as it stood before P2-4), over both
 *       unlock modes, rest days, the calendar before, on and after the start,
 *       and every count from none to all;
 *   (b) the day-identity rule on step 95's edges, one fixture per edge
 *       (a day removed, a course swapped, a day inserted before the current
 *       day, days reordered, a rest day gaining a module, a shorter version
 *       whose required days are all credited). In each: no credited day is
 *       the open day, a started day is in resumableDayIds, and a credit on a
 *       day outside the pinned version counts towards nothing;
 *   (c) blocked_failed from its two inputs (an output only: it never changes
 *       todayUnlocked or openableDay), Behind equal to the rule (released
 *       course days not credited, minus today's; a case where it differs
 *       from "released minus credited"), zero missions never finished nor
 *       open, nextDay;
 *   (d) creditedDaysFor: by id, by number only when the reader fell back
 *       (day_ids null), `{}` credits nothing; creditCoursesFor (the course
 *       on each credited day's row, on the same days); reminderCreditedDays's
 *       fallback to the first `done` course days; reminderCountsFrom (a
 *       failed call reminds nobody, a missing row is no reminder);
 *       resumableDayIdsFor; parseVersionDays' dayId, a day listed twice and
 *       0107's reading of a day number;
 *   (e) readJourneyCredits (lib/journey/credits-read.ts) on a stub client: the
 *       two reads with day_id and day_ids, each request with its own abort
 *       signal; each row's course_id (in the base select: on every
 *       database); the versions read only for enrolments that hold a credit; on
 *       a missing-column error naming day_id or day_ids, today's reading by
 *       number; any other error, and a pinned version the read did not
 *       answer, {ok: false}; chunks and pages decided once, a shared state
 *       deciding once for several calls;
 *   (f) learnerCanAccessCourse's journey branch (lib/auth/course-access.ts)
 *       on a stub client. Above the open day (past the ceiling) a credited
 *       day is granted only for the course on its credit row: it stays open
 *       for review when it keeps that course, a day there that holds no
 *       credit does not open, a credited day whose course a publish swapped
 *       (by id, and by number without 0107) grants neither the new course
 *       nor the old one, and a credit row whose course is null grants
 *       nothing (step 22's row for `?journey=E&day=`, section 95's row "A
 *       day's course swapped"). At or below the ceiling the day's current
 *       course is granted as before, a credited day whose course a publish
 *       swapped included, and a completed enrolment grants every course of
 *       its pinned version: the P2-6 gap (step 22's rows for
 *       `?journey=E&day=` and for a completed E; step 23), pinned as today's
 *       behaviour by the cases labelled "P2-6 gap (step 22)", which P2-6 is
 *       expected to flip. A failed credit read grants nothing, and the
 *       caller's own read is used only when it is ok and covers every
 *       enrolment that holds the course (two enrolments, the read covering
 *       one). P2-6 creates tests/unit/course-access.test.ts with step 23's
 *       cases; these stay here with the twin they test.
 *
 * Not here, because the twin does not answer them (step 62's row names them
 * for the journey surfaces of later phases): `late` (a credit's column, written
 * by journey_record_completion), the live deadline (dateOfDay over the
 * program's deadline_days, which each reader applies) and reset enrolments
 * (excluded by each reader's status filter).
 *
 * No database, no network.
 *
 * Run:  npx tsx tests/unit/journey-state.test.ts   (or npm run test:unit)
 */
import {
  computeJourneyState,
  countedDaysElapsed,
  courseDaysOf,
  creditCoursesFor,
  creditedDaysFor,
  parseVersionDays,
  reminderCountsFrom,
  reminderCreditedDays,
  resumableDayIdsFor,
  type JourneyCreditRow,
  type JourneyUnlockMode,
} from "../../lib/journey/journey";
import { readJourneyCredits, type JourneyCredits } from "../../lib/journey/credits-read";
import { learnerCanAccessCourse } from "../../lib/auth/course-access";
import type { OptionalColumnState } from "../../lib/scoring/attempt-kind";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

// ---------------------------------------------------------------------------
// The twin before P2-4, by row count (lib/journey/journey.ts at 63dbcc3).
// ---------------------------------------------------------------------------
function oldState(opts: {
  startDate: string; today: string; completedCount: number; daysTotal: number;
  countSundays: boolean; unlockMode?: JourneyUnlockMode; courseDays?: number[];
}) {
  const { startDate, today, completedCount, daysTotal, countSundays } = opts;
  const progress = opts.unlockMode === "progress";
  const courseDays = opts.courseDays && opts.courseDays.length > 0
    ? [...opts.courseDays].filter((d) => d >= 1 && d <= daysTotal).sort((a, b) => a - b)
    : Array.from({ length: daysTotal }, (_, i) => i + 1);
  const missionsTotal = courseDays.length;
  const allowedDay = Math.min(daysTotal, countedDaysElapsed(startDate, today, countSundays));
  const started = allowedDay >= 1;
  const finished = missionsTotal > 0 && completedCount >= missionsTotal;
  const currentDay = finished ? daysTotal : (courseDays[completedCount] ?? daysTotal);
  const todayUnlocked = !finished && (progress ? started : currentDay <= allowedDay);
  const openableDay = todayUnlocked ? currentDay : 0;
  const releasedMissions = progress
    ? finished ? missionsTotal : started ? courseDays.filter((d) => d <= currentDay).length : 0
    : courseDays.filter((d) => d <= allowedDay).length;
  const pendingDays = progress ? 0 : Math.max(0, releasedMissions - completedCount);
  return {
    daysTotal, completedCount, allowedDay, currentDay, todayUnlocked, openableDay, pendingDays,
    behindDays: progress ? 0 : Math.max(0, pendingDays - 1),
    daysRemaining: Math.max(0, missionsTotal - completedCount),
    pct: missionsTotal > 0 ? Math.round((completedCount / missionsTotal) * 100) : 0,
    finished,
  };
}
const OLD_KEYS = ["daysTotal", "completedCount", "allowedDay", "currentDay", "todayUnlocked", "openableDay", "pendingDays", "behindDays", "daysRemaining", "pct", "finished"] as const;
const pick = (s: Record<string, unknown>) => Object.fromEntries(OLD_KEYS.map((k) => [k, s[k]]));

// A version from a list of [number, id, course] entries (course null = rest day).
type Entry = [number, string, string | null];
const version = (entries: Entry[], daysTotal: number) => ({
  days: entries.map(([day, , course]) => ({ day, course_id: course, mission_title: null })),
  days_total: daysTotal,
  day_ids: Object.fromEntries(entries.map(([day, id]) => [String(day), id])) as Record<string, unknown> | null,
});
const raw = (dayId: string | null, dayNumber: number): JourneyCreditRow => ({ day_id: dayId, day_number: dayNumber, course_id: null, completed_at: null });
const credit = (dayId: string, dayNumber: number): JourneyCreditRow => ({ day_id: dayId, day_number: dayNumber, course_id: null, completed_at: "2026-02-01T10:00:00Z" });
const stateOf = (v: ReturnType<typeof version>, rows: JourneyCreditRow[], extra: Partial<Parameters<typeof computeJourneyState>[0]> = {}) =>
  computeJourneyState({
    startDate: "2026-01-05",
    today: "2026-01-20",
    creditedDays: creditedDaysFor(v, rows),
    daysTotal: v.days_total,
    countSundays: true,
    courseDays: courseDaysOf(v.days, v.days_total),
    ...extra,
  });

// Day ids (lower-case uuids, ascending in the order written).
const D = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const NEW = "00000000-0000-0000-0000-0000000000aa";

async function main() {
  console.log("\n(a) no re-pin: the credits by day id give exactly the old count's answers");
  {
    let cases = 0;
    const bad: string[] = [];
    const layouts: Array<{ name: string; entries: Entry[]; total: number }> = [
      { name: "every day a mission", entries: [1, 2, 3, 4, 5, 6].map((n) => [n, D(n), `c${n}`] as Entry), total: 6 },
      { name: "rest days 2 and 5", entries: [1, 2, 3, 4, 5, 6].map((n) => [n, D(n), n === 2 || n === 5 ? null : `c${n}`] as Entry), total: 6 },
      { name: "a mission beyond days_total", entries: [1, 2, 3, 4, 5].map((n) => [n, D(n), `c${n}`] as Entry), total: 4 },
    ];
    for (const l of layouts) {
      const v = version(l.entries, l.total);
      const courseDays = courseDaysOf(v.days, v.days_total);
      for (const mode of ["calendar", "progress"] as const) {
        for (const today of ["2026-01-01", "2026-01-05", "2026-01-07", "2026-01-30"]) {
          for (let n = 0; n <= courseDays.length; n++) {
            const rows = courseDays.slice(0, n).map((d) => credit(D(d), d));
            const opts = { startDate: "2026-01-05", today, daysTotal: v.days_total, countSundays: false, unlockMode: mode };
            const got = computeJourneyState({ ...opts, creditedDays: creditedDaysFor(v, rows), courseDays });
            const want = oldState({ ...opts, completedCount: n, courseDays });
            cases++;
            if (JSON.stringify(pick(got)) !== JSON.stringify(want)) bad.push(`${l.name}, ${mode}, ${today}, ${n} credited: ${JSON.stringify(pick(got))} ≠ ${JSON.stringify(want)}`);
            if (got.finished ? got.nextDay !== null : got.nextDay !== got.currentDay) bad.push(`${l.name}, ${mode}, ${today}, ${n}: nextDay ${got.nextDay} beside currentDay ${got.currentDay}`);
          }
        }
      }
    }
    eq(`every output equals the old count's, ${cases} states (3 layouts × 2 modes × 4 dates × each count)`, bad, []);
    const v = version([1, 2, 3].map((n) => [n, D(n), `c${n}`] as Entry), 3);
    eq("…and by number (a database without 0107) the same numbers as by id",
      creditedDaysFor({ ...v, day_ids: null }, [credit(D(1), 1), credit(D(2), 2)]), creditedDaysFor(v, [credit(D(1), 1), credit(D(2), 2)]));
  }

  console.log("\n(b) step 95's edges, the learner having credited days 1 and 2 of v1 (d1, d2) and started day 3 (d3)");
  {
    const v1: Entry[] = [[1, D(1), "A"], [2, D(2), "B"], [3, D(3), "C"], [4, D(4), "D"], [5, D(5), "E"]];
    const credits = [credit(D(1), 1), credit(D(2), 2)];
    const started = [D(3)];
    const edge = (name: string, entries: Entry[], total: number, rows: JourneyCreditRow[], want: { credited: number[]; next: number | null; finished?: boolean }, outside: string[] = []) => {
      const v = version(entries, total);
      const st = stateOf(v, rows, { resumableDayIds: started });
      const credited = creditedDaysFor(v, rows);
      eq(`${name}: credited days ${JSON.stringify(want.credited)}, open day ${want.next}`, [credited, st.nextDay, st.finished], [want.credited, want.next, want.finished ?? false]);
      eq(`${name}: no credited day is the open day`, st.nextDay !== null && credited.includes(st.nextDay), false);
      eq(`${name}: the started day is resumable`, st.resumableDayIds.includes(D(3)), true);
      for (const id of outside) {
        const n = rows.find((r) => r.day_id === id)?.day_number;
        eq(`${name}: the credit on ${id === NEW ? "the new day" : `d${Number(id.slice(-12))}`} (number ${n} when credited) counts towards nothing`,
          creditedDaysFor(v, rows.filter((r) => r.day_id !== id)), credited);
      }
    };
    edge("no re-pin", v1, 5, credits, { credited: [1, 2], next: 3 });
    // A day removed: d2 leaves the version; later days move up one number.
    edge("a day removed", [[1, D(1), "A"], [2, D(3), "C"], [3, D(4), "D"], [4, D(5), "E"]], 4, credits, { credited: [1], next: 2 }, [D(2)]);
    // A course swapped on a credited day: the credit stands on its day.
    edge("a course swapped", [[1, D(1), "A"], [2, D(2), "X"], [3, D(3), "C"], [4, D(4), "D"], [5, D(5), "E"]], 5, credits, { credited: [1, 2], next: 3 });
    // A day inserted at 2: the credited d2 moves to 3; the new day is the open day.
    edge("a day inserted before the current day", [[1, D(1), "A"], [2, NEW, "N"], [3, D(2), "B"], [4, D(3), "C"], [5, D(4), "D"], [6, D(5), "E"]], 6, credits, { credited: [1, 3], next: 2 });
    // Days 2 and 4 swapped: d2 (credited) is now number 4, d4 now number 2.
    edge("days reordered", [[1, D(1), "A"], [2, D(4), "D"], [3, D(3), "C"], [4, D(2), "B"], [5, D(5), "E"]], 5, credits, { credited: [1, 4], next: 2 });
    // v1 with day 3 a rest day, credits on 1, 2 and 4; v2 gives day 3 a module.
    {
      const rest: Entry[] = [[1, D(1), "A"], [2, D(2), "B"], [3, D(3), null], [4, D(4), "D"], [5, D(5), "E"]];
      const rows = [credit(D(1), 1), credit(D(2), 2), credit(D(4), 4)];
      const before = stateOf(version(rest, 5), rows);
      eq("a rest day gaining a module: before, the open day is 5 (3 is a rest day)", before.nextDay, 5);
      edge("a rest day gaining a module", [[1, D(1), "A"], [2, D(2), "B"], [3, D(3), "C"], [4, D(4), "D"], [5, D(5), "E"]], 5, rows, { credited: [1, 2, 4], next: 3 });
    }
    // A shorter version: days_total 3, every remaining day credited; the credit on day 4 is history.
    {
      const rows = [credit(D(1), 1), credit(D(2), 2), credit(D(3), 3), credit(D(4), 4)];
      edge("a shorter version, every required day credited", v1, 3, rows, { credited: [1, 2, 3], next: null, finished: true }, [D(4)]);
    }
  }

  console.log("\n(c) blocked_failed, Behind, zero missions");
  {
    const v = version([1, 2, 3, 4, 5].map((n) => [n, D(n), `c${n}`] as Entry), 5);
    const rows = [credit(D(1), 1)];
    const plain = stateOf(v, rows);
    const failed = stateOf(v, rows, { currentDayFailed: true });
    eq("the open day failed and no unused grant: blockedFailed", failed.blockedFailed, true);
    eq("…with an unused journey grant: not blocked", stateOf(v, rows, { currentDayFailed: true, unusedJourneyGrant: true }).blockedFailed, false);
    eq("…not failed: not blocked (both inputs default to false)", plain.blockedFailed, false);
    eq("…an output only: todayUnlocked and openableDay are as without it", [failed.todayUnlocked, failed.openableDay], [plain.todayUnlocked, plain.openableDay]);
    const all = [1, 2, 3, 4, 5].map((n) => credit(D(n), n));
    eq("…a finished journey is never blocked", stateOf(v, all, { currentDayFailed: true }).blockedFailed, false);

    // Calendar: start 2026-01-05, Sundays counted, today 2026-01-08 → allowedDay 4.
    const gap = stateOf(v, [credit(D(1), 1), credit(D(3), 3)], { today: "2026-01-08" });
    eq("Behind: released course days 1 to 4, credited 1 and 3 → pending 2, behind 1, open day 2",
      [gap.allowedDay, gap.pendingDays, gap.behindDays, gap.nextDay, gap.completedCount], [4, 2, 1, 2, 2]);
    const prog = stateOf(v, [credit(D(1), 1), credit(D(3), 3)], { today: "2026-01-08", unlockMode: "progress" });
    eq("…progress mode is never behind", [prog.pendingDays, prog.behindDays, prog.todayUnlocked, prog.openableDay], [0, 0, true, 2]);
    // A day inserted at 2 before a credited day (d2 moves to 3), calendar day
    // 2: released course days 1 and 2, credited 1 (and 3, not yet released).
    // "Released minus credited" would read 2 - 2 = 0; the rule reads 1.
    const inserted = version([[1, D(1), "A"], [2, NEW, "N"], [3, D(2), "B"], [4, D(3), "C"], [5, D(4), "D"], [6, D(5), "E"]], 6);
    const ins = stateOf(inserted, [credit(D(1), 1), credit(D(2), 2)], { today: "2026-01-06" });
    eq("…a credited day beyond the calendar does not cancel a released one: allowed 2, pending 1, behind 0, open day 2",
      [ins.allowedDay, ins.pendingDays, ins.behindDays, ins.nextDay], [2, 1, 0, 2]);

    const none = computeJourneyState({ startDate: "2026-01-05", today: "2026-01-20", creditedDays: [], daysTotal: 5, countSundays: true, courseDays: [] });
    eq("zero missions (courseDays []): never finished, nothing open, no next day, 0%",
      [none.finished, none.todayUnlocked, none.openableDay, none.nextDay, none.pct, none.pendingDays, none.daysRemaining], [false, false, 0, null, 0, 0, 0]);
    eq("resumableDayIds: distinct, ascending, passed through", stateOf(v, [], { resumableDayIds: [D(4), D(2), D(4)] }).resumableDayIds, [D(2), D(4)]);
  }

  console.log("\n(d) the helpers");
  {
    const v = version([[1, D(1), "A"], [2, D(2), null], [3, D(3), "C"]], 3);
    eq("creditedDaysFor by id: a credit on a rest day counts towards nothing", creditedDaysFor(v, [credit(D(2), 2), credit(D(3), 3)]), [3]);
    eq("…a day_id in another case matches (ids compare in lower case)", creditedDaysFor(v, [raw(D(3).toUpperCase(), 9)]), [3]);
    eq("…a row without a day id counts towards nothing by id", creditedDaysFor(v, [raw(null, 1)]), []);
    eq("…a version whose map is {} (0107, no day_ids) credits nothing", creditedDaysFor({ ...v, day_ids: {} }, [credit(D(1), 1)]), []);
    eq("…by number (day_ids null, the reader's fallback): the credit's number on a course day", creditedDaysFor({ ...v, day_ids: null }, [raw(null, 1), raw(null, 2)]), [1]);

    eq("reminderCreditedDays: 0107's credited", reminderCreditedDays({ done: 2, credited: [1, 4] }, [1, 2, 3, 4]), [1, 4]);
    eq("…without the column: the first `done` course days (today's reading)", reminderCreditedDays({ done: 2 }, [4, 1, 2]), [1, 2]);
    eq("…without the column, done 0", reminderCreditedDays({ done: 0 }, [1, 2]), []);
    eq("…without the column, done above the course days", reminderCreditedDays({ done: 9 }, [1, 2]), [1, 2]);

    const failedCounts = reminderCountsFrom(null, { code: "57014", message: "statement timeout" });
    eq("reminderCountsFrom: a failed call is {ok: false} (reminds nobody, never \"nothing done\")", failedCounts.ok, false);
    eq("…a failed call with rows beside the error is still {ok: false}",
      reminderCountsFrom([{ enrollment_id: "e1", done: 0, done_today: false }], { code: "XX000" }).ok, false);
    const counts = reminderCountsFrom([
      { enrollment_id: "e1", done: 2, done_today: true, credited: [1, 3] },
      { enrollment_id: "e2", done: 1, done_today: false },
    ], null);
    const c1 = counts.ok ? counts.countOf("e1") : null;
    const c2 = counts.ok ? counts.countOf("e2") : null;
    eq("…0107's row keeps `credited`, which reminderCreditedDays takes", [c1?.done_today, c1 ? reminderCreditedDays(c1, [1, 2, 3, 4]) : null], [true, [1, 3]]);
    eq("…a row without `credited` (no 0107): the first `done` course days", c2 ? reminderCreditedDays(c2, [2, 4, 6]) : null, [2]);
    eq("…an enrolment the answer has no row for: null (no reminder)", counts.ok ? counts.countOf("e9") : "failed", null);
    const empty = reminderCountsFrom(null, null);
    eq("…no rows and no error: ok, every enrolment null", [empty.ok, empty.ok ? empty.countOf("e1") : "failed"], [true, null]);

    const E = "e1";
    const row = (o: Record<string, unknown>) => ({ journey_enrollment_id: E, context_kind: "journey", status: "in_progress", is_revision: false, ...o });
    eq("resumableDayIdsFor: open official journey rows of the enrolment, distinct, ascending", resumableDayIdsFor(E, [
      row({ journey_day_id: D(5) }),
      row({ journey_day_id: D(2) }),
      row({ journey_day_id: D(5) }),
      row({ journey_day_id: D(6), is_revision: true }),
      row({ journey_day_id: D(7), status: "completed" }),
      row({ journey_day_id: D(8), context_kind: "preview" }),
      row({ journey_day_id: D(9), journey_enrollment_id: "e2" }),
      row({ journey_day_id: null }),
    ]), [D(2), D(5)]);

    const days = parseVersionDays([{ day: 1, course_id: null, mission_title: "first" }, { day: 1, course_id: "C1" }, { day: 2, course_id: "C2" }], { "1": D(1).toUpperCase() });
    eq("parseVersionDays: a day listed twice takes the first entry's course that has one", days.get(1)?.course_id, "C1");
    eq("…the dayId from the map, in lower case; none for a number the map lacks", [days.get(1)?.dayId, days.get(2)?.dayId], [D(1), null]);
    eq("…no map: every dayId null", parseVersionDays([{ day: 1, course_id: "C" }]).get(1)?.dayId, null);
    // 0107 reads a day as `->> 'day' ~ '^[0-9]{1,6}$'`: a whole JSON number or a string of digits.
    const odd = parseVersionDays([
      { day: 2.5, course_id: "X" }, { day: "1e1", course_id: "X" }, { day: " 4", course_id: "X" }, { day: true, course_id: "X" },
      { day: "3", course_id: "C3" }, { day: 7, course_id: "C7" }, { day: 1234567, course_id: "X" }, null,
    ]);
    eq("…a day number as 0107 reads it: 2.5, \"1e1\", \" 4\", true and seven digits are no day; \"3\" and 7 are", [...odd.keys()].sort((a, b) => a - b), [3, 7]);
    eq("…so a fractional day is no required day of creditedDaysFor either",
      creditedDaysFor({ days: [{ day: 1, course_id: "A" }, { day: 2.5, course_id: "B" }], days_total: 3, day_ids: { "1": D(1), "3": D(3) } }, [credit(D(1), 1), credit(D(3), 3)]), [1]);
  }
  {
    // A day inserted at 2 and d2's course swapped from A to B: d2 is day 3.
    const v = version([[1, D(1), "X"], [2, NEW, "N"], [3, D(2), "B"], [4, D(3), "C"]], 4);
    const rows: JourneyCreditRow[] = [
      { ...credit(D(1), 1), course_id: "X" },
      { ...credit(D(2).toUpperCase(), 2), course_id: "A" },
      { ...credit(D(9), 9), course_id: "Z" },
    ];
    eq("creditCoursesFor: the course on each credited day's credit row, by id (day 3 answers its row's A, not the day's B)",
      [...creditCoursesFor(v, rows)], [[1, "X"], [3, "A"]]);
    eq("…its days are exactly creditedDaysFor's", [...creditCoursesFor(v, rows).keys()].sort((a, b) => a - b), creditedDaysFor(v, rows));
    eq("…by number only when the reader fell back (day_ids null)", [...creditCoursesFor({ ...v, day_ids: null }, rows)], [[1, "X"], [2, "A"]]);
    eq("…a row without a course answers null", [...creditCoursesFor(v, [{ ...credit(D(1), 1), course_id: null }])], [[1, null]]);
  }

  console.log("\n(e) readJourneyCredits on a stub client");
  {
    type Req = { table: string; select: string; ops: Array<[string, unknown[]]>; signal: AbortSignal | null };
    type World = {
      no0107?: boolean;
      progress?: Array<Record<string, unknown>>;
      versions?: Array<Record<string, unknown>>;
      progressError?: { code: string; message: string } | null;
      versionsError?: { code: string; message: string } | null;
    };
    const stub = (w: World) => {
      const reqs: Req[] = [];
      const from = (table: string) => {
        const r: Req = { table, select: "", ops: [], signal: null };
        reqs.push(r);
        const answer = () => {
          if (table === "journey_day_progress") {
            if (w.progressError) return { data: null, error: w.progressError };
            if (w.no0107 && r.select.includes("day_id")) return { data: null, error: { code: "42703", message: "column journey_day_progress.day_id does not exist" } };
            const ids = (r.ops.find(([op]) => op === "in")?.[1][1] ?? []) as string[];
            const [lo, hi] = (r.ops.find(([op]) => op === "range")?.[1] ?? [0, 999]) as number[];
            const rows = (w.progress ?? []).filter((p) => ids.includes(String(p.enrollment_id)))
              .map((p) => (r.select.includes("day_id") ? p : Object.fromEntries(Object.entries(p).filter(([k]) => k !== "day_id"))));
            return { data: rows.slice(lo, hi + 1), error: null };
          }
          if (table === "journey_versions") {
            if (w.versionsError) return { data: null, error: w.versionsError };
            const ids = (r.ops.find(([op]) => op === "in")?.[1][1] ?? []) as string[];
            return { data: (w.versions ?? []).filter((v) => ids.includes(String(v.id))), error: null };
          }
          return { data: [], error: null };
        };
        const b: Record<string, unknown> = {
          select: (s: string) => ((r.select = s), b),
          in: (...a: unknown[]) => (r.ops.push(["in", a]), b),
          order: (...a: unknown[]) => (r.ops.push(["order", a]), b),
          range: (...a: unknown[]) => (r.ops.push(["range", a]), b),
          abortSignal: (s: AbortSignal) => ((r.signal = s), b),
          then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(answer()).then(res, rej),
        };
        return b;
      };
      return { client: { from }, reqs };
    };
    const ENR = [{ id: "e1", version_id: "v1" }, { id: "e2", version_id: "v1" }];
    const P = (enr: string, n: number) => ({ enrollment_id: enr, day_number: n, course_id: `c${n}`, day_id: D(n).toUpperCase(), completed_at: "2026-02-01T10:00:00Z" });

    {
      const s = stub({ progress: [P("e1", 1), P("e1", 2), P("e2", 1)], versions: [{ id: "v1", day_ids: { "1": D(1), "2": D(2) } }] });
      const r = await readJourneyCredits(s.client, ENR);
      eq("0107: ok, read by day id", r.ok && r.byDayId, true);
      eq("…two requests: progress with course_id and day_id, then the versions' day_ids", s.reqs.map((q) => [q.table, q.select]), [
        ["journey_day_progress", "enrollment_id, day_number, completed_at, course_id, day_id"],
        ["journey_versions", "id, day_ids"],
      ]);
      eq("…each request carries its own abort signal (no memoized re-read)", s.reqs.every((q) => q.signal instanceof AbortSignal) && s.reqs[0].signal !== s.reqs[1].signal, true);
      eq("…the rows by enrolment, day ids in lower case", r.ok ? [r.rowsOf("e1").map((x) => x.day_id), r.rowsOf("e2").length, r.rowsOf("e3")] : null, [[D(1), D(2)], 1, []]);
      eq("…dayIdsOf the version's map; {} for a version it did not read", r.ok ? [r.dayIdsOf("v1"), r.dayIdsOf("v9")] : null, [{ "1": D(1), "2": D(2) }, {}]);
      eq("…each row's course_id, the course its credit was earned on", r.ok ? r.rowsOf("e1").map((x) => x.course_id) : null, ["c1", "c2"]);
    }
    {
      const s = stub({ progress: [{ ...P("e1", 1), course_id: null }, { ...P("e1", 2), course_id: 7 }, { ...P("e1", 3), course_id: "" }], versions: [{ id: "v1", day_ids: { "1": D(1) } }] });
      const r = await readJourneyCredits(s.client, ENR);
      eq("a course_id that is null (its course deleted), not a string or empty reads as null", r.ok ? r.rowsOf("e1").map((x) => x.course_id) : null, [null, null, null]);
    }
    {
      const s = stub({ progress: [P("e1", 1)], versions: [{ id: "v1", day_ids: null }] });
      const r = await readJourneyCredits(s.client, ENR);
      eq("0107, a version whose day_ids is null: {} (credits nothing, as journey_credit_state)", r.ok ? r.dayIdsOf("v1") : null, {});
    }
    {
      const s = stub({ no0107: true, progress: [P("e1", 1), P("e1", 2)] });
      const r = await readJourneyCredits(s.client, ENR);
      eq("no 0107 (42703 naming day_id): ok, read by number", r.ok ? r.byDayId : null, false);
      eq("…today's select once more (course_id kept: it is on every database), and no versions read", s.reqs.map((q) => [q.table, q.select]), [
        ["journey_day_progress", "enrollment_id, day_number, completed_at, course_id, day_id"],
        ["journey_day_progress", "enrollment_id, day_number, completed_at, course_id"],
      ]);
      eq("…the rows keep their course_id", r.ok ? r.rowsOf("e1").map((x) => x.course_id) : null, ["c1", "c2"]);
      eq("…rows without a day id; dayIdsOf null, so creditedDaysFor reads by number",
        r.ok ? [r.rowsOf("e1").map((x) => x.day_id), r.dayIdsOf("v1")] : null, [[null, null], null]);
      const v = version([[1, D(1), "A"], [2, D(2), "B"], [3, D(3), "C"]], 3);
      eq("…today's reading: days 1 and 2 credited, the open day 3",
        r.ok ? stateOf({ ...v, day_ids: r.dayIdsOf("v1") }, r.rowsOf("e1")).nextDay : null, 3);
    }
    {
      // A missing-column error naming day_ids: today's reading by number too
      // (P2-4 item 2), the rows already read kept.
      const s = stub({ progress: [P("e1", 1), P("e1", 2)], versionsError: { code: "42703", message: "column journey_versions.day_ids does not exist" } });
      const r = await readJourneyCredits(s.client, ENR);
      eq("day_id there but day_ids missing (42703 naming day_ids): ok, read by number", r.ok ? [r.byDayId, r.dayIdsOf("v1")] : null, [false, null]);
      eq("…no second read of the rows", s.reqs.map((q) => q.table), ["journey_day_progress", "journey_versions"]);
      const v = version([[1, D(1), "A"], [2, D(2), "B"], [3, D(3), "C"]], 3);
      eq("…today's reading: days 1 and 2 credited by number, the open day 3",
        r.ok ? stateOf({ ...v, day_ids: r.dayIdsOf("v1") }, r.rowsOf("e1")).nextDay : null, 3);
    }
    {
      const s = stub({ progressError: { code: "XX000", message: "boom" } });
      const r = await readJourneyCredits(s.client, ENR);
      eq("any other error: {ok: false}, no second read", [r.ok, s.reqs.length], [false, 1]);
    }
    {
      const s = stub({ progress: [P("e1", 1)], versionsError: { code: "57014", message: "statement timeout" } });
      const r = await readJourneyCredits(s.client, ENR);
      eq("a failed versions read (any other error): {ok: false}, never by number", [r.ok, s.reqs.map((q) => q.table)], [false, ["journey_day_progress", "journey_versions"]]);
    }
    {
      const s = stub({ progress: [P("e1", 1)], versionsError: { code: "42703", message: "column journey_versions.version_number does not exist" } });
      const r = await readJourneyCredits(s.client, ENR);
      eq("…a missing column that is not day_ids is a failure too", r.ok, false);
    }
    {
      const s = stub({ progress: [P("e1", 1)], versions: [] });
      const r = await readJourneyCredits(s.client, ENR);
      eq("a pinned version the versions read did not answer: {ok: false} (never a version that credits nothing)",
        r.ok ? "ok" : r.error?.code, "version_unreadable");
    }
    {
      const s = stub({ progress: [], versions: [{ id: "v1", day_ids: { "1": D(1) } }] });
      const r = await readJourneyCredits(s.client, ENR);
      eq("no enrolment holds a credit: ok, one request (no versions read)", [r.ok, s.reqs.map((q) => q.table)], [true, ["journey_day_progress"]]);
      eq("…dayIdsOf {} and no rows, so nothing is credited", r.ok ? creditedDaysFor({ ...version([[1, D(1), "A"]], 1), day_ids: r.dayIdsOf("v1") }, r.rowsOf("e1")) : null, []);
    }
    {
      const two = [{ id: "e1", version_id: "v1" }, { id: "e3", version_id: "v2" }];
      const s = stub({ progress: [P("e1", 1)], versions: [{ id: "v1", day_ids: { "1": D(1) } }, { id: "v2", day_ids: { "1": D(1) } }] });
      const r = await readJourneyCredits(s.client, two);
      eq("only the versions of enrolments that hold a credit are read",
        s.reqs.filter((q) => q.table === "journey_versions").map((q) => q.ops.find(([op]) => op === "in")?.[1][1]), [["v1"]]);
      eq("…the other version answers {} (its enrolment has no row to map)", r.ok ? [r.dayIdsOf("v2"), r.rowsOf("e3")] : null, [{}, []]);
    }
    {
      const s = stub({});
      const r = await readJourneyCredits(s.client, []);
      eq("no enrolment: ok with nothing, no request", [r.ok, s.reqs.length], [true, 0]);
    }
    {
      // Two calls of one request sharing the decision (the CRM feed's batches).
      const s = stub({ no0107: true, progress: [P("e1", 1), P("e2", 2)] });
      const state: OptionalColumnState = { columns: null };
      const first = await readJourneyCredits(s.client, [ENR[0]], { state });
      const second = await readJourneyCredits(s.client, [ENR[1]], { state });
      eq("a shared state: one failed read for both calls, each by number",
        [first.ok && !first.byDayId, second.ok && !second.byDayId, s.reqs.filter((q) => q.select.includes("day_id")).length, s.reqs.length], [true, true, 1, 3]);
    }
    {
      // 160 enrolments (two chunks of 150 and 10) and 1,200 rows on the first enrolment (two pages).
      const enr = Array.from({ length: 160 }, (_, i) => ({ id: `e${i}`, version_id: "v1" }));
      const progress = [
        ...Array.from({ length: 1200 }, (_, i) => ({ enrollment_id: "e0", day_number: (i % 90) + 1, day_id: D((i % 90) + 1), completed_at: null })),
        { enrollment_id: "e159", day_number: 1, day_id: D(1), completed_at: null },
      ];
      const s = stub({ no0107: true, progress });
      const r = await readJourneyCredits(s.client, enr);
      const reads = s.reqs.filter((q) => q.table === "journey_day_progress");
      eq("chunks and pages: the first page decides once (one 42703), then every page and chunk reads the decided columns",
        reads.map((q) => [q.select.includes("day_id"), (q.ops.find(([op]) => op === "in")?.[1][1] as string[]).length, q.ops.find(([op]) => op === "range")?.[1]]),
        [[true, 150, [0, 999]], [false, 150, [0, 999]], [false, 150, [1000, 1999]], [false, 10, [0, 999]]]);
      eq("…every row read", r.ok ? [r.rowsOf("e0").length, r.rowsOf("e159").length] : null, [1200, 1]);
    }
  }

  console.log("\n(f) learnerCanAccessCourse's journey branch on a stub client");
  {
    // The default world: one active enrolment on a version where a day was
    // inserted at 2 before credited days: credits on d1, d2 and d3 (numbers
    // 1, 3 and 4 now), each row holding the course its day still holds, the
    // open day 2 (the new day). Started long ago, so the calendar allows
    // every day and the ceiling is the open day in both modes.
    type Req = { table: string; select: string; ops: Array<[string, unknown[]]> };
    // One credit row: [enrolment, day id, number when credited, the course on the row].
    type Credit = [string, string, number, string | null];
    type World = {
      mode: "calendar" | "progress";
      progressError?: { code: string; message: string };
      /** A database without 0107: a credits select naming day_id answers 42703. */
      no0107?: boolean;
      /** The pinned version's [number, course] entries and its day_ids. */
      days?: Array<[number, string | null]>;
      dayIds?: Record<string, string>;
      credits?: Credit[];
      enrollments?: string[];
      /** The enrolments' status ("active" unless given). */
      status?: "active" | "completed";
    };
    const INSERTED: Array<[number, string | null]> = [[1, "A"], [2, "N"], [3, "B"], [4, "C"], [5, "D"]];
    const INSERTED_IDS = { "1": D(1), "2": NEW, "3": D(2), "4": D(3), "5": D(4) };
    const KEPT: Credit[] = [["e1", D(1), 1, "A"], ["e1", D(2), 2, "B"], ["e1", D(3), 3, "C"]];
    const stub = (w: World) => {
      const reqs: Req[] = [];
      const days = (w.days ?? INSERTED).map(([day, course_id]) => ({ day, course_id, mission_title: null }));
      const answerOf = (r: Req, single: boolean) => {
        const rows = (() => {
          switch (r.table) {
            case "journey_enrollments":
              return (w.enrollments ?? ["e1"]).map((id) => ({ id, version_id: "v1", start_date: "2026-01-01", status: w.status ?? "active", journey_programs: { is_active: true } }));
            case "journey_versions":
              return [{ id: "v1", days_total: Math.max(...days.map((d) => d.day)), count_sundays: true, days, unlock_mode: w.mode, day_ids: w.dayIds ?? INSERTED_IDS }];
            case "journey_day_progress": {
              if (w.progressError) return w.progressError;
              const withDayId = r.select.includes("day_id");
              if (w.no0107 && withDayId) return { code: "42703", message: "column journey_day_progress.day_id does not exist" };
              // The read's `.in("enrollment_id", ...)` is honoured: a read for
              // one enrolment answers that enrolment's rows only.
              const ids = (r.ops.find(([op]) => op === "in")?.[1][1] ?? []) as string[];
              return (w.credits ?? KEPT)
                .filter(([enr]) => ids.includes(enr))
                .map(([enr, dayId, n, course]) => ({
                  enrollment_id: enr, day_number: n, course_id: course, completed_at: "2026-01-02T10:00:00Z",
                  ...(withDayId ? { day_id: dayId } : {}),
                }));
            }
            default:
              return [];
          }
        })();
        if (!Array.isArray(rows)) return { data: null, error: rows };
        return { data: single ? rows[0] ?? null : rows, error: null };
      };
      const from = (table: string) => {
        const r: Req = { table, select: "", ops: [] };
        reqs.push(r);
        let single = false;
        const b: Record<string, unknown> = {};
        for (const op of ["eq", "in", "order", "range", "abortSignal", "neq", "is", "limit"]) b[op] = (...a: unknown[]) => (r.ops.push([op, a]), b);
        b.select = (s: string) => ((r.select = s), b);
        b.maybeSingle = () => ((single = true), b);
        b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(answerOf(r, single)).then(res, rej);
        return b;
      };
      return { client: { from }, reqs };
    };
    const access = async (w: World, courseId: string, journeyCredits?: { ids: ReadonlySet<string>; credits: JourneyCredits }) => {
      const s = stub(w);
      const res = await learnerCanAccessCourse({
        supabase: s.client as never, orgId: "org-1", userId: "u1", courseId, isAdmin: false, visibility: "private", journeyCredits,
      });
      return { res, creditReads: s.reqs.filter((q) => q.table === "journey_day_progress").length };
    };
    const allowed = { allowed: true, upcomingAt: null };
    const denied = { allowed: false, upcomingAt: null };
    for (const mode of ["calendar", "progress"] as const) {
      eq(`${mode}: the course of a credited day numbered above the open day (day 3), the course on its credit row, stays open for review`, (await access({ mode }, "B")).res, allowed);
      eq(`${mode}: …and of the credited day 4`, (await access({ mode }, "C")).res, allowed);
      eq(`${mode}: the open day's course (day 2) is open`, (await access({ mode }, "N")).res, allowed);
      eq(`${mode}: a day past the open day that holds no credit (day 5) is not`, (await access({ mode }, "D")).res, denied);
    }
    eq("a credit row without a course (its course deleted) grants nothing: the credited day 3 above the open day is closed",
      (await access({ mode: "calendar", credits: [["e1", D(1), 1, "A"], ["e1", D(2), 2, null], ["e1", D(3), 3, "C"]] }, "B")).res, denied);
    eq("…the other credited day above the open day still opens", (await access({ mode: "calendar", credits: [["e1", D(1), 1, "A"], ["e1", D(2), 2, null], ["e1", D(3), 3, "C"]] }, "C")).res, allowed);

    // A day's course swapped (section 95; step 22's row for ?journey=E&day=):
    // credits on d1 (course X) and d2 (course A); a publish to all inserted
    // a day 2 (course N) and swapped d2's course to B, so d2 is day 3 now,
    // credited above the open day 2. Day 4 (d3, course C) holds no credit.
    const SWAP: Array<[number, string | null]> = [[1, "X"], [2, "N"], [3, "B"], [4, "C"]];
    const SWAP_IDS = { "1": D(1), "2": NEW, "3": D(2), "4": D(3) };
    const SWAP_CREDITS: Credit[] = [["e1", D(1), 1, "X"], ["e1", D(2), 2, "A"]];
    for (const mode of ["calendar", "progress"] as const) {
      const w: World = { mode, days: SWAP, dayIds: SWAP_IDS, credits: SWAP_CREDITS };
      eq(`${mode}, a day's course swapped: the new course B on the credited day 3 is not offered inside the journey`, (await access(w, "B")).res, denied);
      eq(`${mode}, …the open day's course N is open`, (await access(w, "N")).res, allowed);
      eq(`${mode}, …the course on the credit row, A, is no course day of the version (step 23's grant, P2-6)`, (await access(w, "A")).res, denied);
      eq(`${mode}, …day 4's course C, above the open day and not credited, is closed`, (await access(w, "C")).res, denied);
    }
    // The same rule by number on a database without 0107: credits numbered 1
    // (course X) and 3 (course A); a publish gave the rest day 2 a module N
    // and swapped day 3's course to B. By number days 1 and 3 are credited,
    // the open day 2.
    {
      const w: World = { mode: "calendar", no0107: true, days: SWAP, credits: [["e1", D(1), 1, "X"], ["e1", D(3), 3, "A"]] };
      eq("no 0107, a day's course swapped: B on the credited day 3 is closed", (await access(w, "B")).res, denied);
      eq("…the open day's course N is open", (await access(w, "N")).res, allowed);
      eq("…A and C are closed", [(await access(w, "A")).res, (await access(w, "C")).res], [denied, denied]);
      const kept: World = { ...w, credits: [["e1", D(1), 1, "X"], ["e1", D(3), 3, "B"]] };
      eq("…by number, the credited day 3 that keeps its course B (the course on its row) stays open", (await access(kept, "B")).res, allowed);
    }

    // The P2-6 gap (step 22), pinned as today's behaviour: at or below the
    // ceiling the day's current course is granted, a credited day whose
    // course a publish swapped included, and a completed enrolment grants
    // every course of its pinned version. Step 22's rows for
    // `?journey=E&day=` and for a completed E grant a credited day only for
    // the course on its credit row. The grant stays as it is until P2-6
    // points the done-day links at that course, so P2-6 is expected to flip
    // each case below; a failure here names it.
    const gap = (n: string, got: unknown, want: unknown) =>
      eq(`P2-6 gap (step 22): ${n} [today's behaviour, pinned; P2-6 is expected to flip it: update this case with P2-6]`, got, want);
    // Credits on d1 (course X) and d2 (course A); a publish swapped d2's
    // course to B in place, so d2 is still day 2, credited below the open
    // day 3, the ceiling in both modes.
    const BELOW: Array<[number, string | null]> = [[1, "X"], [2, "B"], [3, "C"]];
    const BELOW_IDS = { "1": D(1), "2": D(2), "3": D(3) };
    const BELOW_CREDITS: Credit[] = [["e1", D(1), 1, "X"], ["e1", D(2), 2, "A"]];
    for (const mode of ["calendar", "progress"] as const) {
      const w: World = { mode, days: BELOW, dayIds: BELOW_IDS, credits: BELOW_CREDITS };
      gap(`${mode}, a credited day below the open day whose course a publish swapped: its current course B is allowed (step 22: only A, the course on its credit row)`,
        (await access(w, "B")).res, allowed);
      gap(`${mode}, …the course on its credit row, A, is denied (no course day of the version; step 23 grants it)`, (await access(w, "A")).res, denied);
    }
    // Every course day of SWAP credited (d2's row still holds A): the
    // journey is finished, the ceiling is days_total, so the swapped day 3
    // grants its current course B, which the SWAP cases above deny while
    // day 3 is above the open day.
    const ALL_SWAP: Credit[] = [["e1", D(1), 1, "X"], ["e1", NEW, 2, "N"], ["e1", D(2), 2, "A"], ["e1", D(3), 4, "C"]];
    for (const mode of ["calendar", "progress"] as const) {
      gap(`${mode}, every day credited (finished, still active): the swapped day 3's current course B is allowed (step 22: only A, the course on its credit row)`,
        (await access({ mode, days: SWAP, dayIds: SWAP_IDS, credits: ALL_SWAP }, "B")).res, allowed);
    }
    {
      const done = await access({ mode: "calendar", days: SWAP, dayIds: SWAP_IDS, credits: ALL_SWAP, status: "completed" }, "B");
      gap("a completed enrolment grants every course of its pinned version: the swapped day 3's current course B is allowed, before any credit read (step 22's row for a completed E: review of the course on the credit row)",
        [done.res, done.creditReads], [allowed, 0]);
    }
    gap("a credit row whose course is null on the credited day 2, below the open day 3: the day's current course B is allowed (step 22: a null course grants nothing)",
      (await access({ mode: "calendar", days: BELOW, dayIds: BELOW_IDS, credits: [["e1", D(1), 1, "X"], ["e1", D(2), 2, null]] }, "B")).res, allowed);
    gap("no 0107, the swap by number: the credited day 2, below the open day 3, grants its current course B (step 22: only A, the course on its credit row)",
      (await access({ mode: "calendar", no0107: true, days: BELOW, credits: BELOW_CREDITS }, "B")).res, allowed);

    eq("a failed credit read grants nothing through the journey, the open day included",
      (await access({ mode: "calendar", progressError: { code: "XX000", message: "boom" } }, "N")).res, denied);

    const own = stub({ mode: "calendar" });
    const read = await readJourneyCredits(own.client, [{ id: "e1", version_id: "v1" }]);
    const given = await access({ mode: "calendar" }, "B", { ids: new Set(["e1"]), credits: read });
    eq("the caller's own read, ok and covering the enrolment, is used: no second credit read", [given.res, given.creditReads], [allowed, 0]);
    const other = await access({ mode: "calendar" }, "B", { ids: new Set(["e9"]), credits: read });
    eq("…a read that does not cover the enrolment: the credits are read here", [other.res, other.creditReads], [allowed, 1]);
    const failed: JourneyCredits = { ok: false, error: { code: "XX000", message: "boom" } };
    const notOk = await access({ mode: "calendar" }, "B", { ids: new Set(["e1"]), credits: failed });
    eq("…a failed read handed in: the credits are read here, never taken as none", [notOk.res, notOk.creditReads], [allowed, 1]);
    {
      // Two enrolments holding course C (day 4): e1 credited d1 only (open
      // day 2, so C is past its ceiling); e2 credited d1 to d3, so C is a
      // credited day above its open day, with C on its credit row. The read
      // handed in covers e1 only, so the credits are read here for both.
      const two: World = { mode: "calendar", enrollments: ["e1", "e2"], credits: [["e1", D(1), 1, "A"], ...KEPT.map(([, id, n, c]): Credit => ["e2", id, n, c])] };
      const onlyE1 = await readJourneyCredits(stub(two).client, [{ id: "e1", version_id: "v1" }]);
      eq("…the read handed in holds e1's credits and none of e2's", onlyE1.ok ? [onlyE1.rowsOf("e1").length, onlyE1.rowsOf("e2").length] : null, [1, 0]);
      const partial = await access(two, "C", { ids: new Set(["e1"]), credits: onlyE1 });
      eq("…a read covering e1 but not e2, whose credited day 4 holds C: re-read here, and open", [partial.res, partial.creditReads], [allowed, 1]);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
