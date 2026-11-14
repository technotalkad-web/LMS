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
 *       course days not credited, minus today's), zero missions never
 *       finished nor open, nextDay;
 *   (d) creditedDaysFor: by id, by number only when the reader fell back
 *       (day_ids null), `{}` credits nothing; reminderCreditedDays's
 *       fallback to the first `done` course days; resumableDayIdsFor;
 *       parseVersionDays' dayId and a day listed twice;
 *   (e) readJourneyCredits (lib/journey/credits-read.ts) on a stub client: the
 *       two reads with day_id and day_ids, each request with its own abort
 *       signal; on a missing-column error naming day_id, today's reading by
 *       number and no versions read; day_ids missing while day_id is there,
 *       and any other error, answer {ok: false}; chunks and pages decided
 *       once.
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
  creditedDaysFor,
  parseVersionDays,
  reminderCreditedDays,
  resumableDayIdsFor,
  type JourneyCreditRow,
  type JourneyUnlockMode,
} from "../../lib/journey/journey";
import { readJourneyCredits } from "../../lib/journey/credits-read";

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
const raw = (dayId: string | null, dayNumber: number): JourneyCreditRow => ({ day_id: dayId, day_number: dayNumber, completed_at: null });
const credit = (dayId: string, dayNumber: number): JourneyCreditRow => ({ day_id: dayId, day_number: dayNumber, completed_at: "2026-02-01T10:00:00Z" });
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
            return { data: w.versions ?? [], error: null };
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
    const P = (enr: string, n: number) => ({ enrollment_id: enr, day_number: n, day_id: D(n).toUpperCase(), completed_at: "2026-02-01T10:00:00Z" });

    {
      const s = stub({ progress: [P("e1", 1), P("e1", 2), P("e2", 1)], versions: [{ id: "v1", day_ids: { "1": D(1), "2": D(2) } }] });
      const r = await readJourneyCredits(s.client, ENR);
      eq("0107: ok, read by day id", r.ok && r.byDayId, true);
      eq("…two requests: progress with day_id, then the versions' day_ids", s.reqs.map((q) => [q.table, q.select]), [
        ["journey_day_progress", "enrollment_id, day_number, completed_at, day_id"],
        ["journey_versions", "id, day_ids"],
      ]);
      eq("…each request carries its own abort signal (no memoized re-read)", s.reqs.every((q) => q.signal instanceof AbortSignal) && s.reqs[0].signal !== s.reqs[1].signal, true);
      eq("…the rows by enrolment, day ids in lower case", r.ok ? [r.rowsOf("e1").map((x) => x.day_id), r.rowsOf("e2").length, r.rowsOf("e3")] : null, [[D(1), D(2)], 1, []]);
      eq("…dayIdsOf the version's map; {} for a version it did not read", r.ok ? [r.dayIdsOf("v1"), r.dayIdsOf("v9")] : null, [{ "1": D(1), "2": D(2) }, {}]);
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
      eq("…today's select once more, and no versions read", s.reqs.map((q) => [q.table, q.select]), [
        ["journey_day_progress", "enrollment_id, day_number, completed_at, day_id"],
        ["journey_day_progress", "enrollment_id, day_number, completed_at"],
      ]);
      eq("…rows without a day id; dayIdsOf null, so creditedDaysFor reads by number",
        r.ok ? [r.rowsOf("e1").map((x) => x.day_id), r.dayIdsOf("v1")] : null, [[null, null], null]);
      const v = version([[1, D(1), "A"], [2, D(2), "B"], [3, D(3), "C"]], 3);
      eq("…today's reading: days 1 and 2 credited, the open day 3",
        r.ok ? stateOf({ ...v, day_ids: r.dayIdsOf("v1") }, r.rowsOf("e1")).nextDay : null, 3);
    }
    {
      const s = stub({ progress: [P("e1", 1)], versionsError: { code: "42703", message: "column journey_versions.day_ids does not exist" } });
      const r = await readJourneyCredits(s.client, ENR);
      eq("day_id there but day_ids missing: {ok: false}, never a fallback", r.ok, false);
    }
    {
      const s = stub({ progressError: { code: "XX000", message: "boom" } });
      const r = await readJourneyCredits(s.client, ENR);
      eq("any other error: {ok: false}, no second read", [r.ok, s.reqs.length], [false, 1]);
    }
    {
      const s = stub({ versionsError: { code: "57014", message: "statement timeout" } });
      const r = await readJourneyCredits(s.client, ENR);
      eq("a failed versions read: {ok: false}", r.ok, false);
    }
    {
      const s = stub({});
      const r = await readJourneyCredits(s.client, []);
      eq("no enrolment: ok with nothing, no request", [r.ok, s.reqs.length], [true, 0]);
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

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
