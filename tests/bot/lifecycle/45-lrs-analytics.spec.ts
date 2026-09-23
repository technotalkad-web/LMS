/**
 * External LRS — analytics profile (0078) against a local mock LRS.
 *
 * Runs against LOCAL dev (E2E_BASE_URL=http://localhost:3000): the dev server
 * must reach the mock on 127.0.0.1. Covers:
 *   - engine statements posted through /api/xapi/statements land in the
 *     outbox as the ENRICHED copy (stable course ids, mbox actor, learner /
 *     content / attempt dimensions, cmi5 context preserved) while our own
 *     xapi_statements row stays raw and progress/completion are unchanged
 *   - the drainer delivers the enriched copy and every statement passes the
 *     xAPI structural lint strict LRSs apply
 *   - with migration 0078: the sweeper derives LMS events (launched, XP …)
 *     and the "raw" profile forwards verbatim
 */
import http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { addMember, createAuthUser, createOrg, svc } from "../../e2e/helpers/supabase";
import { lintStatement } from "../lib/xapi-lint";

const NS = "https://ambak.com/xapi/";

type Mock = { url: string; received: Array<Record<string, unknown>>; close: () => Promise<void> };

async function startMockLrs(): Promise<Mock> {
  const received: Array<Record<string, unknown>> = [];
  const server = http.createServer((req, res) => {
    if (req.url?.includes("/about")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ version: ["1.0.3"] }));
      return;
    }
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      try {
        const body = JSON.parse(buf);
        received.push(...(Array.isArray(body) ? body : [body]));
      } catch {
        /* ignore */
      }
      res.writeHead(200, { "content-type": "application/json" }).end("[]");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, received, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function has0078() {
  const { error } = await svc().from("tenant_lrs_config").select("backfill_cursor").limit(1);
  return !error;
}

async function drain(baseURL: string) {
  const res = await fetch(`${baseURL}/api/cron/lrs-forward`, {
    method: "POST",
    headers: { "x-cron-secret": process.env.CRON_SECRET ?? "" },
  });
  return res.json().catch(() => ({}));
}

test("LRS analytics profile: enriched copy, raw internal, lint-clean delivery, derived events", async ({ baseURL }) => {
  test.skip(!process.env.E2E_BASE_URL?.includes("localhost"), "needs a local dev server that can reach the mock LRS");
  const { error: cfgErr } = await svc().from("tenant_lrs_config").select("organization_id").limit(1);
  test.skip(!!cfgErr, "migration 0044 (tenant_lrs_config) not applied");

  const mock = await startMockLrs();
  const db = svc();
  try {
    const org = await createOrg({ name: "QA LRS Analytics" });
    const learner = await createAuthUser({
      profile: { first_name: "Asha", last_name: "Patel", must_change_password: false },
    });
    await addMember({ organizationId: org.id, userId: learner.id, role: "member" });
    await db
      .from("organization_members")
      .update({ business_vertical: "Fulfillment", branch: "Thane", designation: "Area Manager", employee_id: "QA-LRS-45", date_of_joining: "2026-01-15" })
      .eq("organization_id", org.id)
      .eq("user_id", learner.id);

    // A cmi5 course + version with a known AU id, an open attempt, a launch token.
    const { data: course, error: courseErr } = await db
      .from("courses")
      .insert({ organization_id: org.id, title: "QA LRS Module", slug: `qa-lrs-${randomUUID().slice(0, 8)}`, status: "published" })
      .select("id")
      .single();
    expect(courseErr, `course insert: ${courseErr?.message}`).toBeNull();
    const auId = "urn:qa:lrs:module";
    const { data: pkg } = await db
      .from("course_packages")
      .insert({ course_id: course!.id, language: "en", display_name: "English" })
      .select("id")
      .single();
    const { data: version, error: versionErr } = await db
      .from("course_versions")
      .insert({
        course_id: course!.id,
        version_number: 1,
        manifest_type: "cmi5",
        launch_url: "index.html",
        storage_prefix: `courses/${course!.id}/v1/`,
        manifest_data: { raw: { auId }, unitCount: 5 },
        package_id: pkg?.id ?? null,
      })
      .select("id")
      .single();
    expect(versionErr, `version insert: ${versionErr?.message}`).toBeNull();
    await db.from("courses").update({ current_version_id: version!.id }).eq("id", course!.id);
    const { data: attempt } = await db
      .from("course_attempts")
      .insert({ course_version_id: version!.id, user_id: learner.id, organization_id: org.id, status: "in_progress", completion_status: "in_progress", success_status: "unknown" })
      .select("id")
      .single();
    const token = randomBytes(32).toString("hex");
    await db.from("cmi5_launch_tokens").insert({ auth_token: token, attempt_id: attempt!.id });

    await db.from("tenant_lrs_config").upsert(
      { organization_id: org.id, enabled: true, endpoint: mock.url, auth_key: "k", auth_secret: "s", xapi_version: "1.0.3" },
      { onConflict: "organization_id" }
    );

    const actor = { objectType: "Agent", name: learner.email, account: { homePage: baseURL, name: learner.id } };
    const ctx = {
      registration: attempt!.id,
      extensions: { "https://w3id.org/xapi/cmi5/context/extensions/sessionid": randomUUID() },
      contextActivities: { category: [{ id: "https://w3id.org/xapi/cmi5/context/categories/cmi5" }] },
    };
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const res = await fetch(`${baseURL}/api/xapi/statements`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-experience-api-version": "1.0.3" },
      body: JSON.stringify([
        { id: ids[0], actor, verb: { id: "http://adlnet.gov/expapi/verbs/experienced" }, object: { id: `${auId}/3`, definition: { name: { "en-US": "Slide three" } } }, context: ctx, timestamp: new Date().toISOString() },
        { id: ids[1], actor, verb: { id: "http://adlnet.gov/expapi/verbs/answered" }, object: { id: `${auId}/3_q_k1`, definition: { interactionType: "choice", correctResponsesPattern: ["b"], choices: [{ id: "a", description: { "en-US": "A" } }, { id: "b", description: { "en-US": "B" } }] } }, result: { success: false, response: "a" }, context: ctx, timestamp: new Date().toISOString() },
        { id: ids[2], actor, verb: { id: "http://adlnet.gov/expapi/verbs/failed" }, object: { id: auId }, result: { score: { scaled: 0.4, raw: 4, max: 10, min: 0 }, success: false, completion: true, duration: "PT9M" }, context: ctx, timestamp: new Date().toISOString() },
      ]),
    });
    expect(res.status, "our LRS accepts the statements").toBe(200);

    // Internal copy raw; attempt processed as before.
    const { data: internal } = await db.from("xapi_statements").select("statement_id, raw").eq("attempt_id", attempt!.id);
    const rawAnswered = internal!.find((r) => r.statement_id === ids[1])!.raw as { actor: { account?: { name: string } }; object: { id: string } };
    expect(rawAnswered.actor.account?.name).toBe(learner.id);
    expect(rawAnswered.object.id).toBe(`${auId}/3_q_k1`);
    const { data: att } = await db.from("course_attempts").select("completion_status, success_status, score, progress_pct").eq("id", attempt!.id).single();
    expect(att).toMatchObject({ completion_status: "completed", success_status: "failed", progress_pct: 100 });
    expect(Number(att!.score)).toBeCloseTo(0.4);

    // Outbox: enriched copy.
    await new Promise((r) => setTimeout(r, 1500));
    const { data: outbox } = await db.from("lrs_forward_outbox").select("statement_id, payload, status").eq("organization_id", org.id);
    expect(outbox!.length).toBe(3);
    type Stmt = { actor: Record<string, unknown>; object: { id: string; definition?: Record<string, unknown> }; result?: Record<string, unknown>; context: { registration?: string; language?: string; extensions: Record<string, unknown>; contextActivities: { parent?: Array<{ id: string }>; grouping?: Array<{ id: string }>; category?: Array<{ id: string }> } } };
    const ans = outbox!.find((r) => r.statement_id === ids[1])!.payload as Stmt;
    expect(ans.actor.mbox).toBe(`mailto:${learner.email.toLowerCase()}`);
    expect(ans.actor.account).toBeUndefined();
    expect(ans.object.id).toBe(`${NS}activities/course/${course!.id}/question/3_q_k1`);
    expect(ans.context.contextActivities.parent?.[0].id).toBe(`${NS}activities/course/${course!.id}/slide/3`);
    expect(ans.context.contextActivities.grouping?.map((g) => g.id)).toContain(`${NS}activities/course/${course!.id}`);
    expect(ans.context.contextActivities.category?.some((c) => c.id.includes("cmi5"))).toBeTruthy();
    expect(ans.context.registration).toBe(attempt!.id);
    const E = ans.context.extensions;
    expect(E[`${NS}ext/learner/segment`]).toBe("E2E");
    expect(E[`${NS}ext/learner/vertical`]).toBe("Fulfillment");
    expect(E[`${NS}ext/learner/branch`]).toBe("Thane");
    expect(E[`${NS}ext/learner/employee-id`]).toBe("QA-LRS-45");
    expect(E[`${NS}ext/content/course-id`]).toBe(course!.id);
    expect(E[`${NS}ext/attempt/number`]).toBe(1);
    expect(E[`${NS}ext/statement/origin`]).toBe("engine");
    expect(ans.result).toMatchObject({ success: false, response: "a" });
    expect((ans.object.definition as { interactionType?: string }).interactionType).toBe("choice");
    const fail = outbox!.find((r) => r.statement_id === ids[2])!.payload as Stmt;
    expect(fail.object.id).toBe(`${NS}activities/course/${course!.id}`);
    expect(fail.result?.score).toMatchObject({ scaled: 0.4, raw: 4, max: 10 });
    for (const row of outbox!) expect(lintStatement(row.payload), `lint ${row.statement_id}`).toEqual([]);

    // Delivery: mock holds the enriched copy under the same ids.
    if (mock.received.length < 3) await drain(baseURL!);
    for (const id of ids) {
      const got = mock.received.find((s) => s.id === id) as Stmt | undefined;
      expect(got, `mock received ${id}`).toBeTruthy();
      expect(got!.object.id.startsWith(`${NS}activities/course/`)).toBeTruthy();
    }

    if (await has0078()) {
      // Sweeper (runs inside the cron drainer): derives launched + XP etc.
      const sweep = (await drain(baseURL!)) as { sweep?: Array<{ org: string; ran: string[]; enqueued: Record<string, number> }> };
      const mine = sweep.sweep?.find((s) => s.org === org.id);
      expect(mine, "sweeper ran for the org").toBeTruthy();
      expect(mine!.ran).toContain("statements");
      // launched is derived from course_attempts; run the drainer until the
      // rotating window has covered the attempts source.
      for (let i = 0; i < 4; i++) {
        const { data: launched } = await db.from("lrs_forward_outbox").select("payload").eq("organization_id", org.id).eq("origin", "lms");
        if ((launched ?? []).some((r) => (r.payload as { verb: { id: string } }).verb.id.endsWith("/launched"))) break;
        await drain(baseURL!);
      }
      const { data: lms } = await db.from("lrs_forward_outbox").select("payload").eq("organization_id", org.id).eq("origin", "lms");
      const launched = (lms ?? []).map((r) => r.payload as Stmt & { verb: { id: string } }).find((s) => s.verb.id.endsWith("/launched"));
      expect(launched, "derived launched statement").toBeTruthy();
      expect(launched!.object.id).toBe(`${NS}activities/course/${course!.id}`);
      expect(launched!.context.registration).toBe(attempt!.id);
      expect(lintStatement(launched)).toEqual([]);
      // History sweep re-enqueued nothing twice (same ids).
      const { data: all } = await db.from("lrs_forward_outbox").select("statement_id").eq("organization_id", org.id);
      expect(new Set(all!.map((r) => r.statement_id)).size).toBe(all!.length);

      // Raw profile: verbatim.
      await db.from("tenant_lrs_config").update({ statement_profile: "raw" }).eq("organization_id", org.id);
      const rawId = randomUUID();
      await fetch(`${baseURL}/api/xapi/statements`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify([{ id: rawId, actor, verb: { id: "http://adlnet.gov/expapi/verbs/terminated" }, object: { id: auId }, context: ctx }]),
      });
      await new Promise((r) => setTimeout(r, 1000));
      const { data: rawRow } = await db.from("lrs_forward_outbox").select("payload").eq("statement_id", rawId).single();
      const rawPayload = rawRow!.payload as Stmt;
      expect(rawPayload.object.id).toBe(auId);
      expect((rawPayload.actor.account as { name: string }).name).toBe(learner.id);
    }
  } finally {
    await mock.close();
  }
});
