/**
 * ADR 0020 on staging (step 10): course enrolment counts every assignment that
 * reaches a learner, direct, team, org-wide, Custom Group and released Learning
 * Path step, minus the learners a path still holds back, from one SQL view
 * (migration 0105), and every admin surface agrees with it.
 *
 * The fixture is the rehearsal's (scripts/migration-rehearsal/seed-0105.sql),
 * seeded through the service role in a lifecycle-* organisation: learners L1 to
 * L14 (L13 inactive; L12 and L13 in the Retail vertical; L6 joined 10 days ago
 * and L11 60 days ago), teams T1 {L7, L8} and T2 {L6, L11}, groups G1 static
 * {L9, L10}, G2 dynamic Retail, G3 dynamic team T2 joined within 30 days, G4 the
 * system group of the Retail vertical (system_key 'scope:Retail|'), G5 static
 * and inactive {L14}; courses C1 to C6 (SCORM uploads); paths P1 (C1, then C3
 * released tomorrow), P2 (C1, C2, C3), P3 inactive (C4), P4 org_public with no
 * assignment (C6 released tomorrow); assignments: L3, L4, L5 and G1 on P1; L5,
 * L6 and T1 on P2; L11 on P3; L1 on C5 and C6; L2 on C5 released tomorrow; L4
 * on C1 and C3; G4 on C5; G3 on C5 released tomorrow; G5 on C5.
 *
 *   1. the view's set per course (service role) equals the rehearsal's:
 *      C1 {L3-L10}, C2 {L5-L8}, C3 {L6, L7, L8}, C4 {}, C5 {L1, L12}, C6 {};
 *      P1's path set includes G1's learners;
 *   2. the TypeScript and SQL twins of the group resolver agree:
 *      resolveManyGroups equals v_group_members_expanded for G1-G4, and the
 *      inactive G5 is in neither;
 *   3. as the org admin, the Library course page and the Reports page show
 *      "Total enrolled" equal to the view's count for C1, C2, C3 and C5; the
 *      learners table lists exactly the view's set, with via Path, Group and
 *      Direct where expected; the CSV has the same rows and its "Enrolled via"
 *      column prints group and path;
 *   4. the Library list shows the view's per-course counts, as the org admin
 *      and as a data_analyst;
 *   5. refresh_report_views() through the service role, then both course
 *      matviews' total_enrolled equal the view's counts;
 *   6. the CRM progress feed lists the view's course set for every learner
 *      except where owner decision 2 keeps the feed as it is (every step of
 *      an assigned active path, no hold-back): the P1 learners, for whom the
 *      feed lists C3 (an unreleased step), and L1, for whom it lists C6 (held
 *      back by the org_public P4); both differences are asserted explicitly;
 *   7. Organisation Reports does not move: with L1's completed official
 *      attempt on C5, Total users, Completions, Pass rate and Completion rate
 *      read the same before and after P2 is assigned to L1;
 *   8. the launch page agrees with the view on C3 (run after 7: a 200 launch
 *      creates an attempt row): L4's and L5's launch with ?lp=P1 redirect to
 *      dashboard?upcoming=, L6's with ?lp=P2 answers 200; P1's step moved into
 *      the past, C3 holds every P1 and P2 learner and L4's launch answers 200.
 *      The paths are seeded with sequence_mode random, so the strict prereq
 *      lock (earlier steps not completed) never answers instead of the gate;
 *      the view reads no sequence_mode, and the hold-back runs in any mode;
 *   9. P4's step moved into the past: C6 = {L1}; G3's row on C5 moved into the
 *      past: C5 gains L6 (team 2, joined 10 days ago) and not L11.
 *
 * A separate block, "staging note", records one real path-taught course's
 * Reports §4.1 and §4.2 counts for the staging note (counts only): run it with
 * ENROLMENT_NOTE_COURSE=<course id> before the paste and after the first
 * refresh; without the variable it is not registered at all (no skip in the
 * nightly), and it needs no 0105.
 *
 * Needs 0105 on the database: the probe FAILS the fixture block without it.
 * By hand on staging after the paste, never while another lifecycle run is in
 * progress; then added to the nightly subset. Also re-run: specs 54 and 61
 * (admin pages), and `npm run test:unit`. Data stays in the lifecycle-*
 * namespace.
 */
import { test, expect, type APIResponse, type BrowserContext } from "@playwright/test";
import { addMember, createAuthUser, createOrg, rand, svc } from "./data";
import { authedContext, courseHandle, latestAttemptId, scormCommit, type CourseHandle } from "./helpers";
import { scormZip, uploadNew } from "./p0-helpers";
import { resolveManyGroups } from "../../../lib/org/groups";

type User = { id: string; email: string; password: string };
const L = (n: number) => `L${n}`;
const sorted = (xs: Iterable<string>) => [...xs].sort();

async function requires0105(): Promise<void> {
  const { error } = await svc().from("v_group_members_expanded").select("user_id").limit(1);
  if (error) throw new Error(`0105 is not applied on this database (a real select of v_group_members_expanded failed: ${error.code ?? ""} ${error.message})`);
}

/** The UTC date N days ago, as the group resolver compares date_of_joining. */
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const inOneDay = () => new Date(Date.now() + 86_400_000).toISOString();
const aMinuteAgo = () => new Date(Date.now() - 60_000).toISOString();

function csvRows(text: string): string[][] {
  const out: string[][] = [];
  for (const line of text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.length > 0)) {
    const cells: string[] = [];
    let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ",") { cells.push(cur); cur = ""; } else cur += ch;
    }
    cells.push(cur);
    out.push(cells);
  }
  return out;
}

/** Spec 54's form: a 3xx to exactly `target`, or the redirect marker for it in a streamed 200 body. */
async function redirectedExactly(res: APIResponse, baseURL: string, target: string): Promise<boolean> {
  const location = res.headers()["location"] ?? "";
  const body = res.status() === 200 ? await res.text() : "";
  const u = location ? new URL(location, baseURL) : null;
  const viaHeader = res.status() >= 300 && res.status() < 400 && !!u && `${u.pathname}${u.search}` === target;
  const esc = target.replace(/[/?=.-]/g, "\\$&");
  const viaBody = new RegExp(`NEXT_REDIRECT;(?:replace|push);${esc};`).test(body);
  return viaHeader || viaBody;
}

test.describe.serial("ADR 0020: course enrolment counts path and group learners (0105)", () => {
  const s: {
    org?: { id: string; slug: string };
    admin?: User;
    adminCtx?: BrowserContext;
    analyst?: User;
    analystCtx?: BrowserContext;
    key?: string;
    users: Map<number, User>;
    courses: Map<number, CourseHandle>;
    paths: Map<number, string>;
    groups: Map<number, string>;
    teams: Map<number, string>;
    g3Row?: string;
  } = { users: new Map(), courses: new Map(), paths: new Map(), groups: new Map(), teams: new Map() };

  const u = (n: number) => s.users.get(n)!;
  const c = (n: number) => s.courses.get(n)!.courseId;
  const labelOf = (id: string) => {
    for (const [n, user] of s.users) if (user.id === id) return L(n);
    return id;
  };
  const viewSet = async (course: number): Promise<string[]> => {
    const { data, error } = await svc().from("v_course_enrollments_expanded").select("user_id").eq("course_id", c(course));
    expect(error, `view read: ${error?.message}`).toBeNull();
    return sorted(((data ?? []) as Array<{ user_id: string }>).map((r) => labelOf(r.user_id)));
  };
  const want = (...ns: number[]) => sorted(ns.map(L));
  const ins = async (table: string, rows: Record<string, unknown> | Array<Record<string, unknown>>) => {
    const { data, error } = await svc().from(table).insert(rows).select("*");
    expect(error, `${table} insert: ${error?.message}`).toBeNull();
    return (data ?? []) as Array<Record<string, unknown> & { id?: string }>;
  };
  test.beforeAll(async () => {
    await requires0105();
  });
  test.afterAll(async () => {
    await s.adminCtx?.close().catch(() => {});
    await s.analystCtx?.close().catch(() => {});
  });

  test("seed: the rehearsal's fixture through the service role", async ({ browser, baseURL }) => {
    test.setTimeout(600_000);
    const org = await createOrg({ name: "Lifecycle Enrolment Counts" });
    s.org = org;
    const admin = await createAuthUser({ profile: { first_name: "Enrolment", last_name: "Admin", must_change_password: false } });
    await addMember({ organizationId: org.id, userId: admin.id, role: "super_owner" });
    s.admin = admin;
    const analyst = await createAuthUser({ profile: { first_name: "Enrolment", last_name: "Analyst", must_change_password: false } });
    await addMember({ organizationId: org.id, userId: analyst.id, role: "data_analyst" });
    s.analyst = analyst;
    s.adminCtx = await authedContext(browser, baseURL!, admin.email, admin.password);
    s.analystCtx = await authedContext(browser, baseURL!, analyst.email, analyst.password);
    const keyRes = await s.adminCtx.request.post("/api/org/api-keys", { data: { orgSlug: org.slug, name: "QA enrolment counts" } });
    expect(keyRes.ok(), `api key → ${keyRes.status()}`).toBeTruthy();
    s.key = (await keyRes.json()).key as string;

    for (let n = 1; n <= 14; n++) {
      const user = await createAuthUser({ profile: { first_name: "Enrolment", last_name: L(n), must_change_password: false } });
      await addMember({ organizationId: org.id, userId: user.id, role: "user" });
      s.users.set(n, user);
    }
    for (const [n, patch] of [
      [12, { business_vertical: "Retail" }],
      [13, { business_vertical: "Retail", status: "inactive" }],
      [6, { date_of_joining: daysAgo(10) }],
      [11, { date_of_joining: daysAgo(60) }],
    ] as Array<[number, Record<string, unknown>]>) {
      const { error } = await svc().from("organization_members").update(patch).eq("organization_id", org.id).eq("user_id", u(n).id);
      expect(error, `member ${L(n)}: ${error?.message}`).toBeNull();
    }

    for (const n of [1, 2]) {
      const [t] = await ins("teams", { organization_id: org.id, name: `Enrolment T${n}`, slug: `enrol-t${n}-${rand(6)}` });
      s.teams.set(n, t.id as string);
    }
    await ins("team_members", [
      { team_id: s.teams.get(1), user_id: u(7).id },
      { team_id: s.teams.get(1), user_id: u(8).id },
      { team_id: s.teams.get(2), user_id: u(6).id },
      { team_id: s.teams.get(2), user_id: u(11).id },
    ]);

    const groupRows: Array<[number, Record<string, unknown>]> = [
      [1, { group_type: "static", rules: null, is_active: true }],
      [2, { group_type: "dynamic", rules: { verticals: ["Retail"] }, is_active: true }],
      [3, { group_type: "dynamic", rules: { team_ids: [s.teams.get(2)], joined_within_days: 30 }, is_active: true }],
      [4, { group_type: "dynamic", rules: { verticals: ["Retail"] }, is_active: true, system_key: "scope:Retail|" }],
      [5, { group_type: "static", rules: null, is_active: false }],
    ];
    for (const [n, g] of groupRows) {
      const [row] = await ins("org_groups", { organization_id: org.id, name: `Enrolment G${n} ${rand(4)}`, ...g });
      s.groups.set(n, row.id as string);
    }
    await ins("org_group_members", [
      { group_id: s.groups.get(1), organization_id: org.id, user_id: u(9).id },
      { group_id: s.groups.get(1), organization_id: org.id, user_id: u(10).id },
      { group_id: s.groups.get(5), organization_id: org.id, user_id: u(14).id },
    ]);

    // Six distinct packages: the upload guard (lib/courses/validation/integrity.ts) blocks a module that
    // already belongs to another course of the organisation, so one fixture cannot be uploaded six times.
    const tag = rand(6);
    for (let n = 1; n <= 6; n++) {
      const zip = await scormZip({ title: `Enrolment C${n}`, marker: `enrolment-${tag}-c${n}` });
      const res = await uploadNew(s.adminCtx.request, org.slug, `enrolment-c${n}.zip`, zip);
      expect(res.ok(), `C${n} upload → ${res.status()}: ${await res.text()}`).toBeTruthy();
      const course = await courseHandle((await res.json()).courseId as string);
      await svc().from("courses").update({ title: `Enrolment C${n}` }).eq("id", course.courseId);
      s.courses.set(n, course);
    }

    for (const [n, active, visibility] of [[1, true, "private"], [2, true, "private"], [3, false, "private"], [4, true, "org_public"]] as Array<[number, boolean, string]>) {
      // sequence_mode random: the launch page's prereq lock (strict paths) would
      // otherwise redirect a launch whose earlier steps are not completed, and
      // step 8 proves the hold-back gate, which runs whatever the mode.
      const [p] = await ins("learning_paths", { organization_id: org.id, name: `Enrolment P${n}`, slug: `enrol-p${n}-${rand(6)}`, is_active: active, visibility, sequence_mode: "random" });
      s.paths.set(n, p.id as string);
    }
    const P = (n: number) => s.paths.get(n)!;
    await ins("learning_path_courses", [
      { path_id: P(1), course_id: c(1), step_number: 1, release_at: null },
      { path_id: P(1), course_id: c(3), step_number: 2, release_at: inOneDay() },
      { path_id: P(2), course_id: c(1), step_number: 1, release_at: null },
      { path_id: P(2), course_id: c(2), step_number: 2, release_at: null },
      { path_id: P(2), course_id: c(3), step_number: 3, release_at: null },
      { path_id: P(3), course_id: c(4), step_number: 1, release_at: null },
      { path_id: P(4), course_id: c(6), step_number: 1, release_at: inOneDay() },
    ]);
    const pa = (path: number, row: Record<string, unknown>) => ({ organization_id: org.id, path_id: P(path), ...row });
    await ins("learning_path_assignments", [
      pa(1, { assignee_type: "user", user_id: u(3).id }),
      pa(1, { assignee_type: "user", user_id: u(4).id }),
      pa(1, { assignee_type: "user", user_id: u(5).id }),
      pa(2, { assignee_type: "user", user_id: u(5).id }),
      pa(2, { assignee_type: "user", user_id: u(6).id }),
      pa(2, { assignee_type: "team", team_id: s.teams.get(1) }),
      pa(1, { assignee_type: "group", group_id: s.groups.get(1) }),
      pa(3, { assignee_type: "user", user_id: u(11).id }),
    ]);
    const ca = (course: number, row: Record<string, unknown>) => ({ organization_id: org.id, course_id: c(course), assigned_by: admin.id, ...row });
    await ins("course_assignments", [
      ca(5, { assignee_type: "user", user_id: u(1).id }),
      ca(6, { assignee_type: "user", user_id: u(1).id }),
      ca(5, { assignee_type: "user", user_id: u(2).id, release_at: inOneDay() }),
      ca(1, { assignee_type: "user", user_id: u(4).id }),
      ca(3, { assignee_type: "user", user_id: u(4).id }),
      ca(5, { assignee_type: "group", group_id: s.groups.get(4) }),
      ca(5, { assignee_type: "group", group_id: s.groups.get(5) }),
    ]);
    const [g3] = await ins("course_assignments", ca(5, { assignee_type: "group", group_id: s.groups.get(3), release_at: inOneDay() }));
    s.g3Row = g3.id as string;
  });

  test("1: the view's set per course equals the rehearsal's; P1's path set includes G1's learners", async () => {
    expect(await viewSet(1)).toEqual(want(3, 4, 5, 6, 7, 8, 9, 10));
    expect(await viewSet(2)).toEqual(want(5, 6, 7, 8));
    expect(await viewSet(3), "L4 and L5 held back by P1; L3, L9, L10 on P1's unreleased step").toEqual(want(6, 7, 8));
    expect(await viewSet(4), "P3 is inactive").toEqual([]);
    expect(await viewSet(5), "not L2, G3 (future rows), L13 (inactive member), L14 (inactive group)").toEqual(want(1, 12));
    expect(await viewSet(6), "L1 held back by the org_public P4").toEqual([]);
    const { data } = await svc().from("v_path_enrollments_expanded").select("user_id").eq("path_id", s.paths.get(1)!);
    expect(sorted(((data ?? []) as Array<{ user_id: string }>).map((r) => labelOf(r.user_id)))).toEqual(want(3, 4, 5, 9, 10));
  });

  test("2: the TypeScript and SQL twins of the group resolver agree; the inactive group is in neither", async () => {
    for (const n of [1, 2, 3, 4, 5]) {
      const ts = sorted([...(await resolveManyGroups(svc(), s.org!.id, [s.groups.get(n)!]))].map(labelOf));
      const { data, error } = await svc().from("v_group_members_expanded").select("user_id").eq("group_id", s.groups.get(n)!);
      expect(error).toBeNull();
      const sql = sorted(((data ?? []) as Array<{ user_id: string }>).map((r) => labelOf(r.user_id)));
      expect(sql, `G${n}: SQL equals TypeScript`).toEqual(ts);
    }
    const { data: g } = await svc().from("v_group_members_expanded").select("group_id, user_id").eq("organization_id", s.org!.id);
    const got = sorted(((g ?? []) as Array<{ group_id: string; user_id: string }>).map((r) => {
      const gn = [...s.groups].find(([, id]) => id === r.group_id)?.[0];
      return `G${gn}:${labelOf(r.user_id)}`;
    }));
    expect(got).toEqual(sorted(["G1:L9", "G1:L10", "G2:L12", "G3:L6", "G4:L12"]));
  });

  test("3: the Library course page, the Reports page, the learners table and its CSV agree with the view", async () => {
    test.setTimeout(600_000);
    for (const n of [1, 2, 3, 5]) {
      const expected = (await viewSet(n)).length;
      const page = await s.adminCtx!.newPage();
      await page.goto(`/${s.org!.slug}/library/${c(n)}`, { timeout: 120_000 });
      await expect(page.getByTestId("sum-total"), `C${n} course page`).toHaveText(String(expected), { timeout: 60_000 });
      await page.goto(`/${s.org!.slug}/library/${c(n)}/reports`, { timeout: 120_000 });
      await expect(page.getByTestId("enr-total"), `C${n} Reports §4.1`).toHaveText(String(expected), { timeout: 60_000 });
      await page.close();
    }

    // The learners table and its CSV on C1 (path and direct learners) and C5 (direct and group).
    const viaWanted: Record<number, Record<string, string>> = {
      1: { L3: "path", L4: "user", L5: "path", L6: "path", L7: "path", L8: "path", L9: "path", L10: "path" },
      5: { L1: "user", L12: "group" },
    };
    const cellOf: Record<string, string> = { user: "Direct", group: "Group", path: "Path" };
    for (const n of [1, 5]) {
      const page = await s.adminCtx!.newPage();
      await page.goto(`/${s.org!.slug}/library/${c(n)}/learners`, { timeout: 120_000 });
      await page.locator("tbody tr").first().waitFor({ timeout: 60_000 });
      const rows = page.locator("tbody tr");
      await expect(rows, `C${n} learners table rows`).toHaveCount(Object.keys(viaWanted[n]).length);
      for (const [label, kind] of Object.entries(viaWanted[n])) {
        const user = u(Number(label.slice(1)));
        await expect(page.locator("tbody tr", { hasText: user.email }), `C${n} ${label} via ${kind}`).toContainText(cellOf[kind]);
      }
      await page.close();

      const r = await s.adminCtx!.request.get(`/api/courses/${c(n)}/learners/export?orgSlug=${encodeURIComponent(s.org!.slug)}`);
      expect(r.status(), await r.text()).toBe(200);
      const csv = csvRows(await r.text());
      const header = csv[0];
      const viaCol = header.indexOf("Enrolled via");
      const emailCol = header.indexOf("Email");
      expect(viaCol, "the CSV has its Enrolled via column").toBeGreaterThanOrEqual(0);
      const byEmail = new Map(csv.slice(1).map((row) => [row[emailCol]?.toLowerCase(), row[viaCol]]));
      expect(byEmail.size, `C${n} CSV rows`).toBe(Object.keys(viaWanted[n]).length);
      for (const [label, kind] of Object.entries(viaWanted[n])) {
        expect(byEmail.get(u(Number(label.slice(1))).email.toLowerCase()), `C${n} CSV ${label}`).toBe(kind);
      }
    }
  });

  test("4: the Library list shows the view's per-course counts, as the org admin and as a data_analyst", async () => {
    const counts = new Map<number, number>();
    for (let n = 1; n <= 6; n++) counts.set(n, (await viewSet(n)).length);
    for (const [who, ctx] of [["admin", s.adminCtx!], ["data_analyst", s.analystCtx!]] as const) {
      const res = await ctx.request.get(`/${s.org!.slug}/library`, { timeout: 120_000 });
      expect(res.ok(), `${who} library → ${res.status()}`).toBeTruthy();
      const html = (await res.text()).replace(/\\"/g, '"');
      for (const [n, count] of counts) {
        const m = new RegExp(`"id":"${c(n)}"[^{}]*?"enrolled":(\\d+)`).exec(html);
        expect(m, `${who}: C${n} is on the list`).toBeTruthy();
        expect(Number(m![1]), `${who}: C${n} enrolled`).toBe(count);
      }
    }
  });

  test("5: after refresh_report_views(), both course matviews equal the view's counts", async () => {
    const { data: res, error } = await svc().rpc("refresh_report_views");
    expect(error, `refresh: ${error?.message}`).toBeNull();
    const entries = (Array.isArray(res) ? res : []) as Array<{ view: string; error: string | null }>;
    expect(entries.filter((e) => e.error !== null), "refresh errors").toEqual([]);
    for (let n = 1; n <= 6; n++) {
      const count = (await viewSet(n)).length;
      for (const mv of ["mv_course_enrollment_status", "mv_course_performance"]) {
        const { data } = await svc().from(mv).select("total_enrolled").eq("course_id", c(n)).maybeSingle();
        expect(Number((data as { total_enrolled: number } | null)?.total_enrolled ?? 0), `${mv} C${n}`).toBe(count);
      }
    }
  });

  test("6: the CRM feed equals the view except where owner decision 2 keeps it as it is", async () => {
    const byLearner = new Map<string, Set<string>>();
    for (let n = 1; n <= 6; n++) {
      const { data } = await svc().from("v_course_enrollments_expanded").select("user_id").eq("course_id", c(n));
      for (const r of (data ?? []) as Array<{ user_id: string }>) byLearner.set(r.user_id, (byLearner.get(r.user_id) ?? new Set()).add(`C${n}`));
    }
    const courseLabel = new Map([...s.courses].map(([n, h]) => [h.courseId, `C${n}`]));
    // The feed lists every step of an assigned active path (no step gate) and
    // applies no hold-back (decision 2): C3 for the P1 learners, C6 for L1.
    const extraInFeed: Record<string, string[]> = { L1: ["C6"], L3: ["C3"], L4: ["C3"], L5: ["C3"], L9: ["C3"], L10: ["C3"] };
    for (let n = 1; n <= 14; n++) {
      const user = u(n);
      const r = await s.adminCtx!.request.get(`/api/integrations/progress?email=${encodeURIComponent(user.email)}`, { headers: { Authorization: `Bearer ${s.key}` } });
      expect(r.status(), await r.text()).toBe(200);
      const row = ((await r.json()).progress as Array<{ email: string; courses: Array<{ course_id: string }> }>)
        .find((p) => p.email?.toLowerCase() === user.email.toLowerCase());
      const feed = sorted((row?.courses ?? []).map((x) => courseLabel.get(x.course_id)).filter((x): x is string => !!x));
      const view = sorted(byLearner.get(user.id) ?? []);
      const extra = extraInFeed[L(n)] ?? [];
      expect(feed, `${L(n)}: the feed lists the view's set${extra.length ? ` plus ${extra.join(", ")} (decision 2)` : ""}`).toEqual(sorted([...view, ...extra]));
      for (const x of extra) expect(view, `${L(n)}: the view does not count ${x}`).not.toContain(x);
    }
  });

  test("7: Organisation Reports does not move when a path reaches a learner", async ({ browser, baseURL }) => {
    test.setTimeout(300_000);
    // L1 completes an official attempt on C5 (directly assigned, released).
    const l1 = await authedContext(browser, baseURL!, u(1).email, u(1).password);
    const launch = await l1.request.get(`/${s.org!.slug}/courses/${c(5)}/launch`);
    expect(launch.ok(), `L1 launch C5 → ${launch.status()}`).toBeTruthy();
    const attemptId = await latestAttemptId(s.courses.get(5)!.versionId, u(1).id);
    await scormCommit(l1.request, attemptId, { "cmi.core.lesson_status": "passed", "cmi.core.score.raw": "92" }, true);
    await l1.close();

    const kpis = async () => {
      const page = await s.adminCtx!.newPage();
      await page.goto(`/${s.org!.slug}/reports`, { timeout: 120_000 });
      const out: Record<string, string> = {};
      for (const label of ["Total users", "Completions", "Pass rate", "Completion rate"]) {
        const tile = page.locator("p", { hasText: new RegExp(`^\\s*${label}\\s*$`, "i") }).first().locator("xpath=..");
        await tile.waitFor({ timeout: 60_000 });
        out[label] = ((await tile.locator("p").nth(1).innerText()) || "").trim();
      }
      await page.close();
      return out;
    };
    const before = await kpis();
    const [row] = await ins("learning_path_assignments", { organization_id: s.org!.id, path_id: s.paths.get(2), assignee_type: "user", user_id: u(1).id });
    try {
      expect(await viewSet(2), "P2 now reaches L1 (the view moves)").toContain("L1");
      expect(await kpis(), "Organisation Reports reads members and official pairs only").toEqual(before);
    } finally {
      await svc().from("learning_path_assignments").delete().eq("id", row.id as string);
    }
  });

  test("8: the launch page agrees with the view on C3; P1's step released, every P1 and P2 learner counts", async ({ browser, baseURL }) => {
    test.setTimeout(300_000);
    const c3 = c(3);
    const target = `/${s.org!.slug}/dashboard?upcoming=${c3}`;
    const ctxOf = async (n: number) => authedContext(browser, baseURL!, u(n).email, u(n).password);
    const l4 = await ctxOf(4);
    const l5 = await ctxOf(5);
    const l6 = await ctxOf(6);
    try {
      for (const [n, ctx] of [[4, l4], [5, l5]] as const) {
        const res = await ctx.request.get(`/${s.org!.slug}/courses/${c3}/launch?lp=${s.paths.get(1)}`, { maxRedirects: 0 });
        expect(await redirectedExactly(res, baseURL!, target), `${L(n)} is held back by P1 → ${res.status()}`).toBe(true);
      }
      const ok = await l6.request.get(`/${s.org!.slug}/courses/${c3}/launch?lp=${s.paths.get(2)}`, { maxRedirects: 0 });
      expect(ok.status(), "L6 opens C3 through P2").toBe(200);
      expect(await redirectedExactly(ok, baseURL!, target)).toBe(false);

      const { error } = await svc().from("learning_path_courses").update({ release_at: aMinuteAgo() }).eq("path_id", s.paths.get(1)!).eq("course_id", c3);
      expect(error).toBeNull();
      expect(await viewSet(3)).toEqual(want(3, 4, 5, 6, 7, 8, 9, 10));
      const now = await l4.request.get(`/${s.org!.slug}/courses/${c3}/launch?lp=${s.paths.get(1)}`, { maxRedirects: 0 });
      expect(now.status(), "L4 opens C3 once P1's step is released").toBe(200);
      expect(await redirectedExactly(now, baseURL!, target)).toBe(false);
    } finally {
      await l4.close();
      await l5.close();
      await l6.close();
    }
  });

  test("9: P4's step released: C6 = {L1}; G3's row released: C5 gains L6 and not L11", async () => {
    let r = await svc().from("learning_path_courses").update({ release_at: aMinuteAgo() }).eq("path_id", s.paths.get(4)!).eq("course_id", c(6));
    expect(r.error).toBeNull();
    expect(await viewSet(6)).toEqual(want(1));
    r = await svc().from("course_assignments").update({ release_at: aMinuteAgo() }).eq("id", s.g3Row!);
    expect(r.error).toBeNull();
    expect(await viewSet(5)).toEqual(want(1, 6, 12));
  });
});

// Registered only when ENROLMENT_NOTE_COURSE is set (a by-hand staging read): the nightly subset runs this file
// without it, and a skipped test there turns every night amber (scripts/lifecycle-summary.mjs).
if (process.env.ENROLMENT_NOTE_COURSE) test.describe("ADR 0020 staging note: one path-taught course before the paste and after the first refresh", () => {
  test("counts only: the live view and the two course matviews for ENROLMENT_NOTE_COURSE", async () => {
    const courseId = process.env.ENROLMENT_NOTE_COURSE ?? "";
    const { count } = await svc().from("v_course_enrollments_expanded").select("user_id", { count: "exact", head: true }).eq("course_id", courseId);
    const { data: st } = await svc().from("mv_course_enrollment_status").select("total_enrolled, completed, in_progress, not_started, refreshed_at").eq("course_id", courseId).maybeSingle();
    const { data: perf } = await svc().from("mv_course_performance").select("total_enrolled, total_completed, total_passed, total_failed, refreshed_at").eq("course_id", courseId).maybeSingle();
    const note = JSON.stringify({ view_enrolled: count ?? null, mv_course_enrollment_status: st ?? null, mv_course_performance: perf ?? null });
    test.info().annotations.push({ type: "staging note (counts only)", description: note });
    console.log(`[adr-0020 staging note] ${note}`);
  });
});
