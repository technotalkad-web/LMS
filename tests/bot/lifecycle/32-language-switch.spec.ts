/**
 * Multi-language — learner language switch confirmation + progress reset.
 *
 * Seeds a course with two language packages (English + Hindi) and an in-progress
 * English attempt, then drives the learner UI:
 *   - the "Change language" menu offers Hindi
 *   - picking it shows the confirmation popup, whose words say what happens
 *     (ADR 0024 P2-9, step 27 (d): only this product's open attempt is reset;
 *     attempts in a path or a journey and completed results are not changed)
 *   - "OK, Switch Language" resets the English attempt (abandoned) and saves the
 *     Hindi preference; "Cancel" makes no change.
 *   - an explicit ?lang= with progress open in the other language goes to the
 *     launch page's own picker (?switch=<lang>), no longer the course page
 *   - ADR 0024 P2-9: a switch inside a path, on the launch's own picker,
 *     closes the path's open attempt only and writes one audit row.
 */
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import {
  addMember,
  createAuthUser,
  createOrg,
  rand,
  svc,
} from "./data";
import { authedContext, uploadCourse, assignCourse, GUARDIAN_ROUTE_TIMEOUT_MS } from "./helpers";
import { fixtureAttemptContext } from "./p0-helpers";

const FIXTURES = path.resolve(__dirname, "../fixtures");

test.describe.serial("Multi-language — switch confirmation + reset", () => {
  const s: {
    org?: { id: string; slug: string };
    admin?: { id: string; email: string; password: string };
    learner?: { id: string; email: string; password: string };
    learner2?: { id: string; email: string; password: string };
    courseId?: string;
    enVersionId?: string;
    hiVersionId?: string;
    abandonedEnId?: string;
    retakeId?: string;
  } = {};

  test("seed course with English + Hindi packages and an in-progress EN attempt", async ({
    browser,
    baseURL,
  }) => {
    const org = await createOrg({ name: "QA Lang Org" });
    const admin = await createAuthUser({
      profile: { first_name: "Lang", last_name: "Admin", must_change_password: false },
    });
    await addMember({ organizationId: org.id, userId: admin.id, role: "admin" });
    s.org = org;
    s.admin = admin;

    const adminCtx = await authedContext(browser, baseURL!, admin.email, admin.password);
    const course = await uploadCourse(adminCtx.request, org.slug, "scorm12.zip");
    s.courseId = course.courseId;

    // The first upload creates a single legacy (NULL-language) package. Promote
    // it to English, then add a Hindi package — two pickable languages.
    const { data: pkgs } = await svc()
      .from("course_packages")
      .select("id, language, current_version_id")
      .eq("course_id", course.courseId);
    const legacy = (pkgs ?? [])[0] as { id: string; current_version_id: string };
    s.enVersionId = legacy.current_version_id;

    const promote = await adminCtx.request.patch(
      `/api/courses/${course.courseId}/packages/${legacy.id}`,
      { data: { orgSlug: org.slug, language: "en", display_name: "English" } }
    );
    expect(promote.ok(), `promote → ${promote.status()}: ${await promote.text()}`).toBeTruthy();

    const addHi = await adminCtx.request.post(`/api/courses/${course.courseId}/packages`, {
      multipart: {
        orgSlug: org.slug,
        language: "hi",
        display_name: "Hindi",
        file: {
          name: "scorm12.zip",
          mimeType: "application/zip",
          buffer: fs.readFileSync(path.join(FIXTURES, "scorm12.zip")),
        },
      },
      timeout: GUARDIAN_ROUTE_TIMEOUT_MS,
    });
    expect(addHi.ok(), `add hi → ${addHi.status()}: ${await addHi.text()}`).toBeTruthy();

    // Learner, assigned, with a saved English preference + an in-progress EN attempt.
    const learner = await createAuthUser({
      profile: { first_name: "Lang", last_name: "Learner", must_change_password: false },
    });
    await addMember({ organizationId: org.id, userId: learner.id, role: "member" });
    s.learner = learner;
    await assignCourse(adminCtx.request, org.slug, course.courseId, learner.id);
    await adminCtx.close();

    await svc().from("course_language_preferences").upsert({
      user_id: learner.id,
      course_id: course.courseId,
      language: "en",
    });
    // An Individual attempt that names its context (ADR 0024 step 64).
    const { error: attErr } = await svc().from("course_attempts").insert({
      course_version_id: s.enVersionId,
      user_id: learner.id,
      organization_id: org.id,
      status: "in_progress",
      completion_status: "in_progress",
      success_status: "unknown",
      ...fixtureAttemptContext(),
    });
    expect(attErr, attErr ? JSON.stringify(attErr) : "").toBeNull();
  });

  test("switch to Hindi shows the confirmation popup with what it does", async ({ browser, baseURL }) => {
    const ctx = await authedContext(browser, baseURL!, s.learner!.email, s.learner!.password);
    const page = await ctx.newPage();
    await page.goto(`/${s.org!.slug}/courses/${s.courseId}`);

    // Open the change-language menu and pick Hindi.
    await page.getByRole("button", { name: /English/ }).first().click();
    await page.getByRole("menuitem", { name: /Hindi/ }).first().click();

    // The copy (ADR 0024 P2-9, step 27 (d)): the course page is the
    // Individual course, so only its open attempt is reset.
    await expect(
      page.getByRole("heading", { name: "Change Course Language?" })
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("language-switch-copy")).toHaveText(
      "Your attempt in progress on this course will be reset, and the course starts again from the beginning in Hindi. " +
        "Attempts you have open in a learning path or a journey keep their language and progress, and completed results are not changed."
    );
    await expect(page.getByRole("button", { name: "OK, Switch Language" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();

    await page.close();
    await ctx.close();
  });

  test("Cancel makes no change", async ({ browser, baseURL }) => {
    const ctx = await authedContext(browser, baseURL!, s.learner!.email, s.learner!.password);
    const page = await ctx.newPage();
    await page.goto(`/${s.org!.slug}/courses/${s.courseId}`);
    await page.getByRole("button", { name: /English/ }).first().click();
    await page.getByRole("menuitem", { name: /Hindi/ }).first().click();
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.close();
    await ctx.close();

    const { data: pref } = await svc()
      .from("course_language_preferences")
      .select("language")
      .eq("user_id", s.learner!.id)
      .eq("course_id", s.courseId!)
      .maybeSingle();
    expect(pref?.language).toBe("en");

    const { data: att } = await svc()
      .from("course_attempts")
      .select("status")
      .eq("course_version_id", s.enVersionId!)
      .eq("user_id", s.learner!.id)
      .maybeSingle();
    expect(att?.status).toBe("in_progress");
  });

  test("OK, Switch Language resets EN progress and saves Hindi", async ({ browser, baseURL }) => {
    const ctx = await authedContext(browser, baseURL!, s.learner!.email, s.learner!.password);
    const page = await ctx.newPage();
    await page.goto(`/${s.org!.slug}/courses/${s.courseId}`);
    await page.getByRole("button", { name: /English/ }).first().click();
    await page.getByRole("menuitem", { name: /Hindi/ }).first().click();
    // Wait for the route's response (it saves the preference, THEN abandons)
    // before closing the page, so the request is never cut short.
    const switched = page.waitForResponse(
      (r) => r.url().includes("/language-preference") && r.request().method() === "PUT"
    );
    await page.getByRole("button", { name: "OK, Switch Language" }).click();
    expect((await switched).status()).toBe(200);

    // The preference flipped server-side.
    await expect
      .poll(
        async () => {
          const { data } = await svc()
            .from("course_language_preferences")
            .select("language")
            .eq("user_id", s.learner!.id)
            .eq("course_id", s.courseId!)
            .maybeSingle();
          return data?.language ?? null;
        },
        { timeout: 15_000 }
      )
      .toBe("hi");

    await page.close();
    await ctx.close();

    // EN attempt reset (abandoned), course/history preserved.
    const enAttempt = async () =>
      (
        await svc()
          .from("course_attempts")
          .select("id, status")
          .eq("course_version_id", s.enVersionId!)
          .eq("user_id", s.learner!.id)
          .maybeSingle()
      ).data as { id: string; status: string } | null;
    await expect.poll(async () => (await enAttempt())?.status, { timeout: 15_000 }).toBe("abandoned");
    s.abandonedEnId = (await enAttempt())!.id;
  });

  // ---- ALDS step 0 (P1 + P4): launches never resurrect an abandoned attempt.

  test("saved-preference launch opens Hindi fresh; the abandoned EN attempt stays abandoned", async ({
    browser,
    baseURL,
  }) => {
    const { data: hiPkg } = await svc()
      .from("course_packages")
      .select("current_version_id")
      .eq("course_id", s.courseId!)
      .eq("language", "hi")
      .single();
    s.hiVersionId = (hiPkg as { current_version_id: string }).current_version_id;

    const ctx = await authedContext(browser, baseURL!, s.learner!.email, s.learner!.password);
    const res = await ctx.request.get(`/${s.org!.slug}/courses/${s.courseId}/launch`);
    expect(res.ok(), `launch → ${res.status()}`).toBeTruthy();
    // The iframe is served from the Hindi attempt's own version.
    expect(await res.text()).toContain(`/courses/${s.courseId}/content/v/${s.hiVersionId}/index.html`);
    await ctx.close();

    expect(await statuses(s.learner!.id, s.hiVersionId)).toEqual(["in_progress"]);
    expect(await statuses(s.learner!.id, s.enVersionId!)).toEqual(["abandoned"]);
  });

  test("?lang=en launch opens a NEW English attempt; the abandoned one is never resumed or revived", async ({
    browser,
    baseURL,
  }) => {
    const ctx = await authedContext(browser, baseURL!, s.learner!.email, s.learner!.password);
    // ADR 0004 step 9 (1): with the Hindi attempt in progress, an explicit
    // ?lang=en no longer launches straight away: it goes to the launch
    // page's own picker with the language-switch confirm (ADR 0024 P2-9:
    // ?switch=en, the launch's context kept, ?lang= dropped), and nothing is
    // abandoned.
    const first = await ctx.request.get(`/${s.org!.slug}/courses/${s.courseId}/launch?lang=en`, { maxRedirects: 0 });
    const location = first.headers()["location"] ?? "";
    const body = first.status() === 200 ? await first.text() : "";
    expect(
      location.includes(`/courses/${s.courseId}/launch?switch=en`) || body.includes(`/courses/${s.courseId}/launch?switch=en`),
      `?lang=en with Hindi in progress → the launch's picker with the switch confirm (status ${first.status()}, location "${location}")`
    ).toBeTruthy();
    expect(body).not.toContain(`/content/v/${s.enVersionId}/`);
    expect(await statuses(s.learner!.id, s.hiVersionId!)).toEqual(["in_progress"]);
    // The learner confirms the switch (the dialog's PUT): Hindi resets.
    const confirm = await ctx.request.put(`/api/courses/${s.courseId}/language-preference`, {
      data: { orgSlug: s.org!.slug, language: "en", restart_if_in_progress: true, context: { kind: "individual" } },
    });
    expect(confirm.status(), await confirm.text()).toBe(200);
    expect(await statuses(s.learner!.id, s.hiVersionId!)).toEqual(["abandoned"]);

    const res = await ctx.request.get(`/${s.org!.slug}/courses/${s.courseId}/launch?lang=en`);
    expect(res.ok(), `launch ?lang=en → ${res.status()}`).toBeTruthy();
    expect(await res.text()).toContain(`/courses/${s.courseId}/content/v/${s.enVersionId}/index.html`);

    const { data: rows } = await svc()
      .from("course_attempts")
      .select("id, status")
      .eq("course_version_id", s.enVersionId!)
      .eq("user_id", s.learner!.id)
      .order("started_at", { ascending: true });
    const en = (rows ?? []) as Array<{ id: string; status: string }>;
    expect(en.map((r) => r.status)).toEqual(["abandoned", "in_progress"]);
    expect(en[0].id).toBe(s.abandonedEnId);
    expect(en[1].id).not.toBe(s.abandonedEnId);

    // A stale tab of the abandoned attempt cannot write to it (410).
    const stale = await ctx.request.post(`/api/scorm/${s.abandonedEnId}/commit`, {
      data: { cmi: { "cmi.core.lesson_status": "passed", "cmi.core.score.raw": "100" }, finished: true },
    });
    expect(stale.status()).toBe(410);
    await ctx.close();
    expect(await statuses(s.learner!.id, s.enVersionId!)).toEqual(["abandoned", "in_progress"]);
  });

  test("a consumed grant retake survives a confirmed language switch", async ({ browser, baseURL }) => {
    // Learner 2: English, fails the one official attempt, gets an extra
    // attempt granted, starts it (the grant is consumed) — then switches.
    const learner2 = await createAuthUser({
      profile: { first_name: "Lang", last_name: "Retaker", must_change_password: false },
    });
    await addMember({ organizationId: s.org!.id, userId: learner2.id, role: "member" });
    s.learner2 = learner2;
    const adminCtx = await authedContext(browser, baseURL!, s.admin!.email, s.admin!.password);
    await assignCourse(adminCtx.request, s.org!.slug, s.courseId!, learner2.id);

    const ctx = await authedContext(browser, baseURL!, learner2.email, learner2.password);
    const pref = await ctx.request.put(`/api/courses/${s.courseId}/language-preference`, {
      data: { orgSlug: s.org!.slug, language: "en" },
    });
    expect(pref.status(), await pref.text()).toBe(200);
    expect((await ctx.request.get(`/${s.org!.slug}/courses/${s.courseId}/launch`)).ok()).toBeTruthy();
    const { data: first } = await svc()
      .from("course_attempts")
      .select("id")
      .eq("course_version_id", s.enVersionId!)
      .eq("user_id", learner2.id)
      .single();
    const failed = await ctx.request.post(`/api/scorm/${(first as { id: string }).id}/commit`, {
      data: { cmi: { "cmi.core.lesson_status": "failed", "cmi.core.score.raw": "40" }, finished: true },
    });
    expect(failed.status(), await failed.text()).toBe(200);

    const grant = await adminCtx.request.post(`/api/attempt-requests/bulk?orgSlug=${s.org!.slug}`, {
      data: { courseId: s.courseId },
    });
    expect(grant.status(), await grant.text()).toBe(200);
    expect((await grant.json()).granted).toBe(1);
    await adminCtx.close();

    // Next launch consumes the grant → a fresh OFFICIAL retake attempt.
    expect((await ctx.request.get(`/${s.org!.slug}/courses/${s.courseId}/launch`)).ok()).toBeTruthy();
    const { data: used } = await svc()
      .from("attempt_requests")
      .select("used_attempt_id")
      .eq("user_id", learner2.id)
      .eq("course_id", s.courseId!)
      .eq("status", "approved")
      .single();
    s.retakeId = (used as { used_attempt_id: string | null }).used_attempt_id ?? undefined;
    expect(s.retakeId, "the grant is consumed by the launch").toBeTruthy();
    const { data: r0 } = await svc().from("course_attempts").select("status").eq("id", s.retakeId!).single();
    expect((r0 as { status: string }).status).toBe("in_progress");

    // The confirmation copy no longer promises a reset of the retake.
    const page = await ctx.newPage();
    await page.goto(`/${s.org!.slug}/courses/${s.courseId}`);
    await page.getByRole("button", { name: /English/ }).first().click();
    await page.getByRole("menuitem", { name: /Hindi/ }).first().click();
    await expect(page.getByRole("heading", { name: "Change Course Language?" })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Your extra attempt in progress is kept")).toBeVisible();
    await expect(page.getByText("will reset your current progress")).toHaveCount(0);
    const switched = page.waitForResponse(
      (r) => r.url().includes("/language-preference") && r.request().method() === "PUT"
    );
    await page.getByRole("button", { name: "OK, Switch Language" }).click();
    expect(await (await switched).json()).toMatchObject({ ok: true, abandoned: 0, kept_grant_retakes: 1 });
    await expect
      .poll(
        async () => {
          const { data } = await svc()
            .from("course_language_preferences")
            .select("language")
            .eq("user_id", learner2.id)
            .eq("course_id", s.courseId!)
            .maybeSingle();
          return data?.language ?? null;
        },
        { timeout: 15_000 }
      )
      .toBe("hi");
    await page.close();

    // The retake was NOT abandoned (Decision 9) and the API says so (the
    // explicit PUTs below wait for the route, unlike the UI click above).
    const again = await ctx.request.put(`/api/courses/${s.courseId}/language-preference`, {
      data: { orgSlug: s.org!.slug, language: "en", restart_if_in_progress: true },
    });
    expect(again.status(), await again.text()).toBe(200);
    expect(await again.json()).toMatchObject({ ok: true, abandoned: 0, kept_grant_retakes: 0 });
    const back = await ctx.request.put(`/api/courses/${s.courseId}/language-preference`, {
      data: { orgSlug: s.org!.slug, language: "hi", restart_if_in_progress: true },
    });
    expect(await back.json()).toMatchObject({ ok: true, abandoned: 0, kept_grant_retakes: 1 });
    const { data: r2 } = await svc().from("course_attempts").select("status").eq("id", s.retakeId!).single();
    expect((r2 as { status: string }).status).toBe("in_progress");
    await ctx.close();
  });

  // ---- ADR 0024 P2-9 (step 27, decisions A24 and A37): the switch inside one context.
  // A learner of their own (the readers above assume one row per learner
  // and version): the course on its own and as the only step of a path.

  test("a switch inside a path closes the path's open attempt only, on the launch's own picker, with an audit row", async ({ browser, baseURL }) => {
    const learner3 = await createAuthUser({
      profile: { first_name: "Lang", last_name: "Pathway", must_change_password: false },
    });
    await addMember({ organizationId: s.org!.id, userId: learner3.id, role: "member" });
    const adminCtx = await authedContext(browser, baseURL!, s.admin!.email, s.admin!.password);
    await assignCourse(adminCtx.request, s.org!.slug, s.courseId!, learner3.id);
    await adminCtx.close();
    const { data: path, error: pathErr } = await svc()
      .from("learning_paths")
      .insert({ organization_id: s.org!.id, name: "Lang Path", slug: `qa-lang-${rand(6)}`, sequence_mode: "random", visibility: "private", is_active: true })
      .select("id")
      .single();
    expect(pathErr, pathErr?.message).toBeNull();
    const pathId = (path as { id: string }).id;
    const { error: stepErr } = await svc().from("learning_path_courses").insert({ path_id: pathId, course_id: s.courseId!, step_number: 1 });
    expect(stepErr, stepErr?.message).toBeNull();
    const { error: paErr } = await svc()
      .from("learning_path_assignments")
      .insert({ organization_id: s.org!.id, path_id: pathId, assignee_type: "user", user_id: learner3.id });
    expect(paErr, paErr?.message).toBeNull();

    // English on its own, then English in the path: two open rows, one per context.
    const ctx = await authedContext(browser, baseURL!, learner3.email, learner3.password);
    const base = `/${s.org!.slug}/courses/${s.courseId}`;
    for (const q of ["?lang=en", `?lp=${pathId}&lang=en`]) {
      const res = await ctx.request.get(`${base}/launch${q}`);
      expect(res.ok(), `launch ${q} → ${res.status()}`).toBeTruthy();
      expect(await res.text()).toContain(`/courses/${s.courseId}/content/v/${s.enVersionId}/index.html`);
    }
    const rowsOf = async () =>
      ((await svc()
        .from("course_attempts")
        .select("id, course_version_id, status, context_kind, learning_path_id")
        .eq("user_id", learner3.id)
        .order("started_at", { ascending: true })).data ?? []) as Array<{ id: string; course_version_id: string; status: string; context_kind: string; learning_path_id: string | null }>;
    const two = await rowsOf();
    expect(two.map((r) => [r.context_kind, r.course_version_id, r.status])).toEqual([
      ["individual", s.enVersionId, "in_progress"],
      ["path", s.enVersionId, "in_progress"],
    ]);
    const [own, inPath] = two;

    // Rule (1) inside the path: the launch's own picker, the path kept, ?switch=hi, nothing written.
    const first = await ctx.request.get(`${base}/launch?lp=${pathId}&lang=hi`, { maxRedirects: 0 });
    const where = `${first.headers()["location"] ?? ""} ${first.status() === 200 ? await first.text() : ""}`
      .split(String.fromCharCode(92) + "u0026").join("&")
      .replace(/&amp;/g, "&");
    expect(where, `?lang=hi in the path → the launch's picker in the path (status ${first.status()})`).toContain(`/courses/${s.courseId}/launch?lp=${pathId}&switch=hi`);
    expect((await rowsOf()).map((r) => r.status)).toEqual(["in_progress", "in_progress"]);

    // The confirm on that picker, in the path's words; OK sends the path's context.
    const page = await ctx.newPage();
    // The module is not needed: the picker is the page, and the launch it
    // goes on to is checked by its row only.
    await page.route(/\/content\//, (r) => r.abort());
    await page.goto(`${base}/launch?lp=${pathId}&switch=hi`);
    await expect(page.getByRole("heading", { name: "Change Course Language?" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("language-switch-copy")).toContainText("on this step of the path will be reset");
    const switched = page.waitForResponse((r) => r.url().includes("/language-preference") && r.request().method() === "PUT");
    await page.getByRole("button", { name: "OK, Switch Language" }).click();
    const res = await switched;
    expect(res.request().postDataJSON()).toMatchObject({ language: "hi", restart_if_in_progress: true, context: { kind: "path", path_id: pathId } });
    // The status only: the picker navigates at once, so the body may be gone;
    // the rows and the audit row below carry what it closed.
    const status = res.status();
    expect(status, `the switch: ${status === 200 ? "" : await res.text().catch(() => "")}`).toBe(200);
    await page.waitForURL((u) => u.searchParams.get("lang") === "hi" && !u.searchParams.has("switch"), { timeout: 60_000 });
    await page.close();
    await ctx.close();

    // Only the path's English attempt is closed (the row stays); the course's own is untouched.
    const after = await rowsOf();
    expect(after.find((r) => r.id === inPath.id)?.status, "the path's English attempt is abandoned, not deleted").toBe("abandoned");
    expect(after.find((r) => r.id === own.id)?.status, "the course's own English attempt stays open").toBe("in_progress");
    const { data: pref } = await svc()
      .from("course_language_preferences")
      .select("language")
      .eq("user_id", learner3.id)
      .eq("course_id", s.courseId!)
      .maybeSingle();
    expect(pref?.language).toBe("hi");

    // ADR 0024 decision A37: the audit row names what the switch closed, ids only.
    const { data: audit, error: auditErr } = await svc()
      .from("platform_audit_log")
      .select("actor_user_id, target_type, target_id, metadata")
      .eq("action", "course.language_switched")
      .eq("actor_user_id", learner3.id);
    expect(auditErr, auditErr?.message).toBeNull();
    expect(audit ?? []).toHaveLength(1);
    const row = (audit ?? [])[0] as { target_type: string; target_id: string; metadata: Record<string, unknown> };
    expect([row.target_type, row.target_id]).toEqual(["course", s.courseId]);
    expect(row.metadata).toMatchObject({ context: { kind: "path", pathId }, attemptIds: [inPath.id], fromLanguages: ["en"], toLanguage: "hi" });
    expect(JSON.stringify(row)).not.toContain(learner3.email);
  });
});

async function statuses(userId: string, versionId: string): Promise<string[]> {
  const { data } = await svc()
    .from("course_attempts")
    .select("status")
    .eq("course_version_id", versionId)
    .eq("user_id", userId)
    .order("started_at", { ascending: true });
  return ((data ?? []) as Array<{ status: string }>).map((r) => r.status);
}
