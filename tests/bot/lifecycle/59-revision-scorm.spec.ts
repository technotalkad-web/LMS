/**
 * ADR 0014 (PR 1a) on staging: the SCORM revision visit, end to end
 * (step 17's "new SCORM lifecycle spec").
 *
 *   - completed_at on a non-revision row: a mid-way LMSFinish no longer
 *     stamps it; the completing commit stamps it once; the completing
 *     session's final LMSFinish leaves it alone (step 4);
 *   - the revisit opens a revision visit's row (is_revision), served in
 *     review / no-credit, rebuilt from the official attempt alone, with the
 *     "Revision" badge (data-testid kept) and one revision_visits
 *     row (step 3);
 *   - a commit on the flagged row derives nothing: status, completion,
 *     success, score, completed_at unchanged, the official attempt unchanged,
 *     no streak day (step 4, R-5);
 *   - the second revisit resumes the same row and re-seeds it from the
 *     official attempt, and records a second visit (10 s dedupe apart);
 *   - cross-language: a revisit in the other language slot is seeded from
 *     the official attempt on the first slot; the flagged row on the first
 *     slot is neither counted nor abandoned by a language switch (step 3).
 *
 * Needs 0103 on the target database: the probe FAILS the spec without it
 * (the deploy order applies 0103 before PR 1a's code). By hand on staging,
 * never while another harness runs (docs/ARCHITECTURE.md §9).
 */
import { test, expect, type APIRequestContext, type BrowserContext } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { addMember, createAuthUser, createOrg, svc } from "./data";
import { assignCourse, authedContext, uploadCourse } from "./helpers";

const FIXTURES = path.resolve(__dirname, "../fixtures");
type User = { id: string; email: string; password: string };

async function requires0103(): Promise<void> {
  const { error } = await svc().from("revision_visits").select("id").limit(1);
  if (error) throw new Error(`0103 is not applied on this database (a real select of revision_visits failed: ${error.code ?? ""} ${error.message})`);
}

/** Course with an English (promoted legacy) and a Hindi package of scorm12.zip (spec 48's shape). */
async function bilingualScorm(adminReq: APIRequestContext, orgSlug: string) {
  const zip = "scorm12.zip";
  const course = await uploadCourse(adminReq, orgSlug, zip);
  const { data: pkgs } = await svc().from("course_packages").select("id").eq("course_id", course.courseId);
  const enPkg = (pkgs ?? [])[0].id as string;
  const promote = await adminReq.patch(`/api/courses/${course.courseId}/packages/${enPkg}`, {
    data: { orgSlug, language: "en", display_name: "English" },
  });
  expect(promote.ok(), `promote → ${promote.status()}: ${await promote.text()}`).toBeTruthy();
  const addHi = await adminReq.post(`/api/courses/${course.courseId}/packages`, {
    multipart: {
      orgSlug,
      language: "hi",
      display_name: "Hindi",
      file: { name: zip, mimeType: "application/zip", buffer: fs.readFileSync(path.join(FIXTURES, zip)) },
    },
  });
  expect(addHi.ok(), `add hi → ${addHi.status()}: ${await addHi.text()}`).toBeTruthy();
  const { data: hi } = await svc().from("course_packages").select("current_version_id").eq("course_id", course.courseId).eq("language", "hi").single();
  return { courseId: course.courseId, enVersionId: course.versionId, hiVersionId: (hi as { current_version_id: string }).current_version_id };
}

type Row = {
  id: string;
  status: string;
  completion_status: string;
  success_status: string;
  score: number | null;
  completed_at: string | null;
  progress_pct?: number | null;
  is_revision?: boolean;
  cmi_data: Record<string, string>;
};
async function rowsOn(userId: string, versionId: string): Promise<Row[]> {
  const { data } = await svc().from("course_attempts").select("*").eq("user_id", userId).eq("course_version_id", versionId).order("started_at");
  return (data ?? []) as Row[];
}
async function row(id: string): Promise<Row> {
  const { data } = await svc().from("course_attempts").select("*").eq("id", id).single();
  return data as Row;
}
async function visits(userId: string, courseId: string) {
  const { data } = await svc().from("revision_visits").select("attempt_id, launch_kind, course_version_id").eq("user_id", userId).eq("course_id", courseId).order("launched_at");
  return (data ?? []) as Array<{ attempt_id: string; launch_kind: string; course_version_id: string }>;
}
async function streak(orgId: string, userId: string) {
  const { data } = await svc().from("user_gamification").select("current_streak_days, last_active_day, total_xp").eq("organization_id", orgId).eq("user_id", userId).maybeSingle();
  return data;
}
/** The served SCORM cmi carries a key/value (the RSC payload escapes quotes). */
const servesKey = (html: string, key: string, value: string) =>
  new RegExp(`${key.replace(/\./g, "\\.")}\\\\?"\\s*:\\s*\\\\?"${value}`).test(html);

const OFFICIAL_CMI = {
  "cmi.core.lesson_status": "passed",
  "cmi.core.score.raw": "80",
  "cmi.core.score.min": "0",
  "cmi.core.score.max": "100",
  "cmi.suspend_data": "official-bookmark",
  "cmi.core.lesson_location": "page-5",
};

test.describe.serial("ADR 0014 — the SCORM revision visit (PR 1a)", () => {
  const s: {
    org?: { id: string; slug: string };
    adminCtx?: BrowserContext;
    learnerCtx?: BrowserContext;
    learner?: User;
    course?: Awaited<ReturnType<typeof bilingualScorm>>;
    official?: string;
    officialCompletedAt?: string;
    revision?: string;
  } = {};

  test.beforeAll(async () => {
    await requires0103();
  });
  test.afterAll(async () => {
    await s.learnerCtx?.close().catch(() => {});
    await s.adminCtx?.close().catch(() => {});
  });

  test("seed: a bilingual SCORM course and a learner", async ({ browser, baseURL }) => {
    const org = await createOrg({ name: "Lifecycle Revision SCORM" });
    const admin = await createAuthUser({ profile: { first_name: "Rev", last_name: "Admin", must_change_password: false } });
    await addMember({ organizationId: org.id, userId: admin.id, role: "admin" });
    s.org = org;
    s.adminCtx = await authedContext(browser, baseURL!, admin.email, admin.password);
    s.course = await bilingualScorm(s.adminCtx.request, org.slug);
    const learner = await createAuthUser({ profile: { first_name: "Rev", last_name: "Learner", must_change_password: false } });
    await addMember({ organizationId: org.id, userId: learner.id, role: "member" });
    await assignCourse(s.adminCtx.request, org.slug, s.course.courseId, learner.id);
    s.learner = learner;
    s.learnerCtx = await authedContext(browser, baseURL!, learner.email, learner.password);
  });

  test("the official attempt: a mid-way LMSFinish stamps no completed_at; the completing commit stamps it once", async () => {
    const req = s.learnerCtx!.request;
    const launch = await req.get(`/${s.org!.slug}/courses/${s.course!.courseId}/launch?lang=en`);
    expect(launch.ok(), `launch → ${launch.status()}`).toBeTruthy();
    const [a1] = await rowsOn(s.learner!.id, s.course!.enVersionId);
    expect(a1?.is_revision ?? false, "the first launch is official").toBe(false);
    s.official = a1.id;

    const midway = await req.post(`/api/scorm/${a1.id}/commit`, {
      data: { cmi: { "cmi.core.lesson_status": "incomplete", "cmi.core.lesson_location": "page-2" }, finished: true },
    });
    expect(midway.status(), await midway.text()).toBe(200);
    expect((await row(a1.id)).completed_at, "a mid-way LMSFinish leaves completed_at empty").toBeNull();

    const completing = await req.post(`/api/scorm/${a1.id}/commit`, { data: { cmi: OFFICIAL_CMI, finished: false } });
    expect(completing.status(), await completing.text()).toBe(200);
    const done = await row(a1.id);
    expect([done.status, done.success_status, done.score]).toEqual(["passed", "passed", 0.8]);
    expect(done.completed_at, "the completing commit stamps completed_at").not.toBeNull();
    s.officialCompletedAt = done.completed_at!;

    const finish = await req.post(`/api/scorm/${a1.id}/commit`, { data: { cmi: OFFICIAL_CMI, finished: true } });
    expect(finish.status(), await finish.text()).toBe(200);
    expect((await row(a1.id)).completed_at, "the final LMSFinish leaves the stamp alone").toBe(s.officialCompletedAt);
  });

  test("the revisit: a flagged row, review / no-credit, rebuilt from the official attempt, one visit", async () => {
    const res = await s.learnerCtx!.request.get(`/${s.org!.slug}/courses/${s.course!.courseId}/launch?lang=en`);
    expect(res.ok(), `revisit → ${res.status()}`).toBeTruthy();
    const html = await res.text();
    const rows = await rowsOn(s.learner!.id, s.course!.enVersionId);
    const rev = rows.find((r) => r.id !== s.official)!;
    expect(rev, "a second row on the version").toBeTruthy();
    expect([rev.is_revision, rev.status]).toEqual([true, "in_progress"]);
    s.revision = rev.id;
    expect(rev.cmi_data, "rebuilt from the official attempt alone").toEqual({
      "cmi.suspend_data": "official-bookmark",
      "cmi.core.lesson_location": "page-5",
      "cmi.core.lesson_status": "passed",
      "cmi.core.score.raw": "80",
      "cmi.core.score.min": "0",
      "cmi.core.score.max": "100",
      "cmi.core.entry": "resume",
      "cmi.core.lesson_mode": "review",
      "cmi.core.credit": "no-credit",
    });
    expect([servesKey(html, "cmi.core.lesson_mode", "review"), servesKey(html, "cmi.core.credit", "no-credit")], "served in review / no-credit").toEqual([true, true]);
    expect(html.includes('data-testid="practice-badge"'), "the Revision badge (test id kept)").toBe(true);
    expect(await visits(s.learner!.id, s.course!.courseId)).toEqual([
      { attempt_id: rev.id, launch_kind: "scorm12", course_version_id: s.course!.enVersionId },
    ]);
  });

  test("a commit on the flagged row derives nothing and moves no streak", async () => {
    const before = await row(s.revision!);
    const officialBefore = await row(s.official!);
    const streakBefore = await streak(s.org!.id, s.learner!.id);
    const res = await s.learnerCtx!.request.post(`/api/scorm/${s.revision}/commit`, {
      data: {
        cmi: { "cmi.core.lesson_status": "failed", "cmi.core.score.raw": "20", "cmi.suspend_data": "revisit-state", "cmi.core.lesson_location": "page-9" },
        finished: true,
      },
    });
    expect(res.status(), await res.text()).toBe(200);
    const after = await row(s.revision!);
    expect(
      [after.status, after.completion_status, after.success_status, after.score, after.completed_at, after.progress_pct ?? null],
      "status, completion, success, score, completed_at and progress unchanged"
    ).toEqual([before.status, before.completion_status, before.success_status, before.score, before.completed_at, before.progress_pct ?? null]);
    expect(after.cmi_data["cmi.suspend_data"], "the SCO's own map is stored").toBe("revisit-state");
    expect(await row(s.official!), "the official attempt is untouched").toEqual(officialBefore);
    expect(await streak(s.org!.id, s.learner!.id), "no streak day, no XP").toEqual(streakBefore);
  });

  test("the second revisit resumes the same row, re-seeds it from the official attempt, and counts a second visit", async () => {
    await new Promise((r) => setTimeout(r, 11_000)); // past record_revision_visit's 10 s dedupe
    const res = await s.learnerCtx!.request.get(`/${s.org!.slug}/courses/${s.course!.courseId}/launch?lang=en`);
    expect(res.ok(), `second revisit → ${res.status()}`).toBeTruthy();
    const rows = await rowsOn(s.learner!.id, s.course!.enVersionId);
    expect(rows.map((r) => r.id).sort(), "no new row: the flagged row resumes").toEqual([s.official!, s.revision!].sort());
    const again = await row(s.revision!);
    expect([again.cmi_data["cmi.suspend_data"], again.cmi_data["cmi.core.lesson_location"]], "re-seeded from the official attempt").toEqual(["official-bookmark", "page-5"]);
    expect((await visits(s.learner!.id, s.course!.courseId)).map((v) => v.attempt_id)).toEqual([s.revision!, s.revision!]);
  });

  test("cross-language: the other slot's revisit is seeded from the official attempt; the flagged row survives a switch", async () => {
    const req = s.learnerCtx!.request;
    // The flagged English row is neither counted nor abandoned by a switch.
    const sw = await req.put(`/api/courses/${s.course!.courseId}/language-preference`, {
      data: { orgSlug: s.org!.slug, language: "hi", restart_if_in_progress: false },
    });
    expect(sw.status(), `switch → ${sw.status()}: ${await sw.text()}`).toBe(200);
    expect(await sw.json()).toMatchObject({ ok: true, abandoned: 0 });
    expect((await row(s.revision!)).status, "the English revision row stays open").toBe("in_progress");

    await new Promise((r) => setTimeout(r, 11_000));
    const res = await req.get(`/${s.org!.slug}/courses/${s.course!.courseId}/launch?lang=hi`);
    expect(res.ok(), `hi revisit → ${res.status()}`).toBeTruthy();
    const [hiRow] = await rowsOn(s.learner!.id, s.course!.hiVersionId);
    expect(hiRow?.is_revision, "the Hindi launch is a revision visit (the official result is on English)").toBe(true);
    expect([hiRow.cmi_data["cmi.suspend_data"], hiRow.cmi_data["cmi.core.lesson_mode"]], "seeded from the English official attempt").toEqual(["official-bookmark", "review"]);
    const v = await visits(s.learner!.id, s.course!.courseId);
    expect(v[v.length - 1]).toEqual({ attempt_id: hiRow.id, launch_kind: "scorm12", course_version_id: s.course!.hiVersionId });
  });
});
