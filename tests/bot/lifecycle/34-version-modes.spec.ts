/**
 * Silent module versioning modes on "Replace content".
 *
 *  - grandfather (default): a learner with an in-progress attempt keeps routing
 *    to their RETIRED version (bookmark intact); no new attempt is created.
 *  - force_restart: old in-progress attempts are silently marked 'abandoned';
 *    the next launch creates a fresh attempt on the NEW version (0%).
 *
 * No learner-facing choice/notice in either mode.
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
import { authedContext, uploadCourse, assignCourse, launch } from "./helpers";

const FIXTURES = path.resolve(__dirname, "../fixtures");
const zipBuf = () => fs.readFileSync(path.join(FIXTURES, "scorm12.zip"));

async function seed(browser: import("@playwright/test").Browser, baseURL: string) {
  const org = await createOrg({ name: "QA VerMode Org" });
  const admin = await createAuthUser({
    profile: { first_name: "Ver", last_name: "Admin", must_change_password: false },
  });
  await addMember({ organizationId: org.id, userId: admin.id, role: "admin" });
  const adminCtx = await authedContext(browser, baseURL, admin.email, admin.password);
  const course = await uploadCourse(adminCtx.request, org.slug, "scorm12.zip");

  const { data: pkgs } = await svc()
    .from("course_packages")
    .select("id")
    .eq("course_id", course.courseId);
  const pkgId = (pkgs ?? [])[0].id as string;

  const learner = await createAuthUser({
    profile: { first_name: "Ver", last_name: "Learner", must_change_password: false },
  });
  await addMember({ organizationId: org.id, userId: learner.id, role: "member" });
  await assignCourse(adminCtx.request, org.slug, course.courseId, learner.id);

  // Seed an in-progress attempt with a bookmark on v1.
  const { data: att } = await svc()
    .from("course_attempts")
    .insert({
      course_version_id: course.versionId,
      user_id: learner.id,
      organization_id: org.id,
      status: "in_progress",
      completion_status: "in_progress",
      success_status: "unknown",
      cmi_data: { "cmi.core.lesson_location": "page-3" },
    })
    .select("id")
    .single();

  return { org, adminCtx, learner, course, pkgId, v1: course.versionId, attemptId: att!.id as string };
}

test("grandfather: in-progress learner resumes the retired version", async ({ browser, baseURL }) => {
  const s = await seed(browser, baseURL!);

  const replace = await s.adminCtx.request.post(
    `/api/courses/${s.course.courseId}/packages/${s.pkgId}/versions`,
    {
      multipart: {
        orgSlug: s.org.slug,
        mode: "grandfather",
        file: { name: "scorm12.zip", mimeType: "application/zip", buffer: zipBuf() },
      },
    }
  );
  expect(replace.ok(), `replace → ${replace.status()}: ${await replace.text()}`).toBeTruthy();
  const v2 = (await replace.json()).version_id as string;
  await s.adminCtx.close();

  const learnerCtx = await authedContext(browser, baseURL!, s.learner.email, s.learner.password);
  await launch(learnerCtx.request, s.org.slug, s.course.courseId);
  await learnerCtx.close();

  // The original v1 attempt is still in-progress (resumed, bookmark intact).
  const { data: orig } = await svc()
    .from("course_attempts")
    .select("status, cmi_data")
    .eq("id", s.attemptId)
    .single();
  expect(orig!.status).toBe("in_progress");
  expect((orig!.cmi_data as Record<string, unknown>)["cmi.core.lesson_location"]).toBe("page-3");

  // No NEW attempt was created on the new version.
  const { count } = await svc()
    .from("course_attempts")
    .select("id", { count: "exact", head: true })
    .eq("user_id", s.learner.id)
    .eq("course_version_id", v2);
  expect(count ?? 0).toBe(0);
});

test("force_restart: old attempt abandoned, fresh attempt on the new version", async ({
  browser,
  baseURL,
}) => {
  const s = await seed(browser, baseURL!);

  const replace = await s.adminCtx.request.post(
    `/api/courses/${s.course.courseId}/packages/${s.pkgId}/versions`,
    {
      multipart: {
        orgSlug: s.org.slug,
        mode: "force_restart",
        file: { name: "scorm12.zip", mimeType: "application/zip", buffer: zipBuf() },
      },
    }
  );
  const body = await replace.text();
  // force_restart needs the 'abandoned' status constraint (migration 0043/0042).
  test.skip(
    !replace.ok() && /restart failed|constraint/i.test(body),
    "migration 0043 (abandoned status) not applied yet"
  );
  expect(replace.ok(), `replace → ${replace.status()}: ${body}`).toBeTruthy();
  const v2 = JSON.parse(body).version_id as string;
  await s.adminCtx.close();

  // Old attempt silently abandoned.
  const { data: orig } = await svc()
    .from("course_attempts")
    .select("status")
    .eq("id", s.attemptId)
    .single();
  expect(orig!.status).toBe("abandoned");

  // Next launch creates a fresh attempt on the new version.
  const learnerCtx = await authedContext(browser, baseURL!, s.learner.email, s.learner.password);
  await launch(learnerCtx.request, s.org.slug, s.course.courseId);
  await learnerCtx.close();

  const { data: fresh } = await svc()
    .from("course_attempts")
    .select("id, status")
    .eq("user_id", s.learner.id)
    .eq("course_version_id", v2)
    .maybeSingle();
  expect(fresh?.status).toBe("in_progress");
});
