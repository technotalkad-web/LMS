/**
 * Layer 2 (writes) — real admin/learner write workflows.
 *
 * The crawler only does GET navigation and 10-journeys only checks form
 * validation; neither actually creates data. This spec exercises the real
 * write paths end-to-end as the seeded admin (and learner), then verifies the
 * row actually landed via the service-role client, and checks that a
 * low-privilege role is rejected from admin writes.
 *
 * Driven through the HTTP API rather than the UI forms on purpose: it exercises
 * the same server handlers the forms post to, but without selector fragility,
 * so a styling change can't turn a real backend regression into a false pass
 * (or a false finding). Everything created is tracked and deleted in afterAll;
 * the global-teardown org purge is the backstop.
 */

import { test, expect, type BrowserContext } from "@playwright/test";
import { authedContext } from "../lib/session";
import { record } from "../lib/findings";
import { readSeed, type SeedWorld } from "../lib/seed";
import { svc, rand } from "../../e2e/helpers/supabase";
import type { BotRole, Severity } from "../lib/types";

test.describe.configure({ timeout: 6 * 60_000 });

let seed: SeedWorld;
let adminCtx: BrowserContext;
let learnerCtx: BrowserContext;

// Track everything we create so we can delete it regardless of FK-cascade config.
const created = {
  teams: [] as string[],
  paths: [] as string[],
  announcements: [] as string[],
  tickets: [] as string[],
  assignments: [] as string[],
  courses: [] as string[],
  versions: [] as string[],
};

test.beforeAll(async ({ browser, baseURL }) => {
  seed = readSeed();
  adminCtx = await authedContext(browser, baseURL!, seed.admin.email, seed.admin.password);
  learnerCtx = await authedContext(browser, baseURL!, seed.learner.email, seed.learner.password);
});

test.afterAll(async () => {
  const s = svc();
  // Delete in dependency order (children first) — best-effort.
  for (const id of created.assignments) await s.from("course_assignments").delete().eq("id", id);
  for (const id of created.tickets) await s.from("help_tickets").delete().eq("id", id);
  for (const id of created.announcements) await s.from("org_announcements").delete().eq("id", id);
  for (const id of created.versions) await s.from("course_versions").delete().eq("id", id);
  for (const id of created.courses) await s.from("courses").delete().eq("id", id);
  for (const id of created.paths) await s.from("learning_paths").delete().eq("id", id);
  for (const id of created.teams) await s.from("teams").delete().eq("id", id); // cascades team_members
  await adminCtx?.close();
  await learnerCtx?.close();
});

/** Record a workflow finding and soft-fail (run continues; report is source of truth). */
async function flag(opts: {
  severity: Severity;
  title: string;
  detail: string;
  role: BotRole;
  url: string;
  area: string;
  repro: string[];
  meta?: Record<string, unknown>;
}): Promise<void> {
  await record({ category: "journey", ...opts });
  expect.soft(false, opts.title).toBeTruthy();
}

async function rowExists(table: string, id: string): Promise<boolean> {
  const { data } = await svc().from(table).select("id").eq("id", id).maybeSingle();
  return !!data;
}

// ---------------------------------------------------------------------------

test("admin write — create a team and add a member", async () => {
  const name = `QA Bot Team ${rand(5)}`;
  const res = await adminCtx.request.post("/api/teams", {
    failOnStatusCode: false,
    data: { orgSlug: seed.org.slug, name },
  });
  if (!res.ok()) {
    await flag({
      severity: "high",
      title: `Create team failed (${res.status()})`,
      detail: `POST /api/teams as admin returned ${res.status()}: ${(await res.text()).slice(0, 200)}`,
      role: "admin",
      url: "/api/teams",
      area: "admin/teams",
      repro: ["Sign in as admin", "Open Teams → New team", `Submit name "${name}"`],
      meta: { status: res.status() },
    });
    return;
  }
  const teamId = (await res.json())?.team?.id as string | undefined;
  if (!teamId) {
    await flag({
      severity: "high",
      title: "Create team returned no id",
      detail: "POST /api/teams returned 200 but no team.id in the body.",
      role: "admin",
      url: "/api/teams",
      area: "admin/teams",
      repro: ["Sign in as admin", "Create a team", "Inspect the response body"],
    });
    return;
  }
  created.teams.push(teamId);
  // Persistence check.
  if (!(await rowExists("teams", teamId))) {
    await flag({
      severity: "high",
      title: "Created team not persisted",
      detail: `teams row ${teamId} was not found after a 200 create.`,
      role: "admin",
      url: "/api/teams",
      area: "admin/teams",
      repro: ["Sign in as admin", "Create a team", "Confirm it persists in the DB"],
    });
    return;
  }

  // Add the seeded learner to the team.
  const addRes = await adminCtx.request.post(`/api/teams/${teamId}/members`, {
    failOnStatusCode: false,
    data: { userIds: [seed.learner.id] },
  });
  if (!addRes.ok()) {
    await flag({
      severity: "high",
      title: `Add team member failed (${addRes.status()})`,
      detail: `POST /api/teams/{id}/members returned ${addRes.status()}.`,
      role: "admin",
      url: `/api/teams/${teamId}/members`,
      area: "admin/teams",
      repro: ["Sign in as admin", "Open a team", "Add a learner to it"],
      meta: { status: addRes.status() },
    });
    return;
  }
  const { data: member } = await svc()
    .from("team_members")
    .select("user_id")
    .eq("team_id", teamId)
    .eq("user_id", seed.learner.id)
    .maybeSingle();
  if (!member) {
    await flag({
      severity: "high",
      title: "Team member not persisted",
      detail: "team_members row missing after a 200 add-member.",
      role: "admin",
      url: `/api/teams/${teamId}/members`,
      area: "admin/teams",
      repro: ["Sign in as admin", "Add a member to a team", "Confirm it persists"],
    });
  }
});

test("admin write — create a learning path", async () => {
  const name = `QA Bot Path ${rand(5)}`;
  const res = await adminCtx.request.post("/api/learning-paths", {
    failOnStatusCode: false,
    data: { orgSlug: seed.org.slug, name, description: "Created by the testing bot." },
  });
  if (!res.ok()) {
    await flag({
      severity: "high",
      title: `Create learning path failed (${res.status()})`,
      detail: `POST /api/learning-paths returned ${res.status()}: ${(await res.text()).slice(0, 200)}`,
      role: "admin",
      url: "/api/learning-paths",
      area: "admin/learning-paths",
      repro: ["Sign in as admin", "Open Learning paths → New", `Submit "${name}"`],
      meta: { status: res.status() },
    });
    return;
  }
  const pathId = (await res.json())?.path?.id as string | undefined;
  if (pathId) created.paths.push(pathId);
  if (!pathId || !(await rowExists("learning_paths", pathId))) {
    await flag({
      severity: "high",
      title: "Created learning path not persisted",
      detail: `learning_paths row missing after a 200 create (id=${pathId ?? "none"}).`,
      role: "admin",
      url: "/api/learning-paths",
      area: "admin/learning-paths",
      repro: ["Sign in as admin", "Create a learning path", "Confirm it persists"],
    });
  }
});

test("admin write — create an announcement", async () => {
  const title = `QA Bot Announcement ${rand(5)}`;
  const res = await adminCtx.request.post("/api/announcements", {
    failOnStatusCode: false,
    data: { orgSlug: seed.org.slug, title, body: "Bot test announcement.", tone: "info" },
  });
  if (!res.ok()) {
    await flag({
      severity: "high",
      title: `Create announcement failed (${res.status()})`,
      detail: `POST /api/announcements returned ${res.status()}: ${(await res.text()).slice(0, 200)}`,
      role: "admin",
      url: "/api/announcements",
      area: "admin/announcements",
      repro: ["Sign in as admin", "Open Announcements → New", `Submit "${title}"`],
      meta: { status: res.status() },
    });
    return;
  }
  const id = (await res.json())?.id as string | undefined;
  if (id) created.announcements.push(id);
  if (!id || !(await rowExists("org_announcements", id))) {
    await flag({
      severity: "high",
      title: "Created announcement not persisted",
      detail: `org_announcements row missing after a 200 create (id=${id ?? "none"}).`,
      role: "admin",
      url: "/api/announcements",
      area: "admin/announcements",
      repro: ["Sign in as admin", "Create an announcement", "Confirm it persists"],
    });
  }
});

test("learner write — file a support ticket", async () => {
  const subject = `QA Bot Ticket ${rand(5)}`;
  const res = await learnerCtx.request.post("/api/tickets", {
    failOnStatusCode: false,
    data: { orgSlug: seed.org.slug, subject, body: "Bot-filed ticket.", priority: "low" },
  });
  if (!res.ok()) {
    await flag({
      severity: "high",
      title: `File ticket failed (${res.status()})`,
      detail: `POST /api/tickets as learner returned ${res.status()}: ${(await res.text()).slice(0, 200)}`,
      role: "learner",
      url: "/api/tickets",
      area: "learner/support",
      repro: ["Sign in as learner", "Open Help & Support", `Submit a ticket "${subject}"`],
      meta: { status: res.status() },
    });
    return;
  }
  const id = (await res.json())?.id as string | undefined;
  if (id) created.tickets.push(id);
  if (!id || !(await rowExists("help_tickets", id))) {
    await flag({
      severity: "high",
      title: "Filed ticket not persisted",
      detail: `help_tickets row missing after a 200 create (id=${id ?? "none"}).`,
      role: "learner",
      url: "/api/tickets",
      area: "learner/support",
      repro: ["Sign in as learner", "File a support ticket", "Confirm it persists"],
    });
  }
});

test("admin write — assign a course to the org", async () => {
  // Seed a minimal course (+version) directly; the bot doesn't upload SCORM.
  // If the insert fails (schema drift), record an info note and skip rather
  // than emit a false failure for the assignment flow.
  const orgId = seed.org.id;
  const slug = `qa-bot-course-${rand(5)}`;
  const { data: course, error: cErr } = await svc()
    .from("courses")
    .insert({ organization_id: orgId, slug, title: "QA Bot Course", status: "published" })
    .select("id")
    .single();
  if (cErr || !course) {
    await flag({
      severity: "info",
      title: "Skipped course-assignment workflow (could not seed a course)",
      detail: `Direct courses insert failed: ${cErr?.message ?? "no row"}. Assignment coverage skipped — seed schema may have drifted.`,
      role: "admin",
      url: "/api/assignments",
      area: "admin/assignments",
      repro: ["(bot) seed a minimal course row via service role"],
    });
    return;
  }
  created.courses.push(course.id);
  const { data: ver } = await svc()
    .from("course_versions")
    .insert({
      course_id: course.id,
      version_number: 1,
      manifest_type: "scorm12",
      launch_url: "index.html",
      storage_prefix: `courses/${course.id}/v1/`,
      manifest_data: {},
    })
    .select("id")
    .single();
  if (ver) {
    created.versions.push(ver.id);
    await svc().from("courses").update({ current_version_id: ver.id }).eq("id", course.id);
  }

  const res = await adminCtx.request.post("/api/assignments", {
    failOnStatusCode: false,
    data: { orgSlug: seed.org.slug, courseId: course.id, assignToOrg: true },
  });
  if (!res.ok()) {
    await flag({
      severity: "high",
      title: `Assign course failed (${res.status()})`,
      detail: `POST /api/assignments returned ${res.status()}: ${(await res.text()).slice(0, 200)}`,
      role: "admin",
      url: "/api/assignments",
      area: "admin/assignments",
      repro: ["Sign in as admin", "Open a course", "Assign it to the whole org"],
      meta: { status: res.status() },
    });
    return;
  }
  const assigned = (await res.json())?.assigned as number | undefined;
  // Track the created assignment row for cleanup.
  const { data: arow } = await svc()
    .from("course_assignments")
    .select("id")
    .eq("course_id", course.id)
    .eq("assignee_type", "org")
    .maybeSingle();
  if (arow?.id) created.assignments.push(arow.id);
  if (!assigned || assigned < 1 || !arow) {
    await flag({
      severity: "high",
      title: "Course assignment not persisted",
      detail: `assigned=${assigned}; course_assignments org row ${arow ? "found" : "missing"}.`,
      role: "admin",
      url: "/api/assignments",
      area: "admin/assignments",
      repro: ["Sign in as admin", "Assign a course org-wide", "Confirm the assignment persists"],
    });
  }
});

// ---------------------------------------------------------------------------
// RBAC: a learner must not be able to drive admin writes.
// ---------------------------------------------------------------------------

const learnerForbiddenWrites: Array<{ path: string; data: Record<string, unknown>; what: string }> = [
  { path: "/api/teams", data: { name: "Hacky Team" }, what: "create team" },
  { path: "/api/learning-paths", data: { name: "Hacky Path" }, what: "create learning path" },
  { path: "/api/announcements", data: { title: "Hacky Announcement", tone: "info" }, what: "create announcement" },
];

test("learner write — admin-only writes are rejected (RBAC)", async () => {
  for (const probe of learnerForbiddenWrites) {
    const res = await learnerCtx.request.post(probe.path, {
      failOnStatusCode: false,
      maxRedirects: 0,
      data: { orgSlug: seed.org.slug, ...probe.data },
    });
    const blocked = [400, 401, 403, 404].includes(res.status());
    if (!blocked) {
      await flag({
        severity: "critical",
        title: `Learner could ${probe.what} (${res.status()})`,
        detail: `A learner POST to ${probe.path} returned ${res.status()} instead of being rejected.`,
        role: "learner",
        url: probe.path,
        area: "access-control",
        repro: [
          "Sign in as a learner",
          `POST ${probe.path} with a valid payload`,
          `Observe HTTP ${res.status()} instead of 403`,
        ],
        meta: { status: res.status() },
      });
      // If it leaked through, best-effort track for cleanup.
      try {
        const body = await res.json();
        const id = body?.team?.id ?? body?.path?.id ?? body?.id;
        if (id && probe.path.includes("teams")) created.teams.push(id);
        else if (id && probe.path.includes("learning-paths")) created.paths.push(id);
        else if (id && probe.path.includes("announcements")) created.announcements.push(id);
      } catch {
        /* ignore */
      }
    }
    expect.soft([400, 401, 403, 404], `learner ${probe.what}`).toContain(res.status());
  }
});
