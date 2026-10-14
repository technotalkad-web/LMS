/**
 * Unit tests for ALDS step 0 (docs/ambak-learning-data-standard/BLUEPRINT.md §0):
 *   P1  the legacy content route's version rule (pickLegacyVersionId)
 *   P4  abandoned is terminal: conditional attempt writes, processStatement
 *       never derives a status for an abandoned attempt, token expiry
 *   P5  the analytics ?content= guard (contentFilterInOrg)
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
      for (const op of ["select", "update", "insert", "upsert", "eq", "neq", "in", "gt", "not", "is", "order", "limit"]) {
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

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
