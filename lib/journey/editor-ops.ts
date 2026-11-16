/**
 * The journey editor's operations (ADR 0024 step 92, P2-8 item 1): pure,
 * client-safe, no imports. Every operation keeps each row's identity, the
 * journey_days row id, so a day keeps its id (and with it its learners'
 * credits and attempt contexts) when the admin moves it.
 *
 *   - "Move up" / "Move down" swap the two rows' numbers, not their contents;
 *   - "Insert a day here" creates a row and shifts every later row down one;
 *   - "Remove day" marks a saved row removed (it is sent with removed: true)
 *     and shifts every later row up one;
 *   - clearing a day's module keeps the row: it becomes a rest day, as before.
 *
 * P2-N7's three rules hold through these functions:
 *   (1) after every save the editor is rebuilt from the save's read-back
 *       (afterSave), so it holds the id of every saved row and a later save
 *       in the same page session never sends a saved day again without it;
 *   (2) Remove on a row without an id drops it and never sends removed: true
 *       (journey_save_days refuses a new removed day);
 *   (3) the editor holds every active row of the program, the rows above
 *       days_total included, and Insert and Remove shift them too; the save
 *       names every row it holds (savePayload), because journey_save_days
 *       leaves an unnamed day where it is, and a named day moved onto its
 *       number would fail the save with 23505.
 *
 * A day's pass_required is carried unchanged through every operation and
 * sent back as it was loaded (P2-N8): journey_save_days writes the entry's
 * value on every named day, and a key left out reads null.
 */

/** One day of the editor: a journey_days row, or a row not saved yet (id null). */
export type EditorDay = {
  /** journey_days.id; null until the row's first save (P2-N7). */
  id: string | null;
  day_number: number;
  /** null = a rest day. */
  course_id: string | null;
  mission_title: string | null;
  /** The day's own pass rule; null = the course's rule. Sent back unchanged (P2-N8). */
  pass_required: boolean | null;
};

export type EditorState = {
  /** One row per number: every active row of the program (above days_total too) and each new row. */
  rows: EditorDay[];
  /** Saved rows the admin removed in this session, sent with removed: true. */
  removedIds: string[];
};

/** One entry of the save, in the full shape journey_save_days reads (every key present). */
export type SaveEntry = {
  id: string | null;
  day_number: number | null;
  course_id: string | null;
  mission_title: string | null;
  pass_required: boolean | null;
  removed: boolean;
};

/** A row as the admin page and the save's read-back load it. */
export type LoadedDayRow = {
  id: string;
  day_number: number | null;
  course_id: string | null;
  mission_title: string | null;
  pass_required?: boolean | null;
};

/** The highest day number a journey day may hold (the 0058 check). */
export const MAX_DAY_NUMBER = 365;

const isDayNumber = (n: unknown): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= MAX_DAY_NUMBER;

const byNumber = (a: EditorDay, b: EditorDay) => a.day_number - b.day_number;

const blank = (n: number): EditorDay => ({
  id: null,
  day_number: n,
  course_id: null,
  mission_title: null,
  pass_required: null,
});

/** A row with nothing in it: no module, no title and no rule of its own. */
const isEmpty = (r: EditorDay) => r.course_id === null && r.mission_title === null && r.pass_required === null;

/**
 * The editor from loaded rows: the active ones (a removed row has no number),
 * by number, a number held twice kept once (the first). Rows above
 * days_total are kept (rule 3).
 */
export function editorFromRows(rows: ReadonlyArray<LoadedDayRow>): EditorState {
  const seen = new Set<number>();
  const out: EditorDay[] = [];
  for (const r of rows) {
    if (!isDayNumber(r.day_number) || seen.has(r.day_number)) continue;
    if (typeof r.id !== "string" || !r.id) continue;
    seen.add(r.day_number);
    out.push({
      id: r.id,
      day_number: r.day_number,
      course_id: r.course_id ?? null,
      mission_title: r.mission_title ?? null,
      pass_required: typeof r.pass_required === "boolean" ? r.pass_required : null,
    });
  }
  return { rows: out.sort(byNumber), removedIds: [] };
}

/** The editor after a save: the save's read-back (rule 1); nothing pending removal. */
export const afterSave = (readBack: ReadonlyArray<LoadedDayRow>): EditorState => editorFromRows(readBack);

/**
 * What the editor shows: one slot per number from 1 to days_total (a number
 * with no row shows an empty, unsaved slot) and, apart, the rows above
 * days_total (outside the journey's length, so outside a publish).
 */
export function slotsOf(state: EditorState, daysTotal: number): { slots: EditorDay[]; beyond: EditorDay[] } {
  const at = new Map(state.rows.map((r) => [r.day_number, r]));
  const slots = Array.from({ length: Math.max(0, Math.min(daysTotal, MAX_DAY_NUMBER)) }, (_, i) => at.get(i + 1) ?? blank(i + 1));
  const beyond = state.rows.filter((r) => r.day_number > daysTotal).sort(byNumber);
  return { slots, beyond };
}

/** A course or title edit on day n; on an empty slot it creates the row (id null). */
export function setDay(
  state: EditorState,
  n: number,
  patch: { course_id?: string | null; mission_title?: string | null }
): EditorState {
  if (!isDayNumber(n)) return state;
  const has = state.rows.some((r) => r.day_number === n);
  const rows = has
    ? state.rows.map((r) => (r.day_number === n ? { ...r, ...patch } : r))
    : [...state.rows, { ...blank(n), ...patch }].sort(byNumber);
  return { ...state, rows };
}

/** Clearing day n's module: the row stays (its id, number, title and rule), as a rest day. */
export const clearDay = (state: EditorState, n: number): EditorState => setDay(state, n, { course_id: null });

/**
 * Move up (dir -1) or down (dir +1): day n and its neighbour swap NUMBERS;
 * each keeps its id, content and rule (step 92). Both must lie in 1 to
 * days_total. An empty slot has no row, so the row moves into it.
 */
export function moveDay(state: EditorState, n: number, dir: -1 | 1, daysTotal: number): EditorState {
  const m = n + dir;
  if (n < 1 || m < 1 || n > daysTotal || m > daysTotal) return state;
  if (!state.rows.some((r) => r.day_number === n || r.day_number === m)) return state;
  const rows = state.rows
    .map((r) => (r.day_number === n ? { ...r, day_number: m } : r.day_number === m ? { ...r, day_number: n } : r))
    .sort(byNumber);
  return { ...state, rows };
}

export type InsertResult =
  | { ok: true; state: EditorState; pushedBeyond: number }
  | { ok: false; reason: string };

/**
 * "Insert a day here": a new, empty row at n; every row at n or later moves
 * down one, the rows above days_total included (rule 3). Refused when a row
 * would pass day 365. An unsaved, empty row pushed above days_total is
 * dropped (it is only an empty slot); `pushedBeyond` counts the other rows
 * the insert moved from inside the journey's length to beyond it.
 */
export function insertDayAt(state: EditorState, n: number, daysTotal: number): InsertResult {
  if (n < 1 || n > daysTotal || !isDayNumber(n)) return { ok: false, reason: "That day is outside the journey." };
  const shifted = state.rows.map((r) => (r.day_number >= n ? { ...r, day_number: r.day_number + 1 } : r));
  if (shifted.some((r) => r.day_number > MAX_DAY_NUMBER)) {
    return { ok: false, reason: `A journey holds at most ${MAX_DAY_NUMBER} days: remove a day after this one first.` };
  }
  let pushedBeyond = 0;
  const kept: EditorDay[] = [];
  for (const r of shifted) {
    const crossed = r.day_number > daysTotal && r.day_number - 1 <= daysTotal;
    if (r.day_number > daysTotal && r.id === null && isEmpty(r)) continue;
    if (crossed) pushedBeyond++;
    kept.push(r);
  }
  return { ok: true, state: { ...state, rows: [...kept, blank(n)].sort(byNumber) }, pushedBeyond };
}

/**
 * "Remove day": day n's row leaves the editor (a saved row is sent with
 * removed: true; a row without an id is dropped and never sent as removed,
 * rule 2), and every later row moves up one, the rows above days_total
 * included (rule 3). On an empty slot only the later rows move.
 */
export function removeDay(state: EditorState, n: number, daysTotal: number): EditorState {
  if (n < 1 || n > daysTotal) return state;
  const gone = state.rows.find((r) => r.day_number === n);
  const rows = state.rows
    .filter((r) => r.day_number !== n)
    .map((r) => (r.day_number > n ? { ...r, day_number: r.day_number - 1 } : r));
  const removedIds = gone?.id ? [...state.removedIds, gone.id] : state.removedIds;
  return { rows, removedIds };
}

/**
 * The save's entries: every row the editor holds, visible or above
 * days_total (rule 3), each in the full shape with its own pass_required
 * (P2-N8); an unsaved entry for each empty slot of 1 to days_total, as the
 * editor has always saved every slot; and one entry per removed row.
 */
export function savePayload(state: EditorState, daysTotal: number): SaveEntry[] {
  const { slots } = slotsOf(state, daysTotal);
  const held = new Set(state.rows.map((r) => r.day_number));
  const entry = (r: EditorDay): SaveEntry => ({
    id: r.id,
    day_number: r.day_number,
    course_id: r.course_id,
    mission_title: r.mission_title,
    pass_required: r.pass_required,
    removed: false,
  });
  const live = [...state.rows, ...slots.filter((s) => !held.has(s.day_number))].sort(byNumber).map(entry);
  const removed = state.removedIds.map(
    (id): SaveEntry => ({ id, day_number: null, course_id: null, mission_title: null, pass_required: null, removed: true })
  );
  return [...live, ...removed];
}

/**
 * How many entries of the save would change the program, against the rows
 * last loaded or saved: a new row with something in it, a removed row, or a
 * row whose number, module, title or rule differs. An empty slot with no row
 * is not a change (the save still sends it, as the editor always saved every
 * slot). 0 means there is nothing to save.
 */
export function pendingChanges(baseline: EditorState, state: EditorState, daysTotal: number): number {
  const before = new Map(baseline.rows.map((r) => [r.id, r]));
  let n = 0;
  for (const e of savePayload(state, daysTotal)) {
    if (e.removed) { n++; continue; }
    if (e.id === null) {
      if (e.course_id !== null || e.mission_title !== null || e.pass_required !== null) n++;
      continue;
    }
    const b = before.get(e.id);
    if (
      !b ||
      b.day_number !== e.day_number ||
      b.course_id !== e.course_id ||
      b.mission_title !== e.mission_title ||
      b.pass_required !== e.pass_required
    ) {
      n++;
    }
  }
  return n;
}

/**
 * Whether a save that did not come back as a confirmed success may still
 * have landed, so the editor keeps Save off until the page is reloaded
 * (P2-N7 rule (1); ADR 0024 P2-8 note, item 10): the editor cannot know the
 * new rows' ids, and a resend would name their numbers again.
 *
 *   - the answer says so (`reload: true`: an unconfirmed save, a read-back
 *     that failed or did not match);
 *   - a 409 (the curriculum changed since the page was loaded);
 *   - a 2xx this page cannot read as a save's answer;
 *   - a 5xx without a readable error (a gateway's or the platform's page, or
 *     a body that is not the route's JSON): the route may have run and saved.
 *
 * Every other refusal (400, 401, 403, 404, and a 5xx the route answered with
 * its own error and no `reload`, such as a failed check before the call or
 * a refusal the database raised) wrote nothing, and Save stays on. A fetch
 * that rejects is the caller's catch, which also keeps Save off.
 */
export function saveMayHaveLanded(status: number, body: { reload?: unknown; error?: unknown }): boolean {
  if (body.reload === true) return true;
  if (status === 409) return true;
  if (status >= 200 && status < 300) return true;
  return status >= 500 && typeof body.error !== "string";
}

/** One "Move instead?" question (R17). */
export type MoveInsteadPair = {
  course_id: string;
  /** The saved day whose module was cleared: its number and id. */
  from: number;
  fromId: string;
  /** The day that now holds the module: its number and its id (null for a new row). */
  to: number;
  toId: string | null;
};

const sameCourse = (a: string | null, b: string | null) =>
  a !== null && b !== null && a.toLowerCase() === b.toLowerCase();

/**
 * The "Move instead?" test (step 92, reading R17), read literally: a saved
 * row X still in the editor whose module was C at the last load or save and
 * is none now, and another row Y whose module is C now and was not C then (or
 * Y is new). Saving them as they are leaves X's identity (and its learners'
 * credits) on the cleared day, and Y is a new day for C, which learners who
 * completed C would meet again. A removed day, a module changed to another
 * one, a move by the buttons and a module that was on both days already ask
 * nothing. Several clears of one module pair with its new days by ascending
 * number.
 */
export function moveInsteadPairs(baseline: EditorState, state: EditorState): MoveInsteadPair[] {
  const before = new Map(baseline.rows.filter((r) => r.id).map((r) => [r.id as string, r]));
  const sorted = [...state.rows].sort(byNumber);
  const cleared = sorted.filter((r) => {
    const b = r.id ? before.get(r.id) : undefined;
    return !!b && b.course_id !== null && r.course_id === null;
  });
  const out: MoveInsteadPair[] = [];
  const used = new Set<number>();
  for (const x of cleared) {
    const c = before.get(x.id as string)!.course_id as string;
    const y = sorted.find((r) => {
      if (r === x || used.has(r.day_number) || !sameCourse(r.course_id, c)) return false;
      const b = r.id ? before.get(r.id) : undefined;
      return !b || !sameCourse(b.course_id, c);
    });
    if (!y) continue;
    used.add(y.day_number);
    out.push({ course_id: c, from: x.day_number, fromId: x.id as string, to: y.day_number, toId: y.id });
  }
  return out;
}

/**
 * "Move instead" accepted: the two days exchange places and the two slots
 * still show what the admin set. X (the cleared day) takes Y's number with
 * Y's module and title, so C's day keeps its id where C now is; Y takes X's
 * number with X's current (cleared) content. Each keeps its own id and rule.
 */
export function applyMoveInstead(state: EditorState, pair: MoveInsteadPair): EditorState {
  const x = state.rows.find((r) => r.day_number === pair.from && r.id === pair.fromId);
  const y = state.rows.find((r) => r.day_number === pair.to && r.id === pair.toId);
  if (!x || !y || x === y) return state;
  const rows = state.rows
    .map((r) => {
      if (r === x) return { ...x, day_number: y.day_number, course_id: y.course_id, mission_title: y.mission_title };
      if (r === y) return { ...y, day_number: x.day_number, course_id: x.course_id, mission_title: x.mission_title };
      return r;
    })
    .sort(byNumber);
  return { ...state, rows };
}
