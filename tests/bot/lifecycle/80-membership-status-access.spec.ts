/**
 * ADR 0030 (membership status), lifecycle spec 80, in the two groups of
 * build prerequisites point 6. The DATABASE GROUP (the first block below) is
 * everything migration 0115 closes alone; the APP GROUP (the second block)
 * is everything that needs the app's own checks. A membership counts only
 * while its status is 'active' and its organisation's deleted_at is null;
 * the rule tests the reader, never the person a row is about.
 *
 * It first probes for 0115 by behaviour (an inactive member's
 * is_org_member answers false, beside an active control's true) and fails
 * with a clear message when the file is not on the database. It never
 * skips. A failed control fails the spec.
 *
 * Seeds its own lifecycle-* organisations and @lifecycle.test accounts
 * (./data.ts) and touches no existing organisation; its three
 * platform-owner marks are removed in afterAll:
 *   A, live: an active administrator (the control), an inactive and a
 *     suspended administrator, an inactive learner, an active and an
 *     inactive data analyst, a person whose status is changed in mid-session,
 *     person X (an active learner here), and a platform owner with an
 *     inactive row and one with an active row;
 *   B, live: an active administrator, and X's row (an administrator's), inactive;
 *   D: an active administrator and an active learner, both added before D
 *     is soft-deleted; before the delete the administrator reads D, the
 *     learner's member row and the learner's profile (the control that lets
 *     the reads after the delete fail);
 *   a signed-in person with no membership (the outsider), and a platform
 *   owner with no row in A.
 *
 * Cases (each refused answer is compared with the outsider's on the same
 * organisation, and a page also with an unknown organisation address):
 *   (1) the inactive administrator, the suspended administrator, the inactive
 *       learner, the inactive data analyst, and D's administrator and D's
 *       learner after the soft delete: the data API (the organisation row,
 *       its courses, other members' rows and profiles, the four helpers), a
 *       learner page, an admin page and a route guarded by row security alone
 *       (POST /api/folders, the administrators only) answer as for the
 *       outsider; the control reads and writes as today. A person still reads
 *       their own membership row (decision 5). The profile read names a
 *       co-member of the person's own organisation: A's control for A's
 *       people, D's learner for D's administrator (whose zero count of other
 *       members' rows now has that learner's row behind it), and D's
 *       administrator for D's learner. The profile and other-member reads
 *       prove nothing for the learners and the data analyst, who never had
 *       them; the organisation row, the courses and the helpers carry those
 *       people.
 *   (2) a status changed in mid-session is refused at the next request and
 *       restored when set back (page, data API).
 *   (3) X, an active learner in A who holds an inactive administrator row in
 *       B (under the old rule that row still read B, its member rows and
 *       profiles, and wrote the folder): /select-org sends X straight to A;
 *       in B a learner page, the folder route and the data API answer as for
 *       the outsider, and no folder is written; in A all still work, and X is
 *       no administrator there; X reads their own profile (the control) and
 *       not the profile of B's administrator. Nothing is asserted of the
 *       profiles of A's co-members: a learner's session reads no other
 *       member's profile on any database built from the repository's
 *       migrations, before 0115 or after it (the profiles policy reads
 *       organization_members under that table's own row security; on
 *       staging 0115's before-check B4b listed no other policy on that
 *       table and its after-check A4 passed). That read is the rehearsal's,
 *       whose X is an administrator in both
 *       (scripts/migration-rehearsal/assert-0115.sql; ADR 0030, note
 *       "Spec 80, first run", 2026-11-18).
 *   (4) the control still reads the inactive learner's membership row and
 *       profile (the rule tests the reader only).
 *   (5) the data analyst: is_org_data_analyst answers true for the active
 *       one and false for the inactive one; the active one reads A, the
 *       inactive one does not.
 *   (6) impersonation as it is before ADR 0026, on a page, last in the
 *       spec (it needs IMPERSONATION_SECRET on the app under test): (a) a
 *       platform owner with no row in A is sent back; (b) one whose row in
 *       A is inactive gets the same answer as (a) and never the admin page;
 *       (c) one whose row is active opens the admin page; the row set
 *       inactive in mid-session gives (a)'s answer at the next request, and
 *       set back it is restored. (b) is compared with (a), so ADR 0026's
 *       pull requests change one expectation for both.
 *
 * The APP GROUP seeds its own organisations, people and platform owners (it
 * shares no state with the database group) and opens with a probe for the
 * app's code: the platform console's administrator list carries each row's
 * status. A failed probe fails the group with a clear message; it never
 * skips. Every refusal is compared with the live answer to a reference
 * caller (the outsider on the same call, an unknown organisation id, a
 * revoked key), beside a control that is let through:
 *   - admin routes keyed on an organisation id: an admin's reply on a
 *     ticket, whose organisation comes from the ticket (an inactive and a
 *     suspended administrator, X in B, D's administrator after the soft
 *     delete); no reply is written; the control's reply mails nobody, its
 *     requester being the inactive learner (read again in the mail test,
 *     after a positive control, since the reply mails in the background);
 *   - the export and the lists: the control's Users list, course learners
 *     table and its CSV still show the inactive learner, whose attempts are
 *     unchanged; the refused administrators and the inactive data analyst
 *     get the outsider's answer from the export; the active data analyst
 *     opens the reports page, which reads with the service role and still
 *     shows the inactive learner's attempt, is refused the export (manage
 *     only; no export admits a data analyst) and is sent from the Users
 *     page, and the inactive one gets the outsider's answer on the reports
 *     page;
 *   - mail: an organisation-wide assignment logs a mail for each active
 *     member and none for the inactive and suspended ones (email paused, so
 *     nothing leaves); a broadcast in A to X and the inactive learner
 *     counts X only (email is paused there, so it answers that nothing was
 *     sent and writes no row), and one in B to X reaches nobody;
 *   - a cmi5 launch open while the learner is deactivated on the Users
 *     page: the next statement is refused, the attempt stays in progress,
 *     and after reactivation a new launch resumes it; removing the learner
 *     on the Users page then refuses that new launch's next statement too
 *     (the row is written back for the tests after it);
 *   - a SCORM commit from the inactive learner is refused 403 no_access and
 *     writes nothing (the membership is tested before the runtime);
 *   - language-preference from the inactive learner: the outsider's answer,
 *     no preference row;
 *   - a deleted organisation's API key gets the revoked key's answer;
 *   - the platform console lists each administrator's status, still manages
 *     the deleted tenant, and its add brings an inactive administrator back
 *     at the next request;
 *   - impersonation (last; it needs IMPERSONATION_SECRET): a start on the
 *     deleted organisation gets the unknown organisation's answer and writes
 *     no session row; a session started before a deletion opens no page
 *     after it; case (b)'s admin route answers as case (a)'s.
 *
 * Gates: the database group by hand on staging after 0115's staging paste
 * (ADR 0030 gate G2); the whole spec by hand on a build of pull request B's
 * branch against staging (gate G4) and again after that build is deployed
 * on staging (gate G5); never while another harness runs there; it joins
 * the nightly list after one green run. Never against production.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { test, expect, type APIResponse, type BrowserContext } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  addMember,
  createAuthUser,
  createOrg,
  markPlatformOwner,
  rand,
  svc,
  testSlug,
  type SeededOrg,
  type SeededUser,
} from "./data";
import { authedContext, latestAttemptId, uploadCourse, type CourseHandle } from "./helpers";
import { authTokenFor, sha256, VERB, XAPI_HEADERS } from "./p0-helpers";

type Status = "active" | "inactive" | "suspended";
type Role = "admin" | "user" | "data_analyst";
type Reads = { org: number; courses: number; others: number; member: boolean; admin: boolean };

const PROBE_FAIL =
  "0115 is not on this database: an inactive member still counts. Paste 0115 on staging first (ADR 0030 gate G2); this spec never skips.";

const s: {
  a?: SeededOrg;
  b?: SeededOrg;
  d?: SeededOrg;
  users: Record<string, SeededUser>;
  ctx: Record<string, BrowserContext>;
  db: Record<string, SupabaseClient>;
  platformOwners: string[];
} = { users: {}, ctx: {}, db: {}, platformOwners: [] };

const u = (k: string) => {
  const v = s.users[k];
  if (!v) throw new Error(`no seeded person ${k}`);
  return v;
};

async function setStatus(orgId: string, userId: string, status: Status): Promise<void> {
  const { error } = await svc().from("organization_members").update({ status }).eq("organization_id", orgId).eq("user_id", userId);
  expect(error, `status ${status}: ${error?.message}`).toBeNull();
}

/** A data API client signed in as the person (anon key and the person's own token). */
async function sessionDb(user: SeededUser): Promise<SupabaseClient> {
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await db.auth.signInWithPassword({ email: user.email, password: user.password });
  expect(error, `data API sign-in: ${error?.message}`).toBeNull();
  return db;
}

/** What a session reads of one organisation over the data API. */
async function reads(db: SupabaseClient, orgId: string, self: string): Promise<Reads> {
  const count = async (q: PromiseLike<{ count: number | null; error: { message: string } | null }>) => {
    const { count: n, error } = await q;
    expect(error, error?.message).toBeNull();
    return n ?? 0;
  };
  const rpc = async (fn: string) => {
    const { data, error } = await db.rpc(fn, { org_id: orgId });
    expect(error, `${fn}: ${error?.message}`).toBeNull();
    return data === true;
  };
  return {
    org: await count(db.from("organizations").select("id", { count: "exact", head: true }).eq("id", orgId)),
    courses: await count(db.from("courses").select("id", { count: "exact", head: true }).eq("organization_id", orgId)),
    // other people's membership rows; a person still reads their own (decision 5)
    others: await count(
      db.from("organization_members").select("user_id", { count: "exact", head: true }).eq("organization_id", orgId).neq("user_id", self),
    ),
    member: await rpc("is_org_member"),
    admin: await rpc("is_org_admin"),
  };
}

async function canReadProfile(db: SupabaseClient, id: string): Promise<boolean> {
  const { data, error } = await db.from("profiles").select("id").eq("id", id);
  expect(error, error?.message).toBeNull();
  return (data ?? []).length === 1;
}

const NOTHING: Reads = { org: 0, courses: 0, others: 0, member: false, admin: false };

/**
 * Where a page sends the session: "redirect <path>" (a 3xx, or Next's
 * redirect marker in a streamed 200), "rendered", or the status.
 */
async function pageOutcome(ctx: BrowserContext, path: string): Promise<string> {
  const res = await ctx.request.get(path, { maxRedirects: 0, timeout: 120_000 });
  const status = res.status();
  const pathOf = (loc: string) => {
    try {
      return new URL(loc, "http://x.invalid").pathname;
    } catch {
      return loc;
    }
  };
  if (status >= 300 && status < 400) return `redirect ${pathOf(res.headers()["location"] ?? "")}`;
  if (status === 200) {
    const m = /NEXT_REDIRECT;(?:replace|push);([^;"\\]+);/.exec(await res.text());
    return m ? `redirect ${pathOf(m[1])}` : "rendered";
  }
  return `status ${status}`;
}

const learnerPage = (org: SeededOrg) => `/${org.slug}/dashboard`;
const adminPage = (org: SeededOrg) => `/${org.slug}/users`;

/** POST /api/folders, the route guarded by row security alone: its status and body. */
async function folderCreate(ctx: BrowserContext, org: SeededOrg, name: string): Promise<{ status: number; body: string }> {
  const res = await ctx.request.post("/api/folders", { data: { orgSlug: org.slug, name } });
  return { status: res.status(), body: await res.text() };
}

async function foldersNamed(orgId: string, name: string): Promise<number> {
  const { count, error } = await svc().from("folders").select("id", { count: "exact", head: true }).eq("organization_id", orgId).eq("name", name);
  expect(error, error?.message).toBeNull();
  return count ?? 0;
}

test.describe.serial("ADR 0030 spec 80: membership status, the database group (0115)", () => {
  test("seed: three organisations, their people, a course in each; D soft-deleted after its control read", async ({ browser, baseURL }) => {
    test.setTimeout(10 * 60_000);
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
    expect(url, "NEXT_PUBLIC_SUPABASE_URL is set").not.toBe("");
    expect(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "", "NEXT_PUBLIC_SUPABASE_ANON_KEY is set").not.toBe("");

    s.a = await createOrg({ name: "Lifecycle membership A" });
    s.b = await createOrg({ name: "Lifecycle membership B" });
    s.d = await createOrg({ name: "Lifecycle membership D" });
    for (const org of [s.a, s.b, s.d]) {
      const { error } = await svc()
        .from("courses")
        .insert({ organization_id: org.id, title: "Membership status course", slug: `membership-${rand()}`, status: "published" });
      expect(error, `course in ${org.slug}: ${error?.message}`).toBeNull();
    }

    const people: Array<[string, SeededOrg | null, Role, Status]> = [
      ["admin", s.a, "admin", "active"],
      ["inactiveAdmin", s.a, "admin", "inactive"],
      ["suspendedAdmin", s.a, "admin", "suspended"],
      ["inactiveLearner", s.a, "user", "inactive"],
      ["analyst", s.a, "data_analyst", "active"],
      ["inactiveAnalyst", s.a, "data_analyst", "inactive"],
      ["flip", s.a, "admin", "active"],
      ["x", s.a, "user", "active"],
      ["adminB", s.b, "admin", "active"],
      ["deletedAdmin", s.d, "admin", "active"],
      ["deletedLearner", s.d, "user", "active"],
      ["outsider", null, "user", "active"],
      ["poNone", null, "user", "active"],
      ["poInactive", s.a, "user", "inactive"],
      ["poActive", s.a, "user", "active"],
    ];
    for (const [key, org, role, status] of people) {
      const user = await createAuthUser({ profile: { first_name: "Membership", last_name: key, must_change_password: false } });
      s.users[key] = user;
      if (org) {
        await addMember({ organizationId: org.id, userId: user.id, role });
        if (status !== "active") await setStatus(org.id, user.id, status);
      }
    }
    // X's row in B is an administrator's, then set inactive. Under the old rule
    // such a row still passed is_org_admin (B's member rows and profiles, the
    // folder write), so each refusal of case (3) in B is a test of 0115. An
    // inactive learner row never passed an administrator test.
    await addMember({ organizationId: s.b.id, userId: u("x").id, role: "admin" });
    await setStatus(s.b.id, u("x").id, "inactive");
    for (const key of ["poNone", "poInactive", "poActive"]) {
      await markPlatformOwner(u(key).id);
      s.platformOwners.push(u(key).id);
    }

    // D's control, before the soft delete: its administrator reads D, D's
    // learner's member row and that learner's profile. Without it the reads of
    // case (1) after the delete could not fail.
    const dDb = await sessionDb(u("deletedAdmin"));
    const dBefore = await reads(dDb, s.d.id, u("deletedAdmin").id);
    expect(dBefore.org, "D's administrator reads D before the soft delete").toBe(1);
    expect(dBefore.others, "D's administrator reads D's learner's member row before the soft delete").toBe(1);
    expect(await canReadProfile(dDb, u("deletedLearner").id), "D's administrator reads D's learner's profile before the soft delete").toBe(true);
    const now = Date.now();
    const { error: delErr } = await svc()
      .from("organizations")
      .update({ scheduled_deletion_at: new Date(now - 31 * 86_400_000).toISOString(), deleted_at: new Date(now).toISOString() })
      .eq("id", s.d.id);
    expect(delErr, `soft delete of D: ${delErr?.message}`).toBeNull();

    for (const key of Object.keys(s.users)) {
      s.db[key] = await sessionDb(u(key));
      s.ctx[key] = await authedContext(browser, baseURL!, u(key).email, u(key).password);
    }
  });

  test("0115 is on this database (probe by behaviour, beside the control)", async () => {
    const control = await reads(s.db.admin, s.a!.id, u("admin").id);
    expect(control.member && control.admin && control.org === 1, "the control (an active administrator of A) reads A").toBe(true);
    const inactive = await reads(s.db.inactiveAdmin, s.a!.id, u("inactiveAdmin").id);
    expect(inactive.member, PROBE_FAIL).toBe(false);
  });

  test("(1) the data API: a membership that does not count reads as the outsider's; the control reads A", async () => {
    const outsiderA = await reads(s.db.outsider, s.a!.id, u("outsider").id);
    const outsiderD = await reads(s.db.outsider, s.d!.id, u("outsider").id);
    expect(outsiderA, "the outsider reads nothing of A").toEqual(NOTHING);
    expect(outsiderD, "the outsider reads nothing of D").toEqual(NOTHING);

    const control = await reads(s.db.admin, s.a!.id, u("admin").id);
    expect(control.org, "control: A's row").toBe(1);
    expect(control.courses, "control: A's course").toBeGreaterThanOrEqual(1);
    // A's nine other members, of every status
    expect(control.others, "control: the other members' rows, the inactive ones included").toBe(9);
    expect([control.member, control.admin], "control: is_org_member, is_org_admin").toEqual([true, true]);
    expect(await canReadProfile(s.db.admin, u("inactiveLearner").id), "control: the inactive learner's profile").toBe(true);

    // The last field names the co-member whose profile is read. D's
    // administrator names D's learner, whose row and profile the seed's control
    // read before the delete, so its zero count and its refused profile read
    // here can fail.
    for (const [key, org, outsider, coMember] of [
      ["inactiveAdmin", s.a!, outsiderA, "admin"],
      ["suspendedAdmin", s.a!, outsiderA, "admin"],
      ["inactiveLearner", s.a!, outsiderA, "admin"],
      ["inactiveAnalyst", s.a!, outsiderA, "admin"],
      ["deletedAdmin", s.d!, outsiderD, "deletedLearner"],
      ["deletedLearner", s.d!, outsiderD, "deletedAdmin"],
    ] as Array<[string, SeededOrg, Reads, string]>) {
      expect(await reads(s.db[key], org.id, u(key).id), `${key}: as the outsider`).toEqual(outsider);
      expect(await canReadProfile(s.db[key], u(coMember).id), `${key}: no co-member's profile (${coMember})`).toBe(false);
      const { data: own, error } = await s.db[key].from("organization_members").select("status").eq("organization_id", org.id).eq("user_id", u(key).id);
      expect(error, error?.message).toBeNull();
      expect((own ?? []).length, `${key}: still reads their own membership row`).toBe(1);
    }
  });

  test("(1) pages: a learner page and an admin page answer as for the outsider and an unknown address; the control's render", async () => {
    const unknown = { id: "", name: "", slug: testSlug("nowhere") } as SeededOrg;
    for (const page of [learnerPage, adminPage]) {
      const outsiderA = await pageOutcome(s.ctx.outsider, page(s.a!));
      expect(outsiderA, `the outsider on ${page(s.a!)}`).toBe("redirect /select-org");
      expect(await pageOutcome(s.ctx.outsider, page(unknown)), "the outsider on an unknown address").toBe(outsiderA);
      expect(await pageOutcome(s.ctx.outsider, page(s.d!)), "the outsider on D").toBe(outsiderA);
      expect(await pageOutcome(s.ctx.admin, page(s.a!)), `the control on ${page(s.a!)}`).toBe("rendered");
      for (const [key, org] of [
        ["inactiveAdmin", s.a!],
        ["suspendedAdmin", s.a!],
        ["inactiveLearner", s.a!],
        ["inactiveAnalyst", s.a!],
        ["deletedAdmin", s.d!],
        ["deletedLearner", s.d!],
      ] as Array<[string, SeededOrg]>) {
        expect(await pageOutcome(s.ctx[key], page(org)), `${key} on ${page(org)}`).toBe(outsiderA);
      }
    }
  });

  test("(1) the folder route, guarded by row security alone: the same status and body as the outsider's, and no row", async () => {
    const name = (who: string) => `membership-${who}-${rand(4)}`;
    const ok = await folderCreate(s.ctx.admin, s.a!, name("control"));
    expect(ok.status, `the control creates a folder: ${ok.body}`).toBeLessThan(300);

    for (const [key, org] of [
      ["inactiveAdmin", s.a!],
      ["suspendedAdmin", s.a!],
      ["deletedAdmin", s.d!],
    ] as Array<[string, SeededOrg]>) {
      const outsider = await folderCreate(s.ctx.outsider, org, name("outsider"));
      expect(outsider.status, "the outsider is refused").toBeGreaterThanOrEqual(400);
      const n = name(key);
      expect(await folderCreate(s.ctx[key], org, n), `${key}: as the outsider`).toEqual(outsider);
      expect(await foldersNamed(org.id, n), `${key}: no folder written`).toBe(0);
    }
  });

  test("(2) a status changed in mid-session is refused at the next request and restored when set back", async () => {
    const a = s.a!;
    const flip = u("flip");
    expect(await pageOutcome(s.ctx.flip, adminPage(a)), "active: the admin page").toBe("rendered");
    expect((await reads(s.db.flip, a.id, flip.id)).org, "active: A's row").toBe(1);

    await setStatus(a.id, flip.id, "inactive");
    try {
      expect(await pageOutcome(s.ctx.flip, adminPage(a)), "inactive: the next request").toBe(await pageOutcome(s.ctx.outsider, adminPage(a)));
      expect(await reads(s.db.flip, a.id, flip.id), "inactive: the same token reads as the outsider").toEqual(NOTHING);
    } finally {
      await setStatus(a.id, flip.id, "active");
    }
    expect(await pageOutcome(s.ctx.flip, adminPage(a)), "set back: the admin page").toBe("rendered");
    expect((await reads(s.db.flip, a.id, flip.id)).admin, "set back: is_org_admin").toBe(true);
  });

  test("(3) a person active in A and inactive in B keeps A and reads nothing of B", async () => {
    const a = s.a!;
    const b = s.b!;
    const x = u("x");
    expect(await pageOutcome(s.ctx.x, "/select-org"), "/select-org sends X straight to A").toBe(`redirect /${a.slug}/dashboard`);

    expect(await pageOutcome(s.ctx.x, learnerPage(a)), "A's learner page").toBe("rendered");
    expect(await pageOutcome(s.ctx.x, learnerPage(b)), "B's learner page, as the outsider").toBe(await pageOutcome(s.ctx.outsider, learnerPage(b)));
    const outsiderFolder = await folderCreate(s.ctx.outsider, b, `membership-outsider-${rand(4)}`);
    const n = `membership-x-${rand(4)}`;
    expect(await folderCreate(s.ctx.x, b, n), "the folder route in B, as the outsider").toEqual(outsiderFolder);
    expect(await foldersNamed(b.id, n), "no folder in B").toBe(0);

    const inA = await reads(s.db.x, a.id, x.id);
    expect([inA.org, inA.member, inA.admin], "X reads A as a member; the administrator row in B gives no administrator right in A").toEqual([1, true, false]);
    expect(inA.courses, "X reads A's course").toBeGreaterThanOrEqual(1);
    expect(await reads(s.db.x, b.id, x.id), "X reads nothing of B").toEqual(await reads(s.db.outsider, b.id, u("outsider").id));
    // The control beside the refused read: the profiles table answers X's
    // session. Nothing is asserted of A's co-members (see the header, case 3).
    expect(await canReadProfile(s.db.x, x.id), "X reads their own profile (the control)").toBe(true);
    expect(await canReadProfile(s.db.x, u("adminB").id), "X does not read the profile of B's administrator").toBe(false);
    expect((await reads(s.db.adminB, b.id, u("adminB").id)).org, "B's control reads B").toBe(1);
    expect(await canReadProfile(s.db.adminB, x.id), "B's control still reads X's profile").toBe(true);
  });

  test("(4) the control still reads the inactive learner's membership row and profile", async () => {
    const { data, error } = await s.db.admin.from("organization_members").select("status").eq("organization_id", s.a!.id).eq("user_id", u("inactiveLearner").id);
    expect(error, error?.message).toBeNull();
    expect(data, "the inactive learner's row, as it is").toEqual([{ status: "inactive" }]);
    expect(await canReadProfile(s.db.admin, u("inactiveLearner").id), "the inactive learner's profile").toBe(true);
  });

  test("(5) the data analyst: is_org_data_analyst follows the status", async () => {
    const answer = async (key: string) => {
      const { data, error } = await s.db[key].rpc("is_org_data_analyst", { org_id: s.a!.id });
      expect(error, `${key}: ${error?.message}`).toBeNull();
      return data === true;
    };
    expect(await answer("analyst"), "active analyst").toBe(true);
    expect((await reads(s.db.analyst, s.a!.id, u("analyst").id)).org, "the active analyst reads A").toBe(1);
    expect(await answer("inactiveAnalyst"), "inactive analyst").toBe(false);
  });

  // Last: the one block that depends on the target's configuration
  // (IMPERSONATION_SECRET on the app server), as spec 68 orders it.
  test("(6) impersonation before ADR 0026: no row and an inactive row get the same answer; an active row follows its status", async () => {
    const a = s.a!;
    const reason = "lifecycle spec 80 (ADR 0030)";
    const impersonate = async (key: string, run: () => Promise<void>) => {
      const ctx = s.ctx[key];
      const start = await ctx.request.post("/api/super/impersonate", { data: { org_id: a.id, reason } });
      expect(start.status(), `${key}: impersonate → ${start.status()} (the target needs IMPERSONATION_SECRET): ${await start.text()}`).toBeLessThan(400);
      try {
        await run();
      } finally {
        const end = await ctx.request.delete("/api/super/impersonate");
        expect(end.status(), `${key}: end impersonation → ${end.status()}`).toBeLessThan(400);
      }
    };

    let none = "";
    await impersonate("poNone", async () => {
      none = await pageOutcome(s.ctx.poNone, adminPage(a));
      expect(none, "(a) no row: sent back").toMatch(/^redirect /);
    });
    await impersonate("poInactive", async () => {
      expect(await pageOutcome(s.ctx.poInactive, adminPage(a)), "(b) an inactive row: as (a)").toBe(none);
      expect(await pageOutcome(s.ctx.poInactive, learnerPage(a)), "(b) an inactive row, a learner page: as (a)").toBe(
        await pageOutcome(s.ctx.poNone, learnerPage(a)),
      );
    });
    await impersonate("poActive", async () => {
      expect(await pageOutcome(s.ctx.poActive, adminPage(a)), "(c) an active row: the admin page").toBe("rendered");
      await setStatus(a.id, u("poActive").id, "inactive");
      try {
        expect(await pageOutcome(s.ctx.poActive, adminPage(a)), "(c) set inactive: as (a) at the next request").toBe(none);
      } finally {
        await setStatus(a.id, u("poActive").id, "active");
      }
      expect(await pageOutcome(s.ctx.poActive, adminPage(a)), "(c) set back: the admin page again").toBe("rendered");
    });
  });

  test.afterAll(async () => {
    for (const ctx of Object.values(s.ctx)) await ctx.close().catch(() => undefined);
    // No platform owner is left behind on staging by this spec.
    for (const id of s.platformOwners) await svc().from("platform_owners").delete().eq("user_id", id);
  });
});

/* ------------------------------------------------------------------------
 * The APP GROUP: everything that needs the app's own checks (build
 * prerequisites point 6). Its own organisations, people and state.
 * ---------------------------------------------------------------------- */

const CODE_PROBE_FAIL =
  "The app under test does not carry ADR 0030's app checks: the platform console's administrator list has no status. Build pull request B's branch (ADR 0030 gate G4); this spec never skips.";

const app: {
  a?: SeededOrg;
  b?: SeededOrg;
  d?: SeededOrg;
  e?: SeededOrg;
  users: Record<string, SeededUser>;
  ctx: Record<string, BrowserContext>;
  platformOwners: string[];
  course?: CourseHandle;
  dCourseId?: string;
  tickets: Record<string, string>;
  keys: Record<string, string>;
  keyIds: string[];
  snapshot?: string;
} = { users: {}, ctx: {}, platformOwners: [], tickets: {}, keys: {}, keyIds: [] };

const ap = (k: string) => {
  const v = app.users[k];
  if (!v) throw new Error(`no seeded person ${k}`);
  return v;
};

const locationPath = (loc: string) => {
  try {
    return new URL(loc, "http://x.invalid").pathname;
  } catch {
    return loc;
  }
};

/** What a route answered: its status, where a 3xx sends the caller, and the body otherwise. */
async function answer(res: APIResponse): Promise<{ status: number; to: string; body: string }> {
  const status = res.status();
  if (status >= 300 && status < 400) return { status, to: locationPath(res.headers()["location"] ?? ""), body: "" };
  return { status, to: "", body: await res.text() };
}

/** A learner's attempts on a version, as one comparable string. */
async function attemptRows(userId: string, versionId: string): Promise<string> {
  const { data, error } = await svc()
    .from("course_attempts")
    .select("id, status, completion_status, success_status, score, completed_at, progress_pct, cmi_data, last_activity_at")
    .eq("user_id", userId)
    .eq("course_version_id", versionId)
    .order("started_at", { ascending: true });
  expect(error, error?.message).toBeNull();
  return JSON.stringify(data ?? []);
}

/** Mail logged by the organisation to one person for one event (email is paused there, so nothing leaves). */
async function mailRows(orgId: string, userId: string, event: string): Promise<number> {
  const { count, error } = await svc()
    .from("notification_log")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .eq("to_user_id", userId)
    .eq("event_type", event);
  expect(error, error?.message).toBeNull();
  return count ?? 0;
}

async function rowCount(table: string, filters: Record<string, string>): Promise<number> {
  let q = svc().from(table).select("*", { count: "exact", head: true });
  for (const [k, v] of Object.entries(filters)) q = q.eq(k, v);
  const { count, error } = await q;
  expect(error, `${table}: ${error?.message}`).toBeNull();
  return count ?? 0;
}

/** One xAPI statement on a cmi5 launch, with that launch's auth token: the answer's status. */
async function statement(ctx: BrowserContext, auth: string, attemptId: string, who: SeededUser, homePage: string, verb: string, result?: unknown): Promise<number> {
  const res = await ctx.request.post("/api/xapi/statements", {
    headers: { ...XAPI_HEADERS, Authorization: auth },
    data: {
      actor: { objectType: "Agent", name: who.email, account: { homePage, name: who.id } },
      verb: { id: VERB(verb) },
      object: { objectType: "Activity", id: "https://qa.bot/cmi5/au1" },
      context: { registration: attemptId },
      ...(result === undefined ? {} : { result }),
    },
    maxRedirects: 0,
  });
  return res.status();
}

async function softDelete(orgId: string): Promise<void> {
  const now = Date.now();
  const { error } = await svc()
    .from("organizations")
    .update({ scheduled_deletion_at: new Date(now - 31 * 86_400_000).toISOString(), deleted_at: new Date(now).toISOString() })
    .eq("id", orgId);
  expect(error, `soft delete: ${error?.message}`).toBeNull();
}

test.describe.serial("ADR 0030 spec 80: membership status, the app group", () => {
  test("seed: four organisations and their people; a cmi5 course in A, a launch then a deactivation on the Users page; tickets and keys; D soft-deleted", async ({ browser, baseURL }) => {
    test.setTimeout(15 * 60_000);
    app.a = await createOrg({ name: "Lifecycle membership app A" });
    app.b = await createOrg({ name: "Lifecycle membership app B" });
    app.d = await createOrg({ name: "Lifecycle membership app D" });
    app.e = await createOrg({ name: "Lifecycle membership app E" });
    const { a, b, d, e } = app as Required<Pick<typeof app, "a" | "b" | "d" | "e">>;
    // Email paused in every organisation of the group: a mail is logged and
    // never leaves. A broadcast is paused too: the route answers that nothing
    // was sent, with the number of recipients it would have mailed, and logs
    // no row (ADR 0029, the owner's decision of 2026-11-21).
    for (const org of [a, b, d, e]) {
      const { error } = await svc().from("notification_settings").upsert({ organization_id: org.id, email_paused: true }, { onConflict: "organization_id" });
      expect(error, `pause email in ${org.slug}: ${error?.message}`).toBeNull();
    }

    const people: Array<[string, SeededOrg | null, Role]> = [
      ["admin", a, "admin"],
      ["inactiveAdmin", a, "admin"],
      ["suspendedAdmin", a, "admin"],
      ["inactiveLearner", a, "user"],
      ["analyst", a, "data_analyst"],
      ["inactiveAnalyst", a, "data_analyst"],
      ["x", a, "user"],
      ["launcher", a, "user"],
      ["adminB", b, "admin"],
      ["deletedAdmin", d, "admin"],
      ["outsider", null, "user"],
      ["po", null, "user"],
      ["poInactive", a, "user"],
      ["poE", e, "admin"],
    ];
    for (const [key, org, role] of people) {
      const user = await createAuthUser({ profile: { first_name: "Membership", last_name: `app ${key}`, must_change_password: false } });
      app.users[key] = user;
      if (org) await addMember({ organizationId: org.id, userId: user.id, role });
    }
    // X: an active learner in A who holds an administrator row in B, inactive.
    await addMember({ organizationId: b.id, userId: ap("x").id, role: "admin" });
    await setStatus(b.id, ap("x").id, "inactive");
    for (const key of ["po", "poInactive", "poE"]) {
      await markPlatformOwner(ap(key).id);
      app.platformOwners.push(ap(key).id);
    }
    for (const key of Object.keys(app.users)) app.ctx[key] = await authedContext(browser, baseURL!, ap(key).email, ap(key).password);

    // A cmi5 course in A, assigned directly to the launcher and to the learner deactivated next.
    app.course = await uploadCourse(app.ctx.admin.request, a.slug, "cmi5.zip");
    const assigned = await app.ctx.admin.request.post("/api/assignments", {
      data: { orgSlug: a.slug, courseId: app.course.courseId, userIds: [ap("launcher").id, ap("inactiveLearner").id] },
    });
    expect(assigned.ok(), `assign the course: ${assigned.status()} ${await assigned.text()}`).toBe(true);
    // The learner opens a launch while active (an attempt and a launch token),
    // then an administrator deactivates them on the Users page.
    const launched = await app.ctx.inactiveLearner.request.get(`/${a.slug}/courses/${app.course.courseId}/launch`, { timeout: 120_000 });
    expect(launched.ok(), `the learner's launch: ${launched.status()}`).toBe(true);
    const off = await app.ctx.admin.request.patch(`/api/users/${ap("inactiveLearner").id}?orgSlug=${a.slug}`, { data: { status: "inactive" } });
    const offBody = (await off.json()) as { ok?: boolean; tokens_expired?: boolean };
    expect([off.status(), offBody.ok], "the Users page deactivates the learner").toEqual([200, true]);
    expect(offBody.tokens_expired, "the deactivation expired the learner's launch tokens (if false, read the embedded token read of expireLaunchTokensForMembers first)").not.toBe(false);
    await setStatus(a.id, ap("inactiveAdmin").id, "inactive");
    await setStatus(a.id, ap("suspendedAdmin").id, "suspended");
    await setStatus(a.id, ap("inactiveAnalyst").id, "inactive");
    await setStatus(a.id, ap("poInactive").id, "inactive");

    // One ticket in A (raised by the inactive learner, so the control's reply
    // mails nobody: a reply's mail ignores the pause), in B (by B's
    // administrator) and in D (by D's administrator).
    for (const [key, org, raiser] of [["a", a, "inactiveLearner"], ["b", b, "adminB"], ["d", d, "deletedAdmin"]] as Array<[string, SeededOrg, string]>) {
      const { data, error } = await svc()
        .from("help_tickets")
        .insert({ organization_id: org.id, user_id: ap(raiser).id, subject: "Lifecycle spec 80 ticket", body: "A test ticket." })
        .select("id")
        .single();
      expect(error, `ticket in ${org.slug}: ${error?.message}`).toBeNull();
      app.tickets[key] = (data as { id: string }).id;
    }
    // A course in D, for its export.
    {
      const { data, error } = await svc()
        .from("courses")
        .insert({ organization_id: d.id, title: "Membership status course", slug: `membership-${rand()}`, status: "published" })
        .select("id")
        .single();
      expect(error, `course in D: ${error?.message}`).toBeNull();
      app.dCourseId = (data as { id: string }).id;
    }
    // API keys: D's (live), and A's revoked and live ones. Stored by hash only; deactivated in afterAll.
    for (const [name, org, active] of [["dLive", d, true], ["aRevoked", a, false], ["aLive", a, true]] as Array<[string, SeededOrg, boolean]>) {
      const key = `ambk_${randomBytes(24).toString("hex")}`;
      const { data, error } = await svc()
        .from("org_api_keys")
        .insert({ organization_id: org.id, name: `Lifecycle spec 80 ${name}`, key_prefix: key.slice(0, 12), key_hash: sha256(key), is_active: active })
        .select("id")
        .single();
      expect(error, `API key ${name}: ${error?.message}`).toBeNull();
      app.keys[name] = key;
      app.keyIds.push((data as { id: string }).id);
    }

    app.snapshot = await attemptRows(ap("inactiveLearner").id, app.course.versionId);
    expect(JSON.parse(app.snapshot).length, "the inactive learner holds one attempt").toBe(1);
    await softDelete(d.id);
  });

  test("the app's checks are on the target (probe: the console's administrator list carries the status)", async () => {
    const res = await app.ctx.po.request.get(`/api/super/tenants/${app.a!.id}/admins`, { maxRedirects: 0 });
    expect(res.status(), `the console's administrator list as a platform owner: ${res.status()}`).toBe(200);
    const body = (await res.json()) as { admins?: Array<{ user_id: string; status?: string }> };
    expect((body.admins ?? []).find((r) => r.user_id === ap("inactiveAdmin").id)?.status, CODE_PROBE_FAIL).toBe("inactive");
  });

  test("admin routes keyed on an organisation id: an admin's reply on a ticket answers as for the outsider and writes nothing; the control replies", async () => {
    const reply = async (who: string, ticket: string) =>
      answer(await app.ctx[who].request.post(`/api/tickets/${ticket}/messages`, { data: { body: `Lifecycle spec 80 reply ${rand(4)}` }, maxRedirects: 0 }));
    for (const [who, org] of [
      ["inactiveAdmin", "a"],
      ["suspendedAdmin", "a"],
      ["x", "b"],
      ["deletedAdmin", "d"],
    ]) {
      const ticket = app.tickets[org];
      const before = await rowCount("help_ticket_messages", { ticket_id: ticket });
      const outsider = await reply("outsider", ticket);
      expect(outsider.status, "the outsider is refused").toBeGreaterThanOrEqual(400);
      expect(await reply(who, ticket), `${who}, a ticket of ${org.toUpperCase()}: as the outsider`).toEqual(outsider);
      expect(await rowCount("help_ticket_messages", { ticket_id: ticket }), `${who}: no reply written`).toBe(before);
    }
    const ok = await reply("admin", app.tickets.a);
    expect(ok.status, `the control (A's active administrator) replies: ${ok.body}`).toBe(200);
    // The reply's mail is sent in the background, after the answer: this
    // first read can come before it would be logged. The mail test below
    // reads it again after its assignment mails, logged later, have landed.
    expect(await mailRows(app.a!.id, ap("inactiveLearner").id, "custom_broadcast"), "the reply's mail does not reach its requester, whose row does not count").toBe(0);
  });

  test("the export and the lists: the control still sees the inactive learner; a membership that does not count gets the outsider's answer", async () => {
    test.setTimeout(5 * 60_000);
    const a = app.a!;
    const courseId = app.course!.courseId;
    const learner = ap("inactiveLearner");
    const exportOf = (org: SeededOrg, course: string) => `/api/courses/${course}/learners/export?orgSlug=${encodeURIComponent(org.slug)}`;
    const get = async (who: string, path: string) => answer(await app.ctx[who].request.get(path, { maxRedirects: 0, timeout: 120_000 }));
    const html = async (who: string, path: string) => {
      const res = await app.ctx[who].request.get(path, { timeout: 120_000 });
      expect(res.ok(), `${who} ${path}: ${res.status()}`).toBe(true);
      return res.text();
    };

    // The control: the Users list, the course learners table and its CSV still show the inactive learner.
    expect(await html("admin", `/${a.slug}/users`), "the Users list shows the inactive learner").toContain(learner.email);
    expect(await html("admin", `/${a.slug}/library/${courseId}/learners`), "the course learners table shows the inactive learner").toContain(learner.email);
    const csv = await get("admin", exportOf(a, courseId));
    expect(csv.status, "the control's CSV").toBe(200);
    expect(csv.body, "the CSV holds the inactive learner").toContain(learner.email);

    // A membership that does not count: the export answers as for the outsider.
    const outsiderA = await get("outsider", exportOf(a, courseId));
    expect(outsiderA.status, "the outsider is refused the export").not.toBe(200);
    for (const who of ["inactiveAdmin", "suspendedAdmin", "inactiveAnalyst"]) {
      expect(await get(who, exportOf(a, courseId)), `${who}: the export, as the outsider`).toEqual(outsiderA);
    }
    const outsiderD = await get("outsider", exportOf(app.d!, app.dCourseId!));
    expect(await get("deletedAdmin", exportOf(app.d!, app.dCourseId!)), "D's administrator after the soft delete: the export, as the outsider").toEqual(outsiderD);

    // The data analyst: the reports page (read with the service role); the export and the Users page are for managers.
    expect(await pageOutcome(app.ctx.analyst, `/${a.slug}/reports`), "the active analyst opens the reports page").toBe("rendered");
    // Case 2's control: that service-role read still shows the inactive
    // learner's rows (their attempt, in the page's recent attempts).
    expect(await html("analyst", `/${a.slug}/reports`), "the active analyst's reports page shows the inactive learner's attempt").toContain(learner.email);
    expect((await get("analyst", exportOf(a, courseId))).status, "the active analyst is refused the export (managers only, as before)").toBe(403);
    expect(await pageOutcome(app.ctx.analyst, `/${a.slug}/users`), "the active analyst is sent from the Users page (managers only, as before)").toBe(`redirect /${a.slug}/dashboard`);
    expect(await pageOutcome(app.ctx.inactiveAnalyst, `/${a.slug}/reports`), "the inactive analyst: the reports page, as the outsider").toBe(
      await pageOutcome(app.ctx.outsider, `/${a.slug}/reports`),
    );

    expect(await attemptRows(learner.id, app.course!.versionId), "the inactive learner's attempts are unchanged").toBe(app.snapshot);
  });

  test("mail: only the members that count are mailed (an organisation-wide assignment, a broadcast in each organisation)", async () => {
    test.setTimeout(5 * 60_000);
    const a = app.a!;
    const b = app.b!;
    const assigned = await app.ctx.admin.request.post("/api/assignments", {
      data: { orgSlug: a.slug, courseId: app.course!.courseId, assignToOrg: true },
      maxRedirects: 0,
    });
    expect(assigned.ok(), `the organisation-wide assignment: ${assigned.status()} ${await assigned.text()}`).toBe(true);
    // Every active member of A is logged one (paused) assignment mail; wait for all of them before the negatives.
    for (const who of ["admin", "analyst", "x", "launcher"]) {
      await expect
        .poll(() => mailRows(a.id, ap(who).id, "asset_assignment"), { message: `${who}: an assignment mail logged`, timeout: 60_000 })
        .toBeGreaterThanOrEqual(1);
    }
    for (const who of ["inactiveAdmin", "suspendedAdmin", "inactiveAnalyst", "poInactive"]) {
      expect(await mailRows(a.id, ap(who).id, "asset_assignment"), `${who}: no assignment mail`).toBe(0);
    }

    const broadcast = async (who: string, org: SeededOrg, userIds: string[]) =>
      answer(
        await app.ctx[who].request.post("/api/notifications/broadcast", {
          data: { orgSlug: org.slug, subject: "Lifecycle spec 80", body_md: "A test notice.", audience: "users", user_ids: userIds },
          maxRedirects: 0,
        }),
      );
    // In B, X's row is inactive: a broadcast to X reaches nobody, as one to a person who is not in B.
    const toOutsider = await broadcast("adminB", b, [ap("outsider").id]);
    expect(toOutsider.status, "B's broadcast to a person not in B is refused").toBe(400);
    expect(await broadcast("adminB", b, [ap("x").id]), "B's broadcast to X: as to the person not in B").toEqual(toOutsider);
    expect(await mailRows(b.id, ap("x").id, "custom_broadcast"), "no broadcast logged for X in B").toBe(0);
    // In A, X counts and the inactive learner does not: one recipient. Email
    // is paused in A, so the broadcast answers 409 that nothing was sent,
    // with that one recipient, and logs no row.
    const xBefore = await mailRows(a.id, ap("x").id, "custom_broadcast");
    const inA = await broadcast("admin", a, [ap("x").id, ap("inactiveLearner").id]);
    const inABody = JSON.parse(inA.body || "{}") as { total?: number; paused?: boolean };
    expect([inA.status, inABody.paused, inABody.total], "A's broadcast to X and the inactive learner: paused, X only").toEqual([409, true, 1]);
    expect(await mailRows(a.id, ap("x").id, "custom_broadcast"), "a paused broadcast logs no row for X").toBe(xBefore);
    // The assignment mails polled above are the positive control, logged
    // after the earlier ticket reply: none at all for the inactive learner,
    // not this broadcast and not that reply's background mail.
    expect(await mailRows(a.id, ap("inactiveLearner").id, "custom_broadcast"), "none for the inactive learner (this broadcast, and the ticket reply before it)").toBe(0);
  });

  test("a cmi5 launch open while the learner is deactivated on the Users page: the next statement is refused, the attempt stays in progress, a new launch resumes it; a removal closes the next one", async ({ baseURL }) => {
    test.setTimeout(5 * 60_000);
    const a = app.a!;
    const course = app.course!;
    const who = ap("launcher");
    const ctx = app.ctx.launcher;
    const launchPath = `/${a.slug}/courses/${course.courseId}/launch`;
    const first = await ctx.request.get(launchPath, { timeout: 120_000 });
    expect(first.ok(), `the launch: ${first.status()}`).toBe(true);
    const attemptId = await latestAttemptId(course.versionId, who.id);
    const auth = await authTokenFor(ctx.request, attemptId);
    expect(await statement(ctx, auth, attemptId, who, baseURL!, "launched"), "the control: the open launch records").toBeLessThan(300);
    expect(await statement(ctx, auth, attemptId, who, baseURL!, "initialized"), "…and again").toBeLessThan(300);
    const state = async () => {
      const { data, error } = await svc().from("course_attempts").select("status, completion_status, success_status, score, completed_at").eq("id", attemptId).single();
      expect(error, error?.message).toBeNull();
      return data;
    };
    const before = await state();
    expect((before as { status: string }).status, "the attempt is in progress").toBe("in_progress");

    const setOnUsersPage = async (status: Status) => {
      const res = await app.ctx.admin.request.patch(`/api/users/${who.id}?orgSlug=${a.slug}`, { data: { status }, maxRedirects: 0 });
      const body = (await res.json()) as { ok?: boolean; tokens_expired?: boolean };
      expect([res.status(), body.ok], `the Users page sets the learner ${status}`).toEqual([200, true]);
      return body;
    };
    const off = await setOnUsersPage("inactive");
    try {
      expect(off.tokens_expired, "the deactivation expired the launch tokens (if false, read the embedded token read of expireLaunchTokensForMembers first)").not.toBe(false);
      expect(await statement(ctx, auth, attemptId, who, baseURL!, "passed", { score: { scaled: 0.9 } }), "the next statement on the open launch is refused").toBe(401);
      expect(await state(), "the attempt is left as it was: in progress, nothing passed").toEqual(before);
    } finally {
      await setOnUsersPage("active");
    }
    const again = await ctx.request.get(launchPath, { timeout: 120_000 });
    expect(again.ok(), `the launch after reactivation: ${again.status()}`).toBe(true);
    expect(await latestAttemptId(course.versionId, who.id), "a new launch resumes the same attempt").toBe(attemptId);
    const auth2 = await authTokenFor(ctx.request, attemptId);
    expect(auth2, "with a new launch token").not.toBe(auth);
    expect(await statement(ctx, auth2, attemptId, who, baseURL!, "initialized"), "the new launch records").toBeLessThan(300);

    // Removing the member on the Users page closes the open launch as a
    // deactivation does. The row is written back in `finally`: the SCORM
    // test below uses this learner as its active control.
    const kept = await state();
    const removed = await app.ctx.admin.request.delete(`/api/organization-members/${who.id}?orgSlug=${a.slug}`, { maxRedirects: 0 });
    const removedBody = (await removed.json()) as { ok?: boolean; tokens_expired?: boolean };
    try {
      expect([removed.status(), removedBody.ok], "the Users page removes the learner").toEqual([200, true]);
      expect(removedBody.tokens_expired, "the removal expired the launch tokens").not.toBe(false);
      expect(await statement(ctx, auth2, attemptId, who, baseURL!, "passed", { score: { scaled: 0.9 } }), "the next statement on the open launch is refused").toBe(401);
      expect(await state(), "the attempt is left as it was").toEqual(kept);
    } finally {
      await addMember({ organizationId: a.id, userId: who.id, role: "user" });
    }
  });

  test("a SCORM commit from the inactive learner is refused 403 no_access and writes nothing; an active learner's reaches the runtime test", async () => {
    const course = app.course!;
    const learner = ap("inactiveLearner");
    const commit = async (who: string, attemptId: string) =>
      app.ctx[who].request.post(`/api/scorm/${attemptId}/commit`, {
        data: { cmi: { "cmi.core.lesson_status": "passed", "cmi.core.score.raw": "100" }, finished: true },
        maxRedirects: 0,
      });
    const attemptId = await latestAttemptId(course.versionId, learner.id);
    const refused = await commit("inactiveLearner", attemptId);
    expect([refused.status(), await refused.json()], "the inactive learner's commit on their own attempt").toEqual([403, { error: "no_access" }]);
    expect(await attemptRows(learner.id, course.versionId), "nothing written").toBe(app.snapshot);
    // The control: the active launcher's commit gets past the membership check
    // to ADR 0010's runtime test (the attempt is a cmi5 one: 409).
    const control = await commit("launcher", await latestAttemptId(course.versionId, ap("launcher").id));
    expect(control.status(), "the active learner's commit reaches the runtime test").toBe(409);
  });

  test("language-preference from the inactive learner: the outsider's answer, and no preference row", async () => {
    const courseId = app.course!.courseId;
    const learner = ap("inactiveLearner");
    const put = async (who: string) =>
      answer(await app.ctx[who].request.put(`/api/courses/${courseId}/language-preference`, { data: { orgSlug: app.a!.slug, language: "en" }, maxRedirects: 0 }));
    const before = await rowCount("course_language_preferences", { user_id: learner.id, course_id: courseId });
    const outsider = await put("outsider");
    expect(outsider.status, "the outsider is refused").toBe(404);
    expect(await put("inactiveLearner"), "the inactive learner: as the outsider").toEqual(outsider);
    expect(await rowCount("course_language_preferences", { user_id: learner.id, course_id: courseId }), "no preference row written").toBe(before);
    expect(await attemptRows(learner.id, app.course!.versionId), "the learner's attempts unchanged").toBe(app.snapshot);
    const control = await put("x");
    expect(control, `the control (an active learner of A) gets past the membership check: ${control.status} ${control.body}`).not.toEqual(outsider);
  });

  test("a deleted organisation's API key gets the revoked key's answer; a live organisation's key works", async ({ playwright, baseURL }) => {
    const req = await playwright.request.newContext({ baseURL });
    try {
      const call = async (key: string) => answer(await req.get("/api/integrations/catalog", { headers: { authorization: `Bearer ${key}` }, maxRedirects: 0 }));
      const revoked = await call(app.keys.aRevoked);
      expect(revoked.status, "a revoked key (the reference answer)").toBe(401);
      expect(await call(app.keys.dLive), "D's key, D soft-deleted: as the revoked key").toEqual(revoked);
      const live = await call(app.keys.aLive);
      expect(live.status, `the control, A's live key: ${live.body.slice(0, 200)}`).toBe(200);
    } finally {
      await req.dispose();
    }
  });

  test("the platform console lists each administrator's status, still manages the deleted tenant, and its add brings an inactive administrator back at the next request", async () => {
    const a = app.a!;
    const po = app.ctx.po;
    const list = async (org: SeededOrg) => {
      const res = await po.request.get(`/api/super/tenants/${org.id}/admins`, { maxRedirects: 0 });
      expect(res.status(), `the console's list of ${org.slug}`).toBe(200);
      return ((await res.json()) as { admins: Array<{ user_id: string; status: string }> }).admins;
    };
    const statusIn = (rows: Array<{ user_id: string; status: string }>, key: string) => rows.find((r) => r.user_id === ap(key).id)?.status ?? null;
    const inA = await list(a);
    expect(["admin", "inactiveAdmin", "suspendedAdmin", "analyst", "inactiveAnalyst"].map((k) => statusIn(inA, k)), "A's administrators with their status").toEqual([
      "active",
      "inactive",
      "suspended",
      "active",
      "inactive",
    ]);
    expect(statusIn(await list(app.d!), "deletedAdmin"), "the deleted tenant is still managed: its administrator is listed").toBe("active");

    const usersPage = `/${a.slug}/users`;
    expect(await pageOutcome(app.ctx.inactiveAdmin, usersPage), "the inactive administrator, before the add").toBe(await pageOutcome(app.ctx.outsider, usersPage));
    const add = await po.request.post(`/api/super/tenants/${a.id}/admins`, { data: { email: ap("inactiveAdmin").email, role: "admin" }, maxRedirects: 0 });
    const added = (await add.json()) as { ok?: boolean; reactivated?: boolean; invited?: boolean; error?: string };
    try {
      expect([add.status(), added.ok, added.reactivated, added.invited], `the console's add sets the existing row active: ${added.error ?? ""}`).toEqual([200, true, true, false]);
      const { data: audit, error } = await svc()
        .from("platform_audit_log")
        .select("metadata")
        .eq("action", "tenant.add_admin")
        .eq("target_id", a.id)
        .order("at", { ascending: false })
        .limit(1)
        .maybeSingle();
      expect(error, error?.message).toBeNull();
      const meta = (audit as { metadata?: { reactivated?: boolean; previous_status?: string } } | null)?.metadata;
      expect([meta?.reactivated, meta?.previous_status], "the audit row says it reactivated an inactive row").toEqual([true, "inactive"]);
      expect(await pageOutcome(app.ctx.inactiveAdmin, usersPage), "back in at the next request").toBe("rendered");
      expect(statusIn(await list(a), "inactiveAdmin"), "listed active").toBe("active");
    } finally {
      await setStatus(a.id, ap("inactiveAdmin").id, "inactive");
    }
  });

  // Last: the block that depends on the target's configuration
  // (IMPERSONATION_SECRET on the app server), as spec 68 orders it.
  test("impersonation: a start on the deleted organisation gets the unknown one's answer; a session started before a deletion opens no page; case (b)'s admin route answers as case (a)'s", async () => {
    const reason = "lifecycle spec 80 (ADR 0030), app group";
    const start = async (who: string, orgId: string) =>
      answer(await app.ctx[who].request.post("/api/super/impersonate", { data: { org_id: orgId, reason }, maxRedirects: 0 }));
    const end = async (who: string) => {
      const res = await app.ctx[who].request.delete("/api/super/impersonate");
      expect(res.status(), `${who}: end impersonation`).toBeLessThan(400);
    };

    // 3(d): the deleted organisation is refused as an unknown one, and no session row is written.
    const unknown = await start("po", randomUUID());
    expect(unknown.status, "an unknown organisation id (the reference answer)").toBe(404);
    expect(await start("po", app.d!.id), "D, soft-deleted: as an unknown organisation").toEqual(unknown);
    expect(await rowCount("platform_impersonation_sessions", { actor_user_id: ap("po").id, target_org_id: app.d!.id }), "no session row for D").toBe(0);

    // A session started before the deletion opens no page after it.
    const e = app.e!;
    const startedE = await start("poE", e.id);
    expect(startedE.status, `the start on E, live (the target needs IMPERSONATION_SECRET): ${startedE.body}`).toBe(200);
    try {
      expect(await pageOutcome(app.ctx.poE, `/${e.slug}/users`), "E, live: the admin page").toBe("rendered");
      await softDelete(e.id);
      expect(await pageOutcome(app.ctx.poE, `/${e.slug}/users`), "E, soft-deleted: as an unknown address").toBe(
        await pageOutcome(app.ctx.poE, `/${testSlug("nowhere")}/users`),
      );
    } finally {
      await end("poE");
    }

    // 3(b) on an admin route keyed on an organisation id: an impersonating
    // owner with an inactive row in A gets what one with no row gets.
    const reply = async (who: string) =>
      answer(await app.ctx[who].request.post(`/api/tickets/${app.tickets.a}/messages`, { data: { body: "Lifecycle spec 80 (b)" }, maxRedirects: 0 }));
    expect((await start("po", app.a!.id)).status, "(a) the start on A").toBe(200);
    const none = await (async () => {
      try {
        return await reply("po");
      } finally {
        await end("po");
      }
    })();
    expect(none.status, "(a) no row: refused").toBeGreaterThanOrEqual(400);
    expect((await start("poInactive", app.a!.id)).status, "(b) the start on A").toBe(200);
    try {
      expect(await reply("poInactive"), "(b) an inactive row: as (a)").toEqual(none);
    } finally {
      await end("poInactive");
    }
  });

  test.afterAll(async () => {
    for (const ctx of Object.values(app.ctx)) await ctx.close().catch(() => undefined);
    // No platform owner and no usable key is left behind on staging by this group.
    for (const id of app.platformOwners) await svc().from("platform_owners").delete().eq("user_id", id);
    if (app.keyIds.length) await svc().from("org_api_keys").update({ is_active: false }).in("id", app.keyIds);
  });
});
