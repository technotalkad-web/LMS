import { randomBytes, randomUUID } from "node:crypto";
import { test, expect } from "../helpers/fixtures";
import { addMember, createAuthUser, createOrg, fixtureAttemptContext, rand, svc, type SeededOrg, type SeededUser } from "../helpers/supabase";

/**
 * ADR 0014 step 17, database-backed (pr-checks `e2e`: the pushed code built
 * and started in the runner, against the STAGING database, on qa-* data the
 * e2e purge removes): 0103's functions and the statements route's rule R-5.
 *
 *   - two parallel consume_grant calls on one grant → one `opened`, one `used`;
 *   - `stale` (a grant decided before the official completed_at → expired,
 *     with the note suffix); `retake_live` (a second grant while the first's
 *     retake is in progress); `stands` (a passed learner's grant without
 *     override_confirmed → expired; with it → opened);
 *   - two parallel record_revision_visit calls → one row;
 *   - the streak case: one `answered` on a revision visit's row (with its own
 *     launch token) → 200, no xapi_statements row, no streak day, no
 *     xp_events row; the same POST on an official row moves the streak (the
 *     control that proves the gate, not a disabled RPC).
 *
 * The 0103 probe FAILS the spec on a database without 0103: the
 * deploy order applies 0103 before PR 1a's code reaches an environment, so a
 * skip would read green on exactly the gap that order closes. It is a real
 * select of revision_visits, never a head/count probe (those report a
 * missing table as present, docs/ARCHITECTURE.md §9). tests/e2e never runs
 * against production.
 */

const AU = "https://qa.e2e/cmi5/au/consume-grant";
const VERB = (v: string) => `http://adlnet.gov/expapi/verbs/${v}`;
const XAPI_HEADERS = { "Content-Type": "application/json", "X-Experience-API-Version": "1.0.3" };
const HOUR = 60 * 60 * 1000;
const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();

type Seeded = { org: SeededOrg; learner: SeededUser; courseId: string; versionId: string };
type Outcome = { outcome: string; attempt_id: string | null; abandoned_ids: string[] | null };

async function requires0103(): Promise<void> {
  const { error } = await svc().from("revision_visits").select("id").limit(1);
  if (error) {
    throw new Error(
      `0103 is not applied on this database (a real select of revision_visits failed: ${error.code ?? ""} ${error.message}). ` +
        "ADR 0014 orders 0103 before PR 1a's code on every environment; apply it in the owner's sitting first."
    );
  }
}

async function seed(name: string): Promise<Seeded> {
  const org = await createOrg({ name: `QA Org consume ${name}` });
  const learner = await createAuthUser({ profile: { first_name: "Grant", last_name: name } });
  await addMember({ organizationId: org.id, userId: learner.id, role: "user" });
  return { org, learner, ...(await addCourse(org, name)) };
}

/** A cmi5 course with one package and one version in `org`. */
async function addCourse(org: SeededOrg, name: string): Promise<{ courseId: string; versionId: string }> {
  const { data: course, error: cErr } = await svc()
    .from("courses")
    .insert({ organization_id: org.id, title: `QA consume_grant ${name}`, slug: `qa-cg-${rand()}`, status: "published" })
    .select("id")
    .single();
  if (cErr || !course) throw new Error(`course insert failed: ${cErr?.message}`);
  const { data: pkg, error: pErr } = await svc()
    .from("course_packages")
    .insert({ course_id: course.id, language: "en", display_name: "English" })
    .select("id")
    .single();
  if (pErr || !pkg) throw new Error(`package insert failed: ${pErr?.message}`);
  const { data: version, error: vErr } = await svc()
    .from("course_versions")
    .insert({
      course_id: course.id,
      version_number: 1,
      manifest_type: "cmi5",
      launch_url: "index.html",
      storage_prefix: `courses/${course.id}/v1/`,
      manifest_data: { raw: { auId: AU } },
      package_id: pkg.id,
    })
    .select("id")
    .single();
  if (vErr || !version) throw new Error(`version insert failed: ${vErr?.message}`);
  return { courseId: course.id, versionId: version.id };
}

async function attempt(s: Seeded, row: Record<string, unknown>): Promise<string> {
  const { data, error } = await svc()
    .from("course_attempts")
    // The context from the row's flags (ADR 0024 step 64): every row here is Individual.
    .insert({ course_version_id: s.versionId, user_id: s.learner.id, organization_id: s.org.id, ...row, ...fixtureAttemptContext(row) })
    .select("id")
    .single();
  if (error || !data) throw new Error(`attempt insert failed: ${error?.message}`);
  return data.id as string;
}

const completed = (ss: "passed" | "failed" | "unknown", completedAt = iso(-HOUR)) => ({
  status: ss === "unknown" ? "completed" : ss,
  completion_status: "completed",
  success_status: ss,
  score: ss === "passed" ? 0.9 : 0.4,
  started_at: iso(-2 * HOUR),
  completed_at: completedAt,
});

async function grant(s: Seeded, row: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await svc()
    .from("attempt_requests")
    .insert({
      organization_id: s.org.id,
      course_id: s.courseId,
      user_id: s.learner.id,
      status: "approved",
      source: "bulk",
      decided_at: iso(0),
      ...row,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`grant insert failed: ${error?.message}`);
  return data.id as string;
}

async function consume(s: Seeded, grantId: string): Promise<Outcome> {
  const { data, error } = await svc().rpc("consume_grant", {
    p_grant_id: grantId,
    p_user_id: s.learner.id,
    p_course_id: s.courseId,
    p_version_id: s.versionId,
    p_org_id: s.org.id,
    p_learning_path_id: null,
    p_journey_enrollment_id: null,
    p_journey_day: null,
  });
  if (error) throw new Error(`consume_grant raised: ${error.code ?? ""} ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as Outcome | null;
  if (!row) throw new Error("consume_grant answered no row");
  return row;
}

async function grantRow(id: string) {
  const { data } = await svc().from("attempt_requests").select("status, used_at, used_attempt_id, decision_note").eq("id", id).single();
  return data as { status: string; used_at: string | null; used_attempt_id: string | null; decision_note: string | null };
}

test.describe.serial("ADR 0014: consume_grant, record_revision_visit and the revision gate (0103)", () => {
  test.beforeAll(async () => {
    await requires0103();
  });

  test("two parallel consume_grant calls on one grant → one opened, one used", async () => {
    const s = await seed("parallel");
    await attempt(s, completed("failed"));
    const g = await grant(s);
    const outcomes = await Promise.all([consume(s, g), consume(s, g)]);
    expect(outcomes.map((o) => o.outcome).sort()).toEqual(["opened", "used"]);
    const opened = outcomes.find((o) => o.outcome === "opened")!;
    const row = await grantRow(g);
    expect(row.used_attempt_id, "the grant is stamped with the retake it opened").toBe(opened.attempt_id);
    expect(row.used_at).not.toBeNull();
    const { data: open } = await svc()
      .from("course_attempts")
      .select("id, is_revision, cmi_data")
      .eq("user_id", s.learner.id)
      .eq("status", "in_progress");
    expect(open, "exactly one in-progress retake, unflagged and unseeded").toEqual([{ id: opened.attempt_id, is_revision: false, cmi_data: {} }]);
  });

  test("stale: a grant decided before the official result's completed_at → expired with the note suffix", async () => {
    const s = await seed("stale");
    await attempt(s, completed("failed", iso(-HOUR)));
    const g = await grant(s, { decided_at: iso(-2 * HOUR), decision_note: "approved" });
    const o = await consume(s, g);
    expect(o.outcome).toBe("stale");
    const row = await grantRow(g);
    expect(row.status).toBe("expired");
    expect(row.used_at).toBeNull();
    expect(row.decision_note ?? "").toContain("expired unused: decided before the learner's current official result of ");
    const { count } = await svc().from("course_attempts").select("id", { count: "exact", head: true }).eq("user_id", s.learner.id).eq("status", "in_progress");
    expect(count, "nothing else written").toBe(0);
  });

  test("retake_live: a second grant while the first grant's retake is in progress", async () => {
    const s = await seed("retake-live");
    await attempt(s, completed("failed"));
    const g1 = await grant(s);
    expect((await consume(s, g1)).outcome).toBe("opened");
    // g1 is used, so the one-open index admits a second approved grant.
    const g2 = await grant(s);
    const o = await consume(s, g2);
    expect(o.outcome).toBe("retake_live");
    const row = await grantRow(g2);
    expect([row.status, row.used_at], "nothing written: g2 still approved and unused").toEqual(["approved", null]);
  });

  test("stands: a passed learner's grant without override_confirmed → expired; with it → opened", async () => {
    const s = await seed("stands");
    await attempt(s, completed("passed"));
    const plain = await grant(s, { override_confirmed: false });
    expect((await consume(s, plain)).outcome).toBe("stands");
    const row = await grantRow(plain);
    expect(row.status).toBe("expired");
    expect(row.decision_note ?? "").toContain("stands and this grant carries no post-pass confirmation");
    const confirmed = await grant(s, { override_confirmed: true });
    const o = await consume(s, confirmed);
    expect(o.outcome).toBe("opened");
    expect(o.abandoned_ids ?? []).toEqual([]);
  });

  test("two parallel record_revision_visit calls → one row", async () => {
    const s = await seed("visits");
    const official = await attempt(s, completed("passed"));
    const rev = await attempt(s, { status: "in_progress", completion_status: "in_progress", success_status: "unknown", is_revision: true });
    const call = () =>
      svc().rpc("record_revision_visit", {
        p_org: s.org.id,
        p_user: s.learner.id,
        p_course: s.courseId,
        p_version: s.versionId,
        p_attempt: rev,
        p_kind: "cmi5",
      });
    const [a, b] = await Promise.all([call(), call()]);
    expect([a.error, b.error]).toEqual([null, null]);
    expect([a.data, b.data].sort()).toEqual([false, true]);
    const { data: rows } = await svc().from("revision_visits").select("attempt_id, launch_kind").eq("user_id", s.learner.id).eq("course_id", s.courseId);
    expect(rows).toEqual([{ attempt_id: rev, launch_kind: "cmi5" }]);
    expect(official).not.toBe(rev);
  });

  test("the streak case: a revision visit's answered records nothing and moves no streak; an official row's does", async ({ request }) => {
    const s = await seed("streak");
    await attempt(s, completed("passed"));
    const rev = await attempt(s, { status: "in_progress", completion_status: "in_progress", success_status: "unknown", is_revision: true });
    const token = randomBytes(32).toString("hex");
    const { error: tokErr } = await svc().from("cmi5_launch_tokens").insert({ auth_token: token, attempt_id: rev });
    expect(tokErr).toBeNull();
    const gamification = async () =>
      (await svc().from("user_gamification").select("current_streak_days, last_active_day").eq("organization_id", s.org.id).eq("user_id", s.learner.id).maybeSingle()).data;
    const xp = async () => (await svc().from("xp_events").select("id", { count: "exact", head: true }).eq("user_id", s.learner.id)).count ?? 0;
    const before = await gamification();
    const xpBefore = await xp();

    const statementId = randomUUID();
    const res = await request.post("/api/xapi/statements", {
      headers: { ...XAPI_HEADERS, Authorization: `Bearer ${token}` },
      data: {
        id: statementId,
        actor: { objectType: "Agent", account: { homePage: "https://qa.e2e", name: s.learner.id } },
        verb: { id: VERB("answered") },
        object: { objectType: "Activity", id: `${AU}/q1` },
        result: { success: true, response: "a" },
        context: { registration: rev },
      },
    });
    const body = await res.text();
    expect(
      res.status(),
      `statements POST → ${res.status()} ${body.slice(0, 200)} (on the Workers staging free plan a Cloudflare 1102 is staging noise, not this rule: re-run)`
    ).toBe(200);
    expect(JSON.parse(body)).toEqual([statementId]);
    const { count: stored } = await svc().from("xapi_statements").select("statement_id", { count: "exact", head: true }).eq("attempt_id", rev);
    expect(stored, "no xapi_statements row for the revision's answered").toBe(0);
    expect(await gamification(), "current_streak_days and last_active_day unchanged").toEqual(before);
    expect(await xp(), "no xp_events row").toBe(xpBefore);

    // Control: the same learner's official in-progress row on another course
    // of the org does move the streak, so the gate (not a disabled RPC) held.
    const controlCourse = { ...s, ...(await addCourse(s.org, "streak-control")) };
    const official = await attempt(controlCourse, { status: "in_progress", completion_status: "in_progress", success_status: "unknown" });
    const controlToken = randomBytes(32).toString("hex");
    await svc().from("cmi5_launch_tokens").insert({ auth_token: controlToken, attempt_id: official });
    const control = await request.post("/api/xapi/statements", {
      headers: { ...XAPI_HEADERS, Authorization: `Bearer ${controlToken}` },
      data: {
        actor: { objectType: "Agent", account: { homePage: "https://qa.e2e", name: s.learner.id } },
        verb: { id: VERB("initialized") },
        object: { objectType: "Activity", id: AU },
        context: { registration: official },
      },
    });
    expect(control.status(), `control POST → ${control.status()} (a 1102 here is staging noise: re-run)`).toBe(200);
    const after = await gamification();
    expect(after?.last_active_day ?? null, "the official row's statement moved the streak").not.toBeNull();
  });
});
