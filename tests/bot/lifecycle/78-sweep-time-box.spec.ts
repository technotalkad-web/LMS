/**
 * ADR 0024 step 16, the note of 2026-11-16 (step S6): the gate of the
 * completion sweep's time box (migration 0112) and of its own calls (the
 * cron routes' drain, lib/ops/completion-sweep.ts), on staging.
 *
 * The defect it gates (measured on staging, 2026-11-16): with about 150
 * candidates waiting, refresh_report_views() ran its 0107 sweep inside the
 * statement until the role's timeout cancelled it (57014), the cancel rolled
 * back every row the sweep had handled, and the backlog could never drain
 * through PostgREST. This spec builds its own standing queue for each call,
 * so it never passes on an empty queue.
 *
 *   Part A, by RPC with the service role through PostgREST (spec 64's path,
 *   and the statement production's routes send): refresh_report_views(),
 *   then refresh_gamification_views(). Each: no error, every view entry's
 *   error null, the last entry's error null with sweep.stopped 'time' (its
 *   1.5 s box ran out with rows left), the call under 6 s, and the global
 *   backlog lower than before and above 0. On 0107's bodies part A cannot
 *   pass, by construction: their sweep answer has no `stopped` key.
 *   Part B, the two cron routes on the app under test with that app's own
 *   cron secret: gamification-refresh, then refresh-report-views. Each: 200,
 *   ok true, every view entry's error null, completion_sweep_drain.handled
 *   above 0, and the backlog lower than before.
 *
 * The queue is global and oldest first, so every assertion reads the global
 * queue through completion_sweep_backlog() (0112), in a request of its own
 * before and after each call; a call that was cancelled and rolled back
 * leaves the number as it was. The seed is laid before each call that needs
 * it, never once for all four: batch 1 (BATCH_1 rows) before part A, sized
 * so that the queue exceeds what part A's two boxed sweeps handle together;
 * batch 2 (30 rows) before the gamification route; batch 3 (30 rows) before
 * the report route. Each seeded row is a completed attempt in the
 * Individual context, dated ten minutes back (older than the sweep's
 * two-minute rule, and in its natural place at the tail of the queue, so
 * what the spec leaves behind never stands in front of a real row), and the
 * official attempt of its own (learner, course) pair, so the writer runs its
 * whole completion branch for it (points, the completion claim, the stamp)
 * as it does for a real completion. The rows are inserted by the service
 * role and name context_kind through fixtureAttemptContext (steps 23 and 64);
 * the insert triggers of course_attempts were read against this seed: the
 * derive trigger of 0107's paste window fires only when context_kind is
 * absent, the owner trigger only on a journey tag, and the immutability
 * trigger only on update. The courses, packages and versions are inserted
 * directly (spec 46's form): the insert triggers there assign the reference
 * code (0079), reset the analytics tier of a new version (0100) and count the
 * organisation's courses against its plan (0038; see LEARNERS).
 *
 * 'busy' (the staging job of the note's D-S3 holding the sweep's key at that
 * second): a part A call whose sweep answers 'busy' is made once more after
 * 6 s, with the backlog read again; in part B, when a route answers
 * completion_sweep_drain.stopped 'busy' with handled 0, the spec waits 6 s,
 * lays a fresh batch of 30, reads the backlog again and POSTs that route
 * once more; the assertions are made on the second answer, and a second
 * 'busy' fails the spec.
 *
 * The organisation is made by createOrg() of ./data, a lifecycle-* slug,
 * never qa-*: the e2e purge deletes qa-* organisations on every push and
 * pull request, and the seeded attempts would go with it by cascade, so the
 * backlog would fall without the sweep handling a row. The spec makes no
 * direct call of either sweep function and no call that only tidies the
 * queue; what it leaves unhandled stays in the queue of its own lifecycle
 * organisation until a sweep takes it or the 48-hour cleanup removes it.
 *
 * WHEN: by hand on staging, after 0112's paste (S3), against an app that
 * carries the drain: the app scripts/lifecycle-nightly.sh builds from the
 * branch (LIFECYCLE_SPECS=78; no deploy needed), or Cloud Run after the
 * owner's deploy. Never while another lifecycle run is in progress. It is in
 * neither DEFAULT_SPECS nor PRODUCT_SPECS: by step 64 and the note's S6 it
 * joins PRODUCT_SPECS after one green hand run (with a check beside those of
 * specs 68 and 69 in tests/unit/lifecycle-nightly-lists.test.ts), and BATCH_1
 * is set from that run's measured counts. Spec 64 is not changed, and no
 * drain is added to any spec or to the nightly script: a drain there would
 * hide this defect.
 *
 * Env (part B; a missing secret fails the spec, it is never a skip):
 *   LIFECYCLE_CRON_SECRET       set by scripts/lifecycle-nightly.sh for the
 *                               app it starts (a fresh random value per run)
 *   KIVO_CLOUD_RUN_CRON_SECRET  a hand run on Cloud Run: that deployment's
 *                               CRON_SECRET, as spec 56 reads it
 * Neither is CRON_SECRET: the lifecycle config loads the env files with
 * override: true, so a CRON_SECRET of theirs would replace the shell's. The
 * routes are POSTed with plain fetch (as spec 56 does), never on a Workers
 * host, and the secret never reaches a log or an annotation.
 */
import { test, expect } from "@playwright/test";
import { addMember, createAuthUser, createOrg, rand, svc } from "./data";
import { fixtureAttemptContext } from "./p0-helpers";

/** Batch 1, before part A. Start: 150 (the note's S6); reset from the hand run's measured counts. */
const BATCH_1 = 150;
/** Batches 2 and 3, before each route. */
const BATCH_ROUTE = 30;
/**
 * Learners of the seed; each course gives one official row per learner. 30,
 * so a run makes few courses: the organisation has no subscription, so the
 * basic plan's caps apply (0021, enforced at insert by 0038: 25 courses and
 * 100 members); batch 1 makes 5 courses, each route batch 1, a 'busy' retry
 * 1 more, at most 9 in all, and BATCH_1 can grow to 600 rows within the cap.
 */
const LEARNERS = 30;
const CRON_SECRET = process.env.LIFECYCLE_CRON_SECRET || process.env.KIVO_CLOUD_RUN_CRON_SECRET || "";

type Entry = { view?: string; ms?: number; rows?: number | null; error?: string | null; sweep?: Record<string, unknown> | null };
type Drain = { calls: number; candidates: number; handled: number; failed: number; stalled: number; stopped: string; ms: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

/** The global queue, by the sweep's own predicate (0112's completion_sweep_backlog), in a request of its own. */
async function backlog(): Promise<number> {
  const { data, error } = await svc().rpc("completion_sweep_backlog");
  expect(error, `completion_sweep_backlog: ${error?.code ?? ""} ${error?.message ?? ""} (is 0112 applied?)`).toBeNull();
  const n = Number((data as { candidates?: unknown } | null)?.candidates);
  expect(Number.isInteger(n), `completion_sweep_backlog answered ${JSON.stringify(data)}`).toBe(true);
  return n;
}

test.describe.serial("ADR 0024 step 16 (note of 2026-11-16): the completion sweep's time box and its own calls (0112)", () => {
  const s: { orgId?: string; learners: string[]; courses: number; seeded: number } = { learners: [], courses: 0, seeded: 0 };

  /** A course of the organisation with one SCORM 1.2 version (spec 46's direct form); its version id. */
  async function newCourse(): Promise<string> {
    s.courses++;
    const db = svc();
    const { data: course, error: cErr } = await db
      .from("courses")
      .insert({ organization_id: s.orgId, title: `Sweep time box C${s.courses}`, slug: `sweep-box-c${s.courses}-${rand()}`, status: "published" })
      .select("id")
      .single();
    expect(cErr, `course insert: ${cErr?.message}`).toBeNull();
    const courseId = (course as { id: string }).id;
    const { data: pkg, error: pErr } = await db.from("course_packages").insert({ course_id: courseId, language: "en", display_name: "English" }).select("id").single();
    expect(pErr, `package insert: ${pErr?.message}`).toBeNull();
    const { data: version, error: vErr } = await db
      .from("course_versions")
      .insert({
        course_id: courseId,
        version_number: 1,
        manifest_type: "scorm12",
        launch_url: "index.html",
        storage_prefix: `courses/${courseId}/v1/`,
        manifest_data: { title: `Sweep time box C${s.courses}` },
        package_id: (pkg as { id: string }).id,
      })
      .select("id")
      .single();
    expect(vErr, `version insert: ${vErr?.message}`).toBeNull();
    const versionId = (version as { id: string }).id;
    const { error: uErr } = await db.from("courses").update({ current_version_id: versionId }).eq("id", courseId);
    expect(uErr, `course current version: ${uErr?.message}`).toBeNull();
    return versionId;
  }

  /**
   * `size` completed Individual attempts dated ten minutes back, each the
   * official attempt of its own (learner, course) pair: new courses for every
   * batch, LEARNERS rows per course.
   */
  async function seedBatch(size: number): Promise<void> {
    const completedAt = minutesAgo(10);
    const startedAt = minutesAgo(20);
    let left = size;
    while (left > 0) {
      const versionId = await newCourse();
      const rows: Array<Record<string, unknown>> = [];
      for (const userId of s.learners.slice(0, Math.min(LEARNERS, left))) {
        rows.push({
          course_version_id: versionId,
          user_id: userId,
          organization_id: s.orgId,
          status: "completed",
          completion_status: "completed",
          success_status: "unknown",
          score: null,
          started_at: startedAt,
          completed_at: completedAt,
          cmi_data: {},
          ...fixtureAttemptContext(),
        });
      }
      const { error } = await svc().from("course_attempts").insert(rows);
      expect(error, `attempt seed: ${error?.message}`).toBeNull();
      left -= rows.length;
      s.seeded += rows.length;
    }
  }

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    // 0112 first: without it nothing below can be read (a fail, never a skip)
    await backlog();
    const org = await createOrg({ name: "Lifecycle Sweep Time Box" });
    s.orgId = org.id;
    for (let n = 1; n <= LEARNERS; n++) {
      const user = await createAuthUser({ profile: { first_name: "Sweep", last_name: `L${n}`, must_change_password: false } });
      await addMember({ organizationId: org.id, userId: user.id, role: "user" });
      s.learners.push(user.id);
    }
  });

  test("A: each refresh function's sweep stops on its 1.5 s box and keeps what it handled", async () => {
    test.setTimeout(600_000);
    await seedBatch(BATCH_1);
    const record: Array<Record<string, unknown>> = [];
    for (const fn of ["refresh_report_views", "refresh_gamification_views"] as const) {
      const call = async () => {
        const t0 = Date.now();
        const { data, error } = await svc().rpc(fn);
        return { data, error, ms: Date.now() - t0 };
      };
      let before = await backlog();
      let r = await call();
      let entries = (Array.isArray(r.data) ? r.data : []) as Entry[];
      let busy = false;
      if (entries[entries.length - 1]?.sweep?.stopped === "busy") {
        // the staging job (D-S3) held the key at that second: once more after 6 s
        busy = true;
        await sleep(6_000);
        before = await backlog();
        r = await call();
        entries = (Array.isArray(r.data) ? r.data : []) as Entry[];
      }
      const after = await backlog();
      const last = entries[entries.length - 1];
      const sweep = (last?.sweep ?? null) as { stopped?: string; handled?: number; failed?: number; ms?: number } | null;
      record.push({ fn, before, after, rpcMs: r.ms, handled: sweep?.handled ?? null, failed: sweep?.failed ?? null, sweepMs: sweep?.ms ?? null, stopped: sweep?.stopped ?? null, retriedAfterBusy: busy });
      expect(r.error, `${fn}: ${r.error?.code ?? ""} ${r.error?.message ?? ""}`).toBeNull();
      expect(entries.length, `${fn}: an array of entries`).toBeGreaterThan(1);
      expect(entries.slice(0, -1).filter((e) => e.error !== null).map((e) => e.view), `${fn}: every view entry's error null`).toEqual([]);
      expect(last?.view, `${fn}: the completion sweep's entry is last`).toBe("completion_sweep");
      expect(last?.error ?? null, `${fn}: the sweep's own error`).toBeNull();
      expect(sweep?.stopped, `${fn}: sweep.stopped (0107's bodies have no stopped key; 'time' means the 1.5 s box ran out with rows left)`).toBe("time");
      expect(r.ms, `${fn}: the call under 6 s`).toBeLessThan(6_000);
      expect(after, `${fn}: the backlog lower than before (${before})`).toBeLessThan(before);
      expect(after, `${fn}: the backlog above 0 (a queue one call can finish proves nothing; raise BATCH_1)`).toBeGreaterThan(0);
    }
    test.info().annotations.push({ type: "part A", description: JSON.stringify({ batch1: BATCH_1, calls: record }) });
  });

  test("B: the two cron routes drain first, in calls of their own, then refresh", async ({ baseURL }) => {
    test.setTimeout(600_000);
    expect(new URL(baseURL!).hostname.endsWith(".workers.dev"), "the routes are POSTed on the app under test or Cloud Run, never on a Workers host").toBe(false);
    expect(!!CRON_SECRET, "set LIFECYCLE_CRON_SECRET (scripts/lifecycle-nightly.sh sets it for the app it starts) or KIVO_CLOUD_RUN_CRON_SECRET (Cloud Run)").toBe(true);
    const post = async (route: string) => {
      const t0 = Date.now();
      const res = await fetch(new URL(`/api/cron/${route}`, baseURL), {
        method: "POST",
        headers: { "x-cron-secret": CRON_SECRET },
        signal: AbortSignal.timeout(180_000),
      });
      const body = (await res.json().catch(() => null)) as (Record<string, unknown> & { ok?: boolean; error?: string; views?: unknown; completion_sweep_drain?: Drain }) | null;
      return { status: res.status, body, ms: Date.now() - t0 };
    };
    /** The view entries of either route's body: `views` (gamification), or the index keys (report). */
    const entriesOf = (body: Record<string, unknown> | null): Entry[] => {
      if (!body) return [];
      if (Array.isArray(body.views)) return body.views as Entry[];
      return Object.keys(body).filter((k) => /^\d+$/.test(k)).sort((a, b) => Number(a) - Number(b)).map((k) => body[k] as Entry);
    };
    const record: Array<Record<string, unknown>> = [];
    for (const route of ["gamification-refresh", "refresh-report-views"] as const) {
      await seedBatch(BATCH_ROUTE);
      let before = await backlog();
      let r = await post(route);
      let busy = false;
      if (r.body?.completion_sweep_drain?.stopped === "busy" && r.body.completion_sweep_drain.handled === 0) {
        // the staging job (D-S3) may have taken the batch: a fresh one, then once more
        busy = true;
        await sleep(6_000);
        await seedBatch(BATCH_ROUTE);
        before = await backlog();
        r = await post(route);
      }
      const after = await backlog();
      const drain = r.body?.completion_sweep_drain;
      const entries = entriesOf(r.body);
      record.push({ route, before, after, status: r.status, ms: r.ms, drain: drain ?? null, retriedAfterBusy: busy });
      expect(r.status, `${route}: ${r.status} ${r.body?.error ?? ""}`).toBe(200);
      expect(r.body?.ok, `${route}: ok`).toBe(true);
      expect(entries.length, `${route}: the refresh's entries are in the body`).toBeGreaterThan(1);
      expect(entries.filter((e) => e.error !== null).map((e) => e.view), `${route}: every entry's error null`).toEqual([]);
      expect(drain, `${route}: completion_sweep_drain in the body (an app without the drain has none)`).toBeTruthy();
      if (busy) expect(drain!.stopped, `${route}: a second 'busy'`).not.toBe("busy");
      expect(drain!.handled, `${route}: the drain handled rows (${JSON.stringify(drain)})`).toBeGreaterThan(0);
      expect(after, `${route}: the backlog lower than before (${before})`).toBeLessThan(before);
    }
    test.info().annotations.push({ type: "part B", description: JSON.stringify({ batch: BATCH_ROUTE, calls: record, seededInAll: s.seeded }) });
  });
});
