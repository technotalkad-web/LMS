/**
 * Unit test for ADR 0011 (a forced restart never reports success when the
 * reset failed), steps 4, 5–7, 9 and 11, and the two data-safety rules of
 * its build:
 *
 *   (i)   classifyForceRestart: the genuine zero, full success, a shortfall
 *         the re-read resolves, a row still in progress, a row missing from
 *         the re-read, a failed re-read, a failed selection, an update that
 *         fails after one chunk, an unexpected extra id;
 *   (ii)  forceRestartMessage: every outcome, singular and plural;
 *   (iii) forceRestartOlderVersions on the recording fake: the versions read
 *         excludes the new version; the update is conditional on id,
 *         course_version_id and status = 'in_progress', 150 ids at a time,
 *         and stops at the first failed chunk; the selection pages by keyset,
 *         so a row leaving 'in_progress' between pages skips no other row;
 *         an empty answer at R1, R2, R3 or the update (applied or not) is
 *         that step's failure; a failed read issues no update; `[]` is the
 *         genuine zero;
 *         token expiry and the LRS enqueue get exactly the reset ids; a
 *         client that throws still yields a value;
 *   (iv)  the route answers: the multipart 200/500 shapes, finalizeAnswer;
 *   (v)   RULE 1 (the publish survives): finalizeDirectUpload with a failing
 *         restart read keeps the version ready and its prefix untouched and
 *         answers 500 with published: true;
 *   (vi)  RULE 2 (stale clients): abortDirectUpload refuses a ready row
 *         before the row or storage is touched;
 *   (vii) the browser client never aborts a published version and throws
 *         PublishedButRestartFailedError on that 500;
 *   (viii) the Library's Replace dialog passes that error's restart to
 *         onReplaced, which picks the banner (a source check: the repo has
 *         no React test rig, so the banner itself is not rendered here).
 *
 * No database, no storage, no network: a recording fake stands in for the
 * supabase-js query builder (the failed-uploads.test.ts shape, built on a
 * Proxy so any filter method records), and `fetch` is stubbed for (vii).
 *
 * Run:  npx tsx tests/unit/force-restart.test.ts   (or npm run test:unit)
 */
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import {
  FORCE_RESTART_CHUNK,
  classifyForceRestart,
  forceRestartMessage,
  forceRestartOlderVersions,
  forceRestartReplaceAnswer,
  forceRestartReport,
  type ForceRestartFacts,
  type ForceRestartOutcome,
  type SelectedAttempt,
} from "../../lib/attempts/force-restart";
import {
  abortDirectUpload,
  finalizeAnswer,
  finalizeDirectUpload,
  setDirectUploadTestDoubles,
  type FinalizeResult,
} from "../../lib/courses/direct-upload";
import {
  PublishedButRestartFailedError,
  directUpload,
  unzipPackage,
} from "../../app/[org]/(admin)/library/_components/direct-upload";
import type { StorageAdapter } from "../../lib/storage";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const root = path.resolve(__dirname, "../..");

/* ---------------- recording fake supabase client ---------------- */

type Op = { op: string; args: unknown[] };
type Query = { table: string; ops: Op[] };
type Answer = { data?: unknown; error?: unknown; count?: number | null };
type Responder = (q: Query) => Answer;

function fakeClient(respond: Responder, opts: { throwOnQuery?: number } = {}) {
  const queries: Query[] = [];
  const client = {
    from(table: string) {
      if (opts.throwOnQuery !== undefined && queries.length === opts.throwOnQuery) throw new Error("client exploded");
      const q: Query = { table, ops: [] };
      queries.push(q);
      const settle = () => Promise.resolve().then(() => ({ data: null, error: null, count: null, ...respond(q) }));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const builder: any = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "then") return (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => settle().then(res, rej);
            if (prop === "maybeSingle" || prop === "single") {
              return () => {
                q.ops.push({ op: String(prop), args: [] });
                return settle();
              };
            }
            return (...args: unknown[]) => {
              q.ops.push({ op: String(prop), args });
              return builder;
            };
          },
        }
      );
      return builder;
    },
  };
  return { client: client as never, queries };
}
const has = (q: Query, op: string) => q.ops.some((o) => o.op === op);
const arg = (q: Query, op: string, col?: string) => q.ops.find((o) => o.op === op && (col === undefined || o.args[0] === col))?.args;
const sel = (q: Query) => arg(q, "select")?.[0];
const inList = (q: Query, col: string) => (arg(q, "in", col)?.[1] ?? []) as string[];

/* ---------------- an in-memory course_attempts table ---------------- */

type Row = { id: string; course_version_id: string; status: string };
const NEW = "v-new";
const OLD1 = "v-old-1";
const OLD2 = "v-old-2";
const PKG = "pkg-1";

const LRS_SELECT = "id, organization_id, status, started_at, last_activity_at";

/**
 * Answers the force-restart queries from `rows` as PostgREST would, with
 * hooks to break any one step: `versions` (R1), `selection` (R2),
 * `update` (U, by call index), `reread` (R3), `tokens`.
 */
function attemptsWorld(
  rows: Row[],
  hooks: {
    versions?: Answer;
    selection?: (q: Query) => Answer | undefined;
    update?: (q: Query, n: number) => Answer | undefined;
    beforeUpdate?: (n: number) => void;
    reread?: (q: Query) => Answer | undefined;
    tokens?: Answer;
  } = {}
) {
  let updates = 0;
  return fakeClient((q) => {
    if (q.table === "course_versions" && sel(q) === "id") {
      return hooks.versions ?? { data: [{ id: OLD1 }, { id: NEW }, { id: OLD2 }] };
    }
    if (q.table === "course_attempts" && has(q, "update")) {
      const n = updates++;
      hooks.beforeUpdate?.(n);
      const hooked = hooks.update?.(q, n);
      if (hooked) return hooked;
      const ids = new Set(inList(q, "id"));
      const vers = new Set(inList(q, "course_version_id"));
      const status = arg(q, "eq", "status")?.[1];
      const hit = rows.filter((r) => ids.has(r.id) && vers.has(r.course_version_id) && r.status === status);
      for (const r of hit) r.status = "abandoned";
      return { data: hit.map((r) => ({ id: r.id })) };
    }
    if (q.table === "course_attempts" && sel(q) === "id, course_version_id") {
      const hooked = hooks.selection?.(q);
      if (hooked) return hooked;
      const vers = new Set(inList(q, "course_version_id"));
      const status = arg(q, "eq", "status")?.[1];
      const after = arg(q, "gt", "id")?.[1] as string | undefined;
      const range = arg(q, "range") as [number, number] | undefined;
      const limit = (arg(q, "limit")?.[0] ?? 1000) as number;
      const all = rows
        .filter((r) => vers.has(r.course_version_id) && r.status === status && (after === undefined || r.id > after))
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map((r) => ({ id: r.id, course_version_id: r.course_version_id }));
      // Offsets are answered too, so the test can tell keyset from offset paging.
      return { data: range ? all.slice(range[0], range[1] + 1) : all.slice(0, limit) };
    }
    if (q.table === "course_attempts" && sel(q) === "id, status, course_version_id") {
      const hooked = hooks.reread?.(q);
      if (hooked) return hooked;
      const ids = new Set(inList(q, "id"));
      return { data: rows.filter((r) => ids.has(r.id)).map((r) => ({ ...r })) };
    }
    if (q.table === "cmi5_launch_tokens" && has(q, "update")) return hooks.tokens ?? { data: null };
    // enqueueAbandonedStatements' read: nothing to queue (stops before the LRS config).
    if (q.table === "course_attempts" && sel(q) === LRS_SELECT) return { data: [] };
    return {};
  });
}
const updatesOf = (qs: Query[]) => qs.filter((q) => q.table === "course_attempts" && has(q, "update"));
const attemptQueries = (qs: Query[]) => qs.filter((q) => q.table === "course_attempts");
const ids = (n: number, prefix = "a") => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(4, "0")}`);

/* ---------------- (i) classification ---------------- */

function facts(over: Partial<ForceRestartFacts>): ForceRestartFacts {
  return { selectionError: null, selected: [], updateError: null, restartedIds: [], rereadError: null, reread: null, ...over };
}
const pick = (o: ForceRestartOutcome) => ({
  status: o.status,
  expected: o.expected,
  restarted: o.restarted,
  resolved: o.resolved,
  unresolved: o.unresolved,
  unresolved_version_ids: o.unresolved_version_ids,
});
const sel4: SelectedAttempt[] = [
  { id: "a1", course_version_id: OLD1 },
  { id: "a2", course_version_id: OLD1 },
  { id: "a3", course_version_id: OLD2 },
  { id: "a4", course_version_id: OLD2 },
];

function classification() {
  console.log("\n(i) classifyForceRestart (ADR 0011 step 4)");
  eq("(b) genuine zero: selection read ok, nothing in progress", pick(classifyForceRestart(facts({ selected: [] }))), {
    status: "ok", expected: 0, restarted: 0, resolved: 0, unresolved: 0, unresolved_version_ids: [],
  });
  eq(
    "(c) full success: 3 selected, 3 restarted",
    pick(classifyForceRestart(facts({ selected: sel4.slice(0, 3), restartedIds: ["a3", "a1", "a2"] }))),
    { status: "ok", expected: 3, restarted: 3, resolved: 0, unresolved: 0, unresolved_version_ids: [] }
  );
  eq(
    "(d)(e) 4 selected, 2 restarted, re-read passed + abandoned → ok, resolved 2",
    pick(classifyForceRestart(facts({
      selected: sel4,
      restartedIds: ["a1", "a2"],
      reread: [{ id: "a3", status: "passed", course_version_id: OLD2 }, { id: "a4", status: "abandoned", course_version_id: OLD2 }],
    }))),
    { status: "ok", expected: 4, restarted: 2, resolved: 2, unresolved: 0, unresolved_version_ids: [] }
  );
  eq(
    "(d)(f) 4 selected, 2 restarted, re-read passed + in_progress → failed, that row's version",
    pick(classifyForceRestart(facts({
      selected: sel4,
      restartedIds: ["a1", "a2"],
      reread: [{ id: "a3", status: "passed", course_version_id: OLD2 }, { id: "a4", status: "in_progress", course_version_id: OLD2 }],
    }))),
    { status: "failed", expected: 4, restarted: 2, resolved: 1, unresolved: 1, unresolved_version_ids: [OLD2] }
  );
  eq(
    "(d)(f) a shortfall row missing from the re-read → unresolved (fail-closed)",
    pick(classifyForceRestart(facts({
      selected: sel4,
      restartedIds: ["a1", "a2", "a3"],
      reread: [],
    }))),
    { status: "failed", expected: 4, restarted: 3, resolved: 0, unresolved: 1, unresolved_version_ids: [OLD2] }
  );
  eq(
    "(d)(f) a failed re-read → every shortfall id unresolved",
    pick(classifyForceRestart(facts({ selected: sel4, restartedIds: ["a3"], rereadError: "reread: 57014" }))),
    { status: "failed", expected: 4, restarted: 1, resolved: 0, unresolved: 3, unresolved_version_ids: [OLD1, OLD2] }
  );
  eq(
    "(d)(f) R3 empty answer (reread: null) → every shortfall id unresolved",
    pick(classifyForceRestart(facts({ selected: sel4, restartedIds: ["a1", "a2", "a3"], reread: null }))),
    { status: "failed", expected: 4, restarted: 3, resolved: 0, unresolved: 1, unresolved_version_ids: [OLD2] }
  );
  eq(
    "(a) selection error → failed, expected unknown, version ids unknown",
    pick(classifyForceRestart(facts({ selectionError: "versions: 57014", selected: null }))),
    { status: "failed", expected: null, restarted: 0, resolved: 0, unresolved: 0, unresolved_version_ids: null }
  );
  eq(
    "(a) R1/R2 empty answer (selected: null, no error string) → failed",
    classifyForceRestart(facts({ selected: null })).status,
    "failed"
  );
  {
    const selected = ids(200).map((id, i) => ({ id, course_version_id: i < 100 ? OLD1 : OLD2 }));
    const first = selected.slice(0, FORCE_RESTART_CHUNK).map((r) => r.id);
    const rest = selected.slice(FORCE_RESTART_CHUNK).map((r) => ({ id: r.id, status: "in_progress", course_version_id: r.course_version_id }));
    eq(
      "(f) update error after one chunk → failed, restarted = the first chunk",
      pick(classifyForceRestart(facts({ selected, restartedIds: first, updateError: "update: 57014", reread: rest }))),
      { status: "failed", expected: 200, restarted: 150, resolved: 0, unresolved: 50, unresolved_version_ids: [OLD2] }
    );
    const done = rest.map((r) => ({ ...r, status: "completed" }));
    eq(
      "(f) a failed update is a failure even when the re-read resolves the rest",
      pick(classifyForceRestart(facts({ selected, restartedIds: first, updateError: "update: 57014", reread: done }))),
      { status: "failed", expected: 200, restarted: 150, resolved: 50, unresolved: 0, unresolved_version_ids: [] }
    );
  }
  eq(
    "an unexpected extra restarted id is counted, never an error",
    pick(classifyForceRestart(facts({ selected: sel4.slice(0, 2), restartedIds: ["a1", "a2", "zz"] }))),
    { status: "ok", expected: 2, restarted: 3, resolved: 0, unresolved: 0, unresolved_version_ids: [] }
  );
  eq(
    "every terminal status the 0043 constraint allows resolves",
    classifyForceRestart(facts({
      selected: sel4,
      restartedIds: [],
      reread: (["completed", "passed", "failed", "abandoned"] as const).map((status, i) => ({ id: sel4[i].id, status, course_version_id: sel4[i].course_version_id })),
    })).resolved,
    4
  );
  eq(
    "an unknown status never resolves",
    classifyForceRestart(facts({ selected: sel4.slice(0, 1), reread: [{ id: "a1", status: "weird", course_version_id: OLD1 }] })).status,
    "failed"
  );
}

/* ---------------- (ii) wording ---------------- */

function wording() {
  console.log("\n(ii) forceRestartMessage (ADR 0011 step 9)");
  const base = { resolved: 0, unresolved: 0, unresolved_version_ids: [] as string[] | null };
  eq("ok, nobody", forceRestartMessage({ ...base, status: "ok", expected: 0, restarted: 0 }), "No learners were in progress.");
  eq("ok, one", forceRestartMessage({ ...base, status: "ok", expected: 1, restarted: 1 }), "1 learner reset.");
  eq("ok, many", forceRestartMessage({ ...base, status: "ok", expected: 3, restarted: 3 }), "3 learners reset.");
  eq(
    "ok, some had already finished",
    forceRestartMessage({ ...base, status: "ok", expected: 4, restarted: 2, resolved: 2 }),
    "2 learners reset; 2 had already finished or been reset."
  );
  eq(
    "ok, one reset and one already finished",
    forceRestartMessage({ ...base, status: "ok", expected: 2, restarted: 1, resolved: 1 }),
    "1 learner reset; 1 had already finished or been reset."
  );
  eq(
    "failed, counts known, one version",
    forceRestartMessage({ status: "failed", expected: 4, restarted: 2, resolved: 1, unresolved: 1, unresolved_version_ids: [OLD2] }),
    "The new version is published, but resetting 4 learners failed. Use 'Restart learners on this version' on the older version to retry. 2 were reset, 1 could not be."
  );
  eq(
    "failed, one learner, nothing reset",
    forceRestartMessage({ status: "failed", expected: 1, restarted: 0, resolved: 0, unresolved: 1, unresolved_version_ids: [OLD1] }),
    "The new version is published, but resetting 1 learner failed. Use 'Restart learners on this version' on the older version to retry. 0 were reset, 1 could not be."
  );
  eq(
    "failed, two versions → 'versions', one reset → 'was'",
    forceRestartMessage({ status: "failed", expected: 3, restarted: 1, resolved: 0, unresolved: 2, unresolved_version_ids: [OLD1, OLD2] }),
    "The new version is published, but resetting 3 learners failed. Use 'Restart learners on this version' on the older versions to retry. 1 was reset, 2 could not be."
  );
  eq(
    "failed, selection unreadable",
    forceRestartMessage({ status: "failed", expected: null, restarted: 0, resolved: 0, unresolved: 0, unresolved_version_ids: null }),
    "The new version is published, but the learners in progress could not be read, so none were reset. Use 'Restart learners on this version' on each older version to retry."
  );
  eq(
    "the outcome carries its own message",
    classifyForceRestart(facts({ selected: [] })).message,
    "No learners were in progress."
  );
}

/* ---------------- (iii) the I/O part on the fake ---------------- */

async function io() {
  console.log("\n(iii) forceRestartOlderVersions on the recording fake");
  {
    const rows: Row[] = [
      { id: "a1", course_version_id: OLD1, status: "in_progress" },
      { id: "a2", course_version_id: OLD2, status: "in_progress" },
      { id: "a3", course_version_id: OLD1, status: "passed" },
      { id: "a4", course_version_id: NEW, status: "in_progress" },
    ];
    const { client, queries } = attemptsWorld(rows);
    const r = await forceRestartOlderVersions(client, { packageId: PKG, newVersionId: NEW });
    eq("success: ok, expected 2, restarted 2", pick(r), { status: "ok", expected: 2, restarted: 2, resolved: 0, unresolved: 0, unresolved_version_ids: [] });
    eq("success: message", r.message, "2 learners reset.");
    eq("success: restartedIds (internal only)", r.restartedIds, ["a1", "a2"]);
    eq("success: tokens expired", r.tokensExpired, true);
    const v = queries[0];
    eq("R1: course_versions select(id) eq(package_id)", [v.table, sel(v), arg(v, "eq", "package_id")], ["course_versions", "id", ["package_id", PKG]]);
    const r2 = queries.find((q) => q.table === "course_attempts" && sel(q) === "id, course_version_id")!;
    eq("R2: the versions read excludes the new version", inList(r2, "course_version_id"), [OLD1, OLD2]);
    eq("R2: status = in_progress, ordered by id, first page of 1000 (no cursor, no offset)", [arg(r2, "eq", "status"), arg(r2, "order"), arg(r2, "limit"), has(r2, "gt"), has(r2, "range")], [["status", "in_progress"], ["id"], [1000], false, false]);
    eq("R2: no grant-retake exclusion (no attempt_requests read)", queries.some((q) => q.table === "attempt_requests"), false);
    const u = updatesOf(queries);
    eq("U: one update", u.length, 1);
    eq("U: sets status abandoned only", arg(u[0], "update"), [{ status: "abandoned" }]);
    eq("U: .in(id) = the selected ids", inList(u[0], "id"), ["a1", "a2"]);
    eq("U: .in(course_version_id) = their versions", inList(u[0], "course_version_id"), [OLD1, OLD2]);
    eq("U: .eq(status, in_progress)", arg(u[0], "eq", "status"), ["status", "in_progress"]);
    eq("U: .select(id)", arg(u[0], "select"), ["id"]);
    eq("U: no other filter", u[0].ops.map((o) => o.op), ["update", "in", "in", "eq", "select"]);
    eq("no R3 when nothing fell short", queries.some((q) => sel(q) === "id, status, course_version_id"), false);
    const tok = queries.find((q) => q.table === "cmi5_launch_tokens")!;
    eq("token expiry gets exactly the reset ids", inList(tok, "attempt_id"), ["a1", "a2"]);
    const lrs = queries.find((q) => q.table === "course_attempts" && sel(q) === LRS_SELECT)!;
    eq("the LRS enqueue gets exactly the reset ids", inList(lrs, "id"), ["a1", "a2"]);
    eq("rows: the passed attempt and the new version's attempt untouched", rows.map((x) => x.status), ["abandoned", "abandoned", "passed", "in_progress"]);
    eq("no audit row, no delete, no other table written", queries.filter((q) => has(q, "insert") || has(q, "delete") || has(q, "upsert")).length, 0);
  }
  {
    const { client, queries } = attemptsWorld([], { versions: { data: null, error: null } });
    const r = await forceRestartOlderVersions(client, { packageId: PKG, newVersionId: NEW });
    eq("R1 { data: null, error: null } → failed, expected unknown", pick(r), { status: "failed", expected: null, restarted: 0, resolved: 0, unresolved: 0, unresolved_version_ids: null });
    eq("R1 empty answer → no attempts query at all (no update)", attemptQueries(queries).length, 0);
  }
  {
    const { client, queries } = attemptsWorld([], { versions: { error: { message: "timeout", code: "57014" } } });
    const r = await forceRestartOlderVersions(client, { packageId: PKG, newVersionId: NEW });
    eq("R1 error → failed, no attempts query", [r.status, r.expected, attemptQueries(queries).length], ["failed", null, 0]);
  }
  {
    const { client, queries } = attemptsWorld([], { versions: { data: [{ id: OLD1 }, { id: OLD2 }] } });
    const r = await forceRestartOlderVersions(client, { packageId: PKG, newVersionId: NEW });
    eq("R1 without the new version (wrong/truncated read) → failed, no attempts query", [r.status, r.expected, attemptQueries(queries).length], ["failed", null, 0]);
  }
  {
    const { client, queries } = attemptsWorld([], { versions: { data: [{ id: NEW }] } });
    const r = await forceRestartOlderVersions(client, { packageId: PKG, newVersionId: NEW });
    eq("no older versions → genuine zero, nothing else queried", [pick(r), queries.length], [
      { status: "ok", expected: 0, restarted: 0, resolved: 0, unresolved: 0, unresolved_version_ids: [] }, 1,
    ]);
  }
  {
    const rows: Row[] = [{ id: "a1", course_version_id: OLD1, status: "passed" }];
    const { client, queries } = attemptsWorld(rows);
    const r = await forceRestartOlderVersions(client, { packageId: PKG, newVersionId: NEW });
    eq("selection [] → genuine zero", [r.status, r.expected, r.restarted, r.message], ["ok", 0, 0, "No learners were in progress."]);
    eq("selection [] → no update, no token or LRS query", [updatesOf(queries).length, queries.some((q) => q.table === "cmi5_launch_tokens"), queries.some((q) => sel(q) === LRS_SELECT)], [0, false, false]);
  }
  {
    const { client, queries } = attemptsWorld([], { selection: () => ({ data: null, error: null }) });
    const r = await forceRestartOlderVersions(client, { packageId: PKG, newVersionId: NEW });
    eq("R2 { data: null, error: null } → failed, expected unknown, no update", [r.status, r.expected, updatesOf(queries).length], ["failed", null, 0]);
  }
  {
    const { client, queries } = attemptsWorld([], { selection: () => ({ error: { message: "boom", code: "XX000" } }) });
    const r = await forceRestartOlderVersions(client, { packageId: PKG, newVersionId: NEW });
    eq("R2 error → failed, no update", [r.status, r.expected, updatesOf(queries).length], ["failed", null, 0]);
  }
  {
    // 160 older versions → R2 in two chunks of version ids (150 + 10).
    const older = ids(160, "v");
    const { client, queries } = attemptsWorld([], { versions: { data: [{ id: NEW }, ...older.map((id) => ({ id }))] } });
    await forceRestartOlderVersions(client, { packageId: PKG, newVersionId: NEW });
    const r2 = queries.filter((q) => sel(q) === "id, course_version_id");
    eq("R2: version ids chunked at 150", r2.map((q) => inList(q, "course_version_id").length), [150, 10]);
  }
  {
    // 1005 in progress on one old version: R2 pages at 1000; U runs 7 chunks.
    const rows: Row[] = ids(1005).map((id) => ({ id, course_version_id: OLD1, status: "in_progress" }));
    const { client, queries } = attemptsWorld(rows);
    const r = await forceRestartOlderVersions(client, { packageId: PKG, newVersionId: NEW });
    const r2 = queries.filter((q) => sel(q) === "id, course_version_id");
    eq("R2: two keyset pages, the second after the first page's last id", r2.map((q) => [arg(q, "gt", "id") ?? null, arg(q, "limit"), has(q, "range")]), [
      [null, [1000], false],
      [["id", "a0999"], [1000], false],
    ]);
    const u = updatesOf(queries);
    eq("U: chunks of 150 ids", u.map((q) => inList(q, "id").length), [150, 150, 150, 150, 150, 150, 105]);
    eq("U: every chunk conditional on status = in_progress", u.every((q) => JSON.stringify(arg(q, "eq", "status")) === JSON.stringify(["status", "in_progress"])), true);
    eq("1005 selected, 1005 restarted → ok", [r.status, r.expected, r.restarted], ["ok", 1005, 1005]);
  }
  {
    // A first-page row leaves 'in_progress' between the two page reads. Offset
    // paging would then start page 2 one row too late and never select a1000
    // (expected 1004, a1000 left in progress, run ok); the keyset page cannot.
    const rows: Row[] = ids(1005).map((id) => ({ id, course_version_id: OLD1, status: "in_progress" }));
    let pages = 0;
    const { client } = attemptsWorld(rows, {
      selection: () => {
        if (pages++ === 1) rows[0].status = "passed";
        return undefined;
      },
    });
    const r = await forceRestartOlderVersions(client, { packageId: PKG, newVersionId: NEW });
    eq("a row leaving in_progress between pages: every row still in progress is selected", pick(r), {
      status: "ok", expected: 1005, restarted: 1004, resolved: 1, unresolved: 0, unresolved_version_ids: [],
    });
    eq("…the row after the page boundary is reset, nothing left in progress", [rows[1000].status, rows.filter((x) => x.status === "in_progress").length], ["abandoned", 0]);
  }
  {
    // Update error on the second of three chunks (150 + 150 + 1): stop there;
    // the first chunk is kept and the third is never sent.
    const rows: Row[] = ids(301).map((id) => ({ id, course_version_id: OLD1, status: "in_progress" }));
    const { client, queries } = attemptsWorld(rows, { update: (_q, n) => (n === 1 ? { error: { message: "deadlock", code: "40P01" } } : undefined) });
    const r = await forceRestartOlderVersions(client, { packageId: PKG, newVersionId: NEW });
    eq("update error after one chunk → failed, restarted 150, unresolved 151", pick(r), {
      status: "failed", expected: 301, restarted: 150, resolved: 0, unresolved: 151, unresolved_version_ids: [OLD1],
    });
    eq("…stops at the first error (no third update)", updatesOf(queries).length, 2);
    eq("…the third chunk's row is still in progress", rows[300].status, "in_progress");
    const tok = queries.find((q) => q.table === "cmi5_launch_tokens")!;
    eq("…tokens expired for the 150 that were reset, exactly", inList(tok, "attempt_id"), ids(150));
    const reread = queries.filter((q) => sel(q) === "id, status, course_version_id");
    eq("…R3 re-reads the 151 shortfall ids", reread.map((q) => inList(q, "id").length), [150, 1]);
    eq("…the message", r.message, "The new version is published, but resetting 301 learners failed. Use 'Restart learners on this version' on the older version to retry. 150 were reset, 151 could not be.");
  }
  {
    const rows: Row[] = [{ id: "a1", course_version_id: OLD1, status: "in_progress" }];
    const { client } = attemptsWorld(rows, { update: () => ({ data: null, error: null }) });
    const r = await forceRestartOlderVersions(client, { packageId: PKG, newVersionId: NEW });
    eq("U { data: null, error: null } → update failure → failed", [r.status, r.restarted, r.unresolved], ["failed", 0, 1]);
  }
  {
    // The update commits but answers { data: null, error: null }: the re-read
    // finds the row abandoned, yet the run fails closed (the update's answer
    // is the failure), and nothing is expired or queued for an unconfirmed id.
    const rows: Row[] = [{ id: "a1", course_version_id: OLD1, status: "in_progress" }];
    const { client, queries } = attemptsWorld(rows, {
      update: (q) => {
        for (const x of rows) if (inList(q, "id").includes(x.id)) x.status = "abandoned";
        return { data: null, error: null };
      },
    });
    const r = await forceRestartOlderVersions(client, { packageId: PKG, newVersionId: NEW });
    eq("U applied but answers null → failed, restarted 0, resolved 1, unresolved 0", [r.status, r.restarted, r.resolved, r.unresolved], ["failed", 0, 1, 0]);
    eq("…no token expiry or LRS enqueue for it", [queries.some((q) => q.table === "cmi5_launch_tokens"), queries.some((q) => sel(q) === LRS_SELECT)], [false, false]);
  }
  {
    // A completion lands between the selection and the update: it wins.
    const rows: Row[] = [
      { id: "a1", course_version_id: OLD1, status: "in_progress" },
      { id: "a2", course_version_id: OLD2, status: "in_progress" },
    ];
    const { client } = attemptsWorld(rows, { beforeUpdate: () => { rows[1].status = "passed"; } });
    const r = await forceRestartOlderVersions(client, { packageId: PKG, newVersionId: NEW });
    eq("a completion landing first wins: ok, restarted 1, resolved 1", pick(r), { status: "ok", expected: 2, restarted: 1, resolved: 1, unresolved: 0, unresolved_version_ids: [] });
    eq("…the completion is not overwritten", rows[1].status, "passed");
    eq("…message", r.message, "1 learner reset; 1 had already finished or been reset.");
  }
  {
    const rows: Row[] = [
      { id: "a1", course_version_id: OLD1, status: "in_progress" },
      { id: "a2", course_version_id: OLD2, status: "in_progress" },
    ];
    const { client } = attemptsWorld(rows, {
      update: (q) => {
        // The update answers for a1 only although a2 is still in progress.
        rows[0].status = "abandoned";
        return inList(q, "id").includes("a1") ? { data: [{ id: "a1" }] } : undefined;
      },
    });
    const r = await forceRestartOlderVersions(client, { packageId: PKG, newVersionId: NEW });
    eq("a selected row still in progress after the run → failed", pick(r), { status: "failed", expected: 2, restarted: 1, resolved: 0, unresolved: 1, unresolved_version_ids: [OLD2] });
  }
  {
    const rows: Row[] = [
      { id: "a1", course_version_id: OLD1, status: "in_progress" },
      { id: "a2", course_version_id: OLD2, status: "in_progress" },
    ];
    const { client } = attemptsWorld(rows, {
      update: () => ({ data: [{ id: "a1" }] }),
      reread: () => ({ data: null, error: null }),
    });
    const r = await forceRestartOlderVersions(client, { packageId: PKG, newVersionId: NEW });
    eq("R3 { data: null, error: null } → re-read failure → failed", [r.status, r.unresolved], ["failed", 1]);
  }
  {
    const rows: Row[] = [{ id: "a1", course_version_id: OLD1, status: "in_progress" }];
    const { client } = attemptsWorld(rows, { update: () => ({ data: [{ id: "a1" }, { id: "zz" }] }) });
    const r = await forceRestartOlderVersions(client, { packageId: PKG, newVersionId: NEW });
    eq("an extra id from the update is counted, not an error", [r.status, r.expected, r.restarted], ["ok", 1, 2]);
  }
  {
    const rows: Row[] = [{ id: "a1", course_version_id: OLD1, status: "in_progress" }];
    const { client } = attemptsWorld(rows, { tokens: { error: { message: "tokens down" } } });
    const r = await forceRestartOlderVersions(client, { packageId: PKG, newVersionId: NEW });
    eq("token expiry failure → ok with tokensExpired false (informational)", [r.status, r.restarted, r.tokensExpired], ["ok", 1, false]);
  }
  {
    // The client itself throws on the 2nd query (R2): still a value, never a throw.
    const { client } = fakeClient(() => ({ data: [{ id: NEW }, { id: OLD1 }] }), { throwOnQuery: 1 });
    let threw = false;
    let r: Awaited<ReturnType<typeof forceRestartOlderVersions>> | null = null;
    try {
      r = await forceRestartOlderVersions(client, { packageId: PKG, newVersionId: NEW });
    } catch {
      threw = true;
    }
    eq("a throwing client → resolves failed, never throws", [threw, r?.status, r?.expected], [false, "failed", null]);
  }
  {
    // A responder that rejects (the awaited builder throws) during the update.
    const rows: Row[] = [{ id: "a1", course_version_id: OLD1, status: "in_progress" }];
    const { client } = attemptsWorld(rows, { update: () => { throw new Error("socket hang up"); } });
    const r = await forceRestartOlderVersions(client, { packageId: PKG, newVersionId: NEW });
    eq("a rejecting update → failed (update failure), not a throw", [r.status, r.expected, r.restarted, r.unresolved], ["failed", 1, 0, 1]);
  }
}

/* ---------------- (iv) route answers ---------------- */

function answers() {
  console.log("\n(iv) the route answers (ADR 0011 steps 5–6)");
  const base = { courseId: "c1", packageId: PKG, versionId: NEW, versionNumber: 3 };
  const okRun = { status: "ok" as const, expected: 2, restarted: 2, resolved: 0, unresolved: 0, unresolved_version_ids: [], message: "2 learners reset.", restartedIds: ["a1", "a2"], tokensExpired: true };
  {
    const a = forceRestartReplaceAnswer({ ...base, report: forceRestartReport(okRun) });
    eq("multipart ok: 200, every existing field kept, expected/resolved/message added", a, {
      status: 200,
      body: { ok: true, version_id: NEW, version_number: 3, mode: "force_restart", restarted: 2, expected: 2, resolved: 0, message: "2 learners reset." },
    });
    eq("multipart ok: no attempt ids in the body", JSON.stringify(a.body).includes("a1"), false);
    const t = forceRestartReplaceAnswer({ ...base, report: forceRestartReport({ ...okRun, tokensExpired: false }) });
    eq("multipart ok: tokens_expired: false only when the expiry failed", t.body.tokens_expired, false);
  }
  const failedRun = {
    status: "failed" as const, expected: 4, restarted: 2, resolved: 1, unresolved: 1, unresolved_version_ids: [OLD2],
    message: "The new version is published, but resetting 4 learners failed. Use 'Restart learners on this version' on the older version to retry. 2 were reset, 1 could not be.",
    restartedIds: ["a1", "a2"], tokensExpired: true,
  };
  {
    const a = forceRestartReplaceAnswer({ ...base, report: forceRestartReport(failedRun) });
    eq("multipart failed: 500 with published: true and the retry pointer", a, {
      status: 500,
      body: {
        error: failedRun.message,
        published: true,
        version_id: NEW,
        version_number: 3,
        mode: "force_restart",
        restart: "failed",
        expected: 4,
        restarted: 2,
        resolved: 1,
        unresolved: 1,
        unresolved_version_ids: [OLD2],
        retry: `/api/courses/c1/packages/${PKG}/versions/<versionId>/restart`,
      },
    });
    eq("multipart failed: no attempt ids in the body", /"a[12]"/.test(JSON.stringify(a.body)), false);
    eq("forceRestartReport drops the attempt ids", Object.keys(forceRestartReport(failedRun)).includes("restartedIds"), false);
  }
  {
    const okResult: FinalizeResult = {
      ok: true, courseId: "c1", packageId: PKG, versionId: NEW, versionNumber: 3,
      manifest: { title: "T", type: "scorm12", launchUrl: "index.html" }, fileCount: 2, unitCount: null,
    };
    eq("finalize: grandfather → 200 with the result", finalizeAnswer(okResult), { status: 200, body: okResult });
    const withOk = { ...okResult, restart: forceRestartReport(okRun) };
    eq("finalize: restart ok → 200 with restart", finalizeAnswer(withOk), { status: 200, body: withOk });
    const withFailed = { ...okResult, restart: forceRestartReport(failedRun) };
    const a = finalizeAnswer(withFailed);
    eq("finalize: restart failed → 500", a.status, 500);
    eq("finalize: ok false, published true, error = the restart message, retryable false", [a.body.ok, a.body.published, a.body.error, a.body.retryable], [false, true, failedRun.message, false]);
    eq("finalize: the published version's fields stay", [a.body.versionId, a.body.versionNumber, (a.body.restart as { status: string }).status], [NEW, 3, "failed"]);
    eq("finalize: refusal → its status, { error, retryable }", finalizeAnswer({ ok: false, status: 409, error: "x", retryable: true }), { status: 409, body: { error: "x", retryable: true } });
  }
  {
    // The multipart route: the restart runs after the upload's try/catch
    // closed, so no catch there can turn a restart outcome into "Upload failed".
    const src = fs.readFileSync(path.join(root, "app/api/courses/[courseId]/packages/[packageId]/versions/route.ts"), "utf8");
    const call = src.indexOf("forceRestartOlderVersions(svc");
    const uploadCatch = src.indexOf("} catch (e) {", src.indexOf("result = await uploadCoursePackage("));
    const link = src.indexOf("await linkValidationToVersion(");
    eq("multipart route: one call, after the upload's catch and the validation link", call > uploadCatch && call > link && src.indexOf("forceRestartOlderVersions(svc", call + 1) === -1, true);
    eq("multipart route: no try/catch after the upload's catch", /\btry\s*\{/.test(src.slice(uploadCatch + 1)), false);
  }
}

/* ---------------- (v) RULE 1: the publish survives a failed restart ---------------- */

const PREFIX = `courses/c1/${PKG}/v3/`;

async function fixtureFiles() {
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(root, "tests/bot/fixtures/scorm12.zip")));
  return {
    [`${PREFIX}imsmanifest.xml`]: await zip.file("imsmanifest.xml")!.async("string"),
    [`${PREFIX}index.html`]: await zip.file("index.html")!.async("string"),
  } as Record<string, string>;
}

function fakeStorage(files: Record<string, string>) {
  const deleted: string[] = [];
  const drivers: string[] = [];
  const adapter = {
    async head(k: string) { return files[k] ? { size: files[k].length, contentType: null } : null; },
    async list(p: string) { return Object.keys(files).filter((k) => k.startsWith(p)); },
    async getObject(k: string) { return files[k] ? { body: files[k] } : null; },
    async deletePrefix(p: string) { deleted.push(p); },
    async delete(k: string) { deleted.push(k); },
    async upload() { throw new Error("no uploads in this test"); },
    async getSignedDownloadUrl() { throw new Error("not used"); },
    async getSignedUploadUrl() { throw new Error("not used"); },
  } as unknown as StorageAdapter;
  return { deleted, drivers, storageFor: async (d: string) => { drivers.push(d); return adapter; } };
}

const VERSION_ROW = {
  id: NEW, course_id: "c1", package_id: PKG, version_number: 3, manifest_type: "scorm12", launch_url: "index.html",
  storage_prefix: PREFIX, storage_driver: "supabase", upload_status: "uploading", file_count: 2,
  manifest_data: { title: "QA Bot SCORM 1.2 Course" }, upload_started_at: "2026-10-18T00:00:00Z",
};

/** The whole finalize flow on one fake (caller and service client), with `restart` answering the forced-restart reads. */
function finalizeWorld(restart: Responder) {
  return fakeClient((q) => {
    const s = sel(q);
    if (q.table === "course_versions" && s === "*") return { data: { ...VERSION_ROW } };
    if (q.table === "courses" && s === "id, organization_id, current_version_id") return { data: { id: "c1", organization_id: "org1", current_version_id: OLD1 } };
    if (q.table === "course_versions" && typeof s === "string" && s.includes("courses!course_versions_course_id_fkey")) return { data: [] };
    if (q.table === "course_packages" && s === "id, current_version_id") return { data: { id: PKG, current_version_id: OLD1 } };
    if (q.table === "package_validations" && s === "*") return { data: null };
    if (q.table === "course_versions" && has(q, "update")) return { data: [{ id: NEW }] };
    if (q.table === "courses" && s === "current_version_id") return { data: { current_version_id: OLD1 } };
    if (q.table === "course_versions" && s === "package_id") return { data: { package_id: PKG } };
    if (q.table === "courses" && has(q, "update")) return { data: [{ id: "c1" }] };
    if (q.table === "course_versions" && s === "id") return restart(q);
    if (q.table === "course_attempts") return restart(q);
    if (q.table === "cmi5_launch_tokens") return restart(q);
    if (q.table === "course_versions") return { data: [] }; // same-slot identity read
    return {};
  });
}

function versionWrites(qs: Query[]) {
  return qs.filter((q) => q.table === "course_versions" && has(q, "update")).map((q) => arg(q, "update")?.[0] as Record<string, unknown>);
}

async function ruleOne() {
  console.log("\n(v) RULE 1: finalize publishes, the restart fails, the version stays ready and its files stay");
  const files = await fixtureFiles();
  const cases: Array<[string, Responder]> = [
    ["the restart's versions read fails", (q) => (q.table === "course_versions" ? { error: { message: "timeout", code: "57014" } } : {})],
    ["the restart's versions read answers nothing", (q) => (q.table === "course_versions" ? { data: null, error: null } : {})],
    ["the restart's update fails", (q) => {
      if (q.table === "course_versions") return { data: [{ id: NEW }, { id: OLD1 }] };
      if (q.table === "course_attempts" && has(q, "update")) return { error: { message: "deadlock", code: "40P01" } };
      if (q.table === "course_attempts" && sel(q) === "id, course_version_id") return { data: [{ id: "a1", course_version_id: OLD1 }] };
      if (q.table === "course_attempts" && sel(q) === "id, status, course_version_id") return { data: [{ id: "a1", status: "in_progress", course_version_id: OLD1 }] };
      return {};
    }],
  ];
  for (const [what, restart] of cases) {
    const { client, queries } = finalizeWorld(restart);
    const st = fakeStorage(files);
    setDirectUploadTestDoubles({ svc: client, storageFor: st.storageFor });
    const result = await finalizeDirectUpload({
      supabase: client, org: { id: "org1", slug: "qa", name: "QA" }, userId: "u1", versionId: NEW, notifyUpdate: false, restartMode: "force_restart",
    });
    eq(`${what}: finalize result ok (published)`, [result.ok, result.ok && result.versionId], [true, NEW]);
    eq(`${what}: restart reported failed`, result.ok && result.restart?.status, "failed");
    eq(`${what}: the only version write is the ready flip`, versionWrites(queries).map((w) => w.upload_status), ["ready"]);
    eq(`${what}: no row marked failed, nothing deleted`, queries.some((q) => has(q, "delete")) || versionWrites(queries).some((w) => w.upload_status === "failed"), false);
    eq(`${what}: the package now points at the new version`, queries.some((q) => q.table === "course_packages" && has(q, "update") && (arg(q, "update")?.[0] as { current_version_id?: string }).current_version_id === NEW), true);
    eq(`${what}: the prefix is untouched`, st.deleted, []);
    const a = finalizeAnswer(result);
    eq(`${what}: answer 500 with published: true and ok: false`, [a.status, a.body.published, a.body.ok, a.body.versionId], [500, true, false, NEW]);
    eq(`${what}: the error is the restart's message`, typeof a.body.error === "string" && (a.body.error as string).startsWith("The new version is published, but "), true);
    eq(`${what}: no attempt id in the answer`, JSON.stringify(a.body).includes("\"a1\""), false);
  }
  {
    // Control: the same flow with a working restart answers 200.
    const { client } = finalizeWorld((q) => (q.table === "course_versions" ? { data: [{ id: NEW }, { id: OLD1 }] } : q.table === "course_attempts" ? { data: [] } : {}));
    const st = fakeStorage(files);
    setDirectUploadTestDoubles({ svc: client, storageFor: st.storageFor });
    const result = await finalizeDirectUpload({
      supabase: client, org: { id: "org1", slug: "qa", name: "QA" }, userId: "u1", versionId: NEW, notifyUpdate: false, restartMode: "force_restart",
    });
    const a = finalizeAnswer(result);
    eq("control: nobody in progress → 200, restart ok, genuine zero", [a.status, (a.body.restart as { status: string; expected: number; message: string })], [200, {
      status: "ok", expected: 0, restarted: 0, resolved: 0, unresolved: 0, unresolved_version_ids: [], message: "No learners were in progress.", tokensExpired: true,
    }]);
  }
  {
    const { client, queries } = finalizeWorld(() => ({}));
    const st = fakeStorage(files);
    setDirectUploadTestDoubles({ svc: client, storageFor: st.storageFor });
    const result = await finalizeDirectUpload({
      supabase: client, org: { id: "org1", slug: "qa", name: "QA" }, userId: "u1", versionId: NEW, notifyUpdate: false, restartMode: "grandfather",
    });
    eq("grandfather: no restart field, no attempts query", [result.ok && "restart" in result, queries.some((q) => q.table === "course_attempts")], [false, false]);
  }
}

/* ---------------- (vi) RULE 2: abort refuses a ready row ---------------- */

async function ruleTwo() {
  console.log("\n(vi) RULE 2: abortDirectUpload refuses a ready row before touching it or its files");
  const abortWorld = (status: string, claim: Answer = { data: [{ id: NEW }] }) =>
    fakeClient((q) => {
      if (q.table === "course_versions" && sel(q) === "*") return { data: { ...VERSION_ROW, upload_status: status } };
      if (q.table === "courses") return { data: { id: "c1", organization_id: "org1", current_version_id: NEW } };
      if (q.table === "course_versions" && has(q, "update")) return claim;
      return {};
    });
  {
    const { client, queries } = abortWorld("ready");
    const st = fakeStorage({});
    setDirectUploadTestDoubles({ svc: client, storageFor: st.storageFor });
    const r = await abortDirectUpload({ supabase: client, org: { id: "org1" }, versionId: NEW });
    eq("ready → 409 'This version is ready, not uploading.'", r, { ok: false, status: 409, error: "This version is ready, not uploading." });
    eq("ready → reads only: no update, no delete", queries.filter((q) => has(q, "update") || has(q, "delete")).length, 0);
    eq("ready → storage never opened, prefix untouched", [st.drivers, st.deleted], [[], []]);
  }
  {
    const { client, queries } = abortWorld("uploading");
    const st = fakeStorage({});
    setDirectUploadTestDoubles({ svc: client, storageFor: st.storageFor });
    const r = await abortDirectUpload({ supabase: client, org: { id: "org1" }, versionId: NEW });
    const claim = queries.find((q) => q.table === "course_versions" && has(q, "update"))!;
    eq("uploading → ok; the claim is conditional on uploading/failed", [r.ok, arg(claim, "in", "upload_status")], [true, ["upload_status", ["uploading", "failed"]]]);
    eq("uploading → the prefix is emptied", st.deleted, [PREFIX.replace(/\/$/, "")]);
  }
  {
    const { client } = abortWorld("uploading", { data: [] });
    const st = fakeStorage({});
    setDirectUploadTestDoubles({ svc: client, storageFor: st.storageFor });
    const r = await abortDirectUpload({ supabase: client, org: { id: "org1" }, versionId: NEW });
    eq("claim lost (finalised meanwhile) → 409, prefix untouched", [r.ok, !r.ok && r.status, st.deleted], [false, 409, []]);
  }
  {
    // ADR 0008 D1 (spec 44): a failed row is accepted, so a repeat abort only empties its folder again.
    const { client } = abortWorld("failed");
    const st = fakeStorage({});
    setDirectUploadTestDoubles({ svc: client, storageFor: st.storageFor });
    const r = await abortDirectUpload({ supabase: client, org: { id: "org1" }, versionId: NEW });
    eq("failed → accepted (idempotent, never a published row)", r.ok, true);
  }
}

/* ---------------- (vii) the browser client ---------------- */

async function browser() {
  console.log("\n(vii) directUpload() in the browser: a published version is never aborted");
  const buf = fs.readFileSync(path.join(root, "tests/bot/fixtures/scorm12.zip"));
  const pkg = await unzipPackage(new File([buf], "scorm12.zip", { type: "application/zip" }));
  const failedRestart: ForceRestartOutcome = {
    status: "failed", expected: 1, restarted: 0, resolved: 0, unresolved: 1, unresolved_version_ids: [OLD1],
    message: "The new version is published, but resetting 1 learner failed. Use 'Restart learners on this version' on the older version to retry. 0 were reset, 1 could not be.",
  };
  const run = async (finalize: { status: number; body: Record<string, unknown> }) => {
    const calls: string[] = [];
    const phases: string[] = [];
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url === "/api/courses/upload/init") return json(200, { courseId: "c1", packageId: PKG, versionId: NEW, versionNumber: 3, signBatch: 40, fileCount: 2 });
      if (url === "/api/courses/upload/sign") {
        const files = (JSON.parse(String(init?.body)) as { files: Array<{ path: string }> }).files;
        return json(200, { uploads: files.map((f) => ({ path: f.path, key: PREFIX + f.path, url: `https://storage.test/${f.path}`, method: "PUT", headers: {} })) });
      }
      if (url.startsWith("https://storage.test/")) return new Response(null, { status: 200 });
      if (url === "/api/courses/upload/finalize") return json(finalize.status, finalize.body);
      if (url === "/api/courses/upload/abort") return json(200, { ok: true });
      return json(404, {});
    }) as typeof fetch;
    let error: unknown = null;
    let result: unknown = null;
    try {
      result = await directUpload({
        pkg,
        target: { orgSlug: "qa", courseId: "c1", packageId: PKG, mode: "force_restart" },
        validationId: "val1",
        acknowledge: true,
        onProgress: (p) => phases.push(p.phase),
      });
    } catch (e) {
      error = e;
    } finally {
      globalThis.fetch = realFetch;
    }
    return { calls, phases, error, result };
  };
  const published = { ok: false, published: true, courseId: "c1", packageId: PKG, versionId: NEW, versionNumber: 3, error: failedRestart.message, retryable: false, restart: { ...failedRestart, tokensExpired: true } };
  {
    const r = await run({ status: 500, body: published });
    eq("500 published: true → no abort call", r.calls.includes("/api/courses/upload/abort"), false);
    eq("…throws PublishedButRestartFailedError", r.error instanceof PublishedButRestartFailedError, true);
    const e = r.error as PublishedButRestartFailedError;
    eq("…carrying the failed restart and the published version", [e.restart?.status, e.restart?.expected, e.result?.versionId, e.message], ["failed", 1, NEW, failedRestart.message]);
    eq("…progress never reaches done", r.phases.includes("done"), false);
  }
  {
    const r = await run({ status: 500, body: { ...published, restart: undefined } });
    const e = r.error as PublishedButRestartFailedError;
    eq("500 published: true without a restart body → still a failed outcome (never silent)", [e instanceof PublishedButRestartFailedError, e.restart?.status, e.restart?.message], [true, "failed", failedRestart.message]);
  }
  {
    const r = await run({ status: 500, body: { error: "Could not finalise: boom", retryable: false } });
    eq("500 without published → aborted as before, plain Error", [r.calls.includes("/api/courses/upload/abort"), r.error instanceof PublishedButRestartFailedError, (r.error as Error)?.message], [true, false, "Could not finalise: boom"]);
  }
  {
    const r = await run({ status: 409, body: { error: "files missing", retryable: true } });
    eq("409 → not aborted, plain Error (unchanged)", [r.calls.includes("/api/courses/upload/abort"), r.error instanceof PublishedButRestartFailedError], [false, false]);
  }
  {
    const okRestart = { status: "ok", expected: 0, restarted: 0, resolved: 0, unresolved: 0, unresolved_version_ids: [], message: "No learners were in progress.", tokensExpired: true };
    const r = await run({ status: 200, body: { ok: true, courseId: "c1", packageId: PKG, versionId: NEW, versionNumber: 3, restart: okRestart } });
    eq("200 → the result with its restart, progress done, no abort", [(r.result as { restart?: { message: string } })?.restart?.message, r.phases.at(-1), r.calls.includes("/api/courses/upload/abort")], ["No learners were in progress.", "done", false]);
  }
}

/* ---------------- (viii) the Library wiring (source check) ---------------- */

function library() {
  console.log("\n(viii) the Library's Replace dialog: the published-but-failed path (source check; no React rig)");
  const src = fs.readFileSync(path.join(root, "app/[org]/(admin)/library/[courseId]/languages-section.tsx"), "utf8");
  const at = src.indexOf("if (err instanceof PublishedButRestartFailedError) {");
  const own = at === -1 ? -1 : src.indexOf("setError(err instanceof Error", at);
  const block = own === -1 ? "" : src.slice(at, own);
  eq("doUpload: the published-but-failed catch hands err.restart to onReplaced and returns before the dialog's own setError", /onReplaced\(\{ restart: err\.restart \}\);\s*return;\s*\}\s*$/.test(block), true);
  const h = src.indexOf("onReplaced={(outcome) => {");
  const handler = h === -1 ? "" : src.slice(h, src.indexOf("/>", h));
  const refresh = handler.indexOf("router.refresh();");
  const grand = handler.indexOf("if (!r) {");
  const failed = handler.indexOf('} else if (r.status === "failed") {');
  const okBranch = handler.indexOf("} else {", failed);
  eq("onReplaced: refreshes before choosing a banner", refresh !== -1 && refresh < grand, true);
  eq("onReplaced: grandfather clears both banners", /setError\(null\);[\s\S]*setNotice\(null\);/.test(handler.slice(grand, failed)), true);
  eq("onReplaced: failed → the red error banner with the restart message", handler.slice(failed, okBranch).includes("setError(r.message);"), true);
  eq("onReplaced: ok → the replace-result notice", handler.slice(okBranch).includes("setNotice(`Replaced. ${r.message}`);"), true);
  eq("the notice renders as data-testid=replace-result", src.includes('data-testid="replace-result"'), true);
}

async function main() {
  // The direct-upload test doubles are honoured only under NODE_ENV=test.
  (process.env as Record<string, string>).NODE_ENV = "test";
  classification();
  wording();
  await io();
  answers();
  await ruleOne();
  await ruleTwo();
  await browser();
  library();
  setDirectUploadTestDoubles({ svc: null, storageFor: null });
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
