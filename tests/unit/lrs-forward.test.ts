/**
 * Unit tests for the external-LRS transport, lib/lrs/forward.ts, against a fake
 * LRS behind a stubbed globalThis.fetch.
 *
 * The fake behaves as a real LRS does: it stores a batch atomically, and it
 * answers 400 if any statement in the batch is malformed and 409 if any id is
 * already held with different content, storing none of that batch.
 *
 * The rule asserted for every statement of every case: the forwarder says ok
 * only if that statement reached the fake's store, or if that statement alone
 * answered 409 (the LRS holds that id; the idempotent success).
 *
 * The second half runs both callers for real against the same fake and a stubbed
 * PostgREST: app/api/cron/lrs-forward/route.ts over repeated runs on a fake clock
 * (a statement the isolation budget did not reach counts no failed attempt, so it
 * never dead-letters for that, while an outage still backs off and dead-letters),
 * and lib/lrs/enqueue.ts (only what the LRS accepted is marked sent).
 *
 * A 200 counts only if it carries a list of ids, and the redirect shapes behind
 * that rule depend on what the real fetch does, so those cases post to a server
 * bound to 127.0.0.1 in this process.
 *
 * No database, and no network beyond that server.
 *
 * Run:  npx tsx tests/unit/lrs-forward.test.ts   (or npm run test:unit)
 */
import http from "node:http";
import { forwardStatements, shuffled, testConnection, type ForwardResult } from "../../lib/lrs/forward";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

type Stmt = { id: string; verb?: { id: string } };
const VERB = { id: "http://adlnet.gov/expapi/verbs/experienced" };
const realFetch = globalThis.fetch;

/** A batch of n statements, s0 to s(n-1). `poison` have no verb (malformed). */
function batch(n: number, poison: number[] = []): Stmt[] {
  return Array.from({ length: n }, (_, i) => (poison.includes(i) ? { id: `s${i}` } : { id: `s${i}`, verb: VERB }));
}

type Answer = number | "network";

/**
 * The fake LRS. `conflicts` are ids it already holds with different content.
 * `force`, when given, answers a post in its place: a status (nothing stored)
 * or "network" (fetch rejects). Returning undefined leaves the post to the fake.
 */
function fakeLrs(conflicts: string[] = [], force?: (list: Stmt[], postNumber: number) => Answer | undefined) {
  const held = new Set(conflicts);
  const stored = new Set<string>();
  const aloneConflict = new Set<string>();
  const posts: string[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const list = JSON.parse(String(init?.body)) as Stmt[];
    const forced = force?.(list, posts.length + 1);
    if (forced === "network") {
      posts.push(`${list.length}:network`);
      throw new TypeError("fetch failed");
    }
    let status = forced ?? 200;
    if (forced === undefined) {
      if (list.some((s) => !s.verb)) status = 400;
      else if (list.some((s) => held.has(s.id))) status = 409;
      else for (const s of list) stored.add(s.id);
    }
    if (status === 409 && list.length === 1) aloneConflict.add(list[0].id);
    posts.push(`${list.length}:${status}`);
    return new Response(status === 204 ? null : status >= 200 && status < 300 ? "[]" : JSON.stringify({ error: { message: `status ${status}` } }), { status });
  }) as typeof fetch;
  return { stored, aloneConflict, posts };
}

const CFG = { endpoint: "http://lrs.test/xapi", auth_key: "k", auth_secret: "s", xapi_version: "1.0.3" };

const outcomeOf = (res: ForwardResult, id: string) => (res.results ? res.results[id] : res);

/** The per-statement rule. Returns the ids that break it, so a failure names them. */
function ruleBreakers(res: ForwardResult, lrs: ReturnType<typeof fakeLrs>, statements: Stmt[]): string[] {
  return statements
    .filter((s) => {
      const o = outcomeOf(res, s.id);
      if (!o) return true; // every statement has an outcome
      return o.ok ? !(lrs.stored.has(s.id) || lrs.aloneConflict.has(s.id)) : lrs.stored.has(s.id);
    })
    .map((s) => s.id);
}

const okIds = (res: ForwardResult, statements: Stmt[]) => statements.filter((s) => outcomeOf(res, s.id)?.ok).map((s) => s.id);

/** A generator with a fixed sequence (mulberry32), so a shuffled order is the same on every run of this file. */
function seeded(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The endpoint answers every post the same way and stores nothing. */
function answering(status: number, body: () => BodyInit | null) {
  const posts: string[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    posts.push(`${(JSON.parse(String(init?.body)) as Stmt[]).length}:${status}`);
    return new Response(body(), { status });
  }) as typeof fetch;
  return { posts };
}

type Loopback = { url: string; address: string; posts: number; gets: number; stored: string[]; close: () => Promise<void> };

/** A real server on 127.0.0.1, with the real fetch, so its redirects are followed as they are in production. */
async function onLoopback(handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string, s: Loopback) => void): Promise<Loopback> {
  globalThis.fetch = realFetch;
  const s = { posts: 0, gets: 0, stored: [] as string[] } as Loopback;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "POST") s.posts++;
      else s.gets++;
      handler(req, res, body, s);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address() as { port: number; address: string };
  s.url = `http://127.0.0.1:${a.port}/xapi`;
  s.address = a.address;
  s.close = () => new Promise<void>((r) => server.close(() => r()));
  return s;
}

/* ---------------- the callers: a stubbed PostgREST, the fake LRS, a fake clock ---------------- */

type Row = { id: string; organization_id: string; statement_id: string; payload: Stmt; status: string; attempts: number; next_attempt_at: string; last_error: string | null };
type Spec = { org?: string; conflict?: boolean; poison?: boolean; fail500?: boolean; attempts?: number; rowStatementId?: (id: string) => string; idIn?: (id: string) => string };
type LrsMode = "fake" | 503 | 401 | "network" | "page200";
type ConfigAnswer = "enabled" | "disabled" | "no endpoint" | "no row" | 500;

const CADENCE_MS = 5 * 60_000;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const list = (v: string | null) => (v ?? "").replace(/^in\.\(|\)$/g, "").split(",").map((x) => x.replace(/^"|"$/g, ""));

/** An outbox, an LRS and a clock. n rows, s0 to s(n-1), in the order given. `config` answers the org's config read in place of a healthy one. */
function world(specs: Spec[], mode: LrsMode = "fake", config?: (org: string) => ConfigAnswer) {
  const start = Date.parse("2026-01-01T00:00:00.000Z");
  const clock = { now: start };
  const rows: Row[] = specs.map((sp, i) => {
    const id = (sp.idIn ?? ((x: string) => x))(`s${i}`);
    return {
      id: `row-${i}`,
      organization_id: sp.org ?? "org-a",
      statement_id: (sp.rowStatementId ?? ((x: string) => x))(id),
      payload: sp.poison ? { id } : { id, verb: VERB },
      status: (sp.attempts ?? 0) > 0 ? "failed" : "pending",
      attempts: sp.attempts ?? 0,
      next_attempt_at: new Date(start).toISOString(),
      last_error: null,
    };
  });
  const conflicts = new Set(rows.filter((_, i) => specs[i].conflict).map((r) => r.payload.id));
  const fail500 = new Set(rows.filter((_, i) => specs[i].fail500).map((r) => r.payload.id));
  const stored = new Set<string>();
  const aloneConflict = new Set<string>();
  const postedIds: string[][] = [];
  const random = seeded(20261105);
  let postsThisRun = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.host === "lrs.test") {
      postsThisRun++;
      if (mode === "network") throw new TypeError("fetch failed");
      if (mode === "page200") return new Response("<html>sign in</html>", { status: 200 });
      if (mode !== "fake") return json({ error: `status ${mode}` }, mode);
      const posted = JSON.parse(String(init?.body)) as Stmt[];
      postedIds.push(posted.map((p) => p.id));
      if (posted.some((p) => !p.verb)) return json({ error: "malformed" }, 400);
      if (posted.some((p) => fail500.has(p.id))) return json({ error: "cannot store" }, 500);
      if (posted.some((p) => conflicts.has(p.id))) {
        if (posted.length === 1) aloneConflict.add(posted[0].id);
        return json({ error: "conflict" }, 409);
      }
      for (const p of posted) stored.add(p.id);
      return json(posted.map((p) => p.id));
    }
    if (url.pathname === "/rest/v1/lrs_forward_outbox") {
      if (method === "GET") {
        const lte = (url.searchParams.get("next_attempt_at") ?? "").replace(/^lte\./, "");
        const due = rows
          .filter((r) => (r.status === "pending" || r.status === "failed") && r.next_attempt_at <= lte)
          .map((r, i) => ({ r, i }))
          .sort((a, b) => a.r.next_attempt_at.localeCompare(b.r.next_attempt_at) || a.i - b.i)
          .slice(0, Number(url.searchParams.get("limit")))
          .map((x) => x.r);
        return json(due);
      }
      if (method === "PATCH") {
        const ids = new Set(list(url.searchParams.get("id")));
        const patch = JSON.parse(String(init?.body)) as Partial<Row>;
        for (const r of rows) if (ids.has(r.id)) Object.assign(r, patch);
        return new Response(null, { status: 204 });
      }
      if (method === "DELETE") {
        const ids = new Set(list(url.searchParams.get("id")));
        for (let i = rows.length - 1; i >= 0; i--) if (ids.has(rows[i].id)) rows.splice(i, 1);
        return new Response(null, { status: 204 });
      }
    }
    if (url.pathname === "/rest/v1/tenant_lrs_config") {
      // No backfill_cursor: the sweep skips the org, so a run counts the drain only.
      const org = (url.searchParams.get("organization_id") ?? "").replace(/^eq\./, "");
      const cfg = (o: string) => ({ organization_id: o, enabled: true, endpoint: "http://lrs.test/xapi", auth_key: "k", auth_secret: "s", xapi_version: "1.0.3" });
      if (!org) return json([...new Set(rows.map((r) => r.organization_id))].map(cfg));
      const answer = config?.(org) ?? "enabled";
      if (answer === 500) return json({ message: "upstream connect error" }, 500);
      if (answer === "no row") return json([]);
      if (answer === "disabled") return json([{ ...cfg(org), enabled: false }]);
      if (answer === "no endpoint") return json([{ ...cfg(org), endpoint: null }]);
      return json([cfg(org)]);
    }
    return json([], 201);
  }) as typeof fetch;

  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...a: unknown[]) {
      if (a.length === 0) super(clock.now);
      else super(...(a as [string]));
    }
    static now() { return clock.now; }
  }
  const open = () => rows.filter((r) => r.status === "pending" || r.status === "failed").length;
  return {
    rows,
    stored,
    aloneConflict,
    postedIds,
    open,
    /** One cron firing, 5 minutes after the last. Answers the route's body and the posts it made. */
    async run() {
      const { POST } = await import("../../app/api/cron/lrs-forward/route");
      clock.now += CADENCE_MS;
      postsThisRun = 0;
      (globalThis as { Date: unknown }).Date = FakeDate;
      const realRandom = Math.random;
      Math.random = random;
      try {
        const res = await POST(new Request("http://lms.test/api/cron/lrs-forward", { method: "POST", headers: { "x-cron-secret": "stub-cron" } }));
        return { body: (await res.json()) as Record<string, unknown>, posts: postsThisRun };
      } finally {
        (globalThis as { Date: unknown }).Date = RealDate;
        Math.random = realRandom;
      }
    },
    /** Fires until no row is open or the horizon passes. */
    async drain(horizon = 3000) {
      let runs = 0, firings = 0, maxPosts = 0;
      while (open() > 0 && firings < horizon) {
        const { posts } = await this.run();
        firings++;
        if (posts > 0) runs = firings;
        maxPosts = Math.max(maxPosts, posts);
      }
      return { runs, firings, maxPosts, hours: (runs * CADENCE_MS) / 3_600_000 };
    },
    /** A row marked sent whose statement the LRS neither stored nor answered 409 for alone. */
    sentNeverStored: () => rows.filter((r) => r.status === "sent" && !stored.has(r.payload.id) && !aloneConflict.has(r.payload.id)).map((r) => r.id),
  };
}

const rowsOf = (n: number, f: (i: number) => Spec = () => ({})) => Array.from({ length: n }, (_, i) => f(i));
const countBy = (rows: Row[], status: string) => rows.filter((r) => r.status === status).length;
const maxAttempts = (rows: Row[]) => rows.reduce((m, r) => Math.max(m, r.attempts), 0);

async function routeCases() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://stub.supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-key";
  process.env.CRON_SECRET = "stub-cron";

  console.log("\nthe cron route: one run");
  {
    const w = world(rowsOf(200, () => ({ conflict: true })));
    const { body, posts } = await w.run();
    eq("every row of 200 conflicts, run 1: the counts", [body.processed, body.sent, body.failed, body.dead, body.unsettled], [200, 6, 0, 0, 194]);
    eq("every row of 200 conflicts, run 1: 17 posts", posts, 17);
    const left = w.rows.filter((r) => r.status === "pending");
    eq("every row of 200 conflicts, run 1: unreached rows keep attempts 0", maxAttempts(left), 0);
    eq("every row of 200 conflicts, run 1: and say why", new Set(left.map((r) => r.last_error)).size === 1 && /not reached/.test(String(left[0].last_error)), true);
    eq("every row of 200 conflicts, run 1: and stay due for the next run", left.every((r) => r.next_attempt_at <= new Date(Date.parse("2026-01-01T00:05:00.000Z")).toISOString()), true);
  }

  { const w = world(rowsOf(200, () => ({ conflict: true, attempts: 3 }))); await w.run(); const left = w.rows.filter((r) => /not reached/.test(String(r.last_error))); eq("unreached rows that had already failed keep their status and attempts", [left.length, left.every((r) => r.status === "failed" && r.attempts === 3)], [194, true]); }

  console.log("\nthe cron route: repeated runs until the batch is drained");
  const drains: Array<{ name: string; specs: Spec[]; runs: number; sent: number; dead: number }> = [
    { name: "every row of 200 conflicts", specs: rowsOf(200, () => ({ conflict: true })), runs: 32, sent: 200, dead: 0 },
    { name: "half of 200 conflict, every second row", specs: rowsOf(200, (i) => ({ conflict: i % 2 === 0 })), runs: 32, sent: 200, dead: 0 },
    { name: "half of 200 conflict, the first 100", specs: rowsOf(200, (i) => ({ conflict: i < 100 })), runs: 18, sent: 200, dead: 0 },
    { name: "one conflict in 200", specs: rowsOf(200, (i) => ({ conflict: i === 0 })), runs: 1, sent: 200, dead: 0 },
    { name: "one conflict and one malformed in 200, different halves", specs: rowsOf(200, (i) => ({ poison: i === 3, conflict: i === 150 })), runs: 2, sent: 199, dead: 1 },
    { name: "one conflict and one malformed in 25, different halves", specs: rowsOf(25, (i) => ({ poison: i === 3, conflict: i === 20 })), runs: 2, sent: 24, dead: 1 },
    { name: "every row of 200 conflicts, all already at attempts 35", specs: rowsOf(200, () => ({ conflict: true, attempts: 35 })), runs: 32, sent: 200, dead: 0 },
    { name: "a backlog of 1000, every row conflicts", specs: rowsOf(1000, () => ({ conflict: true })), runs: 165, sent: 1000, dead: 0 },
    { name: "a backlog of 1000, half conflict", specs: rowsOf(1000, (i) => ({ conflict: i % 2 === 0 })), runs: 165, sent: 1000, dead: 0 },
  ];
  for (const d of drains) {
    const w = world(d.specs);
    const r = await w.drain();
    eq(`${d.name}: drained in ${d.runs} run(s)`, [w.open(), r.runs], [0, d.runs]);
    eq(`${d.name}: sent and dead`, [countBy(w.rows, "sent"), countBy(w.rows, "dead")], [d.sent, d.dead]);
    eq(`${d.name}: no row marked sent unless stored or alone 409`, w.sentNeverStored(), []);
    eq(`${d.name}: never more than 17 posts in a run`, r.maxPosts <= 17, true);
    eq(`${d.name}: every good statement is stored`, d.specs.filter((sp) => !sp.conflict && !sp.poison).length, w.stored.size);
    eq(`${d.name}: no attempt counted against a row that was not rejected`, [...new Set(w.rows.filter((_, i) => !d.specs[i].poison).map((r) => r.attempts))], [d.specs[0].attempts ?? 0]);
  }

  console.log("\nthe cron route: a broken endpoint still backs off and dead-letters");
  {
    const w = world(rowsOf(200), 503);
    const first = await w.run();
    eq("every post answers 503, run 1: every row failed, attempt counted", [first.body.failed, first.body.unsettled, maxAttempts(w.rows), w.rows.every((r) => r.attempts === 1)], [200, 0, 1, true]);
    eq("every post answers 503, run 1: the rows reached alone and the rows not reached both name the status", [/LRS HTTP 503/.test(String(w.rows[0].last_error)), /LRS HTTP 503/.test(String(w.rows[150].last_error))], [true, true]);
    const r = await w.drain();
    eq("every post answers 503: all dead at attempt 36", [countBy(w.rows, "dead"), maxAttempts(w.rows)], [200, 36]);
    eq("every post answers 503: within about 27 hours", r.hours > 24 && r.hours < 27, true);
  }
  {
    const w = world(rowsOf(200), "network");
    const first = await w.run();
    eq("LRS unreachable, run 1: one post, every row failed", [first.posts, first.body.failed, first.body.unsettled], [1, 200, 0]);
    await w.drain();
    eq("LRS unreachable: all dead at attempt 36", [countBy(w.rows, "dead"), maxAttempts(w.rows)], [200, 36]);
  }
  {
    const w = world(rowsOf(200), 401);
    const first = await w.run();
    eq("wrong secret, run 1: the 6 reached alone dead, the rest failed, nothing unsettled", [first.body.dead, first.body.failed, first.body.unsettled], [6, 194, 0]);
    eq("wrong secret, run 1: an attempt counted on every row", w.rows.every((r) => r.attempts === 1), true);
  }

  console.log("\nthe cron route: an endpoint that answers 200 without being an LRS");
  {
    const w = world(rowsOf(200), "page200");
    const first = await w.run();
    eq("a sign-in page answers 200, run 1: nothing sent, every row failed, attempt counted", [first.body.sent, first.body.failed, first.body.unsettled, w.rows.every((r) => r.attempts === 1)], [0, 200, 0, true]);
    eq("a sign-in page answers 200, run 1: the error says why, the page does not reach it", new Set(w.rows.map((r) => r.last_error)).size === 1 && w.rows[0].last_error, "LRS HTTP 502: LRS answered 200 without a list of statement ids");
    const r = await w.drain();
    eq("a sign-in page answers 200: all dead at attempt 36, none sent", [countBy(w.rows, "dead"), countBy(w.rows, "sent"), maxAttempts(w.rows)], [200, 0, 36]);
    eq("a sign-in page answers 200: within about 27 hours", r.hours > 24 && r.hours < 27, true);
  }

  console.log("\nthe cron route: a failed read of the org's config");
  {
    let answer: ConfigAnswer = 500;
    const w = world(rowsOf(50), "fake", () => answer);
    const first = await w.run();
    eq("one 500 on the config read: no row is deleted and nothing is posted", [w.rows.length, first.posts], [50, 0]);
    eq("one 500 on the config read: the rows are as they were, still due", w.rows.every((r) => r.status === "pending" && r.attempts === 0 && r.last_error === null && r.next_attempt_at === "2026-01-01T00:00:00.000Z"), true);
    answer = "enabled";
    const second = await w.run();
    eq("one 500 on the config read: the next run delivers them", [second.body.sent, countBy(w.rows, "sent"), w.stored.size], [50, 50, 50]);
  }
  {
    const w = world([...rowsOf(5), ...rowsOf(5, () => ({ org: "org-b" }))], "fake", (org) => (org === "org-a" ? 500 : "enabled"));
    const { body } = await w.run();
    eq("a failed read for one org: the next org in the run is still delivered", [body.sent, w.rows.filter((r) => r.organization_id === "org-b" && r.status === "sent").length], [5, 5]);
    eq("a failed read for one org: its own rows stay due", w.rows.filter((r) => r.organization_id === "org-a" && r.status === "pending").length, 5);
  }
  {
    const w = world(rowsOf(5), "fake", () => "no row");
    await w.run();
    eq("no config row, which reads the same as a failed read: the rows stay", w.rows.length, 5);
  }
  {
    const w = world(rowsOf(5), "fake", () => "disabled");
    const { posts } = await w.run();
    eq("a config row that is disabled: its rows are dropped, as before", [w.rows.length, posts], [0, 0]);
  }
  {
    const w = world(rowsOf(5), "fake", () => "no endpoint");
    const { posts } = await w.run();
    eq("a config row with no endpoint: its rows are dropped, as before", [w.rows.length, posts], [0, 0]);
  }

  console.log("\nthe cron route: the order a batch is posted in");
  {
    const w = world(rowsOf(8));
    await w.run();
    eq("a first send keeps its order", w.postedIds[0], ["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7"]);
  }
  {
    const w = world(rowsOf(8, (i) => ({ attempts: i === 7 ? 1 : 0 })));
    await w.run();
    eq("one row has already failed: the batch goes in a new order", w.postedIds[0].join() !== "s0,s1,s2,s3,s4,s5,s6,s7", true);
    eq("one row has already failed: every row is still posted, once", w.postedIds[0].slice().sort(), ["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7"]);
    eq("one row has already failed: every row settles on its own outcome", [countBy(w.rows, "sent"), w.stored.size], [8, 8]);
  }
  {
    // Nothing has failed: the rows the budget did not reach keep attempts 0, so the next run keeps their order too.
    const w = world(rowsOf(200, () => ({ conflict: true })));
    await w.run();
    await w.run();
    eq("rows the budget did not reach, attempts 0: the next run keeps their order", (w.postedIds[17] ?? []).slice(0, 3), ["s6", "s7", "s8"]);
  }

  console.log("\nthe cron route: rows that keep failing at the head of a batch do not take the others with them");
  const heads: Array<{ name: string; specs: Spec[]; dead: number; stored: number }> = [
    { name: "the first 6 of 200 answer 500 alone", specs: rowsOf(200, (i) => ({ fail500: i < 6 })), dead: 6, stored: 194 },
    { name: "the first 50 of 200 answer 500 alone", specs: rowsOf(200, (i) => ({ fail500: i < 50 })), dead: 50, stored: 150 },
    { name: "the first 8 of 25 answer 500 alone", specs: rowsOf(25, (i) => ({ fail500: i < 8 })), dead: 8, stored: 17 },
    { name: "every fourth of 200 answers 500 alone", specs: rowsOf(200, (i) => ({ fail500: i % 4 === 0 })), dead: 50, stored: 150 },
    { name: "the first 6 of 200 are malformed, every row at attempts 35", specs: rowsOf(200, (i) => ({ poison: i < 6, attempts: 35 })), dead: 6, stored: 194 },
  ];
  for (const h of heads) {
    const w = world(h.specs);
    await w.drain();
    eq(`${h.name}: only those rows are dead`, countBy(w.rows, "dead"), h.dead);
    eq(`${h.name}: every good statement is stored`, w.stored.size, h.stored);
    eq(`${h.name}: nothing left open`, w.open(), 0);
  }

  console.log("\nthe cron route: a row whose statement_id differs from the id in its payload");
  {
    // The sweep's copy: statement_id read from a uuid column (lower case), the payload keeps the engine's spelling.
    const upper = (id: string) => id.toUpperCase();
    const lower = (id: string) => id.toLowerCase();
    const w = world(rowsOf(8, (i) => ({ poison: i === 2, idIn: upper, rowStatementId: lower })));
    await w.run();
    eq("a malformed statement is dead, not sent", w.rows[2].status, "dead");
    eq("the good ones are stored, then sent", [countBy(w.rows, "sent"), w.stored.size], [7, 7]);
    eq("no row marked sent unless stored", w.sentNeverStored(), []);
  }

  console.log("\nthe cron route: another org's rows are not held behind a backlog");
  {
    const w = world([...rowsOf(1000, () => ({ conflict: true })), ...rowsOf(10, () => ({ org: "org-b" }))]);
    let firings = 0;
    while (w.rows.slice(1000).some((r) => r.status !== "sent") && firings < 20) {
      await w.run();
      firings++;
    }
    eq("org-b's 10 rows, behind org-a's 1000: sent on run 6", [firings, countBy(w.rows.slice(1000), "sent")], [6, 10]);
  }
  {
    const w = world([...rowsOf(100, () => ({ conflict: true })), ...rowsOf(100, () => ({ org: "org-b", conflict: true }))]);
    const { body } = await w.run();
    eq("two orgs in one run: the unsettled count adds both", body.unsettled, w.rows.filter((r) => r.status === "pending").length);
  }
}

async function enqueueCases() {
  const { mirrorToExternalLrs } = await import("../../lib/lrs/enqueue");
  const sentIds: string[] = [];
  const errored: string[] = [];
  const stored = new Set<string>();
  const aloneConflict = new Set<string>();
  let conflicts = new Set<string>();
  let signInPage = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.host === "lrs.test") {
      if (signInPage) return new Response("<html>sign in</html>", { status: 200 });
      const posted = JSON.parse(String(init?.body)) as Stmt[];
      if (posted.some((p) => !p.verb)) return json({ error: "malformed" }, 400);
      if (posted.some((p) => conflicts.has(p.id))) {
        if (posted.length === 1) aloneConflict.add(posted[0].id);
        return json({ error: "conflict" }, 409);
      }
      for (const p of posted) stored.add(p.id);
      return json(posted.map((p) => p.id));
    }
    if (url.pathname === "/rest/v1/course_attempts") return json([{ organization_id: "org-a" }]);
    if (url.pathname === "/rest/v1/tenant_lrs_config") {
      return json([{ organization_id: "org-a", enabled: true, endpoint: "http://lrs.test/xapi", auth_key: "k", auth_secret: "s", xapi_version: "1.0.3", statement_profile: "raw" }]);
    }
    if (url.pathname === "/rest/v1/lrs_forward_outbox" && method === "PATCH") {
      const ids = list(url.searchParams.get("statement_id"));
      const patch = JSON.parse(String(init?.body)) as { status?: string };
      (patch.status === "sent" ? sentIds : errored).push(...ids);
      return new Response(null, { status: 204 });
    }
    return json([], 201);
  }) as typeof fetch;
  const settle = () => new Promise((r) => setTimeout(r, 50));
  const reset = (c: string[]) => {
    sentIds.length = 0; errored.length = 0; stored.clear(); aloneConflict.clear();
    conflicts = new Set(c);
  };

  console.log("\nthe live mirror, lib/lrs/enqueue.ts");
  {
    reset(["s0"]);
    await mirrorToExternalLrs("att-1", batch(8) as never);
    await settle();
    eq("one conflict in 8: all 8 marked sent", sentIds.length, 8);
    eq("one conflict in 8: every one stored or alone 409", sentIds.filter((id) => !stored.has(id) && !aloneConflict.has(id)), []);
    eq("one conflict in 8: the 7 good ones stored", stored.size, 7);
  }
  {
    reset(["s20"]);
    await mirrorToExternalLrs("att-1", batch(25, [3]) as never);
    await settle();
    eq("one conflict and one malformed in 25: only what was accepted is marked sent", sentIds.filter((id) => !stored.has(id) && !aloneConflict.has(id)), []);
    eq("one conflict and one malformed in 25: the malformed and the unreached keep an error", errored.slice().sort(), ["s21", "s22", "s23", "s24", "s3"]);
  }
  {
    reset(["S20"]);
    await mirrorToExternalLrs("att-1", batch(25, [3]).map((s) => ({ ...s, id: s.id.toUpperCase() })) as never);
    await settle();
    eq("upper-case ids, one conflict and one malformed in 25: only what was accepted is marked sent", sentIds.filter((id) => !stored.has(id) && !aloneConflict.has(id)), []);
    eq("upper-case ids, one conflict and one malformed in 25: the malformed and the unreached keep an error", errored.slice().sort(), ["S21", "S22", "S23", "S24", "S3"]);
  }
  {
    reset([]);
    signInPage = true;
    await mirrorToExternalLrs("att-1", batch(8) as never);
    await settle();
    signInPage = false;
    eq("a sign-in page answers 200: nothing is marked sent", sentIds, []);
    eq("a sign-in page answers 200: every row keeps the error", errored.length, 8);
  }
}

/** The real fetch against a real server on 127.0.0.1: what a redirect does to a POST cannot be stubbed. */
async function loopbackCases() {
  console.log("\nthe real fetch: an endpoint that answers a POST with a redirect, or a 200 that is not an LRS's");
  const five = batch(5);
  const FIXED = "LRS HTTP 502: LRS answered 200 without a list of statement ids";
  const refused: Array<{ name: string; handler: Parameters<typeof onLoopback>[0]; gets: number }> = [
    {
      name: "302 to a sign-in page that answers GET with 200",
      gets: 1,
      handler: (req, res) => {
        if (req.method === "POST") res.writeHead(302, { location: "/login" }).end();
        else res.writeHead(200, { "content-type": "text/html" }).end("<html>sign in</html>");
      },
    },
    {
      name: "301 to /statements/, whose GET answers 200 with a JSON object",
      gets: 1,
      handler: (req, res) => {
        if (req.method === "POST") res.writeHead(301, { location: `${req.url}/` }).end();
        else res.writeHead(200, { "content-type": "application/json" }).end('{"statements":[],"more":""}');
      },
    },
    {
      name: "200 with an HTML page and no redirect",
      gets: 0,
      handler: (_req, res) => {
        res.writeHead(200, { "content-type": "text/html" }).end("<html>welcome</html>");
      },
    },
  ];
  for (const c of refused) {
    const s = await onLoopback(c.handler);
    eq(`${c.name}: the test server is on 127.0.0.1`, s.address, "127.0.0.1");
    const res = await forwardStatements({ ...CFG, endpoint: s.url }, five);
    eq(`${c.name}: nothing ok, retryable, and the error is the fixed text`, [okIds(res, five).length, res.permanent, outcomeOf(res, "s0")?.error], [0, false, FIXED]);
    eq(`${c.name}: the whole budget is spent, nothing stored`, [s.posts, s.gets === c.gets * s.posts, s.stored.length], [9, true, 0]);
    await s.close();
  }
  {
    const s = await onLoopback((req, res, body, srv) => {
      if (req.url === "/xapi/statements") res.writeHead(307, { location: "/xapi/statements/" }).end();
      else {
        const list = JSON.parse(body) as Stmt[];
        srv.stored.push(...list.map((x) => x.id));
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(list.map((x) => x.id)));
      }
    });
    eq("307 that keeps the POST: the test server is on 127.0.0.1", s.address, "127.0.0.1");
    const res = await forwardStatements({ ...CFG, endpoint: s.url }, five);
    eq("307 that keeps the POST: still delivered, no split", [res.ok, res.results, s.posts, s.stored.length], [true, undefined, 2, 5]);
    await s.close();
  }

  console.log("\ntestConnection: the admin's test");
  {
    const s = await onLoopback((req, res) => {
      if (req.url === "/xapi/about") res.writeHead(302, { location: "/login" }).end();
      else res.writeHead(200, { "content-type": "text/html" }).end("<html>sign in</html>");
    });
    eq("a gateway: the test server is on 127.0.0.1", s.address, "127.0.0.1");
    const r = await testConnection({ ...CFG, endpoint: s.url });
    eq("a gateway that redirects /about to a sign-in page: not ok, and no probe is posted", [r.ok, r.status, s.posts], [false, "error", 0]);
    eq("a gateway: the error is fixed text, not the page", /version/.test(String(r.error)) && !/html/.test(String(r.error)), true);
    await s.close();
  }
  const aboutBodies: Array<[string, string]> = [
    ["JSON with no version", '{"name":"not an LRS"}'],
    ["a version that is not a list", '{"version":"1.0.3"}'],
    ["null", "null"],
    ["not JSON", "<html></html>"],
  ];
  for (const [name, body] of aboutBodies) {
    const s = await onLoopback((_req, res) => {
      res.writeHead(200).end(body);
    });
    const r = await testConnection({ ...CFG, endpoint: s.url });
    eq(`/about answers 200 with ${name}: not ok`, [r.ok, r.status], [false, "error"]);
    await s.close();
  }
  {
    const s = await onLoopback((req, res) => {
      if (req.url === "/xapi/about") res.writeHead(200, { "content-type": "application/json" }).end('{"version":["1.0.3"]}');
      else res.writeHead(200, { "content-type": "application/json" }).end("[]");
    });
    const r = await testConnection({ ...CFG, endpoint: s.url });
    eq("an LRS: ok, with its versions, after the probe", [r.ok, r.status, r.versions, s.posts], [true, "ok", ["1.0.3"], 1]);
    await s.close();
  }
  {
    const s = await onLoopback((req, res) => {
      if (req.url === "/xapi/about") res.writeHead(200, { "content-type": "application/json" }).end('{"version":["1.0.3"]}');
      else res.writeHead(401).end();
    });
    const r = await testConnection({ ...CFG, endpoint: s.url });
    eq("an LRS whose /about is public, and a wrong secret: auth_failed", [r.ok, r.status], [false, "auth_failed"]);
    await s.close();
  }
  globalThis.fetch = realFetch;
}

async function main() {
  console.log("\nthe six shapes: a batch with a conflict, a malformed statement or both");
  const shapes: Array<{ name: string; n: number; conflict: number[]; poison: number[]; posts: string; okCount: number; storedCount: number }> = [
    { name: "one conflict at the start of 8", n: 8, conflict: [0], poison: [], posts: "8:409 4:409 2:409 1:409 1:200 2:200 4:200", okCount: 8, storedCount: 7 },
    { name: "one conflict at the end of 8", n: 8, conflict: [7], poison: [], posts: "8:409 4:200 4:409 2:200 2:409 1:200 1:409", okCount: 8, storedCount: 7 },
    { name: "one conflict in 2", n: 2, conflict: [0], poison: [], posts: "2:409 1:409 1:200", okCount: 2, storedCount: 1 },
    {
      name: "25 rows, malformed in the first half, conflict in the second",
      n: 25,
      conflict: [20],
      poison: [3],
      posts: "25:400 13:400 7:400 4:400 2:200 2:400 1:200 1:400 3:200 6:200 12:409 6:200 6:409 3:409 2:409 1:200 1:409",
      okCount: 20, // s21 to s24 are not reached in this call
      storedCount: 19,
    },
    {
      name: "25 rows, malformed and conflict in the same half",
      n: 25,
      conflict: [4],
      poison: [3],
      posts: "25:400 13:400 7:400 4:400 2:200 2:400 1:200 1:400 3:409 2:409 1:409 1:200 1:200 6:200 12:200",
      okCount: 24,
      storedCount: 23,
    },
    { name: "no conflict, one malformed in 8", n: 8, conflict: [], poison: [2], posts: "8:400 4:400 2:200 2:400 1:400 1:200 4:200", okCount: 7, storedCount: 7 },
  ];
  for (const sh of shapes) {
    const statements = batch(sh.n, sh.poison);
    const lrs = fakeLrs(sh.conflict.map((i) => `s${i}`));
    const res = await forwardStatements(CFG, statements);
    eq(`${sh.name}: no statement marked ok unless stored or alone 409`, ruleBreakers(res, lrs, statements), []);
    eq(`${sh.name}: the posts`, lrs.posts.join(" "), sh.posts);
    eq(`${sh.name}: ok count`, okIds(res, statements).length, sh.okCount);
    eq(`${sh.name}: stored count`, lrs.stored.size, sh.storedCount);
    for (const i of sh.poison) eq(`${sh.name}: s${i} is permanent`, outcomeOf(res, `s${i}`)?.permanent, true);
  }

  console.log("\nthe batch outcome, when the batch was not split");
  {
    const statements = batch(8);
    const lrs = fakeLrs();
    const res = await forwardStatements(CFG, statements);
    eq("whole 2xx: one post", lrs.posts.join(" "), "8:200");
    eq("whole 2xx: ok, no per-statement results", [res.ok, res.results], [true, undefined]);
    eq("whole 2xx: the rule", ruleBreakers(res, lrs, statements), []);
  }
  {
    const statements = batch(8);
    const lrs = fakeLrs([], () => "network");
    const res = await forwardStatements(CFG, statements);
    eq("network error: one post, no split", lrs.posts.join(" "), "8:network");
    eq("network error: retryable, no per-statement results", [res.ok, res.permanent, res.results], [false, false, undefined]);
    eq("network error: the rule", ruleBreakers(res, lrs, statements), []);
  }
  {
    const statements = batch(1);
    const lrs = fakeLrs(["s0"]);
    const res = await forwardStatements(CFG, statements);
    eq("single 409: ok, nothing stored", [res.ok, res.permanent, res.status, lrs.stored.size], [true, false, 409, 0]);
    eq("single 409: the rule", ruleBreakers(res, lrs, statements), []);
  }
  {
    const statements = batch(1, [0]);
    const lrs = fakeLrs();
    const res = await forwardStatements(CFG, statements);
    eq("single 400: permanent", [res.ok, res.permanent, res.status], [false, true, 400]);
    eq("single 400: the rule", ruleBreakers(res, lrs, statements), []);
  }
  {
    const statements = batch(1);
    const lrs = fakeLrs([], () => 500);
    const res = await forwardStatements(CFG, statements);
    eq("single 500: retryable", [res.ok, res.permanent, res.status], [false, false, 500]);
    eq("single 500: the rule", ruleBreakers(res, lrs, statements), []);
  }

  for (const status of [408, 429]) { const statements = batch(1); fakeLrs([], () => status); const res = await forwardStatements(CFG, statements); eq(`single ${status}: retryable`, [res.ok, res.permanent, res.status], [false, false, status]); }

  console.log("\nthe isolation budget: 16 posts after the first");
  {
    const statements = batch(64, Array.from({ length: 64 }, (_, i) => i));
    const lrs = fakeLrs();
    const res = await forwardStatements(CFG, statements);
    eq("every statement malformed: 17 posts", lrs.posts.length, 17);
    eq("every statement malformed: the rule", ruleBreakers(res, lrs, statements), []);
    const outcomes = statements.map((s) => outcomeOf(res, s.id));
    eq("every statement malformed: 7 reached alone are permanent", outcomes.filter((o) => o?.permanent).length, 7);
    eq("every statement malformed: the rest stay retryable", outcomes.filter((o) => o && !o.ok && !o.permanent).length, 57);
    eq("every statement malformed: nothing accepted, so the rest count as failed", outcomes.filter((o) => o?.unsettled).length, 0);
  }
  {
    const statements = batch(200);
    const lrs = fakeLrs(statements.map((s) => s.id));
    const res = await forwardStatements(CFG, statements);
    eq("every statement of 200 conflicts: 17 posts", lrs.posts.length, 17);
    eq("every statement of 200 conflicts: the rule", ruleBreakers(res, lrs, statements), []);
    eq("every statement of 200 conflicts: 6 alone 409, ok", okIds(res, statements).length, 6);
    eq(
      "every statement of 200 conflicts: the rest stay retryable",
      statements.filter((s) => { const o = outcomeOf(res, s.id); return o && !o.ok && !o.permanent; }).length,
      194
    );
    eq("every statement of 200 conflicts: the call is not ok", res.ok, false);
    eq("every statement of 200 conflicts: the rest are marked unsettled", statements.filter((s) => outcomeOf(res, s.id)?.unsettled).length, 194);
  }
  {
    const statements = batch(200);
    const lrs = fakeLrs([statements[137].id]);
    const res = await forwardStatements(CFG, statements);
    eq("one conflict in 200: the budget is enough, every statement settled", okIds(res, statements).length, 200);
    eq("one conflict in 200: at most 17 posts", lrs.posts.length <= 17, true);
    eq("one conflict in 200: the rule", ruleBreakers(res, lrs, statements), []);
  }

  console.log("\na wholesale failure");
  {
    const statements = batch(64);
    const lrs = fakeLrs([], () => 503);
    const res = await forwardStatements(CFG, statements);
    eq("every post answers 503: the whole budget, 17 posts", lrs.posts.length, 17);
    eq("every post answers 503: nothing ok, nothing permanent", [okIds(res, statements).length, res.permanent], [0, false]);
    eq("every post answers 503: nothing accepted, so nothing is unsettled", statements.filter((s) => outcomeOf(res, s.id)?.unsettled).length, 0);
    eq("every post answers 503: a statement the budget did not reach carries the error", /LRS HTTP 503/.test(String(outcomeOf(res, "s63")?.error)), true);
  }
  {
    const statements = batch(8);
    const lrs = fakeLrs([], (_list, n) => (n === 1 ? 400 : n === 2 ? "network" : undefined));
    const res = await forwardStatements(CFG, statements);
    eq("a network error on a sub-batch: the other half is stored", lrs.posts.join(" "), "8:400 4:network 4:200");
    eq("a network error on a sub-batch: the rule", ruleBreakers(res, lrs, statements), []);
    eq("a network error on a sub-batch: its statements stay retryable", statements.slice(0, 4).map((s) => outcomeOf(res, s.id)?.permanent), [false, false, false, false]);
  }

  console.log("\na 200 is a delivery only if it carries a list");
  const FIXED_ERROR = "LRS HTTP 502: LRS answered 200 without a list of statement ids";
  const notLists: Array<[string, () => BodyInit | null]> = [
    ["an HTML page", () => "<html>sign in</html>"],
    ["a JSON object", () => '{"statements":[],"more":""}'],
    ["a JSON string", () => '"ok"'],
    ["an empty body", () => ""],
    ["a body that fails to read", () => new ReadableStream({ start: (c) => c.error(new Error("connection lost")) })],
  ];
  for (const [name, body] of notLists) {
    const statements = batch(8);
    const lrs = answering(200, body);
    const res = await forwardStatements(CFG, statements);
    eq(`200 with ${name}, 8 statements: nothing ok, nothing permanent`, [okIds(res, statements).length, res.permanent], [0, false]);
    eq(`200 with ${name}, 8 statements: split like any failure, every post counted`, lrs.posts.length, 15);
    eq(`200 with ${name}, 8 statements: the error is the fixed text`, outcomeOf(res, "s0")?.error, FIXED_ERROR);
    const one = batch(1);
    answering(200, body);
    const single = await forwardStatements(CFG, one);
    eq(`200 with ${name}, one statement: retryable, reads as a 502`, [single.ok, single.permanent, single.status, single.error], [false, false, 502, FIXED_ERROR]);
  }
  {
    const statements = batch(8);
    const lrs = answering(200, () => JSON.stringify(statements.map((s) => s.id)));
    const res = await forwardStatements(CFG, statements);
    eq("200 with the list of ids: stored, one post", [res.ok, res.status, res.results, lrs.posts.join(" ")], [true, 200, undefined, "8:200"]);
  }
  {
    const statements = batch(8);
    const lrs = answering(204, () => null);
    const res = await forwardStatements(CFG, statements);
    eq("204, no body: stored, one post", [res.ok, res.status, res.results, lrs.posts.join(" ")], [true, 204, undefined, "8:204"]);
  }
  {
    const statements = batch(4);
    const lrs = fakeLrs([], (_list, n) => (n === 1 ? 400 : n === 2 ? 204 : undefined));
    const res = await forwardStatements(CFG, statements);
    eq("a 204 on a sub-batch counts as stored there too", [okIds(res, statements).length, lrs.posts.join(" ")], [4, "4:400 2:204 2:200"]);
  }
  {
    const statements = batch(8);
    const lrs = fakeLrs([], (_list, n) => (n === 1 ? 400 : n === 2 ? 300 : undefined));
    const res = await forwardStatements(CFG, statements);
    eq("a 300 on a sub-batch stored nothing, so it splits", [okIds(res, statements).length, lrs.posts.join(" ")], [8, "8:400 4:300 2:200 2:200 4:200"]);
  }

  console.log("\nshuffled: a random order, with the generator passed in");
  {
    const a = [1, 2, 3, 4, 5, 6, 7, 8];
    const copy = a.slice();
    eq("the same generator gives the same order", shuffled(a, seeded(7)), shuffled(a, seeded(7)));
    eq("every item stays, once", shuffled(a, seeded(7)).slice().sort((x, y) => x - y), copy);
    eq("the list passed in is not changed", a, copy);
    eq("the lowest draws: the known order", shuffled([1, 2, 3, 4], () => 0), [2, 3, 4, 1]);
    eq("the highest draws: nothing moves", shuffled([1, 2, 3, 4], () => 0.999999), [1, 2, 3, 4]);
    eq("no items, one item", [shuffled([], seeded(1)), shuffled([9], seeded(1))], [[], [9]]);
    const r = seeded(11);
    const firsts = new Set<number>();
    const lasts = new Set<number>();
    for (let k = 0; k < 200; k++) {
      const s = shuffled([1, 2, 3, 4], r);
      firsts.add(s[0]);
      lasts.add(s[3]);
    }
    eq("over many draws any item can come first or last", [firsts.size, lasts.size], [4, 4]);
    const realRandom = Math.random;
    let drawn = 0;
    Math.random = () => { drawn++; return 0; };
    const byDefault = shuffled([1, 2, 3, 4]);
    Math.random = realRandom;
    eq("with no generator passed in, it draws from Math.random", [byDefault, drawn], [[2, 3, 4, 1], 3]);
  }

  console.log("\nthe rule over many mixes");
  {
    // A small deterministic generator, so a failure names a reproducible case.
    let seed = 20261105;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    const sizes = [1, 2, 3, 5, 8, 13, 25, 50, 64, 199, 200];
    const broken: string[] = [];
    let overBudget = 0, cases = 0;
    for (const n of sizes) {
      for (let k = 0; k < 40; k++) {
        const conflictRate = [0, 0.02, 0.1, 0.5, 1][k % 5];
        const poisonRate = [0, 0.02, 0.1][k % 3];
        const poison: number[] = [];
        const conflict: string[] = [];
        for (let i = 0; i < n; i++) {
          if (rnd() < poisonRate) poison.push(i);
          else if (rnd() < conflictRate) conflict.push(`s${i}`);
        }
        const statements = batch(n, poison);
        const lrs = fakeLrs(conflict);
        const res = await forwardStatements(CFG, statements);
        cases++;
        const bad = ruleBreakers(res, lrs, statements);
        if (bad.length) broken.push(`n=${n} k=${k}: ${bad.length}`);
        if (lrs.posts.length > 17) overBudget++;
      }
    }
    eq(`${cases} mixes: the rule holds for every statement`, broken, []);
    eq(`${cases} mixes: never more than 17 posts`, overBudget, 0);
  }

  await routeCases();
  await enqueueCases();
  await loopbackCases();

  globalThis.fetch = realFetch;
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
