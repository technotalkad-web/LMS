/**
 * ADR 0030 (membership status), lifecycle spec 80: the DATABASE GROUP of
 * build prerequisites point 6, everything migration 0115 closes alone, on
 * the code that runs today. A membership counts only while its status is
 * 'active' and its organisation's deleted_at is null; the rule tests the
 * reader, never the person a row is about.
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
 *   D: an active administrator, read before and after D is soft-deleted;
 *   a signed-in person with no membership (the outsider), and a platform
 *   owner with no row in A.
 *
 * Cases (each refused answer is compared with the outsider's on the same
 * organisation, and a page also with an unknown organisation address):
 *   (1) the inactive administrator, the suspended administrator, the inactive
 *       learner, the inactive data analyst, and D's administrator after the
 *       soft delete: the data API (the organisation row, its courses, other
 *       members' rows and profiles, the four helpers), a learner page, an
 *       admin page and a route guarded by row security alone (POST
 *       /api/folders) answer as for the outsider; the control reads and
 *       writes as today. A person still reads their own membership row
 *       (decision 5).
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
 * The app group (admin routes keyed on an organisation id, the export, the
 * mail cases, the launch-token and SCORM cases, language-preference, the
 * console's add and list, the refused start for a deleted organisation)
 * joins this file with ADR 0030's pull request B.
 *
 * Gates: by hand on staging after 0115's staging paste (ADR 0030 gate G2),
 * never while another harness runs there; it joins the nightly list after
 * one green run (gate G5). Never against production.
 */
import { test, expect, type BrowserContext } from "@playwright/test";
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
import { authedContext } from "./helpers";

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

    // D's control, before the soft delete: its administrator reads D
    const dDb = await sessionDb(u("deletedAdmin"));
    expect((await reads(dDb, s.d.id, u("deletedAdmin").id)).org, "D's administrator reads D before the soft delete").toBe(1);
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

    for (const [key, org, outsider] of [
      ["inactiveAdmin", s.a!, outsiderA],
      ["suspendedAdmin", s.a!, outsiderA],
      ["inactiveLearner", s.a!, outsiderA],
      ["inactiveAnalyst", s.a!, outsiderA],
      ["deletedAdmin", s.d!, outsiderD],
    ] as Array<[string, SeededOrg, Reads]>) {
      expect(await reads(s.db[key], org.id, u(key).id), `${key}: as the outsider`).toEqual(outsider);
      expect(await canReadProfile(s.db[key], u("admin").id), `${key}: no co-member's profile`).toBe(false);
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
