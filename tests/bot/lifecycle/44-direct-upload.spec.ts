/**
 * Direct browser-to-storage upload → validate → publish → learner playback
 * (streaming + range) → second version → rollback → abort cleanup.
 *
 * Runs the real admin UI (file chooser, validation report, progress bar) on a
 * 161-file, 9 MB media package. Needs:
 *   - migration 0077 on the target database
 *   - an S3-compatible bucket the browser can reach: the real R2 bucket on
 *     staging, or `node scripts/dev-s3.mjs` locally with
 *     STORAGE_DRIVER=r2 R2_ENDPOINT=http://localhost:9000 R2_BUCKET=lms-content
 *     R2_ACCESS_KEY_ID=S3RVER R2_SECRET_ACCESS_KEY=S3RVER on the app.
 * Set DIRECT_UPLOAD_E2E=1 to enable.
 */
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { addMember, createAuthUser, createOrg, svc } from "../../e2e/helpers/supabase";
import { assignCourse, authedContext } from "./helpers";

const FIXTURES = path.resolve(__dirname, "../fixtures");
test.skip(!process.env.DIRECT_UPLOAD_E2E, "set DIRECT_UPLOAD_E2E=1 with an S3-compatible bucket configured on the app");

async function world() {
  const org = await createOrg({ name: "QA Direct Upload" });
  const admin = await createAuthUser({ profile: { first_name: "Direct", last_name: "Admin", must_change_password: false } });
  await addMember({ organizationId: org.id, userId: admin.id, role: "admin" });
  const learner = await createAuthUser({ profile: { first_name: "Direct", last_name: "Learner", must_change_password: false } });
  await addMember({ organizationId: org.id, userId: learner.id, role: "member" });
  return { org, admin, learner };
}

async function versionsOf(courseId: string) {
  const { data } = await svc()
    .from("course_versions")
    .select("id, package_id, version_number, upload_status, storage_driver, file_count, size_bytes, manifest_data")
    .eq("course_id", courseId)
    .order("version_number", { ascending: true });
  return (data ?? []) as Array<{
    id: string; package_id: string; version_number: number; upload_status: string; storage_driver: string;
    file_count: number | null; size_bytes: number | null; manifest_data: { unitCount?: number | null };
  }>;
}

async function currentVersionId(courseId: string) {
  const { data } = await svc().from("courses").select("current_version_id").eq("id", courseId).single();
  return (data as { current_version_id: string | null }).current_version_id;
}

/** Drive the upload page: choose a zip, validate, accept, wait for success. */
async function uploadThroughUi(page: Page, orgSlug: string, zip: string, courseId?: string) {
  await page.goto(`/${orgSlug}/library/upload${courseId ? `?courseId=${courseId}` : ""}`);
  await page.setInputFiles("input[type=file]", path.join(FIXTURES, zip));
  await page.getByRole("button", { name: /validate/i }).click();
  await expect(page.getByRole("button", { name: /accept & upload/i })).toBeVisible({ timeout: 60_000 });
  // The report was built from the browser bundle: it must know the whole package.
  await expect(page.getByText(/161 files|Scan coverage/i).first()).toBeVisible();
  await page.getByRole("button", { name: /accept & upload/i }).click();
  await expect(page.getByTestId("upload-progress")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/^(Uploaded|New version published)$/)).toBeVisible({ timeout: 180_000 });
}

test("direct upload: 161-file package publishes only after finalise; learner streams it with range support", async ({ browser, baseURL }) => {
  const w = await world();
  const adminCtx = await authedContext(browser, baseURL!, w.admin.email, w.admin.password);
  const page = await adminCtx.newPage();

  // --- v1 through the admin UI
  await uploadThroughUi(page, w.org.slug, "xapi-media.zip");
  const { data: courseRow } = await svc()
    .from("courses")
    .select("id, title, current_version_id")
    .eq("organization_id", w.org.id)
    .eq("title", "QA Bot Media Course")
    .single();
  const course = courseRow as { id: string; current_version_id: string };
  expect(course.current_version_id).toBeTruthy();

  let versions = await versionsOf(course.id);
  expect(versions).toHaveLength(1);
  expect(versions[0].upload_status).toBe("ready");
  expect(versions[0].storage_driver).toBe(process.env.EXPECTED_STORAGE_DRIVER ?? "r2");
  expect(versions[0].file_count).toBe(161);
  expect(versions[0].size_bytes).toBeGreaterThan(9_000_000);
  expect(versions[0].manifest_data.unitCount).toBe(5); // read from the stored launch file
  expect(await currentVersionId(course.id)).toBe(versions[0].id);

  // Validation row is accepted and linked to the version.
  const { data: val } = await svc()
    .from("package_validations")
    .select("status, verdict, course_version_id, size_bytes, report")
    .eq("course_version_id", versions[0].id)
    .maybeSingle();
  expect((val as { status: string }).status).toBe("accepted");
  expect((val as { size_bytes: number }).size_bytes).toBeGreaterThan(9_000_000); // whole package, not the bundle
  expect(JSON.stringify((val as { report: unknown }).report)).toContain("Scan coverage");

  await assignCourse(adminCtx.request, w.org.slug, course.id, w.learner.id);

  // --- learner: launch + content delivery
  const learnerCtx = await authedContext(browser, baseURL!, w.learner.email, w.learner.password);
  const req = learnerCtx.request;
  const base = `/${w.org.slug}/courses/${course.id}`;
  const launch = await req.get(`${base}/launch`);
  expect(launch.ok()).toBeTruthy();

  const vtxt = await req.get(`${base}/content/version.txt`);
  expect(vtxt.status()).toBe(200);
  expect(await vtxt.text()).toBe("v1");
  expect(vtxt.headers()["accept-ranges"]).toBe("bytes");
  expect(vtxt.headers()["content-type"]).toContain("text/plain");

  // Range: the first KB of a 1.5 MB audio file → 206 with the right window.
  const part = await req.get(`${base}/content/assets/media/intro.mp3`, { headers: { Range: "bytes=0-1023" } });
  expect(part.status()).toBe(206);
  expect(part.headers()["content-range"]).toBe("bytes 0-1023/1500000");
  expect((await part.body()).length).toBe(1024);
  expect(part.headers()["content-type"]).toContain("audio/mpeg");
  const tail = await req.get(`${base}/content/assets/media/intro.mp3`, { headers: { Range: "bytes=1499000-" } });
  expect(tail.status()).toBe(206);
  expect((await tail.body()).length).toBe(1000);
  const bad = await req.get(`${base}/content/assets/media/intro.mp3`, { headers: { Range: "bytes=9999999-" } });
  expect(bad.status()).toBe(416);
  expect(bad.headers()["content-range"]).toBe("bytes */1500000");
  // Traversal is refused; a foreign course id is not found.
  expect((await req.get(`${base}/content/..%2F..%2Fother/index.html`)).status()).toBe(403);

  // Real browser playback: the package loads, reads version.txt through the
  // content route and the audio element gets its metadata via range requests.
  const lp = await learnerCtx.newPage();
  // The <audio preload="metadata"> element makes the browser issue its own
  // range request for the mp3; it must come back as a 206 from the content
  // route. (The fixture bytes are not decodable audio, so we assert the
  // transport, not playback.)
  const mediaResponses: Array<{ status: number; range: string | null }> = [];
  lp.on("response", (r) => {
    if (r.url().includes("/content/assets/media/intro.mp3")) {
      mediaResponses.push({ status: r.status(), range: r.headers()["content-range"] ?? null });
    }
  });
  await lp.goto(`${base}/launch`);
  const frame = lp.frameLocator("iframe");
  await expect(frame.locator("#status")).toHaveText(/fresh start at slide 1/, { timeout: 60_000 });
  await expect(frame.locator("#version")).toHaveText("version v1");
  await expect
    .poll(() => mediaResponses.some((r) => r.status === 206 && /^bytes \d+-\d+\/1500000$/.test(r.range ?? "")), {
      timeout: 20_000,
      message: `browser media request served as 206 range: ${JSON.stringify(mediaResponses)}`,
    })
    .toBe(true);
  await lp.close();

  // --- v2 through the admin UI (replace the same package)
  await uploadThroughUi(page, w.org.slug, "xapi-media-v2.zip", course.id);
  versions = await versionsOf(course.id);
  expect(versions).toHaveLength(2);
  expect(versions[1].version_number).toBe(2);
  expect(versions[1].package_id).toBe(versions[0].package_id);
  expect(await currentVersionId(course.id)).toBe(versions[1].id);
  expect(await (await req.get(`${base}/content/version.txt`)).text()).toBe("v2");

  // --- rollback: Make current on v1 from the course page
  await page.goto(`/${w.org.slug}/library/${course.id}`);
  // Under `next dev` the button can render before it is hydrated; retry the
  // click until the confirm dialog actually opens.
  await expect(async () => {
    await page.getByRole("button", { name: /make current/i }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
  await page.getByRole("dialog").getByRole("button", { name: /make current/i }).click();
  await expect.poll(() => currentVersionId(course.id), { timeout: 15_000 }).toBe(versions[0].id);
  expect(await (await req.get(`${base}/content/version.txt`)).text()).toBe("v1");
  const { data: audit } = await svc()
    .from("platform_audit_log")
    .select("action, target_id")
    .eq("action", "course.version.activated")
    .eq("target_id", versions[0].id)
    .limit(1);
  expect(audit?.length ?? 0).toBe(1);

  await learnerCtx.close();
  await adminCtx.close();
});

test("direct upload: an unfinished upload never becomes current; abort and the reaper clean it up", async ({ browser, baseURL }) => {
  const w = await world();
  const adminCtx = await authedContext(browser, baseURL!, w.admin.email, w.admin.password);
  const req: APIRequestContext = adminCtx.request;

  // Validate the small xAPI fixture the legacy way (full zip is fine for the validator).
  const zipBuf = fs.readFileSync(path.join(FIXTURES, "xapi.zip"));
  const v = await req.post("/api/courses/validate-package", {
    multipart: { orgSlug: w.org.slug, file: { name: "xapi.zip", mimeType: "application/zip", buffer: zipBuf } },
  });
  expect(v.ok(), await v.text()).toBeTruthy();
  const validationId = (await v.json()).validation_id as string;

  const zip = await JSZip.loadAsync(zipBuf);
  const files = await Promise.all(
    Object.entries(zip.files).filter(([, e]) => !e.dir).map(async ([p, e]) => ({ path: p, size: (await e.async("uint8array")).length }))
  );
  const init = await req.post("/api/courses/upload/init", {
    data: {
      orgSlug: w.org.slug,
      validation_id: validationId,
      manifest: { fileName: "tincan.xml", xml: await zip.file("tincan.xml")!.async("string") },
      files,
    },
  });
  expect(init.ok(), await init.text()).toBeTruthy();
  const j = (await init.json()) as { courseId: string; versionId: string; signBatch: number; fileCount: number };
  expect(j.fileCount).toBe(files.length);
  expect(j.signBatch).toBeGreaterThan(0);

  // Signed URLs come in batches; a batch larger than the driver's budget is refused.
  const tooMany = await req.post("/api/courses/upload/sign", {
    data: { orgSlug: w.org.slug, versionId: j.versionId, files: Array.from({ length: j.signBatch + 1 }, (_, i) => ({ path: `x/${i}.txt` })) },
  });
  expect(tooMany.status()).toBe(400);
  const sign = await req.post("/api/courses/upload/sign", {
    data: { orgSlug: w.org.slug, versionId: j.versionId, files: files.map((f) => ({ path: f.path })) },
  });
  expect(sign.ok(), await sign.text()).toBeTruthy();
  const signed = (await sign.json()) as { uploads: Array<{ path: string; key: string; url: string; headers: Record<string, string> }> };
  expect(signed.uploads).toHaveLength(files.length);
  expect(signed.uploads.every((u) => u.key.startsWith(`courses/${j.courseId}/`))).toBeTruthy();
  const escaped = await req.post("/api/courses/upload/sign", {
    data: { orgSlug: w.org.slug, versionId: j.versionId, files: [{ path: "../../escape.txt" }] },
  });
  expect(escaped.status()).toBe(400);

  // Nothing is current yet, and the validation cannot be reused.
  expect(await currentVersionId(j.courseId)).toBeNull();
  const reuse = await req.post("/api/courses/upload/init", {
    data: { orgSlug: w.org.slug, validation_id: validationId, manifest: { fileName: "tincan.xml", xml: await zip.file("tincan.xml")!.async("string") }, files },
  });
  expect(reuse.status()).toBe(400);

  // Upload only the manifest, then try to finalise → refused, retryable.
  const only = signed.uploads.find((u) => u.path === "tincan.xml")!;
  const put = await req.put(only.url, { headers: only.headers, data: await zip.file("tincan.xml")!.async("nodebuffer") });
  expect(put.ok(), `PUT to storage → ${put.status()}`).toBeTruthy();
  const fin = await req.post("/api/courses/upload/finalize", { data: { orgSlug: w.org.slug, versionId: j.versionId } });
  expect(fin.status()).toBe(409);
  expect((await fin.json()).retryable).toBe(true);
  expect(await currentVersionId(j.courseId)).toBeNull();

  // A learner cannot read anything from it (no current version → 404).
  const learnerCtx = await authedContext(browser, baseURL!, w.learner.email, w.learner.password);
  await assignCourse(req, w.org.slug, j.courseId, w.learner.id);
  expect((await learnerCtx.request.get(`/${w.org.slug}/courses/${j.courseId}/content/index.html`)).status()).toBe(404);
  await learnerCtx.close();

  // Abort: row and files go away.
  const ab = await req.post("/api/courses/upload/abort", { data: { orgSlug: w.org.slug, versionId: j.versionId } });
  expect(ab.ok(), await ab.text()).toBeTruthy();
  expect(await versionsOf(j.courseId)).toHaveLength(0);
  expect((await req.post("/api/courses/upload/finalize", { data: { orgSlug: w.org.slug, versionId: j.versionId } })).status()).toBe(404);

  // Reaper: an 'uploading' row older than 24 h is swept.
  if (process.env.CRON_SECRET) {
    const v2 = await req.post("/api/courses/validate-package", {
      multipart: { orgSlug: w.org.slug, file: { name: "xapi.zip", mimeType: "application/zip", buffer: zipBuf } },
    });
    const init2 = await req.post("/api/courses/upload/init", {
      data: { orgSlug: w.org.slug, courseId: j.courseId, validation_id: (await v2.json()).validation_id, manifest: { fileName: "tincan.xml", xml: await zip.file("tincan.xml")!.async("string") }, files },
    });
    expect(init2.ok(), await init2.text()).toBeTruthy();
    const stale = (await init2.json()).versionId as string;
    await svc().from("course_versions").update({ upload_started_at: new Date(Date.now() - 2 * 86_400_000).toISOString() }).eq("id", stale);
    const reap = await req.post("/api/cron/reaper", { headers: { "x-cron-secret": process.env.CRON_SECRET } });
    expect(reap.ok(), await reap.text()).toBeTruthy();
    expect((await reap.json()).abandonedUploadsSwept).toBeGreaterThanOrEqual(1);
    expect((await versionsOf(j.courseId)).find((x) => x.id === stale)).toBeUndefined();
  }
  await adminCtx.close();
});
