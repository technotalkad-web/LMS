/**
 * Unit test for the live "abandoned" LRS statement (gap 4; ADR 0008 step 5).
 *
 *  - The statement id is the sweeper's: uuid5("abandoned:<attemptId>") in the
 *    LMS namespace (fixed vector cross-checked with Python's uuid.uuid5).
 *  - The live enqueue at an abandon site and the sweeper's attempts source
 *    produce the same outbox statement id (and the same payload), so the
 *    outbox unique key (org, statement_id) keeps one row.
 *  - Org gate: no config, forwarding off, no endpoint, raw profile or a
 *    pre-0078 config → no outbox row.
 *  - Fail-soft: an outbox or read error never throws; a row that is not
 *    abandoned is never queued; nothing is posted (no fetch).
 *
 * Run:  npx tsx tests/unit/lrs-abandoned.test.ts   (or npm run test:unit)
 * (No DB: a fake query builder answers by table name.)
 */
import { abandonedStatementId } from "../../lib/lrs/statement-id";
import { uuid5 } from "../../lib/lrs/uuid5";
import { derivedStatementsSkip, type LrsConfig } from "../../lib/lrs/config";
import { runSource } from "../../lib/lrs/sweep";
import { verb } from "../../lib/lrs/profile";
import { enqueueAbandonedStatements } from "../../lib/lrs/abandoned";
import type { SupabaseClient } from "@supabase/supabase-js";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

const ATTEMPT = "11111111-2222-4333-8444-555555555555";
const ORG = "99999999-8888-4777-8666-555555555555";
const USER = "22222222-3333-4444-8555-666666666666";
const VERSION = "33333333-4444-4555-8666-777777777777";
const COURSE = "44444444-5555-4666-8777-888888888888";

console.log("\nstatement id");
eq("fixed vector (Python uuid.uuid5, LMS namespace)", abandonedStatementId(ATTEMPT), "3a072959-c510-5f53-8ceb-86472b20146d");
eq("= the sweeper's uuid5(`abandoned:<id>`)", abandonedStatementId(ATTEMPT), uuid5(`abandoned:${ATTEMPT}`));

console.log("\norg gate (derivedStatementsSkip)");
const cfg = (over: Partial<LrsConfig> & Record<string, unknown> = {}): LrsConfig =>
  ({
    organization_id: ORG, enabled: true, endpoint: "https://lrs.example.test/xapi", auth_key: null, auth_secret: null,
    xapi_version: "1.0.3", statement_profile: "ambak-v1", backfill_cursor: {}, last_test_at: null, last_test_status: null,
    last_test_error: null, ...over,
  }) as LrsConfig;
eq("no config row → disabled", derivedStatementsSkip(null), "disabled");
eq("forwarding off → disabled", derivedStatementsSkip(cfg({ enabled: false })), "disabled");
eq("no endpoint → disabled", derivedStatementsSkip(cfg({ endpoint: null })), "disabled");
eq("raw profile → skipped", derivedStatementsSkip(cfg({ statement_profile: "raw" })), "raw profile");
{
  const pre = cfg();
  delete (pre as Record<string, unknown>).backfill_cursor;
  eq("pre-0078 config → skipped", derivedStatementsSkip(pre), "migration 0078 not applied");
}
eq("enabled ambak-v1 → queued", derivedStatementsSkip(cfg()), null);

// ---- fake Supabase client --------------------------------------------------
type Upsert = { table: string; rows: Array<Record<string, unknown>>; opts: unknown };
function fakeDb(tables: Record<string, unknown[]>, opts: { failUpsert?: boolean; failRead?: string } = {}) {
  const upserts: Upsert[] = [];
  const from = (table: string) => {
    let single = false;
    let result: unknown = null;
    const builder: Record<string | symbol, unknown> = {};
    const proxy: unknown = new Proxy(builder, {
      get(_t, prop) {
        if (prop === "then") {
          const value =
            result ??
            (opts.failRead === table
              ? { data: null, error: { message: "boom", code: "XX000" } }
              : { data: single ? (tables[table] ?? [])[0] ?? null : tables[table] ?? [], error: null });
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(value).then(res, rej);
        }
        if (prop === "maybeSingle" || prop === "single") return () => ((single = true), proxy);
        if (prop === "upsert") {
          return (rows: Array<Record<string, unknown>>, o: unknown) => {
            if (opts.failUpsert) throw new Error("outbox down");
            upserts.push({ table, rows, opts: o });
            result = { data: null, error: null };
            return proxy;
          };
        }
        return () => proxy;
      },
    });
    return proxy;
  };
  return { db: { from } as unknown as SupabaseClient, upserts };
}

const attemptRow = (status: string) => ({
  id: ATTEMPT,
  user_id: USER,
  organization_id: ORG,
  course_version_id: VERSION,
  learning_path_id: null,
  journey_enrollment_id: null,
  journey_day: null,
  started_at: "2026-10-01T09:00:00.000Z",
  last_activity_at: "2026-10-02T10:30:00.000Z",
  status,
  course_versions: {
    id: VERSION,
    course_id: COURSE,
    version_number: 1,
    manifest_type: "scorm12",
    package_id: null,
    manifest_data: {},
    courses: { id: COURSE, title: "QA course" },
    course_packages: null,
  },
});

async function main() {
  // Make sure nothing is posted: any fetch fails the test.
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched++;
    throw new Error("no network in unit tests");
  }) as typeof fetch;

  console.log("\nlive enqueue = sweeper (same id, same payload)");
  {
    const tables = { course_attempts: [attemptRow("abandoned")], tenant_lrs_config: [cfg()] };
    const live = fakeDb(tables);
    await enqueueAbandonedStatements(live.db, [ATTEMPT, ATTEMPT, ""]);
    const out = live.upserts.filter((u) => u.table === "lrs_forward_outbox");
    eq("one outbox upsert", out.length, 1);
    const row = out[0]?.rows[0] ?? {};
    eq("one row", out[0]?.rows.length, 1);
    eq("statement id", row.statement_id, abandonedStatementId(ATTEMPT));
    eq("org", row.organization_id, ORG);
    eq("attempt", row.attempt_id, ATTEMPT);
    eq("pending, origin lms", [row.status, row.origin], ["pending", "lms"]);
    eq("unique key + first copy wins", out[0]?.opts, { onConflict: "organization_id,statement_id", ignoreDuplicates: true });
    const payload = row.payload as { id?: string; verb?: { id?: string }; timestamp?: string; context?: { registration?: string } };
    eq("payload id = statement id", payload?.id, row.statement_id);
    eq("verb abandoned", payload?.verb?.id, verb.abandoned);
    eq("timestamp = last activity (as the sweeper)", payload?.timestamp, "2026-10-02T10:30:00.000Z");
    eq("registration = attempt", payload?.context?.registration, ATTEMPT);

    const sweep = await runSource(fakeDb(tables).db, "attempts", ORG);
    const ab = sweep.statements.find((s) => s.verb?.id === verb.abandoned);
    eq("sweeper builds the abandoned statement", !!ab, true);
    eq("sweeper id = live id", ab?.id, row.statement_id);
    eq("sweeper payload = live payload", ab, payload);
  }

  console.log("\nonly abandoned rows, only gated orgs");
  {
    const live = fakeDb({ course_attempts: [attemptRow("in_progress")], tenant_lrs_config: [cfg()] });
    await enqueueAbandonedStatements(live.db, [ATTEMPT]);
    eq("an attempt still in progress is not queued", live.upserts.length, 0);
  }
  for (const [name, c] of [
    ["no config row", null],
    ["forwarding off", cfg({ enabled: false })],
    ["raw profile", cfg({ statement_profile: "raw" })],
  ] as const) {
    const live = fakeDb({ course_attempts: [attemptRow("abandoned")], tenant_lrs_config: c ? [c] : [] });
    await enqueueAbandonedStatements(live.db, [ATTEMPT]);
    eq(`${name} → no outbox row`, live.upserts.length, 0);
  }
  {
    const live = fakeDb({ course_attempts: [attemptRow("abandoned")], tenant_lrs_config: [cfg()] });
    await enqueueAbandonedStatements(live.db, []);
    eq("no ids → nothing read or written", live.upserts.length, 0);
  }

  console.log("\nfail-soft");
  {
    const live = fakeDb({ course_attempts: [attemptRow("abandoned")], tenant_lrs_config: [cfg()] }, { failUpsert: true });
    let threw = false;
    try {
      await enqueueAbandonedStatements(live.db, [ATTEMPT]);
    } catch {
      threw = true;
    }
    eq("outbox error does not throw", threw, false);
  }
  {
    const live = fakeDb({ course_attempts: [attemptRow("abandoned")], tenant_lrs_config: [cfg()] }, { failRead: "course_attempts" });
    let threw = false;
    try {
      await enqueueAbandonedStatements(live.db, [ATTEMPT]);
    } catch {
      threw = true;
    }
    eq("attempts read error does not throw", threw, false);
    eq("attempts read error → no row", live.upserts.length, 0);
  }
  eq("nothing posted to an LRS", fetched, 0);
  globalThis.fetch = realFetch;

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
