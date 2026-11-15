/**
 * ADR 0024 (three independent learning products), spec 68
 * `three-product-independence` (step 62). Phase 2 slice P2-5 creates it with
 * the Start and Preview cases (R6, decision A32); P2-6 adds the launch on
 * launch_context in four blocks of their own (below the P2-5 block, each
 * with its own organisation and seed, so a red case hides only its own
 * block); P2-7 onward add grants per context, webhooks and emails.
 *
 * Start and Preview by mode (P2-5). Without ?mode=preview every role is a
 * learner with real rows; ?mode=preview is a preview for the report-viewing
 * roles only (super_owner, admin, data_analyst), whose row is
 * context_kind 'preview', preview_kind 'course', is_preview true,
 * launch_mode 'Normal', with no official tag, and is never official.
 *
 *   (r1-r3) an enrolled admin, super owner and data analyst each press Preview
 *         first and Start second (item 7); a second Preview resumes the
 *         preview. Item 5b's two mixed reads need two orders, so the roles
 *         split them:
 *         (r1, r3) the preview is COMPLETED before the Start (passed for the
 *         admin, failed for the analyst), which an attempt list that counted
 *         previews would read as the official attempt: the Start would be a
 *         revision visit and the real attempt a second, non-official run. So
 *         the Start must be a first official attempt (a new row, no Revision
 *         Mode badge, is_revision false) and the real attempt, passed on its
 *         own token, gets the LMS.OfficialResult note, while the preview gets
 *         none and no XP;
 *         (r2) the preview stays OPEN during the Start, which a routing read
 *         that counted previews would resume or close: the Start writes a new
 *         row beside it; the preview, finished after the real attempt, gets no
 *         note and no XP and leaves the real attempt as it was.
 *         Every role: two rows; the bar reads "Preview: not an official
 *         record" on the preview only; the preview row is deep-equal across
 *         the Start and the real attempt's result (the real attempt is scored
 *         alone); the learner course page offers each role a Preview link;
 *   (run) a preview that names a run is refused (phase P): ?denied=1, no row;
 *   (3b)  a plain enrolled learner's ?mode=preview: ?denied=1 and no
 *         course_attempts row written, before and after a Start of their own;
 *         their course page offers no Preview;
 *   (3c)  impersonation: a platform owner who is a plain member, enrolled,
 *         impersonating the organisation (requireOrgAccess answers
 *         super_owner): a Start is refused with ?denied=1 and writes nothing,
 *         the course page says "You're impersonating, so this course opens
 *         as a preview only." (never "not enrolled": the member is enrolled)
 *         and offers "Preview instead", a Preview is served and
 *         writes one preview row; once the
 *         impersonation ends the member's own role answers (Preview refused,
 *         Start served). A platform owner with no membership: the Start is
 *         never served and writes nothing (requireOrgAccess reads the
 *         organisation on the caller's session before the impersonation, and
 *         the organisations policy admits members only, so the launch never
 *         reaches the impersonation answer; the redirect is logged by class).
 *         Last in its block: it alone depends on the target's configuration
 *         (IMPERSONATION_SECRET on the app server);
 *   (4)   a data analyst not enrolled: the Start is refused with ?denied=1
 *         and writes nothing; the course page says "not enrolled
 *         in this course" and offers "Preview instead"; the Preview is served;
 *   (5b)  one person holds a preview row and a real row of one course:
 *         (a) a Start opens the course's current version while the preview
 *             is open on the retired one;
 *         (b) an open preview on another language does not bounce an explicit
 *             ?lang= Start to the switch confirm;
 *         (c) through the launch's language picker (no ?lang=, no saved
 *             preference), in a browser whose module content never loads:
 *             the Preview's pick saves no preference and opens Hindi; with
 *             that preview open and holding a stored assessment result (a
 *             failed statement on a sub-activity, so it stays in progress),
 *             the Start's pick of English is neither sent to the confirm nor
 *             held (the switch route answers 200, not 409), runs English and
 *             not the preview's Hindi, and closes nothing;
 *         (d) a completed preview of step 1 leaves step 2 of a strict path
 *             locked for a Start, and step 2's own Preview is still served
 *             (a preview runs outside the path's order); the path page offers
 *             a Preview link on each step, with no ?lp=;
 *         (e) an open preview on another language does not reroute a Start
 *             chosen by the saved preference onto its language (the picker of
 *             (c) always ends in an explicit ?lang=, so it never reaches this
 *             routing);
 *   (m)   a preview launch's subrequest count, measured on a local build: the
 *         server-side fetch() calls of a first preview, a resumed preview and
 *         a first Start, counted inside the app server by
 *         ./subrequest-meter.cjs (preloaded into `next start`, never into this
 *         run) and read back from SUBREQUEST_LOG. Recorded, not asserted (40
 *         is P2-6's gate, (m2) below). Registered only when SUBREQUEST_LOG
 *         is set: on a target without the meter a skipped test would turn
 *         the nightly amber (scripts/lifecycle-summary.mjs), as spec 64's
 *         staging note avoids. The middleware's own call is not in the
 *         figure (ADR 0019 estimates one).
 *
 * P2-6, the launch on launch_context (item 8; steps 22 to 26, rulings A3 and
 * P2-Q2). Every Start reads one launch_context call; the resolver's answer
 * decides the product, and its refusals reach the learner as today's
 * notices (every refusal ?denied=1, P2-N5; upcoming and locked as
 * /dashboard?upcoming= and ?locked=; one holder into that product's launch;
 * several, the dashboard until phase 6's chooser).
 *
 *   Block "three products" (learner R, course C held directly, in path P
 *   and on day 1 of a journey):
 *   (p1)  the example learner through three products at launch: the Library,
 *         ?lp=P and ?journey=E&day=<day id> each open a first attempt in its
 *         own context (context_kind, context_key and the tags, the journey's
 *         day id and pinned version), even after the Individual attempt
 *         passed; each relaunch resumes its own row (the journey's also by an
 *         old link's day number, and with an empty ?lp= beside it); a Library
 *         relaunch after the pass is a revision visit in the Individual
 *         context only, recorded under the key 'individual';
 *   (p2)  a forged ?lp= (a path R is not on, an unknown id, not a uuid,
 *         another organisation's path, a course that is no step of P):
 *         ?denied=1, no attempt and no enrolment written;
 *   (p3)  both product parameters; a journey launch with no day, an unknown
 *         enrolment, an unknown day id or a day number the version lacks:
 *         ?denied=1, nothing written;
 *   (p4)  a launch with no parameter of a course R holds only through path Q
 *         goes into Q's launch (?lp=Q), which then opens it in Q's context;
 *         through two paths, to the dashboard; neither redirect writes;
 *   (p5)  the journey page links today's mission by the day's id (item 7).
 *
 *   Block "PostgREST forms" (service role only, no app request):
 *   (rv)  record_revision_visit, six names (key 'individual') and seven
 *         names (the key named), deduplicated per key over 10 seconds;
 *   (cg)  consume_grant, nine names: a path grant is unavailable in another
 *         context, opens a retake with its context in its own, then answers
 *         used; eight names: a journey grant resolves the day number through
 *         the pinned version (a number it lacks is unavailable); an unknown
 *         grant is unavailable from both; a version of another course raises
 *         22023 and consumes nothing;
 *   (rls) the learner's own session can call none of launch_context,
 *         consume_grant or record_revision_visit.
 *
 *   Block "self-enrolment" (step 24, ruling A3, P2-Q2):
 *   (s1)  Start on an "Everyone" course writes one source='self' user row
 *         (assigned by the learner, no dates) and opens the attempt in the
 *         same render: launch_context's second call reads the insert (step
 *         25's mid-render write); a second Start adds no row; an admin's
 *         assignment without dates converts the row (source admin, assigned
 *         by the admin, same id), a dated one sets the admin's date;
 *   (s2)  the same on step 1 of an "Everyone" strict path, with the path
 *         attempt in path:P; step 2 stays locked; an admin's dated path
 *         assignment converts the row;
 *   (a3)  a learner not enrolled presses Start on step 2: the self row is
 *         recorded first, then the strict order sends them to ?locked=, no
 *         attempt;
 *   (q2a) a learner whose own assignment of an "Everyone" course is dated in
 *         the future: ?upcoming=, no attempt, the admin's row unchanged;
 *   (q2b) a learner whose team holds the dated assignment starts at once,
 *         with a source='self' row of their own; the team row unchanged.
 *
 *   Block "grants in context" (fixture rows through the service role):
 *   (st)  a stale path grant: consume_grant expires it in the render, the
 *         rerun reads the fresh grants, and the launch is a revision visit
 *         in path:P recorded under that key;
 *   (w)   the worst path of step 70: a self-enrolling learner's first launch
 *         of step 2 of an "Everyone" strict path that consumes a path grant
 *         (A3: launch_context reads step 1 as not done before the insert and
 *         done after it, in the same render);
 *   (m2)  item 9's measured count, branch by branch, on a local build with
 *         the meter (registered only when SUBREQUEST_LOG is set): the worst
 *         path is asserted at or under 40 with the middleware's one call;
 *         the other branches are recorded;
 *   (u)   the evaluate rerun after 'used' (step 25): four concurrent Starts
 *         on one unused path grant all serve the one retake (the 'used'
 *         answer needs a request whose grant read precedes the winner's
 *         commit: reliable at a runner's latency, not guaranteed where calls
 *         take a few milliseconds, spec 53 (5)'s disclosure). Last in its
 *         block, so a red there skips neither (w) nor (m2).
 *
 * Needs 0107 on the target database: every seed FAILS without it. By hand on
 * staging after the code is deployed, never while another lifecycle run is in
 * progress; after one green run it joins PRODUCT_SPECS in
 * scripts/lifecycle-nightly.sh (step 73). Data stays in the lifecycle-*
 * namespace; the two platform-owner marks are removed in afterAll. Logs carry
 * ids and counts only.
 */
import { test, expect, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { addMember, createAuthUser, createOrg, markPlatformOwner, rand, svc } from "./data";
import { assignCourse, authedContext, courseHandle, grantDecidedAfter, GUARDIAN_ROUTE_TIMEOUT_MS } from "./helpers";
import {
  authTokenFor,
  cmi5Zip,
  fixtureAttemptContext,
  has0107,
  sessionClient,
  uploadNew,
  VERB,
  XAPI_HEADERS,
  zipFile,
} from "./p0-helpers";
import { todayStr } from "../../../lib/journey/journey";

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

/**
 * A scored answer inside the AU, as an assessment block sends it: a failed
 * statement whose object is a sub-activity. It is stored on the attempt (the
 * switch route's hold looks for a stored passed or failed), and the attempt
 * stays in progress (only the AU's own outcome completes it).
 */
async function assessInside(req: APIRequestContext, u: User, attemptId: string) {
  const auth = await authTokenFor(req, attemptId);
  const res = await req.post("/api/xapi/statements", {
    headers: { ...XAPI_HEADERS, Authorization: auth },
    data: [
      statement(u, "initialized", attemptId),
      statement(u, "failed", attemptId, {
        object: { objectType: "Activity", id: `${AU}/assessment` },
        result: { success: false, score: { scaled: 0.3 } },
      }),
    ],
  });
  expect(res.status(), await res.text()).toBe(200);
}

async function outcomeStatements(attemptId: string): Promise<number> {
  const { count, error } = await svc()
    .from("xapi_statements")
    .select("statement_id", { count: "exact", head: true })
    .eq("attempt_id", attemptId)
    .in("verb", [VERB("passed"), VERB("failed")]);
  expect(error, `statements read: ${error?.message}`).toBeNull();
  return count ?? 0;
}

async function savedLanguage(userId: string, courseId: string): Promise<string | null> {
  const { data, error } = await svc()
    .from("course_language_preferences")
    .select("language")
    .eq("user_id", userId)
    .eq("course_id", courseId)
    .maybeSingle();
  expect(error, `preference read: ${error?.message}`).toBeNull();
  return (data as { language?: string } | null)?.language ?? null;
}

// ── the launch's language picker, in a browser (5b-c) ───────────────────────
type Sent = { method: string; url: string };

/**
 * A launch that renders the language picker (no ?lang=, no saved preference),
 * in a page whose module content never loads (spec 63's launchPage), so no
 * fixture spends an attempt's fetch token. `sent` lists the page's requests.
 */
async function pickerPage(ctx: BrowserContext, url: string): Promise<{ page: Page; sent: Sent[] }> {
  const page = await ctx.newPage();
  await page.route(/\/content\//, (r) => r.abort());
  const sent: Sent[] = [];
  page.on("request", (r) => sent.push({ method: r.method(), url: r.url() }));
  const res = await page.goto(url, { timeout: 120_000 });
  expect(res?.status(), `${url} → ${res?.status()}`).toBe(200);
  await expect(page.getByRole("heading", { name: "Choose your language" }), `${url}: the launch's language picker`).toBeVisible({
    timeout: 60_000,
  });
  return { page, sent };
}

/**
 * Picks `code` on the picker. The click is retried until hydration has
 * attached the handler, and never once `handled()` says the handler ran (it
 * sent its request): the buttons are then disabled and the page navigates.
 */
async function pick(page: Page, code: string, handled: () => boolean) {
  const button = page.getByRole("button").filter({ has: page.locator("code", { hasText: new RegExp(`^${code}$`) }) });
  await expect(button, `the picker offers ${code}`).toHaveCount(1);
  await expect(async () => {
    if (!handled()) await button.click({ timeout: 5_000 });
    expect(handled(), `the pick of ${code} reached the picker's handler`).toBe(true);
  }).toPass({ timeout: 30_000 });
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
    // member platform owner on K; the admin on V; the analyst (5b-b), the
    // super owner (5b-c) and the admin (5b-e) on L. The analyst holds nothing
    // on the path (case 4).
    for (const u of [admin, owner, analyst, learner, meter, imp]) await assignCourse(areq, org.slug, s.k, u.id);
    await assignCourse(areq, org.slug, s.v, admin.id);
    for (const u of [analyst, owner, admin]) await assignCourse(areq, org.slug, lId, u.id);

    for (const key of Object.keys(s.users) as Array<keyof typeof s.users>) {
      const u = s.users[key]!;
      s.ctx[key] = await authedContext(browser, baseURL!, u.email, u.password);
    }
  });

  // Item 5b's two mixed reads need two orders (header, r1-r3). "completed": the
  // preview is finished before the Start, so an attempt list that counted it
  // would make the Start a revision visit and the real attempt a second,
  // non-official run. "open": the preview is open during the Start, so a
  // routing read that counted it would resume or close it.
  for (const [n, key, label, order, previewOutcome, previewScore] of [
    ["r1", "admin", "admin", "completed", "passed", 0.9],
    ["r2", "owner", "super owner", "open", "failed", 0.2],
    ["r3", "analyst", "data analyst", "completed", "failed", 0.3],
  ] as const) {
    const how = order === "completed" ? "the preview completed, then Start" : "then Start with the preview open";
    test(`(${n}) an enrolled ${label}: Preview first, ${how}; a first official attempt beside the preview, scored alone`, async () => {
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

      if (order === "completed") {
        // The preview's own result, before the Start: never official.
        await finish(req, u, previewId, previewOutcome, previewScore);
        const done = await fullRow(previewId);
        expect([done.completion_status, done.success_status], "the preview is complete before the Start").toEqual(["completed", previewOutcome]);
        expect(await noteStatus(previewId), "no official note for the preview").toBeNull();
        expect(await xpCount(previewId), "no XP for the preview").toBe(0);
      }
      const previewBefore = await fullRow(previewId);

      // Start: a new real row beside the preview, a first official attempt.
      const st = await served(req, startUrl(s.k!));
      expect(st.src).toContain(`/content/v/${s.vK}/`);
      expectStartBar(st.html, "Start");
      rows = await rowsOf(u.id, s.vK);
      expect(rows.length, "two rows: the preview and the real attempt").toBe(2);
      const real = realOf(rows);
      expect(real.length, "one real row").toBe(1);
      expect(real[0].id, "a new row: the Start never resumes the preview").not.toBe(previewId);
      expect(real[0], "a first attempt, not a revision visit").toMatchObject({ ...REAL_ROW, status: "in_progress" });
      expect([null, "Normal"], "a learner's launch mode (Normal with ALDS_P4 on), never Review").toContain(real[0].launch_mode);
      expect(
        await fullRow(previewId),
        order === "completed" ? "the Start left the completed preview as it was" : "the Start left the open preview as it was: not resumed, not closed"
      ).toEqual(previewBefore);

      // The real attempt, passed on its own token, is the official one: had the
      // completed preview been counted, it would hold the official slot and
      // this row would get no note.
      await finish(req, u, real[0].id, "passed", 0.8);
      const realAfter = await fullRow(real[0].id);
      expect([realAfter.status, realAfter.success_status, realAfter.score]).toEqual(["passed", "passed", 0.8]);
      expect(await noteStatus(real[0].id), "the official result note on the real attempt").toBe("passed");
      expect(await fullRow(previewId), "the preview is still as it was").toEqual(previewBefore);
      expect(await noteStatus(previewId), "no note on the preview").toBeNull();
      expect(await xpCount(previewId), "no XP for the preview").toBe(0);

      if (order === "open") {
        // The preview, finished afterwards: never official; the real attempt stays.
        await finish(req, u, previewId, previewOutcome, previewScore);
        const previewDone = await fullRow(previewId);
        expect([previewDone.completion_status, previewDone.success_status], "the preview's own result").toEqual(["completed", previewOutcome]);
        expect(await noteStatus(previewId), "no official note for the preview").toBeNull();
        expect(await xpCount(previewId), "no XP for the preview").toBe(0);
        expect(await fullRow(real[0].id), "the real attempt is as its own result left it").toEqual(realAfter);
        expect(await noteStatus(real[0].id), "the real attempt's note is unchanged").toBe("passed");
      }
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

  test("(5b-c) through the launch's language picker, an open assessed preview on Hindi neither confirms nor holds a Start of English, which runs English, not the preview's Hindi", async () => {
    const u = s.users.owner!;
    const ctx = s.ctx.owner!;
    const L = s.l!;
    const launchPath = `/${slug()}/courses/${L.courseId}/launch`;
    const prefPath = `/api/courses/${L.courseId}/language-preference`;
    const isPut = (r: Sent) => r.method === "PUT" && new URL(r.url).pathname === prefPath;
    expect(await savedLanguage(u.id, L.courseId), "no saved language: the launch shows its picker").toBeNull();
    expect(await rowsOf(u.id, L.enVersion), "nothing on English yet").toEqual([]);
    expect(await rowsOf(u.id, L.hiVersion), "nothing on Hindi yet").toEqual([]);

    // The Preview: the picker's Hindi opens the preview, with no PUT.
    const p = await pickerPage(ctx, previewUrl(L.courseId));
    const toHi = (x: URL) => x.pathname === launchPath && x.searchParams.get("lang") === "hi" && x.searchParams.get("mode") === "preview";
    await pick(p.page, "hi", () => p.sent.some((r) => r.method === "GET" && toHi(new URL(r.url))));
    await p.page.waitForURL(toHi, { timeout: 120_000 });
    await expect(p.page.getByTestId("launch-bar"), "the Hindi preview runs").toBeVisible({ timeout: 60_000 });
    await expect(p.page.getByTestId("preview-badge"), "the preview's bar").toHaveCount(1);
    expect(await p.page.locator("iframe").first().getAttribute("src"), "Hindi runs").toContain(`/content/v/${L.hiVersion}/`);
    expect(p.sent.filter(isPut).length, "a Preview's pick sends no switch").toBe(0);
    await p.page.close();
    expect(await savedLanguage(u.id, L.courseId), "a Preview saves no language preference").toBeNull();
    const [pv] = await rowsOf(u.id, L.hiVersion);
    expect(pv).toMatchObject({ ...PREVIEW_ROW, status: "in_progress" });

    // An answer inside the preview's assessment: a switch route that counted
    // the preview would hold the Start (requires_finish), and without it would
    // send the Start to its confirm (requires_confirm).
    await assessInside(ctx.request, u, pv.id);
    expect(await outcomeStatements(pv.id), "the preview holds a stored assessment result").toBe(1);
    const previewBefore = await fullRow(pv.id);
    expect(previewBefore.status, "the preview is still open").toBe("in_progress");
    expect(previewBefore.completion_status, "a sub-activity's result does not complete it").not.toBe("completed");

    // The Start: the picker's English goes through the switch route.
    const st = await pickerPage(ctx, startUrl(L.courseId));
    const put = st.page.waitForResponse((r) => r.request().method() === "PUT" && new URL(r.url()).pathname === prefPath, {
      timeout: 60_000,
    });
    // If the pick fails first, its own error is the case's; the wait's later
    // timeout must not land on another case.
    put.catch(() => {});
    await pick(st.page, "en", () => st.sent.some(isPut));
    const putRes = await put;
    const putStatus = putRes.status();
    const putBody = putStatus === 200 ? "" : await putRes.text().catch(() => "");
    expect(putStatus, `the picker's switch is neither sent to the confirm nor held (409): ${putBody}`).toBe(200);
    await expect(st.page.getByTestId("launch-bar"), "the Start runs (not the switch confirm, not the picker's message)").toBeVisible({
      timeout: 120_000,
    });
    const at = new URL(st.page.url());
    expect([at.pathname, at.searchParams.get("lang"), at.searchParams.has("mode")], "the launch of English, not a preview").toEqual([
      launchPath,
      "en",
      false,
    ]);
    await expect(st.page.getByTestId("preview-badge"), "not a preview").toHaveCount(0);
    await expect(st.page.getByTestId("practice-badge"), "not a revision visit").toHaveCount(0);
    expect(await st.page.locator("iframe").first().getAttribute("src"), "English runs, not the preview's Hindi").toContain(
      `/content/v/${L.enVersion}/`
    );
    expect(st.sent.filter(isPut).length, "one switch request").toBe(1);
    await st.page.close();

    expect(await savedLanguage(u.id, L.courseId), "the Start's pick saved English").toBe("en");
    const en = await rowsOf(u.id, L.enVersion);
    expect(en.length, "one real attempt in English").toBe(1);
    expect(en[0]).toMatchObject({ ...REAL_ROW, status: "in_progress" });
    expect((await rowsOf(u.id, L.hiVersion)).map((x) => x.id), "Hindi holds only the preview").toEqual([pv.id]);
    expect(await fullRow(pv.id), "the preview is as it was: open, not closed by the switch").toEqual(previewBefore);
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

  test("(5b-e) an open preview on Hindi does not reroute a Start chosen by the saved preference (English)", async () => {
    const u = s.users.admin!;
    const req = s.ctx.admin!.request;
    const L = s.l!;
    expect(await rowsOf(u.id, L.enVersion), "nothing on English yet").toEqual([]);
    // The preference first, so the Start below is chosen by it (the picker of
    // (5b-c) always ends in an explicit ?lang=). (5b-c) holds the switch
    // route's own answer with a preview open.
    const pref = await req.put(`/api/courses/${L.courseId}/language-preference`, { data: { orgSlug: slug(), language: "en" } });
    expect(pref.status(), await pref.text()).toBe(200);
    expect((await served(req, previewUrl(L.courseId, "&lang=hi"))).src).toContain(`/content/v/${L.hiVersion}/`);
    const [pv] = await rowsOf(u.id, L.hiVersion);
    expect(pv).toMatchObject({ ...PREVIEW_ROW, status: "in_progress" });
    const previewBefore = await fullRow(pv.id);

    const st = await served(req, startUrl(L.courseId));
    expect(st.src, "the preference's language runs, not the preview's").toContain(`/content/v/${L.enVersion}/`);
    expectStartBar(st.html, "Start");
    const en = await rowsOf(u.id, L.enVersion);
    expect(en.length, "one real attempt in English").toBe(1);
    expect(en[0]).toMatchObject({ ...REAL_ROW, status: "in_progress" });
    expect((await rowsOf(u.id, L.hiVersion)).map((x) => x.id), "Hindi holds only the preview").toEqual([pv.id]);
    expect(await fullRow(pv.id), "the preview is as it was").toEqual(previewBefore);
  });

  // Registered only where the meter runs (the app server here with
  // NODE_OPTIONS=--require ./tests/bot/lifecycle/subrequest-meter.cjs and
  // SUBREQUEST_LOG set for both): a skipped test would turn the nightly amber.
  if (METER_LOG) test("(m) a preview launch's subrequest count, measured on a local build", async () => {
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

  // Last in its block: the one case that depends on the target's configuration
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
      // The course page offers an impersonator the preview only, with its own
      // line: the member is enrolled in K, so never "not enrolled". (The
      // asserted copy has no apostrophe: React escapes one in served HTML.)
      const cp = await ctx.request.get(`/${slug()}/courses/${s.k}`, { timeout: 120_000 });
      expect(cp.ok(), `course page → ${cp.status()}`).toBeTruthy();
      const cpHtml = text(await cp.text());
      expect(cpHtml, "the impersonation card").toContain('data-testid="impersonation-preview-only"');
      expect(cpHtml, "the impersonation line").toContain("impersonating, so this course opens as a preview only.");
      expect(cpHtml, "no not-enrolled card for an enrolled impersonator").not.toContain('data-testid="not-enrolled"');
      expect(cpHtml, "no not-enrolled line for an enrolled impersonator").not.toContain("not enrolled in this course");
      expect(cpHtml, "Preview instead, for an impersonator").toContain('data-testid="preview-instead"');

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

// ════════════════════════════════════════════════════════════════════════════
// P2-6: the launch on launch_context (ADR 0024 phase 2, item 8). Four blocks,
// each with its own organisation and seed: a failed test restarts the worker
// and skips the rest of its own block only, and no block reads another's seed.
// ════════════════════════════════════════════════════════════════════════════

type Course = { id: string; v: string };
type Journey = { programId: string; dayId: string; versionId: string };
/** A course_attempts row with its context columns (0107). */
type CtxAtt = Att & {
  journey_day: number | null;
  journey_day_id: string | null;
  journey_version_id: string | null;
  context_key: string | null;
};
const CTX_COLUMNS = `${ATT_COLUMNS}, journey_day, journey_day_id, journey_version_id, context_key`;
/** An enrolment row (course_assignments or learning_path_assignments), as P2-6 writes and converts it. */
type Enrolment = {
  id: string;
  assignee_type: string;
  user_id: string | null;
  team_id: string | null;
  source: string;
  assigned_by: string | null;
  due_at: string | null;
  organization_id: string;
};
const ENROLMENT_COLUMNS = "id, assignee_type, user_id, team_id, source, assigned_by, due_at, organization_id";
type CourseEnrolment = Enrolment & { release_at: string | null };
type Grant = { status: string; used_at: string | null; used_attempt_id: string | null; decision_note: string | null; context_key: string | null };
/** launch_context's path answer (0107 section 6p), the keys these cases read. */
type PathFact = {
  found: boolean;
  visibility?: string;
  sequence_mode?: string | null;
  enrolled?: boolean;
  self_row?: boolean;
  course_step?: number | null;
  steps?: Array<{ course_id: string; step_number: number; done: boolean }>;
};
type ConsumeAnswer = { outcome: string; attempt_id: string | null; abandoned_ids: string[] | null };

/** The middleware's own subrequest, which the meter does not see (ADR 0019 estimates one). */
const MIDDLEWARE_SUBREQUESTS = 1;
/** Step 70's gate for one launch request: 40 of the Workers budget of 50. */
const LAUNCH_BUDGET = 40;
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const sameInstant = (a: string | null | undefined, b: string | null | undefined) =>
  typeof a === "string" && typeof b === "string" && Date.parse(a) === Date.parse(b);

async function ctxRows(userId: string, versionId?: string): Promise<CtxAtt[]> {
  let q = svc().from("course_attempts").select(CTX_COLUMNS).eq("user_id", userId);
  if (versionId) q = q.eq("course_version_id", versionId);
  const { data, error } = await q.order("started_at");
  expect(error, `attempts read: ${error?.message}`).toBeNull();
  return (data ?? []) as unknown as CtxAtt[];
}

/** Every attempt id of a user, sorted: a refusal writes none. */
const attemptIds = async (userId: string) => (await ctxRows(userId)).map((r) => r.id).sort();

/** The attempt a served cmi5 launch runs: its registration (the launch page's cmi5 launch parameters). */
function registrationOf(src: string): string | null {
  try {
    return new URL(src, "http://x.invalid").searchParams.get("registration");
  } catch {
    return null;
  }
}

async function courseEnrolments(courseId: string, userId: string): Promise<CourseEnrolment[]> {
  const { data, error } = await svc()
    .from("course_assignments")
    .select(`${ENROLMENT_COLUMNS}, release_at`)
    .eq("course_id", courseId)
    .eq("user_id", userId)
    .order("assigned_at");
  expect(error, `course enrolment read: ${error?.message}`).toBeNull();
  return (data ?? []) as unknown as CourseEnrolment[];
}

async function pathEnrolments(pathId: string, userId: string): Promise<Enrolment[]> {
  const { data, error } = await svc()
    .from("learning_path_assignments")
    .select(ENROLMENT_COLUMNS)
    .eq("path_id", pathId)
    .eq("user_id", userId)
    .order("assigned_at");
  expect(error, `path enrolment read: ${error?.message}`).toBeNull();
  return (data ?? []) as unknown as Enrolment[];
}

/** Every enrolment row naming the user, of courses and paths, sorted: a refusal writes none. */
async function enrolmentIds(userId: string): Promise<string[]> {
  const ids: string[] = [];
  for (const table of ["course_assignments", "learning_path_assignments"]) {
    const { data, error } = await svc().from(table).select("id").eq("user_id", userId);
    expect(error, `${table} read: ${error?.message}`).toBeNull();
    ids.push(...((data ?? []) as Array<{ id: string }>).map((r) => r.id));
  }
  return ids.sort();
}

/** launch_context's path facts, read through the service role as the launch page reads them. */
async function pathFacts(userId: string, orgId: string, courseId: string, pathId: string): Promise<PathFact> {
  const { data, error } = await svc().rpc("launch_context", {
    p_user: userId,
    p_org: orgId,
    p_course: courseId,
    p_path: pathId,
    p_enrollment: null,
    p_day_id: null,
    p_day: null,
  });
  expect(error, `launch_context: ${error?.code} ${error?.message}`).toBeNull();
  return ((data as { path?: PathFact | null } | null)?.path ?? { found: false }) as PathFact;
}

const stepDone = (f: PathFact, step: number) => f.steps?.find((x) => x.step_number === step)?.done ?? null;

async function grantRow(id: string): Promise<Grant> {
  const { data, error } = await svc()
    .from("attempt_requests")
    .select("status, used_at, used_attempt_id, decision_note, context_key")
    .eq("id", id)
    .single();
  expect(error, `grant ${id}: ${error?.message}`).toBeNull();
  return data as Grant;
}

async function visitsOf(userId: string, courseId?: string): Promise<Array<{ context_key: string; attempt_id: string | null }>> {
  let q = svc().from("revision_visits").select("context_key, attempt_id").eq("user_id", userId);
  if (courseId) q = q.eq("course_id", courseId);
  const { data, error } = await q.order("launched_at");
  expect(error, `visits read: ${error?.message}`).toBeNull();
  return (data ?? []) as Array<{ context_key: string; attempt_id: string | null }>;
}

async function newLearner(orgId: string, key: string): Promise<User> {
  const u = (await createAuthUser({ profile: { first_name: "Contexts", last_name: key, must_change_password: false } })) as User;
  await addMember({ organizationId: orgId, userId: u.id, role: "user" });
  return u;
}

/** A cmi5 course uploaded through the app (distinct course id and title: the integrity check). */
async function cmi5Course(req: APIRequestContext, orgSlug: string, tag: string, key: string, title: string): Promise<Course> {
  const r = await uploadNew(req, orgSlug, `${key}.zip`, await cmi5Zip({ courseId: `urn:qa:launchctx:${tag}:${key}`, title }));
  expect(r.ok(), `upload ${key} → ${r.status()}: ${await r.text()}`).toBeTruthy();
  const id = (await r.json()).courseId as string;
  return { id, v: (await courseHandle(id)).versionId };
}

/** A course with one cmi5 version, written through the service role only (no file; never launched). */
async function bareCourse(orgId: string, title: string): Promise<Course> {
  const db = svc();
  const { data: c, error: ce } = await db
    .from("courses")
    .insert({ organization_id: orgId, title, slug: `qa-lctx-${rand(6)}`, status: "published" })
    .select("id")
    .single();
  expect(ce, `course ${title}: ${ce?.message}`).toBeNull();
  const id = (c as { id: string }).id;
  const { data: p, error: pe } = await db.from("course_packages").insert({ course_id: id, language: "en", display_name: "English" }).select("id").single();
  expect(pe, `package ${title}: ${pe?.message}`).toBeNull();
  const { data: v, error: ve } = await db
    .from("course_versions")
    .insert({
      course_id: id,
      version_number: 1,
      manifest_type: "cmi5",
      launch_url: "index.html",
      storage_prefix: `courses/${id}/v1/`,
      manifest_data: { raw: { auId: `urn:qa:launchctx:${rand(6)}` } },
      package_id: (p as { id: string }).id,
    })
    .select("id")
    .single();
  expect(ve, `version ${title}: ${ve?.message}`).toBeNull();
  const vid = (v as { id: string }).id;
  const { error: ue } = await db.from("courses").update({ current_version_id: vid }).eq("id", id);
  expect(ue, `current version ${title}: ${ue?.message}`).toBeNull();
  return { id, v: vid };
}

async function newPath(
  orgId: string,
  name: string,
  opts: { visibility: "private" | "org_public"; sequence: "strict" | "random" },
  steps: string[]
): Promise<string> {
  const { data, error } = await svc()
    .from("learning_paths")
    .insert({ organization_id: orgId, name, slug: `qa-lctx-${rand(6)}`, sequence_mode: opts.sequence, visibility: opts.visibility, is_active: true })
    .select("id")
    .single();
  expect(error, `path ${name}: ${error?.message}`).toBeNull();
  const pathId = (data as { id: string }).id;
  if (steps.length > 0) {
    const { error: se } = await svc()
      .from("learning_path_courses")
      .insert(steps.map((courseId, i) => ({ path_id: pathId, course_id: courseId, step_number: i + 1 })));
    expect(se, `path ${name} steps: ${se?.message}`).toBeNull();
  }
  return pathId;
}

/** An admin's path assignment of one learner (source defaults to 'admin'). */
async function assignPath(orgId: string, pathId: string, userId: string): Promise<void> {
  const { error } = await svc().from("learning_path_assignments").insert({ organization_id: orgId, path_id: pathId, assignee_type: "user", user_id: userId });
  expect(error, `path assignment: ${error?.message}`).toBeNull();
}

/**
 * A one-day journey whose day 1 is `courseId`, open today in either unlock
 * mode (count_sundays, so any weekday): spec 55 (j)'s shape, the day row
 * before the version, which names the day's id itself (day_ids, source
 * 'editor'; ADR 0024 step 64, P2-N9).
 */
async function oneDayJourney(orgId: string, name: string, courseId: string): Promise<Journey> {
  const db = svc();
  const { data: program, error: pErr } = await db
    .from("journey_programs")
    .insert({ organization_id: orgId, name, days_total: 1, count_sundays: true })
    .select("id")
    .single();
  expect(pErr, `program ${name}: ${pErr?.message}`).toBeNull();
  const programId = (program as { id: string }).id;
  const { data: day, error: dErr } = await db
    .from("journey_days")
    .insert({ program_id: programId, organization_id: orgId, day_number: 1, course_id: courseId, mission_title: `${name} mission` })
    .select("id")
    .single();
  expect(dErr, `journey day ${name}: ${dErr?.message}`).toBeNull();
  const dayId = (day as { id: string }).id;
  const { data: jv, error: vErr } = await db
    .from("journey_versions")
    .insert({
      program_id: programId,
      organization_id: orgId,
      version_number: 1,
      name,
      days_total: 1,
      count_sundays: true,
      completion_title: "Yoddha",
      days: [{ day: 1, course_id: courseId, mission_title: `${name} mission` }],
      day_ids: { "1": dayId },
      day_ids_source: "editor",
    })
    .select("id")
    .single();
  expect(vErr, `journey version ${name}: ${vErr?.message}`).toBeNull();
  const versionId = (jv as { id: string }).id;
  const { error: cErr } = await db.from("journey_programs").update({ current_version_id: versionId }).eq("id", programId);
  expect(cErr, `program version ${name}: ${cErr?.message}`).toBeNull();
  return { programId, dayId, versionId };
}

async function enrolJourney(j: Journey, orgId: string, userId: string): Promise<string> {
  const { data, error } = await svc()
    .from("journey_enrollments")
    .insert({ program_id: j.programId, version_id: j.versionId, organization_id: orgId, user_id: userId, start_date: todayStr(), status: "active" })
    .select("id")
    .single();
  expect(error, `journey enrolment: ${error?.message}`).toBeNull();
  return (data as { id: string }).id;
}

/** A completed official attempt in a path's context (fixture row through the service role; ADR 0024 step 64). */
async function pathAttempt(o: {
  versionId: string;
  userId: string;
  orgId: string;
  pathId: string;
  outcome: "passed" | "failed";
  completedAt: string;
}): Promise<string> {
  const { data, error } = await svc()
    .from("course_attempts")
    .insert({
      course_version_id: o.versionId,
      user_id: o.userId,
      organization_id: o.orgId,
      status: o.outcome,
      completion_status: "completed",
      success_status: o.outcome,
      score: o.outcome === "passed" ? 0.9 : 0.3,
      started_at: new Date(Date.parse(o.completedAt) - 600_000).toISOString(),
      completed_at: o.completedAt,
      cmi_data: {},
      ...fixtureAttemptContext({ learning_path_id: o.pathId }),
    })
    .select("id")
    .single();
  expect(error, `path fixture attempt: ${error?.message}`).toBeNull();
  return (data as { id: string }).id;
}

/** An approved, unused grant of one retake in a path's context (context_key path:<id>, generated). */
async function pathGrant(o: { orgId: string; courseId: string; userId: string; pathId: string; decidedBy: string; decidedAt: string }): Promise<string> {
  const { data, error } = await svc()
    .from("attempt_requests")
    .insert({
      organization_id: o.orgId,
      course_id: o.courseId,
      user_id: o.userId,
      status: "approved",
      source: "bulk",
      decided_by: o.decidedBy,
      decided_at: o.decidedAt,
      context_kind: "path",
      learning_path_id: o.pathId,
    })
    .select("id")
    .single();
  expect(error, `path grant: ${error?.message}`).toBeNull();
  return (data as { id: string }).id;
}

function expectRevisionBar(html: string, what: string) {
  expect(html, `${what}: not a preview`).not.toContain(PREVIEW_COPY);
  expect(html, `${what}: a revision visit's badge`).toContain('data-testid="practice-badge"');
}

test.describe.serial("ADR 0024 P2-6 — one learner through three products at launch; refusals and holders", () => {
  const s: {
    org?: { id: string; slug: string };
    adminCtx?: BrowserContext;
    r?: User;
    rCtx?: BrowserContext;
    /** C: R's course in all three products. */
    c?: Course;
    /** D: held by R only through path Q (step 1). */
    d?: Course;
    /** D2: held by R through Q (step 2) and Q2 (step 1). */
    d2?: Course;
    p?: string;
    q?: string;
    q2?: string;
    /** X: a private path that holds C, which R is not on. */
    x?: string;
    otherPath?: string;
    j?: Journey;
    enr?: string;
  } = {};
  const slug = () => s.org!.slug;
  const startUrl = (courseId: string, q = "") => `/${slug()}/courses/${courseId}/launch${q}`;
  const denied = () => `/${slug()}/dashboard?denied=1`;

  test.afterAll(async () => {
    await s.rCtx?.close().catch(() => {});
    await s.adminCtx?.close().catch(() => {});
  });

  test("seed: courses C, D, D2; paths P (C), Q (D, D2), Q2 (D2), X (C) and another organisation's path; a one-day journey on C; learner R on C, P, Q, Q2 and the journey", async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(600_000);
    expect(await has0107(), "0107 is not applied on this database: P2-6's launch reads launch_context").toBe(true);
    const org = await createOrg({ name: "Lifecycle Launch Contexts" });
    s.org = org;
    const admin = (await createAuthUser({ profile: { first_name: "Contexts", last_name: "Admin", must_change_password: false } })) as User;
    await addMember({ organizationId: org.id, userId: admin.id, role: "admin" });
    s.adminCtx = await authedContext(browser, baseURL!, admin.email, admin.password);
    const areq = s.adminCtx.request;
    s.r = await newLearner(org.id, "R");

    const tag = rand(6);
    s.c = await cmi5Course(areq, org.slug, tag, "c", "QA Contexts C");
    s.d = await cmi5Course(areq, org.slug, tag, "d", "QA Contexts D");
    s.d2 = await cmi5Course(areq, org.slug, tag, "d2", "QA Contexts D2");
    s.p = await newPath(org.id, "Contexts P", { visibility: "private", sequence: "strict" }, [s.c.id]);
    s.q = await newPath(org.id, "Contexts Q", { visibility: "private", sequence: "strict" }, [s.d.id, s.d2.id]);
    s.q2 = await newPath(org.id, "Contexts Q2", { visibility: "private", sequence: "random" }, [s.d2.id]);
    s.x = await newPath(org.id, "Contexts X", { visibility: "private", sequence: "strict" }, [s.c.id]);
    const other = await createOrg({ name: "Lifecycle Launch Contexts Other" });
    s.otherPath = await newPath(other.id, "Contexts Other", { visibility: "private", sequence: "strict" }, []);

    await assignCourse(areq, org.slug, s.c.id, s.r.id);
    for (const pathId of [s.p, s.q, s.q2]) await assignPath(org.id, pathId, s.r.id);
    s.j = await oneDayJourney(org.id, "Contexts Journey", s.c.id);
    s.enr = await enrolJourney(s.j, org.id, s.r.id);
    s.rCtx = await authedContext(browser, baseURL!, s.r.email, s.r.password);
  });

  test("(p1) the example learner through three products: the Library, ?lp=P and the journey day each open a first attempt in its own context; each relaunch resumes its own row", async () => {
    const r = s.r!;
    const req = s.rCtx!.request;
    const C = s.c!;
    const j = s.j!;
    expect(await ctxRows(r.id), "nothing before").toEqual([]);

    // The Library: the Individual product, passed on its own token.
    const lib = await served(req, startUrl(C.id));
    expectStartBar(lib.html, "Library Start");
    let rows = await ctxRows(r.id, C.v);
    expect(rows.length, "one row after the Library Start").toBe(1);
    const ind = rows[0];
    expect(ind).toMatchObject({ ...REAL_ROW, context_key: "individual", journey_day_id: null, status: "in_progress" });
    expect(registrationOf(lib.src), "the Library launch runs the Individual row").toBe(ind.id);
    await finish(req, r, ind.id, "passed", 0.9);
    const indDone = await fullRow(ind.id);
    expect([indDone.completion_status, indDone.success_status], "the Individual result").toEqual(["completed", "passed"]);

    // The path: a first attempt in path:P, never a revision visit of the
    // Individual result (each product has its own official attempt).
    const viaPath = await served(req, startUrl(C.id, `?lp=${s.p}`));
    expectStartBar(viaPath.html, "path Start");
    rows = await ctxRows(r.id, C.v);
    const inPath = rows.filter((x) => x.context_kind === "path");
    expect(inPath.length, "one path row").toBe(1);
    expect(inPath[0]).toMatchObject({
      context_kind: "path",
      context_key: `path:${s.p}`,
      learning_path_id: s.p,
      journey_enrollment_id: null,
      journey_day_id: null,
      is_preview: false,
      is_revision: false,
      status: "in_progress",
    });
    expect(registrationOf(viaPath.src), "the path launch runs the path row").toBe(inPath[0].id);

    // The journey day, by its id (the link the journey page makes).
    const viaDay = await served(req, startUrl(C.id, `?journey=${s.enr}&day=${j.dayId}`));
    expectStartBar(viaDay.html, "journey Start");
    rows = await ctxRows(r.id, C.v);
    const inDay = rows.filter((x) => x.context_kind === "journey");
    expect(inDay.length, "one journey row").toBe(1);
    expect(inDay[0]).toMatchObject({
      context_kind: "journey",
      context_key: `journey:${s.enr}:${j.dayId}`,
      journey_enrollment_id: s.enr,
      journey_day: 1,
      journey_day_id: j.dayId,
      journey_version_id: j.versionId,
      learning_path_id: null,
      is_preview: false,
      is_revision: false,
      status: "in_progress",
    });
    expect(registrationOf(viaDay.src), "the journey launch runs the journey row").toBe(inDay[0].id);
    expect(rows.length, "three rows of one version, one per product").toBe(3);
    expect(await fullRow(ind.id), "the Individual result as its own run left it").toEqual(indDone);

    // Each relaunch resumes its own row.
    const mine = [ind.id, inPath[0].id, inDay[0].id];
    for (const [what, q, want] of [
      ["the path again", `?lp=${s.p}`, inPath[0].id],
      ["the journey day again, by its id", `?journey=${s.enr}&day=${j.dayId}`, inDay[0].id],
      ["the journey day by an old link's number", `?journey=${s.enr}&day=1`, inDay[0].id],
      ["the journey day with an empty ?lp= beside it (an empty parameter is absent)", `?lp=&journey=${s.enr}&day=${j.dayId}`, inDay[0].id],
    ] as const) {
      const again = await served(req, startUrl(C.id, q));
      expectStartBar(again.html, what);
      expect(registrationOf(again.src), `${what}: resumes its own row`).toBe(want);
    }
    expect((await ctxRows(r.id, C.v)).map((x) => x.id).sort(), "still the three rows").toEqual([...mine].sort());

    // The Library again, after the pass: a revision visit in the Individual
    // context only; the path and journey rows stay open.
    const revisit = await served(req, startUrl(C.id));
    expectRevisionBar(revisit.html, "Library relaunch after the pass");
    rows = await ctxRows(r.id, C.v);
    const visit = rows.find((x) => !mine.includes(x.id));
    expect(visit, "a new row for the revision visit").toBeTruthy();
    expect(visit!).toMatchObject({ context_kind: "individual", context_key: "individual", is_revision: true, status: "in_progress" });
    expect(registrationOf(revisit.src), "the revision visit runs its own row").toBe(visit!.id);
    for (const [id, what] of [
      [inPath[0].id, "path"],
      [inDay[0].id, "journey"],
    ] as const) {
      expect((await fullRow(id)).status, `the ${what} row stays open`).toBe("in_progress");
    }
    expect(await visitsOf(r.id, C.id), "one visit, recorded under the Individual key").toEqual([{ context_key: "individual", attempt_id: visit!.id }]);
  });

  test("(p2) a forged ?lp= is refused with ?denied=1 and writes no attempt and no enrolment", async () => {
    const r = s.r!;
    const req = s.rCtx!.request;
    const before = { attempts: await attemptIds(r.id), enrolments: await enrolmentIds(r.id) };
    for (const [what, course, lp] of [
      ["a private path R is not on, which holds the course", s.c!.id, s.x!],
      ["a path id no path has", s.c!.id, randomUUID()],
      ["a path id that is not a uuid", s.c!.id, "not-a-uuid"],
      ["another organisation's path", s.c!.id, s.otherPath!],
      ["a path R is on, of which the course is no step", s.d!.id, s.p!],
    ] as const) {
      const res = await noFollow(req, startUrl(course, `?lp=${encodeURIComponent(lp)}`));
      expect(redirectTarget(res), `${what}: ${describe(res)}`).toBe(denied());
    }
    expect(await attemptIds(r.id), "no attempt written").toEqual(before.attempts);
    expect(await enrolmentIds(r.id), "no enrolment written").toEqual(before.enrolments);
  });

  test("(p3) both product parameters, and a journey launch that names no open day of the learner's, are refused with ?denied=1 and write nothing", async () => {
    const r = s.r!;
    const req = s.rCtx!.request;
    const j = s.j!;
    const before = { attempts: await attemptIds(r.id), enrolments: await enrolmentIds(r.id) };
    for (const [what, q] of [
      ["both ?lp= and ?journey=", `?lp=${s.p}&journey=${s.enr}&day=${j.dayId}`],
      ["?journey= with no day", `?journey=${s.enr}`],
      ["a journey enrolment id no enrolment has", `?journey=${randomUUID()}&day=${j.dayId}`],
      ["a day id that is no day of the pinned version", `?journey=${s.enr}&day=${randomUUID()}`],
      ["a day number the pinned version does not hold", `?journey=${s.enr}&day=2`],
    ] as const) {
      const res = await noFollow(req, startUrl(s.c!.id, q));
      expect(redirectTarget(res), `${what}: ${describe(res)}`).toBe(denied());
    }
    expect(await attemptIds(r.id), "no attempt written").toEqual(before.attempts);
    expect(await enrolmentIds(r.id), "no enrolment written").toEqual(before.enrolments);
  });

  test("(p4) a launch with no product parameter of a course R holds only through a path goes into that path's launch; through two paths, to the dashboard (the chooser until phase 6)", async () => {
    const r = s.r!;
    const req = s.rCtx!.request;
    const before = { attempts: await attemptIds(r.id), enrolments: await enrolmentIds(r.id) };
    const into = startUrl(s.d!.id, `?lp=${s.q}`);
    const one = await noFollow(req, startUrl(s.d!.id));
    expect(redirectTarget(one), `one holder (path Q): ${describe(one)}`).toBe(into);
    const two = await noFollow(req, startUrl(s.d2!.id));
    expect(redirectTarget(two), `two holders (Q and Q2): ${describe(two)}`).toBe(`/${slug()}/dashboard`);
    expect(await attemptIds(r.id), "neither redirect writes an attempt").toEqual(before.attempts);
    expect(await enrolmentIds(r.id), "nor an enrolment").toEqual(before.enrolments);

    // Followed, Q's launch opens D in Q's context.
    const inQ = await served(req, into);
    expectStartBar(inQ.html, "D through Q");
    const rows = await ctxRows(r.id, s.d!.v);
    expect(rows.length, "one row on D").toBe(1);
    expect(rows[0]).toMatchObject({ context_kind: "path", context_key: `path:${s.q}`, learning_path_id: s.q, is_revision: false, status: "in_progress" });
    expect(registrationOf(inQ.src)).toBe(rows[0].id);
  });

  test("(p5) the journey page links R's mission of the day by the day's id (item 7)", async () => {
    const res = await s.rCtx!.request.get(`/${slug()}/journey`, { timeout: 120_000 });
    expect(res.ok(), `journey page → ${res.status()}`).toBeTruthy();
    const html = (await res.text()).replace(/&amp;/g, "&");
    expect(html, "today's mission carries the day's id").toContain(`/courses/${s.c!.id}/launch?journey=${s.enr}&day=${s.j!.dayId}`);
  });
});

test.describe.serial("ADR 0024 P2-6 — both forms of record_revision_visit and consume_grant through PostgREST", () => {
  const s: {
    org?: { id: string; slug: string };
    x?: User;
    course?: Course;
    other?: Course;
    pathId?: string;
    j?: Journey;
    enr?: string;
    /** An individual grant left open by (cg-22023), refused to the session in (rls). */
    open?: string;
  } = {};
  const visit = () => ({
    p_org: s.org!.id,
    p_user: s.x!.id,
    p_course: s.course!.id,
    p_version: s.course!.v,
    p_attempt: null,
    p_kind: "cmi5",
  });
  const nine = (o: Record<string, unknown>) => ({
    p_grant_id: null,
    p_user_id: s.x!.id,
    p_course_id: s.course!.id,
    p_version_id: s.course!.v,
    p_org_id: s.org!.id,
    p_learning_path_id: null,
    p_journey_enrollment_id: null,
    p_journey_day: null,
    p_journey_day_id: null,
    ...o,
  });
  const eight = (o: Record<string, unknown>) => ({
    p_grant_id: null,
    p_user_id: s.x!.id,
    p_course_id: s.course!.id,
    p_version_id: s.course!.v,
    p_org_id: s.org!.id,
    p_learning_path_id: null,
    p_journey_enrollment_id: null,
    p_journey_day: null,
    ...o,
  });

  async function rpcVisit(args: Record<string, unknown>): Promise<boolean> {
    const { data, error } = await svc().rpc("record_revision_visit", args);
    expect(error, `record_revision_visit: ${error?.code} ${error?.message}`).toBeNull();
    return data as boolean;
  }

  async function consume(args: Record<string, unknown>): Promise<ConsumeAnswer> {
    const { data, error } = await svc().rpc("consume_grant", args);
    expect(error, `consume_grant: ${error?.code} ${error?.message}`).toBeNull();
    const row = (Array.isArray(data) ? data[0] : data) as ConsumeAnswer | null;
    expect(row, "consume_grant answers one row").toBeTruthy();
    return row!;
  }

  async function grant(ctx: Record<string, unknown>): Promise<string> {
    const { data, error } = await svc()
      .from("attempt_requests")
      .insert({
        organization_id: s.org!.id,
        course_id: s.course!.id,
        user_id: s.x!.id,
        status: "approved",
        source: "bulk",
        decided_at: new Date().toISOString(),
        ...ctx,
      })
      .select("id")
      .single();
    expect(error, `grant: ${error?.message}`).toBeNull();
    return (data as { id: string }).id;
  }

  test("seed (service role only): a course with one version and a second course, a path on the course, a one-day journey on it, learner X enrolled", async () => {
    expect(await has0107(), "0107 is not applied on this database").toBe(true);
    const org = await createOrg({ name: "Lifecycle Launch Context Functions" });
    s.org = org;
    s.x = await newLearner(org.id, "X");
    s.course = await bareCourse(org.id, "QA Contexts Functions");
    s.other = await bareCourse(org.id, "QA Contexts Functions Other");
    s.pathId = await newPath(org.id, "Functions Path", { visibility: "private", sequence: "strict" }, [s.course.id]);
    s.j = await oneDayJourney(org.id, "Functions Journey", s.course.id);
    s.enr = await enrolJourney(s.j, org.id, s.x.id);
  });

  test("(rv) record_revision_visit: six names write the key 'individual', seven names the key given; the 10-second dedupe is per key", async () => {
    const pathKey = `path:${s.pathId}`;
    expect(await rpcVisit(visit()), "six names: written").toBe(true);
    expect(await rpcVisit(visit()), "six names again: deduplicated").toBe(false);
    expect(await rpcVisit({ ...visit(), p_context_key: "individual" }), "seven names, 'individual': the same key, deduplicated").toBe(false);
    expect(await rpcVisit({ ...visit(), p_context_key: pathKey }), "seven names, another key: written").toBe(true);
    expect(await rpcVisit({ ...visit(), p_context_key: pathKey }), "seven names again: deduplicated").toBe(false);
    const keys = (await visitsOf(s.x!.id, s.course!.id)).map((v) => v.context_key).sort();
    expect(keys, "two visits, one per key").toEqual(["individual", pathKey].sort());
  });

  test("(cg) consume_grant: nine names consume only in the grant's own context; eight names resolve the day number through the pinned version; an unknown grant is unavailable from both", async () => {
    const x = s.x!;
    const j = s.j!;
    // A path grant: unavailable in the Individual context, opened in its own.
    const g1 = await grant({ context_kind: "path", learning_path_id: s.pathId });
    expect((await grantRow(g1)).context_key).toBe(`path:${s.pathId}`);
    expect((await consume(nine({ p_grant_id: g1 }))).outcome, "nine names, another context").toBe("unavailable");
    const opened = await consume(nine({ p_grant_id: g1, p_learning_path_id: s.pathId }));
    expect(opened.outcome, "nine names, the grant's own context").toBe("opened");
    expect(opened.abandoned_ids ?? [], "nothing open in path:P to abandon").toEqual([]);
    const a1 = opened.attempt_id!;
    expect(await fullRow(a1), "the retake names its context").toMatchObject({
      course_version_id: s.course!.v,
      context_kind: "path",
      context_key: `path:${s.pathId}`,
      learning_path_id: s.pathId,
      journey_enrollment_id: null,
      is_revision: false,
      status: "in_progress",
    });
    const g1Row = await grantRow(g1);
    expect([g1Row.used_attempt_id, g1Row.used_at !== null]).toEqual([a1, true]);
    expect((await consume(nine({ p_grant_id: g1, p_learning_path_id: s.pathId }))).outcome, "nine names, spent").toBe("used");

    // A journey grant on day 1: the nine-name form needs the day's id; the
    // eight-name form resolves the number through the pinned version.
    const g2 = await grant({ context_kind: "journey", journey_enrollment_id: s.enr, journey_day: 1, journey_day_id: j.dayId });
    expect((await grantRow(g2)).context_key).toBe(`journey:${s.enr}:${j.dayId}`);
    expect(
      (await consume(nine({ p_grant_id: g2, p_journey_enrollment_id: s.enr, p_journey_day: 1, p_journey_day_id: null }))).outcome,
      "nine names, no day id: no key"
    ).toBe("unavailable");
    expect(
      (await consume(eight({ p_grant_id: g2, p_journey_enrollment_id: s.enr, p_journey_day: 2 }))).outcome,
      "eight names, a day number the pinned version lacks"
    ).toBe("unavailable");
    const viaNumber = await consume(eight({ p_grant_id: g2, p_journey_enrollment_id: s.enr, p_journey_day: 1 }));
    expect(viaNumber.outcome, "eight names, day 1").toBe("opened");
    const a2 = viaNumber.attempt_id!;
    expect(await fullRow(a2), "the journey retake names the day's id and the pinned version").toMatchObject({
      course_version_id: s.course!.v,
      context_kind: "journey",
      context_key: `journey:${s.enr}:${j.dayId}`,
      journey_enrollment_id: s.enr,
      journey_day: 1,
      journey_day_id: j.dayId,
      journey_version_id: j.versionId,
      learning_path_id: null,
      is_revision: false,
      status: "in_progress",
    });
    expect((await grantRow(g2)).used_attempt_id).toBe(a2);

    // A grant id no grant has: unavailable from both forms, nothing written.
    const unknown = randomUUID();
    expect((await consume(nine({ p_grant_id: unknown }))).outcome).toBe("unavailable");
    expect((await consume(eight({ p_grant_id: unknown }))).outcome).toBe("unavailable");
    expect(await attemptIds(x.id), "the two retakes only").toEqual([a1, a2].sort());
  });

  test("(cg-22023) consume_grant naming a version of another course raises 22023 and consumes nothing", async () => {
    const g3 = await grant({});
    s.open = g3;
    const before = await attemptIds(s.x!.id);
    const { error } = await svc().rpc("consume_grant", nine({ p_grant_id: g3, p_version_id: s.other!.v }));
    expect(error?.code, `the consistency check: ${error?.message}`).toBe("22023");
    const g = await grantRow(g3);
    expect([g.status, g.used_at, g.used_attempt_id, g.context_key]).toEqual(["approved", null, null, "individual"]);
    expect(await attemptIds(s.x!.id), "nothing written").toEqual(before);
  });

  test("(rls) the learner's own session can call none of launch_context, consume_grant or record_revision_visit; nothing is written", async () => {
    const x = s.x!;
    const db = await sessionClient(x);
    const attempts = await attemptIds(x.id);
    const visits = (await visitsOf(x.id)).length;
    const lc = await db.rpc("launch_context", {
      p_user: x.id,
      p_org: s.org!.id,
      p_course: s.course!.id,
      p_path: null,
      p_enrollment: null,
      p_day_id: null,
      p_day: null,
    });
    // A revoked execute privilege answers 42501 (permission denied), as a
    // revoked table privilege does (spec 55); any other error, a wrong
    // argument set for one, would not prove the grant.
    const refused = (what: string, e: { code?: string; message?: string } | null) =>
      expect(e?.code ?? "no error", `${what} on the learner's session: ${e?.message ?? ""}`).toBe("42501");
    refused("launch_context", lc.error);
    const cg9 = await db.rpc("consume_grant", nine({ p_grant_id: s.open! }));
    refused("consume_grant, nine names", cg9.error);
    const cg8 = await db.rpc("consume_grant", eight({ p_grant_id: s.open! }));
    refused("consume_grant, eight names", cg8.error);
    const rv7 = await db.rpc("record_revision_visit", { ...visit(), p_context_key: `path:${randomUUID()}` });
    refused("record_revision_visit, seven names", rv7.error);
    const rv6 = await db.rpc("record_revision_visit", visit());
    refused("record_revision_visit, six names", rv6.error);
    expect(await attemptIds(x.id), "no attempt written").toEqual(attempts);
    expect((await visitsOf(x.id)).length, "no visit written").toBe(visits);
    expect((await grantRow(s.open!)).used_at, "the grant is unused").toBeNull();
  });
});

test.describe.serial("ADR 0024 P2-6 — self-enrolment on an Everyone course and path; P2-Q2", () => {
  const s: {
    org?: { id: string; slug: string };
    admin?: User;
    adminCtx?: BrowserContext;
    /** G: an "Everyone in this org" course. */
    g?: Course;
    /** E1, E2: the steps of the "Everyone" strict path PE. */
    e1?: Course;
    e2?: Course;
    pe?: string;
    team?: string;
    users: Partial<Record<"s1" | "s2" | "s3" | "q1" | "q2", User>>;
    ctx: Partial<Record<"s1" | "s2" | "s3" | "q1" | "q2", BrowserContext>>;
  } = { users: {}, ctx: {} };
  const slug = () => s.org!.slug;
  const startUrl = (courseId: string, q = "") => `/${slug()}/courses/${courseId}/launch${q}`;

  test.afterAll(async () => {
    for (const c of Object.values(s.ctx)) await c?.close().catch(() => {});
    await s.adminCtx?.close().catch(() => {});
  });

  test("seed: an Everyone course G; an Everyone strict path PE (E1, E2); a team T; five learners with no enrolment", async ({ browser, baseURL }) => {
    test.setTimeout(600_000);
    expect(await has0107(), "0107 is not applied on this database: self-enrolment writes source").toBe(true);
    const org = await createOrg({ name: "Lifecycle Self Enrolment" });
    s.org = org;
    const admin = (await createAuthUser({ profile: { first_name: "Contexts", last_name: "Admin", must_change_password: false } })) as User;
    await addMember({ organizationId: org.id, userId: admin.id, role: "admin" });
    s.admin = admin;
    s.adminCtx = await authedContext(browser, baseURL!, admin.email, admin.password);
    const areq = s.adminCtx.request;
    const tag = rand(6);
    s.g = await cmi5Course(areq, org.slug, tag, "g", "QA Self Enrolment G");
    s.e1 = await cmi5Course(areq, org.slug, tag, "e1", "QA Self Enrolment Step One");
    s.e2 = await cmi5Course(areq, org.slug, tag, "e2", "QA Self Enrolment Step Two");
    const { error: ve } = await svc().from("courses").update({ visibility: "org_public" }).eq("id", s.g.id);
    expect(ve, `G's visibility: ${ve?.message}`).toBeNull();
    s.pe = await newPath(org.id, "Everyone Path", { visibility: "org_public", sequence: "strict" }, [s.e1.id, s.e2.id]);
    for (const key of ["s1", "s2", "s3", "q1", "q2"] as const) s.users[key] = await newLearner(org.id, key);
    const { data: t, error: te } = await svc()
      .from("teams")
      .insert({ organization_id: org.id, name: "Self Enrolment T", slug: `qa-lctx-t-${rand(6)}` })
      .select("id")
      .single();
    expect(te, `team: ${te?.message}`).toBeNull();
    s.team = (t as { id: string }).id;
    const { error: me } = await svc().from("team_members").insert({ team_id: s.team, user_id: s.users.q2!.id });
    expect(me, `team member: ${me?.message}`).toBeNull();
    for (const key of Object.keys(s.users) as Array<keyof typeof s.users>) {
      const u = s.users[key]!;
      expect(await enrolmentIds(u.id), `${key} starts with no enrolment`).toEqual([]);
      s.ctx[key] = await authedContext(browser, baseURL!, u.email, u.password);
    }
  });

  test("(s1) Start on an Everyone course: the source='self' row and the attempt in the same render (step 25's mid-render write); a second Start adds no row; an admin's assignment converts the row", async () => {
    const u = s.users.s1!;
    const req = s.ctx.s1!.request;
    const G = s.g!;
    expect(await courseEnrolments(G.id, u.id), "no row before the Start").toEqual([]);

    const first = await served(req, startUrl(G.id));
    expectStartBar(first.html, "the first Start");
    const rows = await courseEnrolments(G.id, u.id);
    expect(rows.length, "one enrolment row, written by the Start").toBe(1);
    expect(rows[0]).toMatchObject({
      assignee_type: "user",
      user_id: u.id,
      team_id: null,
      source: "self",
      assigned_by: u.id,
      due_at: null,
      release_at: null,
      organization_id: s.org!.id,
    });
    const att = await ctxRows(u.id, G.v);
    expect(att.length, "one attempt").toBe(1);
    expect(att[0]).toMatchObject({ ...REAL_ROW, context_key: "individual", status: "in_progress" });
    // The same request wrote the row and opened the attempt: launch_context's
    // second call (a POST, never memoized) read the insert as enrolled.
    expect(registrationOf(first.src), "the first Start runs the attempt it opened").toBe(att[0].id);

    const second = await served(req, startUrl(G.id));
    expect(registrationOf(second.src), "a second Start resumes").toBe(att[0].id);
    expect((await courseEnrolments(G.id, u.id)).map((e) => e.id), "a second Start adds no row").toEqual([rows[0].id]);
    expect((await ctxRows(u.id, G.v)).map((x) => x.id), "nor an attempt").toEqual([att[0].id]);

    // An admin's assignment with no dates converts the row in place.
    const a1 = await s.adminCtx!.request.post("/api/assignments", { data: { orgSlug: slug(), courseId: G.id, userIds: [u.id] } });
    expect(a1.ok(), `assign (no dates) → ${a1.status()}: ${await a1.text()}`).toBeTruthy();
    let conv = await courseEnrolments(G.id, u.id);
    expect(conv.length, "still one row").toBe(1);
    expect(conv[0], "converted: the admin's row").toMatchObject({ id: rows[0].id, source: "admin", assigned_by: s.admin!.id, due_at: null });
    // A dated assignment sets the admin's date on the same row.
    const due = inDays(7);
    const a2 = await s.adminCtx!.request.post("/api/assignments", { data: { orgSlug: slug(), courseId: G.id, userIds: [u.id], dueAt: due } });
    expect(a2.ok(), `assign (dated) → ${a2.status()}: ${await a2.text()}`).toBeTruthy();
    conv = await courseEnrolments(G.id, u.id);
    expect(conv.length, "still one row").toBe(1);
    expect(conv[0]).toMatchObject({ id: rows[0].id, source: "admin", assigned_by: s.admin!.id });
    expect(sameInstant(conv[0].due_at, due), `the admin's due date (${conv[0].due_at})`).toBe(true);
    expect(registrationOf((await served(req, startUrl(G.id))).src), "the learner's attempt is unchanged by the conversion").toBe(att[0].id);
  });

  test("(s2) Start on step 1 of an Everyone strict path: the source='self' path row and the path attempt in the same render; a second Start adds no row; step 2 stays locked; an admin's dated assignment converts the row", async () => {
    const u = s.users.s2!;
    const req = s.ctx.s2!.request;
    const PE = s.pe!;
    expect(await pathEnrolments(PE, u.id), "no row before the Start").toEqual([]);

    const first = await served(req, startUrl(s.e1!.id, `?lp=${PE}`));
    expectStartBar(first.html, "step 1's first Start");
    const rows = await pathEnrolments(PE, u.id);
    expect(rows.length, "one path enrolment row, written by the Start").toBe(1);
    expect(rows[0]).toMatchObject({ assignee_type: "user", user_id: u.id, team_id: null, source: "self", assigned_by: u.id, due_at: null, organization_id: s.org!.id });
    const att = await ctxRows(u.id, s.e1!.v);
    expect(att.length, "one attempt").toBe(1);
    expect(att[0]).toMatchObject({ context_kind: "path", context_key: `path:${PE}`, learning_path_id: PE, is_revision: false, status: "in_progress" });
    expect(registrationOf(first.src), "the first Start runs the attempt it opened").toBe(att[0].id);

    const second = await served(req, startUrl(s.e1!.id, `?lp=${PE}`));
    expect(registrationOf(second.src), "a second Start resumes").toBe(att[0].id);
    expect((await pathEnrolments(PE, u.id)).map((e) => e.id), "a second Start adds no row").toEqual([rows[0].id]);

    // Step 1 is in progress: the strict order holds step 2.
    const locked = await noFollow(req, startUrl(s.e2!.id, `?lp=${PE}`));
    expect(redirectTarget(locked), `step 2: ${describe(locked)}`).toBe(`/${slug()}/dashboard?locked=${s.e2!.id}`);
    expect(await ctxRows(u.id, s.e2!.v), "nothing written on step 2").toEqual([]);
    expect((await pathEnrolments(PE, u.id)).map((e) => e.id), "still the one row").toEqual([rows[0].id]);

    // An admin's dated path assignment converts the row in place.
    const due = inDays(14);
    const a = await s.adminCtx!.request.post("/api/learning-path-assignments", { data: { orgSlug: slug(), pathId: PE, userIds: [u.id], dueAt: due } });
    expect(a.ok(), `assign the path → ${a.status()}: ${await a.text()}`).toBeTruthy();
    const conv = await pathEnrolments(PE, u.id);
    expect(conv.length, "still one row").toBe(1);
    expect(conv[0], "converted: the admin's row").toMatchObject({ id: rows[0].id, source: "admin", assigned_by: s.admin!.id });
    expect(sameInstant(conv[0].due_at, due), `the admin's due date (${conv[0].due_at})`).toBe(true);
  });

  test("(a3) ruling A3: a learner not enrolled on an Everyone strict path presses Start on step 2: the self row is recorded first, then the strict order holds step 2; no attempt", async () => {
    const u = s.users.s3!;
    const req = s.ctx.s3!.request;
    const PE = s.pe!;
    const before = await pathFacts(u.id, s.org!.id, s.e2!.id, PE);
    expect(before, "not enrolled: launch_context reads the A3 state").toMatchObject({ found: true, visibility: "org_public", enrolled: false, self_row: false, course_step: 2 });

    const r = await noFollow(req, startUrl(s.e2!.id, `?lp=${PE}`));
    expect(redirectTarget(r), `step 2: ${describe(r)}`).toBe(`/${slug()}/dashboard?locked=${s.e2!.id}`);
    const rows = await pathEnrolments(PE, u.id);
    expect(rows.length, "the enrolment is recorded before the strict order is read").toBe(1);
    expect(rows[0]).toMatchObject({ source: "self", assigned_by: u.id, assignee_type: "user", due_at: null });
    expect(await ctxRows(u.id), "no attempt of any course").toEqual([]);
    const after = await pathFacts(u.id, s.org!.id, s.e2!.id, PE);
    expect(after).toMatchObject({ enrolled: true, self_row: true });
    expect(stepDone(after, 1), "step 1 is not done: the lock stands").toBe(false);
  });

  test("(q2a) P2-Q2: a learner whose own assignment of an Everyone course is dated in the future is held back: ?upcoming=, no attempt, the admin's row unchanged", async () => {
    const u = s.users.q1!;
    const G = s.g!;
    const release = inDays(1);
    const a = await s.adminCtx!.request.post("/api/assignments", { data: { orgSlug: slug(), courseId: G.id, userIds: [u.id], releaseAt: release } });
    expect(a.ok(), `assign with a release date → ${a.status()}: ${await a.text()}`).toBeTruthy();
    const before = await courseEnrolments(G.id, u.id);
    expect(before.length, "the admin's own row").toBe(1);
    expect(before[0]).toMatchObject({ assignee_type: "user", source: "admin", assigned_by: s.admin!.id });
    expect(sameInstant(before[0].release_at, release), `released tomorrow (${before[0].release_at})`).toBe(true);

    const r = await noFollow(s.ctx.q1!.request, startUrl(G.id));
    expect(redirectTarget(r), `the Start: ${describe(r)}`).toBe(`/${slug()}/dashboard?upcoming=${G.id}`);
    expect(await ctxRows(u.id), "no attempt").toEqual([]);
    expect(await courseEnrolments(G.id, u.id), "the admin's row unchanged, no self row").toEqual(before);
  });

  test("(q2b) P2-Q2: a learner whose team holds the dated assignment starts at once, with a source='self' row of their own", async () => {
    const u = s.users.q2!;
    const G = s.g!;
    const release = inDays(1);
    const a = await s.adminCtx!.request.post("/api/assignments", { data: { orgSlug: slug(), courseId: G.id, teamIds: [s.team!], releaseAt: release } });
    expect(a.ok(), `assign the team with a release date → ${a.status()}: ${await a.text()}`).toBeTruthy();
    const teamRows = async () => {
      const { data, error } = await svc().from("course_assignments").select("id, release_at, source").eq("course_id", G.id).eq("team_id", s.team!);
      expect(error, `team row read: ${error?.message}`).toBeNull();
      return (data ?? []) as Array<{ id: string; release_at: string | null; source: string }>;
    };
    const teamBefore = await teamRows();
    expect(teamBefore.length, "the team's row").toBe(1);
    expect(sameInstant(teamBefore[0].release_at, release), `the team's row released tomorrow (${teamBefore[0].release_at})`).toBe(true);
    expect(await courseEnrolments(G.id, u.id), "no row of the learner's own").toEqual([]);

    const st = await served(s.ctx.q2!.request, startUrl(G.id));
    expectStartBar(st.html, "the Start");
    const own = await courseEnrolments(G.id, u.id);
    expect(own.length, "one row of the learner's own").toBe(1);
    expect(own[0]).toMatchObject({ assignee_type: "user", user_id: u.id, source: "self", assigned_by: u.id, due_at: null, release_at: null });
    const att = await ctxRows(u.id, G.v);
    expect(att.length, "one attempt").toBe(1);
    expect(att[0]).toMatchObject({ ...REAL_ROW, status: "in_progress" });
    expect(registrationOf(st.src)).toBe(att[0].id);
    expect(await teamRows(), "the team's row unchanged").toEqual(teamBefore);
  });
});

test.describe.serial("ADR 0024 P2-6 — grants in context: the rerun after used and after stale, the worst path and its measured count", () => {
  const s: {
    org?: { id: string; slug: string };
    admin?: User;
    adminCtx?: BrowserContext;
    /** H: step 1 of the private strict path PH. */
    h?: Course;
    ph?: string;
    /** W1, W2: the steps of the "Everyone" strict path PW (the worst path). */
    w1?: Course;
    w2?: Course;
    pw?: string;
    /** Meter only: an "Everyone" course and a one-day journey on H. */
    g2?: Course;
    j2?: Journey;
    users: Partial<Record<"g" | "st" | "w", User>>;
    ctx: Partial<Record<"g" | "st" | "w", BrowserContext>>;
  } = { users: {}, ctx: {} };
  const slug = () => s.org!.slug;
  const startUrl = (courseId: string, q = "") => `/${slug()}/courses/${courseId}/launch${q}`;

  test.afterAll(async () => {
    for (const c of Object.values(s.ctx)) await c?.close().catch(() => {});
    await s.adminCtx?.close().catch(() => {});
  });

  test("seed: a private strict path PH (H) with two learners on it; an Everyone strict path PW (W1, W2); a third learner on nothing", async ({ browser, baseURL }) => {
    test.setTimeout(600_000);
    expect(await has0107(), "0107 is not applied on this database: grants carry a context").toBe(true);
    const org = await createOrg({ name: "Lifecycle Grants In Context" });
    s.org = org;
    const admin = (await createAuthUser({ profile: { first_name: "Contexts", last_name: "Admin", must_change_password: false } })) as User;
    await addMember({ organizationId: org.id, userId: admin.id, role: "admin" });
    s.admin = admin;
    s.adminCtx = await authedContext(browser, baseURL!, admin.email, admin.password);
    const areq = s.adminCtx.request;
    const tag = rand(6);
    s.h = await cmi5Course(areq, org.slug, tag, "h", "QA Grants H");
    s.w1 = await cmi5Course(areq, org.slug, tag, "w1", "QA Grants Step One");
    s.w2 = await cmi5Course(areq, org.slug, tag, "w2", "QA Grants Step Two");
    s.ph = await newPath(org.id, "Grants Path", { visibility: "private", sequence: "strict" }, [s.h.id]);
    s.pw = await newPath(org.id, "Grants Everyone Path", { visibility: "org_public", sequence: "strict" }, [s.w1.id, s.w2.id]);
    if (METER_LOG) {
      s.g2 = await cmi5Course(areq, org.slug, tag, "g2", "QA Grants Everyone Course");
      const { error: ve } = await svc().from("courses").update({ visibility: "org_public" }).eq("id", s.g2.id);
      expect(ve, `G2's visibility: ${ve?.message}`).toBeNull();
      s.j2 = await oneDayJourney(org.id, "Grants Journey", s.h.id);
    }
    for (const key of ["g", "st", "w"] as const) {
      const u = await newLearner(org.id, key);
      s.users[key] = u;
      if (key !== "w") await assignPath(org.id, s.ph, u.id);
      s.ctx[key] = await authedContext(browser, baseURL!, u.email, u.password);
    }
  });

  test("(st) a stale path grant: consume_grant expires it in the render, the rerun reads the fresh grants, and the launch is a revision visit in path:P recorded under that key", async () => {
    const u = s.users.st!;
    const H = s.h!;
    const official = await pathAttempt({ versionId: H.v, userId: u.id, orgId: s.org!.id, pathId: s.ph!, outcome: "failed", completedAt: hoursAgo(1) });
    // Decided before the official result completed: stale (consume_grant step 6).
    const grantId = await pathGrant({ orgId: s.org!.id, courseId: H.id, userId: u.id, pathId: s.ph!, decidedBy: s.admin!.id, decidedAt: hoursAgo(2) });
    const st = await served(s.ctx.st!.request, startUrl(H.id, `?lp=${s.ph}`));
    expectRevisionBar(st.html, "the Start after the stale grant");
    const rows = await ctxRows(u.id, H.v);
    expect(rows.length, "the official attempt and the revision visit's row").toBe(2);
    const visitRow = rows.find((x) => x.id !== official)!;
    expect(visitRow).toMatchObject({ context_kind: "path", context_key: `path:${s.ph}`, learning_path_id: s.ph, is_revision: true, status: "in_progress" });
    expect(registrationOf(st.src)).toBe(visitRow.id);
    const g = await grantRow(grantId);
    expect([g.status, g.used_at, g.used_attempt_id], "expired unused").toEqual(["expired", null, null]);
    expect(g.decision_note ?? "", "the stale note").toContain("decided before");
    expect(await visitsOf(u.id, H.id), "one visit, under the path's key").toEqual([{ context_key: `path:${s.ph}`, attempt_id: visitRow.id }]);
  });

  test("(w) the worst path of step 70 (fixture rows): a self-enrolling learner's first launch of step 2 of an Everyone strict path consumes a path grant; A3's second call reads step 1 done after the insert", async () => {
    const u = s.users.w!;
    const W1 = s.w1!;
    const W2 = s.w2!;
    const PW = s.pw!;
    await pathAttempt({ versionId: W1.v, userId: u.id, orgId: s.org!.id, pathId: PW, outcome: "passed", completedAt: hoursAgo(3) });
    const failed = await pathAttempt({ versionId: W2.v, userId: u.id, orgId: s.org!.id, pathId: PW, outcome: "failed", completedAt: hoursAgo(2) });
    const failedBefore = await fullRow(failed);
    const grantId = await pathGrant({
      orgId: s.org!.id,
      courseId: W2.id,
      userId: u.id,
      pathId: PW,
      decidedBy: s.admin!.id,
      decidedAt: await grantDecidedAfter(failed),
    });
    // The state: no enrolment, so v_path_step_status reads step 1 as not done.
    const before = await pathFacts(u.id, s.org!.id, W2.id, PW);
    expect(before, "the worst path's state").toMatchObject({ found: true, visibility: "org_public", sequence_mode: "strict", enrolled: false, self_row: false, course_step: 2 });
    expect(stepDone(before, 1), "step 1 reads not done before the enrolment").toBe(false);

    const launch = await served(s.ctx.w!.request, startUrl(W2.id, `?lp=${PW}`));
    expectStartBar(launch.html, "the worst path's Start");
    // Enrolled first ...
    const enr = await pathEnrolments(PW, u.id);
    expect(enr.length, "one self row").toBe(1);
    expect(enr[0]).toMatchObject({ assignee_type: "user", source: "self", assigned_by: u.id, due_at: null });
    const after = await pathFacts(u.id, s.org!.id, W2.id, PW);
    expect(after).toMatchObject({ enrolled: true, self_row: true });
    expect(stepDone(after, 1), "step 1 done once enrolled").toBe(true);
    // ... then the grant opened a retake in path:PW, in the same render.
    const rows = await ctxRows(u.id, W2.v);
    expect(rows.length, "the failed official attempt and the retake").toBe(2);
    const retake = rows.find((x) => x.id !== failed)!;
    expect(retake).toMatchObject({ context_kind: "path", context_key: `path:${PW}`, learning_path_id: PW, is_revision: false, status: "in_progress" });
    expect(registrationOf(launch.src), "the launch runs the retake").toBe(retake.id);
    const g = await grantRow(grantId);
    expect([g.status, g.used_attempt_id], "the grant spent on the retake").toEqual(["approved", retake.id]);
    expect(await fullRow(failed), "the failed attempt as it was").toEqual(failedBefore);
  });

  // Item 9. Registered only where the meter runs (the app server here with
  // NODE_OPTIONS=--require ./tests/bot/lifecycle/subrequest-meter.cjs and
  // SUBREQUEST_LOG set for both; a local production build against the
  // staging database): elsewhere a skipped test would turn the nightly amber.
  // Each branch is a fresh learner and fixture rows; the meter counts every
  // server-side fetch of the one launch request, the learner layout included
  // and the middleware not (one more, ADR 0019). Run it once with the app
  // server's ALDS_P4 off and once on (each line says which, read from the
  // served row's launch mode).
  if (METER_LOG) test("(m2) item 9: the launch's subrequest count per branch, measured on a local build (fixture rows); the worst path at or under 40 with the middleware", async ({ browser, baseURL }) => {
    test.setTimeout(900_000);
    const org = s.org!;
    const ctxs: BrowserContext[] = [];
    const lines: Array<{ branch: string; worst: boolean; total: number; line: string }> = [];
    const learner = async (key: string) => {
      const u = await newLearner(org.id, `meter-${key}`);
      const ctx = await authedContext(browser, baseURL!, u.email, u.password);
      ctxs.push(ctx);
      return { u, req: ctx.request };
    };
    const newestOpen = async (userId: string) => {
      const open = (await ctxRows(userId)).filter((r) => r.status === "in_progress");
      expect(open.length, "the launch opened a row").toBeGreaterThan(0);
      return open[open.length - 1];
    };
    const measure = async (branch: string, worst: boolean, req: APIRequestContext, url: string, check: () => Promise<CtxAtt>) => {
      const m = await metered(req, url);
      const row = await check();
      // ALDS_P4 on writes the 0100 launch mode on every launch's row (Normal,
      // or Review on a revision row); off, it stays null.
      const mode = (await fullRow(row.id)).launch_mode;
      const p4 = mode === null || mode === undefined ? "ALDS_P4 off" : "ALDS_P4 on";
      const total = m.fetches + MIDDLEWARE_SUBREQUESTS;
      const line = `${branch}: ${m.fetches} (database ${m.supabase}, other ${m.other}) + middleware ${MIDDLEWARE_SUBREQUESTS} = ${total}${total > LAUNCH_BUDGET ? " (over 40)" : ""}; ${p4}`;
      console.log(`[spec 68] subrequests: ${line}`);
      test.info().annotations.push({ type: "subrequests", description: line });
      lines.push({ branch, worst, total, line });
    };
    try {
      // 1. The worst path: the self-enrolment insert, A3's second call, and a grant opened.
      {
        const { u, req } = await learner("worst");
        await pathAttempt({ versionId: s.w1!.v, userId: u.id, orgId: org.id, pathId: s.pw!, outcome: "passed", completedAt: hoursAgo(3) });
        const failed = await pathAttempt({ versionId: s.w2!.v, userId: u.id, orgId: org.id, pathId: s.pw!, outcome: "failed", completedAt: hoursAgo(2) });
        const grantId = await pathGrant({ orgId: org.id, courseId: s.w2!.id, userId: u.id, pathId: s.pw!, decidedBy: s.admin!.id, decidedAt: await grantDecidedAfter(failed) });
        await measure("worst path: self-enrolling first strict-path launch that consumes a grant", true, req, startUrl(s.w2!.id, `?lp=${s.pw}`), async () => {
          expect((await pathEnrolments(s.pw!, u.id)).map((e) => e.source), "enrolled by the launch").toEqual(["self"]);
          const g = await grantRow(grantId);
          expect(g.used_attempt_id, "the grant opened the retake").toBeTruthy();
          return (await ctxRows(u.id)).find((r) => r.id === g.used_attempt_id)!;
        });
      }
      // 2. The same Start whose grant is stale: consume_grant answers 'stale', the rerun, a revision visit.
      {
        const { u, req } = await learner("stale");
        await pathAttempt({ versionId: s.w1!.v, userId: u.id, orgId: org.id, pathId: s.pw!, outcome: "passed", completedAt: hoursAgo(3) });
        await pathAttempt({ versionId: s.w2!.v, userId: u.id, orgId: org.id, pathId: s.pw!, outcome: "failed", completedAt: hoursAgo(1) });
        const grantId = await pathGrant({ orgId: org.id, courseId: s.w2!.id, userId: u.id, pathId: s.pw!, decidedBy: s.admin!.id, decidedAt: hoursAgo(2) });
        await measure("self-enrolling strict-path launch whose grant is stale (rerun, revision visit)", false, req, startUrl(s.w2!.id, `?lp=${s.pw}`), async () => {
          expect((await grantRow(grantId)).status, "the grant expired as stale").toBe("expired");
          const row = await newestOpen(u.id);
          expect(row).toMatchObject({ context_kind: "path", is_revision: true });
          return row;
        });
      }
      // 3. A3 with no grant: the first official attempt of step 2.
      {
        const { u, req } = await learner("a3");
        await pathAttempt({ versionId: s.w1!.v, userId: u.id, orgId: org.id, pathId: s.pw!, outcome: "passed", completedAt: hoursAgo(3) });
        await measure("self-enrolling first strict-path launch, no grant", false, req, startUrl(s.w2!.id, `?lp=${s.pw}`), async () => {
          const row = await newestOpen(u.id);
          expect(row).toMatchObject({ context_kind: "path", course_version_id: s.w2!.v, is_revision: false });
          return row;
        });
      }
      // 4. The Individual self-enrolment on an "Everyone" course.
      {
        const { u, req } = await learner("course");
        await measure("self-enrolling first Start of an Everyone course", false, req, startUrl(s.g2!.id), async () => {
          expect((await courseEnrolments(s.g2!.id, u.id)).map((e) => e.source), "enrolled by the launch").toEqual(["self"]);
          const row = await newestOpen(u.id);
          expect(row).toMatchObject({ context_kind: "individual", course_version_id: s.g2!.v });
          return row;
        });
      }
      // 5. A journey day by its id (with the pinned version's days read for warming).
      {
        const { u, req } = await learner("journey");
        const enr = await enrolJourney(s.j2!, org.id, u.id);
        await measure("first Start of a journey day, by its id", false, req, startUrl(s.h!.id, `?journey=${enr}&day=${s.j2!.dayId}`), async () => {
          const row = await newestOpen(u.id);
          expect(row).toMatchObject({ context_kind: "journey", journey_day_id: s.j2!.dayId });
          return row;
        });
      }
      // 6. P2-5's baseline: the first Start of an assigned course.
      {
        const { u, req } = await learner("assigned");
        await assignCourse(s.adminCtx!.request, org.slug, s.h!.id, u.id);
        await measure("first Start of an assigned course (Individual)", false, req, startUrl(s.h!.id), async () => {
          const row = await newestOpen(u.id);
          expect(row).toMatchObject({ context_kind: "individual", course_version_id: s.h!.v });
          return row;
        });
      }
    } finally {
      for (const c of ctxs) await c.close().catch(() => {});
    }
    const worst = lines.find((l) => l.worst)!;
    expect(worst.total, `step 70's gate, the worst path: ${worst.line}`).toBeLessThanOrEqual(LAUNCH_BUDGET);
  });

  test("(u) step 25, the evaluate rerun after 'used': four concurrent Starts on one unused path grant all serve the one retake", async () => {
    // A request whose grant read precedes the winner's commit waits on the
    // grant's row lock, then consume_grant answers 'used' and the page reruns
    // its grants read and evaluate() in the same render: each rerun read
    // carries its own abort signal, so it sees the retake and resumes it. A
    // memoized rerun would see the grant unused and no retake, and refuse
    // with the retry notice. The race needs requests that overlap: reliable
    // at a runner's latency, not guaranteed where calls take a few
    // milliseconds (spec 53 (5)'s disclosure); every answer is checked either
    // way.
    const u = s.users.g!;
    const H = s.h!;
    const official = await pathAttempt({ versionId: H.v, userId: u.id, orgId: s.org!.id, pathId: s.ph!, outcome: "failed", completedAt: hoursAgo(2) });
    const officialBefore = await fullRow(official);
    const grantId = await pathGrant({
      orgId: s.org!.id,
      courseId: H.id,
      userId: u.id,
      pathId: s.ph!,
      decidedBy: s.admin!.id,
      decidedAt: await grantDecidedAfter(official),
    });
    const url = startUrl(H.id, `?lp=${s.ph}`);
    const answers = await Promise.all(Array.from({ length: 4 }, () => noFollow(s.ctx.g!.request, url)));
    const regs: Array<string | null> = [];
    for (const [i, a] of answers.entries()) {
      expect(a.status, `Start ${i + 1}: ${describe(a)}`).toBe(200);
      expect(redirectTarget(a), `Start ${i + 1}: served, never the retry notice`).toBeNull();
      const m = /<iframe[^>]+src="([^"]+)"/.exec(a.body);
      expect(m, `Start ${i + 1}: the course iframe`).toBeTruthy();
      regs.push(registrationOf(m![1].replace(/&amp;/g, "&")));
    }
    const rows = await ctxRows(u.id, H.v);
    expect(rows.length, "the official attempt and one retake").toBe(2);
    const retake = rows.find((x) => x.id !== official)!;
    expect(retake).toMatchObject({ context_kind: "path", context_key: `path:${s.ph}`, learning_path_id: s.ph, is_revision: false, status: "in_progress" });
    expect([...new Set(regs)], "every Start serves the one retake").toEqual([retake.id]);
    const g = await grantRow(grantId);
    expect([g.status, g.used_attempt_id, g.used_at !== null], "the grant spent once, on the retake").toEqual(["approved", retake.id, true]);
    expect(await fullRow(official), "the official attempt as it was").toEqual(officialBefore);
  });
});
