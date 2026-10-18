/**
 * ADR 0004 step 17 — content-integrity check on both upload paths (D2).
 *
 *   - same-org collision (course id, or title) → 'blocked' on the direct
 *     path's validate and on the multipart inline path (409 + validation_id)
 *   - the direct path re-checks the STORED bytes at finalize: a package whose
 *     uploaded files differ from the validated manifest is blocked and
 *     removed before it becomes ready
 *   - the multipart path re-checks the RECEIVED bytes when it accepts a
 *     validation_id: a package validated before its id was taken by another
 *     course is blocked at upload, and a validation run for one course is
 *     refused for another target
 *   - admin override attempt → 403; bad reasons → 400
 *   - super_owner override with a reason → the row stays pending with
 *     overridden_at set; the re-POSTed upload creates the version; the row
 *     becomes accepted; audit row; Attention Center item naming the
 *     overriding super owner and the colliding course; a second override of
 *     the same block is refused                                 (needs 0098)
 *   - a blocked row without override is still refused       (needs 0098)
 *   - same-slot retitle → warning + confirm
 *   - urn:elearning-engine:untitled-course → warning only; two untitled
 *     exports in different courses do not block each other
 *   - the same fixture through the multipart and the direct path → identical
 *     findings after finalize
 *
 * ADR 0008 step 21 (decision C: package_validations is written by the server
 * only; section 1 of migration 0099):
 *   - validate → upload on both paths still creates and links the rows, and
 *     validate_existing still records its audit row (server writes; run now)
 *   - a `user` session reads no validation row; the admin session reads its
 *     organisation's (select policy; run now)
 *   - reject (a server write since ADR 0008 step 18): pending → rejected; a
 *     second reject and another test organisation's row → 404, that row
 *     unchanged (run now)
 *   - ADR 0008 D1: a refused finalize into a course that is kept leaves the
 *     version row 'failed' with size 0, the course and its current version
 *     unchanged, and the next upload takes the next number (run now)
 *   - an admin session's PostgREST PATCH of overridden_at / verdict / report
 *     on a pending blocked row, an INSERT and a DELETE → refused, row
 *     unchanged                                                (needs 0099)
 *   - the super_owner override route still works: the override test below,
 *     unchanged
 */
import { test, expect, type BrowserContext } from "@playwright/test";
import { addMember, createAuthUser, createOrg, isLifecycleSlug, svc } from "./data";
import { authedContext } from "./helpers";
import { NEEDS_0098, NEEDS_0099, cmi5Zip, directUpload, has0098, has0099, sessionClient, uploadNew, zipFile } from "./p0-helpers";

type User = { id: string; email: string; password: string };
const X_ID = "urn:elearning-engine:qa-integrity-x";
const X_TITLE = "QA Integrity X";
const BLOCKED = /already belongs to a different course in this organisation/;

type Findings = {
  identity: { kivoCourseId: string | null; title: string | null };
  collisions: Array<{ courseId: string; matchedOn: string[] }>;
  sameSlot: unknown;
  untitledId: boolean;
  blocked: boolean;
};
const comparable = (f: Findings) => ({
  identity: f.identity,
  collisions: f.collisions.map((c) => ({ courseId: c.courseId, matchedOn: c.matchedOn })),
  sameSlot: f.sameSlot,
  untitledId: f.untitledId,
  blocked: f.blocked,
});

async function courseCount(orgId: string): Promise<number> {
  const { count } = await svc().from("courses").select("id", { count: "exact", head: true }).eq("organization_id", orgId);
  return count ?? 0;
}

test.describe.serial("ADR 0004 — content-integrity check", () => {
  const s: {
    org?: { id: string; slug: string };
    owner?: User;
    admin?: User;
    ownerCtx?: BrowserContext;
    adminCtx?: BrowserContext;
    courseX?: string;
    pkgX?: string;
    inlineBlockedId?: string | null;
    /** The exact bytes the inline 409 bound its row to (sha256): every re-POST reuses this Buffer. */
    inlineZip?: Buffer;
  } = {};

  test.afterAll(async () => {
    await s.ownerCtx?.close().catch(() => {});
    await s.adminCtx?.close().catch(() => {});
  });

  test("seed: an org with course X (KIVO-style id) and a super owner + an admin", async ({ browser, baseURL }) => {
    const org = await createOrg({ name: "QA Integrity" });
    const owner = await createAuthUser({ profile: { first_name: "Integ", last_name: "Owner", must_change_password: false } });
    await addMember({ organizationId: org.id, userId: owner.id, role: "super_owner" });
    const admin = await createAuthUser({ profile: { first_name: "Integ", last_name: "Admin", must_change_password: false } });
    await addMember({ organizationId: org.id, userId: admin.id, role: "admin" });
    Object.assign(s, { org, owner, admin });
    s.ownerCtx = await authedContext(browser, baseURL!, owner.email, owner.password);
    s.adminCtx = await authedContext(browser, baseURL!, admin.email, admin.password);
    const up = await uploadNew(s.adminCtx.request, org.slug, "x.zip", await cmi5Zip({ courseId: X_ID, title: X_TITLE }));
    expect(up.ok(), `upload X → ${up.status()}: ${await up.text()}`).toBeTruthy();
    s.courseX = (await up.json()).courseId as string;
    const { data: pkg } = await svc().from("course_packages").select("id").eq("course_id", s.courseX).single();
    s.pkgX = (pkg as { id: string }).id;
    // New versions persist the identity the lookup matches on.
    const { data: v } = await svc().from("course_versions").select("manifest_data").eq("course_id", s.courseX).single();
    expect((v as { manifest_data: { identity?: unknown } }).manifest_data.identity).toEqual({ kivoCourseId: X_ID, title: X_TITLE });
  });

  test("direct path: same id (or same title) as another course → blocked at validate", async () => {
    const areq = s.adminCtx!.request;
    for (const [zip, matched] of [
      [await cmi5Zip({ courseId: X_ID, title: "QA Integrity X retitled" }), ["id"]],
      [await cmi5Zip({ courseId: "urn:elearning-engine:qa-integrity-other", title: X_TITLE }), ["title"]],
    ] as Array<[Buffer, string[]]>) {
      const v = await areq.post("/api/courses/validate-package", { multipart: { orgSlug: s.org!.slug, file: zipFile("c.zip", zip) } });
      // Before 0098 the blocked row cannot be stored: 409 with the report and no id.
      expect([200, 409]).toContain(v.status());
      const j = await v.json();
      expect(j.report.verdict).toBe("blocked");
      expect(j.report.integrity.collisions.map((c: { courseId: string; matchedOn: string[] }) => [c.courseId, c.matchedOn])).toEqual([[s.courseX, matched]]);
      expect(j.report.checks.find((c: { id: string }) => c.id === "integrity").status).toBe("fail");
      expect(j.can_override ?? false, "an admin is never offered the override").toBe(false);
      if (await has0098()) {
        expect(v.status()).toBe(200);
        expect(typeof j.validation_id).toBe("string");
        // init refuses the blocked validation.
        const r = await directUpload(areq, { orgSlug: s.org!.slug, buffer: zip, name: "c.zip", validationId: j.validation_id });
        expect(r.init?.status).toBe(409);
        expect(String(r.init?.body.error)).toMatch(BLOCKED);
      } else {
        expect(v.status()).toBe(409);
        expect(j.validation_id).toBeNull();
      }
    }
  });

  test("multipart inline path: collision → 409 with validation_id; nothing created", async () => {
    const before = await courseCount(s.org!.id);
    s.inlineZip = await cmi5Zip({ courseId: X_ID, title: "QA Integrity X copy" });
    const r = await uploadNew(s.adminCtx!.request, s.org!.slug, "c.zip", s.inlineZip);
    expect(r.status(), await r.text()).toBe(409);
    const j = await r.json();
    expect(j.error).toMatch(BLOCKED);
    expect("validation_id" in j, "the 409 names the row an override can target").toBe(true);
    if (await has0098()) {
      expect(typeof j.validation_id).toBe("string");
      const { data: row } = await svc().from("package_validations").select("status, verdict, overridden_at").eq("id", j.validation_id).single();
      expect(row).toEqual({ status: "pending", verdict: "blocked", overridden_at: null });
    } else {
      test.info().annotations.push({ type: "note", description: `validation_id is null until 0098 widens the verdict constraint (${NEEDS_0098})` });
    }
    s.inlineBlockedId = j.validation_id ?? null;
    expect(await courseCount(s.org!.id)).toBe(before);
  });

  test("direct path: finalize re-checks the stored bytes and blocks before ready", async () => {
    const before = await courseCount(s.org!.id);
    const clean = await cmi5Zip({ courseId: "urn:elearning-engine:qa-integrity-clean", title: "QA Integrity Clean" });
    const wrong = await cmi5Zip({ courseId: X_ID, title: "QA Integrity Clean" }); // stored bytes = course X's id
    const r = await directUpload(s.adminCtx!.request, { orgSlug: s.org!.slug, buffer: clean, name: "clean.zip", filesFrom: wrong, acknowledge: true });
    const vr = r.validate?.body.report as { verdict: string; integrity: { blocked: boolean } };
    expect(vr.integrity.blocked, "the validated package itself collides with nothing").toBe(false);
    expect(vr.verdict).not.toBe("blocked");
    expect(r.init?.status, JSON.stringify(r.init?.body)).toBe(200);
    expect(r.finalize?.status, JSON.stringify(r.finalize?.body)).toBe(409);
    expect(String(r.finalize?.body.error)).toMatch(BLOCKED);
    expect(r.finalize?.body.retryable).toBe(false);
    const { data: gone } = await svc().from("course_versions").select("id").eq("id", r.versionId!).maybeSingle();
    expect(gone, "the blocked upload never became a version").toBeNull();
    expect(await courseCount(s.org!.id), "the course created by this upload is removed too").toBe(before);
  });

  test("override: an admin gets 403; empty or over-long reasons get 400", async () => {
    const id = s.inlineBlockedId ?? "00000000-0000-0000-0000-000000000000";
    const body = (reason: string) => ({ action: "override", orgSlug: s.org!.slug, validation_id: id, override_reason: reason });
    const admin = await s.adminCtx!.request.post("/api/courses/validate-package", { data: body("we know") });
    expect(admin.status(), await admin.text()).toBe(403);
    expect((await s.ownerCtx!.request.post("/api/courses/validate-package", { data: body("   ") })).status()).toBe(400);
    expect((await s.ownerCtx!.request.post("/api/courses/validate-package", { data: body("x".repeat(501)) })).status()).toBe(400);
  });

  test("multipart: a validation run for course X is refused for a different target (a new course)", async () => {
    const areq = s.adminCtx!.request;
    const zip = await cmi5Zip({ courseId: "urn:elearning-engine:qa-integrity-bound", title: "QA Integrity Bound" });
    const v = await areq.post("/api/courses/validate-package", {
      multipart: { orgSlug: s.org!.slug, courseId: s.courseX!, file: zipFile("bound.zip", zip) },
    });
    expect(v.status(), await v.text()).toBe(200);
    const j = await v.json();
    expect(j.report.integrity.context.courseId).toBe(s.courseX);
    const before = await courseCount(s.org!.id);
    const up = await uploadNew(areq, s.org!.slug, "bound.zip", zip, { validation_id: j.validation_id, acknowledge: "1" });
    expect(up.status(), await up.text()).toBe(400);
    expect((await up.json()).error).toMatch(/run for a different course/);
    expect(await courseCount(s.org!.id)).toBe(before);
  });

  test("multipart: a package validated before another course took its id is blocked when the upload accepts it", async () => {
    const areq = s.adminCtx!.request;
    const LATE_ID = "urn:elearning-engine:qa-integrity-late";
    const zip = await cmi5Zip({ courseId: LATE_ID, title: "QA Integrity Late" });
    const v = await areq.post("/api/courses/validate-package", { multipart: { orgSlug: s.org!.slug, file: zipFile("late.zip", zip) } });
    expect(v.status(), await v.text()).toBe(200);
    const j = await v.json();
    expect(j.report.integrity.blocked, "nothing carries this id yet").toBe(false);
    // Meanwhile another course is created with the same course id.
    const other = await uploadNew(areq, s.org!.slug, "late-other.zip", await cmi5Zip({ courseId: LATE_ID, title: "QA Integrity Late Other" }));
    expect(other.status(), await other.text()).toBe(200);
    const otherCourse = (await other.json()).courseId as string;
    const before = await courseCount(s.org!.id);
    const up = await uploadNew(areq, s.org!.slug, "late.zip", zip, { validation_id: j.validation_id, acknowledge: "1" });
    expect(up.status(), await up.text()).toBe(409);
    const body = await up.json();
    expect(body.error).toMatch(BLOCKED);
    expect(await courseCount(s.org!.id), "nothing created").toBe(before);
    const { data: row } = await svc().from("package_validations").select("*").eq("id", j.validation_id).single();
    const r = row as { status: string; verdict: string; report: { integrity?: { collisions?: Array<{ courseId: string }> } } };
    expect(r.status, "the row stays pending (an override can still target it)").toBe("pending");
    if (await has0098()) {
      expect(body.validation_id).toBe(j.validation_id);
      expect(r.verdict).toBe("blocked");
      expect((r.report.integrity?.collisions ?? []).map((c) => c.courseId)).toEqual([otherCourse]);
    } else {
      expect(body.validation_id).toBeNull();
      test.info().annotations.push({ type: "note", description: `the row cannot be marked blocked until 0098 (${NEEDS_0098})` });
    }
  });


  test("same-slot retitle → warning that needs the admin's confirm", async () => {
    const areq = s.adminCtx!.request;
    const zip = await cmi5Zip({ courseId: X_ID, title: "QA Integrity X (2026 edition)" });
    const v = await areq.post("/api/courses/validate-package", {
      multipart: { orgSlug: s.org!.slug, courseId: s.courseX!, packageId: s.pkgX!, file: zipFile("x2.zip", zip) },
    });
    expect(v.status(), await v.text()).toBe(200);
    const j = await v.json();
    expect(j.report.verdict).toBe("warning");
    expect(j.report.integrity.blocked).toBe(false);
    expect(j.report.integrity.sameSlot).toMatchObject({ titleChanged: true, idChanged: false });
    expect(j.report.checks.find((c: { id: string }) => c.id === "integrity-slot")?.status).toBe("warning");
    const noAck = await directUpload(areq, { orgSlug: s.org!.slug, buffer: zip, name: "x2.zip", courseId: s.courseX, packageId: s.pkgX, validationId: j.validation_id });
    expect(noAck.init?.status).toBe(400);
    expect(String(noAck.init?.body.error)).toMatch(/Accept & Upload/);
    const ack = await directUpload(areq, { orgSlug: s.org!.slug, buffer: zip, name: "x2.zip", courseId: s.courseX, packageId: s.pkgX, validationId: j.validation_id, acknowledge: true });
    expect(ack.init?.status, JSON.stringify(ack.init?.body)).toBe(200);
    expect(ack.finalize?.status, JSON.stringify(ack.finalize?.body)).toBe(200);
    // Uploading into its own course is never a collision.
    const { data: vrow } = await svc().from("package_validations").select("status, acknowledged_warnings").eq("id", j.validation_id).single();
    expect(vrow).toEqual({ status: "accepted", acknowledged_warnings: true });
  });

  test("untitled KIVO id → warning only; two untitled exports in different courses do not block each other", async () => {
    const areq = s.adminCtx!.request;
    const one = await cmi5Zip({ courseId: "urn:elearning-engine:untitled-course", title: "QA Integrity Untitled One" });
    const v = await areq.post("/api/courses/validate-package", { multipart: { orgSlug: s.org!.slug, file: zipFile("u1.zip", one) } });
    expect(v.status(), await v.text()).toBe(200);
    const j = await v.json();
    expect(j.report.verdict).toBe("warning");
    expect(j.report.integrity.untitledId).toBe(true);
    expect(j.report.checks.find((c: { id: string }) => c.id === "integrity-untitled")?.status).toBe("warning");
    const up1 = await uploadNew(areq, s.org!.slug, "u1.zip", one);
    expect(up1.status(), await up1.text()).toBe(200);
    const two = await cmi5Zip({ courseId: "urn:elearning-engine:untitled-course", title: "QA Integrity Untitled Two" });
    const up2 = await uploadNew(areq, s.org!.slug, "u2.zip", two);
    expect(up2.status(), `second untitled export → ${up2.status()}: ${await up2.text()}`).toBe(200);
  });

  test("the same fixture through the multipart and the direct path → identical findings after finalize", async ({ browser, baseURL }) => {
    const fixture = await cmi5Zip({ courseId: "urn:elearning-engine:qa-integrity-same", title: "QA Integrity Same" });
    const ctxs: BrowserContext[] = [];
    const orgFor = async (name: string) => {
      const org = await createOrg({ name });
      const admin = await createAuthUser({ profile: { first_name: "Same", last_name: "Admin", must_change_password: false } });
      await addMember({ organizationId: org.id, userId: admin.id, role: "admin" });
      const ctx = await authedContext(browser, baseURL!, admin.email, admin.password);
      ctxs.push(ctx);
      return { org, req: ctx.request };
    };
    const a = await orgFor("QA Integrity Same A");
    const b = await orgFor("QA Integrity Same B");

    const mp = await uploadNew(a.req, a.org.slug, "same.zip", fixture);
    expect(mp.status(), await mp.text()).toBe(200);
    const mpVersion = (await mp.json()).versionId as string | undefined;
    const direct = await directUpload(b.req, { orgSlug: b.org.slug, buffer: fixture, name: "same.zip", acknowledge: true });
    expect(direct.finalize?.status, JSON.stringify(direct.finalize?.body)).toBe(200);

    const reportOf = async (orgId: string) => {
      const { data } = await svc()
        .from("package_validations")
        .select("report, course_version_id")
        .eq("organization_id", orgId)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();
      return data as { report: { integrity: Findings & { stage: string } }; course_version_id: string | null };
    };
    const ra = await reportOf(a.org.id);
    const rb = await reportOf(b.org.id);
    expect(ra.report.integrity.stage).toBe("inline");
    expect(rb.report.integrity.stage).toBe("finalize");
    expect(comparable(rb.report.integrity)).toEqual(comparable(ra.report.integrity));
    const identityOf = async (versionId: string) =>
      ((await svc().from("course_versions").select("manifest_data").eq("id", versionId).single()).data as { manifest_data: { identity: unknown } }).manifest_data.identity;
    const va = mpVersion ?? ra.course_version_id!;
    expect(await identityOf(direct.versionId!)).toEqual(await identityOf(va));
    for (const c of ctxs) await c.close();
  });

  // ---- ADR 0008 C: the server's own writes still work (run before and after 0099) ----
  test("ADR 0008 C: validate → upload on both paths creates and links the validation rows", async () => {
    const areq = s.adminCtx!.request;
    const row = async (id: string) =>
      (await svc().from("package_validations").select("status, organization_id, course_id, course_version_id").eq("id", id).single()).data;

    // Multipart: validate (pending row), then the upload accepts and links it.
    const mpZip = await cmi5Zip({ courseId: "urn:elearning-engine:qa-integrity-link-mp", title: "QA Integrity Link Multipart" });
    const v = await areq.post("/api/courses/validate-package", { multipart: { orgSlug: s.org!.slug, file: zipFile("link-mp.zip", mpZip) } });
    expect(v.status(), await v.text()).toBe(200);
    const mpId = (await v.json()).validation_id as string;
    expect(await row(mpId)).toEqual({ status: "pending", organization_id: s.org!.id, course_id: null, course_version_id: null });
    const up = await uploadNew(areq, s.org!.slug, "link-mp.zip", mpZip, { validation_id: mpId, acknowledge: "1" });
    expect(up.status(), await up.text()).toBe(200);
    const mpCourse = (await up.json()).courseId as string;
    const { data: c } = await svc().from("courses").select("current_version_id").eq("id", mpCourse).single();
    expect(await row(mpId)).toEqual({
      status: "accepted",
      organization_id: s.org!.id,
      course_id: mpCourse,
      course_version_id: (c as { current_version_id: string }).current_version_id,
    });

    // Direct: validate → init (consumes the row) → finalize (links it).
    const dZip = await cmi5Zip({ courseId: "urn:elearning-engine:qa-integrity-link-direct", title: "QA Integrity Link Direct" });
    const d = await directUpload(areq, { orgSlug: s.org!.slug, buffer: dZip, name: "link-direct.zip", acknowledge: true });
    expect(d.finalize?.status, JSON.stringify(d.finalize?.body)).toBe(200);
    const dId = d.validate!.body.validation_id as string;
    const { data: dv } = await svc().from("course_versions").select("course_id").eq("id", d.versionId!).single();
    expect(await row(dId)).toEqual({
      status: "accepted",
      organization_id: s.org!.id,
      course_id: (dv as { course_id: string }).course_id,
      course_version_id: d.versionId,
    });
  });

  test("ADR 0008 C: validate_existing still records its audit row", async () => {
    const r = await s.adminCtx!.request.post("/api/courses/validate-package", {
      data: { action: "validate_existing", orgSlug: s.org!.slug, course_id: s.courseX },
    });
    expect(r.status(), await r.text()).toBe(200);
    const id = (await r.json()).validation_id as string;
    expect(typeof id).toBe("string");
    const { data: c } = await svc().from("courses").select("current_version_id").eq("id", s.courseX!).single();
    const current = (c as { current_version_id: string }).current_version_id;
    const { data: v } = await svc()
      .from("package_validations")
      .select("status, organization_id, course_id, course_version_id, sha256, uploaded_by")
      .eq("id", id)
      .single();
    expect(v).toEqual({
      status: "accepted",
      organization_id: s.org!.id,
      course_id: s.courseX,
      course_version_id: current,
      sha256: `stored:${current}`,
      uploaded_by: s.admin!.id,
    });
  });

  test("ADR 0008 C: a user session reads no validation row; the admin session reads its organisation's", async () => {
    const learner = await createAuthUser({ profile: { first_name: "Integ", last_name: "Learner", must_change_password: false } });
    await addMember({ organizationId: s.org!.id, userId: learner.id, role: "user" });
    const { count } = await svc()
      .from("package_validations")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", s.org!.id);
    expect(count ?? 0, "the organisation has validation rows").toBeGreaterThan(0);
    const userDb = await sessionClient(learner);
    const { data: seen, error } = await userDb.from("package_validations").select("id").eq("organization_id", s.org!.id);
    expect(error).toBeNull();
    expect(seen, "a user reads nothing").toEqual([]);
    const adminDb = await sessionClient(s.admin!);
    const { data: adminSeen, error: adminErr } = await adminDb.from("package_validations").select("id").eq("organization_id", s.org!.id);
    expect(adminErr).toBeNull();
    expect((adminSeen ?? []).length, "the admin reads every row of the organisation").toBe(count);
  });

  test("ADR 0008 C: reject is a server write bound to the organisation and to a pending row", async ({ browser, baseURL }) => {
    const areq = s.adminCtx!.request;
    const rowOf = async (id: string) =>
      (await svc().from("package_validations").select("status, organization_id").eq("id", id).single()).data as { status: string; organization_id: string };
    const reject = (id: string) => areq.post("/api/courses/validate-package", { data: { action: "reject", orgSlug: s.org!.slug, validation_id: id } });
    const zip = await cmi5Zip({ courseId: "urn:elearning-engine:qa-integrity-reject", title: "QA Integrity Reject" });

    const v = await areq.post("/api/courses/validate-package", { multipart: { orgSlug: s.org!.slug, file: zipFile("reject.zip", zip) } });
    expect(v.status(), await v.text()).toBe(200);
    const id = (await v.json()).validation_id as string;
    expect(await rowOf(id)).toEqual({ status: "pending", organization_id: s.org!.id });
    const first = await reject(id);
    expect(first.status(), await first.text()).toBe(200);
    expect(await rowOf(id), "the row is rejected").toEqual({ status: "rejected", organization_id: s.org!.id });
    const again = await reject(id);
    expect(again.status(), "a second reject finds no pending row").toBe(404);

    // Another test organisation's pending row: this admin's reject is scoped to
    // their own organisation, so it matches nothing and the row stays.
    const other = await createOrg({ name: "QA Integrity Reject Other" });
    expect(isLifecycleSlug(other.slug)).toBeTruthy();
    const otherAdmin = await createAuthUser({ profile: { first_name: "Integ", last_name: "OtherAdmin", must_change_password: false } });
    await addMember({ organizationId: other.id, userId: otherAdmin.id, role: "admin" });
    const octx = await authedContext(browser, baseURL!, otherAdmin.email, otherAdmin.password);
    const ov = await octx.request.post("/api/courses/validate-package", { multipart: { orgSlug: other.slug, file: zipFile("reject-other.zip", zip) } });
    expect(ov.status(), await ov.text()).toBe(200);
    const otherId = (await ov.json()).validation_id as string;
    await octx.close();
    const cross = await reject(otherId);
    expect(cross.status(), "another organisation's row is not found").toBe(404);
    expect(await rowOf(otherId), "…and unchanged").toEqual({ status: "pending", organization_id: other.id });
  });

  test("ADR 0008 D1: a refused finalize into a kept course leaves its version 'failed' and the course as it was", async () => {
    const areq = s.adminCtx!.request;
    const Y_ID = "urn:elearning-engine:qa-integrity-kept";
    const Y_TITLE = "QA Integrity Kept";
    const up = await uploadNew(areq, s.org!.slug, "kept.zip", await cmi5Zip({ courseId: Y_ID, title: Y_TITLE }));
    expect(up.status(), await up.text()).toBe(200);
    const courseY = (await up.json()).courseId as string;
    const courseRow = async () => (await svc().from("courses").select("id, current_version_id").eq("id", courseY).maybeSingle()).data;
    const before = await courseRow();
    expect(before?.current_version_id, "course Y has a current version").toBeTruthy();
    const { data: pkg } = await svc().from("course_packages").select("id").eq("course_id", courseY).single();
    const pkgY = (pkg as { id: string }).id;

    // Validated bytes are Y's own; the stored bytes carry course X's id, so
    // finalize refuses them (the collision is found on what was stored).
    const clean = await cmi5Zip({ courseId: Y_ID, title: Y_TITLE, marker: "kept-v2" });
    const wrong = await cmi5Zip({ courseId: X_ID, title: Y_TITLE, marker: "kept-v2" });
    const r = await directUpload(areq, { orgSlug: s.org!.slug, buffer: clean, name: "kept-v2.zip", courseId: courseY, packageId: pkgY, filesFrom: wrong, acknowledge: true });
    expect(r.init?.status, JSON.stringify(r.init?.body)).toBe(200);
    expect(r.finalize?.status, JSON.stringify(r.finalize?.body)).toBe(409);
    expect(String(r.finalize?.body.error)).toMatch(BLOCKED);
    expect(r.finalize?.body.retryable).toBe(false);

    const { data: refused } = await svc().from("course_versions").select("upload_status, size_bytes, version_number").eq("id", r.versionId!).maybeSingle();
    expect(refused, "the refused version keeps its row, emptied").toMatchObject({ upload_status: "failed", size_bytes: 0 });
    expect(await courseRow(), "the course is kept with its current version").toEqual(before);

    // The number stays taken: the next upload into the slot moves on.
    const next = await directUpload(areq, {
      orgSlug: s.org!.slug,
      buffer: await cmi5Zip({ courseId: Y_ID, title: Y_TITLE, marker: "kept-v3" }),
      name: "kept-v3.zip",
      courseId: courseY,
      packageId: pkgY,
      acknowledge: true,
    });
    expect(next.finalize?.status, JSON.stringify(next.finalize?.body)).toBe(200);
    const { data: nv } = await svc().from("course_versions").select("version_number").eq("id", next.versionId!).single();
    expect((nv as { version_number: number }).version_number).toBe((refused as { version_number: number }).version_number + 1);
  });

  // ---- needs 0098: rows with verdict 'blocked' and the override columns ----
  test("a blocked row without an override is still refused (multipart re-POST; the direct gate is covered above)", async () => {
    test.skip(!(await has0098()), NEEDS_0098);
    // multipart re-POST of the inline-blocked row (the same bytes), no override
    const again = await uploadNew(s.adminCtx!.request, s.org!.slug, "c.zip", s.inlineZip!, { validation_id: s.inlineBlockedId! });
    expect(again.status(), await again.text()).toBe(409);
    expect((await again.json()).validation_id).toBe(s.inlineBlockedId);
  });

  test("ADR 0008 C: an admin session's PostgREST PATCH / INSERT / DELETE on package_validations is refused, row unchanged", async () => {
    test.skip(!(await has0099()), NEEDS_0099);
    // Its own pending blocked row (0099 requires 0098, so blocked rows store).
    const v = await s.adminCtx!.request.post("/api/courses/validate-package", {
      multipart: { orgSlug: s.org!.slug, file: zipFile("guard.zip", await cmi5Zip({ courseId: X_ID, title: "QA Integrity X guard" })) },
    });
    expect(v.status(), await v.text()).toBe(200);
    const id = (await v.json()).validation_id as string;
    const read = async () => (await svc().from("package_validations").select("*").eq("id", id).single()).data as Record<string, unknown>;
    const orgCount = async () =>
      (await svc().from("package_validations").select("id", { count: "exact", head: true }).eq("organization_id", s.org!.id)).count ?? 0;
    const before = await read();
    expect(before).toMatchObject({ status: "pending", verdict: "blocked", overridden_at: null });

    const adminDb = await sessionClient(s.admin!);
    const patches: Array<Record<string, unknown>> = [
      { overridden_at: new Date().toISOString(), overridden_by: s.admin!.id, override_reason: "forged" },
      { verdict: "pass" },
      { report: { forged: true } },
    ];
    for (const patch of patches) {
      const res = await adminDb.from("package_validations").update(patch).eq("id", id).select("id");
      expect(Boolean(res.error) || (res.data ?? []).length === 0, `PATCH ${Object.keys(patch).join(", ")} refused`).toBe(true);
      expect(await read(), "row unchanged").toEqual(before);
    }

    const countBefore = await orgCount();
    const ins = await adminDb
      .from("package_validations")
      .insert({ organization_id: s.org!.id, sha256: "forged", verdict: "pass", report: {}, status: "accepted" })
      .select("id");
    expect(ins.error, "INSERT refused").toBeTruthy();
    expect(await orgCount(), "no row created").toBe(countBefore);

    const del = await adminDb.from("package_validations").delete().eq("id", id).select("id");
    expect(Boolean(del.error) || (del.data ?? []).length === 0, "DELETE refused").toBe(true);
    expect(await read(), "row still there, unchanged").toEqual(before);
  });

  test("super_owner override with a reason → upload goes through, accepted, audited, in the Attention Center", async () => {
    test.skip(!(await has0098()), NEEDS_0098);
    const reason = "QA: this module deliberately replaces course X";
    const ov = await s.ownerCtx!.request.post("/api/courses/validate-package", {
      data: { action: "override", orgSlug: s.org!.slug, validation_id: s.inlineBlockedId, override_reason: reason },
    });
    expect(ov.status(), await ov.text()).toBe(200);
    const { data: row } = await svc()
      .from("package_validations")
      .select("status, verdict, override_reason, overridden_by, overridden_at")
      .eq("id", s.inlineBlockedId!)
      .single();
    expect(row).toMatchObject({ status: "pending", verdict: "blocked", override_reason: reason, overridden_by: s.owner!.id });
    const firstOverrideAt = (row as { overridden_at: string | null }).overridden_at;
    expect(firstOverrideAt).toBeTruthy();

    // A second override of the same block is refused and changes nothing.
    const again = await s.ownerCtx!.request.post("/api/courses/validate-package", {
      data: { action: "override", orgSlug: s.org!.slug, validation_id: s.inlineBlockedId, override_reason: "QA: second reason" },
    });
    expect(again.status(), await again.text()).toBe(409);
    const { data: row2 } = await svc()
      .from("package_validations")
      .select("override_reason, overridden_at")
      .eq("id", s.inlineBlockedId!)
      .single();
    expect(row2).toEqual({ override_reason: reason, overridden_at: firstOverrideAt });

    const zip = s.inlineZip!;
    const up = await uploadNew(s.adminCtx!.request, s.org!.slug, "c.zip", zip, { validation_id: s.inlineBlockedId! });
    expect(up.status(), await up.text()).toBe(200);
    const courseId = (await up.json()).courseId as string;
    const { data: after } = await svc().from("package_validations").select("status, course_id").eq("id", s.inlineBlockedId!).single();
    expect(after).toEqual({ status: "accepted", course_id: courseId });
    const reuse = await uploadNew(s.adminCtx!.request, s.org!.slug, "c.zip", zip, { validation_id: s.inlineBlockedId! });
    expect(reuse.status(), "a consumed validation cannot be reused").toBe(400);

    const { data: audit } = await svc()
      .from("platform_audit_log")
      .select("action, actor_user_id, metadata")
      .eq("target_id", s.inlineBlockedId!)
      .eq("action", "package_validation.block_overridden");
    expect(audit).toHaveLength(1);
    expect((audit![0] as { actor_user_id: string }).actor_user_id).toBe(s.owner!.id);
    expect((audit![0] as { metadata: { reason: string } }).metadata.reason).toBe(reason);

    const page = await s.adminCtx!.request.get(`/${s.org!.slug}/attention`);
    expect(page.ok()).toBeTruthy();
    // Text nodes escape quotes as &quot;, the RSC payload as \".
    const html = (await page.text()).replace(/&quot;/g, '"').replace(/\\"/g, '"');
    expect(html).toContain("Integrity block overridden");
    expect(html, "the item names the colliding course").toContain(`Matched "${X_TITLE}"`);
    expect(html, "the item names the overriding super owner").toContain("Integ Owner");
  });
});
