/**
 * ADR 0024 (three independent learning products), spec 68
 * `three-product-independence` (step 62). Phase 2 slice P2-5 creates it with
 * the Start and Preview cases (R6, decision A32); later slices add their
 * cases here (P2-6: the example learner through three products, a forged
 * ?lp=, self-enrolment; P2-7 onward: grants per context, webhooks, emails).
 *
 * Start and Preview by mode (P2-5). Without ?mode=preview every role is a
 * learner with real rows; ?mode=preview is a preview for the report-viewing
 * roles only (super_owner, admin, data_analyst), whose row is
 * context_kind 'preview', preview_kind 'course', is_preview true,
 * launch_mode 'Normal', with no official tag, and is never official.
 *
 *   (r1-r3) an enrolled admin, super owner and data analyst each press Preview
 *         first and Start second: two rows; the bar reads "Preview: not an
 *         official record" on the preview only; a second Preview resumes the
 *         preview; the Start leaves the preview row as it was; the real
 *         attempt, passed on its own token, is the official one (its
 *         LMS.OfficialResult note) and the preview row is still untouched;
 *         the preview, finished afterwards, gets no note and no XP and leaves
 *         the real attempt as it was (the other order would hide a mixed
 *         read: a Start that resumed the preview, or a real row read as a
 *         revision); the learner course page offers each role a Preview link;
 *   (run) a preview that names a run is refused (phase P): ?denied=1, no row;
 *   (3b)  a plain enrolled learner's ?mode=preview: ?denied=1 and no
 *         course_attempts row written, before and after a Start of their own;
 *         their course page offers no Preview;
 *   (3c)  impersonation: a platform owner who is a plain member, enrolled,
 *         impersonating the organisation (requireOrgAccess answers
 *         super_owner): a Start is refused with ?denied=1 and writes nothing,
 *         the course page offers "Preview instead", a Preview is served and
 *         writes one preview row; once the
 *         impersonation ends the member's own role answers (Preview refused,
 *         Start served). A platform owner with no membership: the Start is
 *         never served and writes nothing (requireOrgAccess reads the
 *         organisation on the caller's session before the impersonation, and
 *         the organisations policy admits members only, so the launch never
 *         reaches the impersonation answer; the redirect is logged by class).
 *         Last in the file: it alone depends on the target's configuration
 *         (IMPERSONATION_SECRET on the app server);
 *   (4)   a data analyst not enrolled: the Start is refused with ?denied=1
 *         and writes nothing; the course page says "not enrolled
 *         in this course" and offers "Preview instead"; the Preview is served;
 *   (5b)  one person holds a preview row and a real row of one course:
 *         (a) a Start opens the course's current version while the preview
 *             is open on the retired one;
 *         (b) an open preview on another language neither bounces an explicit
 *             ?lang= Start to the switch confirm (c) nor reroutes a Start
 *             chosen by the saved preference onto its language;
 *         (d) a completed preview of step 1 leaves step 2 of a strict path
 *             locked for a Start, and step 2's own Preview is still served
 *             (a preview runs outside the path's order); the path page offers
 *             a Preview link on each step, with no ?lp=;
 *   (m)   a preview launch's subrequest count, measured on a local build: the
 *         server-side fetch() calls of a first preview, a resumed preview and
 *         a first Start, counted inside the app server by
 *         ./subrequest-meter.cjs (preloaded into `next start`, never into this
 *         run) and read back from SUBREQUEST_LOG. Recorded, not asserted (40
 *         is P2-6's gate); on a target without the meter the case is skipped
 *         as "not measured on this target". The middleware's own call is not
 *         in the figure (ADR 0019 estimates one).
 *
 * Needs 0107 on the target database: the seed FAILS without it. By hand on
 * staging after the code is deployed, never while another lifecycle run is in
 * progress; after one green run it joins PRODUCT_SPECS in
 * scripts/lifecycle-nightly.sh (step 73). Data stays in the lifecycle-*
 * namespace; the two platform-owner marks are removed in afterAll. Logs carry
 * ids and counts only.
 */
import { test, expect, type APIRequestContext, type BrowserContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { addMember, createAuthUser, createOrg, markPlatformOwner, rand, svc } from "./data";
import { assignCourse, authedContext, courseHandle, GUARDIAN_ROUTE_TIMEOUT_MS } from "./helpers";
import { authTokenFor, cmi5Zip, has0107, uploadNew, VERB, XAPI_HEADERS, zipFile } from "./p0-helpers";

type User = { id: string; email: string; password: string };
type Role = "admin" | "super_owner" | "data_analyst" | "user";
type Row = Record<string, unknown>;
type Att = {
  id: string;
  course_version_id: string;
  status: string;
  completion_status: string;
  success_status: string;
  score: number | null;
  is_revision: boolean | null;
  is_preview: boolean | null;
  launch_mode: string | null;
  context_kind: string | null;
  preview_kind: string | null;
  learning_path_id: string | null;
  journey_enrollment_id: string | null;
};
const ATT_COLUMNS =
  "id, course_version_id, status, completion_status, success_status, score, is_revision, is_preview, launch_mode, context_kind, preview_kind, learning_path_id, journey_enrollment_id";

const AU = "https://qa.bot/cmi5/au1";
const PREVIEW_COPY = "Preview: not an official record";
/** A course preview row as P2-5 writes it (ADR 0024 step 22's preview row, decision A32). */
const PREVIEW_ROW = {
  context_kind: "preview",
  preview_kind: "course",
  is_preview: true,
  launch_mode: "Normal",
  is_revision: false,
  learning_path_id: null,
  journey_enrollment_id: null,
};
/** A Start without a product parameter: the Individual product, never a preview or a revision. */
const REAL_ROW = { context_kind: "individual", is_preview: false, is_revision: false, learning_path_id: null, journey_enrollment_id: null };
/** The meter's log (./subrequest-meter.cjs), set only when the app server runs on this machine with the meter. */
const METER_LOG = process.env.SUBREQUEST_LOG;

// ── HTTP helpers (spec 63's noFollow, copied; spec 63 stays unchanged) ──────
type NoFollow = { status: number; location: string; body: string };

async function noFollow(req: APIRequestContext, url: string): Promise<NoFollow> {
  const res = await req.get(url, { maxRedirects: 0, timeout: 120_000 });
  const location = res.headers()["location"] ?? "";
  const body = res.status() === 200 ? await res.text() : "";
  return { status: res.status(), location, body };
}

/**
 * Where a response redirects (path and query), from a 3xx Location or from
 * Next's redirect marker in a 200 body once the loading boundary has
 * streamed; null for a page that rendered. Never a bare substring of the
 * body: every learner page carries /{org}/dashboard links.
 */
function redirectTarget(r: NoFollow): string | null {
  if (r.status >= 300 && r.status < 400) {
    try {
      const u = new URL(r.location, "http://x.invalid");
      return u.pathname + u.search;
    } catch {
      return r.location;
    }
  }
  if (r.status === 200) {
    const m = /NEXT_REDIRECT;(?:replace|push);([^;"\\]+);/.exec(r.body);
    if (m) return m[1];
  }
  return null;
}

const describe = (r: NoFollow) => `${r.status} → ${redirectTarget(r) ?? "(rendered)"}`;
/** The launch's HTML with React's text separators removed, for copy checks. */
const text = (html: string) => html.replace(/<!-- -->/g, "");

/** A served launch: 200, no redirect, the course's iframe. Returns the iframe's src and the HTML. */
async function served(req: APIRequestContext, url: string): Promise<{ src: string; html: string }> {
  const r = await noFollow(req, url);
  expect(r.status, `${url}: ${describe(r)}`).toBe(200);
  expect(redirectTarget(r), `${url}: no redirect`).toBeNull();
  const m = /<iframe[^>]+src="([^"]+)"/.exec(r.body);
  expect(m, `${url}: the launch renders the course iframe`).toBeTruthy();
  return { src: m![1].replace(/&amp;/g, "&"), html: text(r.body) };
}

function expectPreviewBar(html: string, what: string) {
  expect(html, `${what}: the preview's bar`).toContain(PREVIEW_COPY);
  expect(html, `${what}: the preview badge`).toContain('data-testid="preview-badge"');
  expect(html, `${what}: no Continue`).not.toContain('data-testid="continue-next"');
  expect(html, `${what}: no Revision Mode badge`).not.toContain('data-testid="practice-badge"');
}

function expectStartBar(html: string, what: string) {
  expect(html, `${what}: not a preview`).not.toContain(PREVIEW_COPY);
  expect(html, `${what}: no preview badge`).not.toContain('data-testid="preview-badge"');
  expect(html, `${what}: not a revision visit`).not.toContain('data-testid="practice-badge"');
}

// ── row readers (by attempt id or by user and version; context-aware) ───────
async function rowsOf(userId: string, versionId?: string): Promise<Att[]> {
  let q = svc().from("course_attempts").select(ATT_COLUMNS).eq("user_id", userId);
  if (versionId) q = q.eq("course_version_id", versionId);
  const { data, error } = await q.order("started_at");
  expect(error, `attempts read: ${error?.message}`).toBeNull();
  return (data ?? []) as unknown as Att[];
}

async function fullRow(id: string): Promise<Row> {
  const { data, error } = await svc().from("course_attempts").select("*").eq("id", id).single();
  expect(error, `attempt ${id}: ${error?.message}`).toBeNull();
  return data as Row;
}

const previewsOf = (rows: Att[]) => rows.filter((r) => r.context_kind === "preview");
const realOf = (rows: Att[]) => rows.filter((r) => r.context_kind !== "preview");

/** The official result note (ADR 0017 step 19), written only for an official run. */
async function noteStatus(attemptId: string): Promise<string | null> {
  const { data, error } = await svc().from("xapi_state").select("content").eq("attempt_id", attemptId).eq("state_id", "LMS.OfficialResult").maybeSingle();
  expect(error, `note read: ${error?.message}`).toBeNull();
  return ((data as { content?: { status?: string } } | null)?.content?.status as string | undefined) ?? null;
}

async function xpCount(attemptId: string): Promise<number> {
  const { count, error } = await svc().from("xp_events").select("id", { count: "exact", head: true }).eq("attempt_id", attemptId);
  expect(error, `xp read: ${error?.message}`).toBeNull();
  return count ?? 0;
}

// ── cmi5 results on an attempt's own launch token (spec 63's finish, copied) ─
function statement(u: User, verb: string, registration: string, extra: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    actor: { objectType: "Agent", name: u.email, account: { homePage: "https://qa.bot", name: u.id } },
    verb: { id: VERB(verb) },
    object: { objectType: "Activity", id: AU },
    context: { registration },
    ...extra,
  };
}

async function finish(req: APIRequestContext, u: User, attemptId: string, outcome: "passed" | "failed", scaled: number) {
  const auth = await authTokenFor(req, attemptId);
  const res = await req.post("/api/xapi/statements", {
    headers: { ...XAPI_HEADERS, Authorization: auth },
    data: [
      statement(u, "initialized", attemptId),
      statement(u, "completed", attemptId, { result: { completion: true } }),
      statement(u, outcome, attemptId, { result: { success: outcome === "passed", score: { scaled } } }),
    ],
  });
  expect(res.status(), await res.text()).toBe(200);
}

// ── the meter (./subrequest-meter.cjs) ──────────────────────────────────────
type Metered = { path: string; status: number; fetches: number; supabase: number; other: number };

function meterLines(): Metered[] {
  if (!METER_LOG || !fs.existsSync(METER_LOG)) return [];
  return fs
    .readFileSync(METER_LOG, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Metered);
}

/** One GET of `url` and the meter's line for it (the line appended after the call began, for this path). */
async function metered(req: APIRequestContext, url: string): Promise<Metered> {
  const from = meterLines().length;
  const r = await noFollow(req, url);
  expect(r.status, `${url}: ${describe(r)}`).toBe(200);
  expect(redirectTarget(r), `${url}: served, not redirected`).toBeNull();
  let mine: Metered[] = [];
  for (let i = 0; i < 50 && mine.length === 0; i++) {
    mine = meterLines().slice(from).filter((l) => l.path === url);
    if (mine.length === 0) await new Promise((res) => setTimeout(res, 100));
  }
  expect(mine.length, `the meter logged ${url} (is the app server running with the meter and this SUBREQUEST_LOG?)`).toBe(1);
  return mine[0];
}

test.describe.serial("ADR 0024 P2-5 — Start and Preview by mode", () => {
  const s: {
    org?: { id: string; slug: string };
    setupCtx?: BrowserContext;
    users: Partial<Record<"admin" | "owner" | "analyst" | "learner" | "meter" | "imp" | "outsider", User>>;
    ctx: Partial<Record<"admin" | "owner" | "analyst" | "learner" | "meter" | "imp" | "outsider", BrowserContext>>;
    platformOwners: string[];
    /** K: the role cases, the refusals, impersonation and the meter. */
    k?: string;
    vK?: string;
    /** V: replaced in (5b-a). */
    v?: string;
    vPkg?: string;
    vV1?: string;
    vZip?: Buffer;
    /** L: English and Hindi, (5b-b) and (5b-c). */
    l?: { courseId: string; enVersion: string; hiVersion: string };
    /** A strict path P1 → P2, (5b-d) and (4). */
    p1?: string;
    p2?: string;
    vP1?: string;
    vP2?: string;
    pathId?: string;
  } = { users: {}, ctx: {}, platformOwners: [] };
  const slug = () => s.org!.slug;
  const startUrl = (courseId: string, q = "") => `/${slug()}/courses/${courseId}/launch${q}`;
  const previewUrl = (courseId: string, extra = "") => `/${slug()}/courses/${courseId}/launch?mode=preview${extra}`;
  const denied = () => `/${slug()}/dashboard?denied=1`;

  test.afterAll(async () => {
    for (const c of Object.values(s.ctx)) await c?.close().catch(() => {});
    await s.setupCtx?.close().catch(() => {});
    // No platform owner is left behind on staging by this spec.
    for (const id of s.platformOwners) await svc().from("platform_owners").delete().eq("user_id", id);
  });

  test("seed: courses K and V, bilingual L, a strict path P1 → P2; an admin, a super owner, an analyst, a learner, a metered admin and two platform owners", async ({ browser, baseURL }) => {
    expect(await has0107(), "0107 is not applied on this database: spec 68 needs course_attempts.context_kind").toBe(true);
    const org = await createOrg({ name: "Lifecycle Three Products" });
    s.org = org;
    const mk = async (key: keyof typeof s.users, role: Role | null) => {
      const u = (await createAuthUser({ profile: { first_name: "Products", last_name: key, must_change_password: false } })) as User;
      if (role) await addMember({ organizationId: org.id, userId: u.id, role });
      s.users[key] = u;
      return u;
    };
    const setup = (await createAuthUser({ profile: { first_name: "Products", last_name: "Setup", must_change_password: false } })) as User;
    await addMember({ organizationId: org.id, userId: setup.id, role: "super_owner" });
    s.setupCtx = await authedContext(browser, baseURL!, setup.email, setup.password);
    const areq = s.setupCtx.request;

    const admin = await mk("admin", "admin");
    const owner = await mk("owner", "super_owner");
    const analyst = await mk("analyst", "data_analyst");
    const learner = await mk("learner", "user");
    const meter = await mk("meter", "admin");
    const imp = await mk("imp", "user");
    const outsider = await mk("outsider", null);
    for (const u of [imp, outsider]) {
      await markPlatformOwner(u.id);
      s.platformOwners.push(u.id);
    }

    const tag = rand(6);
    const up = async (name: string, buf: Buffer) => {
      const r = await uploadNew(areq, org.slug, name, buf);
      expect(r.ok(), `upload ${name} → ${r.status()}: ${await r.text()}`).toBeTruthy();
      return (await r.json()).courseId as string;
    };
    s.k = await up("k.zip", await cmi5Zip({ courseId: `urn:qa:products:${tag}:k`, title: "QA Products K" }));
    s.vK = (await courseHandle(s.k)).versionId;
    s.vZip = await cmi5Zip({ courseId: `urn:qa:products:${tag}:v`, title: "QA Products V" });
    s.v = await up("v.zip", s.vZip);
    s.vV1 = (await courseHandle(s.v)).versionId;
    const { data: vp, error: vpErr } = await svc().from("course_packages").select("id").eq("course_id", s.v).single();
    expect(vpErr, `V's package: ${vpErr?.message}`).toBeNull();
    s.vPkg = (vp as { id: string }).id;
    s.p1 = await up("p1.zip", await cmi5Zip({ courseId: `urn:qa:products:${tag}:p1`, title: "QA Products Step One" }));
    s.p2 = await up("p2.zip", await cmi5Zip({ courseId: `urn:qa:products:${tag}:p2`, title: "QA Products Step Two" }));
    s.vP1 = (await courseHandle(s.p1)).versionId;
    s.vP2 = (await courseHandle(s.p2)).versionId;

    // L in English and Hindi (spec 53's bilingual(), inline).
    const lZip = await cmi5Zip({ courseId: `urn:qa:products:${tag}:l`, title: "QA Products L" });
    const lId = await up("l.zip", lZip);
    const { data: l0 } = await svc().from("course_packages").select("id, current_version_id").eq("course_id", lId).single();
    const enPkg = (l0 as { id: string }).id;
    const promote = await areq.patch(`/api/courses/${lId}/packages/${enPkg}`, { data: { orgSlug: org.slug, language: "en", display_name: "English" } });
    expect(promote.ok(), `promote → ${promote.status()}: ${await promote.text()}`).toBeTruthy();
    const addHi = await areq.post(`/api/courses/${lId}/packages`, {
      multipart: { orgSlug: org.slug, language: "hi", display_name: "Hindi", file: zipFile("l.zip", lZip) },
      timeout: GUARDIAN_ROUTE_TIMEOUT_MS,
    });
    expect(addHi.ok(), `add hi → ${addHi.status()}: ${await addHi.text()}`).toBeTruthy();
    const { data: hi } = await svc().from("course_packages").select("current_version_id").eq("course_id", lId).eq("language", "hi").single();
    s.l = {
      courseId: lId,
      enVersion: (l0 as { current_version_id: string }).current_version_id,
      hiVersion: (hi as { current_version_id: string }).current_version_id,
    };

    const { data: p, error: pathErr } = await svc()
      .from("learning_paths")
      .insert({ organization_id: org.id, name: "Products Path", slug: `qa-prd-${rand(6)}`, sequence_mode: "strict" })
      .select("id")
      .single();
    expect(pathErr, `path seed: ${pathErr?.message}`).toBeNull();
    s.pathId = (p as { id: string }).id;
    const { error: se } = await svc().from("learning_path_courses").insert([
      { path_id: s.pathId, course_id: s.p1, step_number: 1 },
      { path_id: s.pathId, course_id: s.p2, step_number: 2 },
    ]);
    expect(se, `path steps: ${se?.message}`).toBeNull();
    const { error: pae } = await svc()
      .from("learning_path_assignments")
      .insert({ organization_id: org.id, path_id: s.pathId, assignee_type: "user", user_id: owner.id });
    expect(pae, `path assignment: ${pae?.message}`).toBeNull();

    // Enrolment: every role-case user, the learner, the metered admin and the
    // member platform owner on K; the admin on V; the analyst and the super
    // owner on L. The analyst holds nothing on the path (case 4).
    for (const u of [admin, owner, analyst, learner, meter, imp]) await assignCourse(areq, org.slug, s.k, u.id);
    await assignCourse(areq, org.slug, s.v, admin.id);
    for (const u of [analyst, owner]) await assignCourse(areq, org.slug, lId, u.id);

    for (const key of Object.keys(s.users) as Array<keyof typeof s.users>) {
      const u = s.users[key]!;
      s.ctx[key] = await authedContext(browser, baseURL!, u.email, u.password);
    }
  });

  for (const [n, key, label] of [
    ["r1", "admin", "admin"],
    ["r2", "owner", "super owner"],
    ["r3", "analyst", "data analyst"],
  ] as const) {
    test(`(${n}) an enrolled ${label}: Preview first, then Start; two rows, the preview untouched, the real attempt scored alone`, async () => {
      const u = s.users[key]!;
      const req = s.ctx[key]!.request;
      expect(await rowsOf(u.id, s.vK), "nothing before the Preview").toEqual([]);

      // The learner course page offers this role a Preview (step 23's buttons).
      const page = await req.get(`/${slug()}/courses/${s.k}`, { timeout: 120_000 });
      expect(page.ok(), `course page → ${page.status()}`).toBeTruthy();
      expect(await page.text(), "the course page's Preview link").toContain(`/courses/${s.k}/launch?mode=preview`);

      // Preview: one preview row, resumed by a second Preview.
      const pv = await served(req, previewUrl(s.k!));
      expect(pv.src).toContain(`/content/v/${s.vK}/`);
      expectPreviewBar(pv.html, "Preview");
      let rows = await rowsOf(u.id, s.vK);
      expect(rows.length, "one row after the Preview").toBe(1);
      expect(rows[0]).toMatchObject({ ...PREVIEW_ROW, status: "in_progress" });
      const previewId = rows[0].id;
      expectPreviewBar((await served(req, previewUrl(s.k!))).html, "Preview again");
      rows = await rowsOf(u.id, s.vK);
      expect(rows.map((r) => r.id), "the second Preview resumes the preview").toEqual([previewId]);
      const previewBefore = await fullRow(previewId);

      // Start: a real attempt beside the preview, which the Start leaves alone.
      const st = await served(req, startUrl(s.k!));
      expect(st.src).toContain(`/content/v/${s.vK}/`);
      expectStartBar(st.html, "Start");
      rows = await rowsOf(u.id, s.vK);
      expect(rows.length, "two rows: the preview and the real attempt").toBe(2);
      const real = realOf(rows);
      expect(real.length, "one real row").toBe(1);
      expect(real[0]).toMatchObject({ ...REAL_ROW, status: "in_progress" });
      expect([null, "Normal"], "a learner's launch mode (Normal with ALDS_P4 on)").toContain(real[0].launch_mode);
      expect(await fullRow(previewId), "the Start left the preview row as it was").toEqual(previewBefore);

      // The real attempt, passed on its own token, is the official one.
      await finish(req, u, real[0].id, "passed", 0.8);
      const realAfter = await fullRow(real[0].id);
      expect([realAfter.status, realAfter.success_status, realAfter.score]).toEqual(["passed", "passed", 0.8]);
      expect(await noteStatus(real[0].id), "the official result note on the real attempt").toBe("passed");
      expect(await fullRow(previewId), "the preview is still as it was").toEqual(previewBefore);
      expect(await noteStatus(previewId), "no note on the preview").toBeNull();

      // The preview, finished afterwards: never official; the real attempt stays.
      await finish(req, u, previewId, "failed", 0.2);
      const previewDone = await fullRow(previewId);
      expect([previewDone.completion_status, previewDone.success_status], "the preview's own result").toEqual(["completed", "failed"]);
      expect(await noteStatus(previewId), "no official note for the preview").toBeNull();
      expect(await xpCount(previewId), "no XP for the preview").toBe(0);
      expect(await fullRow(real[0].id), "the real attempt is as its own result left it").toEqual(realAfter);
      expect(await noteStatus(real[0].id), "the real attempt's note is unchanged").toBe("passed");
      expect((await rowsOf(u.id, s.vK)).length, "still two rows").toBe(2);
    });
  }

  test("(run) a preview that names a run is refused (phase P): ?denied=1, no row", async () => {
    const u = s.users.admin!;
    const before = (await rowsOf(u.id)).map((r) => r.id);
    const r = await noFollow(s.ctx.admin!.request, previewUrl(s.k!, `&run=${randomUUID()}`));
    expect(redirectTarget(r), describe(r)).toBe(denied());
    expect((await rowsOf(u.id)).map((x) => x.id), "no row written").toEqual(before);
  });

  test("(3b) a plain enrolled learner's ?mode=preview is refused with ?denied=1 and writes no row, before and after a Start", async () => {
    const u = s.users.learner!;
    const req = s.ctx.learner!.request;
    const page = await req.get(`/${slug()}/courses/${s.k}`, { timeout: 120_000 });
    expect(page.ok(), `course page → ${page.status()}`).toBeTruthy();
    expect(await page.text(), "no Preview link for a plain user").not.toContain("launch?mode=preview");

    const r = await noFollow(req, previewUrl(s.k!));
    expect(redirectTarget(r), describe(r)).toBe(denied());
    expect(await rowsOf(u.id), "no course_attempts row of any course").toEqual([]);

    // The learner is enrolled: a Start is served and is a real attempt.
    expectStartBar((await served(req, startUrl(s.k!))).html, "Start");
    const rows = await rowsOf(u.id);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ ...REAL_ROW, course_version_id: s.vK, status: "in_progress" });

    const again = await noFollow(req, previewUrl(s.k!));
    expect(redirectTarget(again), describe(again)).toBe(denied());
    expect((await rowsOf(u.id)).map((x) => x.id), "still the one real row").toEqual([rows[0].id]);
  });

  test("(4) a data analyst not enrolled: the Start is refused and writes nothing; the Preview is served", async () => {
    const u = s.users.analyst!;
    const req = s.ctx.analyst!.request;
    // No role bypass for a Start any more (step 23): today's denied notice.
    const r = await noFollow(req, startUrl(s.p1!));
    expect(redirectTarget(r), `the not-enrolled Start: ${describe(r)}`).toBe(denied());
    expect(await rowsOf(u.id, s.vP1), "nothing written").toEqual([]);
    // The course page: "You're not enrolled in this course" and, for a
    // report-viewing role, "Preview instead" (step 23's buttons).
    const cp = await req.get(`/${slug()}/courses/${s.p1}`, { timeout: 120_000 });
    expect(cp.ok(), `course page → ${cp.status()}`).toBeTruthy();
    const cpHtml = text(await cp.text());
    expect(cpHtml, "the not-enrolled notice").toContain('data-testid="not-enrolled"');
    expect(cpHtml).toContain("not enrolled in this course");
    const instead = /<a[^>]*data-testid="preview-instead"[^>]*>/.exec(cpHtml)?.[0] ?? "";
    expect(instead, "Preview instead opens this course's preview").toContain(`/courses/${s.p1}/launch?mode=preview"`);
    expectPreviewBar((await served(req, previewUrl(s.p1!))).html, "not-enrolled Preview");
    const rows = await rowsOf(u.id, s.vP1);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ ...PREVIEW_ROW, status: "in_progress" });
  });

  test("(5b-a) a Start opens the course's current version while a preview is open on the retired one", async () => {
    const u = s.users.admin!;
    const req = s.ctx.admin!.request;
    expect((await served(req, previewUrl(s.v!))).src).toContain(`/content/v/${s.vV1}/`);
    const [pv] = await rowsOf(u.id, s.vV1);
    expect(pv).toMatchObject({ ...PREVIEW_ROW, status: "in_progress" });
    const previewBefore = await fullRow(pv.id);

    // Replace content, grandfather: v1 retired, v2 current; open rows stay.
    const replace = await s.setupCtx!.request.post(`/api/courses/${s.v}/packages/${s.vPkg}/versions`, {
      multipart: { orgSlug: slug(), mode: "grandfather", file: zipFile("v.zip", s.vZip!) },
      timeout: GUARDIAN_ROUTE_TIMEOUT_MS,
    });
    expect(replace.ok(), `replace → ${replace.status()}: ${await replace.text()}`).toBeTruthy();
    const v2 = (await replace.json()).version_id as string;
    expect(v2).not.toBe(s.vV1);

    const st = await served(req, startUrl(s.v!));
    expect(st.src, "the Start runs the current version, not the preview's").toContain(`/content/v/${v2}/`);
    expectStartBar(st.html, "Start");
    const onV2 = await rowsOf(u.id, v2);
    expect(onV2.length).toBe(1);
    expect(onV2[0]).toMatchObject({ ...REAL_ROW, status: "in_progress" });
    expect((await rowsOf(u.id, s.vV1)).map((r) => r.id), "v1 holds only the preview").toEqual([pv.id]);
    expect(await fullRow(pv.id), "the preview is as it was").toEqual(previewBefore);
  });

  test("(5b-b) an open preview on Hindi does not bounce an explicit ?lang=en Start to the switch confirm", async () => {
    const u = s.users.analyst!;
    const req = s.ctx.analyst!.request;
    const L = s.l!;
    expect((await served(req, previewUrl(L.courseId, "&lang=hi"))).src).toContain(`/content/v/${L.hiVersion}/`);
    const [pv] = await rowsOf(u.id, L.hiVersion);
    expect(pv).toMatchObject({ ...PREVIEW_ROW, status: "in_progress" });
    const previewBefore = await fullRow(pv.id);

    // served(): a 200 that renders, never the redirect to ?switch=en.
    const st = await served(req, startUrl(L.courseId, "?lang=en"));
    expect(st.src, "English runs").toContain(`/content/v/${L.enVersion}/`);
    expectStartBar(st.html, "Start");
    const en = await rowsOf(u.id, L.enVersion);
    expect(en.length, "one real attempt in English").toBe(1);
    expect(en[0]).toMatchObject({ ...REAL_ROW, status: "in_progress" });
    expect((await rowsOf(u.id, L.hiVersion)).map((x) => x.id), "Hindi holds only the preview").toEqual([pv.id]);
    expect(await fullRow(pv.id), "the preview is as it was").toEqual(previewBefore);
  });

  test("(5b-c) an open preview on Hindi does not reroute a Start chosen by the saved preference (English)", async () => {
    const u = s.users.owner!;
    const req = s.ctx.owner!.request;
    const L = s.l!;
    // The preference first: with a preview open on Hindi the preference route
    // would count it as progress elsewhere and answer its confirm (409).
    const pref = await req.put(`/api/courses/${L.courseId}/language-preference`, { data: { orgSlug: slug(), language: "en" } });
    expect(pref.status(), await pref.text()).toBe(200);
    expect((await served(req, previewUrl(L.courseId, "&lang=hi"))).src).toContain(`/content/v/${L.hiVersion}/`);
    const [pv] = await rowsOf(u.id, L.hiVersion);
    expect(pv).toMatchObject({ ...PREVIEW_ROW, status: "in_progress" });
    const previewBefore = await fullRow(pv.id);

    const st = await served(req, startUrl(L.courseId));
    expect(st.src, "the preference's language runs, not the preview's").toContain(`/content/v/${L.enVersion}/`);
    const en = await rowsOf(u.id, L.enVersion);
    expect(en.length, "one real attempt in English").toBe(1);
    expect(en[0]).toMatchObject({ ...REAL_ROW, status: "in_progress" });
    expect((await rowsOf(u.id, L.hiVersion)).map((x) => x.id), "Hindi holds only the preview").toEqual([pv.id]);
    expect(await fullRow(pv.id), "the preview is as it was").toEqual(previewBefore);
  });

  test("(5b-d) a completed preview of step 1 leaves step 2 of a strict path locked for a Start", async () => {
    const u = s.users.owner!;
    const req = s.ctx.owner!.request;
    // The path page: a Preview link on each step, with no ?lp=.
    const pathPage = await req.get(`/${slug()}/paths/${s.pathId}`, { timeout: 120_000 });
    expect(pathPage.ok(), `path page → ${pathPage.status()}`).toBeTruthy();
    const pathHtml = (await pathPage.text()).replace(/&amp;/g, "&");
    for (const c of [s.p1!, s.p2!]) expect(pathHtml, `step ${c === s.p1 ? 1 : 2}'s Preview link`).toContain(`/courses/${c}/launch?mode=preview`);
    expect(pathHtml, "a Preview link carries no ?lp=").not.toMatch(/launch\?mode=preview[^"]*lp=/);

    expectPreviewBar((await served(req, previewUrl(s.p1!))).html, "step 1's Preview");
    const [pv] = await rowsOf(u.id, s.vP1);
    expect(pv).toMatchObject({ ...PREVIEW_ROW, status: "in_progress" });
    await finish(req, u, pv.id, "passed", 0.9);
    const done = await fullRow(pv.id);
    expect([done.completion_status, done.success_status], "the preview of step 1 is complete and passed").toEqual(["completed", "passed"]);
    expect(await noteStatus(pv.id), "never official").toBeNull();
    expect(await xpCount(pv.id), "no XP").toBe(0);
    expect(realOf(await rowsOf(u.id, s.vP1)), "no real attempt on step 1").toEqual([]);

    const r = await noFollow(req, startUrl(s.p2!, `?lp=${s.pathId}`));
    expect(redirectTarget(r), `step 2 stays locked: ${describe(r)}`).toBe(`/${slug()}/dashboard?locked=${s.p2}`);
    expect(await rowsOf(u.id, s.vP2), "nothing written on step 2").toEqual([]);
    // A preview runs outside the path's order: step 2's Preview is served.
    expectPreviewBar((await served(req, previewUrl(s.p2!))).html, "step 2's Preview");
    const onP2 = await rowsOf(u.id, s.vP2);
    expect(onP2.length).toBe(1);
    expect(onP2[0]).toMatchObject({ ...PREVIEW_ROW, status: "in_progress" });
  });

  test("(m) a preview launch's subrequest count, measured on a local build", async () => {
    test.skip(
      !METER_LOG,
      "not measured on this target: run the app server here with NODE_OPTIONS=--require ./tests/bot/lifecycle/subrequest-meter.cjs and SUBREQUEST_LOG set for both"
    );
    const u = s.users.meter!;
    const req = s.ctx.meter!.request;
    expect(await rowsOf(u.id), "a fresh admin").toEqual([]);
    const first = await metered(req, previewUrl(s.k!));
    const resume = await metered(req, previewUrl(s.k!));
    const start = await metered(req, startUrl(s.k!));
    const rows = await rowsOf(u.id, s.vK);
    expect(previewsOf(rows).length, "one preview").toBe(1);
    expect(realOf(rows).length, "one real attempt").toBe(1);
    const fmt = (m: Metered) => `${m.fetches} (database ${m.supabase}, other ${m.other})`;
    const line =
      `server-side fetches per request, middleware not included: first Preview ${fmt(first)}; ` +
      `resumed Preview ${fmt(resume)}; first Start ${fmt(start)}`;
    console.log(`[spec 68] subrequests: ${line}`);
    test.info().annotations.push({ type: "subrequests", description: line });
  });

  // Last in the file: the one case that depends on the target's configuration
  // (IMPERSONATION_SECRET on the app server, the Secure impersonation cookie),
  // so a red here skips no other case.
  test("(3c) impersonation: a Start is refused with ?denied=1 and writes nothing; Preview stays allowed", async () => {
    const u = s.users.imp!;
    const ctx = s.ctx.imp!;
    const startImp = await ctx.request.post("/api/super/impersonate", { data: { org_id: s.org!.id, reason: "lifecycle spec 68 (ADR 0024 P2-5 3c)" } });
    expect(startImp.status(), `impersonate → ${startImp.status()} (the target needs IMPERSONATION_SECRET): ${await startImp.text()}`).toBeLessThan(400);
    expect((await ctx.cookies()).some((c) => c.name === "lms_impersonation"), "the impersonation cookie is set").toBe(true);
    try {
      const active = await ctx.request.get("/api/super/impersonate");
      expect(await active.text(), "the impersonation is active for this organisation").toContain(s.org!.id);
      // The course page offers an impersonator the preview only.
      const cp = await ctx.request.get(`/${slug()}/courses/${s.k}`, { timeout: 120_000 });
      expect(cp.ok(), `course page → ${cp.status()}`).toBeTruthy();
      expect(await cp.text(), "Preview instead, for an impersonator").toContain('data-testid="preview-instead"');

      const r = await noFollow(ctx.request, startUrl(s.k!));
      expect(redirectTarget(r), describe(r)).toBe(denied());
      expect(await rowsOf(u.id), "an impersonated Start writes nothing").toEqual([]);

      const pv = await served(ctx.request, previewUrl(s.k!));
      expectPreviewBar(pv.html, "impersonated Preview");
      const rows = await rowsOf(u.id);
      expect(rows.length, "one row: the preview").toBe(1);
      expect(rows[0]).toMatchObject({ ...PREVIEW_ROW, course_version_id: s.vK, status: "in_progress" });
    } finally {
      const end = await ctx.request.delete("/api/super/impersonate");
      expect(end.status(), `end impersonation → ${end.status()}`).toBeLessThan(400);
    }

    // The impersonation over, the member's own role (user) answers: no
    // Preview; a Start is a real attempt (the refusal above was the ruling's).
    const refused = await noFollow(ctx.request, previewUrl(s.k!));
    expect(redirectTarget(refused), describe(refused)).toBe(denied());
    expectStartBar((await served(ctx.request, startUrl(s.k!))).html, "own Start");
    const rows = await rowsOf(u.id, s.vK);
    expect(previewsOf(rows).length, "the preview").toBe(1);
    expect(realOf(rows).length, "and one real attempt").toBe(1);
    expect(realOf(rows)[0]).toMatchObject({ ...REAL_ROW, status: "in_progress" });

    // A platform owner with no membership: never a served Start, never a row.
    const outCtx = s.ctx.outsider!;
    const out = await outCtx.request.post("/api/super/impersonate", { data: { org_id: s.org!.id, reason: "lifecycle spec 68 (ADR 0024 P2-5 3c)" } });
    expect(out.status(), `impersonate (no membership) → ${out.status()}`).toBeLessThan(400);
    try {
      const o = await noFollow(outCtx.request, startUrl(s.k!));
      const target = redirectTarget(o);
      expect(o.status === 200 && target === null, `a non-member's Start is not served: ${describe(o)}`).toBe(false);
      const op = await noFollow(outCtx.request, previewUrl(s.k!));
      const cls = (t: string | null) => (t === null ? "rendered" : t.startsWith("/select-org") ? "select-org" : t.includes("denied=1") ? "denied" : "other");
      console.log(`[spec 68] non-member impersonator: Start → ${cls(target)}, Preview → ${cls(redirectTarget(op))}`);
      expect(realOf(await rowsOf(s.users.outsider!.id)), "no real attempt for a non-member").toEqual([]);
    } finally {
      await outCtx.request.delete("/api/super/impersonate");
    }
  });
});
