/**
 * ADR 0003 step 14 — statements are write-once.
 *
 *   - a statement id POSTed twice with different bodies → 200 both times,
 *     the stored raw is the first body, `statement_conflict` is logged
 *   - an id-less statement POSTed twice (the KIVO engine's re-POST of the
 *     same queued object after a 5xx) → one row with the deterministic id
 *     (uuid5 over attempt|verb|object|timestamp|result|try), and the retry
 *     fires no second completion webhook and no second XP event
 *   - two id-less statements that differ only in their content timestamp →
 *     two rows
 *
 * Runs against a LOCAL dev server only: the completion-webhook listener
 * binds to 127.0.0.1 on the runner, which a deployed app cannot reach (keep
 * it out of a nightly against a remote URL). The statement_conflict log
 * line is its own case and needs LIFECYCLE_SERVER_LOG = the dev server's log
 * file; without it that case is skipped with that reason, never passed.
 */
import { test, expect, type BrowserContext } from "@playwright/test";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { addMember, createAuthUser, createOrg, svc } from "./data";
import { assignCourse, authedContext } from "./helpers";
import { VERB, XAPI_HEADERS, authTokenFor, cmi5Zip, inProgressAttempt, uploadNew } from "./p0-helpers";
import { deterministicStatementId } from "../../../lib/lrs/statement-id";

type User = { id: string; email: string; password: string };
const AU = "https://qa.bot/cmi5/au1";

test.describe.serial("ADR 0003 — statements are write-once", () => {
  const s: {
    org?: { id: string; slug: string };
    learner?: User;
    learnerCtx?: BrowserContext;
    attemptId?: string;
    auth?: string;
    hooks: string[];
    server?: http.Server;
    conflictId?: string;
  } = { hooks: [] };

  test.afterAll(async () => {
    await s.learnerCtx?.close().catch(() => {});
    await new Promise<void>((r) => (s.server ? s.server.close(() => r()) : r()));
  });

  const actor = () => ({ objectType: "Agent", name: s.learner!.email, account: { homePage: "https://qa.bot", name: s.learner!.id } });
  const post = (body: unknown) =>
    s.learnerCtx!.request.post("/api/xapi/statements", { headers: { ...XAPI_HEADERS, Authorization: s.auth! }, data: body });
  const rows = async (ids: string[]) => {
    const { data } = await svc()
      .from("xapi_statements")
      .select("statement_id, raw")
      .eq("attempt_id", s.attemptId!)
      .in("statement_id", ids);
    return (data ?? []) as Array<{ statement_id: string; raw: Record<string, unknown> }>;
  };
  const xpCount = async () => {
    const { count } = await svc().from("xp_events").select("id", { count: "exact", head: true }).eq("attempt_id", s.attemptId!);
    return count ?? 0;
  };

  test("seed: cmi5 course, a webhook listener, a learner with a live attempt", async ({ browser, baseURL }) => {
    // Local completion-webhook listener (loopback is allowed for tests).
    s.server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        s.hooks.push(body);
        res.writeHead(200).end("ok");
      });
    });
    await new Promise<void>((r) => s.server!.listen(0, "127.0.0.1", () => r()));
    const port = (s.server.address() as AddressInfo).port;

    const org = await createOrg({ name: "QA No Overwrite" });
    const owner = await createAuthUser({ profile: { first_name: "NoOver", last_name: "Owner", must_change_password: false } });
    await addMember({ organizationId: org.id, userId: owner.id, role: "super_owner" });
    const learner = await createAuthUser({ profile: { first_name: "NoOver", last_name: "Learner", must_change_password: false } });
    await addMember({ organizationId: org.id, userId: learner.id, role: "member" });
    s.org = org;
    s.learner = learner;

    const octx = await authedContext(browser, baseURL!, owner.email, owner.password);
    const hook = await octx.request.post("/api/org/integration-settings", {
      data: { orgSlug: org.slug, webhook_url: `http://127.0.0.1:${port}/hook` },
    });
    expect(hook.ok(), `webhook settings → ${hook.status()}: ${await hook.text()}`).toBeTruthy();
    const up = await uploadNew(octx.request, org.slug, "noover.zip", await cmi5Zip({ courseId: "https://qa.bot/cmi5/noover", title: "QA No Overwrite cmi5" }));
    expect(up.ok(), `upload → ${up.status()}: ${await up.text()}`).toBeTruthy();
    const courseId = (await up.json()).courseId as string;
    await assignCourse(octx.request, org.slug, courseId, learner.id);
    await octx.close();

    s.learnerCtx = await authedContext(browser, baseURL!, learner.email, learner.password);
    const launch = await s.learnerCtx.request.get(`/${org.slug}/courses/${courseId}/launch`);
    expect(launch.ok(), `launch → ${launch.status()}`).toBeTruthy();
    const { data: c } = await svc().from("courses").select("current_version_id").eq("id", courseId).single();
    s.attemptId = await inProgressAttempt(learner.id, (c as { current_version_id: string }).current_version_id);
    s.auth = await authTokenFor(s.learnerCtx.request, s.attemptId);
  });

  test("same id, different body → 200 both times; stored raw unchanged", async () => {
    const id = randomUUID();
    s.conflictId = id;
    const base = { id, actor: actor(), verb: { id: VERB("experienced") }, object: { objectType: "Activity", id: `${AU}/slide-1` }, context: { registration: s.attemptId } };
    const first = await post({ ...base, result: { response: "first" } });
    expect(first.status(), await first.text()).toBe(200);
    expect(await first.json()).toEqual([id]);
    const second = await post({ ...base, result: { response: "second" } });
    expect(second.status(), await second.text()).toBe(200);
    expect(await second.json()).toEqual([id]);

    const stored = await rows([id]);
    expect(stored).toHaveLength(1);
    expect((stored[0].raw.result as { response: string }).response).toBe("first");

    // An exact retry of the first body is accepted the same way.
    const retry = await post({ ...base, result: { response: "first" } });
    expect(retry.status()).toBe(200);
    expect(await rows([id])).toHaveLength(1);
  });

  test("the conflicting resend is logged as statement_conflict (attempt id + statement id)", async () => {
    const log = process.env.LIFECYCLE_SERVER_LOG;
    test.skip(!log || !fs.existsSync(log), "needs LIFECYCLE_SERVER_LOG = the local dev server's log file");
    const id = s.conflictId!;
    expect(id, "the previous case ran").toBeTruthy();
    await expect
      .poll(
        () =>
          fs
            .readFileSync(log!, "utf8")
            .split(/\r?\n/)
            .some((l) => l.includes('"statement_conflict"') && l.includes(id) && l.includes(s.attemptId!)),
        { timeout: 10_000 }
      )
      .toBe(true);
  });

  test("id-less statement re-POSTed → one row (deterministic id); no second webhook or XP event", async () => {
    const t0 = Date.now();
    const st = (verb: string, offsetMs: number, result?: unknown) => ({
      actor: actor(),
      verb: { id: VERB(verb) },
      object: { objectType: "Activity", id: AU },
      context: { registration: s.attemptId },
      // The engine stamps timestamp before the first send and re-queues the same object.
      timestamp: new Date(t0 + offsetMs).toISOString(),
      ...(result ? { result } : {}),
    });
    const opening = [st("launched", 0), st("initialized", 1000)];
    const r0 = await post(opening);
    expect(r0.status(), await r0.text()).toBe(200);

    const batch = [st("passed", 2000, { score: { scaled: 0.9 } }), st("completed", 3000, { completion: true })];
    const want = batch.map((b) => deterministicStatementId(s.attemptId!, b));
    const r1 = await post(batch);
    expect(r1.status(), await r1.text()).toBe(200);
    expect(await r1.json(), "ids are the deterministic uuid5 of each statement as sent").toEqual(want);
    const { data: att } = await svc().from("course_attempts").select("completion_status, success_status").eq("id", s.attemptId!).single();
    expect(att).toEqual({ completion_status: "completed", success_status: "passed" });
    await expect.poll(() => s.hooks.length, { timeout: 15_000, message: "the completion webhook fires once" }).toBe(1);
    const xpAfterFirst = await xpCount();
    expect(xpAfterFirst, "the first completion awarded XP (so 'no second XP event' checks something)").toBeGreaterThan(0);

    // The engine re-POSTs the identical queued batch after a 5xx.
    const r2 = await post(batch);
    expect(r2.status(), await r2.text()).toBe(200);
    expect(await r2.json()).toEqual(want);
    expect(await rows(want), "one row per statement, not two").toHaveLength(2);
    await new Promise((r) => setTimeout(r, 3000));
    expect(s.hooks.length, "no second completion webhook").toBe(1);
    expect(await xpCount(), "no second XP event").toBe(xpAfterFirst);
    expect(JSON.parse(s.hooks[0]).event).toBeTruthy();
  });

  test("two id-less statements that differ only in the content timestamp → two rows", async () => {
    const body = (ts: string) => ({
      actor: actor(),
      verb: { id: VERB("experienced") },
      object: { objectType: "Activity", id: `${AU}/slide-2` },
      context: { registration: s.attemptId },
      timestamp: ts,
    });
    const a = body(new Date(Date.now() + 10_000).toISOString());
    const b = body(new Date(Date.now() + 20_000).toISOString());
    const ra = await post(a);
    const rb = await post(b);
    expect([ra.status(), rb.status()]).toEqual([200, 200]);
    const [ida] = (await ra.json()) as string[];
    const [idb] = (await rb.json()) as string[];
    expect(ida).not.toBe(idb);
    expect([ida, idb]).toEqual([deterministicStatementId(s.attemptId!, a), deterministicStatementId(s.attemptId!, b)]);
    expect(await rows([ida, idb])).toHaveLength(2);
  });
});
