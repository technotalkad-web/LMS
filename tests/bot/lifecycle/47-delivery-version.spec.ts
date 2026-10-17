/**
 * ALDS step 0 — P1 "serve the attempt's version".
 *
 * Every content URL the launch page renders names the attempt's version
 * (`/content/v/<course_attempts.course_version_id>/…`), so an attempt is served
 * the bytes of the package it was opened on — a retired version it is
 * grandfathered on, or another language — never whatever is current for the
 * course. The versioned route 404s unless the version belongs to the course
 * and the course to the org. The legacy `/content/…` route (kept one release)
 * serves the learner's latest non-abandoned attempt's version, else the
 * course's current version.
 *
 * Each package carries a `version.txt` marker so the served bytes identify the
 * version unambiguously.
 */
import { test, expect, type APIRequestContext, type BrowserContext } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { addMember, createAuthUser, createOrg, svc } from "../../e2e/helpers/supabase";
import { assignCourse, authedContext } from "./helpers";

const FIXTURES = path.resolve(__dirname, "../fixtures");

/**
 * scorm12.zip plus a version.txt marker. `title` retitles the manifest: a
 * second COURSE in the same org must not carry the first course's title, or
 * the content-integrity check (ADR 0004 step 3) blocks it as a wrong-course
 * upload.
 */
async function markedZip(marker: string, title?: string): Promise<Buffer> {
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(FIXTURES, "scorm12.zip")));
  zip.file("version.txt", marker);
  if (title) {
    const manifest = await zip.file("imsmanifest.xml")!.async("string");
    zip.file("imsmanifest.xml", manifest.replace("<title>QA Bot SCORM 1.2 Course</title>", `<title>${title}</title>`));
  }
  return zip.generateAsync({ type: "nodebuffer" });
}

/** The iframe src the launch page rendered (SSR HTML). */
async function launchIframeSrc(req: APIRequestContext, url: string): Promise<string> {
  const res = await req.get(url);
  expect(res.ok(), `launch ${url} → ${res.status()}`).toBeTruthy();
  const html = await res.text();
  const m = /<iframe[^>]+src="([^"]+)"/.exec(html);
  expect(m, `launch page ${url} should render the course iframe`).toBeTruthy();
  return m![1].replace(/&amp;/g, "&");
}

async function text(req: APIRequestContext, url: string): Promise<{ status: number; body: string }> {
  const res = await req.get(url, { maxRedirects: 0 });
  return { status: res.status(), body: res.status() === 200 ? await res.text() : "" };
}

async function attemptsOf(userId: string, versionIds: string[]) {
  const { data } = await svc()
    .from("course_attempts")
    .select("id, course_version_id, status")
    .eq("user_id", userId)
    .in("course_version_id", versionIds)
    .order("started_at", { ascending: true });
  return (data ?? []) as Array<{ id: string; course_version_id: string; status: string }>;
}

test.describe.serial("ALDS P1 — content is served from the attempt's version", () => {
  const s: {
    org?: { id: string; slug: string };
    org2?: { id: string; slug: string };
    adminCtx?: BrowserContext;
    learnerA?: { id: string; email: string; password: string };
    learnerB?: { id: string; email: string; password: string };
    courseId?: string;
    pkgId?: string;
    v1?: string;
    v2?: string;
    hi1?: string;
    otherCourseId?: string;
    foreignCourseId?: string;
    foreignVersionId?: string;
  } = {};

  test.afterAll(async () => {
    await s.adminCtx?.close().catch(() => {});
  });

  test("seed: course v1, learner A in progress on v1, then v2 replaces it (grandfather)", async ({
    browser,
    baseURL,
  }) => {
    const org = await createOrg({ name: "QA ALDS Delivery" });
    const admin = await createAuthUser({
      profile: { first_name: "Deliv", last_name: "Admin", must_change_password: false },
    });
    await addMember({ organizationId: org.id, userId: admin.id, role: "admin" });
    s.org = org;
    s.adminCtx = await authedContext(browser, baseURL!, admin.email, admin.password);
    const areq = s.adminCtx.request;

    const up = await areq.post("/api/courses/upload", {
      multipart: {
        orgSlug: org.slug,
        file: { name: "alds47-v1.zip", mimeType: "application/zip", buffer: await markedZip("ALDS47-EN-V1") },
      },
    });
    expect(up.ok(), `upload v1 → ${up.status()}: ${await up.text()}`).toBeTruthy();
    s.courseId = (await up.json()).courseId as string;
    const { data: course } = await svc().from("courses").select("current_version_id").eq("id", s.courseId).single();
    s.v1 = (course as { current_version_id: string }).current_version_id;
    const { data: pkgs } = await svc().from("course_packages").select("id").eq("course_id", s.courseId);
    s.pkgId = (pkgs ?? [])[0].id as string;

    for (const k of ["learnerA", "learnerB"] as const) {
      const u = await createAuthUser({
        profile: { first_name: "Deliv", last_name: k, must_change_password: false },
      });
      await addMember({ organizationId: org.id, userId: u.id, role: "member" });
      await assignCourse(areq, org.slug, s.courseId, u.id);
      s[k] = u;
    }

    // Learner A opens v1 → in-progress attempt on v1, iframe on /content/v/<v1>/.
    const a = await authedContext(browser, baseURL!, s.learnerA!.email, s.learnerA!.password);
    const src = await launchIframeSrc(a.request, `/${org.slug}/courses/${s.courseId}/launch`);
    expect(src).toBe(`/${org.slug}/courses/${s.courseId}/content/v/${s.v1}/index.html`);
    await a.close();
    const att = await attemptsOf(s.learnerA!.id, [s.v1!]);
    expect(att.map((x) => x.status)).toEqual(["in_progress"]);

    // Admin replaces the package (grandfather) → v2 is current.
    const rep = await areq.post(`/api/courses/${s.courseId}/packages/${s.pkgId}/versions`, {
      multipart: {
        orgSlug: org.slug,
        mode: "grandfather",
        file: { name: "alds47-v2.zip", mimeType: "application/zip", buffer: await markedZip("ALDS47-EN-V2") },
      },
    });
    expect(rep.ok(), `replace → ${rep.status()}: ${await rep.text()}`).toBeTruthy();
    s.v2 = (await rep.json()).version_id as string;
    const { data: c2 } = await svc().from("courses").select("current_version_id").eq("id", s.courseId).single();
    expect((c2 as { current_version_id: string }).current_version_id).toBe(s.v2);
  });

  test("versioned route serves each version's own bytes", async ({ browser, baseURL }) => {
    const a = await authedContext(browser, baseURL!, s.learnerA!.email, s.learnerA!.password);
    const base = `/${s.org!.slug}/courses/${s.courseId}/content/v`;
    expect(await text(a.request, `${base}/${s.v1}/version.txt`)).toEqual({ status: 200, body: "ALDS47-EN-V1" });
    expect(await text(a.request, `${base}/${s.v2}/version.txt`)).toEqual({ status: 200, body: "ALDS47-EN-V2" });

    // Range still works on the versioned route (206 + Content-Range).
    const part = await a.request.get(`${base}/${s.v2}/version.txt`, { headers: { Range: "bytes=0-5" } });
    expect(part.status()).toBe(206);
    expect(await part.text()).toBe("ALDS47");
    expect(part.headers()["content-range"]).toBe("bytes 0-5/12");
    // Traversal is refused.
    expect((await a.request.get(`${base}/${s.v1}/..%2F..%2Fother/index.html`)).status()).toBe(403);
    await a.close();
  });

  test("grandfathered relaunch: learner A's iframe stays on v1 and gets v1 bytes", async ({ browser, baseURL }) => {
    const a = await authedContext(browser, baseURL!, s.learnerA!.email, s.learnerA!.password);
    const src = await launchIframeSrc(a.request, `/${s.org!.slug}/courses/${s.courseId}/launch`);
    expect(src).toBe(`/${s.org!.slug}/courses/${s.courseId}/content/v/${s.v1}/index.html`);
    // Relative package requests resolve under the same versioned prefix.
    const marker = src.replace(/index\.html$/, "version.txt");
    expect(await text(a.request, marker)).toEqual({ status: 200, body: "ALDS47-EN-V1" });
    const att = await attemptsOf(s.learnerA!.id, [s.v1!, s.v2!]);
    expect(att.map((x) => [x.course_version_id, x.status])).toEqual([[s.v1, "in_progress"]]);
    await a.close();
  });

  test("legacy route: attempt's version for A, current version for B (no attempt)", async ({ browser, baseURL }) => {
    const legacy = `/${s.org!.slug}/courses/${s.courseId}/content/version.txt`;
    const a = await authedContext(browser, baseURL!, s.learnerA!.email, s.learnerA!.password);
    expect(await text(a.request, legacy)).toEqual({ status: 200, body: "ALDS47-EN-V1" });
    await a.close();
    const b = await authedContext(browser, baseURL!, s.learnerB!.email, s.learnerB!.password);
    expect(await text(b.request, legacy)).toEqual({ status: 200, body: "ALDS47-EN-V2" });
    await b.close();
  });

  test("another language: learner B's Hindi attempt is served the Hindi package", async ({ browser, baseURL }) => {
    const areq = s.adminCtx!.request;
    const promote = await areq.patch(`/api/courses/${s.courseId}/packages/${s.pkgId}`, {
      data: { orgSlug: s.org!.slug, language: "en", display_name: "English" },
    });
    expect(promote.ok(), `promote → ${promote.status()}: ${await promote.text()}`).toBeTruthy();
    const addHi = await areq.post(`/api/courses/${s.courseId}/packages`, {
      multipart: {
        orgSlug: s.org!.slug,
        language: "hi",
        display_name: "Hindi",
        file: { name: "alds47-hi.zip", mimeType: "application/zip", buffer: await markedZip("ALDS47-HI-V1") },
      },
    });
    expect(addHi.ok(), `add hi → ${addHi.status()}: ${await addHi.text()}`).toBeTruthy();
    const { data: hiPkg } = await svc()
      .from("course_packages")
      .select("current_version_id")
      .eq("course_id", s.courseId!)
      .eq("language", "hi")
      .single();
    s.hi1 = (hiPkg as { current_version_id: string }).current_version_id;

    const b = await authedContext(browser, baseURL!, s.learnerB!.email, s.learnerB!.password);
    const src = await launchIframeSrc(b.request, `/${s.org!.slug}/courses/${s.courseId}/launch?lang=hi`);
    expect(src).toBe(`/${s.org!.slug}/courses/${s.courseId}/content/v/${s.hi1}/index.html`);
    expect(await text(b.request, src.replace(/index\.html$/, "version.txt"))).toEqual({
      status: 200,
      body: "ALDS47-HI-V1",
    });
    const att = await attemptsOf(s.learnerB!.id, [s.v1!, s.v2!, s.hi1!]);
    expect(att.map((x) => [x.course_version_id, x.status])).toEqual([[s.hi1, "in_progress"]]);

    // The admin now publishes a new ENGLISH version: the course's current
    // version is English again, while B's attempt is Hindi.
    const rep = await areq.post(`/api/courses/${s.courseId}/packages/${s.pkgId}/versions`, {
      multipart: {
        orgSlug: s.org!.slug,
        mode: "grandfather",
        file: { name: "alds47-v3.zip", mimeType: "application/zip", buffer: await markedZip("ALDS47-EN-V3") },
      },
    });
    expect(rep.ok(), `replace en → ${rep.status()}: ${await rep.text()}`).toBeTruthy();
    const v3 = (await rep.json()).version_id as string;
    const { data: c } = await svc().from("courses").select("current_version_id").eq("id", s.courseId).single();
    expect((c as { current_version_id: string }).current_version_id).toBe(v3);

    // B's relaunch still runs the Hindi package and gets Hindi bytes; the
    // legacy route follows B's Hindi attempt, not the (English) current
    // version — before P1 it served EN-V3 to the Hindi attempt.
    const src2 = await launchIframeSrc(b.request, `/${s.org!.slug}/courses/${s.courseId}/launch?lang=hi`);
    expect(src2).toBe(src);
    expect(await text(b.request, src2.replace(/index\.html$/, "version.txt"))).toEqual({
      status: 200,
      body: "ALDS47-HI-V1",
    });
    expect(await text(b.request, `/${s.org!.slug}/courses/${s.courseId}/content/version.txt`)).toEqual({
      status: 200,
      body: "ALDS47-HI-V1",
    });
    await b.close();
  });

  test("ownership: unknown version, another course's version, another org's course → 404", async ({
    browser,
    baseURL,
  }) => {
    const areq = s.adminCtx!.request;
    // Another course in the SAME org.
    const up2 = await areq.post("/api/courses/upload", {
      multipart: {
        orgSlug: s.org!.slug,
        file: { name: "alds47-other.zip", mimeType: "application/zip", buffer: await markedZip("ALDS47-OTHER", "QA ALDS47 Other Course") },
      },
    });
    expect(up2.ok(), `upload other → ${up2.status()}`).toBeTruthy();
    s.otherCourseId = (await up2.json()).courseId as string;

    // A course in ANOTHER org.
    const org2 = await createOrg({ name: "QA ALDS Delivery Other" });
    const admin2 = await createAuthUser({
      profile: { first_name: "Deliv", last_name: "Admin2", must_change_password: false },
    });
    await addMember({ organizationId: org2.id, userId: admin2.id, role: "admin" });
    s.org2 = org2;
    const a2 = await authedContext(browser, baseURL!, admin2.email, admin2.password);
    const up3 = await a2.request.post("/api/courses/upload", {
      multipart: {
        orgSlug: org2.slug,
        file: { name: "alds47-foreign.zip", mimeType: "application/zip", buffer: await markedZip("ALDS47-FOREIGN") },
      },
    });
    expect(up3.ok(), `upload foreign → ${up3.status()}`).toBeTruthy();
    s.foreignCourseId = (await up3.json()).courseId as string;
    const { data: fc } = await svc().from("courses").select("current_version_id").eq("id", s.foreignCourseId).single();
    s.foreignVersionId = (fc as { current_version_id: string }).current_version_id;
    // Sanity: its owner can read it.
    expect(
      await text(a2.request, `/${org2.slug}/courses/${s.foreignCourseId}/content/v/${s.foreignVersionId}/version.txt`)
    ).toEqual({ status: 200, body: "ALDS47-FOREIGN" });
    await a2.close();

    const a = await authedContext(browser, baseURL!, s.learnerA!.email, s.learnerA!.password);
    const o = s.org!.slug;
    // Unknown version id.
    expect((await text(a.request, `/${o}/courses/${s.courseId}/content/v/00000000-0000-4000-8000-000000000000/version.txt`)).status).toBe(404);
    // v1 belongs to courseId, not to the other course.
    expect((await text(a.request, `/${o}/courses/${s.otherCourseId}/content/v/${s.v1}/version.txt`)).status).toBe(404);
    // Another org's course/version through this org's URL space.
    expect((await text(a.request, `/${o}/courses/${s.foreignCourseId}/content/v/${s.foreignVersionId}/version.txt`)).status).toBe(404);
    // Another org's URL space: not a member → bounced, never served.
    const foreign = await a.request.get(
      `/${s.org2!.slug}/courses/${s.foreignCourseId}/content/v/${s.foreignVersionId}/version.txt`,
      { maxRedirects: 0 }
    );
    expect(foreign.status(), "non-member must not get the bytes").not.toBe(200);
    // A non-UUID segment after /v/ is treated as a legacy package folder
    // ("v/<folder>/…"): a clean 404 here, never a 500.
    expect((await text(a.request, `/${o}/courses/${s.courseId}/content/v/not-a-version/version.txt`)).status).toBe(404);
    await a.close();
  });
});
