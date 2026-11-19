/**
 * Unit tests for ALDS step 0 (docs/ambak-learning-data-standard/BLUEPRINT.md §0):
 *   P1  the legacy content route's version rule (pickLegacyVersionId)
 *   P4  abandoned is terminal: conditional attempt writes, processStatement
 *       never derives a status for an abandoned attempt, token expiry
 *   P5  the analytics ?content= guard (contentFilterInOrg)
 * And ADR 0030 decision 4: expireLaunchTokensForMembers finds the live
 * tokens of these people's attempts in one organisation, whatever the
 * attempt's status, in chunks of 150 people with each read paged, hands the
 * attempt ids to the existing expiry, touches no other table, and returns
 * an error rather than throwing.
 * No DB: a recording fake stands in for the supabase-js query builder.
 *
 * Run:  npx tsx tests/unit/alds-step0.test.ts
 */
import { orgCourseVersion, pickLegacyVersionId } from "../../lib/courses/content-delivery";
import { contentFilterInOrg } from "../../lib/content/analytics-filter";
import { updateAttemptFailSoft, updateProgressFromState } from "../../lib/courses/progress";
import { processStatement } from "../../lib/xapi/process-statement";
import {
  ATTEMPT_ABANDONED,
  AttemptAbandonedError,
  attemptAbandonedResponse,
  expireLaunchTokens,
  expireLaunchTokensForMembers,
  isAttemptAbandonedError,
} from "../../lib/attempts/abandon";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

/* ---------------- fake supabase client ---------------- */

type Call = { table: string; op: string; args: unknown[] };
type Responder = (table: string, ops: Array<{ op: string; args: unknown[] }>) => { data: unknown; error: unknown };

function fakeClient(respond: Responder) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      const ops: Array<{ op: string; args: unknown[] }> = [];
      const b: Record<string, unknown> = {};
      for (const op of ["select", "update", "insert", "upsert", "eq", "neq", "in", "gt", "not", "is", "order", "limit", "range"]) {
        b[op] = (...args: unknown[]) => {
          ops.push({ op, args });
          calls.push({ table, op, args });
          return b;
        };
      }
      const settle = () => Promise.resolve(respond(table, ops));
      b.maybeSingle = () => settle();
      b.single = () => settle();
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => settle().then(res, rej);
      return b;
    },
  };
  return { client: client as never, calls };
}
const isUpdate = (ops: Array<{ op: string }>) => ops.some((o) => o.op === "update");

async function main() {
  /* ---------------- P1: legacy version rule ---------------- */
  console.log("\nP1 legacy content route — version rule");
  eq("no attempts → current version", pickLegacyVersionId([], "cur"), "cur");
  eq("no attempts, no current → null", pickLegacyVersionId([], null), null);
  eq(
    "newest live attempt wins (in_progress)",
    pickLegacyVersionId([{ course_version_id: "hi1", status: "in_progress" }, { course_version_id: "en1", status: "completed" }], "en2"),
    "hi1"
  );
  eq(
    "newest live attempt wins (completed/passed/failed count as live)",
    pickLegacyVersionId([{ course_version_id: "en1", status: "passed" }], "en2"),
    "en1"
  );
  eq(
    "abandoned attempts are skipped",
    pickLegacyVersionId([{ course_version_id: "hi1", status: "abandoned" }, { course_version_id: "en1", status: "failed" }], "en2"),
    "en1"
  );
  eq(
    "only abandoned → current version",
    pickLegacyVersionId([{ course_version_id: "hi1", status: "abandoned" }], "en2"),
    "en2"
  );

  console.log("\nP1 versioned content route — ownership");
  const C1 = "11111111-1111-4111-8111-111111111111";
  const V1 = "22222222-2222-4222-8222-222222222222";
  const ownership = (course: unknown, version: unknown) =>
    fakeClient((table) => ({ data: table === "courses" ? course : version, error: null }));
  {
    const { client, calls } = ownership({ id: C1 }, { id: V1, storage_prefix: "courses/c1/p/v1/", upload_status: "ready" });
    const v = await orgCourseVersion(client, "org1", C1, V1);
    eq("own course + own version + ready → served", v?.storage_prefix, "courses/c1/p/v1/");
    eq("course lookup is pinned to the org", calls.some((c) => c.table === "courses" && c.op === "eq" && c.args[0] === "organization_id" && c.args[1] === "org1"), true);
    eq("version lookup is pinned to the course", calls.some((c) => c.table === "course_versions" && c.op === "eq" && c.args[0] === "course_id" && c.args[1] === C1), true);
  }
  {
    const { client } = ownership(null, { id: V1, storage_prefix: "x/" });
    eq("course not in org → 404", await orgCourseVersion(client, "org1", C1, V1), null);
  }
  {
    const { client } = ownership({ id: C1 }, null);
    eq("version not of this course → 404", await orgCourseVersion(client, "org1", C1, V1), null);
  }
  {
    const { client } = ownership({ id: C1 }, { id: V1, storage_prefix: "x/", upload_status: "uploading" });
    eq("unfinished upload → 404", await orgCourseVersion(client, "org1", C1, V1), null);
  }
  {
    const { client } = ownership({ id: C1 }, { id: V1, storage_prefix: "x/" });
    eq("pre-0077 row (no upload_status) → served", (await orgCourseVersion(client, "org1", C1, V1))?.id, V1);
  }
  {
    const { client, calls } = ownership({ id: C1 }, { id: V1, storage_prefix: "x/" });
    eq("non-uuid version id → 404 without a query", await orgCourseVersion(client, "org1", C1, "index.html"), null);
    eq("…no query issued", calls.length, 0);
  }

  /* ---------------- P5: analytics content guard ---------------- */
  console.log("\nP5 analytics ?content= guard");
  const maps = {
    courseIds: new Set(["c1"]),
    pathIds: new Map([["p1", "Path"]]),
    programIds: new Map([["j1", {}]]),
  };
  eq("own course honoured", contentFilterInOrg("course:c1", maps), true);
  eq("foreign course rejected", contentFilterInOrg("course:c999", maps), false);
  eq("own path honoured", contentFilterInOrg("path:p1", maps), true);
  eq("foreign path rejected", contentFilterInOrg("path:c1", maps), false);
  eq("own journey honoured", contentFilterInOrg("journey:j1", maps), true);
  eq("unknown kind rejected", contentFilterInOrg("module:c1", maps), false);
  eq("empty id rejected", contentFilterInOrg("course:", maps), false);
  eq("no kind rejected", contentFilterInOrg("c1", maps), false);

  /* ---------------- P4: conditional attempt write ---------------- */
  console.log("\nP4 updateAttemptFailSoft — conditional on status <> 'abandoned'");
  {
    const { client, calls } = fakeClient(() => ({ data: [{ id: "a1" }], error: null }));
    const r = await updateAttemptFailSoft(client, "a1", { status: "completed" }, { userId: "u1" });
    eq("row matched → null (success)", r, null);
    eq(
      "write carries .neq('status','abandoned')",
      calls.some((c) => c.op === "neq" && c.args[0] === "status" && c.args[1] === "abandoned"),
      true
    );
    eq("write is scoped to the user", calls.some((c) => c.op === "eq" && c.args[0] === "user_id" && c.args[1] === "u1"), true);
  }
  {
    const { client } = fakeClient(() => ({ data: [], error: null }));
    const r = await updateAttemptFailSoft(client, "a1", { status: "completed" });
    eq("0 rows → abandoned", r, { message: ATTEMPT_ABANDONED, abandoned: true });
  }
  {
    let n = 0;
    const { client } = fakeClient(() =>
      ++n === 1
        ? { data: null, error: { message: 'column "progress_pct" does not exist' } }
        : { data: [{ id: "a1" }], error: null }
    );
    const r = await updateAttemptFailSoft(client, "a1", { status: "completed", progress_pct: 50 });
    eq("pre-0075 retry without progress_pct still succeeds", r, null);
  }
  {
    const { client } = fakeClient(() => ({ data: null, error: { message: "boom" } }));
    const r = await updateAttemptFailSoft(client, "a1", { status: "completed" });
    eq("real error passes through (not abandoned)", r, { message: "boom" });
  }

  /* ---------------- P4: processStatement ---------------- */
  console.log("\nP4 processStatement — never derives a status for an abandoned attempt");
  const auStatement = {
    actor: { objectType: "Agent", account: { homePage: "x", name: "u1" } },
    verb: { id: "http://adlnet.gov/expapi/verbs/completed" },
    object: { objectType: "Activity", id: "https://qa.bot/au" },
  };
  const attemptRow = (status: string) => ({
    id: "a1",
    status,
    completion_status: "in_progress",
    success_status: "unknown",
    completed_at: null,
    score: null,
    course_version_id: "v1",
    cmi_data: {},
    progress_pct: null,
    course_versions: { id: "v1", manifest_data: { raw: { auId: "https://qa.bot/au" }, unitCount: 4 } },
  });
  {
    const { client, calls } = fakeClient((table, ops) =>
      isUpdate(ops) ? { data: [{ id: "a1" }], error: null } : { data: attemptRow("abandoned"), error: null }
    );
    let thrown: unknown = null;
    try {
      await processStatement({ statement: auStatement as never, attemptId: "a1", supabase: client });
    } catch (e) {
      thrown = e;
    }
    eq("abandoned attempt → AttemptAbandonedError", thrown instanceof AttemptAbandonedError, true);
    eq("…and no attempt write was attempted", calls.some((c) => c.op === "update"), false);
  }
  {
    const { client } = fakeClient((table, ops) =>
      isUpdate(ops) ? { data: [], error: null } : { data: attemptRow("in_progress"), error: null }
    );
    let thrown: unknown = null;
    try {
      await processStatement({ statement: auStatement as never, attemptId: "a1", supabase: client });
    } catch (e) {
      thrown = e;
    }
    eq("abandoned between read and write (0 rows) → AttemptAbandonedError", isAttemptAbandonedError(thrown), true);
  }
  {
    const { client, calls } = fakeClient((table, ops) =>
      isUpdate(ops) ? { data: [{ id: "a1" }], error: null } : { data: attemptRow("in_progress"), error: null }
    );
    const delta = (await processStatement({ statement: auStatement as never, attemptId: "a1", supabase: client })) as Record<string, unknown>;
    eq("live attempt: AU completed → status completed", delta?.status, "completed");
    eq("live attempt: write is conditional", calls.some((c) => c.op === "neq" && c.args[1] === "abandoned"), true);
  }

  /* ---------------- P4: State progress ---------------- */
  console.log("\nP4 updateProgressFromState");
  {
    const { client, calls } = fakeClient((table, ops) =>
      isUpdate(ops) ? { data: [{ id: "a1" }], error: null } : { data: attemptRow("abandoned"), error: null }
    );
    let thrown: unknown = null;
    try {
      await updateProgressFromState(client, "a1", { progress: 0.5 });
    } catch (e) {
      thrown = e;
    }
    eq("abandoned → AttemptAbandonedError", isAttemptAbandonedError(thrown), true);
    eq("…without writing", calls.some((c) => c.op === "update"), false);
  }
  {
    const { client } = fakeClient((table, ops) =>
      isUpdate(ops) ? { data: [], error: null } : { data: attemptRow("in_progress"), error: null }
    );
    let thrown: unknown = null;
    try {
      await updateProgressFromState(client, "a1", { progress: 0.5 });
    } catch (e) {
      thrown = e;
    }
    eq("abandoned between read and write → AttemptAbandonedError", isAttemptAbandonedError(thrown), true);
  }
  {
    const { client } = fakeClient((table, ops) =>
      isUpdate(ops) ? { data: [{ id: "a1" }], error: null } : { data: attemptRow("in_progress"), error: null }
    );
    eq("live attempt: progress raised", await updateProgressFromState(client, "a1", { progress: 0.5 }), 50);
  }

  /* ---------------- P4: token expiry + 410 shape ---------------- */
  console.log("\nP4 token expiry + 410 response");
  {
    const { client, calls } = fakeClient(() => ({ data: null, error: null }));
    const ids = Array.from({ length: 450 }, (_, i) => `a${i}`);
    const r = await expireLaunchTokens(client, [...ids, "a0", ""]);
    eq("no error", r, null);
    const updates = calls.filter((c) => c.table === "cmi5_launch_tokens" && c.op === "update");
    eq("chunked: 450 distinct ids → 3 updates", updates.length, 3);
    eq("sets expires_at", Object.keys((updates[0]?.args[0] ?? {}) as object), ["expires_at"]);
    eq("only live tokens (.gt expires_at)", calls.filter((c) => c.op === "gt" && c.args[0] === "expires_at").length, 3);
  }
  {
    const { client, calls } = fakeClient(() => ({ data: null, error: null }));
    await expireLaunchTokens(client, []);
    eq("no ids → no query", calls.length, 0);
  }
  {
    const res = attemptAbandonedResponse();
    eq("410 status", res.status, 410);
    eq("410 body", await res.json(), { error: "attempt_abandoned" });
  }

  /* ---------------- ADR 0030 decision 4: a deactivation's token expiry ---------------- */
  console.log("\nADR 0030 decision 4: expireLaunchTokensForMembers");
  type Q = { table: string; ops: Array<{ op: string; args: unknown[] }> };
  const recorder = (answer: (q: Q) => { data: unknown; error: unknown }) => {
    const queries: Q[] = [];
    const { client } = fakeClient((table, ops) => {
      const q = { table, ops: [...ops] };
      queries.push(q);
      return answer(q);
    });
    return { client, queries };
  };
  const argsOf = (q: Q | undefined, op: string) => (q?.ops ?? []).filter((o) => o.op === op).map((o) => o.args);
  const inList = (q: Q | undefined) => (argsOf(q, "in")[0]?.[1] ?? []) as string[];
  const tokenReads = (qs: Q[]) => qs.filter((q) => !isUpdate(q.ops));
  const tokenUpdates = (qs: Q[]) => qs.filter((q) => isUpdate(q.ops));
  {
    // 450 people, one repeated and one empty id. Each holds one live token,
    // except u0, who holds two on one attempt.
    const { client, queries } = recorder((q) => {
      if (isUpdate(q.ops)) return { data: null, error: null };
      return { data: inList(q).flatMap((u) => (u === "u0" ? [{ attempt_id: "a-u0" }, { attempt_id: "a-u0" }] : [{ attempt_id: `a-${u}` }])), error: null };
    });
    const people = Array.from({ length: 450 }, (_, i) => `u${i}`);
    const r = await expireLaunchTokensForMembers(client, "o1", [...people, "u0", ""]);
    eq("no error", r, null);
    const rd = tokenReads(queries);
    eq("one read per 150 distinct people (the house .in() rule): 3 reads", rd.map((q) => inList(q).length), [150, 150, 150]);
    eq("…every person read once", new Set(rd.flatMap(inList)).size, 450);
    eq("…the read is of cmi5_launch_tokens, the attempt through an inner embed",
      [rd.every((q) => q.table === "cmi5_launch_tokens"), argsOf(rd[0], "select")[0]?.[0]],
      [true, "attempt_id, course_attempts!inner(user_id, organization_id)"]);
    eq("…found through the attempt's organisation and user",
      [argsOf(rd[0], "eq"), argsOf(rd[0], "in")[0]?.[0]],
      [[["course_attempts.organization_id", "o1"]], "course_attempts.user_id"]);
    eq("…live tokens only, and no filter on the attempt's status",
      [argsOf(rd[0], "gt").map((a) => a[0]), rd[0]?.ops.some((o) => JSON.stringify(o.args).includes("status"))],
      [["expires_at"], false]);
    eq("…paged in a stable order", [argsOf(rd[0], "order")[0]?.[0], argsOf(rd[0], "range")[0]], ["fetch_token", [0, 999]]);
    const up = tokenUpdates(queries);
    eq("then the existing expiry: 450 distinct attempts, 3 updates of at most 200", up.map((q) => inList(q).length), [200, 200, 50]);
    eq("…keyed on the attempt, live tokens only, setting expires_at alone",
      [argsOf(up[0], "in")[0]?.[0], argsOf(up[0], "gt").map((a) => a[0]), Object.keys((argsOf(up[0], "update")[0]?.[0] ?? {}) as object)],
      ["attempt_id", ["expires_at"], ["expires_at"]]);
    eq("…the repeated attempt is expired once", up.flatMap(inList).filter((a) => a === "a-u0").length, 1);
    eq("no table other than cmi5_launch_tokens is read or written (the attempts are not touched)", [...new Set(queries.map((q) => q.table))], ["cmi5_launch_tokens"]);
    eq("all reads come before the first update", queries.findIndex((q) => isUpdate(q.ops)), 3);
  }
  {
    // One person with more than a page of live tokens: the read is paged.
    const { client, queries } = recorder((q) => {
      if (isUpdate(q.ops)) return { data: null, error: null };
      const from = (argsOf(q, "range")[0]?.[0] ?? 0) as number;
      const n = from === 0 ? 1000 : 3;
      return { data: Array.from({ length: n }, (_, i) => ({ attempt_id: `a${from + i}` })), error: null };
    });
    const r = await expireLaunchTokensForMembers(client, "o1", ["u1"]);
    eq("paged: a full page is followed by the next", [r, tokenReads(queries).map((q) => argsOf(q, "range")[0])], [null, [[0, 999], [1000, 1999]]]);
    eq("…every attempt of both pages is expired", new Set(tokenUpdates(queries).flatMap(inList)).size, 1003);
  }
  {
    const { client, queries } = recorder(() => ({ data: [], error: null }));
    eq("no live token: one read, no update", [await expireLaunchTokensForMembers(client, "o1", ["u1"]), tokenReads(queries).length, tokenUpdates(queries).length], [null, 1, 0]);
  }
  {
    const { client, queries } = recorder(() => ({ data: [], error: null }));
    await expireLaunchTokensForMembers(client, "o1", []);
    await expireLaunchTokensForMembers(client, "o1", ["", ""]);
    await expireLaunchTokensForMembers(client, "", ["u1"]);
    eq("no person, or no organisation: no query", queries.length, 0);
  }
  {
    const { client, queries } = recorder((q) => (isUpdate(q.ops) ? { data: null, error: null } : { data: null, error: { message: "read failed" } }));
    const r = await expireLaunchTokensForMembers(client, "o1", ["u1"]);
    eq("a failed read: the error comes back, and nothing is expired", [typeof r?.message, /read failed/.test(r?.message ?? ""), tokenUpdates(queries).length], ["string", true, 0]);
  }
  {
    const { client } = recorder((q) => (isUpdate(q.ops) ? { data: null, error: { message: "update failed" } } : { data: [{ attempt_id: "a1" }], error: null }));
    eq("a failed update: the error comes back", await expireLaunchTokensForMembers(client, "o1", ["u1"]), { message: "update failed" });
  }
  {
    const { client } = recorder(() => {
      throw new Error("network down");
    });
    let threw = false;
    let r: { message: string } | null = null;
    try {
      r = await expireLaunchTokensForMembers(client, "o1", ["u1"]);
    } catch {
      threw = true;
    }
    eq("an exception is answered as an error, never thrown", [threw, r], [false, { message: "network down" }]);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
