/**
 * Unit tests for ADR 0017 step 15 on the attempt page: the real server component,
 * rendered under a stubbed fetch. The block's sentence names the official result, so
 * it shows only on the official attempt, by the course page's own condition: the
 * learner's attempts on the course and a strict grant read, on the page's RLS client.
 * A failed or empty read leaves it absent. The rest of the block stays.
 *
 * Everything below next/headers is the real code: the auth gate, the page, the reads
 * and computeScoring.
 *
 * No database, no network.
 *
 * Run:  npx tsx tests/unit/attempt-page-official-sentence.test.ts   (or npm run test:unit)
 */
import Module from "node:module";
import React, { type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mergeIgnoredResult, newIgnoredRecord, notAppliedNotice, type IgnoredRecord } from "../../lib/xapi/ignored-pass";
import { DEFAULT_POLICY, normalizePolicy } from "../../lib/scoring/policy";
import { officialFailedAttemptId } from "../../lib/scoring/attempt-kind";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

type Row = Record<string, unknown>;
type Req = { method: string; path: string; select: string; query: URLSearchParams; auth: string };

const SUPABASE = "http://stub.supabase.test";
const LEARNER = { id: "11111111-1111-4111-8111-111111111111", aud: "authenticated", role: "authenticated", email: "learner@example.test" };
const ADMIN = { id: "22222222-2222-4222-8222-222222222222", aud: "authenticated", role: "authenticated", email: "admin@example.test" };
const FAILED_AT = "2026-11-05T10:00:00.000Z";
const FIRST = "a1";
const RETAKE = "a2";
const SENTENCE_TESTID = 'data-testid="ignored-pass-notice"';
const BLOCK_TESTID = 'data-testid="ignored-pass-block"';

let viewer = LEARNER;
const session = () => JSON.stringify({ access_token: "learner-session-token", refresh_token: "r", token_type: "bearer", expires_in: 3600, expires_at: 4102444800, user: viewer });

// tsx compiles the page's JSX to React.createElement.
(globalThis as { React?: unknown }).React = React;

// The page's only cookie-bound import. Everything below it is the real code.
const load = (Module as unknown as { _load: (...a: unknown[]) => unknown })._load;
(Module as unknown as { _load: (...a: unknown[]) => unknown })._load = function (this: unknown, request: unknown, ...rest: unknown[]) {
  if (request === "next/headers") {
    return {
      cookies: async () => ({ get: () => undefined, getAll: () => [{ name: "sb-stub-auth-token", value: session() }], set() {} }),
      headers: async () => new Headers({ host: "lms.test" }),
    };
  }
  return load.call(this, request, ...rest);
};

const record = (): IgnoredRecord =>
  mergeIgnoredResult(
    newIgnoredRecord({ runtime: "cmi5", course_version_id: "v1", engine_version: "2026.10.28", floor: "2026.10.28", failed: { at: FAILED_AT, score: 0.5 } }),
    { verb: "passed", received_at: "2026-11-05T10:30:00.000Z", score: 1, statement_id: "b0000000-0000-4000-8000-000000000001", same_session: false }
  ).record;

const row = (id: string, extra: Row = {}): Row => ({
  id, user_id: LEARNER.id, organization_id: "o1", course_version_id: "v1", status: "failed", completion_status: "completed", success_status: "failed",
  score: 0.5, started_at: "2026-11-05T09:00:00.000Z", completed_at: FAILED_AT, cmi_data: {}, is_revision: false, ...extra,
});
const grant = (used: string | null): Row => ({
  id: `g-${used ?? "unused"}`, used_attempt_id: used, used_at: used ? "2026-11-06T09:00:00.000Z" : null, expires_at: null, created_at: "2026-11-06T08:00:00.000Z",
  decided_by: ADMIN.id, decided_at: "2026-11-06T08:00:00.000Z", decision_note: null, reason: "r", reissued_from: null,
});

type Fault = { status: number; body: unknown } | "throw" | "null";
const TIMEOUT = { code: "57014", message: "canceling statement due to statement timeout" };

/** One world per render. */
let requests: Req[] = [];
let rows: Row[] = [];
let grants: Row[] = [];
let opened = FIRST;
let versionsFault: Fault | null = null;
let attemptsFault: Fault | null = null;
let grantsFault: Fault | null = null;
let versionList: Row[] = [{ id: "v1" }];
let statements: Row[] = [];
let noRevisionColumn = false;
const unmatched: string[] = [];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const answerFault = (f: Fault): Response => {
  if (f === "throw") throw new TypeError("fetch failed");
  return f === "null" ? json(null) : json(f.body, f.status);
};

const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const select = url.searchParams.get("select") ?? "";
  const p = url.pathname;
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  requests.push({ method, path: p, select, query: url.searchParams, auth: headers.get("authorization") ?? "" });
  if (p === "/auth/v1/user") return json(viewer);
  if (p.startsWith("/auth/v1/admin/users/")) return json(LEARNER);
  if (p === "/rest/v1/profiles") return json([{ must_change_password: false }]);
  if (p === "/rest/v1/organizations") return json([{ id: "o1", name: "Org", slug: "org", logo_url: null, brand_color: null, brand_font: null, custom_domain: null }]);
  if (p === "/rest/v1/organization_members") return json([{ role: viewer === ADMIN ? "admin" : "user" }]);
  if (p === "/rest/v1/courses") return json([{ id: "c1", title: "Home loans", organization_id: "o1", show_attempts_history: true }]);
  if (p === "/rest/v1/xapi_statements") return json(statements);
  if (p === "/rest/v1/course_versions") {
    if (select.startsWith("id,course_id")) return json([{ id: "v1", course_id: "c1", manifest_type: "cmi5", version_number: 1 }]);
    if (versionsFault) return answerFault(versionsFault);
    return json(versionList);
  }
  if (p === "/rest/v1/course_attempts") {
    // The page's first read: one row, by id.
    if (url.searchParams.has("id")) return json(rows.filter((r) => `eq.${r.id}` === url.searchParams.get("id")));
    if (attemptsFault) return answerFault(attemptsFault);
    if (noRevisionColumn && select.includes("is_revision")) return json({ code: "42703", message: "column course_attempts.is_revision does not exist" }, 400);
    // The read's in.(...) filter: a row on a version it does not name is not answered.
    const inVersions = /^in\.\((.*)\)$/.exec(url.searchParams.get("course_version_id") ?? "")?.[1].split(",").map((v) => v.replace(/^"|"$/g, ""));
    return json(rows.filter((r) => url.searchParams.get("user_id") === `eq.${r.user_id}` && (!inVersions || inVersions.includes(String(r.course_version_id)))));
  }
  if (p === "/rest/v1/attempt_requests") {
    if (grantsFault) return answerFault(grantsFault);
    return json(grants);
  }
  unmatched.push(`${method} ${p} select=${select}`);
  return json([]);
};

const decode = (html: string) => html.replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');

function reset(i: { rows: Row[]; grants?: Row[]; opened?: string; viewer?: typeof LEARNER }) {
  requests = [];
  rows = i.rows;
  grants = i.grants ?? [];
  opened = i.opened ?? FIRST;
  viewer = i.viewer ?? LEARNER;
  versionsFault = null;
  attemptsFault = null;
  grantsFault = null;
  versionList = [{ id: "v1" }];
  statements = [];
  noRevisionColumn = false;
}

async function main() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "stub-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-service-key";
  (process.env as Record<string, string>).NODE_ENV = "test";
  const realFetch = globalThis.fetch;
  globalThis.fetch = stub as typeof fetch;
  const realError = console.error;
  console.error = () => {};
  try {
    const page = (await import("../../app/[org]/(learner)/courses/[courseId]/attempts/[attemptId]/page")).default;
    const render = async (courseId = "c1") => decode(renderToStaticMarkup((await page({ params: Promise.resolve({ org: "org", courseId, attemptId: opened }) })) as ReactElement));
    const notice = notAppliedNotice({ score: 0.5, at: FAILED_AT });
    const shows = (html: string) => [html.includes(SENTENCE_TESTID), html.includes(notice)];
    const SHOWN = [true, true];
    const ABSENT = [false, false];
    const extraReads = () => requests.filter((q) => (q.path === "/rest/v1/course_versions" && q.select === "id") || (q.path === "/rest/v1/course_attempts" && q.query.has("user_id")) || q.path === "/rest/v1/attempt_requests");

    console.log("\nthe official attempt");
    {
      reset({ rows: [row(FIRST, { ignored_pass: record() })] });
      const html = await render();
      eq("the learner, no grant: the sentence, in the owner's words", shows(html), SHOWN);
      eq("the words carry the first final result", html.includes("That result was not applied: your first final result stands."), true);
      eq("the block and its heading", [html.includes(BLOCK_TESTID), html.includes("Passed result not applied")], [true, true]);
      eq("no unmatched request", unmatched, []);
    }
    {
      reset({ rows: [row(FIRST, { ignored_pass: record() })], viewer: ADMIN });
      const html = await render();
      eq("an admin on the learner's row: the sentence", shows(html), SHOWN);
      eq("…the reads ask for the row's learner, not the viewer", extraReads().filter((q) => q.query.has("user_id")).map((q) => q.query.get("user_id")), [`eq.${LEARNER.id}`, `eq.${LEARNER.id}`]);
    }
    {
      reset({ rows: [row(FIRST, { ignored_pass: record() }), row(RETAKE, { status: "in_progress", completion_status: "in_progress", success_status: "unknown", score: null, completed_at: null, started_at: "2026-11-06T09:00:00.000Z" })], grants: [grant(RETAKE)] });
      eq("a granted retake still running: the first row stands, as on the course page", shows(await render()), SHOWN);
    }
    {
      reset({ rows: [row(FIRST, { ignored_pass: record() })], grants: [grant(null)] });
      eq("a grant not used yet: the first row stands", shows(await render()), SHOWN);
    }
    {
      reset({ rows: [row(FIRST, { ignored_pass: record() }), row("r1", { is_revision: true, status: "completed", success_status: "passed", score: 1, completed_at: "2026-11-05T09:30:00.000Z", started_at: "2026-11-05T09:10:00.000Z" })] });
      eq("a revision visit's row never counts", shows(await render()), SHOWN);
    }
    {
      reset({ rows: [row(FIRST, { completed_at: "2026-11-05T08:00:00.000Z", started_at: "2026-11-05T07:00:00.000Z", status: "passed", success_status: "passed", score: 0.9 }), row(RETAKE, { completed_at: "2026-11-06T10:00:00.000Z", started_at: "2026-11-06T09:00:00.000Z", ignored_pass: record() })], grants: [grant(RETAKE)], opened: RETAKE });
      eq("a retake that failed and is now official, holding its own record: the sentence", shows(await render()), SHOWN);
    }

    console.log("\na row a retake replaced");
    for (const [what, retake] of [
      ["passed", { status: "passed", success_status: "passed", score: 1 }],
      ["failed", { status: "failed", success_status: "failed", score: 0.4 }],
    ] as Array<[string, Row]>) {
      for (const who of [LEARNER, ADMIN]) {
        reset({ rows: [row(FIRST, { ignored_pass: record() }), row(RETAKE, { started_at: "2026-11-06T09:00:00.000Z", completed_at: "2026-11-06T10:00:00.000Z", ...retake })], grants: [grant(RETAKE)], viewer: who });
        const html = await render();
        eq(`a ${what} retake, seen by the ${who === ADMIN ? "admin" : "learner"}: no sentence`, shows(html), ABSENT);
        eq("…the words appear nowhere on the page", [html.includes("Your official result for this module is"), html.includes("your first final result stands")], [false, false]);
        eq("…the block stays, with its heading and the count", [html.includes(BLOCK_TESTID), html.includes("Passed result not applied"), html.includes("Ignored passes: 1")], [true, true, true]);
      }
    }

    {
      reset({ rows: [row(FIRST, { ignored_pass: record() }), row(RETAKE, { course_version_id: "v2", status: "passed", success_status: "passed", score: 1, started_at: "2026-11-06T09:00:00.000Z", completed_at: "2026-11-06T10:00:00.000Z" })], grants: [grant(RETAKE)] });
      versionList = [{ id: "v1" }, { id: "v2" }];
      eq("a passed retake on a newer version, read across both versions: no sentence", shows(await render()), ABSENT);
    }

    console.log("\nnot failed");
    {
      reset({ rows: [row(FIRST, { status: "passed", success_status: "passed", ignored_pass: record() })] });
      eq("the official attempt reads passed: no sentence, as on the course page", shows(await render()), ABSENT);
    }

    console.log("\na failed or empty read: absent, never wrong");
    const faults: Array<[string, () => void]> = [
      ["the grant read answering an error", () => { grantsFault = { status: 500, body: TIMEOUT }; }],
      ["the grant read answering neither rows nor an error", () => { grantsFault = "null"; }],
      ["the grant read throwing", () => { grantsFault = "throw"; }],
      ["the versions read answering an error", () => { versionsFault = { status: 500, body: TIMEOUT }; }],
      ["the versions read answering neither", () => { versionsFault = "null"; }],
      ["the versions read empty", () => { versionList = []; }],
      ["the versions read throwing", () => { versionsFault = "throw"; }],
      ["the attempts read answering an error", () => { attemptsFault = { status: 500, body: TIMEOUT }; }],
      ["the attempts read answering neither", () => { attemptsFault = "null"; }],
      ["the attempts read empty", () => { attemptsFault = { status: 200, body: [] }; }],
      ["the attempts read throwing", () => { attemptsFault = "throw"; }],
    ];
    for (const [what, arm] of faults) {
      reset({ rows: [row(FIRST, { ignored_pass: record() })] });
      arm();
      const html = await render();
      eq(`${what}: no sentence, the block stays`, [shows(html), html.includes(BLOCK_TESTID)], [ABSENT, true]);
    }
    for (const [what, arm] of [
      ["versions", () => { versionList = []; }],
      ["attempts", () => { attemptsFault = { status: 200, body: [] }; }],
    ] as Array<[string, () => void]>) {
      reset({ rows: [row(FIRST, { ignored_pass: record() })] });
      arm();
      await render();
      eq(`the ${what} read empty: the reads stop there`, extraReads().some((q) => q.path === "/rest/v1/attempt_requests"), false);
    }
    {
      // An answer with an error is not read, whatever else it holds.
      const answer = (i: { versions?: unknown; attempts?: unknown }) => {
        const answers: Record<string, unknown> = {
          course_versions: { data: [{ id: "v1" }], error: null, ...(i.versions as object) },
          course_attempts: { data: [row(FIRST)], error: null, ...(i.attempts as object) },
          attempt_requests: { data: [], error: null },
        };
        return {
          from(table: string) {
            const b: Record<string, unknown> = {};
            for (const op of ["select", "eq", "in"]) b[op] = () => b;
            b.then = (res: (v: unknown) => unknown) => Promise.resolve(answers[table]).then(res);
            return b;
          },
        };
      };
      const ERROR = { error: { code: "57014", message: "timeout" } };
      eq("the helper, clean: this attempt", await officialFailedAttemptId(answer({}), LEARNER.id, "c1"), FIRST);
      eq("the helper, the versions answer with rows and an error: null", await officialFailedAttemptId(answer({ versions: ERROR }), LEARNER.id, "c1"), null);
      eq("the helper, the attempts answer with rows and an error: null", await officialFailedAttemptId(answer({ attempts: ERROR }), LEARNER.id, "c1"), null);
    }
    {
      reset({ rows: [row(FIRST, { ignored_pass: record() }), row("r1", { success_status: "passed", status: "passed", is_revision: undefined, completed_at: "2026-11-06T09:30:00.000Z", started_at: "2026-11-06T09:10:00.000Z" })] });
      noRevisionColumn = true;
      const html = await render();
      eq("a database without is_revision: read again without it, as the course page's select(*) tolerates", [shows(html), extraReads().filter((q) => q.path === "/rest/v1/course_attempts").length], [SHOWN, 2]);
    }

    console.log("\nthe reads and their cost");
    reset({ rows: [row(FIRST)] });
    await render();
    const plain = requests.length;
    eq("a row with no record: none of the three reads", extraReads().length, 0);
    {
      const scoreOnly = mergeIgnoredResult(newIgnoredRecord({ runtime: "cmi5", course_version_id: "v1", engine_version: "2026.10.28", floor: "2026.10.28", failed: { at: FAILED_AT, score: 0.5 } }), { verb: "failed", received_at: "2026-11-05T10:30:00.000Z", score: 0.9, statement_id: "f" }).record;
      reset({ rows: [row(FIRST, { ignored_pass: scoreOnly })] });
      const html = await render();
      eq("a score-only record: no read, no sentence, Result notes", [extraReads().length, shows(html), html.includes("Result notes")], [0, ABSENT, true]);
      eq("…and costs what a plain row costs", requests.length, plain);
    }
    reset({ rows: [row(FIRST, { ignored_pass: record() })] });
    await render();
    const reads = extraReads();
    eq("a row with an ignored pass: three reads, in this order", reads.map((q) => q.path), ["/rest/v1/course_versions", "/rest/v1/course_attempts", "/rest/v1/attempt_requests"]);
    eq("…three subrequests more than a plain row", requests.length - plain, 3);
    console.log(`  budget: this page makes ${plain} requests on a plain row under this stub and ${requests.length} on a row with an ignored pass`);
    eq("…each on the page's RLS client, with the session's token", reads.map((q) => q.auth), reads.map(() => "Bearer learner-session-token"));
    eq("…the versions by the attempt's own course", reads[0].query.get("course_id"), "eq.c1");
    eq("…the attempts across them, for the learner", [reads[1].query.get("course_version_id"), reads[1].query.get("user_id")], ["in.(v1)", `eq.${LEARNER.id}`]);
    eq("…the attempts read names no cmi_data", reads[1].select.includes("cmi_data") || reads[1].select === "*", false);
    eq("…the approved grants of the learner on that course", [reads[2].query.get("user_id"), reads[2].query.get("course_id"), reads[2].query.get("status")], [`eq.${LEARNER.id}`, "eq.c1", "eq.approved"]);
    {
      reset({ rows: [row(FIRST, { ignored_pass: record() })] });
      await render("another-course");
      eq("a URL naming another course: the reads still follow the attempt's version", extraReads()[0].query.get("course_id"), "eq.c1");
    }
    {
      // The course page's resolvePolicy reads a rule, and every rule normalises to these.
      const clamped = normalizePolicy({ max_scored_attempts: 5, official_basis: "best", official_attempt_number: 3, retain_first_attempt: false, after_limit: "block", source: "course", source_id: "x" });
      const pick = (p: typeof DEFAULT_POLICY) => [p.max_scored_attempts, p.official_basis, p.official_attempt_number, p.after_limit];
      eq("no policy read is needed: every rule is clamped to the default the page passes", pick(clamped), pick(DEFAULT_POLICY));
    }
    eq("no unmatched request in any render", unmatched, []);
  } finally {
    globalThis.fetch = realFetch;
    console.error = realError;
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
