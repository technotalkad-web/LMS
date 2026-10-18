/**
 * Direct browser-to-storage upload → validate → publish → learner playback
 * (streaming + range) → second version → rollback → abort cleanup.
 *
 * ADR 0008 D1 (step 25): a version that will never be ready keeps its row
 * as 'failed' (prefix emptied), so the next upload takes the next number
 * under a new folder: abort (direct path), a multipart upload failing
 * mid-way, and the Library hiding failed rows. The reaper's sweep has its
 * own test, gated by REAPER_E2E=1 (the reaper also acts on other tenants:
 * never set it against shared staging, so it skips itself there); the
 * sweep's write is unit-tested in tests/unit/failed-uploads.test.ts.
 *
 * Runs the real admin UI (file chooser, validation report, progress bar) on a
 * 161-file, 9 MB media package. Needs:
 *   - migration 0077 on the target database
 *   - an S3-compatible bucket the browser can reach: the real R2 bucket on
 *     staging, or `node scripts/dev-s3.mjs` locally with
 *     STORAGE_DRIVER=r2 R2_ENDPOINT=http://localhost:9000 R2_BUCKET=lms-content
 *     R2_ACCESS_KEY_ID=S3RVER R2_SECRET_ACCESS_KEY=S3RVER on the app.
 *     The runner lists version folders with the same storage adapter, so it
 *     needs the app's storage env too (Supabase: the service key it already
 *     has; R2: the R2_* variables).
 * Set DIRECT_UPLOAD_E2E=1 to enable (EXPECTED_STORAGE_DRIVER=supabase when the
 * app has no STORAGE_DRIVER).
 */
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { addMember, createAuthUser, createOrg, svc } from "../../e2e/helpers/supabase";
import { assignCourse, authedContext } from "./helpers";
import { directUpload, uploadNew, zipFile } from "./p0-helpers";
// Static imports: the runner's transform does not follow lib/storage's
// dynamic import() of a .ts module.
import { SupabaseStorageAdapter } from "../../../lib/storage/supabase";
import { R2StorageAdapter } from "../../../lib/storage/r2";

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
    .select("id, package_id, version_number, upload_status, storage_driver, storage_prefix, file_count, size_bytes, manifest_data")
    .eq("course_id", courseId)
    .order("version_number", { ascending: true });
  return (data ?? []) as Array<{
    id: string; package_id: string; version_number: number; upload_status: string; storage_driver: string;
    storage_prefix: string; file_count: number | null; size_bytes: number | null; manifest_data: { unitCount?: number | null };
  }>;
}

/** Every object key under a version's folder (the app's own storage adapter for that row's driver). */
async function keysUnder(v: { storage_driver: string; storage_prefix: string }): Promise<string[]> {
  const storage = v.storage_driver === "r2" ? new R2StorageAdapter() : new SupabaseStorageAdapter();
  return storage.list(v.storage_prefix.replace(/\/$/, ""));
}

/**
 * xapi.zip plus `extra` small files and one entry whose deflate stream is
 * corrupt: the manifest parses and the validator skips the unreadable file,
 * so the multipart upload reserves the version and then fails mid-way
 * (JSZip rejects the entry: "uncompressed data size mismatch").
 */
async function brokenXapiZip(extra = 20): Promise<Buffer> {
  const date = new Date("2026-01-01T00:00:00Z");
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(FIXTURES, "xapi.zip")));
  for (let i = 0; i < extra; i++) zip.file(`assets/extra-${i}.txt`, `extra ${i}`, { date });
  zip.file("assets/broken.txt", "x".repeat(200_000), { date, compression: "DEFLATE" });
  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const name = Buffer.from("assets/broken.txt");
  for (let i = buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04])); i >= 0; i = buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), i + 4)) {
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    if (buf.subarray(i + 30, i + 30 + nameLen).equals(name)) {
      buf[i + 30 + nameLen + extraLen] = 0x07; // BFINAL=1, BTYPE=11 (reserved): an invalid deflate block
      return buf;
    }
  }
  throw new Error("brokenXapiZip: entry not found");
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

  // Legacy URL space (kept one release) still answers.
  expect(await (await req.get(`${base}/content/version.txt`)).text()).toBe("v1");
  // The launch page serves the attempt's version through the versioned route
  // (ALDS step 0, P1) — the delivery checks below run against it.
  const vbase = `${base}/content/v/${versions[0].id}`;
  const vtxt = await req.get(`${vbase}/version.txt`);
  expect(vtxt.status()).toBe(200);
  expect(await vtxt.text()).toBe("v1");
  expect(vtxt.headers()["accept-ranges"]).toBe("bytes");
  expect(vtxt.headers()["content-type"]).toContain("text/plain");

  // Range: the first KB of a 1.5 MB audio file → 206 with the right window.
  const part = await req.get(`${vbase}/assets/media/intro.mp3`, { headers: { Range: "bytes=0-1023" } });
  expect(part.status()).toBe(206);
  expect(part.headers()["content-range"]).toBe("bytes 0-1023/1500000");
  expect((await part.body()).length).toBe(1024);
  expect(part.headers()["content-type"]).toContain("audio/mpeg");
  const tail = await req.get(`${vbase}/assets/media/intro.mp3`, { headers: { Range: "bytes=1499000-" } });
  expect(tail.status()).toBe(206);
  expect((await tail.body()).length).toBe(1000);
  const bad = await req.get(`${vbase}/assets/media/intro.mp3`, { headers: { Range: "bytes=9999999-" } });
  expect(bad.status()).toBe(416);
  expect(bad.headers()["content-range"]).toBe("bytes */1500000");
  // Traversal is refused; a foreign course id is not found.
  expect((await req.get(`${vbase}/..%2F..%2Fother/index.html`)).status()).toBe(403);
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
    if (r.url().includes(`/content/v/${versions[0].id}/assets/media/intro.mp3`)) {
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
  // ALDS step 0 (P1): the legacy route serves the learner's in-progress
  // attempt's version (v1, launched above); the versioned route serves v2.
  expect(await (await req.get(`${base}/content/version.txt`)).text()).toBe("v1");
  expect(await (await req.get(`${base}/content/v/${versions[1].id}/version.txt`)).text()).toBe("v2");
  // The admin (no attempt) gets the course's current version from the legacy route.
  expect(await (await page.request.get(`${base}/content/version.txt`)).text()).toBe("v2");

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
  // Rollback is visible to someone with no attempt (the admin) on the legacy route.
  expect(await (await page.request.get(`${base}/content/version.txt`)).text()).toBe("v1");
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

/** Init a direct upload of the small xAPI fixture (validate + init only); returns the init body. */
async function initSmallUpload(req: APIRequestContext, orgSlug: string, zipBuf: Buffer, courseId?: string) {
  const zip = await JSZip.loadAsync(zipBuf);
  const files = await Promise.all(
    Object.entries(zip.files).filter(([, e]) => !e.dir).map(async ([p, e]) => ({ path: p, size: (await e.async("uint8array")).length }))
  );
  const v = await req.post("/api/courses/validate-package", {
    multipart: { orgSlug, ...(courseId ? { courseId } : {}), file: zipFile("xapi.zip", zipBuf) },
  });
  expect(v.ok(), await v.text()).toBeTruthy();
  const validationId = (await v.json()).validation_id as string;
  const init = await req.post("/api/courses/upload/init", {
    data: {
      orgSlug,
      ...(courseId ? { courseId } : {}),
      validation_id: validationId,
      manifest: { fileName: "tincan.xml", xml: await zip.file("tincan.xml")!.async("string") },
      files,
    },
  });
  expect(init.ok(), await init.text()).toBeTruthy();
  return {
    zip,
    files,
    validationId,
    body: (await init.json()) as { courseId: string; versionId: string; versionNumber: number; storagePrefix: string; signBatch: number; fileCount: number },
  };
}

test("direct upload: an unfinished upload never becomes current; abort keeps a failed row and the next upload moves on", async ({ browser, baseURL }) => {
  const w = await world();
  const adminCtx = await authedContext(browser, baseURL!, w.admin.email, w.admin.password);
  const req: APIRequestContext = adminCtx.request;
  const zipBuf = fs.readFileSync(path.join(FIXTURES, "xapi.zip"));

  const first = await initSmallUpload(req, w.org.slug, zipBuf);
  const { zip, files, validationId } = first;
  const j = first.body;
  expect(j.fileCount).toBe(files.length);
  expect(j.signBatch).toBeGreaterThan(0);
  expect(j.versionNumber).toBe(1);

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
  // …nor through the versioned route, although tincan.xml IS in storage: only
  // finished ('ready') uploads are servable (ALDS step 0, P1).
  expect((await learnerCtx.request.get(`/${w.org.slug}/courses/${j.courseId}/content/v/${j.versionId}/tincan.xml`)).status()).toBe(404);

  // The same package for another (new) course: v1, still uploading, holds
  // its identity, so that validation is blocked (ADR 0004)…
  const verdictElsewhere = async () => {
    const r = await req.post("/api/courses/validate-package", { multipart: { orgSlug: w.org.slug, file: zipFile("xapi.zip", zipBuf) } });
    return ((await r.json()) as { report?: { verdict?: string } }).report?.verdict;
  };
  expect(await verdictElsewhere()).toBe("blocked");

  // --- Abort v1 (ADR 0008 D1): the row stays as 'failed', its files go.
  let versions = await versionsOf(j.courseId);
  expect(await keysUnder(versions[0]), "the manifest PUT landed").toHaveLength(1);
  const ab = await req.post("/api/courses/upload/abort", { data: { orgSlug: w.org.slug, versionId: j.versionId } });
  expect(ab.ok(), await ab.text()).toBeTruthy();
  versions = await versionsOf(j.courseId);
  expect(versions.map((v) => [v.version_number, v.upload_status, v.size_bytes])).toEqual([[1, "failed", 0]]);
  expect(await keysUnder(versions[0]), "v1's folder is empty").toEqual([]);
  // …but a failed row holds no content, so it is never a collision.
  expect(await verdictElsewhere()).not.toBe("blocked");
  // A failed row is not uploading: no more signing or finalising…
  const finFailed = await req.post("/api/courses/upload/finalize", { data: { orgSlug: w.org.slug, versionId: j.versionId } });
  expect(finFailed.status()).toBe(409);
  expect((await finFailed.json()).error).toMatch(/failed, not uploading/);
  expect((await req.post("/api/courses/upload/sign", { data: { orgSlug: w.org.slug, versionId: j.versionId, files: [{ path: "tincan.xml" }] } })).status()).toBe(409);
  // …and aborting it again only empties the folder again (idempotent).
  expect((await req.post("/api/courses/upload/abort", { data: { orgSlug: w.org.slug, versionId: j.versionId } })).ok()).toBeTruthy();
  expect((await versionsOf(j.courseId)).map((v) => v.upload_status)).toEqual(["failed"]);
  // Still nothing for the learner.
  expect((await learnerCtx.request.get(`/${w.org.slug}/courses/${j.courseId}/content/v/${j.versionId}/tincan.xml`)).status()).toBe(404);
  await learnerCtx.close();

  // --- v2 takes the next number under a new folder; abort it mid-way too.
  const second = (await initSmallUpload(req, w.org.slug, zipBuf, j.courseId)).body;
  expect(second.versionNumber).toBe(2);
  versions = await versionsOf(j.courseId);
  const v2 = versions.find((v) => v.id === second.versionId)!;
  expect(v2.package_id).toBe(versions[0].package_id);
  expect(v2.storage_prefix).toBe(`courses/${j.courseId}/${v2.package_id}/v2/`);
  expect(v2.storage_prefix).not.toBe(versions[0].storage_prefix);
  const sign2 = await req.post("/api/courses/upload/sign", {
    data: { orgSlug: w.org.slug, versionId: second.versionId, files: [{ path: "tincan.xml" }] },
  });
  expect(sign2.ok(), await sign2.text()).toBeTruthy();
  const u2 = ((await sign2.json()) as { uploads: Array<{ url: string; headers: Record<string, string> }> }).uploads[0];
  expect((await req.put(u2.url, { headers: u2.headers, data: await zip.file("tincan.xml")!.async("nodebuffer") })).ok()).toBeTruthy();
  expect(await keysUnder(v2)).toHaveLength(1);
  const ab2 = await req.post("/api/courses/upload/abort", { data: { orgSlug: w.org.slug, versionId: second.versionId } });
  expect(ab2.ok(), await ab2.text()).toBeTruthy();
  versions = await versionsOf(j.courseId);
  expect(versions.map((v) => [v.version_number, v.upload_status])).toEqual([[1, "failed"], [2, "failed"]]);
  expect(await keysUnder(v2), "v2's folder is empty").toEqual([]);

  // --- The next full upload is v3 under its own folder, and becomes current.
  const third = await directUpload(req, { orgSlug: w.org.slug, buffer: zipBuf, name: "xapi.zip", courseId: j.courseId });
  expect(third.finalize?.status, JSON.stringify(third)).toBe(200);
  versions = await versionsOf(j.courseId);
  expect(versions.map((v) => [v.version_number, v.upload_status])).toEqual([[1, "failed"], [2, "failed"], [3, "ready"]]);
  const v3 = versions[2];
  expect(v3.id).toBe(third.versionId);
  expect(v3.storage_prefix).toBe(`courses/${j.courseId}/${v3.package_id}/v3/`);
  expect(new Set(versions.map((v) => v.storage_prefix)).size).toBe(3);
  expect((await keysUnder(v3)).length).toBe(files.length);
  expect(await currentVersionId(j.courseId)).toBe(v3.id);

  // --- Library: failed rows are hidden behind "Show failed uploads"; shown,
  // they offer no Discard, Make current or Restart.
  const page = await adminCtx.newPage();
  await page.goto(`/${w.org.slug}/library/${j.courseId}`);
  const rows = page.getByTestId("version-row");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute("data-version-id", v3.id);
  const toggle = page.getByTestId("toggle-failed-uploads");
  await expect(toggle).toHaveText("Show failed uploads (2)");
  await toggle.click();
  await page.waitForURL(/showFailed=1/);
  await expect(rows).toHaveCount(3);
  const failedRows = page.locator('[data-testid="version-row"][data-upload-status="failed"]');
  await expect(failedRows).toHaveCount(2);
  // Only the copy-id chips: no action on a failed row.
  await expect(failedRows.getByRole("button", { name: /discard|make current|restart/i })).toHaveCount(0);
  await expect(failedRows.getByRole("button", { name: /^copy /i })).toHaveCount(4);
  await expect(failedRows.first()).toContainText("failed");
  await expect(page.getByTestId("toggle-failed-uploads")).toHaveText("Hide failed uploads");
  await page.close();
  await adminCtx.close();
});

test("multipart upload: a failure mid-way keeps a failed row with an empty folder; the next upload moves on", async ({ browser, baseURL }) => {
  const w = await world();
  const adminCtx = await authedContext(browser, baseURL!, w.admin.email, w.admin.password);
  const req = adminCtx.request;
  const good = fs.readFileSync(path.join(FIXTURES, "xapi.zip"));

  // v1 through the multipart API path (inline validation).
  const r1 = await uploadNew(req, w.org.slug, "xapi.zip", good);
  expect(r1.ok(), await r1.text()).toBeTruthy();
  const v1 = (await r1.json()) as { courseId: string; versionId: string; versionNumber: number };
  expect(v1.versionNumber).toBe(1);

  // v2: the manifest parses, the version is reserved, then one entry cannot
  // be read while the files are written → refused; the row stays 'failed'.
  const r2 = await uploadNew(req, w.org.slug, "xapi-broken.zip", await brokenXapiZip(), { courseId: v1.courseId });
  expect(r2.status(), await r2.text()).toBe(400);
  let versions = await versionsOf(v1.courseId);
  expect(versions.map((v) => [v.version_number, v.upload_status])).toEqual([[1, "ready"], [2, "failed"]]);
  expect(versions[1].size_bytes).toBe(0);
  expect(versions[1].storage_prefix).toBe(`courses/${v1.courseId}/${versions[1].package_id}/v2/`);
  expect(await keysUnder(versions[1]), "nothing is left in v2's folder").toEqual([]);
  expect(await currentVersionId(v1.courseId)).toBe(v1.versionId);

  // v3: the next upload takes the next number under a new folder.
  const r3 = await uploadNew(req, w.org.slug, "xapi.zip", good, { courseId: v1.courseId });
  expect(r3.ok(), await r3.text()).toBeTruthy();
  const v3 = (await r3.json()) as { versionId: string; versionNumber: number };
  expect(v3.versionNumber).toBe(3);
  versions = await versionsOf(v1.courseId);
  expect(versions.map((v) => [v.version_number, v.upload_status])).toEqual([[1, "ready"], [2, "failed"], [3, "ready"]]);
  expect(versions[2].storage_prefix).toBe(`courses/${v1.courseId}/${versions[2].package_id}/v3/`);
  expect(await currentVersionId(v1.courseId)).toBe(v3.versionId);
  await adminCtx.close();
});

// ADR 0011 step 13: the Library's Replace dialog reports the forced
// restart apart from the publish. Nobody is in progress here, so the
// banner is the genuine zero; the failure banner is unit-tested only.
test("Library Replace with force restart and nobody in progress: the replace-result banner, the new version listed", async ({ browser, baseURL }) => {
  const w = await world();
  const adminCtx = await authedContext(browser, baseURL!, w.admin.email, w.admin.password);
  const zipBuf = fs.readFileSync(path.join(FIXTURES, "xapi.zip"));
  const first = await directUpload(adminCtx.request, { orgSlug: w.org.slug, buffer: zipBuf, name: "xapi.zip", acknowledge: true });
  expect(first.finalize?.status, JSON.stringify(first)).toBe(200);
  const courseId = first.finalize!.body.courseId as string;

  const page = await adminCtx.newPage();
  await page.goto(`/${w.org.slug}/library/${courseId}`, { timeout: 120_000 });
  await page.getByRole("button", { name: "Replace content" }).click();
  const dialog = page.locator("div.fixed").filter({ hasText: "Replace module content" });
  await dialog.locator("input[type=file]").setInputFiles(path.join(FIXTURES, "xapi.zip"));
  await dialog.getByRole("radio", { name: /Force restart on new version/ }).check();
  await dialog.getByRole("button", { name: "Validate package" }).click();
  await expect(dialog.getByRole("button", { name: /accept & upload/i })).toBeVisible({ timeout: 60_000 });
  await dialog.getByRole("button", { name: /accept & upload/i }).click();
  await expect(page.getByTestId("replace-result")).toHaveText("Replaced. No learners were in progress.", { timeout: 180_000 });

  const versions = await versionsOf(courseId);
  expect(versions.map((v) => [v.version_number, v.upload_status])).toEqual([[1, "ready"], [2, "ready"]]);
  expect(await currentVersionId(courseId)).toBe(versions[1].id);
  const row = page.locator(`[data-testid="version-row"][data-version-id="${versions[1].id}"]`);
  await expect(row).toBeVisible({ timeout: 60_000 });
  await expect(row).toContainText("current");
  await adminCtx.close();
});

// The reaper also reaps other tenants: this test calls it only with
// REAPER_E2E=1 (never against shared staging; its write is unit-tested).
test("reaper: an 'uploading' row older than 24 h is swept to 'failed', not deleted", async ({ browser, baseURL }) => {
  test.skip(!process.env.REAPER_E2E || !process.env.CRON_SECRET, "set REAPER_E2E=1 (and CRON_SECRET) only on an isolated database: the reaper acts on every tenant");
  const w = await world();
  const adminCtx = await authedContext(browser, baseURL!, w.admin.email, w.admin.password);
  const req = adminCtx.request;
  const zipBuf = fs.readFileSync(path.join(FIXTURES, "xapi.zip"));
  const stale = (await initSmallUpload(req, w.org.slug, zipBuf)).body;
  await svc().from("course_versions").update({ upload_started_at: new Date(Date.now() - 2 * 86_400_000).toISOString() }).eq("id", stale.versionId);
  const reap = await req.post("/api/cron/reaper", { headers: { "x-cron-secret": process.env.CRON_SECRET! } });
  expect(reap.ok(), await reap.text()).toBeTruthy();
  expect((await reap.json()).abandonedUploadsSwept).toBeGreaterThanOrEqual(1);
  const row = (await versionsOf(stale.courseId)).find((x) => x.id === stale.versionId);
  expect(row?.upload_status).toBe("failed");
  expect(await keysUnder(row!)).toEqual([]);
  await adminCtx.close();
});
