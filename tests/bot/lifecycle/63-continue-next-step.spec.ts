/**
 * ADR 0019 on staging: the launch bar's Continue button and the continue
 * address (/{org}/continue?lp=<path>&from=<course>), on a strict three-step
 * Learning Path (steps 1 and 2 cmi5, step 3 SCORM 1.2; step 2 pass_required).
 *
 *   (a)  the bar: a path launch carries continue-next to the continue address
 *        and the launch-bar test id, no practice-badge on a first visit, the
 *        title of a package that is not a KIVO build; a Library launch has no
 *        continue-next;
 *   (b)  Continue before the result: the address waits at least 6 s, shows
 *        "Saving your result", ends on the path page's saving banner, and
 *        changes no row;
 *   (c)  the normal path: a stored pass moves on at once to step 2's launch,
 *        whose new row carries the path;
 *   (d)  step 2 in progress: the saving banner; the strict lock still refuses
 *        step 3 (today's lock, unchanged);
 *   (e)  a failed result on the pass_required step 2: the failed banner, never
 *        step 3's launch, step 2 still current;
 *   (e2) a failed result on step 1 (not pass_required): moves on to step 2;
 *   (f)  the SCORM runtime: Continue on step 3, a passed commit, the end
 *        banner and the celebration;
 *   (g)  a revision visit: Continue moves on at once; the badge and Continue
 *        show together;
 *   (h)  refusals: from not a step, lp not a uuid, another organisation's path;
 *   (i)  staff: an admin's Continue skips the wait and writes no row;
 *   (j)  widths and a 120-character title: Exit, Revision Mode and Continue
 *        visible and never overlapping at 320, 390, 640, 768 and 1280 px.
 *
 * Every redirect is asserted with redirectedExactly(): a 3xx Location ending
 * with the target, or Next's redirect marker naming it in the 200 body once
 * the loading boundary has streamed. Never a bare substring of the body:
 * every learner page carries /{org}/dashboard links.
 *
 * By hand on staging (npm run test:lifecycle), after both staging deployments
 * carry the branch, never while another lifecycle run is in progress. Not in
 * the nightly subset until one green run (ADR 0019 decision 7). Data stays in
 * the lifecycle-* namespace.
 */
import { test, expect, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { addMember, createAuthUser, createOrg, rand, svc } from "./data";
import { assignCourse, authedContext, courseHandle, scormCommit } from "./helpers";
import { authTokenFor, cmi5Zip, scormZip, uploadNew, VERB, XAPI_HEADERS } from "./p0-helpers";

type User = { id: string; email: string; password: string };
const AU = "https://qa.bot/cmi5/au1";
/** Step 1's title, exactly 120 characters (case (j)). */
const LONG_TITLE = `QA Continue Step One ${"with a deliberately long module title ".repeat(4)}`.slice(0, 120);
/** "About 2 s" in the record: asserted as well under the 6 s wait. */
const PROMPT_MS = 4_000;
const WAIT_MS = 6_000;
const BANNERS = ["continue-saving-banner", "continue-failed-banner", "continue-end-banner"];

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
  } = {};
  const slug = () => s.org!.slug;
  const launchUrl = (courseId: string, lp = true) => `/${slug()}/courses/${courseId}/launch${lp ? `?lp=${s.pathId}` : ""}`;
  const continueUrl = (from: string, lp = s.pathId!) => `/${slug()}/continue?lp=${lp}&from=${from}`;
  const pathUrl = (q = "") => `/${slug()}/paths/${s.pathId}${q}`;

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

  test("(a) the bar: Continue to the continue address on a path launch, none on a Library launch", async () => {
    const page = await launchPage(s.aCtx!, launchUrl(s.c1!));
    expect(await page.getByTestId("continue-next").getAttribute("href")).toBe(`/${slug()}/continue?lp=${s.pathId}&from=${s.c1}`);
    const html = await page.content();
    expect(html).toContain('data-testid="launch-bar"');
    expect(html).not.toContain("practice-badge");
    // The synthetic cmi5 package is not a KIVO build: its title shows from sm.
    await expect(page.getByTestId("launch-bar").getByText(LONG_TITLE)).toBeVisible();
    await page.close();
    const rows = await attemptsOn(s.a!.id, s.v1!);
    expect(rows.length, "one attempt on step 1").toBe(1);
    expect(rows[0].learning_path_id, "the launch carries the path").toBe(s.pathId);
    s.a1 = rows[0].id;

    const lib = await getOk(s.aCtx!, launchUrl(s.c4!, false));
    expect(lib).toContain('data-testid="launch-bar"');
    expect(lib).not.toContain('data-testid="continue-next"');
  });

  test("(b) Continue before the result: at least 6 s, Saving your result, the saving banner, nothing changed", async () => {
    const before = (await attemptsOn(s.a!.id, s.v1!))[0];
    const r = await noFollow(s.aCtx!.request, continueUrl(s.c1!));
    expect(r.ms, describe(r)).toBeGreaterThanOrEqual(WAIT_MS);
    expect(r.body, "the loading screen streamed first").toContain("continue-saving");
    expect(redirectedExactly(r, pathUrl("?saving=1")), describe(r)).toBe(true);
    const after = await attemptsOn(s.a!.id, s.v1!);
    expect(after.length).toBe(1);
    const pick = (x: Att) => ({ status: x.status, completion_status: x.completion_status, success_status: x.success_status, score: x.score, completed_at: x.completed_at });
    expect(pick(after[0])).toEqual(pick(before));
    expect((await attemptsOn(s.a!.id, s.v2!)).length, "no attempt on step 2").toBe(0);
    expect(await getOk(s.aCtx!, pathUrl("?saving=1"))).toContain('data-testid="continue-saving-banner"');
  });

  test("(c) a stored pass moves on at once to step 2, whose new row carries the path", async () => {
    await finish(s.aCtx!.request, s.a!, s.a1!, "passed", 0.9);
    const r = await noFollow(s.aCtx!.request, continueUrl(s.c1!));
    expect(r.ms, describe(r)).toBeLessThan(PROMPT_MS);
    expect(redirectedExactly(r, launchUrl(s.c2!)), describe(r)).toBe(true);
    await getOk(s.aCtx!, launchUrl(s.c2!));
    const rows = await attemptsOn(s.a!.id, s.v2!);
    expect(rows.length).toBe(1);
    expect(rows[0].learning_path_id).toBe(s.pathId);
  });

  test("(d) step 2 in progress: the saving banner; the strict lock still refuses step 3", async () => {
    const r = await noFollow(s.aCtx!.request, continueUrl(s.c2!));
    expect(r.ms, describe(r)).toBeGreaterThanOrEqual(WAIT_MS);
    expect(redirectedExactly(r, pathUrl("?saving=1")), describe(r)).toBe(true);
    const lock = await noFollow(s.aCtx!.request, launchUrl(s.c3!));
    expect(redirectedExactly(lock, `/${slug()}/dashboard?locked=${s.c3}`), describe(lock)).toBe(true);
  });

  test("(e) a failed result on the pass_required step 2: the failed banner, never step 3, step 2 still current", async () => {
    const [a2] = await attemptsOn(s.a!.id, s.v2!);
    await finish(s.aCtx!.request, s.a!, a2.id, "failed", 0.4);
    const r = await noFollow(s.aCtx!.request, continueUrl(s.c2!));
    expect(r.ms, describe(r)).toBeLessThan(PROMPT_MS);
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
    expect(r.ms, describe(r)).toBeLessThan(PROMPT_MS);
    expect(redirectedExactly(r, launchUrl(s.c2!)), describe(r)).toBe(true);
    await getOk(s.cCtx!, launchUrl(s.c2!));
    const rows = await attemptsOn(s.c!.id, s.v2!);
    expect(rows.length).toBe(1);
    expect(rows[0].learning_path_id).toBe(s.pathId);
  });

  test("(f) the SCORM runtime: Continue on step 3, a passed commit, the end banner and the celebration", async () => {
    const breq = s.bCtx!.request;
    await getOk(s.bCtx!, launchUrl(s.c1!));
    await finish(breq, s.b!, (await attemptsOn(s.b!.id, s.v1!))[0].id, "passed", 0.9);
    await getOk(s.bCtx!, launchUrl(s.c2!));
    await finish(breq, s.b!, (await attemptsOn(s.b!.id, s.v2!))[0].id, "passed", 0.9);
    const html = await getOk(s.bCtx!, launchUrl(s.c3!));
    expect(html).toContain('data-testid="continue-next"');
    const [b3] = await attemptsOn(s.b!.id, s.v3!);
    expect(b3.learning_path_id).toBe(s.pathId);
    await scormCommit(breq, b3.id, { "cmi.core.lesson_status": "passed", "cmi.core.score.raw": "90" }, true);
    const r = await noFollow(breq, continueUrl(s.c3!));
    expect(r.ms, describe(r)).toBeLessThan(PROMPT_MS);
    expect(redirectedExactly(r, pathUrl("?end=1")), describe(r)).toBe(true);
    const path = await getOk(s.bCtx!, pathUrl("?end=1"));
    expect(path).toContain('data-testid="continue-end-banner"');
    expect(path).toContain("You finished this path");
  });

  test("(g) a revision visit: Continue moves on at once; Revision Mode and Continue show together", async () => {
    const r = await noFollow(s.aCtx!.request, continueUrl(s.c1!));
    expect(r.ms, describe(r)).toBeLessThan(PROMPT_MS);
    expect(redirectedExactly(r, launchUrl(s.c2!)), describe(r)).toBe(true);
    const html = await getOk(s.aCtx!, launchUrl(s.c1!));
    expect(html).toContain('data-testid="practice-badge"');
    expect(html).toContain('data-testid="continue-next"');
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
    expect(r.ms, describe(r)).toBeLessThan(PROMPT_MS);
    expect(redirectedExactly(r, launchUrl(s.c2!)), describe(r)).toBe(true);
    const { data, error } = await svc().from("course_attempts").select("id").eq("user_id", s.previewer!.id);
    expect(error).toBeNull();
    expect((data ?? []).length, "the continue address wrote no attempt").toBe(0);
  });

  test("(j) widths and the 120-character title: Exit, Revision Mode and Continue visible and apart", async () => {
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
    for (const width of [320, 390, 1280, 640, 768]) {
      await page.setViewportSize({ width, height: 640 });
      for (const l of [bar, exit, badge, next]) await expect(l, `visible at ${width}`).toBeVisible({ timeout: 60_000 });
      const boxes = await Promise.all([exit, badge, next].map((l) => l.boundingBox()));
      const [e, b, n] = boxes as Box[];
      expect([overlap(e, b), overlap(b, n), overlap(e, n)], `no overlap at ${width}: ${JSON.stringify(boxes)}`).toEqual([false, false, false]);
      for (const box of boxes as Box[]) expect(box.x + box.width, `inside the viewport at ${width}`).toBeLessThanOrEqual(width);
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
