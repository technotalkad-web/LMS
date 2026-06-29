/**
 * Multi-language — learner language switch confirmation + progress reset.
 *
 * Seeds a course with two language packages (English + Hindi) and an in-progress
 * English attempt, then drives the learner UI:
 *   - the "Change language" menu offers Hindi
 *   - picking it shows the exact spec confirmation popup
 *   - "OK, Switch Language" resets the English attempt (abandoned) and saves the
 *     Hindi preference; "Cancel" makes no change.
 */
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import {
  addMember,
  createAuthUser,
  createOrg,
  svc,
} from "../../e2e/helpers/supabase";
import { authedContext, uploadCourse, assignCourse } from "./helpers";

const FIXTURES = path.resolve(__dirname, "../fixtures");

test.describe.serial("Multi-language — switch confirmation + reset", () => {
  const s: {
    org?: { id: string; slug: string };
    learner?: { id: string; email: string; password: string };
    courseId?: string;
    enVersionId?: string;
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
    const { error: attErr } = await svc().from("course_attempts").insert({
      course_version_id: s.enVersionId,
      user_id: learner.id,
      organization_id: org.id,
      status: "in_progress",
      completion_status: "in_progress",
      success_status: "unknown",
    });
    expect(attErr, attErr ? JSON.stringify(attErr) : "").toBeNull();
  });

  test("switch to Hindi shows the exact spec confirmation popup", async ({ browser, baseURL }) => {
    const ctx = await authedContext(browser, baseURL!, s.learner!.email, s.learner!.password);
    const page = await ctx.newPage();
    await page.goto(`/${s.org!.slug}/courses/${s.courseId}`);

    // Open the change-language menu and pick Hindi.
    await page.getByRole("button", { name: /English/ }).first().click();
    await page.getByRole("button", { name: /Hindi/ }).first().click();

    // Exact spec copy.
    await expect(
      page.getByRole("heading", { name: "Change Course Language?" })
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByText(
        "Changing the language will reset your current progress and start the course from the beginning in the new language."
      )
    ).toBeVisible();
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
    await page.getByRole("button", { name: /Hindi/ }).first().click();
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
    await page.getByRole("button", { name: /Hindi/ }).first().click();
    await page.getByRole("button", { name: "OK, Switch Language" }).click();

    // Wait for the preference to flip server-side.
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
    const { data: att } = await svc()
      .from("course_attempts")
      .select("status")
      .eq("course_version_id", s.enVersionId!)
      .eq("user_id", s.learner!.id)
      .maybeSingle();
    expect(att?.status).toBe("abandoned");
  });
});
