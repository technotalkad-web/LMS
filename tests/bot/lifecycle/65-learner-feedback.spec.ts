/**
 * ADR 0021 G.2 — the Learner Feedback section on a course's Reports page and
 * its CSV: administrators only; staff previews, revision visits and reset
 * attempts excluded; a learner's newest answer counted.
 *
 * Fixture: organisation A with an admin, a data analyst, a manager (a `user`
 * member named as learner 2's line manager, the spec 34 form) and two
 * learners; organisation B with its own admin; a cmi5 upload in each
 * (cmi5.zip). Attempt rows are inserted with the service role (spec 58's
 * form), each with its status named, never two in progress for one
 * (user_id, course_version_id) (0062):
 *   learner 1 official   completed     flags false   s1 likert_3, s2 star_4, s3 yes,
 *                                                     s4 and s5 comments, s6 left blank
 *   learner 1 retake     in_progress   flags false   s1 again, likert_1, later
 *   learner 2 reset      abandoned     flags false   EXCLUDED-RESET
 *   learner 2 revision   in_progress   is_revision   EXCLUDED-REVISION
 *   admin preview        in_progress   is_preview    EXCLUDED-PREVIEW
 * Statements are in the released A.1 engine's responded shapes (ADR 0021
 * Context), each with an explicit `stored`.
 *
 *   (a) admin: the Reports page shows the section, s1's question, "Average
 *       rating" 4.0, s1's five likert positions in scale order with
 *       likert_1 counted once and likert_3 zero, "Yes" 1, "No answer" 1, two
 *       comments, the markup escaped, nothing EXCLUDED-;
 *   (b) admin: the CSV (header, 7 rows, the formula guard, Counted no/yes,
 *       nothing EXCLUDED-), blank dates, the date-only `to` inclusive, a
 *       `from` after every row, an invalid date (400), and the audit rows;
 *   (c) data analyst, (d) manager, (e) learner 1: the page redirects to the
 *       dashboard with no section, the CSV answers 403;
 *   (f) admin of B: A's course → 404, B's own course → the header only;
 *   (g) the organisation Reports page as the analyst: no section.
 *
 * Needs 0106 on the target database: the probe FAILS the spec without it.
 * By hand on staging after the code is deployed, never while another
 * lifecycle run is in progress (ADR 0021 H.3); after one green run it joins
 * DEFAULT_SPECS in scripts/lifecycle-nightly.sh (F.5). Data stays in the
 * lifecycle-* namespace.
 */
import { test, expect, type BrowserContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { addMember, createAuthUser, createOrg, svc } from "./data";
import { authedContext, uploadCourse } from "./helpers";
import { fixtureAttemptContext, getNoFollow } from "./p0-helpers";
import { auActivityId } from "../../../lib/alds/types";

type User = { id: string; email: string; password: string };

const RESPONDED = "http://adlnet.gov/expapi/verbs/responded";
const UNANSWERED = "https://ambak.com/xapi/ext/question/unanswered";
const RAW = "https://e-learning-engine/extensions/raw-response";
const LIKERT_NA = ["Not Applicable", "Strongly Disagree", "Disagree", "Agree", "Strongly Agree"];
const S1_QUESTION = "The module was paced well";
const COMMENT_FORMULA = "=SUM(1)+1 clear and well paced";
const COMMENT_MARKUP = "<b>bold</b> & more";
const CSV_HEADER = [
  "Responded at (ISO)", "Stored at (ISO)", "Employee ID", "Email", "First name", "Last name", "Question", "Question id",
  "Type", "Response", "Response label", "Counted", "Version id", "Slot language", "Attempt id", "Statement id",
];

const lang = (s: string) => ({ "en-US": s });

/** One responded statement in the A.1 shape: object.id = {AU}/{slide}, no success, no key. */
function responded(
  au: string,
  attemptId: string,
  slide: string,
  kind: "likert-na" | "stars" | "yes-no" | "free-text",
  value: string | null,
  question: string,
  stored: Date
) {
  const definition: Record<string, unknown> = {
    type: "http://adlnet.gov/expapi/activities/cmi.interaction",
    name: lang(`Feedback ${slide}`),
    description: lang(question),
  };
  let response: string | undefined;
  if (kind === "likert-na") {
    definition.interactionType = "likert";
    definition.scale = LIKERT_NA.map((d, i) => ({ id: `likert_${i}`, description: lang(d) }));
    response = value === null ? undefined : `likert_${value}`;
  } else if (kind === "stars") {
    definition.interactionType = "likert";
    definition.scale = [1, 2, 3, 4, 5].map((n) => ({ id: `star_${n}`, description: lang(String(n)) }));
    response = value === null ? undefined : `star_${value}`;
  } else if (kind === "yes-no") {
    definition.interactionType = "choice";
    definition.choices = [
      { id: "yes", description: lang("Yes") },
      { id: "no", description: lang("No") },
    ];
    response = value === null ? undefined : value;
  } else {
    definition.interactionType = "long-fill-in";
    response = value === null ? undefined : value;
  }
  const id = randomUUID();
  const raw = {
    id,
    actor: { objectType: "Agent", account: { homePage: "https://lifecycle.test", name: attemptId } },
    verb: { id: RESPONDED, display: { "en-US": "responded" } },
    object: { id: `${au}/${slide}`, definition },
    result:
      response === undefined
        ? { extensions: { [UNANSWERED]: true } }
        : { response, extensions: { [RAW]: value } },
    timestamp: stored.toISOString(),
    context: { registration: attemptId },
  };
  return { attempt_id: attemptId, statement_id: id, verb: RESPONDED, stored: stored.toISOString(), raw };
}

async function requires0106(): Promise<void> {
  const { error } = await svc().from("v_course_feedback_responses").select("statement_row_id").limit(1);
  if (error) throw new Error(`0106 is not applied on this database (a real select of v_course_feedback_responses failed: ${error.code ?? ""} ${error.message})`);
}

function csvRows(text: string): string[][] {
  const body = text.replace(/^﻿/, "");
  const out: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (q) {
      if (ch === '"' && body[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cur); cur = ""; }
    else if (ch === "\r" && body[i + 1] === "\n") { row.push(cur); out.push(row); row = []; cur = ""; i++; }
    else cur += ch;
  }
  if (cur !== "" || row.length) { row.push(cur); out.push(row); }
  return out;
}

/** The HTML of one question card, found by its interaction id. */
function questionCard(html: string, interactionId: string): string {
  const cards = html.split('data-testid="feedback-question"').slice(1);
  const card = cards.find((c) => c.includes(`${interactionId}</code>`));
  expect(card, `a feedback-question card for ${interactionId}`).toBeTruthy();
  return card!;
}

const buckets = (card: string) =>
  [...card.matchAll(/data-bucket="([^"]+)" data-count="(\d+)"[^>]*><td[^>]*>([^<]*)</g)].map((m) => [m[1], Number(m[2]), m[3]]);

test.describe.serial("ADR 0021 — Learner Feedback section and CSV", () => {
  const s: {
    orgA?: { id: string; slug: string };
    orgB?: { id: string; slug: string };
    admin?: User;
    adminB?: User;
    analyst?: User;
    manager?: User;
    l1?: User;
    l2?: User;
    courseA?: string;
    versionA?: string;
    courseB?: string;
    au?: string;
    lastDay?: string;
    nextDay?: string;
    ctx: Record<string, BrowserContext>;
  } = { ctx: {} };

  test.afterAll(async () => {
    for (const c of Object.values(s.ctx)) await c.close().catch(() => {});
  });

  test("seed: two organisations, five roles, attempts and responded statements", async ({ browser, baseURL }) => {
    await requires0106();
    const orgA = await createOrg({ name: "QA Learner Feedback" });
    const orgB = await createOrg({ name: "QA Learner Feedback Other" });
    s.orgA = orgA;
    s.orgB = orgB;
    const mk = async (orgId: string, first: string, role: "admin" | "data_analyst" | "user") => {
      const u = await createAuthUser({ profile: { first_name: first, last_name: "Feedback", must_change_password: false } });
      await addMember({ organizationId: orgId, userId: u.id, role });
      return u as User;
    };
    s.admin = await mk(orgA.id, "Admin", "admin");
    s.analyst = await mk(orgA.id, "Analyst", "data_analyst");
    s.manager = await mk(orgA.id, "Manager", "user");
    s.l1 = await mk(orgA.id, "Learner1", "user");
    s.l2 = await mk(orgA.id, "Learner2", "user");
    s.adminB = await mk(orgB.id, "AdminB", "admin");
    // The manager is a `user` member named as learner 2's line manager (spec 34's form).
    const { error: lmErr } = await svc()
      .from("organization_members")
      .update({ line_manager_id: s.manager.id })
      .eq("organization_id", orgA.id)
      .eq("user_id", s.l2.id);
    expect(lmErr, lmErr?.message).toBeNull();

    for (const [key, u] of Object.entries({ admin: s.admin, analyst: s.analyst, manager: s.manager, l1: s.l1, adminB: s.adminB })) {
      s.ctx[key] = await authedContext(browser, baseURL!, u.email, u.password);
    }
    const course = await uploadCourse(s.ctx.admin.request, orgA.slug, "cmi5.zip");
    s.courseA = course.courseId;
    s.versionA = course.versionId;
    s.courseB = (await uploadCourse(s.ctx.adminB.request, orgB.slug, "cmi5.zip")).courseId;
    const { data: ver, error: vErr } = await svc().from("course_versions").select("package_id").eq("id", s.versionA).single();
    expect(vErr).toBeNull();
    s.au = auActivityId((ver as { package_id: string }).package_id);

    const now = Date.now();
    const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000);
    const attempt = async (user: User, status: string, flags: { is_revision?: boolean; is_preview?: boolean }, startedMinutesAgo: number, completed: boolean) => {
      const { data, error } = await svc()
        .from("course_attempts")
        .insert({
          course_version_id: s.versionA,
          user_id: user.id,
          organization_id: orgA.id,
          status,
          completion_status: completed ? "completed" : "in_progress",
          success_status: "unknown",
          started_at: at(startedMinutesAgo).toISOString(),
          completed_at: completed ? at(startedMinutesAgo - 20).toISOString() : null,
          cmi_data: {},
          is_revision: flags.is_revision ?? false,
          is_preview: flags.is_preview ?? false,
          // The context from the same flags; a preview is the by-role kind, legacy_role (ADR 0024 step 64).
          ...fixtureAttemptContext(flags),
        })
        .select("id")
        .single();
      expect(error, error?.message).toBeNull();
      return (data as { id: string }).id;
    };
    const official = await attempt(s.l1, "completed", {}, 180, true);
    const retake = await attempt(s.l1, "in_progress", {}, 60, false);
    const reset = await attempt(s.l2, "abandoned", {}, 170, false);
    const revision = await attempt(s.l2, "in_progress", { is_revision: true }, 50, false);
    const preview = await attempt(s.admin, "in_progress", { is_preview: true }, 40, false);

    const au = s.au;
    const rows = [
      responded(au, official, "s1", "likert-na", "3", S1_QUESTION, at(150)),
      responded(au, official, "s2", "stars", "4", "How would you rate this module?", at(149)),
      responded(au, official, "s3", "yes-no", "yes", "Would you recommend it?", at(148)),
      responded(au, official, "s4", "free-text", COMMENT_FORMULA, "What worked well?", at(147)),
      responded(au, official, "s5", "free-text", COMMENT_MARKUP, "What could be better?", at(146)),
      responded(au, official, "s6", "likert-na", null, "The examples were relevant", at(145)),
      responded(au, retake, "s1", "likert-na", "1", S1_QUESTION, at(30)),
      responded(au, revision, "s4", "free-text", "EXCLUDED-REVISION", "What worked well?", at(20)),
      responded(au, preview, "s4", "free-text", "EXCLUDED-PREVIEW", "What worked well?", at(15)),
      responded(au, reset, "s4", "free-text", "EXCLUDED-RESET", "What worked well?", at(10)),
    ];
    const { error: sErr } = await svc().from("xapi_statements").insert(rows);
    expect(sErr, sErr?.message).toBeNull();
    // The CSV's date cases: the UTC day of the newest eligible row, and the day after it.
    s.lastDay = at(30).toISOString().slice(0, 10);
    s.nextDay = new Date(Date.parse(`${s.lastDay}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

    // The view keeps the seven eligible rows (six official, one retake).
    const { data: viewRows, error: viewErr } = await svc()
      .from("v_course_feedback_responses")
      .select("attempt_id, response, is_latest")
      .eq("course_id", s.courseA);
    expect(viewErr, viewErr?.message).toBeNull();
    expect((viewRows ?? []).length, "eligible rows in the view").toBe(7);
  });

  test("(a) admin: the section, the figures, the comments, escaped, nothing excluded", async () => {
    const res = await s.ctx.admin.request.get(`/${s.orgA!.slug}/library/${s.courseA}/reports`);
    expect(res.status()).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-testid="feedback-section"');
    expect(html).toContain(S1_QUESTION);
    expect(html).not.toContain("EXCLUDED-");

    // s2 stars: the average of the one counted rating
    const stars = questionCard(html, `${s.au}/s2`);
    expect(stars).toContain("Average rating");
    expect(stars).toMatch(/data-testid="feedback-average"[^>]*>4\.0</);

    // s1: the five positions in scale order; the retake's likert_1 counts, the official likert_3 does not
    expect(buckets(questionCard(html, `${s.au}/s1`))).toEqual([
      ["likert_0", 0, LIKERT_NA[0]],
      ["likert_1", 1, LIKERT_NA[1]],
      ["likert_2", 0, LIKERT_NA[2]],
      ["likert_3", 0, LIKERT_NA[3]],
      ["likert_4", 0, LIKERT_NA[4]],
    ]);
    // s3: Yes 1, No 0
    expect(buckets(questionCard(html, `${s.au}/s3`))).toEqual([
      ["yes", 1, "Yes"],
      ["no", 0, "No"],
    ]);
    // s6: No answer 1
    expect(buckets(questionCard(html, `${s.au}/s6`))).toContainEqual(["none", 1, "No answer"]);

    // two comments, the markup escaped
    expect(html.split('data-testid="feedback-comment"').length - 1).toBe(2);
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(html).not.toContain("<b>bold");
    expect(html).toContain('data-testid="feedback-csv"');
  });

  test("(b) admin: the CSV, its date cases and the audit rows", async () => {
    const base = `/api/courses/${s.courseA}/feedback/export?orgSlug=${s.orgA!.slug}`;
    const auditRows = async () => {
      const { data, error } = await svc()
        .from("platform_audit_log")
        .select("actor_user_id, action, target_type, target_id, metadata")
        .eq("action", "course.feedback.exported")
        .eq("target_id", s.courseA!)
        .eq("actor_user_id", s.admin!.id);
      expect(error, error?.message).toBeNull();
      return (data ?? []) as Array<{ target_type: string; metadata: { organizationId: string; rows: number; from: string | null; to: string | null } }>;
    };

    const res = await s.ctx.admin.request.get(base);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/csv");
    expect(res.headers()["content-disposition"]).toMatch(/^attachment; filename="feedback_/);
    const text = await res.text();
    const rows = csvRows(text);
    expect(rows[0]).toEqual(CSV_HEADER);
    expect(rows.length - 1, "data rows").toBe(7);
    expect(text).not.toContain("EXCLUDED-");
    const col = (name: string) => CSV_HEADER.indexOf(name);
    const formula = rows.find((r) => r[col("Question id")] === `${s.au}/s4`);
    expect(formula?.[col("Response")]).toBe(`'${COMMENT_FORMULA}`);
    const s1 = rows.filter((r) => r[col("Question id")] === `${s.au}/s1`).map((r) => [r[col("Response")], r[col("Response label")], r[col("Counted")]]);
    expect(s1).toEqual([
      ["likert_3", "Agree", "no"],
      ["likert_1", "Strongly Disagree", "yes"],
    ]);
    const blank = rows.find((r) => r[col("Question id")] === `${s.au}/s6`);
    expect([blank?.[col("Response")], blank?.[col("Response label")]]).toEqual(["", "No answer"]);
    expect(rows.slice(1).every((r) => r[col("Email")] !== "" && r[col("Version id")] === s.versionA)).toBe(true);

    // the audit row of this first file
    const first = await auditRows();
    expect(first.length).toBe(1);
    expect(first[0].target_type).toBe("course");
    expect(first[0].metadata).toEqual({ organizationId: s.orgA!.id, rows: 7, from: null, to: null });

    // blank date inputs are absent
    const blankDates = await s.ctx.admin.request.get(`${base}&from=&to=`);
    expect(blankDates.status()).toBe(200);
    expect(csvRows(await blankDates.text()).length - 1).toBe(7);
    // a date-only `to` is inclusive: the newest row's own day keeps every row
    const toDay = await s.ctx.admin.request.get(`${base}&to=${s.lastDay}`);
    expect(toDay.status()).toBe(200);
    expect(csvRows(await toDay.text()).length - 1).toBe(7);
    // a `from` after every row: the header only
    const after = await s.ctx.admin.request.get(`${base}&from=${s.nextDay}`);
    expect(after.status()).toBe(200);
    expect(csvRows(await after.text())).toEqual([CSV_HEADER]);
    // an invalid date: 400, no file, no audit row
    const bad = await s.ctx.admin.request.get(`${base}&from=not-a-date`);
    expect(bad.status()).toBe(400);

    const audit = (await auditRows()).map((r) => r.metadata);
    expect(audit.length, "one audit row per 200 answer, none for the 400").toBe(4);
    expect(audit.map((m) => m.rows).sort()).toEqual([0, 7, 7, 7]);
    expect(audit).toContainEqual({ organizationId: s.orgA!.id, rows: 7, from: null, to: s.lastDay });
    expect(audit).toContainEqual({ organizationId: s.orgA!.id, rows: 0, from: s.nextDay, to: null });
  });

  for (const [label, key] of [["(c) data analyst", "analyst"], ["(d) manager", "manager"], ["(e) learner 1", "l1"]] as const) {
    test(`${label}: no section, the CSV answers 403`, async () => {
      const r = await getNoFollow(s.ctx[key].request, `/${s.orgA!.slug}/library/${s.courseA}/reports`);
      expect(r.redirectedTo(`/${s.orgA!.slug}/dashboard?denied=1`), `redirect (status ${r.status})`).toBe(true);
      expect(r.body).not.toContain("feedback-section");
      const csv = await s.ctx[key].request.get(`/api/courses/${s.courseA}/feedback/export?orgSlug=${s.orgA!.slug}`);
      expect(csv.status()).toBe(403);
      expect(await csv.json()).toEqual({ error: "Forbidden" });
    });
  }

  test("(f) admin of B: A's course is not found; B's own course answers the header only", async () => {
    const cross = await s.ctx.adminB.request.get(`/api/courses/${s.courseA}/feedback/export?orgSlug=${s.orgB!.slug}`);
    expect(cross.status()).toBe(404);
    expect(await cross.json()).toEqual({ error: "Course not found" });
    const own = await s.ctx.adminB.request.get(`/api/courses/${s.courseB}/feedback/export?orgSlug=${s.orgB!.slug}`);
    expect(own.status()).toBe(200);
    expect(own.headers()["content-type"]).toContain("text/csv");
    expect(csvRows(await own.text())).toEqual([CSV_HEADER]);
    const { data } = await svc()
      .from("platform_audit_log")
      .select("target_id, metadata")
      .eq("action", "course.feedback.exported")
      .eq("actor_user_id", s.adminB!.id);
    expect((data ?? []).map((r) => [r.target_id, (r.metadata as { rows: number }).rows])).toEqual([[s.courseB, 0]]);
  });

  test("(g) the organisation Reports page as the analyst: no Learner feedback", async () => {
    const res = await s.ctx.analyst.request.get(`/${s.orgA!.slug}/reports`);
    expect(res.status()).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("feedback-section");
    expect(html).not.toContain("Learner feedback");
  });
});
