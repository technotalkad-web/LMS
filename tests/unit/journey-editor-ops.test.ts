/**
 * Unit tests for the journey editor's operations (ADR 0024 step 92, P2-8
 * items 1, 4 and 6; lib/journey/editor-ops.ts) and the version freeze
 * (freezeVersionDays in lib/journey/journey.ts).
 *
 *   (a) a model of journey_save_days, written from 0107 section 6e as it
 *       stands (the checks and effects in their order, and the table's unique
 *       (program_id, day_number) over every active row, named or not, and its
 *       1-to-365 check), first proved on rehearsal case (31)'s literal
 *       expectations (scripts/migration-rehearsal/assert-0107-plpgsql.sql):
 *       its three saves' answers and day layouts and its twelve refusals with
 *       their codes. Without that, a passing ops test would only prove that
 *       the operations agree with a model nobody checked;
 *   (b) move, insert, remove and clear keep each row's id; clearing keeps the
 *       row; Remove on an unsaved row drops it and never sends removed: true;
 *       an Insert with a row above days_total shifts that row too; an Insert
 *       that would pass day 365 is refused;
 *   (c) two saves in one page session, the second after "Insert a day here"
 *       and a move, through the model: no 23505, every saved row named by id,
 *       one new row; and the two controls that make the test bite (the
 *       editor's state before the first save, and an editor that ignores the
 *       rows above days_total, each raise 23505 on the same save);
 *   (d) pass_required travels with its row through a move, an insert, the
 *       removal of another row and "Move instead", and every entry carries
 *       the key (null where the row has no rule) (P2-N8);
 *   (e) the "Move instead?" test (R17): it asks when one save clears module
 *       C on a saved day and sets C on another, and not for a plain change of
 *       module, a move by the buttons or a C that was on both days already;
 *       accepted, the slots show what the admin set and C's day id sits where
 *       C now is;
 *   (f) the freeze: whole day numbers 1 to days_total only (a removed row, a
 *       row above the length and a fractional number are left out), day_ids
 *       for every frozen day with rest days included, pass_required copied
 *       only when it is a boolean.
 *
 * No database, no network.
 *
 * Run:  npx tsx tests/unit/journey-editor-ops.test.ts   (or npm run test:unit)
 */
import {
  afterSave,
  applyMoveInstead,
  clearDay,
  editorFromRows,
  insertDayAt,
  moveDay,
  moveInsteadPairs,
  pendingChanges,
  removeDay,
  savePayload,
  setDay,
  slotsOf,
  type EditorState,
  type LoadedDayRow,
  type SaveEntry,
} from "../../lib/journey/editor-ops";
import { freezeVersionDays } from "../../lib/journey/journey";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

// ---------------------------------------------------------------------------
// The model of journey_save_days (0107 section 6e).
// ---------------------------------------------------------------------------
type DbDay = {
  id: string;
  program_id: string;
  day_number: number | null;
  course_id: string | null;
  mission_title: string | null;
  pass_required: boolean | null;
  removed_at: string | null;
};
type SaveAnswer = { saved: number; renumbered: number; removed: number; inserted: number };
type SaveOutcome = { ok: true; answer: SaveAnswer } | { ok: false; code: string; what: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class Refusal extends Error {
  constructor(public code: string, what: string) { super(what); }
}

/** One program's journey_days table (and the other programs' rows) under the admin's session. */
class SaveDaysModel {
  rows: DbDay[];
  private n = 0;
  constructor(public programs: Set<string>, rows: DbDay[]) {
    this.rows = rows.map((r) => ({ ...r }));
  }
  private newId() {
    this.n++;
    return `00000000-0000-4000-8000-${String(this.n).padStart(12, "0")}`;
  }
  /** The active rows of a program, by number (what the save's read-back reads). */
  active(programId: string): LoadedDayRow[] {
    return this.rows
      .filter((r) => r.program_id === programId && r.day_number !== null)
      .sort((a, b) => (a.day_number as number) - (b.day_number as number))
      .map((r) => ({ id: r.id, day_number: r.day_number, course_id: r.course_id, mission_title: r.mission_title, pass_required: r.pass_required }));
  }
  save(programId: string, pDays: unknown): SaveOutcome {
    const work = this.rows.map((r) => ({ ...r }));
    try {
      const answer = this.run(work, programId, pDays);
      this.rows = work; // one transaction: written only when nothing raised
      return { ok: true, answer };
    } catch (e) {
      if (e instanceof Refusal) return { ok: false, code: e.code, what: e.message };
      throw e;
    }
  }
  private run(t: DbDay[], programId: string, pDays: unknown): SaveAnswer {
    // 1. the save itself
    if (!Array.isArray(pDays)) throw new Refusal("22023", "the days must be a JSON array of day objects");
    if (pDays.some((e) => e === null || typeof e !== "object" || Array.isArray(e))) {
      throw new Refusal("22023", "the days must be a JSON array of day objects");
    }
    const els = pDays as Array<Record<string, unknown>>;
    // jsonb_to_recordset(... x(id uuid, removed boolean)): the casts of the first statement
    const idOf = (e: Record<string, unknown>): string | null => {
      const v = e.id;
      if (v === undefined || v === null) return null;
      if (typeof v !== "string" || !UUID.test(v)) throw new Refusal("22P02", "invalid input syntax for type uuid");
      return v.toLowerCase();
    };
    const removedOf = (e: Record<string, unknown>): boolean => {
      const v = e.removed;
      if (v === undefined || v === null) return false;
      if (typeof v !== "boolean") throw new Refusal("22P02", "invalid input syntax for type boolean");
      return v;
    };
    const ids = els.map(idOf);
    const removed = els.map(removedOf);
    if (els.some((_, i) => ids[i] === null && removed[i])) throw new Refusal("22023", "a new day cannot be removed");
    const named = ids.filter((x): x is string => x !== null);
    if (new Set(named).size !== named.length) throw new Refusal("22023", "a day is named twice in the save");
    const numberOf = (e: Record<string, unknown>): number | null => {
      const v = e.day_number;
      if (v === undefined || v === null) return null;
      if (typeof v !== "number" || !Number.isInteger(v)) throw new Refusal("22P02", "invalid input syntax for type integer");
      return v;
    };
    const numbers = els.map(numberOf);
    const taken = numbers.filter((x, i) => x !== null && !removed[i]);
    if (new Set(taken).size !== taken.length) throw new Refusal("22023", "two days of the save share a number");
    const saved = els.length;

    // 2. the program and every named day locked
    if (!this.programs.has(programId)) throw new Refusal("22023", "this session reads no journey program with this id");
    const mine = (id: string) => t.find((r) => r.id === id && r.program_id === programId);
    if (new Set(named).size !== named.filter((id) => mine(id)).length) {
      throw new Refusal("22023", "a day of the save is not a day of this program that this session may change");
    }
    if (els.some((_, i) => ids[i] !== null && mine(ids[i]!)!.removed_at !== null && !removed[i])) {
      throw new Refusal("22023", "a removed day cannot be given a number again");
    }

    // 3. clear the numbers of the days that move or are removed (renumbered counted first)
    let renumbered = 0;
    els.forEach((_, i) => {
      if (ids[i] === null || removed[i]) return;
      if (mine(ids[i]!)!.day_number !== numbers[i]) renumbered++;
    });
    els.forEach((_, i) => {
      if (ids[i] === null) return;
      const d = mine(ids[i]!)!;
      if (d.day_number !== null && (removed[i] || d.day_number !== numbers[i])) d.day_number = null;
    });

    // 4. mark the removed days (a day already removed keeps its time)
    let removedCount = 0;
    els.forEach((_, i) => {
      if (ids[i] === null || !removed[i]) return;
      const d = mine(ids[i]!)!;
      if (d.removed_at === null) { d.removed_at = "now"; removedCount++; }
    });

    // the table's constraints, checked per written row: the 0058 range, the
    // 0107 removed-has-no-number check, and the unique (program_id, day_number)
    const check = (d: DbDay) => {
      if (d.day_number !== null && (d.day_number < 1 || d.day_number > 365)) {
        throw new Refusal("23514", "new row violates check constraint journey_days_day_number_check");
      }
      if (d.removed_at !== null && d.day_number !== null) throw new Refusal("23514", "journey_days_removed_no_number_check");
      if (d.day_number !== null && t.some((o) => o !== d && o.program_id === d.program_id && o.day_number === d.day_number)) {
        throw new Refusal("23505", "duplicate key value violates unique constraint");
      }
    };
    const content = (e: Record<string, unknown>) => {
      const c = e.course_id;
      if (c !== undefined && c !== null && (typeof c !== "string" || !UUID.test(c))) throw new Refusal("22P02", "invalid input syntax for type uuid");
      const p = e.pass_required;
      if (p !== undefined && p !== null && typeof p !== "boolean") throw new Refusal("22P02", "invalid input syntax for type boolean");
      return {
        course_id: typeof c === "string" ? c.toLowerCase() : null,
        mission_title: typeof e.mission_title === "string" ? e.mission_title : null,
        pass_required: typeof p === "boolean" ? p : null,
      };
    };

    // 5. the named days: their numbers and their content
    els.forEach((e, i) => {
      if (ids[i] === null || removed[i]) return;
      const d = mine(ids[i]!)!;
      Object.assign(d, { day_number: numbers[i] }, content(e));
      check(d);
    });

    // 6. the new days
    let inserted = 0;
    els.forEach((e, i) => {
      if (ids[i] !== null) return;
      const d: DbDay = { id: this.newId(), program_id: programId, day_number: numbers[i], removed_at: null, ...content(e) };
      t.push(d);
      check(d);
      inserted++;
    });

    // 7. no day that is not removed is left without a number
    if (t.some((d) => d.program_id === programId && d.removed_at === null && d.day_number === null)) {
      throw new Refusal("22023", "a day that is not removed was left without a number");
    }
    return { saved, renumbered, removed: removedCount, inserted };
  }
}

// ---------------------------------------------------------------------------
// (a) The model on rehearsal case (31).
// ---------------------------------------------------------------------------
console.log("\n(a) the model of journey_save_days on rehearsal case (31)'s literal expectations");
{
  const JS = "00000000-0000-0000-0000-000107174001";
  const OTHER = "00000000-0000-0000-0000-000107173001";
  const S1 = "00000000-0000-0000-0000-000107174101";
  const S2 = "00000000-0000-0000-0000-000107174102";
  const S3 = "00000000-0000-0000-0000-000107174103";
  const S9 = "00000000-0000-0000-0000-000107174109";
  const CA = "00000000-0000-0000-0000-000107171001";
  const CB = "00000000-0000-0000-0000-000107171002";
  const CC = "00000000-0000-0000-0000-000107171003";
  const row = (id: string, program: string, n: number, c: string | null): DbDay => ({ id, program_id: program, day_number: n, course_id: c, mission_title: null, pass_required: null, removed_at: null });
  const m = new SaveDaysModel(new Set([JS, OTHER]), [row(S1, JS, 1, CA), row(S2, JS, 2, CB), row(S3, JS, 3, CC), row(S9, OTHER, 9, null)]);
  const label = (id: string) => ({ [S1]: "S1", [S2]: "S2", [S3]: "S3" } as Record<string, string>)[id] ?? "new";
  /** pg_temp.days7(): each day as S<n>=<number> (r when removed), by number, nulls last, then id. */
  const days7 = () =>
    m.rows
      .filter((r) => r.program_id === JS)
      .sort((a, b) => (a.day_number ?? Infinity) - (b.day_number ?? Infinity) || a.id.localeCompare(b.id))
      .map((r) => `${label(r.id)}=${r.day_number ?? "-"}${r.removed_at !== null ? "r" : ""}`)
      .join(" ");
  const save7 = (p: unknown) => {
    const got = m.save(JS, p);
    return [got.ok ? got.answer : got.code, days7()];
  };

  eq("a swap by identity: {saved 3, removed 0, inserted 0, renumbered 2} S2=1 S1=2 S3=3",
    save7([{ id: S1, day_number: 2, course_id: CA }, { id: S2, day_number: 1, course_id: CB }, { id: S3, day_number: 3, course_id: CC }]),
    [{ saved: 3, renumbered: 2, removed: 0, inserted: 0 }, "S2=1 S1=2 S3=3"]);
  eq("a day inserted at 2: {saved 4, removed 0, inserted 1, renumbered 2} S2=1 new=2 S1=3 S3=4",
    save7([{ id: S2, day_number: 1, course_id: CB }, { id: null, day_number: 2, course_id: CA, mission_title: "New day", pass_required: true },
      { id: S1, day_number: 3, course_id: CA }, { id: S3, day_number: 4, course_id: CC }]),
    [{ saved: 4, renumbered: 2, removed: 0, inserted: 1 }, "S2=1 new=2 S1=3 S3=4"]);
  const newDay = m.rows.find((r) => r.program_id === JS && r.day_number === 2)!;
  eq("…the inserted day's content as saved (1001/New day/t)", `${newDay.course_id!.slice(-4)}/${newDay.mission_title}/${newDay.pass_required ? "t" : "f"}`, "1001/New day/t");
  eq("a day removed and another moved: {saved 2, removed 1, inserted 0, renumbered 1} S2=1 new=2 S3=3 S1=-r",
    save7([{ id: S1, removed: true }, { id: S3, day_number: 3, course_id: CB, pass_required: false }]),
    [{ saved: 2, renumbered: 1, removed: 1, inserted: 0 }, "S2=1 new=2 S3=3 S1=-r"]);
  const s3 = m.rows.find((r) => r.id === S3)!;
  const s1 = m.rows.find((r) => r.id === S1)!;
  eq("…the moved day's content (1002/f) and the removed day's (1001/t)",
    [`${s3.course_id!.slice(-4)}/${s3.pass_required ? "t" : "f"}`, `${s1.course_id!.slice(-4)}/${s1.removed_at !== null ? "t" : "f"}`], ["1002/f", "1001/t"]);

  const before = days7();
  const refusals: Array<[string, unknown, string]> = [
    ["not an array", { id: null }, "22023"],
    ["an element that is not an object", [1], "22023"],
    ["a new day removed", [{ id: null, removed: true }], "22023"],
    ["a day named twice", [{ id: S2, day_number: 1 }, { id: S2, day_number: 2 }], "22023"],
    ["two days on one number", [{ id: S2, day_number: 1 }, { id: null, day_number: 1 }], "22023"],
    ["an id of no day", [{ id: "00000000-0000-0000-0000-000107179999", day_number: 5 }], "22023"],
    ["a day of another program", [{ id: S9, day_number: 5 }], "22023"],
    ["a removed day given a number", [{ id: S1, day_number: 5 }], "22023"],
    ["a day left without a number", [{ id: S3, day_number: null }], "22023"],
    ["a move onto a number an unnamed day holds", [{ id: S3, day_number: 2 }], "23505"],
    ["a number above 365", [{ id: null, day_number: 400 }], "23514"],
    ["an id that is not a uuid", [{ id: "x", day_number: 5 }], "22P02"],
  ];
  for (const [what, payload, code] of refusals) {
    const got = m.save(JS, payload);
    eq(`refused, ${what}: ${code}`, got.ok ? "ok" : got.code, code);
  }
  eq("the twelve refusals left the days as they were", days7(), before);
}

// ---------------------------------------------------------------------------
// Fixtures for (b) to (e).
// ---------------------------------------------------------------------------
const P = "11111111-1111-4111-8111-111111111111";
const id = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`;
const course = (n: number) => `cccccccc-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [CA, CB, CC, CD, CE] = [1, 2, 3, 4, 5].map(course);
/** A journey of 4 days: day 2 has a rule of its own, day 3 is a rest day, slot 4 has no row, and day 5 sits above days_total (left by a shorter length). */
const DAYS_TOTAL = 4;
const seed = (): DbDay[] => [
  { id: id(1), program_id: P, day_number: 1, course_id: CA, mission_title: "Day A", pass_required: null, removed_at: null },
  { id: id(2), program_id: P, day_number: 2, course_id: CB, mission_title: null, pass_required: true, removed_at: null },
  { id: id(3), program_id: P, day_number: 3, course_id: null, mission_title: null, pass_required: null, removed_at: null },
  { id: id(5), program_id: P, day_number: 5, course_id: CE, mission_title: "Beyond", pass_required: false, removed_at: null },
];
const layout = (s: EditorState) => s.rows.map((r) => `${r.day_number}:${r.id ? r.id.slice(-2) : "new"}:${r.course_id ? r.course_id.slice(-1) : "-"}`).join(" ");
const keysOf = (p: SaveEntry[]) => p.map((e) => Object.keys(e).sort().join(","));
const FULL_SHAPE = "course_id,day_number,id,mission_title,pass_required,removed";

// ---------------------------------------------------------------------------
// (b) The operations keep each row's id.
// ---------------------------------------------------------------------------
console.log("\n(b) move, insert, remove and clear keep each row's id");
{
  const db = new SaveDaysModel(new Set([P]), seed());
  const s0 = editorFromRows(db.active(P));
  eq("the editor holds every active row, the one above days_total included", layout(s0), "1:01:1 2:02:2 3:03:- 5:05:5");
  const view = slotsOf(s0, DAYS_TOTAL);
  eq("…it shows 1 to days_total (an empty slot for 4) and day 5 apart", [view.slots.map((r) => `${r.day_number}:${r.id ? "row" : "slot"}`), view.beyond.map((r) => r.day_number)],
    [["1:row", "2:row", "3:row", "4:slot"], [5]]);
  eq("a removed row (no number) is not loaded", layout(editorFromRows([{ id: id(9), day_number: null, course_id: CA, mission_title: null }])), "");

  const moved = moveDay(s0, 1, 1, DAYS_TOTAL);
  eq("Move down swaps the two rows' numbers, not their contents", layout(moved), "1:02:2 2:01:1 3:03:- 5:05:5");
  eq("…Move up back restores the layout", layout(moveDay(moved, 2, -1, DAYS_TOTAL)), layout(s0));
  eq("…a move into an empty slot moves the row (day 3 down to the slot 4)", layout(moveDay(s0, 3, 1, DAYS_TOTAL)), "1:01:1 2:02:2 4:03:- 5:05:5");
  eq("…no move past the first day or the journey's length", [layout(moveDay(s0, 1, -1, DAYS_TOTAL)), layout(moveDay(s0, 4, 1, DAYS_TOTAL))], [layout(s0), layout(s0)]);

  const ins = insertDayAt(s0, 2, DAYS_TOTAL);
  eq("Insert at 2: a new row at 2, later rows down one, day 5 (above days_total) to 6", ins.ok ? layout(ins.state) : ins.reason, "1:01:1 2:new:- 3:02:2 4:03:- 6:05:5");
  eq("…no row crossed the journey's length (day 3 moved to the empty slot 4)", ins.ok ? ins.pushedBeyond : -1, 0);
  const full = setDay(s0, 4, { course_id: CD });
  const ins2 = insertDayAt(full, 1, DAYS_TOTAL);
  eq("Insert at 1 with every slot filled: the last day crosses the length and is counted", ins2.ok ? [layout(ins2.state), ins2.pushedBeyond] : ins2.reason,
    ["1:new:- 2:01:1 3:02:2 4:03:- 5:new:4 6:05:5", 1]);

  const rem = removeDay(s0, 2, DAYS_TOTAL);
  eq("Remove day 2: the row leaves, later rows up one (day 5 to 4: back inside the length)", layout(rem), "1:01:1 2:03:- 4:05:5");
  eq("…its id is sent as removed", rem.removedIds, [id(2)]);
  const cleared = clearDay(s0, 1);
  eq("Clear day 1's module: the row stays, with its id, number and title; a rest day", cleared.rows[0], { id: id(1), day_number: 1, course_id: null, mission_title: "Day A", pass_required: null });

  const unsaved = insertDayAt(s0, 1, DAYS_TOTAL);
  const dropped = unsaved.ok ? removeDay(setDay(unsaved.state, 1, { course_id: CC }), 1, DAYS_TOTAL) : s0;
  eq("Remove on a row without an id: dropped, the layout back", layout(dropped), layout(s0));
  eq("…never sent as removed (no id null with removed: true; no removed entry at all)",
    savePayload(dropped, DAYS_TOTAL).filter((e) => e.removed).length, 0);
  eq("…and the model accepts the save", db.save(P, savePayload(dropped, DAYS_TOTAL)).ok, true);

  const top: LoadedDayRow[] = Array.from({ length: 365 }, (_, i) => ({ id: id(100 + i), day_number: i + 1, course_id: null, mission_title: null }));
  const fullYear = insertDayAt(editorFromRows(top), 1, 365);
  eq("an Insert that would pass day 365 is refused", fullYear.ok ? "inserted" : /365/.test(fullYear.reason), true);

  eq("savePayload: the full shape on every entry (a key left out reads null in journey_save_days)",
    [...new Set(keysOf(savePayload(rem, DAYS_TOTAL)))], [FULL_SHAPE]);
  eq("…the empty slot 4 is sent as a new row, as the editor always saved every slot",
    savePayload(s0, DAYS_TOTAL).filter((e) => e.id === null).map((e) => e.day_number), [4]);
  eq("pendingChanges: the loaded rows and an empty slot are no change; a title edit 1; the empty slot given a module 2",
    [pendingChanges(s0, s0, DAYS_TOTAL), pendingChanges(s0, setDay(s0, 1, { mission_title: "x" }), DAYS_TOTAL),
      pendingChanges(s0, setDay(setDay(s0, 1, { mission_title: "x" }), 4, { course_id: CD }), DAYS_TOTAL)], [0, 1, 2]);
  eq("…Remove day 2: 3 (the removal, and days 3 and 5 moving up)", pendingChanges(s0, removeDay(s0, 2, DAYS_TOTAL), DAYS_TOTAL), 3);
  const ins3 = insertDayAt(s0, 2, DAYS_TOTAL);
  eq("…an Insert counts the rows it moves, not its own empty row (Insert at 2 moves 2, 3 and 5)", ins3.ok ? pendingChanges(s0, ins3.state, DAYS_TOTAL) : -1, 3);
}

// ---------------------------------------------------------------------------
// (c) Two saves in one page session.
// ---------------------------------------------------------------------------
console.log("\n(c) two saves in one page session, the second after \"Insert a day here\" and a move: no 23505");
{
  const db = new SaveDaysModel(new Set([P]), seed());
  const loaded = editorFromRows(db.active(P));
  // First save: day 1 moved down, the empty slot 4 given a module.
  let s = setDay(moveDay(loaded, 1, 1, DAYS_TOTAL), 4, { course_id: CD });
  const first = db.save(P, savePayload(s, DAYS_TOTAL));
  eq("the first save: ok, 2 renumbered, 1 inserted", first.ok ? first.answer : first.code, { saved: 5, renumbered: 2, removed: 0, inserted: 1 });
  const stale = s; // what the page held before P2-N7 rule (1)
  s = afterSave(db.active(P));
  eq("after the save the editor holds the id of every saved row (rule 1)", s.rows.every((r) => r.id !== null), true);
  const ids1 = s.rows.map((r) => r.id);

  // Second save: "Insert a day here" at 2, then day 4 moved up.
  const ins = insertDayAt(s, 2, DAYS_TOTAL);
  if (!ins.ok) throw new Error(ins.reason);
  const second = moveDay(ins.state, 4, -1, DAYS_TOTAL);
  const payload = savePayload(second, DAYS_TOTAL);
  eq("the second save names every saved row by id", ids1.every((x) => payload.some((e) => e.id === x)), true);
  eq("…and inserts only the new row", payload.filter((e) => e.id === null).length, 1);
  const got = db.save(P, payload);
  // S2 stays on 1; S1 2 to 4, S3 stays on 3 (inserted at 2, then moved up),
  // D 4 to 5 (past the length) and the row above days_total 5 to 6.
  eq("…the model raises nothing (no 23505): six entries, three renumbered, one inserted", got.ok ? got.answer : got.code, { saved: 6, renumbered: 3, removed: 0, inserted: 1 });
  eq("…the first save's rows keep their ids, numbers as shown", db.active(P).map((r) => `${r.day_number}:${r.id}`),
    second.rows.map((r) => `${r.day_number}:${r.id ?? db.active(P).find((x) => x.day_number === r.day_number)!.id}`));

  // The controls: each fails the same save with 23505.
  const db2 = new SaveDaysModel(new Set([P]), seed());
  db2.save(P, savePayload(stale, DAYS_TOTAL));
  const staleIns = insertDayAt(stale, 2, DAYS_TOTAL);
  const staleSecond = staleIns.ok ? moveDay(staleIns.state, 4, -1, DAYS_TOTAL) : stale;
  const bad = db2.save(P, savePayload(staleSecond, DAYS_TOTAL));
  eq("control: the state held before the first save (no ids for its new rows) raises 23505", bad.ok ? "ok" : bad.code, "23505");

  const db3 = new SaveDaysModel(new Set([P]), seed());
  const visibleOnly = (st: EditorState): EditorState => ({ ...st, rows: st.rows.filter((r) => r.day_number <= DAYS_TOTAL) });
  const ignoring = insertDayAt(visibleOnly(editorFromRows(db3.active(P))), 1, DAYS_TOTAL);
  const hid = ignoring.ok ? db3.save(P, savePayload(visibleOnly(ignoring.state), 6)) : null;
  eq("control: an editor that ignores the row above days_total raises 23505 on an Insert", hid && !hid.ok ? hid.code : "ok", "23505");
  const holding = insertDayAt(editorFromRows(db3.active(P)), 1, DAYS_TOTAL);
  const ok3 = holding.ok ? db3.save(P, savePayload(holding.state, DAYS_TOTAL)) : null;
  eq("…holding it, the same Insert saves", ok3?.ok ?? false, true);
  eq("…and the row above days_total moved too (5 to 6)", db3.active(P).find((r) => r.id === id(5))?.day_number, 6);
}

// ---------------------------------------------------------------------------
// (d) pass_required travels with its row (P2-N8).
// ---------------------------------------------------------------------------
console.log("\n(d) a row's pass_required stays with it through every operation, and every entry carries the key");
{
  const s0 = editorFromRows(seed().map((r) => ({ ...r })));
  const ruleOf = (st: EditorState) => st.rows.find((r) => r.id === id(2))?.pass_required;
  const afterMove = moveDay(s0, 2, -1, DAYS_TOTAL);
  const afterIns = insertDayAt(afterMove, 1, DAYS_TOTAL);
  const afterRem = afterIns.ok ? removeDay(afterIns.state, 3, DAYS_TOTAL) : afterMove;
  eq("true through a move, an insert and the removal of another row", [ruleOf(afterMove), afterIns.ok ? ruleOf(afterIns.state) : null, ruleOf(afterRem)], [true, true, true]);
  const payload = savePayload(afterRem, DAYS_TOTAL);
  eq("the save sends it unchanged", payload.find((e) => e.id === id(2))?.pass_required, true);
  eq("a row with no rule sends null, the key present", payload.filter((e) => e.id === id(1)).map((e) => ["pass_required" in e, e.pass_required]), [[true, null]]);
  eq("a false rule (day 5, above the length) is sent as false", payload.find((e) => e.id === id(5))?.pass_required, false);
  const db = new SaveDaysModel(new Set([P]), seed());
  db.save(P, payload);
  eq("…and the model keeps day 2's rule", db.rows.find((r) => r.id === id(2))?.pass_required, true);

  // Through "Move instead": day 2 (rule true) cleared, its module chosen on day 4.
  const st = setDay(clearDay(s0, 2), 4, { course_id: CB });
  const pairs = moveInsteadPairs(s0, st);
  const moved = pairs.length === 1 ? applyMoveInstead(st, pairs[0]) : st;
  eq("…and through Move instead (day 2's row, now on day 4 with B, keeps true)", moved.rows.find((r) => r.id === id(2))?.pass_required, true);
}

// ---------------------------------------------------------------------------
// (e) "Move instead?" (R17).
// ---------------------------------------------------------------------------
console.log("\n(e) the \"Move instead?\" test (R17)");
{
  const s0 = editorFromRows(seed().map((r) => ({ ...r })));
  const st = setDay(clearDay(s0, 1), 3, { course_id: CA });
  const pairs = moveInsteadPairs(s0, st);
  eq("one save clears A on day 1 and sets A on day 3: asked once", pairs, [{ course_id: CA, from: 1, fromId: id(1), to: 3, toId: id(3) }]);
  eq("…a new row (the empty slot 4) is a target too", moveInsteadPairs(s0, setDay(clearDay(s0, 1), 4, { course_id: CA })).map((p) => [p.from, p.to, p.toId]), [[1, 4, null]]);
  eq("not for a plain change of module (A to C on day 1)", moveInsteadPairs(s0, setDay(s0, 1, { course_id: CC })), []);
  eq("not for a move by the buttons", moveInsteadPairs(s0, moveDay(s0, 1, 1, DAYS_TOTAL)), []);
  const both = editorFromRows([...seed().slice(0, 2), { ...seed()[2], course_id: CA }]);
  eq("not for a module that was on both days already (A on 1 and 3; 1 cleared)", moveInsteadPairs(both, clearDay(both, 1)), []);
  eq("not for a removed day (the literal reading: a cleared day only)", moveInsteadPairs(s0, setDay(removeDay(s0, 1, DAYS_TOTAL), 3, { course_id: CA })), []);
  eq("not for a clear alone", moveInsteadPairs(s0, clearDay(s0, 1)), []);

  const accepted = applyMoveInstead(st, pairs[0]);
  const shown = (x: EditorState) => slotsOf(x, DAYS_TOTAL).slots.map((r) => `${r.day_number}:${r.course_id ? r.course_id.slice(-1) : "-"}:${r.mission_title ?? ""}`);
  eq("accepted: the slots show what the admin set", shown(accepted), shown(st));
  eq("…and A's day id (day 1's row) now sits where A is", accepted.rows.find((r) => r.course_id === CA)?.id, id(1));
  eq("…day 3's row takes the cleared slot", accepted.rows.find((r) => r.day_number === 1)?.id, id(3));
  eq("…nothing left to ask", moveInsteadPairs(s0, accepted), []);
  const db = new SaveDaysModel(new Set([P]), seed());
  const saved = db.save(P, savePayload(accepted, DAYS_TOTAL));
  eq("…the model saves it: A's row moved to 3 with A", [saved.ok, db.active(P).find((r) => r.id === id(1))?.day_number, db.active(P).find((r) => r.id === id(1))?.course_id], [true, 3, CA]);
}

// ---------------------------------------------------------------------------
// (f) The freeze.
// ---------------------------------------------------------------------------
console.log("\n(f) freezeVersionDays: what the publish and its dry run freeze");
{
  const rows = [
    { id: id(3), day_number: 3, course_id: null, mission_title: null, pass_required: null },
    { id: id(1), day_number: 1, course_id: CA, mission_title: "Day A", pass_required: true },
    { id: id(2), day_number: 2, course_id: CB, mission_title: null, pass_required: false },
    { id: id(7), day_number: null, course_id: CC, mission_title: null, pass_required: true },
    { id: id(5), day_number: 5, course_id: CE, mission_title: null },
    { id: id(8), day_number: 2.5, course_id: CD, mission_title: null },
  ];
  const f = freezeVersionDays(rows, DAYS_TOTAL);
  eq("days: 1 to days_total, ascending; a removed row, a row above the length and a fractional number left out", f.days.map((d) => d.day), [1, 2, 3]);
  eq("…course and title as held; pass_required only when a boolean (true and false kept, null left out)", f.days, [
    { day: 1, course_id: CA, mission_title: "Day A", pass_required: true },
    { day: 2, course_id: CB, mission_title: null, pass_required: false },
    { day: 3, course_id: null, mission_title: null },
  ]);
  eq("day_ids: every frozen day, the rest day included; no \"null\" key and nothing above the length", f.day_ids, { "1": id(1), "2": id(2), "3": id(3) });
  eq("a row without the column (a database without 0107) freezes without the key", freezeVersionDays([{ id: id(1), day_number: 1, course_id: CA, mission_title: null }], 1).days, [{ day: 1, course_id: CA, mission_title: null }]);
  eq("nothing frozen from no rows", freezeVersionDays([], 3), { days: [], day_ids: {} });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
