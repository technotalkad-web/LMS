/**
 * Admin replace/update of a language package's module content.
 *
 * Uploads a course (default package), adds a Hindi package, then replaces the
 * default package's content via the new versions endpoint. Asserts:
 *   - a new version (v2) is created under the default package and becomes current
 *   - the Hindi package is untouched
 *   - storage prefixes are package-scoped (so languages never clobber each other)
 */
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { addMember, createAuthUser, createOrg, svc } from "../../e2e/helpers/supabase";
import { authedContext, uploadCourse } from "./helpers";

const FIXTURES = path.resolve(__dirname, "../fixtures");
const zipBuf = () => fs.readFileSync(path.join(FIXTURES, "scorm12.zip"));

test("admin replaces a package's content → new current version, prefixes package-scoped", async ({
  browser,
  baseURL,
}) => {
  const org = await createOrg({ name: "QA Replace Org" });
  const admin = await createAuthUser({
    profile: { first_name: "Rep", last_name: "Admin", must_change_password: false },
  });
  await addMember({ organizationId: org.id, userId: admin.id, role: "admin" });

  const ctx = await authedContext(browser, baseURL!, admin.email, admin.password);
  const course = await uploadCourse(ctx.request, org.slug, "scorm12.zip");

  // Default package (created by the initial upload).
  const { data: pkgs0 } = await svc()
    .from("course_packages")
    .select("id, current_version_id")
    .eq("course_id", course.courseId);
  const def = (pkgs0 ?? [])[0] as { id: string; current_version_id: string };

  // Add a Hindi package.
  const addHi = await ctx.request.post(`/api/courses/${course.courseId}/packages`, {
    multipart: {
      orgSlug: org.slug,
      language: "hi",
      display_name: "Hindi",
      file: { name: "scorm12.zip", mimeType: "application/zip", buffer: zipBuf() },
    },
  });
  expect(addHi.ok(), `add hi → ${addHi.status()}: ${await addHi.text()}`).toBeTruthy();
  const hiPkgId = (await addHi.json()).package_id as string;

  const { data: hiBefore } = await svc()
    .from("course_packages")
    .select("current_version_id")
    .eq("id", hiPkgId)
    .single();

  // Replace the DEFAULT package's content.
  const replace = await ctx.request.post(
    `/api/courses/${course.courseId}/packages/${def.id}/versions`,
    {
      multipart: {
        orgSlug: org.slug,
        file: { name: "scorm12.zip", mimeType: "application/zip", buffer: zipBuf() },
      },
    }
  );
  expect(replace.ok(), `replace → ${replace.status()}: ${await replace.text()}`).toBeTruthy();
  const rep = await replace.json();
  expect(rep.version_number).toBe(2); // default was v1 → new v2

  await ctx.close();

  // Default package now points at the new v2.
  const { data: defAfter } = await svc()
    .from("course_packages")
    .select("current_version_id")
    .eq("id", def.id)
    .single();
  expect(defAfter!.current_version_id).toBe(rep.version_id);
  expect(defAfter!.current_version_id).not.toBe(def.current_version_id);

  // Hindi package untouched.
  const { data: hiAfter } = await svc()
    .from("course_packages")
    .select("current_version_id")
    .eq("id", hiPkgId)
    .single();
  expect(hiAfter!.current_version_id).toBe(hiBefore!.current_version_id);

  // Storage prefixes are package-scoped → default v2 and Hindi v1 never collide.
  const { data: defVer } = await svc()
    .from("course_versions")
    .select("storage_prefix")
    .eq("id", rep.version_id)
    .single();
  const { data: hiVer } = await svc()
    .from("course_versions")
    .select("storage_prefix")
    .eq("id", hiAfter!.current_version_id)
    .single();
  expect(defVer!.storage_prefix).toContain(def.id);
  expect(hiVer!.storage_prefix).toContain(hiPkgId);
  expect(defVer!.storage_prefix).not.toBe(hiVer!.storage_prefix);
});
