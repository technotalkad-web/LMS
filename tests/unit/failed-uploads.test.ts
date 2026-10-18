/**
 * Unit test for ADR 0008 decision D1 (step 22): a version that will never be
 * ready keeps its row as 'failed', so its version number and storage folder
 * are never reused.
 *   - markVersionFailed: the conditional claim (upload_status, size_bytes 0)
 *   - sweepAbandonedUploads (the reaper hook): an old 'uploading' row turns
 *     'failed' and its prefix is emptied; the row is never deleted; a row
 *     finalised meanwhile, or one holding attempts, keeps its files.
 *   - failedUploadCleanup: the multipart error path empties a folder only
 *     when its row is known not to be ready.
 * No DB and no storage: a recording fake stands in for the supabase-js query
 * builder and the storage adapter (the reaper route itself is never called;
 * lifecycle spec 44 covers it only behind REAPER_E2E=1).
 *
 * Run:  npx tsx tests/unit/failed-uploads.test.ts   (or npm run test:unit)
 */
import { failedUploadCleanup, markVersionFailed, type UploadRowStatus } from "../../lib/courses/upload";
import { DIRECT_UPLOAD_LIMITS, sweepAbandonedUploads } from "../../lib/courses/direct-upload";

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
      for (const op of ["select", "update", "insert", "delete", "eq", "neq", "in", "lt", "gt", "is", "order", "limit", "range"]) {
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
  };
  return { client: client as never, queries };
}
const has = (q: Query, op: string) => q.ops.some((o) => o.op === op);
const arg = (q: Query, op: string, col?: string) => q.ops.find((o) => o.op === op && (col === undefined || o.args[0] === col))?.args;
const isClaim = (q: Query) => q.table === "course_versions" && has(q, "update");

/** A fake storage adapter recording deletePrefix calls. */
function fakeStorage(opts: { throwOn?: string } = {}) {
  const deleted: string[] = [];
  const drivers: string[] = [];
  return {
    deleted,
    drivers,
    storageFor: async (driver: string) => {
      drivers.push(driver);
      return {
        async deletePrefix(prefix: string) {
          if (opts.throwOn === prefix) throw new Error("storage down");
          deleted.push(prefix);
        },
      };
    },
  };
}

async function main() {
  /* ---------------- markVersionFailed ---------------- */
  console.log("\nmarkVersionFailed (the claim)");
  {
    const { client, queries } = fakeClient((q) => (isClaim(q) ? { data: [{ id: "v1" }] } : {}));
    const r = await markVersionFailed(client, "v1");
    eq("claimed", r, { claimed: true, error: null });
    const q = queries[0];
    eq("one query, on course_versions", [queries.length, q.table], [1, "course_versions"]);
    eq("sets failed and frees the quota bytes", arg(q, "update"), [{ upload_status: "failed", size_bytes: 0 }]);
    eq("by id", arg(q, "eq", "id"), ["id", "v1"]);
    eq("only from 'uploading' by default", arg(q, "in", "upload_status"), ["upload_status", ["uploading"]]);
    eq("never a delete", queries.some((x) => has(x, "delete")), false);
  }
  {
    const { client, queries } = fakeClient(() => ({ data: [{ id: "v1" }] }));
    await markVersionFailed(client, "v1", ["uploading", "failed"]);
    eq("abort: 'failed' accepted too (idempotent)", arg(queries[0], "in", "upload_status"), ["upload_status", ["uploading", "failed"]]);
  }
  {
    const { client } = fakeClient(() => ({ data: [] }));
    eq("a row finalised meanwhile → not claimed", await markVersionFailed(client, "v1"), { claimed: false, error: null });
  }
  {
    const { client } = fakeClient(() => ({ error: { message: 'column "upload_status" does not exist' } }));
    eq("database error → not claimed, error passed on", await markVersionFailed(client, "v1"), {
      claimed: false,
      error: 'column "upload_status" does not exist',
    });
  }

  /* ---------------- sweepAbandonedUploads ---------------- */
  console.log("\nsweepAbandonedUploads (the reaper hook, D1)");
  const NOW = Date.parse("2026-10-17T12:00:00Z");
  const stale = [
    { id: "va", storage_prefix: "courses/c1/p1/v2/", storage_driver: "r2", upload_started_at: "2026-10-15T00:00:00Z" },
    { id: "vb", storage_prefix: "courses/c2/p2/v4/", storage_driver: "supabase", upload_started_at: "2026-10-15T00:00:00Z" },
  ];
  {
    const st = fakeStorage();
    const { client, queries } = fakeClient((q) => {
      if (q.table === "course_versions" && has(q, "lt")) return { data: stale };
      if (q.table === "course_attempts") return { count: 0 };
      if (isClaim(q)) return { data: [{ id: arg(q, "eq", "id")![1] }] };
      return {};
    });
    const r = await sweepAbandonedUploads(client, { storageFor: st.storageFor, now: NOW });
    eq("both swept, no errors", r, { swept: 2, errors: [] });
    const scan = queries[0];
    eq("scan: only 'uploading' rows", arg(scan, "eq", "upload_status"), ["upload_status", "uploading"]);
    eq("scan: older than the abandonment window", arg(scan, "lt", "upload_started_at"), [
      "upload_started_at",
      new Date(NOW - DIRECT_UPLOAD_LIMITS.abandonAfterMs).toISOString(),
    ]);
    const claims = queries.filter(isClaim);
    eq("each row claimed once", claims.map((q) => arg(q, "eq", "id")![1]), ["va", "vb"]);
    eq("claim → failed, size 0", claims.map((q) => arg(q, "update")![0]), [
      { upload_status: "failed", size_bytes: 0 },
      { upload_status: "failed", size_bytes: 0 },
    ]);
    eq("claim conditional on 'uploading'", claims.map((q) => arg(q, "in", "upload_status")![1]), [["uploading"], ["uploading"]]);
    eq("no row is ever deleted", queries.some((q) => has(q, "delete")), false);
    eq("each prefix emptied (no trailing slash), on its own driver", [st.deleted, st.drivers], [
      ["courses/c1/p1/v2", "courses/c2/p2/v4"],
      ["r2", "supabase"],
    ]);
    // Order: the claim precedes the delete, so a lost race never deletes.
    const claimIdx = queries.findIndex((q) => isClaim(q) && arg(q, "eq", "id")![1] === "va");
    const attemptIdx = queries.findIndex((q) => q.table === "course_attempts");
    eq("attempt check before the claim", attemptIdx < claimIdx, true);
  }
  {
    const st = fakeStorage();
    const { client, queries } = fakeClient((q) => {
      if (q.table === "course_versions" && has(q, "lt")) return { data: [stale[0]] };
      if (q.table === "course_attempts") return { count: 0 };
      if (isClaim(q)) return { data: [] }; // finalised (or aborted) since the scan
      return {};
    });
    const r = await sweepAbandonedUploads(client, { storageFor: st.storageFor, now: NOW });
    eq("finalised meanwhile → not swept", r, { swept: 0, errors: [] });
    eq("…and its files are untouched", st.deleted, []);
    eq("…and nothing deleted", queries.some((q) => has(q, "delete")), false);
  }
  {
    const st = fakeStorage();
    const { client, queries } = fakeClient((q) => {
      if (q.table === "course_versions" && has(q, "lt")) return { data: [stale[0]] };
      if (q.table === "course_attempts") return { count: 3 };
      return { data: [{ id: "va" }] };
    });
    const r = await sweepAbandonedUploads(client, { storageFor: st.storageFor, now: NOW });
    eq("a row holding attempts is skipped and reported", r, {
      swept: 0,
      errors: ["va: skipped, 3 attempt(s) on an 'uploading' version"],
    });
    eq("…never claimed", queries.some(isClaim), false);
    eq("…files untouched", st.deleted, []);
  }
  {
    const st = fakeStorage();
    const { client } = fakeClient((q) => {
      if (q.table === "course_versions" && has(q, "lt")) return { data: [stale[0]] };
      if (q.table === "course_attempts") return { count: 0 };
      if (isClaim(q)) return { error: { message: "boom" } };
      return {};
    });
    const r = await sweepAbandonedUploads(client, { storageFor: st.storageFor, now: NOW });
    eq("claim error → reported, files untouched", [r, st.deleted], [{ swept: 0, errors: ["va: could not mark failed: boom"] }, []]);
  }
  {
    const st = fakeStorage({ throwOn: "courses/c1/p1/v2" });
    const { client } = fakeClient((q) => {
      if (q.table === "course_versions" && has(q, "lt")) return { data: [stale[0]] };
      if (q.table === "course_attempts") return { count: 0 };
      if (isClaim(q)) return { data: [{ id: "va" }] };
      return {};
    });
    const r = await sweepAbandonedUploads(client, { storageFor: st.storageFor, now: NOW });
    eq("prefix delete fails → the row is still failed (swept), the error reported", r, {
      swept: 1,
      errors: ["va: storage down"],
    });
  }
  {
    const { client } = fakeClient(() => ({ error: { message: "scan failed" } }));
    eq("scan error → reported", await sweepAbandonedUploads(client, { storageFor: fakeStorage().storageFor, now: NOW }), {
      swept: 0,
      errors: ["scan failed"],
    });
  }

  /* ---------------- failedUploadCleanup (multipart error path) ---------------- */
  console.log("\nfailedUploadCleanup (the multipart error path never empties a ready version)");
  {
    const plan = (claimed: boolean, rowDeleted: boolean, status: UploadRowStatus | null, createdCourse: boolean) =>
      failedUploadCleanup({ claimed, rowDeleted, status, createdCourse });
    const keep = { landed: false, emptyFolder: false, deleteCourse: false };
    const empty = { landed: false, emptyFolder: true, deleteCourse: false };
    const emptyAndCourse = { landed: false, emptyFolder: true, deleteCourse: true };
    const landed = { landed: true, emptyFolder: false, deleteCourse: false };
    eq("claimed by this call → empty the folder", plan(true, false, null, false), empty);
    eq("claimed, course created by this call → folder and course go", plan(true, false, null, true), emptyAndCourse);
    eq("pre-0077 row delete → empty the folder", plan(false, true, null, false), empty);
    eq("re-read 'ready' (only the answer of the ready flip was lost) → keep and publish", plan(false, false, "ready", false), landed);
    eq("re-read 'ready' on a course created by this call → kept too", plan(false, false, "ready", true), landed);
    eq("re-read 'failed' (Discard mid-upload) → empty the folder", plan(false, false, "failed", false), empty);
    eq("row gone → empty the folder", plan(false, false, "missing", false), empty);
    eq("still 'uploading' (claim error) → files kept for the reaper", plan(false, false, "uploading", false), keep);
    eq("unreadable → files kept", plan(false, false, "unknown", false), keep);
    eq("unreadable, course created by this call → course and folder go together", plan(false, false, "unknown", true), emptyAndCourse);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
