/**
 * External LRS — end-to-end against a REAL Yet Analytics SQL LRS (Postgres backend),
 * mirroring the production pipeline: LMS ingest → enrich → outbox → real-time forward →
 * cron drainer/sweeper → SQL LRS (directly and through a Caddy TLS proxy).
 *
 * Needs, locally:
 *   - the LMS dev server on E2E_BASE_URL (localhost), NODE_TLS_REJECT_UNAUTHORIZED=0 for the
 *     Caddy step
 *   - SQL LRS on LOCAL_LRS_URL (default http://127.0.0.1:8080/xapi) with LOCAL_LRS_KEY/SECRET
 *   - the supervisor on LRS_SUPERVISOR (default http://127.0.0.1:8099) exposing /stop /start
 *   - Caddy on LOCAL_LRS_TLS_URL (default https://localhost:8443/xapi) → the LRS
 * Every step records PASS/FAIL into LRS_E2E_RESULTS (json) so the whole run is reported even
 * when a step fails (soft assertions).
 */
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import { test, expect } from "@playwright/test";
import { addMember, createAuthUser, createOrg, rand, svc } from "../../e2e/helpers/supabase";
import { lintStatement } from "../lib/xapi-lint";
import { uuid5 } from "../../../lib/lrs/uuid5";
import { testConnection } from "../../../lib/lrs/forward";

const NS = "https://ambak.com/xapi/";
// Where THIS test talks to the LRS (assertions) …
const LRS = process.env.LOCAL_LRS_URL || "http://127.0.0.1:8080/xapi";
// … and where the LMS under test must send to. Same LRS; differs when the LMS
// runs remotely (e.g. the staging Worker reaching this LRS through a tunnel).
const LRS_FOR_LMS = process.env.LRS_URL_FOR_LMS || LRS;
const LRS_KEY = process.env.LOCAL_LRS_KEY || "localkey";
const LRS_SECRET = process.env.LOCAL_LRS_SECRET || "localsecret";
const SUPERVISOR = process.env.LRS_SUPERVISOR || "http://127.0.0.1:8099";
// A TLS endpoint for the proxy step: local Caddy, or the (already TLS) remote endpoint.
const CADDY = process.env.LOCAL_LRS_TLS_URL || (process.env.LRS_URL_FOR_LMS ? process.env.LRS_URL_FOR_LMS : "https://localhost:8443/xapi");
const REMOTE = process.env.LRS_E2E_REMOTE === "1";
const RESULTS = process.env.LRS_E2E_RESULTS || "lrs-e2e-results.json";

type Obj = Record<string, unknown>;
type Stmt = { id: string; actor: Obj; verb: { id: string }; object: { id: string; definition?: Obj }; result?: Obj; context: { registration?: string; extensions: Obj; contextActivities: { parent?: Array<{ id: string }>; grouping?: Array<{ id: string }>; category?: Array<{ id: string }> } } };

const H = {
  authorization: "Basic " + Buffer.from(`${LRS_KEY}:${LRS_SECRET}`).toString("base64"),
  "x-experience-api-version": "1.0.3",
  "content-type": "application/json",
};
const R: Array<{ step: string; ok: boolean; detail: unknown }> = [];
function rec(step: string, ok: boolean, detail: unknown) {
  R.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${step} :: ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 400)}`);
  expect.soft(ok, step).toBeTruthy();
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 15000, step = 500): Promise<T | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v as T;
    await sleep(step);
  }
  return null;
}
async function lrsGet(id: string) {
  const r = await fetch(`${LRS}/statements?statementId=${id}`, { headers: H });
  return { status: r.status, body: r.status === 200 ? ((await r.json()) as Stmt) : null };
}
async function lrsByReg(reg: string): Promise<Stmt[]> {
  const r = await fetch(`${LRS}/statements?registration=${reg}&limit=50`, { headers: H });
  const j = (await r.json()) as { statements?: Stmt[] };
  return j.statements ?? [];
}
async function lrsPost(stmts: unknown[], headers: Record<string, string> = H) {
  const r = await fetch(`${LRS}/statements`, { method: "POST", headers, body: JSON.stringify(stmts) });
  return { status: r.status, text: (await r.text()).slice(0, 300) };
}
async function drain(baseURL: string) {
  const r = await fetch(`${baseURL}/api/cron/lrs-forward`, { method: "POST", headers: { "x-cron-secret": process.env.CRON_SECRET ?? "" } });
  return (await r.json().catch(() => ({}))) as { processed?: number; sent?: number; failed?: number; dead?: number; sweep?: Array<{ org: string; ran: string[]; enqueued: Record<string, number>; caughtUp?: boolean }> };
}
async function supervisor(cmd: "stop" | "start" | "status") {
  const r = await fetch(`${SUPERVISOR}/${cmd}`);
  return (await r.text()).trim();
}
async function lrsUp(): Promise<boolean> {
  try {
    const r = await fetch(`${LRS}/about`, { headers: H, signal: AbortSignal.timeout(3000) });
    return r.status === 200;
  } catch {
    return false;
  }
}
async function waitLrs(up: boolean, ms = 90000) {
  return (await until(async () => ((await lrsUp()) === up ? true : null), ms, 1000)) === true;
}
async function outboxRows(orgId: string, ids: string[]) {
  const { data } = await svc().from("lrs_forward_outbox").select("statement_id, status, attempts, last_error, origin, payload").eq("organization_id", orgId).in("statement_id", ids);
  return (data ?? []) as Array<{ statement_id: string; status: string; attempts: number; last_error: string | null; origin: string; payload: Stmt }>;
}
async function waitOutbox(orgId: string, ids: string[], status: string, ms = 25000) {
  return until(async () => {
    const rows = await outboxRows(orgId, ids);
    return rows.length === ids.length && rows.every((r) => r.status === status) ? rows : null;
  }, ms);
}

test("real SQL LRS end-to-end: live forward, drainer, sweeper, idempotency, outage, dead-letter, auth failure, TLS proxy", async ({ baseURL }) => {
  test.skip(!process.env.E2E_BASE_URL?.includes("localhost") && !REMOTE, "needs a local dev server that can reach the local LRS (or LRS_E2E_REMOTE=1 with LRS_URL_FOR_LMS)");
  test.setTimeout(15 * 60_000);
  const db = svc();
  const started = new Date().toISOString();

  // ---------- fixtures ------------------------------------------------------
  const org = await createOrg({ name: "QA Real LRS" });
  const learner = await createAuthUser({ profile: { first_name: "Riddhi", last_name: "QA", must_change_password: false } });
  await addMember({ organizationId: org.id, userId: learner.id, role: "member", employee_id: "QA-EMP-46" });
  await db.from("organization_members").update({ business_vertical: "Fulfillment", branch: "Thane", city: "Mumbai", state: "Maharashtra", designation: "Relationship Manager", date_of_joining: "2026-01-15" }).eq("organization_id", org.id).eq("user_id", learner.id);
  const { data: team } = await db.from("teams").insert({ organization_id: org.id, name: "West Sales QA", slug: `west-sales-${rand()}` }).select("id").single();
  await db.from("team_members").insert({ team_id: team!.id, user_id: learner.id });

  const auId = `urn:qa:reallrs:${rand()}`;
  const { data: course } = await db.from("courses").insert({ organization_id: org.id, title: "QA Real LRS Module", slug: `qa-reallrs-${rand()}`, status: "published" }).select("id").single();
  const { data: pkg } = await db.from("course_packages").insert({ course_id: course!.id, language: "en", display_name: "English" }).select("id").single();
  const { data: version } = await db.from("course_versions").insert({ course_id: course!.id, version_number: 1, manifest_type: "cmi5", launch_url: "index.html", storage_prefix: `courses/${course!.id}/v1/`, manifest_data: { raw: { auId }, unitCount: 8 }, package_id: pkg!.id }).select("id").single();
  await db.from("courses").update({ current_version_id: version!.id }).eq("id", course!.id);

  const { data: path } = await db.from("learning_paths").insert({ organization_id: org.id, name: "QA Path", slug: `qa-path-${rand()}` }).select("id").single();
  await db.from("learning_path_courses").insert({ path_id: path!.id, course_id: course!.id, step_number: 1 });
  const { data: program } = await db.from("journey_programs").insert({ organization_id: org.id, name: "QA Journey", days_total: 30 }).select("id").single();
  const { data: jversion } = await db.from("journey_versions").insert({ program_id: program!.id, organization_id: org.id, version_number: 1, name: "QA Journey", days_total: 30, count_sundays: false, completion_title: "Yoddha", days: [] }).select("id").single();
  await db.from("journey_programs").update({ current_version_id: jversion!.id }).eq("id", program!.id);
  const { data: enrollment } = await db.from("journey_enrollments").insert({ program_id: program!.id, version_id: jversion!.id, organization_id: org.id, user_id: learner.id, start_date: new Date().toISOString().slice(0, 10), status: "active" }).select("id").single();

  const { data: attempt, error: attErr } = await db.from("course_attempts").insert({ course_version_id: version!.id, user_id: learner.id, organization_id: org.id, status: "in_progress", completion_status: "in_progress", success_status: "unknown", learning_path_id: path!.id, journey_enrollment_id: enrollment!.id, journey_day: 3 }).select("id").single();
  expect(attErr, `attempt insert: ${attErr?.message}`).toBeNull();
  const token = randomBytes(32).toString("hex");
  await db.from("cmi5_launch_tokens").insert({ auth_token: token, attempt_id: attempt!.id });
  await db.from("tenant_lrs_config").upsert({ organization_id: org.id, enabled: true, endpoint: LRS_FOR_LMS, auth_key: LRS_KEY, auth_secret: LRS_SECRET, xapi_version: "1.0.3", statement_profile: "ambak-v1" }, { onConflict: "organization_id" });

  const actor = { objectType: "Agent", name: learner.email, account: { homePage: baseURL, name: learner.id } };
  const ctx = { registration: attempt!.id, extensions: { "https://w3id.org/xapi/cmi5/context/extensions/sessionid": randomUUID() }, contextActivities: { category: [{ id: "https://w3id.org/xapi/cmi5/context/categories/cmi5" }] } };
  const engine = (id: string, verb: string, object: Obj, extra: Obj = {}) => ({ id, actor, verb: { id: `http://adlnet.gov/expapi/verbs/${verb}`, display: { "en-US": verb } }, object, context: ctx, timestamp: new Date().toISOString(), ...extra });
  const postToLms = async (stmts: unknown[]) => {
    const r = await fetch(`${baseURL}/api/xapi/statements`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-experience-api-version": "1.0.3" }, body: JSON.stringify(stmts) });
    return r.status;
  };
  const summary: Obj = { org: org.id, learner: learner.id, attempt: attempt!.id, course: course!.id, lrs: LRS, started };

  try {
    // ---------- S1 reachability + credential detection ---------------------
    await test.step("S1 LRS reachability", async () => {
      const ok = await fetch(`${LRS}/about`, { headers: H });
      const body = (await ok.json()) as { version?: string[] };
      rec("S1a /about with valid credentials", ok.status === 200 && (body.version ?? []).includes("1.0.3"), { status: ok.status, versions: body.version });
      const bad = await fetch(`${LRS}/about`, { headers: { ...H, authorization: "Basic " + Buffer.from("localkey:WRONG").toString("base64") } });
      rec("S1b LRS behaviour (informational): /about does not check credentials on SQL LRS", true, { status: bad.status, note: bad.status === 200 ? "SQL LRS answers /about for any credentials → a Test-connection probe must use an authenticated route" : "this LRS rejects bad credentials on /about" });
      const none = await fetch(`${LRS}/about`, { headers: { "x-experience-api-version": "1.0.3" } });
      summary.aboutWithoutAuth = none.status;
      const okProbe = await testConnection({ endpoint: LRS, auth_key: LRS_KEY, auth_secret: LRS_SECRET, xapi_version: "1.0.3" });
      const badProbe = await testConnection({ endpoint: LRS, auth_key: LRS_KEY, auth_secret: "WRONG", xapi_version: "1.0.3" });
      rec("S1c LMS Test-connection detects a wrong secret (auth_failed) and accepts the right one (ok)", okProbe.status === "ok" && badProbe.status === "auth_failed", { ok: okProbe, bad: badProbe });
    });

    // ---------- S2 live forward of engine statements ------------------------
    const ids = { init: randomUUID(), exp: randomUUID(), ans: randomUUID(), pass: randomUUID() };
    await test.step("S2 live forward", async () => {
      const status = await postToLms([
        engine(ids.init, "initialized", { id: auId, definition: { type: "http://adlnet.gov/expapi/activities/lesson" } }),
        engine(ids.exp, "experienced", { id: `${auId}/3`, definition: { name: { "en-US": "Slide three" }, type: "http://adlnet.gov/expapi/activities/cmi.interaction" } }, { result: { duration: "PT41S" } }),
        engine(ids.ans, "answered", { id: `${auId}/3_q_k1`, definition: { name: { "en-US": "Q1" }, type: "http://adlnet.gov/expapi/activities/cmi.interaction", interactionType: "choice", correctResponsesPattern: ["b"], choices: [{ id: "a", description: { "en-US": "A" } }, { id: "b", description: { "en-US": "B" } }] } }, { result: { success: false, response: "a", duration: "PT23S" } }),
        engine(ids.pass, "passed", { id: auId, definition: { type: "http://adlnet.gov/expapi/activities/course" } }, { result: { score: { scaled: 0.9, raw: 9, max: 10, min: 0 }, success: true, completion: true, duration: "PT9M" } }),
      ]);
      rec("S2a LMS ingest accepts 4 engine statements", status === 200, { status });
      const rows = await waitOutbox(org.id, Object.values(ids), "sent");
      rec("S2b outbox rows reach status=sent via the real-time path (no cron)", !!rows, rows ? rows.map((r) => `${r.status}/${r.attempts}`) : await outboxRows(org.id, Object.values(ids)));
      const got: Record<string, Stmt | null> = {};
      for (const [k, id] of Object.entries(ids)) got[k] = (await lrsGet(id)).body;
      rec("S2c all 4 statements retrievable from the SQL LRS by id", Object.values(got).every(Boolean), Object.fromEntries(Object.entries(got).map(([k, v]) => [k, v ? "200" : "404"])));
      const ans = got.ans;
      if (ans) {
        const E = ans.context.extensions;
        const grouping = (ans.context.contextActivities.grouping ?? []).map((g) => g.id);
        rec("S2d enriched object id (stable course/question)", ans.object.id === `${NS}activities/course/${course!.id}/question/3_q_k1`, ans.object.id);
        rec("S2e actor is mbox email only", ans.actor.mbox === `mailto:${learner.email.toLowerCase()}` && !ans.actor.account, ans.actor);
        rec("S2f segment E2E, team, employee id, tenure present", E[`${NS}ext/learner/segment`] === "E2E" && (E[`${NS}ext/learner/teams`] as string[] | undefined)?.includes("West Sales QA") && E[`${NS}ext/learner/employee-id`] === "QA-EMP-46" && typeof E[`${NS}ext/learner/tenure-days`] === "number", { segment: E[`${NS}ext/learner/segment`], teams: E[`${NS}ext/learner/teams`], emp: E[`${NS}ext/learner/employee-id`], tenure: E[`${NS}ext/learner/tenure-days`] });
        rec("S2g grouping carries course, path+step, journey+day, org", [`${NS}activities/course/${course!.id}`, `${NS}activities/path/${path!.id}`, `${NS}activities/path/${path!.id}/step/1`, `${NS}activities/journey/${program!.id}`, `${NS}activities/journey/${program!.id}/day/3`, `${NS}activities/org/${org.id}`].every((g) => grouping.includes(g)), grouping);
        rec("S2h parent = slide 3; cmi5 category + profile category kept; registration = attempt", ans.context.contextActivities.parent?.[0]?.id === `${NS}activities/course/${course!.id}/slide/3` && (ans.context.contextActivities.category ?? []).some((c) => c.id.includes("cmi5")) && (ans.context.contextActivities.category ?? []).some((c) => c.id === `${NS}profile/v1`) && ans.context.registration === attempt!.id, { parent: ans.context.contextActivities.parent, category: ans.context.contextActivities.category });
        rec("S2i result preserved (success=false, response=a, duration)", ans.result?.success === false && ans.result?.response === "a" && ans.result?.duration === "PT23S", ans.result);
        const lint = Object.values(got).filter(Boolean).flatMap((s) => lintStatement(s));
        rec("S2j delivered statements pass the xAPI lint", lint.length === 0, lint);
      }
      const { data: att } = await db.from("course_attempts").select("completion_status, success_status, score, progress_pct, completed_at").eq("id", attempt!.id).single();
      rec("S2k LMS attempt record updated by the engine 'passed' (LMS not disturbed by forwarding)", att?.completion_status === "completed" && att?.success_status === "passed", att);
      if (att?.completion_status !== "completed") await db.from("course_attempts").update({ completion_status: "completed", success_status: "passed", status: "passed", score: 0.9, completed_at: new Date().toISOString() }).eq("id", attempt!.id);
    });

    // LMS-side events to be derived by the sweeper. Every insert reports its error
    // instead of crashing the run, so the report shows exactly which source could not be seeded.
    const fixtureErrors: Record<string, string> = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ins = async (name: string, q: PromiseLike<any>): Promise<{ id: string } | null> => {
      const { data, error } = (await q) as { data: { id: string } | null; error: { message: string } | null };
      if (error) fixtureErrors[name] = error.message;
      return data;
    };
    // The LMS records the journey day itself when the attempt completes (journey_record_completion);
    // use that row when it exists, otherwise seed one.
    const { data: autoProgress } = await db.from("journey_day_progress").select("id").eq("enrollment_id", enrollment!.id).eq("day_number", 3).maybeSingle();
    summary.journeyDayAutoRecordedByLms = !!autoProgress;
    const progress = autoProgress ?? (await ins("journey_day_progress", db.from("journey_day_progress").insert({ enrollment_id: enrollment!.id, organization_id: org.id, user_id: learner.id, day_number: 3, course_id: course!.id, attempt_id: attempt!.id, completed_at: new Date().toISOString() }).select("id").single()));
    await ins("journey_enrollments.completed", db.from("journey_enrollments").update({ status: "completed", completed_at: new Date().toISOString() }).eq("id", enrollment!.id).select("id").single());
    await ins("course_ratings", db.from("course_ratings").insert({ user_id: learner.id, course_id: course!.id, rating: 4, comment: "QA rating" }).select("id").single());
    await ins("xp_events", db.from("xp_events").insert({ organization_id: org.id, user_id: learner.id, rule: "course_completed", xp: 50, course_id: course!.id, attempt_id: attempt!.id, dedupe_key: `qa-${attempt!.id}` }).select("id").single());
    await ins("user_badges", db.from("user_badges").insert({ organization_id: org.id, user_id: learner.id, badge_slug: "first-course" }).select("id").single());

    // SCORM 1.2 attempt (finished) for the translation source.
    const sversion = await ins("scorm course_version", db.from("course_versions").insert({ course_id: course!.id, version_number: 2, manifest_type: "scorm12", launch_url: "index_lms.html", storage_prefix: `courses/${course!.id}/v2/`, manifest_data: { raw: { activityId: `${auId}-scorm` }, unitCount: 8 }, package_id: pkg!.id }).select("id").single());
    const sattempt = sversion
      ? await ins("scorm course_attempt", db.from("course_attempts").insert({ course_version_id: sversion.id, user_id: learner.id, organization_id: org.id, status: "passed", completion_status: "completed", success_status: "passed", score: 0.8, completed_at: new Date().toISOString(), cmi_data: { "cmi.core.score.raw": 8, "cmi.core.score.max": 10, "cmi.core.score.min": 0, "cmi.core.total_time": "0000:12:30.00", "cmi.core.lesson_status": "passed", "cmi.interactions.0.id": "q1", "cmi.interactions.0.type": "choice", "cmi.interactions.0.student_response": "b", "cmi.interactions.0.correct_responses.0.pattern": "b", "cmi.interactions.0.result": "correct", "cmi.interactions.0.latency": "0000:00:20.00", "cmi.interactions.1.id": "q2", "cmi.interactions.1.type": "true-false", "cmi.interactions.1.student_response": "f", "cmi.interactions.1.correct_responses.0.pattern": "t", "cmi.interactions.1.result": "wrong" } }).select("id").single())
      : null;
    rec("Fixtures for LMS-derived events seeded (journey day, journey completion, rating, XP, badge, SCORM attempt)", Object.keys(fixtureErrors).length === 0, Object.keys(fixtureErrors).length ? fixtureErrors : "all seeded");

    // ---------- S3 drainer + sweeper (LMS-derived + SCORM) -------------------
    await test.step("S3 drainer and sweeper", async () => {
      const expected: Record<string, string> = {
        launched: uuid5(`launched:${attempt!.id}`),
        "path step completed": uuid5(`path-step:${attempt!.id}`),
        "path satisfied": uuid5(`path-satisfied:${path!.id}:${learner.id}`),
        ...(progress ? { "journey day completed": uuid5(`journey-day:${progress.id}`) } : {}),
        ...(fixtureErrors["journey_enrollments.completed"] ? {} : { "journey satisfied": uuid5(`journey-satisfied:${enrollment!.id}`) }),
        ...(sattempt
          ? {
              "scorm completed": uuid5(`scorm:${sattempt.id}:completed`),
              "scorm passed": uuid5(`scorm:${sattempt.id}:passed`),
              "scorm answered q1": uuid5(`scorm:${sattempt.id}:answered:0`),
              "scorm launched": uuid5(`launched:${sattempt.id}`),
            }
          : {}),
      };
      let drains = 0;
      let last: Awaited<ReturnType<typeof drain>> = {};
      for (let i = 0; i < 8; i++) {
        last = await drain(baseURL!);
        drains++;
        const rows = await outboxRows(org.id, Object.values(expected));
        if (rows.length === Object.keys(expected).length && rows.every((r) => r.status === "sent")) break;
      }
      summary.drains = drains;
      summary.lastDrain = last;
      const rows = await outboxRows(org.id, Object.values(expected));
      const byId = new Map(rows.map((r) => [r.statement_id, r]));
      for (const [name, id] of Object.entries(expected)) {
        const row = byId.get(id);
        const inLrs = (await lrsGet(id)).status;
        rec(`S3 derived '${name}' enqueued and stored in the LRS`, row?.status === "sent" && inLrs === 200, { outbox: row?.status ?? "missing", origin: row?.origin, lrs: inLrs });
        if (row) {
          const l = lintStatement(row.payload);
          if (l.length) rec(`S3 lint '${name}'`, false, l);
        }
      }
      const { data: lms } = await db.from("lrs_forward_outbox").select("payload, status").eq("organization_id", org.id).eq("origin", "lms");
      const verbs = new Set((lms ?? []).map((r) => (r.payload as Stmt).verb.id.replace(/^.*\//, "")));
      rec("S3 earned (XP/badge) and rated derived", verbs.has("earned") && verbs.has("rated"), [...verbs]);
      if (expected["scorm answered q1"]) {
        const scormAns = (await lrsGet(expected["scorm answered q1"])).body;
        rec("S3 SCORM interaction translated with interactionType and success", scormAns?.object.definition?.interactionType === "choice" && scormAns?.result?.success === true && scormAns?.result?.response === "b", scormAns ? { def: scormAns.object.definition, result: scormAns.result } : "missing");
      }
    });

    // ---------- S4 idempotency --------------------------------------------
    await test.step("S4 idempotency", async () => {
      const before = (await lrsByReg(attempt!.id)).length;
      const { data: allBefore } = await db.from("lrs_forward_outbox").select("statement_id").eq("organization_id", org.id);
      await db.from("tenant_lrs_config").update({ backfill_requested_at: new Date().toISOString() }).eq("organization_id", org.id);
      for (let i = 0; i < 4; i++) await drain(baseURL!);
      const after = (await lrsByReg(attempt!.id)).length;
      const { data: allAfter } = await db.from("lrs_forward_outbox").select("statement_id, status").eq("organization_id", org.id);
      rec("S4a 'Resend all history' does not duplicate statements in the LRS", before === after && before > 0, { before, after });
      rec("S4b outbox statement ids unique after backfill; row count unchanged", new Set(allAfter!.map((r) => r.statement_id)).size === allAfter!.length && allAfter!.length === allBefore!.length, { before: allBefore!.length, after: allAfter!.length });
      const rows = await outboxRows(org.id, Object.values(ids));
      const identical = await lrsPost(rows.map((r) => r.payload));
      rec("S4c re-POST of identical statements (same ids) is accepted", identical.status === 200, identical);
      const modified = JSON.parse(JSON.stringify(rows.find((r) => r.statement_id === ids.ans)!.payload)) as Stmt;
      modified.result = { ...(modified.result ?? {}), response: "zz" };
      const conflict = await lrsPost([modified]);
      rec("S4d same id with DIFFERENT content → 409 Conflict (LRS keeps the first copy)", conflict.status === 409, conflict);
      const fresh = JSON.parse(JSON.stringify(rows.find((r) => r.statement_id === ids.exp)!.payload)) as Stmt;
      fresh.id = randomUUID();
      fresh.object.id = `${NS}activities/course/${course!.id}/slide/99`;
      const mixed = await lrsPost([modified, fresh]);
      const freshStored = (await lrsGet(fresh.id)).status;
      rec("S4e LRS behaviour (informational): a mixed batch with one conflicting id is rejected as a whole", true, { batchStatus: mixed.status, newStatementStored: freshStored === 200, note: freshStored !== 200 ? "one conflicting statement makes the LRS reject the whole batch → the forwarder must split on 409" : "this LRS stores the non-conflicting statements" });
      summary.mixedBatch = { status: mixed.status, freshStored };
      // The same situation through the LMS forwarder: an outbox batch that holds a
      // conflicting copy (same id, different content) AND a brand-new statement.
      const conflictRow = JSON.parse(JSON.stringify(rows.find((r) => r.statement_id === ids.exp)!.payload)) as Stmt;
      conflictRow.result = { ...(conflictRow.result ?? {}), duration: "PT1H" };
      const newStmt = JSON.parse(JSON.stringify(rows.find((r) => r.statement_id === ids.exp)!.payload)) as Stmt;
      newStmt.id = randomUUID();
      newStmt.object.id = `${NS}activities/course/${course!.id}/slide/98`;
      await db.from("lrs_forward_outbox").update({ status: "pending", attempts: 0, payload: conflictRow as unknown as Record<string, unknown>, next_attempt_at: new Date(Date.now() - 1000).toISOString() }).eq("organization_id", org.id).eq("statement_id", ids.exp);
      await db.from("lrs_forward_outbox").insert({ organization_id: org.id, attempt_id: attempt!.id, statement_id: newStmt.id, payload: newStmt as unknown as Record<string, unknown>, status: "pending", origin: "engine", next_attempt_at: new Date(Date.now() - 1000).toISOString() });
      const d = await drain(baseURL!);
      const settled = await outboxRows(org.id, [ids.exp, newStmt.id]);
      const newStored = (await lrsGet(newStmt.id)).status;
      rec("S4f LMS forwarder: conflicting + new statement in one batch → both settled 'sent' and the NEW one is stored (split on 409)", settled.every((r) => r.status === "sent") && newStored === 200, { drain: { processed: d.processed, sent: d.sent, failed: d.failed, dead: d.dead }, rows: settled.map((r) => `${r.statement_id === newStmt.id ? "new" : "conflict"}:${r.status}`), newStored });
    });

    // ---------- S5 outage + recovery ---------------------------------------
    const out1 = randomUUID(), out2 = randomUUID();
    await test.step("S5 outage and recovery", async () => {
      await supervisor("stop");
      rec("S5a LRS stopped (simulated outage)", await waitLrs(false, 30000), await supervisor("status"));
      const status = await postToLms([engine(out1, "experienced", { id: `${auId}/4`, definition: { name: { "en-US": "Slide four" } } }), engine(out2, "experienced", { id: `${auId}/5`, definition: { name: { "en-US": "Slide five" } } })]);
      rec("S5b LMS still accepts learner statements while the LRS is down", status === 200, { status });
      await sleep(4000);
      let rows = await outboxRows(org.id, [out1, out2]);
      rec("S5c outbox holds them as pending with the failure recorded", rows.length === 2 && rows.every((r) => r.status === "pending"), rows.map((r) => ({ s: r.status, a: r.attempts, e: r.last_error?.slice(0, 60) })));
      const d = await drain(baseURL!);
      rows = await outboxRows(org.id, [out1, out2]);
      rec("S5d drainer marks them failed with backoff (attempts=1), not dead", rows.every((r) => r.status === "failed" && r.attempts === 1), { drain: { processed: d.processed, failed: d.failed, dead: d.dead }, rows: rows.map((r) => `${r.status}/${r.attempts}`) });
      await supervisor("start");
      rec("S5e LRS back up", await waitLrs(true, 120000), await supervisor("status"));
      await db.from("lrs_forward_outbox").update({ next_attempt_at: new Date(Date.now() - 1000).toISOString() }).eq("organization_id", org.id).in("statement_id", [out1, out2]);
      await drain(baseURL!);
      rows = await outboxRows(org.id, [out1, out2]);
      const stored = [(await lrsGet(out1)).status, (await lrsGet(out2)).status];
      rec("S5f after recovery the drainer delivers them (sent) and the LRS has them", rows.every((r) => r.status === "sent") && stored.every((s) => s === 200), { rows: rows.map((r) => r.status), stored });
    });

    // ---------- S6 dead-letter then resend ---------------------------------
    const deadId = randomUUID();
    await test.step("S6 dead-letter and Resend all history", async () => {
      await supervisor("stop");
      await waitLrs(false, 30000);
      await postToLms([engine(deadId, "experienced", { id: `${auId}/6`, definition: { name: { "en-US": "Slide six" } } })]);
      await sleep(3000);
      // Push the row to one attempt below the drainer's retry budget (MAX_ATTEMPTS = 36).
      await db.from("lrs_forward_outbox").update({ status: "failed", attempts: 35, next_attempt_at: new Date(Date.now() - 1000).toISOString() }).eq("organization_id", org.id).eq("statement_id", deadId);
      const d = await drain(baseURL!);
      let row = (await outboxRows(org.id, [deadId]))[0];
      rec("S6a failure past the retry budget dead-letters the row", row?.status === "dead", { drain: { dead: d.dead, failed: d.failed }, row: row ? `${row.status}/${row.attempts}` : "missing" });
      await supervisor("start");
      await waitLrs(true, 120000);
      await db.from("tenant_lrs_config").update({ backfill_requested_at: new Date().toISOString() }).eq("organization_id", org.id);
      for (let i = 0; i < 4; i++) await drain(baseURL!);
      row = (await outboxRows(org.id, [deadId]))[0];
      const stored = (await lrsGet(deadId)).status;
      rec("S6b 'Resend all history' recovers a dead-lettered statement (row re-queued and delivered)", row?.status === "sent" && stored === 200, { row: row ? `${row.status}/${row.attempts}` : "missing", lrs: stored, note: row?.status === "dead" ? "BUG: re-enqueue uses ignoreDuplicates, so an existing dead row is never reset; the statement never reaches the LRS" : "" });
      summary.deadAfterResend = row?.status;
    });

    // ---------- S7 permanent auth failure ----------------------------------
    const authId = randomUUID();
    await test.step("S7 wrong credentials", async () => {
      await db.from("tenant_lrs_config").update({ auth_secret: "WRONG" }).eq("organization_id", org.id);
      await postToLms([engine(authId, "experienced", { id: `${auId}/7`, definition: { name: { "en-US": "Slide seven" } } })]);
      await sleep(3000);
      let row = (await outboxRows(org.id, [authId]))[0];
      const live = row ? { status: row.status, err: row.last_error?.slice(0, 80) } : "missing";
      await db.from("lrs_forward_outbox").update({ next_attempt_at: new Date(Date.now() - 1000).toISOString() }).eq("organization_id", org.id).eq("statement_id", authId);
      const d = await drain(baseURL!);
      row = (await outboxRows(org.id, [authId]))[0];
      rec("S7a wrong secret → LRS 401 → row dead-lettered immediately as a permanent error (no endless retry)", row?.status === "dead" && /401/.test(row?.last_error ?? ""), { live, afterDrain: row ? `${row.status}/${row.attempts} ${row.last_error?.slice(0, 60)}` : "missing", drain: { dead: d.dead } });
      await db.from("tenant_lrs_config").update({ auth_secret: LRS_SECRET, backfill_requested_at: new Date().toISOString() }).eq("organization_id", org.id);
      for (let i = 0; i < 4; i++) await drain(baseURL!);
      row = (await outboxRows(org.id, [authId]))[0];
      rec("S7b after fixing the secret, 'Resend all history' delivers it", row?.status === "sent" && (await lrsGet(authId)).status === 200, { row: row ? `${row.status}/${row.attempts}` : "missing" });
    });

    // ---------- S8 through Caddy (TLS) --------------------------------------
    const tlsId = randomUUID();
    await test.step("S8 Caddy TLS proxy path", async () => {
      await db.from("tenant_lrs_config").update({ endpoint: CADDY }).eq("organization_id", org.id);
      const status = await postToLms([engine(tlsId, "experienced", { id: `${auId}/8`, definition: { name: { "en-US": "Slide eight" } } })]);
      const rows = await waitOutbox(org.id, [tlsId], "sent");
      rec("S8 statement delivered through the TLS endpoint (proxy → LRS)", status === 200 && !!rows && (await lrsGet(tlsId)).status === 200, { endpoint: CADDY.replace(/\/\/[^/]+/, "//…"), status, row: rows?.[0]?.status ?? (await outboxRows(org.id, [tlsId]))[0]?.last_error });
      await db.from("tenant_lrs_config").update({ endpoint: LRS_FOR_LMS }).eq("organization_id", org.id);
    });
  } finally {
    try { await supervisor("start"); } catch { /* ignore */ }
    const total = (await lrsByReg(attempt!.id)).length;
    summary.statementsForAttemptInLrs = total;
    summary.passed = R.filter((r) => r.ok).length;
    summary.failed = R.filter((r) => !r.ok).length;
    fs.writeFileSync(RESULTS, JSON.stringify({ summary, results: R }, null, 2));
    console.log(`RESULTS ${summary.passed} passed, ${summary.failed} failed → ${RESULTS}`);
  }
});
