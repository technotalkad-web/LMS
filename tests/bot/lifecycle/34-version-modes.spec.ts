/**
 * Silent module versioning modes on "Replace content".
 *
 *  - grandfather (default): a learner with an in-progress attempt keeps routing
 *    to their RETIRED version (bookmark intact); no new attempt is created.
 *  - force_restart: old in-progress attempts are silently marked 'abandoned';
 *    the next launch creates a fresh attempt on the NEW version (0%).
 *
 * No learner-facing choice/notice in either mode.
 *
 * ADR 0011: a forced restart reports its reset apart from the publish, on
 * both upload paths (multipart replace and direct finalize): the counts
 * (`expected`, `restarted`, `resolved`) and a message, "No learners were in
 * progress." only for a selection that read fine and found nobody. A failed
 * reset is a 500 with `published: true`; it cannot be produced here without
 * harming the database and is proven by tests/unit/force-restart.test.ts.
 * Any non-2xx answer fails these tests (no skip).
 *
 * Per-version restart (ADR 0008 decision A, step 17 part A): "Restart
 * learners on this version" closes the in-progress attempts of ONE version
 * only — never another version, a grant retake or a completed attempt —
 * with a dry run first, a required reason, token expiry and an audit row;
 * afterwards the reset attempt is not in progress on any surface.
 */
import { test, expect, type BrowserContext } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  addMember,
  createAuthUser,
  createOrg,
  svc,
} from "./data";
import { authedContext, uploadCourse, assignCourse, launch } from "./helpers";
import { directUpload } from "./p0-helpers";

const FIXTURES = path.resolve(__dirname, "../fixtures");
const zipBuf = () => fs.readFileSync(path.join(FIXTURES, "scorm12.zip"));

async function seed(
  browser: import("@playwright/test").Browser,
  baseURL: string,
  /** Overrides for the seeded v1 attempt (e.g. an already passed one). */
  attempt: Record<string, unknown> = {}
) {
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
      ...attempt,
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
  // ADR 0011 step 10: no skip; migration 0043 is on every environment and a
  // non-ok answer (e.g. "…but resetting N learners failed…") fails the test.
  expect(replace.ok(), `replace → ${replace.status()}: ${body}`).toBeTruthy();
  const rep = JSON.parse(body);
  const v2 = rep.version_id as string;
  // ADR 0011 step 13: one selected, one reset, nobody resolved elsewhere.
  expect(rep).toMatchObject({ ok: true, mode: "force_restart", expected: 1, restarted: 1, resolved: 0, message: "1 learner reset." });
  expect(rep.version_number).toBe(2);
  // Counts only: no attempt or user ids in the answer.
  expect(body).not.toContain(s.attemptId);
  expect(body).not.toContain(s.learner.id);
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

const PASSED = {
  status: "passed",
  completion_status: "completed",
  success_status: "passed",
  score: 0.9,
  completed_at: new Date().toISOString(),
};

test("force_restart with nobody in progress: 200, the genuine zero; the passed attempt is untouched (ADR 0011)", async ({
  browser,
  baseURL,
}) => {
  // Seeded already passed (not a second replace after a launch, which would
  // find the fresh attempt on v2 and give expected: 1).
  const s = await seed(browser, baseURL!, PASSED);
  const before = await attemptRow(s.attemptId);
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
  expect(replace.status(), body).toBe(200);
  expect(JSON.parse(body)).toMatchObject({
    ok: true,
    mode: "force_restart",
    restarted: 0,
    expected: 0,
    resolved: 0,
    message: "No learners were in progress.",
  });
  await s.adminCtx.close();
  expect(await attemptRow(s.attemptId)).toEqual(before);
});

test("direct finalize force_restart: the in-progress attempt is reset and reported (ADR 0011)", async ({ browser, baseURL }) => {
  const s = await seed(browser, baseURL!);
  const r = await directUpload(s.adminCtx.request, {
    orgSlug: s.org.slug,
    buffer: zipBuf(),
    name: "scorm12.zip",
    courseId: s.course.courseId,
    packageId: s.pkgId,
    acknowledge: true,
    mode: "force_restart",
  });
  expect(r.finalize?.status, JSON.stringify(r)).toBe(200);
  const body = r.finalize!.body as { versionId?: string; restart?: Record<string, unknown> };
  // toMatchObject: tokensExpired is informational (ADR 0011 step 3), so a
  // transient token-table error must not fail a reset that worked.
  expect(body.restart).toMatchObject({
    status: "ok",
    expected: 1,
    restarted: 1,
    resolved: 0,
    unresolved: 0,
    unresolved_version_ids: [],
    message: "1 learner reset.",
  });
  const text = JSON.stringify(r.finalize!.body);
  expect(text).not.toContain(s.attemptId);
  expect(text).not.toContain(s.learner.id);
  await s.adminCtx.close();
  expect((await attemptRow(s.attemptId)).status).toBe("abandoned");
  // The new version is the package's current version.
  const { data: pkg } = await svc().from("course_packages").select("current_version_id").eq("id", s.pkgId).single();
  expect((pkg as { current_version_id: string }).current_version_id).toBe(body.versionId);
});

test("direct finalize force_restart with nobody in progress: 200, the genuine zero (ADR 0011)", async ({ browser, baseURL }) => {
  const s = await seed(browser, baseURL!, PASSED);
  const before = await attemptRow(s.attemptId);
  const r = await directUpload(s.adminCtx.request, {
    orgSlug: s.org.slug,
    buffer: zipBuf(),
    name: "scorm12.zip",
    courseId: s.course.courseId,
    packageId: s.pkgId,
    acknowledge: true,
    mode: "force_restart",
  });
  expect(r.finalize?.status, JSON.stringify(r)).toBe(200);
  expect((r.finalize!.body as { restart?: Record<string, unknown> }).restart).toEqual({
    status: "ok",
    expected: 0,
    restarted: 0,
    resolved: 0,
    unresolved: 0,
    unresolved_version_ids: [],
    message: "No learners were in progress.",
    tokensExpired: true,
  });
  await s.adminCtx.close();
  expect(await attemptRow(s.attemptId)).toEqual(before);
});

// ---------------------------------------------------------------------------
// Per-version restart (ADR 0008 decision A)
// ---------------------------------------------------------------------------

type User = { id: string; email: string; password: string };
const RESTART_ACTION = "course.version.attempts_restarted";
const RESET = "Reset — module updated";

async function seedAttempt(
  versionId: string,
  userId: string,
  orgId: string,
  over: Record<string, unknown> = {}
): Promise<string> {
  const { data, error } = await svc()
    .from("course_attempts")
    .insert({
      course_version_id: versionId,
      user_id: userId,
      organization_id: orgId,
      status: "in_progress",
      completion_status: "in_progress",
      success_status: "unknown",
      cmi_data: { "cmi.core.lesson_location": "page-2" },
      ...over,
    })
    .select("id")
    .single();
  expect(error, error?.message).toBeNull();
  return (data as { id: string }).id;
}

async function attemptRow(id: string) {
  const { data } = await svc()
    .from("course_attempts")
    .select("status, completion_status, success_status, score, completed_at, course_version_id")
    .eq("id", id)
    .single();
  return data as Record<string, unknown>;
}

async function restartAuditRows(versionId: string) {
  const { data, error } = await svc()
    .from("platform_audit_log")
    .select("actor_user_id, action, target_type, target_id, metadata")
    .eq("action", RESTART_ACTION)
    .eq("target_id", versionId);
  expect(error, error?.message).toBeNull();
  return (data ?? []) as Array<{ actor_user_id: string; target_type: string; metadata: Record<string, unknown> }>;
}

async function tokenExpiry(attemptId: string): Promise<number[]> {
  const { data } = await svc().from("cmi5_launch_tokens").select("expires_at").eq("attempt_id", attemptId);
  return ((data ?? []) as Array<{ expires_at: string }>).map((t) => new Date(t.expires_at).getTime());
}

test.describe.serial("per-version restart (ADR 0008 A)", () => {
  const s: {
    org?: { id: string; slug: string };
    adminCtx?: BrowserContext;
    admin?: User;
    owner?: User;
    learners?: { reset: User; v2: User; retake: User; done: User; manager: User };
    courseId?: string;
    courseTitle?: string;
    pkgId?: string;
    v1?: string;
    v2?: string;
    att?: { reset: string; staff: string; v2: string; retake: string; done: string };
    dry?: { attempt_ids: string[]; excluded_grant_retake_ids: string[]; by_role: { learner: number; staff: number } };
  } = {};
  const url = (versionId: string) =>
    `/api/courses/${s.courseId}/packages/${s.pkgId}/versions/${versionId}/restart`;

  test.afterAll(async () => {
    await s.adminCtx?.close().catch(() => {});
  });

  test("seed: v1 + v2; in progress on both; a grant retake and a completion on v1", async ({ browser, baseURL }) => {
    const org = await createOrg({ name: "QA Version Restart" });
    s.org = org;
    const mk = async (first: string, role: "admin" | "super_owner" | "user") => {
      const u = await createAuthUser({ profile: { first_name: first, last_name: "Restart", must_change_password: false } });
      await addMember({ organizationId: org.id, userId: u.id, role });
      return u as User;
    };
    s.admin = await mk("Admin", "admin");
    s.owner = await mk("Owner", "super_owner");
    s.learners = {
      reset: await mk("Reset", "user"),
      v2: await mk("OnV2", "user"),
      retake: await mk("Retake", "user"),
      done: await mk("Done", "user"),
      manager: await mk("Manager", "user"),
    };
    // The Report Card path: the manager is the reset learner's line manager.
    const { error: lmErr } = await svc()
      .from("organization_members")
      .update({ line_manager_id: s.learners.manager.id })
      .eq("organization_id", org.id)
      .eq("user_id", s.learners.reset.id);
    expect(lmErr, lmErr?.message).toBeNull();

    s.adminCtx = await authedContext(browser, baseURL!, s.admin.email, s.admin.password);
    const req = s.adminCtx.request;
    const course = await uploadCourse(req, org.slug, "scorm12.zip");
    s.courseId = course.courseId;
    s.v1 = course.versionId;
    const { data: c } = await svc().from("courses").select("title").eq("id", course.courseId).single();
    s.courseTitle = (c as { title: string }).title;
    const { data: pkgs } = await svc().from("course_packages").select("id").eq("course_id", course.courseId);
    s.pkgId = (pkgs ?? [])[0].id as string;
    for (const l of [s.learners.reset, s.learners.v2, s.learners.retake, s.learners.done]) {
      await assignCourse(req, org.slug, course.courseId, l.id);
    }

    // v2 becomes the package's current version (grandfather: nobody reset).
    const replace = await req.post(`/api/courses/${s.courseId}/packages/${s.pkgId}/versions`, {
      multipart: {
        orgSlug: org.slug,
        mode: "grandfather",
        file: { name: "scorm12.zip", mimeType: "application/zip", buffer: zipBuf() },
      },
    });
    expect(replace.ok(), `replace → ${replace.status()}: ${await replace.text()}`).toBeTruthy();
    s.v2 = (await replace.json()).version_id as string;

    const L = s.learners;
    s.att = {
      reset: await seedAttempt(s.v1, L.reset.id, org.id),
      staff: await seedAttempt(s.v1, s.admin.id, org.id),
      v2: await seedAttempt(s.v2, L.v2.id, org.id),
      retake: await seedAttempt(s.v1, L.retake.id, org.id),
      done: await seedAttempt(s.v1, L.done.id, org.id, {
        status: "passed",
        completion_status: "completed",
        success_status: "passed",
        score: 0.9,
        completed_at: new Date().toISOString(),
      }),
    };
    // A consumed grant: the retake attempt is the grant's used_attempt_id.
    const { error: grantErr } = await svc().from("attempt_requests").insert({
      organization_id: org.id,
      course_id: s.courseId,
      user_id: L.retake.id,
      status: "approved",
      source: "bulk",
      decided_by: s.admin.id,
      decided_at: new Date().toISOString(),
      used_at: new Date().toISOString(),
      used_attempt_id: s.att.retake,
    });
    expect(grantErr, grantErr?.message).toBeNull();
    // SCORM attempts mint no cmi5 token: seed a live one for the attempt to reset.
    const { error: tokErr } = await svc().from("cmi5_launch_tokens").insert({
      auth_token: randomUUID(),
      attempt_id: s.att.reset,
      expires_at: new Date(Date.now() + 24 * 3600_000).toISOString(),
    });
    expect(tokErr, tokErr?.message).toBeNull();
    expect((await tokenExpiry(s.att.reset))[0]).toBeGreaterThan(Date.now());
  });

  test("refusals change nothing: user 403, other org 404, current of an active package 409, reason 400", async ({
    browser,
    baseURL,
  }) => {
    const slug = s.org!.slug;
    // A plain user of the organisation.
    const userCtx = await authedContext(browser, baseURL!, s.learners!.reset.email, s.learners!.reset.password);
    const asUser = await userCtx.request.post(url(s.v1!), { data: { orgSlug: slug, reason: "x" } });
    expect(asUser.status()).toBe(403);
    await userCtx.close();

    // Another organisation's admin, through their own organisation.
    const other = await createOrg({ name: "QA Restart Other" });
    const otherAdmin = await createAuthUser({ profile: { first_name: "Other", last_name: "Admin", must_change_password: false } });
    await addMember({ organizationId: other.id, userId: otherAdmin.id, role: "admin" });
    const otherCtx = await authedContext(browser, baseURL!, otherAdmin.email, otherAdmin.password);
    for (const body of [{ orgSlug: other.slug, dry_run: true }, { orgSlug: other.slug, reason: "x" }]) {
      const res = await otherCtx.request.post(url(s.v1!), { data: body });
      expect(res.status(), await res.text()).toBe(404);
    }
    // …and through ours: not a member, so RLS hides the organisation itself.
    const cross = await otherCtx.request.post(url(s.v1!), { data: { orgSlug: slug, reason: "x" } });
    expect(cross.status()).toBe(404);
    await otherCtx.close();

    const req = s.adminCtx!.request;
    // The current version of an ACTIVE package: resetting onto the same version corrects nothing.
    for (const body of [{ orgSlug: slug, dry_run: true }, { orgSlug: slug, reason: "x" }]) {
      const res = await req.post(url(s.v2!), { data: body });
      expect(res.status(), await res.text()).toBe(409);
      expect((await res.json()).error).toBe("version_is_current");
    }
    // A real run needs a reason of 1–500 characters.
    for (const reason of [undefined, "", "   ", "x".repeat(501)]) {
      const res = await req.post(url(s.v1!), { data: { orgSlug: slug, ...(reason === undefined ? {} : { reason }) } });
      expect(res.status(), `reason ${JSON.stringify(reason)?.slice(0, 20)}`).toBe(400);
      expect((await res.json()).error).toBe("reason_required");
    }
    // dry_run must be a JSON boolean: a string "true" sent with a reason is
    // refused, never read as a real (irreversible) run.
    for (const dry_run of ["true", 1, null]) {
      const res = await req.post(url(s.v1!), { data: { orgSlug: slug, dry_run, reason: "QA: dry run sent as a string" } });
      expect(res.status(), `dry_run ${JSON.stringify(dry_run)}`).toBe(400);
      expect((await res.json()).error).toBe("invalid_dry_run");
    }
    // An unknown version of this package.
    const ghost = await req.post(url(randomUUID()), { data: { orgSlug: slug, dry_run: true } });
    expect(ghost.status()).toBe(404);

    for (const id of [s.att!.reset, s.att!.staff, s.att!.retake, s.att!.v2]) {
      expect((await attemptRow(id)).status).toBe("in_progress");
    }
    expect((await tokenExpiry(s.att!.reset))[0]).toBeGreaterThan(Date.now());
    expect(await restartAuditRows(s.v1!)).toEqual([]);
    expect(await restartAuditRows(s.v2!)).toEqual([]);
  });

  test("dry run: the per-attempt list, ids and role classes only; nothing changed, no audit row", async () => {
    const res = await s.adminCtx!.request.post(url(s.v1!), { data: { orgSlug: s.org!.slug, dry_run: true } });
    expect(res.status(), await res.text()).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      dry_run: true,
      version_id: s.v1,
      attempt_ids: [s.att!.reset, s.att!.staff].sort(),
      excluded_grant_retake_ids: [s.att!.retake],
      by_role: { learner: 1, staff: 1 },
    });
    // Privacy: no user ids, names or emails.
    const text = JSON.stringify(body);
    for (const u of [s.learners!.reset, s.admin!]) {
      expect(text).not.toContain(u.id);
      expect(text).not.toContain(u.email);
    }
    s.dry = body;
    for (const id of [s.att!.reset, s.att!.staff, s.att!.retake]) {
      expect((await attemptRow(id)).status).toBe("in_progress");
    }
    expect((await tokenExpiry(s.att!.reset))[0]).toBeGreaterThan(Date.now());
    expect(await restartAuditRows(s.v1!)).toEqual([]);
  });

  test("Library: the button on v1 opens the dry-run counts and needs a reason; none on the current v2", async () => {
    const page = await s.adminCtx!.newPage();
    await page.goto(`/${s.org!.slug}/library/${s.courseId}`, { timeout: 120_000 });
    const v1Row = page.locator("li", { hasText: s.v1! });
    const v2Row = page.locator("li", { hasText: s.v2! });
    await expect(v1Row).toBeVisible({ timeout: 60_000 });
    await expect(v2Row.getByRole("button", { name: "Restart learners on this version" })).toHaveCount(0);
    await v1Row.getByRole("button", { name: "Restart learners on this version" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByTestId("restart-counts")).toHaveText(
      "2 in-progress attempts: 1 learner, 1 staff; 1 grant retake excluded.",
      { timeout: 30_000 }
    );
    const go = dialog.getByRole("button", { name: "Restart 2 attempts" });
    await expect(go).toBeDisabled();
    await dialog.getByLabel(/Reason/).fill("QA: checking the dialog only");
    await expect(go).toBeEnabled();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.close();
    // Cancelling changed nothing.
    expect((await attemptRow(s.att!.reset)).status).toBe("in_progress");
    expect(await restartAuditRows(s.v1!)).toEqual([]);
  });

  test("real run on v1: only v1's in-progress attempts reset; grant retake, completion and v2 untouched; tokens expired; audit row", async () => {
    const reason = "QA: wrong module on v1 (ledger entry QA-1)";
    const doneBefore = await attemptRow(s.att!.done);
    const res = await s.adminCtx!.request.post(url(s.v1!), { data: { orgSlug: s.org!.slug, reason: `  ${reason} ` } });
    expect(res.status(), await res.text()).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ...s.dry, dry_run: false, restarted: 2 });

    expect((await attemptRow(s.att!.reset)).status).toBe("abandoned");
    expect((await attemptRow(s.att!.staff)).status).toBe("abandoned");
    expect((await attemptRow(s.att!.retake)).status).toBe("in_progress");
    expect((await attemptRow(s.att!.v2)).status).toBe("in_progress");
    expect(await attemptRow(s.att!.done)).toEqual(doneBefore);
    // Launch tokens expire with the attempt (generous app↔runner clock skew).
    const exp = await tokenExpiry(s.att!.reset);
    expect(exp.length).toBe(1);
    expect(exp[0]).toBeLessThanOrEqual(Date.now() + 5 * 60_000);

    const audit = await restartAuditRows(s.v1!);
    expect(audit.length).toBe(1);
    expect(audit[0].actor_user_id).toBe(s.admin!.id);
    expect(audit[0].target_type).toBe("course_version");
    expect(audit[0].metadata).toEqual({
      courseId: s.courseId,
      packageId: s.pkgId,
      versionNumber: 1,
      reason,
      attemptIds: s.dry!.attempt_ids,
      excludedGrantRetakeIds: [s.att!.retake],
      requestedCount: 2,
    });
    // LRS: this organisation has no forwarding configured → no outbox row.
    const { data: outbox, error: obErr } = await svc()
      .from("lrs_forward_outbox")
      .select("statement_id")
      .eq("organization_id", s.org!.id);
    expect(obErr, obErr?.message).toBeNull();
    expect(outbox ?? []).toEqual([]);

    // Run again: nothing left in progress on v1; the retake is still excluded.
    const again = await s.adminCtx!.request.post(url(s.v1!), { data: { orgSlug: s.org!.slug, dry_run: true } });
    expect(await again.json()).toMatchObject({ attempt_ids: [], excluded_grant_retake_ids: [s.att!.retake], by_role: { learner: 0, staff: 0 } });
  });

  test("after the run the reset attempt is not in progress anywhere, and a stale tab gets 410", async ({
    browser,
    baseURL,
    request,
  }) => {
    const L = s.learners!;
    const slug = s.org!.slug;
    // Learner course page: the reset pill, no Resume.
    const ctx = await authedContext(browser, baseURL!, L.reset.email, L.reset.password);
    const page = await ctx.request.get(`/${slug}/courses/${s.courseId}`, { timeout: 120_000 });
    expect(page.ok(), `course page → ${page.status()}`).toBeTruthy();
    const html = await page.text();
    expect(html).toContain(RESET);
    expect(html).not.toContain("Resume course");
    expect(html).toContain("Launch course");
    // A runtime write to the reset attempt answers 410 and changes nothing.
    const before = await attemptRow(s.att!.reset);
    const commit = await ctx.request.post(`/api/scorm/${s.att!.reset}/commit`, {
      data: { cmi: { "cmi.core.lesson_status": "passed", "cmi.core.score.raw": "95" }, finished: true },
    });
    expect(commit.status()).toBe(410);
    expect(await commit.json()).toEqual({ error: "attempt_abandoned" });
    expect(await attemptRow(s.att!.reset)).toEqual(before);
    await ctx.close();

    // Library summary: reset learner Not started; v2 learner and the retake In progress; the completion Completed.
    const lib = await s.adminCtx!.newPage();
    await lib.goto(`/${slug}/library/${s.courseId}`, { timeout: 120_000 });
    await expect(lib.getByTestId("sum-total")).toHaveText("4", { timeout: 60_000 });
    await expect(lib.getByTestId("sum-in-progress")).toHaveText("2");
    await expect(lib.getByTestId("sum-not-started")).toHaveText("1");
    await expect(lib.getByTestId("sum-completed")).toHaveText("1");
    // Nothing left to restart on v1: the dialog says so and offers nothing.
    await lib.locator("li", { hasText: s.v1! }).getByRole("button", { name: "Restart learners on this version" }).click();
    const dialog = lib.getByRole("dialog");
    await expect(dialog.getByTestId("restart-counts")).toContainText("No in-progress attempts on this version", { timeout: 30_000 });
    await expect(dialog.getByRole("button", { name: /^Restart/ })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Close" }).click();
    await lib.close();

    // CRM progress feed: status is not in progress.
    const ownerCtx = await authedContext(browser, baseURL!, s.owner!.email, s.owner!.password);
    const keyRes = await ownerCtx.request.post("/api/org/api-keys", { data: { orgSlug: slug, name: "QA restart" } });
    expect(keyRes.ok(), `api key → ${keyRes.status()}: ${await keyRes.text()}`).toBeTruthy();
    const key = (await keyRes.json()).key as string;
    await ownerCtx.close();
    const prog = await request.get(`/api/integrations/progress?email=${encodeURIComponent(L.reset.email)}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(prog.status(), await prog.text()).toBe(200);
    const learner = ((await prog.json()).progress as Array<{ email: string; courses: Array<{ course_id: string; status: string }> }>)
      .find((p) => p.email?.toLowerCase() === L.reset.email.toLowerCase());
    expect(learner, "the reset learner is in the feed").toBeTruthy();
    expect(learner!.courses.find((c) => c.course_id === s.courseId)?.status).toBe("not_started");

    // Report Card (manager's employee report): the course reads Not started.
    const mgr = await authedContext(browser, baseURL!, L.manager.email, L.manager.password);
    const rc = await mgr.newPage();
    await rc.goto(`/${slug}/team-performance/${L.reset.id}`, { timeout: 120_000 });
    const row = rc.locator("tr", { hasText: s.courseTitle! });
    await expect(row).toBeVisible({ timeout: 60_000 });
    await expect(row).toContainText("Not started");
    await expect(row).not.toContainText("In progress");
    // Gap 6/10: the reset attempt is not counted as an attempt; it shows as a suffix.
    await expect(row).toContainText("· 1 reset");
    await rc.close();
    await mgr.close();
  });

  test("the current version of a deactivated package can be restarted", async () => {
    const slug = s.org!.slug;
    const off = await s.adminCtx!.request.patch(`/api/courses/${s.courseId}/packages/${s.pkgId}`, {
      data: { orgSlug: slug, is_active: false },
    });
    expect(off.ok(), `deactivate → ${off.status()}: ${await off.text()}`).toBeTruthy();

    const page = await s.adminCtx!.newPage();
    await page.goto(`/${slug}/library/${s.courseId}`, { timeout: 120_000 });
    await expect(
      page.locator("li", { hasText: s.v2! }).getByRole("button", { name: "Restart learners on this version" })
    ).toBeVisible({ timeout: 60_000 });
    await page.close();

    const res = await s.adminCtx!.request.post(url(s.v2!), {
      data: { orgSlug: slug, reason: "QA: language slot retired" },
    });
    expect(res.status(), await res.text()).toBe(200);
    expect(await res.json()).toMatchObject({ dry_run: false, attempt_ids: [s.att!.v2], restarted: 1, by_role: { learner: 1, staff: 0 } });
    expect((await attemptRow(s.att!.v2)).status).toBe("abandoned");
    // v1's grant retake is still untouched.
    expect((await attemptRow(s.att!.retake)).status).toBe("in_progress");
    expect((await restartAuditRows(s.v2!)).length).toBe(1);
  });
});
