/**
 * ADR 0009 steps 12-13 — attempt rows are written only by the server.
 *
 * Every case calls PostgREST directly with a real user session (JWT from
 * signInWithPassword with the anon key, the spec 50 pattern) on rows of this
 * spec's own qa-* organisations, and every assertion is on a service-role
 * re-read of the row, never on the status code alone: a revoked privilege
 * answers 42501, a dropped policy with the privilege present answers 200 with
 * zero rows, and both count as refused.
 *
 *   (a) learner PATCH of own in-progress SCORM attempt to passed / completed /
 *       score 1 / completed_at / progress_pct 100        → row unchanged
 *   (b) learner PATCH of cmi_data alone on the same row   → unchanged
 *   (c) learner POST of a never-launched completed + passed row
 *                                                         → no row
 *   (d) learner POST naming the other organisation's version id and the
 *       learner's own organization_id                     → no row
 *   (f) learner DELETE of the SCORM attempt               → row still exists
 *   (g) admin-session PATCH of the learner's SCORM row    → unchanged
 *   (e) admin force-restart replace of the cmi5 package abandons the cmi5
 *       attempt (an app flow, every run); learner PATCH {status:'in_progress'}
 *       on it                                             → still abandoned
 *   (h) the real paths still work (every run): a fresh cmi5 launch creates an
 *       in_progress row on the new version and a statement through
 *       /api/xapi/statements updates it; a SCORM commit through the route on
 *       the attempt of (a) answers 200 and the row carries the committed
 *       status and score; the learner (and the admin) still read the
 *       learner's rows through PostgREST (select policy kept).
 *
 * Branches, decided by has0099() (a real select of
 * v_course_attempt_summary.live_attempt_count):
 *   - 0099 applied: (a)-(g) assert refusal.
 *   - before 0099, ATTEMPT_GUARD_PROBE=1: the staging probe of ADR 0009 step
 *     13 (owner decision 4: one run, staging test accounts only). The same
 *     calls run; (a)-(e) must succeed and change or create the row (the hole
 *     exists), (f) and (g) are refused today as well. Each outcome is recorded
 *     as a test annotation and a log line (case, HTTP status, row changed,
 *     ids only). Nothing is restored: every row written belongs to this run's
 *     qa-* organisations and goes with the next CI purge.
 *   - before 0099 without the variable: (a)-(g) and the revive skip
 *     ("needs 0099"); the seed, the force restart and (h) still run.
 *
 * Binding (so a probe call that succeeds never invalidates a later case): the
 * SCORM attempt serves (a), (b), (f), (g) and the commit of (h), whose
 * assertions do not depend on what (a)/(b) left; the inserts of (c) target a
 * third course the learner never launches (a forged completion on the cmi5
 * course would turn (h)'s launch into a revision run); the revive of (e) runs
 * last, after (h)'s fresh launch (a revived old-version attempt would be
 * resumed by grandfather routing).
 *
 * Never push while this runs: pr-checks purges qa-* data on every push.
 */
import { test, expect, type BrowserContext } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { addMember, createAuthUser, createOrg, svc } from "../../e2e/helpers/supabase";
import { assignCourse, authedContext } from "./helpers";
import {
  NEEDS_0099,
  VERB,
  XAPI_HEADERS,
  authTokenFor,
  cmi5Zip,
  has0099,
  inProgressAttempt,
  sessionClient,
  scormZip,
  uploadNew,
  zipFile,
} from "./p0-helpers";

type User = { id: string; email: string; password: string };
type Branch = "guard" | "probe" | "skip";
type Row = Record<string, unknown>;

const PROBE = process.env.ATTEMPT_GUARD_PROBE === "1";
const CMI5_ID = "urn:elearning-engine:qa-attempt-guard";
const CMI5_TITLE = "QA Attempt Guard cmi5";

/** Which branch this run takes for the PostgREST write cases. */
async function branch(): Promise<Branch> {
  if (await has0099()) return "guard";
  return PROBE ? "probe" : "skip";
}

/** Service-role re-read of one attempt (every column). */
async function row(id: string): Promise<Row | null> {
  const { data, error } = await svc().from("course_attempts").select("*").eq("id", id).maybeSingle();
  expect(error).toBeNull();
  return (data as Row | null) ?? null;
}

async function rowsFor(userId: string, versionId: string): Promise<Row[]> {
  const { data, error } = await svc()
    .from("course_attempts")
    .select("*")
    .eq("user_id", userId)
    .eq("course_version_id", versionId);
  expect(error).toBeNull();
  return (data ?? []) as Row[];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

type Outcome = { case: string; branch: Branch; http: number; code: string | null; returned: number; changed: boolean; ids: Record<string, string> };
const results: Outcome[] = [];
/** Annotation + log line: ids, status codes and booleans only (no names, no emails). */
function record(o: Outcome) {
  results.push(o);
  test.info().annotations.push({ type: `case ${o.case}`, description: JSON.stringify(o) });
  console.log(`[spec55] ${JSON.stringify(o)}`);
}

test.describe.serial("ADR 0009 — attempt rows are written only by the server", () => {
  const s: {
    orgA?: { id: string; slug: string };
    orgB?: { id: string; slug: string };
    admin?: User;
    learner?: User;
    adminCtx?: BrowserContext;
    learnerCtx?: BrowserContext;
    learnerDb?: SupabaseClient;
    adminDb?: SupabaseClient;
    scormCourse?: string;
    scormVersion?: string;
    scormAttempt?: string;
    cmi5Course?: string;
    cmi5Package?: string;
    cmi5Version?: string;
    cmi5Attempt?: string;
    cmi5NewVersion?: string;
    forgeVersion?: string; // (c): a course the learner never launches
    otherOrgVersion?: string; // (d)
  } = {};

  test.afterAll(async () => {
    await s.adminCtx?.close().catch(() => {});
    await s.learnerCtx?.close().catch(() => {});
    if (results.length) console.log(`[spec55] summary ${JSON.stringify(results)}`);
  });

  test("seed: two qa orgs; a SCORM, a cmi5 and a forge-target course; the learner launches SCORM and cmi5", async ({ browser, baseURL }) => {
    const b = await branch();
    test.info().annotations.push({ type: "branch", description: b });
    console.log(`[spec55] branch=${b}`);

    const orgA = await createOrg({ name: "QA Attempt Guard" });
    const orgB = await createOrg({ name: "QA Attempt Guard Other" });
    expect(orgA.slug.startsWith("qa-") && orgB.slug.startsWith("qa-")).toBeTruthy();
    const admin = await createAuthUser({ profile: { first_name: "AGuard", last_name: "Admin", must_change_password: false } });
    await addMember({ organizationId: orgA.id, userId: admin.id, role: "admin" });
    const learner = await createAuthUser({ profile: { first_name: "AGuard", last_name: "Learner", must_change_password: false } });
    await addMember({ organizationId: orgA.id, userId: learner.id, role: "member" });
    const adminB = await createAuthUser({ profile: { first_name: "AGuard", last_name: "OtherAdmin", must_change_password: false } });
    await addMember({ organizationId: orgB.id, userId: adminB.id, role: "admin" });
    Object.assign(s, { orgA, orgB, admin, learner });

    // The other organisation's course: only its version id is used, by (d).
    const bctx = await authedContext(browser, baseURL!, adminB.email, adminB.password);
    const ub = await uploadNew(bctx.request, orgB.slug, "other.zip", await scormZip({ title: "QA Attempt Guard Other Org" }));
    expect(ub.ok(), `upload other-org course → ${ub.status()}: ${await ub.text()}`).toBeTruthy();
    const otherCourse = (await ub.json()).courseId as string;
    await bctx.close();
    const { data: cb } = await svc().from("courses").select("current_version_id").eq("id", otherCourse).single();
    s.otherOrgVersion = (cb as { current_version_id: string }).current_version_id;

    s.adminCtx = await authedContext(browser, baseURL!, admin.email, admin.password);
    const areq = s.adminCtx.request;
    // Distinct titles (and a distinct cmi5 id): the integrity check blocks a
    // second course carrying another course's identity.
    const upS = await uploadNew(areq, orgA.slug, "scorm.zip", await scormZip({ title: "QA Attempt Guard SCORM" }));
    expect(upS.ok(), `upload SCORM → ${upS.status()}: ${await upS.text()}`).toBeTruthy();
    s.scormCourse = (await upS.json()).courseId as string;
    const upC = await uploadNew(areq, orgA.slug, "cmi5.zip", await cmi5Zip({ courseId: CMI5_ID, title: CMI5_TITLE }));
    expect(upC.ok(), `upload cmi5 → ${upC.status()}: ${await upC.text()}`).toBeTruthy();
    s.cmi5Course = (await upC.json()).courseId as string;
    const upK = await uploadNew(areq, orgA.slug, "forge.zip", await scormZip({ title: "QA Attempt Guard Forge Target" }));
    expect(upK.ok(), `upload forge target → ${upK.status()}: ${await upK.text()}`).toBeTruthy();
    const forgeCourse = (await upK.json()).courseId as string;

    const versionOf = async (courseId: string) =>
      ((await svc().from("courses").select("current_version_id").eq("id", courseId).single()).data as { current_version_id: string }).current_version_id;
    s.scormVersion = await versionOf(s.scormCourse);
    s.cmi5Version = await versionOf(s.cmi5Course);
    s.forgeVersion = await versionOf(forgeCourse);
    const { data: pkg } = await svc().from("course_packages").select("id").eq("course_id", s.cmi5Course).single();
    s.cmi5Package = (pkg as { id: string }).id;

    await assignCourse(areq, orgA.slug, s.scormCourse, learner.id);
    await assignCourse(areq, orgA.slug, s.cmi5Course, learner.id);

    s.learnerCtx = await authedContext(browser, baseURL!, learner.email, learner.password);
    for (const cid of [s.scormCourse, s.cmi5Course]) {
      const r = await s.learnerCtx.request.get(`/${orgA.slug}/courses/${cid}/launch`);
      expect(r.ok(), `launch ${cid} → ${r.status()}`).toBeTruthy();
    }
    s.scormAttempt = await inProgressAttempt(learner.id, s.scormVersion);
    s.cmi5Attempt = await inProgressAttempt(learner.id, s.cmi5Version);
    expect(await rowsFor(learner.id, s.forgeVersion), "the forge target was never launched").toHaveLength(0);

    s.learnerDb = await sessionClient(learner);
    s.adminDb = await sessionClient(admin);
  });

  test("(a) learner PATCH of own in-progress SCORM attempt to passed / completed / score 1", async () => {
    const b = await branch();
    test.skip(b === "skip", NEEDS_0099);
    const before = await row(s.scormAttempt!);
    expect(before?.status).toBe("in_progress");
    const forged = {
      status: "passed",
      completion_status: "completed",
      success_status: "passed",
      score: 1,
      completed_at: new Date().toISOString(),
      progress_pct: 100,
    };
    const res = await s.learnerDb!.from("course_attempts").update(forged).eq("id", s.scormAttempt!).select("id");
    const after = await row(s.scormAttempt!);
    const changed = !same(before, after);
    record({ case: "a", branch: b, http: res.status, code: res.error?.code ?? null, returned: res.data?.length ?? 0, changed, ids: { attempt: s.scormAttempt! } });
    if (b === "guard") {
      expect(Boolean(res.error) || (res.data ?? []).length === 0, "refused").toBe(true);
      expect(after, "row unchanged").toEqual(before);
    } else {
      expect(changed, "probe: the learner's session rewrote the row").toBe(true);
      expect(after).toMatchObject({ status: "passed", completion_status: "completed", success_status: "passed", score: 1, progress_pct: 100 });
    }
  });

  test("(b) learner PATCH of cmi_data alone on the same row", async () => {
    const b = await branch();
    test.skip(b === "skip", NEEDS_0099);
    const before = await row(s.scormAttempt!);
    const cmi = { "cmi.core.lesson_location": "forged", "cmi.suspend_data": "forged" };
    const res = await s.learnerDb!.from("course_attempts").update({ cmi_data: cmi }).eq("id", s.scormAttempt!).select("id");
    const after = await row(s.scormAttempt!);
    const changed = !same(before, after);
    record({ case: "b", branch: b, http: res.status, code: res.error?.code ?? null, returned: res.data?.length ?? 0, changed, ids: { attempt: s.scormAttempt! } });
    if (b === "guard") {
      expect(Boolean(res.error) || (res.data ?? []).length === 0, "refused").toBe(true);
      expect(after, "row unchanged").toEqual(before);
    } else {
      expect(changed, "probe: cmi_data rewritten").toBe(true);
      expect(after?.cmi_data).toEqual(cmi);
    }
  });

  test("(c) learner POST of a never-launched completed + passed row", async () => {
    const b = await branch();
    test.skip(b === "skip", NEEDS_0099);
    const before = await rowsFor(s.learner!.id, s.forgeVersion!);
    expect(before).toHaveLength(0);
    const now = new Date().toISOString();
    const res = await s.learnerDb!
      .from("course_attempts")
      .insert({
        course_version_id: s.forgeVersion!,
        user_id: s.learner!.id,
        organization_id: s.orgA!.id,
        status: "passed",
        completion_status: "completed",
        success_status: "passed",
        score: 1,
        progress_pct: 100,
        started_at: now,
        completed_at: now,
      })
      .select("id");
    const after = await rowsFor(s.learner!.id, s.forgeVersion!);
    record({ case: "c", branch: b, http: res.status, code: res.error?.code ?? null, returned: res.data?.length ?? 0, changed: after.length !== before.length, ids: { version: s.forgeVersion!, org: s.orgA!.id, ...(after[0] ? { attempt: String(after[0].id) } : {}) } });
    if (b === "guard") {
      expect(res.error, "refused").toBeTruthy();
      expect(after, "no row for this learner and version").toHaveLength(0);
    } else {
      expect(after, "probe: a forged completion exists").toHaveLength(1);
      expect(after[0]).toMatchObject({ status: "passed", success_status: "passed", completion_status: "completed" });
    }
  });

  test("(d) learner POST naming the other organisation's version and the learner's own organisation", async () => {
    const b = await branch();
    test.skip(b === "skip", NEEDS_0099);
    const before = await rowsFor(s.learner!.id, s.otherOrgVersion!);
    expect(before).toHaveLength(0);
    const res = await s.learnerDb!
      .from("course_attempts")
      .insert({
        course_version_id: s.otherOrgVersion!,
        user_id: s.learner!.id,
        organization_id: s.orgA!.id,
        status: "in_progress",
      })
      .select("id");
    const after = await rowsFor(s.learner!.id, s.otherOrgVersion!);
    record({ case: "d", branch: b, http: res.status, code: res.error?.code ?? null, returned: res.data?.length ?? 0, changed: after.length !== before.length, ids: { version: s.otherOrgVersion!, versionOrg: s.orgB!.id, rowOrg: s.orgA!.id, ...(after[0] ? { attempt: String(after[0].id) } : {}) } });
    if (b === "guard") {
      expect(res.error, "refused").toBeTruthy();
      expect(after, "no row on the other organisation's version").toHaveLength(0);
    } else {
      expect(after, "probe: a cross-organisation row exists").toHaveLength(1);
      expect(after[0]).toMatchObject({ organization_id: s.orgA!.id, course_version_id: s.otherOrgVersion! });
    }
  });

  test("(f) learner DELETE of the SCORM attempt → the row still exists", async () => {
    const b = await branch();
    test.skip(b === "skip", NEEDS_0099);
    const before = await row(s.scormAttempt!);
    const res = await s.learnerDb!.from("course_attempts").delete().eq("id", s.scormAttempt!).select("id");
    const after = await row(s.scormAttempt!);
    record({ case: "f", branch: b, http: res.status, code: res.error?.code ?? null, returned: res.data?.length ?? 0, changed: !same(before, after), ids: { attempt: s.scormAttempt! } });
    // Refused in both branches: there is no delete policy today, and 0099's
    // revoke keeps it so.
    expect(Boolean(res.error) || (res.data ?? []).length === 0, "refused").toBe(true);
    expect(after, "row still exists, unchanged").toEqual(before);
  });

  test("(g) admin-session PATCH of the learner's SCORM row", async () => {
    const b = await branch();
    test.skip(b === "skip", NEEDS_0099);
    const before = await row(s.scormAttempt!);
    const res = await s.adminDb!
      .from("course_attempts")
      .update({ status: "failed", success_status: "failed", score: 0.01 })
      .eq("id", s.scormAttempt!)
      .select("id");
    const after = await row(s.scormAttempt!);
    record({ case: "g", branch: b, http: res.status, code: res.error?.code ?? null, returned: res.data?.length ?? 0, changed: !same(before, after), ids: { attempt: s.scormAttempt!, actorRole: "admin" } });
    // Refused in both branches: the 0002 update policy is user_id = auth.uid().
    expect(Boolean(res.error) || (res.data ?? []).length === 0, "refused").toBe(true);
    expect(after, "row unchanged").toEqual(before);
  });

  test("(e, part 1) admin force-restart replace abandons the cmi5 attempt (app flow, every run)", async () => {
    const rep = await s.adminCtx!.request.post(`/api/courses/${s.cmi5Course}/packages/${s.cmi5Package}/versions`, {
      multipart: {
        orgSlug: s.orgA!.slug,
        mode: "force_restart",
        file: zipFile("cmi5-v2.zip", await cmi5Zip({ courseId: CMI5_ID, title: CMI5_TITLE, marker: "attempt-guard-v2" })),
      },
    });
    expect(rep.ok(), `replace → ${rep.status()}: ${await rep.text()}`).toBeTruthy();
    const j = await rep.json();
    expect(j.restarted).toBe(1);
    s.cmi5NewVersion = j.version_id as string;
    expect(s.cmi5NewVersion).not.toBe(s.cmi5Version);
    expect((await row(s.cmi5Attempt!))?.status).toBe("abandoned");
  });

  test("(h) the real paths still work: fresh cmi5 launch + statement, SCORM commit, own-row reads", async () => {
    const lreq = s.learnerCtx!.request;

    // A fresh cmi5 launch creates an in_progress row on the new version (the
    // launch page's server insert) ...
    const r = await lreq.get(`/${s.orgA!.slug}/courses/${s.cmi5Course}/launch`);
    expect(r.ok(), `launch → ${r.status()}`).toBeTruthy();
    const fresh = await inProgressAttempt(s.learner!.id, s.cmi5NewVersion!);
    expect(fresh).not.toBe(s.cmi5Attempt);
    // ... and a statement through /api/xapi/statements updates it (the xAPI
    // routes' service-client write).
    const auth = await authTokenFor(lreq, fresh);
    const st = await lreq.post("/api/xapi/statements", {
      headers: { ...XAPI_HEADERS, Authorization: auth },
      data: {
        actor: { objectType: "Agent", name: "qa-learner", account: { homePage: "https://qa.bot", name: s.learner!.id } },
        verb: { id: VERB("completed") },
        object: { objectType: "Activity", id: "https://qa.bot/cmi5/au1" },
        context: { registration: fresh },
        result: { completion: true },
      },
    });
    expect(st.status(), await st.text()).toBe(200);
    const freshRow = await row(fresh);
    expect(freshRow).toMatchObject({ completion_status: "completed", course_version_id: s.cmi5NewVersion });
    expect(freshRow?.last_activity_at).toBeTruthy();

    // The SCORM commit through the route on the attempt of (a): 200 and the
    // committed values land (independent of what a probe left on the row).
    const commit = await lreq.post(`/api/scorm/${s.scormAttempt}/commit`, {
      data: { cmi: { "cmi.core.lesson_status": "passed", "cmi.core.score.raw": "95", "cmi.core.lesson_location": "end" }, finished: true },
    });
    expect(commit.status(), await commit.text()).toBe(200);
    const sRow = await row(s.scormAttempt!);
    expect(sRow).toMatchObject({ status: "passed", success_status: "passed", completion_status: "completed", score: 0.95 });
    expect((sRow?.cmi_data as Record<string, string>)["cmi.core.lesson_location"]).toBe("end");

    // Reads stay on the select policy: the learner reads their own rows ...
    const { data: own, error: ownErr } = await s.learnerDb!.from("course_attempts").select("id, user_id");
    expect(ownErr).toBeNull();
    const ownRows = (own ?? []) as Array<{ id: string; user_id: string }>;
    expect(ownRows.every((x) => x.user_id === s.learner!.id), "only the learner's own rows").toBe(true);
    expect(ownRows.map((x) => x.id)).toEqual(expect.arrayContaining([s.scormAttempt, s.cmi5Attempt, fresh]));
    // ... and the admin reads the organisation's.
    const { data: adm, error: admErr } = await s.adminDb!.from("course_attempts").select("id").eq("user_id", s.learner!.id);
    expect(admErr).toBeNull();
    expect(((adm ?? []) as Array<{ id: string }>).map((x) => x.id)).toEqual(expect.arrayContaining([s.scormAttempt, s.cmi5Attempt, fresh]));
  });

  test("(e, part 2) learner PATCH {status: 'in_progress'} on the abandoned cmi5 attempt", async () => {
    const b = await branch();
    test.skip(b === "skip", NEEDS_0099);
    const before = await row(s.cmi5Attempt!);
    expect(before?.status).toBe("abandoned");
    const res = await s.learnerDb!.from("course_attempts").update({ status: "in_progress" }).eq("id", s.cmi5Attempt!).select("id");
    const after = await row(s.cmi5Attempt!);
    const changed = !same(before, after);
    record({ case: "e", branch: b, http: res.status, code: res.error?.code ?? null, returned: res.data?.length ?? 0, changed, ids: { attempt: s.cmi5Attempt!, version: s.cmi5Version! } });
    if (b === "guard") {
      expect(Boolean(res.error) || (res.data ?? []).length === 0, "refused").toBe(true);
      expect(after, "still abandoned, unchanged").toEqual(before);
    } else {
      expect(changed, "probe: the learner's session revived the abandoned attempt").toBe(true);
      expect(after?.status).toBe("in_progress");
    }
  });
});
