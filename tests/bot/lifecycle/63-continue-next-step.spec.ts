/**
 * ADR 0019 on staging: the launch bar's Continue button and the continue
 * address (/{org}/continue?lp=<path>&from=<course>), on a strict three-step
 * Learning Path (steps 1 and 2 cmi5, step 3 SCORM 1.2; step 2 pass_required).
 *
 *   (a)  the bar: a path launch with the official attempt in progress shows
 *        continue-next waiting (no href, aria-disabled; a tap shows "Finish
 *        this module to continue" and stays on the page; the status route
 *        answers { stored: false }), the launch-bar test id, no practice-badge
 *        on a first visit, the title of a package that is not a KIVO build; a
 *        Library launch has no continue-next;
 *   (b)  Continue before the result: the address waits at least 6 s, shows
 *        "Saving your result", ends on the path page's saving banner, and
 *        changes no row;
 *   (b2) a result stored during the wait: the address reads it (each read
 *        fresh, not Next's memoized first answer) and moves on to step 2
 *        before the bound;
 *   (c)  the normal path: a stored pass moves on at once to step 2's launch,
 *        whose new row carries the path;
 *   (d)  step 2 in progress: the saving banner; the strict lock still refuses
 *        step 3 (today's lock, unchanged);
 *   (e)  a failed result on the pass_required step 2: the failed banner, never
 *        step 3's launch, step 2 still current;
 *   (e2) a failed result on step 1 (not pass_required): moves on to step 2;
 *   (k)  the live state on a cmi5 launch (ADR 0019, note of 2026-11-11): C's
 *        step 2 waits; once its pass is stored the status route answers
 *        stored, the bar's own poll (no tap) turns Continue ready within one
 *        interval, and a tap on the ready button goes on to step 3's launch; a
 *        relaunch of step 2 (a revision visit) is ready on first render; the
 *        route refuses another learner's attempt, a bad id and a signed-out
 *        call, and writes nothing;
 *   (f)  the SCORM runtime: Continue waits on step 3 and turns ready after the
 *        parent's own passed commit through window.API, then the end banner
 *        and the celebration;
 *   (g)  a revision visit: Continue is ready (href to the continue address)
 *        and moves on at once; the badge and Continue show together;
 *   (h)  refusals: from not a step, lp not a uuid, another organisation's path;
 *   (i)  staff: an admin's Continue skips the wait and writes no row;
 *   (j)  widths and a 120-character title: Exit, Revision Mode and Continue
 *        visible and never overlapping at 320, 390, 640, 768 and 1280 px; the
 *        bar about 41 px high below sm and 49 px from sm.
 *
 * Hydration: launchPage() returns once the server-rendered bar is visible,
 * before React has attached the waiting button's tap handler or the SCORM
 * runtime has installed window.API, so a tap is retried inside toPass() and
 * every window.API drive waits for the API first. The waiting button carries
 * aria-disabled on role="link", which Playwright reads as disabled, so a tap
 * is a forced click.
 *
 * Every redirect is asserted with redirectedExactly(): a 3xx Location ending
 * with the target, or Next's redirect marker naming it in the 200 body once
 * the loading boundary has streamed. Never a bare substring of the body:
 * every learner page carries /{org}/dashboard links.
 *
 * By hand on staging (npm run test:lifecycle), after both staging deployments
 * carry the branch, never while another lifecycle run is in progress. In the
 * nightly subset since its first green staging run, 2026-11-11 (ADR 0019
 * decision 7). Data stays in the lifecycle-* namespace.
 */
import { test, expect, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { addMember, createAuthUser, createOrg, rand, svc } from "./data";
import { assignCourse, authedContext, courseHandle } from "./helpers";
import { authTokenFor, cmi5Zip, scormZip, uploadNew, VERB, XAPI_HEADERS } from "./p0-helpers";

type User = { id: string; email: string; password: string };
const AU = "https://qa.bot/cmi5/au1";
/** Step 1's title, exactly 120 characters (case (j)). */
const LONG_TITLE = `QA Continue Step One ${"with a deliberately long module title ".repeat(4)}`.slice(0, 120);
/** The continue address's wait (CONTINUE_WAIT_MS): with no stored result it answers after at least this. */
const WAIT_MS = 6_000;
/**
 * "Moves on at once" ("about 2 s" in the record) is asserted against the
 * waits this run measured, not a fixed figure: a prompt answer beats the
 * shortest of them ((b), then the lower of (b) and (d)) by at least half of
 * WAIT_MS. A wait sleeps the full WAIT_MS on top of the same reads plus six
 * more reads of the attempts, so the real gap is over 6 s in any
 * environment, while both figures move with the database latency; up to
 * about three of the six one-second sleeps still pass as "at once". A fixed
 * 4 s came first; Cloud Run staging met it, but at a GitHub runner's latency
 * (local runs with 270 ms added to every database call, 2026-11-12) a
 * prompt answer takes 3.5 to 4.4 s and a wait about 12 s, and the nightly
 * runner crossed 4 s.
 */
const PROMPT_GAP_MS = WAIT_MS / 2;
const BANNERS = ["continue-saving-banner", "continue-failed-banner", "continue-end-banner"];
/** The waiting button's message (lib/learner/continue-state.ts CONTINUE_WAITING_MESSAGE). */
const WAITING_MESSAGE = "Finish this module to continue";
/** The bar's status route for one attempt (ADR 0019, note of 2026-11-11). */
const statusUrl = (attemptId: string) => `/api/attempts/${attemptId}/result-stored`;

/** spec 61's statement(), copied (spec 61 stays unchanged). */
function statement(learner: User, verb: string, registration: string, extra: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    actor: { objectType: "Agent", name: learner.email, account: { homePage: "https://qa.bot", name: learner.id } },
    verb: { id: VERB(verb) },
    object: { objectType: "Activity", id: AU },
    context: { registration },
    ...extra,
  };
}

/** spec 61's finish(), copied: crafted cmi5 statements on the attempt's own launch token. */
async function finish(req: APIRequestContext, learner: User, attemptId: string, outcome: "passed" | "failed", scaled: number) {
  const auth = await authTokenFor(req, attemptId);
  const res = await req.post("/api/xapi/statements", {
    headers: { ...XAPI_HEADERS, Authorization: auth },
    data: [
      statement(learner, "initialized", attemptId),
      statement(learner, "completed", attemptId, { result: { completion: true } }),
      statement(learner, outcome, attemptId, { result: { success: outcome === "passed", score: { scaled } } }),
    ],
  });
  expect(res.status(), await res.text()).toBe(200);
}

type NoFollow = { status: number; location: string; body: string; ms: number };

/** GET without following redirects, timed to the end of the body (the continue page streams, then redirects). */
async function noFollow(req: APIRequestContext, url: string): Promise<NoFollow> {
  const t0 = Date.now();
  const res = await req.get(url, { maxRedirects: 0, timeout: 120_000 });
  const location = res.headers()["location"] ?? "";
  const body = res.status() === 200 ? await res.text() : "";
  return { status: res.status(), location, body, ms: Date.now() - t0 };
}

/** The redirect named exactly `target` (a path from the site root, with its query). */
function redirectedExactly(r: NoFollow, target: string): boolean {
  if (r.status >= 300 && r.status < 400) {
    let path = r.location;
    try {
      const u = new URL(r.location, "http://x.invalid");
      path = u.pathname + u.search;
    } catch {
      /* compare the raw header */
    }
    return path === target || r.location.endsWith(target);
  }
  const esc = target.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
  return r.status === 200 && new RegExp(`NEXT_REDIRECT;(?:replace|push);${esc};`).test(r.body);
}

const describe = (r: NoFollow) => `${r.status} ${r.location || "(body)"} in ${r.ms} ms`;

type Att = { id: string; status: string; completion_status: string; success_status: string; score: number | null; completed_at: string | null; learning_path_id: string | null };
async function attemptsOn(userId: string, versionId: string): Promise<Att[]> {
  const { data, error } = await svc()
    .from("course_attempts")
    .select("id, status, completion_status, success_status, score, completed_at, learning_path_id")
    .eq("user_id", userId)
    .eq("course_version_id", versionId)
    .order("started_at");
  expect(error, `attempts read: ${error?.message}`).toBeNull();
  return (data ?? []) as Att[];
}

type Box = { x: number; y: number; width: number; height: number };
const overlap = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test.describe.serial("ADR 0019 — Continue to the next step of a Learning Path", () => {
  const s: {
    org?: { id: string; slug: string };
    adminCtx?: BrowserContext;
    previewer?: User;
    previewCtx?: BrowserContext;
    a?: User;
    b?: User;
    c?: User;
    aCtx?: BrowserContext;
    bCtx?: BrowserContext;
    cCtx?: BrowserContext;
    c1?: string;
    c2?: string;
    c3?: string;
    c4?: string;
    v1?: string;
    v2?: string;
    v3?: string;
    pathId?: string;
    otherPathId?: string;
    a1?: string;
    /** (b)'s measured wait, the reference of expectPrompt. */
    waitMs?: number;
  } = {};
  const slug = () => s.org!.slug;
  const launchUrl = (courseId: string, lp = true) => `/${slug()}/courses/${courseId}/launch${lp ? `?lp=${s.pathId}` : ""}`;
  const continueUrl = (from: string, lp = s.pathId!) => `/${slug()}/continue?lp=${lp}&from=${from}`;
  const pathUrl = (q = "") => `/${slug()}/paths/${s.pathId}${q}`;
  /** A prompt answer of the continue address (PROMPT_GAP_MS). */
  const expectPrompt = (r: NoFollow) => {
    expect(s.waitMs, "(b) measured a wait").toBeDefined();
    const bound = s.waitMs! - PROMPT_GAP_MS;
    expect(r.ms, `${describe(r)}; prompt bound ${bound} ms`).toBeLessThan(bound);
  };

  /** A browser page on a launch whose module content never loads, so no fixture spends the attempt's fetch token. */
  async function launchPage(ctx: BrowserContext, url: string): Promise<Page> {
    const page = await ctx.newPage();
    await page.route(/\/content\//, (r) => r.abort());
    const res = await page.goto(url, { timeout: 120_000 });
    expect(res?.status(), `launch page → ${res?.status()}`).toBe(200);
    await expect(page.getByTestId("launch-bar")).toBeVisible({ timeout: 60_000 });
    return page;
  }

  async function getOk(ctx: BrowserContext, url: string): Promise<string> {
    const r = await ctx.request.get(url, { timeout: 120_000 });
    expect(r.ok(), `${url} → ${r.status()}`).toBeTruthy();
    return r.text();
  }

  test.afterAll(async () => {
    for (const ctx of [s.aCtx, s.bCtx, s.cCtx, s.previewCtx, s.adminCtx]) await ctx?.close().catch(() => {});
  });

  test("seed: a strict path of three courses (step 2 pass_required), a Library course, learners A, B, C and an admin", async ({ browser, baseURL }) => {
    const org = await createOrg({ name: "Lifecycle Continue" });
    s.org = org;
    const admin = await createAuthUser({ profile: { first_name: "Continue", last_name: "Owner", must_change_password: false } });
    await addMember({ organizationId: org.id, userId: admin.id, role: "super_owner" });
    s.adminCtx = await authedContext(browser, baseURL!, admin.email, admin.password);
    const areq = s.adminCtx.request;

    const up = async (name: string, buf: Buffer) => {
      const r = await uploadNew(areq, org.slug, name, buf);
      expect(r.ok(), `upload ${name} → ${r.status()}: ${await r.text()}`).toBeTruthy();
      return (await r.json()).courseId as string;
    };
    const tag = rand(6);
    s.c1 = await up("c1.zip", await cmi5Zip({ courseId: `urn:qa:continue:${tag}:one`, title: LONG_TITLE }));
    s.c2 = await up("c2.zip", await cmi5Zip({ courseId: `urn:qa:continue:${tag}:two`, title: "QA Continue Step Two" }));
    s.c3 = await up("c3.zip", await scormZip({ title: "QA Continue Step Three" }));
    s.c4 = await up("c4.zip", await scormZip({ title: "QA Continue Library Course" }));
    // The 120-character title, whatever the upload kept; step 2 needs a pass.
    const { error: te } = await svc().from("courses").update({ title: LONG_TITLE }).eq("id", s.c1);
    expect(te, `title: ${te?.message}`).toBeNull();
    const { error: pe } = await svc().from("courses").update({ pass_required: true }).eq("id", s.c2);
    expect(pe, `pass_required: ${pe?.message}`).toBeNull();
    s.v1 = (await courseHandle(s.c1)).versionId;
    s.v2 = (await courseHandle(s.c2)).versionId;
    s.v3 = (await courseHandle(s.c3)).versionId;

    const { data: p, error: pathErr } = await svc()
      .from("learning_paths")
      .insert({ organization_id: org.id, name: "Continue Path", slug: `qa-cnt-${rand(6)}`, sequence_mode: "strict" })
      .select("id")
      .single();
    expect(pathErr, `path seed: ${pathErr?.message}`).toBeNull();
    s.pathId = (p as { id: string }).id;
    const { error: se } = await svc().from("learning_path_courses").insert([
      { path_id: s.pathId, course_id: s.c1, step_number: 1 },
      { path_id: s.pathId, course_id: s.c2, step_number: 2 },
      { path_id: s.pathId, course_id: s.c3, step_number: 3 },
    ]);
    expect(se, `path steps: ${se?.message}`).toBeNull();

    for (const who of ["A", "B", "C"] as const) {
      const u = await createAuthUser({ profile: { first_name: "Continue", last_name: who, must_change_password: false } });
      await addMember({ organizationId: org.id, userId: u.id, role: "member" });
      const { error: ae } = await svc().from("learning_path_assignments").insert({ organization_id: org.id, path_id: s.pathId, assignee_type: "user", user_id: u.id });
      expect(ae, `path assignment ${who}: ${ae?.message}`).toBeNull();
      if (who === "A") s.a = u;
      else if (who === "B") s.b = u;
      else s.c = u;
    }
    await assignCourse(areq, org.slug, s.c4, s.a!.id);

    const previewer = await createAuthUser({ profile: { first_name: "Continue", last_name: "Preview", must_change_password: false } });
    await addMember({ organizationId: org.id, userId: previewer.id, role: "admin" });
    s.previewer = previewer;

    // Another organisation's path, for (h).
    const other = await createOrg({ name: "Lifecycle Continue Other" });
    const { data: op, error: ope } = await svc()
      .from("learning_paths")
      .insert({ organization_id: other.id, name: "Other Path", slug: `qa-cnt-o-${rand(6)}` })
      .select("id")
      .single();
    expect(ope, `other path: ${ope?.message}`).toBeNull();
    s.otherPathId = (op as { id: string }).id;

    s.aCtx = await authedContext(browser, baseURL!, s.a!.email, s.a!.password);
    s.bCtx = await authedContext(browser, baseURL!, s.b!.email, s.b!.password);
    s.cCtx = await authedContext(browser, baseURL!, s.c!.email, s.c!.password);
    s.previewCtx = await authedContext(browser, baseURL!, previewer.email, previewer.password);
  });

  test("(a) the bar: Continue waits on a path launch while the official attempt is in progress, none on a Library launch", async () => {
    const page = await launchPage(s.aCtx!, launchUrl(s.c1!));
    const next = page.getByTestId("continue-next");
    await expect(next).toHaveAttribute("data-state", "waiting");
    await expect(next).toHaveAttribute("aria-disabled", "true");
    expect(await next.getAttribute("href"), "no href while waiting: inert before hydration").toBeNull();
    const msg = page.getByTestId("continue-waiting-message");
    await expect(msg).toHaveCount(1);
    await expect(msg).toHaveText("");
    const html = await page.content();
    expect(html).toContain('data-testid="launch-bar"');
    expect(html).not.toContain("practice-badge");
    // The synthetic cmi5 package is not a KIVO build: its title shows from sm.
    await expect(page.getByTestId("launch-bar").getByText(LONG_TITLE)).toBeVisible();
    // A tap checks the status and shows the message; retried until hydration
    // has attached the handler. It never navigates.
    const at = page.url();
    await expect(async () => {
      await next.click({ force: true, timeout: 5_000 });
      await expect(msg).toHaveText(WAITING_MESSAGE, { timeout: 2_500 });
    }).toPass({ timeout: 30_000 });
    expect(page.url(), "a tap on the waiting button stays on the launch").toBe(at);
    await expect(next).toHaveAttribute("data-state", "waiting");
    await page.close();
    const rows = await attemptsOn(s.a!.id, s.v1!);
    expect(rows.length, "one attempt on step 1").toBe(1);
    expect(rows[0].learning_path_id, "the launch carries the path").toBe(s.pathId);
    s.a1 = rows[0].id;
    const st = await s.aCtx!.request.get(statusUrl(s.a1));
    expect(st.status(), await st.text()).toBe(200);
    expect(st.headers()["cache-control"] ?? "").toContain("no-store");
    expect(await st.json()).toEqual({ stored: false });

    const lib = await getOk(s.aCtx!, launchUrl(s.c4!, false));
    expect(lib).toContain('data-testid="launch-bar"');
    expect(lib).not.toContain('data-testid="continue-next"');
  });

  test("(b) Continue before the result: at least 6 s, Saving your result, the saving banner, nothing changed", async () => {
    const before = (await attemptsOn(s.a!.id, s.v1!))[0];
    const r = await noFollow(s.aCtx!.request, continueUrl(s.c1!));
    expect(r.ms, describe(r)).toBeGreaterThanOrEqual(WAIT_MS);
    s.waitMs = r.ms;
    expect(r.body, "the loading screen streamed first").toContain("continue-saving");
    expect(redirectedExactly(r, pathUrl("?saving=1")), describe(r)).toBe(true);
    const after = await attemptsOn(s.a!.id, s.v1!);
    expect(after.length).toBe(1);
    const pick = (x: Att) => ({ status: x.status, completion_status: x.completion_status, success_status: x.success_status, score: x.score, completed_at: x.completed_at });
    expect(pick(after[0])).toEqual(pick(before));
    expect((await attemptsOn(s.a!.id, s.v2!)).length, "no attempt on step 2").toBe(0);
    expect(await getOk(s.aCtx!, pathUrl("?saving=1"))).toContain('data-testid="continue-saving-banner"');
  });

  test("(b2) a result stored during the wait: Continue moves on to step 2 before the bound", async ({ browser, baseURL }) => {
    // A learner of its own, so no other case's rows change. The result lands
    // through the service role mid-wait (as spec 46 stores one): the case is
    // about the address's reads, and a statements round trip from a runner
    // can outlast the 6 s wait. (b)'s wait minus WAIT_MS is the time before
    // the first read of the attempts plus seven of those reads, so the row
    // changes after that first read and well before the last one.
    const d = await createAuthUser({ profile: { first_name: "Continue", last_name: "D", must_change_password: false } });
    await addMember({ organizationId: s.org!.id, userId: d.id, role: "member" });
    const { error: ae } = await svc().from("learning_path_assignments").insert({ organization_id: s.org!.id, path_id: s.pathId, assignee_type: "user", user_id: d.id });
    expect(ae, `path assignment D: ${ae?.message}`).toBeNull();
    const dCtx = await authedContext(browser, baseURL!, d.email, d.password);
    try {
      await getOk(dCtx, launchUrl(s.c1!));
      const [d1] = await attemptsOn(d.id, s.v1!);
      expect(d1.status).toBe("in_progress");
      const storeAt = Math.max(500, s.waitMs! - WAIT_MS + 500);
      const t0 = Date.now();
      const pending = noFollow(dCtx.request, continueUrl(s.c1!));
      await new Promise((res) => setTimeout(res, storeAt));
      const { error: ue } = await svc()
        .from("course_attempts")
        .update({ completion_status: "completed", success_status: "passed", status: "passed", score: 0.9, completed_at: new Date().toISOString() })
        .eq("id", d1.id);
      expect(ue, `store: ${ue?.message}`).toBeNull();
      const storedAt = Date.now() - t0;
      const r = await pending;
      expect(redirectedExactly(r, launchUrl(s.c2!)), `${describe(r)}; stored at ${storedAt} ms`).toBe(true);
      expect(r.ms, "it waited: no answer before the store was sent").toBeGreaterThanOrEqual(storeAt);
      expect(r.ms, "before the bound").toBeLessThan(s.waitMs!);
    } finally {
      await dCtx.close();
    }
  });

  test("(c) a stored pass moves on at once to step 2, whose new row carries the path", async () => {
    await finish(s.aCtx!.request, s.a!, s.a1!, "passed", 0.9);
    const r = await noFollow(s.aCtx!.request, continueUrl(s.c1!));
    expectPrompt(r);
    expect(redirectedExactly(r, launchUrl(s.c2!)), describe(r)).toBe(true);
    await getOk(s.aCtx!, launchUrl(s.c2!));
    const rows = await attemptsOn(s.a!.id, s.v2!);
    expect(rows.length).toBe(1);
    expect(rows[0].learning_path_id).toBe(s.pathId);
  });

  test("(d) step 2 in progress: the saving banner; the strict lock still refuses step 3", async () => {
    const r = await noFollow(s.aCtx!.request, continueUrl(s.c2!));
    expect(r.ms, describe(r)).toBeGreaterThanOrEqual(WAIT_MS);
    s.waitMs = Math.min(s.waitMs ?? r.ms, r.ms);
    expect(redirectedExactly(r, pathUrl("?saving=1")), describe(r)).toBe(true);
    const lock = await noFollow(s.aCtx!.request, launchUrl(s.c3!));
    expect(redirectedExactly(lock, `/${slug()}/dashboard?locked=${s.c3}`), describe(lock)).toBe(true);
  });

  test("(e) a failed result on the pass_required step 2: the failed banner, never step 3, step 2 still current", async () => {
    const [a2] = await attemptsOn(s.a!.id, s.v2!);
    await finish(s.aCtx!.request, s.a!, a2.id, "failed", 0.4);
    const r = await noFollow(s.aCtx!.request, continueUrl(s.c2!));
    expectPrompt(r);
    expect(redirectedExactly(r, pathUrl("?failed=1")), describe(r)).toBe(true);
    expect((await attemptsOn(s.a!.id, s.v3!)).length, "no attempt on step 3").toBe(0);
    const html = await getOk(s.aCtx!, pathUrl("?failed=1"));
    expect(html).toContain('data-testid="continue-failed-banner"');
    // Step 2 is current: its card launches it (a completed step links to the course page instead).
    expect(html).toContain(`href="${launchUrl(s.c2!)}"`);
    expect(html).not.toContain(`href="${launchUrl(s.c3!)}"`);
  });

  test("(e2) a failed result on step 1, which is not pass_required, moves on to step 2", async () => {
    await getOk(s.cCtx!, launchUrl(s.c1!));
    const [c1Row] = await attemptsOn(s.c!.id, s.v1!);
    await finish(s.cCtx!.request, s.c!, c1Row.id, "failed", 0.4);
    const r = await noFollow(s.cCtx!.request, continueUrl(s.c1!));
    expectPrompt(r);
    expect(redirectedExactly(r, launchUrl(s.c2!)), describe(r)).toBe(true);
    await getOk(s.cCtx!, launchUrl(s.c2!));
    const rows = await attemptsOn(s.c!.id, s.v2!);
    expect(rows.length).toBe(1);
    expect(rows[0].learning_path_id).toBe(s.pathId);
  });

  test("(k) the live state on a cmi5 launch: waiting until stored, then on; the status route's answers and refusals", async ({ browser, baseURL }) => {
    // C's step 2 row from (e2): in progress, on the pass_required course.
    const [c2Row] = await attemptsOn(s.c!.id, s.v2!);
    expect(c2Row.status, "C's step 2 is in progress").toBe("in_progress");
    const creq = s.cCtx!.request;

    const page = await launchPage(s.cCtx!, launchUrl(s.c2!));
    const next = page.getByTestId("continue-next");
    await expect(next).toHaveAttribute("data-state", "waiting");
    expect(await next.getAttribute("href")).toBeNull();
    const r0 = await creq.get(statusUrl(c2Row.id));
    expect(r0.status(), await r0.text()).toBe(200);
    expect(await r0.json()).toEqual({ stored: false });

    await finish(creq, s.c!, c2Row.id, "passed", 0.9);
    const stored = (await attemptsOn(s.c!.id, s.v2!)).find((x) => x.id === c2Row.id)!;
    expect(stored.success_status).toBe("passed");
    const r1 = await creq.get(statusUrl(c2Row.id));
    expect(r1.status(), await r1.text()).toBe(200);
    expect(r1.headers()["cache-control"] ?? "").toContain("no-store");
    expect(await r1.json()).toEqual({ stored: true });

    // The poll, untouched: the bar asks the status route every 25 s while the
    // tab is visible (its interval started at hydration, before the finish),
    // so it turns ready within one interval plus a round trip, with no tap.
    // bringToFront keeps the page visible (if it was not, the check on return
    // to the tab answers first; either way the bar's own check, not a tap).
    await page.bringToFront();
    await expect(next).toHaveAttribute("data-state", "ready", { timeout: 40_000 });
    await expect(next).toHaveAttribute("href", continueUrl(s.c2!));
    await expect(next).not.toHaveAttribute("aria-disabled", "true");
    // A tap on the ready button: a full navigation to the continue address,
    // then step 3's launch.
    await next.click();
    await page.waitForURL((u) => u.pathname === `/${slug()}/courses/${s.c3}/launch` && u.searchParams.get("lp") === s.pathId, { timeout: 60_000 });

    // A relaunch of step 2 is a revision visit: ready on first render, no poll needed.
    const html = await getOk(s.cCtx!, launchUrl(s.c2!));
    expect(html).toContain('data-testid="continue-next" data-state="ready"');
    expect(html).not.toContain('data-state="waiting"');
    await page.close();

    // Refusals: another learner's attempt and a bad id are 404; a signed-out
    // call is redirected to the login page by the middleware.
    const foreign = await s.aCtx!.request.get(statusUrl(c2Row.id));
    expect(foreign.status(), "another learner's attempt").toBe(404);
    const bad = await creq.get(statusUrl("not-a-uuid"));
    expect(bad.status(), "not a uuid").toBe(404);
    const anon = await browser.newContext({ baseURL });
    try {
      const out = await anon.request.get(statusUrl(c2Row.id), { maxRedirects: 0 });
      expect(out.status(), "signed out: a redirect").toBeGreaterThanOrEqual(300);
      expect(out.status(), "signed out: a redirect").toBeLessThan(400);
      expect(out.headers()["location"] ?? "").toContain("/login");
    } finally {
      await anon.close();
    }

    // The route wrote nothing: the official row is as the statements left it.
    const after = (await attemptsOn(s.c!.id, s.v2!)).find((x) => x.id === c2Row.id)!;
    expect(after).toEqual(stored);
  });

  test("(f) the SCORM runtime: Continue waits on step 3, turns ready after the parent's own passed commit, the end banner and the celebration", async () => {
    const breq = s.bCtx!.request;
    await getOk(s.bCtx!, launchUrl(s.c1!));
    await finish(breq, s.b!, (await attemptsOn(s.b!.id, s.v1!))[0].id, "passed", 0.9);
    await getOk(s.bCtx!, launchUrl(s.c2!));
    await finish(breq, s.b!, (await attemptsOn(s.b!.id, s.v2!))[0].id, "passed", 0.9);
    const page = await launchPage(s.bCtx!, launchUrl(s.c3!));
    const next = page.getByTestId("continue-next");
    await expect(next).toHaveAttribute("data-state", "waiting");
    const [b3] = await attemptsOn(s.b!.id, s.v3!);
    expect(b3.learning_path_id).toBe(s.pathId);
    // The parent's own window.API (installed at hydration; the content never
    // loads here): its LMSFinish commit is answered with a terminal status,
    // and the bar's one status check turns Continue ready.
    // Timing. The commit answers only after it classifies the attempt and
    // awaits its side effects: the XP and journey RPCs (the journey one does
    // nothing here), the CRM webhook lookup, the course email, the
    // path-completion scan and, because step 3 closes the path, the path
    // email. On Cloud Run staging 0.9 s from the commit to the path email
    // (2026-11-11); from a GitHub runner to the staging database 8.2 s in
    // both lifecycle-nightly runs of 2026-11-12, and the commit's answer took
    // 9.8 s in a local run with 270 ms added to every database call. A single
    // 10 s budget timed out with the row already passed. So the commit gets
    // 60 s and Continue 10 s after its answer; and the status checks are
    // recorded: none before the commit's answer and the first within 3 s
    // after it, which a 25 s poll (a SCORM launch must not poll) meets only by
    // chance, however long the commit took.
    const statusAt: number[] = [];
    page.on("request", (q) => {
      if (q.url().includes(statusUrl(b3.id))) statusAt.push(Date.now());
    });
    type ScormApi = { LMSInitialize(p: string): string; LMSSetValue(k: string, v: string): string; LMSFinish(p: string): string };
    await page.waitForFunction(() => !!(window as unknown as { API?: unknown }).API, null, { timeout: 30_000 });
    const [commit] = await Promise.all([
      page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes(`/api/scorm/${b3.id}/commit`), {
        timeout: 60_000,
      }),
      page.evaluate(() => {
        const api = (window as unknown as { API: ScormApi }).API;
        api.LMSInitialize("");
        api.LMSSetValue("cmi.core.lesson_status", "passed");
        api.LMSSetValue("cmi.core.score.raw", "90");
        api.LMSFinish("");
      }),
    ]);
    const answeredAt = Date.now();
    expect(commit.status(), "the LMSFinish commit").toBe(200);
    await expect(next).toHaveAttribute("data-state", "ready", { timeout: 10_000 });
    expect(statusAt.length, "the bar ran a status check").toBeGreaterThan(0);
    expect(statusAt[0], "no status check before the commit answered").toBeGreaterThanOrEqual(answeredAt - 1_000);
    expect(statusAt[0], "the check followed the commit's answer").toBeLessThanOrEqual(answeredAt + 3_000);
    await expect(next).toHaveAttribute("href", continueUrl(s.c3!));
    const [b3After] = await attemptsOn(s.b!.id, s.v3!);
    expect(b3After.success_status).toBe("passed");
    await page.close();
    const r = await noFollow(breq, continueUrl(s.c3!));
    expectPrompt(r);
    expect(redirectedExactly(r, pathUrl("?end=1")), describe(r)).toBe(true);
    const path = await getOk(s.bCtx!, pathUrl("?end=1"));
    expect(path).toContain('data-testid="continue-end-banner"');
    expect(path).toContain("You finished this path");
  });

  test("(g) a revision visit: Continue is ready and moves on at once; Revision Mode and Continue show together", async () => {
    const r = await noFollow(s.aCtx!.request, continueUrl(s.c1!));
    expectPrompt(r);
    expect(redirectedExactly(r, launchUrl(s.c2!)), describe(r)).toBe(true);
    const page = await launchPage(s.aCtx!, launchUrl(s.c1!));
    const html = await page.content();
    expect(html).toContain('data-testid="practice-badge"');
    expect(html).toContain('data-testid="continue-next"');
    const next = page.getByTestId("continue-next");
    await expect(next).toHaveAttribute("data-state", "ready");
    await expect(next).toHaveAttribute("href", continueUrl(s.c1!));
    await page.close();
    const st = await s.aCtx!.request.get(statusUrl(s.a1!));
    expect(st.status(), await st.text()).toBe(200);
    expect(await st.json()).toEqual({ stored: true });
  });

  test("(h) refusals: from not a step, lp not a uuid, another organisation's path", async () => {
    const areq = s.aCtx!.request;
    const notStep = await noFollow(areq, continueUrl(s.c4!));
    expect(redirectedExactly(notStep, pathUrl()), describe(notStep)).toBe(true);
    const html = await getOk(s.aCtx!, pathUrl());
    for (const b of BANNERS) expect(html, b).not.toContain(`data-testid="${b}"`);
    const badLp = await noFollow(areq, `/${slug()}/continue?lp=not-a-uuid&from=${s.c1}`);
    expect(redirectedExactly(badLp, `/${slug()}/dashboard`), describe(badLp)).toBe(true);
    const foreign = await noFollow(areq, continueUrl(s.c1!, s.otherPathId!));
    expect(redirectedExactly(foreign, `/${slug()}/dashboard`), describe(foreign)).toBe(true);
  });

  test("(i) staff: an admin's Continue skips the wait and writes no row", async () => {
    const r = await noFollow(s.previewCtx!.request, continueUrl(s.c1!));
    expectPrompt(r);
    expect(redirectedExactly(r, launchUrl(s.c2!)), describe(r)).toBe(true);
    const { data, error } = await svc().from("course_attempts").select("id").eq("user_id", s.previewer!.id);
    expect(error).toBeNull();
    expect((data ?? []).length, "the continue address wrote no attempt").toBe(0);
  });

  test("(j) widths and the 120-character title: Exit, Revision Mode and Continue visible and apart; a thinner bar below sm", async () => {
    const page = await s.aCtx!.newPage();
    await page.setViewportSize({ width: 320, height: 640 });
    await page.route(/\/content\//, (r) => r.abort());
    const res = await page.goto(launchUrl(s.c1!), { timeout: 120_000 });
    expect(res?.status()).toBe(200);
    const bar = page.getByTestId("launch-bar");
    const exit = bar.getByTitle(/exit course/i);
    const badge = page.getByTestId("practice-badge");
    const next = page.getByTestId("continue-next");
    const title = bar.getByText(LONG_TITLE);
    // The status region is always there and empty unless a waiting button was tapped.
    await expect(page.getByTestId("continue-waiting-message")).toHaveText("");
    // boundingBox() reports sub-pixel layout (a min-h-10 control measured 39.999998569488525 at 1280 on
    // staging 00041-kvm), so every pixel bound below allows half a pixel either way.
    const SUBPX = 0.5;
    for (const width of [320, 390, 1280, 640, 768]) {
      await page.setViewportSize({ width, height: 640 });
      for (const l of [bar, exit, badge, next]) await expect(l, `visible at ${width}`).toBeVisible({ timeout: 60_000 });
      const boxes = await Promise.all([exit, badge, next].map((l) => l.boundingBox()));
      const [e, b, n] = boxes as Box[];
      expect([overlap(e, b), overlap(b, n), overlap(e, n)], `no overlap at ${width}: ${JSON.stringify(boxes)}`).toEqual([false, false, false]);
      for (const box of boxes as Box[]) expect(box.x + box.width, `inside the viewport at ${width}`).toBeLessThanOrEqual(width + SUBPX);
      // The owner's thinner bar (ADR 0019, note of 2026-11-11): about 41 px
      // below sm (36 px controls), about 49 px from sm (40 px controls).
      const barH = ((await bar.boundingBox()) as Box).height;
      if (width < 640) {
        expect(barH, `the bar's height at ${width}`).toBeLessThanOrEqual(42 + SUBPX);
        expect(n.height, `Continue's height at ${width}`).toBeLessThanOrEqual(37 + SUBPX);
      } else {
        expect(barH, `the bar's height at ${width}`).toBeGreaterThanOrEqual(48 - SUBPX);
        expect(n.height, `Continue's height at ${width}`).toBeGreaterThanOrEqual(40 - SUBPX);
      }
      if (width < 640) {
        await expect(title, `title hidden below sm at ${width}`).toBeHidden();
      } else {
        await expect(title, `title shown from sm at ${width}`).toBeVisible();
        const t = (await title.boundingBox()) as Box;
        expect([overlap(t, b), overlap(t, n)], `the title clears the badge and Continue at ${width}`).toEqual([false, false]);
      }
    }
    await page.close();
  });
});
