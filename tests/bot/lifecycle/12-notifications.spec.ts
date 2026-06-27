/**
 * PHASE 4 — transactional notification emails (real Gmail delivery).
 *
 * Covers the emails the app sends synchronously through the ORG SMTP relay:
 *   - asset_assignment  ("New course assigned: …")  on admin assign
 *   - asset_completion  ("Nice work! You completed …") when the learner passes
 *   - asset_unassignment ("Removed from …") on admin unassign
 *
 * Reminders/due-date/expiry are driven by the cron endpoint (/api/cron/reminders)
 * and need CRON_SECRET + course_reminder_settings — tracked separately.
 */
import { test, expect } from "@playwright/test";
import { addMember, createAuthUser, createOrg, rand, svc } from "../../e2e/helpers/supabase";
import { authedContext } from "../lib/session";
import { aliasFor, configureOrgSmtp, waitForEmail } from "./inbox";
import { courseHandle, latestAttemptId, launch, scormCommit, uploadCourse } from "./helpers";

const TAG = `nf${rand(4)}`;

const state: {
  org?: { id: string; name: string; slug: string };
  admin?: { id: string; email: string; password: string };
  learner?: { id: string; email: string; password: string };
  learnerEmail?: string;
  course?: Awaited<ReturnType<typeof courseHandle>>;
} = {};

test.describe.serial("Phase 4 — notification emails", () => {
  test("seed org + admin + learner, configure SMTP, upload course", async ({ browser, baseURL }) => {
    const org = await createOrg({ name: "QA Notify Org" });
    const admin = await createAuthUser({
      profile: { first_name: "Ntfy", last_name: "Admin", must_change_password: false },
    });
    await addMember({ organizationId: org.id, userId: admin.id, role: "admin" });
    await configureOrgSmtp(org.id);

    // Learner with a real inbox alias + known password (so they can launch).
    const learnerEmail = aliasFor(`${TAG}l1`);
    const learner = await createAuthUser({
      email: learnerEmail,
      profile: { first_name: "Ntfy", last_name: "Learner", must_change_password: false },
    });
    await addMember({ organizationId: org.id, userId: learner.id, role: "member" });

    const ctx = await authedContext(browser, baseURL!, admin.email, admin.password);
    state.course = await uploadCourse(ctx.request, org.slug, "scorm12.zip");
    await ctx.close();

    state.org = org;
    state.admin = admin;
    state.learner = learner;
    state.learnerEmail = learnerEmail;
    console.log(`[notify] org=${org.slug} learner=${learnerEmail}`);
  });

  test("assignment email is delivered", async ({ browser, baseURL }) => {
    const since = new Date(Date.now() - 5 * 60_000);
    const ctx = await authedContext(browser, baseURL!, state.admin!.email, state.admin!.password);
    const res = await ctx.request.post("/api/assignments", {
      data: { orgSlug: state.org!.slug, courseId: state.course!.courseId, userIds: [state.learner!.id] },
    });
    expect(res.ok(), `assign → ${res.status()}: ${await res.text()}`).toBeTruthy();
    await ctx.close();

    const mail = await waitForEmail({
      recipient: state.learnerEmail!,
      subjectIncludes: "New course assigned",
      since,
      timeoutMs: 150_000,
    });
    expect(`${mail.text}\n${mail.html}`).toContain("QA Bot SCORM 1.2 Course");
    console.log(`[notify] ✓ assignment email: "${mail.subject}"`);
  });

  test("completion email is delivered when the learner passes", async ({ browser, baseURL }) => {
    const since = new Date(Date.now() - 5 * 60_000);
    const ctx = await authedContext(browser, baseURL!, state.learner!.email, state.learner!.password);
    await launch(ctx.request, state.org!.slug, state.course!.courseId);
    const attemptId = await latestAttemptId(state.course!.versionId, state.learner!.id);
    await scormCommit(
      ctx.request,
      attemptId,
      { "cmi.core.lesson_status": "passed", "cmi.core.score.raw": "95" },
      true
    );
    await ctx.close();

    const mail = await waitForEmail({
      recipient: state.learnerEmail!,
      subjectIncludes: "completed",
      since,
      timeoutMs: 150_000,
    });
    expect(`${mail.text}\n${mail.html}`).toContain("QA Bot SCORM 1.2 Course");
    console.log(`[notify] ✓ completion email: "${mail.subject}"`);
  });

  test("unassignment email is delivered", async ({ browser, baseURL }) => {
    const since = new Date(Date.now() - 5 * 60_000);
    // Find the assignment row to delete via the API.
    const { data: rows } = await svc()
      .from("course_assignments")
      .select("id")
      .eq("organization_id", state.org!.id)
      .eq("user_id", state.learner!.id)
      .eq("course_id", state.course!.courseId)
      .limit(1);
    const assignmentId = (rows ?? [])[0]?.id as string | undefined;
    expect(assignmentId, "an assignment row should exist to unassign").toBeTruthy();

    const ctx = await authedContext(browser, baseURL!, state.admin!.email, state.admin!.password);
    const res = await ctx.request.delete(`/api/assignments/${assignmentId}?orgSlug=${state.org!.slug}`);
    expect(res.ok(), `unassign → ${res.status()}: ${await res.text()}`).toBeTruthy();
    await ctx.close();

    const mail = await waitForEmail({
      recipient: state.learnerEmail!,
      subjectIncludes: "Removed from",
      since,
      timeoutMs: 150_000,
    });
    expect(`${mail.text}\n${mail.html}`).toContain("QA Bot SCORM 1.2 Course");
    console.log(`[notify] ✓ unassignment email: "${mail.subject}"`);
  });
});
