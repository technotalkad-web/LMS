/**
 * ADR 0004 step 17 — launch-time handling of in-progress attempts on another
 * language slot (step 9), one case per rule:
 *
 *   (0) own-slot resume wins
 *   (1) explicit ?lang= with progress on another active slot → the course
 *       page's language-switch confirm, nothing abandoned
 *   (2) saved preference with progress on another active slot → that
 *       attempt's version is launched (grandfather across slots)
 *   (3) progress on a DEACTIVATED slot → abandoned, tokens expired, the
 *       "Reset — module updated" pill shows, the launch continues
 *   (4) a consumed grant retake is never abandoned or rerouted
 *
 * The per-version restart action (ADR 0004 step 14a) is not built: decision
 * 0004/6 is open.
 */
import { test, expect, type APIRequestContext, type BrowserContext } from "@playwright/test";
import { addMember, createAuthUser, createOrg, svc } from "../../e2e/helpers/supabase";
import { assignCourse, authedContext } from "./helpers";
import { attemptStatuses, cmi5Zip, getNoFollow, inProgressAttempt, scormZip, uploadNew, zipFile } from "./p0-helpers";

type User = { id: string; email: string; password: string };
type Bilingual = { courseId: string; enPkg: string; enVersion: string; hiPkg: string; hiVersion: string };

async function bilingual(req: APIRequestContext, orgSlug: string, name: string, buffer: Buffer): Promise<Bilingual> {
  const up = await uploadNew(req, orgSlug, name, buffer);
  expect(up.ok(), `upload ${name} → ${up.status()}: ${await up.text()}`).toBeTruthy();
  const courseId = (await up.json()).courseId as string;
  const { data: p0 } = await svc().from("course_packages").select("id, current_version_id").eq("course_id", courseId).single();
  const enPkg = (p0 as { id: string }).id;
  const promote = await req.patch(`/api/courses/${courseId}/packages/${enPkg}`, { data: { orgSlug, language: "en", display_name: "English" } });
  expect(promote.ok(), `promote → ${promote.status()}: ${await promote.text()}`).toBeTruthy();
  const addHi = await req.post(`/api/courses/${courseId}/packages`, {
    multipart: { orgSlug, language: "hi", display_name: "Hindi", file: zipFile(name, buffer) },
  });
  expect(addHi.ok(), `add hi → ${addHi.status()}: ${await addHi.text()}`).toBeTruthy();
  const { data: hi } = await svc().from("course_packages").select("id, current_version_id").eq("course_id", courseId).eq("language", "hi").single();
  return {
    courseId,
    enPkg,
    enVersion: (p0 as { current_version_id: string }).current_version_id,
    hiPkg: (hi as { id: string }).id,
    hiVersion: (hi as { current_version_id: string }).current_version_id,
  };
}

async function iframeSrc(req: APIRequestContext, url: string): Promise<string> {
  const res = await req.get(url);
  expect(res.ok(), `launch ${url} → ${res.status()}`).toBeTruthy();
  const m = /<iframe[^>]+src="([^"]+)"/.exec(await res.text());
  expect(m, `launch page ${url} should render the course iframe`).toBeTruthy();
  return m![1].replace(/&amp;/g, "&");
}

async function tokensExpired(attemptId: string): Promise<boolean[]> {
  const { data } = await svc().from("cmi5_launch_tokens").select("expires_at").eq("attempt_id", attemptId);
  const now = Date.now() + 5 * 60_000; // app ↔ runner clock skew allowance
  return ((data ?? []) as Array<{ expires_at: string }>).map((t) => new Date(t.expires_at).getTime() <= now);
}

test.describe.serial("ADR 0004 step 9 — launch routing across language slots", () => {
  const s: {
    org?: { id: string; slug: string };
    adminCtx?: BrowserContext;
    cmi5?: Bilingual;
    scorm?: Bilingual;
    learners: Record<string, User>;
  } = { learners: {} };

  test.afterAll(async () => {
    await s.adminCtx?.close().catch(() => {});
  });

  const learnerCtx = (browser: import("@playwright/test").Browser, baseURL: string, key: string) =>
    authedContext(browser, baseURL, s.learners[key].email, s.learners[key].password);

  test("seed: bilingual cmi5 and SCORM courses, five learners", async ({ browser, baseURL }) => {
    const org = await createOrg({ name: "QA Launch Routing" });
    const admin = await createAuthUser({ profile: { first_name: "Route", last_name: "Admin", must_change_password: false } });
    await addMember({ organizationId: org.id, userId: admin.id, role: "admin" });
    s.org = org;
    s.adminCtx = await authedContext(browser, baseURL!, admin.email, admin.password);
    const areq = s.adminCtx.request;
    s.cmi5 = await bilingual(areq, org.slug, "routing-cmi5.zip", await cmi5Zip({ courseId: "https://qa.bot/cmi5/routing", title: "QA Routing cmi5" }));
    s.scorm = await bilingual(areq, org.slug, "routing-scorm.zip", await scormZip({ title: "QA Routing SCORM" }));
    for (const key of ["own", "pref", "deact", "retake"]) {
      const u = await createAuthUser({ profile: { first_name: "Route", last_name: key, must_change_password: false } });
      await addMember({ organizationId: org.id, userId: u.id, role: "member" });
      await assignCourse(areq, org.slug, s.cmi5.courseId, u.id);
      await assignCourse(areq, org.slug, s.scorm.courseId, u.id);
      s.learners[key] = u;
    }
  });

  test("(0) own-slot resume: a second ?lang=en launch resumes the same English attempt", async ({ browser, baseURL }) => {
    const ctx = await learnerCtx(browser, baseURL!, "own");
    const base = `/${s.org!.slug}/courses/${s.cmi5!.courseId}`;
    const src1 = await iframeSrc(ctx.request, `${base}/launch?lang=en`);
    expect(src1).toContain(`/content/v/${s.cmi5!.enVersion}/`);
    const first = await inProgressAttempt(s.learners.own.id, s.cmi5!.enVersion);
    const src2 = await iframeSrc(ctx.request, `${base}/launch?lang=en`);
    expect(src2).toContain(`/content/v/${s.cmi5!.enVersion}/`);
    expect(await attemptStatuses(s.learners.own.id, s.cmi5!.enVersion)).toEqual(["in_progress"]);
    expect(await inProgressAttempt(s.learners.own.id, s.cmi5!.enVersion)).toBe(first);
    await ctx.close();
  });

  test("(1) ?lang=hi while English is in progress → the switch confirm on the course page, nothing abandoned", async ({ browser, baseURL }) => {
    const ctx = await learnerCtx(browser, baseURL!, "own");
    const base = `/${s.org!.slug}/courses/${s.cmi5!.courseId}`;
    const r = await getNoFollow(ctx.request, `${base}/launch?lang=hi`);
    expect(r.redirectedTo(`/courses/${s.cmi5!.courseId}?switch=hi`), `redirect to the confirm (status ${r.status})`).toBe(true);
    expect(r.body).not.toContain(`/content/v/${s.cmi5!.hiVersion}/`);
    expect(await attemptStatuses(s.learners.own.id, s.cmi5!.enVersion)).toEqual(["in_progress"]);
    expect(await attemptStatuses(s.learners.own.id, s.cmi5!.hiVersion)).toEqual([]);

    // The course page opens the existing confirmation for Hindi; Cancel changes nothing.
    const page = await ctx.newPage();
    await page.goto(`${base}?switch=hi`);
    await expect(page.getByRole("heading", { name: "Change Course Language?" })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.close();
    expect(await attemptStatuses(s.learners.own.id, s.cmi5!.enVersion)).toEqual(["in_progress"]);
    await ctx.close();
  });

  test("(2) saved preference Hindi, English in progress → the English attempt's version launches", async ({ browser, baseURL }) => {
    const ctx = await learnerCtx(browser, baseURL!, "pref");
    const base = `/${s.org!.slug}/courses/${s.cmi5!.courseId}`;
    const pref = await ctx.request.put(`/api/courses/${s.cmi5!.courseId}/language-preference`, { data: { orgSlug: s.org!.slug, language: "hi" } });
    expect(pref.status(), await pref.text()).toBe(200);
    // An explicit English launch with nothing open elsewhere starts English.
    expect(await iframeSrc(ctx.request, `${base}/launch?lang=en`)).toContain(`/content/v/${s.cmi5!.enVersion}/`);
    const en = await inProgressAttempt(s.learners.pref.id, s.cmi5!.enVersion);
    // The preference says Hindi, but the open English attempt is continued.
    expect(await iframeSrc(ctx.request, `${base}/launch`)).toContain(`/content/v/${s.cmi5!.enVersion}/`);
    expect(await inProgressAttempt(s.learners.pref.id, s.cmi5!.enVersion)).toBe(en);
    expect(await attemptStatuses(s.learners.pref.id, s.cmi5!.hiVersion)).toEqual([]);
    await ctx.close();
  });

  test("(3) Hindi deactivated while in progress → that attempt is abandoned at the next launch, tokens expired, pill shown", async ({ browser, baseURL }) => {
    const ctx = await learnerCtx(browser, baseURL!, "deact");
    const base = `/${s.org!.slug}/courses/${s.cmi5!.courseId}`;
    expect(await iframeSrc(ctx.request, `${base}/launch?lang=hi`)).toContain(`/content/v/${s.cmi5!.hiVersion}/`);
    const hiAttempt = await inProgressAttempt(s.learners.deact.id, s.cmi5!.hiVersion);
    expect(await tokensExpired(hiAttempt)).toContain(false);

    const off = await s.adminCtx!.request.patch(`/api/courses/${s.cmi5!.courseId}/packages/${s.cmi5!.hiPkg}`, {
      data: { orgSlug: s.org!.slug, is_active: false },
    });
    expect(off.ok(), `deactivate hi → ${off.status()}: ${await off.text()}`).toBeTruthy();

    // English is now the only active slot: the launch closes the Hindi attempt and starts English.
    expect(await iframeSrc(ctx.request, `${base}/launch`)).toContain(`/content/v/${s.cmi5!.enVersion}/`);
    expect(await attemptStatuses(s.learners.deact.id, s.cmi5!.hiVersion)).toEqual(["abandoned"]);
    expect((await tokensExpired(hiAttempt)).every(Boolean), "every launch token of the closed attempt is expired").toBe(true);
    expect(await attemptStatuses(s.learners.deact.id, s.cmi5!.enVersion)).toEqual(["in_progress"]);
    // Other learners' attempts on active slots are untouched.
    expect(await attemptStatuses(s.learners.own.id, s.cmi5!.enVersion)).toEqual(["in_progress"]);
    expect(await attemptStatuses(s.learners.pref.id, s.cmi5!.enVersion)).toEqual(["in_progress"]);

    const page = await ctx.newPage();
    await page.goto(base);
    await expect(page.getByText("Reset — module updated")).toBeVisible({ timeout: 15_000 });
    await page.close();
    await ctx.close();
  });

  test("(4) a consumed grant retake on a slot that is then deactivated is never abandoned", async ({ browser, baseURL }) => {
    const u = s.learners.retake;
    const ctx = await learnerCtx(browser, baseURL!, "retake");
    const base = `/${s.org!.slug}/courses/${s.scorm!.courseId}`;
    const pref = await ctx.request.put(`/api/courses/${s.scorm!.courseId}/language-preference`, { data: { orgSlug: s.org!.slug, language: "hi" } });
    expect(pref.status(), await pref.text()).toBe(200);
    expect(await iframeSrc(ctx.request, `${base}/launch`)).toContain(`/content/v/${s.scorm!.hiVersion}/`);
    const first = await inProgressAttempt(u.id, s.scorm!.hiVersion);
    const failed = await ctx.request.post(`/api/scorm/${first}/commit`, {
      data: { cmi: { "cmi.core.lesson_status": "failed", "cmi.core.score.raw": "40" }, finished: true },
    });
    expect(failed.status(), await failed.text()).toBe(200);
    const grant = await s.adminCtx!.request.post(`/api/attempt-requests/bulk?orgSlug=${s.org!.slug}`, { data: { courseId: s.scorm!.courseId } });
    expect(grant.status(), await grant.text()).toBe(200);
    expect((await grant.json()).granted).toBe(1);
    // The next launch consumes the grant → a fresh official retake on Hindi.
    expect(await iframeSrc(ctx.request, `${base}/launch`)).toContain(`/content/v/${s.scorm!.hiVersion}/`);
    const { data: used } = await svc()
      .from("attempt_requests")
      .select("used_attempt_id")
      .eq("user_id", u.id)
      .eq("course_id", s.scorm!.courseId)
      .eq("status", "approved")
      .single();
    const retakeId = (used as { used_attempt_id: string | null }).used_attempt_id!;
    expect(retakeId).toBeTruthy();

    const off = await s.adminCtx!.request.patch(`/api/courses/${s.scorm!.courseId}/packages/${s.scorm!.hiPkg}`, {
      data: { orgSlug: s.org!.slug, is_active: false },
    });
    expect(off.ok(), `deactivate hi → ${off.status()}: ${await off.text()}`).toBeTruthy();
    const r = await ctx.request.get(`${base}/launch`);
    expect(r.ok(), `launch → ${r.status()}`).toBeTruthy();
    const { data: after } = await svc().from("course_attempts").select("status").eq("id", retakeId).single();
    expect((after as { status: string }).status, "the grant retake stays in progress").toBe("in_progress");
    await ctx.close();
  });
});
