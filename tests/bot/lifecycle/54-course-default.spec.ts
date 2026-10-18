/**
 * ADR 0008 decision B (steps 9–15), step 17 part B — the explicit course
 * default. `courses.current_version_id` is the current version of the
 * course's DEFAULT SLOT:
 *
 *   - new course → default = v1 (multipart and browser-direct paths);
 *   - add a language → unchanged;
 *   - replace (grandfather) in the default slot → follows (multipart and
 *     direct finalize); Make current on v1 there → follows back;
 *   - replace / Make current in another slot → unchanged;
 *   - Set as default (Library UI) → moves, audit row; again → noop, no row;
 *     on an inactive slot or one without a ready version → 409;
 *   - hiding (or deleting) the default slot while another active slot
 *     exists → 409; hiding the only active slot → allowed, the launch goes
 *     back to the course page, which offers "Not available right now", and
 *     an `updated_since` catalogue delta sees the course;
 *   - catalogue `version_id` = the default slot's current version after each
 *     step; `available` is false while no active slot holds the default;
 *   - the Attention Center lists the hidden default.
 */
import { test, expect, type APIRequestContext, type BrowserContext } from "@playwright/test";
import { addMember, createAuthUser, createOrg, svc } from "./data";
import { assignCourse, authedContext } from "./helpers";
import { directUpload, scormZip, uploadNew, zipFile } from "./p0-helpers";

type User = { id: string; email: string; password: string };
type CatalogCourse = {
  id: string;
  code: string | null;
  version_id: string | null;
  version_code: string | null;
  status: string;
  has_content: boolean;
};

const TITLE_A = "QA Default Course A";
const TITLE_B = "QA Default Course B";
const zipA = (marker: string) => scormZip({ title: TITLE_A, marker });

async function courseDefault(courseId: string): Promise<string | null> {
  const { data } = await svc().from("courses").select("current_version_id").eq("id", courseId).single();
  return (data as { current_version_id: string | null }).current_version_id;
}

async function packageCurrent(packageId: string): Promise<string | null> {
  const { data } = await svc().from("course_packages").select("current_version_id").eq("id", packageId).single();
  return (data as { current_version_id: string | null }).current_version_id;
}

async function defaultAuditRows(courseId: string) {
  const { data, error } = await svc()
    .from("platform_audit_log")
    .select("actor_user_id, target_type, metadata")
    .eq("action", "course.default_slot_set")
    .eq("target_id", courseId);
  expect(error, error?.message).toBeNull();
  return (data ?? []) as Array<{ actor_user_id: string; target_type: string; metadata: Record<string, unknown> }>;
}

test.describe.serial("ADR 0008 B — explicit course default", () => {
  const s: {
    org?: { id: string; slug: string };
    admin?: User;
    adminCtx?: BrowserContext;
    learner?: User;
    apiKey?: string;
    courseA?: string;
    enPkg?: string;
    hiPkg?: string;
    enV1?: string;
    enV2?: string;
    enV3?: string;
    hiV1?: string;
    hiV2?: string;
  } = {};
  const areq = () => s.adminCtx!.request;
  const slug = () => s.org!.slug;

  async function catalogCourse(
    request: APIRequestContext,
    courseId: string,
    includeInactive = true,
    updatedSince?: string
  ): Promise<CatalogCourse | undefined> {
    const since = updatedSince ? `&updated_since=${encodeURIComponent(updatedSince)}` : "";
    const res = await request.get(
      `/api/integrations/catalog?content_type=course${includeInactive ? "&include_inactive=true" : ""}${since}`,
      { headers: { Authorization: `Bearer ${s.apiKey}` } }
    );
    expect(res.status(), await res.text()).toBe(200);
    return ((await res.json()).courses as CatalogCourse[]).find((c) => c.id === courseId);
  }

  /** The course default and the catalogue's version_id both equal `want`. */
  async function expectDefault(request: APIRequestContext, courseId: string, want: string, status: "available" | "unavailable" = "available") {
    expect(await courseDefault(courseId), "courses.current_version_id").toBe(want);
    const item = await catalogCourse(request, courseId);
    expect(item, "the course is in the catalogue").toBeTruthy();
    expect(item!.version_id, "catalogue version_id = the default slot's current version").toBe(want);
    expect(item!.status).toBe(status);
  }

  const patchPkg = (packageId: string, data: Record<string, unknown>) =>
    areq().patch(`/api/courses/${s.courseA}/packages/${packageId}`, { data: { orgSlug: slug(), ...data } });
  const setDefault = (req: APIRequestContext, packageId: string, orgSlug = slug()) =>
    req.post(`/api/courses/${s.courseA}/packages/${packageId}/default`, { data: { orgSlug } });

  test.afterAll(async () => {
    await s.adminCtx?.close().catch(() => {});
  });

  test("seed: admin, super owner (API key), assigned learner", async ({ browser, baseURL }) => {
    const org = await createOrg({ name: "QA Course Default" });
    s.org = org;
    const mk = async (first: string, role: "admin" | "super_owner" | "user") => {
      const u = await createAuthUser({ profile: { first_name: first, last_name: "Default", must_change_password: false } });
      await addMember({ organizationId: org.id, userId: u.id, role });
      return u as User;
    };
    s.admin = await mk("Admin", "admin");
    const owner = await mk("Owner", "super_owner");
    s.learner = await mk("Learner", "user");
    s.adminCtx = await authedContext(browser, baseURL!, s.admin.email, s.admin.password);
    const ownerCtx = await authedContext(browser, baseURL!, owner.email, owner.password);
    const keyRes = await ownerCtx.request.post("/api/org/api-keys", { data: { orgSlug: org.slug, name: "QA default" } });
    expect(keyRes.ok(), `api key → ${keyRes.status()}: ${await keyRes.text()}`).toBeTruthy();
    s.apiKey = (await keyRes.json()).key as string;
    await ownerCtx.close();
  });

  test("new course → its v1 is the default (multipart and browser-direct)", async ({ request }) => {
    const up = await uploadNew(areq(), slug(), "default-a-en1.zip", await zipA("A-EN-V1"));
    expect(up.ok(), `upload → ${up.status()}: ${await up.text()}`).toBeTruthy();
    s.courseA = (await up.json()).courseId as string;
    const { data: p0 } = await svc().from("course_packages").select("id, current_version_id").eq("course_id", s.courseA).single();
    s.enPkg = (p0 as { id: string }).id;
    s.enV1 = (p0 as { current_version_id: string }).current_version_id;
    expect(s.enV1).toBeTruthy();
    const promote = await patchPkg(s.enPkg, { language: "en", display_name: "English" });
    expect(promote.ok(), `promote → ${promote.status()}: ${await promote.text()}`).toBeTruthy();
    await expectDefault(request, s.courseA, s.enV1!);
    await assignCourse(areq(), slug(), s.courseA, s.learner!.id);

    // finalizeDirectUpload, new course.
    const direct = await directUpload(areq(), {
      orgSlug: slug(),
      buffer: await scormZip({ title: TITLE_B, marker: "B-V1" }),
      name: "default-b.zip",
      acknowledge: true,
    });
    expect(direct.finalize?.status, JSON.stringify(direct)).toBe(200);
    const courseB = direct.finalize!.body.courseId as string;
    expect(await courseDefault(courseB)).toBe(direct.versionId);
    expect((await catalogCourse(request, courseB))?.version_id).toBe(direct.versionId);
  });

  test("add a language → the default is unchanged", async ({ request }) => {
    const addHi = await areq().post(`/api/courses/${s.courseA}/packages`, {
      multipart: { orgSlug: slug(), language: "hi", display_name: "Hindi", file: zipFile("default-a-hi1.zip", await zipA("A-HI-V1")) },
    });
    expect(addHi.ok(), `add hi → ${addHi.status()}: ${await addHi.text()}`).toBeTruthy();
    const j = await addHi.json();
    s.hiPkg = j.package_id as string;
    s.hiV1 = j.version_id as string;
    expect(await packageCurrent(s.hiPkg!)).toBe(s.hiV1);
    await expectDefault(request, s.courseA!, s.enV1!);
  });

  test("replace in the default slot → follows (multipart, then direct finalize)", async ({ request }) => {
    const rep = await areq().post(`/api/courses/${s.courseA}/packages/${s.enPkg}/versions`, {
      multipart: { orgSlug: slug(), mode: "grandfather", file: zipFile("default-a-en2.zip", await zipA("A-EN-V2")) },
    });
    expect(rep.ok(), `replace en → ${rep.status()}: ${await rep.text()}`).toBeTruthy();
    s.enV2 = (await rep.json()).version_id as string;
    await expectDefault(request, s.courseA!, s.enV2!);

    const direct = await directUpload(areq(), {
      orgSlug: slug(),
      buffer: await zipA("A-EN-V3"),
      name: "default-a-en3.zip",
      courseId: s.courseA,
      packageId: s.enPkg,
      acknowledge: true,
    });
    expect(direct.finalize?.status, JSON.stringify(direct)).toBe(200);
    s.enV3 = direct.versionId;
    expect(await packageCurrent(s.enPkg!)).toBe(s.enV3);
    await expectDefault(request, s.courseA!, s.enV3!);
  });

  test("Make current on v1 in the default slot → follows back", async ({ request }) => {
    const act = await areq().post(`/api/courses/${s.courseA}/packages/${s.enPkg}/versions/${s.enV1}/activate`, {
      data: { orgSlug: slug() },
    });
    expect(act.status(), await act.text()).toBe(200);
    expect((await act.json()).courseDefaultMoved).toBe(true);
    expect(await packageCurrent(s.enPkg!)).toBe(s.enV1);
    await expectDefault(request, s.courseA!, s.enV1!);
  });

  test("replace and Make current in the other slot → the default is unchanged", async ({ request }) => {
    const direct = await directUpload(areq(), {
      orgSlug: slug(),
      buffer: await zipA("A-HI-V2"),
      name: "default-a-hi2.zip",
      courseId: s.courseA,
      packageId: s.hiPkg,
      acknowledge: true,
    });
    expect(direct.finalize?.status, JSON.stringify(direct)).toBe(200);
    s.hiV2 = direct.versionId;
    expect(await packageCurrent(s.hiPkg!)).toBe(s.hiV2);
    await expectDefault(request, s.courseA!, s.enV1!);

    const act = await areq().post(`/api/courses/${s.courseA}/packages/${s.hiPkg}/versions/${s.hiV1}/activate`, {
      data: { orgSlug: slug() },
    });
    expect(act.status(), await act.text()).toBe(200);
    expect((await act.json()).courseDefaultMoved).toBe(false);
    expect(await packageCurrent(s.hiPkg!)).toBe(s.hiV1);
    await expectDefault(request, s.courseA!, s.enV1!);
  });

  test("Set as default from the Library → moves, audit row; again → noop", async ({ request }) => {
    const page = await s.adminCtx!.newPage();
    await page.goto(`/${slug()}/library/${s.courseA}`, { timeout: 120_000 });
    await expect(page.getByTestId("default-language")).toContainText("Default language: English", { timeout: 60_000 });
    const enRow = page.locator("tr", { hasText: "English · en" });
    const hiRow = page.locator("tr", { hasText: "Hindi · hi" });
    await expect(enRow.getByTestId("default-badge")).toBeVisible();
    await expect(enRow.getByRole("button", { name: "Set as default" })).toHaveCount(0);
    await expect(hiRow.getByTestId("default-badge")).toHaveCount(0);
    await expect(page.locator("li", { hasText: s.enV1! }).getByTestId("course-default-version")).toBeVisible();
    await expect(page.getByTestId("course-default-version")).toHaveCount(1);
    await expect(page.getByTestId("default-warning")).toHaveCount(0);

    await hiRow.getByRole("button", { name: "Set as default" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Set as default" }).click();
    await expect(page.getByTestId("default-language")).toContainText("Default language: Hindi", { timeout: 60_000 });
    await expect(page.locator("tr", { hasText: "Hindi · hi" }).getByTestId("default-badge")).toBeVisible();
    await expect(page.locator("li", { hasText: s.hiV1! }).getByTestId("course-default-version")).toBeVisible();
    await page.close();

    await expectDefault(request, s.courseA!, s.hiV1!);
    const rows = await defaultAuditRows(s.courseA!);
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_user_id).toBe(s.admin!.id);
    expect(rows[0].target_type).toBe("course");
    expect(rows[0].metadata).toEqual({
      packageId: s.hiPkg,
      language: "hi",
      versionId: s.hiV1,
      previousVersionId: s.enV1,
      previousPackageId: s.enPkg,
    });

    const again = await setDefault(areq(), s.hiPkg!);
    expect(again.status(), await again.text()).toBe(200);
    expect(await again.json()).toMatchObject({ ok: true, noop: true, versionId: s.hiV1 });
    expect(await defaultAuditRows(s.courseA!)).toHaveLength(1);
  });

  test("Set as default: another organisation's admin → 404, a learner → 403", async ({ browser, baseURL }) => {
    const other = await createOrg({ name: "QA Course Default Other" });
    const otherAdmin = await createAuthUser({ profile: { first_name: "Other", last_name: "Default", must_change_password: false } });
    await addMember({ organizationId: other.id, userId: otherAdmin.id, role: "admin" });
    const oc = await authedContext(browser, baseURL!, otherAdmin.email, otherAdmin.password);
    expect((await setDefault(oc.request, s.enPkg!, other.slug)).status()).toBe(404);
    await oc.close();
    const lc = await authedContext(browser, baseURL!, s.learner!.email, s.learner!.password);
    expect((await setDefault(lc.request, s.enPkg!)).status()).toBe(403);
    await lc.close();
    expect(await courseDefault(s.courseA!)).toBe(s.hiV1);
    expect(await defaultAuditRows(s.courseA!)).toHaveLength(1);
  });

  test("Set as default on a slot without a ready version or an inactive slot → 409, nothing changed", async ({ request }) => {
    // A language whose only version is still uploading: no current version.
    const ta = await directUpload(areq(), {
      orgSlug: slug(),
      buffer: await zipA("A-TA-V1"),
      name: "default-a-ta1.zip",
      courseId: s.courseA,
      language: "ta",
      acknowledge: true,
      initOnly: true,
    });
    expect(ta.init?.status, JSON.stringify(ta)).toBe(200);
    const { data: taRow } = await svc().from("course_packages").select("id, current_version_id, is_active").eq("course_id", s.courseA!).eq("language", "ta").single();
    const taPkg = (taRow as { id: string }).id;
    expect(taRow).toMatchObject({ current_version_id: null, is_active: true });
    const noReady = await setDefault(areq(), taPkg);
    expect(noReady.status(), await noReady.text()).toBe(409);
    expect((await noReady.json()).error).toBe("no_current_version");
    // Tidy through the app: discard the upload, delete the empty language.
    const abort = await areq().post("/api/courses/upload/abort", { data: { orgSlug: slug(), versionId: ta.versionId } });
    expect(abort.ok(), `abort → ${abort.status()}: ${await abort.text()}`).toBeTruthy();
    const del = await areq().delete(`/api/courses/${s.courseA}/packages/${taPkg}?orgSlug=${slug()}`);
    expect(del.ok(), `delete ta → ${del.status()}: ${await del.text()}`).toBeTruthy();

    // English does not hold the default (Hindi does): hiding it is allowed.
    const offEn = await patchPkg(s.enPkg!, { is_active: false });
    expect(offEn.status(), await offEn.text()).toBe(200);
    const inactive = await setDefault(areq(), s.enPkg!);
    expect(inactive.status(), await inactive.text()).toBe(409);
    expect((await inactive.json()).error).toBe("package_inactive");
    await expectDefault(request, s.courseA!, s.hiV1!);
    expect(await defaultAuditRows(s.courseA!)).toHaveLength(1);
  });

  test("hiding the default slot while another active slot exists → 409 default_slot", async ({ request }) => {
    const onEn = await patchPkg(s.enPkg!, { is_active: true });
    expect(onEn.status(), await onEn.text()).toBe(200);
    const offHi = await patchPkg(s.hiPkg!, { is_active: false });
    expect(offHi.status(), await offHi.text()).toBe(409);
    expect((await offHi.json()).error).toBe("default_slot");
    // Deleting the default language is refused the same way (it would clear the default).
    const delHi = await areq().delete(`/api/courses/${s.courseA}/packages/${s.hiPkg}?orgSlug=${slug()}`);
    expect(delHi.status(), await delHi.text()).toBe(409);
    expect((await delHi.json()).error).toBe("default_slot");
    const { data: hi } = await svc().from("course_packages").select("is_active").eq("id", s.hiPkg!).single();
    expect((hi as { is_active: boolean }).is_active).toBe(true);
    await expectDefault(request, s.courseA!, s.hiV1!);
    // A multi-language course's version_code carries the default's language.
    const item = await catalogCourse(request, s.courseA!);
    if (item?.code) expect(item.version_code).toBe(`${item.code}-HI-V01`);
  });

  test("hiding the only active slot → allowed; launch goes to the course page; catalogue unavailable; Attention item", async ({ browser, baseURL, request }) => {
    expect((await patchPkg(s.enPkg!, { is_active: false })).status()).toBe(200);
    const beforeHide = new Date(Date.now() - 1000).toISOString();
    const offHi = await patchPkg(s.hiPkg!, { is_active: false });
    expect(offHi.status(), await offHi.text()).toBe(200);
    await expectDefault(request, s.courseA!, s.hiV1!, "unavailable");
    expect(await catalogCourse(request, s.courseA!, false), "hidden from the default listing").toBeUndefined();
    // Hiding the default language dates the course, so a delta sync sees it.
    const delta = await catalogCourse(request, s.courseA!, true, beforeHide);
    expect(delta, "in the updated_since delta").toBeTruthy();
    expect(delta!.status).toBe("unavailable");

    // The launch never falls back to the course default while packages exist.
    const ctx = await authedContext(browser, baseURL!, s.learner!.email, s.learner!.password);
    const target = `/${slug()}/courses/${s.courseA}`;
    const res = await ctx.request.get(`${target}/launch`, { maxRedirects: 0 });
    const location = res.headers()["location"] ?? "";
    const body = res.status() === 200 ? await res.text() : "";
    const viaHeader = res.status() >= 300 && res.status() < 400 && new URL(location, baseURL!).pathname === target;
    const viaBody = new RegExp(`NEXT_REDIRECT;(?:replace|push);${target.replace(/[/-]/g, "\\$&")};`).test(body);
    expect(viaHeader || viaBody, `launch → ${res.status()} ${location}`).toBe(true);
    expect(body).not.toContain("<iframe");
    // The course page says so instead of offering a Launch that bounces.
    const coursePage = await ctx.request.get(target, { timeout: 120_000 });
    expect(coursePage.ok(), `course page → ${coursePage.status()}`).toBeTruthy();
    const courseHtml = await coursePage.text();
    expect(courseHtml).toContain("Not available right now");
    expect(courseHtml).not.toContain("Launch course");
    const { count } = await svc()
      .from("course_attempts")
      .select("id", { count: "exact", head: true })
      .eq("user_id", s.learner!.id);
    expect(count ?? 0, "no attempt was started").toBe(0);
    await ctx.close();

    const page = await areq().get(`/${slug()}/attention`);
    expect(page.ok()).toBeTruthy();
    const html = (await page.text()).replace(/&quot;/g, '"').replace(/\\"/g, '"');
    expect(html).toContain("Default language is hidden from learners (Hindi)");

    const lib = await s.adminCtx!.newPage();
    await lib.goto(`/${slug()}/library/${s.courseA}`, { timeout: 120_000 });
    await expect(lib.getByTestId("default-warning")).toContainText("The default version belongs to a hidden language", { timeout: 60_000 });
    await expect(lib.getByTestId("default-language")).toContainText("Hindi (hidden from learners)");
    await lib.close();
  });

  test("an active slot that does not hold the default keeps the course unavailable until Set as default", async ({ request }) => {
    expect((await patchPkg(s.enPkg!, { is_active: true })).status()).toBe(200);
    await expectDefault(request, s.courseA!, s.hiV1!, "unavailable");
    const set = await setDefault(areq(), s.enPkg!);
    expect(set.status(), await set.text()).toBe(200);
    await expectDefault(request, s.courseA!, s.enV1!);
    expect(await defaultAuditRows(s.courseA!)).toHaveLength(2);
  });
});
