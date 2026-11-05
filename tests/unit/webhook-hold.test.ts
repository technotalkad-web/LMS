/**
 * Unit test for ADR 0015 steps 2, 5 and 6 (lib/integrations/webhook-hold.ts):
 *   (i)   decideCompletionWebhook, every row of step 9 (i), the order of its
 *         rules, and normalizeSuccess;
 *   (ii)  sweepHeldWebhooks against a recording fake: the filters of the
 *         shared selection (each exclusion asserted by name on the recorded
 *         filter, since the fake does not evaluate predicates), the paging on
 *         small opts, the caps, and what each row's outcome lists;
 *   (iii) heldWebhookSummary and heldWebhookItem, the registry defaults of
 *         "held-webhooks", its dispatch line in collect.ts (a source check), and
 *         heldWebhookItems through the exported collectAttention on the fake,
 *         with the real classifyAttempt (step 9 (iii)), and classifyAttempt
 *         itself with its versions read failing;
 *   (iv)  WEBHOOK_HOLD_SWEEP_FROM's format, and that it is not in the future;
 *   (v)   the caps never exceed ADR 0015's ceilings.
 * No DB: the recording fake of failed-uploads.test.ts (with `or` and `gte`
 * recorded too) stands in for supabase-js; fire and classify are injected.
 * The budget rule itself is asserted where the per-row costs are measured,
 * under the fetch stub of webhook-hold-route.test.ts.
 *
 * Run:  npx tsx tests/unit/webhook-hold.test.ts   (or npm run test:unit)
 */
import fs from "node:fs";
import path from "node:path";
import {
  HELD_MAX_COUNT,
  HELD_MAX_SCANNED,
  HELD_PAGE_SIZE,
  SWEEP_MAX_FIRES,
  SWEEP_MAX_SCANNED,
  WEBHOOK_HOLD_SWEEP_FROM,
  decideCompletionWebhook,
  heldWebhookItem,
  heldWebhookPage,
  heldWebhookSummary,
  normalizeSuccess,
  sweepHeldWebhooks,
  type HoldInput,
  type HoldSuccess,
  type SweepDeps,
} from "../../lib/integrations/webhook-hold";
import { collectAttention } from "../../lib/attention/collect";
import { classifyAttempt } from "../../lib/scoring/attempt-kind";
import { ATTENTION_PROVIDERS, effectiveConfig } from "../../lib/attention/types";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

/* ---------------- fake supabase client ---------------- */

type Op = { op: string; args: unknown[] };
type Query = { table: string; ops: Op[] };
type Responder = (q: Query) => { data?: unknown; error?: unknown; count?: number | null };

function fakeClient(respond: Responder) {
  const queries: Query[] = [];
  const client = {
    from(table: string) {
      const q: Query = { table, ops: [] };
      queries.push(q);
      const b: Record<string, unknown> = {};
      for (const op of ["select", "update", "insert", "delete", "eq", "neq", "in", "lt", "gt", "gte", "is", "not", "or", "order", "limit", "range"]) {
        b[op] = (...args: unknown[]) => {
          q.ops.push({ op, args });
          return b;
        };
      }
      const settle = () => Promise.resolve({ data: null, error: null, count: null, ...respond(q) });
      b.maybeSingle = () => settle();
      b.single = () => settle();
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => settle().then(res, rej);
      return b;
    },
    rpc: () => Promise.resolve({ data: [], error: null }),
  };
  return { client: client as never, queries };
}
const arg = (q: Query | undefined, op: string, col?: string) => q?.ops.find((o) => o.op === op && (col === undefined || o.args[0] === col))?.args;
const all = (q: Query | undefined, op: string) => (q?.ops ?? []).filter((o) => o.op === op).map((o) => o.args);

type Row = { id: string; completed_at: string };
/** Serves `rows` in order, as many per select as its recorded limit asks for (the fake does not evaluate filters). */
function pagedResponder(rows: Row[]): Responder {
  let pos = 0;
  return (q) => {
    const limit = Number(arg(q, "limit")?.[0] ?? rows.length);
    const page = rows.slice(pos, pos + limit);
    pos += page.length;
    return { data: page.map((r) => ({ ...r, course_versions: { manifest_type: "cmi5" } })) };
  };
}
const row = (id: string, completed_at: string): Row => ({ id, completed_at });

type Kind = { official: boolean; attemptNumber: number | null } | null | "throw";
/** Injected classify and fire that record their calls. */
function recordingDeps(kinds: Record<string, Kind>, fireAnswer: (id: string, call: number) => boolean | "throw" = () => true) {
  const classified: string[] = [];
  const fires: Array<[string, number | null]> = [];
  const deps: SweepDeps = {
    classify: async (_svc, id) => {
      classified.push(id);
      const k = kinds[id] ?? null;
      if (k === "throw") throw new Error("classify failed");
      return k;
    },
    fire: async (id, n) => {
      fires.push([id, n]);
      const a = fireAnswer(id, fires.length);
      if (a === "throw") throw new Error("fire failed");
      return a;
    },
    now: () => NOW,
  };
  return { deps, classified, fires };
}

/** Runs `fn` with console.warn captured. */
async function captureWarn<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const orig = console.warn;
  const lines: string[] = [];
  console.warn = (...a: unknown[]) => { lines.push(a.map((x) => (typeof x === "string" ? x : String(x))).join(" ")); };
  try {
    return { value: await fn(), lines };
  } finally {
    console.warn = orig;
  }
}
const sweepLines = (lines: string[]) =>
  lines.flatMap((l) => { try { const o = JSON.parse(l); return o?.event === "webhook_sweep" ? [o] : []; } catch { return []; } });

const NOW = new Date("2026-11-04T12:00:00.000Z");
const SWEEP_LT = "2026-11-04T11:45:00.000Z"; // NOW − 15 minutes
const PROVIDER_LT = "2026-11-03T12:00:00.000Z"; // NOW − 24 hours
const COMPLETENESS_OR = "completion_status.eq.completed,success_status.eq.passed";
const keysetOr = (r: Row) => `completed_at.lt."${r.completed_at}",and(completed_at.eq."${r.completed_at}",id.lt."${r.id}")`;
const OFFICIAL = (n: number | null = 1): Kind => ({ official: true, attemptNumber: n });
const NOT_OFFICIAL: Kind = { official: false, attemptNumber: null };
const BIG = { pageSize: 10, maxFires: 10, maxScanned: 10 };

async function main() {
  /* ---------------- (i) decideCompletionWebhook ---------------- */
  console.log("\n(i) decideCompletionWebhook (ADR 0015 step 2; every row of step 9 (i))");
  {
    const TS = "2026-10-29T10:00:00.000Z";
    const d = (
      before: [boolean, HoldSuccess, string | null | undefined],
      after: [boolean, HoldSuccess],
      batch: [boolean, boolean],
      official = true
    ) => {
      const input: HoldInput = {
        official,
        before: { complete: before[0], successStatus: before[1], webhookAt: before[2] },
        after: { complete: after[0], successStatus: after[1] },
        batch: { completingStatementCarriedSuccess: batch[0], terminated: batch[1] },
      };
      return decideCompletionWebhook(input);
    };
    eq("a two-element array (completed + passed) → fire", d([false, null, null], [true, "passed"], [true, false]), "fire");
    eq("a lone completed → hold", d([false, null, null], [true, null], [false, false]), "hold");
    eq("a later passed in its own request → fire", d([true, null, null], [true, "passed"], [true, false]), "fire");
    eq("a lone completed + terminated in the same batch, webhookAt null → fire", d([false, null, null], [true, null], [false, true]), "fire");
    eq("a second terminated in a later request, webhookAt set → none", d([true, null, TS], [true, null], [false, true]), "none");
    eq("webhookAt undefined (column unreadable) with a terminated → hold (the branch stays inert)", d([false, null, undefined], [true, null], [false, true]), "hold");
    eq("webhookAt undefined with a passed → fire", d([false, null, undefined], [true, "passed"], [true, false]), "fire");
    eq("failed then passed with webhookAt set → refire", d([true, "failed", TS], [true, "passed"], [true, false]), "refire");
    eq("a result-less first message (before {true, null, ts}) then passed → refire", d([true, null, TS], [true, "passed"], [true, false]), "refire");
    eq("failed with webhookAt set, then a later failed → none", d([true, "failed", TS], [true, "failed"], [true, false]), "none");
    eq("failed then passed with webhookAt null → fire (no re-fire needed)", d([true, "failed", null], [true, "passed"], [true, false]), "fire");
    eq("not official → none", d([false, null, null], [true, "passed"], [true, false], false), "none");
    eq("an in_progress row with a terminated and no AU completed (after.complete false) → none", d([false, null, null], [false, null], [false, true]), "none");
    eq("a plain-xAPI course-level passed with result.completion true → fire", d([false, null, null], [true, "passed"], [true, false]), "fire");
    eq("the completing statement carried a result and the pass/fail did not change → fire (that trigger alone)", d([false, "failed", null], [true, "failed"], [true, false]), "fire");
    eq("the same result on a row already complete before the request → hold", d([true, "failed", null], [true, "failed"], [true, false]), "hold");
    eq("a third request repeating passed on a latched row → none (it became passed once)", d([true, "passed", TS], [true, "passed"], [true, false]), "none");
    eq("passed on a row latched while not complete before the request → none, never refire", d([false, null, TS], [true, "passed"], [true, false]), "none");
    eq("a known result read before and no result read after, latch null → hold, never fire", d([true, "failed", null], [true, null], [false, false]), "hold");
    eq("passed on both reads of a complete row, latch null → hold", d([true, "passed", null], [true, "passed"], [false, false]), "hold");
    eq("(b) before (b′): a re-fire input has webhookAt set and still answers refire, not none", d([true, null, TS], [true, "passed"], [false, false]), "refire");
    eq("(b′) before (c): a latched row with a new failed answers none, never fire", d([true, null, TS], [true, "failed"], [true, false]), "none");
    eq("normalizeSuccess('unknown') → null", normalizeSuccess("unknown"), null);
    eq("normalizeSuccess('passed') → passed", normalizeSuccess("passed"), "passed");
    eq("normalizeSuccess('failed') → failed", normalizeSuccess("failed"), "failed");
    eq("normalizeSuccess(undefined) → null", normalizeSuccess(undefined), null);
  }

  /* ---------------- (ii) sweepHeldWebhooks ---------------- */
  console.log("\n(ii) sweepHeldWebhooks (ADR 0015 step 5) against the recording fake");
  {
    // The default call: no opts, the exported caps apply.
    const { client, queries } = fakeClient(pagedResponder([]));
    const { deps, classified, fires } = recordingDeps({});
    const { value: res } = await captureWarn(() => sweepHeldWebhooks(client, deps));
    const q = queries[0];
    eq("default call: one select, on course_attempts", queries.map((x) => x.table), ["course_attempts"]);
    eq("default call: selects id and completed_at with the !inner course_versions embed", arg(q, "select"), ["id, completed_at, course_versions!inner(manifest_type)"]);
    eq("default call: the latch-null filter (is completion_webhook_at null)", arg(q, "is", "completion_webhook_at"), ["completion_webhook_at", null]);
    eq("a SCORM row is excluded: the type bound (in course_versions.manifest_type [cmi5, xapi])", arg(q, "in", "course_versions.manifest_type"), ["course_versions.manifest_type", ["cmi5", "xapi"]]);
    eq("default call: the completeness or, and no other or", all(q, "or"), [[COMPLETENESS_OR]]);
    eq("default call: neq status abandoned", arg(q, "neq", "status"), ["status", "abandoned"]);
    eq("a row younger than 15 minutes is excluded: lt completed_at now − 15 minutes", arg(q, "lt", "completed_at"), ["completed_at", SWEEP_LT]);
    eq("a row completed before the start date is excluded: gte completed_at WEBHOOK_HOLD_SWEEP_FROM", arg(q, "gte", "completed_at"), ["completed_at", WEBHOOK_HOLD_SWEEP_FROM]);
    eq("default call: order completed_at desc, id desc", all(q, "order"), [["completed_at", { ascending: false }], ["id", { ascending: false }]]);
    eq("default call: limit min(HELD_PAGE_SIZE, SWEEP_MAX_SCANNED)", arg(q, "limit"), [Math.min(HELD_PAGE_SIZE, SWEEP_MAX_SCANNED)]);
    eq("default call: no organisation restriction", arg(q, "eq", "organization_id"), undefined);
    eq("default call on an empty window: nothing classified or fired", [classified.length, fires.length], [0, 0]);
    eq("default call on an empty window: the result", res, { scanned: 0, fired: [], skipped: [], unfired: [] });
  }
  {
    // Paging: two rows, then a short page of one.
    const r1 = row("a1", "2026-11-04T11:30:00.000Z"), r2 = row("a2", "2026-11-04T11:20:00.000Z"), r3 = row("a3", "2026-11-04T11:10:00.000Z");
    const { client, queries } = fakeClient(pagedResponder([r1, r2, r3]));
    const { deps } = recordingDeps({ a1: NOT_OFFICIAL, a2: NOT_OFFICIAL, a3: NOT_OFFICIAL });
    const { value: res } = await captureWarn(() => sweepHeldWebhooks(client, deps, { pageSize: 2, maxFires: 10, maxScanned: 10 }));
    eq("{pageSize 2}: two rows then one → two selects, no third after the short page", queries.length, 2);
    eq("{pageSize 2}: the first select carries the completeness or only", all(queries[0], "or"), [[COMPLETENESS_OR]]);
    eq("{pageSize 2}: the second select carries the keyset or with page 1's last row (completed_at and id, lt)", all(queries[1], "or"), [[COMPLETENESS_OR], [keysetOr(r2)]]);
    eq("{pageSize 2}: each select asks for 2", [arg(queries[0], "limit"), arg(queries[1], "limit")], [[2], [2]]);
    eq("{pageSize 2}: the second select keeps the 15-minute lt and the start-date gte",
      [arg(queries[1], "lt", "completed_at"), arg(queries[1], "gte", "completed_at")],
      [["completed_at", SWEEP_LT], ["completed_at", WEBHOOK_HOLD_SWEEP_FROM]]);
    eq("{pageSize 2}: the second select keeps the latch-null, type and abandoned filters",
      [arg(queries[1], "is", "completion_webhook_at"), arg(queries[1], "in", "course_versions.manifest_type"), arg(queries[1], "neq", "status")],
      [["completion_webhook_at", null], ["course_versions.manifest_type", ["cmi5", "xapi"]], ["status", "abandoned"]]);
    eq("{pageSize 2}: every row scanned and skipped", [res.scanned, res.skipped], [3, ["a1", "a2", "a3"]]);
  }
  {
    // No opts: the exported caps bound the scan and the fire calls, whatever their values.
    const many = Array.from({ length: SWEEP_MAX_SCANNED + SWEEP_MAX_FIRES + 5 }, (_, i) => row(`m${i}`, "2026-11-04T10:00:00.000Z"));
    const skipped = fakeClient(pagedResponder(many));
    const s = recordingDeps({});
    const { value: scan } = await captureWarn(() => sweepHeldWebhooks(skipped.client, s.deps));
    eq("no opts, non-official rows: exactly SWEEP_MAX_SCANNED rows scanned", scan.scanned, SWEEP_MAX_SCANNED);
    eq("no opts, non-official rows: ceil(SWEEP_MAX_SCANNED / HELD_PAGE_SIZE) selects", skipped.queries.length, Math.ceil(SWEEP_MAX_SCANNED / HELD_PAGE_SIZE));
    const official = fakeClient(pagedResponder(many));
    const o = recordingDeps(Object.fromEntries(many.map((r) => [r.id, OFFICIAL(1)])));
    await captureWarn(() => sweepHeldWebhooks(official.client, o.deps));
    eq("no opts, official rows: min(SWEEP_MAX_FIRES, SWEEP_MAX_SCANNED) fire calls", o.fires.length, Math.min(SWEEP_MAX_FIRES, SWEEP_MAX_SCANNED));
  }
  {
    // Each request asks for min(pageSize, remaining scan).
    const rows = ["b1", "b2", "b3", "b4", "b5", "b6", "b7"].map((id, i) => row(id, `2026-11-04T10:0${i}:00.000Z`));
    const { client, queries } = fakeClient(pagedResponder(rows));
    const { deps } = recordingDeps({});
    await captureWarn(() => sweepHeldWebhooks(client, deps, { pageSize: 4, maxFires: 10, maxScanned: 6 }));
    eq("{pageSize 4, maxScanned 6}: the second select carries limit 2", arg(queries[1], "limit"), [2]);
    eq("{pageSize 4, maxScanned 6}: no third select once 6 rows are scanned", queries.length, 2);
  }
  {
    // maxFires bounds fire calls, fired plus unfired.
    const rows = ["c1", "c2", "c3", "c4", "c5", "c6"].map((id, i) => row(id, `2026-11-04T10:0${9 - i}:00.000Z`));
    const kinds = Object.fromEntries(rows.map((r) => [r.id, OFFICIAL(1)]));
    const { client, queries } = fakeClient(pagedResponder(rows));
    const { deps, fires, classified } = recordingDeps(kinds, (_id, call) => call !== 2);
    const { value: res } = await captureWarn(() => sweepHeldWebhooks(client, deps, { pageSize: 2, maxFires: 3, maxScanned: 10 }));
    eq("{maxFires 3}: exactly 3 fire calls, the second answering false", fires.map(([id]) => id), ["c1", "c2", "c3"]);
    eq("{maxFires 3}: fired lists the first and third ids, in order", res.fired, ["c1", "c3"]);
    eq("{maxFires 3}: unfired lists the second", res.unfired, ["c2"]);
    eq("{maxFires 3}: no select after the page that reached the cap", queries.length, 2);
    eq("{maxFires 3}: the row after the cap is not classified", classified, ["c1", "c2", "c3"]);
  }
  {
    // maxScanned bounds the rows scanned.
    const rows = ["d1", "d2", "d3", "d4", "d5", "d6"].map((id, i) => row(id, `2026-11-04T10:0${9 - i}:00.000Z`));
    const { client, queries } = fakeClient(pagedResponder(rows));
    const { deps, fires } = recordingDeps({});
    const { value: res } = await captureWarn(() => sweepHeldWebhooks(client, deps, { pageSize: 2, maxFires: 10, maxScanned: 4 }));
    eq("{maxScanned 4}: pages of non-official rows → two selects and no third", queries.length, 2);
    eq("{maxScanned 4}: 4 rows scanned and skipped, none fired", [res.scanned, res.skipped.length, fires.length], [4, 4, 0]);
  }
  {
    // Newest first, below the cap: skipped rows newer than a held official row do not hide it.
    const n1 = row("n1", "2026-11-04T11:40:00.000Z"), n2 = row("n2", "2026-11-04T11:35:00.000Z"), h = row("h1", "2026-11-04T09:00:00.000Z");
    const { client } = fakeClient(pagedResponder([n1, n2, h]));
    const { deps } = recordingDeps({ n1: NOT_OFFICIAL, n2: NOT_OFFICIAL, h1: OFFICIAL(1) });
    const { value: res } = await captureWarn(() => sweepHeldWebhooks(client, deps, { pageSize: 2, maxFires: 10, maxScanned: 10 }));
    eq("page 1 all skipped, page 2 holds the official row → it is fired", [res.skipped, res.fired], [["n1", "n2"], ["h1"]]);
  }
  {
    // A held cmi5 row older than 15 minutes is fired with its attemptNumber.
    const { client } = fakeClient(pagedResponder([row("e1", "2026-11-04T11:00:00.000Z")]));
    const { deps, fires } = recordingDeps({ e1: OFFICIAL(1) });
    const { value: res, lines } = await captureWarn(() => sweepHeldWebhooks(client, deps, BIG));
    eq("a held official row is fired with its attemptNumber", fires, [["e1", 1]]);
    eq("…and listed in fired", res.fired, ["e1"]);
    eq("one webhook_sweep log line per run, ids and counts only", sweepLines(lines), [{ event: "webhook_sweep", scanned: 1, fired: ["e1"], skipped: [], unfired: [] }]);
  }
  {
    // A non-official row and a null classification are skipped and logged.
    const { client } = fakeClient(pagedResponder([row("f1", "2026-11-04T11:00:00.000Z"), row("f2", "2026-11-04T10:00:00.000Z")]));
    const { deps, fires } = recordingDeps({ f1: NOT_OFFICIAL, f2: null });
    const { value: res, lines } = await captureWarn(() => sweepHeldWebhooks(client, deps, BIG));
    eq("a non-official row and a null classification are skipped, nothing fired", [res.skipped, fires.length], [["f1", "f2"], 0]);
    eq("…both ids are in the log line's skipped", sweepLines(lines).map((l) => l.skipped), [["f1", "f2"]]);
  }
  {
    // Official with no attempt number: classifyAttempt's list read failed. Skipped, retried next run; the next row still fires.
    const { client } = fakeClient(pagedResponder([row("y1", "2026-11-04T11:00:00.000Z"), row("y2", "2026-11-04T10:00:00.000Z")]));
    const { deps, fires } = recordingDeps({ y1: OFFICIAL(null), y2: OFFICIAL(2) });
    const { value: res } = await captureWarn(() => sweepHeldWebhooks(client, deps, BIG));
    eq("official with no attempt number is skipped, the next row fired", [res.skipped, res.fired, fires], [["y1"], ["y2"], [["y2", 2]]]);
  }
  {
    // A skipped row spends no fire call, at the caps' own maxFires.
    const { client } = fakeClient(pagedResponder([row("x1", "2026-11-04T11:00:00.000Z"), row("x2", "2026-11-04T10:30:00.000Z"), row("x3", "2026-11-04T10:00:00.000Z")]));
    const { deps, fires } = recordingDeps({ x1: OFFICIAL(null), x2: OFFICIAL(1), x3: OFFICIAL(2) });
    const { value: res } = await captureWarn(() => sweepHeldWebhooks(client, deps, { pageSize: 10, maxFires: 2, maxScanned: 3 }));
    eq("official with no number spends no fire call", [res.skipped, fires.length], [["x1"], 2]);
  }
  {
    // fire answering false → unfired; fire throwing → unfired and the next row still fired.
    const { client } = fakeClient(pagedResponder([row("g1", "2026-11-04T11:00:00.000Z"), row("g2", "2026-11-04T10:50:00.000Z"), row("g3", "2026-11-04T10:40:00.000Z")]));
    const { deps } = recordingDeps({ g1: OFFICIAL(1), g2: OFFICIAL(2), g3: OFFICIAL(1) }, (id) => (id === "g1" ? false : id === "g2" ? "throw" : true));
    const { value: res } = await captureWarn(() => sweepHeldWebhooks(client, deps, BIG));
    eq("a fire answering false puts the id in unfired, not in fired", [res.unfired.includes("g1"), res.fired.includes("g1")], [true, false]);
    eq("a fire throwing puts the id in unfired and the next row is fired", [res.unfired, res.fired], [["g1", "g2"], ["g3"]]);
  }
  {
    // A classify that throws on one row skips it (retried next run); the next row is still fired.
    const { client } = fakeClient(pagedResponder([row("k1", "2026-11-04T11:00:00.000Z"), row("k2", "2026-11-04T10:00:00.000Z")]));
    const { deps } = recordingDeps({ k1: "throw", k2: OFFICIAL(1) });
    const { value: res } = await captureWarn(() => sweepHeldWebhooks(client, deps, BIG));
    eq("a classify that throws skips that row and the next row is fired", [res.skipped, res.fired], [["k1"], ["k2"]]);
  }
  {
    // A select error reports and fires nothing (a database without 0082 errors the select).
    const { client, queries } = fakeClient(() => ({ error: { code: "42703", message: "column course_attempts.completion_webhook_at does not exist" } }));
    const { deps, fires, classified } = recordingDeps({});
    const { value: res, lines } = await captureWarn(() => sweepHeldWebhooks(client, deps, BIG));
    eq("a select error is reported in error", res.error, "column course_attempts.completion_webhook_at does not exist");
    eq("…nothing classified or fired, one select", [classified.length, fires.length, queries.length], [0, 0, 1]);
    eq("…and the run still logs its line", sweepLines(lines).length, 1);
  }
  {
    // A select error on a later page stops the run: what was fired stays listed, nothing more is fired.
    let selects = 0;
    const page1 = [row("r1", "2026-11-04T11:00:00.000Z"), row("r2", "2026-11-04T10:00:00.000Z")];
    const { client, queries } = fakeClient(() => {
      selects++;
      return selects === 1 ? { data: page1 } : { error: { message: "page 2 failed" } };
    });
    const { deps, fires } = recordingDeps({ r1: OFFICIAL(1), r2: OFFICIAL(1) });
    const { value: res } = await captureWarn(() => sweepHeldWebhooks(client, deps, { pageSize: 2, maxFires: 10, maxScanned: 10 }));
    eq("a select error on page 2 sets error", res.error, "page 2 failed");
    eq("…page 1's fires stay listed and nothing more is fired", [res.fired, fires.length, queries.length], [["r1", "r2"], 2, 2]);
  }
  {
    // heldWebhookPage itself: its defaults, the probe's fromIso, and a client that throws.
    const { client, queries } = fakeClient(pagedResponder([]));
    const page = await heldWebhookPage(client, { olderThanIso: SWEEP_LT });
    eq("heldWebhookPage: limit defaults to HELD_PAGE_SIZE", arg(queries[0], "limit"), [HELD_PAGE_SIZE]);
    eq("heldWebhookPage: gte defaults to WEBHOOK_HOLD_SWEEP_FROM", arg(queries[0], "gte", "completed_at"), ["completed_at", WEBHOOK_HOLD_SWEEP_FROM]);
    eq("heldWebhookPage: no rows and no error on an empty answer", page, { rows: [], error: null });
    await heldWebhookPage(client, { olderThanIso: SWEEP_LT, fromIso: "2026-01-01T00:00:00.000Z", after: null });
    eq("heldWebhookPage: fromIso replaces the gte value (the staging probe only)", arg(queries[1], "gte", "completed_at"), ["completed_at", "2026-01-01T00:00:00.000Z"]);
    eq("heldWebhookPage: after null sends no keyset or", all(queries[1], "or"), [[COMPLETENESS_OR]]);
    const answered = fakeClient(pagedResponder([row("x1", "2026-11-04T11:00:00.000Z")]));
    const one = await heldWebhookPage(answered.client, { olderThanIso: SWEEP_LT });
    eq("heldWebhookPage: a row answers id and completed_at only", one, { rows: [{ id: "x1", completed_at: "2026-11-04T11:00:00.000Z" }], error: null });
    const throwing = { from() { throw new Error("client failed"); } } as never;
    eq("heldWebhookPage: a client that throws answers no rows and the error", await heldWebhookPage(throwing, { olderThanIso: SWEEP_LT }), { rows: [], error: "client failed" });
  }

  /* ---------------- (iii) heldWebhookSummary, heldWebhookItem, the registry ---------------- */
  console.log("\n(iii) heldWebhookSummary and heldWebhookItem (ADR 0015 step 6)");
  {
    const { client, queries } = fakeClient(pagedResponder([]));
    const { deps } = recordingDeps({});
    const s = await heldWebhookSummary(client, "org-1", { classify: deps.classify, now: deps.now });
    const q = queries[0];
    eq("the selection carries eq organization_id", arg(q, "eq", "organization_id"), ["organization_id", "org-1"]);
    eq("the selection carries the 24-hour lt", arg(q, "lt", "completed_at"), ["completed_at", PROVIDER_LT]);
    eq("the selection carries the start-date gte (its value the constant)", arg(q, "gte", "completed_at"), ["completed_at", WEBHOOK_HOLD_SWEEP_FROM]);
    eq("the default call carries limit min(HELD_PAGE_SIZE, HELD_MAX_SCANNED)", arg(q, "limit"), [Math.min(HELD_PAGE_SIZE, HELD_MAX_SCANNED)]);
    eq("the same held filters as the sweep (latch null, type bound, completeness, not abandoned)",
      [arg(q, "is", "completion_webhook_at"), arg(q, "in", "course_versions.manifest_type"), all(q, "or"), arg(q, "neq", "status")],
      [["completion_webhook_at", null], ["course_versions.manifest_type", ["cmi5", "xapi"]], [[COMPLETENESS_OR]], ["status", "abandoned"]]);
    eq("an empty window → count 0, not truncated, no error", s, { count: 0, oldestCompletedAt: null, truncated: false, error: null });
  }
  {
    const o1 = row("p1", "2026-11-02T10:00:00.000Z"), n = row("p2", "2026-11-02T09:00:00.000Z"), o2 = row("p3", "2026-11-01T08:00:00.000Z");
    const { client } = fakeClient(pagedResponder([o1, n, o2]));
    const { deps } = recordingDeps({ p1: OFFICIAL(1), p2: NOT_OFFICIAL, p3: OFFICIAL(1) });
    // maxScanned above the row count, so a short page ends the scan whatever HELD_MAX_SCANNED is:
    // a full last page exactly at the bound answers truncated true, because the scan cannot tell
    // whether more rows follow.
    const s = await heldWebhookSummary(client, "org-1", { classify: deps.classify, now: deps.now }, { maxScanned: 10 });
    eq("two official rows and one non-official → count 2", s.count, 2);
    eq("…oldestCompletedAt the older of the two", s.oldestCompletedAt, o2.completed_at);
    eq("…not truncated", s.truncated, false);
  }
  {
    // The sweep's rule: official with no attempt number is not counted, and is not the oldest.
    const n = row("z1", "2026-11-01T08:00:00.000Z"), o = row("z2", "2026-11-02T10:00:00.000Z");
    const { client } = fakeClient(pagedResponder([o, n]));
    const { deps } = recordingDeps({ z1: OFFICIAL(null), z2: OFFICIAL(1) });
    const s = await heldWebhookSummary(client, "org-1", { classify: deps.classify, now: deps.now }, { maxScanned: 10 });
    eq("official with no attempt number is not counted", [s.count, s.oldestCompletedAt], [1, o.completed_at]);
  }
  {
    // A null classification (classifyAttempt's own read failed) is not official: not counted, and the scan goes on.
    const n = row("z3", "2026-11-01T08:00:00.000Z"), o = row("z4", "2026-11-02T10:00:00.000Z");
    const { client } = fakeClient(pagedResponder([o, n]));
    const { deps } = recordingDeps({ z3: null, z4: OFFICIAL(1) });
    const s = await heldWebhookSummary(client, "org-1", { classify: deps.classify, now: deps.now }, { maxScanned: 10 });
    eq("a null classification is not counted", [s.count, s.oldestCompletedAt, s.error], [1, o.completed_at, null]);
  }
  {
    const rows = [row("q1", "2026-11-02T10:00:00.000Z"), row("q2", "2026-11-02T09:00:00.000Z"), row("q3", "2026-11-02T08:00:00.000Z"), row("q4", "2026-11-01T08:00:00.000Z")];
    const { client, queries } = fakeClient(pagedResponder(rows));
    const { deps, classified } = recordingDeps({ q1: NOT_OFFICIAL, q2: NOT_OFFICIAL, q3: NOT_OFFICIAL, q4: OFFICIAL(1) });
    const s = await heldWebhookSummary(client, "org-1", { classify: deps.classify, now: deps.now }, { pageSize: 2, maxScanned: 3 });
    eq("{pageSize 2, maxScanned 3}: two selects", queries.length, 2);
    eq("…the second with the keyset or and limit 1", [all(queries[1], "or"), arg(queries[1], "limit")], [[[COMPLETENESS_OR], [keysetOr(rows[1])]], [1]]);
    eq("…the official row beyond the bound is never classified", classified, ["q1", "q2", "q3"]);
    eq("…count 0, truncated true (the bound is real)", [s.count, s.truncated], [0, true]);
  }
  {
    // No opts: HELD_MAX_SCANNED bounds the scan, whatever its value.
    const many = Array.from({ length: HELD_MAX_SCANNED + 5 }, (_, i) => row(`s${i}`, "2026-11-02T10:00:00.000Z"));
    const { client } = fakeClient(pagedResponder(many));
    const { deps, classified } = recordingDeps({});
    const s = await heldWebhookSummary(client, "org-1", { classify: deps.classify, now: deps.now });
    eq("no opts: exactly HELD_MAX_SCANNED rows classified", classified.length, HELD_MAX_SCANNED);
    eq("no opts: truncated true at the scan bound", s.truncated, true);
  }
  {
    // HELD_MAX_COUNT bounds the count inside a page.
    const rows = Array.from({ length: HELD_MAX_COUNT + 5 }, (_, i) => row(`u${i}`, new Date(Date.parse("2026-11-02T10:00:00.000Z") - i * 60_000).toISOString()));
    const { client, queries } = fakeClient(pagedResponder(rows));
    const { deps, classified } = recordingDeps(Object.fromEntries(rows.map((r) => [r.id, OFFICIAL(1)])));
    const s = await heldWebhookSummary(client, "org-1", { classify: deps.classify, now: deps.now }, { pageSize: HELD_MAX_COUNT + 5, maxScanned: 1000 });
    eq("HELD_MAX_COUNT official rows: the count stops at the bound", s.count, HELD_MAX_COUNT);
    eq("…the rows beyond it are not classified", classified.length, HELD_MAX_COUNT);
    eq("…truncated true, one select", [s.truncated, queries.length], [true, 1]);
    eq("…oldestCompletedAt the oldest row counted", s.oldestCompletedAt, rows[HELD_MAX_COUNT - 1].completed_at);
  }
  {
    // Exactly HELD_MAX_COUNT official rows and then a short page: no bound stopped the scan.
    const rows = Array.from({ length: HELD_MAX_COUNT }, (_, i) => row(`v${i}`, "2026-11-02T10:00:00.000Z"));
    const { client } = fakeClient(pagedResponder(rows));
    const { deps } = recordingDeps(Object.fromEntries(rows.map((r) => [r.id, OFFICIAL(1)])));
    const s = await heldWebhookSummary(client, "org-1", { classify: deps.classify, now: deps.now }, { pageSize: HELD_MAX_COUNT + 5, maxScanned: 1000 });
    eq("exactly HELD_MAX_COUNT rows then a short page → the count, not truncated", [s.count, s.truncated], [HELD_MAX_COUNT, false]);
  }
  {
    const { client } = fakeClient(pagedResponder([row("w1", "2026-11-02T10:00:00.000Z")]));
    const { deps } = recordingDeps({ w1: "throw" });
    const s = await heldWebhookSummary(client, "org-1", { classify: deps.classify, now: deps.now }, { maxScanned: 10 });
    eq("a classify that throws → count 0, not truncated, error set", s, { count: 0, oldestCompletedAt: null, truncated: false, error: "classify failed" });
  }
  {
    const before = Date.now();
    const fallback = heldWebhookItem({ count: 1, oldestCompletedAt: null, orgSlug: "qa-org", priority: "high" });
    eq("no oldest date → occurredAt is the current time", Date.parse(fallback?.occurredAt ?? "") >= before, true);
    eq("the priority given is the item's priority", heldWebhookItem({ count: 1, oldestCompletedAt: null, orgSlug: "qa-org", priority: "critical" })?.priority, "critical");
  }
  {
    const item2 = heldWebhookItem({ count: 2, oldestCompletedAt: "2026-11-01T08:00:00.000Z", orgSlug: "qa-org", priority: "high" });
    eq("count 2 → key held-webhooks:all:2", item2?.key, "held-webhooks:all:2");
    eq("count 2 → title \"2 completion webhooks held\"", item2?.title, "2 completion webhooks held");
    eq("count 2 → href /qa-org/reports", item2?.href, "/qa-org/reports");
    eq("count 2 → dismissible true", item2?.dismissible, true);
    eq("count 2 → inline null", item2?.inline, null);
    eq("count 2 → the item in the overdue item's shape", item2, {
      key: "held-webhooks:all:2",
      type: "held-webhooks",
      priority: "high",
      title: "2 completion webhooks held",
      who: null,
      context: "cmi5/xAPI completions whose CRM webhook has not fired after 24 hours",
      occurredAt: "2026-11-01T08:00:00.000Z",
      actionLabel: "Review learners",
      href: "/qa-org/reports",
      inline: null,
      dismissible: true,
    });
    eq("count 1 → \"1 completion webhook held\"", heldWebhookItem({ count: 1, oldestCompletedAt: "2026-11-01T08:00:00.000Z", orgSlug: "qa-org", priority: "high" })?.title, "1 completion webhook held");
    eq("count 0 → null", heldWebhookItem({ count: 0, oldestCompletedAt: null, orgSlug: "qa-org", priority: "high" }), null);
  }
  {
    const { client } = fakeClient(() => ({ error: { code: "42703", message: "column course_attempts.completion_webhook_at does not exist" } }));
    const { deps } = recordingDeps({});
    const s = await heldWebhookSummary(client, "org-1", { classify: deps.classify, now: deps.now });
    eq("a select error → count 0, error set", [s.count, s.error], [0, "column course_attempts.completion_webhook_at does not exist"]);
    eq("…and the item is null", heldWebhookItem({ count: s.count, oldestCompletedAt: s.oldestCompletedAt, orgSlug: "qa-org", priority: "high" }), null);
  }
  {
    eq("effectiveConfig(null).byType[\"held-webhooks\"] → enabled, high", effectiveConfig(null).byType["held-webhooks"], { enabled: true, priority: "high" });
    eq("the registry entry (ADR 0015 step 6)", ATTENTION_PROVIDERS.find((p) => p.type === "held-webhooks"), {
      type: "held-webhooks",
      label: "Completion webhooks held",
      description: "cmi5/xAPI completions whose CRM webhook has not fired after 24 hours.",
      defaultEnabled: true,
      defaultPriority: "high",
      configurablePriority: true,
    });
    const collect = fs.readFileSync(path.resolve(__dirname, "../../lib/attention/collect.ts"), "utf8");
    eq("collect.ts dispatches \"held-webhooks\" to heldWebhookItems under run(", /p\.type === "held-webhooks"\) jobs\.push\(run\(heldWebhookItems\(svc, orgId, orgSlug, c\.priority\)\)\);/.test(collect), true);
  }

  /* ---------------- heldWebhookItems, through collectAttention on the fake ---------------- */
  console.log("\n(iii) heldWebhookItems through collectAttention, with the real classifyAttempt (ADR 0015 step 9 (iii))");
  {
    const OLD_1 = "2026-11-04T01:00:00.000Z";
    const OLD_2 = "2026-11-04T00:30:00.000Z";
    const isHeldPage = (q: Query) => q.table === "course_attempts" && String(arg(q, "select")?.[0] ?? "").includes("course_versions!inner(manifest_type)");
    const eqValue = (q: Query, col: string) => arg(q, "eq", col)?.[1];
    /** Two held rows, each its learner's only attempt unless named: `flagged` carry is_revision, `beyond` an earlier completed attempt. */
    const world = (o: { flagged?: string[]; beyond?: string[]; versionsError?: boolean; listError?: boolean; heldError?: boolean; throwOnAttempt?: boolean } = {}) =>
      fakeClient((q) => {
        if (isHeldPage(q)) {
          if (o.heldError) return { error: { code: "42703", message: "column course_attempts.completion_webhook_at does not exist" } };
          return { data: [{ id: "a1", completed_at: OLD_1, course_versions: { manifest_type: "xapi" } }, { id: "a2", completed_at: OLD_2, course_versions: { manifest_type: "cmi5" } }] };
        }
        if (q.table === "course_versions") return o.versionsError ? { error: { code: "57014", message: "canceling statement due to statement timeout" } } : { data: [{ id: "v1" }] };
        if (q.table === "course_attempts" && arg(q, "eq", "id")) {
          if (o.throwOnAttempt) throw new Error("the client failed");
          const id = String(eqValue(q, "id"));
          return { data: { id, user_id: `u-${id}`, organization_id: "o1", course_version_id: "v1", course_versions: { course_id: "c1" }, is_revision: (o.flagged ?? []).includes(id) } };
        }
        if (q.table === "course_attempts" && arg(q, "eq", "user_id")) {
          if (o.listError) return { error: { code: "57014", message: "canceling statement due to statement timeout" } };
          const id = String(eqValue(q, "user_id")).slice(2);
          const own = { id, score: 0.8, started_at: "2026-11-03T00:00:00.000Z", completed_at: OLD_1, completion_status: "completed", success_status: "unknown", status: "completed", is_revision: (o.flagged ?? []).includes(id) };
          const earlier = { ...own, id: `${id}-earlier`, completed_at: "2026-10-01T00:00:00.000Z", is_revision: false };
          return { data: (o.beyond ?? []).includes(id) ? [earlier, own] : [own] };
        }
        return { data: [] };
      });
    const heldOf = async (client: never, over: { settings?: { enabled?: boolean | null; config?: Record<string, { enabled?: boolean; priority?: string }> | null } | null; dismissals?: Map<string, string> } = {}) => {
      const out = await collectAttention({ svc: client, orgId: "o1", orgSlug: "qa-org", settings: over.settings ?? null, dismissals: over.dismissals ?? new Map<string, string>() });
      return { out, items: out.items.filter((i) => i.type === "held-webhooks") };
    };
    {
      const { client, queries } = world();
      const { out, items } = await heldOf(client);
      eq("two held official rows: one item, the count in its key, the priority the registry's, the href from the organisation's slug", items, [{
        key: "held-webhooks:all:2",
        type: "held-webhooks",
        priority: "high",
        title: "2 completion webhooks held",
        who: null,
        context: "cmi5/xAPI completions whose CRM webhook has not fired after 24 hours",
        occurredAt: OLD_2,
        actionLabel: "Review learners",
        href: "/qa-org/reports",
        inline: null,
        dismissible: true,
      }]);
      eq("…byPriority counts it", out.byPriority.high, 1);
      const pages = queries.filter(isHeldPage);
      eq("…one held-row select (a short page)", pages.length, 1);
      eq("…for the organisation's id", eqValue(pages[0], "organization_id"), "o1");
      eq("…no opts: limit min(HELD_PAGE_SIZE, HELD_MAX_SCANNED)", arg(pages[0], "limit"), [Math.min(HELD_PAGE_SIZE, HELD_MAX_SCANNED)]);
      eq("…a SCORM row is excluded: the type bound", arg(pages[0], "in", "course_versions.manifest_type"), ["course_versions.manifest_type", ["cmi5", "xapi"]]);
      eq("…the start date", arg(pages[0], "gte", "completed_at"), ["completed_at", WEBHOOK_HOLD_SWEEP_FROM]);
      const ageHours = (Date.now() - Date.parse(String(arg(pages[0], "lt", "completed_at")?.[1]))) / 3_600_000;
      eq("…a younger row is excluded: older than 24 hours", ageHours > 23.99 && ageHours < 24.01, true);
      eq("…the real classifyAttempt read each row, by id", queries.filter((q) => q.table === "course_attempts" && arg(q, "eq", "id")).map((q) => eqValue(q, "id")), ["a1", "a2"]);
    }
    {
      const { client, queries } = world();
      const { items } = await heldOf(client, { settings: { enabled: true, config: { "held-webhooks": { enabled: false } } } });
      eq("disabled by an admin: no item, no held-row select", [items.length, queries.filter(isHeldPage).length], [0, 0]);
    }
    {
      const { client } = world();
      const { items } = await heldOf(client, { settings: { enabled: true, config: { "held-webhooks": { enabled: true, priority: "critical" } } } });
      eq("the configured priority reaches the item", items[0]?.priority, "critical");
    }
    {
      const { client } = world({ flagged: ["a1"] });
      const { items } = await heldOf(client);
      eq("a flagged row is not official: not counted", [items[0]?.key, items[0]?.title], ["held-webhooks:all:1", "1 completion webhook held"]);
    }
    {
      const { client } = world({ beyond: ["a2"] });
      const { items } = await heldOf(client);
      eq("a row beyond the scored window is not official: not counted, and not the oldest", [items[0]?.key, items[0]?.occurredAt], ["held-webhooks:all:1", OLD_1]);
    }
    {
      const { client } = world({ flagged: ["a1"], beyond: ["a2"] });
      eq("only non-official rows: nothing", (await heldOf(client)).items, []);
    }
    {
      const { client } = world({ listError: true });
      eq("the classification's list read failing: official with no number, so nothing", (await heldOf(client)).items, []);
    }
    {
      const { client } = world({ versionsError: true });
      eq("the classification's versions read failing: official with no number, so nothing", (await heldOf(client)).items, []);
    }
    {
      const { client } = world({ heldError: true });
      const { out, items } = await heldOf(client);
      eq("a select error (a database without 0082): nothing, and the page still answers", [items, out.total], [[], 0]);
    }
    {
      const { client } = world({ throwOnAttempt: true });
      const { out, items } = await heldOf(client);
      eq("a client that throws inside the classification: nothing, and the page still answers", [items, out.total], [[], 0]);
    }
    {
      const { client } = world();
      eq("dismissed at this count: hidden", (await heldOf(client, { dismissals: new Map([["held-webhooks:all:2", "2026-11-04T02:00:00.000Z"]]) })).items, []);
    }
    {
      const { client } = world();
      eq("dismissed at another count: it re-surfaces", (await heldOf(client, { dismissals: new Map([["held-webhooks:all:1", "2026-11-04T02:00:00.000Z"]]) })).items.length, 1);
    }
  }

  /* ---------------- classifyAttempt with its versions read failing, on the fake ---------------- */
  console.log("\n(iii) classifyAttempt with its versions read failing: a failed list read, so official with no number (ADR 0015)");
  {
    const TIMEOUT = { code: "57014", message: "canceling statement due to statement timeout" };
    const COMPLETED_AT = "2026-11-04T01:00:00.000Z";
    const listRow = (id: string, completed_at: string) => ({ id, score: 0.8, started_at: "2026-10-01T00:00:00.000Z", completed_at, completion_status: "completed", success_status: "unknown", status: "completed", is_revision: false });
    /** The row n0 on version v1; unless `alone`, the learner's first attempt is on v0, so n0 is beyond the window through it. The list read honours its version filter. */
    const world = (o: { versionsError?: boolean; versionsTransport?: boolean; listError?: boolean; flagged?: boolean; alone?: boolean } = {}) =>
      fakeClient((q) => {
        if (q.table === "course_versions") return o.versionsTransport ? { error: { code: "", message: "TypeError: fetch failed" } } : o.versionsError ? { error: TIMEOUT } : { data: [{ id: "v0" }, { id: "v1" }] };
        if (q.table === "course_attempts" && String(arg(q, "select")?.[0] ?? "").includes("course_versions!inner(manifest_type)")) {
          return { data: [{ id: "n0", completed_at: COMPLETED_AT, course_versions: { manifest_type: "xapi" } }] };
        }
        if (q.table === "course_attempts" && arg(q, "eq", "id")) {
          return { data: { id: "n0", user_id: "u1", organization_id: "o1", course_version_id: "v1", course_versions: { course_id: "c1" }, is_revision: o.flagged === true } };
        }
        if (q.table === "course_attempts" && arg(q, "eq", "user_id")) {
          if (o.listError) return { error: TIMEOUT };
          const versions = (arg(q, "in", "course_version_id")?.[1] ?? []) as string[];
          const onVersion: Record<string, ReturnType<typeof listRow>[]> = { v0: o.alone ? [] : [listRow("first", "2026-10-01T00:00:00.000Z")], v1: [listRow("n0", COMPLETED_AT)] };
          return { data: versions.flatMap((v) => onVersion[v] ?? []) };
        }
        return { data: [] };
      });
    const healthy = world();
    const sound = await classifyAttempt(healthy.client, "n0");
    eq("the versions read healthy: a row beyond the window through another version is not official, number 2", [sound?.official, sound?.attemptNumber], [false, 2]);
    const failing = world({ versionsError: true });
    const kind = await classifyAttempt(failing.client, "n0");
    eq("the versions read failing: official, a null number, never a wrong 1", [kind?.official, kind?.attemptNumber], [true, null]);
    eq("…scoring ran on no rows", kind?.scoring.attemptNumber.size, 0);
    eq("…the same subrequests, the list read still made", failing.queries.map((q) => q.table), healthy.queries.map((q) => q.table));
    const listFailing = await classifyAttempt(world({ listError: true }).client, "n0");
    eq("…the same answer as a failed list read", [kind?.official, kind?.attemptNumber], [listFailing?.official, listFailing?.attemptNumber]);
    const transport = await classifyAttempt(world({ versionsTransport: true }).client, "n0");
    eq("…a rejected fetch, whose error has an empty code, is the same", [transport?.official, transport?.attemptNumber], [true, null]);
    const flagged = await classifyAttempt(world({ versionsError: true, flagged: true }).client, "n0");
    eq("…a revision row stays not official", [flagged?.official, flagged?.attemptNumber], [false, null]);

    const fires: Array<[string, number | null]> = [];
    const deps: SweepDeps = { classify: classifyAttempt, fire: async (id, n) => { fires.push([id, n]); return true; } };
    const sweep = async (o: { versionsError?: boolean; alone?: boolean }) => (await captureWarn(() => sweepHeldWebhooks(world(o).client, deps))).value;
    for (const run of [1, 2]) {
      const res = await sweep({ versionsError: true });
      eq(`the sweep, run ${run}, the versions read failing: skipped, no fire call`, [res.skipped, res.fired, fires], [["n0"], [], []]);
    }
    {
      const res = await sweep({});
      eq("…the next run, the read healthy: a row beyond the window stays skipped, no fire call", [res.skipped, res.fired, fires], [["n0"], [], []]);
    }
    {
      const res = await sweep({ versionsError: true, alone: true });
      eq("the learner's only attempt, the versions read failing: skipped, never fired as number 1", [res.skipped, res.fired, fires], [["n0"], [], []]);
      const next = await sweep({ alone: true });
      eq("…retried: the next run fires it with its number", [next.skipped, next.fired, fires], [[], ["n0"], [["n0", 1]]]);
    }
    const s = await heldWebhookSummary(world({ versionsError: true, alone: true }).client, "o1", { classify: classifyAttempt });
    eq("the provider, the versions read failing: not counted, no error", [s.count, s.oldestCompletedAt, s.error], [0, null, null]);
  }

  /* ---------------- (iv) the start date ---------------- */
  console.log("\n(iv) WEBHOOK_HOLD_SWEEP_FROM (ADR 0015 step 5)");
  {
    eq("is a UTC midnight ISO instant", /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/.test(WEBHOOK_HOLD_SWEEP_FROM), true);
    eq("parses to the same instant", new Date(WEBHOOK_HOLD_SWEEP_FROM).toISOString(), WEBHOOK_HOLD_SWEEP_FROM);
    eq("is not after today's date in UTC (a future date would hide every held row)", Date.parse(WEBHOOK_HOLD_SWEEP_FROM) <= Date.now(), true);
  }

  /* ---------------- (v) the ceilings ---------------- */
  console.log("\n(v) the caps never exceed ADR 0015's ceilings");
  {
    eq("SWEEP_MAX_FIRES <= 200", SWEEP_MAX_FIRES <= 200, true);
    eq("SWEEP_MAX_SCANNED <= 1000", SWEEP_MAX_SCANNED <= 1000, true);
    eq("HELD_MAX_COUNT <= 200", HELD_MAX_COUNT <= 200, true);
    eq("HELD_MAX_SCANNED <= 1000", HELD_MAX_SCANNED <= 1000, true);
    eq("HELD_PAGE_SIZE <= 200", HELD_PAGE_SIZE <= 200, true);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
