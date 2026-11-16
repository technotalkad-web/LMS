/**
 * ADR 0024 (three independent learning products), spec 69 `journey-contexts`
 * (step 64's row). Phase 2 slice P2-8 creates it (item 7) with its phase 2
 * cases; later phases add theirs (listed at the end). Three blocks, each with
 * its own organisation and seed, so a red case skips the rest of its own
 * block only. Every journey here is built and published through the app's
 * routes or the journey editor (day_ids_source 'editor'), every learner is
 * fresh per run and every day is launched and completed through the app
 * (the launch page and the SCORM commit route, which credits the day through
 * journey_record_completion). Until phase 3 that route classifies an attempt
 * across the whole course (N21), so a learner's completion of a course in a
 * second context is credited by the nightly sweep, not in the request; for
 * those attempts only ((b), (c) and (d)) the spec makes the sweep's own call
 * after the commit (recordCompletion). No journey course is assigned to a
 * learner directly: the journey is the entitlement under test. count_sundays
 * and unlock_mode 'progress' open each day as the one before it is done.
 *
 *   Block "launch" (A):
 *   (a)   one course on two days: two official attempts, contexts
 *         journey:E:<day 1> and journey:E:<day 2>; completing day 1 credits
 *         day 1 only;
 *   (b)   re-run after a reset: the reset enrolment's launch is refused
 *         (?denied=1); a new enrolment opens a fresh context for day 1; the
 *         old attempts keep their enrolment and context;
 *   (c)   review of a credited day and of a completed journey: a revision
 *         visit, never a new official attempt; the journey completes once,
 *         with one badge and one claim (origin learner);
 *   (d)   several active journeys holding one course: a launch with no
 *         product parameter goes to the dashboard (the chooser until phase
 *         6); each journey's launch tags its own enrolment and credits only
 *         it;
 *   (e)   a stale numeric link (&day=<old number>) after a renumbering
 *         publish never serves another day's attempt: the old number now
 *         names the inserted day, so the link of the started day's course is
 *         refused (?denied=1) and writes nothing, while the day's id link and
 *         its new number resume the started attempt.
 *
 *   Block "editor" (B, in the browser):
 *   (b1)  two saves in one page session, the second after "Insert a day
 *         here" and a move: both 200; the first save's rows keep their ids;
 *         one new row per save; the numbers as the editor shows them, the row
 *         pushed past the journey's length included (P2-N7); the day seeded
 *         with a pass rule of its own keeps it through both saves, and no
 *         other day gains one (P2-N8: the page loads each rule and the
 *         editor sends it back unchanged);
 *   (b2)  "Move instead?" accepted: the day whose module was cleared now
 *         holds the module at its new number (R17), each day with its own
 *         rule.
 *
 *   Block "republish" (C, A27; one program, one learner and one publish per
 *   edit): each learner completed days 1 to 3 through the app and holds
 *   day 4 open with a SCORM bookmark (C-pub: days 1 and 2, day 3 open;
 *   C-fail: day 1, then day 2 failed). Each case runs the same steps:
 *     (i)   the edit through the editor and Save; snapshot S0; "Publish &
 *           update everyone" runs the dry run, whose counts the dialog shows;
 *     (ii)  before confirming, snapshot S1 equals S0: the dry run wrote
 *           nothing (the program's enrolments, versions and pointer, the
 *           credits, the learner's attempts, the badges and the completion
 *           claims);
 *     (iii) confirmed: the publish's counts equal the dry run's, key by key;
 *           the new version is source 'editor' with day_ids = the saved rows'
 *           ids by number; every attempt and credit row of S0 is unchanged;
 *     (iv)  the learner: no completed day is offered as today's mission; the
 *           open attempt resumes by its launch link with its bookmark (the
 *           same attempt id) and its completion credits its own day id; the
 *           journey page and journey admin show the same credited count
 *           (C-fail holds no open attempt: its (iv) is in its entry below).
 *   The expected counts come from 0107 section 6f's definitions:
 *   (C-ins)    a day with a module inserted before the open day: repinned 1,
 *              sent_back 1 (the open day is now the inserted day 2), and
 *              started_days_kept 1 (the started day moved from 4 to 5); the
 *              learner then finishes every day: one completion, one badge,
 *              one claim (origin learner);
 *   (C-swap)   two completed days swapped by Move down: repinned 1, every
 *              other count 0 (credits follow their days); the learner then
 *              finishes the journey: one completion, one badge, one claim
 *              (origin learner);
 *   (C-course) the open day's module changed in place: started_days_kept 1;
 *              the day's link on the new module goes into the started module
 *              and resumes it; no attempt on the new module; the day credited
 *              by the started module counts, and the learner then finishes
 *              the journey (one completion, one badge, one claim);
 *   (C-rem)    the open day removed: started_days_kept 1; its attempt
 *              resumes by its link (no ?denied=1) and its completion writes a
 *              history credit that counts towards nothing; the learner then
 *              finishes the remaining day and the enrolment completes (one
 *              badge, one claim, origin learner);
 *   (C-pub)    the learner's only uncredited required day, open, removed: the
 *              publish completes the enrolment (completed_now 1,
 *              started_days_kept 1; the dry run said the same), with one
 *              badge and one claim (origin publish); the removed day's attempt
 *              still resumes and its completion writes a history credit and
 *              nothing else (R13);
 *   (C-fail)   step 64's "a republish that moves a failed day keeps its
 *              failed result and opens no new official attempt without a
 *              grant": the day's course requires a pass (pass_required true,
 *              set through the course route) and the learner failed it by a
 *              SCORM commit (no credit, the context's verdict failed, no
 *              attempt request). Move up takes the failed day from 2 to 1,
 *              so it is still the open day and its launch reaches the
 *              attempt rule (after a move down the next day would be open
 *              first, and the failed day's link would only meet the
 *              journey_locked redirect): repinned 1, sent_back 1 (the open
 *              day moves from 2 to 1). After the publish the failed attempt
 *              row is unchanged field by field, its day has no credit and the
 *              context's verdict is still failed by that row; the journey
 *              page and journey admin count 1 of 3 with the failed day as
 *              today's mission; its launch link opens no new official attempt
 *              (the learner's official attempts on the course are the same
 *              before and after, and a new row is a revision visit in the
 *              day's context, as the launch serves it); no grant exists and
 *              the enrolment stays active.
 *
 * Not in phase 2 (each comes with its phase): every email (phase 3), the CRM
 * days[] (9a), the dashboard card and the "Started earlier" list (6), a
 * failed day blocked, then granted and credited (4; C-fail covers only a
 * failed day that a republish moves), the deadline edit and overdue (7, 8),
 * two concurrent completions (phase 3's writer), a credited swapped day's
 * course, code and score on journey admin and the CRM (6, 7, 9a), and a
 * stricter pass rule (the phase 6 day editor).
 *
 * Needs 0107 on the target database: every seed fails without it. By hand on
 * staging after the code is deployed, never while another lifecycle run or
 * an e2e job is in progress; it publishes to all on its own programs only.
 * It joins PRODUCT_SPECS in scripts/lifecycle-nightly.sh after its first
 * green hand run (P2-8's gate). Data stays in the lifecycle-* namespace; logs
 * carry ids and counts only.
 */
import { test, expect, type APIRequestContext, type Browser, type BrowserContext, type Page, type Response } from "@playwright/test";
import { addMember, createAuthUser, createOrg, rand, svc } from "./data";
import { authedContext, scormCommit } from "./helpers";
import { has0107, scormZip, uploadNew } from "./p0-helpers";
import { todayStr } from "../../../lib/journey/journey";

type User = { id: string; email: string; password: string };
type Org = { id: string; slug: string };
type Row = Record<string, unknown>;

const PROGRAM_API = "/api/journey/program";
/** The seven counts of journey_repin_enrollments (0107 section 6f), as the publish and its dry run answer them. */
const REPIN_KEYS = [
  "repinned",
  "kept_on_version",
  "completed_now",
  "sent_back",
  "started_days_kept",
  "credits_now_history",
  "credited_by_rule_change",
] as const;
type Counts = Record<(typeof REPIN_KEYS)[number], number>;
const ZERO: Counts = { repinned: 0, kept_on_version: 0, completed_now: 0, sent_back: 0, started_days_kept: 0, credits_now_history: 0, credited_by_rule_change: 0 };
const countsOf = (j: Row): Counts => Object.fromEntries(REPIN_KEYS.map((k) => [k, j[k]])) as Counts;

const PASSED = { "cmi.core.lesson_status": "passed", "cmi.core.score.raw": "90" };
/** A finished SCORM 1.2 result that fails (C-fail): the commit route records success_status failed, completion completed. */
const FAILED = { "cmi.core.lesson_status": "failed", "cmi.core.score.raw": "40" };

// ── HTTP helpers (spec 68's, copied; spec 68 stays unchanged) ───────────────
type NoFollow = { status: number; location: string; body: string };

async function noFollow(req: APIRequestContext, url: string): Promise<NoFollow> {
  const res = await req.get(url, { maxRedirects: 0, timeout: 120_000 });
  const location = res.headers()["location"] ?? "";
  const body = res.status() === 200 ? await res.text() : "";
  return { status: res.status(), location, body };
}

/** Where a response redirects (path and query), from a 3xx Location or Next's redirect marker in a 200 body; null for a page that rendered. */
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
    // The marker sits in the HTML, so its "&" arrives as "&amp;"; decode it
    // first, or the match stops at that ";" and drops the rest of the query.
    const m = /NEXT_REDIRECT;(?:replace|push);([^;"\\]+);/.exec(r.body.replace(/&amp;/g, "&"));
    if (m) return m[1];
  }
  return null;
}

const describe = (r: NoFollow) => `${r.status} → ${redirectTarget(r) ?? "(rendered)"}`;
/** A page's HTML with React's text separators removed and entities in links decoded. */
const text = (html: string) => html.replace(/<!-- -->/g, "").replace(/&amp;/g, "&");

/** A served page: 200 and no redirect. */
async function served(req: APIRequestContext, url: string): Promise<string> {
  const r = await noFollow(req, url);
  expect(r.status, `${url}: ${describe(r)}`).toBe(200);
  expect(redirectTarget(r), `${url}: no redirect`).toBeNull();
  return text(r.body);
}

/** A launch followed as a browser follows it (at most three redirects, each into a course launch, never ?denied=1). */
async function followLaunch(req: APIRequestContext, url: string): Promise<{ hops: string[]; html: string }> {
  const hops = [url];
  let r = await noFollow(req, url);
  for (let t = redirectTarget(r); t !== null; t = redirectTarget(r)) {
    hops.push(t);
    const trail = hops.join(" → ");
    expect(t.includes("denied=1"), `never ?denied=1: ${trail}`).toBe(false);
    expect(/\/courses\/[0-9a-f-]{36}\/launch\?/.test(t), `each redirect is a course launch: ${trail}`).toBe(true);
    expect(hops.length, `at most three redirects: ${trail}`).toBeLessThanOrEqual(4);
    r = await noFollow(req, t);
  }
  expect(r.status, `${hops.join(" → ")}: ${describe(r)}`).toBe(200);
  return { hops, html: text(r.body) };
}

// ── seeds, through the app ──────────────────────────────────────────────────
async function newUser(orgId: string, role: "admin" | "user", key: string): Promise<User> {
  const u = (await createAuthUser({ profile: { first_name: "Journey", last_name: key, must_change_password: false } })) as User;
  await addMember({ organizationId: orgId, userId: u.id, role });
  return u;
}

/** A SCORM 1.2 course uploaded through the app; its id. */
async function scormCourse(req: APIRequestContext, slug: string, title: string): Promise<string> {
  const r = await uploadNew(req, slug, `${rand(6)}.zip`, await scormZip({ title }));
  expect(r.ok(), `upload ${title} → ${r.status()}: ${await r.text()}`).toBeTruthy();
  return (await r.json()).courseId as string;
}

type DayRowRead = { id: string; day_number: number; course_id: string | null; mission_title: string | null; pass_required: boolean | null };

/** The program's active days (a removed day has no number), by number. */
async function activeDays(programId: string): Promise<DayRowRead[]> {
  const { data, error } = await svc()
    .from("journey_days")
    .select("id, day_number, course_id, mission_title, pass_required")
    .eq("program_id", programId)
    .not("day_number", "is", null)
    .order("day_number");
  expect(error, `journey days: ${error?.message}`).toBeNull();
  return (data ?? []) as DayRowRead[];
}

const idsByNumber = (rows: DayRowRead[]) => Object.fromEntries(rows.map((r) => [r.day_number, r.id])) as Record<number, string>;

/** A full-shape save entry (journey_save_days reads a key left out as null); `rule` is the day's own pass rule. */
const entry = (n: number, id: string | null, course: string | null, rule: boolean | null = null) =>
  ({ id, day_number: n, course_id: course, mission_title: null, pass_required: rule, removed: false });

/**
 * A journey built and published (v1, new enrolments only) through the
 * journey program route: created, set to `daysTotal` days (count_sundays,
 * unlock_mode progress), its curriculum saved through journey_save_days (one
 * new day per course given; null = a rest day) and published (source
 * 'editor'). Answers the program and its day ids by number.
 */
async function buildJourney(req: APIRequestContext, slug: string, name: string, courses: Array<string | null>, daysTotal = courses.length) {
  const made = await req.post(PROGRAM_API, { data: { orgSlug: slug, name } });
  expect(made.ok(), `create ${name} → ${made.status()}: ${await made.text()}`).toBeTruthy();
  const programId = (await made.json()).program_id as string;
  const set = await req.patch(PROGRAM_API, { data: { orgSlug: slug, program_id: programId, days_total: daysTotal, count_sundays: true, unlock_mode: "progress" } });
  expect(set.ok(), `settings ${name} → ${set.status()}: ${await set.text()}`).toBeTruthy();
  const saved = await req.put(PROGRAM_API, { data: { orgSlug: slug, program_id: programId, days: courses.map((c, i) => entry(i + 1, null, c)) } });
  expect(saved.status(), `save ${name}: ${await saved.text()}`).toBe(200);
  expect((await saved.json()).inserted, `${name}: every day inserted`).toBe(courses.length);
  const pub = await req.post(PROGRAM_API, { data: { orgSlug: slug, action: "publish", program_id: programId, apply_to: "new" } });
  expect(pub.ok(), `publish ${name} → ${pub.status()}: ${await pub.text()}`).toBeTruthy();
  const v1 = await currentVersion(programId);
  expect(v1.day_ids_source, `${name}: v1 is the editor's`).toBe("editor");
  return { programId, days: idsByNumber(await activeDays(programId)) };
}

async function currentVersion(programId: string): Promise<{ id: string; day_ids: Record<string, string>; day_ids_source: string; days_total: number }> {
  const { data: p, error: pe } = await svc().from("journey_programs").select("current_version_id").eq("id", programId).single();
  expect(pe, `program ${programId}: ${pe?.message}`).toBeNull();
  const { data, error } = await svc()
    .from("journey_versions")
    .select("id, day_ids, day_ids_source, days_total")
    .eq("id", (p as { current_version_id: string }).current_version_id)
    .single();
  expect(error, `version: ${error?.message}`).toBeNull();
  return data as { id: string; day_ids: Record<string, string>; day_ids_source: string; days_total: number };
}

/** The learner enrolled by the admin's route (start today); the active enrolment's id. */
async function enrol(req: APIRequestContext, slug: string, programId: string, userId: string): Promise<string> {
  const r = await req.post("/api/journey/enrollments", { data: { orgSlug: slug, program_id: programId, user_ids: [userId], start_date: todayStr() } });
  expect(r.ok(), `enrol → ${r.status()}: ${await r.text()}`).toBeTruthy();
  expect((await r.json()).enrolled, "one enrolment").toBe(1);
  const { data, error } = await svc()
    .from("journey_enrollments")
    .select("id")
    .eq("program_id", programId)
    .eq("user_id", userId)
    .eq("status", "active")
    .single();
  expect(error, `enrolment: ${error?.message}`).toBeNull();
  return (data as { id: string }).id;
}

// ── rows ────────────────────────────────────────────────────────────────────
type JAtt = {
  id: string;
  status: string;
  is_revision: boolean | null;
  context_kind: string | null;
  context_key: string | null;
  journey_enrollment_id: string | null;
  journey_day_id: string | null;
  journey_version_id: string | null;
  cmi_data: Record<string, unknown> | null;
};
const ATT_COLUMNS = "id, status, is_revision, context_kind, context_key, journey_enrollment_id, journey_day_id, journey_version_id, cmi_data";

async function attemptsOf(userId: string): Promise<JAtt[]> {
  const { data, error } = await svc().from("course_attempts").select(ATT_COLUMNS).eq("user_id", userId).order("started_at");
  expect(error, `attempts: ${error?.message}`).toBeNull();
  return (data ?? []) as unknown as JAtt[];
}

const ctxKey = (enr: string, dayId: string) => `journey:${enr}:${dayId}`;
const officialIn = (rows: JAtt[], key: string) => rows.filter((r) => r.context_key === key && r.is_revision !== true);

/** An attempt's result and tags, every field the official result reads, for a field-by-field comparison (C-fail). */
const RESULT_COLUMNS =
  "id, status, completion_status, success_status, score, completed_at, is_revision, context_kind, context_key, journey_enrollment_id, journey_day, journey_day_id, journey_version_id";

async function resultRow(attemptId: string): Promise<Row> {
  const { data, error } = await svc().from("course_attempts").select(RESULT_COLUMNS).eq("id", attemptId).single();
  expect(error, `attempt ${attemptId}: ${error?.message}`).toBeNull();
  return data as Row;
}

/** The learner's official attempts (not revision visits) on one course, in every context, by id. */
async function officialOnCourse(userId: string, courseId: string): Promise<string[]> {
  const { data: vers, error: ve } = await svc().from("course_versions").select("id").eq("course_id", courseId);
  expect(ve, `versions of ${courseId}: ${ve?.message}`).toBeNull();
  const { data, error } = await svc()
    .from("course_attempts")
    .select("id, is_revision")
    .eq("user_id", userId)
    .in("course_version_id", ((vers ?? []) as Array<{ id: string }>).map((v) => v.id))
    .order("id");
  expect(error, `attempts on ${courseId}: ${error?.message}`).toBeNull();
  return ((data ?? []) as Array<{ id: string; is_revision: boolean | null }>).filter((r) => r.is_revision !== true).map((r) => r.id);
}

/** One context's official verdict (0107's v_context_attempt_summary, over the rows that are not revision visits). */
async function contextVerdict(userId: string, courseId: string, key: string): Promise<Row[]> {
  const { data, error } = await svc()
    .from("v_context_attempt_summary")
    .select("official_status, official_attempt_id, attempt_count")
    .eq("user_id", userId)
    .eq("course_id", courseId)
    .eq("context_key", key);
  expect(error, `verdict: ${error?.message}`).toBeNull();
  return (data ?? []) as Row[];
}

/** The learner's attempt requests on one course, granted or not (attempt_requests, 0083). */
async function requestsOn(userId: string, courseId: string): Promise<Row[]> {
  const { data, error } = await svc().from("attempt_requests").select("id, status").eq("user_id", userId).eq("course_id", courseId);
  expect(error, `attempt requests: ${error?.message}`).toBeNull();
  return (data ?? []) as Row[];
}

type Credit = { id: string; enrollment_id: string; day_id: string | null; day_number: number | null; course_id: string | null; attempt_id: string | null; credit_kind: string | null };

async function creditsOf(enrIds: string[]): Promise<Credit[]> {
  if (enrIds.length === 0) return [];
  const { data, error } = await svc()
    .from("journey_day_progress")
    .select("id, enrollment_id, day_id, day_number, course_id, attempt_id, credit_kind")
    .in("enrollment_id", enrIds)
    .order("id");
  expect(error, `credits: ${error?.message}`).toBeNull();
  return (data ?? []) as Credit[];
}

async function enrolment(id: string): Promise<{ status: string; completed_at: string | null; version_id: string }> {
  const { data, error } = await svc().from("journey_enrollments").select("status, completed_at, version_id").eq("id", id).single();
  expect(error, `enrolment ${id}: ${error?.message}`).toBeNull();
  return data as { status: string; completed_at: string | null; version_id: string };
}

async function badgesOf(enrIds: string[]): Promise<Row[]> {
  if (enrIds.length === 0) return [];
  const { data, error } = await svc()
    .from("user_badges")
    .select("id, user_id, period")
    .eq("badge_slug", "yoddha")
    .in("period", enrIds.map((e) => `enr:${e}`))
    .order("id");
  expect(error, `badges: ${error?.message}`).toBeNull();
  return (data ?? []) as Row[];
}

async function claimsOf(enrIds: string[]): Promise<Row[]> {
  if (enrIds.length === 0) return [];
  const { data, error } = await svc()
    .from("completion_notices")
    .select("id, instance_id, origin")
    .eq("product_kind", "journey")
    .in("instance_id", enrIds)
    .order("id");
  expect(error, `claims: ${error?.message}`).toBeNull();
  return (data ?? []) as Row[];
}

// ── the learner, through the app ────────────────────────────────────────────
const launchUrl = (slug: string, course: string, enr: string, day: string | number) => `/${slug}/courses/${course}/launch?journey=${enr}&day=${day}`;

/** A day's launch serves a new official attempt in the day's context; its id. */
async function startDay(req: APIRequestContext, u: User, slug: string, course: string, enr: string, dayId: string): Promise<string> {
  const before = new Set((await attemptsOf(u.id)).map((r) => r.id));
  const html = await served(req, launchUrl(slug, course, enr, dayId));
  const fresh = (await attemptsOf(u.id)).filter((r) => !before.has(r.id));
  expect(fresh.map((r) => [r.context_kind, r.context_key, r.is_revision === true, r.status]), "one new official attempt in the day's context")
    .toEqual([["journey", ctxKey(enr, dayId), false, "in_progress"]]);
  expect(html, "the launch runs that attempt").toContain(fresh[0].id);
  return fresh[0].id;
}

/**
 * The completion branch of the side-effect writer (ADR 0024 step 12), as the
 * nightly sweep calls it, for one completed attempt. Used only for a
 * course's completion in a second context (another day or another enrolment
 * holding a course this learner already completed): until phase 3 the
 * commit route classifies an attempt across the whole course
 * (classifyAttempt, with one scored attempt per course), so such a
 * completion is credited by the sweep, not in the request (N21; the P2-6
 * note's "Left open"). Spec 63 makes the same call. From phase 3 the request
 * credits it and this call finds nothing left to do.
 */
async function recordCompletion(attemptId: string) {
  const { error } = await svc().rpc("record_learning_activity", { p_attempt_id: attemptId, p_activity: false });
  expect(error, `record_learning_activity: ${error?.code} ${error?.message}`).toBeNull();
}

/**
 * A day completed through the app (launch, then a passed SCORM commit): the
 * day's credit names the attempt. `secondContext`: the learner already
 * completed this course in another context, so the sweep's call follows the
 * commit (recordCompletion).
 */
async function passDay(
  req: APIRequestContext,
  u: User,
  slug: string,
  course: string,
  enr: string,
  dayId: string,
  opts: { secondContext?: boolean } = {}
): Promise<string> {
  const id = await startDay(req, u, slug, course, enr, dayId);
  await scormCommit(req, id, PASSED, true);
  if (opts.secondContext) await recordCompletion(id);
  const mine = (await creditsOf([enr])).filter((c) => c.day_id === dayId);
  expect(mine.map((c) => c.attempt_id), "the day is credited with this attempt").toEqual([id]);
  return id;
}

/** A day started and left open with a bookmark (lesson_location and suspend_data). */
async function openDay(req: APIRequestContext, u: User, slug: string, course: string, enr: string, dayId: string, bookmark: string): Promise<string> {
  const id = await startDay(req, u, slug, course, enr, dayId);
  await scormCommit(req, id, { "cmi.core.lesson_status": "incomplete", "cmi.core.lesson_location": "page-2", "cmi.suspend_data": bookmark }, false);
  return id;
}

/** The started attempt resumes by a launch link: no new row, the same attempt and its bookmark served. */
async function expectResume(req: APIRequestContext, u: User, url: string, attemptId: string, bookmark: string, what: string) {
  const before = (await attemptsOf(u.id)).map((r) => r.id);
  const { html, hops } = await followLaunch(req, url);
  expect((await attemptsOf(u.id)).map((r) => r.id), `${what}: no new attempt (${hops.join(" → ")})`).toEqual(before);
  expect(html, `${what}: the launch runs the started attempt`).toContain(attemptId);
  expect(html, `${what}: with its bookmark`).toContain(bookmark);
  const row = (await attemptsOf(u.id)).find((r) => r.id === attemptId)!;
  expect([row.status, row.cmi_data?.["cmi.suspend_data"]], `${what}: still open, bookmark kept`).toEqual(["in_progress", bookmark]);
  return hops;
}

/** The journey page's credited count ("Missions X/Y") and its today's-mission links, for one enrolment. */
async function journeyPage(req: APIRequestContext, slug: string, enr: string): Promise<{ credited: number; total: number; links: string[] }> {
  const html = await served(req, `/${slug}/journey?j=${enr}`);
  const m = /Missions<\/p>\s*<p[^>]*>(\d+)\/(\d+)<\/p>/.exec(html);
  expect(m, "the journey page shows the missions count").toBeTruthy();
  const links = [...html.matchAll(/href="([^"]*\/launch\?journey=[^"]*)"/g)].map((x) => x[1]).filter((h) => h.includes(`journey=${enr}&`));
  return { credited: Number(m![1]), total: Number(m![2]), links };
}

/** Journey admin's credited count for one enrolment (the roster cell's data-count). */
async function adminCredited(req: APIRequestContext, slug: string, programId: string, enr: string): Promise<number> {
  const html = await served(req, `/${slug}/journey-admin?program=${programId}`);
  const tag = new RegExp(`<td[^>]*data-testid="journey-enrollment-credited-${enr}"[^>]*>`).exec(html)?.[0] ?? "";
  const n = /data-count="(\d+)"/.exec(tag);
  expect(n, "journey admin shows the enrolment's credited count").toBeTruthy();
  return Number(n![1]);
}

// ── the editor, in the browser ──────────────────────────────────────────────
async function editorPage(ctx: BrowserContext, slug: string, programId: string): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto(`/${slug}/journey-admin?program=${programId}`, { timeout: 120_000 });
  await expect(page.getByTestId("journey-save"), "the curriculum editor").toBeVisible({ timeout: 60_000 });
  return page;
}

const isProgramCall = (method: string, action?: string) => (r: Response) => {
  if (!r.url().includes(PROGRAM_API) || r.request().method() !== method) return false;
  if (action === undefined) return true;
  try {
    return (r.request().postDataJSON() as Row | null)?.action === action;
  } catch {
    return false;
  }
};

/** A save's answer, after a click that sends it. */
async function saved(page: Page, click: () => Promise<void>): Promise<Row> {
  const [res] = await Promise.all([page.waitForResponse(isProgramCall("PUT"), { timeout: 120_000 }), click()]);
  const body = (await res.json()) as Row;
  expect(res.status(), `save: ${JSON.stringify(body.error ?? null)}`).toBe(200);
  expect(body.ok, "the save answers ok").toBe(true);
  await expect(page.getByTestId("journey-save")).toBeEnabled({ timeout: 30_000 });
  return body;
}

/** What the editor shows: each slot's day id by number, and the rows past the journey's length. */
async function shownLayout(page: Page, daysTotal: number): Promise<Record<number, string>> {
  const out: Record<number, string> = {};
  for (let n = 1; n <= daysTotal; n++) {
    out[n] = (await page.getByTestId(`journey-day-${n}`).getAttribute("data-day-id")) ?? "";
  }
  for (const li of await page.locator('[data-testid^="journey-beyond-"]').all()) {
    const n = Number(((await li.getAttribute("data-testid")) ?? "").replace("journey-beyond-", ""));
    out[n] = (await li.getAttribute("data-day-id")) ?? "";
  }
  return out;
}

/** "Remove day" on a saved day, through its confirmation. */
async function removeInEditor(page: Page, n: number) {
  await page.getByTestId(`journey-day-${n}-remove`).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove day" }).click();
}

// ── condition 3: what a dry run must not change ─────────────────────────────
type Snap = { enrolments: Row[]; versions: string[]; current: string | null; credits: Credit[]; attempts: Row[]; badges: Row[]; claims: Row[] };

async function snapshot(programId: string, userId: string): Promise<Snap> {
  const db = svc();
  const { data: enr, error: ee } = await db.from("journey_enrollments").select("id, version_id, status, completed_at").eq("program_id", programId).order("id");
  expect(ee, `enrolments: ${ee?.message}`).toBeNull();
  const enrolments = (enr ?? []) as Row[];
  const enrIds = enrolments.map((e) => e.id as string);
  const { data: vers, error: ve } = await db.from("journey_versions").select("id").eq("program_id", programId).order("id");
  expect(ve, `versions: ${ve?.message}`).toBeNull();
  const { data: prog, error: pe } = await db.from("journey_programs").select("current_version_id").eq("id", programId).single();
  expect(pe, `program: ${pe?.message}`).toBeNull();
  const { data: atts, error: ae } = await db
    .from("course_attempts")
    .select("id, status, context_key, journey_day_id, journey_version_id, journey_enrollment_id")
    .eq("user_id", userId)
    .order("id");
  expect(ae, `attempts: ${ae?.message}`).toBeNull();
  return {
    enrolments,
    versions: ((vers ?? []) as Array<{ id: string }>).map((v) => v.id),
    current: (prog as { current_version_id: string | null }).current_version_id,
    credits: await creditsOf(enrIds),
    attempts: (atts ?? []) as Row[],
    badges: await badgesOf(enrIds),
    claims: await claimsOf(enrIds),
  };
}

/**
 * Steps (i) to (iii) of a republish case: the edit and Save in the editor,
 * then "Publish & update everyone": the dry run's answer and the dialog's
 * counts, S0 = S1 around it, the confirmed publish's counts equal to the dry
 * run's, the new version's day map, and every attempt and credit row of S0
 * unchanged.
 */
async function republish(o: { page: Page; programId: string; learner: User; edit: () => Promise<void>; expected: Counts }) {
  await saved(o.page, o.edit);
  const s0 = await snapshot(o.programId, o.learner.id);
  const [dryRes] = await Promise.all([
    o.page.waitForResponse(isProgramCall("POST", "dry_run"), { timeout: 120_000 }),
    o.page.getByTestId("journey-publish-all").click(),
  ]);
  const dryBody = (await dryRes.json()) as Row;
  expect([dryRes.status(), dryBody.ok, dryBody.dry_run], `dry run: ${JSON.stringify(dryBody.error ?? null)}`).toEqual([200, true, true]);
  const dry = countsOf(dryBody);
  await expect(o.page.getByTestId("journey-dry-run"), "the confirmation with the counts").toBeVisible();
  const shown: Row = {};
  for (const k of REPIN_KEYS) shown[k] = Number(await o.page.getByTestId(`journey-dry-run-${k}`).getAttribute("data-count"));
  expect(shown, "the dialog shows the dry run's counts").toEqual(dry);
  expect(dry, "the dry run's counts (0107 section 6f)").toEqual(o.expected);

  // (ii) condition 3: the dry run wrote nothing.
  const s1 = await snapshot(o.programId, o.learner.id);
  expect(s1, "the dry run changed nothing").toEqual(s0);

  // (iii) the publish, confirmed.
  const [pubRes] = await Promise.all([
    o.page.waitForResponse(isProgramCall("POST", "publish"), { timeout: 120_000 }),
    o.page.getByTestId("journey-dry-run-confirm").click(),
  ]);
  const pubBody = (await pubRes.json()) as Row;
  expect([pubRes.status(), pubBody.ok], `publish: ${JSON.stringify(pubBody.error ?? null)}`).toEqual([200, true]);
  expect(countsOf(pubBody), "the publish's counts equal the dry run's, key by key").toEqual(dry);
  const v = await currentVersion(o.programId);
  expect(v.id, "a new version is current").not.toBe(s0.current);
  expect(v.day_ids_source, "the version's day map is the editor's").toBe("editor");
  const savedRows = (await activeDays(o.programId)).filter((r) => r.day_number <= v.days_total);
  expect(v.day_ids, "day_ids = the saved rows' ids by number").toEqual(Object.fromEntries(savedRows.map((r) => [String(r.day_number), r.id])));
  const s2 = await snapshot(o.programId, o.learner.id);
  expect(s2.attempts, "no attempt row changed").toEqual(s0.attempts);
  expect(s2.credits, "no credit row changed or added").toEqual(s0.credits);
  return { dry, s0, s2, version: v };
}

// ════════════════════════════════════════════════════════════════════════════
// A. Launch cases.
// ════════════════════════════════════════════════════════════════════════════
test.describe.serial("ADR 0024 P2-8 spec 69 — journey launches in their own contexts", () => {
  const s: {
    org?: Org;
    adminCtx?: BrowserContext;
    x?: string;
    y?: string;
    w?: string;
    /** (a) to (c): course X on days 1 and 2. */
    pa?: { programId: string; days: Record<number, string> };
    la?: User;
    laCtx?: BrowserContext;
    ea?: string;
    a1?: string;
    a2?: string;
    ea2?: string;
  } = {};
  const slug = () => s.org!.slug;

  test.afterAll(async () => {
    await s.laCtx?.close().catch(() => {});
    await s.adminCtx?.close().catch(() => {});
  });

  test("seed: courses X, Y and W (SCORM, uploaded); journey PA with X on days 1 and 2; learner LA enrolled", async ({ browser, baseURL }) => {
    test.setTimeout(600_000);
    expect(await has0107(), "0107 is not applied on this database: P2-8's save and publish need it").toBe(true);
    const org = await createOrg({ name: "Lifecycle Journey Contexts A" });
    s.org = org;
    const admin = await newUser(org.id, "admin", "Admin A");
    s.adminCtx = await authedContext(browser, baseURL!, admin.email, admin.password);
    const areq = s.adminCtx.request;
    const tag = rand(4);
    s.x = await scormCourse(areq, org.slug, `QA Journey X ${tag}`);
    s.y = await scormCourse(areq, org.slug, `QA Journey Y ${tag}`);
    s.w = await scormCourse(areq, org.slug, `QA Journey W ${tag}`);
    s.pa = await buildJourney(areq, org.slug, `Contexts PA ${tag}`, [s.x, s.x]);
    s.la = await newUser(org.id, "user", "LA");
    s.ea = await enrol(areq, org.slug, s.pa.programId, s.la.id);
    s.laCtx = await authedContext(browser, baseURL!, s.la.email, s.la.password);
  });

  test("(a) one course on two days: two official attempts in two contexts; completing day 1 credits day 1 only", async () => {
    test.setTimeout(300_000);
    const u = s.la!;
    const req = s.laCtx!.request;
    const [d1, d2] = [s.pa!.days[1], s.pa!.days[2]];
    s.a1 = await passDay(req, u, slug(), s.x!, s.ea!, d1);
    expect((await creditsOf([s.ea!])).map((c) => c.day_id), "day 1 only").toEqual([d1]);
    s.a2 = await startDay(req, u, slug(), s.x!, s.ea!, d2);
    const rows = await attemptsOf(u.id);
    expect(rows.filter((r) => r.context_kind === "journey").map((r) => [r.id, r.context_key]), "two attempts, one per day's context").toEqual([
      [s.a1, ctxKey(s.ea!, d1)],
      [s.a2, ctxKey(s.ea!, d2)],
    ]);
    expect((await creditsOf([s.ea!])).map((c) => c.day_id), "still day 1 only while day 2 is open").toEqual([d1]);
  });

  test("(b) re-run after a reset: the reset enrolment is refused; a new enrolment opens a fresh context; the old attempts keep theirs", async () => {
    test.setTimeout(300_000);
    const u = s.la!;
    const req = s.laCtx!.request;
    const areq = s.adminCtx!.request;
    const old = (await attemptsOf(u.id)).filter((r) => r.journey_enrollment_id === s.ea);
    const reset = await areq.patch("/api/journey/enrollments", { data: { orgSlug: slug(), enrollment_id: s.ea, action: "reset" } });
    expect(reset.ok(), `reset → ${reset.status()}: ${await reset.text()}`).toBeTruthy();
    expect((await enrolment(s.ea!)).status).toBe("reset");
    const refused = await noFollow(req, launchUrl(slug(), s.x!, s.ea!, s.pa!.days[1]));
    expect(redirectTarget(refused), `the reset enrolment's launch: ${describe(refused)}`).toBe(`/${slug()}/dashboard?denied=1`);

    s.ea2 = await enrol(areq, slug(), s.pa!.programId, u.id);
    expect(s.ea2, "a new enrolment").not.toBe(s.ea);
    const fresh = await startDay(req, u, slug(), s.x!, s.ea2, s.pa!.days[1]);
    expect(fresh, "not the old day 1 attempt").not.toBe(s.a1);
    const after = (await attemptsOf(u.id)).filter((r) => r.journey_enrollment_id === s.ea);
    const keep = (rows: JAtt[]) => rows.map((r) => [r.id, r.status, r.context_key, r.journey_enrollment_id, r.journey_day_id]);
    expect(keep(after), "the old attempts keep their enrolment and context").toEqual(keep(old));
    await scormCommit(req, fresh, PASSED, true);
    await recordCompletion(fresh); // X's second completion by this learner (N21)
    expect((await creditsOf([s.ea2])).map((c) => [c.day_id, c.attempt_id]), "the new enrolment's day 1, by the new attempt").toEqual([[s.pa!.days[1], fresh]]);
  });

  test("(c) review of a credited day and of a completed journey: a revision visit, never a new official attempt", async () => {
    test.setTimeout(300_000);
    const u = s.la!;
    const req = s.laCtx!.request;
    const [d1, d2] = [s.pa!.days[1], s.pa!.days[2]];
    const review = async (dayId: string, what: string) => {
      const before = await attemptsOf(u.id);
      const html = await served(req, launchUrl(slug(), s.x!, s.ea2!, dayId));
      const rows = await attemptsOf(u.id);
      const key = ctxKey(s.ea2!, dayId);
      expect(officialIn(rows, key).map((r) => r.id), `${what}: the official attempt is still the one`).toEqual(officialIn(before, key).map((r) => r.id));
      const fresh = rows.filter((r) => !before.some((b) => b.id === r.id));
      for (const r of fresh) expect([r.is_revision, r.context_key], `${what}: a new row is a revision visit in the day's context`).toEqual([true, key]);
      expect(html, `${what}: the revision visit's badge`).toContain('data-testid="practice-badge"');
    };
    await review(d1, "a credited day of an active enrolment");
    await passDay(req, u, slug(), s.x!, s.ea2!, d2, { secondContext: true });
    const done = await enrolment(s.ea2!);
    expect([done.status, typeof done.completed_at], "the journey completed").toEqual(["completed", "string"]);
    expect((await badgesOf([s.ea2!])).length, "one badge").toBe(1);
    expect((await claimsOf([s.ea2!])).map((c) => c.origin), "one claim, origin learner").toEqual(["learner"]);
    await review(d2, "a day of a completed journey");
    await review(d1, "another day of the completed journey");
    expect((await badgesOf([s.ea2!])).length, "still one badge").toBe(1);
  });

  test("(d) several active journeys holding one course: each launch tags its own enrolment and credits only it", async ({ browser, baseURL }) => {
    test.setTimeout(400_000);
    const areq = s.adminCtx!.request;
    const tag = rand(4);
    const p1 = await buildJourney(areq, slug(), `Contexts PD1 ${tag}`, [s.y!, null]);
    const p2 = await buildJourney(areq, slug(), `Contexts PD2 ${tag}`, [s.y!, null]);
    const u = await newUser(s.org!.id, "user", "LD");
    const e1 = await enrol(areq, slug(), p1.programId, u.id);
    const e2 = await enrol(areq, slug(), p2.programId, u.id);
    const ctx = await authedContext(browser, baseURL!, u.email, u.password);
    try {
      const req = ctx.request;
      const plain = await noFollow(req, `/${slug()}/courses/${s.y}/launch`);
      expect(redirectTarget(plain), `no product parameter, two holders: ${describe(plain)}`).toBe(`/${slug()}/dashboard`);
      expect(await attemptsOf(u.id), "that redirect writes nothing").toEqual([]);
      const t1 = await passDay(req, u, slug(), s.y!, e1, p1.days[1]);
      expect((await creditsOf([e2])).length, "the other journey's day is not credited").toBe(0);
      const t2 = await startDay(req, u, slug(), s.y!, e2, p2.days[1]);
      const rows = await attemptsOf(u.id);
      expect(rows.map((r) => [r.id, r.journey_enrollment_id, r.context_key]), "each attempt tags its own enrolment").toEqual([
        [t1, e1, ctxKey(e1, p1.days[1])],
        [t2, e2, ctxKey(e2, p2.days[1])],
      ]);
      await scormCommit(req, t2, PASSED, true);
      await recordCompletion(t2); // Y's second completion by this learner (N21)
      const byEnrolment = (pairs: string[][]) => [...pairs].sort((a, b) => a[0].localeCompare(b[0]));
      expect(byEnrolment((await creditsOf([e1, e2])).map((c) => [c.enrollment_id, c.attempt_id ?? ""])), "each credit names its own enrolment's attempt")
        .toEqual(byEnrolment([[e1, t1], [e2, t2]]));
    } finally {
      await ctx.close().catch(() => {});
    }
  });

  test("(e) a stale numeric link after a renumbering publish never serves another day's attempt", async ({ browser, baseURL }) => {
    test.setTimeout(400_000);
    const areq = s.adminCtx!.request;
    const tag = rand(4);
    const pe = await buildJourney(areq, slug(), `Contexts PE ${tag}`, [s.x!, s.y!, null]);
    const u = await newUser(s.org!.id, "user", "LE");
    const e = await enrol(areq, slug(), pe.programId, u.id);
    const ctx = await authedContext(browser, baseURL!, u.email, u.password);
    try {
      const req = ctx.request;
      await passDay(req, u, slug(), s.x!, e, pe.days[1]);
      const bookmark = `qa-stale-${rand(6)}`;
      const started = await openDay(req, u, slug(), s.y!, e, pe.days[2], bookmark);

      // A day with W inserted at 2 (the editor names every row it holds; the
      // rest day moves past the length), then a publish to all.
      const put = await areq.put(PROGRAM_API, {
        data: {
          orgSlug: slug(),
          program_id: pe.programId,
          days: [entry(1, pe.days[1], s.x!), entry(2, null, s.w!), entry(3, pe.days[2], s.y!), entry(4, pe.days[3], null)],
        },
      });
      expect(put.status(), await put.text()).toBe(200);
      const pub = await areq.post(PROGRAM_API, { data: { orgSlug: slug(), action: "publish", program_id: pe.programId, apply_to: "all" } });
      expect(pub.status(), await pub.text()).toBe(200);
      expect((await pub.json()).repinned, "the learner is re-pinned").toBe(1);
      const inserted = (await activeDays(pe.programId)).find((r) => r.day_number === 2)!.id;
      expect(inserted, "day 2 is the inserted day").not.toBe(pe.days[2]);

      const before = (await attemptsOf(u.id)).map((r) => r.id);
      const stale = await noFollow(req, launchUrl(slug(), s.y!, e, 2));
      expect(redirectTarget(stale), `the old number 2 now names the inserted day (W): ${describe(stale)}`).toBe(`/${slug()}/dashboard?denied=1`);
      expect((await attemptsOf(u.id)).map((r) => r.id), "the refusal writes nothing").toEqual(before);
      await expectResume(req, u, launchUrl(slug(), s.y!, e, pe.days[2]), started, bookmark, "the started day by its id");
      await expectResume(req, u, launchUrl(slug(), s.y!, e, 3), started, bookmark, "the started day by its new number");
      const opened = await startDay(req, u, slug(), s.w!, e, inserted);
      expect(opened, "the inserted day opens its own attempt").not.toBe(started);
    } finally {
      await ctx.close().catch(() => {});
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// B. The editor and the save, in the browser.
// ════════════════════════════════════════════════════════════════════════════
test.describe.serial("ADR 0024 P2-8 spec 69 — the journey editor keeps each day's id across saves", () => {
  const s: {
    org?: Org;
    adminCtx?: BrowserContext;
    page?: Page;
    k?: [string, string, string];
    programId?: string;
    /** The ids after each save, by number. */
    after1?: Record<number, string>;
    after2?: Record<number, string>;
  } = {};

  test.afterAll(async () => {
    await s.page?.close().catch(() => {});
    await s.adminCtx?.close().catch(() => {});
  });

  test("seed: courses K1, K2, K3; a 4-day journey with days 1 to 3 saved (K1, K2, K3) and slot 4 empty", async ({ browser, baseURL }) => {
    test.setTimeout(600_000);
    expect(await has0107(), "0107 is not applied on this database: P2-8's save needs it").toBe(true);
    const org = await createOrg({ name: "Lifecycle Journey Contexts B" });
    s.org = org;
    const admin = await newUser(org.id, "admin", "Admin B");
    s.adminCtx = await authedContext(browser, baseURL!, admin.email, admin.password);
    const areq = s.adminCtx.request;
    const tag = rand(4);
    s.k = [
      await scormCourse(areq, org.slug, `QA Journey K1 ${tag}`),
      await scormCourse(areq, org.slug, `QA Journey K2 ${tag}`),
      await scormCourse(areq, org.slug, `QA Journey K3 ${tag}`),
    ];
    const made = await areq.post(PROGRAM_API, { data: { orgSlug: org.slug, name: `Contexts PB ${tag}` } });
    expect(made.ok(), await made.text()).toBeTruthy();
    s.programId = (await made.json()).program_id as string;
    const set = await areq.patch(PROGRAM_API, { data: { orgSlug: org.slug, program_id: s.programId, days_total: 4, count_sundays: true, unlock_mode: "progress" } });
    expect(set.ok(), await set.text()).toBeTruthy();
    // K2's day (2) holds a pass rule of its own, so the editor's saves are
    // seen to send each loaded rule back unchanged (P2-N8).
    const put = await areq.put(PROGRAM_API, { data: { orgSlug: org.slug, program_id: s.programId, days: s.k.map((c, i) => entry(i + 1, null, c, i === 1 ? true : null)) } });
    expect(put.status(), await put.text()).toBe(200);
    expect((await activeDays(s.programId)).map((r) => [r.day_number, r.pass_required]), "K2's day holds a rule of its own").toEqual([[1, null], [2, true], [3, null]]);
    s.page = await editorPage(s.adminCtx, org.slug, s.programId);
  });

  test("(b1) two saves in one page session, the second after \"Insert a day here\" and a move: both 200, the first save's rows keep their ids, one new row each", async () => {
    test.setTimeout(300_000);
    const page = s.page!;
    const [k1, k2, k3] = s.k!;
    const d0 = idsByNumber(await activeDays(s.programId!));
    expect(Object.keys(d0).length, "three saved days").toBe(3);

    // First save: day 1 moved down (its id goes with it), the empty slot 4 given K3 (a new row).
    const first = await saved(page, async () => {
      await page.getByTestId("journey-day-1-down").click();
      await page.getByTestId("journey-day-4-module").selectOption(k3);
      await page.getByTestId("journey-save").click();
    });
    expect([first.inserted, first.renumbered], "one new row, two renumbered").toEqual([1, 2]);
    s.after1 = idsByNumber(await activeDays(s.programId!));
    expect([s.after1[1], s.after1[2], s.after1[3]], "the saved days moved by identity").toEqual([d0[2], d0[1], d0[3]]);
    expect(Object.values(d0).includes(s.after1[4]), "day 4 is a new row").toBe(false);
    expect(await shownLayout(page, 4), "the editor shows the saved ids").toEqual(s.after1);

    // Second save, same page session: "Insert a day here" at 2 (given K1),
    // then day 4 moved up. The row pushed past the length (5) is still named.
    const second = await saved(page, async () => {
      await page.getByTestId("journey-day-2-insert").click();
      await page.getByTestId("journey-day-2-module").selectOption(k1);
      await page.getByTestId("journey-day-4-up").click();
      await page.getByTestId("journey-save").click();
    });
    expect(second.inserted, "one new row").toBe(1);
    s.after2 = idsByNumber(await activeDays(s.programId!));
    const a1 = s.after1;
    expect([s.after2[1], s.after2[3], s.after2[4], s.after2[5]], "every row of the first save keeps its id, at the numbers shown").toEqual([a1[1], a1[3], a1[2], a1[4]]);
    expect(Object.values(a1).includes(s.after2[2]), "day 2 is the one new row").toBe(false);
    expect(await shownLayout(page, 4), "the editor's layout is the database's, the row past the length included").toEqual(s.after2);
    expect(await page.getByTestId("journey-days-beyond").isVisible(), "the row past the length is listed apart").toBe(true);
    const rows = await activeDays(s.programId!);
    expect(rows.map((r) => [r.day_number, r.course_id]), "the modules as set").toEqual([[1, k2], [2, k1], [3, k3], [4, k1], [5, k3]]);
    expect(rows.map((r) => [r.id, r.pass_required]), "K2's day keeps its own rule through both saves and no other day gains one (P2-N8)")
      .toEqual(rows.map((r) => [r.id, r.id === d0[2] ? true : null]));
  });

  test("(b2) \"Move instead?\" accepted: the day whose module was cleared now holds it at its new number", async () => {
    test.setTimeout(300_000);
    const page = s.page!;
    const [, k2] = s.k!;
    const x = s.after2![1]; // holds K2
    const y = s.after2![3]; // holds K3
    await page.getByTestId("journey-day-1-module").selectOption("");
    await page.getByTestId("journey-day-3-module").selectOption(k2);
    await page.getByTestId("journey-save").click();
    await expect(page.getByTestId("journey-move-instead"), "the editor asks").toBeVisible({ timeout: 30_000 });
    const answer = await saved(page, () => page.getByTestId("journey-move-instead-accept").click());
    expect(answer.inserted, "no new row").toBe(0);
    const rows = await activeDays(s.programId!);
    const at = (n: number) => rows.find((r) => r.day_number === n)!;
    expect([at(3).id, at(3).course_id], "K2's day (its id) now on day 3, with K2").toEqual([x, k2]);
    expect([at(1).id, at(1).course_id], "the other day takes day 1, a rest day").toEqual([y, null]);
    expect([at(3).pass_required, at(1).pass_required], "each day keeps its own rule: K2's day true, the other none (P2-N8)").toEqual([true, null]);
    await expect(page.getByTestId("journey-day-3-module"), "the editor shows K2 on day 3").toHaveValue(k2);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// C. Republish (A27), through the editor: one program, one learner and one
//    publish per edit.
// ════════════════════════════════════════════════════════════════════════════
test.describe.serial("ADR 0024 P2-8 spec 69 — republish by day identity: the dry run, the publish and the learner", () => {
  const s: {
    org?: Org;
    admin?: User;
    adminCtx?: BrowserContext;
    /** A to F. */
    c?: Record<"A" | "B" | "C" | "D" | "E" | "F", string>;
    contexts: BrowserContext[];
  } = { contexts: [] };
  const slug = () => s.org!.slug;

  test.afterAll(async () => {
    for (const ctx of s.contexts) await ctx.close().catch(() => {});
    await s.adminCtx?.close().catch(() => {});
  });

  test("seed: six SCORM courses A to F", async ({ browser, baseURL }) => {
    test.setTimeout(900_000);
    expect(await has0107(), "0107 is not applied on this database: P2-8's publish needs it").toBe(true);
    const org = await createOrg({ name: "Lifecycle Journey Contexts C" });
    s.org = org;
    s.admin = await newUser(org.id, "admin", "Admin C");
    s.adminCtx = await authedContext(browser, baseURL!, s.admin.email, s.admin.password);
    const tag = rand(4);
    const c: Record<string, string> = {};
    for (const k of ["A", "B", "C", "D", "E", "F"]) c[k] = await scormCourse(s.adminCtx.request, org.slug, `QA Journey ${k} ${tag}`);
    s.c = c as Record<"A" | "B" | "C" | "D" | "E" | "F", string>;
  });

  /**
   * One case's world: a journey (A, B, C, D, E and a rest day 6; C-pub: A, B,
   * C; C-fail: A, G, C), a fresh learner who completed days 1 to `done`
   * through the app and holds the next day open with a bookmark (C-fail then
   * fails that day), and the editor on the program.
   */
  async function world(browser: Browser, baseURL: string, name: string, courses: Array<string | null>, done: number) {
    const areq = s.adminCtx!.request;
    const j = await buildJourney(areq, slug(), `${name} ${rand(4)}`, courses);
    const u = await newUser(s.org!.id, "user", name);
    const enr = await enrol(areq, slug(), j.programId, u.id);
    const ctx = await authedContext(browser, baseURL, u.email, u.password);
    s.contexts.push(ctx);
    const passed: string[] = [];
    for (let n = 1; n <= done; n++) passed.push(await passDay(ctx.request, u, slug(), courses[n - 1]!, enr, j.days[n]));
    const bookmark = `qa-${name.toLowerCase()}-${rand(6)}`;
    const open = await openDay(ctx.request, u, slug(), courses[done]!, enr, j.days[done + 1], bookmark);
    const page = await editorPage(s.adminCtx!, slug(), j.programId);
    return { ...j, u, enr, req: ctx.request, passed, open, bookmark, page };
  }

  /** (iv): the journey page and journey admin show the same credited count; today's mission is `todayDay`'s link on `todayCourse`. */
  async function learnerSees(w: Awaited<ReturnType<typeof world>>, o: { credited: number; total: number; todayCourse: string; todayDay: string }) {
    const jp = await journeyPage(w.req, slug(), w.enr);
    expect([jp.credited, jp.total], "the journey page's credited count").toEqual([o.credited, o.total]);
    expect(await adminCredited(s.adminCtx!.request, slug(), w.programId, w.enr), "journey admin's count is the same").toBe(o.credited);
    const today = `/${slug()}/courses/${o.todayCourse}/launch?journey=${w.enr}&day=${o.todayDay}`;
    expect(jp.links, "today's mission is the open day").toContain(today);
    const credited = new Set((await creditsOf([w.enr])).map((c) => c.day_id));
    for (const link of jp.links) {
      const day = new URL(link, "http://x.invalid").searchParams.get("day") ?? "";
      if (!credited.has(day)) continue;
      // A credited day is only ever offered as a review of its credit's course.
      const credit = (await creditsOf([w.enr])).find((c) => c.day_id === day)!;
      expect(link, "a credited day's link opens its credit's course").toContain(`/courses/${credit.course_id}/launch?`);
    }
  }

  /**
   * The learner finished every remaining day: the enrolment completed once
   * (status and completed_at), one badge, one claim (origin learner), and
   * journey admin counts every required day of the pinned version.
   */
  async function expectCompleted(w: Awaited<ReturnType<typeof world>>, total: number) {
    const done = await enrolment(w.enr);
    expect([done.status, typeof done.completed_at], "completed").toEqual(["completed", "string"]);
    expect((await badgesOf([w.enr])).length, "one badge").toBe(1);
    expect((await claimsOf([w.enr])).map((x) => x.origin), "one claim, origin learner").toEqual(["learner"]);
    expect(await adminCredited(s.adminCtx!.request, slug(), w.programId, w.enr), "journey admin counts every required day").toBe(total);
  }

  test("(C-ins) a day inserted before the open day: sent back, the started day kept; the learner then finishes the journey", async ({ browser, baseURL }) => {
    test.setTimeout(600_000);
    const c = s.c!;
    const w = await world(browser, baseURL!, "Ins", [c.A, c.B, c.C, c.D, c.E, null], 3);
    const { s2 } = await republish({
      page: w.page,
      programId: w.programId,
      learner: w.u,
      edit: async () => {
        await w.page.getByTestId("journey-day-2-insert").click();
        await w.page.getByTestId("journey-day-2-module").selectOption(c.F);
        await w.page.getByTestId("journey-save").click();
      },
      expected: { ...ZERO, repinned: 1, sent_back: 1, started_days_kept: 1 },
    });
    expect(s2.enrolments.map((e) => e.status), "still active").toEqual(["active"]);
    const now = idsByNumber(await activeDays(w.programId));
    expect([now[1], now[3], now[4], now[5], now[6], now[7]], "every day kept its id; the rest day is past the length").toEqual([w.days[1], w.days[2], w.days[3], w.days[4], w.days[5], w.days[6]]);
    const inserted = now[2];

    // (iv) today's mission is the inserted day; the started day (now day 5) resumes.
    await learnerSees(w, { credited: 3, total: 6, todayCourse: c.F, todayDay: inserted });
    await expectResume(w.req, w.u, launchUrl(slug(), c.D, w.enr, w.days[4]), w.open, w.bookmark, "the started day by its launch link");
    await scormCommit(w.req, w.open, PASSED, true);
    expect((await creditsOf([w.enr])).find((x) => x.attempt_id === w.open)?.day_id, "its completion credits its own day id").toBe(w.days[4]);

    // Then every remaining day: one completion, one badge, one claim (learner).
    await passDay(w.req, w.u, slug(), c.F, w.enr, inserted);
    expect((await enrolment(w.enr)).status, "not complete before the last day").toBe("active");
    await passDay(w.req, w.u, slug(), c.E, w.enr, w.days[5]);
    const done = await enrolment(w.enr);
    expect([done.status, typeof done.completed_at], "completed").toEqual(["completed", "string"]);
    expect((await badgesOf([w.enr])).length, "one badge").toBe(1);
    expect((await claimsOf([w.enr])).map((x) => x.origin), "one claim, origin learner").toEqual(["learner"]);
  });

  test("(C-swap) two completed days swapped by Move down: credits follow their days; nothing is offered again", async ({ browser, baseURL }) => {
    test.setTimeout(600_000);
    const c = s.c!;
    const w = await world(browser, baseURL!, "Swap", [c.A, c.B, c.C, c.D, c.E, null], 3);
    await republish({
      page: w.page,
      programId: w.programId,
      learner: w.u,
      edit: async () => {
        await w.page.getByTestId("journey-day-1-down").click();
        await w.page.getByTestId("journey-save").click();
      },
      expected: { ...ZERO, repinned: 1 },
    });
    const now = idsByNumber(await activeDays(w.programId));
    expect([now[1], now[2]], "days 1 and 2 swapped by identity").toEqual([w.days[2], w.days[1]]);
    await learnerSees(w, { credited: 3, total: 5, todayCourse: c.D, todayDay: w.days[4] });
    await expectResume(w.req, w.u, launchUrl(slug(), c.D, w.enr, w.days[4]), w.open, w.bookmark, "the open day by its launch link");
    await scormCommit(w.req, w.open, PASSED, true);
    expect((await creditsOf([w.enr])).find((x) => x.attempt_id === w.open)?.day_id, "its completion credits its own day id").toBe(w.days[4]);
    // Then the last required day (E): the enrolment completes.
    expect((await enrolment(w.enr)).status, "not complete before the last day").toBe("active");
    await passDay(w.req, w.u, slug(), c.E, w.enr, w.days[5]);
    await expectCompleted(w, 5);
  });

  test("(C-course) the open day's module changed in place: the started module resumes and credits the day; the new one is not opened beside it", async ({ browser, baseURL }) => {
    test.setTimeout(600_000);
    const c = s.c!;
    const w = await world(browser, baseURL!, "Course", [c.A, c.B, c.C, c.D, c.E, null], 3);
    await republish({
      page: w.page,
      programId: w.programId,
      learner: w.u,
      edit: async () => {
        await w.page.getByTestId("journey-day-4-module").selectOption(c.F);
        await w.page.getByTestId("journey-save").click();
      },
      expected: { ...ZERO, repinned: 1, started_days_kept: 1 },
    });
    await learnerSees(w, { credited: 3, total: 5, todayCourse: c.F, todayDay: w.days[4] });
    // The day's link names its new module; it goes into the started one.
    const hops = await expectResume(w.req, w.u, launchUrl(slug(), c.F, w.enr, w.days[4]), w.open, w.bookmark, "the day's link on its new module");
    expect(hops[hops.length - 1], "into the started module's launch of the same day").toContain(`/courses/${c.D}/launch?journey=${w.enr}&day=${w.days[4]}`);
    await scormCommit(w.req, w.open, PASSED, true);
    const credit = (await creditsOf([w.enr])).find((x) => x.day_id === w.days[4]);
    expect([credit?.attempt_id, credit?.course_id], "the day is credited by the started module").toEqual([w.open, c.D]);
    const onF = (await attemptsOf(w.u.id)).filter((r) => r.context_key === ctxKey(w.enr, w.days[4]) && r.id !== w.open);
    expect(onF, "no attempt on the new module beside it").toEqual([]);
    // The day credited by the started module counts: 4 of 5, today's mission is E.
    await learnerSees(w, { credited: 4, total: 5, todayCourse: c.E, todayDay: w.days[5] });
    expect((await enrolment(w.enr)).status, "not complete before the last day").toBe("active");
    await passDay(w.req, w.u, slug(), c.E, w.enr, w.days[5]);
    await expectCompleted(w, 5);
  });

  test("(C-rem) the open day removed: its attempt resumes by its link and its completion is a history credit", async ({ browser, baseURL }) => {
    test.setTimeout(600_000);
    const c = s.c!;
    const w = await world(browser, baseURL!, "Rem", [c.A, c.B, c.C, c.D, c.E, null], 3);
    await republish({
      page: w.page,
      programId: w.programId,
      learner: w.u,
      edit: async () => {
        await removeInEditor(w.page, 4);
        await w.page.getByTestId("journey-save").click();
      },
      expected: { ...ZERO, repinned: 1, started_days_kept: 1 },
    });
    const now = await activeDays(w.programId);
    expect(now.some((r) => r.id === w.days[4]), "the removed day has no number").toBe(false);
    expect(idsByNumber(now)[4], "E's day moved up to 4").toBe(w.days[5]);
    await learnerSees(w, { credited: 3, total: 4, todayCourse: c.E, todayDay: w.days[5] });
    await expectResume(w.req, w.u, launchUrl(slug(), c.D, w.enr, w.days[4]), w.open, w.bookmark, "the removed day by its launch link");
    await scormCommit(w.req, w.open, PASSED, true);
    expect((await creditsOf([w.enr])).find((x) => x.attempt_id === w.open)?.day_id, "a credit on the removed day's id").toBe(w.days[4]);
    await learnerSees(w, { credited: 3, total: 4, todayCourse: c.E, todayDay: w.days[5] });
    expect((await enrolment(w.enr)).status, "it counts towards nothing").toBe("active");
    // The remaining day (E, now day 4) completes the enrolment; the history credit is not counted.
    await passDay(w.req, w.u, slug(), c.E, w.enr, w.days[5]);
    await expectCompleted(w, 4);
  });

  test("(C-pub) the only uncredited required day, open, removed: the publish completes the enrolment; the started day still resumes", async ({ browser, baseURL }) => {
    test.setTimeout(600_000);
    const c = s.c!;
    const w = await world(browser, baseURL!, "Pub", [c.A, c.B, c.C], 2);
    const { s2 } = await republish({
      page: w.page,
      programId: w.programId,
      learner: w.u,
      edit: async () => {
        await removeInEditor(w.page, 3);
        await w.page.getByTestId("journey-save").click();
      },
      expected: { ...ZERO, repinned: 1, completed_now: 1, started_days_kept: 1 },
    });
    expect(s2.enrolments.map((e) => [e.status, typeof e.completed_at]), "completed, with completed_at").toEqual([["completed", "string"]]);
    expect(s2.badges.length, "one badge").toBe(1);
    expect(s2.claims.map((x) => x.origin), "one claim, origin publish").toEqual(["publish"]);

    // R13: the started day survives the completing publish.
    await expectResume(w.req, w.u, launchUrl(slug(), c.C, w.enr, w.days[3]), w.open, w.bookmark, "the removed day of a completed journey");
    await scormCommit(w.req, w.open, PASSED, true);
    expect((await creditsOf([w.enr])).find((x) => x.attempt_id === w.open)?.day_id, "a history credit on its own day id").toBe(w.days[3]);
    expect((await badgesOf([w.enr])).length, "still one badge").toBe(1);
    expect((await claimsOf([w.enr])).map((x) => x.origin), "still one claim").toEqual(["publish"]);
    expect((await enrolment(w.enr)).status).toBe("completed");
  });

  test("(C-fail) a failed day moved by the publish keeps its failed result; its launch opens no new official attempt without a grant", async ({ browser, baseURL }) => {
    test.setTimeout(600_000);
    const c = s.c!;
    const areq = s.adminCtx!.request;
    // G: a course of this case only, whose rule requires a pass, set through the course route.
    const g = await scormCourse(areq, slug(), `QA Journey G ${rand(4)}`);
    const rule = await areq.patch(`/api/courses/${g}`, { data: { pass_required: true } });
    expect(rule.ok(), `G pass_required → ${rule.status()}: ${await rule.text()}`).toBeTruthy();
    const { data: gRow, error: ge } = await svc().from("courses").select("pass_required").eq("id", g).single();
    expect(ge, `course G: ${ge?.message}`).toBeNull();
    expect((gRow as { pass_required: boolean | null }).pass_required, "G requires a pass").toBe(true);

    // Day 1 (A) passed; day 2 (G) started, then failed through the SCORM commit route.
    const w = await world(browser, baseURL!, "Fail", [c.A, g, c.C], 1);
    const failedDay = w.days[2];
    const key = ctxKey(w.enr, failedDay);
    await scormCommit(w.req, w.open, FAILED, true);
    const failedRow = await resultRow(w.open);
    expect([failedRow.status, failedRow.success_status, failedRow.completion_status, failedRow.is_revision], "the day's official attempt failed")
      .toEqual(["failed", "failed", "completed", false]);
    const creditedDays = async () => (await creditsOf([w.enr])).map((x) => x.day_id);
    expect(await creditedDays(), "the failed day is not credited (G requires a pass)").toEqual([w.days[1]]);
    const verdict = [{ official_status: "failed", official_attempt_id: w.open, attempt_count: 1 }];
    expect(await contextVerdict(w.u.id, g, key), "the day's context: failed, by that attempt").toEqual(verdict);
    expect(await requestsOn(w.u.id, g), "no attempt request and no grant").toEqual([]);

    // Move up: the failed day goes from 2 to 1 and is still the open day, so
    // its launch reaches the attempt rule (after a move down, C's day would
    // be open first and the failed day's link would only meet the
    // journey_locked redirect).
    await republish({
      page: w.page,
      programId: w.programId,
      learner: w.u,
      edit: async () => {
        await w.page.getByTestId("journey-day-2-up").click();
        await w.page.getByTestId("journey-save").click();
      },
      expected: { ...ZERO, repinned: 1, sent_back: 1 },
    });
    const now = idsByNumber(await activeDays(w.programId));
    expect([now[1], now[2], now[3]], "the failed day moved to 1 by identity").toEqual([failedDay, w.days[1], w.days[3]]);
    expect(await resultRow(w.open), "the failed attempt is unchanged, field by field").toEqual(failedRow);
    expect(await contextVerdict(w.u.id, g, key), "the day's context is still failed, by the same attempt").toEqual(verdict);
    expect(await creditedDays(), "still no credit on the failed day").toEqual([w.days[1]]);

    // (iv) today's mission is the failed day; its launch link opens no new official attempt.
    await learnerSees(w, { credited: 1, total: 3, todayCourse: g, todayDay: failedDay });
    const officialBefore = await officialOnCourse(w.u.id, g);
    expect(officialBefore, "G's one official attempt is the failed one").toEqual([w.open]);
    const before = await attemptsOf(w.u.id);
    const { html, hops } = await followLaunch(w.req, launchUrl(slug(), g, w.enr, failedDay));
    expect(await officialOnCourse(w.u.id, g), `no new official attempt on G (${hops.join(" → ")})`).toEqual(officialBefore);
    const rows = await attemptsOf(w.u.id);
    expect(officialIn(rows, key).map((r) => r.id), "the day's context holds the failed attempt only").toEqual([w.open]);
    const fresh = rows.filter((r) => !before.some((b) => b.id === r.id));
    for (const r of fresh) expect([r.is_revision, r.context_key], "a new row is a revision visit in the day's context").toEqual([true, key]);
    expect(html, "the launch serves a revision visit").toContain('data-testid="practice-badge"');
    expect(await resultRow(w.open), "the failed attempt is still unchanged").toEqual(failedRow);
    expect(await contextVerdict(w.u.id, g, key), "the day's context is still failed, by the same attempt").toEqual(verdict);
    expect(await creditedDays(), "the launch credits nothing").toEqual([w.days[1]]);
    expect(await requestsOn(w.u.id, g), "still no grant").toEqual([]);
    expect((await enrolment(w.enr)).status, "the journey waits on the failed day").toBe("active");
  });
});
